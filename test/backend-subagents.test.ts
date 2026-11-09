/**
 * Offline contract tests for the native subagent bridge.
 *
 * Every fact is a synthetic Cordis host: no profile, credential, real session
 * log, Agent creation/resume or model request is touched. `FakeSessionWorld`
 * mirrors the public `ctx.sessions` / `ctx.sessionQuery` / `ctx.sessionProjections`
 * read faces; the backend's own `SubagentBridge` folds their projection values.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshBackend, type DshContextBackend } from '../src/backend/context.ts'
import type { BackendEvent, DecisionRequest, SessionInfo, SubagentEntry, SubagentSnapshot } from '../src/backend/types.ts'

type SessionEventFrame = Extract<BackendEvent, { type: 'session_event' }>
type StreamStart = Extract<BackendEvent, { type: 'stream_start' }>
type StreamChunk = Extract<BackendEvent, { type: 'stream_chunk' }>

function isSessionEvent(event: BackendEvent): event is SessionEventFrame {
  return event.type === 'session_event'
}

function streamStarts(events: readonly BackendEvent[], sessionId: string): StreamStart[] {
  return events.flatMap(event => event.type === 'stream_start' && event.sessionId === sessionId ? [event] : [])
}

function streamChunks(events: readonly BackendEvent[], sessionId: string): StreamChunk[] {
  return events.flatMap(event => event.type === 'stream_chunk' && event.sessionId === sessionId ? [event] : [])
}
import {
  FakeAgentRegistry,
  FakeDshHost,
  FakeSessionWorld,
  createFakeAgent,
  fakeCatalogEvent,
  fakeNativeHelpers,
  nextTask,
  type FakeAgentState,
  type FakeSessionEvent,
} from '../src/backend/testing.ts'

const ROOT = 'root-session'
const ROOT_AGENT_OPTIONS = {
  provider: 'p1',
  model: 'm1',
}

type RawRow = Record<string, unknown>
type ChildMode = 'one-shot' | 'continuable' | 'external' | 'unknown'

/** One native-shaped rejection carrying a public DSH error code. */
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

/**
 * Host double for the public `ctx.subagents` discovery contract
 * (`listChildren` / `listDescendants`): stable pre-order, per-catalog event
 * order, external leaves, branch diagnostics and one released observation per
 * branch. The adapter under test must never walk catalogs itself, so this double
 * is the only structure source in these tests.
 */
class FakeNativeSubagents {
  readonly descendantCalls: Array<{ rootSessionId: string; signal: AbortSignal | undefined }> = []
  readonly childCalls: Array<{ parentSessionId: string; signal: AbortSignal | undefined }> = []
  /** Parent ids whose catalog was read, in order (native releases each first). */
  readonly catalogReads: string[] = []
  /** Whole-listing failure with a native code. */
  fail: Error | undefined
  /** Per-branch catalog failure with a native code (`corrupt`/`unavailable`). */
  readonly branchFailures = new Map<string, Error>()
  /** Last-mile row rewrite: models a partial, older or hostile service. */
  mapRows: ((rows: RawRow[]) => unknown[]) | undefined
  private readonly world: FakeSessionWorld

  constructor(world: FakeSessionWorld) {
    this.world = world
  }

  /** Install this double as the mounted native discovery service. */
  attach(host: FakeDshHost): this {
    host.use('subagents', this)
    return this
  }

  async listChildren(parentSessionId: string, signal?: AbortSignal): Promise<unknown[]> {
    this.childCalls.push({ parentSessionId, signal })
    return this.catalog(parentSessionId, signal)
  }

  async listDescendants(rootSessionId: string, signal?: AbortSignal): Promise<unknown[]> {
    this.descendantCalls.push({ rootSessionId, signal })
    if (this.fail !== undefined) throw this.fail
    const root = this.catalog(rootSessionId, signal)
    const stack = root.map(entry => ({ entry, parentId: rootSessionId, depth: 1 })).reverse()
    const visited = new Set<string>([rootSessionId])
    const result: RawRow[] = []
    for (let position = stack.pop(); position !== undefined; position = stack.pop()) {
      const { entry, parentId, depth } = position
      const id = typeof entry.id === 'string' ? entry.id : ''
      if (id === '' || visited.has(id)) continue
      visited.add(id)
      if (signal?.aborted === true) throw listingFailure('subagent listing was cancelled', 'CANCELLED')
      let children: RawRow[]
      try {
        children = modeOfRow(entry) === 'external' ? [] : this.catalog(id, signal)
      } catch (error) {
        const code = (error as { code?: unknown }).code
        result.push({
          kind: 'diagnostic',
          id,
          parentId,
          depth,
          reason: code === 'SESSION_QUERY_CORRUPT_SESSION' || code === 'SESSION_QUERY_SOURCE_CONFLICT' ? 'corrupt' : 'unavailable',
        })
        continue
      }
      if (modeOfRow(entry) === 'unknown') {
        result.push({ kind: 'diagnostic', id, parentId, depth, reason: 'unsupported' })
      } else {
        result.push({
          kind: 'child',
          id,
          parentId,
          depth,
          mode: modeOfRow(entry),
          ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
          activity: this.world.store.get(id) === undefined ? 'inactive' : 'running',
          hasChildren: children.length > 0,
        })
      }
      for (const child of [...children].reverse()) stack.push({ entry: child, parentId: id, depth: depth + 1 })
    }
    return this.mapRows === undefined ? result : this.mapRows(result)
  }

