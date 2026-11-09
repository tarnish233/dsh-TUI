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
import { imageAttachmentValue, sameImageAttachment, asImageAttachmentRef } from '../attachments.ts'
import { nativeInstallationAnchor, nativeResourceURL } from '../plugin/native-resources.ts'
import { backendError, backendErrorCodeOf, asBackendError, redactDiagnostic } from './errors.ts'
import type { BackendError } from './errors.ts'
import { makeTranscriptCodec } from './native-codec.ts'
import { carriedEffort, modelRow, reasoningView, selectModelRow, type ModelReasoningView, type ModelRow } from './model-view.ts'
import { SubagentBridge } from './subagents.ts'
import { NativeInspection, goalChangedInvalidation, projectionInvalidationDomain } from './native-inspection.ts'
import { NativeFileInput, normalizeCommandAttachments, normalizePromptContent as normalizeNativePromptContent, recallableParts, queueReplacementContent, commandOutcome } from './native-files.ts'
import { fileReferenceService, listFileReferenceCandidates } from './native-file-references.ts'
import { NativeQuestionAdapter, isUserQuestionProjectionKey } from './native-questions.ts'
import { NativeManagement, buildInteractiveForkInput } from './native-management.ts'
import type { InteractiveForkInputOutcome } from './native-management.ts'
import type { NativeUiAccess, NativeUiScope } from './native-ui-scope.ts'
import type {
  Backend,
  BackendEvent,
  DecisionOrigin,
  DecisionRequest,
  DisplayContentPart,
  EncodedFileInput,
  FileAttachmentRef,
  FileReferenceCandidate,
  ImageAttachmentRef,
  ImageAttachmentValue,
  InputRoute,
  JsonRecord,
  NativeUiDomain,
  PlanSnapshot,
  PromptContentPart,
  QueueEntry,
  SessionEvent,
  SessionInfo,
  SkillCatalogEntry,
  SkillCatalogSnapshot,
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
  /** Optional public helpers from the selected native installation. */
  readPluginInventory?(host: unknown): Promise<unknown>
  buildForkSeed?(events: readonly unknown[], boundary: number): readonly unknown[]
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
  readonly seq?: number
  snapshotEvents?(): readonly unknown[]
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
  /** Owning domain read of the native turn-boundary projection for one Session. */
  turnBoundaryOf?(session: SessionLike): unknown
}

