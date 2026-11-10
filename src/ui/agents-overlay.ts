/**
 * Native Agents overlay (temporary modal).
 *
 * One list of DSH's child catalog: direct children and the nested children the
 * native rows already identify through `parentSessionId`. This surface owns no
 * pane, starts no timer and never polls: `setEntries`/`setEntry` replace native
 * snapshots, and the parent owns every render/close decision.
 *
 * Shared chrome comes from `ModalFrame` (the same one every approval/settings
 * modal uses): the frame owns the border, title, close/action chips and their
 * mouse mapping, while this component owns only the list body. Selection is
 * the **native child id**, never a row index, so catalog reordering, a live
 * upsert or a search/filter remap can never retarget a different child.
 *
 * Search/filtering is presentation-only:
 * - `modal.search` focuses the single `InlineAnswer`/`CcEditor` field; printable
 *   characters (including `r`/`s`) edit the query, so reply/stop cannot fire
 *   while the user is typing a search. The field uses the shared CC editor
 *   grammar (word/whitespace deletion, kill/yank, undo), never a bespoke
 *   readline.
 * - `subagent.filter.toggle` (default Tab) switches `Active`/`All`.
 * - Both only look at metadata already in the native catalog; hovering/selecting
 *   never reads a child transcript, starts a follow or stops an Agent.
 *
 * Input is resolved through the shared `CcKeymap` in the `subagentList` context
 * (`subagentList → list → dialog → global`, no editor fallback), so list
 * movement, Enter and Esc come from the real keymap and a remapped/disabled
 * action never advertises a dead key. Any other resolved global action is
 * deliberately inert inside this modal; the parent action
 * `app.subagents.details` opened it, it cannot re-enter itself.
 *
 * Pi-style Ctrl+C: the default Ctrl+C locally resolves `list.cancel` in this
 * read-only context, so it closes the overlay without a native interrupt and
 * without reaching a hidden root clear. A disabled/remapped local cancel is
 * inert here (no global `app.clear` alias, no invented close fallback). Only an
 * explicit `app.interrupt` override keeps its old native meaning (stop the
 * selected child first, then the parent's interrupt).
 *
 * Intervention is requested, never performed: `subagent.reply` / the Reply
 * action chip call `onReply` and `subagent.interrupt` / the Stop chip call
 * `onStop` only when that callback exists *and* the selected native row is
 * applicable (`subagentCanReply` / `subagentCanStop`). The parent owns the
 * backend command, the Agent and the scheduler; this component never creates an
 * editor for prompts, never sends a prompt and never invents a status.
 *
 * External tasks are real catalog rows but have no local child Session, so they
 * are selectable and never open a transcript. Width-safe rows drop mode,
 * activity, tokens and timing in that priority order before the label/status.
 */
