/**
 * Offline contract tests for two subagent-bridge read-path guards.
 *
 * 1. `snapshotForRoot` must return the same fresh projection of the current
 *    root on every success branch: joining an in-flight refresh may not serve
 *    the cache object captured before that refresh settled, nor another root's
 *    cache, nor `undefined` merely because the joined refresh skipped publish.
 * 2. The display refresh reads cold child projections through bounded parallel
 *    native observation leases, not one 5s deadline per child serially. Native
 *    catalog order, per-read cancellation/disposal and deterministic
 *    diagnostics stay intact.
 *
 * Every fact is a synthetic Cordis host: no profile, credential, real session,
 * Agent creation/resume, model request, network call or terminal is touched.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SubagentBridge } from '../src/backend/subagents.ts'
import {
  FakeDshHost,
  FakeSessionWorld,
  fakeCatalogEvent,
  type FakeSessionEvent,
} from '../src/backend/testing.ts'

const ROOT = 'root-session'
const OTHER_ROOT = 'root-two'
/** Chosen small bound: enough overlap to matter, far below a 200-row tree. */
const EXPECTED_MAX_CONCURRENT_READS = 8

type RawRow = Record<string, unknown>

function listingFailure(message: string, code: string): Error {
  const error = new Error(message)
  error.name = 'SubagentError'
  Object.assign(error, { code })
  return error
}

function catalogValue(children: Array<[string, string?]>): unknown[] {
  return children.map(([id, label], index) => ({
    id,
    mode: 'continuable',
    ...(label === undefined ? {} : { label }),
    createdAt: 1000 + index,
  }))
}

/** One direct-child row per synthetic `subagentCatalog` entry, in native order. */
class DirectDirectory {
  readonly calls: string[] = []
  /** Hold exactly one listing until the test (or the epoch signal) releases it. */
  private hold: { readonly root: string; readonly settle: (value: void | PromiseLike<void>) => void; readonly promise: Promise<void> } | undefined
  fail: Error | undefined
  private readonly world: FakeSessionWorld

  constructor(world: FakeSessionWorld) {
    this.world = world
  }

  attach(host: FakeDshHost): this {
    host.use('subagents', this)
    return this
  }

  /** Hold the next listing for `root`; the epoch abort also releases it. */
  holdNext(root: string): Promise<void> {
    let settle: (value: void | PromiseLike<void>) => void = () => {}
    const promise = new Promise<void>(resolve => { settle = resolve })
    this.hold = { root, settle, promise }
    return promise
  }

  releaseHeld(): void {
    const hold = this.hold
    this.hold = undefined
    hold?.settle()
  }

  async listDescendants(rootSessionId: string, signal?: AbortSignal): Promise<unknown[]> {
    this.calls.push(rootSessionId)
    const hold = this.hold
    if (hold !== undefined && hold.root === rootSessionId) {
      this.hold = undefined
      if (signal?.aborted === true) hold.settle()
      else signal?.addEventListener('abort', () => hold.settle(), { once: true })
      await hold.promise
    }
    if (this.fail !== undefined) throw this.fail
    const catalog = this.world.valuesOf(rootSessionId).subagentCatalog
    if (!Array.isArray(catalog)) {
      throw listingFailure('listing subagents requires the registered subagentCatalog projection', 'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE')
    }
    return catalog.map(row => {
      const item = row as RawRow
      return {
        kind: 'child',
        id: String(item.id),
        parentId: rootSessionId,
        depth: 1,
        mode: String(item.mode),
        ...(typeof item.label === 'string' ? { label: item.label } : {}),
      }
    })
  }
}

interface Harness {
  readonly host: FakeDshHost
  readonly world: FakeSessionWorld
  readonly directory: DirectDirectory
  readonly warnings: string[]
  readonly bridge: SubagentBridge
}

function addChild(world: FakeSessionWorld, id: string, parent = ROOT, live = false, label = id): void {
  world.add({
    id,
    createdAt: 10,
    parentSession: parent,
    origin: 'subagent',
    delegationDepth: 1,
    live,
    events: [],
    projections: { subagent: { mode: 'continuable', label, seq: 0 } },
  })
}

function makeRoot(world: FakeSessionWorld, root: string, children: Array<[string, string?]>, live = true): void {
  world.add({
    id: root,
    createdAt: 1,
    live,
    events: children.map(([id, label]) => fakeCatalogEvent(id, 'continuable', label) as FakeSessionEvent),
    projections: { subagentCatalog: catalogValue(children) },
  })
}

