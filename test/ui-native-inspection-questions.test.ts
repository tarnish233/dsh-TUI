// Must stay the FIRST import: forces truecolor before any src module.
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { ContinuedQuestionRow, ContinuedQuestionsView } from '../src/backend/native-questions.ts'
import * as helpers from '../src/ui/continued-questions-dialog.ts'
import {
  continuedQuestionAnswerable,
  continuedQuestionChoices,
  continuedQuestionDetail,
  continuedQuestionDisabledReason,
  continuedQuestionLabel,
  continuedQuestionStateLabel,
  continuedQuestionsNote,
} from '../src/ui/continued-questions-dialog.ts'

/**
 * Continued-question display helpers for the parent's existing question
 * pickers. Pure presentation: native rows only, no timer, no scheduler, no
 * local pending map, no answer write.
 */

function row(over: Partial<ContinuedQuestionRow> = {}): ContinuedQuestionRow {
  return {
    callId: 'call-1',
    state: 'continued',
    questions: [{ id: 'q1', question: 'Which workspace should I use?', header: 'Workspace' }],
    ...over,
  }
}

function view(over: Partial<ContinuedQuestionsView> = {}): ContinuedQuestionsView {
  return {
    sessionId: 'session-1',
    available: true,
    active: [row()],
    settled: [],
    ...over,
  }
}

test('native state words are painted verbatim, unknown values are never "open"', () => {
  assert.equal(continuedQuestionStateLabel('open'), 'open')
  assert.equal(continuedQuestionStateLabel('continued'), 'continued')
  assert.equal(continuedQuestionStateLabel('plugin-state'), 'plugin-state')
  assert.equal(continuedQuestionStateLabel(''), 'state unknown')
  assert.equal(continuedQuestionStateLabel(undefined), 'state unknown')
  assert.equal(continuedQuestionStateLabel(7), 'state unknown')
})

test('the label is a sanitized one-line native header + question', () => {
  assert.equal(continuedQuestionLabel(row()), 'Workspace · Which workspace should I use?')
  assert.equal(
    continuedQuestionLabel(row({ questions: [{ id: 'q', question: 'No header here' }] })),
    'No header here',
  )
  // A row without question text is identified by its native call id, never by
  // an invented question.
  assert.equal(continuedQuestionLabel(row({ callId: 'call-x', questions: [] })), 'Native question call-x')
  assert.equal(continuedQuestionLabel(undefined), 'Native question')
  const hostile = continuedQuestionLabel(row({
    questions: [{ id: 'q', question: '\x1b[31m目标 🚀\x1b[0m\nsecond\x07line' }],
  }))
  assert.equal(stripTerminalSequences(hostile).includes('\x1b'), false)
  assert.equal(hostile.includes('\n'), false, 'native control/newlines are flattened to one line')
  assert.ok(hostile.includes('目标 🚀'))
  const clipped = continuedQuestionLabel(row(), 24)
  assert.ok(visibleWidth(clipped) <= 24)
  // Pi's width truncation marks the clip; only the visible text is asserted.
  assert.match(stripTerminalSequences(clipped), /(?:…|\.\.\.)$/)
})

test('the detail line keeps state, question count, queued reply and the opaque call id', () => {
  assert.equal(continuedQuestionDetail(row()), 'continued · 1 question · call-1')
  assert.equal(
    continuedQuestionDetail(row({
      state: 'open',
      replyQueued: true,
      questions: [{ id: 'a', question: 'a' }, { id: 'b', question: 'b' }],
    })),
    'open · 2 questions · reply queued · call-1',
  )
  // Absent native facts are omitted, never described as "no reply".
  const unknownInbox = continuedQuestionDetail(row({ replyQueued: undefined }))
  assert.doesNotMatch(unknownInbox, /reply/)
  assert.doesNotMatch(continuedQuestionDetail(row({ questions: [] })), /question/)
  assert.equal(continuedQuestionDetail(undefined), 'state unknown')
})

