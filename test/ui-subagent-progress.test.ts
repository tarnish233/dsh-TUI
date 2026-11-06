// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from '#pi-tui'
import type { SubagentEntry } from '../src/backend/types.ts'
import { SubagentProgress } from '../src/ui/subagent-progress.ts'
import { loadInputModule } from '../src/input/testing/harness.ts'

const input = await loadInputModule()

/** Deterministic clock: native session totals must never read the wall clock. */
const NOW = 1_000_000

const keymap = () => input.createCcKeymap()

const entry = (overrides: Partial<SubagentEntry> = {}): SubagentEntry => ({
  id: 'child-1',
  parentSessionId: 's1',
  mode: 'one-shot',
  status: 'running',
  ...overrides,
})

interface Harness {
  progress: SubagentProgress
  opened: string[]
  agents: number
  renders: number
}

function mount(options: {
  maxRows?: number | (() => number)
  mouseBlocked?: boolean | (() => boolean)
  onOpenChild?: (entry: SubagentEntry) => void
  keymap?: ReturnType<typeof keymap>
  withChild?: boolean
} = {}): Harness {
  const opened: string[] = []
  const state: Harness = { progress: undefined as unknown as SubagentProgress, opened, agents: 0, renders: 0 }
  state.progress = new SubagentProgress({
    keymap: options.keymap ?? keymap(),
    // A host accessor is the parent's shape: re-sampled on every paint.
    get maxRows() {
      const value = options.maxRows
      return typeof value === 'function' ? value() : value ?? 8
    },
    ...(options.mouseBlocked === undefined ? {} : { mouseBlocked: options.mouseBlocked }),
    onOpenAgents: () => {
      state.agents += 1
    },
    ...(options.withChild === false ? {} : {
      onOpenChild: (child: SubagentEntry) => {
        opened.push(child.id)
        options.onOpenChild?.(child)
      },
    }),
    onRenderRequest: () => {
      state.renders += 1
    },
    now: () => NOW,
  })
  return state
}

const plain = (lines: readonly string[]): string[] => lines.map(line => stripTerminalSequences(line))

/** Display column where `needle` starts in one plain painted line. */
function colOf(line: string, needle: string): number {
  const index = line.indexOf(needle)
  assert.ok(index >= 0, `missing ${JSON.stringify(needle)} in ${JSON.stringify(line)}`)
  return visibleWidth(line.slice(0, index))
}

function assertWidths(lines: readonly string[], width: number, label: string): void {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `${label}: width ${width} got ${visibleWidth(line)} :: ${JSON.stringify(stripTerminalSequences(line))}`,
    )
  }
}

function mouse(
  type: TuiMouseEvent['type'],
  x: number,
  y: number,
  overrides: Partial<TuiMouseEvent> = {},
): TuiMouseEvent {
  return {
    type,
    x,
    y,
    button: 'left',
    screenX: x + 4,
    screenY: y + 10,
    width: 80,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
    ...overrides,
  }
}

/** One full click gesture at component-local (x, y). */
function click(progress: SubagentProgress, x: number, y: number): void {
  progress.handleMouse(mouse('press', x, y))
  progress.handleMouse(mouse('click', x, y))
}

// ---------------------------------------------------------------------------
// Layout and visual shape

test('renders nothing at all for an empty catalog: no spacer, no hitbox', () => {
  const h = mount()
  assert.deepEqual(h.progress.render(80), [])
  // There is no row to click and no header to open.
  assert.equal(h.progress.handleMouse(mouse('click', 3, 0)), undefined)
  assert.equal(h.agents, 0)
  // Setting entries and clearing them again returns to a truly empty frame.
  h.progress.entries = [entry({ status: 'idle' })]
  assert.notEqual(h.progress.render(80).length, 0)
  h.progress.entries = []
  assert.deepEqual(h.progress.render(80), [])
})

test('running child matches the Pi above-editor shape with native metrics only', () => {
  const h = mount()
  h.progress.entries = [entry({
    id: 'child-1',
    label: 'frontend-developer',
    mode: 'continuable',
    status: 'running',
    lastActivity: "I'll start by reading the project instructions",
    totalTokens: 75_900,
    provider: 'deepseek',
    model: 'deepseek-chat',
    timing: { settledMs: 0, activeSince: NOW - 90_400 },
  })]
  assert.deepEqual(plain(h.progress.render(100)), [
    '● Agents · 1 child · Ctrl+X Ctrl+A open',
    '└─ ⏺ frontend-developer  continuable · running · 1m 30s · 76k tok · deepseek/deepseek-chat',
    "     ⎿  I'll start by reading the project instructions",
    '',
  ])
  // At 80 columns the native route is the first extra to go; status/timing stay.
  const narrow = plain(h.progress.render(80))
  assert.ok(narrow[1]?.includes('running'), narrow.join('\n'))
  assert.ok(narrow[1]?.includes('1m 30s'), narrow.join('\n'))
  assert.ok(!narrow[1]?.includes('deepseek/deepseek-chat'), narrow.join('\n'))
})

test('no invented Pi metrics: no turns, tool-use count, context percent or cost', () => {
  const h = mount()
  h.progress.entries = [entry({
    label: 'review',
    status: 'running',
    lastActivity: 'reading src/app.ts',
    totalTokens: 2_400,
    timing: { settledMs: 3_000 },
  })]
  const text = plain(h.progress.render(120)).join('\n')
  assert.ok(text.includes('2.4k tok'), text)
  assert.ok(text.includes('3s'), text)
  for (const invented of ['↻', 'tool uses', 'tool use', '%', '~$', 'token (']) {
    assert.ok(!text.includes(invented), `row must not invent ${invented}: ${text}`)
  }
})

test('native status vocabulary: continuable completion, external leaf, one-shot completion', () => {
  const h = mount({ maxRows: 10 })
  h.progress.entries = [
    entry({ id: 'cont', label: 'Continuable', mode: 'continuable', status: 'completed', timing: { lastTurnCompleted: true } }),
    entry({ id: 'once', label: 'One shot', mode: 'one-shot', status: 'completed' }),
    entry({ id: 'ext', label: 'External task', mode: 'external', status: 'external' }),
    entry({ id: 'fail', label: 'Broken', mode: 'one-shot', status: 'failed', lastActivity: 'stale prose is not live work' }),
    entry({ id: 'init', label: 'Starting', mode: 'one-shot', status: 'initializing' }),
  ]
  const lines = plain(h.progress.render(100))
  assert.deepEqual(lines, [
    '● Agents · 5 children · Ctrl+X Ctrl+A open',
    '├─ ⏺ Starting  one-shot · initializing',
    '├─ ● Continuable  continuable · last run completed · idle',
    '├─ ● One shot  one-shot · completed',
    '├─ ◌ External task  external',
    '└─ ● Broken  one-shot · failed',
    '',
  ])
  // Only a `running` child may show an activity line.
  assert.ok(!lines.join('\n').includes('stale prose'), 'a settled activity is never presented as live')
})

