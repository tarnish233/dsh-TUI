/**
 * In-process DSH adapter.
 *
 * The TUI runs inside a DSH native application bundle and receives the host
 * Cordis context. This class is the *only* translation layer between the UI's
 * neutral `Backend` contract and DSH's public services: Agent lifecycle,
 * commands, model catalog/defaults, permissions, presets, attachments,
 * session queries, projections and HMR remain DSH-owned. Nothing here spawns a
 * process, opens a control wire, mirrors a profile, or owns a second Agent
 * loop, persistence store, permission policy or model transport.
 *
 * `close()` disposes exactly what this adapter created: its host listeners,
 * pending decisions, in-flight command/image operations and the Agent handle it
 * owns. It never disposes the host root and never exits the process.
 *
 * @module dsh-tui/backend/context
 */
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { imageAttachmentValue, isImageMediaType, sameImageAttachment, asImageAttachmentRef } from '../attachments.ts'
import { backendError, backendErrorCodeOf, asBackendError, redactDiagnostic } from './errors.ts'
import type { BackendError } from './errors.ts'
import { makeTranscriptCodec } from './native-codec.ts'
import { carriedEffort, modelRow, reasoningView, selectModelRow, type ModelReasoningView, type ModelRow } from './model-view.ts'
import { SubagentBridge } from './subagents.ts'
import type {
  Backend,
  BackendEvent,
  DecisionOrigin,
  DecisionRequest,
  DisplayContentPart,
  ImageAttachmentRef,
  ImageAttachmentValue,
  JsonRecord,
  PlanSnapshot,
  PromptContentPart,
  QueueEntry,
  SessionEvent,
  SessionInfo,
  StatsSnapshot,
  SubagentSnapshot,
  TodosSnapshot,
  TranscriptCodec,
  UsageSnapshot,
} from './types.ts'

/** Structural view of the host Cordis context used by this adapter. */
export interface DshHostContext {
  get(name: string): unknown
  on(name: string, listener: unknown): unknown
  logger?: { warn?(message: string): void }
}

/** Public native pure helpers. Production omits this and lets the adapter
 * resolve the installed `@deepseek-ai/dsh-llm` / `dsh-session` exports. */
export interface DshNativeHelpers {
  createUserMessage(input: { content: readonly unknown[]; source: { kind: 'user' } }): unknown
  transcriptCodec: TranscriptCodec
}

export interface DshContextBackendOptions {
  /** Session workspace. The native Host composition owns the actual sandbox root. */
  cwd: string
  resume?: string
  provider?: string
  model?: string
  /** Explicit helpers (tests, or a bundle that prefers to import them itself). */
  native?: DshNativeHelpers
  /** Adapter diagnostics; never stdout. */
  warn?(message: string): void
}

interface Route {
  provider: string
  model: string
  reasoningEffort?: string
}

interface SessionLike {
  readonly id: string
  readonly header?: { readonly cwd?: string }
  requestHeader?(): { readonly config?: unknown } | undefined
}

interface UserMessageLike {
  readonly id: string
  readonly content?: readonly unknown[]
  readonly source?: { readonly kind?: string }
}

interface InboxLike {
  readonly nextTurn: readonly UserMessageLike[]
  readonly nextStep: readonly UserMessageLike[]
  remove(id: string): boolean
  replace(id: string, message: UserMessageLike): boolean
  prepend(target: 'next-turn' | 'next-step', message: UserMessageLike): void
  append(target: 'next-turn' | 'next-step', message: UserMessageLike): void
}

interface AgentLike {
  readonly id: string
  readonly session: SessionLike
  readonly options?: { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string }
  readonly model?: {
    current(): Readonly<Route> | undefined
    select(selection: Readonly<Route>): void
  }
  readonly inbox: InboxLike
  readonly status: 'idle' | 'running'
  readonly ctx?: unknown
  cancel(cause: { kind: 'user' | 'disposed' }, options?: { keepInbox?: boolean }): void
  whenIdle(): Promise<void>
  followup(message: unknown): unknown
  steer(message: unknown): unknown
}

interface AgentHandleLike {
  readonly agent: AgentLike
  dispose(): Promise<void>
}

interface AgentRegistryLike {
  create(options: unknown): Promise<AgentHandleLike>
  resume(options: unknown): Promise<AgentHandleLike>
  get?(id: string): AgentLike | undefined
}

interface CommandsLike {
  list(agent?: AgentLike): readonly unknown[]
  execute(agent: AgentLike, line: string, attachments: readonly unknown[], signal: AbortSignal): Promise<unknown>
}

interface LlmLike {
  listProviders(): readonly { readonly id: string; readonly name?: string }[]
  listModels(provider: string): Promise<readonly { readonly id: string; readonly name?: string; readonly description?: string }[]>
  resolveModelInfo(provider: string, model: string): Promise<unknown>
}

interface AttachmentsLike {
  readImage?(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<unknown>
  admitPromptContent?(content: readonly PromptContentPart[]): Promise<readonly unknown[]>
}

/**
 * Structural view of the public `ctx.subagents` mutation surface.
 *
 * DSH owns admission and authorization: this adapter only validates current
 * tree membership, presents the exact durable direct-parent address and
 * forwards the native call. Optional methods keep an older/smaller composition
 * loadable; capability detection reads them live.
 */
interface SubagentsLike {
  /** Fire-and-return cancel-signal admission; a no-op is still `accepted`. */
  interrupt?(targetSessionId: string, authority: { readonly kind: 'user'; readonly parentSessionId: string }): void
  /** Continuable child prompt whose receipt names the accepted inbox message. */
  prompt?(request: {
    readonly requestId: string
    readonly parentSessionId: string
    readonly childSessionId: string
    readonly mode: 'continuable'
    readonly delivery: 'queue' | 'steer'
    readonly content: readonly PromptContentPart[]
  }, signal: AbortSignal): Promise<unknown>
}

interface ObservationLike {
  readonly header?: unknown
  readonly inheritedEventCount?: unknown
  readonly events?: unknown
  readonly projections?: { readonly values?: unknown }
  [Symbol.dispose]?(): void
}

interface SessionQueryLike {
  readSession(id: string): Promise<unknown>
  listSessions(signal?: AbortSignal): Promise<readonly unknown[]>
  readTitleSnapshots(ids: readonly string[], signal?: AbortSignal): Promise<readonly unknown[]>
  observeSession?(id: string, options?: { readonly signal?: AbortSignal; readonly projectionMode?: 'all' | 'none' }): Promise<ObservationLike>
}

interface ProjectionsLike {
  onChanged?(listener: (session: unknown, key: string, value: unknown, seq: unknown) => void): () => void
  stateOf?(session: unknown, key: string): unknown
  snapshot?(session: unknown, keys?: readonly string[]): unknown
}

interface DefaultModelLike {
  currentSelection?(): unknown
  saveSelection?(next: Route): Promise<void>
}

interface PermissionPresetsLike {
  catalog?(): unknown
  current?(session: SessionLike): string
}

interface AgentPresetsLike {
  list?(): Promise<readonly unknown[]>
  resolve?(id?: string): Promise<unknown>
  select?(agent: AgentLike, id: string): Promise<unknown>
  mount?(agentCtx: unknown, id?: string): Promise<unknown>
  presetForSession?(session: SessionLike): string | null
  composedPreset?(ctx: unknown): string | undefined
  readonly defaultId?: string
}

interface HmrLike {
  runExclusive?<T>(operation: () => Promise<T>): Promise<T>
  reconcileProfile?(requiredIds?: readonly string[]): Promise<unknown>
}

interface ToolsLike {
  get?(name: string, scope?: unknown): unknown
}

interface LoaderEntryLike {
  readonly options?: { readonly id?: string; readonly name?: string }
  readonly disabled?: boolean
  update?(options: { disabled: boolean }): Promise<unknown>
}

interface LoaderLike {
  entries?(): Iterable<LoaderEntryLike>
}

interface SessionTitleLike {
  refresh?(...args: unknown[]): unknown
}

interface SessionsLike {
  flush?(session: SessionLike): Promise<unknown>
  get?(id: string): SessionLike | undefined
}

interface SessionPersistenceLike {
  list?(): Promise<readonly unknown[]>
}

interface LiveAgent {
  readonly handle: AgentHandleLike
  readonly agent: AgentLike
  readonly attachmentId: string
  route: Route | undefined
}

interface PendingSession {
  readonly sessionId: string
  readonly attachmentId: string
  route: Route | undefined
  preset: string | undefined
}

interface PendingDecision {
  readonly kind: 'approval' | 'question'
  readonly signal: AbortSignal | undefined
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly onAbort: () => void
}

interface ActiveCommand {
  readonly requestId: string
  readonly controller: AbortController
  readonly sessionId: string
  readonly settled: Promise<void>
  readonly settle: () => void
}

const BASE_CAPABILITIES = ['stream', 'followup', 'steer', 'cancel', 'new', 'resume', 'state', 'dequeue']
const SESSIONLESS_COMMANDS = new Set([
  'new', 'resume', 'sessions', 'titles', 'models', 'presets', 'commands', 'state',
  'auto-title', 'dequeue', 'cancel',
])
const STAGEABLE_COMMANDS = new Set(['model', 'preset', 'effort'])
const COMMAND_NAMES = new Set([
  'models', 'sessions', 'titles', 'commands', 'execute', 'cancel', 'new', 'resume', 'model',
  'presets', 'preset', 'efforts', 'effort', 'permissions', 'auto-title', 'state',
  'reload', 'dequeue', 'queue-remove', 'queue-replace', 'queue-send-now',
  'subagent-session', 'subagent-follow', 'subagent-interrupt', 'subagent-prompt',
])
const TITLE_PROVIDER_NAMES = [
  '@deepseek-ai/dsh-session-title-first-prompt-llm',
  '@deepseek-ai/dsh-session-title-all-prompts-llm',
]
const METRICS_KEYS = new Set(['contextPressure', 'tokenUsage', 'contextBreakdown', 'sessionStats'])
const STATS_FIELDS = ['turns', 'steps', 'llmMs', 'toolMs', 'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens'] as const
const MAX_SNAPSHOT_EVENTS = 8000
const SNAPSHOT_BYTE_BUDGET = 4 * 1024 * 1024
const MAX_CACHED_TOOL_CALLS = 2048
const IDLE_SETTLE_TIMEOUT_MS = 15_000
const COMMAND_DRAIN_TIMEOUT_MS = 15_000
const CANCEL_SETTLE_TIMEOUT_MS = 2_000
const RELOAD_TIMEOUT_MS = 120_000
const MAX_TITLE_IDS = 100
/** Bounded correlation entries for failed native compaction attempts. */
const MAX_COMPACTION_CAUSES = 32
/** Bound on one retained native cause so a provider dump cannot grow state. */
const MAX_COMPACTION_CAUSE_CHARS = 4_096
/** Bound on the appended native-cause detail so one notice stays readable. */
const MAX_NATIVE_CAUSE_CHARS = 400
/** The only human command whose generic failure text is enriched. */
const COMPACT_COMMAND = 'compact'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function jsonSafe(value: unknown): unknown {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? undefined : JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Diagnostic text for one native rejection, redacted once.
 *
 * Only scalar `message`/`name` fields are read: an arbitrary thrown object is
 * never serialized, so enumerable `stack`, `cause` and credential-shaped
 * properties cannot reach a UI diagnostic.
 */
function errorMessage(error: unknown): string {
  if (error === null || error === undefined) return 'unknown error'
  if (error instanceof Error) return redactDiagnostic(error.message.length > 0 ? error.message : error.name)
  if (typeof error === 'string') return redactDiagnostic(error)
  if (typeof error === 'object') {
    const item = error as { message?: unknown; name?: unknown }
    if (typeof item.message === 'string' && item.message.length > 0) return redactDiagnostic(item.message)
    if (typeof item.name === 'string' && item.name.length > 0) return redactDiagnostic(item.name)
    return 'the native service failed without a diagnostic message'
  }
  return typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint'
    ? String(error)
    : 'the native service failed without a diagnostic message'
}

function codedError(code: Parameters<typeof backendError>[0], message: string): Error {
  return backendError(code, message)
}

/**
 * Normalize one native Agent-registry rejection into the adapter taxonomy.
 *
 * `ctx.agents.create`, `ctx.agents.resume` (including the setup composition
 * they await) and the preset roster may reject with a bare native `Error` that
 * has no stable code. A coded value keeps its exact code and instance so
 * cancellations and stale/ownership classifications survive untouched; an
 * uncoded native failure becomes one redacted `RUNTIME_REQUEST_FAILED` with the
 * native diagnostic appended, never a stack trace.
 *
 * @param label - adapter-owned description of the failed native operation.
 * @param error - the rejection the native service produced.
 * @returns a coded, redacted BackendError safe to surface in the UI.
 */
function nativeAgentFailure(label: string, error: unknown): BackendError {
  if (backendErrorCodeOf(error) !== undefined) return asBackendError(error)
  return backendError('RUNTIME_REQUEST_FAILED', `${label}: ${errorMessage(error)}`)
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(codedError('RUNTIME_REQUEST_FAILED', `${label} timed out after ${ms}ms`)), ms)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(max, Math.max(min, number))
}

function routeFromLogged(value: unknown): Route | undefined {
  const config = record(value)?.config
  const candidate = record(config)
  return routeOf(candidate)
}

function routeOf(value: unknown): Route | undefined {
  const route = record(value)
  if (route === undefined || typeof route.provider !== 'string' || route.provider.length === 0) return undefined
  if (typeof route.model !== 'string' || route.model.length === 0) return undefined
  return {
    provider: route.provider,
    model: route.model,
    ...(typeof route.reasoningEffort === 'string' && route.reasoningEffort.length > 0
      ? { reasoningEffort: route.reasoningEffort }
      : {}),
  }
}

function sameRoute(left: Route | undefined, right: Route | undefined): boolean {
  if (left === right) return true
  if (left === undefined || right === undefined) return false
  return left.provider === right.provider && left.model === right.model &&
    (left.reasoningEffort ?? undefined) === (right.reasoningEffort ?? undefined)
}

function sameNumberRecord(a: Record<string, number> | undefined, b: Record<string, number> | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) if (a[key] !== b[key]) return false
  return true
}

function samePlanSnapshot(a: PlanSnapshot, b: PlanSnapshot): boolean {
  if (a.active !== b.active || a.wanted !== b.wanted) return false
  if (a.running === null || b.running === null) return a.running === b.running
  return a.running.commandId === b.running.commandId && a.running.wanted === b.running.wanted
}

function textOfBlock(block: unknown): string {
  const value = record(block)
  return value?.type === 'text' && typeof value.text === 'string' ? value.text : ''
}

function messageText(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : []
  return content.map(textOfBlock).filter(part => part.length > 0).join('\n')
}

/**
 * Ordered, byte-free recallable content of one native inbox message. Only a
 * human `source.kind === 'user'` message with text/image blocks is recallable;
 * injected context stays in the native inbox for the model.
 */
function recallableContent(message: Record<string, unknown>): DisplayContentPart[] | undefined {
  const source = record(message.source)
  if (source?.kind !== 'user') return undefined
  if (!Array.isArray(message.content)) return undefined
  const parts: DisplayContentPart[] = []
  for (const block of message.content) {
    const item = record(block)
    if (item === undefined) return undefined
    if (item.type === 'text') {
      parts.push({ type: 'text', text: typeof item.text === 'string' ? item.text : '' })
      continue
    }
    if (item.type === 'image') {
      const attachment = asImageAttachmentRef(item.attachment)
      if (attachment === undefined) return undefined
      parts.push({ type: 'image', attachment })
      continue
    }
    return undefined
  }
  return parts
}

function isRecallableMessage(message: UserMessageLike): boolean {
  return recallableContent(message as unknown as Record<string, unknown>) !== undefined
}

function parseToolArguments(data: Record<string, unknown>): unknown {
  if (typeof data.arguments !== 'string') return undefined
  try {
    return JSON.parse(data.arguments)
  } catch {
    return undefined
  }
}

function normalizeApprovalOutcome(value: unknown): 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' {
  if (value === undefined || value === null) return 'cancelled'
  if (typeof value === 'string') {
    return value === 'allowed-once' || value === 'rejected' || value === 'cancelled' || value === 'unavailable'
      ? value
      : 'cancelled'
  }
  const item = record(value)
  if (item === undefined) return 'cancelled'
  if (item.cancelled === true) return 'cancelled'
  const outcome = item.outcome ?? item.value
  if (outcome === 'allowed-once' || outcome === 'rejected' || outcome === 'cancelled' || outcome === 'unavailable') {
    return outcome
  }
  if (item.allow === true) return 'allowed-once'
  if (item.reject === true) return 'rejected'
  return 'cancelled'
}

function isCancelledValue(value: unknown): boolean {
  const item = record(value)
  return item?.cancelled === true || item?.outcome === 'cancelled'
}

