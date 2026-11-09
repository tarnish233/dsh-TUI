/**
 * Durable transcript projection for the DSH backend contract.
 *
 * DSH owns the truth: `session_event` carries the append-only v2 log
 * settlements. The live `stream_*` frames are process-local and tentative.
 * This store keeps those two planes separate:
 *
 *   live attempt item  -> one item per attempt, never one per token
 *   final settlement   -> replaces the matching live item in place
 *   abandoned attempt  -> an explicit attempt item, never an assistant reply
 *
 * Business semantics are NOT reimplemented here. DSH's own public helpers reach
 * this module through the injected {@link TranscriptCodec}:
 *
 *   createStream()      -> native BlockAssembler over live stream chunks
 *   assemble(stream)    -> native assistant-stream assembly of a settled attempt
 *   surfaceKind(event)  -> native surface metadata (append / replace / none)
 *
 * Without that codec the store never guesses: it tracks attempt identity,
 * ordering and settlements, but shows no streamed preview. The real backend
 * installs the codec before `ready`; the offline demo supplies a fixture-only
 * one. There is deliberately no production fallback/mirror of DSH's algorithms
 * in this file.
 *
 * The store is deliberately independent of the renderer. It has no terminal
 * output, no timers and no DSH runtime imports; tests can drive it directly.
 */

import { asImageAttachmentRef, displayContentParts } from '../attachments.ts'
import { redactDiagnostic } from '../backend/errors.ts'
import type {
  BackendEvent,
  DisplayContentPart,
  DisplayStream,
  JsonRecord,
  SessionEvent,
  SessionInfo,
  StreamPresentation,
  SubagentEntry,
  SubagentSnapshot,
  TodoItem,
  TodosSnapshot,
  TranscriptCodec,
} from '../backend/types.ts'
import {
  composeSubagentRows,
  readSubagentMessage,
  SubagentProjection,
  type SubagentMessageTranscriptItem,
  type SubagentTranscriptItem,
} from './subagents.ts'

export type { SubagentMessageTranscriptItem, SubagentTranscriptItem }

export type TranscriptItem =
  | UserTranscriptItem
  | AssistantTranscriptItem
  | ToolTranscriptItem
  | AttemptTranscriptItem
  | NoticeTranscriptItem
  | TodosTranscriptItem
  | SubagentTranscriptItem
  | SubagentMessageTranscriptItem

export interface UserTranscriptItem {
  readonly kind: 'user'
  readonly id: string
  readonly seq?: number
  readonly text: string
  /** Number of native image blocks, including blocks without a usable ref. */
  readonly imageCount: number
  /**
   * Ordered display content when the durable message carried non-text parts
   * (images or native files). `text` stays the joined text projection for every
   * consumer that does not need their positions; this array preserves the
   * original text/image/file order and repeated references.
   */
  readonly content?: readonly DisplayContentPart[]
  readonly version: number
}

/**
 * One reasoning run of an assistant/attempt item.
 *
 * A run starts at the first reasoning chunk of an attempt and ends at the first
 * text/tool-call chunk (or when the attempt settles), so a turn that thinks,
 * answers, thinks again yields several runs — each one gets its own collapsed
 * summary block in the transcript.
 *
 * Timing is honest by construction: `startedAt` exists only while the run is
 * still producing text, and `durationMs` only once a real measurement exists.
 * A durable replay that carries no usable event times leaves both undefined, so
 * the UI shows a plain `✻ Thought` instead of a made-up number.
 */
export interface TranscriptThinkingRun {
  readonly text: string
  /** Clock reading (epoch ms) at which this run started; in-progress runs only. */
  readonly startedAt?: number
  /** Settled duration in ms; absent when nobody measured it. */
  readonly durationMs?: number
}

export interface AssistantTranscriptItem {
  readonly kind: 'assistant'
  readonly id: string
  readonly seq?: number
  readonly text: string
  readonly thinking: string
  /** Per-run reasoning projection; parallel to `thinking`, never a replacement for it. */
  readonly thinkingRuns?: readonly TranscriptThinkingRun[]
  /**
   * UI-only reasoning/disclosure identity inherited from the live attempt this
   * durable projection replaced. The durable id/seq stay native facts; this
   * field only lets the renderer carry expanded reasoning, hover and cached
   * body across the streaming -> settled handoff.
   */
  readonly thinkingKey?: string
  /** Ordered text/image/file content when the message carried non-text parts. */
  readonly content?: readonly DisplayContentPart[]
  /** Native image block count, including legacy blocks without a usable ref. */
  readonly imageCount?: number
  readonly interrupted: boolean
  /**
   * Native `turn/end{aborted}` cancellation cause, when DSH recorded one for
   * this message's turn. Absent means the cause is unknown, so the renderer
   * must not attribute the interruption to anyone.
   */
  readonly interruptCause?: TurnEndCancelCause
  readonly version: number
}

/**
 * Tool card lifecycle, kept strictly separate from success/failure:
 *
 *   proposed  the model requested the call (assistant message content)
 *   running   DSH admitted the call (durable `tool/call`)
 *   done      a durable `tool/result` arrived without a failure marker
 *   error     a durable `tool/result` arrived with a failure marker
 *   unknown   the turn ended or the connection closed before any result
 *
 * `unknown` never claims the tool succeeded, failed, or even started.
 */
export type ToolTranscriptStatus = 'proposed' | 'running' | 'done' | 'error' | 'unknown'

export interface ToolTranscriptItem {
  readonly kind: 'tool'
  readonly id: string
  readonly callId: string
  readonly seq?: number
  readonly callSeq?: number
  readonly resultSeq?: number
  readonly turn?: number
  readonly step?: number
  /** DSH call-to-settlement wall time, including permission/policy waiting. */
  readonly startedAt?: number
  readonly settledAt?: number
  readonly durationMs?: number
  /** Original result blocks/envelope for lossless detail viewing; never reconstructed. */
  readonly resultContent?: readonly unknown[]
  readonly rawResult?: JsonRecord
  readonly name: string
  readonly arguments: string
  readonly status: ToolTranscriptStatus
  readonly resultText: string
  readonly resultImages: number
  /** Ordered text/image parts of the durable result blocks, when non-text parts exist. */
  readonly resultContentParts?: readonly DisplayContentPart[]
  readonly resultIsError: boolean
  /** Opaque DSH tool/result meta. Presentation may read it; it is never a success guess. */
  readonly meta: unknown
  /**
   * Ephemeral render intent from the native tool definition
   * (`presentCall`/`presentResult`, forwarded as `{ call?, result? }`).
   * Display-only: never written back to DSH's log.
   */
  readonly presentation?: JsonRecord
  readonly error?: { readonly name: string; readonly code: string; readonly reason?: string }
  readonly version: number
}

export type AttemptTranscriptStatus = 'streaming' | 'committing' | 'abandoned' | 'unknown'

