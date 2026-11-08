/**
 * Offline contract tests for the read-only native skill metadata seam.
 *
 * Every service is a local fake shaped like the public DSH surface: no profile,
 * credential, skill body, durable session, model request or subprocess is
 * touched. The fake `ctx.skills` deliberately exposes a `get()` that fails the
 * test if called, proving the adapter never loads instructions.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshBackend, type DshContextBackend } from '../src/backend/context.ts'
import type { BackendEvent, SessionInfo, SkillCatalogSnapshot } from '../src/backend/types.ts'
import {
  FakeAgentRegistry,
  FakeDshHost,
  FakeSessionWorld,
  fakeNativeHelpers,
  nextTask,
  type FakeAgentState,
} from '../src/backend/testing.ts'

type SnapshotOptions = { readonly cwd?: string; readonly scope?: unknown; readonly signal?: AbortSignal }

class FakeSkills {
  readonly calls: SnapshotOptions[] = []
  readonly getCalls: string[] = []
  handler: (options: SnapshotOptions) => unknown = () => ({ skills: [], complete: true })

  async snapshot(options: SnapshotOptions): Promise<unknown> {
    this.calls.push(options)
    return await this.handler(options)
  }

  /** The adapter must never ask the registry for a body. */
  async get(name: string): Promise<never> {
    this.getCalls.push(name)
    throw new Error('the TUI adapter must never load a skill body')
  }
}

/** Public list-only registry shape: metadata without a completeness fact. */
class FakeListSkills {
  readonly calls: SnapshotOptions[] = []
  handler: (options: SnapshotOptions) => unknown = () => []

  async list(options: SnapshotOptions): Promise<unknown> {
    this.calls.push(options)
    return await this.handler(options)
  }
}

interface FakePresetLease {
  readonly key: unknown
  readonly [Symbol.asyncDispose]: () => Promise<void>
  disposed: boolean
  disposeCount: number
}

/**
 * Fake `agentPresets` with the public live/cold reads the adapter mirrors:
 * `serviceFor(agent,'skills')` for the preset-isolated registry and
 * `acquireScope(id)` for a retained preset revision without an Agent.
 */
class FakePresets {
  readonly acquireCalls: Array<string | undefined> = []
  readonly leases: FakePresetLease[] = []
  readonly serviceForCalls: Array<{ readonly agent: unknown; readonly name: string }> = []
  scopeKey: unknown = { presetScope: true }
  acquireGate: Promise<void> | undefined
  failAcquire: Error | undefined
  failServiceFor: Error | undefined
  serviceForValue: unknown
  defaultId = 'standard'

  async acquireScope(id?: string): Promise<unknown> {
    this.acquireCalls.push(id)
    if (this.acquireGate !== undefined) await this.acquireGate
    if (this.failAcquire !== undefined) throw this.failAcquire
    const lease: FakePresetLease = {
      key: this.scopeKey,
      disposed: false,
      disposeCount: 0,
      [Symbol.asyncDispose]: async () => {
        lease.disposed = true
        lease.disposeCount += 1
      },
    }
    this.leases.push(lease)
    return lease
  }

  serviceFor(agent: unknown, name: string): unknown {
    this.serviceForCalls.push({ agent, name })
    if (this.failServiceFor !== undefined) throw this.failServiceFor
    return this.serviceForValue
  }

  async list(): Promise<readonly unknown[]> {
    return [{ id: this.defaultId }]
  }

  async resolve(id?: string): Promise<unknown> {
    return { id: id ?? this.defaultId }
  }

  presetForSession(): null {
    return null
  }

  async select(): Promise<string> {
    return this.defaultId
  }
}

/**
 * Fake `ctx.commands` with the exact scoped lookup the adapter must use.
 *
 * `scoped` models agent/preset-scoped definitions that a global `list()` does
 * not show; `execute` fails the test if the classification path ever runs a
 * command instead of returning a decision.
 */
class FakeCommands {
  readonly findCalls: Array<{ readonly agent: unknown; readonly name: string }> = []
  readonly listCalls: unknown[] = []
  readonly executeCalls: unknown[] = []
  readonly scoped = new Map<string, unknown>()
  global: Array<{ name: string }> = []
  failFind: Error | undefined

