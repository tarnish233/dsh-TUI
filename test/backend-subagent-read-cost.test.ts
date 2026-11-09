/**
 * Offline contract tests for the subagent bridge's **read budget**.
 *
 * A display refresh must keep native `listDescendants` as the only structural
 * authority and must not spend more native reads than the facts it renders
 * require. These tests therefore count the exact public calls the adapter makes:
 *
 * - `ctx.subagents.listDescendants` / `listChildren` (native structure),
 * - `ctx.sessionQuery.observeSession` (leased cold/live observation),
 * - `ctx.sessionProjections.snapshot(session, keys)` (resident projection cut),
 * - `ctx.sessions.get` (resident identity).
 *
 * Every fact is a synthetic host: no profile, credential, real session log,
 * Agent creation/resume, model request, network call or terminal is touched.
 * The native listing double is the same shape the enumeration suite uses — the
 * adapter under test never walks catalogs itself.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshBackend, type DshContextBackend } from '../src/backend/context.ts'
import { SubagentBridge } from '../src/backend/subagents.ts'
import type { BackendEvent, SessionInfo, SubagentEntry, SubagentSnapshot } from '../src/backend/types.ts'
import {
  FakeAgentRegistry,
  FakeDshHost,
  FakeSessionWorld,
  FakeSubagentsService,
  fakeCatalogEvent,
  fakeNativeHelpers,
  type FakeSessionEvent,
} from '../src/backend/testing.ts'

const ROOT = 'root-session'
const ROOT_ROUTE = { provider: 'p1', model: 'm1' }
/** The projection keys one display row folds; a resident cut must ask only for these. */
const ROW_KEYS = ['subagent', 'subagentTiming', 'tokenUsage', 'modelSelection']

type ChildMode = 'one-shot' | 'continuable' | 'external' | 'unknown'
type RawRow = Record<string, unknown>

/** One observed public read: the exact call and its arguments. */
interface ReadLog {
  readonly listings: Array<{ rootSessionId: string; signal: AbortSignal | undefined }>
  readonly childListings: Array<{ parentSessionId: string; signal: AbortSignal | undefined }>
  readonly observes: Array<{ id: string; signal: AbortSignal | undefined; projectionMode: unknown }>
  /** Projection cuts requested from the resident registry, with their key selection. */
  readonly cuts: Array<{ id: string; keys: readonly string[] | undefined }>
  readonly sessionGets: string[]
  disposals: number
}

function emptyLog(): ReadLog {
  return { listings: [], childListings: [], observes: [], cuts: [], sessionGets: [], disposals: 0 }
}

function listingFailure(message: string, code: string): Error {
  const error = new Error(message)
  error.name = 'SubagentError'
  Object.assign(error, { code })
  return error
}

function modeOfRow(row: RawRow): ChildMode {
  const mode = row.mode
  return mode === 'one-shot' || mode === 'continuable' || mode === 'external' ? mode : 'unknown'
}

function catalogValue(children: Array<[string, ChildMode, string?]>): unknown[] {
  return children.map(([id, mode, label], index) => ({
    id,
    mode,
    ...(label === undefined ? {} : { label }),
    createdAt: 1000 + index,
  }))
}

/**
 * Host double for the public `ctx.subagents` discovery surface.
 *
 * Mirrors the documented native semantics only (pre-order, catalog order,
 * external leaves, per-branch diagnostics) and records each call so a test can
 * prove the adapter never adds a second structural walk.
 */
class CountingDirectory {
  readonly log: ReadLog
  fail: Error | undefined
  readonly branchFailures = new Map<string, Error>()
  /** Native-shaped listing hold: the adapter must discard the late result. */
  hold: (() => void) | undefined
  private readonly world: FakeSessionWorld

  constructor(world: FakeSessionWorld, log: ReadLog) {
    this.world = world
    this.log = log
  }

  async listChildren(parentSessionId: string, signal?: AbortSignal): Promise<unknown[]> {
    this.log.childListings.push({ parentSessionId, signal })
    return this.catalog(parentSessionId, signal)
  }

  async listDescendants(rootSessionId: string, signal?: AbortSignal): Promise<unknown[]> {
    this.log.listings.push({ rootSessionId, signal })
    if (this.hold !== undefined) await new Promise<void>(resolve => setTimeout(resolve, 0))
    if (this.fail !== undefined) throw this.fail
    const root = this.catalog(rootSessionId, signal)
    const stack = root.map(entry => ({ entry, parentId: rootSessionId, depth: 1 })).reverse()
    const visited = new Set<string>([rootSessionId])
    const rows: RawRow[] = []
    for (let position = stack.pop(); position !== undefined; position = stack.pop()) {
      const { entry, parentId, depth } = position
      const id = typeof entry.id === 'string' ? entry.id : ''
      if (id === '' || visited.has(id)) continue
      visited.add(id)
      if (signal?.aborted === true) throw listingFailure('subagent listing was cancelled', 'CANCELLED')
      if (modeOfRow(entry) === 'external') {
        rows.push({
          kind: 'child',
          id,
          parentId,
          depth,
          mode: 'external',
          ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
        })
        continue
      }
      let children: unknown[]
      try {
        children = this.catalog(id, signal)
      } catch (error) {
        const code = (error as { code?: unknown }).code
        rows.push({
          kind: 'diagnostic',
          id,
          parentId,
          depth,
          reason: code === 'SESSION_QUERY_CORRUPT_SESSION' ? 'corrupt' : 'unavailable',
        })
        continue
      }
      if (modeOfRow(entry) === 'unknown') {
        rows.push({ kind: 'diagnostic', id, parentId, depth, reason: 'unsupported' })
      } else {
        rows.push({
          kind: 'child',
          id,
          parentId,
          depth,
          mode: modeOfRow(entry),
          ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
        })
      }
      for (const child of [...children].reverse()) {
        stack.push({ entry: child as RawRow, parentId: id, depth: depth + 1 })
      }
    }
    return rows
  }

