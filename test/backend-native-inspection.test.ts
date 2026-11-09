/**
 * Offline contract tests for the read-only native inspection adapter.
 *
 * Every fact is a synthetic Cordis-shaped service double: no profile,
 * credential, real Session/Job/Goal, Loader tree, Agent creation, model request
 * or terminal is touched. The doubles mirror the public native signatures the
 * adapter calls (`ctx.jobs`, `ctx.goals`, `ctx.workingDirectory`,
 * `ctx.sessionProjections`, `ctx.tools`, `readPluginInventory(ctx)`), including
 * native ordering, owner fencing, failure modes, malformed rows and async
 * attachment changes.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  NativeInspection,
  goalChangedInvalidation,
  inventoryInvalidationDomain,
  jobEventInvalidation,
  projectionInvalidationDomain,
  toolsInvalidationDomain,
  type GoalRead,
  type JobOutputRead,
  type JobsRead,
  type PluginInventoryRead,
  type ToolCatalogRead,
  type WorkingDirectoryRead,
} from '../src/backend/native-inspection.ts'
import type { NativeUiAccess, NativeUiScope } from '../src/backend/native-ui-scope.ts'

const ROOT = 'root-session'
const ATTACHMENT = 'attachment-1'
const OTHER = 'other-session'

type RawRow = Record<string, unknown>

/** Minimal seam double; `scope` is replaced wholesale to model an attachment switch. */
class FakeAccess implements NativeUiAccess {
  readonly host: unknown = { nativeContext: true }
  readonly services = new Map<string, unknown>()
  readonly warnings: string[] = []
  scope: NativeUiScope | undefined
  private detachOnService = false
  private detach: (() => void) | undefined

  constructor(scope: NativeUiScope | undefined) {
    this.scope = scope
  }

  service(name: string): unknown {
    if (this.detachOnService) this.detach?.()
    return this.services.get(name)
  }

  current(): NativeUiScope | undefined {
    return this.scope
  }

  isCurrent(scope: NativeUiScope): boolean {
    return this.scope === scope
  }

  warn(message: string): void {
    this.warnings.push(message)
  }

  use(name: string, service: unknown): this {
    this.services.set(name, service)
    return this
  }

  /** Flip the attachment as soon as any service is looked up. */
  detachOnNextService(read: () => void): void {
    this.detachOnService = true
    this.detach = read
  }
}

function scopeOf(options: {
  session?: unknown
  agent?: unknown
  attachmentId?: string
  sessionId?: string
} = {}): NativeUiScope {
  return {
    sessionId: options.sessionId ?? ROOT,
    ...(options.attachmentId === undefined ? { attachmentId: ATTACHMENT } : { attachmentId: options.attachmentId }),
    ...(options.session === undefined ? {} : { session: options.session }),
    ...(options.agent === undefined ? {} : { agent: options.agent }),
  }
}

function fakeSession(headerCwd: string | undefined = '/work', id = ROOT): RawRow {
  return { id, header: headerCwd === undefined ? {} : { cwd: headerCwd } }
}

function jobView(overrides: RawRow = {}): RawRow {
  return {
    id: 'bash-0000000000000001',
    kind: 'bash',
    label: 'pnpm test',
    owner: ROOT,
    status: 'running',
    startedAt: 1_700_000_000_000,
    output: { total: 0, earliest: 0 },
    ...overrides,
  }
}

function goalView(overrides: RawRow = {}): RawRow {
  return {
    id: 'goal-1',
    revision: 3,
    objective: 'Ship the inspector',
    phase: 'active',
    maxGoalRounds: 10,
    roundsStarted: 2,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    activation: 'armed',
    ...overrides,
  }
}

function projectionSnapshot(values: Record<string, unknown>): RawRow {
  return { asOfSeq: 12, values }
}

async function jobsOf(access: NativeUiAccess, options: ConstructorParameters<typeof NativeInspection>[0] = { access }): Promise<JobsRead> {
  return await new NativeInspection(options).jobs()
}

function assertAvailable<T extends { available: boolean }>(value: T): asserts value is T & { available: true } {
  assert.equal(value.available, true, `expected available, got ${JSON.stringify(value)}`)
}

function assertUnavailable(value: { available: boolean; reason?: string }, reason: string): void {
  assert.deepEqual(value, { available: false, reason })
}

// ------------------------------------------------------------------- jobs

test('jobs: native order, unowned rows, whitelist and immutable projection', async () => {
  const older = jobView({ id: 'bash-0000000000000002', label: 'second', startedAt: 2 })
  const newer = jobView({ id: 'bash-0000000000000001', label: 'first', startedAt: 1, progress: '3/10' })
  const unowned = jobView({ id: 'bash-0000000000000003', label: 'shared', owner: undefined })
  const registry = {
    rows: [older, newer, unowned],
    calls: [] as Array<string | undefined>,
    list(caller?: string): unknown[] {
      this.calls.push(caller)
      return this.rows
    },
  }
  const access = new FakeAccess(scopeOf())
  access.use('jobs', registry)
  const read = await jobsOf(access)
  assertAvailable(read)
  assert.deepEqual(registry.calls, [ROOT])
  assert.deepEqual(read.jobs.map(job => job.id), [
    'bash-0000000000000002',
    'bash-0000000000000001',
    'bash-0000000000000003',
  ])
  assert.equal(read.complete, true)
  assert.equal(read.jobs[0]?.owned, true)
  assert.equal(read.jobs[2]?.owned, false)
  assert.deepEqual(read.jobs[1], {
    id: 'bash-0000000000000001',
    kind: 'bash',
    label: 'first',
    status: 'running',
    owned: true,
    startedAt: 1,
    progress: '3/10',
    output: { total: 0, earliest: 0, evicted: false },
  })
  // Host spill paths and the raw owner id are not part of the UI projection.
  assert.equal('owner' in read.jobs[0]!, false)
  assert.equal('spillPaths' in (read.jobs[0]!.output as RawRow), false)
  // The projection never aliases a native row object.
  assert.notEqual(read.jobs[0], registry.rows[0])
  assert.notEqual(read.jobs[0]!.output, (registry.rows[0] as RawRow).output)
})

