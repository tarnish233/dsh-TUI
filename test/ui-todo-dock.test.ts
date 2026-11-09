// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { TodoItem, TodosSnapshot } from '../src/backend/types.ts'
import { createCcKeymap } from '../src/input/keymap.ts'
import { TodoBoard } from '../src/ui/todo-board.ts'

/**
 * Native DSH todos dock: presentation-only projection of the `todos`
 * snapshot. No backend, no model, no DSH runtime and no stdout.
 *
 * Claude Code reference for the behavioral choices asserted here:
 * - status-area checklist toggled by Ctrl+T, at most five tasks visible:
 *   https://code.claude.com/docs/en/interactive-mode#task-list
 *   https://code.claude.com/docs/en/keybindings
 * - full-list replacement / pending-in_progress-completed lifecycle:
 *   https://code.claude.com/docs/en/agent-sdk/todo-tracking
 * - the tray disappears once every item is completed (public observation on
 *   CC 2.0.76/macOS): https://github.com/anthropics/claude-code/issues/15408
 */

const PLAN: TodoItem[] = [
  { content: 'Read the current resume flow', status: 'completed' },
  { content: 'Extract the picker scope filter', status: 'in_progress' },
  { content: 'Run the ui test suite', status: 'pending' },
]

const plain = (lines: readonly string[]): string[] => lines.map(line => stripTerminalSequences(line))

function mount(options: ConstructorParameters<typeof TodoBoard>[0] = {}): TodoBoard {
  return new TodoBoard({ keymap: createCcKeymap(), ...options })
}

function snapshot(...items: TodoItem[]): TodosSnapshot {
  return items
}

function assertWidths(lines: readonly string[], width: number, label: string): void {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `${label}: width ${width} got ${visibleWidth(line)} :: ${JSON.stringify(stripTerminalSequences(line))}`,
    )
  }
}

function countRows(lines: readonly string[], glyphs = ['☑', '◐', '☐']): number {
  return plain(lines).filter(line => glyphs.some(glyph => line.includes(`${glyph} `))).length
}

// ---------------------------------------------------------------------------
// Empty / cleared / unsupported snapshots

test('null, empty, malformed and all-blank snapshots paint nothing at all', () => {
  const board = mount()
  assert.deepEqual(board.render(80), [], 'no projection yet')
  assert.equal(board.hasOpenItems, false)
  assert.deepEqual(board.counts, { total: 0, completed: 0, inProgress: 0, pending: 0 })

  board.todos = []
  assert.deepEqual(board.render(80), [], 'an empty list is chrome, not a row')
  // A hostile runtime value is not a list and must not throw.
  board.todos = { length: 1 } as unknown as TodosSnapshot
  assert.deepEqual(board.render(80), [])
  board.todos = [null, 3, { content: 7, status: 'pending' }] as unknown as TodosSnapshot
  assert.deepEqual(board.render(80), [], 'invalid entries are skipped, never invented')
  board.todos = [{ content: '   ', status: 'pending' }, { content: '\x1b[31m\x1b[0m', status: 'pending' }]
  assert.deepEqual(board.render(80), [], 'blank/control-only content is not painted as a step')
})

test('an empty native fold clears the previous session checklist and counts', () => {
  const board = mount()
  board.todos = snapshot(...PLAN)
  assert.ok(board.render(80).length > 0)
  assert.equal(board.hasOpenItems, true)

  board.todos = null
  assert.deepEqual(board.render(80), [], 'null removes the dock')
  assert.deepEqual(board.counts, { total: 0, completed: 0, inProgress: 0, pending: 0 }, 'no stale counts')
  assert.equal(board.hasOpenItems, false)

  // A new session's list paints only its own facts.
  board.todos = snapshot({ content: 'new session step', status: 'pending' })
  const painted = plain(board.render(80)).join('\n')
  assert.ok(painted.includes('new session step'))
  for (const stale of PLAN) assert.ok(!painted.includes(stale.content), `stale fact ${stale.content}`)
})

// ---------------------------------------------------------------------------
// Native statuses and visual shape

