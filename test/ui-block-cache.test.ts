// Must stay FIRST: forces truecolor before src modules snapshot terminal mode.
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { SubagentEntry, SubagentSnapshot, SessionEvent, SessionInfo } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import type { AssistantTranscriptItem, ToolTranscriptItem, UserTranscriptItem } from '../src/state/transcript.ts'
import { createItemBlock, type ItemBlock, type TranscriptViewOptions } from '../src/ui/blocks.ts'
import { cacheKeyBuilds, resetCacheKeyBuilds } from '../src/ui/render-counters.ts'
import { clearThinkingExpansion, setThinkingExpanded, thinkingExpansionKey } from '../src/ui/thinking-block.ts'
import { clearToolExpansion, isToolExpanded, setToolExpanded, toolExpansionKey } from '../src/ui/tool-expansion.ts'
import { TranscriptView } from '../src/ui/transcript.ts'

/**
 * The block paint caches, pinned by deterministic counters instead of timings.
 *
 * One rule per test: a repaint whose key inputs are unchanged reuses the exact
 * lines array and composes no key, and every input that *can* change between
 * two paints invalidates first. `cacheKeyBuilds()` counts composed keys, so
 * "cheap" and "stale" are both observable facts.
 */

const flags = (overrides: Partial<TranscriptViewOptions> = {}): TranscriptViewOptions => ({
  showThinking: true,
  expandTools: false,
  hints: {},
  screen: 'fullscreen',
  thinkingPreviewLines: 3,
  ...overrides,
})

const userItem = (id: string, text: string, version = 1): UserTranscriptItem => ({
  kind: 'user',
  id,
  text,
  imageCount: 0,
  version,
})

const assistantItem = (
  id: string,
  text: string,
  options: { thinking?: string; thinkingRuns?: AssistantTranscriptItem['thinkingRuns']; version?: number } = {},
): AssistantTranscriptItem => ({
  kind: 'assistant',
  id,
  text,
  thinking: options.thinking ?? '',
  ...(options.thinkingRuns === undefined ? {} : { thinkingRuns: options.thinkingRuns }),
  interrupted: false,
  version: options.version ?? 1,
})

const toolItem = (
  callId: string,
  options: Partial<ToolTranscriptItem> = {},
): ToolTranscriptItem => ({
  kind: 'tool',
  id: `tool:${callId}`,
  callId,
  name: 'bash',
  arguments: JSON.stringify({ command: 'npm test' }),
  status: 'done',
  resultText: 'ok',
  resultImages: 0,
  resultIsError: false,
  meta: undefined,
  version: 1,
  ...options,
})

/** Byte equality of two painted frames (arrays are compared by content here). */
function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index])
}

/** One repaint that must not compose a key (the fast path). */
function assertReused(block: ItemBlock, width: number, label: string): void {
  const first = block.render(width)
  const before = cacheKeyBuilds()
  const second = block.render(width)
  assert.equal(second, first, `${label}: the exact lines array is reused`)
  assert.equal(cacheKeyBuilds(), before, `${label}: an unchanged repaint composes no key`)
}

// ---------------------------------------------------------------------------
// Fast path: unchanged repaint reuses the cached lines

test('every stable block reuses its exact lines array on an unchanged repaint', () => {
  clearToolExpansion()
  clearThinkingExpansion()
  const views: Array<[string, ItemBlock]> = [
    ['user', createItemBlock(userItem('u1', 'hello there, human turn'), flags())],
    ['assistant', createItemBlock(assistantItem('a1', '## Heading\n\nthe answer body'), flags())],
    ['tool', createItemBlock(toolItem('c1'), flags())],
  ]
  for (const [label, block] of views) {
    resetCacheKeyBuilds()
    const first = block.render(70)
    assert.equal(cacheKeyBuilds(), 1, `${label}: the first paint composes exactly one key`)
    assertReused(block, 70, label)
    assertReused(block, 70, label)
    assert.ok(first.length > 0, `${label}: the block paints something`)
  }
})

