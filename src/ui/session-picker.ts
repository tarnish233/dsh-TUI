/**
 * Resume-session picker.
 *
 * The caller hands over DSH's native `sessions` DTO projection. That listing is
 * already deterministic — DSH's sessionQuery `compareSessions` returns newest
 * first — so this component never re-sorts the rows; incoming order is display
 * order and only an active query re-orders by fuzzy relevance. Everything below
 * is presentation: the current-folder/all scope filter, the relative age
 * column, the fuzzy query over title+cwd and the selection index. Session ids
 * are opaque stream ids and are passed back verbatim on select, so session
 * identity and switching stay DSH facts.
 *
 * Two-phase data flow: DSH lists session headers and generates titles
 * separately, so the dialog opens immediately (`loading`, no sessions), accepts
 * the headers later through `setSessions`, and merges streamed titles through
 * `setTitles`. The component never fetches, never times out and never renders
 * on its own: every mutator only updates state, and `onVisibleIds` tells the
 * parent which rows to fetch titles for. All of that is state plus a callback —
 * no timers, no render requests, no backend calls.
 *
 * The UX mirrors Pi's own session selector — a search line, a Tab
 * Current-Folder ↔ All scope toggle, one-line rows with a right-aligned age
 * column, native order and per-scope empty states — rebuilt on the *vendored*
 * Pi TUI primitives only: a plain `Input` for the query field, `fuzzyFilter`
 * for matching, and this repo's dialog geometry (`rowBudget`, `windowRows`,
 * `fit`) plus the shared `CcKeymap` in list context, exactly like
 * `SelectDialog`. One deliberate difference from `SelectDialog`: a printable
 * single-key list binding (j/k in list context) is query text here, never
 * navigation, because a search field must not refuse a letter. Numbered
 * quick-select stays available while the query is empty (CC list behaviour) and
 * becomes query text once typing starts.
 *
 * Layout (top to bottom): header with the title on the left and the right
 * aligned scope indicator, the search field, a blank line, one row per session
 * (or the phase-1 `Loading sessions…` row / the scope-aware empty hint), the
 * optional `(i/n)` window indicator, a blank line, and the footer hint.
 * Every line is width-safe for any width >= 4; no stdout is ever written.
 */
import { resolve } from 'node:path'
import {
  type Component,
  type Focusable,
  fuzzyFilter,
  Input,
  matchesKey,
  type TUI,
} from '#pi-tui'
import { createCcKeymap, type CcKeymap } from '../input/index.ts'
import { isInterruptKey, listAction, rowBudget, windowRows } from './dialogs.ts'
import { bold, cc, dim, t } from './theme.ts'
import { fit, oneLine, sanitize, tildePath, truncateToWidth, visibleWidth } from './text.ts'

export interface SessionPickerItem {
  /** DSH session id (the opaque wire id, passed back verbatim on select). */
  id: string
  /** Native LLM-generated title, when the session has one. */
  title?: string
  /** Recorded working directory of the session (may differ per session). */
  cwd: string
  /** Epoch-milliseconds creation stamp; unknown when absent. */
  createdAt?: number
  /** Another process currently holds the session open. */
  live?: boolean
}

export interface SessionPickerOptions {
  /**
   * Raw native DTO projection, unfiltered and unsorted — the picker owns
   * presentation. Omitted or empty is the phase-1 state: the dialog renders
   * immediately and the headers arrive later through `setSessions`.
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
const isInterruptAction = (id: string): boolean => id === 'app.interrupt'
const isSelectAction = (id: string): boolean => id === 'list.select' || id === 'dialog.confirm'

const isTab = (data: string): boolean => matchesKey(data, 'tab')

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

/**
 * A usable creation stamp. DSH records epoch milliseconds; anything else
 * (absent, non-finite, zero) is "unknown" and sorts last / renders as such.
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
 * Row window for a one-line-per-row list, following `windowRows` growth
 * exactly: the focused row first, then alternately one row below and one row
 * above until the budget is spent. Kept next to `windowRows`' contract so the
 * ids reported to the parent are the rows actually painted; a test pins the two
 * together.
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

  private readonly tui: TUI
  private readonly options: SessionPickerOptions
  private readonly keymap: CcKeymap
  private readonly search: Input
  private readonly directory: string

  /** Native DTO projection, in the order DSH's `sessions` listing returned it. */
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
  private focusedState = false
  private done = false