test('renders the CC status-area shape with native pending/in-progress/completed rows', () => {
  const board = mount()
  board.todos = snapshot(...PLAN)
  assert.deepEqual(plain(board.render(80)), [
    '⏺ Todos · 1/3',
    '  ⎿  ☑ Read the current resume flow',
    '     ◐ Extract the picker scope filter',
    '     ☐ Run the ui test suite',
    '',
  ])
  // Completed work recedes; only the active row is bold+accent.
  const lines = board.render(80)
  assert.ok(lines[1]?.includes('\x1b[2m'), 'completed content is dim')
  assert.ok(lines[2]?.includes('\x1b[1m'), 'in-progress content is emphasised')
  assert.deepEqual(board.counts, { total: 3, completed: 1, inProgress: 1, pending: 1 })
  assert.ok(board.render(80).every(line => !line.includes('\x1b[9m')), 'no strikethrough is claimed without evidence')
})

test('paints no hardcoded background slab: shared transparent canvas only', () => {
  const board = mount()
  board.todos = snapshot(...PLAN)
  for (const width of [20, 40, 80]) {
    const lines = board.render(width)
    for (const line of lines) {
      assert.doesNotMatch(
        line,
        /\x1b\[(?:4[0-7]|49|48|10[0-7])(?:;[0-9;]*)?m/,
        'the dock must not paint its own background or surface plate',
      )
    }
    // The only blank row is the explicit optional separator, never a filled band.
    assert.ok(plain(lines).every(line => line === '' || line.trim() !== ''))
  }
})

test('a status-only update replaces the same row and never appends a copy', () => {
  const board = mount()
  board.todos = snapshot(...PLAN)
  const before = plain(board.render(80))
  const position = before.findIndex(line => line.includes('Extract the picker scope filter'))
  assert.ok(position > 0)

  board.todos = snapshot(
    PLAN[0]!,
    { content: PLAN[1]!.content, status: 'completed' },
    { content: PLAN[2]!.content, status: 'in_progress' },
  )
  const after = plain(board.render(80))
  assert.equal(after.length, before.length, 'replacement keeps the frame shape')
  assert.equal(after[position], '     ☑ Extract the picker scope filter', 'same index identity, new status glyph')
  assert.equal(after.filter(line => line.includes('Extract the picker scope filter')).length, 1)
  assert.equal(after[0], '⏺ Todos · 2/3')
  assert.equal(countRows(board.render(80)), 3)

  // An identical repeated snapshot is idempotent.
  assert.deepEqual(board.render(80), board.render(80))
})

test('identity is the native index: duplicates stay distinct and order is never rewritten', () => {
  const board = mount()
  board.todos = snapshot(
    { content: 'same text', status: 'pending' },
    { content: 'same text', status: 'in_progress' },
    { content: 'other', status: 'completed' },
  )
  const lines = plain(board.render(80))
  assert.equal(lines.filter(line => line.includes('same text')).length, 2, 'content is not a dedupe key')
  assert.equal(lines[0], '⏺ Todos · 1/3')
  assert.match(lines[1] ?? '', /☐ same text/)
  assert.match(lines[2] ?? '', /◐ same text/)

  // Completion does not sort or float rows: DSH's array order is the order.
  board.todos = snapshot(
    { content: 'third', status: 'completed' },
    { content: 'first', status: 'pending' },
    { content: 'second', status: 'in_progress' },
  )
  const reordered = plain(board.render(80))
  assert.deepEqual(reordered.slice(1, 4), [
    '  ⎿  ☑ third',
    '     ☐ first',
    '     ◐ second',
  ])

  // Shrinking and growing replaces the list; no stale rows or overflow remain.
  board.todos = snapshot({ content: 'only', status: 'pending' }, { content: 'tail', status: 'pending' })
  const small = plain(board.render(80)).join('\n')
  for (const gone of ['third', 'first', 'second', 'more']) {
    assert.ok(!small.includes(gone), `stale ${gone}`)
  }
  assert.ok(!small.includes('+'))
})

test('one open item keeps every completed row visible, exactly like CC', () => {
  const board = mount()
  board.todos = snapshot(
    { content: 'done one', status: 'completed' },
    { content: 'done two', status: 'completed' },
    { content: 'still open', status: 'pending' },
  )
  const lines = plain(board.render(80))
  assert.deepEqual(lines.slice(0, 4), [
    '⏺ Todos · 2/3',
    '  ⎿  ☑ done one',
    '     ☑ done two',
    '     ☐ still open',
  ])
  assert.ok(!board.render(80)[0]?.includes('+'), 'nothing is hidden')
})

test('an all-completed list hides the dock (CC retires the tray), without erasing facts', () => {
  const board = mount()
  board.todos = snapshot(
    { content: 'finished a', status: 'completed' },
    { content: 'finished b', status: 'completed' },
  )
  assert.deepEqual(board.render(80), [], 'all done means current work is over')
  assert.deepEqual(board.counts, { total: 2, completed: 2, inProgress: 0, pending: 0 })
  assert.equal(board.hasOpenItems, false)

  // Adding one open item immediately restores the whole native list.
  board.todos = snapshot(
    { content: 'finished a', status: 'completed' },
    { content: 'finished b', status: 'completed' },
    { content: 'next', status: 'pending' },
  )
  const lines = plain(board.render(80))
  assert.equal(countRows(board.render(80)), 3)
  assert.ok(lines.join('\n').includes('finished a'))
})

test('unknown statuses stay visibly pending and are never promoted to completed', () => {
  const board = mount()
  board.todos = [
    { content: 'blocked mystery', status: 'blocked' as TodoItem['status'] },
    { content: 'missing status', status: undefined as unknown as TodoItem['status'] },
  ]
  const lines = plain(board.render(80))
  assert.equal(lines[0], '⏺ Todos · 0/2')
  assert.match(lines[1] ?? '', /☐ blocked mystery/)
  assert.match(lines[2] ?? '', /☐ missing status/)
  assert.ok(!lines.join('\n').includes('☑'), 'no false completion')
  assert.deepEqual(board.counts, { total: 2, completed: 0, inProgress: 0, pending: 2 })
})

// ---------------------------------------------------------------------------
// CC's five-task cap and constrained height

test('at most five tasks are painted and the rest are counted honestly', () => {
  const board = mount({ maxRows: 8 })
  board.todos = snapshot(...Array.from({ length: 9 }, (_, index) => ({
    content: `step ${index + 1}`,
    status: index === 0 ? 'in_progress' as const : 'pending' as const,
  })))
  const lines = plain(board.render(80))
  assert.equal(countRows(board.render(80)), 5, 'CC shows up to five tasks')
  assert.equal(lines[0], '⏺ Todos · 0/9 · +4 more')
  assert.ok(!lines.join('\n').includes('step 6'), 'the sixth task is not painted')
  assert.ok(lines.join('\n').includes('step 5'))
})

test('the line budget is a hard total: zero hides, one compacts, two or more is the full tray', () => {
  const board = mount()
  board.todos = snapshot(...Array.from({ length: 9 }, (_, index) => ({
    content: `step ${index + 1}`,
    status: 'pending' as const,
  })))
  board.maxRows = 0
  assert.deepEqual(board.render(80), [], 'budget 0 degrades to nothing, not a header-only strip')
  // A single row is the compact fallback, never a header without work.
  board.maxRows = 1
  const compact = board.render(80)
  assert.equal(compact.length, 1, 'budget 1 spends exactly one row')
  assert.equal(plain(compact)[0], '⏺ Todos · 0/9 · ☐ step 1')
  for (const budget of [2, 3, 4, 5, 6, 7, 8]) {
    board.maxRows = budget
    const lines = board.render(80)
    assert.ok(lines.length <= budget, `budget ${budget} produced ${lines.length} lines`)
    assert.ok(lines.length >= 2, `budget ${budget} still paints the header and at least one task`)
    assert.ok(countRows(lines) >= 1)
    assert.equal(lines.length, Math.min(budget, 7), `budget ${budget} uses only what it can`)
  }
  // A larger budget never shows more than the CC cap.
  board.maxRows = 40
  assert.equal(countRows(board.render(80)), 5)
})

test('the trailing separator is optional and never pushes past the budget', () => {
  const board = mount({ maxRows: 3 })
  board.todos = snapshot({ content: 'one', status: 'pending' }, { content: 'two', status: 'pending' })
  assert.deepEqual(plain(board.render(80)), [
    '⏺ Todos · 0/2',
    '  ⎿  ☐ one',
    '     ☐ two',
  ])
  board.maxRows = 4
  assert.deepEqual(plain(board.render(80)).at(-1), '')
  // Even at a tall budget the dock is compact: header + all rows + one gap.
  board.maxRows = 40
  assert.equal(board.render(80).length, 4)
})

test('a dynamic budget getter is re-sampled on every paint', () => {
  let budget = 2
  const board = mount({ maxRows: () => budget })
  board.todos = snapshot(...Array.from({ length: 5 }, (_, index) => ({ content: `s${index}`, status: 'pending' as const })))
  assert.equal(board.render(80).length, 2)
  budget = 5
  assert.equal(board.render(80).length, 5)
  budget = 0
  assert.deepEqual(board.render(80), [])
  // An explicit assignment wins over the live getter until it is cleared.
  board.maxRows = 3
  budget = 40
  assert.equal(board.render(80).length, 3)
  // Non-finite budgets fall back to the bounded default (header + five tasks
  // + separator when the list is long enough to fill it).
  board.maxRows = Number.NaN
  assert.equal(board.render(80).length, 7)
})

// ---------------------------------------------------------------------------
// Narrow terminals, CJK/emoji and hostile text

test('every emitted line is width-safe at 1..120 columns for CJK, emoji, ANSI and controls', () => {
  const board = mount()
  board.todos = snapshot(
    {
      content: '实现待办列表的块渲染，并保持每行宽度安全 ✅ 这是一段很长的内容用来触发截断',
      status: 'in_progress',
    },
    { content: '👨‍👩‍👧‍👦 emoji family with combining é and \x1b[31mred\x1b[0m text', status: 'pending' },
    { content: '\x1b]8;;https://example.com\x07click here\x1b]8;;\x07\r\nnext\tline\x00', status: 'completed' },
  )
  for (const width of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 16, 24, 40, 80, 120]) {
    const lines = board.render(width)
    assertWidths(lines, width, `width ${width}`)
    for (const line of plain(lines)) assert.doesNotMatch(line, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
    // Content with embedded newlines/tabs stays on one task line.
    for (const line of lines) assert.ok(!line.includes('\n'))
  }
  const narrow = plain(board.render(8))
  assert.match(narrow[1] ?? '', /^  ⎿  |^☑|^◐|^☐/)
  const wide = plain(board.render(80)).join('\n')
  assert.ok(wide.includes('click here next line'), 'newlines/tabs fold onto one row')
  assert.ok(wide.includes('实现待办'))
  assert.ok(!wide.includes('https://example.com'), 'OSC 8 payload is stripped, not painted')
})

test('a narrow terminal drops the elbow before it drops the task text', () => {
  const board = mount({ maxRows: 4 })
  board.todos = snapshot({ content: 'read the file', status: 'pending' })
  // 20 columns is wide enough for the transcript guide...
  assert.equal(plain(board.render(20))[1], '  ⎿  ☐ read the file')
  // ...while a narrow one uses the compact glyph row and keeps more content.
  const compact = plain(board.render(12))[1] ?? ''
  assert.equal(compact, '☐ read the …')
  assert.ok(!compact.includes('⎿'))
  assertWidths(board.render(12), 12, 'compact')
})

test('hostile control bytes in content cannot widen, reflow or paint the terminal', () => {
  const board = mount()
  board.todos = snapshot({
    content: 'a\x1b[2Jb\x1b]0;title\x07c\x1b[?25ld',
    status: 'pending',
  })
  const lines = board.render(40)
  assert.equal(lines.length, 3, 'header + one row + separator')
  assert.equal(plain(lines)[1], '  ⎿  ☐ abcd')
  for (const line of lines) {
    // Strip our own SGR first; nothing left may be a terminal sequence.
    assert.ok(!stripTerminalSequences(line).includes('\x1b'))
  }
})

// ---------------------------------------------------------------------------
// Stock replacement, Ctrl+T visibility, spinner frame, no mutation

test('assignments replace the snapshot; they never toggle the parent-owned visibility', () => {
  const board = mount()
  board.todos = snapshot(...PLAN)
  assert.equal(board.visible, true)
  assert.equal(board.toggle(), false)
  assert.deepEqual(board.render(80), [], 'Ctrl+T hidden')
  board.todos = snapshot({ content: 'new native step', status: 'in_progress' })
  assert.equal(board.visible, false, 'a native update never re-opens a hidden dock')
  assert.deepEqual(board.render(80), [])
  assert.equal(board.toggle(), true)
  assert.ok(plain(board.render(80)).join('\n').includes('new native step'))
  // The initial option is honored, and dispose is terminal.
  assert.equal(mount({ visible: false }).visible, false)
  board.dispose()
  assert.deepEqual(board.render(80), [])
  assert.equal(board.todos, null)
  assert.equal(board.isDisposed, true)
  board.dispose()
})

test('invalidate and repeated renders are deterministic; the native input is never mutated', () => {
  const frozen: readonly TodoItem[] = Object.freeze([
    Object.freeze({ content: 'frozen step ✅', status: 'in_progress' as const }),
    Object.freeze({ content: '另一个步骤', status: 'pending' as const }),
  ])
  const board = mount()
  board.todos = frozen
  const first = board.render(60)
  board.invalidate()
  assert.deepEqual(board.render(60), first)
  assert.deepEqual(board.render(60), first)
  // Counts/visibility helpers are read-only projections.
  assert.deepEqual(board.counts, { total: 2, completed: 0, inProgress: 1, pending: 1 })
  assert.equal(board.hasOpenItems, true)
  assert.equal(Object.isFrozen(frozen), true)
  assert.equal(Object.isFrozen(frozen[0]), true)
  for (const width of [2, 8, 16, 40, 60]) assertWidths(board.render(width), width, `frozen ${width}`)
})

test('the parent Working frame replaces only the in-progress glyph for one paint', () => {
  const board = mount()
  board.todos = snapshot(...PLAN)
  assert.ok(plain(board.render(80))[2]?.includes('◐ Extract'))
  board.spinnerFrame = '✻'
  assert.ok(plain(board.render(80))[2]?.includes('✻ Extract'))
  assert.ok(plain(board.render(80))[1]?.includes('☑ Read'), 'completed rows keep their own glyph')
  assert.ok(plain(board.render(80))[3]?.includes('☐ Run'), 'pending rows keep their own glyph')
  for (const frame of ['·', '✻', '✶', '✳']) {
    board.spinnerFrame = frame
    assertWidths(board.render(80), 80, `frame ${frame}`)
    assert.ok(plain(board.render(80))[2]?.includes(`${frame} Extract`))
  }
  // Hostile or multi-cell frames fall back; SGR is stripped before measuring.
  board.spinnerFrame = undefined
  const valid = plain(board.render(80))
  for (const frame of ['', '   ', 'ab', '🚀', '\x00', '\x1b[31m\x1b[0m']) {
    board.spinnerFrame = frame
    assert.deepEqual(plain(board.render(80)), valid, `frame ${JSON.stringify(frame)} must fall back`)
  }
  board.spinnerFrame = '\x1b[35m✻\x1b[0m'
  assert.ok(plain(board.render(80))[2]?.includes('✻ Extract'))
  board.spinnerFrame = undefined
  assert.ok(plain(board.render(80))[2]?.includes('◐ Extract'))
  // No in-progress row means no live glyph at all.
  board.todos = snapshot({ content: 'pending only', status: 'pending' })
  board.spinnerFrame = '✻'
  assert.ok(!plain(board.render(80)).join('\n').includes('✻'))
})

test('the header advertises the real Ctrl+T binding only when the parent opts in', () => {
  const defaultBoard = mount()
  defaultBoard.todos = snapshot(...PLAN)
  assert.ok(!plain(defaultBoard.render(80))[0]?.includes('Ctrl+T'), 'no dead chord by default')

  const hinted = mount({ hint: true })
  hinted.todos = snapshot(...PLAN)
  assert.equal(plain(hinted.render(80))[0], '⏺ Todos · 1/3 · Ctrl+T hide')

  // The chord comes from the shared keymap, so a remap is advertised honestly.
  const remapped = mount({ hint: true, keymap: createCcKeymap({ bindings: { 'app.todo': 'ctrl+y' } }) })
  remapped.todos = snapshot(...PLAN)
  assert.ok(plain(remapped.render(80))[0]?.includes('Ctrl+Y hide'))

  // A disabled action advertises nothing rather than a dead shortcut.
  const disabled = mount({ hint: true, keymap: createCcKeymap({ bindings: { 'app.todo': null } }) })
  disabled.todos = snapshot(...PLAN)
  assert.ok(!plain(disabled.render(80))[0]?.includes('Ctrl+T'))

  // The live hint getter is re-sampled per paint.
  let show = false
  const live = mount({ hint: () => show })
  live.todos = snapshot(...PLAN)
  assert.ok(!plain(live.render(80))[0]?.includes('Ctrl+T'))
  show = true
  assert.ok(plain(live.render(80))[0]?.includes('Ctrl+T hide'))
})

test('the hint never widens a narrow header', () => {
  const board = mount({ hint: true })
  board.todos = snapshot({ content: 'narrow', status: 'pending' })
  for (const width of [1, 2, 4, 8, 12, 16, 20]) {
    assertWidths(board.render(width), width, `hint ${width}`)
  }
  const narrow = plain(board.render(8)).join('\n')
  assert.ok(!narrow.includes('Ctrl+T'), 'the low-priority hint goes first')
  assert.ok(narrow.includes('Todos'), 'the honest header survives')
})
// ---------------------------------------------------------------------------
// Single-row compact fallback (explicit maxRows === 1)

test('maxRows 1 keeps a real checklist row: identity, native counts, first unfinished item', () => {
  const board = mount({ maxRows: 1 })
  board.todos = snapshot(...PLAN)
  const lines = board.render(80)
  assert.equal(lines.length, 1, 'a one-row budget spends exactly one row')
  assert.deepEqual(plain(lines), ['⏺ Todos · 1/3 · ◐ Extract the picker scope filter'])
  // Styling follows the full tray: native counts dim, the active item emphasised.
  assert.ok(lines[0]?.includes('\x1b[1m'), 'the in-progress item is bold like the full tray')
  // Counts are the honest native projection, not a progress guess.
  assert.deepEqual(board.counts, { total: 3, completed: 1, inProgress: 1, pending: 1 })
  assert.equal(board.hasOpenItems, true)
  // The compact row never borrows the full tray's chrome it cannot afford.
  assert.ok(!plain(lines)[0]?.includes('+'), 'no overflow count in one row')
  assert.ok(!plain(lines)[0]?.includes('⎿'), 'no transcript elbow in one row')
})

test('the compact row shows the FIRST unfinished item in native order and skips completed rows', () => {
  const board = mount({ maxRows: 1 })
  // Completed rows never displace the first real unfinished item.
  board.todos = snapshot(
    { content: 'done one', status: 'completed' },
    { content: 'done two', status: 'completed' },
    { content: 'still open', status: 'pending' },
  )
  assert.deepEqual(plain(board.render(80)), ['⏺ Todos · 2/3 · ☐ still open'])

  // Native order wins over a status preference: a pending row before an
  // in-progress one is painted, never re-sorted and never merged.
  board.todos = snapshot(
    { content: 'pending first', status: 'pending' },
    { content: 'active second', status: 'in_progress' },
  )
  assert.deepEqual(plain(board.render(80)), ['⏺ Todos · 0/2 · ☐ pending first'])

  // Content is never a dedupe key: identical unfinished rows stay distinct.
  board.todos = snapshot(
    { content: 'same text', status: 'pending' },
    { content: 'same text', status: 'in_progress' },
  )
  assert.equal(plain(board.render(80)).length, 1)
  assert.deepEqual(plain(board.render(80)), ['⏺ Todos · 0/2 · ☐ same text'])
  // Unknown statuses stay visibly pending (never promoted to completed).
  board.todos = snapshot({ content: 'mystery', status: 'blocked' as TodoItem['status'] })
  assert.deepEqual(plain(board.render(80)), ['⏺ Todos · 0/1 · ☐ mystery'])
})

test('the compact row degrades by width: item, then counts, then identity', () => {
  const board = mount({ maxRows: 1 })
  board.todos = snapshot(...PLAN)
  // 22 columns fit the elided item, 21 drop it and keep the native counts...
  assert.deepEqual(plain(board.render(22)), ['⏺ Todos · 1/3 · ◐ Ext…'])
  assert.deepEqual(plain(board.render(21)), ['⏺ Todos · 1/3'])
  assert.deepEqual(plain(board.render(13)), ['⏺ Todos · 1/3'])
  // ...12 no longer fits the counts, so the identity survives alone...
  assert.deepEqual(plain(board.render(12)), ['⏺ Todos'])
  assert.deepEqual(plain(board.render(7)), ['⏺ Todos'])
  // ...and every narrower column count only clips that identity.
  for (const width of [1, 2, 3, 4, 5, 6, 8, 9, 10, 11, 16, 20, 40, 80, 120]) {
    const lines = board.render(width)
    assert.equal(lines.length, 1, `width ${width} stays one row`)
    assertWidths(lines, width, `compact ${width}`)
  }
  // At one column Pi's shared fitter paints its ellipsis cell; it is still
  // width-safe and still one row, exactly like the full tray's floor.
  assert.equal(plain(board.render(1))[0]?.length, 1)
  // A short item keeps its full native text once the row has room.
  board.todos = snapshot({ content: 'run on', status: 'pending' })
  assert.deepEqual(plain(board.render(40)), ['⏺ Todos · 0/1 · ☐ run on'])
})

test('the compact row is width-safe for CJK, emoji, tabs, newlines and control bytes', () => {
  const board = mount({ maxRows: 1 })
  board.todos = snapshot(
    { content: '实现待办列表的块渲染 ✅ 这是一段很长的内容用来触发截断', status: 'in_progress' },
    { content: '👨‍👩‍👧‍👦 family\r\nnext\tline\x00', status: 'pending' },
  )
  for (const width of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 16, 20, 22, 24, 40, 80, 120]) {
    const lines = board.render(width)
    assert.equal(lines.length, 1, `width ${width} stays one row`)
    assertWidths(lines, width, `compact cjk ${width}`)
    for (const line of lines) {
      assert.ok(!line.includes('\n'), 'no embedded newline row')
      assert.ok(!stripTerminalSequences(line).includes('\x1b'), 'no non-SGR escape leaks')
      assert.doesNotMatch(stripTerminalSequences(line), /[\x00-\x08\x0b-\x1f\x7f-\x9f]/)
    }
  }
  const wide = plain(board.render(80))[0] ?? ''
  assert.ok(wide.startsWith('⏺ Todos · 0/2 · ◐ 实现待办'), wide)
  // The compact row only shows one native item; the later row is not folded in.
  assert.ok(!wide.includes('family'), wide)
  // Newlines/tabs in the first native item flatten onto the single row.
  board.todos = snapshot({ content: 'a\x1b[2Jb\x1b]0;title\x07c\r\nd\te', status: 'pending' })
  assert.deepEqual(plain(board.render(80)), ['⏺ Todos · 0/1 · ☐ abc d e'])
})

