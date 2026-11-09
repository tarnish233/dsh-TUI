/**
 * Offline contract tests for the native timed/continued user-questions
 * pending view and late answer.
 *
 * Every fact is a synthetic Cordis-shaped host: no profile, credential, real
 * session log, model request, Agent materialization or terminal is touched.
 * The doubles mirror the installed public surfaces exactly — the
 * `sessionProjections.snapshot(session, keys)` carrier read (native
 * `userQuestions` + `inbox` wire views) and
 * `userQuestions.answer(agent, callId, answer)` with the service's own
 * live-root rejection codes. The adapter must add no fold, timer, store,
 * pending decision or foreground `attachWait` claim.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  NativeQuestionAdapter,
  USER_QUESTION_PROJECTION_KEYS,
  isUserQuestionProjectionKey,
  type ContinuedQuestionsView,
} from '../src/backend/native-questions.ts'
import type { NativeUiAccess, NativeUiScope } from '../src/backend/native-ui-scope.ts'
import { BackendError } from '../src/backend/errors.ts'

const ROOT = 'root-session'
const ATTACHMENT = 'attachment-1'

type Raw = Record<string, unknown>

/** Synthetic public `ctx.sessionProjections` carrier read face. */
class FakeProjections {
  readonly calls: Array<{ session: unknown; keys: readonly string[] | undefined }> = []
  readonly values: Raw = {}
  asOfSeq = 7
  failure: Error | undefined

  snapshot(session: unknown, keys?: readonly string[]): unknown {
    this.calls.push({ session, keys })
    if (this.failure !== undefined) throw this.failure
    const values: Raw = {}
    for (const key of keys ?? Object.keys(this.values)) {
      if (Object.hasOwn(this.values, key)) values[key] = this.values[key]
    }
    return { asOfSeq: this.asOfSeq, values }
  }
}

/** Synthetic public `ctx.userQuestions`; exposes `attachWait` to prove it is never claimed. */
class FakeUserQuestions {
  readonly answerCalls: Array<{ agent: unknown; callId: unknown; answer: unknown }> = []
  readonly attachWaitCalls: unknown[] = []
  /** `true`/`false` like native, or a native-shaped rejection. */
  result: boolean | Error = true
  /** Runs inside the write, like a synchronous native event side effect. */
  duringAnswer: (() => void) | undefined

  answer(agent: unknown, callId: unknown, answer: unknown): unknown {
    this.answerCalls.push({ agent, callId, answer })
    this.duringAnswer?.()
    if (this.result instanceof Error) throw this.result
    return this.result
  }

  async *attachWait(...args: unknown[]): AsyncIterable<{ remainingMs: number }> {
    this.attachWaitCalls.push(args)
    yield { remainingMs: 1 }
  }
}

/** One exact attachment scope, with an identity-based `isCurrent` like the seam contract. */
class FakeAccess implements NativeUiAccess {
  readonly host = {}
  readonly services = new Map<string, unknown>()
  readonly serviceCalls: string[] = []
  readonly warnings: string[] = []
  scope: NativeUiScope | undefined
  identityCheck = true

  constructor(session: unknown, agent: unknown) {
    this.scope = { sessionId: ROOT, attachmentId: ATTACHMENT, session, agent }
  }

  use(name: string, service: unknown): this {
    this.services.set(name, service)
    return this
  }

  service(name: string): unknown {
    this.serviceCalls.push(name)
    return this.services.get(name)
  }

  current(): NativeUiScope | undefined {
    return this.scope
  }

  isCurrent(scope: NativeUiScope): boolean {
    const current = this.scope
    if (current === undefined) return false
    if (this.identityCheck) return scope === current
    return scope.sessionId === current.sessionId && scope.attachmentId === current.attachmentId
  }

  warn(message: string): void {
    this.warnings.push(message)
  }
}

