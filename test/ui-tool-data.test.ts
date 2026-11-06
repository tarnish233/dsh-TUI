import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { BackendEvent, SessionEvent, SessionInfo } from '../src/backend/types.ts'
import { TranscriptStore, type ToolTranscriptItem } from '../src/state/transcript.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'

/**
 * Tool data projection: which durable facts become a card, with which real
 * timestamps, and which events are allowed to change them.
 *
 * The store consumes DSH's native codec; these offline tests use the demo's
 * fixture-only codec. Nothing here calls a model or a tool.
 */

const baseInfo = (events: SessionEvent[] = []): SessionInfo => ({
  sessionId: 'session-tool-data',
  cwd: '/tmp/tool-data',
  provider: 'demo',
  model: 'demo-model',
  capabilities: [],
  events,
})

const event = (type: string, seq: number, data: unknown, extra: Partial<SessionEvent> = {}): SessionEvent => ({
  type,
  seq,
  data,
  ...extra,
})

const callData = (callId: string, extra: Record<string, unknown> = {}) => ({
  turn: 1,
  step: 1,
  callId,
  name: 'bash',
  arguments: '{"command":"echo hi"}',
  ...extra,
})

const resultData = (
  callId: string,
  content: unknown[],
  extra: Record<string, unknown> = {},
  isError = false,
) => ({
  turn: 1,
  step: 1,
  message: {
    id: `result-${callId}`,
    role: 'tool',
    toolCallId: callId,
    content,
    isError,
    source: { kind: 'tool', callId },
  },
  ...extra,
})

const assistantProposal = (toolCalls: Array<{ id: string; name: string; arguments: string }>) => ({
  turn: 1,
  step: 1,
  message: {
    id: 'assistant-proposal',
    role: 'assistant',
    content: toolCalls.map(call => ({
      type: 'tool-call',
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    })),
    source: { kind: 'model', provider: 'demo', model: 'demo-model' },
  },
  stream: [],
})

function replay(events: SessionEvent[], now?: () => number): TranscriptStore {
  const store = new TranscriptStore({
    codec: DEMO_TRANSCRIPT_CODEC,
    ...(now === undefined ? {} : { now }),
  })
  store.reset(baseInfo(events))
  return store
}

function live(events: SessionEvent[], now?: () => number): TranscriptStore {
  const store = new TranscriptStore({
    codec: DEMO_TRANSCRIPT_CODEC,
    ...(now === undefined ? {} : { now }),
  })
  store.reset(baseInfo())
  const sessionId = baseInfo().sessionId
  for (const item of events) store.handle({ type: 'session_event', sessionId, event: item })
  return store
}

function feed(store: TranscriptStore, item: SessionEvent): void {
  store.handle({ type: 'session_event', sessionId: baseInfo().sessionId, event: item })
}

function toolItem(store: TranscriptStore, callId: string): ToolTranscriptItem {
  const item = store.items.find((entry): entry is ToolTranscriptItem => entry.kind === 'tool' && entry.callId === callId)
  assert.ok(item !== undefined, `tool ${callId} was not projected`)
  return item
}

/** Version is a render counter, not a durable fact: compare the data only. */
function stable(item: ToolTranscriptItem): Omit<ToolTranscriptItem, 'version'> {
  const { version: _version, ...rest } = item
  return rest
}

test('live and replayed tools share the real call→settlement duration', () => {
  const events = [
    event('tool/call', 4, callData('call-timing', { turn: 2, step: 3 }), { time: 1_000 }),
    event('tool/result', 9, resultData('call-timing', [{ type: 'text', text: 'settled' }], { turn: 2, step: 3 }), { time: 1_750 }),
  ]
  const replayed = toolItem(replay(events), 'call-timing')
  const lived = toolItem(live(events), 'call-timing')
  assert.deepEqual(stable(lived), stable(replayed), 'replay must not invent a different history')
  assert.equal(replayed.status, 'done')
  assert.equal(replayed.callSeq, 4)
  assert.equal(replayed.resultSeq, 9)
  assert.equal(replayed.turn, 2)
  assert.equal(replayed.step, 3)
  assert.equal(replayed.startedAt, 1_000)
  assert.equal(replayed.settledAt, 1_750)
  // Call -> settlement includes permission/policy waiting, like native toolMs;
  // it is not a pure body-execution measurement.
  assert.equal(replayed.durationMs, 750)
})

