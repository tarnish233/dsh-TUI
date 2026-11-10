/**
 * Read-only native **long-history** surface: one bounded turn outline plus one
 * explicitly opened turn projected into its **own** transcript store/view.
 *
 * Ownership boundary:
 * - DSH owns the durable session, the turn outline and the exact event windows.
 *   The parent owns every native read: it supplies the current `SessionInfo`,
 *   the already-read `HistoryTurnsResult`, and answers each bounded
 *   `HistoryWindowRequest` with `setWindow(requestId, result)` (or an honest
 *   `failWindow(requestId, message)`).
 * - This component owns **no** durable state. The detail `TranscriptStore` is a
 *   short-lived, read-only projection of exactly the native events returned for
 *   the opened turn. It is never the main live transcript, never reset/prepended
 *   by history, never persisted and never treated as a second source of truth.
 *   Closing the turn disposes it.
 * - No polling, timer, model call, provider/profile access, raw stdin listener,
 *   standalone hotkey layer or terminal write exists here. Input resolves in the
 *   shared `modalList` context through `modalAction`; rendering uses the shared
 *   `ModalListSurface`/`ModalFrame`, `ScrollView` and `TranscriptView`.
 *
 * Paging and identity:
 * - A turn is identified by its outline `(turn, seq)` pair; rows paint in native
 *   outline order and are never sorted.
 * - Opening a turn requests one anchor window at the outline `seq` with at most
 *   `HISTORY_PAGE_LIMIT` events before and after. Loaded events are clipped to
 *   `[turn.seq, nextTurn.seq)` (or the outline `asOfSeq`) and to a detected
 *   `turn/end`, then merged by native `seq`; duplicate/overlapping pages are
 *   ignored and order is always ascending native seq.
 * - Automatic paging stops at a proven boundary, when a page adds nothing, at
 *   the event/byte read cap, or after a bounded number of pages. Every stop is
 *   stated honestly (truncation marker) instead of presenting a partial turn as
 *   complete. `older`/`newer` footer actions appear only when the native window
 *   proves more events exist in that direction; there is no invented
 *   `hasNewer`.
 * - Every request carries a monotonically increasing `requestId`. A page that
 *   arrives after close, after another turn was opened, after a session change
 *   or after dispose is dropped (its id is no longer outstanding), so a late
 *   native read can never revive or repaint an obsolete view.
 *
 * @module dsh-tui/ui/history-dialog
 */
