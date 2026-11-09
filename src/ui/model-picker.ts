/**
 * /model picker: provider-grouped, searchable model chooser.
 *
 * The picker owns only presentation and selection state. Model catalogs,
 * provider strings and opaque model ids come from the caller unchanged; this
 * file never parses an id, invents a provider alias or reads credentials.
 *
 * The surface is the shared `ModalFrame` (`standard` size): chrome, sizing,
 * action chips and mouse geometry belong to the frame, the picker supplies the
 * provider/search chrome lines, the model body and its mouse row ranges. The
 * frame footer prints the *actual* keymap bindings for provider switching,
 * selection and cancel, so a remap or a disabled action never shows a fake key.
 *
 * Asynchronous rosters: the parent may open the picker before the native catalog
 * is known and then call `setModels`/`setLoading`/`setError`. Loading, an empty
 * catalog, a query with no match and a visible native failure are four distinct
 * states. Late data never selects or submits anything: the selection is
 * preserved when its model id (or provider) still exists. A native
 * `model_route` event may also settle the route *after* the picker opened: the
 * parent calls `setCurrentRoute`, which only refreshes the `current` badge and
 * status inputs - never the highlight, query, provider group or focus.
 *
 * Input uses the central CC/readline subsystem:
 * - exactly one `InlineAnswer`/`CcEditor` state for the query field;
 * - the shared `CcKeymap`, switched between the real `modelPickerList` and
 *   `modelPickerSearch` contexts with `CcEditor.setContext()`;
 * - provider/list actions are handled from `editor.onAction` events, never
 *   from hardcoded Tab/Left/Right matches;
 * - browse mode forwards navigation to the editor so the keymap resolves
 *   remaps, disabling and chords exactly once;
 * - typing, paste and genuine readline edits switch the same editor to
 *   `modelPickerSearch` (the input layer applies printable-text priority);
 * - Up/Down/Ctrl+P/N in the query are inspected at the visual boundary with
 *   the same non-mutating check as `InlineAnswer`, then either move the model
 *   selection (back to browse) or stay in the query editor.
 *
 * No stdout is written while active. All rendered lines are width-safe.
 */
