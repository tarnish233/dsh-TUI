// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import { defaults, type Settings } from '../src/config.ts'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'

const input = await loadInputModule()
const { SettingsDialog } = await import('../src/ui/settings.ts')

type Dialog = InstanceType<typeof SettingsDialog>

const ESC = '\x1b'
const ENTER = '\r'
const DOWN = '\x0e'
const CTRL_F = '\x06'
const CTRL_R = '\x12'
const CTRL_C = '\x03'

const lines = (dialog: Dialog, width: number): string[] => dialog.render(width)
const text = (dialog: Dialog, width = 80): string => stripTerminalSequences(lines(dialog, width).join('\n'))

function rowOf(dialog: Dialog, needle: string, width = 80): number {
  const index = lines(dialog, width).findIndex(line => stripTerminalSequences(line).includes(needle))
  assert.ok(index >= 0, `${needle} is rendered`)
  return index
}

function columnOf(dialog: Dialog, row: number, needle: string, width = 80): number {
  const line = stripTerminalSequences(lines(dialog, width)[row] ?? '')
  const index = line.indexOf(needle)
  assert.ok(index >= 0, `${needle} is on row ${row}`)
  return visibleWidth(line.slice(0, index))
}

function mouse(dialog: Dialog, type: 'press' | 'click' | 'wheel', row: number, col: number, width = 80, wheelDelta?: number): void {
  const rendered = lines(dialog, width)
  dialog.handleMouse?.({
    type, button: 'left', x: col, y: row, screenX: col, screenY: row,
    width, height: rendered.length, shift: false, alt: false, ctrl: false,
    ...(type === 'click' ? { clickCount: 1 } : {}),
    ...(wheelDelta === undefined ? {} : { wheelDelta }),
  })
}

interface Harness {
  dialog: Dialog
  patches: Array<Partial<Settings>>
  resets: Array<keyof Settings>
  events: string[]
  tui: ReturnType<typeof createFakeTui>
}

function harness(options: {
  settings?: Partial<Settings>
  rows?: number
  maxHeight?: number
  onChange?: (patch: Partial<Settings>) => void | Promise<void | Settings>
  onReset?: (key: keyof Settings) => void | Promise<void | Settings>
  nativeEntries?: () => readonly { id: string; label: string; value: string; description?: string; available?: boolean; onActivate?: () => void }[]
  keymap?: ReturnType<typeof input.createCcKeymap>
  withInterrupt?: boolean
} = {}): Harness {
  const tui = createFakeTui(options.rows ?? 30, 100)
  const patches: Array<Partial<Settings>> = []
  const resets: Array<keyof Settings> = []
  const events: string[] = []
  const dialog = new SettingsDialog(asTui(tui), {
    settings: { ...defaults, ...options.settings },
    keymap: options.keymap ?? input.createCcKeymap(),
    onChange: patch => { patches.push(patch); return options.onChange?.(patch) },
    ...(options.onReset === undefined ? {} : { onReset: key => { resets.push(key); return options.onReset?.(key) } }),
    onKeybindings: () => { events.push('keybindings') },
    ...(options.nativeEntries === undefined ? {} : { getNativeEntries: options.nativeEntries }),
    ...(options.maxHeight === undefined ? {} : { maxHeight: options.maxHeight }),
    path: '/tmp/temporary/settings.json',
    onCancel: () => { events.push('cancel') },
    ...(options.withInterrupt === true ? { onInterrupt: () => { events.push('interrupt') } } : {}),
  })
  dialog.focused = true
  return { dialog, patches, resets, events, tui }
}

const goTo = (dialog: Dialog, category: 'general' | 'thinking' | 'tools' | 'agents' | 'images' | 'dsh' | 'keyboard'): void => {
  for (let index = 0; dialog.activeCategory !== category && index < 14; index += 1) dialog.handleInput('\x1b[C')
  assert.equal(dialog.activeCategory, category)
}

