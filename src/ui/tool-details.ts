/**
 * Read-only tool call inspector (Input / Output) on the shared modal chrome.
 *
 * DSH owns the tool call and its result. This surface only presents the
 * projected `ToolTranscriptItem`; it never executes, retries or rewrites a
 * tool, never reads a path/URL/body, never edits the prompt and never persists
 * anything. The parent mounts one instance as an overlay (inline and fullscreen
 * composites both support overlays), owns closing/disposal and the actual
 * clipboard write.
 *
 * Contract (options are additive; older hosts keep working):
 *
 *   new ToolDetailsDialog(tui, {
 *     tool, section?, keymap,
 *     onClose, onInterrupt?, onCopy, onRenderRequest?,
 *     getToolNavigation?, onPreviousTool?, onNextTool?,
 *     onImageDetails?,
 *     getTools?, onSelectTool?,   // optional wide metadata call list
 *     maxHeight?,
 *   })
 *
 * - `tool` is the projected call. `setTool` applies an update of the *same*
 *   callId (live stream → durable result) without losing the selected section,
 *   the per-section scroll position or the find/wrap state. A different callId
 *   is the inspector moving between real calls: the focused section is kept,
 *   both scroll positions reset, in-flight copy feedback is invalidated, and
 *   `onClose` is never called by this component.
 * - `getTools`/`onSelectTool` are metadata navigation only: the list shows
 *   already-projected calls and a selection asks the parent to show that call.
 *   Nothing is re-run, and no file/URL/body is read. Without both callbacks the
 *   wide list is not offered at all (no ghost list, no invented calls).
 * - `onCopy(text)` receives the complete Input/Output source (no preview line
 *   cap, no 8k/16k truncation, no wrapped/truncated display text). A failure is
 *   reported inside the panel only.
 *
 * Chrome (title, close, action chips, measured body budget) comes from the
 * shared `ModalFrame`; this component only paints the body: section tabs,
 * optional call list, image chips and the Input/Output window. Chrome/actions
 * are rebuilt for every frame, so geometry stays in sync with the live size.
 *
 * Input is resolved through the shared `CcKeymap` in the `toolDetails` context
 * (`toolDetails → list → dialog → global`, no editor fallback):
 *
 *   tool.details.next-section / previous-section  Input ↔ Output
 *   tool.details.copy                            copy the focused section
 *   modal.search                                 focus the CC find field
 *   tool.details.toggle-calls                    show/hide the wide call list
 *   tool.details.wrap                            wrap / clip long lines
 *   list.previous/next/page-up/page-down/first/last  scroll (or list cursor)
 *   list.select                                  select a call in the call list
 *   tool.details.previous-tool / next-tool       parent-owned earlier/later call
 *   list.cancel / dialog.cancel / app.cancel     clear find, else close
 *   app.interrupt                                parent's turn interrupt (else close)
 *
 * The find field is a real field (one `InlineAnswer`/`CcEditor`, shared keymap):
 * typing, word vs whitespace deletion, kill/yank, undo and paste use the CC
 * grammar. Esc in the field clears the query and returns to browsing; Enter
 * keeps the query. Everything else stays inert on purpose, so a remapped or
 * disabled modal action never falls through to permission cycling, tool
 * expansion or a hidden editor.
 *
 * Text is shown preformatted (never Markdown-lexed per frame). Sources, wrapped
 * lines and filter counts are cached per tool version and width, with only the
 * visible window sliced out, so a >8k Input / >16k Output stays fully reachable
 * by scrolling without a per-frame re-wrap. Scrolling state is independent per
 * section, and the scrollbar is a plain line-range readout rather than a raw
 * terminal escape parser.
 */
