// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, Text, type Component, type TuiMouseEvent } from '#pi-tui'
import type { DisplayContentPart, ImageAttachmentRef, QueueEntry, SessionEvent, SessionInfo, SubagentEntry } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { createCcKeymap } from '../src/input/keymap.ts'
import { asTui, createFakeTui } from '../src/input/testing/harness.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import type { SubagentMessageTranscriptItem, ToolTranscriptItem, UserTranscriptItem } from '../src/state/transcript.ts'
import {
  ActivityGroupBlock,
  type ActivityMemberItem,
} from '../src/ui/activity-group.ts'
import type { ItemBlock, TranscriptViewOptions } from '../src/ui/blocks.ts'
import { ImageContentBody } from '../src/ui/image-content.ts'
import { DockPromptEditor } from '../src/ui/inline-editor.ts'
import { measureRows } from '../src/ui/measure.ts'
import { ModalListSurface, windowList, type ListBlock, type ListBody } from '../src/ui/modal-list.ts'
import { hoverExitEvent } from '../src/ui/mouse.ts'
import { QueueList } from '../src/ui/queue-list.ts'
import { SubagentGroupBlock } from '../src/ui/subagent-group.ts'
import { editorTheme } from '../src/ui/theme.ts'
import { clearToolExpansion, setToolExpanded } from '../src/ui/tool-expansion.ts'
import { ToolGroupBlock, type ToolGroupMember } from '../src/ui/tool-group.ts'
import { TranscriptView, type TranscriptViewHints } from '../src/ui/transcript.ts'
import { clearThinkingExpansion } from '../src/ui/thinking-block.ts'

/**
 * Regression tests for five rendering defects that were verified in the
 * transcript/dock/modal paint paths. Every test states one invariant ("only the
 * header row may be a hover target", "measure equals paint", …), not the
 * implementation that happens to satisfy it.
 */

// ---------------------------------------------------------------------------
// Shared fixtures (synthetic state only: no backend, no model, no stdout)

type MouseKind = TuiMouseEvent['type']

const mouseAt = (type: MouseKind, x: number, y: number): TuiMouseEvent => ({
  type,
  button: type === 'move' ? 'none' : 'left',
  x,
  y,
  screenX: x,
  screenY: y,
  width: 70,
  height: 40,
  shift: false,
  alt: false,
  ctrl: false,
})

const ev = (type: string, seq: number, data: unknown, extra: Partial<SessionEvent> = {}): SessionEvent => ({
  type,
  seq,
  data,
  ...extra,
})

const info = (events: SessionEvent[] = [], subagents?: SessionInfo['subagents']): SessionInfo => ({
  sessionId: 's1',
  cwd: '/tmp/work',
  provider: 'demo',
  model: 'demo',
  capabilities: [],
  events,
  ...(subagents === undefined ? {} : { subagents }),
})

