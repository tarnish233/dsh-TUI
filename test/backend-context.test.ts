/**
 * Offline contract tests for the in-process DSH adapter's lifecycle,
 * streaming, decisions, commands, model route, queue and shutdown.
 *
 * Every service is a local fake: no profile, credential, session log, model
 * request or subprocess is touched.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshBackend, type DshContextBackend } from '../src/backend/context.ts'
import type { BackendEvent, PromptContentPart, SessionInfo } from '../src/backend/types.ts'
import { FakeAgentRegistry, FakeDshHost, fakeNativeHelpers, type FakeAgentState } from '../src/backend/testing.ts'

interface Harness {
  host: FakeDshHost
  agents: FakeAgentRegistry
  backend: DshContextBackend
  events: BackendEvent[]
  savedDefaults: Array<Record<string, unknown>>
}

function defaultModelService(saved: Array<Record<string, unknown>>): Record<string, unknown> {
  let current: Record<string, unknown> = { provider: 'p1', model: 'm1' }
  return {
    currentSelection: () => current,
    saveSelection: async (next: Record<string, unknown>) => {
      saved.push(next)
      current = { ...next }
    },
  }
}

function harness(extra: (host: FakeDshHost) => void = () => {}): Harness {
  const host = new FakeDshHost()
  const agents = new FakeAgentRegistry()
  const savedDefaults: Array<Record<string, unknown>> = []
  host.use('agents', agents)
  host.use('agentDefaultModel', defaultModelService(savedDefaults))
  host.use('llm', {
    listProviders: () => [{ id: 'p1', name: 'Provider One' }],
    listModels: async () => [
      { id: 'm1', name: 'Model One', description: 'first' },
      { id: 'm2', name: 'Model Two' },
    ],
    resolveModelInfo: async () => ({
      reasoning: {
        efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
        defaultEffort: 'low',
      },
    }),
  })
  host.use('commands', {
    list: () => [
      { definitionId: 'native.permission', name: 'permission', description: 'Change permissions' },
      { name: 'compact', description: 'Compact', input: { hint: '[focus]' } },
    ],
    execute: async (_agent: unknown, line: string) => ({
      commandId: 'command-1',
      result: { kind: 'success', text: `ran ${line}` },
    }),
  })
  host.use('permissionPresets', {
    catalog: () => ({
      options: [
        { value: 'read-only', name: 'Read only' },
        { value: 'workspace-write', name: 'Workspace write' },
      ],
    }),
    current: () => 'workspace-write',
  })
  host.use('agentPresets', {
    defaultId: 'standard',
    list: async () => [
      { id: 'standard', name: 'Standard' },
      { id: 'minimal', name: 'Minimal' },
      { id: 'broken', broken: 'missing tool' },
    ],
    resolve: async (id?: string) => {
      const resolved = id ?? 'standard'
      if (resolved === 'unknown') return { id: 'unknown', broken: 'not declared' }
      return { id: resolved }
    },
    select: async () => 'standard',
    presetForSession: () => null,
    composedPreset: () => undefined,
  })
  extra(host)
  const backend = createDshBackend(host, {
    cwd: '/workspace',
    native: fakeNativeHelpers(),
    warn: () => {},
  })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  return { host, agents, backend, events, savedDefaults }
}

function latestAgent(harnessValue: { agents: FakeAgentRegistry }): FakeAgentState {
  const agent = harnessValue.agents.agents[harnessValue.agents.agents.length - 1]
  assert.ok(agent, 'the fake registry created an Agent')
  return agent
}

async function connected(extra?: (host: FakeDshHost) => void): Promise<Harness & { info: SessionInfo }> {
  const value = harness(extra)
  const info = await value.backend.connect()
  return { ...value, info }
}

test('connect enters a pending session without creating an Agent', async () => {
  const { backend, agents, events, info } = await connected()
  assert.equal(agents.createCalls.length, 0)
  assert.equal(agents.resumeCalls.length, 0)
  assert.equal(typeof info.sessionId, 'string')
  assert.equal(typeof info.attachmentId, 'string')
  assert.equal(info.cwd, '/workspace')
  assert.equal(info.provider, 'p1')
  assert.equal(info.model, 'm1')
  assert.ok(info.capabilities.includes('state'))
  assert.ok(info.capabilities.includes('commands'))
  assert.ok(info.capabilities.includes('model'))
  assert.equal(events.filter(event => event.type === 'ready').length, 1)
  const ready = events.find(event => event.type === 'ready')
  assert.equal(ready?.type === 'ready' ? ready.info.sessionId : undefined, info.sessionId)
  const state = await backend.command('state') as Record<string, unknown>
  assert.equal(state.sessionId, info.sessionId)
  assert.equal(state.status, 'idle')
  assert.deepEqual(state.pending, { nextTurn: 0, nextStep: 0 })
  assert.equal(agents.createCalls.length, 0, 'state must not materialize a pending session')
  await backend.close()
})

test('send lazily materializes the same session and forwards native stream facts', async () => {
  const { backend, agents, events, info } = await connected()
  await backend.send('hello')
  assert.equal(agents.createCalls.length, 1)
  const created = agents.createCalls[0] as Record<string, unknown>
  assert.equal(created.sessionId, info.sessionId)
  assert.deepEqual(
    (created.meta as Record<string, unknown>).cwd,
    '/workspace',
  )
  const agent = latestAgent({ agents })
  assert.equal(agent.sent.length, 1)
  assert.equal(agent.sent[0]?.mode, 'followup')
  const ready = events.filter(event => event.type === 'ready').at(-1)
  assert.equal(ready?.type === 'ready' ? ready.info.sessionId : undefined, info.sessionId)
  assert.equal(ready?.type === 'ready' ? ready.info.attachmentId : undefined, info.attachmentId)

  const start = { type: 'start', attemptId: 'attempt-1', revision: 2, turn: 1, step: 1 }
  const chunk = { type: 'chunk', attemptId: 'attempt-1', revision: 3, index: 0, time: 1234, chunk: { type: 'text-delta', index: 0, text: 'hi' } }
  const end = { type: 'end', attemptId: 'attempt-1', revision: 4, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 } }
  for (const frame of [start, chunk, end]) {
    harnessValueEmit(agents.agents.at(-1), frame)
  }
  const streamEvents = events.filter(event => event.type.startsWith('stream_'))
  assert.equal(streamEvents.length, 3)
  const startEvent = streamEvents[0]
  assert.deepEqual(startEvent, {
    type: 'stream_start', sessionId: info.sessionId, attemptId: 'attempt-1', revision: 2, turn: 1, step: 1,
  })
  const chunkEvent = streamEvents[1]
  assert.equal(chunkEvent.type, 'stream_chunk')
  if (chunkEvent.type === 'stream_chunk') {
    assert.equal(chunkEvent.revision, 3)
    assert.equal(chunkEvent.index, 0)
    assert.equal(chunkEvent.time, 1234)
    assert.deepEqual(chunkEvent.chunk, { type: 'text-delta', index: 0, text: 'hi' })
  }
  const endEvent = streamEvents[2]
  assert.deepEqual(endEvent, {
    type: 'stream_end', sessionId: info.sessionId, attemptId: 'attempt-1', revision: 4, outcome: 'committed', seq: 9,
  })
  await backend.close()

  function harnessValueEmit(target: FakeAgentState | undefined, frame: Record<string, unknown>): void {
    assert.ok(target)
    // The listener lives on the harness host; resolve it from the backend's
    // registered listener through the event capture in this test.
    const host = (backend as unknown as { host: FakeDshHost }).host
    host.emit('agent/assistant-stream', { agent: target, frame })
  }
})

test('late stream/session events from a retired attachment are ignored', async () => {
  const { backend, agents, events, info } = await connected()
  await backend.send('one')
  const first = agents.agents[0]
  assert.ok(first)
  const replaced = await backend.command('new') as SessionInfo
  assert.notEqual(replaced.attachmentId, info.attachmentId)
  const before = events.length
  const host = (backend as unknown as { host: FakeDshHost }).host
  host.emit('agent/assistant-stream', { agent: first, frame: { type: 'start', attemptId: 'old', revision: 1, turn: 1, step: 1 } })
  host.emit('session/event', first.session, { type: 'user/message', seq: 3, data: {}, surfaceOp: 'append' })
  assert.equal(events.length, before, 'old attachment facts never reach the UI')
  await backend.close()
})

test('approval and question decisions settle through the native waterfall', async () => {
  const { backend, agents, events } = await connected()
  await backend.send('prompt')
  const agent = agents.agents[0]
  assert.ok(agent)
  const host = (backend as unknown as { host: FakeDshHost }).host
  const controller = new AbortController()
  const approval = host.waterfall('approval/request', { agent, toolName: 'bash', reason: 'list files', signal: controller.signal })
  const decision = events.find(event => event.type === 'decision')
  assert.ok(decision && decision.type === 'decision')
  assert.equal(decision.request.kind, 'approval')
  assert.equal(decision.request.title, 'Approve bash')
  assert.equal(decision.request.message, 'list files')
  assert.deepEqual(decision.request.options?.map(option => option.value), ['allowed-once', 'rejected'])
  await backend.respond(decision.request.id, 'allowed-once')
  assert.equal(await approval, 'allowed-once')
  assert.ok(events.some(event => event.type === 'decision_closed' && event.id === decision.request.id))

  const question = host.waterfall('user-questions/request', {
    agent,
    questions: [{
      id: 'q1',
      question: 'Pick one',
      header: 'Choice',
      detail: 'details',
      multiSelect: false,
      options: [{ label: 'A', description: 'first' }, { label: 'B' }],
      intent: { kind: 'plan-review', approve: 'A' },
    }],
  })
  const questionEvent = events.filter(event => event.type === 'decision').at(-1)
  assert.ok(questionEvent?.type === 'decision')
  await backend.respond(questionEvent.request.id, { answers: [['A']] })
  assert.deepEqual(await question, { answers: [{ id: 'q1', selected: ['A'] }] })

  const cancelledQuestion = host.waterfall('user-questions/request', {
    agent,
    questions: [{ id: 'q2', question: 'Cancel me', options: [{ label: 'A' }] }],
  })
  const cancelEvent = events.filter(event => event.type === 'decision').at(-1)
  assert.ok(cancelEvent?.type === 'decision')
  await backend.respond(cancelEvent.request.id, { cancelled: true })
  await assert.rejects(cancelledQuestion, (error: unknown) => (error as { code?: string }).code === 'ASK_CANCELLED')

  const aborted = host.waterfall('user-questions/request', {
    agent,
    questions: [{ id: 'q3', question: 'Abort me', options: [{ label: 'A' }] }],
    signal: controller.signal,
  })
  const abortEvent = events.filter(event => event.type === 'decision').at(-1)
  assert.ok(abortEvent?.type === 'decision')
  controller.abort()
  await assert.rejects(aborted, (error: unknown) => (error as { code?: string }).code === 'ASK_ABORTED')
  await backend.close()
})

test('a decision for another Agent falls through to the next native answerer', async () => {
  const { backend, agents } = await connected()
  await backend.send('prompt')
  const host = (backend as unknown as { host: FakeDshHost }).host
  const foreign = { id: 'other' }
  let delegated = false
  await host.waterfall('approval/request', { agent: foreign, toolName: 'bash' }, async () => {
    delegated = true
    return 'rejected'
  })
  assert.equal(delegated, true)
  assert.equal(agents.agents.length, 1)
  await backend.close()
})

test('cancel keeps the native inbox and settles pending decisions', async () => {
  const { backend, agents, events } = await connected()
  await backend.send('prompt')
  const agent = agents.agents[0]
  assert.ok(agent)
  agent.status = 'running'
  const host = (backend as unknown as { host: FakeDshHost }).host
  const pending = host.waterfall('approval/request', { agent, toolName: 'bash' })
  assert.ok(events.some(event => event.type === 'decision'))
  await backend.cancel()
  assert.deepEqual(agent.cancellations.at(-1), { cause: 'user', keepInbox: true })
  assert.equal(await pending, 'cancelled')
  await backend.close()
})

test('native command catalog and execution are forwarded without a second registry', async () => {
  const { backend, agents, info } = await connected()
  const descriptors = await backend.command('commands') as Array<Record<string, unknown>>
  assert.deepEqual(descriptors.map(item => item.name), ['permission', 'compact'])
  assert.equal(descriptors[0]?.definitionId, 'native.permission')
  assert.deepEqual(descriptors[1]?.input, { hint: '[focus]' })
  assert.equal(agents.createCalls.length, 0, 'listing commands never materializes an Agent')
  await backend.send('prompt')
  assert.equal(agents.createCalls.length, 1)
  const execution = await backend.command('execute', { line: '/permission read-only' }) as Record<string, unknown>
  assert.equal(execution.commandId, 'command-1')
  assert.deepEqual(execution.result, { kind: 'success', text: 'ran /permission read-only' })
  await assert.rejects(backend.command('nope'), /unsupported command/)
  assert.ok(info.sessionId)
  await backend.close()
})

test('model, effort and preset stage on a pending session and write the native slot when live', async () => {
  const { backend, agents, savedDefaults } = await connected()
  const llmCalls: string[] = []
  const metadataCalls: string[] = []
  const host = (backend as unknown as { host: FakeDshHost }).host
  host.use('llm', {
    listProviders: () => { llmCalls.push('listProviders'); return [{ id: 'p1', name: 'Provider One' }] },
    listModels: async (providerId: string) => {
      llmCalls.push(`listModels(${providerId})`)
      // Real 0.2.2 list DTOs do not carry reasoning metadata.
      return [
        { id: 'm1', name: 'Model One', description: 'first' },
        { id: 'm2', name: 'Model Two' },
      ]
    },
    resolveModelInfo: async (provider: string, model: string) => {
      metadataCalls.push(`${provider}/${model}`)
      return { reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } }
    },
  })
  const models = await backend.command('models') as Array<Record<string, unknown>>
  assert.deepEqual(llmCalls, ['listProviders', 'listModels(p1)'], 'rows come from the mounted native LLM registry')
  assert.deepEqual(metadataCalls, [], 'listing never prefetches reasoning per row')
  assert.equal(models.length, 2)
  assert.equal(models[0]?.id, 'p1/m1')
  assert.equal(models[0]?.isDefault, true)
  const staged = await backend.command('model', { id: 'p1/m2' }) as Record<string, unknown>
  assert.deepEqual(metadataCalls, ['p1/m2'], 'only the selected target resolves reasoning')
  assert.equal(staged.reasoningEffort, undefined, 'no explicit level was carried')
  assert.equal(staged.model, 'm2')
  assert.equal(staged.defaultPersistence, 'native')
  assert.equal(agents.createCalls.length, 0, 'a pending model choice creates no Agent')
  assert.equal(savedDefaults.at(-1)?.model, 'm2')

  const pendingState = await backend.command('state') as Record<string, unknown>
  assert.equal(pendingState.model, 'm2')

  const presets = await backend.command('presets') as Record<string, unknown>
  assert.equal(presets.blank, true)
  assert.equal(presets.default, 'standard')
  const stagedPreset = await backend.command('preset', { id: 'minimal' }) as SessionInfo
  assert.equal(stagedPreset.preset, 'minimal')
  assert.equal(agents.createCalls.length, 0)

  await backend.send('go')
  const agent = agents.agents[0]
  assert.ok(agent)
  const created = agents.createCalls[0] as Record<string, unknown>
  assert.deepEqual(created.agentOptions, { provider: 'p1', model: 'm2' })
  assert.equal((created.meta as Record<string, unknown>).agentPreset, 'minimal')

  const efforts = await backend.command('efforts') as Record<string, unknown>
  assert.equal(efforts.provider, 'p1')
  assert.equal(efforts.model, 'm2')
  assert.equal(efforts.available, true)
  const appliedEffort = await backend.command('effort', { id: 'high' }) as Record<string, unknown>
  assert.equal(appliedEffort.effectiveEffort, 'high')
  assert.deepEqual(agent.route, { provider: 'p1', model: 'm2', reasoningEffort: 'high' })

  metadataCalls.length = 0
  const live = await backend.command('model', { id: 'p1/m1' }) as Record<string, unknown>
  assert.deepEqual(metadataCalls, ['p1/m1'], 'the live target resolves reasoning after selection')
  assert.equal(live.model, 'm1')
  assert.deepEqual(agent.route, { provider: 'p1', model: 'm1', reasoningEffort: 'high' })
  const livePreset = await backend.command('preset', { id: 'standard' }) as Record<string, unknown>
  assert.equal(livePreset.locked, true)
  assert.equal((await backend.command('permissions') as Record<string, unknown>).currentValue, 'workspace-write')
  await backend.close()
})

test('model selection preserves an explicit effort only when the target advertises it', async () => {
  const { backend, agents } = await connected()
  await backend.send('prompt')
  const agent = agents.agents[0]
  assert.ok(agent)
  const host = (backend as unknown as { host: FakeDshHost }).host
  host.use('llm', {
    listProviders: () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
    resolveModelInfo: async (_provider: string, model: string) => ({
      reasoning: model === 'm1'
        ? { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' }
        : { efforts: [{ id: 'low' }], defaultEffort: 'low' },
    }),
  })
  await backend.command('effort', { id: 'high' })
  assert.deepEqual(agent.route, { provider: 'p1', model: 'm1', reasoningEffort: 'high' })
  await backend.command('model', { id: 'p1/m2' })
  assert.deepEqual(agent.route, { provider: 'p1', model: 'm2' }, 'the target native default applies when high is not advertised')
  await backend.command('model', { id: 'p1/m1' })
  assert.deepEqual(agent.route, { provider: 'p1', model: 'm1' }, 'a dropped level is not resurrected')
  await backend.close()
})

test('model selection still works when native reasoning metadata is unavailable', async () => {
  const { backend, agents } = await connected()
  await backend.send('prompt')
  const agent = agents.agents[0]
  assert.ok(agent)
  const host = (backend as unknown as { host: FakeDshHost }).host
  host.use('llm', {
    listProviders: () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }], defaultEffort: 'high' } }),
  })
  await backend.command('effort', { id: 'high' })
  host.use('llm', {
    listProviders: () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
  })
  const result = await backend.command('model', { id: 'p1/m2' }) as Record<string, unknown>
  assert.equal(result.model, 'm2')
  assert.deepEqual(agent.route, { provider: 'p1', model: 'm2' }, 'no fabricated level; the native default applies')
  await backend.close()
})

test('a completed metadata read never overwrites a switched attachment', async () => {
  const { backend, agents } = await connected()
  await backend.send('prompt')
  const agent = agents.agents[0]
  assert.ok(agent)
  const host = (backend as unknown as { host: FakeDshHost }).host
  let release: () => void = () => {}
  const metadata = new Promise<unknown>(resolve => {
    release = () => resolve({ reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'low' } })
  })
  host.use('llm', {
    listProviders: () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'low' } }),
  })
  await backend.command('model', { id: 'p1/m2' })
  host.use('llm', {
    listProviders: () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }, { id: 'm2' }],
    resolveModelInfo: async () => await metadata,
  })
  const selecting = backend.command('model', { id: 'p1/m1' })
  const replaced = await backend.command('new') as SessionInfo
  release()
  await assert.rejects(selecting, (error: unknown) => (error as { code?: string }).code === 'STALE_SESSION')
  assert.deepEqual(agent.route, { provider: 'p1', model: 'm2' }, 'the retired Agent route is untouched')
  const pending = await backend.command('state') as Record<string, unknown>
  assert.equal(pending.sessionId, replaced.sessionId)
  assert.equal(pending.model, 'm2', 'the new pending route comes from the saved native default, not the stale selection')
  await backend.close()
})

test('state, queue recall and dequeue share one recallability rule', async () => {
  const { backend, agents } = await connected()
  await backend.send('prompt')
  const agent = agents.agents[0]
  assert.ok(agent)
  agent.inbox.nextTurn.push(
    { id: 'm1', content: [{ type: 'text', text: 'queued one' }], source: { kind: 'user' } },
    { id: 'm2', content: [{ type: 'text', text: 'approval policy changed' }], source: { kind: 'user-approval' } },
  )
  agent.inbox.nextStep.push(
    { id: 'm3', content: [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 2, height: 2 } }], source: { kind: 'user' } },
    { id: 'm4', content: [{ type: 'file', path: '/x' }], source: { kind: 'user' } },
  )
  const state = await backend.command('state') as Record<string, unknown>
  assert.deepEqual(state.pending, { nextTurn: 2, nextStep: 2 })
  assert.equal(state.queued, 2)
  assert.equal(state.usage, null)
  assert.deepEqual((state.queue as Array<{ messageId: string }>).map(row => row.messageId), ['m1', 'm3'])
  const removed = await backend.command('dequeue') as Array<Record<string, unknown>>
  assert.equal(removed.length, 2)
  assert.equal(removed[0]?.text, 'queued one')
  assert.equal(removed[1]?.target, 'next-step')
  const attachment = (removed[1]?.content as Array<Record<string, unknown>>)[0]?.attachment
  assert.deepEqual(attachment, { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 2, height: 2 })
  assert.deepEqual(agent.inbox.nextTurn.map(message => message.id), ['m2'])
  assert.deepEqual(agent.inbox.nextStep.map(message => message.id), ['m4'])
  assert.equal((await backend.command('state') as Record<string, unknown>).queued, 0)
  await backend.close()
})

test('queue rows can be replaced, removed, or sent now without dropping the rest', async () => {
  const { backend, agents } = await connected()
  await backend.send('prompt')
  const agent = agents.agents[0]
  assert.ok(agent)
  agent.status = 'running'
  agent.inbox.nextTurn.push(
    { id: 'm1', content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } },
    { id: 'm2', content: [{ type: 'text', text: 'approval policy changed' }], source: { kind: 'user-approval' } },
    { id: 'm3', content: [{ type: 'text', text: 'third' }], source: { kind: 'user' } },
  )
  const replaced = await backend.command('queue-replace', { messageId: 'm1', text: 'first edited' }) as { messageId: string }
  assert.notEqual(replaced.messageId, 'm1')
  assert.equal((agent.inbox.nextTurn[0]?.content as Array<{ text?: string }>)[0]?.text, 'first edited')
  assert.equal(agent.inbox.nextTurn[1]?.id, 'm2', 'non-user inbox context stays in place')

  await backend.command('queue-remove', { messageId: replaced.messageId })
  assert.deepEqual(agent.inbox.nextTurn.map(message => message.id), ['m2', 'm3'])
  assert.deepEqual(await backend.command('queue-remove', { messageId: 'm2' }), { removed: false })
  assert.deepEqual(await backend.command('queue-remove', { messageId: replaced.messageId }), { removed: false })
  assert.deepEqual(agent.inbox.nextTurn.map(message => message.id), ['m2', 'm3'])

  agent.status = 'running'
  const sent = await backend.command('queue-send-now', { messageId: 'm3' }) as { messageId: string }
  assert.equal(sent.messageId, 'm3')
  assert.equal(agent.cancellations.at(-1)?.keepInbox, true)
  assert.equal(agent.sent.at(-1)?.mode, 'followup')
  assert.equal((agent.sent.at(-1)?.message as { id?: string }).id, 'm3')
  assert.deepEqual(agent.inbox.nextTurn.map(message => message.id), ['m2'])
  await backend.close()
})

test('close disposes only adapter-owned listeners and the owned Agent handle', async () => {
  const { backend, agents, events, host } = await connected((fakeHost) => {
    fakeHost.use('appExit', () => { throw new Error('the adapter must never request app exit') })
  })
  await backend.send('prompt')
  const agent = agents.agents[0]
  assert.ok(agent)
  await backend.close()
  assert.equal(agent.disposed, true)
  assert.deepEqual(agent.cancellations.at(-1), { cause: 'user', keepInbox: true })
  assert.equal(host.listenerCount('agent/assistant-stream'), 0)
  assert.equal(events.filter(event => event.type === 'closed').length, 1)
  await backend.close()
  assert.equal(events.filter(event => event.type === 'closed').length, 1, 'closed is announced once')
})

test('sendContent text-only delegates to the normal native message path', async () => {
  const { backend, agents } = await connected()
  const content: PromptContentPart[] = [{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }]
  await backend.sendContent(content)
  assert.equal(agents.createCalls.length, 1)
  const agent = agents.agents[0]
  assert.ok(agent)
  const message = agent.sent[0]?.message as Record<string, unknown>
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello\nworld' }])
  await backend.close()
})