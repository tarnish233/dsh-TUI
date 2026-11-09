/**
 * Fixed status-dock stack: the one owner of the Todo → Goal → Agents section
 * above the prompt.
 *
 * The three docks are independent native projections (`TodoBoard`,
 * `GoalProgress`, `SubagentProgress`). A parent that mounts them one by one
 * ends up reimplementing height allocation in three places, which is how the
 * same section can show a Todo→Goal gap but no Goal→Agents gap, reserve rows
 * for a settled-only catalog, or spend the last row on whitespace while a real
 * task row is clipped. This component is the single composition layer for that
 * fixed section and nothing else:
 *
 * - Fixed native order: Todo, then Goal, then Agents. No sorting, no reorder
 *   and no member can be moved by the parent through this API.
 * - One hard total row budget (`maxRows`) shared by content rows and the
 *   optional inter-section gaps. It is re-sampled on every render, so a parent
 *   can pass editor/queue/hint/footer + transcript rows through a getter.
 * - Presence stays component-native: `TodoBoard.visible` +
 *   `TodoBoard.hasOpenItems`, `GoalProgress.visible` + `.hasGoal`, and
 *   `SubagentProgress.hasActiveEntries` (with the parent's existing enable
 *   flag). Hidden, empty, unavailable and settled-only members consume no row
 *   and no gap, and this stack never mutates native snapshots to hide them.
 * - Pure `preferredRows` / `comfortableRows` / `compactRows` facts are used for
 *   planning. Each member is rendered exactly once per frame, after the plan is
 *   fixed, so live Subagent rows are never re-rendered merely to measure and no
 *   hitbox/hover/gesture state churns during allocation.
 * - Uniform all-or-none gaps: either one blank row between every adjacent
 *   visible section, or no blank row at all. A gap is bought only after every
 *   visible section can hold its comfortable content (Todo header + one task,
 *   Goal header + its native objective when present, Agents header + the first
 *   child's name). There is never a gap after the last section: the editor
 *   border separates the stack from the prompt.
 * - If the total budget cannot hold one compact row per visible section, the
 *   stack emits the first budget-many sections in fixed order (Todo first) and
 *   omits the rest instead of overflowing or writing through a member's budget.
 * - Actual emitted row spans are kept for hit testing. Mouse events are
 *   re-based into the member under the pointer and forwarded through the shared
 *   `dispatchToChild` seam, which keeps the child as the gesture target. A
 *   member that disappears or whose start row moved under a pending press is
 *   invalidated, so a release can never navigate a different section.
 *
 * Content components keep their own `maxRows` and standalone rendering. For a
 * root stack they are constructed with `trailingSeparator: false` (Todo and
 * Agents; Goal has no trailing separator), because this stack alone chooses
 * inter-section gaps. The stack also strips any trailing blank line a member
 * still emits, so a forgotten option cannot become a second gap.
 *
 * This component is not `Focusable`, installs no input listener, starts no
 * timer, schedules nothing and never writes to stdout. It fetches no native
 * service and owns no business state: the parent assigns snapshots/entries as
 * before and merely mounts this stack instead of the three members.
 *
 * Integration shape (parent-owned `statusDockStack`):
 *
 * ```ts
 * this.todoBoard = new TodoBoard({ keymap: this.keymap, hint: () => true, trailingSeparator: false })
 * this.goalProgress = new GoalProgress()
 * this.subagentProgress = new SubagentProgress({ keymap: this.keymap, trailingSeparator: false, ... })
 * this.statusDockStack = new StatusDockStack({
 *   todos: this.todoBoard,
 *   goal: this.goalProgress,
 *   agents: this.subagentProgress,
 *   maxRows: () => this.statusDockPool(),
 *   agentsEnabled: () => this.settings.get().showSubagentProgress,
 * })
 * // bottom.addChild(this.statusDockStack) instead of the three members
 * ```
 *
 * `maxRows` must be the remaining status pool in rows *including* the gaps this
 * stack may emit. The parent keeps measuring the one editor, queue, hint,
 * footer and reserved transcript rows; it must not call the children's
 * `render()` to measure them, and it must not pass per-member `maxRows`
 * callbacks into a stacked composition — this stack assigns each member's
 * budget for the frame.
 *
 * @module dsh-tui/ui/status-dock-stack
 */
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '#pi-tui'
import { dispatchToChild } from './mouse.ts'
import type { GoalProgress } from './goal-progress.ts'
import type { SubagentProgress } from './subagent-progress.ts'
import { fit } from './text.ts'
import type { TodoBoard } from './todo-board.ts'