export interface AttemptTranscriptItem {
  readonly kind: 'attempt'
  readonly id: string
  readonly seq?: number
  readonly attemptId?: string
  readonly revision?: number
  readonly turn: number
  readonly step: number
  readonly text: string
  readonly thinking: string
  /** Per-run reasoning projection; same rules as on an assistant item. */
  readonly thinkingRuns?: readonly TranscriptThinkingRun[]
  /** UI-only handoff identity (see `AssistantTranscriptItem.thinkingKey`). */
  readonly thinkingKey?: string
  readonly toolNames: readonly string[]
  /** Ordered text/image/file content when the live/settled stream carried non-text parts. */
  readonly content?: readonly DisplayContentPart[]
  /** Native image block count, including legacy blocks without a usable ref. */
  readonly imageCount?: number
  readonly status: AttemptTranscriptStatus
  /** True until a durable settlement (assistant/message or assistant/attempt) replaced it. */
  readonly tentative: boolean
  readonly version: number
}

export interface NoticeTranscriptItem {
  readonly kind: 'notice'
  readonly id: string
  readonly level: 'info' | 'error'
  readonly text: string
  readonly version: number
}

/**
 * DSH's native `todos` projection as one live checklist block.
 *
 * The checklist is a single piece of session state, not a stream of events: a
 * non-null snapshot updates this item in place, and null removes it again.
 * Exactly one todos item exists per transcript, like the web client.
 */
export interface TodosTranscriptItem {
  readonly kind: 'todos'
  readonly id: string
  readonly todos: readonly TodoItem[]
  readonly version: number
}

export type NoticeLevel = NoticeTranscriptItem['level']

/** Native durable cancellation cause (`turn/end{aborted}.reason`). */
export type TurnEndCancelCause = 'user' | 'parent' | 'hook' | 'disposed' | 'legacy'

const CANCEL_CAUSES: ReadonlySet<string> = new Set(['user', 'parent', 'hook', 'disposed', 'legacy'])

const isCancelCause = (value: string | undefined): value is TurnEndCancelCause =>
  value !== undefined && CANCEL_CAUSES.has(value)

/**
 * Concise transcript outcome of a native `turn/end` that did not complete.
 *
 * The text states the native outcome only: it never invents a user message
 * (a `blocked` turn may have admitted none), never attributes a cancellation,
 * and never repeats the live `agent/error` frame that already reported a
 * failed turn. Unknown/plugin-extended reasons stay silent: this store cannot
 * describe a semantic it does not know.
 */
