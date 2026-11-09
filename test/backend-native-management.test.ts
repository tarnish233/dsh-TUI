/**
 * Offline contract tests for the native management seam (rename, native
 * `SessionStore.fork` facts, interactive fork preparation, capabilities).
 *
 * Every native object is a synthetic double shaped after the public DSH
 * `0.2.2-rc.1` contracts (`Session`, `SessionTitleService`, `SessionStore`).
 * No profile, credential, real session log, file, Agent creation/resume, model
 * request or terminal is touched. The interactive fork helper is exercised with
 * an injected `buildForkSeed` double only; production calls resolve it from the
 * installed public `@deepseek-ai/dsh-session` export.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  NativeManagement,
  buildInteractiveForkInput,
  sessionForkFacts,
  type SessionForkOutcome,
  type SessionRenameOutcome,
} from '../src/backend/native-management.ts'
import type { NativeUiAccess, NativeUiScope } from '../src/backend/native-ui-scope.ts'

const ROOT = 'root-session'
const OTHER = 'other-session'

interface FakeEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
}

/** Native-shaped Session: public header, inherited count, seq and full snapshot. */
class FakeSession {
  readonly id: string
  readonly header: Record<string, unknown>
  readonly inheritedEventCount: number
  readonly events: FakeEvent[]
  snapshotCalls = 0

  constructor(id: string, events: readonly FakeEvent[], header: Record<string, unknown>, inherited = 0) {
    this.id = id
    this.events = [...events]
    this.header = { version: 4, id, createdAt: 1, ...header }
    this.inheritedEventCount = inherited
  }

  get seq(): number {
    return this.events.length
  }

  snapshotEvents(fromSeq?: number, toSeqExclusive?: number): readonly FakeEvent[] {
    this.snapshotCalls += 1
    return this.events.slice(fromSeq ?? 0, toSeqExclusive ?? this.events.length)
  }
}

function eventsOf(length: number): FakeEvent[] {
  return Array.from({ length }, (_, seq) => ({ type: seq === 0 ? 'user/message' : 'assistant/message', seq, time: seq }))
}

function nativeForkError(message: string, code: string): Error {
  const error = new Error(message)
  error.name = 'SessionForkError'
  Object.assign(error, { code })
  return error
}

interface Host {
  scope: NativeUiScope | undefined
  services: Map<string, unknown>
  warnings: string[]
}

function accessOf(host: Host): NativeUiAccess {
  return {
    host: { synthetic: true },
    service(name: string): unknown {
      return host.services.get(name)
    },
    current(): NativeUiScope | undefined {
      return host.scope
    },
    isCurrent(scope: NativeUiScope): boolean {
      return host.scope === scope
    },
    warn(message: string): void {
      host.warnings.push(message)
    },
  }
}

function baseHost(scope: NativeUiScope | undefined, services: Record<string, unknown> = {}): Host {
  return { scope, services: new Map(Object.entries(services)), warnings: [] }
}

interface TitleState {
  title: string | null
  appends: Array<{ sessionId: string; title: string }>
  getCalls: number
  renameCalls: Array<{ session: unknown; title: string }>
  getThrows?: boolean
  onRename?: (session: unknown) => void
}

function titleService(state: TitleState, normalize: (raw: string) => string = (raw) => raw.trim()): unknown {
  return {
    get(session: unknown): unknown {
      state.getCalls += 1
      if (state.getThrows === true) throw new Error('title store unavailable')
      if (state.title === null) return undefined
      return { title: state.title, messageSeqs: [], source: { kind: 'fallback' }, eventSeq: 3, updatedAt: 1 }
    },
    rename(session: unknown, raw: string): unknown {
      state.renameCalls.push({ session, title: raw })
      state.onRename?.(session)
      const normalized = normalize(raw)
      if (normalized.length === 0) {
        const error = new Error('session title must contain visible characters')
        error.name = 'SessionTitleInvalidError'
        throw error
      }
      const target = session as { id: string }
      state.title = normalized
      state.appends.push({ sessionId: target.id, title: normalized })
      return { title: normalized, messageSeqs: [], source: { kind: 'user' }, eventSeq: 10 + state.appends.length, updatedAt: 2 }
    },
  }
}