interface Harness {
  readonly access: FakeAccess
  readonly projections: FakeProjections
  readonly questions: FakeUserQuestions
  readonly adapter: NativeQuestionAdapter
  readonly session: { id: string; header: { cwd: string } }
  readonly agent: { id: string; session: unknown }
}

function harness(): Harness {
  const session = { id: ROOT, header: { cwd: '/workspace' } }
  const agent = { id: ROOT, session }
  const access = new FakeAccess(session, agent)
  const projections = new FakeProjections()
  const questions = new FakeUserQuestions()
  access.use('sessionProjections', projections).use('userQuestions', questions)
  return {
    access,
    projections,
    questions,
    adapter: new NativeQuestionAdapter({ access }),
    session,
    agent,
  }
}

/** One native-shaped timed `ask_user_question` call. */
function pendingCall(
  callId: string,
  state: string,
  questions: unknown[],
): Raw {
  return { callId, state, questions }
}

const pickOne: Raw = {
  id: 'q1',
  question: 'Which mode?',
  header: 'Mode',
  options: [{ label: 'Fast', description: 'Less thorough' }, { label: 'Careful' }],
}

const pickMany: Raw = {
  id: 'q2',
  question: 'Which checks?',
  multiSelect: true,
  options: [{ label: 'Lint' }, { label: 'Types' }],
}

const freeform: Raw = { id: 'q3', question: 'Anything else?' }

function nativeView(active: unknown[], settled: unknown[] = []): Raw {
  return { active, settled }
}

function continuedView(callId: string, questions: unknown[]): Raw {
  return nativeView([pendingCall(callId, 'continued', questions)])
}

/** One native `UserQuestionError`-shaped rejection with a public service code. */
function nativeFailure(code: string, message = `native ${code}`): Error {
  const error = new Error(message)
  error.name = 'UserQuestionError'
  Object.assign(error, { code })
  return error
}

function codeOf(error: unknown): string | undefined {
  return error instanceof BackendError ? error.code : undefined
}

// --------------------------------------------------------------------- read

test('read projects the native userQuestions cut without folding or materializing an Agent', () => {
  const h = harness()
  h.projections.values.userQuestions = nativeView(
    [
      pendingCall('call-1', 'continued', [pickOne, freeform]),
      pendingCall('call-2', 'open', [pickMany]),
    ],
    [{ callId: 'call-0', answers: [{ id: 'q0', selected: ['Fast'], custom: 'note' }] }],
  )

  const view = h.adapter.read()
  assert.ok(view !== undefined)
  assert.equal(view.available, true)
  assert.equal(view.sessionId, ROOT)
  assert.equal(view.attachmentId, ATTACHMENT)
  assert.equal(view.asOfSeq, 7)
  assert.deepEqual(view.active, [
    {
      callId: 'call-1',
      state: 'continued',
      questions: [pickOne, freeform],
    },
    {
      callId: 'call-2',
      state: 'open',
      questions: [pickMany],
    },
  ])
  assert.deepEqual(view.settled, [{ callId: 'call-0', answers: [{ id: 'q0', selected: ['Fast'], custom: 'note' }] }])

  // One consistent native cut, exact Session object, both native keys.
  assert.equal(h.projections.calls.length, 1)
  assert.equal(h.projections.calls[0]!.session, h.session)
  assert.deepEqual(h.projections.calls[0]!.keys, ['userQuestions', 'inbox'])
  // Discovery never touches an Agent registry, session store or the answer service.
  assert.deepEqual([...new Set(h.access.serviceCalls)], ['sessionProjections'])
  assert.equal(h.questions.attachWaitCalls.length, 0)
})

test('read preserves native question identity, option labels and multiSelect exactly', () => {
  const h = harness()
  h.projections.values.userQuestions = continuedView('call-1', [pickMany, { id: 'q9', question: 'Q?', detail: 'd' }])

  const row = h.adapter.read()!.active[0]!
  assert.equal(row.callId, 'call-1')
  assert.deepEqual(row.questions[0], {
    id: 'q2',
    question: 'Which checks?',
    multiSelect: true,
    options: [{ label: 'Lint' }, { label: 'Types' }],
  })
  assert.deepEqual(row.questions[1], { id: 'q9', question: 'Q?', detail: 'd' })
})