  private catalog(parentSessionId: string, signal: AbortSignal | undefined): RawRow[] {
    if (signal?.aborted === true) throw listingFailure('subagent listing was cancelled', 'CANCELLED')
    const branchFailure = this.branchFailures.get(parentSessionId)
    if (branchFailure !== undefined) throw branchFailure
    if (!this.world.has(parentSessionId)) {
      throw listingFailure(`session "${parentSessionId}" not found`, 'SESSION_QUERY_SESSION_NOT_FOUND')
    }
    const rows = this.world.valuesOf(parentSessionId).subagentCatalog
    if (!Array.isArray(rows)) {
      throw listingFailure('listing subagents requires the registered subagentCatalog projection', 'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE')
    }
    return rows as RawRow[]
  }
}

/** Native-shaped test double: discovery plus the recorded mutation surface. */
class FakeNativeSubagents extends FakeSubagentsService {
  readonly directory: CountingDirectory

  constructor(world: FakeSessionWorld, log: ReadLog) {
    super()
    this.directory = new CountingDirectory(world, log)
  }

  listChildren(parentSessionId: string, signal?: AbortSignal): Promise<unknown[]> {
    return this.directory.listChildren(parentSessionId, signal)
  }

  listDescendants(rootSessionId: string, signal?: AbortSignal): Promise<unknown[]> {
    return this.directory.listDescendants(rootSessionId, signal)
  }
}

/** The public observation options the bridge may forward. */
interface ObserveOptions {
  readonly signal?: AbortSignal
  readonly projectionMode?: 'all' | 'none'
}

/** Replacements a test installs to model a hostile or degraded public surface. */
interface Spies {
  /** Resident identity override: returning `{value}` replaces `ctx.sessions.get`. */
  get?: (id: string) => { value: unknown } | undefined
  /** Resident projection cut override; `{value}` replaces the returned cut. */
  cut?: (session: unknown, keys: readonly string[] | undefined) => { value: unknown }
  /** Observation override; returning a promise replaces the native observation. */
  observe?: (id: string) => Promise<Record<string, unknown>> | undefined
  /** Remove the whole `sessionProjections` service. */
  dropProjections?: boolean
}

interface Harness {
  readonly host: FakeDshHost
  readonly world: FakeSessionWorld
  readonly agents: FakeAgentRegistry
  readonly subagents: FakeNativeSubagents
  readonly backend: DshContextBackend
  readonly info: SessionInfo
  readonly events: BackendEvent[]
  readonly warnings: string[]
  readonly log: ReadLog
}

interface ChildSpec {
  id: string
  parent?: string
  mode?: 'one-shot' | 'continuable'
  label?: string
  createdAt?: number
  /** Whether `ctx.sessions.get` resolves this session (a resident child). */
  live?: boolean
  /** Override the durable header fields after creation (stale/foreign facts). */
  header?: Record<string, unknown>
  projections?: Record<string, unknown>
  catalog?: Array<[string, ChildMode, string?]>
}

function childSession(world: FakeSessionWorld, spec: ChildSpec): void {
  const entry = world.add({
    id: spec.id,
    createdAt: spec.createdAt ?? 2,
    parentSession: spec.parent ?? ROOT,
    origin: 'subagent',
    delegationDepth: 1,
    live: spec.live ?? false,
    events: (spec.catalog ?? []).map(([id, mode, label]) => fakeCatalogEvent(id, mode, label) as FakeSessionEvent),
    projections: spec.projections ?? {
      ...(spec.mode === undefined ? {} : { subagent: { mode: spec.mode, ...(spec.label === undefined ? {} : { label: spec.label }), seq: 0 } }),
      subagentTiming: { settledMs: 0 },
      subagentCatalog: catalogValue(spec.catalog ?? []),
    },
  })
  if (spec.header !== undefined) Object.assign(entry.header, spec.header)
}

/**
 * Build one synthetic composition and count every public read the bridge makes.
 *
 * The counters wrap the *same* fake services the bridge already uses, so a
 * counted call is the real native-shaped call — not a parallel bookkeeping path.
 */
