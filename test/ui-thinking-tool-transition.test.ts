// Must stay the FIRST import: forces truecolor before any src module snapshots
// terminal color mode.
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences } from '#pi-tui'
import { imageFixture } from './helpers/images.ts'
import type { BackendEvent, SessionEvent, SessionInfo } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import { createItemBlock, type ItemBlock, type TranscriptViewOptions } from '../src/ui/blocks.ts'
import {
  clearThinkingExpansion,
  isThinkingExpanded,
  setThinkingExpanded,
  thinkingExpansionKey,
} from '../src/ui/thinking-block.ts'
import { TranscriptView } from '../src/ui/transcript.ts'

const info = (): SessionInfo => ({
  sessionId: 's1', cwd: '/tmp/work', provider: 'demo', model: 'demo', capabilities: [], events: [],
})

const ev = (type: string, seq: number, data: unknown, time = 0): SessionEvent => ({
  type, seq, time, data, surfaceOp: 'append',
})

const LONG_LINES = 1_400
const LONG_THOUGHT = Array.from({ length: LONG_LINES }, (_, index) =>
  `reasoning line ${index + 1} keeps the full native thought explicitly visible`).join('\n')

const plain = (lines: readonly string[]): string[] => lines.map(line => stripTerminalSequences(line))

interface Clock { value: number }

function storeOf(clock: Clock): TranscriptStore {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC, now: () => clock.value })
  store.reset(info())
  return store
}

function viewOf(store: TranscriptStore, clock: Clock, screen: 'inline' | 'fullscreen', groupTools = true): TranscriptView {
  return new TranscriptView(store, {
    showThinking: true,
    expandTools: false,
    thinkingPreviewLines: 3,
    screen,
    groupTools,
    thinkingLiveTimerMs: 0,
    hints: { thinking: 'ctrl+g' },
    now: () => clock.value,
  })
}

function send(store: TranscriptStore, event: BackendEvent): void {
  store.handle(event)
}

function chunk(store: TranscriptStore, revision: number, index: number, body: Record<string, unknown>, attemptId = 'att'): void {
  send(store, { type: 'stream_chunk', sessionId: 's1', attemptId, revision, index, chunk: body })
}

function start(store: TranscriptStore, attemptId = 'att', revision = 1): void {
  send(store, { type: 'stream_start', sessionId: 's1', attemptId, revision, turn: 1, step: 1 })
}

function reasoning(store: TranscriptStore, text: string, revision = 2, index = 0): void {
  chunk(store, revision, index, { type: 'block-start', index: 0, blockType: 'reasoning' })
  chunk(store, revision + 1, index + 1, { type: 'reasoning-delta', index: 0, text })
  chunk(store, revision + 2, index + 2, { type: 'block-end', index: 0, block: { type: 'reasoning', text } })
}

function assistantMessage(seq: number, content: unknown[], time: number, interrupted = false): SessionEvent {
  return ev('assistant/message', seq, {
    turn: 1, step: 1, message: {
      id: `m${seq}`, role: 'assistant', content,
      source: { kind: 'model', provider: 'demo', model: 'demo' },
    }, stream: [], ...(interrupted ? { interrupted: true } : {}),
  }, time)
}

function toolCall(seq: number, id: string, name: string, time: number): SessionEvent {
  return ev('tool/call', seq, { turn: 1, step: 1, callId: id, name, arguments: '{"code":"print(1)"}' }, time)
}

function toolResult(seq: number, id: string, text: string, time: number): SessionEvent {
  return ev('tool/result', seq, {
    turn: 1, step: 1,
    message: {
      id: `r${seq}`, role: 'tool', toolCallId: id,
      source: { kind: 'tool', callId: id },
      content: [{ type: 'text', text }],
    },
  }, time)
}

