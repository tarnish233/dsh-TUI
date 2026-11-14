// Full read-only native decision details: the exact `DecisionDetailContent`
// API, untruncated readable content, bounded scrolling, native-detail-only
// keyboard access and untouched decision state.
//
// DSH owns the decision and the native detail snapshot; this surface is display
// only (docs/COMPOSER-INTERACTION-CONTRACT.md, "Long native decision details").
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { DecisionRequest } from '../src/backend/types.ts'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'

const input = await loadInputModule()
const { DecisionDialog, decisionProposalRecord } = await import('../src/ui/dialogs.ts')
const { DecisionDetailsDialog } = await import('../src/ui/decision-details.ts')

type CcKeymap = InstanceType<typeof input.CcKeymap>
type Details = InstanceType<typeof DecisionDetailsDialog>
type Decision = InstanceType<typeof DecisionDialog>

const fakeTui = (rows = 30, columns = 80) => createFakeTui(rows, columns)
const tui = (rows = 30, columns = 80) => asTui(fakeTui(rows, columns))
const keymap = (bindings: Record<string, string | string[] | null | undefined> = {}): CcKeymap =>
  input.createCcKeymap({ bindings })
const text = (surface: { render(width: number): string[] }, width = 80): string =>
  stripTerminalSequences(surface.render(width).join('\n'))

function assertWidths(lines: string[], width: number): void {
  for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`)
}

const DOWN = '\x1b[B'
const PAGE_DOWN = '\x1b[6~'
const END = '\x1b[F'
const HOME = '\x1b[H'
const ESC = '\x1b'
const CTRL_O = '\x0f'

const PLAN = ['# Plan: native stats', '', ...Array.from({ length: 40 }, (_, index) => `- step ${index + 1}`)].join('\n')

function markdownDetails(rows = 30, columns = 80, content = PLAN): Details {
  return new DecisionDetailsDialog(tui(rows, columns), {
    content: { kind: 'markdown', title: 'Plan review', text: content },
    keymap: keymap(),
    onClose: () => {},
  })
}

const EDIT_CALL = {
  card: 'diff',
  diffs: [{
    path: 'src/greet.ts',
    oldText: 'export const greeting = "hi"\nconst keep = 1\n',
    newText: 'export const greeting = "hello"\nconst keep = 1\n',
  }],
}

function proposalDetails(rows = 30, columns = 80): Details {
  return new DecisionDetailsDialog(tui(rows, columns), {
    content: { kind: 'proposal', title: 'Proposed change', presentation: { call: EDIT_CALL } },
    keymap: keymap(),
    onClose: () => {},
  })
}

// ---------------------------------------------------------------------------
// Content: complete, never truncated, bounded by the viewport

test('native detail markdown cannot inject terminal control sequences', () => {
  const details = markdownDetails(30, 100, `# Plan\n\nSafe step\n\x1b[2J\x1b]0;owned-title\x07`)
  const raw = details.render(90).join('\n')
  assert.doesNotMatch(raw, /\x1b\[2J/)
  assert.doesNotMatch(raw, /\x1b\]0;owned-title/)
  assert.doesNotMatch(raw, /owned-title/)
})

test('native markdown detail is fully readable by scrolling, with honest metadata', () => {
  const details = markdownDetails()
  const lines = details.render(80)
  assertWidths(lines, 80)
  const painted = stripTerminalSequences(lines.join('\n'))
  assert.match(painted, /Plan review/, 'the native title heads the surface')
  assert.match(painted, /native detail · read-only/, 'the kind/metadata is stated')
  assert.match(painted, /Plan: native stats/, 'the native body starts at the top')
  assert.match(painted, /step 1\b/)
  // Every native row exists in the content model: nothing is dropped up front.
  const rows = details.contentRows(80)
  assert.ok(rows > 40, `the whole plan is present (${rows} rows)`)
  const max = details.maxScrollTop(80)
  assert.ok(max > 0, 'a long plan is scrollable')
  assert.equal(details.scrollTop, 0)

  // The position row is a real readout, not a fabricated summary.
  assert.match(painted, new RegExp(`1–\\d+/${rows}`), 'the painted window states its real position')

  // Scrolling reaches the actual last native row, in order.
  details.handleInput(END)
  assert.equal(details.scrollTop, max, 'End scrolls to the real maximum')
  const end = text(details)
  assert.match(end, /step 40/, 'the final native row is reachable')
  assert.match(end, new RegExp(`${rows}/${rows}`), 'the readout reports the end')
  details.handleInput(HOME)
  assert.equal(details.scrollTop, 0, 'Home returns to the top')
  details.handleInput(PAGE_DOWN)
  assert.ok(details.scrollTop > 0, 'PageDown scrolls a page')
  details.handleInput(DOWN)
  const stepped = details.scrollTop
  details.handleInput(DOWN)
  assert.equal(details.scrollTop, stepped + 1, 'one row per Down')
})

