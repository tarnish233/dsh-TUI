/**
 * Reattachment-fault regressions for the in-process adapter.
 *
 * The adapter must never trade a usable attachment for a candidate it has not
 * secured. Installed native contracts make a same-id candidate impossible to
 * prepare in parallel with the live one:
 * - `AgentRegistry.enter()` is the "authoritative collision boundary" and
 *   rejects `agent "<id>" is already registered`;
 * - `SessionPersistence.open(id,'write')` documents "write atomically claims
 *   single-writer ownership; an existing active owner rejects"
 *   (`SessionAlreadyOwnedError`).
 *
 * So a close-then-resume reattachment of the *current* session has no
 * rollback, and this suite pins the behaviour that survives a native
 * resume/create/setup fault: the previous attachment (same epoch, same native
 * Agent, same queue and decisions) stays usable instead of the session being
 * lost. These are offline fakes; no profile, credential or model is involved.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshBackend, type DshContextBackend, type DshContextBackendOptions } from '../src/backend/context.ts'
import type { BackendEvent, SessionInfo } from '../src/backend/types.ts'
import { FakeAgentRegistry, FakeDshHost, fakeNativeHelpers, type FakeAgentState } from '../src/backend/testing.ts'

interface Harness {
  host: FakeDshHost
  agents: FakeAgentRegistry
  backend: DshContextBackend
  events: BackendEvent[]
}

function harness(options: Partial<DshContextBackendOptions> = {}): Harness {
  const host = new FakeDshHost()
  const agents = new FakeAgentRegistry()
  host.use('agents', agents)
  host.use('agentDefaultModel', {
    currentSelection: () => ({ provider: 'p1', model: 'm1' }),
    saveSelection: async () => {},
  })
  host.use('llm', {
    listProviders: () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }],
    resolveModelInfo: async () => ({}),
  })
  const backend = createDshBackend(host, { cwd: '/workspace', native: fakeNativeHelpers(), ...options })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  return { host, agents, backend, events }
}

/** One materialized session whose Agent answers through the fake inbox. */
async function liveHarness(): Promise<Harness & { agent: FakeAgentState; info: SessionInfo }> {
  const value = harness()
  await value.backend.connect()
  await value.backend.send('prompt')
  const agent = value.agents.agents[0]
  assert.ok(agent, 'the lazy send materialized exactly one native Agent')
  assert.equal(value.agents.agents.length, 1)
  return { ...value, agent, info: await value.backend.connect() }
}

function errorOf(error: unknown): { code?: string; name?: string; message?: string } {
  return error as { code?: string; name?: string; message?: string }
}

test('an explicit reattachment to the current session keeps the live attachment', async () => {
  const { backend, agents, agent, info } = await liveHarness()
  // A persistent native fault for this id: the old code called it and lost the
  // attachment, so every later state/send failed with "no live session".
  agents.failResume = new Error('synthetic native resume fault')
  agents.failSetup = new Error('synthetic native setup fault')

  const resumed = await backend.command('resume', { sessionId: info.sessionId }) as SessionInfo
  assert.equal(resumed.sessionId, info.sessionId)
  assert.equal(resumed.attachmentId, info.attachmentId, 'the attachment epoch is preserved')
  assert.equal(resumed.provider, info.provider)
  assert.equal(resumed.model, info.model)

  // No native resume was attempted, so nothing could fail and nothing was torn down.
  assert.equal(agents.resumeCalls.length, 0)
  assert.equal(agents.createCalls.length, 1)
  assert.equal(agents.agents.length, 1, 'the same native Agent is still the only live one')
  assert.equal(agent.disposed, false)
  assert.deepEqual(agent.cancellations, [], 'a reattachment never cancels the live turn')

  const state = await backend.command('state') as Record<string, unknown>
  assert.equal(state.sessionId, info.sessionId)
  assert.equal(state.status, 'running', 'the live turn is still reported, not cancelled by the reattachment')

  // The attachment is still writable: the persistent fault stays irrelevant.
  await backend.send('after reattach')
  assert.equal(agent.sent.at(-1)?.mode, 'followup')
  const message = agent.sent.at(-1)?.message as { content?: Array<{ text?: string }> }
  assert.equal(message.content?.[0]?.text, 'after reattach')
  await backend.close()
})

test('a same-id reattachment preserves queued input, decisions and the owned handle', async () => {
  const { backend, agents, agent, info, events } = await liveHarness()
  agent.inbox.nextTurn.push({ id: 'q1', content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } })
  agent.inbox.nextStep.push({ id: 'q2', content: [{ type: 'text', text: 'approval policy changed' }], source: { kind: 'user-approval' } })
  assert.equal((await backend.command('state') as Record<string, unknown>).queued, 1)

  agents.failResume = new Error('synthetic native resume fault')
  const resumed = await backend.command('resume', { sessionId: info.sessionId }) as SessionInfo
  assert.equal(resumed.attachmentId, info.attachmentId)

  const state = await backend.command('state') as Record<string, unknown>
  assert.deepEqual(state.pending, { nextTurn: 1, nextStep: 1 }, 'native inbox input is untouched')
  assert.equal(state.queued, 1)
  assert.deepEqual(agent.inbox.nextTurn.map(message => message.id), ['q1'])
  assert.deepEqual(agent.inbox.nextStep.map(message => message.id), ['q2'])
  // The announcement still reaches the UI once, for the unchanged attachment.
  assert.ok(events.some(event => event.type === 'ready' && event.info.attachmentId === info.attachmentId))
  await backend.close()
  assert.equal(agent.disposed, true)
})

