/**
 * Focused regressions for the in-process DSH adapter's P2 hardening:
 *
 * - strict native wire surface operations / seqs;
 * - native session-listing identity;
 * - bounded, cancellation/close-aware durable reads;
 * - cheap per-subagent-event capability detection (no Loader enumeration);
 * - in-flight native writes in the active-command/reload gate;
 * - close-during-materialization ownership;
 * - explicit preset roster DTO;
 * - cancellable native prompt admission (adapter bound only).
 *
 * Every service is a local fake; no profile, credential, session file, model
 * request or subprocess is touched.
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createDshBackend, type DshContextBackend, type DshContextBackendOptions } from '../src/backend/context.ts'
import type { BackendEvent, PromptContentPart, SessionInfo } from '../src/backend/types.ts'
import {
  FakeAgentRegistry,
  FakeDshHost,
  FakeSessionWorld,
  fakeNativeHelpers,
  nextTask,
  type FakeAgentState,
} from '../src/backend/testing.ts'

interface Harness {
  host: FakeDshHost
  agents: FakeAgentRegistry
  backend: DshContextBackend
  events: BackendEvent[]
  warnings: string[]
}

function harness(extra: (host: FakeDshHost) => void = () => {}, options: Partial<DshContextBackendOptions> = {}): Harness {
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
  host.use('agentPresets', {
    defaultId: 'standard',
    list: async () => [{ id: 'standard', name: 'Standard' }, { id: 'minimal', name: 'Minimal' }],
    resolve: async (id?: string) => ({ id: id ?? 'standard' }),
    select: async () => 'standard',
    presetForSession: () => null,
    composedPreset: () => undefined,
  })
  extra(host)
  const warnings: string[] = []
  const backend = createDshBackend(host, {
    cwd: '/workspace',
    native: fakeNativeHelpers(),
    warn: message => warnings.push(message),
    ...options,
  })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  return { host, agents, backend, events, warnings }
}

async function liveHarness(extra: (host: FakeDshHost) => void = () => {}): Promise<Harness & { agent: FakeAgentState; info: SessionInfo }> {
  const value = harness(extra)
  await value.backend.connect()
  await value.backend.send('prompt')
  const agent = value.agents.agents[0]
  assert.ok(agent)
  return { ...value, agent, info: await value.backend.connect() }
}

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await nextTask()
  }
  assert.fail(label)
}

function hasCode(code: string, message?: RegExp): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, code, `expected code ${code}: ${String(error)}`)
    if (message !== undefined) assert.match((error as Error).message, message)
    return true
  }
}

function activeCommandCount(backend: DshContextBackend): number {
  return (backend as unknown as { activeCommands: Map<string, unknown> }).activeCommands.size
}

function activeDurableReadCount(backend: DshContextBackend): number {
  return (backend as unknown as { activeDurableReads: Map<string, unknown> }).activeDurableReads.size
}

function liveOf(backend: DshContextBackend): unknown {
  return (backend as unknown as { live?: unknown }).live
}

function snapshotReader(backend: DshContextBackend): (sessionId: string) => Promise<unknown> {
  return (backend as unknown as { snapshotOf(id: string): Promise<unknown> }).snapshotOf.bind(backend)
}

function withTimerMock(t: TestContext): void {
  t.mock.timers.enable({ apis: ['setTimeout'] })
}

// ---------------------------------------------------------------- wire facts

test('a native replace surface op is accepted only with two real native seqs', async () => {
  const { host, backend, events, agent } = await liveHarness()
  const emit = (surfaceOp: unknown, seq = 3): void => {
    host.emit('session/event', agent.session, { type: 'system/message', seq, data: { text: 'x' }, surfaceOp })
  }
  const wire = (): Record<string, unknown> => {
    const event = events.filter(item => item.type === 'session_event').at(-1)
    assert.ok(event?.type === 'session_event')
    return event.event as unknown as Record<string, unknown>
  }

  emit({ op: 'replace', startSeq: 0, endSeq: 0 }, 4)
  assert.deepEqual(wire().surfaceOp, { op: 'replace', startSeq: 0, endSeq: 0 })
  assert.equal(wire().seq, 4)
  assert.equal(backend.transcriptCodec?.surfaceKind(wire() as never), 'replace')

  emit({ op: 'replace', startSeq: 0, endSeq: 7 }, 8)
  assert.deepEqual(wire().surfaceOp, { op: 'replace', startSeq: 0, endSeq: 7 })

  emit('append', 9)
  assert.equal(wire().surfaceOp, 'append')
  assert.equal(backend.transcriptCodec?.surfaceKind(wire() as never), 'append')

  // Every malformed placement is omitted: no NaN/Infinity/string/negative value
  // and no claimed replacement can ever reach the UI.
  const malformed: unknown[] = [
    { op: 'replace', startSeq: '1', endSeq: 2 },
    { op: 'replace', startSeq: 1, endSeq: null },
    { op: 'replace', startSeq: Number.NaN, endSeq: 2 },
    { op: 'replace', startSeq: 1, endSeq: Number.POSITIVE_INFINITY },
    { op: 'replace', startSeq: -1, endSeq: 2 },
    { op: 'replace', startSeq: 1.5, endSeq: 2 },
    { op: 'replace', startSeq: 1 },
    { op: 'replace', endSeq: 2 },
    { op: 'append2', startSeq: 1, endSeq: 2 },
    { op: 'replace', startSeq: 2 ** 60, endSeq: 2 },
    null,
    42,
    'replace',
  ]
  for (const value of malformed) {
    emit(value, 10)
    const event = wire()
    assert.equal(Object.hasOwn(event, 'surfaceOp'), false, `malformed op was forwarded: ${JSON.stringify(value)}`)
    assert.equal(backend.transcriptCodec?.surfaceKind(event as never), 'none')
    assert.equal(Object.is(event.seq, -0), false)
    assert.equal(Number.isFinite(event.seq), true)
  }
  await backend.close()
})

test('event seq and sourceEventSeqs never carry non-native numbers', async () => {
  const { host, backend, events, agent } = await liveHarness()
  const emit = (event: Record<string, unknown>): Record<string, unknown> => {
    host.emit('session/event', agent.session, event)
    const forwarded = events.filter(item => item.type === 'session_event').at(-1)
    assert.ok(forwarded?.type === 'session_event')
    return forwarded.event as unknown as Record<string, unknown>
  }

  const mixed = emit({
    type: 'user/message',
    seq: Number.NaN,
    time: Number.NaN,
    data: {},
    surfaceOp: 'append',
    sourceEventSeqs: [0, 1, '2', null, -1, 1.5, 3, Number.POSITIVE_INFINITY],
  })
  assert.equal(mixed.seq, 0, 'a non-native seq falls back to the existing missing-seq default')
  assert.equal(Object.hasOwn(mixed, 'time'), false, 'a non-finite wall clock is not a native time')
  assert.deepEqual(mixed.sourceEventSeqs, [0, 1, 3])
  assert.equal(mixed.surfaceOp, 'append')

  assert.equal(emit({ type: 'user/message', seq: -1, data: {}, surfaceOp: 'append' }).seq, 0)
  assert.equal(emit({ type: 'user/message', seq: 1.5, data: {}, surfaceOp: 'append' }).seq, 0)
  assert.equal(emit({ type: 'user/message', seq: 2 ** 60, data: {}, surfaceOp: 'append' }).seq, 0)
  assert.equal(emit({ type: 'user/message', seq: 12, data: {}, surfaceOp: 'append' }).seq, 12)
  await backend.close()
})

test('durable snapshots apply the same strict surface validation', async () => {
  const { backend } = harness((host) => {
    host.use('sessionQuery', {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readSession: async (id: string) => ({
        session: { id },
        inheritedEventCount: 0,
        events: [
          { type: 'user/message', seq: 0, data: {}, surfaceOp: 'append' },
          { type: 'system/message', seq: 1, data: {}, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } },
          { type: 'system/message', seq: 2, data: {}, surfaceOp: { op: 'replace', startSeq: '0', endSeq: 1 } },
          { type: 'system/message', seq: Number.NaN, data: {}, surfaceOp: 'append', sourceEventSeqs: [0, '1'] },
        ],
      }),
    })
  }, { resume: 'wire-session' })
  const info = await backend.connect()
  assert.equal(info.totalEvents, 4, 'every native log entry still travels')
  const events = info.events ?? []
  assert.deepEqual(events[0]?.surfaceOp, 'append')
  assert.deepEqual(events[1]?.surfaceOp, { op: 'replace', startSeq: 0, endSeq: 0 })
  assert.equal(Object.hasOwn(events[2] ?? {}, 'surfaceOp'), false, 'the malformed replacement is omitted')
  assert.equal(events[3]?.seq, 0)
  assert.deepEqual(events[3]?.sourceEventSeqs, [0])
  await backend.close()
})

// ------------------------------------------------------- session identity

test('session listing keeps native order and skips rows without a native identity', async () => {
  const titleIds: string[][] = []
  const rows: Array<Record<string, unknown>> = [
    { header: { id: 's1', cwd: '/w1', createdAt: 10 }, live: false },
    { header: {} },
    { header: { id: undefined } },
    { header: { id: '' } },
    { header: { id: 42 } },
    { live: true },
    { header: { id: 's2', cwd: '/w2', createdAt: 20 }, live: true },
    { header: { id: 'child', origin: 'subagent', createdAt: 30 } },
    { header: { id: 's3', cwd: '/w3', createdAt: 25 } },
  ]
  const { backend, warnings, agents } = await (async () => {
    const value = harness((host) => {
      host.use('sessionQuery', {
        listSessions: async () => rows,
        readTitleSnapshots: async (ids: readonly string[]) => {
          titleIds.push([...ids])
          return ids.map(id => ({ sessionId: id, status: 'fulfilled', value: { title: { title: `title-${id}` } } }))
        },
        readSession: async (id: string) => ({ session: { id }, events: [], inheritedEventCount: 0 }),
      })
    })
    await value.backend.connect()
    return value
  })()

  const sessions = await backend.command('sessions') as Array<Record<string, unknown>>
  assert.deepEqual(sessions.map(row => row.id), ['s1', 's2', 's3'], 'valid rows keep their native order')
  assert.equal(sessions.some(row => row.id === 'undefined'), false, 'no fabricated id')
  assert.deepEqual(titleIds, [['s1', 's2', 's3']], 'title enrichment only names real sessions')
  assert.equal(sessions[0]?.title, 'title-s1')
  assert.equal(sessions[1]?.live, true)
  assert.equal(sessions[1]?.cwd, '/w2')
  assert.equal(warnings.filter(message => /session identity/.test(message)).length, 1, 'one host diagnostic, not one per row')
  assert.match(warnings.at(-1) ?? '', /\b5 row\(s\)/)

  const bounded = await backend.command('sessions', { limit: 2, titles: false }) as Array<Record<string, unknown>>
  assert.deepEqual(bounded.map(row => row.id), ['s1', 's2'], 'the caller bound applies after filtering')
  assert.deepEqual(agents.createCalls, [], 'a read-only listing never materializes the pending Agent')
  await backend.close()
})

test('a raw native session-listing rejection becomes one coded, redacted diagnostic', async () => {
  const secret = 'sk-live-session-list-123456'
  const { backend } = await (async () => {
    const value = harness((host) => {
      host.use('sessionQuery', {
        listSessions: async () => { throw new Error(`Authorization: Bearer ${secret}`) },
        readTitleSnapshots: async () => [],
        readSession: async (id: string) => ({ session: { id }, events: [] }),
      })
    })
    await value.backend.connect()
    return value
  })()
  await assert.rejects(backend.command('sessions'), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'RUNTIME_REQUEST_FAILED')
    const message = (error as Error).message
    assert.equal(message.includes(secret), false)
    assert.match(message, /\[redacted\]/)
    assert.match(message, /native session listing failed/)
    return true
  })
  await backend.close()
})

// ----------------------------------------------------- durable read bounds

test('a malformed native listing envelope fails closed instead of emptying the picker', async () => {
  const value = harness((host) => {
    host.use('sessionQuery', {
      listSessions: async () => ({ sessions: [] }) as unknown as readonly unknown[],
      readTitleSnapshots: async () => [],
      readSession: async (id: string) => ({ session: { id }, events: [] }),
    })
  })
  await value.backend.connect()
  await assert.rejects(value.backend.command('sessions'), hasCode('RUNTIME_REQUEST_FAILED', /no session array/))
  await value.backend.close()
})

test('a stalled session listing is abandoned with a coded, bounded diagnostic', async (t) => {
  withTimerMock(t)
  const value = harness((host) => {
    host.use('sessionQuery', {
      listSessions: () => new Promise<never>(() => {}),
      readTitleSnapshots: async () => [],
      readSession: async (id: string) => ({ session: { id }, events: [] }),
    })
  })
  await value.backend.connect()
  const listing = value.backend.command('sessions')
  await nextTask()
  assert.equal(activeDurableReadCount(value.backend), 1, 'the read is owned while it is awaited')
  t.mock.timers.tick(5_000)
  await assert.rejects(listing, hasCode('RUNTIME_REQUEST_FAILED', /timed out after 5000ms/))
  assert.equal(activeDurableReadCount(value.backend), 0, 'every exit path releases the read')
  await value.backend.close()
})

test('a stalled title batch leaves titles unknown instead of hanging or inventing', async (t) => {
  withTimerMock(t)
  const rows = [
    { header: { id: 's1', cwd: '/w', createdAt: 10 }, live: false },
    { header: { id: 's2', cwd: '/w', createdAt: 20 }, live: false },
  ]
  const value = harness((host) => {
    host.use('sessionQuery', {
      listSessions: async () => rows,
      readTitleSnapshots: () => new Promise<never>(() => {}),
      readSession: async (id: string) => ({ session: { id }, events: [] }),
    })
  })
  await value.backend.connect()
  const listing = value.backend.command('sessions')
  await nextTask()
  t.mock.timers.tick(5_000)
  const sessions = await listing as Array<Record<string, unknown>>
  assert.deepEqual(sessions.map(row => row.id), ['s1', 's2'])
  assert.deepEqual(sessions.map(row => Object.hasOwn(row, 'title')), [false, false], 'a timed-out batch is unknown, never null')
  assert.ok(value.warnings.some(message => /session titles.*timed out after 5000ms/.test(message)))
  assert.equal(value.events.some(event => event.type === 'warning'), false, 'a title failure stays a host diagnostic')
  assert.equal(activeDurableReadCount(value.backend), 0)
  await value.backend.close()
})

test('a stalled root snapshot reports incomplete history instead of hanging', async (t) => {
  withTimerMock(t)
  const value = harness((host) => {
    host.use('sessionQuery', {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readSession: () => new Promise<never>(() => {}),
    })
  })
  await value.backend.connect()
  const resumed = value.backend.command('resume', { sessionId: 'stalled' })
  await until(() => activeDurableReadCount(value.backend) === 1, 'the durable snapshot read started')
  t.mock.timers.tick(5_000)
  const info = await resumed as SessionInfo
  assert.equal(info.sessionId, 'stalled')
  assert.equal(info.snapshotUnavailable, true)
  assert.equal(info.events, undefined)
  assert.equal(activeDurableReadCount(value.backend), 0)
  await value.backend.close()
})

test('close during a root snapshot rejects the materialization and never announces ready', async () => {
  const gate = deferred<void>()
  let readStarted = false
  const value = harness((host) => {
    host.use('sessionQuery', {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readSession: async (id: string) => {
        readStarted = true
        await gate.promise
        return { session: { id }, events: [], inheritedEventCount: 0 }
      },
    })
  })
  await value.backend.connect()
  const readyBefore = value.events.filter(event => event.type === 'ready').length
  const resumed = value.backend.command('resume', { sessionId: 'held-snapshot' })
  await until(() => readStarted, 'the durable read started')
  const closing = value.backend.close()
  gate.resolve()
  await assert.rejects(resumed, (error: unknown) => {
    const code = (error as { code?: string }).code
    assert.equal(code === 'ABORTED' || code === 'CLOSED', true, String(error))
    return true
  })
  await closing
  assert.equal(value.events.filter(event => event.type === 'ready').length, readyBefore, 'no ready follows close')
  assert.equal(value.agents.agents[0]?.disposed, true, 'the owned Agent was still disposed')
  await value.backend.close()
})

test('close during a session listing aborts the outstanding read', async () => {
  const gate = deferred<void>()
  let started = false
  const value = harness((host) => {
    host.use('sessionQuery', {
      listSessions: async () => {
        started = true
        await gate.promise
        return [{ header: { id: 's1' } }]
      },
      readTitleSnapshots: async () => [],
      readSession: async (id: string) => ({ session: { id }, events: [] }),
    })
  })
  await value.backend.connect()
  const listing = value.backend.command('sessions')
  await until(() => started, 'the listing started')
  const closing = value.backend.close()
  gate.resolve()
  await assert.rejects(listing, hasCode('ABORTED'))
  await closing
  assert.equal(activeDurableReadCount(value.backend), 0)
})

test('a snapshot for a replaced session is rejected instead of resurrecting it', async () => {
  const gate = deferred<void>()
  let started = false
  const value = harness((host) => {
    host.use('sessionQuery', {
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readSession: async (id: string) => {
        started = true
        await gate.promise
        return { session: { id }, events: [], inheritedEventCount: 0 }
      },
    })
  })
  await value.backend.connect()
  await value.backend.send('prompt')
  const oldSessionId = value.agents.agents[0]!.session.id
  const reading = snapshotReader(value.backend)(oldSessionId)
  await until(() => started, 'the snapshot read started')
  await value.backend.command('new')
  gate.resolve()
  await assert.rejects(reading, (error: unknown) => {
    const code = (error as { code?: string }).code
    assert.equal(code === 'ABORTED' || code === 'STALE_SESSION', true, String(error))
    return true
  })
  await value.backend.close()
})

// ------------------------------------------------------ capability refresh

test('subagent events never re-enumerate the Loader for capabilities', async () => {
  let loaderReads = 0
  const value = await liveHarness((host) => {
    host.use('loader', {
      entries: () => {
        loaderReads += 1
        return [{ options: { id: 'title-entry', name: '@deepseek-ai/dsh-session-title-first-prompt-llm' }, disabled: false }]
      },
    })
    host.use('sessionTitle', { refresh: () => {} })
  })
  const info = await value.backend.connect()
  assert.ok(info.capabilities.includes('auto-title'), 'the Loader-backed capability is still reported')
  const baseline = loaderReads
  for (let index = 0; index < 8; index += 1) {
    value.host.emit('subagent/start', { id: `child-${index}`, runId: `run-${index}`, local: true })
    value.host.emit('subagent/end', { id: `child-${index}`, runId: `run-${index}`, stopReason: 'completed', local: true })
  }
  await nextTask()
  await nextTask()
  assert.equal(loaderReads, baseline, 'a subagent frame is not a capability/loader audit')
  await value.backend.close()
})

test('a subagent service appearing later still re-announces on the same attachment', async () => {
  const world = new FakeSessionWorld()
  const value = harness((host) => { world.attach(host) })
  const first = await value.backend.connect()
  await value.backend.send('prompt')
  const before = value.events.filter(event => event.type === 'ready').length
  assert.equal(first.capabilities.includes('subagents'), false)
  value.host.use('subagents', { listDescendants: async () => [] })
  value.host.emit('subagent/start', { id: 'child-1', runId: 'run-1', local: true })
  await until(() => value.events.filter(event => event.type === 'ready').length > before, 'the refreshed ready')
  const ready = value.events.filter(event => event.type === 'ready').at(-1)
  assert.ok(ready?.type === 'ready')
  assert.ok(ready.info.capabilities.includes('subagents'))
  const live = await value.backend.connect()
  assert.equal(ready.info.sessionId, live.sessionId)
  assert.equal(ready.info.attachmentId, live.attachmentId, 'the same attachment is re-announced, not replaced')
  await value.backend.close()
})

// ------------------------------------------------ in-flight native writes

function heldStaging(): {
  readonly service: Record<string, unknown>
  readonly calls: Array<ReadonlyArray<unknown>>
  hold(): { release(): void }
} {
  const calls: Array<ReadonlyArray<unknown>> = []
  let pending: { promise: Promise<void>; release(): void } | undefined
  return {
    calls,
    service: {
      admitEncodedFile: async (input: unknown): Promise<unknown> => {
        calls.push([input])
        if (pending !== undefined) await pending.promise
        const item = input as { data: string; name?: string }
        return { attachmentId: 'file-1', name: item.name ?? 'file', bytes: Buffer.from(item.data, 'base64').length }
      },
    },
    hold() {
      const gate = deferred<void>()
      pending = { promise: gate.promise, release: () => gate.resolve() }
      return { release: () => gate.resolve() }
    },
  }
}

function hmrService(steps: string[]): Record<string, unknown> {
  return {
    runExclusive: async (operation: () => Promise<unknown>): Promise<unknown> => {
      steps.push('exclusive')
      return await operation()
    },
    reconcileProfile: async (): Promise<unknown> => {
      steps.push('reconcile')
      return {}
    },
  }
}

test('stageFile is an active native write: reload waits, caller abort and close release it', async () => {
  const staging = heldStaging()
  const reloads: string[] = []
  const value = harness((host) => {
    host.use('attachments', staging.service)
    host.use('hmr', hmrService(reloads))
  })
  await value.backend.connect()

  const held = staging.hold()
  const stagingRun = value.backend.stageFile({ data: 'AAEC', name: 'quarterly.csv' })
  await until(() => activeCommandCount(value.backend) === 1, 'staging is registered')
  await assert.rejects(value.backend.command('reload'), /wait for the current turn/)
  assert.deepEqual(reloads, [], 'no HMR work starts while the native write is in flight')
  held.release()
  const ref = await stagingRun
  assert.deepEqual(ref, { attachmentId: 'file-1', name: 'quarterly.csv', bytes: 3 })
  assert.equal(activeCommandCount(value.backend), 0, 'success releases the carrier')
  await value.backend.command('reload')
  assert.deepEqual(reloads, ['exclusive', 'reconcile'])

  // The caller's own cancellation still aborts the native-UI read.
  const callerGate = staging.hold()
  const controller = new AbortController()
  const cancelledRun = value.backend.stageFile({ data: 'AAEC' }, controller.signal)
  await until(() => activeCommandCount(value.backend) === 1, 'staging is registered')
  controller.abort()
  await assert.rejects(cancelledRun, hasCode('ABORTED'))
  assert.equal(activeCommandCount(value.backend), 0, 'caller cancellation releases the carrier')
  callerGate.release()

  // close() aborts the carrier and drains it instead of leaving a latch.
  const closeGate = staging.hold()
  const closingRun = value.backend.stageFile({ data: 'AAEC' })
  await until(() => activeCommandCount(value.backend) === 1, 'staging is registered')
  const closing = value.backend.close()
  await assert.rejects(closingRun, hasCode('ABORTED'))
  await closing
  assert.equal(activeCommandCount(value.backend), 0)
  closeGate.release()
})

function volatileSchema(field: string): unknown {
  return {
    uid: 10,
    refs: {
      10: { type: 'object', meta: {}, dict: { [field]: 11 } },
      11: { type: 'string', meta: { volatile: true } },
    },
  }
}

function defaultWriteFixture(): {
  readonly service: Record<string, unknown>
  readonly loader: Record<string, unknown>
  readonly calls: Array<{ ns: string; ops: readonly unknown[]; expectedRevision: number | undefined }>
  hold(): { release(): void }
  fail(error: unknown): void
  clear(): void
} {
  const state = { value: 'standard', revision: 2 }
  const calls: Array<{ ns: string; ops: readonly unknown[]; expectedRevision: number | undefined }> = []
  let pending: { promise: Promise<void>; release(): void } | undefined
  let failure: unknown
  return {
    calls,
    loader: {
      entries: () => [{
        options: { id: 'owner-profile-presets', name: '@deepseek-ai/dsh-agent-preset-registry' },
      }],
    },
    service: {
      describe: () => [{
        ns: 'owner-profile-presets',
        autoGenerate: false,
        schema: volatileSchema('selectedDefault'),
        value: { selectedDefault: state.value },
        base: {},
        user: {},
        revision: state.revision,
        applies: 'live',
      }],
      mutate: async (ns: string, ops: readonly { op: 'set'; path: readonly string[]; value: unknown }[], expectedRevision?: number) => {
        calls.push({ ns, ops, expectedRevision })
        if (pending !== undefined) await pending.promise
        if (failure !== undefined) throw failure
        const set = ops[0]
        if (set !== undefined) state.value = String(set.value)
        state.revision += 1
      },
    },
    hold() {
      const gate = deferred<void>()
      pending = { promise: gate.promise, release: () => gate.resolve() }
      return { release: () => gate.resolve() }
    },
    fail(error: unknown): void {
      failure = error
    },
    clear(): void {
      failure = undefined
    },
  }
}

test('native-default-update applies one exact fenced write and participates in reload idling', async () => {
  const fixture = defaultWriteFixture()
  const reloads: string[] = []
  const value = harness((host) => {
    host.use('settings', fixture.service)
    host.use('loader', fixture.loader)
    host.use('hmr', hmrService(reloads))
  })
  const info = await value.backend.connect()
  assert.ok(info.capabilities.includes('native-default-update'))
  assert.deepEqual(value.agents.createCalls, [], 'a session-less write materializes no Agent')

  const accepted = await value.backend.command('native-default-update', {
    target: 'agent-preset-default', value: 'minimal', expectedRevision: 2,
  }) as Record<string, unknown>
  assert.equal(accepted.ok, true)
  assert.equal(accepted.target, 'agent-preset-default')
  assert.equal(accepted.namespace, 'owner-profile-presets')
  assert.equal(accepted.field, 'selectedDefault')
  assert.equal(accepted.value, 'minimal')
  assert.equal(accepted.revision, 3)
  assert.equal(accepted.changed, true)
  assert.deepEqual(fixture.calls, [{
    ns: 'owner-profile-presets',
    ops: [{ op: 'set', path: ['selectedDefault'], value: 'minimal' }],
    expectedRevision: 2,
  }])

  // A confirmed revision mismatch is the native conflict outcome, not a throw.
  fixture.fail(Object.assign(new Error('native revision moved'), { code: 'SETTINGS_CONFLICT', expected: 3, actual: 9 }))
  const conflict = await value.backend.command('native-default-update', {
    target: 'agent-preset-default', value: 'minimal', expectedRevision: 3,
  }) as Record<string, unknown>
  assert.equal(conflict.ok, false)
  assert.equal(conflict.reason, 'conflict')
  assert.equal(conflict.actualRevision, 9)

  // An in-flight native write blocks profile recomposition until it settles.
  fixture.clear()
  const held = fixture.hold()
  const writing = value.backend.command('native-default-update', {
    target: 'agent-preset-default', value: 'minimal', expectedRevision: 3,
  })
  await until(() => activeCommandCount(value.backend) === 1, 'the default write is registered')
  await assert.rejects(value.backend.command('reload'), /wait for the current turn/)
  assert.deepEqual(reloads, [])
  held.release()
  const done = await writing as Record<string, unknown>
  assert.equal(done.ok, true)
  await until(() => activeCommandCount(value.backend) === 0, 'the write released its carrier')
  await value.backend.command('reload')
  assert.deepEqual(reloads, ['exclusive', 'reconcile'])
  await value.backend.close()
})

// --------------------------------------------- close-during-materialization

test('close during Agent creation discards the native Agent and publishes nothing', async () => {
  const value = harness()
  const gate = deferred<void>()
  let createStarted = false
  const original = value.agents.create.bind(value.agents)
  value.agents.create = async (options: unknown) => {
    createStarted = true
    await gate.promise
    return await original(options)
  }
  await value.backend.connect()
  const readyBefore = value.events.filter(event => event.type === 'ready').length
  const sending = value.backend.send('hello')
  await until(() => createStarted, 'create was called')
  assert.equal(liveOf(value.backend), undefined, 'the Agent is not published before creation settles')
  const closing = value.backend.close()
  gate.resolve()
  await assert.rejects(sending, hasCode('CLOSED'))
  await closing
  assert.equal(value.agents.agents[0]?.disposed, true, 'the adapter owned and disposed the created Agent')
  assert.equal(liveOf(value.backend), undefined)
  assert.equal(value.events.filter(event => event.type === 'ready').length, readyBefore, 'no ready during/after close')
  assert.equal(activeCommandCount(value.backend), 0)
})

test('close after commit but before the ready announcement suppresses the ready', async () => {
  const world = new FakeSessionWorld()
  const gate = deferred<void>()
  let listingStarted = false
  const value = harness((host) => {
    world.attach(host)
    host.use('subagents', {
      listDescendants: async () => {
        listingStarted = true
        await gate.promise
        return []
      },
    })
  })
  await value.backend.connect()
  const readyBefore = value.events.filter(event => event.type === 'ready').length
  const sending = value.backend.send('hello')
  await until(() => listingStarted, 'the materialization read started')
  const closing = value.backend.close()
  gate.resolve()
  await assert.rejects(sending, (error: unknown) => {
    const code = (error as { code?: string }).code
    assert.equal(code === 'CLOSED' || code === 'ABORTED', true, String(error))
    return true
  })
  await closing
  assert.equal(value.events.filter(event => event.type === 'ready').length, readyBefore, 'the suppressed ready never fires')
  assert.equal(value.agents.agents[0]?.disposed, true)
  assert.equal(liveOf(value.backend), undefined)
})

test('a commit failure rolls back publication before disposing the owned Agent', async () => {
  const value = harness()
  await value.backend.connect()
  const readyBefore = value.events.filter(event => event.type === 'ready').length
  ;(value.backend as unknown as { makeToolPresenter: () => undefined }).makeToolPresenter = () => {
    throw new Error('synthetic commit failure')
  }
  await assert.rejects(value.backend.send('hello'), /synthetic commit failure/)
  assert.equal(value.agents.agents[0]?.disposed, true)
  assert.equal(liveOf(value.backend), undefined, 'no half-committed Agent stays live')
  assert.equal(value.events.filter(event => event.type === 'ready').length, readyBefore)
  await value.backend.close()
})

// ------------------------------------------------------ preset roster DTO

test('presets expose only the documented native row fields plus adapter marks', async () => {
  const { backend } = await (async () => {
    const value = harness((host) => {
      host.use('agentPresets', {
        defaultId: 'standard',
        list: async () => [
          {
            id: 'standard', name: 'Standard', description: 'default work', order: 2,
            internalRoster: { secret: 'TEST_ONLY_INTERNAL' }, cachedComposition: ['never-copy'],
          },
          { id: 'minimal', name: 'Minimal', order: 1, extraUnknown: { token: 'TEST_ONLY_TOKEN' } },
          { id: 'broken', broken: 'missing tool', name: 42, order: 'first' },
        ],
        resolve: async (id?: string) => ({ id: id ?? 'standard' }),
        presetForSession: () => 'standard',
        composedPreset: () => undefined,
      })
    })
    await value.backend.connect()
    await value.backend.send('prompt')
    return value
  })()
  const catalog = await backend.command('presets') as Record<string, unknown>
  const rows = catalog.presets as Array<Record<string, unknown>>
  assert.deepEqual(rows.map(row => row.id), ['standard', 'minimal', 'broken'], 'native roster order and ids survive')
  assert.deepEqual(rows[0], {
    id: 'standard', name: 'Standard', description: 'default work', order: 2, current: true, isDefault: true,
  })
  assert.deepEqual(rows[1], { id: 'minimal', name: 'Minimal', order: 1, current: false })
  assert.deepEqual(Object.keys(rows[1] ?? {}).sort(), ['current', 'id', 'name', 'order'])
  assert.deepEqual(rows[2], { id: 'broken', broken: 'missing tool', current: false })
  const serialized = JSON.stringify(catalog)
  assert.equal(serialized.includes('TEST_ONLY_INTERNAL'), false, 'unknown native row fields never leak')
  assert.equal(serialized.includes('TEST_ONLY_TOKEN'), false)
  assert.equal(serialized.includes('cachedComposition'), false)
  assert.equal(catalog.default, 'standard')
  await backend.close()
})

// ------------------------------------------------ prompt admission cancel

function heldAdmission(): {
  readonly service: Record<string, unknown>
  readonly argumentCounts: number[]
  hold(): { release(): void }
} {
  const argumentCounts: number[] = []
  let pending: { promise: Promise<void>; release(): void } | undefined
  return {
    argumentCounts,
    service: {
      admitPromptContent: async (...args: unknown[]): Promise<readonly unknown[]> => {
        argumentCounts.push(args.length)
        if (pending !== undefined) await pending.promise
        const content = args[0] as readonly PromptContentPart[]
        return content.map(part => part.type === 'text'
          ? part
          : { type: 'image', attachment: { attachmentId: 'image-1', mediaType: 'image/png', bytes: 4, width: 2, height: 2 } })
      },
    },
    hold() {
      const gate = deferred<void>()
      pending = { promise: gate.promise, release: () => gate.resolve() }
      return { release: () => gate.resolve() }
    },
  }
}

const IMAGE_CONTENT: readonly PromptContentPart[] = [
  { type: 'text', text: 'look' },
  { type: 'image', mediaType: 'image/png', data: 'iVBORw0KGgo=' },
]

function messagesSent(agent: FakeAgentState): number {
  return agent.sent.length
}

test('Esc/cancel stops a native prompt admission and suppresses the late send', async () => {
  const admission = heldAdmission()
  const { backend, agent } = await liveHarness((host) => { host.use('attachments', admission.service) })
  const sentBefore = messagesSent(agent)
  const held = admission.hold()
  const sending = backend.sendContent(IMAGE_CONTENT)
  await until(() => activeCommandCount(backend) === 1, 'admission is registered')
  await backend.cancel()
  await assert.rejects(sending, hasCode('ABORTED'))
  assert.equal(activeCommandCount(backend), 0, 'cancel releases the carrier immediately')
  held.release()
  await nextTask()
  await nextTask()
  assert.equal(messagesSent(agent), sentBefore, 'a late native admission never becomes a sent message')
  assert.deepEqual(admission.argumentCounts, [1], 'native admitPromptContent receives content only, never a fabricated signal')
  await backend.close()
})

test('close and session switch both cancel an in-flight prompt admission', async () => {
  const admission = heldAdmission()
  const first = await liveHarness((host) => { host.use('attachments', admission.service) })
  const firstSent = messagesSent(first.agent)
  const held = admission.hold()
  const sending = first.backend.sendContent(IMAGE_CONTENT)
  await until(() => activeCommandCount(first.backend) === 1, 'admission is registered')
  const closing = first.backend.close()
  await assert.rejects(sending, (error: unknown) => {
    const code = (error as { code?: string }).code
    assert.equal(code === 'ABORTED' || code === 'CLOSED', true, String(error))
    return true
  })
  await closing
  held.release()
  await nextTask()
  assert.equal(messagesSent(first.agent), firstSent)
  assert.equal(activeCommandCount(first.backend), 0)

  const second = await liveHarness((host) => { host.use('attachments', admission.service) })
  const secondSent = messagesSent(second.agent)
  const switchGate = admission.hold()
  const switching = second.backend.sendContent(IMAGE_CONTENT)
  await until(() => activeCommandCount(second.backend) === 1, 'admission is registered')
  await second.backend.command('new')
  await assert.rejects(switching, (error: unknown) => {
    const code = (error as { code?: string }).code
    assert.equal(code === 'ABORTED' || code === 'STALE_SESSION', true, String(error))
    return true
  })
  switchGate.release()
  await nextTask()
  assert.equal(messagesSent(second.agent), secondSent, 'the retired Agent never receives a late message')
  assert.equal(activeCommandCount(second.backend), 0)
  await second.backend.close()
})

test('prompt admission has one adapter wall-clock bound', async (t) => {
  withTimerMock(t)
  const admission = heldAdmission()
  const { backend, agent } = await liveHarness((host) => { host.use('attachments', admission.service) })
  const sentBefore = messagesSent(agent)
  const held = admission.hold()
  const sending = backend.sendContent(IMAGE_CONTENT)
  await until(() => activeCommandCount(backend) === 1, 'admission is registered')
  t.mock.timers.tick(8_000)
  await assert.rejects(sending, hasCode('RUNTIME_REQUEST_FAILED', /timed out after 8000ms/))
  assert.equal(activeCommandCount(backend), 0)
  held.release()
  await nextTask()
  assert.equal(messagesSent(agent), sentBefore, 'a timed-out admission cannot send later')
  await backend.close()
})