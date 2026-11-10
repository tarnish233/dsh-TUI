/**
 * Offline contract tests for the adapter's two native history read faces:
 * `history-turns` over `sessionProjections.snapshot(session,['turnOutline'])`
 * and `history-window` over `sessionQuery.readEvent`.
 *
 * Every service is a local fake: no profile, credential, session log, model
 * request or subprocess is touched. `warn` is captured so redaction is real.
 */
import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createDshBackend, type DshContextBackend } from '../src/backend/context.ts'
import type { BackendEvent, HistoryTurnsResult, HistoryWindowResult, SessionInfo } from '../src/backend/types.ts'
import { FakeAgentRegistry, FakeDshHost, fakeNativeHelpers, nextTask, type FakeAgentState } from '../src/backend/testing.ts'

interface Harness {
  host: FakeDshHost
  agents: FakeAgentRegistry
  backend: DshContextBackend
  events: BackendEvent[]
  warnings: string[]
}

function harness(extra: (host: FakeDshHost) => void = () => {}, options: { resume?: string } = {}): Harness {
  const host = new FakeDshHost()
  const agents = new FakeAgentRegistry()
  host.use('agents', agents)
  host.use('agentDefaultModel', {
    currentSelection: () => ({ provider: 'p1', model: 'm1' }),
    saveSelection: async () => {},
  })
  extra(host)
  const warnings: string[] = []
  const backend = createDshBackend(host, {
    cwd: '/workspace',
    native: fakeNativeHelpers(),
    warn: (message: string) => warnings.push(message),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
  })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  return { host, agents, backend, events, warnings }
}

async function liveHarness(
  extra: (host: FakeDshHost) => void = () => {},
): Promise<Harness & { agent: FakeAgentState; info: SessionInfo }> {
  const value = harness(extra)
  const pending = await value.backend.connect()
  await value.backend.send('prompt')
  const agent = value.agents.agents[0]
  assert.ok(agent)
  const info = await value.backend.connect()
  assert.equal(info.sessionId, pending.sessionId)
  return { ...value, agent, info }
}

function hasCode(...codes: string[]): (error: unknown) => boolean {
  return (error: unknown) => codes.includes(String((error as { code?: unknown }).code))
}

/** Public carrier read face only; `stateOf` is a trap the adapter must never touch. */
class FakeProjections {
  readonly snapshotCalls: Array<{ session: unknown; keys: readonly string[] | undefined }> = []
  stateOfCalls = 0
  value: unknown = { asOfSeq: 4, values: { turnOutline: [] } }
  fail: Error | undefined
  /** Fail only cuts that request one of these keys (title/metrics reads stay healthy). */
  failFor: readonly string[] | undefined

  snapshot(session: unknown, keys?: readonly string[]): unknown {
    this.snapshotCalls.push({ session, keys })
    const shouldFail = this.fail !== undefined &&
      (this.failFor === undefined || (keys ?? []).some(key => this.failFor?.includes(key) === true))
    if (shouldFail) throw this.fail
    return this.value
  }

  stateOf(): unknown {
    this.stateOfCalls += 1
    throw new Error('sessionProjections.stateOf must never be read')
  }

  onChanged(): () => void {
    return () => {}
  }
}

function eventWindow(events: Array<Record<string, unknown>>, bounds: { startSeq: number; endSeq: number; inheritedEventCount?: number }): Record<string, unknown> {
  return {
    session: { id: 's1' },
    inheritedEventCount: bounds.inheritedEventCount ?? 0,
    target: events.find(event => event.seq === 3),
    events,
    startSeq: bounds.startSeq,
    endSeq: bounds.endSeq,
  }
}

function seqEvents(start: number, count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    type: 'user/message',
    seq: start + index,
    time: 1000 + start + index,
    data: { index: start + index },
    surfaceOp: 'append',
  }))
}

test('history-turns reads exactly one turnOutline cut and never the deprecated stateOf fold', async () => {
  const projections = new FakeProjections()
  projections.value = {
    asOfSeq: 12,
    values: {
      turnOutline: [
        { turn: 1, seq: 0, prompt: 'first ask', response: 'first answer', ignored: 'native extra' },
        { turn: 2, seq: 7, prompt: '', response: 'second answer' },
      ],
      title: 'not requested',
    },
  }
  const { backend, agents, agent } = await liveHarness(host => host.use('sessionProjections', projections))
  const result = await backend.command('history-turns') as HistoryTurnsResult
  assert.deepEqual(result, {
    available: true,
    sessionId: agent.id,
    attachmentId: (await backend.connect()).attachmentId,
    asOfSeq: 12,
    entries: [
      { turn: 1, seq: 0, prompt: 'first ask', response: 'first answer' },
      { turn: 2, seq: 7, prompt: '', response: 'second answer' },
    ],
  })
  const outlineCalls = projections.snapshotCalls.filter(call => call.keys?.includes('turnOutline') === true)
  assert.equal(outlineCalls.length, 1, 'exactly one turnOutline cut is requested')
  assert.equal(outlineCalls[0]?.session, agent.session, 'the exact live session object is read')
  assert.deepEqual(outlineCalls[0]?.keys, ['turnOutline'], 'only the outline key is requested')
  assert.equal(projections.stateOfCalls, 0, 'stateOf is the deprecated raw fold and is never called')
  assert.equal(agents.createCalls.length, 1, 'a live read never creates another Agent')
  await backend.close()
})