async function harness(options: {
  children?: Array<[string, ChildMode, string?]>
  childrenSpecs?: ChildSpec[]
  setup?: (ctx: { world: FakeSessionWorld; host: FakeDshHost; subagents: FakeNativeSubagents; log: ReadLog }) => void
  spies?: Spies
} = {}): Promise<Harness> {
  const log = emptyLog()
  const host = new FakeDshHost()
  const agents = new FakeAgentRegistry()
  const world = new FakeSessionWorld().attach(host)
  const subagents = new FakeNativeSubagents(world, log)
  host.use('agents', agents)
  host.use('agentDefaultModel', {
    currentSelection: () => ({ ...ROOT_ROUTE }),
    saveSelection: async () => {},
  })
  host.use('llm', {
    listProviders: () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }],
    resolveModelInfo: async () => ({}),
  })
  const children = options.children ?? []
  world.add({
    id: ROOT,
    live: true,
    createdAt: 1,
    events: children.map(([id, mode, label]) => fakeCatalogEvent(id, mode, label) as FakeSessionEvent),
    projections: { subagentCatalog: catalogValue(children) },
  })
  for (const spec of options.childrenSpecs ?? []) childSession(world, spec)
  options.setup?.({ world, host, subagents, log })

  // Counted public reads. Each wrapper forwards to the same fake service.
  const query = world.sessionQuery
  host.use('sessionQuery', {
    ...query,
    observeSession: async (id: string, observeOptions?: ObserveOptions) => {
      log.observes.push({
        id,
        signal: observeOptions?.signal,
        projectionMode: observeOptions?.projectionMode,
      })
      const injected = options.spies?.observe?.(id)
      const observation = await (injected ?? query.observeSession(id, observeOptions))
      let disposed = false
      const wrapped = Object.create(observation) as Record<string, unknown>
      Object.defineProperty(wrapped, Symbol.dispose, {
        value: () => {
          if (disposed) return
          disposed = true
          log.disposals += 1
        },
        enumerable: false,
      })
      return wrapped
    },
  })
  if (options.spies?.dropProjections !== true) {
    const projections = world.sessionProjections
    host.use('sessionProjections', {
      ...projections,
      snapshot: (session: unknown, keys?: readonly string[]) => {
        const id = String((session as { id?: unknown } | null)?.id)
        log.cuts.push({ id, keys })
        const injected = options.spies?.cut?.(session, keys)
        return injected === undefined ? projections.snapshot(session, keys) : injected.value
      },
    })
  }
  const store = world.store
  host.use('sessions', {
    ...store,
    get: (id: string) => {
      log.sessionGets.push(id)
      const injected = options.spies?.get?.(id)
      return injected === undefined ? store.get(id) : injected.value
    },
  })
  if (host.get('subagents') === undefined) subagents.attach(host)

  const events: BackendEvent[] = []
  const warnings: string[] = []
  const backend = createDshBackend(host, {
    cwd: '/workspace',
    resume: ROOT,
    native: fakeNativeHelpers(),
    warn: message => warnings.push(message),
  })
  backend.onEvent(event => events.push(event))
  const info = await backend.connect()
  return { host, world, agents, subagents, backend, info, events, warnings, log }
}

function entryOf(entries: readonly SubagentEntry[] | undefined, id: string): SubagentEntry | undefined {
  return entries?.find(entry => entry.id === id)
}

function lastSnapshot(events: readonly BackendEvent[]): SubagentSnapshot | undefined {
  let snapshot: SubagentSnapshot | undefined
  for (const event of events) if (event.type === 'subagents') snapshot = event.value
  return snapshot
}

/**
 * Projection cuts taken for child rows.
 *
 * The harness counts every `sessionProjections.snapshot` call on the host; the
 * root's own title/plan cuts belong to the parent-owned context adapter, so a
 * row-read assertion excludes the attachment root.
 */
function rowCuts(log: ReadLog): Array<{ id: string; keys: readonly string[] | undefined }> {
  return log.cuts.filter(cut => cut.id !== ROOT)
}

/** The identity-free content facts a row read must produce for a same-shaped row. */
function rowShape(entry: SubagentEntry | undefined): unknown {
  if (entry === undefined) return undefined
  return {
    mode: entry.mode,
    local: entry.local,
    parentSessionId: entry.parentSessionId,
    createdAt: entry.createdAt,
    timing: entry.timing,
    totalTokens: entry.totalTokens,
    provider: entry.provider,
    model: entry.model,
    reasoningEffort: entry.reasoningEffort,
    // `status` is excluded: a resident Session is genuinely live, so
    // `statusOf` reports `initializing` where a cold row honestly reports
    // `unknown`. That is a real fact difference, not a read-path difference.
  }
}

/** Content facts a row read must produce, independent of execution liveness. */
function contentOf(entries: readonly SubagentEntry[] | undefined): unknown[] {
  return (entries ?? []).map(({ status: _status, ...rest }) => rest)
}

async function until(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}

// --------------------------------------------------------------------- tests