  find(agent: unknown, name: string): unknown {
    this.findCalls.push({ agent, name })
    if (this.failFind !== undefined) throw this.failFind
    return this.scoped.get(name)
  }

  list(agent?: unknown): readonly unknown[] {
    this.listCalls.push(agent)
    return this.global
  }

  async execute(): Promise<never> {
    this.executeCalls.push(true)
    throw new Error('input-route classification must never execute a command')
  }
}

interface Harness {
  readonly host: FakeDshHost
  readonly agents: FakeAgentRegistry
  readonly skills: FakeSkills
  readonly presets: FakePresets
  readonly world: FakeSessionWorld
  readonly native: ReturnType<typeof fakeNativeHelpers>
  readonly backend: DshContextBackend
  readonly events: BackendEvent[]
  readonly workingDirectoryCalls: unknown[]
}

function makeHarness(options: {
  withSkills?: boolean
  withPresets?: boolean
  withWorkingDirectory?: boolean
} = {}): Harness {
  const host = new FakeDshHost()
  const agents = new FakeAgentRegistry()
  const skills = new FakeSkills()
  const presets = new FakePresets()
  const world = new FakeSessionWorld().attach(host)
  const workingDirectoryCalls: unknown[] = []
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
  if (options.withSkills !== false) host.use('skills', skills)
  if (options.withPresets !== false) host.use('agentPresets', presets)
  if (options.withWorkingDirectory !== false) {
    host.use('workingDirectory', {
      ensure: async (agent: unknown) => {
        workingDirectoryCalls.push(agent)
        return '/workspace/from-working-directory'
      },
    })
  }
  const native = fakeNativeHelpers()
  const backend = createDshBackend(host, { cwd: '/tui-workspace', native })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  return { host, agents, skills, presets, world, native, backend, events, workingDirectoryCalls }
}

function lastReady(events: readonly BackendEvent[]): SessionInfo {
  const ready = [...events].reverse().find(event => event.type === 'ready')
  assert.ok(ready !== undefined && ready.type === 'ready', 'a ready event was announced')
  return ready.info
}

async function liveAgent(harness: Harness): Promise<{ info: SessionInfo; agent: FakeAgentState }> {
  await harness.backend.connect()
  await harness.backend.send('prompt')
  const agent = harness.agents.agents[0]
  assert.ok(agent, 'the fake native registry created one Agent')
  return { info: lastReady(harness.events), agent }
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string }).code
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const USER_SKILL = {
  name: 'skill-studio',
  description: 'Studio skill',
  invocation: { modelInvocable: true, userInvocable: true },
} as const

test('projects only the metadata whitelist for the exact live Agent scope', async () => {
  const harness = makeHarness()
  const { agent } = await liveAgent(harness)
  harness.skills.handler = () => ({
    complete: true,
    skills: [
      {
        name: 'alpha',
        description: 'Alpha skill',
        whenToUse: 'when A',
        invocation: { modelInvocable: true, userInvocable: true },
        path: '/private/SKILL.md',
        content: 'SECRET BODY',
        provider: 'filesystem',
        resourceBase: { kind: 'directory', path: '/private' },
        metadata: { secret: true },
        rank: 100,
        locator: { secret: true },
      },
      { name: 'model-only', description: 'model only', invocation: { modelInvocable: true, userInvocable: false } },
      { name: 'user-only', description: 'user only', invocation: { modelInvocable: false, userInvocable: true } },
    ],
  })

  const snapshot = await harness.backend.command('skills')
  assert.deepEqual(snapshot, {
    available: true,
    complete: true,
    entries: [
      { name: 'alpha', description: 'Alpha skill', whenToUse: 'when A', modelInvocable: true },
      { name: 'user-only', description: 'user only', modelInvocable: false },
    ],
  })
  const wire = JSON.stringify(snapshot)
  assert.ok(!wire.includes('SECRET'), 'no skill body crosses the adapter')
  assert.ok(!wire.includes('/private'), 'no native path/resource base crosses the adapter')
  assert.equal(harness.skills.getCalls.length, 0, 'the adapter never loads a skill definition')
  assert.equal(harness.skills.calls.length, 1)
  const call = harness.skills.calls[0]!
  assert.equal(call.cwd, '/workspace/from-working-directory', 'the native working directory is the lookup cwd')
  assert.equal(call.scope, agent, 'the exact live Agent is the viewing scope')
  assert.ok(call.signal instanceof AbortSignal, 'the query owns an abort signal')
  assert.deepEqual(harness.workingDirectoryCalls, [agent])
  assert.deepEqual(harness.presets.serviceForCalls, [{ agent, name: 'skills' }])
  assert.equal(harness.host.services.has('tools'), false, 'tool-schema visibility is never consulted')
  await harness.backend.close()
})