function turnEndNotice(kind: string, reason: Record<string, unknown>): { text: string; level: NoticeLevel } | undefined {
  switch (kind) {
    case 'max-tokens':
      return { text: 'Output limit reached — the response may be incomplete.', level: 'info' }
    case 'blocked':
      return { text: 'Turn blocked by DSH.', level: 'info' }
    case 'interrupted':
      return { text: 'Turn interrupted before it completed (recovered from session history).', level: 'info' }
    case 'forked':
      return { text: 'Turn ended at a session fork boundary.', level: 'info' }
    case 'error': {
      // The durable reason carries the native failure facts; a live turn also
      // emitted `agent/error` first, and only that live notice is shown.
      const error = isRecord(reason.error) ? reason.error : undefined
      // Redact only this derived diagnostic, never the durable event or tool content.
      const message = error === undefined ? '' : redactDiagnostic(asString(error.message) ?? '').replace(/\s+/g, ' ').trim()
      const detail = message.length > 300 ? `${message.slice(0, 299)}…` : message
      return { text: detail === '' ? 'Turn failed.' : `Turn failed: ${detail}`, level: 'error' }
    }
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// Small unknown-value readers. DSH data crosses the backend boundary as
// `unknown`; projection validates the fields it reads instead of trusting any.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const asArray = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])

/** Durable integer field (turn/step/log index); never coerced from a string. */
const asIndex = (value: unknown): number | undefined => {
  const index = asNumber(value)
  return index !== undefined && Number.isSafeInteger(index) ? index : undefined
}

/**
 * Durable event wall clock (epoch ms), passed through exactly as DSH recorded
 * it. DSH's public `SessionEvent.time` has no "0 = unrecorded" convention and
 * epoch 0 is a real instant, so this layer must not invent its own sentinel.
 * Only a missing/non-finite reading stays unrecorded; it is never replaced with
 * the local `Date.now()` (which would fabricate history).
 */
const eventClock = (value: unknown): number | undefined => {
  const time = asNumber(value)
  return time !== undefined && time >= 0 ? time : undefined
}

/**
 * DSH call-to-settlement wall time, including approval/policy waiting — the
 * same window native `toolMs` folds. A clock that ran backwards is clamped to
 * zero; a missing endpoint yields no duration at all.
 */
function toolDuration(startedAt: number | undefined, settledAt: number | undefined): number | undefined {
  if (startedAt === undefined || settledAt === undefined) return undefined
  return Math.max(0, settledAt - startedAt)
}

interface TextBlocks {
  text: string
  thinking: string
  images: number
  files: number
  /** Ordered text/image/file parts; only non-text parts need this array on an item. */
  content: DisplayContentPart[]
}

/**
 * Project durable content blocks without rewriting them.
 *
 * Image blocks are counted even when the wire shape is only a legacy placeholder
 * (no usable attachment ref), so an item is never dropped just because its bytes
 * are unreachable. Native `file` blocks keep their durable metadata ref in the
 * ordered content; nothing here reads bytes or invents a path. The ordered parts
 * come from {@link displayContentParts}, the one shared validation authority for
 * admitted content, so repeated refs and their original order survive.
 */
function projectBlocks(content: unknown): TextBlocks {
  const texts: string[] = []
  const thinking: string[] = []
  let images = 0
  for (const block of asArray(content)) {
    if (!isRecord(block)) continue
    const type = asString(block.type)
    if (type === 'text') {
      const text = asString(block.text)
      if (text !== undefined) texts.push(text)
    } else if (type === 'reasoning') {
      const text = asString(block.text)
      if (text !== undefined) thinking.push(text)
    } else if (type === 'image') {
      images += 1
    }
  }
  const parts = displayContentParts(asArray(content))
  const files = parts.reduce((count, part) => count + (part.type === 'file' ? 1 : 0), 0)
  return { text: texts.join('\n\n'), thinking: thinking.join('\n\n'), images, files, content: parts }
}

/**
 * Native stream projection for a live/durable attempt. `content` is the
 * ordered wire value; `images` is the legacy replay-only convenience array.
 * Text-only content is not stored on the item (the joined `text`/`thinking`
 * fields already cover it) unless a non-text part actually needs a position.
 * File blocks keep their native metadata ref; they are never treated as images.
 */
function streamDisplayContent(view: StreamPresentation): DisplayContentPart[] {
  const parts = displayContentParts(view.content)
  if (parts.some(part => part.type !== 'text')) return parts
  const legacy = (view.images ?? []).flatMap(ref => {
    const attachment = asImageAttachmentRef(ref)
    return attachment === undefined ? [] : [{ type: 'image' as const, attachment }]
  })
  return legacy.length === 0 ? [] : [...parts.filter(part => part.type === 'text'), ...legacy]
}

function imagePartsCount(parts: readonly DisplayContentPart[]): number {
  return parts.reduce((count, part) => count + (part.type === 'image' ? 1 : 0), 0)
}

/** Non-text fields to attach to an attempt item; `{}` for a text-only stream. */
function streamContentFields(view: StreamPresentation): {
  content?: readonly DisplayContentPart[]
  imageCount?: number
} {
  const content = streamDisplayContent(view)
  const count = Math.max(imagePartsCount(content), view.images?.length ?? 0)
  const fields: { content?: readonly DisplayContentPart[]; imageCount?: number } = {}
  if (content.some(part => part.type !== 'text')) fields.content = content
  if (count > 0) fields.imageCount = count
  return fields
}

/**
 * Split a settled message's content into reasoning runs: one run per maximal
 * group of consecutive `reasoning` blocks, closed by the next text or tool-call
 * block. This mirrors the live chunk rule so a settled item and the live
 * preview of the same turn fold identically.
 */
function projectThinkingRuns(content: unknown): TranscriptThinkingRun[] {
  const runs: TranscriptThinkingRun[] = []
  let current: string[] | undefined
  const flush = (): void => {
    if (current === undefined) return
    const text = current.join('\n\n')
    if (text.trim() !== '') runs.push({ text })
    current = undefined
  }
  for (const block of asArray(content)) {
    if (!isRecord(block)) continue
    const type = asString(block.type)
    if (type === 'reasoning') {
      const text = asString(block.text)
      if (text === undefined) continue
      if (current === undefined) current = []
      current.push(text)
      continue
    }
    if (type === 'text' || type === 'tool-call') flush()
  }
  flush()
  return runs
}

interface FinalToolCall {
  id: string
  name: string
  arguments: string
}

function projectMessageTools(content: unknown): FinalToolCall[] {
  const calls: FinalToolCall[] = []
  for (const block of asArray(content)) {
    if (!isRecord(block) || asString(block.type) !== 'tool-call') continue
    const id = asString(block.id)
    if (id === undefined || id === '') continue
    calls.push({ id, name: asString(block.name) ?? 'tool', arguments: asString(block.arguments) ?? '' })
  }
  return calls
}

/** DSH event types that produce model messages and carry surface metadata. */
const SURFACE_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

const EMPTY_STREAM: StreamPresentation = { text: '', thinking: '', toolNames: [] }

/** One live todos block per transcript; the id keeps the view's block cache stable. */
const TODOS_ITEM_ID = 'todos:current'

function hasVisibleStream(view: StreamPresentation): boolean {
  if (view.text.trim() !== '' || view.thinking.trim() !== '' || view.toolNames.length > 0) return true
  // A pure-image or file attachment turn is still real content; never drop it
  // because it has no text. Legacy image counts are visible placeholders too.
  return streamDisplayContent(view).some(part => part.type !== 'text') || (view.images?.length ?? 0) > 0
}

// ---------------------------------------------------------------------------
// Live attempt bookkeeping.

interface LiveAttempt {
  readonly sessionId: string
  readonly attemptId: string
  /** Latest accepted frame revision, not an attempt/lifecycle identifier. */
  revision: number
  readonly turn: number
  readonly step: number
  readonly itemId: string
  /** Native stream projection; undefined when no codec was installed. */
  readonly stream: DisplayStream | undefined
  view: StreamPresentation
  /**
   * Reasoning runs of this attempt, built from the chunk sequence itself (the
   * native snapshot only joins blocks into one string and drops boundaries).
   */
  runs: TranscriptThinkingRun[]
  /** Index into `runs` of the run still receiving deltas, if any. */
  openRun: number | undefined
  nextIndex: number
  chunkCount: number
  pendingSeq?: number
  ended: boolean
}

export interface TranscriptStoreOptions {
  onChange?: () => void
  /** Same codec `Backend.transcriptCodec` exposes; install before reset/ready. */
  codec?: TranscriptCodec
  /**
   * Clock for live reasoning-run durations. Defaults to `Date.now`; tests inject
   * a deterministic reading so a run's elapsed time is reproducible.
   */
  now?: () => number
}

export class TranscriptStore {
  private list: TranscriptItem[] = []
  private infoValue: SessionInfo | undefined
  private sessionIdValue: string | undefined
  private statusValue: 'running' | 'idle' = 'idle'
  private liveAttempt: LiveAttempt | undefined
  private codecValue: TranscriptCodec | undefined
  private readonly clock: () => number
  /**
   * Event time of the current step, used only to derive an APPROXIMATE attempt
   * duration for durable replays (resume). Never used to fake per-run timing.
   */
  private stepStartedAt: number | undefined
  private readonly processedSeqs = new Set<number>()
  private readonly subagentProjection = new SubagentProjection()
  /**
   * Turns whose non-success `turn/end` outcome is already in the transcript.
   * A replayed frame (same durable turn) must not append a second notice.
   */
  private readonly endedTurns = new Set<number>()
  /**
   * Durable turn of the newest assistant item with text/thinking/content; used
   * only to attach a native cancellation cause to the reply it interrupted.
   */
  private lastAssistantTurn: number | undefined
  /**
   * A live backend `error` frame (native `agent/error`) arrived since the
   * current turn started. Its notice is the visible failure report, so the
   * durable `turn/end{error}` must not report the same failure again.
   */
  private liveErrorSinceTurnStart = false
  private noticeCounter = 0
  private versionCounter = 0
  /** Called after every observable mutation. Parent assigns this to request a render. */
  onChange: () => void

  constructor(options: TranscriptStoreOptions | (() => void) = {}) {
    if (typeof options === 'function') {
      this.onChange = options
      this.clock = Date.now
    } else {
      this.onChange = options.onChange ?? (() => {})
      this.codecValue = options.codec
      this.clock = options.now ?? Date.now
    }
  }

  /**
   * Install DSH's native transcript codec (as `Backend.transcriptCodec`).
   * The parent calls this before `reset`/`ready`; replacing a codec mid-attempt
   * only affects later streams because a live preview is never re-derived.
   */
  setCodec(codec: TranscriptCodec | undefined): void {
    this.codecValue = codec
  }

  /** Diagnostics/tests: whether native projection helpers are installed. */
  get hasCodec(): boolean {
    return this.codecValue !== undefined
  }

  /** Read-only view of the projected entries, in session order. */
  get items(): readonly TranscriptItem[] {
    return composeSubagentRows(this.list, this.subagentProjection, this.sessionIdValue)
  }

  /**
   * Current native child catalog (direct and nested), in catalog order. The
   * overlay reads this, including cold rows that carry no parent catalog seq.
   */
  get subagentEntries(): readonly SubagentEntry[] {
    return this.subagentProjection.entries
  }

  /** The current serializable catalog snapshot; absent before a native read. */
  get subagentSnapshot(): SubagentSnapshot | undefined {
    return this.subagentProjection.snapshot
  }

  get subagentsTruncated(): boolean {
    return this.subagentProjection.truncated
  }

  /** One known child by durable session id, for detail-surface wiring. */
  subagentEntry(id: string): SubagentEntry | undefined {
    return this.subagentProjection.get(id)
  }

  get info(): SessionInfo | undefined {
    return this.infoValue
  }

  get sessionId(): string | undefined {
    return this.sessionIdValue
  }

  get status(): 'running' | 'idle' {
    return this.statusValue
  }

  get hasLiveAttempt(): boolean {
    return this.liveAttempt !== undefined
  }

  /** Replace the transcript with a durable snapshot. Replays info.events by seq. */
  reset(info: SessionInfo): void {
    this.list = []
    this.liveAttempt = undefined
    this.stepStartedAt = undefined
    this.processedSeqs.clear()
    this.endedTurns.clear()
    this.lastAssistantTurn = undefined
    this.liveErrorSinceTurnStart = false
    // An absent catalog is not an empty native read: keep `subagentSnapshot`
    // undefined until DSH actually reports one. An explicit empty snapshot is
    // still recorded as a known-empty catalog.
    if (info.subagents === undefined) this.subagentProjection.clear()
    else this.subagentProjection.applySnapshot(info.subagents)
    this.infoValue = info
    this.sessionIdValue = info.sessionId
    this.statusValue = 'idle'
    for (const event of info.events ?? []) this.projectSessionEvent(event)
    // A snapshot is durable state, not a live stream: anything still waiting
    // for a result or settlement stays visibly unresolved instead of Running.
    this.settleOutstanding()
    this.notify()
  }

  /** Keep the current session metadata but clear projected entries. */
  clear(): void {
    this.list = []
    this.liveAttempt = undefined
    this.stepStartedAt = undefined
    this.endedTurns.clear()
    this.lastAssistantTurn = undefined
    this.liveErrorSinceTurnStart = false
    this.subagentProjection.clear()
    this.notify()
  }

  handle(event: BackendEvent): void {
    switch (event.type) {
      case 'ready':
        this.reset(event.info)
        return
      case 'status':
        if (!this.isCurrent(event.sessionId)) return
        this.statusValue = event.status
        this.notify()
        return
      case 'stream_start':
        this.handleStreamStart(event)
        return
      case 'stream_chunk':
        this.handleStreamChunk(event)
        return
      case 'stream_end':
        this.handleStreamEnd(event)
        return
      case 'todos':
        if (!this.isCurrent(event.sessionId)) return
        this.applyTodos(event.value)
        return
      case 'subagents':
        // Native full catalog snapshot: authoritative membership, idempotent
        // when replayed with no changes (no re-render, no re-key).
        if (!this.isCurrent(event.sessionId)) return
        if (this.subagentProjection.applySnapshot(event.value)) this.notify()
        return
      case 'subagent':
        // Native live upsert of one child; keeps a cold snapshot's anchor.
        if (!this.isCurrent(event.sessionId)) return
        if (this.subagentProjection.applyEntry(event.value)) this.notify()
        return
      case 'session_event':
        if (!this.isCurrent(event.sessionId)) return
        this.projectSessionEvent(event.event)
        this.notify()
        return
      case 'closed':
        // The connection ended. Never leave a card spinning as Running and
        // never invent a success/failure for what DSH did not settle.
        this.settleOutstanding()
        this.notify()
        return
      case 'warning':
        this.report(event.message, 'info')
        return
      case 'error':
        // Live agent/error is the visible failure report for this turn.
        this.liveErrorSinceTurnStart = true
        this.report(event.message, 'error')
        return
      case 'permissions':
      case 'decision':
      case 'decision_closed':
      case 'metrics':
        // Controls, connection status and footer projections are parent-owned;
        // the transcript does not invent entries for control-plane messages.
        // `metrics` needs this explicit no-op: the store sees every frame before
        // the app filters by session, so frames of any session must be swallowed.
        return
    }
  }

  /** Add a local notice (never presented as a model message). */
  report(text: string, level: NoticeLevel = 'info'): void {
    if (!this.pushNotice(text, level)) return
    this.notify()
  }

  /** Append one notice without notifying; callers own the batch notification. */
  private pushNotice(text: string, level: NoticeLevel = 'info'): boolean {
    const trimmed = text.trim()
    if (trimmed === '') return false
    this.list.push({
      kind: 'notice',
      id: `notice:${++this.noticeCounter}`,
      level,
      text: trimmed,
      version: ++this.versionCounter,
    })
    return true
  }

  // -------------------------------------------------------------------------
  // Live stream

  private isCurrent(sessionId: string): boolean {
    return this.sessionIdValue !== undefined && sessionId === this.sessionIdValue
  }

  private handleStreamStart(event: Extract<BackendEvent, { type: 'stream_start' }>): void {
    if (!this.isCurrent(event.sessionId)) return
    if (!Number.isSafeInteger(event.revision) || event.revision < 1) return
    const current = this.liveAttempt
    if (current !== undefined) {
      if (current.attemptId === event.attemptId || event.revision <= current.revision) return
      // A replacement lifecycle supersedes the tentative item. DSH sends an
      // abandoned end for the old attempt normally; if it did not, the old
      // item was never a durable fact and must not survive as one.
      this.removeLiveItem(current)
      this.liveAttempt = undefined
    }
    const itemId = `live:${event.sessionId}:${event.attemptId}:${event.revision}`
    const live: LiveAttempt = {
      sessionId: event.sessionId,
      attemptId: event.attemptId,
      revision: event.revision,
      turn: event.turn,
      step: event.step,
      itemId,
      stream: this.codecValue?.createStream(),
      view: EMPTY_STREAM,
      runs: [],
      openRun: undefined,
      nextIndex: 0,
      chunkCount: 0,
      ended: false,
    }
    this.liveAttempt = live
    this.list.push(this.liveItem(live, 'streaming'))
    this.notify()
  }

  private handleStreamChunk(event: Extract<BackendEvent, { type: 'stream_chunk' }>): void {
    const live = this.liveAttempt
    if (live === undefined || !this.isCurrent(event.sessionId)) return
    if (live.ended || event.attemptId !== live.attemptId) return
    // DSH increments revision for EVERY frame. Requiring equality with the
    // start frame silently discards all real model deltas. Identity is the
    // attemptId; revision and index only reject stale/duplicate publications.
    if (!Number.isSafeInteger(event.revision) || event.revision <= live.revision) return
    // DSH indices are dense and zero-based. Duplicates and stale replays are
    // ignored; a forward gap is accepted rather than dropping later content.
    if (!Number.isSafeInteger(event.index) || event.index < 0) return
    if (event.index < live.nextIndex) return
    live.revision = event.revision
    live.nextIndex = event.index + 1
    live.chunkCount += 1
    live.stream?.push(event.chunk)
    if (live.stream !== undefined) live.view = live.stream.snapshot()
    this.trackThinkingRun(live, event.chunk)
    this.replaceItem(live.itemId, this.liveItem(live, live.pendingSeq === undefined ? 'streaming' : 'committing'))
    this.notify()
  }

  private handleStreamEnd(event: Extract<BackendEvent, { type: 'stream_end' }>): void {
    const live = this.liveAttempt
    if (live === undefined || !this.isCurrent(event.sessionId)) return
    if (live.ended || event.attemptId !== live.attemptId) return
    if (!Number.isSafeInteger(event.revision) || event.revision <= live.revision) return
    live.revision = event.revision
    live.ended = true
    // The stream is over: whatever run is still open stops accruing time now.
    this.closeThinkingRun(live)
    if (event.outcome === 'committed') {
      if (event.seq !== undefined) live.pendingSeq = event.seq
      this.replaceItem(live.itemId, this.liveItem(live, 'committing'))
      this.notify()
      return
    }
    // Abandoned with no durable settlement: keep the streamed text as an
    // explicit, tentative attempt instead of pretending it became a reply.
    this.removeLiveItem(live)
    this.liveAttempt = undefined
    if (hasVisibleStream(live.view)) {
      this.list.push(this.attemptItem(live, 'abandoned', true))
    }
    this.notify()
  }

  private liveItem(live: LiveAttempt, status: AttemptTranscriptStatus): AttemptTranscriptItem {
    return {
      kind: 'attempt',
      id: live.itemId,
      attemptId: live.attemptId,
      revision: live.revision,
      turn: live.turn,
      step: live.step,
      text: live.view.text,
      thinking: live.view.thinking,
      ...(live.runs.length === 0 ? {} : { thinkingRuns: [...live.runs] }),
      ...streamContentFields(live.view),
      toolNames: live.view.toolNames,
      status,
      tentative: true,
      version: ++this.versionCounter,
    }
  }

  private attemptItem(live: LiveAttempt, status: AttemptTranscriptStatus, tentative: boolean): AttemptTranscriptItem {
    return {
      kind: 'attempt',
      id: `${live.itemId}:${status}`,
      // Keep the live reasoning/disclosure identity available to the renderer
      // after the attempt id changes; the id itself remains the stable display
      // id of this settled/abandoned/unknown attempt.
      thinkingKey: live.itemId,
      attemptId: live.attemptId,
      revision: live.revision,
      turn: live.turn,
      step: live.step,
      text: live.view.text,
      thinking: live.view.thinking,
      ...(live.runs.length === 0 ? {} : { thinkingRuns: [...live.runs] }),
      ...streamContentFields(live.view),
      toolNames: live.view.toolNames,
      status,
      tentative,
      version: ++this.versionCounter,
    }
  }

  private removeLiveItem(live: LiveAttempt): void {
    const index = this.list.findIndex(item => item.id === live.itemId)
    if (index >= 0) this.list.splice(index, 1)
  }

  private replaceItem(id: string, item: TranscriptItem): void {
    const index = this.list.findIndex(entry => entry.id === id)
    if (index >= 0) this.list[index] = item
    else this.list.push(item)
  }

  /**
   * Remove the live item that corresponds to a committed settlement and
   * return its former position plus its display identity. The durable items
   * still keep their native ids/seqs; only reasoning/disclosure state is
   * transferred through the returned `thinkingKey`.
   */
  private settleLive(
    seq: number | undefined,
    turn: number | undefined,
    step: number | undefined,
  ): { readonly index: number; readonly thinkingKey: string } | undefined {
    const live = this.liveAttempt
    if (live === undefined) return undefined
    if (live.pendingSeq !== undefined && seq !== undefined && live.pendingSeq !== seq) return undefined
    if (live.pendingSeq === undefined) {
      if (turn !== undefined && live.turn !== turn) return undefined
      if (step !== undefined && live.step !== step) return undefined
    }
    const index = this.list.findIndex(item => item.id === live.itemId)
    this.liveAttempt = undefined
    if (index < 0) return { index: this.list.length, thinkingKey: live.itemId }
    this.list.splice(index, 1)
    return { index, thinkingKey: live.itemId }
  }

  /**
   * Turn end / disconnect / snapshot replay: resolve every card that is still
   * waiting. The outcome is reported as unknown, never as success or failure.
   */
  private settleOutstanding(): void {
    for (const [index, item] of this.list.entries()) {
      if (item.kind !== 'tool') continue
      if (item.status !== 'proposed' && item.status !== 'running') continue
      this.list[index] = { ...item, status: 'unknown', version: ++this.versionCounter }
    }
    const live = this.liveAttempt
    if (live === undefined) return
    this.liveAttempt = undefined
    // An attempt nobody settled can no longer accrue reasoning time.
    this.closeThinkingRun(live)
    this.removeLiveItem(live)
    if (hasVisibleStream(live.view)) this.list.push(this.attemptItem(live, 'unknown', true))
  }

  // -------------------------------------------------------------------------
  // Live reasoning runs

  /**
   * Follow the raw chunk sequence to keep per-run reasoning boundaries.
   *
   * The native snapshot only joins reasoning blocks into one string, so the
   * run structure (and therefore `n more lines` per thought) has to be read
   * from the chunks themselves. Only the store's own accepted frames reach
   * this method, so stale/duplicate replays never affect it.
   */
  private trackThinkingRun(live: LiveAttempt, chunk: JsonRecord): void {
    const type = asString(chunk.type)
    const text = asString(chunk.text) ?? ''
    switch (type) {
      case 'block-start': {
        const blockType = asString(chunk.blockType)
        if (blockType === 'reasoning') this.openThinkingRun(live)
        else if (blockType === 'text' || blockType === 'tool-call') this.closeThinkingRun(live)
        return
      }
      case 'reasoning-delta':
        if (text === '') return
        this.appendThinkingRun(live, text)
        return
      case 'block-end': {
        // Delta-only protocols may deliver the finished block instead of deltas.
        const block = isRecord(chunk.block) ? chunk.block : undefined
        const blockType = block === undefined ? undefined : asString(block.type)
        if (blockType === 'reasoning') {
          const finalText = block === undefined ? '' : asString(block.text) ?? ''
          const openText = live.openRun === undefined ? '' : live.runs[live.openRun]?.text ?? ''
          if (finalText !== '' && openText === '') this.appendThinkingRun(live, finalText)
          return
        }
        if (blockType === 'text' || blockType === 'tool-call') this.closeThinkingRun(live)
        return
      }
      case 'text-delta':
        // Whitespace-only deltas belong to formatting, not to a new phase.
        if (text.trim() === '') return
        this.closeThinkingRun(live)
        return
      case 'tool-call-delta':
        // A name-bearing tool delta is the first content of a tool-call block.
        if (asString(chunk.name) !== undefined) this.closeThinkingRun(live)
        return
      default:
        return
    }
  }

  private openThinkingRun(live: LiveAttempt): void {
    if (live.openRun !== undefined) return
    live.runs.push({ text: '', startedAt: this.clock() })
    live.openRun = live.runs.length - 1
  }

  private appendThinkingRun(live: LiveAttempt, text: string): void {
    if (live.openRun === undefined) this.openThinkingRun(live)
    const index = live.openRun
    if (index === undefined) return
    const current = live.runs[index]
    if (current === undefined) return
    live.runs[index] = { text: current.text + text, startedAt: current.startedAt ?? this.clock() }
  }

  /**
   * Freeze one run's duration. A measurement below one millisecond is dropped
   * rather than reported as `0ms`: the clock simply did not advance, which is
   * not a duration claim, and it keeps a settled item identical to the live
   * frame it replaces.
   */
  private closeThinkingRun(live: LiveAttempt): void {
    const index = live.openRun
    if (index === undefined) return
    live.openRun = undefined
    const run = live.runs[index]
    if (run === undefined) return
    const started = run.startedAt
    const elapsed = started === undefined ? undefined : this.clock() - started
    live.runs[index] = { text: run.text, ...(elapsed !== undefined && elapsed > 0 ? { durationMs: elapsed } : {}) }
  }

  // -------------------------------------------------------------------------
  // Durable session events

  /**
   * Native surface classification. The codec (DSH's own public surface helpers)
   * decides; only when no codec is installed do we read the wire field directly,
   * and a missing field means "original append-origin fact".
   */
  private surfaceKind(event: SessionEvent): 'append' | 'replace' | 'none' {
    if (this.codecValue !== undefined) return this.codecValue.surfaceKind(event)
    const op = event.surfaceOp
    if (op === undefined || op === 'append') return 'append'
    return 'replace'
  }

  private projectSessionEvent(event: SessionEvent): void {
    if (!isRecord(event)) return
    const seq = asNumber(event.seq)
    if (seq === undefined || !Number.isSafeInteger(seq) || seq < 0) return
    const type = asString(event.type)
    if (type === undefined) return
    const isMessage = SURFACE_MESSAGE_TYPES.has(type)
    if (isMessage) {
      if (this.processedSeqs.has(seq)) return
      this.processedSeqs.add(seq)
      const kind = this.surfaceKind(event)
      // A native replacement copy is model-only: it exists to reshape what the
      // model sees after pruning/compaction. The human transcript keeps its
      // append-origin facts, so a replacement never appends, overwrites, or
      // erases anything the user already saw. Non-surface lifecycle/attempt
      // records below are unaffected and always projected.
      if (kind !== 'append') return
    }
    const data = isRecord(event.data) ? event.data : {}
    const presentation = isRecord(event.toolPresentation) ? event.toolPresentation : undefined

    switch (type) {
      case 'user/message': {
        this.projectUserMessage(seq, data)
        return
      }
      case 'assistant/message': {
        this.projectAssistantMessage(seq, data, asNumber(event.time))
        return
      }
      case 'assistant/attempt': {
        this.projectAssistantAttempt(seq, data, asNumber(event.time))
        return
      }
      case 'tool/call': {
        this.upsertToolCall(seq, data, presentation, eventClock(event.time))
        return
      }
      case 'tool/result': {
        this.applyToolResult(seq, data, presentation, eventClock(event.time))
        return
      }
      case 'turn/start':
      case 'step/start':
        this.statusValue = 'running'
        if (type === 'turn/start') this.liveErrorSinceTurnStart = false
        // Start of the step's own clock, used only for the approximate
        // attempt-level duration of a durable replay (see approximateRuns).
        this.stepStartedAt = asNumber(event.time) ?? this.stepStartedAt
        return
      case 'turn/end':
        // The native reason is the only durable outcome fact. It is projected
        // as one concise transcript notice (never a fabricated user message)
        // and, for a cancellation, as attribution on the interrupted reply.
        this.projectTurnEnd(data)
        this.liveErrorSinceTurnStart = false
        this.statusValue = 'idle'
        this.settleOutstanding()
        return
      case 'step/end':
        return
      case 'system/message':
      case 'developer/message':
      case 'request/header':
      case 'request/context':
      default:
        return
    }
  }

  /**
   * Project the one durable outcome fact of a closed turn.
   *
   * `completed` and plugin-extended/unknown reasons add nothing: normal
   * streaming must not print internal settlement diagnostics. `max-tokens`,
   * `blocked`, cold `interrupted`/`forked` closers and replayed `error` turns
   * each become exactly one concise notice, so scrollback and `--resume` show
   * the same outcome as the live turn. `blocked` never fabricates a user
   * message: DSH may have admitted none, and the notice says so.
   */
  private projectTurnEnd(data: Record<string, unknown>): void {
    const turn = asIndex(data.turn)
    const reason = isRecord(data.reason) ? data.reason : undefined
    const kind = reason === undefined ? undefined : asString(reason.kind)
    if (reason === undefined || kind === undefined || turn === undefined) return
    if (kind === 'aborted') {
      this.attributeCancellation(turn, reason)
      return
    }
    const notice = turnEndNotice(kind, reason)
    if (notice === undefined || this.endedTurns.has(turn)) return
    // A live failed turn already reported itself through the native agent/error
    // frame; only a cold/replayed error turn needs its own durable report.
    if (kind === 'error' && this.liveErrorSinceTurnStart) return
    this.endedTurns.add(turn)
    this.pushNotice(notice.text, notice.level)
  }

  /**
   * Attach the native cancellation cause to the reply it interrupted.
   *
   * The durable message alone carries only `interrupted: true`; the cause is
   * `turn/end{aborted}.reason`. Attribution is therefore written only from that
   * recorded cause (and only for the same turn's newest reply), never guessed:
   * an unknown or external interruption stays unattributed.
   */
  private attributeCancellation(turn: number, reason: Record<string, unknown>): void {
    if (this.lastAssistantTurn !== turn) return
    const cause = isRecord(reason.reason) ? asString(reason.reason.kind) : undefined
    if (!isCancelCause(cause)) return
    const index = this.list.findLastIndex(item => item.kind === 'assistant')
    if (index < 0) return
    const item = this.list[index]
    if (item.kind !== 'assistant' || !item.interrupted || item.interruptCause !== undefined) return
    this.list[index] = { ...item, interruptCause: cause, version: ++this.versionCounter }
  }

  private projectUserMessage(seq: number, data: Record<string, unknown>): void {
    const source = isRecord(data.source) ? data.source : undefined
    const sourceKind = source === undefined ? 'user' : asString(source.kind)
    if (sourceKind === 'subagent-settled' || sourceKind === 'agent-message') {
      this.projectSubagentMessage(seq, data)
      return
    }
    // Synthetic context (agent.inject, instructions, notices) is model-visible
    // but not a human prompt. Keep the transcript to real user turns.
    if (source !== undefined && sourceKind !== 'user') return
    const blocks = projectBlocks(data.content)
    // A file-only prompt is a real human turn: keep it visible instead of
    // dropping the message because it has no text. Nothing is synthesized; the
    // native file metadata is the only content shown.
    if (blocks.text.trim() === '' && blocks.images === 0 && blocks.files === 0) return
    this.list.push({
      kind: 'user',
      id: `user:${seq}`,
      seq,
      text: blocks.text,
      imageCount: blocks.images,
      ...(blocks.images > 0 || blocks.files > 0 ? { content: blocks.content } : {}),
      version: ++this.versionCounter,
    })
  }

  /**
   * DSH's durable settlement/trigger messages are user-role facts, never human
   * prompts. They keep their native seq, sender, summary and exact text; the
   * UI renders them as attributed trigger rows rather than notices.
   */
  private projectSubagentMessage(seq: number, data: Record<string, unknown>): void {
    const fields = readSubagentMessage(data)
    if (fields === undefined) return
    this.list.push({
      kind: 'subagent-message',
      id: `subagent-message:${seq}`,
      seq,
      sourceKind: fields.sourceKind,
      senderSessionId: fields.senderSessionId,
      ...(fields.summary === undefined ? {} : { summary: fields.summary }),
      ...(fields.form === undefined ? {} : { form: fields.form }),
      text: fields.text,
      version: ++this.versionCounter,
    })
  }

  /**
   * Approximate a durable reasoning duration for resume replay.
   *
   * A durable assistant message/attempt carries no per-run timing (the codec's
   * `StreamPresentation` only exposes joined text), so the only honest number
   * available is the step window: `step/start` time -> settlement time. It is
   * applied only when the message has exactly one reasoning run, where that
   * window really is the thinking attempt. Otherwise every run keeps no
   * duration and the UI prints a plain `✻ Thought`.
   */
  private approximateRuns(runs: TranscriptThinkingRun[], settledAt: number | undefined): TranscriptThinkingRun[] {
    if (runs.length !== 1) return runs
    const startedAt = this.stepStartedAt
    if (startedAt === undefined || settledAt === undefined) return runs
    const duration = settledAt - startedAt
    if (!Number.isFinite(duration) || duration <= 0) return runs
    return [{ ...runs[0]!, durationMs: duration }]
  }

  private projectAssistantMessage(seq: number, data: Record<string, unknown>, settledAt: number | undefined): void {
    const turn = asNumber(data.turn)
    const step = asNumber(data.step)
    const settled = this.settleLive(seq, turn, step)
    const message = isRecord(data.message) ? data.message : {}
    const blocks = projectBlocks(message.content)
    const runs = this.approximateRuns(projectThinkingRuns(message.content), settledAt)
    const tools = projectMessageTools(message.content)
    const items: TranscriptItem[] = []
    if (blocks.text.trim() !== '' || blocks.thinking.trim() !== '' || blocks.images > 0 || blocks.files > 0) {
      items.push({
        kind: 'assistant',
        id: `assistant:${seq}`,
        seq,
        ...(settled === undefined ? {} : { thinkingKey: settled.thinkingKey }),
        text: blocks.text,
        thinking: blocks.thinking,
        ...(runs.length === 0 ? {} : { thinkingRuns: runs }),
        ...(blocks.images > 0 || blocks.files > 0
          ? { content: blocks.content, ...(blocks.images > 0 ? { imageCount: blocks.images } : {}) }
          : {}),
        interrupted: data.interrupted === true,
        version: ++this.versionCounter,
      })
    }
    if (items.some(item => item.kind === 'assistant')) this.lastAssistantTurn = turn
    for (const tool of tools) {
      if (this.list.some(item => item.kind === 'tool' && item.id === `tool:${tool.id}`)) continue
      items.push(this.newToolItem({
        callId: tool.id,
        seq,
        turn: asIndex(data.turn),
        step: asIndex(data.step),
        name: tool.name,
        arguments: tool.arguments,
        // Keep the declaration's native boundary without claiming admission.
        // The model proposed this call; DSH has not admitted it yet.
        status: 'proposed',
      }))
    }
    if (settled === undefined) this.list.push(...items)
    else this.list.splice(settled.index, 0, ...items)
  }

  private projectAssistantAttempt(seq: number, data: Record<string, unknown>, settledAt: number | undefined): void {
    const turn = asNumber(data.turn)
    const step = asNumber(data.step)
    const settled = this.settleLive(seq, turn, step)
    const view = this.codecValue?.assemble(data.stream, true) ?? EMPTY_STREAM
    if (!hasVisibleStream(view)) return
    const runs = view.thinking.trim() === ''
      ? []
      : this.approximateRuns([{ text: view.thinking }], settledAt)
    const images = streamContentFields(view)
    const item: AttemptTranscriptItem = {
      kind: 'attempt',
      id: `attempt:${seq}`,
      seq,
      ...(settled === undefined ? {} : { thinkingKey: settled.thinkingKey }),
      turn: turn ?? 0,
      step: step ?? 0,
      text: view.text,
      thinking: view.thinking,
      ...(runs.length === 0 ? {} : { thinkingRuns: runs }),
      ...images,
      toolNames: view.toolNames,
      status: 'abandoned',
      tentative: false,
      version: ++this.versionCounter,
    }
    if (settled === undefined) this.list.push(item)
    else this.list.splice(settled.index, 0, item)
  }

  private newToolItem(fields: {
    callId: string
    seq?: number
    callSeq?: number
    resultSeq?: number
    turn?: number
    step?: number
    startedAt?: number
    settledAt?: number
    name: string
    arguments: string
    status: ToolTranscriptStatus
    resultText?: string
    resultImages?: number
    resultContentParts?: readonly DisplayContentPart[]
    resultIsError?: boolean
    resultContent?: readonly unknown[]
    rawResult?: JsonRecord
    meta?: unknown
    presentation?: JsonRecord
    error?: ToolTranscriptItem['error']
  }): ToolTranscriptItem {
    const durationMs = toolDuration(fields.startedAt, fields.settledAt)
    return {
      kind: 'tool',
      id: `tool:${fields.callId}`,
      callId: fields.callId,
      ...(fields.seq === undefined ? {} : { seq: fields.seq }),
      ...(fields.callSeq === undefined ? {} : { callSeq: fields.callSeq }),
      ...(fields.resultSeq === undefined ? {} : { resultSeq: fields.resultSeq }),
      ...(fields.turn === undefined ? {} : { turn: fields.turn }),
      ...(fields.step === undefined ? {} : { step: fields.step }),
      ...(fields.startedAt === undefined ? {} : { startedAt: fields.startedAt }),
      ...(fields.settledAt === undefined ? {} : { settledAt: fields.settledAt }),
      ...(durationMs === undefined ? {} : { durationMs }),
      name: fields.name,
      arguments: fields.arguments,
      status: fields.status,
      resultText: fields.resultText ?? '',
      resultImages: fields.resultImages ?? 0,
      ...(fields.resultContentParts === undefined ? {} : { resultContentParts: fields.resultContentParts }),
      resultIsError: fields.resultIsError ?? false,
      ...(fields.resultContent === undefined ? {} : { resultContent: fields.resultContent }),
      ...(fields.rawResult === undefined ? {} : { rawResult: fields.rawResult }),
      meta: fields.meta,
      ...(fields.presentation === undefined ? {} : { presentation: fields.presentation }),
      ...(fields.error === undefined ? {} : { error: fields.error }),
      version: ++this.versionCounter,
    }
  }

  /**
   * `tool/call` is the durable admission fact. Applying the same call twice is
   * idempotent: the first accepted event owns the real start time, name and
   * arguments, so a duplicate or delayed copy can only fill what is still
   * missing. It never rewrites an established outcome, result or timestamp.
   */
  private upsertToolCall(
    seq: number,
    data: Record<string, unknown>,
    presentation: JsonRecord | undefined,
    startedAt: number | undefined,
  ): void {
    const callId = asString(data.callId)
    if (callId === undefined || callId === '') return
    const name = asString(data.name) ?? 'tool'
    const args = asString(data.arguments) ?? ''
    const turn = asIndex(data.turn)
    const step = asIndex(data.step)
    const index = this.list.findIndex(item => item.kind === 'tool' && item.id === `tool:${callId}`)
    if (index < 0) {
      this.list.push(this.newToolItem({
        callId,
        seq,
        callSeq: seq,
        ...(turn === undefined ? {} : { turn }),
        ...(step === undefined ? {} : { step }),
        ...(startedAt === undefined ? {} : { startedAt }),
        name,
        arguments: args,
        // DSH admitted the call at its durable log position.
        status: 'running',
        ...(presentation === undefined ? {} : { presentation }),
      }))
      return
    }
    const current = this.list[index]
    if (current?.kind !== 'tool') return
    // A result that arrived first (window missing the call, or an async event
    // order) still gets its real name/input/time from this late call, but its
    // done/error outcome is stable. A model proposal is promoted to running.
    // Only the first accepted call supplies identity and timing: duplicates and
    // delayed copies can never re-date or rename an established call.
    const firstCall = current.callSeq === undefined
    const callSeq = current.callSeq ?? seq
    const callStartedAt = firstCall ? startedAt : current.startedAt
    const resolvedTurn = firstCall ? turn ?? current.turn : current.turn
    const resolvedStep = firstCall ? step ?? current.step : current.step
    const durationMs = toolDuration(callStartedAt, current.settledAt)
    this.list[index] = {
      ...current,
      callSeq,
      ...(resolvedTurn === undefined ? {} : { turn: resolvedTurn }),
      ...(resolvedStep === undefined ? {} : { step: resolvedStep }),
      ...(callStartedAt === undefined ? {} : { startedAt: callStartedAt }),
      ...(durationMs === undefined ? {} : { durationMs }),
      name: firstCall ? name : current.name,
      arguments: firstCall ? args : current.arguments,
      seq: current.seq ?? seq,
      // A late duplicate call must not overwrite an already-settled result.
      status: current.status === 'proposed' ? 'running' : current.status,
      presentation: mergePresentation(current.presentation, presentation),
      version: ++this.versionCounter,
    }
  }

  /**
   * `tool/result` is the durable settlement fact. The first accepted result owns
   * the settlement time, content blocks, raw envelope and outcome; a duplicate
   * or delayed copy (same callId) cannot rewrite them later. Native presentation
   * intent stays display-only and never becomes a tool identity.
   */
  private applyToolResult(
    seq: number,
    data: Record<string, unknown>,
    presentation: JsonRecord | undefined,
    settledAt: number | undefined,
  ): void {
    const message = isRecord(data.message) ? data.message : {}
    const source = isRecord(message.source) ? message.source : undefined
    const callId = asString(message.toolCallId) ?? (source === undefined ? undefined : asString(source.callId))
    if (callId === undefined || callId === '') return
    const blocks = projectBlocks(message.content)
    const isError = message.isError === true
    const content = Array.isArray(message.content) ? message.content : undefined
    const errorValue = isRecord(data.error) ? data.error : undefined
    const reason = errorValue === undefined ? undefined : asString(errorValue.reason)
    const error = errorValue === undefined
      ? undefined
      : {
          name: asString(errorValue.name) ?? 'ToolError',
          code: asString(errorValue.code) ?? '',
          ...(reason === undefined ? {} : { reason }),
        }
    const turn = asIndex(data.turn)
    const step = asIndex(data.step)
    const index = this.list.findIndex(item => item.kind === 'tool' && item.id === `tool:${callId}`)
    if (index < 0) {
      // The durable window may not include the call (truncated replay): keep the
      // result truthful, but leave the identity/input missing rather than
      // guessing them from a presentation title.
      this.list.push(this.newToolItem({
        callId,
        seq,
        resultSeq: seq,
        ...(turn === undefined ? {} : { turn }),
        ...(step === undefined ? {} : { step }),
        ...(settledAt === undefined ? {} : { settledAt }),
        name: 'tool',
        arguments: '',
        status: isError ? 'error' : 'done',
        resultText: blocks.text,
        resultImages: blocks.images,
        ...(blocks.images > 0 || blocks.files > 0 ? { resultContentParts: blocks.content } : {}),
        resultIsError: isError,
        ...(content === undefined ? {} : { resultContent: content }),
        rawResult: data,
        meta: data.meta,
        ...(presentation === undefined ? {} : { presentation }),
        ...(error === undefined ? {} : { error }),
      }))
      return
    }
    const current = this.list[index]
    if (current?.kind !== 'tool') return
    // The first result is the stable settlement; nothing older or repeated may
    // replace its time, raw blocks or outcome.
    if (current.resultSeq !== undefined) return
    const durationMs = toolDuration(current.startedAt, settledAt)
    const resolvedTurn = current.turn ?? turn
    const resolvedStep = current.step ?? step
    this.list[index] = {
      ...current,
      resultSeq: seq,
      ...(resolvedTurn === undefined ? {} : { turn: resolvedTurn }),
      ...(resolvedStep === undefined ? {} : { step: resolvedStep }),
      ...(settledAt === undefined ? {} : { settledAt }),
      ...(durationMs === undefined ? {} : { durationMs }),
      seq: current.seq ?? seq,
      status: isError ? 'error' : 'done',
      resultText: blocks.text,
      resultImages: blocks.images,
      ...(blocks.images > 0 || blocks.files > 0 ? { resultContentParts: blocks.content } : {}),
      resultIsError: isError,
      ...(content === undefined ? {} : { resultContent: content }),
      rawResult: data,
      meta: data.meta,
      presentation: mergePresentation(current.presentation, presentation),
      ...(error === undefined ? {} : { error }),
      version: ++this.versionCounter,
    }
  }

  /**
   * DSH's native `todos` projection is the whole live checklist of a turn, so
   * it is one item: append it once, replace it in place afterwards, and drop it
   * when the fold reports null. The statuses are DSH's; nothing is inferred.
   */
  private applyTodos(value: TodosSnapshot): void {
    const index = this.list.findIndex(item => item.kind === 'todos')
    if (value === null) {
      if (index >= 0) this.list.splice(index, 1)
      this.notify()
      return
    }
    const item: TodosTranscriptItem = {
      kind: 'todos',
      id: TODOS_ITEM_ID,
      todos: value.map(todo => ({ content: todo.content, status: todo.status })),
      version: ++this.versionCounter,
    }
    if (index < 0) this.list.push(item)
    else this.list[index] = item
    this.notify()
  }

  private notify(): void {
    this.onChange()
  }
}

/**
 * The native tool may publish its call intent at `tool/call` and its result
 * intent at `tool/result`; keep both halves so the card can render pending and
 * completed states from one record.
 */
function mergePresentation(previous: JsonRecord | undefined, next: JsonRecord | undefined): JsonRecord | undefined {
  if (next === undefined) return previous
  if (previous === undefined) return next
  return { ...previous, ...next }
}