test('a resident tree spends one key-scoped projection cut per row and no observation lease', async () => {
  const h = await harness({
    children: [
      ['child-a', 'continuable', 'task'],
      ['child-b', 'one-shot', 'once'],
    ],
    childrenSpecs: [
      {
        id: 'child-a',
        mode: 'continuable',
        label: 'task',
        live: true,
        createdAt: 4242,
        projections: {
          subagent: { mode: 'continuable', label: 'task', seq: 0 },
          subagentTiming: { settledMs: 7, lastTurnCompleted: true },
          tokenUsage: { uncachedInputTokens: 5, outputTokens: 7 },
          modelSelection: { lastUsed: { provider: 'p2', model: 'm2', reasoningEffort: 'low' }, next: null },
          // An unrelated wire unit must never be folded for a row read.
          title: { text: 'ignored' },
          subagentCatalog: catalogValue([]),
        },
      },
      { id: 'child-b', mode: 'one-shot', label: 'once', live: true, createdAt: 4243 },
    ],
  })

  const entries = h.info.subagents?.entries ?? []
  assert.deepEqual(entries.map(entry => entry.id), ['child-a', 'child-b'], 'native pre-order is unchanged')

  assert.equal(h.subagents.directory.log.listings.length, 1, 'one native listing owns structure')
  assert.deepEqual(h.subagents.directory.log.childListings, [], 'the display refresh never re-walks with listChildren')
  assert.deepEqual(
    h.log.observes.map(call => call.id),
    [],
    'no resident child needs an observation lease',
  )
  assert.equal(h.log.disposals, 0, 'no lease exists, so none has to be released')

  // Exactly one cut per readable local row, each asking only for the row keys.
  assert.deepEqual(rowCuts(h.log).map(cut => cut.id), ['child-a', 'child-b'], 'one cut per resident row')
  for (const cut of rowCuts(h.log)) {
    assert.deepEqual(cut.keys, ROW_KEYS, 'the cut asks only for the keys a row folds')
  }
  assert.deepEqual(
    [...new Set(h.log.sessionGets)].sort(),
    ['child-a', 'child-b'],
    'resident identity came from ctx.sessions.get',
  )

  // Same content facts a live observation lease would have produced.
  const a = entryOf(entries, 'child-a')!
  assert.equal(a.mode, 'continuable')
  assert.equal(a.label, 'task')
  assert.equal(a.local, true)
  assert.equal(a.parentSessionId, ROOT)
  assert.equal(a.createdAt, 4242, 'the resident durable header is the createdAt source')
  assert.equal(a.totalTokens, 12, 'the tokenUsage wire view is folded')
  assert.deepEqual(a.timing, { settledMs: 7, lastTurnCompleted: true })
  assert.equal(a.provider, 'p2')
  assert.equal(a.model, 'm2')
  assert.equal(a.reasoningEffort, 'low')
  assert.equal(h.info.subagents?.truncated, undefined, 'a complete resident tree is not truncated')
  assert.deepEqual(h.warnings, [], 'the resident path needs no fallback diagnostic')
})

test('cold children keep one released native observation each', async () => {
  const h = await harness({
    children: [
      ['child-cold', 'continuable', 'cold'],
      ['child-warm', 'continuable', 'warm'],
    ],
    childrenSpecs: [
      { id: 'child-cold', mode: 'continuable', label: 'cold', live: false },
      { id: 'child-warm', mode: 'continuable', label: 'warm', live: true },
    ],
  })

  assert.deepEqual(h.log.observes.map(call => call.id), ['child-cold'], 'only the non-resident child takes a lease')
  assert.equal(h.log.disposals, 1, 'every observation lease is released')
  assert.ok(h.log.observes[0].signal instanceof AbortSignal, 'the epoch/deadline signal is forwarded')
  assert.equal(h.log.observes[0].signal?.aborted, false)
  assert.equal(h.log.observes[0].projectionMode, undefined, 'the row read keeps the native default projection mode')
  assert.deepEqual(rowCuts(h.log).map(cut => cut.id), ['child-warm'], 'the resident child still reads its own cut')

  // Both rows carry the same content facts despite different read paths.
  assert.equal(entryOf(h.info.subagents?.entries, 'child-cold')?.mode, 'continuable')
  assert.equal(entryOf(h.info.subagents?.entries, 'child-cold')?.label, 'cold')
  assert.equal(entryOf(h.info.subagents?.entries, 'child-warm')?.label, 'warm')
  assert.deepEqual(
    rowShape(entryOf(h.info.subagents?.entries, 'child-cold')),
    rowShape(entryOf(h.info.subagents?.entries, 'child-warm')),
    'the cold and resident read paths agree on the content facts of a same-shaped row',
  )

  // A fully cold tree spends one lease per row and no resident cut at all.
  const allCold = await harness({
    children: [
      ['child-c1', 'continuable', 'c1'],
      ['child-c2', 'continuable', 'c2'],
    ],
    childrenSpecs: [
      { id: 'child-c1', mode: 'continuable', label: 'c1', live: false },
      { id: 'child-c2', mode: 'continuable', label: 'c2', live: false },
    ],
  })
  assert.deepEqual(allCold.log.observes.map(call => call.id), ['child-c1', 'child-c2'], 'one lease per cold row')
  assert.equal(allCold.log.disposals, 2, 'every cold lease is released')
  assert.deepEqual(rowCuts(allCold.log), [], 'a cold row takes no resident cut')
  assert.equal(allCold.subagents.directory.log.listings.length, 1, 'still exactly one native listing')
})

test('a resident row reports exactly the facts the native lease baseline reports', async () => {
  const specs: ChildSpec[] = [
    {
      id: 'child-a',
      mode: 'continuable',
      label: 'task',
      live: true,
      createdAt: 4242,
      projections: {
        subagent: { mode: 'continuable', label: 'task', seq: 0 },
        subagentTiming: { settledMs: 7, lastCommitMs: 3 },
        tokenUsage: { uncachedInputTokens: 5, outputTokens: 7, cacheReadTokens: 11, cacheWriteTokens: 13 },
        modelSelection: { next: { provider: 'p2', model: 'm2' } },
        subagentCatalog: catalogValue([]),
      },
    },
    { id: 'child-b', mode: 'one-shot', label: 'once', live: true, createdAt: 4243 },
  ]
  const resident = await harness({ children: [['child-a', 'continuable', 'task'], ['child-b', 'one-shot', 'once']], childrenSpecs: specs })
  assert.deepEqual(resident.log.observes, [], 'the resident run used no lease')

  // Same composition, but `ctx.sessions.get` returns a foreign resident object
  // whose id is not the requested child. The bridge must not borrow its facts:
  // it falls back to the native lease, which is the baseline read path.
  const stale = await harness({
    children: [['child-a', 'continuable', 'task'], ['child-b', 'one-shot', 'once']],
    childrenSpecs: specs,
    spies: {
      get: id => ({ value: { id: `${id}-stale`, header: { id: `${id}-stale`, createdAt: 1, origin: 'subagent', parentSession: 'someone-else' } } }),
    },
  })
  assert.deepEqual(stale.log.observes.map(call => call.id), ['child-a', 'child-b'], 'both rows fell back to the native lease')

  assert.deepEqual(
    resident.info.subagents?.entries,
    stale.info.subagents?.entries,
    'the resident read and the native lease read produce identical entries',
  )
  assert.deepEqual(rowCuts(resident.log).map(cut => cut.keys), [ROW_KEYS, ROW_KEYS])
  assert.equal(rowCuts(resident.log).length, 2, 'two resident cuts…')
  assert.equal(rowCuts(stale.log).length, 0, '…instead of two full-registry observation folds')
})