test('history-turns answers unavailable for absent, corrupt or non-increasing native outlines', async () => {
  const cases: Array<{ name: string; value: unknown }> = [
    { name: 'no snapshot value', value: undefined },
    { name: 'no values object', value: { asOfSeq: 0 } },
    { name: 'turnOutline is not an array', value: { asOfSeq: 0, values: { turnOutline: {} } } },
    { name: 'unsafe turn', value: { asOfSeq: 0, values: { turnOutline: [{ turn: -1, seq: 0, prompt: '', response: '' }] } } },
    { name: 'fractional turn', value: { asOfSeq: 0, values: { turnOutline: [{ turn: 1.5, seq: 0, prompt: '', response: '' }] } } },
    { name: 'string seq', value: { asOfSeq: 0, values: { turnOutline: [{ turn: 1, seq: '0', prompt: '', response: '' }] } } },
    { name: 'negative-zero seq', value: { asOfSeq: 0, values: { turnOutline: [{ turn: 1, seq: -0, prompt: '', response: '' }] } } },
    { name: 'non-string prompt', value: { asOfSeq: 0, values: { turnOutline: [{ turn: 1, seq: 0, prompt: 7, response: '' }] } } },
    { name: 'missing response', value: { asOfSeq: 0, values: { turnOutline: [{ turn: 1, seq: 0, prompt: '' }] } } },
    {
      name: 'non-increasing turn',
      value: { asOfSeq: 0, values: { turnOutline: [
        { turn: 2, seq: 0, prompt: '', response: '' },
        { turn: 2, seq: 3, prompt: '', response: '' },
      ] } },
    },
    {
      name: 'non-increasing seq',
      value: { asOfSeq: 0, values: { turnOutline: [
        { turn: 1, seq: 5, prompt: '', response: '' },
        { turn: 2, seq: 5, prompt: '', response: '' },
      ] } },
    },
    { name: 'malformed asOfSeq only', value: { asOfSeq: 'x', values: { turnOutline: [] } } },
  ]
  for (const entry of cases) {
    const projections = new FakeProjections()
    projections.value = entry.value
    const { backend, agents } = await liveHarness(host => host.use('sessionProjections', projections))
    const result = await backend.command('history-turns') as HistoryTurnsResult
    // A malformed cut is unavailable, never a fabricated empty outline.
    if (entry.name === 'malformed asOfSeq only') {
      assert.equal(result.available, true, entry.name)
      assert.deepEqual(result.entries, [], entry.name)
      assert.equal(Object.hasOwn(result, 'asOfSeq'), false, entry.name)
    } else {
      assert.equal(result.available, false, entry.name)
      assert.deepEqual(result.entries, [], entry.name)
    }
    assert.equal(agents.createCalls.length, 1, entry.name)
    await backend.close()
  }
})

test('history-turns stays unavailable without the projection service and reports a failed cut once', async () => {
  const missing = await liveHarness()
  const absent = await missing.backend.command('history-turns') as HistoryTurnsResult
  assert.equal(absent.available, false)
  assert.deepEqual(absent.entries, [])
  assert.equal(missing.agents.createCalls.length, 1)
  await missing.backend.close()

  const projections = new FakeProjections()
  projections.failFor = ['turnOutline']
  projections.fail = new Error('snapshot exploded with api_key=sk-live-secret')
  const failed = await liveHarness(host => host.use('sessionProjections', projections))
  const before = failed.warnings.length
  const result = await failed.backend.command('history-turns') as HistoryTurnsResult
  assert.equal(result.available, false)
  assert.equal(failed.warnings.length, before + 1)
  assert.doesNotMatch(failed.warnings.at(-1) ?? '', /sk-live-secret/)
  await failed.backend.close()
})

