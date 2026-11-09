// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from '#pi-tui'
import type { SubagentEntry, TodoItem } from '../src/backend/types.ts'
import type { GoalRead, GoalStateView } from '../src/backend/native-inspection.ts'
import { createCcKeymap } from '../src/input/keymap.ts'
import { GoalProgress } from '../src/ui/goal-progress.ts'
import { StatusDockStack, type StatusDockId, type StatusDockSpan } from '../src/ui/status-dock-stack.ts'
import { SubagentProgress } from '../src/ui/subagent-progress.ts'
import { TodoBoard } from '../src/ui/todo-board.ts'

/**
 * Shared fixed status-dock composition: Todo → Goal → Agents.
 *
 * These tests own only the composition layer. The three members are native
 * projections tested standalone elsewhere; here they are mounted through the
 * stack exactly as the parent will mount them (root `trailingSeparator: false`
 * for Todo/Agents, no per-member budget callbacks).
 */

const NOW = 1_000_000

const TODO_ITEMS: readonly TodoItem[] = Object.freeze([
  Object.freeze({ content: '完成 fixed dock stack 的实现 ✅', status: 'in_progress' as const }),
  Object.freeze({ content: '👨‍👩‍👧‍👦 emoji family with combining é', status: 'pending' as const }),
  Object.freeze({ content: 'previous step', status: 'completed' as const }),
])

const GOAL_VIEW: GoalStateView = Object.freeze({
  id: 'goal-1',
  revision: 3,
  objective: '实现状态区固定布局 🚀 并保持宽度安全',
  phase: 'active',
  maxGoalRounds: 10,
  roundsStarted: 4,
  activation: 'armed',
})

const GOAL_READ: GoalRead = Object.freeze({
  available: true,
  complete: true,
  sessionId: 's1',
  goal: GOAL_VIEW,
})

const agent = (over: Partial<SubagentEntry> = {}): SubagentEntry => ({
  id: 'child-1',
  parentSessionId: 's1',
  mode: 'one-shot',
  status: 'running',
  label: 'frontend-developer',
  lastActivity: '实现编辑框上方固定状态区 · scattered activity',
  ...over,
})

interface Harness {
  readonly stack: StatusDockStack
  readonly todos: TodoBoard
  readonly goal: GoalProgress
  readonly agents: SubagentProgress
  readonly opened: string[]
  agentsOpened: number
}

function mount(options: {
  budget?: number | (() => number)
  agentsEnabled?: boolean | (() => boolean)
  trailingSeparator?: boolean
} = {}): Harness {
  const keymap = createCcKeymap()
  const state: Harness = {
    stack: undefined as unknown as StatusDockStack,
    todos: undefined as unknown as TodoBoard,
    goal: undefined as unknown as GoalProgress,
    agents: undefined as unknown as SubagentProgress,
    opened: [],
    agentsOpened: 0,
  }
  const trailingSeparator = options.trailingSeparator ?? false
  const todos = new TodoBoard({ keymap, trailingSeparator })
  const goal = new GoalProgress()
  const agents = new SubagentProgress({
    keymap,
    trailingSeparator,
    now: () => NOW,
    onOpenAgents: () => {
      state.agentsOpened += 1
    },
    onOpenChild: entry => {
      state.opened.push(entry.id)
    },
  })
  const stack = new StatusDockStack({
    todos,
    goal,
    agents,
    ...(options.budget === undefined ? {} : { maxRows: options.budget }),
    ...(options.agentsEnabled === undefined ? {} : { agentsEnabled: options.agentsEnabled }),
  })
  return Object.assign(state, { stack, todos, goal, agents })
}

/** All three native sections present, in the order the stack must emit them. */
function fill(h: Harness): void {
  h.todos.todos = TODO_ITEMS
  h.goal.status = GOAL_READ
  h.agents.entries = [agent()]
}

const plain = (lines: readonly string[]): string[] => lines.map(line => stripTerminalSequences(line))

function assertWidths(lines: readonly string[], width: number, label: string): void {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `${label}: width ${width} got ${visibleWidth(line)} :: ${JSON.stringify(stripTerminalSequences(line))}`,
    )
  }
}

