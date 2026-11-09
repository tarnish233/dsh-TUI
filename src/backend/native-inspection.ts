/**
 * Read-only native inspection adapters.
 *
 * DSH remains the owner of every fact this module reads: the background-job
 * registry (`ctx.jobs`), the goal domain (`ctx.goals` plus the durable `goal`
 * projection), the effective working directory (`ctx.workingDirectory` plus its
 * projection), the Loader/agent-preset plugin inventory (public
 * `readPluginInventory(ctx)`) and the active Agent's tool definitions
 * (`ctx.tools.definitions(agent)`).
 *
 * The adapter adds no second store, no poller, no Agent materialization, no job
 * supervisor, no kill policy and no business timers. Every read is a fresh
 * projection rebuilt from native values and validated as `unknown`; a failed or
 * stale read is reported as unavailable/incomplete rather than as an empty
 * authoritative list. Reads validate the current attachment identity before and
 * after every native call. No stdout is written: diagnostics go to the injected
 * warning sink and are credential-redacted.
 *
 * @module dsh-tui/backend/native-inspection
 */
import { isAbsolute } from 'node:path'
import { redactDiagnostic } from './errors.ts'
import type { NativeUiAccess, NativeUiScope } from './native-ui-scope.ts'
import type { NativeUiDomain } from './types.ts'

// ---------------------------------------------------------------- DTO types

/** Why a native read could not answer; never a synthetic empty value. */
export type InspectionReason =
  | 'no-attachment'
  | 'stale-attachment'
  | 'missing-service'
  | 'native-failed'
  | 'malformed'
  | 'no-session'
  | 'no-agent'
  | 'invalid-request'

/** One read that could not produce a projection the UI may display. */
export interface InspectionUnavailable {
  readonly available: false
  readonly reason: InspectionReason
}

/** Native job lifecycle, with `unknown` for a value outside the public union. */
export type JobPhase = 'running' | 'stopping' | 'completed' | 'killed' | 'failed' | 'unknown'

/** One job-row projection; identity, lifecycle and retained-output coordinates only. */
export interface InspectedJob {
  /** Registry-issued `<kind>-<short-uuid>` id. */
  readonly id: string
  /** Producer kind (`bash`, …), an open native string. */
  readonly kind: string
  /** Producer-supplied one-line label. */
  readonly label: string
  readonly status: JobPhase
  /** True for the current Session's own job; false for a native unowned job. */
  readonly owned: boolean
  /** Epoch ms when the job was registered. */
  readonly startedAt: number
  /** Epoch ms when the job settled; absent while live. */
  readonly finishedAt?: number
  /** Live progress line, cleared natively at settlement. */
  readonly progress?: string
  /** Terminal reason; a recorded kill reason is already merged by the registry. */
  readonly detail?: string
  /**
   * Output-ring coordinates. `total` is the next chunk offset, `earliest` the
   * oldest retained byte; `evicted` is `earliest > 0`. Host spill paths are
   * deliberately not exposed.
   */
  readonly output: {
    readonly total: number
    readonly earliest: number
    readonly evicted: boolean
  }
}

/** The caller-visible job roster for one attachment. */
export interface JobsSnapshot {
  readonly available: true
  /** False when a native row could not be validated (rows are then omitted). */
  readonly complete: boolean
  readonly sessionId: string
  readonly jobs: readonly InspectedJob[]
}

export type JobsRead = JobsSnapshot | InspectionUnavailable

/** One retained output chunk, sanitized for terminal display. */
export interface JobOutputChunkView {
  /** Absolute offset of the chunk's first byte; never rewritten. */
  readonly at: number
  readonly text: string
  readonly channel?: 'stdout' | 'stderr' | 'log'
  /** Bytes immediately before this chunk were lost at the producer. */
  readonly gapBefore?: true
}

/**
 * One non-consuming read of a job's retained output ring.
 *
 * `next` is always a chunk boundary the caller may pass back as `from`; when a
 * single chunk exceeds the byte budget the adapter ships a bounded head and
 * reports `truncated`, because a mid-chunk resume would duplicate text.
 */
export interface JobOutputSnapshot {
  readonly available: true
  readonly complete: boolean
  readonly sessionId: string
  readonly job: InspectedJob
  readonly from: number
  readonly next: number
  /** The native ring dropped bytes before `from` (or the adapter's bound did). */
  readonly lossy: boolean
  readonly truncated: boolean
  readonly chunks: readonly JobOutputChunkView[]
}

export type JobOutputRead = JobOutputSnapshot | InspectionUnavailable

/** Durable goal phase. */
export type GoalPhaseView = 'active' | 'paused' | 'blocked' | 'complete'

/** Process-local continuation eligibility; never persisted by DSH. */
export type GoalActivationView = 'armed' | 'disarmed'

/** One current goal, projected from `ctx.goals.get(agent)` or the durable `goal` projection. */
export interface GoalStateView {
  readonly id: string
  /** Positive revision; every durable mutation increments it. */
  readonly revision: number
  readonly objective: string
  readonly phase: GoalPhaseView
  readonly maxGoalRounds: number
  readonly roundsStarted: number
  readonly createdAt?: number
  readonly updatedAt?: number
  /**
   * Present only when the exact live Agent answered `goals.get`; the durable
   * projection deliberately does not carry activation.
   */
  readonly activation?: GoalActivationView
  readonly blockedReason?: { readonly code: string; readonly message: string }
}

/** Current goal state for one attachment; `goal: null` means a successful read saw no goal. */
export interface GoalSnapshot {
  readonly available: true
  /** False when activation (or the whole live view) could not be read. */
  readonly complete: boolean
  readonly sessionId: string
  readonly goal: GoalStateView | null
}

export type GoalRead = GoalSnapshot | InspectionUnavailable

