/**
 * Offline contract tests for the native subagent control commands.
 *
 * Every fact is a synthetic Cordis host: no profile, credential, real session
 * log, child Agent creation/resume, model request or terminal is touched.
 * `FakeSessionWorld` provides the public read faces and `FakeSubagentsService`
 * records the exact `ctx.subagents.prompt` / `ctx.subagents.interrupt` calls.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshBackend, type DshContextBackend } from '../src/backend/context.ts'
import type { BackendEvent, PromptContentPart, SessionInfo, SubagentSnapshot } from '../src/backend/types.ts'
import {
  FakeAgentRegistry,
  FakeDshHost,
  FakeSessionWorld,
  FakeSubagentsService,
  createFakeAgent,
  fakeCatalogEvent,
  fakeNativeHelpers,
  nextTask,
  type FakeAgentState,
  type FakeSessionEvent,
} from '../src/backend/testing.ts'

const ROOT = 'root-session'
const ROOT_ROUTE = { provider: 'p1', model: 'm1' }
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

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

/** Mirrors `ctx.subagents.listChildren` only (exact direct-parent rows). */
class FakeSubagentCatalog {
  readonly childCalls: Array<{ parentSessionId: string; signal: AbortSignal | undefined }> = []
  private readonly world: FakeSessionWorld

  constructor(world: FakeSessionWorld) {
    this.world = world
  }

