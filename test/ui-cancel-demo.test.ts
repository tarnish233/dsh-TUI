import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { BackendEvent, DecisionRequest, SessionEvent } from '../src/backend/types.ts'
import { DemoBackend } from '../src/demo.ts'
import { TranscriptStore } from '../src/state/transcript.ts'

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** Bounded wait so a fixture regression fails the test instead of hanging the suite. */
const TIMEOUT_MS = 5_000

function withTimeout<T>(promise: Promise<T>, label: string, ms = TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

async function idle(backend: DemoBackend, label = 'demo session idle'): Promise<void> {
  await withTimeout(backend.whenIdle(), label)
}

function newStore(backend: DemoBackend): TranscriptStore {
  const codec = backend.transcriptCodec
  assert.ok(codec !== undefined)
  return new TranscriptStore({ codec })
}

function waitFor(backend: DemoBackend, predicate: (event: BackendEvent) => boolean, label = 'demo event'): Promise<BackendEvent> {
  return withTimeout(new Promise(resolve => {
    const off = backend.onEvent(event => {
      if (predicate(event)) {
        off()
        resolve(event)
      }
    })
  }), label)
}

const sessionEvents = (events: BackendEvent[]): SessionEvent[] =>
  events.flatMap(event => (event.type === 'session_event' ? [event.event] : []))

async function askDecision(backend: DemoBackend, prompt: string): Promise<DecisionRequest> {
  const pending = waitFor(backend, event => event.type === 'decision')
  await backend.send(prompt)
  const event = await pending
  assert.equal(event.type, 'decision')
  if (event.type !== 'decision') throw new Error('unreachable')
  return event.request
}

const lastAssistantText = (store: TranscriptStore): string => {
  const item = store.items.filter(entry => entry.kind === 'assistant').at(-1)
  return item?.kind === 'assistant' ? item.text : ''
}

// ---------------------------------------------------------------------------
// R22: a cancelled decision is cancelled, not a deny/unexpected answer

test('a raw {cancelled:true} approval answer is reported as cancelled, never as deny', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const store = newStore(backend)
  const events: BackendEvent[] = []
  backend.onEvent(event => {
    events.push(event)
    store.handle(event)
  })
  await backend.connect()
  const request = await askDecision(backend, 'approval')
  assert.equal(request.kind, 'approval')
  await backend.respond(request.id, { cancelled: true })
  await idle(backend)

  const text = lastAssistantText(store)
  assert.match(text, /cancel/i)
  assert.doesNotMatch(text, /deny/i)
  assert.doesNotMatch(text, /unexpected/i)
  const turnEnd = sessionEvents(events).find(event => event.type === 'turn/end')
  assert.deepEqual((turnEnd?.data as { reason?: unknown }).reason, { kind: 'completed' })
  await backend.close()
})

test('a raw {cancelled:true} question answer records no answers', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const store = newStore(backend)
  backend.onEvent(event => store.handle(event))
  await backend.connect()
  const request = await askDecision(backend, 'question')
  await backend.respond(request.id, { answers: [['Blue'], 'Compact'], cancelled: true })
  await idle(backend)
  const text = lastAssistantText(store)
  assert.match(text, /cancelled/i)
  assert.doesNotMatch(text, /unexpected/i)
  assert.doesNotMatch(text, /Blue|Compact/)
  await backend.close()
})

test('a native rejected approval value stays distinct from a cancellation', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const store = newStore(backend)
  backend.onEvent(event => store.handle(event))
  await backend.connect()
  const request = await askDecision(backend, 'approval')
  const deny = request.options?.find(option => typeof option.value === 'object' && option.value !== null && (option.value as { allow?: boolean }).allow === false)
  assert.ok(deny !== undefined, 'the demo approval exposes an opaque deny option')
  await backend.respond(request.id, deny.value)
  await idle(backend)
  assert.match(lastAssistantText(store), /deny/i)
  await backend.close()
})

// ---------------------------------------------------------------------------
// Queued input: preserved and paused on cancel, resumed by an explicit send

