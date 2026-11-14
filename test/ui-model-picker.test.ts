import { strict as assert } from 'node:assert'
import test from 'node:test'
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { TuiMouseEventResult } from '#pi-tui'
import { asTui, createFakeTui, loadInputModule, testEditorTheme } from '../src/input/testing/harness.ts'

// Real input subsystem (vendored Pi TUI + CC seam), no fallback editor.
const input = await loadInputModule()
const { ModelPickerDialog } = await import('../src/ui/model-picker.ts')

type CcKeymap = InstanceType<typeof input.CcKeymap>
type Picker = InstanceType<typeof ModelPickerDialog>

interface Item {
  id: string
  provider: string
  model: string
  label?: string
  description?: string
  isDefault?: boolean
}

const KEY = {
  tab: '\t',
  shiftTab: '\x1b[Z',
  left: '\x1b[D',
  right: '\x1b[C',
  up: '\x1b[A',
  down: '\x1b[B',
  enter: '\r',
  escape: '\x1b',
  ctrlC: '\x03',
  ctrlB: '\x02',
  ctrlF: '\x06',
  ctrlA: '\x01',
  ctrlE: '\x05',
  ctrlW: '\x17',
  ctrlY: '\x19',
  ctrlU: '\x15',
  ctrlK: '\x0b',
  undo: '\x1f',
  backspace: '\x7f',
  altB: '\x1bb',
  altF: '\x1bf',
  altBackspace: '\x1b\x7f',
  pageDown: '\x1b[6~',
  pasteStart: '\x1b[200~',
  pasteEnd: '\x1b[201~',
}

function fakeTui(rows = 30, columns = 80) {
  return asTui(createFakeTui(rows, columns))
}

function keymap(bindings: Record<string, string | string[] | null | undefined> = {}): CcKeymap {
  return input.createCcKeymap({ bindings })
}

function makePicker(options: {
  models: Item[]
  currentProvider?: string
  currentModel?: string
  keymap?: CcKeymap
  loading?: boolean
  error?: string
  title?: string
  routeLabel?: string
  onSelect?: (id: string) => void
  onCancel?: () => void
  onInterrupt?: () => void
  rows?: number
  columns?: number
}): {
  dialog: Picker
  selected: string[]
  cancelled: number
  interrupted: number
  tui: ReturnType<typeof fakeTui>
} {
  const tui = fakeTui(options.rows, options.columns)
  const selected: string[] = []
  const state = { cancelled: 0, interrupted: 0 }
  const dialog = new ModelPickerDialog(tui, {
    models: options.models,
    ...(options.loading === undefined ? {} : { loading: options.loading }),
    ...(options.error === undefined ? {} : { error: options.error }),
    ...(options.title === undefined ? {} : { title: options.title }),
    ...(options.routeLabel === undefined ? {} : { routeLabel: options.routeLabel }),
    currentProvider: options.currentProvider,
    currentModel: options.currentModel,
    keymap: options.keymap ?? keymap(),
    onSelect: (id: string) => {
      selected.push(id)
      options.onSelect?.(id)
    },
    onCancel: () => {
      state.cancelled += 1
      options.onCancel?.()
    },
    onInterrupt: () => {
      state.interrupted += 1
      options.onInterrupt?.()
    },
  })
  dialog.focused = true
  return { dialog, selected, get cancelled() { return state.cancelled }, get interrupted() { return state.interrupted }, tui }
}

function text(dialog: Picker, width = 80): string {
  return stripTerminalSequences(dialog.render(width).join('\n'))
}

