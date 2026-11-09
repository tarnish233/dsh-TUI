/**
 * Native timed/continued `ask_user_question` pending view and late answer.
 *
 * DSH owns every fact here. The pending list is the public `userQuestions`
 * session projection, folded by the native projection registry: the adapter
 * calls `ctx.sessionProjections.snapshot(exactSession, ['userQuestions',
 * 'inbox'])` (one consistent cut) and validates the wire value. A late answer
 * is the public `ctx.userQuestions.answer(agent, callId, answer)` write, whose
 * own `assertLiveRoot` (exact live instance + runtime root) is the authority
 * for who may answer. Nothing is folded, timed, cached or persisted here:
 *
 * - no `PendingDecision` entry, no blocking-promise settlement and no second
 *   answer store;
 * - no TUI timer: expiry is native (`TimedQuestionWait`), and its outcome is
 *   the projection row that becomes `continued`;
 * - no Agent/Session materialization for discovery (the pending attachment has
 *   no native Session object yet, so the view is honestly unavailable);
 * - no cancel path: DSH exposes no way to abandon a continued question, and a
 *   local dialog close must send nothing. A skip is a real answer
 *   (`{id, selected: []}`), never a cancellation.
 *
 * Blocking waterfall questions stay owned by `src/backend/context.ts`: the
 * native legacy tool's calls appear in neither projection half, so this
 * adapter can never convert a blocking decision into a continued one.
 *
 * @module dsh-tui/backend/native-questions
 */
import { asBackendError, backendError, redactDiagnostic } from './errors.ts'
import type { NativeUiAccess, NativeUiScope } from './native-ui-scope.ts'

/** One selectable answer of a continued question, exactly as DSH projected it. */
export interface ContinuedQuestionOption {
  readonly label: string
  readonly description?: string
}

/**
 * One original question of a continued call. `id`, question text and option
 * labels are the native values the eventual answer must echo; this adapter
 * never renames, reorders or fabricates them.
 */
export interface ContinuedQuestion {
  /** Stable caller-provided native question id; required by the native answer batch. */
  readonly id: string
  readonly question: string
  readonly header?: string
  /** Accepted when a future native view carries it; the shipped projection vocabulary has no detail. */
  readonly detail?: string
  /** Present only when true; absence is native single-select. */
  readonly multiSelect?: boolean
  /** Absent means the question is free-form (no declared option labels). */
  readonly options?: readonly ContinuedQuestionOption[]
}

/** One answer item in DSH's native vocabulary: labels in `selected`, free text in `custom`. */
export interface ContinuedQuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** Native `UserQuestionState`: `open` is still owned by the live blocking request. */
export type ContinuedQuestionState = 'open' | 'continued'

/** One timed `ask_user_question` call from the native projection, in native ask order. */
export interface ContinuedQuestionRow {
  readonly callId: string
  readonly state: ContinuedQuestionState
  readonly questions: readonly ContinuedQuestion[]
  /**
   * True while a late reply for this call waits in the native durable inbox.
   * Absent when the native `inbox` projection is not readable (unknown, not false).
   */
  readonly replyQueued?: boolean
}

/** One call the native projection recorded as settled by an answer batch. */
export interface SettledQuestionRow {
  readonly callId: string
  readonly answers: readonly ContinuedQuestionAnswerItem[]
}

/** Both halves of one Session's native timed-question state, validated and detached. */
export interface ContinuedQuestionsView {
  readonly sessionId: string
  readonly attachmentId?: string
  /**
   * True only when the native `userQuestions` projection was registered and
   * readable for this exact Session. False means "unknown", never "no pending
   * questions": a pending Agent-less Session has no native Session object yet.
   */
  readonly available: boolean
  /** Native ask order. `open` rows must be answered through the blocking waterfall. */
  readonly active: readonly ContinuedQuestionRow[]
  /** Native settlement order. */
  readonly settled: readonly SettledQuestionRow[]
  /** Native `snapshot().asOfSeq` for parent-side ordering/dedup, when it is a valid cursor. */
  readonly asOfSeq?: number
}

/** Which native faces are actually mounted. `answer` implies `list`. */
export interface NativeQuestionCapabilities {
  /** `sessionProjections.snapshot` is mounted; the pending list can be read. */
  readonly list: boolean
  /** `userQuestions.answer` plus the projection are mounted; a late answer can be submitted. */
  readonly answer: boolean
}

