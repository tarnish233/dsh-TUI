/**
 * Offline contract tests for the adapter's model-route follower.
 *
 * The fixtures are native-shaped, not adapter-shaped: the fake registry keeps
 * the exact `AgentOptions` object the adapter passes, its Agent resolves
 * `model.current()` as `recorded selection/request ?? live AgentOptions` (the
 * packaged `AgentModel` rule), and the default-model service is a mutable
 * native getter. That is the only way to observe the difference between a
 * static creation snapshot and the SDK's documented live accessors.
 *
 * No profile, credential, session log, provider or network request is touched.
 *
 * @module dsh-tui/test/backend-default-follow
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshBackend, type DshContextBackend, type DshContextBackendOptions } from '../src/backend/context.ts'
import type { BackendEvent, SessionInfo } from '../src/backend/types.ts'
import { FakeDshHost, fakeNativeHelpers, nextTask } from '../src/backend/testing.ts'

interface Route {
  provider: string
  model: string
  reasoningEffort?: string
}

interface AgentOptionsLike {
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
}

function routeOf(value: AgentOptionsLike): Route | undefined {
  const provider = value.provider
  const model = value.model
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  const effort = value.reasoningEffort
  return { provider, model, ...(typeof effort === 'string' && effort.length > 0 ? { reasoningEffort: effort } : {}) }
}

function equalRoute(left: Readonly<Route> | undefined, right: Readonly<Route> | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.provider === right.provider && left.model === right.model &&
    (left.reasoningEffort ?? undefined) === (right.reasoningEffort ?? undefined)
}

/**
 * One native-shaped Agent: exactly the public surface the adapter uses, with
 * the packaged `AgentModel` read rule (`pending ?? lastRequest ?? options`).
 */
class NativeAgent {
  readonly session: {
    readonly id: string
    readonly header: { readonly cwd: string }
    requestHeader(): { config: Route } | undefined
  }
  /** The exact object the adapter supplied as `agentOptions`. */
  readonly options: AgentOptionsLike
  readonly inbox = { nextTurn: [] as unknown[], nextStep: [] as unknown[] }
  readonly status = 'idle'
  readonly ctx = { name: 'native-agent-ctx' }
  readonly sent: unknown[] = []
  /** Recorded `model/selection` appends, in order. */
  readonly selections: Route[] = []
  /** Folded `request/header` selection (`lastUsed`). */
  lastRequest: Route | undefined
  private pending: Route | undefined

  constructor(id: string, options: AgentOptionsLike, lastRequest: Route | undefined) {
    this.session = {
      id,
      header: { cwd: '/workspace' },
      requestHeader: () => (this.lastRequest === undefined ? undefined : { config: { ...this.lastRequest } }),
    }
    this.options = options
    this.lastRequest = lastRequest
    this.model = {
      current: () => {
        const recorded = this.pending ?? this.lastRequest
        return recorded === undefined ? routeOf(this.options) : { ...recorded }
      },
      select: (selection: Readonly<Route>) => {
        if (equalRoute(this.pending ?? this.lastRequest, selection)) return
        const next = { ...selection }
        this.selections.push(next)
        this.pending = next
      },
    }
  }

  readonly model: {
    current(): Readonly<Route> | undefined
    select(selection: Readonly<Route>): void
  }

  /** Fold one native model request: it retires a matching pending selection. */
  recordRequest(): Route | undefined {
    const used = this.model.current()
    if (used !== undefined) this.lastRequest = { ...used }
    this.pending = undefined
    return used === undefined ? undefined : { ...used }
  }

  cancel(): void {}
  async whenIdle(): Promise<void> {}
  followup(message: unknown): void { this.sent.push(message) }
  steer(message: unknown): void { this.sent.push(message) }
}

/** Native-shaped registry: keeps `agentOptions`, resumes persisted headers. */
class NativeShapeRegistry {
  readonly createCalls: Array<Record<string, unknown>> = []
  readonly resumeCalls: Array<Record<string, unknown>> = []
  readonly agents: NativeAgent[] = []
  /** Persisted request header per durable session id. */
  readonly logs = new Map<string, Route>()
  private counter = 0

  async create(options: unknown): Promise<{ agent: NativeAgent; dispose(): Promise<void> }> {
    const call = options as Record<string, unknown>
    this.createCalls.push(call)
    const id = typeof call.sessionId === 'string' ? call.sessionId : this.minted()
    return await this.publish(new NativeAgent(id, agentOptionsOf(call), undefined), call)
  }