function assertWidths(dialog: Picker, width: number): void {
  for (const line of dialog.render(width)) {
    assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`)
  }
}

/** The caret marker only exists while the query field owns typing (search mode). */
const fieldFocused = (dialog: Picker, width = 80): boolean =>
  dialog.render(width).join('\n').includes(CURSOR_MARKER)

function typeText(dialog: Picker, value: string): void {
  for (const char of value) dialog.handleInput(char)
}

/**
 * The painted footer action chip for `label`, addressed by its own cells.
 *
 * A disabled action owns no hitbox, so its press/click come back `undefined`;
 * that difference is exactly what separates "a real, if unobvious, target"
 * from "looks selectable and silently swallows the gesture".
 */
function footerChip(
  dialog: Picker,
  label: string,
  width = 80,
): { row: number; col: number; press(): TuiMouseEventResult | undefined; click(): TuiMouseEventResult | undefined } {
  const rendered = dialog.render(width)
  const pattern = new RegExp(`\\[[^\\]]*${label}[^\\]]*\\]`)
  const row = rendered.findIndex(line => pattern.test(stripTerminalSequences(line)))
  assert.ok(row >= 0, `footer action chip "${label}" is painted`)
  const plain = stripTerminalSequences(rendered[row]!)
  const col = visibleWidth(plain.slice(0, plain.indexOf(label)))
  const base = { button: 'left' as const, width, height: rendered.length, shift: false, alt: false, ctrl: false }
  const send = (type: 'press' | 'click'): TuiMouseEventResult | undefined => dialog.handleMouse({
    ...base, type, x: col, y: row, screenX: col, screenY: row,
    ...(type === 'click' ? { clickCount: 1 } : {}),
  })
  return { row, col, press: () => send('press'), click: () => send('click') }
}

const roster: Item[] = [
  { id: 'alpha/a-one', provider: 'alpha', model: 'a-one', label: 'Alpha One', description: 'Fast small model' },
  { id: 'alpha/a-two', provider: 'alpha', model: 'a-two', label: 'Alpha Two', description: 'Balanced daily model' },
  { id: 'beta/b-one', provider: 'beta', model: 'b-one', label: 'Beta One', description: 'Long context model' },
  { id: 'alpha/a-three', provider: 'alpha', model: 'a-three', label: 'Alpha Three', description: 'Reasoning model' },
]

test('groups by provider, preserves roster order and initializes the current route', () => {
  const p = makePicker({ models: roster, currentProvider: 'alpha', currentModel: 'a-two' })
  assert.equal(p.dialog.capturesViewportInput, true)
  const rendered = text(p.dialog)
  assert.match(rendered, /Choose model/)
  assert.match(rendered, /Alpha One/)
  assert.match(rendered, /Alpha Two/)
  assert.match(rendered, /Alpha Three/)
  assert.doesNotMatch(rendered, /Beta One/)
  assert.match(rendered, /a-two\s+current/)
  assert.match(rendered, /3 models/)
  assert.match(rendered, /provider 1\/2/)
  assert.match(rendered, /current alpha\/a-two/)
  // Non-contiguous alpha entries were grouped without reordering.
  const alpha = rendered.indexOf('Alpha One')
  const two = rendered.indexOf('Alpha Two')
  const three = rendered.indexOf('Alpha Three')
  assert.ok(alpha < two && two < three)
  p.dialog.handleInput(KEY.enter)
  assert.deepEqual(p.selected, ['alpha/a-two'])
  p.dialog.handleInput(KEY.enter)
  assert.deepEqual(p.selected, ['alpha/a-two'], 'selection is delivered exactly once')
})

test('current and default marks use the exact provider/model tuple and are never inferred', () => {
  const models: Item[] = [
    { id: 'alpha/shared', provider: 'alpha', model: 'shared', label: 'Shared', isDefault: true },
    { id: 'beta/shared', provider: 'beta', model: 'shared', label: 'Shared' },
  ]
  const p = makePicker({ models, currentProvider: 'alpha', currentModel: 'shared' })
  let rendered = text(p.dialog)
  assert.match(rendered, /current\s+·\s+default/)
  p.dialog.handleInput(KEY.tab)
  rendered = text(p.dialog)
  assert.match(rendered, /provider 2\/2/)
  assert.match(rendered, /current alpha\/shared/)
  assert.doesNotMatch(rendered, /Shared\s+current/, 'same model name in another provider is not marked current')
  p.dialog.handleInput(KEY.enter)
  assert.deepEqual(p.selected, ['beta/shared'])

  const noDefault = makePicker({ models: [{ id: 'x/m', provider: 'x', model: 'm', label: 'M' }], currentProvider: 'x', currentModel: 'm' })
  assert.doesNotMatch(text(noDefault.dialog), /default/)
})

test('Tab/Shift+Tab and browse Left/Right switch provider while preserving the query', () => {
  const models: Item[] = [
    { id: 'p1/one', provider: 'p1', model: 'one', label: 'One' },
    { id: 'p2/two', provider: 'p2', model: 'two', label: 'Two' },
    { id: 'p3/three', provider: 'p3', model: 'three', label: 'Three' },
  ]
  // Left/Right are provider arrows only in browse mode.
  const arrows = makePicker({ models, currentProvider: 'p1', currentModel: 'one' })
  arrows.dialog.handleInput(KEY.right)
  assert.match(text(arrows.dialog), /provider 2\/3/)
  arrows.dialog.handleInput(KEY.right)
  assert.match(text(arrows.dialog), /provider 3\/3/)
  arrows.dialog.handleInput(KEY.right)
  assert.match(text(arrows.dialog), /provider 1\/3/)
  arrows.dialog.handleInput(KEY.left)
  assert.match(text(arrows.dialog), /provider 3\/3/)

  const p = makePicker({ models, currentProvider: 'p1', currentModel: 'one' })
  typeText(p.dialog, 'o')
  assert.match(text(p.dialog), /provider 1\/3/)
  assert.match(text(p.dialog), /Search o/)
  p.dialog.handleInput(KEY.tab)
  assert.match(text(p.dialog), /provider 2\/3/)
  p.dialog.handleInput(KEY.shiftTab)
  assert.match(text(p.dialog), /provider 1\/3/)
  // Tab works in the search context and keeps the query.
  p.dialog.handleInput(KEY.tab)
  assert.match(text(p.dialog), /provider 2\/3/)
  assert.match(text(p.dialog), /Search o/)
})

test('typing j/k/digits and fresh text enters search instead of list/digit selection', () => {
  const models: Item[] = [
    { id: 'p/one', provider: 'p', model: 'one', label: 'One' },
    { id: 'p/two', provider: 'p', model: 'two', label: 'Two' },
    { id: 'p/three', provider: 'p', model: 'three', label: 'Three' },
  ]
  const p = makePicker({ models, currentProvider: 'p', currentModel: 'one' })
  typeText(p.dialog, 'j1k')
  const rendered = text(p.dialog)
  assert.match(rendered, /j1k/)
  assert.match(rendered, /No models match/)
  p.dialog.handleInput(KEY.enter)
  assert.deepEqual(p.selected, [], 'Enter cannot pick a hidden model')
  // Clear the query and confirm the first model is still selected (digit 2 did
  // not quick-select the second item).
  p.dialog.handleInput(KEY.ctrlU)
  assert.match(text(p.dialog), /3 models/)
  p.dialog.handleInput(KEY.enter)
  assert.deepEqual(p.selected, ['p/one'])
})

test('search is case-insensitive over id, label, model and description', () => {
  const models: Item[] = [
    { id: 'p/Opus-4', provider: 'p', model: 'Opus-4', label: 'Ocean Model', description: 'Very Long context window' },
    { id: 'p/fast', provider: 'p', model: 'fast', label: 'Quick', description: 'Small and cheap' },
  ]
  const p = makePicker({ models, currentProvider: 'p', currentModel: 'fast' })
  typeText(p.dialog, 'opus')
  assert.match(text(p.dialog), /Ocean Model/)
  assert.doesNotMatch(text(p.dialog), /Quick/)
  p.dialog.handleInput(KEY.ctrlU)
  typeText(p.dialog, 'LONG')
  assert.match(text(p.dialog), /Ocean Model/)
  p.dialog.handleInput(KEY.ctrlU)
  typeText(p.dialog, 'quick')
  assert.match(text(p.dialog), /Quick/)
  p.dialog.handleInput(KEY.ctrlU)
  typeText(p.dialog, 'p/fa')
  assert.match(text(p.dialog), /Quick/, 'opaque id can be searched without parsing it')
})

test('query persists across providers and filters the new provider', () => {
  const models: Item[] = [
    { id: 'alpha/shared', provider: 'alpha', model: 'shared', label: 'Shared Alpha' },
    { id: 'alpha/other', provider: 'alpha', model: 'other', label: 'Other Alpha' },
    { id: 'beta/shared', provider: 'beta', model: 'shared', label: 'Shared Beta' },
  ]
  const p = makePicker({ models, currentProvider: 'alpha', currentModel: 'shared' })
  typeText(p.dialog, 'shared')
  assert.match(text(p.dialog), /1 of 2 models/)
  p.dialog.handleInput(KEY.tab)
  const rendered = text(p.dialog)
  assert.match(rendered, /provider 2\/2/)
  assert.match(rendered, /Shared Beta/)
  assert.doesNotMatch(rendered, /Other Alpha/)
  assert.match(rendered, /shared/)
})

test('browse mode activates search for genuine readline edits but not for provider arrows', () => {
  const models: Item[] = [
    { id: 'alpha/a', provider: 'alpha', model: 'a', label: 'A' },
    { id: 'beta/b', provider: 'beta', model: 'b', label: 'B' },
  ]
  const p = makePicker({ models, currentProvider: 'alpha' })
  p.dialog.handleInput(KEY.ctrlB)
  assert.match(text(p.dialog), /provider 1\/2/, 'Ctrl+B is an editor move, not a provider arrow')
  typeText(p.dialog, 'ab')
  p.dialog.handleInput(KEY.left)
  assert.match(text(p.dialog), /provider 1\/2/, 'Left edits query text in search mode')
  typeText(p.dialog, 'X')
  assert.match(text(p.dialog), /aXb/)
  p.dialog.handleInput(KEY.right)
  typeText(p.dialog, 'Y')
  assert.match(text(p.dialog), /aXbY/)
})

test('Up/Down at the query boundary navigate models and return to browse; otherwise they edit text', () => {
  const models: Item[] = [
    { id: 'p/one', provider: 'p', model: 'one', label: 'One' },
    { id: 'p/two', provider: 'p', model: 'two', label: 'Two' },
    { id: 'p/three', provider: 'p', model: 'three', label: 'Three' },
  ]
  const p = makePicker({ models, currentProvider: 'p', currentModel: 'one' })
  p.dialog.render(80)
  typeText(p.dialog, 'o')
  p.dialog.handleInput(KEY.down)
  let rendered = text(p.dialog)
  assert.match(rendered, /2\/2/, 'Down at the boundary moved the model selection')
  assert.equal(fieldFocused(p.dialog), false, 'model navigation returned to browse mode')
  p.dialog.handleInput(KEY.up)
  rendered = text(p.dialog)
  assert.match(rendered, /1\/2/)
  // Multi-line query: Up/Down inside the query keep editing until a boundary.
  p.dialog.handleInput(KEY.enter) // selects, create a new picker for the multiline case
  assert.deepEqual(p.selected, ['p/one'])
})

test('readline kill/yank/undo and Ctrl+W vs Alt+Backspace share the one query editor', () => {
  const models: Item[] = [
    { id: 'p/one', provider: 'p', model: 'one', label: 'One' },
    { id: 'p/two', provider: 'p', model: 'two', label: 'Two' },
  ]
  const p = makePicker({ models, currentProvider: 'p' })
  p.dialog.render(80)
  typeText(p.dialog, 'src/utils/foo.ts')
  p.dialog.handleInput(KEY.ctrlW)
  assert.match(text(p.dialog), /2 models/)
  assert.doesNotMatch(text(p.dialog), /src\/utils\/foo\.ts/)
  p.dialog.handleInput(KEY.ctrlY)
  assert.match(text(p.dialog), /src\/utils\/foo.ts/)
  p.dialog.handleInput(KEY.undo)
  assert.doesNotMatch(text(p.dialog), /src\/utils\/foo.ts/)
  p.dialog.handleInput(KEY.ctrlY)
  p.dialog.handleInput(KEY.ctrlA)
  typeText(p.dialog, 'X')
  assert.match(text(p.dialog), /Xsrc\/utils\/foo.ts/)
  p.dialog.handleInput(KEY.ctrlE)
  typeText(p.dialog, 'Y')
  assert.match(text(p.dialog), /Xsrc\/utils\/foo.tsY/)
  p.dialog.handleInput(KEY.altBackspace)
  assert.doesNotMatch(text(p.dialog), /foo\.tsY/)
  p.dialog.handleInput(KEY.ctrlY)
  assert.match(text(p.dialog), /foo\.tsY/)
})

test('fragmented bracketed paste is reassembled, keeps Tab/Ctrl+C bytes as text and exposes isPasting', () => {
  const models: Item[] = [
    { id: 'p/one', provider: 'p', model: 'one', label: 'One' },
    { id: 'p/two', provider: 'p', model: 'two', label: 'Two' },
  ]
  const p = makePicker({ models, currentProvider: 'p', currentModel: 'one' })
  p.dialog.handleInput('\x1b[2')
  // A held prefix is input the editor has not classified yet. Hosts use
  // `isPasting` as their protection flag, so bytes waiting for the rest of the
  // paste marker must report as pasting instead of looking idle.
  assert.equal(p.dialog.isPasting, true, 'a possible paste-marker prefix is held, not ignored')
  p.dialog.handleInput('00~alpha')
  assert.equal(p.dialog.isPasting, true)
  p.dialog.handleInput(KEY.ctrlC) // pasted byte, never an interrupt
  assert.equal(p.interrupted, 0)
  p.dialog.handleInput('\x1b[20')
  p.dialog.handleInput('1~')
  assert.equal(p.dialog.isPasting, false)
  const rendered = text(p.dialog)
  assert.match(rendered, /alpha/, 'paste text reached the query')
  assert.equal(p.interrupted, 0)
  // A single-chunk paste containing Tab and an end marker never navigates.
  p.dialog.handleInput(KEY.ctrlU)
  p.dialog.handleInput(`${KEY.pasteStart}beta\tgamma${KEY.pasteEnd}`)
  assert.match(text(p.dialog), /beta/)
  assert.match(text(p.dialog), /gamma/)
  assert.match(text(p.dialog), /provider 1\/1/)
})

test('default Ctrl+C cancels a pending chord and closes locally; an explicit interrupt keeps priority', () => {
  const models: Item[] = [{ id: 'p/one', provider: 'p', model: 'one', label: 'One' }]
  const p = makePicker({ models, currentProvider: 'p' })
  p.dialog.handleInput('\x18') // ctrl+x chord prefix
  assert.notEqual(p.dialog.keymap.getPendingChord(), null)
  p.dialog.handleInput(KEY.ctrlC)
  assert.equal(p.cancelled, 1, 'default app.clear is the local list.cancel here')
  assert.equal(p.interrupted, 0, 'default Ctrl+C never invokes app.interrupt')
  assert.equal(p.dialog.keymap.getPendingChord(), null)

  const explicit = makePicker({
    models,
    currentProvider: 'p',
    keymap: keymap({ 'app.interrupt': 'ctrl+c' }),
    onInterrupt: () => {},
  })
  explicit.dialog.handleInput('\x18')
  explicit.dialog.handleInput(KEY.ctrlC)
  assert.equal(explicit.interrupted, 1, 'explicit interrupt override keeps priority through the chord')
  assert.equal(explicit.cancelled, 0)
  assert.equal(explicit.dialog.keymap.getPendingChord(), null)

  // A chord mismatch with a printable key re-dispatches it as query text.
  const q = makePicker({ models, currentProvider: 'p' })
  q.dialog.handleInput('\x18')
  q.dialog.handleInput('a')
  assert.equal(q.dialog.keymap.getPendingChord(), null)
  let rendered = text(q.dialog)
  assert.match(rendered, /Search a/)
  assert.equal(fieldFocused(q.dialog), true, 'mismatch printable activated search')
  typeText(q.dialog, 'b')
  assert.match(text(q.dialog), /Search ab/)
})

test('browse Alt+B/F word movement activates search and uses the query editor', () => {
  const models: Item[] = [{ id: 'p/one', provider: 'p', model: 'one', label: 'One' }]
  const p = makePicker({ models, currentProvider: 'p' })
  typeText(p.dialog, 'alpha beta')
  p.dialog.handleInput(KEY.altB)
  typeText(p.dialog, 'X')
  assert.match(text(p.dialog), /alpha Xbeta/)
  p.dialog.handleInput(KEY.altF)
  typeText(p.dialog, 'Y')
  assert.match(text(p.dialog), /alpha XbetaY/)

  const browse = makePicker({ models, currentProvider: 'p' })
  browse.dialog.handleInput(KEY.altB)
  assert.equal(fieldFocused(browse.dialog), true, 'Alt+B from browse activated the query')
})

test('default Ctrl+C and Esc both cancel locally exactly once; only an explicit interrupt is native', () => {
  const models: Item[] = [{ id: 'p/one', provider: 'p', model: 'one', label: 'One' }]
  const p = makePicker({ models, currentProvider: 'p', onInterrupt: () => {} })
  p.dialog.handleInput(KEY.ctrlC)
  assert.equal(p.cancelled, 1, 'default app.clear is the local list.cancel here')
  assert.equal(p.interrupted, 0, 'default Ctrl+C must not invoke the native interrupt hook')
  p.dialog.handleInput(KEY.ctrlC)
  assert.equal(p.cancelled, 1, 'a closed picker stays closed (idempotent)')

  const c = makePicker({ models, currentProvider: 'p' })
  c.dialog.handleInput(KEY.escape)
  assert.equal(c.cancelled, 1)
  c.dialog.handleInput(KEY.escape)
  assert.equal(c.cancelled, 1)

  // Explicit user interrupt override: native, repeatable while the picker is open.
  const explicit = makePicker({
    models,
    currentProvider: 'p',
    keymap: keymap({ 'app.interrupt': 'ctrl+c' }),
    onInterrupt: () => {},
  })
  explicit.dialog.handleInput(KEY.ctrlC)
  assert.equal(explicit.interrupted, 1)
  assert.equal(explicit.cancelled, 0)
  explicit.dialog.handleInput(KEY.ctrlC)
  assert.equal(explicit.interrupted, 2)
})

test('remapped/disabled provider and list actions respect the shared keymap', () => {
  const models: Item[] = [
    { id: 'p1/one', provider: 'p1', model: 'one', label: 'One' },
    { id: 'p1/other', provider: 'p1', model: 'other', label: 'Other' },
    { id: 'p2/two', provider: 'p2', model: 'two', label: 'Two' },
  ]
  const remapped = keymap({
    'model.provider.next': 'alt+n',
    'model.provider.previous': 'alt+m',
    'list.next': 'alt+j',
  })
  const p = makePicker({ models, keymap: remapped })
  p.dialog.handleInput(KEY.tab)
  assert.match(text(p.dialog), /provider 1\/2/, 'old Tab default was removed')
  p.dialog.handleInput('\x1bn')
  assert.match(text(p.dialog), /provider 2\/2/)
  p.dialog.handleInput('\x1bm')
  assert.match(text(p.dialog), /provider 1\/2/)
  p.dialog.handleInput(KEY.down)
  p.dialog.handleInput(KEY.enter)
  assert.deepEqual(p.selected, ['p1/one'], 'old Down default no longer moves list.next')
  const q = makePicker({ models, keymap: remapped })
  q.dialog.handleInput('\x1bj')
  q.dialog.handleInput(KEY.enter)
  assert.deepEqual(q.selected, ['p1/other'])

  const disabled = makePicker({ models, keymap: keymap({ 'model.provider.next': null }) })
  disabled.dialog.handleInput(KEY.tab)
  assert.match(text(disabled.dialog), /provider 1\/2/, 'generic completion/Tab fallback is inert')
  assert.equal(fieldFocused(disabled.dialog), false, 'disabled provider Tab does not activate search')
  assert.match(text(p.dialog), /\[alt\+n Provider\]/, 'the footer prints the configured binding')
  assert.match(text(p.dialog), /\[alt\+m Provider\]/)
})

test('chords stay owned by the one editor and chord-bound provider actions still work', () => {
  const models: Item[] = [
    { id: 'p1/one', provider: 'p1', model: 'one', label: 'One' },
    { id: 'p2/two', provider: 'p2', model: 'two', label: 'Two' },
  ]
  const chordMap = keymap({ 'model.provider.next': ['ctrl+x ctrl+n'] })
  const p = makePicker({ models, keymap: chordMap })
  p.dialog.handleInput('\x18') // ctrl+x
  assert.notEqual(chordMap.getPendingChord(), null)
  p.dialog.handleInput('\x0e') // ctrl+n
  assert.equal(chordMap.getPendingChord(), null)
  assert.match(text(p.dialog), /provider 2\/2/)

  // The generic app chord (Ctrl+X Ctrl+E) is consumed by the editor and does
  // not close the picker or leak a provider switch.
  const q = makePicker({ models })
  q.dialog.handleInput('\x18')
  q.dialog.handleInput('\x05')
  assert.equal(q.dialog.isDone, false)
  assert.match(text(q.dialog), /provider 1\/2/)
  typeText(q.dialog, 'a')
  assert.match(text(q.dialog), /a/)
})

test('provider tabs window to the active provider and all widths stay bounded', () => {
  const models: Item[] = []
  for (let provider = 1; provider <= 12; provider += 1) {
    models.push({ id: `p${provider}/m`, provider: `provider-${provider}`, model: `model-${provider}`, label: `Model ${provider}` })
  }
  const p = makePicker({ models, currentProvider: 'provider-1', rows: 24, columns: 40 })
  for (let index = 0; index < 9; index += 1) p.dialog.handleInput(KEY.tab)
  assert.match(text(p.dialog, 40), /provider-10/, 'active tab stays visible in the window')
  for (const width of [20, 28, 40, 80, 120]) assertWidths(p.dialog, width)

  const large: Item[] = []
  for (let index = 0; index < 80; index += 1) {
    large.push({
      id: `p/model-${index}`,
      provider: 'p',
      model: `model-${index}`,
      label: `A very long model label 中文 🚀 ${index}`,
      description: 'A long description that must wrap safely in narrow terminals without exceeding the viewport.',
    })
  }
  const big = makePicker({ models: large, currentProvider: 'p', currentModel: 'model-40', rows: 24, columns: 24 })
  for (const width of [20, 24, 40, 80]) assertWidths(big.dialog, width)
  assert.ok(big.dialog.render(24).length <= 24, 'short terminals stay within the row bound')
  assert.match(text(big.dialog, 24), /current/)

  const short: Item[] = []
  for (let index = 1; index <= 30; index += 1) {
    short.push({ id: `p/m${index}`, provider: 'p', model: `m${index}`, label: `Model ${index}` })
  }
  const windowed = makePicker({ models: short, currentProvider: 'p', currentModel: 'm1', rows: 24, columns: 40 })
  windowed.dialog.handleInput('\x1b[F') // End -> list.last
  const output = text(windowed.dialog, 40)
  assert.match(output, /Model 30/, 'body window follows the selection')
  assert.doesNotMatch(output, /Model 1\b/)
  assert.ok(windowed.dialog.render(40).length <= 24)

  const cjk: Item[] = [
    { id: 'p/一', provider: '提供商一號', model: '一', label: '模型一 🚀' },
    { id: 'p/二', provider: '提供商二號', model: '二', label: '模型二' },
    { id: 'p/三', provider: '提供商三號', model: '三', label: '模型三' },
  ]
  const wide = makePicker({ models: cjk, currentProvider: '提供商一號', rows: 24, columns: 20 })
  for (const width of [12, 20, 30]) assertWidths(wide.dialog, width)
})

test('10/16/24-row short terminals and multiline paste stay inside the viewport', () => {
  const models: Item[] = []
  for (let index = 1; index <= 40; index += 1) {
    models.push({
      id: `p/m${index}`,
      provider: index % 2 === 0 ? '提供商 🚀 long provider name' : 'p',
      model: `m${index}`,
      label: `Model ${index}`,
      description: 'Description that wraps',
    })
  }
  for (const rows of [10, 16, 24]) {
    const p = makePicker({ models, currentProvider: 'p', currentModel: 'm1', rows, columns: 40 })
    p.dialog.handleInput(`${KEY.pasteStart}alpha