interface ForkState {
  calls: Array<{ source: unknown; boundary: number | undefined; childSessionId: string | undefined }>
  child?: FakeSession
  error?: Error
}

function sessionsService(live: Map<string, unknown>, forks: ForkState): unknown {
  return {
    get(id: string): unknown {
      return live.get(id)
    },
    fork(source: unknown, boundary?: number, childSessionId?: string): unknown {
      forks.calls.push({ source, boundary, childSessionId })
      if (forks.error !== undefined) throw forks.error
      if (forks.child === undefined) throw new Error('synthetic fork is not configured')
      live.set(forks.child.id, forks.child)
      return forks.child
    },
  }
}

function scopeOf(session: unknown, sessionId = ROOT, attachmentId = 'attachment-1'): NativeUiScope {
  return { sessionId, attachmentId, ...(session === undefined ? {} : { session }) }
}

function management(host: Host): NativeManagement {
  return new NativeManagement({ access: accessOf(host) })
}

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

test('rename appends the native normalized title for the exact current root', () => {
  const session = new FakeSession(ROOT, eventsOf(2), {})
  const titles: TitleState = { title: 'older title', appends: [], getCalls: 0, renameCalls: [] }
  const host = baseHost(scopeOf(session), { sessionTitle: titleService(titles), sessions: sessionsService(new Map([[ROOT, session]]), { calls: [] }) })
  const outcome = management(host).renameCurrent({ sessionId: ROOT, attachmentId: 'attachment-1', title: '  Release   notes  ' })
  assert.equal(outcome.ok, true)
  const ok = outcome as Extract<SessionRenameOutcome, { ok: true }>
  assert.equal(ok.title, 'Release   notes')
  assert.equal(ok.seq, 11)
  assert.equal(ok.source, 'user')
  assert.equal(ok.previousTitle, 'older title')
  assert.equal(ok.stillCurrent, true)
  assert.deepEqual(titles.appends, [{ sessionId: ROOT, title: 'Release   notes' }])
  assert.equal(titles.renameCalls.length, 1)
  assert.equal(titles.renameCalls[0]?.session, session)
  assert.equal(titles.renameCalls[0]?.title, '  Release   notes  ')
})

test('a blank title is the native invalid-title refusal and appends nothing', () => {
  const session = new FakeSession(ROOT, eventsOf(1), {})
  const titles: TitleState = { title: null, appends: [], getCalls: 0, renameCalls: [] }
  const host = baseHost(scopeOf(session), { sessionTitle: titleService(titles), sessions: sessionsService(new Map([[ROOT, session]]), { calls: [] }) })
  const outcome = management(host).renameCurrent({ sessionId: ROOT, title: '   ' })
  assert.equal(outcome.ok, false)
  assert.equal((outcome as Extract<SessionRenameOutcome, { ok: false }>).reason, 'title-invalid')
  assert.equal(titles.appends.length, 0)
  assert.equal(host.warnings.length, 0)
})