  async resume(options: unknown): Promise<{ agent: NativeAgent; dispose(): Promise<void> }> {
    const call = options as Record<string, unknown>
    this.resumeCalls.push(call)
    const id = typeof call.resumeSessionId === 'string' ? call.resumeSessionId : this.minted()
    const logged = this.logs.get(id)
    return await this.publish(new NativeAgent(id, agentOptionsOf(call), logged), call)
  }

  get(id: string): NativeAgent | undefined {
    return this.agents.find(agent => agent.session.id === id)
  }

  private async publish(agent: NativeAgent, call: Record<string, unknown>): Promise<{ agent: NativeAgent; dispose(): Promise<void> }> {
    const setup = call.setup
    // Setup composes before publication, exactly like the native factory.
    if (typeof setup === 'function') await (setup as (ctx: unknown, agent: unknown) => unknown)(agent.ctx, agent)
    this.agents.push(agent)
    return { agent, dispose: async () => {} }
  }

  private minted(): string {
    this.counter += 1
    return `native-${this.counter}`
  }
}

function agentOptionsOf(call: Record<string, unknown>): AgentOptionsLike {
  const options = call.agentOptions
  return options !== null && typeof options === 'object' ? options as AgentOptionsLike : {}
}

/** Native default-model service whose selection moves while a test watches. */
class DefaultModelService {
  selection: Route
  failRead = false
  failSave = false
  reads = 0
  readonly saves: Route[] = []

  constructor(selection: Route) {
    this.selection = { ...selection }
  }

  currentSelection(): unknown {
    this.reads += 1
    if (this.failRead) throw new Error('synthetic native default read failure')
    return { ...this.selection }
  }

  async saveSelection(next: Route): Promise<void> {
    if (this.failSave) throw new Error('synthetic native default save failure')
    this.saves.push({ ...next })
    this.selection = { ...next }
  }
}

interface LlmService {
  listProviders(): readonly { readonly id: string }[]
  listModels(provider: string): Promise<readonly { readonly id: string }[]>
  resolveModelInfo(provider: string, model: string): Promise<unknown>
}

interface Harness {
  host: FakeDshHost
  agents: NativeShapeRegistry
  defaults: DefaultModelService
  llm: LlmService
  backend: DshContextBackend
  events: BackendEvent[]
  warnings: string[]
}

function harness(
  options: { provider?: string; model?: string; initialDefault?: Route } = {},
): Harness {
  const host = new FakeDshHost()
  const agents = new NativeShapeRegistry()
  const defaults = new DefaultModelService(options.initialDefault ?? { provider: 'p1', model: 'm1' })
  const llm: LlmService = {
    listProviders: () => [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }, { id: 'p4' }],
    listModels: async (provider: string) => ['m1', 'm2', 'm3', 'm4'].map(model => ({ id: model })).concat(
      provider === 'p2' ? [{ id: 'mx' }] : [],
    ),
    resolveModelInfo: async () => ({
      reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
    }),
  }
  host.use('agents', agents)
  host.use('agentDefaultModel', defaults)
  host.use('llm', llm)
  const warnings: string[] = []
  const events: BackendEvent[] = []
  const backendOptions: DshContextBackendOptions = {
    cwd: '/workspace',
    native: fakeNativeHelpers(),
    warn: message => { warnings.push(message) },
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.model === undefined ? {} : { model: options.model }),
  }
  const backend = createDshBackend(host, backendOptions)
  backend.onEvent(event => events.push(event))
  return { host, agents, defaults, llm, backend, events, warnings }
}

function lastAgent(h: Harness): NativeAgent {
  const agent = h.agents.agents.at(-1)
  assert.ok(agent, 'the native-shaped registry created an Agent')
  return agent
}

function isGetter(options: AgentOptionsLike | undefined, key: keyof AgentOptionsLike): boolean {
  if (options === undefined) return false
  return typeof Object.getOwnPropertyDescriptor(options, key)?.get === 'function'
}

// ------------------------------------------------------------------ pending