/**
 * Effective working directory for one Session.
 *
 * `workspaceCwd` is the immutable Session header project; `effectiveCwd` is the
 * native committed directory (`ctx.workingDirectory.get`). The adapter never
 * sets, validates or rewrites either value.
 */
export interface WorkingDirectorySnapshot {
  readonly available: true
  /** False when the effective directory could only be inferred from partial data. */
  readonly complete: boolean
  readonly sessionId: string
  readonly workspaceCwd?: string
  readonly effectiveCwd?: string
  /** Projection value: `null` = no recorded change; absent = projection unavailable. */
  readonly recordedCwd?: string | null
  /** `effectiveCwd !== workspaceCwd` when both are known. */
  readonly redirected: boolean
}

export type WorkingDirectoryRead = WorkingDirectorySnapshot | InspectionUnavailable

/** Live Loader fiber phase; null when the entry has no live root Fiber. */
export type PluginFiberPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null

/** Whitelisted non-group Loader entry. Package metadata/conditions are omitted. */
export interface PluginEntryView {
  readonly entryId: string
  /** Exact module specifier imported by the Loader entry. */
  readonly moduleName: string
  readonly enabled: boolean
  readonly fiberPhase: PluginFiberPhase
}

/** Whitelisted agent-preset composition row. */
export interface PluginRowView {
  readonly entryId: string | null
  readonly moduleName: string
  /** `'conditional'` is the native value for an unevaluated `!!js` disable expression. */
  readonly enabled: boolean | 'conditional'
  readonly fiberPhase: PluginFiberPhase
}

/** One agent preset's identity and composition rows. */
export interface PluginPresetGroupView {
  readonly id: string
  readonly name?: string
  readonly isDefault: boolean
  /** The preset's composition cannot be read; row text is native-owned and omitted. */
  readonly broken?: true
  readonly rows: readonly PluginRowView[]
}

/** Derived inventory counts; a capability summary, never entry configuration. */
export interface PluginInventorySummary {
  readonly total: number
  readonly enabled: number
  readonly disabled: number
  readonly active: number
  readonly failed: number
  readonly pending: number
  /** Native rows/diagnostics dropped because their shape was invalid. */
  readonly malformed: number
}

/** Derived, redacted startup diagnostic for one entry. */
export interface PluginDiagnosticView {
  readonly entryId: string
  readonly message: string
}

/** Read-only Loader/agent-preset inventory returned by the public helper. */
export interface PluginInventorySnapshot {
  readonly available: true
  /** False when rows/diagnostics were dropped or a preset composition was unreadable. */
  readonly complete: boolean
  readonly entries: readonly PluginEntryView[]
  readonly summary: PluginInventorySummary
  readonly diagnostics: readonly PluginDiagnosticView[]
  readonly diagnosticsTruncated: boolean
  readonly presets?: readonly PluginPresetGroupView[]
}

export type PluginInventoryRead = PluginInventorySnapshot | InspectionUnavailable

/** One tool visible to the exact active Agent; no schema, body or executor. */
export interface ToolCatalogEntryView {
  readonly name: string
  /** Bounded, control-stripped declaration text. */
  readonly description: string
  /** `tools.executable(name, agent)` resolves a definition outside a model step. */
  readonly executable: boolean
  readonly deferredLoading: boolean
  readonly presenter: { readonly call: boolean; readonly result: boolean }
}

/** The active Agent's tool catalog and its capability counts. */
export interface ToolCatalogSnapshot {
  readonly available: true
  readonly complete: boolean
  readonly sessionId: string
  readonly tools: readonly ToolCatalogEntryView[]
  readonly summary: {
    readonly total: number
    readonly executable: number
    readonly deferred: number
  }
}

export type ToolCatalogRead = ToolCatalogSnapshot | InspectionUnavailable

/** Native job invalidations, already filtered to one Session's visible set. */
export type JobInvalidation = {
  readonly kind: 'jobs'
  readonly sessionId: string
  readonly reason: 'registered' | 'progress' | 'stopping' | 'settled' | 'removed' | 'output'
  readonly jobId?: string
}

/** Goal operations of the native `goal/changed` event. */
export type GoalOperationView = 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'block' | 'clear'

/** Native goal invalidation, already filtered to the current attachment's session/agent. */
export type GoalInvalidation = {
  readonly kind: 'goal'
  readonly sessionId: string
  readonly operation: GoalOperationView
  readonly goalId?: string
  readonly revision?: number
}

// ------------------------------------------------------------ adapter options

/** Constructor contract; the parent owns the attachment seam. */
export interface NativeInspectionOptions {
  readonly access: NativeUiAccess
  /**
   * Public `readPluginInventory(ctx)` from `@deepseek-ai/dsh-host-plugin-inventory`.
   * Absent means the capability stays unavailable; the adapter never imports a
   * private Web controller or invents a Loader walk.
   */
  readonly readPluginInventory?: (host: unknown) => Promise<unknown>
  /** Soft per-read output budget in UTF-8 bytes (default 65536). */
  readonly maxOutputBytes?: number
  /** Bound for labels, status text, descriptions and diagnostics (default 512). */
  readonly maxTextChars?: number
  /** Diagnostics retained per plugin inventory read (default 20). */
  readonly maxDiagnostics?: number
  /** Adapter diagnostics (never stdout); falls back to `access.warn`. */
  readonly warn?: (message: string) => void
}

const DEFAULT_MAX_OUTPUT_BYTES = 65536
const DEFAULT_MAX_TEXT_CHARS = 512
const DEFAULT_MAX_DIAGNOSTICS = 20
const MAX_JOB_ID_CHARS = 128
const MAX_TOOL_ROWS = 1024
const MAX_PRESET_ROWS = 1024

// ---------------------------------------------------------------- validation

type UnknownRecord = Record<string, unknown>

