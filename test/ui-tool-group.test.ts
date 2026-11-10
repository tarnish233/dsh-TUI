// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, type TuiMouseEvent, visibleWidth } from '#pi-tui'
import type { SessionEvent, SessionInfo } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { createCcKeymap } from '../src/input/keymap.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import type { ToolTranscriptItem, TranscriptItem } from '../src/state/transcript.ts'
import type { ItemBlock, TranscriptViewOptions } from '../src/ui/blocks.ts'
import {
  clearThinkingExpansion,
  isThinkingExpanded,
  setThinkingExpanded,
  thinkingExpansionKey,
} from '../src/ui/thinking-block.ts'
import {
  clearToolExpansion,
  isToolExpanded,
  setToolExpanded,
  toolExpansionKey,
  toolGroupExpansionKey,
} from '../src/ui/tool-expansion.ts'
import {
  durationTail,
  isGroupableToolItem,
  isTransparentItem,
  planTranscriptNodes,
  ToolGroupBlock,
  toolGroupCounts,
  toolGroupLabel,
  toolGroupNameList,
  toolStatusGlyph,
  type ToolGroupMember,
} from '../src/ui/tool-group.ts'
import { TranscriptView, transcriptHints } from '../src/ui/transcript.ts'

// ---------------------------------------------------------------------------
// Fixtures (synthetic DSH events only; no backend, no model, no stdout)

const info = (events: SessionEvent[] = [], sessionId = 's1'): SessionInfo => ({
  sessionId,
  cwd: '/tmp/work',
  provider: 'demo',
  model: 'demo',
  capabilities: [],
  events,
})

const ev = (type: string, seq: number, data: unknown, extra: Partial<SessionEvent> = {}): SessionEvent => ({
  type,
  seq,
  // No clock unless a test states one: a durable event without a time is an
  // unrecorded reading, which is exactly the "no measurement" case the rows
  // must not turn into `· 0ms`. Tests that assert a real duration pass `time`
  // explicitly (including a genuine same-instant `0`).
  data,
  ...extra,
})

const callEvent = (seq: number, callId: string, name: string, args: string, turn = 1, step = 1): SessionEvent =>
  ev('tool/call', seq, { turn, step, callId, name, arguments: args })

const resultEvent = (
  seq: number,
  callId: string,
  text: string,
  extra: Partial<SessionEvent> = {},
  isError = false,
): SessionEvent => ev('tool/result', seq, {
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
}, { surfaceOp: 'append', ...extra })

