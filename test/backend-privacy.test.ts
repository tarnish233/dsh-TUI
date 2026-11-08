/**
 * Adapter diagnostics privacy contract.
 *
 * Synthetic credential-shaped strings exercise the redaction of adapter-origin
 * errors/warnings only. Native session events and tool output stay verbatim:
 * DSH's durable facts are not rewritten by the TUI.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshBackend } from '../src/backend/context.ts'
import { redactDiagnostic } from '../src/backend/errors.ts'
import type { BackendEvent } from '../src/backend/types.ts'
import { FakeAgentRegistry, FakeDshHost, fakeNativeHelpers } from '../src/backend/testing.ts'

const SECRET = 'sk-live-SECRET-abc123'
const BEARER = 'Bearer abc.def.ghi'
const API_KEY = 'api_key=qwerty987'
const TOKEN = 'token=tok_999'

interface Harness {
  host: FakeDshHost
  agents: FakeAgentRegistry
  events: BackendEvent[]
  warnings: string[]
  backend: ReturnType<typeof createDshBackend>
}

function harness(extra: (host: FakeDshHost) => void = () => {}): Harness {
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
  const warnings: string[] = []
  const backend = createDshBackend(host, {
    cwd: '/workspace',
    native: fakeNativeHelpers(),
    warn: message => warnings.push(message),
  })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  return { host, agents, events, warnings, backend }
}

function assertNoSecrets(text: string): void {
  for (const value of [SECRET, 'abc.def.ghi', 'qwerty987', 'tok_999', BEARER]) {
    assert.equal(text.includes(value), false, `diagnostic leaked ${value}: ${text}`)
  }
}

test('native provider failure diagnostics are redacted while other provider facts remain', async () => {
  const { backend, host, events } = harness()
  await backend.connect()
  const leaked = `Authorization: ${BEARER} ${API_KEY} ${TOKEN}`
  host.use('llm', {
    listProviders: () => [{ id: 'p1', name: 'Provider One' }, { id: 'p2', name: 'Provider Two' }],
    listModels: async (providerId: string) => {
      if (providerId === 'p2') throw new Error(leaked)
      return [{ id: 'm1', name: 'Model One' }]
    },
    resolveModelInfo: async () => ({}),
  })
  const models = await backend.command('models') as Array<Record<string, unknown>>
  assert.deepEqual(models.map(row => row.id), ['p1/m1'])
  const warning = events.filter(event => event.type === 'warning').at(-1)
  assert.ok(warning?.type === 'warning')
  assertNoSecrets(warning.message)
  assert.match(warning.message, /p2:/)
  assert.match(warning.message, /\[redacted\]/)
  await backend.close()
})

test('an all-failed native provider registry reports redacted service failures', async () => {
  const { backend, host } = harness()
  await backend.connect()
  host.use('llm', {
    listProviders: () => [{ id: 'p1' }],
    listModels: async () => { throw new Error(`credential rejected: ${API_KEY} ${BEARER}`) },
    resolveModelInfo: async () => ({}),
  })
  await assert.rejects(backend.command('models'), (error: unknown) => {
    const message = (error as Error).message
    assertNoSecrets(message)
    assert.match(message, /no model routes are available/)
    assert.match(message, /\[redacted\]/)
    return true
  })
  await backend.close()
})

test('default-model save failures are redacted', async () => {
  const { backend } = harness((host) => {
    host.use('agentDefaultModel', {
      currentSelection: () => ({ provider: 'p1', model: 'm1' }),
      saveSelection: async () => {
        throw new Error(`profile write failed ${API_KEY} ${BEARER}`)
      },
    })
  })
  await backend.connect()
  const result = await backend.command('model', { id: 'p1/m1' }) as Record<string, unknown>
  assert.equal(result.defaultPersistence, 'failed')
  assertNoSecrets(String(result.defaultWarning))
  await backend.close()
})

test('read-only auto-title diagnostics never carry native loader text', async () => {
  const { backend } = harness((host) => {
    host.use('loader', {
      entries: () => { throw new Error(`loader error ${TOKEN} ${BEARER}`) },
    })
    host.use('sessionTitle', { refresh: () => {} })
  })
  const state = await backend.command('auto-title') as Record<string, unknown>
  assert.equal(state.available, false)
  assertNoSecrets(JSON.stringify(state))
  const refused = await backend.command('auto-title', { enabled: false }) as Record<string, unknown>
  assert.equal(refused.available, false)
  assert.equal(refused.changed, false)
  assert.match(String(refused.reason), /profile composition/)
  assertNoSecrets(JSON.stringify(refused))
  await backend.close()
})

test('native session events and durable facts are never rewritten', async () => {
  const { backend, agents, events, host } = harness()
  await backend.connect()
  await backend.send('prompt')
  const agent = agents.agents[0]
  assert.ok(agent)
  const raw = {
    type: 'tool/result',
    seq: 7,
    data: {
      message: {
        content: [{ type: 'text', text: `provider said Authorization: ${BEARER} ${API_KEY}` }],
        isError: false,
      },
    },
    surfaceOp: 'append',
  }
  host.emit('session/event', agent.session, raw)
  const forwarded = events.filter(event => event.type === 'session_event').at(-1)
  assert.ok(forwarded?.type === 'session_event')
  assert.deepEqual(forwarded.event.data, raw.data)
  assert.equal(forwarded.event.surfaceOp, 'append')
  await backend.close()
})

test('models capability is claimed only when the native LLM services exist', async () => {
  const { backend, host } = harness()
  host.services.delete('llm')
  const info = await backend.connect()
  assert.equal(info.capabilities.includes('models'), false)
  assert.equal(info.capabilities.includes('efforts'), false)
  await assert.rejects(backend.command('models'), /no LLM provider catalog/)
  await backend.close()
})

test('redactDiagnostic covers headers and assignments without over-redacting facts', () => {
  const input = `Authorization: ${BEARER}; ${API_KEY}; access_token=${SECRET}; password: "hunter2"; model p1/m1`
  const output = redactDiagnostic(input)
  for (const value of ['abc.def.ghi', 'qwerty987', SECRET, 'hunter2']) {
    assert.equal(output.includes(value), false, `leaked ${value}`)
  }
  assert.match(output, /model p1\/m1/)
  assert.equal(redactDiagnostic('request body is fine'), 'request body is fine')
})

test('image payloads never enter adapter diagnostics', async () => {
  const bytes = Buffer.alloc(2048, 9)
  const { backend, warnings } = harness((host) => {
    host.use('attachments', {
      readImage: async (ref: { attachmentId: string; mediaType: string; bytes: number; width: number; height: number }) => ({
        ref: { ...ref, bytes: 2048 },
        data: bytes,
      }),
    })
  })
  await backend.connect()
  const value = await backend.readImage({ attachmentId: 'a1', mediaType: 'image/png', bytes: 2048, width: 2, height: 2 })
  assert.equal(Buffer.from(value.data, 'base64').length, 2048)
  assert.deepEqual(warnings, [])
  await backend.close()
})
test('asBackendError sanitizes every thrown shape and keeps stable codes', async () => {
  const { asBackendError, BackendError, backendErrorCodeOf } = await import('../src/backend/errors.ts')
  const fromError = asBackendError(new Error(`native failure ${API_KEY} ${BEARER}`))
  assert.equal(fromError instanceof BackendError, true)
  assert.equal(fromError.code, 'RUNTIME_REQUEST_FAILED')
  assertNoSecrets(fromError.message)
  assert.match(fromError.message, /\[redacted\]/)

  const fromString = asBackendError(`string failure ${TOKEN}`)
  assert.equal(fromString.code, 'RUNTIME_REQUEST_FAILED')
  assertNoSecrets(fromString.message)

  const fromRecord = asBackendError({ message: `record failure ${API_KEY}`, detail: `detail ${SECRET}` })
  assertNoSecrets(fromRecord.message)
  assertNoSecrets(String(fromRecord.detail))

  const fromEmpty = asBackendError(undefined)
  assert.equal(typeof fromEmpty.message, 'string')
  assert.equal(fromEmpty.code, 'RUNTIME_REQUEST_FAILED')

  // A stable code on the value wins; a coded cancellation keeps its identity.
  const coded = Object.assign(new Error(`aborted ${BEARER}`), { code: 'ABORTED' })
  const cancellation = asBackendError(coded)
  assert.equal(cancellation.code, 'ABORTED')
  assertNoSecrets(cancellation.message)
  assert.equal(backendErrorCodeOf(coded), 'ABORTED')

  const abortNamed = Object.assign(new Error('caller aborted'), { name: 'AbortError' })
  assert.equal(asBackendError(abortNamed).code, 'ABORTED')
  const owned = Object.assign(new Error('session "s1" is already owned'), { name: 'SessionAlreadyOwnedError' })
  assert.equal(asBackendError(owned).code, 'STALE_SESSION')

  // An adapter BackendError is returned unchanged when it is already safe.
  const safe = new BackendError('STALE_DECISION', 'unknown or already settled decision: approval-1')
  assert.equal(asBackendError(safe), safe)
  const unsafe = new BackendError('RUNTIME_REQUEST_FAILED', `leaked ${SECRET}`)
  const hardened = asBackendError(unsafe)
  assert.notEqual(hardened, unsafe)
  assert.equal(hardened.code, unsafe.code)
  assertNoSecrets(hardened.message)

  assert.equal(asBackendError(new Error('x'), 'CAPABILITY_UNAVAILABLE').code, 'CAPABILITY_UNAVAILABLE')
  assert.equal(asBackendError(new Error('x'), 'CAPABILITY_UNAVAILABLE').message, 'x')
})

test('a raw native resume rejection becomes one cold, coded diagnostic', async () => {
  const { backend, agents } = harness()
  agents.failResume = new Error(`native resume exploded ${BEARER} ${API_KEY}`)
  await assert.rejects(backend.command('resume', { sessionId: 's-raw' }), (error: unknown) => {
    const failure = error as { name?: string; code?: string; message?: string; stack?: string }
    assert.equal(failure.name, 'BackendError')
    assert.equal(failure.code, 'RUNTIME_REQUEST_FAILED')
    assertNoSecrets(String(failure.message))
    assert.match(String(failure.message), /could not resume session "s-raw"/)
    assert.match(String(failure.message), /\[redacted\]/)
    assert.equal(failure.stack?.includes('[redacted]'), true, 'the stack still points at adapter code only')
    return true
  })
  await backend.close()
})

test('a raw native create/setup rejection is coded and redacted, never a bare Error', async () => {
  const { backend, agents } = harness()
  await backend.connect()
  agents.failCreate = new Error(`native setup exploded ${TOKEN}`)
  await assert.rejects(backend.send('prompt'), (error: unknown) => {
    const failure = error as { code?: string; message?: string }
    assert.equal(failure.code, 'RUNTIME_REQUEST_FAILED')
    assert.match(String(failure.message), /could not create session/)
    assertNoSecrets(String(failure.message))
    return true
  })
  await backend.close()
})

test('an already-coded native rejection keeps its code through the adapter boundary', async () => {
  const { backend, agents } = harness()
  agents.failResume = Object.assign(new Error('session "s-live" is already owned by an active write handle'), {
    name: 'SessionAlreadyOwnedError',
  })
  await assert.rejects(backend.command('resume', { sessionId: 's-live' }), (error: unknown) => {
    const failure = error as { code?: string; message?: string }
    assert.equal(failure.code, 'STALE_SESSION')
    return true
  })
  agents.failResume = Object.assign(new Error('native setup cancelled'), { code: 'ABORTED' })
  await assert.rejects(backend.command('resume', { sessionId: 's-live' }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'ABORTED')
    return true
  })
  await backend.close()
})

test('a raw unknown thrown object is never serialized into a diagnostic', async () => {
  const { asBackendError } = await import('../src/backend/errors.ts')
  // Synthetic shapes only: no real credential, profile or session value.
  const thrown = {
    api_key: 'TEST_ONLY_VALUE',
    stack: 'TEST_ONLY_STACK',
    cause: { token: 'TEST_ONLY_CAUSE' },
  }
  const failure = asBackendError(thrown)
  const text = `${failure.message}\n${failure.detail ?? ''}`
  for (const value of ['TEST_ONLY_VALUE', 'TEST_ONLY_STACK', 'TEST_ONLY_CAUSE', 'api_key', 'cause']) {
    assert.equal(text.includes(value), false, `leaked ${value}: ${text}`)
  }
  assert.equal(failure.message, 'the operation failed without a diagnostic message')
  assert.equal(failure.detail, undefined)
  assert.equal(failure.code, 'RUNTIME_REQUEST_FAILED')

  // Validated scalar fields are the only shape that can become a diagnostic.
  assert.equal(asBackendError({ message: 'native said no', stack: 'TEST_ONLY_STACK' }).message, 'native said no')
  assert.equal(asBackendError({ name: 'NativeFault', cause: { token: 'TEST_ONLY_CAUSE' } }).message, 'NativeFault')
  assert.equal(
    asBackendError(Object.assign(new Error(''), { name: 'NativeFault', stack: 'TEST_ONLY_STACK' })).message,
    'NativeFault',
  )
  assert.equal(asBackendError(undefined).message, 'the operation failed without a diagnostic message')
  assert.equal(asBackendError(42).message, '42')
  assert.equal(asBackendError([{ token: 'TEST_ONLY_CAUSE' }]).message, 'the operation failed without a diagnostic message')
})

test('enumerable stack and cause never reach an adapter diagnostic', async () => {
  const { backend, agents } = harness()
  const rejected = Object.assign(new Error('native resume failed'), {
    stack: 'TEST_ONLY_STACK',
    cause: { token: 'TEST_ONLY_CAUSE', api_key: 'TEST_ONLY_VALUE' },
    api_key: 'TEST_ONLY_VALUE',
  })
  agents.failResume = rejected
  await assert.rejects(backend.command('resume', { sessionId: 's-fields' }), (error: unknown) => {
    const failure = error as { code?: string; message?: string; detail?: string; stack?: string }
    assert.equal(failure.code, 'RUNTIME_REQUEST_FAILED')
    assert.match(String(failure.message), /could not resume session "s-fields": native resume failed/)
    for (const value of ['TEST_ONLY_STACK', 'TEST_ONLY_CAUSE', 'TEST_ONLY_VALUE']) {
      assert.equal(String(failure.message).includes(value), false, `leaked ${value}`)
      assert.equal(String(failure.detail ?? '').includes(value), false, `leaked ${value}`)
    }
    return true
  })
  await backend.close()
})

test('quoted JSON credential keys and escaped values are redacted in diagnostic strings', async () => {
  const { redactDiagnostic } = await import('../src/backend/errors.ts')
  const cases = [
    '{"api_key":"TEST_ONLY_VALUE"}',
    '{"apiKey": "TEST_ONLY_VALUE"}',
    '{"token": "TEST_ONLY_CAUSE"}',
    '{ "access-token" : "TEST_ONLY_TOKEN" }',
    "{'client-secret':'TEST_ONLY_SECRET'}",
    '{"Authorization":"Bearer TEST_ONLY_BEARER"}',
    '{"password":"TEST_ONLY_PASSWORD"}',
    '{"secret":"a\\"TEST_ONLY_TAIL"}',
  ]
  for (const text of cases) {
    const redacted = redactDiagnostic(text)
    for (const value of ['TEST_ONLY_VALUE', 'TEST_ONLY_CAUSE', 'TEST_ONLY_TOKEN', 'TEST_ONLY_SECRET', 'TEST_ONLY_BEARER', 'TEST_ONLY_PASSWORD', 'TEST_ONLY_TAIL']) {
      assert.equal(redacted.includes(value), false, `leaked ${value} in ${redacted}`)
    }
    assert.match(redacted, /\[redacted\]/)
    // The key itself stays readable: redaction replaces the value only.
    assert.match(redacted, /api_?[kK]ey|token|secret|password|authorization/i)
  }
  // Facts that are not credentials stay byte-identical.
  assert.equal(redactDiagnostic('model p1/m1 failed with HTTP 401'), 'model p1/m1 failed with HTTP 401')
  assert.equal(redactDiagnostic('request body is fine'), 'request body is fine')
})
