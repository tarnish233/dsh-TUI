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

import type {
  BackendEvent,
  DisplayStream,
  JsonRecord,
  SessionEvent,
  SessionInfo,
  StreamPresentation,
  TranscriptCodec,
} from '../backend/types.ts'

export type TranscriptItem =
  | UserTranscriptItem
  | AssistantTranscriptItem
  | ToolTranscriptItem
  | AttemptTranscriptItem
  | NoticeTranscriptItem

export interface UserTranscriptItem {
  readonly kind: 'user'
  readonly id: string
  readonly seq?: number
  readonly text: string
  readonly imageCount: number
  readonly version: number
}

export interface AssistantTranscriptItem {
  readonly kind: 'assistant'
  readonly id: string
  readonly seq?: number
  readonly text: string
  readonly thinking: string
  readonly interrupted: boolean
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
  readonly name: string
  readonly arguments: string
  readonly status: ToolTranscriptStatus
  readonly resultText: string
  readonly resultImages: number
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
  readonly toolNames: readonly string[]
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

export type NoticeLevel = NoticeTranscriptItem['level']

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

interface TextBlocks {
  text: string
  thinking: string
  images: number
}

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
  return { text: texts.join('\n\n'), thinking: thinking.join('\n\n'), images }
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

function hasVisibleStream(view: StreamPresentation): boolean {
  return view.text.trim() !== '' || view.thinking.trim() !== '' || view.toolNames.length > 0
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
  nextIndex: number
  chunkCount: number
  pendingSeq?: number
  ended: boolean
}

export interface TranscriptStoreOptions {
  onChange?: () => void
  /** Same codec `Backend.transcriptCodec` exposes; install before reset/ready. */
  codec?: TranscriptCodec
}

export class TranscriptStore {
  private list: TranscriptItem[] = []
  private infoValue: SessionInfo | undefined
  private sessionIdValue: string | undefined
  private statusValue: 'running' | 'idle' = 'idle'
  private liveAttempt: LiveAttempt | undefined
  private codecValue: TranscriptCodec | undefined
  private readonly processedSeqs = new Set<number>()
  private noticeCounter = 0
  private versionCounter = 0
  /** Called after every observable mutation. Parent assigns this to request a render. */
  onChange: () => void

  constructor(options: TranscriptStoreOptions | (() => void) = {}) {
    if (typeof options === 'function') {
      this.onChange = options
    } else {
      this.onChange = options.onChange ?? (() => {})
      this.codecValue = options.codec
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
    return this.list
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
    this.processedSeqs.clear()
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
        this.report(event.message, 'error')
        return
      case 'permissions':
      case 'decision':
      case 'decision_closed':
        // Controls and connection status are parent-owned; the transcript does
        // not invent entries for control-plane messages.
        return
    }
  }