test('only the exact current root may be renamed: foreign, pending, child and stale scopes never call native', () => {
  const session = new FakeSession(ROOT, eventsOf(1), {})
  const titles: TitleState = { title: null, appends: [], getCalls: 0, renameCalls: [] }
  const cases: Array<{
    label: string
    host: Host
    request: { sessionId: string; attachmentId?: string; title: string }
    reason: string
  }> = [
    {
      label: 'foreign id',
      host: baseHost(scopeOf(session), { sessionTitle: titleService(titles), sessions: sessionsService(new Map([[ROOT, session]]), { calls: [] }) }),
      request: { sessionId: OTHER, title: 'x' },
      reason: 'foreign-session',
    },
    {
      label: 'pending session',
      host: baseHost(scopeOf(undefined), { sessionTitle: titleService(titles), sessions: sessionsService(new Map(), { calls: [] }) }),
      request: { sessionId: ROOT, title: 'x' },
      reason: 'no-session',
    },
    {
      label: 'subagent origin',
      host: baseHost(scopeOf(new FakeSession(ROOT, eventsOf(1), { origin: 'subagent' })), { sessionTitle: titleService(titles) }),
      request: { sessionId: ROOT, title: 'x' },
      reason: 'child-session',
    },
    {
      label: 'delegation depth',
      host: baseHost(scopeOf(new FakeSession(ROOT, eventsOf(1), { delegationDepth: 2 })), { sessionTitle: titleService(titles) }),
      request: { sessionId: ROOT, title: 'x' },
      reason: 'child-session',
    },
    {
      label: 'attachment moved',
      host: baseHost(scopeOf(session), { sessionTitle: titleService(titles), sessions: sessionsService(new Map([[ROOT, session]]), { calls: [] }) }),
      request: { sessionId: ROOT, attachmentId: 'attachment-2', title: 'x' },
      reason: 'stale-attachment',
    },
    {
      label: 'not the live store instance',
      host: baseHost(scopeOf(session), { sessionTitle: titleService(titles), sessions: sessionsService(new Map([[ROOT, new FakeSession(ROOT, eventsOf(1), {})]]), { calls: [] }) }),
      request: { sessionId: ROOT, title: 'x' },
      reason: 'session-not-live',
    },
    {
      label: 'no attachment',
      host: baseHost(undefined, { sessionTitle: titleService(titles) }),
      request: { sessionId: ROOT, title: 'x' },
      reason: 'no-attachment',
    },
    {
      label: 'no readable native header',
      host: baseHost(scopeOf({ id: ROOT, inheritedEventCount: 0 }), { sessionTitle: titleService(titles) }),
      request: { sessionId: ROOT, title: 'x' },
      reason: 'no-session',
    },
    {
      label: 'missing title service',
      host: baseHost(scopeOf(session)),
      request: { sessionId: ROOT, title: 'x' },
      reason: 'missing-service',
    },
  ]
  for (const entry of cases) {
    const outcome = management(entry.host).renameCurrent(entry.request)
    assert.equal(outcome.ok, false, entry.label)
    assert.equal((outcome as Extract<SessionRenameOutcome, { ok: false }>).reason, entry.reason, entry.label)
  }
  assert.equal(titles.appends.length, 0)
  assert.equal(titles.renameCalls.length, 0)
})

test('rename reports the durable truth plus stillCurrent when the attachment moves during the append', () => {
  const session = new FakeSession(ROOT, eventsOf(1), {})
  const titles: TitleState = { title: null, appends: [], getCalls: 0, renameCalls: [] }
  const host = baseHost(scopeOf(session), { sessionTitle: titleService(titles), sessions: sessionsService(new Map([[ROOT, session]]), { calls: [] }) })
  titles.onRename = (): void => {
    host.scope = scopeOf(new FakeSession(OTHER, eventsOf(0), {}), OTHER, 'attachment-2')
  }
  const outcome = management(host).renameCurrent({ sessionId: ROOT, title: 'accepted' })
  assert.equal(outcome.ok, true)
  assert.equal((outcome as Extract<SessionRenameOutcome, { ok: true }>).stillCurrent, false)
  assert.equal(titles.appends.length, 1)
})

test('an unreadable previous title is omitted instead of claimed as no-title', () => {
  const session = new FakeSession(ROOT, eventsOf(1), {})
  const titles: TitleState = { title: 'hidden', appends: [], getCalls: 0, renameCalls: [], getThrows: true }
  const host = baseHost(scopeOf(session), { sessionTitle: titleService(titles), sessions: sessionsService(new Map([[ROOT, session]]), { calls: [] }) })
  const outcome = management(host).renameCurrent({ sessionId: ROOT, title: 'new' })
  assert.equal(outcome.ok, true)
  assert.equal(Object.hasOwn(outcome, 'previousTitle'), false)
  assert.equal(host.warnings.length, 1)
})

// ---------------------------------------------------------------------------
// explicit native SessionStore.fork (session-only artifact)
// ---------------------------------------------------------------------------

function forkedChild(id: string, inherited: number, header: Record<string, unknown> = {}): FakeSession {
  return new FakeSession(id, eventsOf(inherited), { isSeeded: true, cwd: '/workspace/demo', ...header }, inherited)
}