const userEvent = (seq: number, text: string): SessionEvent =>
  ev('user/message', seq, { id: `u${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: 'append' })

const assistantEvent = (
  seq: number,
  content: readonly unknown[],
  extra: Partial<SessionEvent> = {},
): SessionEvent => ev('assistant/message', seq, {
  turn: 1,
  step: 1,
  message: { id: `a${seq}`, role: 'assistant', content, source: { kind: 'model', provider: 'demo', model: 'demo' } },
  stream: [],
}, { surfaceOp: 'append', ...extra })

function newStore(events: SessionEvent[] = [], sessionId = 's1'): TranscriptStore {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info(events, sessionId))
  return store
}

/** Append a durable event after `reset` (used for live-ish status changes). */
function push(store: TranscriptStore, event: SessionEvent, sessionId = 's1'): void {
  store.handle({ type: 'session_event', sessionId, event })
}

const plain = (lines: readonly string[]): string => stripTerminalSequences(lines.join('\n'))

interface ViewOverrides {
  showThinking?: boolean
  expandTools?: boolean
  groupTools?: boolean
  screen?: 'inline' | 'fullscreen'
  thinkingPreviewLines?: number
  thinkingLiveTimerMs?: number
  now?: () => number
  mouseBlocked?: boolean
  hints?: { expand?: string; toolsDetails?: string; thinking?: string }
  expandedOutputMaxLines?: number
  toolLabelClip?: number
  onRenderRequest?: () => void
  onViewportAnchor?: (expanding: boolean) => void
  onToolDetails?: (request: { callId: string; section: 'input' | 'output' }) => void
}

function view(store: TranscriptStore, overrides: ViewOverrides = {}): TranscriptView {
  return new TranscriptView(store, {
    showThinking: overrides.showThinking ?? false,
    expandTools: overrides.expandTools ?? false,
    groupTools: overrides.groupTools ?? true,
    hints: overrides.hints ?? { expand: 'ctrl+o' },
    screen: overrides.screen ?? 'inline',
    toolLabelClip: overrides.toolLabelClip ?? 0,
    ...(overrides.thinkingPreviewLines === undefined ? {} : { thinkingPreviewLines: overrides.thinkingPreviewLines }),
    ...(overrides.thinkingLiveTimerMs === undefined ? {} : { thinkingLiveTimerMs: overrides.thinkingLiveTimerMs }),
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
    ...(overrides.expandedOutputMaxLines === undefined ? {} : { expandedOutputMaxLines: overrides.expandedOutputMaxLines }),
    ...(overrides.mouseBlocked === undefined ? {} : { mouseBlocked: overrides.mouseBlocked }),
    ...(overrides.onRenderRequest === undefined ? {} : { onRenderRequest: overrides.onRenderRequest }),
    ...(overrides.onViewportAnchor === undefined ? {} : { onViewportAnchor: overrides.onViewportAnchor }),
    ...(overrides.onToolDetails === undefined ? {} : { onToolDetails: overrides.onToolDetails }),
  })
}

type MouseKind = TuiMouseEvent['type']

const mouseAt = (type: MouseKind, x: number, y: number, overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
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
  ...overrides,
})

const reset = (): void => {
  clearToolExpansion()
  clearThinkingExpansion()
}

const linesOf = (text: string): string[] => text.split('\n')

const groupHeaderRow = (text: string): number =>
  linesOf(text).findIndex(line => line.startsWith('● ') || line.startsWith('◌ '))

const rowIndex = (text: string, needle: string): number => linesOf(text).findIndex(line => line.includes(needle))

// ---------------------------------------------------------------------------
// Pure projection

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

test('the projection is a pure, order-preserving view over the declared items', () => {
  reset()
  const items: TranscriptItem[] = [
    toolItem('a', 'bash', 'done'),
    toolItem('b', 'bash', 'running'),
    toolItem('c', 'read', 'proposed'),
  ]
  const nodes = planTranscriptNodes(items, { groupTools: true, showThinking: false })
  assert.equal(nodes.length, 1)
  const group = nodes[0]!
  assert.equal(group.kind, 'group')
  if (group.kind !== 'group') return
  assert.deepEqual(group.members.map(member => member.callId), ['a', 'b', 'c'], 'declaration order is kept')
  assert.equal(group.anchor.callId, 'a', 'the first member is the anchor')
  // The store itself is never rewritten.
  assert.deepEqual(items.map(item => item.id), ['tool:a', 'tool:b', 'tool:c'])

  // `groupTools=false` is the previous behaviour: one card per call.
  const singles = planTranscriptNodes(items, { groupTools: false, showThinking: false })
  assert.deepEqual(singles.map(node => node.kind), ['item', 'item', 'item'])
  assert.deepEqual(singles.map(node => (node.kind === 'item' ? node.item.id : '')), ['tool:a', 'tool:b', 'tool:c'])
})

test('a single call never becomes a group and file-mutating/diff calls stay their own card', () => {
  reset()
  const only = planTranscriptNodes([toolItem('a', 'bash', 'done')], { groupTools: true, showThinking: false })
  assert.deepEqual(only.map(node => node.kind), ['item'])

  const edit = toolItem('e', 'edit', 'done')
  const write = toolItem('w', 'write', 'done')
  const patch = toolItem('p', 'apply_patch', 'done')
  const diffCard = toolItem('d', 'custom_tool', 'done', {
    presentation: { result: { card: 'diff', diffs: [{ path: 'a.ts', oldText: null, newText: 'x' }] } },
  })
  const metaDiff = toolItem('m', 'custom_tool', 'done', { meta: { diffs: [{ path: 'b.ts', oldText: 'a', newText: 'b' }] } })
  for (const item of [edit, write, patch, diffCard, metaDiff]) {
    assert.equal(isGroupableToolItem(item), false, `${item.name} must not be grouped`)
  }
  const nodes = planTranscriptNodes(
    [toolItem('a', 'bash', 'done'), edit, write, patch, diffCard, metaDiff, toolItem('b', 'bash', 'done')],
    { groupTools: true, showThinking: false },
  )
  assert.deepEqual(
    nodes.map(node => (node.kind === 'group' ? 'group' : node.item.id)),
    ['tool:a', 'tool:e', 'tool:w', 'tool:p', 'tool:d', 'tool:m', 'tool:b'],
    'every excluded call breaks the run instead of joining it',
  )
})

test('visible rows break a group, painted-nothing items may be crossed', () => {
  reset()
  const emptyAssistant = { kind: 'assistant', id: 'assistant:9', text: '', thinking: '', interrupted: false, version: 1 } as const
  const hiddenThought = { kind: 'assistant', id: 'assistant:8', text: '', thinking: 'a thought', interrupted: false, version: 1 } as const
  const visibleText = { kind: 'assistant', id: 'assistant:7', text: 'answer', thinking: '', interrupted: false, version: 1 } as const
  const partialAttempt = {
    kind: 'attempt', id: 'attempt:6', turn: 1, step: 1, text: '', thinking: 'thought', toolNames: [],
    status: 'streaming', tentative: true, version: 1,
  } as const

  for (const showThinking of [false, true]) {
    // The `✻ Thought (hidden)` placeholder is a real row: it must never be
    // swallowed by a group, so a thought breaks the run in both modes.
    assert.equal(isTransparentItem(hiddenThought), false, `hidden thought placeholder (showThinking=${showThinking})`)
    assert.equal(isTransparentItem(partialAttempt), false)
    assert.equal(isTransparentItem(emptyAssistant), true)
    assert.equal(isTransparentItem(visibleText), false)

    const nodes = planTranscriptNodes(
      [toolItem('a', 'bash', 'done'), emptyAssistant, toolItem('b', 'bash', 'done'), hiddenThought, toolItem('c', 'bash', 'done')],
      { groupTools: true, showThinking },
    )
    assert.deepEqual(nodes.map(node => (node.kind === 'group' ? node.members.map(member => member.callId).join('+') : node.item.id)), ['a+b', 'assistant:8', 'tool:c'])
  }
})

test('a known turn change breaks the run, an unknown one never invents a break', () => {
  reset()
  const nodes = planTranscriptNodes(
    [
      toolItem('a', 'bash', 'done', { turn: 1, step: 1 }),
      toolItem('b', 'bash', 'done', { turn: 1, step: 2 }),
      toolItem('c', 'bash', 'done'),
      toolItem('d', 'bash', 'done', { turn: 2 }),
    ],
    { groupTools: true, showThinking: false },
  )
  // Turn 1 keeps grouping across a step change and across an item that carries
  // no turn number at all; the known turn 2 breaks it.
  assert.deepEqual(
    nodes.map(node => (node.kind === 'group' ? node.members.map(member => member.callId).join('+') : node.item.id)),
    ['a+b+c', 'tool:d'],
  )
})

// ---------------------------------------------------------------------------
// Header wording

test('the header names a single tool, or Multiple Tools with per-name counts', () => {
  reset()
  const bash = [toolItem('a', 'bash', 'done'), toolItem('b', 'bash', 'running')]
  assert.equal(toolGroupLabel(bash), 'Bash')
  assert.equal(toolGroupLabel([toolItem('a', 'bash', 'done'), toolItem('b', 'read', 'done')]), 'Multiple Tools')
  assert.equal(toolGroupNameList([toolItem('a', 'bash', 'done'), toolItem('b', 'bash', 'done'), toolItem('c', 'read', 'done')]), 'Bash×2, Read×1')

  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"npm test"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'bash', '{"command":"npm run build"}'),
    resultEvent(4, 'c2', 'ok'),
  ])
  const output = plain(view(store).render(70))
  assert.match(output, /● Bash: 2 done · ctrl\+o to expand/)
  assert.doesNotMatch(output, /Multiple Tools/)
  assert.doesNotMatch(output, /Bash · 2 done/, 'counts are bound to the name with a colon')

  const mixed = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"npm test"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'read', '{"path":"src/a.ts"}'),
    resultEvent(4, 'c2', 'one line'),
  ])
  const mixedOutput = plain(view(mixed).render(70))
  assert.match(mixedOutput, /● Multiple Tools: 2 done · Bash×1, Read×1/)
})

test('proposed/running/done/error/unknown are counted apart and unknown is never "running"', () => {
  reset()
  const counts = toolGroupCounts([
    toolItem('a', 'bash', 'proposed'),
    toolItem('b', 'bash', 'running'),
    toolItem('c', 'bash', 'running'),
    toolItem('d', 'bash', 'done'),
    toolItem('e', 'bash', 'error'),
    toolItem('f', 'bash', 'unknown'),
  ])
  assert.deepEqual(counts, { proposed: 1, running: 2, done: 1, error: 1, unknown: 1 })

  // A turn that ended before any tool/result leaves a restored card with no
  // result: it is reported as unknown, not as still running.
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"npm test"}'),
    callEvent(2, 'c2', 'bash', '{"command":"npm run build"}'),
  ])
  const output = plain(view(store).render(70))
  assert.match(output, /2 unknown/)
  assert.doesNotMatch(output, /running/)
})

test('members are listed by declaration order even when results settle out of order', () => {
  reset()
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"first call"}'),
    callEvent(2, 'c2', 'bash', '{"command":"second call"}'),
    // Results arrive in the opposite order; a duplicate call frame arrives last.
    resultEvent(3, 'c2', 'second done'),
    resultEvent(4, 'c1', 'first done'),
    callEvent(5, 'c1', 'bash', '{"command":"first call"}'),
  ])
  const output = plain(view(store).render(70))
  const first = rowIndex(output, 'first call')
  const second = rowIndex(output, 'second call')
  assert.ok(first >= 0 && second >= 0)
  assert.ok(first < second, 'rows keep the declared order, not the completion order')
  assert.match(output, /2 done/, 'a late duplicate call does not reset a settled result')
  assert.doesNotMatch(output, /parallel/)
})

// ---------------------------------------------------------------------------
// Collapsed rows

test('each call is one row with its real summary and the measured shell duration', () => {
  reset()
  const store = newStore([
    ev('tool/call', 1, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' }, { time: 1_000 }),
    ev('tool/result', 2, {
      turn: 1,
      step: 1,
      message: { id: 'r2', role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false, source: { kind: 'tool', callId: 'c1' } },
    }, { surfaceOp: 'append', time: 2_450 }),
    ev('tool/call', 3, { turn: 1, step: 1, callId: 'c2', name: 'bash', arguments: '{"command":"npm run build"}' }, { time: 2_500 }),
    ev('tool/result', 4, {
      turn: 1,
      step: 1,
      message: { id: 'r4', role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'ok' }], isError: false, source: { kind: 'tool', callId: 'c2' } },
    }, { surfaceOp: 'append', time: 3_500 }),
  ])
  const output = plain(view(store).render(70))
  const rows = linesOf(output).filter(line => line.startsWith('├ ') || line.startsWith('└ '))
  assert.equal(rows.length, 2, 'one row per call')
  // `✓` here means "a tool/result arrived without a failure marker", never that
  // the command exited 0.
  assert.match(rows[0] ?? '', /^├ ✓ Bash npm test · 1\.4s$/)
  assert.match(rows[1] ?? '', /^└ ✓ Bash npm run build · 1\.0s$/)
  assert.equal(durationTail(undefined), '', 'no measurement prints nothing')
  assert.equal(durationTail(0), ' · 0ms', 'a real same-instant measurement is a 0ms reading, not silence')
  assert.equal(durationTail(1_450), ' · 1.4s')
  assert.equal(durationTail(-1), '', 'a backwards clock is not a measurement')
  assert.equal(durationTail(Number.NaN), '', 'a non-finite reading is not a measurement')
  assert.equal(durationTail(Number.POSITIVE_INFINITY), '', 'a non-finite reading is not a measurement')
})

test('a settled same-instant call keeps its real 0ms in the group row', () => {
  reset()
  // The durable call and its result share one clock reading: DSH's `toolMs` is
  // `max(0, settled - started)`, so this is a genuine 0ms measurement and the
  // row must not hide it (the single card and the details status line print it).
  const store = newStore([
    ev('tool/call', 1, { turn: 1, step: 1, callId: 'z1', name: 'bash', arguments: '{"command":"true"}' }, { time: 7_000 }),
    ev('tool/result', 2, {
      turn: 1,
      step: 1,
      message: { id: 'r2', role: 'tool', toolCallId: 'z1', content: [{ type: 'text', text: 'ok' }], isError: false, source: { kind: 'tool', callId: 'z1' } },
    }, { surfaceOp: 'append', time: 7_000 }),
    ev('tool/call', 3, { turn: 1, step: 1, callId: 'z2', name: 'bash', arguments: '{"command":"false"}' }, { time: 7_000 }),
    ev('tool/result', 4, {
      turn: 1,
      step: 1,
      message: { id: 'r4', role: 'tool', toolCallId: 'z2', content: [{ type: 'text', text: 'ok' }], isError: false, source: { kind: 'tool', callId: 'z2' } },
    }, { surfaceOp: 'append', time: 7_500 }),
  ])
  const rows = linesOf(plain(view(store).render(70))).filter(line => line.startsWith('├ ') || line.startsWith('└ '))
  assert.equal(rows.length, 2)
  assert.match(rows[0] ?? '', /^├ ✓ Bash true · 0ms$/, 'the real zero measurement is shown, never rounded away')
  assert.match(rows[1] ?? '', /^└ ✓ Bash false · 500ms$/)

  // A call with no measurement at all still prints no timing claim.
  const pending = newStore([callEvent(1, 'p1', 'bash', '{"command":"sleep 1"}'), callEvent(2, 'p2', 'bash', '{"command":"sleep 2"}')])
  const pendingRows = linesOf(plain(view(pending).render(70))).filter(line => line.startsWith('├ ') || line.startsWith('└ '))
  assert.deepEqual(pendingRows.map(row => / · \d/.test(row)), [false, false], 'running calls never advertise elapsed time')
})

test('the tree glyphs mark the last member and nothing claims a parallel run', () => {
  reset()
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    callEvent(2, 'c2', 'bash', '{"command":"two"}'),
    callEvent(3, 'c3', 'bash', '{"command":"three"}'),
  ])
  const rows = linesOf(plain(view(store).render(70))).filter(line => line.startsWith('├ ') || line.startsWith('└ '))
  assert.equal(rows.length, 3)
  assert.match(rows[0] ?? '', /^├ ◌ Bash one$/, 'an unresolved call carries its own status glyph')
  assert.match(rows[1] ?? '', /^├ ◌ /)
  assert.match(rows[2] ?? '', /^└ ◌ /)
})

// ---------------------------------------------------------------------------
// groupTools on/off

test('groupTools=false restores one card per call through the same item cache', () => {
  reset()
  const events = [
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    resultEvent(2, 'c1', 'first output'),
    callEvent(3, 'c2', 'bash', '{"command":"two"}'),
    resultEvent(4, 'c2', 'second output'),
  ]
  const grouped = view(newStore(events), { groupTools: true })
  const groupedOutput = plain(grouped.render(70))
  assert.match(groupedOutput, /● Bash/)
  assert.doesNotMatch(groupedOutput, /first output/, 'a collapsed group shows summaries, not bodies')

  const singles = view(newStore(events), { groupTools: false })
  const singleOutput = plain(singles.render(70))
  assert.doesNotMatch(singleOutput, /● /)
  assert.match(singleOutput, /⏺ Bash/)
  assert.equal(singleOutput.split('\n').filter(line => line.startsWith('⏺ ')).length, 2, 'one card per call')
  assert.deepEqual(singles.rowSpans.map(span => span.itemId), ['tool:c1', 'tool:c2'], 'one span per call')

  // Flipping the setting on the same view re-projects without touching the store.
  const store = newStore(events)
  const flip = view(store, { groupTools: true })
  flip.render(70)
  flip.options.groupTools = false
  assert.equal(flip.render(70).length > 0, true)
  assert.doesNotMatch(plain(flip.render(70)), /● Bash/)
  flip.options.groupTools = true
  assert.match(plain(flip.render(70)), /● Bash/)
  assert.equal(store.items.length, 2, 'the store keeps its two declared call items')
})

// ---------------------------------------------------------------------------
// Expansion, disclosure state and Ctrl+O

test('clicking the header expands every child card with its real Input/Output paint', () => {
  reset()
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"npm test"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'read', '{"path":"src/a.ts"}'),
    resultEvent(4, 'c2', Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n')),
  ])
  let renders = 0
  const anchors: boolean[] = []
  const view1 = view(store, {
    screen: 'fullscreen',
    onRenderRequest: () => { renders += 1 },
    onViewportAnchor: expanding => anchors.push(expanding),
  })
  const collapsed = plain(view1.render(70))
  const headerRow = view1.rowSpans[0]!.startRow + groupHeaderRow(collapsed)
  const anchorKey = toolGroupExpansionKey('c1')
  assert.equal(isToolExpanded(anchorKey), false)
  assert.deepEqual(
    linesOf(collapsed),
    [
      '● Multiple Tools: 2 done · Bash×1, Read×1 · click to show more',
      '├ ✓ Bash npm test',
      '└ ✓ Read src/a.ts',
    ],
    'the collapsed frame is the header plus one real row per call',
  )

  const result = view1.handleMouse(mouseAt('click', 6, headerRow))
  assert.deepEqual({ handled: result?.handled, render: result?.render }, { handled: true, render: true })
  assert.deepEqual(anchors, [true], 'the viewport anchor runs before the flip, expanding=true')
  assert.equal(renders, 1, 'a click asks the parent for a repaint')
  assert.equal(isToolExpanded(anchorKey), true)

  const opened = plain(view1.render(70))
  const openedLines = linesOf(opened)
  assert.equal(
    openedLines[0],
    '● Multiple Tools: 2 done · Bash×1, Read×1 · click to collapse',
    'the header keeps the counts and only swaps the affordance',
  )
  // The expanded frame is the two real child cards under the tree. Each child
  // keeps its own status marker (never duplicated, never dropped) and its own
  // Input/Output sections; the 2-column prefix is the only thing added.
  const required = [
    '├ ⏺ Bash npm test · click to collapse',
    '│   ├ Input',
    '│   │ command: npm test',
    '│   │',
    '│   └ Output',
    '│     ok',
    '└ ⏺ Read src/a.ts · click to collapse',
    '    ├ Input',
    '    │ path: src/a.ts',
    '    │',
    '    └ Output',
    '      line 0',
    '      line 9',
    '      … 20 more lines · click to show details',
  ]
  for (const line of required) {
    assert.ok(openedLines.includes(line), `missing expanded child row: ${JSON.stringify(line)}\n---\n${opened}`)
  }
  for (const line of openedLines) {
    assert.ok(visibleWidth(line) <= 70)
    assert.ok(!line.startsWith('├ ✓ ') && !line.startsWith('└ ✓ '), 'an expanded child shows its own status, not a second group glyph')
  }
  assert.equal(
    view1.rowSpans.filter(span => span.itemId === 'tool:c1').length,
    1,
    'the group is one root span anchored on the first call',
  )

  // Collapsing returns exactly the collapsed member rows.
  const openedHeaderRow = view1.rowSpans[0]!.startRow
  view1.handleMouse(mouseAt('click', 6, openedHeaderRow))
  assert.equal(isToolExpanded(anchorKey), false)
  assert.deepEqual(anchors, [true, false])
  const closed = plain(view1.render(70))
  assert.deepEqual(linesOf(closed), linesOf(collapsed))
})

test('Ctrl+O overrides every local override at once', () => {
  reset()
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'bash', '{"command":"two"}'),
    resultEvent(4, 'c2', 'ok'),
    callEvent(5, 'c3', 'read', '{"path":"a.ts"}'),
    resultEvent(6, 'c3', 'content'),
  ])
  const view1 = view(store, { groupTools: false })
  view1.render(70)
  // One card opened by hand, another closed by hand: both are local overrides.
  setToolExpanded(toolExpansionKey('c1'), true)
  setToolExpanded(toolExpansionKey('c2'), false)
  assert.equal(isToolExpanded(toolExpansionKey('c1')), true)

  view1.toggleToolsExpanded()
  assert.equal(view1.options.expandTools, true, 'the global default flipped')
  assert.equal(isToolExpanded(toolExpansionKey('c1')), false, 'local overrides are gone')
  assert.equal(isToolExpanded(toolExpansionKey('c2')), false)
  assert.match(plain(view1.render(70)), /ctrl\+o to collapse/)

  view1.toggleToolsExpanded()
  assert.equal(view1.options.expandTools, false)
  assert.match(plain(view1.render(70)), /ctrl\+o to expand/)
})

test('expandedDisclosureCount counts visible Thinking plus root tools/groups once each', () => {
  reset()
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'bash', '{"command":"two"}'),
    resultEvent(4, 'c2', 'ok'),
    assistantEvent(5, [{ type: 'reasoning', text: 'a thought about the build' }, { type: 'text', text: 'done' }], { time: 5_500 }),
  ])
  const view1 = view(store, { showThinking: true, thinkingPreviewLines: 0 })
  assert.equal(view1.expandedDisclosureCount, 0)

  // A member's own override is not a disclosure: the group owns it.
  setToolExpanded(toolExpansionKey('c2'), true)
  assert.equal(view1.expandedDisclosureCount, 0, 'a grouped child is never counted on its own')

  setToolExpanded(toolGroupExpansionKey('c1'), true)
  assert.equal(view1.expandedDisclosureCount, 1, 'the group counts once')

  // Reasoning keys are separate disclosures; the group does not change that.
  setThinkingExpanded(thinkingExpansionKey('assistant:5', 0), true)
  assert.equal(view1.expandedDisclosureCount, 2, 'Thinking + group coexist')

  // Hidden reasoning is not a visible disclosure.
  view1.options.showThinking = false
  assert.equal(view1.expandedDisclosureCount, 1)

  // Ungrouping re-exposes the member's own override (it was never dropped) next
  // to the still-open reasoning run; the group itself stops counting.
  view1.options.showThinking = true
  view1.options.groupTools = false
  assert.equal(view1.expandedDisclosureCount, 2, 'one card override + one reasoning run')

  // A removed item is not counted at all.
  store.reset(info([assistantEvent(5, [{ type: 'reasoning', text: 'a thought about the build' }])]))
  assert.equal(view1.expandedDisclosureCount, 1)
})

test('a group and a thinking run expand together without closing each other', () => {
  reset()
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'bash', '{"command":"two"}'),
    resultEvent(4, 'c2', 'ok'),
    assistantEvent(5, [{ type: 'reasoning', text: 'thinking body here' }, { type: 'text', text: 'answer' }]),
  ])
  const view1 = view(store, { showThinking: true, thinkingPreviewLines: 0 })
  const first = plain(view1.render(70))
  const groupRow = view1.rowSpans[0]!.startRow + groupHeaderRow(first)
  view1.handleMouse(mouseAt('click', 6, groupRow))
  assert.equal(isToolExpanded(toolGroupExpansionKey('c1')), true)
  assert.equal(store.items.length, 3, 'two calls and one assistant message')
  assert.ok(view1.rowSpans.some(span => span.itemId === 'assistant:5'), 'the trailing message is still its own root block')
})

// ---------------------------------------------------------------------------
// Mouse routing: native selection, precise child dispatch

test('the header is a small control that pins its press across a repaint', () => {
  reset()
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'bash', '{"command":"two"}'),
    resultEvent(4, 'c2', 'ok'),
  ])
  const view1 = view(store)
  const text = plain(view1.render(70))
  const headerRow = view1.rowSpans[0]!.startRow + groupHeaderRow(text)
  const press = view1.handleMouse(mouseAt('press', 4, headerRow))
  assert.equal(press?.handled, true, 'the header claims the press')
  const target = (press as { target?: { component?: { itemId?: string } } } | undefined)?.target
  assert.equal(target?.component?.itemId, 'tool:c1', 'the press target is the group block')

  // An ordinary repaint (streaming, hover, live timer) must not lose the press.
  view1.render(70)
  const click = view1.handleMouse(mouseAt('click', 4, headerRow))
  assert.equal(click?.handled, true)
  assert.equal(isToolExpanded(toolGroupExpansionKey('c1')), true, 'the pinned press still toggles its own row')
})

test('a collapsed member row is plain text: no detail entry, no toggle', () => {
  reset()
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'bash', '{"command":"two"}'),
    resultEvent(4, 'c2', 'ok'),
  ])
  const view1 = view(store)
  const text = plain(view1.render(70))
  const memberRow = view1.rowSpans[0]!.startRow + rowIndex(text, '├ ✓ Bash one')
  assert.ok(memberRow > 0, 'the member row is inside the group span')

  // A collapsed summary row advertises nothing: it is plain transcript text, so
  // every pointer event stays native (selection, drag, double click).
  for (const type of ['press', 'move', 'drag', 'click'] as const) {
    assert.equal(view1.handleMouse(mouseAt(type, 4, memberRow)), undefined, `${type} over a collapsed member row stays native`)
  }
  assert.equal(isToolExpanded(toolGroupExpansionKey('c1')), false, 'touching a member row never toggles the group')

  // Only the header is an entry point.
  view1.handleMouse(mouseAt('click', 4, view1.rowSpans[0]!.startRow))
  assert.equal(isToolExpanded(toolGroupExpansionKey('c1')), true)
})

test('an open group collapses from a body click while selection stays native', () => {
  reset()
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"npm test"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'bash', '{"command":"npm run build"}'),
    resultEvent(4, 'c2', 'ok'),
    callEvent(5, 'c3', 'read', '{"path":"src/a.ts"}'),
    resultEvent(6, 'c3', Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n')),
  ])
  const details: Array<{ callId: string; section: string }> = []
  const view1 = view(store, { onToolDetails: request => details.push(request) })
  view1.render(70)
  view1.handleMouse(mouseAt('click', 4, view1.rowSpans[0]!.startRow))
  assert.equal(isToolExpanded(toolGroupExpansionKey('c1')), true)

  const opened = plain(view1.render(70))
  const openedLines = linesOf(opened)
  const moreRow = view1.rowSpans[0]!.startRow + openedLines.findIndex(line => line.includes('… 20 more lines'))
  const bodyRow = view1.rowSpans[0]!.startRow + openedLines.findIndex(line => line === '│     ok')
  assert.ok(moreRow > 0 && bodyRow > 0, `expected the truncated read row\n${opened}`)

  // The child's own IO affordance stays clickable through the group: a grouped
  // child hitbox is not swallowed by the group's own regions.
  assert.equal(view1.handleMouse(mouseAt('click', 4, moreRow))?.handled, true)
  assert.deepEqual(details, [{ callId: 'c3', section: 'output' }], 'the child IO hitbox still forwards onToolDetails')
  assert.equal(isToolExpanded(toolGroupExpansionKey('c1')), true, 'opening the inspector does not close the group')

  // Press/move/drag over body text stay native (text selection and drag).
  for (const type of ['press', 'move', 'drag'] as const) {
    assert.equal(view1.handleMouse(mouseAt(type, 4, bodyRow)), undefined, `${type} over body text stays native`)
  }

  // A plain click on the child body collapses the whole group through its context.
  assert.equal(view1.handleMouse(mouseAt('click', 4, bodyRow))?.handled, true)
  assert.equal(isToolExpanded(toolGroupExpansionKey('c1')), false, 'body click collapses the group')
})

test('an expanded child receives the event in its own coordinates through the group', () => {
  reset()
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'read', '{"path":"src/a.ts"}'),
    resultEvent(4, 'c2', Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n')),
  ])
  const view1 = view(store, { expandTools: true })
  const text = plain(view1.render(70))
  const childRow = view1.rowSpans[0]!.startRow + rowIndex(text, '⏺ Read')
  const result = view1.handleMouse(mouseAt('click', 4, childRow))
  const target = (result as { target?: { component?: { itemId?: string } } } | undefined)?.target
  assert.equal(result?.handled, true)
  assert.equal(target?.component?.itemId, 'tool:c2', 'the row resolves to the real child card, not the group')
})

test('a group whose rows are clicked never swallows reasoning hitboxes elsewhere', () => {
  reset()
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'bash', '{"command":"two"}'),
    resultEvent(4, 'c2', 'ok'),
    assistantEvent(5, [{ type: 'reasoning', text: 'a thought' }, { type: 'text', text: 'answer' }]),
  ])
  const view1 = view(store, { showThinking: true, thinkingPreviewLines: 0 })
  const text = plain(view1.render(70))
  const thinkingRow = rowIndex(text, '✻ Thought')
  assert.ok(thinkingRow >= 0)
  view1.handleMouse(mouseAt('click', 3, thinkingRow))
  assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:5', 0)), true)
  assert.equal(isToolExpanded(toolGroupExpansionKey('c1')), false, 'the thinking click did not touch the group')
})

test('mouseBlocked makes the transcript inert while a modal overlay is open', () => {
  reset()
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'bash', '{"command":"two"}'),
    resultEvent(4, 'c2', 'ok'),
  ])
  const view1 = view(store, { mouseBlocked: true })
  const text = plain(view1.render(70))
  const headerRow = view1.rowSpans[0]!.startRow + groupHeaderRow(text)
  assert.equal(view1.handleMouse(mouseAt('press', 4, headerRow)), undefined)
  assert.equal(view1.handleMouse(mouseAt('click', 4, headerRow)), undefined)
  assert.equal(isToolExpanded(toolGroupExpansionKey('c1')), false)
  view1.options.mouseBlocked = false
  assert.equal(view1.handleMouse(mouseAt('click', 4, headerRow))?.handled, true)
})

// ---------------------------------------------------------------------------
// Cache/cleanup: member changes, session switch

test('the group block is reused while members join, update and leave', () => {
  reset()
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    callEvent(2, 'c2', 'bash', '{"command":"two"}'),
  ])
  const view1 = view(store)
  view1.render(70)
  const before = view1.cachedItemCount
  push(store, callEvent(3, 'c3', 'bash', '{"command":"three"}'))
  assert.match(plain(view1.render(70)), /three/)
  assert.match(plain(view1.render(70)), /1 running · 2 unknown/, 'statuses stay separate after a member joins')
  assert.equal(view1.cachedItemCount, before + 1, 'only one new child block; the group component is reused')
  assert.deepEqual(view1.rowSpans.map(span => span.itemId), ['tool:c1'], 'identity is the first call')

  // The first member disappears (a replayed snapshot without it): the group
  // re-anchors on the new first call and the old block is dropped.
  const replayed = view1
  store.reset(info([
    callEvent(3, 'c3', 'bash', '{"command":"three"}'),
    callEvent(4, 'c4', 'bash', '{"command":"four"}'),
  ]))
  const text = plain(replayed.render(70))
  assert.match(text, /three/)
  assert.match(text, /four/)
  assert.deepEqual(replayed.rowSpans.map(span => span.itemId), ['tool:c3'], 'the surviving group anchors on c3')
  assert.equal(replayed.cachedItemCount, 3, 'two child cards plus the group')
})

test('a session switch clears tool disclosures and drops the cache', () => {
  reset()
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'bash', '{"command":"two"}'),
    resultEvent(4, 'c2', 'ok'),
  ])
  const view1 = view(store)
  view1.render(70)
  setToolExpanded(toolGroupExpansionKey('c1'), true)
  assert.equal(view1.expandedDisclosureCount, 1)

  store.reset(info([], 's2'))
  view1.render(70)
  assert.equal(isToolExpanded(toolGroupExpansionKey('c1')), false, 'the previous session\'s disclosure is gone')
  assert.equal(view1.expandedDisclosureCount, 0)
  assert.equal(view1.cachedItemCount, 0)
})

test('a removed member leaves no stale disclosure key behind', () => {
  reset()
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'bash', '{"command":"two"}'),
    resultEvent(4, 'c2', 'ok'),
    callEvent(5, 'c3', 'read', '{"path":"a.ts"}'),
    resultEvent(6, 'c3', 'content'),
  ])
  const view1 = view(store, { groupTools: true })
  view1.render(70)
  setToolExpanded(toolExpansionKey('c3'), true)
  view1.render(70)
  assert.equal(isToolExpanded(toolExpansionKey('c3')), true, 'the key of a live tool is kept')

  store.reset(info([
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'bash', '{"command":"two"}'),
    resultEvent(4, 'c2', 'ok'),
  ]))
  view1.render(70)
  assert.equal(isToolExpanded(toolExpansionKey('c3')), false, 'a removed call drops its disclosure key')
})

// ---------------------------------------------------------------------------
// Width safety

test('group headers and rows never overflow a narrow terminal', () => {
  reset()
  const store = newStore([
    ev('tool/call', 1, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"npm run build --verbose"}' }, { time: 1_000 }),
    ev('tool/result', 2, {
      turn: 1,
      step: 1,
      message: { id: 'r2', role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false, source: { kind: 'tool', callId: 'c1' } },
    }, { surfaceOp: 'append', time: 62_000 }),
    ev('tool/call', 3, { turn: 1, step: 1, callId: 'c2', name: 'read', arguments: '{"path":"src/very/long/path/to/a/file.ts"}' }, { time: 0 }),
    ev('tool/result', 4, {
      turn: 1,
      step: 1,
      message: { id: 'r4', role: 'tool', toolCallId: 'c2', content: [{ type: 'text', text: 'a\nb' }], isError: false, source: { kind: 'tool', callId: 'c2' } },
    }, { surfaceOp: 'append', time: 1_000 }),
  ])
  for (const width of [12, 16, 20, 24, 32, 40, 60, 80, 120]) {
    for (const expandTools of [false, true]) {
      const view1 = view(store, { expandTools })
      for (const line of view1.render(width)) {
        assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(stripTerminalSequences(line))} is ${visibleWidth(line)}`)
      }
    }
  }
  // The duration survives a cramped row instead of being truncated away.
  const narrow = plain(view(store).render(24))
  assert.match(narrow, /1m 1s/)
})

