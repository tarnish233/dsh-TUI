// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent, type TuiMouseEventType } from '#pi-tui'
import type { SessionEvent, SessionInfo, SubagentEntry, SubagentSnapshot } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import type { SubagentMessageTranscriptItem } from '../src/state/subagents.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import type { ToolTranscriptItem, TranscriptItem } from '../src/state/transcript.ts'
import {
  ActivityGroupBlock,
  activityGroupCounts,
  isPureStatusNotice,
  planActivityGroupNodes,
  type ActivityGroupMember,
  type ActivityMemberItem,
} from '../src/ui/activity-group.ts'
import { createItemBlock, type TranscriptViewOptions } from '../src/ui/blocks.ts'
import { planSubagentGroupNodes } from '../src/ui/subagent-group.ts'
import {
  clearToolExpansion,
  isToolExpanded,
  setToolExpanded,
  toolExpansionKey,
  toolGroupExpansionKey,
} from '../src/ui/tool-expansion.ts'
import { planTranscriptNodes } from '../src/ui/tool-group.ts'
import { TranscriptView } from '../src/ui/transcript.ts'

// ---------------------------------------------------------------------------
// Fixtures (synthetic DSH events only; no backend, no model, no stdout)

const info = (events: SessionEvent[] = [], subagents?: SubagentSnapshot): SessionInfo => ({
  sessionId: 's1',
  cwd: '/tmp/work',
  provider: 'demo',
  model: 'demo',
  capabilities: [],
  events,
  ...(subagents === undefined ? {} : { subagents }),
})

const ev = (type: string, seq: number, data: unknown, extra: Partial<SessionEvent> = {}): SessionEvent => ({
  type,
  seq,
  data,
  ...extra,
})

const userEvent = (seq: number, text: string): SessionEvent =>
  ev('user/message', seq, {
    id: `u-${seq}`,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })

const callEvent = (seq: number, callId: string, name: string, args: string, turn = 1, step = 1): SessionEvent =>
  ev('tool/call', seq, { turn, step, callId, name, arguments: args })

const resultEvent = (seq: number, callId: string, text: string, isError = false): SessionEvent =>
  ev('tool/result', seq, {
    turn: 1,
    step: 1,
    message: {
      id: `res-${seq}`,
      role: 'tool',
      toolCallId: callId,
      content: [{ type: 'text', text }],
      isError,
      source: { kind: 'tool', callId },
    },
  }, { surfaceOp: 'append' })

const SETTLEMENT_SUMMARY = 'Background subagent child-3 finished. It cannot receive follow-up messages.'
const SETTLEMENT_DETAIL = 'It sent you a message just before finishing, so its closing message is omitted.'

/** DSH's own durable settlement notice: a `user/message` with an attributed source. */
const settlementEvent = (
  seq: number,
  options: {
    senderSessionId?: string
    summary?: string
    detail?: string
    form?: string
    sourceKind?: 'subagent-settled' | 'agent-message'
  } = {},
): SessionEvent => {
  const senderSessionId = options.senderSessionId ?? 'child-3'
  const summary = options.summary ?? SETTLEMENT_SUMMARY
  const sourceKind = options.sourceKind ?? 'subagent-settled'
  // DSH always stamps `subagent-settled` with the native `notice` form; a test
  // that wants a legacy/unknown shape passes `form` explicitly.
  const form = options.form ?? 'notice'
  return ev('user/message', seq, {
    id: `settle-${seq}`,
    role: 'user',
    content: [{ type: 'text', text: summary }, { type: 'text', text: options.detail ?? SETTLEMENT_DETAIL }],
    source: { kind: sourceKind, form, summary, senderSessionId },
  }, { surfaceOp: 'append' })
}

const agentMessageEvent = (seq: number, senderSessionId = 'child-3'): SessionEvent =>
  ev('user/message', seq, {
    id: `agent-${seq}`,
    role: 'user',
    content: [{ type: 'text', text: `Agent ${senderSessionId} sent a message: ` }, { type: 'text', text: 'I found the answer.' }],
    source: { kind: 'agent-message', form: 'relay', senderSessionId },
  }, { surfaceOp: 'append' })

/** Native catalog row that resolves the durable sender to a real openable child. */
const childEntry = (id = 'child-3', label = 'Tui acceptance agent 3') => ({
  id,
  parentSessionId: 's1',
  mode: 'one-shot' as const,
  status: 'completed' as const,
  label,
  local: true,
})

const snapshot = (...entries: SubagentEntry[]): SubagentSnapshot => ({ entries })

/**
 * The user's real display: one real tool (`List Agents children`) whose result is
 * three rows, immediately followed by the runtime's own settlement notice for a
 * background child.
 */