test('fork calls the exact live source and reports native lineage/inheritance facts', () => {
  const session = new FakeSession(ROOT, eventsOf(5), { cwd: '/workspace/demo' })
  const child = forkedChild('fork-1', 3)
  const forks: ForkState = { calls: [], child }
  const host = baseHost(scopeOf(session), {
    sessions: sessionsService(new Map([[ROOT, session]]), forks),
    sessionTitle: titleService({ title: null, appends: [], getCalls: 0, renameCalls: [] }),
  })
  const outcome = management(host).forkCurrent({ sessionId: ROOT, attachmentId: 'attachment-1', atSeq: 2, childSessionId: 'fork-1' })
  assert.equal(outcome.ok, true)
  const ok = outcome as Extract<SessionForkOutcome, { ok: true }>
  assert.equal(forks.calls.length, 1)
  assert.equal(forks.calls[0]?.source, session)
  assert.equal(forks.calls[0]?.boundary, 2)
  assert.equal(forks.calls[0]?.childSessionId, 'fork-1')
  assert.deepEqual(ok.facts, {
    sourceSessionId: ROOT,
    sessionId: 'fork-1',
    boundary: 2,
    inheritedEventCount: 3,
    isSeeded: true,
    cwd: '/workspace/demo',
    nextSeq: 3,
  })
  assert.equal(ok.title, null)
  assert.equal(ok.stillCurrent, true)
  assert.equal(ok.agentAcquisition, 'native-create-required')
  assert.equal(ok.session, child)
})

test('an empty source fork carries no invented boundary and no invented parent/origin', () => {
  const session = new FakeSession(ROOT, eventsOf(0), {})
  const child = forkedChild('fork-empty', 0)
  const forks: ForkState = { calls: [], child }
  const host = baseHost(scopeOf(session), { sessions: sessionsService(new Map([[ROOT, session]]), forks) })
  const outcome = management(host).forkCurrent({ sessionId: ROOT })
  assert.equal(outcome.ok, true)
  const facts = (outcome as Extract<SessionForkOutcome, { ok: true }>).facts
  assert.equal(facts.boundary, undefined)
  assert.equal(facts.inheritedEventCount, 0)
  assert.equal(Object.hasOwn(facts, 'origin'), false)
  assert.equal(Object.hasOwn(facts, 'parentSessionId'), false)
  assert.equal(forks.calls[0]?.boundary, undefined)
})

test('a native fork rejection is surfaced as fork-failed with a redacted diagnostic and no switch', () => {
  const session = new FakeSession(ROOT, eventsOf(3), {})
  const forks: ForkState = { calls: [], error: nativeForkError('fork boundary 9 does not exist (Authorization: Bearer sk-abcdef123456)', 'INVALID_BOUNDARY') }
  const host = baseHost(scopeOf(session), { sessions: sessionsService(new Map([[ROOT, session]]), forks) })
  const outcome = management(host).forkCurrent({ sessionId: ROOT, atSeq: 9 })
  assert.equal(outcome.ok, false)
  const failure = outcome as Extract<SessionForkOutcome, { ok: false }>
  assert.equal(failure.reason, 'fork-failed')
  assert.match(failure.message ?? '', /\[redacted\]/)
  assert.doesNotMatch(failure.message ?? '', /sk-abcdef123456/)
  assert.equal(host.warnings.length, 1)
})

test('a requested child title is written after the fork; a title refusal leaves the fork standing', () => {
  const session = new FakeSession(ROOT, eventsOf(3), {})
  const child = forkedChild('fork-title', 2)
  const titles: TitleState = { title: null, appends: [], getCalls: 0, renameCalls: [] }
  const host = baseHost(scopeOf(session), {
    sessions: sessionsService(new Map([[ROOT, session]]), { calls: [], child }),
    sessionTitle: titleService(titles),
  })
  const ok = management(host).forkCurrent({ sessionId: ROOT, title: 'Forked: plan' })
  assert.equal(ok.ok, true)
  assert.equal((ok as Extract<SessionForkOutcome, { ok: true }>).title, 'Forked: plan')
  assert.deepEqual(titles.appends, [{ sessionId: 'fork-title', title: 'Forked: plan' }])

  const invalid = management(host).forkCurrent({ sessionId: ROOT, title: '  ' })
  assert.equal(invalid.ok, true)
  const partial = invalid as Extract<SessionForkOutcome, { ok: true }>
  assert.equal(Object.hasOwn(partial, 'title'), false)
  assert.match(partial.titleError ?? '', /visible characters/)
})

