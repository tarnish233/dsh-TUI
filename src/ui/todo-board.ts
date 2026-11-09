/**
 * Native DSH todos projection as the compact checklist docked immediately
 * above the one Editor.
 *
 * Claude Code reference (public documentation and public observations only;
 * no proprietary source was read):
 *
 * - CC keeps a task checklist in the terminal "status area"; `Ctrl+T` (the
 *   `app:toggleTodos` action) shows or hides it. The view shows up to five
 *   tasks at a time, and an expanded view is restored when a session still has
 *   tasks. With no checklist items the toggle has no visible effect.
 *   <https://code.claude.com/docs/en/interactive-mode#task-list>
 *   <https://code.claude.com/docs/en/keybindings>
 * - A checklist update replaces the previous list; items are `pending`,
 *   `in_progress` or `completed`, and completed work recedes while the active
 *   step is the emphasised row.
 *   <https://code.claude.com/docs/en/agent-sdk/todo-tracking>
 * - CC's tray disappears once every item is completed (public issue #15408,
 *   reported on CC 2.0.76/macOS), so this dock represents current work only.
 *   The native checklist still exists in the transcript block and through the
 *   parent's summary command; hiding the dock never deletes the snapshot.
 *
 * What this component is NOT: a todo engine, a scheduler, a tool, a model-text
 * parser or a second renderer. DSH owns the `todos` projection; the parent
 * assigns the latest `TodosSnapshot` before painting. There is no timer, no
 * polling, no persistence, no local status inference and no mutation of the
 * native items.
 *
 * Identity and updates:
 *
 * - `TodoItem` has no id. Identity inside one snapshot is therefore the native
 *   array index; the component keys by it and never by content. A status-only
 *   update repaints the same row, duplicate contents remain two distinct rows,
 *   and reordering is whatever DSH sent (no sorting, no dedupe, no merging).
 * - A new snapshot replaces the previous one completely (CC's TodoWrite
 *   contract). `null` — DSH's "the fold is empty" — paints nothing and keeps no
 *   previous row, count, overflow or session fact.
 * - An unknown runtime status is painted as still pending; it is never
 *   upgraded to completed. Blank or non-string content is skipped rather than
 *   replaced with invented text.
 *
 * Height and width:
 *
 * - CC shows at most five tasks. This dock keeps that cap and treats its
 *   `maxRows` as a hard total (header + task rows + overflow count + optional
 *   trailing separator).
 * - `preferredRows` / `comfortableRows` / `compactRows` are pure presentation
 *   facts for a parent that composes several docks: `preferredRows` is the
 *   full-tray content height (header + up to five tasks, never the separator),
 *   `comfortableRows` is the smallest useful content (header + first task) and
 *   `compactRows` is the one-row fallback. They read the same native
 *   projection as `render()` and never paint, measure a width or mutate state,
 *   so a shared status-dock stack can plan its budget without re-rendering.
 * - `trailingSeparator` (default `true`) preserves the standalone blank row
 *   between this dock and the editor border. A root `StatusDockStack` owns
 *   inter-section gaps, so it constructs the dock with `false`; the component
 *   then never chooses a root gap itself. This is a rendering parameter, not
 *   a settings hierarchy.
 * - `maxRows === 0` hides the dock completely. An explicit `maxRows === 1` is
 *   the one-row compact fallback (see below); it exists because a sibling
 *   status dock can shrink this dock's budget to a single row while it still
 *   holds real unfinished work, and dropping the checklist there would hide a
 *   durable native fact. A one-row budget is never a header-only strip: the
 *   row must identify Todos and keep the true native counts.
 * - `maxRows >= 2` always keeps the full CC tray (header plus up to five task
 *   rows) and never switches to the compact form.
 * - Tasks are one display line each with a trailing ellipsis, matching CC's
 *   compact status-area checklist (long titles are truncated, not wrapped).
 *   The full text remains available in the transcript block. Every line is
 *   sanitized/fitted with Pi TUI width helpers, so CJK, emoji, combining
 *   characters and hostile control bytes can never exceed the given width.
 * - Narrow terminals fall back from the transcript's `⎿` elbow to a compact
 *   `☑ text` row. All counts/hints are appended only while they fit.
 *
 * Chrome uses only the shared theme roles (`t`, `cc`, `bold`, `dim`) and paints
 * no background of its own: the dock inherits the terminal canvas, matching the
 * transparent `surfaces.canvas`. There is no hardcoded background slab and no
 * `surfaces.raised` band here; a parent that wants an inset band must apply the
 * shared `surfaces.raised.fill(text, width)` outside this component.
 *
 * This component is not Focusable, installs no input listener and handles no
 * mouse input: the main Editor keeps focus, ordinary typing and native text
 * selection. It never writes to stdout.
 *
 * @module dsh-tui/ui/todo-board
 */