test('a settled attempt reuses its frame until its version changes', () => {
  const item = {
    kind: 'attempt' as const,
    id: 'live:attempt',
    attemptId: 'at-1',
    revision: 1,
    turn: 1,
    step: 1,
    text: 'streaming preview text',
    thinking: '',
    toolNames: [] as string[],
    status: 'abandoned' as const,
    tentative: true,
    version: 1,
  }
  const block = createItemBlock(item, flags())
  resetCacheKeyBuilds()
  const first = block.render(70)
  assert.equal(cacheKeyBuilds(), 1)
  assertReused(block, 70, 'abandoned attempt')
  block.update({ ...item, text: 'streaming preview text edited', version: 2 })
  const second = block.render(70)
  assert.equal(cacheKeyBuilds(), 2, 'a new version composes one new key')
  assert.notEqual(second, first, 'a new version repaints')
})

// ---------------------------------------------------------------------------
// Every key input invalidates exactly once

test('width, cwd, invalidation and version are the only other repaint triggers', () => {
  const block = createItemBlock(toolItem('c1'), flags()) as ItemBlock & { setCwd?: (cwd: string) => void }
  resetCacheKeyBuilds()
  block.render(70)
  assert.equal(cacheKeyBuilds(), 1)

  // A resize re-flows every row.
  assert.notEqual(block.render(40), undefined)
  assert.equal(cacheKeyBuilds(), 2, 'a width change composes one key')

  // The session cwd changes how a path is displayed.
  block.setCwd?.('/tmp/other-project')
  block.render(40)
  assert.equal(cacheKeyBuilds(), 3, 'a cwd change composes one key')

  // An explicit invalidation (settings/theme/reload) always repaints.
  block.invalidate()
  block.render(40)
  assert.equal(cacheKeyBuilds(), 4, 'invalidate() composes one key')
  // ...and the fast path is back afterwards.
  assertReused(block, 40, 'after invalidate')
})

test('hover invalidates the block that paints it and reverts on exit', () => {
  const item = toolItem('c1', { resultText: 'ok' })
  const block = createItemBlock(item, flags()) as ItemBlock & {
    hitboxes?: () => readonly { id: string; onHover?: (entering: boolean) => void }[]
  }
  clearToolExpansion()
  resetCacheKeyBuilds()
  const rest = block.render(70)
  const hoverable = (block.hitboxes?.() ?? []).filter(box => typeof box.onHover === 'function')
  assert.ok(hoverable.length > 0, 'a tool card declares at least one hover target')

  // Every real hover transition is a key-input change, so every one of them
  // composes exactly one key (none of them can be fast-pathed) and the paint it
  // produces differs from the neutral one for at least one target.
  let changedBy: string | undefined
  let expected = cacheKeyBuilds()
  for (const box of hoverable) {
    box.onHover?.(true)
    expected += 1
    const hovered = block.render(70)
    assert.equal(cacheKeyBuilds(), expected, `${box.id}: entering composes exactly one key`)
    if (changedBy === undefined && !sameLines(hovered, rest)) changedBy = box.id
    box.onHover?.(false)
    expected += 1
    const back = block.render(70)
    assert.equal(cacheKeyBuilds(), expected, `${box.id}: leaving composes exactly one key`)
    assert.ok(sameLines(back, rest), `${box.id}: the neutral paint is restored`)
  }
  assert.notEqual(changedBy, undefined, 'hovering a control does change what is painted')
  assertReused(block, 70, 'after every hover left')
})