import {
  CURSOR_MARKER,
  ScrollView,
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '#pi-tui'
import type { ToolTranscriptItem } from '../state/transcript.ts'
import {
  BRACKETED_PASTE_START,
  createCcKeymap,
  formatBinding,
  printableInput,
  type CcKeymap,
} from '../input/index.ts'
import { SearchField } from './inspector-search.ts'
import { HitboxRegistry, type MouseHitbox } from './mouse.ts'
import { ModalFrame, type ModalAction, type ModalFrameOptions, type ModalGeometry, type ModalSize } from './modal.ts'
import { fit, oneLine, sanitize, visibleWidth, wrap } from './text.ts'
import { bold, cc, dim, t } from './theme.ts'
import { formatToolDuration, toolCopyText, toolDisplayName, toolInputText, toolOutputText } from './tool-io.ts'
import { toolImageOccurrences, type ImageOccurrence } from './image-data.ts'
import type { ImageDetailsRequest } from './image-view.ts'
import type { ToolIoSection } from './tool-view.ts'

export interface ToolDetailsDialogOptions {
  /** Projected call/result view. DSH remains the only source of truth. */
  tool: ToolTranscriptItem
  /** Initially focused section; `input` when omitted. */
  section?: ToolIoSection
  /** Shared keymap from the input subsystem (defaults to a CC keymap). */
  keymap: CcKeymap
  /** Local dismissal (Esc / list.cancel). Parent hides and disposes. */
  onClose: () => void
  /**
   * Global turn cancellation (`app.interrupt`, Ctrl+C by default). When
   * omitted the interrupt key closes this surface through `onClose`.
   */
  onInterrupt?: () => void
  /**
   * Native clipboard (or test injection) receives the complete source text of
   * the focused section. Never called with a preview/truncated copy.
   */
  onCopy: (text: string) => void | Promise<void>
  /** Optional repaint hook for hosts that own rendering (e.g. a viewport). */
  onRenderRequest?: () => void
  /**
   * Parent-owned position of this call among the session's real tool calls.
   * Read on every render (never cached), so the toolbar count follows the store
   * and boundary controls stay truthful. 0-based `index`.
   */
  getToolNavigation?: () => { index: number; total: number }
  /** Parent-owned previous-call navigation (already past the left boundary). */
  onPreviousTool?: () => void
  /** Parent-owned next-call navigation (already past the right boundary). */
  onNextTool?: () => void
  /**
   * Read-only metadata list for the wide call-list column. Already-projected
   * calls only: this component never reads a tool, path, URL or result body.
   */
  getTools?: () => readonly ToolTranscriptItem[]
  /**
   * Ask the parent to show another real call (`metadata only`). The parent owns
   * ordering, live updates and the actual `setTool`; this component never
   * re-runs anything.
   */
  onSelectTool?: (callId: string) => void
  /**
   * Open the separate image viewer for one tool-result occurrence. The parent
   * keeps this tool overlay mounted underneath and restores it on close, so the
   * section/scroll position survives. Without this callback the Output surface
   * stays text-only and advertises no image affordance.
   */
  onImageDetails?: (request: ImageDetailsRequest) => void
  /**
   * Optional frame height cap (the parent usually passes the shared modal
   * height). The default derives the cap from `tui.terminal.rows`.
   */
  maxHeight?: number
}

const SECTIONS: readonly ToolIoSection[] = ['input', 'output']

const CLOSE_ACTIONS: ReadonlySet<string> = new Set(['list.cancel', 'dialog.cancel', 'app.cancel'])

/** Below this body width the call list would leave no usable content column. */
const MIN_CALL_LIST_WIDTH = 56
const CALL_LIST_MAX_WIDTH = 34
const CALL_LIST_MIN_WIDTH = 16

const errorText = (error: unknown): string => sanitize(error instanceof Error ? error.message : String(error))

/** Honest source-line count; whitespace-only text is no content at all. */
function lineCount(text: string): number {
  return text.trim() === '' ? 0 : text.replace(/\n+$/, '').split('\n').length
}

/** Split a source body into display lines; trailing newlines are not content. */
function sourceLines(text: string): string[] {
  return text.trim() === '' ? [] : text.replace(/\n+$/, '').split('\n')
}

/** Pad a styled line to `width` columns without breaking its escape codes. */
function padEnd(line: string, width: number): string {
  const used = visibleWidth(line)
  return used >= width ? line : line + ' '.repeat(width - used)
}

/** Frame position of this call among the session's real calls. */
interface NavPosition {
  readonly index: number
  readonly total: number
  readonly previous: boolean
  readonly next: boolean
}

/** Optional wide metadata call list for one frame. */
interface CallListPlan {
  readonly tools: readonly ToolTranscriptItem[]
  readonly cursor: number
  readonly leftWidth: number
  readonly rightWidth: number
}

interface CallListPaint {
  readonly lines: string[]
  readonly hits: Array<MouseHitbox | undefined>
}

/** Cached wrap of one section: source lines plus their display rows. */
interface WrappedSection {
  readonly callId: string
  readonly version: number
  readonly width: number
  readonly wrapped: boolean
  readonly raw: string[]
  readonly rows: string[][]
}

/**
 * Read-only Input/Output inspector. `Component` + `Focusable`; the parent
 * mounts it with a bounded overlay and calls `dispose()` after hiding it.
 */
export class ToolDetailsDialog implements Component, Focusable {
  readonly capturesViewportInput = true
  /** Parent-generic dialog hosting uses the wider content size. */
  readonly modalSize: ModalSize = 'wide'
  readonly keymap: CcKeymap
  private readonly tui: TUI
  private readonly options: ToolDetailsDialogOptions
  private readonly frame = new ModalFrame()
  private readonly search: SearchField
  private readonly registry = new HitboxRegistry()
  /** Scroll state uses the public ScrollView semantics (`scrollTop` range). */
  private readonly scrollViews: Record<ToolIoSection, ScrollView>
  private readonly scrollChild = new SectionBody()
  private tool: ToolTranscriptItem
  private currentSection: ToolIoSection
  private focusedState = false
  private done = false
  private disposed = false
  private chordPending = false
  /** Cancels async copy feedback after dispose or a different call. */
  private generation = 0
  private message = ''
  private messageFailed = false
  private hovered: string | undefined
  /** `content` browses/scolls, `search` types in the find field, `calls` picks. */
  private focus: 'content' | 'calls' | 'search' = 'content'
  private wrapEnabled = true
  private callsEnabled = false
  private callCursor = 0
  /** Call already requested from the parent; suppresses a double submit until setTool applies it. */
  private pendingCallId: string | undefined
  private readonly queries: Record<ToolIoSection, string> = { input: '', output: '' }
  private readonly viewportHeights: Record<ToolIoSection, number> = { input: 0, output: 0 }
  private readonly maxScrollTops: Record<ToolIoSection, number> = { input: 0, output: 0 }
  private sourceCache: {
    callId: string
    version: number
    input: string
    output: string
    inputLines: number
    outputLines: number
  } | undefined
  private readonly wrappedCache = new Map<ToolIoSection, WrappedSection>()
  private matchCache: { key: string; total: number; matched: number | undefined } | undefined
  /** Last measured terminal width; wide-only affordances stay honest at narrow sizes. */
  private lastWidth = 100

  constructor(tui: TUI, options: ToolDetailsDialogOptions) {
    this.tui = tui
    this.options = options
    this.tool = options.tool
    this.currentSection = options.section ?? 'input'
    this.keymap = options.keymap ?? createCcKeymap()
    this.search = new SearchField({
      tui,
      keymap: this.keymap,
      onChange: () => this.handleQueryChange(),
    })
    this.scrollViews = {
      input: new ScrollView(this.scrollChild, { scrollbar: 'auto' }),
      output: new ScrollView(this.scrollChild, { scrollbar: 'auto' }),
    }
  }

  // -------------------------------------------------------------------------
  // State accessors (parent/tests)

  /** The currently projected tool item. */
  get currentTool(): ToolTranscriptItem {
    return this.tool
  }

  get section(): ToolIoSection {
    return this.currentSection
  }

  /** Per-section scroll offset (wrapped-line units). */
  scrollTop(section: ToolIoSection = this.currentSection): number {
    return this.scrollViews[section].scrollTop
  }

  maxScrollTop(section: ToolIoSection = this.currentSection): number {
    return this.maxScrollTops[section]
  }

  /** Last copy/close feedback text; failures stay inside the panel. */
  get notice(): string {
    return this.message
  }

  get noticeFailed(): boolean {
    return this.messageFailed
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
    if (!value) {
      this.releaseOwnChord()
      this.search.focused = false
    } else if (this.focus === 'search') {
      this.search.focused = true
    }
    this.focusedState = value
  }

  /** Live find query of the focused section (trimmed). */
  get searchQuery(): string {
    return this.queries[this.currentSection]
  }

  /** True while the find field owns the keyboard. */
  get searchFocused(): boolean {
    return this.focus === 'search'
  }

  /** True when long lines wrap instead of being clipped to the column. */
  get wraps(): boolean {
    return this.wrapEnabled
  }

  /** True when the wide metadata call list is requested (see render width). */
  get callsShown(): boolean {
    return this.callsEnabled
  }

  /** Currently highlighted call in the metadata list (callId). */
  selectedCallId(): string | undefined {
    const tools = this.callListTools()
    if (tools === undefined) return undefined
    return tools[Math.max(0, Math.min(this.callCursor, tools.length - 1))]?.callId
  }

  /**
   * Parent/test helper: measure the frame for a width with the current state.
   * Geometry always comes from the same options used for `render`.
   */
  measure(width: number): ModalGeometry {
    return this.layoutFor(Math.max(1, Math.floor(width))).geometry
  }

  /** Parent hook for focus changes; only this instance's chord is released. */
  cancelChord(): void {
    this.releaseOwnChord()
  }

  invalidate(): void {
    this.sourceCache = undefined
    this.wrappedCache.clear()
    this.matchCache = undefined
    this.search.invalidate()
    this.frame.invalidate()
    this.requestRender()
  }

  // -------------------------------------------------------------------------
  // Updates / lifecycle

  /**
   * Apply the same call's newer projection (live → durable result). Section,
   * scroll, find query and wrap state are preserved; content caches refresh on
   * the version token only.
   *
   * A different callId is the inspector navigating to another real call. The
   * selected Input/Output section is kept (the reader stays in the same mental
   * place), both scroll positions reset to the top, and any in-flight copy
   * feedback from the old call is invalidated. `onClose` is never called here;
   * the parent owns closing.
   */
  setTool(next: ToolTranscriptItem): void {
    if (this.disposed) return
    const differentCall = next.callId !== this.tool.callId
    this.tool = next
    if (differentCall) {
      this.generation += 1
      this.scrollViews.input.scrollTo(0)
      this.scrollViews.output.scrollTo(0)
      this.maxScrollTops.input = 0
      this.maxScrollTops.output = 0
      this.hovered = undefined
      this.message = ''
      this.messageFailed = false
      this.pendingCallId = undefined
      this.callCursor = this.currentCallIndex() ?? this.callCursor
    }
    this.sourceCache = undefined
    this.wrappedCache.clear()
    this.matchCache = undefined
    this.requestRender()
  }

  /**
   * Idempotent teardown: release this modal's own chord, the find field and
   * hitboxes only. Never calls `onClose` and never changes focus, so a parent
   * can dispose an unselected/stale surface without disturbing the editor.
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.releaseOwnChord()
    this.hovered = undefined
    this.registry.clear()
    this.wrappedCache.clear()
    this.sourceCache = undefined
    this.matchCache = undefined
    this.search.dispose()
  }

  // -------------------------------------------------------------------------
  // Input

  handleInput(raw: string): void {
    if (this.done || this.disposed || raw.length === 0) return
    // While the find field owns input, it owns the keymap decisively: resolving
    // a browse action first would mutate a shared chord (for example Ctrl+X)
    // and steal the field's ordinary readline behavior.
    if (this.focus === 'search') {
      this.forwardToSearch(raw)
      return
    }
    const resolution = this.keymap.resolve(raw, 'toolDetails')
    if (resolution.kind === 'pending') {
      this.chordPending = true
      return
    }
    if (resolution.kind === 'cancelled-chord') {
      this.chordPending = false
      // The passthrough byte is fresh input in this modal (or find field).
      this.routeFresh(resolution.passthrough, undefined)
      return
    }
    this.chordPending = false
    this.routeFresh(raw, resolution.kind === 'action' ? resolution.action.id : undefined)
  }

  /**
   * One routing decision for a fresh byte: the find field owns printable text
   * and editing keys, modal actions own navigation. Anything without an action
   * in this context stays inert (no editor fallthrough).
   */
  private routeFresh(raw: string, actionId: string | undefined): void {
    if (this.focus === 'search') {
      const text = printableInput(raw) !== undefined || raw.startsWith(BRACKETED_PASTE_START)
      if (text) {
        this.forwardToSearch(raw)
        return
      }
      if (actionId !== undefined && (
        actionId === 'app.interrupt' ||
        actionId === 'list.select' ||
        CLOSE_ACTIONS.has(actionId)
      )) {
        this.dispatch(actionId)
        return
      }
      // Everything else belongs to the field: CC editing keys (Ctrl+F char-right,
      // Ctrl+W whitespace kill, kill/yank, undo, boundaries) and printable text.
      // Browse-only actions (find toggle, wrap, calls) never fire while typing.
      this.forwardToSearch(raw)
      return
    }
    if (actionId === undefined) return
    this.dispatch(actionId)
  }

  private forwardToSearch(raw: string): void {
    const result = this.search.handleKey(raw)
    switch (result) {
      case 'confirm':
        this.leaveSearch()
        return
      case 'cancel':
        this.clearSearch()
        return
      case 'interrupt':
        this.interruptOrClose()
        return
      case 'up':
      case 'down':
      case 'tab':
        this.leaveSearch()
        return
      default:
        this.requestRender()
        return
    }
  }

  /**
   * Only the contract actions act. Any other global fallback (Ctrl+O expand,
   * Shift+Tab permission cycle, todos, …) stays inert inside this modal.
   */
  private dispatch(id: string): void {
    if (CLOSE_ACTIONS.has(id)) {
      // Inside the field, Esc cancels the find state instead of the inspector.
      if (this.focus === 'search') this.clearSearch()
      else this.close()
      return
    }
    switch (id) {
      case 'app.interrupt':
        this.interruptOrClose()
        return
      case 'modal.search':
        this.toggleSearch()
        return
      case 'tool.details.next-section':
      case 'tool.details.previous-section':
        this.selectSection(this.currentSection === 'input' ? 'output' : 'input')
        return
      case 'tool.details.toggle-calls':
        this.toggleCalls()
        return
      case 'tool.details.wrap':
        this.toggleWrap()
        return
      case 'tool.details.copy':
        void this.copy()
        return
      case 'app.images.details': {
        const first = this.imageOccurrences()[0]
        if (first !== undefined) this.openImage(first.key)
        return
      }
      case 'tool.details.previous-tool':
        this.navigateTool('previous')
        return
      case 'tool.details.next-tool':
        this.navigateTool('next')
        return
      case 'list.select':
        if (this.focus === 'search') this.leaveSearch()
        else if (this.focus === 'calls') this.selectCallCursor()
        return
      case 'list.first':
        if (this.focus === 'calls') this.moveCallCursor('first')
        else this.setScroll(this.currentSection, 0)
        return
      case 'list.last':
        if (this.focus === 'calls') this.moveCallCursor('last')
        else this.setScroll(this.currentSection, this.maxScrollTops[this.currentSection])
        return
      case 'list.previous':
        if (this.focus === 'calls') this.moveCallCursor('previous')
        else this.scrollBy(-1)
        return
      case 'list.next':
        if (this.focus === 'calls') this.moveCallCursor('next')
        else this.scrollBy(1)
        return
      case 'list.page-up':
        if (this.focus === 'calls') this.moveCallCursor('page-up')
        else this.scrollBy(-this.pageSize())
        return
      case 'list.page-down':
        if (this.focus === 'calls') this.moveCallCursor('page-down')
        else this.scrollBy(this.pageSize())
        return
      default:
        // Deliberately inert: no editor fallthrough in this context and no
        // unrelated global app action may run from a read-only inspector.
        return
    }
  }

  private interruptOrClose(): void {
    if (this.options.onInterrupt !== undefined) this.options.onInterrupt()
    else this.close()
  }

  private pageSize(): number {
    return Math.max(1, this.viewportHeights[this.currentSection] - 1)
  }

  private setScroll(section: ToolIoSection, value: number): void {
    this.scrollViews[section].scrollTo(value)
    this.requestRender()
  }

  private scrollBy(lines: number): void {
    const section = this.currentSection
    this.scrollViews[section].scrollBy(lines)
    this.requestRender()
  }

  private close(): void {
    if (this.done || this.disposed) return
    this.done = true
    this.releaseOwnChord()
    this.search.focused = false
    this.options.onClose()
  }

  // -------------------------------------------------------------------------
  // Find field

  private toggleSearch(): void {
    if (this.focus === 'search') {
      this.leaveSearch()
      return
    }
    this.focus = 'search'
    this.search.setText(this.queries[this.currentSection])
    this.search.focused = this.focusedState
    this.requestRender()
  }

  /** Keep the query and return to browsing (Enter / find toggle). */
  private leaveSearch(): void {
    this.queries[this.currentSection] = this.search.query
    this.queries[this.currentSection] = this.queries[this.currentSection].trim()
    this.search.focused = false
    this.focus = 'content'
    this.requestRender()
  }

  /** Drop the query and return to browsing (Esc in the field). */
  private clearSearch(): void {
    this.queries[this.currentSection] = ''
    this.search.clear()
    this.search.focused = false
    this.focus = 'content'
    this.matchCache = undefined
    this.requestRender()
  }

  private handleQueryChange(): void {
    this.queries[this.currentSection] = this.search.query.trim()
    this.matchCache = undefined
    // A new query is a new reading position in the filtered lines.
    this.scrollViews[this.currentSection].scrollTo(0)
    this.requestRender()
  }

  private selectSection(next: ToolIoSection): void {
    if (next === this.currentSection) return
    if (this.focus === 'search') this.queries[this.currentSection] = this.search.query.trim()
    this.currentSection = next
    if (this.focus === 'search') {
      this.search.setText(this.queries[next])
      this.search.focused = this.focusedState
    }
    this.requestRender()
  }

  private toggleWrap(): void {
    this.wrapEnabled = !this.wrapEnabled
    // Display rows change with the wrap mode; sources and scroll state stay.
    this.scrollViews[this.currentSection].scrollTo(0)
    this.requestRender()
  }

  // -------------------------------------------------------------------------
  // Call list (metadata only)

  private readTools(): readonly ToolTranscriptItem[] | undefined {
    const read = this.options.getTools
    if (read === undefined) return undefined
    let value: readonly ToolTranscriptItem[]
    try {
      value = read()
    } catch {
      return undefined
    }
    if (!Array.isArray(value)) return undefined
    return value.filter(item => item !== null && typeof item === 'object' && item.kind === 'tool')
  }

  /**
   * True when this host could offer the wide call list at this width. Narrow
   * terminals use the existing Prev/Next call switching instead of a list that
   * would leave no content column.
   */
  private callListOffered(): boolean {
    if (this.lastWidth < MIN_CALL_LIST_WIDTH) return false
    if (this.options.onSelectTool === undefined || this.options.getTools === undefined) return false
    const tools = this.readTools()
    return tools !== undefined && tools.length > 1
  }

  private callListTools(): readonly ToolTranscriptItem[] | undefined {
    if (!this.callsEnabled) return undefined
    const tools = this.readTools()
    return tools !== undefined && tools.length > 1 ? tools : undefined
  }

  private callList(width: number): CallListPlan | undefined {
    const tools = this.callListTools()
    if (tools === undefined) return undefined
    if (width < MIN_CALL_LIST_WIDTH) return undefined
    const leftWidth = Math.max(CALL_LIST_MIN_WIDTH, Math.min(CALL_LIST_MAX_WIDTH, Math.floor(width * 0.32)))
    const rightWidth = width - leftWidth - 2
    if (rightWidth < 10) return undefined
    const current = this.currentCallIndex() ?? 0
    if (this.callCursor < 0 || this.callCursor >= tools.length) this.callCursor = current
    return { tools, cursor: this.callCursor, leftWidth, rightWidth }
  }

  private currentCallIndex(): number | undefined {
    const tools = this.readTools()
    if (tools === undefined) return undefined
    const index = tools.findIndex(item => item.callId === this.tool.callId)
    return index < 0 ? undefined : index
  }

  private toggleCalls(): void {
    if (!this.callListOffered()) return
    this.callsEnabled = !this.callsEnabled
    if (this.callsEnabled) {
      this.focus = 'calls'
      this.callCursor = this.currentCallIndex() ?? 0
    } else if (this.focus === 'calls') {
      this.focus = 'content'
    }
    this.requestRender()
  }

  private moveCallCursor(direction: 'previous' | 'next' | 'first' | 'last' | 'page-up' | 'page-down'): void {
    const tools = this.callListTools() ?? this.readTools()
    if (tools === undefined || tools.length === 0) return
    const step = Math.max(1, Math.min(10, this.viewportHeights[this.currentSection] - 1))
    const current = Math.max(0, Math.min(this.callCursor, tools.length - 1))
    const next = direction === 'first' ? 0
      : direction === 'last' ? tools.length - 1
        : direction === 'previous' ? current - 1
          : direction === 'next' ? current + 1
            : direction === 'page-up' ? current - step
              : current + step
    const clamped = Math.max(0, Math.min(tools.length - 1, next))
    if (clamped === this.callCursor) return
    this.callCursor = clamped
    this.requestRender()
  }

  private selectCallCursor(): void {
    const select = this.options.onSelectTool
    const tools = this.readTools()
    if (select === undefined || tools === undefined || tools.length === 0) return
    const index = Math.max(0, Math.min(this.callCursor, tools.length - 1))
    const callId = tools[index]?.callId
    if (callId === undefined) return
    this.requestCall(select, callId)
  }

  /**
   * Ask the parent to show one already-projected call exactly once. A repeated
   * Enter/click on the same row is inert until the parent applies `setTool`
   * (which clears the pending id), so one gesture never becomes two opens and
   * no tool is re-run.
   */
  private requestCall(select: (callId: string) => void, callId: string): void {
    if (callId === this.tool.callId || callId === this.pendingCallId) return
    this.pendingCallId = callId
    select(callId)
  }

  /**
   * Live navigation state. The getter is called every frame so a shrinking or
   * growing tool list updates the count and boundary state without a cached
   * snapshot. A malformed/empty position hides the controls instead of
   * inventing one. Without `getToolNavigation` the projected call list provides
   * the same metadata.
   */
  private navigation(): NavPosition | undefined {
    const read = this.options.getToolNavigation
    if (read !== undefined) {
      let position: { index: number; total: number } | undefined
      try {
        position = read()
      } catch {
        return undefined
      }
      if (position === null || typeof position !== 'object') return undefined
      const totalValue = Number(position.total)
      const indexValue = Number(position.index)
      if (!Number.isFinite(totalValue) || totalValue <= 0) return undefined
      const total = Math.floor(totalValue)
      const index = Math.min(Math.max(0, Number.isFinite(indexValue) ? Math.floor(indexValue) : 0), total - 1)
      return {
        index,
        total,
        previous: index > 0 && this.options.onPreviousTool !== undefined,
        next: index < total - 1 && this.options.onNextTool !== undefined,
      }
    }
    const tools = this.readTools()
    const select = this.options.onSelectTool
    if (tools === undefined || select === undefined) return undefined
    const index = tools.findIndex(item => item.callId === this.tool.callId)
    if (index < 0 || tools.length === 0) return undefined
    return {
      index,
      total: tools.length,
      previous: index > 0 && (this.options.onPreviousTool !== undefined || select !== undefined),
      next: index < tools.length - 1 && (this.options.onNextTool !== undefined || select !== undefined),
    }
  }

  /**
   * Parent owns call ordering. A boundary or missing callback is inert; the
   * position is re-read here so a stale mouse row can never navigate twice or
   * past the end. Without an explicit previous/next callback the projected call
   * list is used (metadata only).
   */
  private navigateTool(direction: 'previous' | 'next'): void {
    if (this.disposed) return
    const nav = this.navigation()
    if (nav === undefined) return
    if (direction === 'previous' ? !nav.previous : !nav.next) return
    const callback = direction === 'previous' ? this.options.onPreviousTool : this.options.onNextTool
    if (callback !== undefined) {
      callback()
      return
    }
    const tools = this.readTools()
    const select = this.options.onSelectTool
    if (tools === undefined || select === undefined) return
    const index = tools.findIndex(item => item.callId === this.tool.callId)
    const target = tools[index + (direction === 'previous' ? -1 : 1)]
    if (target === undefined) return
    this.callCursor = index + (direction === 'previous' ? -1 : 1)
    this.requestCall(select, target.callId)
  }

  /**
   * Copy the complete focused source through the parent's clipboard hook.
   * Feedback is panel-local and dropped when this instance was disposed or the
   * parent switched to a different call while the write was in flight.
   */
  private async copy(): Promise<void> {
    if (this.disposed) return
    const generation = this.generation
    const section = this.currentSection
    let text: string
    try {
      text = toolCopyText(this.tool, section)
    } catch (error) {
      this.showNotice('Copy failed: ' + errorText(error), true, generation)
      return
    }
    try {
      await this.options.onCopy(text)
      if (!this.isCurrent(generation)) return
      this.showNotice(`Copied ${section} (${text.length} chars)`, false, generation)
    } catch (error) {
      if (!this.isCurrent(generation)) return
      this.showNotice('Copy failed: ' + errorText(error), true, generation)
    }
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation
  }

  private showNotice(text: string, failed: boolean, generation: number): void {
    if (!this.isCurrent(generation)) return
    this.message = sanitize(text)
    this.messageFailed = failed
    this.requestRender()
  }

  private releaseOwnChord(): void {
    if (!this.chordPending) return
    this.chordPending = false
    this.keymap.cancelChord()
  }

  private requestRender(): void {
    if (this.disposed) return
    this.options.onRenderRequest?.()
    this.tui.requestRender()
  }

  // -------------------------------------------------------------------------
  // Mouse

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    // Chrome (close/action chips) belongs to the shared frame.
    const chrome = this.frame.handleMouse(event)
    if (chrome !== undefined) return chrome
    const body = this.frame.bodyMouse(event)
    if (body === undefined) return undefined
    // Wheel routing scrolls the same public scroll state the keys use. Only
    // cells inside the body are consumed, so chrome/text outside keep their
    // native selection behaviour.
    if (body.type === 'wheel') {
      const delta = body.wheelDelta ?? 0
      if (delta === 0) return undefined
      this.scrollBy(delta)
      return { handled: true, render: true }
    }
    return this.registry.handleMouse(body)
  }

  // -------------------------------------------------------------------------
  // Content

  private sources(): { input: string; output: string; inputLines: number; outputLines: number } {
    const cache = this.sourceCache
    if (cache !== undefined && cache.callId === this.tool.callId && cache.version === this.tool.version) return cache
    let input: string
    let output: string
    try {
      input = sanitize(toolInputText(this.tool))
      output = sanitize(toolOutputText(this.tool))
    } catch (error) {
      input = ''
      output = 'Details could not be read: ' + errorText(error)
    }
    this.sourceCache = {
      callId: this.tool.callId,
      version: this.tool.version,
      input,
      output,
      inputLines: lineCount(input),
      outputLines: lineCount(output),
    }
    this.wrappedCache.clear()
    return this.sourceCache
  }

  private sectionText(section: ToolIoSection): string {
    const sources = this.sources()
    return section === 'input' ? sources.input : sources.output
  }

  /**
   * Source lines with their display rows, cached per call/version/width/wrap
   * mode. Only the visible window is sliced during render; the complete source
   * stays reachable by scrolling and copy.
   */
  private wrappedSection(section: ToolIoSection, width: number): WrappedSection {
    const text = this.sectionText(section)
    const cached = this.wrappedCache.get(section)
    if (
      cached !== undefined &&
      cached.callId === this.tool.callId &&
      cached.version === this.tool.version &&
      cached.width === width &&
      cached.wrapped === this.wrapEnabled
    ) return cached
    const raw = sourceLines(text)
    const column = Math.max(1, width)
    const rows = raw.map(line => this.wrapEnabled ? wrap(line, column) : [line])
    const next: WrappedSection = {
      callId: this.tool.callId,
      version: this.tool.version,
      width,
      wrapped: this.wrapEnabled,
      raw,
      rows,
    }
    this.wrappedCache.set(section, next)
    return next
  }

  /** Filtered display rows of the focused section for one content width. */
  private displayLines(section: ToolIoSection, width: number): { lines: string[]; total: number; matched: number | undefined } {
    const wrapped = this.wrappedSection(section, width)
    const query = this.queries[section].trim().toLowerCase()
    if (query === '') return { lines: wrapped.rows.flat(), total: wrapped.raw.length, matched: undefined }
    const lines: string[] = []
    let matched = 0
    wrapped.raw.forEach((line, index) => {
      if (!line.toLowerCase().includes(query)) return
      matched += 1
      lines.push(...wrapped.rows[index]!)
    })
    return { lines, total: wrapped.raw.length, matched }
  }

  /** Filter counts independent of the current content column width. */
  private matchCounts(section: ToolIoSection): { total: number; matched: number | undefined } {
    const query = this.queries[section].trim().toLowerCase()
    const key = `${section}|${this.tool.callId}|${this.tool.version}|${query}`
    if (this.matchCache?.key === key) {
      return { total: this.matchCache.total, matched: this.matchCache.matched }
    }
    const raw = sourceLines(this.sectionText(section))
    const matched = query === '' ? undefined : raw.filter(line => line.toLowerCase().includes(query)).length
    this.matchCache = { key, total: raw.length, matched }
    return { total: raw.length, matched }
  }

  /** Honest fallback when a section has no content (never a fake "Done"). */
  private emptyMessage(section: ToolIoSection): string {
    if (section === 'input') return 'No input recorded for this tool call.'
    switch (this.tool.status) {
      case 'proposed': return 'Proposed only — this tool has not run yet.'
      case 'running': return 'Running — no result yet.'
      case 'unknown': return 'Unknown — no result was received for this call.'
      case 'error': return this.errorSummary() ?? 'Failed with no output.'
      case 'done':
        return this.tool.resultImages > 0
          ? `No text output · ${this.tool.resultImages} image${this.tool.resultImages === 1 ? '' : 's'} attached.`
          : 'No output.'
      default: {
        const exhaustive: never = this.tool.status
        return String(exhaustive)
      }
    }
  }

  private errorSummary(): string | undefined {
    const error = this.tool.error
    if (error === undefined) return undefined
    const code = error.code === '' ? '' : ` (${oneLine(error.code, 40)})`
    const reason = error.reason === undefined ? '' : `: ${oneLine(error.reason, 160)}`
    return `Failed${code}${reason}`
  }

  /** Real image occurrences of the current tool result, in declared order. */
  private imageOccurrences(): readonly ImageOccurrence[] {
    return toolImageOccurrences(this.tool)
  }

  /** Explicit image entry; the parent owns the image overlay lifecycle. */
  private openImage(key: string): void {
    this.options.onImageDetails?.({ key })
  }

  // -------------------------------------------------------------------------
  // Rendering

  /**
   * Two-pass layout: the inner width sizes the find/status rows, then the final
   * options (the exact object passed to render) size the body budget. Both
   * `render` and the public `measure` use this, so mouse geometry can never
   * disagree with what was painted.
   */
  private layoutFor(size: number): { options: ModalFrameOptions; geometry: ModalGeometry } {
    const base = this.frameOptions(size)
    const first = this.frame.measure(size, base)
    const options: ModalFrameOptions = {
      ...base,
      before: this.beforeLines(first.bodyWidth),
      after: this.afterLines(first.bodyWidth),
    }
    return { options, geometry: this.frame.measure(size, options) }
  }

  render(width: number): string[] {
    if (this.disposed) return []
    const size = Math.max(1, Math.floor(width))
    this.lastWidth = size
    const { options, geometry } = this.layoutFor(size)
    const body = this.bodyLines(geometry.bodyWidth, geometry.bodyHeight)
    return this.frame.render(size, body, options)
  }

  private frameOptions(width: number): ModalFrameOptions {
    const nav = this.navigation()
    const name = oneLine(toolDisplayName(this.tool.name), 48)
    const subtitle = nav === undefined
      ? name
      : `${name} · ${nav.index + 1} / ${nav.total}`
    return {
      title: 'Tools',
      // Stable native identity: a press on a footer action must not act on a
      // different call or a different focused section after a repaint.
      ownerKey: `tool:${this.tool.callId}:${this.currentSection}`,
      subtitle,
      actions: this.frameActions(width),
      onClose: () => this.close(),
      maxHeight: this.heightFor(width),
      keymap: this.keymap,
    }
  }

  /**
   * Action chips read the effective keymap through the frame, so a remapped,
   * chord-only or disabled action changes (or removes) the advertised key
   * instead of printing a dead shortcut.
   */
  private frameActions(width: number): ModalAction[] {
    const copy: ModalAction = { id: 'copy', label: 'Copy', action: 'tool.details.copy', onActivate: () => { void this.copy() } }
    const closeAction: ModalAction = { id: 'close', label: 'Close', action: 'list.cancel', onActivate: () => this.close() }
    // The frame caps the footer at two rows. On a narrow terminal the shortcut
    // is still reachable (and hinted), so keep only the two essential actions
    // instead of silently dropping Close off the bottom.
    if (width < 40) return [copy, closeAction]
    const actions: ModalAction[] = [
      copy,
      closeAction,
      { id: 'find', label: 'Find', action: 'modal.search', onActivate: () => this.toggleSearch() },
    ]
    if (this.keymap.getBindings('tool.details.wrap').length > 0) {
      actions.push({
        id: 'wrap',
        label: this.wrapEnabled ? 'Wrap off' : 'Wrap on',
        action: 'tool.details.wrap',
        onActivate: () => this.toggleWrap(),
      })
    }
    if (this.callListOffered() && this.keymap.getBindings('tool.details.toggle-calls').length > 0) {
      actions.push({
        id: 'calls',
        label: this.callsEnabled ? 'Hide calls' : 'Calls',
        action: 'tool.details.toggle-calls',
        onActivate: () => this.toggleCalls(),
      })
    }
    return actions
  }

  private heightFor(width: number): number {
    void width
    const rows = this.tui.terminal.rows
    const terminalCap = Number.isFinite(rows) && rows > 0 ? Math.max(6, Math.floor(rows) - 2) : 24
    const configured = this.options.maxHeight
    const cap = configured !== undefined && Number.isFinite(configured) && configured > 0
      ? Math.max(6, Math.min(terminalCap, Math.floor(configured)))
      : terminalCap
    return Math.max(6, cap)
  }

  /** Find row(s): the one CC field, prefixed with a stable label. */
  private beforeLines(width: number): string[] {
    const inner = Math.max(1, width)
    const label = this.sectionLabel(this.currentSection).toLowerCase()
    const prefixText = 'Find: '
    const prefixWidth = Math.min(visibleWidth(prefixText), Math.max(1, inner - 1))
    const prefix = this.focus === 'search' ? cc.suggestion(prefixText) : dim(prefixText)
    const key = this.firstKeys('modal.search')
    const focusedPlaceholder = `filter ${label}…`
    const idlePlaceholder = key === undefined
      ? `search ${label} unavailable (no binding)`
      : `${key} to search ${label}`
    const rendered = this.search.render(
      Math.max(1, inner - prefixWidth),
      this.focus === 'search' ? focusedPlaceholder : idlePlaceholder,
      this.queries[this.currentSection],
    )
    if (rendered.length === 0) return [fit(prefix, inner)]
    const lines = rendered.map((line, index) => {
      if (index === 0) return prefix + line
      const cursor = line.includes(CURSOR_MARKER) ? ' ' : ' '.repeat(prefixWidth)
      return cursor + line
    })
    return lines.map(line => fit(line, inner))
  }

  /** Status + hint rows; the frame caps them by its own chrome budget. */
  private afterLines(width: number): string[] {
    const inner = Math.max(1, width)
    const sources = this.sources()
    const counts = this.matchCounts(this.currentSection)
    const filter = counts.matched === undefined
      ? ''
      : counts.matched === 0
        ? ` · no matching lines of ${counts.total}`
        : ` · ${counts.matched} of ${counts.total} lines match`
    const wrapState = this.wrapEnabled ? '' : ' · wrap off'
    const notice = this.message === '' ? '' : ` · ${this.message}`
    const summary = [
      this.statusLine(),
      dim(' · '),
      dim(`${sources.inputLines} in · ${sources.outputLines} out`),
      dim(filter + wrapState),
      notice === '' ? '' : this.messageFailed ? t.redSoft(notice) : dim(notice),
    ].join('')
    const hint = this.hintLine()
    const lines = [fit(' ' + summary, inner)]
    if (hint !== '') lines.push(fit(' ' + dim(hint), inner))
    return lines
  }

  /** Body rows: features on top, then the content window (optionally split). */
  private bodyLines(width: number, height: number): string[] {
    const rows = Math.max(0, Math.floor(height))
    const out: string[] = []
    const boxes: MouseHitbox[] = []
    if (rows === 0) {
      this.registry.sync([])
      return []
    }
    const nav = this.navigation()
    const images = this.section === 'output' && this.options.onImageDetails !== undefined
      ? this.imageOccurrences()
      : []
    const features = { nav: nav !== undefined, tabs: true, chips: images.length > 0 }
    const fixedRows = (): number => (features.nav ? 1 : 0) + (features.tabs ? 1 : 0) + (features.chips ? 1 : 0)
    while (fixedRows() >= rows && (features.chips || features.nav || features.tabs)) {
      if (features.chips) features.chips = false
      else if (features.nav) features.nav = false
      else features.tabs = false
    }
    const list = this.callList(width)
    const contentRows = Math.max(1, rows - fixedRows())
    const contentWidth = list === undefined ? width : list.rightWidth
    let row = 0
    if (features.nav) {
      this.paintNav(out, boxes, row, width, nav!)
      row += 1
    }
    if (features.tabs) {
      this.paintTabs(out, boxes, row, width)
      row += 1
    }
    if (features.chips) {
      this.paintChips(out, boxes, row, width, images)
      row += 1
    }
    const content = this.contentWindow(contentWidth, contentRows)
    if (list === undefined) {
      for (const line of content) {
        out.push(fit(' ' + line, width))
        row += 1
      }
    } else {
      const painted = this.paintCallList(list, contentRows)
      for (let index = 0; index < contentRows; index += 1) {
        const left = painted.lines[index] ?? ''
        const right = content[index] ?? ''
        out.push(fit(padEnd(left, list.leftWidth) + dim('│') + ' ' + right, width))
        const hit = painted.hits[index]
        if (hit !== undefined) {
          boxes.push({ ...hit, startRow: row, endRow: row, startCol: 0, endCol: list.leftWidth - 1 })
        }
        row += 1
      }
    }
    while (out.length < rows) out.push('')
    this.registry.sync(boxes)
    return out
  }

  /** Visible Input/Output window for the current width and row budget. */
  private contentWindow(width: number, rows: number): string[] {
    const section = this.currentSection
    const column = Math.max(1, width - 1)
    const text = this.sectionText(section)
    const display = this.displayLines(section, column)
    const query = this.queries[section].trim()
    let lines: string[]
    if (text.trim() === '') {
      lines = [dim(t.muted(this.emptyMessage(section)))]
    } else if (display.lines.length === 0) {
      lines = [dim(t.muted(query === '' ? 'No content.' : `No lines match "${oneLine(query, 80)}" (${display.total} lines).`))]
    } else if (this.wrapEnabled) {
      lines = display.lines.map(line => t.text(line))
    } else {
      lines = display.lines.map(line => t.text(fit(line, column)))
    }
    const maxScroll = Math.max(0, lines.length - rows)
    this.maxScrollTops[section] = maxScroll
    this.viewportHeights[section] = rows
    const view = this.scrollViews[section]
    view.updateLayout(lines.length, rows, () => this.requestRender())
    if (view.scrollTop > maxScroll) view.scrollTo(maxScroll)
    const top = Math.min(view.scrollTop, maxScroll)
    const visible = lines.slice(top, top + rows)
    while (visible.length < rows) visible.push('')
    return visible
  }

  /**
   * `Tool 3 / 12   [Prev] [Next]` (or compact `‹`/`›` when narrow).
   *
   * Boundary controls render dim with no hitbox, so a press there never claims
   * the gesture or fires a navigation. IDs are stable across frames; the click
   * handler re-reads the live position and asks the parent exactly once.
   */
  private paintNav(out: string[], boxes: MouseHitbox[], row: number, width: number, nav: NavPosition): void {
    const compact = width < 32
    const label = `Tool ${nav.index + 1} / ${nav.total}`
    const parts: string[] = [` ${dim(label)}`]
    const pending: Array<{ id: 'nav-prev' | 'nav-next'; direction: 'previous' | 'next'; startCol: number; endCol: number }> = []
    let used = 1 + visibleWidth(label)
    const addButton = (id: 'nav-prev' | 'nav-next', text: string, enabled: boolean, direction: 'previous' | 'next'): void => {
      const rawWidth = visibleWidth(text) + 2
      const startCol = used + 1
      const hovered = this.hovered === id
      parts.push(' ')
      if (enabled) {
        parts.push(dim('[') + (hovered ? cc.suggestion(text) : t.text(text)) + dim(']'))
        const endCol = startCol + rawWidth - 1
        if (endCol < width) pending.push({ id, direction, startCol, endCol })
      } else {
        parts.push(dim(`[${text}]`))
      }
      used += 1 + rawWidth
    }
    addButton('nav-prev', compact ? '‹' : 'Prev', nav.previous, 'previous')
    addButton('nav-next', compact ? '›' : 'Next', nav.next, 'next')
    out.push(fit(parts.join(''), width))
    for (const button of pending) {
      boxes.push({
        id: button.id,
        startRow: row,
        endRow: row,
        startCol: button.startCol,
        endCol: button.endCol,
        onClick: () => this.navigateTool(button.direction),
        onHover: (entering: boolean) => this.setHover(entering ? button.id : undefined),
      })
    }
  }

  /** Section tabs with the honest source-line count; only visible chips click. */
  private paintTabs(out: string[], boxes: MouseHitbox[], row: number, width: number): void {
    const sources = this.sources()
    const plans: Array<{ section: ToolIoSection; text: string; startCol: number }> = []
    const parts: string[] = [' ']
    let col = 1
    for (const section of SECTIONS) {
      const text = ` ${this.sectionLabel(section)} `
      plans.push({ section, text, startCol: col })
      parts.push(section === this.currentSection ? cc.chip(text) : t.muted(text))
      col += visibleWidth(text)
      parts.push(' ')
      col += 1
    }
    const count = this.currentSection === 'input' ? sources.inputLines : sources.outputLines
    const suffix = dim(`${count} line${count === 1 ? '' : 's'}`)
    if (col + visibleWidth(suffix) + 1 <= width) parts.push(suffix)
    out.push(fit(parts.join(''), width))
    for (const plan of plans) {
      const endCol = plan.startCol + visibleWidth(plan.text) - 1
      if (endCol >= width) continue
      boxes.push({
        id: 'tab:' + plan.section,
        startRow: row,
        endRow: row,
        startCol: plan.startCol,
        endCol,
        onClick: () => this.selectSection(plan.section),
        onHover: (entering: boolean) => this.setHover(entering ? 'tab:' + plan.section : undefined),
      })
    }
  }

  /**
   * One explicit chip per real tool-result image, on the Output tab. Chips use
   * the shared hitbox layer and open the parent-owned image overlay; a real
   * keyboard entry is the effective `app.images.details` binding (first image).
   * Remapped/disabled bindings produce no key hint.
   */
  private paintChips(
    out: string[],
    boxes: MouseHitbox[],
    row: number,
    width: number,
    images: readonly ImageOccurrence[],
  ): void {
    const openKey = this.bindingLabel('app.images.details')
    const hint = openKey === undefined ? '' : `${openKey} open first`
    const plans: Array<{ key: string; startCol: number; endCol: number }> = []
    const parts: string[] = [` ${dim('Images:')} `]
    let col = visibleWidth(parts[0]!)
    for (const image of images) {
      const id = `image:${image.key}`
      const label = `[Image #${image.ordinal}]`
      const chip = this.hovered === id ? bold(t.accentBright(label)) : t.accentBright(label)
      const startCol = col
      parts.push(chip)
      col += visibleWidth(label)
      plans.push({ key: image.key, startCol, endCol: col - 1 })
      parts.push(' ')
      col += 1
    }
    if (hint !== '') {
      const styled = dim(hint)
      if (col + visibleWidth(styled) + 3 <= width) parts.push(dim('· '), styled)
    }
    out.push(fit(parts.join(''), width))
    for (const plan of plans) {
      if (plan.endCol >= width) continue
      const id = `image:${plan.key}`
      boxes.push({
        id,
        startRow: row,
        endRow: row,
        startCol: plan.startCol,
        endCol: plan.endCol,
        claimPress: true,
        onClick: () => { this.openImage(plan.key) },
        onHover: (entering: boolean) => this.setHover(entering ? id : undefined),
      })
    }
  }

  /** Left column of the wide layout: call identity only, windowed on the cursor. */
  private paintCallList(plan: CallListPlan, rows: number): CallListPaint {
    const lines: string[] = []
    const hits: Array<MouseHitbox | undefined> = []
    const { tools, cursor, leftWidth } = plan
    const column = Math.max(1, leftWidth - 1)
    const header = fit(` ${dim('Calls')}${dim(` ${cursor + 1}/${tools.length}`)}`, leftWidth)
    const listRows = rows > 1 ? rows - 1 : 0
    if (rows > 0) {
      lines.push(header)
      hits.push(undefined)
    }
    const top = Math.max(0, Math.min(cursor - Math.floor(listRows / 2), tools.length - listRows))
    for (let index = 0; index < listRows; index += 1) {
      const position = top + index
      const tool = tools[position]
      if (tool === undefined) {
        lines.push('')
        hits.push(undefined)
        continue
      }
      const focused = this.focus === 'calls' && position === cursor
      const current = tool.callId === this.tool.callId
      const id = `call:${tool.callId}`
      const hovered = this.hovered === id
      const name = oneLine(toolDisplayName(tool.name), 40)
      const status = tool.status === 'done' && tool.resultIsError ? 'error' : tool.status
      const body = fit(` ${name} · ${status}`, column)
      const marker = focused ? cc.suggestion('❯') : current ? t.accentBright('•') : ' '
      const line = focused
        ? marker + bold(cc.suggestion(body.slice(1)))
        : hovered
          ? marker + bold(t.text(body.slice(1)))
          : current
            ? marker + t.text(body.slice(1))
            : dim(body)
      lines.push(fit(padEnd(line, leftWidth), leftWidth))
      hits.push({
        id,
        startRow: 0,
        endRow: 0,
        onClick: () => {
          const select = this.options.onSelectTool
          this.callCursor = position
          if (select !== undefined) this.requestCall(select, tool.callId)
        },
        onHover: (entering: boolean) => this.setHover(entering ? id : undefined),
      })
    }
    return { lines, hits }
  }

  private setHover(id: string | undefined): void {
    if (id === this.hovered) return
    this.hovered = id
    this.requestRender()
  }

  private sectionLabel(section: ToolIoSection): string {
    return section === 'input' ? 'Input' : 'Output'
  }

  private statusLine(): string {
    const status = this.tool.status
    const label = status === 'done' && this.tool.resultIsError ? 'done · error result' : status
    const duration = this.tool.durationMs === undefined ? '' : formatToolDuration(this.tool.durationMs)
    const suffix = duration === '' ? '' : ' · ' + duration
    const text = label + suffix
    switch (status) {
      case 'done':
        return this.tool.resultIsError ? cc.warning(text) : cc.success(text)
      case 'error':
        return cc.error(text)
      case 'proposed':
      case 'unknown':
        return cc.warning(text)
      case 'running':
        return t.muted(text)
      default: {
        const exhaustive: never = status
        return t.muted(String(exhaustive))
      }
    }
  }

  /**
   * Hints come from the effective keymap only: remapping, disabling or
   * chord-only bindings change (or remove) the text. The interrupt binding is
   * excluded from the close hint because `app.interrupt` has priority.
   */
  private hintLine(): string {
    const parts: string[] = []
    const next = this.firstKeys('tool.details.next-section')
    const previous = this.firstKeys('tool.details.previous-section')
    const sectionKeys = [next, previous].filter((value): value is string => value !== undefined)
    if (sectionKeys.length > 0) parts.push(`${sectionKeys.join('/')} section`)
    const up = this.firstKeys('list.previous')
    const down = this.firstKeys('list.next')
    if (up !== undefined && down !== undefined) parts.push(`${up}/${down} scroll`)
    if (this.focus === 'search') parts.push('type to filter · enter keep · esc clear')
    else {
      const find = this.firstKeys('modal.search')
      if (find !== undefined) parts.push(`${find} find`)
    }
    const wrapKey = this.firstKeys('tool.details.wrap')
    if (wrapKey !== undefined) parts.push(`${wrapKey} wrap`)
    if (this.callListOffered()) {
      const calls = this.firstKeys('tool.details.toggle-calls')
      if (calls !== undefined) parts.push(`${calls} calls`)
    }
    const toolKeys: string[] = []
    if (this.options.onPreviousTool !== undefined) {
      const previousTool = this.firstKeys('tool.details.previous-tool')
      if (previousTool !== undefined) toolKeys.push(previousTool)
    }
    if (this.options.onNextTool !== undefined) {
      const nextTool = this.firstKeys('tool.details.next-tool')
      if (nextTool !== undefined) toolKeys.push(nextTool)
    }
    if (toolKeys.length > 0) parts.push(`${toolKeys.join('/')} tool`)
    if (this.imageOccurrences().length > 0 && this.options.onImageDetails !== undefined) {
      const image = this.bindingLabel('app.images.details')
      if (image !== undefined) parts.push(`${image} image`)
    }
    const copy = this.firstKeys('tool.details.copy')
    if (copy !== undefined) parts.push(`${copy} copy`)
    const close = this.closeKey()
    if (close !== undefined) parts.push(`${close} close`)
    return parts.join(' · ')
  }

  private firstKeys(actionId: string): string | undefined {
    const binding = this.keymap.getBindings(actionId).find(spec => !spec.includes(' '))
    if (binding === undefined) return undefined
    return formatBinding(binding.split(' '))
  }

  /** Effective binding including chords (e.g. `ctrl+x ctrl+i`). */
  private bindingLabel(actionId: string): string | undefined {
    const binding = this.keymap.getBindings(actionId)[0]
    return binding === undefined ? undefined : formatBinding(binding.split(' '))
  }

  private closeKey(): string | undefined {
    const interrupt = new Set(this.keymap.getBindings('app.interrupt'))
    for (const id of ['list.cancel', 'dialog.cancel']) {
      const binding = this.keymap.getBindings(id).find(spec => !spec.includes(' ') && !interrupt.has(spec))
      if (binding !== undefined) return formatBinding(binding.split(' '))
    }
    return undefined
  }
}

/**
 * Minimal child for the public `ScrollView`: this modal already renders its own
 * line list, so the child exists only to satisfy the public scroll model. The
 * dialog slices the visible window from its own cached lines.
 */
class SectionBody implements Component {
  render(): string[] {
    return []
  }

  invalidate(): void {}
}
