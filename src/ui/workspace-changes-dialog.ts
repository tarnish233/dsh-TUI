/**
 * Read-only native workspace diff surface.
 *
 * Opening this dialog never reads a file, runs git, starts a watcher or resolves
 * a path. The parent owns the native `workspace-change-diff` read and passes a
 * narrow `loadDiff(seq, index)` request; the dialog only renders the validated
 * `WorkspaceChangeDiffResult` it receives.
 *
 * Identity is exact and fail-closed:
 * - the native session id and attachment id (when known) must match;
 * - the announcing event `seq` and the requested file `index` must match the
 *   still-open detail request;
 * - the returned `diff.path` must equal the selected native summary row's
 *   `path`. A mismatched payload is settled as an honest error and never
 *   painted: the dialog never shows another file's bytes under this label;
 * - a closed, switched, disposed or stale-session response is dropped without
 *   repaint, so a late read can never revive another file or another session.
 *
 * List/detail reuse the shared modal chrome and list plumbing (`ModalFrame`,
 * `windowList`, `ModalListSurface`, `rowMouse`), the `modalList` keymap context
 * and the common body hit testing. No private editor, timer, stdin listener or
 * stdout writer lives here.
 */
import {
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '#pi-tui'
import type {
  WorkspaceChangeDiffResult,
  WorkspaceChangeFile,
  WorkspaceChangesSummary,
  WorkspaceFileDiff,
} from '../backend/types.ts'
import { createCcKeymap, type CcKeymap } from '../input/index.ts'
import { isInterruptKey, modalAction, type ResolvedModalAction } from './dialogs.ts'
import {
  ModalListSurface,
  windowList,
  type ListBlock,
  type ListBody,
} from './modal-list.ts'
import { type ModalAction, type ModalSize } from './modal.ts'
import { fit, oneLine, sanitize, truncateToWidth, visibleWidth, wrap } from './text.ts'
import { bold, dim, t } from './theme.ts'
import {
  workspaceDisplayLabel,
  workspaceFileNotes,
  workspaceFileSuffix,
  workspaceFileSuffixStyle,
  workspaceSummaryFacts,
} from './workspace-changes.ts'
import { renderWorkspaceFileDiff, workspaceDiffFacts } from './workspace-diff.ts'

const DOWN_ACTIONS: ReadonlySet<string> = new Set(['list.next', 'list.page-down'])
const UP_ACTIONS: ReadonlySet<string> = new Set(['list.previous', 'list.page-up'])
const CLOSE_ACTIONS: ReadonlySet<string> = new Set(['list.cancel', 'dialog.cancel', 'app.cancel'])
export interface WorkspaceChangesViewState {
  readonly selectedIndex: number
  readonly listScroll: number
  readonly detailIndex?: number
  readonly detailScroll: number
}

export interface WorkspaceChangesDialogOptions {
  /** Durable seq of the live event that announced the summary. */
  readonly seq: number
  readonly summary: WorkspaceChangesSummary
  /** Exact native session identity; responses for another session are dropped. */
  readonly sessionId: string
  /** Exact process attachment identity when the parent knows it. */
  readonly attachmentId?: string
  /** Initial list selection; the parent may call `openDetail()` for a direct file. */
  readonly initialIndex?: number
  /** Shared keymap; defaults to the CC defaults for tests/standalone hosts. */
  readonly keymap?: CcKeymap
  /** Bounded modal height (defaults to the shared standard modal budget). */
  readonly maxHeight?: number
  /**
   * Request the exact native diff read (`workspace-change-diff` with
   * `{seq,index}`). Called at most once per explicit file open. Omit it to keep
   * the detail action unavailable instead of advertising a dead read.
   */
  readonly loadDiff?: (seq: number, index: number) => void
  /**
   * Extra live session guard the parent can supply. Returning false drops any
   * pending/late response even when id/attachment still look current.
   */
  readonly isSessionCurrent?: () => boolean
  /** Esc / Ctrl+C / configured local cancel. The parent hides and disposes this instance. */
  readonly onClose: () => void
  /**
   * Explicit native interrupt (a configured `app.interrupt`, no shipped
   * default); defaults to closing. Default Ctrl+C is the local cancel.
   */
  readonly onInterrupt?: () => void
  /** Optional repaint hook for hosts that own rendering. */
  readonly onRenderRequest?: () => void
}

/** Runtime shape guard for the optional native diff payload. */
function usableDiff(value: WorkspaceFileDiff | undefined): WorkspaceFileDiff | undefined {
  if (value === undefined || value === null || typeof value !== 'object') return undefined
  if (value.kind === 'binary' || value.kind === 'oversized') return value
  if (value.kind !== 'text') return undefined
  if (!Array.isArray(value.hunks)) return undefined
  return value
}

const countText = (value: number): string => (Number.isFinite(value) && value >= 0 ? `+${value}` : '+?')
const deleteText = (value: number): string => (Number.isFinite(value) && value >= 0 ? `-${value}` : '-?')

export class WorkspaceChangesDialog implements Component, Focusable {
  readonly capturesViewportInput = true
  readonly modalSize: ModalSize = 'standard'
  readonly keymap: CcKeymap

  private readonly tui: TUI
  private readonly options: WorkspaceChangesDialogOptions
  private readonly list: ModalListSurface
  private readonly summary: WorkspaceChangesSummary
  private readonly seq: number
  private readonly sessionId: string
  private readonly attachmentId: string | undefined
  private selected: number
  private listScroll = 0
  private detail: number | undefined
  private diff: WorkspaceFileDiff | undefined
  private diffError = ''
  private diffLoading = false
  private detailScroll = 0
  private paintedDetailScroll = 0
  private detailRows = 0
  private bodyHeight = 0
  private focusedState = false
  private done = false
  private disposed = false

  constructor(tui: TUI, options: WorkspaceChangesDialogOptions) {
    this.tui = tui
    this.options = options
    this.keymap = options.keymap ?? createCcKeymap()
    this.summary = options.summary
    this.seq = options.seq
    this.sessionId = options.sessionId
    this.attachmentId = options.attachmentId
    this.selected = clampIndex(options.initialIndex ?? 0, options.summary.files.length)
    this.list = new ModalListSurface(tui, {
      size: this.modalSize,
      ...(options.maxHeight === undefined ? {} : { maxHeight: options.maxHeight }),
    })
  }

  // -------------------------------------------------------------------------
  // Parent surface

  get mode(): 'list' | 'detail' {
    return this.detail === undefined ? 'list' : 'detail'
  }

  get selectedIndex(): number {
    return this.selected
  }

  /** Native file index of the open detail view, if any. */
  get detailIndex(): number | undefined {
    return this.detail
  }

  get isLoading(): boolean {
    return this.diffLoading
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
    this.keymap.cancelChord()
    this.focusedState = value
  }

  captureView(): WorkspaceChangesViewState {
    return {
      selectedIndex: this.selected,
      listScroll: this.listScroll,
      ...(this.detail === undefined ? {} : { detailIndex: this.detail }),
      detailScroll: this.paintedDetailScroll,
    }
  }

  /** Select one native file row without opening it (parent deep-link/restore). */
  selectIndex(index: number): void {
    if (this.done || this.disposed) return
    this.selected = clampIndex(index, this.summary.files.length)
    this.list.invalidate()
    this.repaint()
  }

  /**
   * Open the native detail view for one file row and request its diff once.
   * A second call for the same open file is a no-op; a different index resets
   * the page and makes any older in-flight response stale.
   */
  openDetail(index?: number): void {
    if (this.done || this.disposed) return
    const files = this.summary.files
    if (files.length === 0) return
    const target = clampIndex(index ?? this.selected, files.length)
    if (this.detail === target && (this.diffLoading || this.diff !== undefined)) return
    this.selected = target
    this.detail = target
    this.diff = undefined
    this.diffError = ''
    this.diffLoading = true
    this.detailScroll = 0
    this.paintedDetailScroll = 0
    this.list.invalidate()
    this.repaint()
    const load = this.options.loadDiff
    if (load === undefined) {
      this.diffLoading = false
      this.diffError = 'Native per-file diffs are unavailable in this host.'
      this.list.invalidate()
      this.repaint()
      return
    }
    try {
      load(this.seq, target)
    } catch {
      // The parent owns the native read. A throwing request leaves an honest
      // local error instead of a permanently loading panel.
      if (this.detail === target && !this.done && !this.disposed) {
        this.diffLoading = false
        this.diffError = 'Native diff could not be requested.'
        this.list.invalidate()
        this.repaint()
      }
    }
  }

  /** Return to the list without closing the modal (Esc in detail). */
  closeDetail(): void {
    if (this.detail === undefined) return
    this.detail = undefined
    this.diff = undefined
    this.diffError = ''
    this.diffLoading = false
    this.detailScroll = 0
    this.paintedDetailScroll = 0
    this.list.invalidate()
    this.repaint()
  }

  /**
   * Accept one validated native diff for the currently open file.
   *
   * Returns false (and changes nothing) for a closed/disposed/session-stale
   * view or for a response whose seq/index/identity is not the open request.
   */
  setDiff(result: WorkspaceChangeDiffResult): boolean {
    if (!this.acceptsResult(result)) return false
    if (!this.accepts(result.seq, result.index)) return false
    const diff = usableDiff(result.diff)
    const requested = this.summary.files[result.index]
    if (diff !== undefined && (requested === undefined || diff.path !== requested.path)) {
      // The native read answered for a different row than the one that is open.
      // Painting it would show another file's bytes under this row's label, so
      // the open load settles as an honest error instead of sticking.
      this.diff = undefined
      this.diffLoading = false
      this.diffError = 'Native diff did not match the requested file.'
      this.list.invalidate()
      this.repaint()
      return false
    }
    this.diff = diff
    this.diffError = diff === undefined
      ? 'No native diff was returned for this file.'
      : ''
    this.diffLoading = false
    this.list.invalidate()
    this.repaint()
    return true
  }

  /** Honest adapter failure for the currently open file (late failures dropped). */
  setDiffError(seq: number, index: number, message: string): boolean {
    if (!this.accepts(seq, index)) return false
    const detail = oneLine(sanitize(typeof message === 'string' ? message : ''), 300)
    this.diff = undefined
    this.diffLoading = false
    this.diffError = detail === '' ? 'Native diff could not be read.' : detail
    this.list.invalidate()
    this.repaint()
    return true
  }

  invalidate(): void {
    this.list.invalidate()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.diff = undefined
    if (this.focusedState) this.keymap.cancelChord()
  }

  private accepts(seq: number, index: number): boolean {
    if (this.done || this.disposed) return false
    if (this.detail === undefined || this.detail !== index || this.seq !== seq) return false
    if (this.options.isSessionCurrent?.() === false) return false
    return true
  }

  private acceptsResult(result: WorkspaceChangeDiffResult | null | undefined): boolean {
    if (result === null || result === undefined) return false
    if (result.sessionId !== this.sessionId) return false
    if (result.attachmentId !== this.attachmentId) return false
    return true
  }

  // -------------------------------------------------------------------------
  // Input

  private close(): void {
    if (this.done) return
    this.done = true
    this.keymap.cancelChord()
    this.options.onClose()
  }

  private interrupt(): void {
    this.keymap.cancelChord()
    if (this.options.onInterrupt !== undefined) this.options.onInterrupt()
    else this.close()
  }

  private repaint(): void {
    try {
      this.tui.requestRender()
    } catch {
      // A closing host may already have torn the renderer down.
    }
    this.options.onRenderRequest?.()
  }

  private move(delta: number): void {
    const count = this.summary.files.length
    if (count === 0) return
    const from = this.selected < 0 || this.selected >= count ? 0 : this.selected
    this.selected = ((from + delta) % count + count) % count
    if (this.selected < this.listScroll) this.listScroll = this.selected
    this.keymap.cancelChord()
    this.repaint()
  }

  private moveTo(index: number): void {
    const count = this.summary.files.length
    if (count === 0) return
    this.selected = clampIndex(index, count)
    if (this.selected < this.listScroll) this.listScroll = this.selected
    this.repaint()
  }

  private scrollDetail(delta: number): void {
    const max = Math.max(0, this.detailRows - Math.max(1, this.bodyHeight))
    const base = Math.max(0, Math.min(this.paintedDetailScroll, max))
    const next = Math.max(0, Math.min(base + delta, max))
    this.detailScroll = next
    this.paintedDetailScroll = next
    this.repaint()
  }

  handleInput(raw: string): void {
    if (this.done || this.disposed) return
    if (isInterruptKey(this.keymap, raw)) {
      this.interrupt()
      return
    }
    const action = modalAction(this.keymap, raw)
    if (action === undefined) return
    if (this.mode === 'detail') {
      this.inputDetail(action)
      return
    }
    switch (action.id) {
      case 'list.previous': this.move(-1); return
      case 'list.next': this.move(1); return
      case 'list.page-up': this.move(-5); return
      case 'list.page-down': this.move(5); return
      case 'list.first': this.moveTo(0); return
      case 'list.last': this.moveTo(this.summary.files.length - 1); return
      case 'list.select':
      case 'dialog.confirm': this.openDetail(); return
      default:
        if (CLOSE_ACTIONS.has(action.id)) this.close()
        // Every other global/app action stays inert inside this read-only modal.
        return
    }
  }

  private inputDetail(action: ResolvedModalAction): void {
    if (UP_ACTIONS.has(action.id)) {
      this.scrollDetail(action.id === 'list.page-up' ? -5 : -1)
      return
    }
    if (DOWN_ACTIONS.has(action.id)) {
      this.scrollDetail(action.id === 'list.page-down' ? 5 : 1)
      return
    }
    switch (action.id) {
      case 'list.first':
        this.detailScroll = 0
        this.paintedDetailScroll = 0
        this.repaint()
        return
      case 'list.last':
        this.detailScroll = Number.MAX_SAFE_INTEGER
        this.paintedDetailScroll = Number.MAX_SAFE_INTEGER
        this.repaint()
        return
      case 'list.select':
      case 'dialog.confirm':
        return // Enter is inert in the read-only detail view
      default:
        if (CLOSE_ACTIONS.has(action.id)) this.closeDetail()
        return
    }
  }

  // -------------------------------------------------------------------------
  // Rendering

  private ownerKey(): string {
    return this.detail === undefined
      ? `workspace:list:${this.seq}:${this.selected}`
      : `workspace:detail:${this.seq}:${this.detail}`
  }

  private frameActions(): ModalAction[] {
    if (this.detail !== undefined) {
      return [
        { id: 'back', label: 'back', action: 'list.cancel', onActivate: () => this.closeDetail() },
        { id: 'close', label: 'close', onActivate: () => this.close() },
      ]
    }
    const open: ModalAction = this.summary.files.length === 0
      ? { id: 'open', label: 'details', disabled: true }
      : this.options.loadDiff === undefined
        ? { id: 'open', label: 'details', disabled: true }
        : { id: 'open', label: 'details', action: 'list.select', onActivate: () => this.openDetail() }
    return [
      open,
      { id: 'close', label: 'close', action: 'list.cancel', onActivate: () => this.close() },
    ]
  }

  private listHeader(width: number): string[] {
    const first = fit(
      `${t.accentBright('❯')} ${bold(t.text('Workspace changes'))} ${dim(`· turn ${this.summary.turn}`)}`,
      width,
    )
    const second = fit(`   ${dim(workspaceSummaryFacts(this.summary))}`, width)
    return [first, second]
  }

  private detailHeader(width: number): string[] {
    const file = this.currentFile()
    if (file === undefined) return [fit('', width), fit('', width)]
    const notes = workspaceFileNotes(file)
    const suffix = notes === '' ? `${countText(file.added)} ${deleteText(file.deleted)}` : notes
    const first = fit(`${t.accentBright('❯')} ${bold(t.text(safeDisplay(file.display)))} ${dim('·')} ${dim(suffix)}`, width)
    const facts: string[] = [
      `file ${this.detail === undefined ? 1 : this.detail + 1} of ${this.summary.files.length}`,
      `turn ${this.summary.turn}`,
    ]
    if (this.diff !== undefined) facts.push(...workspaceDiffFacts(this.diff))
    else if (notes !== '') facts.push(notes)
    const second = fit(`   ${dim(facts.join(' · '))}`, width)
    return [first, second]
  }

  private statusLines(width: number): string[] {
    if (this.options.isSessionCurrent?.() === false) {
      return [fit(` ${t.yellow('This native session is no longer current.')}`, width)]
    }
    if (this.mode === 'list' && this.options.loadDiff === undefined) {
      return [fit(` ${t.muted('Native per-file diffs are unavailable in this host.')}`, width)]
    }
    return []
  }

  private currentFile(): WorkspaceChangeFile | undefined {
    if (this.detail === undefined) return undefined
    return this.summary.files[this.detail]
  }

  private fileLines(file: WorkspaceChangeFile, width: number, focused: boolean): string[] {
    const marker = focused ? t.accentBright('❯') : ' '
    const prefix = `${marker} `
    const suffix = workspaceFileSuffix(file)
    const suffixWidth = visibleWidth(suffix)
    const gap = '  '
    const display = safeDisplay(file.display)
    const room = width - visibleWidth(prefix) - suffixWidth - visibleWidth(gap)
    if (room < 4) {
      return [fit(`${prefix}${t.text(truncateToWidth(display, Math.max(1, width - visibleWidth(prefix)), '…'))}`, width)]
    }
    const shown = truncateToWidth(display, room, '…')
    const label = focused ? bold(t.accentBright(shown)) : t.text(shown)
    return [fit(`${prefix}${label}${gap}${workspaceFileSuffixStyle(file)}`, width)]
  }

  private buildList(width: number, height: number): ListBody {
    const files = this.summary.files
    if (height <= 0) return { lines: [] }
    if (files.length === 0) {
      return { lines: [fit(` ${t.muted('No changed files were reported for this turn.')}`, width)] }
    }
    const blocks: ListBlock[] = files.map((file, index) => ({
      lines: this.fileLines(file, width, index === this.selected),
      focused: index === this.selected,
      index,
      key: String(index),
    }))
    const window = windowList(blocks, height, { start: this.listScroll })
    this.listScroll = window.start
    return { lines: window.lines, hits: window.hits }
  }

  private buildDetail(width: number, height: number): ListBody {
    if (height <= 0) return { lines: [] }
    this.bodyHeight = height
    const all = this.detailContent(width)
    this.detailRows = all.length
    const max = Math.max(0, all.length - height)
    const scroll = Math.max(0, Math.min(this.paintedDetailScroll, max))
    this.paintedDetailScroll = scroll
    this.detailScroll = scroll
    return { lines: all.slice(scroll, scroll + height).map(line => fit(line, width)) }
  }

  private detailContent(width: number): string[] {
    if (this.diffError !== '') {
      return wrap(t.redSoft(this.diffError), Math.max(4, width)).slice(0, 4)
    }
    if (this.diffLoading) return [fit(t.muted('Reading native diff…'), width)]
    if (this.diff !== undefined) return renderWorkspaceFileDiff(this.diff, width)
    return [fit(t.muted('No native diff has been read yet.'), width)]
  }

  render(width: number): string[] {
    if (this.done || this.disposed) return []
    const size = Math.max(1, Math.floor(width))
    const detail = this.mode === 'detail'
    return this.list.render(size, {
      title: detail ? 'Workspace file' : 'Workspace changes',
      ownerKey: this.ownerKey(),
      beforeRows: 2,
      before: bodyWidth => detail ? this.detailHeader(bodyWidth) : this.listHeader(bodyWidth),
      status: bodyWidth => this.statusLines(bodyWidth),
      actions: this.frameActions(),
      onClose: () => this.close(),
      keymap: this.keymap,
    }, (bodyWidth, bodyHeight) => detail ? this.buildDetail(bodyWidth, bodyHeight) : this.buildList(bodyWidth, bodyHeight))
  }

  // -------------------------------------------------------------------------
  // Mouse

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.done || this.disposed) return undefined
    const chrome = this.list.chromeMouse(event)
    if (chrome !== undefined) return chrome
    const body = this.list.bodyMouse(event)
    if (body === undefined) return undefined
    if (event.type === 'wheel') {
      const delta = (event.wheelDelta ?? 0) < 0 ? -1 : 1
      if (this.mode === 'detail') this.scrollDetail(delta * 3)
      else this.move(delta)
      return { handled: true, render: true }
    }
    if (this.mode === 'detail') {
      // The read-only detail body has no selectable rows; claim the left
      // gesture so it cannot leak into the composer's text selection.
      return event.button === 'left' ? { handled: true, render: false } : undefined
    }
    const handled = this.list.rowMouse(event, this.ownerKey(), hit => {
      const index = hit.index
      if (index === undefined) return
      const file = this.summary.files[index]
      if (file === undefined) return
      this.selected = index
      this.openDetail(index)
    })
    return handled
  }
}

function clampIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) return 0
  return Math.max(0, Math.min(Math.floor(index), count - 1))
}

/**
 * Flatten/sanitize a native display label before any width arithmetic.
 *
 * A whitespace-only native label stays visible (quoted) instead of painting a
 * blank row that hides which native index is selected.
 */
const safeDisplay = (display: string): string => workspaceDisplayLabel(display)