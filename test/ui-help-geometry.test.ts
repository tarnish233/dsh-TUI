/**
 * Help window geometry: the painted body window, the scroll maximum and the
 * status range must all come from the SAME body width the frame lays the body
 * out at (`ModalFrame` body width), never from the frame/terminal width.
 *
 * Regression background: `/help` used to measure the body at the frame width
 * (`this.lastWidth`) for `maxScroll()`/`statusText()` while painting the body
 * wrapped at the narrower frame body width. Wrapping at the wider width yields
 * fewer rows, so `list.last`/End stopped short of the true tail: the footer
 * claimed `25-46/46` while the last commands/skills rows (for example a
 * user-only skill's own wrapped description) stayed clipped below the frame.
 * This file is UI-only: a fake TUI, a fixture catalog and native skill
 * metadata. It starts no Agent, model, profile or global read.
 */
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'
import type { HelpCommand } from '../src/ui/help.ts'
import type { SkillCatalogSnapshot } from '../src/backend/types.ts'

const input = await loadInputModule()
const { HelpPanel } = await import('../src/ui/help.ts')

type CcKeymap = InstanceType<typeof input.CcKeymap>
type Panel = InstanceType<typeof HelpPanel>

const END = '\x1b[F'
const HOME = '\x1b[H'
const PAGE_DOWN = '\x1b[6~'

/**
 * The mounted optional UI commands of the failing native scene (17 of them),
 * with descriptions long enough to wrap inside one modal column.
 */
const mountedCommands = (): HelpCommand[] => [
  { name: 'help', description: 'List mounted commands and native skills' },
  { name: 'model', inputHint: '[provider/model]', description: 'Choose a DSH model for this session' },
  { name: 'permission', inputHint: '<preset>', description: 'Switch the permission preset (sandbox mode + approval policy)' },
  { name: 'jobs', description: 'Inspect native jobs and retained output' },
  { name: 'inspect', description: 'Read mounted native plugins and capabilities' },
  { name: 'questions', description: 'View and answer native continued questions' },
  { name: 'rename', description: 'Explicitly rename the current native session' },
  { name: 'attach', inputHint: '[local-path]', description: 'Attach one local file through native DSH storage' },
  { name: 'feedback', inputHint: '<text>', description: 'Record feedback about this session' },
  { name: 'resume', description: 'Reopen a durable native session by id' },
  { name: 'skills', description: 'Inspect the native skill catalog for this composition' },
  { name: 'settings', description: 'Edit grouped shortcuts and terminal preferences' },
  { name: 'theme', description: 'Preview the semantic colour surfaces' },
  { name: 'todos', description: 'Show the durable native todo board' },
  { name: 'usage', description: 'Native token and cost accounting' },
  { name: 'compact', description: 'Ask native DSH to compact this conversation' },
  { name: 'clear', description: 'Clear the visible transcript without touching native state' },
]

/**
 * The tail marker proves that the deepest row of the longest description is
 * painted. It stays a whole word at the narrowest tested width, so a body
 * clipped by the window can never be mistaken for a wrapped one.
 */
const TAIL = 'END-OF-CATALOG'
const REVIEW_DESCRIPTION = 'Native fixture review metadata that needs more than one row at narrow widths.'
const REVIEW_WHEN = 'when reviewing fixture metadata'
const USER_ONLY = 'fixture-user-only'
const USER_ONLY_DESCRIPTION = `Explicit-only native fixture kept out of model invocation, ending with ${TAIL}`

/** A user-only skill last in the snapshot, exactly like the native failure. */
const skillSnapshot = (userOnlyLast = true): SkillCatalogSnapshot => {
  const review = { name: 'fixture-review', description: REVIEW_DESCRIPTION, whenToUse: REVIEW_WHEN, modelInvocable: true }
  const userOnly = { name: USER_ONLY, description: USER_ONLY_DESCRIPTION, modelInvocable: false }
  return { available: true, complete: true, entries: userOnlyLast ? [review, userOnly] : [userOnly, review] }
}