test('history-turns on a pending attachment answers unavailable without materializing an Agent', async () => {
  const projections = new FakeProjections()
  const value = harness(host => host.use('sessionProjections', projections))
  const info = await value.backend.connect()
  const result = await value.backend.command('history-turns') as HistoryTurnsResult
  assert.deepEqual(result, {
    available: false,
    sessionId: info.sessionId,
    attachmentId: info.attachmentId,
    entries: [],
  })
  assert.equal(projections.snapshotCalls.length, 0, 'a pending attachment owns no native Session to snapshot')
  assert.deepEqual(value.agents.createCalls, [], 'history-turns never materializes a pending session')
  await value.backend.close()
})

test('history reads reject another session/attachment identity and validate parameter types', async () => {
  const projections = new FakeProjections()
  const value = await liveHarness(host => host.use('sessionProjections', projections))
  const info = await value.backend.connect()
  const ok = await value.backend.command('history-turns', { sessionId: info.sessionId, attachmentId: info.attachmentId }) as HistoryTurnsResult
  assert.equal(ok.available, true)
  await assert.rejects(value.backend.command('history-turns', { sessionId: 'other' }), hasCode('STALE_SESSION'))
  await assert.rejects(value.backend.command('history-turns', { attachmentId: 'other' }), hasCode('STALE_SESSION'))
  await assert.rejects(value.backend.command('history-turns', { sessionId: 7 }), hasCode('INVALID_ARGUMENT'))
  await assert.rejects(
    value.backend.command('history-window', { sessionId: 'other', seq: 0 }),
    hasCode('STALE_SESSION'),
  )
  await assert.rejects(
    value.backend.command('workspace-change-diff', { attachmentId: 'other', seq: 0, index: 0 }),
    hasCode('STALE_SESSION'),
  )
  await value.backend.close()
})

test('history-window forwards the exact native request/signal and maps the whole window envelope', async () => {
  const calls: Array<{ request: unknown; signal: AbortSignal }> = []
  let abortedAfterCall = false
  const { backend, agents, agent, info } = await liveHarness((host) => {
    host.use('tools', {
      get: (name: string) => name === 'bash'
        ? { presentCall: (args: unknown) => ({ card: 'terminal', title: String((args as { command?: unknown }).command), cwd: '/workspace' }) }
        : undefined,
    })
    host.use('sessionQuery', {
      readSession: async () => ({ session: { id: 'x' }, events: [], inheritedEventCount: 0 }),
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readEvent: async (request: unknown, signal?: AbortSignal) => {
        calls.push({ request, signal: signal as AbortSignal })
        abortedAfterCall = signal?.aborted === true
        return eventWindow([
          { type: 'user/message', seq: 2, time: 20, data: { content: [{ type: 'text', text: 'a' }] }, surfaceOp: 'append' },
          { type: 'tool/call', seq: 3, time: 30, data: { callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' } },
          { type: 'assistant/message', seq: 4, time: 40, data: { message: { content: [{ type: 'text', text: 'b' }] } }, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2, 'x', -1] },
        ], { startSeq: 2, endSeq: 4, inheritedEventCount: 1 })
      },
    })
  })
  const result = await backend.command('history-window', { seq: 3, before: 1, after: 1 }) as HistoryWindowResult
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.request, { sessionId: agent.id, seq: 3, before: 1, after: 1 })
  assert.ok(calls[0]?.signal instanceof AbortSignal)
  assert.equal(abortedAfterCall, false, 'the native read starts with a live owned signal')
  assert.equal(calls[0]?.signal.aborted, true, 'the owned signal is aborted once the read settles')
  assert.deepEqual(result, {
    sessionId: agent.id,
    attachmentId: info.attachmentId,
    targetSeq: 3,
    startSeq: 2,
    endSeq: 4,
    inheritedEventCount: 1,
    hasOlder: true,
    events: [
      { type: 'user/message', seq: 2, time: 20, data: { content: [{ type: 'text', text: 'a' }] }, surfaceOp: 'append' },
      { type: 'tool/call', seq: 3, time: 30, data: { callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }, toolPresentation: { call: { card: 'terminal', title: 'ls', cwd: '/workspace' } } },
      { type: 'assistant/message', seq: 4, time: 40, data: { message: { content: [{ type: 'text', text: 'b' }] } }, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] },
    ],
  })
  assert.equal(agents.createCalls.length, 1, 'a live read never creates another Agent')
  await backend.close()
})

