import { strict as assert } from 'node:assert'
import test from 'node:test'
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { DecisionRequest } from '../src/backend/types.ts'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'

// The dialog uses the real input owner's CcEditor with the vendored Pi TUI
// source and the app-owned seam installer. There is no unpatched fallback.
const input = await loadInputModule()
const { DecisionDialog, SelectDialog } = await import('../src/ui/dialogs.ts')

type CcKeymap = InstanceType<typeof input.CcKeymap>

function fakeTui(rows = 30, columns = 80) {
  return asTui(createFakeTui(rows, columns))
}

function keymap(bindings: Record<string, string | string[] | null | undefined> = {}): CcKeymap {
  return input.createCcKeymap({ bindings })
}

function assertWidths(lines: string[], width: number): void {
  for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`)
}

test('SelectDialog navigates with Ctrl+P/N, numbered choices and opaque values', () => {
  const tui = fakeTui()
  const allow = { allow: true, scope: 'once' }
  const deny = { allow: false }
  let selected: unknown = 'unset'
  const dialog = new SelectDialog(tui, {
    title: 'Approve demo action?',
    items: [
      { label: 'Allow once', description: 'Return the opaque object.', value: allow },
      { label: 'Deny', value: deny },
    ],
    onSelect: value => { selected = value },
    onCancel: () => { selected = 'cancelled' },
  })
  dialog.focused = true
  assert.equal(dialog.capturesViewportInput, true)
  for (const width of [24, 40, 80, 120]) assertWidths(dialog.render(width), width)
  const rendered = stripTerminalSequences(dialog.render(60).join('\n'))
  assert.match(rendered, /1\. Allow once/)
  // The footer prints the real action bindings instead of a prose hint.
  assert.match(rendered, /\[enter Select\]/)
  assert.match(rendered, /\[escape Cancel\]/)

  dialog.handleInput('\x0e') // Ctrl+N -> second (list.next default)
  dialog.handleInput('\r')
  assert.deepEqual(selected, deny)
})

test('SelectDialog wraps upward with Ctrl+P and supports digit quick-pick', () => {
  const tui = fakeTui()
  const picked: unknown[] = []
  const make = (onSelect: (value: unknown) => void): InstanceType<typeof SelectDialog> => new SelectDialog(tui, {
    title: 'Pick',
    items: [{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }],
    onSelect,
    onCancel: () => { picked.push('cancel') },
  })
  const wrap = make(value => { picked.push(value) })
  wrap.handleInput('\x10')
  wrap.handleInput('\r')
  assert.deepEqual(picked.slice(), ['two'])
  const digit = make(value => { picked.push(value) })
  digit.handleInput('1')
  assert.deepEqual(picked.slice(), ['two', 'one'])
  const cancel = make(value => { picked.push(value) })
  cancel.handleInput('\x1b')
  assert.deepEqual(picked.slice(), ['two', 'one', 'cancel'])
})

test('remapped list navigation respects the shared keymap and removes defaults', () => {
  const tui = fakeTui()
  const remapped = keymap({ 'list.previous': 'alt+k', 'list.next': 'alt+j' })
  let picked: unknown = 'unset'
  const dialog = new SelectDialog(tui, {
    title: 'Remapped',
    items: [{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }],
    onSelect: value => { picked = value },
    onCancel: () => { picked = 'cancel' },
    keymap: remapped,
  })
  assert.equal(dialog.keymap, remapped)
  // Default Ctrl+N no longer moves after remapping list.next.
  dialog.handleInput('\x0e')
  dialog.handleInput('\x1bj') // alt+j -> next
  dialog.handleInput('\r')
  assert.equal(picked, 'two')
})

test('disabled list navigation does not fall back to Pi/arrow defaults', () => {
  const tui = fakeTui()
  const disabled = keymap({ 'list.next': null })
  let picked: unknown = 'unset'
  const dialog = new SelectDialog(tui, {
    title: 'Disabled',
    items: [{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }],
    onSelect: value => { picked = value },
    onCancel: () => { picked = 'cancel' },
    keymap: disabled,
  })
  dialog.handleInput('\x0e') // ctrl+n was list.next: now consumed, no move
  dialog.handleInput('\x1b[B') // down was list.next: also disabled here (whole action)
  dialog.handleInput('\r')
  assert.equal(picked, 'one')
})

test('dialog cancel can be disabled and remapped away from Escape', () => {
  const tui = fakeTui()
  const remappedCancel = keymap({ 'list.cancel': null, 'app.cancel': null, 'dialog.cancel': 'ctrl+q' })
  let state = 'unset'
  const dialog = new SelectDialog(tui, {
    title: 'Cancel remap',
    items: [{ label: 'One', value: 'one' }],
    onSelect: () => { state = 'selected' },
    onCancel: () => { state = 'cancelled' },
    keymap: remappedCancel,
  })
  dialog.handleInput('\x1b')
  assert.equal(state, 'unset')
  dialog.handleInput('\x11') // ctrl+q via dialog.cancel
  assert.equal(state, 'cancelled')
})

test('approval DecisionDialog returns the exact opaque option value', () => {
  const tui = fakeTui()
  const allow = { kind: 'approval', allow: true, nonce: ['a', 1] }
  const deny = { kind: 'approval', allow: false }
  let result: unknown = 'unset'
  const request: DecisionRequest = {
    id: 'a1',
    kind: 'approval',
    title: 'Allow tool?',
    message: 'No tool will run in demo mode.',
    options: [
      { label: 'Allow', description: 'Opaque object value.', value: allow },
      { label: 'Deny', value: deny },
    ],
  }
  const dialog = new DecisionDialog(tui, {
    request,
    onSubmit: value => { result = value },
    onCancel: () => { result = 'cancelled' },
  })
  dialog.focused = true
  for (const width of [24, 40, 80]) assertWidths(dialog.render(width), width)
  dialog.handleInput('\x0e')
  dialog.handleInput('\r')
  assert.deepEqual(result, deny)
  const second = new DecisionDialog(tui, {
    request,
    onSubmit: value => { result = value },
    onCancel: () => { result = 'cancelled' },
  })
  second.handleInput('1')
  assert.deepEqual(result, allow)
})

test('question DecisionDialog returns ordered answers across tabs and multi-select', () => {
  const tui = fakeTui()
  let result: unknown = 'unset'
  const request: DecisionRequest = {
    id: 'q1',
    kind: 'question',
    title: 'Demo questions',
    questions: [
      {
        question: 'Which colors?',
        header: 'Colors',
        multiSelect: true,
        options: [{ label: 'Blue' }, { label: 'Green' }],
      },
      {
        question: 'Which mode?',
        header: 'Mode',
        options: [{ label: 'Compact' }, { label: 'Expanded' }],
      },
    ],
  }
  const dialog = new DecisionDialog(tui, {
    request,
    onSubmit: value => { result = value },
    onCancel: () => { result = 'cancelled' },
  })
  dialog.focused = true
  for (const width of [28, 40, 70, 110]) assertWidths(dialog.render(width), width)
  dialog.handleInput('1') // toggle Blue
  dialog.handleInput('2') // toggle Green
  dialog.handleInput('\t') // next question
  assert.match(stripTerminalSequences(dialog.render(70).join('\n')), /Which mode\?/)
  dialog.handleInput('2') // choose Expanded -> review
  assert.match(stripTerminalSequences(dialog.render(70).join('\n')), /Review your answers/)
  dialog.handleInput('\r')
  assert.deepEqual(result, { answers: [['Blue', 'Green'], 'Expanded'] })
})

test('single question auto-submits and a typed custom answer is returned', () => {
  const tui = fakeTui()
  let result: unknown = 'unset'
  const request: DecisionRequest = {
    id: 'q2',
    kind: 'question',
    title: 'Custom answer',
    questions: [{
      question: 'Pick or type.',
      options: [{ label: 'A' }, { label: 'B' }],
    }],
  }
  const dialog = new DecisionDialog(tui, {
    request,
    onSubmit: value => { result = value },
    onCancel: () => { result = 'cancelled' },
  })
  dialog.focused = true
  dialog.handleInput('3') // focus the custom row
  assert.ok(dialog.render(60).join('').includes(CURSOR_MARKER), 'focused custom row exposes the hardware cursor')
  for (const char of '自定义 ✅') dialog.handleInput(char)
  dialog.handleInput('\r')
  assert.deepEqual(result, { answers: ['自定义 ✅'] })
})

test('printable j/k edit a custom answer instead of moving the list', () => {
  const tui = fakeTui()
  let result: unknown = 'unset'
  const request: DecisionRequest = {
    id: 'q3',
    kind: 'question',
    title: 'j/k test',
    questions: [{ question: 'Type', options: [{ label: 'One' }, { label: 'Two' }] }],
  }
  const dialog = new DecisionDialog(tui, {
    request,
    onSubmit: value => { result = value },
    onCancel: () => { result = 'cancelled' },
  })
  dialog.handleInput('3')
  dialog.handleInput('j')
  dialog.handleInput('k')
  dialog.handleInput('\r')
  assert.deepEqual(result, { answers: ['jk'] })
})

test('multi-select combines checked options and a custom answer in order', () => {
  const tui = fakeTui()
  let result: unknown = 'unset'
  const request: DecisionRequest = {
    id: 'q4',
    kind: 'question',
    title: 'Multi',
    questions: [{
      question: 'Choose many',
      multiSelect: true,
      options: [{ label: 'Blue' }, { label: 'Green' }],
    }],
  }
  const dialog = new DecisionDialog(tui, {
    request,
    onSubmit: value => { result = value },
    onCancel: () => { result = 'cancelled' },
  })
  dialog.handleInput('1')
  dialog.handleInput('3') // custom row
  for (const char of 'custom') dialog.handleInput(char)
  dialog.handleInput('\r') // advance to review
  dialog.handleInput('\r') // submit
  assert.deepEqual(result, { answers: [['Blue', 'custom']] })
})

test('custom answer uses overridden editor Ctrl+W/yank bindings without double resolve', () => {
  const tui = fakeTui()
  const editorOverrides = keymap({
    'editor.kill.whitespace-backward': 'ctrl+g',
    'editor.yank': 'ctrl+t',
  })
  let result: unknown = 'unset'
  const request: DecisionRequest = {
    id: 'q-override',
    kind: 'question',
    title: 'Editor overrides',
    questions: [{
      question: 'Type a path',
      options: [{ label: 'Option' }],
    }],
  }
  const dialog = new DecisionDialog(tui, {
    request,
    onSubmit: value => { result = value },
    onCancel: () => { result = 'cancelled' },
    keymap: editorOverrides,
  })
  dialog.focused = true
  dialog.handleInput('2') // list.select-digit focuses the custom row
  dialog.render(60) // initialise the editor layout
  for (const char of 'src/utils/foo.ts') dialog.handleInput(char)
  dialog.handleInput('\x17') // ctrl+w: unbound now, must not kill
  dialog.handleInput('\x07') // ctrl+g: overridden whitespace kill
  dialog.handleInput('\x19') // ctrl+y: unbound now, must not yank
  dialog.handleInput('\x14') // ctrl+t: overridden yank
  dialog.handleInput('\r')
  assert.deepEqual(result, { answers: ['src/utils/foo.ts'] })
})

test('Esc cancels question and approval requests without submitting', () => {
  const tui = fakeTui()
  let state = 'unset'
  const question = new DecisionDialog(tui, {
    request: {
      id: 'q5',
      kind: 'question',
      title: 'Cancel me',
      questions: [{ question: 'Q', options: [{ label: 'A' }] }],
    },
    onSubmit: () => { state = 'submitted' },
    onCancel: () => { state = 'cancelled' },
  })
  question.handleInput('\x1b')
  assert.equal(state, 'cancelled')
  const approval = new DecisionDialog(tui, {
    request: {
      id: 'a5',
      kind: 'approval',
      title: 'Cancel approval',
      options: [{ label: 'Allow', value: true }],
    },
    onSubmit: () => { state = 'submitted' },
    onCancel: () => { state = 'cancelled' },
  })
  approval.handleInput('\x1b')
  assert.equal(state, 'cancelled')
})

test('long question tabs and options stay within narrow terminal widths', () => {
  const tui = fakeTui(24, 40)
  const dialog = new DecisionDialog(tui, {
    request: {
      id: 'q6',
      kind: 'question',
      title: 'A very long dialog title that has to wrap across several narrow terminal rows 中文标题',
      message: 'A long message with 中文 and emoji 🚀 that should wrap safely.',
      questions: [
        {
          question: 'A long question with a path /a/very/long/path/name.ts and 中文字符?',
          header: 'Very long header one',
          options: [{ label: 'An option with a long description', description: 'More description text that wraps' }, { label: '另一个选项 🚀' }],
        },
        { question: 'Second?', header: 'Another very long header', multiSelect: true, options: [{ label: 'X' }, { label: 'Y' }] },
      ],
    },
    onSubmit: () => {},
    onCancel: () => {},
  })
  dialog.focused = true
  for (const width of [20, 30, 40, 60]) assertWidths(dialog.render(width), width)
})

// --- native plan review -----------------------------------------------------

const PLAN_MARKDOWN = [
  '# Plan: native sessionStats in the footer',
  '',
  'The footer must read DSH statistics instead of folding its own numbers.',
  '',
  '1. Read `sessionStats` from the native projection',
  '2. Drop the local settle/TTFT fold',
  '3. Keep the editor-border live rate',
].join('\n')

test('a plan-review question presents header, question, plan body and both options', () => {
  const tui = fakeTui()
  let result: unknown = 'unset'
  const request: DecisionRequest = {
    id: 'plan-review-1',
    kind: 'question',
    title: 'Decision from DSH',
    questions: [{
      id: 'plan-review',
      intent: { kind: 'plan-review' },
      header: 'Plan review',
      question: 'Approve this plan and leave plan mode?',
      detail: PLAN_MARKDOWN,
      options: [
        { label: 'Approve', description: 'Leave plan mode and run the plan.' },
        { label: 'Keep planning', description: 'Stay in plan mode and keep refining.' },
      ],
    }],
  }
  const dialog = new DecisionDialog(tui, {
    request,
    onSubmit: value => { result = value },
    onCancel: () => { result = 'cancelled' },
  })
  dialog.focused = true
  for (const width of [24, 40, 72, 110]) assertWidths(dialog.render(width), width)

  const rendered = stripTerminalSequences(dialog.render(72).join('\n'))
  assert.match(rendered, /Plan review/, 'the native header is the dialog title')
  assert.doesNotMatch(rendered, /Decision from DSH/, 'the generic request title is replaced')
  assert.match(rendered, /Approve this plan and leave plan mode\?/, 'the question is the subtitle')
  assert.match(rendered, /Plan: native sessionStats in the footer/, 'the plan markdown is the body')
  assert.match(rendered, /Read `?sessionStats`? from the native projection/)
  assert.match(rendered, /1\. Approve/, 'both options keep their existing rows')
  assert.match(rendered, /2\. Keep planning/)
  assert.doesNotMatch(rendered, /☐ Plan review/, 'the header does not repeat as a tab chip')

  // Answer semantics are the unchanged question machinery.
  dialog.handleInput('\r')
  assert.deepEqual(result, { answers: ['Approve'] })

  let kept: unknown = 'unset'
  const keep = new DecisionDialog(tui, {
    request,
    onSubmit: value => { kept = value },
    onCancel: () => { kept = 'cancelled' },
  })
  keep.handleInput('2')
  assert.deepEqual(kept, { answers: ['Keep planning'] })

  // The custom-answer path still carries plan feedback.
  let feedback: unknown = 'unset'
  const custom = new DecisionDialog(tui, {
    request,
    onSubmit: value => { feedback = value },
    onCancel: () => { feedback = 'cancelled' },
  })
  custom.focused = true
  custom.handleInput('3') // the custom row after the two options
  custom.render(72)
  for (const char of 'add the rollback step') custom.handleInput(char)
  custom.handleInput('\r')
  assert.deepEqual(feedback, { answers: ['add the rollback step'] })

  // A multi-select detail question keeps its tabs and review step: only a
  // self-presenting single question promotes its header to the dialog title.
  const multi = new DecisionDialog(tui, {
    request: {
      id: 'plan-review-multi',
      kind: 'question',
      title: 'Pick many',
      questions: [{
        question: 'Choose the plan steps',
        header: 'Many',
        multiSelect: true,
        detail: 'Supporting text for the choices.',
        options: [{ label: 'A' }, { label: 'B' }],
      }],
    },
    onSubmit: () => {},
    onCancel: () => {},
  })
  const multiText = stripTerminalSequences(multi.render(72).join('\n'))
  assert.match(multiText, /Pick many/, 'the request title stays for a multi-select question')
  assert.match(multiText, /Supporting text for the choices/, 'the detail body still renders')
  assert.match(multiText, /☐ Many/, 'and the tab chip is kept')
})

test('a long plan is capped with an honest marker and keeps the options reachable', () => {
  const tui = fakeTui(18, 60) // rowBudget = max(4, 18 - 14) = 4
  let result: unknown = 'unset'
  const detail = ['# Plan', '', ...Array.from({ length: 40 }, (_, index) => `step ${index + 1}`)].join('\n')
  const dialog = new DecisionDialog(tui, {
    request: {
      id: 'plan-review-2',
      kind: 'question',
      title: 'Decision from DSH',
      questions: [{
        header: 'Plan review',
        question: 'Approve this plan and leave plan mode?',
        detail,
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
      }],
    },
    onSubmit: value => { result = value },
    onCancel: () => { result = 'cancelled' },
  })
  dialog.focused = true
  for (const width of [20, 40, 60]) assertWidths(dialog.render(width), width)
  const rendered = stripTerminalSequences(dialog.render(60).join('\n'))
  assert.match(rendered, /… \+\d+ lines/, 'truncation is reported, never silent')
  assert.match(rendered, /1\. Approve/, 'the answer rows survive a long plan')
  assert.match(rendered, /2\. Keep planning/)
  dialog.handleInput('\r')
  assert.deepEqual(result, { answers: ['Approve'] })
})

test('a detail-less question renders as before', () => {
  const tui = fakeTui()
  let result: unknown = 'unset'
  const request: DecisionRequest = {
    id: 'q-no-detail',
    kind: 'question',
    title: 'Pick a delivery mode',
    questions: [{
      question: 'Which mode do you want?',
      header: 'Mode',
      options: [{ label: 'Compact' }, { label: 'Expanded' }],
    }],
  }
  const dialog = new DecisionDialog(tui, {
    request,
    onSubmit: value => { result = value },
    onCancel: () => { result = 'cancelled' },
  })
  dialog.focused = true
  for (const width of [24, 40, 80]) assertWidths(dialog.render(width), width)
  const rendered = stripTerminalSequences(dialog.render(80).join('\n'))
  assert.match(rendered, /Pick a delivery mode/, 'the request title still heads the dialog')
  assert.match(rendered, /☐ Mode/, 'a single question keeps its header chip')
  assert.match(rendered, /Which mode do you want\?/)
  assert.match(rendered, /1\. Compact/)
  assert.match(rendered, /2\. Expanded/)
  assert.doesNotMatch(rendered, /… \+/)
  dialog.handleInput('2')
  assert.deepEqual(result, { answers: ['Expanded'] })
})

/** Native bridge shape: opaque string outcomes from the DSH approval mapping. */
const nativeApproval = (): DecisionRequest => ({
  id: 'a-native',
  kind: 'approval',
  title: 'Allow tool?',
  message: 'No tool runs in this fixture.',
  options: [
    { label: 'Allow once', description: 'Permit exactly this action.', value: 'allowed-once' },
    { label: 'Reject', description: 'Decline the action.', value: 'rejected' },
  ],
})

/** Demo shape: opaque object values, deny is `{allow:false}` rather than 'rejected'. */
const demoApproval = (): DecisionRequest => ({
  id: 'a-demo',
  kind: 'approval',
  title: 'Allow tool?',
  message: 'No tool runs in this fixture.',
  options: [
    { label: 'Allow once', description: 'Opaque value.', value: { allow: true, scope: 'once' } },
    { label: 'Always allow (demo)', value: { allow: true, scope: 'always' } },
    { label: 'Deny', description: 'Deny without running anything.', value: { allow: false, scope: 'deny' } },
  ],
})

const approvalRequest = (options: DecisionRequest['options']): DecisionRequest => ({
  id: 'a-frame',
  kind: 'approval',
  title: 'Allow tool?',
  message: 'No tool runs in this fixture.',
  options,
})

// ---------------------------------------------------------------------------
// Shared frame geometry: closed chrome, real footer, both renderers' widths

/** Every rendered frame is a closed box whose footer still holds an action. */
function assertClosedFrame(lines: string[], width: number): void {
  assert.ok(lines.length > 0, 'a frame is always painted')
  assertWidths(lines, width)
  const top = stripTerminalSequences(lines[0] ?? '')
  const bottom = stripTerminalSequences(lines[lines.length - 1] ?? '')
  assert.match(top, /^┌─ /, `top border missing at ${width}: ${JSON.stringify(top)}`)
  assert.match(bottom, /^└─+┘$/, `bottom border missing at ${width}: ${JSON.stringify(bottom)}`)
  const hint = stripTerminalSequences(lines.slice(-4).join('\n'))
  assert.match(hint, /\[escape Cancel\]|\[escape Reject\]/, `close affordance missing at ${width}`)
}

test('chooser and decision frames stay closed and width-safe at 40/60/80/120 columns and short heights', () => {
  const items = [
    { label: 'Allow once', description: 'Permit exactly this action.', value: 'allow' },
    { label: 'Reject', description: 'Decline the action.', value: 'rejected' },
  ]
  for (const rows of [10, 18, 24, 40]) {
    for (const width of [40, 60, 80, 120]) {
      const tui = asTui(createFakeTui(rows, width))
      const select = new SelectDialog(tui, { title: 'Choose', items, onSelect: () => {}, onCancel: () => {} })
      assertClosedFrame(select.render(width), width)
      const decision = new DecisionDialog(tui, {
        request: approvalRequest(items),
        onSubmit: () => {},
        onCancel: () => {},
      })
      assertClosedFrame(decision.render(width), width)
    }
  }
})

test('frame close routes through the same reject path as Esc and never hides a pending request', () => {
  const submitted: unknown[] = []
  let cancelled = 0
  const tui = fakeTui()
  const approval = new DecisionDialog(tui, {
    request: nativeApproval(),
    onSubmit: value => { submitted.push(value) },
    onCancel: () => { cancelled += 1 },
  })
  approval.focused = true
  const lines = approval.render(80)
  // The [×] close affordance is painted on the top border; a click on it must
  // settle exactly like Esc (native rejected value), not merely discard the UI.
  const top = stripTerminalSequences(lines[0] ?? '')
  const closeCol = top.indexOf('[×]')
  assert.ok(closeCol >= 0, 'the close affordance is painted')
  const chrome = approval.handleMouse({
    type: 'press', button: 'left', x: closeCol + 1, y: 0, screenX: closeCol + 1, screenY: 0,
    width: 80, height: lines.length, shift: false, alt: false, ctrl: false,
  })
  assert.equal(chrome?.handled, true, 'the close affordance claims the press')
  approval.handleMouse({
    type: 'click', button: 'left', x: closeCol + 1, y: 0, screenX: closeCol + 1, screenY: 0,
    width: 80, height: lines.length, shift: false, alt: false, ctrl: false, clickCount: 1,
  })
  assert.deepEqual(submitted, ['rejected'], 'closing an approval rejects it natively')
  assert.equal(cancelled, 0, 'closing is not a turn cancellation')

  const question = new DecisionDialog(tui, {
    request: {
      id: 'q-close',
      kind: 'question',
      title: 'Question',
      questions: [{ question: 'Pick one', options: [{ label: 'A' }] }],
    },
    onSubmit: () => { throw new Error('closing a question must not answer it') },
    onCancel: () => { cancelled += 1 },
  })
  question.focused = true
  const withQuestion = question.render(80)
  const questionTop = stripTerminalSequences(withQuestion[0] ?? '')
  const close = questionTop.indexOf('[×]')
  question.handleMouse({
    type: 'press', button: 'left', x: close + 1, y: 0, screenX: close + 1, screenY: 0,
    width: 80, height: withQuestion.length, shift: false, alt: false, ctrl: false,
  })
  question.handleMouse({
    type: 'click', button: 'left', x: close + 1, y: 0, screenX: close + 1, screenY: 0,
    width: 80, height: withQuestion.length, shift: false, alt: false, ctrl: false, clickCount: 1,
  })
  assert.equal(cancelled, 1, 'closing a question goes to the App-owned cancel path')
})

test('row clicks need a matching press: a stale click never answers a moved option', () => {
  const submitted: unknown[] = []
  const tui = fakeTui()
  const dialog = new DecisionDialog(tui, {
    request: demoApproval(),
    onSubmit: value => { submitted.push(value) },
    onCancel: () => { submitted.push('cancelled') },
  })
  dialog.focused = true
  const lines = dialog.render(80)
  // Locate the second option row in painted body coordinates.
  const bodyRow = lines.findIndex(line => stripTerminalSequences(line).includes('2. Always allow (demo)'))
  assert.ok(bodyRow > 0)
  const click = (y: number) => ({
    type: 'click' as const, button: 'left' as const, x: 8, y, screenX: 8, screenY: y,
    width: 80, height: lines.length, shift: false, alt: false, ctrl: false, clickCount: 1,
  })
  // A click without a press is swallowed.
  const unpaired = dialog.handleMouse(click(bodyRow))
  assert.equal(unpaired?.render, false)
  assert.deepEqual(submitted, [])
  // A press followed by a click on the same row answers it (Enter parity).
  dialog.handleMouse({
    type: 'press', button: 'left', x: 8, y: bodyRow, screenX: 8, screenY: bodyRow,
    width: 80, height: lines.length, shift: false, alt: false, ctrl: false,
  })
  dialog.handleMouse(click(bodyRow))
  assert.deepEqual(submitted, [{ allow: true, scope: 'always' }])
})

test('SelectDialog async setters never auto-select and keep loading/empty/error distinct', () => {
  const picked: unknown[] = []
  const tui = fakeTui()
  const dialog = new SelectDialog(tui, {
    title: 'Presets',
    items: [],
    loading: true,
    onSelect: value => { picked.push(value) },
    onCancel: () => { picked.push('cancelled') },
  })
  dialog.focused = true
  const loading = stripTerminalSequences(dialog.render(70).join('\n'))
  assert.match(loading, /Loading options…/)
  assert.doesNotMatch(loading, /No options are available/)

  dialog.setError('native preset catalog unavailable')
  const failed = stripTerminalSequences(dialog.render(70).join('\n'))
  assert.match(failed, /native preset catalog unavailable/)

  dialog.setError(undefined)
  dialog.setLoading(false)
  const empty = stripTerminalSequences(dialog.render(70).join('\n'))
  assert.match(empty, /No options are available\./)
  assert.doesNotMatch(empty, /Loading options/)

  // Late data must not select or submit anything, even a single candidate.
  dialog.setItems([{ label: 'Only preset', value: 'only' }])
  dialog.setItems([{ label: 'First', value: 'first' }, { label: 'Second', value: 'second' }])
  assert.deepEqual(picked, [], 'arriving data never answers for the user')
  assert.equal(dialog.selectedIndex, 0)
  dialog.handleInput('\r')
  assert.deepEqual(picked, ['first'])
})

test('unbound actions keep a clickable label without a fake key', () => {
  const remapped = keymap({ 'list.select': null, 'list.cancel': null })
  const tui = fakeTui()
  const dialog = new SelectDialog(tui, {
    title: 'No bindings',
    items: [{ label: 'One', value: 'one' }],
    onSelect: () => {},
    onCancel: () => {},
    keymap: remapped,
  })
  const rendered = stripTerminalSequences(dialog.render(80).join('\n'))
  assert.match(rendered, /\[Select\]/, 'the capability stays discoverable')
  assert.doesNotMatch(rendered, /enter Select|escape Cancel/, 'no disabled binding is advertised')
})

test('a clipped plan always announces the omission, even when the body cannot show content', () => {
  const detail = ['# Plan', '', ...Array.from({ length: 60 }, (_, index) => `plan step ${index + 1}`)].join('\n')
  for (const rows of [8, 10, 12, 18, 24]) {
    for (const width of [40, 80]) {
      let result: unknown = 'unset'
      const dialog = new DecisionDialog(asTui(createFakeTui(rows, width)), {
        request: {
          id: `plan-${rows}-${width}`,
          kind: 'question',
          title: 'Decision from DSH',
          questions: [{
            header: 'Plan review',
            question: 'Approve this plan?',
            detail,
            options: [{ label: 'Approve' }, { label: 'Keep planning' }],
          }],
        },
        onSubmit: value => { result = value },
        onCancel: () => { result = 'cancelled' },
      })
      dialog.focused = true
      const painted = stripTerminalSequences(dialog.render(width).join('\n'))
      // Whenever the native plan is clipped the marker says so; nothing is
      // dropped silently even when only one body row can afford it.
      if (!painted.includes('plan step 60')) {
        assert.match(painted, /… \+\d+ lines? hidden/, `omission marker at ${width}x${rows}`)
      }
      // The native options are still reachable and answerable.
      assert.match(painted, /1\. Approve/, `options reachable at ${width}x${rows}`)
      dialog.handleInput('\r')
      assert.deepEqual(result, { answers: ['Approve'] }, `answer at ${width}x${rows}`)
    }
  }
})