test('jobs: foreign owner and malformed rows are dropped and marked incomplete', async () => {
  const registry = {
    rows: [
      jobView({ id: 'bash-0000000000000004' }),
      jobView({ id: 'bash-0000000000000005', owner: OTHER }),
      { id: 'bash-0000000000000006', kind: 'bash', label: 'broken' },
      jobView({ id: 'bash-0000000000000007', status: 'teleported' }),
    ],
    list(): unknown[] {
      return this.rows
    },
  }
  const access = new FakeAccess(scopeOf())
  access.use('jobs', registry)
  const read = await jobsOf(access)
  assertAvailable(read)
  assert.equal(read.complete, false)
  assert.deepEqual(read.jobs.map(job => job.id), [
    'bash-0000000000000004',
    'bash-0000000000000007',
  ])
  assert.equal(read.jobs[1]?.status, 'unknown')
})

test('jobs: missing service, failing service and stale attachment are not empty lists', async () => {
  const missing = new FakeAccess(scopeOf())
  assertUnavailable(await jobsOf(missing), 'missing-service')

  const failing = new FakeAccess(scopeOf())
  failing.use('jobs', {
    list(): unknown[] {
      throw new Error('registry exploded with Authorization: Bearer supersecret')
    },
  })
  assertUnavailable(await jobsOf(failing), 'native-failed')
  assert.equal(failing.warnings.length, 1)
  assert.match(failing.warnings[0]!, /registry exploded/)
  assert.match(failing.warnings[0]!, /Authorization: \[redacted\]/)
  assert.doesNotMatch(failing.warnings[0]!, /supersecret/)

  const malformed = new FakeAccess(scopeOf())
  malformed.use('jobs', { list: () => 'not-an-array' })
  assertUnavailable(await jobsOf(malformed), 'malformed')

  const noAttachment = new FakeAccess(undefined)
  assertUnavailable(await jobsOf(noAttachment), 'no-attachment')

  // Attachment identity is re-validated after the native call resolves.
  const stale = new FakeAccess(scopeOf())
  stale.use('jobs', {
    list(): unknown[] {
      stale.scope = scopeOf({ attachmentId: 'attachment-2' })
      return [jobView()]
    },
  })
  assertUnavailable(await jobsOf(stale), 'stale-attachment')

  // A hostile isCurrent that still says yes is not enough: the seam's current
  // scope must name the exact same attachment.
  const hostile = new FakeAccess(scopeOf())
  hostile.use('jobs', {
    list(): unknown[] {
      hostile.scope = scopeOf({ sessionId: ROOT, attachmentId: 'attachment-3' })
      return [jobView()]
    },
  })
  hostile.isCurrent = () => true
  assertUnavailable(await jobsOf(hostile), 'stale-attachment')
})

test('jobs: pending identity reads the roster without creating an Agent', async () => {
  const registry = { rows: [jobView()], calls: [] as string[] }
  const access = new FakeAccess({ sessionId: ROOT })
  access.use('jobs', {
    list(caller?: string): unknown[] {
      registry.calls.push(caller ?? '')
      return registry.rows
    },
  })
  access.use('agents', {
    get(): never {
      throw new Error('the inspector must never materialize an Agent')
    },
  })
  const read = await jobsOf(access)
  assertAvailable(read)
  assert.deepEqual(registry.calls, [ROOT])
  assert.equal(read.jobs.length, 1)
})

test('bounds: labels, status text and descriptions truncate without splitting surrogate pairs', async () => {
  const registry = {
    list(): unknown[] {
      return [jobView({
        label: 'x'.repeat(8) + '\u{1F600}',
        progress: 'p'.repeat(40),
        detail: 'd'.repeat(40),
        status: 'running',
      })]
    },
  }
  const access = new FakeAccess(scopeOf())
  access.use('jobs', registry)
  const read = await new NativeInspection({ access, maxTextChars: 9 }).jobs()
  assertAvailable(read)
  assert.equal(read.jobs[0]!.label, 'x'.repeat(8))
  assert.equal(read.jobs[0]!.progress, 'p'.repeat(9))
  assert.equal(read.jobs[0]!.detail, 'd'.repeat(9))

  const tools = new FakeAccess(scopeOf({ session: fakeSession(), agent: {} }))
  tools.use('tools', {
    definitions: () => [{ name: 'bash', description: 'y'.repeat(50) }],
    executable: () => undefined,
  })
  const catalog = await new NativeInspection({ access: tools, maxTextChars: 12 }).toolCatalog()
  assertAvailable(catalog as { available: boolean })
  assert.equal((catalog as Extract<ToolCatalogRead, { available: true }>).tools[0]!.description, 'y'.repeat(12))
})

