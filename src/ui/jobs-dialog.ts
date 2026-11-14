/**
 * Read-only native **jobs inspector**: the list of the current session's
 * background jobs plus one explicit, bounded output view.
 *
 * Ownership boundary (AGENTS.md "Jobs inspector" contract):
 * - DSH owns the job registry (`ctx.jobs`), its lifecycle status, the output
 *   ring and every producer. This component owns **no** job state: the parent
 *   assigns a native snapshot (`setSnapshot`, also on `native_ui_changed` with
 *   `domain: 'jobs'`), and the parent performs the native `get`/`readAt` reads
 *   behind `onOpenOutput` and answers with `setOutput`/`setOutputError`.
 * - No supervisor: this file never starts, kills, waits for or removes a job,
 *   never polls, never runs a timer, and never derives a process status from
 *   output bytes or elapsed time. An unrecognized native status is painted as
 *   the sanitized native value, never mapped onto `completed`.
 * - No guessed timing: a duration is shown only from native `startedAt` /
 *   `finishedAt`; a running row shows no locally computed elapsed time, because
 *   that would be a TUI-owned clock rather than a native fact.
 *
 * Identity and refresh:
 * - The selection is the opaque native job id, never a row index. A snapshot
 *   refresh keeps the selected id, preserves native registration order (no
 *   sorting by time/status), and a removed id falls back to the nearest
 *   still-listed row instead of resurrecting the old one.
 * - The output view is bound to the job id it was opened for. A page or error
 *   that arrives for a closed, switched or disposed view is dropped, so a late
 *   native read can never repaint or revive another view.
 *
 * DTOs: `JobsRead`, `InspectedJob`, `JobOutputSnapshot`, `JobOutputChunkView`,
 * `JobPhase` and `InspectionReason` are **type-only imports** of the backend
 * inspection adapter (`src/backend/native-inspection.ts`); there is no
 * hand-copied mirror. Nothing is `any`: a malformed runtime snapshot shape is
 * validated and skipped, never rendered raw, and no backend runtime is loaded
 * through this seam.
 *
 * Shared surfaces: chrome comes from `ModalListSurface`/`ModalFrame` (the same
 * popup used by Settings, Queue and the pickers), rows from `windowList` (so a
 * click can never point at a clipped row), and input from the shared
 * `modalList` keymap context via `modalAction`. No raw stdin listener, no
 * second editor, no hardcoded shortcut label and no stdout writes.
 *
 * @module dsh-tui/ui/jobs-dialog
 */
