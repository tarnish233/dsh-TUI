/**
 * Offline contract tests for attachments, projections, resume snapshots,
 * auto-title, reload and ephemeral tool presentation in the in-process adapter.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshBackend, type DshContextBackend, type DshContextBackendOptions } from '../src/backend/context.ts'
import type { BackendEvent, ImageAttachmentRef, PromptContentPart, SessionInfo } from '../src/backend/types.ts'
import { FakeAgentRegistry, FakeDshHost, fakeNativeHelpers, nextTask, type FakeAgentState } from '../src/backend/testing.ts'

class FakeProjections {
  readonly state = new Map<string, unknown>()
  readonly views = new Map<string, unknown>()
  private listeners: Array<(session: unknown, key: string, value: unknown, seq: unknown) => void> = []

  stateOf(_session: unknown, key: string): unknown {
    return this.state.get(key)
  }

  snapshot(_session: unknown, keys?: readonly string[]): { values: Record<string, unknown> } {
    const values: Record<string, unknown> = {}
    for (const key of keys ?? [...this.views.keys()]) values[key] = this.views.get(key)
    return { values }
  }

  onChanged(listener: (session: unknown, key: string, value: unknown, seq: unknown) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(existing => existing !== listener)
    }
  }

  set(session: unknown, key: string, value: unknown, view: unknown = value): void {
    if (value === undefined) this.state.delete(key)
    else this.state.set(key, value)
    if (view === undefined) this.views.delete(key)
    else this.views.set(key, view)
    for (const listener of [...this.listeners]) listener(session, key, view, 1)
  }
}

interface Harness {
  host: FakeDshHost
  agents: FakeAgentRegistry
  backend: DshContextBackend
  events: BackendEvent[]
}

function harness(extra: (host: FakeDshHost) => void = () => {}, options: Partial<DshContextBackendOptions> = {}): Harness {
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
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'low' } }),
  })
  extra(host)
  const backend = createDshBackend(host, {
    cwd: '/workspace',
    native: fakeNativeHelpers(),
    ...options,
  })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  return { host, agents, backend, events }
}

async function liveHarness(extra: (host: FakeDshHost) => void = () => {}, options: Partial<DshContextBackendOptions> = {}): Promise<Harness & { agent: FakeAgentState; info: SessionInfo }> {
  const value = harness(extra, options)
  const info = await value.backend.connect()
  await value.backend.send('prompt')
  const agent = value.agents.agents[0]
  assert.ok(agent)
  return { ...value, agent, info: await value.backend.connect() }
}

function ref(id = 'a1', bytes = 4): ImageAttachmentRef {
  return { attachmentId: id, mediaType: 'image/png', bytes, width: 2, height: 2 }
}

test('readImage returns verified base64 with no control-frame size limit', async () => {
  const large = Buffer.alloc(512 * 1024, 7)
  const hostRef = ref('large', large.length)
  const { backend } = await liveHarness((fakeHost) => {
    fakeHost.use('attachments', {
      readImage: async (requested: ImageAttachmentRef) => ({
        ref: requested,
        data: Buffer.from(large),
      }),
    })
  })
  const value = await backend.readImage(hostRef)
  assert.equal(value.attachment.attachmentId, 'large')
  assert.equal(Buffer.from(value.data, 'base64').length, large.length)
  await backend.close()
})

test('readImage rejects corrupt identity and honours the caller signal', async () => {
  const { backend } = await liveHarness((fakeHost) => {
    fakeHost.use('attachments', {
      readImage: async (requested: ImageAttachmentRef, signal?: AbortSignal) => {
        if (signal?.aborted === true) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        return { ref: { ...requested, bytes: requested.bytes + 1 }, data: new Uint8Array(requested.bytes) }
      },
    })
  })
  await assert.rejects(backend.readImage(ref()), /do not match the requested reference/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(backend.readImage(ref(), controller.signal), (error: unknown) => (error as { code?: string }).code === 'ABORTED')
  await backend.close()
})

test('sendContent admits image content through the native attachment store', async () => {
  const attachment = ref()
  const admitted: unknown[] = []
  const { backend, agents, agent } = await liveHarness((fakeHost) => {
    fakeHost.use('attachments', {
      admitPromptContent: async (content: readonly PromptContentPart[]) => {
        admitted.push(...content)
        return [{ type: 'image', attachment }]
      },
    })
  })
  await backend.sendContent([
    { type: 'text', text: 'look' },
    { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
  ], 'steer')
  assert.equal(admitted.length, 2)
  assert.equal(agent.sent.at(-1)?.mode, 'steer')
  const message = agent.sent.at(-1)?.message as Record<string, unknown>
  assert.deepEqual(message.content, [{ type: 'image', attachment }])
  assert.equal(agents.createCalls.length, 1)
  await backend.close()
})

test('image admission refusals never materialize a pending session', async () => {
  const { backend, agents } = harness()
  await backend.connect()
  await assert.rejects(
    backend.sendContent([{ type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' }]),
    (error: unknown) => (error as { code?: string }).code === 'CAPABILITY_UNAVAILABLE',
  )
  assert.equal(agents.createCalls.length, 0)
  await backend.close()
})

test('native projections publish todos, an engaged plan once, and deduped metrics', async () => {
  const projections = new FakeProjections()
  const { host, backend, events } = harness((fakeHost) => {
    fakeHost.use('sessionProjections', projections)
  })
  await backend.connect()
  await backend.send('prompt')
  const session = agentsSession(backend)
  projections.set(session, 'todos', [
    { content: 'one', status: 'pending' },
    { content: 'two', status: 'in_progress' },
  ])
  await nextTask()
  const todos = events.filter(event => event.type === 'todos').at(-1)
  assert.ok(todos?.type === 'todos')
  assert.deepEqual(todos.value, [{ content: 'one', status: 'pending' }, { content: 'two', status: 'in_progress' }])

  const idlePlan = { active: false, wanted: null, running: null, activeAtLastHeader: false, entered: false }
  projections.set(session, 'plan', idlePlan, { active: false, pending: null })
  assert.equal(events.filter(event => event.type === 'plan').length, 0, 'an unengaged plan is not a fact')

  const engaged = { active: true, wanted: null, running: { commandId: 'c1', wanted: true }, activeAtLastHeader: true }
  projections.set(session, 'plan', engaged, { active: true, pending: null })
  const plan = events.filter(event => event.type === 'plan').at(-1)
  assert.ok(plan?.type === 'plan')
  assert.deepEqual(plan.value, { active: true, wanted: null, running: { commandId: 'c1', wanted: true } })
  projections.set(session, 'plan', engaged, { active: true, pending: null })
  assert.equal(events.filter(event => event.type === 'plan').length, 1, 'a rebuilt identical plan stays silent')

  projections.views.set('contextPressure', { contextWindow: 1000, projectedTokens: 400 })
  projections.views.set('tokenUsage', { uncachedInputTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 0, outputTokens: 50 })
  projections.set(session, 'sessionStats', { turns: 1, steps: 2, ttftMs: 30, ignored: 9 })
  const metrics = events.filter(event => event.type === 'metrics').at(-1)
  assert.ok(metrics?.type === 'metrics')
  assert.deepEqual(metrics.usage, { used: 400, size: 1000, cachePct: 75, totalTokens: 450 })
  assert.deepEqual(metrics.stats, { turns: 1, steps: 2, ttftMs: 30 })
  const count = events.filter(event => event.type === 'metrics').length
  projections.set(session, 'sessionStats', { turns: 1, steps: 2, ttftMs: 30, ignored: 9 })
  assert.equal(events.filter(event => event.type === 'metrics').length, count, 'unchanged figures stay silent')
  assert.equal(host.listenerCount('session/event'), 1)
  await backend.close()
})

test('session events preserve native surface facts and add ephemeral tool presentation', async () => {
  const { host, backend, agent } = await liveHarness((fakeHost) => {
    fakeHost.use('tools', {
      get: () => ({
        presentCall: (args: unknown) => ({ card: 'bash', command: (args as Record<string, unknown>).command }),
        presentResult: (_args: unknown, result: { content: unknown[]; isError: boolean }) => ({
          card: 'bash', output: result.content, failed: result.isError,
        }),
      }),
    })
  })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  host.emit('session/event', agent.session, {
    type: 'tool/call', seq: 4, data: { callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
  })
  host.emit('session/event', agent.session, {
    type: 'tool/result', seq: 5, data: { message: { toolCallId: 'call-1', content: [{ type: 'text', text: 'file' }], isError: false } },
  })
  const calls = events.filter(event => event.type === 'session_event')
  assert.equal(calls.length, 2)
  const first = calls[0]
  assert.ok(first?.type === 'session_event')
  assert.deepEqual(first.event.data, { callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' })
  assert.deepEqual(first.event.toolPresentation, { call: { card: 'bash', command: 'ls' } })
  const second = calls[1]
  assert.ok(second?.type === 'session_event')
  assert.deepEqual(second.event.toolPresentation, {
    call: { card: 'bash', command: 'ls' },
    result: { card: 'bash', output: [{ type: 'text', text: 'file' }], failed: false },
  })
  await backend.close()
})

test('resume reads the durable snapshot through sessionQuery and reports truncation', async () => {
  const big = 'x'.repeat(2 * 1024 * 1024)
  const { backend, agents, events } = harness((fakeHost) => {
    fakeHost.use('sessionQuery', {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readSession: async (id: string) => ({
        session: { id },
        inheritedEventCount: 0,
        events: [
          { type: 'user/message', seq: 0, data: { content: [{ type: 'text', text: big }] }, surfaceOp: 'append' },
          { type: 'system/message', seq: 1, data: { content: [{ type: 'text', text: big }] }, surfaceOp: 'append' },
          { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: big }] }, surfaceOp: 'append' },
        ],
      }),
    })
  }, { resume: 'session-42' })
  const info = await backend.connect()
  assert.equal(info.sessionId, 'session-42')
  assert.equal(info.truncated, true)
  assert.equal(info.totalEvents, 3)
  assert.equal(info.events?.length, 1)
  assert.equal(info.events?.[0]?.seq, 2)
  assert.equal(agents.resumeCalls.length, 1)
  assert.ok(events.some(event => event.type === 'ready'))
  await backend.close()
})

test('a failed durable read is reported as incomplete, never empty', async () => {
  const { backend, events } = harness((fakeHost) => {
    fakeHost.use('sessionQuery', {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readSession: async () => { throw new Error('unreadable') },
    })
  }, { resume: 'session-bad' })
  const info = await backend.connect()
  assert.equal(info.snapshotUnavailable, true)
  assert.ok(events.some(event => event.type === 'warning' && /incomplete/.test(event.message)))
  await backend.close()
})

test('resume and session listing use only the native query surface', async () => {
  const { backend } = await liveHarness((fakeHost) => {
    fakeHost.use('sessionQuery', {
      listSessions: async () => [
        { header: { id: 's1', cwd: '/w', createdAt: 10 }, live: false },
        { header: { id: 's2', cwd: '/w', createdAt: 20, origin: 'subagent' }, live: false },
      ],
      readTitleSnapshots: async (ids: readonly string[]) => ids.map(id => ({ sessionId: id, status: 'fulfilled', value: { title: { title: `title-${id}` } } })),
      readSession: async (id: string) => ({ session: { id }, events: [], inheritedEventCount: 0 }),
    })
  })
  const sessions = await backend.command('sessions') as Array<Record<string, unknown>>
  assert.deepEqual(sessions.map(row => row.id), ['s1'])
  assert.equal(sessions[0]?.title, 'title-s1')
  const titles = await backend.command('titles', { ids: ['s1', 's1', 's9'] }) as Array<Record<string, unknown>>
  assert.deepEqual(titles, [
    { sessionId: 's1', title: 'title-s1' },
    { sessionId: 's9', title: 'title-s9' },
  ])
  await backend.close()
})

test('auto-title toggles only native Loader entries and restores the observed baseline', async () => {
  const updates: Array<{ id: string; disabled: boolean }> = []
  const entry = {
    options: { id: 'session-title-llm', name: '@deepseek-ai/dsh-session-title-first-prompt-llm' },
    disabled: false,
    update: async (next: { disabled: boolean }) => {
      updates.push({ id: 'session-title-llm', disabled: next.disabled })
      entry.disabled = next.disabled
    },
  }
  const { backend } = harness((fakeHost) => {
    fakeHost.use('loader', { entries: () => [entry] })
    fakeHost.use('sessionTitle', { refresh: () => {} })
  })
  const initial = await backend.command('auto-title') as Record<string, unknown>
  assert.equal(initial.enabled, true)
  assert.equal(initial.inherited, true)
  const disabled = await backend.command('auto-title', { enabled: false }) as Record<string, unknown>
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.mode, 'disabled')
  assert.deepEqual(updates, [{ id: 'session-title-llm', disabled: true }])
  const restored = await backend.command('auto-title', { enabled: null }) as Record<string, unknown>
  assert.equal(restored.enabled, true)
  assert.equal(restored.inherited, true)
  assert.deepEqual(updates.at(-1), { id: 'session-title-llm', disabled: false })
  await backend.close()
})

test('reload is a single exclusive native reconciliation gated on idle state', async () => {
  let exclusive = 0
  let reconciled = 0
  const hmr = {
    runExclusive: async <T>(operation: () => Promise<T>): Promise<T> => {
      exclusive += 1
      return await operation()
    },
    reconcileProfile: async () => {
      reconciled += 1
      return { warnings: ['entry disabled'], pending: [{ url: 'file:///m.js', reason: 'module-comparison' }], restartReason: 'module-comparison' }
    },
  }
  const { backend, agent } = await liveHarness((fakeHost) => {
    fakeHost.use('hmr', hmr)
  })
  agent.status = 'running'
  await assert.rejects(backend.command('reload'), /wait for the current turn/)
  assert.equal(exclusive, 0, 'the idle gate runs before any HMR work')
  agent.status = 'idle'
  const result = await backend.command('reload') as Record<string, unknown>
  assert.equal(result.available, true)
  assert.equal(exclusive, 1)
  assert.equal(reconciled, 1)
  assert.deepEqual(result.warnings, ['entry disabled'])
  assert.equal((result.pending as unknown[]).length, 1)
  assert.equal(result.restartReason, 'module-comparison')
  assert.ok(result.info !== undefined)
  await backend.close()
})

test('reload is unavailable without the native HMR service', async () => {
  const { backend, agent } = await liveHarness()
  agent.status = 'idle'
  const result = await backend.command('reload') as Record<string, unknown>
  assert.equal(result.available, false)
  assert.ok(Array.isArray(result.warnings))
  await backend.close()
})

test('close never waits for an in-flight recomposition', async () => {
  let release: () => void = () => {}
  const hmr = {
    runExclusive: async <T>(operation: () => Promise<T>): Promise<T> => await operation(),
    reconcileProfile: async () => await new Promise<unknown>(resolve => { release = () => resolve({ warnings: [], pending: [] }) }),
  }
  const { backend } = await liveHarness((fakeHost) => {
    fakeHost.use('hmr', hmr)
  })
  const reloading = backend.command('reload')
  const closed = backend.close()
  await Promise.race([
    closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error('close waited for HMR')), 500)),
  ])
  release()
  await reloading.catch(() => undefined)
})

function agentsSession(backend: DshContextBackend): { id: string } {
  const live = (backend as unknown as { live?: { agent: { session: { id: string } } } }).live
  assert.ok(live, 'adapter has a live Agent')
  return live.agent.session
}