// ------------------------------------------------------------- job output

test('job output: non-consuming readAt from earliest, native order and channels', async () => {
  const registry = {
    getCalls: [] as Array<{ id: string; caller?: string }>,
    readCalls: [] as Array<{ id: string; from: number; caller?: string }>,
    get(id: string, caller?: string): unknown {
      this.getCalls.push({ id, caller })
      return jobView({ id, status: 'completed', output: { total: 40, earliest: 8 } })
    },
    readAt(id: string, from: number, caller?: string): unknown {
      this.readCalls.push({ id, from, caller })
      return {
        chunks: [
          { at: 8, text: 'first\n', channel: 'stdout' },
          { at: 14, text: 'warn\n', channel: 'stderr', gapBefore: true },
          { at: 20, text: 'note\n', channel: 'log' },
          { at: 25, text: 'odd\n', channel: 'stdin' },
        ],
        next: 40,
        lossy: true,
      }
    },
  }
  const access = new FakeAccess(scopeOf())
  access.use('jobs', registry)
  const read = await new NativeInspection({ access }).jobOutput('bash-0000000000000001')
  assertAvailable(read as { available: boolean })
  const output = read as Extract<JobOutputRead, { available: true }>
  assert.deepEqual(registry.getCalls, [{ id: 'bash-0000000000000001', caller: ROOT }])
  assert.deepEqual(registry.readCalls, [{ id: 'bash-0000000000000001', from: 8, caller: ROOT }])
  assert.equal(output.from, 8)
  assert.equal(output.next, 40)
  assert.equal(output.lossy, true)
  assert.equal(output.truncated, false)
  assert.equal(output.complete, true)
  assert.equal(output.job.status, 'completed')
  assert.equal(output.job.output.evicted, true)
  assert.deepEqual(output.chunks, [
    { at: 8, text: 'first\n', channel: 'stdout' },
    { at: 14, text: 'warn\n', channel: 'stderr', gapBefore: true },
    { at: 20, text: 'note\n', channel: 'log' },
    { at: 25, text: 'odd\n' },
  ])
})

test('job output: byte bound keeps chunk boundaries and resumes at the first omitted chunk', async () => {
  const chunks = Array.from({ length: 40 }, (_, index) => ({
    at: index * 10,
    text: 'x'.repeat(10),
    channel: 'stdout',
  }))
  const registry = {
    get(): unknown {
      return jobView({ output: { total: 400, earliest: 0 } })
    },
    readAt(): unknown {
      return { chunks, next: 400, lossy: false }
    },
  }
  const access = new FakeAccess(scopeOf())
  access.use('jobs', registry)
  const read = await new NativeInspection({ access, maxOutputBytes: 48 }).jobOutput('bash-0000000000000001')
  assertAvailable(read as { available: boolean })
  const output = read as Extract<JobOutputRead, { available: true }>
  assert.equal(output.chunks.length, 4)
  assert.equal(output.truncated, true)
  assert.equal(output.complete, true)
  // The resume offset is the first chunk this read did not include, never a
  // mid-chunk offset that would duplicate text on the next read.
  assert.equal(output.next, 40)
  assert.deepEqual(output.chunks.map(chunk => chunk.at), [0, 10, 20, 30])
})

test('job output: one oversized chunk ships a bounded head and reports truncation', async () => {
  const registry = {
    get(): unknown {
      return jobView({ output: { total: 500, earliest: 0 } })
    },
    readAt(): unknown {
      return { chunks: [{ at: 0, text: 'é'.repeat(200), channel: 'stdout' }], next: 500, lossy: false }
    },
  }
  const access = new FakeAccess(scopeOf())
  access.use('jobs', registry)
  const read = await new NativeInspection({ access, maxOutputBytes: 21 }).jobOutput('bash-0000000000000001')
  assertAvailable(read as { available: boolean })
  const output = read as Extract<JobOutputRead, { available: true }>
  assert.equal(output.chunks.length, 1)
  assert.equal(output.chunks[0]!.at, 0)
  assert.ok(Buffer.byteLength(output.chunks[0]!.text, 'utf8') <= 21)
  assert.equal(output.chunks[0]!.text, 'é'.repeat(10))
  assert.equal(output.truncated, true)
  // A truncated single chunk cannot resume mid-chunk; keep the native offset.
  assert.equal(output.next, 500)
})

test('job output: ANSI/control sequences are stripped, malformed chunks drop with incomplete', async () => {
  const registry = {
    get(): unknown {
      return jobView()
    },
    readAt(): unknown {
      return {
        chunks: [
          { at: 0, text: '\u001b[31mred\u001b[0m\r\nline\u0007\u001b]0;title\u0007tail', channel: 'stdout' },
          { at: 99, text: 'out-of-order' },
          { at: 40, text: 12 },
          { at: 50 },
          { at: 60, text: 'ok' },
        ],
        next: 62,
        lossy: false,
      }
    },
  }
  const access = new FakeAccess(scopeOf())
  access.use('jobs', registry)
  const read = await new NativeInspection({ access }).jobOutput('bash-0000000000000001')
  assertAvailable(read as { available: boolean })
  const output = read as Extract<JobOutputRead, { available: true }>
  // A hostile/out-of-order sequence is dropped at the first regression, never
  // reordered: native chunks are ascending by contract.
  assert.deepEqual(output.chunks.map(chunk => chunk.text), ['red\nlinetail', 'out-of-order'])
  assert.equal(output.complete, false)
  assert.equal(output.truncated, false)
})

