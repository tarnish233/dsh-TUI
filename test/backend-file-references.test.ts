/**
 * Offline contract tests for native `@file` discovery.
 *
 * The provider is a local fake over the public
 * `ctx.fileReferences.list(agent, query, signal)` shape: no profile,
 * credential, workspace scan, file read, model request or subprocess is
 * touched. The real provider package is documented read-only in docs/BACKEND.md.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshBackend, type DshContextBackend } from '../src/backend/context.ts'
import { fileReferenceService, normalizeFileReferenceCandidates } from '../src/backend/native-file-references.ts'
import { FakeAgentRegistry, FakeDshHost, fakeNativeHelpers, nextTask, type FakeAgentState } from '../src/backend/testing.ts'
import type { BackendEvent, SessionInfo } from '../src/backend/types.ts'

interface ProviderCalls {
  readonly agents: unknown[]
  readonly queries: string[]
  readonly signals: AbortSignal[]
}

interface ProviderSpy {
  readonly service: { list(agent: unknown, query: string, signal: AbortSignal): Promise<unknown> }
  readonly calls: ProviderCalls
}

/**
 * One mounted provider fake. `respond` receives the exact forwarded arguments;
 * calls are recorded before the response so tests can wait for entry.
 */
function providerSpy(
  respond: (agent: unknown, query: string, signal: AbortSignal) => unknown = () => [{ path: 'src/index.ts', kind: 'file' }],
): ProviderSpy {
  const calls: ProviderCalls = { agents: [], queries: [], signals: [] }
  return {
    calls,
    service: {
      async list(agent: unknown, query: string, signal: AbortSignal): Promise<unknown> {
        calls.agents.push(agent)
        calls.queries.push(query)
        calls.signals.push(signal)
        return await respond(agent, query, signal)
      },
    },
  }
}

interface Harness {
  readonly host: FakeDshHost
  readonly agents: FakeAgentRegistry
  readonly backend: DshContextBackend
  readonly events: BackendEvent[]
  readonly warnings: string[]
}

/** Minimal native-shaped host: Agent registry, default route and model catalog. */
function harness(): Harness {
  const host = new FakeDshHost()
  const agents = new FakeAgentRegistry()
  const warnings: string[] = []
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
  const backend = createDshBackend(host, {
    cwd: '/workspace',
    native: fakeNativeHelpers(),
    warn: message => { warnings.push(message) },
  })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  return { host, agents, backend, events, warnings }
}

async function connected(): Promise<Harness & { info: SessionInfo }> {
  const value = harness()
  const info = await value.backend.connect()
  return { ...value, info }
}

function latestAgent(agents: FakeAgentRegistry): FakeAgentState {
  const agent = agents.agents[agents.agents.length - 1]
  assert.ok(agent, 'the fake registry created an Agent')
  return agent
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await nextTask()
  }
  throw new Error('timed out waiting for ' + label)
}

function rejectsWithCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.equal((error as { code?: string }).code, code)
    return true
  }
}

test('file-references capability follows only a mounted list method', async () => {
  const mounted = harness()
  mounted.host.use('fileReferences', providerSpy().service)
  const info = await mounted.backend.connect()
  assert.ok(info.capabilities.includes('file-references'), 'a mounted list method is advertised on ready')
  await mounted.backend.close()

  const nonFunction = harness()
  nonFunction.host.use('fileReferences', { list: 'not a function' })
  const absent = await nonFunction.backend.connect()
  assert.equal(absent.capabilities.includes('file-references'), false, 'a non-function list is not discovery')
  await assert.rejects(nonFunction.backend.listFileReferences('src'), rejectsWithCode('CAPABILITY_UNAVAILABLE'))
  assert.equal(nonFunction.agents.createCalls.length, 0)
  await nonFunction.backend.close()
})

test('capability is advertised on ready only while the provider is mounted', async () => {
  const value = harness()
  value.host.use('fileReferences', providerSpy().service)
  const info = await value.backend.connect()
  assert.ok(info.capabilities.includes('file-references'), 'a mounted list method is advertised on ready')
  await value.backend.close()

  const missing = harness()
  missing.host.use('fileReferences', null)
  const absent = await missing.backend.connect()
  assert.equal(absent.capabilities.includes('file-references'), false)
  await missing.backend.close()
})

test('missing provider rejects without materializing the pending Agent', async () => {
  const value = await connected()
  await assert.rejects(value.backend.listFileReferences('src/'), rejectsWithCode('CAPABILITY_UNAVAILABLE'))
  assert.equal(value.agents.createCalls.length, 0, 'a failed capability check must not create an Agent')
  assert.equal(value.agents.resumeCalls.length, 0)
  assert.equal(value.agents.agents.length, 0)

  // The same backend serves queries as soon as a provider is mounted; the
  // pending root is materialized by the ordinary lazy path.
  const provider = providerSpy(() => [{ path: 'src/', kind: 'directory' }])
  value.host.use('fileReferences', provider.service)
  assert.deepEqual(await value.backend.listFileReferences('src/'), [{ path: 'src/', kind: 'directory' }])
  assert.equal(value.agents.createCalls.length, 1)
  assert.equal((value.agents.createCalls[0] as { sessionId?: string }).sessionId, value.info.sessionId)
  await value.backend.close()
})