function unavailable(reason: InspectionReason): InspectionUnavailable {
  return { available: false, reason }
}

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined
}

function positiveBound(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** A native identifier: non-empty, bounded and free of control characters. */
function identifier(value: unknown, max = 256): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return undefined
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return undefined
  return value
}

const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

/**
 * Remove terminal control sequences and normalize line endings. Job output is
 * the user's own command output: credentials are not rewritten here (the web
 * terminal shows the same bytes), but escape sequences must never reach the
 * renderer.
 */
function sanitizeText(value: string): string {
  return value
    .replace(ANSI_OSC, '')
    .replace(ANSI_CSI, '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS, '')
}

function truncateText(value: string, max: number): { text: string; truncated: boolean } {
  if (value.length <= max) return { text: value, truncated: false }
  let end = max
  if (end > 0) {
    const code = value.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff) end -= 1
  }
  return { text: value.slice(0, end), truncated: true }
}

function boundedText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const sanitized = sanitizeText(value)
  const trimmed = sanitized.trim()
  if (trimmed.length === 0) return undefined
  return truncateText(trimmed, max).text
}

function boundedMessage(value: string, max: number): string {
  return truncateText(sanitizeText(value), max).text
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/** Longest whole-code-point head that fits `maxBytes`; never splits a surrogate pair. */
function headByBytes(value: string, maxBytes: number): string {
  let bytes = 0
  let end = 0
  for (const char of value) {
    const size = utf8Bytes(char)
    if (bytes + size > maxBytes) break
    bytes += size
    end += char.length
  }
  return value.slice(0, end)
}

function absolutePath(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return undefined
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return undefined
  return isAbsolute(value) ? value : undefined
}

const JOB_STATUSES = new Set(['running', 'stopping', 'completed', 'killed', 'failed'])
const GOAL_PHASES = new Set(['active', 'paused', 'blocked', 'complete'])
const GOAL_ACTIVATIONS = new Set(['armed', 'disarmed'])
const FIBER_PHASES = new Set(['pending', 'loading', 'active', 'failed', 'unloading'])
const JOB_CHANNELS = new Set(['stdout', 'stderr', 'log'])
const GOAL_OPERATIONS = new Set(['create', 'edit', 'pause', 'resume', 'complete', 'block', 'clear'])

function jobStatus(value: unknown): { status: JobPhase; valid: boolean } {
  return typeof value === 'string' && JOB_STATUSES.has(value)
    ? { status: value as JobPhase, valid: true }
    : { status: 'unknown', valid: false }
}

function jobChannel(value: unknown): 'stdout' | 'stderr' | 'log' | undefined {
  return typeof value === 'string' && JOB_CHANNELS.has(value)
    ? value as 'stdout' | 'stderr' | 'log'
    : undefined
}

function fiberPhaseOf(value: unknown): { phase: PluginFiberPhase; valid: boolean } {
  if (value === null) return { phase: null, valid: true }
  if (typeof value === 'string' && FIBER_PHASES.has(value)) {
    return { phase: value as Exclude<PluginFiberPhase, null>, valid: true }
  }
  return { phase: null, valid: false }
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : ''
}

function codeOf(error: unknown): string | undefined {
  const value = record(error)?.code
  return typeof value === 'string' ? value : undefined
}

// -------------------------------------------------------------- row mapping

interface MappedJob {
  readonly job?: InspectedJob
  /** A native row whose shape does not match the public contract. */
  readonly malformed: boolean
  /** A row owned by another Session (native `list` should never return one). */
  readonly foreign: boolean
}

/** Project one native `JobView` onto the whitelisted UI row. */
function mapJob(value: unknown, sessionId: string, maxText: number): MappedJob {
  const raw = record(value)
  if (raw === undefined) return { malformed: true, foreign: false }
  const id = identifier(raw.id, MAX_JOB_ID_CHARS)
  const kind = boundedText(raw.kind, maxText)
  const label = boundedText(raw.label, maxText)
  const startedAt = count(raw.startedAt)
  const output = record(raw.output)
  const total = count(output?.total)
  const earliest = count(output?.earliest)
  if (id === undefined || kind === undefined || label === undefined || startedAt === undefined || total === undefined || earliest === undefined) {
    return { malformed: true, foreign: false }
  }
  let owned = false
  if (raw.owner !== undefined) {
    const owner = identifier(raw.owner)
    if (owner === undefined) return { malformed: true, foreign: false }
    if (owner !== sessionId) return { malformed: false, foreign: true }
    owned = true
  }
  const phase = jobStatus(raw.status)
  const finishedAt = raw.finishedAt === undefined ? undefined : count(raw.finishedAt)
  const progress = raw.progress === undefined ? undefined : boundedText(raw.progress, maxText)
  const detail = raw.detail === undefined ? undefined : boundedText(raw.detail, maxText)
  const job: InspectedJob = {
    id,
    kind,
    label,
    status: phase.status,
    owned,
    startedAt,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(progress === undefined ? {} : { progress }),
    ...(detail === undefined ? {} : { detail }),
    output: { total, earliest, evicted: earliest > 0 },
  }
  return {
    malformed: !phase.valid || (raw.finishedAt !== undefined && finishedAt === undefined),
    foreign: false,
    job,
  }
}

interface MappedGoal {
  readonly goal?: GoalStateView
  /** The native value was structurally invalid. */
  readonly malformed: boolean
}

/** Project one native `GoalView` (activation included). */
function mapGoalView(value: unknown, maxText: number): MappedGoal {
  const raw = record(value)
  if (raw === undefined) return { malformed: true }
  const id = identifier(raw.id)
  const revision = count(raw.revision)
  const objective = boundedText(raw.objective, maxText)
  const maxGoalRounds = count(raw.maxGoalRounds)
  const roundsStarted = count(raw.roundsStarted)
  const createdAt = raw.createdAt === undefined ? undefined : count(raw.createdAt)
  const updatedAt = raw.updatedAt === undefined ? undefined : count(raw.updatedAt)
  const phase = raw.phase
  const activation = raw.activation
  const blocked = raw.blockedReason === undefined ? undefined : record(raw.blockedReason)
  if (
    id === undefined || revision === undefined || revision === 0 || objective === undefined ||
    maxGoalRounds === undefined || roundsStarted === undefined ||
    typeof phase !== 'string' || !GOAL_PHASES.has(phase) ||
    typeof activation !== 'string' || !GOAL_ACTIVATIONS.has(activation) ||
    (raw.createdAt !== undefined && createdAt === undefined) ||
    (raw.updatedAt !== undefined && updatedAt === undefined)
  ) {
    return { malformed: true }
  }
  let blockedReason: GoalStateView['blockedReason']
  if (blocked !== undefined) {
    const code = identifier(blocked.code, 128)
    const message = boundedText(blocked.message, maxText)
    if (code === undefined || message === undefined) return { malformed: true }
    blockedReason = { code, message }
  }
  return {
    malformed: false,
    goal: {
      id,
      revision,
      objective,
      phase: phase as GoalPhaseView,
      maxGoalRounds,
      roundsStarted,
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
      activation: activation as GoalActivationView,
      ...(blockedReason === undefined ? {} : { blockedReason }),
    },
  }
}

/** Project the durable `goal` projection value (activation deliberately absent). */
function mapGoalProjection(value: unknown, maxText: number): MappedGoal {
  const raw = record(value)
  if (raw === undefined) return { malformed: true }
  const snapshot = record(raw.goal)
  const roundsStarted = count(raw.roundsStarted)
  const createdAt = raw.createdAt === undefined ? undefined : count(raw.createdAt)
  const updatedAt = raw.updatedAt === undefined ? undefined : count(raw.updatedAt)
  if (snapshot === undefined || roundsStarted === undefined) return { malformed: true }
  const id = identifier(snapshot.id)
  const revision = count(snapshot.revision)
  const objective = boundedText(snapshot.objective, maxText)
  const maxGoalRounds = count(snapshot.maxGoalRounds)
  const phase = snapshot.phase
  const blocked = snapshot.blockedReason === undefined ? undefined : record(snapshot.blockedReason)
  if (
    id === undefined || revision === undefined || revision === 0 || objective === undefined ||
    maxGoalRounds === undefined ||
    typeof phase !== 'string' || !GOAL_PHASES.has(phase) ||
    (raw.createdAt !== undefined && createdAt === undefined) ||
    (raw.updatedAt !== undefined && updatedAt === undefined)
  ) {
    return { malformed: true }
  }
  let blockedReason: GoalStateView['blockedReason']
  if (blocked !== undefined) {
    const code = identifier(blocked.code, 128)
    const message = boundedText(blocked.message, maxText)
    if (code === undefined || message === undefined) return { malformed: true }
    blockedReason = { code, message }
  }
  return {
    malformed: false,
    goal: {
      id,
      revision,
      objective,
      phase: phase as GoalPhaseView,
      maxGoalRounds,
      roundsStarted,
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
      ...(blockedReason === undefined ? {} : { blockedReason }),
    },
  }
}

// ------------------------------------------------------------ pure event maps

/** Read-only native UI domains this adapter projects. */
export type InspectionDomain = Extract<NativeUiDomain, 'jobs' | 'goal' | 'working-directory' | 'inventory' | 'tools'>

/**
 * Map one public `sessionProjections.onChanged` key onto the neutral domain the
 * parent should invalidate. Keys owned by other views (`todos`, `plan`, …) and
 * unknown keys return `undefined`.
 *
 * The parent already subscribes to this feed for its live Session; binding this
 * mapping adds no new subscription and no cache.
 */
export function projectionInvalidationDomain(key: unknown): 'goal' | 'working-directory' | undefined {
  if (key === 'goal') return 'goal'
  if (key === 'workingDirectory') return 'working-directory'
  return undefined
}

/**
 * Map one public `tools/change` notification to its neutral domain.
 *
 * `tools/change` is an unfiltered registry emit (a global registration affects
 * every Agent), so the parent must drop it unless the current attachment is
 * still the one whose catalog is displayed.
 */
export function toolsInvalidationDomain(): 'tools' {
  return 'tools'
}

/**
 * Map one public Loader/profile notification to its neutral domain.
 *
 * `readPluginInventory` has no change event of its own: bind
 * `app-boot/config-reload()`, `loader/entry-init(entry)`, `loader/config-update()`
 * and (when mounted) `plugin-manager/changed(change)`; each listener re-reads.
 */
export function inventoryInvalidationDomain(): 'inventory' {
  return 'inventory'
}

/**
 * Map one native `jobs.events` event onto a Session-filtered invalidation.
 *
 * The native filter already excludes other Sessions' owned jobs; this function
 * re-checks each event's owner so a hostile/older registry cannot leak another
 * Session's job identity, and validates the job id before the UI refetches.
 */
export function jobEventInvalidation(event: unknown, sessionId: string): JobInvalidation | undefined {
  const raw = record(event)
  if (raw === undefined || typeof sessionId !== 'string' || sessionId.length === 0) return undefined
  const type = raw.type
  if (type === 'registered' || type === 'progress' || type === 'stopping' || type === 'removed') {
    const job = record(raw.job)
    const id = identifier(job?.id, MAX_JOB_ID_CHARS)
    const owner = job?.owner
    if (id === undefined) return undefined
    if (owner !== undefined && owner !== sessionId) return undefined
    return { kind: 'jobs', sessionId, reason: type, jobId: id }
  }
  if (type === 'settled') {
    const job = record(raw.job)
    const id = identifier(job?.id, MAX_JOB_ID_CHARS)
    const owner = job?.owner
    if (id === undefined) return undefined
    if (owner !== undefined && owner !== sessionId) return undefined
    return { kind: 'jobs', sessionId, reason: 'settled', jobId: id }
  }
  if (type === 'output') {
    const id = identifier(raw.id, MAX_JOB_ID_CHARS)
    const owner = raw.owner
    if (id === undefined) return undefined
    if (owner !== undefined && owner !== sessionId) return undefined
    return { kind: 'jobs', sessionId, reason: 'output', jobId: id }
  }
  return undefined
}

/**
 * Map one native `goal/changed` payload onto an invalidation bound to the
 * supplied current attachment. A foreign session, a different live Agent or a
 * malformed payload yields `undefined`; the parent must still re-check
 * `access.isCurrent` before applying the result.
 */
export function goalChangedInvalidation(
  payload: unknown,
  scope: { readonly sessionId: string; readonly agent?: unknown } | undefined,
): GoalInvalidation | undefined {
  if (scope === undefined) return undefined
  const raw = record(payload)
  const agent = record(raw?.agent)
  const session = record(agent?.session)
  const sessionId = identifier(session?.id)
  if (sessionId === undefined || sessionId !== scope.sessionId) return undefined
  if (scope.agent !== undefined && raw?.agent !== scope.agent) return undefined
  const change = record(raw?.change)
  const operation = change?.operation
  if (typeof operation !== 'string' || !GOAL_OPERATIONS.has(operation)) return undefined
  const ref = record(change?.ref)
  const goalId = identifier(ref?.id)
  const revision = ref?.revision === undefined ? undefined : count(ref.revision)
  if (ref !== undefined && goalId === undefined) return undefined
  return {
    kind: 'goal',
    sessionId,
    operation: operation as GoalOperationView,
    ...(goalId === undefined ? {} : { goalId }),
    ...(revision === undefined ? {} : { revision }),
  }
}

// -------------------------------------------------------- plugin inventory map

interface MappedPluginInventory {
  readonly snapshot?: PluginInventorySnapshot
  readonly malformed: boolean
}

function mapPluginInventory(
  value: unknown,
  options: { readonly maxText: number; readonly maxDiagnostics: number },
): MappedPluginInventory {
  const raw = record(value)
  const rawEntries = raw?.entries
  if (raw === undefined || !Array.isArray(rawEntries)) return { malformed: true }
  const entries: PluginEntryView[] = []
  const diagnostics: PluginDiagnosticView[] = []
  let malformed = 0
  let enabled = 0
  let disabled = 0
  let active = 0
  let failed = 0
  let pending = 0
  let droppedDiagnostics = 0
  let truncated = false
  for (const item of rawEntries) {
    const entry = record(item)
    const entryId = identifier(entry?.entryId, 512)
    const moduleName = boundedText(entry?.moduleName, options.maxText)
    const enabledFlag = typeof entry?.enabled === 'boolean' ? entry.enabled : undefined
    const phase = fiberPhaseOf(entry?.fiberPhase)
    if (entryId === undefined || moduleName === undefined || enabledFlag === undefined || !phase.valid) {
      malformed += 1
      continue
    }
    entries.push({ entryId, moduleName, enabled: enabledFlag, fiberPhase: phase.phase })
    if (enabledFlag) enabled += 1
    else disabled += 1
    if (phase.phase === 'active') active += 1
    else if (phase.phase === 'failed') failed += 1
    else if (phase.phase === 'pending') pending += 1
    if (entry?.diagnostic !== undefined) {
      const message = boundedMessage(redactDiagnostic(errorText(entry.diagnostic)), options.maxText)
      if (message.length === 0) malformed += 1
      else if (diagnostics.length < options.maxDiagnostics) diagnostics.push({ entryId, message })
      else droppedDiagnostics += 1
    }
  }

  let presets: PluginPresetGroupView[] | undefined
  const rawPresets = raw.agentPresets
  if (rawPresets !== undefined) {
    if (!Array.isArray(rawPresets)) {
      malformed += 1
    } else {
      presets = []
      for (const rawGroup of rawPresets) {
        const group = record(rawGroup)
        const id = identifier(group?.id)
        const rows = group?.rows
        if (id === undefined || !Array.isArray(rows)) {
          malformed += 1
          continue
        }
        const mappedRows: PluginRowView[] = []
        if (rows.length > MAX_PRESET_ROWS) truncated = true
        for (const rawRow of rows.slice(0, MAX_PRESET_ROWS)) {
          const row = record(rawRow)
          const moduleName = boundedText(row?.moduleName, options.maxText)
          const rowId = row?.entryId === null ? null : identifier(row?.entryId)
          const rowEnabled = row?.enabled
          const phase = fiberPhaseOf(row?.fiberPhase)
          if (
            moduleName === undefined || rowId === undefined || !phase.valid ||
            (typeof rowEnabled !== 'boolean' && rowEnabled !== 'conditional')
          ) {
            malformed += 1
            continue
          }
          mappedRows.push({
            entryId: rowId,
            moduleName,
            enabled: rowEnabled,
            fiberPhase: phase.phase,
          })
        }
        const name = boundedText(group?.name, options.maxText)
        presets.push({
          id,
          ...(name === undefined ? {} : { name }),
          isDefault: group?.isDefault === true,
          ...(group?.broken === undefined || group.broken === false ? {} : { broken: true as const }),
          rows: mappedRows,
        })
      }
    }
  }

  const malformedTotal = malformed > 0
  return {
    malformed: malformedTotal,
    snapshot: {
      available: true,
      complete: malformed === 0 && droppedDiagnostics === 0 && !truncated,
      entries,
      summary: {
        total: entries.length,
        enabled,
        disabled,
        active,
        failed,
        pending,
        malformed,
      },
      diagnostics,
      diagnosticsTruncated: droppedDiagnostics > 0,
      ...(presets === undefined ? {} : { presets }),
    },
  }
}

// --------------------------------------------------------------- the adapter

/**
 * Read-only inspection facade over the supplied native host.
 *
 * All reads return either an `available: true` snapshot (with `complete`
 * reporting partial native data) or an `InspectionUnavailable` reason. No read
 * creates an Agent or Session, and none writes native state.
 */
export class NativeInspection {
  private readonly options: NativeInspectionOptions
  private readonly maxOutputBytes: number
  private readonly maxText: number
  private readonly maxDiagnostics: number
  private readonly warned = new Set<string>()

  constructor(options: NativeInspectionOptions) {
    this.options = options
    this.maxOutputBytes = positiveBound(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES)
    this.maxText = positiveBound(options.maxTextChars, DEFAULT_MAX_TEXT_CHARS)
    this.maxDiagnostics = positiveBound(options.maxDiagnostics, DEFAULT_MAX_DIAGNOSTICS)
  }

  // ------------------------------------------------------------- seam access

  private scope(): NativeUiScope | undefined {
    try {
      const scope = this.options.access.current()
      if (scope === undefined) return undefined
      if (typeof scope.sessionId !== 'string' || scope.sessionId.length === 0) return undefined
      return scope
    } catch {
      return undefined
    }
  }

  /** Attachment identity, never provider/model metadata, decides ownership. */
  private current(scope: NativeUiScope): boolean {
    try {
      if (!this.options.access.isCurrent(scope)) return false
      const current = this.options.access.current()
      if (current === undefined) return false
      return current.sessionId === scope.sessionId && current.attachmentId === scope.attachmentId
    } catch {
      return false
    }
  }

  private service(name: string): UnknownRecord | undefined {
    let value: unknown
    try {
      value = this.options.access.service(name)
    } catch {
      return undefined
    }
    return record(value)
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    const safe = redactDiagnostic(boundedMessage(message, this.maxText))
    try {
      // Preserve the seam method's receiver; it may rely on `this`.
      if (this.options.warn !== undefined) this.options.warn(safe)
      else this.options.access.warn?.(safe)
    } catch {
      /* diagnostics must never break the adapter */
    }
  }

  /**
   * Run one read against the current attachment: validate identity before and
   * after the native call, contain native failures, and drop stale results.
   */
  private async read<T extends { readonly available: true }>(
    label: string,
    run: (scope: NativeUiScope) => T | InspectionUnavailable | Promise<T | InspectionUnavailable>,
  ): Promise<T | InspectionUnavailable> {
    const scope = this.scope()
    if (scope === undefined) return unavailable('no-attachment')
    if (!this.current(scope)) return unavailable('stale-attachment')
    let result: T | InspectionUnavailable
    try {
      result = await run(scope)
    } catch (error) {
      if (!this.current(scope)) return unavailable('stale-attachment')
      this.warnOnce(`${label}:failed`, `${label} read failed: ${errorText(error)}`)
      return unavailable('native-failed')
    }
    if (!this.current(scope)) return unavailable('stale-attachment')
    return result
  }

  // ------------------------------------------------------------------- jobs

  /** The current Session's visible job roster (own plus native unowned jobs). */
  async jobs(): Promise<JobsRead> {
    return await this.read('jobs', scope => {
      const jobs = this.service('jobs')
      if (jobs === undefined || typeof jobs.list !== 'function') return unavailable('missing-service')
      const rows: unknown = jobs.list.call(jobs, scope.sessionId)
      if (!Array.isArray(rows)) return unavailable('malformed')
      const mapped: InspectedJob[] = []
      let incomplete = false
      for (const row of rows) {
        const job = mapJob(row, scope.sessionId, this.maxText)
        if (job.foreign) incomplete = true
        if (job.malformed) incomplete = true
        if (job.job !== undefined) mapped.push(job.job)
      }
      return { available: true, complete: !incomplete, sessionId: scope.sessionId, jobs: mapped }
    })
  }

  /**
   * Read one job's retained output without touching the model's consuming
   * cursor. A foreign or unknown job fails natively and is reported as
   * unavailable; it is never rendered as an empty ring.
   */
  async jobOutput(jobId: string, from?: number): Promise<JobOutputRead> {
    const id = identifier(jobId, MAX_JOB_ID_CHARS)
    if (id === undefined) return unavailable('invalid-request')
    if (from !== undefined && count(from) === undefined) return unavailable('invalid-request')
    return await this.read('job-output', scope => {
      const jobs = this.service('jobs')
      if (jobs === undefined || typeof jobs.get !== 'function' || typeof jobs.readAt !== 'function') {
        return unavailable('missing-service')
      }
      const job = mapJob(jobs.get.call(jobs, id, scope.sessionId), scope.sessionId, this.maxText)
      if (job.foreign) return unavailable('native-failed')
      if (job.job === undefined) return unavailable('malformed')
      const start = from ?? job.job.output.earliest
      const read = record(jobs.readAt.call(jobs, id, start, scope.sessionId))
      if (read === undefined || !Array.isArray(read.chunks)) return unavailable('malformed')
      const nativeNext = count(read.next)
      if (nativeNext === undefined) return unavailable('malformed')
      const lossy = read.lossy === true
      const chunks: JobOutputChunkView[] = []
      let bytes = 0
      let malformed = 0
      let oversize = false
      let droppedAt: number | undefined
      let previousAt = -1
      for (const rawChunk of read.chunks) {
        const chunk = record(rawChunk)
        const at = count(chunk?.at)
        const text = chunk?.text
        if (chunk === undefined || at === undefined || typeof text !== 'string' || at < previousAt) {
          malformed += 1
          continue
        }
        previousAt = at
        if (droppedAt !== undefined) continue
        const sanitized = sanitizeText(text)
        const size = utf8Bytes(sanitized)
        const channel = jobChannel(chunk.channel)
        const gapBefore = chunk.gapBefore === true
        if (bytes + size > this.maxOutputBytes) {
          if (chunks.length === 0) {
            const head = headByBytes(sanitized, this.maxOutputBytes)
            if (head.length > 0) {
              bytes += utf8Bytes(head)
              chunks.push({
                at,
                text: head,
                ...(channel === undefined ? {} : { channel }),
                ...(gapBefore ? { gapBefore: true as const } : {}),
              })
            }
            // An empty head still means the caller must not resume mid-chunk.
            oversize = true
          } else {
            droppedAt = at
          }
          continue
        }
        bytes += size
        chunks.push({
          at,
          text: sanitized,
          ...(channel === undefined ? {} : { channel }),
          ...(gapBefore ? { gapBefore: true as const } : {}),
        })
      }
      // A truncated single chunk cannot resume mid-chunk without duplicating
      // text; otherwise resume exactly at the first chunk this read omitted.
      const next = oversize ? nativeNext : droppedAt ?? nativeNext
      return {
        available: true,
        complete: malformed === 0 && !job.malformed,
        sessionId: scope.sessionId,
        job: job.job,
        from: start,
        next,
        lossy,
        truncated: oversize || droppedAt !== undefined,
        chunks,
      }
    })
  }

  /**
   * Subscribe to the current Session's native job invalidations.
   *
   * The listener runs only while the subscribed attachment is still current and
   * receives no native payload objects. Returns a disposer; a missing service,
   * pending attachment or hostile registry yields a no-op disposer.
   */
  subscribeJobs(listener: (event: JobInvalidation) => void): () => void {
    const scope = this.scope()
    if (scope === undefined || !this.current(scope)) return () => {}
    const jobs = this.service('jobs')
    if (jobs === undefined) return () => {}
    let events: UnknownRecord | undefined
    try {
      events = record(jobs.events)
    } catch {
      return () => {}
    }
    const subscribe = events?.subscribe
    if (typeof subscribe !== 'function') return () => {}
    const onEvent = (raw: unknown): void => {
      if (!this.current(scope)) return
      const mapped = jobEventInvalidation(raw, scope.sessionId)
      if (mapped === undefined) return
      try {
        listener(mapped)
      } catch {
        /* a UI listener bug must not break native dispatch */
      }
    }
    try {
      const disposer: unknown = subscribe.call(events, { owner: scope.sessionId }, onEvent)
      return typeof disposer === 'function' ? disposer as () => void : () => {}
    } catch (error) {
      this.warnOnce('jobs:subscribe', `jobs invalidation subscription failed: ${errorText(error)}`)
      return () => {}
    }
  }

  // ------------------------------------------------------------------- goal

  /**
   * Read the current goal. Prefers the exact live Agent's `goals.get` (durable
   * state plus activation) and falls back to the durable `goal` projection
   * without materializing an Agent; `goal: null` is only returned by a
   * successful read.
   */
  async goal(): Promise<GoalRead> {
    return await this.read('goal', scope => {
      const session = record(scope.session)
      const goals = this.service('goals')
      const projections = this.service('sessionProjections')
      const getGoal = goals?.get
      const readProjections = projections?.snapshot
      const hasLive = typeof getGoal === 'function' && goals !== undefined && scope.agent !== undefined
      const hasProjection = session !== undefined && typeof readProjections === 'function' && projections !== undefined
      if (!hasLive && !hasProjection) {
        if (goals === undefined && projections === undefined) return unavailable('missing-service')
        return unavailable(session === undefined ? 'no-session' : 'missing-service')
      }

      let goal: GoalStateView | null | undefined
      let activationKnown = false
      let malformed = false

      if (hasLive && goals !== undefined && typeof getGoal === 'function') {
        try {
          const raw = getGoal.call(goals, scope.agent)
          if (raw === undefined) {
            goal = null
            activationKnown = true
          } else {
            const mapped = mapGoalView(raw, this.maxText)
            if (mapped.malformed || mapped.goal === undefined) malformed = true
            else {
              goal = mapped.goal
              activationKnown = mapped.goal.activation !== undefined
            }
          }
        } catch (error) {
          // `GOAL_AGENT_NOT_LIVE` is expected after an attachment switch; the
          // durable projection is still authoritative for the durable fields.
          if (codeOf(error) !== 'GOAL_AGENT_NOT_LIVE') {
            this.warnOnce('goal:get', `goal read failed: ${errorText(error)}`)
          }
        }
      }

      if (
        goal === undefined && hasProjection && session !== undefined &&
        projections !== undefined && typeof readProjections === 'function'
      ) {
        let snapshot: unknown
        try {
          snapshot = readProjections.call(projections, session, ['goal'])
        } catch (error) {
          this.warnOnce('goal:projection', `goal projection read failed: ${errorText(error)}`)
          return unavailable('native-failed')
        }
        const values = record(record(snapshot)?.values)
        if (values === undefined || !('goal' in values)) {
          return unavailable('missing-service')
        }
        if (values.goal === null) {
          goal = null
        } else {
          const mapped = mapGoalProjection(values.goal, this.maxText)
          if (mapped.malformed || mapped.goal === undefined) malformed = true
          else goal = mapped.goal
        }
      }

      if (goal === undefined) {
        if (malformed) return unavailable('malformed')
        if (session === undefined) return unavailable('no-session')
        return unavailable('missing-service')
      }
      return {
        available: true,
        complete: activationKnown && !malformed,
        sessionId: scope.sessionId,
        goal,
      }
    })
  }

  // -------------------------------------------------------- working directory

  /**
   * Read the immutable Session project directory and the current effective
   * directory. Never sets the directory, validates it on the filesystem, or
   * rewrites terminal/OSC7 state.
   */
  async workingDirectory(): Promise<WorkingDirectoryRead> {
    return await this.read('working-directory', scope => {
      const session = record(scope.session)
      if (session === undefined) return unavailable('no-session')
      const header = record(session.header)
      const workspaceCwd = absolutePath(header?.cwd)
      const service = this.service('workingDirectory')
      const projections = this.service('sessionProjections')
      let effectiveCwd: string | undefined
      let recordedCwd: string | null | undefined
      let complete = false
      let malformed = false

      if (service !== undefined && typeof service.get === 'function') {
        try {
          const value: unknown = service.get.call(service, session)
          const read = absolutePath(value)
          if (read === undefined) malformed = true
          else {
            effectiveCwd = read
            complete = true
          }
        } catch (error) {
          this.warnOnce('working-directory:get', `working directory read failed: ${errorText(error)}`)
        }
      }

      if (projections !== undefined && typeof projections.snapshot === 'function') {
        try {
          const values = record(record(projections.snapshot(session, ['workingDirectory']))?.values)
          if (values !== undefined && 'workingDirectory' in values) {
            const value = values.workingDirectory
            if (value === null) recordedCwd = null
            else {
              const read = absolutePath(value)
              if (read === undefined) malformed = true
              else recordedCwd = read
            }
          }
        } catch (error) {
          this.warnOnce('working-directory:projection', `working directory projection read failed: ${errorText(error)}`)
        }
      }

      if (effectiveCwd === undefined && recordedCwd !== undefined) {
        // Projection fallback: the recorded directory is native truth, but the
        // service getter (with its deployment default) was unavailable.
        effectiveCwd = recordedCwd ?? workspaceCwd
        if (effectiveCwd !== undefined) complete = false
      }

      if (effectiveCwd === undefined && workspaceCwd === undefined) {
        return unavailable(malformed ? 'malformed' : 'native-failed')
      }
      return {
        available: true,
        complete: complete && !malformed,
        sessionId: scope.sessionId,
        ...(workspaceCwd === undefined ? {} : { workspaceCwd }),
        ...(effectiveCwd === undefined ? {} : { effectiveCwd }),
        ...(recordedCwd === undefined ? {} : { recordedCwd }),
        redirected: effectiveCwd !== undefined && workspaceCwd !== undefined && effectiveCwd !== workspaceCwd,
      }
    })
  }

  // -------------------------------------------------------- plugin inventory

  /**
   * Read the native Loader/agent-preset inventory through the public async
   * helper. Package metadata, disable conditions and every config value are
   * omitted; diagnostics are credential-redacted and bounded.
   */
  async pluginInventory(): Promise<PluginInventoryRead> {
    const helper = this.options.readPluginInventory
    if (helper === undefined) return unavailable('missing-service')
    const host = this.options.access.host
    if (host === undefined || host === null) return unavailable('missing-service')
    return await this.read('plugin-inventory', async () => {
      let raw: unknown
      try {
        raw = await helper(host)
      } catch (error) {
        this.warnOnce('plugin-inventory:read', `plugin inventory read failed: ${errorText(error)}`)
        return unavailable('native-failed')
      }
      const mapped = mapPluginInventory(raw, { maxText: this.maxText, maxDiagnostics: this.maxDiagnostics })
      if (mapped.snapshot === undefined) return unavailable('malformed')
      return mapped.snapshot
    })
  }

  // ------------------------------------------------------------ tool catalog

  /**
   * Enumerate the exact active Agent's visible tool definitions. Without a live
   * Agent (a pending attachment) the read is unavailable: enumerating the
   * global or preset view would not describe this attachment, and no read here
   * may materialize an Agent.
   */
  async toolCatalog(): Promise<ToolCatalogRead> {
    return await this.read('tool-catalog', scope => {
      if (scope.agent === undefined) return unavailable('no-agent')
      const tools = this.service('tools')
      const definitionsOf = tools?.definitions
      if (tools === undefined || typeof definitionsOf !== 'function') return unavailable('missing-service')
      const readExecutable = tools.executable
      const definitions: unknown = definitionsOf.call(tools, scope.agent)
      if (!Array.isArray(definitions)) return unavailable('malformed')
      const executableOf = typeof readExecutable === 'function'
        ? (name: string): boolean => {
            try {
              return readExecutable.call(tools, name, scope.agent) !== undefined
            } catch {
              return false
            }
          }
        : (): boolean => false
      const rows: ToolCatalogEntryView[] = []
      let malformed = 0
      let truncated = false
      for (const rawDefinition of definitions) {
        if (rows.length + malformed >= MAX_TOOL_ROWS) {
          truncated = true
          break
        }
        const definition = record(rawDefinition)
        const name = identifier(definition?.name, 256)
        if (name === undefined) {
          malformed += 1
          continue
        }
        const description = typeof definition?.description === 'string'
          ? boundedText(definition.description, this.maxText) ?? ''
          : ''
        if (typeof definition?.description !== 'string') malformed += 1
        rows.push({
          name,
          description,
          executable: executableOf(name),
          deferredLoading: definition?.deferLoading === true,
          presenter: {
            call: typeof definition?.presentCall === 'function',
            result: typeof definition?.presentResult === 'function',
          },
        })
      }
      let executable = 0
      let deferred = 0
      for (const row of rows) {
        if (row.executable) executable += 1
        if (row.deferredLoading) deferred += 1
      }
      return {
        available: true,
        complete: malformed === 0 && !truncated,
        sessionId: scope.sessionId,
        tools: rows,
        summary: { total: rows.length, executable, deferred },
      }
    })
  }
}