test('job output: invalid requests, foreign/unknown jobs and missing services stay unavailable', async () => {
  const access = new FakeAccess(scopeOf())
  access.use('jobs', {
    get(): unknown {
      throw new Error('job bash-1 belongs to another session')
    },
    readAt(): unknown {
      throw new Error('must not read a rejected job')
    },
  })
  const inspection = new NativeInspection({ access })
  assertUnavailable(await inspection.jobOutput(''), 'invalid-request')
  assertUnavailable(await inspection.jobOutput('bash-1', -1), 'invalid-request')
  assertUnavailable(await inspection.jobOutput('bash-1', 1.5), 'invalid-request')
  assertUnavailable(await inspection.jobOutput('bash-1'), 'native-failed')
  assert.match(access.warnings[0] ?? '', /belongs to another session/)

  const missing = new FakeAccess(scopeOf())
  assertUnavailable(await new NativeInspection({ access: missing }).jobOutput('bash-1'), 'missing-service')
})

// --------------------------------------------------------------- goal

test('goal: live Agent view includes activation and is read without creating anything', async () => {
  const agent = { id: ROOT, session: fakeSession() }
  const registry = {
    getCalls: [] as unknown[],
    get(received: unknown): unknown {
      this.getCalls.push(received)
      return goalView({ phase: 'blocked', activation: 'disarmed', blockedReason: { code: 'needs-human', message: 'approval pending' } })
    },
  }
  const access = new FakeAccess(scopeOf({ session: fakeSession(), agent }))
  access.use('goals', registry)
  access.use('agents', { get: () => { throw new Error('no Agent materialization') } })
  const read = await new NativeInspection({ access }).goal()
  assertAvailable(read as { available: boolean })
  const goal = read as Extract<GoalRead, { available: true }>
  assert.equal(goal.complete, true)
  assert.deepEqual(registry.getCalls, [agent])
  assert.deepEqual(goal.goal, {
    id: 'goal-1',
    revision: 3,
    objective: 'Ship the inspector',
    phase: 'blocked',
    maxGoalRounds: 10,
    roundsStarted: 2,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    activation: 'disarmed',
    blockedReason: { code: 'needs-human', message: 'approval pending' },
  })
})

test('goal: no current goal is authoritative; a stale live Agent falls back to the durable projection', async () => {
  const agent = { id: ROOT }
  const none = new FakeAccess(scopeOf({ session: fakeSession(), agent }))
  none.use('goals', { get: () => undefined })
  const empty = await new NativeInspection({ access: none }).goal()
  assertAvailable(empty as { available: boolean })
  assert.deepEqual(empty, { available: true, complete: true, sessionId: ROOT, goal: null })

  const stale = new FakeAccess(scopeOf({ session: fakeSession(), agent }))
  stale.use('goals', {
    get(): never {
      const error = new Error('agent is not live in this registry')
      Object.assign(error, { code: 'GOAL_AGENT_NOT_LIVE' })
      throw error
    },
  })
  stale.use('sessionProjections', {
    snapshot: () => projectionSnapshot({
      goal: {
        goal: { id: 'goal-2', revision: 1, objective: 'durable only', phase: 'active', maxGoalRounds: 4 },
        roundsStarted: 1,
        createdAt: 5,
        updatedAt: 6,
      },
    }),
  })
  const fallback = await new NativeInspection({ access: stale }).goal()
  assertAvailable(fallback as { available: boolean })
  const goal = fallback as Extract<GoalRead, { available: true }>
  assert.equal(goal.complete, false)
  assert.equal(goal.goal?.id, 'goal-2')
  assert.equal(goal.goal?.activation, undefined)
  assert.equal(stale.warnings.length, 0, 'GOAL_AGENT_NOT_LIVE is an expected attachment edge, not a warning')
})

test('goal: projection null, pending identity and missing/malformed services are distinguished', async () => {
  const projected = new FakeAccess(scopeOf({ session: fakeSession() }))
  projected.use('sessionProjections', { snapshot: () => projectionSnapshot({ goal: null }) })
  const cleared = await new NativeInspection({ access: projected }).goal()
  assertAvailable(cleared as { available: boolean })
  assert.deepEqual(cleared, { available: true, complete: false, sessionId: ROOT, goal: null })

  const pending = new FakeAccess({ sessionId: ROOT })
  pending.use('sessionProjections', { snapshot: () => projectionSnapshot({ goal: null }) })
  assertUnavailable(await new NativeInspection({ access: pending }).goal(), 'no-session')

  const missing = new FakeAccess(scopeOf({ session: fakeSession() }))
  assertUnavailable(await new NativeInspection({ access: missing }).goal(), 'missing-service')

  const unregistered = new FakeAccess(scopeOf({ session: fakeSession() }))
  unregistered.use('sessionProjections', { snapshot: () => projectionSnapshot({}) })
  assertUnavailable(await new NativeInspection({ access: unregistered }).goal(), 'missing-service')

  const malformed = new FakeAccess(scopeOf({ session: fakeSession(), agent: {} }))
  malformed.use('goals', { get: () => ({ id: 'goal-x', revision: 0 }) })
  malformed.use('sessionProjections', { snapshot: () => projectionSnapshot({ goal: { goal: {} } }) })
  assertUnavailable(await new NativeInspection({ access: malformed }).goal(), 'malformed')

  const failingProjection = new FakeAccess(scopeOf({ session: fakeSession() }))
  failingProjection.use('sessionProjections', {
    snapshot(): never {
      throw new Error('fold failure')
    },
  })
  assertUnavailable(await new NativeInspection({ access: failingProjection }).goal(), 'native-failed')
})

