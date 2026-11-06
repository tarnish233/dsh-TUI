// Native diagnostic projection (frontend half of terminal-output isolation).
//
// The proven defect: native catalog diagnostics go through the global console to
// fd 2 and overwrite the editor's row. The backend owns classification,
// sanitization, the bounded log and fatal restoration; this module only decides
// which already-classified record may become one existing transcript notice.
// These tests are synthetic: no profile, provider, credential, PTY, network or
// model request is involved.
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { TerminalDiagnosticRecord } from '../src/backend/terminal-output.ts'
import type { SessionEvent, SessionInfo } from '../src/backend/types.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { createItemBlock } from '../src/ui/blocks.ts'
import {
  createNativeDiagnosticProjection,
  NATIVE_DIAGNOSTIC_DEFAULTS,
  type NativeDiagnosticRecord,
  type NativeNoticeLevel,
} from '../src/ui/native-diagnostics.ts'

interface Report {
  readonly message: string
  readonly level: NativeNoticeLevel
}

function collector(): { reports: Report[]; report: (message: string, level: NativeNoticeLevel) => void } {
  const reports: Report[] = []
  return { reports, report: (message, level) => { reports.push({ message, level }) } }
}

/** The backend's agreed record, already sanitized and classified. */
const record = (
  kind: TerminalDiagnosticRecord['kind'],
  text: string,
  channel: TerminalDiagnosticRecord['channel'] = 'stderr',
): NativeDiagnosticRecord => ({ channel, kind, text })

/** A test-only clock; window behaviour must not depend on real time. */
function fakeClock(start = 1_000): { now: () => number; advance: (ms: number) => void; set: (value: number) => void } {
  let value = start
  return {
    now: () => value,
    advance: (ms: number) => { value += ms },
    set: (next: number) => { value = next },
  }
}

/** The proven real routine line, already sanitized by the backend. */
const ROUTINE_LISTING = '[llm-deepseek-account] model listing from https://api.deepseek.com/models loaded 2 model(s), skipped 0 row(s)'
const WARNING_LINE = '[llm-deepseek-account] model listing skipped 2 row(s) without an id'

test('routine success, fatal and unclassified records never enter the notice plane', () => {
  const { reports, report } = collector()
  const projection = createNativeDiagnosticProjection(report)
  projection.handle(record('routine', ROUTINE_LISTING))
  projection.handle(record('routine', ROUTINE_LISTING, 'stdout'))
  projection.handle(record('fatal', 'dsh: fatal load failure: terminal not acquired'))
  for (let index = 0; index < 10; index += 1) projection.handle(record('fatal', `fatal ${index}`))

  // Runtime data can still be malformed even though the type is closed.
  projection.handle({ channel: 'stderr', kind: 'error', text: 'unknown kind' } as unknown as NativeDiagnosticRecord)
  projection.handle({ channel: 'stderr', kind: 'warning', text: 42 } as unknown as NativeDiagnosticRecord)
  projection.handle({ channel: 'stderr', kind: 'warning', text: '   ' } as unknown as NativeDiagnosticRecord)
  projection.handle({ channel: 'stderr', kind: 'warning', text: '\x1b[31m\x1b[0m' } as unknown as NativeDiagnosticRecord)
  projection.handle(null)
  projection.handle(undefined)

  assert.deepEqual(reports, [], 'routine/fatal/unknown records stay log-only')
  projection.dispose()
})

test('one warning becomes exactly one width-safe notice', () => {
  const { reports, report } = collector()
  const projection = createNativeDiagnosticProjection(report)
  projection.handle(record('warning', WARNING_LINE))

  assert.deepEqual(reports, [{ message: `Native warning: ${WARNING_LINE}`, level: 'info' }])
  for (const entry of reports) {
    assert.doesNotMatch(entry.message, /[\x00-\x1f\x7f\u0080-\u009f]/, 'no escape/control bytes survive')
    assert.doesNotMatch(entry.message, /\n/, 'the preview is one line')
    assert.ok(visibleWidth(entry.message) <= 200, 'the preview stays bounded')
  }
  projection.dispose()
})