function clickSummary(view: TranscriptView, row = 0): void {
  const event = {
    type: 'click' as const, button: 'left' as const, x: 3, y: row,
    screenX: 3, screenY: row, width: 80, height: 40, shift: false, alt: false, ctrl: false,
  }
  const result = view.handleMouse(event)
  assert.equal(result?.handled, true, 'the reasoning summary is clickable')
}

function expandLive(view: TranscriptView, store: TranscriptStore): string {
  // The view clears module expansion on the first session render; render once
  // so the click below operates on the same conversation frame a user sees.
  view.render(80)
  const live = store.items[0]
  assert.equal(live?.kind, 'attempt')
  if (live?.kind !== 'attempt') throw new Error('missing live attempt')
  clickSummary(view)
  assert.equal(isThinkingExpanded(thinkingExpansionKey(live.id, 0)), true, 'the live run is expanded')
  return live.id
}

/**
 * First `count` rendered reasoning body rows. Live text, an assistant reply and
 * a settled attempt all put their own heading/label above the same indented
 * body, so the body rows are located by their paint, not by a fixed offset.
 */
function thinkingRows(lines: readonly string[], count: number): string[] {
  const rows = plain(lines)
  const start = rows.findIndex(row => row.startsWith('  '))
  return start < 0 ? [] : rows.slice(start, start + count)
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`thinking -> tool handoff ${screen}: 1400-line expanded body survives native assistant settlement`, () => {
    clearThinkingExpansion()
    const clock: Clock = { value: 1_000 }
    const store = storeOf(clock)
    const view = viewOf(store, clock, screen)
    send(store, { type: 'session_event', sessionId: 's1', event: ev('step/start', 1, { turn: 1, step: 1 }, 1_000) })
    start(store)
    reasoning(store, LONG_THOUGHT)
    const liveId = expandLive(view, store)
    clock.value = 6_000
    chunk(store, 10, 3, { type: 'block-start', index: 1, blockType: 'tool-call' })
    chunk(store, 11, 4, { type: 'tool-call-delta', index: 1, id: 'c1', name: 'run_code', argumentsDelta: '{"code":' })
    const live = plain(view.render(80))
    assert.equal(live.length, 1 + LONG_LINES + 1, 'heading + every expanded row + the transient requested row')
    assert.equal(live[LONG_LINES + 1], '  ⎿  requested: run_code')

    // Native DSH appends the durable settlement BEFORE the committed stream_end.
    clock.value = 6_500
    send(store, { type: 'session_event', sessionId: 's1', event: assistantMessage(10, [
      { type: 'reasoning', text: LONG_THOUGHT },
      { type: 'tool-call', id: 'c1', name: 'run_code', arguments: '{"code":"print(1)"}' },
    ], 6_500) })
    const settled = store.items
    assert.deepEqual(settled.map(item => item.kind), ['assistant', 'tool'], 'one durable reply and one proposed call')
    const assistant = settled[0]!
    assert.equal(assistant.kind, 'assistant')
    if (assistant.kind !== 'assistant') return
    assert.equal(assistant.id, 'assistant:10', 'native durable id is preserved')
    assert.equal(assistant.seq, 10)
    assert.equal(assistant.thinkingKey, liveId, 'only the UI handoff identity is carried over')
    const durable = plain(view.render(80))
    assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:10', 0)), true, 'expanded reasoning does not collapse')
    assert.equal(isThinkingExpanded(thinkingExpansionKey(liveId, 0)), false, 'the tentative key is not kept alive')
    const tool = settled[1]!
    assert.equal(tool.kind, 'tool')
    if (tool.kind !== 'tool') return
    assert.equal(tool.id, 'tool:c1')
    assert.equal(tool.seq, 10)
    assert.equal(tool.status, 'proposed')

    assert.deepEqual(thinkingRows(durable, LONG_LINES), thinkingRows(live, LONG_LINES), 'the displayed thinking body and hidden-line geometry are identical')
    assert.equal(durable.length, 1 + LONG_LINES + 3, 'only the blank separation + real tool card are added')
    assert.equal(durable[LONG_LINES + 1], '')
    assert.equal(durable.some(line => line.includes('requested: run_code')), false, 'the transient requested row is gone, not duplicated')
    assert.equal(durable.filter(line => line.includes('Run Code')).length, 1, 'exactly one tool row')
    assert.ok(durable.every(line => !line.includes('more lines')), 'nothing was re-collapsed or re-counted')

    // Late committed end is bookkeeping only.
    send(store, { type: 'stream_end', sessionId: 's1', attemptId: 'att', revision: 12, outcome: 'committed', seq: 10 })
    assert.deepEqual(store.items.map(item => item.id), ['assistant:10', 'tool:c1'])
    assert.deepEqual(plain(view.render(80)), durable)

    // Native admission/result change status in place; identity and body stay.
    send(store, { type: 'session_event', sessionId: 's1', event: toolCall(11, 'c1', 'run_code', 6_600) })
    send(store, { type: 'session_event', sessionId: 's1', event: toolResult(12, 'c1', 'done', 6_700) })
    const toolFinal = store.items.find(item => item.kind === 'tool')
    assert.equal(toolFinal?.kind, 'tool')
    if (toolFinal?.kind !== 'tool') return
    assert.equal(toolFinal.id, 'tool:c1')
    assert.equal(toolFinal.callSeq, 11)
    assert.equal(toolFinal.resultSeq, 12)
    assert.equal(toolFinal.status, 'done')
    assert.equal(store.items.filter(item => item.kind === 'tool').length, 1, 'no duplicate call rows')
    assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:10', 0)), true)
    const final = plain(view.render(80))
    assert.deepEqual(thinkingRows(final, LONG_LINES), thinkingRows(live, LONG_LINES))
    clearThinkingExpansion()
  })
}

