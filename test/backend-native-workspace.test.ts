/**
 * Offline contract tests for the adapter's native live-turn workspace facts:
 * the whitelisted `SessionEvent.workspaceChanges` summary and the
 * `workspace-change-diff` read over `ctx.workspaceChanges`.
 *
 * Every service is a local fake: no file is read, no path resolved, no git or
 * watcher runs, and no profile/credential/session log is touched.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshBackend, type DshContextBackend } from '../src/backend/context.ts'
import type { BackendEvent, SessionInfo, WorkspaceChangeDiffResult, WorkspaceChangesSummary } from '../src/backend/types.ts'
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
  await value.backend.connect()
  await value.backend.send('prompt')
  const agent = value.agents.agents[0]
  assert.ok(agent)
  const info = await value.backend.connect()
  return { ...value, agent, info }
}

function hasCode(...codes: string[]): (error: unknown) => boolean {
  return (error: unknown) => codes.includes(String((error as { code?: unknown }).code))
}

function summaryOf(turn = 1): Record<string, unknown> {
  return {
    turn,
    cwd: '/workspace/private',
    snapshot: { before: 'tree-0', after: 'tree-1' },
    files: [
      { path: 'src/a.ts', display: 'src/a.ts', added: 3, deleted: 1, extra: 'drop me' },
      { path: '/tmp/b.bin', display: '~/b.bin', added: 0, deleted: 0, binary: true },
      { path: 'big.txt', display: 'big.txt', added: 0, deleted: 0, oversized: true },
    ],
    total: 3,
    added: 3,
    deleted: 1,
  }
}

function liveChangesEvent(seq = 7, turn = 1): { type: string; seq: number; time: number; data: unknown } {
  return { type: 'workspace/changes', seq, time: 1_700_000_000_000, data: { turn } }
}

test('a live workspace/changes event carries the whitelisted native summary and nothing else', async () => {
  const summaryCalls: Array<[string, number]> = []
  const { backend, host, events, agent, info } = await liveHarness((fakeHost) => {
    fakeHost.use('workspaceChanges', {
      summary: (sessionId: string, seq: number) => {
        summaryCalls.push([sessionId, seq])
        return summaryOf()
      },
      diff: async () => { throw new Error('diff must not be called by the event path') },
    })
  })
  const before = events.length
  host.emit('session/event', agent.session, liveChangesEvent(7, 2))
  // Only the exact live session object is the root surface.
  host.emit('session/event', { id: agent.id }, liveChangesEvent(8, 3))
  await nextTask()
  assert.deepEqual(summaryCalls, [[agent.id, 7]], 'exactly the live event seq is looked up once')
  const emitted = events.slice(before).filter(event => event.type === 'session_event')
  assert.equal(emitted.length, 1)
  const wire = emitted[0]?.type === 'session_event' ? emitted[0].event : undefined
  assert.ok(wire)
  assert.deepEqual(wire.workspaceChanges, {
    turn: 1,
    files: [
      { path: 'src/a.ts', display: 'src/a.ts', added: 3, deleted: 1 },
      { path: '/tmp/b.bin', display: '~/b.bin', added: 0, deleted: 0, binary: true },
      { path: 'big.txt', display: 'big.txt', added: 0, deleted: 0, oversized: true },
    ],
    total: 3,
    added: 3,
    deleted: 1,
  } as WorkspaceChangesSummary)
  assert.equal(Object.hasOwn(wire.workspaceChanges as object, 'cwd'), false, 'host cwd never crosses the DTO')
  assert.equal(Object.hasOwn(wire.workspaceChanges as object, 'snapshot'), false, 'git object ids never cross the DTO')
  assert.equal(wire.seq, 7)
  assert.equal(wire.time, 1_700_000_000_000)
  assert.deepEqual(wire.data, { turn: 2 })
  assert.equal(info.sessionId, agent.id)
  await backend.close()
})

test('the native append-before-record timing keeps summary, turn/end and idle in order', async () => {
  let summary: Record<string, unknown> | undefined
  const { backend, host, events, agent } = await liveHarness((fakeHost) => {
    fakeHost.use('workspaceChanges', { summary: () => summary })
  })
  const before = events.length
  // Match TurnRecorder.record(): session.append notifies synchronously, then
  // recorder.records.set(event.seq, {summary}) runs before append() returns.
  host.emit('session/event', agent.session, liveChangesEvent(11, 1))
  host.emit('session/event', agent.session, { type: 'turn/end', seq: 12, data: { turn: 1, reason: { kind: 'completed' } } })
  host.emit('agent/status', { agent, status: 'idle' })
  assert.equal(events.length, before, 'later native facts cannot overtake the pending summary')
  summary = summaryOf()
  await nextTask()
  const released = events.slice(before)
  assert.deepEqual(released.map(event => event.type), ['session_event', 'session_event', 'status'])
  const workspace = released[0]
  assert.ok(workspace?.type === 'session_event')
  assert.equal(workspace.event.seq, 11)
  assert.equal(workspace.event.workspaceChanges?.total, 3)
  assert.equal(released[1]?.type === 'session_event' ? released[1].event.seq : undefined, 12)
  await backend.close()
})

test('close invalidates an append-time workspace barrier without a late event', async () => {
  let summary: Record<string, unknown> | undefined
  const { backend, host, events, agent } = await liveHarness((fakeHost) => {
    fakeHost.use('workspaceChanges', { summary: () => summary })
  })
  const before = events.length
  host.emit('session/event', agent.session, liveChangesEvent(13, 1))
  await backend.close()
  summary = summaryOf()
  await nextTask()
  const released = events.slice(before)
  assert.deepEqual(released.map(event => event.type), ['closed'])
  await backend.close()
})

test('a session switch never traps the new ready or attaches a late old summary', async () => {
  let summary: Record<string, unknown> | undefined
  const { backend, host, events, agent } = await liveHarness((fakeHost) => {
    fakeHost.use('workspaceChanges', { summary: () => summary })
  })
  const before = events.length
  host.emit('session/event', agent.session, liveChangesEvent(15, 1))
  await backend.command('new')
  summary = summaryOf()
  await nextTask()
  const released = events.slice(before)
  const readyIndex = released.findIndex(event => event.type === 'ready' && event.info.sessionId !== agent.id)
  assert.ok(readyIndex >= 0, 'the new session ready is never queued behind the old barrier')
  const oldIndex = released.findIndex(event => event.type === 'session_event' && event.event.seq === 15)
  if (oldIndex >= 0) {
    assert.ok(oldIndex < readyIndex, 'an already releasable old event precedes the switch')
    const old = released[oldIndex]
    assert.equal(old?.type === 'session_event' ? old.event.workspaceChanges : undefined, undefined)
  }
  await backend.close()
})

test('missing, malformed or turn-less native summaries never become an attached card', async () => {
  const cases: Array<{ name: string; value: unknown }> = [
    { name: 'missing summary', value: undefined },
    { name: 'null summary', value: null },
    { name: 'no turn', value: { files: [], total: 0, added: 0, deleted: 0 } },
    { name: 'files absent', value: { turn: 1, total: 0, added: 0, deleted: 0 } },
    { name: 'files not array', value: { turn: 1, files: {}, total: 0, added: 0, deleted: 0 } },
    { name: 'negative count', value: { turn: 1, files: [], total: 0, added: -1, deleted: 0 } },
    { name: 'fractional total', value: { turn: 1, files: [], total: 0.5, added: 0, deleted: 0 } },
    { name: 'total below file count', value: { turn: 1, files: [{ path: 'a', display: 'a', added: 1, deleted: 0 }], total: 0, added: 1, deleted: 0 } },
    { name: 'file without display', value: { turn: 1, files: [{ path: 'a', added: 1, deleted: 0 }], total: 1, added: 1, deleted: 0 } },
    { name: 'file binary not true', value: { turn: 1, files: [{ path: 'a', display: 'a', added: 1, deleted: 0, binary: 'yes' }], total: 1, added: 1, deleted: 0 } },
    { name: 'file count string', value: { turn: 1, files: [{ path: 'a', display: 'a', added: '1', deleted: 0 }], total: 1, added: 1, deleted: 0 } },
  ]
  for (const entry of cases) {
    const { backend, host, events, agent } = await liveHarness((fakeHost) => {
      fakeHost.use('workspaceChanges', { summary: () => entry.value })
    })
    const before = events.length
    host.emit('session/event', agent.session, liveChangesEvent())
    await nextTask()
    const emitted = events.slice(before).filter(event => event.type === 'session_event')
    assert.equal(emitted.length, 1, entry.name)
    const wire = emitted[0]?.type === 'session_event' ? emitted[0].event : undefined
    assert.equal(wire?.workspaceChanges, undefined, entry.name)
    await backend.close()
  }
})

test('a throwing summary lookup never breaks transcript delivery', async () => {
  const { backend, host, events, agent } = await liveHarness((fakeHost) => {
    fakeHost.use('workspaceChanges', {
      summary: () => { throw new Error('summary exploded: api_key=sk-live-secret') },
    })
  })
  const before = events.length
  host.emit('session/event', agent.session, liveChangesEvent())
  await nextTask()
  const emitted = events.slice(before).filter(event => event.type === 'session_event')
  assert.equal(emitted.length, 1)
  assert.equal(emitted[0]?.type === 'session_event' ? emitted[0].event.workspaceChanges : 'x', undefined)
  assert.equal(JSON.stringify(events).includes('sk-live-secret'), false)
  await backend.close()
})

test('workspace summaries are looked up only for live workspace/changes events', async () => {
  const summaryCalls: Array<[string, number]> = []
  const { backend, host, events, agent } = await liveHarness((fakeHost) => {
    fakeHost.use('workspaceChanges', { summary: (id: string, seq: number) => { summaryCalls.push([id, seq]); return summaryOf() } })
  })
  const before = events.length
  host.emit('session/event', agent.session, { type: 'tool/call', seq: 3, data: { callId: 'c', name: 'bash', arguments: '{}' } })
  host.emit('session/event', agent.session, { type: 'user/message', seq: 4, data: {} })
  assert.deepEqual(summaryCalls, [], 'a non-workspace event is never looked up')
  // A missing native seq is not a lookup key: the wire's `0` fallback is not
  // allowed to alias a real workspace event.
  host.emit('session/event', agent.session, { type: 'workspace/changes', data: { turn: 1 } })
  assert.deepEqual(summaryCalls, [])
  const workspaceless = events.slice(before).filter(event => event.type === 'session_event')
  assert.equal(workspaceless.every(event => event.type !== 'session_event' || event.event.workspaceChanges === undefined), true)
  await backend.close()
})

test('a resumed durable log is never given a fabricated live workspace summary', async () => {
  let summaryCalls = 0
  const value = harness((fakeHost) => {
    fakeHost.use('workspaceChanges', { summary: () => { summaryCalls += 1; return summaryOf() } })
    fakeHost.use('sessionQuery', {
      readSession: async (id: string) => ({
        session: { id },
        inheritedEventCount: 0,
        events: [liveChangesEvent(0, 1), { type: 'user/message', seq: 1, data: {} }],
      }),
      listSessions: async () => [],
      readTitleSnapshots: async () => [],
    })
  }, { resume: 'session-resumed' })
  const info = await value.backend.connect()
  assert.equal(info.sessionId, 'session-resumed')
  assert.equal(info.events?.length, 2)
  assert.equal(info.events?.[0]?.type, 'workspace/changes')
  assert.equal(info.events?.[0]?.workspaceChanges, undefined, 'durable replay has no live-only summary')
  assert.equal(summaryCalls, 0, 'the snapshot path never calls the live summary service')
  await value.backend.close()
})

test('workspace capabilities follow the exact mounted native methods', async () => {
  const read = async (service: unknown): Promise<string[]> => {
    const value = harness(host => host.use('workspaceChanges', service))
    const info = await value.backend.connect()
    await value.backend.close()
    return info.capabilities.filter(name => name === 'workspace-changes' || name === 'workspace-change-diff')
  }
  assert.deepEqual(await read(undefined), [])
  assert.deepEqual(await read({}), [])
  assert.deepEqual(await read({ summary: () => undefined }), ['workspace-changes'])
  assert.deepEqual(await read({ diff: async () => undefined }), ['workspace-change-diff'])
  assert.deepEqual(await read({ summary: () => undefined, diff: async () => undefined }), ['workspace-changes', 'workspace-change-diff'])
})

test('workspace-change-diff forwards the exact native args/owned signal and whitelists a text comparison', async () => {
  const calls: Array<{ args: unknown[]; abortedDuring: boolean }> = []
  const service = {
    summary: () => { throw new Error('summary must not be called by the diff read') },
    diff: async (sessionId: string, seq: number, index: number, signal: AbortSignal) => {
      calls.push({ args: [sessionId, seq, index], abortedDuring: signal.aborted })
      assert.ok(signal instanceof AbortSignal)
      return {
        kind: 'text',
        path: 'src/a.ts',
        display: 'src/a.ts',
        before: true,
        after: true,
        coarse: false,
        extra: 'drop me',
        hunks: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+a', '+b'], ignored: true },
        ],
      }
    },
  }
  const { backend, agent, info } = await liveHarness(host => host.use('workspaceChanges', service))
  const result = await backend.command('workspace-change-diff', { seq: 9, index: 2 }) as WorkspaceChangeDiffResult
  assert.deepEqual(calls.map(call => call.args), [[agent.id, 9, 2]])
  assert.equal(calls[0]?.abortedDuring, false, 'the native call receives a live owned signal')
  assert.deepEqual(result, {
    sessionId: agent.id,
    attachmentId: info.attachmentId,
    seq: 9,
    index: 2,
    diff: {
      kind: 'text',
      path: 'src/a.ts',
      display: 'src/a.ts',
      before: true,
      after: true,
      coarse: false,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+a', '+b'] }],
    },
  })
  await backend.close()
})

test('workspace-change-diff preserves binary/oversized and the native no-comparison absence', async () => {
  for (const diff of [
    { kind: 'binary', path: 'a.bin', display: 'a.bin', hunks: 'ignored' },
    { kind: 'oversized', path: 'big', display: '../big' },
  ]) {
    const { backend } = await liveHarness(host => host.use('workspaceChanges', { diff: async () => diff }))
    const result = await backend.command('workspace-change-diff', { seq: 1, index: 0 }) as WorkspaceChangeDiffResult
    assert.deepEqual(result.diff, { kind: diff.kind, path: diff.path, display: diff.display })
    await backend.close()
  }
  const absent = await liveHarness(host => host.use('workspaceChanges', { diff: async () => undefined }))
  const result = await absent.backend.command('workspace-change-diff', { seq: 1, index: 0 }) as WorkspaceChangeDiffResult
  assert.equal(result.diff, undefined)
  assert.equal(Object.hasOwn(result, 'diff'), false, 'native absence is an omitted DTO field, not an empty diff')
  await absent.backend.close()
})

test('workspace-change-diff rejects malformed native comparisons and never synthesizes a diff', async () => {
  const cases: Array<{ name: string; value: unknown }> = [
    { name: 'null comparison', value: null },
    { name: 'string comparison', value: 'diff' },
    { name: 'unknown kind', value: { kind: 'patch', path: 'a', display: 'a' } },
    { name: 'missing path', value: { kind: 'binary', display: 'a' } },
    { name: 'empty display', value: { kind: 'oversized', path: 'a', display: '' } },
    { name: 'text without flags', value: { kind: 'text', path: 'a', display: 'a', hunks: [] } },
    { name: 'text without hunks', value: { kind: 'text', path: 'a', display: 'a', before: true, after: true, coarse: false } },
    { name: 'hunk without bounds', value: { kind: 'text', path: 'a', display: 'a', before: true, after: true, coarse: false, hunks: [{}] } },
    {
      name: 'hunk with string line',
      value: { kind: 'text', path: 'a', display: 'a', before: true, after: true, coarse: false, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['+a', 7] }] },
    },
  ]
  for (const entry of cases) {
    const { backend } = await liveHarness(host => host.use('workspaceChanges', { diff: async () => entry.value }))
    await assert.rejects(
      backend.command('workspace-change-diff', { seq: 3, index: 0 }),
      hasCode('RUNTIME_REQUEST_FAILED'),
      entry.name,
    )
    await backend.close()
  }
})

test('workspace-change-diff validates seq/index/identity before any native call', async () => {
  let calls = 0
  const { backend, info } = await liveHarness(host => host.use('workspaceChanges', {
    diff: async () => { calls += 1; return undefined },
  }))
  for (const seq of [undefined, -1, 1.5, '3', Number.NaN]) {
    await assert.rejects(backend.command('workspace-change-diff', { seq, index: 0 }), hasCode('INVALID_ARGUMENT'), String(seq))
  }
  for (const index of [undefined, -1, 1.5, '0', Number.MAX_SAFE_INTEGER + 2]) {
    await assert.rejects(backend.command('workspace-change-diff', { seq: 0, index }), hasCode('INVALID_ARGUMENT'), String(index))
  }
  await assert.rejects(backend.command('workspace-change-diff', { sessionId: 'other', seq: 0, index: 0 }), hasCode('STALE_SESSION'))
  await assert.rejects(backend.command('workspace-change-diff', { attachmentId: 'other', seq: 0, index: 0 }), hasCode('STALE_SESSION'))
  await assert.rejects(backend.command('workspace-change-diff', { sessionId: 1, seq: 0, index: 0 }), hasCode('INVALID_ARGUMENT'))
  assert.equal(calls, 0, 'invalid requests never reach the native comparison')
  const accepted = await backend.command('workspace-change-diff', { sessionId: info.sessionId, attachmentId: info.attachmentId, seq: 0, index: 0 }) as WorkspaceChangeDiffResult
  assert.equal(accepted.sessionId, info.sessionId)
  assert.equal(calls, 1)
  await backend.close()
})

test('workspace-change-diff is unavailable without the service and never materializes a pending Agent', async () => {
  const missing = harness()
  await missing.backend.connect()
  const info = await missing.backend.connect()
  assert.equal(info.capabilities.includes('workspace-change-diff'), false)
  await assert.rejects(missing.backend.command('workspace-change-diff', { seq: 0, index: 0 }), hasCode('NOT_CONNECTED'))
  assert.deepEqual(missing.agents.createCalls, [], 'a pending diff read never creates a session')
  await missing.backend.close()

  const summaryOnly = await liveHarness(host => host.use('workspaceChanges', { summary: () => undefined }))
  await assert.rejects(summaryOnly.backend.command('workspace-change-diff', { seq: 0, index: 0 }), hasCode('CAPABILITY_UNAVAILABLE'))
  await summaryOnly.backend.close()
})

test('workspace-change-diff aborts on close and on a session switch without a late DTO', async () => {
  const signals: AbortSignal[] = []
  const held = () => ({
    diff: async (_sessionId: string, _seq: number, _index: number, signal: AbortSignal) => {
      signals.push(signal)
      return await new Promise((_resolve, reject) => {
        const abort = (): void => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
      })
    },
  })
  const closing = await liveHarness(host => host.use('workspaceChanges', held()))
  const inflight = closing.backend.command('workspace-change-diff', { seq: 1, index: 0 })
  await nextTask()
  await closing.backend.close()
  await assert.rejects(inflight, hasCode('ABORTED', 'CLOSED'))
  assert.equal(signals[0]?.aborted, true)

  const switching = await liveHarness(host => host.use('workspaceChanges', held()))
  const stale = switching.backend.command('workspace-change-diff', { seq: 2, index: 1 })
  await nextTask()
  await switching.backend.command('new')
  await assert.rejects(stale, hasCode('ABORTED', 'STALE_SESSION', 'CLOSED'))
  await switching.backend.close()
})

test('workspace-change-diff normalizes a native rejection to a coded, redacted diagnostic', async () => {
  const { backend } = await liveHarness(host => host.use('workspaceChanges', {
    diff: async () => { throw new Error('comparison failed: Authorization: Bearer sk-live-deadbeef') },
  }))
  await assert.rejects(backend.command('workspace-change-diff', { seq: 5, index: 0 }), (error: unknown) => {
    const coded = error as { code?: string; message?: string }
    assert.equal(coded.code, 'RUNTIME_REQUEST_FAILED')
    assert.doesNotMatch(String(coded.message), /sk-live-deadbeef/)
    assert.match(String(coded.message), /\[redacted\]/)
    return true
  })
  await backend.close()
})

test('workspace reads never touch the filesystem, git, subprocess or a second catalog', async () => {
  let fsReads = 0
  let subprocessRuns = 0
  let summaryCalls = 0
  let diffCalls = 0
  const { backend, host, agent } = await liveHarness((fakeHost) => {
    fakeHost.use('fs', { readFile: async () => { fsReads += 1; throw new Error('adapter must not read files') } })
    fakeHost.use('subprocess', { run: async () => { subprocessRuns += 1; throw new Error('adapter must not run git') } })
    fakeHost.use('workspaceChanges', {
      summary: () => { summaryCalls += 1; return summaryOf() },
      diff: async () => {
        diffCalls += 1
        return { kind: 'binary', path: 'a.bin', display: 'a.bin' }
      },
    })
  })
  host.emit('session/event', agent.session, liveChangesEvent())
  await nextTask()
  await backend.command('workspace-change-diff', { seq: 7, index: 0 })
  assert.equal(summaryCalls, 1)
  assert.equal(diffCalls, 1)
  assert.equal(fsReads, 0, 'no file read')
  assert.equal(subprocessRuns, 0, 'no git/subprocess run')
  await backend.close()
})