test('compact row stays quiet when hidden, disposed, empty or all-completed', () => {
  const board = mount({ maxRows: 1 })
  assert.deepEqual(board.render(80), [], 'no projection yet')
  board.todos = []
  assert.deepEqual(board.render(80), [], 'an empty list is chrome, not a row')
  // All-completed keeps the CC tray retirement rule at every budget.
  board.todos = snapshot({ content: 'done a', status: 'completed' }, { content: 'done b', status: 'completed' })
  assert.deepEqual(board.render(80), [])
  assert.deepEqual(board.counts, { total: 2, completed: 2, inProgress: 0, pending: 0 })
  assert.equal(board.hasOpenItems, false)

  // Ctrl+T hidden and a zero budget paint nothing at all.
  board.todos = snapshot(...PLAN)
  board.visible = false
  assert.deepEqual(board.render(80), [])
  board.visible = true
  board.maxRows = 0
  assert.deepEqual(board.render(80), [])
  board.maxRows = 1
  assert.equal(board.render(80).length, 1)

  // Disposal is terminal for the compact row too.
  board.dispose()
  assert.deepEqual(board.render(80), [])
  assert.equal(board.isDisposed, true)
})

test('the compact row reads a frozen native snapshot and the parent Working frame', () => {
  const frozen: readonly TodoItem[] = Object.freeze([
    Object.freeze({ content: 'frozen step ✅', status: 'completed' as const }),
    Object.freeze({ content: '另一个步骤', status: 'in_progress' as const }),
  ])
  const board = mount({ maxRows: 1 })
  board.todos = frozen
  const first = board.render(60)
  assert.deepEqual(plain(first), ['⏺ Todos · 1/2 · ◐ 另一个步骤'])
  board.invalidate()
  assert.deepEqual(board.render(60), first, 'repeat paints are deterministic')
  assert.deepEqual(board.counts, { total: 2, completed: 1, inProgress: 1, pending: 0 })

  // The parent's Working frame replaces the live glyph for one paint only.
  board.spinnerFrame = '✻'
  assert.deepEqual(plain(board.render(60)), ['⏺ Todos · 1/2 · ✻ 另一个步骤'])
  for (const frame of ['', '   ', 'ab', '🚀', '\x00']) {
    board.spinnerFrame = frame
    assert.deepEqual(plain(board.render(60)), ['⏺ Todos · 1/2 · ◐ 另一个步骤'], `frame ${JSON.stringify(frame)}`)
  }
  board.spinnerFrame = undefined
  // The native input stays frozen and untouched by every paint above.
  assert.equal(Object.isFrozen(frozen), true)
  assert.equal(Object.isFrozen(frozen[1]), true)
  assert.equal(frozen[1]?.status, 'in_progress')
  assert.equal(frozen[1]?.content, '另一个步骤')
})