test('history-window proves hasOlder only from a non-zero startSeq', async () => {
  const make = (startSeq: number, endSeq: number) => {
    const events = seqEvents(startSeq, endSeq - startSeq + 1)
    return harness((host) => {
      host.use('sessionQuery', {
        readSession: async () => ({ session: { id: 'x' }, events: [], inheritedEventCount: 0 }),
        listSessions: async () => [],
        readTitleSnapshots: async () => [],
        readEvent: async () => eventWindow(events, { startSeq, endSeq }),
      })
    })
  }
  const atZero = make(0, 0)
  await atZero.backend.connect()
  await atZero.backend.send('p')
  const first = await atZero.backend.command('history-window', { seq: 0 }) as HistoryWindowResult
  assert.equal(first.hasOlder, false)
  assert.equal(first.startSeq, 0)
  assert.equal(first.inheritedEventCount, 0)
  assert.equal(Object.hasOwn(first, 'hasNewer'), false, 'no unsupported hasNewer claim')
  await atZero.backend.close()

  const later = make(5, 7)
  await later.backend.connect()
  await later.backend.send('p')
  const second = await later.backend.command('history-window', { seq: 6, before: 1, after: 1 }) as HistoryWindowResult
  assert.equal(second.hasOlder, true)
  assert.equal(second.startSeq, 5)
  assert.equal(second.endSeq, 7)
  await later.backend.close()
})

test('history-window validates the native seq and the 0..50 window bounds before calling native', async () => {
  const calls: unknown[] = []
  const { backend } = await liveHarness((host) => {
    host.use('sessionQuery', {
      readSession: async () => ({ session: { id: 'x' }, events: [], inheritedEventCount: 0 }),
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readEvent: async (request: unknown) => {
        calls.push(request)
        const seq = (request as { seq: number }).seq
        return eventWindow(seqEvents(seq, 1), { startSeq: seq, endSeq: seq })
      },
    })
  })
  for (const seq of [undefined, -1, 1.5, '3', Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(backend.command('history-window', { seq }), hasCode('INVALID_ARGUMENT'), `seq ${String(seq)}`)
  }
  for (const bound of [-1, 51, 1.5, '5']) {
    await assert.rejects(backend.command('history-window', { seq: 0, before: bound }), hasCode('INVALID_ARGUMENT'), `before ${String(bound)}`)
    await assert.rejects(backend.command('history-window', { seq: 0, after: bound }), hasCode('INVALID_ARGUMENT'), `after ${String(bound)}`)
  }
  assert.deepEqual(calls, [], 'invalid arguments never reach the native reader')
  const accepted = await backend.command('history-window', { seq: 0, before: 50, after: 50 }) as HistoryWindowResult
  assert.equal(accepted.targetSeq, 0)
  assert.deepEqual(calls[0], { sessionId: (accepted as HistoryWindowResult).sessionId, seq: 0, before: 50, after: 50 })
  await backend.close()
})

test('history-window rejects every malformed native window instead of returning an empty corpus', async () => {
  const valid = seqEvents(2, 3)
  const cases: Array<{ name: string; value: unknown }> = [
    { name: 'undefined response', value: undefined },
    { name: 'non-object response', value: 'events' },
    { name: 'missing inherited count', value: { events: valid, startSeq: 2, endSeq: 4 } },
    { name: 'negative inherited count', value: { events: valid, startSeq: 2, endSeq: 4, inheritedEventCount: -1 } },
    { name: 'string startSeq', value: { events: valid, startSeq: '2', endSeq: 4, inheritedEventCount: 0 } },
    { name: 'reversed bounds', value: { events: valid, startSeq: 4, endSeq: 2, inheritedEventCount: 0 } },
    { name: 'target outside window', value: { events: valid, startSeq: 3, endSeq: 4, inheritedEventCount: 0 } },
    { name: 'events not an array', value: { events: {}, startSeq: 2, endSeq: 4, inheritedEventCount: 0 } },
    { name: 'count mismatch', value: { events: valid.slice(0, 2), startSeq: 2, endSeq: 4, inheritedEventCount: 0 } },
    { name: 'non-contiguous events', value: { events: [valid[0], valid[2]], startSeq: 2, endSeq: 3, inheritedEventCount: 0 } },
    { name: 'event without seq', value: { events: [{ type: 'x' }, valid[1], valid[2]], startSeq: 2, endSeq: 4, inheritedEventCount: 0 } },
    { name: 'event with unsafe seq', value: { events: [{ ...valid[0], seq: -0 }, valid[1], valid[2]], startSeq: 2, endSeq: 4, inheritedEventCount: 0 } },
  ]
  for (const entry of cases) {
    const { backend } = await liveHarness((host) => {
      host.use('sessionQuery', {
        readSession: async () => ({ session: { id: 'x' }, events: [], inheritedEventCount: 0 }),
        listSessions: async () => [],
        readTitleSnapshots: async () => [],
        readEvent: async () => entry.value,
      })
    })
    await assert.rejects(
      backend.command('history-window', { seq: 3, before: 1, after: 1 }),
      hasCode('RUNTIME_REQUEST_FAILED'),
      entry.name,
    )
    await backend.close()
  }
})

test('history-window is unavailable without readEvent and never creates an Agent while pending', async () => {
  const missing = harness()
  await missing.backend.connect()
  const info = await missing.backend.connect()
  assert.equal(info.capabilities.includes('history-window'), false)
  await assert.rejects(missing.backend.command('history-window', { seq: 0 }), hasCode('NOT_CONNECTED'))
  assert.deepEqual(missing.agents.createCalls, [], 'a pending history read never materializes an Agent')
  await missing.backend.close()

  const queryOnly = await liveHarness((host) => {
    host.use('sessionQuery', {
      readSession: async () => ({ session: { id: 'x' }, events: [], inheritedEventCount: 0 }),
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
    })
  })
  const read = await liveHarness()
  await read.backend.close()
  const info2 = await queryOnly.backend.connect()
  assert.equal(info2.capabilities.includes('history-window'), false)
  await assert.rejects(queryOnly.backend.command('history-window', { seq: 0 }), hasCode('CAPABILITY_UNAVAILABLE'))
  await queryOnly.backend.close()
})

test('history-window aborts on close and on an attachment switch without publishing a late window', async () => {
  let release: (() => void) | undefined
  const signals: AbortSignal[] = []
  const { backend } = await liveHarness((host) => {
    host.use('sessionQuery', {
      readSession: async () => ({ session: { id: 'x' }, events: [], inheritedEventCount: 0 }),
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readEvent: async (_request: unknown, signal?: AbortSignal) => {
        signals.push(signal as AbortSignal)
        return await new Promise((_resolve, reject) => {
          const abort = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
          if (signal?.aborted === true) abort()
          else signal?.addEventListener('abort', abort, { once: true })
          release = () => reject(Object.assign(new Error('released late'), { code: 'LATE' }))
        })
      },
    })
  })
  const pending = backend.command('history-window', { seq: 3 })
  await nextTask()
  assert.equal(signals.length, 1)
  await backend.close()
  await assert.rejects(pending, hasCode('ABORTED', 'CLOSED'))
  assert.equal(signals[0]?.aborted, true)
  release?.()

  const switched = await liveHarness((host) => {
    host.use('sessionQuery', {
      readSession: async () => ({ session: { id: 'x' }, events: [], inheritedEventCount: 0 }),
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readEvent: async (_request: unknown, signal?: AbortSignal) => await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })
      }),
    })
  })
  const inflight = switched.backend.command('history-window', { seq: 1 })
  await nextTask()
  const next = await switched.backend.command('new') as SessionInfo
  assert.notEqual(next.sessionId, switched.agent.id)
  await assert.rejects(inflight, hasCode('ABORTED', 'STALE_SESSION', 'CLOSED'))
  await switched.backend.close()
})

