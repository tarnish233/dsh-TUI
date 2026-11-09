// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { GoalRead, GoalStateView } from '../src/backend/native-inspection.ts'
import { GoalProgress, goalPhaseText } from '../src/ui/goal-progress.ts'

/**
 * Native goal dock: presentation-only projection of the `GoalRead` DTO.
 * No native Goal loop, no round driver, no scheduler, no timer, no stdout.
 */

const SESSION = 'session-goal'

const plain = (lines: readonly string[]): string[] => lines.map(line => stripTerminalSequences(line))

function goal(over: Partial<GoalStateView> = {}): GoalStateView {
  return {
    id: 'goal-1',
    revision: 3,
    objective: 'Ship the width-safe native goal dock',
    phase: 'active',
    maxGoalRounds: 10,
    roundsStarted: 4,
    activation: 'armed',
    ...over,
  }
}

function read(value: GoalStateView | null, over: Partial<GoalRead & { available: true }> = {}): GoalRead {
  return { available: true, complete: true, sessionId: SESSION, goal: value, ...over }
}

function dock(options: { maxRows?: number | (() => number); visible?: boolean } = {}): GoalProgress {
  return new GoalProgress(options)
}

function assertWidths(lines: readonly string[], width: number, label: string): void {
  for (const line of lines) {
    assert.ok(
      visibleWidth(line) <= width,
      `${label}: width ${width} got ${visibleWidth(line)} :: ${JSON.stringify(stripTerminalSequences(line))}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Honest empty / unavailable states (never a fabricated objective or phase)

test('an unread, unavailable or empty goal paints nothing and is never "no goal forever"', () => {
  const unread = dock()
  assert.deepEqual(unread.render(80), [])
  assert.equal(unread.state, 'unavailable')
  assert.equal(unread.hasGoal, false)
  assert.equal(unread.unavailableReason, undefined)

  const unavailable = dock()
  unavailable.status = { available: false, reason: 'no-agent' }
  assert.deepEqual(unavailable.render(80), [])
  assert.equal(unavailable.state, 'unavailable')
  assert.equal(unavailable.unavailableReason, 'no-agent')

  const none = dock()
  none.status = read(null)
  assert.deepEqual(none.render(80), [], 'a successful read with no current goal is still nothing to paint')
  assert.equal(none.state, 'none')
  assert.equal(none.hasGoal, false)

  const visible = dock({ visible: false })
  visible.status = read(goal())
  assert.deepEqual(visible.render(80), [])
  visible.visible = true
  assert.ok(visible.render(80).length > 0)
})

// ---------------------------------------------------------------------------
// Native facts only

test('the dock paints native phase, rounds, activation and the bounded objective', () => {
  const d = dock()
  d.status = read(goal())
  const text = plain(d.render(80)).join('\n')
  assert.match(text, /⏺ Goal/)
  assert.match(text, /active/)
  assert.match(text, /rounds 4\/10/)
  assert.match(text, /armed/)
  assert.match(text, /Ship the width-safe native goal dock/)
  assert.equal(plain(d.render(80)).length, 2, 'header + objective')
  assert.equal(d.state, 'goal')
  assert.equal(d.hasGoal, true)
})

test('round chips appear only from finite native numbers, never invented rounds', () => {
  const d = dock()
  d.status = read(goal({ roundsStarted: 3, maxGoalRounds: undefined as unknown as number }))
  assert.match(plain(d.render(80))[0]!, /rounds 3(?!\/)/)
  d.status = read(goal({ roundsStarted: undefined as unknown as number, maxGoalRounds: 7 }))
  assert.match(plain(d.render(80))[0]!, /max 7 rounds/)
  d.status = read(goal({ roundsStarted: Number.NaN as unknown as number, maxGoalRounds: -1 }))
  const text = plain(d.render(80))[0]!
  assert.doesNotMatch(text, /rounds/)
  assert.doesNotMatch(text, /NaN/)
})

test('activation is omitted when the durable fallback has none', () => {
  const d = dock()
  d.status = read(goal({ activation: undefined }), { complete: false })
  const text = plain(d.render(80))[0]!
  assert.doesNotMatch(text, /armed|disarmed/)
  assert.match(text, /rounds 4\/10/)
})

test('an unrecognized native phase is stated, never upgraded to active', () => {
  const d = dock()
  d.status = read(goal({ phase: 'plugin-phase' as GoalStateView['phase'] }))
  const text = plain(d.render(80))[0]!
  assert.match(text, /plugin-phase/)
  assert.doesNotMatch(text, /active/)
  assert.equal(goalPhaseText('active'), 'active')
  assert.equal(goalPhaseText('plugin-phase'), 'plugin-phase')
  assert.equal(goalPhaseText(''), 'phase unknown')
  assert.equal(goalPhaseText(42), 'phase unknown')
})

test('the blocked reason is painted only for a blocked goal and only as its own line', () => {
  const blocked = dock()
  blocked.status = read(goal({
    phase: 'blocked',
    blockedReason: { code: 'round-budget', message: 'The native round cap would be exceeded.' },
  }))
  const lines = plain(blocked.render(80))
  assert.equal(lines.length, 3, 'header + objective + reason')
  assert.match(lines[2]!, /round-budget/)
  assert.match(lines[2]!, /round cap would be exceeded/)

  // A stale reason on a non-blocked phase is not a current native fact.
  const paused = dock()
  paused.status = read(goal({ phase: 'paused', blockedReason: { code: 'old', message: 'stale' } }))
  assert.equal(plain(paused.render(80)).length, 2)
  assert.doesNotMatch(plain(paused.render(80)).join('\n'), /stale/)

  // Blocked without a reason stays honest: no invented explanation.
  const bare = dock()
  bare.status = read(goal({ phase: 'blocked' }))
  assert.equal(plain(bare.render(80)).length, 2)
})

test('a missing or blank objective paints no row instead of a placeholder', () => {
  const d = dock()
  d.status = read(goal({ objective: '   ' }))
  assert.equal(plain(d.render(80)).length, 1)
  d.status = read(goal({ objective: undefined as unknown as string }))
  assert.equal(plain(d.render(80)).length, 1)
})

// ---------------------------------------------------------------------------
// Shared dock budget (parent-owned)

test('maxRows is a hard total re-sampled from the parent on every paint', () => {
  let budget = 3
  const d = dock({ maxRows: () => budget })
  d.status = read(goal({ phase: 'blocked', blockedReason: { code: 'needs-human', message: 'Confirm the next step.' } }))
  assert.equal(d.render(80).length, 3)
  budget = 2
  assert.equal(d.render(80).length, 2)
  budget = 1
  assert.equal(d.render(80).length, 1)
  budget = 0
  assert.deepEqual(d.render(80), [])
  budget = 8
  assert.equal(d.render(80).length, 3, 'extra budget never invents rows')
  // An explicit static value wins over no option and a non-finite one is ignored.
  const fixed = dock({ maxRows: Number.NaN })
  fixed.status = read(goal())
  assert.equal(fixed.render(80).length, 2, 'a broken budget falls back to the default')
  const tiny = dock({ maxRows: Number.POSITIVE_INFINITY })
  tiny.status = read(goal())
  assert.equal(tiny.render(80).length, 2)
})

// ---------------------------------------------------------------------------
// Width safety and sanitation

test('the dock is width-safe with CJK, emoji and hostile control text at every width', () => {
  const d = dock()
  d.status = read(goal({
    objective: '\x1b[31m目标\x1b[0m 与 emoji 🚀 的组合 objective\twith\ttabs and a very long tail that must be clipped',
    phase: 'blocked',
    blockedReason: { code: 'needs-\x07human', message: '原因 \x1b]0;title\x07 说明 with more text than fits' },
  }))
  for (const width of [4, 8, 12, 20, 33, 40, 57, 80, 120]) {
    const lines = d.render(width)
    assertWidths(lines, width, `goal dock at ${width}`)
    for (const line of lines) {
      assert.ok(!stripTerminalSequences(line).includes('\x1b'), 'no native escape sequence survives sanitization')
    }
  }
  assert.match(plain(d.render(120)).join('\n'), /目标 与 emoji 🚀/)
  // One line per fact: nothing wraps into extra rows.
  assert.equal(d.render(12).length, 3)
})

// ---------------------------------------------------------------------------
// Focus and input ownership

test('the dock is not focusable and installs no input or mouse handler', () => {
  const d = dock() as unknown as Record<string, unknown>
  assert.equal('handleInput' in d, false)
  assert.equal('handleMouse' in d, false)
  assert.equal('focused' in d, false)
  assert.equal(typeof d.render, 'function')
  // invalidate() is a no-op projection hook, never a cache invalidation that
  // could revive an old goal.
  const fresh = new GoalProgress()
  fresh.invalidate()
  fresh.status = read(goal())
  assert.ok(fresh.render(80).length > 0)
})
// ---------------------------------------------------------------------------
// Root composition seams: pure height facts and stack-owned budget

test('preferred/comfortable/compact rows are pure facts of the native read', () => {
  const d = dock()
  assert.deepEqual([d.preferredRows, d.comfortableRows, d.compactRows], [0, 0, 0], 'unread')
  d.status = { available: false, reason: 'no-agent' }
  assert.deepEqual([d.preferredRows, d.comfortableRows, d.compactRows], [0, 0, 0], 'unavailable')
  d.status = read(null)
  assert.deepEqual([d.preferredRows, d.comfortableRows, d.compactRows], [0, 0, 0], 'no current goal')

  d.status = read(goal())
  assert.deepEqual([d.preferredRows, d.comfortableRows, d.compactRows], [2, 2, 1])
  d.status = read(goal({ objective: '   ' }))
  assert.deepEqual([d.preferredRows, d.comfortableRows, d.compactRows], [1, 1, 1])
  d.status = read(goal({
    phase: 'blocked',
    blockedReason: { code: 'needs-human', message: 'Confirm the next step.' },
  }))
  assert.deepEqual([d.preferredRows, d.comfortableRows, d.compactRows], [3, 2, 1])
  // A blocked phase without a native message adds no invented row.
  d.status = read(goal({ phase: 'blocked', blockedReason: { code: 'x', message: ' ' } }))
  assert.equal(d.preferredRows, 2)
  // Hidden is a component fact, not a parent re-filter.
  d.visible = false
  assert.deepEqual([d.preferredRows, d.comfortableRows, d.compactRows], [0, 0, 0])
})

test('the pure row facts never call render and ignore the row budget', () => {
  const d = dock()
  d.status = read(goal())
  const original = d.render.bind(d)
  let renders = 0
  d.render = (width: number) => {
    renders += 1
    return original(width)
  }
  for (const budget of [0, 1, 2, 3, 8]) {
    d.maxRows = budget
    assert.equal(d.preferredRows, 2)
    assert.equal(d.comfortableRows, 2)
    assert.equal(d.compactRows, 1)
  }
  assert.equal(renders, 0, 'planning height must not paint')
})

test('an explicit stack-assigned maxRows wins over a constructor getter', () => {
  let budget = 2
  const d = dock({ maxRows: () => budget })
  d.status = read(goal({
    phase: 'blocked',
    blockedReason: { code: 'needs-human', message: 'Confirm the next step.' },
  }))
  assert.equal(d.render(80).length, 2)
  d.maxRows = 3
  budget = 1
  assert.equal(d.render(80).length, 3, 'the composing stack owns this frame budget')
  d.maxRows = 0
  assert.deepEqual(d.render(80), [])
  d.maxRows = Number.NaN
  assert.equal(d.render(80).length, 3, 'a broken explicit budget falls back to the default')
})
