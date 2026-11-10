/**
 * Full read-only native decision detail on the shared popup frame.
 *
 * DSH owns the decision, the native question text and the `presentCall` diff
 * intent. This surface only reads the snapshot the parent already handed to the
 * decision dialog: a native `question.detail` markdown body or the *pure*
 * proposal record (the same validated `toolPresentation.call` the approval
 * preview uses). It never answers, never executes a tool, never reads a path or
 * URL, never presents a `result`/`presentResult` half and never invents an
 * applied label. The parent mounts it as a separate workspace overlay over the
 * retained decision instance and returns focus on close, so selections, checks,
 * custom drafts and ordered opaque values survive untouched.
 *
 * Content is rendered in full and reached by scrolling — nothing is truncated
 * silently. The body is the actual native rows plus one honest position and
 * metadata row, so a long plan or a large patch is bounded by the viewport,
 * never by a fake summary.
 *
 * Input is resolved through the shared `CcKeymap` in the `modalList` context
 * (`list`/`dialog`/`global` fallbacks, no editor layer): list navigation keys
 * scroll, `list.cancel`/`dialog.cancel`/`app.cancel` close, and an explicitly
 * configured `app.interrupt` stays global turn cancellation (the App owns that
 * action). A disabled or remapped key is honoured — no invented fallback is
 * added here.
 */