function toolPlusNoticeStore(options: {
  call?: Partial<{ callId: string; name: string; args: string; status: 'done' | 'error' | 'unresolved' | 'running' }>
  settlement?: Parameters<typeof settlementEvent>[1]
  subagents?: SubagentSnapshot
} = {}): TranscriptStore {
  const callId = options.call?.callId ?? 'call-1'
  const name = options.call?.name ?? 'list_agents'
  const args = options.call?.args ?? '{"mode":"children"}'
  const status = options.call?.status ?? 'done'
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  const append = (event: SessionEvent): void => {
    store.handle({ type: 'session_event', sessionId: 's1', event })
  }
  // `running` is a live admitted call; the others are already in the snapshot.
  const settleNow = status === 'running'
  const events: SessionEvent[] = [
    userEvent(1, 'check the children'),
    ...(settleNow ? [] : [callEvent(2, callId, name, args)]),
  ]
  if (status === 'done') events.push(resultEvent(3, callId, 'child-1 running\nchild-2 idle\nchild-3 completed'))
  if (status === 'error') events.push(resultEvent(3, callId, 'permission denied', true))
  store.reset(info(events, options.subagents))
  if (settleNow) append(callEvent(2, callId, name, args))
  // `unresolved` keeps the call without a result (the snapshot settles it as
  // unresolved); every case is followed by the runtime's own notice.
  append(settlementEvent(4, options.settlement))
  return store
}

type ViewOptionsShape = TranscriptViewOptions & { groupSubagentMessages?: boolean; suppressLiveTodos?: boolean }

const viewOptions = (extra: Partial<ViewOptionsShape> = {}): ViewOptionsShape => ({
  showThinking: true,
  expandTools: false,
  groupTools: true,
  groupSubagentMessages: true,
  hints: { expand: 'ctrl+o' },
  screen: 'inline',
  ...extra,
})

const plain = (lines: readonly string[]): string[] => lines.map(line => stripTerminalSequences(line))
const text = (lines: readonly string[]): string => plain(lines).join('\n')

function mouse(type: TuiMouseEventType, x: number, y: number): TuiMouseEvent {
  return {
    type,
    x,
    y,
    button: type === 'move' ? 'none' : 'left',
    screenX: x + 10,
    screenY: y + 3,
    width: 80,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
  }
}

function colOf(line: string, needle: string): number {
  const index = line.indexOf(needle)
  assert.ok(index >= 0, `missing ${JSON.stringify(needle)} in ${JSON.stringify(line)}`)
  return visibleWidth(line.slice(0, index))
}

function assertWidths(lines: readonly string[], width: number, label: string): void {
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `${label}: width ${width} got ${visibleWidth(line)} :: ${JSON.stringify(stripTerminalSequences(line))}`)
  }
}

const reset = (): void => { clearToolExpansion() }

// Pure-projection fixtures

const toolItem = (callId: string, name: string, status: ToolTranscriptItem['status'], extra: Partial<ToolTranscriptItem> = {}): ToolTranscriptItem => ({
  kind: 'tool',
  id: `tool:${callId}`,
  callId,
  name,
  arguments: '{"command":"x"}',
  status,
  resultText: '',
  resultImages: 0,
  resultIsError: false,
  meta: undefined,
  version: 1,
  ...extra,
})

const noticeItem = (
  seq: number,
  extra: Partial<SubagentMessageTranscriptItem> = {},
): SubagentMessageTranscriptItem => ({
  kind: 'subagent-message',
  id: `subagent-message:${seq}`,
  seq,
  sourceKind: 'subagent-settled',
  senderSessionId: 'child-3',
  form: 'notice',
  summary: SETTLEMENT_SUMMARY,
  text: SETTLEMENT_DETAIL,
  version: 1,
  ...extra,
})

/** The full three-step projection the view uses. */
function project(
  items: readonly TranscriptItem[],
  options: { groupTools?: boolean; groupSubagentMessages?: boolean } = {},
): ReturnType<typeof planSubagentGroupNodes> {
  const groupTools = options.groupTools ?? true
  const groupSubagentMessages = options.groupSubagentMessages ?? true
  const toolNodes = planTranscriptNodes(items, { groupTools, showThinking: false })
  const activityNodes = planActivityGroupNodes(toolNodes, { groupActivities: groupTools && groupSubagentMessages })
  return planSubagentGroupNodes(activityNodes, { groupRecords: groupSubagentMessages })
}

// ---------------------------------------------------------------------------
// Pure projection