test('an unreadable forked title is omitted instead of claimed as no-title', () => {
  const session = new FakeSession(ROOT, eventsOf(2), {})
  const child = forkedChild('fork-unknown-title', 1)
  const titles: TitleState = { title: 'hidden', appends: [], getCalls: 0, renameCalls: [], getThrows: true }
  const host = baseHost(scopeOf(session), {
    sessions: sessionsService(new Map([[ROOT, session]]), { calls: [], child }),
    sessionTitle: titleService(titles),
  })
  const outcome = management(host).forkCurrent({ sessionId: ROOT })
  assert.equal(outcome.ok, true)
  assert.equal(Object.hasOwn(outcome, 'title'), false)
  assert.equal(host.warnings.length, 1)
})

test('fork never runs for a foreign, pending, child or stale target', () => {
  const session = new FakeSession(ROOT, eventsOf(2), {})
  const forks: ForkState = { calls: [] }
  const child = forkedChild('fork-never', 1)
  forks.child = child
  const live = new Map([[ROOT, session]])
  const cases: Array<{ host: Host; request: { sessionId: string; attachmentId?: string }; reason: string }> = [
    { host: baseHost(scopeOf(session), { sessions: sessionsService(live, forks) }), request: { sessionId: OTHER }, reason: 'foreign-session' },
    { host: baseHost(scopeOf(undefined), { sessions: sessionsService(live, forks) }), request: { sessionId: ROOT }, reason: 'no-session' },
    { host: baseHost(scopeOf(new FakeSession(ROOT, eventsOf(1), { origin: 'subagent' })), { sessions: sessionsService(live, forks) }), request: { sessionId: ROOT }, reason: 'child-session' },
    { host: baseHost(scopeOf(session), { sessions: sessionsService(live, forks) }), request: { sessionId: ROOT, attachmentId: 'attachment-9' }, reason: 'stale-attachment' },
    { host: baseHost(scopeOf(session)), request: { sessionId: ROOT }, reason: 'missing-service' },
  ]
  for (const entry of cases) {
    const outcome = management(entry.host).forkCurrent(entry.request)
    assert.equal(outcome.ok, false)
    assert.equal((outcome as Extract<SessionForkOutcome, { ok: false }>).reason, entry.reason)
  }
  assert.equal(forks.calls.length, 0)
})

test('sessionForkFacts mirrors native header facts and refuses a Session without native counts', () => {
  const child = forkedChild('fork-facts', 4, {
    parentSession: 'historical-source',
    origin: 'subagent',
    delegationDepth: 1,
    agentPreset: 'ptc',
    cwd: '/work',
  })
  const facts = sessionForkFacts(child, 'source-1')
  assert.deepEqual(facts, {
    sourceSessionId: 'source-1',
    sessionId: 'fork-facts',
    boundary: 3,
    inheritedEventCount: 4,
    isSeeded: true,
    origin: 'subagent',
    parentSessionId: 'historical-source',
    delegationDepth: 1,
    cwd: '/work',
    agentPreset: 'ptc',
    nextSeq: 4,
  })
  assert.equal(sessionForkFacts({ id: 'no-counts', header: {} }, 'source-1'), undefined)
  assert.equal(sessionForkFacts(undefined, 'source-1'), undefined)
})

// ---------------------------------------------------------------------------
// interactive fork preparation (public buildForkSeed, injected)
// ---------------------------------------------------------------------------

/** Offline double for the public buildForkSeed contract (prefix + marker + closers). */
function fakeBuildForkSeed(events: readonly unknown[], boundary: number): readonly unknown[] {
  const prefix = events.slice(0, boundary + 1)
  return [
    ...prefix,
    { type: 'session/end-seed', seq: boundary + 1, time: boundary, data: { inherited: true } },
    { type: 'turn/end', seq: boundary + 2, time: boundary, data: { kind: 'aborted' } },
  ]
}