beta
gamma
delta
epsilon${KEY.pasteEnd}`)
    for (const width of [20, 40]) {
      const lines = p.dialog.render(width)
      assert.ok(lines.length <= rows, `${lines.length} rows > ${rows} at width ${width}`)
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`)
    }
    assert.match(text(p.dialog, 40), /alpha/, 'query window still shows the active text')
  }
})

test('the shared frame owns the height budget and keeps the footer inside it', () => {
  const models: Item[] = []
  for (let index = 0; index < 100; index += 1) {
    models.push({ id: `opaque-${index}`, provider: 'alpha', model: `item-${index}`, label: `Catalog item ${index}` })
  }
  for (const rows of [10, 18, 22, 40]) {
    const p = makePicker({ models, currentProvider: 'alpha', currentModel: 'item-50', rows, columns: 80 })
    const lines = p.dialog.render(80)
    // modalHeight: never the full terminal, always two rows of slack.
    const budget = Math.min(rows - 2, Math.floor(rows * 0.9))
    assert.ok(lines.length <= budget, `${lines.length} lines exceed the frame budget ${budget}`)
    const rendered = stripTerminalSequences(lines.join('\n'))
    assert.match(rendered, /Search/)
    assert.match(rendered, /Catalog item 50/)
    assert.match(rendered, /Provider/, 'the provider action stays discoverable')
    // Closed chrome plus a real footer action is the acceptance shape.
    assert.match(rendered.split('\n')[0] ?? '', /^┌─ /)
    assert.match((rendered.split('\n').at(-1) ?? ''), /^└─+┘$/)
    assert.match(rendered, /\[escape Cancel\]|\[Cancel\]/, 'the cancel affordance survives short heights')
    const atEnd = makePicker({ models, currentProvider: 'alpha', currentModel: 'item-50', rows, columns: 80 })
    atEnd.dialog.handleInput('\x1b[F')
    assert.match(stripTerminalSequences(atEnd.dialog.render(80).join('\n')), /Catalog item 99/, 'last selected result stays visible')
  }
})