test('a real tool call followed by a pure settlement notice becomes one mixed group', () => {
  reset()
  const items: TranscriptItem[] = [toolItem('a', 'list_agents', 'done', { resultText: 'one\ntwo\nthree' }), noticeItem(4)]
  const nodes = project(items)
  assert.equal(nodes.length, 1)
  const node = nodes[0]!
  assert.equal(node.kind, 'activity-group')
  if (node.kind !== 'activity-group') return
  assert.deepEqual(node.members.map(member => member.kind), ['tool', 'subagent-message'])
  assert.deepEqual(node.members.map(member => member.id), ['tool:a', 'subagent-message:4'], 'declaration order, real ids')
  assert.equal(node.anchor.id, 'tool:a', 'the first member is the anchor')
  // Nothing is rewritten: the source items keep every native fact.
  assert.equal(items[1]?.kind === 'subagent-message' ? items[1].text : '', SETTLEMENT_DETAIL)
  assert.equal(items[1]?.kind === 'subagent-message' ? items[1].summary : '', SETTLEMENT_SUMMARY)
  assert.equal(items[1]?.kind === 'subagent-message' ? items[1].seq : 0, 4)

  // A notice *before* the tool is the same narrative, anchored on the notice.
  const reversed = project([noticeItem(3), toolItem('a', 'list_agents', 'done')])
  assert.equal(reversed[0]?.kind, 'activity-group')
  assert.equal(reversed[0]?.kind === 'activity-group' ? reversed[0].anchor.id : '', 'subagent-message:3')

  // Genuine messages are boundaries in both directions.
  const agentMessage = noticeItem(5, { sourceKind: 'agent-message', form: 'relay' })
  assert.deepEqual(project([toolItem('a', 'bash', 'done'), agentMessage]).map(node => node.kind), ['item', 'item'])
  assert.deepEqual(project([agentMessage, toolItem('a', 'bash', 'done')]).map(node => node.kind), ['item', 'item'])
})

test('both grouping preferences gate the mixed group and keep their own meaning', () => {
  reset()
  const items: TranscriptItem[] = [toolItem('a', 'bash', 'done'), noticeItem(4)]
  // Either preference off restores the previous rows; no third setting exists.
  assert.deepEqual(project(items, { groupSubagentMessages: false }).map(node => node.kind), ['item', 'item'])
  assert.deepEqual(project(items, { groupTools: false }).map(node => node.kind), ['item', 'item'])
  assert.deepEqual(project(items, { groupTools: false, groupSubagentMessages: false }).map(node => node.kind), ['item', 'item'])

  // Plain tool runs still use the existing tool group, untouched.
  const toolsOnly = project([toolItem('a', 'bash', 'done'), toolItem('b', 'read', 'done')])
  assert.deepEqual(toolsOnly.map(node => node.kind), ['group'])
  // Plain consecutive subagent records still use the existing subagent group.
  const noticesOnly = project([noticeItem(3), noticeItem(4)])
  assert.deepEqual(noticesOnly.map(node => node.kind), ['subagent-group'])
})

test('the mixed run is fail-closed on the native source form and on every hard boundary', () => {
  reset()
  const tool = toolItem('a', 'bash', 'done')
  // No/unknown/foreign form is not this build's notice shape: it keeps its row.
  assert.equal(isPureStatusNotice(noticeItem(1)), true)
  assert.equal(isPureStatusNotice(noticeItem(1, { form: undefined })), false)
  assert.equal(isPureStatusNotice(noticeItem(1, { form: 'relay' })), false)
  assert.equal(isPureStatusNotice(noticeItem(1, { sourceKind: 'agent-message' })), false)
  assert.deepEqual(project([tool, noticeItem(4, { form: undefined })]).map(node => node.kind), ['item', 'item'])
  assert.deepEqual(project([tool, noticeItem(4, { form: 'relay' })]).map(node => node.kind), ['item', 'item'])

  // File-mutating / diff cards are never folded away.
  assert.deepEqual(project([tool, noticeItem(4), toolItem('b', 'edit', 'done')]).map(node => node.kind),
    ['activity-group', 'item'])
  // Arbitrary notices, todos, users and visible assistant rows are boundaries.
  const notice: TranscriptItem = { kind: 'notice', id: 'notice:1', text: 'permission required', level: 'error', version: 1 }
  const todos: TranscriptItem = { kind: 'todos', id: 'todos:1', todos: [], version: 1 }
  const user: TranscriptItem = { kind: 'user', id: 'user:9', seq: 9, text: 'go on', imageCount: 0, version: 1 }
  for (const boundary of [notice, todos, user]) {
    assert.deepEqual(project([tool, boundary, noticeItem(4)]).map(node => node.kind), ['item', 'item', 'item'])
  }
  const assistant: TranscriptItem = {
    kind: 'assistant',
    id: 'assistant:2',
    text: 'visible answer',
    thinking: '',
    interrupted: false,
    version: 1,
  }
  assert.deepEqual(project([tool, assistant, noticeItem(4)]).map(node => node.kind), ['item', 'item', 'item'])

  // A transparent empty assistant row is crossed exactly like inside a tool run.
  const empty: TranscriptItem = { ...assistant, text: '' }
  assert.deepEqual(project([tool, empty, noticeItem(4)]).map(node => node.kind), ['activity-group'])

  // A known turn change still breaks the run; an unknown turn is not invented.
  assert.deepEqual(project([
    toolItem('a', 'bash', 'done', { turn: 1 }),
    noticeItem(4),
    toolItem('b', 'read', 'done', { turn: 2 }),
  ]).map(node => node.kind), ['activity-group', 'item'])
  assert.deepEqual(project([
    toolItem('a', 'bash', 'done'),
    noticeItem(4),
    toolItem('b', 'read', 'done'),
  ]).map(node => node.kind), ['activity-group'])
})

