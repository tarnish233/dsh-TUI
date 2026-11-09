/**
 * Offline contract tests for attachments, projections, resume snapshots,
 * auto-title, reload and ephemeral tool presentation in the in-process adapter.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshBackend, type DshContextBackend, type DshContextBackendOptions } from '../src/backend/context.ts'
import type { BackendEvent, ImageAttachmentRef, PromptContentPart, SessionInfo } from '../src/backend/types.ts'
import { FakeAgentRegistry, FakeDshHost, fakeNativeHelpers, nextTask, type FakeAgentState } from '../src/backend/testing.ts'

/**
 * Fake `ctx.sessionProjections` with the public carrier read face only.
 *
 * It serves `snapshot(session, keys)` (one validated cut, absent keys omitted)
 * and the change feed. `stateOf` is the registry's deprecated raw fold read and
 * is a trap here: the adapter must never call it.
 */
class FakeProjections {
  /** Native client views keyed by projection key, as DSH would validate them. */
  readonly views = new Map<string, unknown>()
  readonly snapshotCalls: Array<readonly string[]> = []
  stateOfCalls = 0
  failSnapshot: Error | undefined
  private listeners: Array<(session: unknown, key: string, value: unknown, seq: unknown) => void> = []

  stateOf(): unknown {
    this.stateOfCalls += 1
    throw new Error('sessionProjections.stateOf is deprecated and must not be read by the adapter')
  }

  snapshot(_session: unknown, keys?: readonly string[]): { asOfSeq: number; values: Record<string, unknown> } {
    this.snapshotCalls.push(keys ?? [])
    if (this.failSnapshot !== undefined) throw this.failSnapshot
    const values: Record<string, unknown> = {}
    for (const key of keys ?? [...this.views.keys()]) {
      if (this.views.has(key)) values[key] = this.views.get(key)
    }
    return { asOfSeq: 1, values }
  }

  onChanged(listener: (session: unknown, key: string, value: unknown, seq: unknown) => void): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(existing => existing !== listener)
    }
  }

  set(session: unknown, key: string, value: unknown): void {
    if (value === undefined) this.views.delete(key)
    else this.views.set(key, value)
    for (const listener of [...this.listeners]) listener(session, key, value, 1)
  }
}

/**
 * Fake `ctx.sessionTitle`: the owning domain read is `get(session)`.
 * `undefined` is the native no-title fact, a throwing read is unavailable.
 */
class FakeSessionTitle {
  private titles = new Map<unknown, string>()
  /** Title returned for a session with no explicit entry (an unstaged fold). */
  defaultTitle: string | undefined
  getCalls = 0
  failGet: Error | undefined
  refreshCalls = 0

  get(session: unknown): unknown {
    this.getCalls += 1
    if (this.failGet !== undefined) throw this.failGet
    const title = this.titles.get(session) ?? this.defaultTitle
    return title === undefined ? undefined : { title, messageSeqs: [], source: { kind: 'user' }, eventSeq: 1, updatedAt: 1 }
  }

  refresh(): void {
    this.refreshCalls += 1
  }

  set(session: unknown, title: string | undefined): void {
    if (title === undefined) this.titles.delete(session)
    else this.titles.set(session, title)
  }
}

/** Fake `ctx.planMode`: the public `get(agent)` read of logged plan state. */
class FakePlanMode {
  fact: Record<string, unknown> | undefined
  readonly agents: unknown[] = []
  failGet: Error | undefined