// ---------------------------------------------------------------------------
// Status glyphs

test('every call row carries its own real status glyph, never a success claim', () => {
  reset()
  assert.match(toolStatusGlyph(toolItem('a', 'bash', 'done')), /✓/)
  assert.match(toolStatusGlyph(toolItem('a', 'bash', 'error')), /✗/)
  assert.match(toolStatusGlyph(toolItem('a', 'bash', 'running')), /◐/)
  assert.match(toolStatusGlyph(toolItem('a', 'bash', 'proposed')), /○/)
  assert.match(toolStatusGlyph(toolItem('a', 'bash', 'unknown')), /◌/)
  // `done` is "a result arrived without a failure marker", not "exit code 0".
  assert.doesNotMatch(toolStatusGlyph(toolItem('a', 'bash', 'done')), /0|exit/)

  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"npm test"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'bash', '{"command":"npm run build"}'),
    resultEvent(4, 'c2', 'boom', {}, true),
  ])
  const rows = linesOf(plain(view(store).render(70))).filter(line => line.startsWith('├ ') || line.startsWith('└ '))
  assert.deepEqual(rows, ['├ ✓ Bash npm test', '└ ✗ Bash npm run build'])
  const header = plain(view(store).render(70)).split('\n')[0] ?? ''
  assert.match(header, /^● Bash: 1 done · 1 failed · ctrl\+o to expand$/, `header counts stay separate: ${header}`)
})