test('missing, zero-epoch and backward clocks follow the durable event times', () => {
  // A local clock exists, but durable tool timing must not fall back to it.
  const localClock = (): number => 9_999_999_999

  const missingStart = toolItem(live([
    event('tool/call', 1, callData('call-no-start')),
    event('tool/result', 2, resultData('call-no-start', [{ type: 'text', text: 'output' }]), { time: 5_000 }),
  ], localClock), 'call-no-start')
  assert.equal(missingStart.startedAt, undefined)
  assert.equal(missingStart.settledAt, 5_000)
  assert.equal(missingStart.durationMs, undefined, 'no Date.now() backfill for an unrecorded start')

  const missingEnd = toolItem(live([
    event('tool/call', 1, callData('call-no-end'), { time: 5_000 }),
    event('tool/result', 2, resultData('call-no-end', [{ type: 'text', text: 'output' }])),
  ], localClock), 'call-no-end')
  assert.equal(missingEnd.startedAt, 5_000)
  assert.equal(missingEnd.settledAt, undefined)
  assert.equal(missingEnd.durationMs, undefined, 'no settlement time means no duration')

  // DSH's public `SessionEvent.time` is epoch ms and epoch 0 is a real instant:
  // the projection must not invent a "0 = unrecorded" sentinel. A 0 -> 500
  // pairing is a real 500ms call-to-settlement window.
  const zeroToZero = toolItem(live([
    event('tool/call', 1, callData('call-zero-zero'), { time: 0 }),
    event('tool/result', 2, resultData('call-zero-zero', [{ type: 'text', text: 'output' }]), { time: 0 }),
  ], localClock), 'call-zero-zero')
  assert.equal(zeroToZero.startedAt, 0, 'epoch 0 is a real durable time')
  assert.equal(zeroToZero.settledAt, 0)
  assert.equal(zeroToZero.durationMs, 0)

  const zeroToLater = toolItem(live([
    event('tool/call', 1, callData('call-zero-later'), { time: 0 }),
    event('tool/result', 2, resultData('call-zero-later', [{ type: 'text', text: 'output' }]), { time: 500 }),
  ], localClock), 'call-zero-later')
  assert.equal(zeroToLater.startedAt, 0)
  assert.equal(zeroToLater.settledAt, 500)
  assert.equal(zeroToLater.durationMs, 500, '0 -> 500 is a real 500ms window')

  // Non-finite readings are not clock values: they stay unrecorded.
  const nonFinite = toolItem(live([
    event('tool/call', 1, callData('call-nan'), { time: Number.NaN }),
    event('tool/result', 2, resultData('call-nan', [{ type: 'text', text: 'output' }]), { time: Number.POSITIVE_INFINITY }),
  ], localClock), 'call-nan')
  assert.equal(nonFinite.startedAt, undefined)
  assert.equal(nonFinite.settledAt, undefined)
  assert.equal(nonFinite.durationMs, undefined)

  const backwards = toolItem(live([
    event('tool/call', 1, callData('call-backwards'), { time: 5_000 }),
    event('tool/result', 2, resultData('call-backwards', [{ type: 'text', text: 'output' }]), { time: 4_000 }),
  ], localClock), 'call-backwards')
  assert.equal(backwards.startedAt, 5_000, 'the recorded event times stay truthful')
  assert.equal(backwards.settledAt, 4_000)
  assert.equal(backwards.durationMs, 0, 'a clock that ran backwards clamps to zero, never negative')
})