const userEvent = (seq: number, text: string): SessionEvent =>
  ev('user/message', seq, { id: `u${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: 'append' })

const callEvent = (seq: number, callId: string, command: string): SessionEvent =>
  ev('tool/call', seq, { turn: 1, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command }) })

const resultEvent = (seq: number, callId: string): SessionEvent =>
  ev('tool/result', seq, {
    turn: 1,
    step: 1,
    message: {
      id: `res-${seq}`,
      role: 'tool',
      toolCallId: callId,
      content: [{ type: 'text', text: 'ok\n' }],
      isError: false,
      source: { kind: 'tool', callId },
    },
  }, { surfaceOp: 'append' })

const newStore = (events: SessionEvent[] = [], subagents?: SessionInfo['subagents']): TranscriptStore => {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info(events, subagents))
  return store
}

interface ViewOverrides {
  showThinking?: boolean
  expandTools?: boolean
  groupTools?: boolean
  groupSubagentMessages?: boolean
  suppressLiveTodos?: boolean
  hints?: TranscriptViewHints
  mouseBlocked?: boolean
}

const view = (store: TranscriptStore, overrides: ViewOverrides = {}): TranscriptView =>
  new TranscriptView(store, {
    showThinking: overrides.showThinking ?? false,
    expandTools: overrides.expandTools ?? false,
    groupTools: overrides.groupTools ?? true,
    ...(overrides.groupSubagentMessages === undefined ? {} : { groupSubagentMessages: overrides.groupSubagentMessages }),
    ...(overrides.suppressLiveTodos === undefined ? {} : { suppressLiveTodos: overrides.suppressLiveTodos }),
    hints: overrides.hints ?? {},
    screen: 'fullscreen',
  })

const toolItem = (callId: string, status: ToolTranscriptItem['status'] = 'done'): ToolTranscriptItem => ({
  kind: 'tool',
  id: `tool:${callId}`,
  callId,
  name: 'bash',
  arguments: '{"command":"ls"}',
  status,
  resultText: '',
  resultImages: 0,
  resultIsError: false,
  meta: undefined,
  version: 1,
})

const noticeItem = (seq: number): SubagentMessageTranscriptItem => ({
  kind: 'subagent-message',
  id: `subagent-message:${seq}`,
  seq,
  sourceKind: 'subagent-settled',
  senderSessionId: 'child-a',
  form: 'notice',
  summary: 'Background subagent finished.',
  text: 'Body: no blockers.',
  version: 1,
})

interface StubState {
  events: TuiMouseEvent[]
  renders: number
}

/** A member block that only records what the host dispatched to it. */
function stubBlock(item: ToolTranscriptItem | SubagentMessageTranscriptItem, lines: readonly string[], state: StubState): ItemBlock {
  return {
    itemId: item.id,
    kind: item.kind,
    version: item.version,
    update(): void {},
    invalidate(): void {},
    clearMouse(): void {},
    handleMouse(event): { handled: boolean; render: boolean } {
      state.events.push(event)
      return { handled: true, render: true }
    },
    render(width: number): string[] {
      state.renders += 1
      return lines.map(line => line.slice(0, Math.max(1, width)))
    },
  }
}

const groupFlags = (overrides: Partial<TranscriptViewOptions> = {}): TranscriptViewOptions => ({
  showThinking: false,
  expandTools: false,
  groupTools: true,
  hints: { expand: 'ctrl+o' },
  screen: 'fullscreen',
  toolLabelClip: 0,
  ...overrides,
})

// ---------------------------------------------------------------------------
// F1: a collapsed group may only claim the pointer on its header row

interface GroupHost {
  readonly name: string
  readonly group: ToolGroupBlock | ActivityGroupBlock | SubagentGroupBlock
  /** Rows painted below the header (the collapsed member summaries). */
  readonly memberRows: number
  /** First row after this group's own paint (the transcript row gap). */
  readonly gapRow: number
}

function toolHost(): GroupHost {
  const first = toolItem('a')
  const second = toolItem('b')
  const state: StubState = { events: [], renders: 0 }
  const group = new ToolGroupBlock(first, groupFlags())
  const members: ToolGroupMember[] = [
    { item: first, block: stubBlock(first, ['first'], state) },
    { item: second, block: stubBlock(second, ['second'], state) },
  ]
  group.setMembers(members)
  return { name: 'tool group', group, memberRows: 2, gapRow: 3 }
}

function activityHost(): GroupHost {
  const tool = toolItem('a')
  const notice = noticeItem(4)
  const state: StubState = { events: [], renders: 0 }
  const group = new ActivityGroupBlock(tool, groupFlags())
  const members: Array<{ item: ActivityMemberItem; block: ItemBlock }> = [
    { item: tool, block: stubBlock(tool, ['tool'], state) },
    { item: notice, block: stubBlock(notice, ['notice'], state) },
  ]
  group.setMembers(members)
  return { name: 'activity group', group, memberRows: 2, gapRow: 3 }
}

function subagentHost(): GroupHost {
  const first = noticeItem(4)
  const second = noticeItem(7)
  const state: StubState = { events: [], renders: 0 }
  const group = new SubagentGroupBlock(first, groupFlags())
  group.setMembers([
    { item: first, block: stubBlock(first, ['settled'], state) },
    { item: second, block: stubBlock(second, ['relay'], state) },
  ])
  return { name: 'subagent group', group, memberRows: 2, gapRow: 3 }
}

const groupHosts = (): GroupHost[] => [toolHost(), activityHost(), subagentHost()]

/** Placement the group claimed for itself (`header` only on row 0). */
const hoverSlotOf = (host: GroupHost): string | undefined => host.group.hoverSlot

test('a collapsed group claims the pointer only on its header row', () => {
  clearToolExpansion()
  for (const host of groupHosts()) {
    const lines = host.group.render(70)
    assert.ok(lines.length >= 1 + host.memberRows, `${host.name} paints a header plus one row per member`)
    assert.equal(hoverSlotOf(host), undefined, `${host.name}: no pointer target before motion`)

    // A member row is plain text: it advertises nothing and adopts nothing.
    host.group.handleMouse(mouseAt('move', 4, 1))
    assert.equal(hoverSlotOf(host), undefined, `${host.name}: a collapsed member row is not the header`)
    host.group.handleMouse(mouseAt('move', 4, host.memberRows))
    assert.equal(hoverSlotOf(host), undefined, `${host.name}: the last member row is not the header`)

    // Row 0 is the header control: the pointer really is on it.
    host.group.handleMouse(mouseAt('move', 4, 0))
    assert.equal(hoverSlotOf(host), 'header', `${host.name}: the header row is claimed`)

    // Leaving the header for a member row releases the claim again.
    host.group.handleMouse(mouseAt('move', 4, 1))
    assert.equal(hoverSlotOf(host), undefined, `${host.name}: the header is released when the pointer leaves row 0`)

    // The gap after the group (blank separator row) belongs to nobody.
    host.group.handleMouse(mouseAt('move', 4, 0))
    host.group.handleMouse(mouseAt('move', 4, host.gapRow))
    assert.equal(hoverSlotOf(host), undefined, `${host.name}: a row outside the paint claims nothing`)
  }
})

test('the synthetic hover leave never re-adopts a collapsed header', () => {
  clearToolExpansion()
  for (const host of groupHosts()) {
    host.group.render(70)
    host.group.handleMouse(mouseAt('move', 4, 0))
    assert.equal(hoverSlotOf(host), 'header')
    // The transcript hands its previous owner a synthetic out-of-rect leave.
    host.group.handleMouse(hoverExitEvent(mouseAt('move', 4, 0)))
    assert.equal(hoverSlotOf(host), undefined, `${host.name}: a synthetic leave adopts nothing`)
  }
})

test('an expanded group claims the header only on row 0 and the member on its own row', () => {
  clearToolExpansion()
  clearThinkingExpansion()
  const first = toolItem('a')
  const second = toolItem('b')
  const group = new ToolGroupBlock(first, groupFlags())
  const state: StubState = { events: [], renders: 0 }
  group.setMembers([
    { item: first, block: stubBlock(first, ['first top', 'first body'], state) },
    { item: second, block: stubBlock(second, ['second'], state) },
  ])
  setToolExpanded(group.key, true)
  const lines = group.render(70)
  assert.equal(lines.length, 4, 'header + 2 + 1 member rows')
  const spans = group.rowSpans
  assert.deepEqual(spans.map(span => span.startRow), [1, 3])

  group.handleMouse(mouseAt('move', 4, 0))
  assert.equal(hoverSlotOf({ ...toolHost(), group }), 'header', 'the header row is the group’s own control')
  group.handleMouse(mouseAt('move', 6, spans[0]!.startRow))
  assert.equal(hoverSlotOf({ ...toolHost(), group }), undefined, 'a member row belongs to the member block, not the header')
  assert.equal(state.events.at(-1)?.y, 0, 'the member hears the event re-based to its own first row')
  clearToolExpansion()
})

test('hovering another group still hands the pointer over (existing contract kept)', () => {
  clearToolExpansion()
  const store = newStore([
    userEvent(1, 'first run'),
    callEvent(2, 'call-a', 'npm test'),
    resultEvent(3, 'call-a'),
    callEvent(4, 'call-b', 'npm run build'),
    resultEvent(5, 'call-b'),
    userEvent(6, 'second run'),
    callEvent(7, 'call-c', 'npm run lint'),
    resultEvent(8, 'call-c'),
    callEvent(9, 'call-d', 'npm run typecheck'),
    resultEvent(10, 'call-d'),
  ])
  const view1 = view(store)
  const first = view1.render(70)
  const headers = first.flatMap((line, row) => (stripTerminalSequences(line).includes('click to show more') ? [row] : []))
  assert.equal(headers.length, 2, 'two separated tool runs')

  view1.handleMouse(mouseAt('move', 4, headers[0]!))
  assert.equal(view1.hoverOwnerItemId, 'tool:call-a')
  assert.equal(view1.hoverOwnerPlacement, `row ${headers[0]}`)

  view1.handleMouse(mouseAt('move', 4, headers[1]!))
  assert.equal(view1.hoverOwnerItemId, 'tool:call-c', 'the first group was released for the second')

  // A member row of the second (collapsed) group is not its header: the header
  // claim is released and the plain member row owns no hover at all.
  view1.handleMouse(mouseAt('move', 4, headers[1]! + 1))
  assert.notEqual(view1.hoverOwnerPlacement, 'header')
})

// ---------------------------------------------------------------------------
// F2: body events are translated to body-local coordinates *and* body size

const listRow = (index: number): ListBlock => ({
  lines: [`row ${index}`],
  index,
  key: `row:${index}`,
  ...(index === 0 ? { focused: true } : {}),
})

const listBody = (blocks: readonly ListBlock[]): ListBody => windowList(blocks, 12)

const listConfig = (): Parameters<ModalListSurface['render']>[1] => ({
  title: 'Settings',
  ownerKey: 'row:0',
  beforeRows: 1,
  before: () => ['header'],
  status: () => [],
})

test('a translated body event carries the body size, not the whole screen', () => {
  const list = new ModalListSurface(asTui(createFakeTui(24, 60)), { maxHeight: 12 })
  assert.equal(list.bodyMouse(mouseAt('move', 4, 3)), undefined, 'nothing is measured before the first paint')
  const lines = list.render(60, listConfig(), () => listBody([listRow(0), listRow(1), listRow(2)]))
  assert.ok(lines.length > 0)
  const geometry = list.bodyGeometry
  assert.ok(geometry !== undefined)

  const screenWide = mouseAt('move', geometry.bodyCol + 2, geometry.bodyRow + 1)
  assert.equal(screenWide.width, 70, 'the incoming event describes the whole terminal')
  const translated = list.bodyMouse(screenWide)
  assert.ok(translated !== undefined)
  assert.equal(translated.x, 2)
  assert.equal(translated.y, 1)
  assert.equal(translated.width, geometry.bodyWidth, 'a body that wraps to the event width must wrap to the body')
  assert.equal(translated.height, geometry.bodyHeight)
  assert.notEqual(translated.width, screenWide.width, 'the full screen width is never forwarded to the body')
  assert.notEqual(translated.height, screenWide.height)

  // Outside the body (chrome, border, past the last body row) stays undefined.
  assert.equal(list.bodyMouse(mouseAt('move', 1, geometry.bodyRow)), undefined, 'the frame border is not body')
  assert.equal(list.bodyMouse(mouseAt('move', geometry.bodyCol, 0)), undefined, 'the title row is chrome')
  assert.equal(
    list.bodyMouse(mouseAt('move', geometry.bodyCol, geometry.bodyRow + geometry.bodyHeight)),
    undefined,
    'the first row after the body is chrome again',
  )
})

// ---------------------------------------------------------------------------
// F3: at most one blank row between runs, never a dangling one

const imageRef = (id: string): ImageAttachmentRef => ({
  attachmentId: `fixture:${id}`,
  mediaType: 'image/png',
  bytes: 64,
  width: 2,
  height: 2,
  name: `${id}.png`,
})

const userItem = (content: DisplayContentPart[]): UserTranscriptItem => ({
  kind: 'user',
  id: 'u1',
  seq: 1,
  text: content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n\n'),
  imageCount: content.filter(part => part.type === 'image').length,
  content,
  version: 1,
})

const bodyLines = (content: DisplayContentPart[], width = 40): { lines: string[]; markerRows: readonly number[] } => {
  const body = new ImageContentBody('plain')
  body.setItem(userItem(content))
  const result = body.render(width, { interactive: false, fullscreen: true })
  return { lines: result.lines.map(line => stripTerminalSequences(line)), markerRows: result.markerRows }
}

const blankRuns = (lines: readonly string[]): number[] => {
  const runs: number[] = []
  let current = 0
  for (const line of lines) {
    if (line.trim() === '') current += 1
    else {
      if (current > 0) runs.push(current)
      current = 0
    }
  }
  if (current > 0) runs.push(current)
  return runs
}

test('a text run is separated from an image run by at most one blank row', () => {
  const content: DisplayContentPart[] = [
    { type: 'text', text: 'before the image' },
    { type: 'image', attachment: imageRef('a') },
    { type: 'text', text: 'after the image' },
  ]
  const { lines, markerRows } = bodyLines(content)
  assert.equal(markerRows.length, 1)
  const markerRow = markerRows[0]!
  assert.ok(lines[markerRow]!.includes('Image'), lines[markerRow])
  // The text after the marker starts exactly one blank row below it.
  assert.equal(lines[markerRow + 1], '')
  assert.ok(lines[markerRow + 2]!.includes('after the image'))
  assert.deepEqual(blankRuns(lines), [1], 'exactly one separator row in the whole body')
  assert.notEqual(lines.at(-1), '', 'no dangling blank row at the end of the body')
})

test('a text run that paints nothing never stacks a separator between two images', () => {
  // A whitespace-only run is real durable content but paints no row: the body
  // must not leave a blank line where nothing was painted (the old code pushed a
  // separator first and then discovered the run was empty).
  const { lines, markerRows } = bodyLines([
    { type: 'image', attachment: imageRef('a') },
    { type: 'text', text: '   ' },
    { type: 'image', attachment: imageRef('b') },
  ])
  assert.equal(markerRows.length, 2)
  assert.deepEqual(markerRows, [0, 1], 'the two markers stay adjacent')
  assert.deepEqual(blankRuns(lines), [], 'no separator without a following run')
})

test('mixed text and image runs never produce two blank rows in a row', () => {
  const content: DisplayContentPart[] = [
    { type: 'text', text: 'first text' },
    { type: 'image', attachment: imageRef('a') },
    { type: 'image', attachment: imageRef('b') },
    { type: 'text', text: 'second text' },
    { type: 'image', attachment: imageRef('c') },
    { type: 'text', text: 'third text' },
  ]
  for (const width of [12, 24, 40, 80]) {
    const { lines, markerRows } = bodyLines(content, width)
    assert.equal(markerRows.length, 3)
    assert.ok(blankRuns(lines).every(run => run === 1), `width ${width}: at most one blank row between runs`)
    assert.notEqual(lines[0], '', `width ${width}: the body never starts with a blank row`)
    assert.notEqual(lines.at(-1), '', `width ${width}: the body never ends with a blank row`)
  }
})

// ---------------------------------------------------------------------------
// F4: the projection is planned once per input change, never per paint

const projectionStore = (): TranscriptStore => newStore([
  userEvent(1, 'please run both commands'),
  callEvent(2, 'call-a', 'npm test'),
  resultEvent(3, 'call-a'),
  callEvent(4, 'call-b', 'npm run build'),
  resultEvent(5, 'call-b'),
])

test('an unchanged transcript is not re-projected between paints', () => {
  const store = projectionStore()
  const view1 = view(store)
  view1.render(70)
  const builds = view1.projectionBuilds
  assert.equal(builds, 1, 'the first paint plans the frame exactly once')

  // Same items, same preferences: a keystroke, a spinner tick or a hover repaint
  // must not re-run the three plan folds.
  view1.render(70)
  view1.render(70)
  assert.equal(view1.projectionBuilds, builds, 'repeated paints reuse the planned frame')

  // Width is not a projection input: the plan functions take the item order and
  // the display preferences only, so a resize alone must not re-plan either.
  view1.render(40)
  view1.render(120)
  assert.equal(view1.projectionBuilds, builds, 'a resize re-flows rows but not the projection')

  // Pointer motion and the viewport-anchor counter read the same cache.
  view1.handleMouse(mouseAt('move', 4, 0))
  void view1.expandedDisclosureCount
  assert.equal(view1.projectionBuilds, builds, 'hover motion never re-plans')
})

test('every preference that changes the projection invalidates the planned frame', () => {
  const store = projectionStore()
  const view1 = view(store)
  view1.render(70)
  let builds = view1.projectionBuilds

  const mutations: Array<[string, (target: TranscriptView) => void]> = [
    ['groupTools', target => { target.options.groupTools = false }],
    ['groupSubagentMessages', target => { target.options.groupSubagentMessages = false }],
    ['showThinking', target => { target.options.showThinking = true }],
    ['suppressLiveTodos', target => { target.options.suppressLiveTodos = true }],
  ]
  for (const [name, mutate] of mutations) {
    const fresh = view(store)
    fresh.render(70)
    const before = fresh.projectionBuilds
    mutate(fresh)
    fresh.render(70)
    assert.equal(fresh.projectionBuilds, before + 1, `${name} must re-plan exactly once`)
    assert.equal(fresh.projectionBuilds, before + 1)
    fresh.render(70)
    assert.equal(fresh.projectionBuilds, before + 1, `${name}: the new plan is reused afterwards`)
  }
  // The loop's own baseline is untouched by the copies.
  assert.equal(view1.projectionBuilds, builds)
  builds += 0
})

test('a changed item re-projects while an identical item list keeps the plan', () => {
  const store = projectionStore()
  const view1 = view(store)
  view1.render(70)
  const builds = view1.projectionBuilds
  store.handle({ type: 'session_event', sessionId: 's1', event: callEvent(6, 'call-c', 'npm run lint') } as never)
  view1.render(70)
  assert.equal(view1.projectionBuilds, builds + 1, 'a new tool call changes the run boundaries')

  // The same content re-read from the store (a settled status, an unchanged
  // replay) keeps the plan: identity is the projection input, not a timestamp.
  view1.render(70)
  view1.render(70)
  assert.equal(view1.projectionBuilds, builds + 1)
})

test('an item whose content changes re-plans even when its identity stays the same', () => {
  // `toolItemCarriesDiff` reads the call's real `meta`/presentation, so a durable
  // result can change the *projection* (a groupable call becomes its own card)
  // while the item id, kind and position stay identical. A cache keyed on
  // identity alone would keep painting the stale group.
  const store = newStore([
    callEvent(1, 'call-a', 'npm test'),
    callEvent(2, 'call-b', 'npm run build'),
  ])
  const view1 = view(store)
  const grouped = view1.render(70).map(line => stripTerminalSequences(line))
  assert.equal(grouped.filter(line => line.includes('click to show more')).length, 1, 'both calls share one group')
  const builds = view1.projectionBuilds

  store.handle({
    type: 'session_event',
    sessionId: 's1',
    event: ev('tool/result', 3, {
      turn: 1,
      step: 1,
      meta: { diffs: [{ path: 'src/a.ts' }] },
      message: {
        id: 'res-3',
        role: 'tool',
        toolCallId: 'call-a',
        content: [{ type: 'text', text: 'ok\n' }],
        isError: false,
        source: { kind: 'tool', callId: 'call-a' },
      },
    }, { surfaceOp: 'append' }),
  } as never)
  const split = view1.render(70).map(line => stripTerminalSequences(line))
  assert.equal(view1.projectionBuilds, builds + 1, 'a content change must re-plan the frame')
  assert.equal(
    split.filter(line => line.includes('click to show more')).length,
    0,
    'the diff-carrying call left the run, so the group is gone',
  )
  // The unchanged call is still its own row, and the frame is stable afterwards.
  assert.equal(view1.projectionBuilds, builds + 1)
  view1.render(70)
  assert.equal(view1.projectionBuilds, builds + 1, 'the re-planned frame is reused')
})

test('anchored child rows are memoized per read and do not re-plan an unchanged frame', () => {
  const entries: SubagentEntry[] = [
    { id: 'child-a', parentSessionId: 's1', catalogSeq: 2, mode: 'one-shot', status: 'running', label: 'Alpha' },
    { id: 'child-b', parentSessionId: 's1', catalogSeq: 3, mode: 'one-shot', status: 'completed', label: 'Beta' },
  ]
  const store = newStore([userEvent(1, 'spawn the children')], { entries })
  // `store.items` reuses the composed array until a real projection change; the
  // plan cache must still compare the items, not the array object.
  assert.equal(store.items, store.items)
  const view1 = view(store)
  view1.render(70)
  const builds = view1.projectionBuilds
  view1.render(70)
  view1.render(70)
  assert.equal(view1.projectionBuilds, builds, 'a re-composed but unchanged order is the same projection input')
})

// ---------------------------------------------------------------------------
// F5: measuring a dock member equals painting it

const queueRow = (patch: Partial<QueueEntry> = {}): QueueEntry => ({
  messageId: 'native-queue',
  text: '',
  target: 'next-turn',
  images: 0,
  ...patch,
})

const queueActions = { sendNow(): void {}, edit(): void {}, cancel(): void {}, changed(): void {} }

/** The invariant F5 exists for: the measurement *is* the paint's row count. */
const assertMeasured = (name: string, component: Component, widths: readonly number[] = [4, 10, 24, 40, 80]): void => {
  for (const width of widths) {
    const measured = measureRows(component, width)
    const painted = component.render(width).length
    assert.equal(measured, painted, `${name} at width ${width}: measure ${measured} !== paint ${painted}`)
    // Idempotent: measuring again, after a paint, still agrees with the paint.
    assert.equal(measureRows(component, width), component.render(width).length, `${name} at width ${width}: measuring is stable`)
  }
}

test('the queue list measures exactly the rows it paints', () => {
  const list = new QueueList(queueActions)
  // Empty: nothing is painted, nothing is reserved.
  list.rows = []
  assertMeasured('empty queue', list)
  assert.equal(list.measureRows(80), 0)
  assert.equal(list.render(80).length, 0)

  // One row.
  list.rows = [queueRow({ messageId: 'q1', text: 'run the tests' })]
  assertMeasured('single-row queue', list)
  assert.equal(list.measureRows(80), 3, 'header + one message + separator')

  // Several rows, including CJK/emoji and attachments that widen a row.
  list.rows = [
    queueRow({ messageId: 'q1', text: 'run the tests' }),
    queueRow({ messageId: 'q2', text: '中文 😀 emoji mixed', images: 2 }),
    queueRow({ messageId: 'q3', text: '', files: 2, target: 'next-step' }),
  ]
  assertMeasured('multi-row queue', list)
  assert.equal(list.measureRows(80), 5)

  // Collapsed: the header only.
  list.setDefaultCollapsed(true)
  list.invalidate()
  assertMeasured('collapsed queue', list)
  assert.equal(list.measureRows(80), 2, 'folded header + separator')

  // A content change (a row leaving) keeps them equal.
  list.rows = [queueRow({ messageId: 'q2', text: '中文 😀 emoji mixed', images: 2 })]
  list.invalidate()
  assertMeasured('queue after a content change', list)
})

test('the dock prompt editor measures exactly the rows it paints', () => {
  const keymap = createCcKeymap()
  const editor = new DockPromptEditor(asTui(createFakeTui(24, 80)), editorTheme, { paddingX: 2, keymap, context: 'editor' })
  assert.equal(typeof editor.measureRows, 'function', 'the App can measure the dock editor')

  // Empty prompt: border + cursor row + border.
  assertMeasured('empty editor', editor)
  assert.equal(editor.measureRows(80), 3)

  // One logical line.
  editor.setText('hello world')
  assertMeasured('single-line editor', editor)

  // A line that wraps at a narrow width.
  editor.setText('the quick brown fox jumps over the lazy dog')
  assertMeasured('wrapping editor', editor, [12, 20, 40, 80])
  assert.ok(editor.measureRows(20) > editor.measureRows(80), 'narrower width wraps into more rows')

  // Multiple logical lines.
  editor.setText('first line\nsecond line\nthird line')
  assertMeasured('multi-line editor', editor, [20, 40, 80])

  // Wide graphemes: CJK and emoji must count their real display width.
  editor.setText('中文内容 😀🎉 mixed text 中文字符')
  assertMeasured('CJK/emoji editor', editor, [8, 16, 24, 40, 80])

  // A content change (typing through the one editor state) stays consistent.
  editor.setText('')
  editor.handleInput('a')
  editor.handleInput('b')
  editor.flushInputBuffer?.()
  assertMeasured('editor after typing', editor)
  assert.equal(editor.getText(), 'ab', 'the measurement never consumed or rewrote the draft')
})

test('the generic measurement entry point is the paint’s row count', () => {
  // Pi's `Text` has no `measureRows`, so the helper falls back to its own
  // content+width line cache — the same O(1) cost as the paint it replaces.
  const hint = new Text('ctrl+o to expand · esc to cancel · ctrl+c to interrupt', 1, 0)
  assertMeasured('hint text', hint, [10, 24, 40, 80])
  hint.setText('')
  assertMeasured('empty hint text', hint, [10, 40])
  hint.setText('中文提示 😀 换行测试')
  assertMeasured('CJK hint text', hint, [8, 16, 40])

  // A member with its own `measureRows` answers from its state.
  const list = new QueueList(queueActions)
  list.rows = [queueRow({ messageId: 'q1', text: 'queued' })]
  assert.equal(measureRows(list, 80), list.measureRows(80))
  assert.equal(measureRows(list, 80), list.render(80).length)
})