test('a native create/setup fault during lazy materialization keeps the staged attachment', async () => {
  const { backend, agents, events } = harness()
  const staged = await backend.connect()
  assert.equal(agents.createCalls.length, 0)

  agents.failSetup = new Error('synthetic native setup fault')
  await assert.rejects(backend.send('first prompt'), (error: unknown) => {
    const failure = errorOf(error)
    assert.equal(failure.code, 'RUNTIME_REQUEST_FAILED')
    assert.match(String(failure.message), /could not create session/)
    return true
  })
  // Nothing was published, so nothing is attached to a half-built Agent.
  assert.equal(agents.agents.length, 0)

  // The staged session (same id and epoch) survives and materializes on retry.
  const state = await backend.command('state') as Record<string, unknown>
  assert.equal(state.sessionId, staged.sessionId)
  assert.equal((await backend.connect()).attachmentId, staged.attachmentId)

  agents.failSetup = undefined
  await backend.send('second prompt')
  assert.equal(agents.createCalls.length, 2)
  assert.equal((agents.createCalls[1] as { sessionId?: string }).sessionId, staged.sessionId)
  const live = agents.agents[0]
  assert.ok(live)
  assert.equal(live.id, staged.sessionId)
  assert.equal(live.sent.length, 1)
  const materialized = await backend.connect()
  assert.equal(materialized.sessionId, staged.sessionId)
  assert.equal(materialized.attachmentId, staged.attachmentId, 'lazy materialization keeps the staged epoch')
  assert.ok(events.some(event => event.type === 'ready' && event.info.attachmentId === staged.attachmentId))
  await backend.close()
})

test('a native create fault during lazy materialization keeps the staged attachment', async () => {
  const { backend, agents } = harness()
  const staged = await backend.connect()
  agents.failCreate = new Error('synthetic native create fault')
  await assert.rejects(backend.send('prompt'), (error: unknown) => {
    assert.equal(errorOf(error).code, 'RUNTIME_REQUEST_FAILED')
    return true
  })
  assert.equal(agents.agents.length, 0)
  assert.equal((await backend.command('state') as Record<string, unknown>).sessionId, staged.sessionId)
  agents.failCreate = undefined
  await backend.send('prompt')
  assert.equal(agents.agents[0]?.id, staged.sessionId)
  await backend.close()
})

test('a failed resume of a different session keeps the current attachment usable', async () => {
  const { backend, agents, agent, info } = await liveHarness()
  agents.failResume = new Error('synthetic native resume fault for another id')
  await assert.rejects(backend.command('resume', { sessionId: 'other-session' }), (error: unknown) => {
    assert.equal(errorOf(error).code, 'RUNTIME_REQUEST_FAILED')
    assert.match(String(errorOf(error).message), /could not resume session "other-session"/)
    return true
  })
  // The candidate never committed, so the previous attachment was never closed.
  assert.equal(agent.disposed, false)
  assert.deepEqual(agent.cancellations, [])
  const state = await backend.command('state') as Record<string, unknown>
  assert.equal(state.sessionId, info.sessionId)
  await backend.send('still attached')
  assert.equal(agent.sent.at(-1)?.mode, 'followup')
  const connected = await backend.connect()
  assert.equal(connected.sessionId, info.sessionId)
  assert.equal(connected.attachmentId, info.attachmentId)
  await backend.close()
})

test('a successful resume of a different session still commits the new attachment', async () => {
  const { backend, agents, info } = await liveHarness()
  const previous = agents.agents[0]
  assert.ok(previous)
  const resumed = await backend.command('resume', { sessionId: 'session-b' }) as SessionInfo
  assert.equal(resumed.sessionId, 'session-b')
  assert.notEqual(resumed.attachmentId, info.attachmentId, 'a real switch takes a new epoch')
  assert.equal(resumed.capabilities.includes('resume'), true)
  assert.equal(agents.resumeCalls.length, 1)
  assert.equal((agents.resumeCalls[0] as { resumeSessionId?: string }).resumeSessionId, 'session-b')
  // The previous Agent is retired only after the replacement committed.
  assert.equal(previous.disposed, true)
  await backend.send('on session b')
  assert.equal(agents.agents.at(-1)?.id, 'session-b')
  await backend.close()
})

test('reattaching the staged pending session reports it instead of resuming it', async () => {
  const { backend, agents } = harness()
  const staged = await backend.connect()
  const again = await backend.command('resume', { sessionId: staged.sessionId }) as SessionInfo
  assert.equal(again.sessionId, staged.sessionId)
  assert.equal(again.attachmentId, staged.attachmentId)
  assert.equal(agents.resumeCalls.length, 0, 'no durable resume for an unmaterialized identity')
  await backend.send('prompt')
  assert.equal(agents.createCalls.length, 1)
  await backend.close()
})