// ---------------------------------------------------------------------------
// Mouse single-expand (source-project policy)

test('expanding one root tool closes the other root tools and leaves Thinking alone', () => {
  reset()
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'read', '{"path":"a.ts"}'),
    resultEvent(4, 'c2', 'content'),
    assistantEvent(5, [{ type: 'reasoning', text: 'a thought body' }, { type: 'text', text: 'answer' }]),
  ])
  const view1 = view(store, { groupTools: false, showThinking: true, thinkingPreviewLines: 0 })
  const text = plain(view1.render(70))
  const c1Row = view1.rowSpans.find(span => span.itemId === 'tool:c1')!.startRow
  const c2Row = view1.rowSpans.find(span => span.itemId === 'tool:c2')!.startRow
  const thinkingRow = rowIndex(text, '✻ Thought')

  view1.handleMouse(mouseAt('click', 4, c1Row))
  assert.equal(isToolExpanded(toolExpansionKey('c1')), true)
  view1.handleMouse(mouseAt('click', 4, thinkingRow))
  assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:5', 0)), true, 'a reasoning run opens independently')

  view1.handleMouse(mouseAt('click', 4, c2Row))
  assert.equal(isToolExpanded(toolExpansionKey('c2')), true)
  assert.equal(isToolExpanded(toolExpansionKey('c1')), false, 'opening one card closed the other root card')
  assert.equal(
    isThinkingExpanded(thinkingExpansionKey('assistant:5', 0)),
    true,
    'single-expand never touches reasoning disclosures',
  )
})