test('pending discovery materializes exactly one Agent and sends no model turn', async () => {
  const provider = providerSpy((_agent, query) => [{ path: query === '' ? 'src/' : 'src/index.ts', kind: query === '' ? 'directory' : 'file' }])
  const value = harness()
  value.host.use('fileReferences', provider.service)
  const info = await value.backend.connect()
  assert.equal(value.agents.createCalls.length, 0)

  const [bare, scoped] = await Promise.all([
    value.backend.listFileReferences(''),
    value.backend.listFileReferences('src'),
  ])
  assert.deepEqual(bare, [{ path: 'src/', kind: 'directory' }])
  assert.deepEqual(scoped, [{ path: 'src/index.ts', kind: 'file' }])
  assert.equal(value.agents.createCalls.length, 1, 'concurrent first queries materialize once')
  assert.equal(value.agents.resumeCalls.length, 0)
  assert.equal((value.agents.createCalls[0] as { sessionId?: string }).sessionId, info.sessionId)
  const agent = latestAgent(value.agents)
  assert.equal(value.agents.agents.length, 1)
  assert.equal(provider.calls.agents.length, 2)
  for (const seen of provider.calls.agents) assert.equal(seen, agent, 'the exact live Agent reaches the provider')
  assert.equal(agent.sent.length, 0, 'discovery never submits a prompt or starts a turn')
  assert.equal(agent.status, 'idle')
  await value.backend.close()
})

test('mounted discovery preserves provider order, query and the public candidate shape', async () => {
  const raw = [
    { path: 'zeta.ts', kind: 'file', score: 91, hidden: 'provider-private' },
    { path: 'alpha/', kind: 'directory' },
    { path: '/abs/with space.txt', kind: 'file' },
    { path: 'beta.ts', kind: 'file' },
  ]
  const provider = providerSpy(() => raw)
  const value = await connected()
  value.host.use('fileReferences', provider.service)
  const result = await value.backend.listFileReferences(' zeta ')
  assert.equal(provider.calls.queries[0], ' zeta ', 'the query is forwarded verbatim, never trimmed')
  assert.deepEqual(result, [
    { path: 'zeta.ts', kind: 'file' },
    { path: 'alpha/', kind: 'directory' },
    { path: '/abs/with space.txt', kind: 'file' },
    { path: 'beta.ts', kind: 'file' },
  ])
  assert.equal(result.length, raw.length, 'providers own ranking and limits; nothing is truncated')
  assert.equal((result[0] as unknown as Record<string, unknown>).score, undefined, 'only the public fields cross the seam')
  assert.equal((result[0] as unknown as Record<string, unknown>).hidden, undefined)
  await value.backend.close()
})

test('each call resolves the mounted provider again and uses the exact current Agent', async () => {
  const first = providerSpy()
  const value = await connected()
  value.host.use('fileReferences', first.service)
  await value.backend.listFileReferences('a')
  const agent = latestAgent(value.agents)
  assert.equal(first.calls.agents[0], agent)

  // HMR replacement: the next query must not reuse the previous service object.
  const second = providerSpy(() => [{ path: 'second/', kind: 'directory' }])
  value.host.use('fileReferences', second.service)
  assert.deepEqual(await value.backend.listFileReferences('b'), [{ path: 'second/', kind: 'directory' }])
  assert.equal(first.calls.agents.length, 1, 'the replaced provider never sees a later query')
  assert.equal(second.calls.agents.length, 1)
  assert.equal(second.calls.agents[0], agent, 'the exact live Agent object is forwarded')
  assert.equal(second.calls.queries[0], 'b')
  assert.equal(value.agents.createCalls.length, 1)
  await value.backend.close()
})

test('a caller abort is effective before and during the provider call', async () => {
  const provider = providerSpy()
  const value = await connected()
  value.host.use('fileReferences', provider.service)

  const pre = new AbortController()
  pre.abort()
  await assert.rejects(value.backend.listFileReferences('src', pre.signal), rejectsWithCode('ABORTED'))
  assert.equal(provider.calls.agents.length, 0, 'an aborted query never reaches the provider')
  assert.equal(value.agents.createCalls.length, 0, 'an aborted query must not materialize an Agent')

  let owned: AbortSignal | undefined
  const inflight = providerSpy((_agent, _query, signal) => {
    owned = signal
    return new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('provider aborted'), { name: 'AbortError' })), { once: true })
    })
  })
  value.host.use('fileReferences', inflight.service)
  const controller = new AbortController()
  const query = value.backend.listFileReferences('slow', controller.signal)
  await waitFor(() => inflight.calls.agents.length === 1, 'the provider call to start')
  assert.equal(owned?.aborted, false)
  controller.abort()
  await assert.rejects(query, rejectsWithCode('ABORTED'))
  assert.equal(owned?.aborted, true, 'the owned signal forwards external cancellation')
  await value.backend.close()
})

