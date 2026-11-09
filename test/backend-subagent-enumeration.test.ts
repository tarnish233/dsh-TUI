/**
 * Offline contract tests for native subagent enumeration reuse.
 *
 * Every fact is a synthetic Cordis host: no profile, credential, real session
 * log, Agent creation/resume, model request or terminal is touched.
 *
 * `FakeSubagentDirectory` is a **host double** for the public DSH discovery
 * contract (`ctx.subagents.listChildren` / `listDescendants`): stable pre-order,
 * per-catalog event order, external leaves, branch diagnostics and one released
 * observation per branch. It reads the same synthetic projection values the
 * native implementation reads. The adapter under test must never walk catalogs
 * itself, so this double is the only structure source in these tests.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshBackend, type DshContextBackend } from '../src/backend/context.ts'
import { SubagentBridge, type SubagentBranchDiagnostic } from '../src/backend/subagents.ts'
import type { BackendEvent, SessionInfo, SubagentSnapshot } from '../src/backend/types.ts'
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
 * Host double for the public `ctx.subagents` discovery surface.
 *
 * Mirrors the documented native semantics only: it is not a second DSH
 * business implementation, and production code never contains an equivalent
 * walker.
 */
class FakeSubagentDirectory {
  readonly descendantCalls: Array<{ rootSessionId: string; signal: AbortSignal | undefined }> = []
  readonly childCalls: Array<{ parentSessionId: string; signal: AbortSignal | undefined }> = []
  /** Parent ids whose catalog was read, in order (native releases each first). */
  readonly catalogReads: string[] = []
  /** Whole-listing failure with a native code (`SESSION_QUERY_SESSION_NOT_FOUND`, …). */
  fail: Error | undefined
  /** Per-branch catalog failure with a native code (`corrupt`/`unavailable`). */
  readonly branchFailures = new Map<string, Error>()
  /** Last-mile rewrite: models a partial, older or hostile service. */
  mapRows: ((rows: RawRow[]) => unknown[]) | undefined
  private readonly world: FakeSessionWorld