import {
  ScrollView,
  type Component,
  type Focusable,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '#pi-tui'
import type {
  HistoryTurnEntry,
  HistoryTurnsResult,
  HistoryWindowResult,
  JsonRecord,
  SessionEvent,
  SessionInfo,
  TranscriptCodec,
} from '../backend/types.ts'
import { createCcKeymap, type CcKeymap } from '../input/index.ts'
import { TranscriptStore } from '../state/transcript.ts'
import { isInterruptKey, modalAction, type ResolvedModalAction } from './dialogs.ts'
import {
  ModalListSurface,
  windowList,
  type ListBlock,
  type ListBody,
} from './modal-list.ts'
import { modalHeight, type ModalAction, type ModalSize } from './modal.ts'
import { TranscriptView } from './transcript.ts'
import { fit, oneLine, sanitize, truncateToWidth, wrap } from './text.ts'
import { bold, dim, t } from './theme.ts'

// ---------------------------------------------------------------------------
// Public contract

/**
 * Hard native page bound. The dialog never asks for more than this many events
 * on either side of an anchor; a larger caller value is clamped.
 */
export const HISTORY_PAGE_LIMIT = 50

export type HistoryWindowPage = 'anchor' | 'older' | 'newer'

/** One bounded native event-window read. The parent echoes `requestId` back. */
export interface HistoryWindowRequest {
  /**
   * Monotonic dialog-owned id. Pass it to `setWindow`/`failWindow`; a response
   * whose id is no longer outstanding is a late page and is ignored.
   */
  readonly requestId: number
  /** Exact native session this page belongs to. */
  readonly sessionId: string
  /** Durable attachment identity when the parent/outline provided one. */
  readonly attachmentId?: string
  /** Outline turn this page was requested for (parent diagnostics only). */
  readonly turn: number
  /**
   * Existing native seq to anchor the read on: the turn anchor for `anchor`,
   * the earliest loaded seq for `older`, or the latest loaded seq for `newer`
   * (the edge event is repeated and deduplicated by seq).
   */
  readonly targetSeq: number
  /** Events requested before `targetSeq`; always `<= HISTORY_PAGE_LIMIT`. */
  readonly before: number
  /** Events requested after `targetSeq`; always `<= HISTORY_PAGE_LIMIT`. */
  readonly after: number
  /** `anchor` opens a turn; `older`/`newer` continue one direction. */
  readonly page: HistoryWindowPage
}

export interface HistoryDialogOptions {
  /** Current native session. A session/attachment change invalidates detail reads. */
  session: SessionInfo
  /** Initial native turn outline (`HistoryTurnsResult`) when already read. */
  outline?: HistoryTurnsResult
  /** Parent's phase-1 read flag, so "not read yet" never looks like "no turns". */
  loading?: boolean
  /** Shared keymap; defaults to CC defaults for standalone hosts/tests. */
  keymap?: CcKeymap
  /** Bounded modal height (defaults to the shared wide budget). */
  maxHeight?: number
  /**
   * Request one native turn-outline read (explicit `app.redraw`, Ctrl+L by
   * default). The parent owns the read and answers with `setOutline` /
   * `setTurnsLoading` / `setTurnsError` / `setTurnsUnavailable`. There is no
   * automatic or periodic re-read.
   */
  loadTurns?: () => void
  /**
   * Request one bounded native event window. Called at most once per explicit
   * open plus at most one outstanding auto-page. The parent answers with
   * `setWindow(request.requestId, result)` or `failWindow(request.requestId, …)`.
   */
  loadWindow?: (request: HistoryWindowRequest) => void
  /** Esc / configured cancel. The parent hides and disposes this instance. */
  onClose: () => void
  /**
   * Explicit native interrupt (a configured `app.interrupt`; no shipped
   * default); defaults to closing. Default Ctrl+C is the local cancel.
   */
  onInterrupt?: () => void
  /** Optional repaint hook for hosts that own rendering. */
  onRenderRequest?: () => void
  /** Native transcript codec for the read-only detail projection. */
  codec?: TranscriptCodec
  /**
   * Build the read-only detail view. Defaults to a TranscriptView with
   * disclosure disabled and no advertised shortcut labels. The dialog disposes
   * exactly the view it created/received.
   */
  createView?: (store: TranscriptStore) => TranscriptView
  /** Total retained-event cap for one opened turn (default 1200). */
  maxEvents?: number
  /** Approximate retained JSON-text byte cap for one opened turn (default 1 MiB). */
  maxBytes?: number
  /** Automatic paging stop for one opened turn (default 40; manual nav may add one page). */
  maxPages?: number
}

export type HistoryTurnsState = 'unread' | 'loading' | 'ready' | 'unavailable' | 'failed'

// ---------------------------------------------------------------------------
// Defaults and display helpers

const DEFAULT_MAX_EVENTS = 1200
const DEFAULT_MAX_BYTES = 1024 * 1024
const DEFAULT_MAX_PAGES = 40
const CLOSE_ACTIONS: ReadonlySet<string> = new Set(['list.cancel', 'dialog.cancel', 'app.cancel'])

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const safeInt = (value: unknown, minimum = 0): number | undefined =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum ? value : undefined

const positiveInt = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback

const clampPage = (value: unknown): number => {
  const count = safeInt(value) ?? HISTORY_PAGE_LIMIT
  return Math.max(0, Math.min(HISTORY_PAGE_LIMIT, count))
}

const preview = (value: string): string => oneLine(sanitize(value), 240)

/** Approximate retained size; page bytes are never kept, only this budget input. */
function eventBytes(event: SessionEvent): number {
  try {
    return JSON.stringify(event).length
  } catch {
    return 1
  }
}

/** One native turn/step marker's turn number, when the event carries one. */
function eventTurn(event: SessionEvent): number | undefined {
  if (!isRecord(event.data)) return undefined
  const turn = event.data.turn
  return safeInt(turn)
}

interface NormalizedTurns {
  readonly entries: readonly HistoryTurnEntry[]
  readonly skipped: number
  readonly malformed: boolean
}

/** Validate native outline rows; malformed/duplicate-seq rows are counted, not painted. */
function normalizeTurns(source: readonly unknown[]): NormalizedTurns {
  const seen = new Set<number>()
  const entries: HistoryTurnEntry[] = []
  let skipped = 0
  for (const row of source) {
    if (!isRecord(row)) {
      skipped += 1
      continue
    }
    const turn = safeInt(row.turn)
    const seq = safeInt(row.seq)
    if (turn === undefined || seq === undefined || typeof row.prompt !== 'string' || typeof row.response !== 'string') {
      skipped += 1
      continue
    }
    if (seen.has(seq)) {
      skipped += 1
      continue
    }
    seen.add(seq)
    entries.push({ turn, seq, prompt: row.prompt, response: row.response })
  }
  return { entries, skipped, malformed: entries.length === 0 && source.length > 0 }
}

interface PageRows {
  readonly events: readonly SessionEvent[]
  readonly skipped: number
}

/** Validate the window envelope and each event's native identity. */
function normalizeWindowEvents(value: unknown): PageRows | undefined {
  if (!Array.isArray(value)) return undefined
  const events: SessionEvent[] = []
  let skipped = 0
  for (const row of value) {
    if (!isRecord(row) || safeInt(row.seq) === undefined || typeof row.type !== 'string' || row.type === '') {
      skipped += 1
      continue
    }
    events.push(row as unknown as SessionEvent)
  }
  return { events, skipped }
}

// ---------------------------------------------------------------------------
// Dialog

interface DetailState {
  readonly entry: HistoryTurnEntry
  readonly token: number
  readonly sessionId: string
  readonly attachmentId?: string
  readonly lowerBound: number
  upperBound?: number
}

export class HistoryDialog implements Component, Focusable {
  readonly capturesViewportInput = true
  readonly modalSize: ModalSize = 'wide'
  readonly keymap: CcKeymap

  private readonly tui: TUI
  private readonly options: HistoryDialogOptions
  private readonly surface: ModalListSurface
  private readonly maxEvents: number
  private readonly maxBytes: number
  private readonly maxPages: number

  private sessionValue: SessionInfo
  private outlineValue: HistoryTurnsResult | undefined
  private entries: readonly HistoryTurnEntry[] = []
  private outlineSkipped = 0
  private outlineAsOfSeq: number | undefined
  private outlineAttachmentId: string | undefined
  private turnsState: HistoryTurnsState
  private turnsReason = ''
  private turnsError = ''
  private selectedSeqValue: number | undefined
  private selectedIndex = 0
  private listScroll = 0

  // Detail (one explicitly opened turn)
  private detail: DetailState | undefined
  private detailEvents = new Map<number, SessionEvent>()
  private detailBytes = 0
  private detailRequests = new Map<number, HistoryWindowRequest>()
  private detailManualRequests = new Set<number>()
  private detailPages = 0
  private detailReady = false
  private detailLoading = false
  private detailError = ''
  private detailNotice = ''
  private detailTruncated = false
  private detailCapHit = false
  private detailTruncation = ''
  private detailNoOlder = false
  private detailNoNewer = false
  private detailLastOlderHasOlder = false
  private detailLastForwardHasAfter = false
  private detailInherited = 0
  private detailStore: TranscriptStore | undefined
  private detailView: TranscriptView | undefined
  private detailScrollView: ScrollView | undefined
  private detailScrollTop = 0
  private detailPaintedTop = 0
  private detailBodyHeight = 0
  private detailContentLength = 0

  private requestCounter = 0
  private detailToken = 0
  private focusedState = false
  private done = false
  private disposed = false

  constructor(tui: TUI, options: HistoryDialogOptions) {
    this.tui = tui
    this.options = options
    this.keymap = options.keymap ?? createCcKeymap()
    this.sessionValue = options.session
    this.maxEvents = positiveInt(options.maxEvents, DEFAULT_MAX_EVENTS)
    this.maxBytes = positiveInt(options.maxBytes, DEFAULT_MAX_BYTES)
    this.maxPages = positiveInt(options.maxPages, DEFAULT_MAX_PAGES)
    this.turnsState = options.outline !== undefined ? 'ready' : options.loading === true ? 'loading' : 'unread'
    this.surface = new ModalListSurface(tui, {
      size: this.modalSize,
      ...(options.maxHeight === undefined ? {} : { maxHeight: options.maxHeight }),
    })
    if (options.outline !== undefined) this.setOutline(options.outline)
  }

  // -------------------------------------------------------------------------
  // Parent surface

  get isDone(): boolean {
    return this.done
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  get mode(): 'list' | 'turn' {
    return this.detail === undefined ? 'list' : 'turn'
  }

  get selectedSeq(): number | undefined {
    return this.selectedSeqValue
  }

  get selectedTurn(): HistoryTurnEntry | undefined {
    return this.entries[this.selectedIndex]
  }

  get detailTurn(): HistoryTurnEntry | undefined {
    return this.detail?.entry
  }

  get detailEventCount(): number {
    return this.detailEvents.size
  }

  get detailEventSeqs(): readonly number[] {
    return [...this.detailEvents.keys()].sort((left, right) => left - right)
  }

  get detailHasOlder(): boolean {
    return this.hasOlder()
  }

  get detailHasNewer(): boolean {
    return this.hasNewer()
  }

  get detailIsTruncated(): boolean {
    return this.detailTruncated
  }

  get detailMessage(): string {
    return this.detailError
  }

  get turnsStatus(): HistoryTurnsState {
    return this.turnsState
  }

  get outline(): HistoryTurnsResult | undefined {
    return this.outlineValue
  }

  /** Reader for tests/hosts that need the derived projection, never shared with the live store. */
  get store(): TranscriptStore | undefined {
    return this.detailStore
  }

  get view(): TranscriptView | undefined {
    return this.detailView
  }

  get focused(): boolean {
    return this.focusedState
  }

  set focused(value: boolean) {
    if (value === this.focusedState) return
    if (!value) this.cancelChord()
    this.focusedState = value
  }

  cancelChord(): void {
    this.keymap.cancelChord()
  }

  /** Replace the current session. A changed id/attachment discards all history state. */
  setSession(session: SessionInfo, outline?: HistoryTurnsResult): void {
    if (this.done || this.disposed) return
    const changed = session.sessionId !== this.sessionValue.sessionId
      || session.attachmentId !== this.sessionValue.attachmentId
    this.sessionValue = session
    if (!changed) {
      if (outline !== undefined) this.setOutline(outline)
      this.repaint()
      return
    }
    this.clearDetail()
    this.outlineValue = undefined
    this.entries = []
    this.outlineSkipped = 0
    this.outlineAsOfSeq = undefined
    this.outlineAttachmentId = undefined
    this.turnsState = outline === undefined && this.options.loading === true ? 'loading' : 'unread'
    this.turnsReason = ''
    this.turnsError = ''
    this.selectedSeqValue = undefined
    this.selectedIndex = 0
    this.listScroll = 0
    this.surface.invalidate()
    if (outline !== undefined) this.setOutline(outline)
    this.repaint()
  }

  /** Accept one native turn outline (initial read, refresh or explicit retry). */
  setOutline(outline: HistoryTurnsResult): void {
    if (this.done || this.disposed) return
    if (!isRecord(outline)) {
      this.turnsState = 'failed'
      this.turnsError = 'Native turn history is malformed.'
      this.entries = []
      this.selectedSeqValue = undefined
      this.selectedIndex = 0
      this.surface.invalidate()
      this.repaint()
      return
    }
    const sessionId = outline.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      this.turnsState = 'failed'
      this.turnsError = 'Native turn history has no session identity.'
      this.entries = []
      this.surface.invalidate()
      this.repaint()
      return
    }
    if (sessionId !== this.sessionValue.sessionId) {
      this.turnsState = 'failed'
      this.turnsError = 'Native turn history belongs to a different session.'
      this.entries = []
      this.selectedSeqValue = undefined
      this.selectedIndex = 0
      this.surface.invalidate()
      this.repaint()
      return
    }
    const expectedAttachment = this.sessionValue.attachmentId
    if (outline.attachmentId !== undefined && expectedAttachment !== undefined
      && outline.attachmentId !== expectedAttachment) {
      this.turnsState = 'failed'
      this.turnsError = 'Native turn history belongs to a different session attachment.'
      this.entries = []
      this.selectedSeqValue = undefined
      this.selectedIndex = 0
      this.surface.invalidate()
      this.repaint()
      return
    }
    if (outline.available !== true) {
      const runtime = outline as unknown as JsonRecord
      const reason = typeof runtime.reason === 'string' ? oneLine(sanitize(runtime.reason), 60) : ''
      this.outlineValue = outline
      this.entries = []
      this.outlineSkipped = 0
      this.outlineAsOfSeq = undefined
      this.outlineAttachmentId = outline.attachmentId
      this.selectedSeqValue = undefined
      this.selectedIndex = 0
      this.turnsState = 'unavailable'
      this.turnsReason = reason
      this.turnsError = ''
      this.surface.invalidate()
      this.repaint()
      return
    }
    if (!Array.isArray(outline.entries)) {
      this.turnsState = 'failed'
      this.turnsError = 'Native turn history is malformed.'
      this.entries = []
      this.selectedSeqValue = undefined
      this.selectedIndex = 0
      this.surface.invalidate()
      this.repaint()
      return
    }
    const normalized = normalizeTurns(outline.entries)
    this.outlineValue = outline
    this.outlineAttachmentId = outline.attachmentId
    this.outlineAsOfSeq = safeInt(outline.asOfSeq)
    this.outlineSkipped = normalized.skipped
    this.turnsReason = ''
    this.turnsError = ''
    if (normalized.malformed) {
      this.entries = []
      this.turnsState = 'failed'
      this.turnsError = 'Native turn history is malformed; no turn row could be read.'
      this.selectedSeqValue = undefined
      this.selectedIndex = 0
      this.surface.invalidate()
      this.repaint()
      return
    }
    this.entries = normalized.entries
    this.turnsState = 'ready'
    this.reconcileSelection()
    this.surface.invalidate()
    this.repaint()
  }

  /** Parent phase flag; never invents rows or an empty authoritative list. */
  setTurnsLoading(loading: boolean): void {
    if (this.done || this.disposed) return
    if (loading) {
      this.turnsState = 'loading'
    } else if (this.turnsState === 'loading') {
      this.turnsState = this.entries.length > 0 || this.outlineValue !== undefined ? 'ready' : 'unread'
    }
    this.surface.invalidate()
    this.repaint()
  }

  /** Honest adapter failure while keeping already-known native rows visible. */
  setTurnsError(message: string): void {
    if (this.done || this.disposed) return
    this.turnsState = 'failed'
    this.turnsError = oneLine(sanitize(typeof message === 'string' ? message : ''), 300)
      || 'Native turn history could not be read.'
    this.surface.invalidate()
    this.repaint()
  }

  /** Honest unavailability while keeping already-known native rows visible. */
  setTurnsUnavailable(reason?: string): void {
    if (this.done || this.disposed) return
    this.turnsState = 'unavailable'
    this.turnsReason = typeof reason === 'string' ? oneLine(sanitize(reason), 60) : ''
    this.turnsError = ''
    this.surface.invalidate()
    this.repaint()
  }

  /**
   * Accept one native window page only while its request is outstanding for the
   * currently opened turn and session. Everything else is a late page.
   */
  setWindow(requestId: number, result: HistoryWindowResult): void {
    if (this.done || this.disposed) return
    const request = this.takeRequest(requestId)
    if (request === undefined) return
    if (!isRecord(result)) return this.failDetail('Native history window is malformed.')
    const sessionId = result.sessionId
    if (typeof sessionId !== 'string' || sessionId !== request.sessionId) {
      return this.failDetail('Native history window belongs to a different session.')
    }
    const expectedAttachment = request.attachmentId
    if (result.attachmentId !== undefined && expectedAttachment !== undefined
      && result.attachmentId !== expectedAttachment) {
      return this.failDetail('Native history window belongs to a different session attachment.')
    }
    const targetSeq = safeInt(result.targetSeq)
    const startSeq = safeInt(result.startSeq)
    const endSeq = safeInt(result.endSeq)
    if (targetSeq === undefined || startSeq === undefined || endSeq === undefined) {
      return this.failDetail('Native history window is malformed.')
    }
    const page = normalizeWindowEvents(result.events)
    if (page === undefined) return this.failDetail('Native history window is malformed.')
    if (page.events.length === 0 && result.events.length > 0) {
      return this.failDetail('Native history window is malformed.')
    }
    this.acceptPage(request, result, startSeq, endSeq, page)
  }

  /** Honest failure for one outstanding window request; late ids are ignored. */
  failWindow(requestId: number, message: string): void {
    if (this.done || this.disposed) return
    const request = this.takeRequest(requestId)
    if (request === undefined) return
    this.failDetail(oneLine(sanitize(typeof message === 'string' ? message : ''), 300)
      || 'Native history window could not be read.')
  }

  /** Explicit native outline refresh through the shared `app.redraw` binding. */
  reloadTurns(): void {
    if (this.done || this.disposed || this.options.loadTurns === undefined) return
    this.keymap.cancelChord()
    this.turnsState = 'loading'
    this.surface.invalidate()
    this.repaint()
    try {
      this.options.loadTurns()
    } catch {
      this.turnsState = 'failed'
      this.turnsError = 'Native turn history could not be read.'
      this.repaint()
    }
  }

  /** Select one native turn by its exact outline seq (parent deep link/restore). */
  selectTurn(seq: number): void {
    if (this.done || this.disposed) return
    const index = this.entries.findIndex(entry => entry.seq === seq)
    if (index < 0) return
    this.selectedIndex = index
    this.selectedSeqValue = this.entries[index]?.seq
    if (this.selectedIndex < this.listScroll) this.listScroll = this.selectedIndex
    this.repaint()
  }

  /** Open the selected turn in its own read-only transcript surface. */
  openSelectedTurn(): void {
    if (this.done || this.disposed) return
    // A disabled footer chip/Enter path must not open a detail it cannot read.
    if (typeof this.options.loadWindow !== 'function') return
    const entry = this.selectedTurn
    if (entry === undefined) return
    if (this.detail?.entry.seq === entry.seq && this.detail.entry.turn === entry.turn) return
    this.openTurn(entry)
  }

  /** Return to the outline; never closes the modal. */
  closeTurn(): void {
    if (this.detail === undefined) return
    this.clearDetail()
    this.surface.invalidate()
    this.repaint()
  }

  invalidate(): void {
    if (this.disposed) return
    this.surface.invalidate()
    this.detailView?.invalidate()
    this.repaint()
  }

  /** Idempotent teardown; never calls `onClose`/`onInterrupt`. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.cancelChord()
    this.clearDetail()
    this.surface.invalidate()
  }

  // -------------------------------------------------------------------------
  // Selection

  private reconcileSelection(): void {
    const entries = this.entries
    if (entries.length === 0) {
      this.selectedSeqValue = undefined
      this.selectedIndex = 0
      return
    }
    if (this.selectedSeqValue !== undefined) {
      const found = entries.findIndex(entry => entry.seq === this.selectedSeqValue)
      if (found >= 0) {
        this.selectedIndex = found
        return
      }
    }
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, entries.length - 1))
    this.selectedSeqValue = entries[this.selectedIndex]?.seq
  }

  private move(delta: number): void {
    const entries = this.entries
    if (entries.length === 0) return
    const from = this.selectedIndex < 0 || this.selectedIndex >= entries.length ? 0 : this.selectedIndex
    const next = ((from + delta) % entries.length + entries.length) % entries.length
    this.selectedIndex = next
    this.selectedSeqValue = entries[next]?.seq
    if (next < this.listScroll) this.listScroll = next
    this.cancelChord()
    this.repaint()
  }

  private moveTo(index: number): void {
    if (this.entries.length === 0) return
    this.selectedIndex = Math.max(0, Math.min(index, this.entries.length - 1))
    this.selectedSeqValue = this.entries[this.selectedIndex]?.seq
    if (this.selectedIndex < this.listScroll) this.listScroll = this.selectedIndex
    this.repaint()
  }

  // -------------------------------------------------------------------------
  // Detail lifecycle and paging

  private nextOutlineSeq(entry: HistoryTurnEntry): number | undefined {
    const index = this.entries.findIndex(candidate => candidate.seq === entry.seq && candidate.turn === entry.turn)
    const start = index < 0 ? 0 : index + 1
    for (let cursor = start; cursor < this.entries.length; cursor += 1) {
      const candidate = this.entries[cursor]
      if (candidate !== undefined && candidate.seq > entry.seq) return candidate.seq
    }
    return undefined
  }

  private openTurn(entry: HistoryTurnEntry): void {
    this.clearDetail()
    const token = ++this.detailToken
    const next = this.nextOutlineSeq(entry)
    let upper: number | undefined
    if (next !== undefined) upper = next
    else if (this.outlineAsOfSeq !== undefined && this.outlineAsOfSeq >= entry.seq) upper = this.outlineAsOfSeq + 1
    const attachmentId = this.outlineAttachmentId ?? this.sessionValue.attachmentId
    this.detail = {
      entry,
      token,
      sessionId: this.sessionValue.sessionId,
      ...(attachmentId === undefined ? {} : { attachmentId }),
      lowerBound: entry.seq,
      ...(upper === undefined ? {} : { upperBound: upper }),
    }
    this.detailEvents = new Map()
    this.detailBytes = 0
    this.detailRequests = new Map()
    this.detailManualRequests = new Set()
    this.detailPages = 0
    this.detailReady = false
    this.detailLoading = false
    this.detailError = ''
    this.detailNotice = ''
    this.detailTruncated = false
    this.detailCapHit = false
    this.detailTruncation = ''
    this.detailNoOlder = false
    this.detailNoNewer = false
    this.detailLastOlderHasOlder = false
    this.detailLastForwardHasAfter = false
    this.detailInherited = 0
    this.detailScrollTop = 0
    this.detailPaintedTop = 0
    this.detailBodyHeight = 0
    this.detailContentLength = 0

    const store = new TranscriptStore({
      ...(this.options.codec === undefined ? {} : { codec: this.options.codec }),
    })
    const view = this.options.createView?.(store) ?? new TranscriptView(store, {
      showThinking: true,
      expandTools: false,
      groupTools: false,
      groupSubagentMessages: false,
      screen: 'inline',
      // The detail is a read-only projection: disclosure keys are not routed
      // from this modal, so no hint advertises a shortcut it cannot run.
      mouseBlocked: true,
      // Disclosure of this projection is local and inert: it never reads,
      // writes, retains, clears or transfers the module-level tool/thinking
      // maps the live transcript paints from, and it owns no expansion hitbox.
      readonlyDisclosure: true,
      onRenderRequest: () => this.repaint(),
    })
    // Also enforce it for a host-supplied `createView`: the dialog owns the
    // read-only guarantee, not the factory.
    view.setReadonlyDisclosure(true)
    this.detailStore = store
    this.detailView = view
    this.detailScrollView = new ScrollView(view, { scrollbar: 'hidden', follow: 'none' })
    this.surface.invalidate()
    this.repaint()
    this.requestPage('anchor')
  }

  private clearDetail(): void {
    this.detailToken += 1
    this.detail = undefined
    this.detailEvents = new Map()
    this.detailBytes = 0
    this.detailRequests = new Map()
    this.detailManualRequests = new Set()
    this.detailPages = 0
    this.detailReady = false
    this.detailLoading = false
    this.detailError = ''
    this.detailNotice = ''
    this.detailTruncated = false
    this.detailCapHit = false
    this.detailTruncation = ''
    this.detailNoOlder = false
    this.detailNoNewer = false
    this.detailLastOlderHasOlder = false
    this.detailLastForwardHasAfter = false
    this.detailInherited = 0
    this.detailScrollTop = 0
    this.detailPaintedTop = 0
    this.detailBodyHeight = 0
    this.detailContentLength = 0
    this.detailScrollView = undefined
    const view = this.detailView
    this.detailView = undefined
    this.detailStore = undefined
    try {
      view?.dispose()
    } catch {
      // A host may already have torn the view down; the modal stays closable.
    }
  }

  private takeRequest(requestId: unknown): HistoryWindowRequest | undefined {
    const id = safeInt(requestId)
    if (id === undefined) return undefined
    const request = this.detailRequests.get(id)
    if (request === undefined) return undefined
    this.detailRequests.delete(id)
    return request
  }

  private requestPage(page: HistoryWindowPage, manual = false): void {
    const detail = this.detail
    if (detail === undefined || this.detailError !== '' || this.detailRequests.size > 0) return
    if (!manual && this.detailTruncated) return
    if (manual && this.detailCapHit) {
      this.detailNotice = 'The native read cap was reached; no more events can be loaded.'
      this.repaint()
      return
    }
    const min = this.minLoadedSeq()
    const max = this.maxLoadedSeq()
    const targetSeq = page === 'older'
      ? (min ?? detail.entry.seq)
      : page === 'newer'
        // Re-anchor on the latest *loaded* seq. DSH's readEvent requires an
        // existing target event and includes it, so asking for max + 1 could
        // fail at the real end of the log. The edge event is deduplicated.
        ? (max ?? detail.entry.seq)
        : detail.entry.seq
    const before = page === 'newer' ? 0 : clampPage(HISTORY_PAGE_LIMIT)
    const after = page === 'older' ? 0 : clampPage(HISTORY_PAGE_LIMIT)
    const requestId = ++this.requestCounter
    const request: HistoryWindowRequest = {
      requestId,
      sessionId: detail.sessionId,
      ...(detail.attachmentId === undefined ? {} : { attachmentId: detail.attachmentId }),
      turn: detail.entry.turn,
      targetSeq,
      before,
      after,
      page,
    }
    this.detailRequests.set(requestId, request)
    if (manual) this.detailManualRequests.add(requestId)
    this.detailPages += 1
    this.detailLoading = true
    this.detailError = ''
    this.repaint()
    const load = this.options.loadWindow
    if (typeof load !== 'function') {
      this.detailRequests.delete(requestId)
      this.failDetail('Native history window reads are unavailable.')
      return
    }
    try {
      load(request)
    } catch {
      this.detailRequests.delete(requestId)
      this.failDetail('Native history window could not be read.')
    }
  }

  private acceptPage(
    request: HistoryWindowRequest,
    result: HistoryWindowResult,
    startSeq: number,
    endSeq: number,
    page: PageRows,
  ): void {
    const detail = this.detail
    if (detail === undefined || detail.token !== this.detailToken) return
    const manual = this.detailManualRequests.delete(request.requestId)
    if (page.events.length === 0 && result.events.length > 0) {
      return this.failDetail('Native history window is malformed.')
    }
    this.detailInherited = safeInt(result.inheritedEventCount) ?? this.detailInherited
    if (request.page !== 'newer') this.detailLastOlderHasOlder = result.hasOlder === true
    if (page.skipped > 0) {
      this.detailNotice = page.skipped === 1
        ? 'One malformed native window row was skipped.'
        : `${page.skipped} malformed native window rows were skipped.`
    }

    const sorted = [...page.events].sort((left, right) => left.seq - right.seq)
    let added = 0
    let capReason = ''
    for (const event of sorted) {
      if (event.seq < detail.lowerBound) continue
      if (detail.upperBound !== undefined && event.seq >= detail.upperBound) continue
      const turnStart = event.type === 'turn/start' ? eventTurn(event) : undefined
      if (turnStart !== undefined && turnStart > detail.entry.turn) {
        this.setUpperBound(event.seq)
        continue
      }
      if (this.detailEvents.has(event.seq)) continue
      const bytes = eventBytes(event)
      if (this.detailEvents.size + 1 > this.maxEvents) {
        capReason = 'events'
        break
      }
      if (this.detailBytes + bytes > this.maxBytes) {
        capReason = 'bytes'
        break
      }
      this.detailEvents.set(event.seq, event)
      this.detailBytes += bytes
      added += 1
      if (event.type === 'turn/end') {
        const turn = eventTurn(event)
        if (turn === undefined || turn === detail.entry.turn) this.setUpperBound(event.seq + 1)
      }
    }
    if (capReason !== '') {
      this.detailTruncated = true
      this.detailCapHit = true
      this.detailTruncation = capReason
    } else if (manual && this.detailTruncation === 'pages') {
      // A successful explicit page may complete what automatic paging stopped
      // at; the automatic stop marker is re-added by `pump` only if still true.
      this.detailTruncated = false
      this.detailTruncation = ''
    }
    this.detailReady = true
    this.detailLoading = false
    if (request.page === 'older') {
      if (added === 0 || startSeq <= detail.lowerBound) this.detailNoOlder = true
    } else if (request.page === 'newer') {
      if (added === 0) {
        this.detailNoNewer = true
        const max = this.maxLoadedSeq()
        if (capReason === '' && detail.upperBound !== undefined && max !== undefined && max + 1 < detail.upperBound) {
          // A native readWindowMax of 0 can return the same valid anchor again.
          // The outline cut still proves unread events: stop boundedly, but do
          // not turn a no-progress page into a false claim of a complete turn.
          this.detailTruncated = true
          this.detailTruncation = 'progress'
        }
      }
    } else if (this.detailEvents.size === 0) {
      this.detailNoOlder = true
      this.detailNoNewer = true
    }
    if (request.page !== 'older') {
      // The native window includes its target and is contiguous, so
      // `endSeq > targetSeq` is real window proof of newer events — never a
      // guess from the requested page size or a nonexistent `hasNewer`.
      this.detailLastForwardHasAfter = endSeq > request.targetSeq
    }
    if (detail.upperBound !== undefined && this.maxLoadedSeq() !== undefined
      && (this.maxLoadedSeq() ?? 0) + 1 >= detail.upperBound) {
      this.detailNoNewer = true
    }
    this.rebuildDetailStore()
    this.repaint()
    this.pump()
  }

  private setUpperBound(value: number): void {
    const detail = this.detail
    if (detail === undefined) return
    detail.upperBound = detail.upperBound === undefined ? value : Math.min(detail.upperBound, value)
  }

  private minLoadedSeq(): number | undefined {
    let min: number | undefined
    for (const seq of this.detailEvents.keys()) min = min === undefined ? seq : Math.min(min, seq)
    return min
  }

  private maxLoadedSeq(): number | undefined {
    let max: number | undefined
    for (const seq of this.detailEvents.keys()) max = max === undefined ? seq : Math.max(max, seq)
    return max
  }

  private hasOlder(): boolean {
    if (this.detail === undefined || this.detailError !== '' || this.detailNoOlder) return false
    const min = this.minLoadedSeq()
    return min !== undefined && min > this.detail.lowerBound && this.detailLastOlderHasOlder
  }

  private hasNewer(): boolean {
    const detail = this.detail
    if (detail === undefined || this.detailError !== '' || this.detailNoNewer) return false
    const max = this.maxLoadedSeq()
    if (max === undefined) return false
    if (detail.upperBound !== undefined) return max + 1 < detail.upperBound
    return this.detailLastForwardHasAfter
  }

  private wantsOlder(): boolean {
    return this.hasOlder()
  }

  private wantsNewer(): boolean {
    const detail = this.detail
    if (detail === undefined || this.detailError !== '' || this.detailNoNewer) return false
    const max = this.maxLoadedSeq()
    if (max === undefined) return false
    if (detail.upperBound !== undefined) return max + 1 < detail.upperBound
    // No outline tail bound: a contiguous native window that ended after its
    // target proves newer events. A window ending at its target proves none.
    return this.detailLastForwardHasAfter
  }

  /**
   * One automatic page per response. A synchronous parent response re-enters
   * here, so the recursion depth is exactly the bounded page budget.
   */
  private pump(): void {
    const detail = this.detail
    if (detail === undefined || this.detailRequests.size > 0 || this.detailError !== '' || this.detailCapHit) return
    const older = this.wantsOlder()
    const newer = this.wantsNewer()
    if (!older && !newer) return
    if (this.detailPages >= this.maxPages) {
      this.detailTruncated = true
      this.detailTruncation = 'pages'
      this.repaint()
      return
    }
    this.requestPage(older ? 'older' : 'newer')
  }

  /** Explicit footer navigation. Proof is checked by the caller/action visibility. */
  private navigate(direction: 'older' | 'newer'): void {
    if (this.detail === undefined || this.detailRequests.size > 0) return
    if (direction === 'older' && !this.hasOlder()) return
    if (direction === 'newer' && !this.hasNewer()) return
    if (direction === 'older') this.detailNoOlder = false
    else this.detailNoNewer = false
    this.requestPage(direction, true)
  }

  private failDetail(message: string): void {
    this.detailError = oneLine(sanitize(message), 300) || 'Native history could not be read.'
    this.detailLoading = false
    this.detailRequests.clear()
    this.detailManualRequests.clear()
    this.detailReady = this.detailEvents.size > 0 || this.detailReady
    this.repaint()
  }

  /**
   * Re-project the accepted native events into the detail's own read-only store.
   * The main live transcript is never touched: this store is created per open
   * turn and destroyed with it.
   */
  private rebuildDetailStore(): void {
    const detail = this.detail
    const store = this.detailStore
    const view = this.detailView
    if (detail === undefined || store === undefined || view === undefined) return
    const events = [...this.detailEvents.values()].sort((left, right) => left.seq - right.seq)
    const info: SessionInfo = {
      sessionId: detail.sessionId,
      cwd: this.sessionValue.cwd,
      provider: this.sessionValue.provider,
      model: this.sessionValue.model,
      capabilities: [],
      ...(detail.attachmentId === undefined ? {} : { attachmentId: detail.attachmentId }),
      events,
      ...(this.detailTruncated ? { truncated: true } : {}),
    }
    store.reset(info)
    view.invalidate()
  }

  // -------------------------------------------------------------------------
  // Input

  private close(): void {
    if (this.done || this.disposed) return
    this.done = true
    this.cancelChord()
    this.clearDetail()
    this.options.onClose()
  }

  private interrupt(): void {
    this.cancelChord()
    if (this.options.onInterrupt !== undefined) this.options.onInterrupt()
    else this.close()
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
      this.reloadTurns()
      return
    }
    if (this.detail !== undefined) {
      this.inputDetail(action)
      return
    }
    switch (action.id) {
      case 'list.previous': this.move(-1); return
      case 'list.next': this.move(1); return
      case 'list.page-up': this.move(-5); return
      case 'list.page-down': this.move(5); return
      case 'list.first': this.moveTo(0); return
      case 'list.last': this.moveTo(this.entries.length - 1); return
      case 'list.select':
      case 'dialog.confirm': this.openSelectedTurn(); return
      default:
        if (CLOSE_ACTIONS.has(action.id)) this.close()
        // Every other app/global action is inert inside this read-only modal.
        return
    }
  }

  private inputDetail(action: ResolvedModalAction): void {
    switch (action.id) {
      case 'list.previous':
      case 'list.page-up': this.scrollDetail(-5); return
      case 'list.next':
      case 'list.page-down': this.scrollDetail(5); return
      case 'list.first': this.scrollDetailTo('first'); return
      case 'list.last': this.scrollDetailTo('last'); return
      case 'list.select':
      case 'dialog.confirm': return // Enter is inert in the read-only turn view
      default:
        if (CLOSE_ACTIONS.has(action.id)) this.closeTurn()
        return
    }
  }

  private scrollDetail(delta: number): void {
    const max = Math.max(0, this.detailContentLength - Math.max(1, this.detailBodyHeight))
    const base = Math.max(0, Math.min(this.detailPaintedTop, max))
    this.detailScrollTop = Math.max(0, Math.min(base + delta, max))
    this.detailPaintedTop = this.detailScrollTop
    this.repaint()
  }

  private scrollDetailTo(edge: 'first' | 'last'): void {
    if (edge === 'first') {
      this.detailScrollTop = 0
      this.detailPaintedTop = 0
    } else {
      this.detailScrollTop = Number.MAX_SAFE_INTEGER
      this.detailPaintedTop = Number.MAX_SAFE_INTEGER
    }
    this.repaint()
  }

  private repaint(): void {
    if (this.done || this.disposed) return
    try {
      this.tui.requestRender()
    } catch {
      // A closing host may already have torn the renderer down.
    }
    this.options.onRenderRequest?.()
  }

  // -------------------------------------------------------------------------
  // Rendering

  private heightCap(): number {
    const rows = this.tui.terminal?.rows
    if (!Number.isFinite(rows) || rows <= 0) return 200
    return Math.max(1, Math.floor(this.options.maxHeight ?? modalHeight(this.tui, this.modalSize)))
  }

  private ownerKey(): string {
    const entry = this.detail?.entry
    if (entry !== undefined) return `history:turn:${entry.seq}:${this.detail?.token ?? 0}`
    return `history:list:${this.selectedSeqValue ?? ''}`
  }

  private frameTitle(): string {
    const entry = this.detail?.entry
    return entry === undefined ? 'History' : `History › #${entry.turn}`
  }

  private frameActions(): ModalAction[] {
    if (this.detail !== undefined) {
      const actions: ModalAction[] = [{
        id: 'back',
        label: 'back',
        action: 'list.cancel',
        onActivate: () => this.closeTurn(),
      }]
      if (this.hasOlder()) {
        actions.push({ id: 'older', label: 'older', onActivate: () => this.navigate('older') })
      }
      if (this.hasNewer()) {
        actions.push({ id: 'newer', label: 'newer', onActivate: () => this.navigate('newer') })
      }
      actions.push({ id: 'close', label: 'close', onActivate: () => this.close() })
      return actions
    }
    const canOpen = this.selectedTurn !== undefined && typeof this.options.loadWindow === 'function'
    const open: ModalAction = canOpen
      ? { id: 'open', label: 'open', action: 'list.select', onActivate: () => this.openSelectedTurn() }
      : { id: 'open', label: 'open', disabled: true }
    const refresh: ModalAction[] = this.options.loadTurns === undefined ? [] : [{
      id: 'refresh',
      label: 'refresh',
      action: 'app.redraw',
      onActivate: () => this.reloadTurns(),
    }]
    return [
      open,
      ...refresh,
      { id: 'close', label: 'close', action: 'list.cancel', onActivate: () => this.close() },
    ]
  }

  private sessionLabel(): string {
    const title = this.sessionValue.title
    if (typeof title === 'string' && title.trim() !== '') return oneLine(sanitize(title), 120)
    return oneLine(sanitize(this.sessionValue.sessionId), 120)
  }

  private listHeaderLines(width: number): readonly string[] {
    const parts = ['Native turn history']
    if (this.turnsState === 'ready' && this.entries.length > 0) {
      parts.push(`${this.entries.length} ${this.entries.length === 1 ? 'turn' : 'turns'}`)
    }
    if (this.outlineAsOfSeq !== undefined) parts.push(`as of seq ${this.outlineAsOfSeq}`)
    if (this.outlineAttachmentId !== undefined) parts.push('attachment')
    return [
      fit(dim(parts.join(' · ')), width),
      fit(dim(`Session ${this.sessionLabel()}`), width),
    ]
  }

  private detailHeaderLines(width: number): readonly string[] {
    const detail = this.detail
    if (detail === undefined) return new Array<string>(3).fill('')
    const entry = detail.entry
    const prompt = preview(entry.prompt) || '(no prompt text)'
    const response = preview(entry.response) || '(no response text)'
    const min = this.minLoadedSeq() ?? entry.seq
    const max = this.maxLoadedSeq()
    const meta = [`seq ${min}${max === undefined ? '' : `–${max}`}`, `${this.detailEvents.size} events`]
    if (this.detailPages > 1) meta.push(`${this.detailPages} pages`)
    if (this.detailInherited > 0) meta.push(`${this.detailInherited} inherited`)
    return [
      fit(`${t.accentBright('❯')} ${bold(`#${entry.turn}`)} ${t.text(prompt)}`, width),
      fit(`   ${dim('↳ ' + response)}`, width),
      fit(`   ${dim(meta.join(' · '))}`, width),
    ]
  }

  /**
   * Empty/loading/failure messages are painted in the **body** when no row
   * exists: modal chrome may legally shrink a status row away on a short frame,
   * and an honest history state must never disappear with it.
   */
  private emptyListLines(width: number): string[] {
    if (this.turnsState === 'loading') return [fit(` ${t.muted('Reading native turn history…')}`, width)]
    if (this.turnsState === 'failed') {
      return wrap(t.redSoft(this.turnsError || 'Native turn history could not be read.'), Math.max(4, width - 1))
        .slice(0, 2)
        .map(line => fit(' ' + line, width))
    }
    if (this.turnsState === 'unavailable') {
      const detail = this.turnsReason === '' ? '' : ` (${this.turnsReason})`
      return [fit(` ${t.yellow('Native turn history is unavailable')}${dim(detail)}`, width)]
    }
    if (this.turnsState === 'unread') {
      return [fit(` ${t.muted('Native turn history has not been read in this session.')}`, width)]
    }
    return [fit(` ${t.muted('No native turns in this session.')}`, width)]
  }

  /** Status chrome beside a non-empty outline (never the only copy of a state). */
  private listStatusLines(width: number): readonly string[] {
    if (this.entries.length === 0) return []
    if (this.turnsState === 'loading') return [fit(` ${t.muted('Reading native turn history…')}`, width)]
    if (this.turnsState === 'failed') {
      return wrap(t.redSoft(this.turnsError || 'Native turn history could not be read.'), Math.max(4, width - 1))
        .slice(0, 2)
        .map(line => fit(' ' + line, width))
    }
    if (this.turnsState === 'unavailable') {
      const detail = this.turnsReason === '' ? '' : ` (${this.turnsReason})`
      return [fit(` ${t.yellow('Native turn history is unavailable')}${dim(detail)}`, width)]
    }
    if (this.outlineSkipped > 0) {
      const label = this.outlineSkipped === 1
        ? '1 malformed native outline row was skipped.'
        : `${this.outlineSkipped} malformed native outline rows were skipped.`
      return [fit(` ${t.muted(label)}`, width)]
    }
    return []
  }

  private truncationLabel(): string {
    if (this.detailTruncation === 'progress') return 'Partial turn: the native event reader made no forward progress.'
    if (this.detailTruncation === 'bytes') return `Partial turn: the ${this.maxBytes}-byte read cap was reached.`
    if (this.detailTruncation === 'pages') {
      return `Partial turn: automatic paging stopped after ${this.maxPages} ${this.maxPages === 1 ? 'page' : 'pages'}.`
    }
    return `Partial turn: the ${this.maxEvents}-event read cap was reached.`
  }

  private detailStatusLines(width: number): readonly string[] {
    if (this.detailError !== '') {
      return wrap(t.redSoft(this.detailError), Math.max(4, width - 1)).slice(0, 2).map(line => fit(' ' + line, width))
    }
    if (this.detail === undefined) return []
    if (!this.detailReady && this.detailEvents.size === 0) {
      return [fit(` ${t.muted('Reading native turn history…')}`, width)]
    }
    const notes: string[] = []
    if (this.detailTruncated) notes.push(t.yellow(this.truncationLabel()))
    if (this.detailNotice !== '') notes.push(t.muted(this.detailNotice))
    if (this.detailEvents.size === 0) {
      notes.push(t.muted('The native window returned no events for this turn.'))
    } else if ((this.detailView?.store.items.length ?? 0) === 0) {
      notes.push(t.muted(`The native window has ${this.detailEvents.size} events but no transcript rows to display.`))
    } else if (this.detailLoading) {
      notes.push(t.muted('Reading more native events…'))
    }
    return notes.slice(0, 2).map(note => fit(' ' + note, width))
  }

  private turnLines(entry: HistoryTurnEntry, width: number, focused: boolean): string[] {
    const marker = focused ? t.accentBright('❯') : ' '
    const number = `#${entry.turn}`
    const prompt = preview(entry.prompt) || '(no prompt text)'
    const response = preview(entry.response) || '(no response text)'
    const room = Math.max(1, width - 2 - number.length - 1)
    const numberText = focused ? bold(t.accentBright(number)) : t.accent(number)
    const promptText = focused ? bold(t.text(truncateToWidth(prompt, room, '…'))) : t.text(truncateToWidth(prompt, room, '…'))
    return [
      fit(marker + ' ' + numberText + ' ' + promptText, width),
      fit('  ' + dim('↳ ' + truncateToWidth(response, Math.max(1, width - 4), '…')), width),
    ]
  }

  private buildList(width: number, height: number): ListBody {
    if (height <= 0) return { lines: [] }
    if (this.entries.length === 0) {
      return { lines: this.emptyListLines(width).slice(0, height) }
    }
    const blocks: ListBlock[] = this.entries.map((entry, index) => ({
      lines: this.turnLines(entry, width, index === this.selectedIndex),
      focused: index === this.selectedIndex,
      index,
      key: String(entry.seq),
    }))
    const window = windowList(blocks, height, { start: this.listScroll })
    this.listScroll = window.start
    return { lines: window.lines, hits: window.hits }
  }

  private buildDetail(width: number, height: number): ListBody {
    if (height <= 0) return { lines: [] }
    this.detailBodyHeight = height
    const view = this.detailView
    const scrollView = this.detailScrollView
    if (view === undefined || scrollView === undefined) {
      this.detailContentLength = 0
      return { lines: [] }
    }
    const content = scrollView.render(width)
    this.detailContentLength = content.length
    if (content.length === 0) {
      // The status row is optional chrome and may be squeezed out on a short
      // frame. An empty projection must still state why (loading/error/no
      // native events), never look like an empty successful history.
      const notes = this.detailStatusLines(width)
      if (notes.length > 0) return { lines: notes.slice(0, height) }
    }
    scrollView.updateLayout(content.length, Math.max(1, height), () => this.repaint())
    const maxScroll = Math.max(0, content.length - Math.max(1, height))
    const top = Math.max(0, Math.min(this.detailScrollTop, maxScroll))
    this.detailScrollTop = top
    this.detailPaintedTop = top
    const lines: string[] = []
    for (let offset = 0; offset < height; offset += 1) lines.push(content[top + offset] ?? '')
    return { lines }
  }

  render(width: number): string[] {
    if (this.done || this.disposed) return []
    const size = Math.max(1, Math.floor(width))
    const detail = this.detail !== undefined
    const lines = this.surface.render(size, {
      title: this.frameTitle(),
      ownerKey: this.ownerKey(),
      beforeRows: detail ? 3 : 2,
      before: bodyWidth => detail ? this.detailHeaderLines(bodyWidth) : this.listHeaderLines(bodyWidth),
      status: bodyWidth => detail ? this.detailStatusLines(bodyWidth) : this.listStatusLines(bodyWidth),
      actions: this.frameActions(),
      onClose: () => this.close(),
      keymap: this.keymap,
    }, (bodyWidth, bodyHeight) => detail ? this.buildDetail(bodyWidth, bodyHeight) : this.buildList(bodyWidth, bodyHeight))
    // `ModalListSurface`/`ModalFrame` already clips every ordinary line to the
    // inner width; graphic APC/iTerm lines are passed through raw by the frame
    // and must not be measured or wrapped as terminal text.
    return lines
  }

  // -------------------------------------------------------------------------
  // Mouse

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.done || this.disposed) return undefined
    const chrome = this.surface.chromeMouse(event)
    if (chrome !== undefined) return chrome
    const body = this.surface.bodyMouse(event)
    if (body === undefined) return undefined
    if (event.type === 'wheel') {
      const delta = (event.wheelDelta ?? 0) < 0 ? -1 : 1
      if (this.detail !== undefined) this.scrollDetail(delta * 3)
      else this.move(delta)
      return { handled: true, render: true }
    }
    if (this.detail !== undefined) {
      // The detail body is scrollable/read-only. Clicks are claimed so they
      // cannot leak into the composer underneath; disclosure/link state is
      // module-level and is deliberately not mutated from this projection.
      return event.button === 'left' ? { handled: true, render: false } : undefined
    }
    const handled = this.surface.rowMouse(event, this.ownerKey(), hit => {
      const index = hit.index
      if (index === undefined) return
      const entry = this.entries[index]
      if (entry === undefined) return
      const wasSelected = this.selectedSeqValue === entry.seq
      this.selectedIndex = index
      this.selectedSeqValue = entry.seq
      if (wasSelected) this.openSelectedTurn()
      else this.repaint()
    })
    if (handled !== undefined) return handled
    return undefined
  }
}