test('replacing or closing the attachment cancels an in-flight discovery', async () => {
  let resolveLate: ((value: unknown) => void) | undefined
  const provider = providerSpy(() => new Promise<unknown>((resolve) => { resolveLate = resolve }))
  const value = await connected()
  value.host.use('fileReferences', provider.service)
  const query = value.backend.listFileReferences('late')
  await waitFor(() => provider.calls.agents.length === 1, 'the provider call to start')

  await value.backend.command('new')
  resolveLate?.([{ path: 'late.ts', kind: 'file' }])
  await assert.rejects(query, (error: unknown) => {
    assert.ok(
      (error as { code?: string }).code === 'ABORTED' || (error as { code?: string }).code === 'STALE_SESSION',
      'a replaced attachment never delivers candidates',
    )
    return true
  })
  assert.equal(provider.calls.signals[0].aborted, true, 'session replacement aborts the owned read')

  const closeProvider = providerSpy((_agent, _query, signal) => new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(Object.assign(new Error('closed'), { name: 'AbortError' })), { once: true })
  }))
  value.host.use('fileReferences', closeProvider.service)
  const closing = value.backend.listFileReferences('closing')
  await waitFor(() => closeProvider.calls.agents.length === 1, 'the second provider call to start')
  await value.backend.close()
  await assert.rejects(closing, rejectsWithCode('ABORTED'))
  assert.deepEqual(value.warnings, [], 'close cancellation is not a diagnostic')
  await assert.rejects(value.backend.listFileReferences('after'), rejectsWithCode('CLOSED'))
})

test('malformed provider results are coded failures, never partial or empty lists', async () => {
  let result: unknown
  const provider = providerSpy(() => result)
  const value = await connected()
  value.host.use('fileReferences', provider.service)
  const malformed: unknown[] = [
    undefined,
    null,
    {},
    'candidates',
    42,
    [null],
    [[]],
    ['src/a.ts'],
    [{}],
    [{ path: '', kind: 'file' }],
    [{ path: 42, kind: 'file' }],
    [{ path: 'src/a.ts' }],
    [{ path: 'src/a.ts', kind: 'folder' }],
    [{ path: 'src/a.ts', kind: 'File' }],
    [{ path: 'ok.ts', kind: 'file' }, null],
  ]
  for (const candidate of malformed) {
    result = candidate
    await assert.rejects(value.backend.listFileReferences('src'), rejectsWithCode('RUNTIME_REQUEST_FAILED'))
  }
  // The diagnostic names the malformed position without echoing candidate text.
  result = [{ path: 'ok.ts', kind: 'file' }, null]
  await assert.rejects(value.backend.listFileReferences('src'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'RUNTIME_REQUEST_FAILED')
    assert.match((error as Error).message, /index 1/)
    return true
  })
  await value.backend.close()
})

test('provider rejections keep native codes and redact diagnostics', async () => {
  const coded = providerSpy(() => {
    throw Object.assign(new Error('session is already owned'), { code: 'STALE_SESSION' })
  })
  const value = await connected()
  value.host.use('fileReferences', coded.service)
  await assert.rejects(value.backend.listFileReferences('src'), rejectsWithCode('STALE_SESSION'))

  const failing = providerSpy(() => {
    throw new Error('scan failed with api_key=sk-supersecret-value')
  })
  value.host.use('fileReferences', failing.service)
  await assert.rejects(value.backend.listFileReferences('src'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'RUNTIME_REQUEST_FAILED')
    const message = (error as Error).message
    assert.match(message, /native file-reference provider failed/)
    assert.equal(message.includes('sk-supersecret-value'), false, 'credentials never reach a diagnostic')
    return true
  })
  await value.backend.close()
})

test('the candidate normalizer preserves length/order and drops private fields', () => {
  const long = Array.from({ length: 64 }, (_value, index) => ({
    path: `src/file-${index}.ts`,
    kind: index % 2 === 0 ? 'file' : 'directory',
    score: index,
  }))
  const normalized = normalizeFileReferenceCandidates(long)
  assert.equal(normalized.length, 64)
  assert.deepEqual(normalized[0], { path: 'src/file-0.ts', kind: 'file' })
  assert.deepEqual(normalized[63], { path: 'src/file-63.ts', kind: 'directory' })
  assert.deepEqual(normalized.map(candidate => candidate.path), long.map(candidate => candidate.path))

  assert.equal(fileReferenceService(undefined), undefined)
  assert.equal(fileReferenceService(null), undefined)
  assert.equal(fileReferenceService({ list: 1 }), undefined)
  assert.equal(fileReferenceService({ list: async () => [] })?.list instanceof Function, true)
  assert.equal(fileReferenceService({ get list(): unknown { throw new Error('unreadable service') } }), undefined)
  assert.throws(
    () => normalizeFileReferenceCandidates([{ path: 'a', kind: 'nope' }]),
    (error: unknown) => (error as { code?: string }).code === 'RUNTIME_REQUEST_FAILED',
  )
  assert.throws(
    () => normalizeFileReferenceCandidates([{ get path(): string { throw new Error('unreadable candidate') }, kind: 'file' }]),
    (error: unknown) => (error as { code?: string }).code === 'RUNTIME_REQUEST_FAILED',
  )
})