test('a malformed, absent or failing resident cut falls back to the native lease', async () => {
  const base: ChildSpec = {
    id: 'child-a',
    mode: 'continuable',
    label: 'task',
    live: true,
    projections: {
      subagent: { mode: 'continuable', label: 'task', seq: 0 },
      tokenUsage: { uncachedInputTokens: 4 },
      subagentCatalog: catalogValue([]),
    },
  }

  for (const [label, cut] of [
    ['throwing', () => { throw new Error('registry exploded') }],
    ['undefined', () => ({ value: undefined })],
    ['non-object', () => ({ value: 42 })],
  ] as const) {
    const h = await harness({
      children: [['child-a', 'continuable', 'task']],
      childrenSpecs: [{ ...base }],
      spies: { cut },
    })
    assert.deepEqual(h.log.observes.map(call => call.id), ['child-a'], `${label} cut falls back to the lease`)
    assert.equal(h.log.disposals, 1, `${label} cut still releases its fallback lease`)
    const entry = entryOf(h.info.subagents?.entries, 'child-a')
    assert.ok(entry, `${label} cut still produces the row`)
    assert.equal(entry.mode, 'continuable', `${label} cut keeps the native identity view through the fallback`)
    assert.equal(entry.label, 'task')
    assert.equal(entry.totalTokens, 4, `${label} cut does not lose the projection facts`)
    assert.equal(h.info.subagents?.truncated, undefined, `${label} cut is not reported as a truncated tree`)
  }

  // An empty (but valid) cut is a real answer: no values, no fallback.
  const empty = await harness({
    children: [['child-a', 'continuable', 'task']],
    childrenSpecs: [{ ...base }],
    spies: { cut: () => ({ value: { asOfSeq: 0, values: {} } }) },
  })
  assert.deepEqual(empty.log.observes, [], 'an empty resident cut is not a failure')
  const emptyEntry = entryOf(empty.info.subagents?.entries, 'child-a')
  assert.equal(emptyEntry?.mode, 'continuable', 'the catalog mode remains the row mode')
  assert.equal(emptyEntry?.label, 'task', 'the catalog label remains the row label')
  assert.equal(emptyEntry?.totalTokens, undefined, 'no value is invented from the empty cut')

  // A composition without the registry service behaves like a live observation
  // without projections: header facts only, still no lease.
  const noRegistry = await harness({
    children: [['child-a', 'continuable', 'task']],
    childrenSpecs: [{ ...base }],
    spies: { dropProjections: true },
  })
  assert.deepEqual(noRegistry.log.observes, [], 'no registry means no projection to fold')
  assert.equal(entryOf(noRegistry.info.subagents?.entries, 'child-a')?.mode, 'continuable')
  assert.equal(entryOf(noRegistry.info.subagents?.entries, 'child-a')?.createdAt, 2, 'the header still came from the resident Session')
})

test('a stale resident header never rewrites native lineage facts', async () => {
  // 1. The resident header names a different durable parent than the catalog.
  const parentMismatch = await harness({
    children: [['child-a', 'continuable', 'task']],
    childrenSpecs: [{ id: 'child-a', mode: 'continuable', label: 'task', live: true, header: { parentSession: 'other-root' } }],
  })
  assert.equal(
    entryOf(parentMismatch.info.subagents?.entries, 'child-a'),
    undefined,
    'a catalog row contradicted by its durable header is omitted',
  )
  assert.equal(parentMismatch.info.subagents?.truncated, true, 'the inconsistent row marks the tree incomplete')
  assert.ok(
    parentMismatch.warnings.some(message => message.includes('durable parent')),
    'the contradiction is reported once as a diagnostic',
  )

  // 2. The resident header is not a subagent origin.
  const originMismatch = await harness({
    children: [['child-a', 'continuable', 'task']],
    childrenSpecs: [{ id: 'child-a', mode: 'continuable', label: 'task', live: true, header: { origin: 'resume' } }],
  })
  assert.equal(
    entryOf(originMismatch.info.subagents?.entries, 'child-a'),
    undefined,
    'a non-subagent origin is omitted exactly like the lease path',
  )
  assert.equal(originMismatch.info.subagents?.truncated, true)

  // 3. A resident object whose header id is not the requested child is not used.
  const headerMismatch = await harness({
    children: [['child-a', 'continuable', 'task']],
    childrenSpecs: [{ id: 'child-a', mode: 'continuable', label: 'task', live: true, createdAt: 99 }],
    spies: {
      get: id => ({ value: { id, header: { id: 'someone-else', createdAt: 1, origin: 'subagent', parentSession: ROOT } } }),
    },
  })
  assert.deepEqual(headerMismatch.log.observes.map(call => call.id), ['child-a'], 'the mismatched resident header is rejected')
  assert.equal(entryOf(headerMismatch.info.subagents?.entries, 'child-a')?.createdAt, 99, 'the true durable header wins')
})