// ------------------------------------------------------ working directory

test('working directory: immutable workspace cwd vs native effective directory', async () => {
  const session = fakeSession('/work')
  const service = {
    getCalls: [] as unknown[],
    setCalls: [] as unknown[],
    ensureCalls: [] as unknown[],
    get(received: unknown): unknown {
      this.getCalls.push(received)
      return '/work/packages/app'
    },
  }
  const access = new FakeAccess(scopeOf({ session }))
  access.use('workingDirectory', {
    ...service,
    set(...args: unknown[]): never {
      service.setCalls.push(args)
      throw new Error('the inspector must never set the working directory')
    },
    ensure(...args: unknown[]): never {
      service.ensureCalls.push(args)
      throw new Error('the inspector must never ensure the working directory')
    },
  })
  access.use('sessionProjections', {
    snapshot: () => projectionSnapshot({ workingDirectory: '/work/packages/app' }),
  })
  const read = await new NativeInspection({ access }).workingDirectory()
  assertAvailable(read as { available: boolean })
  const directory = read as Extract<WorkingDirectoryRead, { available: true }>
  assert.deepEqual(directory, {
    available: true,
    complete: true,
    sessionId: ROOT,
    workspaceCwd: '/work',
    effectiveCwd: '/work/packages/app',
    recordedCwd: '/work/packages/app',
    redirected: true,
  })
  assert.deepEqual(service.setCalls, [])
  assert.deepEqual(service.ensureCalls, [])
})

test('working directory: partial native data never becomes a fabricated value', async () => {
  const throwing = new FakeAccess(scopeOf({ session: fakeSession('/work') }))
  throwing.use('workingDirectory', {
    get(): never {
      throw new Error('projection unavailable')
    },
  })
  throwing.use('sessionProjections', { snapshot: () => projectionSnapshot({ workingDirectory: '/work/sub' }) })
  const fallback = await new NativeInspection({ access: throwing }).workingDirectory()
  assertAvailable(fallback as { available: boolean })
  const directory = fallback as Extract<WorkingDirectoryRead, { available: true }>
  assert.equal(directory.complete, false)
  assert.equal(directory.effectiveCwd, '/work/sub')
  assert.equal(directory.redirected, true)

  const headerOnly = new FakeAccess(scopeOf({ session: fakeSession('/work') }))
  const partial = await new NativeInspection({ access: headerOnly }).workingDirectory()
  assertAvailable(partial as { available: boolean })
  assert.deepEqual(partial, {
    available: true,
    complete: false,
    sessionId: ROOT,
    workspaceCwd: '/work',
    redirected: false,
  })

  const recordedNull = new FakeAccess(scopeOf({ session: fakeSession('/work') }))
  recordedNull.use('workingDirectory', { get: () => '/work' })
  recordedNull.use('sessionProjections', { snapshot: () => projectionSnapshot({ workingDirectory: null }) })
  const unchanged = await new NativeInspection({ access: recordedNull }).workingDirectory()
  assertAvailable(unchanged as { available: boolean })
  assert.equal((unchanged as Extract<WorkingDirectoryRead, { available: true }>).recordedCwd, null)
  assert.equal((unchanged as Extract<WorkingDirectoryRead, { available: true }>).redirected, false)

  const pending = new FakeAccess({ sessionId: ROOT })
  assertUnavailable(await new NativeInspection({ access: pending }).workingDirectory(), 'no-session')

  const relative = new FakeAccess(scopeOf({ session: fakeSession('relative/dir') }))
  assertUnavailable(await new NativeInspection({ access: relative }).workingDirectory(), 'native-failed')
})

// ------------------------------------------------------- plugin inventory

function nativeInventory(): RawRow {
  return {
    managementAvailable: true,
    entries: [
      {
        entryId: 'include:0',
        moduleName: '@deepseek-ai/dsh-agent',
        enabled: true,
        fiberPhase: 'active',
        meta: { title: 'Agent', description: 'secret-ish metadata' },
      },
      {
        entryId: 'include:1',
        moduleName: './bad-plugin.ts',
        enabled: false,
        fiberPhase: 'failed',
        diagnostic: 'startup failed: Authorization: Bearer abc.def.ghi key=sk-live-123456',
      },
      { entryId: 'include:2', moduleName: './pending.ts', enabled: true, fiberPhase: 'pending' },
      { entryId: 'include:3', moduleName: './nofiber.ts', enabled: true, fiberPhase: null },
    ],
    agentPresets: [
      {
        id: 'default',
        name: 'Default',
        isDefault: true,
        rows: [
          { entryId: 'row-1', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: true, fiberPhase: 'active' },
          { entryId: null, moduleName: '@deepseek-ai/dsh-tool-fs', enabled: 'conditional', condition: 'os.platform()', fiberPhase: null },
        ],
      },
      { id: 'broken', broken: 'composition unreadable', rows: [] },
    ],
  }
}