import {
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '#pi-tui'
import type {
  InspectionReason,
  InspectedJob,
  JobOutputChunkView,
  JobOutputSnapshot,
  JobPhase,
  JobsRead,
} from '../backend/native-inspection.ts'
import { createCcKeymap, type CcKeymap } from '../input/index.ts'
import { isInterruptKey, modalAction, type ResolvedModalAction } from './dialogs.ts'
import {
  ModalListSurface,
  windowList,
  type ListBlock,
  type ListBody,
} from './modal-list.ts'
import { CLOSE_ACTIONS, modalHeight, type ModalAction, type ModalSize } from './modal.ts'
import { fit, oneLine, sanitize, truncateToWidth, visibleWidth, wrap } from './text.ts'
import { bold, dim, t, type Style } from './theme.ts'

// ---------------------------------------------------------------------------
// Parent-facing view state (ephemeral; never a native job fact)

/** Parent-owned restore record for `captureView()` / `initialState`. */
export interface JobsViewState {
  readonly selectedId?: string
  readonly mode: 'list' | 'output'
  readonly outputJobId?: string
  readonly listScroll: number
  readonly outputScroll: number
}

export interface JobsDialogOptions {
  /** Initial native roster read (optional; `getSnapshot` wins when supplied). */
  snapshot?: JobsRead
  /** Live native roster read re-sampled on every paint; never cached as truth. */
  getSnapshot?: () => JobsRead | undefined
  /** Shared keymap; defaults to the CC defaults for tests/standalone hosts. */
  keymap?: CcKeymap
  /** Parent's phase-1 read flag, so "not read yet" never looks like "no jobs". */
  loading?: boolean
  /** Restore the list selection/scroll when the parent reopens this modal. */
  initialState?: JobsViewState
  /** Bounded modal height (defaults to the shared standard modal budget). */
  maxHeight?: number
  /** Hard per-page line bound for the output view (default 2000). */
  maxOutputLines?: number
  /**
   * Request the native output read for one job (`ctx.jobs.readAt`). Called at
   * most once per explicit open; the parent answers with `setOutput` or
   * `setOutputError`/`setOutputUnavailable`. Omit it to make the output view
   * unavailable (the row and chip stay inert, no fake key is advertised).
   */
  onOpenOutput?: (job: InspectedJob) => void
  /**
   * Explicit user refresh (the existing `app.redraw` binding, Ctrl+L by
   * default; remappable/disable-able through the normal keymap). The parent
   * owns the single-flight read and may also refresh the open output view via
   * `outputId`. There is no polling, timer or automatic re-read here; omitting
   * the callback keeps the key inert and advertises no refresh action.
   */
  onRefresh?: () => void
  /** Esc / Ctrl+C / configured local cancel. The parent hides and disposes this instance. */
  onClose: () => void
  /**
   * Explicit native interrupt (a configured `app.interrupt`, no shipped
   * default); defaults to closing. Default Ctrl+C is the local cancel.
   */
  onInterrupt?: () => void
  /** Optional repaint hook for hosts that own rendering. */
  onRenderRequest?: () => void
}

// ---------------------------------------------------------------------------
// Native DTOs
//
// The inspection adapter owns the read DTOs (type-only import above): no
// backend adapter, DSH runtime or Cordis service is loaded through this seam,
// and there is no hand-copied mirror to drift.

// ---------------------------------------------------------------------------
// Display helpers (pure, width-safe, no native state)

const KNOWN_STATUS: ReadonlySet<string> = new Set(['running', 'stopping', 'completed', 'killed', 'failed'])

const STATUS_GLYPH: Readonly<Record<string, string>> = {
  running: '◐',
  stopping: '◑',
  completed: '☑',
  killed: '⊘',
  failed: '✖',
  unknown: '?',
}

const DEFAULT_MAX_OUTPUT_LINES = 2000

/** Native status glyph; an unrecognized value never borrows `completed`. */
export function jobStatusGlyph(status: unknown): string {
  if (typeof status !== 'string' || status === '') return STATUS_GLYPH.unknown!
  return STATUS_GLYPH[status] ?? STATUS_GLYPH.unknown!
}

/** Native status text; unknown/blank is stated, never guessed. */
export function jobStatusText(status: unknown): string {
  if (typeof status !== 'string' || status.trim() === '') return 'status unknown'
  if (KNOWN_STATUS.has(status)) return status
  const text = oneLine(sanitize(status), 40)
  return text === '' ? 'status unknown' : text
}

/** Color role for a status; unknown stays muted (no success/error claim). */
export function jobStatusTone(status: unknown): Style {
  switch (status) {
    case 'running': return t.accentBright
    case 'stopping': return t.yellow
    case 'completed': return t.green
    case 'killed': return t.orange
    case 'failed': return t.redSoft
    default: return t.muted
  }
}

/** True only for a status the native registry itself defines as live work. */
export function jobIsLive(status: unknown): boolean {
  return status === 'running' || status === 'stopping'
}

/** Duration from native timestamps only; `''` when either side is unknown. */
export function formatJobDuration(startedAt: unknown, finishedAt: unknown): string {
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return ''
  if (typeof finishedAt !== 'number' || !Number.isFinite(finishedAt)) return ''
  const ms = finishedAt - startedAt
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
  const seconds = Math.round(ms / 1000)
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${Math.floor(seconds / 3600)}h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}m`
}

/**
 * Flatten non-consuming native chunks into display lines in native order.
 * A `gapBefore` chunk inserts one explicit gap line: the loss is stated, never
 * silently joined into the surrounding bytes. Channel labels are the native
 * stream names and are not painted here (the view is one text stream).
 */
export function jobOutputLines(chunks: readonly JobOutputChunkView[]): string[] {
  const parts: string[] = []
  for (const chunk of chunks) {
    if (chunk === null || typeof chunk !== 'object') continue
    if (chunk.gapBefore === true) parts.push('\n⋯ earlier output was lost ⋯\n')
    if (typeof chunk.text === 'string' && chunk.text !== '') parts.push(chunk.text)
  }
  if (parts.length === 0) return []
  const lines = parts.join('').split('\n')
  // Chunk streams end with a trailing newline in practice; that final empty
  // entry is not a written line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.map(line => sanitize(line).replace(/\t/g, '    '))
}

const numberText = (value: unknown): string => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return ''
  return String(Math.floor(value))
}

const byteLabel = (value: number): string => (value === 1 ? '1 byte' : `${value} bytes`)

// ---------------------------------------------------------------------------
// Dialog

/** Small display metadata of the accepted read; page bytes are not retained. */
interface OutputMeta {
  readonly lossy: boolean
  readonly truncated: boolean
  readonly from: number
  readonly next: number
  /** Native stream labels present in the accepted page, in native order. */
  readonly channels: readonly string[]
}

export class JobsDialog implements Component, Focusable {
  readonly capturesViewportInput = true
  readonly modalSize: ModalSize = 'standard'
  readonly keymap: CcKeymap

  private readonly tui: TUI
  private readonly options: JobsDialogOptions
  private readonly list: ModalListSurface
  private readonly maxOutputLines: number
  private snapshot: JobsRead | undefined
  private reading: boolean
  private selected: string | undefined
  private selectedIndex = 0
  private listScroll = 0
  private outputJobId: string | undefined
  private outputJob: InspectedJob | undefined
  private outputLines: readonly string[] = []
  private outputMeta: OutputMeta | undefined
  private outputError = ''
  private outputLoading = false
  private outputScroll = 0
  private paintedOutputScroll = 0
  private bodyHeight = 0
  private droppedLines = 0
  private focusedState = false
  private done = false
  private disposed = false

  constructor(tui: TUI, options: JobsDialogOptions) {
    this.tui = tui
    this.options = options
    this.keymap = options.keymap ?? createCcKeymap()
    const requestedLines = options.maxOutputLines
    this.maxOutputLines = typeof requestedLines === 'number' && Number.isFinite(requestedLines) && requestedLines > 0
      ? Math.floor(requestedLines)
      : DEFAULT_MAX_OUTPUT_LINES
    this.snapshot = options.snapshot
    this.reading = options.loading === true
    this.list = new ModalListSurface(tui, {
      size: this.modalSize,
      ...(options.maxHeight === undefined ? {} : { maxHeight: options.maxHeight }),
    })
    const initial = options.initialState
    if (initial !== undefined) {
      if (initial.selectedId !== undefined && typeof initial.selectedId === 'string') this.selected = initial.selectedId
      this.listScroll = Number.isFinite(initial.listScroll) ? Math.max(0, Math.floor(initial.listScroll)) : 0
      // The output page is parent state; a reopened modal restores the list
      // and the parent may call `openOutput(id)` itself. A stale page is never
      // replayed here.
    }
  }

  // -------------------------------------------------------------------------
  // Parent surface

  /** Live native snapshot: the getter when supplied, else the last assignment. */
  snapshotValue(): JobsRead | undefined {
    return this.options.getSnapshot === undefined ? this.snapshot : this.options.getSnapshot()
  }

  /** Replace the native roster (repeatable; keeps the selected native id). */
  setSnapshot(snapshot: JobsRead | undefined): void {
    if (this.done || this.disposed) return
    this.snapshot = snapshot
    this.reconcile()
    this.repaint()
  }

  /** Parent phase-1 read flag; never invents rows or an empty authoritative list. */
  setLoading(loading: boolean): void {
    if (this.done || this.disposed || this.reading === loading) return
    this.reading = loading
    this.list.invalidate()
    this.repaint()
  }

  /** Native jobs in native registration order, with invalid rows skipped. */
  jobs(): readonly InspectedJob[] {
    const snapshot = this.snapshotValue()
    if (snapshot === undefined) return []
    if (snapshot.available !== true) return []
    const rows = snapshot.jobs
    if (!Array.isArray(rows)) return []
    const out: InspectedJob[] = []
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const job = row as InspectedJob
      if (typeof job.id !== 'string' || job.id === '') continue
      out.push(job)
    }
    return out
  }

  get mode(): 'list' | 'output' {
    return this.outputJobId === undefined ? 'list' : 'output'
  }

  get selectedId(): string | undefined {
    return this.selectedJob()?.id
  }

  /** Native id of the open output view (parent refresh/read guard), if any. */
  get outputId(): string | undefined {
    return this.outputJobId
  }

  get isLoading(): boolean {
    return this.reading
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

  /** Ephemeral restore record for the parent (native selection + scrolls). */
  captureView(): JobsViewState {
    return {
      ...(this.selectedId === undefined ? {} : { selectedId: this.selectedId }),
      mode: this.mode,
      ...(this.outputJobId === undefined ? {} : { outputJobId: this.outputJobId }),
      listScroll: this.listScroll,
      outputScroll: this.paintedOutputScroll,
    }
  }

  /** Select one native job id (parent deep-link / restore). */
  selectJob(id: string | undefined): void {
    if (this.done || this.disposed) return
    if (id === undefined) {
      this.selected = undefined
    } else if (typeof id === 'string' && id !== '') {
      this.selected = id
    }
    this.reconcile()
    this.repaint()
  }

  /**
   * Open the explicit output view for one native job (default: the selection).
   * Clears any previous page and asks the parent for a native read exactly once.
   * No callback → no output view (the row stays selectable, no fake key).
   */
  openOutput(id?: string): void {
    if (this.done || this.disposed) return
    const requested = id ?? this.selectedId
    if (requested === undefined) return
    const job = this.jobs().find(row => row.id === requested)
    if (job === undefined) return
    if (this.options.onOpenOutput === undefined) return
    this.outputJobId = requested
    this.outputJob = job
    this.outputLines = []
    this.outputMeta = undefined
    this.outputError = ''
    this.outputScroll = Number.MAX_SAFE_INTEGER // pin to the tail on first paint
    this.paintedOutputScroll = 0
    this.droppedLines = 0
    this.outputLoading = true
    this.list.invalidate()
    this.repaint()
    try {
      this.options.onOpenOutput(job)
    } catch {
      // The parent owns the native read; a throwing callback must not break
      // the mounted modal. The view stays in its loading state until a page or
      // an explicit error arrives.
    }
  }

  /** Return to the list (Esc in the output view); never closes the modal. */
  closeOutput(): void {
    if (this.outputJobId === undefined) return
    this.outputJobId = undefined
    this.outputJob = undefined
    this.outputLines = []
    this.outputMeta = undefined
    this.outputError = ''
    this.outputLoading = false
    this.outputScroll = 0
    this.paintedOutputScroll = 0
    this.droppedLines = 0
    this.list.invalidate()
    this.repaint()
  }

  /**
   * Accept one native `ctx.jobs.readAt` snapshot **only** for the currently
   * open job and only while mounted. A late read for a closed, switched or
   * disposed view is dropped (no revival, no repaint, no error).
   */
  setOutput(jobId: string, page: JobOutputSnapshot): void {
    if (this.done || this.disposed) return
    if (this.outputJobId === undefined || this.outputJobId !== jobId) return
    if (page === null || typeof page !== 'object') return
    if (page.job !== undefined && page.job !== null && page.job.id !== jobId) return
    const lines = Array.isArray(page.chunks) ? jobOutputLines(page.chunks) : []
    const cap = this.maxOutputLines
    this.droppedLines = lines.length > cap ? lines.length - cap : 0
    this.outputLines = this.droppedLines > 0 ? lines.slice(lines.length - cap) : lines
    // The read carries the native projection at read time; adopt it as the
    // header fact. No page bytes/meta beyond these display fields are kept.
    if (page.job !== undefined && page.job !== null) this.outputJob = page.job
    const channels: string[] = []
    for (const chunk of Array.isArray(page.chunks) ? page.chunks : []) {
      if (chunk === null || typeof chunk !== 'object') continue
      const channel = chunk.channel
      // Native stream label only; an absent/unrecognized label is not invented.
      if (channel === 'stdout' || channel === 'stderr' || channel === 'log') {
        if (!channels.includes(channel)) channels.push(channel)
      }
    }
    this.outputMeta = {
      lossy: page.lossy === true,
      truncated: page.truncated === true,
      from: page.from,
      next: page.next,
      channels,
    }
    this.outputError = ''
    this.outputLoading = false
    // Newest output is the useful tail. The sentinel is resolved by the next
    // paint's clamp, and a page keypress works from the painted offset.
    this.outputScroll = Number.MAX_SAFE_INTEGER
    this.paintedOutputScroll = Number.MAX_SAFE_INTEGER
    this.list.invalidate()
    this.repaint()
  }

  /** Honest adapter failure for the currently open job (late failures dropped). */
  setOutputUnavailable(jobId: string, reason: InspectionReason): void {
    const code = oneLine(sanitize(String(reason ?? '')), 40) || 'native-failed'
    this.setOutputError(jobId, `Native output is unavailable (${code}).`)
  }

  /** Honest failure for the currently open job (a late error is dropped too). */
  setOutputError(jobId: string, message: string): void {
    if (this.done || this.disposed) return
    if (this.outputJobId === undefined || this.outputJobId !== jobId) return
    const text = oneLine(sanitize(typeof message === 'string' ? message : ''), 300)
    this.outputError = text === '' ? 'Native output could not be read.' : text
    this.outputLines = []
    this.outputMeta = undefined
    this.outputLoading = false
    this.list.invalidate()
    this.repaint()
  }

  invalidate(): void {
    this.list.invalidate()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.outputLines = []
    this.outputMeta = undefined
    if (this.focusedState) this.keymap.cancelChord()
  }

  // -------------------------------------------------------------------------
  // Selection

  private selectedJob(): InspectedJob | undefined {
    const jobs = this.jobs()
    if (jobs.length === 0) {
      this.selected = undefined
      this.selectedIndex = 0
      return undefined
    }
    if (this.selected !== undefined) {
      const found = jobs.findIndex(job => job.id === this.selected)
      if (found >= 0) {
        this.selectedIndex = found
        return jobs[found]
      }
    }
    // The selected id vanished: nearest still-listed row, never a resurrection.
    const index = Math.max(0, Math.min(this.selectedIndex, jobs.length - 1))
    this.selectedIndex = index
    this.selected = jobs[index]?.id
    return jobs[index]
  }

  private reconcile(): void {
    const selected = this.selectedJob()
    if (selected !== undefined) this.selected = selected.id
  }

  private move(delta: number): void {
    const jobs = this.jobs()
    if (jobs.length === 0) return
    const from = this.selectedIndex < 0 || this.selectedIndex >= jobs.length ? 0 : this.selectedIndex
    const next = ((from + delta) % jobs.length + jobs.length) % jobs.length
    this.selectedIndex = next
    this.selected = jobs[next]?.id
    if (next < this.listScroll) this.listScroll = next
    this.keymap.cancelChord()
    this.repaint()
  }

  private moveTo(index: number): void {
    const jobs = this.jobs()
    if (jobs.length === 0) return
    this.selectedIndex = Math.max(0, Math.min(index, jobs.length - 1))
    this.selected = jobs[this.selectedIndex]?.id
    if (this.selectedIndex < this.listScroll) this.listScroll = this.selectedIndex
    this.repaint()
  }

  private scrollOutput(delta: number): void {
    const max = Math.max(0, this.outputLines.length - Math.max(1, this.bodyHeight))
    const base = Math.max(0, Math.min(this.paintedOutputScroll, max))
    const next = Math.max(0, Math.min(base + delta, max))
    this.outputScroll = next
    this.paintedOutputScroll = next
    this.repaint()
  }

  private scrollOutputTo(edge: 'first' | 'last'): void {
    if (edge === 'last') {
      this.outputScroll = Number.MAX_SAFE_INTEGER
      this.paintedOutputScroll = Number.MAX_SAFE_INTEGER
      return void this.repaint()
    }
    this.outputScroll = 0
    this.paintedOutputScroll = 0
    this.repaint()
  }

  private repaint(): void {
    try {
      this.tui.requestRender()
    } catch {
      // A closing host may already have torn the renderer down.
    }
    this.options.onRenderRequest?.()
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

  /** Ask the parent for one explicit re-read; never a local poll or mutation. */
  private refresh(): void {
    if (this.done || this.disposed || this.options.onRefresh === undefined) return
    this.keymap.cancelChord()
    try {
      this.options.onRefresh()
    } catch {
      // The parent owns the read; a throwing callback must not break the modal.
    }
  }

  handleInput(raw: string): void {
    if (this.done || this.disposed) return
    if (isInterruptKey(this.keymap, raw)) {
      this.interrupt()
      return
    }
    const action = modalAction(this.keymap, raw, ['app.redraw'])
    if (action === undefined) return
    if (action.id === 'app.redraw') {
      this.refresh()
      return
    }
    if (this.mode === 'output') {
      this.inputOutput(action)
      return
    }
    switch (action.id) {
      case 'list.previous': this.move(-1); return
      case 'list.next': this.move(1); return
      case 'list.page-up': this.move(-5); return
      case 'list.page-down': this.move(5); return
      case 'list.first': this.moveTo(0); return
      case 'list.last': this.moveTo(this.jobs().length - 1); return
      case 'list.select':
      case 'dialog.confirm': this.openOutput(); return
      default:
        if (CLOSE_ACTIONS.has(action.id)) this.close()
        // Every other global/app action stays inert inside this read-only modal.
        return
    }
  }

  private inputOutput(action: ResolvedModalAction): void {
    switch (action.id) {
      case 'list.previous':
      case 'list.page-up': this.scrollOutput(-5); return
      case 'list.next':
      case 'list.page-down': this.scrollOutput(5); return
      case 'list.first': this.scrollOutputTo('first'); return
      case 'list.last': this.scrollOutputTo('last'); return
      case 'list.select':
      case 'dialog.confirm': return // Enter is inert in the read-only output view
      default:
        if (CLOSE_ACTIONS.has(action.id)) this.closeOutput()
        return
    }
  }

  // -------------------------------------------------------------------------
  // Rendering

  private heightCap(): number {
    const rows = this.tui.terminal?.rows
    if (!Number.isFinite(rows) || rows <= 0) return 200
    return Math.max(1, Math.floor(this.options.maxHeight ?? modalHeight(this.tui, this.modalSize)))
  }

  private frameTitle(): string {
    return this.mode === 'output' ? 'Job output' : 'Jobs'
  }

  private ownerKey(): string {
    return this.mode === 'output' ? `jobs:output:${this.outputJobId ?? ''}` : `jobs:list:${this.selectedId ?? ''}`
  }

  private frameActions(): ModalAction[] {
    const refresh: ModalAction[] = this.options.onRefresh === undefined ? [] : [
      { id: 'refresh', label: 'refresh', action: 'app.redraw', onActivate: () => this.refresh() },
    ]
    if (this.mode === 'output') {
      return [
        { id: 'back', label: 'back', action: 'list.cancel', onActivate: () => this.closeOutput() },
        ...refresh,
        { id: 'close', label: 'close', onActivate: () => this.close() },
      ]
    }
    // Without a native read callback there is no output capability, so the
    // chip keeps its label but advertises no key and stays inert.
    const output: ModalAction = this.options.onOpenOutput === undefined
      ? { id: 'output', label: 'output', disabled: true }
      : { id: 'output', label: 'output', action: 'list.select', onActivate: () => this.openOutput() }
    return [
      output,
      ...refresh,
      { id: 'close', label: 'close', action: 'list.cancel', onActivate: () => this.close() },
    ]
  }

  private headerLine(width: number): string {
    const jobs = this.jobs()
    const live = jobs.filter(job => jobIsLive(job.status)).length
    const parts = ['Native jobs']
    if (jobs.length > 0) parts.push(`${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}`)
    if (live > 0) parts.push(`${live} live`)
    const snapshot = this.snapshotValue()
    if (snapshot !== undefined && snapshot.available === true && snapshot.complete === false) parts.push('incomplete')
    return fit(dim(parts.join(' · ')), width)
  }

  private outputHeaderLines(width: number): [string, string] {
    const job = this.outputJob
    if (job === undefined) return [fit('', width), fit('', width)]
    const tone = jobStatusTone(job.status)
    const label = oneLine(sanitize(typeof job.label === 'string' ? job.label : ''), 200)
    const kind = oneLine(sanitize(typeof job.kind === 'string' ? job.kind : ''), 40)
    const name = label !== '' ? label : kind !== '' ? kind : '(unlabeled)'
    const meta = [jobStatusText(job.status), oneLine(sanitize(job.progress ?? ''), 60)].filter(part => part !== '')
    if (job.detail !== undefined && job.detail !== '') meta.push(oneLine(sanitize(job.detail), 80))
    const first = fit(`${t.accentBright('❯')} ${tone(jobStatusGlyph(job.status))} ${bold(name)} ${dim('· ' + meta.join(' · '))}`, width)
    const coords: string[] = []
    const total = numberText(job.output?.total)
    const earliest = numberText(job.output?.earliest)
    if (total !== '') coords.push(`${byteLabel(Number(total))} written`)
    if (earliest !== '' && Number(earliest) > 0) coords.push(`retained from byte ${earliest}`)
    if (this.outputMeta?.lossy === true || job.output?.evicted === true) coords.push('earlier output was lost')
    const jobId = oneLine(sanitize(job.id), 120)
    const from = numberText(this.outputMeta?.from)
    const next = numberText(this.outputMeta?.next)
    if (from !== '' && next !== '' && from !== next) coords.push(`offset ${from}→${next}`)
    if (this.outputMeta !== undefined && this.outputMeta.channels.length > 0) {
      coords.push(`streams ${this.outputMeta.channels.join('+')}`)
    }
    if (kind !== '' && kind !== name) coords.push(kind)
    coords.push(jobId)
    return [first, fit(`   ${dim(coords.join(' · '))}`, width)]
  }

  private listStatusLines(width: number): string[] {
    const snapshot = this.snapshotValue()
    if (this.reading) return [fit(` ${t.muted('Reading native jobs…')}`, width)]
    if (snapshot === undefined) {
      return [fit(` ${t.muted('Native jobs have not been read in this session.')}`, width)]
    }
    if (snapshot.available !== true) {
      const reason = oneLine(sanitize(String(snapshot.reason ?? '')), 40)
      const detail = reason === '' ? '' : ` (${reason})`
      return [fit(` ${t.yellow('Native jobs are unavailable')}${dim(detail)}`, width)]
    }
    if (this.jobs().length === 0) return [fit(` ${t.muted('No native background jobs.')}`, width)]
    return []
  }

  private outputStatusLines(width: number): string[] {
    const notes: string[] = []
    if (this.droppedLines > 0) {
      notes.push(`Showing the last ${this.outputLines.length} of ${this.outputLines.length + this.droppedLines} lines.`)
    }
    if (this.outputMeta?.truncated === true) notes.push('This page is bounded by the native read limit.')
    if (this.outputJobId !== undefined && !this.jobs().some(job => job.id === this.outputJobId)) {
      notes.push('This job is no longer in the native list.')
    }
    return notes.slice(0, 2).map(note => fit(` ${t.muted(note)}`, width))
  }

  private jobLines(job: InspectedJob, width: number, focused: boolean): string[] {
    const tone = jobStatusTone(job.status)
    const label = oneLine(sanitize(typeof job.label === 'string' ? job.label : ''), 200)
    const kind = oneLine(sanitize(typeof job.kind === 'string' ? job.kind : ''), 40)
    const name = label !== '' ? label : kind !== '' ? kind : '(unlabeled)'
    const meta = [jobStatusText(job.status), oneLine(sanitize(job.progress ?? ''), 60),
      formatJobDuration(job.startedAt, job.finishedAt)].filter(part => part !== '').join(' · ')
    const marker = focused ? t.accentBright('❯') : ' '
    const prefix = `${marker} ${tone(jobStatusGlyph(job.status))} `
    const lines: string[] = []
    const room = width - visibleWidth(prefix)
    if (room <= 0) return [fit(prefix, width)]
    const metaWidth = meta === '' ? 0 : Math.min(visibleWidth(meta), Math.max(0, Math.floor(width / 2)))
    const labelRoom = room - (metaWidth > 0 ? metaWidth + 3 : 0)
    if (meta !== '' && labelRoom >= 10) {
      const body = truncateToWidth(name, labelRoom, '…')
      const pad = Math.max(0, labelRoom - visibleWidth(body))
      lines.push(fit(prefix + (focused ? bold(t.accentBright(body)) : t.text(body))
        + ' '.repeat(pad) + dim(' │ ') + dim(truncateToWidth(meta, metaWidth, '…')), width))
    } else {
      lines.push(fit(prefix + (focused ? bold(t.accentBright(name)) : t.text(name)), width))
    }
    if (!focused) return lines
    const jobId = oneLine(sanitize(job.id), 120)
    const detail = [jobId, kind, meta !== '' && labelRoom < 10 ? meta : ''].filter(part => part !== '').join(' · ')
    if (detail !== '') lines.push(fit(`   ${dim(detail)}`, width))
    return lines
  }

  private buildList(width: number, height: number): ListBody {
    const jobs = this.jobs()
    if (height <= 0 || jobs.length === 0) return { lines: [] }
    const selected = this.selectedJob()
    const selectedIndex = this.selectedIndex
    const blocks: ListBlock[] = jobs.map((job, index) => ({
      lines: this.jobLines(job, width, index === selectedIndex || job === selected),
      focused: index === selectedIndex,
      index,
      key: job.id,
    }))
    const window = windowList(blocks, height, { start: this.listScroll })
    this.listScroll = window.start
    return { lines: window.lines, hits: window.hits }
  }

  private buildOutput(width: number, height: number): ListBody {
    if (height <= 0) return { lines: [] }
    this.bodyHeight = height
    if (this.outputError !== '') {
      return { lines: wrap(t.redSoft(this.outputError), Math.max(4, width - 1)).slice(0, 2).map(line => fit(' ' + line, width)) }
    }
    if (this.outputLoading) return { lines: [fit(` ${t.muted('Reading native output…')}`, width)] }
    if (this.outputMeta === undefined) return { lines: [fit(` ${t.muted('No output has been read yet.')}`, width)] }
    const lines = this.outputLines
    if (lines.length === 0) {
      const total = numberText(this.outputJob?.output?.total)
      const text = total === '' || total === '0'
        ? 'This job has written no output.'
        : 'No output at this offset.'
      return { lines: [fit(` ${t.muted(text)}`, width)] }
    }
    const maxScroll = Math.max(0, lines.length - height)
    // `Number.MAX_SAFE_INTEGER` is the "pin to the tail" sentinel; clamping it
    // is exactly the newest page, and any explicit scroll is clamped likewise.
    const scroll = Math.max(0, Math.min(this.paintedOutputScroll, maxScroll))
    this.paintedOutputScroll = scroll
    this.outputScroll = scroll
    return { lines: lines.slice(scroll, scroll + height).map(line => fit(' ' + line, width)) }
  }

  render(width: number): string[] {
    if (this.done || this.disposed) return []
    const size = Math.max(1, Math.floor(width))
    const cap = this.heightCap()
    const output = this.mode === 'output'
    return this.list.render(size, {
      title: this.frameTitle(),
      ownerKey: this.ownerKey(),
      beforeRows: output ? 2 : 1,
      before: bodyWidth => output ? this.outputHeaderLines(bodyWidth) : [this.headerLine(bodyWidth)],
      status: bodyWidth => output ? this.outputStatusLines(bodyWidth) : this.listStatusLines(bodyWidth),
      actions: this.frameActions(),
      onClose: () => this.close(),
      keymap: this.keymap,
    }, (bodyWidth, bodyHeight) => output ? this.buildOutput(bodyWidth, bodyHeight) : this.buildList(bodyWidth, bodyHeight))
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
      if (this.mode === 'output') this.scrollOutput(delta * 3)
      else this.move(delta)
      return { handled: true, render: true }
    }
    if (this.mode === 'output') {
      // No selectable rows in the read-only output view; claim the gesture so
      // it cannot leak into the composer's selection.
      return event.button === 'left' ? { handled: true, render: false } : undefined
    }
    const handled = this.list.rowMouse(event, this.ownerKey(), hit => {
      const index = hit.index
      if (index === undefined) return
      const job = this.jobs()[index]
      if (job === undefined) return
      const wasSelected = this.selectedId === job.id
      this.selected = job.id
      this.selectedIndex = index
      // A second click on the selected native row opens its output, matching
      // the chip and Enter; destructive actions do not exist here.
      if (wasSelected) this.openOutput(job.id)
      else this.repaint()
    })
    if (handled !== undefined) return handled
    return undefined
  }
}