test('read marks replyQueued from the native durable inbox and never invents queue facts', () => {
  const h = harness()
  h.projections.values.userQuestions = nativeView([
    pendingCall('call-1', 'continued', [pickOne]),
    pendingCall('call-2', 'continued', [pickOne]),
  ])
  h.projections.values.inbox = {
    'next-turn': [{ id: 'm-1', source: { kind: 'user-question-reply', callId: 'call-1' } }],
    'next-step': [
      { id: 'm-2', source: { kind: 'user' } },
      { id: 'm-3', source: { kind: 'user-question-reply', callId: 'call-2' } },
    ],
  }

  const view = h.adapter.read()!
  assert.equal(view.active.find(row => row.callId === 'call-1')!.replyQueued, true)
  assert.equal(view.active.find(row => row.callId === 'call-2')!.replyQueued, true)

  // An unreadable inbox means "unknown", never "not queued".
  h.projections.values.inbox = { 'next-turn': 'not-a-list' }
  const unknown = h.adapter.read()!
  assert.equal(unknown.available, true)
  assert.equal('replyQueued' in unknown.active[0]!, false)
  assert.equal(h.access.warnings.filter(message => message.includes('inbox')).length, 1)

  // A missing inbox projection is also unknown, with no diagnostic.
  delete h.projections.values.inbox
  const missing = h.adapter.read()!
  assert.equal('replyQueued' in missing.active[0]!, false)
  assert.equal(h.access.warnings.filter(message => message.includes('inbox')).length, 1)
})

test('read reports unavailable instead of no-pending-questions', () => {
  const h = harness()

  // No current attachment at all.
  h.access.scope = undefined
  assert.equal(h.adapter.read(), undefined)

  // Pending (unmaterialized) attachment: no native Session object exists yet.
  h.access.scope = { sessionId: ROOT, attachmentId: ATTACHMENT }
  const pendingView = h.adapter.read() as ContinuedQuestionsView
  assert.deepEqual(pendingView, {
    sessionId: ROOT,
    attachmentId: ATTACHMENT,
    available: false,
    active: [],
    settled: [],
  })
  assert.equal(h.projections.calls.length, 0)

  // A supplied Session that belongs to another identity is never read.
  const other = { id: 'other-session' }
  h.access.scope = { sessionId: ROOT, attachmentId: ATTACHMENT, session: other, agent: h.agent }
  assert.equal(h.adapter.read()!.available, false)
  assert.equal(h.projections.calls.length, 0)
  assert.equal(h.access.warnings.some(message => message.includes('does not belong')), true)

  // Read failure is a host diagnostic, not an empty native list.
  h.access.scope = { sessionId: ROOT, attachmentId: ATTACHMENT, session: h.session, agent: h.agent }
  h.projections.failure = nativeFailure('PROJECTION_READ_FAILED', 'projection fold failed')
  assert.equal(h.adapter.read()!.available, false)
  assert.equal(h.access.warnings.some(message => message.includes('unavailable')), true)
  h.projections.failure = undefined
  h.adapter.read()
  assert.equal(h.access.warnings.filter(message => message.includes('unavailable')).length, 1)

  // A missing native unit is unavailable, not an empty projection.
  delete h.projections.values.userQuestions
  assert.equal(h.adapter.read()!.available, false)
})