test('single-expand closes the other root group but not member keys or deleted ids', () => {
  reset()
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'bash', '{"command":"two"}'),
    resultEvent(4, 'c2', 'ok'),
    assistantEvent(5, [{ type: 'text', text: 'a boundary between the runs' }]),
    callEvent(6, 'c3', 'read', '{"path":"a.ts"}'),
    resultEvent(7, 'c3', 'content'),
  ])
  const view1 = view(store)
  view1.render(70)
  assert.deepEqual(
    view1.rowSpans.map(span => span.itemId),
    ['tool:c1', 'assistant:5', 'tool:c3'],
    'one root group plus one root card',
  )

  // Open the group and a member override that is NOT a root disclosure.
  view1.handleMouse(mouseAt('click', 4, view1.rowSpans[0]!.startRow))
  assert.equal(isToolExpanded(toolGroupExpansionKey('c1')), true)
  setToolExpanded(toolExpansionKey('c2'), true)
  setToolExpanded(toolExpansionKey('ghost'), true)

  // Expanding another root disclosure closes the group but keeps the member
  // override and the id that is not part of the projection untouched.
  const cardRow = view1.rowSpans.find(span => span.itemId === 'tool:c3')!.startRow
  view1.handleMouse(mouseAt('click', 4, cardRow))
  assert.equal(isToolExpanded(toolExpansionKey('c3')), true)
  assert.equal(isToolExpanded(toolGroupExpansionKey('c1')), false, 'the other root group is closed')
  assert.equal(isToolExpanded(toolExpansionKey('c2')), true, 'a group member is not a root disclosure')
  assert.equal(isToolExpanded(toolExpansionKey('ghost')), true, 'ids outside the projection are never "handled"')
})

// ---------------------------------------------------------------------------
// Display preferences and ordinary repaints

test('changing a Tools display preference repaints an already-expanded group', () => {
  reset()
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"npm test"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'read', '{"path":"src/a.ts"}'),
    resultEvent(4, 'c2', Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n')),
  ])
  const view1 = view(store, { expandedOutputMaxLines: 10, hints: { expand: 'ctrl+o', toolsDetails: 'ctrl+x ctrl+o' } })
  view1.render(70)
  view1.handleMouse(mouseAt('click', 4, view1.rowSpans[0]!.startRow))
  assert.equal(isToolExpanded(toolGroupExpansionKey('c1')), true)
  const narrowPreview = plain(view1.render(70))
  assert.match(narrowPreview, /… 20 more lines · ctrl\+x ctrl\+o to inspect tools/)
  assert.doesNotMatch(narrowPreview, /line 29/)

  // A Settings change lands immediately: no stale composed frame.
  view1.options.expandedOutputMaxLines = 40
  const full = plain(view1.render(70))
  assert.match(full, /line 29/)
  assert.doesNotMatch(full, /20 more lines/)

  // Label clip and hint labels are part of the collapsed frame too.
  view1.toggleToolsExpanded()
  view1.toggleToolsExpanded()
  view1.options.toolLabelClip = 8
  const clipped = plain(view1.render(70))
  const clippedRow = clipped.split('\n').find(line => line.startsWith('├ ✓ ')) ?? ''
  assert.match(clippedRow, /^├ ✓ Bash np…$/, `the clip preference reaches the collapsed row: ${clippedRow}`)

  view1.options.toolLabelClip = 0
  view1.options.hints = { expand: 'ctrl+y' }
  assert.match(plain(view1.render(70)), /ctrl\+y to expand/, 'a remapped key is shown without a stale one')
})