test('all settled children dim the heading but keep the ● marker', () => {
  const h = mount()
  h.progress.entries = [entry({ label: 'Idle', mode: 'continuable', status: 'idle' })]
  const lines = h.progress.render(60)
  assert.deepEqual(plain(lines), ['● Agents · 1 child · Ctrl+X Ctrl+A open', '└─ ◌ Idle  continuable · idle', ''])
  assert.ok(lines[0]?.includes('\x1b[2m'), 'an idle catalog uses the dim heading tier')
})

test('native truncated catalog is stated honestly in the header', () => {
  const h = mount()
  h.progress.entries = [entry({ label: 'A', status: 'running' })]
  h.progress.truncated = true
  assert.ok(plain(h.progress.render(100))[0]?.includes('incomplete'))
  h.progress.truncated = false
  assert.ok(!plain(h.progress.render(100))[0]?.includes('incomplete'))
})

// ---------------------------------------------------------------------------
// Budget: bounded rows, activity priority, overflow count

test('budget is a hard total including header, rows, overflow and separator', () => {
  for (const budget of [1, 2, 3, 4, 5, 6, 8]) {
    const h = mount({ maxRows: budget })
    h.progress.entries = [
      entry({ id: 'run-a', label: 'Run A', status: 'running', lastActivity: 'reading a' }),
      entry({ id: 'run-b', label: 'Run B', status: 'running', lastActivity: 'reading b' }),
      entry({ id: 'done-a', label: 'Done A', status: 'completed' }),
      entry({ id: 'done-b', label: 'Done B', status: 'failed' }),
      entry({ id: 'idle-a', label: 'Idle A', status: 'idle' }),
    ]
    const lines = h.progress.render(80)
    assert.ok(lines.length <= budget, `budget ${budget} produced ${lines.length} lines`)
    assert.ok(lines.length >= 1, `budget ${budget} still paints the header`)
  }
  // A zero/negative budget paints nothing, never a spacer.
  const zero = mount({ maxRows: 0 })
  zero.progress.entries = [entry()]
  assert.deepEqual(zero.progress.render(80), [])
  const negative = mount({ maxRows: -3 })
  negative.progress.entries = [entry()]
  assert.deepEqual(negative.progress.render(80), [])
})

test('a dynamic budget getter is re-sampled on every render', () => {
  let budget = 4
  const h = mount({ maxRows: () => budget })
  h.progress.entries = [
    entry({ id: 'a', label: 'A', status: 'running' }),
    entry({ id: 'b', label: 'B', status: 'running' }),
    entry({ id: 'c', label: 'C', status: 'idle' }),
  ]
  assert.ok(h.progress.render(80).length <= 4)
  budget = 8
  const wide = h.progress.render(80)
  assert.ok(wide.length > 4, 'a larger budget shows more rows')
  assert.ok(wide.length <= 8)
  budget = 0
  assert.deepEqual(h.progress.render(80), [])
})

test('active rows are prioritized and an overflow count replaces unbounded history', () => {
  const h = mount({ maxRows: 4 })
  h.progress.entries = [
    entry({ id: 'idle-a', label: 'Idle A', status: 'idle' }),
    entry({ id: 'done-a', label: 'Done A', status: 'completed' }),
    entry({ id: 'run-a', label: 'Run A', status: 'running' }),
    entry({ id: 'run-b', label: 'Run B', status: 'running' }),
  ]
  // Two live rows outrank the settled history, which is summarized by status.
  assert.deepEqual(plain(h.progress.render(80)), [
    '● Agents · 4 children · Ctrl+X Ctrl+A open',
    '├─ ⏺ Run A  one-shot · running',
    '├─ ⏺ Run B  one-shot · running',
    '└─ +2 more (1 idle, 1 completed)',
  ])
})

test('a tight budget keeps the running row and the count, not the activity line', () => {
  const h = mount({ maxRows: 3 })
  h.progress.entries = [
    entry({ id: 'run', label: 'Run', status: 'running', lastActivity: 'reading src/app.ts' }),
    entry({ id: 'other', label: 'Other', status: 'idle' }),
    entry({ id: 'third', label: 'Third', status: 'completed' }),
  ]
  assert.deepEqual(plain(h.progress.render(80)), [
    '● Agents · 3 children · Ctrl+X Ctrl+A open',
    '├─ ⏺ Run  one-shot · running',
    '└─ +2 more (1 idle, 1 completed)',
  ])
  // A roomier frame spends its extra lines on the real activity first.
  const wider = mount({ maxRows: 5 })
  wider.progress.entries = h.progress.entries
  const lines = plain(wider.progress.render(80))
  assert.ok(lines.includes('│    ⎿  reading src/app.ts'), lines.join('\n'))
  assert.equal(lines.length, 5)
})

test('three live children keep their two-line Pi shape under the cap while history collapses', () => {
  const h = mount({ maxRows: 8 })
  h.progress.entries = [
    entry({ id: 'run-a', label: 'Run A', status: 'running', lastActivity: 'reading src/app.ts' }),
    entry({ id: 'run-b', label: 'Run B', status: 'running', lastActivity: 'editing src/ui/blocks.ts' }),
    entry({ id: 'run-c', label: 'Run C', status: 'running', lastActivity: 'searching for callers' }),
    entry({ id: 'done-a', label: 'Done A', status: 'completed' }),
    entry({ id: 'done-b', label: 'Done B', status: 'failed' }),
    entry({ id: 'idle-a', label: 'Idle A', status: 'idle' }),
    entry({ id: 'idle-b', label: 'Idle B', status: 'idle' }),
    entry({ id: 'ext', label: 'Ext', mode: 'external', status: 'external' }),
  ]
  assert.deepEqual(plain(h.progress.render(80)), [
    '● Agents · 8 children · Ctrl+X Ctrl+A open',
    '├─ ⏺ Run A  one-shot · running',
    '│    ⎿  reading src/app.ts',
    '├─ ⏺ Run B  one-shot · running',
    '│    ⎿  editing src/ui/blocks.ts',
    '├─ ⏺ Run C  one-shot · running',
    '│    ⎿  searching for callers',
    '└─ +5 more (1 completed, 1 failed, 2 idle, 1 external)',
  ])
})

