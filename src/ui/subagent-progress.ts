/**
 * Compact native subagent progress above the one prompt.
 *
 * Visual concept from the installed pi-subagents extension's `aboveEditor`
 * widget (`@tintinweb/pi-subagents` 0.23.1, MIT, `src/ui/agent-widget.ts`,
 * `renderWidget()` at lines 424-531 and the README sample at line 158):
 *
 *   ● Agents
 *   ├─ ⠹ frontend-developer  实现编辑框上方进度区 · ↻25≤80 · 37 tool uses · 75.9k token (7%) · 90.4s
 *   │    ⎿  I'll start by reading the project instructions and researchi…
 *   └─ +2 more (1 idle, 1 completed)
 *
 * The shape is kept — blue heading, dim `├─`/`└─` tree guide, small live
 * marker, **bold** child label, muted inline state/metrics and one indented
 * dim activity line — while every field is DSH's own native vocabulary. The
 * plugin's `↻turns≤max`, `37 tool uses`, context `(7%)` and cost figures have
 * no DSH equivalent and are deliberately **not** synthesized: the row carries
 * the native label, mode/status, optional route, session-total tokens and
 * session-total time, and the second line is only the real current
 * `lastActivity` of a `running` child.
 *
 * Ownership boundaries:
 * - DSH owns the child catalog, statuses, prompts, interrupts and persistence.
 *   This component only projects the `SubagentEntry[]` the parent assigns
 *   before `render()`; it starts no timer, no poll, no child work, keeps no
 *   status of its own and never measures a run locally. It therefore does not
 *   animate: the live marker is a static native glyph and the parent's frame
 *   loop supplies repaints. No transcript is fetched to fill the activity line.
 * - It is not `Focusable` and installs no input listener, so the one Editor
 *   keeps focus and ordinary typing is untouched. Only mouse affordances are
 *   registered, and only for links whose text actually survived the clip on
 *   the current frame.
 * - Links are internal TUI hitboxes, never OSC 8 hyperlinks: exactly the
 *   `Agents` heading word, the `+N more` count and one child's **name** (bold
 *   brand blue + underline, brighter while hovered) navigate. The branch
 *   guide, status glyph, gaps, mode/status/metrics/route, activity line, the
 *   header count/chord and the overflow guide/grouped counts stay plain text,
 *   so native selection and drag keep working over them. A non-openable
 *   (external/remote) child, a missing `onOpenChild` or a clipped-away label is
 *   never painted as a fake link.
 * - Opening the Agents overlay / a child session is requested through parent
 *   callbacks (`onOpenAgents` / `onOpenChild`). Reply/Stop stay on the existing
 *   Agents overlay and child-session view, so plain `r`/`s` remain text here.
 *
 * Rendering is width-safe at every column count: labels, activity and route go
 * through the shared sanitizers in `subagent-format.ts` and Pi TUI's width
 * helpers, and every emitted line is fitted to the supplied width.
 *
 * @module dsh-tui/ui/subagent-progress
 */
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '#pi-tui'
import type { SubagentEntry } from '../backend/types.ts'
import { createCcKeymap, formatBinding, type CcKeymap } from '../input/index.ts'
import { HitboxRegistry, type MouseHitbox } from './mouse.ts'
import {
  subagentActivity,
  subagentLabel,
  subagentModeLabel,
  subagentOpenable,
  subagentRawStatusLabel,
  subagentRouteLabel,
  subagentStatusLabel,
  subagentTimingLabel,
  subagentTokensLabel,
  subagentTone,
  type SubagentTone,
} from './subagent-format.ts'
import { fit, oneLine, truncateToWidth, visibleWidth } from './text.ts'
import { bold, dim, t, underline, type Style } from './theme.ts'

/** Total rendered lines when the parent supplies no budget. */
const DEFAULT_MAX_ROWS = 8

/** Columns a child label needs before the row keeps its secondary mode. */
const MIN_LABEL_WIDTH = 8