/**
 * Result of one late-answer submission.
 *
 * - `accepted` — native `answer` returned true; the reply is queued until the
 *   Agent admits its user message.
 * - `queued` — a reply for this call was already waiting for admission.
 * - `unavailable` — the call is no longer answerable for this attachment (it
 *   was settled, the projection no longer lists it, or it is still `open` and
 *   owned by the live blocking request). Nothing was written.
 * - `stale` — the attachment identity changed; the caller must drop the dialog
 *   and must not retry. A reply may already have been queued in the previous
 *   attachment, which DSH owns and this adapter never replays.
 */
export type ContinuedAnswerOutcome = 'accepted' | 'queued' | 'unavailable' | 'stale'

export interface ContinuedAnswerResult {
  readonly callId: string
  readonly outcome: ContinuedAnswerOutcome
}

/**
 * One late answer.
 *
 * `answer` accepts the existing `DecisionDialog` value
 * (`{ answers: (string | string[])[] }`, one entry per native question in ask
 * order, `''`/`[]` = skip) or an already-native
 * `{ answers: { id, selected, custom? }[] }` batch. A cancelled value is
 * refused: a continued question has no native cancellation.
 */
export interface NativeQuestionAnswerInput {
  readonly callId: string
  readonly answer: unknown
}

export interface NativeQuestionAdapterOptions {
  readonly access: NativeUiAccess
}

/** Native projection keys whose change invalidates the questions domain. */
export const USER_QUESTION_PROJECTION_KEYS = ['userQuestions', 'inbox'] as const

/**
 * Whether one native projection key is a questions-domain invalidation.
 * `userQuestions` is the required one; `inbox` only refines `replyQueued`.
 */
export function isUserQuestionProjectionKey(key: string): boolean {
  return (USER_QUESTION_PROJECTION_KEYS as readonly string[]).includes(key)
}

interface ProjectionService {
  snapshot?(session: unknown, keys?: readonly string[]): unknown
}

interface AnswerService {
  answer?(agent: unknown, callId: unknown, answer: unknown): unknown
}

/** Validated view of one supplied attachment scope; `raw` keeps the exact host object. */
interface ScopeFacts {
  readonly raw: NativeUiScope
  readonly sessionId: string
  readonly attachmentId?: string
}

type Raw = Record<string, unknown>

function record(value: unknown): Raw | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Raw : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** The native failure code of one thrown value, without copying any payload. */
function nativeCodeOf(error: unknown): string | undefined {
  const item = record(error)
  return text(item?.code)
}

function diagnosticOf(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name
  if (typeof error === 'string' && error.length > 0) return error
  const item = record(error)
  return text(item?.message) ?? text(item?.name) ?? 'the native user-questions service failed'
}

/** Marker for a shape that is not this adapter's native vocabulary. */
class InvalidView extends Error {}

function invalidView(message: string): never {
  throw new InvalidView(message)
}

function validateOption(value: unknown): ContinuedQuestionOption {
  const item = record(value)
  const label = text(item?.label)
  if (item === undefined || label === undefined) invalidView('an option has no string label')
  const description = optionalText(item.description)
  return {
    label,
    ...(description === undefined ? {} : { description }),
  }
}

function validateQuestion(value: unknown): ContinuedQuestion {
  const item = record(value)
  if (item === undefined) invalidView('a question is not an object')
  const id = text(item.id)
  if (id === undefined) invalidView('a question has no string id')
  if (typeof item.question !== 'string') invalidView('a question has no string text')
  const header = optionalText(item.header)
  const detail = optionalText(item.detail)
  if (item.multiSelect !== undefined && typeof item.multiSelect !== 'boolean') {
    invalidView('a question has a non-boolean multiSelect')
  }
  let options: ContinuedQuestionOption[] | undefined
  if (item.options !== undefined) {
    if (!Array.isArray(item.options)) invalidView('question options are not an array')
    options = item.options.map(validateOption)
  }
  return {
    id,
    question: item.question,
    ...(header === undefined ? {} : { header }),
    ...(detail === undefined ? {} : { detail }),
    ...(item.multiSelect === true ? { multiSelect: true } : {}),
    ...(options === undefined ? {} : { options }),
  }
}