function harness(options: {
  readonly children: Array<[string, string?]>
  /** Which children `ctx.sessions.get` resolves (resident rows, no lease). */
  readonly resident?: readonly string[]
  readonly setup?: (h: { host: FakeDshHost; world: FakeSessionWorld; directory: DirectDirectory }) => void
}): Harness {
  const host = new FakeDshHost()
  const world = new FakeSessionWorld().attach(host)
  const directory = new DirectDirectory(world).attach(host)
  makeRoot(world, ROOT, options.children)
  for (const [id, label] of options.children) {
    addChild(world, id, ROOT, options.resident?.includes(id) === true, label)
  }
  const warnings: string[] = []
  const bridge = new SubagentBridge({ host, emit: () => {}, warn: message => warnings.push(message) })
  bridge.setRoot(ROOT)
  options.setup?.({ host, world, directory })
  return { host, world, directory, warnings, bridge }
}

async function until(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>(resolve => setTimeout(resolve, 2))
  }
  assert.fail(`timed out waiting for ${label}`)
}

function flush(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve))
}

/** Controlled native observations: every lease waits for an explicit release. */
interface ControlledObservations {
  readonly starts: string[]
  readonly disposals: string[]
  readonly maxActive: number
  readonly active: number
  takePending(): Array<() => void>
  releaseAll(reverse?: boolean): void
}

function controlObservations(host: FakeDshHost, world: FakeSessionWorld): ControlledObservations {
  const real = world.sessionQuery
  const starts: string[] = []
  const disposals: string[] = []
  const pending: Array<() => void> = []
  let active = 0
  let maxActive = 0
  host.use('sessionQuery', {
    ...real,
    observeSession: (id: string, options?: { readonly signal?: AbortSignal; readonly projectionMode?: 'all' | 'none' }) => {
      starts.push(id)
      active += 1
      if (active > maxActive) maxActive = active
      return (async () => {
        const observation = await real.observeSession(id, options) as Record<string, unknown>
        const lease = Object.create(observation) as Record<string, unknown>
        Object.defineProperty(lease, Symbol.dispose, {
          value: () => { disposals.push(id) },
          enumerable: false,
        })
        await new Promise<void>(resolve => {
          pending.push(() => {
            active -= 1
            resolve()
          })
        })
        return lease
      })()
    },
  })
  return {
    starts,
    disposals,
    get maxActive(): number { return maxActive },
    get active(): number { return active },
    takePending: () => pending.splice(0),
    releaseAll(reverse = false): void {
      const batch = pending.splice(0)
      for (const release of reverse ? batch.reverse() : batch) release()
    },
  }
}

// ------------------------------------------------- 1. snapshotForRoot branches

test('concurrent snapshotForRoot callers all receive the same fresh snapshot', async () => {
  const h = harness({ children: [['child-a', 'task']] })
  // No `announce` yet: the refresh cannot publish, so only the projection path
  // can serve the joined caller. The pre-fix branch returned the still-empty
  // `cache` while the first caller produced a full snapshot.
  const first = h.bridge.snapshotForRoot(ROOT)
  const second = h.bridge.snapshotForRoot(ROOT)
  const [a, b] = await Promise.all([first, second])
  assert.ok(a, 'the refreshing caller reads the tree')
  assert.ok(b, 'a caller that joined the refresh also reads it')
  assert.deepEqual(b?.entries.map(entry => entry.id), ['child-a'])
  assert.deepEqual(a, b, 'both callers see the same projection')
  assert.deepEqual(h.directory.calls, [ROOT], 'joining callers share one native listing')

  // An event-driven value frame mutates bridge state synchronously, before any
  // debounced publish: the next read must project the new label, not a cache
  // object captured earlier.
  h.bridge.noteProjection({ id: 'child-a' }, 'subagent', { mode: 'continuable', label: 'renamed', seq: 1 })
  const updated = await h.bridge.snapshotForRoot(ROOT)
  assert.equal(updated?.entries[0]?.label, 'renamed', 'event-driven updates are visible on the next read')
  h.bridge.close()
})

test('joining a refresh for the previous root reads the new root instead of an empty cache', async () => {
  const h = harness({ children: [['child-a', 'task']] })
  h.directory.holdNext(ROOT)
  const oldRoot = h.bridge.snapshotForRoot(ROOT)
  await until(() => h.directory.calls.length === 1, 'the held old-root listing')

  // Reattach while the old listing is still open. The waiting caller must not
  // treat the old epoch's absent cache as the new root's answer.
  h.world.add({
    id: OTHER_ROOT,
    createdAt: 2,
    live: true,
    events: [fakeCatalogEvent('child-b', 'continuable', 'two') as FakeSessionEvent],
    projections: { subagentCatalog: catalogValue([['child-b', 'two']]) },
  })
  addChild(h.world, 'child-b', OTHER_ROOT, false, 'two')
  h.bridge.setRoot(OTHER_ROOT)
  const newRoot = h.bridge.snapshotForRoot(OTHER_ROOT)

  h.directory.releaseHeld()
  assert.equal(await oldRoot, undefined, 'the old epoch is discarded')
  const fresh = await newRoot
  assert.ok(fresh, 'the new root is read after the old refresh settled')
  assert.deepEqual(fresh?.entries.map(entry => entry.id), ['child-b'], 'no cache from the old root leaks')
  assert.deepEqual(h.directory.calls, [ROOT, OTHER_ROOT], 'the new root owns a fresh native listing')
  h.bridge.close()
})