test('a result that arrives before its call is completed by the late call without regressing', () => {
  const resultFirst = toolItem(live([
    event('tool/result', 20, resultData('call-late', [{ type: 'text', text: 'async result' }], { turn: 4, step: 5 }), { time: 2_000 }),
    event('tool/call', 15, callData('call-late', {
      name: 'read',
      arguments: '{"path":"src/a.ts"}',
      turn: 4,
      step: 5,
    }), { time: 1_500 }),
  ]), 'call-late')
  assert.equal(resultFirst.status, 'done', 'a late call never resets a settled outcome')
  assert.equal(resultFirst.name, 'read', 'the late call supplies the real tool identity')
  assert.equal(resultFirst.arguments, '{"path":"src/a.ts"}', 'and the real input')
  assert.equal(resultFirst.callSeq, 15)
  assert.equal(resultFirst.resultSeq, 20)
  assert.equal(resultFirst.startedAt, 1_500)
  assert.equal(resultFirst.settledAt, 2_000)
  assert.equal(resultFirst.durationMs, 500)
  assert.equal(resultFirst.turn, 4)
  assert.equal(resultFirst.step, 5)

  const errorFirst = toolItem(live([
    event('tool/result', 22, resultData('call-late-error', [{ type: 'text', text: 'denied' }], {
      error: { name: 'ReadError', code: 'E_DENIED' },
    }, true), { time: 3_000 }),
    event('tool/call', 18, callData('call-late-error', {
      name: 'read',
      arguments: '{"path":"secret.txt"}',
    }), { time: 2_000 }),
  ]), 'call-late-error')
  assert.equal(errorFirst.status, 'error', 'a late call never turns an error into done')
  assert.equal(errorFirst.name, 'read')
  assert.equal(errorFirst.durationMs, 1_000)

  // A replay window without the call keeps the identity missing and the timing
  // unmeasured instead of guessing from a presentation title.
  const orphan = toolItem(live([
    event('tool/result', 30, resultData('call-orphan', [{ type: 'text', text: 'window gap' }], { turn: 7, step: 8 }), { time: 4_000 }),
  ]), 'call-orphan')
  assert.equal(orphan.status, 'done')
  assert.equal(orphan.callSeq, undefined)
  assert.equal(orphan.resultSeq, 30)
  assert.equal(orphan.name, 'tool')
  assert.equal(orphan.arguments, '')
  assert.equal(orphan.startedAt, undefined)
  assert.equal(orphan.durationMs, undefined)
  assert.equal(orphan.turn, 7)
  assert.equal(orphan.step, 8)
})

test('duplicate and stale events never rewrite stable times, names or output', () => {
  const first = replay([
    event('tool/call', 1, callData('call-stable', { name: 'bash' }), { time: 1_000 }),
    event('tool/result', 2, resultData('call-stable', [{ type: 'text', text: 'original output' }]), { time: 2_000 }),
  ])
  const duplicated = replay([
    event('tool/call', 1, callData('call-stable', { name: 'bash' }), { time: 1_000 }),
    event('tool/result', 2, resultData('call-stable', [{ type: 'text', text: 'original output' }]), { time: 2_000 }),
    // Same callId again, later timestamps and different content: stale copies.
    event('tool/call', 3, callData('call-stable', {
      name: 'edit',
      arguments: '{"file_path":"other.ts"}',
    }), { time: 9_000 }),
    event('tool/result', 4, resultData('call-stable', [{ type: 'text', text: 'rewritten output' }]), { time: 3_000 }),
  ])
  assert.deepEqual(stable(toolItem(duplicated, 'call-stable')), stable(toolItem(first, 'call-stable')))

  const item = toolItem(duplicated, 'call-stable')
  assert.equal(item.name, 'bash', 'the first admitted call owns the identity')
  assert.equal(item.arguments, '{"command":"echo hi"}')
  assert.equal(item.callSeq, 1)
  assert.equal(item.resultSeq, 2)
  assert.equal(item.startedAt, 1_000)
  assert.equal(item.settledAt, 2_000)
  assert.equal(item.durationMs, 1_000)
  assert.equal(item.resultText, 'original output')
  assert.equal(item.status, 'done')

  // A real epoch-0 start is a durable time too: duplicates may not re-date it.
  const epochZero = toolItem(live([
    event('tool/call', 1, callData('call-zero-duplicate'), { time: 0 }),
    event('tool/result', 2, resultData('call-zero-duplicate', [{ type: 'text', text: 'zero start' }]), { time: 500 }),
    event('tool/call', 3, callData('call-zero-duplicate', { name: 'edit' }), { time: 90_000 }),
    event('tool/result', 4, resultData('call-zero-duplicate', [{ type: 'text', text: 'rewritten' }]), { time: 91_000 }),
  ]), 'call-zero-duplicate')
  assert.equal(epochZero.startedAt, 0, 'the duplicate cannot replace the real epoch-0 start')
  assert.equal(epochZero.settledAt, 500)
  assert.equal(epochZero.durationMs, 500)
  assert.equal(epochZero.resultText, 'zero start')
  assert.equal(epochZero.resultSeq, 2)

  // Feeding the same durable record twice through the live path is idempotent.
  const store = live([])
  const records = [
    event('tool/call', 1, callData('call-idempotent'), { time: 1_000 }),
    event('tool/call', 1, callData('call-idempotent'), { time: 1_000 }),
    event('tool/result', 2, resultData('call-idempotent', [{ type: 'text', text: 'once' }]), { time: 1_400 }),
    event('tool/result', 2, resultData('call-idempotent', [{ type: 'text', text: 'once' }]), { time: 1_400 }),
  ]
  for (const record of records) feed(store, record)
  const repeated = toolItem(store, 'call-idempotent')
  assert.equal(repeated.callSeq, 1, 'a repeated result cannot re-apply the settlement')
  assert.equal(repeated.resultSeq, 2)
  assert.equal(repeated.durationMs, 400)
  assert.equal(repeated.resultText, 'once')
  assert.equal(store.items.filter(entry => entry.kind === 'tool').length, 1)
})