test('only a budget that cannot hold the pair degrades a live row to its summary', () => {
  const entries = [
    entry({ id: 'run-a', label: 'Run A', status: 'running', lastActivity: 'reading a' }),
    entry({ id: 'run-b', label: 'Run B', status: 'running', lastActivity: 'reading b' }),
    entry({ id: 'done-a', label: 'Done A', status: 'completed' }),
  ]
  const roomy = mount({ maxRows: 7 })
  roomy.progress.entries = entries
  const roomyLines = plain(roomy.progress.render(80))
  assert.ok(roomyLines.includes('│    ⎿  reading a'), roomyLines.join('\n'))
  assert.ok(roomyLines.includes('│    ⎿  reading b'), roomyLines.join('\n'))
  assert.equal(roomyLines.length, 7)

  // Two lines short: the second pair loses its activity line, not the row, and
  // the finished child is never promoted above a live one.
  const tight = mount({ maxRows: 4 })
  tight.progress.entries = entries
  const tightLines = plain(tight.progress.render(80))
  assert.ok(tightLines[1]?.includes('Run A'), tightLines.join('\n'))
  assert.ok(tightLines.includes('│    ⎿  reading a'), tightLines.join('\n'))
  assert.ok(!tightLines.join('\n').includes('reading b'), tightLines.join('\n'))
  assert.ok(!tightLines.join('\n').includes('Done A'), tightLines.join('\n'))
})

test('the separator is the lowest-priority line and never overflows the budget', () => {
  const h = mount({ maxRows: 3 })
  h.progress.entries = [entry({ id: 'a', label: 'A', status: 'running', lastActivity: 'busy' })]
  // header + row + activity exactly fills the budget: no trailing separator.
  assert.deepEqual(plain(h.progress.render(80)), [
    '● Agents · 1 child · Ctrl+X Ctrl+A open',
    '└─ ⏺ A  one-shot · running',
    '     ⎿  busy',
  ])
  const roomy = mount({ maxRows: 4 })
  roomy.progress.entries = h.progress.entries
  assert.deepEqual(plain(roomy.progress.render(80)).at(-1), '')
})

// ---------------------------------------------------------------------------
// Reply target

test('the reply target is pinned first and marked; removing it restores native order', () => {
  const h = mount({ maxRows: 8 })
  h.progress.entries = [
    entry({ id: 'run', label: 'Run', status: 'running' }),
    entry({ id: 'target', label: 'Target', mode: 'continuable', status: 'idle' }),
  ]
  h.progress.replyTargetId = 'target'
  const lines = plain(h.progress.render(100))
  assert.ok(lines[1]?.includes('Target'), lines.join('\n'))
  assert.ok(lines[1]?.includes('reply target'), lines.join('\n'))
  assert.ok(lines[2]?.includes('Run'), lines.join('\n'))
  h.progress.replyTargetId = undefined
  const restored = plain(h.progress.render(100))
  assert.ok(restored[1]?.includes('Run'), restored.join('\n'))
  assert.ok(!restored.join('\n').includes('reply target'))
})

test('an unknown reply target id is ignored instead of inventing a row', () => {
  const h = mount()
  h.progress.entries = [entry({ id: 'a', label: 'A', status: 'running' })]
  h.progress.replyTargetId = 'ghost'
  assert.deepEqual(plain(h.progress.render(80)), [
    '● Agents · 1 child · Ctrl+X Ctrl+A open',
    '└─ ⏺ A  one-shot · running',
    '',
  ])
})

// ---------------------------------------------------------------------------
// Header shortcut honesty

test('the header advertises the effective Agents chord, including remap and disable', () => {
  const custom = input.createCcKeymap({ bindings: { 'app.subagents.details': 'ctrl+x ctrl+g' } })
  const remapped = mount({ keymap: custom })
  remapped.progress.entries = [entry({ label: 'A', status: 'running' })]
  const remappedHeader = plain(remapped.progress.render(120))[0] ?? ''
  assert.ok(remappedHeader.includes('Ctrl+X Ctrl+G open'), remappedHeader)
  assert.ok(!remappedHeader.includes('Ctrl+A'), remappedHeader)

  const disabled = input.createCcKeymap({ bindings: { 'app.subagents.details': null } })
  const off = mount({ keymap: disabled })
  off.progress.entries = [entry({ label: 'A', status: 'running' })]
  const disabledHeader = plain(off.progress.render(120))[0] ?? ''
  assert.ok(!disabledHeader.includes('open'), disabledHeader)
  assert.equal(disabledHeader, '● Agents · 1 child')
})

// ---------------------------------------------------------------------------
// Width safety

test('CJK, emoji, hostile ANSI and every column count stay within the width', () => {
  const h = mount({ maxRows: 8 })
  h.progress.entries = [
    entry({
      id: 'cjk',
      label: '探索仓库 🚀 子代理',
      mode: 'continuable',
      status: 'running',
      lastActivity: '\x1b[31m读取\x1b[0m src/state/transcript.ts 并总结 🧭 结论',
      totalTokens: 123_456,
      provider: 'deepseek',
      model: 'deepseek-chat',
      timing: { settledMs: 12_300 },
    }),
    entry({ id: 'emoji', label: '👩‍💻 reviewer', mode: 'one-shot', status: 'failed' }),
    entry({ id: 'dots', label: 'a'.repeat(200), mode: 'unknown', status: 'unknown' }),
  ]
  for (const width of [1, 2, 5, 20, 40, 80, 120]) {
    const lines = h.progress.render(width)
    assertWidths(lines, width, `width ${width}`)
    // Nothing may contain a raw ESC from a hostile label once rendered.
    for (const line of plain(lines)) {
      assert.ok(!line.includes('\x1b'), `sanitized at width ${width}`)
    }
  }
})

test('narrow rows degrade to label plus native status before anything overflows', () => {
  const h = mount()
  h.progress.entries = [entry({ label: 'Explore the repository', mode: 'continuable', status: 'running' })]
  const narrow = plain(h.progress.render(24))
  assert.ok(narrow[1]?.includes('running'), narrow.join('\n'))
  assert.ok(!narrow[1]?.includes('continuable'), 'mode is dropped before the status')
  assertWidths(h.progress.render(24), 24, 'narrow')
})

// ---------------------------------------------------------------------------
// Mouse affordances

/**
 * Row 0 is the header, row 1 the first child, row 2 its activity line.
 */