test('diagnostics, external leaves and unknown-versus-empty are unchanged by the resident path', async () => {
  const h = await harness({
    children: [
      ['child-live', 'continuable', 'live'],
      ['child-ext', 'external', 'remote'],
      ['child-gone', 'continuable', 'gone'],
    ],
    childrenSpecs: [{ id: 'child-live', mode: 'continuable', label: 'live', live: true }],
    setup: ({ world: _world, subagents }) => {
      subagents.directory.branchFailures.set('child-gone', listingFailure('conflicting sources', 'SESSION_QUERY_CORRUPT_SESSION'))
    },
  })

  const entries = h.info.subagents?.entries ?? []
  assert.deepEqual(entries.map(entry => entry.id), ['child-live', 'child-ext', 'child-gone'], 'native order and diagnostics are preserved')
  assert.deepEqual(h.info.subagents?.diagnostics, [
    { id: 'child-gone', parentSessionId: ROOT, depth: 1, reason: 'corrupt' },
  ], 'branch diagnostics stay validated metadata')
  assert.equal(h.info.subagents?.truncated, true, 'an unreadable branch marks the tree incomplete')
  assert.equal(entryOf(entries, 'child-gone')?.local, undefined, 'a diagnostic claims neither local nor external')
  assert.equal(entryOf(entries, 'child-ext')?.local, false, 'an external leaf is a nonlocal row')
  assert.equal(entryOf(entries, 'child-ext')?.status, 'external')

  // The external leaf and the unreadable branch never trigger a row read.
  assert.deepEqual(h.log.observes, [], 'no lease for an external leaf or a diagnostic branch')
  assert.deepEqual(rowCuts(h.log).map(cut => cut.id), ['child-live'], 'only the readable local row takes a cut')
  assert.equal(h.log.sessionGets.includes('child-ext'), false, 'an external leaf is never resolved as a local Session')

  // A genuinely empty native directory stays an authoritative empty tree.
  const empty = await harness({ children: [] })
  assert.deepEqual(empty.info.subagents, { entries: [] }, 'a readable empty directory is complete')
  assert.deepEqual(rowCuts(empty.log), [], 'no row exists, so no projection is folded')

  // A failed listing is still unavailable, never an empty tree.
  const failed = await harness({
    children: [['child-a', 'continuable', 'task']],
    childrenSpecs: [{ id: 'child-a', mode: 'continuable', label: 'task', live: true }],
    setup: ({ subagents }) => {
      subagents.directory.fail = listingFailure('session "root-session" not found', 'SESSION_QUERY_SESSION_NOT_FOUND')
    },
  })
  assert.equal(failed.info.subagents, undefined, 'an unreadable root is unavailable, never empty')
  assert.deepEqual(rowCuts(failed.log), [], 'an unavailable listing reads no row')
  assert.deepEqual(lastSnapshot(failed.events), undefined, 'no empty snapshot is published')
})

test('root reattachment aborts the epoch and discards a late resident listing', async () => {
  const log = emptyLog()
  const host = new FakeDshHost()
  const world = new FakeSessionWorld().attach(host)
  const subagents = new FakeNativeSubagents(world, log)
  subagents.attach(host)
  world.add({
    id: ROOT,
    live: true,
    events: [fakeCatalogEvent('child-a', 'continuable', 'task') as FakeSessionEvent],
    projections: { subagentCatalog: catalogValue([['child-a', 'continuable', 'task']]) },
  })
  childSession(world, { id: 'child-a', mode: 'continuable', label: 'task', live: true })
  world.add({
    id: 'root-two',
    live: true,
    events: [fakeCatalogEvent('child-two', 'continuable', 'two') as FakeSessionEvent],
    projections: { subagentCatalog: catalogValue([['child-two', 'continuable', 'two']]) },
  })
  childSession(world, { id: 'child-two', parent: 'root-two', mode: 'continuable', label: 'two', live: true })

  const published: SubagentSnapshot[] = []
  const bridge = new SubagentBridge({ host, emit: event => { if (event.type === 'subagents') published.push(event.value) }, warn: () => {} })
  bridge.setRoot(ROOT)
  bridge.announce(ROOT, undefined)

  // Hold the first native listing, then reattach the bridge to another root.
  let release: (() => void) | undefined
  let heldSignal: AbortSignal | undefined
  const originalListDescendants = subagents.directory.listDescendants.bind(subagents.directory)
  subagents.directory.listDescendants = async (rootSessionId: string, signal?: AbortSignal) => {
    // Only the first listing is held; the new epoch must read normally.
    subagents.directory.listDescendants = originalListDescendants
    heldSignal = signal
    await new Promise<void>(resolve => { release = resolve })
    return await originalListDescendants(rootSessionId, signal)
  }
  const pending = bridge.snapshotForRoot(ROOT)
  await until(() => release !== undefined, 'the held listing')
  assert.ok(heldSignal instanceof AbortSignal)
  assert.equal(heldSignal.aborted, false, 'the root epoch signal is live')

  bridge.setRoot('root-two')
  assert.equal(heldSignal.aborted, true, 'reattaching the root aborts the previous epoch')

  // A late listing result for the old root must never publish or leak rows.
  release?.()
  assert.equal(await pending, undefined, 'the late read is discarded')
  assert.deepEqual(published, [], 'a discarded read publishes nothing')

  const fresh = await bridge.snapshotForRoot('root-two')
  assert.deepEqual(fresh?.entries.map(entry => entry.id), ['child-two'], 'the new epoch reads its own tree')
  assert.equal(bridge.rootSessionId, 'root-two')
  bridge.close()
})

