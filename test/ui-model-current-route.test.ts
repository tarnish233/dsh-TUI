// Must stay the FIRST import: forces truecolor capabilities before any src
// module (theme.ts snapshots getTerminalColorMode at import time), so the
// themed `current` badge rows carry real SGR sequences.
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from '#pi-tui'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'

// Real input subsystem (vendored Pi TUI + CC seam); the picker owns exactly one
// query editor, so these tests also prove a route update never touches it.
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
  enter: '\r',
  ctrlA: '\x01',
  tab: '\t',
} as const

const ROSTER: Item[] = [
  { id: 'alpha/a-one', provider: 'alpha', model: 'a-one', label: 'Alpha One' },
  { id: 'alpha/a-two', provider: 'alpha', model: 'a-two', label: 'Alpha Two' },
  { id: 'beta/b-one', provider: 'beta', model: 'b-one', label: 'Beta One' },
]

function fakeTui(rows = 30, columns = 80) {
  return asTui(createFakeTui(rows, columns))
}

function keymap(bindings: Record<string, string | string[] | null | undefined> = {}): CcKeymap {
  return input.createCcKeymap({ bindings })
}

interface Spec {
  models?: Item[]
  currentProvider?: string
  currentModel?: string
  loading?: boolean
  keymap?: CcKeymap
  rows?: number
  columns?: number
}

interface Harness {
  dialog: Picker
  selected: string[]
  cancels: string[]
  interrupts: string[]
  keymap: CcKeymap
}

function harness(spec: Spec = {}): Harness {
  const shared = spec.keymap ?? keymap()
  const selected: string[] = []
  const cancels: string[] = []
  const interrupts: string[] = []
  const dialog = new ModelPickerDialog(fakeTui(spec.rows, spec.columns), {
    models: spec.models ?? ROSTER,
    currentProvider: spec.currentProvider,
    currentModel: spec.currentModel,
    ...(spec.loading === undefined ? {} : { loading: spec.loading }),
    keymap: shared,
    onSelect: (id: string) => { selected.push(id) },
    onCancel: () => { cancels.push('cancelled') },
    onInterrupt: () => { interrupts.push('interrupted') },
  })
  dialog.focused = true
  return { dialog, selected, cancels, interrupts, keymap: shared }
}

function text(dialog: Picker, width = 80): string {
  return stripTerminalSequences(dialog.render(width).join('\n'))
}

function typeText(dialog: Picker, value: string): void {
  for (const char of value) dialog.handleInput(char)
}

/** Display column of the caret inside the painted query line. */
function caretColumn(dialog: Picker, width = 80): number {
  const line = dialog.render(width).find(candidate => candidate.includes(CURSOR_MARKER)) ?? ''
  const marker = line.indexOf(CURSOR_MARKER)
  assert.ok(marker >= 0, 'the focused query field paints a caret')
  return visibleWidth(stripTerminalSequences(line.slice(0, marker)))
}

test('a settled native route moves the current badge without moving the selection', () => {
  const h = harness({ currentProvider: 'alpha', currentModel: 'a-two' })
  const before = text(h.dialog)
  assert.match(before, /Alpha Two\s+a-two\s+current/)
  assert.match(before, /❯.*Alpha Two/)
  assert.match(before, /current alpha\/a-two/)

  // Native defaults settle after the picker opened (app boot / config reload).
  h.dialog.setCurrentRoute('alpha', 'a-one')
  const after = text(h.dialog)
  assert.match(after, /Alpha One\s+a-one\s+current/, 'the badge follows the settled route')
  assert.doesNotMatch(after, /Alpha Two\s+a-two\s+current/, 'the previous route is no longer marked')
  assert.match(after, /❯.*Alpha Two/, 'the row under the cursor does not move')
  assert.match(after, /current alpha\/a-one/)
  assert.match(after, /provider 1\/2/, 'the provider group is untouched')
  assert.deepEqual(h.selected, [], 'a metadata update never answers for the user')
  assert.deepEqual(h.cancels, [])
  assert.deepEqual(h.interrupts, [])

  h.dialog.handleInput(KEY.enter)
  assert.deepEqual(h.selected, ['alpha/a-two'], 'Enter still answers the preserved row')
})

test('an unknown or removed current route never marks a row and stays honest', () => {
  const h = harness({ currentProvider: 'alpha', currentModel: 'a-two' })
  assert.match(text(h.dialog), /a-two\s+current/)

  // A route the catalog never had marks nothing; the status line still reports
  // the native truth instead of inventing a nearby row.
  h.dialog.setCurrentRoute('ghost-provider', 'ghost-model')
  const unknown = text(h.dialog)
  assert.doesNotMatch(unknown, /a-one\s+current|a-two\s+current|b-one\s+current/)
  assert.match(unknown, /current ghost-provider\/ghost-model/)
  assert.match(unknown, /❯.*Alpha Two/, 'the selection survives an unknown route')
  assert.deepEqual(h.selected, [])

  // Clearing the route removes the status part entirely.
  h.dialog.setCurrentRoute(undefined, undefined)
  const cleared = text(h.dialog)
  assert.doesNotMatch(cleared, /current/, 'no current marker is painted or claimed')
  assert.match(cleared, /Alpha One/)
  assert.deepEqual(h.selected, [])
  assert.deepEqual(h.cancels, [])

  // Restoring a known route marks its row again.
  h.dialog.setCurrentRoute('alpha', 'a-one')
  assert.match(text(h.dialog), /Alpha One\s+a-one\s+current/)

  // The native catalog can drop that row later: the route stays as reported by
  // the backend, but no absent row is painted as current.
  h.dialog.setModels([{ id: 'alpha/a-two', provider: 'alpha', model: 'a-two', label: 'Alpha Two' }])
  const removed = text(h.dialog)
  assert.doesNotMatch(removed, /current\s+·|a-one\s+current/)
  assert.match(removed, /current alpha\/a-one/)
  assert.match(removed, /❯.*Alpha Two/)
  assert.deepEqual(h.selected, [])
})