  async listChildren(parentSessionId: string, signal?: AbortSignal): Promise<unknown[]> {
    this.childCalls.push({ parentSessionId, signal })
    if (signal?.aborted === true) throw listingFailure('subagent listing was cancelled', 'CANCELLED')
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

/**
 * Native-shaped discovery double plus the recorded mutation surface.
 *
 * It mirrors the public `ctx.subagents.listDescendants` contract only: stable
 * pre-order, per-catalog event order, external leaves, branch diagnostics and
 * one released observation per branch. Production code never walks catalogs.
 */
class FakeNativeSubagents extends FakeSubagentsService {
  readonly directory: FakeSubagentCatalog
  readonly descendantCalls: Array<{ rootSessionId: string; signal: AbortSignal | undefined }> = []
  private readonly world: FakeSessionWorld

  constructor(world: FakeSessionWorld) {
    super()
    this.world = world
    this.directory = new FakeSubagentCatalog(world)
  }

  listChildren(parentSessionId: string, signal?: AbortSignal): Promise<unknown[]> {
    return this.directory.listChildren(parentSessionId, signal)
  }

  async listDescendants(rootSessionId: string, signal?: AbortSignal): Promise<unknown[]> {
    this.descendantCalls.push({ rootSessionId, signal })
    const root = await this.catalog(rootSessionId, signal)
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
        children = modeOfRow(entry) === 'external' ? [] : await this.catalog(id, signal)
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
    return result
  }

  private async catalog(parentSessionId: string, signal: AbortSignal | undefined): Promise<RawRow[]> {
    return await this.directory.listChildren(parentSessionId, signal) as RawRow[]
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

function catalogValue(children: Array<[string, 'one-shot' | 'continuable' | 'external', string?]>): unknown[] {
  return children.map(([id, mode, label], index) => ({
    id,
    mode,
    ...(label === undefined ? {} : { label }),
    createdAt: 1000 + index,
  }))
}

function childSession(
  world: FakeSessionWorld,
  options: {
    id: string
    parent: string
    mode: 'one-shot' | 'continuable'
    label?: string
    catalog?: Array<[string, 'one-shot' | 'continuable' | 'external', string?]>
  },
): void {
  world.add({
    id: options.id,
    createdAt: 2,
    parentSession: options.parent,
    origin: 'subagent',
    delegationDepth: 1,
    live: false,
    events: (options.catalog ?? []).map(([id, mode, label]) => fakeCatalogEvent(id, mode, label) as FakeSessionEvent),
    projections: {
      subagent: { mode: options.mode, ...(options.label === undefined ? {} : { label: options.label }), seq: 0 },
      subagentTiming: { settledMs: 0, lastTurnCompleted: true },
      subagentCatalog: catalogValue(options.catalog ?? []),
    },
  })
}

/**
 * Root tree used by every control test:
 *
 * root-session
 *   ├─ child-c        (continuable, local)
 *   │    └─ nested-c  (continuable, local)
 *   │         └─ deep-one (one-shot, local)
 *   ├─ child-one      (one-shot, local)
 *   └─ child-ext      (external leaf, no local Session)
 */
async function harness(controls = true): Promise<Harness> {
  const host = new FakeDshHost()
  const agents = new FakeAgentRegistry()
  const world = new FakeSessionWorld().attach(host)
  const subagents = new FakeNativeSubagents(world)
  if (controls) subagents.attach(host)
  const warnings: string[] = []
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

  const rootChildren: Array<[string, 'one-shot' | 'continuable' | 'external', string?]> = [
    ['child-c', 'continuable', 'plan'],
    ['child-one', 'one-shot', 'audit'],
    ['child-ext', 'external', 'cloud'],
  ]
  world.add({
    id: ROOT,
    live: true,
    createdAt: 1,
    events: rootChildren.map(([id, mode, label]) => fakeCatalogEvent(id, mode, label) as FakeSessionEvent),
    projections: { subagentCatalog: catalogValue(rootChildren) },
  })
  childSession(world, {
    id: 'child-c',
    parent: ROOT,
    mode: 'continuable',
    label: 'plan',
    catalog: [['nested-c', 'continuable', 'nested']],
  })
  childSession(world, {
    id: 'nested-c',
    parent: 'child-c',
    mode: 'continuable',
    label: 'nested',
    catalog: [['deep-one', 'one-shot', 'deep']],
  })
  childSession(world, { id: 'deep-one', parent: 'nested-c', mode: 'one-shot', label: 'deep' })
  childSession(world, { id: 'child-one', parent: ROOT, mode: 'one-shot', label: 'audit' })

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

/** Let the bridge's debounced post-`ready` publish settle. */
async function settle(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 80))
}

async function until(predicate: () => boolean, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  assert.fail(`timed out waiting for ${label}`)
}

function isCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => (error as { code?: string }).code === code
}

function subagentEvents(events: readonly BackendEvent[]): BackendEvent[] {
  return events.filter(event => event.type === 'subagent' || event.type === 'subagents')
}

function lastSnapshot(events: readonly BackendEvent[]): SubagentSnapshot | undefined {
  let snapshot: SubagentSnapshot | undefined
  for (const event of events) if (event.type === 'subagents') snapshot = event.value
  return snapshot
}

function snapshotSignature(snapshot: SubagentSnapshot | undefined): string {
  return JSON.stringify(snapshot ?? null)
}

async function expectNoControlSideEffects(h: Harness): Promise<void> {
  assert.equal(h.agents.createCalls.length, 0, 'no child create ran (the root was resumed)')
  assert.equal(h.agents.resumeCalls.length, 1, 'only the root resume ran')
  assert.deepEqual(h.subagents.drainCalls, { descendants: 0, children: 0 }, 'the adapter never drains children')
  assert.equal(h.rootAgent.disposed, false)
  assert.deepEqual(h.rootAgent.cancellations, [])
  assert.equal(h.agents.live.size, 1, 'no child Agent was materialized')
}

test('late native subagent services refresh capabilities on the same attachment', async () => {
  const h = await harness(false)
  assert.equal(h.info.capabilities.includes('subagent-prompt'), false)
  assert.equal(h.info.capabilities.includes('subagent-interrupt'), false)
  const readyBefore = h.events.filter(event => event.type === 'ready').length

  h.subagents.attach(h.host)
  h.host.emit('subagent/start', { id: 'child-c', runId: 'late-native-run', local: true })
  await until(() => h.events.some(event => event.type === 'ready' &&
    event.info.capabilities.includes('subagent-prompt') &&
    event.info.capabilities.includes('subagent-interrupt')), 'late native capability ready')

  const refreshed = h.events.filter(event => event.type === 'ready').at(-1)
  assert.ok(refreshed?.type === 'ready')
  assert.equal(refreshed.info.sessionId, h.info.sessionId)
  assert.equal(refreshed.info.attachmentId, h.info.attachmentId)
  assert.equal(refreshed.info.events, undefined, 'capability refresh does not replay or reset the transcript snapshot')
  assert.equal(h.events.filter(event => event.type === 'ready').length, readyBefore + 1)

  h.host.emit('subagent/end', { id: 'child-c', runId: 'late-native-run', stopReason: 'completed', local: true })
  await settle()
  assert.equal(h.events.filter(event => event.type === 'ready').length, readyBefore + 1, 'unchanged capabilities do not re-announce')
  await h.backend.close()
})

test('subagent-interrupt addresses each child through its exact durable direct parent', async () => {
  const h = await harness()
  await settle()
  const baseline = h.events.length

  assert.deepEqual(
    await h.backend.command('subagent-interrupt', { sessionId: 'child-c' }),
    { sessionId: 'child-c', parentSessionId: ROOT, accepted: true },
  )
  // Nested children must never reuse the root parent address.
  assert.deepEqual(
    await h.backend.command('subagent-interrupt', { sessionId: 'nested-c' }),
    { sessionId: 'nested-c', parentSessionId: 'child-c', accepted: true },
  )
  assert.deepEqual(
    await h.backend.command('subagent-interrupt', { sessionId: 'deep-one' }),
    { sessionId: 'deep-one', parentSessionId: 'nested-c', accepted: true },
  )
  // One-shot children use the same core public primitive.
  assert.deepEqual(
    await h.backend.command('subagent-interrupt', { sessionId: 'child-one' }),
    { sessionId: 'child-one', parentSessionId: ROOT, accepted: true },
  )

  assert.deepEqual(h.subagents.interruptCalls, [
    { targetSessionId: 'child-c', kind: 'user', parentSessionId: ROOT },
    { targetSessionId: 'nested-c', kind: 'user', parentSessionId: 'child-c' },
    { targetSessionId: 'deep-one', kind: 'user', parentSessionId: 'nested-c' },
    { targetSessionId: 'child-one', kind: 'user', parentSessionId: ROOT },
  ])
  await nextTask()
  assert.deepEqual(subagentEvents(h.events.slice(baseline)), [], 'admission writes no transcript or status')
  await expectNoControlSideEffects(h)
})

test('subagent-interrupt lets the native authority decide external leaves', async () => {
  const h = await harness()
  assert.deepEqual(
    await h.backend.command('subagent-interrupt', { sessionId: 'child-ext' }),
    { sessionId: 'child-ext', parentSessionId: ROOT, accepted: true },
  )
  assert.deepEqual(h.subagents.interruptCalls, [
    { targetSessionId: 'child-ext', kind: 'user', parentSessionId: ROOT },
  ])

  h.subagents.failInterrupt = Object.assign(new Error('subagent/unauthorized: parent does not own the target'), {
    code: 'subagent/unauthorized',
  })
  await assert.rejects(
    h.backend.command('subagent-interrupt', { sessionId: 'child-c' }),
    (error: unknown) => {
      const failure = error as { code?: string; message?: string }
      assert.equal(failure.code, 'RUNTIME_REQUEST_FAILED')
      assert.match(failure.message ?? '', /unauthorized/)
      return true
    },
  )
})

test('subagent-interrupt fails closed for empty, root and out-of-tree ids', async () => {
  const h = await harness()
  for (const sessionId of ['', '   ', ROOT, 'not-a-child']) {
    await assert.rejects(
      h.backend.command('subagent-interrupt', { sessionId }),
      isCode('INVALID_ARGUMENT'),
      `${JSON.stringify(sessionId)} is rejected`,
    )
  }
  await assert.rejects(
    h.backend.command('subagent-interrupt', {}),
    isCode('INVALID_ARGUMENT'),
  )
  await assert.rejects(
    h.backend.command('subagent-interrupt', { sessionId: 42 }),
    isCode('INVALID_ARGUMENT'),
  )
  assert.deepEqual(h.subagents.interruptCalls, [], 'nothing reached the native authority')
  await expectNoControlSideEffects(h)
})

test('subagent-prompt defaults to queue and preserves the caller request identity', async () => {
  const h = await harness()
  await settle()
  const baseline = h.events.length
  const before = snapshotSignature(lastSnapshot(h.events))

  const queued = await h.backend.command('subagent-prompt', {
    sessionId: 'child-c',
    text: 'continue the plan',
  }) as Record<string, unknown>
  assert.equal(queued.messageId, 'fake-subagent-prompt-1')
  assert.equal(queued.sessionId, 'child-c')
  assert.equal(queued.parentSessionId, ROOT)
  assert.equal(queued.delivery, 'queue')
  assert.equal(typeof queued.requestId, 'string')
  assert.ok((queued.requestId as string).length > 0)

  const first = h.subagents.promptCalls[0]
  assert.deepEqual(first.content, [{ type: 'text', text: 'continue the plan' }])
  assert.equal(first.requestId, queued.requestId, 'the returned identity is the native request identity')
  assert.equal(first.mode, 'continuable')
  assert.equal(first.parentSessionId, ROOT)
  assert.ok(first.signal instanceof AbortSignal)
  assert.equal(first.signal.aborted, false)

  const steered = await h.backend.command('subagent-prompt', {
    sessionId: 'child-c',
    delivery: 'steer',
    requestId: 'caller-request-42',
    text: '  keep the whitespace  ',
  }) as Record<string, unknown>
  assert.equal(steered.delivery, 'steer')
  assert.equal(steered.requestId, 'caller-request-42')
  const second = h.subagents.promptCalls[1]
  assert.equal(second.delivery, 'steer')
  assert.equal(second.requestId, 'caller-request-42')
  assert.deepEqual(second.content, [{ type: 'text', text: '  keep the whitespace  ' }])

  // Every invocation without an explicit id mints a fresh identity; no retry.
  await h.backend.command('subagent-prompt', { sessionId: 'child-c', text: 'again' })
  assert.notEqual(h.subagents.promptCalls[2].requestId, queued.requestId)
  assert.equal(h.subagents.promptCalls.length, 3)

  await nextTask()
  assert.deepEqual(subagentEvents(h.events.slice(baseline)), [], 'accepted prompts write no transcript/status')
  assert.equal(snapshotSignature(lastSnapshot(h.events)), before)
  await expectNoControlSideEffects(h)
})

test('subagent-prompt addresses nested continuable children through their direct parent', async () => {
  const h = await harness()
  const receipt = await h.backend.command('subagent-prompt', {
    sessionId: 'nested-c',
    text: 'nested follow-up',
  }) as Record<string, unknown>
  assert.equal(receipt.parentSessionId, 'child-c')
  assert.equal(h.subagents.promptCalls[0].parentSessionId, 'child-c')
  assert.equal(h.subagents.promptCalls[0].childSessionId, 'nested-c')
  await expectNoControlSideEffects(h)
})

test('subagent-prompt forwards text and native image content without local admission', async () => {
  const h = await harness()
  assert.equal(h.host.get('attachments'), undefined, 'no attachment store is mounted')

  const content: PromptContentPart[] = [
    { type: 'text', text: 'compare with this screenshot' },
    { type: 'image', mediaType: 'image/png', data: PNG_BASE64, name: 'shot.png' },
  ]
  const receipt = await h.backend.command('subagent-prompt', { sessionId: 'child-c', content }) as Record<string, unknown>
  assert.equal(receipt.messageId, 'fake-subagent-prompt-1')
  assert.deepEqual(h.subagents.promptCalls[0].content, content)

  const imageOnly: PromptContentPart[] = [{ type: 'image', mediaType: 'image/png', data: PNG_BASE64 }]
  await h.backend.command('subagent-prompt', { sessionId: 'child-c', content: imageOnly })
  assert.deepEqual(h.subagents.promptCalls[1].content, imageOnly)

  const textOnly: PromptContentPart[] = [{ type: 'text', text: 'text part' }]
  await h.backend.command('subagent-prompt', { sessionId: 'child-c', content: textOnly })
  assert.deepEqual(h.subagents.promptCalls[2].content, textOnly)
  assert.equal(h.subagents.promptCalls[2].delivery, 'queue')
  await expectNoControlSideEffects(h)
})

test('subagent-prompt rejects invalid arguments and ineligible targets before any native call', async () => {
  const h = await harness()
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['missing payload', { sessionId: 'child-c' }, 'INVALID_ARGUMENT'],
    ['both payloads', { sessionId: 'child-c', text: 'x', content: [{ type: 'text', text: 'y' }] }, 'INVALID_ARGUMENT'],
    ['empty text', { sessionId: 'child-c', text: '' }, 'INVALID_ARGUMENT'],
    ['whitespace text', { sessionId: 'child-c', text: '   ' }, 'INVALID_ARGUMENT'],
    ['non-string text', { sessionId: 'child-c', text: 42 }, 'INVALID_ARGUMENT'],
    ['unknown delivery', { sessionId: 'child-c', text: 'x', delivery: 'later' }, 'INVALID_ARGUMENT'],
    ['empty requestId', { sessionId: 'child-c', text: 'x', requestId: '' }, 'INVALID_ARGUMENT'],
    ['non-string requestId', { sessionId: 'child-c', text: 'x', requestId: 7 }, 'INVALID_ARGUMENT'],
    ['empty content', { sessionId: 'child-c', content: [] }, 'INVALID_ARGUMENT'],
    ['whitespace-only content', { sessionId: 'child-c', content: [{ type: 'text', text: '  ' }] }, 'INVALID_ARGUMENT'],
    ['bad media type', {
      sessionId: 'child-c',
      content: [{ type: 'image', mediaType: 'image/tiff', data: PNG_BASE64 }],
    }, 'INVALID_ARGUMENT'],
    ['non-canonical base64', {
      sessionId: 'child-c',
      content: [{ type: 'image', mediaType: 'image/png', data: 'not-base64!' }],
    }, 'INVALID_ARGUMENT'],
    ['unknown part', { sessionId: 'child-c', content: [{ type: 'file', path: '/etc/passwd' }] }, 'INVALID_ARGUMENT'],
    ['non-array content', { sessionId: 'child-c', content: 'text' }, 'INVALID_ARGUMENT'],
    ['empty id', { sessionId: '', text: 'x' }, 'INVALID_ARGUMENT'],
    ['root id', { sessionId: ROOT, text: 'x' }, 'INVALID_ARGUMENT'],
    ['out of tree', { sessionId: 'not-a-child', text: 'x' }, 'INVALID_ARGUMENT'],
    ['one-shot child', { sessionId: 'child-one', text: 'x' }, 'INVALID_ARGUMENT'],
    ['one-shot nested child', { sessionId: 'deep-one', text: 'x' }, 'INVALID_ARGUMENT'],
    ['external leaf', { sessionId: 'child-ext', text: 'x' }, 'INVALID_ARGUMENT'],
  ]
  for (const [label, params, code] of cases) {
    await assert.rejects(
      h.backend.command('subagent-prompt', params),
      isCode(code),
      `${label} is rejected as ${code}`,
    )
  }
  assert.deepEqual(h.subagents.promptCalls, [], 'no refusal reached the native prompt')
  await expectNoControlSideEffects(h)
})

test('subagent-prompt surfaces native refusals and never fabricates a receipt', async () => {
  const h = await harness()
  await settle()
  const baseline = h.events.length

  h.subagents.failPrompt = Object.assign(new Error('subagent/delivery-unavailable: child inbox is full'), {
    code: 'subagent/delivery-unavailable',
  })
  await assert.rejects(
    h.backend.command('subagent-prompt', { sessionId: 'child-c', text: 'x' }),
    (error: unknown) => {
      const failure = error as { code?: string; message?: string }
      assert.equal(failure.code, 'RUNTIME_REQUEST_FAILED')
      assert.match(failure.message ?? '', /delivery-unavailable/)
      return true
    },
  )
  assert.equal(h.subagents.promptCalls.length, 1, 'a refused prompt is never retried automatically')
  h.subagents.failPrompt = undefined

  h.subagents.promptReceipt = null
  await assert.rejects(
    h.backend.command('subagent-prompt', { sessionId: 'child-c', text: 'x' }),
    isCode('RUNTIME_REQUEST_FAILED'),
    'a null receipt is not an accepted message',
  )
  h.subagents.promptReceipt = {}
  await assert.rejects(
    h.backend.command('subagent-prompt', { sessionId: 'child-c', text: 'x' }),
    isCode('RUNTIME_REQUEST_FAILED'),
  )
  h.subagents.promptReceipt = { messageId: 42 }
  await assert.rejects(
    h.backend.command('subagent-prompt', { sessionId: 'child-c', text: 'x' }),
    isCode('RUNTIME_REQUEST_FAILED'),
  )
  h.subagents.promptReceipt = undefined

  await nextTask()
  assert.deepEqual(subagentEvents(h.events.slice(baseline)), [], 'failures write no optimistic status')
  await expectNoControlSideEffects(h)
})

test('an admitted interrupt never fabricates a stopped status', async () => {
  const h = await harness()
  await settle()
  const child = createFakeAgent({ id: 'child-c', status: 'running' })
  h.agents.enter(child.agent)
  await nextTask()
  const baseline = h.events.length
  await h.backend.command('subagent-interrupt', { sessionId: 'child-c' })
  await nextTask()

  const published = h.events.slice(baseline).flatMap(event =>
    event.type === 'subagent' || event.type === 'subagents' ? [event] : [])
  for (const event of published) {
    const entries = event.type === 'subagent' ? [event.value] : event.value.entries
    for (const entry of entries) {
      assert.notEqual(entry.status, 'stopped', 'accepted is not quiescence')
      assert.notEqual(entry.status, 'completed')
    }
  }
  // The child Agent is untouched: no local cancel/dispose and no drain.
  assert.deepEqual(child.agent.cancellations, [])
  assert.equal(child.agent.disposed, false)
  assert.deepEqual(h.subagents.drainCalls, { descendants: 0, children: 0 })
})

test('capabilities follow the exact native methods and the readable bridge', async () => {
  const h = await harness()
  assert.ok(h.info.capabilities.includes('subagent-interrupt'))
  assert.ok(h.info.capabilities.includes('subagent-prompt'))

  // A mutation method without usable discovery cannot prove current-tree
  // membership, so it is not advertised: control stays fail-closed.
  h.host.use('subagents', { interrupt: h.subagents.interrupt.bind(h.subagents) })
  const mutationOnly = await h.backend.connect()
  assert.equal(mutationOnly.capabilities.includes('subagent-interrupt'), false)
  assert.equal(mutationOnly.capabilities.includes('subagent-prompt'), false)
  await assert.rejects(
    h.backend.command('subagent-interrupt', { sessionId: 'child-c' }),
    isCode('CAPABILITY_UNAVAILABLE'),
  )

  // Only interrupt mounted, over the readable native discovery.
  h.host.use('subagents', {
    interrupt: h.subagents.interrupt.bind(h.subagents),
    listDescendants: h.subagents.listDescendants.bind(h.subagents),
    listChildren: h.subagents.listChildren.bind(h.subagents),
  })
  const interruptOnly = await h.backend.connect()
  assert.equal(interruptOnly.capabilities.includes('subagent-interrupt'), true)
  assert.equal(interruptOnly.capabilities.includes('subagent-prompt'), false)
  await assert.rejects(
    h.backend.command('subagent-prompt', { sessionId: 'child-c', text: 'x' }),
    isCode('CAPABILITY_UNAVAILABLE'),
  )
  await h.backend.command('subagent-interrupt', { sessionId: 'child-c' })

  // Only prompt mounted, over the readable native discovery.
  h.host.use('subagents', {
    prompt: h.subagents.prompt.bind(h.subagents),
    listDescendants: h.subagents.listDescendants.bind(h.subagents),
    listChildren: h.subagents.listChildren.bind(h.subagents),
  })
  const promptOnly = await h.backend.connect()
  assert.equal(promptOnly.capabilities.includes('subagent-prompt'), true)
  assert.equal(promptOnly.capabilities.includes('subagent-interrupt'), false)
  await assert.rejects(
    h.backend.command('subagent-interrupt', { sessionId: 'child-c' }),
    isCode('CAPABILITY_UNAVAILABLE'),
  )

  // No native subagent service at all.
  h.host.use('subagents', undefined)
  const none = await h.backend.connect()
  assert.equal(none.capabilities.includes('subagent-interrupt'), false)
  assert.equal(none.capabilities.includes('subagent-prompt'), false)
  for (const [name, params] of [
    ['subagent-interrupt', { sessionId: 'child-c' }],
    ['subagent-prompt', { sessionId: 'child-c', text: 'x' }],
  ] as Array<[string, Record<string, unknown>]>) {
    await assert.rejects(h.backend.command(name, params), isCode('CAPABILITY_UNAVAILABLE'))
  }

  // Native methods exist, but the tree cannot be read: both commands fail closed.
  h.subagents.attach(h.host)
  const query = h.world.sessionQuery as unknown as Record<string, unknown>
  const saved = query.observeSession
  delete query.observeSession
  try {
    const unreadable = await h.backend.connect()
    assert.equal(unreadable.capabilities.includes('subagent-interrupt'), false)
    assert.equal(unreadable.capabilities.includes('subagent-prompt'), false)
    for (const [name, params] of [
      ['subagent-interrupt', { sessionId: 'child-c' }],
      ['subagent-prompt', { sessionId: 'child-c', text: 'x' }],
    ] as Array<[string, Record<string, unknown>]>) {
      await assert.rejects(h.backend.command(name, params), isCode('CAPABILITY_UNAVAILABLE'))
    }
  } finally {
    query.observeSession = saved
  }

  const restored = await h.backend.connect()
  assert.ok(restored.capabilities.includes('subagent-interrupt'))
  assert.ok(restored.capabilities.includes('subagent-prompt'))
})

test('an in-flight prompt blocks /reload through the existing command idleness check', async () => {
  const h = await harness()
  h.subagents.holdPrompt = true
  const pending = h.backend.command('subagent-prompt', { sessionId: 'child-c', text: 'hold' })
  const outcome = pending.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }),
  )
  await until(() => h.subagents.promptCalls.length === 1, 'native prompt started')

  await assert.rejects(
    h.backend.command('reload'),
    (error: unknown) => {
      const failure = error as { code?: string; message?: string }
      assert.equal(failure.code, 'RUNTIME_REQUEST_FAILED')
      assert.match(failure.message ?? '', /native command to finish before reloading/)
      return true
    },
  )

  await h.backend.close()
  const settled = await outcome
  assert.equal(settled.ok, false)
  assert.equal((settled as { error?: { code?: string } }).error?.code, 'ABORTED')
})