test('plugin inventory: public helper result is whitelisted, counted and redacted', async () => {
  const access = new FakeAccess(scopeOf())
  const hosts: unknown[] = []
  const read = await new NativeInspection({
    access,
    readPluginInventory: async host => {
      hosts.push(host)
      return nativeInventory()
    },
  }).pluginInventory()
  assertAvailable(read as { available: boolean })
  const inventory = read as Extract<PluginInventoryRead, { available: true }>
  assert.deepEqual(hosts, [access.host])
  assert.equal(inventory.complete, true)
  assert.deepEqual(inventory.entries, [
    { entryId: 'include:0', moduleName: '@deepseek-ai/dsh-agent', enabled: true, fiberPhase: 'active' },
    { entryId: 'include:1', moduleName: './bad-plugin.ts', enabled: false, fiberPhase: 'failed' },
    { entryId: 'include:2', moduleName: './pending.ts', enabled: true, fiberPhase: 'pending' },
    { entryId: 'include:3', moduleName: './nofiber.ts', enabled: true, fiberPhase: null },
  ])
  for (const entry of inventory.entries) {
    assert.deepEqual(Object.keys(entry).sort(), ['enabled', 'entryId', 'fiberPhase', 'moduleName'])
  }
  assert.deepEqual(inventory.summary, {
    total: 4,
    enabled: 3,
    disabled: 1,
    active: 1,
    failed: 1,
    pending: 1,
    malformed: 0,
  })
  assert.equal(inventory.diagnostics.length, 1)
  assert.equal(inventory.diagnostics[0]!.entryId, 'include:1')
  assert.match(inventory.diagnostics[0]!.message, /startup failed/)
  assert.match(inventory.diagnostics[0]!.message, /Authorization: \[redacted\]/)
  assert.match(inventory.diagnostics[0]!.message, /\[redacted\]/)
  assert.doesNotMatch(inventory.diagnostics[0]!.message, /abc\.def\.ghi|sk-live/)
  assert.deepEqual(inventory.presets?.[0], {
    id: 'default',
    name: 'Default',
    isDefault: true,
    rows: [
      { entryId: 'row-1', moduleName: '@deepseek-ai/dsh-tool-bash', enabled: true, fiberPhase: 'active' },
      { entryId: null, moduleName: '@deepseek-ai/dsh-tool-fs', enabled: 'conditional', fiberPhase: null },
    ],
  })
  assert.deepEqual(inventory.presets?.[1], { id: 'broken', isDefault: false, broken: true, rows: [] })
  assert.equal('meta' in inventory.presets![0]!.rows[0]!, false)
  assert.equal('condition' in inventory.presets![0]!.rows[1]!, false)
})

test('plugin inventory: malformed rows, diagnostic caps, failing helper and async staleness', async () => {
  const access = new FakeAccess(scopeOf())
  const malformed = await new NativeInspection({
    access,
    maxDiagnostics: 1,
    readPluginInventory: async () => ({
      entries: [
        { entryId: 'ok', moduleName: 'ok.ts', enabled: true, fiberPhase: 'active' },
        { entryId: '', moduleName: 'bad.ts', enabled: true, fiberPhase: 'active' },
        { entryId: 'bad-phase', moduleName: 'bad2.ts', enabled: true, fiberPhase: 'exploded' },
        { entryId: 'diag-1', moduleName: 'd1.ts', enabled: true, fiberPhase: 'failed', diagnostic: 'one' },
        { entryId: 'diag-2', moduleName: 'd2.ts', enabled: true, fiberPhase: 'failed', diagnostic: 'two' },
      ],
    }),
  }).pluginInventory()
  assertAvailable(malformed as { available: boolean })
  const inventory = malformed as Extract<PluginInventoryRead, { available: true }>
  assert.equal(inventory.summary.malformed, 2)
  assert.equal(inventory.summary.total, 3)
  assert.equal(inventory.complete, false)
  assert.equal(inventory.diagnostics.length, 1)
  assert.equal(inventory.diagnosticsTruncated, true)
  assert.deepEqual(inventory.entries.map(entry => entry.entryId), ['ok', 'diag-1', 'diag-2'])

  const absent = new FakeAccess(scopeOf())
  assertUnavailable(await new NativeInspection({ access: absent }).pluginInventory(), 'missing-service')

  const failing = new FakeAccess(scopeOf())
  assertUnavailable(await new NativeInspection({
    access: failing,
    readPluginInventory: async () => {
      throw new Error('loader unavailable: token=super-secret')
    },
  }).pluginInventory(), 'native-failed')
  assert.match(failing.warnings[0] ?? '', /token=\[redacted\]/)
  assert.doesNotMatch(failing.warnings[0] ?? '', /super-secret/)

  const notAnObject = new FakeAccess(scopeOf())
  assertUnavailable(await new NativeInspection({
    access: notAnObject,
    readPluginInventory: async () => ({ entries: 'nope' }),
  }).pluginInventory(), 'malformed')

  const stale = new FakeAccess(scopeOf())
  let resolveRead: ((value: unknown) => void) | undefined
  const staleRead = new NativeInspection({
    access: stale,
    readPluginInventory: async () => await new Promise<unknown>(resolve => {
      resolveRead = resolve
    }),
  }).pluginInventory()
  stale.scope = scopeOf({ attachmentId: 'attachment-2' })
  resolveRead?.(nativeInventory())
  assertUnavailable(await staleRead, 'stale-attachment')
})

