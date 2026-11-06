// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { BackendEvent, SessionEvent, SessionInfo } from '../src/backend/types.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import { clearThinkingExpansion as clearFromView, TranscriptView } from '../src/ui/transcript.ts'
import {
  formatThinkingDuration,
  ThinkingBlock,
  clearThinkingExpansion,
  isThinkingExpanded,
  setThinkingExpanded,
  thinkingExpandedCount,
  thinkingExpansionKey,
} from '../src/ui/thinking-block.ts'
import { t } from '../src/ui/theme.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'

// ---------------------------------------------------------------------------
// Fixtures

const info = (events: SessionEvent[] = []): SessionInfo => ({
  sessionId: 's1',
  cwd: '/tmp/work',
  provider: 'demo',
  model: 'demo',
  capabilities: [],
  events,
})

const ev = (type: string, seq: number, data: unknown, extra: Partial<SessionEvent> = {}): SessionEvent => ({
  type,
  seq,
  time: 0,
  data,
  ...extra,
})

const assistantEvent = (seq: number, thinking: string, text: string, time = 0): SessionEvent => ev('assistant/message', seq, {
  turn: 1,
  step: 1,
  message: {
    id: `a${seq}`,
    role: 'assistant',
    content: [
      ...(thinking === '' ? [] : [{ type: 'reasoning', text: thinking }]),
      { type: 'text', text },
    ],
    source: { kind: 'model', provider: 'demo', model: 'demo' },
  },
  stream: [],
}, { surfaceOp: 'append', time })

/** Deterministic store clock so a live run's elapsed time is reproducible. */
function newStore(options: { events?: SessionEvent[]; clock?: { value: number } } = {}): TranscriptStore {
  const clock = options.clock ?? { value: 1_000_000 }
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC, now: () => clock.value })
  store.reset(info(options.events ?? []))
  return store
}

const plain = (lines: string[]): string => stripTerminalSequences(lines.join('\n'))

const THOUGHT = [
  'I read the failing test first and note the wrap helper is not ANSI aware.',
  'Then the tokenizer shows CJK width handled by the vendored utilities.',
  'Finally the collapsed summary must count real wrap lines, not newlines.',
].join(' ')

const words = (count: number): string => Array.from({ length: count }, (_, index) => `word${index + 1}`).join(' ')

