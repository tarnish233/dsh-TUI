import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { BackendEvent, SessionEvent, SessionInfo, StreamPresentation, SubagentEntry, TranscriptCodec } from '../src/backend/types.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'

/**
 * The store takes DSH's native `TranscriptCodec` from the backend. These tests
 * use the demo's fixture-only codec (the real backend installs DSH's public
 * BlockAssembler/assistant-stream/surface helpers instead); it is never a
 * production fallback, and `--demo` must run without DSH installed.
 */
const codec = DEMO_TRANSCRIPT_CODEC

const baseInfo = (events: SessionEvent[] = []): SessionInfo => ({
  sessionId: 'session-a',
  cwd: '/tmp/work',
  provider: 'demo',
  model: 'demo-model',
  capabilities: ['streaming'],
  events,
})

const sessionEvent = (type: string, seq: number, data: unknown, extra: Partial<SessionEvent> = {}): SessionEvent => ({
  type,
  seq,
  time: 0,
  data,
  ...extra,
})

const userMessage = (text: string) => ({
  id: `u-${text}`,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

const toolResultMessage = (callId: string, text: string, isError = false) => ({
  id: `tr-${callId}`,
  role: 'tool',
  toolCallId: callId,
  content: [{ type: 'text', text }],
  isError,
  source: { kind: 'tool', callId },
})

const assistantMessage = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  turn: 1,
  step: 1,
  message: {
    id: 'a-1',
    role: 'assistant',
    content,
    source: { kind: 'model', provider: 'demo', model: 'demo-model' },
  },
  stream: [],
  ...extra,
})

const newStore = (options: { codec?: TranscriptCodec; events?: SessionEvent[] } = {}): TranscriptStore => {
  const store = new TranscriptStore(options.codec === undefined ? { codec } : { codec: options.codec })
  store.reset(baseInfo(options.events ?? []))
  return store
}

const feed = (store: TranscriptStore, event: BackendEvent): void => store.handle(event)

const session = (store: TranscriptStore, event: SessionEvent): void =>
  feed(store, { type: 'session_event', sessionId: 'session-a', event })