test('turn and step come from the tool facts, not a default', () => {
  const store = replay([
    event('assistant/message', 1, assistantProposal([
      { id: 'call-turn', name: 'read', arguments: '{"path":"a.ts"}' },
    ]), { surfaceOp: 'append', time: 500 }),
    event('tool/call', 2, callData('call-turn', { turn: 3, step: 4 }), { time: 1_000 }),
    event('tool/result', 3, resultData('call-turn', [{ type: 'text', text: 'x' }], { turn: 3, step: 4 }), { time: 1_200 }),
  ])
  const item = toolItem(store, 'call-turn')
  assert.equal(item.turn, 3)
  assert.equal(item.step, 4)
  assert.equal(item.durationMs, 200)
})

test('image, file and custom result blocks are preserved while resultText stays compatible', () => {
  const content = [
    { type: 'text', text: 'first text' },
    { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
    { type: 'file', path: 'src/a.ts', content: 'export const a = 1' },
    { type: 'custom', name: 'demo', payload: { nested: [1, 2] } },
    { type: 'text', text: 'second text' },
  ]
  const data = resultData('call-blocks', content, { meta: { path: 'src/a.ts' } })
  const item = toolItem(live([
    event('tool/call', 1, callData('call-blocks'), { time: 1_000 }),
    event('tool/result', 2, data, { time: 1_500 }),
  ]), 'call-blocks')
  assert.equal(item.resultText, 'first text\n\nsecond text', 'the legacy text projection still works')
  assert.equal(item.resultImages, 1)
  assert.deepEqual(item.resultContent, content, 'raw blocks are kept, including non-text ones')
  assert.deepEqual(item.rawResult, data, 'the raw result envelope is kept')
  assert.deepEqual(item.meta, { path: 'src/a.ts' })
  assert.equal(item.status, 'done')
})

test('raw result meta and native error survive projection', () => {
  const data = resultData('call-error', [{ type: 'text', text: 'permission denied' }], {
    meta: { path: 'secret.txt' },
    error: { name: 'ReadError', code: 'E_READ', reason: 'permission denied' },
  }, true)
  const item = toolItem(live([
    event('tool/call', 1, callData('call-error'), { time: 1_000 }),
    event('tool/result', 2, data, { time: 1_800 }),
  ]), 'call-error')
  assert.equal(item.status, 'error')
  assert.equal(item.resultIsError, true)
  assert.equal(item.resultText, 'permission denied')
  assert.deepEqual(item.error, { name: 'ReadError', code: 'E_READ', reason: 'permission denied' })
  assert.deepEqual(item.meta, { path: 'secret.txt' })
  assert.deepEqual(item.rawResult, data)

  // Incomplete native error data is normalized, never upgraded to success.
  const partial = toolItem(live([
    event('tool/result', 9, resultData('call-error-partial', [], { error: { reason: 'boom' } }, true), { time: 500 }),
  ]), 'call-error-partial')
  assert.deepEqual(partial.error, { name: 'ToolError', code: '', reason: 'boom' })
  assert.equal(partial.status, 'error')
})

test('model-only replacement copies never overwrite append-origin tool facts', () => {
  const store = replay([
    event('assistant/message', 1, {
      turn: 1,
      step: 1,
      message: {
        id: 'a-original',
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-replace', name: 'bash', arguments: '{"command":"echo original"}' }],
        source: { kind: 'model', provider: 'demo', model: 'demo-model' },
      },
      stream: [],
    }, { surfaceOp: 'append', time: 500 }),
    event('tool/call', 2, callData('call-replace'), { time: 1_000 }),
    event('tool/result', 3, resultData('call-replace', [{ type: 'text', text: 'original result' }]), { surfaceOp: 'append', time: 2_000 }),
    // Native pruning rewrites the model-visible copy of the same range.
    event('tool/result', 4, resultData('call-replace', [{ type: 'text', text: '[pruned] replacement' }]), {
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 },
      time: 3_000,
    }),
    // A replacement assistant message must not append a shadow tool card.
    event('assistant/message', 5, assistantProposal([
      { id: 'call-shadow', name: 'edit', arguments: '{"file_path":"x.ts"}' },
    ]), { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 }, time: 4_000 }),
  ])
  const tools = store.items.filter(entry => entry.kind === 'tool')
  assert.equal(tools.length, 1, 'a replacement never appends a second card')
  const item = toolItem(store, 'call-replace')
  assert.equal(item.resultText, 'original result')
  assert.equal(item.resultSeq, 3)
  assert.equal(item.settledAt, 2_000)
  assert.equal(item.durationMs, 1_000)
  assert.equal(item.status, 'done')
  assert.equal(store.items.some(entry => entry.kind === 'tool' && entry.callId === 'call-shadow'), false)

  // A replacement-only result is not a settlement: the admitted call stays
  // unresolved and never claims done.
  const shadowed = live([
    event('tool/call', 1, callData('call-shadowed'), { time: 1_000 }),
    event('tool/result', 2, resultData('call-shadowed', [{ type: 'text', text: 'pruned away' }]), {
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 },
      time: 2_000,
    }),
  ])
  const unresolved = toolItem(shadowed, 'call-shadowed')
  assert.equal(unresolved.status, 'running')
  assert.equal(unresolved.resultText, '')
  assert.equal(unresolved.resultSeq, undefined)
  assert.equal(unresolved.settledAt, undefined)
  assert.equal(unresolved.durationMs, undefined)
})