function assertWidths(view: TranscriptView, widths: readonly number[]): void {
  for (const width of widths) {
    for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`)
  }
}

// ---------------------------------------------------------------------------
// Duration formatting

test('thinking durations format as ms, seconds and minutes without inventing data', () => {
  assert.equal(formatThinkingDuration(undefined), '', 'no measurement prints nothing at all')
  assert.equal(formatThinkingDuration(Number.NaN), '')
  assert.equal(formatThinkingDuration(Number.POSITIVE_INFINITY), '')
  // <1s keeps millisecond resolution.
  assert.equal(formatThinkingDuration(0), '0ms')
  assert.equal(formatThinkingDuration(1), '1ms')
  assert.equal(formatThinkingDuration(450), '450ms')
  assert.equal(formatThinkingDuration(999), '999ms')
  // <60s is whole seconds (rounded, never truncated to a smaller claim).
  assert.equal(formatThinkingDuration(1000), '1s')
  assert.equal(formatThinkingDuration(5200), '5s')
  assert.equal(formatThinkingDuration(59_400), '59s')
  // >=60s is `1m 20s`; a zero second part keeps the short form.
  assert.equal(formatThinkingDuration(60_000), '1m')
  assert.equal(formatThinkingDuration(80_000), '1m 20s')
  assert.equal(formatThinkingDuration(3_600_000), '60m')
})

// ---------------------------------------------------------------------------
// Collapsed summary line

test('the collapsed summary counts real wrap lines and keeps the affordance', () => {
  const store = newStore({ events: [assistantEvent(2, THOUGHT, 'Answer.')] })
  const view = new TranscriptView(store, {
    showThinking: true,
    expandTools: false,
    hints: { thinking: 'ctrl+g' },
    thinkingPreviewLines: 1,
    screen: 'fullscreen',
  })
  const output = plain(view.render(64))
  // 4 wrapped lines at this width, 1 previewed -> 3 hidden.
  assert.match(output, /✻ Thought · 3 more lines · click to show more/)
  // The preview is the tail, so the last sentence is what stays visible.
  assert.match(output, /real wrap lines, not newlines\./)
  assert.doesNotMatch(output, /I read the failing test first/)
  assertWidths(view, [24, 40, 64, 100])
})

test('the inline hint uses the real binding and is omitted when unbound', () => {
  const store = newStore({ events: [assistantEvent(2, THOUGHT, 'Answer.')] })
  const bound = plain(new TranscriptView(store, {
    showThinking: true, expandTools: false, hints: { thinking: 'ctrl+g' }, thinkingPreviewLines: 0, screen: 'inline',
  }).render(64))
  assert.match(bound, /✻ Thought · 4 more lines · ctrl\+g to expand/)

  const unbound = plain(new TranscriptView(store, {
    showThinking: true, expandTools: false, thinkingPreviewLines: 0, screen: 'inline',
  }).render(64))
  assert.match(unbound, /✻ Thought · 4 more lines/)
  assert.doesNotMatch(unbound, /to expand/, 'an unbound action advertises no key')
  assert.doesNotMatch(unbound, /click to show more/, 'inline mode never claims a click')
})

test('a thought that fits the preview advertises no hidden lines and no expand claim', () => {
  const store = newStore({ events: [assistantEvent(2, 'short thought', 'Answer.')] })
  const output = plain(new TranscriptView(store, {
    showThinking: true, expandTools: false, hints: { thinking: 'ctrl+g' }, thinkingPreviewLines: 3, screen: 'inline',
  }).render(80))
  // Nothing is hidden, so nothing is promised: an expand affordance here would
  // only teach the user that the key does not work.
  assert.match(output, /✻ Thought\n/)
  assert.doesNotMatch(output, /more line/)
  assert.doesNotMatch(output, /to expand|click to show more/)
  assert.match(output, /short thought/)

  const fullscreen = plain(new TranscriptView(store, {
    showThinking: true, expandTools: false, hints: { thinking: 'ctrl+g' }, thinkingPreviewLines: 3, screen: 'fullscreen',
  }).render(80))
  assert.doesNotMatch(fullscreen, /click to show more/, 'fullscreen does not claim a click that reveals nothing')
})

test('one hidden line is singular', () => {
  const store = newStore({ events: [assistantEvent(2, words(40), 'Answer.')] })
  const total = (() => {
    const summary = plain(new TranscriptView(store, {
      showThinking: true, expandTools: false, thinkingPreviewLines: 0, screen: 'fullscreen',
    }).render(70))
    const count = /✻ Thought · (\d+) more lines/.exec(summary)?.[1]
    return count === undefined ? 0 : Number(count)
  })()
  assert.ok(total > 1, 'the fixture wraps over several lines')
  const one = plain(new TranscriptView(store, {
    showThinking: true, expandTools: false, thinkingPreviewLines: total - 1, screen: 'fullscreen',
  }).render(70))
  assert.match(one, /✻ Thought · 1 more line · click to show more/)
  assert.doesNotMatch(one, /1 more lines/)
})

test('a single long paragraph still counts as wrap lines', () => {
  const text = 'x '.repeat(200).trim()
  const store = newStore({ events: [assistantEvent(2, text, 'Answer.')] })
  const collapsed = plain(new TranscriptView(store, {
    showThinking: true, expandTools: false, thinkingPreviewLines: 1, screen: 'fullscreen',
  }).render(60))
  const hidden = Number(/· (\d+) more lines/.exec(collapsed)?.[1] ?? 0)
  assert.ok(hidden >= 4, `expected several wrapped lines, got ${hidden}`)
})

test('an over-wide summary truncates the heading and keeps the hint', () => {
  const store = newStore({ events: [assistantEvent(2, words(80), 'Answer.')] })
  const view = new TranscriptView(store, {
    showThinking: true, expandTools: false, hints: { thinking: 'alt+t' }, thinkingPreviewLines: 0, screen: 'fullscreen',
  })
  const line = view.render(40).find(entry => entry.includes('✻')) ?? ''
  assert.match(plain([line]), /click to show more$/)
  assert.ok(visibleWidth(line) <= 40, `${visibleWidth(line)} > 40`)
  assert.match(plain([line]), /^✻ Thought · /, 'the counted heading keeps its shape')
  assert.match(plain([line]), /\.\.\./, 'the heading itself is what gets shortened')
})

test('tabs and control bytes are expanded before counting, so the count matches the render', () => {
  const store = newStore({ events: [assistantEvent(2, '\talpha\tbeta', 'Answer.')] })
  const output = plain(new TranscriptView(store, {
    showThinking: true, expandTools: false, thinkingPreviewLines: 0, screen: 'fullscreen',
  }).render(80))
  assert.doesNotMatch(output, /\t/, 'no raw tab reaches the grid')
  assert.match(output, /1 more line/)
})

// ---------------------------------------------------------------------------
// Expansion

test('clicking the summary expands the full reasoning and replaces the expand hint', () => {
  clearThinkingExpansion()
  const store = newStore({ events: [assistantEvent(2, THOUGHT, 'Answer.')] })
  let renders = 0
  const view = new TranscriptView(store, {
    showThinking: true,
    expandTools: false,
    hints: { thinking: 'ctrl+g' },
    thinkingPreviewLines: 1,
    screen: 'fullscreen',
    onRenderRequest: () => { renders += 1 },
  })
  view.render(64)
  const summaryRow = view.rowSpans[0]!.startRow
  const event = { type: 'click' as const, button: 'left' as const, x: 4, y: summaryRow, screenX: 4, screenY: summaryRow, width: 64, height: 20, shift: false, alt: false, ctrl: false }
  const result = view.handleMouse(event)
  assert.deepEqual({ handled: result?.handled, render: result?.render }, { handled: true, render: true })
  assert.equal(renders, 1, 'the click asks the parent for a repaint')
  assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:2', 0)), true)

  const expanded = plain(view.render(64))
  assert.match(expanded, /✻ Thought · click to collapse/, 'the summary row survives expansion and keeps an affordance')
  assert.doesNotMatch(expanded, /click to show more/, 'the expand hint is replaced, not duplicated')
  assert.match(expanded, /I read the failing test first/, 'the whole thought is rendered')
  assert.match(expanded, /collapsed summary must count/)
  assert.match(expanded, /real wrap lines, not newlines\./)
  assertWidths(view, [24, 40, 64, 100])

  // A second click collapses it again.
  view.render(64)
  view.handleMouse(event)
  const collapsed = plain(view.render(64))
  assert.match(collapsed, /more lines · click to show more/)
  assert.doesNotMatch(collapsed, /I read the failing test first/)
  clearThinkingExpansion()
})

test('expansion keys are module level, keyed by item and run, and clearable', () => {
  clearThinkingExpansion()
  assert.equal(thinkingExpandedCount(), 0)
  const key = thinkingExpansionKey('attempt:live:1', 2)
  assert.equal(key, 'attempt:live:1:2')
  setThinkingExpanded(key, true)
  assert.equal(isThinkingExpanded(key), true)
  assert.equal(thinkingExpandedCount(), 1)
  setThinkingExpanded(key, false)
  assert.equal(thinkingExpandedCount(), 0)
  setThinkingExpanded('a:0', true)
  setThinkingExpanded('b:0', true)
  clearThinkingExpansion()
  assert.equal(thinkingExpandedCount(), 0)
  assert.equal(isThinkingExpanded('a:0'), false)
})

test('toggleLatestThinking flips the last run of the last item', () => {
  clearThinkingExpansion()
  const store = newStore({
    events: [assistantEvent(2, 'first thought', 'A.'), assistantEvent(3, 'second thought', 'B.')],
  })
  let renders = 0
  const view = new TranscriptView(store, {
    showThinking: true, expandTools: false, thinkingPreviewLines: 0, onRenderRequest: () => { renders += 1 },
  })
  assert.equal(view.toggleLatestThinking(), true)
  assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:3', 0)), true)
  assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:2', 0)), false)
  assert.equal(renders, 1)
  assert.equal(view.toggleLatestThinking(), true)
  assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:3', 0)), false)

  const empty = new TranscriptView(newStore(), { showThinking: true, expandTools: false })
  assert.equal(empty.toggleLatestThinking(), false, 'nothing to toggle is reported, not invented')
  clearThinkingExpansion()
})

test('hover brightens the hint and only repaints on a real transition', () => {
  clearThinkingExpansion()
  const store = newStore({ events: [assistantEvent(2, THOUGHT, 'Answer.')] })
  let renders = 0
  const block = new ThinkingBlock({ itemId: 'assistant:2', onRenderRequest: () => { renders += 1 } })
  const input = { runs: [{ text: THOUGHT }], width: 64, previewLines: 1, screen: 'fullscreen' as const, toggleKey: 'ctrl+g', rowOffset: 0 }
  const before = block.render(input)
  assert.equal(block.hitboxes().length, 1)
  assert.equal(block.hitboxes()[0]!.startRow, 0)
  assert.equal(block.hitboxes()[0]!.endRow, 0, 'the hitbox is the summary row only')
  const hint = ' · click to show more'
  assert.ok(before[0]!.includes(t.muted(hint)), 'the resting hint uses the muted tone')
  assert.ok(!before[0]!.includes(t.accent(hint)), 'the resting hint is not the bright tone')

  block.sync()
  const hover = block.handleMouse({ type: 'move', button: 'none', x: 6, y: 0, screenX: 6, screenY: 0, width: 64, height: 10, shift: false, alt: false, ctrl: false })
  assert.equal(hover?.render, true)
  assert.equal(renders, 1, 'entering the summary asks for a repaint')
  const hovered = block.render(input)
  assert.ok(hovered[0]!.includes(t.accent(hint)), 'the hovered hint switches to the bright accent')
  assert.ok(!hovered[0]!.includes(t.muted(hint)))

  // Staying inside the same hitbox is not a transition: no extra repaint.
  block.sync()
  block.handleMouse({ type: 'move', button: 'none', x: 8, y: 0, screenX: 8, screenY: 0, width: 64, height: 10, shift: false, alt: false, ctrl: false })
  assert.equal(renders, 1)

  // Leaving the row restores the muted tone.
  block.sync()
  block.handleMouse({ type: 'move', button: 'none', x: 6, y: 5, screenX: 6, screenY: 5, width: 64, height: 10, shift: false, alt: false, ctrl: false })
  assert.equal(renders, 2)
  assert.ok(block.render(input)[0]!.includes(t.muted(hint)))
  clearThinkingExpansion()
})

test('events outside the summary row stay unhandled', () => {
  const store = newStore({ events: [assistantEvent(2, THOUGHT, 'Answer.')] })
  const view = new TranscriptView(store, { showThinking: true, expandTools: false, thinkingPreviewLines: 1 })
  view.render(64)
  const outside = { type: 'click' as const, button: 'left' as const, x: 2, y: 99, screenX: 2, screenY: 99, width: 64, height: 20, shift: false, alt: false, ctrl: false }
  assert.equal(view.handleMouse(outside), undefined, 'an empty row leaves the event to TuiAltScreen')
  const previewRow = view.rowSpans[0]!.startRow + 2
  const preview = view.handleMouse({ ...outside, y: previewRow, screenY: previewRow })
  assert.equal(preview, undefined, 'preview rows are not clickable')
})

// ---------------------------------------------------------------------------
// showThinking = false keeps the previous behaviour

test('showThinking=false never leaks reasoning and keeps the single-line marker', () => {
  const store = newStore({ events: [assistantEvent(2, THOUGHT, 'Answer.')] })
  const hidden = plain(new TranscriptView(store, { showThinking: false, expandTools: false }).render(70))
  assert.match(hidden, /✻ Thought \(hidden\)/)
  assert.doesNotMatch(hidden, /collapsed summary/)
  assert.doesNotMatch(hidden, /more line/)

  const hinted = plain(new TranscriptView(store, { showThinking: false, expandTools: false, hints: { thinking: 'ctrl+g' } }).render(70))
  assert.match(hinted, /✻ Thought \(ctrl\+g to show\)/)
  // The toggle keeps working when the text is hidden.
  const view = new TranscriptView(store, { showThinking: false, expandTools: false, hints: { thinking: 'ctrl+g' } })
  assert.equal(view.toggleLatestThinking(), true, 'the toggle target exists even when the text is hidden')
  assert.doesNotMatch(plain(view.render(70)), /collapsed summary/)
  clearThinkingExpansion()
})

test('a click fires the viewport anchor before the state flips, in both directions', () => {
  clearThinkingExpansion()
  const store = newStore({ events: [assistantEvent(2, THOUGHT, 'Answer.')] })
  const anchors: Array<{ expanding: boolean; expandedAt: boolean }> = []
  const view = new TranscriptView(store, {
    showThinking: true,
    expandTools: false,
    thinkingPreviewLines: 1,
    screen: 'fullscreen',
    onViewportAnchor: expanding => anchors.push({ expanding, expandedAt: isThinkingExpanded(thinkingExpansionKey('assistant:2', 0)) }),
  })
  view.render(64)
  const summaryRow = view.rowSpans[0]!.startRow
  const event = { type: 'click' as const, button: 'left' as const, x: 4, y: summaryRow, screenX: 4, screenY: summaryRow, width: 64, height: 20, shift: false, alt: false, ctrl: false }
  view.handleMouse(event)
  view.handleMouse(event)
  // The app freezes follow-end BEFORE the flip (keepViewportOnExpand) and
  // restores it on the collapsing click; direction must match the flip.
  assert.deepEqual(anchors, [{ expanding: true, expandedAt: false }, { expanding: false, expandedAt: true }])
  clearThinkingExpansion()
})

test('hasHiddenThinking tells the parent when expanding would show nothing', () => {
  clearThinkingExpansion()
  const store = newStore({ events: [assistantEvent(2, 'a hidden thought', 'Answer.')] })
  const hidden = new TranscriptView(store, { showThinking: false, expandTools: false })
  assert.equal(hidden.hasHiddenThinking, true)
  assert.equal(hidden.toggleLatestThinking(), true, 'the expansion state flips even while hidden')
  const shown = new TranscriptView(store, { showThinking: true, expandTools: false })
  assert.equal(shown.hasHiddenThinking, false)
  assert.equal(new TranscriptView(newStore(), { showThinking: false, expandTools: false }).hasHiddenThinking, false)

  // The view module re-exports the module-level reset for the parent.
  assert.ok(thinkingExpandedCount() > 0)
  clearFromView()
  assert.equal(thinkingExpandedCount(), 0)
})

// ---------------------------------------------------------------------------
// Live streaming runs

interface Clock { value: number }

function liveStore(clock: Clock): TranscriptStore {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC, now: () => clock.value })
  store.reset(info())
  return store
}

const chunk = (store: TranscriptStore, revision: number, index: number, body: Record<string, unknown>, attemptId = 'att'): void =>
  store.handle({ type: 'stream_chunk', sessionId: 's1', attemptId, revision, index, chunk: body } as BackendEvent)

test('live reasoning is one run, closed at the first text delta with a measured duration', () => {
  const clock: Clock = { value: 1_000_000 }
  const store = liveStore(clock)
  store.handle({ type: 'stream_start', sessionId: 's1', attemptId: 'att', revision: 1, turn: 1, step: 1 } as BackendEvent)
  chunk(store, 2, 0, { type: 'block-start', index: 0, blockType: 'reasoning' })
  clock.value += 1_200
  chunk(store, 3, 1, { type: 'reasoning-delta', index: 0, text: 'think ' })
  chunk(store, 4, 2, { type: 'reasoning-delta', index: 0, text: 'harder' })
  const open = store.items[0]
  assert.equal(open?.kind, 'attempt')
  if (open?.kind !== 'attempt') return
  assert.deepEqual(open.thinkingRuns, [{ text: 'think harder', startedAt: 1_000_000 }], 'an open run keeps its start time and no duration')

  clock.value += 800
  chunk(store, 5, 3, { type: 'text-delta', index: 1, text: 'Answer.' })
  const closed = store.items[0]
  if (closed?.kind !== 'attempt') return
  assert.deepEqual(closed.thinkingRuns, [{ text: 'think harder', durationMs: 2_000 }], 'the first text delta freezes the run')
  assert.equal(closed.text, 'Answer.')
})

test('thinking and text alternating produce one run per thought', () => {
  const clock: Clock = { value: 5_000 }
  const store = liveStore(clock)
  store.handle({ type: 'stream_start', sessionId: 's1', attemptId: 'att', revision: 1, turn: 1, step: 1 } as BackendEvent)
  chunk(store, 2, 0, { type: 'block-start', index: 0, blockType: 'reasoning' })
  chunk(store, 3, 1, { type: 'reasoning-delta', index: 0, text: 'first' })
  clock.value += 400
  chunk(store, 4, 2, { type: 'text-delta', index: 1, text: 'between' })
  clock.value += 100
  chunk(store, 5, 3, { type: 'block-start', index: 2, blockType: 'reasoning' })
  chunk(store, 6, 4, { type: 'reasoning-delta', index: 2, text: 'second' })
  clock.value += 300
  chunk(store, 7, 5, { type: 'tool-call-delta', index: 3, id: 'call-1', name: 'read', argumentsDelta: '{}' })

  const item = store.items[0]
  assert.equal(item?.kind, 'attempt')
  if (item?.kind !== 'attempt') return
  const runs = item.thinkingRuns ?? []
  assert.equal(runs.length, 2)
  assert.deepEqual(runs[0], { text: 'first', durationMs: 400 })
  assert.deepEqual(runs[1], { text: 'second', durationMs: 300 }, 'a name-bearing tool delta also closes the run')
})

test('attempt settlement freezes the open run and an abandoned attempt never invents a number', () => {
  const clock: Clock = { value: 10_000 }
  const store = liveStore(clock)
  store.handle({ type: 'stream_start', sessionId: 's1', attemptId: 'att', revision: 1, turn: 1, step: 1 } as BackendEvent)
  chunk(store, 2, 0, { type: 'reasoning-delta', index: 0, text: 'abandoned thought' })
  chunk(store, 3, 1, { type: 'text-delta', index: 1, text: 'partial' })
  // A run opened and closed without the clock moving must not claim a duration.
  clock.value += 2_500
  chunk(store, 4, 2, { type: 'reasoning-delta', index: 2, text: 'late extra thought' })
  store.handle({ type: 'stream_end', sessionId: 's1', attemptId: 'att', revision: 5, outcome: 'abandoned' } as BackendEvent)

  const item = store.items.find(entry => entry.kind === 'attempt')
  assert.equal(item?.kind, 'attempt')
  if (item?.kind !== 'attempt') return
  assert.equal(item.status, 'abandoned')
  assert.equal(item.thinkingRuns?.length, 2)
  assert.equal(item.thinkingRuns?.[0]?.durationMs, undefined, 'a zero-width run claims no duration')
  assert.equal(item.thinkingRuns?.[1]?.durationMs, undefined, 'settlement froze the run, the clock had not moved since it opened')
  const view = new TranscriptView(store, { showThinking: true, expandTools: false, now: () => clock.value })
  const output = plain(view.render(70))
  assert.match(output, /✻ Thought/, 'the honest fallback is a plain Thought line')
  assert.doesNotMatch(output, /for 0ms|for 2s/, 'no fabricated duration')
})

test('a committed attempt keeps its runs until the durable settlement replaces it', () => {
  const clock: Clock = { value: 0 }
  const store = liveStore(clock)
  store.handle({ type: 'stream_start', sessionId: 's1', attemptId: 'att', revision: 1, turn: 1, step: 1 } as BackendEvent)
  chunk(store, 2, 0, { type: 'reasoning-delta', index: 0, text: 'kept thought' })
  clock.value += 1_500
  store.handle({ type: 'stream_end', sessionId: 's1', attemptId: 'att', revision: 3, outcome: 'committed', seq: 4 } as BackendEvent)
  const live = store.items[0]
  assert.equal(live?.kind, 'attempt')
  if (live?.kind !== 'attempt') return
  assert.equal(live.status, 'committing')
  assert.deepEqual(live.thinkingRuns, [{ text: 'kept thought', durationMs: 1_500 }])
})

test('the live view shows Thinking… with elapsed time and a real timer', () => {
  const clock: Clock = { value: 0 }
  const store = liveStore(clock)
  let renders = 0
  const view = new TranscriptView(store, {
    showThinking: true,
    expandTools: false,
    hints: { thinking: 'ctrl+g' },
    thinkingPreviewLines: 3,
    thinkingLiveTimerMs: 250,
    now: () => clock.value,
    onRenderRequest: () => { renders += 1 },
  })
  store.handle({ type: 'stream_start', sessionId: 's1', attemptId: 'att', revision: 1, turn: 1, step: 1 } as BackendEvent)
  chunk(store, 2, 0, { type: 'reasoning-delta', index: 0, text: 'working it out' })
  clock.value += 3_400
  const live = plain(view.render(70))
  assert.match(live, /✻ Thinking… · 3s/)
  assert.doesNotMatch(live, /to expand/, 'a thought that fits the preview hides nothing yet')
  assert.equal(view.liveTimerRunning, true, 'a slow delta interval is covered by the timer')

  // The clock advancing alone changes the next frame (cache key includes it).
  clock.value += 1_000
  assert.match(plain(view.render(70)), /✻ Thinking… · 4s/)

  store.handle({ type: 'stream_end', sessionId: 's1', attemptId: 'att', revision: 3, outcome: 'abandoned' } as BackendEvent)
  assert.match(plain(view.render(70)), /✻ Thought for 4s/)
  assert.equal(view.liveTimerRunning, false, 'the timer stops as soon as no run is accruing time')
})

test('thinkingLiveTimerMs=0 leaves the display purely chunk driven', () => {
  const clock: Clock = { value: 0 }
  const store = liveStore(clock)
  let renders = 0
  const view = new TranscriptView(store, {
    showThinking: true, expandTools: false, thinkingPreviewLines: 0, thinkingLiveTimerMs: 0,
    now: () => clock.value, onRenderRequest: () => { renders += 1 },
  })
  store.handle({ type: 'stream_start', sessionId: 's1', attemptId: 'att', revision: 1, turn: 1, step: 1 } as BackendEvent)
  chunk(store, 2, 0, { type: 'reasoning-delta', index: 0, text: 'quiet stream' })
  clock.value += 900
  assert.match(plain(view.render(70)), /✻ Thinking… · 900ms/)
  assert.equal(view.liveTimerRunning, false)
  assert.equal(renders, 0)
})

test('an in-progress run with no measurable elapsed time prints no number', () => {
  const clock: Clock = { value: 42 }
  const store = liveStore(clock)
  const view = new TranscriptView(store, { showThinking: true, expandTools: false, thinkingPreviewLines: 0, now: () => clock.value })
  store.handle({ type: 'stream_start', sessionId: 's1', attemptId: 'att', revision: 1, turn: 1, step: 1 } as BackendEvent)
  chunk(store, 2, 0, { type: 'reasoning-delta', index: 0, text: 'just started' })
  const output = plain(view.render(70))
  assert.match(output, /✻ Thinking…/)
  assert.doesNotMatch(output, /0ms|·\s*$/, 'no placeholder duration is printed')
})

// ---------------------------------------------------------------------------
// Durable replay (resume)

test('resume derives an approximate attempt duration only when it is unambiguous', () => {
  const oneRun: SessionEvent[] = [
    ev('step/start', 1, { turn: 1, step: 1 }, { time: 1_000 }),
    assistantEvent(2, 'earlier reasoning about the failure', 'settled answer', 6_200),
  ]
  const store = newStore({ events: oneRun })
  const item = store.items.find(entry => entry.kind === 'assistant')
  assert.equal(item?.kind, 'assistant')
  if (item?.kind !== 'assistant') return
  assert.deepEqual(item.thinkingRuns, [{ text: 'earlier reasoning about the failure', durationMs: 5_200 }])
  const output = plain(new TranscriptView(store, { showThinking: true, expandTools: false, thinkingPreviewLines: 0 }).render(70))
  assert.match(output, /✻ Thought for 5s/)

  // Two reasoning runs in one message: the step window is not one thought's
  // duration, so no number is claimed for either.
  const twoRuns: SessionEvent[] = [
    ev('step/start', 1, { turn: 1, step: 1 }, { time: 1_000 }),
    ev('assistant/message', 2, {
      turn: 1,
      step: 1,
      message: {
        id: 'a2',
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'first' },
          { type: 'text', text: 'middle' },
          { type: 'reasoning', text: 'second' },
          { type: 'text', text: 'end' },
        ],
        source: { kind: 'model', provider: 'demo', model: 'demo' },
      },
      stream: [],
    }, { surfaceOp: 'append', time: 9_000 }),
  ]
  const multi = newStore({ events: twoRuns })
  const multiItem = multi.items.find(entry => entry.kind === 'assistant')
  assert.equal(multiItem?.kind, 'assistant')
  if (multiItem?.kind !== 'assistant') return
  assert.equal(multiItem.thinkingRuns?.length, 2)
  assert.deepEqual(multiItem.thinkingRuns, [{ text: 'first' }, { text: 'second' }])
  const multiOutput = plain(new TranscriptView(multi, { showThinking: true, expandTools: false }).render(70))
  assert.equal(multiOutput.split('\n').filter(entry => entry.startsWith('✻ Thought')).length, 2)
  assert.doesNotMatch(multiOutput, / for /, 'two runs share no single duration')
})

test('a durable replay without event times degrades to a plain Thought line', () => {
  const store = newStore({ events: [ev('assistant/message', 1, {
    turn: 1,
    step: 1,
    message: {
      id: 'a1',
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'no timing available anywhere' }, { type: 'text', text: 'done' }],
      source: { kind: 'model', provider: 'demo', model: 'demo' },
    },
    stream: [],
  }, { surfaceOp: 'append' })] })
  const item = store.items[0]
  assert.equal(item?.kind, 'assistant')
  if (item?.kind !== 'assistant') return
  assert.deepEqual(item.thinkingRuns, [{ text: 'no timing available anywhere' }])
  const output = plain(new TranscriptView(store, { showThinking: true, expandTools: false, thinkingPreviewLines: 3 }).render(70))
  assert.match(output, /✻ Thought\n/)
  assert.doesNotMatch(output, / for /)
})

test('a settled attempt keeps its summary one row below the label, so its hitbox stays aligned', () => {
  clearThinkingExpansion()
  const store = newStore({ events: [ev('assistant/attempt', 4, {
    turn: 1,
    step: 1,
    stream: [
      { type: 'reasoning-chunks', time0: 0, index: 0, dt: [1], texts: ['half formed thought'] },
      { type: 'text-chunks', time0: 0, index: 1, dt: [1], texts: ['partial answer'] },
    ],
  })] })
  const view = new TranscriptView(store, { showThinking: true, expandTools: false, thinkingPreviewLines: 0, hints: { thinking: 'ctrl+g' } })
  const lines = plain(view.render(70)).split('\n')
  assert.match(lines[0] ?? '', /Incomplete response/)
  assert.match(lines[1] ?? '', /✻ Thought/)
  const row = view.rowSpans[0]!.startRow + 1
  const event = { type: 'click' as const, button: 'left' as const, x: 3, y: row, screenX: 3, screenY: row, width: 70, height: 20, shift: false, alt: false, ctrl: false }
  assert.equal(view.handleMouse(event)?.handled, true, 'the summary hitbox is re-based by the block label row')
  assert.equal(isThinkingExpanded(thinkingExpansionKey('attempt:4', 0)), true)
  clearThinkingExpansion()
})

test('several runs in one item each get their own summary and hitbox', () => {
  clearThinkingExpansion()
  const store = newStore({ events: [ev('assistant/message', 2, {
    turn: 1,
    step: 1,
    message: {
      id: 'a2',
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'first thought body' },
        { type: 'text', text: 'answer one' },
        { type: 'reasoning', text: 'second thought body' },
        { type: 'text', text: 'answer two' },
      ],
      source: { kind: 'model', provider: 'demo', model: 'demo' },
    },
    stream: [],
  }, { surfaceOp: 'append' })] })
  const view = new TranscriptView(store, { showThinking: true, expandTools: false, thinkingPreviewLines: 3, hints: { thinking: 'ctrl+g' } })
  const output = plain(view.render(70))
  const summaries = output.split('\n').filter(line => line.includes('✻ Thought'))
  assert.equal(summaries.length, 2, 'one collapsed summary per run')
  assert.match(output, /first thought body/)
  assert.match(output, /second thought body/)
  assert.match(output, /answer one/)
  assert.match(output, /answer two/)

  // Each summary toggles independently.
  const first = view.rowSpans[0]!.startRow
  const base = { type: 'click' as const, button: 'left' as const, x: 2, screenX: 2, width: 70, height: 20, shift: false, alt: false, ctrl: false }
  const secondRow = view.render(70).findIndex(line => stripTerminalSequences(line).includes('✻ Thought') && line !== '' && view.render(70).indexOf(line) > 0)
  void secondRow
  const spans = plain(view.render(70)).split('\n')
  const indexes = spans.map((line, index) => (line.includes('✻ Thought') ? index : -1)).filter(index => index >= 0)
  assert.equal(indexes.length, 2)
  view.handleMouse({ ...base, y: first + indexes[0]!, screenY: first + indexes[0]! })
  const afterFirst = plain(view.render(70))
  assert.match(afterFirst, /first thought body/)
  assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:2', 0)), true)
  assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:2', 1)), false)
  view.handleMouse({ ...base, y: first + indexes[1]!, screenY: first + indexes[1]! })
  assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:2', 1)), true)
  clearThinkingExpansion()
})

// ---------------------------------------------------------------------------
// Mouse routing through the view

test('the view routes a click to the block under the row, not to the previous item', () => {
  clearThinkingExpansion()
  const store = newStore({
    events: [
      ev('user/message', 1, { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
      assistantEvent(2, 'routed thought body', 'answer'),
    ],
  })
  let renders = 0
  const view = new TranscriptView(store, {
    showThinking: true, expandTools: false, hints: { thinking: 'ctrl+g' }, thinkingPreviewLines: 0, screen: 'fullscreen',
    onRenderRequest: () => { renders += 1 },
  })
  const spans = view.render(70)
  void spans
  const assistantSpan = view.rowSpans.find(span => span.itemId === 'assistant:2')
  assert.ok(assistantSpan !== undefined)
  assert.equal(assistantSpan.startRow, 2, 'one user row, one gap row, then the assistant block')

  const base = { type: 'press' as const, button: 'left' as const, x: 1, screenX: 1, width: 70, height: 30, shift: false, alt: false, ctrl: false }
  assert.equal(view.handleMouse({ ...base, y: assistantSpan.startRow - 1, screenY: assistantSpan.startRow - 1 }), undefined, 'the gap row is not owned by any block')
  assert.equal(view.handleMouse({ ...base, y: 0, screenY: 0 }), undefined, 'the user block has no hitboxes')
  const pressed = view.handleMouse({ ...base, type: 'click', y: assistantSpan.startRow, screenY: assistantSpan.startRow })
  assert.equal(pressed?.handled, true)
  assert.equal(renders, 1)
  assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:2', 0)), true)
  clearThinkingExpansion()
})

test('the tool card keeps its own click handler through the same routing', () => {
  const store = newStore({
    events: [
      ev('assistant/message', 1, {
        turn: 1,
        step: 1,
        message: {
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"seq 1 12"}' }],
          source: { kind: 'model', provider: 'demo', model: 'demo' },
        },
        stream: [],
      }, { surfaceOp: 'append' }),
      ev('tool/call', 2, { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"seq 1 12"}' }),
      ev('tool/result', 3, {
        turn: 1,
        step: 1,
        message: {
          id: 'tr-1',
          role: 'tool',
          toolCallId: 'call-1',
          content: [{ type: 'text', text: Array.from({ length: 12 }, (_, index) => `row ${index + 1}`).join('\n') }],
          isError: false,
          source: { kind: 'tool', callId: 'call-1' },
        },
      }, { surfaceOp: 'append' }),
    ],
  })
  const view = new TranscriptView(store, { showThinking: false, expandTools: false })
  const folded = plain(view.render(70))
  assert.match(folded, /12 lines returned/)
  const span = view.rowSpans.find(entry => entry.itemId === 'tool:call-1')
  assert.ok(span !== undefined)
  const click = { type: 'click' as const, button: 'left' as const, x: 2, y: span.startRow, screenX: 2, screenY: span.startRow, width: 70, height: 30, shift: false, alt: false, ctrl: false }
  assert.equal(view.handleMouse(click)?.handled, true)
  const expandedPreview = plain(view.render(70))
  assert.match(expandedPreview, /├ Input/)
  assert.match(expandedPreview, /└ Output/)
  assert.match(expandedPreview, /row 10/, 'the tool block expanded through the routed click')
  assert.match(expandedPreview, /2 more lines/, 'the separate Output preview budget remains honest')
  assert.doesNotMatch(expandedPreview, /row 12/)
  view.options.expandedOutputMaxLines = 20
  assert.match(plain(view.render(70)), /row 12/, 'the source is retained beyond the preview budget')
})
// ---------------------------------------------------------------------------
// Expanded bodies: click anywhere in the run to collapse, selection stays native

/** The dispatch target pi-tui records from a handled press (block + origin). */
interface DispatchTarget {
  readonly component: { handleMouse?: (event: unknown) => { handled?: boolean; render?: boolean } | undefined }
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
}

/** Read the forwarded target a routed press handed back to the renderer. */
function pressTarget(result: unknown): DispatchTarget | undefined {
  if (result === undefined || typeof result !== 'object') return undefined
  const target = (result as { target?: unknown }).target
  return target === undefined ? undefined : (target as DispatchTarget)
}

test('an expanded run collapses from a click anywhere in its own body', () => {
  clearThinkingExpansion()
  const store = newStore({ events: [assistantEvent(2, THOUGHT, 'Answer.')] })
  const view = new TranscriptView(store, {
    showThinking: true, expandTools: false, hints: { thinking: 'ctrl+g' }, thinkingPreviewLines: 1, screen: 'fullscreen',
  })
  const base = { button: 'left' as const, x: 4, screenX: 4, width: 64, height: 30, shift: false, alt: false, ctrl: false }

  view.render(64)
  const summaryRow = view.rowSpans[0]!.startRow
  view.handleMouse({ ...base, type: 'click', y: summaryRow, screenY: summaryRow })
  assert.equal(thinkingExpandedCount(), 1)

  const expanded = plain(view.render(64)).split('\n')
  const answerRow = expanded.findIndex(line => line.includes('⏺'))
  assert.ok(answerRow > summaryRow + 2, 'the expanded body sits between the summary and the answer')
  const selectionRow = summaryRow + 2

  // The body stays native for the pointer: press/move/drag select text.
  for (const type of ['press', 'move', 'drag'] as const) {
    assert.equal(
      view.handleMouse({ ...base, type, y: selectionRow, screenY: selectionRow }),
      undefined,
      `${type} over reasoning text is left to the terminal selection`,
    )
  }
  assert.equal(thinkingExpandedCount(), 1, 'touching the body does not toggle')

  // The body hitbox stops at this run: the gap row and the answer row below it
  // belong to no region.
  for (const row of [answerRow - 1, answerRow]) {
    assert.equal(view.handleMouse({ ...base, type: 'click', y: row, screenY: row }), undefined, `row ${row} is not part of the body`)
  }

  // …while the native synthesized click (an undragged press/release) collapses.
  assert.deepEqual(
    { handled: view.handleMouse({ ...base, type: 'click', y: selectionRow, screenY: selectionRow })?.handled },
    { handled: true },
  )
  assert.equal(thinkingExpandedCount(), 0, 'a plain click in the body collapses the run')
  assert.match(plain(view.render(64)), /more lines · click to show more/, 'the run is collapsed again')
  clearThinkingExpansion()
})

test('body click bounds stop at the next run and never cover the following message', () => {
  clearThinkingExpansion()
  const store = newStore({ events: [ev('assistant/message', 2, {
    turn: 1,
    step: 1,
    message: {
      id: 'a2',
      role: 'assistant',
      content: [
        { type: 'reasoning', text: THOUGHT },
        { type: 'text', text: 'answer one' },
        { type: 'reasoning', text: 'second thought body' },
        { type: 'text', text: 'answer two' },
      ],
      source: { kind: 'model', provider: 'demo', model: 'demo' },
    },
    stream: [],
  }, { surfaceOp: 'append' })] })
  const view = new TranscriptView(store, {
    showThinking: true, expandTools: false, hints: { thinking: 'ctrl+g' }, thinkingPreviewLines: 3, screen: 'fullscreen',
  })
  const base = { button: 'left' as const, x: 4, screenX: 4, width: 70, height: 40, shift: false, alt: false, ctrl: false }
  const summaries = (): number[] => {
    const lines = plain(view.render(70)).split('\n')
    return lines.map((line, index) => (line.includes('✻ Thought') ? index : -1)).filter(index => index >= 0)
  }

  const [firstSummary] = summaries()
  assert.ok(firstSummary !== undefined)
  view.handleMouse({ ...base, type: 'click', y: firstSummary, screenY: firstSummary })
  assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:2', 0)), true)

  const afterFirst = summaries()
  assert.equal(afterFirst.length, 2)
  const secondSummary = afterFirst[1]!
  // Run 0's body is `firstSummary+1 .. secondSummary-1`; the last row of it is a
  // body row, so a body click there collapses run 0 only.
  view.handleMouse({ ...base, type: 'click', y: secondSummary - 1, screenY: secondSummary - 1 })
  assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:2', 0)), false, 'the tail of run 0 is still its own body')
  assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:2', 1)), false, 'run 1 was not touched')

  // Expand run 1 through its summary and collapse it from its own body.
  const secondSummaryRow = summaries()[1]!
  view.handleMouse({ ...base, type: 'click', y: secondSummaryRow, screenY: secondSummaryRow })
  assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:2', 1)), true)
  // A frame lands after the click (the app repaints on every click), so the new
  // body rows are declared before the pointer uses them.
  const openRows = summaries()
  const bodyRow = openRows[1]! + 1
  assert.equal(openRows[1], secondSummaryRow, 'the run grew below its own summary only')
  assert.equal(
    view.handleMouse({ ...base, type: 'click', y: bodyRow, screenY: bodyRow })?.handled,
    true,
    'run 1 is clickable from its body row',
  )
  assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:2', 1)), false)
  clearThinkingExpansion()
})

test('the expanded summary advertises a real collapse affordance', () => {
  clearThinkingExpansion()
  const store = newStore({ events: [assistantEvent(2, words(60), 'Answer.')] })
  const open = (options: { screen: 'inline' | 'fullscreen'; thinking?: string }): string => {
    clearThinkingExpansion()
    const view = new TranscriptView(store, {
      showThinking: true, expandTools: false, thinkingPreviewLines: 0, screen: options.screen,
      ...(options.thinking === undefined ? {} : { hints: { thinking: options.thinking } }),
    })
    view.render(70)
    assert.equal(view.toggleLatestThinking(), true)
    return plain(view.render(70))
  }

  assert.match(open({ screen: 'fullscreen' }), /✻ Thought · click to collapse/)
  assert.match(open({ screen: 'inline', thinking: 'ctrl+g' }), /✻ Thought · ctrl\+g to collapse/)
  const unbound = open({ screen: 'inline' })
  assert.match(unbound, /✻ Thought/)
  assert.doesNotMatch(unbound, /to collapse/, 'an unbound action advertises no key')
  assert.doesNotMatch(unbound, /click/, 'inline mode never claims a click')
  clearThinkingExpansion()
})

// ---------------------------------------------------------------------------
// No phantom hitbox when the reasoning is hidden

test('hiding the reasoning clears the summary hitbox and fires no viewport anchor', () => {
  clearThinkingExpansion()
  const store = newStore({ events: [ev('assistant/message', 2, {
    turn: 1,
    step: 1,
    message: {
      id: 'a2',
      role: 'assistant',
      content: [{ type: 'reasoning', text: THOUGHT }, { type: 'text', text: 'Answer.' }],
      source: { kind: 'model', provider: 'demo', model: 'demo' },
    },
    stream: [],
  }, { surfaceOp: 'append' })] })
  const anchors: boolean[] = []
  const view = new TranscriptView(store, {
    showThinking: true, expandTools: false, hints: { thinking: 'ctrl+g' }, thinkingPreviewLines: 1, screen: 'fullscreen',
    onViewportAnchor: expanding => anchors.push(expanding),
  })
  const base = { button: 'left' as const, x: 4, screenX: 4, width: 70, height: 24, shift: false, alt: false, ctrl: false }
  view.render(70)
  assert.match(plain(view.render(70)).split('\n')[0] ?? '', /✻ Thought · \d+ more lines · click to show more/)

  // The master switch is turned off while the summary is on screen (／settings).
  view.options.showThinking = false
  const hidden = plain(view.render(70)).split('\n')
  assert.match(hidden[0] ?? '', /✻ Thought \(ctrl\+g to show\)/)

  for (const type of ['press', 'click'] as const) {
    assert.equal(
      view.handleMouse({ ...base, type, y: 0, screenY: 0 }),
      undefined,
      `the hidden marker row is not a click target (${type})`,
    )
  }
  assert.deepEqual(anchors, [], 'no viewport anchor for an expansion nobody can see')
  assert.equal(thinkingExpandedCount(), 0, 'no invisible expansion state')

  // Re-enabling shows the collapsed summary, not a run the user never opened.
  view.options.showThinking = true
  assert.match(plain(view.render(70)).split('\n')[0] ?? '', /✻ Thought · \d+ more lines · click to show more/)
  clearThinkingExpansion()
})

test('ThinkingBlock.clear drops its hitboxes, hover and press state', () => {
  clearThinkingExpansion()
  const block = new ThinkingBlock({ itemId: 'assistant:9' })
  const input = { runs: [{ text: THOUGHT }], width: 60, previewLines: 1, screen: 'fullscreen' as const, toggleKey: 'ctrl+g', rowOffset: 0 }
  block.render(input)
  block.sync()
  assert.equal(block.hitboxes().length, 1)

  block.clear()
  assert.equal(block.hitboxes().length, 0)
  assert.equal(block.runCount, 0)
  assert.equal(block.handleMouse({ type: 'press', button: 'left', x: 2, y: 0, screenX: 2, screenY: 0, width: 60, height: 10, shift: false, alt: false, ctrl: false }), undefined)
  clearThinkingExpansion()
})

// ---------------------------------------------------------------------------
// Press pinning through the real dispatch contract

test('a claimed summary press survives a repaint that moves its row', () => {
  clearThinkingExpansion()
  const store = newStore({ events: [assistantEvent(2, THOUGHT, 'first answer'), assistantEvent(3, THOUGHT, 'second answer')] })
  const view = new TranscriptView(store, {
    showThinking: true, expandTools: false, hints: { thinking: 'ctrl+g' }, thinkingPreviewLines: 1, screen: 'fullscreen',
  })
  const base = { button: 'left' as const, x: 4, screenX: 4, width: 64, height: 30, shift: false, alt: false, ctrl: false }

  view.render(64)
  const before = view.rowSpans.find(span => span.itemId === 'assistant:3')
  assert.ok(before !== undefined)
  const pressRow = before.startRow
  const press = view.handleMouse({ ...base, type: 'press', y: pressRow, screenY: pressRow })
  const target = pressTarget(press)
  assert.deepEqual({ handled: (press as { handled?: boolean }).handled }, { handled: true })
  assert.ok(target !== undefined, 'the press target is the block, not the transcript view')

  // A repaint between press and release: expanding the earlier item pushes
  // assistant:3 down (a streaming chunk plus follow-end scrolling does the same).
  setThinkingExpanded(thinkingExpansionKey('assistant:2', 0), true)
  view.invalidate()
  view.render(64)
  const after = view.rowSpans.find(span => span.itemId === 'assistant:3')
  assert.ok(after !== undefined)
  assert.ok(after.startRow > pressRow, 'the pressed row moved with the repaint')

  // pi-tui re-bases the synthesized click with the press-time origin, so the
  // block receives the press-time local row.
  const click = { ...base, type: 'click' as const, x: 4, y: 0, screenX: 4, screenY: pressRow, width: base.width, height: base.height }
  const replayed = target.component.handleMouse?.({
    ...click,
    x: click.screenX - target.originX,
    y: click.screenY - target.originY,
  })
  assert.deepEqual({ handled: replayed?.handled, render: replayed?.render }, { handled: true, render: true })

  assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:3', 0)), true, 'the pressed summary expanded')
  assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:2', 0)), true, 'the run now under that row was left alone')
  clearThinkingExpansion()
})

test('a keyboard toggle fires the viewport anchor before the flip, like a click', () => {
  clearThinkingExpansion()
  const store = newStore({ events: [assistantEvent(2, THOUGHT, 'Answer.')] })
  const anchors: Array<{ expanding: boolean; expandedAt: boolean }> = []
  const view = new TranscriptView(store, {
    showThinking: true,
    expandTools: false,
    thinkingPreviewLines: 1,
    screen: 'fullscreen',
    onViewportAnchor: expanding => anchors.push({ expanding, expandedAt: isThinkingExpanded(thinkingExpansionKey('assistant:2', 0)) }),
  })
  view.render(64)
  assert.equal(view.toggleLatestThinking(), true)
  assert.equal(view.toggleLatestThinking(), true)
  assert.deepEqual(anchors, [{ expanding: true, expandedAt: false }, { expanding: false, expandedAt: true }])
  clearThinkingExpansion()
})