test('read refuses a malformed projection instead of presenting it as authoritative', () => {
  const h = harness()
  const malformed: unknown[] = [
    'not-an-object',
    { active: 'no', settled: [] },
    { active: [pendingCall('', 'continued', [pickOne])], settled: [] },
    { active: [pendingCall('call-1', 'expired', [pickOne])], settled: [] },
    { active: [pendingCall('call-1', 'continued', [])], settled: [] },
    { active: [pendingCall('call-1', 'continued', [{ id: 'q1', question: 'Q?' }, { id: 'q1', question: 'Q2?' }])], settled: [] },
    { active: [pendingCall('call-1', 'continued', [pickOne]), pendingCall('call-1', 'continued', [pickOne])], settled: [] },
    { active: [pendingCall('call-1', 'continued', [{ id: 'q1', question: 'Q?', options: 'nope' }])], settled: [] },
    { active: [pendingCall('call-1', 'continued', [{ id: 'q1', question: 'Q?', options: [{ label: 1 }] }])], settled: [] },
    { active: [pendingCall('call-1', 'continued', [pickOne])], settled: [{ callId: 'c', answers: 'nope' }] },
    { active: [pendingCall('call-1', 'continued', [pickOne])], settled: [{ callId: 'c', answers: [{ id: 'q', selected: [1] }] }] },
  ]
  for (const value of malformed) {
    h.projections.values.userQuestions = value
    const view = h.adapter.read()!
    assert.equal(view.available, false, `expected unavailable for ${JSON.stringify(value)}`)
    assert.deepEqual(view.active, [])
    assert.deepEqual(view.settled, [])
  }
  // Bounded diagnostics: one message per distinct shape failure, never per read.
  assert.ok(h.access.warnings.length >= 1 && h.access.warnings.length <= 8)
})

test('read omits asOfSeq when the native cut is not a valid cursor', () => {
  const h = harness()
  h.projections.values.userQuestions = continuedView('call-1', [pickOne])
  h.projections.asOfSeq = -1
  assert.equal(h.adapter.read()!.asOfSeq, -1)
  h.projections.asOfSeq = Number.NaN
  assert.equal('asOfSeq' in h.adapter.read()!, false)
})

// ------------------------------------------------------------- capabilities

test('capabilities report only the mounted public faces', () => {
  const h = harness()
  assert.deepEqual(h.adapter.capabilities(), { list: true, answer: true })

  h.access.services.delete('userQuestions')
  assert.deepEqual(h.adapter.capabilities(), { list: true, answer: false })

  h.access.services.delete('sessionProjections')
  assert.deepEqual(h.adapter.capabilities(), { list: false, answer: false })

  // A throwing host lookup is an unmounted face, never a crash.
  h.access.service = (name: string): unknown => {
    h.access.serviceCalls.push(name)
    throw new Error('no such service')
  }
  assert.deepEqual(h.adapter.capabilities(), { list: false, answer: false })
})

// ------------------------------------------------------------ late answer

test('late answer normalizes the existing DecisionDialog values to the native batch', async () => {
  const h = harness()
  h.projections.values.userQuestions = continuedView('call-1', [pickMany, pickOne, freeform])

  const result = await h.adapter.answer({
    callId: 'call-1',
    answer: { answers: [['Types', 'Lint'], 'Unknown mode', 'typed note'] },
  })

  assert.deepEqual(result, { callId: 'call-1', outcome: 'accepted' })
  assert.equal(h.questions.answerCalls.length, 1)
  const call = h.questions.answerCalls[0]!
  // Exact root Agent object supplied by the seam, untouched.
  assert.equal(call.agent, h.agent)
  assert.equal(call.callId, 'call-1')
  assert.deepEqual(call.answer, {
    answers: [
      { id: 'q2', selected: ['Types', 'Lint'] },
      { id: 'q1', selected: [], custom: 'Unknown mode' },
      { id: 'q3', selected: [], custom: 'typed note' },
    ],
  })
  // No foreground wait claim, no Agent materialization, no second service.
  assert.equal(h.questions.attachWaitCalls.length, 0)
  assert.deepEqual([...new Set(h.access.serviceCalls)].sort(), ['sessionProjections', 'userQuestions'])
})

