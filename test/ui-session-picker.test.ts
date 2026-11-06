import { strict as assert } from 'node:assert'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from '#pi-tui'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'

// Real input subsystem (vendored Pi TUI + CC seam); the picker is loaded after
// it so the shared keymap and the single Input state come from the same build.
const input = await loadInputModule()
const { SessionPickerDialog } = await import('../src/ui/session-picker.ts')

// Fixtures list sessions exactly as DSH's `sessions` listing does: newest first
// (sessionQuery `compareSessions`). The picker never re-sorts the listing, so
// every fixture below is written in that native order on purpose.

type CcKeymap = InstanceType<typeof input.CcKeymap>
type Picker = InstanceType<typeof SessionPickerDialog>

interface Item {
  id: string
  title?: string
  cwd: string
  createdAt?: number
  live?: boolean
}

const DIRECTORY = '/work/alpha'
const OTHER = '/work/beta'

const KEY = {
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  pageUp: '\x1b[5~',
  pageDown: '\x1b[6~',
  end: '\x1b[F',
  enter: '\r',
  escape: '\x1b',
  ctrlC: '\x03',
  ctrlP: '\x10',
  ctrlN: '\x0e',
  backspace: '\x7f',
}

function fakeTui(rows = 30, columns = 80) {
  return asTui(createFakeTui(rows, columns))
}

function keymap(bindings: Record<string, string | string[] | null | undefined> = {}): CcKeymap {
  return input.createCcKeymap({ bindings })
}

interface Harness {
  picker: Picker
  selected: string[]
  cancelled: number
  interrupted: number
  /** Every `onVisibleIds` call, in order. */
  visibleIds: string[][]
}

function makePicker(options: {
  items?: Item[]
  loading?: boolean
  directory?: string
  rows?: number
  keymap?: CcKeymap
  onInterrupt?: boolean
}): Harness {
  const harness: Harness = {
    picker: undefined as unknown as Picker,
    selected: [],
    cancelled: 0,
    interrupted: 0,
    visibleIds: [],
  }
  harness.picker = new SessionPickerDialog(fakeTui(options.rows ?? 30), {
    ...(options.items === undefined ? {} : { sessions: options.items }),
    ...(options.loading === true ? { loading: true } : {}),
    directory: options.directory ?? DIRECTORY,
    keymap: options.keymap ?? keymap(),
    onSelect: id => { harness.selected.push(id) },
    onCancel: () => { harness.cancelled += 1 },
    ...(options.onInterrupt === true ? { onInterrupt: () => { harness.interrupted += 1 } } : {}),
    onVisibleIds: ids => { harness.visibleIds.push([...ids]) },
  })
  return harness
}

/** Rendered plain text, as every other ui test reads a dialog. */
function text(picker: Picker, width = 80): string {
  return stripTerminalSequences(picker.render(width).join('\n'))
}

/** The one line carrying the selection cursor. */
function selectedLine(picker: Picker, width = 80): string {
  const line = picker.render(width).map(stripTerminalSequences).find(candidate => candidate.trimStart().startsWith('❯'))
  return line ?? ''
}