test('counts keep tools and status updates separate and every real tool state visible', () => {
  reset()
  const members: ActivityMemberItem[] = [
    toolItem('a', 'bash', 'running'),
    toolItem('b', 'read', 'done'),
    toolItem('c', 'bash', 'error'),
    toolItem('d', 'grep', 'unknown'),
    noticeItem(5),
    noticeItem(6),
  ]
  assert.deepEqual(activityGroupCounts(members), {
    tools: 4,
    updates: 2,
    proposed: 0,
    running: 1,
    done: 1,
    failed: 1,
    unknown: 1,
  })
})

// ---------------------------------------------------------------------------
// The real display: one tool + one runtime settlement notice

test('1 tool + 1 notice renders one Activities group that counts both separately', () => {
  reset()
  const store = toolPlusNoticeStore({ subagents: snapshot(childEntry()) })
  const view = new TranscriptView(store, viewOptions())
  const lines = plain(view.render(120))
  const header = lines.findIndex(line => line.includes('Activities:'))
  assert.ok(header >= 0, lines.join('\n'))
  assert.match(lines[header]!, /Activities: 1 tool · 1 update/)
  assert.ok(lines[header]!.includes('ctrl+o to expand'), 'the real key hint is advertised')
  // The two native populations stayed two native facts in the store.
  assert.deepEqual(store.items.map(item => item.kind), ['user', 'tool', 'subagent-message'])
  const stored = store.items[2]
  assert.equal(stored?.kind, 'subagent-message')
  if (stored?.kind === 'subagent-message') {
    assert.equal(stored.sourceKind, 'subagent-settled')
    assert.equal(stored.form, 'notice')
    assert.equal(stored.senderSessionId, 'child-3')
    assert.equal(stored.summary, SETTLEMENT_SUMMARY)
    assert.equal(stored.text, `${SETTLEMENT_SUMMARY}\n\n${SETTLEMENT_DETAIL}`)
  }
  // Collapsed rows: the real tool summary plus the real attributed notice title
  // and the catalog's own child label.
  const joined = lines.join('\n')
  assert.ok(joined.includes('List Agents'), joined)
  assert.ok(joined.includes('Subtask status updated'), joined)
  assert.ok(joined.includes('Tui acceptance agent 3'), joined)
  // Nothing fabricated: no tool row is described as a subagent or vice versa.
  assert.ok(!joined.includes('2 tools'), 'the notice is never counted as a tool')
  assert.ok(!joined.includes('2 updates'), 'the tool is never counted as an update')
})

test('the mixed group never invents success: unresolved, running and failed tools stay visible', () => {
  reset()
  const unresolved = new TranscriptView(toolPlusNoticeStore({
    call: { status: 'unresolved' },
    subagents: snapshot(childEntry()),
  }), viewOptions())
  const unresolvedText = text(unresolved.render(120))
  assert.match(unresolvedText, /Activities: 1 tool · 1 unknown · 1 update/)

  const running = new TranscriptView(toolPlusNoticeStore({ call: { status: 'running' } }), viewOptions())
  assert.match(text(running.render(120)), /Activities: 1 tool · 1 running/)
  // …and the collapsed tool row keeps its real running glyph, not a check mark.
  assert.ok(text(running.render(120)).includes('◐'), 'the running call keeps its own status glyph')

  const failed = new TranscriptView(toolPlusNoticeStore({
    call: { status: 'error' },
    subagents: snapshot(childEntry()),
  }), viewOptions())
  const failedLines = plain(failed.render(120))
  const header = failedLines.findIndex(line => line.includes('Activities:'))
  assert.ok(header >= 0)
  assert.match(failedLines[header]!, /Activities: 1 tool · 1 failed · 1 update/)
  // The failed call's own status is painted on its collapsed row too.
  assert.ok(failedLines.some(line => line.includes('✗')), failedLines.join('\n'))
  assert.ok(!failedLines[header]!.startsWith('●') || failedLines[header]!.includes('failed'))
})

test('expanding the group renders the real member blocks, never a rewritten notice', () => {
  reset()
  const store = toolPlusNoticeStore({ subagents: snapshot(childEntry()) })
  const view = new TranscriptView(store, viewOptions())
  assert.ok(!text(view.render(120)).includes(SETTLEMENT_DETAIL), 'collapsed shows no notice body')
  view.toggleToolsExpanded()
  const expanded = text(view.render(120))
  assert.ok(expanded.includes('ctrl+o to collapse'), expanded)
  // The real tool result rows.
  assert.ok(expanded.includes('child-1 running'), expanded)
  assert.ok(expanded.includes('child-2 idle'), expanded)
  assert.ok(expanded.includes('child-3 completed'), expanded)
  // The real, exact native notice body (both paragraphs).
  assert.ok(expanded.includes(SETTLEMENT_SUMMARY), expanded)
  assert.ok(expanded.includes(SETTLEMENT_DETAIL), expanded)
  // Prefix guide only: the native text is never rewritten, dropped or duplicated.
  assert.equal(expanded.split(SETTLEMENT_DETAIL).length - 1, 1)
  for (const line of view.render(120)) {
    const prefix = stripTerminalSequences(line).slice(0, 2)
    if (prefix === '  ' || prefix === '│ ' || prefix === '├ ' || prefix === '└ ') {
      assert.ok(!stripTerminalSequences(line).includes('Activities:'), 'the header carries no tree prefix')
    }
  }
})