test('late answer preserves selected-vs-custom meaning for skips and multi-select', async () => {
  const h = harness()
  h.projections.values.userQuestions = continuedView('call-1', [pickOne, pickMany, freeform])

  await h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast', ['Lint'], ''] } })
  assert.deepEqual(h.questions.answerCalls[0]!.answer, {
    answers: [
      { id: 'q1', selected: ['Fast'] },
      { id: 'q2', selected: ['Lint'] },
      { id: 'q3', selected: [] },
    ],
  })

  // An array with only an empty string is the native skip for that question.
  await h.adapter.answer({ callId: 'call-1', answer: { answers: [[], [''], []] } })
  assert.deepEqual(h.questions.answerCalls[1]!.answer, {
    answers: [
      { id: 'q1', selected: [] },
      { id: 'q2', selected: [] },
      { id: 'q3', selected: [] },
    ],
  })

  // Two free-form entries are two custom lines, never fabricated labels.
  await h.adapter.answer({ callId: 'call-1', answer: { answers: ['', [''], ['line one', 'line two']] } })
  assert.deepEqual(h.questions.answerCalls[2]!.answer, {
    answers: [
      { id: 'q1', selected: [] },
      { id: 'q2', selected: [] },
      { id: 'q3', selected: [], custom: 'line one\nline two' },
    ],
  })

  // A bare array is the same positional dialog value.
  await h.adapter.answer({ callId: 'call-1', answer: ['Careful', ['Lint', 'Types'], 'x'] })
  assert.deepEqual(h.questions.answerCalls[3]!.answer, {
    answers: [
      { id: 'q1', selected: ['Careful'] },
      { id: 'q2', selected: ['Lint', 'Types'] },
      { id: 'q3', selected: [], custom: 'x' },
    ],
  })
})

test('late answer accepts an already-native batch in native question order', async () => {
  const h = harness()
  h.projections.values.userQuestions = continuedView('call-1', [pickOne, pickMany, freeform])

  await h.adapter.answer({
    callId: 'call-1',
    answer: {
      answers: [
        { id: 'q3', selected: [], custom: 'done' },
        { id: 'q2', selected: ['Lint'], custom: 'also typecheck' },
        { id: 'q1', selected: ['Fast'], custom: 'custom wins' },
      ],
    },
  })

  assert.deepEqual(h.questions.answerCalls[0]!.answer, {
    answers: [
      // single-select: native custom overrides the chosen option.
      { id: 'q1', selected: [], custom: 'custom wins' },
      // multi-select: custom supplements the selected labels.
      { id: 'q2', selected: ['Lint'], custom: 'also typecheck' },
      { id: 'q3', selected: [], custom: 'done' },
    ],
  })
})

