/**
 * Offline contract tests for the in-process DSH adapter's lifecycle,
 * streaming, decisions, commands, model route, queue and shutdown.
 *
 * Every service is a local fake: no profile, credential, session log, model
 * request or subprocess is touched.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { createDshBackend, type DshContextBackend } from '../src/backend/context.ts'
import { BackendError } from '../src/backend/errors.ts'
import type { BackendEvent, PromptContentPart, SessionInfo } from '../src/backend/types.ts'
import { FakeAgentRegistry, FakeDshHost, fakeNativeHelpers, nextTask, type FakeAgentState } from '../src/backend/testing.ts'

interface Harness {
  host: FakeDshHost
  agents: FakeAgentRegistry
  backend: DshContextBackend
  events: BackendEvent[]
  savedDefaults: Array<Record<string, unknown>>
  /** Native turn-boundary fact the fake Agent registry reports for the live session. */
  turns: { openTurnStartSeq: number | null; lastTurn: number }
  /** Exact Agents the native preset selector was asked about. */
  presetSelects: unknown[]
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
  const turns = { openTurnStartSeq: null as number | null, lastTurn: 0 }
  const presetSelects: unknown[] = []
  // Native-shaped turn boundary: the blank check is a registry read, never a
  // projection stateOf guess.
  Object.assign(agents, { turnBoundaryOf: () => ({ ...turns, lastStepStartSeq: null, lastStepBoundary: null }) })
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
    select: async (agent: unknown) => {
      presetSelects.push(agent)
      // The native selector owns the locked rule: a session that already started
      // a turn keeps its composition.
      if (turns.lastTurn > 0 || turns.openTurnStartSeq !== null) {
        throw Object.assign(new Error('agent preset is locked to the started session'), { code: 'agent-preset/locked' })
      }
      return 'standard'
    },
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
  return { host, agents, backend, events, savedDefaults, turns, presetSelects }
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
  const { backend, agents, savedDefaults, turns, presetSelects } = await connected()
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
  assert.equal(presets.blank, true, 'a pending attachment is blank by construction')
  assert.equal(presets.default, 'standard')
  const stagedPreset = await backend.command('preset', { id: 'minimal' }) as SessionInfo
  assert.equal(stagedPreset.preset, 'minimal')
  assert.equal(agents.createCalls.length, 0)
  assert.deepEqual(presetSelects, [], 'a pending preset only stages; no Agent is selected')

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
  const livePresets = await backend.command('presets') as Record<string, unknown>
  assert.equal(livePresets.blank, true, 'the native turn boundary proves this session never started a turn')

  // The adapter never pre-judges the blank/locked rule: it forwards to the
  // native selector on the exact captured Agent, and only the native rejection
  // (code `agent-preset/locked`) becomes a locked answer.
  const blankSwitch = await backend.command('preset', { id: 'standard' }) as Record<string, unknown>
  assert.equal(presetSelects.at(-1), agent, 'the native selector receives the exact live Agent')
  assert.equal(blankSwitch.locked, undefined, 'a blank session switches without a fabricated lock')
  assert.equal((blankSwitch.preset as string | undefined) ?? 'standard', 'standard')

  turns.lastTurn = 1
  turns.openTurnStartSeq = 7
  const started = await backend.command('presets') as Record<string, unknown>
  assert.equal(started.blank, false, 'a recorded turn is a native non-blank fact')
  const livePreset = await backend.command('preset', { id: 'minimal' }) as Record<string, unknown>
  assert.equal(livePreset.locked, true, 'the native selector owns the lock')
  assert.equal(livePreset.id, 'minimal')
  assert.equal(presetSelects.length, 2, 'the locked answer still came from one native select call')
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

test('/new uses the staged native preset supplied by the UI', async () => {
  const { backend, agents } = await connected()
  await backend.command('new', { preset: 'minimal' })
  await backend.send('go')
  const created = agents.createCalls.at(-1) as Record<string, unknown> | undefined
  assert.ok(created)
  assert.equal((created.meta as Record<string, unknown>).agentPreset, 'minimal')
  await backend.close()
})

test('queue-send-now keeps the original native entry when attachment admission fails', async () => {
  const { backend, agents } = await connected((host) => {
    host.use('attachments', { admitPromptContent: async () => { throw new Error('synthetic admission refusal') } })
  })
  await backend.send('prompt')
  const agent = agents.agents[0]
  assert.ok(agent)
  agent.inbox.nextTurn.push({
    id: 'queued-image', content: [{ type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 10, width: 2, height: 2 } }], source: { kind: 'user' },
  })
  await assert.rejects(
    backend.command('queue-send-now', {
      messageId: 'queued-image',
      content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }],
    }),
    /admission|refused|not sent/i,
  )
  assert.deepEqual(agent.inbox.nextTurn.map(message => message.id), ['queued-image'], 'a rejected replacement must not remove the original')
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
// ---------------------------------------------------------------------------
// Lifecycle, queue and native-error hardening regressions.
//
// Each test names the invariant it protects: the adapter must not lose the
// user's native queue, must not announce `closed` before its own cleanup
// settled, must not create a ghost session for a read-only command, and must
// never forward an unredacted native rejection.
// ---------------------------------------------------------------------------

