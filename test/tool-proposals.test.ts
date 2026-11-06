import assert from 'node:assert/strict'
import test from 'node:test'
import type { SessionEvent, SessionInfo } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import { planTranscriptNodes } from '../src/ui/tool-group.ts'

const info: SessionInfo = { sessionId: 'proposal-boundaries', cwd: '/fixture', provider: 'demo', model: 'fixture', capabilities: [], events: [] }
function store(): TranscriptStore {
  const value = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  value.reset(info)
  return value
}
function proposal(seq: number, callId: string, turn: unknown, step: unknown): SessionEvent {
  return { type: 'assistant/message', seq, time: 1_000, surfaceOp: 'append', data: {
    turn, step, stream: [], message: { id: `message-${seq}`, role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{"command":"true"}' }],
      source: { kind: 'model', provider: 'demo', model: 'fixture' },
    },
  } }
}

test('parent projection: model-declared calls retain turn/step without inventing admission/time/result', () => {
  const value = store()
  value.handle({ type: 'session_event', sessionId: info.sessionId, event: proposal(1, 'a', 3, 2) })
  const item = value.items.find(entry => entry.kind === 'tool')
  assert.equal(item?.kind, 'tool')
  if (item?.kind !== 'tool') return
  assert.equal(item.turn, 3)
  assert.equal(item.step, 2)
  assert.equal(item.status, 'proposed')
  assert.equal(item.callSeq, undefined)
  assert.equal(item.startedAt, undefined)
  assert.equal(item.durationMs, undefined)
  assert.equal(item.rawResult, undefined)
})

test('parent projection: invisible assistant messages cannot merge tool proposals across known turns', () => {
  const value = store()
  value.handle({ type: 'session_event', sessionId: info.sessionId, event: proposal(1, 'first-turn', 1, 1) })
  value.handle({ type: 'session_event', sessionId: info.sessionId, event: proposal(2, 'second-turn', 2, 1) })
  const nodes = planTranscriptNodes(value.items, { groupTools: true, showThinking: false })
  assert.equal(nodes.some(node => node.kind === 'group'), false)
  assert.deepEqual(value.items.filter(item => item.kind === 'tool').map(item => item.turn), [1, 2])
})

test('parent projection: same-turn proposals across steps remain eligible when there is no visible content', () => {
  const value = store()
  value.handle({ type: 'session_event', sessionId: info.sessionId, event: proposal(1, 'same-turn-a', 1, 1) })
  value.handle({ type: 'session_event', sessionId: info.sessionId, event: proposal(2, 'same-turn-b', 1, 2) })
  const nodes = planTranscriptNodes(value.items, { groupTools: true, showThinking: false })
  assert.equal(nodes.length, 1)
  assert.equal(nodes[0]?.kind, 'group')
})

test('parent projection: invalid/missing declaration indices stay absent instead of becoming a guessed boundary', () => {
  const value = store()
  value.handle({ type: 'session_event', sessionId: info.sessionId, event: proposal(1, 'unknown', 1.5, undefined) })
  const item = value.items.find(entry => entry.kind === 'tool')
  assert.equal(item?.kind, 'tool')
  if (item?.kind !== 'tool') return
  assert.equal(item.turn, undefined)
  assert.equal(item.step, undefined)
})