import type { Component } from '#pi-tui'
import type { TodoItem, TodosSnapshot } from '../backend/types.ts'
import { createCcKeymap, formatBinding, type CcKeymap } from '../input/index.ts'
import { fit, oneLine, sanitize, truncateToWidth, visibleWidth } from './text.ts'
import { bold, cc, dim, t } from './theme.ts'

/** Hard total when the parent supplies no budget (header + five tasks + gap). */
const DEFAULT_MAX_ROWS = 7

/** Claude Code shows at most five tasks at a time. */
const MAX_VISIBLE_ITEMS = 5

/** Minimum task text that justifies the transcript's elbow guide. */
const MIN_ELBOW_TEXT = 8

/**
 * Minimum task text that justifies appending an item to the one-row compact
 * fallback. Below this the row would only paint an ellipsis, so identity and
 * the native counts win and the item is dropped instead.
 */
const MIN_COMPACT_ITEM_TEXT = 4

/** The parent action that toggles this dock (CC's `app:toggleTodos`). */
const TOGGLE_ACTION = 'app.todo'

const HEADER_MARK = '⏺'
const ELBOW = '  ⎿  '
const INDENT = '     '
const GLYPH_WIDTH = 2

const STATUS_GLYPH: Readonly<Record<TodoItem['status'], string>> = {
  completed: '☑',
  in_progress: '◐',
  pending: '☐',
}

/** Counts of the non-empty items in the current native snapshot. */
export interface TodoBoardCounts {
  readonly total: number
  readonly completed: number
  readonly inProgress: number
  readonly pending: number
}

export interface TodoBoardOptions {
  /** Shared CC keymap; only used to advertise the real toggle chord. */
  keymap?: CcKeymap
  /**
   * Hard total line budget (header, task rows and the optional separator).
   * A getter is re-sampled on every `render()`, so the parent can account for
   * terminal height, resize and sibling dock/editor heights without a timer.
   * `0` hides the dock; `1` paints the single-row compact fallback (identity,
   * native counts and the first unfinished item while it fits); `>= 2` always
   * paints the full CC tray.
   */
  maxRows?: number | (() => number)
  /**
   * Show the effective `app.todo` chord in the header. Off by default: only a
   * parent that really routes Ctrl+T to {@link TodoBoard.toggle} should
   * advertise it. A getter is re-read on every paint.
   */
  hint?: boolean | (() => boolean)
  /**
   * Emit the standalone trailing blank row (header/tasks + one gap) when the
   * budget still has room. Default `true` keeps the historical standalone
   * shape. A root `StatusDockStack` constructs this dock with `false` because
   * the stack owns every inter-section gap uniformly.
   */
  trailingSeparator?: boolean
  /** Initial visibility (the parent owns Ctrl+T policy and any persistence). */
  visible?: boolean
}

export class TodoBoard implements Component {
  /**
   * Latest native snapshot, assigned by the parent before every paint.
   * `null` and an empty list both paint nothing. The component copies and
   * normalizes on read; it never mutates the supplied array or its items.
   */
  todos: TodosSnapshot = null
  /**
   * Ctrl+T visibility, owned by the parent. Assignment never renders and never
   * changes the native snapshot; a hidden board keeps no painted rows.
   */
  visible: boolean
  /**
   * Parent-supplied Working frame for this paint, the same one-cell glyph the
   * host already uses in its editor status (`· ✻ ✶ ✳`). Only an
   * `in_progress` row reads it, and only a single display cell survives
   * sanitization; anything else falls back to the static `◐`. This is
   * presentation input only: no timer, no animation, no status change.
   */
  spinnerFrame?: string