import {
  ScrollView,
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '#pi-tui'
import type { SubagentEntry, SubagentSnapshot } from '../backend/types.ts'
import { createCcKeymap, formatBinding, type CcKeymap } from '../input/index.ts'
import {
  buildSubagentTree,
  flattenSubagentTree,
  SubagentProjection,
  type SubagentTreeNode,
} from '../state/subagents.ts'
import { InlineAnswer } from './inline-editor.ts'
import { modalBinding, modalHeight, ModalFrame, type ModalAction, type ModalFrameOptions, type ModalSize } from './modal.ts'
import { HitboxRegistry, type MouseHitbox } from './mouse.ts'
import {
  subagentActivity,
  subagentCanReply,
  subagentCanStop,
  subagentLabel,
  subagentModeLabel,
  subagentOpenable,
  subagentStatusLabel,
  subagentTimingLabel,
  subagentTokensLabel,
  subagentTone,
  type SubagentTone,
} from './subagent-format.ts'
import { fit, sanitize, truncateToWidth, visibleWidth } from './text.ts'
import { bold, cc, dim, t } from './theme.ts'

/** Active/All catalog filter. Presentation only; never mutates the catalog. */
export type AgentsFilter = 'active' | 'all'

/**
 * Parent-owned restore record for `captureView()` / `initialState`.
 *
 * It contains only ephemeral list state: the native selected id plus this
 * surface's query/filter/scroll. No DSH session fact, child transcript or
 * native control is copied.
 */
export interface AgentsViewState {
  readonly query: string
  readonly filter: AgentsFilter
  /** Native child id (never a row index). */
  readonly selectedId?: string
  readonly scrollTop: number
}

export interface AgentsOverlayOptions {
  /** Initial native catalog entries (direct and nested). */
  entries: readonly SubagentEntry[]
  /** True only when the native read is known to be incomplete. */
  truncated?: boolean
  /** Restore list position/search/filter when the parent reopens this modal. */
  initialState?: AgentsViewState
  /** Shared keymap; defaults to the CC defaults for tests/standalone hosts. */
  keymap?: CcKeymap
  /** Esc / configured cancel. Parent hides and disposes this instance. */
  onClose: () => void
  /**
   * Open one local child's read-only session view. External rows never call
   * this, because DSH has no local child Session for them.
   */
  onOpen?: (entry: SubagentEntry) => void
  /**
   * Request a native follow-up prompt for the selected child. Called only when
   * this callback exists and the row is a local continuable child; the parent
   * owns the prompt/backend call and any Editor it opens.
   */
  onReply?: (entry: SubagentEntry) => void
  /**
   * Request a native interrupt for the selected child. Called only when this
   * callback exists and the row is local and `running`/`initializing`.
   */
  onStop?: (entry: SubagentEntry) => void
  /** Global interrupt override (`app.interrupt`); defaults to closing the overlay. */
  onInterrupt?: () => void
  /**
   * Reserved for truly global app actions. Only `app.exit` is forwarded here,
   * matching `ChildSessionView`; parent tools/model/permission/settings/
   * subagent actions stay inert inside this read-only modal.
   */
  onGlobalAction?: (actionId: string) => void
  /** Repaint hook; the component itself never writes stdout. */
  onRenderRequest?: () => void
  /** Overlay height cap; defaults to the terminal rows minus two. */
  maxHeight?: number
  /** Clock for the native session-total duration; injectable for tests. */
  now?: () => number
}

const CLOSE_ACTIONS: ReadonlySet<string> = new Set(['list.cancel', 'dialog.cancel', 'app.cancel'])

/** Native statuses this widget treats as current work (never a local guess). */
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['running', 'initializing'])

const TONE_STYLE: Readonly<Record<SubagentTone, (text: string) => string>> = {
  running: t.accent,
  done: t.green,
  idle: t.muted,
  failed: t.redSoft,
  stopped: t.yellow,
  external: t.subtle,
  unknown: t.subtle,
}

function toneGlyph(tone: SubagentTone): string {
  switch (tone) {
    case 'running': return t.accent('⏺')
    case 'done': return t.green('●')
    case 'failed': return t.redSoft('●')
    case 'stopped': return t.yellow('◌')
    case 'idle': return t.muted('○')
    case 'external': return t.subtle('◌')
    case 'unknown': return t.subtle('◌')
  }
}

/** Empty host child: ScrollView owns the public scroll state; rows are sliced here. */
class EmptyBody implements Component {
  render(): string[] {
    return []
  }

  invalidate(): void {}
}

export class AgentsOverlay implements Component, Focusable {
  readonly capturesViewportInput = true
  /** Parent generic dialog hosting uses the standard-width modal token. */
  readonly modalSize: ModalSize = 'standard'
  readonly keymap: CcKeymap
  private readonly tui: TUI
  private readonly options: AgentsOverlayOptions
  private readonly frame = new ModalFrame()
  private readonly registry = new HitboxRegistry()
  private readonly projectionValue = new SubagentProjection()
  private readonly scrollView: ScrollView
  private readonly search: InlineAnswer
  private selectedId: string | undefined
  private filterValue: AgentsFilter
  private focusedState = false
  private searchOpenValue = false
  private messageValue: { readonly text: string; readonly error: boolean } | undefined
  private pendingScrollTop = 0
  /** Last selection painted; wheel scrolling must not re-snap every frame. */
  private lastSelectedIndex: number | undefined
  private done = false
  private disposed = false
  private chordPending = false
  /** Last measured body height, used by page navigation. */
  private viewportRows = 1
  private readonly now: () => number