test('partial tool start/name/arguments never fabricate a requested row, and settlement adds the one real card', () => {
  clearThinkingExpansion()
  const clock: Clock = { value: 1_000 }
  const store = storeOf(clock)
  const view = viewOf(store, clock, 'inline')
  start(store)
  reasoning(store, 'short but real reasoning')
  chunk(store, 5, 3, { type: 'block-start', index: 1, blockType: 'tool-call' })
  chunk(store, 6, 4, { type: 'tool-call-delta', index: 1, id: 'c1', argumentsDelta: '{"code":' })
  const live = store.items[0]
  assert.equal(live?.kind, 'attempt')
  if (live?.kind !== 'attempt') return
  assert.deepEqual(live.toolNames, [], 'a name-less partial call is not named')
  const partial = plain(view.render(80)).join('\n')
  assert.doesNotMatch(partial, /requested:/)
  chunk(store, 7, 5, { type: 'tool-call-delta', index: 1, id: 'c1', name: 'run_code', argumentsDelta: '"print(1)"}' })
  const named = plain(view.render(80)).join('\n')
  assert.equal(named.match(/requested: run_code/g)?.length, 1)

  send(store, { type: 'session_event', sessionId: 's1', event: assistantMessage(10, [
    { type: 'reasoning', text: 'short but real reasoning' },
    { type: 'tool-call', id: 'c1', name: 'run_code', arguments: '{"code":"print(1)"}' },
  ], 1_500) })
  const text = plain(view.render(80)).join('\n')
  assert.doesNotMatch(text, /requested:/)
  assert.equal(text.match(/Run Code/g)?.length, 1)
  assert.equal(store.items.filter(item => item.kind === 'tool').length, 1)
  clearThinkingExpansion()
})