function validateAnswerItem(value: unknown): ContinuedQuestionAnswerItem {
  const item = record(value)
  if (item === undefined) invalidView('an answer is not an object')
  const id = text(item.id)
  if (id === undefined) invalidView('an answer has no string id')
  if (!Array.isArray(item.selected) || item.selected.some(entry => typeof entry !== 'string')) {
    invalidView('an answer has no string selected list')
  }
  const custom = optionalText(item.custom)
  return {
    id,
    selected: [...item.selected] as string[],
    ...(custom === undefined ? {} : { custom }),
  }
}

function validateActiveRow(value: unknown): ContinuedQuestionRow {
  const item = record(value)
  if (item === undefined) invalidView('an active question row is not an object')
  const callId = text(item.callId)
  if (callId === undefined) invalidView('an active question row has no string callId')
  if (item.state !== 'open' && item.state !== 'continued') invalidView('an active question row has an unknown state')
  if (!Array.isArray(item.questions) || item.questions.length === 0) {
    invalidView('an active question row has no questions')
  }
  const questions = item.questions.map(validateQuestion)
  const ids = new Set<string>()
  for (const question of questions) {
    if (ids.has(question.id)) invalidView('an active question row repeats a question id')
    ids.add(question.id)
  }
  return { callId, state: item.state, questions }
}

function validateSettledRow(value: unknown): SettledQuestionRow {
  const item = record(value)
  if (item === undefined) invalidView('a settled question row is not an object')
  const callId = text(item.callId)
  if (callId === undefined) invalidView('a settled question row has no string callId')
  if (!Array.isArray(item.answers)) invalidView('a settled question row has no answer list')
  return { callId, answers: item.answers.map(validateAnswerItem) }
}

/** Validate DSH's whole `userQuestions` wire view; any mismatch rejects the view. */
function validateView(value: unknown): Pick<ContinuedQuestionsView, 'active' | 'settled'> {
  const item = record(value)
  if (item === undefined) invalidView('the userQuestions projection is not an object')
  if (!Array.isArray(item.active) || !Array.isArray(item.settled)) {
    invalidView('the userQuestions projection has no active/settled lists')
  }
  const active = item.active.map(validateActiveRow)
  const callIds = new Set<string>()
  for (const row of active) {
    if (callIds.has(row.callId)) invalidView('the userQuestions projection repeats an active callId')
    callIds.add(row.callId)
  }
  return { active, settled: item.settled.map(validateSettledRow) }
}

/**
 * Read the queued late replies out of DSH's native `inbox` projection.
 * Only the two native lists and the `user-question-reply` source kind are
 * interpreted; every other pending message is ignored as DSH's own queue fact.
 * @param value - the projection's whole wire value.
 * @returns queued call ids, or undefined when the value is not the native shape.
 */
function queuedReplyCallIds(value: unknown): Set<string> | undefined {
  const item = record(value)
  if (item === undefined) return undefined
  const nextTurn = item['next-turn']
  const nextStep = item['next-step']
  if (!Array.isArray(nextTurn) || !Array.isArray(nextStep)) return undefined
  const queued = new Set<string>()
  for (const message of [...nextTurn, ...nextStep]) {
    const source = record(record(message)?.source)
    if (source?.kind !== 'user-question-reply') continue
    const callId = text(source.callId)
    if (callId !== undefined) queued.add(callId)
  }
  return queued
}

/** One normalized answer batch, or a coded rejection for a caller mistake. */
type AnswerBatch = { readonly answers: ContinuedQuestionAnswerItem[] }

/**
 * Positional `DecisionDialog` values: one `string | string[]` per native
 * question. Unknown text is the free-form answer, never a fabricated label.
 */
function batchFromPositional(
  questions: readonly ContinuedQuestion[],
  list: readonly unknown[],
): AnswerBatch {
  if (list.length !== questions.length) {
    throw backendError('INVALID_ANSWER', `the answer batch must name each of ${questions.length} questions exactly once`)
  }
  return {
    answers: questions.map((question, index) => {
      const labels = new Set((question.options ?? []).map(option => option.label))
      const raw = list[index]
      const values = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : undefined
      if (values === undefined) {
        throw backendError('INVALID_ANSWER', `question ${question.id} must be answered with a string or string list`)
      }
      const selected: string[] = []
      let custom: string | undefined
      for (const entry of values) {
        if (typeof entry !== 'string') {
          throw backendError('INVALID_ANSWER', `question ${question.id} has a non-string answer entry`)
        }
        // '' (and an empty list) is the native skip: selected stays empty, no custom.
        if (entry.length === 0) continue
        if (labels.has(entry)) {
          if (!selected.includes(entry)) selected.push(entry)
        } else {
          custom = custom === undefined ? entry : `${custom}\n${entry}`
        }
      }
      if (question.multiSelect !== true) {
        if (selected.length > 1) {
          throw backendError('INVALID_ANSWER', `question ${question.id} accepts one selection`)
        }
        // Native meaning: a single-select custom answer overrides the choice.
        if (custom !== undefined) selected.length = 0
      }
      return {
        id: question.id,
        selected,
        ...(custom === undefined ? {} : { custom }),
      }
    }),
  }
}

