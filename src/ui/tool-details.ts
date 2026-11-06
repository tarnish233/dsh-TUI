/**
 * Read-only tool call details (Input / Output) as a modal Pi TUI component.
 *
 * DSH owns the tool call and its result. This surface only presents the
 * projected `ToolTranscriptItem`; it never executes, retries or rewrites a
 * tool, never edits the prompt and never persists anything. The parent mounts
 * one instance through `TUI.showOverlay` (inline and fullscreen composites both
 * support overlays) and owns closing/disposal plus the actual clipboard write.
 *
 * Contract (fixed options):
 *
 *   new ToolDetailsDialog(tui, {
 *     tool, section?, keymap,
 *     onClose, onInterrupt?, onCopy, onRenderRequest?,
 *     getToolNavigation?, onPreviousTool?, onNextTool?,
 *   })
 *
 * - `tool` is the projected call. `setTool` applies an update of the *same*
 *   callId (live stream → durable result) without losing the selected section
 *   or the per-section scroll position. A different callId is the inspector
 *   moving between real calls: the focused section is kept, both scroll
 *   positions reset, in-flight copy feedback is invalidated, and `onClose` is
 *   never called by this component.
 * - `dispose()` is idempotent: it releases this instance's own pending chord
 *   and mouse hitboxes, never calls `onClose` and never moves focus.
 * - `onCopy(text)` receives the complete Input/Output source (no preview line
 *   cap, no 8k/16k truncation). A failure is reported inside the panel only.
 *
 * Input is resolved through the shared `CcKeymap` in the `toolDetails` context
 * (`toolDetails → list → dialog → global`, no editor fallback). Only the
 * contract actions take effect:
 *
 *   tool.details.next-section / previous-section  Input ↔ Output
 *   tool.details.copy                            copy the focused section
 *   list.previous/next/page-up/page-down/first/last  scroll the active section
 *   tool.details.previous-tool / next-tool        parent-owned earlier/later call
 *   list.cancel / dialog.cancel / app.cancel     close
 *   app.interrupt                                parent's turn interrupt (else close)
 *
 * Everything else is inert on purpose. A remapped/disabled modal action must
 * not fall through to an unrelated global action: Shift+Tab with
 * `tool.details.previous-section` disabled resolves `app.mode.cycle`, and Ctrl+O
 * resolves `app.tools.expand`; neither may change DSH permission or expand a
 * background tool card from inside this modal.
 *
 * The inspector opens on the latest call (parent decision) and can browse the
 * real tool-call sequence through the optional navigation hooks. The count is
 * read live from `getToolNavigation`; Previous/Next are disabled at the ends
 * both for the mouse and the keyboard. Without those hooks the component stays
 * the old single-call surface: no toolbar and no ghost buttons.
 *
 * Text is shown preformatted (never Markdown-lexed per frame). Sources and
 * wrapped lines are cached per tool version and width, with only the visible
 * window sliced out, so a >8k Input / >16k Output stays fully reachable by
 * scrolling without a per-frame re-wrap. Scrolling state is independent per
 * section, and the scrollbar is a plain line-range readout rather than a raw
 * terminal escape parser.
 */
import {
  ScrollView,
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '#pi-tui'
import type { ToolTranscriptItem } from '../state/transcript.ts'
import { createCcKeymap, formatBinding, type CcKeymap } from '../input/index.ts'
import { HitboxRegistry, type MouseHitbox } from './mouse.ts'
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
   * Open the separate image viewer for one tool-result occurrence. The parent
   * keeps this tool overlay mounted underneath and restores it on close, so the
   * section/scroll position survives. Without this callback the Output surface
   * stays text-only and advertises no image affordance.
   */
  onImageDetails?: (request: ImageDetailsRequest) => void
  /**
   * Optional overlay height cap (the parent already knows its viewport). The
   * default derives the cap from `tui.terminal.rows`, keeping every line inside
   * a normal terminal instead of scrolling the whole dialog into scrollback.
   */
  maxHeight?: number
}

const SECTIONS: readonly ToolIoSection[] = ['input', 'output']

const CLOSE_ACTIONS: ReadonlySet<string> = new Set(['list.cancel', 'dialog.cancel', 'app.cancel'])

const errorText = (error: unknown): string => sanitize(error instanceof Error ? error.message : String(error))

/** Honest source-line count; whitespace-only text is no content at all. */
function lineCount(text: string): number {
  return text.trim() === '' ? 0 : text.replace(/\n+$/, '').split('\n').length
}

/** Toolbar state for one frame; undefined keeps the standalone single-call UI. */
interface ToolNavView {
  readonly index: number
  readonly total: number
  readonly previous: boolean
  readonly next: boolean
  readonly compact: boolean
}