function normalizeAskAnswer(questions: readonly Record<string, unknown>[], value: unknown): unknown {
  const item = record(value)
  if (item === undefined) throw codedError('INVALID_ANSWER', 'question answer must be {answers: (string|string[])[]}')
  const list = Array.isArray(value) ? value : item.answers
  if (!Array.isArray(list)) throw codedError('INVALID_ANSWER', 'question answer must carry an answers array')
  if (list.length !== questions.length) {
    throw codedError('INVALID_ANSWER', `question answer must name each of ${questions.length} questions exactly once`)
  }
  return {
    answers: questions.map((question, index) => {
      const raw = list[index]
      const options = Array.isArray(question.options) ? question.options : []
      const labels = new Set(options.map(option => record(option)?.label).filter((label): label is string => typeof label === 'string'))
      const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
      const selected: string[] = []
      let custom: string | undefined
      for (const entry of values) {
        if (typeof entry !== 'string' || entry.length === 0) continue
        if (labels.size === 0 || labels.has(entry)) selected.push(entry)
        else custom = custom === undefined ? entry : `${custom}\n${entry}`
      }
      return {
        id: question.id,
        selected,
        ...(custom === undefined ? {} : { custom }),
      }
    }),
  }
}

function statsOf(value: unknown): StatsSnapshot | undefined {
  const item = record(value)
  if (item === undefined) return undefined
  const stats: StatsSnapshot = {}
  let any = false
  for (const key of STATS_FIELDS) {
    const field = item[key]
    if (typeof field === 'number' && Number.isFinite(field) && field >= 0) {
      stats[key] = field
      any = true
    }
  }
  return any ? stats : undefined
}

function messageFacts(value: unknown): Record<string, unknown> | undefined {
  return record(value)
}

/** Ephemeral tool-card projection over the mounted native tool registry. */
class ToolPresenter {
  private readonly tools: ToolsLike
  private readonly agent: AgentLike
  private readonly calls = new Map<string, { name: string; args: unknown; call: unknown }>()

  constructor(tools: ToolsLike, agent: AgentLike) {
    this.tools = tools
    this.agent = agent
  }

  of(event: SessionEvent): JsonRecord | undefined {
    const data = record(event.data)
    if (data === undefined) return undefined
    if (event.type === 'tool/call') {
      if (typeof data.name !== 'string' || data.callId === undefined) return undefined
      const args = parseToolArguments(data)
      const definition = this.definitionOf(data.name)
      const call = this.callViewOf(definition, args)
      this.remember(String(data.callId), { name: data.name, args, call })
      return call === undefined ? undefined : { call }
    }
    if (event.type !== 'tool/result') return undefined
    const message = record(data.message)
    const source = record(message?.source)
    const callId = message?.toolCallId ?? source?.callId
    if (callId === undefined) return undefined
    const cached = this.calls.get(String(callId))
    if (cached === undefined) return undefined
    const definition = this.definitionOf(cached.name)
    const result = this.resultViewOf(definition, cached.args, message, data.meta)
    if (cached.call === undefined && result === undefined) return undefined
    return {
      ...(cached.call === undefined ? {} : { call: cached.call }),
      ...(result === undefined ? {} : { result }),
    } as JsonRecord
  }

  private definitionOf(name: string): unknown {
    try {
      return this.tools.get?.(name, this.agent)
    } catch {
      return undefined
    }
  }

  private callViewOf(definition: unknown, args: unknown): unknown {
    const present = record(definition)?.presentCall
    if (typeof present !== 'function') return undefined
    try {
      return jsonSafe(present(args))
    } catch {
      return undefined
    }
  }

  private resultViewOf(definition: unknown, args: unknown, message: Record<string, unknown> | undefined, meta: unknown): unknown {
    const present = record(definition)?.presentResult
    if (typeof present !== 'function') return undefined
    const content = Array.isArray(message?.content) ? message.content : []
    try {
      return jsonSafe(present(args, {
        content,
        isError: message?.isError === true,
        ...(meta === undefined ? {} : { meta }),
      }))
    } catch {
      return undefined
    }
  }

  private remember(callId: string, entry: { name: string; args: unknown; call: unknown }): void {
    this.calls.set(callId, entry)
    if (this.calls.size <= MAX_CACHED_TOOL_CALLS) return
    const oldest = this.calls.keys().next()
    if (!oldest.done) this.calls.delete(oldest.value)
  }
}

/** Load the public native helpers a bundle normally imports directly. */
async function loadDefaultNative(): Promise<DshNativeHelpers> {
  // Package names are computed so the project typechecks without those peer
  // dependencies in its own node_modules; the running bundle resolves them.
  const llmSpecifier: string = '@deepseek-ai/dsh-llm'
  const sessionSpecifier: string = '@deepseek-ai/dsh-session'
  let llm: unknown
  let session: unknown
  try {
    llm = await import(llmSpecifier)
  } catch {
    throw codedError(
      'STARTUP_FAILED',
      'the DSH llm helpers (@deepseek-ai/dsh-llm) are not resolvable from this bundle; native message creation/assembly is unavailable',
    )
  }
  try {
    session = await import(sessionSpecifier)
  } catch {
    throw codedError(
      'STARTUP_FAILED',
      'the DSH session helpers (@deepseek-ai/dsh-session) are not resolvable from this bundle; transcript surface semantics are unavailable',
    )
  }
  const llmModule = record(llm)
  const createUserMessage = llmModule?.createUserMessage
  if (typeof createUserMessage !== 'function') {
    throw codedError('STARTUP_FAILED', '@deepseek-ai/dsh-llm does not expose createUserMessage')
  }
  return {
    createUserMessage: input => createUserMessage(input),
    transcriptCodec: makeTranscriptCodec(llm, session),
  }
}

/** In-process DSH backend: DSH owns every business fact, this owns the seam. */
export class DshContextBackend implements Backend {
  private readonly host: DshHostContext
  private readonly options: DshContextBackendOptions
  private readonly listeners = new Set<(event: BackendEvent) => void>()
  private readonly disposers: Array<() => void> = []
  private readonly pendingDecisions = new Map<string, PendingDecision>()
  private readonly activeCommands = new Map<string, ActiveCommand>()
  private readonly activeImageReads = new Map<string, AbortController>()
  private readonly planStates = new Map<string, PlanSnapshot>()
  private readonly metricsStates = new Map<string, { usage?: UsageSnapshot; stats?: StatsSnapshot }>()
  private readonly titleBaselines = new Map<string, boolean>()
  private readonly compactionCauses = new Map<string, string>()
  private readonly subagentBridge: SubagentBridge
  private readonly childPresenters = new Map<string, { readonly agent: AgentLike; readonly presenter: ToolPresenter }>()
  private bound = false
  private native: DshNativeHelpers | undefined
  private live: LiveAgent | undefined
  private pending: PendingSession | undefined
  private switching: Promise<void> = Promise.resolve()
  private closed = false
  private closedEmitted = false
  private decisionSeq = 0
  private modelFailureSignature = ''
  private titleOverride: boolean | undefined
  private toolPresenter: ToolPresenter | undefined
  private reloading: Promise<unknown> | undefined
  private codec: TranscriptCodec | undefined
  /** Native subagent services may activate after the first pending/root ready. */
  private subagentControlCapabilities = ''
  private refreshingSubagentCapabilities: Promise<void> | undefined

  constructor(host: DshHostContext, options: DshContextBackendOptions) {
    this.host = host
    this.options = { ...options }
    this.subagentBridge = new SubagentBridge({
      host: {
        get: (name: string): unknown => this.service(name),
      },
      emit: event => this.emit(event),
      warn: (message: string) => this.warn(message),
    })
    if (options.native !== undefined) {
      this.native = options.native
      this.codec = options.native.transcriptCodec
    }
  }

  get transcriptCodec(): TranscriptCodec | undefined {
    return this.codec
  }

