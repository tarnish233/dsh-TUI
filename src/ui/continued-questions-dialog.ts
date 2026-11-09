/**
 * Display adapter for **native continued questions** (late answers).
 *
 * The parent answers a continued `ask_user_question` through the existing
 * `DecisionDialog`/`SelectDialog` and `NativeQuestionAdapter.answer()`. This
 * module therefore owns no dialog, no editor, no timer and no scheduler: it
 * only turns one `ContinuedQuestionsView` row into the shared picker item shape
 * (`label` / `description` / opaque `value`) so a second question surface is
 * never invented and the parent's routing stays one code path.
 *
 * Facts are native only (`src/backend/native-questions.ts`):
 * - `state` is the native `open`/`continued` value; an unrecognized value is
 *   painted verbatim, never mapped to "open".
 * - `replyQueued` is a native inbox fact ("a reply is already waiting for
 *   admission"); an absent field means the inbox half could not be read and is
 *   never described as "no reply".
 * - the call id is the opaque row identity. It is displayed for recognition and
 *   passed back through `DecisionOption.value` untouched.
 * - no local countdown, timeout, retry or auto-answer exists: the native
 *   blocking wait settles the `open` case, and `answer()` is the only write.
 *   A "skip" is a real empty answer chosen by the user, never a cancellation.
 *
 * Every string is sanitized and flattened to one line, so a native question
 * containing ANSI/controls/CJK/emoji cannot widen or repaint the picker.
 *
 * @module dsh-tui/ui/continued-questions-dialog
 */
import type { ContinuedQuestionRow, ContinuedQuestionsView } from '../backend/native-questions.ts'
import { oneLine, sanitize, truncateToWidth } from './text.ts'

/** Longest native question text carried into one picker line. */
const MAX_TEXT = 240

const STATE_LABEL: Readonly<Record<string, string>> = {
  open: 'open',
  continued: 'continued',
}

/** Native state word; unknown/blank is stated instead of guessed. */
export function continuedQuestionStateLabel(state: unknown): string {
  if (typeof state !== 'string' || state.trim() === '') return 'state unknown'
  const known = STATE_LABEL[state]
  if (known !== undefined) return known
  const text = oneLine(sanitize(state), 40)
  return text === '' ? 'state unknown' : text
}

/** First line of one native row: header/question, sanitized and flattened. */
export function continuedQuestionLabel(row: ContinuedQuestionRow | undefined, max = MAX_TEXT): string {
  const first = row?.questions?.[0]
  const header = oneLine(sanitize(typeof first?.header === 'string' ? first.header : ''), 60)
  const question = oneLine(sanitize(typeof first?.question === 'string' ? first.question : ''), max)
  if (question === '') {
    // A row without question text is still a real native call: identify it by
    // id rather than inventing a question.
    const callId = oneLine(sanitize(typeof row?.callId === 'string' ? row.callId : ''), 80)
    return truncateToWidth(callId === '' ? 'Native question' : `Native question ${callId}`, max)
  }
  const text = header === '' ? question : `${header} · ${question}`
  return truncateToWidth(text, Math.max(8, max))
}

/**
 * Second line of one native row: native state, how many questions the call
 * carries, whether a reply already waits, and the opaque call id. Absent facts
 * are omitted, never described as zero/none.
 */
export function continuedQuestionDetail(row: ContinuedQuestionRow | undefined): string {
  const parts: string[] = []
  parts.push(continuedQuestionStateLabel(row?.state))
  const questions = Math.max(0, Math.floor(row?.questions?.length ?? 0))
  if (questions > 0) parts.push(questions === 1 ? '1 question' : `${questions} questions`)
  if (row?.replyQueued === true) parts.push('reply queued')
  const callId = oneLine(sanitize(typeof row?.callId === 'string' ? row.callId : ''), 80)
  if (callId !== '') parts.push(callId)
  return parts.join(' · ')
}

/**
 * True only for a call this late-answer path may submit.
 *
 * Native authority (see the questions adapter): an `open` row is owned by the
 * live blocking waterfall — the existing question dialog answers it — and
 * `replyQueued` means a reply already waits for Agent admission, which native
 * `answer()`` refuses (`REPLY_QUEUED`). Both are therefore not answerable here;
 * an unknown state word is never treated as open.
 */
export function continuedQuestionAnswerable(row: ContinuedQuestionRow | undefined): boolean {
  if (row === undefined || row === null) return false
  return row.state === 'continued' && row.replyQueued !== true
}

/** Why a row is not answerable here; `''` means it is. */
export function continuedQuestionDisabledReason(row: ContinuedQuestionRow | undefined): string {
  if (row === undefined || row === null) return 'no native call'
  if (row.replyQueued === true) return 'reply already queued'
  if (row.state === 'open') return 'answered by the live question dialog'
  if (row.state !== 'continued') return 'native state is not a late-answer call'
  return ''
}

/** One picker row plus the late-answer capability, never a second question model. */
export interface ContinuedQuestionChoice {
  /** Sanitized one-line native question/header. */
  readonly label: string
  /** Native state, question count, queued reply and the opaque call id. */
  readonly description: string
  /** Opaque native `callId`, passed back untouched on select. */
  readonly value: string
  /** False for `open`/queued/unknown rows: the parent must not submit them here. */
  readonly answerable: boolean
  /** Native state word (unknown values verbatim). */
  readonly state: string
}

/**
 * Picker items for the pending rows, in the native ask order the view already
 * carries. `value` is the native `callId`, so a native row refresh or reorder
 * can never retarget a different call. Unanswerable rows keep their honest
 * status text and `answerable: false` instead of being silently dropped (the
 * user can still see that a call waits) or silently answerable.
 */
export function continuedQuestionChoices(rows: readonly ContinuedQuestionRow[]): ContinuedQuestionChoice[] {
  const choices: ContinuedQuestionChoice[] = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (typeof row.callId !== 'string' || row.callId === '') continue
    const reason = continuedQuestionDisabledReason(row)
    const detail = continuedQuestionDetail(row)
    choices.push({
      label: continuedQuestionLabel(row),
      description: reason === '' ? detail : `${detail} · ${reason}`,
      value: row.callId,
      answerable: reason === '',
      state: continuedQuestionStateLabel(row.state),
    })
  }
  return choices
}

/**
 * Honest one-line state for the picker body/subtitle. `undefined` (not read
 * yet) and `available: false` are different facts from "no pending question".
 */
export function continuedQuestionsNote(view: ContinuedQuestionsView | undefined): string {
  if (view === undefined) return 'Native question state has not been read in this session.'
  if (view.available !== true) return 'Native question state is unavailable; no pending question can be listed.'
  if (view.active.length === 0) return 'No question is waiting for a late answer.'
  return ''
}