  constructor(tui: TUI, options: SessionPickerOptions) {
    this.tui = tui
    this.options = options
    this.keymap = options.keymap ?? createCcKeymap()
    this.directory = options.directory
    this.loading = options.loading === true
    // DSH's listing order is the display order; the picker only copies it.
    this.items = [...(options.sessions ?? [])]
    this.search = new Input({
      prompt: ` ${dim('Search')} `,
      placeholder: 'type to search',
      placeholderStyle: text => t.muted(text),
    })
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
    // The query field owns the caret, so IME/cursor placement follows focus.
    this.search.focused = value
    this.tui.requestRender()
  }

  invalidate(): void {
    this.search.invalidate()
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
    for (const [id, title] of titles) this.titleOverlay.set(id, title)
    this.refresh()
    this.notifyVisible()
  }

  // --- state -------------------------------------------------------------

  private query(): string {
    return this.search.getValue().trim()
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
   * fall back to `fallbackIndex`, clamped into the new list. Reporting the new
   * window is the caller's job so every notification point stays visible.
   */
  private refresh(previousId: string | undefined = this.selectedId(), fallbackIndex = this.index): void {
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
    const { start, end } = windowRange(this.visible.length, this.index, rowBudget(this.tui))
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
    this.scope = this.scope === 'directory' ? 'all' : 'directory'
    // The query survives the toggle, exactly like Pi's scope switch.
    this.refresh()
    this.notifyVisible()
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
    // Interrupt priority matches SelectDialog: the configured `app.interrupt`
    // key is checked before the list binding that also carries Ctrl+C.
    if (isInterruptKey(this.keymap, raw)) {
      this.interrupt()
      return
    }
    // Tab is the scope toggle and is intercepted before the query field sees it.
    if (isTab(raw)) {
      this.toggleScope()
      return
    }
    const action = listAction(this.keymap, raw)
    // A half-typed chord owns its prefix keys; they are neither navigation nor
    // query text.
    if (this.keymap.isPendingChord()) return
    if (action !== undefined) {
      if (this.dispatchable(action)) {
        this.apply(action)
        return
      }
    }
    this.type(raw)
  }

  /** Whether a resolved list action keeps its meaning over the query field. */
  private dispatchable(action: { id: string; keys: string[] }): boolean {
    if (isInterruptAction(action.id) || isCancelAction(action.id)) return true
    // Numbered quick-select only exists while nothing has been typed.
    if (action.id === 'list.select-digit') return this.query() === ''
    // Printable single-key bindings belong to the query field.
    return !isPrintedChar(action.keys)
  }

  private apply(action: { id: string; keys: string[] }): void {
    if (isInterruptAction(action.id)) {
      this.interrupt()
      return
    }
    if (isCancelAction(action.id)) {
      // Esc cancels the whole picker even with an active query (Pi behaviour);
      // Backspace/editing is what clears the query.
      this.cancel()
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
  }

  /** Everything else is query text: the single Input state owns it. */
  private type(raw: string): void {
    this.search.handleInput(raw)
    this.refresh()
    this.notifyVisible()
    this.tui.requestRender()
  }

  // --- rendering ---------------------------------------------------------

  private title(): string {
    return this.scope === 'directory' ? 'Resume session (Current Folder)' : 'Resume session (All)'
  }

  private scopeIndicator(): string {
    return this.scope === 'directory'
      ? `${t.accent('Current Folder')}${t.muted(' | All')}`
      : `${t.muted('Current Folder | ')}${t.accent('All')}`
  }

  /** Bold title on the left, active scope text on the right; right side truncates first. */
  private header(width: number): string {
    const right = truncateToWidth(this.scopeIndicator(), width, '')
    const available = Math.max(0, width - visibleWidth(right) - 1)
    const left = truncateToWidth(bold(cc.permission(this.title())), available, '')
    const spacing = Math.max(0, width - visibleWidth(left) - visibleWidth(right))
    return left + ' '.repeat(spacing) + right
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
      ? 'No sessions in current folder. Press Tab to view all.'
      : 'No sessions found'
  }

  render(width: number): string[] {
    const safeWidth = Math.max(4, Math.floor(width))
    const out: string[] = [this.header(safeWidth), this.search.render(safeWidth)[0] ?? '', '']
    const budget = rowBudget(this.tui)
    if (this.empty()) {
      out.push(` ${t.muted(this.emptyMessage())}`)
    } else {
      const blocks = this.visible.map((item, index) => ({
        lines: [this.row(item, index, safeWidth)],
        focused: index === this.index,
      }))
      out.push(...windowRows(blocks, budget))
      if (this.visible.length > budget) out.push(` ${t.muted(`(${this.index + 1}/${this.visible.length})`)}`)
    }
    out.push('', ` ${dim(cc.inactive('Tab folder/all · Enter select · Esc cancel · type to search'))}`)
    return out.map(line => fit(line, safeWidth))
  }
}