/**
 * Flatten already-sanitized native display text onto ONE line.
 *
 * `sanitize()` strips terminal escapes and C0/C1 bytes but deliberately keeps
 * LF/CR (and expands TAB), because multi-line native bodies are legal elsewhere.
 * A native label/provider/model/effort carrying a newline would therefore add
 * real rows to this widget and break its hard above-editor budget, so the
 * display text is whitespace-folded with the shared `oneLine` helper *before*
 * any width truncation. The max is effectively unbounded on purpose: only
 * whitespace is rewritten, so no surrogate pair or grapheme is cut here and Pi
 * TUI's width helpers do the clipping afterwards. Stored native facts and the
 * shared formatters are untouched.
 */
function flatten(text: string): string {
  return oneLine(text, Number.MAX_SAFE_INTEGER)
}

/** Parent action that opens the existing Agents overlay. */
const OPEN_AGENTS_ACTION = 'app.subagents.details'

const HEADER_HITBOX = 'subagent-progress:header'
const OVERFLOW_HITBOX = 'subagent-progress:overflow'
const ROW_HITBOX_PREFIX = 'subagent-progress:child:'

/** Status-text color per coarse tone (same mapping as the Agents overlay). */
const TONE_STYLE: Readonly<Record<SubagentTone, (text: string) => string>> = {
  running: t.accent,
  done: t.green,
  idle: t.muted,
  failed: t.redSoft,
  stopped: t.yellow,
  external: t.subtle,
  unknown: t.subtle,
}

/**
 * Status glyph, identical to the Agents overlay and the transcript row so one
 * child reads the same in every surface. Static by design (no component timer).
 */
const TONE_GLYPH: Readonly<Record<SubagentTone, string>> = {
  running: '⏺',
  done: '●',
  idle: '◌',
  failed: '●',
  stopped: '◌',
  external: '◌',
  unknown: '◌',
}

/**
 * Live marker color. The installed plugin renders its spinner in the theme's
 * `accent`, which is cyan in Pi's dark theme; the user's reference screenshot
 * keeps that cyan marker. DSH's `accent` role is the 品牌蓝 chrome blue, so the
 * cyan palette member is used for this one live marker only — a static glyph,
 * not a spinner and not a second theme.
 */
function markStyle(tone: SubagentTone): (text: string) => string {
  return tone === 'running' ? t.cyan : TONE_STYLE[tone]
}

export interface SubagentProgressOptions {
  /** Shared CC keymap; the header advertises the real `app.subagents.details` key. */
  keymap?: CcKeymap
  /** Open the existing Agents overlay (header click). */
  onOpenAgents?: () => void
  /**
   * Open one local child's existing read-only session view. Only called for a
   * row DSH reports as openable; external rows are display-only.
   */
  onOpenChild?: (entry: SubagentEntry) => void
  /** Repaint hook owned by the parent; never a stdout write. */
  onRenderRequest?: () => void
  /**
   * Total line budget (header, rows, overflow and the trailing separator).
   * Read on every `render()`, so a getter may track the terminal height and the
   * actual sibling heights of the editor, queue, hint and footer.
   */
  maxRows?: number | (() => number)
  /**
   * True while a dialog, decision, details/Agents/child overlay owns input.
   * A getter is read on every `render()`/`handleMouse()` call.
   */
  mouseBlocked?: boolean | (() => boolean)
  /** Clock for native session-total timing; injectable for deterministic tests. */
  now?: () => number
}

/** One planned child row for this frame. */
interface RowPlan {
  readonly entry: SubagentEntry
  /** Live (`running`/`initializing`) rows are prioritized over settled history. */
  readonly active: boolean
  /** The parent's current reply target: pinned first and visually marked. */
  readonly pinned: boolean
  /** Native current activity; only a live row with a native activity has one. */
  readonly activity?: string
}

/** One admitted row and whether its native activity line fits. */
interface SelectedRow {
  readonly plan: RowPlan
  readonly withActivity: boolean
}

interface RowSelection {
  readonly rows: readonly SelectedRow[]
  readonly hidden: readonly SubagentEntry[]
  /** Budget lines consumed by `rows` (an activity line counts twice). */
  readonly used: number
}

/** Inclusive component-local columns of one painted internal link. */
interface LinkSpan {
  readonly startCol: number
  readonly endCol: number
}

/** One painted line plus the link geometry actually visible on that line. */
interface PaintedLine {
  readonly line: string
  /** Absent when the link is inert or its text was clipped out of view. */
  readonly link?: LinkSpan
}