test('only native continued rows are answerable by the late path', () => {
  assert.equal(continuedQuestionAnswerable(row()), true)
  assert.equal(continuedQuestionAnswerable(row({ state: 'open' })), false,
    'an open row is owned by the live blocking question dialog')
  assert.equal(continuedQuestionAnswerable(row({ replyQueued: true })), false,
    'a queued reply would be refused natively as REPLY_QUEUED')
  assert.equal(continuedQuestionAnswerable(row({ state: 'settled' as ContinuedQuestionRow['state'] })), false)
  assert.equal(continuedQuestionAnswerable(undefined), false)

  assert.equal(continuedQuestionDisabledReason(row()), '')
  assert.match(continuedQuestionDisabledReason(row({ state: 'open' })), /live question dialog/)
  assert.match(continuedQuestionDisabledReason(row({ replyQueued: true })), /reply already queued/)
  assert.match(continuedQuestionDisabledReason(row({ state: 'plugin-state' as ContinuedQuestionRow['state'] })), /not a late-answer/)
  assert.equal(continuedQuestionDisabledReason(undefined), 'no native call')
})

test('choices keep native ask order, the opaque call id and the answer capability', () => {
  const rows = [
    row({ callId: 'call-a' }),
    row({ callId: 'call-b', state: 'open' }),
    row({ callId: 'call-c', replyQueued: true, questions: [{ id: 'q', question: 'Queued one' }] }),
  ]
  const choices = continuedQuestionChoices(rows)
  assert.deepEqual(choices.map(choice => choice.value), ['call-a', 'call-b', 'call-c'],
    'native order and identity are preserved; unanswerable rows are not dropped')
  assert.deepEqual(choices.map(choice => choice.answerable), [true, false, false])
  assert.match(choices[1]!.description, /live question dialog/)
  assert.match(choices[2]!.description, /reply already queued/)
  assert.equal(choices[0]!.state, 'continued')
  assert.equal(choices[1]!.state, 'open')

  // Invalid rows are skipped instead of inventing a call identity.
  const invalid = continuedQuestionChoices([
    null as unknown as ContinuedQuestionRow,
    { callId: '', state: 'continued', questions: [] },
    7 as unknown as ContinuedQuestionRow,
    row({ callId: 'call-valid' }),
  ])
  assert.deepEqual(invalid.map(choice => choice.value), ['call-valid'])
  // Duplicate call ids stay distinct rows in native order (native owns identity).
  assert.deepEqual(
    continuedQuestionChoices([row({ callId: 'same' }), row({ callId: 'same' })]).map(choice => choice.value),
    ['same', 'same'],
  )
})

test('the honest note distinguishes unread, unavailable and no-pending-question', () => {
  assert.match(continuedQuestionsNote(undefined), /has not been read/)
  assert.match(continuedQuestionsNote(view({ available: false })), /unavailable/)
  assert.match(continuedQuestionsNote(view({ active: [] })), /No question is waiting for a late answer/)
  assert.equal(continuedQuestionsNote(view()), '')
})

test('helpers are pure presentation: no class, timer or scheduler export', () => {
  const exported = Object.keys(helpers).sort()
  assert.deepEqual(exported, [
    'continuedQuestionAnswerable',
    'continuedQuestionChoices',
    'continuedQuestionDetail',
    'continuedQuestionDisabledReason',
    'continuedQuestionLabel',
    'continuedQuestionStateLabel',
    'continuedQuestionsNote',
  ])
  // Deterministic, allocation-only projection: the same native row yields the
  // same text on every call (no clock, no countdown, no state machine).
  const source = row({ questions: [{ id: 'q', question: 'Stable?' }] })
  const first = continuedQuestionLabel(source)
  const second = continuedQuestionLabel(source)
  assert.equal(first, second)
  assert.deepEqual(continuedQuestionChoices([source]), continuedQuestionChoices([source]))
})