test('falls back to the session workspace only when no working-directory service is mounted', async () => {
  const harness = makeHarness({ withWorkingDirectory: false })
  await liveAgent(harness)
  harness.skills.handler = () => ({ skills: [], complete: true })
  await harness.backend.command('skills')
  assert.equal(harness.skills.calls[0]?.cwd, '/workspace', 'the native session header cwd is the fallback')

  // A mounted service that fails or returns no directory is a real failure, not
  // a reason to silently scan a different workspace.
  const failing = makeHarness()
  await liveAgent(failing)
  failing.host.use('workingDirectory', { ensure: async () => { throw new Error('workspace unavailable') } })
  await assert.rejects(failing.backend.command('skills'), (error: unknown) => codeOf(error) === 'RUNTIME_REQUEST_FAILED')
  assert.equal(failing.skills.calls.length, 0, 'no discovery ran against an unknown cwd')
  await harness.backend.close()
  await failing.backend.close()
})

test('bad entries fail closed and never claim a complete catalog', async () => {
  const harness = makeHarness()
  await liveAgent(harness)
  harness.skills.handler = () => ({
    complete: true,
    skills: [
      { name: 'ok', description: 'fine', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'bad-flag', description: 'x', invocation: { modelInvocable: 'yes', userInvocable: true } },
      { name: 'missing-description', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'bad/name', description: 'x', invocation: { modelInvocable: true, userInvocable: true } },
      { name: 'bad-when', description: 'x', whenToUse: 7, invocation: { modelInvocable: true, userInvocable: true } },
      null,
    ],
  })
  const snapshot = await harness.backend.command('skills') as { entries: unknown[]; available: boolean; complete: boolean }
  assert.deepEqual(snapshot.entries, [{ name: 'ok', description: 'fine', modelInvocable: true }])
  assert.equal(snapshot.available, true)
  assert.equal(snapshot.complete, false, 'malformed entries are never presented as authoritative')

  harness.skills.handler = () => ({ complete: false, skills: [] })
  assert.deepEqual(await harness.backend.command('skills'), { entries: [], available: true, complete: false })

  harness.skills.handler = () => ({ skills: 'not-an-array' })
  await assert.rejects(harness.backend.command('skills'), (error: unknown) => codeOf(error) === 'RUNTIME_REQUEST_FAILED')
  harness.skills.handler = () => ({})
  await assert.rejects(harness.backend.command('skills'), (error: unknown) => codeOf(error) === 'RUNTIME_REQUEST_FAILED')
  await harness.backend.close()
})

test('pending metadata uses the native preset lease without materializing an Agent', async () => {
  const harness = makeHarness()
  harness.skills.handler = () => ({ complete: true, skills: [USER_SKILL] })
  const info = await harness.backend.connect()
  assert.ok(info.capabilities.includes('skills'), 'registry readability is the capability')
  assert.ok(info.capabilities.includes('input-route'))

  const snapshot = await harness.backend.command('skills')
  assert.deepEqual(snapshot, {
    entries: [{ name: 'skill-studio', description: 'Studio skill', modelInvocable: true }],
    available: true,
    complete: true,
  })
  assert.deepEqual(harness.presets.acquireCalls, [undefined], 'undefined asks for the native current default')
  assert.equal(harness.agents.createCalls.length, 0, 'a menu read never creates a durable session')
  assert.equal(harness.native.messages.length, 0, 'a menu read sends no model prompt')
  assert.equal(harness.skills.calls.length, 1)
  assert.equal(harness.skills.calls[0]?.cwd, '/tui-workspace')
  assert.equal(harness.skills.calls[0]?.scope, harness.presets.scopeKey)
  assert.equal(harness.presets.leases.length, 1)
  assert.equal(harness.presets.leases[0]?.disposed, true, 'the revision lease is released after the read')
  assert.equal(harness.events.some(event => event.type === 'skills_changed'), false, 'a read causes no self-invalidation')
  await harness.backend.close()
})