  /** One parent catalog read: cancels, releases (implicitly) and validates. */
  private catalog(parentSessionId: string, signal: AbortSignal | undefined): RawRow[] {
    if (signal?.aborted === true) throw listingFailure('subagent listing was cancelled', 'CANCELLED')
    this.catalogReads.push(parentSessionId)
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

interface Harness {
  host: FakeDshHost
  agents: FakeAgentRegistry
  world: FakeSessionWorld
  subagents: FakeNativeSubagents
  backend: DshContextBackend
  events: BackendEvent[]
  warnings: string[]
  info: SessionInfo
  rootAgent: FakeAgentState
}

function rootSessionEvents(children: Array<[string, 'one-shot' | 'continuable' | 'external' | 'unknown', string?]>): FakeSessionEvent[] {
  return children.map(([id, mode, label]) => fakeCatalogEvent(id, mode, label))
}

function catalogValue(children: Array<[string, 'one-shot' | 'continuable' | 'external' | 'unknown', string?]>): unknown[] {
  return children.map(([id, mode, label], index) => ({
    id,
    mode,
    ...(label === undefined ? {} : { label }),
    createdAt: 1000 + index,
  }))
}

function tokens(uncachedInputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0): Record<string, number> {
  return { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

async function harness(options: {
  children?: Array<[string, 'one-shot' | 'continuable' | 'external' | 'unknown', string?]>
  setup?: (world: FakeSessionWorld, host: FakeDshHost) => void
  rootProjections?: Record<string, unknown>
  rootExtraEvents?: FakeSessionEvent[]
  /** Complete own-suffix event list override (used to model a seeded fork). */
  rootEvents?: FakeSessionEvent[]
  inheritedEventCount?: number
  resume?: boolean
} = {}): Promise<Harness> {
  const host = new FakeDshHost()
  const agents = new FakeAgentRegistry()
  const world = new FakeSessionWorld().attach(host)
  const subagents = new FakeNativeSubagents(world)
  const warnings: string[] = []
  host.use('agents', agents)
  host.use('agentDefaultModel', {
    currentSelection: () => ({ ...ROOT_AGENT_OPTIONS }),
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
    inheritedEventCount: options.inheritedEventCount ?? 0,
    events: options.rootEvents ?? [...rootSessionEvents(children), ...(options.rootExtraEvents ?? [])],
    projections: {
      subagentCatalog: catalogValue(children),
      ...(options.rootProjections ?? {}),
    },
  })
  options.setup?.(world, host)
  if (host.get('subagents') === undefined) subagents.attach(host)
  const events: BackendEvent[] = []
  const backend = createDshBackend(host, {
    cwd: '/workspace',
    resume: ROOT,
    native: fakeNativeHelpers(),
    warn: message => warnings.push(message),
  })
  backend.onEvent(event => events.push(event))
  const info = await backend.connect()
  const rootAgent = agents.get(ROOT)
  assert.ok(rootAgent !== undefined, 'the fake resume produced the root Agent')
  return { host, agents, world, subagents, backend, events, warnings, info, rootAgent }
}

function childSession(
  world: FakeSessionWorld,
  options: {
    id: string
    parent?: string
    mode?: 'one-shot' | 'continuable'
    label?: string
    timing?: Record<string, unknown>
    usage?: Record<string, number>
    catalog?: Array<[string, 'one-shot' | 'continuable' | 'external' | 'unknown', string?]>
    events?: FakeSessionEvent[]
    modelSelection?: Record<string, unknown>
    origin?: 'subagent'
    live?: boolean
  },
): void {
  world.add({
    id: options.id,
    createdAt: 2,
    parentSession: options.parent ?? ROOT,
    origin: options.origin ?? 'subagent',
    delegationDepth: 1,
    live: options.live ?? false,
    events: [
      ...(options.events ?? []),
      ...(options.catalog ?? []).map(([id, mode, label]) => fakeCatalogEvent(id, mode, label)),
    ],
    projections: {
      ...(options.mode === undefined
        ? {}
        : { subagent: { mode: options.mode, ...(options.label === undefined ? {} : { label: options.label }), seq: 0 } }),
      subagentTiming: options.timing ?? { settledMs: 0 },
      ...(options.usage === undefined ? {} : { tokenUsage: options.usage }),
      subagentCatalog: catalogValue(options.catalog ?? []),
      ...(options.modelSelection === undefined ? {} : { modelSelection: options.modelSelection }),
    },
  })
}

function subagentSnapshot(events: readonly BackendEvent[]): SubagentSnapshot | undefined {
  let snapshot: SubagentSnapshot | undefined
  for (const event of events) if (event.type === 'subagents') snapshot = event.value
  return snapshot
}

function upserts(events: readonly BackendEvent[]): SubagentEntry[] {
  return events.flatMap(event => event.type === 'subagent' ? [event.value] : [])
}

function entryOf(snapshot: SubagentSnapshot | undefined, id: string): SubagentEntry | undefined {
  return snapshot?.entries.find(entry => entry.id === id)
}

async function until(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}

/** Emit one child session event through the fake host's public feed. */
function emitChildEvent(host: FakeDshHost, childId: string, event: FakeSessionEvent): void {
  host.emit('session/event', { id: childId }, { seq: 0, time: Date.now(), ...event })
}

function startRun(host: FakeDshHost, id: string, runId: string, local = true): void {
  host.emit('subagent/start', { runId, provider: 'spawn', id, local })
}

function endRun(host: FakeDshHost, id: string, runId: string, stopReason: string, local = true): void {
  host.emit('subagent/end', { runId, provider: 'spawn', id, local, stopReason })
}

test('cold catalog: native projections populate SessionInfo.subagents without an Agent', async () => {
  const h = await harness({
    children: [
      ['child-a', 'continuable', 'research'],
      ['child-b', 'one-shot', 'audit'],
      ['child-ext', 'external', 'remote'],
    ],
    setup: (world) => {
      childSession(world, {
        id: 'child-a',
        mode: 'continuable',
        label: 'research',
        timing: { settledMs: 1_500, lastTurnCompleted: true },
        usage: tokens(10, 20, 30, 40),
        modelSelection: { lastUsed: { provider: 'p1', model: 'm1', reasoningEffort: 'high' }, next: null },
      })
      childSession(world, {
        id: 'child-b',
        mode: 'one-shot',
        label: 'audit',
        timing: { settledMs: 250, lastTurnCompleted: true },
        usage: tokens(1, 2),
      })
    },
  })

  assert.equal(h.agents.createCalls.length, 0)
  assert.equal(h.agents.resumeCalls.length, 1, 'only the root resume was requested')
  assert.ok(h.info.subagents, 'SessionInfo carries the native child catalog')
  const entries = h.info.subagents!.entries
  assert.deepEqual(entries.map(entry => entry.id), ['child-a', 'child-b', 'child-ext'])
  assert.equal(h.info.subagents!.truncated, undefined)

  const [a, b, ext] = entries
  assert.equal(a.mode, 'continuable')
  assert.equal(a.label, 'research')
  assert.equal(a.parentSessionId, ROOT)
  assert.equal(a.catalogSeq, 0)
  // The native descendant listing drops the catalog row's createdAt; the child
  // Session header is the durable fallback (see docs/SUBAGENT-ADAPTER-CONVERGENCE.md).
  assert.equal(a.createdAt, 2)
  assert.equal(a.local, true)
  assert.equal(a.status, 'idle', 'a continuable child with a completed turn is idle, not terminal')
  assert.equal(a.totalTokens, 100, 'the four native token buckets are summed')
  assert.deepEqual(a.timing, { settledMs: 1_500, lastTurnCompleted: true })
  assert.equal(a.provider, 'p1', 'the durable modelSelection projection supplies the child route')
  assert.equal(a.model, 'm1')
  assert.equal(a.reasoningEffort, 'high')

  assert.equal(b.mode, 'one-shot')
  assert.equal(b.status, 'completed')
  assert.equal(b.catalogSeq, 1)
  assert.equal(b.totalTokens, 3)

  assert.equal(ext.mode, 'external')
  assert.equal(ext.status, 'external')
  assert.equal(ext.local, false)
  assert.equal(ext.catalogSeq, 2)

  assert.ok(h.info.capabilities.includes('subagents'))
  assert.ok(h.info.capabilities.includes('subagent-session'))
  assert.ok(h.info.capabilities.includes('subagent-follow'))
})

test('cold catalog: a known-empty catalog stays authoritative and empty', async () => {
  const h = await harness({ children: [] })
  assert.deepEqual(h.info.subagents, { entries: [] })
})

test('fork-inherited catalog facts are excluded and own rows keep their parent seq', async () => {
  const h = await harness({
    inheritedEventCount: 2,
    rootEvents: [
      fakeCatalogEvent('ghost-one', 'one-shot', 'inherited') as FakeSessionEvent,
      fakeCatalogEvent('ghost-two', 'continuable', 'inherited') as FakeSessionEvent,
      fakeCatalogEvent('own-child', 'continuable', 'own') as FakeSessionEvent,
    ],
    children: [['own-child', 'continuable', 'own']],
    setup: (world) => {
      childSession(world, { id: 'own-child', mode: 'continuable', label: 'own' })
    },
  })
  assert.ok(h.info.subagents)
  assert.deepEqual(h.info.subagents!.entries.map(entry => entry.id), ['own-child'], 'inherited facts are not this root\'s children')
  const own = entryOf(h.info.subagents, 'own-child')!
  assert.equal(own.catalogSeq, 2, 'the own catalog event seq anchors the row')
})

test('nested children and inconsistent lineage', async () => {
  const h = await harness({
    children: [
      ['parent-child', 'continuable', 'parent'],
      ['bad-lineage', 'continuable', 'mismatch'],
    ],
    setup: (world) => {
      childSession(world, {
        id: 'parent-child',
        mode: 'continuable',
        label: 'parent',
        catalog: [['grand-child', 'one-shot', 'grand']],
      })
      childSession(world, { id: 'grand-child', parent: 'parent-child', mode: 'one-shot', label: 'grand' })
      // Catalog says parent-child, header says another durable parent: omitted.
      childSession(world, { id: 'bad-lineage', parent: 'somewhere-else', mode: 'continuable', label: 'mismatch' })
    },
  })
  assert.ok(h.info.subagents)
  const ids = h.info.subagents!.entries.map(entry => entry.id)
  assert.deepEqual(ids, ['parent-child', 'grand-child'], 'pre-order, no inconsistent row')
  assert.equal(entryOf(h.info.subagents, 'grand-child')!.parentSessionId, 'parent-child')
  assert.equal(h.info.subagents!.truncated, true, 'incomplete native data is reported')
})

test('an unreadable child keeps its native membership row but marks the tree truncated', async () => {
  const h = await harness({
    children: [['missing-child', 'continuable', 'gone']],
    setup: () => {
      // No session is added for missing-child: the catalog row is still native.
    },
  })
  const entry = entryOf(h.info.subagents, 'missing-child')
  assert.ok(entry, 'the parent-owned catalog row survives an unreadable child')
  assert.equal(entry!.status, 'unknown', 'no status is invented from an unreadable child')
  assert.equal(h.info.subagents!.truncated, true)
})

test('start/end races: settled stop reasons, repeated activations and finish-before-spawn', async () => {
  const h = await harness({
    children: [['child-a', 'continuable', 'task'], ['child-z', 'continuable', 'race']],
    setup: (world) => {
      childSession(world, { id: 'child-a', mode: 'continuable', label: 'task' })
      childSession(world, { id: 'child-z', mode: 'continuable', label: 'race' })
    },
  })
  const child = createFakeAgent({ id: 'child-a', status: 'running' })
  h.agents.enter(child.agent)

  startRun(h.host, 'child-a', 'run-1')
  await until(() => upserts(h.events).some(entry => entry.id === 'child-a' && entry.status === 'running'), 'running upsert')
  assert.equal(upserts(h.events).at(-1)!.lastRunId, 'run-1')

  endRun(h.host, 'child-a', 'run-1', 'aborted')
  await until(() => upserts(h.events).some(entry => entry.id === 'child-a' && entry.status === 'stopped'), 'stopped upsert')
  assert.equal(upserts(h.events).at(-1)!.lastStopReason, 'aborted')

  // A second, repeated continuable activation reuses the durable child.
  child.agent.status = 'running'
  startRun(h.host, 'child-a', 'run-2')
  await until(() => upserts(h.events).some(entry => entry.id === 'child-a' && entry.lastRunId === 'run-2'), 'second activation')
  assert.equal(upserts(h.events).at(-1)!.status, 'running')

  endRun(h.host, 'child-a', 'run-2', 'completed')
  await until(() => upserts(h.events).at(-1)?.lastStopReason === 'completed', 'completed settlement')
  const settled = upserts(h.events).at(-1)!
  assert.equal(settled.status, 'idle', 'a continuable child settles to idle')
  assert.equal(settled.lastRunId, 'run-2')

  // Finish-before-spawn: an end seen first wins over a late start of the same run.
  endRun(h.host, 'child-z', 'run-early', 'error')
  await until(() => upserts(h.events).some(entry => entry.id === 'child-z' && entry.status === 'failed'), 'early end applied')
  startRun(h.host, 'child-z', 'run-early')
  await nextTask()
  assert.equal(upserts(h.events).filter(entry => entry.id === 'child-z' && entry.status === 'running').length, 0,
    'a start paired with an already-settled run never reports running')
  assert.equal(upserts(h.events).at(-1)!.lastRunId, 'run-early')
  assert.equal(upserts(h.events).at(-1)!.lastStopReason, 'error')
})

test('an end for a not-yet-cataloged child applies when the row appears', async () => {
  const h = await harness({ children: [] })
  childSession(h.world, { id: 'late-child', mode: 'one-shot', label: 'late' })
  endRun(h.host, 'late-child', 'run-late', 'max-tokens')
  await nextTask()
  h.world.appendEvent(ROOT, fakeCatalogEvent('late-child', 'one-shot', 'late') as FakeSessionEvent)
  h.world.setProjection(ROOT, 'subagentCatalog', catalogValue([['late-child', 'one-shot', 'late']]))
  h.host.emit('session/event', h.rootAgent.session, { seq: 2, type: 'subagent/catalog', data: fakeCatalogEvent('late-child', 'one-shot', 'late').data })
  await until(() => entryOf(subagentSnapshot(h.events), 'late-child') !== undefined, 'late row')
  const entry = entryOf(subagentSnapshot(h.events), 'late-child')!
  assert.equal(entry.status, 'max-tokens')
  assert.equal(entry.lastStopReason, 'max-tokens')
  assert.equal(entry.lastRunId, 'run-late')
})

test('a freshly cataloged local child is enterable while initializing, with no child Agent', async () => {
  const h = await harness({ children: [] })
  const creates = h.agents.createCalls.length
  const resumes = h.agents.resumeCalls.length

  // The native start edge precedes the parent-owned catalog fact. A start edge
  // alone proves no membership row, so nothing is painted or enterable yet.
  startRun(h.host, 'child-fresh', 'run-fresh', true)
  await nextTask()
  assert.equal(subagentSnapshot(h.events), undefined, 'a start edge alone publishes no row')
  await assert.rejects(
    h.backend.command('subagent-follow', { sessionId: 'child-fresh', follow: true }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
    'a child without its catalog fact is not a member yet',
  )

  // The durable parent catalog fact and the child Session exist; no Agent does.
  childSession(h.world, {
    id: 'child-fresh',
    mode: 'continuable',
    label: 'Explore',
    live: true,
    events: [{ type: 'subagent/descriptor', data: { mode: 'continuable', label: 'Explore' } }],
  })
  h.world.appendEvent(ROOT, fakeCatalogEvent('child-fresh', 'continuable', 'Explore') as FakeSessionEvent)
  h.world.setProjection(ROOT, 'subagentCatalog', catalogValue([['child-fresh', 'continuable', 'Explore']]))
  h.host.emit('session/event', h.rootAgent.session, {
    seq: 2,
    type: 'subagent/catalog',
    data: fakeCatalogEvent('child-fresh', 'continuable', 'Explore').data,
  })
  await until(() => entryOf(subagentSnapshot(h.events), 'child-fresh') !== undefined, 'first catalog row')

  const entry = entryOf(subagentSnapshot(h.events), 'child-fresh')!
  assert.equal(entry.mode, 'continuable')
  assert.equal(entry.local, true, 'the first local row is never marked non-local')
  assert.equal(entry.status, 'initializing', 'the start edge is known while the child Agent is absent')
  assert.equal(entry.lastRunId, 'run-fresh')
  assert.equal(h.agents.get('child-fresh'), undefined, 'no child Agent exists in the registry')

  // First action on that row, exactly like the first click: follow then read.
  // Both are native-membership based and create/resume nothing.
  assert.deepEqual(
    await h.backend.command('subagent-follow', { sessionId: 'child-fresh', follow: true }),
    { sessionId: 'child-fresh', follow: true },
  )
  const info = await h.backend.command('subagent-session', { sessionId: 'child-fresh' }) as SessionInfo
  assert.equal(info.sessionId, 'child-fresh')
  assert.equal(info.snapshotUnavailable, undefined)
  assert.ok(info.events?.some(event => event.type === 'subagent/descriptor'), 'the durable child cut is returned')
  assert.equal(h.agents.createCalls.length, creates, 'follow and the read never create an Agent')
  assert.equal(h.agents.resumeCalls.length, resumes, 'follow and the read never resume an Agent')
  assert.equal(
    entryOf(subagentSnapshot(h.events), 'child-fresh')!.status,
    'initializing',
    'reading never invents a running status',
  )

  assert.deepEqual(
    await h.backend.command('subagent-follow', { sessionId: 'child-fresh', follow: false }),
    { sessionId: 'child-fresh', follow: false },
  )
})

test('external children are leaves; their lifecycle never becomes a local status', async () => {
  const h = await harness({
    children: [['external-child', 'external', 'cloud']],
    setup: (world) => {
      // Even a conflicting local session with a catalog must not be traversed.
      childSession(world, { id: 'external-child', mode: 'continuable', label: 'cloud', catalog: [['nested', 'one-shot', 'nested']] })
      childSession(world, { id: 'nested', parent: 'external-child', mode: 'one-shot', label: 'nested' })
    },
  })
  startRun(h.host, 'external-child', 'run-ext', false)
  endRun(h.host, 'external-child', 'run-ext', 'error', false)
  // Native lifecycle metadata may update the row, but the status vocabulary
  // for a leaf stays `external` — never a local running/failed status.
  await until(() => upserts(h.events).some(value => value.id === 'external-child'), 'external upsert')
  const published = upserts(h.events).at(-1)!
  assert.equal(published.status, 'external')
  assert.equal(published.local, false)
  assert.equal(published.lastStopReason, 'error')
  const entry = entryOf(h.info.subagents, 'external-child')!
  assert.equal(entry.mode, 'external')
  assert.equal(entry.status, 'external')
  assert.equal(entry.local, false)
  assert.deepEqual(h.info.subagents!.entries.map(value => value.id), ['external-child'])
  assert.equal(entryOf(h.info.subagents, 'nested'), undefined, 'external rows are never traversed')
  await assert.rejects(
    h.backend.command('subagent-session', { sessionId: 'external-child' }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
    'an external leaf has no local transcript to read',
  )
  // Follow fails closed for the same native reason: an external execution owns
  // no local Session, so admitting a follow would promise frames that cannot
  // exist. Release stays unconditional so teardown can never throw.
  await assert.rejects(
    h.backend.command('subagent-follow', { sessionId: 'external-child', follow: true }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
    'an external leaf has no local session to follow',
  )
  assert.deepEqual(
    await h.backend.command('subagent-follow', { sessionId: 'external-child', follow: false }),
    { sessionId: 'external-child', follow: false },
    'unfollowing an unopenable row never throws',
  )
})

test('follow does not await a pending child transcript read', async () => {
  const h = await harness({
    children: [['child-a', 'continuable', 'task']],
    setup: (world) => {
      childSession(world, { id: 'child-a', mode: 'continuable', label: 'task' })
    },
  })
  // Model a slow durable transcript read for the child. Membership comes from
  // the native catalog row, so follow must resolve without waiting for it; the
  // delayed continuation is bounded and released here only if it is awaited.
  const real = h.world.sessionQuery
  const held: string[] = []
  h.host.use('sessionQuery', {
    ...real,
    observeSession: (id: string, options?: { readonly projectionMode?: 'all' | 'none' }) => {
      if (id !== 'child-a') return real.observeSession(id, options)
      held.push(id)
      return new Promise<unknown>(resolve => {
        const timer = setTimeout(() => { void resolve(real.observeSession(id, options)) }, 3_000)
        timer.unref?.()
      })
    },
    readSession: real.readSession,
  })

  const started = Date.now()
  assert.deepEqual(
    await h.backend.command('subagent-follow', { sessionId: 'child-a', follow: true }),
    { sessionId: 'child-a', follow: true },
  )
  const elapsed = Date.now() - started
  assert.deepEqual(held, [], 'follow never observes the child transcript')
  assert.ok(elapsed < 1_000, `follow resolved without the pending read (${elapsed}ms)`)
  assert.deepEqual(
    await h.backend.command('subagent-follow', { sessionId: 'child-a', follow: false }),
    { sessionId: 'child-a', follow: false },
  )
})

test('one bounded activity label per child; child tokens stay off the main UI', async () => {
  const h = await harness({
    children: [['child-a', 'continuable', 'task']],
    setup: (world) => {
      childSession(world, { id: 'child-a', mode: 'continuable', label: 'task' })
    },
  })
  const child = createFakeAgent({ id: 'child-a', status: 'running' })
  h.agents.enter(child.agent)
  startRun(h.host, 'child-a', 'run-1')
  await until(() => upserts(h.events).some(entry => entry.id === 'child-a'), 'initial upsert')

  emitChildEvent(h.host, 'child-a', {
    type: 'tool/call',
    data: { name: `bash\u001b[31m-${'x'.repeat(200)}`, callId: 'call-1', arguments: '{}' },
  })
  await until(() => upserts(h.events).at(-1)?.lastActivity?.startsWith('tool:') === true, 'tool activity')
  const activity = upserts(h.events).at(-1)!.lastActivity!
  assert.ok(activity.startsWith('tool: bash'))
  assert.ok(activity.length <= 64, `bounded activity label (${activity.length})`)
  assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(activity), false)

  emitChildEvent(h.host, 'child-a', { type: 'assistant/message', data: {} })
  await until(() => upserts(h.events).at(-1)?.lastActivity === 'reply', 'reply activity')

  // Only a bounded label formed from selected events is emitted; no child
  // stream and no raw child session event reaches the main listener.
  assert.equal(h.events.some(event => event.type === 'stream_start' || event.type === 'stream_chunk'), false)
  assert.equal(h.events.some(event => event.type === 'session_event' && event.sessionId === 'child-a'), false)
})

test('follow/unfollow filters child frames and leaves root events unchanged', async () => {
  const h = await harness({
    children: [['child-a', 'continuable', 'task'], ['child-b', 'continuable', 'other']],
    setup: (world) => {
      childSession(world, { id: 'child-a', mode: 'continuable', label: 'task' })
      childSession(world, { id: 'child-b', mode: 'continuable', label: 'other' })
    },
  })
  const childA = createFakeAgent({ id: 'child-a', status: 'running' })
  const childB = createFakeAgent({ id: 'child-b', status: 'running' })
  h.agents.enter(childA.agent)
  h.agents.enter(childB.agent)

  const followed = await h.backend.command('subagent-follow', { sessionId: 'child-a', follow: true })
  assert.deepEqual(followed, { sessionId: 'child-a', follow: true })

  emitChildEvent(h.host, 'child-a', { type: 'assistant/message', data: { message: { content: [] } } })
  emitChildEvent(h.host, 'child-b', { type: 'assistant/message', data: { message: { content: [] } } })
  h.host.emit('agent/assistant-stream', {
    agent: childA.agent,
    frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 },
  })
  h.host.emit('agent/assistant-stream', {
    agent: childA.agent,
    frame: { type: 'chunk', attemptId: 'a1', revision: 1, index: 0, chunk: { type: 'text-delta', text: 'hi' } },
  })
  h.host.emit('agent/assistant-stream', {
    agent: childA.agent,
    frame: { type: 'end', attemptId: 'a1', revision: 1, outcome: { kind: 'committed', seq: 3 } },
  })
  h.host.emit('agent/assistant-stream', {
    agent: childB.agent,
    frame: { type: 'start', attemptId: 'b1', revision: 1, turn: 1, step: 1 },
  })
  await nextTask()

  assert.equal(h.events.filter(isSessionEvent).some(event => event.sessionId === 'child-a'), true)
  assert.deepEqual(streamStarts(h.events, 'child-a').map(event => event.attemptId), ['a1'])
  assert.deepEqual(streamChunks(h.events, 'child-a').map(event => event.chunk), [{ type: 'text-delta', text: 'hi' }])
  assert.equal(streamStarts(h.events, 'child-b').length, 0)
  assert.equal(h.events.filter(isSessionEvent).some(event => event.sessionId === 'child-b'), false)

  // Root frames still use the root session id.
  h.host.emit('agent/assistant-stream', {
    agent: h.rootAgent,
    frame: { type: 'start', attemptId: 'root-1', revision: 1, turn: 1, step: 1 },
  })
  const rootFrame = h.events.at(-1)!
  assert.equal(rootFrame.type, 'stream_start')
  assert.equal(rootFrame.type === 'stream_start' ? rootFrame.sessionId : undefined, ROOT)

  const unfollowed = await h.backend.command('subagent-follow', { sessionId: 'child-a', follow: false })
  assert.deepEqual(unfollowed, { sessionId: 'child-a', follow: false })
  const before = h.events.length
  emitChildEvent(h.host, 'child-a', { type: 'assistant/message', data: {} })
  h.host.emit('agent/assistant-stream', {
    agent: childA.agent,
    frame: { type: 'start', attemptId: 'a2', revision: 1, turn: 2, step: 1 },
  })
  assert.equal(h.events.length, before, 'unfollowed children emit nothing')
})

test('follow requires native tree membership and clears on root switch', async () => {
  const h = await harness({
    children: [['child-a', 'continuable', 'task']],
    setup: (world) => {
      childSession(world, { id: 'child-a', mode: 'continuable', label: 'task' })
    },
  })
  const child = createFakeAgent({ id: 'child-a', status: 'running' })
  h.agents.enter(child.agent)
  await assert.rejects(
    h.backend.command('subagent-follow', { sessionId: 'not-a-child', follow: true }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
  )
  await assert.rejects(
    h.backend.command('subagent-follow', { sessionId: 'child-a', follow: 'yes' }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
  )
  await h.backend.command('subagent-follow', { sessionId: 'child-a', follow: true })

  h.world.add({
    id: 'root-two',
    live: true,
    events: [],
    projections: { subagentCatalog: [] },
  })
  await h.backend.command('resume', { sessionId: 'root-two' })
  emitChildEvent(h.host, 'child-a', { type: 'assistant/message', data: {} })
  h.host.emit('agent/assistant-stream', { agent: child.agent, frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 } })
  assert.equal(h.events.some(event => event.type === 'session_event' && event.sessionId === 'child-a'), false)
  assert.equal(h.events.some(event => event.type === 'stream_start' && event.sessionId === 'child-a'), false)
})

test('subagent-session returns a cold-safe child snapshot without create/resume', async () => {
  const h = await harness({
    children: [['child-a', 'continuable', 'task']],
    setup: (world) => {
      childSession(world, {
        id: 'child-a',
        mode: 'continuable',
        label: 'task',
        modelSelection: { lastUsed: { provider: 'p1', model: 'm2', reasoningEffort: 'low' }, next: null },
        events: [
          { type: 'user/message', data: { content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } } },
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
        ],
        catalog: [['grand-child', 'one-shot', 'grand']],
      })
      childSession(world, { id: 'grand-child', parent: 'child-a', mode: 'one-shot', label: 'grand' })
    },
  })
  const creates = h.agents.createCalls.length
  const resumes = h.agents.resumeCalls.length
  const info = await h.backend.command('subagent-session', { sessionId: 'child-a' }) as SessionInfo

  assert.equal(h.agents.createCalls.length, creates, 'reading a child never creates an Agent')
  assert.equal(h.agents.resumeCalls.length, resumes, 'reading a child never resumes an Agent')
  assert.equal(info.sessionId, 'child-a')
  assert.equal(info.cwd, '/workspace')
  assert.equal(info.provider, 'p1')
  assert.equal(info.model, 'm2')
  assert.equal(info.reasoningEffort, 'low')
  assert.equal(info.snapshotUnavailable, undefined)
  assert.ok(info.events, 'the native durable log is returned')
  assert.equal(info.events!.some(event => event.type === 'user/message'), true)
  assert.equal(info.events!.some(event => event.type === 'assistant/message'), true)
  assert.equal(info.events!.some(event => event.type === 'subagent/catalog'), true)
  assert.equal(info.totalEvents, 3)
  // Raw native payloads are preserved for the installed transcript codec.
  assert.deepEqual(info.events![0].data, { content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } })

  assert.ok(info.subagents, 'the child transcript carries its own child catalog')
  assert.deepEqual(info.subagents!.entries.map(entry => entry.id), ['grand-child'])
  assert.equal(info.subagents!.entries[0].parentSessionId, 'child-a')
  assert.equal(info.subagents!.entries[0].catalogSeq, 2, 'the child log seq anchors its own catalog row')

  await assert.rejects(
    h.backend.command('subagent-session', { sessionId: ROOT }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
  )
  await assert.rejects(
    h.backend.command('subagent-session', { sessionId: 'nope' }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
  )
})

test('subagent-session reports an unreadable durable log as incomplete, not empty', async () => {
  const h = await harness({
    children: [['child-a', 'continuable', 'task']],
    setup: (world) => {
      childSession(world, { id: 'child-a', mode: 'continuable', label: 'task' })
    },
  })
  h.world.remove('child-a')
  // Keep the native projection row readable so membership stays proven.
  const info = await h.backend.command('subagent-session', { sessionId: 'child-a' }) as SessionInfo
  assert.equal(info.snapshotUnavailable, true)
  assert.equal(info.events, undefined)
  assert.equal(info.model, '')
})

test('child approval and question waterfalls carry exact native origin and settle by id', async () => {
  const h = await harness({
    children: [['child-a', 'continuable', 'task']],
    setup: (world) => {
      childSession(world, { id: 'child-a', mode: 'continuable', label: 'task' })
    },
  })
  const child = createFakeAgent({ id: 'child-a', status: 'running' })
  h.agents.enter(child.agent)
  // Load the tree so the child row and its label are in the bridge cache.
  await h.backend.command('subagent-follow', { sessionId: 'child-a', follow: true })

  const abort = new AbortController()
  const approval = h.host.waterfall('approval/request', {
    agent: child.agent,
    toolName: 'bash',
    reason: 'needs to write',
    signal: abort.signal,
  })
  await until(() => h.events.some(event => event.type === 'decision'), 'approval decision')
  const decision = h.events.find(event => event.type === 'decision')!
  assert.equal(decision.type === 'decision' && decision.sessionId, ROOT, 'child decisions are rooted at the top-level session')
  const request = (decision as { request: DecisionRequest }).request
  assert.deepEqual(request.origin, {
    rootSessionId: ROOT,
    childSessionId: 'child-a',
    parentSessionId: ROOT,
    label: 'task',
  })
  assert.equal(request.kind, 'approval')
  await h.backend.respond(request.id, 'allowed-once')
  assert.equal(await approval, 'allowed-once')
  assert.ok(h.events.some(event => event.type === 'decision_closed' && event.id === request.id))

  const question = h.host.waterfall('user-questions/request', {
    agent: child.agent,
    questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'One' }, { label: 'Two' }] }],
  })
  await until(() => h.events.some(event => event.type === 'decision' && event.request.kind === 'question'), 'question decision')
  const questionDecision = h.events.filter(event => event.type === 'decision').at(-1)!
  const questionRequest = (questionDecision as { request: DecisionRequest }).request
  assert.equal(questionRequest.origin!.childSessionId, 'child-a')
  await h.backend.respond(questionRequest.id, { answers: [['Two']] })
  assert.deepEqual(await question, {
    answers: [{ id: 'q1', selected: ['Two'] }],
  })
})

test('out-of-tree decisions fail closed and root decisions stay unchanged', async () => {
  const h = await harness({ children: [] })
  const stranger = createFakeAgent({ id: 'stranger', status: 'running' })
  const fallback = await h.host.waterfall('approval/request', { agent: stranger.agent, toolName: 'bash' })
  assert.equal(fallback, undefined, 'next() keeps the native fail-closed outcome')
  assert.equal(h.events.some(event => event.type === 'decision'), false)

  const rootWaterfall = h.host.waterfall('approval/request', { agent: h.rootAgent, toolName: 'bash' })
  await until(() => h.events.some(event => event.type === 'decision'), 'root decision')
  const request = (h.events.find(event => event.type === 'decision') as { request: DecisionRequest }).request
  assert.equal(request.origin, undefined, 'the root decision payload is unchanged')
  await h.backend.respond(request.id, 'rejected')
  assert.equal(await rootWaterfall, 'rejected')
})

test('an untracked child proven only by native lineage is marked untracked', async () => {
  const h = await harness({ children: [] })
  h.world.add({
    id: 'lineage-child',
    parentSession: ROOT,
    origin: 'subagent',
    delegationDepth: 1,
    events: [],
  })
  const child = createFakeAgent({ id: 'lineage-child', status: 'running' })
  const pending = h.host.waterfall('approval/request', { agent: child.agent, toolName: 'bash' })
  await until(() => h.events.some(event => event.type === 'decision'), 'lineage decision')
  const request = (h.events.find(event => event.type === 'decision') as { request: DecisionRequest }).request
  assert.equal(request.origin?.untracked, true)
  assert.equal(request.origin?.childSessionId, 'lineage-child')
  await h.backend.respond(request.id, 'rejected')
  assert.equal(await pending, 'rejected')
})

test('a grandchild lineage chain proves tree membership for decisions', async () => {
  const h = await harness({ children: [['child-a', 'continuable', 'task']] })
  childSession(h.world, { id: 'child-a', mode: 'continuable', label: 'task' })
  h.world.add({
    id: 'grand-child',
    parentSession: 'child-a',
    origin: 'subagent',
    delegationDepth: 2,
    events: [],
  })
  const grand = createFakeAgent({ id: 'grand-child', status: 'running' })
  const pending = h.host.waterfall('approval/request', { agent: grand.agent, toolName: 'bash' })
  await until(() => h.events.some(event => event.type === 'decision'), 'grandchild decision')
  const request = (h.events.find(event => event.type === 'decision') as { request: DecisionRequest }).request
  assert.equal(request.origin?.childSessionId, 'grand-child')
  assert.equal(request.origin?.untracked, true)
  await h.backend.respond(request.id, 'rejected')
  assert.equal(await pending, 'rejected')
})

test('snapshots and upserts are idempotent; only real changes are published', async () => {
  const h = await harness({
    children: [['child-a', 'continuable', 'task']],
    setup: (world) => {
      childSession(world, { id: 'child-a', mode: 'continuable', label: 'task' })
    },
  })
  // Let the post-announce publish settle before measuring idempotency.
  await new Promise<void>(resolve => setTimeout(resolve, 50))
  const baseline = h.events.length
  // A projection frame that leaves every value unchanged must not be republished.
  h.world.changed(ROOT, 'subagentCatalog', catalogValue([['child-a', 'continuable', 'task']]))
  await new Promise<void>(resolve => setTimeout(resolve, 80))
  assert.equal(h.events.length, baseline, 'no duplicate snapshot or upsert')

  // A live Agent is a real native fact: entering it legitimately changes the
  // child's status (unknown -> idle), so this happens after the idempotency cut.
  const child = createFakeAgent({ id: 'child-a', status: 'running' })
  h.agents.enter(child.agent)
  startRun(h.host, 'child-a', 'run-1')
  await until(() => h.events.length > baseline, 'change upsert')
  const added = h.events.slice(baseline)
  assert.equal(added.filter(event => event.type === 'subagent').length, 1, 'one upsert per changed child')
  assert.equal(added[0].type === 'subagent' && added[0].sessionId, ROOT)

  // Membership changes publish one full snapshot.
  childSession(h.world, { id: 'child-b', mode: 'one-shot', label: 'second' })
  h.world.appendEvent(ROOT, fakeCatalogEvent('child-b', 'one-shot', 'second') as FakeSessionEvent)
  h.world.setProjection(ROOT, 'subagentCatalog', catalogValue([['child-a', 'continuable', 'task'], ['child-b', 'one-shot', 'second']]))
  h.host.emit('session/event', h.rootAgent.session, { seq: 3, type: 'subagent/catalog', data: fakeCatalogEvent('child-b', 'one-shot', 'second').data })
  await until(() => subagentSnapshot(h.events)?.entries.length === 2, 'structural snapshot')
  assert.equal(h.events.filter(event => event.type === 'subagents').length, 1)
})

test('close and HMR leave no stale listeners, follow state or capability claims', async () => {
  const h = await harness({
    children: [['child-a', 'continuable', 'task']],
    setup: (world) => {
      childSession(world, { id: 'child-a', mode: 'continuable', label: 'task' })
    },
  })
  const child = createFakeAgent({ id: 'child-a', status: 'running' })
  h.agents.enter(child.agent)
  await h.backend.command('subagent-follow', { sessionId: 'child-a', follow: true })
  for (const name of ['subagent/start', 'subagent/end', 'session/event', 'agent/status', 'agent/error', 'agent/created', 'agent/disposed']) {
    assert.ok(h.host.listenerCount(name) >= 1, `${name} listener bound`)
  }

  // A native `/reload` invalidates the cached tree but must re-announce the
  // refreshed attachment so later child changes are published again.
  h.host.use('hmr', { runExclusive: async <T>(operation: () => Promise<T>) => await operation(), reconcileProfile: async () => ({}) })
  const reloaded = await h.backend.command('reload') as { available: boolean; info?: SessionInfo }
  assert.equal(reloaded.available, true)
  const beforeReload = h.events.length
  startRun(h.host, 'child-a', 'run-reload')
  await until(() => h.events.slice(beforeReload).some(event => event.type === 'subagent'), 'publish after reload')
  assert.equal(h.events.slice(beforeReload).at(-1)!.type === 'subagent' && (h.events.slice(beforeReload).at(-1) as { value: SubagentEntry }).value.status, 'running')

  await h.backend.close()
  for (const name of ['subagent/start', 'subagent/end', 'session/event', 'agent/status', 'agent/error', 'agent/created', 'agent/disposed']) {
    assert.equal(h.host.listenerCount(name), 0, `${name} listener disposed`)
  }
  const before = h.events.length
  emitChildEvent(h.host, 'child-a', { type: 'assistant/message', data: {} })
  h.host.emit('subagent/start', { runId: 'run-after-close', provider: 'spawn', id: 'child-a', local: true })
  await nextTask()
  assert.equal(h.events.length, before, 'a closed bridge publishes nothing')
  assert.deepEqual(h.events.at(-1), { type: 'closed', code: 0, signal: null })
})

test('capability detection follows the mounted services (HMR safe)', async () => {
  const h = await harness({ children: [] })
  assert.ok(h.info.capabilities.includes('subagents'))
  const query = h.host.get('sessionQuery') as Record<string, unknown>
  const saved = query.observeSession
  delete query.observeSession
  try {
    const next = await h.backend.connect()
    assert.equal(next.capabilities.includes('subagents'), false)
    assert.equal(next.capabilities.includes('subagent-session'), false)
    await assert.rejects(
      h.backend.command('subagent-session', { sessionId: 'anything' }),
      (error: unknown) => (error as { code?: string }).code === 'CAPABILITY_UNAVAILABLE',
    )
  } finally {
    query.observeSession = saved
  }
  const restored = await h.backend.connect()
  assert.ok(restored.capabilities.includes('subagents'))
})

test('/resume still excludes child sessions from the picker list', async () => {
  const h = await harness({
    children: [['child-a', 'continuable', 'task']],
    setup: (world) => {
      childSession(world, {
        id: 'child-a',
        mode: 'continuable',
        label: 'task',
        events: [{ type: 'session/end-seed', data: {} }],
      })
    },
  })
  const sessions = await h.backend.command('sessions', { titles: false }) as Array<{ id: string }>
  assert.deepEqual(sessions.map(row => row.id), [ROOT])
})

test('a child session event never becomes a main transcript event while unfollowed', async () => {
  const h = await harness({
    children: [['child-a', 'continuable', 'task']],
    setup: (world) => {
      childSession(world, { id: 'child-a', mode: 'continuable', label: 'task' })
    },
  })
  const before = h.events.length
  emitChildEvent(h.host, 'child-a', { type: 'user/message', data: { content: [] } })
  await nextTask()
  assert.equal(h.events.slice(before).some(event => event.type === 'session_event'), false)
  // Root events still flow unchanged.
  h.host.emit('session/event', h.rootAgent.session, { seq: 9, type: 'assistant/message', data: {} })
  const rootEvent = h.events.at(-1)!
  assert.equal(rootEvent.type, 'session_event')
  assert.equal(rootEvent.type === 'session_event' ? rootEvent.sessionId : undefined, ROOT)
})
/**
 * Capture a waterfall outcome without leaving an unhandled rejection behind:
 * a decision that is settled during `close()` rejects before the test awaits it.
 */
type CapturedDecision = { value: unknown } | { failure: unknown }

function captureDecision(promise: Promise<unknown>): Promise<CapturedDecision> {
  return promise.then(value => ({ value }), (failure: unknown) => ({ failure }))
}

/** One lineage-proven child in the current root tree, with no catalog row. */
function lineageChild(h: Harness, id: string): FakeAgentState {
  h.world.add({ id, parentSession: ROOT, origin: 'subagent', delegationDepth: 1, events: [] })
  const child = createFakeAgent({ id, status: 'running' })
  h.agents.enter(child.agent)
  return child.agent
}

async function openChildQuestion(h: Harness, child: FakeAgentState): Promise<{ id: string; outcome: Promise<CapturedDecision> }> {
  const pending = captureDecision(h.host.waterfall('user-questions/request', {
    agent: child,
    questions: [{ id: 'q1', question: 'Pick one', options: [{ label: 'One' }] }],
  }))
  await until(() => h.events.some(event => event.type === 'decision'), 'child question decision')
  const decision = h.events.filter(event => event.type === 'decision').at(-1)
  assert.ok(decision?.type === 'decision')
  assert.equal(decision.request.origin?.childSessionId, child.id, 'the decision is owned by the child that asked')
  return { id: decision.request.id, outcome: pending }
}

test('a root cancel settles only the root Agent decisions, never an open child question', async () => {
  const h = await harness({ children: [] })
  const child = lineageChild(h, 'child-lineage')
  const question = await openChildQuestion(h, child)

  await h.backend.cancel()

  assert.equal(
    h.events.some(event => event.type === 'decision_closed' && event.id === question.id),
    false,
    'the root interruption must not close a child decision the user never saw',
  )
  assert.deepEqual(child.cancellations, [], 'the root interruption never cancels a child Agent')
  assert.deepEqual(h.rootAgent.cancellations.at(-1), { cause: 'user', keepInbox: true })

  await h.backend.respond(question.id, { answers: [['One']] })
  assert.deepEqual(await question.outcome, { value: { answers: [{ id: 'q1', selected: ['One'] }] } })
  await h.backend.close()
})

test('close settles every remaining decision, including a child request', async () => {
  const h = await harness({ children: [] })
  const child = lineageChild(h, 'child-lineage')
  const question = await openChildQuestion(h, child)

  await h.backend.close()

  const settled = await question.outcome
  assert.ok('failure' in settled, 'a surviving decision is settled when the adapter closes')
  assert.equal((settled.failure as { code?: string }).code, 'ASK_ABORTED')
  assert.ok(h.events.some(event => event.type === 'decision_closed' && event.id === question.id))
  assert.equal(h.events.filter(event => event.type === 'closed').length, 1, 'closed is announced exactly once')
})