test('late answer validates caller mistakes without writing', async () => {
  const h = harness()
  h.projections.values.userQuestions = continuedView('call-1', [pickOne, pickMany, freeform])

  const cases: Array<{ answer: unknown; code: string }> = [
    { answer: { cancelled: true }, code: 'INVALID_ARGUMENT' },
    { answer: { outcome: 'cancelled' }, code: 'INVALID_ARGUMENT' },
    { answer: undefined, code: 'INVALID_ANSWER' },
    { answer: { answers: 'no' }, code: 'INVALID_ANSWER' },
    { answer: { answers: ['Fast'] }, code: 'INVALID_ANSWER' },
    { answer: { answers: ['Fast', ['Lint'], 'x', 'extra'] }, code: 'INVALID_ANSWER' },
    { answer: { answers: [42, ['Lint'], 'x'] }, code: 'INVALID_ANSWER' },
    { answer: { answers: ['Fast', ['Lint'], ['x', 1]] }, code: 'INVALID_ANSWER' },
    { answer: { answers: [['Fast', 'Careful'], ['Lint'], 'x'] }, code: 'INVALID_ANSWER' },
    { answer: { answers: [{ id: 'q1', selected: ['Nope'] }, { id: 'q2', selected: [] }, { id: 'q3', selected: [] }] }, code: 'INVALID_ANSWER' },
    { answer: { answers: [{ id: 'q1', selected: ['Fast'] }, { id: 'q1', selected: [] }, { id: 'q3', selected: [] }] }, code: 'INVALID_ANSWER' },
    { answer: { answers: [{ id: 'q1', selected: ['Fast'] }, { id: 'q2', selected: [] }] }, code: 'INVALID_ANSWER' },
    { answer: { answers: [{ id: 'q1', selected: ['Fast'] }, { id: 'q2', selected: [] }, { id: 'q3', selected: [], custom: 1 }] }, code: 'INVALID_ANSWER' },
  ]
  for (const item of cases) {
    await assert.rejects(
      () => h.adapter.answer({ callId: 'call-1', answer: item.answer }),
      (error: unknown) => codeOf(error) === item.code,
      `expected ${item.code} for ${JSON.stringify(item.answer)}`,
    )
  }
  assert.equal(h.questions.answerCalls.length, 0)

  await assert.rejects(() => h.adapter.answer({ callId: '', answer: { answers: [] } }), (error: unknown) => codeOf(error) === 'INVALID_ARGUMENT')
  await assert.rejects(() => h.adapter.answer(null as never), (error: unknown) => codeOf(error) === 'INVALID_ARGUMENT')
})

test('a call that is not continued is unavailable and never written', async () => {
  const h = harness()
  h.projections.values.userQuestions = nativeView([pendingCall('call-1', 'open', [pickOne])])
  assert.deepEqual(await h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } }), {
    callId: 'call-1',
    outcome: 'unavailable',
  })

  // Settled / closed call, and a foreign call id, are the same native fact.
  h.projections.values.userQuestions = nativeView([], [{ callId: 'call-1', answers: [{ id: 'q1', selected: ['Fast'] }] }])
  assert.deepEqual(await h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } }), {
    callId: 'call-1',
    outcome: 'unavailable',
  })
  assert.deepEqual(await h.adapter.answer({ callId: 'call-foreign', answer: { answers: ['Fast'] } }), {
    callId: 'call-foreign',
    outcome: 'unavailable',
  })
  assert.equal(h.questions.answerCalls.length, 0)
})

test('a call settled between the UI read and submit is unavailable, never replayed', async () => {
  const h = harness()
  h.projections.values.userQuestions = continuedView('call-1', [pickOne])
  assert.equal(h.adapter.read()!.active[0]!.state, 'continued')

  // The call closed in DSH between the dialog opening and the submit.
  h.projections.values.userQuestions = nativeView([], [{ callId: 'call-1', answers: [{ id: 'q1', selected: ['Fast'] }] }])
  assert.deepEqual(await h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } }), {
    callId: 'call-1',
    outcome: 'unavailable',
  })
  assert.equal(h.questions.answerCalls.length, 0)
})

test('an open call that becomes continued after the first read is answerable again', async () => {
  const h = harness()
  h.projections.values.userQuestions = nativeView([pendingCall('call-1', 'open', [pickOne])])
  // The live foreground wait expires natively; the projection flips the row.
  assert.deepEqual(await h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } }), {
    callId: 'call-1',
    outcome: 'unavailable',
  })
  assert.equal(h.questions.answerCalls.length, 0)

  h.projections.values.userQuestions = continuedView('call-1', [pickOne])
  assert.deepEqual(await h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } }), {
    callId: 'call-1',
    outcome: 'accepted',
  })
  assert.equal(h.questions.answerCalls.length, 1)
})

test('native accepted false means the call is no longer continued', async () => {
  const h = harness()
  h.projections.values.userQuestions = continuedView('call-1', [pickOne])
  h.questions.result = false
  assert.deepEqual(await h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } }), {
    callId: 'call-1',
    outcome: 'unavailable',
  })
  assert.equal(h.questions.answerCalls.length, 1)
})