test('ANSI, CR/LF and control bytes are collapsed into one bounded one-line preview', () => {
  const { reports, report } = collector()
  const projection = createNativeDiagnosticProjection(report, { maxPreviewColumns: 40 })
  projection.handle(record(
    'warning',
    '\x1b]8;;https://example.invalid\x07\x1b[31mfirst\r\nsecond\tthird\x07\x1b[0m ' + 'z'.repeat(200),
  ))
  assert.equal(reports.length, 1)
  const message = reports[0]!.message
  assert.doesNotMatch(message, /[\x00-\x1f\x7f\u0080-\u009f]/, 'no escape or control byte is forwarded')
  assert.match(message, /^Native warning: first second third/)
  assert.ok(message.endsWith('…'), 'an over-budget preview is visibly truncated')
  assert.ok(visibleWidth(message) <= 60, `${visibleWidth(message)} columns`)
  assert.ok(!message.includes('z'.repeat(41)), 'the preview budget is enforced')
  projection.dispose()
})

test('repeated diagnostics are reported once, however often they repeat', () => {
  const { reports, report } = collector()
  const projection = createNativeDiagnosticProjection(report)
  for (let index = 0; index < 100; index += 1) projection.handle(record('warning', WARNING_LINE))
  projection.handle(record('warning', WARNING_LINE, 'stdout'))
  assert.equal(reports.length, 1, 'one per distinct sanitized text, regardless of channel')
  projection.dispose()
})

test('dedupe state is bounded and evicts only the oldest signature', () => {
  const { reports, report } = collector()
  const clock = fakeClock()
  const projection = createNativeDiagnosticProjection(report, {
    maxSignatures: 2,
    maxNotices: 10,
    now: clock.now,
  })
  projection.handle(record('warning', 'warning A'))
  projection.handle(record('warning', 'warning B'))
  projection.handle(record('warning', 'warning A'))
  assert.equal(reports.length, 2, 'A and B are each reported once while remembered')

  projection.handle(record('warning', 'warning C')) // evicts A from the bounded state
  projection.handle(record('warning', 'warning B'))
  projection.handle(record('warning', 'warning A'))
  assert.deepEqual(reports.map(entry => entry.message), [
    'Native warning: warning A',
    'Native warning: warning B',
    'Native warning: warning C',
    'Native warning: warning A',
  ], 'bounded memory may re-report a very old evicted diagnostic, but never floods')
  projection.dispose()
})

test('the notice budget is a per-window ceiling with one explicit limit notice', () => {
  const { reports, report } = collector()
  const clock = fakeClock()
  const projection = createNativeDiagnosticProjection(report, {
    maxNotices: 3,
    windowMs: 60_000,
    now: clock.now,
  })

  for (let index = 0; index < 50; index += 1) projection.handle(record('warning', `distinct failure ${index}`))
  assert.equal(reports.length, 4, 'three individual notices plus one limit notice')
  assert.deepEqual(reports.slice(0, 3).map(entry => entry.level), ['info', 'info', 'info'])
  assert.match(reports[3]!.message, /suppressed for now/)
  assert.match(reports[3]!.message, /bounded native log/)
  assert.doesNotMatch(reports[3]!.message, /full record stays/, 'the log is bounded, never called complete')

  // The rest of the same window stays quiet.
  projection.handle(record('warning', 'late distinct warning in the same window'))
  assert.equal(reports.length, 4)
  projection.dispose()
})