test('a pure native proposal is shown in full, still worded as not run', () => {
  const details = proposalDetails()
  const painted = text(details)
  assert.match(painted, /Proposal · not run yet · src\/greet\.ts · \+1 -1 lines/)
  assert.match(painted, /- export const greeting = "hi"/)
  assert.match(painted, /\+ export const greeting = "hello"/)
  assert.match(painted, /const keep = 1/)
  assert.match(painted, /proposal · not run yet/, 'the frame metadata repeats the intent')
  // No applied/executed wording and no result half anywhere.
  assert.doesNotMatch(painted, /applied/i)
  assert.doesNotMatch(painted, /executed/i)
  assert.doesNotMatch(painted, /\bresult\b/i)
  assert.doesNotMatch(painted, /… \d+ more lines/, 'the detail overlay does not truncate the change')
})

test('a large but valid proposal is fully readable, never the bounded preview', () => {
  const lines = Array.from({ length: 60 }, (_, index) => `const value${index} = ${index}`)
  const big = {
    card: 'diff',
    diffs: [{
      path: 'src/big.ts',
      oldText: lines.join('\n') + '\n',
      newText: lines.map(line => `${line} + 1`).join('\n') + '\n',
    }],
  }
  const details = new DecisionDetailsDialog(tui(30, 80), {
    content: { kind: 'proposal', title: 'Proposed change', presentation: { call: big } },
    keymap: keymap(),
    onClose: () => {},
  })
  const rows = details.contentRows(80)
  assert.ok(rows > 12 + 60, `the whole change is present (${rows} rows), not a 12-row preview`)
  const painted = text(details)
  assert.doesNotMatch(painted, /… \d+ more lines/, 'the detail overlay never folds the change')
  assert.match(painted, /Proposal · not run yet · src\/big\.ts · \+60 -60 lines/)
  details.handleInput(END)
  const end = text(details)
  assert.match(end, /\+ const value59 = 59 \+ 1/, 'the final changed row is reachable')
  assert.equal(details.scrollTop, details.maxScrollTop(80))
})

test('an oversized native hunk is reported honestly instead of invented', () => {
  const huge = {
    card: 'diff',
    diffs: [{
      path: 'src/huge.ts',
      // Over the shared DIFF_LCS_CHAR_LIMIT (150k chars per side): the renderer
      // refuses an LCS diff instead of inventing rows.
      oldText: Array.from({ length: 8000 }, (_, index) => `old line ${index} ${'x'.repeat(24)}`).join('\n'),
      newText: Array.from({ length: 8000 }, (_, index) => `new line ${index} ${'y'.repeat(24)}`).join('\n'),
    }],
  }
  const details = new DecisionDetailsDialog(tui(30, 80), {
    content: { kind: 'proposal', title: 'Proposed change', presentation: { call: huge } },
    keymap: keymap(),
    onClose: () => {},
  })
  const painted = text(details)
  assert.match(painted, /Proposal · not run yet/)
  assert.match(painted, /\(diff too large to display\)/, 'the shared diff budget refuses honestly')
  assert.match(painted, /hunk too large to count precisely/)
  assert.doesNotMatch(painted, /applied|executed/i)
})