function mouseFixture() {
  const h = mount({ maxRows: 8 })
  h.progress.entries = [
    entry({ id: 'run', label: 'Run', status: 'running', lastActivity: 'reading src/app.ts' }),
    entry({ id: 'idle', label: 'Idle', status: 'idle' }),
    entry({ id: 'ext', label: 'External', mode: 'external', status: 'external' }),
  ]
  const lines = plain(h.progress.render(80))
  assert.deepEqual(lines, [
    '● Agents · 3 children · Ctrl+X Ctrl+A open',
    '├─ ⏺ Run  one-shot · running',
    '│    ⎿  reading src/app.ts',
    '├─ ◌ Idle  one-shot · idle',
    '└─ ◌ External  external',
    '',
  ])
  return h
}

test('only the painted child name opens a child; the rest of the row is selection text', () => {
  const h = mouseFixture()
  const lines = plain(h.progress.render(80))
  const row = lines[1] ?? ''
  const name = colOf(row, 'Run')
  const nameEnd = name + visibleWidth('Run') - 1
  assert.equal(name, visibleWidth('├─ ⏺ '), 'the link starts after the guide, glyph and both gaps')
  // Branch guide, spaces, the status glyph and the gap after the name are inert.
  for (const x of [0, 1, 2, 3, 4, nameEnd + 1, nameEnd + 2]) {
    assert.equal(h.progress.handleMouse(mouse('press', x, 1)), undefined, `col ${x} must stay unclaimed`)
  }
  // Mode/status/metrics are plain text, so is the whole activity line.
  assert.equal(h.progress.handleMouse(mouse('press', colOf(row, 'one-shot'), 1)), undefined)
  assert.equal(h.progress.handleMouse(mouse('press', colOf(row, 'running'), 1)), undefined)
  const activity = lines[2] ?? ''
  const activityCol = colOf(activity, 'reading')
  assert.equal(h.progress.handleMouse(mouse('press', activityCol, 2)), undefined)
  click(h.progress, activityCol, 2)
  assert.deepEqual(h.opened, [], 'the activity line never navigates')
  assert.equal(h.agents, 0)
  // The first and the last display column of the name do navigate.
  click(h.progress, name, 1)
  assert.deepEqual(h.opened, ['run'])
  click(h.progress, nameEnd, 1)
  assert.deepEqual(h.opened, ['run', 'run'])
  // The other painted child uses the same name-only geometry.
  click(h.progress, colOf(lines[3] ?? '', 'Idle') + 1, 3)
  assert.deepEqual(h.opened, ['run', 'run', 'idle'])
})

test('the Agents heading word is the only header link', () => {
  const h = mouseFixture()
  const header = plain(h.progress.render(80))[0] ?? ''
  const word = colOf(header, 'Agents')
  const wordEnd = word + visibleWidth('Agents') - 1
  // Bullet and the space before the word are not links.
  assert.equal(h.progress.handleMouse(mouse('press', 0, 0)), undefined)
  assert.equal(h.progress.handleMouse(mouse('press', 1, 0)), undefined)
  // The child count and the advertised chord are not links.
  assert.equal(h.progress.handleMouse(mouse('press', colOf(header, '3 children'), 0)), undefined)
  assert.equal(h.progress.handleMouse(mouse('press', colOf(header, 'Ctrl+X'), 0)), undefined)
  click(h.progress, wordEnd, 0)
  assert.equal(h.agents, 1)
  click(h.progress, word, 0)
  assert.equal(h.agents, 2)
  assert.deepEqual(h.opened, [])
})

test('hover is offered only on link text and only brightens that link', () => {
  const h = mouseFixture()
  const resting = h.progress.render(80)
  const row = plain(resting)[1] ?? ''
  const status = colOf(row, 'running')
  // Non-link cells never enter a hover state: no repaint is requested.
  assert.equal(h.progress.handleMouse(mouse('move', status, 1)), undefined)
  assert.equal(h.renders, 0)
  // The name link takes hover and asks the host for exactly one repaint.
  assert.equal(h.progress.handleMouse(mouse('move', colOf(row, 'Run'), 1)), undefined)
  assert.equal(h.renders, 1)
  const hovered = h.progress.render(80)
  assert.notEqual(hovered[1], resting[1], 'the hovered link is painted brighter')
  assert.equal((hovered[1] ?? '').split('\x1b[4m').length - 1, 1, 'only the label text is underlined')
  assert.deepEqual(plain(hovered), plain(resting), 'hover never changes layout or text')
  // Leaving the link restores the resting paint and repaints once more.
  assert.equal(h.progress.handleMouse(mouse('move', status, 1)), undefined)
  assert.equal(h.renders, 2)
  assert.deepEqual(h.progress.render(80), resting)
  // A hovered link that disappears is never painted hovered when it comes back.
  const fresh = mouseFixture()
  const restingRow = fresh.progress.render(80)[1]
  h.progress.handleMouse(mouse('move', colOf(row, 'Run'), 1))
  h.progress.entries = [
    entry({ id: 'idle', label: 'Idle', status: 'idle' }),
    entry({ id: 'ext', label: 'External', mode: 'external', status: 'external' }),
  ]
  h.progress.render(80)
  h.progress.entries = fresh.progress.entries
  assert.equal(h.progress.render(80)[1], restingRow)
})

test('an external or absent-callback child is never painted as a fake link', () => {
  const h = mouseFixture()
  const lines = h.progress.render(80)
  const external = lines[4] ?? ''
  assert.ok(!external.includes('\x1b[4m'), 'a non-openable name is never underlined')
  const externalRow = plain(lines)[4] ?? ''
  assert.equal(
    h.progress.handleMouse(mouse('press', colOf(externalRow, 'External'), 4)),
    undefined,
  )
  click(h.progress, colOf(externalRow, 'External'), 4)
  assert.deepEqual(h.opened, [])

  // Without onOpenChild even the reply-target name stays plain text.
  const inert = mount({ withChild: false })
  inert.progress.entries = [entry({ id: 'a', label: 'Inert', status: 'running' })]
  inert.progress.replyTargetId = 'a'
  const inertLines = inert.progress.render(80)
  assert.ok(!(inertLines[1] ?? '').includes('\x1b[4m'), 'no fake link without a callback')
  const inertRow = plain(inertLines)[1] ?? ''
  assert.equal(inert.progress.handleMouse(mouse('press', colOf(inertRow, 'Inert'), 1)), undefined)
})