test('history-window normalizes a native rejection to a coded, redacted diagnostic', async () => {
  const { backend } = await liveHarness((host) => {
    host.use('sessionQuery', {
      readSession: async () => ({ session: { id: 'x' }, events: [], inheritedEventCount: 0 }),
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readEvent: async () => { throw new Error('native window failed: Authorization: Bearer sk-live-deadbeef') },
    })
  })
  await assert.rejects(backend.command('history-window', { seq: 2 }), (error: unknown) => {
    const coded = error as { code?: string; message?: string }
    assert.equal(coded.code, 'RUNTIME_REQUEST_FAILED')
    assert.doesNotMatch(String(coded.message), /sk-live-deadbeef/)
    assert.match(String(coded.message), /\[redacted\]/)
    return true
  })
  await backend.close()
})
// ------------------------------------------- proven native readWindowMax (R7)

/**
 * Native-shaped window rejection.
 *
 * The official reader throws `SessionQueryError`
 * `SESSION_QUERY_INVALID_WINDOW` with `` `${name} must be an integer between 0
 * and ${readWindowMax}` ``; these tests reproduce that exact public diagnostic
 * and nothing else.
 */
function nativeWindowError(name: 'before' | 'after', limit: number): Error {
  return Object.assign(new Error(`${name} must be an integer between 0 and ${limit}`), {
    code: 'SESSION_QUERY_INVALID_WINDOW',
  })
}

interface WindowCall {
  readonly before: number | undefined
  readonly after: number | undefined
}

/**
 * Offline stand-in for `sessionQuery.readEvent` with a configurable
 * `readWindowMax`, sliced exactly like the shipped implementation.
 */