/** How one painted link should be styled this frame. */
interface LinkPaint {
  /** False for external/remote children, a missing callback or a blocked frame. */
  readonly linkable: boolean
  /** True only while the pointer is inside this exact link. */
  readonly hovered: boolean
}

export class SubagentProgress implements Component {
  /** Native catalog projection, replaced by the parent before every render. */
  entries: readonly SubagentEntry[] = []
  /** True only when DSH reports the native catalog as incomplete. */
  truncated = false
  /** Child id the one root Editor is currently addressing, if any. */
  replyTargetId?: string
  private readonly options: SubagentProgressOptions
  private readonly keymap: CcKeymap
  private readonly hitboxes = new HitboxRegistry()
  private readonly now: () => number
  /** This frame's hitboxes, kept for gesture validation (see handleMouse). */
  private boxes: readonly MouseHitbox[] = []
  private hoveredId?: string
  /** True between a claimed press and its click. */
  private pressPending = false
  /** Set when the world changed mid-gesture: the synthesized click is dropped. */
  private gestureVoid = false
  /** Region id claimed by the current press, validated again on the click. */
  private pressedBoxId?: string
  /**
   * Set when a press landed outside every link (so the renderer kept it for
   * text selection). A later synthesized click must then never resolve the
   * name that a repaint moved under the press coordinates.
   */
  private pressOutside = false
  /**
   * Set once a drag was observed in this gesture. The native renderer already
   * suppresses the click after motion; this local veto keeps a synthetic
   * press→drag→click sequence from ever becoming a navigation jump.
   */
  private dragged = false
  private disposed = false
  private budgetValue = DEFAULT_MAX_ROWS
  /** True after the host assigned the field: an explicit assignment wins. */
  private budgetAssigned = false
  private blockedValue = false
  private blockedAssigned = false

  constructor(options: SubagentProgressOptions = {}) {
    this.options = options
    this.keymap = options.keymap ?? createCcKeymap()
    this.now = options.now ?? Date.now
    // A numeric option is only the initial value; assigning the public field
    // later still wins. A host accessor/callback stays live (see rowBudget).
    if (typeof options.maxRows === 'number') this.budgetValue = options.maxRows
    if (typeof options.mouseBlocked === 'boolean') this.blockedValue = options.mouseBlocked
  }

  /**
   * Total line budget (header, rows, overflow and the trailing separator).
   *
   * Precedence: an explicit assignment wins, otherwise the constructor option
   * (a live host accessor or a callback is re-read on every paint), otherwise
   * the last numeric value. The parent's height budget therefore adapts to a
   * resize or a growing multiline draft without any component timer.
   */
  get maxRows(): number {
    return this.budgetValue
  }

  set maxRows(value: number) {
    this.budgetValue = value
    this.budgetAssigned = true
  }

  /** True while another surface owns input; every hitbox is dropped. */
  get mouseBlocked(): boolean {
    return this.blockedValue
  }