test('a live budget getter crossing 2 switches between compact and full tray', () => {
  let budget = 1
  const board = mount({ maxRows: () => budget })
  board.todos = snapshot(...PLAN)
  assert.deepEqual(plain(board.render(80)), ['⏺ Todos · 1/3 · ◐ Extract the picker scope filter'])
  budget = 2
  assert.deepEqual(plain(board.render(80)), [
    '⏺ Todos · 1/3 · +2 more',
    '  ⎿  ☑ Read the current resume flow',
  ], 'two rows are always the full tray, even though the compact row would fit')
  budget = 1
  assert.equal(board.render(80).length, 1)
  budget = 0
  assert.deepEqual(board.render(80), [])
  // An explicit assignment wins over the live getter; the compact path follows it.
  budget = 8
  board.maxRows = 1
  assert.equal(board.render(80).length, 1)
  assert.ok(plain(board.render(80))[0]?.includes('Todos'))
})

test('the compact row never advertises the toggle hint it has no room for', () => {
  const board = mount({ maxRows: 1, hint: true })
  board.todos = snapshot(...PLAN)
  for (const width of [7, 12, 21, 40, 80]) {
    const line = plain(board.render(width))[0] ?? ''
    assert.ok(!line.includes('Ctrl+T'), `width ${width} keeps the hint out: ${line}`)
    assert.ok(line.includes('Todos'))
  }
  // The full tray still advertises it at every budget >= 2.
  board.maxRows = 2
  assert.ok(plain(board.render(80))[0]?.includes('Ctrl+T hide'))
})