/**
 * Already-native batches. Declared option labels stay `selected`; anything else
 * is refused rather than reclassified, because a native batch states its own
 * vocabulary. Native single-select semantics are preserved (`custom` wins).
 */
function batchFromNative(
  questions: readonly ContinuedQuestion[],
  list: readonly unknown[],
): AnswerBatch {
  const byId = new Map<string, unknown>()
  for (const entry of list) {
    const item = record(entry)
    const id = text(item?.id)
    if (item === undefined || id === undefined) {
      throw backendError('INVALID_ANSWER', 'each answer item must be an object with a string id')
    }
    if (byId.has(id)) throw backendError('INVALID_ANSWER', `the answer batch repeats question ${id}`)
    byId.set(id, item)
  }
  if (byId.size !== questions.length || questions.some(question => !byId.has(question.id))) {
    throw backendError('INVALID_ANSWER', `the answer batch must name each of ${questions.length} questions exactly once`)
  }
  const answers = questions.map((question) => {
    const item: Raw = record(byId.get(question.id)) ?? {}
    if (!Array.isArray(item.selected) || item.selected.some(entry => typeof entry !== 'string')) {
      throw backendError('INVALID_ANSWER', `question ${question.id} must carry a string selected list`)
    }
    if (item.custom !== undefined && typeof item.custom !== 'string') {
      throw backendError('INVALID_ANSWER', `question ${question.id} has a non-string custom answer`)
    }
    const labels = new Set((question.options ?? []).map(option => option.label))
    const selected: string[] = []
    for (const entry of item.selected as string[]) {
      if (!labels.has(entry)) {
        throw backendError('INVALID_ANSWER', `question ${question.id} selected a label it does not declare`)
      }
      if (!selected.includes(entry)) selected.push(entry)
    }
    const custom = typeof item.custom === 'string' && item.custom.length > 0 ? item.custom : undefined
    if (question.multiSelect !== true) {
      if (selected.length > 1) {
        throw backendError('INVALID_ANSWER', `question ${question.id} accepts one selection`)
      }
      if (custom !== undefined) selected.length = 0
    }
    return {
      id: question.id,
      selected,
      ...(custom === undefined ? {} : { custom }),
    }
  })
  return { answers }
}

function isCancelledValue(value: unknown): boolean {
  const item = record(value)
  return item?.cancelled === true || item?.outcome === 'cancelled'
}

/** Whether a value looks like the native answer-item vocabulary rather than dialog values. */
function isNativeBatch(list: readonly unknown[]): boolean {
  return list.length > 0 && list.every(entry => record(entry) !== undefined && 'id' in (entry as Raw))
}

function normalizeAnswer(questions: readonly ContinuedQuestion[], value: unknown): AnswerBatch {
  if (isCancelledValue(value)) {
    // A continued question has no native cancellation: closing the panel sends
    // nothing, and a deliberate skip is a real `{id, selected: []}` answer.
    throw backendError('INVALID_ARGUMENT', 'a continued question cannot be cancelled; close the dialog locally or submit a skip')
  }
  const item = record(value)
  if (Array.isArray(value)) return normalizeList(questions, value)
  if (item === undefined || !Array.isArray(item.answers)) {
    throw backendError('INVALID_ANSWER', 'the answer must be {answers: (string|string[])[]} or {answers: {id,selected,custom?}[]}')
  }
  return normalizeList(questions, item.answers)
}

function normalizeList(questions: readonly ContinuedQuestion[], list: readonly unknown[]): AnswerBatch {
  if (isNativeBatch(list)) return batchFromNative(questions, list)
  return batchFromPositional(questions, list)
}

/**
 * One read + one native write over the host's public user-questions faces.
 *
 * Construct once per adapter lifetime. The class keeps no pending state, adds
 * no listener and starts no timer; the parent owns the projection subscription
 * and emits `native_ui_changed` with `domain: 'questions'`.
 */