test('a failed refresh is not reported as a successful empty tree; a retry recovers', async () => {
  const h = harness({ children: [['child-a', 'task']] })
  h.directory.fail = new Error('transient native listing failure')
  assert.equal(await h.bridge.snapshotForRoot(ROOT), undefined, 'the failure is not an empty tree')
  assert.equal(await h.bridge.snapshotForRoot(ROOT), undefined, 'a repeated failure stays unavailable')
  h.directory.fail = undefined
  const recovered = await h.bridge.snapshotForRoot(ROOT)
  assert.deepEqual(recovered?.entries.map(entry => entry.id), ['child-a'])
  h.bridge.close()
})

test('close settles concurrent snapshotForRoot callers without a snapshot', async () => {
  const h = harness({ children: [['child-a', 'task']] })
  h.directory.holdNext(ROOT)
  const first = h.bridge.snapshotForRoot(ROOT)
  await until(() => h.directory.calls.length === 1, 'the held listing')
  const second = h.bridge.snapshotForRoot(ROOT)
  h.bridge.close()
  h.directory.releaseHeld()
  assert.equal(await first, undefined)
  assert.equal(await second, undefined)
})

// ------------------------------------------------ 2. bounded parallel reads

test('cold rows are read in bounded parallel batches, preserving native order', async () => {
  const children: Array<[string, string?]> = Array.from({ length: 12 }, (_, index) => [`child-${index + 1}`, `task-${index + 1}`])
  const h = harness({ children })
  const observed = controlObservations(h.host, h.world)
  const pending = h.bridge.snapshotForRoot(ROOT)

  await until(() => observed.starts.length === EXPECTED_MAX_CONCURRENT_READS, 'the first bounded batch')
  assert.deepEqual(
    observed.starts,
    children.slice(0, EXPECTED_MAX_CONCURRENT_READS).map(([id]) => id),
    'the batch starts in native catalog order',
  )
  assert.ok(observed.maxActive > 1, 'reads really overlap')
  assert.ok(observed.maxActive <= EXPECTED_MAX_CONCURRENT_READS, `never more than the small cap (${observed.maxActive})`)

  // Complete the first batch in reverse order: output order must not depend on
  // completion order.
  observed.releaseAll(true)
  await until(() => observed.starts.length === children.length, 'the second batch')
  assert.equal(observed.starts.length, children.length, 'queued rows restarted after the batch settled')
  observed.releaseAll(true)

  const snapshot = await pending
  assert.deepEqual(snapshot?.entries.map(entry => entry.id), children.map(([id]) => id), 'native order is deterministic')
  assert.equal(snapshot?.truncated, undefined, 'a complete tree is not truncated')
  assert.ok(observed.maxActive <= EXPECTED_MAX_CONCURRENT_READS)
  assert.deepEqual(
    observed.disposals.slice().sort(),
    children.map(([id]) => id).sort(),
    'every parallel lease is released exactly once',
  )
  h.bridge.close()
})

test('one late failing row does not cancel or reorder the batch', async () => {
  const children: Array<[string, string?]> = Array.from({ length: 6 }, (_, index) => [`child-${index + 1}`, `task-${index + 1}`])
  const h = harness({ children })
  const real = h.world.sessionQuery
  const releases = new Map<string, () => void>()
  let started = 0
  h.host.use('sessionQuery', {
    ...real,
    observeSession: (id: string, options?: { readonly signal?: AbortSignal; readonly projectionMode?: 'all' | 'none' }) => {
      started += 1
      return (async () => {
        if (id === 'child-3') {
          await new Promise<void>(resolve => releases.set(id, resolve))
          throw listingFailure('the child session disappeared mid-read', 'SESSION_QUERY_SESSION_NOT_FOUND')
        }
        const observation = await real.observeSession(id, options) as Record<string, unknown>
        const lease = Object.create(observation) as Record<string, unknown>
        Object.defineProperty(lease, Symbol.dispose, { value: () => {}, enumerable: false })
        await new Promise<void>(resolve => releases.set(id, resolve))
        return lease
      })()
    },
  })
  const pending = h.bridge.snapshotForRoot(ROOT)
  await until(() => releases.size === 6, 'all six row reads')
  // Fail the middle row first, then complete the rest in reverse order.
  releases.get('child-3')?.()
  for (const [id, release] of [...releases].reverse()) if (id !== 'child-3') release()

  const snapshot = await pending
  assert.deepEqual(
    snapshot?.entries.map(entry => entry.id),
    children.map(([id]) => id),
    'a failed read never removes a native row or reorders the others',
  )
  assert.equal(snapshot?.truncated, true, 'the failed row marks the tree incomplete')
  assert.equal(
    h.warnings.filter(message => message.includes('"child-3"')).length,
    1,
    'the failure is diagnosed exactly once',
  )
  h.bridge.close()
})