test('retry settlement carries expansion, keeps the native attempt id, and a new attempt is a separate row', () => {
  clearThinkingExpansion()
  const clock: Clock = { value: 1_000 }
  const store = storeOf(clock)
  const view = viewOf(store, clock, 'inline')
  send(store, { type: 'session_event', sessionId: 's1', event: ev('step/start', 1, { turn: 1, step: 1 }, 1_000) })
  start(store)
  reasoning(store, LONG_THOUGHT)
  const liveId = expandLive(view, store)
  const liveBody = thinkingRows(view.render(80), LONG_LINES)
  clock.value = 3_000
  send(store, { type: 'session_event', sessionId: 's1', event: ev('assistant/attempt', 5, {
    turn: 1, step: 1,
    stream: [
      { type: 'reasoning-chunks', time0: 1_000, index: 0, dt: [0, 2_000], texts: [LONG_THOUGHT] },
      { type: 'text-chunks', time0: 3_000, index: 1, dt: [0], texts: ['partial answer'] },
    ],
  }, 3_000) })
  const retried = store.items[0]
  assert.equal(retried?.kind, 'attempt')
  if (retried?.kind !== 'attempt') return
  assert.equal(retried.id, 'attempt:5', 'native durable attempt id')
  assert.equal(retried.seq, 5)
  assert.equal(retried.status, 'abandoned')
  assert.equal(retried.thinkingKey, liveId)
  const retriedBody = thinkingRows(view.render(80), LONG_LINES)
  assert.equal(isThinkingExpanded(thinkingExpansionKey('attempt:5', 0)), true)
  assert.deepEqual(retriedBody, liveBody, 'the body did not change at settlement')

  start(store, 'att-retry', 20)
  reasoning(store, 'second attempt reasoning', 21)
  assert.deepEqual(store.items.map(item => item.kind), ['attempt', 'attempt'])
  assert.equal(store.items[0]?.id, 'attempt:5', 'retry never rewrites the settled attempt')
  assert.equal(store.items[1]?.id, 'live:s1:att-retry:20')
  assert.equal(store.items[1]?.kind === 'attempt' && store.items[1].thinkingKey, undefined)
  clearThinkingExpansion()
})