  private readonly options: TodoBoardOptions
  private readonly keymap: CcKeymap
  private disposed = false
  private budgetValue = DEFAULT_MAX_ROWS
  private budgetAssigned = false

  constructor(options: TodoBoardOptions = {}) {
    this.options = options
    this.keymap = options.keymap ?? createCcKeymap()
    this.visible = options.visible !== false
    if (typeof options.maxRows === 'number') this.budgetValue = options.maxRows
  }

  /**
   * Hard total line budget. An explicit assignment wins; otherwise the
   * constructor option (a live parent accessor is re-read each paint) wins;
   * otherwise the last numeric value. Non-finite values fall back to the
   * default and negatives mean "hide". Exactly `1` is the compact one-row
   * fallback; `>= 2` is always the full tray.
   */
  get maxRows(): number {
    return this.budgetValue
  }

  set maxRows(value: number) {
    this.budgetValue = value
    this.budgetAssigned = true
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * Native display counts for the current snapshot. Pure projection of DSH's
   * statuses (unknown statuses count as pending); useful for the parent's
   * Ctrl+T routing without letting the parent reimplement row filtering.
   */
  get counts(): TodoBoardCounts {
    const items = this.displayItems()
    let completed = 0
    let inProgress = 0
    let pending = 0
    for (const item of items) {
      if (item.status === 'completed') completed += 1
      else if (item.status === 'in_progress') inProgress += 1
      else pending += 1
    }
    return { total: items.length, completed, inProgress, pending }
  }

  /** True while the native snapshot has at least one non-completed item. */
  get hasOpenItems(): boolean {
    return this.displayItems().some(item => item.status !== 'completed')
  }

  /**
   * Full-tray content height at the current native snapshot: the header plus up
   * to five task rows. Excludes the optional trailing separator and any budget
   * cap. `0` means this dock paints nothing (hidden, disposed, empty or
   * all-completed). Pure: it never calls `render()` and never mutates state.
   */
  get preferredRows(): number {
    const items = this.paintableItems()
    if (items === undefined) return 0
    return 1 + Math.min(items.length, MAX_VISIBLE_ITEMS)
  }

  /**
   * Smallest useful content height: header plus the first task, bounded by
   * {@link preferredRows}. `0` when the dock paints nothing. A parent that
   * cannot afford this should fall back to {@link compactRows} before spending
   * rows on inter-section whitespace.
   */
  get comfortableRows(): number {
    const preferred = this.preferredRows
    return preferred === 0 ? 0 : Math.min(preferred, 2)
  }

  /** One-row native fallback: identity, true counts and first unfinished item. */
  get compactRows(): number {
    return this.paintableItems() === undefined ? 0 : 1
  }

  /**
   * Flip the parent-owned Ctrl+T visibility and return the new state.
   * Never paints, focuses, persists or calls a callback: the parent requests
   * its own render.
   */
  toggle(): boolean {
    this.visible = !this.visible
    return this.visible
  }

  /** No cached frame is kept; this is an idempotent parent-driven invalidation. */
  invalidate(): void {}

  /** Idempotent; drops the snapshot reference and paints nothing afterwards. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.todos = null
  }

  render(width: number): string[] {
    const items = this.paintableItems()
    if (items === undefined) return []
    const budget = this.rowBudget()
    // No row budget at all: paint nothing.
    if (budget < 1) return []

    const size = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1
    // A single-row budget is the compact fallback, not a header-only strip:
    // one line that names the dock, keeps the native counts and shows the
    // first unfinished native item while the width allows it.
    if (budget === 1) return [fit(this.compactLine(size, items), size)]

    const capacity = Math.min(items.length, MAX_VISIBLE_ITEMS, budget - 1)
    if (capacity < 1) return []

    const shown = items.slice(0, capacity)
    const hidden = items.length - shown.length
    let completed = 0
    for (const item of items) if (item.status === 'completed') completed += 1
    const lines = [this.headerLine(size, items.length, completed, hidden)]

    for (const [index, item] of shown.entries()) {
      lines.push(this.taskLine(size, item, index === 0))
    }
    // One separator row between the dock and the editor border, and only when
    // the parent's budget still has room for it. A root stack disables it and
    // owns every inter-section gap itself.
    if (this.options.trailingSeparator !== false && lines.length < budget && shown.length > 0) lines.push('')
    return lines.map(line => fit(line, size))
  }

  // -------------------------------------------------------------------------
  // Native projection only

  /**
   * Native items this dock can actually paint right now, or `undefined` when
   * there is no row to emit (hidden, disposed, empty, invalid or only finished
   * work). CC retires the checklist tray once every item is complete; the
   * transcript block and the parent summary still hold the native facts.
   */
  private paintableItems(): Array<{ readonly content: string; readonly status: TodoItem['status'] }> | undefined {
    if (this.disposed || !this.visible) return undefined
    const items = this.displayItems()
    if (items.length === 0 || items.every(item => item.status === 'completed')) return undefined
    return items
  }

  /**
   * Non-empty native items in native order, with unknown statuses normalized
   * to `pending` and content copied/sanitized at paint time. No dedupe, no
   * sorting and no ids are invented: index is identity inside the snapshot.
   */
  private displayItems(): Array<{ readonly content: string; readonly status: TodoItem['status'] }> {
    const snapshot = this.todos
    if (!Array.isArray(snapshot)) return []
    const out: Array<{ content: string; status: TodoItem['status'] }> = []
    for (const raw of snapshot) {
      if (raw === null || typeof raw !== 'object') continue
      const rawContent = (raw as { content?: unknown }).content
      if (typeof rawContent !== 'string') continue
      // Sanitize before the emptiness test: `\x1b[31m\x1b[0m` is a non-blank
      // string but paints nothing, and a native row must never become a bare
      // status glyph or an invented placeholder.
      const content = flatten(sanitize(rawContent))
      if (content.trim() === '') continue
      const status = (raw as { status?: unknown }).status
      out.push({
        content,
        status: status === 'completed' ? 'completed' : status === 'in_progress' ? 'in_progress' : 'pending',
      })
    }
    return out
  }

  // -------------------------------------------------------------------------
  // Paint

  /**
   * `⏺ Todos · 2/5 · +1 more · Ctrl+T hide`
   *
   * Counts are native status counts. Every extra segment is appended only
   * while it still fits, so a narrow terminal keeps the honest base header.
   */
  private headerLine(width: number, total: number, completed: number, hidden: number): string {
    let line = t.accent(HEADER_MARK) + ' ' + bold(t.text('Todos'))
    const append = (styled: string): void => {
      const next = `${line}${dim(' · ')}${styled}`
      if (visibleWidth(next) <= width) line = next
    }
    append(dim(`${completed}/${total}`))
    if (hidden > 0) append(dim(`+${hidden} more`))
    const hint = this.toggleHint()
    if (hint !== undefined) append(dim(`${hint} hide`))
    return line
  }

  /**
   * `⏺ Todos · 1/3 · ◐ Extract the picker scope filter`
   *
   * The one-row fallback used only when the parent's hard budget is exactly one
   * line. Priority order is identity (`⏺ Todos`), then the true native
   * `completed/total` count, then the FIRST unfinished item in native order
   * (never a synthesized task, never a re-sorted list). Each segment is
   * appended only while it fits, so a narrow terminal degrades to
   * `⏺ Todos · 1/3` and finally to a clipped `⏺ Todos` instead of an elided
   * checklist. The toggle hint and the overflow summary stay out of this row:
   * at one line they would compete with the native counts and item itself.
   *
   * The item keeps its native status glyph (`◐` in-progress, `☐` pending), the
   * parent's Working frame for an in-progress item, and the same style rules as
   * the full tray. Nothing here derives business state: the item is simply the
   * first snapshot entry whose native status is not `completed`.
   */
  private compactLine(
    width: number,
    items: ReadonlyArray<{ readonly content: string; readonly status: TodoItem['status'] }>,
  ): string {
    const total = items.length
    let completed = 0
    for (const item of items) if (item.status === 'completed') completed += 1
    let line = t.accent(HEADER_MARK) + ' ' + bold(t.text('Todos'))
    const append = (styled: string): void => {
      const next = `${line}${dim(' · ')}${styled}`
      if (visibleWidth(next) <= width) line = next
    }
    append(dim(`${completed}/${total}`))
    const item = items.find(entry => entry.status !== 'completed')
    // Unreachable in practice (an all-completed list returns before painting),
    // kept explicit so the compact row can never invent an item row.
    if (item === undefined) return line
    const separator = dim(' · ')
    const room = width - visibleWidth(line) - visibleWidth(separator) - GLYPH_WIDTH
    if (room < MIN_COMPACT_ITEM_TEXT) return line
    const content = truncateToWidth(item.content, room, '…')
    if (content === '') return line
    const glyph = item.status === 'in_progress'
      ? t.accent(this.activeGlyph())
      : t.muted(STATUS_GLYPH.pending)
    const styled = item.status === 'in_progress' ? bold(t.text(content)) : t.text(content)
    return line + separator + glyph + ' ' + styled
  }

  /**
   * `  ⎿  ☑ Read the current resume flow`
   * `     ◐ Extract the picker scope filter`
   *
   * One display line per task; long content is ellipsized rather than wrapped
   * so the hard above-editor budget always holds. Completed rows recede and
   * the active row is the only emphasised one. Only a live in-progress row
   * reads the parent's spinner frame.
   */
  private taskLine(width: number, item: { content: string; status: TodoItem['status'] }, first: boolean): string {
    const lead = first ? ELBOW : INDENT
    const compact = width - visibleWidth(lead) - GLYPH_WIDTH < MIN_ELBOW_TEXT
    const prefix = compact ? '' : lead
    const room = Math.max(0, width - visibleWidth(prefix) - GLYPH_WIDTH)
    const content = truncateToWidth(item.content, room, '…')
    const glyph = item.status === 'in_progress'
      ? t.accent(this.activeGlyph())
      : item.status === 'completed' ? cc.success(STATUS_GLYPH.completed) : t.muted(STATUS_GLYPH.pending)
    const styled = item.status === 'completed'
      ? dim(t.muted(content))
      : item.status === 'in_progress' ? bold(t.text(content)) : t.text(content)
    return prefix + glyph + (content === '' ? '' : ' ' + styled)
  }

  /** One-cell live glyph or the static native marker. */
  private activeGlyph(): string {
    const frame = this.spinnerFrame
    if (frame === undefined) return STATUS_GLYPH.in_progress
    const cleaned = sanitize(frame)
    return cleaned !== '' && visibleWidth(cleaned) === 1 ? cleaned : STATUS_GLYPH.in_progress
  }

  // -------------------------------------------------------------------------
  // Budget / toggle hint

  private rowBudget(): number {
    const option = this.options.maxRows
    const raw = this.budgetAssigned ? this.budgetValue
      : typeof option === 'function' ? option()
        : typeof option === 'number' ? option
          : this.budgetValue
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_MAX_ROWS
    return Math.max(0, Math.floor(raw))
  }

  private toggleHint(): string | undefined {
    const option = this.options.hint
    const enabled = typeof option === 'function' ? option() === true : option === true
    if (!enabled) return undefined
    const action = this.keymap.getAction(TOGGLE_ACTION)
    if (action === undefined) return undefined
    const chain = this.keymap.getFallbackChain('editor')
    if (!action.contexts.some(context => chain.includes(context))) return undefined
    const binding = this.keymap.getBindings(TOGGLE_ACTION)[0]
    return binding === undefined ? undefined : formatBinding(binding.split(' '))
  }
}

/**
 * Flatten already-sanitized native display text onto ONE line.
 *
 * `sanitize()` intentionally keeps LF/CR (and expands TAB) for multi-line
 * bodies elsewhere. A native todo whose content carries a newline would add
 * real rows to this hard-budgeted dock, so whitespace is folded first; Pi
 * TUI's width helpers do the clipping afterwards.
 */
function flatten(text: string): string {
  return oneLine(text, Number.MAX_SAFE_INTEGER)
}