test('proposed and unresolved calls never impersonate done', () => {
  const store = live([
    event('assistant/message', 1, assistantProposal([
      { id: 'call-proposed', name: 'read', arguments: '{"path":"a.ts"}' },
    ]), { surfaceOp: 'append', time: 500 }),
  ])
  const proposed = toolItem(store, 'call-proposed')
  assert.equal(proposed.status, 'proposed', 'a model request is not an admitted call')
  assert.equal(proposed.callSeq, undefined)
  assert.equal(proposed.resultSeq, undefined)
  assert.equal(proposed.startedAt, undefined)
  assert.equal(proposed.settledAt, undefined)
  assert.equal(proposed.durationMs, undefined)

  const admitted = live([
    event('tool/call', 1, callData('call-running'), { time: 1_000 }),
  ])
  const running = toolItem(admitted, 'call-running')
  assert.equal(running.status, 'running')
  assert.equal(running.startedAt, 1_000)
  assert.equal(running.durationMs, undefined, 'an unresolved call has no duration yet')

  admitted.handle({
    type: 'session_event',
    sessionId: baseInfo().sessionId,
    event: event('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }, { time: 3_000 }),
  })
  const ended = toolItem(admitted, 'call-running')
  assert.equal(ended.status, 'unknown')
  assert.equal(ended.startedAt, 1_000)
  assert.equal(ended.settledAt, undefined)
  assert.equal(ended.durationMs, undefined)
  assert.equal(ended.resultText, '')

  // A late duplicate call cannot turn an unresolved outcome back into Running,
  // and cannot invent a settlement time.
  admitted.handle({
    type: 'session_event',
    sessionId: baseInfo().sessionId,
    event: event('tool/call', 3, callData('call-running', {
      name: 'read',
      arguments: '{"path":"late.ts"}',
    }), { time: 4_000 }),
  })
  const stillUnknown = toolItem(admitted, 'call-running')
  assert.equal(stillUnknown.status, 'unknown')
  assert.equal(stillUnknown.startedAt, 1_000)
  assert.equal(stillUnknown.durationMs, undefined)

  const disconnected = live([
    event('tool/call', 4, callData('call-closed'), { time: 1_000 }),
  ])
  disconnected.handle({ type: 'closed', code: 0 } satisfies BackendEvent)
  assert.equal(toolItem(disconnected, 'call-closed').status, 'unknown')
})