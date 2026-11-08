import './helpers/truecolor.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'

const input = await loadInputModule()
const { KeybindingsDialog, parseShortcutText } = await import('../src/ui/keybindings.ts')
type Dialog = InstanceType<typeof KeybindingsDialog>
type Override = string[] | null | undefined
const text = (dialog: Dialog, width = 80) => stripTerminalSequences(dialog.render(width).join('\n'))

const CTRL_D = '\x04'
const CTRL_R = '\x12'
const CTRL_F = '\x06'
const ENTER = '\r'
const ESC = '\x1b'

const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

function fixture(
  rows = 0,
  bindings: Record<string, string | string[] | null> = {},
  change?: (id: string, value: Override) => Promise<void>,
) {
  const keymap = input.createCcKeymap({ bindings })
  const writes: Array<{ id: string; value: Override }> = []
  let back = 0
  const tui = createFakeTui(rows, 80)
  const dialog = new KeybindingsDialog(asTui(tui), {
    keymap,
    path: '/temporary/config/keybindings.json',
    onChange: async (id, value) => {
      if (change) await change(id, value)
      writes.push({ id, value })
      const config = keymap.getUserConfig()
      if (value === undefined) delete config[id]
      else config[id] = value
      keymap.setBindings(config)
    },
    onBack: () => { back++ },
  })
  dialog.focused = true
  return { dialog, keymap, writes, tui, get back() { return back } }
}

function replace(dialog: Dialog, value: string) {
  for (let count = 0; dialog.bindingText && count < 30; count++) dialog.handleInput('\x15')
  assert.equal(dialog.bindingText, '', 'Ctrl+U clears this editor, including line boundaries')
  dialog.handleInput('\x1b[200~' + value + '\x1b[201~')
}

async function saved(dialog: Dialog) {
  for (let turn = 0; dialog.isSaving && turn < 20; turn++) await Promise.resolve()
  assert.equal(dialog.isSaving, false)
}

const rowOf = (dialog: Dialog, needle: string, width = 80): number => {
  const index = dialog.render(width).findIndex(line => stripTerminalSequences(line).includes(needle))
  assert.ok(index >= 0, `${needle} is rendered`)
  return index
}

const columnOf = (dialog: Dialog, row: number, needle: string, width = 80): number => {
  const line = stripTerminalSequences(dialog.render(width)[row] ?? '')
  const index = line.indexOf(needle)
  assert.ok(index >= 0, `${needle} is on row ${row}`)
  return visibleWidth(line.slice(0, index))
}

function click(dialog: Dialog, row: number, col: number): void {
  const lines = dialog.render(80)
  dialog.handleMouse?.({
    type: 'click', button: 'left', x: col, y: row, screenX: col, screenY: row,
    width: 80, height: lines.length, shift: false, alt: false, ctrl: false, clickCount: 1,
  })
}

// ---------------------------------------------------------------------------

test('shortcut text reuses native key validation and preserves alternatives, punctuation and chords', () => {
  assert.deepEqual(parseShortcutText('Ctrl+P\nOption+Left\nCtrl+X Ctrl+E\nctrl+p'), ['ctrl+p', 'alt+left', 'ctrl+x ctrl+e'])
  assert.deepEqual(parseShortcutText('ctrl+,\n/\nctrl+;'), ['ctrl+,', '/', 'ctrl+;'])
  assert.equal(parseShortcutText(' \n '), null)
  assert.throws(() => parseShortcutText('ctrl+not-a-key'), /Invalid key/)
})

test('shortcut settings render grouped keys/actions, including unbound entries, without debug columns', () => {
  const f = fixture(0)
  assert.equal(f.dialog.modalSize, 'standard')
  const rendered = text(f.dialog)
  for (const group of ['Navigation', 'Editing', 'Application', 'Completion', 'Lists & dialogs', 'History search']) {
    assert.ok(rendered.includes(group), group)
  }
  assert.match(rendered, /Key\(s\).*Action/)
  assert.match(rendered, /Home \/ Ctrl\+A/)
  assert.match(rendered, /Not bound/)
  assert.match(rendered, /Todo panel \(not implemented\)/)
  assert.match(rendered, /Cycle DSH permission/)
  assert.match(rendered, /Keyboard shortcuts/)
  assert.match(rendered, /\/temporary\/config\/keybindings\.json/)
  assert.doesNotMatch(rendered, /editor\.move|cc-match|cc-app-override|reasoning effort|Toggle extended thinking/)
  // Hints come from the real registry actions.
  assert.match(rendered, /enter edit/i)
  assert.match(rendered, /ctrl\+d disable/i)
  assert.match(rendered, /ctrl\+r reset/i)
  assert.match(rendered, /ctrl\+f search/i)
  for (const width of [1, 4, 20, 40, 60, 100]) {
    for (const line of f.dialog.render(width)) assert.ok(visibleWidth(line) <= width)
  }
})