test('abandoned stream, closed connection and cancelled reply preserve disclosure and native outcome', () => {
  clearThinkingExpansion()
  const clock: Clock = { value: 1_000 }
  const abandonedStore = storeOf(clock)
  const abandonedView = viewOf(abandonedStore, clock, 'inline')
  start(abandonedStore)
  reasoning(abandonedStore, 'abandoned reasoning body')
  const abandonedLive = expandLive(abandonedView, abandonedStore)
  const abandonedBody = thinkingRows(abandonedView.render(80), 1)
  send(abandonedStore, { type: 'stream_end', sessionId: 's1', attemptId: 'att', revision: 9, outcome: 'abandoned' })
  const abandoned = abandonedStore.items[0]
  assert.equal(abandoned?.kind, 'attempt')
  if (abandoned?.kind !== 'attempt') return
  assert.equal(abandoned.id, 'live:s1:att:1:abandoned')
  assert.equal(abandoned.status, 'abandoned')
  assert.equal(abandoned.thinkingKey, abandonedLive)
  const abandonedRendered = thinkingRows(abandonedView.render(80), 1)
  assert.equal(isThinkingExpanded(thinkingExpansionKey(abandoned.id, 0)), true)
  assert.deepEqual(abandonedRendered, abandonedBody)
  assert.match(plain(abandonedView.render(80))[0] ?? '', /Incomplete response/)

  const closedStore = storeOf({ value: 2_000 })
  const closedView = viewOf(closedStore, { value: 2_000 }, 'inline')
  start(closedStore)
  reasoning(closedStore, 'unknown reasoning body')
  const closedLive = expandLive(closedView, closedStore)
  // Deliberately abrupt: a durable admission can arrive while the tentative
  // stream is still on screen; a later disconnect must not invent success.
  send(closedStore, { type: 'session_event', sessionId: 's1', event: ev('tool/call', 3, {
    turn: 1, step: 1, callId: 'pending', name: 'bash', arguments: '{}',
  }, 2_100) })
  send(closedStore, { type: 'closed', code: 1 })
  const unknown = closedStore.items.find(item => item.kind === 'attempt')
  assert.equal(unknown?.kind, 'attempt')
  if (unknown?.kind !== 'attempt') return
  assert.equal(unknown.id, 'live:s1:att:1:unknown')
  assert.equal(unknown.status, 'unknown')
  assert.equal(unknown.thinkingKey, closedLive)
  const unknownRendered = plain(closedView.render(80))
  assert.equal(isThinkingExpanded(thinkingExpansionKey(unknown.id, 0)), true)
  assert.match(unknownRendered.join('\n'), /Response result unknown/)
  const pending = closedStore.items.find(item => item.kind === 'tool')
  assert.equal(pending?.kind, 'tool')
  if (pending?.kind !== 'tool') return
  assert.equal(pending.status, 'unknown', 'never a fabricated success')

  clearThinkingExpansion()
  const cancelledStore = storeOf({ value: 3_000 })
  const cancelledView = viewOf(cancelledStore, { value: 3_000 }, 'fullscreen')
  send(cancelledStore, { type: 'session_event', sessionId: 's1', event: ev('step/start', 1, { turn: 1, step: 1 }, 3_000) })
  start(cancelledStore)
  reasoning(cancelledStore, 'cancelled reasoning body')
  const cancelledLive = expandLive(cancelledView, cancelledStore)
  const cancelledBody = thinkingRows(cancelledView.render(80), 1)
  send(cancelledStore, { type: 'session_event', sessionId: 's1', event: assistantMessage(4, [
    { type: 'reasoning', text: 'cancelled reasoning body' },
    { type: 'text', text: 'partial' },
  ], 3_500, true) })
  send(cancelledStore, { type: 'session_event', sessionId: 's1', event: ev('turn/end', 5, {
    turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } },
  }, 3_600) })
  const cancelled = cancelledStore.items.find(item => item.kind === 'assistant')
  assert.equal(cancelled?.kind, 'assistant')
  if (cancelled?.kind !== 'assistant') return
  assert.equal(cancelled.id, 'assistant:4')
  assert.equal(cancelled.thinkingKey, cancelledLive)
  assert.equal(cancelled.interrupted, true)
  assert.equal(cancelled.interruptCause, 'user')
  const cancelledRendered = plain(cancelledView.render(80))
  assert.equal(isThinkingExpanded(thinkingExpansionKey('assistant:4', 0)), true)
  assert.deepEqual(thinkingRows(cancelledRendered, 1), cancelledBody)
  assert.match(cancelledRendered.join('\n'), /Interrupted by user/)
  assert.equal(cancelledStore.items.some(item => item.kind === 'tool'), false)
  clearThinkingExpansion()
})

test('showThinking=false keeps the hidden placeholder layout and leaks no reasoning across the handoff', () => {
  clearThinkingExpansion()
  const clock: Clock = { value: 1_000 }
  const store = storeOf(clock)
  const view = new TranscriptView(store, {
    showThinking: false, expandTools: false, thinkingPreviewLines: 3, screen: 'inline', groupTools: false,
    thinkingLiveTimerMs: 0, now: () => clock.value,
  })
  start(store)
  reasoning(store, LONG_THOUGHT)
  chunk(store, 6, 3, { type: 'text-delta', index: 1, text: 'answer text' })
  const live = plain(view.render(80))
  assert.equal(live.join('\n').includes('reasoning line 1 '), false)
  assert.match(live.join('\n'), /Thought \(hidden\)/)
  send(store, { type: 'session_event', sessionId: 's1', event: assistantMessage(10, [
    { type: 'reasoning', text: LONG_THOUGHT },
    { type: 'text', text: 'answer text' },
    { type: 'tool-call', id: 'c1', name: 'run_code', arguments: '{}' },
  ], 1_500) })
  const settled = plain(view.render(80))
  assert.deepEqual(settled.slice(0, live.length), live, 'hidden reasoning does not change the visible layout')
  assert.equal(settled.join('\n').includes(LONG_THOUGHT.split('\n')[0]!), false)
  assert.equal(settled.filter(line => line.includes('Run Code')).length, 1)
  clearThinkingExpansion()
})