function boundedSessionQuery(limit: number, calls: WindowCall[], total = 13): Record<string, unknown> {
  const log = seqEvents(0, total)
  return {
    readSession: async () => ({ session: { id: 'x' }, events: [], inheritedEventCount: 0 }),
    listSessions: async () => [],
    readTitleSnapshots: async () => [],
    readEvent: async (request: unknown) => {
      const { seq, before = 0, after = 0 } = request as { seq: number; before?: number; after?: number }
      calls.push({ before, after })
      if (request === null || typeof request !== 'object') throw nativeWindowError('before', limit)
      if (before > limit) throw nativeWindowError('before', limit)
      if (after > limit) throw nativeWindowError('after', limit)
      const startSeq = Math.max(0, seq - before)
      const endSeq = Math.min(log.length - 1, seq + after)
      return eventWindow(log.slice(startSeq, endSeq + 1), { startSeq, endSeq })
    },
  }
}

function activeDurableReadCount(backend: DshContextBackend): number {
  return (backend as unknown as { activeDurableReads: Map<string, unknown> }).activeDurableReads.size
}

function withTimerMock(t: TestContext): void {
  t.mock.timers.enable({ apis: ['setTimeout'] })
}

test('history-window narrows to a proven smaller native readWindowMax once, then reuses it', async () => {
  const calls: WindowCall[] = []
  const value = await liveHarness((host) => {
    host.use('sessionQuery', boundedSessionQuery(20, calls))
  })
  const warnings = [...value.warnings]
  const first = await value.backend.command('history-window', { seq: 6, before: 50, after: 50 }) as HistoryWindowResult
  assert.deepEqual(calls, [
    { before: 50, after: 50 },
    { before: 20, after: 20 },
  ], 'the adapter asks for the TUI cap, then retries exactly once inside the proven native bound')
  assert.equal(first.targetSeq, 6)
  assert.equal(first.startSeq, 0, 'the narrowed window stays inside 6 - 20')
  assert.equal(first.endSeq, 12, 'the narrowed window ends at the native log end')
  assert.deepEqual(value.warnings, warnings, 'successful bound adaptation never writes a routine warning into the live transcript')

  // A later page reuses the proven bound: no second failing read, no widening.
  const second = await value.backend.command('history-window', { seq: 6, before: 50, after: 0 }) as HistoryWindowResult
  assert.deepEqual(calls.slice(2), [{ before: 20, after: 0 }], 'subsequent pages are narrowed before dispatch')
  assert.equal(second.startSeq, 0)
  assert.equal(second.endSeq, 6)

  // A narrower caller request is never widened to the proven maximum.
  const third = await value.backend.command('history-window', { seq: 6, before: 3, after: 2 }) as HistoryWindowResult
  assert.deepEqual(calls.at(-1), { before: 3, after: 2 })
  assert.equal(third.startSeq, 3)
  assert.equal(third.endSeq, 8)
  assert.equal(calls.length, 4, 'exactly one retry happened in total')
  assert.deepEqual(value.warnings, warnings, 'reuse and smaller caller windows remain silent native reads')
  await value.backend.close()
})

test('history-window honours a proven 0 and 1 native bound without widening later reads', async () => {
  const zeroCalls: WindowCall[] = []
  const zero = await liveHarness((host) => {
    host.use('sessionQuery', boundedSessionQuery(0, zeroCalls))
  })
  const exact = await zero.backend.command('history-window', { seq: 4, before: 1, after: 0 }) as HistoryWindowResult
  assert.deepEqual(zeroCalls, [{ before: 1, after: 0 }, { before: 0, after: 0 }], 'a proven 0 clamps both sides')
  assert.equal(exact.startSeq, 4)
  assert.equal(exact.endSeq, 4)
  const reused = await zero.backend.command('history-window', { seq: 4, before: 50, after: 50 }) as HistoryWindowResult
  assert.deepEqual(zeroCalls.at(-1), { before: 0, after: 0 }, 'a proven 0 is reused, never re-negotiated from 50')
  assert.equal(reused.startSeq, 4)
  assert.equal(reused.endSeq, 4)
  await zero.backend.close()

  const oneCalls: WindowCall[] = []
  const one = await liveHarness((host) => {
    host.use('sessionQuery', boundedSessionQuery(1, oneCalls))
  })
  const single = await one.backend.command('history-window', { seq: 3, before: 50, after: 50 }) as HistoryWindowResult
  assert.deepEqual(oneCalls, [{ before: 50, after: 50 }, { before: 1, after: 1 }])
  assert.equal(single.startSeq, 2)
  assert.equal(single.endSeq, 4)
  await one.backend.close()
})

