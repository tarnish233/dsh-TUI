/**
 * Native DSH **goal** as a compact status dock row (read-only projection).
 *
 * DSH owns the goal domain (`ctx.goals`, the durable `goal` projection, the
 * round driver and every mutation). The native `/goal` command stays a native
 * passthrough: this component never creates, edits, pauses, resumes, completes
 * or clears a goal, starts no continuation loop, schedules nothing and holds no
 * timer. It only projects the facts of one `GoalRead` that the parent assigns
 * before painting.
 *
 * Facts painted, in native vocabulary:
 * - `phase` (`active` / `paused` / `blocked` / `complete`); an unrecognized
 *   value is painted verbatim, never upgraded to `active`.
 * - `roundsStarted` / `maxGoalRounds`; each chip appears only when the native
 *   number is a finite non-negative number, so no round count is invented.
 * - `activation` (`armed` / `disarmed`); omitted when the read could only use
 *   the durable projection, which deliberately has no activation.
 * - the objective as one bounded line, and `blockedReason.message` as one
 *   bounded line only while the native phase is `blocked`.
 *
 * Honesty rules:
 * - `goal: null` is a successful native read that found no current goal, and
 *   `available: false` is a failed read; both paint nothing. The dock never
 *   fabricates an objective or a phase, and the native `/goal` output remains
 *   the authority. `unavailable`/`hasGoal` are exposed for the parent only.
 * - A row budget is a hard total (header + objective + blocked reason). The
 *   parent owns the shared Todo/Subagent/Goal dock budget: pass a getter and
 *   the component re-samples it on every paint. A non-positive budget renders
 *   `[]`.
 * - `preferredRows` / `comfortableRows` / `compactRows` are pure presentation
 *   facts for a shared status-dock stack: full content height (header + the
 *   native objective while present + the native blocked reason while present),
 *   the smallest useful content (header + objective when present, otherwise the
 *   header) and the one-row fallback. They never paint, measure a width or
 *   mutate the native read, so the stack plans rows without re-rendering.
 *   This dock has no trailing separator of its own; the root stack owns gaps.
 *
 * Focus: not `Focusable`, no input listener, no mouse handler and no stdout
 * write. The one Editor keeps focus and ordinary typing; the component never
 * consumes a key and never advertises a shortcut it does not own.
 *
 * @module dsh-tui/ui/goal-progress
 */
import type { Component } from '#pi-tui'
import type { GoalRead, GoalStateView } from '../backend/native-inspection.ts'
import { fit, oneLine, sanitize, truncateToWidth } from './text.ts'
import { bold, cc, dim, t, type Style } from './theme.ts'

/** Header + objective + blocked reason. */
const DEFAULT_MAX_ROWS = 3

const HEADER_MARK = '⏺'
const ELBOW = '  ⎿  '

/**
 * Compact state of the dock, for the parent only (never painted as a fact).
 * `none` = no current goal, `unavailable` = the native read failed / was never
 * made, `goal` = a real projection is painted.
 */
export type GoalDockState = 'none' | 'unavailable' | 'goal'

export interface GoalProgressOptions {
  /**
   * Hard total line budget (header, objective line, blocked-reason line). A
   * getter is re-sampled on every `render()`, so the parent can account for
   * terminal height, resize and its shared dock budget without a timer.
   */
  maxRows?: number | (() => number)
  /** Initial visibility (the parent owns any hide policy). */
  visible?: boolean
}

const PHASE_LABEL: Readonly<Record<string, string>> = {
  active: 'active',
  paused: 'paused',
  blocked: 'blocked',
  complete: 'complete',
}

const PHASE_TONE: Readonly<Record<string, Style>> = {
  active: t.accentBright,
  paused: t.yellow,
  blocked: t.redSoft,
  complete: t.green,
}

const ACTIVATION_LABEL: Readonly<Record<string, string>> = {
  armed: 'armed',
  disarmed: 'disarmed',
}

const countOf = (value: unknown): number | undefined => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
}

/** One sanitized objective line, or `''` when the native value is blank. */
function objectiveText(goal: GoalStateView): string {
  return oneLine(sanitize(typeof goal.objective === 'string' ? goal.objective : ''), 400)
}

/** One sanitized native blocked reason, or `''` when it is absent/blank. */
function blockedText(goal: GoalStateView): string {
  const message = goal.blockedReason?.message
  return oneLine(sanitize(typeof message === 'string' ? message : ''), 400)
}

/** Native phase text; an unrecognized/blank value is stated, never guessed. */
export function goalPhaseText(phase: unknown): string {
  if (typeof phase !== 'string' || phase.trim() === '') return 'phase unknown'
  const known = PHASE_LABEL[phase]
  if (known !== undefined) return known
  const text = oneLine(sanitize(phase), 40)
  return text === '' ? 'phase unknown' : text
}

/** Color role for a native phase; unknown stays muted (no success/error claim). */
export function goalPhaseTone(phase: unknown): Style {
  return (typeof phase === 'string' ? PHASE_TONE[phase] : undefined) ?? t.muted
}