  set mouseBlocked(value: boolean) {
    this.blockedValue = value
    this.blockedAssigned = true
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * Drop this frame's hitboxes and hover state (parent-driven invalidation).
   *
   * A pending *claimed* press is voided at the same time: the attachment the
   * user pressed may have been replaced, so the synthesized click must not run
   * against the new frame — even when the same child id is still on screen.
   * An unclaimed (outside) press or a drag keeps its tombstone instead: its
   * release may still synthesize a click after reattachment, and that click
   * must stay unhandled so native selection/copy is untouched. Only a real new
   * press or the completion of the gesture clears the tombstone.
   */
  invalidate(): void {
    if (this.pressPending) this.gestureVoid = true
    this.hitboxes.clear()
    this.hoveredId = undefined
  }

  /** Idempotent; never moves focus, never calls a parent callback, keeps no timer. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.pressPending = false
    this.pressOutside = false
    this.dragged = false
    this.gestureVoid = true
    this.pressedBoxId = undefined
    this.boxes = []
    this.hitboxes.clear()
    this.hoveredId = undefined
  }

  /**
   * Mouse dispatch with gesture validation on top of `HitboxRegistry`.
   *
   * Only a press on a link claims the renderer's gesture; every press, move and
   * drag elsewhere stays unclaimed so native selection, drag-to-select and
   * copy-on-select keep working over all non-link text (the branch guide, the
   * status glyph, gaps, metrics, activity and padding). Motion is never claimed
   * either: hover is a local repaint concern, and a drag that started in plain
   * text must not be stolen just because it crosses a link's columns.
   *
   * The registry already pins a press to its region id, so a repaint that moves
   * the label (reflow/reorder) keeps the same child. Three local guards cover
   * what a pin alone cannot: a press that began outside a link (a later click
   * must not resolve a name that a repaint moved under the old coordinates),
   * the pressed region disappearing (a removed child or a clipped-away label
   * must never retarget whatever lands on the old coordinates) and an
   * `invalidate()` between press and release (attachment/session replacement —
   * the click is swallowed instead of reading the new frame).
   */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) {
      // Final teardown: the object never reactivates, so no gesture survives.
      this.resetGesture()
      return undefined
    }
    if (event.type === 'press') {
      // A real new press always starts a new gesture.
      this.resetGesture()
      // Right/middle presses keep their native paste/selection behavior.
      if (event.button !== 'left') return this.hitboxes.handleMouse(event)
      // While another surface owns input nothing is claimed, but the press is
      // remembered as an outside one so its release also stays unhandled.
      if (this.blocked()) {
        this.pressOutside = true
        return undefined
      }
      const box = this.claimableAt(event.y, event.x)
      if (box === undefined) {
        // Outside every link: claim nothing. TuiAltScreen keeps the press for
        // text selection, and a repaint that later moves a name under these
        // coordinates (or a reattachment) cannot turn it into navigation.
        this.pressOutside = true
        return this.hitboxes.handleMouse(event)
      }
      this.pressPending = true
      this.pressedBoxId = box.id
      return this.hitboxes.handleMouse(event)
    }
    // Another surface owns input: freeze the in-flight gesture (a blocked
    // interval must never read as a fresh one) and never touch selection.
    if (this.blocked()) {
      this.noteBlocked()
      return undefined
    }
    if (event.type === 'click') {
      // A click synthesized after an unclaimed press belongs to the renderer:
      // report it unhandled so native selection/copy is not cleared.
      if (this.pressOutside) {
        this.resetGesture()
        return undefined
      }
      // A drag is never a click jump, even if a synthetic click follows it.
      const dragged = this.dragged
      const swallow = dragged || (this.pressPending && (this.gestureVoid ||
        (this.pressedBoxId !== undefined && !this.boxes.some(box => box.id === this.pressedBoxId))))
      this.resetGesture()
      if (swallow) return { handled: true }
      return this.hitboxes.handleMouse(event)
    }
    if (event.type === 'drag') {
      // The renderer suppresses the click after a drag; keep no stale press.
      // An outside press keeps its tombstone, so its release stays unhandled.
      this.pressPending = false
      this.pressedBoxId = undefined
      this.dragged = true
    }
    // Hover still updates (a repaint may be requested by `setHover`), but the
    // motion itself is never claimed: selection and drag stay native.
    this.hitboxes.handleMouse(event)
    return undefined
  }

  /**
   * Another surface took input mid-gesture.
   *
   * A claimed press is voided (its click is swallowed after the dialog closes),
   * while an outside press or a drag keeps its tombstone: the release belongs
   * to the renderer and must stay unhandled.
   */
  private noteBlocked(): void {
    if (this.pressPending) this.gestureVoid = true
  }

  /** First press-claiming hitbox under a component-local cell. */
  private claimableAt(row: number, col: number): MouseHitbox | undefined {
    const box = this.boxAt(row, col)
    return box === undefined || box.claimPress === false ? undefined : box
  }

  /** Forget the press bookkeeping (never a callback, never focus). */
  private resetGesture(): void {
    this.pressPending = false
    this.pressOutside = false
    this.dragged = false
    this.gestureVoid = false
    this.pressedBoxId = undefined
  }

  /** First hitbox under a component-local cell (declaration order wins). */
  private boxAt(row: number, col: number): MouseHitbox | undefined {
    return this.boxes.find(box =>
      row >= box.startRow && row <= box.endRow &&
      (box.startCol === undefined || col >= box.startCol) &&
      (box.endCol === undefined || col <= box.endCol))
  }

  render(width: number): string[] {
    if (this.disposed) {
      this.syncFrame([])
      return []
    }
    const size = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1
    const entries = this.deduped()
    // An empty catalog renders nothing at all: no blank spacer, invisible
    // hitbox or host-side sibling/Editor measurement on ordinary idle paints.
    if (entries.length === 0) {
      this.syncFrame([])
      return []
    }
    const budget = this.rowBudget()
    if (budget < 1) {
      this.syncFrame([])
      return []
    }

    const blocked = this.blocked()
    // A temporary dialog/overlay must not make an in-flight claimed press look
    // fresh again once it closes; outside/drag tombstones are left untouched.
    if (blocked) this.noteBlocked()
    const boxes: MouseHitbox[] = []
    const openAgents = blocked ? undefined : this.options.onOpenAgents
    const header = this.headerLine(size, entries, {
      linkable: openAgents !== undefined,
      hovered: openAgents !== undefined && this.hoveredId === HEADER_HITBOX,
    })
    const lines: string[] = [header.line]
    if (openAgents !== undefined && header.link !== undefined) {
      boxes.push({
        id: HEADER_HITBOX,
        startRow: 0,
        endRow: 0,
        startCol: header.link.startCol,
        endCol: header.link.endCol,
        claimPress: true,
        onClick: () => openAgents(),
        onHover: entering => this.setHover(entering ? HEADER_HITBOX : undefined),
      })
    }

    let remaining = budget - 1
    const plans = this.planRows(entries)
    let selection = this.selectRows(plans, remaining)
    // The overflow summary is part of the bounded-list contract; when the rows
    // currently spend the last line, reserve one so the count cannot vanish.
    if (selection.hidden.length > 0 && remaining - selection.used < 1 && remaining >= 2) {
      selection = this.selectRows(plans, remaining - 1)
    }
    remaining -= selection.used
    const showOverflow = selection.hidden.length > 0 && remaining >= 1
    if (showOverflow) remaining -= 1

    for (const [index, row] of selection.rows.entries()) {
      const last = index === selection.rows.length - 1 && !showOverflow
      const rowIndex = lines.length
      const entry = row.plan.entry
      const openChild = blocked ? undefined : this.options.onOpenChild
      const boxId = `${ROW_HITBOX_PREFIX}${entry.id}`
      const linkable = openChild !== undefined && subagentOpenable(entry)
      const painted = this.mainLine(row.plan, size, last, {
        linkable,
        hovered: linkable && this.hoveredId === boxId,
      })
      lines.push(painted.line)
      if (row.withActivity) lines.push(this.activityLine(row.plan, size, last))
      if (openChild === undefined || painted.link === undefined) continue
      boxes.push({
        id: boxId,
        startRow: rowIndex,
        endRow: rowIndex,
        startCol: painted.link.startCol,
        endCol: painted.link.endCol,
        claimPress: true,
        onClick: () => openChild(entry),
        onHover: entering => this.setHover(entering ? boxId : undefined),
      })
    }
    if (showOverflow) {
      const overflowRow = lines.length
      const painted = this.overflowLine(selection.hidden, size, {
        linkable: openAgents !== undefined,
        hovered: openAgents !== undefined && this.hoveredId === OVERFLOW_HITBOX,
      })
      lines.push(painted.line)
      // The count is the way to inspect the children this widget had to hide.
      if (openAgents !== undefined && painted.link !== undefined) {
        boxes.push({
          id: OVERFLOW_HITBOX,
          startRow: overflowRow,
          endRow: overflowRow,
          startCol: painted.link.startCol,
          endCol: painted.link.endCol,
          claimPress: true,
          onClick: () => openAgents(),
          onHover: entering => this.setHover(entering ? OVERFLOW_HITBOX : undefined),
        })
      }
    }
    // One separator row between the widget and the editor border, and only
    // when the parent's budget still has room for it.
    if (remaining >= 1 && selection.rows.length > 0) lines.push('')

    // A row clipped away must not stay clickable on this frame.
    this.syncFrame(boxes.filter(box => box.endRow < lines.length))
    return lines.map(line => fit(line, size))
  }

  /**
   * Publish this frame's hitboxes.
   *
   * Losing the pressed region at any point voids the pending gesture, even if
   * the same region id comes back before the release: a hidden or removed row
   * that reappears at the old coordinates must never receive that click.
   */
  private syncFrame(boxes: readonly MouseHitbox[]): void {
    this.boxes = boxes
    const changes = this.hitboxes.sync(boxes)
    // A repaint carries no pointer motion: a link that vanished must not keep
    // painting as hovered. A same-id rect move is reported as exit + enter and
    // the pointer may still be on it, so only a real removal clears the flag.
    if (this.hoveredId !== undefined &&
      changes.exited?.id === this.hoveredId && changes.entered?.id !== this.hoveredId) {
      this.hoveredId = undefined
    }
    if (this.pressPending && this.pressedBoxId !== undefined && !boxes.some(box => box.id === this.pressedBoxId)) {
      this.gestureVoid = true
    }
  }

  // -------------------------------------------------------------------------
  // Budget / blocking / hover

  private rowBudget(): number {
    const option = this.options.maxRows
    const raw = this.budgetAssigned ? this.budgetValue
      : typeof option === 'function' ? option()
        : typeof option === 'number' ? option
          : this.budgetValue
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_MAX_ROWS
    return Math.max(0, Math.floor(raw))
  }

  private blocked(): boolean {
    if (this.blockedAssigned) return this.blockedValue
    const option = this.options.mouseBlocked
    if (typeof option === 'function') return option() === true
    if (typeof option === 'boolean') return option
    return this.blockedValue
  }

  private setHover(id: string | undefined): void {
    if (this.hoveredId === id) return
    this.hoveredId = id
    this.options.onRenderRequest?.()
  }

  /** Native order with duplicate child ids collapsed (first wins). */
  private deduped(): readonly SubagentEntry[] {
    const seen = new Set<string>()
    const out: SubagentEntry[] = []
    for (const entry of this.entries) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      out.push(entry)
    }
    return out
  }

  // -------------------------------------------------------------------------
  // Header

  /**
   * `● Agents · 5 children · Ctrl+X Ctrl+A open`
   *
   * The native heading marker is brand blue while a child is live, dim once
   * everything settles. The actionable `Agents` word remains a blue internal
   * link, not a second status source. The count is dim and honest; the open
   * hint comes from the real keymap in the
   * editor context, so a remapped action advertises the new key and a disabled
   * one advertises nothing instead of a dead chord.
   *
   * Only the `Agents` word is a link: the bullet, the count and the chord keep
   * their plain text and the native selection behavior.
   */
  private headerLine(
    width: number,
    entries: readonly SubagentEntry[],
    paint: LinkPaint,
  ): PaintedLine {
    let active = 0
    for (const entry of entries) if (isActive(entry)) active += 1
    const style = active > 0 ? t.accent : dim
    const word = 'Agents'
    const prefix = style('●') + ' '
    let line = prefix + (paint.linkable ? linkStyle(paint.hovered)(word) : style(word))
    const append = (styled: string): void => {
      const next = `${line}${dim(' · ')}${styled}`
      if (visibleWidth(next) <= width) line = next
    }
    const total = entries.length
    append(dim(`${total} ${total === 1 ? 'child' : 'children'}`))
    if (this.truncated) append(t.yellow('incomplete'))
    const hint = this.openHint()
    if (hint !== undefined) append(dim(`${hint} open`))
    return paintedLine(line, width, visibleWidth(prefix), visibleWidth(word), paint.linkable)
  }

  /** Effective `app.subagents.details` chord in the editor context, if any. */
  private openHint(): string | undefined {
    const action = this.keymap.getAction(OPEN_AGENTS_ACTION)
    if (action === undefined) return undefined
    const chain = this.keymap.getFallbackChain('editor')
    if (!action.contexts.some(context => chain.includes(context))) return undefined
    const binding = this.keymap.getBindings(OPEN_AGENTS_ACTION)[0]
    return binding === undefined ? undefined : formatBinding(binding.split(' '))
  }

  // -------------------------------------------------------------------------
  // Rows

  /**
   * Priority order for a bounded widget: the parent's reply target first (the
   * next prompt addresses it), then live children, then settled history, each
   * group in native catalog order.
   */
  private planRows(entries: readonly SubagentEntry[]): readonly RowPlan[] {
    const targetId = this.replyTargetId
    const target = targetId === undefined ? undefined : entries.find(entry => entry.id === targetId)
    const plans: RowPlan[] = []
    if (target !== undefined) plans.push(this.planRow(target, true))
    for (const entry of entries) {
      if (target !== undefined && entry.id === target.id) continue
      if (isActive(entry)) plans.push(this.planRow(entry, false))
    }
    for (const entry of entries) {
      if (target !== undefined && entry.id === target.id) continue
      if (!isActive(entry)) plans.push(this.planRow(entry, false))
    }
    return plans
  }

  private planRow(entry: SubagentEntry, pinned: boolean): RowPlan {
    const activity = subagentActivity(entry)
    return {
      entry,
      active: isActive(entry),
      pinned,
      ...(activity === undefined ? {} : { activity }),
    }
  }

  /**
   * `├─ ⏺ frontend-developer  continuable · running · 1m 30s · 75.9k tok · deepseek/deepseek-chat`
   *
   * Label + mode/status are reserved, so a long label can never push the honest
   * native state off the row; the session-total timing/tokens and the route are
   * low-priority extras that disappear first. Nothing is invented: an absent
   * native metric simply paints nothing.
   *
   * `link` reports the painted columns of the label only — never the branch
   * guide, the status glyph, the gap before the mode/status or anything after
   * the label. The span is derived from the exact painted text after the final
   * clip, so CJK, emoji/ZWJ/combining and ANSI styling stay in display columns,
   * and a label that was clipped away yields no span at all.
   */
  private mainLine(plan: RowPlan, width: number, last: boolean, paint: LinkPaint): PaintedLine {
    const entry = plan.entry
    const pinned = plan.pinned
    const tone = subagentTone(entry)
    const glyph = markStyle(tone)(TONE_GLYPH[tone])
    const head = dim(last ? '└─' : '├─') + ' ' + glyph + ' '
    const statusText = subagentStatusLabel(entry)
    const status = TONE_STYLE[tone](statusText)
    // `external` is already a leaf status; repeating `external · external` is noise.
    const external = entry.mode === 'external' || entry.status === 'external'
    const gap = '  '
    const modeText = external ? '' : subagentModeLabel(entry.mode)
    const gapWidth = visibleWidth(gap)
    const statusWidth = visibleWidth(statusText)
    const modeWidth = visibleWidth(modeText) + visibleWidth(dim(' · '))
    // Mode is secondary: keep it only while the label still has a readable
    // width, so a narrow row degrades to `label · status` instead of an ellipsis.
    const keepMode = modeText !== '' && width - visibleWidth(head) - gapWidth - statusWidth - modeWidth >= MIN_LABEL_WIDTH
    const secondary = keepMode ? dim(modeText) + dim(' · ') + status : status
    const labelRoom = Math.max(1, width - visibleWidth(head) - visibleWidth(secondary) - gapWidth)
    const label = truncateToWidth(flatten(subagentLabel(entry)), labelRoom, '…')
    const styledLabel = paint.linkable
      ? linkStyle(paint.hovered)(label)
      : pinned ? bold(t.accentBright(label)) : bold(t.text(label))
    let line = head + styledLabel + gap + secondary
    if (pinned) line = appendIfFits(line, t.accentBright('reply target'), width)
    const timing = subagentTimingLabel(entry.timing, this.now())
    if (timing !== undefined) line = appendIfFits(line, dim(timing), width)
    const tokens = subagentTokensLabel(entry.totalTokens)
    if (tokens !== undefined) line = appendIfFits(line, dim(tokens), width)
    const route = subagentRouteLabel(entry)
    if (route !== undefined) line = appendIfFits(line, dim(flatten(route)), width)
    return paintedLine(line, width, visibleWidth(head), visibleWidth(label), paint.linkable)
  }

  /**
   * Indented native activity of one live child, in the plugin's `⎿` shape.
   *
   * `subagentActivity` already whitespace-folds through `oneLine`; flattening
   * again is the local guarantee that this surface only ever emits one row per
   * planned line.
   */
  private activityLine(plan: RowPlan, width: number, last: boolean): string {
    const activity = flatten(plan.activity ?? '')
    return fit(dim(`${last ? '   ' : '│  '}  ⎿  ${activity}`), width)
  }

  /**
   * `└─ +3 more (1 idle, 2 completed)`
   *
   * Grouped by the raw native status label, so the count never invents a
   * category ("finished", a percentage or a business mode). Only the
   * `+N more` text is a link; the tree guide and the parenthesized grouped
   * counts stay plain text.
   */
  private overflowLine(
    hidden: readonly SubagentEntry[],
    width: number,
    paint: LinkPaint,
  ): PaintedLine {
    const counts = new Map<string, number>()
    for (const entry of hidden) {
      const label = subagentRawStatusLabel(entry.status)
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    const detail = [...counts.entries()].map(([label, count]) => `${count} ${label}`).join(', ')
    const guide = dim('└─') + ' '
    const count = `+${hidden.length} more`
    const line = guide +
      (paint.linkable ? linkStyle(paint.hovered)(count) : dim(count)) +
      dim(` (${detail})`)
    return paintedLine(line, width, visibleWidth(guide), visibleWidth(count), paint.linkable)
  }

  /**
   * Greedy selection in priority order under a hard line budget.
   *
   * A live child is admitted together with its native activity line before any
   * settled history is considered, so the Pi two-line design survives a busy
   * catalog: three live children keep their activity lines while finished
   * children collapse into the `+N more` count. Only when the budget cannot
   * hold another two-line row does a live child degrade to its summary line;
   * once a live row cannot be admitted at all, lower-priority settled rows stop
   * being admitted too.
   */
  private selectRows(plans: readonly RowPlan[], available: number): RowSelection {
    const rows: SelectedRow[] = []
    const hidden: SubagentEntry[] = []
    let remaining = Math.max(0, Math.floor(available))
    const start = remaining
    let activeCut = false
    for (const plan of plans) {
      if (activeCut && !plan.active) {
        hidden.push(plan.entry)
        continue
      }
      if (plan.activity !== undefined && remaining >= 2) {
        rows.push({ plan, withActivity: true })
        remaining -= 2
        continue
      }
      if (remaining >= 1) {
        rows.push({ plan, withActivity: false })
        remaining -= 1
        continue
      }
      if (plan.active) activeCut = true
      hidden.push(plan.entry)
    }
    return { rows, hidden, used: start - remaining }
  }
}