function makePanel(options: {
  rows: number
  columns: number
  skills?: SkillCatalogSnapshot
}): Panel {
  const keymap: CcKeymap = input.createCcKeymap({ bindings: {} })
  const panel = new HelpPanel(asTui(createFakeTui(options.rows, options.columns)), {
    commands: mountedCommands(),
    customCommands: [],
    keymap,
    ...(options.skills === undefined ? {} : { skills: options.skills }),
    onClose: () => {},
  })
  panel.focused = true
  return panel
}

interface Painted {
  lines: string[]
  /** Body rows only: between the two frame rules, chrome removed. */
  rows: string[]
  /** Chrome-free body width, taken from the frame's own rule row. */
  bodyWidth: number
}

const RULE = /^├─+┤$/

function painted(panel: Panel, width: number): Painted {
  const lines = panel.render(width).map(line => stripTerminalSequences(line))
  const rules = lines.reduce<number[]>((all, line, index) => (RULE.test(line) ? [...all, index] : all), [])
  assert.equal(rules.length, 2, `a framed body has two rules:\n${lines.join('\n')}`)
  const ruleWidth = visibleWidth(lines[rules[0]!]!)
  const rows = lines.slice(rules[0]! + 1, rules[1]!).map(line => line.replace(/^│ /, '').replace(/ │$/, '').trimEnd())
  return { lines, rows, bodyWidth: Math.max(1, ruleWidth - 4) }
}

type StatusRange =
  | { kind: 'window'; start: number; end: number; total: number }
  /** No window is needed: the whole body fits the painted height. */
  | { kind: 'fits' }
  /** Narrow terminal: the status row itself is width-clipped before the range. */
  | { kind: 'clipped' }

/** What the footer claims about the visible window, if anything. */
function rangeOf(p: Painted): StatusRange {
  const status = p.rows.length > 0 ? p.lines.find(line => /\d+ commands ·/.test(line)) : undefined
  assert.ok(status, `missing status line:\n${p.lines.join('\n')}`)
  const text = status!.replace(/^│ /, '').replace(/ │$/, '').trimEnd()
  const match = /\b(\d+)-(\d+)\/(\d+)$/.exec(text)
  if (match !== null) return { kind: 'window', start: Number(match[1]), end: Number(match[2]), total: Number(match[3]) }
  // A range that was cut by the frame width is not a claim this test can read;
  // it is a narrow-terminal display limit, not a window that lies about rows.
  return visibleWidth(text) >= p.bodyWidth ? { kind: 'clipped' } : { kind: 'fits' }
}

const nonBlank = (rows: readonly string[]): string[] => rows.filter(row => row.trim() !== '')

/** One page's rows as text: indentation collapsed so wrapped words stay whole. */
const flattened = (rows: readonly string[]): string => nonBlank(rows).join(' ').replace(/\s+/g, ' ').trim()