test('cancel keeps queued input, pauses the queue and never drains it automatically', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const store = newStore(backend)
  const events: BackendEvent[] = []
  backend.onEvent(event => {
    events.push(event)
    store.handle(event)
  })
  await backend.connect()
  const chunk = waitFor(backend, event => event.type === 'stream_chunk' && event.chunk.type === 'text-delta')
  await backend.send('hello')
  await chunk
  await backend.send('second') // queued while the first turn runs
  assert.deepEqual((await backend.command('state') as { pending: unknown }).pending, { nextTurn: 1, nextStep: 0 })
  await backend.cancel()
  // Wait for the interrupted turn to settle; the queue must stay paused.
  await delay(10)
  const state = await backend.command('state') as { pending: { nextTurn: number; nextStep: number }; status: string; queued?: number }
  assert.deepEqual(state.pending, { nextTurn: 1, nextStep: 0 }, 'native keepInbox: the queued message survives cancel')
  assert.equal(state.queued, undefined, 'state mirrors native shape: pending counts, no TUI-owned queued field')
  assert.equal(state.status, 'idle')
  assert.equal(lastAssistantText(store), '')
  const turns = sessionEvents(events).filter(event => event.type === 'turn/start')
  assert.equal(turns.length, 1, 'a cancelled turn does not auto-drain the paused queue')

  // dequeue (UI recall) can still retrieve the retained message without a turn.
  const removed = await backend.command('dequeue') as Array<{ text: string; target: string }>
  assert.deepEqual(removed.map(entry => entry.text), ['second'])
  assert.deepEqual((await backend.command('state') as { pending: unknown }).pending, { nextTurn: 0, nextStep: 0 })
  await backend.close()
})

test('an explicit send resumes the paused queue without dropping it', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const store = newStore(backend)
  const events: BackendEvent[] = []
  backend.onEvent(event => {
    events.push(event)
    store.handle(event)
  })
  await backend.connect()
  const chunk = waitFor(backend, event => event.type === 'stream_chunk' && event.chunk.type === 'text-delta')
  await backend.send('hello')
  await chunk
  await backend.send('second')
  await backend.cancel()
  await delay(10)
  await backend.send('third')
  await idle(backend)
  const users = sessionEvents(events)
    .filter(event => event.type === 'user/message')
    .map(event => {
      // Demo durable user/message carries content directly (same as DSH v2).
      const data = event.data as { content?: Array<{ text?: string }> }
      return data.content?.[0]?.text ?? ''
    })
  assert.deepEqual(users, ['hello', 'second', 'third'], 'queued input runs in order after an explicit send')
  assert.equal(sessionEvents(events).filter(event => event.type === 'turn/start').length, 3)
  await backend.close()
})

test('a new or resumed demo session starts with its own empty inbox', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  await backend.connect()
  const chunk = waitFor(backend, event => event.type === 'stream_chunk' && event.chunk.type === 'text-delta')
  await backend.send('hello')
  await chunk
  await backend.send('queued')
  await backend.cancel()
  await delay(5)
  const resumed = await backend.command('resume', { sessionId: 'demo-resumed' }) as { sessionId: string }
  assert.equal(resumed.sessionId, 'demo-resumed')
  const state = await backend.command('state') as { pending: { nextTurn: number; nextStep: number } }
  assert.deepEqual(state.pending, { nextTurn: 0, nextStep: 0 })
  await backend.close()
})

test('cancelling a pending decision keeps it settled and the queue preserved', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const store = newStore(backend)
  const events: BackendEvent[] = []
  backend.onEvent(event => {
    events.push(event)
    store.handle(event)
  })
  await backend.connect()
  const request = await askDecision(backend, 'question')
  await backend.send('queued behind the question')
  await backend.cancel()
  await delay(10)
  const closed = events.filter(event => event.type === 'decision_closed')
  assert.ok(closed.length >= 1)
  assert.deepEqual((await backend.command('state') as { pending: unknown; pendingDecisions: string[] }).pending, { nextTurn: 1, nextStep: 0 })
  assert.deepEqual((await backend.command('state') as { pendingDecisions: string[] }).pendingDecisions, [], `request ${request.id} was settled`)
  // Only the fixture intro was committed; the cancelled decision recorded no answers.
  assert.doesNotMatch(lastAssistantText(store), /Recorded demo answers|cancelled/i)
  await backend.close()
})