test('native drag and selection stay unclaimed across every link boundary', () => {
  const h = mouseFixture()
  const row = plain(h.progress.render(80))[1] ?? ''
  const name = colOf(row, 'Run')
  const mode = colOf(row, 'one-shot')
  // A press that began in plain text starts no gesture at all.
  assert.equal(h.progress.handleMouse(mouse('press', mode, 1)), undefined)
  // Dragging into the link is not claimed and never navigates.
  assert.equal(h.progress.handleMouse(mouse('drag', name, 1)), undefined)
  assert.equal(h.progress.handleMouse(mouse('drag', name + 1, 1)), undefined)
  assert.deepEqual(h.opened, [])
  // Leaving a hovered link is unclaimed too, so selection keeps working.
  h.progress.handleMouse(mouse('move', name, 1))
  assert.equal(h.progress.handleMouse(mouse('drag', mode, 1)), undefined)
  // Press inside the link then drag out: no click jump on the synthetic click.
  assert.deepEqual(h.progress.handleMouse(mouse('press', name, 1)), { handled: true })
  assert.equal(h.progress.handleMouse(mouse('drag', mode, 1)), undefined)
  assert.deepEqual(h.progress.handleMouse(mouse('click', name, 1)), { handled: true })
  assert.deepEqual(h.opened, [], 'a drag never becomes a navigation click')
  // The next clean gesture works again.
  click(h.progress, name, 1)
  assert.deepEqual(h.opened, ['run'])
})

test('a press outside a name never navigates when a repaint moves a name under it', () => {
  const h = mount({ maxRows: 4 })
  h.progress.entries = [entry({ id: 'first', label: 'A', status: 'running' })]
  const before = plain(h.progress.render(40))
  const outside = colOf(before[1] ?? '', 'one-shot')
  assert.deepEqual(h.progress.handleMouse(mouse('press', outside, 1)), undefined)
  // A repaint reflows a long label over the old press coordinates.
  h.progress.entries = [entry({ id: 'first', label: 'Long-Label-Here', status: 'running' })]
  const after = plain(h.progress.render(40))
  assert.ok(after[1]?.includes('Long-Label-Here'), after.join('\n'))
  const name = colOf(after[1] ?? '', 'Long-Label-Here')
  assert.ok(outside > name, 'the label now covers the unpressed cell')
  assert.equal(h.progress.handleMouse(mouse('click', outside, 1)), undefined)
  assert.deepEqual(h.opened, [], 'the outside press never becomes navigation')
  // A fresh gesture on the new name does open the child.
  click(h.progress, name, 1)
  assert.deepEqual(h.opened, ['first'])
})

test('external rows are display-only: no hitbox, no callback', () => {
  const h = mouseFixture()
  assert.equal(h.progress.handleMouse(mouse('press', 5, 4)), undefined)
  click(h.progress, 5, 4)
  assert.deepEqual(h.opened, [])
})

test('without onOpenChild the rows paint but stay inert', () => {
  const h = mount({ withChild: false })
  h.progress.entries = [entry({ id: 'a', label: 'A', status: 'running' })]
  const lines = plain(h.progress.render(80))
  assert.ok(lines[1]?.includes('A'))
  assert.equal(h.progress.handleMouse(mouse('press', 5, 1)), undefined)
})

test('hover only requests a repaint on a real transition', () => {
  const h = mouseFixture()
  h.progress.handleMouse(mouse('move', 5, 1))
  assert.equal(h.renders, 1)
  // Same region, new cell: no transition, no repaint.
  h.progress.handleMouse(mouse('move', 6, 1))
  assert.equal(h.renders, 1)
  // Moving onto another row exits the first region and enters the next one.
  h.progress.handleMouse(mouse('move', 5, 3))
  assert.equal(h.renders, 3)
  h.progress.handleMouse(mouse('move', 40, 20))
  assert.equal(h.renders, 4)
  // Hovering nothing repeatedly stays quiet.
  h.progress.handleMouse(mouse('move', 41, 20))
  assert.equal(h.renders, 4)
})

test('mouseBlocked drops every hitbox and never claims an event', () => {
  const h = mouseFixture()
  h.progress.mouseBlocked = true
  h.progress.render(80)
  assert.equal(h.progress.handleMouse(mouse('press', 5, 0)), undefined)
  assert.equal(h.progress.handleMouse(mouse('click', 5, 0)), undefined)
  assert.equal(h.agents, 0)
  assert.deepEqual(h.opened, [])

  // A getter option is also honoured, read on every call.
  let blocked = true
  const g = mount({ mouseBlocked: () => blocked })
  g.progress.entries = [entry({ id: 'a', label: 'A', status: 'running' })]
  g.progress.render(80)
  assert.equal(g.progress.handleMouse(mouse('press', 5, 1)), undefined)
  blocked = false
  g.progress.render(80)
  click(g.progress, 5, 1)
  assert.deepEqual(g.opened, ['a'])
})

test('a vanished child cannot retarget the row that lands on its old coordinates', () => {
  const h = mount({ maxRows: 8 })
  h.progress.entries = [
    entry({ id: 'gone', label: 'Gone', status: 'running' }),
    entry({ id: 'stays', label: 'Stays', status: 'idle' }),
  ]
  h.progress.render(80)
  // Press on the first child row, then the catalog removes it.
  assert.deepEqual(h.progress.handleMouse(mouse('press', 5, 1)), { handled: true })
  h.progress.entries = [entry({ id: 'stays', label: 'Stays', status: 'idle' })]
  const lines = plain(h.progress.render(80))
  assert.ok(lines[1]?.includes('Stays'), lines.join('\n'))
  // The synthesized click must not open whatever now occupies row 1.
  h.progress.handleMouse(mouse('click', 5, 1))
  assert.deepEqual(h.opened, [])
})

test('press-pinning keeps the same child id across a reorder', () => {
  const h = mount({ maxRows: 8 })
  h.progress.entries = [
    entry({ id: 'first', label: 'First', status: 'running' }),
    entry({ id: 'second', label: 'Second', status: 'running' }),
  ]
  h.progress.render(80)
  h.progress.handleMouse(mouse('press', 5, 1))
  // The first child settles: the active row order changes under the pointer.
  h.progress.entries = [
    entry({ id: 'first', label: 'First', status: 'completed' }),
    entry({ id: 'second', label: 'Second', status: 'running' }),
  ]
  const lines = plain(h.progress.render(80))
  assert.ok(lines[1]?.includes('Second'), lines.join('\n'))
  h.progress.handleMouse(mouse('click', 5, 1))
  assert.deepEqual(h.opened, ['first'], 'the pressed child id is what opens')
})