test('replays historical v2 message, tool and attempt settlements', () => {
  const events: SessionEvent[] = [
    sessionEvent('turn/start', 1, { turn: 1 }),
    sessionEvent('user/message', 2, userMessage('please edit')),
    sessionEvent('assistant/message', 3, assistantMessage([
      { type: 'reasoning', text: 'think first' },
      { type: 'text', text: 'I will update it.' },
      { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"a.ts"}' },
    ])),
    sessionEvent('tool/call', 4, { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{"path":"a.ts"}' }),
    sessionEvent('tool/result', 5, {
      turn: 1,
      step: 1,
      message: toolResultMessage('call-1', 'one\ntwo'),
      meta: { path: 'a.ts' },
    }),
    sessionEvent('assistant/attempt', 6, {
      turn: 1,
      step: 2,
      stream: [
        { type: 'text-chunks', time0: 0, index: 0, dt: [0, 1], texts: ['retry', ' text'] },
        { type: 'tool-call-chunks', time0: 0, index: 1, dt: [0], id: 'call-2', name: 'edit', args: ['{"path":', '"b.ts"}'] },
        { type: 'chunk', time: 2, chunk: { type: 'finish', reason: { kind: 'error' } } },
      ],
    }),
  ]
  const store = newStore({ events })
  assert.deepEqual(store.items.map(item => item.kind), ['user', 'assistant', 'tool', 'attempt'])
  const assistant = store.items[1]
  assert.equal(assistant?.kind, 'assistant')
  if (assistant?.kind !== 'assistant') return
  assert.equal(assistant.text, 'I will update it.')
  assert.equal(assistant.thinking, 'think first')
  const tool = store.items[2]
  assert.equal(tool?.kind, 'tool')
  if (tool?.kind !== 'tool') return
  assert.equal(tool.status, 'done')
  assert.equal(tool.callId, 'call-1')
  assert.equal(tool.resultText, 'one\ntwo')
  assert.deepEqual(tool.meta, { path: 'a.ts' })
  const attempt = store.items[3]
  assert.equal(attempt?.kind, 'attempt')
  if (attempt?.kind !== 'attempt') return
  assert.equal(attempt.text, 'retry text')
  assert.deepEqual(attempt.toolNames, ['edit'])
  assert.equal(attempt.status, 'abandoned')
  assert.equal(attempt.tentative, false)
  // Reset is replay, not append: a second reset must not duplicate entries.
  store.reset(baseInfo(events))
  assert.equal(store.items.length, 4)
})

test('merges one live attempt with its committed message without duplication', () => {
  const store = newStore()
  session(store, sessionEvent('user/message', 1, userMessage('hi')))
  feed(store, { type: 'stream_start', sessionId: 'session-a', attemptId: 'att-1', revision: 1, turn: 1, step: 1 })
  feed(store, { type: 'stream_chunk', sessionId: 'session-a', attemptId: 'att-1', revision: 2, index: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } })
  feed(store, { type: 'stream_chunk', sessionId: 'session-a', attemptId: 'att-1', revision: 3, index: 1, chunk: { type: 'text-delta', index: 0, text: 'Hel' } })
  const itemId = store.items[1]?.id
  // Native DSH increments revision per frame; duplicates must not append.
  feed(store, { type: 'stream_chunk', sessionId: 'session-a', attemptId: 'att-1', revision: 3, index: 1, chunk: { type: 'text-delta', index: 0, text: 'XX' } })
  feed(store, { type: 'stream_chunk', sessionId: 'session-a', attemptId: 'att-1', revision: 4, index: 2, chunk: { type: 'text-delta', index: 0, text: 'lo' } })
  feed(store, { type: 'stream_chunk', sessionId: 'session-a', attemptId: 'att-1', revision: 5, index: 3, chunk: { type: 'text-delta', index: 0, text: '!' } })
  assert.equal(store.items[1]?.id, itemId, 'frame revisions do not recreate the component')
  feed(store, { type: 'stream_end', sessionId: 'session-a', attemptId: 'att-1', revision: 6, outcome: 'committed', seq: 2 })
  assert.deepEqual(store.items.map(item => item.kind), ['user', 'attempt'])
  const live = store.items[1]
  assert.equal(live?.kind, 'attempt')
  if (live?.kind !== 'attempt') return
  assert.equal(live.text, 'Hello!')
  assert.equal(live.status, 'committing')
  assert.equal(live.tentative, true)
  assert.equal(store.hasLiveAttempt, true)

  session(store, sessionEvent('assistant/message', 2, assistantMessage([{ type: 'text', text: 'Hello!' }])))
  assert.deepEqual(store.items.map(item => item.kind), ['user', 'assistant'])
  assert.equal(store.hasLiveAttempt, false)
  const assistant = store.items[1]
  assert.equal(assistant?.kind, 'assistant')
  if (assistant?.kind !== 'assistant') return
  assert.equal(assistant.text, 'Hello!')
  // Late end and duplicate settlement are ignored.
  feed(store, { type: 'stream_end', sessionId: 'session-a', attemptId: 'att-1', revision: 6, outcome: 'committed', seq: 2 })
  session(store, sessionEvent('assistant/message', 2, assistantMessage([{ type: 'text', text: 'Hello!' }])))
  assert.equal(store.items.length, 2)
})

test('settlement that arrives before stream_end still replaces the live item in place', () => {
  const store = newStore()
  feed(store, { type: 'stream_start', sessionId: 'session-a', attemptId: 'att-1', revision: 2, turn: 1, step: 1 })
  feed(store, { type: 'stream_chunk', sessionId: 'session-a', attemptId: 'att-1', revision: 3, index: 0, chunk: { type: 'text-delta', index: 0, text: 'live' } })
  session(store, sessionEvent('assistant/message', 4, assistantMessage([{ type: 'text', text: 'final' }])))
  feed(store, { type: 'stream_end', sessionId: 'session-a', attemptId: 'att-1', revision: 4, outcome: 'committed', seq: 4 })
  assert.deepEqual(store.items.map(item => item.kind), ['assistant'])
  const assistant = store.items[0]
  assert.equal(assistant?.kind, 'assistant')
  if (assistant?.kind !== 'assistant') return
  assert.equal(assistant.text, 'final')
})

test('abandoned live text stays an explicit tentative attempt and a retry appends facts', () => {
  const store = newStore()
  feed(store, { type: 'stream_start', sessionId: 'session-a', attemptId: 'att-old', revision: 1, turn: 1, step: 1 })
  feed(store, { type: 'stream_chunk', sessionId: 'session-a', attemptId: 'att-old', revision: 2, index: 0, chunk: { type: 'text-delta', index: 0, text: 'partial' } })
  feed(store, { type: 'stream_end', sessionId: 'session-a', attemptId: 'att-old', revision: 3, outcome: 'abandoned' })
  assert.deepEqual(store.items.map(item => item.kind), ['attempt'])
  const abandoned = store.items[0]
  assert.equal(abandoned?.kind, 'attempt')
  if (abandoned?.kind !== 'attempt') return
  assert.equal(abandoned.status, 'abandoned')
  assert.equal(abandoned.tentative, true)
  assert.equal(abandoned.text, 'partial')
  assert.equal(store.hasLiveAttempt, false)

  feed(store, { type: 'stream_start', sessionId: 'session-a', attemptId: 'att-new', revision: 4, turn: 1, step: 1 })
  feed(store, { type: 'stream_chunk', sessionId: 'session-a', attemptId: 'att-new', revision: 5, index: 0, chunk: { type: 'text-delta', index: 0, text: 'final' } })
  feed(store, { type: 'stream_end', sessionId: 'session-a', attemptId: 'att-new', revision: 6, outcome: 'committed', seq: 7 })
  session(store, sessionEvent('assistant/message', 7, assistantMessage([{ type: 'text', text: 'final' }])))
  assert.deepEqual(store.items.map(item => item.kind), ['attempt', 'assistant'])
  const final = store.items[1]
  assert.equal(final?.kind, 'assistant')
  if (final?.kind !== 'assistant') return
  assert.equal(final.text, 'final')
})

test('committed assistant/attempt settlement is not presented as a reply', () => {
  const store = newStore()
  feed(store, { type: 'stream_start', sessionId: 'session-a', attemptId: 'att-fail', revision: 3, turn: 1, step: 1 })
  feed(store, { type: 'stream_chunk', sessionId: 'session-a', attemptId: 'att-fail', revision: 4, index: 0, chunk: { type: 'text-delta', index: 0, text: 'partial failure' } })
  feed(store, { type: 'stream_end', sessionId: 'session-a', attemptId: 'att-fail', revision: 5, outcome: 'committed', seq: 9 })
  session(store, sessionEvent('assistant/attempt', 9, {
    turn: 1,
    step: 1,
    stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [0], texts: ['partial failure'] }],
  }))
  assert.deepEqual(store.items.map(item => item.kind), ['attempt'])
  const attempt = store.items[0]
  assert.equal(attempt?.kind, 'attempt')
  if (attempt?.kind !== 'attempt') return
  assert.equal(attempt.status, 'abandoned')
  assert.equal(attempt.tentative, false)
  assert.equal(attempt.text, 'partial failure')
})