test('a later new warning becomes visible again after the window, identical repeats stay quiet', () => {
  const { reports, report } = collector()
  const clock = fakeClock()
  const projection = createNativeDiagnosticProjection(report, {
    maxNotices: 2,
    windowMs: 60_000,
    now: clock.now,
  })

  projection.handle(record('warning', 'first window failure A'))
  projection.handle(record('warning', 'first window failure B'))
  projection.handle(record('warning', 'first window failure C'))
  assert.equal(reports.length, 3, 'two notices plus the limit notice')

  // A later, genuinely new failure is not permanently silenced by an earlier burst.
  clock.advance(60_000)
  projection.handle(record('warning', 'after the window failure'))
  assert.equal(reports.length, 4)
  assert.match(reports[3]!.message, /after the window failure/)
  // ...but an identical earlier diagnostic never repeats.
  projection.handle(record('warning', 'first window failure A'))
  assert.equal(reports.length, 4)
  projection.dispose()
})

test('each window gets its own budget and one limit notice per burst', () => {
  const { reports, report } = collector()
  const clock = fakeClock()
  const projection = createNativeDiagnosticProjection(report, {
    maxNotices: 2,
    windowMs: 10_000,
    now: clock.now,
  })

  const burst = (label: string): void => {
    for (let index = 0; index < 20; index += 1) projection.handle(record('warning', `${label} ${index}`))
  }
  burst('first burst')
  assert.equal(reports.length, 3)
  clock.advance(10_000)
  burst('second burst')
  assert.equal(reports.length, 6, 'a new window re-enables two notices and one limit line')
  assert.equal(reports.filter(entry => /suppressed for now/.test(entry.message)).length, 2)
  projection.dispose()
})

test('a backwards or broken clock resets the window safely instead of wedging it', () => {
  const { reports, report } = collector()
  const clock = fakeClock(10_000)
  const projection = createNativeDiagnosticProjection(report, {
    maxNotices: 1,
    windowMs: 60_000,
    now: clock.now,
  })

  projection.handle(record('warning', 'muted A'))
  projection.handle(record('warning', 'muted B'))
  assert.equal(reports.length, 2, 'one notice plus the limit notice')

  // A non-finite reading is ignored: the current window continues quietly.
  clock.set(Number.NaN)
  projection.handle(record('warning', 'during broken clock'))
  assert.equal(reports.length, 2)

  // A backwards jump (suspend/resume, clock change) is a new window, not a mute.
  clock.set(5_000)
  projection.handle(record('warning', 'after backwards clock'))
  assert.equal(reports.length, 3)
  assert.match(reports[2]!.message, /after backwards clock/)
  projection.dispose()
})

test('a warning suppressed by the window budget appears once that window rolls', () => {
  const { reports, report } = collector()
  const clock = fakeClock()
  const projection = createNativeDiagnosticProjection(report, {
    maxNotices: 1,
    windowMs: 60_000,
    now: clock.now,
  })

  projection.handle(record('warning', 'warning A'))
  assert.equal(reports.length, 1)
  // B is first encountered while the window is exhausted: it must NOT be marked
  // seen, otherwise the same important failure is muted forever.
  projection.handle(record('warning', 'important failure B'))
  assert.equal(reports.length, 2)
  assert.match(reports[1]!.message, /suppressed for now/)

  clock.advance(60_000)
  projection.handle(record('warning', 'important failure B'))
  assert.equal(reports.length, 3)
  assert.equal(reports[2]!.message, 'Native warning: important failure B')

  // A warning the user actually saw stays deduped, in this window and later.
  projection.handle(record('warning', 'warning A'))
  clock.advance(60_000)
  projection.handle(record('warning', 'warning A'))
  assert.equal(reports.length, 3, 'a successfully reported identical warning still dedupes')
  projection.dispose()
})

test('dispose stops all reporting, is idempotent and does not resurrect state', () => {
  const { reports, report } = collector()
  const projection = createNativeDiagnosticProjection(report)
  projection.handle(record('warning', 'before close'))
  projection.dispose()
  projection.dispose()
  assert.equal(projection.disposed, true)
  projection.handle(record('warning', 'after close'))
  projection.handle(record('warning', 'before close'))
  assert.equal(reports.length, 1)
})

