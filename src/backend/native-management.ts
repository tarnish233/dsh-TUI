/**
 * Native management seam: explicit current-root session rename and the two safe
 * native default-setting fields (`selectedDefault` / `defaultPreset`).
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
 *   only as the native option authority for those two fields.
 *
 * It never creates, resumes, prompts or switches an Agent; never writes a file;
 * never reads a credential, an unrelated namespace or an unrelated field; and
 * keeps no store, timer, cache or scheduler. Read-only paths materialize
 * nothing. `buildInteractiveForkInput` is the pure helper for the parent's own
 * native `/fork` flow (public `snapshotEvents` + native `buildForkSeed` + native
 * `agents.create`); this module deliberately exposes no session-only
 * `SessionStore.fork` adapter, because such a child owns no Agent and no public
 * API can attach one (native `SessionStore.prepare` rejects the existing id, so
 * pre-forking would also block the parent's own `agents.create`).
 *
 * @module dsh-tui/backend/native-management
 */
import { asBackendError, backendError } from './errors.ts'
import type { NativeUiAccess, NativeUiScope } from './native-ui-scope.ts'

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

/** The two allowlisted native default-setting targets. */
export type DefaultSettingTarget = 'agent-preset-default' | 'permission-default-preset'

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
  /** Allowlisted field name: `selectedDefault` or `defaultPreset`. */
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
}

/** Both allowlisted targets, resolved on every read. */
export interface NativeDefaultSettingsRead {
  readonly available: boolean
  readonly targets: readonly NativeDefaultSettingView[]
  readonly reason?: DefaultSettingReadReason
  readonly limitation?: string
}

/** Explicit, confirmed default-setting write request. */
export interface NativeDefaultSettingUpdateRequest {
  readonly target: DefaultSettingTarget
  /** Exact native id from the target's `options` (never a free-form value). */
  readonly value: string
  /** Revision returned by the confirmed read; required, never a wildcard. */
  readonly expectedRevision: number
  /** Optional exact-attachment fence captured with the read. */
  readonly attachmentId?: string
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
      attachmentId?: string
      /** False when the attachment moved while the native write was in flight. */
      stillCurrent: boolean
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

/** Construction options (the shared seam is injected, never modified). */
export interface NativeManagementOptions {
  readonly access: NativeUiAccess
  /** Redacted diagnostic sink; defaults to the access `warn` hook. */
  readonly warn?: (message: string) => void
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

interface TargetSpec {
  readonly target: DefaultSettingTarget
  readonly packageName: string
  readonly field: string
}

const TARGETS: readonly TargetSpec[] = [
  { target: 'agent-preset-default', packageName: '@deepseek-ai/dsh-agent-preset-registry', field: 'selectedDefault' },
  { target: 'permission-default-preset', packageName: '@deepseek-ai/dsh-permission-presets', field: 'defaultPreset' },
]

interface SessionTitleLike {
  get?(session: unknown): unknown
  rename?(session: unknown, title: string): unknown
}

interface SettingsLike {
  describe?(options?: { readonly redactSecrets?: boolean }): unknown
  mutate?(namespace: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<unknown>
}

interface SettingsPathOp {
  readonly op: 'set'
  readonly path: readonly string[]
  readonly value: unknown
}

interface LoaderEntryLike {
  readonly options?: { readonly id?: string; readonly name?: string }
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

  constructor(options: NativeManagementOptions) {
    const access = options?.access
    if (access === undefined || access === null || typeof access !== 'object') {
      throw backendError('INVALID_OPTIONS', 'NativeManagement requires the supplied NativeUiAccess seam')
    }
    this.access = access
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
  async defaultSettings(): Promise<NativeDefaultSettingsRead> {
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
    const describe = (): readonly unknown[] | undefined => {
      try {
        const value = settings.describe?.({ redactSecrets: true })
        return Array.isArray(value) ? value : undefined
      } catch (error) {
        this.warn(`settings describe failed: ${diagnostic(error)}`)
        return undefined
      }
    }
    const descriptors = describe()
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
      resolutions.map(async (resolution) => this.attachOptions(this.projectTarget(resolution, descriptors, writablePath))),
    )
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
  async updateDefault(request: NativeDefaultSettingUpdateRequest): Promise<NativeDefaultSettingOutcome> {
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
    const withOptions = await this.attachOptions(current)
    if (!this.stillCurrent(captured)) {
      return { ok: false, target, reason: 'stale-attachment', message: 'the attachment changed while the write was prepared', current: withOptions }
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
        [{ op: 'set', path: [resolution.spec.field], value }],
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
      field: resolution.spec.field,
      value: accepted,
      revision: after.revision,
      changed: accepted === value,
      ...(captured.scope.attachmentId === undefined ? {} : { attachmentId: captured.scope.attachmentId }),
      stillCurrent: this.stillCurrent(captured),
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
      field: spec.field,
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

  private async attachOptions(view: NativeDefaultSettingView): Promise<NativeDefaultSettingView> {
    if (!view.available) return view
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
      roster = await presets.list()
    } catch (error) {
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
    const base = (reason: DefaultSettingUnavailableReason, limitation: string): NativeDefaultSettingView => ({
      target: spec.target,
      field: spec.field,
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
    if (!schemaDeclaresField(descriptor.schema, spec.field)) {
      return base('field-not-volatile', `the native settings form does not declare "${spec.field}" as a live field`)
    }
    const value = record(descriptor.value)
    if (value === undefined) return base('value-malformed', 'the native settings value is unreadable')
    const fieldValue = value[spec.field]
    if (fieldValue !== undefined && typeof fieldValue !== 'string') {
      return base('value-malformed', `the native "${spec.field}" value is not a string`)
    }
    return {
      target: spec.target,
      field: spec.field,
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