test('filters stale sessions and late chunks from older revisions', () => {
  const store = newStore()
  feed(store, { type: 'status', sessionId: 'other', status: 'running' })
  feed(store, { type: 'session_event', sessionId: 'other', event: sessionEvent('user/message', 1, userMessage('nope')) })
  feed(store, { type: 'stream_start', sessionId: 'other', attemptId: 'x', revision: 1, turn: 1, step: 1 })
  feed(store, { type: 'stream_start', sessionId: 'session-a', attemptId: 'att', revision: 5, turn: 1, step: 1 })
  feed(store, { type: 'stream_chunk', sessionId: 'session-a', attemptId: 'att', revision: 4, index: 0, chunk: { type: 'text-delta', index: 0, text: 'stale' } })
  feed(store, { type: 'stream_chunk', sessionId: 'session-a', attemptId: 'att', revision: 6, index: 0, chunk: { type: 'text-delta', index: 0, text: 'ok' } })
  assert.deepEqual(store.items.map(item => item.kind), ['attempt'])
  const attempt = store.items[0]
  assert.equal(attempt?.kind, 'attempt')
  if (attempt?.kind !== 'attempt') return
  assert.equal(attempt.text, 'ok')
  assert.equal(store.status, 'idle')
})

test('advancing frame revisions project text, reasoning and tools without accepting stale frames', () => {
  const store = newStore()
  const start: BackendEvent = { type: 'stream_start', sessionId: 'session-a', attemptId: 'att', revision: 1, turn: 1, step: 1 }
  const text = (revision: number, index: number, value: string, attemptId = 'att'): BackendEvent => ({ type: 'stream_chunk', sessionId: 'session-a', attemptId, revision, index, chunk: { type: 'text-delta', index: 1, text: value } })
  feed(store, start)
  const id = store.items[0]?.id
  feed(store, { type: 'stream_chunk', sessionId: 'session-a', attemptId: 'att', revision: 2, index: 0, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } })
  feed(store, { type: 'stream_chunk', sessionId: 'session-a', attemptId: 'att', revision: 3, index: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking live' } })
  feed(store, text(4, 2, 'visible'))
  feed(store, { type: 'stream_chunk', sessionId: 'session-a', attemptId: 'att', revision: 5, index: 3, chunk: { type: 'tool-call-delta', index: 2, id: 'call-live', name: 'read', argumentsDelta: '{}' } })

  // Neither a stale revision, duplicate index, foreign attempt, nor an
  // out-of-order start can roll back or recreate this active attempt.
  feed(store, text(4, 4, 'stale revision'))
  feed(store, text(6, 2, 'duplicate index'))
  feed(store, text(99, 4, 'foreign attempt', 'old-att'))
  feed(store, { ...start, attemptId: 'old-att', revision: 4 })
  feed(store, { ...start, revision: 99 })
  feed(store, text(Number.NaN, 4, 'invalid revision'))
  feed(store, text(6, 4, ' more'))
  feed(store, { type: 'stream_end', sessionId: 'session-a', attemptId: 'att', revision: 6, outcome: 'abandoned' })
  assert.equal(store.hasLiveAttempt, true, 'a stale end must not close the stream')
  const live = store.items[0]
  assert.ok(live?.kind === 'attempt')
  assert.equal(live.id, id)
  assert.equal(live.revision, 6)
  assert.equal(live.text, 'visible more')
  assert.equal(live.thinking, 'thinking live')
  assert.deepEqual(live.toolNames, ['read'])
  feed(store, { type: 'stream_end', sessionId: 'session-a', attemptId: 'att', revision: 7, outcome: 'abandoned' })
  assert.equal(store.hasLiveAttempt, false)
  assert.equal(store.items.length, 1)
  const ended = store.items[0]
  assert.ok(ended?.kind === 'attempt')
  assert.equal(ended.text, 'visible more')
  assert.equal(ended.status, 'abandoned')
})

test('commits tool calls and results by callId, including errors and unknown results', () => {
  const store = newStore()
  session(store, sessionEvent('assistant/message', 1, assistantMessage([
    { type: 'tool-call', id: 'call-x', name: 'read', arguments: '{"path":"x"}' },
  ])))
  // The assistant message created the tool card; the durable tool/call upserts it.
  session(store, sessionEvent('tool/call', 2, { turn: 1, step: 1, callId: 'call-x', name: 'read', arguments: '{"path":"x","limit":2}' }))
  session(store, sessionEvent('tool/result', 3, {
    turn: 1,
    step: 1,
    message: toolResultMessage('call-x', 'bad', true),
    error: { name: 'ReadError', code: 'E_READ', reason: 'permission denied' },
    meta: { path: 'x' },
  }))
  session(store, sessionEvent('tool/result', 4, {
    turn: 1,
    step: 1,
    message: toolResultMessage('call-unknown', 'orphan result'),
  }))
  const tools = store.items.filter(item => item.kind === 'tool')
  assert.equal(tools.length, 2)
  const first = tools[0]
  assert.equal(first?.kind, 'tool')
  if (first?.kind !== 'tool') return
  assert.equal(first.status, 'error')
  assert.equal(first.arguments, '{"path":"x","limit":2}')
  assert.equal(first.resultText, 'bad')
  assert.deepEqual(first.error, { name: 'ReadError', code: 'E_READ', reason: 'permission denied' })
  const orphan = tools[1]
  assert.equal(orphan?.kind, 'tool')
  if (orphan?.kind !== 'tool') return
  assert.equal(orphan.callId, 'call-unknown')
  assert.equal(orphan.status, 'done')
  assert.equal(orphan.resultText, 'orphan result')
})

test('model-only replacement messages are filtered while append-origin facts and lifecycle records survive', () => {
  const store = newStore()
  const replace = (startSeq: number, endSeq: number) => ({ surfaceOp: { op: 'replace' as const, startSeq, endSeq } })
  // Append-origin human transcript.
  session(store, sessionEvent('assistant/message', 1, assistantMessage([{ type: 'text', text: 'original reply' }]), { surfaceOp: 'append' }))
  // Native compaction/pruning replacement copies are model-only.
  session(store, sessionEvent('assistant/message', 2, assistantMessage([{ type: 'text', text: 'summarized replacement' }]), replace(1, 1)))
  session(store, sessionEvent('user/message', 3, userMessage('rewritten prompt'), replace(1, 2)))
  session(store, sessionEvent('tool/result', 4, {
    turn: 1,
    step: 1,
    message: toolResultMessage('call-shadow', 'replacement tool output'),
  }, replace(1, 3)))
  // Non-surface lifecycle/attempt records are never replacement copies.
  session(store, sessionEvent('assistant/attempt', 5, {
    turn: 1,
    step: 2,
    stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [0], texts: ['attempt kept'] }],
  }))
  session(store, sessionEvent('tool/call', 6, { turn: 1, step: 2, callId: 'call-live', name: 'read', arguments: '{}' }))
  assert.deepEqual(store.items.map(item => item.kind), ['assistant', 'attempt', 'tool'])
  const assistant = store.items[0]
  assert.equal(assistant?.kind, 'assistant')
  if (assistant?.kind !== 'assistant') return
  assert.equal(assistant.text, 'original reply')
  assert.equal(store.items.filter(item => item.kind === 'user').length, 0)
  const attempt = store.items[1]
  assert.equal(attempt?.kind, 'attempt')
  if (attempt?.kind !== 'attempt') return
  assert.equal(attempt.text, 'attempt kept')
  const tool = store.items[2]
  assert.equal(tool?.kind, 'tool')
  if (tool?.kind !== 'tool') return
  assert.equal(tool.status, 'running', 'lifecycle call is preserved')
})

