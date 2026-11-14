/**
 * Native management seam: explicit current-root session rename and the safe
 * native default settings (`selectedDefault`, `defaultPreset`, and the one
 * `agent-default-model` selection: `provider`/`model`/`reasoningEffort`).
 *
 * DSH remains the owner of titles, sessions, presets, permissions and config.
 * This module is a thin, validating adapter over public services only:
 *
 * - `ctx.sessionTitle.get/rename` for the explicit user title append;
 * - `ctx.sessions.get` to prove the current root Session live;
 * - `ctx.loader.entries()` to resolve the real profile namespace ids (never a
 *   hardcoded web id) and `ctx.settings.describe/mutate` for the allowlisted
 *   volatile fields, always with the native revision fence;
 * - `ctx.agentPresets.list/defaultId` and `ctx.permissionPresets.catalog()`
 *   only as the native option authority for those two fields;
 * - injected default-model faces (`agentDefaultModel.currentSelection`, one
 *   exact-route `llm.resolveModelInfo` and the existing adapter model catalog)
 *   so this module never walks or keeps a provider catalog itself.
 *
 * It never creates, resumes, prompts or switches an Agent; never writes a file;
 * never reads a credential, an unrelated namespace or an unrelated field; and
 * keeps no store, cache, polling loop, scheduler or durable state (the bounded
 * per-operation waits below own one cleared timer each). Read-only paths
 * materialize nothing. `buildInteractiveForkInput` is the pure helper for the
 * parent's own native `/fork` flow (public `snapshotEvents` + native
 * `buildForkSeed` + native `agents.create`); this module deliberately exposes
 * no session-only `SessionStore.fork` adapter, because such a child owns no
 * Agent and no public API can attach one (native `SessionStore.prepare` rejects
 * the existing id, so pre-forking would also block the parent's own
 * `agents.create`).
 *
 * @module dsh-tui/backend/native-management
 */
import { asBackendError, backendError, redactDiagnostic } from './errors.ts'
import type { NativeUiAccess, NativeUiScope } from './native-ui-scope.ts'
import {
  carriedEffort,
  reasoningView,
  selectModelRow,
  type ModelReasoningView,
  type ModelRow,
} from './model-view.ts'

/** Why a root-scoped operation refused to run. */
export type ManagementRejectReason =
  | 'invalid-request'
  | 'no-attachment'
  | 'stale-attachment'
  | 'foreign-session'
  | 'child-session'
  | 'no-session'
  | 'session-not-live'
  | 'missing-service'
  | 'native-failed'

/**
 * The allowlisted native default-setting targets.
 *
 * `agent-default-model` is one native selection (`provider`/`model`/
 * `reasoningEffort` on the `@deepseek-ai/dsh-agent-default-model` profile
 * entry), so it is one target written by one revision-fenced
 * `settings.mutate()`: splitting it into three targets would allow an
 * intermediate provider/model pair that DSH cannot route.
 */
export type DefaultSettingTarget = 'agent-preset-default' | 'permission-default-preset' | 'agent-default-model'

/** Why one default-setting target cannot be read or written. */
export type DefaultSettingUnavailableReason =
  | 'missing-loader'
  | 'namespace-unresolved'
  | 'namespace-ambiguous'
  | 'namespace-unavailable'
  | 'field-not-volatile'
  | 'value-malformed'
  | 'options-unavailable'
  | 'write-unavailable'

/** The read as a whole can also fail before any target exists. */
export type DefaultSettingReadReason =
  | 'no-attachment'
  | 'stale-attachment'
  | 'missing-settings-service'
  | DefaultSettingUnavailableReason
  | 'read-failed'

/** One native selectable value for a default setting. */
export interface NativeDefaultOption {
  /** Exact native id written to Settings. */
  readonly id: string
  /** Native display label, when the native roster supplies one. */
  readonly label?: string
  /** Native one-line description, when supplied. */
  readonly description?: string
}

/** One allowlisted default setting, projected from the native descriptor. */
export interface NativeDefaultSettingView {
  readonly target: DefaultSettingTarget
  /**
   * Display name of the allowlisted native field(s): `selectedDefault`,
   * `defaultPreset`, or the ordered `provider,model,reasoningEffort` list of
   * the default-model target. Derived from that target's one allowlisted path
   * list, so it can never disagree with what is actually read or written.
   */
  readonly field: string
  /** True only when the descriptor and the allowlisted field were isolated. */
  readonly available: boolean
  /** True only when the native write path and the native option list are usable. */
  readonly writable: boolean
  /** Resolved profile entry id (the native settings namespace). */
  readonly namespace?: string
  /** Exact native field value; absent when the field is unset. */
  readonly value?: string
  /** Native resolver fallback when the field is unset (never a TUI guess). */
  readonly effectiveValue?: string
  /** Native revision fence for an explicit write. */
  readonly revision?: number
  /** Native selectable ids in native order. */
  readonly options: readonly NativeDefaultOption[]
  readonly reason?: DefaultSettingUnavailableReason
  /** One redacted sentence explaining an unavailable/read-only target. */
  readonly limitation?: string

  // -- `agent-default-model` only -----------------------------------------
  /** Persisted native provider of the default selection. */
  readonly provider?: string
  /** Persisted native model id of the default selection. */
  readonly model?: string
  /** Persisted reasoning level; absent means the native default applies. */
  readonly reasoningEffort?: string
  /** Adapter-advertised default level; never promoted into an explicit selection. */
  readonly defaultReasoningEffort?: string
  /** Level DSH will apply when no explicit level is stored, or the stored one when advertised. */
  readonly effectiveReasoningEffort?: string
  /**
   * True only when the mounted metadata resolver answered for the exact default
   * pair. `false` disables the effort choice but never the model row: the native
   * Settings write itself stays available so a broken saved pair can be repaired.
   */
  readonly reasoningAvailable?: boolean
  /** True only when that exact pair advertises at least one reasoning level. */
  readonly reasoningSupported?: boolean
  /** Advertised levels of the default pair, in native order (empty when unsupported). */
  readonly reasoningEfforts?: readonly NativeDefaultOption[]
}

/** Every allowlisted target, resolved on every read. */
export interface NativeDefaultSettingsRead {
  readonly available: boolean
  readonly targets: readonly NativeDefaultSettingView[]
  readonly reason?: DefaultSettingReadReason
  readonly limitation?: string
}

/** Explicit, confirmed default-setting write request. */
export interface NativeDefaultSettingUpdateRequest {
  readonly target: DefaultSettingTarget
  /**
   * Exact native id from the target's `options` (never a free-form value).
   *
   * For `agent-default-model` this is either the persisted provider/model
   * tuple (an effort-only edit) or one native model row id resolved by the
   * mounted catalog (`command('models')` grammar).
   */
  readonly value: string
  /** Revision returned by the confirmed read; required, never a wildcard. */
  readonly expectedRevision: number
  /** Optional exact-attachment fence captured with the read. */
  readonly attachmentId?: string
  /**
   * `agent-default-model` only: a native level id to store, or `null` to remove
   * the stored level so the native model/adapter default applies. Omitted keeps
   * the stored level when the target still advertises it.
   */
  readonly reasoningEffort?: string | null
}

/** Outcome of one explicit default-setting write. */
export type NativeDefaultSettingOutcome =
  | {
      ok: true
      target: DefaultSettingTarget
      namespace: string
      field: string
      /** Read-back native value after the accepted write. */
      value: string
      revision: number
      /** True only when the read-back value equals the requested value. */
      changed: boolean
      /** True when the confirmed choice was already the persisted selection. */
      unchanged?: boolean
      attachmentId?: string
      /** False when the attachment moved while the native write was in flight. */
      stillCurrent: boolean
      /** `agent-default-model`: native read-back provider/model/level. */
      provider?: string
      model?: string
      reasoningEffort?: string
      /** `agent-default-model`: an unsupported stored level was removed by this write. */
      reasoningEffortReset?: boolean
    }
  | {
      ok: false
      target: DefaultSettingTarget
      reason: 'invalid-request' | 'stale-attachment' | 'unavailable' | 'not-an-option' | 'conflict' | 'write-failed'
      message?: string
      expectedRevision?: number
      actualRevision?: number
      /** Fresh native view after a conflict or failure, when it could be re-read. */
      current?: NativeDefaultSettingView
    }

/** Explicit rename of the current root Session. */
export interface SessionRenameRequest {
  readonly sessionId: string
  readonly attachmentId?: string
  /** Raw user text; DSH normalizes and rejects an empty result. */
  readonly title: string
}

export type SessionRenameOutcome =
  | {
      ok: true
      sessionId: string
      attachmentId?: string
      /** Accepted (normalized) title. */
      title: string
      /** Durable `session/title` event seq. */
      seq: number
      source: 'user'
      /** Previous folded title; `null` means the native no-title fact, absent means unknown. */
      previousTitle?: string | null
      /** False when the attachment moved after the append committed. */
      stillCurrent: boolean
    }
  | {
      ok: false
      reason: ManagementRejectReason | 'title-invalid' | 'rename-failed'
      message?: string
    }

/** Service-level capability report; the per-call gate still applies. */
export interface NativeManagementCapabilities {
  readonly rename: boolean
  readonly defaultSettingsRead: boolean
  readonly defaultSettingsWrite: boolean
  readonly targets: readonly DefaultSettingTarget[]
}

/**
 * Exact-route reasoning metadata probe result.
 *
 * `available:false` means the metadata could not be read at all (no resolver,
 * failure or deadline); it is never flattened into "this model has no levels".
 */
export type NativeReasoningProbe =
  | { readonly available: true; readonly reasoning?: ModelReasoningView }
  | { readonly available: false; readonly limitation: string }