test('a pending session follows the live native default and never polls', async () => {
  const h = harness()
  const first = await h.backend.connect()
  assert.equal(first.provider, 'p1')
  assert.equal(first.model, 'm1')
  assert.equal(h.agents.createCalls.length, 0, 'reporting the default creates no Agent')

  h.defaults.selection = { provider: 'p2', model: 'm2', reasoningEffort: 'high' }
  const moved = await h.backend.command('state') as Record<string, unknown>
  assert.equal(moved.provider, 'p2')
  assert.equal(moved.model, 'm2')
  assert.equal(moved.reasoningEffort, 'high')
  assert.equal(h.agents.createCalls.length, 0, 'following the default stays a read, not an Agent')

  const next = await h.backend.command('new') as SessionInfo
  assert.equal(next.provider, 'p2')
  assert.equal(next.model, 'm2')
  assert.equal(next.reasoningEffort, 'high')

  // A TUI polling router would keep reading the service; the adapter only reads
  // it when a caller asks for the route.
  const reads = h.defaults.reads
  await nextTask()
  await nextTask()
  assert.equal(h.defaults.reads, reads, 'no scheduled or polled native default read exists')
  await h.backend.close()
})

test('a failed native default read is unknown, never a stale or guessed route', async () => {
  const h = harness()
  await h.backend.connect()
  h.defaults.failRead = true

  const state = await h.backend.command('state') as Record<string, unknown>
  assert.equal(state.provider, '')
  assert.equal(state.model, '')
  assert.equal(Object.hasOwn(state, 'reasoningEffort'), false, 'an unreadable default supplies no effort')
  await assert.rejects(
    async () => await h.backend.command('effort', { id: 'high' }),
    (error: unknown) => /no model route/.test(String((error as { message?: string }).message ?? error)),
    'an effort cannot be validated against an unknown route',
  )
  assert.equal(h.defaults.saves.length, 0, 'a failed default read pins and saves nothing')

  // An explicit model choice does not depend on the default read at all.
  const selected = await h.backend.command('model', { id: 'p2/m2' }) as Record<string, unknown>
  assert.equal(selected.model, 'm2')
  assert.equal(Object.hasOwn(selected, 'reasoningEffort'), false, 'no effort is invented from the failed default')
  assert.equal(selected.defaultPersistence, 'failed', 'the unreadable default is reported as an unproven save')

  h.defaults.failRead = false
  const pinned = await h.backend.command('state') as Record<string, unknown>
  assert.equal(pinned.provider, 'p2')
  assert.equal(pinned.model, 'm2')
  await h.backend.close()
})

// ---------------------------------------------------------------- live Agent

test('a materialized but unrequested Agent keeps following the default through true getters', async () => {
  const h = harness()
  await h.backend.connect()
  await h.backend.send('first prompt')

  const call = h.agents.createCalls.at(-1)
  assert.ok(call)
  const options = call.agentOptions as AgentOptionsLike | undefined
  assert.equal(isGetter(options, 'provider'), true, 'the creation route is a live native accessor')
  assert.equal(isGetter(options, 'model'), true)
  assert.equal(isGetter(options, 'reasoningEffort'), true)
  assert.equal(options?.provider, 'p1', 'the accessor resolves the current native default')

  const agent = lastAgent(h)
  assert.deepEqual(agent.model.current(), { provider: 'p1', model: 'm1' })

  // Another native surface moves the deployment default before any step ran.
  h.defaults.selection = { provider: 'p2', model: 'm2', reasoningEffort: 'high' }
  assert.deepEqual(agent.model.current(), { provider: 'p2', model: 'm2', reasoningEffort: 'high' },
    'the Agent itself follows the native default; the adapter did not re-create or re-select it')
  assert.deepEqual(agent.selections, [], 'following a default records no selection of its own')
  assert.equal(h.agents.resumeCalls.length, 0)
  assert.equal(h.agents.createCalls.length, 1, 'one attachment, no polling re-materialization')

  const state = await h.backend.command('state') as Record<string, unknown>
  assert.equal(state.provider, 'p2')
  assert.equal(state.model, 'm2')
  assert.equal(state.reasoningEffort, 'high')
  await h.backend.close()
})