/** Default when a parent supplies no budget (the documented combined cap). */
const DEFAULT_MAX_ROWS = 15

/** Todo content cap: header + five native tasks. */
const TODO_MAX_CONTENT_ROWS = 6

/** Goal content cap: header + objective + native blocked reason. */
const GOAL_MAX_CONTENT_ROWS = 3

/** Agents content cap: header + rows/activity/overflow within one widget. */
const AGENTS_MAX_CONTENT_ROWS = 8

/** At most one blank row between two adjacent visible sections. */
const GAP_ROWS = 1

/** Stable member identity and display order. */
export type StatusDockId = 'todos' | 'goal' | 'agents'

/** The structural presentation surface a stacked member must expose. */
export interface StatusDockMember extends Component {
  /** Hard content budget for this frame, assigned by the stack. */
  maxRows: number
  /** Full natural content height (no trailing separator, no cap). */
  readonly preferredRows: number
  /** Smallest useful content height for this member. */
  readonly comfortableRows: number
  /** One-row compact fallback height. */
  readonly compactRows: number
}

export interface StatusDockStackOptions {
  /** Todos projection dock. Mount it only through this stack. */
  readonly todos: TodoBoard
  /** Native goal projection dock. Mount it only through this stack. */
  readonly goal: GoalProgress
  /** Active-subagent progress widget. Mount it only through this stack. */
  readonly agents: SubagentProgress
  /**
   * TOTAL rows available to this section, including inter-section gaps. A
   * getter is re-sampled on every `render()`: the parent accounts for its
   * measured editor/queue/hint/footer and reserved transcript rows there.
   * Missing/non-finite falls back to the combined parent maximum (15);
   * negatives/zero emit no rows.
   */
  readonly maxRows?: number | (() => number)
  /**
   * Parent enable flag for the existing Agents setting. Default `true`: when a
   * live native child exists the section participates in layout. A getter is
   * sampled on every render (never a constructor snapshot).
   */
  readonly agentsEnabled?: boolean | (() => boolean)
}

/**
 * One actually emitted member block. Rows are component-local to this stack
 * frame (`0 .. lines.length - 1`); gap rows belong to no span.
 */
export interface StatusDockSpan {
  readonly id: StatusDockId
  readonly component: StatusDockMember
  /** First emitted row, inclusive. */
  readonly startRow: number
  /** Last emitted row, inclusive. */
  readonly endRow: number
  /** Emitted content rows (`endRow - startRow + 1`). Never a gap. */
  readonly rows: number
}

interface MemberSlot {
  readonly id: StatusDockId
  readonly component: StatusDockMember
  /** Native presence + a paintable natural height. */
  readonly present: boolean
  /** Capped full content height. */
  readonly preferred: number
  /** Capped smallest useful content height (1 when present). */
  readonly comfortable: number
}

interface Allocation {
  readonly slot: MemberSlot
  rows: number
}

interface FramePlan {
  readonly allocations: readonly Allocation[]
  /** 0 = all-or-none tight layout, 1 = one blank between adjacent sections. */
  readonly gapRows: number
}

export class StatusDockStack implements Component {
  private readonly options: StatusDockStackOptions
  private spansValue: readonly StatusDockSpan[] = []
  private renderedIds: ReadonlySet<StatusDockId> = new Set()
  /** Press bookkeeping: a release must never land in a different frame. */
  private pressed: { readonly id: StatusDockId; readonly startRow: number } | undefined
  private disposed = false

  constructor(options: StatusDockStackOptions) {
    this.options = options
  }