import {
  Markdown,
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '#pi-tui'
import type { JsonRecord } from '../backend/types.ts'
import { createCcKeymap, formatBinding, type CcKeymap } from '../input/index.ts'
import {
  decisionProposalDiffs,
  decisionProposalRows,
  modalAction,
  type ResolvedModalAction,
} from './dialogs.ts'
import { ModalFrame, modalHeight, type ModalAction, type ModalFrameOptions, type ModalSize } from './modal.ts'
import { dim, markdownTheme, t } from './theme.ts'
import { fit } from './text.ts'

/**
 * One already-supplied native detail. Both variants are display-only snapshots:
 * `markdown` is the native `Question.detail` text verbatim, `proposal` is the
 * validated pure native approval presentation (never its result half).
 */
export type DecisionDetailContent =
  | { readonly kind: 'markdown'; readonly title: string; readonly text: string }
  | { readonly kind: 'proposal'; readonly title: string; readonly presentation: JsonRecord }

export interface DecisionDetailsOptions {
  readonly content: DecisionDetailContent
  readonly keymap: CcKeymap
  readonly onClose: () => void
  readonly onInterrupt?: () => void
}

const CLOSE_ACTIONS = new Set(['list.cancel', 'dialog.cancel', 'app.cancel'])
/** Wheel rows per notch; the same feel as the other read-only inspectors. */
const WHEEL_ROWS = 3
/** Left pad of one column so native text never touches the frame border. */
const BODY_PAD = 1

interface FramePlan {
  readonly width: number
  readonly options: ModalFrameOptions
  readonly bodyWidth: number
  readonly bodyHeight: number
}

/**
 * Read-only, scrollable native detail. `Component` + `Focusable`; the parent
 * mounts it with a bounded workspace overlay and calls `dispose()` after
 * hiding it.
 */
export class DecisionDetailsDialog implements Component, Focusable {
  /** A workspace reading surface owns the viewport (its own scroll keys). */
  readonly capturesViewportInput = true
  readonly modalSize: ModalSize = 'wide'
  readonly keymap: CcKeymap
  private readonly tui: TUI
  private readonly options: DecisionDetailsOptions
  private readonly frame = new ModalFrame()
  private readonly markdown = new Markdown('', 0, 0, markdownTheme)
  /** Validated once: the record is an immutable native snapshot. */
  private readonly proposalDiffs: ReturnType<typeof decisionProposalDiffs> | undefined
  /** Native rows keyed by width; dropped by `invalidate()`. */
  private contentCache: { readonly width: number; readonly lines: readonly string[] } | undefined
  private scrollTopValue = 0
  /** Content rows the last paint gave the window (used for page scrolling). */
  private viewportRows = 0
  private focusedState = false
  private done = false
  private disposedState = false

  constructor(tui: TUI, options: DecisionDetailsOptions) {
    this.tui = tui
    this.options = options
    this.keymap = options.keymap ?? createCcKeymap()
    this.proposalDiffs = options.content.kind === 'proposal'
      ? decisionProposalDiffs(options.content.presentation)
      : undefined
  }

  get focused(): boolean {
    return this.focusedState
  }

  set focused(value: boolean) {
    if (value === this.focusedState) return
    this.keymap.cancelChord()
    this.focusedState = value
  }

  get isDone(): boolean {
    return this.done
  }

  get isDisposed(): boolean {
    return this.disposedState
  }

  /** Current content scroll offset in native rows. */
  get scrollTop(): number {
    return this.scrollTopValue
  }

  /** Native rows of the complete content at `width` (never a preview). */
  contentRows(width: number = this.tui.terminal.columns): number {
    return this.contentLines(this.plan(width).bodyWidth).length
  }

  /** Largest usable scroll offset for the current width (0 when it all fits). */
  maxScrollTop(width: number = this.tui.terminal.columns): number {
    const plan = this.plan(width)
    const lines = this.contentLines(plan.bodyWidth).length
    return Math.max(0, lines - this.window(plan.bodyHeight, lines))
  }

  /** Parent hook for focus changes; safe to call repeatedly. */
  cancelChord(): void {
    this.keymap.cancelChord()
  }

  /**
   * Idempotent teardown. Never calls `onClose` and never changes focus, so a
   * parent can dispose a stale surface without disturbing the editor.
   */
  dispose(): void {
    if (this.disposedState) return
    this.disposedState = true
    if (this.focusedState) this.keymap.cancelChord()
  }

  invalidate(): void {
    this.frame.invalidate()
    this.markdown.invalidate()
    this.contentCache = undefined
  }

  // -------------------------------------------------------------------------
  // Input

  handleInput(raw: string): void {
    if (this.done || this.disposedState) return
    const action = modalAction(this.keymap, raw)
    if (action === undefined) return
    this.apply(action)
  }

  private apply(action: ResolvedModalAction): void {
    if (action.id === 'app.interrupt') {
      this.interrupt()
      return
    }
    if (CLOSE_ACTIONS.has(action.id)) {
      this.close()
      return
    }
    const page = Math.max(1, this.viewportRows - 1)
    const max = this.maxScrollTop()
    if (action.id === 'list.previous') this.setScroll(this.scrollTopValue - 1, max)
    else if (action.id === 'list.next') this.setScroll(this.scrollTopValue + 1, max)
    else if (action.id === 'list.page-up') this.setScroll(this.scrollTopValue - page, max)
    else if (action.id === 'list.page-down') this.setScroll(this.scrollTopValue + page, max)
    else if (action.id === 'list.first') this.setScroll(0, max)
    else if (action.id === 'list.last') this.setScroll(max, max)
    // list.select / dialog.confirm have no rows to activate: read-only.
  }

  private setScroll(value: number, max: number): void {
    this.scrollTopValue = Math.max(0, Math.min(max, Math.trunc(value)))
  }

  private close(): void {
    if (this.done) return
    this.done = true
    this.options.onClose()
  }

  private interrupt(): void {
    if (this.done) return
    this.keymap.cancelChord()
    if (this.options.onInterrupt !== undefined) this.options.onInterrupt()
    else this.close()
  }

  // -------------------------------------------------------------------------
  // Mouse

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const chrome = this.frame.handleMouse(event)
    if (chrome !== undefined) return chrome
    const body = this.frame.bodyMouse(event)
    if (body === undefined) return undefined
    if (event.type !== 'wheel') return undefined
    const delta = event.wheelDelta ?? 0
    if (delta === 0) return undefined
    this.setScroll(this.scrollTopValue + (delta < 0 ? -WHEEL_ROWS : WHEEL_ROWS), this.maxScrollTop())
    return { handled: true, render: true }
  }

  // -------------------------------------------------------------------------
  // Rendering

  private title(): string {
    const title = this.options.content.title.trim()
    return title === '' ? 'Native detail' : title
  }

  private kindLabel(): string {
    return this.options.content.kind === 'proposal' ? 'proposal · not run yet' : 'native detail'
  }

  /**
   * The complete native rows at `width`: never a preview, never a fabricated
   * result. Proposal rows come from the same validated record and the same
   * shared `renderDiffBlock` the approval preview uses, in expanded mode.
   */
  private contentLines(width: number): readonly string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    if (this.contentCache?.width === safeWidth) return this.contentCache.lines
    const contentWidth = Math.max(1, safeWidth - BODY_PAD)
    let lines: string[]
    if (this.options.content.kind === 'proposal') {
      const diffs = this.proposalDiffs ?? []
      if (diffs.length === 0) {
        // Defensive only: the parent passes validated content. Say so plainly
        // instead of painting an empty or invented change.
        lines = [` ${dim(t.muted('No native proposal content is available.'))}`]
      } else {
        lines = decisionProposalRows(diffs, contentWidth, { expanded: true }).lines
      }
    } else {
      this.markdown.setText(this.options.content.text)
      const rendered = this.markdown.render(contentWidth)
      while (rendered.length > 0 && (rendered[0] ?? '').trim() === '') rendered.shift()
      while (rendered.length > 0 && (rendered[rendered.length - 1] ?? '').trim() === '') rendered.pop()
      lines = rendered.map(line => (line.trim() === '' ? '' : line.trimEnd()))
      if (lines.length === 0) lines = [` ${dim(t.muted('No native detail text is available.'))}`]
    }
    const fitted = lines.map(line => (line === '' ? '' : fit(` ${line.replace(/^ +/, '')}`, safeWidth)))
    this.contentCache = { width: safeWidth, lines: fitted }
    return fitted
  }

  /** Rows available to content once the honest position row is reserved. */
  private window(room: number, total: number): number {
    const height = Math.max(1, room)
    // One row is reserved for the position/metadata line whenever the content
    // does not fit; a fitting body keeps every row for native text.
    return Math.max(1, total > height - 1 ? height - 1 : height)
  }

  private plan(width: number): FramePlan {
    const safeWidth = Math.max(1, Math.floor(width))
    const options = this.modalOptions()
    const geometry = this.frame.measure(safeWidth, options)
    return { width: safeWidth, options, bodyWidth: geometry.bodyWidth, bodyHeight: geometry.bodyHeight }
  }

  private modalOptions(): ModalFrameOptions {
    const close: ModalAction = { id: 'close', label: 'Close', action: 'list.cancel', onActivate: () => this.close() }
    return {
      title: this.title(),
      ownerKey: `decision-details:${this.options.content.kind}:${this.title()}`,
      subtitle: `${this.kindLabel()} · read-only`,
      actions: [close],
      onClose: () => this.close(),
      maxHeight: modalHeight(this.tui, this.modalSize),
      keymap: this.keymap,
    }
  }

  private body(bodyWidth: number, bodyHeight: number): string[] {
    const lines = this.contentLines(bodyWidth)
    const room = Math.max(1, bodyHeight)
    const window = this.window(room, lines.length)
    this.viewportRows = window
    const max = Math.max(0, lines.length - window)
    if (this.scrollTopValue > max) this.scrollTopValue = max
    const top = Math.min(Math.max(0, this.scrollTopValue), max)
    const painted = lines.slice(top, top + window)
    if (lines.length <= window) return painted
    const above = top
    const below = Math.max(0, lines.length - (top + painted.length))
    const parts = [`↑ ${above}`, `${top + 1}–${top + painted.length}/${lines.length}`, `↓ ${below}`]
    const hint = this.scrollHint()
    if (hint !== '') parts.push(hint)
    return [...painted, ` ${dim(t.muted(parts.join(' · ')))}`]
  }

  /** Effective scroll bindings, never invented prose about keys. */
  private scrollHint(): string {
    const keys = [...this.keymap.getBindings('list.previous'), ...this.keymap.getBindings('list.next')]
    const labels = [...new Set(keys.filter(key => key.split(' ').length === 1).map(key => formatBinding([key])))].slice(0, 2)
    return labels.length === 0 ? '' : `${labels.join('/')} scroll`
  }

  render(width: number): string[] {
    const plan = this.plan(width)
    const body = this.body(plan.bodyWidth, plan.bodyHeight)
    const lines = body.slice(0, plan.bodyHeight).map(line => fit(line, plan.bodyWidth))
    return this.frame.render(plan.width, lines, plan.options)
  }
}