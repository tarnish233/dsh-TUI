import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { DecisionRequest } from '../src/backend/types.ts'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'

// The dialogs use the real input owner's CcEditor with the vendored Pi TUI
// source and the app-owned seam installer. There is no unpatched fallback.
const input = await loadInputModule()
const { DecisionDialog, SelectDialog, rejectedOption } = await import('../src/ui/dialogs.ts')
const { KeybindingsDialog } = await import('../src/ui/keybindings.ts')
const { editorTheme } = await import('../src/ui/theme.ts')

type CcKeymap = InstanceType<typeof input.CcKeymap>
type Decision = InstanceType<typeof DecisionDialog>

const fakeTui = (rows = 30, columns = 80) => asTui(createFakeTui(rows, columns))
const keymap = (bindings: Record<string, string | string[] | null | undefined> = {}): CcKeymap =>
  input.createCcKeymap({ bindings })
const text = (dialog: Decision, width = 70): string => stripTerminalSequences(dialog.render(width).join('\n'))

function assertWidths(dialog: Decision, widths: readonly number[] = [24, 40, 80, 120]): void {
  for (const width of widths) {
    for (const line of dialog.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`)
  }
}

const approvalRequest = (options: DecisionRequest['options']): DecisionRequest => ({
  id: 'a1',
  kind: 'approval',
  title: 'Allow tool?',
  message: 'No tool runs in this fixture.',
  options,
})

/** Native bridge shape: opaque string outcomes from the DSH approval mapping. */
const nativeApproval = (): DecisionRequest => approvalRequest([
  { label: 'Allow once', description: 'Permit exactly this action.', value: 'allowed-once' },
  { label: 'Reject', description: 'Decline the action.', value: 'rejected' },
])

/** Demo shape: opaque object values, deny is `{allow:false}` rather than 'rejected'. */
const demoApproval = (): DecisionRequest => approvalRequest([
  { label: 'Allow once', description: 'Opaque value.', value: { allow: true, scope: 'once' } },
  { label: 'Always allow (demo)', value: { allow: true, scope: 'always' } },
  { label: 'Deny', description: 'Deny without running anything.', value: { allow: false, scope: 'deny' } },
])

const twoQuestions = (): DecisionRequest => ({
  id: 'q1',
  kind: 'question',
  title: 'Demo questions',
  questions: [
    { question: 'Which colors?', header: 'Colors', multiSelect: true, options: [{ label: 'Blue' }, { label: 'Green' }] },
    { question: 'Which mode?', header: 'Mode', options: [{ label: 'Compact' }, { label: 'Expanded' }] },
  ],
})

const singleQuestions = (): DecisionRequest => ({
  id: 'q2',
  kind: 'question',
  title: 'Two single questions',
  questions: [
    { question: 'First?', header: 'One', options: [{ label: 'A' }, { label: 'B' }] },
    { question: 'Second?', header: 'Two', options: [{ label: 'C' }, { label: 'D' }] },
  ],
})

// ---------------------------------------------------------------------------
// Approval: Esc rejects with the request's own opaque value

test('Esc on an approval submits the native rejected opaque value, never a generic cancel', () => {
  for (const request of [nativeApproval(), demoApproval()]) {
    const submitted: unknown[] = []
    let cancelled = 0
    const dialog = new DecisionDialog(fakeTui(), {
      request,
      onSubmit: value => { submitted.push(value) },
      onCancel: () => { cancelled += 1 },
    })
    dialog.focused = true
    assert.match(text(dialog), /Esc to reject/, 'the hint tells the truth about Esc')
    dialog.handleInput('\x1b')
    const expected = rejectedOption(request.options ?? [])?.value
    assert.ok(expected !== undefined, 'this fixture has a rejected option')
    assert.deepEqual(submitted, [expected])
    assert.equal(cancelled, 0, 'a rejection is not a turn cancellation')
  }
  // The demo deny is the opaque object, not a synthesized string.
  assert.deepEqual(rejectedOption(demoApproval().options ?? [])?.value, { allow: false, scope: 'deny' })
  // The native bridge option is the literal native rejected outcome.
  assert.equal(rejectedOption(nativeApproval().options ?? [])?.value, 'rejected')
  assertWidths(new DecisionDialog(fakeTui(), { request: demoApproval(), onSubmit: () => {}, onCancel: () => {} }))
})

test('a request without any rejection option falls back to the parent local cancel', () => {
  let submitted = 0
  let cancelled = 0
  const dialog = new DecisionDialog(fakeTui(), {
    request: approvalRequest([{ label: 'Allow', value: 'allowed-once' }]),
    onSubmit: () => { submitted += 1 },
    onCancel: () => { cancelled += 1 },
  })
  dialog.handleInput('\x1b')
  assert.equal(submitted, 0, 'Esc must not auto-allow when no rejection option exists')
  assert.equal(cancelled, 1)
})

test('default Ctrl+C on an approval rejects with the native rejected option, never an interrupt', () => {
  // The shipped keymap has no `app.interrupt` default any more: Ctrl+C is the
  // surface-local list/dialog cancel. No backend turn cancellation is implied.
  const submitted: unknown[] = []
  let cancelled = 0
  let interrupts = 0
  const dialog = new DecisionDialog(fakeTui(), {
    request: nativeApproval(),
    onSubmit: value => { submitted.push(value) },
    onCancel: () => { cancelled += 1 },
    onInterrupt: () => { interrupts += 1 },
  })
  dialog.focused = true
  dialog.handleInput('\x03')
  assert.deepEqual(submitted, ['rejected'], 'the request\'s own rejected opaque value settles it')
  assert.equal(cancelled, 0, 'a rejection is not a turn cancellation')
  assert.equal(interrupts, 0, 'no implicit global interrupt')

  // An explicit interrupt override is the user's stated intent and still wins.
  const explicit: unknown[] = []
  let explicitInterrupts = 0
  const withOverride = new DecisionDialog(fakeTui(), {
    request: nativeApproval(),
    onSubmit: value => { explicit.push(value) },
    onCancel: () => { explicit.push('cancelled') },
    onInterrupt: () => { explicitInterrupts += 1 },
    keymap: keymap({ 'app.interrupt': 'ctrl+c' }),
  })
  withOverride.focused = true
  withOverride.handleInput('\x03')
  assert.equal(explicitInterrupts, 1)
  assert.deepEqual(explicit, [], 'a global interrupt never answers the request')
  // The request stays pending and the surface stays usable.
  withOverride.handleInput('\r')
  assert.deepEqual(explicit, ['allowed-once'])
})

test('default Ctrl+C is inert when every local cancel binding is disabled', () => {
  // No invented fallback: the root `app.clear` binding is not aliased into a
  // local dismissal, and the hidden root draft is never cleared either.
  const submitted: unknown[] = []
  let cancelled = 0
  const disabled = keymap({ 'list.cancel': null, 'dialog.cancel': null, 'app.cancel': null })
  const dialog = new DecisionDialog(fakeTui(), {
    request: nativeApproval(),
    onSubmit: value => { submitted.push(value) },
    onCancel: () => { cancelled += 1 },
    keymap: disabled,
  })
  dialog.focused = true
  dialog.handleInput('\x03')
  dialog.handleInput('\x1b')
  assert.deepEqual(submitted, [])
  assert.equal(cancelled, 0)
  // The decision still settles through its own explicit action.
  dialog.handleInput('\r')
  assert.deepEqual(submitted, ['allowed-once'])
})

test('a remapped app.interrupt is honoured and Ctrl+C then stays the local cancel', () => {
  let interrupts = 0
  let cancelled = 0
  const submitted: unknown[] = []
  const remapped = keymap({ 'app.interrupt': 'ctrl+q' })
  const dialog = new DecisionDialog(fakeTui(), {
    request: nativeApproval(),
    onSubmit: value => { submitted.push(value) },
    onCancel: () => { cancelled += 1 },
    onInterrupt: () => { interrupts += 1 },
    keymap: remapped,
  })
  dialog.handleInput('\x11') // ctrl+q = the configured interrupt
  assert.equal(interrupts, 1)
  dialog.handleInput('\x03') // ctrl+c is not app.interrupt: list.cancel rejects
  assert.deepEqual(submitted, ['rejected'])
  assert.equal(cancelled, 0)
})

test('SelectDialog dismisses locally on Ctrl+C; only an explicit interrupt override interrupts', () => {
  const events: string[] = []
  const plain = new SelectDialog(fakeTui(), {
    title: 'Pick',
    items: [{ label: 'One', value: 'one' }],
    onSelect: () => { events.push('select') },
    onCancel: () => { events.push('cancel') },
    onInterrupt: () => { events.push('interrupt') },
  })
  plain.handleInput('\x03')
  assert.deepEqual(events, ['cancel'], 'default Ctrl+C closes the chooser, it is not a turn abort')

  const explicit = new SelectDialog(fakeTui(), {
    title: 'Pick',
    items: [{ label: 'One', value: 'one' }],
    onSelect: () => { events.push('select') },
    onCancel: () => { events.push('cancel2') },
    onInterrupt: () => { events.push('interrupt') },
    keymap: keymap({ 'app.interrupt': 'ctrl+c' }),
  })
  explicit.handleInput('\x03')
  assert.deepEqual(events, ['cancel', 'interrupt'])
  explicit.handleInput('\x1b')
  assert.deepEqual(events, ['cancel', 'interrupt', 'cancel2'], 'Esc keeps closing locally afterwards')
})

// ---------------------------------------------------------------------------
// Questions: dismissal keeps the request and the draft

test('Esc on a question hides it without answering and the same instance keeps draft/checks', () => {
  const events: string[] = []
  const dialog = new DecisionDialog(fakeTui(), {
    request: twoQuestions(),
    onSubmit: () => { events.push('submit') },
    onCancel: () => { events.push('cancel') },
    onInterrupt: () => { events.push('interrupt') },
  })
  dialog.focused = true
  // The footer carries the real bindings; the narrow hint line states the
  // layered Esc meaning without inventing a key.
  assert.match(text(dialog, 120), /Tab switches questions · Space toggles · Esc cancels/)
  dialog.handleInput('1') // check Blue
  dialog.handleInput('4') // color #3 would be the custom row for 2 options? no: 2 options -> custom is 3
  dialog.handleInput('\x1b')
  assert.deepEqual(events, ['cancel'], 'question Esc is a local hide, not an answer')
  assert.equal(dialog.dismissed, true)
  assert.equal(dialog.isDisposed, false, 'hiding a question must not dispose its editors')

  // Reopening the same instance (as /questions does) preserves state.
  dialog.focused = false
  dialog.focused = true
  assert.equal(dialog.dismissed, false)
  dialog.handleInput('3') // custom row
  for (const char of 'cerulean') dialog.handleInput(char)
  dialog.handleInput('\r') // confirm custom answer, advance to question 2
  dialog.handleInput('1') // choose Compact -> review
  dialog.handleInput('\r') // submit
  assert.deepEqual(events, ['cancel', 'submit'])
  assert.match(text(dialog), /Review your answers/)
})

test('a dismissed question keeps checks and selection when reopened', () => {
  let result: unknown = 'unset'
  const dialog = new DecisionDialog(fakeTui(), {
    request: twoQuestions(),
    onSubmit: value => { result = value },
    onCancel: () => {},
  })
  dialog.focused = true
  dialog.handleInput('1') // check Blue
  dialog.handleInput('\t') // second question
  dialog.handleInput('2') // Expanded
  dialog.handleInput('\x1b') // hide on the review tab
  dialog.focused = false
  dialog.focused = true
  dialog.handleInput('\x1b[Z') // shift+tab back to question 2
  dialog.handleInput('\t') // review again
  dialog.handleInput('\r')
  assert.deepEqual(result, { answers: [['Blue'], 'Expanded'] })
})

test('Ctrl+C while typing a custom answer dismisses locally and keeps the draft', () => {
  const events: string[] = []
  const dialog = new DecisionDialog(fakeTui(), {
    request: twoQuestions(),
    onSubmit: () => { events.push('submit') },
    onCancel: () => { events.push('cancel') },
    onInterrupt: () => { events.push('interrupt') },
  })
  dialog.focused = true
  dialog.handleInput('3') // custom row of question 1
  for (const char of 'teal') dialog.handleInput(char)
  dialog.handleInput('\x03')
  assert.deepEqual(events, ['cancel'], 'the configured local cancel key dismisses, it does not abort the turn')
  assert.match(text(dialog), /teal/, 'the busy-editor draft survives the dismissal')
  assert.equal(dialog.dismissed, true)
  dialog.focused = false
  dialog.focused = true
  dialog.handleInput('\r') // confirm the preserved draft, advance
  dialog.handleInput('2') // second question: Expanded
  dialog.handleInput('\r')
  assert.deepEqual(events, ['cancel', 'submit'])

  // An explicit interrupt override is dispatched by the editor, not shadowed.
  const explicit: string[] = []
  const overridden = new DecisionDialog(fakeTui(), {
    request: twoQuestions(),
    onSubmit: () => {},
    onCancel: () => { explicit.push('cancel') },
    onInterrupt: () => { explicit.push('interrupt') },
    keymap: keymap({ 'app.interrupt': 'ctrl+c' }),
  })
  overridden.focused = true
  overridden.handleInput('3')
  for (const char of 'teal') overridden.handleInput(char)
  overridden.handleInput('\x03')
  assert.deepEqual(explicit, ['interrupt'])
  assert.match(text(overridden), /teal/, 'the draft survives the interrupt too')

  // Disabled local cancels gain no invented dismissal in the answer field.
  const inert: string[] = []
  const disabled = new DecisionDialog(fakeTui(), {
    request: twoQuestions(),
    onSubmit: () => {},
    onCancel: () => { inert.push('cancel') },
    onInterrupt: () => { inert.push('interrupt') },
    keymap: keymap({ 'list.cancel': null, 'dialog.cancel': null, 'app.cancel': null }),
  })
  disabled.focused = true
  disabled.handleInput('3')
  disabled.handleInput('x')
  disabled.handleInput('\x03')
  assert.deepEqual(inert, [], 'a disabled cancel key is inert, not aliased to app.clear')
  assert.match(text(disabled), /x/, 'the draft is untouched')
})

// ---------------------------------------------------------------------------
// R21: one custom-answer rule for single and multi select

test('a confirmed custom answer survives the editor clear when the question is revisited', () => {
  let result: unknown = 'unset'
  const request: DecisionRequest = {
    id: 'q3',
    kind: 'question',
    title: 'Revisit',
    questions: [
      { question: 'First?', header: 'One', options: [{ label: 'A' }] },
      { question: 'Second?', header: 'Two', options: [{ label: 'C' }] },
    ],
  }
  const dialog = new DecisionDialog(fakeTui(), { request, onSubmit: value => { result = value }, onCancel: () => {} })
  dialog.focused = true
  dialog.handleInput('2') // custom row (A, then custom)
  for (const char of 'my own answer') dialog.handleInput(char)
  dialog.handleInput('\r') // submit custom -> next question
  assert.match(text(dialog), /Second\?/)
  dialog.handleInput('\x1b[Z') // shift+tab back to question 1
  const revisited = text(dialog)
  assert.match(revisited, /my own answer/, 'the confirmed value is shown, not just a check mark')
  assert.match(revisited, /☒ One/, 'the question still reads as answered')
  dialog.handleInput('\t') // forward to question 2
  dialog.handleInput('1') // C -> review
  dialog.handleInput('\r')
  assert.deepEqual(result, { answers: ['my own answer', 'C'] })
})

test('multi-select keeps its confirmed custom answer after the editor clear too', () => {
  let result: unknown = 'unset'
  const request: DecisionRequest = {
    id: 'q4',
    kind: 'question',
    title: 'Multi custom',
    questions: [{
      question: 'Choose many',
      multiSelect: true,
      options: [{ label: 'Blue' }, { label: 'Green' }],
    }],
  }
  const dialog = new DecisionDialog(fakeTui(), { request, onSubmit: value => { result = value }, onCancel: () => {} })
  dialog.focused = true
  dialog.handleInput('1') // Blue
  dialog.handleInput('3') // custom row
  for (const char of 'custom words') dialog.handleInput(char)
  dialog.handleInput('\r') // confirm -> Next row
  dialog.handleInput('\x1b[Z') // shift+tab wraps to same tab? keep it in place
  const revisited = text(dialog)
  assert.match(revisited, /custom words/)
  dialog.handleInput('\t') // Submit row? Tab moves to review tab
  dialog.handleInput('\x1b[Z')
  // Walk to the review tab through the list action instead of a fixed key.
  dialog.handleInput('\t')
  dialog.handleInput('\r')
  if (result === 'unset') {
    // Single question + multiSelect keeps the review tab; submit from there.
    dialog.handleInput('\r')
  }
  assert.deepEqual(result, { answers: [['Blue', 'custom words']] })
})

test('an unconfirmed draft is handled the same way in single and multi select', () => {
  // Single-select: typed but never submitted, then Tab away and submit.
  let single: unknown = 'unset'
  const singleDialog = new DecisionDialog(fakeTui(), {
    request: singleQuestions(),
    onSubmit: value => { single = value },
    onCancel: () => {},
  })
  singleDialog.focused = true
  singleDialog.handleInput('3') // custom row of First?
  for (const char of 'draft text') singleDialog.handleInput(char)
  singleDialog.handleInput('\t') // Tab leaves the row without Enter
  singleDialog.handleInput('\t') // review
  singleDialog.handleInput('\r')
  assert.deepEqual(single, { answers: ['draft text', ''] })

  // Multi-select: the same draft rule, combined with the checked options.
  let multi: unknown = 'unset'
  const multiDialog = new DecisionDialog(fakeTui(), {
    request: { id: 'q5', kind: 'question', title: 'Multi draft', questions: [{ question: 'Pick', multiSelect: true, options: [{ label: 'Blue' }] }] },
    onSubmit: value => { multi = value },
    onCancel: () => {},
  })
  multiDialog.focused = true
  multiDialog.handleInput('1') // Blue
  multiDialog.handleInput('2') // custom row
  for (const char of 'draft text') multiDialog.handleInput(char)
  multiDialog.handleInput('\t') // Next row
  multiDialog.handleInput('\t') // review
  multiDialog.handleInput('\r')
  assert.deepEqual(multi, { answers: [['Blue', 'draft text']] })
})

test('unanswered questions stay allowed: no required-answer semantics are invented', () => {
  let result: unknown = 'unset'
  const dialog = new DecisionDialog(fakeTui(), {
    request: twoQuestions(),
    onSubmit: value => { result = value },
    onCancel: () => {},
  })
  dialog.handleInput('\t')
  dialog.handleInput('\t')
  const review = text(dialog)
  assert.match(review, /You have not answered all questions/)
  dialog.handleInput('\r')
  assert.deepEqual(result, { answers: [[], ''] })
})

test('all question lifecycle rendering stays within narrow widths', () => {
  const dialog = new DecisionDialog(fakeTui(20, 40), {
    request: {
      id: 'q6',
      kind: 'question',
      title: 'A very long title 中文标题 that wraps',
      questions: [
        { question: 'Question one with 中文 and a long path /a/very/long/path.ts?', header: 'Colors', multiSelect: true, options: [{ label: 'Blue', description: 'A long description that wraps in narrow terminals' }, { label: '绿色 🚀' }] },
        { question: 'Question two?', header: 'Mode', options: [{ label: 'Compact' }] },
      ],
    },
    onSubmit: () => {},
    onCancel: () => {},
    onInterrupt: () => {},
  })
  dialog.focused = true
  for (const width of [20, 30, 40, 60]) assertWidths(dialog, [width])
  dialog.handleInput('3')
  dialog.handleInput('x')
  for (const width of [20, 30, 40, 60]) assertWidths(dialog, [width])
})

// ---------------------------------------------------------------------------
// Disposal lifecycle (shared-keymap chord listeners)

test('DecisionDialog.dispose is idempotent and only for settled/reset/shutdown lifecycles', () => {
  const dialog = new DecisionDialog(fakeTui(), {
    request: twoQuestions(),
    onSubmit: () => {},
    onCancel: () => {},
    onInterrupt: () => {},
  })
  dialog.focused = true
  dialog.handleInput('\x1b') // hide: request stays pending, editors must stay alive
  assert.equal(dialog.isDisposed, false)
  dialog.handleInput('1') // still usable afterwards
  dialog.dispose()
  assert.equal(dialog.isDisposed, true)
  dialog.dispose() // idempotent
  assert.equal(dialog.isDisposed, true)
  // A disposed dialog ignores further input instead of answering a stale request.
  let answered = 0
  const disposed = new DecisionDialog(fakeTui(), { request: nativeApproval(), onSubmit: () => { answered += 1 }, onCancel: () => { answered += 1 } })
  disposed.dispose()
  disposed.handleInput('\r')
  assert.equal(answered, 0)
})

test('disposing an inactive dialog never cancels a chord owned by the focused editor', () => {
  const tui = fakeTui()
  const map = keymap()
  const actions: string[] = []
  const editor = new input.CcEditor(tui, editorTheme, { paddingX: 0, keymap: map, context: 'editor' })
  editor.focused = true
  editor.onAction = event => { actions.push(event.id); return true }
  editor.handleInput('\x18') // Ctrl+X chord prefix in the main prompt
  assert.equal(map.isPendingChord(), true)
  const dialog = new DecisionDialog(tui, { request: twoQuestions(), onSubmit: () => {}, onCancel: () => {}, keymap: map })
  // Inactive disposal (no focus): detach own listeners, leave the shared chord alone.
  dialog.dispose()
  assert.equal(map.isPendingChord(), true, 'the prompt keeps its pending Ctrl+X completion')
  editor.handleInput('\x05') // Ctrl+E completes the chord
  assert.deepEqual(actions, ['app.editor.external'])
  assert.equal(map.isPendingChord(), false)

  // The Settings pane follows the same ownership rule.
  const pane = new KeybindingsDialog(tui, { keymap: map, path: '/tmp/keybindings.json', onChange: async () => {}, onBack: () => {} })
  editor.handleInput('\x18')
  assert.equal(map.isPendingChord(), true)
  pane.dispose()
  assert.equal(map.isPendingChord(), true)
  editor.handleInput('\x05')
  assert.deepEqual(actions, ['app.editor.external', 'app.editor.external'])
})

test('disposing the actively focused dialog cancels its own pending chord', () => {
  const tui = fakeTui()
  const map = keymap()
  const dialog = new DecisionDialog(tui, { request: twoQuestions(), onSubmit: () => {}, onCancel: () => {}, keymap: map })
  dialog.focused = true
  dialog.handleInput('\x18') // start the shared Ctrl+X chord while focused
  assert.equal(map.isPendingChord(), true)
  dialog.dispose()
  assert.equal(map.isPendingChord(), false, 'the owning surface cancels its own half-typed chord')
})

test('KeybindingsDialog.dispose is idempotent', async () => {
  const dialog = new KeybindingsDialog(fakeTui(), {
    keymap: keymap(),
    path: '/temporary/keybindings.json',
    onChange: async () => {},
    onBack: () => {},
    onInterrupt: () => {},
  })
  dialog.focused = true
  dialog.handleInput('\r') // start editing the first binding
  assert.equal(dialog.isEditing, true)
  dialog.dispose()
  assert.equal(dialog.isDisposed, true)
  dialog.dispose()
  assert.equal(dialog.isDisposed, true)
  dialog.handleInput('\r')
  assert.equal(dialog.isEditing, true, 'a disposed pane no longer reacts to input')
})