test('a route update preserves query, caret, provider group, focus and keymap', () => {
  const shared = keymap()
  const h = harness({ currentProvider: 'alpha', currentModel: 'a-two', keymap: shared })
  assert.equal(h.dialog.keymap, shared)
  typeText(h.dialog, 'a')
  h.dialog.handleInput(KEY.ctrlA) // readline line start, still inside the query
  const caretBefore = caretColumn(h.dialog)
  const before = text(h.dialog)
  assert.match(before, /Search a/)
  assert.match(before, /2 of 2 models/)

  h.dialog.setCurrentRoute('beta', 'b-one')
  assert.equal(h.dialog.focused, true, 'focus is untouched')
  assert.equal(h.dialog.keymap, shared, 'the shared keymap instance is untouched')
  const after = text(h.dialog)
  assert.match(after, /Search a/, 'the query text is untouched')
  assert.equal(caretColumn(h.dialog), caretBefore, 'the caret stays where the user left it')
  assert.match(after, /2 of 2 models/, 'the filtered result is untouched')
  assert.match(after, /provider 1\/2/, 'no automatic jump to the new current provider')
  assert.match(after, /current beta\/b-one/)
  assert.doesNotMatch(after, /Beta One/, 'the other provider group is not opened')
  assert.deepEqual(h.selected, [])
  assert.deepEqual(h.cancels, [])
  assert.deepEqual(h.interrupts, [])

  // The same single editor still dispatches the keymap after the update.
  h.dialog.handleInput(KEY.enter)
  assert.deepEqual(h.selected, ['alpha/a-two'])
})

test('the setter keeps the loading state and never paints rows that do not exist', () => {
  const h = harness({ models: [], loading: true, currentProvider: 'alpha', currentModel: 'a-two' })
  assert.match(text(h.dialog), /Loading models…/)

  h.dialog.setCurrentRoute('alpha', 'a-one')
  const loading = text(h.dialog)
  assert.match(loading, /Loading models…/, 'still the pending native catalog')
  assert.doesNotMatch(loading, /No models are available/, 'a pending catalog is not an empty one')
  assert.match(loading, /current alpha\/a-one/, 'the status reports the settled native route')
  assert.doesNotMatch(loading, /❯|Alpha One|a-one\s+current/, 'no model row or badge exists before the catalog')
  assert.deepEqual(h.selected, [])

  // The first catalog then initializes from the settled route, as designed.
  h.dialog.setModels(ROSTER)
  const rendered = text(h.dialog)
  assert.match(rendered, /Alpha One\s+a-one\s+current/)
  assert.match(rendered, /❯.*Alpha One/, 'the first catalog still initializes from the native route')
  assert.match(rendered, /current alpha\/a-one/)
  assert.deepEqual(h.selected, [], 'nothing is selected on arrival')
  assert.deepEqual(h.cancels, [])
})

test('the themed badge repaints at every width after a cached frame', () => {
  const h = harness({ currentProvider: 'alpha', currentModel: 'a-two' })
  // Warm the frame/geometry cache, then settle a new route with no catalog call
  // at all: the badge must repaint from the invalidated frame, not stale paint.
  h.dialog.render(80)
  h.dialog.setCurrentRoute('alpha', 'a-one')
  for (const width of [24, 32, 40, 60, 80, 120]) {
    const lines = h.dialog.render(width)
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`)
    const rendered = stripTerminalSequences(lines.join('\n'))
    if (width >= 60) assert.match(rendered, /current alpha\/a-one/)
    if (width >= 40) {
      assert.match(rendered.split('\n')[0] ?? '', /^┌─ /)
      assert.match(rendered.split('\n').at(-1) ?? '', /^└─+┘$/)
      assert.match(rendered, /Cancel/, 'cancel stays discoverable')
    }
  }

  // Themed output: the badge row is painted through the palette (truecolor is
  // forced by the first import) and the styled line stays width-safe.
  const raw = h.dialog.render(80)
  const badge = raw.find(line => {
    const plain = stripTerminalSequences(line)
    return plain.includes('a-one') && plain.includes('current')
  })
  assert.ok(badge !== undefined, 'the current badge row exists')
  assert.match(badge ?? '', /\x1b\[/, 'the badge row carries theme styling')
  assert.ok(visibleWidth(badge ?? '') <= 80)
  assert.match(stripTerminalSequences(badge ?? ''), /Alpha One\s+a-one\s+current/)

  // Repeated identical deliveries are idempotent for the painted surface.
  h.dialog.setCurrentRoute('alpha', 'a-one')
  assert.equal(text(h.dialog, 80), text(h.dialog, 80))
  assert.deepEqual(h.selected, [])
  assert.deepEqual(h.cancels, [])
  assert.deepEqual(h.interrupts, [])
})