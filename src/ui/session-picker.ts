/**
 * Resume-session picker.
 *
 * The caller hands over DSH's native `sessions` DTO projection in the backend's
 * own display order (newest first). This component never re-sorts the rows,
 * never stats/opens a durable session artifact and never selects a session on
 * its own: incoming order IS display order, and only an active query re-orders
 * the matched subset by fuzzy relevance.
 *
 * Ordering policy (DSH owns durable session truth): the TUI must not derive a
 * recency policy of its own. A `stat` of a session's JSONL mtime, a locally
 * sorted copy of the listing, or a newest-session auto-selection would be a
 * second, competing durability policy that can disagree with DSH's own view —
 * and a picker cannot know what DSH considers a session's activity. So the
 * listing order is consumed verbatim (`refresh` only filters) and the only
 * allowed re-order is relevance inside an active query; clearing the query
 * restores the native order exactly. Recovery stays explicit: `--resume <id>`,
 * `/resume <id>` or one user selection here — never an automatic newest pick.
 *
 * Everything below is presentation: the current-folder/all scope filter, the
 * relative age column, the fuzzy query over title+cwd and the selection index.
 * The age stamp is display-only (see `SessionPickerItem.createdAt`): a row
 * without one renders `unknown time` in place and never moves. Titles come from
 * the native DTO or the parent's lazy title stream — never from reading a
 * session file. Session ids are opaque stream ids and are passed back verbatim
 * on select, so session identity and switching stay DSH facts.
 *
 * Two-phase data flow: DSH lists session headers and generates titles
 * separately, so the dialog opens immediately (`loading`, no sessions), accepts
 * the headers later through `setSessions`, and merges streamed titles through
 * `setTitles`. The component never fetches, never times out and never renders
 * on its own: every mutator only updates state, and `onVisibleIds` tells the
 * parent which rows to fetch titles for. All of that is state plus a callback —
 * no timers, no render requests, no backend calls.
 *
 * Surface: the shared `ModalFrame` (`standard` size). Chrome (scope segment,
 * query field), the row body and the status line are laid out by the measured
 * frame; only the body rows are mouse-selectable. The footer prints the real
 * keymap bindings for scope, select and cancel, so a remap/disable never shows a
 * fake key. `session.scope.toggle` is the registry action (Ctrl+A by default) —
 * there is no hardcoded Tab fallback.
 *
 * The query field is the central CC input (`InlineAnswer`/`CcEditor`) in the
 * input owner's `modalSearch` context: typing, word/whitespace deletion,
 * kill/yank and undo work through the one Pi editor state, and Enter/Esc arrive
 * as the dialog actions the UI maps to select/cancel. List navigation is
 * resolved first in `modalList`, so arrows/Ctrl+P/N/j/k move rows; a printed
 * single-key list binding is query text here, never navigation, because a
 * search field must not refuse a letter. Numbered quick-select stays available
 * while the query is empty (CC list behaviour) and becomes query text once
 * typing starts.
 *
 * Layout (top to bottom): frame title, scope segment line, the search field,
 * one row per session (or the phase-1 `Loading sessions…` row / the scope-aware
 * empty hint / the honest no-match row), a status line, and the action footer.
 * Every line is width-safe for any width >= 4; no stdout is ever written.
 */