test('an ordinary invalidate keeps the pressed header pinned', () => {
  reset()
  const store = newStore([
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'bash', '{"command":"two"}'),
    resultEvent(4, 'c2', 'ok'),
  ])
  const view1 = view(store)
  const rendered = plain(view1.render(70))
  const headerRow = view1.rowSpans[0]!.startRow + groupHeaderRow(rendered)
  assert.ok(headerRow >= 0, 'the header row is inside the group span')
  assert.equal(view1.handleMouse(mouseAt('press', 4, headerRow))?.handled, true)
  // invalidate() only drops cached lines: it must not clear the pin.
  view1.invalidate()
  view1.render(70)
  assert.equal(view1.handleMouse(mouseAt('click', 4, headerRow))?.handled, true)
  assert.equal(isToolExpanded(toolGroupExpansionKey('c1')), true)
})

// ---------------------------------------------------------------------------
// Cleanup ownership: the old group must not steal the new group's children

test('a group that loses its anchor releases no context the new group already owns', () => {
  reset()
  const three = [
    callEvent(1, 'c1', 'bash', '{"command":"npm test"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'bash', '{"command":"npm run build"}'),
    resultEvent(4, 'c2', 'ok'),
    callEvent(5, 'c3', 'read', '{"path":"src/a.ts"}'),
    resultEvent(6, 'c3', Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n')),
  ]
  const store = newStore(three)
  const view1 = view(store)
  view1.render(70)
  view1.handleMouse(mouseAt('click', 4, view1.rowSpans[0]!.startRow))
  assert.equal(isToolExpanded(toolGroupExpansionKey('c1')), true)

  // The first call disappears (a replayed snapshot): the group re-anchors on c2.
  // The old group's cleanup must not reset the contexts c2/c3 now use.
  store.reset(info(three.slice(2)))
  const reanchored = plain(view1.render(70))
  assert.deepEqual(view1.rowSpans.map(span => span.itemId), ['tool:c2'], 'the surviving group anchors on c2')
  assert.match(reanchored, /^├ ✓ Bash npm run build/m, `c2 is still a member row\n${reanchored}`)

  // Open the new group: the children must render through their group context
  // (Input/Output sections), which is only true while the context is attached.
  view1.handleMouse(mouseAt('click', 4, view1.rowSpans[0]!.startRow))
  assert.equal(isToolExpanded(toolGroupExpansionKey('c2')), true)
  const opened = plain(view1.render(70))
  assert.match(opened, /^├ ⏺ Bash npm run build/m, `the c2 child card is expanded through its group context\n${opened}`)
  assert.match(opened, /^│ {3}├ Input$/m)
  assert.match(opened, /^│ {3}│ command: npm run build$/m)
  assert.match(opened, /^│ {3}└ Output$/m)
  assert.match(opened, /^└ ⏺ Read src\/a\.ts/m)

  // …and the child still delegates a body click to the group.
  const bodyRow = view1.rowSpans[0]!.startRow + linesOf(opened).findIndex(line => line.startsWith('│     ok'))
  assert.equal(view1.handleMouse(mouseAt('click', 4, bodyRow))?.handled, true)
  assert.equal(isToolExpanded(toolGroupExpansionKey('c2')), false, 'the surviving group is still fully wired')
})

test('merged groups, ungrouped members and disabled grouping all release cleanly', () => {
  reset()
  const split = [
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'bash', '{"command":"two"}'),
    resultEvent(4, 'c2', 'ok'),
    assistantEvent(5, [{ type: 'text', text: 'between the runs' }]),
    callEvent(6, 'c3', 'bash', '{"command":"three"}'),
    resultEvent(7, 'c3', 'ok'),
    callEvent(8, 'c4', 'bash', '{"command":"four"}'),
    resultEvent(9, 'c4', 'ok'),
  ]
  const store = newStore(split)
  const view1 = view(store)
  view1.render(70)
  assert.deepEqual(view1.rowSpans.map(span => span.itemId), ['tool:c1', 'assistant:5', 'tool:c3'], 'two groups around a message')
  view1.handleMouse(mouseAt('click', 4, view1.rowSpans[0]!.startRow))
  view1.handleMouse(mouseAt('click', 4, view1.rowSpans[2]!.startRow))
  assert.equal(isToolExpanded(toolGroupExpansionKey('c1')), false, 'single-expand closed the first group')

  // The message disappears: the two groups merge into one anchored on c1. The
  // evicted second group must not clear the contexts the merged group owns.
  store.reset(info([...split.slice(0, 4), ...split.slice(5)]))
  const merged = plain(view1.render(70))
  assert.deepEqual(view1.rowSpans.map(span => span.itemId), ['tool:c1'], 'one merged group')
  assert.doesNotMatch(merged, /between the runs/)
  assert.match(merged, /^├ ✓ Bash one$/m)
  assert.match(merged, /^└ ✓ Bash four$/m)

  view1.handleMouse(mouseAt('click', 4, view1.rowSpans[0]!.startRow))
  assert.equal(isToolExpanded(toolGroupExpansionKey('c1')), true)
  const opened = plain(view1.render(70))
  assert.match(opened, /^├ ⏺ Bash one/m)
  assert.match(opened, /^└ ⏺ Bash four/m, `every merged child renders its own card\n${opened}`)

  // Turning grouping off returns to single cards that own their own disclosure.
  view1.options.groupTools = false
  const singles = plain(view1.render(70))
  assert.doesNotMatch(singles, /● Bash:/)
  assert.equal(view1.rowSpans.length, 4, 'one span per call')
  assert.equal(isToolExpanded(toolExpansionKey('c4')), false, 'a card leaves the group without inheriting its state')
  assert.equal(
    isToolExpanded(toolGroupExpansionKey('c1')),
    false,
    'the group disclosure key is dropped with the row that owned it (no unreachable override is kept)',
  )
  assert.equal(isToolExpanded(toolExpansionKey('c1')), false, 'the member cards do not inherit the group state either')
  const lastRow = view1.rowSpans.find(span => span.itemId === 'tool:c4')!.startRow
  view1.handleMouse(mouseAt('click', 4, lastRow))
  assert.equal(isToolExpanded(toolExpansionKey('c4')), true, 'the standalone card owns its own toggle again')
  assert.equal(isToolExpanded(toolExpansionKey('c1')), false, 'mouse single-expand leaves only the clicked card open')
})

test('a press held on a removed group stays inert and never breaks the new frame', () => {
  reset()
  const three = [
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'bash', '{"command":"two"}'),
    resultEvent(4, 'c2', 'ok'),
    callEvent(5, 'c3', 'bash', '{"command":"three"}'),
    resultEvent(6, 'c3', 'ok'),
  ]
  const store = newStore(three)
  const view1 = view(store)
  const headerRow = groupHeaderRow(plain(view1.render(70)))
  const press = view1.handleMouse(mouseAt('press', 4, headerRow))
  const held = (press as { target?: { component?: ItemBlock & { handleMouse?: (event: TuiMouseEvent) => unknown } } }).target?.component
  assert.ok(held !== undefined, 'the press target is the group block')

  // The group disappears (only one call left → a plain card).
  store.reset(info(three.slice(0, 2)))
  view1.render(70)
  assert.deepEqual(view1.rowSpans.map(span => span.itemId), ['tool:c1'], 'a single call renders as a card')

  // The renderer still addresses the pressed group for release/click: it must be
  // inert and must not toggle anything.
  const stale = held.handleMouse?.(mouseAt('click', 4, 0))
  assert.equal(stale, undefined, 'a removed group handles no pointer event')
  assert.equal(isToolExpanded(toolGroupExpansionKey('c1')), false)

  // The frame that replaced it keeps working.
  const cardRow = view1.rowSpans[0]!.startRow
  assert.equal(view1.handleMouse(mouseAt('click', 4, cardRow))?.handled, true)
  assert.equal(isToolExpanded(toolExpansionKey('c1')), true)
})

// ---------------------------------------------------------------------------
// dispose()