test('a genuine agent message stays a visible boundary outside the mixed status group', () => {
  reset()
  const store = toolPlusNoticeStore({ subagents: snapshot(childEntry()) })
  // DSH appends the child's own message right after the settlement notice.
  store.handle({ type: 'session_event', sessionId: 's1', event: agentMessageEvent(6) })
  const view = new TranscriptView(store, viewOptions())
  const lines = plain(view.render(120))
  assert.equal(lines.filter(line => line.includes('Activities:')).length, 1)
  assert.match(lines.find(line => line.includes('Activities:'))!, /1 tool · 1 update/, 'the agent message is not an update')
  assert.ok(lines.some(line => line.includes('Task message received')), lines.join('\n'))
  assert.deepEqual(store.items.map(item => item.kind), ['user', 'tool', 'subagent-message', 'subagent-message'])
  assert.equal(store.items[3]?.kind === 'subagent-message' ? store.items[3].sourceKind : '', 'agent-message')
})

// ---------------------------------------------------------------------------
// Expansion, disclosure and cache ownership

test('Ctrl+O and single-expand own the mixed group like any tool group', () => {
  reset()
  const store = toolPlusNoticeStore({ subagents: snapshot(childEntry()) })
  const key = toolGroupExpansionKey('tool:call-1')
  const view = new TranscriptView(store, viewOptions())
  view.render(120)
  assert.equal(isToolExpanded(key, false), false)
  assert.equal(view.expandedDisclosureCount, 0)

  // Header click opens the group through the shared disclosure map.
  const header = plain(view.render(120)).findIndex(line => line.includes('Activities:'))
  assert.equal(view.handleMouse(mouse('press', 4, header))?.handled, true)
  assert.equal(view.handleMouse(mouse('click', 4, header))?.handled, true)
  assert.equal(isToolExpanded(key, false), true)
  assert.equal(view.expandedDisclosureCount, 1)
  assert.ok(text(view.render(120)).includes(SETTLEMENT_DETAIL))

  // A second click collapses it again.
  const expandedHeader = plain(view.render(120)).findIndex(line => line.includes('Activities:'))
  view.handleMouse(mouse('press', 4, expandedHeader))
  view.handleMouse(mouse('click', 4, expandedHeader))
  assert.equal(isToolExpanded(key, false), false)
  assert.equal(view.expandedDisclosureCount, 0)

  // Single-expand closes every other root disclosure, and the group counts once.
  reset()
  const both = toolPlusNoticeStore({ subagents: snapshot(childEntry()) })
  both.handle({ type: 'session_event', sessionId: 's1', event: callEvent(8, 'call-2', 'bash', '{"command":"ls"}') })
  both.handle({ type: 'session_event', sessionId: 's1', event: resultEvent(9, 'call-2', 'a\nb') })
  both.handle({ type: 'session_event', sessionId: 's1', event: callEvent(10, 'call-3', 'bash', '{"command":"pwd"}') })
  both.handle({ type: 'session_event', sessionId: 's1', event: resultEvent(11, 'call-3', '/tmp/work') })
  const single = new TranscriptView(both, viewOptions())
  const lines = plain(single.render(120))
  assert.ok(lines.some(line => line.includes('Activities:')), lines.join('\n'))
  const anchorRow = lines.findIndex(line => line.includes('Activities:'))
  single.handleMouse(mouse('press', 4, anchorRow))
  single.handleMouse(mouse('click', 4, anchorRow))
  assert.equal(single.expandedDisclosureCount, 1, 'only the clicked mixed group is open')
  assert.ok(!isToolExpanded(toolGroupExpansionKey('call-2'), false), 'the other root group was closed')

  // Ctrl+O is still the master switch and drops the local overrides.
  reset()
  const master = new TranscriptView(toolPlusNoticeStore({ subagents: snapshot(childEntry()) }), viewOptions())
  master.render(120)
  master.toggleToolsExpanded()
  assert.ok(text(master.render(120)).includes(SETTLEMENT_DETAIL), 'the master switch opens the group')
  master.toggleToolsExpanded()
  assert.ok(!text(master.render(120)).includes(SETTLEMENT_DETAIL))
})