/** Every rendered row must fit the frame width, and the frame the terminal. */
function assertFits(p: Painted, width: number, rows: number): void {
  for (const line of p.lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} ${JSON.stringify(line)}`)
  assert.ok(p.lines.length <= rows, `${p.lines.length} frame rows for a ${rows}-row terminal`)
}

/**
 * Walk the catalog with the real list keymap from Home to the end, returning
 * every painted page. The pages must cover the body without a gap: a skipped
 * row is a row the footer's total hides from the reader for good.
 */
function walk(panel: Panel, width: number, pageKey = PAGE_DOWN): Painted[] {
  const pages: Painted[] = []
  if (pageKey === PAGE_DOWN) panel.handleInput(HOME)
  let previous = Number.NaN
  for (let step = 0; step < 200; step += 1) {
    const scroll = panel.scrollTop
    if (scroll === previous) break
    previous = scroll
    pages.push(painted(panel, width))
    panel.handleInput(pageKey)
  }
  return pages
}

/** The footer must not hide rows: contiguous pages that end on the claimed total. */
function assertContiguousWalk(pages: readonly Painted[], label: string): void {
  // Overlap on the final page is normal (the page size rarely divides the body);
  // a GAP means the footer's total hides rows the reader can never reach.
  let highest = 1
  let total: number | undefined
  let windowed = false
  let clipped = false
  for (const [index, page] of pages.entries()) {
    const range = rangeOf(page)
    if (range.kind === 'clipped') { clipped = true; continue }
    if (range.kind === 'fits') {
      assert.equal(index, 0, `${label}: only one page when the whole body fits`)
      continue
    }
    windowed = true
    assert.ok(range.start <= highest, `${label}: page ${index} starts at ${range.start}, skipping row ${highest}`)
    assert.equal(range.end - range.start + 1, page.rows.length, `${label}: page ${index} span vs painted rows`)
    highest = Math.max(highest, range.end + 1)
    total = range.total
    if (index === pages.length - 1) assert.equal(range.end, range.total, `${label}: the walk ends on the claimed total`)
  }
  if (!clipped && windowed && total !== undefined) {
    assert.equal(highest - 1, total, `${label}: the pages cover the reported total ${total}`)
  }
}

/** At End the deepest painted row is the catalog tail, never a clipped prefix. */
function assertTailReachable(panel: Panel, width: number, rows: number, label: string, tail: string | RegExp): Painted {
  // The App paints a surface before it can receive keys; do the same so the
  // window budget is measured, then jump to the last row.
  painted(panel, width)
  panel.handleInput(END)
  const last = painted(panel, width)
  assertFits(last, width, rows)
  const deepest = nonBlank(last.rows).at(-1)
  assert.ok(deepest !== undefined, `${label}: the last page is blank\n${last.lines.join('\n')}`)
  const ok = typeof tail === 'string' ? deepest!.endsWith(tail) : tail.test(deepest!)
  assert.ok(ok, `${label}: the deepest row is clipped below the frame: ${JSON.stringify(deepest)}`)
  return last
}

const GEOMETRIES: readonly (readonly [number, number])[] = [
  // rows, width: short, tall, narrow, and the 100-column standard modal inside a
  // wider terminal — the native scene's shape, where frame width != terminal width.
  [12, 40], [12, 100], [12, 106],
  [18, 56], [18, 106],
  [24, 72], [24, 100],
  [30, 80], [30, 100], [30, 106], [30, 120],
  [40, 96], [40, 106], [40, 120],
  [60, 100], [60, 120],
]

test('the last user-only skills row is reachable at End at every geometry', () => {
  for (const [rows, width] of GEOMETRIES) {
    const label = `rows=${rows} width=${width}`
    const panel = makePanel({ rows, columns: width, skills: skillSnapshot() })

    const first = painted(panel, width)
    assertFits(first, width, rows)
    assert.equal(panel.scrollTop, 0, label)
    const firstRange = rangeOf(first)
    if (firstRange.kind === 'window') assert.equal(firstRange.start, 1, `${label}: the first window starts at row 1`)

    const last = assertTailReachable(panel, width, rows, label, TAIL)
    const lastRange = rangeOf(last)
    if (lastRange.kind === 'window') {
      assert.equal(lastRange.end, lastRange.total, `${label}: End must land on the real last row`)
      assert.equal(lastRange.start, panel.scrollTop + 1, `${label}: the window starts at the painted offset`)
      assert.equal(lastRange.end - lastRange.start + 1, last.rows.length,
        `${label}: the reported span must be the painted body height`)
    }

    const pages = walk(panel, width)
    for (const page of pages) assertFits(page, width, rows)
    assertContiguousWalk(pages, label)

    // No row is lost to the window: every wrapped row is painted exactly once.
    const text = pages.map(page => flattened(page.rows)).join(' ')
    for (const expected of [REVIEW_DESCRIPTION, REVIEW_WHEN, USER_ONLY_DESCRIPTION, '[user-only]', 'Commands 17', 'Skills 2']) {
      assert.ok(text.includes(expected), `${label}: missing ${JSON.stringify(expected)} from the painted pages`)
    }
    assert.ok(text.indexOf(REVIEW_DESCRIPTION) < text.indexOf(USER_ONLY_DESCRIPTION),
      `${label}: the snapshot order is preserved, not sorted`)
  }
})

test('a user-only skill first in the snapshot is not clipped either', () => {
  for (const [rows, width] of [[12, 40], [18, 106], [30, 100], [30, 106]] as const) {
    const label = `rows=${rows} width=${width}`
    const panel = makePanel({ rows, columns: width, skills: skillSnapshot(false) })
    // The last body row is the review block: its description tail, or the
    // second wrapped `when:` row on a narrow body.
    const last = assertTailReachable(panel, width, rows, label, /widths\.$|metadata$/)
    assert.ok(flattened(last.rows).includes('reviewing fixture') || flattened(last.rows).includes('widths.'),
      `${label}: the last page still paints the final skill block\n${last.lines.join('\n')}`)

    const pages = walk(panel, width)
    for (const page of pages) assertFits(page, width, rows)
    assertContiguousWalk(pages, label)
    const text = pages.map(page => flattened(page.rows)).join(' ')
    assert.ok(text.includes(USER_ONLY_DESCRIPTION), `${label}: the user-only description is fully painted`)
    assert.ok(text.includes('when: when reviewing fixture'), `${label}: the when: row is fully painted`)
  }
})

test('a filtered skills catalog keeps the same window and still reaches its last row', () => {
  for (const [rows, width] of [[12, 100], [18, 106], [30, 80]] as const) {
    const label = `rows=${rows} width=${width}`
    const panel = makePanel({ rows, columns: width, skills: skillSnapshot() })
    panel.handleInput('\x06') // Ctrl+F = modal.search
    for (const char of 'fixture') panel.handleInput(char)
    assert.equal(panel.searching, true, label)

    // The search layer keeps the page keys: scroll with PageDown to the end.
    const pages = walk(panel, width)
    for (const page of pages) assertFits(page, width, rows)
    assertContiguousWalk(pages, label)

    const deepest = nonBlank(pages.at(-1)!.rows).at(-1)
    assert.ok(deepest !== undefined && deepest.endsWith(TAIL), `${label}: the filtered last row is clipped: ${JSON.stringify(deepest)}`)
    const text = pages.map(page => flattened(page.rows)).join(' ')
    assert.ok(text.includes(USER_ONLY_DESCRIPTION), `${label}: the filtered user-only description is fully painted`)
    assert.ok(text.includes('Skills 2'), `${label}: the filtered count stays honest`)
    assert.ok(panel.searching, `${label}: paging never leaves the query layer`)
  }
})

test('End is stable: repeating it never moves past the last row or hides content', () => {
  const panel = makePanel({ rows: 18, columns: 106, skills: skillSnapshot() })
  const first = painted(panel, 106)
  assert.ok(first.rows.length > 0)
  panel.handleInput(END)
  const once = painted(panel, 106)
  const scroll = panel.scrollTop
  assert.ok(scroll > 0, 'a short 18-row terminal really windows this body')
  for (let index = 0; index < 3; index += 1) {
    panel.handleInput(END)
    assert.equal(panel.scrollTop, scroll)
    assert.deepEqual(painted(panel, 106).lines, once.lines)
  }
  // A resize keeps the same rule: the tail stays reachable at every new width.
  for (const width of [80, 120, 100, 56]) {
    painted(panel, width)
    panel.handleInput(END)
    assertTailReachable(panel, width, 18, `resize width=${width}`, TAIL)
  }
})