/** One recallable queued row, in the exact native user-message shape. */
function queueRow(id: string, text: string): { id: string; content: Array<{ type: 'text'; text: string }>; source: { kind: string } } {
  return { id, content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function laneIds(agent: FakeAgentState): { nextTurn: string[]; nextStep: string[] } {
  return {
    nextTurn: agent.inbox.nextTurn.map(message => message.id),
    nextStep: agent.inbox.nextStep.map(message => message.id),
  }
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => (error as { code?: unknown }).code === code
}

/** Adapter-owned command carriers; read through a structural cast, never `any`. */
function activeCommandCount(backend: DshContextBackend): number {
  return (backend as unknown as { activeCommands: Map<string, unknown> }).activeCommands.size
}

/**
 * A native command registry whose `execute` only settles when its carrier
 * signal aborts: one uncooperative, long-running native command.
 */
function heldCommands(): { service: Record<string, unknown>; started: () => number } {
  let started = 0
  return {
    started: () => started,
    service: {
      list: () => [],
      execute: (_agent: unknown, _line: string, _parts: readonly unknown[], signal: AbortSignal): Promise<never> => {
        started += 1
        return new Promise<never>((_resolve, reject) => {
          const abort = (): void => reject(Object.assign(new Error('the native command was cancelled'), { code: 'ABORTED' }))
          if (signal.aborted) abort()
          else signal.addEventListener('abort', abort, { once: true })
        })
      },
    },
  }
}

const IMAGE_REF = { attachmentId: 'image-1', mediaType: 'image/png' as const, bytes: 10, width: 2, height: 2 }

/**
 * The session-less command list exactly as documented.
 *
 * `docs/BACKEND.md` derives that list from the single `COMMAND_DECLARATIONS`
 * table; parsing the document here is what keeps the document, the table and
 * the observable behavior from drifting apart again.
 */
function documentedSessionlessCommands(): string[] {
  const text = readFileSync(new URL('../docs/BACKEND.md', import.meta.url), 'utf8')
  const statement = /Session-less commands \(([^)]*)\)/u.exec(text)
  assert.ok(statement, 'docs/BACKEND.md states the session-less command list')
  return [...statement[1].matchAll(/`([a-z0-9][a-z0-9-]*)`/gu)].map(match => match[1])
}

test('queue-send-now restores the exact native queue when the wake is refused', async () => {
  const { backend, agents } = await connected()
  await backend.send('prompt')
  const agent = latestAgent({ agents })
  agent.status = 'running'
  const m1 = queueRow('m1', 'first')
  const m2 = queueRow('m2', 'second')
  agent.inbox.nextTurn.push(m1, m2)
  agent.inbox.nextStep.push(queueRow('m3', 'next step'))
  const before = laneIds(agent)
  const refusal = Object.assign(new Error('agent "x" is not live'), { code: 'AGENT_NOT_LIVE' })
  // The public wake is the only step that can refuse after the queue moved.
  agent.followup = () => { throw refusal }
  await assert.rejects(
    backend.command('queue-send-now', { messageId: 'm1' }),
    (error: unknown) => error === refusal,
  )
  assert.deepEqual(laneIds(agent), before, 'a refused wake leaves both native lanes exactly as they were')
  assert.equal(agent.inbox.nextTurn[0], m1, 'the same native message object is restored, not a copy')
  assert.equal(agent.inbox.nextTurn[1], m2)
  await backend.close()
})

test('repeated close joins the first owned cleanup and announces closed once, after it settles', async () => {
  const steps: string[] = []
  let releaseFlush: () => void = () => {}
  const flushing = new Promise<void>((resolve) => { releaseFlush = resolve })
  const { backend, agents, events, turns } = await connected((host) => {
    host.use('sessions', {
      flush: async (): Promise<void> => {
        steps.push('flush:start')
        await flushing
        steps.push('flush:end')
      },
    })
  })
  await backend.send('prompt')
  const agent = latestAgent({ agents })
  // A recorded turn is the native fact that makes the retirement flush real.
  turns.lastTurn = 1
  backend.onEvent((event) => { if (event.type === 'closed') steps.push('closed') })

  const first = backend.close()
  const second = backend.close()
  let secondSettled = false
  void second.then(() => { secondSettled = true }, () => { secondSettled = true })
  await nextTask()
  assert.deepEqual(steps, ['flush:start'], 'the joining close neither settles nor announces closed early')
  assert.equal(secondSettled, false)

  releaseFlush()
  await Promise.all([first, second])
  assert.deepEqual(steps, ['flush:start', 'flush:end', 'closed'], 'closed follows the settled cleanup')
  assert.equal(events.filter(event => event.type === 'closed').length, 1, 'closed is announced exactly once')
  assert.equal(agent.disposed, true)
})

test('a cleanup rejection still announces closed exactly once for every joining close', async () => {
  const { backend, agents, events } = await connected()
  await backend.send('prompt')
  const agent = latestAgent({ agents })
  // A native attachment that fails while it is being retired: the adapter's
  // own announcement must survive the failure and stay single.
  Object.defineProperty(agent.session, 'id', {
    configurable: true,
    get() { throw new Error('synthetic native cleanup failure') },
  })
  const first = backend.close()
  const second = backend.close()
  await assert.rejects(first, /synthetic native cleanup failure/)
  await assert.rejects(second, /synthetic native cleanup failure/)
  assert.equal(events.filter(event => event.type === 'closed').length, 1)
})

test('every documented session-less command answers without materializing the pending Agent', async () => {
  const names = documentedSessionlessCommands()
  for (const name of ['permissions', 'queue-remove', 'efforts']) {
    assert.ok(names.includes(name), `${name} is documented as session-less`)
  }
  for (const name of names) {
    const h = await connected()
    assert.deepEqual(h.agents.createCalls, [])
    // An unmounted native service may still reject; the invariant is that a
    // session-less command never creates the pending Session's Agent.
    await h.backend.command(name).catch(() => undefined)
    assert.deepEqual(h.agents.createCalls, [], `${name} must not materialize a pending session`)
    await h.backend.close()
  }
})

test('read-only commands report structured pending facts instead of creating a session', async () => {
  const { backend, agents } = await connected()
  const permissions = await backend.command('permissions') as {
    options?: Array<{ value?: unknown }>
    currentValue?: unknown
  }
  assert.deepEqual(permissions.options?.map(option => option.value), ['read-only', 'workspace-write'])
  assert.equal(permissions.currentValue, undefined, 'a pending attachment has no native current value')
  assert.deepEqual(await backend.command('queue-remove', { messageId: 'm1' }), { removed: false })
  const efforts = await backend.command('efforts') as {
    provider?: string
    model?: string
    available?: boolean
    efforts?: Array<{ id?: unknown }>
  }
  assert.equal(efforts.provider, 'p1', 'the pending route is the native default, not a created Agent')
  assert.equal(efforts.model, 'm1')
  assert.equal(efforts.available, true)
  assert.deepEqual(efforts.efforts?.map(level => level.id), ['low', 'high'])
  assert.deepEqual(agents.createCalls, [], 'no read-only command materialized the pending Agent')
  await backend.close()
})

test('native image-read and command refusals keep a code and redact credentials', async () => {
  const secret = 'sk-live-abcdef123456'
  const { backend } = await connected((host) => {
    host.use('attachments', {
      readImage: async (): Promise<never> => { throw new Error(`Authorization: Bearer ${secret}`) },
    })
    host.use('commands', {
      list: () => [],
      execute: async (): Promise<never> => { throw new Error(`api_key=${secret}`) },
    })
  })
  const image = await backend.readImage(IMAGE_REF).catch((error: unknown) => error)
  assert.ok(image instanceof BackendError, 'the image-read rejection is a coded BackendError')
  assert.equal(typeof image.code, 'string')
  assert.equal(image.message.includes(secret), false, 'the bearer token never reaches the UI')
  assert.match(image.message, /\[redacted\]/u)

  await backend.send('prompt')
  const command = await backend.command('execute', { line: '/compact' }).catch((error: unknown) => error)
  assert.ok(command instanceof BackendError, 'the native command rejection is a coded BackendError')
  assert.equal(command.code, 'RUNTIME_REQUEST_FAILED')
  assert.equal(command.message.includes(secret), false, 'the API key never reaches the UI')
  assert.match(command.message, /\[redacted\]/u)
  await backend.close()
})

test('cancellation keeps its own code on the image and command seams', async () => {
  const holding = await connected((host) => {
    host.use('attachments', {
      readImage: async (_ref: unknown, signal?: AbortSignal): Promise<never> => new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('the native read was aborted')), { once: true })
      }),
    })
  })
  const controller = new AbortController()
  const reading = holding.backend.readImage(IMAGE_REF, controller.signal)
  await nextTask()
  controller.abort()
  await assert.rejects(reading, hasCode('ABORTED'))
  await holding.backend.close()

  const held = heldCommands()
  const running = await connected((host) => { host.use('commands', held.service) })
  await running.backend.send('prompt')
  const executing = running.backend.command('execute', { line: '/compact' })
  await nextTask()
  await running.backend.cancel()
  await assert.rejects(executing, hasCode('ABORTED'))
  await running.backend.close()
})