test('long CJK/emoji/ANSI provider labels stay sanitized and width-safe', () => {
  const models: Item[] = [
    { id: 'p/a', provider: '\x1b[31m提供商🚀非常非常非常非常长的名字\x1b[0m', model: 'a', label: 'A' },
    { id: 'p/b', provider: '另一个提供商🌏', model: 'b', label: 'B' },
  ]
  const p = makePicker({ models, currentProvider: '另一个提供商🌏', rows: 10, columns: 20 })
  for (const width of [10, 16, 20, 40]) {
    const lines = p.dialog.render(width)
    assert.ok(lines.length <= 10)
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`)
  }
  const rendered = text(p.dialog, 40)
  assert.doesNotMatch(rendered, /\x1b\[31m/, 'provider label ANSI is not emitted')
  assert.match(rendered, /提供商/)
})

test('query focus is only shown in actual search mode', () => {
  const models: Item[] = [{ id: 'p/one', provider: 'p', model: 'one', label: 'One' }]
  const p = makePicker({ models, currentProvider: 'p' })
  p.dialog.render(40)
  const browse = p.dialog.render(40).join('\n')
  assert.doesNotMatch(browse, /\x1b_pi:c\x07/, 'browse mode does not show a text caret')
  p.dialog.handleInput('a')
  const search = p.dialog.render(40).join('\n')
  assert.match(search, /\x1b_pi:c\x07/, 'typing shows the active query caret')
})

test('empty rosters render an honest state and never select or navigate', () => {
  const p = makePicker({ models: [], rows: 24, columns: 30 })
  const rendered = text(p.dialog, 30)
  assert.match(rendered, /Choose model/)
  assert.match(rendered, /No models are available/)
  assert.match(rendered, /0 models/)
  p.dialog.handleInput(KEY.tab)
  p.dialog.handleInput(KEY.right)
  p.dialog.handleInput(KEY.down)
  p.dialog.handleInput(KEY.enter)
  assert.deepEqual(p.selected, [])
  for (const width of [12, 20, 30]) assertWidths(p.dialog, width)
})

test('label is optional and falls back to the native model string', () => {
  const p = makePicker({
    models: [
      { id: 'p/native-name', provider: 'p', model: 'native-name' },
      { id: 'p/empty-label', provider: 'p', model: 'empty-label', label: '' },
    ],
    currentProvider: 'p',
    currentModel: 'empty-label',
  })
  const rendered = text(p.dialog)
  assert.match(rendered, /native-name/)
  assert.match(rendered, /empty-label\s+current/)
})

test('dispose is idempotent and does not steal another editor’s pending chord', () => {
  const models: Item[] = [{ id: 'p/one', provider: 'p', model: 'one', label: 'One' }]
  const shared = keymap()
  const other = new input.CcEditor(fakeTui(), testEditorTheme, { keymap: shared, context: 'editor' })
  other.handleInput('\x18') // ctrl+x opens a chord owned by `other`
  assert.notEqual(shared.getPendingChord(), null)
  const p = makePicker({ models, keymap: shared })
  p.dialog.dispose()
  p.dialog.dispose()
  assert.equal(p.dialog.isDisposed, true)
  assert.notEqual(shared.getPendingChord(), null, 'disposing the picker left the other editor’s chord intact')
  other.handleInput('\x05') // ctrl+e completes the other editor's chord
  assert.equal(shared.getPendingChord(), null)
  other.dispose()
})
// ---------------------------------------------------------------------------
// Asynchronous native catalog and mouse parity

test('async catalog: loading, empty, no-match and native failure are distinct and never submit', () => {
  const p = makePicker({ models: [], loading: true, currentProvider: undefined })
  p.dialog.focused = true
  let rendered = text(p.dialog)
  assert.match(rendered, /Loading models…/)
  assert.doesNotMatch(rendered, /No models are available/)

  p.dialog.render(80)
  p.dialog.handleInput(KEY.enter)
  assert.deepEqual(p.selected, [], 'Enter on a loading roster cannot select')

  p.dialog.setLoading(false)
  rendered = text(p.dialog)
  assert.match(rendered, /No models are available\./)
  assert.doesNotMatch(rendered, /Loading models/)

  p.dialog.setError('native model catalog rejected the read')
  rendered = text(p.dialog)
  assert.match(rendered, /native model catalog rejected the read/)
  p.dialog.setError(undefined)
  assert.doesNotMatch(text(p.dialog), /native model catalog rejected the read/)

  // A single late candidate must not be applied on arrival.
  p.dialog.setModels([{ id: 'p/only', provider: 'p', model: 'only', label: 'Only' }])
  assert.deepEqual(p.selected, [], 'arriving catalog data never answers for the user')
  rendered = text(p.dialog)
  assert.match(rendered, /Only/)
  assert.match(rendered, /1 model/)

  // A query with no match is its own state, not an empty catalog.
  typeText(p.dialog, 'zzz')
  rendered = text(p.dialog)
  assert.match(rendered, /No models match "zzz" in p\./)
  assert.doesNotMatch(rendered, /No models are available\./)
  p.dialog.handleInput(KEY.enter)
  assert.deepEqual(p.selected, [], 'Enter on a no-match list cannot select')
})

test('setModels keeps the current provider and the selected model id, without re-submitting', () => {
  const p = makePicker({ models: roster, currentProvider: 'alpha', currentModel: 'a-two' })
  assert.deepEqual(p.selected, [])
  // Re-delivery of the same roster (e.g. a reload) keeps the highlight.
  p.dialog.setModels(roster)
  assert.match(text(p.dialog), /a-two\s+current/)
  const marked = text(p.dialog)
  assert.match(marked, /❯.*Alpha Two/, 'the current route stays the highlighted row')
  assert.deepEqual(p.selected, [], 're-delivery does not select anything')

  // A catalog that no longer contains the provider falls back to the first
  // group; the query and the selection index stay sane.
  p.dialog.setModels([{ id: 'beta/b-one', provider: 'beta', model: 'b-one', label: 'Beta One' }])
  const after = text(p.dialog)
  assert.match(after, /provider 1\/1/)
  assert.match(after, /Beta One/)
  assert.deepEqual(p.selected, [])
})

test('mouse: a click needs a press on the same model id and never selects a moved row', () => {
  const input = keymap()
  const models: Item[] = [
    { id: 'p/one', provider: 'p', model: 'one', label: 'One' },
    { id: 'p/two', provider: 'p', model: 'two', label: 'Two' },
  ]
  const p = makePicker({ models, keymap: input })
  const lines = p.dialog.render(80)
  const rowTwo = lines.findIndex(line => stripTerminalSequences(line).includes('Two'))
  assert.ok(rowTwo > 0)
  const click = (y: number) => ({
    type: 'click' as const, button: 'left' as const, x: 6, y, screenX: 6, screenY: y,
    width: 80, height: lines.length, shift: false, alt: false, ctrl: false, clickCount: 1,
  })
  // Click without press: swallowed.
  assert.equal(p.dialog.handleMouse(click(rowTwo))?.render, false)
  assert.deepEqual(p.selected, [])
  // Press + click on the same row selects that opaque id (Enter parity).
  p.dialog.handleMouse({
    type: 'press', button: 'left', x: 6, y: rowTwo, screenX: 6, screenY: rowTwo,
    width: 80, height: lines.length, shift: false, alt: false, ctrl: false,
  })
  p.dialog.handleMouse(click(rowTwo))
  assert.deepEqual(p.selected, ['p/two'])
})

test('narrow widths keep the frame closed and the footer actionable', () => {
  const models: Item[] = roster
  for (const width of [40, 60, 80, 120]) {
    for (const rows of [10, 18, 24]) {
      const p = makePicker({ models, currentProvider: 'alpha', currentModel: 'a-two', rows, columns: width })
      const lines = p.dialog.render(width)
      for (const line of lines) assert.ok(visibleWidth(line) <= width)
      const rendered = stripTerminalSequences(lines.join('\n'))
      assert.match(rendered.split('\n')[0] ?? '', /^┌─ /)
      assert.match(rendered.split('\n').at(-1) ?? '', /^└─+┘$/)
      assert.match(rendered, /Cancel/, 'cancel stays discoverable at every size')
    }
  }
})

test('an async first catalog honors the explicit current provider, not the first roster entry', () => {
  // Reproduces the App flow: a picker opens before the native catalog exists,
  // with the session's real route. The roster that lands has a different
  // provider first, so "first group" would silently open the wrong provider.
  const rosterItems: Item[] = [
    { id: 'deepseek-official/deepseek-chat', provider: 'deepseek-official', model: 'deepseek-chat', label: 'DeepSeek Chat' },
    { id: 'deepseek-official/deepseek-reasoner', provider: 'deepseek-official', model: 'deepseek-reasoner', label: 'DeepSeek Reasoner' },
    { id: 'picker-alpha/alpha-one', provider: 'picker-alpha', model: 'alpha-one', label: 'Alpha One' },
    { id: 'picker-alpha/alpha-two', provider: 'picker-alpha', model: 'alpha-two', label: 'Alpha Two' },
  ]
  const p = makePicker({ models: [], loading: true, currentProvider: 'picker-alpha', currentModel: 'alpha-two' })
  p.dialog.focused = true
  assert.match(text(p.dialog), /Loading models…/)
  assert.deepEqual(p.selected, [], 'nothing is selected while the catalog is pending')

  p.dialog.setModels(rosterItems)
  const rendered = text(p.dialog)
  assert.match(rendered, /provider 2\/2/, 'the explicit current provider, not the first group')
  assert.match(rendered, /Alpha One/)
  assert.match(rendered, /Alpha Two/)
  assert.match(rendered, /a-two|alpha-two/, 'the current model row is present')
  assert.doesNotMatch(rendered, /DeepSeek Chat/, 'the first roster provider is not opened')
  assert.match(rendered, /❯.*Alpha Two/, 'the current native route is highlighted')
  assert.deepEqual(p.selected, [], 'arriving data still selects nothing')

  // Enter picks the highlighted row of that provider, verbatim.
  p.dialog.handleInput(KEY.enter)
  assert.deepEqual(p.selected, ['picker-alpha/alpha-two'])
})

test('setModels falls back to the first group when the explicit provider is gone', () => {
  const p = makePicker({ models: [], currentProvider: 'retired-provider', currentModel: 'gone', loading: true })
  p.dialog.setModels([{ id: 'p/one', provider: 'p', model: 'one', label: 'One' }])
  assert.match(text(p.dialog), /provider 1\/1/)
  assert.match(text(p.dialog), /One/)
  assert.deepEqual(p.selected, [])
})

// ---------------------------------------------------------------------------
// Caller-supplied presentation (default-model surface) and refresh safety

/** Mouse press/click on the painted row containing `needle`. */
function mouseRow(
  dialog: Picker,
  lines: string[],
  needle: string,
): { press: () => void; click: () => void; y: number } {
  const y = lines.findIndex(line => stripTerminalSequences(line).includes(needle))
  assert.ok(y > 0, `row "${needle}" is painted`)
  const base = { button: 'left' as const, x: 6, width: 80, height: lines.length, shift: false, alt: false, ctrl: false }
  return {
    y,
    press: () => { dialog.handleMouse({ ...base, type: 'press', y, screenX: 6, screenY: y }) },
    click: () => { dialog.handleMouse({ ...base, type: 'click', y, screenX: 6, screenY: y, clickCount: 1 }) },
  }
}

test('title and route label default to the historical presentation', () => {
  const p = makePicker({ models: roster, currentProvider: 'alpha', currentModel: 'a-two' })
  const rendered = text(p.dialog)
  assert.match(rendered, /Choose model/)
  assert.match(rendered, /a-two\s+current/)
  assert.match(rendered, /current alpha\/a-two/)
  assert.doesNotMatch(rendered, /Choose default model/)
  assert.doesNotMatch(rendered, /default alpha\/a-two/)
  assert.deepEqual(p.selected, [], 'opening never selects')
})

test('a caller title and route label rename only the heading, badge word and status prefix', () => {
  const p = makePicker({
    models: roster,
    currentProvider: 'alpha',
    currentModel: 'a-two',
    title: 'Choose default model',
    routeLabel: 'default',
  })
  const rendered = text(p.dialog)
  assert.match(rendered, /^┌─ Choose default model/)
  assert.doesNotMatch(rendered, /Choose model/, 'the historical heading is fully replaced')
  assert.match(rendered, /a-two\s+default/, 'the badge uses the caller word')
  assert.match(rendered, /default alpha\/a-two/, 'the status prefix uses the caller word')
  assert.doesNotMatch(rendered, /current/, 'no stale current marker survives')
  // Still presentation only: identical rows, order, geometry and selection.
  assert.match(rendered, /Alpha One/)
  assert.match(rendered, /3 models/)
  assert.match(rendered, /provider 1\/2/)
  assert.deepEqual(p.selected, [])
  p.dialog.handleInput(KEY.enter)
  assert.deepEqual(p.selected, ['alpha/a-two'], 'the default surface still submits the exact opaque id')
})

test('the route label marks only the exact provider/model tuple', () => {
  const shared: Item[] = [
    { id: 'alpha/shared', provider: 'alpha', model: 'shared', label: 'Shared' },
    { id: 'beta/shared', provider: 'beta', model: 'shared', label: 'Shared' },
  ]
  const p = makePicker({
    models: shared,
    currentProvider: 'alpha',
    currentModel: 'shared',
    title: 'Choose default model',
    routeLabel: 'default',
  })
  let rendered = text(p.dialog)
  assert.match(rendered, /❯ Shared  shared  default/)
  assert.match(rendered, /default alpha\/shared/)
  p.dialog.handleInput(KEY.tab)
  rendered = text(p.dialog)
  assert.match(rendered, /provider 2\/2/)
  assert.doesNotMatch(rendered, /❯ Shared  shared  default/, 'the same model name in another provider is not marked')
  assert.match(rendered, /default alpha\/shared/, 'the marked route itself does not move')
  assert.equal(p.dialog.isDone, false)
  assert.deepEqual(p.selected, [])
})

test('caller presentation strings are sanitized, bounded and width-safe', () => {
  const long = 'Choose default ' + 'x'.repeat(300)
  const injected = `Choose default model \x1b]0;evil-title\x07\x1b[31m`
  const cases = [long, injected, '默认模型选择 一个很长很长的标题'.repeat(6)]
  for (const title of cases) {
    for (const routeLabel of ['默认', 'default ' + 'y'.repeat(80), '\x1b]0;evil-label\x07high']) {
      for (const width of [30, 48, 64, 80]) {
        const p = makePicker({
          models: roster,
          currentProvider: 'alpha',
          currentModel: 'a-two',
          title,
          routeLabel,
          rows: 24,
          columns: width,
        })
        const lines = p.dialog.render(width)
        for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`)
        const painted = stripTerminalSequences(lines.join('\n'))
        assert.match(painted, /^┌─ /, 'the frame stays closed at every width')
        assert.match(painted.split('\n').at(-1) ?? '', /^└─+┘$/, 'the footer stays inside the viewport')
        assert.doesNotMatch(painted, /evil-title|evil-label/, 'terminal sequences in caller strings are stripped')
        assert.match(painted, /a-two\s+\S+/, 'the exact tuple keeps a badge word')
        assert.deepEqual(p.selected, [], 'rendering a long label never selects')
      }
    }
  }
})