interface CommandsLike {
  list?(agent?: AgentLike): readonly unknown[]
  find?(agent: AgentLike, name: string): unknown
  execute?(agent: AgentLike, line: string, attachments: readonly unknown[], signal: AbortSignal): Promise<unknown>
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

/**
 * Structural view of the public `ctx.sessionProjections` carrier read face.
 *
 * Only `snapshot(session, keys)` and the change feed are borrowed.
 * `sessionProjections.stateOf` is the registry's deprecated raw fold read: this
 * adapter never calls it, so a projection fact always arrives schema-validated
 * from one consistent public cut.
 */
interface ProjectionsLike {
  onChanged?(listener: (session: unknown, key: string, value: unknown, seq: unknown) => void): () => void
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

/**
 * Structural view of the public `ctx.planMode` controller read face.
 *
 * Only `get(agent)` is borrowed: DSH owns logged plan state, the pending
 * selection and its boundary; this adapter never selects, folds or caches plan
 * state itself.
 */
interface PlanModeLike {
  get(agent: AgentLike): unknown
}

interface AgentPresetsLike {
  list?(): Promise<readonly unknown[]>
  resolve?(id?: string): Promise<unknown>
  select?(agent: AgentLike, id: string): Promise<unknown>
  mount?(agentCtx: unknown, id?: string): Promise<unknown>
  presetForSession?(session: SessionLike): string | null
  composedPreset?(ctx: unknown): string | undefined
  /** Read the preset-isolated service instance for one exact Agent. */
  serviceFor?(agent: unknown, name: string): unknown
  /** Retain the preset revision as a scope lease without creating an Agent. */
  acquireScope?(id?: string): Promise<unknown>
  readonly defaultId?: string
}

interface HmrLike {
  runExclusive?<T>(operation: () => Promise<T>): Promise<T>
  reconcileProfile?(requiredIds?: readonly string[]): Promise<unknown>
}

interface ToolsLike {
  get?(name: string, scope?: unknown): unknown
}

/**
 * Structural view of the public `ctx.skills` registry read surface.
 *
 * Only `snapshot` is borrowed: this adapter never loads a skill body, keeps a
 * cached catalog, or owns invocation policy. The native registry has already
 * resolved `invocation` for every summary.
 */
interface SkillsLike {
  snapshot?(options: { readonly cwd?: string; readonly scope?: unknown; readonly signal?: AbortSignal }): Promise<unknown> | unknown
  list?(options: { readonly cwd?: string; readonly scope?: unknown; readonly signal?: AbortSignal }): Promise<unknown> | unknown
}

/** Structural view of the public `ctx.workingDirectory` lookup. */
interface WorkingDirectoryLike {
  ensure?(agent: unknown, signal?: AbortSignal): Promise<unknown> | unknown
}

interface LoaderEntryLike {
  readonly options?: { readonly id?: string; readonly name?: string }
  readonly disabled?: boolean
}

interface LoaderLike {
  entries?(): Iterable<LoaderEntryLike>
}

interface SessionTitleLike {
  /** Owning domain read: the folded native title snapshot, or `undefined` before any. */
  get?(session: SessionLike): unknown
  refresh?(...args: unknown[]): unknown
}

interface SessionsLike {
  flush?(session: SessionLike): Promise<unknown>
  get?(id: string): SessionLike | undefined
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
  /** Adapter-pinned route; `undefined` keeps following the live native default. */
  route: Route | undefined
  preset: string | undefined
}

/**
 * The exact native owner of one pending decision.
 *
 * A root `cancel()`/attachment retirement may only settle decisions that its
 * own Agent asked. Recording the asking Agent (identity, not just the id)
 * keeps a root interruption from closing a child Agent's approval or question
 * that the user never saw and that no root action can answer.
 */
interface DecisionOwner {
  /** The native Agent object that raised the request. */
  readonly agent: unknown
  /** That Agent's own session id (a child id, never the root id). */
  readonly sessionId: string
  /** Root session the decision was announced under (`decision`/`decision_closed`). */
  readonly eventSessionId: string
}

interface PendingDecision {
  readonly kind: 'approval' | 'question'
  readonly signal: AbortSignal | undefined
  readonly owner: DecisionOwner
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

interface ActiveSkillQuery {
  readonly controller: AbortController
  readonly sessionId: string
  readonly attachmentId: string
  /** Captured pending observation this read belongs to; undefined for a live Agent. */
  readonly pending: PendingSession | undefined
  /** Captured preset id: staging another preset on the same pending object is stale. */
  readonly preset: string | undefined
}

/** One adapter-owned, bounded durable session-query read. */
interface ActiveDurableRead {
  readonly controller: AbortController
  /** Exact attachment epoch this read belongs to; undefined for corpus reads. */
  readonly sessionId: string | undefined
}

const BASE_CAPABILITIES = ['stream', 'followup', 'steer', 'cancel', 'new', 'resume', 'state', 'dequeue']

/**
 * One command's policy facts, declared exactly once.
 *
 * The accepted-name set, the lazy-materialization gate and the documented
 * session-less list were three parallel hand-maintained lists before this
 * table; they drifted (`permissions`, `queue-remove` and `efforts` silently
 * materialized a pending Agent). Every policy read now comes from here.
 */
interface CommandDeclaration {
  readonly name: string
  /**
   * Pending-safe: answers from native services and staged attachment facts
   * only, so it must never materialize the pending Agent. Any fact that needs
   * the Agent degrades explicitly (omitted field / `removed:false` / the
   * pending route) instead of creating a durable session.
   */
  readonly sessionless?: true
  /** Stages the choice on a pending session; applies through native owners when live. */
  readonly stageable?: true
}

/**
 * The one declaration table. `docs/BACKEND.md` lists the session-less rows,
 * and `test/backend-context.test.ts` proves both the table and that list by
 * asserting `agents.createCalls` stays empty for every one of them.
 *
 * `queue-replace`/`queue-send-now` are deliberately *not* session-less: they
 * rewrite/wake a native inbox row that only a live Agent owns, and a pending
 * attachment has no queue to address. `queue-remove` is session-less because
 * "nothing is queued" is a complete answer (`removed:false`), exactly like
 * `dequeue` answering `[]`.
 */
const COMMAND_DECLARATIONS: readonly CommandDeclaration[] = [
  // Read-only/pending-safe control commands.
  { name: 'state', sessionless: true },
  { name: 'commands', sessionless: true },
  { name: 'skills', sessionless: true },
  { name: 'sessions', sessionless: true },
  { name: 'titles', sessionless: true },
  { name: 'models', sessionless: true },
  { name: 'presets', sessionless: true },
  { name: 'permissions', sessionless: true },
  { name: 'auto-title', sessionless: true },
  { name: 'efforts', sessionless: true },
  { name: 'dequeue', sessionless: true },
  { name: 'queue-remove', sessionless: true },
  { name: 'cancel', sessionless: true },
  { name: 'new', sessionless: true },
  { name: 'resume', sessionless: true },
  // Native read faces and exact-session mutations of the attached root.
  { name: 'native-jobs', sessionless: true },
  { name: 'native-job-output', sessionless: true },
  { name: 'native-goal', sessionless: true },
  { name: 'native-working-directory', sessionless: true },
  { name: 'native-inventory', sessionless: true },
  { name: 'native-tools', sessionless: true },
  { name: 'native-questions', sessionless: true },
  { name: 'native-question-answer', sessionless: true },
  { name: 'native-defaults', sessionless: true },
  { name: 'native-default-update', sessionless: true },
  { name: 'session-fork', sessionless: true },
  // Pending-staged selections; live application goes through DSH's own owners.
  { name: 'model', stageable: true },
  { name: 'preset', stageable: true },
  { name: 'effort', stageable: true },
  // Everything below needs the live Agent's own scope.
  { name: 'input-route' },
  { name: 'execute' },
  { name: 'reload' },
  { name: 'queue-replace' },
  { name: 'queue-send-now' },
  { name: 'subagent-session' },
  { name: 'subagent-follow' },
  { name: 'subagent-interrupt' },
  { name: 'subagent-prompt' },
  { name: 'session-rename' },
]
/** Every accepted backend command name, derived from the declaration table. */
const COMMAND_DECLARATIONS_BY_NAME: ReadonlyMap<string, CommandDeclaration> = new Map(
  COMMAND_DECLARATIONS.map(declaration => [declaration.name, declaration]),
)
const TITLE_PROVIDER_NAMES = [
  '@deepseek-ai/dsh-session-title-first-prompt-llm',
  '@deepseek-ai/dsh-session-title-all-prompts-llm',
]
/** Why a write request cannot be honoured without owning DSH composition. */
const AUTO_TITLE_READ_ONLY =
  'DSH owns auto-title through the profile composition; this TUI exposes no runtime-only switch and never rewrites that composition. '
  + 'Change the session-title provider enablement in the DSH profile (native plugin manager or profile patch), then reload or restart.'
const METRICS_KEYS = new Set(['contextPressure', 'tokenUsage', 'contextBreakdown', 'sessionStats'])
const STATS_FIELDS = ['turns', 'steps', 'llmMs', 'toolMs', 'ttftMs', 'ttftSteps', 'decodeMs', 'decodeTokens'] as const
const MAX_SNAPSHOT_EVENTS = 8000
const SNAPSHOT_BYTE_BUDGET = 4 * 1024 * 1024
const MAX_CACHED_TOOL_CALLS = 2048
/** Abandon uncooperative read-only SDK requests; never terminate native I/O. */
const NATIVE_UI_READ_TIMEOUT_MS = 8_000
/** Bound on one durable session-query read; same order as the subagent reads. */
const SESSION_QUERY_READ_TIMEOUT_MS = 5_000
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

/** The honest answer when no native viewing scope can be read. */
function unavailableSkills(): SkillCatalogSnapshot {
  return { entries: [], available: false, complete: false }
}

/** One native `/name` token: lower-kebab, the same grammar as DSH's skill gesture. */
function isNativeInputName(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
}

interface PresetLeaseLike {
  readonly key?: unknown
  [Symbol.asyncDispose]?: () => Promise<void>
}

/**
 * Normalize the public `agentPresets.acquireScope()` lease.
 *
 * The native contract is `{key} & AsyncDisposable`; this adapter never copies
 * the preset composition, only borrows the retained revision for one read and
 * always releases it.
 */
function normalizePresetLease(value: unknown): { readonly key: unknown; release(): Promise<void> } | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const lease = value as PresetLeaseLike
  if (lease.key === undefined) return undefined
  const dispose = lease[Symbol.asyncDispose]
  return {
    key: lease.key,
    release: async () => {
      if (typeof dispose === 'function') await dispose.call(value)
    },
  }
}

/**
 * Project one native `SkillCatalogSnapshot` into the UI metadata whitelist.
 *
 * The registry has already resolved invocation policy; this function only
 * verifies the structural shape, drops non-user-invocable entries and never
 * reads a body, path, locator or resource base. A malformed entry is skipped
 * and forces `complete:false` so the consumer never presents a partial catalog
 * as authoritative.
 *
 * @param value - the raw native snapshot value.
 * @returns the projected observation, or undefined for a malformed envelope.
 */
function skillCatalogSnapshot(value: unknown): SkillCatalogSnapshot | undefined {
  const payload = record(value)
  if (payload === undefined || !Array.isArray(payload.skills)) return undefined
  const projected = projectSkillEntries(payload.skills)
  return {
    entries: projected.entries,
    available: true,
    complete: payload.complete === true && projected.valid,
  }
}

/**
 * Project a public `ctx.skills.list()` result when the registry has no
 * `snapshot`. The native list carries no completeness flag, so the observation
 * is explicitly incomplete rather than defaulted to authoritative.
 */
function skillCatalogList(value: unknown): SkillCatalogSnapshot | undefined {
  if (!Array.isArray(value)) return undefined
  const projected = projectSkillEntries(value)
  return { entries: projected.entries, available: true, complete: false }
}

function projectSkillEntries(values: readonly unknown[]): {
  readonly entries: SkillCatalogEntry[]
  readonly valid: boolean
} {
  const entries: SkillCatalogEntry[] = []
  let valid = true
  for (const raw of values) {
    const projected = skillCatalogEntry(raw)
    if (projected.kind === 'invalid') {
      valid = false
      continue
    }
    if (projected.kind === 'filtered') continue
    entries.push(projected.entry)
  }
  return { entries, valid }
}

type SkillEntryProjection =
  | { readonly kind: 'entry'; readonly entry: SkillCatalogEntry }
  | { readonly kind: 'filtered' }
  | { readonly kind: 'invalid' }

/**
 * Validate one native skill summary without inventing invocation policy.
 *
 * `invocation.userInvocable` decides inclusion; `invocation.modelInvocable` is
 * carried through unresolved so the UI can label a user-only skill. Any
 * non-boolean policy value or non-string routing field is invalid rather than
 * defaulted.
 */
function skillCatalogEntry(value: unknown): SkillEntryProjection {
  const item = record(value)
  if (item === undefined) return { kind: 'invalid' }
  const name = item.name
  const description = item.description
  const invocation = record(item.invocation)
  const modelInvocable = invocation?.modelInvocable
  const userInvocable = invocation?.userInvocable
  if (typeof name !== 'string' || name.length === 0 || name.trim() !== name || /[\s/]/u.test(name)) {
    return { kind: 'invalid' }
  }
  if (typeof description !== 'string') return { kind: 'invalid' }
  if (typeof modelInvocable !== 'boolean' || typeof userInvocable !== 'boolean') {
    return { kind: 'invalid' }
  }
  const whenToUse = item.whenToUse
  if (whenToUse !== undefined && typeof whenToUse !== 'string') return { kind: 'invalid' }
  if (!userInvocable) return { kind: 'filtered' }
  return {
    kind: 'entry',
    entry: {
      name,
      description,
      ...(typeof whenToUse === 'string' && whenToUse.length > 0 ? { whenToUse } : {}),
      modelInvocable,
    },
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

/**
 * Normalize one native attachment-store rejection into the adapter taxonomy.
 *
 * `ctx.attachments.readImage` is a native seam like any other: a coded refusal
 * keeps its exact code, and an uncoded failure becomes one redacted
 * `RUNTIME_REQUEST_FAILED` diagnostic. A raw native `Error` would reach the UI
 * without a code and without credential redaction.
 *
 * @param error - the rejection the native attachment store produced.
 * @returns a coded, redacted BackendError safe to surface in the UI.
 */
function imageReadFailure(error: unknown): BackendError {
  if (backendErrorCodeOf(error) !== undefined) return asBackendError(error)
  return backendError('RUNTIME_REQUEST_FAILED', `the native image read failed: ${errorMessage(error)}`)
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

/** Complete native `AgentOptions` route snapshot for one adapter-pinned choice. */
function routeOptions(route: Route): Route {
  return {
    provider: route.provider,
    model: route.model,
    ...(typeof route.reasoningEffort === 'string' ? { reasoningEffort: route.reasoningEffort } : {}),
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
  return a.active === b.active && a.pending === b.pending
}

function textOfBlock(block: unknown): string {
  const value = record(block)
  return value?.type === 'text' && typeof value.text === 'string' ? value.text : ''
}

function messageText(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : []
  return content.map(textOfBlock).filter(part => part.length > 0).join('\n')
}

/** Native ordered text/image/file references; no bytes and no injected context. */
function recallableContent(message: Record<string, unknown>): DisplayContentPart[] | undefined {
  return recallableParts(message)
}

function isRecallableMessage(message: UserMessageLike): boolean {
  return recallableContent(message as unknown as Record<string, unknown>) !== undefined
}

/** One native inbox row with the lane it belongs to. */
interface InboxRow {
  readonly target: 'next-turn' | 'next-step'
  readonly message: UserMessageLike
}

/** The two native inbox lanes of one Agent, in order. */
function inboxRowsOf(agent: AgentLike): InboxRow[] {
  return [
    ...agent.inbox.nextTurn.map(message => ({ target: 'next-turn' as const, message })),
    ...agent.inbox.nextStep.map(message => ({ target: 'next-step' as const, message })),
  ]
}

/**
 * Best-effort restoration of one captured native inbox.
 *
 * The public inbox face only offers `remove`/`prepend`/`append`, so an exact
 * sequence is restored by rebuilding each lane in its captured order. Every
 * native call is guarded individually: a failing inbox degrades the rollback
 * but must never mask the rejection the caller is already carrying.
 *
 * @param agent - exact live Agent whose inbox is restored.
 * @param rows - captured rows, in their original lane order.
 */
function restoreInbox(agent: AgentLike, rows: readonly InboxRow[]): void {
  const lanes = [
    ['next-turn', agent.inbox.nextTurn],
    ['next-step', agent.inbox.nextStep],
  ] as const
  for (const [target, lane] of lanes) {
    try {
      for (const item of [...lane]) agent.inbox.remove(item.id)
    } catch {
      /* keep restoring what can still be restored */
    }
    for (const row of rows) {
      if (row.target !== target) continue
      try {
        agent.inbox.append(target, row.message)
      } catch {
        /* best effort: a failed rollback never masks the original error */
      }
    }
  }
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
        // Native meaning: `selected` holds chosen option labels, `custom` holds
        // the free-text answer. Without declared options there is nothing to
        // select, so typed text is a custom answer, never a fabricated label
        // (an option-bearing answer that matches no label is custom too).
        if (labels.has(entry)) selected.push(entry)
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
async function loadDefaultNative(host: DshHostContext): Promise<DshNativeHelpers> {
  const anchor = nativeInstallationAnchor(host)
  const load = (specifier: string): Promise<unknown> => import(anchor === undefined ? specifier : nativeResourceURL(specifier, anchor))
  // Package names are computed so the project typechecks without those peer
  // dependencies in its own node_modules; the running bundle resolves them.
  const llmSpecifier: string = '@deepseek-ai/dsh-llm'
  const sessionSpecifier: string = '@deepseek-ai/dsh-session'
  let llm: unknown
  let session: unknown
  try {
    llm = await load(llmSpecifier)
  } catch {
    throw codedError(
      'STARTUP_FAILED',
      'the DSH llm helpers (@deepseek-ai/dsh-llm) are not resolvable from this bundle; native message creation/assembly is unavailable',
    )
  }
  try {
    session = await load(sessionSpecifier)
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
  let readPluginInventory: DshNativeHelpers['readPluginInventory']
  try {
    const inventorySpecifier: string = '@deepseek-ai/dsh-host-plugin-inventory'
    const helper = record(await load(inventorySpecifier))?.readPluginInventory
    if (typeof helper === 'function') readPluginInventory = host => Promise.resolve(helper(host))
  } catch {
    // Optional read-only capability; never install a package or another frontend.
  }
  const buildForkSeed = record(session)?.buildForkSeed
  return {
    createUserMessage: input => createUserMessage(input),
    transcriptCodec: makeTranscriptCodec(llm, session),
    ...(readPluginInventory === undefined ? {} : { readPluginInventory }),
    ...(typeof buildForkSeed === 'function' ? { buildForkSeed: (events: readonly unknown[], boundary: number): readonly unknown[] => {
      const seed: unknown = buildForkSeed(events, boundary)
      if (!Array.isArray(seed)) throw codedError('RUNTIME_REQUEST_FAILED', 'the native fork helper returned no seed')
      return seed
    } } : {}),
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
  /** In-flight bounded durable session-query reads (root snapshot/listing/titles). */
  private readonly activeDurableReads = new Map<string, ActiveDurableRead>()
  private readonly activeImageReads = new Map<string, AbortController>()
  /** In-flight skill metadata reads; metadata only, never a model turn. */
  private readonly activeSkillQueries = new Map<string, ActiveSkillQuery>()
  /** A native skills/change arrived while no live Agent existed. */
  private skillsDirty = false
  private readonly planStates = new Map<string, PlanSnapshot>()
  private readonly metricsStates = new Map<string, { usage?: UsageSnapshot; stats?: StatsSnapshot }>()
  /** One host diagnostic per process when the public projection read fails. */
  private projectionReadWarned = false
  private readonly compactionCauses = new Map<string, string>()
  private readonly subagentBridge: SubagentBridge
  private readonly nativeUiAccess: NativeUiAccess
  private readonly nativeInspection: NativeInspection
  private readonly nativeFiles: NativeFileInput
  private readonly nativeQuestions: NativeQuestionAdapter
  private readonly nativeManagement: NativeManagement
  private readonly activeNativeUiReads = new Map<string, { scope: NativeUiScope; controller: AbortController }>()
  private offNativeJobs?: () => void
  private nativeJobsScopeSignature = ''
  private nativeJobsService: unknown
  private readonly childPresenters = new Map<string, { readonly agent: AgentLike; readonly presenter: ToolPresenter }>()
  private bound = false
  private native: DshNativeHelpers | undefined
  private live: LiveAgent | undefined
  private pending: PendingSession | undefined
  private switching: Promise<void> = Promise.resolve()
  private closed = false
  /** First owned cleanup; every later `close()` joins it instead of returning early. */
  private closing: Promise<void> | undefined
  private closedEmitted = false
  private decisionSeq = 0
  private modelFailureSignature = ''
  private publishedRouteSignature: string | undefined
  private configurationInvalidationQueued = false
  private toolPresenter: ToolPresenter | undefined
  private reloading: Promise<unknown> | undefined
  private codec: TranscriptCodec | undefined
  /** Native subagent services may activate after the first pending/root ready. */
  private subagentControlCapabilities = ''
  private refreshingSubagentCapabilities: Promise<void> | undefined

  constructor(host: DshHostContext, options: DshContextBackendOptions) {
    this.host = host
    this.options = { ...options }
    this.nativeUiAccess = {
      host, service: name => this.service(name), current: () => this.nativeUiScope(),
      isCurrent: scope => this.isNativeUiCurrent(scope), warn: message => this.warn(message),
    }
    this.nativeInspection = new NativeInspection({
      access: this.nativeUiAccess,
      readPluginInventory: nativeHost => {
        const helper = this.native?.readPluginInventory
        if (helper === undefined) throw codedError('CAPABILITY_UNAVAILABLE', 'the selected DSH installation exposes no plugin inventory helper')
        return helper(nativeHost)
      },
    })
    this.nativeFiles = new NativeFileInput(this.nativeUiAccess)
    this.nativeQuestions = new NativeQuestionAdapter({ access: this.nativeUiAccess })
    this.nativeManagement = new NativeManagement({ access: this.nativeUiAccess })
    this.subagentBridge = new SubagentBridge({
      host: {
        get: (name: string): unknown => this.service(name),
      },
      emit: event => {
        this.emit(event)
        // Enumeration availability can change without a manager mutation.
        if (event.type === 'subagents') this.refreshSubagentControlCapabilities()
      },
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

  private nativeUiScope(): NativeUiScope | undefined {
    if (this.closed) return undefined
    const live = this.live
    if (live !== undefined) return {
      sessionId: live.agent.session.id, attachmentId: live.attachmentId,
      session: live.agent.session, agent: live.agent,
    }
    const pending = this.pending
    return pending === undefined ? undefined : { sessionId: pending.sessionId, attachmentId: pending.attachmentId }
  }

  private isNativeUiCurrent(scope: NativeUiScope): boolean {
    const current = this.nativeUiScope()
    return current !== undefined && current.sessionId === scope.sessionId && current.attachmentId === scope.attachmentId &&
      (scope.agent === undefined || current.agent === scope.agent) && (scope.session === undefined || current.session === scope.session)
  }

  private emitNativeUiInvalidation(domain: NativeUiDomain): void {
    const scope = this.nativeUiScope()
    if (scope !== undefined) this.emit({ type: 'native_ui_changed', sessionId: scope.sessionId, attachmentId: scope.attachmentId, domain })
  }

  /** Owned request cancellation only; a public SDK without a signal continues natively. */
  private async nativeUiRead<T>(label: string, task: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    const scope = this.nativeUiScope()
    if (scope === undefined) throw codedError('NOT_CONNECTED', 'no native attachment is current')
    if (external?.aborted === true) throw codedError('ABORTED', label + ' was cancelled')
    const id = randomUUID(), controller = new AbortController()
    const externalAbort = (): void => controller.abort()
    external?.addEventListener('abort', externalAbort, { once: true })
    this.activeNativeUiReads.set(id, { scope, controller })
    let onAbort: () => void = () => {}
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(codedError('ABORTED', label + ' was cancelled'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const result = await withTimeout(Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw codedError('ABORTED', label + ' was cancelled')
          return task(controller.signal)
        }), aborted,
      ]), NATIVE_UI_READ_TIMEOUT_MS, label)
      if (!this.isNativeUiCurrent(scope)) throw codedError('STALE_SESSION', 'the native attachment changed during ' + label)
      return result
    } finally {
      external?.removeEventListener('abort', externalAbort)
      controller.signal.removeEventListener('abort', onAbort)
      controller.abort()
      this.activeNativeUiReads.delete(id)
    }
  }

  private abortNativeUiReads(sessionId?: string): void {
    for (const entry of this.activeNativeUiReads.values()) {
      if (sessionId === undefined || entry.scope.sessionId === sessionId) entry.controller.abort()
    }
  }

  /**
   * Run one durable session-query read under an adapter-owned bound.
   *
   * `ctx.sessionQuery` reads are read-only native calls: this adapter never
   * terminates or polls them. It abandons the *wait* after
   * {@link SESSION_QUERY_READ_TIMEOUT_MS}, aborts the signal handed to the
   * native method, and rejects with a coded adapter diagnostic. `close()` and
   * the retirement of one attachment abort the same carrier, so a read that
   * settles late can never deliver a snapshot/listing for a closed or replaced
   * attachment: the caller awaits the rejection, and no value is returned after
   * `close()`.
   *
   * @param label - adapter-owned description used in coded diagnostics.
   * @param task - native read; receives the owned cancellation signal.
   * @param sessionId - exact attachment epoch the read belongs to, when scoped.
   * @returns the native value, untouched.
   */
  private async durableRead<T>(
    label: string,
    task: (signal: AbortSignal) => Promise<T>,
    sessionId?: string,
  ): Promise<T> {
    this.assertOpen()
    const id = randomUUID()
    const controller = new AbortController()
    this.activeDurableReads.set(id, { controller, sessionId })
    const timer = setTimeout(() => {
      controller.abort(codedError('RUNTIME_REQUEST_FAILED', `${label} timed out after ${SESSION_QUERY_READ_TIMEOUT_MS}ms`))
    }, SESSION_QUERY_READ_TIMEOUT_MS)
    timer.unref?.()
    let onAbort: () => void = () => {}
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => {
        const reason = controller.signal.reason
        reject(reason instanceof Error
          ? reason
          : codedError('ABORTED', label + ' was cancelled'))
      }
      if (controller.signal.aborted) onAbort()
      else controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const value = await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw codedError('ABORTED', label + ' was cancelled')
          return task(controller.signal)
        }),
        aborted,
      ])
      // A native read that settled just after the adapter stopped waiting is
      // never delivered as a fresh fact.
      if (this.closed) throw codedError('CLOSED', 'the backend closed during ' + label)
      return value
    } finally {
      clearTimeout(timer)
      controller.signal.removeEventListener('abort', onAbort)
      controller.abort()
      this.activeDurableReads.delete(id)
    }
  }

  private abortDurableReads(sessionId?: string): void {
    for (const entry of this.activeDurableReads.values()) {
      if (sessionId === undefined || entry.sessionId === sessionId) {
        if (!entry.controller.signal.aborted) {
          entry.controller.abort(codedError('ABORTED', 'the durable session read was cancelled'))
        }
      }
    }
  }

  private syncNativeJobsSubscription(): void {
    const scope = this.nativeUiScope()
    const signature = scope === undefined ? '' : JSON.stringify([scope.sessionId, scope.attachmentId])
    const service = this.service('jobs')
    if (signature === this.nativeJobsScopeSignature && service === this.nativeJobsService) return
    this.nativeJobsService = service
    this.offNativeJobs?.(); this.offNativeJobs = undefined
    this.nativeJobsScopeSignature = signature
    if (scope !== undefined) this.offNativeJobs = this.nativeInspection.subscribeJobs(() => this.emitNativeUiInvalidation('jobs'))
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

  /** Native catalog invalidations carry no owned rows; name only this current surface. */
  private emitCatalogInvalidation(type: 'commands_changed' | 'models_changed' | 'presets_changed'): void {
    if (this.closed) return
    const live = this.live
    if (live !== undefined) {
      this.emit({ type, sessionId: live.agent.session.id, attachmentId: live.attachmentId })
      return
    }
    const pending = this.pending
    if (pending !== undefined) this.emit({ type, sessionId: pending.sessionId, attachmentId: pending.attachmentId })
  }

  private routeMetadataSignature(info: { sessionId: string; attachmentId?: string; provider: string; model: string; reasoningEffort?: string }): string {
    return JSON.stringify([info.sessionId, info.attachmentId, info.provider, info.model, info.reasoningEffort])
  }

  /** Read native current/default getters only; never select or prepare a request. */
  private publishCurrentModelRoute(): void {
    if (this.closed) return
    const live = this.live
    const pending = this.pending
    if (live === undefined && pending === undefined) return
    const route = this.agentRoute()
    const event = {
      type: 'model_route' as const,
      sessionId: live?.agent.session.id ?? pending!.sessionId,
      attachmentId: live?.attachmentId ?? pending!.attachmentId,
      provider: route?.provider ?? '',
      model: route?.model ?? '',
      ...(route?.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
    }
    const signature = this.routeMetadataSignature(event)
    if (signature === this.publishedRouteSignature) return
    this.publishedRouteSignature = signature
    this.emit(event)
  }

  /** Settled native config/document signals may burst or announce pre/post writes. */
  private invalidateNativeConfiguration(): void {
    if (this.closed || this.configurationInvalidationQueued) return
    this.configurationInvalidationQueued = true
    queueMicrotask(() => {
      this.configurationInvalidationQueued = false
      if (this.closed) return
      // Publish the getter result first so picker reads capture the current route.
      this.publishCurrentModelRoute()
      this.emitCatalogInvalidation('presets_changed')
      this.emitCatalogInvalidation('models_changed')
      this.emitNativeUiInvalidation('settings')
      this.emitNativeUiInvalidation('inventory')
      this.emitNativeUiInvalidation('tools')
      this.syncNativeJobsSubscription()
      this.refreshSubagentControlCapabilities()
    })
  }

  private assertOpen(): void {
    if (this.closed) throw codedError('CLOSED', 'the backend is closed')
  }

  private async ensureNative(): Promise<DshNativeHelpers> {
    if (this.native !== undefined) return this.native
    this.native = await loadDefaultNative(this.host)
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
    // The native registry invalidation is unfiltered and carries no payload.
    // Pending metadata reads are legitimate (preset-scope leases), so a root
    // invalidation is forwarded for whatever current observation exists; an
    // arriving pre-commit event is replayed after the ready announcement.
    keep('skills/change', () => {
      const live = this.live
      if (live !== undefined) {
        this.emit({ type: 'skills_changed', sessionId: live.agent.session.id, attachmentId: live.attachmentId })
        return
      }
      const pending = this.pending
      if (pending === undefined || this.closed) return
      this.skillsDirty = true
      this.emit({ type: 'skills_changed', sessionId: pending.sessionId, attachmentId: pending.attachmentId })
    }, { global: true })
    // The native command registry declares `commands/change(): void` and emits
    // it unfiltered with no payload (0.2.2-rc.1 `CommandRuntime` registration
    // and disposal). The invalidation therefore names this adapter's current
    // surface — the attached Agent when live, else the pending attachment —
    // instead of trusting an event scope that does not exist on the wire. The
    // roster itself stays native: a consumer re-reads `commands.list(agent)`,
    // so no TUI command registry, snapshot comparison or poll is introduced.
    // A child-Agent-scoped registration also reaches this root listener, so the
    // invalidation is deliberately conservative: it names the current surface
    // and claims nothing about which layer changed. Bursts are possible (one
    // preset mount registers several commands) and stay one event each:
    // consumers already single-flight the native listing.
    keep('commands/change', () => this.emitCatalogInvalidation('commands_changed'), { global: true })
    // Public native registry events, not provider polling or a TUI-owned catalog.
    keep('llm/adapters-updated', () => this.emitCatalogInvalidation('models_changed'), { global: true })
    keep('llm/models-updated', () => this.emitCatalogInvalidation('models_changed'), { global: true })
    // Public, settled host signals; no hard-coded Web profile namespace and no
    // pre-commit hmr/change/internal service hooks or private registry polling.
    keep('app-boot/config-reload', () => this.invalidateNativeConfiguration(), { global: true })
    keep('settings/document-updated', () => this.invalidateNativeConfiguration(), { global: true })
    keep('goal/changed', payload => {
      if (goalChangedInvalidation(payload, this.nativeUiScope()) !== undefined) this.emitNativeUiInvalidation('goal')
    }, { global: true })
    keep('goal/activation-changed', payload => {
      if (this.live !== undefined && record(payload)?.agent === this.live.agent) this.emitNativeUiInvalidation('goal')
    }, { global: true })
    keep('tools/change', () => {
      this.emitNativeUiInvalidation('tools')
      this.refreshSubagentControlCapabilities()
    }, { global: true })
    keep('plugin-manager/changed', () => {
      this.emitNativeUiInvalidation('inventory')
      this.refreshSubagentControlCapabilities()
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
          if (key === 'title') {
            // The projection is the native title truth: null means no title,
            // undefined means the projection did not report a value. Never
            // synthesize, cache or announce a TUI-owned title.
            if (value === null || typeof value === 'string') {
              this.emit({ type: 'title', sessionId, attachmentId: this.live.attachmentId, value })
            }
            return
          }
          if (key === 'todos') {
            this.emit({ type: 'todos', sessionId, value: this.todosSnapshotOf(value) })
            return
          }
          if (key === 'plan') {
            // The projection change is only the invalidation signal; the fact
            // itself comes from the native controller for this exact Agent.
            const live = this.live
            if (live !== undefined) this.publishPlan(live.agent.session, this.planFactOf(live.agent))
            return
          }
          const domain = projectionInvalidationDomain(key)
          if (domain !== undefined) this.emitNativeUiInvalidation(domain)
          if (isUserQuestionProjectionKey(key)) this.emitNativeUiInvalidation('questions')
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
    // Path-only discovery is exactly the mounted provider's `list` method.
    // Resolved live so an HMR replacement is visible without a reconnect.
    if (fileReferenceService(this.service('fileReferences')) !== undefined) caps.push('file-references')
    const fileCapabilities = this.nativeFiles.capabilities()
    if (fileCapabilities.promptFiles) caps.push('file-input')
    if (fileCapabilities.commandImages) caps.push('command-attachments')
    if (fileCapabilities.commandFiles) caps.push('command-file-attachments')
    if (has('jobs', 'list') && has('jobs', 'get') && has('jobs', 'readAt')) caps.push('native-jobs', 'native-job-output')
    if (has('goals', 'get')) caps.push('native-goal')
    if (has('workingDirectory', 'get')) caps.push('native-working-directory')
    if (this.native?.readPluginInventory !== undefined && has('loader', 'entries')) caps.push('native-inventory')
    if (has('tools', 'definitions') && has('tools', 'executable')) caps.push('native-tools')
    const questionCapabilities = this.nativeQuestions.capabilities()
    if (questionCapabilities.answer) caps.push('continued-questions', 'native-questions', 'native-question-answer')
    const managementCapabilities = this.nativeManagement.capabilities()
    if (managementCapabilities.rename) caps.push('session-rename')
    if (managementCapabilities.defaultSettingsRead) caps.push('native-defaults')
    if (managementCapabilities.defaultSettingsWrite) caps.push('native-default-update')
    if (this.live !== undefined && this.native?.buildForkSeed !== undefined && typeof this.live.agent.session.snapshotEvents === 'function' &&
        typeof this.live.agent.session.seq === 'number' && this.live.agent.session.seq > 0 && has('agents', 'create')) caps.push('session-fork')
    if (has('llm', 'listProviders') && has('llm', 'listModels')) caps.push('models')
    if (has('sessionQuery', 'readSession')) caps.push('sessions', 'titles')
    if (has('permissionPresets', 'catalog')) caps.push('permissions')
    if (has('agentPresets', 'list')) caps.push('presets', 'preset')
    if (has('llm', 'resolveModelInfo')) caps.push('efforts', 'effort')
    if (has('hmr', 'runExclusive')) caps.push('reload')
    if (has('commands', 'list')) caps.push('commands')
    if (has('commands', 'execute')) caps.push('execute')
    // Skill metadata readability is the native registry API alone; tool-schema
    // visibility never decides whether user-invocable skills exist.
    if (has('skills', 'snapshot') || has('skills', 'list')) caps.push('skills', 'input-route')
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
    this.pending = {
      sessionId: randomUUID(),
      attachmentId: randomUUID(),
      // Only an explicit CLI pair pins a new session. Without one the route
      // follows the live native default until DSH records a selection.
      route: this.explicitConfigRoute(),
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
    const route = this.pendingRoute(pending)
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
    const route = this.pendingRoute(pending)
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

  /**
   * Materialize the pending attachment's Agent exactly once.
   *
   * `close()` sets `closed` synchronously and then joins this serialized
   * create/switch chain, so every asynchronous boundary inside creation is
   * followed by a closed/ownership re-check:
   *
   * - an Agent whose native factory settles after shutdown is discarded, never
   *   committed or announced;
   * - only the exact pending observation captured at entry may be consumed;
   * - no `ready` is emitted after `closed`, and a switched attachment cannot be
   *   overwritten by a stale materialization.
   *
   * Only the handle this call created is ever disposed. The host root, a
   * previous Agent and unrelated carriers are untouched.
   */
  private async ensureCurrent(): Promise<void> {
    this.assertOpen()
    if (this.live !== undefined) return
    await this.serialize(async () => {
      this.assertOpen()
      if (this.live !== undefined) return
      const pending = this.pending
      if (pending === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
      const prepared = await this.prepareAgent('new', pending.sessionId, pending.preset, {
        attachmentId: pending.attachmentId,
        route: pending.route,
      })
      // The only async factory boundary this adapter owns. A close that landed
      // during composition must not publish a live Agent or a ready event.
      if (this.closed) {
        await this.discardAgent(prepared)
        throw codedError('CLOSED', 'the backend closed while the native Agent was created; nothing was published')
      }
      if (this.pending !== pending) {
        await this.discardAgent(prepared)
        throw codedError('STALE_SESSION', 'the staged DSH session changed while its Agent was created; nothing was published')
      }
      try {
        this.commitAgent(prepared)
      } catch (error) {
        // A partially committed publication is rolled back before disposal so
        // `live` never points at an Agent this adapter is about to dispose.
        this.releaseCommittedAgent(prepared)
        await this.discardAgent(prepared)
        throw error
      }
      // Retire the pending reads before the captured observation disappears.
      this.abortSkillQueries('session materialized', pending.sessionId)
      if (this.pending === pending) this.pending = undefined
      const info = await this.sessionInfo(false)
      // The announcement is the last asynchronous boundary: a close during the
      // info/snapshot reads suppresses it instead of emitting a stale ready.
      if (this.closed) throw codedError('CLOSED', 'the backend closed before the materialized DSH session was announced')
      if (this.live !== prepared) throw codedError('STALE_SESSION', 'the DSH attachment changed before the materialized session was announced')
      this.emitAnnouncement(info)
    })
  }

  /** Undo this adapter's own publication fields for one exact prepared Agent. */
  private releaseCommittedAgent(prepared: LiveAgent): void {
    if (this.live !== prepared) return
    this.live = undefined
    this.toolPresenter = undefined
    this.planStates.delete(prepared.agent.session.id)
    this.metricsStates.delete(prepared.agent.session.id)
    this.subagentBridge.setRoot(undefined)
    this.childPresenters.clear()
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
    options: { attachmentId?: string; route?: Route; fork?: Extract<InteractiveForkInputOutcome, { ok: true }> } = {},
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
      // A resumed Session keeps its own logged selection/request as the native
      // authority (`agent.model.current()` reads it first). The live default is
      // only the fallback for a Session that recorded neither, exactly like the
      // packaged DSH session controller resumes. An explicit CLI pair pins new
      // sessions; it never rewrites a resumed conversation's route.
      const agentOptions = this.defaultRouteOptions()
      let handle: AgentHandleLike
      try {
        handle = await agents.resume({
          resumeSessionId: sessionId,
          ...(agentOptions === undefined ? {} : { agentOptions }),
          setup: async (agentCtx: unknown, agent: AgentLike) => {
            await mountPreset(agentCtx, agent, undefined)
          },
        })
      } catch (error) {
        throw nativeAgentFailure(`DSH could not resume session ${JSON.stringify(sessionId)}`, error)
      }
      // Display/pin record only: the durable header stays the logged truth.
      const route = routeFromLogged(handle.agent.session.requestHeader?.())
      return { handle, agent: handle.agent, attachmentId: randomUUID(), route }
    }
    // An adapter-pinned choice (explicit CLI pair or a staged /model or
    // /effort selection) becomes a complete native option snapshot. Without
    // one, DSH receives live accessors so the creation route keeps following
    // later native default changes until a selection or request pins it.
    const pinned = options.route
    const agentOptions = pinned === undefined ? this.defaultRouteOptions() : routeOptions(pinned)
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
        ...(options.fork === undefined ? {} : { seed: options.fork.seed, inheritedEventCount: options.fork.inheritedEventCount }),
        meta: {
          cwd: this.options.cwd,
          ...(options.fork === undefined ? {} : options.fork.meta),
          ...(resolvedPreset === undefined ? {} : { agentPreset: resolvedPreset }),
        },
        ...(agentOptions === undefined ? {} : { agentOptions }),
        setup: async (agentCtx: unknown, agent: AgentLike) => {
          await mountPreset(agentCtx, agent, resolvedPreset)
        },
      })
    } catch (error) {
      throw nativeAgentFailure(`DSH could not create session ${JSON.stringify(sessionId)}`, error)
    }
    return { handle, agent: handle.agent, attachmentId, route: pinned }
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

  /**
   * Retire one owned Agent.
   *
   * Every adapter-owned carrier that pointed at this exact attachment ends
   * here: skill metadata reads, native-UI reads, its own pending decisions and
   * its in-flight native commands. Commands matter for `/reload`: the native
   * idle gate counts any unsettled command, so a dangling carrier of a retired
   * session would block reload forever with the new attachment as its owner.
   * The drain is bounded exactly like `close()`'s, and an uncooperative native
   * command still cannot extend retirement indefinitely.
   *
   * @param target - the exact Agent handle this adapter created or resumed.
   * @param reason - user-facing reason recorded on aborted carriers.
   */
  private async closeAgent(target: LiveAgent, reason: string): Promise<void> {
    const sessionId = target.agent.session.id
    // The attachment epoch ends here: a metadata read that started against it
    // must reject rather than deliver a catalog for a retired Agent.
    this.abortSkillQueries(reason, sessionId)
    this.abortNativeUiReads(sessionId)
    // A durable snapshot/listing read scoped to this exact attachment stops
    // waiting here; a late native log can never be published for it.
    this.abortDurableReads(sessionId)
    // Only this Agent's own decisions: a child's pending approval/question is
    // refused by its own interruption path, never by a parent switch.
    this.closePendingDecisions(reason, { agent: target.agent, sessionId })
    if (this.abortActiveCommands(reason, sessionId) > 0) await this.drainCommands(COMMAND_DRAIN_TIMEOUT_MS, sessionId)
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
    // A blank session has nothing to flush. An unknown blank stays conservative
    // and flushes: a failed turn-boundary read must never skip a real write.
    if (this.blankSessionOf(target.agent.session) !== true) {
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

  /**
   * The route this session follows now: an adapter-pinned choice, else the
   * live native default selection.
   *
   * A pin exists only after an explicit choice reached this adapter (the CLI
   * pair for a new session, or a staged/live `/model`//`/effort` selection).
   * Everything else stays unknown-or-live: DSH owns the default, and a failed
   * or absent `currentSelection()` read is reported as unknown rather than
   * guessed from the last route this adapter saw.
   * @param pinned - the adapter-pinned route, if any.
   * @returns the effective route, or `undefined` when it is unknown.
   */
  private followedRoute(pinned: Route | undefined): Route | undefined {
    return pinned ?? this.defaultModelSelection()
  }

  private pendingRoute(pending: PendingSession | undefined = this.pending): Route | undefined {
    return pending === undefined ? undefined : this.followedRoute(pending.route)
  }

  /**
   * Native `AgentOptions` route fallback built from live getters, matching the
   * packaged DSH session controller (`dsh-api-session-controller`
   * `agentOptions()`): a Session that records no selection or request follows
   * later native default changes on its next step preparation.
   *
   * The getters are the SDK's documented accessor form
   * (`AgentOptions` route fields "may be live accessors until the Session
   * records a selection or request"). They read the native service per access,
   * so this adapter never caches, polls or re-announces the default. A failed
   * read stays unknown (the native loop then reports its own missing route)
   * instead of throwing out of unrelated display reads that also consult
   * `agent.options`.
   * @returns live option accessors, or `undefined` when no native default service is mounted.
   */
  private defaultRouteOptions(): Record<string, string | undefined> | undefined {
    const defaults = this.service<DefaultModelLike>('agentDefaultModel')
    if (typeof defaults?.currentSelection !== 'function') return undefined
    const currentSelection = defaults.currentSelection.bind(defaults)
    const selection = (): Route | undefined => {
      try {
        return routeOf(currentSelection())
      } catch {
        return undefined
      }
    }
    return {
      get provider() { return selection()?.provider },
      get model() { return selection()?.model },
      get reasoningEffort() { return selection()?.reasoningEffort },
    }
  }

  /**
   * The current route of one native Agent, a retired/explicit Agent, or the
   * pending attachment.
   *
   * `undefined` means "no Agent is current": the pending attachment's staged
   * or followed native default is then the only route fact, and it is returned
   * for the default lookup. A caller that passes an explicit Agent (a retired
   * one, or a child) never inherits the pending route.
   *
   * @param agent - exact Agent to read; defaults to the current live Agent.
   * @returns the native route, or undefined when it is unknown.
   */
  private agentRoute(agent?: AgentLike): Route | undefined {
    const live = this.live
    const target = agent ?? live?.agent
    if (target !== undefined && typeof target.model?.current === 'function') {
      try {
        // Native authority: a recorded selection/request wins, else the live
        // `AgentOptions` accessors above.
        const current = routeOf(target.model.current())
        if (current !== undefined) return current
      } catch {
        /* fall through to the adapter's own record */
      }
    }
    if (live !== undefined && target === live.agent) return this.followedRoute(live.route)
    // No Agent at all: the pending attachment has no session to record a
    // selection in, so its staged pin (or the live native default) is the
    // route fact. Read-only callers (`efforts`) use it without materializing.
    if (target === undefined && live === undefined) return this.pendingRoute()
    return undefined
  }

  private applyRoute(agent: AgentLike, route: Route): void {
    if (typeof agent.model?.select !== 'function') {
      throw codedError('CAPABILITY_UNAVAILABLE', 'this session has no native model-selection slot; the route was not changed')
    }
    agent.model.select(routeOptions(route))
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
        this.retirePendingQueries('session switched')
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
      this.retirePendingQueries('session switched')
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
    return await this.serialize(async () => {
      const previous = this.live
      if (previous !== undefined) {
        this.live = undefined
        this.toolPresenter = undefined
        this.subagentBridge.setRoot(undefined)
        this.childPresenters.clear()
      }
      this.retirePendingQueries('session switched')
      this.pending = {
        sessionId: randomUUID(),
        attachmentId: randomUUID(),
        // Same rule as the initial attachment: only the explicit CLI pair pins,
        // every other new session follows the live native default.
        route: this.explicitConfigRoute(),
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
    this.publishedRouteSignature = this.routeMetadataSignature(info)
    this.subagentControlCapabilities = this.subagentControlCapabilitySignature()
    this.emit({ type: 'ready', info })
    this.syncNativeJobsSubscription()
    // A provider registration during preset mount can precede the ready for
    // this very attachment. Replay it now so a consumer that cached the pending
    // observation refetches against the committed native scope.
    if (this.skillsDirty && this.live !== undefined) {
      this.skillsDirty = false
      this.emit({ type: 'skills_changed', sessionId: this.live.agent.session.id, attachmentId: this.live.attachmentId })
    }
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
    // Only the mounted subagent discovery/control faces can appear or vanish
    // per child event (DSH may activate them after the first ready). This
    // signature deliberately avoids `capabilities()`: that read enumerates the
    // Loader and every other service, which would run on every subagent frame.
    // Other capability changes arrive through their own native invalidations
    // and re-announce from there, so no dynamic fact is frozen here.
    if (!this.subagentBridge.available()) return ''
    const subagents = this.service<Record<string, unknown>>('subagents')
    return [
      'subagents',
      typeof subagents?.interrupt === 'function' ? 'subagent-interrupt' : '',
      typeof subagents?.prompt === 'function' ? 'subagent-prompt' : '',
    ].join(' ')
  }

  /**
   * Re-publish a same-attachment ready when native discovery/read/control
   * availability changes after the initial pending/root announcement. No snapshot, Editor,
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
    const title = this.titleOf(session)
    const info: SessionInfo = {
      attachmentId: live.attachmentId,
      sessionId: session.id,
      cwd: this.options.cwd,
      provider: route?.provider ?? live.agent.options?.provider ?? '',
      model: route?.model ?? live.agent.options?.model ?? '',
      ...(typeof route?.reasoningEffort === 'string' ? { reasoningEffort: route.reasoningEffort } : {}),
      ...(preset === undefined ? {} : { preset }),
      ...(permissions === undefined ? {} : { permissions }),
      ...(title === undefined ? {} : { title }),
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
    const captured = this.live
    let rawLog: unknown
    try {
      // Public `readSession(id)` takes no signal: the adapter bounds its own
      // wait and aborts only the reads that can be cancelled. A late log for a
      // closed or replaced attachment is rejected, never returned.
      rawLog = await this.durableRead('native session snapshot', () => query.readSession(sessionId), sessionId)
    } catch (error) {
      const code = backendErrorCodeOf(error)
      // Closing, cancellation and a replaced attachment are not an incomplete
      // conversation: they must abort the caller instead of publishing one.
      if (code === 'CLOSED' || code === 'ABORTED' || code === 'STALE_SESSION') throw error
      // A failed or timed-out durable read is reported as incomplete, never as empty.
      return undefined
    }
    if (this.closed) throw codedError('CLOSED', 'the backend closed during the native session snapshot')
    if (captured === undefined || this.live !== captured || captured.agent.session.id !== sessionId) {
      throw codedError('STALE_SESSION', 'the DSH session changed while its durable snapshot was read')
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

  /**
   * The exact native owner of one decision request.
   *
   * The asking Agent object is the identity that `cancel()`/retirement filter
   * on; its own session id is the owner id only. The event root stays the
   * caller-supplied root (a child decision is announced under the root).
   */
  private decisionOwner(request: Record<string, unknown>, origin?: DecisionOrigin): DecisionOwner {
    const agent = request.agent
    const liveSessionId = this.live?.agent.session.id ?? ''
    return {
      agent,
      sessionId: origin?.childSessionId ?? textOf(record(agent)?.id) ?? liveSessionId,
      eventSessionId: origin?.rootSessionId ?? liveSessionId,
    }
  }

  private askApproval(request: Record<string, unknown>, origin?: DecisionOrigin): Promise<unknown> {
    const id = this.nextDecisionId('approval')
    const owner = this.decisionOwner(request, origin)
    const title = typeof request.toolName === 'string' ? `Approve ${request.toolName}` : 'Approve tool'
    const display = record(request.displayReason)
    const message = typeof request.reason === 'string'
      ? request.reason
      : typeof display?.en === 'string' ? display.en : undefined
    this.emit({
      type: 'decision',
      sessionId: owner.eventSessionId,
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
    return this.awaitDecision(id, 'approval', signal, owner).then(
      value => normalizeApprovalOutcome(value),
      () => 'cancelled',
    )
  }

  private askQuestions(request: Record<string, unknown>, origin?: DecisionOrigin): Promise<unknown> {
    const id = this.nextDecisionId('question')
    const owner = this.decisionOwner(request, origin)
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
      sessionId: owner.eventSessionId,
      request: requestWire,
    })
    const signal = request.signal instanceof AbortSignal ? request.signal : undefined
    return this.awaitDecision(id, 'question', signal, owner).then(
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

  private awaitDecision(id: string, kind: 'approval' | 'question', signal: AbortSignal | undefined, owner: DecisionOwner): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const entry: PendingDecision = {
        kind,
        signal,
        owner,
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

  /**
   * Settle exactly one pending decision.
   *
   * `sessionId` is the event rooting of `decision_closed`; when the caller does
   * not supply one, the owner's captured event root is used, so a late/aborted
   * child decision still closes under the same session it was announced under.
   */
  private settleDecision(
    id: string,
    value?: unknown,
    error?: Error,
    sessionId?: string,
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
    this.emit({ type: 'decision_closed', sessionId: sessionId ?? entry.owner.eventSessionId, id })
    if (error === undefined) entry.resolve(value)
    else {
      if (errorCode !== undefined) Object.assign(error, { code: errorCode })
      entry.reject(error)
    }
    return true
  }

  /**
   * Settle the pending decisions owned by one exact native Agent.
   *
   * The filter is the owner, not the event root: a root interruption or one
   * attachment's retirement must never answer a decision that a *different*
   * Agent asked (the child's own approval/question stays open for its own
   * interruption path). Without an `owner` every decision is settled, which is
   * only correct when the adapter itself is closing.
   *
   * @param reason - user-facing reason for an aborted question.
   * @param owner - exact native Agent (and its session id) being retired.
   */
  private closePendingDecisions(reason: string, owner?: { readonly agent: unknown; readonly sessionId: string }): void {
    for (const id of [...this.pendingDecisions.keys()]) {
      const entry = this.pendingDecisions.get(id)
      if (entry === undefined) continue
      if (owner !== undefined && (entry.owner.agent !== owner.agent || entry.owner.sessionId !== owner.sessionId)) continue
      if (entry.kind === 'approval') this.settleDecision(id, undefined, undefined, entry.owner.eventSessionId)
      else this.settleDecision(id, undefined, codedError('RUNTIME_REQUEST_FAILED', reason), entry.owner.eventSessionId, 'ASK_ABORTED')
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
        entry.owner.eventSessionId,
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

  /**
   * Send one ordered native prompt, admitting attachments exactly once.
   *
   * Public `attachments.admitPromptContent(content)` takes no signal: DSH owns
   * that call and offers no cancellation. The adapter therefore owns the single
   * wall-clock bound (`nativeUiRead`) and an adapter-owned cancellation carrier
   * registered in the active-command table. `cancel()` (Esc), `close()` and the
   * retirement of the attachment abort that carrier: the adapter stops waiting
   * immediately, and `NativeFileInput.admitPrompt` discards the unabortable
   * native result when it eventually settles, so no late message is created or
   * sent. No fabricated signal is passed to DSH's native method.
   */
  async sendContent(content: readonly PromptContentPart[], mode: 'followup' | 'steer' = 'followup'): Promise<void> {
    this.assertOpen()
    if (mode !== 'followup' && mode !== 'steer') throw codedError('INVALID_ARGUMENT', `unsupported send mode: ${String(mode)}`)
    const parts = normalizePromptContent(content)
    if (!parts.some(part => part.type !== 'text' || part.text.trim().length > 0)) {
      throw codedError('INVALID_ARGUMENT', 'sendContent requires non-whitespace text, an image or a file')
    }
    if (parts.every(part => part.type === 'text')) {
      await this.send(parts.map(part => part.type === 'text' ? part.text : '').join('\n'), mode)
      return
    }
    if (!this.nativeFiles.capabilities().promptContent) {
      throw codedError('CAPABILITY_UNAVAILABLE', 'this runtime mounts no native prompt attachment admission; the prompt was not sent')
    }
    await this.ensureNative()
    await this.ensureCurrent()
    const live = this.live
    const scope = this.nativeUiScope()
    if (live === undefined || scope === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
    const admitted = await this.runActiveCommand('native prompt admission', scope.sessionId, async (owned) => {
      return await this.nativeUiRead('native prompt admission', signal => this.nativeFiles.admitPrompt(parts, signal), owned)
    })
    if (this.closed) throw codedError('CLOSED', 'the backend closed during native prompt admission; the prompt was not sent')
    if (this.live !== live) throw codedError('STALE_SESSION', 'the DSH Agent attachment changed during prompt admission; the prompt was not sent')
    const message = this.native!.createUserMessage({ content: admitted, source: { kind: 'user' } })
    if (mode === 'steer') await live.agent.steer(message)
    else await live.agent.followup(message)
  }

  /**
   * Stage one frontend-read file through the native attachment store.
   *
   * The native write is registered in the existing active-command table, so an
   * in-flight stage is visible to `assertReloadIdle()` and to `close()`/
   * session retirement exactly like a native command. The caller's signal is
   * composed with the carrier (either aborts the native-UI read), and the
   * existing `nativeUiRead` bound/identity guard still governs the wait.
   *
   * @param input - canonical base64 bytes plus an optional name.
   * @param signal - caller cancellation; never weakened by the registry carrier.
   * @returns the native durable file reference.
   */
  async stageFile(input: EncodedFileInput, signal?: AbortSignal): Promise<FileAttachmentRef> {
    this.assertOpen()
    const scope = this.nativeUiScope()
    if (scope === undefined) throw codedError('NOT_CONNECTED', 'no native attachment is current')
    return await this.runActiveCommand('native file staging', scope.sessionId, async (owned) => {
      const cancellation = signal === undefined ? owned : AbortSignal.any([owned, signal])
      return await this.nativeUiRead('native file staging', read => this.nativeFiles.stageFile(input, read), cancellation)
    })
  }

  /**
   * Cancellable path-only `@file` discovery through the mounted provider.
   *
   * `ctx.fileReferences.list(agent, query, signal)` is the only source: this
   * adapter never scans a workspace, resolves a path, reads or stages file
   * bytes, or keeps a provider/catalog. A pending first prompt materializes its
   * own native Agent through the ordinary lazy path (no model turn) only after
   * the provider is confirmed mounted, so a composition without discovery is
   * never failed by creating an Agent. The exact live Agent and the owned
   * cancellation signal reach that call, and the ordinary native-UI identity
   * check rejects a result whose attachment is no longer current.
   */
  async listFileReferences(query: string, signal?: AbortSignal): Promise<readonly FileReferenceCandidate[]> {
    this.assertOpen()
    if (typeof query !== 'string') {
      throw codedError('INVALID_ARGUMENT', 'listFileReferences requires the native @path query text')
    }
    if (signal?.aborted === true) throw codedError('ABORTED', 'the native file-reference query was cancelled')
    // Capability first: a query that cannot be served must never materialize
    // the pending Agent merely to reject it.
    if (fileReferenceService(this.service('fileReferences')) === undefined) {
      throw codedError('CAPABILITY_UNAVAILABLE', 'this runtime mounts no native file-reference provider')
    }
    if (this.live === undefined && this.pending === undefined) {
      throw codedError('NOT_CONNECTED', 'no native attachment is current')
    }
    // A provider addresses one concrete Agent. The pending root is materialized
    // through the existing lazy path, which creates the Agent and sends nothing.
    if (this.live === undefined) await this.ensureCurrent()
    this.assertOpen()
    const live = this.live
    if (live === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
    return await this.nativeUiRead('native file-reference query', async (owned) => {
      // HMR: resolve the mounted service again for this exact call; a retained
      // instance could belong to an unloaded composition.
      const service = fileReferenceService(this.service('fileReferences'))
      if (service === undefined) {
        throw codedError('CAPABILITY_UNAVAILABLE', 'the native file-reference provider was unmounted before the query')
      }
      if (this.live !== live) {
        throw codedError('STALE_SESSION', 'the DSH Agent attachment changed before file-reference discovery')
      }
      return await listFileReferenceCandidates(service, live.agent, query, owned)
    }, signal)
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
        // Same taxonomy as every other native seam: keep a stable native code,
        // otherwise report one redacted RUNTIME_REQUEST_FAILED. A raw native
        // Error would carry an unredacted credential straight into the UI.
        throw imageReadFailure(error)
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

  /**
   * One public session-projection cut for the exact session.
   *
   * `sessionProjections.snapshot(session, keys)` is the supported carrier read:
   * it validates every value through that unit's own wire schema and serves one
   * consistent watermark. `sessionProjections.stateOf` is the deprecated raw
   * registry fold, so this adapter never reads it.
   *
   * `undefined` means the projection face is unmounted or the read failed. A
   * present record holds exactly the keys DSH materialized, so an absent key
   * stays "no native fact" and never becomes a fabricated zero or `null`.
   *
   * @param session - exact Session whose committed events are folded.
   * @param keys - client-visible projection keys this read needs.
   * @returns the native view values, or `undefined` when unavailable.
   */
  private projectionSnapshotOf(session: SessionLike, keys: readonly string[]): Record<string, unknown> | undefined {
    const projections = this.service<ProjectionsLike>('sessionProjections')
    if (typeof projections?.snapshot !== 'function') return undefined
    try {
      return record(record(projections.snapshot(session, keys))?.values)
    } catch (error) {
      if (!this.projectionReadWarned) {
        this.projectionReadWarned = true
        this.warn(`DSH session-projection snapshot is unavailable: ${errorMessage(error)}`)
      }
      return undefined
    }
  }

  private projectionValuesOf(session: SessionLike, keys: readonly string[]): Record<string, unknown> {
    return this.projectionSnapshotOf(session, keys) ?? {}
  }

  /**
   * The native plan-mode fact for one exact Agent, in the public shape.
   *
   * `ctx.planMode.get(agent)` returns `{active, pending?}`: the logged mode in
   * force plus the selection a user has requested but the native boundary has
   * not applied yet (`pending: false` is a real pending-off request, not
   * busy-ness). The host fold's `wanted`/`running.commandId` are internal state
   * and are neither read nor reconstructed here. An unmounted, absent or
   * throwing service stays `undefined` (unavailable), never an inactive fact.
   */
  private planSnapshotOf(value: unknown): PlanSnapshot | undefined {
    const fact = record(value)
    if (fact === undefined || typeof fact.active !== 'boolean') return undefined
    return typeof fact.pending === 'boolean'
      ? { active: fact.active, pending: fact.pending }
      : { active: fact.active }
  }

  /**
   * Resolve the plan-mode controller for one exact Agent like the desktop
   * Remote does: the Agent's preset-isolated `planMode` instance first, then the
   * host-plane service. A lookup failure stays visible and falls back; a
   * composition with neither reports the capability absent.
   */
  private planModeFor(agent: AgentLike): PlanModeLike | undefined {
    const presets = this.service<AgentPresetsLike>('agentPresets')
    if (typeof presets?.serviceFor === 'function') {
      try {
        const scoped = record(presets.serviceFor(agent, 'planMode'))
        if (scoped !== undefined && typeof scoped.get === 'function') return scoped as unknown as PlanModeLike
      } catch (error) {
        this.warn(`DSH preset plan-mode lookup failed: ${errorMessage(error)}`)
      }
    }
    const host = this.service<PlanModeLike>('planMode')
    return typeof host?.get === 'function' ? host : undefined
  }

  /**
   * One native plan-mode read for the exact attached Agent.
   * @returns the public `{active, pending?}` fact, or `undefined` when the
   *   composition mounts no plan-mode controller or the read failed.
   */
  private planFactOf(agent: AgentLike): PlanSnapshot | undefined {
    const planMode = this.planModeFor(agent)
    if (planMode === undefined) return undefined
    try {
      return this.planSnapshotOf(planMode.get(agent))
    } catch {
      return undefined
    }
  }

  /**
   * One native title fact for the exact session.
   *
   * `ctx.sessionTitle.get(session)` is the owning domain read: it folds the very
   * log the `title` projection folds, so `undefined` there is the native
   * no-title fact (`null`) while an unmounted service or a failed read stays
   * unknown and callers omit the field. When a composition mounts no title
   * service, the public `title` projection view is the same tri-state fallback:
   * an absent key is capability absence, `null` is native no-title. No query,
   * provider call or log scrape here.
   */
  private titleOf(session: SessionLike): string | null | undefined {
    const titles = this.service<SessionTitleLike>('sessionTitle')
    if (typeof titles?.get === 'function') {
      try {
        const value = titles.get(session)
        if (value === undefined) return null
        const snapshot = record(value)
        return typeof snapshot?.title === 'string' ? snapshot.title : undefined
      } catch {
        return undefined
      }
    }
    const values = this.projectionSnapshotOf(session, ['title'])
    if (values === undefined || !Object.hasOwn(values, 'title')) return undefined
    const value = values.title
    return value === null || typeof value === 'string' ? value : undefined
  }

  private publishPlan(session: SessionLike, value: unknown): boolean {
    const snapshot = this.planSnapshotOf(value)
    if (snapshot === undefined) return false
    const previous = this.planStates.get(session.id)
    if (previous !== undefined && samePlanSnapshot(previous, snapshot)) return false
    this.planStates.set(session.id, snapshot)
    const engaged = snapshot.active || snapshot.pending !== undefined
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
    const live = this.live
    if (live === undefined) return
    // Each frame is skipped when its native read is unavailable rather than
    // published as an invented empty value.
    const todos = this.projectionSnapshotOf(live.agent.session, ['todos'])
    if (todos !== undefined && todos.todos !== undefined) {
      this.emit({ type: 'todos', sessionId: live.agent.session.id, value: this.todosSnapshotOf(todos.todos) })
    }
    this.publishPlan(live.agent.session, this.planFactOf(live.agent))
    this.publishMetrics(live.agent.session)
  }

  /**
   * Whether the exact session has no turn yet, from the native Agent registry.
   *
   * `ctx.agents.turnBoundaryOf(session)` is the owning domain read of the
   * turn-boundary projection. `true` proves a blank session, `false` proves a
   * recorded turn (or an open one), and `undefined` is unknown: an unmounted
   * registry or an unreadable fold never becomes a local "blank" or "locked"
   * claim.
   */
  private blankSessionOf(session: SessionLike): boolean | undefined {
    const agents = this.service<AgentRegistryLike>('agents')
    if (typeof agents?.turnBoundaryOf !== 'function') return undefined
    let boundary: Record<string, unknown> | undefined
    try {
      boundary = record(agents.turnBoundaryOf(session))
    } catch {
      return undefined
    }
    if (boundary === undefined) return undefined
    const open = boundary.openTurnStartSeq
    if (typeof open === 'number') return false
    const lastTurn = boundary.lastTurn
    if (typeof lastTurn !== 'number') return undefined
    if (lastTurn > 0) return false
    return open === null ? true : undefined
  }

  // --------------------------------------------------------------- commands

  async cancel(): Promise<void> {
    this.assertOpen()
    const live = this.live
    if (live === undefined) return
    const sessionId = live.agent.session.id
    this.abortActiveCommands('command cancelled', sessionId)
    live.agent.cancel({ kind: 'user' }, { keepInbox: true })
    // Only the root Agent's own decisions. A child's pending approval/question
    // belongs to the child (and to its own interruption path); settling it here
    // would answer a dialog the root interruption never showed the user.
    this.closePendingDecisions('cancelled', { agent: live.agent, sessionId })
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
    const declaration = COMMAND_DECLARATIONS_BY_NAME.get(name)
    if (declaration === undefined) throw codedError('UNSUPPORTED_COMMAND', `unsupported command: ${name}`)
    const params = record(args) ?? {}
    // Explicit-submission classification prevalidates its token before the
    // lazy Agent path runs: a malformed name must never create a durable
    // session just to be rejected.
    if (name === 'input-route' && !isNativeInputName(params.name)) {
      throw codedError('INVALID_ARGUMENT', 'input-route requires a native lower-kebab name without a slash')
    }
    if (name === 'session-rename' || name === 'session-fork') {
      const scope = this.nativeUiScope()
      if (typeof params.sessionId !== 'string' || params.sessionId === '') throw codedError('INVALID_ARGUMENT', 'an explicit sessionId is required')
      if (scope === undefined || params.sessionId !== scope.sessionId ||
          (params.attachmentId !== undefined && params.attachmentId !== scope.attachmentId)) throw codedError('STALE_SESSION', 'the explicit native session is no longer current')
      if (name === 'session-rename' && (typeof params.title !== 'string' || params.title.trim() === '')) throw codedError('INVALID_ARGUMENT', 'rename requires a non-empty title')
      if (name === 'session-fork' && params.atSeq !== undefined &&
          (typeof params.atSeq !== 'number' || !Number.isSafeInteger(params.atSeq) || params.atSeq < 0)) throw codedError('INVALID_ARGUMENT', 'fork requires a non-negative native boundary')
    }
    if (name === 'reload') return await this.reloadRuntime()
    // The single lazy-materialization gate: only a command that needs the live
    // Agent's own scope may create the pending Session's Agent. A session-less
    // or stageable declaration never does, so no read-only UI action can leave
    // a ghost session behind.
    if (declaration.sessionless !== true && declaration.stageable !== true) await this.ensureCurrent()
    switch (name) {
      case 'models': return await this.listModels()
      case 'sessions': return await this.listSessions(params)
      case 'titles': return await this.listTitles(params)
      case 'commands': return this.controlCommands()
      case 'skills': return await this.skillCatalog()
      case 'input-route': return this.inputRoute(params)
      case 'execute': return await this.executeCommand(params)
      case 'cancel': await this.cancel(); return undefined
      case 'new': return await this.switchSession('new', typeof params.preset === 'string' ? { preset: params.preset } : {}, true)
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
      case 'native-jobs': return this.nativeUiRead('native jobs', () => this.nativeInspection.jobs())
      case 'native-job-output': {
        if (typeof params.jobId !== 'string' || params.jobId === '' ||
            (params.from !== undefined && (typeof params.from !== 'number' || !Number.isSafeInteger(params.from) || params.from < 0))) {
          throw codedError('INVALID_ARGUMENT', 'native-job-output requires a jobId and a non-negative byte offset')
        }
        return this.nativeUiRead('native job output', () => this.nativeInspection.jobOutput(params.jobId as string, params.from as number | undefined))
      }
      case 'native-goal': return this.nativeUiRead('native goal', () => this.nativeInspection.goal())
      case 'native-working-directory': return this.nativeUiRead('native working directory', () => this.nativeInspection.workingDirectory())
      case 'native-inventory': return this.nativeUiRead('native plugin inventory', () => this.nativeInspection.pluginInventory())
      case 'native-tools': return this.nativeUiRead('native tool catalog', () => this.nativeInspection.toolCatalog())
      case 'native-questions': return this.nativeQuestions.read()
      case 'native-question-answer': {
        if (typeof params.callId !== 'string' || params.callId === '') throw codedError('INVALID_ARGUMENT', 'native-question-answer requires callId')
        return this.nativeQuestions.answer({ callId: params.callId, answer: params.answer })
      }
      case 'native-defaults': return this.nativeUiRead('native defaults', () => this.nativeManagement.defaultSettings())
      case 'native-default-update': {
        const target = params.target, value = params.value, expectedRevision = params.expectedRevision
        if ((target !== 'agent-preset-default' && target !== 'permission-default-preset') || typeof value !== 'string' ||
            typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 ||
            (params.attachmentId !== undefined && typeof params.attachmentId !== 'string')) throw codedError('INVALID_ARGUMENT', 'native default update requires a target, value and confirmed revision')
        // Native `settings.mutate` takes no signal: the carrier only makes the
        // in-flight write visible to the reload gate and shutdown drain. It is
        // never presented as native cancellation.
        const sessionId = this.nativeUiScope()?.sessionId ?? ''
        return await this.runActiveCommand('native default update', sessionId, async () => this.nativeManagement.updateDefault({ target, value, expectedRevision,
          ...(typeof params.attachmentId === 'string' ? { attachmentId: params.attachmentId } : {}) }))
      }
      case 'session-rename': return this.nativeManagement.renameCurrent({ sessionId: params.sessionId as string, title: params.title as string,
        ...(typeof params.attachmentId === 'string' ? { attachmentId: params.attachmentId } : {}) })
      case 'session-fork': return this.forkInteractive(params)
      default: throw codedError('UNSUPPORTED_COMMAND', `unsupported command: ${name}`)
    }
  }

  /** Native controller parity: a complete public seed + one native Agent create. */
  private async forkInteractive(params: Record<string, unknown>): Promise<SessionInfo> {
    return this.serialize(async () => {
      this.assertOpen()
      const source = this.live
      if (source === undefined) throw codedError('CAPABILITY_UNAVAILABLE', 'start a native conversation before forking its durable boundary')
      if (params.sessionId !== source.agent.session.id ||
          (params.attachmentId !== undefined && params.attachmentId !== source.attachmentId)) throw codedError('STALE_SESSION', 'the source session changed before fork')
      const header = record(source.agent.session.header)
      if (header?.origin === 'subagent' || (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0)) {
        throw codedError('CAPABILITY_UNAVAILABLE', 'interactive fork is a current-root action, not independent child recovery')
      }
      const builder = this.native?.buildForkSeed
      const seq = source.agent.session.seq
      if (builder === undefined || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1) throw codedError('CAPABILITY_UNAVAILABLE', 'the current native session has no forkable durable boundary')
      const childSessionId = randomUUID(), preset = this.currentPreset()
      const input = buildInteractiveForkInput({
        sourceSession: source.agent.session, childSessionId, atSeq: typeof params.atSeq === 'number' ? params.atSeq : seq - 1,
        buildForkSeed: builder, ...(preset === undefined ? {} : { agentPreset: preset }),
      })
      if (!input.ok) throw codedError(input.reason === 'boundary-invalid' || input.reason === 'invalid-request' ? 'INVALID_ARGUMENT' : 'RUNTIME_REQUEST_FAILED', input.message ?? 'the native fork seed is unavailable')
      const prepared = await this.prepareAgent('new', childSessionId, preset, { fork: input })
      try {
        this.assertOpen()
        if (this.live !== source) throw codedError('STALE_SESSION', 'the source attachment changed during native fork preparation')
        this.commitAgent(prepared)
      } catch (error) { await this.discardAgent(prepared); throw error }
      this.retirePendingQueries('session forked'); this.pending = undefined
      await this.closeAgent(source, 'session forked')
      const info = await this.sessionInfo(true)
      this.emitAnnouncement(info)
      return info
    })
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
    const attachments = normalizeCommandAttachments(params.attachments ?? [])
    const submitted = this.nativeFiles.commandSubmitParts(attachments)
    const requestId = randomUUID()
    const controller = new AbortController()
    let settle: () => void = () => {}
    const settled = new Promise<void>(resolve => { settle = resolve })
    this.activeCommands.set(requestId, { requestId, controller, sessionId: live.agent.session.id, settled, settle })
    try {
      let raw: unknown
      try {
        raw = await commands.execute(live.agent, line, submitted, controller.signal)
      } catch (error) {
        if (controller.signal.aborted) throw codedError('ABORTED', 'the native command was cancelled')
        // DSH owns validation/audit and can refuse a command with a bare native
        // Error. Same taxonomy as the other native seams: keep a stable code,
        // redact the diagnostic, never forward the raw object to the UI.
        throw nativeAgentFailure(`the native command ${JSON.stringify(line)} failed`, error)
      }
      const execution = record(raw)
      if (execution === undefined) {
        const commandName = line.trimStart().slice(1).split(/\s/, 1)[0]
        throw codedError('UNSUPPORTED_COMMAND', `unknown or malformed command: /${commandName}`)
      }
      const outcome = commandOutcome(execution)
      return jsonSafe({ commandId: execution.commandId, result: this.commandResult(line, execution, live.agent.session.id),
        ...(attachments.length === 0 ? {} : { attachmentOutcome: outcome?.kind ?? 'unknown' }) })
    } finally {
      this.activeCommands.delete(requestId)
      settle()
    }
  }

  /**
   * Read the current root's user-facing skill metadata from the native registry.
   *
   * This mirrors the desktop Remote: a live Agent reads the preset-isolated
   * `skills` service (falling back to the host registry) for its exact scope; a
   * pending session retains the selected preset revision through the public
   * `agentPresets.acquireScope` lease and reads without creating an Agent.
   * Tool-schema visibility is never consulted — human `/name` injection lives
   * in `agent/pre-step`, not in the model-facing tool schema. Only native name,
   * description, whenToUse and resolved invocation flags leave this method.
   *
   * @returns the projected observation; `available:false` only when no native
   *   registry can serve a metadata observation at all.
   */
  private async skillCatalog(): Promise<SkillCatalogSnapshot> {
    const live = this.live
    const pending = live === undefined ? this.pending : undefined
    if (live === undefined && pending === undefined) return unavailableSkills()
    const capturedPreset = pending?.preset
    const controller = new AbortController()
    const queryId = randomUUID()
    this.activeSkillQueries.set(queryId, {
      controller,
      sessionId: live?.agent.session.id ?? pending!.sessionId,
      attachmentId: live?.attachmentId ?? pending!.attachmentId,
      pending,
      preset: capturedPreset,
    })
    let releaseLease: (() => Promise<void>) | undefined
    try {
      if (live !== undefined) {
        const registry = this.skillRegistryFor(live.agent)
        if (registry === undefined) return unavailableSkills()
        const cwd = await this.skillCatalogCwd(live.agent, controller.signal)
        this.assertSkillQueryCurrent(controller, live, undefined, undefined)
        const snapshot = await this.readSkillMetadata(registry, {
          cwd,
          scope: live.agent,
          signal: controller.signal,
        })
        this.assertSkillQueryCurrent(controller, live, undefined, undefined)
        return snapshot
      }
      const presets = this.service<AgentPresetsLike>('agentPresets')
      if (typeof presets?.acquireScope === 'function') {
        let lease: unknown
        try {
          lease = await presets.acquireScope(capturedPreset)
        } catch (error) {
          this.assertSkillQueryCurrent(controller, undefined, pending, capturedPreset)
          throw codedError('RUNTIME_REQUEST_FAILED', `the native agent-preset scope could not be acquired: ${errorMessage(error)}`)
        }
        const normalized = normalizePresetLease(lease)
        if (normalized === undefined) {
          throw codedError('RUNTIME_REQUEST_FAILED', 'the native agent-preset scope lease returned no scope key')
        }
        // A lease acquired after close/switch is still released below.
        releaseLease = normalized.release
        this.assertSkillQueryCurrent(controller, undefined, pending, capturedPreset)
        const registry = this.hostSkillRegistry()
        if (registry === undefined) return unavailableSkills()
        const snapshot = await this.readSkillMetadata(registry, {
          cwd: this.options.cwd,
          scope: normalized.key,
          signal: controller.signal,
        })
        this.assertSkillQueryCurrent(controller, undefined, pending, capturedPreset)
        return snapshot
      }
      // No native lease API: read the mounted global registry as an explicitly
      // incomplete/global observation, never a fabricated per-preset table.
      const registry = this.hostSkillRegistry()
      if (registry === undefined) return unavailableSkills()
      const observation = await this.readSkillMetadata(registry, {
        cwd: this.options.cwd,
        signal: controller.signal,
      })
      this.assertSkillQueryCurrent(controller, undefined, pending, capturedPreset)
      return { ...observation, complete: false }
    } finally {
      this.activeSkillQueries.delete(queryId)
      if (releaseLease !== undefined) {
        try {
          await releaseLease()
        } catch (error) {
          this.warn(`the native agent-preset skill scope lease could not be released: ${errorMessage(error)}`)
        }
      }
    }
  }

  /** Read the native registry, preferring `snapshot` and its completeness fact. */
  private async readSkillMetadata(
    registry: SkillsLike,
    options: { readonly cwd?: string; readonly scope?: unknown; readonly signal: AbortSignal },
  ): Promise<SkillCatalogSnapshot> {
    let raw: unknown
    if (typeof registry.snapshot === 'function') {
      try {
        raw = await Promise.resolve(registry.snapshot(options))
      } catch (error) {
        if (options.signal.aborted) throw codedError('ABORTED', 'the skill catalog query was cancelled')
        throw codedError('RUNTIME_REQUEST_FAILED', `the native skill registry failed: ${errorMessage(error)}`)
      }
      const snapshot = skillCatalogSnapshot(raw)
      if (snapshot === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'the native skill registry returned an invalid catalog')
      return snapshot
    }
    if (typeof registry.list === 'function') {
      try {
        raw = await Promise.resolve(registry.list(options))
      } catch (error) {
        if (options.signal.aborted) throw codedError('ABORTED', 'the skill catalog query was cancelled')
        throw codedError('RUNTIME_REQUEST_FAILED', `the native skill registry failed: ${errorMessage(error)}`)
      }
      const listed = skillCatalogList(raw)
      if (listed === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'the native skill registry returned an invalid catalog')
      return listed
    }
    return unavailableSkills()
  }

  /**
   * Resolve the live registry exactly like the desktop Remote: the preset's
   * isolated `skills` service first, then the host registry. A lookup failure
   * stays visible and falls back rather than deleting the capability.
   */
  private skillRegistryFor(agent: AgentLike): SkillsLike | undefined {
    const presets = this.service<AgentPresetsLike>('agentPresets')
    if (typeof presets?.serviceFor === 'function') {
      try {
        const scoped = record(presets.serviceFor(agent, 'skills'))
        if (scoped !== undefined) {
          const registry = scoped as unknown as SkillsLike
          if (typeof registry.snapshot === 'function' || typeof registry.list === 'function') return registry
        }
      } catch (error) {
        this.warn(`DSH preset skill registry lookup failed: ${errorMessage(error)}`)
      }
    }
    return this.hostSkillRegistry()
  }

  /** The host-plane registry row; the pending lease read uses this instance. */
  private hostSkillRegistry(): SkillsLike | undefined {
    const registry = this.service<SkillsLike>('skills')
    if (registry === undefined) return undefined
    return typeof registry.snapshot === 'function' || typeof registry.list === 'function'
      ? registry
      : undefined
  }

  /**
   * Fail closed when a metadata read no longer belongs to the current
   * observation. Pending captures both the exact pending object and the preset
   * id, so staging another preset on the same object invalidates the read.
   */
  private assertSkillQueryCurrent(
    controller: AbortController,
    live: LiveAgent | undefined,
    pending: PendingSession | undefined,
    preset: string | undefined,
  ): void {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason
      if (reason instanceof Error) throw reason
      throw codedError('ABORTED', 'the skill catalog query was cancelled')
    }
    if (this.closed) throw codedError('CLOSED', 'the backend is closed')
    if (live !== undefined) {
      if (this.live !== live) {
        throw codedError('STALE_SESSION', 'the DSH Agent attachment changed during skill discovery')
      }
      return
    }
    if (this.live !== undefined || this.pending !== pending || pending?.preset !== preset) {
      throw codedError('STALE_SESSION', 'the DSH session or preset changed during skill discovery')
    }
  }

  /** Resolve the native session workspace; only a missing service falls back. */
  private async skillCatalogCwd(agent: AgentLike, signal: AbortSignal): Promise<string> {
    const workingDirectory = this.service<WorkingDirectoryLike>('workingDirectory')
    if (typeof workingDirectory?.ensure === 'function') {
      let value: unknown
      try {
        value = await Promise.resolve(workingDirectory.ensure(agent, signal))
      } catch (error) {
        if (signal.aborted) throw codedError('ABORTED', 'the skill catalog query was cancelled')
        throw codedError('RUNTIME_REQUEST_FAILED', `the native working-directory service failed: ${errorMessage(error)}`)
      }
      if (typeof value === 'string' && value.trim().length > 0) return value
      throw codedError('RUNTIME_REQUEST_FAILED', 'the native working-directory service returned no directory')
    }
    const cwd = textOf(agent.session.header?.cwd)
    return cwd ?? this.options.cwd
  }

  /** Retire pending reads before their captured pending observation disappears. */
  private retirePendingQueries(reason: string): void {
    const pending = this.pending
    if (pending !== undefined) {
      this.abortSkillQueries(reason, pending.sessionId)
      this.abortNativeUiReads(pending.sessionId)
    }
  }

  /** Abort in-flight metadata reads for close, attachment retirement or preset changes. */
  private abortSkillQueries(reason: string, sessionId?: string): number {
    let count = 0
    for (const entry of this.activeSkillQueries.values()) {
      if (sessionId !== undefined && entry.sessionId !== sessionId) continue
      if (entry.controller.signal.aborted) continue
      entry.controller.abort(codedError('ABORTED', reason))
      count += 1
    }
    return count
  }

  /**
   * Classify one explicit user-submitted `/name` line against the current Agent.
   *
   * This is a submission-time decision, not a menu/catalog read. The native
   * Agent has already been materialized by the ordinary lazy path, so its
   * agent-scoped command catalog (which a pending `commands` list cannot show)
   * is the precedence authority. Nothing is executed, sent or loaded here; the
   * caller applies the returned kind to the existing `execute`/`send`
   * primitives with the exact original line.
   *
   * @param params - `{name}`: the token after `/`, without the slash.
   * @returns the command-or-prompt decision for the exact current attachment.
   */
  private inputRoute(params: Record<string, unknown>): InputRoute {
    const live = this.live
    if (live === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
    const requested = params.name
    if (!isNativeInputName(requested)) {
      throw codedError('INVALID_ARGUMENT', 'input-route requires a native lower-kebab name without a slash')
    }
    const sessionId = live.agent.session.id
    const attachmentId = live.attachmentId
    if (this.nativeCommandResolves(live.agent, requested)) {
      return { kind: 'command', sessionId, attachmentId }
    }
    // The native `/name` pre-step injection does not require a visible `skill`
    // tool schema. Only the absence of any native skill registry keeps the
    // command error path; an unknown name is literal user input otherwise.
    if (this.skillRegistryFor(live.agent) === undefined) {
      return { kind: 'command', sessionId, attachmentId }
    }
    return { kind: 'prompt', sessionId, attachmentId }
  }

  /**
   * Exact scoped command lookup: `commands.find(agent, name)`, with a `list`
   * fallback for hosts that only mount the catalog read.
   *
   * A lookup failure cannot prove absence, so it keeps native precedence (the
   * existing execute path surfaces the native failure) instead of turning a
   * command name into a model prompt.
   */
  private nativeCommandResolves(agent: AgentLike, name: string): boolean {
    const commands = this.service<CommandsLike>('commands')
    if (commands === undefined) return false
    if (typeof commands.find === 'function') {
      try {
        const found = commands.find(agent, name)
        return found !== undefined && found !== null
      } catch (error) {
        this.warn(`DSH command lookup failed: ${errorMessage(error)}`)
        return true
      }
    }
    if (typeof commands.list === 'function') {
      try {
        return commands.list(agent).some(value => record(value)?.name === name)
      } catch (error) {
        this.warn(`DSH command catalog failed: ${errorMessage(error)}`)
        return true
      }
    }
    // A partially mounted command service is not evidence of an absent name:
    // without a readable native lookup, do not route a possible command to a model.
    return true
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

  /**
   * Run one native write inside the existing active-command registry.
   *
   * `assertReloadIdle()` and `close()` observe these carriers exactly like a
   * native command execution: an in-flight native write blocks a profile
   * recomposition and is aborted (then boundedly drained) at shutdown or when
   * its attachment is retired. Registration happens once per call and is
   * released on every exit path, success or failure.
   *
   * The carrier is adapter-owned cancellation only. A native write that takes no
   * signal (`settings.mutate`) keeps running after abort; its outcome is still
   * reported because the native side owns that fact, while an aborted stageFile
   * observes the owned signal and stops before publishing a reference.
   *
   * @param label - adapter-owned description used in coded diagnostics.
   * @param sessionId - exact attachment epoch the write belongs to (`''` when sessionless).
   * @param task - native write; receives the owned carrier signal.
   * @returns the native outcome, untouched.
   */
  private async runActiveCommand<T>(
    label: string,
    sessionId: string,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const requestId = randomUUID()
    const controller = new AbortController()
    let settle: () => void = () => {}
    const settled = new Promise<void>(resolve => { settle = resolve })
    this.activeCommands.set(requestId, { requestId, controller, sessionId, settled, settle })
    try {
      // A cancel/retire that landed before the native call started prevents it.
      if (controller.signal.aborted) throw codedError('ABORTED', label + ' was cancelled')
      return await task(controller.signal)
    } finally {
      this.activeCommands.delete(requestId)
      settle()
    }
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

  private async drainCommands(timeoutMs: number, sessionId?: string): Promise<void> {
    const pending = [...this.activeCommands.values()]
      .filter(entry => sessionId === undefined || entry.sessionId === sessionId)
      .map(entry => entry.settled)
    if (pending.length === 0) return
    try {
      await withTimeout(Promise.allSettled(pending), timeoutMs, 'native command drain')
    } catch {
      /* bounded */
    }
  }

  // ---------------------------------------------------------------- models

  /**
   * Build the model rows from the mounted native LLM registry.
   *
   * The `default` marker is one native fact and only one: the value of the
   * public default-model service (`ctx.agentDefaultModel.currentSelection()`),
   * which is what DSH reports as its deployment default. It is deliberately
   * NOT the session's current route — neither the live Agent's
   * `agent.model.current()` nor a pending/CLI route — because an explicit
   * session or `--provider/--model` selection is a different native fact and
   * does not change the default. An absent or failing default read marks no row
   * (unknown), rather than promoting the current route into a false default.
   */
  private async modelCatalog(): Promise<{ items: ModelRow[]; failures: string[]; defaultSelection: Route | undefined }> {
    const llm = this.service<LlmLike>('llm')
    if (typeof llm?.listProviders !== 'function' || typeof llm.listModels !== 'function') {
      throw codedError('CAPABILITY_UNAVAILABLE', 'the runtime mounted no LLM provider catalog (ctx.llm.listProviders/listModels)')
    }
    const defaults = this.defaultModelSelection()
    const items: ModelRow[] = []
    const failures: string[] = []
    let providers: readonly { readonly id: string; readonly name?: string }[]
    try {
      providers = llm.listProviders()
    } catch (error) {
      throw codedError('MODELS_UNAVAILABLE', `the native LLM provider registry failed: ${errorMessage(error)}`)
    }
    // Native catalogs remain native-owned. Bound concurrent reads instead of
    // serially paying every provider's deadline, then flatten in registry order
    // so completion timing cannot change grouping/defaults/failure ordering.
    const results = new Array<{ rows: ModelRow[]; failure?: string }>(providers.length)
    let nextProvider = 0
    const readProvider = async (): Promise<void> => {
      for (;;) {
        const index = nextProvider++
        if (index >= providers.length) return
        const provider = providers[index]!
        try {
          const models = await withTimeout(Promise.resolve(llm.listModels(provider.id)), 8_000, `listModels(${provider.id})`)
          const rows: ModelRow[] = []
          for (const model of models) {
            const row = modelRow(provider.id, model, defaults)
            if (row !== undefined) rows.push(row)
          }
          results[index] = { rows }
        } catch (error) {
          results[index] = { rows: [], failure: `${provider.id}: ${errorMessage(error)}` }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, providers.length) }, readProvider))
    for (const result of results) {
      items.push(...result.rows)
      if (result.failure !== undefined) failures.push(result.failure)
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
      // Captured before the native catalog/metadata reads: the exact route this
      // selection started from (an adapter pin, or the live native default).
      const previousRoute = this.pendingRoute(pending)
      const { items } = await this.modelCatalog()
      const entry = selectModelRow(items, args)
      if (entry === undefined) throw codedError('UNKNOWN_MODEL', unknownModelMessage(args))
      // The target's reasoning metadata belongs to resolveModelInfo, not the
      // list DTO. Read it only for the selected target, after selection.
      const targetReasoning = await this.effortReasoningFor(entry)
      // Same-attachment async race: another surface may have staged a pin or
      // moved the native default while the catalog was read. The obsolete
      // selection is neither pinned nor saved.
      if (this.pending !== pending || this.live !== undefined ||
          !sameRoute(this.pendingRoute(pending), previousRoute)) {
        throw codedError('STALE_SESSION', 'the Agent attachment or model route changed during model selection')
      }
      const effort = carriedEffort(targetReasoning, previousRoute?.reasoningEffort)
      const route: Route = {
        provider: String(entry.provider),
        model: String(entry.model),
        ...(typeof effort === 'string' && effort.length > 0 ? { reasoningEffort: effort } : {}),
      }
      pending.route = route
      const saved = await this.saveDefaultSelection(route)
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
    // `blank` is a native fact, not a TUI gate: a pending attachment is blank by
    // construction, a live one only when the native turn-boundary read proves
    // it. An unreadable boundary omits the field (unknown); the picker then
    // stages the selection instead of switching the running Agent.
    const blank = pending !== undefined ? true : this.isBlankSession()
    return jsonSafe({
      current: current ?? null,
      ...(blank === undefined ? {} : { blank }),
      ...(defaultId === undefined ? {} : { default: defaultId }),
      presets: (Array.isArray(roster) ? roster : []).flatMap((row) => {
        const item = record(row)
        if (item === undefined || typeof item.id !== 'string' || item.id.length === 0) return []
        // Explicit native-row DTO: only the public `AgentPreset` display fields
        // leave this adapter. A whole-row spread used to leak any extra runtime
        // property the registry row happened to carry; unknown fields are now
        // dropped by construction, exactly like skills/tools projections.
        return [{
          id: item.id,
          ...(typeof item.name === 'string' ? { name: item.name } : {}),
          ...(typeof item.description === 'string' ? { description: item.description } : {}),
          ...(typeof item.order === 'number' && Number.isFinite(item.order) ? { order: item.order } : {}),
          ...(typeof item.broken === 'string' && item.broken.length > 0 ? { broken: item.broken } : {}),
          current: item.id === current,
          ...(defaultId === item.id ? { isDefault: true } : {}),
        }]
      }),
    })
  }

  private isBlankSession(): boolean | undefined {
    const session = this.live?.agent.session
    return session === undefined ? undefined : this.blankSessionOf(session)
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
      this.abortSkillQueries('agent preset changed', pending.sessionId)
      return this.pendingInfo()
    }
    const live = this.live
    const presets = this.presetService()
    if (typeof presets?.select !== 'function') {
      throw codedError('CAPABILITY_UNAVAILABLE', 'the runtime mounted no native agent-preset selector')
    }
    // The native selector owns the blank/locked rule and decides against the
    // exact Agent it guards. This adapter neither pre-judges blankness nor
    // synthesizes a lock: it captures the Agent, resolves the id and forwards.
    const resolvedId = await this.resolvePresetId(id)
    if (this.live !== live) throw codedError('STALE_SESSION', 'the Agent attachment changed during preset selection')
    try {
      await withTimeout(Promise.resolve(presets.select(live.agent, resolvedId)), 15_000, 'agent preset selection')
    } catch (error) {
      if (record(error)?.code === 'agent-preset/locked') {
        return { id: resolvedId, current: this.currentPreset() ?? null, locked: true }
      }
      throw codedError('RUNTIME_REQUEST_FAILED', errorMessage(error))
    }
    if (this.live !== live) throw codedError('STALE_SESSION', 'the Agent attachment changed during preset selection')
    this.abortSkillQueries('agent preset changed', live.agent.session.id)
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

  /**
   * Read-only reasoning-level roster for the current route.
   *
   * A pending attachment answers from the route it already follows (its staged
   * pin or the live native default) through `agentRoute()`, so this read never
   * creates the Agent. An unknown route stays an explicit failure instead of a
   * fabricated level list.
   */
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
      const route = this.pendingRoute(pending)
      if (route === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'this session has no model route')
      const reasoning = record((await this.effortMetadata(route)).reasoning)
      if (reasoning === undefined) {
        throw codedError('RUNTIME_REQUEST_FAILED', `model route ${route.provider}/${route.model} exposes no reasoning levels`)
      }
      const efforts = Array.isArray(reasoning.efforts) ? reasoning.efforts : []
      const requested = this.requestedEffort(args.id, efforts, route)
      // Same-attachment async race: the exact route this effort choice was
      // validated against must still be the followed one.
      if (this.pending !== pending || this.live !== undefined ||
          !sameRoute(this.pendingRoute(pending), route)) {
        throw codedError('STALE_SESSION', 'the Agent attachment or model route changed during effort selection')
      }
      const pinned: Route = {
        provider: route.provider,
        model: route.model,
        ...(requested === undefined ? {} : { reasoningEffort: requested }),
      }
      pending.route = pinned
      const effective = requested ?? (typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : undefined)
      const saved = await this.saveDefaultSelection(pinned)
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
    const catalog = record(presets.catalog()) ?? {}
    if (session === undefined) {
      // A pending attachment owns no native Session, so there is no native
      // current permission value to report: the roster is the whole fact.
      // Never create an Agent (and a durable session) to answer a read-only
      // permission question; `currentValue` is simply absent, like every other
      // unknown native fact this adapter omits.
      if (this.pending === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
      return jsonSafe({ ...catalog })
    }
    return jsonSafe({ ...catalog, currentValue: presets.current(session) })
  }

  // ------------------------------------------------------------- sessions UI

  private async listSessions(args: Record<string, unknown>): Promise<unknown> {
    const query = this.service<SessionQueryLike>('sessionQuery')
    if (typeof query?.listSessions !== 'function') throw codedError('CAPABILITY_UNAVAILABLE', 'the runtime mounted no session query service')
    const limit = clampInteger(args.limit, 30, 1, 200)
    // DSH owns session order: `sessionQuery.listSessions()` returns the logical
    // corpus in deterministic newest-first order (createdAt descending, id
    // ascending for ties), live-preferred. Keep that order and the native header
    // metadata; this adapter only hides subagent children and applies the
    // caller's bound. It never stats a durable artifact, derives an activity
    // time or re-sorts, so no second durability truth exists here.
    let records: readonly unknown[]
    try {
      records = await this.durableRead('native session listing', signal => query.listSessions(signal))
    } catch (error) {
      if (backendErrorCodeOf(error) !== undefined) throw error
      throw nativeAgentFailure('the native session listing failed', error)
    }
    if (!Array.isArray(records)) {
      throw codedError('RUNTIME_REQUEST_FAILED', 'the native session listing returned no session array; the picker was not overwritten with an empty corpus')
    }
    // Identity is a native fact: a row without a usable header id is skipped
    // instead of being stringified into a fabricated `"undefined"` session that
    // the picker could never resume. Valid rows keep their native order.
    const usable: Array<{ readonly item: Record<string, unknown>; readonly id: string }> = []
    let malformed = 0
    for (const row of Array.isArray(records) ? records : []) {
      const item = record(row)
      const header = record(item?.header)
      const id = header?.id
      if (item === undefined || header === undefined || typeof id !== 'string' || id.length === 0) {
        malformed += 1
        continue
      }
      if (header.origin === 'subagent') continue
      usable.push({ item, id })
    }
    if (malformed > 0) {
      this.warn(`the native session listing returned ${malformed} row(s) without a session identity; they were skipped`)
    }
    const visible = usable.slice(0, limit)
    const titles = args.titles === false ? undefined : await this.titleFactsOf(query, visible.map(row => row.id))
    return visible.map(({ item, id }) => {
      const header = record(item.header) ?? {}
      const title = titles?.titles.get(id)
      return {
        id,
        // A known native title is a string; a fulfilled observation without a
        // folded title snapshot is the native no-title fact (`null`); an
        // unavailable read (service absent, batch failure, per-session
        // rejection) stays unknown and is omitted, exactly like SessionInfo.
        ...(title === undefined ? {} : { title }),
        cwd: typeof header.cwd === 'string' ? header.cwd : '',
        createdAt: header.createdAt,
        live: item.live === true,
      }
    })
  }

  /**
   * Fold one native batch title observation into per-session facts.
   *
   * The native result is `{sessionId,status:'fulfilled',value:{title?}}` or
   * `{sessionId,status:'rejected',reason}`. Only a fulfilled observation is a
   * fact: `value.title` absent means DSH folded no title (`null`), and a
   * fulfilled title means that exact title. A rejected row, a missing row and a
   * whole failed or unmounted batch are all *unknown*, which callers omit
   * rather than rendering as "this session has no title".
   *
   * @param query - the mounted native session query service.
   * @param ids - the session ids to observe in one call.
   * @returns the known title facts; ids absent from `titles` stay unknown.
   */
  private async titleFactsOf(query: SessionQueryLike, ids: readonly string[]): Promise<{ titles: Map<string, string | null> }> {
    const titles = new Map<string, string | null>()
    if (ids.length === 0) return { titles }
    if (typeof query.readTitleSnapshots !== 'function') return { titles }
    const requested = new Set(ids)
    let observations: unknown
    try {
      observations = await this.durableRead('native session titles', signal => query.readTitleSnapshots!(ids, signal))
    } catch (error) {
      // Host-owned diagnostics only: the UI never invents a title fact, and an
      // unavailable store must not surface as a conversation error.
      this.warn(`could not read native session titles: ${errorMessage(error)}`)
      return { titles }
    }
    for (const observation of Array.isArray(observations) ? observations : []) {
      const item = record(observation)
      if (item?.status !== 'fulfilled') continue
      const sessionId = typeof item.sessionId === 'string' ? item.sessionId : undefined
      if (sessionId === undefined || !requested.has(sessionId)) continue
      const value = record(item.value)
      if (value === undefined) continue
      const snapshot = value.title
      // `value.title` absent is the native "folded no title" fact. A present but
      // unrecognized snapshot stays unknown instead of being flattened to null.
      if (snapshot === undefined) {
        titles.set(sessionId, null)
        continue
      }
      const title = record(snapshot)?.title
      if (typeof title !== 'string') continue
      titles.set(sessionId, title.length > 0 ? title : null)
    }
    return { titles }
  }

  private async listTitles(args: Record<string, unknown>): Promise<unknown> {
    const requested = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
    const ids = [...new Set(requested)].slice(0, MAX_TITLE_IDS)
    if (ids.length === 0) return []
    const query = this.service<SessionQueryLike>('sessionQuery')
    if (query === undefined) throw codedError('CAPABILITY_UNAVAILABLE', 'the runtime mounted no session query service')
    const facts = await this.titleFactsOf(query, ids)
    // Same unknown/absent discipline as the listing: a row whose title cannot be
    // observed omits `title` instead of claiming the native no-title value.
    return ids.map((sessionId) => {
      const title = facts.titles.get(sessionId)
      return { sessionId, ...(title === undefined ? {} : { title }) }
    })
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
      if (content.some(part => part.type === 'file')) {
        throw codedError('CAPABILITY_UNAVAILABLE', 'the mounted native subagent prompt accepts text/images, not files; the reply was not sent')
      }
      if (!content.some(part => part.type !== 'text' || part.text.trim().length > 0)) {
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
  //
  // Read-only by design. DSH owns session-title composition: a provider runs
  // only while its profile Loader entry is enabled, and every public mutation
  // path persists that composition (`EntryTree.update()` reports to the owning
  // Include, which rewrites the profile; `pluginManager.setPluginEnabled()`
  // saves a profile patch). Cordis 1.1.0's bare `Entry.update()` does not
  // commit, but it mutates a live DSH entry's options outside the tree's
  // journal/reconcile path, and the Loader itself persists `disabled` when
  // such an enabled fiber unloads. No public runtime-only switch exists, so
  // this adapter reports the native state and refuses to change it: a TUI
  // display preference never rewrites another plugin's Loader entry.

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

  /** Whether the raw `disabled` flag of a live entry is set; a throwing
   * `!!js` expression means the provider is not guaranteed to run. */
  private titleEntryDisabled(entry: LoaderEntryLike): boolean {
    try {
      return entry.disabled === true
    } catch {
      return true
    }
  }

  /** Read-only native snapshot. `available` reports whether the native state
   * can be read; `editable` is always false because DSH composition owns it. */
  private autoTitleState(entries = this.titleProviderEntries()): Record<string, unknown> {
    const service = this.service<SessionTitleLike>('sessionTitle')
    const plugins = entries.map((entry) => {
      const disabled = this.titleEntryDisabled(entry)
      return {
        id: String(entry.options?.id),
        name: String(entry.options?.name),
        enabled: !disabled,
      }
    })
    const effectiveEnabled = plugins.some(plugin => plugin.enabled)
    const readable = service !== undefined && typeof service.refresh === 'function' && plugins.length > 0
    return {
      available: readable,
      editable: false,
      enabled: effectiveEnabled,
      effectiveEnabled,
      // The profile composition is the only source; this adapter holds no
      // runtime override and must never imply one.
      mode: 'inherit',
      inherited: true,
      inheritedEnabled: effectiveEnabled,
      mayIssueModelRequests: effectiveEnabled,
      plugins,
      ...(readable ? {} : {
        limitation: plugins.length === 0
          ? 'The selected DSH composition declares no native session-title provider.'
          : 'The runtime mounted no native session-title service.',
      }),
    }
  }

  private async autoTitle(args: Record<string, unknown>): Promise<unknown> {
    const hasWanted = Object.prototype.hasOwnProperty.call(args, 'enabled')
    const state = this.autoTitleState()
    if (!hasWanted) return state
    const wanted = args.enabled
    if (wanted !== null && wanted !== undefined && typeof wanted !== 'boolean') {
      throw codedError('INVALID_ARGUMENT', 'auto-title enabled must be true, false or null')
    }
    // Fail closed: there is no public DSH runtime-only switch, and writing the
    // profile composition is DSH's decision, not a TUI display preference.
    return {
      ...state,
      available: false,
      editable: false,
      changed: false,
      restartRequired: false,
      reason: AUTO_TITLE_READ_ONLY,
      limitation: typeof state.limitation === 'string' ? state.limitation : AUTO_TITLE_READ_ONLY,
      note: 'Read-only: the DSH profile composition owns session-title enablement.',
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
          files: content.filter(part => part.type === 'file').length,
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
    const messageId = typeof params.messageId === 'string' ? params.messageId : ''
    if (messageId === '') throw codedError('INVALID_ARGUMENT', 'queue-remove requires messageId')
    const agent = this.live?.agent
    if (agent === undefined) {
      // A pending attachment owns no native inbox: nothing is queued, so
      // nothing can be removed. Same answer as `dequeue` (`[]`), and no Agent
      // is created just to say the queue is empty.
      if (this.pending === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
      return { removed: false }
    }
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
    const original = recallableContent(raw) ?? []
    const content = queueReplacementContent(original, text)
    if (!content.some(part => part.type !== 'text' || part.text.trim() !== '')) {
      throw codedError('INVALID_ARGUMENT', 'queue-replace requires text or an existing attachment')
    }
    const replacement = this.asUserMessage(this.userMessageFromContent(content))
    if (!agent.inbox.replace(messageId, replacement)) throw codedError('INVALID_ARGUMENT', 'queued message is gone')
    return { messageId: replacement.id }
  }

  /**
   * Put one human message at the front of `next-turn` and wake the driver.
   *
   * `followup` is the public wake. Other recallable `next-turn` rows are
   * lifted out and appended behind it, so a running turn is cancelled with
   * the inbox kept and the rest still run later, one turn at a time.
   *
   * The promotion is transactional: it changes the native inbox (recall the
   * rest of `next-turn`, drop the replaced row, wake the driver) and
   * `followup` can refuse, so the exact pre-call inbox is captured first and
   * restored on any failure before the original rejection is rethrown. A failed
   * "send now" must leave the user's queue exactly as it was, never empty.
   */
  private async queueSendNow(params: Record<string, unknown>): Promise<{ messageId: string }> {
    await this.ensureNative()
    const agent = this.live?.agent
    if (agent === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
    const messageId = typeof params.messageId === 'string' ? params.messageId : undefined
    const text = typeof params.text === 'string' ? params.text : undefined
    const content = Array.isArray(params.content) ? params.content : undefined
    let message: UserMessageLike
    // Never remove the original before the replacement is admitted: a native
    // attachment refusal must leave the queued input intact.
    const existing = messageId === undefined ? undefined : this.findRecallable(agent, messageId)
    if (content !== undefined) {
      message = await this.admitUserMessage(normalizePromptContent(content as readonly PromptContentPart[]))
    } else if (text !== undefined) {
      if (text.trim() === '') throw codedError('INVALID_ARGUMENT', 'queue-send-now requires non-empty text')
      message = this.asUserMessage(this.userMessage(text))
    } else if (existing !== undefined) {
      message = existing
    } else {
      throw codedError('INVALID_ARGUMENT', 'queue-send-now requires text, content, or messageId')
    }
    this.promote(agent, message, existing)
    return { messageId: message.id }
  }

  /**
   * Move one message to the front of `next-turn` and wake the native driver.
   *
   * @param agent - exact live Agent whose inbox is being reordered.
   * @param message - the admitted message that must lead the next turn.
   * @param original - queued row this call replaces, when it is a different one.
   */
  private promote(agent: AgentLike, message: UserMessageLike, original?: UserMessageLike): void {
    // The two native lanes, in order: the only fact a failed wake can be
    // rolled back to. Restoring the *sequence* (not just membership) is what
    // keeps the queue exactly as the user left it.
    const before = inboxRowsOf(agent)
    try {
      const saved: UserMessageLike[] = []
      for (const item of [...agent.inbox.nextTurn]) {
        if (item.id === message.id || item.id === original?.id || !isRecallableMessage(item)) continue
        if (agent.inbox.remove(item.id)) saved.push(item)
      }
      if (original !== undefined) agent.inbox.remove(original.id)
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
    } catch (error) {
      restoreInbox(agent, before)
      throw error
    }
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
    if (!parts.some(part => part.type !== 'text' || part.text.trim().length > 0)) {
      throw codedError('INVALID_ARGUMENT', 'queue-send-now requires non-whitespace text, an image or a file')
    }
    if (parts.every(part => part.type === 'text')) {
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
    const admitted = await this.nativeFiles.admitPrompt(parts)
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

  /**
   * The adapter's own reload gate: no turn, native command, pending decision or
   * queued input may exist across a profile recomposition.
   *
   * A pending attachment is idle by construction: it owns no Agent, no native
   * command, no decision and no inbox, so every dimension is empty. Requiring a
   * live Agent here made `/reload` unusable until the first `send` for no reason
   * the documented gate states.
   */
  private assertReloadIdle(): void {
    const live = this.live
    if (live === undefined) {
      if (this.pending === undefined) throw codedError('RUNTIME_REQUEST_FAILED', 'no live session')
      if (this.activeCommands.size > 0 || this.pendingDecisions.size > 0) {
        throw codedError(
          'RUNTIME_REQUEST_FAILED',
          'wait for the current turn, queued input or native command to finish before reloading',
        )
      }
      return
    }
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
    // Recomposition can replace skill providers and the preset-scoped tool, so
    // an in-flight metadata read must not deliver a pre-reload catalog.
    this.abortSkillQueries('runtime reloaded', this.live?.agent.session.id ?? this.pending?.sessionId)
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
        // The refreshed attachment facts come from the same read the ordinary
        // attach path uses: the live Agent's SessionInfo, or the pending
        // attachment's own `pendingInfo()`.
        const info = this.live !== undefined
          ? await this.sessionInfo(false)
          : this.pending === undefined ? undefined : this.pendingInfo()
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

  /**
   * Release only what this adapter owns.
   *
   * Repeated shutdown joins the first attempt instead of returning early: the
   * promise is cached before any await, so a second `close()` cannot resolve or
   * announce `closed` while the first one is still draining native commands, a
   * turn, `sessions.flush()` or the owned Agent handle. `closed` is therefore
   * announced exactly once, after owned cleanup has actually settled.
   */
  async close(): Promise<void> {
    this.closing ??= this.disposeOwned()
    await this.closing
  }

  private async disposeOwned(): Promise<void> {
    this.closed = true
    try {
      this.abortNativeUiReads()
      this.activeNativeUiReads.clear()
      this.abortDurableReads()
      this.activeDurableReads.clear()
      this.offNativeJobs?.(); this.offNativeJobs = undefined
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
      // Metadata reads are aborted, never joined: an uncooperative provider or
      // directory scan must not extend shutdown (same policy as an image read).
      this.abortSkillQueries('backend closed')
      this.activeSkillQueries.clear()
      this.compactionCauses.clear()
      await this.switching
      this.pending = undefined
      const current = this.live
      if (current !== undefined) {
        this.live = undefined
        this.toolPresenter = undefined
        await this.closeAgent(current, 'backend closed')
      }
      // `closeAgent` settles only its own Agent's decisions; anything still
      // pending (a child's request) has no surviving answerer once this adapter
      // is gone, so shutdown settles the rest explicitly.
      this.closePendingDecisions('backend closed')
      // Note: no `appExit`, no root disposal, no process exit. The parent plugin
      // owns application shutdown; an in-flight HMR reload is intentionally not
      // awaited because recomposition may be unloading this very plugin.
      this.native = undefined
      this.codec = undefined
    } finally {
      if (!this.closedEmitted) this.emit({ type: 'closed', code: 0, signal: null })
    }
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
  if (!Array.isArray(value) || value.length === 0) throw backendError('INVALID_ARGUMENT', `${label} requires a non-empty ordered content list`)
  return normalizeNativePromptContent(value)
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

/**
 * One non-negative safe native event sequence, or `undefined`.
 *
 * DSH's own surface validator accepts exactly `Number.isSafeInteger(value) &&
 * value >= 0 && !Object.is(value, -0)`. This adapter never widens that: a
 * non-finite, non-integer, negative or negative-zero seq is not a native seq
 * and must never reach the UI as one.
 *
 * @param value - raw wire value from a native event.
 * @returns the exact native seq, or undefined when it is not one.
 */
function nativeSeq(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
    ? value
    : undefined
}

/**
 * Validate one native surface operation against the public `SurfaceOp` shape.
 *
 * `'append'` is the only string form. A replacement must be exactly the
 * positional `{op:'replace', startSeq, endSeq}` shape with two valid native
 * seqs; anything else (coerced numbers, strings, negative/unsafe values,
 * unknown ops) is **omitted**, leaving the event as its native log fact with no
 * claimed surface placement (`surfaceKind` `'none'`). A malformed placement can
 * therefore never fold a replacement, shadow an earlier fact or emit `NaN`.
 * The event itself is still forwarded: dropping a native log entry could hide
 * lifecycle facts the transcript needs, which would be a worse failure.
 *
 * @param value - raw wire value from a native event.
 * @returns the validated native operation, or undefined when malformed.
 */
function surfaceOperationOf(value: unknown): SessionEvent['surfaceOp'] | undefined {
  if (value === 'append') return 'append'
  const op = record(value)
  if (op?.op !== 'replace') return undefined
  const startSeq = nativeSeq(op.startSeq)
  const endSeq = nativeSeq(op.endSeq)
  if (startSeq === undefined || endSeq === undefined) return undefined
  return { op: 'replace', startSeq, endSeq }
}

function sessionEventWire(event: unknown, presentation: JsonRecord | undefined): SessionEvent {
  const raw = record(jsonSafe(event)) ?? {}
  const surfaceOp = surfaceOperationOf(raw.surfaceOp)
  const sourceEventSeqs = Array.isArray(raw.sourceEventSeqs)
    ? raw.sourceEventSeqs.flatMap((value): number[] => {
        const seq = nativeSeq(value)
        return seq === undefined ? [] : [seq]
      })
    : undefined
  return {
    type: typeof raw.type === 'string' ? raw.type : 'unknown',
    // `0` stays the existing missing-seq default; an invalid value is never
    // emitted as a number of its own.
    seq: nativeSeq(raw.seq) ?? 0,
    ...(typeof raw.time === 'number' && Number.isFinite(raw.time) ? { time: raw.time } : {}),
    data: raw.data,
    ...(surfaceOp === undefined ? {} : { surfaceOp }),
    ...(sourceEventSeqs === undefined ? {} : { sourceEventSeqs }),
    ...(presentation === undefined ? {} : { toolPresentation: presentation }),
  }
}

/** Create the in-process backend for one host Cordis context. */
export function createDshBackend(host: DshHostContext, options: DshContextBackendOptions): DshContextBackend {
  return new DshContextBackend(host, options)
}