test('interactive fork input enumerates the complete public log and calls the injected buildForkSeed', () => {
  const source = new FakeSession(ROOT, eventsOf(6), { cwd: '/workspace/demo' })
  const calls: Array<{ events: readonly unknown[]; boundary: number }> = []
  const outcome = buildInteractiveForkInput({
    sourceSession: source,
    childSessionId: 'session-child',
    atSeq: 3,
    agentPreset: 'ptc',
    buildForkSeed(events, boundary) {
      calls.push({ events, boundary })
      return fakeBuildForkSeed(events, boundary)
    },
  })
  assert.equal(outcome.ok, true)
  if (!outcome.ok) return
  assert.equal(source.snapshotCalls, 1)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.events, source.events)
  assert.equal(calls[0]?.boundary, 3)
  assert.equal(outcome.inheritedEventCount, 4)
  assert.equal(outcome.boundary, 3)
  assert.equal(outcome.sessionId, 'session-child')
  assert.deepEqual(outcome.meta, { cwd: '/workspace/demo', isSeeded: true, agentPreset: 'ptc' })
  // The copied prefix keeps the exact native event identities; nothing is re-derived.
  for (let index = 0; index <= 3; index += 1) assert.equal(outcome.seed[index], source.events[index])
})

test('interactive fork input rejects a truncated tail, gaps and a missing boundary', () => {
  const tail = {
    id: ROOT,
    header: { id: ROOT },
    inheritedEventCount: 0,
    snapshotEvents: () => eventsOf(6).slice(2),
  }
  const truncated = buildInteractiveForkInput({ sourceSession: tail, childSessionId: 'c', atSeq: 1, buildForkSeed: fakeBuildForkSeed })
  assert.equal(truncated.ok, false)
  assert.equal((truncated as { reason?: string }).reason, 'event-log-unavailable')

  const gap = {
    id: ROOT,
    header: { id: ROOT },
    inheritedEventCount: 0,
    snapshotEvents: () => [eventsOf(1)[0], { type: 'x', seq: 2, time: 2 }, { type: 'y', seq: 3, time: 3 }],
  }
  const gapped = buildInteractiveForkInput({ sourceSession: gap, childSessionId: 'c', atSeq: 1, buildForkSeed: fakeBuildForkSeed })
  assert.equal(gapped.ok, false)
  assert.equal((gapped as { reason?: string }).reason, 'event-log-unavailable')

  const source = new FakeSession(ROOT, eventsOf(2), {})
  const beyond = buildInteractiveForkInput({ sourceSession: source, childSessionId: 'c', atSeq: 2, buildForkSeed: fakeBuildForkSeed })
  assert.equal(beyond.ok, false)
  assert.equal((beyond as { reason?: string }).reason, 'boundary-invalid')
})

test('interactive fork input refuses a re-derived seed and a source without the public snapshot read', () => {
  const source = new FakeSession(ROOT, eventsOf(4), {})
  const rederived = buildInteractiveForkInput({
    sourceSession: source,
    childSessionId: 'c',
    atSeq: 1,
    buildForkSeed: (events, boundary) => events.slice(0, boundary + 1).map((event) => ({ ...(event as object) })),
  })
  assert.equal(rederived.ok, false)
  assert.equal((rederived as { reason?: string }).reason, 'seed-invalid')

  const noSnapshot = buildInteractiveForkInput({
    sourceSession: { id: ROOT, header: { id: ROOT }, inheritedEventCount: 0 },
    childSessionId: 'c',
    atSeq: 0,
    buildForkSeed: fakeBuildForkSeed,
  })
  assert.equal(noSnapshot.ok, false)
  assert.equal((noSnapshot as { reason?: string }).reason, 'event-log-unavailable')
})