// ------------------------------------------------------------ tool catalog

test('tool catalog: only the exact active Agent scope, whitelisted metadata, native order', async () => {
  const agent = { id: ROOT }
  const tools = {
    definitionScopes: [] as unknown[],
    executableScopes: [] as unknown[],
    definitions(scope: unknown): unknown[] {
      this.definitionScopes.push(scope)
      return [
        {
          name: 'bash',
          description: 'Run a shell command\u001b[2J with \r\nnewlines',
          parameters: { type: 'object', properties: { command: { type: 'string', default: 'API_KEY=secret' } } },
          output: { schema: { type: 'object' }, render: () => [] },
          execute: async () => ({}),
          presentCall: () => undefined,
          presentResult: () => undefined,
          deferLoading: true,
        },
        { name: 'read_file', description: 'Read a file' },
        { name: '', description: 'broken' },
        { name: 'ask', description: 42 },
      ]
    },
    executable(name: string, scope: unknown): unknown {
      this.executableScopes.push(scope)
      return name === 'bash' ? { name } : undefined
    },
  }
  const access = new FakeAccess(scopeOf({ session: fakeSession(), agent }))
  access.use('tools', tools)
  const read = await new NativeInspection({ access }).toolCatalog()
  assertAvailable(read as { available: boolean })
  const catalog = read as Extract<ToolCatalogRead, { available: true }>
  assert.deepEqual(tools.definitionScopes, [agent])
  assert.deepEqual(tools.executableScopes, [agent, agent, agent])
  assert.equal(catalog.complete, false, 'two malformed definitions are reported')
  assert.deepEqual(catalog.tools[0], {
    name: 'bash',
    description: 'Run a shell command with \nnewlines',
    executable: true,
    deferredLoading: true,
    presenter: { call: true, result: true },
  })
  assert.deepEqual(Object.keys(catalog.tools[0]!).sort(), ['deferredLoading', 'description', 'executable', 'name', 'presenter'])
  assert.deepEqual(catalog.tools.map(entry => entry.name), ['bash', 'read_file', 'ask'])
  assert.equal(catalog.tools[2]?.description, '')
  assert.deepEqual(catalog.summary, { total: 3, executable: 1, deferred: 1 })
})

test('tool catalog: pending identity and failing registry stay unavailable', async () => {
  const pending = new FakeAccess({ sessionId: ROOT })
  pending.use('tools', {
    definitions: () => {
      throw new Error('must not read the global tool view for a pending attachment')
    },
  })
  assertUnavailable(await new NativeInspection({ access: pending }).toolCatalog(), 'no-agent')

  const missing = new FakeAccess(scopeOf({ session: fakeSession(), agent: {} }))
  assertUnavailable(await new NativeInspection({ access: missing }).toolCatalog(), 'missing-service')

  const failing = new FakeAccess(scopeOf({ session: fakeSession(), agent: {} }))
  failing.use('tools', {
    definitions(): never {
      throw new Error('registry exploded')
    },
  })
  assertUnavailable(await new NativeInspection({ access: failing }).toolCatalog(), 'native-failed')
  assert.match(failing.warnings[0] ?? '', /registry exploded/)
})

// ------------------------------------------------------- job subscriptions

test('jobs subscription: owner filter, mapped invalidations, attachment staleness and disposal', () => {
  const subscriptions: Array<{ filter: unknown; listener: (event: unknown) => void }> = []
  let disposed = 0
  const registry = {
    events: {
      subscribe(filter: unknown, listener: (event: unknown) => void): () => void {
        subscriptions.push({ filter, listener })
        return () => {
          disposed += 1
        }
      },
    },
  }
  const access = new FakeAccess(scopeOf())
  access.use('jobs', registry)
  const seen: unknown[] = []
  const unsubscribe = new NativeInspection({ access }).subscribeJobs(event => seen.push(event))
  assert.deepEqual(subscriptions[0]!.filter, { owner: ROOT })
  const listener = subscriptions[0]!.listener
  listener({ type: 'registered', job: { id: 'bash-1', owner: ROOT } })
  listener({ type: 'progress', job: { id: 'bash-1', owner: OTHER } })
  listener({ type: 'settled', job: { id: 'bash-1', owner: ROOT }, cause: 'producer', awaited: false })
  listener({ type: 'output', id: 'bash-2', owner: ROOT, total: 10 })
  listener({ type: 'output', id: 'bash-3', total: 10 })
  listener({ type: 'removed', job: { id: 'bash-4' } })
  listener({ type: 'unknown-event' })
  listener('garbage')
  assert.deepEqual(seen, [
    { kind: 'jobs', sessionId: ROOT, reason: 'registered', jobId: 'bash-1' },
    { kind: 'jobs', sessionId: ROOT, reason: 'settled', jobId: 'bash-1' },
    { kind: 'jobs', sessionId: ROOT, reason: 'output', jobId: 'bash-2' },
    { kind: 'jobs', sessionId: ROOT, reason: 'output', jobId: 'bash-3' },
    { kind: 'jobs', sessionId: ROOT, reason: 'removed', jobId: 'bash-4' },
  ])
  // A listener bug is contained and later events still flow.
  const throwing = new NativeInspection({ access })
  const throwingUnsubscribe = throwing.subscribeJobs(() => {
    throw new Error('ui bug')
  })
  assert.doesNotThrow(() => subscriptions[1]!.listener({ type: 'registered', job: { id: 'bash-5', owner: ROOT } }))
  throwingUnsubscribe()

  // Attachment switch silences the bind without touching native dispatch.
  access.scope = scopeOf({ attachmentId: 'attachment-2' })
  listener({ type: 'registered', job: { id: 'bash-6', owner: ROOT } })
  assert.equal(seen.length, 5)
  unsubscribe()
  assert.equal(disposed, 2)
})

