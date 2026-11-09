// Must stay the FIRST import: forces truecolor before src modules snapshot terminal mode.
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { SessionEvent, SessionInfo } from '../src/backend/types.ts'
import { TranscriptStore, type AssistantTranscriptItem, type NoticeTranscriptItem } from '../src/state/transcript.ts'
import { TranscriptView } from '../src/ui/transcript.ts'
import { createItemBlock } from '../src/ui/blocks.ts'

/**
 * A4 regression: every confirmed native non-success turn/end must leave one
 * concise, durable transcript outcome, while a normal completed turn stays
 * quiet and a live `agent/error` is never reported twice. Cancellation wording
 * may only come from the recorded native cancel cause.
 */

const SID = 'session-turn-end'

const ev = (seq: number, type: string, data: unknown, extra: Partial<SessionEvent> = {}): SessionEvent => ({
  type,
  seq,
  time: 1_700_000_000_000 + seq,
  data,
  surfaceOp: 'append',
  ...extra,
})

const info = (events: SessionEvent[] = []): SessionInfo => ({
  sessionId: SID,
  cwd: '/tmp/work',
  provider: 'fixture',
  model: 'fixture',
  capabilities: [],
  events,
})

const user = (text: string) => ({ id: `u-${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
  turn: 1,
  step: 1,
  message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } },
  stream: [],
  ...extra,
})
const end = (turn: number, reason: unknown) => ({ turn, reason })

/** Cold route: `ready` replays the durable snapshot (resume/import/rebuild). */
function coldStore(events: SessionEvent[] = []): TranscriptStore {
  const store = new TranscriptStore({ onChange: () => {} })
  store.handle({ type: 'ready', info: info(events) })
  return store
}

/** Live route: one durable `session_event` per native append. */
function liveStore(events: SessionEvent[] = []): TranscriptStore {
  const store = new TranscriptStore({ onChange: () => {} })
  store.handle({ type: 'ready', info: info([]) })
  feed(store, events)
  return store
}

function feed(store: TranscriptStore, events: readonly SessionEvent[]): void {
  for (const event of events) store.handle({ type: 'session_event', sessionId: SID, event })
}

const notices = (store: TranscriptStore): NoticeTranscriptItem[] =>
  store.items.filter((item): item is NoticeTranscriptItem => item.kind === 'notice')

const kinds = (store: TranscriptStore): string[] => store.items.map(item => item.kind)

function render(store: TranscriptStore, width = 80): string {
  const view = new TranscriptView(store, { showThinking: true, expandTools: false })
  return stripTerminalSequences(view.render(width).join('\n'))
}

function renderAssistant(item: AssistantTranscriptItem, width = 80): string {
  const block = createItemBlock(item, { showThinking: true, expandTools: false })
  return stripTerminalSequences(block.render(width).join('\n'))
}

const turn = (seq: number, number = 1): SessionEvent => ev(seq, 'turn/start', { turn: number })

// ---------------------------------------------------------------------------
// Silent positive controls: a successful or unknown outcome adds nothing

test('a completed turn and normal streaming stay quiet', () => {
  const events = [
    turn(0),
    ev(1, 'user/message', user('hello')),
    ev(2, 'assistant/message', assistant('hello back')),
    ev(3, 'turn/end', end(1, { kind: 'completed' })),
  ]
  for (const [label, store] of [['cold', coldStore(events)], ['live', liveStore(events)]] as const) {
    assert.deepEqual(kinds(store), ['user', 'assistant'], `${label}: no settlement diagnostics`)
    assert.equal(notices(store).length, 0, `${label}: success is silent`)
    assert.doesNotMatch(render(store), /attempt|settle|revision|stream start|stream end/i)
  }
})

test('plugin-extended, unknown and malformed turn/end reasons stay silent and never throw', () => {
  const store = coldStore([
    ev(0, 'turn/end', end(1, { kind: 'plugin:custom-stop', detail: 1 })),
    ev(1, 'turn/end', end(2, null)),
    ev(2, 'turn/end', { turn: 3 }),
    ev(3, 'turn/end', { reason: { kind: 'completed' } }),
    ev(4, 'turn/end', end(4, { kind: 42 })),
  ])
  assert.deepEqual(store.items, [], 'an unknown semantic is not described')
})

// ---------------------------------------------------------------------------
// Required non-success outcomes

test('max-tokens shows one concise durable outcome on cold and live routes', () => {
  const events = [
    turn(0),
    ev(1, 'user/message', user('count to ten')),
    ev(2, 'assistant/message', assistant('one two three')),
    ev(3, 'turn/end', end(1, { kind: 'max-tokens' })),
  ]
  for (const [label, store] of [['cold', coldStore(events)], ['live', liveStore(events)]] as const) {
    assert.deepEqual(kinds(store), ['user', 'assistant', 'notice'], `${label}: one durable outcome row`)
    const [notice] = notices(store)
    assert.equal(notice?.level, 'info')
    assert.match(notice?.text ?? '', /output limit reached/i)
    const text = render(store)
    assert.match(text, /Output limit reached/i, `${label}: visible in scrollback`)
    assert.match(text, /one two three/)
    assert.ok(text.indexOf('one two three') < text.indexOf('Output limit reached'), `${label}: follows the truncated reply`)
  }
})

test('blocked is reported without fabricating a user message', () => {
  // Native pre-step rejection appends no user/message at all.
  const unadmitted = coldStore([
    turn(0),
    ev(1, 'turn/end', end(1, { kind: 'blocked' })),
  ])
  assert.deepEqual(kinds(unadmitted), ['notice'], 'no user row is invented')
  assert.match(notices(unadmitted)[0]?.text ?? '', /blocked/i)
  assert.match(render(unadmitted), /blocked/i)
  assert.doesNotMatch(render(unadmitted), /> /, 'no prompt band is painted')

  // A blocked later turn keeps the earlier admitted conversation intact.
  const later = liveStore([
    turn(0),
    ev(1, 'user/message', user('first')),
    ev(2, 'assistant/message', assistant('answer')),
    ev(3, 'turn/end', end(1, { kind: 'completed' })),
    turn(4, 2),
    ev(5, 'turn/end', end(2, { kind: 'blocked' })),
  ])
  assert.deepEqual(kinds(later), ['user', 'assistant', 'notice'])
  assert.equal(later.items.filter(item => item.kind === 'user').length, 1, 'the blocked turn added no user row')
})

test('cold error diagnostics reuse redaction without mutating the durable failure', () => {
  // All credential-shaped values in this fixture are synthetic, never user data.
  const token = 'synthetic-only-token'
  const key = 'synthetic-only-key'
  const failure = Object.freeze({ message: `Offline failure: Authorization: Bearer ${token}; api_key=${key}`, code: 'AUTH' })
  const event = ev(1, 'turn/end', end(1, { kind: 'error', error: failure }))
  const before = JSON.stringify(event)
  const store = coldStore([turn(0), event])
  const text = render(store)
  assert.match(text, /Turn failed: Offline failure/)
  assert.match(text, /redacted/)
  assert.equal(text.includes(token), false)
  assert.equal(text.includes(key), false)
  assert.equal(JSON.stringify(event), before, 'native failure facts are not rewritten')
})

test('cold interrupted and forked closers are visible', () => {
  const interrupted = coldStore([
    turn(0),
    ev(1, 'assistant/message', assistant('before crash')),
    ev(2, 'turn/end', end(1, { kind: 'interrupted' })),
  ])
  assert.deepEqual(kinds(interrupted), ['assistant', 'notice'])
  assert.match(notices(interrupted)[0]?.text ?? '', /interrupted/i)
  assert.match(render(interrupted), /interrupted before it completed/i)

  const forked = coldStore([ev(0, 'turn/end', end(1, { kind: 'forked' }))])
  assert.deepEqual(kinds(forked), ['notice'])
  assert.match(notices(forked)[0]?.text ?? '', /fork/i)
})

test('a cold error closer reports the durable failure once; live agent/error is not duplicated', () => {
  const failure = { error: { message: '401 invalid api key', code: 'AUTH' } }

  // Cold/imported history has no live agent/error frame: show the durable fact.
  const cold = coldStore([turn(0), ev(1, 'turn/end', end(1, { kind: 'error', ...failure }))])
  const coldNotices = notices(cold)
  assert.equal(coldNotices.length, 1)
  assert.equal(coldNotices[0]?.level, 'error')
  assert.match(coldNotices[0]?.text ?? '', /Turn failed: 401 invalid api key/)
  assert.match(render(cold), /● Turn failed: 401 invalid api key/, 'error notice keeps the CC error chrome')

  // Live: native throwError emits agent/error before turn/end. Exactly one report.
  const live = new TranscriptStore({ onChange: () => {} })
  live.handle({ type: 'ready', info: info([]) })
  live.handle({ type: 'session_event', sessionId: SID, event: turn(0) })
  live.handle({ type: 'error', message: 'agent error: 401 invalid api key' })
  feed(live, [ev(1, 'turn/end', end(1, { kind: 'error', ...failure }))])
  const liveNotices = notices(live)
  assert.equal(liveNotices.length, 1, 'the live API Error is not double-reported')
  assert.match(liveNotices[0]?.text ?? '', /agent error: 401 invalid api key/)
  assert.doesNotMatch(render(live), /Turn failed/, 'no duplicate durable headline')

  // Positive control: a live error frame is visible even without a turn/end.
  const standalone = new TranscriptStore({ onChange: () => {} })
  standalone.handle({ type: 'ready', info: info([]) })
  standalone.handle({ type: 'error', message: 'agent error: 401 invalid api key' })
  assert.match(render(standalone), /API Error: 401 invalid api key/)
})

test('replayed turn/end outcomes are idempotent within one transcript', () => {
  const events = [turn(0), ev(1, 'assistant/message', assistant('partial')), ev(2, 'turn/end', end(1, { kind: 'max-tokens' }))]
  const store = coldStore(events)
  assert.equal(notices(store).length, 1)
  feed(store, events)
  assert.equal(notices(store).length, 1, 'a replayed durable frame appends no second notice')
  store.handle({ type: 'ready', info: info(events) })
  assert.equal(notices(store).length, 1, 'a rebuilt snapshot projects the outcome once')
})

test('a model-only replacement copy never hides or duplicates the outcome', () => {
  const store = coldStore([
    turn(0),
    ev(1, 'assistant/message', assistant('kept reply')),
    // Native replacement copy is model-only: the human row must not be erased.
    ev(2, 'assistant/message', assistant('rewritten model copy'), { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
    ev(3, 'turn/end', end(1, { kind: 'max-tokens' })),
  ])
  const assistants = store.items.filter(item => item.kind === 'assistant')
  assert.equal(assistants.length, 1)
  assert.match(render(store), /kept reply/)
  assert.equal(notices(store).length, 1)
})

// ---------------------------------------------------------------------------
// Cancellation attribution comes only from the recorded native cause

const aborted = (cause: unknown): SessionEvent[] => [
  turn(0),
  ev(1, 'assistant/message', assistant('partial answer', { interrupted: true })),
  ev(2, 'turn/end', end(1, { kind: 'aborted', reason: cause })),
]

function assistantRow(events: SessionEvent[]): AssistantTranscriptItem {
  const item = coldStore(events).items.find(value => value.kind === 'assistant')
  assert.ok(item && item.kind === 'assistant')
  return item
}

test('external cancellation causes are never attributed to the user', () => {
  const external: Array<[string, unknown]> = [
    ['parent', { kind: 'parent' }],
    ['permission hook', { kind: 'hook', reason: 'permission-cancelled' }],
    ['question hook', { kind: 'hook', reason: 'question-cancelled' }],
    ['compaction hook', { kind: 'hook', reason: 'compaction' }],
    ['disposed', { kind: 'disposed' }],
    ['legacy', { kind: 'legacy' }],
  ]
  for (const [label, cause] of external) {
    const item = assistantRow(aborted(cause))
    assert.equal(item.interruptCause, (cause as { kind: string }).kind, `${label}: native cause is kept`)
    const text = renderAssistant(item)
    assert.match(text, /Interrupted/, `${label}: interruption is shown`)
    assert.doesNotMatch(text, /by user/i, `${label}: no invented user attribution`)
  }
})

test('only a recorded user cause says "Interrupted by user"', () => {
  const item = assistantRow(aborted({ kind: 'user' }))
  assert.equal(item.interruptCause, 'user')
  assert.match(renderAssistant(item), /Interrupted by user/)
})

test('unknown or mismatched causes stay unattributed', () => {
  // The durable message alone carries no cause.
  const unrecorded = coldStore([turn(0), ev(1, 'assistant/message', assistant('partial', { interrupted: true }))])
  const item = unrecorded.items.find(value => value.kind === 'assistant')
  assert.ok(item && item.kind === 'assistant')
  assert.equal(item.interruptCause, undefined)
  assert.match(renderAssistant(item), /Interrupted/)
  assert.doesNotMatch(renderAssistant(item), /by user/i)

  // A different turn's abort cannot retarget this reply.
  const mismatched = assistantRow([
    turn(0),
    ev(1, 'assistant/message', assistant('partial answer', { interrupted: true })),
    ev(2, 'turn/end', end(9, { kind: 'aborted', reason: { kind: 'user' } })),
  ])
  assert.equal(mismatched.interruptCause, undefined)
  assert.doesNotMatch(renderAssistant(mismatched), /by user/i)

  // A malformed cause is not guessed.
  const malformed = assistantRow([
    turn(0),
    ev(1, 'assistant/message', assistant('partial answer', { interrupted: true })),
    ev(2, 'turn/end', end(1, { kind: 'aborted', reason: { kind: 'future-cause' } })),
  ])
  assert.equal(malformed.interruptCause, undefined)
})

// ---------------------------------------------------------------------------
// Width / theme

test('outcome notices are width-safe and keep their theme chrome', () => {
  const store = coldStore([
    turn(0),
    ev(1, 'assistant/message', assistant('truncated ' + 'x'.repeat(80))),
    ev(2, 'turn/end', end(1, { kind: 'max-tokens' })),
  ])
  const view = new TranscriptView(store, { showThinking: true, expandTools: false })
  for (const width of [20, 40, 80, 120]) {
    const lines = view.render(width)
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`)
    const text = stripTerminalSequences(lines.join('\n')).replace(/\s+/g, ' ')
    assert.match(text, /Output limit reached/, `width ${width}`)
  }
  // The info row is muted theme chrome (not an error marker).
  const raw = view.render(80).join('\n')
  assert.match(stripTerminalSequences(raw).replace(/\s+/g, ' '), /· Output limit reached/)
  assert.doesNotMatch(stripTerminalSequences(raw), /● Output limit reached/)
  assert.match(raw, /\x1b\[/, 'the notice is painted through the shared theme')
})