/** One frame's section tab in paint order, with its clickable cell range. */
interface TabPlan {
  readonly section: ToolIoSection
  readonly label: string
  readonly text: string
  readonly startCol: number
}

/**
 * Read-only Input/Output modal. `Component` + `Focusable`; the parent mounts it
 * with `TUI.showOverlay` and calls `dispose()` after hiding it.
 */
export class ToolDetailsDialog implements Component, Focusable {
  readonly capturesViewportInput = true
  readonly keymap: CcKeymap
  private readonly tui: TUI
  private readonly options: ToolDetailsDialogOptions
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
  private readonly wrappedCache = new Map<ToolIoSection, { text: string; width: number; lines: string[] }>()

  constructor(tui: TUI, options: ToolDetailsDialogOptions) {
    this.tui = tui
    this.options = options
    this.tool = options.tool
    this.currentSection = options.section ?? 'input'
    this.keymap = options.keymap ?? createCcKeymap()
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
    if (!value) this.releaseOwnChord()
    this.focusedState = value
  }

  /** Parent hook for focus changes; only this instance's chord is released. */
  cancelChord(): void {
    this.releaseOwnChord()
  }

  invalidate(): void {
    this.sourceCache = undefined
    this.wrappedCache.clear()
    this.requestRender()
  }

  // -------------------------------------------------------------------------
  // Updates / lifecycle

  /**
   * Apply the same call's newer projection (live → durable result). Section and
   * scroll are preserved; content caches refresh on the version token only.
   *
   * A different callId is the inspector navigating to another real call. The
   * selected Input/Output section is kept (the reader stays in the same mental
   * place), both scroll positions reset to the top, and any in-flight copy
   * feedback from the old call is invalidated. `onClose` is never called here;
   * the parent owns closing. Same-call result updates keep the reading position.
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
    }
    this.sourceCache = undefined
    this.wrappedCache.clear()
    this.requestRender()
  }

  /**
   * Idempotent teardown: release this modal's own chord and hitboxes only.
   * Never calls `onClose` and never changes focus, so a parent can dispose an
   * unselected/stale surface without disturbing the active editor.
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
  }

  // -------------------------------------------------------------------------
  // Input

  handleInput(raw: string): void {
    if (this.done || this.disposed) return
    const resolution = this.keymap.resolve(raw, 'toolDetails')
    if (resolution.kind === 'pending') {
      this.chordPending = true
      return
    }
    if (resolution.kind !== 'action') {
      this.chordPending = false
      // Read-only modal: a mismatched chord's passthrough byte is consumed
      // here instead of being re-dispatched into a global app action.
      return
    }
    this.chordPending = false
    this.dispatch(resolution.action.id)
  }

  /**
   * Only the contract actions act. Any other global fallback (Ctrl+O expand,
   * Shift+Tab permission cycle, todos, …) stays inert inside this modal.
   */
  private dispatch(id: string): void {
    if (CLOSE_ACTIONS.has(id)) {
      this.close()
      return
    }
    switch (id) {
      case 'app.interrupt':
        if (this.options.onInterrupt !== undefined) this.options.onInterrupt()
        else this.close()
        return
      case 'tool.details.next-section':
      case 'tool.details.previous-section':
        this.currentSection = this.currentSection === 'input' ? 'output' : 'input'
        this.requestRender()
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
      case 'list.first':
        this.setScroll(this.currentSection, 0)
        return
      case 'list.last':
        this.setScroll(this.currentSection, this.maxScrollTops[this.currentSection])
        return
      case 'list.previous':
        this.scrollBy(-1)
        return
      case 'list.next':
        this.scrollBy(1)
        return
      case 'list.page-up':
        this.scrollBy(-this.pageSize())
        return
      case 'list.page-down':
        this.scrollBy(this.pageSize())
        return
      default:
        // Deliberately inert: no editor fallthrough in this context and no
        // unrelated global app action may run from a read-only details panel.
        return
    }
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
    this.options.onClose()
  }