function isActive(entry: Pick<SubagentEntry, 'status'>): boolean {
  return entry.status === 'running' || entry.status === 'initializing'
}

/**
 * Internal TUI link style: bold brand blue + underline, brighter while hovered.
 *
 * These are hitbox-backed links, never OSC 8 hyperlinks, so the underline is
 * real SGR inside the painted label and no URL/browser/custom scheme exists.
 */
function linkStyle(hovered: boolean): Style {
  return hovered
    ? text => underline(bold(t.accentBright(text)))
    : text => underline(bold(t.accent(text)))
}

/**
 * Paint one line and derive its link geometry from the text that survives.
 *
 * `fit` clips through Pi TUI's `truncateToWidth`, so the painted content is a
 * contiguous prefix of the raw line: all of it when the line fits, otherwise
 * only the columns left by the three-cell ellipsis that replaces the tail.
 * Geometry therefore never covers an ellipsis cell or any clipped-away label:
 * a label that starts at or beyond the last painted content cell yields no
 * span at all, and a partially clipped one stops at the last visible column.
 */
function paintedLine(
  raw: string,
  width: number,
  prefixWidth: number,
  textWidth: number,
  linkable: boolean,
): PaintedLine {
  const line = fit(raw, width)
  if (!linkable || textWidth <= 0) return { line }
  const contentWidth = paintedContentWidth(visibleWidth(raw), width)
  if (prefixWidth >= contentWidth) return { line }
  return {
    line,
    link: {
      startCol: prefixWidth,
      endCol: Math.min(prefixWidth + textWidth - 1, contentWidth - 1),
    },
  }
}

/** Columns of a raw line whose original text is still painted after `fit`. */
function paintedContentWidth(rawWidth: number, width: number): number {
  if (rawWidth <= width) return rawWidth
  return Math.max(0, width - visibleWidth('...'))
}

/** Append one low-priority segment only while the row still fits the width. */
function appendIfFits(line: string, segment: string, width: number): string {
  const next = `${line}${dim(' · ')}${segment}`
  return visibleWidth(next) <= width ? next : line
}