test('/reload reconciles the profile on a pending session without materializing it', async () => {
  const calls: string[] = []
  const { backend, agents, events, info } = await connected((host) => {
    host.use('hmr', {
      runExclusive: async (operation: () => Promise<unknown>): Promise<unknown> => {
        calls.push('exclusive')
        return await operation()
      },
      reconcileProfile: async (): Promise<unknown> => {
        calls.push('reconcile')
        return { warnings: ['native warning'], pending: [] }
      },
    })
  })
  const result = await backend.command('reload') as Record<string, unknown>
  assert.deepEqual(calls, ['exclusive', 'reconcile'], 'a pending session runs the same single-step native reload')
  assert.equal(result.available, true)
  assert.deepEqual(result.warnings, ['native warning'])
  const refreshed = result.info as SessionInfo
  assert.equal(refreshed.sessionId, info.sessionId, 'the refreshed info is the same pending attachment')
  assert.equal(refreshed.attachmentId, info.attachmentId)
  assert.deepEqual(agents.createCalls, [], 'reload never materializes the pending Agent')
  assert.equal(events.filter(event => event.type === 'ready').length, 1, '/reload does not replay ready')
  await backend.close()
})

test('/reload still refuses while one of its own native commands is unsettled', async () => {
  const held = heldCommands()
  const { backend } = await connected((host) => {
    host.use('commands', held.service)
    host.use('hmr', {
      runExclusive: async (operation: () => Promise<unknown>): Promise<unknown> => await operation(),
      reconcileProfile: async (): Promise<unknown> => ({}),
    })
  })
  await backend.send('prompt')
  const executing = backend.command('execute', { line: '/compact' })
  await nextTask()
  assert.equal(held.started(), 1)
  await assert.rejects(backend.command('reload'), /wait for the current turn/u)
  await backend.cancel()
  await assert.rejects(executing, hasCode('ABORTED'))
  const result = await backend.command('reload') as Record<string, unknown>
  assert.equal(result.available, true, 'a settled command no longer blocks the native reload')
  await backend.close()
})