  /**
   * Live toolbar state. The getter is called every frame so a shrinking/growing
   * tool list updates the count and boundary state without a cached snapshot.
   * A malformed/empty position hides the toolbar instead of inventing one.
   */
  private toolbar(width: number): ToolNavView | undefined {
    const read = this.options.getToolNavigation
    if (read === undefined) return undefined
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
      compact: width < 32,
    }
  }

  /**
   * Parent owns call ordering. A boundary or missing callback is inert; the
   * position is re-read here so a stale mouse row can never navigate twice or
   * past the end.
   */
  private navigateTool(direction: 'previous' | 'next'): void {
    if (this.disposed) return
    const callback = direction === 'previous' ? this.options.onPreviousTool : this.options.onNextTool
    if (callback === undefined) return
    const read = this.options.getToolNavigation
    if (read === undefined) {
      callback()
      return
    }
    const nav = this.toolbar(80)
    if (nav === undefined) return
    if (direction === 'previous' ? !nav.previous : !nav.next) return
    callback()
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
    // The modal body is not a layout-level ScrollView, so wheel input must be
    // applied to the same public scroll state the keys use. Coordinates stay
    // with the hitbox registry; only the wheel is consumed here.
    if (event.type === 'wheel') {
      const delta = event.wheelDelta ?? 0
      if (delta === 0) return undefined
      this.scrollBy(delta)
      return { handled: true, render: true }
    }
    return this.registry.handleMouse(event)
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

  /**
   * Complete wrapped source lines for one section, cached per text+width. Only
   * the visible window is sliced during render; the full array is what makes
   * every line reachable by scrolling.
   */
  private contentLines(section: ToolIoSection, text: string, width: number): string[] | undefined {
    if (text.trim() === '') return undefined
    const cached = this.wrappedCache.get(section)
    if (cached !== undefined && cached.text === text && cached.width === width) return cached.lines
    const lines = wrap(text.replace(/\n+$/, ''), Math.max(1, width))
    this.wrappedCache.set(section, { text, width, lines })
    return lines
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

  render(width: number): string[] {
    if (this.disposed) return []
    const size = Math.max(1, Math.floor(width))
    const limit = this.heightFor(size)
    const toolbar = this.toolbar(size)
    const messageLines = this.noticeLines(size)
    const images = this.currentSection === 'output' && this.options.onImageDetails !== undefined
      ? this.imageOccurrences()
      : []
    const chrome = 8 + (toolbar === undefined ? 0 : 1) + (images.length === 0 ? 0 : 1)
    const bodyHeight = Math.max(1, limit - chrome - messageLines.length)
    this.viewportHeights.input = bodyHeight
    this.viewportHeights.output = bodyHeight

    const sources = this.sources()
    const sourceText = this.currentSection === 'input' ? sources.input : sources.output
    const bodyLines = this.contentLines(this.currentSection, sourceText, Math.max(1, size - 1))
    const empty = bodyLines === undefined
    const content = empty ? [this.emptyMessage(this.currentSection)] : bodyLines
    const total = content.length
    const maxScroll = Math.max(0, total - bodyHeight)
    this.maxScrollTops[this.currentSection] = maxScroll
    const view = this.scrollViews[this.currentSection]
    view.updateLayout(total, bodyHeight, () => this.requestRender())
    if (view.scrollTop > maxScroll) view.scrollTo(maxScroll)
    const top = Math.min(view.scrollTop, maxScroll)
    const visible = content.slice(top, top + bodyHeight)

    const out: string[] = []
    const boxes: MouseHitbox[] = []
    const push = (line: string): number => {
      out.push(line)
      return out.length - 1
    }

    push(cc.inactive('─'.repeat(size)))
    push(fit(` ${bold(cc.permission('Tool details'))}${dim(' · ')}${t.text(oneLine(toolDisplayName(this.tool.name), 60))}`, size))
    if (toolbar !== undefined) this.renderToolbar(push, boxes, size, toolbar)
    this.renderTabs(push, boxes, size)
    push(cc.inactive('─'.repeat(size)))
    if (images.length > 0) this.renderImageButtons(push, boxes, size, images)

    for (let index = 0; index < bodyHeight; index += 1) {
      const line = visible[index]
      if (line === undefined) {
        push('')
        continue
      }
      push(empty ? ` ${dim(t.muted(line))}` : ` ${t.text(line)}`)
    }

    push(cc.inactive('─'.repeat(size)))
    const range = total === 0
      ? `${this.sectionLabel(this.currentSection)} · no lines`
      : `${this.sectionLabel(this.currentSection)} lines ${total === 0 ? 0 : top + 1}-${Math.min(total, top + bodyHeight)} of ${total}`
    const status = this.statusLine()
    push(fit(` ${status}${dim(' · ')}${dim(`${sources.inputLines} in · ${sources.outputLines} out · ${range}`)}`, size))

    this.renderButtons(push, boxes, size)
    push(fit(` ${dim(this.hintLine())}`, size))
    for (const line of messageLines) push(fit(` ${line}`, size))

    // Consume one blank slot if the terminal height was the limit and a message
    // made the frame grow; keeping a hard bound matters more than the hint.
    if (out.length > limit) out.length = limit

    this.registry.sync(boxes)
    return out.map(line => fit(line, size))
  }

  private heightFor(width: number): number {
    const rows = this.tui.terminal.rows
    const terminalCap = Number.isFinite(rows) && rows > 0 ? Math.max(6, Math.floor(rows) - 2) : 24
    const configured = this.options.maxHeight
    const cap = configured !== undefined && Number.isFinite(configured) && configured > 0
      ? Math.max(6, Math.min(terminalCap, Math.floor(configured)))
      : terminalCap
    return Math.max(6, cap)
  }

  /**
   * `Tool 3 / 12   [Prev] [Next]` (or compact `‹`/`›` when narrow).
   *
   * Boundary controls render dim with no hitbox, so a press there never claims
   * the gesture or fires a navigation. IDs are stable across frames; the click
   * handler re-reads the live position and asks the parent exactly once.
   */
  private renderToolbar(push: (line: string) => number, boxes: MouseHitbox[], width: number, nav: ToolNavView): void {
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
    if (nav.compact) {
      addButton('nav-prev', '‹', nav.previous, 'previous')
      addButton('nav-next', '›', nav.next, 'next')
    } else {
      addButton('nav-prev', 'Prev', nav.previous, 'previous')
      addButton('nav-next', 'Next', nav.next, 'next')
    }
    const row = push(fit(parts.join(''), width))
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

  /**
   * One explicit chip per real tool-result image, on the Output tab. Chips use
   * the shared hitbox layer and open the parent-owned image overlay; a real
   * keyboard entry is the effective `app.images.details` binding (first image).
   * Remapped/disabled bindings produce no key hint.
   */
  private renderImageButtons(
    push: (line: string) => number,
    boxes: MouseHitbox[],
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
    const row = push(fit(parts.join(''), width))
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

  /** Tabs are plain chips; only fully visible tabs expose a click target. */
  private renderTabs(push: (line: string) => number, boxes: MouseHitbox[], width: number): void {
    const plans: Array<{ section: ToolIoSection; text: string; startCol: number }> = []
    const parts: string[] = [' ']
    let col = 1
    for (const section of SECTIONS) {
      const text = ` ${this.sectionLabel(section)} `
      plans.push({ section, text, startCol: col })
      parts.push(section === this.currentSection ? cc.chip(text) : t.muted(text))
      col += visibleWidth(text)
      if (section !== SECTIONS[SECTIONS.length - 1]) {
        parts.push(' ')
        col += 1
      }
    }
    const row = push(fit(parts.join(''), width))
    for (const plan of plans) {
      const endCol = plan.startCol + visibleWidth(plan.text) - 1
      if (endCol >= width) continue
      const id = 'tab:' + plan.section
      boxes.push({
        id,
        startRow: row,
        endRow: row,
        startCol: plan.startCol,
        endCol,
        onClick: () => {
          this.currentSection = plan.section
          this.requestRender()
        },
        onHover: (entering: boolean) => this.setHover(entering ? id : undefined),
      })
    }
  }

  private renderButtons(push: (line: string) => number, boxes: MouseHitbox[], width: number): void {
    const copyHovered = this.hovered === 'copy'
    const closeHovered = this.hovered === 'close'
    const copyLabel = ' Copy '
    const closeLabel = ' Close '
    const copyText = `[${copyHovered ? cc.suggestion(copyLabel) : t.text(copyLabel)}]`
    const closeText = `[${closeHovered ? cc.suggestion(closeLabel) : t.text(closeLabel)}]`
    const row = push(fit(` ${copyText} ${closeText}`, width))
    this.addButtonBox(boxes, 'copy', row, 1, copyText, width, () => { void this.copy() })
    const closeStart = 1 + visibleWidth(copyText) + 1
    this.addButtonBox(boxes, 'close', row, closeStart, closeText, width, () => this.close())
  }

  private addButtonBox(
    boxes: MouseHitbox[],
    id: 'copy' | 'close',
    row: number,
    startCol: number,
    text: string,
    width: number,
    onClick: () => void,
  ): void {
    const endCol = startCol + visibleWidth(text) - 1
    if (endCol >= width) return
    boxes.push({
      id,
      startRow: row,
      endRow: row,
      startCol,
      endCol,
      onClick,
      onHover: (entering: boolean) => this.setHover(entering ? id : undefined),
    })
  }

  private setHover(id: string | undefined): void {
    if (id === this.hovered) return
    this.hovered = id
    this.requestRender()
  }

  private noticeLines(width: number): string[] {
    if (this.message === '') return []
    const style = this.messageFailed ? t.redSoft : t.muted
    return wrap(this.message, Math.max(1, width - 1)).map(line => style(line))
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