export class NativeQuestionAdapter {
  private readonly options: NativeQuestionAdapterOptions
  /** Bounded diagnostic dedupe; never a data cache. */
  private readonly warned = new Set<string>()

  constructor(options: NativeQuestionAdapterOptions) {
    this.options = options
  }

  private get access(): NativeUiAccess {
    return this.options.access
  }

  private face<T>(name: string): T | undefined {
    let value: unknown
    try {
      value = this.access.service(name)
    } catch {
      return undefined
    }
    return record(value) === undefined ? undefined : value as T
  }

  private warn(message: string): void {
    if (this.warned.has(message) || this.warned.size >= 8) return
    this.warned.add(message)
    try {
      this.access.warn?.(message)
    } catch {
      /* diagnostics never break a read or write */
    }
  }

  /** Which public native faces are mounted right now. */
  capabilities(): NativeQuestionCapabilities {
    const list = typeof this.face<ProjectionService>('sessionProjections')?.snapshot === 'function'
    const answer = list && typeof this.face<AnswerService>('userQuestions')?.answer === 'function'
    return { list, answer }
  }

  private isCurrent(scope: NativeUiScope): boolean {
    try {
      return this.access.isCurrent(scope) === true
    } catch {
      return false
    }
  }

  /**
   * Validate one scope while preserving the exact supplied object: the host's
   * `isCurrent` may compare the object it handed out, so it is never replaced
   * by a normalized copy.
   */
  private currentScope(scope: NativeUiScope | undefined): ScopeFacts | undefined {
    let candidate: unknown = scope
    if (candidate === undefined) {
      try {
        candidate = this.access.current()
      } catch {
        return undefined
      }
    }
    const item = record(candidate)
    const sessionId = text(item?.sessionId)
    if (item === undefined || sessionId === undefined) return undefined
    const attachmentId = text(item.attachmentId)
    return {
      raw: candidate as NativeUiScope,
      sessionId,
      ...(attachmentId === undefined ? {} : { attachmentId }),
    }
  }

  /**
   * The exact native Session of the scope, or undefined. A Session object that
   * does not belong to the scope's session id is refused rather than read.
   */
  private sessionOf(scope: ScopeFacts): unknown {
    const session = record(scope.raw.session)
    if (session === undefined) return undefined
    const id = text(session.id)
    if (id === undefined || id !== scope.sessionId) {
      this.warn('native questions: the supplied Session does not belong to the current attachment')
      return undefined
    }
    return scope.raw.session
  }

  /**
   * Read the native pending-question view for one attachment.
   *
   * Read-only and synchronous: no Agent/Session is created or resolved, no
   * service mutation happens, and no state is kept between calls. `undefined`
   * means there is no current attachment at all; `available: false` means the
   * native projection could not be read for this exact Session.
   *
   * @param scope - exact supplied attachment identity; defaults to the current one.
   * @returns validated detached native rows, or undefined without an attachment.
   */
  read(scope?: NativeUiScope): ContinuedQuestionsView | undefined {
    const current = this.currentScope(scope)
    if (current === undefined) return undefined
    return this.viewOf(current)
  }

  /** Validated projection read for one already-validated scope. */
  private viewOf(current: ScopeFacts): ContinuedQuestionsView {
    const base = {
      sessionId: current.sessionId,
      ...(current.attachmentId === undefined ? {} : { attachmentId: current.attachmentId }),
    }
    const unavailable: ContinuedQuestionsView = { ...base, available: false, active: [], settled: [] }
    const session = this.sessionOf(current)
    if (session === undefined) return unavailable
    const projections = this.face<ProjectionService>('sessionProjections')
    if (typeof projections?.snapshot !== 'function') return unavailable
    let snapshot: unknown
    try {
      snapshot = projections.snapshot(session, [...USER_QUESTION_PROJECTION_KEYS])
    } catch (error) {
      this.warn(`native user-questions projection is unavailable: ${redactDiagnostic(diagnosticOf(error))}`)
      return unavailable
    }
    const cut = record(snapshot)
    const values = record(cut?.values)
    const projected = values?.userQuestions
    if (projected === undefined || projected === null) return unavailable
    let view: Pick<ContinuedQuestionsView, 'active' | 'settled'>
    try {
      view = validateView(projected)
    } catch (error) {
      if (!(error instanceof InvalidView)) throw error
      this.warn(`native user-questions projection has an unexpected shape: ${redactDiagnostic(error.message)}`)
      return unavailable
    }
    const queued = values?.inbox === undefined || values.inbox === null
      ? undefined
      : queuedReplyCallIds(values.inbox)
    if (queued === undefined && values?.inbox !== undefined && values.inbox !== null) {
      this.warn('native inbox projection has an unexpected shape; queued late replies are unknown')
    }
    const asOfSeq = cut?.asOfSeq
    return {
      ...base,
      available: true,
      active: view.active.map(row => ({
        ...row,
        ...(queued === undefined ? {} : { replyQueued: queued.has(row.callId) }),
      })),
      settled: view.settled,
      ...(typeof asOfSeq === 'number' && Number.isSafeInteger(asOfSeq) && asOfSeq >= -1 ? { asOfSeq } : {}),
    }
  }