import {
  CURSOR_MARKER,
  type Component,
  type Focusable,
  type KeyId,
  matchesKey,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '#pi-tui'
import {
  BRACKETED_PASTE_START,
  type CcActionEvent,
  type CcContext,
  type CcKeymap,
  printableInput,
} from '../input/index.ts'
import { bodyHitAt, concatPaint, renderModalBody, textPaint, windowRowsWithHits, type BodyPaint, type HitRange, type RowBlock } from './dialogs.ts'
import { InlineAnswer } from './inline-editor.ts'
import { ModalFrame, modalHeight, type ModalFrameOptions, type ModalSize } from './modal.ts'
import { bold, cc, dim, t } from './theme.ts'
import { fit, oneLine, sanitize, truncateToWidth, visibleWidth, wrap } from './text.ts'

export interface ModelPickerItem {
  /** Opaque model id from the native catalog; never parsed or rewritten. */
  id: string
  /** Exact native provider group string. */
  provider: string
  /** Exact native model string. */
  model: string
  /** Display label supplied by the caller (may equal or omit `model`). */
  label?: string
  description?: string
  /** Display only; the picker never infers a default. */
  isDefault?: boolean
}

export interface ModelPickerOptions {
  /**
   * Native catalog rows, in native order. Omitted or empty is the phase-1
   * state: the picker renders immediately and `setModels` supplies the catalog.
   */
  models?: readonly ModelPickerItem[]
  currentProvider?: string
  currentModel?: string
  keymap: CcKeymap
  onSelect: (id: string) => void
  onCancel: () => void
  onInterrupt?: () => void
  /** Phase-1 state: the catalog has not arrived yet. */
  loading?: boolean
  /** A visible failure from the native catalog read. */
  error?: string
}

type PickerMode = 'browse' | 'search'

const BROWSE_CONTEXT: CcContext = 'modelPickerList'
const SEARCH_CONTEXT: CcContext = 'modelPickerSearch'

const PROVIDER_PREVIOUS = 'model.provider.previous'
const PROVIDER_NEXT = 'model.provider.next'
const PROVIDER_PREVIOUS_ARROW = 'model.provider.previousArrow'
const PROVIDER_NEXT_ARROW = 'model.provider.nextArrow'

/** Visible query rows: one line is not a window, an unbounded field eats the body. */
const MAX_QUERY_ROWS = 4

/**
 * First simple action for `data` in a context chain, without mutating
 * keymap/chord state. Used only for mode/boundary decisions; actual dispatch
 * still goes through `CcEditor`.
 */
function simpleActionForKey(keymap: CcKeymap, data: string, context: CcContext): string | undefined {
  for (const entry of keymap.getFallbackChain(context)) {
    for (const action of keymap.definitions) {
      if (!action.contexts.includes(entry)) continue
      const bindings = keymap.getBindings(action.id)
      for (const binding of bindings) {
        if (binding.includes(' ')) continue
        if (matchesKey(data, binding as KeyId)) return action.id
      }
    }
  }
  return undefined
}

/** True when `data` is a configured single-key binding of `actionId`. */
function isBoundSingle(keymap: CcKeymap, actionId: string, data: string): boolean {
  return keymap.getBindings(actionId).some((binding) => !binding.includes(' ') && matchesKey(data, binding as KeyId))
}

/** True when `data` is the first key of a configured chord in this chain. */
function isChordPrefix(keymap: CcKeymap, data: string, context: CcContext): boolean {
  for (const entry of keymap.getFallbackChain(context)) {
    for (const action of keymap.definitions) {
      if (!action.contexts.includes(entry)) continue
      for (const binding of keymap.getBindings(action.id)) {
        const keys = binding.split(' ')
        if (keys.length < 2) continue
        if (matchesKey(data, keys[0] as KeyId)) return true
      }
    }
  }
  return false
}

/** Query text that should enter the search field from browse mode. */
function isQueryText(data: string): boolean {
  if (data.startsWith(BRACKETED_PASTE_START)) return true
  // The input owner's non-mutating Kitty/CSI-u + legacy printable decoder.
  // A lone ESC is Escape (cancel), not query text; control keys never match.
  return printableInput(data) !== undefined
}

const providerLabel = (provider: string): string => sanitize(provider === '' ? '(no provider)' : provider)

/** Keep the active visual line of a multiline query visible without touching editor state. */
function windowQueryLines(lines: readonly string[], budget: number): string[] {
  if (lines.length <= budget) return [...lines]
  let focus = lines.findIndex((line) => line.includes(CURSOR_MARKER))
  if (focus < 0) focus = 0
  const start = Math.max(0, Math.min(focus - Math.floor(budget / 2), lines.length - budget))
  return lines.slice(start, start + budget)
}

function providerTabs(providers: readonly string[], active: number, width: number): string | undefined {
  if (providers.length === 0) return undefined
  const labels = providers.map((provider) => providerLabel(provider))
  const render = (start: number, end: number): string => {
    const parts: string[] = []
    for (let index = start; index < end; index += 1) {
      const label = ` ${labels[index]} `
      parts.push(index === active ? cc.chip(label) : t.muted(label))
    }
    const left = start > 0 ? '‹ ' : ''
    const right = end < providers.length ? ' ›' : ''
    return left + parts.join(' ') + right
  }
  const activeIndex = Math.max(0, Math.min(active, providers.length - 1))
  // Keep the active provider visible first; then grow the window outward.
  let start = activeIndex
  let end = activeIndex + 1
  // A single very long provider name must not exceed the viewport. Shrink by
  // display columns (not code units) so CJK/emoji labels stay valid.
  let activeWidth = visibleWidth(labels[activeIndex]!)
  while (visibleWidth(render(start, end)) > width && activeWidth > 1) {
    activeWidth -= 1
    labels[activeIndex] = truncateToWidth(labels[activeIndex]!, activeWidth)
  }
  for (let grew = true; grew;) {
    grew = false
    if (end < providers.length && visibleWidth(render(start, end + 1)) <= width) {
      end += 1
      grew = true
    }
    if (start > 0 && visibleWidth(render(start - 1, end)) <= width) {
      start -= 1
      grew = true
    }
  }
  return render(start, end)
}

function modelBlocks(
  items: readonly ModelPickerItem[],
  selected: number,
  width: number,
  isCurrent: (item: ModelPickerItem) => boolean,
): RowBlock[] {
  return items.map((item, index) => {
    const focused = index === selected
    const prefix = `${focused ? cc.suggestion('❯') : ' '} `
    const available = Math.max(4, width - visibleWidth(prefix))
    const label = (item.label ?? '').trim()
    const nativeModel = sanitize(item.model)
    const title = label !== '' ? sanitize(label) : nativeModel !== '' ? nativeModel : sanitize(item.id)
    const modelSuffix = nativeModel !== '' && nativeModel !== title ? `  ${nativeModel}` : ''
    const badges: string[] = []
    if (isCurrent(item)) badges.push('current')
    if (item.isDefault === true) badges.push('default')
    const head = `${title}${modelSuffix}${badges.length > 0 ? `  ${badges.join(' · ')}` : ''}`
    const lines = wrap(head, available).map((line, lineIndex) => {
      const indent = lineIndex === 0 ? prefix : ' '.repeat(visibleWidth(prefix))
      return indent + (focused ? cc.suggestion(line) : t.text(line))
    })
    if (item.description !== undefined && item.description.trim() !== '') {
      const indent = ' '.repeat(visibleWidth(prefix) + 2)
      const description = sanitize(item.description.trim())
      for (const line of wrap(description, Math.max(4, width - visibleWidth(indent)))) {
        lines.push(indent + dim(line))
      }
    }
    return { lines, focused, index, key: item.id }
  })
}

export class ModelPickerDialog implements Component, Focusable {
  readonly capturesViewportInput = true
  readonly modalSize: ModalSize = 'standard'
  readonly keymap: CcKeymap

  private readonly tui: TUI
  private readonly onSelect: (id: string) => void
  private readonly onCancel: () => void
  private readonly onInterrupt?: () => void
  private readonly frame = new ModalFrame()
  private readonly grouped = new Map<string, ModelPickerItem[]>()
  private providers: string[]
  private currentProvider: string | undefined
  private currentModel: string | undefined
  private readonly search: InlineAnswer

  private providerIndex = 0
  private visibleModels: ModelPickerItem[] = []
  private selectedIndex = -1
  private mode: PickerMode = 'browse'
  private loadingState: boolean
  private errorState: string | undefined
  private hits: HitRange[] = []
  private press?: { key: string; owner: string }
  private focusedState = false
  private done = false
  private disposedState = false

  constructor(tui: TUI, options: ModelPickerOptions) {
    this.tui = tui
    this.keymap = options.keymap
    this.onSelect = options.onSelect
    this.onCancel = options.onCancel
    this.onInterrupt = options.onInterrupt
    this.currentProvider = options.currentProvider
    this.currentModel = options.currentModel
    this.loadingState = options.loading === true
    this.errorState = options.error
    this.providers = []
    this.applyModels(options.models ?? [])

    const requestedIndex = this.currentProvider !== undefined ? this.providers.indexOf(this.currentProvider) : -1
    this.providerIndex = requestedIndex >= 0 ? requestedIndex : 0

    this.search = new InlineAnswer(tui, this.keymap)
    // One editor, two real contexts: browse list first, search after typing.
    this.search.editor.setContext(BROWSE_CONTEXT)
    this.search.onChange = () => this.handleQueryChange()
    // Replace InlineAnswer's submit/cancel shim: the picker handles the
    // keymap's list/model events directly against its own state.
    this.search.editor.onAction = (event) => this.handleEditorAction(event)

    this.refreshVisible()
    this.selectCurrentModel()
  }

  // --- public state ------------------------------------------------------

  get focused(): boolean {
    return this.focusedState
  }

  set focused(value: boolean) {
    if (value === this.focusedState) return
    if (!value) this.keymap.cancelChord()
    this.focusedState = value
    this.search.focused = value
    this.tui.requestRender()
  }

  /**
   * Fragmented bracketed-paste state of the single query editor. The App's
   * global Ctrl+C listener checks this before cancelling a busy turn, because
   * a Ctrl+C byte inside a paste is query text, not an interrupt.
   */
  get isPasting(): boolean {
    return this.search.editor.isPasting()
  }

  /** True once a selection or cancellation was delivered. */
  get isDone(): boolean {
    return this.done
  }

  get isDisposed(): boolean {
    return this.disposedState
  }

  /** Parent hook for focus changes/keymap reloads. */
  cancelChord(): void {
    this.search.editor.cancelChord()
  }

  /** Release only the query editor's resources (idempotent). */
  dispose(): void {
    if (this.disposedState) return
    this.disposedState = true
    this.done = true
    this.search.onChange = undefined
    // CcEditor.dispose removes only this editor's shared-keymap listener and
    // cancels a pending chord only when this editor opened it.
    this.search.dispose()
  }

  invalidate(): void {
    this.frame.invalidate()
    this.search.invalidate()
  }

  // --- asynchronous native catalog ---------------------------------------

  /**
   * Replace the native catalog. Provider grouping follows the caller's order;
   * the active provider is kept by exact name when it survives, and the current
   * model's row is re-selected when it is still listed. Never selects, submits,
   * focuses or changes the query as a side effect of late data.
   */
  setModels(models: readonly ModelPickerItem[]): void {
    const hadProvider = this.providers.length > 0
    const providerName = hadProvider ? this.providers[this.providerIndex] : undefined
    const previousId = hadProvider ? this.visibleModels[this.selectedIndex]?.id : undefined
    this.applyModels(models)
    this.loadingState = false
    // A picker opened with no catalog has no previous provider to preserve, so
    // the caller's explicit native route (`currentProvider`) decides the group.
    // Falling back to the first provider would silently open on a different
    // provider than the session is actually using.
    const preferredProvider = hadProvider ? providerName : this.currentProvider
    const kept = preferredProvider === undefined ? -1 : this.providers.indexOf(preferredProvider)
    this.providerIndex = kept >= 0 ? kept : 0
    this.refreshVisible(previousId)
    this.selectCurrentModel(previousId)
  }

  /** Enter/leave the phase-1 loading state. */
  setLoading(loading: boolean): void {
    this.loadingState = loading
  }

  /** Show or clear a visible native failure in the current surface. */
  setError(message?: string): void {
    this.errorState = message === undefined || message.trim() === '' ? undefined : message
  }

  /**
   * Update the native current route used by the `current` badge and the status
   * line. A native `model_route` event can settle the effective route after the
   * picker was opened with an earlier (e.g. default) one.
   *
   * This is a display-input update only: the selected row, provider group,
   * query/editor state, focus, keymap and callbacks are untouched, nothing is
   * selected or submitted, and no provider jump is inferred from the new route.
   * An unknown route simply stops matching any row.
   */
  setCurrentRoute(provider: string | undefined, model: string | undefined): void {
    if (this.currentProvider === provider && this.currentModel === model) return
    this.currentProvider = provider
    this.currentModel = model
    this.frame.invalidate()
  }

  private applyModels(models: readonly ModelPickerItem[]): void {
    // Roster order is the caller's order: providers by first appearance and
    // models in native order within each provider. No sorting or aliasing.
    this.grouped.clear()
    for (const item of models) {
      const group = this.grouped.get(item.provider)
      if (group) group.push(item)
      else this.grouped.set(item.provider, [item])
    }
    this.providers = [...this.grouped.keys()]
  }

  /**
   * Prefer an explicit surviving row, then the current native route. This only
   * moves the highlight; it never selects or submits.
   */
  private selectCurrentModel(preferredId?: string): void {
    if (preferredId !== undefined) {
      const kept = this.visibleModels.findIndex(item => item.id === preferredId)
      if (kept >= 0) {
        this.selectedIndex = kept
        return
      }
    }
    if (this.currentModel !== undefined) {
      const requested = this.visibleModels.findIndex(
        (item) => item.model === this.currentModel && (this.currentProvider === undefined || item.provider === this.currentProvider),
      )
      if (requested >= 0) {
        this.selectedIndex = requested
        return
      }
    }
    this.selectedIndex = this.visibleModels.length === 0 ? -1 : 0
  }

  // --- input routing -----------------------------------------------------

  handleInput(data: string): void {
    if (this.done || this.disposedState || data.length === 0) return
    const editor = this.search.editor

    // Paste and chords are owned by the editor. Never reinterpret their bytes
    // with picker navigation: a pasted Tab/Ctrl+C byte must stay text, and a
    // half-typed chord must not be stolen or have its context switched.
    if (editor.isPasting() || this.keymap.isPendingChord()) {
      editor.handleInput(data)
      return
    }

    this.syncEditorContext()

    if (isQueryText(data)) {
      this.enterSearch()
      editor.handleInput(data)
      return
    }

    if (this.mode === 'browse') {
      const action = simpleActionForKey(this.keymap, data, BROWSE_CONTEXT)
      const chord = isChordPrefix(this.keymap, data, BROWSE_CONTEXT)
      // Genuine readline edits activate the query. The generic completion and
      // submit fallbacks (when model.provider.next / list.select is disabled)
      // stay inert and must not pretend to navigate, submit or clear text.
      if (
        !chord &&
        action !== undefined &&
        action.startsWith('editor.') &&
        action !== 'editor.complete' &&
        action !== 'editor.submit'
      ) {
        this.enterSearch()
      }
      editor.handleInput(data)
      return
    }

    const action = simpleActionForKey(this.keymap, data, SEARCH_CONTEXT)
    const chord = isChordPrefix(this.keymap, data, SEARCH_CONTEXT)
    const interrupt = isBoundSingle(this.keymap, 'app.interrupt', data)
    if (!chord && !interrupt && (action === 'editor.move.line-up' || action === 'editor.move.line-down')) {
      const first = action === 'editor.move.line-up' ? editor.ccIsOnFirstVisualLine() : editor.ccIsOnLastVisualLine()
      if (first) {
        this.moveSelection(action === 'editor.move.line-up' ? -1 : 1)
        this.enterBrowse()
        return
      }
    }
    editor.handleInput(data)
  }

  private syncEditorContext(): void {
    const context = this.mode === 'browse' ? BROWSE_CONTEXT : SEARCH_CONTEXT
    if (this.search.editor.getContext() !== context) this.search.editor.setContext(context)
  }

  private enterSearch(): void {
    if (this.mode !== 'search') {
      this.mode = 'search'
      this.tui.requestRender()
    }
    this.syncEditorContext()
  }

  private enterBrowse(): void {
    if (this.mode !== 'browse') {
      this.mode = 'browse'
      this.tui.requestRender()
    }
    this.syncEditorContext()
  }

  private handleQueryChange(): void {
    const previousId = this.visibleModels[this.selectedIndex]?.id
    this.refreshVisible(previousId)
    // A printable key re-dispatched after a chord mismatch is still query
    // text, even if the editor was in browse context at that instant.
    if (this.mode !== 'search') this.mode = 'search'
    // The editor also requests a frame, but the picker's filtered list and
    // status changed independently; keep the component state authoritative.
    this.tui.requestRender()
  }

  private handleEditorAction(event: CcActionEvent): boolean {
    if (this.done) return true
    switch (event.id) {
      case PROVIDER_PREVIOUS:
      case PROVIDER_PREVIOUS_ARROW:
        this.switchProvider(-1)
        return true
      case PROVIDER_NEXT:
      case PROVIDER_NEXT_ARROW:
        this.switchProvider(1)
        return true
      case 'list.previous':
        this.moveSelection(-1)
        return true
      case 'list.next':
        this.moveSelection(1)
        return true
      case 'list.page-up':
        this.moveSelection(-5)
        return true
      case 'list.page-down':
        this.moveSelection(5)
        return true
      case 'list.first':
        this.selectIndex(0)
        return true
      case 'list.last':
        this.selectIndex(this.visibleModels.length - 1)
        return true
      case 'list.select':
        this.selectCurrent()
        return true
      case 'list.cancel':
      case 'app.cancel':
        this.cancel()
        return true
      case 'app.interrupt':
        this.interrupt()
        return true
      case 'list.select-digit':
        // Digits are query text; numbered quick-select is not part of this UI.
        return true
      default:
        return false
    }
  }

  // --- selection state ---------------------------------------------------

  private queryText(): string {
    return this.search.editor.getExpandedText()
  }

  private itemsForProvider(): readonly ModelPickerItem[] {
    const provider = this.providers[this.providerIndex]
    return provider === undefined ? [] : (this.grouped.get(provider) ?? [])
  }

  private matchesQuery(item: ModelPickerItem, query: string): boolean {
    if (query === '') return true
    const haystack = `${item.id}\n${item.model}\n${item.label ?? ''}\n${item.description ?? ''}`.toLowerCase()
    return haystack.includes(query)
  }

  private refreshVisible(preserveId?: string): void {
    const query = this.queryText().trim().toLowerCase()
    const all = this.itemsForProvider()
    this.visibleModels = query === '' ? [...all] : all.filter((item) => this.matchesQuery(item, query))
    let next = -1
    if (preserveId !== undefined) next = this.visibleModels.findIndex((item) => item.id === preserveId)
    if (next < 0 && this.visibleModels.length > 0) next = 0
    this.selectedIndex = next
  }

  private selectIndex(index: number): void {
    if (this.visibleModels.length === 0) {
      this.selectedIndex = -1
      return
    }
    const clamped = Math.max(0, Math.min(index, this.visibleModels.length - 1))
    if (clamped === this.selectedIndex) return
    this.selectedIndex = clamped
    this.tui.requestRender()
  }

  private moveSelection(delta: number): void {
    const count = this.visibleModels.length
    if (count === 0) {
      this.selectedIndex = -1
      return
    }
    const current = this.selectedIndex < 0 ? 0 : this.selectedIndex
    this.selectedIndex = ((current + delta) % count + count) % count
    this.tui.requestRender()
  }

  private switchProvider(delta: number): void {
    const count = this.providers.length
    if (count === 0) return
    const next = ((this.providerIndex + delta) % count + count) % count
    if (next === this.providerIndex) return
    this.providerIndex = next
    // The query persists across providers; selection restarts at the first
    // visible model of the new provider (no hidden carry-over).
    this.refreshVisible()
    this.tui.requestRender()
  }

  private selectCurrent(): void {
    if (this.done) return
    const item = this.visibleModels[this.selectedIndex]
    if (item === undefined) return
    this.done = true
    this.keymap.cancelChord()
    this.onSelect(item.id)
  }

  private cancel(): void {
    if (this.done) return
    this.done = true
    this.keymap.cancelChord()
    this.onCancel()
  }

  private interrupt(): void {
    this.keymap.cancelChord()
    if (this.onInterrupt !== undefined) this.onInterrupt()
    else this.cancel()
  }

  // --- mouse -------------------------------------------------------------

  /**
   * Content identity: provider group, query and the visible roster decide which
   * rows exist. The frame and the press tracker both use it, so a stale click
   * can never select a model that moved in after a roster/query change.
   */
  private ownerKey(): string {
    return `model:${this.providers[this.providerIndex] ?? ''}:${this.queryText()}:${this.visibleModels.length}:${this.visibleModels[0]?.id ?? ''}`
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposedState) return undefined
    const chrome = this.frame.handleMouse(event)
    if (chrome !== undefined) return chrome
    const body = this.frame.bodyMouse(event)
    if (body === undefined) return undefined
    if (event.type === 'wheel') {
      const delta = event.wheelDelta ?? 0
      if (delta === 0) return undefined
      this.moveSelection(delta < 0 ? -1 : 1)
      return { handled: true, render: true }
    }
    const owner = this.ownerKey()
    const hit = bodyHitAt(this.hits, body.y)
    const key = hit === undefined ? undefined : hit.key ?? String(hit.index)
    if (event.type === 'press') {
      this.press = key === undefined ? undefined : { key, owner }
      // Do not move selection on press: the release must resolve the same row.
      return hit === undefined ? undefined : { handled: true, render: false }
    }
    if (event.type === 'drag') {
      this.press = undefined
      return undefined
    }
    if (event.type !== 'click') return undefined
    const pressed = this.press
    this.press = undefined
    if (pressed === undefined || pressed.owner !== owner || key === undefined || pressed.key !== key) {
      return { handled: true, render: false }
    }
    const index = this.visibleModels.findIndex(item => item.id === key)
    if (index < 0) return { handled: true, render: false }
    this.selectedIndex = index
    this.selectCurrent()
    return { handled: true, render: true }
  }

  // --- rendering ---------------------------------------------------------

  private statusText(): string {
    const all = this.itemsForProvider().length
    const shown = this.visibleModels.length
    const query = this.queryText().trim()
    const parts = [query === '' ? `${shown} model${shown === 1 ? '' : 's'}` : `${shown} of ${all} models`]
    if (this.selectedIndex >= 0 && shown > 0) parts.push(`${this.selectedIndex + 1}/${shown}`)
    if (this.currentProvider !== undefined || this.currentModel !== undefined) {
      parts.push(`current ${sanitize(this.currentProvider ?? '-')}/${sanitize(this.currentModel ?? '-')}`)
    }
    if (this.providers.length > 0) parts.push(`provider ${this.providerIndex + 1}/${this.providers.length}`)
    return parts.join(' · ')
  }

  private baseOptions(): ModalFrameOptions {
    return {
      title: 'Choose model',
      ownerKey: this.ownerKey(),
      actions: [
        { id: 'provider-previous', label: 'Provider', action: PROVIDER_PREVIOUS, onActivate: () => this.switchProvider(-1), disabled: this.providers.length < 2 },
        { id: 'provider-next', label: 'Provider', action: PROVIDER_NEXT, onActivate: () => this.switchProvider(1), disabled: this.providers.length < 2 },
        { id: 'select', label: 'Select', action: 'list.select', onActivate: () => this.selectCurrent(), disabled: this.visibleModels.length === 0 },
        { id: 'cancel', label: 'Cancel', action: 'list.cancel', onActivate: () => this.cancel() },
      ],
      onClose: () => this.cancel(),
      maxHeight: modalHeight(this.tui, this.modalSize),
      keymap: this.keymap,
    }
  }

  /** Provider groups and the one query field, both frame chrome lines. */
  private chromeLines(bodyWidth: number): string[] {
    const lines: string[] = []
    const tabs = providerTabs(this.providers, this.providerIndex, bodyWidth)
    if (tabs !== undefined) lines.push(fit(tabs, bodyWidth))
    const prefix = ` ${dim('Search')} `
    const fieldWidth = Math.max(4, bodyWidth - visibleWidth(prefix))
    const field = windowQueryLines(
      this.search.render(fieldWidth, this.focusedState && this.mode === 'search', 'Type to filter models'),
      MAX_QUERY_ROWS,
    )
    field.forEach((line, index) => {
      const lead = index === 0 ? prefix : ' '.repeat(visibleWidth(prefix))
      lines.push(fit(lead + line, bodyWidth))
    })
    lines.push('')
    return lines
  }

  private body(bodyWidth: number, bodyHeight: number): BodyPaint {
    if (this.errorState !== undefined) {
      const lines = wrap(this.errorState, Math.max(4, bodyWidth)).map(line => ` ${cc.error(fit(line, Math.max(4, bodyWidth)))}`)
      const remaining = Math.max(1, bodyHeight - lines.length - 1)
      const rows = this.visibleModels.length === 0
        ? textPaint(this.stateLines(bodyWidth))
        : windowRowsWithHits(this.blocks(bodyWidth), remaining)
      return concatPaint([textPaint(lines), textPaint(['']), rows])
    }
    if (this.visibleModels.length === 0) return textPaint(this.stateLines(bodyWidth))
    return windowRowsWithHits(this.blocks(bodyWidth), bodyHeight)
  }

  private blocks(bodyWidth: number): RowBlock[] {
    return modelBlocks(this.visibleModels, this.selectedIndex, bodyWidth, (item) =>
      this.currentProvider !== undefined &&
      this.currentModel !== undefined &&
      item.provider === this.currentProvider &&
      item.model === this.currentModel,
    )
  }

  /**
   * Honest distinct states: a pending native catalog, an empty catalog and a
   * query with no match never share a sentence.
   */
  private stateLines(width: number): string[] {
    const safeWidth = Math.max(4, width - 2)
    if (this.loadingState && this.providers.length === 0) return [` ${t.muted(fit('Loading models…', safeWidth))}`]
    if (this.providers.length === 0) return [` ${t.muted(fit('No models are available.', safeWidth))}`]
    const query = oneLine(sanitize(this.queryText().trim()), 40)
    const message = `No models match "${query}" in ${providerLabel(this.providers[this.providerIndex] ?? '')}.`
    return wrap(message, safeWidth).map(line => ` ${t.muted(fit(line, safeWidth))}`)
  }

  render(width: number): string[] {
    const base = this.baseOptions()
    // The framed body width is independent of the chrome content, so measure
    // once for the chrome and let the second measure (with `before`) supply the
    // body height that is actually left.
    const bodyWidth = this.frame.measure(width, base).bodyWidth
    const options: ModalFrameOptions = {
      ...base,
      before: this.chromeLines(bodyWidth),
      after: [fit(` ${t.subtle(this.statusText())}`, bodyWidth)],
    }
    const painted = renderModalBody(this.frame, width, options, (innerWidth, bodyHeight) => this.body(innerWidth, bodyHeight))
    this.hits = painted.paint.hits
    return painted.lines
  }
}