test('the group cache is reused across identical frames and torn down when composition changes', () => {
  reset()
  const store = toolPlusNoticeStore({ subagents: snapshot(childEntry()) })
  const view = new TranscriptView(store, viewOptions())
  const first = view.render(120)
  const firstText = text(first)
  const second = view.render(120)
  // A byte-identical frame means the composed member blocks were reused, not
  // re-created: the view keeps one cached block per stable item id.
  assert.equal(text(second), firstText)
  const cacheBefore = view.cachedItemCount
  assert.ok(cacheBefore >= 3, `items + group cached, got ${cacheBefore}`)

  // A third tool call joins the same run: the group survives (same anchor), its
  // member list grows and the header recounts real tools only.
  store.handle({ type: 'session_event', sessionId: 's1', event: callEvent(6, 'call-2', 'read', '{"path":"a.ts"}') })
  store.handle({ type: 'session_event', sessionId: 's1', event: resultEvent(7, 'call-2', 'file body') })
  const grown = text(view.render(120))
  assert.match(grown, /Activities: 2 tools · 1 update/)

  // The cached group block for the old composition is not left behind as a
  // second stale host: one group, one key, the members of this frame.
  assert.ok(!grown.includes('Activities: 1 tool · 1 update'))

  view.dispose()
  assert.equal(view.isDisposed, true)
  assert.deepEqual(view.render(120), [])
  assert.deepEqual(view.rowSpans, [], 'no stale row mappings survive the teardown')
  assert.equal(view.cachedItemCount, 0, 'every cached block (group and members) was dropped')
})

test('the group dissolves cleanly back into its member rows when preferences change', () => {
  reset()
  const store = toolPlusNoticeStore({ subagents: snapshot(childEntry()) })
  const grouped = new TranscriptView(store, viewOptions())
  assert.ok(text(grouped.render(120)).includes('Activities:'))

  // Same store, `groupSubagentMessages` off: no mixed group, both facts visible.
  const ungrouped = new TranscriptView(store, viewOptions({ groupSubagentMessages: false }))
  const rows = text(ungrouped.render(120))
  assert.ok(!rows.includes('Activities:'), rows)
  assert.ok(rows.includes('List Agents'), rows)
  assert.ok(rows.includes('Subtask status updated'), rows)
  // `groupTools` off alone is the same story (the mixed group needs both).
  const noTools = new TranscriptView(store, viewOptions({ groupTools: false }))
  assert.ok(!text(noTools.render(120)).includes('Activities:'))
})

test('a boundary that appears between the members dissolves the group without stale state', () => {
  reset()
  // Start with the mixed run; the settlement notice's seq leaves room for a
  // catalog row that DSH anchors between the tool and the notice.
  const store = toolPlusNoticeStore({ subagents: snapshot(childEntry()) })
  const key = toolGroupExpansionKey('tool:call-1')
  const view = new TranscriptView(store, viewOptions())
  view.render(120)
  setToolExpanded(key, true)
  assert.equal(isToolExpanded(key, false), true)
  assert.ok(text(view.render(120)).includes(SETTLEMENT_DETAIL))

  // A native catalog upsert anchors its own row between the two facts: the run
  // is no longer adjacent, so the mixed group must dissolve.
  store.handle({
    type: 'subagents',
    sessionId: 's1',
    // seq 3 = the tool's own result seq, so the new anchor lands between the
    // tool and the settlement notice (seq 4).
    value: snapshot({ ...childEntry(), catalogSeq: 3 }),
  })
  const lines = plain(view.render(120))
  assert.ok(!lines.some(line => line.includes('Activities:')), lines.join('\n'))
  // The catalog row plus the notice are now their own subagent group; the tool
  // card is an ordinary row again.
  assert.ok(lines.some(line => line.includes('Subagents:')), lines.join('\n'))
  assert.ok(lines.some(line => line.includes('List Agents')), lines.join('\n'))
  // The group's disclosure override is dropped with the group row: no stale
  // expansion survives for a component that no longer exists.
  assert.equal(isToolExpanded(key, false), false)

  // The tool card is a root card again: it owns its own disclosure key and never
  // inherits the dissolved group's context or the subagent group's key.
  const toolRow = lines.findIndex(line => line.includes('List Agents'))
  assert.equal(view.handleMouse(mouse('press', colOf(lines[toolRow]!, 'List Agents'), toolRow))?.handled, true)
  assert.equal(view.handleMouse(mouse('click', colOf(lines[toolRow]!, 'List Agents'), toolRow))?.handled, true)
  assert.equal(isToolExpanded(toolExpansionKey('call-1'), false), true, 'the card toggles its own disclosure')
  assert.equal(isToolExpanded(key, false), false, 'no stale group disclosure is revived')
  assert.equal(view.expandedDisclosureCount, 1)
  assert.ok(text(view.render(120)).includes('child-3 completed'), 'the card expands through its own key')
})

// ---------------------------------------------------------------------------
// Mouse semantics