test('a discarded late row read leaves no lease, no stale row and no invented facts', async () => {
  const log = emptyLog()
  const host = new FakeDshHost()
  const world = new FakeSessionWorld().attach(host)
  const subagents = new FakeNativeSubagents(world, log)
  subagents.attach(host)
  world.add({
    id: ROOT,
    live: true,
    events: [fakeCatalogEvent('child-cold', 'continuable', 'cold') as FakeSessionEvent],
    projections: { subagentCatalog: catalogValue([['child-cold', 'continuable', 'cold']]) },
  })
  childSession(world, { id: 'child-cold', mode: 'continuable', label: 'cold', live: false })

  // Model a native observation that only settles after the epoch was aborted.
  const realQuery = world.sessionQuery
  const observed: string[] = []
  let release: (() => void) | undefined
  let hold = true
  let disposals = 0
  host.use('sessionQuery', {
    ...realQuery,
    observeSession: async (id: string, observeOptions?: { projectionMode?: 'all' | 'none' }) => {
      observed.push(id)
      const observation = await realQuery.observeSession(id, observeOptions) as Record<string, unknown>
      const lease = (): Record<string, unknown> => {
        let disposed = false
        const wrapped = Object.create(observation) as Record<string, unknown>
        Object.defineProperty(wrapped, Symbol.dispose, {
          value: () => {
            if (disposed) return
            disposed = true
            disposals += 1
          },
          enumerable: false,
        })
        return wrapped
      }
      if (!hold) return lease()
      hold = false
      return await new Promise<unknown>(resolve => { release = () => resolve(lease()) })
    },
  })

  const published: BackendEvent[] = []
  const bridge = new SubagentBridge({ host, emit: event => published.push(event), warn: () => {} })
  bridge.setRoot(ROOT)
  bridge.announce(ROOT, undefined)
  const pending = bridge.snapshotForRoot(ROOT)
  await until(() => release !== undefined, 'the held observation lease')
  assert.deepEqual(observed, ['child-cold'], 'the cold child took exactly one lease')

  // Teardown happens while the row lease is still open.
  bridge.close()
  release?.()
  assert.equal(await pending, undefined, 'a read interrupted by teardown produces no snapshot')
  await new Promise<void>(resolve => setTimeout(resolve, 20))
  assert.equal(disposals, 1, 'the late observation lease was released exactly once')
  assert.deepEqual(published, [], 'the late result published no row and no snapshot')
  assert.equal(bridge.rootSessionId, undefined, 'teardown detached the root')
})