  /** Add a local notice (never presented as a model message). */
  report(text: string, level: NoticeLevel = 'info'): void {
    const trimmed = text.trim()
    if (trimmed === '') return
    this.list.push({
      kind: 'notice',
      id: `notice:${++this.noticeCounter}`,
      level,
      text: trimmed,
      version: ++this.versionCounter,
    })
    this.notify()
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
      attemptId: live.attemptId,
      revision: live.revision,
      turn: live.turn,
      step: live.step,
      text: live.view.text,
      thinking: live.view.thinking,
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
   * return its former position so durable items can take its place.
   */
  private settleLive(seq: number | undefined, turn: number | undefined, step: number | undefined): number | undefined {
    const live = this.liveAttempt
    if (live === undefined) return undefined
    if (live.pendingSeq !== undefined && seq !== undefined && live.pendingSeq !== seq) return undefined
    if (live.pendingSeq === undefined) {
      if (turn !== undefined && live.turn !== turn) return undefined
      if (step !== undefined && live.step !== step) return undefined
    }
    const index = this.list.findIndex(item => item.id === live.itemId)
    this.liveAttempt = undefined
    if (index < 0) return this.list.length
    this.list.splice(index, 1)
    return index
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
    this.removeLiveItem(live)
    if (hasVisibleStream(live.view)) this.list.push(this.attemptItem(live, 'unknown', true))
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
        this.projectAssistantMessage(seq, data)
        return
      }
      case 'assistant/attempt': {
        this.projectAssistantAttempt(seq, data)
        return
      }
      case 'tool/call': {
        this.upsertToolCall(seq, data, presentation)
        return
      }
      case 'tool/result': {
        this.applyToolResult(seq, data, presentation)
        return
      }
      case 'turn/start':
      case 'step/start':
        this.statusValue = 'running'
        return
      case 'turn/end':
        // Turn-end reasons are parent/status concerns. Failures already arrive
        // through assistant/attempt and backend error events. Here we only make
        // sure no card keeps claiming to run after its turn is over.
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

  private projectUserMessage(seq: number, data: Record<string, unknown>): void {
    const source = isRecord(data.source) ? data.source : undefined
    // Synthetic context (agent.inject, instructions, notices) is model-visible
    // but not a human prompt. Keep the transcript to real user turns.
    if (source !== undefined && asString(source.kind) !== 'user') return
    const blocks = projectBlocks(data.content)
    if (blocks.text.trim() === '' && blocks.images === 0) return
    this.list.push({
      kind: 'user',
      id: `user:${seq}`,
      seq,
      text: blocks.text,
      imageCount: blocks.images,
      version: ++this.versionCounter,
    })
  }

  private projectAssistantMessage(seq: number, data: Record<string, unknown>): void {
    const turn = asNumber(data.turn)
    const step = asNumber(data.step)
    const index = this.settleLive(seq, turn, step)
    const message = isRecord(data.message) ? data.message : {}
    const blocks = projectBlocks(message.content)
    const tools = projectMessageTools(message.content)
    const items: TranscriptItem[] = []
    if (blocks.text.trim() !== '' || blocks.thinking.trim() !== '') {
      items.push({
        kind: 'assistant',
        id: `assistant:${seq}`,
        seq,
        text: blocks.text,
        thinking: blocks.thinking,
        interrupted: data.interrupted === true,
        version: ++this.versionCounter,
      })
    }
    for (const tool of tools) {
      if (this.list.some(item => item.kind === 'tool' && item.id === `tool:${tool.id}`)) continue
      items.push(this.newToolItem({
        callId: tool.id,
        seq,
        name: tool.name,
        arguments: tool.arguments,
        // The model proposed this call; DSH has not admitted it yet.
        status: 'proposed',
      }))
    }
    if (index === undefined) this.list.push(...items)
    else this.list.splice(index, 0, ...items)
  }

  private projectAssistantAttempt(seq: number, data: Record<string, unknown>): void {
    const turn = asNumber(data.turn)
    const step = asNumber(data.step)
    const index = this.settleLive(seq, turn, step)
    const view = this.codecValue?.assemble(data.stream, true) ?? EMPTY_STREAM
    if (!hasVisibleStream(view)) return
    const item: AttemptTranscriptItem = {
      kind: 'attempt',
      id: `attempt:${seq}`,
      seq,
      turn: turn ?? 0,
      step: step ?? 0,
      text: view.text,
      thinking: view.thinking,
      toolNames: view.toolNames,
      status: 'abandoned',
      tentative: false,
      version: ++this.versionCounter,
    }
    if (index === undefined) this.list.push(item)
    else this.list.splice(index, 0, item)
  }

  private newToolItem(fields: {
    callId: string
    seq?: number
    name: string
    arguments: string
    status: ToolTranscriptStatus
    resultText?: string
    resultImages?: number
    resultIsError?: boolean
    meta?: unknown
    presentation?: JsonRecord
    error?: ToolTranscriptItem['error']
  }): ToolTranscriptItem {
    return {
      kind: 'tool',
      id: `tool:${fields.callId}`,
      callId: fields.callId,
      ...(fields.seq === undefined ? {} : { seq: fields.seq }),
      name: fields.name,
      arguments: fields.arguments,
      status: fields.status,
      resultText: fields.resultText ?? '',
      resultImages: fields.resultImages ?? 0,
      resultIsError: fields.resultIsError ?? false,
      meta: fields.meta,
      ...(fields.presentation === undefined ? {} : { presentation: fields.presentation }),
      ...(fields.error === undefined ? {} : { error: fields.error }),
      version: ++this.versionCounter,
    }
  }

  private upsertToolCall(seq: number, data: Record<string, unknown>, presentation: JsonRecord | undefined): void {
    const callId = asString(data.callId)
    if (callId === undefined || callId === '') return
    const name = asString(data.name) ?? 'tool'
    const args = asString(data.arguments) ?? ''
    const index = this.list.findIndex(item => item.kind === 'tool' && item.id === `tool:${callId}`)
    if (index < 0) {
      this.list.push(this.newToolItem({
        callId,
        seq,
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
    this.list[index] = {
      ...current,
      name,
      arguments: args,
      seq: current.seq ?? seq,
      // A late duplicate call must not overwrite an already-settled result.
      status: current.status === 'proposed' ? 'running' : current.status,
      presentation: mergePresentation(current.presentation, presentation),
      version: ++this.versionCounter,
    }
  }

  private applyToolResult(seq: number, data: Record<string, unknown>, presentation: JsonRecord | undefined): void {
    const message = isRecord(data.message) ? data.message : {}
    const source = isRecord(message.source) ? message.source : undefined
    const callId = asString(message.toolCallId) ?? (source === undefined ? undefined : asString(source.callId))
    if (callId === undefined || callId === '') return
    const blocks = projectBlocks(message.content)
    const isError = message.isError === true
    const errorValue = isRecord(data.error) ? data.error : undefined
    const reason = errorValue === undefined ? undefined : asString(errorValue.reason)
    const error = errorValue === undefined
      ? undefined
      : {
          name: asString(errorValue.name) ?? 'ToolError',
          code: asString(errorValue.code) ?? '',
          ...(reason === undefined ? {} : { reason }),
        }
    const index = this.list.findIndex(item => item.kind === 'tool' && item.id === `tool:${callId}`)
    if (index < 0) {
      this.list.push(this.newToolItem({
        callId,
        seq,
        name: 'tool',
        arguments: '',
        status: isError ? 'error' : 'done',
        resultText: blocks.text,
        resultImages: blocks.images,
        resultIsError: isError,
        meta: data.meta,
        ...(presentation === undefined ? {} : { presentation }),
        ...(error === undefined ? {} : { error }),
      }))
      return
    }
    const current = this.list[index]
    if (current?.kind !== 'tool') return
    this.list[index] = {
      ...current,
      seq: current.seq ?? seq,
      status: isError ? 'error' : 'done',
      resultText: blocks.text,
      resultImages: blocks.images,
      resultIsError: isError,
      meta: data.meta,
      presentation: mergePresentation(current.presentation, presentation),
      ...(error === undefined ? {} : { error }),
      version: ++this.versionCounter,
    }
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