test('collapsed rows: header toggles, tool rows own no hitbox, only the child name is a link', () => {
  reset()
  const opened: string[] = []
  const store = toolPlusNoticeStore({ subagents: snapshot(childEntry()) })
  const view = new TranscriptView(store, viewOptions({ onSubagentDetails: id => opened.push(id) }))
  const lines = plain(view.render(120))
  const header = lines.findIndex(line => line.includes('Activities:'))
  const notice = lines.findIndex(line => line.includes('Subtask status updated'))
  const toolRow = lines.findIndex(line => line.includes('List Agents'))
  assert.ok(header >= 0 && notice > header && toolRow > header, lines.join('\n'))

  // A collapsed tool row is plain text: it advertises no detail view.
  const toolCol = colOf(lines[toolRow]!, 'List Agents')
  assert.equal(view.handleMouse(mouse('press', toolCol, toolRow)), undefined)
  assert.equal(view.handleMouse(mouse('click', toolCol, toolRow)), undefined)
  assert.equal(isToolExpanded(toolGroupExpansionKey('tool:call-1'), false), false)

  // Only the child name navigates.
  const nameCol = colOf(lines[notice]!, 'Tui acceptance agent 3')
  assert.equal(view.handleMouse(mouse('press', nameCol, notice))?.handled, true)
  assert.equal(view.handleMouse(mouse('click', nameCol, notice))?.handled, true)
  assert.deepEqual(opened, ['child-3'])
  // A press that began outside every link never becomes navigation.
  const gapCol = colOf(lines[notice]!, 'Subtask status updated')
  assert.equal(view.handleMouse(mouse('press', gapCol, notice)), undefined)
  assert.equal(view.handleMouse(mouse('click', nameCol, notice)), undefined)
  assert.deepEqual(opened, ['child-3'])

  // An unknown/external sender is plain text with no dead affordance.
  const unknown = toolPlusNoticeStore({ settlement: { senderSessionId: 'nested-child-9' } })
  const unknownView = new TranscriptView(unknown, viewOptions({ onSubagentDetails: id => opened.push(id) }))
  const unknownLines = plain(unknownView.render(120))
  const unknownRow = unknownLines.findIndex(line => line.includes('Subtask status updated'))
  assert.ok(unknownLines[unknownRow]!.includes('nested-child-9'), 'the durable sender id is shown')
  const unknownCol = colOf(unknownLines[unknownRow]!, 'nested-child-9')
  assert.equal(unknownView.handleMouse(mouse('press', unknownCol, unknownRow)), undefined)
  assert.equal(unknownView.handleMouse(mouse('click', unknownCol, unknownRow)), undefined)
  assert.deepEqual(opened, ['child-3'])
})

test('drag and expanded bodies stay native; a vanished link voids its gesture', () => {
  reset()
  const opened: string[] = []
  const store = toolPlusNoticeStore({ subagents: snapshot(childEntry()) })
  const view = new TranscriptView(store, viewOptions({ onSubagentDetails: id => opened.push(id) }))
  let lines = plain(view.render(120))
  let notice = lines.findIndex(line => line.includes('Subtask status updated'))
  const nameCol = colOf(lines[notice]!, 'Tui acceptance agent 3')
  // Press, drag away, release over the same name: never an open.
  assert.equal(view.handleMouse(mouse('press', nameCol, notice))?.handled, true)
  view.handleMouse(mouse('drag', nameCol + 2, notice))
  view.handleMouse(mouse('click', nameCol + 2, notice))
  assert.deepEqual(opened, [])
  // Motion is never claimed either.
  assert.equal(view.handleMouse(mouse('move', nameCol, notice)), undefined)

  // Expanded: the body belongs to the member blocks and native selection.
  view.toggleToolsExpanded()
  lines = plain(view.render(120))
  const body = lines.findIndex(line => line.includes(SETTLEMENT_DETAIL))
  assert.ok(body >= 0, lines.join('\n'))
  const bodyCol = colOf(lines[body]!, 'It sent')
  assert.equal(view.handleMouse(mouse('press', bodyCol, body)), undefined)
  assert.equal(view.handleMouse(mouse('drag', bodyCol, body)), undefined)
  assert.equal(view.handleMouse(mouse('click', bodyCol, body)), undefined)
  assert.ok(text(view.render(120)).includes(SETTLEMENT_DETAIL), 'the group stays expanded')
  assert.deepEqual(opened, [])

  // A modal owns the frame: the mixed group is inert behind it.
  view.options.mouseBlocked = true
  view.render(120)
  assert.equal(view.handleMouse(mouse('press', 4, 0)), undefined)
})