test('jobs subscription: no attachment, missing service, hostile getter or non-disposer yield a no-op', () => {
  const noAttachment = new NativeInspection({ access: new FakeAccess(undefined) })
  assert.doesNotThrow(() => noAttachment.subscribeJobs(() => {})())

  const missing = new FakeAccess(scopeOf())
  assert.doesNotThrow(() => new NativeInspection({ access: missing }).subscribeJobs(() => {})())

  const hostile = new FakeAccess(scopeOf())
  hostile.use('jobs', {
    get events(): never {
      throw new Error('getter exploded')
    },
  })
  const warnings: string[] = []
  assert.doesNotThrow(() => new NativeInspection({ access: hostile, warn: message => warnings.push(message) }).subscribeJobs(() => {})())
  assert.deepEqual(warnings, [])

  const nonDisposer = new FakeAccess(scopeOf())
  nonDisposer.use('jobs', { events: { subscribe: () => 'not-a-function' } })
  assert.doesNotThrow(() => new NativeInspection({ access: nonDisposer }).subscribeJobs(() => {})())

  const throwingSubscribe = new FakeAccess(scopeOf())
  const failing: string[] = []
  throwingSubscribe.use('jobs', {
    events: {
      subscribe(): never {
        throw new Error('subscribe failed: api_key=abc123')
      },
    },
  })
  assert.doesNotThrow(() => new NativeInspection({ access: throwingSubscribe, warn: message => failing.push(message) }).subscribeJobs(() => {})())
  assert.equal(failing.length, 1)
  assert.match(failing[0]!, /api_key=\[redacted\]/)
  assert.doesNotMatch(failing[0]!, /abc123/)
})

// ------------------------------------------------------------- pure mappings

test('pure mappings: job event identity, goal change scope, projection domains', () => {
  assert.deepEqual(jobEventInvalidation({ type: 'registered', job: { id: 'bash-1', owner: ROOT } }, ROOT), {
    kind: 'jobs', sessionId: ROOT, reason: 'registered', jobId: 'bash-1',
  })
  assert.equal(jobEventInvalidation({ type: 'registered', job: { id: 'bash-1', owner: OTHER } }, ROOT), undefined)
  assert.equal(jobEventInvalidation({ type: 'registered', job: { id: '', owner: ROOT } }, ROOT), undefined)
  assert.equal(jobEventInvalidation({ type: 'settled' }, ROOT), undefined)
  assert.equal(jobEventInvalidation(undefined, ROOT), undefined)

  const agent = { id: ROOT, session: { id: ROOT } }
  const payload = {
    agent,
    change: { operation: 'resume', ref: { id: 'goal-1', revision: 4 }, goal: goalView({ revision: 4 }) },
  }
  assert.deepEqual(goalChangedInvalidation(payload, { sessionId: ROOT, agent }), {
    kind: 'goal', sessionId: ROOT, operation: 'resume', goalId: 'goal-1', revision: 4,
  })
  assert.deepEqual(goalChangedInvalidation({
    agent: { id: ROOT, session: { id: ROOT } },
    change: { operation: 'clear', ref: { id: 'goal-1', revision: 5 } },
  }, { sessionId: ROOT }), {
    kind: 'goal', sessionId: ROOT, operation: 'clear', goalId: 'goal-1', revision: 5,
  })
  assert.equal(goalChangedInvalidation(payload, { sessionId: ROOT, agent: { id: 'other' } }), undefined)
  assert.equal(goalChangedInvalidation(payload, { sessionId: OTHER }), undefined)
  assert.equal(goalChangedInvalidation(payload, undefined), undefined)
  assert.equal(goalChangedInvalidation({ agent: { session: { id: ROOT } }, change: { operation: 'explode' } }, { sessionId: ROOT }), undefined)

  assert.equal(projectionInvalidationDomain('goal'), 'goal')
  assert.equal(projectionInvalidationDomain('workingDirectory'), 'working-directory')
  assert.equal(projectionInvalidationDomain('todos'), undefined)
  assert.equal(projectionInvalidationDomain(42), undefined)
  assert.equal(toolsInvalidationDomain(), 'tools')
  assert.equal(inventoryInvalidationDomain(), 'inventory')
})