test('a staged preset id is the lease identity and a preset switch retires the read', async () => {
  const harness = makeHarness()
  harness.skills.handler = () => ({ complete: true, skills: [] })
  await harness.backend.connect()
  await harness.backend.command('preset', { id: 'minimal' })
  await harness.backend.command('skills')
  assert.deepEqual(harness.presets.acquireCalls, ['minimal'])

  const gate = deferred<void>()
  harness.presets.acquireGate = gate.promise
  const pending = harness.backend.command('skills')
  await nextTask()
  await harness.backend.command('preset', { id: 'standard' })
  gate.resolve()
  await assert.rejects(pending, (error: unknown) => codeOf(error) === 'ABORTED')
  assert.equal(harness.presets.leases.at(-1)?.disposed, true, 'a lease acquired after the switch is still released')
  await harness.backend.close()
})

test('a scope lease acquired after close or materialization is always released', async () => {
  const closed = makeHarness()
  await closed.backend.connect()
  const closeGate = deferred<void>()
  closed.presets.acquireGate = closeGate.promise
  const closing = closed.backend.command('skills')
  await nextTask()
  await closed.backend.close()
  closeGate.resolve()
  await assert.rejects(closing, (error: unknown) => codeOf(error) === 'ABORTED')
  assert.equal(closed.presets.leases.at(-1)?.disposed, true)
  assert.equal(closed.presets.leases.at(-1)?.disposeCount, 1)

  const materialized = makeHarness()
  await materialized.backend.connect()
  const materializeGate = deferred<void>()
  materialized.presets.acquireGate = materializeGate.promise
  const pendingRead = materialized.backend.command('skills')
  await nextTask()
  await materialized.backend.send('prompt')
  materializeGate.resolve()
  await assert.rejects(pendingRead, (error: unknown) => codeOf(error) === 'ABORTED')
  assert.equal(materialized.presets.leases.at(-1)?.disposed, true)
  await materialized.backend.close()
})

test('a failed preset lease preserves the native diagnostic and never substitutes another preset', async () => {
  const harness = makeHarness()
  await harness.backend.connect()
  harness.presets.failAcquire = new Error('preset scope denied: api_key=sk-lease123')
  await assert.rejects(harness.backend.command('skills'), (error: unknown) => {
    assert.equal(codeOf(error), 'RUNTIME_REQUEST_FAILED')
    assert.ok(!(error as Error).message.includes('sk-lease123'))
    assert.ok((error as Error).message.includes('agent-preset scope could not be acquired'))
    return true
  })
  assert.equal(harness.skills.calls.length, 0, 'no fallback registry read happened')
  await harness.backend.close()
})

test('without a lease API a pending read is an explicitly incomplete global observation', async () => {
  const harness = makeHarness({ withPresets: false })
  harness.host.use('skills', harness.skills)
  harness.skills.handler = () => ({ complete: true, skills: [USER_SKILL] })
  await harness.backend.connect()
  const snapshot = await harness.backend.command('skills') as SkillCatalogSnapshot
  assert.equal(snapshot.available, true)
  assert.equal(snapshot.complete, false, 'a global view never claims preset completeness')
  assert.deepEqual(snapshot.entries, [{ name: 'skill-studio', description: 'Studio skill', modelInvocable: true }])
  assert.equal(harness.skills.calls[0]?.scope, undefined)
  assert.equal(harness.skills.calls[0]?.cwd, '/tui-workspace')
  await harness.backend.close()
})