  onEvent(listener: (event: BackendEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // ------------------------------------------------------------------ host

  private service<T extends object>(name: string): T | undefined {
    let value: unknown
    try {
      value = this.host.get(name)
    } catch {
      return undefined
    }
    const item = record(value)
    return item === undefined ? undefined : item as T
  }

  private warn(message: string): void {
    const safe = redactDiagnostic(message)
    try {
      this.options.warn?.(safe)
    } catch {
      /* diagnostics must never break the adapter */
    }
    try {
      this.host.logger?.warn?.(safe)
    } catch {
      /* logger is host-owned */
    }
  }

  private emit(event: BackendEvent): void {
    if (event.type === 'closed') this.closedEmitted = true
    // Adapter diagnostics are redacted; native session events, decisions and
    // tool presentation stay exactly as DSH produced them.
    const outgoing: BackendEvent = event.type === 'warning'
      ? { ...event, message: redactDiagnostic(event.message) }
      : event.type === 'error'
        ? { ...event, message: redactDiagnostic(event.message) }
        : event
    for (const listener of [...this.listeners]) {
      try {
        listener(outgoing)
      } catch {
        /* a UI listener bug must not break native dispatch */
      }
    }
  }

  private assertOpen(): void {
    if (this.closed) throw codedError('CLOSED', 'the backend is closed')
  }

  private async ensureNative(): Promise<DshNativeHelpers> {
    if (this.native !== undefined) return this.native
    this.native = await loadDefaultNative()
    this.codec = this.native.transcriptCodec
    return this.native
  }

  private bindHostEvents(): void {
    if (this.bound) return
    this.bound = true
    const on = this.host.on.bind(this.host) as (
      event: string,
      listener: (...args: unknown[]) => unknown,
      options?: { global?: boolean },
    ) => (() => void) | undefined
    const keep = (event: string, listener: (...args: unknown[]) => unknown, options?: { global?: boolean }): void => {
      try {
        const dispose = on(event, listener, options)
        if (typeof dispose === 'function') this.disposers.push(dispose)
      } catch (error) {
        this.warn(`DSH capability listener ${event} is unavailable: ${errorMessage(error)}`)
      }
    }
    keep('agent/assistant-stream', payload => {
      const item = record(payload)
      if (this.live !== undefined && item?.agent === this.live.agent) {
        this.onStreamFrame(this.live.agent.session.id, record(item?.frame))
        return
      }
      // A child stream reaches the main UI only while its exact session is followed.
      const childId = textOf(record(item?.agent)?.id)
      if (childId === undefined || !this.subagentBridge.isFollowed(childId)) return
      this.onStreamFrame(childId, record(item?.frame))
    }, { global: true })
    keep('session/event', (session, event) => {
      const sessionId = textOf(record(session)?.id)
      if (this.live !== undefined && session === this.live.agent.session) {
        this.rememberCompactionCause(event)
        this.subagentBridge.noteRootEvent(this.live.agent.session.id, event)
        const wire = sessionEventWire(event, this.toolPresenter?.of(event as SessionEvent))
        this.emit({ type: 'session_event', sessionId: this.live.agent.session.id, event: wire })
        return
      }
      if (sessionId === undefined) return
      // Child activity stays a bounded label; only a followed child's own
      // transcript frames are forwarded, under its own session id.
      this.subagentBridge.noteChildEvent(sessionId, event)
      if (!this.subagentBridge.isFollowed(sessionId)) return
      const agent = this.liveAgentOf(sessionId)
      const presenter = agent === undefined ? undefined : this.childPresenter(sessionId, agent)
      const wire = sessionEventWire(event, presenter?.of(event as SessionEvent))
      this.emit({ type: 'session_event', sessionId, event: wire })
    }, { global: true })
    keep('agent/status', payload => {
      const item = record(payload)
      if (this.live !== undefined && item?.agent === this.live.agent) {
        const status = item.status
        if (status !== 'running' && status !== 'idle') return
        this.emit({ type: 'status', sessionId: this.live.agent.session.id, status })
        return
      }
      const childId = textOf(record(item?.agent)?.id)
      if (childId === undefined) return
      this.subagentBridge.noteAgentStatus(childId)
      if (!this.subagentBridge.isFollowed(childId)) return
      const status = item?.status
      if (status !== 'running' && status !== 'idle') return
      this.emit({ type: 'status', sessionId: childId, status })
    }, { global: true })
    keep('agent/error', payload => {
      const item = record(payload)
      if (this.live !== undefined && item?.agent === this.live.agent) {
        this.emit({ type: 'error', message: `agent error: ${errorMessage(item.error)}` })
        return
      }
      const childId = textOf(record(item?.agent)?.id)
      if (childId === undefined) return
      // A child failure is never surfaced as a main-session warning: it stays a
      // bounded activity label plus the native stop reason when the run ends.
      this.subagentBridge.noteAgentError(childId)
    }, { global: true })
    keep('agent/created', payload => {
      const childId = textOf(record(record(payload)?.agent)?.id)
      if (childId !== undefined) this.subagentBridge.noteAgentPresent(childId)
    }, { global: true })
    keep('agent/disposed', payload => {
      const childId = textOf(record(record(payload)?.agent)?.id)
      if (childId === undefined) return
      const cached = this.childPresenters.get(childId)
      if (cached === undefined || cached.agent === record(payload)?.agent) this.childPresenters.delete(childId)
      this.subagentBridge.noteAgentDisposed(childId)
    }, { global: true })
    keep('subagent/start', info => {
      this.refreshSubagentControlCapabilities()
      this.subagentBridge.noteStart(record(info) ?? {})
    }, { global: true })
    keep('subagent/end', info => {
      this.refreshSubagentControlCapabilities()
      this.subagentBridge.noteEnd(record(info) ?? {})
    }, { global: true })
    const projections = this.service<ProjectionsLike>('sessionProjections')
    if (typeof projections?.onChanged === 'function') {
      try {
        const dispose = projections.onChanged((session, key, value) => {
          this.subagentBridge.noteProjection(session, key, value)
          if (this.live === undefined || session !== this.live.agent.session) return
          const sessionId = this.live.agent.session.id
          if (key === 'permissions') {
            const currentValue = record(value)?.currentValue
            if (typeof currentValue === 'string') {
              this.emit({ type: 'permissions', sessionId, value: { currentValue } })
            }
            return
          }
          if (key === 'todos') {
            this.emit({ type: 'todos', sessionId, value: this.todosSnapshotOf(value) })
            return
          }
          if (key === 'plan') {
            this.publishPlan(this.live.agent.session, this.planStateOf(this.live.agent.session))
            return
          }
          if (METRICS_KEYS.has(key)) this.publishMetrics(this.live.agent.session)
        })
        this.disposers.push(dispose)
      } catch (error) {
        this.warn(`DSH projection change feed is unavailable: ${errorMessage(error)}`)
      }
    }
    // Human decisions are answered only for the exact Agent this adapter owns
    // or for a child proven to be in the current root tree. Every other request
    // keeps falling through to DSH's own answerers (fail closed).
    keep('approval/request', (request, next) => {
      const item = record(request)
      if (this.live === undefined || item === undefined) {
        return typeof next === 'function' ? next() : Promise.resolve('unavailable')
      }
      if (item.agent === this.live.agent) return this.askApproval(item)
      return this.childDecision(item, next, origin => this.askApproval(item, origin), 'unavailable')
    }, { global: true })
    keep('user-questions/request', (request, next) => {
      const item = record(request)
      if (this.live === undefined || item === undefined) {
        return typeof next === 'function' ? next() : Promise.resolve({ answers: [] })
      }
      if (item.agent === this.live.agent) return this.askQuestions(item)
      return this.childDecision(item, next, origin => this.askQuestions(item, origin), { answers: [] })
    }, { global: true })
  }

  // ------------------------------------------------------------- lifecycle

  async connect(): Promise<SessionInfo> {
    this.assertOpen()
    this.validateOptions()
    await this.ensureNative()
    this.bindHostEvents()
    let info: SessionInfo
    if (this.live !== undefined) info = await this.sessionInfo(false)
    else if (this.pending !== undefined) info = this.pendingInfo()
    else if (typeof this.options.resume === 'string' && this.options.resume.length > 0) {
      info = await this.switchSession('resume', { sessionId: this.options.resume })
    } else {
      await this.enterPending()
      info = this.pendingInfo()
    }
    this.emitAnnouncement(info)
    return info
  }

  private validateOptions(): void {
    const options = this.options
    if (record(options) === undefined) throw codedError('INVALID_OPTIONS', 'DshContextBackendOptions are required')
    if (typeof options.cwd !== 'string' || options.cwd.trim().length === 0) {
      throw codedError('INVALID_OPTIONS', 'DshContextBackendOptions.cwd must be a non-empty path')
    }
    for (const key of ['resume', 'provider', 'model'] as const) {
      const value = options[key]
      if (value !== undefined && (typeof value !== 'string' || value.trim().length === 0)) {
        throw codedError('INVALID_OPTIONS', `DshContextBackendOptions.${key} must be a non-empty string when present`)
      }
    }
  }

  private capabilities(): string[] {
    const caps = [...BASE_CAPABILITIES]
    const has = (name: string, method: string): boolean => {
      const service = this.service<Record<string, unknown>>(name)
      return service !== undefined && typeof service[method] === 'function'
    }
    if (has('attachments', 'readImage')) caps.push('images')
    if (has('attachments', 'admitPromptContent')) caps.push('prompt-content')
    if (has('llm', 'listProviders') && has('llm', 'listModels')) caps.push('models')
    if (has('sessionQuery', 'readSession')) caps.push('sessions', 'titles')
    if (has('permissionPresets', 'catalog')) caps.push('permissions')
    if (has('agentPresets', 'list')) caps.push('presets', 'preset')
    if (has('llm', 'resolveModelInfo')) caps.push('efforts', 'effort')
    if (has('hmr', 'runExclusive')) caps.push('reload')
    if (has('commands', 'list')) caps.push('commands')
    if (has('commands', 'execute')) caps.push('execute')
    if (has('agents', 'create')) caps.push('model')
    if (this.subagentBridge.available()) {
      caps.push('subagents', 'subagent-session', 'subagent-follow')
      // Capabilities follow the exact mounted native methods, so an older or
      // partial composition never advertises a mutation it cannot perform.
      if (has('subagents', 'interrupt')) caps.push('subagent-interrupt')
      if (has('subagents', 'prompt')) caps.push('subagent-prompt')
    }
    if (this.titleProviderEntries().length > 0) caps.push('auto-title')
    return caps
  }

  private async enterPending(): Promise<PendingSession> {
    const route = await this.routeForPending()
    this.pending = {
      sessionId: randomUUID(),
      attachmentId: randomUUID(),
      route,
      preset: undefined,
    }
    this.live = undefined
    this.toolPresenter = undefined
    this.subagentBridge.setRoot(undefined)
    return this.pending
  }

  private pendingInfo(): SessionInfo {
    const pending = this.pending
    if (pending === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
    const route = pending.route
    return {
      attachmentId: pending.attachmentId,
      sessionId: pending.sessionId,
      cwd: this.options.cwd,
      provider: route?.provider ?? '',
      model: route?.model ?? '',
      ...(typeof route?.reasoningEffort === 'string' ? { reasoningEffort: route.reasoningEffort } : {}),
      ...(pending.preset === undefined ? {} : { preset: pending.preset }),
      capabilities: this.capabilities(),
    }
  }

  private pendingState(): Record<string, unknown> {
    const pending = this.pending
    if (pending === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
    const route = pending.route
    return {
      sessionId: pending.sessionId,
      cwd: this.options.cwd,
      provider: route?.provider ?? '',
      model: route?.model ?? '',
      ...(typeof route?.reasoningEffort === 'string' ? { reasoningEffort: route.reasoningEffort } : {}),
      ...(pending.preset === undefined ? {} : { preset: pending.preset }),
      status: 'idle',
      pending: { nextTurn: 0, nextStep: 0 },
      queued: 0,
      queue: [],
      usage: null,
    }
  }

  private async serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.switching.then(task, task)
    this.switching = run.then(() => undefined, () => undefined)
    return await run
  }

  private async ensureCurrent(): Promise<void> {
    if (this.live !== undefined) return
    await this.serialize(async () => {
      if (this.live !== undefined) return
      const pending = this.pending
      if (pending === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
      const prepared = await this.prepareAgent('new', pending.sessionId, pending.preset, {
        attachmentId: pending.attachmentId,
        route: pending.route,
      })
      try {
        this.commitAgent(prepared)
      } catch (error) {
        await this.discardAgent(prepared)
        throw error
      }
      if (this.pending === pending) this.pending = undefined
      this.emitAnnouncement(await this.sessionInfo(false))
    })
  }

  private commitAgent(prepared: LiveAgent): void {
    this.live = prepared
    this.toolPresenter = this.makeToolPresenter(prepared.agent)
    this.planStates.delete(prepared.agent.session.id)
    this.metricsStates.delete(prepared.agent.session.id)
    // A new top-level session is a new tree: process-local run identity,
    // follow state and cached child rows all belong to the previous root.
    this.subagentBridge.setRoot(prepared.agent.session.id)
    this.childPresenters.clear()
    setImmediate(() => {
      try {
        this.emitProjectionSnapshots()
      } catch {
        /* projection snapshots are a read-only convenience */
      }
    })
  }

  private makeToolPresenter(agent: AgentLike): ToolPresenter | undefined {
    const tools = this.service<ToolsLike>('tools')
    return tools === undefined ? undefined : new ToolPresenter(tools, agent)
  }

  private async prepareAgent(
    kind: 'new' | 'resume',
    sessionId: string,
    presetId: string | undefined,
    options: { attachmentId?: string; route?: Route } = {},
  ): Promise<LiveAgent> {
    const agents = this.service<AgentRegistryLike>('agents')
    if (agents === undefined || typeof agents.create !== 'function' || typeof agents.resume !== 'function') {
      throw codedError('CAPABILITY_UNAVAILABLE', 'the DSH runtime mounts no Agent registry')
    }
    const presets = this.service<AgentPresetsLike>('agentPresets')
    const mountPreset = async (agentCtx: unknown, agent: AgentLike, requested: string | undefined): Promise<void> => {
      if (presets === undefined || typeof presets.mount !== 'function') return
      let id = requested
      if (id === undefined && typeof presets.presetForSession === 'function') {
        try {
          const recorded = presets.presetForSession(agent.session)
          if (typeof recorded === 'string' && recorded.length > 0) id = recorded
        } catch {
          /* a preset-free session */
        }
      }
      // A preset-free persisted session still gets the roster default, the
      // same composition the native web orchestration mounts. Resolution stays
      // inside DSH; the adapter never registers or invents preset declarations.
      if (id === undefined && typeof presets.resolve === 'function') {
        try {
          const resolved = record(await presets.resolve())
          if (typeof resolved?.id === 'string' && resolved.id.length > 0) id = resolved.id
        } catch {
          /* a composition without a default preset */
        }
      }
      if (id !== undefined) await presets.mount(agentCtx, id)
    }
    if (kind === 'resume') {
      let handle: AgentHandleLike
      try {
        handle = await agents.resume({
          resumeSessionId: sessionId,
          setup: async (agentCtx: unknown, agent: AgentLike) => {
            await mountPreset(agentCtx, agent, undefined)
          },
        })
      } catch (error) {
        throw nativeAgentFailure(`DSH could not resume session ${JSON.stringify(sessionId)}`, error)
      }
      const route = routeFromLogged(handle.agent.session.requestHeader?.()) ??
        this.defaultModelSelection() ?? this.explicitConfigRoute()
      return { handle, agent: handle.agent, attachmentId: randomUUID(), route }
    }
    const route = Object.prototype.hasOwnProperty.call(options, 'route')
      ? options.route
      : await this.resolveRoute(undefined)
    const attachmentId = typeof options.attachmentId === 'string' && options.attachmentId.length > 0
      ? options.attachmentId
      : randomUUID()
    let resolvedPreset = presetId
    if (presets !== undefined && typeof presets.resolve === 'function') {
      let resolved: unknown
      try {
        resolved = await presets.resolve(presetId)
      } catch (error) {
        throw nativeAgentFailure(
          `DSH could not resolve the agent preset ${JSON.stringify(presetId ?? 'default')}`,
          error,
        )
      }
      const item = record(resolved)
      if (typeof item?.id !== 'string' || item.id.length === 0) {
        throw codedError('RUNTIME_REQUEST_FAILED', `the agent-preset roster returned no id for ${JSON.stringify(presetId ?? 'default')}`)
      }
      if (typeof item.broken === 'string' && item.broken.length > 0) {
        throw codedError('RUNTIME_REQUEST_FAILED', `agent preset ${JSON.stringify(item.id)} is unavailable: ${item.broken}`)
      }
      resolvedPreset = item.id
    }
    let handle: AgentHandleLike
    try {
      handle = await agents.create({
        sessionId,
        meta: {
          cwd: this.options.cwd,
          ...(resolvedPreset === undefined ? {} : { agentPreset: resolvedPreset }),
        },
        ...(route === undefined ? {} : {
          agentOptions: {
            provider: route.provider,
            model: route.model,
            ...(typeof route.reasoningEffort === 'string' ? { reasoningEffort: route.reasoningEffort } : {}),
          },
        }),
        setup: async (agentCtx: unknown, agent: AgentLike) => {
          await mountPreset(agentCtx, agent, resolvedPreset)
        },
      })
    } catch (error) {
      throw nativeAgentFailure(`DSH could not create session ${JSON.stringify(sessionId)}`, error)
    }
    return { handle, agent: handle.agent, attachmentId, route }
  }

  private async discardAgent(prepared: LiveAgent): Promise<void> {
    try {
      prepared.agent.cancel({ kind: 'disposed' }, { keepInbox: true })
    } catch {
      /* already idle */
    }
    try {
      await withTimeout(prepared.agent.whenIdle(), IDLE_SETTLE_TIMEOUT_MS, 'agent drain')
    } catch {
      /* bounded */
    }
    try {
      await prepared.handle.dispose()
    } catch {
      /* disposal is best effort */
    }
  }

  private async closeAgent(target: LiveAgent, reason: string): Promise<void> {
    const sessionId = target.agent.session.id
    this.closePendingDecisions(reason, sessionId)
    try {
      target.agent.cancel({ kind: 'user' }, { keepInbox: true })
    } catch {
      /* already idle */
    }
    try {
      await withTimeout(target.agent.whenIdle(), IDLE_SETTLE_TIMEOUT_MS, 'agent drain')
    } catch {
      /* proceed */
    }
    if (!this.blankSessionOf(target.agent.session)) {
      try {
        await this.service<SessionsLike>('sessions')?.flush?.(target.agent.session)
      } catch {
        /* persistence failure surfaces on the next resume */
      }
    }
    try {
      await target.handle.dispose()
    } catch {
      /* disposal is best effort */
    }
  }

  // ---------------------------------------------------------------- routes

  private defaultModelSelection(): Route | undefined {
    const defaults = this.service<DefaultModelLike>('agentDefaultModel')
    if (typeof defaults?.currentSelection !== 'function') return undefined
    try {
      return routeOf(defaults.currentSelection())
    } catch {
      return undefined
    }
  }

  private explicitConfigRoute(): Route | undefined {
    if (typeof this.options.provider === 'string' && typeof this.options.model === 'string' &&
        this.options.provider.length > 0 && this.options.model.length > 0) {
      return { provider: this.options.provider, model: this.options.model }
    }
    return undefined
  }

  private async resolveRoute(loggedRoute: Route | undefined): Promise<Route | undefined> {
    const explicit = this.explicitConfigRoute()
    if (explicit !== undefined) return explicit
    if (loggedRoute !== undefined) return loggedRoute
    return this.defaultModelSelection()
  }

  private async routeForPending(): Promise<Route | undefined> {
    try {
      return await this.resolveRoute(undefined)
    } catch {
      return undefined
    }
  }

  private agentRoute(agent: AgentLike | undefined = this.live?.agent): Route | undefined {
    if (agent !== undefined && typeof agent.model?.current === 'function') {
      try {
        const current = routeOf(agent.model.current())
        if (current !== undefined) return current
      } catch {
        /* fall through to the creation fallback */
      }
    }
    if (agent === this.live?.agent && this.live !== undefined) return this.live.route
    if (agent === undefined && this.live === undefined) return this.pending?.route
    return undefined
  }

  private applyRoute(agent: AgentLike, route: Route): void {
    if (typeof agent.model?.select !== 'function') {
      throw codedError('CAPABILITY_UNAVAILABLE', 'this session has no native model-selection slot; the route was not changed')
    }
    agent.model.select({
      provider: route.provider,
      model: route.model,
      ...(typeof route.reasoningEffort === 'string' ? { reasoningEffort: route.reasoningEffort } : {}),
    })
    if (this.live !== undefined && this.live.agent === agent) this.live.route = route
  }

  private currentPreset(): string | undefined {
    const agent = this.live?.agent
    if (agent === undefined) return this.pending?.preset
    const presets = this.service<AgentPresetsLike>('agentPresets')
    if (presets !== undefined && typeof presets.presetForSession === 'function') {
      try {
        const recorded = presets.presetForSession(agent.session)
        if (typeof recorded === 'string' && recorded.length > 0) return recorded
      } catch {
        /* not composed */
      }
    }
    if (typeof presets?.composedPreset === 'function') {
      try {
        const composed = presets.composedPreset(agent.ctx)
        if (typeof composed === 'string' && composed.length > 0) return composed
      } catch {
        /* preset-free composition */
      }
    }
    return undefined
  }

  // --------------------------------------------------------------- session

  private async switchSession(
    kind: 'new' | 'resume',
    params: { sessionId?: string; preset?: string },
    announce = false,
  ): Promise<SessionInfo> {
    if (kind === 'new') {
      const info = await this.startPendingSession(params.preset)
      if (announce) this.emitAnnouncement(info)
      return info
    }
    const sessionId = params.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw codedError('INVALID_ARGUMENT', 'resume requires a non-empty sessionId')
    }
    const info = await this.serialize(async () => {
      const live = this.live
      if (live !== undefined && live.agent.session.id === sessionId) {
        // Same id: reuse the attachment we already own (native `resolve()`
        // semantics). A same-id candidate cannot coexist with it, so a
        // tear-down-then-resume reattachment has no rollback. See
        // docs/BACKEND.md "Lifecycle and attachments".
        this.pending = undefined
        return await this.sessionInfo(true)
      }
      const pending = this.pending
      if (pending !== undefined && pending.sessionId === sessionId) {
        // The staged attachment is already this id; nothing durable exists yet.
        return this.pendingInfo()
      }
      const prepared = await this.prepareAgent('resume', sessionId, undefined)
      const previous = this.live
      try {
        this.commitAgent(prepared)
      } catch (error) {
        await this.discardAgent(prepared)
        throw error
      }
      this.pending = undefined
      if (previous !== undefined) await this.closeAgent(previous, 'session switched')
      return await this.sessionInfo(true)
    })
    if (announce) this.emitAnnouncement(info)
    return info
  }

  private async startPendingSession(presetArg: string | undefined): Promise<SessionInfo> {
    const requested = typeof presetArg === 'string' && presetArg.trim().length > 0 ? presetArg.trim() : undefined
    if (requested !== undefined) await this.resolvePresetId(requested)
    const route = await this.routeForPending()
    return await this.serialize(async () => {
      const previous = this.live
      if (previous !== undefined) {
        this.live = undefined
        this.toolPresenter = undefined
        this.subagentBridge.setRoot(undefined)
        this.childPresenters.clear()
      }
      this.pending = {
        sessionId: randomUUID(),
        attachmentId: randomUUID(),
        route,
        preset: requested,
      }
      if (previous !== undefined) await this.closeAgent(previous, 'session switched')
      return this.pendingInfo()
    })
  }

  private async resolvePresetId(id: string): Promise<string> {
    const presets = this.service<AgentPresetsLike>('agentPresets')
    if (presets === undefined || typeof presets.resolve !== 'function') {
      throw codedError('CAPABILITY_UNAVAILABLE', 'the runtime mounted no agent-preset roster')
    }
    const resolved = record(await presets.resolve(id))
    if (typeof resolved?.id !== 'string' || resolved.id.length === 0) {
      throw codedError('RUNTIME_REQUEST_FAILED', `the agent-preset roster returned no id for ${JSON.stringify(id)}`)
    }
    if (typeof resolved.broken === 'string' && resolved.broken.length > 0) {
      throw codedError('RUNTIME_REQUEST_FAILED', `agent preset ${JSON.stringify(resolved.id)} is unavailable: ${resolved.broken}`)
    }
    return resolved.id
  }

  private emitAnnouncement(info: SessionInfo): void {
    this.subagentControlCapabilities = this.subagentControlCapabilitySignature()
    this.emit({ type: 'ready', info })
    // The ready payload is the authoritative first snapshot; `announce` only
    // records it so later publishes stay idempotent.
    if (info.subagents !== undefined) this.subagentBridge.announce(info.sessionId, info.subagents)
    if (info.snapshotUnavailable === true) {
      this.emit({
        type: 'warning',
        message: 'DSH could not read this session\'s durable history; the transcript is incomplete, not a new conversation.',
      })
    }
  }

  private subagentControlCapabilitySignature(): string {
    return this.capabilities().filter(capability =>
      capability === 'subagent-interrupt' || capability === 'subagent-prompt',
    ).join(' ')
  }

  /**
   * Re-publish a same-attachment ready when DSH activates the native mutation
   * service after the initial pending/root announcement. No snapshot, Editor,
   * session id or attachment id is replaced; without a real change this is inert.
   */
  private refreshSubagentControlCapabilities(): void {
    if (this.closed || this.refreshingSubagentCapabilities !== undefined) return
    const signature = this.subagentControlCapabilitySignature()
    if (signature === this.subagentControlCapabilities) return
    const live = this.live
    const pending = this.pending
    if (live === undefined && pending === undefined) return
    this.subagentControlCapabilities = signature
    const task = (async () => {
      const info = live !== undefined ? await this.sessionInfo(false) : this.pendingInfo()
      if (this.closed || (live !== undefined && this.live !== live) || (pending !== undefined && this.pending !== pending)) return
      this.emitAnnouncement(info)
    })()
    this.refreshingSubagentCapabilities = task
    void task.catch(error => {
      if (!this.closed) this.warn('Could not refresh native subagent capabilities: ' + errorMessage(error))
    }).finally(() => {
      if (this.refreshingSubagentCapabilities === task) this.refreshingSubagentCapabilities = undefined
    })
  }

  private permissionsOf(session: SessionLike): { currentValue: string } | undefined {
    const presets = this.service<PermissionPresetsLike>('permissionPresets')
    if (typeof presets?.current !== 'function') return undefined
    try {
      const current = presets.current(session)
      return typeof current === 'string' ? { currentValue: current } : undefined
    } catch {
      return undefined
    }
  }

  private async sessionInfo(includeSnapshot: boolean): Promise<SessionInfo> {
    const live = this.live
    if (live === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
    const session = live.agent.session
    const route = this.agentRoute(live.agent)
    const permissions = this.permissionsOf(session)
    const preset = this.currentPreset()
    const info: SessionInfo = {
      attachmentId: live.attachmentId,
      sessionId: session.id,
      cwd: this.options.cwd,
      provider: route?.provider ?? live.agent.options?.provider ?? '',
      model: route?.model ?? live.agent.options?.model ?? '',
      ...(typeof route?.reasoningEffort === 'string' ? { reasoningEffort: route.reasoningEffort } : {}),
      ...(preset === undefined ? {} : { preset }),
      ...(permissions === undefined ? {} : { permissions }),
      capabilities: this.capabilities(),
    }
    if (includeSnapshot) {
      const snapshot = await this.snapshotOf(session.id)
      if (snapshot === undefined) {
        info.snapshotUnavailable = true
      } else {
        info.events = snapshot.events
        info.truncated = snapshot.truncated
        info.totalEvents = snapshot.totalEvents
      }
    }
    const subagents = await this.subagentSnapshot(session.id)
    if (subagents !== undefined) info.subagents = subagents
    return info
  }

  /**
   * The current root's native child tree. Reads the mounted projections only;
   * a failure never fails `connect()` or invents an empty catalog.
   */
  private async subagentSnapshot(sessionId: string): Promise<SubagentSnapshot | undefined> {
    try {
      return await this.subagentBridge.snapshotForRoot(sessionId)
    } catch (error) {
      this.warn(`the native subagent catalog could not be read: ${errorMessage(error)}`)
      return undefined
    }
  }

  private async snapshotOf(sessionId: string): Promise<{
    events: SessionEvent[]
    truncated: boolean
    totalEvents: number
  } | undefined> {
    const query = this.service<SessionQueryLike>('sessionQuery')
    if (typeof query?.readSession !== 'function') return undefined
    let rawLog: unknown
    try {
      rawLog = await query.readSession(sessionId)
    } catch {
      // A failed durable read is reported as incomplete, never as empty.
      return undefined
    }
    const log = record(rawLog)
    const raw = Array.isArray(log?.events) ? log.events : []
    const header = record(log?.session)
    const inheritedEventCount = typeof log?.inheritedEventCount === 'number' ? log.inheritedEventCount : 0
    // Preserve the parent catalog event seq used to anchor child rows to the
    // ordered transcript; inherited fork facts are excluded by the projection.
    if (typeof header?.id === 'string') {
      try {
        this.subagentBridge.noteCatalogEvents(header.id, raw, inheritedEventCount)
      } catch {
        /* anchoring is an enhancement, not a transcript failure */
      }
    }
    return this.durableSnapshot(raw, this.toolPresenter)
  }

  /** Newest bounded suffix of one durable log, shared by root and child reads. */
  private durableSnapshot(
    raw: readonly unknown[],
    presenter: ToolPresenter | undefined,
  ): { events: SessionEvent[]; truncated: boolean; totalEvents: number } {
    const wire = raw.map(event => sessionEventWire(event, presenter?.of(event as SessionEvent)))
    const kept: SessionEvent[] = []
    let bytes = 0
    for (let index = wire.length - 1; index >= 0; index -= 1) {
      const event = wire[index]
      const size = wireBytes(event) + 1
      if (kept.length >= MAX_SNAPSHOT_EVENTS) break
      if (bytes + size > SNAPSHOT_BYTE_BUDGET) break
      kept.push(event)
      bytes += size
    }
    kept.reverse()
    return { events: kept, truncated: kept.length < wire.length, totalEvents: wire.length }
  }

  // -------------------------------------------------------------- decisions

  private nextDecisionId(kind: string): string {
    this.decisionSeq += 1
    return `${kind}-${process.pid}-${this.decisionSeq}`
  }

  /**
   * Route one waterfall request to a child only when native tree/lineage
   * proves it belongs to the current root; anything else falls through.
   */
  private childDecision(
    request: Record<string, unknown> | undefined,
    next: unknown,
    ask: (origin: DecisionOrigin) => unknown,
    fallback: unknown,
  ): unknown {
    const childId = textOf(record(request?.agent)?.id)
    if (childId === undefined) return typeof next === 'function' ? (next as () => unknown)() : fallback
    return this.subagentBridge.originFor(childId).then(
      (origin: DecisionOrigin | undefined) => {
        if (origin === undefined) return typeof next === 'function' ? (next as () => unknown)() : fallback
        return ask(origin)
      },
      () => typeof next === 'function' ? (next as () => unknown)() : fallback,
    )
  }

  private askApproval(request: Record<string, unknown>, origin?: DecisionOrigin): Promise<unknown> {
    const id = this.nextDecisionId('approval')
    const title = typeof request.toolName === 'string' ? `Approve ${request.toolName}` : 'Approve tool'
    const display = record(request.displayReason)
    const message = typeof request.reason === 'string'
      ? request.reason
      : typeof display?.en === 'string' ? display.en : undefined
    this.emit({
      type: 'decision',
      sessionId: origin?.rootSessionId ?? this.live?.agent.session.id ?? '',
      request: {
        id,
        kind: 'approval',
        title,
        ...(message === undefined ? {} : { message }),
        options: [
          { label: 'Allow once', description: 'Permit exactly this action.', value: 'allowed-once' },
          { label: 'Reject', description: 'Decline the action.', value: 'rejected' },
        ],
        ...(origin === undefined ? {} : { origin }),
      },
    })
    const signal = request.signal instanceof AbortSignal ? request.signal : undefined
    return this.awaitDecision(id, 'approval', signal).then(
      value => normalizeApprovalOutcome(value),
      () => 'cancelled',
    )
  }

  private askQuestions(request: Record<string, unknown>, origin?: DecisionOrigin): Promise<unknown> {
    const id = this.nextDecisionId('question')
    const questions = Array.isArray(request.questions)
      ? request.questions.map(question => record(question)).filter((question): question is Record<string, unknown> => question !== undefined)
      : []
    const options = (question: Record<string, unknown>): Array<{ label: string; description?: string; preview?: string }> =>
      (Array.isArray(question.options) ? question.options : []).flatMap((option) => {
        const item = record(option)
        if (item === undefined || typeof item.label !== 'string') return []
        return [{
          label: item.label,
          ...(typeof item.description === 'string' ? { description: item.description } : {}),
          ...(typeof item.preview === 'string' ? { preview: item.preview } : {}),
        }]
      })
    const requestWire: DecisionRequest = {
      id,
      kind: 'question',
      title: typeof questions[0]?.header === 'string' ? questions[0].header : 'Question',
      ...(origin === undefined ? {} : { origin }),
      questions: questions.map(question => ({
        ...(typeof question.id === 'string' ? { id: question.id } : {}),
        ...(question.intent === undefined ? {} : { intent: jsonSafe(question.intent) as string | JsonRecord }),
        ...(typeof question.detail === 'string' && question.detail.length > 0 ? { detail: question.detail } : {}),
        question: typeof question.question === 'string' ? question.question : '',
        ...(typeof question.header === 'string' ? { header: question.header } : {}),
        ...(question.multiSelect === true ? { multiSelect: true } : {}),
        options: options(question),
      })),
    }
    this.emit({
      type: 'decision',
      sessionId: origin?.rootSessionId ?? this.live?.agent.session.id ?? '',
      request: requestWire,
    })
    const signal = request.signal instanceof AbortSignal ? request.signal : undefined
    return this.awaitDecision(id, 'question', signal).then(
      value => normalizeAskAnswer(questions, value),
      (error: unknown) => {
        const code = record(error)?.code
        const stable = typeof code === 'string' && code.length > 0 ? code : 'ASK_ABORTED'
        const rejected = new Error(errorMessage(error))
        rejected.name = 'UserQuestionError'
        Object.assign(rejected, { code: stable })
        throw rejected
      },
    )
  }

  private awaitDecision(id: string, kind: 'approval' | 'question', signal: AbortSignal | undefined): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const entry: PendingDecision = {
        kind,
        signal,
        resolve,
        reject,
        onAbort: () => {
          if (kind === 'question') this.settleDecision(id, undefined, codedError('RUNTIME_REQUEST_FAILED', 'question cancelled'), undefined, 'ASK_ABORTED')
          else this.settleDecision(id, undefined)
        },
      }
      this.pendingDecisions.set(id, entry)
      if (signal !== undefined) {
        if (signal.aborted) entry.onAbort()
        else signal.addEventListener('abort', entry.onAbort, { once: true })
      }
    })
  }

  private settleDecision(
    id: string,
    value?: unknown,
    error?: Error,
    sessionId: string = this.live?.agent.session.id ?? '',
    errorCode?: string,
  ): boolean {
    const entry = this.pendingDecisions.get(id)
    if (entry === undefined) return false
    this.pendingDecisions.delete(id)
    try {
      entry.signal?.removeEventListener('abort', entry.onAbort)
    } catch {
      /* signal already gone */
    }
    this.emit({ type: 'decision_closed', sessionId, id })
    if (error === undefined) entry.resolve(value)
    else {
      if (errorCode !== undefined) Object.assign(error, { code: errorCode })
      entry.reject(error)
    }
    return true
  }

  private closePendingDecisions(reason: string, sessionId: string): void {
    for (const id of [...this.pendingDecisions.keys()]) {
      const entry = this.pendingDecisions.get(id)
      if (entry === undefined) continue
      if (entry.kind === 'approval') this.settleDecision(id, undefined, undefined, sessionId)
      else this.settleDecision(id, undefined, codedError('RUNTIME_REQUEST_FAILED', reason), sessionId, 'ASK_ABORTED')
    }
  }

  async respond(id: string, value: unknown): Promise<void> {
    this.assertOpen()
    if (typeof id !== 'string' || id.length === 0) throw codedError('INVALID_ARGUMENT', 'respond requires a decision id')
    const entry = this.pendingDecisions.get(id)
    if (entry === undefined) throw codedError('STALE_DECISION', `unknown or already settled decision: ${id}`)
    const cancelled = isCancelledValue(value)
    if (entry.kind === 'approval') this.settleDecision(id, cancelled ? undefined : value)
    else if (cancelled) {
      this.settleDecision(
        id,
        undefined,
        codedError('RUNTIME_REQUEST_FAILED', 'the user cancelled ask_user_question'),
        undefined,
        'ASK_CANCELLED',
      )
    } else this.settleDecision(id, value)
  }

  // -------------------------------------------------------------- subagents

  /** The exact live Agent of one child id, never created or resumed here. */
  private liveAgentOf(sessionId: string): AgentLike | undefined {
    const agents = this.service<AgentRegistryLike>('agents')
    if (typeof agents?.get !== 'function') return undefined
    try {
      return agents.get(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * Reuse one ephemeral tool-card presenter per followed child Agent. A new
   * activation of the same durable child reuses the session id, so the cached
   * entry is keyed by the exact Agent object as well.
   */
  private childPresenter(sessionId: string, agent: AgentLike): ToolPresenter | undefined {
    const existing = this.childPresenters.get(sessionId)
    if (existing !== undefined && existing.agent === agent) return existing.presenter
    const presenter = this.makeToolPresenter(agent)
    if (presenter === undefined) {
      this.childPresenters.delete(sessionId)
      return undefined
    }
    this.childPresenters.set(sessionId, { agent, presenter })
    return presenter
  }

  // ----------------------------------------------------------------- stream

  private onStreamFrame(sessionId: string, frame: Record<string, unknown> | undefined): void {
    if (frame === undefined) return
    const attemptId = String(frame.attemptId)
    if (frame.type === 'start') {
      if (typeof frame.revision !== 'number' || typeof frame.turn !== 'number' || typeof frame.step !== 'number') return
      this.emit({
        type: 'stream_start',
        sessionId,
        attemptId,
        revision: frame.revision,
        turn: frame.turn,
        step: frame.step,
      })
      return
    }
    if (frame.type === 'chunk') {
      if (typeof frame.revision !== 'number' || typeof frame.index !== 'number') return
      const chunk = record(jsonSafe(frame.chunk)) ?? {}
      this.emit({
        type: 'stream_chunk',
        sessionId,
        attemptId,
        revision: frame.revision,
        index: frame.index,
        chunk,
        ...(typeof frame.time === 'number' ? { time: frame.time } : {}),
      })
      return
    }
    if (frame.type !== 'end' || typeof frame.revision !== 'number') return
    const outcome = record(frame.outcome)
    if (outcome?.kind === 'committed' && typeof outcome.seq === 'number') {
      this.emit({ type: 'stream_end', sessionId, attemptId, revision: frame.revision, outcome: 'committed', seq: outcome.seq })
    } else {
      this.emit({ type: 'stream_end', sessionId, attemptId, revision: frame.revision, outcome: 'abandoned' })
    }
  }

  // --------------------------------------------------------------- sending

  private userMessage(text: string): unknown {
    const native = this.native
    if (native === undefined) {
      throw codedError('CAPABILITY_UNAVAILABLE', 'cannot create a native user message: the DSH llm helpers are unavailable')
    }
    return native.createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  }

  async send(text: string, mode: 'followup' | 'steer' = 'followup'): Promise<void> {
    this.assertOpen()
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw codedError('INVALID_ARGUMENT', 'send requires non-empty text')
    }
    if (mode !== 'followup' && mode !== 'steer') throw codedError('INVALID_ARGUMENT', `unsupported send mode: ${String(mode)}`)
    await this.ensureNative()
    await this.ensureCurrent()
    const agent = this.live?.agent
    if (agent === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
    const message = this.userMessage(text)
    if (mode === 'steer') agent.steer(message)
    else agent.followup(message)
  }

  async sendContent(content: readonly PromptContentPart[], mode: 'followup' | 'steer' = 'followup'): Promise<void> {
    this.assertOpen()
    if (mode !== 'followup' && mode !== 'steer') throw codedError('INVALID_ARGUMENT', `unsupported send mode: ${String(mode)}`)
    const parts = normalizePromptContent(content)
    const hasImage = parts.some(part => part.type === 'image')
    if (!parts.some(part => part.type === 'image' || part.text.trim().length > 0)) {
      throw codedError('INVALID_ARGUMENT', 'sendContent requires non-whitespace text or an image')
    }
    if (!hasImage) {
      await this.send(parts.map(part => part.type === 'text' ? part.text : '').join('\n'), mode)
      return
    }
    const attachments = this.service<AttachmentsLike>('attachments')
    if (typeof attachments?.admitPromptContent !== 'function') {
      throw codedError(
        'CAPABILITY_UNAVAILABLE',
        'this runtime mounts no native attachment admission (ctx.attachments.admitPromptContent); the prompt was not sent',
      )
    }
    await this.ensureNative()
    await this.ensureCurrent()
    const live = this.live
    if (live === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
    let admitted: readonly unknown[]
    try {
      admitted = await attachments.admitPromptContent(parts)
    } catch (error) {
      throw codedError('RUNTIME_REQUEST_FAILED', `the native attachment store refused the prompt: ${errorMessage(error)}`)
    }
    if (this.live !== live) throw codedError('STALE_SESSION', 'the DSH Agent attachment changed during prompt admission; the prompt was not sent')
    const native = await this.ensureNative()
    const message = native.createUserMessage({ content: admitted, source: { kind: 'user' } })
    if (mode === 'steer') await live.agent.steer(message)
    else await live.agent.followup(message)
  }

  async readImage(attachment: ImageAttachmentRef, signal?: AbortSignal): Promise<ImageAttachmentValue> {
    this.assertOpen()
    const ref = asImageAttachmentRef(attachment)
    if (ref === undefined) throw codedError('INVALID_ARGUMENT', 'readImage requires a native image attachment reference')
    const attachments = this.service<AttachmentsLike>('attachments')
    if (typeof attachments?.readImage !== 'function') {
      throw codedError('CAPABILITY_UNAVAILABLE', 'this runtime mounts no native attachment store; image bytes cannot be read')
    }
    if (signal?.aborted === true) throw codedError('ABORTED', 'the image read was cancelled')
    const id = randomUUID()
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    this.activeImageReads.set(id, controller)
    try {
      let stored: Record<string, unknown> | undefined
      try {
        stored = record(await attachments.readImage(ref, controller.signal))
      } catch (error) {
        if (controller.signal.aborted) throw codedError('ABORTED', 'the image read was cancelled')
        throw error
      }
      if (controller.signal.aborted) throw codedError('ABORTED', 'the image read was cancelled')
      const data = stored?.data
      if (!(data instanceof Uint8Array)) {
        throw codedError('RUNTIME_REQUEST_FAILED', 'the attachment store returned no verified image bytes')
      }
      const verified = asImageAttachmentRef(stored?.ref ?? stored?.attachment)
      if (verified === undefined || !sameImageAttachment(verified, ref) || data.length !== verified.bytes) {
        throw codedError('RUNTIME_REQUEST_FAILED', 'the attachment store returned bytes that do not match the requested reference')
      }
      return imageAttachmentValue({ attachment: verified, data: Buffer.from(data).toString('base64') }, ref)
    } finally {
      signal?.removeEventListener('abort', abort)
      this.activeImageReads.delete(id)
    }
  }

  // -------------------------------------------------------- projections/etc

  private projectionValuesOf(session: SessionLike, keys: readonly string[]): Record<string, unknown> {
    const projections = this.service<ProjectionsLike>('sessionProjections')
    const read = (key: string): unknown => {
      try {
        return projections?.stateOf?.(session, key)
      } catch {
        return undefined
      }
    }
    if (typeof projections?.snapshot === 'function') {
      try {
        const values = record(projections.snapshot(session, keys))?.values
        if (record(values) !== undefined) return values as Record<string, unknown>
      } catch {
        /* fall back to host reads */
      }
    }
    const values: Record<string, unknown> = {}
    for (const key of keys) values[key] = read(key)
    return values
  }

  private planStateOf(session: SessionLike): unknown {
    const projections = this.service<ProjectionsLike>('sessionProjections')
    if (typeof projections?.stateOf !== 'function') return undefined
    try {
      return projections.stateOf(session, 'plan')
    } catch {
      return undefined
    }
  }

  private planSnapshotOf(value: unknown): PlanSnapshot {
    const state = record(value) ?? {}
    const running = record(state.running)
    return {
      active: state.active === true,
      wanted: typeof state.wanted === 'boolean' ? state.wanted : null,
      running: running !== undefined && typeof running.commandId === 'string' && typeof running.wanted === 'boolean'
        ? { commandId: running.commandId, wanted: running.wanted }
        : null,
    }
  }

  private publishPlan(session: SessionLike, state: unknown): boolean {
    if (state === undefined) return false
    const snapshot = this.planSnapshotOf(state)
    const previous = this.planStates.get(session.id)
    if (previous !== undefined && samePlanSnapshot(previous, snapshot)) return false
    this.planStates.set(session.id, snapshot)
    const engaged = snapshot.active || snapshot.wanted !== null || snapshot.running !== null
    if (previous === undefined && !engaged) return false
    this.emit({ type: 'plan', sessionId: session.id, value: snapshot })
    return true
  }

  private usageOf(session: SessionLike): UsageSnapshot | undefined {
    const values = this.projectionValuesOf(session, ['contextPressure', 'tokenUsage', 'contextBreakdown'])
    const fact = (value: unknown): number | undefined =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
    const pressure = record(values.contextPressure)
    const size = fact(pressure?.contextWindow)
    let used = fact(pressure?.projectedTokens) ?? fact(pressure?.pressureTokens)
    if (used === undefined || used === 0) {
      const breakdown = record(values.contextBreakdown)
      const composition = record(breakdown?.breakdown) ?? breakdown
      const total = (fact(composition?.systemTokens) ?? 0) +
        (fact(composition?.toolsTokens) ?? 0) +
        (fact(composition?.messageTokens) ?? 0)
      if (total > 0) used = total
    }
    const tokenUsage = record(values.tokenUsage)
    const totals = record(tokenUsage?.totals) ?? tokenUsage
    const cacheRead = fact(totals?.cacheReadTokens)
    const billedInput = (fact(totals?.uncachedInputTokens) ?? 0) + (cacheRead ?? 0) + (fact(totals?.cacheWriteTokens) ?? 0)
    const cachePct = cacheRead !== undefined && cacheRead > 0 && billedInput > 0
      ? Math.min(100, (cacheRead * 100) / billedInput)
      : undefined
    const totalTokens = totals !== undefined ? billedInput + (fact(totals.outputTokens) ?? 0) : undefined
    const usage: UsageSnapshot = {
      ...(used === undefined || size === undefined ? {} : { used, size }),
      ...(cachePct === undefined ? {} : { cachePct }),
      ...(totalTokens === undefined || totalTokens === 0 ? {} : { totalTokens }),
    }
    return Object.keys(usage).length === 0 ? undefined : usage
  }

  private statsOfSession(session: SessionLike): StatsSnapshot | undefined {
    try {
      return statsOf(this.projectionValuesOf(session, ['sessionStats']).sessionStats)
    } catch {
      return undefined
    }
  }

  private publishMetrics(session: SessionLike): boolean {
    const usage = this.usageOf(session)
    const stats = this.statsOfSession(session)
    if (usage === undefined && stats === undefined) return false
    const next = {
      ...(usage === undefined ? {} : { usage }),
      ...(stats === undefined ? {} : { stats }),
    }
    const previous = this.metricsStates.get(session.id)
    if (previous !== undefined && sameNumberRecord(previous.usage as unknown as Record<string, number> | undefined, next.usage as unknown as Record<string, number> | undefined) &&
        sameNumberRecord(previous.stats as unknown as Record<string, number> | undefined, next.stats as unknown as Record<string, number> | undefined)) {
      return false
    }
    this.metricsStates.set(session.id, next)
    this.emit({ type: 'metrics', sessionId: session.id, ...next })
    return true
  }

  private todosSnapshotOf(value: unknown): TodosSnapshot {
    if (!Array.isArray(value)) return null
    return value.flatMap((item) => {
      const entry = record(item)
      if (entry === undefined || typeof entry.content !== 'string') return []
      const status = entry.status
      if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return []
      return [{ content: entry.content, status }]
    })
  }

  private emitProjectionSnapshots(): void {
    const session = this.live?.agent.session
    if (session === undefined) return
    const projections = this.service<ProjectionsLike>('sessionProjections')
    if (typeof projections?.stateOf !== 'function' && typeof projections?.snapshot !== 'function') return
    const read = (key: string): unknown => {
      try {
        return projections?.stateOf?.(session, key)
      } catch {
        return undefined
      }
    }
    const todos = read('todos')
    if (todos !== undefined) this.emit({ type: 'todos', sessionId: session.id, value: this.todosSnapshotOf(todos) })
    this.publishPlan(session, read('plan'))
    this.publishMetrics(session)
  }

  private blankSessionOf(session: SessionLike): boolean {
    const projections = this.service<ProjectionsLike>('sessionProjections')
    if (projections === undefined) return false
    try {
      const boundary = record(projections.stateOf?.(session, 'turnBoundary'))
      if (boundary === undefined) return false
      return boundary.openTurnStartSeq === null && boundary.lastTurn === 0
    } catch {
      return false
    }
  }

  // --------------------------------------------------------------- commands

  async cancel(): Promise<void> {
    this.assertOpen()
    const live = this.live
    if (live === undefined) return
    const sessionId = live.agent.session.id
    this.abortActiveCommands('command cancelled', sessionId)
    live.agent.cancel({ kind: 'user' }, { keepInbox: true })
    this.closePendingDecisions('cancelled', sessionId)
    if (live.agent.status === 'running') {
      try {
        await withTimeout(live.agent.whenIdle(), CANCEL_SETTLE_TIMEOUT_MS, 'agent cancel')
      } catch {
        /* the native cancellation was already requested */
      }
    }
  }

  async command(name: string, args: JsonRecord = {}): Promise<unknown> {
    this.assertOpen()
    if (typeof name !== 'string' || name.length === 0) throw codedError('INVALID_ARGUMENT', 'command requires a name')
    if (!COMMAND_NAMES.has(name)) throw codedError('UNSUPPORTED_COMMAND', `unsupported command: ${name}`)
    const params = record(args) ?? {}
    if (name === 'reload') return await this.reloadRuntime()
    if (!SESSIONLESS_COMMANDS.has(name) && !STAGEABLE_COMMANDS.has(name)) await this.ensureCurrent()
    switch (name) {
      case 'models': return await this.listModels()
      case 'sessions': return await this.listSessions(params)
      case 'titles': return await this.listTitles(params)
      case 'commands': return this.controlCommands()
      case 'execute': return await this.executeCommand(params)
      case 'cancel': await this.cancel(); return undefined
      case 'new': return await this.switchSession('new', {}, true)
      case 'resume': return await this.switchSession('resume', { sessionId: typeof params.sessionId === 'string' ? params.sessionId : undefined }, true)
      case 'model': return await this.setModel(params)
      case 'presets': return await this.listPresets()
      case 'preset': return await this.setPreset(params)
      case 'efforts': return await this.listEfforts()
      case 'effort': return await this.setEffort(params)
      case 'permissions': return this.permissions()
      case 'auto-title': return await this.autoTitle(params)
      case 'state': return await this.state()
      case 'dequeue': return this.dequeue()
      case 'queue-remove': return this.queueRemove(params)
      case 'queue-replace': return await this.queueReplace(params)
      case 'queue-send-now': return await this.queueSendNow(params)
      case 'subagent-session': return await this.subagentSession(params)
      case 'subagent-follow': return await this.subagentFollow(params)
      case 'subagent-interrupt': return await this.subagentInterrupt(params)
      case 'subagent-prompt': return await this.subagentPrompt(params)
      default: throw codedError('UNSUPPORTED_COMMAND', `unsupported command: ${name}`)
    }
  }

  private controlCommands(): unknown[] {
    const commands = this.service<CommandsLike>('commands')
    if (typeof commands?.list !== 'function') {
      throw codedError('CAPABILITY_UNAVAILABLE', 'the runtime mounted no human-command registry')
    }
    return commands.list(this.live?.agent).flatMap((value) => {
      const descriptor = record(value)
      if (descriptor === undefined || typeof descriptor.name !== 'string') return []
      const input = record(descriptor.input)
      return [{
        ...(descriptor.definitionId === undefined ? {} : { definitionId: String(descriptor.definitionId) }),
        name: descriptor.name,
        description: typeof descriptor.description === 'string' ? descriptor.description : '',
        ...(input === undefined
          ? {}
          : { input: { hint: input.hint, ...(input.attachments === true ? { attachments: true } : {}) } }),
      }]
    })
  }

  private async executeCommand(params: Record<string, unknown>): Promise<unknown> {
    const live = this.live
    if (live === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
    const commands = this.service<CommandsLike>('commands')
    if (typeof commands?.execute !== 'function') {
      throw codedError('CAPABILITY_UNAVAILABLE', 'the runtime mounted no human-command registry')
    }
    const line = params.line
    if (typeof line !== 'string' || line.trim().length === 0) {
      throw codedError('INVALID_ARGUMENT', 'execute requires a non-empty command line')
    }
    if (!line.trimStart().startsWith('/')) throw codedError('INVALID_ARGUMENT', 'execute requires a slash command line')
    const requestId = randomUUID()
    const controller = new AbortController()
    let settle: () => void = () => {}
    const settled = new Promise<void>(resolve => { settle = resolve })
    this.activeCommands.set(requestId, { requestId, controller, sessionId: live.agent.session.id, settled, settle })
    try {
      const execution = record(await commands.execute(live.agent, line, [], controller.signal))
      if (execution === undefined) {
        const commandName = line.trimStart().slice(1).split(/\s/, 1)[0]
        throw codedError('UNSUPPORTED_COMMAND', `unknown or malformed command: /${commandName}`)
      }
      return jsonSafe({ commandId: execution.commandId, result: this.commandResult(line, execution, live.agent.session.id) })
    } finally {
      this.activeCommands.delete(requestId)
      settle()
    }
  }

  /**
   * Remember one failed native compaction attempt's own error text, keyed by
   * the human command that started it.
   *
   * `compaction/end` is appended synchronously inside the native compaction
   * transaction — before the `/compact` handler settles — and `session/event`
   * dispatch is synchronous post-commit, so the correlation entry is already
   * present when the command execution result arrives. Only the live session's
   * own events are considered, never durable session files.
   *
   * @param event - a native session event exactly as appended.
   */
  private rememberCompactionCause(event: unknown): void {
    const item = record(event)
    if (item?.type !== 'compaction/end') return
    const data = record(item.data)
    const commandId = typeof data?.sourceCommandId === 'string' && data.sourceCommandId.length > 0
      ? data.sourceCommandId
      : undefined
    const error = typeof data?.error === 'string' ? data.error.trim() : ''
    if (commandId === undefined || error.length === 0) return
    if (this.live === undefined) return
    const key = compactionCauseKey(this.live.agent.session.id, commandId)
    this.compactionCauses.delete(key)
    this.compactionCauses.set(key, error.length > MAX_COMPACTION_CAUSE_CHARS
      ? error.slice(0, MAX_COMPACTION_CAUSE_CHARS)
      : error)
    while (this.compactionCauses.size > MAX_COMPACTION_CAUSES) {
      const oldest = this.compactionCauses.keys().next()
      if (oldest.done === true) break
      this.compactionCauses.delete(oldest.value)
    }
  }

  /**
   * Attach one observed native cause to a failed `/compact` result.
   *
   * The generic text native `dsh-command-compact` renders is preserved
   * verbatim; a bounded, single-line, credential-redacted `Native cause:`
   * detail is appended only for an error result of the exact `/compact`
   * command whose `commandId` correlates with a `compaction/end` error. A
   * successful result, another command, or a command with no observed cause is
   * returned untouched, so the native generic fallback survives.
   *
   * @param line - the exact slash command line that was dispatched.
   * @param execution - the native `CommandExecution` record.
   * @param sessionId - the session that owned this command execution.
   * @returns the native result, enriched only when a cause was observed.
   */
  private commandResult(line: string, execution: Record<string, unknown>, sessionId: string): unknown {
    const result = record(execution.result)
    const commandId = typeof execution.commandId === 'string' && execution.commandId.length > 0
      ? execution.commandId
      : undefined
    if (commandId === undefined) return execution.result
    const name = line.trimStart().slice(1).split(/\s/, 1)[0]
    if (name !== COMPACT_COMMAND) return execution.result
    const key = compactionCauseKey(sessionId, commandId)
    const cause = this.compactionCauses.get(key)
    this.compactionCauses.delete(key)
    if (result?.kind !== 'error' || typeof result.text !== 'string') return execution.result
    const detail = cause === undefined ? undefined : oneLineDiagnostic(cause)
    return detail === undefined ? execution.result : { ...result, text: `${result.text}\nNative cause: ${detail}` }
  }

  private abortActiveCommands(reason: string, sessionId?: string): number {
    let count = 0
    for (const entry of this.activeCommands.values()) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue
      if (entry.controller.signal.aborted) continue
      entry.controller.abort(codedError('ABORTED', reason))
      count += 1
    }
    return count
  }

  private async drainCommands(timeoutMs: number): Promise<void> {
    const pending = [...this.activeCommands.values()].map(entry => entry.settled)
    if (pending.length === 0) return
    try {
      await withTimeout(Promise.allSettled(pending), timeoutMs, 'native command drain')
    } catch {
      /* bounded */
    }
  }

  // ---------------------------------------------------------------- models

  private async modelCatalog(): Promise<{ items: ModelRow[]; failures: string[]; defaultSelection: Route | undefined }> {
    const llm = this.service<LlmLike>('llm')
    if (typeof llm?.listProviders !== 'function' || typeof llm.listModels !== 'function') {
      throw codedError('CAPABILITY_UNAVAILABLE', 'the runtime mounted no LLM provider catalog (ctx.llm.listProviders/listModels)')
    }
    const defaults = this.live !== undefined
      ? this.agentRoute(this.live.agent)
      : this.pending?.route ?? this.defaultModelSelection()
    const items: ModelRow[] = []
    const failures: string[] = []
    let providers: readonly { readonly id: string; readonly name?: string }[]
    try {
      providers = llm.listProviders()
    } catch (error) {
      throw codedError('MODELS_UNAVAILABLE', `the native LLM provider registry failed: ${errorMessage(error)}`)
    }
    for (const provider of providers) {
      try {
        const models = await withTimeout(Promise.resolve(llm.listModels(provider.id)), 8_000, `listModels(${provider.id})`)
        for (const model of models) {
          const row = modelRow(provider.id, model, defaults)
          if (row !== undefined) items.push(row)
        }
      } catch (error) {
        failures.push(`${provider.id}: ${errorMessage(error)}`)
      }
    }
    return { items, failures, defaultSelection: defaults }
  }

  private async listModels(): Promise<unknown[]> {
    const { items, failures } = await this.modelCatalog()
    if (items.length === 0) {
      throw codedError(
        'MODELS_UNAVAILABLE',
        `no model routes are available${failures.length > 0 ? ` (${failures.join('; ')})` : ''}; configure a DSH provider/credential or pass provider/model explicitly`,
      )
    }
    const signature = failures.join('\n')
    if (failures.length > 0 && signature !== this.modelFailureSignature) {
      this.modelFailureSignature = signature
      this.emit({ type: 'warning', message: `Some DSH model providers are unavailable: ${failures.join('; ')}` })
    }
    return items
  }

  private async setModel(args: Record<string, unknown>): Promise<unknown> {
    if (this.live === undefined) {
      const pending = this.pending
      if (pending === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
      const { items } = await this.modelCatalog()
      const entry = selectModelRow(items, args)
      if (entry === undefined) throw codedError('UNKNOWN_MODEL', unknownModelMessage(args))
      // The target's reasoning metadata belongs to resolveModelInfo, not the
      // list DTO. Read it only for the selected target, after selection.
      const targetReasoning = await this.effortReasoningFor(entry)
      if (this.pending !== pending || this.live !== undefined) {
        throw codedError('STALE_SESSION', 'the Agent attachment changed during model selection')
      }
      const effort = carriedEffort(targetReasoning, pending.route?.reasoningEffort)
      pending.route = {
        provider: String(entry.provider),
        model: String(entry.model),
        ...(typeof effort === 'string' && effort.length > 0 ? { reasoningEffort: effort } : {}),
      }
      const saved = await this.saveDefaultSelection(pending.route)
      return {
        ...entry,
        ...(typeof effort === 'string' && effort.length > 0 ? { reasoningEffort: effort } : {}),
        ...saved,
      }
    }
    const live = this.live
    const previousRoute = this.agentRoute(live.agent)
    const { items } = await this.modelCatalog()
    const entry = selectModelRow(items, args)
    if (entry === undefined) throw codedError('UNKNOWN_MODEL', unknownModelMessage(args))
    const targetReasoning = await this.effortReasoningFor(entry)
    // The catalog and metadata reads are asynchronous: the attachment and the
    // route must still be the exact ones this selection started from.
    if (this.live !== live || !sameRoute(this.agentRoute(live.agent), previousRoute)) {
      throw codedError('STALE_SESSION', 'the model route changed during model selection; the obsolete selection was neither applied nor saved')
    }
    const effort = carriedEffort(targetReasoning, previousRoute?.reasoningEffort)
    const route: Route = {
      provider: String(entry.provider),
      model: String(entry.model),
      ...(typeof effort === 'string' && effort.length > 0 ? { reasoningEffort: effort } : {}),
    }
    this.applyRoute(live.agent, route)
    const saved = await this.saveDefaultSelection(route)
    return {
      ...entry,
      ...(typeof effort === 'string' && effort.length > 0 ? { reasoningEffort: effort } : {}),
      ...saved,
    }
  }

  private async saveDefaultSelection(next: Route): Promise<Record<string, unknown>> {
    const defaults = this.service<DefaultModelLike>('agentDefaultModel')
    if (typeof defaults?.saveSelection !== 'function') {
      return {
        defaultsPersisted: false,
        defaultPersistence: 'unavailable',
        defaultWarning: 'DSH exposes no native default-model save service in this composition; only this session changed.',
      }
    }
    try {
      await withTimeout(defaults.saveSelection(next), 30_000, 'save default model selection')
      const current = typeof defaults.currentSelection === 'function' ? routeOf(defaults.currentSelection()) : undefined
      if (!sameRoute(current, next)) {
        return {
          defaultsPersisted: false,
          defaultPersistence: 'unavailable',
          defaultWarning: 'This is not the native current default. DSH may have no configuration editor, or a newer selection superseded it; no successful default save is claimed.',
        }
      }
    } catch (error) {
      return {
        defaultsPersisted: false,
        defaultPersistence: 'failed',
        defaultWarning: `DSH did not save this as the default: ${errorMessage(error)}`,
      }
    }
    return {
      defaultsPersisted: false,
      defaultPersistence: 'native',
      defaultWarning: 'Saved through DSH\'s native default-selection service. Persistence is owned by the host\'s mounted ConfigEditor; this adapter cannot confirm a profile flush.',
    }
  }

  // --------------------------------------------------------------- presets

  private presetService(): AgentPresetsLike | undefined {
    const presets = this.service<AgentPresetsLike>('agentPresets')
    return typeof presets?.list === 'function' && typeof presets.resolve === 'function' ? presets : undefined
  }

  private async listPresets(): Promise<unknown> {
    const presets = this.presetService()
    if (presets === undefined) throw codedError('CAPABILITY_UNAVAILABLE', 'the runtime mounted no agent-preset roster')
    const roster = await presets.list?.()
    const pending = this.live === undefined ? this.pending : undefined
    const current = pending !== undefined ? undefined : this.currentPreset()
    const defaultId = typeof presets.defaultId === 'string' ? presets.defaultId : undefined
    return jsonSafe({
      current: current ?? null,
      blank: pending !== undefined ? true : this.isBlankSession(),
      ...(defaultId === undefined ? {} : { default: defaultId }),
      presets: (Array.isArray(roster) ? roster : []).flatMap((row) => {
        const item = record(row)
        if (item === undefined || typeof item.id !== 'string') return []
        return [{
          ...item,
          current: item.id === current,
          ...(defaultId === item.id ? { isDefault: true } : {}),
        }]
      }),
    })
  }

  private isBlankSession(): boolean {
    return this.blankSessionOf(this.live?.agent.session as SessionLike)
  }

  private async setPreset(args: Record<string, unknown>): Promise<unknown> {
    const id = typeof args.id === 'string' ? args.id.trim() : ''
    if (id.length === 0) throw codedError('INVALID_ARGUMENT', 'preset requires a non-empty id')
    if (this.presetService() === undefined) throw codedError('CAPABILITY_UNAVAILABLE', 'the runtime mounted no agent-preset roster')
    if (this.live === undefined) {
      const pending = this.pending
      if (pending === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
      const staged = await this.resolvePresetId(id)
      if (this.pending !== pending || this.live !== undefined) {
        throw codedError('STALE_SESSION', 'the Agent attachment changed during preset selection')
      }
      pending.preset = staged
      return this.pendingInfo()
    }
    const live = this.live
    if (!this.isBlankSession()) return { id, current: this.currentPreset() ?? null, locked: true }
    const presets = this.presetService()
    const resolvedId = await this.resolvePresetId(id)
    if (this.live !== live) throw codedError('STALE_SESSION', 'the Agent attachment changed during preset selection')
    try {
      await withTimeout(Promise.resolve(presets?.select?.(live.agent, resolvedId)), 15_000, 'agent preset selection')
    } catch (error) {
      if (record(error)?.code === 'agent-preset/locked') {
        return { id: resolvedId, current: this.currentPreset() ?? null, locked: true }
      }
      throw codedError('RUNTIME_REQUEST_FAILED', errorMessage(error))
    }
    if (this.live !== live) throw codedError('STALE_SESSION', 'the Agent attachment changed during preset selection')
    this.toolPresenter = this.makeToolPresenter(live.agent)
    return await this.sessionInfo(false)
  }

  // ---------------------------------------------------------------- effort

  /**
   * Read the selected target's native reasoning metadata.
   *
   * The mounted `llm.listModels` DTO is not required to carry `reasoning`;
   * `llm.resolveModelInfo(provider, model).reasoning` is the authority. A
   * missing resolver or a failed metadata read leaves the level unknown, so the
   * target's native default applies (nothing is guessed or fabricated).
   */
  private async effortReasoningFor(row: ModelRow): Promise<ModelReasoningView | undefined> {
    const llm = this.service<LlmLike>('llm')
    if (typeof llm?.resolveModelInfo !== 'function') return undefined
    try {
      const resolved = record(await withTimeout(llm.resolveModelInfo(row.provider, row.model), 8_000, 'resolveModelInfo'))
      return reasoningView(resolved?.reasoning)
    } catch (error) {
      this.warn(`could not read native reasoning metadata for ${row.provider}/${row.model}: ${errorMessage(error)}`)
      return undefined
    }
  }

  private async effortMetadata(route: Route): Promise<Record<string, unknown>> {
    const llm = this.service<LlmLike>('llm')
    if (typeof llm?.resolveModelInfo !== 'function') {
      throw codedError('CAPABILITY_UNAVAILABLE', 'the runtime mounted no model metadata resolver')
    }
    try {
      return record(await withTimeout(llm.resolveModelInfo(route.provider, route.model), 8_000, 'resolveModelInfo')) ?? {}
    } catch (error) {
      throw codedError('MODELS_UNAVAILABLE', `model route ${route.provider}/${route.model} is unavailable: ${errorMessage(error)}`)
    }
  }

  private async listEfforts(): Promise<unknown> {
    const route = this.agentRoute()
    if (route === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'this session has no model route')
    const resolved = await this.effortMetadata(route)
    const reasoning = record(resolved.reasoning)
    const efforts = Array.isArray(reasoning?.efforts) ? reasoning.efforts : []
    const selected = route.reasoningEffort
    const effective = typeof selected === 'string' ? selected : reasoning?.defaultEffort
    return jsonSafe({
      provider: route.provider,
      model: route.model,
      ...(typeof selected === 'string' ? { reasoningEffort: selected } : {}),
      ...(typeof reasoning?.defaultEffort === 'string' ? { defaultEffort: reasoning.defaultEffort } : {}),
      ...(typeof effective === 'string' ? { effectiveEffort: effective } : {}),
      available: reasoning !== undefined && efforts.length > 0,
      efforts: efforts.flatMap((level) => {
        const item = record(level)
        if (item === undefined || typeof item.id !== 'string') return []
        return [{
          id: item.id,
          name: typeof item.name === 'string' && item.name.length > 0 ? item.name : item.id,
          ...(typeof item.description === 'string' ? { description: item.description } : {}),
        }]
      }),
    })
  }

  private requestedEffort(wanted: unknown, efforts: readonly unknown[], route: Route): string | undefined {
    if (wanted === undefined || wanted === null || wanted === '' || wanted === 'default') return undefined
    if (typeof wanted !== 'string') throw codedError('INVALID_ARGUMENT', 'effort id must be a string or null')
    const match = efforts.map(level => record(level)).find(item => item !== undefined && String(item.id) === wanted)
    if (match === undefined) {
      const available = efforts.map(level => String(record(level)?.id)).filter(id => id !== 'undefined').join(', ')
      throw codedError(
        'RUNTIME_REQUEST_FAILED',
        `unknown reasoning effort ${JSON.stringify(wanted)} for ${route.provider}/${route.model}; available: ${available || '(none)'}`,
      )
    }
    return String(match.id)
  }

  private async setEffort(args: Record<string, unknown>): Promise<unknown> {
    if (this.live === undefined) {
      const pending = this.pending
      if (pending === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
      const route = pending.route ?? this.defaultModelSelection()
      if (route === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'this session has no model route')
      const reasoning = record((await this.effortMetadata(route)).reasoning)
      if (reasoning === undefined) {
        throw codedError('RUNTIME_REQUEST_FAILED', `model route ${route.provider}/${route.model} exposes no reasoning levels`)
      }
      const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : []
      const requested = this.requestedEffort(args.id, efforts, route)
      if (this.pending !== pending || this.live !== undefined) {
        throw codedError('STALE_SESSION', 'the Agent attachment changed during effort selection')
      }
      pending.route = {
        provider: route.provider,
        model: route.model,
        ...(requested === undefined ? {} : { reasoningEffort: requested }),
      }
      const effective = requested ?? (typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : undefined)
      const saved = await this.saveDefaultSelection(pending.route)
      return {
        provider: route.provider,
        model: route.model,
        ...(requested === undefined ? {} : { reasoningEffort: requested }),
        ...(effective === undefined ? {} : { effectiveEffort: effective }),
        ...saved,
      }
    }
    const live = this.live
    const route = this.agentRoute(live.agent)
    if (route === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'this session has no model route')
    const reasoning = record((await this.effortMetadata(route)).reasoning)
    if (reasoning === undefined) {
      throw codedError('RUNTIME_REQUEST_FAILED', `model route ${route.provider}/${route.model} exposes no reasoning levels`)
    }
    const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : []
    const requested = this.requestedEffort(args.id, efforts, route)
    if (this.live !== live || !sameRoute(this.agentRoute(live.agent), route)) {
      throw codedError('STALE_SESSION', 'the model route changed during effort selection; the obsolete selection was not applied')
    }
    const next: Route = {
      provider: route.provider,
      model: route.model,
      ...(requested === undefined ? {} : { reasoningEffort: requested }),
    }
    this.applyRoute(live.agent, next)
    const effective = requested ?? (typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : undefined)
    const saved = await this.saveDefaultSelection(next)
    return {
      provider: route.provider,
      model: route.model,
      ...(requested === undefined ? {} : { reasoningEffort: requested }),
      ...(effective === undefined ? {} : { effectiveEffort: effective }),
      ...saved,
    }
  }

  // ------------------------------------------------------------ permissions

  private permissions(): unknown {
    const presets = this.service<PermissionPresetsLike>('permissionPresets')
    if (typeof presets?.catalog !== 'function' || typeof presets.current !== 'function') {
      throw codedError('CAPABILITY_UNAVAILABLE', 'the runtime mounted no permission-preset service')
    }
    const session = this.live?.agent.session
    if (session === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
    return jsonSafe({ ...(record(presets.catalog()) ?? {}), currentValue: presets.current(session) })
  }

  // ------------------------------------------------------------- sessions UI

  private async listSessions(args: Record<string, unknown>): Promise<unknown> {
    const query = this.service<SessionQueryLike>('sessionQuery')
    if (typeof query?.listSessions !== 'function') throw codedError('CAPABILITY_UNAVAILABLE', 'the runtime mounted no session query service')
    const limit = clampInteger(args.limit, 30, 1, 200)
    const records = await query.listSessions()
    const activity = await this.sessionActivity(records)
    const visible = records
      .map(item => record(item))
      .filter((item): item is Record<string, unknown> => item !== undefined && record(item.header) !== undefined)
      .filter(item => record(item.header)?.origin !== 'subagent')
      .sort((left, right) => {
        const leftHeader = record(left.header) ?? {}
        const rightHeader = record(right.header) ?? {}
        const a = activity.get(String(leftHeader.id)) ?? (left.live === true ? Number.MAX_SAFE_INTEGER : Number(leftHeader.createdAt ?? 0))
        const b = activity.get(String(rightHeader.id)) ?? (right.live === true ? Number.MAX_SAFE_INTEGER : Number(rightHeader.createdAt ?? 0))
        if (a === b) return Number(rightHeader.createdAt ?? 0) - Number(leftHeader.createdAt ?? 0)
        return b - a
      })
      .slice(0, limit)
    const titles = args.titles === false ? undefined : await this.titlesOf(query, visible.map(item => String(record(item.header)?.id)))
    return visible.map((item) => {
      const header = record(item.header) ?? {}
      const id = String(header.id)
      return {
        id,
        ...(titles === undefined ? {} : { title: titles.get(id) ?? null }),
        cwd: typeof header.cwd === 'string' ? header.cwd : '',
        createdAt: header.createdAt,
        ...(activity.has(id) ? { activityAt: activity.get(id) } : {}),
        live: item.live === true,
      }
    })
  }

  private async sessionActivity(records: readonly unknown[]): Promise<Map<string, number>> {
    const persistence = this.service<SessionPersistenceLike>('sessionPersistence')
    if (typeof persistence?.list !== 'function') return new Map()
    let snapshots: readonly unknown[]
    try {
      snapshots = await persistence.list()
    } catch {
      return new Map()
    }
    const paths = new Map<string, string>()
    for (const snapshot of snapshots) {
      const item = record(snapshot)
      const header = record(item?.header)
      const location = record(item?.location)
      if (typeof header?.id === 'string' && location?.kind === 'jsonl' && typeof location.path === 'string') {
        paths.set(header.id, location.path)
      }
    }
    const activity = new Map<string, number>()
    for (const recordValue of records) {
      const header = record(recordValue)?.header
      const id = record(header)?.id
      if (typeof id !== 'string') continue
      const path = paths.get(id)
      if (path === undefined) continue
      try {
        const identity = await stat(path)
        if (typeof identity.mtimeMs === 'number' && Number.isFinite(identity.mtimeMs)) activity.set(id, identity.mtimeMs)
      } catch {
        /* vanished artifacts keep the creation-order fallback */
      }
    }
    return activity
  }

  private titleMapOf(observations: unknown): Map<string, string> {
    const titles = new Map<string, string>()
    for (const observation of Array.isArray(observations) ? observations : []) {
      const item = record(observation)
      if (item?.status !== 'fulfilled') continue
      const value = record(item.value)
      const title = record(value?.title)?.title
      if (typeof item.sessionId === 'string' && typeof title === 'string' && title.length > 0) titles.set(item.sessionId, title)
    }
    return titles
  }

  private async titlesOf(query: SessionQueryLike, ids: readonly string[]): Promise<Map<string, string>> {
    if (typeof query.readTitleSnapshots !== 'function') return new Map()
    try {
      return this.titleMapOf(await query.readTitleSnapshots(ids))
    } catch {
      return new Map()
    }
  }

  private async listTitles(args: Record<string, unknown>): Promise<unknown> {
    const requested = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
    const ids = [...new Set(requested)].slice(0, MAX_TITLE_IDS)
    if (ids.length === 0) return []
    const query = this.service<SessionQueryLike>('sessionQuery')
    if (query === undefined) throw codedError('CAPABILITY_UNAVAILABLE', 'the runtime mounted no session query service')
    const titles = await this.titlesOf(query, ids)
    return ids.map(sessionId => ({ sessionId, title: titles.get(sessionId) ?? null }))
  }

  // ------------------------------------------------------------- subagents

  /**
   * Read one child Session durably without creating or resuming an Agent.
   *
   * Membership is validated against the current root tree (catalog or native
   * header lineage) before any read; the returned events are the unmodified
   * native durable log, so the UI's installed transcript codec assembles them
   * exactly like a root snapshot. This command never emits subagent events for
   * the child tree: the wire contract roots those at the top-level session.
   */
  private async subagentSession(params: Record<string, unknown>): Promise<SessionInfo> {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : ''
    if (sessionId === '') throw codedError('INVALID_ARGUMENT', 'subagent-session requires a non-empty sessionId')
    const root = this.live?.agent.session.id
    if (root === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
    if (sessionId === root) {
      throw codedError('INVALID_ARGUMENT', 'subagent-session reads a child session; the root session is already attached')
    }
    if (!this.subagentBridge.available()) {
      throw codedError('CAPABILITY_UNAVAILABLE', 'the runtime mounts no readable native subagent catalog')
    }
    const membership = await this.subagentBridge.membership(sessionId)
    if (membership === undefined) {
      throw codedError(
        'INVALID_ARGUMENT',
        `session ${JSON.stringify(sessionId)} is not a child in the current session's native subagent tree`,
      )
    }
    if (membership.mode === 'external') {
      throw codedError('INVALID_ARGUMENT', `external subagent ${JSON.stringify(sessionId)} has no local session transcript`)
    }
    const read = await this.subagentBridge.readSession(sessionId)
    const header = read?.header ?? await this.subagentBridge.headerOf(sessionId)
    const route = this.childRoute(sessionId, read?.values)
    const info: SessionInfo = {
      sessionId,
      cwd: header?.cwd ?? this.options.cwd,
      provider: route?.provider ?? '',
      model: route?.model ?? '',
      ...(typeof route?.reasoningEffort === 'string' ? { reasoningEffort: route.reasoningEffort } : {}),
      ...(header?.agentPreset === undefined ? {} : { preset: header.agentPreset }),
      capabilities: this.capabilities(),
    }
    if (read === undefined) {
      info.snapshotUnavailable = true
    } else {
      const childAgent = this.liveAgentOf(sessionId)
      const presenter = childAgent === undefined ? undefined : this.childPresenter(sessionId, childAgent)
      const snapshot = this.durableSnapshot(read.events, presenter)
      info.events = snapshot.events
      info.truncated = snapshot.truncated
      info.totalEvents = snapshot.totalEvents
    }
    const subagents = await this.subagentBridge.snapshotAt(sessionId, read === undefined
      ? undefined
      : { events: read.events, inheritedEventCount: read.inheritedEventCount })
    if (subagents !== undefined) info.subagents = subagents
    return info
  }

  /** Route one child's native LLM route from the live Agent or the durable projection. */
  private childRoute(sessionId: string, values: Record<string, unknown> | undefined): Route | undefined {
    const agent = this.liveAgentOf(sessionId)
    if (agent !== undefined && typeof agent.model?.current === 'function') {
      try {
        const current = routeOf(agent.model.current())
        if (current !== undefined) return current
      } catch {
        /* fall through to the durable selection */
      }
    }
    const selection = record(values?.modelSelection)
    return routeOf(selection?.lastUsed) ?? routeOf(selection?.next)
  }

  /**
   * Follow or unfollow one child's own frames. Only followed children emit
   * `session_event` and stream frames, always under their own session id, so
   * the App can maintain a separate store without mixing parent/child data.
   * Follow state is process-local and clears on root switch and close.
   *
   * `follow:true` proves membership exactly like `subagent-session` and then
   * fails closed for a native external (non-local) leaf: it owns no local
   * Session, so admitting a follow would forward nothing and promise a child
   * transcript that cannot exist. `follow:false` stays unconditional teardown
   * so a released surface can always clear its state.
   */
  private async subagentFollow(params: Record<string, unknown>): Promise<{ sessionId: string; follow: boolean }> {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : ''
    if (sessionId === '') throw codedError('INVALID_ARGUMENT', 'subagent-follow requires a non-empty sessionId')
    if (typeof params.follow !== 'boolean') throw codedError('INVALID_ARGUMENT', 'subagent-follow requires a boolean follow')
    if (!this.subagentBridge.available()) {
      throw codedError('CAPABILITY_UNAVAILABLE', 'the runtime mounts no readable native subagent catalog')
    }
    if (params.follow) {
      const membership = await this.subagentBridge.membership(sessionId)
      if (membership === undefined) {
        throw codedError(
          'INVALID_ARGUMENT',
          `session ${JSON.stringify(sessionId)} is not a child in the current session's native subagent tree`,
        )
      }
      if (membership.mode === 'external' || membership.local === false) {
        throw codedError('INVALID_ARGUMENT', `external subagent ${JSON.stringify(sessionId)} has no local session to follow`)
      }
      this.subagentBridge.follow(sessionId)
    } else {
      this.subagentBridge.unfollow(sessionId)
    }
    return { sessionId, follow: params.follow }
  }

  /**
   * Interrupt one child's current execution under its exact durable direct
   * parent.
   *
   * Membership is proven against the *current root* tree and the authority is
   * the direct parent the bridge resolved — for a nested child that is its own
   * parent session, never the root. The native call is the public
   * `ctx.subagents.interrupt(target, {kind:'user', parentSessionId})`
   * fire-and-return primitive, so both one-shot and continuable children use
   * the same path; `interruptByParent` is deliberately not used because it
   * only addresses continuable children.
   *
   * `accepted` means the native cancel signal was admitted: the target may be
   * idle (a native no-op) or may keep running until it observes the signal.
   * This adapter never cancels the root, drains/disposes the child, emits a
   * fabricated `stopped` row or waits for quiescence.
   *
   * @param params - `{sessionId}` of a child in the current root tree.
   * @returns `{sessionId, parentSessionId, accepted:true}` (admission only).
   */
  private async subagentInterrupt(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : ''
    if (sessionId === '') throw codedError('INVALID_ARGUMENT', 'subagent-interrupt requires a non-empty sessionId')
    const root = this.live?.agent.session.id
    if (root === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
    if (sessionId === root) {
      throw codedError('INVALID_ARGUMENT', 'subagent-interrupt targets a child session; the root session is not a subagent')
    }
    if (!this.subagentBridge.available()) {
      throw codedError('CAPABILITY_UNAVAILABLE', 'the runtime mounts no readable native subagent catalog')
    }
    const subagents = this.service<SubagentsLike>('subagents')
    if (typeof subagents?.interrupt !== 'function') {
      throw codedError('CAPABILITY_UNAVAILABLE', 'this runtime mounts no native subagent interrupt (ctx.subagents.interrupt)')
    }
    const membership = await this.subagentBridge.membership(sessionId)
    if (membership === undefined) {
      throw codedError(
        'INVALID_ARGUMENT',
        `session ${JSON.stringify(sessionId)} is not a child in the current session's native subagent tree`,
      )
    }
    if (this.closed) throw codedError('CLOSED', 'the backend closed before the subagent interrupt was submitted')
    if (this.live?.agent.session.id !== root) {
      throw codedError('STALE_SESSION', 'the DSH session changed while resolving the subagent; nothing was interrupted')
    }
    try {
      subagents.interrupt(sessionId, { kind: 'user', parentSessionId: membership.parentSessionId })
    } catch (error) {
      throw nativeAgentFailure(`the native subagent interrupt for ${JSON.stringify(sessionId)} was refused`, error)
    }
    return { sessionId, parentSessionId: membership.parentSessionId, accepted: true }
  }

  /**
   * Deliver one human message to a local continuable child through its exact
   * durable direct parent.
   *
   * Only the native `ctx.subagents.prompt` call admits the message; this
   * adapter validates membership/mode, normalizes the public prompt content
   * and forwards the caller-minted request identity. Image parts are admitted
   * by DSH itself, so no attachment/model capability rule is duplicated here.
   * The returned `messageId` only proves inbox acceptance; later execution is
   * independent of this call and no optimistic transcript/status is written.
   * A caller-supplied `requestId` is used verbatim (one identity per command
   * invocation, no automatic retry).
   *
   * @param params - `{sessionId, delivery?, text?|content?, requestId?}`.
   * @returns native `{messageId}` plus the addressed session facts.
   */
  private async subagentPrompt(params: Record<string, unknown>): Promise<unknown> {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId.trim() : ''
    if (sessionId === '') throw codedError('INVALID_ARGUMENT', 'subagent-prompt requires a non-empty sessionId')
    const root = this.live?.agent.session.id
    if (root === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
    if (sessionId === root) {
      throw codedError('INVALID_ARGUMENT', 'subagent-prompt targets a child session; the root session is not a subagent')
    }
    const delivery = params.delivery === undefined ? 'queue' : params.delivery
    if (delivery !== 'queue' && delivery !== 'steer') {
      throw codedError('INVALID_ARGUMENT', 'subagent-prompt delivery must be "queue" or "steer"')
    }
    const text = params.text
    const contentValue = params.content
    let content: PromptContentPart[]
    if (text !== undefined) {
      if (contentValue !== undefined) {
        throw codedError('INVALID_ARGUMENT', 'subagent-prompt accepts either text or content, not both')
      }
      if (typeof text !== 'string' || text.trim().length === 0) {
        throw codedError('INVALID_ARGUMENT', 'subagent-prompt text must be a non-empty string')
      }
      content = [{ type: 'text', text }]
    } else {
      if (contentValue === undefined) {
        throw codedError('INVALID_ARGUMENT', 'subagent-prompt requires text or content')
      }
      content = normalizePromptContent(contentValue as readonly PromptContentPart[], 'subagent-prompt')
      if (!content.some(part => part.type === 'image' || part.text.trim().length > 0)) {
        throw codedError('INVALID_ARGUMENT', 'subagent-prompt content requires non-whitespace text or an image')
      }
    }
    const requestIdValue = params.requestId
    if (requestIdValue !== undefined && (typeof requestIdValue !== 'string' || requestIdValue.length === 0)) {
      throw codedError('INVALID_ARGUMENT', 'subagent-prompt requestId must be a non-empty string when present')
    }
    const requestId = requestIdValue ?? randomUUID()
    if (!this.subagentBridge.available()) {
      throw codedError('CAPABILITY_UNAVAILABLE', 'the runtime mounts no readable native subagent catalog')
    }
    const subagents = this.service<SubagentsLike>('subagents')
    if (typeof subagents?.prompt !== 'function') {
      throw codedError('CAPABILITY_UNAVAILABLE', 'this runtime mounts no native continuable subagent prompt (ctx.subagents.prompt)')
    }
    const membership = await this.subagentBridge.membership(sessionId)
    if (membership === undefined) {
      throw codedError(
        'INVALID_ARGUMENT',
        `session ${JSON.stringify(sessionId)} is not a child in the current session's native subagent tree`,
      )
    }
    if (membership.mode !== 'continuable' || membership.local !== true) {
      throw codedError(
        'INVALID_ARGUMENT',
        `subagent ${JSON.stringify(sessionId)} is not a local continuable child (mode: ${membership.mode}); prompt delivery is unavailable`,
      )
    }
    if (this.closed) throw codedError('CLOSED', 'the backend closed before the subagent prompt was submitted')
    if (this.live?.agent.session.id !== root) {
      throw codedError('STALE_SESSION', 'the DSH session changed while resolving the subagent; the prompt was not sent')
    }
    // The native call owns its AbortSignal until inbox acceptance. Registering
    // it in the existing active-command table is what lets `cancel()`,
    // `/reload` idleness checks and `close()` observe exactly this call.
    const commandId = randomUUID()
    const controller = new AbortController()
    let settle: () => void = () => {}
    const settled = new Promise<void>(resolve => { settle = resolve })
    this.activeCommands.set(commandId, { requestId: commandId, controller, sessionId: root, settled, settle })
    try {
      if (controller.signal.aborted) throw codedError('ABORTED', 'the subagent prompt was cancelled')
      let receipt: Record<string, unknown> | undefined
      try {
        receipt = record(await subagents.prompt({
          requestId,
          parentSessionId: membership.parentSessionId,
          childSessionId: sessionId,
          mode: 'continuable',
          delivery,
          content,
        }, controller.signal))
      } catch (error) {
        if (controller.signal.aborted) throw codedError('ABORTED', 'the subagent prompt was cancelled')
        throw nativeAgentFailure(`the native subagent prompt for ${JSON.stringify(sessionId)} was refused`, error)
      }
      // A resolved native call proves inbox acceptance; a carrier abort that
      // lands afterwards cannot un-accept the message, so the receipt stands.
      const messageId = receipt?.messageId
      if (typeof messageId !== 'string' || messageId.length === 0) {
        throw codedError(
          'RUNTIME_REQUEST_FAILED',
          `the native subagent prompt for ${JSON.stringify(sessionId)} returned no accepted message id`,
        )
      }
      return { messageId, sessionId, parentSessionId: membership.parentSessionId, delivery, requestId }
    } finally {
      this.activeCommands.delete(commandId)
      settle()
    }
  }

  // ------------------------------------------------------------- auto-title

  private titleProviderEntries(): LoaderEntryLike[] {
    const loader = this.service<LoaderLike>('loader')
    if (typeof loader?.entries !== 'function') return []
    const entries: LoaderEntryLike[] = []
    try {
      for (const entry of loader.entries()) {
        if (TITLE_PROVIDER_NAMES.includes(entry?.options?.name ?? '')) entries.push(entry)
      }
    } catch {
      return []
    }
    return entries
  }

  private autoTitleState(entries = this.titleProviderEntries()): Record<string, unknown> {
    const service = this.service<SessionTitleLike>('sessionTitle')
    const plugins = entries.map((entry) => {
      const id = String(entry.options?.id)
      // The baseline is the first native state this adapter observed: the host
      // composition is the original, so no scratch-profile comparison exists.
      if (!this.titleBaselines.has(id)) this.titleBaselines.set(id, entry.disabled === true)
      return {
        id,
        name: String(entry.options?.name),
        enabled: entry.disabled !== true,
        inheritedEnabled: this.titleBaselines.get(id) !== true,
      }
    })
    const effectiveEnabled = plugins.some(plugin => plugin.enabled)
    const mode = this.titleOverride === true ? 'enabled' : this.titleOverride === false ? 'disabled' : 'inherit'
    const inheritedEnabled = plugins.some(plugin => plugin.inheritedEnabled)
    const enabled = mode === 'inherit' ? inheritedEnabled : effectiveEnabled
    const available = service !== undefined && typeof service.refresh === 'function' && plugins.length > 0
    const drift = mode === 'inherit' && inheritedEnabled !== effectiveEnabled
    return {
      available,
      enabled,
      effectiveEnabled,
      mode,
      inherited: this.titleOverride === undefined,
      inheritedEnabled,
      mayIssueModelRequests: effectiveEnabled,
      plugins,
      ...(available ? {} : {
        limitation: plugins.length === 0
          ? 'The selected DSH composition declares no native session-title provider.'
          : 'The runtime mounted no native session-title service.',
      }),
      ...(drift ? {
        limitation: 'The live Loader state differs from the observed native baseline; restart dsh-tui after updating the composition to inherit it exactly.',
      } : {}),
    }
  }

  private async updateTitleEntry(entry: LoaderEntryLike, disabled: boolean): Promise<void> {
    if (typeof entry.update !== 'function') throw codedError('CAPABILITY_UNAVAILABLE', 'the native loader entry cannot be updated')
    try {
      await entry.update({ disabled })
    } catch (error) {
      throw codedError(
        'RUNTIME_REQUEST_FAILED',
        `DSH could not ${disabled ? 'disable' : 'enable'} the native session-title plugin ${String(entry.options?.id)}: ${errorMessage(error)}`,
      )
    }
  }

  private async autoTitle(args: Record<string, unknown>): Promise<unknown> {
    const hasWanted = Object.prototype.hasOwnProperty.call(args, 'enabled')
    const entries = this.titleProviderEntries()
    if (!hasWanted) return this.autoTitleState(entries)
    const service = this.service<SessionTitleLike>('sessionTitle')
    if (service === undefined || typeof service.refresh !== 'function' || entries.length === 0) {
      throw codedError('CAPABILITY_UNAVAILABLE', 'this DSH composition exposes no native session-title provider to toggle')
    }
    const wanted = args.enabled
    if (wanted !== null && wanted !== undefined && typeof wanted !== 'boolean') {
      throw codedError('INVALID_ARGUMENT', 'auto-title enabled must be true, false or null')
    }
    let changed = false
    if (wanted === null || wanted === undefined) {
      for (const entry of entries) {
        const id = String(entry.options?.id)
        const baselineDisabled = this.titleBaselines.get(id)
        if (baselineDisabled === undefined) continue
        if ((entry.disabled === true) !== baselineDisabled) {
          await this.updateTitleEntry(entry, baselineDisabled)
          changed = true
        }
      }
      this.titleOverride = undefined
    } else if (wanted === false) {
      for (const entry of entries) {
        if (entry.disabled === true) continue
        await this.updateTitleEntry(entry, true)
        changed = true
      }
      this.titleOverride = false
    } else {
      const active = entries.filter(entry => entry.disabled !== true)
      if (active.length === 0) {
        const primary = entries.find(entry => entry.options?.id === 'session-title-llm') ?? entries[0]
        if (primary !== undefined) {
          await this.updateTitleEntry(primary, false)
          changed = true
        }
      }
      this.titleOverride = true
    }
    const after = this.autoTitleState(this.titleProviderEntries())
    return {
      ...after,
      changed,
      restartRequired: false,
      ...(wanted === true && after.effectiveEnabled === false
        ? { limitation: after.limitation ?? 'The native title provider did not start; inspect DSH plugin diagnostics.' }
        : {}),
      ...(this.titleOverride === undefined
        ? { note: 'Inherited from the native DSH composition observed at startup.' }
        : { note: 'Runtime override; the Settings value can be reapplied on the next launch.' }),
    }
  }

  // ------------------------------------------------------------------ state

  private recallableInboxCount(agent: AgentLike): number {
    let count = 0
    for (const messages of [agent.inbox.nextTurn, agent.inbox.nextStep]) {
      for (const message of messages) if (isRecallableMessage(message)) count += 1
    }
    return count
  }

  private async state(): Promise<unknown> {
    if (this.live === undefined) return this.pendingState()
    const agent = this.live.agent
    const session = agent.session
    const route = this.agentRoute(agent)
    const permissions = this.permissionsOf(session)
    const preset = this.currentPreset()
    const usage = this.usageOf(session)
    const stats = this.statsOfSession(session)
    return {
      sessionId: session.id,
      cwd: this.options.cwd,
      provider: route?.provider ?? agent.options?.provider ?? '',
      model: route?.model ?? agent.options?.model ?? '',
      ...(typeof route?.reasoningEffort === 'string' ? { reasoningEffort: route.reasoningEffort } : {}),
      ...(preset === undefined ? {} : { preset }),
      ...(permissions === undefined ? {} : { permissions }),
      status: agent.status,
      pending: {
        nextTurn: agent.inbox.nextTurn.length,
        nextStep: agent.inbox.nextStep.length,
      },
      queued: this.recallableInboxCount(agent),
      queue: this.queueEntries(agent),
      usage: usage ?? null,
      ...(stats === undefined ? {} : { stats }),
    }
  }

  private queueEntries(agent: AgentLike): QueueEntry[] {
    const entries: QueueEntry[] = []
    const lanes: Array<[QueueEntry['target'], readonly UserMessageLike[]]> = [
      ['next-turn', agent.inbox.nextTurn],
      ['next-step', agent.inbox.nextStep],
    ]
    for (const [target, messages] of lanes) {
      for (const message of messages) {
        const raw = message as unknown as Record<string, unknown>
        const content = recallableContent(raw)
        if (content === undefined) continue
        entries.push({
          messageId: message.id,
          text: messageText(raw),
          target,
          images: content.filter(part => part.type === 'image').length,
        })
      }
    }
    return entries
  }

  private findRecallable(agent: AgentLike, messageId: string): UserMessageLike {
    for (const message of [...agent.inbox.nextTurn, ...agent.inbox.nextStep]) {
      if (message.id !== messageId) continue
      if (!isRecallableMessage(message)) break
      return message
    }
    throw codedError('INVALID_ARGUMENT', 'queued message is gone')
  }

  private queueRemove(params: Record<string, unknown>): { removed: boolean } {
    const agent = this.live?.agent
    if (agent === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
    const messageId = typeof params.messageId === 'string' ? params.messageId : ''
    if (messageId === '') throw codedError('INVALID_ARGUMENT', 'queue-remove requires messageId')
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep]
      .find(message => message.id === messageId)
    // Already claimed or never queued: the row just leaves. No error notice.
    if (pending === undefined || !isRecallableMessage(pending)) return { removed: false }
    agent.inbox.remove(messageId)
    return { removed: true }
  }

  private async queueReplace(params: Record<string, unknown>): Promise<{ messageId: string }> {
    await this.ensureNative()
    const agent = this.live?.agent
    if (agent === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
    const messageId = typeof params.messageId === 'string' ? params.messageId : ''
    const text = typeof params.text === 'string' ? params.text : ''
    if (messageId === '') throw codedError('INVALID_ARGUMENT', 'queue-replace requires messageId')
    const existing = this.findRecallable(agent, messageId)
    const raw = existing as unknown as Record<string, unknown>
    const kept = (recallableContent(raw) ?? []).filter(part => part.type === 'image')
    if (text.trim() === '' && kept.length === 0) {
      throw codedError('INVALID_ARGUMENT', 'queue-replace requires text or an existing image')
    }
    const content: unknown[] = []
    if (text.trim() !== '') content.push({ type: 'text', text })
    for (const part of kept) content.push({ type: 'image', attachment: part.attachment })
    const replacement = this.asUserMessage(this.userMessageFromContent(content))
    if (!agent.inbox.replace(messageId, replacement)) throw codedError('INVALID_ARGUMENT', 'queued message is gone')
    return { messageId: replacement.id }
  }

  /**
   * Put one human message at the front of `next-turn` and wake the driver.
   * `followup` is the public wake. Other recallable `next-turn` rows are
   * lifted out and appended behind it, so a running turn is cancelled with
   * the inbox kept and the rest still run later, one turn at a time.
   */
  private async queueSendNow(params: Record<string, unknown>): Promise<{ messageId: string }> {
    await this.ensureNative()
    const agent = this.live?.agent
    if (agent === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
    const messageId = typeof params.messageId === 'string' ? params.messageId : undefined
    const text = typeof params.text === 'string' ? params.text : undefined
    const content = Array.isArray(params.content) ? params.content : undefined
    let message: UserMessageLike
    if (content !== undefined) {
      if (messageId !== undefined) this.dropRecallable(agent, messageId)
      message = await this.admitUserMessage(normalizePromptContent(content as readonly PromptContentPart[]))
    } else if (text !== undefined) {
      if (text.trim() === '') throw codedError('INVALID_ARGUMENT', 'queue-send-now requires non-empty text')
      if (messageId !== undefined) this.dropRecallable(agent, messageId)
      message = this.asUserMessage(this.userMessage(text))
    } else if (messageId !== undefined) {
      message = this.findRecallable(agent, messageId)
    } else {
      throw codedError('INVALID_ARGUMENT', 'queue-send-now requires text, content, or messageId')
    }
    this.promote(agent, message)
    return { messageId: message.id }
  }

  private dropRecallable(agent: AgentLike, messageId: string): void {
    this.findRecallable(agent, messageId)
    agent.inbox.remove(messageId)
  }

  private promote(agent: AgentLike, message: UserMessageLike): void {
    const saved: UserMessageLike[] = []
    for (const item of [...agent.inbox.nextTurn]) {
      if (item.id === message.id || !isRecallableMessage(item)) continue
      if (agent.inbox.remove(item.id)) saved.push(item)
    }
    if (agent.inbox.nextTurn.some(item => item.id === message.id) || agent.inbox.nextStep.some(item => item.id === message.id)) {
      agent.inbox.remove(message.id)
    }
    if (agent.status === 'running') agent.cancel({ kind: 'user' }, { keepInbox: true })
    agent.followup(message)
    const index = agent.inbox.nextTurn.findIndex(item => item.id === message.id)
    if (index > 0) {
      agent.inbox.remove(message.id)
      agent.inbox.prepend('next-turn', message)
    }
    for (const item of saved) agent.inbox.append('next-turn', item)
  }

  private userMessageFromContent(content: readonly unknown[]): unknown {
    const native = this.native
    if (native === undefined) {
      throw codedError('CAPABILITY_UNAVAILABLE', 'cannot create a native user message: the DSH llm helpers are unavailable')
    }
    return native.createUserMessage({ content, source: { kind: 'user' } })
  }

  private asUserMessage(value: unknown): UserMessageLike {
    const message = record(value)
    if (message === undefined || typeof message.id !== 'string') {
      throw codedError('RUNTIME_REQUEST_FAILED', 'native user message has no id')
    }
    return message as unknown as UserMessageLike
  }

  private async admitUserMessage(parts: readonly PromptContentPart[]): Promise<UserMessageLike> {
    if (!parts.some(part => part.type === 'image' || part.text.trim().length > 0)) {
      throw codedError('INVALID_ARGUMENT', 'queue-send-now requires non-whitespace text or an image')
    }
    if (!parts.some(part => part.type === 'image')) {
      return this.asUserMessage(this.userMessage(parts.map(part => part.type === 'text' ? part.text : '').join('\n')))
    }
    const attachments = this.service<AttachmentsLike>('attachments')
    if (typeof attachments?.admitPromptContent !== 'function') {
      throw codedError(
        'CAPABILITY_UNAVAILABLE',
        'this runtime mounts no native attachment admission (ctx.attachments.admitPromptContent); the prompt was not sent',
      )
    }
    const live = this.live
    if (live === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
    let admitted: readonly unknown[]
    try {
      admitted = await attachments.admitPromptContent(parts)
    } catch (error) {
      throw codedError('RUNTIME_REQUEST_FAILED', `the native attachment store refused the prompt: ${errorMessage(error)}`)
    }
    if (this.live !== live) throw codedError('STALE_SESSION', 'the DSH Agent attachment changed during prompt admission; the prompt was not sent')
    await this.ensureNative()
    return this.asUserMessage(this.userMessageFromContent(admitted))
  }

  private dequeue(): unknown[] {
    const agent = this.live?.agent
    if (agent === undefined) return []
    const removed: unknown[] = []
    const lists: Array<[string, readonly UserMessageLike[]]> = [
      ['next-turn', agent.inbox.nextTurn],
      ['next-step', agent.inbox.nextStep],
    ]
    for (const [target, messages] of lists) {
      for (const message of [...messages]) {
        const raw = message as unknown as Record<string, unknown>
        const content = recallableContent(raw)
        if (content === undefined) continue
        if (agent.inbox.remove(message.id)) {
          removed.push({ text: messageText(raw), content, target, messageId: message.id })
        }
      }
    }
    return removed
  }

  // ----------------------------------------------------------------- reload

  private assertReloadIdle(): void {
    const live = this.live
    if (live === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
    if (live.agent.status === 'running' ||
        this.activeCommands.size > 0 ||
        this.pendingDecisions.size > 0 ||
        live.agent.inbox.nextTurn.length > 0 ||
        live.agent.inbox.nextStep.some(message => record(message.source)?.kind !== 'user-approval')) {
      throw codedError(
        'RUNTIME_REQUEST_FAILED',
        'wait for the current turn, queued input or native command to finish before reloading',
      )
    }
  }

  /**
   * Single-step native reload. `reconcileProfile` must run inside
   * `runExclusive` (its own contract); there is no nested acquisition. This
   * adapter never awaits a pending reload from `close()`, so recomposition
   * unloading this plugin cannot deadlock on its own disposal.
   */
  private async reloadRuntime(): Promise<unknown> {
    if (this.reloading !== undefined) {
      throw codedError('RUNTIME_REQUEST_FAILED', 'another reload is already in progress')
    }
    this.assertReloadIdle()
    const hmr = this.service<HmrLike>('hmr')
    if (typeof hmr?.runExclusive !== 'function' || typeof hmr.reconcileProfile !== 'function') {
      return { available: false, warnings: ['The runtime mounted no profile HMR service; restart dsh-tui to apply configuration changes.'], pending: [] }
    }
    const task = (async () => {
      try {
        const result = jsonSafe(await withTimeout(
          hmr.runExclusive!(() => hmr.reconcileProfile!()),
          RELOAD_TIMEOUT_MS,
          'native HMR reconciliation',
        ))
        // Recomposition can replace the projection registrations this bridge
        // reads; drop cached rows and re-resolve services on the next read.
        this.subagentBridge.invalidate()
        const info = this.live === undefined ? undefined : await this.sessionInfo(false)
        // `/reload` does not emit `ready`; re-announce so subsequent child
        // changes are published against the refreshed attachment again.
        if (info !== undefined) this.subagentBridge.announce(info.sessionId, info.subagents)
        return {
          ...(record(result) ?? {}),
          available: true,
          info,
        }
      } finally {
        this.reloading = undefined
      }
    })()
    this.reloading = task
    return await task
  }

  // ------------------------------------------------------------------ close

  async close(): Promise<void> {
    if (this.closed) {
      if (!this.closedEmitted) this.emit({ type: 'closed', code: 0, signal: null })
      return
    }
    this.closed = true
    this.subagentBridge.close()
    this.childPresenters.clear()
    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* listener disposal is best effort */
      }
    }
    const aborted = this.abortActiveCommands('backend closed')
    if (aborted > 0) await this.drainCommands(COMMAND_DRAIN_TIMEOUT_MS)
    for (const controller of this.activeImageReads.values()) {
      if (!controller.signal.aborted) controller.abort()
    }
    this.activeImageReads.clear()
    this.compactionCauses.clear()
    await this.switching
    this.pending = undefined
    const current = this.live
    if (current !== undefined) {
      this.live = undefined
      this.toolPresenter = undefined
      await this.closeAgent(current, 'backend closed')
    }
    // Note: no `appExit`, no root disposal, no process exit. The parent plugin
    // owns application shutdown; an in-flight HMR reload is intentionally not
    // awaited because recomposition may be unloading this very plugin.
    this.native = undefined
    this.codec = undefined
    if (!this.closedEmitted) this.emit({ type: 'closed', code: 0, signal: null })
  }
}

// -------------------------------------------------------------------- helpers

/** Prevent a reused command id from correlating across native sessions. */
function compactionCauseKey(sessionId: string, commandId: string): string {
  return `${sessionId}\0${commandId}`
}

/**
 * Normalize native free-form failure text into one bounded display line.
 *
 * Credentials are redacted through {@link redactDiagnostic}; terminal escapes
 * and C0/C1 controls are then removed, whitespace is collapsed and the result
 * is capped.
 *
 * @param text - native `compaction/end` error text.
 * @returns a safe single-line detail, or undefined when nothing survives.
 */
function oneLineDiagnostic(text: string): string | undefined {
  const stripped = redactDiagnostic(text)
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[P^_][\s\S]*?\u001b\\/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u009b[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (stripped.length === 0) return undefined
  return stripped.length > MAX_NATIVE_CAUSE_CHARS
    ? `${stripped.slice(0, MAX_NATIVE_CAUSE_CHARS - 3)}...`
    : stripped
}

function normalizePromptContent(value: readonly PromptContentPart[], label = 'sendContent'): PromptContentPart[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw backendError('INVALID_ARGUMENT', `${label} requires a non-empty ordered content list`)
  }
  const parts: PromptContentPart[] = []
  for (const entry of value) {
    const part = record(entry)
    if (part?.type === 'text') {
      if (typeof part.text !== 'string') throw backendError('INVALID_ARGUMENT', 'prompt text parts require a text string')
      parts.push({ type: 'text', text: part.text })
      continue
    }
    if (part?.type === 'image') {
      if (!isImageMediaType(part.mediaType)) throw backendError('INVALID_ARGUMENT', 'prompt image parts require a supported mediaType')
      const data = part.data
      if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
        throw backendError('INVALID_ARGUMENT', 'prompt image parts require canonical base64 data')
      }
      if (part.name !== undefined && typeof part.name !== 'string') {
        throw backendError('INVALID_ARGUMENT', 'prompt image part name must be a string when present')
      }
      parts.push({
        type: 'image',
        mediaType: part.mediaType,
        data,
        ...(part.name === undefined ? {} : { name: part.name }),
      })
      continue
    }
    throw backendError('INVALID_ARGUMENT', `unsupported prompt content part: ${JSON.stringify(part?.type)}`)
  }
  return parts
}

function unknownModelMessage(args: Record<string, unknown>): string {
  const wanted = typeof args.id === 'string'
    ? args.id
    : `${typeof args.provider === 'string' ? args.provider : '?'}/${typeof args.model === 'string' ? args.model : '?'}`
  return `unknown model: ${wanted}`
}

function wireBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value))
  } catch {
    return 0
  }
}

function sessionEventWire(event: unknown, presentation: JsonRecord | undefined): SessionEvent {
  const raw = record(jsonSafe(event)) ?? {}
  return {
    type: typeof raw.type === 'string' ? raw.type : 'unknown',
    seq: typeof raw.seq === 'number' ? raw.seq : 0,
    ...(typeof raw.time === 'number' ? { time: raw.time } : {}),
    data: raw.data,
    ...(raw.surfaceOp === 'append' ? { surfaceOp: 'append' as const } : {}),
    ...(record(raw.surfaceOp)?.op === 'replace'
      ? {
          surfaceOp: {
            op: 'replace' as const,
            startSeq: Number(record(raw.surfaceOp)?.startSeq),
            endSeq: Number(record(raw.surfaceOp)?.endSeq),
          },
        }
      : {}),
    ...(Array.isArray(raw.sourceEventSeqs)
      ? { sourceEventSeqs: raw.sourceEventSeqs.filter((seq): seq is number => typeof seq === 'number') }
      : {}),
    ...(presentation === undefined ? {} : { toolPresentation: presentation }),
  }
}

/** Create the in-process backend for one host Cordis context. */
export function createDshBackend(host: DshHostContext, options: DshContextBackendOptions): DshContextBackend {
  return new DshContextBackend(host, options)
}