test('history-window never retries a generic, malformed, non-matching or widening native failure', async () => {
  const cases: Array<{ name: string; failure: unknown }> = [
    { name: 'generic error', failure: new Error('before must be an integer between 0 and 20') },
    { name: 'unrelated native code', failure: Object.assign(new Error('before must be an integer between 0 and 20'), { code: 'SESSION_QUERY_INVALID_FILTER' }) },
    { name: 'paraphrased message', failure: Object.assign(new Error('before/after must be an integer between 0 and 20'), { code: 'SESSION_QUERY_INVALID_WINDOW' }) },
    { name: 'trailing text', failure: Object.assign(new Error('before must be an integer between 0 and 20 (profile)'), { code: 'SESSION_QUERY_INVALID_WINDOW' }) },
    { name: 'negative bound', failure: Object.assign(new Error('before must be an integer between 0 and -1'), { code: 'SESSION_QUERY_INVALID_WINDOW' }) },
    { name: 'fractional bound', failure: Object.assign(new Error('before must be an integer between 0 and 20.5'), { code: 'SESSION_QUERY_INVALID_WINDOW' }) },
    { name: 'non-string message', failure: { code: 'SESSION_QUERY_INVALID_WINDOW', message: 20 } },
    { name: 'non-object value', failure: 'SESSION_QUERY_INVALID_WINDOW' },
    { name: 'bound above the TUI cap', failure: Object.assign(new Error('before must be an integer between 0 and 100'), { code: 'SESSION_QUERY_INVALID_WINDOW' }) },
    { name: 'bound equal to the request', failure: Object.assign(new Error('before must be an integer between 0 and 20'), { code: 'SESSION_QUERY_INVALID_WINDOW' }) },
  ]
  for (const entry of cases) {
    const calls: WindowCall[] = []
    // The "equal to the request" case asks for 20/20; every other case asks
    // for the TUI cap of 50/50.
    const request = entry.name === 'bound equal to the request' ? { seq: 6, before: 20, after: 20 } : { seq: 6, before: 50, after: 50 }
    const value = await liveHarness((host) => {
      host.use('sessionQuery', {
        readSession: async () => ({ session: { id: 'x' }, events: [], inheritedEventCount: 0 }),
        listSessions: async () => [],
        readTitleSnapshots: async () => [],
        readEvent: async (payload: unknown) => {
          const { before, after } = payload as { before: number; after: number }
          calls.push({ before, after })
          throw entry.failure
        },
      })
    })
    await assert.rejects(
      value.backend.command('history-window', request),
      hasCode('RUNTIME_REQUEST_FAILED'),
      entry.name,
    )
    assert.deepEqual(calls, [{ before: request.before, after: request.after }], `${entry.name}: exactly one native read`)
    assert.equal(
      value.warnings.some(message => /accepts at most/.test(message)),
      false,
      `${entry.name}: no bound is learned from an unproven failure`,
    )
    await value.backend.close()
  }
})

test('history-window keeps one durable carrier and one shared deadline across the single retry', async (t) => {
  withTimerMock(t)
  let rounds = 0
  const value = await liveHarness((host) => {
    host.use('sessionQuery', {
      readSession: async () => ({ session: { id: 'x' }, events: [], inheritedEventCount: 0 }),
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readEvent: async () => {
        rounds += 1
        if (rounds === 1) throw nativeWindowError('before', 20)
        // The narrowed retry stalls: it must be abandoned by the SAME 5 s
        // durableRead deadline, not a fresh one.
        return await new Promise<never>(() => {})
      },
    })
  })
  const window = value.backend.command('history-window', { seq: 6, before: 50, after: 50 })
  await nextTask()
  assert.equal(rounds, 2, 'the single retry was issued')
  assert.equal(activeDurableReadCount(value.backend), 1, 'the retry runs inside the one existing carrier')
  t.mock.timers.tick(5_000)
  await assert.rejects(window, (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'RUNTIME_REQUEST_FAILED')
    assert.match(String((error as Error).message), /timed out after 5000ms/)
    return true
  })
  assert.equal(activeDurableReadCount(value.backend), 0, 'every exit path releases the carrier')
  assert.equal(rounds, 2, 'no further retry follows the timed-out retry')
  await value.backend.close()
})

test('history-window never retries after close or an attachment switch', async () => {
  const closedCalls: WindowCall[] = []
  const closed = await liveHarness((host) => {
    host.use('sessionQuery', {
      readSession: async () => ({ session: { id: 'x' }, events: [], inheritedEventCount: 0 }),
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readEvent: async (request: unknown) => {
        const { before, after } = request as { before: number; after: number }
        closedCalls.push({ before, after })
        void closed.backend.close()
        throw nativeWindowError('before', 20)
      },
    })
  })
  await assert.rejects(closed.backend.command('history-window', { seq: 6, before: 50, after: 50 }), hasCode('ABORTED', 'CLOSED'))
  await nextTask()
  assert.deepEqual(closedCalls, [{ before: 50, after: 50 }], 'a closing backend never issues the narrowed retry')

  const switchedCalls: WindowCall[] = []
  const switched = await liveHarness((host) => {
    host.use('sessionQuery', {
      readSession: async () => ({ session: { id: 'x' }, events: [], inheritedEventCount: 0 }),
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readEvent: async (request: unknown) => {
        const { before, after } = request as { before: number; after: number }
        switchedCalls.push({ before, after })
        if (switchedCalls.length === 1) {
          await switched.backend.command('new')
          throw nativeWindowError('after', 20)
        }
        return eventWindow(seqEvents(0, 3), { startSeq: 0, endSeq: 2 })
      },
    })
  })
  await assert.rejects(
    switched.backend.command('history-window', { seq: 2, before: 50, after: 50 }),
    hasCode('ABORTED', 'STALE_SESSION', 'CLOSED'),
  )
  await nextTask()
  assert.deepEqual(switchedCalls, [{ before: 50, after: 50 }], 'a retired attachment is never read twice')
  await switched.backend.close()
})

