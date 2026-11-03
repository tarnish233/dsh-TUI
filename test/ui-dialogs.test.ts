import { strict as assert } from 'node:assert'
import test from 'node:test'
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
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
  assert.match(rendered, /Enter to select/)

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