test('empty or control-only caller strings fall back to the historical defaults', () => {
  for (const title of ['', '   ', '\x1b[31m', '\x1b]0;only-sequence\x07']) {
    for (const routeLabel of ['', '\t ', '\x00', '\x1b[1m']) {
      const p = makePicker({ models: roster, currentProvider: 'alpha', currentModel: 'a-two', title, routeLabel })
      const rendered = text(p.dialog)
      assert.match(rendered, /Choose model/, `blank title falls back (${JSON.stringify(title)})`)
      assert.match(rendered, /a-two\s+current/, `blank route label falls back (${JSON.stringify(routeLabel)})`)
      assert.match(rendered, /current alpha\/a-two/)
      assert.deepEqual(p.selected, [])
    }
  }
})

test('metadata refresh keeps caller presentation and never selects or submits', () => {
  const p = makePicker({
    models: roster,
    currentProvider: 'alpha',
    currentModel: 'a-two',
    title: 'Choose default model',
    routeLabel: 'default',
  })
  p.dialog.setCurrentRoute('beta', 'b-one')
  p.dialog.setModels(roster)
  p.dialog.setLoading(false)
  const rendered = text(p.dialog)
  assert.match(rendered, /Choose default model/)
  assert.match(rendered, /default beta\/b-one/, 'the settled native route refreshes only the status/badge')
  assert.equal(p.dialog.isDone, false)
  assert.deepEqual(p.selected, [], 'a catalog/route refresh never answers for the user')
  assert.match(rendered, /❯.*Alpha Two/, 'the selected row survives the refresh')
})