test('a native request or selection pins the route over later default changes', async () => {
  const h = harness()
  await h.backend.connect()
  await h.backend.send('prompt')
  const agent = lastAgent(h)

  // Native `model/selection` (a pending choice) wins over the live options.
  agent.model.select({ provider: 'p3', model: 'm3' })
  h.defaults.selection = { provider: 'p2', model: 'm2' }
  assert.deepEqual(agent.model.current(), { provider: 'p3', model: 'm3' })
  assert.equal((await h.backend.command('state') as Record<string, unknown>).model, 'm3')

  // The first logged request becomes the durable `lastUsed` fact; the live
  // accessors keep reading the newer default but never override it.
  assert.deepEqual(agent.recordRequest(), { provider: 'p3', model: 'm3' })
  h.defaults.selection = { provider: 'p4', model: 'm4' }
  assert.deepEqual(agent.model.current(), { provider: 'p3', model: 'm3' }, 'the recorded request stays authoritative')
  assert.equal(agent.options.provider, 'p4', 'the native option accessors still read the live default')
  assert.deepEqual(agent.session.requestHeader(), { config: { provider: 'p3', model: 'm3' } },
    'the logged header is a native fact the adapter never rewrites')
  const state = await h.backend.command('state') as Record<string, unknown>
  assert.equal(state.provider, 'p3')
  assert.equal(state.model, 'm3')
  await h.backend.close()
})

test('an explicit TUI model choice pins a pending session and the created Agent', async () => {
  const h = harness()
  await h.backend.connect()
  const staged = await h.backend.command('model', { id: 'p2/m2' }) as Record<string, unknown>
  assert.equal(staged.model, 'm2')
  assert.equal(h.agents.createCalls.length, 0, 'staging records no Agent')

  h.defaults.selection = { provider: 'p4', model: 'm4' }
  const state = await h.backend.command('state') as Record<string, unknown>
  assert.equal(state.provider, 'p2', 'an explicit choice is not the live default')
  assert.equal(state.model, 'm2')

  await h.backend.send('go')
  const options = h.agents.createCalls.at(-1)?.agentOptions as AgentOptionsLike | undefined
  assert.deepEqual(options, { provider: 'p2', model: 'm2' }, 'an explicit choice is a complete static option snapshot')
  assert.equal(isGetter(options, 'provider'), false, 'an explicit choice is never a live accessor')

  h.defaults.selection = { provider: 'p3', model: 'm3' }
  assert.deepEqual(lastAgent(h).model.current(), { provider: 'p2', model: 'm2' })
  assert.equal((await h.backend.command('state') as Record<string, unknown>).model, 'm2')
  await h.backend.close()
})

test('an explicit TUI effort pins the level; a later default effort does not move it', async () => {
  const h = harness({ initialDefault: { provider: 'p1', model: 'm1', reasoningEffort: 'high' } })
  const info = await h.backend.connect()
  assert.equal(info.reasoningEffort, 'high', 'the followed default exposes its explicit level')

  h.defaults.selection = { provider: 'p1', model: 'm1', reasoningEffort: 'low' }
  assert.equal((await h.backend.command('state') as Record<string, unknown>).reasoningEffort, 'low')

  const applied = await h.backend.command('effort', { id: 'high' }) as Record<string, unknown>
  assert.equal(applied.reasoningEffort, 'high')
  h.defaults.selection = { provider: 'p1', model: 'm1', reasoningEffort: 'low' }
  const pinned = await h.backend.command('state') as Record<string, unknown>
  assert.equal(pinned.reasoningEffort, 'high', 'a selected level keeps its provenance')
  assert.deepEqual(h.defaults.saves.at(-1), { provider: 'p1', model: 'm1', reasoningEffort: 'high' })
  await h.backend.close()
})

// --------------------------------------------------------------- CLI/resume

test('an explicit CLI pair pins new sessions but never rewrites a resumed route', async () => {
  const h = harness({ provider: 'p2', model: 'mx' })
  const info = await h.backend.connect()
  assert.equal(info.provider, 'p2', 'the explicit CLI pair still wins for a new session')
  assert.equal(info.model, 'mx')

  await h.backend.send('hello')
  assert.deepEqual(h.agents.createCalls.at(-1)?.agentOptions, { provider: 'p2', model: 'mx' })

  // A persisted request header is the durable route of a resumed session.
  h.agents.logs.set('session-logged', { provider: 'p3', model: 'm3', reasoningEffort: 'high' })
  const resumed = await h.backend.command('resume', { sessionId: 'session-logged' }) as SessionInfo
  assert.equal(resumed.provider, 'p3', 'the logged request beats the CLI pair and the live default')
  assert.equal(resumed.model, 'm3')
  assert.equal(resumed.reasoningEffort, 'high')

  const resumeCall = h.agents.resumeCalls.at(-1)
  assert.ok(resumeCall)
  const resumeOptions = resumeCall.agentOptions as AgentOptionsLike | undefined
  assert.equal(isGetter(resumeOptions, 'provider'), true, 'resume passes the native live-default accessors')
  assert.equal(resumeOptions?.provider, 'p1', 'the CLI pair is not forwarded into the resumed conversation')
  const agent = lastAgent(h)
  assert.deepEqual(agent.selections, [], 'resume records no selection of its own')
  assert.deepEqual(agent.session.requestHeader(), { config: { provider: 'p3', model: 'm3', reasoningEffort: 'high' } },
    'the logged header is never rewritten')

  // A resumed blank session has no logged fact: it follows the live default.
  h.agents.logs.delete('session-blank')
  const blank = await h.backend.command('resume', { sessionId: 'session-blank' }) as SessionInfo
  assert.equal(blank.provider, 'p1', 'an unrecorded resumed session follows the live native default')
  assert.equal(blank.model, 'm1')
  await h.backend.close()
})