test('queued late replies are reported as queued, not as a failure', async () => {
  const h = harness()
  h.projections.values.userQuestions = continuedView('call-1', [pickOne])
  h.questions.result = nativeFailure('REPLY_QUEUED')
  assert.deepEqual(await h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } }), {
    callId: 'call-1',
    outcome: 'queued',
  })
})

// ------------------------------------------------------- root authority / stale

test('root-only native authority maps to stale, never to a TUI permission copy', async () => {
  const h = harness()
  h.projections.values.userQuestions = continuedView('call-1', [pickOne])

  h.questions.result = nativeFailure('CALLER_NOT_LIVE')
  assert.deepEqual(await h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } }), {
    callId: 'call-1',
    outcome: 'stale',
  })

  h.questions.result = nativeFailure('DELEGATED_CALLER')
  assert.deepEqual(await h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } }), {
    callId: 'call-1',
    outcome: 'stale',
  })
  assert.equal(h.questions.answerCalls.length, 2)
})

test('an answer requires the exact live root Agent supplied by the scope', async () => {
  const h = harness()
  h.projections.values.userQuestions = continuedView('call-1', [pickOne])

  h.access.scope = { sessionId: ROOT, attachmentId: ATTACHMENT, session: h.session }
  await assert.rejects(
    () => h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } }),
    (error: unknown) => codeOf(error) === 'CAPABILITY_UNAVAILABLE',
  )

  h.access.scope = { sessionId: ROOT, attachmentId: ATTACHMENT, session: h.session, agent: { id: 'some-child' } }
  await assert.rejects(
    () => h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } }),
    (error: unknown) => codeOf(error) === 'CAPABILITY_UNAVAILABLE',
  )
  assert.equal(h.questions.answerCalls.length, 0)

  // A missing answer service is unavailable before any projection fold.
  h.access.scope = { sessionId: ROOT, attachmentId: ATTACHMENT, session: h.session, agent: h.agent }
  h.access.services.delete('userQuestions')
  h.projections.calls.length = 0
  await assert.rejects(
    () => h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } }),
    (error: unknown) => codeOf(error) === 'CAPABILITY_UNAVAILABLE',
  )
  assert.equal(h.projections.calls.length, 0)
})

test('attachment replacement before the write is stale and never submitted', async () => {
  const h = harness()
  h.projections.values.userQuestions = continuedView('call-1', [pickOne])
  h.access.scope = { sessionId: 'other-root', attachmentId: 'other-attachment', session: h.session, agent: h.agent }
  const previous = h.access.scope
  h.access.scope = { sessionId: ROOT, attachmentId: ATTACHMENT, session: h.session, agent: h.agent }
  // Force the seam to report the captured scope as no longer current.
  h.access.isCurrent = (): boolean => false

  assert.deepEqual(await h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } }, previous), {
    callId: 'call-1',
    outcome: 'stale',
  })
  assert.equal(h.questions.answerCalls.length, 0)
  assert.equal(h.projections.calls.length, 0)
})

test('attachment replacement during the write is stale, accepted once, never retried', async () => {
  const h = harness()
  h.projections.values.userQuestions = continuedView('call-1', [pickOne])
  h.access.identityCheck = false
  h.questions.duringAnswer = () => {
    // The native write queues the reply, then a synchronous surface switch retires the root.
    h.access.scope = { sessionId: 'next-root', attachmentId: 'next-attachment', session: { id: 'next-root' }, agent: { id: 'next-root' } }
  }

  assert.deepEqual(await h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } }), {
    callId: 'call-1',
    outcome: 'stale',
  })
  assert.equal(h.questions.answerCalls.length, 1)

  // Field-identity implementations of the seam are also honored.
  const h2 = harness()
  h2.projections.values.userQuestions = continuedView('call-1', [pickOne])
  h2.access.identityCheck = false
  assert.equal((await h2.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } })).outcome, 'accepted')
})