test('invalidate between press and release cancels the gesture even for the same child id', () => {
  const h = mount({ maxRows: 8 })
  h.progress.entries = [entry({ id: 'run', label: 'Run', status: 'running' })]
  h.progress.render(80)
  h.progress.handleMouse(mouse('press', 5, 1))
  // Attachment replacement: same child id, different native attachment.
  h.progress.invalidate()
  h.progress.entries = [entry({ id: 'run', label: 'Run', status: 'running' })]
  h.progress.render(80)
  const result = h.progress.handleMouse(mouse('click', 5, 1))
  assert.deepEqual(result, { handled: true })
  assert.deepEqual(h.opened, [], 'a stale click must not read the new attachment')
  // A fresh gesture on the same frame works again.
  click(h.progress, 5, 1)
  assert.deepEqual(h.opened, ['run'])
})

test('an outside press survives invalidate: a grown same-id name never receives its click', () => {
  const h = mount({ maxRows: 4 })
  h.progress.entries = [entry({ id: 'first', label: 'A', status: 'running' })]
  const before = plain(h.progress.render(40))
  const outside = colOf(before[1] ?? '', 'one-shot')
  assert.deepEqual(h.progress.handleMouse(mouse('press', outside, 1)), undefined)
  // Same child id, but the attachment was replaced and the label grew under
  // the press coordinate.
  h.progress.invalidate()
  h.progress.entries = [entry({ id: 'first', label: 'Long-Label-Here', status: 'running' })]
  const after = plain(h.progress.render(40))
  const name = colOf(after[1] ?? '', 'Long-Label-Here')
  assert.ok(outside > name, 'the grown label covers the old press coordinate')
  // The release still belongs to the renderer: unhandled, no navigation.
  assert.equal(h.progress.handleMouse(mouse('click', outside, 1)), undefined)
  assert.deepEqual(h.opened, [])
  // A real new press on the now-visible name works again.
  click(h.progress, name, 1)
  assert.deepEqual(h.opened, ['first'])
})

test('a temporary mouseBlocked interval never revives a stale click', () => {
  const h = mouseFixture()
  const row = plain(h.progress.render(80))[1] ?? ''
  const name = colOf(row, 'Run')
  const status = colOf(row, 'running')

  // Claimed press, a dialog opens and closes, then the synthesized click lands.
  assert.deepEqual(h.progress.handleMouse(mouse('press', name, 1)), { handled: true })
  h.progress.mouseBlocked = true
  h.progress.render(80)
  h.progress.mouseBlocked = false
  h.progress.render(80)
  assert.deepEqual(h.progress.handleMouse(mouse('click', name, 1)), { handled: true })
  assert.deepEqual(h.opened, [], 'the dialog-voided claimed press is swallowed')

  // Outside press across the same interval: unhandled, never navigation.
  assert.equal(h.progress.handleMouse(mouse('press', status, 1)), undefined)
  h.progress.mouseBlocked = true
  h.progress.render(80)
  h.progress.mouseBlocked = false
  h.progress.render(80)
  assert.equal(h.progress.handleMouse(mouse('click', name, 1)), undefined)
  assert.deepEqual(h.opened, [])

  // A press that happens while blocked is never claimed and leaves the
  // renderer's selection alone when the dialog closes.
  h.progress.mouseBlocked = true
  assert.equal(h.progress.handleMouse(mouse('press', name, 1)), undefined)
  h.progress.mouseBlocked = false
  h.progress.render(80)
  assert.equal(h.progress.handleMouse(mouse('click', name, 1)), undefined)
  assert.deepEqual(h.opened, [])

  // A fresh press still navigates.
  click(h.progress, name, 1)
  assert.deepEqual(h.opened, ['run'])
})

test('a click without a claimed press keeps working for the header', () => {
  const h = mouseFixture()
  h.progress.handleMouse(mouse('click', 5, 0))
  assert.equal(h.agents, 1)
})

test('the overflow +N more text is the only overflow link', () => {
  const entries = [
    entry({ id: 'run-a', label: 'Run A', status: 'running' }),
    entry({ id: 'run-b', label: 'Run B', status: 'running' }),
    entry({ id: 'done-a', label: 'Done A', status: 'completed' }),
    entry({ id: 'done-b', label: 'Done B', status: 'idle' }),
    entry({ id: 'done-c', label: 'Done C', status: 'failed' }),
  ]
  const h = mount({ maxRows: 5 })
  h.progress.entries = entries
  const lines = plain(h.progress.render(80))
  assert.deepEqual(lines, [
    '● Agents · 5 children · Ctrl+X Ctrl+A open',
    '├─ ⏺ Run A  one-shot · running',
    '├─ ⏺ Run B  one-shot · running',
    '├─ ● Done A  one-shot · completed',
    '└─ +2 more (1 idle, 1 failed)',
  ])
  const overflow = lines[4] ?? ''
  const count = colOf(overflow, '+2 more')
  const countEnd = count + visibleWidth('+2 more') - 1
  assert.equal(count, visibleWidth('└─ '), 'the count starts after the guide and its space')
  // The tree guide, its space and the parenthesized grouped counts are inert.
  for (const x of [0, 1, 2, countEnd + 1]) {
    assert.equal(h.progress.handleMouse(mouse('press', x, 4)), undefined, `col ${x} must stay unclaimed`)
  }
  click(h.progress, colOf(overflow, '(1 idle'), 4)
  assert.equal(h.agents, 0, 'grouped status counts never navigate')
  click(h.progress, countEnd, 4)
  assert.equal(h.agents, 1, 'the count opens the existing Agents list')
  click(h.progress, count, 4)
  assert.equal(h.agents, 2)
  assert.deepEqual(h.opened, [])

  // Without any open callback the count stays a plain, inert line.
  const inert = new SubagentProgress({ keymap: keymap(), now: () => NOW, maxRows: 5 })
  inert.entries = entries
  const inertLines = plain(inert.render(80))
  assert.ok(inertLines[4]?.startsWith('└─ +'), inertLines.join('\n'))
  assert.ok(!(inert.render(80)[4] ?? '').includes('\x1b[4m'), 'no fake overflow link')
  assert.equal(inert.handleMouse(mouse('press', colOf(inertLines[4] ?? '', '+2 more'), 4)), undefined)
})

test('a claimed name press stays pinned to its child across a resize reflow', () => {
  const h = mount({ maxRows: 4 })
  h.progress.entries = [entry({ id: 'wide', label: 'frontend-developer', status: 'running' })]
  const row = plain(h.progress.render(80))[1] ?? ''
  const name = colOf(row, 'frontend-developer')
  assert.deepEqual(h.progress.handleMouse(mouse('press', name, 1)), { handled: true })
  // The name geometry shrinks, but the pressed link is still the same child.
  assert.ok((plain(h.progress.render(20))[1] ?? '').includes('front…'))
  assert.equal(h.progress.handleMouse(mouse('click', name, 1))?.handled, true)
  assert.deepEqual(h.opened, ['wide'])
})