test('every line stays width-safe across narrow, short and CJK/emoji content', () => {
  const long = '非常长的会话标题'.repeat(8)
  const { dialog } = harness({
    rows: 24,
    nativeEntries: () => [{
      id: 'model', label: '当前模型 · ' + long, value: 'deepseek-chat · 🚀 ' + long,
      description: '这是原生状态说明，包含 emoji 🚀 与很长的路径 /Users/someone/workspace/a/very/long/path/that/does/not/fit',
    }],
  })
  for (const width of [1, 4, 8, 16, 20, 24, 32, 40, 46, 60, 80, 120]) {
    for (const line of lines(dialog, width)) {
      assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`)
    }
  }
  goTo(dialog, 'dsh')
  for (const width of [8, 20, 32, 60, 80, 120]) {
    for (const line of lines(dialog, width)) assert.ok(visibleWidth(line) <= width)
  }
  assert.match(text(dialog, 120), /当前模型/)
})

test('short terminals keep a bounded body, a usable close and no empty box', () => {
  for (const height of [4, 6, 8, 10, 12]) {
    const short = harness({ rows: 8, maxHeight: height })
    const rendered = lines(short.dialog, 40)
    assert.ok(rendered.length <= height, `render respects maxHeight ${height}`)
    for (const line of rendered) assert.ok(visibleWidth(line) <= 40)
  }
  const tiny = harness({ rows: 8, maxHeight: 7 })
  const rendered = lines(tiny.dialog, 40)
  assert.ok(rendered.length <= 7)
  const joined = text(tiny.dialog, 40)
  assert.match(joined, /Settings/)
  // Close capability survives: the frame close button or the footer close label.
  assert.ok(joined.includes('[×]') || joined.includes('close'))
  tiny.dialog.handleInput(ESC)
  assert.deepEqual(tiny.events, ['cancel'])
})

test('mouse: close leaves a nested picker first and closes Settings on the next activation', () => {
  const { dialog, events } = harness()
  dialog.handleInput('\r') // Default screen picker
  assert.match(text(dialog), /Settings › Default screen/)
  mouse(dialog, 'click', 0, columnOf(dialog, 0, '[×]'))
  assert.deepEqual(events, [], 'the nested close does not dismiss Settings')
  assert.doesNotMatch(text(dialog), /Settings › Default screen/)
  assert.equal(dialog.activeRowId, 'screen')
  mouse(dialog, 'click', 0, columnOf(dialog, 0, '[×]'))
  assert.deepEqual(events, ['cancel'])
})

test('mouse: search focus, inert group headers, row selection/activation and wheel', () => {
  const { dialog, patches } = harness({ maxHeight: 24 })
  const searchRow = rowOf(dialog, 'Search settings')
  mouse(dialog, 'click', searchRow, 2)
  assert.equal(dialog.searchFocusedState, true)
  dialog.handleInput(ESC)

  // Group headings separate one continuous list; they are not page-switching tabs.
  const groupRow = rowOf(dialog, 'General ─')
  const generalColumn = columnOf(dialog, groupRow, 'General')
  mouse(dialog, 'click', groupRow, generalColumn)
  assert.equal(dialog.activeCategory, 'general')
  assert.equal(dialog.activeRowId, 'screen')
  assert.deepEqual(patches, [])

  // A row click selects; a second click toggles the boolean.
  goTo(dialog, 'tools')
  dialog.handleInput(DOWN)
  const toolRow = rowOf(dialog, 'Group tool calls')
  const groupColumn = columnOf(dialog, toolRow, 'Group tool calls')
  mouse(dialog, 'click', toolRow, groupColumn)
  assert.equal(dialog.activeRowId, 'groupTools')
  assert.equal(patches.length, 0)
  mouse(dialog, 'click', rowOf(dialog, 'Group tool calls'), groupColumn)
  assert.deepEqual(patches.at(-1), { groupTools: false })

  // Wheel moves the selection in the bounded body.
  const before = dialog.activeRowId
  mouse(dialog, 'wheel', rowOf(dialog, 'Group tool calls'), 4, 80, -1)
  assert.notEqual(dialog.activeRowId, before)
})

test('mouse: a press on a mutating footer action cannot act on a different row after the target changes', () => {
  const { dialog, resets } = harness({ maxHeight: 16, onReset: () => Promise.resolve() })
  goTo(dialog, 'tools')
  const resetRow = rowOf(dialog, 'ctrl+r reset')
  const resetColumn = columnOf(dialog, resetRow, 'reset')
  // Press on the reset action for `groupTools`…
  mouse(dialog, 'press', resetRow, resetColumn)
  // …then the selected row changes before the click arrives.
  dialog.handleInput(DOWN)
  mouse(dialog, 'click', resetRow, resetColumn)
  assert.deepEqual(resets, [], 'a pressed action with a changed owner is invalidated')
})

test('mouse: activateHit rejects a pinned row id that disappeared', () => {
  const activated: string[] = []
  let includeGamma = true
  const native = (id: string, label: string, value: string) => ({
    id, label, value, onActivate: () => { activated.push(id) },
  })
  const { dialog } = harness({
    rows: 40,
    maxHeight: 26,
    nativeEntries: () => [
      native('alpha', 'Native Alpha', 'a'),
      ...(includeGamma ? [native('gamma', 'Native Gamma', 'g')] : []),
      native('beta', 'Native Beta', 'b'),
    ],
  })
  goTo(dialog, 'dsh')
  // Select beta first so an erroneous index fallback would activate it.
  const betaRow = rowOf(dialog, 'Native Beta')
  const betaColumn = columnOf(dialog, betaRow, 'Native Beta')
  mouse(dialog, 'click', betaRow, betaColumn)
  mouse(dialog, 'click', betaRow, betaColumn)
  assert.equal(dialog.activeRowId, 'native:beta')
  assert.deepEqual(activated, ['beta'])

  includeGamma = false
  dialog.setSettings({ ...defaults })
  const internals = dialog as unknown as { activateHit(hit: { index: number; key?: string }): void }
  internals.activateHit({ index: 1, key: 'native:gamma' })
  assert.equal(dialog.activeRowId, 'native:beta', 'the vanished pinned row does not address its old index')
  assert.deepEqual(activated, ['beta'], 'a vanished pinned row runs nothing')
})

test('mouse: a roster rebuilt between press and release still activates the pressed row', () => {
  const activated: string[] = []
  let order: 'forward' | 'reversed' = 'forward'
  const native = (id: string, label: string, value: string) => ({
    id, label, value, onActivate: () => { activated.push(id) },
  })
  const { dialog } = harness({
    rows: 40,
    maxHeight: 26,
    // The parent re-reads native rows on every roster build.
    nativeEntries: () => (order === 'forward'
      ? [native('alpha', 'Native Alpha', 'a'), native('beta', 'Native Beta', 'b'), native('gamma', 'Native Gamma', 'g')]
      : [native('gamma', 'Native Gamma', 'g'), native('beta', 'Native Beta', 'b'), native('alpha', 'Native Alpha', 'a')]),
  })
  goTo(dialog, 'dsh')
  const gammaRow = rowOf(dialog, 'Native Gamma')
  const gammaColumn = columnOf(dialog, gammaRow, 'Native Gamma')

  // A first click only selects the native action row.
  mouse(dialog, 'click', gammaRow, gammaColumn)
  assert.equal(dialog.activeRowId, 'native:gamma')
  assert.deepEqual(activated, [], 'the first click only selects')

  // A press pins that row by its id…
  mouse(dialog, 'press', gammaRow, gammaColumn)
  const height = lines(dialog, 80).length

  // …and the native roster is rebuilt before the release arrives, without a
  // repaint: the painted index of the pressed row now addresses another row.
  order = 'reversed'
  dialog.setSettings({ ...defaults })
  assert.deepEqual(dialog.getVisibleRows().filter(row => row.id.startsWith('native:')).map(row => row.id),
    ['native:gamma', 'native:beta', 'native:alpha'], 'the roster really reordered')

  // The release answers the pressed row (its id), never the row that moved into
  // the pressed row\'s old index.
  dialog.handleMouse({
    type: 'click', button: 'left', x: gammaColumn, y: gammaRow, screenX: gammaColumn, screenY: gammaRow,
    width: 80, height, shift: false, alt: false, ctrl: false, clickCount: 1,
  })
  assert.equal(dialog.activeRowId, 'native:gamma', 'the pinned row id wins over the reordered index')
  assert.deepEqual(activated, ['gamma'], 'exactly the pressed native row ran')

  // A plain click (no recorded press) still resolves the row painted under the
  // pointer, and only a click on the selected row activates it.
  const alphaRow = rowOf(dialog, 'Native Alpha')
  const alphaColumn = columnOf(dialog, alphaRow, 'Native Alpha')
  mouse(dialog, 'click', alphaRow, alphaColumn)
  assert.equal(dialog.activeRowId, 'native:alpha')
  assert.deepEqual(activated, ['gamma'], 'a selecting click never activates')
  mouse(dialog, 'click', alphaRow, alphaColumn)
  assert.deepEqual(activated, ['gamma', 'alpha'], 'a click on the selected row still activates it')
})

test('a disabled/unbound footer action keeps a clickable label without a fake key', () => {
  const tui = createFakeTui(24, 100)
  const keymap = input.createCcKeymap({ bindings: { 'settings.reset': null, 'modal.search': null } })
  const resets: Array<keyof Settings> = []
  const dialog = new SettingsDialog(asTui(tui), {
    settings: { ...defaults },
    keymap,
    onChange: () => {},
    onReset: key => { resets.push(key); return Promise.resolve() },
    onKeybindings: () => {},
    path: '/tmp/temporary/settings.json',
    onCancel: () => {},
  })
  dialog.focused = true
  const rendered = text(dialog)
  assert.match(rendered, /\[reset\]/, 'the capability label stays visible')
  assert.match(rendered, /\[search\]/)
  assert.doesNotMatch(rendered, /ctrl\+r reset/i)
  assert.equal(dialog.activeRowId, 'screen')
  const row = rowOf(dialog, 'reset')
  mouse(dialog, 'click', row, columnOf(dialog, row, 'reset'))
  assert.deepEqual(resets, ['screen'], 'the unbound action is still mouse-clickable')
})

test('native information-only rows cannot be mutated by keyboard or mouse', () => {
  const events: string[] = []
  const { dialog, patches, resets } = harness({
    nativeEntries: () => [
      { id: 'model', label: 'Current model', value: 'deepseek-chat', description: 'Native route' },
      { id: 'skills', label: 'Skills', value: '3 available' },
    ],
  })
  goTo(dialog, 'dsh')
  dialog.handleInput(ENTER)
  assert.equal(patches.length, 0, 'an information row never writes a local setting')
  assert.match(text(dialog), /Information only/)
  // Mouse second-click activation takes the same inert path.
  const row = rowOf(dialog, 'Current model')
  const col = columnOf(dialog, row, 'Current model')
  mouse(dialog, 'click', row, col)
  mouse(dialog, 'click', rowOf(dialog, 'Current model'), col)
  dialog.handleInput(CTRL_R)
  assert.deepEqual(resets, [])
  assert.equal(patches.length, 0)
  assert.equal(events.length, 0)
})

test('native navigation rows stay actionable and unavailable rows stay closeable', () => {
  const activated: string[] = []
  const { dialog } = harness({
    nativeEntries: () => [
      { id: 'model', label: 'Current model', value: 'deepseek-chat', onActivate: () => activated.push('model') },
      { id: 'preset', label: 'Default preset', value: 'unsupported', available: false, onActivate: () => activated.push('preset') },
    ],
  })
  goTo(dialog, 'dsh')
  dialog.handleInput(ENTER)
  assert.deepEqual(activated, ['model'])
  dialog.handleInput(DOWN)
  dialog.handleInput(ENTER)
  assert.deepEqual(activated, ['model'], 'unavailable native capability does not activate')
  assert.match(text(dialog), /unavailable in this DSH runtime/)
  dialog.handleInput(ESC)
  assert.deepEqual(dialog.isDone, true, 'native errors/status never block closing')
})

test('a native failure message stays visible while the panel remains closeable', async () => {
  const { dialog, patches, events } = harness({
    settings: { copyOnSelect: true },
    onChange: () => Promise.reject(new Error('Native settings write failed: revision conflict')),
    rows: 24,
  })
  const row = rowOf(dialog, 'Copy on select')
  const col = columnOf(dialog, row, 'Copy on select')
  mouse(dialog, 'click', row, col)
  mouse(dialog, 'click', rowOf(dialog, 'Copy on select'), col)
  assert.equal(dialog.isSaving, true)
  await new Promise(resolve => setImmediate(resolve))
  const rendered = text(dialog, 80)
  assert.match(rendered, /Native settings write failed/)
  assert.match(rendered, /\[×\]|close/)
  dialog.handleInput(ESC)
  assert.deepEqual(events, ['cancel'])
  assert.equal(patches.length, 1)
})

test('a parent status message is shown and does not become a setting write', () => {
  const { dialog, patches } = harness()
  dialog.setMessage('Current model was chosen through the native picker.', false)
  assert.match(text(dialog), /Current model was chosen/)
  assert.equal(patches.length, 0)
  dialog.setMessage('Native preset unavailable\nerror detail', true)
  assert.match(text(dialog, 60), /Native preset unavailable/)
  assert.equal(dialog.isDone, false)
})

test('fragmented paste in the browse list cannot navigate, reset, activate or interrupt', () => {
  const { dialog, patches, resets, events } = harness({ withInterrupt: true, onReset: () => Promise.resolve() })
  dialog.handleInput('\x1b[2')
  dialog.handleInput('00~\t')
  assert.equal(dialog.isPasting, true)
  for (const chunk of ['\x1b[Z', ENTER, CTRL_R, CTRL_C, ESC, '\x1b[20', '1~']) dialog.handleInput(chunk)
  assert.equal(dialog.isPasting, false)
  assert.equal(dialog.activeRowId, 'screen')
  assert.equal(dialog.activeCategory, 'general')
  assert.equal(dialog.isDone, false)
  assert.deepEqual(patches, [])
  assert.deepEqual(resets, [])
  assert.deepEqual(events, [])
  dialog.handleInput('\t')
  assert.equal(dialog.activeCategory, 'thinking', 'a real key after paste keeps its normal meaning')
})

test('mouse focus cannot redirect an unfinished list paste into the search field', () => {
  const { dialog, patches, events } = harness({ withInterrupt: true })
  const searchRow = rowOf(dialog, 'Search settings')
  dialog.handleInput('\x1b[200~')
  mouse(dialog, 'click', searchRow, 3)
  assert.equal(dialog.searchFocusedState, false, 'the active paste retains input ownership')
  dialog.handleInput('\t\r\x03\x1b[201~')
  assert.equal(dialog.isPasting, false)
  assert.equal(dialog.query, '')
  assert.equal(dialog.activeRowId, 'screen')
  assert.deepEqual(patches, [])
  assert.deepEqual(events, [])
  mouse(dialog, 'click', searchRow, 3)
  assert.equal(dialog.searchFocusedState, true, 'mouse navigation resumes after the paste ends')
})

test('pasted controls in an enum picker cannot apply a value or close it', () => {
  const { dialog, patches, events } = harness()
  dialog.handleInput(ENTER)
  dialog.handleInput('\x1b[200~\r\t\x1b[Z\x12\x03\x1b\x1b[201~')
  assert.equal(dialog.isPasting, false)
  assert.match(text(dialog), /Settings › Default screen/)
  assert.deepEqual(patches, [])
  assert.deepEqual(events, [])
  dialog.handleInput(ESC)
  assert.doesNotMatch(text(dialog), /Settings › Default screen/, 'physical Escape still returns from the picker')
})

test('fragmented paste in the search field is reported to the parent', () => {
  const { dialog } = harness()
  dialog.handleInput(CTRL_F)
  assert.equal(dialog.isPasting, false)
  dialog.handleInput('\x1b[200~permi')
  assert.equal(dialog.isPasting, true)
  dialog.handleInput('\x1b[201~')
  assert.equal(dialog.isPasting, false)
  assert.equal(dialog.query, 'permi')
})

test('a zero-row test host renders an unbounded roster and close still works', () => {
  const { dialog, events } = harness({ rows: 0 })
  assert.match(text(dialog), /Reduced motion/)
  goTo(dialog, 'tools')
  assert.match(text(dialog), /Diff word wrap/)
  dialog.handleInput(ESC)
  assert.deepEqual(events, ['cancel'])
})

test('default Ctrl+C restores the focused search layer locally; only an explicit interrupt is native', () => {
  const local = harness({ withInterrupt: true })
  local.dialog.handleInput(CTRL_F)
  local.dialog.handleInput('\x1b[200~a')
  local.dialog.handleInput('\x1b[201~')
  assert.equal(local.dialog.searchFocusedState, true)
  local.dialog.handleInput(CTRL_C)
  assert.deepEqual(local.events, [], 'default app.clear never reaches the native interrupt hook')
  assert.equal(local.dialog.searchFocusedState, false, 'the search layer is cancelled locally')
  assert.equal(local.dialog.isDone, false, 'the Settings surface stays open')
  assert.equal(local.dialog.query, 'a', 'the query draft survives the local layer cancel until re-focused')

  const explicit = harness({
    keymap: input.createCcKeymap({ bindings: { 'app.interrupt': 'ctrl+c' } }),
    withInterrupt: true,
  })
  explicit.dialog.handleInput(CTRL_F)
  explicit.dialog.handleInput(CTRL_C)
  assert.deepEqual(explicit.events, ['interrupt'])
  assert.equal(explicit.dialog.isDone, false)
  assert.equal(explicit.dialog.searchFocusedState, true, 'an explicit interrupt leaves the field open')
})

test('a pasted Ctrl+C byte stays in the search field instead of interrupting the turn', () => {
  const { dialog, events } = harness({ withInterrupt: true })
  dialog.handleInput(CTRL_F)
  dialog.handleInput('\x1b[200~a')
  assert.equal(dialog.isPasting, true)
  dialog.handleInput(CTRL_C)
  assert.deepEqual(events, [], 'an active paste owns the byte')
  assert.equal(dialog.isPasting, true)
  dialog.handleInput('\x1b[201~')
  assert.equal(dialog.isPasting, false)
  assert.equal(dialog.isDone, false)
})

test('physical escape closes Settings even when every cancel action is disabled', () => {
  const keymap = input.createCcKeymap({ bindings: { 'list.cancel': null, 'dialog.cancel': null, 'app.cancel': null } })
  const { dialog, events } = harness({ keymap })
  dialog.handleInput(ESC)
  assert.deepEqual(events, ['cancel'])
})

test('a short value picker scrolls to keep the focused option visible', () => {
  const { dialog } = harness({ rows: 14, maxHeight: 12 })
  goTo(dialog, 'tools')
  for (let index = 0; index < 30 && dialog.activeRowId !== 'toolLabelClip'; index += 1) dialog.handleInput(DOWN)
  assert.equal(dialog.activeRowId, 'toolLabelClip')
  dialog.handleInput(ENTER)
  for (let index = 0; index < 6; index += 1) dialog.handleInput(DOWN)
  const focused = lines(dialog, 80).map(stripTerminalSequences).find(line => line.includes('❯'))
  assert.ok(focused, 'the focused picker option is visible')
  assert.match(focused, /160|Custom/, 'the focused value is not an unseen top-of-roster row')
})