  constructor(world: FakeSessionWorld) {
    this.world = world
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
      let children: unknown[]
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
      for (const child of [...children].reverse()) {
        const raw = child as RawRow
        stack.push({ entry: raw, parentId: id, depth: depth + 1 })
      }
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

/** Native-shaped test double: discovery plus the recorded mutation surface. */
class FakeNativeSubagents extends FakeSubagentsService {
  readonly directory: FakeSubagentDirectory

  constructor(world: FakeSessionWorld) {
    super()
    this.directory = new FakeSubagentDirectory(world)
  }

  listChildren(parentSessionId: string, signal?: AbortSignal): Promise<unknown[]> {
    return this.directory.listChildren(parentSessionId, signal)
  }

  listDescendants(rootSessionId: string, signal?: AbortSignal): Promise<unknown[]> {
    return this.directory.listDescendants(rootSessionId, signal)
  }
}

function catalogValue(children: Array<[string, ChildMode, string?]>): unknown[] {
  return children.map(([id, mode, label], index) => ({
    id,
    mode,
    ...(label === undefined ? {} : { label }),
    createdAt: 1000 + index,
  }))
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
}

async function harness(options: {
  children?: Array<[string, ChildMode, string?]>
  setup?: (world: FakeSessionWorld, host: FakeDshHost, subagents: FakeNativeSubagents) => void
  attachSubagents?: boolean
} = {}): Promise<Harness> {
  const host = new FakeDshHost()
  const agents = new FakeAgentRegistry()
  const world = new FakeSessionWorld().attach(host)
  const subagents = new FakeNativeSubagents(world)
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
  options.setup?.(world, host, subagents)
  if (options.attachSubagents !== false && host.get('subagents') === undefined) subagents.attach(host)
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
  return { host, agents, world, subagents, backend, events, warnings, info }
}

function childSession(
  world: FakeSessionWorld,
  options: {
    id: string
    parent?: string
    mode?: 'one-shot' | 'continuable'
    label?: string
    catalog?: Array<[string, ChildMode, string?]>
    createdAt?: number
    live?: boolean
  },
): void {
  world.add({
    id: options.id,
    createdAt: options.createdAt ?? 2,
    parentSession: options.parent ?? ROOT,
    origin: 'subagent',
    delegationDepth: 1,
    live: options.live ?? false,
    events: (options.catalog ?? []).map(([id, mode, label]) => fakeCatalogEvent(id, mode, label) as FakeSessionEvent),
    projections: {
      ...(options.mode === undefined
        ? {}
        : { subagent: { mode: options.mode, ...(options.label === undefined ? {} : { label: options.label }), seq: 0 } }),
      subagentTiming: { settledMs: 0 },
      subagentCatalog: catalogValue(options.catalog ?? []),
    },
  })
}

function lastSnapshot(events: readonly BackendEvent[]): SubagentSnapshot | undefined {
  let snapshot: SubagentSnapshot | undefined
  for (const event of events) if (event.type === 'subagents') snapshot = event.value
  return snapshot
}

async function until(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}

test('the tree comes from one native descendant listing, in native pre-order', async () => {
  const h = await harness({
    children: [
      ['child-b', 'continuable', 'second'],
      ['child-a', 'continuable', 'first'],
    ],
    setup: (world) => {
      // Catalog order is b then a: native owns that order, not the adapter.
      childSession(world, { id: 'child-b', mode: 'continuable', label: 'second', catalog: [['grand-b', 'one-shot', 'gb']] })
      childSession(world, { id: 'child-a', mode: 'continuable', label: 'first' })
      childSession(world, { id: 'grand-b', parent: 'child-b', mode: 'one-shot', label: 'gb' })
    },
  })

  const snapshot = h.info.subagents
  assert.ok(snapshot, 'SessionInfo carries the native tree')
  assert.deepEqual(snapshot.entries.map(entry => entry.id), ['child-b', 'grand-b', 'child-a'], 'native pre-order, catalog order preserved')
  assert.equal(snapshot.entries[1].parentSessionId, 'child-b', 'the row carries its catalog parent')
  assert.equal(snapshot.truncated, undefined, 'a complete readable tree is not truncated')

  assert.equal(h.subagents.directory.descendantCalls.length, 1, 'exactly one native listing per refresh')
  assert.equal(h.subagents.directory.descendantCalls[0].rootSessionId, ROOT)
  assert.ok(h.subagents.directory.descendantCalls[0].signal instanceof AbortSignal, 'the root epoch signal is forwarded')
  assert.deepEqual(h.subagents.directory.childCalls, [], 'the tree never repeats the native walk with listChildren')
  assert.deepEqual(
    h.subagents.directory.catalogReads.slice().sort(),
    ['child-a', 'child-b', 'grand-b', ROOT],
    'native read every reachable catalog itself (no adapter recursion)',
  )
  assert.equal(h.agents.createCalls.length, 0, 'discovery materializes no child Agent')
  assert.equal(h.agents.resumeCalls.length, 1, 'only the root resume ran')
})

test('per-row projections still come from one released observation per local child', async () => {
  let observations = 0
  let disposals = 0
  const h = await harness({
    children: [
      ['child-a', 'continuable', 'task'],
      ['child-ext', 'external', 'remote'],
    ],
    setup: (world, host) => {
      childSession(world, { id: 'child-a', mode: 'continuable', label: 'task' })
      const query = host.get('sessionQuery') as Record<string, unknown>
      const original = query.observeSession as (id: string, options?: unknown) => Promise<Record<string, unknown>>
      query.observeSession = async (id: string, options?: unknown) => {
        observations += 1
        const observation = await original(id, options)
        const wrapped = Object.create(observation) as Record<string, unknown>
        Object.defineProperty(wrapped, Symbol.dispose, {
          value: () => {
            disposals += 1
          },
          enumerable: false,
        })
        return wrapped
      }
    },
  })

  const entries = h.info.subagents?.entries ?? []
  assert.deepEqual(entries.map(entry => entry.id), ['child-a', 'child-ext'])
  assert.equal(entries[0].mode, 'continuable', 'the child identity projection is folded')
  assert.equal(entries[0].local, true)
  assert.equal(entries[1].mode, 'external')
  assert.equal(entries[1].local, false, 'an external row owns no local Session')
  assert.equal(observations, 1, 'only the local child needed a projection observation')
  assert.equal(disposals, 1, 'the observation lease was released')
})

test('a complete empty catalog is an authoritative empty tree; a failed read is not', async () => {
  const empty = await harness({ children: [] })
  assert.deepEqual(empty.info.subagents, { entries: [] }, 'a readable empty directory is complete')
  assert.equal(empty.subagents.directory.descendantCalls.length, 1)

  const failed = await harness({
    children: [['child-a', 'continuable', 'task']],
    setup: (world, _host, subagents) => {
      childSession(world, { id: 'child-a', mode: 'continuable', label: 'task' })
      subagents.directory.fail = listingFailure('session "root-session" not found', 'SESSION_QUERY_SESSION_NOT_FOUND')
    },
  })
  assert.equal(failed.info.subagents, undefined, 'an unreadable root is unavailable, never an empty tree')
  assert.equal(lastSnapshot(failed.events), undefined, 'no empty snapshot was published')
  assert.ok(
    failed.warnings.some(message => message.includes('native subagent tree could not be refreshed')),
    'the failure is reported as a diagnostic',
  )
  assert.ok(failed.info.capabilities.includes('subagents'), 'a transient read failure does not revoke the mounted service')
})

test('branch diagnostics stay incomplete: only unsupported mode keeps traversal', async () => {
  const h = await harness({
    children: [
      ['ok-child', 'continuable', 'ok'],
      ['gone-child', 'continuable', 'gone'],
      ['corrupt-child', 'continuable', 'corrupt'],
      ['odd-child', 'unknown', 'odd'],
    ],
    setup: (world, _host, subagents) => {
      childSession(world, { id: 'ok-child', mode: 'continuable', label: 'ok' })
      // `gone-child` has no readable session at all.
      childSession(world, { id: 'corrupt-child', mode: 'continuable', label: 'corrupt' })
      subagents.directory.branchFailures.set('corrupt-child', listingFailure('conflicting sources', 'SESSION_QUERY_CORRUPT_SESSION'))
      childSession(world, {
        id: 'odd-child',
        mode: 'continuable',
        label: 'odd',
        catalog: [['odd-grand', 'one-shot', 'og']],
      })
      childSession(world, { id: 'odd-grand', parent: 'odd-child', mode: 'one-shot', label: 'og' })
    },
  })

  const entries = h.info.subagents?.entries ?? []
  assert.deepEqual(entries.map(entry => entry.id), ['ok-child', 'gone-child', 'corrupt-child', 'odd-child', 'odd-grand'])
  assert.equal(h.info.subagents?.truncated, true, 'incomplete branches are reported')

  const gone = entries.find(entry => entry.id === 'gone-child')
  assert.ok(gone)
  assert.equal(gone.mode, 'unknown', 'an unreadable branch keeps an honest unknown mode')
  assert.equal(gone.status, 'unknown', 'no status is invented')
  assert.equal(gone.local, undefined, 'neither a local Session nor an external leaf is claimed')
  assert.equal(gone.parentSessionId, ROOT)

  const odd = entries.find(entry => entry.id === 'odd-child')
  assert.equal(odd?.mode, 'unknown', 'an unsupported catalog mode stays unknown')
  assert.ok(entries.some(entry => entry.id === 'odd-grand'), 'an unsupported mode row is still traversed natively')
  assert.equal(entries.find(entry => entry.id === 'odd-grand')?.parentSessionId, 'odd-child')

  // No diagnostic row is ever exposed as a continuable or external child.
  for (const id of ['gone-child', 'corrupt-child', 'odd-child']) {
    const entry = entries.find(candidate => candidate.id === id)
    assert.ok(entry)
    assert.notEqual(entry.mode, 'continuable')
    assert.notEqual(entry.mode, 'external')
  }
})

test('diagnostics travel on the snapshot as validated metadata only', async () => {
  const host = new FakeDshHost()
  const world = new FakeSessionWorld().attach(host)
  const subagents = new FakeNativeSubagents(world)
  subagents.attach(host)
  world.add({
    id: ROOT,
    live: true,
    events: [fakeCatalogEvent('gone-child', 'continuable', 'gone') as FakeSessionEvent],
    projections: { subagentCatalog: catalogValue([['gone-child', 'continuable', 'gone']]) },
  })
  const bridge = new SubagentBridge({ host, emit: () => {}, warn: () => {} })
  assert.equal(bridge.available(), true, 'a mounted native listing is usable enumeration')
  bridge.setRoot(ROOT)
  const snapshot = await bridge.snapshotForRoot(ROOT)
  assert.deepEqual(snapshot?.entries.map(entry => entry.id), ['gone-child'])
  const expected: readonly SubagentBranchDiagnostic[] = [
    { id: 'gone-child', parentSessionId: ROOT, depth: 1, reason: 'unavailable' },
  ]
  assert.deepEqual(snapshot?.diagnostics, expected, 'the snapshot carries the metadata')
  assert.deepEqual(bridge.branchDiagnostics(), expected, 'the direct read face agrees')
  assert.equal(JSON.stringify(snapshot).includes('not found'), false, 'no raw native error text is on the wire')
  bridge.close()
})

test('a native diagnostic never demotes an already-valid child row', async () => {
  const h = await harness({
    children: [['child-a', 'continuable', 'task']],
    setup: (world, _host, subagents) => {
      childSession(world, { id: 'child-a', mode: 'continuable', label: 'task' })
      // A contradictory service returns the child row AND a diagnostic for it,
      // then only a diagnostic for another candidate.
      subagents.directory.mapRows = rows => [
        ...rows,
        { kind: 'diagnostic', id: 'child-a', parentId: ROOT, depth: 1, reason: 'unavailable' },
        { kind: 'diagnostic', id: 'lonely', parentId: ROOT, depth: 1, reason: 'corrupt' },
      ]
    },
  })
  const entries = h.info.subagents?.entries ?? []
  const child = entries.find(entry => entry.id === 'child-a')
  assert.ok(child, 'the valid child row survives')
  assert.equal(child.mode, 'continuable', 'the diagnostic never rewrites the mode')
  assert.equal(child.local, true, 'the diagnostic never withdraws local proof')
  assert.equal(child.label, 'task', 'the diagnostic never erases the label')

  const lonely = entries.find(entry => entry.id === 'lonely')
  assert.ok(lonely, 'a diagnostic-only candidate stays visible as read-only metadata')
  assert.equal(lonely.mode, 'unknown')
  assert.equal(lonely.local, undefined, 'no local/external/continuable proof is invented')
  assert.equal(h.info.subagents?.truncated, true)

  // A value frame from the unreadable branch must not upgrade the candidate.
  h.world.add({
    id: 'lonely',
    parentSession: ROOT,
    origin: 'subagent',
    delegationDepth: 1,
    events: [],
    projections: { subagent: { mode: 'continuable', label: 'sneaky', seq: 0 } },
  })
  h.world.setProjection('lonely', 'subagent', { mode: 'continuable', label: 'sneaky', seq: 0 })
  await new Promise<void>(resolve => setTimeout(resolve, 40))
  const reAnnounced = await h.backend.connect()
  const afterFrame = reAnnounced.subagents?.entries.find(entry => entry.id === 'lonely')
  assert.ok(afterFrame !== undefined)
  assert.equal(afterFrame.mode, 'unknown', 'the diagnostic row stays unknown after a live identity frame')
  assert.equal(afterFrame.label, undefined, 'the diagnostic row never gains the branch label')

  // The UI reply/stop gates inherit the native union: nothing continuable here.
  await assert.rejects(
    h.backend.command('subagent-prompt', { sessionId: 'lonely', text: 'x' }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
  )
  assert.equal(h.subagents.directory.descendantCalls.length, 1, 'the contradiction needed no extra listing')
})

test('malformed, duplicate and cyclic rows are rejected or kept honestly', async () => {
  const h = await harness({
    children: [
      ['child-a', 'continuable', 'task'],
      ['child-b', 'continuable', 'other'],
    ],
    setup: (world, _host, subagents) => {
      childSession(world, { id: 'child-a', mode: 'continuable', label: 'task' })
      childSession(world, { id: 'child-b', mode: 'continuable', label: 'other' })
      subagents.directory.mapRows = rows => [
        ...rows,
        { kind: 'child', id: 'no-parent' },
        { kind: 'child', id: 'no-depth', parentId: ROOT },
        { kind: 'child', id: 'mystery-mode', parentId: ROOT, depth: 1, mode: 'mystery' },
        { kind: 'diagnostic', id: 'bad-reason', parentId: ROOT, depth: 1, reason: 'because' },
        // A duplicate of a real row and a cycle back to the root itself.
        { kind: 'child', id: 'child-a', parentId: ROOT, depth: 1, mode: 'continuable', label: 'task' },
        { kind: 'child', id: ROOT, parentId: 'child-a', depth: 2, mode: 'continuable' },
      ]
    },
  })

  const entries = h.info.subagents?.entries ?? []
  assert.deepEqual(entries.map(entry => entry.id), ['child-a', 'child-b'], 'malformed and repeated ids never add rows')
  assert.equal(entries.some(entry => entry.id === 'mystery-mode'), false, 'an unvalidatable mode is not invented as a child')
  assert.equal(h.info.subagents?.truncated, true, 'rejected rows make the listing incomplete')
  assert.ok(
    h.warnings.some(message => message.includes('unusable row')),
    'rejected rows are reported as a diagnostic',
  )
})

test('external rows are leaves; presentation bounds cut deep and over-limit trees', async () => {
  const external = await harness({
    children: [['child-ext', 'external', 'remote']],
    setup: (world) => {
      // An external execution has no local Session; even a stray catalog is not traversed.
      childSession(world, { id: 'child-ext', mode: 'continuable', label: 'remote', catalog: [['ghost', 'one-shot', 'g']] })
      childSession(world, { id: 'ghost', parent: 'child-ext', mode: 'one-shot', label: 'g' })
    },
  })
  assert.deepEqual(external.info.subagents?.entries.map(entry => entry.id), ['child-ext'], 'external is a native leaf')
  assert.equal(external.info.subagents?.entries[0].local, false)
  assert.equal(external.info.subagents?.truncated, undefined, 'a leaf is complete, not truncated')

  const chain: Array<[string, ChildMode, string?]> = []
  for (let depth = 1; depth <= 12; depth += 1) chain.push([`deep-${depth}`, 'continuable', `d${depth}`])
  const deep = await harness({
    children: [chain[0]],
    setup: (world) => {
      for (let depth = 1; depth <= 12; depth += 1) {
        childSession(world, {
          id: `deep-${depth}`,
          parent: depth === 1 ? ROOT : `deep-${depth - 1}`,
          mode: 'continuable',
          label: `d${depth}`,
          catalog: depth < 12 ? [chain[depth]] : [],
        })
      }
    },
  })
  const deepIds = deep.info.subagents?.entries.map(entry => entry.id) ?? []
  assert.equal(deepIds.length, 8, 'the UI depth bound is 8')
  assert.equal(deepIds.at(-1), 'deep-8')
  assert.equal(deep.info.subagents?.truncated, true, 'a cut branch is incomplete')

  const wide: Array<[string, ChildMode, string?]> = []
  for (let index = 0; index < 205; index += 1) wide.push([`wide-${index}`, 'continuable'])
  const limit = await harness({
    children: wide,
    setup: (world) => {
      for (const [id] of wide) childSession(world, { id, mode: 'continuable' })
    },
  })
  assert.equal(limit.info.subagents?.entries.length, 200, 'the UI row bound is 200')
  assert.equal(limit.info.subagents?.truncated, true, 'rows beyond the bound are incomplete')
})

test('cancellation aborts the native listing and discards late results', async () => {
  const h = await harness({
    children: [['child-a', 'continuable', 'task']],
    setup: (world) => {
      childSession(world, { id: 'child-a', mode: 'continuable', label: 'task' })
    },
  })
  let release: (() => void) | undefined
  let heldSignal: AbortSignal | undefined
  const original = h.subagents.directory.listDescendants.bind(h.subagents.directory)
  h.subagents.directory.listDescendants = async (rootSessionId: string, signal?: AbortSignal) => {
    heldSignal = signal
    await new Promise<void>(resolve => {
      release = resolve
    })
    return await original(rootSessionId, signal)
  }
  const before = h.events.length
  // One native projection frame schedules the debounced refresh that now blocks.
  h.world.setProjection(ROOT, 'subagentCatalog', catalogValue([['child-a', 'continuable', 'task']]))
  await until(() => heldSignal !== undefined, 'the held listing call')
  assert.equal(heldSignal?.aborted, false, 'the root epoch signal is live')
  // Let the post-`ready` publish settle before measuring the late-result window.
  await new Promise<void>(resolve => setTimeout(resolve, 40))
  const afterSettle = h.events.length
  await h.backend.close()
  assert.equal(heldSignal?.aborted, true, 'closing the bridge aborts in-flight native reads')
  release?.()
  await new Promise<void>(resolve => setTimeout(resolve, 40))
  assert.equal(
    h.events.slice(afterSettle).filter(event => event.type === 'subagents' || event.type === 'subagent').length,
    0,
    'a late listing publishes nothing',
  )
  assert.ok(afterSettle >= before)
})

test('control membership reads the exact direct-parent catalog, not the display throttle', async () => {
  const h = await harness({ children: [] })
  const empty = h.info.subagents
  assert.deepEqual(empty, { entries: [] })

  // A real, freshly cataloged continuable child whose row is NOT in the display
  // cache yet (no projection frame, no debounced refresh).
  h.world.add({
    id: 'late-child',
    parentSession: ROOT,
    origin: 'subagent',
    delegationDepth: 1,
    events: [],
    projections: { subagent: { mode: 'continuable', label: 'late', seq: 0 }, subagentTiming: { settledMs: 0 } },
  })
  h.world.setProjections(ROOT, { subagentCatalog: catalogValue([['late-child', 'continuable', 'late']]) })
  h.subagents.directory.childCalls.length = 0

  const receipt = await h.backend.command('subagent-prompt', { sessionId: 'late-child', text: 'again' }) as { messageId: string }
  assert.equal(receipt.messageId, 'fake-subagent-prompt-1', 'native admission, no local state')
  assert.equal(h.subagents.promptCalls.length, 1, 'the prompt reached the native service')
  assert.deepEqual(
    {
      parentSessionId: h.subagents.promptCalls[0].parentSessionId,
      childSessionId: h.subagents.promptCalls[0].childSessionId,
      mode: h.subagents.promptCalls[0].mode,
    },
    { parentSessionId: ROOT, childSessionId: 'late-child', mode: 'continuable' },
    'the exact durable direct parent, resolved from the native catalog row',
  )
  assert.deepEqual(h.subagents.directory.childCalls.map(call => call.parentSessionId), [ROOT], 'one exact direct-parent read')
  assert.equal(
    h.info.subagents?.entries.some(entry => entry.id === 'late-child'),
    false,
    'the display cache was not the authorization source',
  )
})

test('control membership never crosses trees and never authorizes an unreadable root', async () => {
  const h = await harness({
    children: [['child-a', 'continuable', 'task']],
    setup: (world) => {
      childSession(world, { id: 'child-a', mode: 'continuable', label: 'task' })
      // Same-tree descendant, other-tree child, and a bidi-style self-parent.
      childSession(world, { id: 'child-a-child', parent: 'child-a', mode: 'continuable', label: 'nested' })
      childSession(world, { id: 'other-root-child', parent: 'other-root', mode: 'continuable', label: 'elsewhere' })
      world.add({ id: 'other-root', createdAt: 3, events: [], projections: { subagentCatalog: catalogValue([['other-root-child', 'continuable', 'elsewhere']]) } })
      world.add({ id: 'self-parent', parentSession: 'self-parent', origin: 'subagent', events: [] })
    },
  })

  await assert.rejects(
    h.backend.command('subagent-prompt', { sessionId: 'other-root-child', text: 'x' }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
    'another root\'s child is not continuable here',
  )
  await assert.rejects(
    h.backend.command('subagent-prompt', { sessionId: 'self-parent', text: 'x' }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
    'a lineage cycle proves nothing',
  )
  await assert.rejects(
    h.backend.command('subagent-interrupt', { sessionId: ROOT }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
    'the current root is never a child',
  )
  await assert.rejects(
    h.backend.command('subagent-prompt', { sessionId: 'child-a-child', text: 'x' }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT',
    'a nested child is a real member whose mode is not the display cache\'s business; prompt requires continuable proof',
  )
  assert.equal(h.subagents.promptCalls.length, 0, 'no native prompt ran for a rejected target')
})

test('live projection frames update rows without another native listing', async () => {
  const h = await harness({
    children: [['child-a', 'continuable', 'task']],
    setup: (world) => {
      childSession(world, { id: 'child-a', mode: 'continuable', label: 'task' })
    },
  })
  const listings = h.subagents.directory.descendantCalls.length
  const before = h.events.length
  h.world.setProjection('child-a', 'tokenUsage', { uncachedInputTokens: 5, outputTokens: 7 })
  const published = (): boolean => h.events.slice(before).some(event => event.type === 'subagent'
    ? event.value.totalTokens === 12
    : event.type === 'subagents' && event.value.entries.some(entry => entry.totalTokens === 12))
  await until(published, 'the token frame')
  assert.equal(h.subagents.directory.descendantCalls.length, listings, 'a value-only frame re-lists nothing')
})

test('a composition without usable native enumeration advertises nothing', async () => {
  const missing = await harness({ children: [['child-a', 'continuable', 'task']], attachSubagents: false })
  assert.equal(missing.info.capabilities.includes('subagents'), false)
  assert.equal(missing.info.capabilities.includes('subagent-session'), false)
  assert.equal(missing.info.capabilities.includes('subagent-prompt'), false)
  assert.equal(missing.info.subagents, undefined)
  await assert.rejects(
    missing.backend.command('subagent-session', { sessionId: 'child-a' }),
    (error: unknown) => (error as { code?: string }).code === 'CAPABILITY_UNAVAILABLE',
  )

  // A manager-less / older service that cannot enumerate is not usable either.
  const legacy = await harness({
    children: [['child-a', 'continuable', 'task']],
    setup: (_world, host) => {
      host.use('subagents', { prompt: async () => ({ messageId: 'never' }), interrupt: () => {} })
    },
  })
  assert.equal(legacy.info.capabilities.includes('subagents'), false, 'mutation methods alone do not advertise reads')
  assert.equal(legacy.info.capabilities.includes('subagent-prompt'), false)
  assert.equal(legacy.info.subagents, undefined)

  // Native proof that the catalog projection is not registered closes the tree.
  const broken = await harness({
    children: [['child-a', 'continuable', 'task']],
    setup: (_world, _host, subagents) => {
      subagents.directory.fail = listingFailure(
        'listing subagents requires the registered subagentCatalog projection',
        'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE',
      )
    },
  })
  assert.equal(broken.info.subagents, undefined)
  await assert.rejects(
    broken.backend.command('subagent-session', { sessionId: 'child-a' }),
    (error: unknown) => (error as { code?: string }).code === 'CAPABILITY_UNAVAILABLE',
    'a composition-level listing failure stays closed instead of failing open',
  )
  assert.ok(
    broken.warnings.some(message => message.includes('SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE')),
    'the exact native code is the diagnostic',
  )
})