test('missing or partial native services degrade honestly', async () => {
  const missingSkills = makeHarness({ withSkills: false })
  await liveAgent(missingSkills)
  assert.equal(lastReady(missingSkills.events).capabilities.includes('skills'), false)
  assert.deepEqual(await missingSkills.backend.command('skills'), { entries: [], available: false, complete: false })
  await missingSkills.backend.close()

  const partial = makeHarness()
  partial.host.use('skills', {})
  await liveAgent(partial)
  assert.equal(lastReady(partial.events).capabilities.includes('skills'), false)
  assert.deepEqual(await partial.backend.command('skills'), { entries: [], available: false, complete: false })
  await partial.backend.close()

  const pendingMissing = makeHarness({ withSkills: false })
  await pendingMissing.backend.connect()
  assert.deepEqual(await pendingMissing.backend.command('skills'), { entries: [], available: false, complete: false })
  assert.equal(pendingMissing.presets.leases.at(-1)?.disposed, true, 'an absent registry still releases the lease')
  await pendingMissing.backend.close()
})

test('a list-only native registry is projected as incomplete without inventing completeness', async () => {
  const harness = makeHarness({ withSkills: false })
  const listed = new FakeListSkills()
  listed.handler = () => [
    { name: 'alpha', description: 'Alpha', invocation: { modelInvocable: true, userInvocable: true } },
    { name: 'hidden', description: 'Hidden', invocation: { modelInvocable: true, userInvocable: false } },
  ]
  harness.host.use('skills', listed)
  const { info } = await liveAgent(harness)
  assert.ok(info.capabilities.includes('skills'), 'list is a readable native metadata API')
  const snapshot = await harness.backend.command('skills')
  assert.deepEqual(snapshot, {
    entries: [{ name: 'alpha', description: 'Alpha', modelInvocable: true }],
    available: true,
    complete: false,
  })
  assert.equal(listed.calls.length, 1)
  assert.equal(harness.skills.calls.length, 0, 'the list-only registry is used exactly')
  await harness.backend.close()
})

test('the preset-isolated live registry wins over the host registry', async () => {
  const harness = makeHarness()
  const scoped = new FakeSkills()
  scoped.handler = () => ({ complete: true, skills: [USER_SKILL] })
  harness.presets.serviceForValue = scoped
  const { agent } = await liveAgent(harness)
  const snapshot = await harness.backend.command('skills') as SkillCatalogSnapshot
  assert.deepEqual(snapshot.entries, [{ name: 'skill-studio', description: 'Studio skill', modelInvocable: true }])
  assert.equal(scoped.calls.length, 1)
  assert.equal(harness.skills.calls.length, 0, 'the host registry is not consulted when the preset view exists')
  assert.equal(scoped.calls[0]?.scope, agent)
  assert.deepEqual(harness.presets.serviceForCalls, [{ agent, name: 'skills' }])
  await harness.backend.close()
})

test('a failed preset registry lookup stays visible and falls back to the host registry', async () => {
  const harness = makeHarness()
  await liveAgent(harness)
  harness.presets.failServiceFor = new Error('isolated skills lookup failed')
  harness.skills.handler = () => ({ complete: true, skills: [] })
  assert.deepEqual(await harness.backend.command('skills'), { entries: [], available: true, complete: true })
  assert.equal(harness.skills.calls.length, 1, 'the host registry served the observation')
  assert.equal(harness.host.warnings.some(warning => warning.includes('preset skill registry lookup failed')), true)
  await harness.backend.close()
})

test('a mounted skill provider is listed even with no tool registry or visible skill tool', async () => {
  const harness = makeHarness()
  await liveAgent(harness)
  harness.skills.handler = () => ({ complete: true, skills: [USER_SKILL] })
  assert.equal(harness.host.services.has('tools'), false)
  const snapshot = await harness.backend.command('skills') as SkillCatalogSnapshot
  assert.equal(snapshot.available, true)
  assert.deepEqual(snapshot.entries, [{ name: 'skill-studio', description: 'Studio skill', modelInvocable: true }])
  await harness.backend.close()
})