test('the search field filters by action, label, group and current binding', () => {
  const f = fixture(0)
  f.dialog.handleInput(CTRL_F)
  for (const char of 'permission') f.dialog.handleInput(char)
  assert.equal(f.dialog.query, 'permission')
  const rendered = text(f.dialog)
  assert.match(rendered, /Cycle DSH permission/)
  assert.doesNotMatch(rendered, /Start of line/)
  // Enter from the field opens the selected binding editor.
  f.dialog.handleInput(ENTER)
  assert.equal(f.dialog.isEditing, true)
  assert.equal(f.dialog.selectedActionId, 'app.mode.cycle')
  f.dialog.handleInput(ESC)
  assert.equal(f.dialog.isEditing, false)
  f.dialog.handleInput(ESC)
  assert.equal(f.back, 1, 'Esc from the search field leaves it first, then goes back')

  const binding = fixture(0)
  binding.dialog.handleInput(CTRL_F)
  for (const char of 'ctrl+alt') binding.dialog.handleInput(char)
  assert.equal(binding.dialog.query, 'ctrl+alt')
  assert.match(text(binding.dialog), /No shortcuts match/)
})

test('one inline CC editor saves multiple alternatives and a chord without closing the list', async () => {
  const f = fixture()
  f.dialog.handleInput(ENTER)
  assert.equal(f.dialog.isEditing, true)
  assert.equal(f.dialog.bindingText, 'home\nctrl+a')
  replace(f.dialog, 'ctrl+q\nctrl+x ctrl+e')
  f.dialog.handleInput('\x17') // Ctrl+W in this field, not the main prompt
  assert.equal(f.dialog.bindingText, 'ctrl+q\nctrl+x ')
  f.dialog.handleInput('\x19')
  assert.equal(f.dialog.bindingText, 'ctrl+q\nctrl+x ctrl+e')
  f.dialog.handleInput(ENTER)
  await saved(f.dialog)
  assert.deepEqual(f.writes, [{ id: 'editor.move.line-start', value: ['ctrl+q', 'ctrl+x ctrl+e'] }])
  assert.equal(f.dialog.isEditing, false)
  assert.equal(f.dialog.selectedActionId, 'editor.move.line-start')
  assert.match(text(f.dialog), /Ctrl\+Q \/ Ctrl\+X Ctrl\+E/)
  assert.match(text(f.dialog), /Saved/)
})

test('cancel does not save; printable d/r stay text while editing; recovery controls stay available', async () => {
  const f = fixture(0, { 'list.next': null, 'list.select': null, 'list.cancel': null, 'editor.submit': null, 'editor.cancel': null, 'app.cancel': null, 'dialog.cancel': null })
  f.dialog.handleInput('\x1b[B') // Fixed recovery navigation is scoped to this config pane.
  assert.equal(f.dialog.selectedActionId, 'editor.move.line-end')
  f.dialog.handleInput('\r')
  assert.equal(f.dialog.isEditing, true, 'Enter edits even if a broken list binding was disabled')
  replace(f.dialog, 'dr')
  assert.equal(f.dialog.bindingText, 'dr')
  assert.equal(f.writes.length, 0)
  f.dialog.handleInput(ESC)
  assert.equal(f.dialog.isEditing, false)
  assert.equal(f.writes.length, 0)
  f.dialog.handleInput(CTRL_D)
  await saved(f.dialog)
  assert.deepEqual(f.writes.at(-1), { id: 'editor.move.line-end', value: null })
  f.dialog.handleInput(CTRL_R)
  await saved(f.dialog)
  assert.deepEqual(f.writes.at(-1), { id: 'editor.move.line-end', value: undefined })
  assert.deepEqual(f.keymap.getBindings('editor.move.line-end'), ['end', 'ctrl+e'])
  f.dialog.handleInput(ESC)
  assert.equal(f.back, 1)
})

test('disable and reset affect just one action; configured navigation still works for other keys', async () => {
  const f = fixture(0, { 'list.next': 'alt+j', 'app.model.select': 'ctrl+q' })
  f.dialog.handleInput('\x1bj')
  assert.equal(f.dialog.selectedActionId, 'editor.move.line-end')
  f.dialog.handleInput(CTRL_D); await saved(f.dialog)
  assert.deepEqual(f.keymap.getBindings('editor.move.line-end'), [])
  assert.deepEqual(f.keymap.getBindings('app.model.select'), ['ctrl+q'])
  assert.match(text(f.dialog), /Disabled/)
  f.dialog.handleInput(CTRL_R); await saved(f.dialog)
  assert.deepEqual(f.keymap.getBindings('editor.move.line-end'), ['end', 'ctrl+e'])
  assert.deepEqual(f.keymap.getBindings('app.model.select'), ['ctrl+q'])
})