test('membership and lineage keep native scopes and forward the epoch signal', async () => {
  const h = await harness({
    children: [['child-a', 'continuable', 'task']],
    childrenSpecs: [
      { id: 'child-a', mode: 'continuable', label: 'task', live: true },
      { id: 'child-a-child', parent: 'child-a', mode: 'continuable', label: 'nested', live: true },
      { id: 'other-root-child', parent: 'other-root', mode: 'continuable', label: 'elsewhere', live: true },
    ],
    setup: ({ world }) => {
      world.add({
        id: 'other-root',
        createdAt: 3,
        events: [],
        projections: { subagentCatalog: catalogValue([['other-root-child', 'continuable', 'elsewhere']]) },
      })
    },
  })
  h.log.childListings.length = 0
  h.log.observes.length = 0

  // A display row is already the first membership proof: no catalog read, no lease.
  assert.ok(await h.backend.command('subagent-prompt', { sessionId: 'child-a', text: 'again' }))
  assert.deepEqual(h.log.childListings, [], 'a verified display row needs no extra catalog read')
  assert.deepEqual(h.log.observes, [], 'a resident display row needs no observation lease')

  // A resident child that is cataloged but NOT in the display cache yet: the
  // durable header resolves natively (no lease) and the exact direct-parent
  // catalog supplies the native mode.
  h.world.add({
    id: 'late-child',
    createdAt: 5,
    parentSession: ROOT,
    origin: 'subagent',
    delegationDepth: 1,
    live: true,
    events: [],
    projections: { subagent: { mode: 'continuable', label: 'late', seq: 0 } },
  })
  h.world.setProjections(ROOT, { subagentCatalog: catalogValue([['child-a', 'continuable', 'task'], ['late-child', 'continuable', 'late']]) })
  h.subagents.directory.log.childListings.length = 0
  h.log.observes.length = 0
  const receipt = await h.backend.command('subagent-prompt', { sessionId: 'late-child', text: 'x' }) as { messageId: string }
  assert.equal(receipt.messageId, 'fake-subagent-prompt-2', 'native admission, no local state')
  assert.deepEqual(
    h.subagents.directory.log.childListings.map(call => call.parentSessionId),
    [ROOT],
    'one exact direct-parent catalog read supplies the native mode',
  )
  assert.deepEqual(h.log.observes, [], 'a resident lineage proof needs no observation lease')
  assert.equal(
    h.info.subagents?.entries.some(entry => entry.id === 'late-child'),
    false,
    'the display cache was not the authorization source',
  )

  // A cross-tree child stays rejected and is never authorized by the resident surface.
  await assert.rejects(
    h.backend.command('subagent-prompt', { sessionId: 'other-root-child', text: 'x' }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
    'another root\'s child is not reachable from this attachment',
  )
  await assert.rejects(
    h.backend.command('subagent-interrupt', { sessionId: ROOT }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
    'the current root is never its own child',
  )

  // A cold lineage hop still uses the bounded header observation, with a signal.
  const coldHost = new FakeDshHost()
  const coldWorld = new FakeSessionWorld().attach(coldHost)
  const coldLog = emptyLog()
  const coldSubagents = new FakeNativeSubagents(coldWorld, coldLog)
  coldSubagents.attach(coldHost)
  coldWorld.add({ id: ROOT, live: true, events: [], projections: { subagentCatalog: catalogValue([]) } })
  childSession(coldWorld, { id: 'unknown-child', mode: 'continuable', label: 'probe', live: false })
  const coldQuery = coldWorld.sessionQuery
  coldHost.use('sessionQuery', {
    ...coldQuery,
    observeSession: async (id: string, observeOptions?: ObserveOptions) => {
      coldLog.observes.push({ id, signal: observeOptions?.signal, projectionMode: observeOptions?.projectionMode })
      return await coldQuery.observeSession(id, observeOptions)
    },
  })
  const bridge = new SubagentBridge({ host: coldHost, emit: () => {}, warn: () => {} })
  bridge.setRoot(ROOT)
  const proven = await bridge.membership('unknown-child')
  assert.equal(proven?.untracked, true, 'a lineage-only proof stays honestly untracked')
  assert.equal(coldLog.observes.length, 1, 'one bounded header read for the cold hop')
  assert.equal(coldLog.observes[0].projectionMode, 'none', 'a header-only hop folds no projection')
  const signal = coldLog.observes[0].signal
  assert.ok(signal instanceof AbortSignal, 'the epoch/deadline signal reaches the header read')
  assert.equal(signal.aborted, false)
  bridge.close()
  assert.equal(signal.aborted, true, 'closing the bridge aborts the header read signal')
})

test('durable child reads forward the epoch signal and stay fail-closed after teardown', async () => {
  const h = await harness({
    children: [['child-a', 'continuable', 'task']],
    childrenSpecs: [{ id: 'child-a', mode: 'continuable', label: 'task', live: false }],
  })
  h.log.observes.length = 0
  const info = await h.backend.command('subagent-session', { sessionId: 'child-a' }) as SessionInfo
  assert.equal(info.snapshotUnavailable, undefined, 'the durable log was readable')
  assert.ok(h.log.observes.length >= 1, 'the transcript read used the native observation')
  const signal = h.log.observes[0].signal
  assert.ok(signal instanceof AbortSignal, 'the transcript observation carries a cancellation signal')
  assert.equal(signal.aborted, false)
  assert.notEqual(h.log.observes[0].projectionMode, 'none', 'the transcript read keeps the projection values')

  // The resident row path preserved the same content facts on the main tree.
  assert.equal(entryOf(h.info.subagents?.entries, 'child-a')?.label, 'task')

  await h.backend.close()
  assert.equal(signal.aborted, true, 'teardown aborts an in-flight durable read signal')

  // A cancelled durable read is not a bundle failure: no diagnostic is emitted.
  const synthetic = new FakeDshHost()
  new FakeSessionWorld().attach(synthetic)
  const cancelled = new Error('session observation was aborted')
  Object.assign(cancelled, { code: 'SESSION_QUERY_ABORTED' })
  synthetic.use('sessionQuery', { observeSession: async () => { throw cancelled } })
  const warnings: string[] = []
  const bridge = new SubagentBridge({ host: synthetic, emit: () => {}, warn: message => warnings.push(message) })
  bridge.setRoot(ROOT)
  assert.equal(await bridge.readSession('child-cancelled'), undefined, 'a cancelled read fails closed')
  assert.deepEqual(warnings, [], 'cancellation is silent, not a diagnostic')
  bridge.close()
})

test('the resident path never creates an Agent, schedules work or lists the tree twice', async () => {
  const h = await harness({
    children: [
      ['child-a', 'continuable', 'task'],
      ['child-b', 'continuable', 'other'],
    ],
    childrenSpecs: [
      { id: 'child-a', mode: 'continuable', label: 'task', live: true },
      { id: 'child-b', mode: 'continuable', label: 'other', live: true },
    ],
  })
  const creates = h.agents.createCalls.length
  const resumes = h.agents.resumeCalls.length
  const listings = h.subagents.directory.log.listings.length
  const cuts = rowCuts(h.log).length

  // A live projection frame updates the row without another structural or row read.
  h.world.setProjection('child-a', 'tokenUsage', { uncachedInputTokens: 2, outputTokens: 3 })
  await until(
    () => h.events.some(event => event.type === 'subagent' && event.value.id === 'child-a' && event.value.totalTokens === 5),
    'the value-only upsert',
  )
  assert.equal(h.subagents.directory.log.listings.length, listings, 'a value frame re-lists nothing')
  assert.equal(rowCuts(h.log).length, cuts, 'a value frame takes no additional projection cut')
  assert.deepEqual(h.log.observes, [], 'a value frame takes no observation lease')

  const refreshed = await h.backend.connect()
  assert.equal(h.agents.createCalls.length, creates, 'a resident read never creates a child Agent')
  assert.equal(h.agents.resumeCalls.length, resumes, 'a resident read never resumes an Agent')
  assert.equal(refreshed.subagents?.truncated, undefined)
  assert.deepEqual(refreshed.subagents?.entries.map(entry => entry.id), ['child-a', 'child-b'])
})