test('a resize that clips the pressed name away vetoes the click', () => {
  // At width 5 the label starts on the first clipped column: no link is painted.
  const tiny = mount({ maxRows: 4 })
  tiny.progress.entries = [entry({ id: 'wide', label: 'frontend-developer', status: 'running' })]
  const tinyLines = plain(tiny.progress.render(5))
  assert.equal(tinyLines[1], '└─...')
  assert.ok(!tinyLines.join('').includes('front'), 'the label text is really clipped away')
  assert.equal(tiny.progress.handleMouse(mouse('press', 4, 1)), undefined)
  click(tiny.progress, 2, 1)
  assert.deepEqual(tiny.opened, [], 'an invisible label has no hitbox at all')

  // A claimed press on the wide name is vetoed once its label disappears.
  const h = mount({ maxRows: 4 })
  h.progress.entries = [entry({ id: 'wide', label: 'frontend-developer', status: 'running' })]
  const name = colOf(plain(h.progress.render(80))[1] ?? '', 'frontend-developer')
  assert.deepEqual(h.progress.handleMouse(mouse('press', name, 1)), { handled: true })
  h.progress.render(5)
  assert.equal(h.progress.handleMouse(mouse('click', name, 1))?.handled, true)
  assert.deepEqual(h.opened, [], 'a clipped-away name never receives the stale click')
})

test('a narrow resize re-derives the name geometry instead of keeping a wide hitbox', () => {
  const h = mount({ maxRows: 4 })
  h.progress.entries = [entry({ id: 'wide', label: 'frontend-developer', status: 'running' })]
  const wideRow = plain(h.progress.render(80))[1] ?? ''
  const wideName = colOf(wideRow, 'frontend-developer')
  const wideEnd = wideName + visibleWidth('frontend-developer') - 1
  click(h.progress, wideEnd, 1)
  assert.deepEqual(h.opened, ['wide'])

  const narrowRow = plain(h.progress.render(20))[1] ?? ''
  const narrowName = colOf(narrowRow, 'front…')
  const narrowEnd = colOf(narrowRow, '…')
  assert.ok(narrowEnd < wideEnd, 'the visible label really shrank')
  assert.equal(h.progress.handleMouse(mouse('press', wideEnd, 1)), undefined, 'the old last column is inert')
  click(h.progress, wideEnd, 1)
  assert.deepEqual(h.opened, ['wide'])
  click(h.progress, narrowEnd, 1)
  assert.deepEqual(h.opened, ['wide', 'wide'])
})

test('link geometry uses display columns for CJK, emoji/ZWJ and combining labels', () => {
  const cases: ReadonlyArray<{ label: string; width: number }> = [
    { label: '探索🚀', width: 6 },
    { label: '👩‍💻', width: 2 },
    { label: 'e\u0301x', width: 2 },
  ]
  for (const { label, width } of cases) {
    const id = `u-${width}-${label}`
    const h = mount({ maxRows: 4 })
    h.progress.entries = [entry({ id, label, status: 'running' })]
    const row = plain(h.progress.render(80))[1] ?? ''
    const name = colOf(row, label)
    assert.equal(name, visibleWidth('├─ ⏺ '), `the link starts after the guide/glyph for ${label}`)
    const end = name + width - 1
    // The gap after the label is not a link.
    assert.equal(h.progress.handleMouse(mouse('press', end + 1, 1)), undefined)
    click(h.progress, end, 1)
    assert.deepEqual(h.opened, [id])
    click(h.progress, name, 1)
    assert.deepEqual(h.opened, [id, id])
  }
})

test('a clipped link covers only its visible cells and never the ellipsis', () => {
  const h = mouseFixture()
  // While the line is clipped, only `width - 3` content cells survive (the
  // shared ellipsis owns three). The heading word starts at column 2, so widths
  // up to 5 leave nothing of it on screen: no hitbox at all.
  for (const width of [2, 3, 4, 5]) {
    h.progress.render(width)
    for (let x = 0; x < width; x += 1) {
      assert.equal(h.progress.handleMouse(mouse('press', x, 0)), undefined, `width ${width} col ${x}`)
    }
  }
  // One surviving cell of the word is still a real link, and only that cell.
  const heading = plain(h.progress.render(6))
  assert.equal(heading[0], '● A...')
  assert.equal(h.progress.handleMouse(mouse('press', 1, 0)), undefined)
  click(h.progress, 2, 0)
  assert.equal(h.agents, 1)
  h.progress.handleMouse(mouse('press', 3, 0))
  assert.equal(h.agents, 1, 'the ellipsis cells never navigate')
  // The child row clips the same way: its one painted label cell is the link,
  // the gap and the shared ellipsis tail are not.
  const row = plain(h.progress.render(10))
  assert.equal(row[1], '├─ ⏺ … ...')
  assert.equal(h.progress.handleMouse(mouse('press', 6, 1)), undefined)
  click(h.progress, 5, 1)
  assert.deepEqual(h.opened, ['run'])
})