  /**
   * Submit one late answer for a continued call through the public native
   * service. The exact `NativeUiScope.agent` is passed unchanged, so DSH's own
   * live-root check (not a TUI permission copy) decides authority.
   *
   * Attachment identity is validated before the write and again after it; a
   * changed attachment never receives a retry, and an `open` row (still owned
   * by the blocking waterfall) is reported `unavailable`, never answered twice.
   *
   * @param input - call identity plus the dialog or native answer batch.
   * @param scope - exact supplied attachment identity; defaults to the current one.
   * @returns the native outcome; callers drop the dialog on `unavailable`/`stale`.
   * @throws {BackendError} `CAPABILITY_UNAVAILABLE` without the native faces,
   *   `INVALID_ARGUMENT`/`INVALID_ANSWER` for a caller mistake, or a redacted
   *   `RUNTIME_REQUEST_FAILED` for an unclassified native failure.
   */
  async answer(input: NativeQuestionAnswerInput, scope?: NativeUiScope): Promise<ContinuedAnswerResult> {
    const request = record(input)
    const callId = text(request?.callId)
    if (callId === undefined) throw backendError('INVALID_ARGUMENT', 'a late answer requires a non-empty callId')
    const current = this.currentScope(scope)
    if (current === undefined) {
      throw backendError('CAPABILITY_UNAVAILABLE', 'no current attachment accepts a question answer')
    }
    if (!this.isCurrent(current.raw)) return { callId, outcome: 'stale' }
    const capabilities = this.capabilities()
    if (!capabilities.answer) {
      throw backendError('CAPABILITY_UNAVAILABLE', 'the host exposes no public user-questions answer face with its projection')
    }
    const agent = record(current.raw.agent)
    if (agent === undefined || text(agent.id) !== current.sessionId) {
      throw backendError('CAPABILITY_UNAVAILABLE', 'a continued question requires the exact live root Agent of this attachment')
    }
    const view = this.viewOf(current)
    if (!view.available) {
      throw backendError('CAPABILITY_UNAVAILABLE', 'the native user-questions projection is not readable for this attachment')
    }
    const row = view.active.find(candidate => candidate.callId === callId)
    if (row === undefined) return { callId, outcome: 'unavailable' }
    if (row.state !== 'continued') {
      // `open` is still owned by the live blocking request in context.ts.
      return { callId, outcome: 'unavailable' }
    }
    const batch = normalizeAnswer(row.questions, request?.answer)
    const service = this.face<AnswerService>('userQuestions')
    const nativeAnswer = service?.answer
    if (service === undefined || typeof nativeAnswer !== 'function') {
      throw backendError('CAPABILITY_UNAVAILABLE', 'the host mounts no public user-questions answer service')
    }
    let accepted: unknown
    try {
      accepted = await nativeAnswer.call(service, current.raw.agent, callId, { answers: batch.answers })
    } catch (error) {
      const code = nativeCodeOf(error)
      if (code === 'REPLY_QUEUED') return { callId, outcome: 'queued' }
      if (code === 'CALLER_NOT_LIVE' || code === 'DELEGATED_CALLER') return { callId, outcome: 'stale' }
      if (code === 'BAD_ANSWER') throw backendError('INVALID_ANSWER', diagnosticOf(error))
      throw asBackendError(error, 'RUNTIME_REQUEST_FAILED')
    }
    if (!this.isCurrent(current.raw)) return { callId, outcome: 'stale' }
    if (accepted === true) return { callId, outcome: 'accepted' }
    if (accepted === false) return { callId, outcome: 'unavailable' }
    throw backendError('RUNTIME_REQUEST_FAILED', 'the native user-questions service returned no boolean answer outcome')
  }
}