test('a replacement tool result never overwrites the append-origin human output', () => {
  const store = newStore()
  session(store, sessionEvent('assistant/message', 1, assistantMessage([
    { type: 'tool-call', id: 'call-r', name: 'bash', arguments: '{"command":"echo hi"}' },
  ]), { surfaceOp: 'append' }))
  session(store, sessionEvent('tool/call', 2, { turn: 1, step: 1, callId: 'call-r', name: 'bash', arguments: '{"command":"echo hi"}' }))
  session(store, sessionEvent('tool/result', 3, {
    turn: 1,
    step: 1,
    message: toolResultMessage('call-r', 'original human output'),
  }, { surfaceOp: 'append' }))
  // Native result pruning rewrites the model-visible copy of the same range.
  session(store, sessionEvent('tool/result', 4, {
    turn: 1,
    step: 1,
    message: toolResultMessage('call-r', '[pruned] output is too large'),
  }, { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 } }))
  const tools = store.items.filter(item => item.kind === 'tool')
  assert.equal(tools.length, 1, 'replacement must not append a second card')
  const tool = tools[0]
  assert.equal(tool?.kind, 'tool')
  if (tool?.kind !== 'tool') return
  assert.equal(tool.status, 'done')
  assert.equal(tool.resultText, 'original human output')
})