test('close aborts an in-flight prompt through the active-command mechanism', async () => {
  const h = await harness()
  h.subagents.holdPrompt = true
  const pending = h.backend.command('subagent-prompt', { sessionId: 'child-c', text: 'hold' })
  // Attach the rejection handler before close so the rejection is never unhandled.
  const outcome = pending.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }),
  )
  await until(() => h.subagents.promptCalls.length === 1, 'native prompt started')
  const carrier = h.subagents.promptCalls[0].signal
  assert.equal(carrier.aborted, false)

  await h.backend.close()
  const settled = await outcome
  assert.equal(settled.ok, false)
  assert.equal((settled as { error?: { code?: string } }).error?.code, 'ABORTED', 'close cancels the carrier, not the child')
  assert.equal(carrier.aborted, true)
  assert.deepEqual(h.subagents.drainCalls, { descendants: 0, children: 0 })
  assert.equal(h.rootAgent.disposed, true, 'close disposes only the adapter-owned root handle')
  await assert.rejects(
    h.backend.command('subagent-prompt', { sessionId: 'child-c', text: 'after close' }),
    isCode('CLOSED'),
  )
  assert.equal(h.subagents.promptCalls.length, 1)
})

test('a prompt rejection caused by a caller cancel surfaces as ABORTED', async () => {
  const h = await harness()
  h.subagents.holdPrompt = true
  const pending = h.backend.command('subagent-prompt', { sessionId: 'child-c', text: 'cancel me' })
  const outcome = pending.then(
    value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }),
  )
  await until(() => h.subagents.promptCalls.length === 1, 'native prompt started')
  const carrier = h.subagents.promptCalls[0].signal

  await h.backend.cancel()
  const settled = await outcome
  assert.equal(settled.ok, false)
  assert.equal((settled as { error?: { code?: string } }).error?.code, 'ABORTED')
  assert.equal(carrier.aborted, true)
  assert.deepEqual(h.subagents.drainCalls, { descendants: 0, children: 0 })
  assert.equal(h.rootAgent.disposed, false)
})