  /** Actual emitted spans for the last `render()`; frozen and ordered. */
  get spans(): readonly StatusDockSpan[] {
    return this.spansValue
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /** Ids that emitted at least one content row in the last frame. */
  private members(): readonly MemberSlot[] {
    const todos = this.options.todos
    const goal = this.options.goal
    const agents = this.options.agents
    const slots: MemberSlot[] = [
      this.slot('todos', todos, TODO_MAX_CONTENT_ROWS),
      this.slot('goal', goal, GOAL_MAX_CONTENT_ROWS),
      this.slot('agents', agents, AGENTS_MAX_CONTENT_ROWS, this.agentsEnabled()),
    ]
    return slots
  }

  private slot(
    id: StatusDockId,
    component: StatusDockMember,
    cap: number,
    enabled = true,
  ): MemberSlot {
    const preferred = enabled ? clampInt(component.preferredRows, 0, cap) : 0
    return {
      id,
      component,
      present: enabled && preferred > 0,
      preferred,
      comfortable: preferred > 0 ? clampInt(component.comfortableRows, 1, preferred) : 0,
    }
  }

  render(width: number): string[] {
    if (this.disposed) {
      this.reconcile([])
      return []
    }
    const columns = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1
    const budget = this.rowBudget()
    const slots = this.members()
    const present = slots.filter(slot => slot.present)

    // A hidden/empty/settled member owns no row and no stale hitbox.
    for (const slot of slots) if (!slot.present) slot.component.maxRows = 0

    if (budget < 1 || present.length === 0) {
      for (const slot of present) slot.component.maxRows = 0
      this.reconcile([])
      return []
    }

    const plan = planFrame(present, budget)
    const allocated = new Set(plan.allocations.map(allocation => allocation.slot.id))
    // Members that cannot be admitted this frame paint nothing at all: no
    // header-only reservation, no phantom gap and no overflow past the budget.
    for (const slot of present) if (!allocated.has(slot.id)) slot.component.maxRows = 0

    const rendered: Array<{ readonly slot: MemberSlot; readonly lines: readonly string[] }> = []
    for (const allocation of plan.allocations) {
      allocation.slot.component.maxRows = allocation.rows
      rendered.push({
        slot: allocation.slot,
        // Each member paints once, after planning. The slice is the final hard
        // guarantee even if a member was misconfigured by a future caller.
        lines: trimTrailingBlanks(allocation.slot.component.render(columns), allocation.rows),
      })
    }

    const lines: string[] = []
    const spans: StatusDockSpan[] = []
    let cursor = 0
    for (const item of rendered) {
      if (item.lines.length === 0) continue
      if (spans.length > 0 && plan.gapRows > 0) {
        lines.push('')
        cursor += GAP_ROWS
      }
      const startRow = cursor
      for (const line of item.lines) {
        lines.push(fit(line, columns))
        cursor += 1
      }
      spans.push(Object.freeze({
        id: item.slot.id,
        component: item.slot.component,
        startRow,
        endRow: cursor - 1,
        rows: cursor - startRow,
      }))
    }

    this.reconcile(spans)
    return lines
  }

  /**
   * Route a mouse event to the member under the pointer.
   *
   * The event is re-based into member-local coordinates and forwarded through
   * `dispatchToChild`, so the returned target stays the member: the renderer's
   * press-pinned gesture later arrives with the press-time transform instead of
   * a row re-derived from a moved frame. Gaps and empty frames claim nothing,
   * leaving native selection untouched.
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    const span = this.spanAt(event.y)
    if (span === undefined) {
      if (event.type === 'press') this.pressed = undefined
      return undefined
    }
    const result = dispatchToChild(span.component, { ...event, y: event.y - span.startRow })
    if (event.type === 'press') {
      this.pressed = result?.handled === true ? { id: span.id, startRow: span.startRow } : undefined
    } else if (event.type === 'click' || event.type === 'release') {
      this.pressed = undefined
    }
    return result
  }

  /**
   * Drop member hitboxes/hover and press bookkeeping. Spans stay mapped to the
   * last emitted frame so a no-render invalidation still refuses to guess a
   * member; each member clears its own boxes, so nothing becomes clickable
   * against stale geometry. Idempotent.
   */
  invalidate(): void {
    this.pressed = undefined
    for (const slot of this.members()) slot.component.invalidate()
  }

  /** Idempotent terminal state. Members are parent-owned and not disposed. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pressed = undefined
    this.renderedIds = new Set()
    this.spansValue = Object.freeze([])
  }

  /** Row budget re-sampled from the parent on every paint. */
  private rowBudget(): number {
    const configured = this.options.maxRows
    const raw = typeof configured === 'function' ? configured() : configured
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_MAX_ROWS
    return Math.max(0, Math.floor(raw))
  }

  private agentsEnabled(): boolean {
    const configured = this.options.agentsEnabled
    return typeof configured === 'function' ? configured() === true : configured !== false
  }

  private spanAt(row: number): StatusDockSpan | undefined {
    return this.spansValue.find(span => row >= span.startRow && row <= span.endRow)
  }

  /**
   * Publish the frame and invalidate gestures the frame invalidated.
   *
   * A member that no longer emits rows (member disappearance) and a pressed
   * member whose start row moved (resize or gap-mode change) must not receive
   * the synthesized click at its old coordinates. Clearing only those members
   * keeps unrelated hover state alive.
   */
  private reconcile(spans: readonly StatusDockSpan[]): void {
    const byId = new Map(spans.map(span => [span.id, span]))
    for (const id of this.renderedIds) {
      if (byId.has(id)) continue
      this.member(id)?.invalidate()
    }
    const pressed = this.pressed
    if (pressed !== undefined) {
      const span = byId.get(pressed.id)
      if (span === undefined || span.startRow !== pressed.startRow) {
        this.member(pressed.id)?.invalidate()
        this.pressed = undefined
      }
    }
    this.spansValue = Object.freeze(spans.slice())
    this.renderedIds = new Set(byId.keys())
  }

  private member(id: StatusDockId): StatusDockMember | undefined {
    if (id === 'todos') return this.options.todos
    if (id === 'goal') return this.options.goal
    return this.options.agents
  }
}

/**
 * Plan one frame under a hard total budget.
 *
 * - Fewer rows than visible sections: keep the fixed-order prefix (Todo first)
 *   at one compact row each, never more than the budget and never a gap.
 * - Otherwise every visible section gets one row first. A gap block is bought
 *   only when all comfortable content still fits beside it; then remaining rows
 *   grow sections toward their preferred content in fixed order.
 * - All-or-none: `gapRows` is either 0 or 1 in one frame.
 */
function planFrame(present: readonly MemberSlot[], budget: number): FramePlan {
  if (budget < present.length) {
    return {
      allocations: present.slice(0, budget).map(slot => ({ slot, rows: 1 })),
      gapRows: 0,
    }
  }
  const comfortableTotal = present.reduce((total, slot) => total + slot.comfortable, 0)
  const gapRows = present.length > 1 && budget >= comfortableTotal + (present.length - 1) * GAP_ROWS
    ? GAP_ROWS
    : 0
  let available = budget - gapRows * (present.length - 1)
  const allocations: Allocation[] = present.map(slot => ({ slot, rows: 1 }))
  available -= present.length

  // Comfortable content before whitespace was already guaranteed above.
  for (const allocation of allocations) {
    if (available < 1) break
    const extra = Math.min(available, allocation.slot.comfortable - allocation.rows)
    allocation.rows += extra
    available -= extra
  }
  // Then richer content/detail rows in fixed order. Unused budget emits no
  // trailing whitespace.
  for (const allocation of allocations) {
    if (available < 1) break
    const extra = Math.min(available, allocation.slot.preferred - allocation.rows)
    allocation.rows += extra
    available -= extra
  }
  return { allocations, gapRows }
}

/** Drop member-owned trailing separators the root stack replaces with gaps. */
function trimTrailingBlanks(lines: readonly string[], cap: number): string[] {
  const limit = Math.max(0, Math.floor(cap))
  const out = lines.slice(0, limit)
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.floor(value)))
}