test('reasoning hover and expansion invalidate the owning block', () => {
  clearThinkingExpansion()
  const longThought = Array.from({ length: 12 }, (_, index) => `reasoning line ${index} about the diff`).join('\n')
  const item = assistantItem('a1', 'the answer', {
    thinking: longThought,
    thinkingRuns: [{ text: longThought, durationMs: 4_000 }],
  })
  const block = createItemBlock(item, flags())
  resetCacheKeyBuilds()
  const collapsed = block.render(70)
  assert.equal(cacheKeyBuilds(), 1)

  // Hovering the summary row is a hover-state change of the reasoning child: the
  // owner's key must be dropped or the hint would never paint.
  const before = cacheKeyBuilds()
  block.handleMouse?.({ type: 'move', button: 'none', x: 2, y: 0, screenX: 2, screenY: 0, width: 70, height: 40, shift: false, alt: false, ctrl: false })
  block.render(70)
  assert.equal(cacheKeyBuilds(), before + 1, 'hovering the reasoning summary repaints the owner')

  // A click on the summary flips the disclosure: the frame grows.
  const beforeClick = cacheKeyBuilds()
  const press = { type: 'press' as const, button: 'left' as const, x: 2, y: 0, screenX: 2, screenY: 0, width: 70, height: 40, shift: false, alt: false, ctrl: false }
  block.handleMouse?.(press)
  // pi-tui synthesizes the click on release; the registry consumes `click`.
  block.handleMouse?.({ ...press, type: 'click' })
  const expanded = block.render(70)
  assert.equal(cacheKeyBuilds(), beforeClick + 1, 'expanding composes exactly one key')
  assert.notDeepEqual(expanded, collapsed, 'expanding repaints the reasoning section')
  assert.ok(expanded.length > collapsed.length, 'the expanded reasoning body is painted')
  assertReused(block, 70, 'expanded reasoning')
})

// ---------------------------------------------------------------------------
// Clocked blocks: live text keeps advancing, settled blocks reuse

test('a running tool card keeps its duration advancing', () => {
  let clock = 1_000
  const running = toolItem('c1', { status: 'running', startedAt: 1_000, resultText: '' })
  const block = createItemBlock(running, flags({ now: () => clock }))
  resetCacheKeyBuilds()
  const first = block.render(70)
  assert.equal(cacheKeyBuilds(), 1)
  // Clocked: the key is recomposed even though nothing else changed...
  const second = block.render(70)
  assert.equal(cacheKeyBuilds(), 2, 'a running card is never fast-pathed')
  assert.deepEqual(second, first, 'the same second paints the same rows')

  // ...so a later clock reading is picked up without any version bump.
  clock = 4_000
  const later = block.render(70)
  assert.notDeepEqual(later, first, 'the live duration advanced')
  assert.ok(later.some(line => /[34](\.\d)?s/.test(line)), 'the painted duration reflects the clock')
})

test('a settled tool card returns to the fast path', () => {
  let clock = 1_000
  const running = toolItem('c1', { status: 'running', startedAt: 1_000, resultText: '' })
  const block = createItemBlock(running, flags({ now: () => clock }))
  block.render(70)
  clock = 2_000
  block.update({ ...running, status: 'done', durationMs: 1_000, settledAt: 2_000, version: 2 })
  const settled = block.render(70)
  assert.ok(settled.length > 0)
  assertReused(block, 70, 'settled tool card')
})

test('a live reasoning run keeps advancing and then reuses once settled', () => {
  let clock = 10_000
  const live = assistantItem('a1', 'answer', {
    thinking: 'thinking about it',
    thinkingRuns: [{ text: 'thinking about it', startedAt: 8_000 }],
  })
  const block = createItemBlock(live, flags({ now: () => clock }))
  resetCacheKeyBuilds()
  block.render(70)
  clock = 11_000
  block.render(70)
  assert.equal(cacheKeyBuilds(), 2, 'a live run composes a key on every paint')

  block.update(assistantItem('a1', 'answer', {
    thinking: 'thinking about it',
    thinkingRuns: [{ text: 'thinking about it', durationMs: 3_000 }],
    version: 2,
  }))
  block.render(70)
  assertReused(block, 70, 'settled reasoning run')
})

// ---------------------------------------------------------------------------
// Transcript-level audit: disclosure, catalog, session, hover

const ev = (type: string, seq: number, data: unknown, extra: Partial<SessionEvent> = {}): SessionEvent => ({
  type,
  seq,
  time: 0,
  data,
  ...extra,
})