test('a closing report callback cannot throw through the projection', () => {
  let calls = 0
  const projection = createNativeDiagnosticProjection((_message, _level) => {
    calls += 1
    throw new Error('app is closing')
  })
  assert.doesNotThrow(() => projection.handle(record('warning', 'first failure')))
  // A failed callback is not remembered as seen either: the same line is retried
  // rather than silently swallowed while the app is still shutting down.
  assert.doesNotThrow(() => projection.handle(record('warning', 'first failure')))
  assert.equal(calls, 2, 'a failed callback does not mark the diagnostic as seen')
  projection.dispose()
  assert.doesNotThrow(() => projection.handle(record('warning', 'first failure')))
})

// ---------------------------------------------------------------------------
// Integration: only the intended notice appears; drafts/queue/transcript stay.

const info = (events: SessionEvent[] = []): SessionInfo => ({
  sessionId: 'session-native-diagnostics',
  cwd: '/tmp/native-diagnostics',
  provider: 'demo',
  model: 'demo-model',
  capabilities: [],
  events,
})

const ev = (type: string, seq: number, data: unknown, extra: Record<string, unknown> = {}): SessionEvent => ({
  type, seq, time: 0, data, ...extra,
})

const user = (text: string) => ({ id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

const assistant = (text: string) => ev('assistant/message', 2, {
  turn: 1,
  step: 1,
  message: {
    id: 'a1',
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: 'demo', model: 'demo-model' },
  },
  stream: [],
}, { surfaceOp: 'append' })

test('one warning appends one notice and leaves durable items, draft and queue untouched', () => {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info([
    ev('user/message', 1, user('keep this prompt'), { surfaceOp: 'append' }),
    assistant('and this reply'),
  ]))
  const durable = store.items.slice()
  const draft = { text: 'draft keep me', cursor: 5 }
  const queue = ['queued one', 'queued two']
  const draftBefore = structuredClone(draft)
  const queueBefore = structuredClone(queue)

  const projection = createNativeDiagnosticProjection((message, level) => store.report(message, level))
  for (let index = 0; index < 20; index += 1) projection.handle(record('warning', '[llm-deepseek-account] model listing failed: unauthorized'))
  projection.handle(record('routine', ROUTINE_LISTING))
  projection.handle(record('fatal', 'dsh: fatal load failure: not visible here'))

  assert.deepEqual(store.items.slice(0, durable.length), durable, 'durable transcript items are unchanged')
  const notices = store.items.filter(item => item.kind === 'notice')
  assert.equal(store.items.length, durable.length + 1, 'exactly one notice was appended')
  assert.equal(notices.length, 1)
  assert.equal(notices[0]!.level, 'info')
  assert.equal(notices[0]!.text, 'Native warning: [llm-deepseek-account] model listing failed: unauthorized')
  assert.deepEqual(draft, draftBefore, 'the editor draft is never touched by the diagnostic plane')
  assert.deepEqual(queue, queueBefore, 'the native inbox/queue is never touched')

  // The notice renders through the existing width-safe NoticeBlock.
  for (const width of [16, 24, 40, 80]) {
    for (const line of createItemBlock(notices[0]!, { showThinking: false, expandTools: false }).render(width)) {
      assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)}`)
      assert.doesNotMatch(stripTerminalSequences(line), /\x1b|\r|\u0080-\u009f/)
    }
  }
  projection.dispose()
})

test('routine listing refreshes keep an empty transcript even after many cycles', () => {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info())
  const projection = createNativeDiagnosticProjection((message, level) => store.report(message, level))
  for (let index = 0; index < 100; index += 1) projection.handle(record('routine', ROUTINE_LISTING))
  assert.deepEqual(store.items, [])
  projection.dispose()
  // Defaults the parent relies on (integration, not a user-facing setting).
  assert.equal(NATIVE_DIAGNOSTIC_DEFAULTS.notices, 8)
  assert.equal(NATIVE_DIAGNOSTIC_DEFAULTS.signatures, 32)
  assert.equal(NATIVE_DIAGNOSTIC_DEFAULTS.windowMs, 60_000)
})