  constructor(tui: TUI, options: AgentsOverlayOptions) {
    this.tui = tui
    this.options = options
    this.keymap = options.keymap ?? createCcKeymap()
    this.now = options.now ?? Date.now
    this.scrollView = new ScrollView(new EmptyBody(), { scrollbar: 'hidden' })
    this.search = new InlineAnswer(tui, this.keymap)
    // One shared CC field grammar, resolved in the modal text-field context
    // (editor/dialog/global fallback), never the read-only list context.
    this.search.editor.setContext('modalSearch')
    this.search.onChange = () => {
      this.lastSelectedIndex = undefined
      this.reconcileSelection()
      this.requestRender()
    }
    this.projectionValue.applySnapshot({
      entries: options.entries,
      ...(options.truncated === true ? { truncated: true } : {}),
    })
    this.filterValue = options.initialState?.filter ?? 'all'
    this.searchOpenValue = (options.initialState?.query ?? '') !== ''
    if (this.searchOpenValue) this.search.editor.setText(options.initialState?.query ?? '')
    this.pendingScrollTop = Math.max(0, options.initialState?.scrollTop ?? 0)
    this.selectedId = options.initialState?.selectedId
    this.reconcileSelection(options.initialState?.selectedId)
  }

  // -------------------------------------------------------------------------
  // Public surface (parent owns the overlay lifecycle)

  get entries(): readonly SubagentEntry[] {
    return this.projectionValue.entries
  }

  get truncated(): boolean {
    return this.projectionValue.truncated
  }

  get selectedEntry(): SubagentEntry | undefined {
    return this.projectionValue.get(this.selectedId) ?? this.visibleRows()[0]?.entry
  }

  /** Current Active/All filter (display only). */
  get filter(): AgentsFilter {
    return this.filterValue
  }

  /** Current search query; it filters native metadata, never child content. */
  get query(): string {
    return this.search.raw
  }