/**
 * Native model/configuration faces used only by the default-model target.
 *
 * They are injected by the owning backend adapter so this module never walks a
 * provider catalog, keeps one, or talks to an LLM itself. Every face is optional
 * so a partial composition stays loadable: an absent metadata face makes the
 * reasoning decision unknowable (an explicit level is then refused and a
 * stored level is removed by the model switch's native `unset`, while a proven
 * native Settings write stays usable so a stale default can be repaired), and
 * an absent selection face simply skips the runtime consistency check.
 */
export interface NativeDefaultModelFaces {
  /** Public `ctx.agentDefaultModel.currentSelection()` getter. */
  currentSelection?(): unknown
  /** `ctx.llm.resolveModelInfo(provider, model, signal).reasoning`, one exact route. */
  resolveReasoning?(provider: string, model: string, signal: AbortSignal): Promise<unknown>
  /** Fresh native model rows plus isolated provider failures; a model change only. */
  modelCatalog?(): Promise<{ readonly items: readonly ModelRow[]; readonly failures: readonly string[] }>
}

/** Construction options (the shared seam is injected, never modified). */
export interface NativeManagementOptions {
  readonly access: NativeUiAccess
  /** Redacted diagnostic sink; defaults to the access `warn` hook. */
  readonly warn?: (message: string) => void
  /** Native default-model faces; absent means the target stays read-only/unavailable. */
  readonly native?: NativeDefaultModelFaces
}

/** Public `buildForkSeed` signature from `@deepseek-ai/dsh-session`. */
export type NativeBuildForkSeed = (events: readonly unknown[], boundary: number) => readonly unknown[]

/** Pure preparation input for the parent's native-controller-parity fork. */
export interface InteractiveForkInputRequest {
  /** Exact native live source Session object. */
  readonly sourceSession: unknown
  /** Caller-minted child session id (the parent owns id policy). */
  readonly childSessionId: string
  /** Explicit inclusive cut chosen by the parent (never a TUI default). */
  readonly atSeq: number
  /** Injected public `buildForkSeed` from the installed `@deepseek-ai/dsh-session`. */
  readonly buildForkSeed: NativeBuildForkSeed
  /** Native preset identity the parent's composition resolved for the child. */
  readonly agentPreset?: string
  /** Working directory override; omitted falls back to the source header `cwd`. */
  readonly cwd?: string
}

export type InteractiveForkInputOutcome =
  | {
      ok: true
      sessionId: string
      sourceSessionId: string
      boundary: number
      inheritedEventCount: number
      /** Exact seed built by the supplied public `buildForkSeed`. */
      seed: readonly unknown[]
      /** Native creation metadata for `agents.create` (no hand-written lineage). */
      meta: { cwd?: string; isSeeded: true; agentPreset?: string }
    }
  | {
      ok: false
      reason: 'invalid-request' | 'event-log-unavailable' | 'boundary-invalid' | 'seed-invalid'
      message?: string
    }

/**
 * The `agent-default-model` native paths of the one selection it persists.
 *
 * They are named once and reused by the allowlist above, the write ops and the
 * schema diagnostics, so a path can never be written but not checked (or the
 * reverse).
 */
const MODEL_PROVIDER_PATH = 'provider'
const MODEL_PATH = 'model'
const MODEL_EFFORT_PATH = 'reasoningEffort'

interface TargetSpec {
  readonly target: DefaultSettingTarget
  readonly packageName: string
  /**
   * The single allowlist representation: exact native config paths of this
   * target, in write order. Schema membership, the read/write path and the
   * public DTO label all derive from this one list.
   */
  readonly fields: readonly string[]
}

const TARGETS: readonly TargetSpec[] = [
  {
    target: 'agent-preset-default',
    packageName: '@deepseek-ai/dsh-agent-preset-registry',
    fields: ['selectedDefault'],
  },
  {
    target: 'permission-default-preset',
    packageName: '@deepseek-ai/dsh-permission-presets',
    fields: ['defaultPreset'],
  },
  {
    target: 'agent-default-model',
    packageName: '@deepseek-ai/dsh-agent-default-model',
    fields: [MODEL_PROVIDER_PATH, MODEL_PATH, MODEL_EFFORT_PATH],
  },
]

/**
 * Public DTO label of one target: its allowlisted native paths in write order.
 *
 * Kept derived (never stored twice) so the allowlist cannot disagree with what
 * the UI and `NativeDefaultSettingView.field` already report.
 */
function fieldLabel(spec: TargetSpec): string {
  return spec.fields.join(',')
}

/**
 * The exact native config path of a single-field target.
 *
 * The multi-field default-model target has its own write path; reaching this
 * with more than one allowlisted path would mean writing a comma list as one
 * key, so it fails closed instead.
 */
function singleFieldPath(spec: TargetSpec): string {
  const field = spec.fields[0]
  if (field === undefined || spec.fields.length !== 1) {
    throw backendError('INVALID_ARGUMENT', `the "${spec.target}" target writes more than one native config path`)
  }
  return field
}

/**
 * Bound for one exact-route reasoning metadata read (one phase of a read/write).
 *
 * Relationship to `nativeUiRead` (`NATIVE_UI_READ_TIMEOUT_MS`, 8 s in
 * `context.ts`, the only outer wall-clock bound): the read face runs *inside*
 * it, so a shorter inner bound lets this phase answer `available:false` with
 * its own diagnostic instead of being abandoned as one opaque read timeout. It
 * is a bound on this wait only (an adapter may ignore the passed signal); it is
 * never a native service deadline and never a retry.
 */
const DEFAULT_REASONING_TIMEOUT_MS = 4_000
/**
 * Bound for the fresh native model catalog read of one explicit model change.
 *
 * The default-setting *write* is an active command, not a `nativeUiRead`, so
 * this phase has no outer deadline of its own: this is the only wall-clock
 * bound on it. It uses the same 8 s order as `NATIVE_UI_READ_TIMEOUT_MS` so the
 * write cannot outlive the bound the equivalent native read would get, and the
 * caller still never continues to a mutation after it expires.
 */
const DEFAULT_MODEL_CATALOG_TIMEOUT_MS = 8_000
/**
 * Bound for one async native agent-preset roster read (write preparation); same
 * 8 s `nativeUiRead` order and the same "expire ⇒ no mutation" rule as the
 * catalog phase above.
 */
const DEFAULT_PRESET_ROSTER_TIMEOUT_MS = 8_000
/** Longest one-line native catalog failure detail carried by one refusal. */
const MODEL_CATALOG_FAILURE_MAX_CHARS = 400
/** A signal that never aborts, for internal callers without a carrier. */
const NEVER_ABORTED = new AbortController().signal

/** What one default-model write does to the stored reasoning level. */
type EffortPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'set'; readonly id: string }
  | { readonly kind: 'unset' }

interface SessionTitleLike {
  get?(session: unknown): unknown
  rename?(session: unknown, title: string): unknown
}