test('remapped modal actions are respected and disabled ones never advertise a fake key', async () => {
  const f = fixture(0, { 'keybindings.disable': 'alt+x', 'keybindings.reset': null, 'modal.search': null })
  const rendered = text(f.dialog)
  assert.match(rendered, /alt\+x disable/i)
  assert.doesNotMatch(rendered, /ctrl\+d disable/i)
  assert.match(rendered, /\[reset\]/, 'a disabled action keeps its clickable capability label')
  assert.match(rendered, /\[search\]/)
  // The default keys are inert after the remap/disable.
  f.dialog.handleInput(CTRL_D); await saved(f.dialog)
  assert.equal(f.writes.length, 0)
  f.dialog.handleInput(CTRL_R); await saved(f.dialog)
  assert.equal(f.writes.length, 0)
  f.dialog.handleInput(CTRL_F)
  assert.equal(f.dialog.query, '', 'disabled search action does not focus the field')
  f.dialog.handleInput('\x1bx'); await saved(f.dialog)
  assert.deepEqual(f.writes.at(-1), { id: 'editor.move.line-start', value: null })
})

test('a failed save leaves the binding text editable and does not change effective keys', async () => {
  const f = fixture(0, {}, async () => { throw new Error('Shortcut conflict: choose another key') })
  f.dialog.handleInput('\r')
  replace(f.dialog, 'ctrl+e')
  f.dialog.handleInput('\r'); await saved(f.dialog)
  assert.equal(f.dialog.isEditing, true)
  assert.equal(f.dialog.bindingText, 'ctrl+e')
  assert.deepEqual(f.keymap.getBindings('editor.move.line-start'), ['home', 'ctrl+a'])
  assert.equal(f.writes.length, 0)
  assert.match(text(f.dialog), /Shortcut conflict/)
  f.dialog.handleInput('\x03')
  assert.equal(f.dialog.isEditing, false, 'the configured cancel shortcut also cancels an edit')
})

test('global interrupt stays separate from the inline editor cancel', async () => {
  const keymap = input.createCcKeymap()
  const events: string[] = []
  const make = (onInterrupt?: () => void) => new KeybindingsDialog(asTui(createFakeTui(0, 80)), {
    keymap,
    path: '/temporary/config/keybindings.json',
    onChange: async () => {},
    onBack: () => { events.push('back') },
    ...(onInterrupt === undefined ? {} : { onInterrupt: () => { events.push('interrupt') } }),
  })

  // With the hook, the configured interrupt key is global: it does not save or
  // close the pane, and it does not silently cancel the edit either.
  const hooked = make(() => { events.push('interrupt') })
  hooked.focused = true
  hooked.handleInput('\r')
  assert.equal(hooked.isEditing, true)
  hooked.handleInput('\x03')
  assert.deepEqual(events, ['interrupt'])
  assert.equal(hooked.isEditing, true, 'global interrupt leaves the binding editor open')
  hooked.handleInput(ESC)
  assert.equal(hooked.isEditing, false)

  // Without the hook, Ctrl+C keeps this pane's recovery behaviour.
  events.length = 0
  const plain = make()
  plain.focused = true
  plain.handleInput('\r')
  assert.equal(plain.isEditing, true)
  plain.handleInput('\x03')
  assert.deepEqual(events, [])
  assert.equal(plain.isEditing, false, 'the configured cancel shortcut still cancels an edit')
  plain.handleInput('\x03')
  assert.deepEqual(events, ['back'])
})

test('fragmented paste is reported so the parent interrupt listener can defer', () => {
  const f = fixture(0)
  f.dialog.handleInput('\r')
  f.dialog.handleInput('\x1b[200~ctrl')
  assert.equal(f.dialog.isPasting, true)
  f.dialog.handleInput('\x1b[201~')
  assert.equal(f.dialog.isPasting, false)

  const search = fixture(0)
  search.dialog.handleInput(CTRL_F)
  search.dialog.handleInput('\x1b[200~permi')
  assert.equal(search.dialog.isPasting, true)
  search.dialog.handleInput('\x1b[201~')
  assert.equal(search.dialog.isPasting, false)
})

test('mouse selects a row and a second click edits it; disabled action chips stay clickable labels', async () => {
  const f = fixture(0, { 'list.next': null })
  const target = 'Browse one history entry older'
  const row = rowOf(f.dialog, target)
  const col = Math.max(1, columnOf(f.dialog, row, 'Not bound'))
  click(f.dialog, row, col)
  assert.equal(f.dialog.isEditing, false, 'the first click only selects')
  assert.equal(f.dialog.selectedActionId, 'editor.history.previous')
  click(f.dialog, rowOf(f.dialog, target), col)
  assert.equal(f.dialog.isEditing, true, 'a second click edits the selected row')
})

test('dispose is idempotent and consumes input afterwards', () => {
  const f = fixture(0)
  f.dialog.dispose()
  assert.equal(f.dialog.isDisposed, true)
  f.dialog.dispose()
  f.dialog.handleInput(ENTER)
  assert.equal(f.dialog.isEditing, false)
})