  get isDone(): boolean {
    return this.done
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  get focused(): boolean {
    return this.focusedState
  }

  set focused(value: boolean) {
    if (value === this.focusedState) return
    if (!value) this.cancelChord()
    this.focusedState = value
    this.search.focused = value && this.searchOpenValue
  }

  /** Release only this instance's pending chord. */
  cancelChord(): void {
    if (!this.chordPending) return
    this.chordPending = false
    this.keymap.cancelChord()
  }

  /**
   * Restore record for child-back navigation. The parent stores it and passes
   * it as `initialState` when it reopens the list; a removed native id is
   * reconciled to the nearest available row, never revived.
   */
  captureView(): AgentsViewState {
    const selectedId = this.selectedId
    return {
      query: this.search.raw,
      filter: this.filterValue,
      ...(selectedId === undefined ? {} : { selectedId }),
      scrollTop: this.scrollView.scrollTop,
    }
  }

  /**
   * Replace the whole native catalog entry list. An omitted `truncated` keeps
   * the current completeness flag instead of silently clearing a real native
   * truncation; pass `{ truncated: false }` when a fresh complete read owns it.
   */
  setEntries(entries: readonly SubagentEntry[], options: { truncated?: boolean } = {}): void {
    if (this.disposed) return
    const truncated = options.truncated ?? this.truncated
    const changed = this.projectionValue.applySnapshot({
      entries,
      ...(truncated ? { truncated: true } : {}),
    })
    this.afterCatalogChange(changed)
  }

  /** Apply a full native snapshot object. */
  setSnapshot(snapshot: SubagentSnapshot): void {
    if (this.disposed) return
    const changed = this.projectionValue.applySnapshot(snapshot)
    this.afterCatalogChange(changed)
  }

  /** Apply one live upsert (keeps a known cold catalog anchor). */
  setEntry(entry: SubagentEntry): void {
    if (this.disposed) return
    const changed = this.projectionValue.applyEntry(entry)
    this.afterCatalogChange(changed)
  }

  /**
   * Parent-facing generic update: one entry, a full entry list, or a native
   * snapshot. With no catalog argument it only asks for a repaint (the parent
   * may have new native timing for the same rows).
   */
  update(change: {
    entry?: SubagentEntry
    entries?: readonly SubagentEntry[]
    truncated?: boolean
    snapshot?: SubagentSnapshot
  } = {}): void {
    if (this.disposed) return
    if (change.snapshot !== undefined) {
      this.setSnapshot(change.snapshot)
      return
    }
    if (change.entry !== undefined) {
      this.setEntry(change.entry)
      return
    }
    if (change.entries !== undefined) {
      this.setEntries(change.entries, change.truncated === undefined ? {} : { truncated: change.truncated })
      return
    }
    this.requestRender()
  }

  /**
   * Visible status for a parent-owned native action (reply/stop failure,
   * follow refusal, ...). It is painted in this surface's own status row and
   * cleared/replaced only by the parent; it is never behind the transcript.
   */
  setMessage(message?: string, error = false): void {
    if (this.disposed) return
    const text = message === undefined ? '' : sanitize(message).trim()
    if (text === '') this.messageValue = undefined
    else this.messageValue = { text, error }
    this.requestRender()
  }

  /** Focus the shared CC search field (the `modal.search` action). */
  openSearch(): void {
    if (this.disposed || this.done) return
    this.searchOpenValue = true
    this.search.focused = this.focusedState
    this.requestRender()
  }

  /** Leave the search field; the query and the filtered list stay. */
  closeSearch(): void {
    if (this.disposed || !this.searchOpenValue) return
    this.searchOpenValue = false
    this.search.focused = false
    this.requestRender()
  }

  /** Toggle the focused search field, preserving its query. */
  toggleSearch(): void {
    if (this.searchOpenValue) this.closeSearch()
    else this.openSearch()
  }

  /** Switch `Active`/`All` without touching the native catalog. */
  toggleFilter(): void {
    if (this.disposed || this.done) return
    this.filterValue = this.filterValue === 'active' ? 'all' : 'active'
    this.lastSelectedIndex = undefined
    this.reconcileSelection()
    this.requestRender()
  }

  /** Idempotent teardown; never calls `onClose` and never moves focus. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelChord()
    this.registry.clear()
    this.frame.invalidate()
    this.search.dispose()
  }

  invalidate(): void {
    if (this.disposed) return
    this.frame.invalidate()
    this.search.invalidate()
    this.requestRender()
  }

  private afterCatalogChange(changed: boolean): void {
    this.reconcileSelection()
    if (changed) this.requestRender()
  }

  /**
   * Keep the selection on the same native id while it is still visible; when
   * it disappeared (removed child, filter/search change), move to the nearest
   * visible row in native order. A removed child is never resurrected.
   */
  private reconcileSelection(preferred?: string): void {
    if (preferred !== undefined) this.selectedId = preferred
    const rows = this.visibleRows()
    if (rows.length === 0) {
      this.selectedId = undefined
      return
    }
    if (this.selectedId !== undefined && rows.some(node => node.entry.id === this.selectedId)) return
    const all = this.flatRows()
    const previous = this.selectedId === undefined ? -1 : all.findIndex(node => node.entry.id === this.selectedId)
    if (previous < 0) {
      this.selectedId = rows[0]?.entry.id
      return
    }
    let best: SubagentTreeNode | undefined
    let bestDistance = Number.POSITIVE_INFINITY
    for (const node of rows) {
      const index = all.findIndex(candidate => candidate.entry.id === node.entry.id)
      if (index < 0) continue
      const distance = Math.abs(index - previous)
      if (distance < bestDistance) {
        best = node
        bestDistance = distance
      }
    }
    this.selectedId = (best ?? rows[0])?.entry.id
  }

  private requestRender(): void {
    if (this.disposed) return
    this.options.onRenderRequest?.()
    this.tui.requestRender()
  }

  // -------------------------------------------------------------------------
  // Input

  handleInput(raw: string): void {
    if (this.done || this.disposed) return
    // The search field owns printable text while it is focused: `r`/`s` are
    // query characters here, never reply/stop actions.
    if (this.searchOpenValue && this.focusedState) {
      this.handleSearchKey(raw)
      return
    }
    const resolution = this.keymap.resolve(raw, 'subagentList')
    if (resolution.kind === 'pending') {
      this.chordPending = true
      return
    }
    if (resolution.kind !== 'action') {
      // A mismatched chord/unknown key is consumed by the modal.
      this.chordPending = false
      return
    }
    this.chordPending = false
    this.dispatch(resolution.action.id)
  }

  /**
   * One keystroke inside the shared search field.
   *
   * Enter opens the selected child (the list owns navigation, the editor only
   * types), Esc leaves the field without closing the modal, Tab switches the
   * Active/All filter (the field has no completion provider), and the edge
   * Up/Down move the list. Ctrl+C keeps the modal interrupt priority.
   */
  private handleSearchKey(raw: string): void {
    const result = this.search.handleKey(raw)
    switch (result) {
      case 'submit':
        this.openSelected()
        return
      case 'cancel':
        this.closeSearch()
        return
      case 'interrupt':
        this.dispatch('app.interrupt')
        return
      case 'tab':
        this.toggleFilter()
        return
      case 'up':
        this.move(-1)
        return
      case 'down':
        this.move(1)
        return
      default:
        return
    }
  }

  private dispatch(id: string): void {
    if (CLOSE_ACTIONS.has(id)) {
      this.close()
      return
    }
    switch (id) {
      case 'modal.search':
        this.toggleSearch()
        return
      case 'subagent.filter.toggle':
        this.toggleFilter()
        return
      case 'app.interrupt':
        // An explicit native interrupt override stops a stoppable child instead
        // of dropping the whole surface. With the Pi-style default Ctrl+C this
        // action is unbound, so Ctrl+C stays a local list/dialog cancel.
        if (this.stopSelected()) return
        if (this.options.onInterrupt !== undefined) this.options.onInterrupt()
        else this.close()
        return
      case 'subagent.reply':
        // Explicit reply action: applicable rows only, otherwise inert (a
        // one-shot/external row must never advertise a prompt it cannot send).
        this.replySelected()
        return
      case 'subagent.interrupt':
        this.stopSelected()
        return
      case 'list.previous':
        this.move(-1)
        return
      case 'list.next':
        this.move(1)
        return
      case 'list.page-up':
        this.move(-Math.max(1, this.viewportRows - 1))
        return
      case 'list.page-down':
        this.move(Math.max(1, this.viewportRows - 1))
        return
      case 'list.first':
        this.selectIndex(0)
        return
      case 'list.last':
        this.selectIndex(this.visibleRows().length - 1)
        return
      case 'list.select':
        this.openSelected()
        return
      case 'app.exit':
        // Global quit is not ours to swallow: the parent's normal exit path
        // decides, including its empty-draft/armed-exit semantics.
        this.options.onGlobalAction?.(id)
        return
      default:
        // `app.subagents.details`, model, permission, tools and settings actions
        // are parent surfaces: they stay inert inside this read-only modal.
        return
    }
  }

  private move(delta: number): void {
    const rows = this.visibleRows()
    if (rows.length === 0) return
    const current = this.selectedIndex()
    this.selectIndex(current < 0 ? 0 : current + delta)
  }

  private selectIndex(index: number): void {
    const rows = this.visibleRows()
    if (rows.length === 0) {
      this.selectedId = undefined
      return
    }
    const clamped = Math.max(0, Math.min(rows.length - 1, index))
    const next = rows[clamped]?.entry.id
    if (next === this.selectedId) return
    this.selectedId = next
    this.requestRender()
  }

  private selectedIndex(): number {
    return this.visibleRows().findIndex(row => row.entry.id === this.selectedId)
  }

  private openSelected(): void {
    const entry = this.selectedEntry
    if (entry === undefined || !subagentOpenable(entry)) return
    this.options.onOpen?.(entry)
  }

  /**
   * Reply target: the selected row when it is a local continuable child **and**
   * the parent supplied `onReply`. Without both, reply is inert.
   */
  private replyTarget(): SubagentEntry | undefined {
    if (this.options.onReply === undefined) return undefined
    const entry = this.selectedEntry
    return entry === undefined || !subagentCanReply(entry) ? undefined : entry
  }

  /** Stop target: the selected row when it is local and running/initializing. */
  private stopTarget(): SubagentEntry | undefined {
    if (this.options.onStop === undefined) return undefined
    const entry = this.selectedEntry
    return entry === undefined || !subagentCanStop(entry) ? undefined : entry
  }

  /**
   * Run one native intervention request. Returns whether a request was issued;
   * the component itself never mutates an entry or schedules work, so the
   * parent's own update is the only thing that repaints.
   */
  private replySelected(): boolean {
    const entry = this.replyTarget()
    const callback = this.options.onReply
    if (entry === undefined || callback === undefined) return false
    callback(entry)
    return true
  }

  private stopSelected(): boolean {
    const entry = this.stopTarget()
    const callback = this.options.onStop
    if (entry === undefined || callback === undefined) return false
    callback(entry)
    return true
  }

  private close(): void {
    if (this.done || this.disposed) return
    this.done = true
    this.cancelChord()
    this.search.focused = false
    this.options.onClose()
  }

  // -------------------------------------------------------------------------
  // Projection

  /** Full native catalog as a parentSessionId tree (native order preserved). */
  private flatRows(): readonly SubagentTreeNode[] {
    return flattenSubagentTree(buildSubagentTree(this.projectionValue.entries))
  }

  /** Metadata-only search: native label/id/mode/status/route/activity. */
  private matchesQuery(entry: SubagentEntry, query: string): boolean {
    if (query === '') return true
    const haystack = [
      entry.id,
      entry.label ?? '',
      entry.mode,
      entry.status,
      entry.lastActivity ?? '',
      entry.provider ?? '',
      entry.model ?? '',
      entry.reasoningEffort ?? '',
    ].join('\n').toLowerCase()
    return haystack.includes(query)
  }

  /** Rows visible under the current Active/All filter and query. */
  private visibleRows(): readonly SubagentTreeNode[] {
    const query = this.search.raw.trim().toLowerCase()
    return this.flatRows().filter(node => {
      if (this.filterValue === 'active' && !ACTIVE_STATUSES.has(node.entry.status)) return false
      return this.matchesQuery(node.entry, query)
    })
  }

  private activeCount(): number {
    return this.projectionValue.entries.filter(entry => ACTIVE_STATUSES.has(entry.status)).length
  }

  /**
   * Height budget from the shared size token (`modalHeight`) plus any parent
   * cap. Chrome rows are measured by `ModalFrame`, never by a local constant.
   */
  private limitRows(): number {
    const token = modalHeight(this.tui, this.modalSize)
    const configured = this.options.maxHeight
    if (configured === undefined || !Number.isFinite(configured) || configured <= 0) return token
    return Math.max(1, Math.min(token, Math.floor(configured)))
  }

  // -------------------------------------------------------------------------
  // Rendering

  render(width: number): string[] {
    if (this.disposed) return []
    const size = Math.max(1, Math.floor(width))
    const limit = this.limitRows()
    const rows = this.visibleRows()
    const selectedIndex = this.selectedIndex()

    // The frame is measured before any body line is produced, so the body is
    // sliced to the real available height and the chrome can never be pushed
    // off a tiny terminal.
    const innerWidth = this.innerWidth(size, limit)
    const probe = this.frame.measure(size, this.frameOptions(limit, rows, selectedIndex, innerWidth))
    const bodyHeight = Math.max(0, probe.bodyHeight)
    const bodyWidth = Math.max(1, probe.bodyWidth)
    this.viewportRows = Math.max(1, bodyHeight)

    const total = Math.max(1, rows.length)
    this.scrollView.updateLayout(total, Math.max(1, bodyHeight), () => this.requestRender())
    const maxScroll = Math.max(0, total - Math.max(1, bodyHeight))
    const restoring = this.pendingScrollTop > 0
    let top = Math.max(0, Math.min(this.scrollView.scrollTop, maxScroll))
    if (restoring) {
      top = Math.max(0, Math.min(this.pendingScrollTop, maxScroll))
      this.pendingScrollTop = 0
    }
    // Keep the wheel's viewport unless the selected row actually changed (or
    // the pane is being restored). Re-snapping every frame made wheel input a
    // no-op: the next render immediately undid the scroll.
    if (!restoring && selectedIndex >= 0 && bodyHeight > 0 && selectedIndex !== this.lastSelectedIndex) {
      if (selectedIndex < top) top = selectedIndex
      else if (selectedIndex >= top + bodyHeight) top = selectedIndex - bodyHeight + 1
    }
    this.lastSelectedIndex = selectedIndex
    top = Math.max(0, Math.min(top, maxScroll))
    this.scrollView.scrollTo(top)

    const body: string[] = []
    const boxes: MouseHitbox[] = []
    if (rows.length === 0) {
      body.push(fit(this.emptyLine(), bodyWidth))
      for (let index = 1; index < bodyHeight; index += 1) body.push('')
    } else {
      for (let offset = 0; offset < bodyHeight; offset += 1) {
        const index = top + offset
        const node = rows[index]
        if (node === undefined) {
          body.push('')
          continue
        }
        body.push(fit(this.renderRow(node, bodyWidth, index === selectedIndex), bodyWidth))
        boxes.push({
          id: `agent-row:${node.entry.id}`,
          startRow: offset,
          endRow: offset,
          startCol: 0,
          endCol: Math.max(0, bodyWidth - 1),
          claimPress: true,
          onClick: () => {
            if (this.disposed || this.done) return
            if (node.entry.id !== this.selectedId) {
              this.selectedId = node.entry.id
              this.requestRender()
            }
            this.openSelected()
          },
        })
      }
    }

    const options = this.frameOptions(limit, rows, selectedIndex, innerWidth)
    const lines = this.frame.render(size, body, options)
    this.registry.sync(boxes)
    return lines.map(line => fit(line, size))
  }

  private emptyLine(): string {
    if (this.projectionValue.entries.length === 0) return dim(t.muted('No native subagents in this session.'))
    if (this.filterValue === 'active') return dim(t.muted('No active native subagents. Press the filter key to show all.'))
    return dim(t.muted('No native subagents match this search.'))
  }

  private frameOptions(
    limit: number,
    rows: readonly SubagentTreeNode[],
    selectedIndex: number,
    innerWidth: number,
  ): ModalFrameOptions {
    void rows
    void selectedIndex
    return {
      title: 'Agents',
      // Stable native row identity (never a status/label): a press on a
      // mutating footer action is invalidated when the selected child changes.
      ownerKey: `agents:${this.selectedEntry?.id ?? 'none'}`,
      subtitle: this.subtitle(),
      before: [this.searchLine(innerWidth), this.filterLine(innerWidth)],
      after: this.statusLines(innerWidth),
      actions: this.modalActions(limit),
      onClose: () => this.close(),
      maxHeight: limit,
      keymap: this.keymap,
    }
  }

  private subtitle(): string {
    const entries = this.projectionValue.entries
    const active = this.activeCount()
    const parts = [`${active} active`, `${entries.length} known`]
    if (this.truncated) parts.push('incomplete catalog')
    return parts.join(' · ')
  }

  /** Exact inner width the frame allocates for `before`/`after` lines. */
  private innerWidth(size: number, limit: number): number {
    return size >= 8 && limit >= 6 ? Math.max(1, size - 4) : size
  }

  /** Search row: one shared CC editor state while open, a summary while closed. */
  private searchLine(width: number): string {
    const placeholder = 'Search agents…'
    if (this.searchOpenValue) {
      const [line] = this.search.render(Math.max(4, width), this.focusedState, placeholder)
      return fit(line ?? cc.inactive(placeholder), width)
    }
    const query = this.search.raw.trim()
    const hint = modalBinding(this.keymap, 'modal.search', true)
    const shown = query === '' ? cc.inactive(placeholder) : dim('⌕ ' + sanitize(query))
    return fit(hint === undefined ? shown : `${shown}${dim('  ' + hint)}`, width)
  }

  private filterLine(width: number): string {
    const active = this.filterValue === 'active'
    const all = this.filterValue === 'all'
    const activeText = active ? t.accentBright(bold('Active')) : dim('Active')
    const allText = all ? t.accentBright(bold('All')) : dim('All')
    const hint = modalBinding(this.keymap, 'subagent.filter.toggle', true)
    const suffix = hint === undefined ? '' : dim('  ' + hint + ' toggle')
    return fit(`${activeText}${dim(' / ')}${allText}${suffix}`, width)
  }

  /** Status rows: selected native metadata plus an explicit parent message. */
  private statusLines(width: number): readonly string[] {
    const selected = this.selectedLine(width)
    if (this.messageValue === undefined) return [selected]
    const style = this.messageValue.error ? t.redSoft : t.muted
    return [selected, fit(style(this.messageValue.text), width)]
  }

  private selectedLine(width: number): string {
    const entry = this.selectedEntry
    if (entry === undefined) return dim(t.muted('No native subagents.'))
    const parts = [bold(t.text(subagentLabel(entry))), dim('id ' + sanitize(entry.id))]
    const route = entry.provider === undefined && entry.model === undefined
      ? ''
      : sanitize([entry.provider, entry.model].filter(value => value !== undefined).join('/'))
    if (route !== '') parts.push(dim(route))
    if (entry.mode === 'external' || entry.status === 'external') {
      parts.push(dim('external task · no local transcript'))
    }
    return fit(parts.join(dim(' · ')), width)
  }

  /**
   * Frame action chips. Only real, applicable native capabilities are painted;
   * labels come from the effective keymap inside the frame, so a remapped or
   * disabled action never advertises a dead key.
   */
  private modalActions(limit: number): readonly ModalAction[] {
    const actions: ModalAction[] = []
    const selected = this.selectedEntry
    if (selected !== undefined && subagentOpenable(selected)) {
      actions.push({ id: `open:${selected.id}`, label: 'open', action: 'list.select', onActivate: () => { if (this.selectedEntry?.id === selected.id) this.openSelected() } })
    }
    // A real native capability stays clickable even when its *key* binding is
    // disabled: the frame paints the label without a fictitious shortcut.
    const reply = this.replyTarget()
    if (reply !== undefined) {
      actions.push({ id: `reply:${reply.id}`, label: 'reply', action: 'subagent.reply', onActivate: () => { if (this.selectedEntry?.id === reply.id) this.replySelected() } })
    }
    const stop = this.stopTarget()
    if (stop !== undefined) {
      actions.push({ id: `stop:${stop.id}`, label: 'stop', action: 'subagent.interrupt', onActivate: () => { if (this.selectedEntry?.id === stop.id) this.stopSelected() } })
    }
    const close = modalBinding(this.keymap, 'list.cancel', true) ?? modalBinding(this.keymap, 'app.cancel', true)
    const closeAction: ModalAction = {
      id: 'close',
      label: 'close',
      ...(close === undefined ? {} : { action: 'list.cancel' }),
      onActivate: () => this.close(),
    }
    // A tiny terminal paints one footer row; keep the real return affordance
    // first and let the core intervention follow, instead of a clipped footer
    // that hides how to leave the modal.
    if (limit < 6) return [closeAction, ...actions.slice(0, 1)]
    actions.push(closeAction)
    return actions
  }

  private renderRow(node: SubagentTreeNode, width: number, selected: boolean): string {
    const entry = node.entry
    const tone = subagentTone(entry)
    const glyph = toneGlyph(tone)
    const status = subagentStatusLabel(entry)
    const mode = subagentModeLabel(entry.mode)
    const indent = '  '.repeat(Math.min(node.depth, 8))
    const pointer = selected ? t.accentBright('❯ ') : '  '
    const separator = dim(' · ')
    const sepWidth = visibleWidth(separator)
    const headWidth = visibleWidth(indent) + visibleWidth(pointer) + visibleWidth(glyph) + 1
    // Reserve the status so a long label never pushes the honest state off-row.
    const statusText = TONE_STYLE[tone](status)
    const reserved = headWidth + sepWidth + visibleWidth(status)
    const label = truncateToWidth(subagentLabel(entry), Math.max(1, width - reserved))
    let line = indent + pointer + glyph + ' ' + (selected ? bold(t.accentBright(label)) : t.text(label))
    // Mode is explicit for every non-external row; external is already a leaf
    // state and repeating "external · external" would be noise.
    if (!node.external) line = this.appendIfFits(line, dim(mode), width)
    line += separator + statusText
    const activity = subagentActivity(entry)
    if (activity !== undefined) line = this.appendIfFits(line, t.muted(activity), width)
    const tokens = subagentTokensLabel(entry.totalTokens)
    if (tokens !== undefined) line = this.appendIfFits(line, dim(tokens), width)
    const timing = subagentTimingLabel(entry.timing, this.now())
    if (timing !== undefined) line = this.appendIfFits(line, dim(timing), width)
    return fit(line, width)
  }

  private appendIfFits(line: string, segment: string, width: number): string {
    const next = `${line}${dim(' · ')}${segment}`
    return visibleWidth(next) <= width ? next : line
  }

  // -------------------------------------------------------------------------
  // Mouse: frame owns chrome/action chips; the body owns row selection only.

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    if (event.type === 'wheel') {
      const delta = event.wheelDelta ?? 0
      if (delta === 0) return undefined
      this.scrollView.scrollBy(delta)
      this.requestRender()
      return { handled: true, render: true }
    }
    const chrome = this.frame.handleMouse(event)
    if (chrome !== undefined) return chrome
    const body = this.frame.bodyMouse(event)
    if (body === undefined) return undefined
    return this.registry.handleMouse(body)
  }
}