test('a held refresh blocks Enter and mouse confirmation without marking the picker done', () => {
  const p = makePicker({
    models: roster,
    currentProvider: 'alpha',
    currentModel: 'a-two',
    title: 'Choose default model',
    routeLabel: 'default',
  })
  p.dialog.render(80)
  p.dialog.setLoading(true)
  let lines = p.dialog.render(80)
  const two = mouseRow(p.dialog, lines, 'Alpha Two')

  p.dialog.handleInput(KEY.enter)
  assert.deepEqual(p.selected, [], 'Enter during a held refresh confirms nothing')
  assert.equal(p.dialog.isDone, false, 'the surface stays open for the refreshed roster')

  two.press()
  two.click()
  assert.deepEqual(p.selected, [], 'a mouse release during a held refresh confirms nothing')
  assert.equal(p.dialog.isDone, false)
  assert.match(text(p.dialog), /Choose default model/, 'the caller heading survives the held refresh')

  // Successful retry: the same row, highlighted where the user left it.
  p.dialog.setLoading(false)
  lines = p.dialog.render(80)
  assert.match(stripTerminalSequences(lines.join('\n')), /❯.*Alpha Two/)
  p.dialog.handleInput(KEY.enter)
  assert.deepEqual(p.selected, ['alpha/a-two'], 'exactly one confirmation after the refresh settles')
  assert.equal(p.dialog.isDone, true)
  p.dialog.handleInput(KEY.enter)
  assert.deepEqual(p.selected, ['alpha/a-two'], 'a settled picker never submits twice')
})