test('details stay width-safe and readable at every small and wide size', () => {
  for (const rows of [8, 10, 18, 24, 40]) {
    for (const width of [40, 60, 80, 120]) {
      for (const details of [markdownDetails(rows, width), proposalDetails(rows, width)]) {
        const lines = details.render(width)
        assertWidths(lines, width)
        assert.ok(lines.length <= rows, `details fit ${width}x${rows}`)
        assert.ok(lines.length >= 3, `details always paint readable chrome at ${width}x${rows}`)
      }
    }
  }
})

// ---------------------------------------------------------------------------
// Read-only input contract

test('details are read-only: navigation scrolls, selection keys answer nothing', () => {
  const events: string[] = []
  const details = new DecisionDetailsDialog(tui(18, 80), {
    content: { kind: 'markdown', title: 'Plan', text: PLAN },
    keymap: keymap(),
    onClose: () => { events.push('close') },
    onInterrupt: () => { events.push('interrupt') },
  })
  details.render(80)
  details.handleInput('\r') // list.select: no row to activate
  details.handleInput('1') // list.select-digit: no row to activate
  details.handleInput('x') // printable text is not an answer
  details.handleInput(' ') // space toggles nothing here
  assert.deepEqual(events, [], 'no answer, no close, no interrupt')
  assert.equal(details.isDone, false)
})

test('Esc closes locally and a later key never re-closes the surface', () => {
  const events: string[] = []
  const details = new DecisionDetailsDialog(tui(), {
    content: { kind: 'markdown', title: 'Plan', text: PLAN },
    keymap: keymap(),
    onClose: () => { events.push('close') },
    onInterrupt: () => { events.push('interrupt') },
  })
  details.focused = true
  details.handleInput(ESC)
  assert.deepEqual(events, ['close'])
  details.handleInput(ESC)
  details.handleInput(CTRL_O)
  assert.deepEqual(events, ['close'], 'a closed surface is inert')
  details.dispose()
  details.dispose()
  assert.equal(details.isDisposed, true, 'dispose is idempotent')
})

test('default Ctrl+C closes the read-only detail; an explicit interrupt stays global', () => {
  const events: string[] = []
  const plain = new DecisionDetailsDialog(tui(), {
    content: { kind: 'markdown', title: 'Plan', text: PLAN },
    keymap: keymap(),
    onClose: () => { events.push('close') },
    onInterrupt: () => { events.push('interrupt') },
  })
  plain.handleInput('\x03')
  assert.deepEqual(events, ['close'], 'Ctrl+C is the local cancel of the focused surface')
  assert.equal(plain.isDone, true)

  const explicit = new DecisionDetailsDialog(tui(), {
    content: { kind: 'markdown', title: 'Plan', text: PLAN },
    keymap: keymap({ 'app.interrupt': 'ctrl+c' }),
    onClose: () => { events.push('close2') },
    onInterrupt: () => { events.push('interrupt2') },
  })
  explicit.handleInput('\x03')
  assert.deepEqual(events, ['close', 'interrupt2'], 'an explicit override is the user intent')
  assert.equal(explicit.isDone, false, 'a global interrupt does not settle the view')
})

test('disabled or remapped cancel keys gain no invented close fallback', () => {
  const events: string[] = []
  const disabled = new DecisionDetailsDialog(tui(), {
    content: { kind: 'markdown', title: 'Plan', text: PLAN },
    keymap: keymap({ 'list.cancel': null, 'dialog.cancel': null, 'app.cancel': null }),
    onClose: () => { events.push('close') },
    onInterrupt: () => { events.push('interrupt') },
  })
  disabled.handleInput(ESC)
  disabled.handleInput('\x03')
  assert.equal(events.length, 0, 'no configured cancel key, no close')
  assert.equal(disabled.isDone, false)

  const remapped = new DecisionDetailsDialog(tui(), {
    content: { kind: 'markdown', title: 'Plan', text: PLAN },
    keymap: keymap({ 'list.cancel': 'ctrl+g', 'dialog.cancel': 'ctrl+g', 'app.cancel': null }),
    onClose: () => { events.push('close2') },
  })
  remapped.handleInput(ESC)
  remapped.handleInput('\x03')
  assert.equal(events.length, 0, 'the old keys are genuinely gone')
  remapped.handleInput('\x07') // the configured cancel key
  assert.deepEqual(events, ['close2'])
})