import { resolve } from 'node:path'
import {
  fuzzyFilter,
  matchesKey,
  type KeyId,
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '#pi-tui'
import { BRACKETED_PASTE_START, createCcKeymap, type CcKeymap, printableInput } from '../input/index.ts'
import { bodyHitAt, modalAction, renderModalBody, textPaint, type BodyPaint, type HitRange, type ResolvedModalAction } from './dialogs.ts'
import { InlineAnswer } from './inline-editor.ts'
import { ModalFrame, modalHeight, type ModalFrameOptions, type ModalSize } from './modal.ts'
import { bold, cc, dim, t } from './theme.ts'
import { fit, oneLine, sanitize, tildePath, truncateToWidth, visibleWidth, wrap } from './text.ts'

export interface SessionPickerItem {
  /** DSH session id (the opaque wire id, passed back verbatim on select). */
  id: string
  /** Native LLM-generated title, when the session has one. */
  title?: string
  /** Recorded working directory of the session (may differ per session). */
  cwd: string
  /**
   * Display-only native header creation stamp in epoch milliseconds; absent
   * is `unknown time`.
   * It paints the age column and nothing else: it is never an ordering input,
   * and the picker never stats a session artifact to obtain or refine it.
   */
  createdAt?: number
  /** Another process currently holds the session open. */
  live?: boolean
}

export interface SessionPickerOptions {
  /**
   * Raw native DTO projection in the backend's display order (newest first).
   * The picker copies this order verbatim — it never re-sorts, never reads a
   * session artifact and never applies an auto-selection policy. Omitted or
   * empty is the phase-1 state: the dialog renders immediately and the headers
   * arrive later through `setSessions`.
   */
  sessions?: readonly SessionPickerItem[]
  /** Initial phase-1 state: no listing yet (the dialog still renders immediately). */
  loading?: boolean
  /** This launch's working directory; the initial scope filter baseline. */
  directory: string
  /** Shared CC keymap from the input subsystem; a default is created when omitted. */
  keymap?: CcKeymap
  onSelect: (id: string) => void
  onCancel: () => void
  /** Global interrupt (Ctrl+C by default); defaults to cancel like SelectDialog. */
  onInterrupt?: () => void
  /**
   * The ids of the rows currently visible in the row window, after the
   * scope/query/window settles. Fired once when sessions first land, again on
   * every scope toggle, query change, setSessions or window shift that
   * actually changes the visible id set. The parent fetches titles lazily
   * from this signal.
   */
  onVisibleIds?: (ids: string[]) => void
}

/** Scope of the directory filter (Pi's Current Folder ↔ All toggle). */
type Scope = 'directory' | 'all'

const isCancelAction = (id: string): boolean =>
  id === 'list.cancel' || id === 'dialog.cancel' || id === 'app.cancel'
const isSelectAction = (id: string): boolean => id === 'list.select' || id === 'dialog.confirm'
const SCOPE_TOGGLE = 'session.scope.toggle'
/** Modal-list actions that stay available while the search field owns text. */
const SCROLL_ACTIONS = ['list.page-up', 'list.page-down'] as const

/** Rows assumed before the first render measured the real frame body. */
const DEFAULT_VIEWPORT_ROWS = 10

/**
 * A list binding that is a single printable character (`j`/`k`, the digits).
 * Those are text while a search field is on screen; only real control/navigation
 * keys keep their list meaning.
 */
function isPrintedChar(keys: readonly string[]): boolean {
  const key = keys[0]
  if (key === undefined || keys.length !== 1 || key.length !== 1) return false
  const code = key.charCodeAt(0)
  return code >= 0x20 && code !== 0x7f
}

const digitOf = (action: { keys: string[] }): number | undefined => {
  const key = action.keys[0]
  return key !== undefined && /^[1-9]$/.test(key) ? Number(key) : undefined
}

/** Query text that should enter the search field from the browse layer. */
function isQueryText(data: string): boolean {
  if (data.startsWith(BRACKETED_PASTE_START)) return true
  // Non-mutating printable decoder: a lone ESC is Escape (cancel), and control
  // keys are never mistaken for query text.
  return printableInput(data) !== undefined
}

/**
 * A usable display stamp. DSH records epoch milliseconds; anything else
 * (absent, non-finite, zero) renders as `unknown time` in the row's own listed
 * position — an unstamped session is never moved, dropped or re-ordered.
 */
function stamp(createdAt: number | undefined): number | undefined {
  return typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt > 0 ? createdAt : undefined
}

/** Relative age column: Pi's wolf-style buckets, with an honest unknown case. */
function formatAge(createdAt: number | undefined, now: number = Date.now()): string {
  const created = stamp(createdAt)
  if (created === undefined) return 'unknown time'
  const seconds = Math.max(0, (now - created) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const date = new Date(created)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** One-line, ANSI-free display text from a native string field. */
const clean = (value: string): string => oneLine(sanitize(value), 300)

/**
 * Row window for a one-line-per-row list: the focused row first, then
 * alternately one row below and one above until the budget is spent. Kept next
 * to the painted rows so the ids reported to the parent are exactly the rows
 * actually drawn; a test pins the two together.
 */
function windowRange(count: number, index: number, budget: number): { start: number; end: number } {
  if (count <= budget) return { start: 0, end: count }
  let start = Math.max(0, Math.min(index, count - 1))
  let end = start + 1
  let used = 1
  for (let grew = true; grew;) {
    grew = false
    if (end < count && used + 1 <= budget) {
      end += 1
      used += 1
      grew = true
    }
    if (start > 0 && used + 1 <= budget) {
      start -= 1
      used += 1
      grew = true
    }
  }
  return { start, end }
}

export class SessionPickerDialog implements Component, Focusable {
  readonly capturesViewportInput = true
  readonly modalSize: ModalSize = 'standard'

  private readonly tui: TUI
  private readonly options: SessionPickerOptions
  private readonly keymap: CcKeymap
  private readonly search: InlineAnswer
  private readonly directory: string
  private readonly frame = new ModalFrame()

  /** Native DTO projection, copied verbatim from the `sessions` listing order. */
  private items: SessionPickerItem[]
  /** Streamed titles: an entry wins over the DTO title, `null` confirms none. */
  private readonly titleOverlay = new Map<string, string | null>()

  /** Rows currently shown: scope filter, then fuzzy relevance while searching. */
  private visible: SessionPickerItem[] = []
  private index = 0
  private scope: Scope = 'directory'
  /** Phase-1: the headers have not arrived yet. */
  private loading: boolean
  /** Last reported window; `undefined` means nothing was reported yet. */
  private lastVisibleIds: string[] | undefined
  /** Body rows available in the last painted frame (window + id reporting). */
  private viewportRows = DEFAULT_VIEWPORT_ROWS
  private hits: HitRange[] = []
  private focusedState = false
  private done = false
  /**
   * `browse` is the read-only list: list navigation, `session.scope.toggle` and
   * `modal.search` resolve in `modalList`. `search` is the one CC text field
   * (`modalSearch`): Ctrl+A/F stay readline line-start/char-right and the field
   * owns typing, so the scope action is deliberately unreachable there.
   */
  private mode: 'browse' | 'search' = 'browse'
  /** Content revision: a stale press can never activate a re-ordered row. */
  private revision = 0
  private press?: { key: string; owner: string }

  constructor(tui: TUI, options: SessionPickerOptions) {
    this.tui = tui
    this.options = options
    this.keymap = options.keymap ?? createCcKeymap()
    this.directory = options.directory
    this.loading = options.loading === true
    // DSH's listing order is the display order; the picker only copies it.
    this.items = [...(options.sessions ?? [])]
    this.search = new InlineAnswer(tui, this.keymap)
    // The modal text field: one editor state, editor editing actions plus the
    // dialog/app fallbacks the UI maps to select/cancel/interrupt.
    this.search.editor.setContext('modalSearch')
    this.search.onChange = () => this.handleQueryChange()
    this.search.editor.onAction = (event) => {
      switch (event.id) {
        case 'dialog.confirm':
          this.finish(this.index)
          return true
        case 'dialog.cancel':
        case 'app.cancel':
          // Esc cancels the focused local layer (the search) first; the next Esc
          // closes the picker in browse mode.
          this.leaveSearch()
          return true
        case 'app.interrupt':
          this.interrupt()
          return true
        case 'editor.complete':
          // Tab is completion in a text field; there is no provider here, so it
          // stays inert instead of pretending to toggle the scope.
          return true
        default:
          return false
      }
    }
    // A provided listing reports its first window from construction; the
    // phase-1 dialog waits for `setSessions` so the parent is not asked to
    // fetch titles for rows that do not exist.
    this.refresh(undefined, 0)
    if (options.sessions !== undefined) this.notifyVisible()
  }

  // --- public surface ----------------------------------------------------

  get focused(): boolean {
    return this.focusedState
  }

  set focused(value: boolean) {
    if (value === this.focusedState) return
    this.keymap.cancelChord()
    this.focusedState = value
    // The query field owns the caret only while the search layer is active, so
    // IME/cursor placement follows both focus and mode.
    this.search.focused = value && this.mode === 'search'
    this.tui.requestRender()
  }

  /**
   * Fragmented bracketed-paste state of the one query editor, so the App's
   * global Ctrl+C listener never interrupts on a byte that is query text.
   */
  get isPasting(): boolean {
    return this.search.editor.isPasting()
  }

  invalidate(): void {
    this.frame.invalidate()
    this.search.invalidate()
  }

  /** Release the one query editor (idempotent); the parent owns the surface. */
  dispose(): void {
    this.search.dispose()
    this.frame.invalidate()
  }

  /**
   * Phase-1 arrival: replace the native listing and leave the loading state.
   * Scope, query and the title overlay are kept, so this is safe to call
   * repeatedly and while searching; the selection follows the selected id when
   * it is still listed and otherwise falls back to the first row. Mutates state
   * only — no timers, no render request, no backend call: the caller re-renders
   * afterwards.
   */
  setSessions(sessions: readonly SessionPickerItem[]): void {
    const previous = this.selectedId()
    this.revision += 1
    this.items = [...sessions]
    this.loading = false
    this.refresh(previous, 0)
    this.notifyVisible()
  }

  /**
   * Enter/leave the phase-1 loading state. While loading and no header has
   * arrived yet the rows area shows the single `Loading sessions…` row; once it
   * ends the per-scope empty states apply. Mutates state only — no timers, no
   * render request, no backend call: the caller re-renders afterwards.
   */
  setLoading(loading: boolean): void {
    this.loading = loading
  }

  /**
   * Merge confirmed titles streamed for visible rows: a string replaces the DTO
   * title and `null` confirms there is none. Row rendering and the fuzzy search
   * text consult this overlay immediately, so an active query is re-filtered and
   * the selected id is kept while it still matches. Mutates state only — no
   * timers, no render request, no backend call: the caller re-renders afterwards.
   */
  setTitles(titles: ReadonlyMap<string, string | null>): void {
    if (titles.size === 0) return
    this.revision += 1
    for (const [id, title] of titles) this.titleOverlay.set(id, title)
    this.refresh()
    this.notifyVisible()
  }

  // --- state -------------------------------------------------------------

  private query(): string {
    return this.search.text
  }

  private empty(): boolean {
    return this.visible.length === 0
  }

  private selectedId(): string | undefined {
    return this.visible[this.index]?.id
  }

  /** Exact recorded cwd, or the same resolved directory (symlinked launches). */
  private inDirectory(recorded: string): boolean {
    if (recorded === '' || this.directory === '') return false
    if (recorded === this.directory) return true
    try {
      return resolve(recorded) === resolve(this.directory)
    } catch {
      return false
    }
  }

  /**
   * Recompute the visible rows and keep the selection on the same session id
   * when it survives the filter (Pi's `selectionTouched` behaviour); otherwise
   * fall back to `fallbackIndex`, clamped into the new list. Rows keep their
   * relative listing order in every branch — filtering and scope switching only
   * add or remove rows, they never re-rank them. Reporting the new window is
   * the caller's job so every notification point stays visible.
   */
  private refresh(previousId: string | undefined = this.selectedId(), fallbackIndex = this.index): void {
    // Order is the caller's: `filter` keeps the listing order and the only
    // relevance re-order is Pi's `fuzzyFilter` below. Never sort on a stamp —
    // DSH already ordered this listing, and a TUI-local recency policy would be
    // a second durability truth (see the module ordering policy).
    const scoped = this.scope === 'directory'
      ? this.items.filter(item => this.inDirectory(item.cwd))
      : [...this.items]
    const query = this.query()
    this.visible = query === ''
      ? scoped
      : fuzzyFilter(scoped, query, item => `${this.titleText(item)} ${item.cwd}`)
    if (this.visible.length === 0) {
      this.index = 0
      return
    }
    const found = previousId === undefined ? -1 : this.visible.findIndex(item => item.id === previousId)
    this.index = found >= 0 ? found : Math.max(0, Math.min(fallbackIndex, this.visible.length - 1))
  }

  /** Ids inside the row window paint, top to bottom. */
  private windowIds(): string[] {
    if (this.visible.length === 0) return []
    const { start, end } = windowRange(this.visible.length, this.index, Math.max(1, this.viewportRows))
    return this.visible.slice(start, end).map(item => item.id)
  }

  /**
   * Report the ids painted inside the row window. Consecutive identical lists
   * are skipped, so unrelated keystrokes never re-trigger the parent's lazy
   * title fetch.
   */
  private notifyVisible(): void {
    const ids = this.windowIds()
    const previous = this.lastVisibleIds
    if (previous !== undefined && previous.length === ids.length && previous.every((id, index) => id === ids[index])) return
    this.lastVisibleIds = ids
    this.options.onVisibleIds?.(ids)
  }

  private move(delta: number): void {
    const count = this.visible.length
    if (count === 0) return
    this.index = (this.index + delta + count) % count
    this.notifyVisible()
  }

  private setIndex(index: number): void {
    if (this.empty()) return
    this.index = Math.max(0, Math.min(index, this.visible.length - 1))
    this.notifyVisible()
  }

  private toggleScope(): void {
    this.revision += 1
    this.scope = this.scope === 'directory' ? 'all' : 'directory'
    // The query survives the toggle, exactly like Pi's scope switch.
    this.refresh()
    this.notifyVisible()
    this.tui.requestRender()
  }

  private finish(index: number): void {
    if (this.done) return
    const item = this.visible[index]
    if (item === undefined) return
    this.done = true
    this.keymap.cancelChord()
    this.options.onSelect(item.id)
  }

  private cancel(): void {
    if (this.done) return
    this.done = true
    this.keymap.cancelChord()
    this.options.onCancel()
  }

  /** Global interrupt: routed to the parent, or cancel when no hook was given. */
  private interrupt(): void {
    this.keymap.cancelChord()
    if (this.options.onInterrupt !== undefined) {
      this.options.onInterrupt()
      return
    }
    this.cancel()
  }

  // --- input -------------------------------------------------------------

  handleInput(raw: string): void {
    if (this.done || raw === '') return
    // Bracketed paste and a pending chord are owned by the one editor state,
    // whichever layer is active: the bytes are text, never an action.
    if (this.search.editor.isPasting() || this.keymap.isPendingChord()) {
      if (this.mode === 'browse') this.enterSearch()
      this.typeIntoField(raw)
      return
    }
    if (this.mode === 'search') {
      // The field owns the keyboard: page keys still scroll the modal list, and
      // every other key (Ctrl+A line-start, Ctrl+F char-right, arrows, kill/
      // yank/undo, Esc/Enter through the editor's dialog fallbacks) is the one
      // CC editor state. `session.scope.toggle` is deliberately unreachable
      // here so Ctrl+A keeps its readline meaning in a text field.
      const scroll = this.scrollAction(raw)
      if (scroll !== undefined) {
        this.apply(scroll)
        return
      }
      this.typeIntoField(raw)
      return
    }
    // Browse layer: unified modal list keys, the scope toggle and `modal.search`.
    const action = modalAction(this.keymap, raw, [SCOPE_TOGGLE, 'modal.search'])
    if (action !== undefined) {
      if (this.dispatchable(action)) {
        this.apply(action)
        return
      }
    }
    // A printable key starts the search: one keystroke, no second editor.
    if (isQueryText(raw)) {
      this.enterSearch()
      this.typeIntoField(raw)
    }
  }

  /**
   * The only modal-list actions that keep priority while the search field owns
   * text: page scrolling (a single-line query has nothing to page through).
   * Resolved from the effective bindings without mutating chord state.
   */
  private scrollAction(raw: string): ResolvedModalAction | undefined {
    for (const id of SCROLL_ACTIONS) {
      const binding = this.keymap.getBindings(id).find(entry => !entry.includes(' ') && matchesKey(raw, entry as KeyId))
      if (binding !== undefined) return { id, keys: [binding] }
    }
    return undefined
  }

  /** Whether a resolved browse action keeps its meaning over the query field. */
  private dispatchable(action: ResolvedModalAction): boolean {
    if (isCancelAction(action.id) || action.id === 'app.interrupt') return true
    // The scope toggle belongs to the browse list only (see the mode comment).
    if (action.id === SCOPE_TOGGLE) return true
    if (action.id === 'modal.search') return true
    // Numbered quick-select only exists while nothing has been typed.
    if (action.id === 'list.select-digit') return this.query() === ''
    // Printable single-key bindings belong to the query field.
    return !isPrintedChar(action.keys)
  }

  private enterSearch(): void {
    if (this.mode === 'search') return
    this.mode = 'search'
    this.revision += 1
    this.search.focused = this.focusedState
    this.tui.requestRender()
  }

  /** Esc in the field leaves the search layer and clears the query. */
  private leaveSearch(): void {
    if (this.mode !== 'search') return
    this.mode = 'browse'
    this.search.focused = false
    this.search.editor.replaceDraftText('')
    this.revision += 1
    this.refresh()
    this.notifyVisible()
    this.tui.requestRender()
  }

  private typeIntoField(raw: string): void {
    // The one editor resolves Enter/Esc to its own submit/cancel results (the
    // `modalSearch` chain reaches `editor.submit`/`editor.cancel` before the
    // dialog layer); both map onto this surface's select/leave-search route.
    // The selected id is captured BEFORE the key: CcEditor clears the query on
    // submit, so a post-submit refresh must not resurrect a row the user had
    // filtered away and select it.
    const target = this.selectedId()
    const result = this.search.handleKey(raw)
    switch (result) {
      case 'submit': {
        const index = target === undefined ? -1 : this.visible.findIndex(item => item.id === target)
        if (index >= 0) this.finish(index)
        return
      }
      case 'cancel':
        this.leaveSearch()
        return
      case 'interrupt':
        this.interrupt()
        return
      default:
        break
    }
    this.refresh()
    this.notifyVisible()
    this.tui.requestRender()
  }

  private apply(action: ResolvedModalAction): void {
    if (action.id === 'app.interrupt') {
      this.interrupt()
      return
    }
    if (isCancelAction(action.id)) {
      // Esc cancels the whole picker even with an active query (Pi behaviour);
      // Backspace/editing is what clears the query.
      this.cancel()
      return
    }
    if (action.id === SCOPE_TOGGLE) {
      this.toggleScope()
      return
    }
    if (action.id === 'modal.search') {
      this.enterSearch()
      return
    }
    const count = this.visible.length
    if (action.id === 'list.previous') this.move(-1)
    else if (action.id === 'list.next') this.move(1)
    else if (action.id === 'list.page-up') this.move(-5)
    else if (action.id === 'list.page-down') this.move(5)
    else if (action.id === 'list.first' && count > 0) this.setIndex(0)
    else if (action.id === 'list.last' && count > 0) this.setIndex(count - 1)
    else if (isSelectAction(action.id) && count > 0) this.finish(this.index)
    else if (action.id === 'list.select-digit') {
      const number = digitOf(action)
      if (number !== undefined && number <= count) this.finish(number - 1)
    }
    this.tui.requestRender()
  }

  private handleQueryChange(): void {
    this.refresh()
    this.notifyVisible()
    this.tui.requestRender()
  }

  // --- mouse -------------------------------------------------------------

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.done) return undefined
    const chrome = this.frame.handleMouse(event)
    if (chrome !== undefined) return chrome
    const body = this.frame.bodyMouse(event)
    if (body === undefined) return undefined
    if (event.type === 'wheel') {
      const delta = event.wheelDelta ?? 0
      if (delta === 0) return undefined
      this.move(delta < 0 ? -1 : 1)
      return { handled: true, render: true }
    }
    const owner = this.ownerKey()
    const hit = bodyHitAt(this.hits, body.y)
    const key = hit === undefined ? undefined : this.visible[hit.index]?.id
    if (event.type === 'press') {
      this.press = key === undefined ? undefined : { key, owner }
      return hit === undefined ? undefined : { handled: true, render: true }
    }
    if (event.type === 'drag') {
      // A drag invalidates the pending click: it is a selection gesture.
      if (this.press !== undefined) this.press = undefined
      return undefined
    }
    if (event.type !== 'click') return undefined
    const pressed = this.press
    this.press = undefined
    // Only a press and release on the same native session id may resume it: a
    // late click after re-filtering, re-ordering or a scope/query change is
    // swallowed instead of opening a different session.
    if (pressed === undefined || pressed.owner !== owner || key === undefined || pressed.key !== key) {
      return { handled: true, render: false }
    }
    const index = this.visible.findIndex(item => item.id === key)
    if (index >= 0) this.finish(index)
    return { handled: true, render: true }
  }

  /**
   * Content identity for the frame and for press pinning: the native listing,
   * scope, query and layer determine which rows exist. A press recorded against
   * a different identity can never activate a row.
   */
  private ownerKey(): string {
    return `sessions:${this.scope}:${this.mode}:${this.query()}:${this.revision}`
  }

  // --- rendering ---------------------------------------------------------

  private scopeIndicator(): string {
    return this.scope === 'directory'
      ? `${t.accent('Current Folder')}${t.muted(' | All')}`
      : `${t.muted('Current Folder | ')}${t.accent('All')}`
  }

  private rightColumn(item: SessionPickerItem): string {
    const parts = [formatAge(item.createdAt)]
    if (item.live === true) parts.push('· open elsewhere')
    // The recorded cwd only matters when the list spans folders.
    // Shorten before applying the display budget: a long home prefix must
    // not be truncated away before tildePath can recognize it.
    if (this.scope === 'all' && item.cwd !== '') parts.push(oneLine(tildePath(sanitize(item.cwd)), 300))
    return parts.join(' ')
  }

  /**
   * Effective title text: a streamed overlay entry wins over the DTO title, and
   * `null` (confirmed none) or an empty string reads as no title at all.
   */
  private titleText(item: SessionPickerItem): string {
    const raw = this.titleOverlay.has(item.id) ? this.titleOverlay.get(item.id) : item.title
    return clean(raw ?? '')
  }

  private rowTitle(item: SessionPickerItem): string {
    const title = this.titleText(item)
    return title === '' ? '(untitled)' : title
  }

  /**
   * One line per session: cursor, index, title, then the right-aligned age /
   * live / cwd column. The title truncates first; the right column is dropped
   * whole rather than cut when the width cannot hold it.
   */
  private row(item: SessionPickerItem, index: number, width: number): string {
    const selected = index === this.index
    const cursor = `${selected ? cc.suggestion('❯') : ' '} `
    const label = dim(`${index + 1}.`.padEnd(String(this.visible.length).length + 1))
    const lead = `${cursor}${label} `
    const leadWidth = visibleWidth(lead)
    const right = this.rightColumn(item)
    const rightWidth = visibleWidth(right)
    const showRight = rightWidth > 0 && width - leadWidth - rightWidth - 1 >= 4
    const room = showRight ? width - leadWidth - rightWidth - 1 : Math.max(1, width - leadWidth)
    const title = truncateToWidth(this.rowTitle(item), Math.max(1, room), '…')
    const styled = selected ? bold(title) : t.text(title)
    if (!showRight) return lead + styled
    const spacing = Math.max(1, width - leadWidth - visibleWidth(title) - rightWidth)
    return lead + styled + ' '.repeat(spacing) + dim(right)
  }

  private emptyMessage(): string {
    // Phase-1: the headers themselves have not arrived yet, so neither scope
    // hint is true. The dialog still renders its chrome and stays dismissable.
    if (this.loading && this.items.length === 0) return 'Loading sessions…'
    const query = oneLine(clean(this.query()), 40)
    if (query !== '') return `No sessions matching '${query}'`
    return this.scope === 'directory'
      ? 'No sessions in current folder. Switch scope to view all.'
      : 'No sessions found'
  }

  private statusText(): string {
    const parts: string[] = []
    const query = this.query()
    if (query === '') parts.push(`${this.visible.length} session${this.visible.length === 1 ? '' : 's'}`)
    else parts.push(`${this.visible.length} of ${this.scope === 'directory' ? this.items.filter(item => this.inDirectory(item.cwd)).length : this.items.length} sessions`)
    if (this.visible.length > 0) parts.push(`${this.index + 1}/${this.visible.length}`)
    parts.push(this.scope === 'directory' ? 'current folder' : 'all folders')
    // The escape layer is stated where it actually is, not inferred.
    if (this.mode === 'search') parts.push('esc leaves search')
    return parts.join(' · ')
  }

  private baseOptions(): ModalFrameOptions {
    return {
      title: 'Resume session',
      ownerKey: this.ownerKey(),
      actions: [
        {
          id: 'scope',
          label: this.scope === 'directory' ? 'All folders' : 'Current folder',
          action: SCOPE_TOGGLE,
          onActivate: () => this.toggleScope(),
        },
        {
          id: 'select',
          label: 'Resume',
          action: 'list.select',
          onActivate: () => this.finish(this.index),
          disabled: this.visible.length === 0,
        },
        { id: 'cancel', label: 'Cancel', action: 'list.cancel', onActivate: () => this.cancel() },
      ],
      onClose: () => this.cancel(),
      maxHeight: modalHeight(this.tui, this.modalSize),
      keymap: this.keymap,
    }
  }

  private chromeLines(bodyWidth: number): string[] {
    const lines = [fit(' ' + this.scopeIndicator(), bodyWidth)]
    const prefix = ` ${dim('Search')} `
    const fieldWidth = Math.max(4, bodyWidth - visibleWidth(prefix))
    // The caret/placeholder is only shown while the search layer owns typing.
    const focused = this.focusedState && this.mode === 'search'
    const field = this.search.render(fieldWidth, focused, this.mode === 'search' ? 'type to search' : 'type to search (any printable key)')
    field.slice(0, 4).forEach((line, index) => {
      const lead = index === 0 ? prefix : ' '.repeat(visibleWidth(prefix))
      lines.push(fit(lead + line, bodyWidth))
    })
    lines.push('')
    return lines
  }

  private body(bodyWidth: number, bodyHeight: number): BodyPaint {
    if (this.empty()) {
      return textPaint(wrap(this.emptyMessage(), Math.max(4, bodyWidth - 2)).map(line => ` ${t.muted(fit(line, Math.max(4, bodyWidth - 2)))}`))
    }
    const { start, end } = windowRange(this.visible.length, this.index, Math.max(1, bodyHeight))
    const lines: string[] = []
    const hits: HitRange[] = []
    for (let index = start; index < end; index += 1) {
      const item = this.visible[index]!
      hits.push({ startRow: lines.length, endRow: lines.length, index })
      lines.push(this.row(item, index, bodyWidth))
    }
    return { lines, hits }
  }

  render(width: number): string[] {
    const base = this.baseOptions()
    const bodyWidth = this.frame.measure(width, base).bodyWidth
    const options: ModalFrameOptions = {
      ...base,
      before: this.chromeLines(bodyWidth),
      after: [fit(` ${t.subtle(this.statusText())}`, bodyWidth)],
    }
    const painted = renderModalBody(this.frame, width, options, (innerWidth, bodyHeight) => {
      // Cache the real body budget so the reported window matches the paint.
      this.viewportRows = Math.max(1, bodyHeight)
      const body = this.body(innerWidth, bodyHeight)
      return body
    })
    this.hits = painted.paint.hits
    this.notifyVisible()
    return painted.lines
  }
}