test('interactive fork input validates its explicit inputs without touching anything', () => {
  const source = new FakeSession(ROOT, eventsOf(2), {})
  const cases = [
    { sourceSession: source, childSessionId: '', atSeq: 0, buildForkSeed: fakeBuildForkSeed },
    { sourceSession: source, childSessionId: 'c', atSeq: -1, buildForkSeed: fakeBuildForkSeed },
    { sourceSession: source, childSessionId: 'c', atSeq: 0, buildForkSeed: undefined as unknown as typeof fakeBuildForkSeed },
    { sourceSession: {}, childSessionId: 'c', atSeq: 0, buildForkSeed: fakeBuildForkSeed },
    { sourceSession: source, childSessionId: 'c', atSeq: 0, buildForkSeed: fakeBuildForkSeed, cwd: '' },
  ]
  for (const request of cases) {
    const outcome = buildInteractiveForkInput(request)
    assert.equal(outcome.ok, false)
    assert.equal((outcome as { reason?: string }).reason, 'invalid-request')
  }
  assert.equal(source.snapshotCalls, 0)
})

test('the source cwd can be overridden and a seed builder failure is contained', () => {
  const source = new FakeSession(ROOT, eventsOf(2), { cwd: '/recorded' })
  const overridden = buildInteractiveForkInput({
    sourceSession: source,
    childSessionId: 'c',
    atSeq: 0,
    cwd: '/requested',
    buildForkSeed: fakeBuildForkSeed,
  })
  assert.equal(overridden.ok, true)
  assert.equal((overridden as { meta?: { cwd?: string } }).meta?.cwd, '/requested')

  const failing = buildInteractiveForkInput({
    sourceSession: source,
    childSessionId: 'c',
    atSeq: 0,
    buildForkSeed: () => {
      throw new Error('builder exploded')
    },
  })
  assert.equal(failing.ok, false)
  assert.equal((failing as { reason?: string }).reason, 'seed-invalid')
})

// ---------------------------------------------------------------------------
// capabilities
// ---------------------------------------------------------------------------

function namespaceLoader(id: string, name: string): unknown {
  return { entries: () => [{ options: { id, name } }] }
}

test('capabilities follow the mounted native methods only', () => {
  const session = new FakeSession(ROOT, eventsOf(1), {})
  const full = baseHost(scopeOf(session), {
    sessionTitle: titleService({ title: null, appends: [], getCalls: 0, renameCalls: [] }),
    sessions: sessionsService(new Map([[ROOT, session]]), { calls: [] }),
    settings: { describe: () => [], mutate: async () => undefined },
    loader: namespaceLoader('profile-presets', '@deepseek-ai/dsh-agent-preset-registry'),
  })
  const caps = management(full).capabilities()
  assert.deepEqual(caps, {
    rename: true,
    fork: true,
    defaultSettingsRead: true,
    defaultSettingsWrite: true,
    targets: ['agent-preset-default'],
  })

  const readOnly = baseHost(scopeOf(session), {
    settings: { describe: () => [] },
    loader: namespaceLoader('profile-presets', '@deepseek-ai/dsh-agent-preset-registry'),
  })
  const readCaps = management(readOnly).capabilities()
  assert.equal(readCaps.rename, false)
  assert.equal(readCaps.fork, false)
  assert.equal(readCaps.defaultSettingsRead, true)
  assert.equal(readCaps.defaultSettingsWrite, false)

  const empty = management(baseHost(scopeOf(session))).capabilities()
  assert.deepEqual(empty, {
    rename: false,
    fork: false,
    defaultSettingsRead: false,
    defaultSettingsWrite: false,
    targets: [],
  })
})

test('a throwing service lookup is unavailable, not a crash', () => {
  const session = new FakeSession(ROOT, eventsOf(1), {})
  const host = baseHost(scopeOf(session))
  const access: NativeUiAccess = {
    host: {},
    service(): unknown {
      throw new Error('service registry exploded')
    },
    current: () => host.scope,
    isCurrent: (scope) => host.scope === scope,
    warn: (message) => host.warnings.push(message),
  }
  const adapter = new NativeManagement({ access })
  assert.deepEqual(adapter.capabilities(), {
    rename: false,
    fork: false,
    defaultSettingsRead: false,
    defaultSettingsWrite: false,
    targets: [],
  })
  assert.equal(host.warnings.length, 4)
})