function ids(spans: readonly StatusDockSpan[]): StatusDockId[] {
  return spans.map(span => span.id)
}

/** Blank rows between adjacent emitted spans (never after the last one). */
function gaps(spans: readonly StatusDockSpan[]): number[] {
  return spans.slice(1).map((span, index) => span.startRow - spans[index]!.endRow - 1)
}

/** Display column where `needle` starts in one plain painted line. */
function colOf(line: string, needle: string): number {
  const index = line.indexOf(needle)
  assert.ok(index >= 0, `missing ${JSON.stringify(needle)} in ${JSON.stringify(line)}`)
  return visibleWidth(line.slice(0, index))
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
    screenY: y + 100,
    width: 80,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Fixed presence and order

test('mounts only the present native sections in fixed Todo → Goal → Agents order', () => {
  const h = mount()
  assert.deepEqual(h.stack.render(80), [])
  assert.deepEqual(h.stack.spans, [])

  h.todos.todos = TODO_ITEMS
  const todoOnly = plain(h.stack.render(80))
  assert.equal(todoOnly.length, 4, 'Todo header + all three native rows')
  assert.match(todoOnly[0]!, /Todos/)
  assert.deepEqual(ids(h.stack.spans), ['todos'])

  h.goal.status = GOAL_READ
  h.stack.render(80)
  assert.deepEqual(ids(h.stack.spans), ['todos', 'goal'])
  const two = plain(h.stack.render(80))
  assert.ok(two.findIndex(line => /Todos/.test(line)) < two.findIndex(line => /Goal/.test(line)))

  h.agents.entries = [agent()]
  h.stack.render(80)
  assert.deepEqual(ids(h.stack.spans), ['todos', 'goal', 'agents'])
  const lines = plain(h.stack.render(80))
  const todoAt = lines.findIndex(line => /Todos/.test(line))
  const goalAt = lines.findIndex(line => /Goal/.test(line))
  const agentsAt = lines.findIndex(line => /Agents/.test(line))
  assert.ok(todoAt >= 0 && todoAt < goalAt && goalAt < agentsAt, lines.join('\n'))
})

test('hidden, empty and settled-only sections consume no row, gap or stale span', () => {
  const h = mount({ budget: 15 })
  fill(h)
  h.stack.render(80)
  assert.deepEqual(ids(h.stack.spans), ['todos', 'goal', 'agents'])
  assert.ok(h.stack.spans.length === 3)

  // Native empty transitions: every section retires on its own native fact.
  h.todos.todos = null
  h.goal.status = Object.freeze({ available: true, complete: true, sessionId: 's1', goal: null })
  h.agents.entries = [agent({ id: 'settled', status: 'completed' })]
  assert.deepEqual(h.stack.render(80), [])
  assert.deepEqual(h.stack.spans, [])
  assert.equal(h.todos.maxRows, 0)
  assert.equal(h.goal.maxRows, 0)
  assert.equal(h.agents.maxRows, 0)

  // Component visibility is a layout fact, not a parent re-filter.
  h.todos.todos = TODO_ITEMS
  h.todos.visible = false
  assert.deepEqual(h.stack.render(80), [])
  h.todos.visible = true
  h.stack.render(80)
  assert.deepEqual(ids(h.stack.spans), ['todos'])

  // The parent's existing Agents enable flag participates before rendering.
  h.todos.todos = null
  h.agents.entries = [agent()]
  h.stack.render(80)
  assert.deepEqual(ids(h.stack.spans), ['agents'], 'the goal is still empty native')
  const disabled = mount({ agentsEnabled: () => false })
  disabled.agents.entries = [agent()]
  assert.deepEqual(disabled.stack.render(80), [], 'disabled Agents reserve nothing')
  disabled.agents.entries = [agent({ status: 'idle' })]
  assert.deepEqual(disabled.stack.render(80), [])
})

test('a zero budget emits no rows even while native sections are present', () => {
  const h = mount({ budget: 0 })
  fill(h)
  assert.deepEqual(h.stack.render(80), [])
  assert.deepEqual(h.stack.spans, [])
  assert.equal(h.todos.maxRows, 0)
  assert.equal(h.goal.maxRows, 0)
  assert.equal(h.agents.maxRows, 0)
})

// ---------------------------------------------------------------------------
// Hard total budget, compact fallback, all-or-none gaps

test('every budget 0..18 stays exact, keeps one compact row per visible dock and never trails', () => {
  for (let budget = 0; budget <= 18; budget += 1) {
    const h = mount({ budget })
    fill(h)
    const lines = h.stack.render(80)
    const spans = h.stack.spans
    const label = `budget ${budget}`
    assert.ok(lines.length <= budget, `${label}: ${lines.length} > ${budget}`)
    assert.equal(spans.length, Math.min(3, budget), `${label}: admitted sections`)
    assert.deepEqual(ids(spans), (['todos', 'goal', 'agents'] as const).slice(0, Math.min(3, budget)))
    for (const span of spans) {
      assert.equal(span.rows, span.endRow - span.startRow + 1)
      assert.ok(span.rows >= 1)
      assert.ok(span.startRow >= 0 && span.endRow < lines.length)
      assert.ok(plain(lines.slice(span.startRow, span.endRow + 1)).some(line => line !== ''), label)
    }
    if (budget < 3) {
      assert.equal(spans.reduce((total, span) => total + span.rows, 0), budget)
      assert.ok(gaps(spans).every(value => value === 0), `${label}: no gap before every dock has a row`)
    }
    // All-or-none: every adjacent pair has the same gap value (0 or 1).
    const gapRows = gaps(spans)
    assert.ok(gapRows.every(value => value === 0) || gapRows.every(value => value === 1), `${label}: ${gapRows}`)
    if (budget > 0) {
      assert.notEqual(plain(lines).at(-1), '', `${label}: no after-last spacer`)
      assert.equal(spans.at(-1)!.endRow, lines.length - 1)
    }
    // Gaps are bought only once all three comfortable heights fit beside them.
    if (spans.length === 3) {
      const expectedGap = budget >= 8 ? 1 : 0
      assert.deepEqual(gapRows, expectedGap === 1 ? [1, 1] : [0, 0], `${label}: uniform tight/comfortable`)
      // Real content is 11 rows (Todo4 + gap + Goal2 + gap + Agents3).
      assert.equal(lines.length, Math.min(budget, 11), `${label}: content priority exact`)
    }
  }
})

test('content priority: a task+header, objective and first child name precede gaps', () => {
  const h = mount({ budget: 3 })
  fill(h)
  const compact = plain(h.stack.render(80))
  assert.equal(compact.length, 3)
  assert.match(compact[0]!, /Todos · 1\/3 · .*完成 fixed dock stack/)
  assert.match(compact[1]!, /Goal/)
  assert.match(compact[2]!, /Agents/)

  const four = mount({ budget: 4 })
  fill(four)
  const lines4 = plain(four.stack.render(80))
  assert.equal(lines4.length, 4)
  assert.match(lines4[0]!, /Todos/)
  assert.match(lines4[1]!, /完成 fixed dock stack/, 'Todo header + first task before anything else')
  assert.match(lines4[2]!, /Goal/)
  assert.doesNotMatch(lines4[2]!, /实现状态区固定布局/, 'Goal objective waits for its comfortable row')
  assert.match(lines4[3]!, /Agents/)
  assert.doesNotMatch(lines4.join('\n'), /frontend-developer/, 'first child name waits for Agents comfort')

  const five = mount({ budget: 5 })
  fill(five)
  const lines5 = plain(five.stack.render(80))
  assert.equal(lines5.length, 5, 'no gap is bought while content is still tight')
  assert.match(lines5.join('\n'), /实现状态区固定布局/)
  assert.doesNotMatch(lines5.join('\n'), /frontend-developer/)

  const six = mount({ budget: 6 })
  fill(six)
  const lines6 = plain(six.stack.render(80))
  assert.equal(lines6.length, 6)
  assert.match(lines6.join('\n'), /frontend-developer/, 'first child name before any gap')
  assert.ok(!lines6.includes(''), 'still no gap')
})

test('gaps are all-or-none across two simultaneously visible sections', () => {
  const cases: Array<{ ids: StatusDockId[]; hide: (h: Harness) => void }> = [
    { ids: ['todos', 'goal'], hide: h => { h.agents.entries = [] } },
    { ids: ['todos', 'agents'], hide: h => { h.goal.status = undefined } },
    { ids: ['goal', 'agents'], hide: h => { h.todos.todos = null } },
  ]
  for (const { ids: expected, hide } of cases) {
    const tight = mount({ budget: 4 })
    fill(tight)
    hide(tight)
    const tightLines = tight.stack.render(80)
    assert.deepEqual(ids(tight.stack.spans), expected)
    assert.equal(tightLines.length, 4, `${expected.join('+')} keeps comfortable content instead of a gap`)
    assert.deepEqual(gaps(tight.stack.spans), [0])
    assert.ok(!plain(tightLines).includes(''))

    const roomy = mount({ budget: 5 })
    fill(roomy)
    hide(roomy)
    const roomyLines = roomy.stack.render(80)
    assert.equal(roomyLines.length, 5)
    assert.deepEqual(gaps(roomy.stack.spans), [1])
    assert.equal(plain(roomyLines).filter(line => line === '').length, 1)
    assert.notEqual(plain(roomyLines).at(-1), '')
  }
})

test('per-section content caps bound Todo 6 / Goal 3 / Agents 8 inside the parent max', () => {
  const h = mount({ budget: 18 })
  h.todos.todos = Array.from({ length: 12 }, (_, index) => ({
    content: `long native task ${index + 1} ✅`,
    status: 'pending' as const,
  }))
  h.goal.status = Object.freeze({
    available: true,
    complete: true,
    sessionId: 's1',
    goal: Object.freeze({
      ...GOAL_VIEW,
      phase: 'blocked' as const,
      blockedReason: Object.freeze({ code: 'needs-human', message: '确认下一步 🚀' }),
    }),
  })
  h.agents.entries = Array.from({ length: 12 }, (_, index) => agent({
    id: `child-${index + 1}`,
    label: `子代理 ${index + 1}`,
    lastActivity: `native activity ${index + 1}`,
  }))
  const lines = h.stack.render(80)
  assert.ok(lines.length <= 18)
  const byId = new Map(h.stack.spans.map(span => [span.id, span.rows]))
  assert.ok(byId.get('todos')! <= 6, 'Todo header + five tasks')
  assert.ok(byId.get('goal')! <= 3, 'Goal header + objective + blocked reason')
  assert.ok(byId.get('agents')! <= 8, 'Agents header + rows/activity/overflow')
  assert.equal(lines.length, 18, 'content fills the pool before any unused row')
  assert.notEqual(plain(lines).at(-1), '')

  // An Agents-only frame still respects its own cap instead of filling the pool.
  const agentsOnly = mount({ budget: 15 })
  agentsOnly.agents.entries = h.agents.entries
  const agentsLines = agentsOnly.stack.render(80)
  assert.equal(agentsLines.length, 8)
  assert.equal(agentsOnly.stack.spans[0]!.rows, 8)
  assert.notEqual(plain(agentsLines).at(-1), '')
})

test('an oversize budget uses only real content, never trailing whitespace', () => {
  const h = mount({ budget: 18 })
  fill(h)
  const lines = h.stack.render(80)
  assert.equal(lines.length, 11, 'Todo4 + gap + Goal2 + gap + Agents3')
  assert.notEqual(plain(lines).at(-1), '')
  assert.equal(h.stack.spans.at(-1)!.endRow, lines.length - 1)
})

// ---------------------------------------------------------------------------
// Pure planning facts / budget callbacks

test('each member is rendered once per frame after pure-fact planning', () => {
  const h = mount({ budget: 15 })
  fill(h)
  const renders: Record<StatusDockId, number> = { todos: 0, goal: 0, agents: 0 }
  for (const id of ['todos', 'goal', 'agents'] as const) {
    const member = id === 'todos' ? h.todos : id === 'goal' ? h.goal : h.agents
    const original = member.render.bind(member)
    member.render = (width: number) => {
      renders[id] += 1
      return original(width)
    }
  }
  const first = h.stack.render(80)
  assert.deepEqual(renders, { todos: 1, goal: 1, agents: 1 })
  // Planning reads the pure getters only; repeat frames do not multiply paints.
  h.stack.render(80)
  assert.deepEqual(renders, { todos: 2, goal: 2, agents: 2 })
  // A hard budget can omit a member without painting it to measure it.
  h.stack.render(80)
  assert.deepEqual(renders, { todos: 3, goal: 3, agents: 3 })
  assert.ok(first.length > 0)
})

test('the parent budget getter is re-sampled every frame without constructor re-entry', () => {
  let budget = 2
  let calls = 0
  const h = mount({
    budget: () => {
      calls += 1
      return budget
    },
  })
  fill(h)
  assert.equal(h.stack.render(80).length, 2, 'two tight compact rows')
  assert.equal(calls, 1)
  budget = 8
  assert.equal(h.stack.render(80).length, 8, 'gaps and comfortable content follow the live pool')
  assert.equal(calls, 2)
  budget = 0
  assert.deepEqual(h.stack.render(80), [])
  assert.equal(calls, 3)
  budget = 18
  assert.equal(h.stack.render(80).length, 11)
  assert.equal(calls, 4, 'the same stack instance survives every budget change')

  // Non-finite and missing budgets fall back to the combined maximum.
  const broken = mount({ budget: () => Number.NaN })
  fill(broken)
  assert.ok(broken.stack.render(80).length <= 15)
  assert.ok(broken.stack.render(80).length > 0)
})

test('a root stack bypasses standalone per-member budgets instead of double-capping', () => {
  const keymap = createCcKeymap()
  let calls = 0
  const todos = new TodoBoard({
    keymap,
    trailingSeparator: false,
    maxRows: () => {
      calls += 1
      return 1
    },
  })
  const goal = new GoalProgress({
    maxRows: () => {
      calls += 1
      return 1
    },
  })
  const agents = new SubagentProgress({
    keymap,
    trailingSeparator: false,
    maxRows: () => {
      calls += 1
      return 1
    },
    now: () => NOW,
  })
  const stack = new StatusDockStack({ todos, goal, agents, maxRows: 15 })
  todos.todos = TODO_ITEMS
  goal.status = GOAL_READ
  agents.entries = [agent()]
  const lines = stack.render(80)
  assert.equal(calls, 0, 'the stack assigns explicit budgets; member getters stay dormant')
  assert.deepEqual(ids(stack.spans), ['todos', 'goal', 'agents'])
  assert.ok(lines.length > 3)
})

// ---------------------------------------------------------------------------
// Width safety and frozen native facts

test('every emitted line is width-safe with CJK/emoji at 1..120 columns', () => {
  const h = mount({ budget: 15 })
  fill(h)
  for (const width of [1, 2, 3, 4, 5, 8, 12, 20, 40, 80, 120]) {
    const lines = h.stack.render(width)
    assertWidths(lines, width, `stack at ${width}`)
    assert.ok(lines.length <= 15, `width ${width}: hard budget`)
    for (const line of lines) {
      assert.ok(!stripTerminalSequences(line).includes('\x1b'), `width ${width}: no escape survives`)
    }
    if (lines.length > 0) assert.notEqual(plain(lines).at(-1), '')
  }
})

test('frozen native facts are read-only and repeat frames are deterministic', () => {
  const h = mount({ budget: 15 })
  const todos = Object.freeze([
    Object.freeze({ content: 'frozen ✅ 任务', status: 'in_progress' as const }),
    Object.freeze({ content: '另一个 frozen step', status: 'pending' as const }),
  ])
  const goal = Object.freeze({
    ...GOAL_VIEW,
    objective: 'frozen 🚀 goal',
    blockedReason: Object.freeze({ code: 'needs-human', message: 'frozen reason' }),
  })
  const entries = Object.freeze([
    Object.freeze(agent({ id: 'a', label: '审查 frozen ✅', status: 'running' as const })),
    Object.freeze(agent({ id: 'b', label: 'frozen child', status: 'initializing' as const })),
  ])
  h.todos.todos = todos
  h.goal.status = Object.freeze({ available: true, complete: true, sessionId: 's1', goal })
  h.agents.entries = entries
  const first = h.stack.render(80)
  assert.deepEqual(h.stack.render(80), first)
  assert.ok(Object.isFrozen(h.stack.spans))
  assert.equal(h.stack.spans.length, 3)
  assert.equal(Object.isFrozen(todos), true)
  assert.equal(Object.isFrozen(todos[0]), true)
  assert.equal(Object.isFrozen(goal), true)
  assert.equal(Object.isFrozen(entries), true)
  assert.deepEqual(entries.map(entry => entry.status), ['running', 'initializing'])
  assert.deepEqual(h.todos.todos, todos, 'the stack never rewrites the todo projection')
})

// ---------------------------------------------------------------------------
// Mouse geometry / gesture safety

test('mouse dispatch maps emitted member rows and preserves the child target', () => {
  const h = mount({ budget: 15 })
  fill(h)
  const lines = plain(h.stack.render(80))
  const spans = h.stack.spans
  const agentsSpan = spans.find(span => span.id === 'agents')!
  const agentsLines = lines.slice(agentsSpan.startRow, agentsSpan.endRow + 1)
  const headerOffset = agentsLines.findIndex(line => line.includes('Agents'))
  assert.ok(headerOffset >= 0)
  const headerY = agentsSpan.startRow + headerOffset
  const headerX = colOf(lines[headerY]!, 'Agents')

  const press = h.stack.handleMouse(mouse('press', headerX, headerY))
  assert.ok(press?.handled)
  assert.equal((press as { target?: { component: unknown } }).target?.component, h.agents)
  const click = h.stack.handleMouse(mouse('click', headerX, headerY))
  assert.ok(click?.handled)
  assert.equal(h.agentsOpened, 1)

  // The child name link resolves through the same per-span transform.
  const nameOffset = agentsLines.findIndex(line => line.includes('frontend-developer'))
  assert.ok(nameOffset >= 0)
  const nameY = agentsSpan.startRow + nameOffset
  const nameX = colOf(lines[nameY]!, 'frontend-developer')
  assert.ok(h.stack.handleMouse(mouse('press', nameX, nameY))?.handled)
  assert.ok(h.stack.handleMouse(mouse('click', nameX, nameY))?.handled)
  assert.deepEqual(h.opened, ['child-1'])

  // Gaps and out-of-frame rows claim nothing at all.
  const gapY = spans[0]!.endRow + 1
  assert.ok(gapY < spans[1]!.startRow)
  assert.equal(h.stack.handleMouse(mouse('press', 0, gapY)), undefined)
  assert.equal(h.stack.handleMouse(mouse('click', 0, lines.length + 5)), undefined)
})

test('a disappearing member voids the synthesized click instead of navigating it', () => {
  const h = mount({ budget: 15 })
  fill(h)
  const lines = plain(h.stack.render(80))
  const agentsSpan = h.stack.spans.find(span => span.id === 'agents')!
  const offset = lines
    .slice(agentsSpan.startRow, agentsSpan.endRow + 1)
    .findIndex(line => line.includes('frontend-developer'))
  assert.ok(offset >= 0)
  const y = agentsSpan.startRow + offset
  const x = colOf(lines[y]!, 'frontend-developer')
  const press = h.stack.handleMouse(mouse('press', x, y))
  assert.ok(press?.handled)
  const target = (press as { target: { originX: number; originY: number } }).target

  // The live child settles before the release: the section disappears.
  h.agents.entries = [agent({ status: 'idle' })]
  h.stack.render(80)
  assert.deepEqual(ids(h.stack.spans), ['todos', 'goal'])

  // The renderer would now deliver the click to the press-time child target.
  const nativeClick = mouse('click', x, y)
  const local = {
    ...nativeClick,
    x: nativeClick.screenX - target.originX,
    y: nativeClick.screenY - target.originY,
  }
  const result = h.agents.handleMouse(local)
  assert.equal(result?.handled, true, 'the gesture is swallowed, not left unhandled')
  assert.deepEqual(h.opened, [], 'no child opens after its section disappeared')
})

test('a press whose member start row moves (gap/resize) cannot resolve a new frame', () => {
  const h = mount({ budget: 15 })
  fill(h)
  const lines = plain(h.stack.render(80))
  const agentsSpan = h.stack.spans.find(span => span.id === 'agents')!
  const offset = lines
    .slice(agentsSpan.startRow, agentsSpan.endRow + 1)
    .findIndex(line => line.includes('frontend-developer'))
  const y = agentsSpan.startRow + offset
  const x = colOf(lines[y]!, 'frontend-developer')
  const press = h.stack.handleMouse(mouse('press', x, y))
  assert.ok(press?.handled)
  const target = (press as { target: { originX: number; originY: number } }).target

  // Hiding Todo moves Agents up and removes the Todo→Goal gap style frame.
  h.todos.visible = false
  h.stack.render(80)
  assert.notEqual(h.stack.spans.find(span => span.id === 'agents')!.startRow, agentsSpan.startRow)

  const nativeClick = mouse('click', x, y)
  const local = {
    ...nativeClick,
    x: nativeClick.screenX - target.originX,
    y: nativeClick.screenY - target.originY,
  }
  const result = h.agents.handleMouse(local)
  assert.equal(result?.handled, true)
  assert.deepEqual(h.opened, [], 'a moved member never navigates from stale coordinates')
})

test('a budget shrink that drops Agents also voids its pending gesture', () => {
  let budget = 15
  const h = mount({ budget: () => budget })
  fill(h)
  const lines = plain(h.stack.render(80))
  const agentsSpan = h.stack.spans.find(span => span.id === 'agents')!
  const offset = lines
    .slice(agentsSpan.startRow, agentsSpan.endRow + 1)
    .findIndex(line => line.includes('Agents'))
  const y = agentsSpan.startRow + offset
  const x = colOf(lines[y]!, 'Agents')
  const press = h.stack.handleMouse(mouse('press', x, y))
  assert.ok(press?.handled)
  const target = (press as { target: { originX: number; originY: number } }).target

  budget = 2
  h.stack.render(80)
  assert.deepEqual(ids(h.stack.spans), ['todos', 'goal'])
  const nativeClick = mouse('click', x, y)
  const local = {
    ...nativeClick,
    x: nativeClick.screenX - target.originX,
    y: nativeClick.screenY - target.originY,
  }
  assert.equal(h.agents.handleMouse(local)?.handled, true)
  assert.equal(h.agentsOpened, 0)
})

// ---------------------------------------------------------------------------
// Root separator ownership / safety

test('the stack owns the only inter-section gaps even if a member forgets to disable its separator', () => {
  const h = mount({ budget: 15, trailingSeparator: true })
  fill(h)
  const lines = plain(h.stack.render(80))
  assert.deepEqual(gaps(h.stack.spans), [1, 1], 'exactly one uniform gap, never two')
  assert.notEqual(lines.at(-1), '', 'no blank after the last section')
  assert.equal(h.stack.spans.at(-1)!.endRow, lines.length - 1)
})

test('invalidate and dispose stay safe without stealing focus or disposing members', () => {
  const h = mount({ budget: 15 })
  fill(h)
  h.stack.render(80)
  h.stack.invalidate()
  assert.deepEqual(ids(h.stack.spans), ['todos', 'goal', 'agents'], 'frame mapping is retained')
  // A new press after invalidation is not claimed by stale member hitboxes.
  assert.equal(h.stack.handleMouse(mouse('press', 0, 0)), undefined)
  h.stack.render(80)
  h.stack.dispose()
  assert.equal(h.stack.isDisposed, true)
  assert.deepEqual(h.stack.render(80), [])
  assert.deepEqual(h.stack.spans, [])
  assert.equal(h.agents.isDisposed, false, 'member lifecycle stays parent-owned')
  assert.equal(h.todos.isDisposed, false)
  h.stack.dispose()
})