test('mouse wheel scrolls the bounded viewport and never answers a row', () => {
  const details = markdownDetails()
  const lines = details.render(80)
  const bodyRow = lines.findIndex(line => stripTerminalSequences(line).includes('step 1'))
  assert.ok(bodyRow > 0)
  const wheel = (delta: number) => ({
    type: 'wheel' as const, button: 'left' as const, x: 8, y: bodyRow, screenX: 8, screenY: bodyRow,
    width: 80, height: lines.length, shift: false, alt: false, ctrl: false, wheelDelta: delta,
  })
  assert.equal(details.handleMouse(wheel(1))?.render, true)
  assert.ok(details.scrollTop > 0)
  const after = details.scrollTop
  details.handleMouse(wheel(-1))
  assert.ok(details.scrollTop < after)
  // A press/click is not a decision answer and is not claimed.
  const press = {
    type: 'press' as const, button: 'left' as const, x: 8, y: bodyRow, screenX: 8, screenY: bodyRow,
    width: 80, height: lines.length, shift: false, alt: false, ctrl: false,
  }
  assert.equal(details.handleMouse(press), undefined)
})

// ---------------------------------------------------------------------------
// DecisionDialog wiring: native-only keyboard access, state preserved

function questionRequest(detail?: string, multiSelect = false): DecisionRequest {
  return {
    id: 'q-detail',
    kind: 'question',
    title: 'Decision from DSH',
    questions: [{
      id: 'plan-review',
      intent: { kind: 'plan-review' },
      header: 'Plan review',
      question: 'Approve this plan?',
      ...(detail === undefined ? {} : { detail }),
      ...(multiSelect ? { multiSelect: true } : {}),
      options: [{ label: 'Approve' }, { label: 'Keep planning' }],
    }],
  }
}

function decision(
  request: DecisionRequest,
  extra: Record<string, unknown> = {},
): { dialog: Decision; opened: unknown[]; submitted: unknown[]; cancelled: string[] } {
  const opened: unknown[] = []
  const submitted: unknown[] = []
  const cancelled: string[] = []
  const dialog = new DecisionDialog(tui(), {
    request,
    onSubmit: value => { submitted.push(value) },
    onCancel: () => { cancelled.push('cancelled') },
    onDetails: content => { opened.push(content) },
    keymap: keymap(),
    ...extra,
  })
  dialog.focused = true
  return { dialog, opened, submitted, cancelled }
}

test('Ctrl+O opens the exact native question detail and keeps the decision open', () => {
  const { dialog, opened, submitted, cancelled } = decision(questionRequest(PLAN))
  const painted = text(dialog, 100)
  assert.match(painted, /\[ctrl\+o Details\]/, 'the native-detail action advertises its real key')
  dialog.handleInput(CTRL_O)
  assert.deepEqual(opened, [{ kind: 'markdown', title: 'Plan review', text: PLAN }], 'the native text is passed through verbatim')
  assert.deepEqual(submitted, [], 'opening details never answers the request')
  assert.deepEqual(cancelled, [])
  assert.equal(dialog.dismissed, false)
  assert.equal(dialog.isDisposed, false)
  // The request is still the one in front: it can be answered afterwards.
  dialog.handleInput('\r')
  assert.deepEqual(submitted, [{ answers: ['Approve'] }])
})

test('no native detail means no detail action at all', () => {
  const { dialog, opened } = decision(questionRequest())
  const painted = text(dialog, 100)
  assert.doesNotMatch(painted, /\[.*Details\]/, 'no ghost action without native content')
  dialog.handleInput(CTRL_O)
  assert.deepEqual(opened, [], 'the key is inert without native content')

  // A dialog without the parent hook offers nothing either.
  const withoutHook = new DecisionDialog(tui(), {
    request: questionRequest(PLAN),
    onSubmit: () => {},
    onCancel: () => {},
    keymap: keymap(),
  })
  withoutHook.focused = true
  assert.doesNotMatch(text(withoutHook, 100), /\[.*Details\]/)
  withoutHook.handleInput(CTRL_O) // inert, never a local answer
  assert.equal(withoutHook.isDisposed, false)
})