test('a held catalog refresh with rows on screen shows Refreshing… and disables the footer Select', () => {
  const p = makePicker({ models: roster, currentProvider: 'alpha', currentModel: 'a-two' })
  p.dialog.render(80)
  p.dialog.setLoading(true)
  const lines = p.dialog.render(80)
  const painted = stripTerminalSequences(lines.join('\n'))
  // The previous roster stays readable so the highlight and query survive it…
  assert.match(painted, /Alpha One/)
  assert.match(painted, /❯.*Alpha Two/)
  // …but the pending refresh is visible instead of hiding behind a dead chip.
  assert.match(painted, /Refreshing…/, 'a held refresh with an old catalog says so')
  assert.doesNotMatch(painted, /Loading models…/, 'a loaded catalog is not the empty loading state')

  // The Select chip is disabled: it owns no hitbox, so neither press nor click
  // is claimed on top of the already-guarded Enter.
  const chip = footerChip(p.dialog, 'Select')
  assert.equal(chip.press(), undefined, 'a disabled Select chip claims no press')
  assert.equal(chip.click(), undefined, 'a disabled Select chip claims no click')
  p.dialog.handleInput(KEY.enter)
  assert.deepEqual(p.selected, [], 'Enter still cannot confirm the stale catalog')
  assert.equal(p.dialog.isDone, false, 'the surface stays open for the refreshed catalog')

  // The refresh settles: the status line goes away and the same chip is live.
  p.dialog.setLoading(false)
  assert.doesNotMatch(text(p.dialog), /Refreshing…/)
  assert.match(text(p.dialog), /❯.*Alpha Two/, 'the highlight survives the refresh')
  const live = footerChip(p.dialog, 'Select')
  assert.equal(live.press()?.handled, true, 'the Select chip claims a press once the catalog settles')
  assert.equal(live.click()?.handled, true)
  assert.deepEqual(p.selected, ['alpha/a-two'], 'exactly one confirmation through the restored chip')
  assert.equal(p.dialog.isDone, true)
})