test('native invalidation forwards no payload and replays the pre-commit event after ready', async () => {
  const harness = makeHarness()
  const { info } = await liveAgent(harness)
  harness.host.emit('skills/change', { secret: 'payload', sessionId: 'child-session' })
  const invalidations = harness.events.filter(event => event.type === 'skills_changed')
  assert.deepEqual(invalidations, [{ type: 'skills_changed', sessionId: info.sessionId, attachmentId: info.attachmentId }])
  assert.equal(harness.host.listenerCount('skills/change'), 1)
  await harness.backend.close()
  assert.equal(harness.host.listenerCount('skills/change'), 0, 'close releases the host listener')

  const pendingHarness = makeHarness()
  const pendingInfo = await pendingHarness.backend.connect()
  pendingHarness.host.emit('skills/change')
  assert.deepEqual(pendingHarness.events.filter(event => event.type === 'skills_changed'), [{
    type: 'skills_changed',
    sessionId: pendingInfo.sessionId,
    attachmentId: pendingInfo.attachmentId,
  }], 'a pending lease can legitimately observe provider changes')
  await pendingHarness.backend.send('prompt')
  const afterReady = pendingHarness.events.filter(event => event.type === 'skills_changed')
  assert.equal(afterReady.length, 2, 'the pre-commit invalidation is replayed once after ready')
  assert.deepEqual(afterReady[1], {
    type: 'skills_changed',
    sessionId: pendingInfo.sessionId,
    attachmentId: pendingInfo.attachmentId,
  })
  await pendingHarness.backend.close()
})

test('close aborts an in-flight query and never joins an uncooperative provider', async () => {
  const cooperative = makeHarness()
  await liveAgent(cooperative)
  cooperative.skills.handler = options => new Promise<unknown>((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new Error('native discovery aborted')), { once: true })
  })
  const pending = cooperative.backend.command('skills')
  await nextTask()
  await cooperative.backend.close()
  await assert.rejects(pending, (error: unknown) => codeOf(error) === 'ABORTED')

  const stuck = makeHarness()
  await liveAgent(stuck)
  stuck.skills.handler = () => new Promise<unknown>(() => {})
  const orphan = stuck.backend.command('skills')
  await nextTask()
  await stuck.backend.close()
  // The adapter aborted and dropped the query instead of waiting for the scan.
  // `orphan` intentionally stays unsettled; assert close already completed.
  assert.equal(stuck.skills.calls.length, 1)
  void orphan.catch(() => {})
})

test('a query from a retired attachment cannot deliver its late result', async () => {
  const harness = makeHarness()
  const { info } = await liveAgent(harness)
  const gate = deferred<unknown>()
  harness.skills.handler = () => gate.promise
  const pending = harness.backend.command('skills')
  await nextTask()
  const next = await harness.backend.command('new') as SessionInfo
  assert.notEqual(next.sessionId, info.sessionId)
  gate.resolve({ complete: true, skills: [USER_SKILL] })
  await assert.rejects(pending, (error: unknown) => codeOf(error) === 'ABORTED')
  await harness.backend.close()
})