// ---------------------------------------------------------------------------
// Root composition seams: pure height facts and separator ownership

test('preferred/comfortable/compact rows are pure facts of the native snapshot', () => {
  const board = mount()
  assert.deepEqual([board.preferredRows, board.comfortableRows, board.compactRows], [0, 0, 0])

  board.todos = snapshot(...PLAN)
  assert.deepEqual([board.preferredRows, board.comfortableRows, board.compactRows], [4, 2, 1])
  // A long list is capped exactly like the full tray (header + five tasks).
  board.todos = snapshot(...Array.from({ length: 9 }, (_, index) => ({
    content: `step ${index + 1}`,
    status: 'pending' as const,
  })))
  assert.deepEqual([board.preferredRows, board.comfortableRows, board.compactRows], [6, 2, 1])

  // Finished work and hostile/empty snapshots paint nothing, so they reserve
  // nothing; no synthetic header height is invented.
  board.todos = snapshot({ content: 'done', status: 'completed' })
  assert.deepEqual([board.preferredRows, board.comfortableRows, board.compactRows], [0, 0, 0])
  board.todos = null
  assert.deepEqual([board.preferredRows, board.comfortableRows, board.compactRows], [0, 0, 0])

  // Visibility and disposal are native component facts, not parent re-filtering.
  board.todos = snapshot(...PLAN)
  board.visible = false
  assert.deepEqual([board.preferredRows, board.comfortableRows, board.compactRows], [0, 0, 0])
  board.visible = true
  assert.equal(board.preferredRows, 4)
  board.dispose()
  assert.deepEqual([board.preferredRows, board.comfortableRows, board.compactRows], [0, 0, 0])
})