test('an approval exposes details only for a validated pure proposal record', () => {
  const options = [{ label: 'Allow', value: 'allow' }, { label: 'Reject', value: 'rejected' }]
  const pure: DecisionRequest = { id: 'a1', kind: 'approval', title: 'Allow?', message: 'm', options, toolPresentation: { call: EDIT_CALL } }
  const { dialog, opened, submitted } = decision(pure)
  assert.match(text(dialog, 100), /\[ctrl\+o Details\]/)
  dialog.handleInput(CTRL_O)
  assert.equal(opened.length, 1)
  const content = opened[0] as { kind: string; title: string; presentation: unknown }
  assert.equal(content.kind, 'proposal')
  assert.deepEqual(content.presentation, { call: EDIT_CALL }, 'the same validated record is passed, not a projection')
  assert.equal(decisionProposalRecord(content.presentation) !== undefined, true)
  assert.deepEqual(submitted, [], 'details never answers')
  dialog.handleInput('\r')
  assert.deepEqual(submitted, ['allow'], 'the approval still answers with the opaque value')

  // A decided record (a result half) or a non-diff card is not a proposal.
  for (const toolPresentation of [
    { call: EDIT_CALL, result: { card: 'diff', diffs: [] } },
    { call: { card: 'generic', output: 'x' } },
    { call: { card: 'diff', diffs: 'nope' } },
    { callId: 'call-1' },
  ]) {
    const request: DecisionRequest = { id: 'a2', kind: 'approval', title: 'Allow?', options, toolPresentation }
    const fixture = decision(request)
    assert.doesNotMatch(text(fixture.dialog, 100), /\[.*Details\]/, `no details for ${JSON.stringify(toolPresentation)}`)
    fixture.dialog.handleInput(CTRL_O)
    assert.deepEqual(fixture.opened, [], 'no detail content is fabricated')
  }
})

test('opening details preserves multi-select checks and the custom draft', () => {
  const { dialog, opened, submitted } = decision(questionRequest(PLAN, true))
  dialog.handleInput('1') // check Approve
  dialog.handleInput('3') // custom row
  for (const char of 'also roll back') dialog.handleInput(char)
  dialog.render(100)
  dialog.handleInput(CTRL_O) // details while the answer field owns input
  assert.equal(opened.length, 1, 'Ctrl+O works from the custom-answer field')
  assert.match(text(dialog, 100), /also roll back/, 'the draft survives the detail request')
  dialog.handleInput('\r') // confirm the draft -> review
  dialog.handleInput('\r') // submit
  assert.deepEqual(submitted, [{ answers: [['Approve', 'also roll back']] }], 'checks, order and draft are intact')
})

test('a remapped or disabled dialog.details changes nothing else', () => {
  const disabled = decision(questionRequest(PLAN), { keymap: keymap({ 'dialog.details': null }) })
  assert.doesNotMatch(text(disabled.dialog, 100), /\[ctrl\+o Details\]/, 'no binding is advertised')
  disabled.dialog.handleInput(CTRL_O)
  assert.deepEqual(disabled.opened, [], 'the old key is genuinely gone')
  disabled.dialog.handleInput('\r')
  assert.deepEqual(disabled.submitted, [{ answers: ['Approve'] }], 'the decision is still usable')

  const remapped = decision(questionRequest(PLAN), { keymap: keymap({ 'dialog.details': 'ctrl+g' }) })
  assert.match(text(remapped.dialog, 100), /\[ctrl\+g Details\]/, 'the configured key is advertised')
  remapped.dialog.handleInput(CTRL_O)
  assert.deepEqual(remapped.opened, [], 'the old key is inert')
  remapped.dialog.handleInput('\x07')
  assert.equal(remapped.opened.length, 1, 'the configured key opens the native detail')
})