test('reload and live preset changes retire an in-flight read', async () => {
  const reloading = makeHarness()
  const reloaded = await liveAgent(reloading)
  reloaded.agent.status = 'idle'
  reloading.host.use('hmr', {
    runExclusive: async (task: () => Promise<unknown>) => await task(),
    reconcileProfile: async () => ({ changed: false }),
  })
  reloading.skills.handler = options => new Promise<unknown>((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
  const reloadQuery = reloading.backend.command('skills')
  await nextTask()
  await reloading.backend.command('reload')
  await assert.rejects(reloadQuery, (error: unknown) => codeOf(error) === 'ABORTED')
  await reloading.backend.close()

  const presets = makeHarness()
  const { agent } = await liveAgent(presets)
  presets.world.add({
    id: agent.id,
    live: true,
    projections: { turnBoundary: { openTurnStartSeq: null, lastTurn: 0 } },
  })
  presets.skills.handler = options => new Promise<unknown>((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
  const presetQuery = presets.backend.command('skills')
  await nextTask()
  await presets.backend.command('preset', { id: 'minimal' })
  await assert.rejects(presetQuery, (error: unknown) => codeOf(error) === 'ABORTED')
  await presets.backend.close()
})

test('native failures are bounded and credential-redacted', async () => {
  const harness = makeHarness()
  await liveAgent(harness)
  harness.skills.handler = () => {
    throw new Error('discovery failed: api_key=sk-secretvalue123 authorization: Bearer abcdef')
  }
  await assert.rejects(harness.backend.command('skills'), (error: unknown) => {
    const message = (error as Error).message
    assert.equal(codeOf(error), 'RUNTIME_REQUEST_FAILED')
    assert.ok(!message.includes('sk-secretvalue123'), 'provider key shape is redacted')
    assert.ok(!message.includes('abcdef'), 'authorization value is redacted')
    assert.ok(message.includes('the native skill registry failed'))
    return true
  })
  await harness.backend.close()
})

// ------------------------------------------------- explicit input routing

test('explicit input routing materializes the Agent once and never sends or executes', async () => {
  const harness = makeHarness()
  const commands = new FakeCommands()
  commands.scoped.set('compact', { name: 'compact' })
  harness.host.use('commands', commands)
  const pending = await harness.backend.connect()
  assert.ok(pending.capabilities.includes('input-route'), 'the runtime advertises the routing decision')
  assert.equal(harness.agents.createCalls.length, 0)

  const route = await harness.backend.command('input-route', { name: 'compact' })
  const agent = harness.agents.agents[0]
  assert.ok(agent, 'the submitted name materialized the native Agent exactly once')
  assert.equal(harness.agents.createCalls.length, 1)
  const info = lastReady(harness.events)
  assert.deepEqual(route, { kind: 'command', sessionId: agent.id, attachmentId: info.attachmentId })
  assert.deepEqual(commands.findCalls, [{ agent, name: 'compact' }], 'the exact Agent scope is the lookup key')
  assert.equal(harness.skills.calls.length, 0, 'classification never reads skill metadata')
  assert.equal(harness.skills.getCalls.length, 0)
  assert.equal(harness.native.messages.length, 0, 'nothing was sent as a model prompt')
  assert.equal(agent.sent.length, 0)
  assert.equal(commands.executeCalls.length, 0, 'nothing was executed')

  // The Agent already exists: a repeat classification adds no new session.
  const prompt = await harness.backend.command('input-route', { name: 'unknown-skill' })
  assert.deepEqual(prompt, { kind: 'prompt', sessionId: agent.id, attachmentId: info.attachmentId })
  assert.equal(harness.agents.createCalls.length, 1)
  assert.equal(harness.native.messages.length, 0)
  await harness.backend.close()
})

test('a malformed name rejects before any Agent is materialized', async () => {
  const harness = makeHarness()
  harness.host.use('commands', new FakeCommands())
  await harness.backend.connect()
  for (const bad of ['Bad Name', '/compact', 'Compact', '', 'two/parts', 42, undefined]) {
    await assert.rejects(
      harness.backend.command('input-route', { name: bad }),
      (error: unknown) => codeOf(error) === 'INVALID_ARGUMENT',
      `rejects ${JSON.stringify(bad)}`,
    )
  }
  assert.equal(harness.agents.createCalls.length, 0, 'validation happens before the lazy Agent path')
  assert.equal(harness.events.filter(event => event.type === 'ready').length, 1, 'only the pending announcement was published')
  await harness.backend.close()
})

test('a native agent-scoped command beats a same-name skill even when global list omits it', async () => {
  const harness = makeHarness()
  const commands = new FakeCommands()
  commands.scoped.set('compact', { name: 'compact' })
  commands.global = []
  harness.host.use('commands', commands)
  harness.skills.handler = () => ({
    complete: true,
    skills: [{ name: 'compact', description: 'skill with the same name', invocation: { modelInvocable: true, userInvocable: true } }],
  })
  const { agent, info } = await liveAgent(harness)
  const route = await harness.backend.command('input-route', { name: 'compact' })
  assert.deepEqual(route, { kind: 'command', sessionId: agent.id, attachmentId: info.attachmentId })
  assert.equal(harness.skills.calls.length, 0, 'no skill metadata is consulted for the precedence decision')
  await harness.backend.close()
})

test('an unknown name is literal prompt input only when a native skill registry exists', async () => {
  const harness = makeHarness()
  harness.host.use('commands', new FakeCommands())
  const { agent, info } = await liveAgent(harness)
  const sentBefore = harness.native.messages.length
  const prompt = await harness.backend.command('input-route', { name: 'my-skill' })
  assert.deepEqual(prompt, { kind: 'prompt', sessionId: agent.id, attachmentId: info.attachmentId })
  assert.equal(harness.native.messages.length, sentBefore, 'the classifier itself sent nothing')
  assert.equal(harness.skills.calls.length, 0, 'the decision never reads skill metadata')
  await harness.backend.close()

  const noRegistry = makeHarness({ withSkills: false })
  noRegistry.host.use('commands', new FakeCommands())
  const plain = await liveAgent(noRegistry)
  assert.deepEqual(
    await noRegistry.backend.command('input-route', { name: 'my-skill' }),
    { kind: 'command', sessionId: plain.agent.id, attachmentId: plain.info.attachmentId },
  )
  await noRegistry.backend.close()
})

test('a missing command registry still routes skill-enabled unknown names to prompts', async () => {
  const absent = makeHarness()
  const linked = await liveAgent(absent)
  assert.equal(linked.info.capabilities.includes('input-route'), true, 'routing does not require the command registry')
  assert.deepEqual(
    await absent.backend.command('input-route', { name: 'some-skill' }),
    { kind: 'prompt', sessionId: linked.agent.id, attachmentId: linked.info.attachmentId },
  )
  await absent.backend.close()

  const noSkill = makeHarness({ withSkills: false })
  const plain = await liveAgent(noSkill)
  assert.deepEqual(
    await noSkill.backend.command('input-route', { name: 'some-skill' }),
    { kind: 'command', sessionId: plain.agent.id, attachmentId: plain.info.attachmentId },
  )
  await noSkill.backend.close()
})

test('an older host with only commands.list still resolves an agent-scoped name', async () => {
  const harness = makeHarness()
  const listed: Array<{ name: string }> = [{ name: 'plan' }]
  const listCalls: unknown[] = []
  harness.host.use('commands', {
    list: (agent?: unknown) => {
      listCalls.push(agent)
      return listed
    },
  })
  const { agent, info } = await liveAgent(harness)
  assert.deepEqual(
    await harness.backend.command('input-route', { name: 'plan' }),
    { kind: 'command', sessionId: agent.id, attachmentId: info.attachmentId },
  )
  assert.deepEqual(listCalls, [agent], 'the list fallback reads the exact Agent scope')
  assert.deepEqual(
    await harness.backend.command('input-route', { name: 'not-a-command' }),
    { kind: 'prompt', sessionId: agent.id, attachmentId: info.attachmentId },
  )
  await harness.backend.close()
})

test('a partially mounted command service cannot be mistaken for an absent command', async () => {
  const harness = makeHarness()
  harness.host.use('commands', {})
  const { agent, info } = await liveAgent(harness)
  // No readable native lookup means native precedence is unknown; keep the
  // command error path instead of turning a possible command into a prompt.
  assert.deepEqual(
    await harness.backend.command('input-route', { name: 'compact' }),
    { kind: 'command', sessionId: agent.id, attachmentId: info.attachmentId },
  )
  await harness.backend.close()
})

test('an unreadable command lookup keeps native precedence and stays redacted', async () => {
  const harness = makeHarness()
  const commands = new FakeCommands()
  commands.failFind = new Error('registry failed: api_key=sk-routex123')
  harness.host.use('commands', commands)
  const { agent, info } = await liveAgent(harness)
  assert.deepEqual(
    await harness.backend.command('input-route', { name: 'compact' }),
    { kind: 'command', sessionId: agent.id, attachmentId: info.attachmentId },
  )
  assert.equal(harness.host.warnings.some(warning => warning.includes('DSH command lookup failed')), true)
  assert.equal(harness.host.warnings.some(warning => warning.includes('sk-routex123')), false)
  await harness.backend.close()
})