function assertWidths(picker: Picker, width: number): void {
  for (const line of picker.render(width)) {
    assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`)
    const plain = stripTerminalSequences(line)
    assert.ok(!plain.includes('\x1b'), `dangling escape at width ${width}: ${JSON.stringify(line)}`)
    assert.ok(!/\[[0-9;?]*[a-zA-Z]/.test(plain), `truncated sequence at width ${width}: ${JSON.stringify(line)}`)
  }
}

const minutes = (value: number): number => value * 60_000

test('initial render shows the title, scope indicator, search row, rows and footer', () => {
  const now = Date.now()
  const p = makePicker({
    items: [
      { id: 'alpha', title: 'Alpha session', cwd: DIRECTORY, createdAt: now - minutes(5) - 1000 },
      { id: 'beta', title: 'Beta session', cwd: DIRECTORY, createdAt: now - 3 * 60 * minutes(1) - 1000 },
    ],
  })
  assert.equal(p.picker.capturesViewportInput, true)
  const rendered = text(p.picker)
  assert.match(rendered, /Resume session \(Current Folder\)/)
  assert.match(rendered, /Current Folder \| All/)
  assert.match(rendered, /Search/)
  assert.match(rendered, /1\. Alpha session/)
  assert.match(rendered, /2\. Beta session/)
  assert.match(rendered, /5m ago/)
  assert.match(rendered, /3h ago/)
  assert.match(rendered, /Tab folder\/all · Enter select · Esc cancel · type to search/)
  // Pi's order: header, search field, blank line, rows.
  const lines = p.picker.render(80).map(stripTerminalSequences)
  assert.match(lines[0] ?? '', /Resume session \(Current Folder\)/)
  assert.match(lines[1] ?? '', /Search/)
  assert.equal(lines[2], '')
  assert.match(lines[3] ?? '', /Alpha session/)
  for (const width of [4, 10, 24, 40, 80, 120]) assertWidths(p.picker, width)
})

test('directory scope keeps only this folder; Tab switches to all with shortened cwd', () => {
  const now = Date.now()
  // Spell the fixture cwd with $HOME exactly as `homedir()` reports it: the
  // picker shortens with a raw prefix comparison, so a `$HOME` that itself
  // carries a trailing or doubled separator must not change the expectation.
  const home = `${homedir()}/work/foo`
  const p = makePicker({
    items: [
      { id: 'local', title: 'Local session', cwd: DIRECTORY, createdAt: now },
      // resolve() equality: a symlinked/normalised launch path still matches.
      { id: 'normalised', title: 'Normalised session', cwd: `${DIRECTORY}/sub/..`, createdAt: now - 1000 },
      { id: 'elsewhere', title: 'Elsewhere session', cwd: home, createdAt: now - 2000 },
      { id: 'nocwd', title: 'Directoryless session', cwd: '', createdAt: now - 3000 },
    ],
  })
  const local = text(p.picker)
  assert.match(local, /Local session/)
  assert.match(local, /Normalised session/)
  assert.doesNotMatch(local, /Elsewhere session/, 'other directories are filtered out')
  assert.doesNotMatch(local, /Directoryless session/, 'empty recorded cwd never matches')
  assert.doesNotMatch(local, /\.\./, 'the all-scope cwd column is absent in folder scope')

  p.picker.handleInput(KEY.tab)
  const all = text(p.picker)
  assert.match(all, /Resume session \(All\)/)
  assert.match(all, /Current Folder \| All/)
  assert.match(all, /Elsewhere session/)
  assert.match(all, /~\/work\/foo/, 'the cwd column is home-shortened')
})

test('a home prefix longer than the display budget is shortened before the live-row metadata is fitted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-session-picker-long-home-'))
  const home = join(root, ...Array.from({ length: 16 }, (_, index) => 'home-directory-segment-' + index))
  const previousHome = process.env.HOME
  const previousProfile = process.env.USERPROFILE
  try {
    await mkdir(home, { recursive: true })
    process.env.HOME = home
    process.env.USERPROFILE = home
    assert.ok(homedir().length > 300, 'the home prefix itself exceeds the display budget')
    const cwd = `${homedir()}/work/repo`
    const item = { id: 'opaque-live-session', title: 'Live long-home session', cwd, createdAt: Date.now(), live: true }
    const p = makePicker({ items: [item] })
    p.picker.handleInput(KEY.tab)
    const row = selectedLine(p.picker, 120)
    assert.match(row, /just now · open elsewhere/)
    assert.match(row, /~\/work\/repo/, 'the complete relative suffix stays visible')
    assert.equal(item.cwd, cwd, 'display shortening never changes the native DTO')
    for (const width of [4, 24, 40, 80, 120]) assertWidths(p.picker, width)
    p.picker.handleInput(KEY.enter)
    assert.deepEqual(p.selected, ['opaque-live-session'], 'the opaque native id is unchanged')
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile
    await rm(root, { recursive: true, force: true })
  }
})

test('the native listing order is displayed as given, unknown stamps included', () => {
  const now = Date.now()
  // Native newest-first order: DSH already sorted this, including the
  // unstamped records last. The picker must not re-sort it.
  const p = makePicker({
    items: [
      { id: 'new', title: 'Newest session', cwd: DIRECTORY, createdAt: now - minutes(1) },
      { id: 'old', title: 'Oldest session', cwd: DIRECTORY, createdAt: now - 3 * 60 * 60 * 1000 },
      { id: 'unknown', title: 'Unknown stamp session', cwd: DIRECTORY },
      { id: 'zero', title: 'Zero stamp session', cwd: DIRECTORY, createdAt: 0 },
    ],
  })
  const rendered = text(p.picker)
  assert.ok(rendered.indexOf('Newest session') < rendered.indexOf('Oldest session'))
  assert.ok(rendered.indexOf('Oldest session') < rendered.indexOf('Unknown stamp session'))
  assert.ok(rendered.indexOf('Unknown stamp session') < rendered.indexOf('Zero stamp session'))
  assert.match(selectedLine(p.picker), /Newest session/, 'the first native row starts selected')
  assert.match(rendered, /1\. Newest session/)
  assert.match(rendered, /4\. Zero stamp session/)
  assert.match(rendered, /unknown time/, 'an absent or zero stamp still displays honestly')
})

test('the age column covers just now, minutes, hours, days, dates and unknown', () => {
  const now = Date.now()
  const p = makePicker({
    items: [
      { id: 'now', title: 'Now session', cwd: DIRECTORY, createdAt: now - 5000 },
      { id: 'minutes', title: 'Minutes session', cwd: DIRECTORY, createdAt: now - minutes(5) - 1000 },
      { id: 'hours', title: 'Hours session', cwd: DIRECTORY, createdAt: now - 3 * 60 * minutes(1) - 1000 },
      { id: 'days', title: 'Days session', cwd: DIRECTORY, createdAt: now - 2 * 24 * 60 * minutes(1) - 1000 },
      { id: 'date', title: 'Dated session', cwd: DIRECTORY, createdAt: new Date(2020, 4, 6, 12).getTime() },
      { id: 'unknown', title: 'Unknown session', cwd: DIRECTORY },
    ],
  })
  const rendered = text(p.picker)
  assert.match(rendered, /just now/)
  assert.match(rendered, /5m ago/)
  assert.match(rendered, /3h ago/)
  assert.match(rendered, /2d ago/)
  assert.match(rendered, /2020-05-06/)
  assert.match(rendered, /unknown time/)
})

test('a live session is marked and an untitled session falls back honestly', () => {
  const p = makePicker({
    items: [
      { id: 'live', title: 'Live session', cwd: DIRECTORY, createdAt: Date.now() - minutes(2), live: true },
      { id: 'untitled', cwd: DIRECTORY, createdAt: Date.now() - minutes(9) },
      { id: 'empty-title', title: '', cwd: DIRECTORY, createdAt: Date.now() - minutes(9) },
    ],
  })
  const rendered = text(p.picker)
  assert.match(rendered, /open elsewhere/)
  assert.match(rendered, /2\. \(untitled\)/)
  assert.match(rendered, /3\. \(untitled\)/)
  // `live` is only a marker: the row still shows its own title and age.
  const liveLine = p.picker.render(80).map(stripTerminalSequences).find(line => line.includes('Live session')) ?? ''
  assert.match(liveLine, /2m ago · open elsewhere/)
})

test('typing fuzzy-filters over title and cwd, Backspace restores the full list', () => {
  const now = Date.now()
  const p = makePicker({
    items: [
      { id: 'alpha', title: 'Alpha session', cwd: DIRECTORY, createdAt: now },
      { id: 'beta', title: 'Beta session', cwd: OTHER, createdAt: now - 1000 },
      { id: 'gamma', title: 'Gamma session', cwd: OTHER, createdAt: now - 2000 },
    ],
  })
  p.picker.handleInput(KEY.tab) // all scope: every session is a candidate
  for (const char of 'gamma') p.picker.handleInput(char)
  const filtered = text(p.picker)
  assert.match(filtered, /Gamma session/)
  assert.doesNotMatch(filtered, /Alpha session/)
  assert.doesNotMatch(filtered, /Beta session/)

  for (let index = 0; index < 5; index += 1) p.picker.handleInput(KEY.backspace)
  const restored = text(p.picker)
  assert.match(restored, /Alpha session/)
  assert.match(restored, /Beta session/)
  assert.match(restored, /Gamma session/)

  // The cwd participates in the match too.
  for (const char of 'beta') p.picker.handleInput(char)
  assert.match(text(p.picker), /Beta session/)
})

test('Enter selects the exact session id in both scopes', () => {
  const now = Date.now()
  const items: Item[] = [
    { id: 'local', title: 'Local session', cwd: DIRECTORY, createdAt: now },
    { id: 'other', title: 'Other session', cwd: OTHER, createdAt: now - minutes(1) },
  ]
  const local = makePicker({ items })
  local.picker.handleInput(KEY.enter)
  assert.deepEqual(local.selected, ['local'])
  assert.equal(local.cancelled, 0)

  const all = makePicker({ items })
  all.picker.handleInput(KEY.tab)
  all.picker.handleInput(KEY.down)
  all.picker.handleInput(KEY.enter)
  assert.deepEqual(all.selected, ['other'])

  // One selection closes the picker; later keys are inert.
  all.picker.handleInput(KEY.enter)
  assert.deepEqual(all.selected, ['other'])
})

test('Enter with an active query selects the filtered row', () => {
  const now = Date.now()
  const p = makePicker({
    items: [
      { id: 'alpha', title: 'Alpha session', cwd: DIRECTORY, createdAt: now },
      { id: 'beta', title: 'Beta session', cwd: DIRECTORY, createdAt: now - 1000 },
    ],
  })
  for (const char of 'bet') p.picker.handleInput(char)
  p.picker.handleInput(KEY.enter)
  assert.deepEqual(p.selected, ['beta'])
})

test('Esc cancels the picker, including with an active query', () => {
  const plain = makePicker({ items: [{ id: 'a', title: 'A session', cwd: DIRECTORY, createdAt: Date.now() }] })
  plain.picker.handleInput(KEY.escape)
  assert.equal(plain.cancelled, 1)
  assert.deepEqual(plain.selected, [])

  const searching = makePicker({ items: [{ id: 'a', title: 'A session', cwd: DIRECTORY, createdAt: Date.now() }] })
  searching.picker.handleInput('a')
  assert.equal(searching.cancelled, 0, 'typing does not cancel')
  searching.picker.handleInput(KEY.escape)
  assert.equal(searching.cancelled, 1, 'Esc is a cancel even while searching')
})

test('digits quick-select only while the query is empty', () => {
  const now = Date.now()
  const items: Item[] = [
    { id: 'alpha', title: 'Alpha session', cwd: DIRECTORY, createdAt: now },
    { id: 'beta', title: 'Beta session', cwd: DIRECTORY, createdAt: now - 1000 },
  ]
  const digit = makePicker({ items })
  digit.picker.handleInput('2')
  assert.deepEqual(digit.selected, ['beta'], 'the numbered shortcut selects with an empty query')

  const typed = makePicker({
    items: [
      { id: 'alpha', title: 'Alpha 1 session', cwd: DIRECTORY, createdAt: now },
      { id: 'beta', title: 'Beta 1 session', cwd: DIRECTORY, createdAt: now - 1000 },
    ],
  })
  typed.picker.handleInput('b')
  typed.picker.handleInput('1')
  assert.deepEqual(typed.selected, [], 'digits are query text once typing starts')
  assert.match(text(typed.picker), /Search b1/)
})

test('navigation keys still move the filtered rows while searching', () => {
  const now = Date.now()
  const p = makePicker({
    items: [
      { id: 'alpha', title: 'Alpha session', cwd: DIRECTORY, createdAt: now },
      { id: 'beta', title: 'Beta session', cwd: DIRECTORY, createdAt: now - 1000 },
    ],
  })
  for (const char of 'session') p.picker.handleInput(char)
  assert.match(text(p.picker), /Alpha session/)
  assert.match(text(p.picker), /Beta session/)
  const start = selectedLine(p.picker)
  p.picker.handleInput(KEY.down)
  const moved = selectedLine(p.picker)
  assert.notEqual(moved, start, 'Down moves the selection while searching')
  p.picker.handleInput(KEY.ctrlP)
  assert.equal(selectedLine(p.picker), start, 'Ctrl+P moves it back')
  p.picker.handleInput(KEY.end)
  assert.match(selectedLine(p.picker), /2\./, 'End selects the last filtered row')
  p.picker.handleInput(KEY.ctrlN)
  assert.match(selectedLine(p.picker), /1\./, 'next wraps inside the filtered list')
  p.picker.handleInput(KEY.pageDown)
  assert.match(selectedLine(p.picker), /2\./, 'PageDown pages within the filtered list')
  assert.deepEqual(p.selected, [])
})

test('the selection stays on the same session across re-filters', () => {
  const now = Date.now()
  const p = makePicker({
    items: [
      { id: 'alpha', title: 'Alpha session', cwd: DIRECTORY, createdAt: now },
      { id: 'beta', title: 'Beta session', cwd: DIRECTORY, createdAt: now - 1000 },
    ],
  })
  p.picker.handleInput(KEY.down)
  assert.match(selectedLine(p.picker), /Beta session/)
  for (const char of 'session') p.picker.handleInput(char)
  assert.match(selectedLine(p.picker), /Beta session/, 'the same session id stays selected')
  for (let index = 0; index < 7; index += 1) p.picker.handleInput(KEY.backspace)
  assert.match(selectedLine(p.picker), /Beta session/, 'and it survives the query being cleared')
})

test('interrupt routing follows the shared keymap and the onInterrupt hook', () => {
  const items: Item[] = [{ id: 'a', title: 'A session', cwd: DIRECTORY, createdAt: Date.now() }]
  const hooked = makePicker({ items, onInterrupt: true })
  hooked.picker.handleInput(KEY.ctrlC)
  assert.equal(hooked.interrupted, 1)
  assert.equal(hooked.cancelled, 0, 'global interrupt never becomes a local cancel')
  assert.deepEqual(hooked.selected, [])

  const fallback = makePicker({ items })
  fallback.picker.handleInput(KEY.ctrlC)
  assert.equal(fallback.cancelled, 1, 'without a hook Ctrl+C cancels like SelectDialog')

  // A remapped interrupt key is respected: Ctrl+C then falls through to
  // list.cancel instead of the interrupt hook.
  const remapped = makePicker({ items, keymap: keymap({ 'app.interrupt': 'alt+x' }), onInterrupt: true })
  remapped.picker.handleInput(KEY.ctrlC)
  assert.equal(remapped.interrupted, 0)
  assert.equal(remapped.cancelled, 1)
})

test('empty states are scope-aware and query-aware', () => {
  const elsewhere = makePicker({
    items: [{ id: 'other', title: 'Other session', cwd: OTHER, createdAt: Date.now() }],
  })
  assert.match(text(elsewhere.picker), /No sessions in current folder\. Press Tab to view all\./)
  elsewhere.picker.handleInput(KEY.tab)
  assert.match(text(elsewhere.picker), /Other session/)

  const empty = makePicker({ items: [] })
  assert.match(text(empty.picker), /No sessions in current folder\. Press Tab to view all\./)
  empty.picker.handleInput(KEY.tab)
  assert.match(text(empty.picker), /No sessions found/)

  const unmatched = makePicker({
    items: [{ id: 'a', title: 'Alpha session', cwd: DIRECTORY, createdAt: Date.now() }],
  })
  for (const char of 'zzz') unmatched.picker.handleInput(char)
  assert.match(text(unmatched.picker), /No sessions matching 'zzz'/)
  unmatched.picker.handleInput(KEY.enter)
  assert.deepEqual(unmatched.selected, [], 'an empty filtered list never selects')
  for (const width of [4, 12, 40]) assertWidths(unmatched.picker, width)
})

test('narrow widths stay readable and never leak ANSI', () => {
  const now = Date.now()
  const p = makePicker({
    items: [
      // Same raw-$HOME spelling as above: the row geometry must depend on the
      // shortened `~/…` label, never on how the host spells `$HOME`.
      { id: 'long', title: 'A very long session title that needs truncating', cwd: `${homedir()}/work/a-rather-long-folder-name`, createdAt: now - minutes(4), live: true },
      { id: 'short', title: 'Short', cwd: DIRECTORY, createdAt: now - 9 * 60 * minutes(1) },
    ],
  })
  p.picker.handleInput(KEY.tab)
  for (const width of [4, 6, 10, 20, 40, 80, 120]) assertWidths(p.picker, width)
  const at40 = p.picker.render(40).map(stripTerminalSequences).join('\n')
  assert.match(at40, /A very long session title that.*…/, 'the title truncates with an ellipsis')
  const wide = p.picker.render(120).map(stripTerminalSequences).join('\n')
  assert.match(wide, /open elsewhere/, 'the right column survives when it fits')
  assert.match(wide, /~\/work\/a-rather-long-folder-name/, 'and carries the shortened cwd in all scope')
  const at4 = p.picker.render(4).map(stripTerminalSequences)
  assert.ok(at4.some(line => line.length > 0), 'extreme widths still render something usable')
})

test('focus is propagated to the query field', () => {
  const p = makePicker({ items: [{ id: 'a', title: 'A session', cwd: DIRECTORY, createdAt: Date.now() }] })
  assert.equal(p.picker.focused, false)
  assert.ok(!p.picker.render(60).join('\n').includes(CURSOR_MARKER), 'no caret while unfocused')
  p.picker.focused = true
  assert.equal(p.picker.focused, true)
  const searchRow = p.picker.render(60)[1] ?? ''
  assert.ok(searchRow.includes(CURSOR_MARKER), 'the query field shows the caret when focused')
  p.picker.focused = false
  assert.ok(!p.picker.render(60).join('\n').includes(CURSOR_MARKER))
})

test('invalidate is safe and row windowing reports hidden rows', () => {
  const now = Date.now()
  const items: Item[] = Array.from({ length: 8 }, (_, index) => ({
    id: `s${index}`,
    title: `Session ${index}`,
    cwd: DIRECTORY,
    createdAt: now - index * 1000,
  }))
  const p = makePicker({ items, rows: 18 }) // rowBudget = max(4, 18 - 14) = 4
  p.picker.invalidate()
  p.picker.invalidate()
  const rendered = text(p.picker)
  assert.match(rendered, /\(1\/8\)/, 'hidden rows are reported')
  assert.match(rendered, /Session 0/)
  assert.doesNotMatch(rendered, /Session 7/)
  p.picker.handleInput(KEY.end)
  const after = text(p.picker)
  assert.match(after, /Session 7/, 'list.last scrolls the window to the selection')
  assert.match(after, /\(8\/8\)/)
  for (const width of [4, 40]) assertWidths(p.picker, width)
})
test('runs against a real VirtualTerminal-backed TUI', async () => {
  const { TuiMainScreen } = await import('#pi-tui')
  const { VirtualTerminal } = await import('./helpers/terminal.ts')
  const terminal = new VirtualTerminal(80, 30)
  const picked: string[] = []
  const picker: Picker = new SessionPickerDialog(new TuiMainScreen(terminal), {
    sessions: [
      { id: 'vt-a', title: 'Alpha session', cwd: DIRECTORY, createdAt: Date.now() - minutes(3) },
      { id: 'vt-b', title: 'Beta session', cwd: OTHER, createdAt: Date.now() - minutes(30) },
    ],
    directory: DIRECTORY,
    onSelect: id => { picked.push(id) },
    onCancel: () => { picked.push('cancel') },
  })
  picker.focused = true
  assert.match(text(picker), /Resume session \(Current Folder\)/)
  assert.match(text(picker), /Alpha session/)
  assert.doesNotMatch(text(picker), /Beta session/)
  picker.handleInput(KEY.tab)
  assert.match(text(picker), /Beta session/)
  picker.handleInput(KEY.down)
  picker.handleInput(KEY.enter)
  assert.deepEqual(picked, ['vt-b'])
  terminal.dispose()
})

// --- two-phase data flow: loading → headers → streamed titles -----------------

test('phase-1 loading renders immediately and stays dismissable', () => {
  const p = makePicker({ loading: true })
  const rendered = text(p.picker)
  assert.match(rendered, /Resume session \(Current Folder\)/)
  assert.match(rendered, /Current Folder \| All/)
  assert.match(rendered, /Search/)
  assert.match(rendered, /Loading sessions…/)
  assert.match(rendered, /Tab folder\/all · Enter select · Esc cancel · type to search/)
  assert.deepEqual(p.visibleIds, [], 'nothing is listed yet, so no title fetch is requested')
  for (const width of [4, 8, 12, 40, 80, 120]) assertWidths(p.picker, width)
  assert.match(text(p.picker, 12), /Loading/, 'the loading row truncates like every other line')
  p.picker.handleInput(KEY.escape)
  assert.equal(p.cancelled, 1, 'Esc cancels during loading')

  // Scope, navigation and interrupt keep working with no rows at all.
  const other = makePicker({ loading: true })
  other.picker.handleInput(KEY.tab)
  assert.match(text(other.picker), /Resume session \(All\)/)
  assert.match(text(other.picker), /Loading sessions…/)
  other.picker.handleInput(KEY.enter)
  other.picker.handleInput(KEY.down)
  other.picker.handleInput('abc')
  assert.deepEqual(other.selected, [], 'there is nothing to select yet')
  other.picker.handleInput(KEY.ctrlC)
  assert.equal(other.cancelled, 1, 'interrupt routing works during loading')

  // Loading that ends with zero sessions falls back to the per-scope hints.
  const ended = makePicker({ loading: true })
  ended.picker.setLoading(false)
  assert.doesNotMatch(text(ended.picker), /Loading sessions/)
  assert.match(text(ended.picker), /No sessions in current folder\. Press Tab to view all\./)
  ended.picker.handleInput(KEY.tab)
  assert.match(text(ended.picker), /No sessions found/)
})

test('setSessions replaces the listing, ends loading and follows the selection by id', () => {
  const now = Date.now()
  const p = makePicker({ loading: true })
  p.picker.setSessions([
    { id: 'alpha', title: 'Alpha session', cwd: DIRECTORY, createdAt: now },
    { id: 'beta', title: 'Beta session', cwd: DIRECTORY, createdAt: now - minutes(1) },
  ])
  const rendered = text(p.picker)
  assert.doesNotMatch(rendered, /Loading sessions…/, 'the headers end the loading state')
  assert.match(rendered, /Alpha session/)
  assert.deepEqual(p.visibleIds, [['alpha', 'beta']], 'the first window is reported when headers land')

  p.picker.handleInput(KEY.down)
  assert.match(selectedLine(p.picker), /Beta session/)
  // A replacement listing (native newest-first) keeps the selected id even
  // when its row moves.
  p.picker.setSessions([
    { id: 'gamma', title: 'Gamma session', cwd: DIRECTORY, createdAt: now + 60_000 },
    { id: 'alpha', title: 'Alpha session', cwd: DIRECTORY, createdAt: now },
    { id: 'beta', title: 'Beta session', cwd: DIRECTORY, createdAt: now - minutes(1) },
  ])
  assert.match(selectedLine(p.picker), /Beta session/, 'the selected id survives the replacement')
  assert.deepEqual(p.visibleIds.at(-1), ['gamma', 'alpha', 'beta'])

  // A vanished selection falls back to the first row, not to the old index.
  p.picker.setSessions([
    { id: 'xray', title: 'Xray session', cwd: DIRECTORY, createdAt: now },
    { id: 'yankee', title: 'Yankee session', cwd: DIRECTORY, createdAt: now - 1000 },
  ])
  assert.match(selectedLine(p.picker), /Xray session/, 'a vanished session falls back to the first row')

  // Loading that ends with an empty listing shows the scope hint, not a row.
  const emptyHeaders = makePicker({ loading: true })
  emptyHeaders.picker.setSessions([])
  assert.doesNotMatch(text(emptyHeaders.picker), /Loading sessions/)
  assert.match(text(emptyHeaders.picker), /No sessions in current folder\. Press Tab to view all\./)
})

test('streamed titles fill rows and the fuzzy search', () => {
  const now = Date.now()
  const p = makePicker({
    items: [
      { id: 'alpha', cwd: DIRECTORY, createdAt: now },
      { id: 'beta', title: 'Native beta', cwd: DIRECTORY, createdAt: now - minutes(1) },
    ],
  })
  const before = text(p.picker)
  assert.match(before, /\(untitled\)/)
  assert.match(before, /Native beta/)

  p.picker.setTitles(new Map<string, string | null>([['alpha', 'Streamed alpha'], ['beta', null]]))
  const after = text(p.picker)
  assert.match(after, /Streamed alpha/, 'a streamed title replaces the untitled row')
  assert.match(after, /\(untitled\)/, 'a confirmed none renders untitled')
  assert.doesNotMatch(after, /Native beta/, 'a confirmed none replaces the DTO title')

  // The overlay is searchable text too.
  for (const char of 'streamed') p.picker.handleInput(char)
  assert.match(text(p.picker), /Streamed alpha/)
  assert.doesNotMatch(text(p.picker), /\(untitled\)/)
  for (let index = 0; index < 8; index += 1) p.picker.handleInput(KEY.backspace)

  // A title that arrives while a query is active re-filters immediately.
  const late = makePicker({ items: [{ id: 'alpha', cwd: DIRECTORY, createdAt: now }] })
  for (const char of 'streamed') late.picker.handleInput(char)
  assert.match(text(late.picker), /No sessions matching 'streamed'/)
  const fires = late.visibleIds.length
  late.picker.setTitles(new Map<string, string | null>([['alpha', 'Streamed alpha']]))
  assert.match(text(late.picker), /Streamed alpha/, 'a streamed title re-filters an active query')
  assert.equal(late.visibleIds.length, fires + 1, 'the newly matching row is reported')
  assert.deepEqual(late.visibleIds.at(-1), ['alpha'])

  // Title arrival never moves the selection off its session.
  const keep = makePicker({
    items: [
      { id: 'alpha', cwd: DIRECTORY, createdAt: now },
      { id: 'beta', cwd: DIRECTORY, createdAt: now - minutes(1) },
    ],
  })
  keep.picker.handleInput(KEY.down)
  keep.picker.setTitles(new Map<string, string | null>([['alpha', 'Streamed alpha'], ['beta', 'Streamed beta']]))
  assert.match(selectedLine(keep.picker), /Streamed beta/, 'the selection survives a title merge')
})

test('onVisibleIds follows the row window and never repeats a consecutive set', () => {
  const now = Date.now()
  const p = makePicker({
    items: [
      { id: 'a', title: 'Alpha session', cwd: DIRECTORY, createdAt: now },
      { id: 'b', title: 'Beta session', cwd: DIRECTORY, createdAt: now - 1000 },
      { id: 'c', title: 'Gamma session', cwd: OTHER, createdAt: now - 2000 },
    ],
  })
  assert.deepEqual(p.visibleIds, [['a', 'b']], 'construction reports the current-folder window')
  // Keys that cannot change the window do not re-report it.
  p.picker.handleInput(KEY.up)
  p.picker.handleInput(KEY.down)
  assert.equal(p.visibleIds.length, 1, 'unchanged windows are not re-reported')

  p.picker.handleInput(KEY.tab)
  assert.deepEqual(p.visibleIds.at(-1), ['a', 'b', 'c'], 'a scope toggle reports the widened window')

  for (const char of 'gamma') p.picker.handleInput(char)
  assert.deepEqual(p.visibleIds.at(-1), ['c'], 'a query edit reports the filtered window')
  for (let index = 0; index < 5; index += 1) p.picker.handleInput(KEY.backspace)
  assert.deepEqual(p.visibleIds.at(-1), ['a', 'b', 'c'])
  p.picker.handleInput(KEY.tab)
  assert.deepEqual(p.visibleIds.at(-1), ['a', 'b'], 'toggling back narrows the window again')

  // A streamed title that makes another row match the active query re-reports.
  const titled = makePicker({
    items: [
      { id: 'x', title: 'Beta one', cwd: DIRECTORY, createdAt: now },
      { id: 'y', title: 'Alpha two', cwd: DIRECTORY, createdAt: now - 1000 },
    ],
  })
  for (const char of 'beta') titled.picker.handleInput(char)
  assert.deepEqual(titled.visibleIds, [['x', 'y'], ['x']])
  titled.picker.setTitles(new Map<string, string | null>([['y', 'Beta copy']]))
  assert.equal(titled.visibleIds.length, 3, 'the setTitles re-filter is reported once')
  assert.deepEqual([...(titled.visibleIds.at(-1) ?? [])].sort(), ['x', 'y'])

  // Window shifts past the row budget report only the painted rows.
  const tall: Item[] = Array.from({ length: 8 }, (_, index) => ({
    id: `s${index}`,
    title: `Session ${index}`,
    cwd: DIRECTORY,
    createdAt: now - index * 1000,
  }))
  const windowed = makePicker({ items: tall, rows: 18 }) // rowBudget = max(4, 18 - 14) = 4
  assert.deepEqual(windowed.visibleIds, [['s0', 's1', 's2', 's3']])
  windowed.picker.handleInput(KEY.end)
  assert.deepEqual(windowed.visibleIds.at(-1), ['s4', 's5', 's6', 's7'], 'a window shift is reported')
  assert.equal(windowed.visibleIds.length, 2)
  // The reported ids are exactly the rows the renderer paints.
  const painted = windowed.picker.render(80)
    .map(stripTerminalSequences)
    .map(line => /Session (\d+)/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined)
  assert.deepEqual(painted.map(value => `s${value}`), windowed.visibleIds.at(-1))
})

test('setSessions is safe to repeat and respects an active query', () => {
  const now = Date.now()
  const items: Item[] = [
    { id: 'alpha', title: 'Alpha session', cwd: DIRECTORY, createdAt: now },
    { id: 'beta', title: 'Beta session', cwd: DIRECTORY, createdAt: now - 1000 },
  ]
  const p = makePicker({ items })
  for (const char of 'beta') p.picker.handleInput(char)
  assert.deepEqual(p.visibleIds.at(-1), ['beta'])

  p.picker.setSessions(items)
  assert.match(text(p.picker), /Search beta/, 'the query survives a repeated listing')
  assert.match(text(p.picker), /Beta session/)
  assert.doesNotMatch(text(p.picker), /Alpha session/)

  const fires = p.visibleIds.length
  p.picker.setSessions(items)
  assert.equal(p.visibleIds.length, fires, 'an identical listing does not re-report the window')

  p.picker.setSessions([...items, { id: 'gamma', title: 'Gamma beta clone', cwd: DIRECTORY, createdAt: now - 2000 }])
  assert.match(text(p.picker), /Gamma beta clone/, 'new headers are filtered by the same query')
  assert.deepEqual([...(p.visibleIds.at(-1) ?? [])].sort(), ['beta', 'gamma'])

  p.picker.setSessions([])
  assert.match(text(p.picker), /No sessions matching 'beta'/)
  p.picker.setSessions(items)
  assert.match(text(p.picker), /Beta session/, 'the query still applies after an empty listing')
})