test('the pure row facts never call render and are independent of the budget', () => {
  const board = mount()
  board.todos = snapshot(...PLAN)
  const original = board.render.bind(board)
  let renders = 0
  board.render = (width: number) => {
    renders += 1
    return original(width)
  }
  for (const budget of [0, 1, 2, 4, 40]) {
    board.maxRows = budget
    assert.equal(board.preferredRows, 4)
    assert.equal(board.comfortableRows, 2)
    assert.equal(board.compactRows, 1)
  }
  assert.equal(renders, 0, 'planning height must not paint')
})

test('a root stack disables the standalone trailing separator without changing defaults', () => {
  const standalone = mount({ maxRows: 8 })
  standalone.todos = snapshot(...PLAN)
  assert.deepEqual(plain(standalone.render(80)).at(-1), '', 'standalone default keeps its gap')

  const root = mount({ maxRows: 8, trailingSeparator: false })
  root.todos = snapshot(...PLAN)
  assert.deepEqual(plain(root.render(80)), [
    '⏺ Todos · 1/3',
    '  ⎿  ☑ Read the current resume flow',
    '     ◐ Extract the picker scope filter',
    '     ☐ Run the ui test suite',
  ])
  assert.equal(root.render(80).length, 4, 'no blank row is charged to the root stack')
  // The compact fallback is unaffected by separator policy.
  root.maxRows = 1
  assert.equal(root.render(80).length, 1)
})
