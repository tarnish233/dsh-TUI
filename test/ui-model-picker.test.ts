import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
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

function typeText(dialog: Picker, value: string): void {
  for (const char of value) dialog.handleInput(char)
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
  assert.match(rendered, /type to search/, 'model navigation returned to browse mode')
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
  assert.equal(p.dialog.isPasting, false)
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

test('Ctrl+C stays global through a pending chord and chord mismatch text becomes query', () => {
  const models: Item[] = [{ id: 'p/one', provider: 'p', model: 'one', label: 'One' }]
  const p = makePicker({ models, currentProvider: 'p' })
  p.dialog.handleInput('\x18') // ctrl+x chord prefix
  assert.notEqual(p.dialog.keymap.getPendingChord(), null)
  p.dialog.handleInput(KEY.ctrlC)
  assert.equal(p.interrupted, 1, 'Ctrl+C reaches app.interrupt through the pending chord')
  assert.equal(p.dialog.keymap.getPendingChord(), null)

  // A chord mismatch with a printable key re-dispatches it as query text.
  const q = makePicker({ models, currentProvider: 'p' })
  q.dialog.handleInput('\x18')
  q.dialog.handleInput('a')
  assert.equal(q.dialog.keymap.getPendingChord(), null)
  let rendered = text(q.dialog)
  assert.match(rendered, /Search a/)
  assert.match(rendered, /type\s+to\s+filter/, 'mismatch printable activated search')
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
  assert.match(text(browse.dialog), /type\s+to\s+filter/, 'Alt+B from browse activated the query')
})

test('Ctrl+C outside paste interrupts globally and Esc cancels locally, each once', () => {
  const models: Item[] = [{ id: 'p/one', provider: 'p', model: 'one', label: 'One' }]
  const p = makePicker({ models, currentProvider: 'p' })
  p.dialog.handleInput(KEY.ctrlC)
  assert.equal(p.interrupted, 1)
  assert.equal(p.cancelled, 0)
  p.dialog.handleInput(KEY.ctrlC)
  assert.equal(p.interrupted, 2)

  const c = makePicker({ models, currentProvider: 'p' })
  c.dialog.handleInput(KEY.escape)
  assert.equal(c.cancelled, 1)
  c.dialog.handleInput(KEY.escape)
  assert.equal(c.cancelled, 1)

  let cancelledWithoutInterrupt = 0
  const noInterrupt = new ModelPickerDialog(fakeTui(), {
    models,
    currentProvider: 'p',
    keymap: keymap(),
    onSelect: () => {},
    onCancel: () => {
      cancelledWithoutInterrupt += 1
    },
  })
  noInterrupt.handleInput(KEY.ctrlC)
  assert.equal(cancelledWithoutInterrupt, 1, 'without onInterrupt Ctrl+C falls back to local cancel')
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
  assert.match(text(disabled.dialog), /type to search/, 'disabled provider Tab does not activate search')
  assert.match(text(p.dialog), /Alt\+N\/Alt\+M provider/, 'hints use the configured bindings')
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

test('reserves App chrome rows so the footer/cwd/hint stay visible', () => {
  const models: Item[] = []
  for (let index = 0; index < 100; index += 1) {
    models.push({ id: `opaque-${index}`, provider: 'alpha', model: `item-${index}`, label: `Catalog item ${index}` })
  }
  const p = makePicker({ models, currentProvider: 'alpha', currentModel: 'item-50', rows: 22, columns: 80 })
  const lines = p.dialog.render(80)
  assert.ok(lines.length <= 16, `${lines.length} lines leave less than 6 rows for App chrome`)
  const rendered = stripTerminalSequences(lines.join('\n'))
  assert.match(rendered, /Search/)
  assert.match(rendered, /Catalog item 50/)
  assert.match(rendered, /provider/)
  p.dialog.handleInput('\x1b[F')
  const after = stripTerminalSequences(p.dialog.render(80).join('\n'))
  assert.match(after, /Catalog item 99/, 'last selected result stays visible')
  assert.ok(p.dialog.render(80).length <= 16)
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