test('a resumed logged route survives an unreadable live default', async () => {
  const h = harness({ provider: 'p2', model: 'mx' })
  h.agents.logs.set('session-logged', { provider: 'p3', model: 'm3' })
  h.defaults.failRead = true
  const resumed = await h.backend.command('resume', { sessionId: 'session-logged' }) as SessionInfo
  assert.equal(resumed.provider, 'p3', 'the native logged route is reported without reading the default')
  assert.equal(resumed.model, 'm3')
  assert.equal(lastAgent(h).options.provider, undefined, 'the live accessor reports the failed read as unknown')

  // A blank resume with no readable default reports unknown, not the CLI pair.
  const blank = await h.backend.command('resume', { sessionId: 'session-unknown' }) as SessionInfo
  assert.equal(blank.provider, '')
  assert.equal(blank.model, '')
  await h.backend.close()
})

// ------------------------------------------------------------------- races

test('a pending model choice aborts when the followed default moves during its async read', async () => {
  const h = harness()
  await h.backend.connect()
  let release: () => void = () => {}
  const metadata = new Promise<unknown>(resolve => {
    release = () => resolve({ reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'low' } })
  })
  h.llm.resolveModelInfo = async () => await metadata
  const selecting = h.backend.command('model', { id: 'p2/m2' })
  h.defaults.selection = { provider: 'p3', model: 'm3' }
  release()
  await assert.rejects(selecting, (error: unknown) => (error as { code?: string }).code === 'STALE_SESSION')

  assert.equal(h.defaults.saves.length, 0, 'the obsolete choice is not saved as the default')
  const state = await h.backend.command('state') as Record<string, unknown>
  assert.equal(state.provider, 'p3', 'the pending session still follows the moved native default')
  assert.equal(state.model, 'm3')
  await h.backend.close()
})

test('a live model choice aborts when the followed default moves during its async read', async () => {
  const h = harness()
  await h.backend.connect()
  await h.backend.send('prompt')
  const agent = lastAgent(h)
  let release: () => void = () => {}
  const metadata = new Promise<unknown>(resolve => {
    release = () => resolve({ reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'low' } })
  })
  h.llm.resolveModelInfo = async () => await metadata
  const selecting = h.backend.command('model', { id: 'p2/m2' })
  h.defaults.selection = { provider: 'p3', model: 'm3' }
  release()
  await assert.rejects(selecting, (error: unknown) => (error as { code?: string }).code === 'STALE_SESSION')

  assert.deepEqual(agent.selections, [], 'the retired selection was never applied to the Agent')
  assert.equal(h.defaults.saves.length, 0, 'the obsolete choice is not saved as the default')
  assert.deepEqual(agent.model.current(), { provider: 'p3', model: 'm3' }, 'the Agent still follows the default')
  await h.backend.close()
})

test('a pending effort choice aborts when the followed route changes during its async read', async () => {
  const h = harness()
  await h.backend.connect()
  let release: () => void = () => {}
  const metadata = new Promise<unknown>(resolve => {
    release = () => resolve({ reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'low' } })
  })
  h.llm.resolveModelInfo = async () => await metadata
  const selecting = h.backend.command('effort', { id: 'high' })
  h.defaults.selection = { provider: 'p3', model: 'm3' }
  release()
  await assert.rejects(selecting, (error: unknown) => (error as { code?: string }).code === 'STALE_SESSION')
  assert.equal(h.defaults.saves.length, 0)
  const state = await h.backend.command('state') as Record<string, unknown>
  assert.equal(state.provider, 'p3')
  assert.equal(Object.hasOwn(state, 'reasoningEffort'), false, 'the moved default supplies no pinned level')
  await h.backend.close()
})