test('a per-read deadline is charged per bounded batch, not per child', async (t) => {
  const children: Array<[string, string?]> = Array.from({ length: 20 }, (_, index) => [`child-${index + 1}`, `task-${index + 1}`])
  const h = harness({ children })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const real = h.world.sessionQuery
    const starts: string[] = []
    // A native read that never settles and ignores its cancellation signal: the
    // adapter's own bounded wait is the only thing that can end the batch.
    h.host.use('sessionQuery', {
      ...real,
      observeSession: (id: string) => {
        starts.push(id)
        return new Promise<Record<string, unknown>>(() => {})
      },
    })
    const pending = h.bridge.snapshotForRoot(ROOT)
    await flush()
    assert.equal(starts.length, EXPECTED_MAX_CONCURRENT_READS, 'only one bounded batch waits on the deadline')

    // Three 5s waves cover all 20 rows; a serial read would need twenty.
    const waveSizes: number[] = []
    for (let wave = 0; wave < 3; wave += 1) {
      t.mock.timers.tick(5_001)
      await flush()
      waveSizes.push(starts.length)
    }
    const snapshot = await pending
    assert.deepEqual(waveSizes, [16, 20, 20], 'each deadline releases the batch and starts the next bounded one')
    assert.equal(snapshot?.entries.length, 20, 'the native rows remain, honestly incomplete')
    assert.equal(snapshot?.truncated, true, 'timed-out rows mark the tree incomplete')
    assert.equal(
      h.warnings.filter(message => message.includes('could not be read')).length,
      20,
      'each timed-out row is diagnosed once, deterministically',
    )
  } finally {
    t.mock.timers.reset()
    h.bridge.close()
  }
})

test('cancelling the epoch settles in-flight reads and starts no further batch', async () => {
  const children: Array<[string, string?]> = Array.from({ length: 12 }, (_, index) => [`child-${index + 1}`, `task-${index + 1}`])
  const h = harness({ children })
  const real = h.world.sessionQuery
  const starts: string[] = []
  h.host.use('sessionQuery', {
    ...real,
    observeSession: (id: string, options?: { readonly signal?: AbortSignal }) => {
      starts.push(id)
      return new Promise<Record<string, unknown>>((_resolve, reject) => {
        const signal = options?.signal
        if (signal === undefined) return
        signal.addEventListener('abort', () => reject(listingFailure('subagent row read cancelled', 'ABORTED')), { once: true })
      })
    },
  })
  const pending = h.bridge.snapshotForRoot(ROOT)
  await until(() => starts.length === EXPECTED_MAX_CONCURRENT_READS, 'the first batch')
  h.bridge.setRoot(OTHER_ROOT)
  assert.equal(await pending, undefined, 'the cancelled read produces no snapshot')
  await flush()
  assert.equal(starts.length, EXPECTED_MAX_CONCURRENT_READS, 'no queued row started after cancellation')
  h.bridge.close()
})

test('resident rows in a parallel mix keep resident cuts and spend no lease', async () => {
  const children: Array<[string, string?]> = Array.from({ length: 10 }, (_, index) => [`child-${index + 1}`, `task-${index + 1}`])
  const resident = children.slice(0, 4).map(([id]) => id)
  const h = harness({ children, resident })
  const observed = controlObservations(h.host, h.world)
  const pending = h.bridge.snapshotForRoot(ROOT)
  await until(() => observed.starts.length === 6, 'the cold batch')
  observed.releaseAll()
  const snapshot = await pending
  assert.deepEqual(snapshot?.entries.map(entry => entry.id), children.map(([id]) => id))
  assert.deepEqual(
    observed.starts,
    children.slice(4).map(([id]) => id),
    'resident rows never take an observation lease, even in a mixed batch',
  )
  assert.equal(snapshot?.truncated, undefined)
  h.bridge.close()
})