test('links are internal hitboxes, never OSC 8 hyperlinks or URLs', () => {
  const h = mouseFixture()
  const lines = h.progress.render(80)
  for (const line of lines) {
    assert.ok(!line.includes('\x1b]8;'), 'no OSC 8 hyperlink may be emitted')
    assert.ok(!/https?:\/\//.test(line), 'no URL text is synthesized')
    assert.ok(!/[a-z]+:\/\//.test(stripTerminalSequences(line)), 'no custom scheme is synthesized')
  }
  // The link affordance is plain SGR: bold brand blue + underline.
  assert.ok((lines[0] ?? '').includes('\x1b[4m'), 'the heading word is underlined')
  assert.ok((lines[1] ?? '').includes('\x1b[4m'), 'the child name is underlined')
  assert.ok((lines[1] ?? '').includes('\x1b[1m'), 'the child name is bold')
})

test('a press whose region vanished and reappeared cannot receive the stale click', () => {
  const h = mount({ maxRows: 8 })
  h.progress.entries = [entry({ id: 'a', label: 'A', status: 'running' })]
  h.progress.render(80)
  h.progress.handleMouse(mouse('press', 5, 1))
  // The child disappears for one frame...
  h.progress.entries = []
  assert.deepEqual(h.progress.render(80), [])
  // ...and comes back with the same id at the same row before the release.
  h.progress.entries = [entry({ id: 'a', label: 'A', status: 'running' })]
  h.progress.render(80)
  assert.deepEqual(h.progress.handleMouse(mouse('click', 5, 1)), { handled: true })
  assert.deepEqual(h.opened, [])
  // The same gesture is clean again.
  click(h.progress, 5, 1)
  assert.deepEqual(h.opened, ['a'])
})

test('stale clicks after every entry disappears stay inert', () => {
  const h = mouseFixture()
  h.progress.entries = []
  assert.deepEqual(h.progress.render(80), [])
  click(h.progress, 5, 1)
  assert.deepEqual(h.opened, [])
  assert.equal(h.agents, 0)
})

test('a narrow frame drops the row hitbox with the row it could not paint', () => {
  const h = mount({ maxRows: 2 })
  h.progress.entries = [
    entry({ id: 'a', label: 'A', status: 'running' }),
    entry({ id: 'b', label: 'B', status: 'idle' }),
  ]
  const lines = plain(h.progress.render(80))
  assert.equal(lines.length, 2)
  // Row 1 is a real child row; row 2 (which does not exist) is inert.
  click(h.progress, 5, 1)
  assert.deepEqual(h.opened, ['a'])
  click(h.progress, 5, 2)
  assert.deepEqual(h.opened, ['a'])
})

// ---------------------------------------------------------------------------
// Lifecycle

test('dispose is idempotent and leaves no hitbox, hover or callback behind', () => {
  const h = mouseFixture()
  h.progress.invalidate()
  h.progress.dispose()
  assert.equal(h.progress.isDisposed, true)
  h.progress.dispose()
  assert.deepEqual(h.progress.render(80), [])
  assert.equal(h.progress.handleMouse(mouse('press', 5, 0)), undefined)
  click(h.progress, 5, 1)
  assert.equal(h.agents, 0)
  assert.deepEqual(h.opened, [])
})

test('catalog duplicates collapse to one row per child id', () => {
  const h = mount()
  h.progress.entries = [
    entry({ id: 'dup', label: 'First', status: 'running' }),
    entry({ id: 'dup', label: 'Second', status: 'idle' }),
  ]
  const lines = plain(h.progress.render(80))
  assert.equal(lines.filter(line => line.includes('First') || line.includes('Second')).length, 1)
  assert.ok(lines[1]?.includes('First'), lines.join('\n'))
})
// ---------------------------------------------------------------------------
// Line safety of native display text

/** Only theme SGR may survive; no CR/LF/TAB and no renderer control escapes. */
function assertSingleRowSafety(lines: readonly string[], label: string): void {
  for (const line of lines) {
    assert.ok(!/[\n\r\t]/.test(line), `${label}: control whitespace leaked: ${JSON.stringify(line)}`)
    const withoutSgr = line.replace(/\x1b\[[0-9;]*m/g, '')
    assert.ok(!withoutSgr.includes('\x1b'), `${label}: non-SGR escape leaked: ${JSON.stringify(line)}`)
  }
}

test('an empty widget skips the host height measurement on idle and resize paints', () => {
  let measurements = 0
  const h = mount({ maxRows: () => { measurements += 1; return 8 } })
  // Construction can inspect the option getter; measure the paint path only.
  const baseline = measurements
  assert.deepEqual(h.progress.render(80), [])
  assert.deepEqual(h.progress.render(40), [])
  assert.equal(measurements, baseline, 'idle/resize paints add no Editor/dialog measurement before a native child exists')
  h.progress.entries = [entry({ id: 'measured-live', status: 'running' })]
  h.progress.render(80)
  assert.equal(measurements, baseline + 1, 'a visible widget still samples its live host budget')
})

test('LF/CRLF/TAB in a native label cannot add rows or leak controls', () => {
  const h = mount({ maxRows: 6 })
  h.progress.entries = [
    entry({ id: 'lf', label: 'first\nsecond', status: 'running', lastActivity: 'reading\nsrc/app.ts' }),
    entry({ id: 'crlf', label: 'windows\r\nlabel\twith\ttabs', status: 'idle' }),
    entry({ id: 'emoji', label: '🚀 探索\r\n子代理', mode: 'continuable', status: 'completed' }),
  ]
  const lines = h.progress.render(80)
  assert.ok(lines.length <= 6, `hard budget kept: ${lines.length}`)
  assertSingleRowSafety(lines, 'label newlines')
  assertWidths(lines, 80, 'label newlines')
  const text = plain(lines).join('|')
  assert.ok(text.includes('first second'), text)
  assert.ok(text.includes('windows label with tabs'), text)
  assert.ok(text.includes('🚀 探索 子代理'), text)
})

test('LF/CRLF/TAB in provider/model/effort flatten before width handling', () => {
  const h = mount({ maxRows: 6 })
  h.progress.entries = [entry({
    id: 'route',
    label: 'Route',
    mode: 'continuable',
    status: 'running',
    lastActivity: 'editing\t适配器\n路由',
    provider: 'deep\nseek',
    model: 'chat\r\n4.5 🧭',
    reasoningEffort: 'max\t',
    totalTokens: 12_300,
    timing: { settledMs: 5_000 },
  })]
  const lines = h.progress.render(120)
  assert.ok(lines.length <= 6, `hard budget kept: ${lines.length}`)
  assertSingleRowSafety(lines, 'route newlines')
  assertWidths(lines, 120, 'route newlines')
  const text = plain(lines).join('|')
  assert.ok(text.includes('deep seek/chat 4.5 🧭 · max'), text)
  assert.ok(text.includes('editing 适配器 路由'), text)
})

test('every width keeps flattened native text single-row at the hard budget', () => {
  for (const width of [1, 12, 20, 40, 80, 120]) {
    const h = mount({ maxRows: 8 })
    h.progress.entries = [
      entry({ id: 'a', label: '\n\nleading and trailing\n\n', status: 'running', lastActivity: '\t\t' }),
      entry({ id: 'b', label: 'line\n'.repeat(80), status: 'idle', provider: 'p\n', model: 'm\n', reasoningEffort: 'e\n' }),
      entry({ id: 'c', label: '👩‍💻\r\nreviewer', status: 'failed' }),
      entry({ id: 'd', label: 'x\ty', status: 'completed' }),
      entry({ id: 'e', label: 'z\n', status: 'running', lastActivity: 'busy\n' }),
    ]
    const lines = h.progress.render(width)
    assert.ok(lines.length <= 8, `width ${width}: budget ${lines.length}`)
    assertSingleRowSafety(lines, `width ${width}`)
    assertWidths(lines, width, `width ${width}`)
  }
})