test('multiple adjacent declared calls keep declaration order and native ids through admission/results', () => {
  clearThinkingExpansion()
  const clock: Clock = { value: 1_000 }
  const store = storeOf(clock)
  const view = viewOf(store, clock, 'inline', false)
  send(store, { type: 'session_event', sessionId: 's1', event: assistantMessage(10, [
    { type: 'reasoning', text: 'planning two calls' },
    { type: 'tool-call', id: 'a', name: 'run_code', arguments: '{"code":"a"}' },
    { type: 'tool-call', id: 'b', name: 'run_code', arguments: '{"code":"b"}' },
  ], 1_000) })
  assert.deepEqual(store.items.map(item => item.id), ['assistant:10', 'tool:a', 'tool:b'])
  // Admission/results may arrive out of order; the declared positions never move.
  send(store, { type: 'session_event', sessionId: 's1', event: toolCall(12, 'b', 'run_code', 1_100) })
  send(store, { type: 'session_event', sessionId: 's1', event: toolCall(11, 'a', 'run_code', 1_100) })
  send(store, { type: 'session_event', sessionId: 's1', event: toolResult(14, 'b', 'b done', 1_200) })
  send(store, { type: 'session_event', sessionId: 's1', event: toolResult(13, 'a', 'a done', 1_200) })
  assert.deepEqual(store.items.map(item => item.id), ['assistant:10', 'tool:a', 'tool:b'])
  const tools = store.items.filter(item => item.kind === 'tool')
  assert.deepEqual(tools.map(item => item.kind === 'tool' ? item.callSeq : undefined), [11, 12])
  assert.deepEqual(tools.map(item => item.kind === 'tool' ? item.resultSeq : undefined), [13, 14])
  assert.ok(tools.every(item => item.kind === 'tool' && item.status === 'done'))
  const text = plain(view.render(80)).join('\n')
  assert.equal(text.match(/Run Code/g)?.length, 2, 'one row per real call, declared order')
  clearThinkingExpansion()
})

test('AssistantBlock has one hover owner: moving into thinking clears a stale image-marker hover', async () => {
  const png = await imageFixture('image/png', 'thinking-hover.png')
  clearThinkingExpansion()
  const item = {
    kind: 'assistant' as const,
    id: 'assistant:9',
    seq: 9,
    text: '',
    thinking: 'a thought worth hovering',
    thinkingRuns: [{ text: 'a thought worth hovering' }],
    content: [{ type: 'image' as const, attachment: png.attachment }],
    imageCount: 1,
    interrupted: false,
    version: 1,
  }
  const flags: TranscriptViewOptions = {
    showThinking: true,
    expandTools: false,
    thinkingPreviewLines: 1,
    screen: 'fullscreen',
    hints: { thinking: 'ctrl+g' },
    imageDetailsHint: 'ctrl+i',
    onImageDetails: () => {},
    onRenderRequest: () => {},
  }
  const block: ItemBlock = createItemBlock(item, flags)
  const move = (x: number, y: number): void => {
    block.handleMouse?.({
      type: 'move', button: 'none', x, y, screenX: x, screenY: y,
      width: 80, height: 40, shift: false, alt: false, ctrl: false,
    })
  }
  const lines = (): string[] => block.render(80)
  const rest = lines()
  const markerRow = rest.findIndex(line => stripTerminalSequences(line).includes('[Image #1]'))
  assert.ok(markerRow > 0)
  const restingMarker = rest[markerRow]!
  move(2, markerRow)
  const hoveredMarker = lines()[markerRow]!
  assert.notEqual(hoveredMarker, restingMarker, 'the image marker paints its hover state')
  move(2, 0)
  assert.equal(lines()[markerRow], restingMarker, 'thinking consumes motion and the image hover retires')
  clearThinkingExpansion()
})