test('group prefix, member width and pointer offsets share one budget', () => {
  reset()
  const store = toolPlusNoticeStore({ subagents: snapshot(childEntry()) })
  const flags = viewOptions({ expandTools: true, onSubagentDetails: () => {} }) as TranscriptViewOptions
  const records: ActivityMemberItem[] = [
    toolItem('call-1', 'list_agents', 'done', { resultText: 'one\ntwo\nthree' }),
    noticeItem(4),
  ]
  const members: ActivityGroupMember[] = records.map(item => ({ item, block: createItemBlock(item, flags) }))
  const group = new ActivityGroupBlock(records[0]!, flags)
  group.setMembers(members)
  const width = 80
  const lines = plain(group.render(width))
  assert.match(lines[0]!, /Activities: 1 tool · 1 update/)
  const spans = group.rowSpans
  assert.equal(spans.length, 2)
  for (const span of spans) {
    assert.equal(span.xOffset, 2, 'prefix/xOffset agree')
    const standalone = plain(span.block.render(width - span.xOffset))
    const painted = lines.slice(span.startRow, span.endRow + 1)
    assert.equal(painted.length, standalone.length, 'no member row is dropped or added by the prefix')
    painted.forEach((line, index) => {
      const prefix = line.slice(0, 2)
      assert.ok(['├ ', '└ ', '│ ', '  '].includes(prefix), `unexpected prefix ${JSON.stringify(prefix)}`)
      assert.equal(line.slice(2), standalone[index], 'the member paint is never over-clipped by the final fit')
    })
  }
  assertWidths(group.render(width), width, 'group 80')
  for (const narrow of [8, 16, 24, 40, 60]) {
    assertWidths(group.render(narrow), narrow, `group ${narrow}`)
    for (const span of group.rowSpans) {
      assert.equal(span.xOffset, 2)
      assert.ok(span.endRow >= span.startRow)
    }
  }
  group.dispose()
  assert.equal(group.isDisposed, true)
  assert.deepEqual(group.render(width), [])
  // The store is untouched by the standalone host (no fetch, no rewrite).
  assert.deepEqual(store.items.map(item => item.kind), ['user', 'tool', 'subagent-message'])
})

// ---------------------------------------------------------------------------
// Narrow terminals and untouched behaviour

test('the whole transcript stays width-safe with a mixed group at every narrow width', () => {
  reset()
  const store = toolPlusNoticeStore({
    subagents: snapshot(childEntry()),
    call: { name: 'list_agents', args: '{"mode":"children","detail":"verbose"}' },
  })
  for (const width of [1, 4, 8, 12, 20, 32, 48, 80, 140]) {
    for (const expandTools of [false, true]) {
      const view = new TranscriptView(store, viewOptions({ expandTools }))
      assertWidths(view.render(width), width, `transcript ${width} expanded=${expandTools}`)
      // Every cell of the collapsed frame is safe to poke: nothing throws and a
      // click never fabricates a child open.
      const opened: string[] = []
      const probed = new TranscriptView(store, viewOptions({ expandTools, onSubagentDetails: id => opened.push(id) }))
      const lines = probed.render(width)
      for (let row = 0; row < lines.length; row += 1) {
        for (let col = 0; col < width; col += 1) {
          probed.handleMouse(mouse('press', col, row))
          probed.handleMouse(mouse('click', col, row))
        }
      }
      probed.dispose()
    }
  }
})

test('plain subagent runs and unrelated rows keep their existing rendering', () => {
  reset()
  // Two settlement notices and no tool: the existing subagent group, not ours.
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info([
    userEvent(1, 'go'),
    settlementEvent(2, { senderSessionId: 'child-a', summary: 'Background subagent child-a finished.' }),
    settlementEvent(3, { senderSessionId: 'child-b', summary: 'Background subagent child-b finished.' }),
  ], snapshot(
    childEntry('child-a', 'Alpha'),
    childEntry('child-b', 'Beta'),
  )))
  const view = new TranscriptView(store, viewOptions())
  const lines = plain(view.render(120))
  assert.ok(lines.some(line => line.includes('Subagents:')), lines.join('\n'))
  assert.ok(!lines.some(line => line.includes('Activities:')), 'a notice-only run is not a mixed activity group')

  // Adding one tool in front still leaves the notice run as its own subagent group.
  const mixed = new TranscriptView(toolPlusNoticeStore({ subagents: snapshot(childEntry()) }), viewOptions())
  assert.ok(text(mixed.render(120)).includes('Activities:'))
  assert.ok(!text(mixed.render(120)).includes('Subagents:'))
})

test('a hidden live todo still breaks the run, and the mixed group adds no timer or stdout', () => {
  reset()
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info([
    userEvent(1, 'go'),
    callEvent(2, 'call-1', 'list_agents', '{"mode":"children"}'),
    resultEvent(3, 'call-1', 'child-1 running'),
  ], snapshot(childEntry())))
  // The live checklist lands between the settled tool and the notice.
  store.handle({ type: 'todos', sessionId: 's1', value: [{ content: 'check children', status: 'completed' }] })
  store.handle({ type: 'session_event', sessionId: 's1', event: settlementEvent(5) })
  assert.deepEqual(store.items.map(item => item.kind), ['user', 'tool', 'todos', 'subagent-message'])
  // With the checklist suppressed the display node is hidden, but the native
  // fact still separates the runs exactly as it did before.
  const hidden = new TranscriptView(store, viewOptions({ suppressLiveTodos: true }))
  const lines = plain(hidden.render(120))
  assert.ok(!lines.some(line => line.includes('Activities:')), lines.join('\n'))
  assert.ok(lines.some(line => line.includes('Subtask status updated')), lines.join('\n'))
  assert.equal(hidden.liveTimerRunning, false, 'no display timer is armed by the group')
})