test('turn end and disconnect settle outstanding tool cards as unknown, never as done/error', () => {
  const store = newStore()
  session(store, sessionEvent('assistant/message', 1, assistantMessage([
    { type: 'tool-call', id: 'call-p', name: 'read', arguments: '{"path":"a.ts"}' },
  ]), { surfaceOp: 'append' }))
  const proposed = store.items.find(item => item.kind === 'tool')
  assert.equal(proposed?.kind, 'tool')
  if (proposed?.kind !== 'tool') return
  assert.equal(proposed.status, 'proposed', 'model-requested call is not yet running')

  session(store, sessionEvent('tool/call', 2, { turn: 1, step: 1, callId: 'call-p', name: 'read', arguments: '{"path":"a.ts"}' }))
  const running = store.items.find(item => item.kind === 'tool')
  assert.equal(running?.kind, 'tool')
  if (running?.kind !== 'tool') return
  assert.equal(running.status, 'running')

  // A result settles a different call and must stay done through turn end.
  session(store, sessionEvent('tool/result', 3, {
    turn: 1,
    step: 1,
    message: toolResultMessage('call-done', 'settled output'),
  }, { surfaceOp: 'append' }))
  session(store, sessionEvent('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }))
  const tools = store.items.filter(item => item.kind === 'tool')
  assert.equal(tools.length, 2)
  const pending = tools.find(item => item.kind === 'tool' && item.callId === 'call-p')
  assert.equal(pending?.kind, 'tool')
  if (pending?.kind !== 'tool') return
  assert.equal(pending.status, 'unknown', 'turn end reports unknown instead of permanent Running')
  const settled = tools.find(item => item.kind === 'tool' && item.callId === 'call-done')
  assert.equal(settled?.kind, 'tool')
  if (settled?.kind !== 'tool') return
  assert.equal(settled.status, 'done', 'unknown settlement never overwrites a real result')

  // Disconnect settles the same way and drops the live attempt to unknown.
  feed(store, { type: 'stream_start', sessionId: 'session-a', attemptId: 'att-live', revision: 9, turn: 2, step: 1 })
  feed(store, { type: 'stream_chunk', sessionId: 'session-a', attemptId: 'att-live', revision: 10, index: 0, chunk: { type: 'text-delta', index: 0, text: 'in flight' } })
  session(store, sessionEvent('tool/call', 5, { turn: 2, step: 1, callId: 'call-live', name: 'bash', arguments: '{}' }))
  feed(store, { type: 'closed', code: 1 })
  assert.equal(store.hasLiveAttempt, false)
  const attempt = store.items.find(item => item.kind === 'attempt')
  assert.equal(attempt?.kind, 'attempt')
  if (attempt?.kind !== 'attempt') return
  assert.equal(attempt.status, 'unknown')
  const liveTool = store.items.find(item => item.kind === 'tool' && item.callId === 'call-live')
  assert.equal(liveTool?.kind, 'tool')
  if (liveTool?.kind !== 'tool') return
  assert.equal(liveTool.status, 'unknown')
  const stillDone = store.items.find(item => item.kind === 'tool' && item.callId === 'call-done')
  assert.equal(stillDone?.kind, 'tool')
  if (stillDone?.kind !== 'tool') return
  assert.equal(stillDone.status, 'done')
})

test('a snapshot replay settles unresolved cards instead of leaving them running', () => {
  const store = newStore({
    events: [
      sessionEvent('assistant/message', 1, assistantMessage([
        { type: 'tool-call', id: 'call-s', name: 'read', arguments: '{}' },
      ]), { surfaceOp: 'append' }),
      sessionEvent('tool/call', 2, { turn: 1, step: 1, callId: 'call-s', name: 'read', arguments: '{}' }),
    ],
  })
  const tool = store.items.find(item => item.kind === 'tool')
  assert.equal(tool?.kind, 'tool')
  if (tool?.kind !== 'tool') return
  assert.equal(tool.status, 'unknown')
  assert.equal(store.status, 'idle')
})

test('carries and merges native tool presentation without writing anything back', () => {
  const store = newStore()
  session(store, sessionEvent('assistant/message', 1, assistantMessage([
    { type: 'tool-call', id: 'call-v', name: 'edit', arguments: '{"file_path":"a.ts"}' },
  ]), { surfaceOp: 'append' }))
  session(store, sessionEvent('tool/call', 2, {
    turn: 1,
    step: 1,
    callId: 'call-v',
    name: 'edit',
    arguments: '{"file_path":"a.ts"}',
  }, {
    toolPresentation: { call: { card: 'diff', title: 'Edit a.ts', diffs: [{ path: 'a.ts', oldText: null, newText: 'x' }] } },
  }))
  session(store, sessionEvent('tool/result', 3, {
    turn: 1,
    step: 1,
    message: toolResultMessage('call-v', 'updated'),
  }, {
    toolPresentation: { result: { card: 'diff', diffs: [{ path: 'a.ts', oldText: 'a', newText: 'x' }] } },
  }))
  const tool = store.items.find(item => item.kind === 'tool')
  assert.equal(tool?.kind, 'tool')
  if (tool?.kind !== 'tool') return
  const presentation = tool.presentation as { call?: { card?: string }; result?: { card?: string } } | undefined
  assert.equal(presentation?.call?.card, 'diff', 'call intent is kept across settlement')
  assert.equal(presentation?.result?.card, 'diff')
  // The item itself is display state only; the durable event stays untouched.
  assert.equal(tool.status, 'done')
})

test('without an injected codec the store tracks attempts but never mirrors DSH assembly', () => {
  const store = new TranscriptStore()
  store.reset(baseInfo())
  assert.equal(store.hasCodec, false)
  feed(store, { type: 'stream_start', sessionId: 'session-a', attemptId: 'att-nc', revision: 1, turn: 1, step: 1 })
  feed(store, { type: 'stream_chunk', sessionId: 'session-a', attemptId: 'att-nc', revision: 2, index: 0, chunk: { type: 'text-delta', index: 0, text: 'not assembled' } })
  const live = store.items[0]
  assert.equal(live?.kind, 'attempt')
  if (live?.kind !== 'attempt') return
  assert.equal(live.text, '', 'no production mirror: nothing is assembled locally')
  // Settled attempts still use the injected codec once it is installed.
  store.setCodec(codec)
  assert.equal(store.hasCodec, true)
  feed(store, { type: 'stream_end', sessionId: 'session-a', attemptId: 'att-nc', revision: 3, outcome: 'committed', seq: 2 })
  session(store, sessionEvent('assistant/attempt', 2, {
    turn: 1,
    step: 1,
    stream: [{ type: 'text-chunks', time0: 0, index: 0, dt: [0], texts: ['settled by native codec'] }],
  }))
  const settled = store.items[0]
  assert.equal(settled?.kind, 'attempt')
  if (settled?.kind !== 'attempt') return
  assert.equal(settled.text, 'settled by native codec')
  assert.equal(settled.tentative, false)
})

test('the injected codec owns surface classification', () => {
  const surfaceKinds = new Map<string, 'append' | 'replace' | 'none'>([
    ['assistant/message', 'none'],
    ['user/message', 'append'],
    ['tool/result', 'replace'],
  ])
  const custom: TranscriptCodec = {
    createStream: () => ({ push: () => {}, snapshot: (): StreamPresentation => ({ text: '', thinking: '', toolNames: [] }) }),
    assemble: () => ({ text: '', thinking: '', toolNames: [] }),
    surfaceKind: event => surfaceKinds.get(event.type) ?? 'none',
  }
  const store = newStore({ codec: custom })
  session(store, sessionEvent('assistant/message', 1, assistantMessage([{ type: 'text', text: 'codec says none' }])))
  session(store, sessionEvent('user/message', 2, userMessage('codec says append')))
  session(store, sessionEvent('tool/result', 3, { turn: 1, step: 1, message: toolResultMessage('call-q', 'codec says replace') }))
  assert.deepEqual(store.items.map(item => item.kind), ['user'])
})

test('the fixture codec assembles the demo compact stream without joining boundaries', () => {
  const presentation = codec.assemble([
    { type: 'text-chunks', time0: 0, index: 0, dt: [0, 2], texts: ['a', 'b'] },
    { type: 'reasoning-chunks', time0: 0, index: 1, dt: [0], texts: ['think'] },
    { type: 'tool-call-chunks', time0: 0, index: 2, dt: [0, 2], id: 'c', name: 'edit', args: ['{"p":', '"1"}'] },
    { type: 'chunk', time: 3, chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ])
  assert.equal(presentation.text, 'ab')
  assert.equal(presentation.thinking, 'think')
  assert.deepEqual(presentation.toolNames, ['edit'])
})

test('ignores synthetic user-role context and reports local notices', () => {
  const store = newStore()
  session(store, sessionEvent('user/message', 1, {
    id: 'ctx',
    role: 'user',
    content: [{ type: 'text', text: 'injected file contents' }],
    source: { kind: 'instructions', form: 'instructions' },
  }))
  assert.equal(store.items.length, 0)
  store.report('local error', 'error')
  assert.equal(store.items.length, 1)
  const notice = store.items[0]
  assert.equal(notice?.kind, 'notice')
  if (notice?.kind !== 'notice') return
  assert.equal(notice.level, 'error')
  assert.equal(notice.text, 'local error')
  feed(store, { type: 'error', message: 'backend exploded' })
  assert.equal(store.items.length, 2)
})
// ---------------------------------------------------------------------------
// `items` memoization

const childEntry = (overrides: Partial<SubagentEntry> = {}): SubagentEntry => ({
  id: 'child-1',
  parentSessionId: 'session-a',
  mode: 'one-shot',
  status: 'running',
  ...overrides,
})

test('items is memoized: unchanged reads share one array, real changes rebuild it', () => {
  const store = newStore({ events: [sessionEvent('user/message', 1, userMessage('hello'))] })
  const first = store.items
  assert.equal(store.items, first, 'two reads with no change return the identical array')
  assert.equal(store.items, first)
  assert.deepEqual(first.map(item => item.kind), ['user'])

  // A catalog entry without a parent seq adds no transcript row: the projection
  // is the durable list itself, so even a recomposition returns that one array.
  feed(store, { type: 'subagents', sessionId: 'session-a', value: { entries: [childEntry()] } })
  const catalogNoAnchor = store.items
  assert.deepEqual(catalogNoAnchor.map(item => item.kind), ['user'])
  assert.equal(catalogNoAnchor, first, 'a catalog change with no anchor projects the durable list itself')
  assert.equal(catalogNoAnchor[0], first[0], 'unchanged durable entries keep their identity')
  assert.equal(store.items, catalogNoAnchor)

  // A replayed, identical catalog is a no-op: no notify, no recomposition.
  feed(store, { type: 'subagents', sessionId: 'session-a', value: { entries: [childEntry()] } })
  assert.equal(store.items, catalogNoAnchor, 'an idempotent catalog replay keeps the cached array')

  // A trustworthy anchor is a real projection change.
  feed(store, { type: 'subagent', sessionId: 'session-a', value: childEntry({ catalogSeq: 1 }) })
  const anchored = store.items
  assert.notEqual(anchored, catalogNoAnchor)
  assert.deepEqual(anchored.map(item => item.kind), ['user', 'subagent'])
  assert.equal(store.items, anchored)

  // A local notice mutates the durable list only.
  store.report('note')
  const withNotice = store.items
  assert.notEqual(withNotice, anchored)
  assert.deepEqual(withNotice.map(item => item.kind), ['user', 'subagent', 'notice'])
  assert.equal(store.items, withNotice)

  // A new session id re-anchors nothing: the same catalog yields no child row.
  store.reset({ ...baseInfo(), sessionId: 'session-b' })
  const otherSession = store.items
  assert.notEqual(otherSession, withNotice)
  assert.deepEqual(otherSession.map(item => item.kind), [])

  // `clear()` empties the projection without changing the session id.
  store.report('again')
  assert.deepEqual(store.items.map(item => item.kind), ['notice'])
  const beforeClear = store.items
  store.clear()
  assert.notEqual(store.items, beforeClear)
  assert.equal(store.items.length, 0)
})

test('the items cache never hides an anchored child removed by a later snapshot', () => {
  const store = newStore({ events: [sessionEvent('user/message', 5, userMessage('anchor'))] })
  feed(store, { type: 'subagents', sessionId: 'session-a', value: { entries: [childEntry({ catalogSeq: 4 })] } })
  assert.deepEqual(store.items.map(item => item.kind), ['subagent', 'user'])
  const withChild = store.items
  // The catalog no longer lists the child: the removed row must disappear even
  // though no entry revision was bumped by the removal itself.
  feed(store, { type: 'subagents', sessionId: 'session-a', value: { entries: [] } })
  const without = store.items
  assert.notEqual(without, withChild)
  assert.deepEqual(without.map(item => item.kind), ['user'])
})