interface SettingsLike {
  describe?(options?: { readonly redactSecrets?: boolean }): unknown
  mutate?(namespace: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<unknown>
}

type SettingsPathOp =
  | {
      readonly op: 'set'
      readonly path: readonly string[]
      readonly value: unknown
    }
  | {
      readonly op: 'unset'
      readonly path: readonly string[]
    }

interface LoaderLike {
  entries?(): Iterable<unknown>
}

interface SessionsLike {
  get?(id: string): unknown
}

interface AgentPresetsLike {
  readonly defaultId?: unknown
  list?(): Promise<unknown>
}

interface PermissionPresetsLike {
  catalog?(): unknown
}

interface SessionIdentity {
  readonly source: unknown
  readonly id: string
  readonly header: {
    readonly origin?: string
    readonly delegationDepth?: number
    readonly cwd?: string
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Non-negative safe integer, or undefined. */
function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** Redacted one-line diagnostic; never serializes a native object or stack. */
function diagnostic(error: unknown): string {
  return asBackendError(error).message
}

/**
 * One redacted, single-line summary of the native catalog's isolated provider
 * failures, or undefined when there is nothing to report.
 *
 * The mounted catalog already redacts each provider error; this still bounds
 * the text (a native message may be multi-line or arbitrarily long) and re-runs
 * the adapter redaction, so one refusal can never echo a credential or a stack.
 */
function catalogFailureText(failures: readonly string[]): string | undefined {
  const parts: string[] = []
  for (const failure of failures) {
    const text = redactDiagnostic(failure).replace(/\s+/g, ' ').trim()
    if (text.length > 0) parts.push(text)
  }
  if (parts.length === 0) return undefined
  const joined = parts.join('; ')
  return joined.length > MODEL_CATALOG_FAILURE_MAX_CHARS
    ? `${joined.slice(0, MODEL_CATALOG_FAILURE_MAX_CHARS)}…`
    : joined
}

/** Adapter-owned cancellation reason for the exact carrier signal. */
function cancellationError(signal: AbortSignal, label: string): Error {
  const reason = signal.reason
  return reason instanceof Error ? reason : backendError('ABORTED', `${label} was cancelled`)
}

/**
 * Bound one native metadata/catalog phase of a default-setting operation.
 *
 * The public LLM reads accept an optional `AbortSignal` and this adapter passes
 * it, but an adapter may ignore it, so the bound only ends *this* wait. The
 * caller never continues to a later write after a deadline or cancellation,
 * which is what keeps a timed-out read from becoming a late mutation. No timer
 * outlives the race, and nothing is scheduled in the background.
 */
async function bounded<T>(promise: Promise<T>, ms: number, label: string, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // The caller had to create the native read before invoking `bounded`, so a
    // pre-cancelled operation still owns that promise. Observe its eventual
    // rejection before returning; otherwise a late native failure becomes an
    // unhandled rejection (which this app treats as fatal), even though the
    // operation was already cancelled.
    void promise.catch(() => {})
    throw cancellationError(signal, label)
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(backendError('RUNTIME_REQUEST_FAILED', `${label} timed out after ${ms}ms`)), ms)
        timer.unref?.()
        onAbort = () => reject(cancellationError(signal, label))
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/** One persisted native default-model selection, read without guessing. */
interface DefaultModelSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Read `{provider, model, reasoningEffort?}` from a native selection value. */
function readDefaultSelection(value: unknown): DefaultModelSelection | undefined {
  const item = record(value)
  if (item === undefined) return undefined
  const provider = nonEmpty(item.provider)
  const model = nonEmpty(item.model)
  if (provider === undefined || model === undefined) return undefined
  const reasoningEffort = nonEmpty(item.reasoningEffort)
  return {
    provider,
    model,
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

/** The UI correlation key for one native provider/model pair. */
function pairKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** Exact equality of the three native selection facts. */
function sameSelection(left: DefaultModelSelection, right: DefaultModelSelection): boolean {
  return left.provider === right.provider && left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort
}

function readSessionIdentity(value: unknown): SessionIdentity | undefined {
  const item = record(value)
  if (item === undefined) return undefined
  let id: string | undefined
  let headerValue: unknown
  try {
    id = nonEmpty(item.id)
    headerValue = item.header
  } catch {
    return undefined
  }
  if (id === undefined) return undefined
  const header = record(headerValue) ?? {}
  const read = (key: string): unknown => {
    try {
      return header[key]
    } catch {
      return undefined
    }
  }
  const origin = read('origin')
  const delegationDepth = read('delegationDepth')
  const cwd = read('cwd')
  return {
    source: value,
    id,
    header: {
      ...(typeof origin === 'string' ? { origin } : {}),
      ...(typeof delegationDepth === 'number' ? { delegationDepth } : {}),
      ...(typeof cwd === 'string' ? { cwd } : {}),
    },
  }
}

/** A native Session is a subagent child only by its documented header facts. */
function isChildSession(identity: SessionIdentity): boolean {
  return identity.header.origin === 'subagent'
    || (typeof identity.header.delegationDepth === 'number' && identity.header.delegationDepth > 0)
}

interface TitleSnapshot {
  readonly title: string
  readonly eventSeq: number
}

function readTitleSnapshot(value: unknown): TitleSnapshot | undefined {
  const item = record(value)
  if (item === undefined) return undefined
  const title = typeof item.title === 'string' ? item.title : undefined
  const eventSeq = integer(item.eventSeq)
  if (title === undefined || eventSeq === undefined) return undefined
  return { title, eventSeq }
}

function readDefaultOption(value: unknown): NativeDefaultOption | undefined {
  const item = record(value)
  if (item === undefined) return undefined
  const id = nonEmpty(item.id)
  if (id === undefined) return undefined
  const label = typeof item.label === 'string' && item.label.length > 0 ? item.label : undefined
  const description = typeof item.description === 'string' && item.description.length > 0
    ? item.description
    : undefined
  return { id, ...(label === undefined ? {} : { label }), ...(description === undefined ? {} : { description }) }
}

/** Schemastery's reference form: `{ uid, refs: { "<uid>": node } }`. */
function schemaNode(refs: Record<string, unknown>, value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'number') return record(refs[String(value)])
  if (typeof value === 'string' && /^\d+$/.test(value)) return record(refs[value])
  return record(value)
}

/**
 * Whether the native descriptor form declares the allowlisted top-level field.
 *
 * `SettingsForms.describe()` returns `schema: volatileForm(schema).toJSON()`.
 * `volatileForm` includes a field only when the field itself (or its nearest
 * ancestor) is natively `volatile`, and `plainSchema` then **deletes**
 * `meta.volatile` from that client-facing form. Membership in the form's root
 * object `dict` is therefore the native volatility projection; the surviving
 * `meta.volatile` flag is also accepted when a composition keeps it.
 *
 * Verified against the real installed `0.2.2-rc.1` descriptor shape:
 * `{ uid, refs: { "<rootUid>": { type:"object", meta:{…}, dict:{ <field>: <ref> } },
 * "<ref>": { type:"string", meta:{} } } }` with the field possibly unset in
 * `value`/`user`. A missing/unresolvable field or a non-schema node fails
 * closed; `settings.mutate()` still validates `isVolatilePath` and remains the
 * final write authority.
 */
function schemaDeclaresField(schema: unknown, field: string): boolean {
  const root = record(schema)
  if (root === undefined) return false
  const refs = record(root.refs)
  const objectNode = refs === undefined ? root : (schemaNode(refs, root.uid) ?? root)
  if (objectNode === undefined) return false
  const dict = record(objectNode.dict)
  if (dict === undefined || !Object.hasOwn(dict, field)) return false
  const child = refs === undefined ? record(dict[field]) : schemaNode(refs, dict[field])
  if (child === undefined || typeof child.type !== 'string') return false
  const meta = record(child.meta)
  // `plainSchema` strips the marker from this client-facing form, so an absent
  // marker is the expected native shape; an explicit `volatile: false` is
  // refused rather than silently accepted.
  return meta === undefined || meta.volatile !== false
}

function defaultTarget(value: unknown): TargetSpec | undefined {
  return TARGETS.find((spec) => spec.target === value)
}

interface NamespaceResolution {
  readonly spec: TargetSpec
  readonly namespace?: string
  readonly reason?: DefaultSettingUnavailableReason
}

function readLoaderEntries(loader: LoaderLike): readonly unknown[] | undefined {
  if (typeof loader.entries !== 'function') return undefined
  try {
    const entries = loader.entries()
    if (entries === undefined || entries === null || typeof entries[Symbol.iterator] !== 'function') return undefined
    return [...entries]
  } catch {
    return undefined
  }
}

interface CapturedScope {
  readonly scope: NativeUiScope
}

type RootGate =
  | { readonly ok: true; readonly captured: CapturedScope; readonly identity: SessionIdentity }
  | { readonly ok: false; readonly reason: ManagementRejectReason; readonly message: string }

/**
 * Prepare the exact native inputs for the parent's approved interactive fork.
 *
 * This is pure: it enumerates the source's **complete** public event log with
 * `session.snapshotEvents()` (never a truncated tail; the log must start at
 * seq 0 and be contiguous), validates the explicit inclusive cut, then calls
 * the injected public `buildForkSeed(events, boundary)` from
 * `@deepseek-ai/dsh-session`. It does not create/resume an Agent, choose a
 * preset, copy a seed by hand, fold headers or write anything. The parent owns
 * `ctx.agents.create` with the returned `seed`/`inheritedEventCount`/`meta`,
 * its preset setup and the explicit switch.
 *
 * @param request - native source, caller-minted child id, explicit cut and injected seed builder.
 * @returns exact create inputs, or a typed refusal with nothing changed.
 */
export function buildInteractiveForkInput(request: InteractiveForkInputRequest): InteractiveForkInputOutcome {
  const item = record(request)
  if (item === undefined) return { ok: false, reason: 'invalid-request', message: 'fork preparation requires one request object' }
  const source = readSessionIdentity(item.sourceSession)
  if (source === undefined) return { ok: false, reason: 'invalid-request', message: 'sourceSession is not a native Session' }
  const childSessionId = nonEmpty(item.childSessionId)
  if (childSessionId === undefined) return { ok: false, reason: 'invalid-request', message: 'childSessionId must be a non-empty string' }
  const buildForkSeed = item.buildForkSeed
  if (typeof buildForkSeed !== 'function') return { ok: false, reason: 'invalid-request', message: 'buildForkSeed must be the public native function' }
  const atSeq = integer(item.atSeq)
  if (atSeq === undefined) return { ok: false, reason: 'invalid-request', message: 'atSeq must be a non-negative safe integer' }
  if (item.agentPreset !== undefined && nonEmpty(item.agentPreset) === undefined) {
    return { ok: false, reason: 'invalid-request', message: 'agentPreset must be a non-empty string when supplied' }
  }
  if (item.cwd !== undefined && nonEmpty(item.cwd) === undefined) {
    return { ok: false, reason: 'invalid-request', message: 'cwd must be a non-empty string when supplied' }
  }
  const sourceItem = record(item.sourceSession)
  const snapshotEvents = sourceItem?.snapshotEvents
  if (typeof snapshotEvents !== 'function') {
    return { ok: false, reason: 'event-log-unavailable', message: 'the native Session exposes no complete event snapshot' }
  }
  let snapshot: unknown
  try {
    snapshot = snapshotEvents.call(sourceItem)
  } catch (error) {
    return { ok: false, reason: 'event-log-unavailable', message: diagnostic(error) }
  }
  if (!Array.isArray(snapshot)) {
    return { ok: false, reason: 'event-log-unavailable', message: 'the native Session exposes no complete event snapshot' }
  }
  const events: readonly unknown[] = snapshot
  for (let index = 0; index < events.length; index += 1) {
    const event = record(events[index])
    if (event === undefined || event.seq !== index) {
      return {
        ok: false,
        reason: 'event-log-unavailable',
        message: index === 0
          ? 'the native events do not start at seq 0 (a truncated tail cannot be forked)'
          : `the native event log is not contiguous at seq ${index}`,
      }
    }
  }
  if (atSeq >= events.length) {
    return { ok: false, reason: 'boundary-invalid', message: `seq ${atSeq} does not exist in the source log` }
  }
  let seedValue: unknown
  try {
    seedValue = (buildForkSeed as NativeBuildForkSeed)(events, atSeq)
  } catch (error) {
    return { ok: false, reason: 'seed-invalid', message: diagnostic(error) }
  }
  if (!Array.isArray(seedValue) || seedValue.length <= atSeq + 1) {
    return {
      ok: false,
      reason: 'seed-invalid',
      message: 'buildForkSeed did not return the inclusive prefix followed by its inherited marker',
    }
  }
  const seed: readonly unknown[] = seedValue
  for (let index = 0; index <= atSeq; index += 1) {
    if (seed[index] !== events[index]) {
      return { ok: false, reason: 'seed-invalid', message: `buildForkSeed did not preserve source event ${index}` }
    }
  }
  const cwd = nonEmpty(item.cwd) ?? source.header.cwd
  const agentPreset = nonEmpty(item.agentPreset)
  return {
    ok: true,
    sessionId: childSessionId,
    sourceSessionId: source.id,
    boundary: atSeq,
    inheritedEventCount: atSeq + 1,
    seed,
    meta: {
      ...(cwd === undefined ? {} : { cwd }),
      isSeeded: true,
      ...(agentPreset === undefined ? {} : { agentPreset }),
    },
  }
}

/**
 * Validated direct adapter for rename/default settings.
 *
 * Every method re-validates the exact supplied attachment identity and reads
 * live native services on each call; nothing is cached and nothing is polled.
 */
export class NativeManagement {
  private readonly access: NativeUiAccess
  private readonly warn: (message: string) => void
  private readonly faces: NativeDefaultModelFaces

  constructor(options: NativeManagementOptions) {
    const access = options?.access
    if (access === undefined || access === null || typeof access !== 'object') {
      throw backendError('INVALID_OPTIONS', 'NativeManagement requires the supplied NativeUiAccess seam')
    }
    this.access = access
    this.faces = options.native ?? {}
    this.warn = typeof options.warn === 'function'
      ? options.warn
      : (message: string): void => {
          try {
            if (typeof access.warn === 'function') access.warn(message)
          } catch {
            /* a diagnostic sink failure never changes an outcome */
          }
        }
  }

  /** Service-level capability report; absent services are never advertised. */
  capabilities(): NativeManagementCapabilities {
    const title = this.service<SessionTitleLike>('sessionTitle')
    const settings = this.service<SettingsLike>('settings')
    const loader = this.service<LoaderLike>('loader')
    const defaultSettingsRead = typeof settings?.describe === 'function' && typeof loader?.entries === 'function'
    const targets = defaultSettingsRead
      ? this.resolveNamespaces(loader).flatMap((resolution) => resolution.namespace === undefined ? [] : [resolution.spec.target])
      : []
    return {
      rename: typeof title?.rename === 'function',
      defaultSettingsRead,
      defaultSettingsWrite: defaultSettingsRead && typeof settings?.mutate === 'function',
      targets,
    }
  }

  /** Read both allowlisted native defaults; never touches another namespace. */
  async defaultSettings(signal: AbortSignal = NEVER_ABORTED): Promise<NativeDefaultSettingsRead> {
    const captured = this.captureScope()
    if (captured === undefined) {
      return { available: false, targets: [], reason: 'no-attachment', limitation: 'no current DSH attachment' }
    }
    const settings = this.service<SettingsLike>('settings')
    if (typeof settings?.describe !== 'function') {
      return {
        available: false,
        targets: [],
        reason: 'missing-settings-service',
        limitation: 'DSH mounts no settings service in this profile',
      }
    }
    const loader = this.service<LoaderLike>('loader')
    if (typeof loader?.entries !== 'function') {
      return {
        available: false,
        targets: this.unresolvedTargets('missing-loader'),
        reason: 'missing-loader',
        limitation: 'the DSH Loader tree is not readable, so no settings namespace can be proven',
      }
    }
    const resolutions = this.resolveNamespaces(loader)
    const descriptors = this.describeNow(settings)
    if (descriptors === undefined) {
      return {
        available: false,
        targets: this.unresolvedTargets('namespace-unavailable'),
        reason: 'read-failed',
        limitation: 'the native settings descriptor could not be read',
      }
    }
    const writablePath = typeof settings.mutate === 'function'
    const views = await Promise.all(
      resolutions.map(async (resolution) => await this.attachOptions(this.projectTarget(resolution, descriptors, writablePath), signal)),
    )
    if (signal.aborted) throw cancellationError(signal, 'native defaults read')
    if (!this.stillCurrent(captured)) {
      return {
        available: false,
        targets: [],
        reason: 'stale-attachment',
        limitation: 'the attachment changed while the native settings were read',
      }
    }
    const available = views.some((view) => view.available)
    const firstFailure = views.find((view) => !view.available)
    return {
      available,
      targets: views,
      ...(available ? {} : { reason: firstFailure?.reason ?? 'read-failed' }),
      ...(available ? {} : { limitation: firstFailure?.limitation ?? 'no allowlisted native default is readable' }),
    }
  }

  /**
   * Explicit confirmed write of one allowlisted default field.
   *
   * Uses `settings.mutate(ns, [{op:'set', path:[field], value}], expectedRevision)`
   * only: exact path, native revision fence, unrelated settings preserved.
   */
  async updateDefault(request: NativeDefaultSettingUpdateRequest, signal: AbortSignal = NEVER_ABORTED): Promise<NativeDefaultSettingOutcome> {
    const spec = defaultTarget(record(request)?.target)
    if (spec === undefined) throw backendError('INVALID_ARGUMENT', 'unknown native default-setting target')
    const value = nonEmpty(request.value)
    if (value === undefined) throw backendError('INVALID_ARGUMENT', 'a default-setting write requires a non-empty native option id')
    const expectedRevision = integer(request.expectedRevision)
    if (expectedRevision === undefined) {
      throw backendError('INVALID_ARGUMENT', 'a default-setting write requires the confirmed native revision')
    }
    if (request.attachmentId !== undefined && nonEmpty(request.attachmentId) === undefined) {
      throw backendError('INVALID_ARGUMENT', 'attachmentId must be a non-empty string when supplied')
    }
    const target = spec.target
    const captured = this.captureScope(request.attachmentId)
    if (captured === undefined) {
      return { ok: false, target, reason: 'stale-attachment', message: 'the attachment is not current' }
    }
    const settings = this.service<SettingsLike>('settings')
    if (typeof settings?.describe !== 'function' || typeof settings.mutate !== 'function') {
      return { ok: false, target, reason: 'unavailable', message: 'the native settings write path is not mounted' }
    }
    const loader = this.service<LoaderLike>('loader')
    if (typeof loader?.entries !== 'function') {
      return { ok: false, target, reason: 'unavailable', message: 'the DSH Loader tree is not readable' }
    }
    const resolution = this.resolveNamespaces(loader).find((candidate) => candidate.spec.target === target)
    if (resolution === undefined || resolution.namespace === undefined) {
      return {
        ok: false,
        target,
        reason: 'unavailable',
        message: resolution?.reason === 'namespace-ambiguous'
          ? 'more than one profile entry declares this plugin, so the owner namespace cannot be chosen safely'
          : 'the native settings namespace for this target is not mounted in this profile',
      }
    }
    const descriptors = this.describeNow(settings)
    if (descriptors === undefined) {
      return { ok: false, target, reason: 'unavailable', message: 'the native settings descriptor could not be read' }
    }
    const current = this.projectTarget(resolution, descriptors, true)
    if (!current.available || current.revision === undefined) {
      return {
        ok: false,
        target,
        reason: 'unavailable',
        message: current.limitation ?? 'the allowlisted native field is not readable',
        current,
      }
    }
    if (target === 'agent-default-model') {
      return await this.updateDefaultModel({
        captured,
        settings,
        namespace: resolution.namespace,
        resolution,
        current,
        value,
        expectedRevision,
        request,
        signal,
      })
    }
    const withOptions = await this.attachOptions(current, signal)
    // The native settings write has no AbortSignal of its own. This final fence
    // is the only thing that prevents a roster read completed after Esc/close
    // from becoming a late mutation; the model target has the same recheck.
    if (signal.aborted) throw cancellationError(signal, 'native default update')
    if (!this.stillCurrent(captured)) {
      return { ok: false, target, reason: 'stale-attachment', message: 'the attachment changed while the write was prepared', current: withOptions }
    }
    // The roster read is asynchronous. Re-prove that the profile owner is still
    // the same Loader entry before writing; a recomposition during the read must
    // not target the stale namespace captured above.
    const liveLoader = this.service<LoaderLike>('loader')
    const liveResolution = liveLoader === undefined
      ? undefined
      : this.resolveNamespaces(liveLoader).find(candidate => candidate.spec.target === target)
    if (liveResolution?.namespace !== resolution.namespace) {
      return {
        ok: false,
        target,
        reason: 'unavailable',
        message: 'the native settings owner changed while the write was prepared',
        current: withOptions,
      }
    }
    if (withOptions.options.length === 0) {
      return {
        ok: false,
        target,
        reason: 'unavailable',
        message: withOptions.limitation ?? 'the native option list is not readable',
        current: withOptions,
      }
    }
    if (!withOptions.options.some((option) => option.id === value)) {
      return {
        ok: false,
        target,
        reason: 'not-an-option',
        message: `the native roster does not advertise "${value}" for this default`,
        current: withOptions,
      }
    }
    if (withOptions.revision !== expectedRevision) {
      return {
        ok: false,
        target,
        reason: 'conflict',
        expectedRevision,
        actualRevision: withOptions.revision,
        message: 'the native default changed since it was confirmed',
        current: withOptions,
      }
    }
    try {
      await settings.mutate(
        resolution.namespace,
        [{ op: 'set', path: [singleFieldPath(resolution.spec)], value }],
        expectedRevision,
      )
    } catch (error) {
      const conflict = this.conflictOf(error)
      if (conflict !== undefined) {
        const fresh = this.freshTarget(resolution, settings)
        return {
          ok: false,
          target,
          reason: 'conflict',
          expectedRevision: conflict.expected ?? expectedRevision,
          actualRevision: conflict.actual,
          message: 'the native default changed while it was being written',
          ...(fresh === undefined ? {} : { current: fresh }),
        }
      }
      this.warn(`native default write failed: ${diagnostic(error)}`)
      return {
        ok: false,
        target,
        reason: 'write-failed',
        message: diagnostic(error),
        current: this.freshTarget(resolution, settings),
      }
    }
    const readBack = this.describeNow(settings)
    const after = readBack === undefined ? undefined : this.projectTarget(resolution, readBack, true)
    if (after === undefined || !after.available || after.revision === undefined) {
      this.warn('native default write was accepted but its read-back failed')
      return {
        ok: false,
        target,
        reason: 'write-failed',
        message: 'the native write was accepted but its read-back failed; re-read the native default',
      }
    }
    const accepted = after.value ?? value
    return {
      ok: true,
      target,
      namespace: resolution.namespace,
      field: fieldLabel(resolution.spec),
      value: accepted,
      revision: after.revision,
      changed: accepted === value,
      ...(captured.scope.attachmentId === undefined ? {} : { attachmentId: captured.scope.attachmentId }),
      stillCurrent: this.stillCurrent(captured),
    }
  }

  /**
   * Explicit confirmed write of the native default model selection.
   *
   * One `settings.mutate()` carries `provider`, `model` and the reasoning
   * decision under one native revision fence, because DSH reads them as one
   * selection: two writes could leave a pair the composition cannot route.
   * Every asynchronous metadata/catalog phase is followed by an attachment,
   * cancellation and revision re-check, so a deadline or a moved attachment can
   * never reach the native mutation.
   */
  private async updateDefaultModel(input: {
    readonly captured: CapturedScope
    readonly settings: SettingsLike
    readonly namespace: string
    readonly resolution: NamespaceResolution
    readonly current: NativeDefaultSettingView
    readonly value: string
    readonly expectedRevision: number
    readonly request: NativeDefaultSettingUpdateRequest
    readonly signal: AbortSignal
  }): Promise<NativeDefaultSettingOutcome> {
    const target = 'agent-default-model' as const
    const { captured, settings, namespace, resolution, current, value, expectedRevision, request, signal } = input
    const requestedEffort = request.reasoningEffort
    if (requestedEffort !== undefined && requestedEffort !== null && nonEmpty(requestedEffort) === undefined) {
      throw backendError('INVALID_ARGUMENT', 'reasoningEffort must be a non-empty native level id, null, or omitted')
    }
    // A confirmed revision that has already moved can never become current
    // again, so refuse before paying the bounded catalog/metadata reads below.
    // A revision or owner that moves *during* those reads is still caught by
    // the final re-checks, so this is an early exit, never a replacement fence.
    const confirmedRevision = current.revision
    if (confirmedRevision !== undefined && confirmedRevision !== expectedRevision) {
      return {
        ok: false,
        target,
        reason: 'conflict',
        expectedRevision,
        actualRevision: confirmedRevision,
        message: 'the native default changed since it was confirmed',
        current,
      }
    }
    const persistedProvider = nonEmpty(current.provider)
    const persistedModel = nonEmpty(current.model)
    const persistedEffort = nonEmpty(current.reasoningEffort)
    if (persistedProvider === undefined || persistedModel === undefined) {
      return {
        ok: false,
        target,
        reason: 'unavailable',
        message: 'the native default model selection is unreadable',
        current,
      }
    }
    const persisted: DefaultModelSelection = {
      provider: persistedProvider,
      model: persistedModel,
      ...(persistedEffort === undefined ? {} : { reasoningEffort: persistedEffort }),
    }
    // The mounted runtime service, not this descriptor, decides the startup
    // default. A proven disagreement means writing this profile row would not
    // change what a fresh Agent reads, so the write is refused instead.
    const runtime = this.readDefaultSelection()
    if (runtime !== undefined && !sameSelection(runtime, persisted)) {
      return {
        ok: false,
        target,
        reason: 'unavailable',
        message: 'the mounted native default service does not read this profile entry, so a write could not change the startup default',
        current,
      }
    }

    // A value equal to the persisted pair edits only the level. Any other value
    // must be one advertised native model row; the catalog is read fresh and
    // the existing pure projector decides, so no second catalog is introduced.
    const effortOnly = value === pairKey(persisted.provider, persisted.model) || value === persisted.model
    let selected: DefaultModelSelection = persisted
    if (!effortOnly) {
      const catalog = await this.freshModelRows(signal)
      this.recheck(captured, signal, 'the native default model selection was prepared')
      if (!catalog.ok) {
        return {
          ok: false,
          target,
          reason: 'unavailable',
          message: `the native model catalog could not be read: ${catalog.message}`,
          current,
        }
      }
      const row = selectModelRow(catalog.items, { id: value })
      // Provider failures are part of the native answer: they are never turned
      // into an empty successful catalog, and they are reported alongside the
      // rows that did load so a provider outage is distinguishable from a model
      // id this catalog genuinely does not advertise.
      const failures = catalogFailureText(catalog.failures)
      if (row === undefined) {
        if (catalog.items.length === 0 && failures !== undefined) {
          return {
            ok: false,
            target,
            reason: 'unavailable',
            message: `the native model catalog could not be read: ${failures}`,
            current,
          }
        }
        return {
          ok: false,
          target,
          reason: 'not-an-option',
          message: `the native model catalog does not advertise "${value}"${failures === undefined
            ? ''
            : `; some native providers could not be read: ${failures}`}`,
          current,
        }
      }
      selected = { provider: row.provider, model: row.model }
    }

    const plan = await this.effortPlan({ requestedEffort, effortOnly, persisted, selected, signal })
    if ('refusal' in plan) {
      return { ok: false, target, reason: plan.reason, message: plan.refusal, current }
    }

    const ops: SettingsPathOp[] = []
    if (!effortOnly) {
      ops.push({ op: 'set', path: [MODEL_PROVIDER_PATH], value: selected.provider })
      ops.push({ op: 'set', path: [MODEL_PATH], value: selected.model })
    }
    if (plan.kind === 'set') ops.push({ op: 'set', path: [MODEL_EFFORT_PATH], value: plan.id })
    if (plan.kind === 'unset') ops.push({ op: 'unset', path: [MODEL_EFFORT_PATH] })
    if (ops.length === 0) {
      // Confirming the selection that is already stored changes nothing, so it
      // is a successful no-op rather than a malformed request: the model
      // picker's own current row must stay confirmable. No mutation is prepared
      // (the revision fence has nothing to protect), and the outcome still
      // carries the native read-back shape — fresh `revision`/`value` and the
      // persisted pair — so the caller can repaint from native facts only.
      this.recheck(captured, signal, 'the native default model selection was confirmed')
      const observed = this.freshTarget(resolution, settings)
      const observedValue = observed === undefined ? undefined : nonEmpty(observed.value)
      if (observed === undefined || !observed.available || observed.revision === undefined || observedValue === undefined) {
        return {
          ok: false,
          target,
          reason: 'unavailable',
          message: observed?.limitation ?? 'the native settings descriptor could not be re-read to confirm the current default',
          ...(observed === undefined ? {} : { current: observed }),
        }
      }
      const observedEffort = nonEmpty(observed.reasoningEffort)
      return {
        ok: true,
        target,
        namespace,
        field: fieldLabel(resolution.spec),
        value: observedValue,
        revision: observed.revision,
        changed: false,
        unchanged: true,
        ...(captured.scope.attachmentId === undefined ? {} : { attachmentId: captured.scope.attachmentId }),
        stillCurrent: this.stillCurrent(captured),
        ...(observed.provider === undefined ? {} : { provider: observed.provider }),
        ...(observed.model === undefined ? {} : { model: observed.model }),
        ...(observedEffort === undefined ? {} : { reasoningEffort: observedEffort }),
      }
    }
    const desiredEffort = plan.kind === 'set'
      ? plan.id
      : plan.kind === 'unset'
        ? undefined
        : persistedEffort

    // Final pre-write gate: cancellation, attachment and the native revision
    // are re-proven after every asynchronous phase above.
    this.recheck(captured, signal, 'the native default model selection was prepared')
    const fresh = this.freshTarget(resolution, settings)
    if (fresh === undefined || !fresh.available || fresh.revision === undefined) {
      return {
        ok: false,
        target,
        reason: 'unavailable',
        message: fresh?.limitation ?? 'the native settings descriptor could not be re-read before the write',
        ...(fresh === undefined ? {} : { current: fresh }),
      }
    }
    if (fresh.revision !== expectedRevision) {
      return {
        ok: false,
        target,
        reason: 'conflict',
        expectedRevision,
        actualRevision: fresh.revision,
        message: 'the native default changed since it was confirmed',
        current: fresh,
      }
    }
    const movedPair = fresh.provider !== persisted.provider || fresh.model !== persisted.model ||
      (nonEmpty(fresh.reasoningEffort) ?? undefined) !== persistedEffort
    if (movedPair) {
      return {
        ok: false,
        target,
        reason: 'conflict',
        expectedRevision,
        actualRevision: fresh.revision,
        message: 'the native default model selection changed while this write was prepared',
        current: fresh,
      }
    }
    // Owner re-proof after the asynchronous phases: a profile recomposition can
    // add/replace the default-model Loader entry or hand `currentSelection()` to
    // another service without touching this descriptor's revision. Re-resolve
    // the unique namespace and re-read the mounted owner from the live access
    // services, never from a cached ownership record; a moved owner is refused
    // with no mutation and the native revision fence stays in place.
    const liveLoader = this.service<LoaderLike>('loader')
    const liveResolution = liveLoader === undefined
      ? undefined
      : this.resolveNamespaces(liveLoader).find((candidate) => candidate.spec.target === target)
    if (liveResolution === undefined || liveResolution.namespace === undefined || liveResolution.namespace !== namespace) {
      return {
        ok: false,
        target,
        reason: 'unavailable',
        message: liveResolution?.reason === 'namespace-ambiguous'
          ? 'more than one profile entry now declares this plugin, so the owner namespace is no longer unique'
          : 'the native settings namespace for this target changed while the write was prepared',
        current: fresh,
      }
    }
    const freshProvider = nonEmpty(fresh.provider)
    const freshModel = nonEmpty(fresh.model)
    if (freshProvider === undefined || freshModel === undefined) {
      return {
        ok: false,
        target,
        reason: 'unavailable',
        message: 'the native default model selection is unreadable',
        current: fresh,
      }
    }
    const freshEffort = nonEmpty(fresh.reasoningEffort)
    const liveRuntime = this.readDefaultSelection()
    if (liveRuntime !== undefined && !sameSelection(liveRuntime, {
      provider: freshProvider,
      model: freshModel,
      ...(freshEffort === undefined ? {} : { reasoningEffort: freshEffort }),
    })) {
      return {
        ok: false,
        target,
        reason: 'conflict',
        expectedRevision,
        actualRevision: fresh.revision,
        message: 'the mounted native default service reports a different selection; the obsolete write was not applied',
        current: fresh,
      }
    }

    try {
      const mutate = settings.mutate
      if (typeof mutate !== 'function') {
        return { ok: false, target, reason: 'unavailable', message: 'the native settings write path is not mounted', current }
      }
      await mutate.call(settings, namespace, ops, expectedRevision)
    } catch (error) {
      const conflict = this.conflictOf(error)
      if (conflict !== undefined) {
        const after = this.freshTarget(resolution, settings)
        return {
          ok: false,
          target,
          reason: 'conflict',
          expectedRevision: conflict.expected ?? expectedRevision,
          actualRevision: conflict.actual,
          message: 'the native default changed while it was being written',
          ...(after === undefined ? {} : { current: after }),
        }
      }
      this.warn(`native default model write failed: ${diagnostic(error)}`)
      return {
        ok: false,
        target,
        reason: 'write-failed',
        message: diagnostic(error),
        current: this.freshTarget(resolution, settings),
      }
    }
    const readBack = this.describeNow(settings)
    const after = readBack === undefined ? undefined : this.projectTarget(resolution, readBack, true)
    const accepted = after === undefined ? undefined : nonEmpty(after.value)
    if (after === undefined || !after.available || after.revision === undefined || accepted === undefined) {
      this.warn('native default model write was accepted but its read-back failed')
      return {
        ok: false,
        target,
        reason: 'write-failed',
        message: 'the native write was accepted but its read-back failed; re-read the native default',
      }
    }
    const readBackEffort = nonEmpty(after.reasoningEffort)
    const changed = after.provider === selected.provider && after.model === selected.model &&
      readBackEffort === desiredEffort
    return {
      ok: true,
      target,
      namespace,
      field: fieldLabel(resolution.spec),
      // The native read-back pair, never the requested one: `changed` compares
      // the two, so `value` must describe what the document actually holds.
      value: accepted,
      revision: after.revision,
      changed,
      ...(captured.scope.attachmentId === undefined ? {} : { attachmentId: captured.scope.attachmentId }),
      stillCurrent: this.stillCurrent(captured),
      ...(after.provider === undefined ? {} : { provider: after.provider }),
      ...(after.model === undefined ? {} : { model: after.model }),
      ...(readBackEffort === undefined ? {} : { reasoningEffort: readBackEffort }),
      ...(plan.kind === 'unset' && readBackEffort === undefined ? { reasoningEffortReset: true } : {}),
    }
  }

  /**
   * Decide the reasoning operation for one default-model write.
   *
   * The stored level survives only when the target still advertises it (the
   * same rule the session route uses); otherwise the field is removed, which is
   * exactly the native `saveSelection()` omission semantic. An unreadable
   * metadata answer refuses an **explicit** level (it cannot be validated), but
   * never blocks a model switch: the stored level is then removed with the same
   * native `unset` instead of being guessed as still supported. Refusing the
   * switch would strand exactly the broken saved pair this target exists to
   * repair, and omitting the level is what the native selection writer does
   * when it cannot confirm the target's roster.
   */
  private async effortPlan(input: {
    readonly requestedEffort: string | null | undefined
    readonly effortOnly: boolean
    readonly persisted: DefaultModelSelection
    readonly selected: DefaultModelSelection
    readonly signal: AbortSignal
  }): Promise<EffortPlan | { readonly refusal: string; readonly reason: 'not-an-option' | 'unavailable' }> {
    const { requestedEffort, effortOnly, persisted, selected, signal } = input
    if (requestedEffort === null) return { kind: 'unset' }
    if (requestedEffort !== undefined) {
      const probe = await this.reasoningProbe(selected.provider, selected.model, signal)
      if (!probe.available) return { refusal: probe.limitation, reason: 'unavailable' }
      const efforts = probe.reasoning?.efforts ?? []
      if (!efforts.some((level) => level.id === requestedEffort)) {
        const available = efforts.map((level) => level.id).join(', ')
        return {
          refusal: `the native model ${pairKey(selected.provider, selected.model)} does not advertise reasoning effort "${requestedEffort}"${available === '' ? '' : `; available: ${available}`}`,
          reason: 'not-an-option',
        }
      }
      return { kind: 'set', id: requestedEffort }
    }
    if (effortOnly || persisted.reasoningEffort === undefined) return { kind: 'none' }
    const probe = await this.reasoningProbe(selected.provider, selected.model, signal)
    // Unreadable NEW metadata is unknown, never "supports nothing": the carried
    // level cannot be proven, so the model switch proceeds and omits it (native
    // `saveSelection()` semantics, a native `unset` in the same mutate). Only
    // an explicit level needs a readable answer, and that is refused above.
    if (!probe.available) return { kind: 'unset' }
    const carried = carriedEffort(probe.reasoning, persisted.reasoningEffort)
    if (carried === undefined) return { kind: 'unset' }
    return carried === persisted.reasoningEffort ? { kind: 'none' } : { kind: 'set', id: carried }
  }

  /** Cancellation/attachment re-check after one asynchronous phase. */
  private recheck(captured: CapturedScope, signal: AbortSignal, label: string): void {
    if (signal.aborted) throw cancellationError(signal, 'native default update')
    if (!this.stillCurrent(captured)) {
      throw backendError('STALE_SESSION', `${label}; the obsolete selection was not written`)
    }
  }

  /** One exact-route reasoning metadata read; never a provider catalog walk. */
  private async reasoningProbe(provider: string, model: string, signal: AbortSignal): Promise<NativeReasoningProbe> {
    const face = this.faces.resolveReasoning
    if (typeof face !== 'function') {
      return { available: false, limitation: 'the runtime mounted no native model metadata resolver' }
    }
    try {
      const raw = await bounded(
        Promise.resolve(face(provider, model, signal)),
        DEFAULT_REASONING_TIMEOUT_MS,
        `native reasoning metadata for ${pairKey(provider, model)}`,
        signal,
      )
      // `undefined` legitimately means "this route advertises no levels". A
      // present non-record payload is malformed metadata, not an empty roster.
      if (raw !== undefined && record(raw) === undefined) {
        this.warn(`the native reasoning metadata for ${pairKey(provider, model)} is not a record`)
        return {
          available: false,
          limitation: `the native reasoning metadata for ${pairKey(provider, model)} is malformed`,
        }
      }
      const reasoning = reasoningView(raw)
      return { available: true, ...(reasoning === undefined ? {} : { reasoning }) }
    } catch (error) {
      if (signal.aborted) throw cancellationError(signal, 'native reasoning metadata read')
      this.warn(`could not read native reasoning metadata for ${pairKey(provider, model)}: ${diagnostic(error)}`)
      return {
        available: false,
        limitation: `the native reasoning metadata for ${pairKey(provider, model)} could not be read`,
      }
    }
  }

  /** Fresh native model rows for one explicit model change. */
  private async freshModelRows(
    signal: AbortSignal,
  ): Promise<
    | { readonly ok: true; readonly items: readonly ModelRow[]; readonly failures: readonly string[] }
    | { readonly ok: false; readonly message: string }
  > {
    const face = this.faces.modelCatalog
    if (typeof face !== 'function') return { ok: false, message: 'the runtime mounted no native model catalog' }
    try {
      const value = await bounded(
        Promise.resolve(face()),
        DEFAULT_MODEL_CATALOG_TIMEOUT_MS,
        'native model catalog read',
        signal,
      )
      const items = Array.isArray(value?.items) ? value.items : []
      // Isolated provider failures are retained, never folded into the rows: a
      // partially failed catalog is still usable, and the caller reports the
      // remaining failures instead of pretending the catalog was complete.
      const rawFailures: unknown = value?.failures
      const failures = Array.isArray(rawFailures)
        ? (rawFailures as readonly unknown[]).flatMap((entry) => (typeof entry === 'string' ? [entry] : []))
        : []
      const summary = catalogFailureText(failures)
      if (summary !== undefined) this.warn(`could not read some native model providers: ${summary}`)
      return { ok: true, items, failures }
    } catch (error) {
      if (signal.aborted) throw cancellationError(signal, 'native model catalog read')
      this.warn(`could not read the native model catalog: ${diagnostic(error)}`)
      return { ok: false, message: diagnostic(error) }
    }
  }

  /** The mounted native default selection, read defensively and never cached. */
  private readDefaultSelection(): DefaultModelSelection | undefined {
    const face = this.faces.currentSelection
    if (typeof face !== 'function') return undefined
    try {
      return readDefaultSelection(face())
    } catch (error) {
      this.warn(`native default model selection read failed: ${diagnostic(error)}`)
      return undefined
    }
  }

  /** Explicit rename of the exact current root Session through the native title owner. */
  renameCurrent(request: SessionRenameRequest): SessionRenameOutcome {
    if (typeof request?.title !== 'string') {
      throw backendError('INVALID_ARGUMENT', 'rename requires the raw title text')
    }
    const gate = this.rootGate(request.sessionId, request.attachmentId)
    if (!gate.ok) return { ok: false, reason: gate.reason, message: gate.message }
    const titles = this.service<SessionTitleLike>('sessionTitle')
    if (typeof titles?.rename !== 'function') {
      return { ok: false, reason: 'missing-service', message: 'DSH mounts no session-title service in this profile' }
    }
    const session = gate.identity.source
    const previousTitle = this.readTitle(titles, session)
    let accepted: unknown
    try {
      accepted = titles.rename(session, request.title)
    } catch (error) {
      const item = record(error)
      const invalid = item?.name === 'SessionTitleInvalidError'
      if (!invalid) this.warn(`native title rename failed: ${diagnostic(error)}`)
      return {
        ok: false,
        reason: invalid ? 'title-invalid' : 'rename-failed',
        message: invalid ? 'the title must contain visible characters' : diagnostic(error),
      }
    }
    const snapshot = readTitleSnapshot(accepted)
    if (snapshot === undefined) {
      this.warn('native title rename returned no accepted snapshot')
      return { ok: false, reason: 'rename-failed', message: 'the native rename returned no accepted title' }
    }
    return {
      ok: true,
      sessionId: gate.identity.id,
      ...(gate.captured.scope.attachmentId === undefined ? {} : { attachmentId: gate.captured.scope.attachmentId }),
      title: snapshot.title,
      seq: snapshot.eventSeq,
      source: 'user',
      ...(previousTitle === undefined ? {} : { previousTitle }),
      stillCurrent: this.stillCurrent(gate.captured),
    }
  }

  // ---- internals -------------------------------------------------------

  private service<T>(name: string): T | undefined {
    try {
      const value = this.access.service(name)
      return value === undefined || value === null ? undefined : value as T
    } catch (error) {
      this.warn(`native service "${name}" is unreadable: ${diagnostic(error)}`)
      return undefined
    }
  }

  private isCurrent(scope: NativeUiScope): boolean {
    try {
      return this.access.isCurrent(scope) === true
    } catch {
      return false
    }
  }

  private captureScope(attachmentId?: string): CapturedScope | undefined {
    let current: NativeUiScope | undefined
    try {
      current = this.access.current()
    } catch {
      return undefined
    }
    if (current === undefined || current === null || typeof current !== 'object') return undefined
    if (!this.isCurrent(current)) return undefined
    if (attachmentId !== undefined && current.attachmentId !== attachmentId) return undefined
    return { scope: current }
  }

  private stillCurrent(captured: CapturedScope): boolean {
    return this.isCurrent(captured.scope)
  }

  /**
   * Validate the exact current root attachment before a root-scoped write.
   * Rejects foreign ids, child-origin Sessions and a non-live store instance.
   */
  private rootGate(sessionId: string, attachmentId?: string): RootGate {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw backendError('INVALID_ARGUMENT', 'an explicit current session id is required')
    }
    if (attachmentId !== undefined && nonEmpty(attachmentId) === undefined) {
      throw backendError('INVALID_ARGUMENT', 'attachmentId must be a non-empty string when supplied')
    }
    let current: NativeUiScope | undefined
    try {
      current = this.access.current()
    } catch {
      current = undefined
    }
    if (current === undefined || current === null || typeof current !== 'object') {
      return { ok: false, reason: 'no-attachment', message: 'no current DSH attachment' }
    }
    if (!this.isCurrent(current)) {
      return { ok: false, reason: 'stale-attachment', message: 'the attachment is no longer the supplied native one' }
    }
    if (current.sessionId !== sessionId) {
      return { ok: false, reason: 'foreign-session', message: 'only the exact current root session may be changed' }
    }
    if (attachmentId !== undefined && current.attachmentId !== attachmentId) {
      return { ok: false, reason: 'stale-attachment', message: 'the attachment changed since the action was confirmed' }
    }
    const sessionObject = record(current.session)
    if (sessionObject === undefined || record(sessionObject.header) === undefined) {
      return { ok: false, reason: 'no-session', message: 'the current session has no readable native Session header yet' }
    }
    const identity = readSessionIdentity(current.session)
    if (identity === undefined) {
      return { ok: false, reason: 'no-session', message: 'the current session has no native Session yet' }
    }
    if (identity.id !== sessionId) {
      return { ok: false, reason: 'foreign-session', message: 'the supplied native Session is not the current root session' }
    }
    if (isChildSession(identity)) {
      return { ok: false, reason: 'child-session', message: 'a subagent-origin Session is never a root target' }
    }
    const sessions = this.service<SessionsLike>('sessions')
    if (typeof sessions?.get === 'function') {
      let live: unknown
      try {
        live = sessions.get(sessionId)
      } catch (error) {
        this.warn(`native session store lookup failed: ${diagnostic(error)}`)
        return { ok: false, reason: 'session-not-live', message: 'the native session store could not prove this Session live' }
      }
      if (live !== identity.source) {
        return { ok: false, reason: 'session-not-live', message: 'the current Session is not the live store instance' }
      }
    }
    return { ok: true, captured: { scope: current }, identity }
  }

  private readTitle(titles: SessionTitleLike | undefined, session: unknown): string | null | undefined {
    if (typeof titles?.get !== 'function') return undefined
    try {
      const snapshot = readTitleSnapshot(titles.get(session))
      return snapshot === undefined ? null : snapshot.title
    } catch (error) {
      this.warn(`native title read failed: ${diagnostic(error)}`)
      return undefined
    }
  }

  private resolveNamespaces(loader: LoaderLike): readonly NamespaceResolution[] {
    const entries = readLoaderEntries(loader)
    return TARGETS.map((spec) => {
      if (entries === undefined) return { spec, reason: 'missing-loader' }
      const ids = new Set<string>()
      for (const entry of entries) {
        const options = record(record(entry)?.options)
        if (options === undefined) continue
        if (options.name !== spec.packageName) continue
        const id = nonEmpty(options.id)
        if (id !== undefined) ids.add(id)
      }
      if (ids.size === 0) return { spec, reason: 'namespace-unresolved' }
      if (ids.size > 1) return { spec, reason: 'namespace-ambiguous' }
      return { spec, namespace: [...ids][0] }
    })
  }

  private unresolvedTargets(reason: DefaultSettingUnavailableReason): readonly NativeDefaultSettingView[] {
    return TARGETS.map((spec) => ({
      target: spec.target,
      field: fieldLabel(spec),
      available: false,
      writable: false,
      options: [],
      reason,
      limitation: 'the native settings namespace for this target could not be proven',
    }))
  }

  private describeNow(settings: SettingsLike): readonly unknown[] | undefined {
    try {
      const value = settings.describe?.({ redactSecrets: true })
      return Array.isArray(value) ? value : undefined
    } catch (error) {
      this.warn(`settings describe failed: ${diagnostic(error)}`)
      return undefined
    }
  }

  private freshTarget(resolution: NamespaceResolution, settings: SettingsLike): NativeDefaultSettingView | undefined {
    const descriptors = this.describeNow(settings)
    if (descriptors === undefined) return undefined
    return this.projectTarget(resolution, descriptors, typeof settings.mutate === 'function')
  }

  private async attachOptions(view: NativeDefaultSettingView, signal: AbortSignal = NEVER_ABORTED): Promise<NativeDefaultSettingView> {
    if (!view.available) return view
    if (view.target === 'agent-default-model') return await this.attachDefaultModel(view, signal)
    if (view.target === 'permission-default-preset') {
      const permissions = this.service<PermissionPresetsLike>('permissionPresets')
      if (typeof permissions?.catalog !== 'function') {
        return this.optionsUnavailable(view, 'the native permission catalog is not mounted')
      }
      let catalogValue: unknown
      try {
        catalogValue = permissions.catalog()
      } catch (error) {
        this.warn(`native permission catalog read failed: ${diagnostic(error)}`)
        return this.optionsUnavailable(view, diagnostic(error))
      }
      const catalog = record(catalogValue)
      const rows = Array.isArray(catalog?.defaultOptions) ? catalog.defaultOptions : undefined
      if (rows === undefined) {
        return this.optionsUnavailable(view, 'the native permission catalog advertises no defaults')
      }
      const options: NativeDefaultOption[] = []
      for (const row of rows) {
        const item = record(row)
        const id = nonEmpty(item?.value)
        if (id === undefined) continue
        options.push(readDefaultOption({
          id,
          ...(typeof item?.name === 'string' ? { label: item.name } : {}),
          ...(typeof item?.description === 'string' ? { description: item.description } : {}),
        }) ?? { id })
      }
      if (options.length === 0) {
        return this.optionsUnavailable(view, 'the native permission catalog advertises no defaults')
      }
      const effectiveValue = nonEmpty(catalog?.defaultPreset)
      return this.withOptions(view, options, effectiveValue)
    }
    const presets = this.service<AgentPresetsLike>('agentPresets')
    const effectiveValue = this.presetDefault(presets)
    if (typeof presets?.list !== 'function') {
      return this.optionsUnavailable(view, 'the native agent-preset roster is not mounted')
    }
    let roster: unknown
    try {
      // The roster read is asynchronous and native `settings.mutate()` is not
      // abortable. Bound this phase and let the caller's final signal fence
      // stop a write that completed after cancellation.
      roster = await bounded(
        Promise.resolve(presets.list()),
        DEFAULT_PRESET_ROSTER_TIMEOUT_MS,
        'native agent-preset roster read',
        signal,
      )
    } catch (error) {
      if (signal.aborted) throw cancellationError(signal, 'native agent-preset roster read')
      this.warn(`native agent-preset roster read failed: ${diagnostic(error)}`)
      return this.optionsUnavailable(view, diagnostic(error))
    }
    if (!Array.isArray(roster)) {
      return this.optionsUnavailable(view, 'the native agent-preset roster is unreadable')
    }
    const options: NativeDefaultOption[] = []
    for (const row of roster) {
      const item = record(row)
      const id = nonEmpty(item?.id)
      if (id === undefined) continue
      // A broken declaration cannot compose a session, so it is never offered
      // as the default; the native roster supplies the diagnostic.
      if (typeof item?.broken === 'string' && item.broken.length > 0) continue
      options.push(readDefaultOption({
        id,
        ...(typeof item?.name === 'string' ? { label: item.name } : {}),
        ...(typeof item?.description === 'string' ? { description: item.description } : {}),
      }) ?? { id })
    }
    if (options.length === 0) {
      return this.optionsUnavailable(view, 'the native agent-preset roster advertises no usable preset')
    }
    return this.withOptions(view, options, effectiveValue)
  }

  /**
   * Enrich the default-model target with the exact pair and its native reasoning
   * metadata.
   *
   * One `resolveModelInfo` call for the persisted pair only: no provider
   * catalog walk here, so the outer native-UI read bound still covers the whole
   * read. Missing/failed metadata is reported as `reasoningAvailable:false` and
   * never flattened into "this model has no levels"; a genuine empty roster is
   * `reasoningSupported:false`. Neither condition clears the model row's proven
   * native writability: the effort row gates itself on
   * `reasoningAvailable`, and the model picker is exactly how a default whose
   * old pair metadata is broken gets repaired through the native catalog. A
   * model switch with unreadable target metadata therefore still applies and
   * removes the stored level; only an explicit level is refused.
   */
  private async attachDefaultModel(
    view: NativeDefaultSettingView,
    signal: AbortSignal,
  ): Promise<NativeDefaultSettingView> {
    const provider = nonEmpty(view.provider)
    const model = nonEmpty(view.model)
    if (provider === undefined || model === undefined) {
      return this.optionsUnavailable(view, 'the native default provider/model pair is unreadable')
    }
    const stored = nonEmpty(view.reasoningEffort)
    // The runtime service owns the startup default. A proven disagreement means
    // this profile row is not what a fresh Agent reads, so edits cannot change
    // that default and must not be advertised as writable.
    const runtime = this.readDefaultSelection()
    if (runtime !== undefined && !sameSelection(runtime, {
      provider,
      model,
      ...(stored === undefined ? {} : { reasoningEffort: stored }),
    })) {
      return {
        ...view,
        writable: false,
        reason: 'write-unavailable',
        limitation: 'the mounted native default service does not read this profile entry; a write could not change the startup default',
      }
    }
    const probe = await this.reasoningProbe(provider, model, signal)
    if (!probe.available) {
      // The native Settings write path and this namespace/revision are already
      // proven (`view.writable`); an unreadable reasoning roster only disables
      // the effort choice. Keeping the model row writable is what lets a user
      // replace a stale/broken default with a valid native catalog row.
      return {
        ...view,
        reason: 'options-unavailable',
        limitation: probe.limitation,
        reasoningAvailable: false,
      }
    }
    const efforts = probe.reasoning?.efforts ?? []
    const supported = efforts.length > 0
    const defaultEffort = probe.reasoning?.defaultEffort
    const advertised = stored === undefined ? undefined : efforts.some((level) => level.id === stored)
    const effective = stored === undefined ? defaultEffort : advertised === true ? stored : undefined
    const unsupportedStored = stored !== undefined && supported && advertised === false
    return {
      ...view,
      reasoningAvailable: true,
      reasoningSupported: supported,
      reasoningEfforts: efforts.flatMap((level) => {
        const option = readDefaultOption({ id: level.id, label: level.name, ...(level.description === undefined ? {} : { description: level.description }) })
        return option === undefined ? [] : [option]
      }),
      ...(defaultEffort === undefined ? {} : { defaultReasoningEffort: defaultEffort }),
      ...(effective === undefined ? {} : { effectiveReasoningEffort: effective }),
      ...(unsupportedStored
        ? {
            limitation: `the stored reasoning effort "${stored}" is not advertised by ${pairKey(provider, model)}; DSH rejects it when a request is prepared`,
          }
        : {}),
    }
  }

  private withOptions(
    view: NativeDefaultSettingView,
    options: readonly NativeDefaultOption[],
    effectiveValue: string | undefined,
  ): NativeDefaultSettingView {
    return {
      ...view,
      writable: view.writable && options.length > 0,
      options,
      ...(effectiveValue === undefined ? {} : { effectiveValue }),
    }
  }

  private optionsUnavailable(view: NativeDefaultSettingView, limitation: string): NativeDefaultSettingView {
    return { ...view, writable: false, options: [], reason: 'options-unavailable', limitation }
  }

  private presetDefault(presets: AgentPresetsLike | undefined): string | undefined {
    if (presets === undefined) return undefined
    try {
      return nonEmpty(presets.defaultId)
    } catch (error) {
      this.warn(`native agent-preset default read failed: ${diagnostic(error)}`)
      return undefined
    }
  }

  private projectTarget(
    resolution: NamespaceResolution,
    descriptors: readonly unknown[],
    writablePath: boolean,
  ): NativeDefaultSettingView {
    const spec = resolution.spec
    const label = fieldLabel(spec)
    const base = (reason: DefaultSettingUnavailableReason, limitation: string): NativeDefaultSettingView => ({
      target: spec.target,
      field: label,
      available: false,
      writable: false,
      options: [],
      reason,
      limitation,
    })
    if (resolution.namespace === undefined) {
      return base(
        resolution.reason ?? 'namespace-unresolved',
        resolution.reason === 'namespace-ambiguous'
          ? 'more than one profile entry declares this plugin, so the owner namespace cannot be chosen safely'
          : 'the native settings namespace for this target is not mounted in this profile',
      )
    }
    const descriptor = descriptors.flatMap((value) => {
      const item = record(value)
      return item !== undefined && item.ns === resolution.namespace ? [item] : []
    })[0]
    if (descriptor === undefined) {
      return base('namespace-unavailable', 'the native profile has no live settings entry for this namespace')
    }
    const revision = integer(descriptor.revision)
    if (revision === undefined) return base('value-malformed', 'the native settings revision is unreadable')
    const missing = spec.fields.find((field) => !schemaDeclaresField(descriptor.schema, field))
    if (missing !== undefined) {
      return base('field-not-volatile', `the native settings form does not declare "${missing}" as a live field`)
    }
    const value = record(descriptor.value)
    if (value === undefined) return base('value-malformed', 'the native settings value is unreadable')
    if (spec.target === 'agent-default-model') {
      const provider = nonEmpty(value[MODEL_PROVIDER_PATH])
      const model = nonEmpty(value[MODEL_PATH])
      if (provider === undefined || model === undefined) {
        return base('value-malformed', 'the native default model provider/model pair is unreadable')
      }
      const reasoningEffort = value[MODEL_EFFORT_PATH]
      if (reasoningEffort !== undefined && typeof reasoningEffort !== 'string') {
        return base('value-malformed', `the native "${MODEL_EFFORT_PATH}" value is not a string`)
      }
      return {
        target: spec.target,
        field: label,
        available: true,
        writable: writablePath,
        namespace: resolution.namespace,
        provider,
        model,
        value: pairKey(provider, model),
        ...(nonEmpty(reasoningEffort) === undefined ? {} : { reasoningEffort: nonEmpty(reasoningEffort) }),
        revision,
        options: [],
        ...(writablePath ? {} : { reason: 'write-unavailable', limitation: 'the native settings write path is not mounted' }),
      }
    }
    const fieldValue = value[singleFieldPath(spec)]
    if (fieldValue !== undefined && typeof fieldValue !== 'string') {
      return base('value-malformed', `the native "${label}" value is not a string`)
    }
    return {
      target: spec.target,
      field: label,
      available: true,
      writable: writablePath,
      namespace: resolution.namespace,
      ...(typeof fieldValue === 'string' ? { value: fieldValue } : {}),
      revision,
      options: [],
      ...(writablePath ? {} : { reason: 'write-unavailable', limitation: 'the native settings write path is not mounted' }),
    }
  }

  private conflictOf(error: unknown): { expected?: number; actual?: number } | undefined {
    const item = record(error)
    if (item?.code !== 'SETTINGS_CONFLICT') return undefined
    const expected = integer(item.expected)
    const actual = integer(item.actual)
    return {
      ...(expected === undefined ? {} : { expected }),
      ...(actual === undefined ? {} : { actual }),
    }
  }
}