test('/reload refuses while a native decision is still open', async () => {
  const { backend, agents, events } = await connected((host) => {
    host.use('hmr', {
      runExclusive: async (operation: () => Promise<unknown>): Promise<unknown> => await operation(),
      reconcileProfile: async (): Promise<unknown> => ({}),
    })
  })
  await backend.send('prompt')
  const agent = latestAgent({ agents })
  const host = (backend as unknown as { host: FakeDshHost }).host
  const approval = host.waterfall('approval/request', { agent, toolName: 'bash' })
  const decision = events.find(event => event.type === 'decision')
  assert.ok(decision?.type === 'decision')
  await assert.rejects(backend.command('reload'), /wait for the current turn/u)
  await backend.respond(decision.request.id, 'rejected')
  assert.equal(await approval, 'rejected')
  // The turn that asked is finished, so only the (now settled) decision could
  // have blocked the gate.
  agent.status = 'idle'
  const result = await backend.command('reload') as Record<string, unknown>
  assert.equal(result.available, true, 'a settled decision no longer blocks the native reload')
  await backend.close()
})

test('switching sessions aborts and drains its own native command so reload recovers', async () => {
  const held = heldCommands()
  const reloads: string[] = []
  const { backend } = await connected((host) => {
    host.use('commands', held.service)
    host.use('hmr', {
      runExclusive: async (operation: () => Promise<unknown>): Promise<unknown> => {
        reloads.push('exclusive')
        return await operation()
      },
      reconcileProfile: async (): Promise<unknown> => ({}),
    })
  })
  await backend.send('prompt')
  const executing = backend.command('execute', { line: '/compact' })
  await nextTask()
  assert.equal(activeCommandCount(backend), 1)
  await backend.command('new')
  await assert.rejects(executing, hasCode('ABORTED'))
  await nextTask()
  assert.equal(activeCommandCount(backend), 0, 'the retired attachment left no command carrier behind')
  const result = await backend.command('reload') as Record<string, unknown>
  assert.equal(result.available, true, 'the new attachment is not blocked by a foreign carrier')
  assert.deepEqual(reloads, ['exclusive'])
  await backend.close()
})
