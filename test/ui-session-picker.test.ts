import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from '#pi-tui'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'

// Real input subsystem (vendored Pi TUI + CC seam); the picker is loaded after
// it so the shared keymap and the single Input state come from the same build.
const input = await loadInputModule()
const { SessionPickerDialog } = await import('../src/ui/session-picker.ts')

// Fixtures list sessions exactly as the `sessions` DTO listing arrives: already
// ordered by DSH/its bridge (newest first), which the picker consumes verbatim.
// Nothing below may be re-sorted locally, so every fixture is written in that
// native order on purpose.

type CcKeymap = InstanceType<typeof input.CcKeymap>
type Picker = InstanceType<typeof SessionPickerDialog>

interface Item {
  id: string
  // `null` is a native confirmation of no title; omitted is not-yet-known.
  title?: string | null
  cwd: string
  createdAt?: number
  live?: boolean
}

const DIRECTORY = '/work/alpha'
const OTHER = '/work/beta'

const KEY = {
  tab: '\t', // now inert: the scope toggle is the registry action on Ctrl+A
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
  ctrlA: '\x01',
  ctrlF: '\x06',
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

/** The one row carrying the selection cursor (frame borders stripped). */
function selectedLine(picker: Picker, width = 80): string {
  const line = picker.render(width).map(stripTerminalSequences).find(candidate => candidate.includes('❯'))
  return line ?? ''
}

/** Plain rendered text of the frame body rows (no borders, no chrome). */
function bodyText(picker: Picker, width = 80): string {
  return text(picker, width)
    .split('\n')
    .map(line => line.replace(/^│\s?/, '').replace(/\s*│$/, ''))
    .join('\n')
}

function assertWidths(picker: Picker, width: number): void {
  for (const line of picker.render(width)) {
    assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`)
    const plain = stripTerminalSequences(line)
    assert.ok(!plain.includes('\x1b'), `dangling escape at width ${width}: ${JSON.stringify(line)}`)
    // A truncation must never cut a CSI sequence in half (bracketed chips such
    // as `[c…]` are plain text, not escape state).
    assert.ok(!/\u001b\[[0-9;?]*$/.test(line), `truncated sequence at width ${width}: ${JSON.stringify(line)}`)
  }
}

const minutes = (value: number): number => value * 60_000

/** Assert these labels are painted in the given top-to-bottom order. */
function assertOrder(rendered: string, labels: readonly string[]): void {
  let at = -1
  for (const label of labels) {
    const next = rendered.indexOf(label, at + 1)
    assert.ok(next > at, `${label} must be painted after the previous row:\n${rendered}`)
    at = next
  }
}

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
  assert.match(rendered, /Resume session/, 'the frame title names the surface, not the scope')
  assert.match(rendered, /Current Folder \| All/, 'the scope segment states the active scope')
  assert.match(rendered, /Search/)
  assert.match(rendered, /1\. Alpha session/)
  assert.match(rendered, /2\. Beta session/)
  assert.match(rendered, /5m ago/)
  assert.match(rendered, /3h ago/)
  // Real registry bindings, never a hardcoded Tab or prose key.
  assert.match(rendered, /\[ctrl\+a All folders\]/)
  assert.match(rendered, /\[enter Resume\]/)
  assert.match(rendered, /\[escape Cancel\]/)
  // Frame order: top border, scope segment, search field, rows.
  const lines = p.picker.render(80).map(stripTerminalSequences)
  assert.match(lines[0] ?? '', /^┌─ Resume session/)
  assert.match(lines[1] ?? '', /Current Folder \| All/)
  assert.match(lines[2] ?? '', /Search/)
  assert.ok(lines.some(line => /Alpha session/.test(line)), 'the first row is painted inside the body')
  assert.ok(lines.indexOf(lines.find(line => /Alpha session/.test(line)) ?? '') > 3, 'rows follow the chrome rule')
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

  p.picker.handleInput(KEY.ctrlA)
  const all = text(p.picker)
  assert.match(all, /Resume session/)
  assert.match(all, /Current Folder \| All/)
  assert.match(all, /all folders/)
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
    p.picker.handleInput(KEY.ctrlA)
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

// --- ordering policy: DSH owns the order, the picker never re-derives it ------
// DSH owns durable sessions. A TUI-local `stat` of a session artifact's mtime, a
// locally sorted copy of the listing or a newest-session auto-selection would be
// a second durability truth, so all three stay absent. These tests pin that the
// *listing* order — not the display stamp, not relevance, not recency
// heuristics — decides where a row is painted.

test('the listing order wins over the display stamp: no recency re-sort, no auto-selection', () => {
  const now = Date.now()
  // Deliberately adversarial: the stamps ASCEND while the listing descends, so
  // any local sort by the age column (or by a stat-derived mtime) would flip
  // the rows and change the default selection.
  const p = makePicker({
    items: [
      { id: 'listed-first', title: 'Listed first session', cwd: DIRECTORY, createdAt: now - 5 * 24 * 60 * minutes(1) },
      { id: 'listed-second', title: 'Listed second session', cwd: DIRECTORY, createdAt: now - 90 * minutes(1) },
      { id: 'listed-third', title: 'Listed third session', cwd: DIRECTORY, createdAt: now },
    ],
  })
  const rendered = text(p.picker)
  assertOrder(rendered, ['Listed first session', 'Listed second session', 'Listed third session'])
  assert.match(rendered, /1\. Listed first session/, 'numbering follows the listing, not the stamp')
  assert.match(rendered, /3\. Listed third session/)
  // The stamp is still painted honestly — it just never orders anything.
  assert.match(rendered, /5d ago/)
  assert.match(rendered, /just now/)
  // No newest-session auto-selection: the first row the caller listed is the
  // one Enter resumes, even though it carries the oldest stamp.
  assert.match(selectedLine(p.picker), /Listed first session/, 'the first listed row starts selected')
  p.picker.handleInput(KEY.enter)
  assert.deepEqual(p.selected, ['listed-first'], 'Enter resumes the listed-first session, never a newest guess')

  // The same listing arriving through the two-phase header path keeps its order.
  const late = makePicker({ loading: true })
  late.picker.setSessions([
    { id: 'header-a', title: 'Header A session', cwd: DIRECTORY, createdAt: now - 9 * 24 * 60 * minutes(1) },
    { id: 'header-b', title: 'Header B session', cwd: DIRECTORY, createdAt: now },
  ])
  const lateRendered = text(late.picker)
  assertOrder(lateRendered, ['Header A session', 'Header B session'])
  assert.match(selectedLine(late.picker), /Header A session/, 'late headers keep their listed order and first pick')
  assert.deepEqual(late.visibleIds.at(-1), ['header-a', 'header-b'], 'the lazy-title window follows the listing order')
})

test('scope toggle and search only filter rows: the native order is restored exactly', () => {
  const now = Date.now()
  const natives = [
    { id: 'n1', title: 'Alpha session one', cwd: DIRECTORY, createdAt: now },
    { id: 'n2', title: 'Beta session two', cwd: OTHER, createdAt: now - minutes(1) },
    { id: 'n3', title: 'Gamma session three', cwd: DIRECTORY, createdAt: now - minutes(2) },
    { id: 'n4', title: 'Delta session four', cwd: OTHER, createdAt: now - minutes(3) },
    { id: 'n5', title: 'Epsilon session five', cwd: DIRECTORY, createdAt: now - minutes(4) },
  ]
  const p = makePicker({ items: natives })

  // Current folder: the native subsequence, in native relative order.
  assertOrder(text(p.picker), ['Alpha session one', 'Gamma session three', 'Epsilon session five'])

  // All folders: the complete listing, still in native order.
  p.picker.handleInput(KEY.ctrlA)
  const all = text(p.picker)
  assertOrder(all, natives.map(item => item.title))
  assert.match(all, /1\. Alpha session one/)
  assert.match(all, /5\. Epsilon session five/)

  // An active query may rank matches by relevance (that is the one allowed
  // re-order) but it can never invent a row or drop a match.
  for (const char of 'session') p.picker.handleInput(char)
  const searched = text(p.picker)
  for (const item of natives) assert.match(searched, new RegExp(item.title), 'search keeps every match')
  assert.match(searched, /5 of 5 sessions/)
  assert.doesNotMatch(searched, /No sessions/, 'no phantom empty state')

  // Dropping the query restores the exact native order again.
  for (let index = 0; index < 'session'.length; index += 1) p.picker.handleInput(KEY.backspace)
  assertOrder(text(p.picker), natives.map(item => item.title))

  // Narrowing back to the current folder restores the native subsequence, with
  // the selection still pinned to the same session id.
  p.picker.handleInput(KEY.escape)
  p.picker.handleInput(KEY.ctrlA)
  const narrowed = text(p.picker)
  assertOrder(narrowed, ['Alpha session one', 'Gamma session three', 'Epsilon session five'])
  assert.doesNotMatch(narrowed, /Beta session two/, 'the other folder is filtered out again')
  assert.match(selectedLine(p.picker), /Alpha session one/, 'the selection follows the id across the toggle')

  // A repeated native listing (identical order) is not re-sorted either.
  p.picker.setSessions(natives)
  p.picker.handleInput(KEY.ctrlA)
  assertOrder(text(p.picker), natives.map(item => item.title))
})

test('streamed titles never re-order the rows they enrich', () => {
  const now = Date.now()
  const p = makePicker({
    items: [
      { id: 't1', cwd: DIRECTORY, createdAt: now },
      { id: 't2', title: 'Zulu native', cwd: DIRECTORY, createdAt: now - minutes(1) },
      { id: 't3', cwd: DIRECTORY, createdAt: now - minutes(2) },
    ],
  })
  const before = text(p.picker)
  // An omitted title is not yet known (the header may still be enriched); it
  // is not a native confirmation that the session has none.
  assert.match(before, /1\. \(title unknown\)/)
  assertOrder(before, ['(title unknown)', 'Zulu native'])

  // A title that sorts "late" by text must stay where its session was listed.
  p.picker.setTitles(new Map<string, string | null>([['t1', 'Aaa streamed'], ['t3', 'Mmm streamed']]))
  const after = text(p.picker)
  assertOrder(after, ['Aaa streamed', 'Zulu native', 'Mmm streamed'])
  assert.match(after, /1\. Aaa streamed/, 'the enriched row keeps its listed number')
  assert.match(after, /3\. Mmm streamed/)
  assert.match(selectedLine(p.picker), /Aaa streamed/, 'the selection stays on the first listed session')
  assert.deepEqual(p.visibleIds.at(-1), ['t1', 't2', 't3'], 'the title window follows the listing order')
})

test('the picker never reads a session artifact and never sorts the listing', () => {
  // Source-level guard for the ordering policy: DSH owns durable sessions, so
  // this module must not stat/read a session file (a TUI-owned mtime recency
  // policy) and must not re-sort the incoming listing. Relevance ordering is
  // Pi's `fuzzyFilter`, which is a query, not a durability policy.
  const source = readFileSync(fileURLToPath(new URL('../src/ui/session-picker.ts', import.meta.url)), 'utf8')
  assert.doesNotMatch(source, /from 'node:fs'|node:fs\/promises/, 'no filesystem access in the picker')
  assert.doesNotMatch(source, /\bstat(Sync)?\(/, 'no artifact stat (mtime recency) in the picker')
  assert.doesNotMatch(source, /\b(readFile|readFileSync|readdir|readdirSync|createReadStream)\s*\(/, 'no session-file reads')
  assert.doesNotMatch(source, /\.mtime\b/, 'no mtime-derived ordering')
  assert.doesNotMatch(source, /\.sort\s*\(/, 'the native listing order is never re-sorted')
  assert.match(source, /fuzzyFilter/, 'relevance filtering goes through the shared Pi helper')
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
  assert.match(rendered, /2\. \(title unknown\)/, 'an omitted title is unknown, not confirmed-none')
  assert.match(rendered, /3\. \(untitled\)/, 'a known blank title renders untitled')
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
  p.picker.handleInput(KEY.ctrlA) // all scope: every session is a candidate
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
  all.picker.handleInput(KEY.ctrlA)
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

test('Esc cancels the picker in browse and leaves the search field first while typing', () => {
  const plain = makePicker({ items: [{ id: 'a', title: 'A session', cwd: DIRECTORY, createdAt: Date.now() }] })
  plain.picker.handleInput(KEY.escape)
  assert.equal(plain.cancelled, 1, 'browse Esc closes the picker')
  assert.deepEqual(plain.selected, [])

  const searching = makePicker({ items: [{ id: 'a', title: 'A session', cwd: DIRECTORY, createdAt: Date.now() }] })
  searching.picker.handleInput('a')
  assert.equal(searching.cancelled, 0, 'typing does not cancel')
  assert.match(text(searching.picker), /esc leaves search/)
  assert.match(text(searching.picker), /Search a/)
  // The field is the focused local layer: Esc leaves and clears it, and the
  // native listing is untouched.
  searching.picker.handleInput(KEY.escape)
  assert.equal(searching.cancelled, 0, 'Esc in the field cancels the search layer, not the surface')
  assert.doesNotMatch(text(searching.picker), /Search a/, 'the query is cleared')
  assert.match(text(searching.picker), /A session/, 'every session is listed again')
  // The next Esc (browse layer) closes it.
  searching.picker.handleInput(KEY.escape)
  assert.equal(searching.cancelled, 1)
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

test('browse keys navigate the list; the search field keeps readline semantics', () => {
  const now = Date.now()
  const p = makePicker({
    items: [
      { id: 'alpha', title: 'Alpha session', cwd: DIRECTORY, createdAt: now },
      { id: 'beta', title: 'Beta session', cwd: DIRECTORY, createdAt: now - 1000 },
    ],
  })
  // Browse layer: the list actions move the selection.
  const start = selectedLine(p.picker)
  p.picker.handleInput(KEY.down)
  assert.notEqual(selectedLine(p.picker), start, 'browse Down moves the selection')
  p.picker.handleInput(KEY.ctrlP)
  assert.equal(selectedLine(p.picker), start, 'browse Ctrl+P moves it back')
  p.picker.handleInput(KEY.end)
  assert.match(selectedLine(p.picker), /2\./, 'browse End selects the last row')
  p.picker.handleInput(KEY.ctrlN)
  assert.match(selectedLine(p.picker), /1\./, 'browse next wraps inside the list')
  p.picker.handleInput(KEY.pageDown)
  assert.match(selectedLine(p.picker), /2\./, 'browse PageDown pages the list')

  // Search layer: the one CC field owns the keyboard. Down/Ctrl+P edit text
  // instead of moving the list, and Ctrl+A is readline line-start (it must not
  // toggle the scope); PageDown still pages the modal list.
  for (const char of 'session') p.picker.handleInput(char)
  const whileTyping = selectedLine(p.picker)
  p.picker.handleInput(KEY.down)
  assert.equal(selectedLine(p.picker), whileTyping, 'Down is editor input while the field owns text')
  p.picker.handleInput(KEY.ctrlP)
  assert.equal(selectedLine(p.picker), whileTyping, 'Ctrl+P is editor history input in the field')
  assert.match(text(p.picker), /current folder/, 'Ctrl+A did not toggle the scope')
  p.picker.handleInput(KEY.ctrlA)
  assert.match(text(p.picker), /current folder/, 'Ctrl+A stays readline line-start in the field')
  p.picker.handleInput(KEY.ctrlF)
  assert.match(text(p.picker), /Search session/, 'Ctrl+F stays editor char-right, not modal.search')
  p.picker.handleInput(KEY.pageDown)
  assert.notEqual(selectedLine(p.picker), whileTyping, 'PageDown still pages the modal list')
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
  assert.match(text(elsewhere.picker), /No sessions in current folder\. Switch scope to view all\./)
  elsewhere.picker.handleInput(KEY.ctrlA)
  assert.match(text(elsewhere.picker), /Other session/)

  const empty = makePicker({ items: [] })
  assert.match(text(empty.picker), /No sessions in current folder\. Switch scope to view all\./)
  empty.picker.handleInput(KEY.ctrlA)
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
  p.picker.handleInput(KEY.ctrlA)
  for (const width of [4, 6, 10, 20, 40, 80, 120]) assertWidths(p.picker, width)
  const at40 = p.picker.render(40).map(stripTerminalSequences).join('\n')
  assert.match(at40, /A very long session title that.*…/, 'the title truncates with an ellipsis')
  const wide = p.picker.render(120).map(stripTerminalSequences).join('\n')
  assert.match(wide, /open elsewhere/, 'the right column survives when it fits')
  assert.match(wide, /~\/work\/a-rather-long-folder-name/, 'and carries the shortened cwd in all scope')
  const at4 = p.picker.render(4).map(stripTerminalSequences)
  assert.ok(at4.some(line => line.length > 0), 'extreme widths still render something usable')
})

test('the query field takes the caret only in the search layer', () => {
  const p = makePicker({ items: [{ id: 'a', title: 'A session', cwd: DIRECTORY, createdAt: Date.now() }] })
  assert.equal(p.picker.focused, false)
  assert.ok(!p.picker.render(60).join('\n').includes(CURSOR_MARKER), 'no caret while unfocused')
  p.picker.focused = true
  assert.equal(p.picker.focused, true)
  // Browse layer: focus is the surface's, not the text field's.
  assert.ok(!p.picker.render(60).join('\n').includes(CURSOR_MARKER), 'browse mode paints no caret')
  p.picker.handleInput('a')
  assert.ok(p.picker.render(60).join('\n').includes(CURSOR_MARKER), 'the field shows the caret once it owns typing')
  p.picker.focused = false
  assert.ok(!p.picker.render(60).join('\n').includes(CURSOR_MARKER), 'losing focus hides the caret')
})

test('invalidate is safe and row windowing reports hidden rows', () => {
  const now = Date.now()
  const items: Item[] = Array.from({ length: 8 }, (_, index) => ({
    id: `s${index}`,
    title: `Session ${index}`,
    cwd: DIRECTORY,
    createdAt: now - index * 1000,
  }))
  const p = makePicker({ items, rows: 18 })
  p.picker.invalidate()
  p.picker.invalidate()
  const rendered = text(p.picker)
  assert.match(rendered, /1\/8/, 'hidden rows are reported honestly')
  assert.match(rendered, /Session 0/)
  assert.doesNotMatch(rendered, /Session 7/, 'rows outside the measured body are not painted')
  p.picker.handleInput(KEY.end)
  const after = text(p.picker)
  assert.match(after, /Session 7/, 'list.last scrolls the window to the selection')
  assert.match(after, /8\/8/, 'the status line follows the selection')
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
  assert.match(text(picker), /Resume session/)
  assert.match(text(picker), /Alpha session/)
  assert.doesNotMatch(text(picker), /Beta session/)
  picker.handleInput(KEY.ctrlA)
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
  assert.match(rendered, /Resume session/)
  assert.match(rendered, /Current Folder \| All/)
  assert.match(rendered, /Search/)
  assert.match(rendered, /Loading sessions…/)
  assert.match(rendered, /\[ctrl\+a All folders\]/)
  assert.match(rendered, /\[enter Resume\]/)
  assert.match(rendered, /\[escape Cancel\]/)
  assert.ok(p.visibleIds.every(ids => ids.length === 0), 'nothing is listed yet, so no title fetch is requested')
  for (const width of [4, 8, 12, 40, 80, 120]) assertWidths(p.picker, width)
  assert.match(text(p.picker, 12), /Load/, 'the loading row truncates like every other line')
  p.picker.handleInput(KEY.escape)
  assert.equal(p.cancelled, 1, 'Esc cancels during loading')

  // Scope, navigation and interrupt keep working with no rows at all.
  const other = makePicker({ loading: true })
  other.picker.handleInput(KEY.ctrlA)
  assert.match(text(other.picker), /all folders/)
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
  assert.match(text(ended.picker), /No sessions in current folder\. Switch scope to view all\./)
  ended.picker.handleInput(KEY.ctrlA)
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
  assert.match(text(emptyHeaders.picker), /No sessions in current folder\. Switch scope to view all\./)
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
  assert.match(before, /\(title unknown\)/, 'an omitted title stays unknown until it arrives')
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

test('title states are distinct: native null, known blank, omitted and streamed', () => {
  const now = Date.now()
  const p = makePicker({
    items: [
      { id: 'known-null', title: null, cwd: DIRECTORY, createdAt: now },
      { id: 'known-blank', title: '   ', cwd: DIRECTORY, createdAt: now - minutes(1) },
      { id: 'omitted', cwd: DIRECTORY, createdAt: now - minutes(2) },
      { id: 'present', title: 'Present native title', cwd: DIRECTORY, createdAt: now - minutes(3) },
    ],
  })
  const initial = text(p.picker)
  assert.match(initial, /1\. \(untitled\)/, 'a native null title is a known none')
  assert.match(initial, /2\. \(untitled\)/, 'a known blank title is a known none')
  assert.match(initial, /3\. \(title unknown\)/, 'an omitted title is not-yet-known')
  assert.match(initial, /4\. Present native title/)
  assert.doesNotMatch(initial, /no title|service failed|unavailable|not found/i,
    'not-yet-known never claims a native no-title or a service failure')
  assert.doesNotMatch(initial, /3\. \(untitled\)/, 'unknown is never collapsed into confirmed-none')

  // The lazy native title stream may confirm none or fill a title later; the
  // native order and the selected row stay put.
  p.picker.setTitles(new Map<string, string | null>([['known-blank', null], ['omitted', 'Late streamed title']]))
  const enriched = text(p.picker)
  assert.match(enriched, /2\. \(untitled\)/, 'a confirmed none stays untitled')
  assert.match(enriched, /3\. Late streamed title/, 'an unknown row is enriched in place')
  assert.match(enriched, /4\. Present native title/)
  assert.ok(enriched.indexOf('(untitled)') < enriched.indexOf('Late streamed title'))
  assert.match(selectedLine(p.picker), /known-null|untitled/, 'selection stays on the first native row')

  // Filtering uses the effective title; explicit resume returns the exact id.
  for (const char of 'late') p.picker.handleInput(char)
  const filtered = text(p.picker)
  assert.match(filtered, /Late streamed title/)
  assert.doesNotMatch(filtered, /Present native title/)
  p.picker.handleInput(KEY.enter)
  assert.deepEqual(p.selected, ['omitted'], 'explicit resume returns the native session id')
  assert.equal(p.cancelled, 0)

  assertWidths(p.picker, 40)
  assertWidths(p.picker, 80)
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

  p.picker.handleInput(KEY.ctrlA)
  assert.deepEqual(p.visibleIds.at(-1), ['a', 'b', 'c'], 'a scope toggle reports the widened window')

  for (const char of 'gamma') p.picker.handleInput(char)
  assert.deepEqual(p.visibleIds.at(-1), ['c'], 'a query edit reports the filtered window')
  for (let index = 0; index < 5; index += 1) p.picker.handleInput(KEY.backspace)
  assert.deepEqual(p.visibleIds.at(-1), ['a', 'b', 'c'])
  // Ctrl+A in the field is readline line-start: leave the search layer first.
  p.picker.handleInput(KEY.escape)
  p.picker.handleInput(KEY.ctrlA)
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
  const windowed = makePicker({ items: tall, rows: 18 })
  // Construction reports the pessimistic default window; the first measured
  // frame replaces it with what the frame body can actually paint. No legacy
  // `rows - 14` line count is claimed here.
  windowed.picker.render(80)
  const firstWindow = windowed.visibleIds.at(-1) ?? []
  assert.ok(firstWindow.length > 0 && firstWindow.length < tall.length, 'shorter than the catalog')
  assert.deepEqual(firstWindow, Array.from({ length: firstWindow.length }, (_, index) => `s${index}`))
  const reports = windowed.visibleIds.length
  windowed.picker.render(80)
  assert.equal(windowed.visibleIds.length, reports, 'an unchanged window is never re-reported')
  windowed.picker.handleInput(KEY.end)
  const lastWindow = windowed.visibleIds.at(-1) ?? []
  assert.equal(lastWindow.at(-1), 's7', 'a window shift is reported with the last row')
  assert.notDeepEqual(lastWindow, firstWindow)
  assert.equal(windowed.visibleIds.length, reports + 1, 'exactly one report for the shift')
  // The reported ids are exactly the rows the renderer paints.
  const painted = windowed.picker.render(80)
    .map(stripTerminalSequences)
    .map(line => /Session (\d+)/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined)
  assert.deepEqual(painted.map(value => `s${value}`).sort(), [...(windowed.visibleIds.at(-1) ?? [])].sort())
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

// ---------------------------------------------------------------------------
// Field layering, mouse identity and frame closure

test('Ctrl+A and Ctrl+F keep their readline meaning whenever the field owns text', () => {
  const now = Date.now()
  const p = makePicker({
    items: [
      { id: 'alpha', title: 'Alpha session', cwd: DIRECTORY, createdAt: now },
      { id: 'beta', title: 'Beta session', cwd: OTHER, createdAt: now - 1000 },
    ],
  })
  p.picker.focused = true
  p.picker.handleInput('alpha')
  // Caret is at the end of the query: Ctrl+A moves to line start, Ctrl+F moves
  // right again. Neither toggles the scope nor opens modal.search.
  p.picker.handleInput(KEY.ctrlA)
  p.picker.handleInput('>')
  assert.match(text(p.picker), /Search >alpha/, 'Ctrl+A put the caret at line start')
  assert.match(text(p.picker), /current folder/, 'Ctrl+A never toggled the scope in the field')
  p.picker.handleInput(KEY.ctrlF)
  p.picker.handleInput('<')
  assert.match(text(p.picker), /Search >a<lpha/, 'Ctrl+F moved the caret right in the field')

  // Browse layer keeps the registry meanings.
  p.picker.handleInput(KEY.escape) // leave the search
  p.picker.handleInput(KEY.ctrlF) // modal.search -> the field
  assert.ok(p.picker.render(80).join('\n').includes(CURSOR_MARKER), 'modal.search focuses the field in browse')
  p.picker.handleInput(KEY.escape)
  p.picker.handleInput(KEY.ctrlA) // session.scope.toggle in browse
  assert.match(text(p.picker), /all folders/)
})

test('session scope toggle is only bound in browse: remap and disable are respected', () => {
  const now = Date.now()
  const items: Item[] = [
    { id: 'a', title: 'Alpha', cwd: DIRECTORY, createdAt: now },
    { id: 'b', title: 'Beta', cwd: OTHER, createdAt: now - 1000 },
  ]
  const remapped = makePicker({ items, keymap: keymap({ 'session.scope.toggle': 'alt+t' }) })
  remapped.picker.handleInput(KEY.ctrlA)
  assert.match(text(remapped.picker), /current folder/, 'the old Ctrl+A default was removed')
  remapped.picker.handleInput('\x1bt')
  assert.match(text(remapped.picker), /all folders/)
  assert.match(text(remapped.picker), /\[alt\+t All folders\]|\[alt\+t Current folder\]/)

  // Tab is no longer the scope key: it must be inert (no scope change, no close).
  const tab = makePicker({ items })
  tab.picker.handleInput(KEY.tab)
  assert.match(text(tab.picker), /current folder/)
  assert.equal(tab.cancelled, 0, 'Tab neither toggles the scope nor closes the picker')

  const disabled = makePicker({ items, keymap: keymap({ 'session.scope.toggle': null }) })
  disabled.picker.handleInput(KEY.ctrlA)
  assert.match(text(disabled.picker), /current folder/, 'a disabled scope action is inert')
  assert.match(text(disabled.picker), /\[All folders\]/, 'the capability stays clickable')
  assert.doesNotMatch(text(disabled.picker), /ctrl\+a All folders/, 'no fake binding is advertised')
})

test('mouse: press+click on the same session resumes it; a stale or unpaired click cannot', () => {
  const now = Date.now()
  const p = makePicker({
    items: [
      { id: 'alpha', title: 'Alpha session', cwd: DIRECTORY, createdAt: now },
      { id: 'beta', title: 'Beta session', cwd: DIRECTORY, createdAt: now - 1000 },
    ],
  })
  const lines = p.picker.render(80)
  const betaRow = lines.findIndex(line => stripTerminalSequences(line).includes('Beta session'))
  assert.ok(betaRow > 0)
  const click = (y: number) => ({
    type: 'click' as const, button: 'left' as const, x: 8, y, screenX: 8, screenY: y,
    width: 80, height: lines.length, shift: false, alt: false, ctrl: false, clickCount: 1,
  })
  const press = (y: number) => p.picker.handleMouse({
    type: 'press', button: 'left', x: 8, y, screenX: 8, screenY: y,
    width: 80, height: lines.length, shift: false, alt: false, ctrl: false,
  })

  // A click with no press must not resume anything.
  assert.equal(p.picker.handleMouse(click(betaRow))?.render, false)
  assert.deepEqual(p.selected, [], 'an unpaired click never resumes a session')
  // Press on Beta, then the query filters the list, then release: swallowed.
  press(betaRow)
  p.picker.handleInput('z')
  p.picker.handleInput(KEY.backspace)
  assert.deepEqual(p.selected, [], 'a stale press cannot resume a re-filtered row')
  // Press + click on the same row resumes that exact opaque id.
  press(betaRow)
  p.picker.handleMouse(click(betaRow))
  assert.deepEqual(p.selected, ['beta'])
})

test('frame closure and footer survive 40/60/80/120 columns and short heights', () => {
  const now = Date.now()
  const items: Item[] = Array.from({ length: 6 }, (_, index) => ({
    id: `s${index}`,
    title: `Session ${index} with a deliberately long title`,
    cwd: DIRECTORY,
    createdAt: now - index * 1000,
  }))
  for (const rows of [10, 18, 24, 40]) {
    for (const width of [40, 60, 80, 120]) {
      const picker = new SessionPickerDialog(fakeTui(rows, width), {
        sessions: items,
        directory: DIRECTORY,
        keymap: keymap(),
        onSelect: () => {},
        onCancel: () => {},
      })
      const lines = picker.render(width)
      for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`)
      const rendered = stripTerminalSequences(lines.join('\n'))
      assert.match(rendered.split('\n')[0] ?? '', /^┌─ /, `top border at ${width}x${rows}`)
      assert.match(rendered.split('\n').at(-1) ?? '', /^└─+┘$/, `bottom border at ${width}x${rows}`)
      assert.match(rendered, /\[escape Cancel\]|\[Cancel\]/, `cancel stays discoverable at ${width}x${rows}`)
      assert.ok(lines.length <= Math.min(rows - 2, Math.floor(rows * 0.9)))
    }
  }
})