test('dispose stops the live timer, releases children and goes inert', () => {
  reset()
  const clock = { value: 1_000_000 }
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC, now: () => clock.value })
  store.reset(info([
    callEvent(1, 'c1', 'bash', '{"command":"one"}'),
    resultEvent(2, 'c1', 'ok'),
    callEvent(3, 'c2', 'bash', '{"command":"two"}'),
    resultEvent(4, 'c2', 'ok'),
  ]))
  let renders = 0
  const view1 = view(store, {
    thinkingLiveTimerMs: 250,
    now: () => clock.value,
    onRenderRequest: () => { renders += 1 },
  })
  view1.render(70)
  view1.handleMouse(mouseAt('click', 4, view1.rowSpans[0]!.startRow))
  // A live reasoning run arms the single display timer.
  store.handle({ type: 'stream_start', sessionId: 's1', attemptId: 'att', revision: 1, turn: 2, step: 1 } as never)
  store.handle({ type: 'stream_chunk', sessionId: 's1', attemptId: 'att', revision: 2, index: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' } } as never)
  view1.render(70)
  assert.equal(view1.liveTimerRunning, true)
  const itemsBefore = store.items.length

  view1.dispose()
  assert.equal(view1.isDisposed, true)
  assert.equal(view1.liveTimerRunning, false, 'the display timer is stopped')
  assert.equal(view1.cachedItemCount, 0, 'no block is retained')
  assert.deepEqual(view1.rowSpans, [])
  assert.equal(store.items.length, itemsBefore, 'dispose never mutates the transcript store')

  const rendersAtDispose = renders
  assert.deepEqual(view1.render(70), [], 'a disposed view renders nothing')
  assert.equal(view1.handleMouse(mouseAt('click', 4, 0)), undefined, 'a disposed view owns no pointer target')
  assert.equal(view1.handleMouse(mouseAt('press', 4, 0)), undefined)
  assert.equal(renders, rendersAtDispose, 'dispose never asks for another repaint')
  // Idempotent.
  view1.dispose()
  assert.equal(view1.isDisposed, true)
  assert.equal(view1.cachedItemCount, 0)
})

// ---------------------------------------------------------------------------
// Group component unit tests (stub children keep the contract observable)

interface StubState {
  contexts: Array<{ key: string; expanded: boolean } | undefined>
  events: TuiMouseEvent[]
  renders: number
}