  get(agent: unknown): unknown {
    this.agents.push(agent)
    if (this.failGet !== undefined) throw this.failGet
    return this.fact
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
        // Native admission preserves every ordered text and attachment part.
        return content.map(part => part.type === 'text' ? part : { type: 'image', attachment })
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
  assert.deepEqual(message.content, [{ type: 'text', text: 'look' }, { type: 'image', attachment }])
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

test('native projections publish todos and deduped metrics from the public cut, never the raw fold', async () => {
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
  assert.ok(projections.snapshotCalls.length > 0, 'every fact comes from the public carrier read')
  assert.equal(projections.stateOfCalls, 0, 'the deprecated raw registry fold is never read')
  await backend.close()
})

test('a failing projection cut omits figures instead of inventing zeros', async () => {
  const projections = new FakeProjections()
  projections.failSnapshot = new Error('registry disposed')
  const warnings: string[] = []
  const { backend, events } = await liveHarness((fakeHost) => {
    fakeHost.use('sessionProjections', projections)
  }, { warn: message => { warnings.push(message) } })
  projections.set(agentsSession(backend), 'todos', [{ content: 'one', status: 'pending' }])
  await nextTask()
  assert.equal(events.filter(event => event.type === 'metrics').length, 0, 'no usage/stats frame is fabricated')
  assert.equal(events.some(event => event.type === 'todos' && event.value === null), false, 'an unreadable todos fold is not an empty checklist')
  assert.equal(warnings.filter(message => /session-projection snapshot/.test(message)).length, 1, 'one host diagnostic, no spam')
  await backend.close()
})

test('the native plan controller publishes active/pending on the exact Agent, not a folded command id', async () => {
  const projections = new FakeProjections()
  const planMode = new FakePlanMode()
  const { backend, events, agent } = await liveHarness((fakeHost) => {
    fakeHost.use('sessionProjections', projections)
    fakeHost.use('planMode', planMode)
  })
  await nextTask()
  const frames = (): unknown[] => events.filter(event => event.type === 'plan').map(event => event.type === 'plan' ? event.value : undefined)
  assert.deepEqual(frames(), [], 'a baseline with no native plan fact publishes nothing')

  planMode.fact = { active: false }
  projections.set(agentsSession(backend), 'plan', { active: false })
  assert.deepEqual(frames(), [], 'an unengaged plan is not a fact')

  planMode.fact = { active: true, pending: false }
  projections.set(agentsSession(backend), 'plan', { active: true, pending: false })
  assert.deepEqual(frames(), [{ active: true, pending: false }], 'pending:false is the requested plan-off intent, preserved as-is')

  projections.set(agentsSession(backend), 'plan', { active: true, pending: false })
  assert.equal(frames().length, 1, 'a rebuilt identical fact stays silent')

  planMode.fact = { active: false, pending: true }
  projections.set(agentsSession(backend), 'plan', { active: false, pending: true })
  assert.deepEqual(frames().at(-1), { active: false, pending: true })

  planMode.fact = undefined
  projections.set(agentsSession(backend), 'plan', { active: false, pending: true })
  assert.equal(frames().length, 2, 'an absent native read is unavailable, never an inactive fact')

  planMode.failGet = new Error('plan controller disposed')
  projections.set(agentsSession(backend), 'plan', { active: false, pending: true })
  assert.equal(frames().length, 2, 'a throwing read publishes nothing')
  assert.equal(planMode.agents.every(seen => seen === agent), true, 'every read names the exact supplied Agent')
  await backend.close()
})

test('plan mode prefers the preset-isolated controller and publishes nothing when unmounted', async () => {
  const projections = new FakeProjections()
  const hostPlan = new FakePlanMode()
  hostPlan.fact = { active: true }
  const scopedPlan = new FakePlanMode()
  scopedPlan.fact = { active: false, pending: true }
  const serviceForCalls: Array<{ agent: unknown; name: string }> = []
  const { backend, events, agent } = await liveHarness((fakeHost) => {
    fakeHost.use('sessionProjections', projections)
    fakeHost.use('planMode', hostPlan)
    fakeHost.use('agentPresets', {
      serviceFor(seen: unknown, name: string) {
        serviceForCalls.push({ agent: seen, name })
        return name === 'planMode' ? scopedPlan : undefined
      },
    })
  })
  await nextTask()
  assert.deepEqual(serviceForCalls[0], { agent, name: 'planMode' }, 'the exact Agent scope is queried')
  assert.equal(hostPlan.agents.length, 0, 'the host-plane controller is not read when the preset scope owns planMode')
  const frames = (): unknown[] => events.filter(event => event.type === 'plan').map(event => event.type === 'plan' ? event.value : undefined)
  assert.deepEqual(frames().at(-1), { active: false, pending: true })
  await backend.close()

  const bare = new FakeProjections()
  const unmounted = await liveHarness((fakeHost) => {
    fakeHost.use('sessionProjections', bare)
  })
  bare.set(agentsSession(unmounted.backend), 'plan', { active: true })
  await nextTask()
  assert.equal(unmounted.events.filter(event => event.type === 'plan').length, 0, 'capability absence publishes no plan fact')
  await unmounted.backend.close()
})

test('the native title read supplies the resume baseline even without a title event', async () => {
  const titles = new FakeSessionTitle()
  titles.defaultTitle = 'Native baseline'
  const { backend, events } = harness((fakeHost) => {
    fakeHost.use('sessionTitle', titles)
    fakeHost.use('sessionQuery', {
      // A durable log whose retained suffix contains no title event: the
      // baseline must still come from the native session-title fold.
      readSession: async (sessionId: string) => ({ session: { id: sessionId }, events: [] }),
    })
  })
  await backend.connect()
  await backend.send('prompt')
  const current = await backend.connect()
  const info = await backend.command('resume', { sessionId: current.sessionId }) as SessionInfo
  assert.equal(info.title, 'Native baseline')
  assert.equal((info.events ?? []).some(event => event.type === 'session/title'), false)
  assert.deepEqual(info.events, [], 'the retained event suffix has no title event')
  const ready = events.filter(event => event.type === 'ready').at(-1)
  assert.equal(ready?.type === 'ready' ? ready.info.title : undefined, 'Native baseline')
  assert.equal(titles.refreshCalls, 0, 'a title read never asks the native provider to generate')
  await backend.close()
})

test('title is tri-state: a string, the native no-title null, or omitted when unreadable', async () => {
  const titles = new FakeSessionTitle()
  titles.defaultTitle = 'Native baseline'
  const { backend } = await liveHarness((fakeHost) => {
    fakeHost.use('sessionTitle', titles)
  })
  assert.equal((await backend.connect()).title, 'Native baseline')
  titles.defaultTitle = undefined
  assert.equal((await backend.connect()).title, null, 'no folded title is the native no-title fact')
  titles.failGet = new Error('title service disposed')
  assert.equal(Object.hasOwn(await backend.connect(), 'title'), false, 'a failed read stays unknown and is omitted')
  await backend.close()

  const projections = new FakeProjections()
  const fallback = await liveHarness((fakeHost) => {
    fakeHost.use('sessionProjections', projections)
  })
  assert.equal(Object.hasOwn(await fallback.backend.connect(), 'title'), false, 'an unmounted title service and absent key stay unknown')
  projections.views.set('title', null)
  assert.equal((await fallback.backend.connect()).title, null, 'the public title view is the same native no-title fact')
  projections.views.set('title', 'From the title projection')
  assert.equal((await fallback.backend.connect()).title, 'From the title projection')
  await fallback.backend.close()
})

test('native title updates and null clears come from projection changes with the live attachment', async () => {
  const projections = new FakeProjections()
  const { backend, events } = await liveHarness((fakeHost) => {
    fakeHost.use('sessionProjections', projections)
  })
  const session = agentsSession(backend)
  const info = await backend.connect()
  projections.set(session, 'title', 'First native title')
  projections.set(session, 'title', null)
  const titles = events.filter(event => event.type === 'title')
  assert.equal(titles.length, 2)
  assert.deepEqual(titles[0], {
    type: 'title', sessionId: info.sessionId, attachmentId: info.attachmentId, value: 'First native title',
  })
  assert.deepEqual(titles[1], {
    type: 'title', sessionId: info.sessionId, attachmentId: info.attachmentId, value: null,
  })
  await backend.close()
})

test('an old session title change is rejected after switching, and unavailable titles stay omitted', async () => {
  const projections = new FakeProjections()
  const { backend, agents, events } = await liveHarness((fakeHost) => {
    fakeHost.use('sessionProjections', projections)
  })
  const oldSession = agents.agents[0]?.session
  assert.ok(oldSession)
  await backend.command('new')
  await backend.send('next')
  const newSession = agents.agents[1]?.session
  assert.ok(newSession)
  assert.notEqual(newSession, oldSession)
  const current = await backend.connect()
  projections.set(oldSession, 'title', 'stale old title')
  assert.equal(events.filter(event => event.type === 'title').length, 0, 'a retired session cannot change the live title')
  projections.set(newSession, 'title', 'fresh title')
  const titles = events.filter(event => event.type === 'title')
  assert.deepEqual(titles, [{
    type: 'title', sessionId: current.sessionId, attachmentId: current.attachmentId, value: 'fresh title',
  }])
  await backend.close()

  const withoutProjection = await liveHarness()
  const omitted = await withoutProjection.backend.connect()
  assert.equal(Object.hasOwn(omitted, 'title'), false, 'an unavailable title projection is omitted, not null')
  await withoutProjection.backend.close()
})

test('title projection forwarding never writes title-provider enablement or profile entries', async () => {
  const projections = new FakeProjections()
  let providerRefreshes = 0
  let entryUpdates = 0
  const { backend } = await liveHarness((fakeHost) => {
    fakeHost.use('sessionProjections', projections)
    fakeHost.use('sessionTitle', {
      refresh: async () => {
        providerRefreshes += 1
        return undefined
      },
    })
    fakeHost.use('loader', {
      entries: () => [{
        options: { id: 'title-entry', name: '@deepseek-ai/dsh-session-title-first-prompt-llm' },
        disabled: false,
        update: () => {
          entryUpdates += 1
        },
      }],
    })
  })
  const session = agentsSession(backend)
  projections.set(session, 'title', 'Native only')
  await nextTask()
  assert.equal(providerRefreshes, 0, 'title forwarding never calls the provider')
  assert.equal(entryUpdates, 0, 'title forwarding never mutates the Loader/profile entry')
  const info = await backend.connect()
  assert.equal(info.title, 'Native only')
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

test('resume and session listing use only the native query surface and preserve native order', async () => {
  let persistenceReads = 0
  const { backend } = await liveHarness((fakeHost) => {
    fakeHost.use('sessionPersistence', { list: async () => { persistenceReads += 1; return [] } })
    fakeHost.use('sessionQuery', {
      listSessions: async () => [
        // Deliberately ascending stamps: a TUI recency sort would reverse the
        // native listing. Native order is the only order exposed to the picker.
        { header: { id: 's1', cwd: '/w', createdAt: 10 }, live: false },
        { header: { id: 's2', cwd: '/w', createdAt: 20 }, live: true },
        { header: { id: 'child', cwd: '/w', createdAt: 30, origin: 'subagent' }, live: false },
      ],
      readTitleSnapshots: async (ids: readonly string[]) => ids.map(id => ({ sessionId: id, status: 'fulfilled', value: { title: { title: `title-${id}` } } })),
      readSession: async (id: string) => ({ session: { id }, events: [], inheritedEventCount: 0 }),
    })
  })
  const sessions = await backend.command('sessions') as Array<Record<string, unknown>>
  assert.deepEqual(sessions.map(row => row.id), ['s1', 's2'])
  assert.deepEqual(sessions.map(row => row.createdAt), [10, 20], 'native header stamps remain display metadata')
  assert.equal(sessions[0]?.title, 'title-s1')
  assert.equal(sessions.some(row => Object.hasOwn(row, 'activityAt')), false, 'no adapter-derived activity field')
  assert.equal(persistenceReads, 0, 'listing never stats durable artifacts through sessionPersistence')
  const titles = await backend.command('titles', { ids: ['s1', 's1', 's9'] }) as Array<Record<string, unknown>>
  assert.deepEqual(titles, [
    { sessionId: 's1', title: 'title-s1' },
    { sessionId: 's9', title: 'title-s9' },
  ])
  await backend.close()
})

test('auto-title reports the native composition read-only and never mutates the Loader entry', async () => {
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
  assert.equal(initial.available, true)
  assert.equal(initial.editable, false)
  assert.equal(initial.enabled, true)
  assert.equal(initial.mode, 'inherit')
  assert.equal(initial.inherited, true)
  assert.equal(initial.mayIssueModelRequests, true)
  assert.deepEqual(initial.plugins, [
    { id: 'session-title-llm', name: '@deepseek-ai/dsh-session-title-first-prompt-llm', enabled: true },
  ])

  for (const wanted of [false, true, null]) {
    const refused = await backend.command('auto-title', { enabled: wanted }) as Record<string, unknown>
    assert.equal(refused.available, false, 'a write is never claimed as applied')
    assert.equal(refused.editable, false)
    assert.equal(refused.changed, false)
    assert.equal(refused.enabled, true, 'the live native state is only reported')
    assert.match(String(refused.reason), /profile composition/)
    assert.match(String(refused.limitation), /profile composition/)
  }
  assert.deepEqual(updates, [], 'the adapter never calls the Loader entry update path')
  assert.equal(entry.disabled, false, 'the native entry options are untouched')
  const after = await backend.command('auto-title') as Record<string, unknown>
  assert.equal(after.enabled, true)
  assert.equal(after.mode, 'inherit')
  await backend.close()
})

test('auto-title inherits a disabled native provider without enabling it', async () => {
  const entry = {
    options: { id: 'session-title-llm', name: '@deepseek-ai/dsh-session-title-all-prompts-llm' },
    disabled: true,
    update: async () => { throw new Error('the adapter must never call entry.update') },
  }
  const { backend } = harness((fakeHost) => {
    fakeHost.use('loader', { entries: () => [entry] })
    fakeHost.use('sessionTitle', { refresh: () => {} })
  })
  const state = await backend.command('auto-title') as Record<string, unknown>
  assert.equal(state.available, true)
  assert.equal(state.enabled, false)
  assert.equal(state.effectiveEnabled, false)
  assert.equal(state.mayIssueModelRequests, false)
  assert.equal(state.mode, 'inherit')
  const refused = await backend.command('auto-title', { enabled: true }) as Record<string, unknown>
  assert.equal(refused.available, false)
  assert.equal(refused.changed, false)
  assert.equal(refused.enabled, false)
  assert.equal(entry.disabled, true, 'a disabled provider stays exactly as the composition declared it')
  await backend.close()
})

test('auto-title reports a missing native provider honestly and keeps argument validation', async () => {
  const { backend } = harness()
  const state = await backend.command('auto-title') as Record<string, unknown>
  assert.equal(state.available, false)
  assert.equal(state.editable, false)
  assert.match(String(state.limitation), /declares no native session-title provider/)
  const refused = await backend.command('auto-title', { enabled: false }) as Record<string, unknown>
  assert.equal(refused.available, false)
  assert.equal(refused.changed, false)
  assert.match(String(refused.limitation), /declares no native session-title provider/)
  assert.match(String(refused.reason), /profile composition/)
  await assert.rejects(backend.command('auto-title', { enabled: 'yes' }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'INVALID_ARGUMENT')
    return true
  })
  await backend.close()
})

test('auto-title treats an unreadable Loader as an unavailable read instead of failing', async () => {
  const { backend } = harness((fakeHost) => {
    fakeHost.use('loader', {
      entries: () => { throw new Error('loader exploded') },
    })
    fakeHost.use('sessionTitle', { refresh: () => {} })
  })
  const state = await backend.command('auto-title') as Record<string, unknown>
  assert.equal(state.available, false)
  assert.deepEqual(state.plugins, [])
  assert.doesNotMatch(JSON.stringify(state), /loader exploded/)
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