const userEvent = (seq: number, text: string): SessionEvent =>
  ev('user/message', seq, { id: `u${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: 'append' })

const callEvent = (seq: number, callId: string): SessionEvent =>
  ev('tool/call', seq, { turn: 1, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) })

const resultEvent = (seq: number, callId: string): SessionEvent =>
  ev('tool/result', seq, {
    turn: 1,
    step: 1,
    message: { id: `tr-${callId}`, role: 'tool', toolCallId: callId, content: [{ type: 'text', text: 'ok' }], isError: false, source: { kind: 'tool', callId } },
  }, { surfaceOp: 'append' })

const info = (events: SessionEvent[] = [], subagents?: SubagentSnapshot): SessionInfo => ({
  sessionId: 's1',
  cwd: '/tmp/work',
  provider: 'demo',
  model: 'demo',
  capabilities: [],
  events,
  ...(subagents === undefined ? {} : { subagents }),
})

const entry = (overrides: Partial<SubagentEntry> = {}): SubagentEntry => ({
  id: 'child-1',
  parentSessionId: 's1',
  mode: 'one-shot',
  status: 'running',
  label: 'Alpha',
  catalogSeq: 2,
  ...overrides,
})

const view = (store: TranscriptStore): TranscriptView =>
  new TranscriptView(store, {
    showThinking: true,
    expandTools: false,
    groupTools: true,
    hints: {},
    screen: 'fullscreen',
  })

test('an unchanged transcript frame composes no key at all', () => {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info([userEvent(1, 'run the tests'), callEvent(2, 'c1'), resultEvent(3, 'c1')]))
  const transcript = view(store)
  resetCacheKeyBuilds()
  const first = transcript.render(70)
  assert.ok(cacheKeyBuilds() > 0, 'the first frame paints the blocks')
  const builds = cacheKeyBuilds()
  const second = transcript.render(70)
  assert.equal(cacheKeyBuilds(), builds, 'a repeated frame composes no key')
  assert.deepEqual(second, first, 'the frame is byte-identical')
  assert.deepEqual(transcript.rowSpans, transcript.rowSpans, 'row spans are stable')
  // A spinner tick, a keystroke repaint or a hover-free frame all land here.
  transcript.render(70)
  assert.equal(cacheKeyBuilds(), builds)
})

test('one tool disclosure repaint invalidates the cards, not the projection', () => {
  clearToolExpansion()
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info([userEvent(1, 'run it'), callEvent(2, 'c1'), resultEvent(3, 'c1')]))
  const transcript = view(store)
  transcript.render(70)
  const projectionBuilds = transcript.projectionBuilds
  const builds = cacheKeyBuilds()
  transcript.toggleToolsExpanded()
  const expanded = transcript.render(70)
  // Disclosure is not a projection input: the three plan folds are reused, only
  // the cards repaint.
  assert.equal(transcript.projectionBuilds, projectionBuilds, 'the disclosure flip does not re-project')
  assert.ok(cacheKeyBuilds() > builds, 'every cached card drops its key')
  assert.ok(expanded.length > 0)
})

test('a single-expand click closes the other cards and repaints them', () => {
  clearToolExpansion()
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info([
    userEvent(1, 'run both'),
    callEvent(2, 'c1'), resultEvent(3, 'c1'),
    callEvent(4, 'c2'), resultEvent(5, 'c2'),
  ]))
  // Ungrouped: two standalone cards, so the click reaches a card disclosure
  // rather than a group header.
  const transcript = new TranscriptView(store, {
    showThinking: true, expandTools: false, groupTools: false, hints: {}, screen: 'fullscreen',
  })
  transcript.render(70)
  // Everything is closed by default; open the *other* card first so the click
  // below has a disclosure to close (mouse single-expand).
  setToolExpanded(toolExpansionKey('c2'), true)
  transcript.invalidate()
  transcript.render(70)
  assert.equal(isToolExpanded(toolExpansionKey('c2'), false), true, 'the second card starts open')
  const before = cacheKeyBuilds()
  // Mouse single-expand: opening c1 closes c2, so both cards' keys change.
  const target = transcript.rowSpans.find(span => span.itemId === 'tool:c1')
  assert.ok(target !== undefined, 'the first card has a row span')
  const press = {
    type: 'press' as const, button: 'left' as const, x: 4, y: target.startRow,
    screenX: 4, screenY: target.startRow, width: 70, height: 40, shift: false, alt: false, ctrl: false,
  }
  transcript.handleMouse(press)
  transcript.handleMouse({ ...press, type: 'click' })
  transcript.render(70)
  assert.ok(cacheKeyBuilds() > before, 'the disclosure request invalidates before the repaint')
  assert.equal(isToolExpanded(toolExpansionKey('c1'), false), true, 'the clicked card is open')
  assert.equal(isToolExpanded(toolExpansionKey('c2'), false), false, 'the other card was closed')
  clearToolExpansion()
})

test('the child catalog is a cache input: a change invalidates, a replay does not', () => {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info([userEvent(1, 'spawn a child'), userEvent(3, 'next')], { entries: [entry()] }))
  const transcript = view(store)
  transcript.render(70)

  // Re-delivering the identical catalog is not a change: the rows keep their
  // cache (the projection reuses unchanged entry objects on purpose).
  const builds = cacheKeyBuilds()
  store.handle({ type: 'subagents', sessionId: 's1', value: { entries: [entry()] } } as never)
  const replay = transcript.render(70)
  assert.equal(cacheKeyBuilds(), builds, 'an identical catalog replay composes no key')

  // A changed label is a new entry object: the row must repaint.
  store.handle({ type: 'subagents', sessionId: 's1', value: { entries: [entry({ label: 'Renamed child' })] } } as never)
  const renamed = transcript.render(70)
  assert.ok(cacheKeyBuilds() > builds, 'a changed catalog invalidates the rows')
  assert.notDeepEqual(renamed, replay, 'the painted child label changed')
})

test('a pointer hover keeps its owner and survives an unchanged repaint', () => {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info([userEvent(1, 'run the tests'), callEvent(2, 'c1'), resultEvent(3, 'c1')]))
  const transcript = view(store)
  const lines = transcript.render(70)
  assert.ok(lines.length > 0)
  // The tool card's title row is inside the block that covers the last rows.
  const span = transcript.rowSpans.at(-1)
  assert.ok(span !== undefined)
  transcript.handleMouse({
    type: 'move', button: 'none', x: 4, y: span.startRow, screenX: 4, screenY: span.startRow,
    width: 70, height: 40, shift: false, alt: false, ctrl: false,
  })
  const owner = transcript.hoverOwnerItemId
  assert.notEqual(owner, undefined, 'the pointer owns a block after the move')
  // The hover is a real paint change, so this repaint composes exactly the
  // hovered block's key once; from then on the frame is stable again.
  const beforeHoverPaint = cacheKeyBuilds()
  const hoveredFrame = transcript.render(70)
  assert.equal(cacheKeyBuilds(), beforeHoverPaint + 1, 'the hover repaint composes one key')
  const builds = cacheKeyBuilds()
  const again = transcript.render(70)
  assert.deepEqual(again, hoveredFrame, 'an unchanged repaint returns the same frame')
  assert.equal(transcript.hoverOwnerItemId, owner, 'the hover owner is unchanged')
  assert.equal(cacheKeyBuilds(), builds, 'and no further key is composed')
})

test('a session switch drops every cached block', () => {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info([userEvent(1, 'first session')]))
  const transcript = view(store)
  transcript.render(70)
  assert.equal(transcript.cachedItemCount, 1)

  store.reset({ ...info([userEvent(1, 'second session')]), sessionId: 's2' })
  resetCacheKeyBuilds()
  const lines = transcript.render(70)
  assert.ok(lines.some(line => line.includes('second session')), 'the new session paints')
  assert.equal(transcript.cachedItemCount, 1, 'the previous session blocks are dropped')
  assert.ok(cacheKeyBuilds() >= 1, 'the new session repaints')
})

test('the reasoning expansion helper still shows the live key handoff', () => {
  clearThinkingExpansion()
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info([userEvent(1, 'think'), ev('assistant/attempt', 2, {
    turn: 1, step: 1,
    message: { id: 'at-1', role: 'assistant', content: [{ type: 'reasoning', text: 'weighing options' }, { type: 'text', text: 'answer' }] },
  })], undefined))
  const transcript = view(store)
  transcript.render(70)
  // Expanding the latest run is a key input of the attempt block.
  setThinkingExpanded(thinkingExpansionKey('live:at-1', 0), true)
  const builds = cacheKeyBuilds()
  transcript.invalidate()
  transcript.render(70)
  assert.ok(cacheKeyBuilds() > builds)
  setThinkingExpanded(thinkingExpansionKey('live:at-1', 0), false)
})