export class GoalProgress implements Component {
  /**
   * Latest native goal read, assigned by the parent before every paint.
   * `undefined` (not read yet), an unavailable read and `goal: null` all paint
   * nothing; none of them is treated as "no goal forever".
   */
  status: GoalRead | undefined = undefined
  /** Parent-owned visibility; a hidden dock keeps no painted rows. */
  visible: boolean
  private readonly options: GoalProgressOptions
  private budgetValue = DEFAULT_MAX_ROWS
  private budgetAssigned = false

  constructor(options: GoalProgressOptions = {}) {
    this.options = options
    this.visible = options.visible ?? true
    if (typeof options.maxRows === 'number') this.budgetValue = options.maxRows
  }

  /**
   * Hard total line budget. An explicit assignment (a composing stack) wins;
   * otherwise the constructor option wins (a getter is re-read each paint);
   * otherwise the bounded default. Non-finite values fall back to the default
   * and negatives mean "hide".
   */
  get maxRows(): number {
    return this.budgetValue
  }

  set maxRows(value: number) {
    this.budgetValue = value
    this.budgetAssigned = true
  }

  /** Native goal facts, or `undefined` when no projection is available. */
  get goal(): GoalStateView | undefined {
    const status = this.status
    if (status === undefined || status.available !== true) return undefined
    return status.goal ?? undefined
  }

  /** Why nothing is painted (`'none'` and `'unavailable'` are distinguished). */
  get state(): GoalDockState {
    if (this.status === undefined) return 'unavailable'
    if (this.status.available !== true) return 'unavailable'
    return this.status.goal === null ? 'none' : 'goal'
  }

  /** True only for a real native goal projection. */
  get hasGoal(): boolean {
    return this.state === 'goal'
  }

  /**
   * Full content height at the current native read: the header plus one line
   * for a non-blank objective and one for a native `blocked` reason. `0` when
   * nothing is painted (hidden, unread, unavailable or no current goal).
   * Pure: it never calls `render()` and never mutates the native read.
   */
  get preferredRows(): number {
    if (!this.visible) return 0
    const goal = this.goal
    if (goal === undefined) return 0
    let rows = 1
    if (objectiveText(goal) !== '') rows += 1
    if (goal.phase === 'blocked' && blockedText(goal) !== '') rows += 1
    return rows
  }

  /**
   * Smallest useful content: header plus the native objective when present,
   * otherwise just the header. Bounded by {@link preferredRows}; `0` when the
   * dock paints nothing.
   */
  get comfortableRows(): number {
    const preferred = this.preferredRows
    return preferred === 0 ? 0 : Math.min(preferred, 2)
  }

  /** One-row native fallback: the header identifies the dock and its phase. */
  get compactRows(): number {
    return this.preferredRows === 0 ? 0 : 1
  }

  /** Why the native goal read could not answer; `undefined` when it did. */
  get unavailableReason(): string | undefined {
    const status = this.status
    return status !== undefined && status.available !== true ? status.reason : undefined
  }

  /**
   * Current hard row budget (re-sampled from the parent's getter on every
   * paint). A missing or non-finite value falls back to the default instead of
   * hiding the dock; an explicit `0` really means "no row".
   */
  private rowBudget(): number {
    const configured = this.options.maxRows
    const value = this.budgetAssigned ? this.budgetValue
      : typeof configured === 'function' ? configured()
        : typeof configured === 'number' ? configured
          : this.budgetValue
    if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_ROWS
    return Math.max(0, Math.floor(value))
  }

  render(width: number): string[] {
    if (!this.visible) return []
    const goal = this.goal
    if (goal === undefined) return []
    const budget = this.rowBudget()
    if (budget <= 0) return []
    const columns = Math.max(1, Math.floor(width))

    const rows: string[] = []
    const phase = goalPhaseText(goal.phase)
    const tone = goalPhaseTone(goal.phase)
    const header: string[] = [bold(tone(`${HEADER_MARK} Goal`)), tone(phase)]
    const rounds = countOf(goal.roundsStarted)
    const cap = countOf(goal.maxGoalRounds)
    if (rounds !== undefined && cap !== undefined) header.push(`rounds ${rounds}/${cap}`)
    else if (rounds !== undefined) header.push(`rounds ${rounds}`)
    else if (cap !== undefined) header.push(`max ${cap} rounds`)
    const activation = typeof goal.activation === 'string' ? ACTIVATION_LABEL[goal.activation] : undefined
    if (activation !== undefined) header.push(activation)
    rows.push(fit(header.join(dim(' · ')), columns))

    if (rows.length < budget) {
      const objective = objectiveText(goal)
      if (objective !== '') {
        const room = Math.max(1, columns - ELBOW.length)
        rows.push(fit(dim(ELBOW) + t.text(truncateToWidth(objective, room, '…')), columns))
      }
    }

    if (rows.length < budget && goal.phase === 'blocked') {
      const message = blockedText(goal)
      if (message !== '') {
        const code = typeof goal.blockedReason?.code === 'string' ? oneLine(sanitize(goal.blockedReason.code), 40) : ''
        const prefix = code === '' ? `${cc.warning('⚠ blocked')} ` : `${cc.warning('⚠ ' + code)} `
        const room = Math.max(1, columns - 5 - code.length)
        rows.push(fit('     ' + prefix + t.text(truncateToWidth(message, Math.max(1, room), '…')), columns))
      }
    }

    return rows.slice(0, budget)
  }

  invalidate(): void {
    // Stateless projection: nothing is cached between paints.
  }
}