test('native model-picker error text cannot inject terminal sequences', () => {
  const p = makePicker({ models: roster, currentProvider: 'alpha', currentModel: 'a-two' })
  p.dialog.setError('native failure \x1b[2J\x1b]0;owned-title\x07')
  const raw = p.dialog.render(90).join('\n')
  assert.doesNotMatch(raw, /\x1b\[2J/)
  assert.doesNotMatch(raw, /\x1b\]0;owned-title/)
  assert.doesNotMatch(raw, /owned-title/)
})

test('a visible native error stays informational: Enter, chip and mouse still confirm the painted roster', () => {
  const p = makePicker({ models: roster, currentProvider: 'alpha', currentModel: 'a-two' })
  typeText(p.dialog, 'three')
  p.dialog.render(80)
  p.dialog.setError('Native catalog refresh failed.')
  let lines = p.dialog.render(80)
  const painted = stripTerminalSequences(lines.join('\n'))
  assert.match(painted, /Native catalog refresh failed\./)
  assert.match(painted, /Alpha Three/, 'the roster stays readable under the failure')

  // The Select chip keeps its hitbox: an error never turns it into a dead control.
  const chip = footerChip(p.dialog, 'Select')
  assert.equal(chip.press()?.handled, true, 'an error leaves the Select chip pressable')
  assert.equal(chip.click()?.handled, true, 'an error leaves the Select chip clickable')
  assert.deepEqual(p.selected, ['alpha/a-three'], 'the chip confirms the highlighted row')
  assert.equal(p.dialog.isDone, true)

  // Enter is the same confirmation path.
  const enter = makePicker({ models: roster, currentProvider: 'alpha', currentModel: 'a-two' })
  typeText(enter.dialog, 'three')
  enter.dialog.setError('Native catalog refresh failed.')
  enter.dialog.handleInput(KEY.enter)
  assert.deepEqual(enter.selected, ['alpha/a-three'], 'Enter under a visible failure confirms the highlighted row')
  assert.equal(enter.dialog.isDone, true)

  // A press/release pair on a roster row confirms that row too.
  const mouse = makePicker({ models: roster, currentProvider: 'alpha', currentModel: 'a-two' })
  mouse.dialog.setError('Native catalog refresh failed.')
  lines = mouse.dialog.render(80)
  const three = mouseRow(mouse.dialog, lines, 'Alpha Three')
  three.press()
  three.click()
  assert.deepEqual(mouse.selected, ['alpha/a-three'], 'a mouse release under a visible failure confirms the row')
  assert.equal(mouse.dialog.isDone, true)
})

test('a held native refresh still blocks confirmation, visible error or not', () => {
  const p = makePicker({
    models: roster,
    currentProvider: 'alpha',
    currentModel: 'a-two',
    error: 'Native catalog refresh failed.',
  })
  p.dialog.render(80)
  p.dialog.setLoading(true)
  p.dialog.handleInput(KEY.enter)
  assert.deepEqual(p.selected, [], 'loading blocks confirmation even with an informational error')
  assert.equal(p.dialog.isDone, false)
  const chip = footerChip(p.dialog, 'Select')
  assert.equal(chip.press(), undefined, 'a held refresh still removes the Select hitbox')
  assert.equal(chip.click(), undefined)

  // Once the refresh settles, the stored error is painted again and the same
  // roster is confirmable: an error is information, not a lock.
  p.dialog.setLoading(false)
  assert.match(text(p.dialog), /Native catalog refresh failed\./)
  p.dialog.handleInput(KEY.enter)
  assert.deepEqual(p.selected, ['alpha/a-two'], 'exactly one confirmation after the refresh settles')
  assert.equal(p.dialog.isDone, true)
})

test('a retry after an error shows Refreshing… instead of the stale failure', () => {
  const p = makePicker({ models: roster, currentProvider: 'alpha', currentModel: 'a-two' })
  p.dialog.setError('Previous catalog failure')
  p.dialog.setLoading(true)
  const raw = text(p.dialog)
  assert.match(raw, /Refreshing…/)
  assert.doesNotMatch(raw, /Previous catalog failure/)
  p.dialog.handleInput(KEY.enter)
  assert.deepEqual(p.selected, [], 'a loading retry still cannot confirm the old roster')
  p.dialog.setLoading(false)
  const settled = text(p.dialog)
  assert.match(settled, /Previous catalog failure/, 'the stored failure returns once loading ends')
})

test('a press recorded before an invalidation can never click afterwards', () => {
  const models: Item[] = [
    { id: 'p/one', provider: 'p', model: 'one', label: 'One' },
    { id: 'p/two', provider: 'p', model: 'two', label: 'Two' },
  ]
  const p = makePicker({ models, title: 'Choose default model', routeLabel: 'default' })
  let lines = p.dialog.render(80)
  let two = mouseRow(p.dialog, lines, 'Two')

  // Error invalidation retires the press even when the error is cleared again.
  two.press()
  p.dialog.setError('held')
  p.dialog.setError(undefined)
  lines = p.dialog.render(80)
  two = mouseRow(p.dialog, lines, 'Two')
  two.click()
  assert.deepEqual(p.selected, [], 'the pre-error press cannot answer the refreshed state')
  assert.equal(p.dialog.isDone, false)

  // A roster replacement retires it too, even with an identical shape.
  two.press()
  p.dialog.setModels(models.map(item => ({ ...item })))
  p.dialog.render(80)
  two.click()
  assert.deepEqual(p.selected, [], 'the pre-refresh press cannot answer the new roster')

  // A fresh press/click pair still confirms exactly once.
  two.press()
  two.click()
  assert.deepEqual(p.selected, ['p/two'])
  assert.equal(p.dialog.isDone, true)
})