function stubBlock(item: ToolTranscriptItem, lines: readonly string[], state: StubState): ItemBlock {
  return {
    itemId: item.id,
    kind: 'tool',
    version: item.version,
    update(): void {},
    invalidate(): void {},
    clearMouse(): void {},
    setToolGroupContext(context): void {
      state.contexts.push(context === undefined ? undefined : { key: context.key, expanded: context.isExpanded() })
    },
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

function groupFlags(overrides: Partial<TranscriptViewOptions> = {}): TranscriptViewOptions {
  return {
    showThinking: false,
    expandTools: false,
    groupTools: true,
    hints: { expand: 'ctrl+o' },
    screen: 'fullscreen',
    toolLabelClip: 0,
    ...overrides,
  }
}

test('the group hands its children a shared disclosure context and takes it back', () => {
  reset()
  const first = toolItem('a', 'bash', 'done')
  const second = toolItem('b', 'bash', 'done')
  const firstState: StubState = { contexts: [], events: [], renders: 0 }
  const secondState: StubState = { contexts: [], events: [], renders: 0 }
  const firstBlock = stubBlock(first, ['first'], firstState)
  const secondBlock = stubBlock(second, ['second'], secondState)
  const group = new ToolGroupBlock(first, groupFlags())

  const members = (): ToolGroupMember[] => [
    { item: first, block: firstBlock },
    { item: second, block: secondBlock },
  ]
  group.setMembers(members())
  assert.deepEqual(firstState.contexts.at(-1), { key: group.key, expanded: false })
  assert.equal(group.key, toolGroupExpansionKey('a'))
  assert.equal(group.memberCount, 2)

  // Expansion is the group's, not the children's: nobody writes a per-card key.
  group.toggle()
  assert.equal(isToolExpanded(group.key), true)
  assert.equal(isToolExpanded(toolExpansionKey('a')), false)
  group.setMembers(members())
  assert.deepEqual(firstState.contexts.at(-1), { key: group.key, expanded: true }, 'the context reports the live state')

  // A member that leaves owns its disclosure again.
  group.setMembers([{ item: second, block: secondBlock }])
  assert.equal(firstState.contexts.at(-1), undefined, 'ungrouping removes the context')

  group.clearMouse()
  assert.equal(secondState.contexts.at(-1), undefined, 'clearMouse drops the surviving child context too')
  assert.equal(isToolExpanded(group.key), true, 'ordinary cleanup does not flip the disclosure')
})

test('expanded child rows are prefixed, never filtered, so row mapping stays exact', () => {
  reset()
  const first = toolItem('a', 'bash', 'done')
  const second = toolItem('b', 'read', 'done')
  const firstBlock = stubBlock(first, ['first top', 'first body'], { contexts: [], events: [], renders: 0 })
  const secondBlock = stubBlock(second, ['', 'second body'], { contexts: [], events: [], renders: 0 })
  const group = new ToolGroupBlock(first, groupFlags({ expandTools: true }))
  group.setMembers([{ item: first, block: firstBlock }, { item: second, block: secondBlock }])
  const lines = group.render(40).map(line => stripTerminalSequences(line))
  assert.equal(lines.length, 5, 'header + 2 + 2 rows: a blank child row still occupies its row')
  assert.equal(lines[0]?.startsWith('● ') || lines[0]?.startsWith('◌ '), true)
  assert.equal(lines[1], '├ first top')
  assert.equal(lines[2], '│ first body')
  assert.equal(lines[3], '└ ', 'the child’s own blank row is preserved')
  assert.equal(lines[4], '  second body')
  assert.deepEqual(group.rowSpans.map(span => [span.startRow, span.endRow, span.xOffset]), [[1, 2, 2], [3, 4, 2]])

  // A child row dispatches into the child with re-based coordinates.
  const result = group.handleMouse(mouseAt('click', 5, 2))
  assert.equal(result?.handled, true)
  const target = (result as { target?: { component?: { itemId?: string }; originX?: number; originY?: number } }).target
  assert.equal(target?.component?.itemId, 'tool:a')
  assert.equal(target?.originX, 2, 'the child origin accounts for the tree prefix')
  assert.equal(target?.originY, 1)
})

test('header hover brightens the hint and only a real transition repaints', () => {
  reset()
  let renders = 0
  const item = toolItem('a', 'bash', 'done')
  const block = stubBlock(item, ['body'], { contexts: [], events: [], renders: 0 })
  const group = new ToolGroupBlock(item, groupFlags({ onRenderRequest: () => { renders += 1 } }))
  group.setMembers([{ item, block }, { item: toolItem('b', 'bash', 'done'), block: stubBlock(toolItem('b', 'bash', 'done'), ['b'], { contexts: [], events: [], renders: 0 }) }])
  const resting = group.render(60)[0]!
  group.handleMouse(mouseAt('move', 8, 0))
  assert.equal(renders, 1)
  const hovered = group.render(60)[0]!
  assert.notEqual(resting, hovered)
  group.handleMouse(mouseAt('move', 9, 0))
  assert.equal(renders, 1, 'staying on the header is not a transition')
  group.handleMouse(mouseAt('move', 8, 3))
  assert.equal(renders, 2, 'leaving the header repaints once')
})

test('the group keeps its composed frame until a member or a preference changes', () => {
  reset()
  const first = toolItem('a', 'bash', 'done')
  const second = toolItem('b', 'bash', 'done')
  const flags = groupFlags()
  const group = new ToolGroupBlock(first, flags)
  const members: ToolGroupMember[] = [
    { item: first, block: stubBlock(first, ['a'], { contexts: [], events: [], renders: 0 }) },
    { item: second, block: stubBlock(second, ['b'], { contexts: [], events: [], renders: 0 }) },
  ]
  group.setMembers(members)
  group.render(60)
  const key = group.frameCacheKey
  assert.ok(key !== undefined)

  // Same members, same versions: the composed frame is kept (a group must not
  // paper over a missing preference by clearing itself every frame).
  group.setMembers([
    { item: first, block: members[0]!.block },
    { item: second, block: members[1]!.block },
  ])
  assert.equal(group.frameCacheKey, key, 'an unchanged member list keeps the frame')

  // A new item version invalidates it.
  group.setMembers([
    { item: { ...first, version: 2 }, block: members[0]!.block },
    { item: second, block: members[1]!.block },
  ])
  assert.equal(group.frameCacheKey, undefined, 'a member update drops the frame')

  // Every Tools display preference is part of the key, so a Settings change
  // cannot leave an already-expanded group on stale content. Each case starts
  // from a fresh flags object so the changes do not accumulate.
  const mutations: Array<[string, (next: TranscriptViewOptions) => void]> = [
    ['groupTools', next => { next.groupTools = false }],
    ['expandTools', next => { next.expandTools = !next.expandTools }],
    ['expandedInputMaxLines', next => { next.expandedInputMaxLines = 20 }],
    ['expandedOutputMaxLines', next => { next.expandedOutputMaxLines = 80 }],
    ['toolLabelClip', next => { next.toolLabelClip = 40 }],
    ['diffViewMode', next => { next.diffViewMode = 'split' }],
    ['diffIndicatorMode', next => { next.diffIndicatorMode = 'none' }],
    ['diffSplitMinWidth', next => { next.diffSplitMinWidth = 160 }],
    ['editDiffCollapsedLines', next => { next.editDiffCollapsedLines = 48 }],
    ['writeDiffCollapsedLines', next => { next.writeDiffCollapsedLines = 8 }],
    ['diffWordWrap', next => { next.diffWordWrap = false }],
    ['hints.expand', next => { next.hints = { ...next.hints, expand: 'ctrl+y' } }],
    ['hints.toolsDetails', next => { next.hints = { ...next.hints, toolsDetails: 'ctrl+x ctrl+o' } }],
    ['onToolDetails', next => { next.onToolDetails = () => {} }],
    ['screen', next => { next.screen = 'inline' }],
  ]
  for (const [name, mutate] of mutations) {
    const fresh = groupFlags({ expandTools: true, screen: 'fullscreen', groupTools: true, toolLabelClip: 0 })
    const membersFor = (): ToolGroupMember[] => [
      { item: first, block: stubBlock(first, ['a'], { contexts: [], events: [], renders: 0 }) },
      { item: second, block: stubBlock(second, ['b'], { contexts: [], events: [], renders: 0 }) },
    ]
    const entry = new ToolGroupBlock(first, fresh)
    entry.setMembers(membersFor())
    entry.render(60)
    const before = entry.frameCacheKey
    // The preference must be part of the composed key: a group built with the
    // changed preference composes a different key for the identical member list,
    // so a frame can never be reused across a Settings change.
    mutate(fresh)
    const changed = new ToolGroupBlock(first, fresh)
    changed.setMembers(membersFor())
    changed.render(60)
    assert.notEqual(changed.frameCacheKey, before, `${name} must invalidate the composed frame`)
    // The live instance repaints through the owner's invalidation (the view
    // detects the option change), it never keeps the cached frame.
    entry.invalidate()
    entry.render(60)
    assert.equal(entry.frameCacheKey, changed.frameCacheKey, `${name}: the repaint uses the new preference`)
    entry.dispose()
    changed.dispose()
  }

  // A cwd change and header hover are part of the key too.
  const cwdGroup = new ToolGroupBlock(first, flags)
  cwdGroup.setMembers([{ item: first, block: stubBlock(first, ['a'], { contexts: [], events: [], renders: 0 }) }, { item: second, block: stubBlock(second, ['b'], { contexts: [], events: [], renders: 0 }) }])
  cwdGroup.render(60)
  const cwdKey = cwdGroup.frameCacheKey
  cwdGroup.setCwd('/tmp/other')
  cwdGroup.render(60)
  assert.notEqual(cwdGroup.frameCacheKey, cwdKey, 'cwd is part of the key')
  const hoverKey = cwdGroup.frameCacheKey
  cwdGroup.handleMouse(mouseAt('move', 6, 0))
  cwdGroup.render(60)
  assert.notEqual(cwdGroup.frameCacheKey, hoverKey, 'header hover is part of the key')
})

test('an open group collapses from its own click-only body region', () => {
  reset()
  const first = toolItem('a', 'bash', 'done')
  const second = toolItem('b', 'bash', 'done')
  // Children that handle nothing: the event must fall through to the group's own
  // body region instead of being lost.
  const inert: ItemBlock = {
    itemId: first.id,
    kind: 'tool',
    version: 1,
    update(): void {},
    invalidate(): void {},
    clearMouse(): void {},
    render(): string[] { return ['inert child row'] },
  }
  const inertSecond: ItemBlock = { ...inert, itemId: second.id }
  const group = new ToolGroupBlock(first, groupFlags({ expandTools: true, onRenderRequest: () => {} }))
  group.setMembers([{ item: first, block: inert }, { item: second, block: inertSecond }])
  group.render(60)
  assert.equal(group.hitboxes.length, 2, 'header + open body')
  assert.equal(group.hitboxes[1]!.claimPress, false, 'the body region is click-only so selection stays native')
  assert.equal(group.hitboxes[1]!.startRow, 1)
  assert.equal(group.hitboxes[1]!.endRow, 2)

  for (const type of ['press', 'move', 'drag'] as const) {
    assert.equal(group.handleMouse(mouseAt(type, 4, 2)), undefined, `${type} over the open body stays native`)
  }
  assert.equal(group.expanded, true)
  assert.equal(group.handleMouse(mouseAt('click', 4, 2))?.handled, true)
  assert.equal(isToolExpanded(group.key), false, 'a plain body click collapses the open group')

  // Collapsed: only the header is a region; member rows are plain text.
  group.render(60)
  assert.equal(group.hitboxes.length, 1)
  for (const type of ['press', 'move', 'drag', 'click'] as const) {
    assert.equal(group.handleMouse(mouseAt(type, 4, 1)), undefined, `${type} over a collapsed member row stays native`)
  }
})

test('group dispose releases every child context and is inert afterwards', () => {
  reset()
  const first = toolItem('a', 'bash', 'done')
  const second = toolItem('b', 'bash', 'done')
  const firstState: StubState = { contexts: [], events: [], renders: 0 }
  const secondState: StubState = { contexts: [], events: [], renders: 0 }
  let renders = 0
  const group = new ToolGroupBlock(first, groupFlags({ expandTools: true, onRenderRequest: () => { renders += 1 } }))
  group.setMembers([
    { item: first, block: stubBlock(first, ['a'], firstState) },
    { item: second, block: stubBlock(second, ['b'], secondState) },
  ])
  group.render(60)
  const rendersBefore = renders

  assert.equal(group.expanded, true, 'the group is open through the global default')
  group.dispose()
  assert.equal(group.isDisposed, true)
  assert.equal(firstState.contexts.at(-1), undefined, 'the child context is released')
  assert.equal(secondState.contexts.at(-1), undefined)
  assert.equal(group.frameCacheKey, undefined)
  assert.deepEqual(group.render(60), [], 'a disposed group renders nothing')
  assert.equal(group.handleMouse(mouseAt('click', 4, 0)), undefined, 'a disposed group owns no pointer target')
  assert.equal(renders, rendersBefore, 'dispose asks for no repaint')

  // Idempotent, and it never flips the disclosure state.
  const contextsAfter = firstState.contexts.length
  group.dispose()
  assert.equal(firstState.contexts.length, contextsAfter)
  assert.equal(group.expanded, true, 'teardown never flips a disclosure')
})

test('a card moving between groups keeps the context of its new owner', () => {
  reset()
  const a = toolItem('a', 'bash', 'done')
  const b = toolItem('b', 'bash', 'done')
  const c = toolItem('c', 'bash', 'done')
  const state: StubState = { contexts: [], events: [], renders: 0 }
  const shared = stubBlock(c, ['c body'], state)
  const groupA = new ToolGroupBlock(a, groupFlags())
  const groupB = new ToolGroupBlock(b, groupFlags())

  // The card belongs to A, then a re-projection hands it to B and A drops it.
  groupA.setMembers([{ item: a, block: stubBlock(a, ['a'], { contexts: [], events: [], renders: 0 }) }, { item: c, block: shared }])
  assert.deepEqual(state.contexts.at(-1), { key: groupA.key, expanded: false })
  groupB.setMembers([{ item: b, block: stubBlock(b, ['b'], { contexts: [], events: [], renders: 0 }) }, { item: c, block: shared }])
  assert.deepEqual(state.contexts.at(-1), { key: groupB.key, expanded: false }, 'B now owns the card')
  groupA.setMembers([{ item: a, block: stubBlock(a, ['a'], { contexts: [], events: [], renders: 0 }) }])
  assert.deepEqual(
    state.contexts.at(-1),
    { key: groupB.key, expanded: false },
    'A must not release a context B already owns',
  )

  // The reverse order (B drops it before A re-claims it) releases exactly once,
  // and the re-claim wins.
  groupB.clearMouse()
  assert.equal(state.contexts.at(-1), undefined, 'the owner releases on teardown')
  groupA.setMembers([{ item: a, block: stubBlock(a, ['a'], { contexts: [], events: [], renders: 0 }) }, { item: c, block: shared }])
  assert.deepEqual(state.contexts.at(-1), { key: groupA.key, expanded: false })
  // A disposed group releases; a non-owner never does.
  groupB.dispose()
  assert.deepEqual(state.contexts.at(-1), { key: groupA.key, expanded: false }, 'disposing a non-owner releases nothing')
  groupA.dispose()
  assert.equal(state.contexts.at(-1), undefined)
})

// ---------------------------------------------------------------------------
// Keymap-derived hints

test('transcriptHints exports the real tools-details binding', () => {
  const hints = transcriptHints(createCcKeymap())
  assert.equal(hints.expand, 'ctrl+o', 'app.tools.expand keeps its CC binding')
  assert.equal(hints.toolsDetails, 'ctrl+x ctrl+o', 'the details chord comes from the real keymap')
  assert.equal(hints.thinking, undefined, 'Ctrl+T stays the todo panel, so no thinking key is advertised')

  const remapped = transcriptHints(createCcKeymap({ bindings: { 'app.tools.expand': ['ctrl+y'] } }))
  assert.equal(remapped.expand, 'ctrl+y')
  const disabled = transcriptHints(createCcKeymap({ bindings: { 'app.tools.expand': [] } }))
  assert.equal(disabled.expand, undefined, 'a disabled action advertises no key')
})