test('history-window invalidates a proven bound when the service or the method is replaced', async () => {
  const firstCalls: WindowCall[] = []
  const secondCalls: WindowCall[] = []
  const patchedCalls: WindowCall[] = []
  const value = await liveHarness((host) => {
    host.use('sessionQuery', boundedSessionQuery(20, firstCalls))
  })
  await value.backend.command('history-window', { seq: 6, before: 50, after: 50 })
  assert.deepEqual(firstCalls, [{ before: 50, after: 50 }, { before: 20, after: 20 }])

  // HMR replacement: a new service object is a new native contract.
  value.host.use('sessionQuery', boundedSessionQuery(50, secondCalls))
  await value.backend.command('history-window', { seq: 6, before: 50, after: 50 })
  assert.deepEqual(secondCalls, [{ before: 50, after: 50 }], 'a replaced service is read at the TUI cap again')

  // Hot-patched method on the same object: the stale entry is dropped.
  const query = value.host.get('sessionQuery') as Record<string, unknown>
  const replacement = boundedSessionQuery(50, patchedCalls)
  query.readEvent = async (request: unknown) => {
    const { seq, before = 0, after = 0 } = request as { seq: number; before?: number; after?: number }
    patchedCalls.push({ before, after })
    const startSeq = Math.max(0, seq - before)
    const endSeq = Math.min(12, seq + after)
    return eventWindow(seqEvents(0, 13).slice(startSeq, endSeq + 1), { startSeq, endSeq })
  }
  assert.equal(typeof replacement.readEvent, 'function')
  await value.backend.command('history-window', { seq: 6, before: 50, after: 50 })
  assert.deepEqual(patchedCalls, [{ before: 50, after: 50 }], 'a hot-patched method starts from the TUI cap')
  await value.backend.close()
})

test('history-window rejects a response outside the bounds that were actually dispatched', async () => {
  // The narrowed retry proves 20 per side, but the native returns a
  // wider-but-otherwise-valid slice: extra context was never requested.
  const wideCalls: WindowCall[] = []
  const wide = await liveHarness((host) => {
    host.use('sessionQuery', {
      readSession: async () => ({ session: { id: 'x' }, events: [], inheritedEventCount: 0 }),
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readEvent: async (request: unknown) => {
        const { before, after } = request as { before: number; after: number }
        wideCalls.push({ before, after })
        if (before === 50) throw nativeWindowError('before', 20)
        // 28 contiguous events 0..27: the count matches the returned bounds
        // and the target is inside, so only `endSeq <= seq + after` (6 + 20)
        // can reject this window.
        return eventWindow(seqEvents(0, 28), { startSeq: 0, endSeq: 27 })
      },
    })
  })
  await assert.rejects(wide.backend.command('history-window', { seq: 6, before: 50, after: 50 }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'RUNTIME_REQUEST_FAILED')
    assert.match(String((error as Error).message), /ends after the requested after bound/)
    return true
  })
  assert.deepEqual(wideCalls, [{ before: 50, after: 50 }, { before: 20, after: 20 }])
  await wide.backend.close()

  // A plainly wider slice than the original 50/50 request is malformed too.
  const overhang = await liveHarness((host) => {
    host.use('sessionQuery', {
      readSession: async () => ({ session: { id: 'x' }, events: [], inheritedEventCount: 0 }),
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
      readEvent: async (request: unknown) => {
        const { seq } = request as { seq: number }
        // 52 contiguous events 4..55 for a 55/50/50 request: internally
        // consistent, but it starts one event before the dispatched bound.
        return eventWindow(seqEvents(4, 52), { startSeq: 4, endSeq: 55 })
      },
    })
  })
  await assert.rejects(overhang.backend.command('history-window', { seq: 55, before: 50, after: 50 }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'RUNTIME_REQUEST_FAILED')
    assert.match(String((error as Error).message), /starts before the requested before bound/)
    return true
  })
  await overhang.backend.close()
})