// -------------------------------------------------------------- boundaries

test('a pending Agent-less Session cannot answer and materializes nothing', async () => {
  const h = harness()
  h.projections.values.userQuestions = continuedView('call-1', [pickOne])
  h.access.scope = { sessionId: ROOT, attachmentId: ATTACHMENT }

  await assert.rejects(
    () => h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } }),
    (error: unknown) => codeOf(error) === 'CAPABILITY_UNAVAILABLE',
  )
  assert.equal(h.questions.answerCalls.length, 0)
  assert.equal(h.projections.calls.length, 0)
  // No `agents`/`sessions` service is ever consulted, so no Agent can appear.
  assert.equal(h.access.serviceCalls.includes('agents'), false)
  assert.equal(h.access.serviceCalls.includes('sessions'), false)
})

test('a malformed projection blocks the late answer instead of guessing questions', async () => {
  const h = harness()
  h.projections.values.userQuestions = { active: 'broken', settled: [] }
  await assert.rejects(
    () => h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } }),
    (error: unknown) => codeOf(error) === 'CAPABILITY_UNAVAILABLE',
  )
  assert.equal(h.questions.answerCalls.length, 0)
})

test('an unclassified native failure stays a redacted stable adapter error', async () => {
  const h = harness()
  h.projections.values.userQuestions = continuedView('call-1', [pickOne])
  h.questions.result = new Error('native exploded with apiKey=sk-super-secret-value and Authorization: Bearer abc.def')

  await assert.rejects(
    () => h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } }),
    (error: unknown) => {
      assert.equal(codeOf(error), 'RUNTIME_REQUEST_FAILED')
      const message = (error as Error).message
      assert.equal(message.includes('sk-super-secret-value'), false)
      assert.equal(message.includes('abc.def'), false)
      return true
    },
  )
})

test('a non-boolean native outcome is a protocol failure, not an acceptance', async () => {
  const h = harness()
  h.projections.values.userQuestions = continuedView('call-1', [pickOne])
  h.questions.result = undefined as never
  await assert.rejects(
    () => h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } }),
    (error: unknown) => codeOf(error) === 'RUNTIME_REQUEST_FAILED',
  )
})

test('a throwing seam read or host diagnostic never breaks the adapter', async () => {
  const h = harness()
  h.projections.values.userQuestions = continuedView('call-1', [pickOne])

  // A host that reports itself unavailable is a stale answer, not a crash.
  h.access.isCurrent = (): boolean => {
    throw new Error('host identity check failed')
  }
  assert.deepEqual(await h.adapter.answer({ callId: 'call-1', answer: { answers: ['Fast'] } }), {
    callId: 'call-1',
    outcome: 'stale',
  })
  assert.equal(h.questions.answerCalls.length, 0)

  // A throwing current() read is no attachment at all.
  h.access.current = (): NativeUiScope | undefined => {
    throw new Error('host scope read failed')
  }
  assert.equal(h.adapter.read(), undefined)

  // A throwing warning sink is swallowed while the read still succeeds.
  const h2 = harness()
  h2.projections.values.userQuestions = continuedView('call-1', [pickOne])
  h2.access.warn = (): void => {
    throw new Error('sink failed')
  }
  h2.projections.failure = new Error('projection failed')
  assert.equal(h2.adapter.read()!.available, false)
})

test('questions-domain projection keys are exact and no other invalidation is claimed', () => {
  assert.deepEqual([...USER_QUESTION_PROJECTION_KEYS], ['userQuestions', 'inbox'])
  assert.equal(isUserQuestionProjectionKey('userQuestions'), true)
  assert.equal(isUserQuestionProjectionKey('inbox'), true)
  assert.equal(isUserQuestionProjectionKey('todos'), false)
  assert.equal(isUserQuestionProjectionKey('userquestions'), false)
})