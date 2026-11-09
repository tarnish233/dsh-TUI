/**
 * Native subagent-tree bridge.
 *
 * DSH owns every durable subagent fact: directory enumeration (stable pre-order,
 * per-catalog event order, branch diagnostics), the parent-owned
 * `subagent/catalog` projection, each child's `subagent` identity,
 * `subagentTiming` and `tokenUsage` projections, the `subagent/start` /
 * `subagent/end` lifecycle pair and the child Agent/Session events.
 *
 * Structure and diagnostics come from the public `ctx.subagents`
 * `listDescendants` / `listChildren` methods, which own the recursive catalog
 * walk, the observation lease per branch and the external-leaf rule; this
 * adapter never re-walks catalogs itself. Per-row display facts that native rows
 * do not carry (identity, timing, usage, route) come from the public resident
 * surface — `ctx.sessions.get(id)` identity plus
 * `sessionProjections.snapshot(session, keys)` over exactly the keys a row folds
 * — and only a child that is not resident takes the `sessionQuery.observeSession`
 * lease, a cold-safe live-preferred observation that creates no Agent. The live
 * projection change feed still updates rows between reads.
 *
 * Nothing here creates, resumes, prompts, interrupts or persists a subagent.
 * `runId` is process-local: it is kept for the lifetime of this adapter and is
 * never derived from durable state. A cold catalog row therefore carries no
 * run identity and its status is `unknown` until a native fact proves more.
 *
 * @module dsh-tui/backend/subagents
 */
import { backendError } from './errors.ts'
import type {
  BackendEvent,
  DecisionOrigin,
  SubagentDiagnostic,
  SubagentEntry,
  SubagentMode,
  SubagentSnapshot,
  SubagentStatus,
  SubagentTiming,
} from './types.ts'

/** The only host capability this bridge needs: public service lookup. */
export interface SubagentHost {
  get(name: string): unknown
}

export interface SubagentBridgeOptions {
  readonly host: SubagentHost
  readonly emit: (event: BackendEvent) => void
  readonly warn?: (message: string) => void
}

/** One durable session header field set this bridge reads. */
export interface SubagentHeader {
  readonly id: string
  readonly createdAt?: number
  readonly cwd?: string
  readonly parentSession?: string
  readonly origin?: string
  readonly delegationDepth?: number
  readonly agentPreset?: string
  readonly isSeeded?: boolean
}

/** One bounded durable read of a child Session used by 'subagent-session'. */
export interface SubagentSessionRead {
  readonly header: SubagentHeader | undefined
  readonly inheritedEventCount: number
  readonly events: readonly unknown[]
  readonly values: Record<string, unknown> | undefined
}

/** Tree membership of one requested child. */
export interface SubagentMembership {
  /** Durable direct parent, exactly as native lineage/catalog states it. */
  readonly parentSessionId: string
  readonly mode: SubagentMode
  /**
   * True when the child owns a local DSH Session/Agent. An `external` leaf has
   * no local session, so capability checks can reject it without guessing.
   */
  readonly local: boolean
  readonly label?: string
  /** True when native lineage proves the child while the catalog row is not loaded yet. */
  readonly untracked?: boolean
}

interface ObservationLike {
  readonly header?: unknown
  readonly inheritedEventCount?: unknown
  readonly events?: unknown
  readonly projections?: { readonly values?: unknown }
  [Symbol.dispose]?(): void
}

interface SessionQueryLike {
  observeSession?(id: string, options?: { readonly signal?: AbortSignal; readonly projectionMode?: 'all' | 'none' }): Promise<ObservationLike>
  readSession?(id: string): Promise<unknown>
}

interface SessionsLike {
  get?(id: string): unknown
}

interface AgentLike {
  readonly id?: unknown
  readonly status?: unknown
  readonly model?: { current?(): unknown }
}

interface AgentsLike {
  get?(id: string): AgentLike | undefined
}

/**
 * One native branch diagnostic for the current root.
 *
 * This is the shared metadata-only wire row `{id, parentSessionId, depth,
 * reason}`: opaque ids, the edge distance and the native diagnostic class. It
 * never carries a raw native error string or any credential.
 */
export type SubagentBranchDiagnostic = SubagentDiagnostic

/**
 * Structural view of the public `ctx.subagents` discovery surface.
 *
 * The recursive walk (pre-order, catalog event order, external leaves, branch
 * diagnostics and the per-branch observation release) belongs to DSH; this
 * adapter only validates the rows it receives. Optional methods keep a smaller
 * composition loadable and make {@link SubagentBridge.available} honest.
 */
interface SubagentListingLike {
  listDescendants?(rootSessionId: string, signal?: AbortSignal): Promise<unknown>
  listChildren?(parentSessionId: string, signal?: AbortSignal): Promise<unknown>
}

interface ProjectionsLike {
  snapshot?(session: unknown, keys?: readonly string[]): { readonly values?: unknown } | undefined
  restore?(
    checkpoint: Record<string, unknown>,
    events: readonly unknown[],
    baseSeq: number,
    header: unknown,
    inheritedEventCount: number,
  ): { readonly snapshot?: { readonly values?: unknown } } | undefined
}

interface RunState {
  readonly runId: string
  readonly provider?: string
  readonly local: boolean
}

interface EndState {
  readonly runId: string
  readonly stopReason: string
  readonly local: boolean
}

interface ChildNode {
  readonly id: string
  readonly parentSessionId: string
  readonly depth: number
  readonly catalogMode: SubagentMode
  readonly catalogLabel?: string
  /**
   * Catalog row creation time when native reported it, else the observed child
   * Session's own `createdAt` (the descendant listing drops the catalog row's
   * value). Never invented.
   */
  createdAt?: number
  /** Native branch diagnostic when this directory row itself could not be read. */
  readonly diagnostic?: SubagentDiagnosticReason
  catalogSeq?: number
  header?: SubagentHeader
  /** `null` is the projection's explicit "no valid descriptor" sentinel. */
  identity?: { readonly mode: Exclude<SubagentMode, 'external' | 'unknown'>; readonly label?: string } | null
  timing?: SubagentTiming
  totalTokens?: number
  route?: { readonly provider?: string; readonly model?: string; readonly reasoningEffort?: string }
}

interface TreeRead {
  readonly nodes: ChildNode[]
  /** Native branch diagnostics retained independently of the display rows. */
  readonly diagnostics: readonly SubagentBranchDiagnostic[]
  readonly truncated: boolean
}

/**
 * One row read served entirely from the resident public surface.
 *
 * `header` is the exact immutable `SessionHeader` of the resident Session and
 * `values` are the validated wire views of {@link ROW_PROJECTION_KEYS} at the
 * same cut — content-identical to what a live `observeSession` lease carries.
 */
interface ResidentRowRead {
  readonly header: SubagentHeader
  readonly values?: Record<string, unknown>
}

  /** Native branch-diagnostic vocabulary for an incomplete subagent subtree. */
type SubagentDiagnosticReason = SubagentDiagnostic['reason']

/** One validated native listing row: a catalog child or a branch diagnostic. */
interface ListedRow {
  readonly kind: 'child' | 'diagnostic'
  readonly id: string
  readonly parentId: string
  readonly depth: number
  /** Present on `child` rows only; an `unknown` mode is a native diagnostic. */
  readonly mode?: SubagentMode
  readonly label?: string
  readonly createdAt?: number
  readonly reason?: SubagentDiagnosticReason
}

/** One validated listing payload: accepted rows plus the rejected row count. */
interface ListedTree {
  readonly rows: ListedRow[]
  readonly rejected: number
}

/** Bound on one tree snapshot; beyond it the native data is incomplete. */
const MAX_TREE_ENTRIES = 200
const MAX_TREE_DEPTH = 8
/** Bound on one native listing call; the native walk releases its own leases. */
const MAX_LISTING_MS = 15_000
const MAX_SESSION_READ_MS = 5_000
const MAX_PENDING_RUNS = 64
const MAX_RUN_ENDS = 256
const MAX_FINISHED_RUNS = 128
const MAX_ACTIVITIES = 256
const MAX_ACTIVITY_CHARS = 64
const MAX_HEADER_CACHE = 256
const MAX_CATALOG_SEQS = 512
const MAX_LINEAGE_HOPS = 16
const REFRESH_DEBOUNCE_MS = 30
const PUBLISH_DEBOUNCE_MS = 15

/**
 * Native failure codes that prove the mounted enumeration cannot work at all:
 * they name a missing service or a missing projection registration, not a
 * transient per-session read problem. Any other failure stays per-read.
 */
const UNUSABLE_LISTING_CODES: ReadonlySet<string> = new Set([
  'SUBAGENT_CONTROL_QUERY_UNAVAILABLE',
  'SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE',
  'SUBAGENT_CONTROL_SESSION_STORE_UNAVAILABLE',
])

/**
 * The wire keys one display row folds.
 *
 * A resident row read asks the native registry for exactly these units, so the
 * projection cut neither computes nor advances unrelated client-visible units.
 */
const ROW_PROJECTION_KEYS: readonly string[] = ['subagent', 'subagentTiming', 'tokenUsage', 'modelSelection']
/** Every projection key whose change frame can move a display row. */
const SUBAGENT_KEYS: ReadonlySet<string> = new Set<string>(['subagentCatalog', ...ROW_PROJECTION_KEYS])

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function modeOf(value: unknown): SubagentMode | undefined {
  return value === 'one-shot' || value === 'continuable' || value === 'external' || value === 'unknown'
    ? value
    : undefined
}

/** One display-safe, bounded native activity label. */
function activityLabel(value: string): string | undefined {
  const stripped = value
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (stripped.length === 0) return undefined
  return stripped.length > MAX_ACTIVITY_CHARS ? stripped.slice(0, MAX_ACTIVITY_CHARS - 3) + '...' : stripped
}

function timingOf(value: unknown): SubagentTiming | undefined {
  const item = record(value)
  if (item === undefined) return undefined
  const settled = count(item.settledMs)
  const active = record(item.active)
  const since = count(active?.since)
  const through = count(active?.through)
  const lastTurnCompleted = typeof item.lastTurnCompleted === 'boolean' ? item.lastTurnCompleted : undefined
  if (settled === undefined && since === undefined && lastTurnCompleted === undefined) return undefined
  return {
    ...(settled === undefined ? {} : { settledMs: settled }),
    ...(since === undefined ? {} : { activeSince: since }),
    ...(through === undefined ? {} : { activeThrough: through }),
    ...(lastTurnCompleted === undefined ? {} : { lastTurnCompleted }),
  }
}

/** Sum the four disjoint native provider-usage buckets of one child session. */
function tokenTotalOf(value: unknown): number | undefined {
  const item = record(value)
  if (item === undefined) return undefined
  const totals = record(item.totals) ?? item
  let total = 0
  let any = false
  for (const key of ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    const part = count(totals[key])
    if (part === undefined) continue
    total += part
    any = true
  }
  return any ? total : undefined
}

function routeOf(value: unknown): { provider?: string; model?: string; reasoningEffort?: string } | undefined {
  const selection = record(value)
  if (selection === undefined) return undefined
  const provider = text(selection.provider)
  const model = text(selection.model)
  const reasoningEffort = text(selection.reasoningEffort)
  if (provider === undefined && model === undefined && reasoningEffort === undefined) return undefined
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  }
}

function modelSelectionRoute(value: unknown): { provider?: string; model?: string; reasoningEffort?: string } | undefined {
  const item = record(value)
  if (item === undefined) return undefined
  return routeOf(item.lastUsed) ?? routeOf(item.next)
}

function headerOf(value: unknown): SubagentHeader | undefined {
  const item = record(value)
  const id = text(item?.id)
  if (item === undefined || id === undefined) return undefined
  const createdAt = integer(item.createdAt)
  const cwd = text(item.cwd)
  const parentSession = text(item.parentSession)
  const origin = text(item.origin)
  const delegationDepth = integer(item.delegationDepth)
  const agentPreset = text(item.agentPreset)
  return {
    id,
    ...(createdAt === undefined ? {} : { createdAt }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(parentSession === undefined ? {} : { parentSession }),
    ...(origin === undefined ? {} : { origin }),
    ...(delegationDepth === undefined ? {} : { delegationDepth }),
    ...(agentPreset === undefined ? {} : { agentPreset }),
    ...(typeof item.isSeeded === 'boolean' ? { isSeeded: item.isSeeded } : {}),
  }
}

/** One validated direct-child catalog row from `listChildren`. */
interface CatalogRow {
  readonly id: string
  readonly mode: SubagentMode
  readonly label?: string
  readonly createdAt?: number
}

/**
 * Validate one `listChildren` payload (parent-owned catalog rows).
 *
 * Unlike a descendant row these carry no `kind`/`parentId`/`depth`; they are the
 * exact direct children of the requested parent in native event order.
 */
function catalogRows(value: unknown): { readonly rows: CatalogRow[]; readonly rejected: number } | undefined {
  if (!Array.isArray(value)) return undefined
  const rows: CatalogRow[] = []
  let rejected = 0
  for (const raw of value) {
    const item = record(raw)
    const id = text(item?.id)
    const mode = modeOf(item?.mode)
    if (item === undefined || id === undefined || mode === undefined) {
      rejected += 1
      continue
    }
    const label = text(item.label)
    const createdAt = integer(item.createdAt)
    rows.push({ id, mode, ...(label === undefined ? {} : { label }), ...(createdAt === undefined ? {} : { createdAt }) })
  }
  return { rows, rejected }
}

/**
 * Validate one native listing payload.
 *
 * The public service returns typed rows; this adapter still validates them,
 * because a partial/older composition or a transport-shaped fake is untrusted
 * input here. Rejected rows are counted, never silently dropped, so the tree can
 * be reported incomplete instead of complete.
 */
function listedTree(value: unknown): ListedTree | undefined {
  if (!Array.isArray(value)) return undefined
  const rows: ListedRow[] = []
  let rejected = 0
  for (const raw of value) {
    const item = record(raw)
    const id = text(item?.id)
    const parentId = text(item?.parentId)
    const depth = integer(item?.depth)
    if (item === undefined || id === undefined || parentId === undefined || depth === undefined) {
      rejected += 1
      continue
    }
    if (item.kind === 'child') {
      const mode = modeOf(item.mode)
      if (mode === undefined || mode === 'unknown') {
        rejected += 1
        continue
      }
      const label = text(item.label)
      const createdAt = integer(item.createdAt)
      rows.push({
        kind: 'child',
        id,
        parentId,
        depth,
        mode,
        ...(label === undefined ? {} : { label }),
        ...(createdAt === undefined ? {} : { createdAt }),
      })
      continue
    }
    const reason = item.reason
    if (item.kind !== 'diagnostic' || (reason !== 'corrupt' && reason !== 'unsupported' && reason !== 'unavailable')) {
      rejected += 1
      continue
    }
    rows.push({ kind: 'diagnostic', id, parentId, depth, reason })
  }
  return { rows, rejected }
}

/** Native failure code of a foreign rejection, when it carries one. */
function errorCode(error: unknown): string | undefined {
  const code = record(error)?.code
  return typeof code === 'string' ? code : undefined
}

function disposeObservation(value: unknown): void {
  const item = value as { [Symbol.dispose]?: unknown } | undefined
  const dispose = item?.[Symbol.dispose]
  if (typeof dispose !== 'function') return
  try {
    ;(dispose as () => void).call(item)
  } catch {
    /* a released lease is not an adapter failure */
  }
}

function timeoutAfter<T>(promise: Promise<T>, ms: number, label: string, onLate?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      settled = true
      reject(backendError('RUNTIME_REQUEST_FAILED', `${label} timed out after ${ms}ms`))
    }, ms)
    timer.unref?.()
    promise.then(
      (value) => {
        if (settled) {
          onLate?.(value)
          return
        }
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error instanceof Error ? error : backendError('RUNTIME_REQUEST_FAILED', label))
      },
    )
  })
}

/** Map one native activation stop reason to the neutral status vocabulary. */
function statusFromStopReason(reason: string, mode: SubagentMode): SubagentStatus {
  if (reason === 'completed') return mode === 'continuable' ? 'idle' : 'completed'
  if (reason === 'aborted') return 'stopped'
  if (reason === 'error') return 'failed'
  if (reason === 'max-tokens') return 'max-tokens'
  if (reason === 'refusal') return 'refusal'
  return 'unknown'
}

function structuralKey(entry: SubagentEntry): string {
  return JSON.stringify([
    entry.id,
    entry.parentSessionId,
    entry.mode,
    entry.label ?? null,
    entry.catalogSeq ?? null,
    entry.createdAt ?? null,
    entry.local ?? null,
  ])
}

function sameEntry(left: SubagentEntry, right: SubagentEntry): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Build one snapshot from display rows plus the native metadata the neutral
 * contract carries.
 *
 * `diagnostics` is the approved metadata-only wire field: it holds native
 * `{id,parentSessionId,depth,reason}` rows and never a raw native error string
 * or credential. A complete tree keeps the field absent instead of empty, so a
 * consumer can tell "no diagnostic" from "diagnostics not read".
 */
function withSnapshotMetadata(
  entries: readonly SubagentEntry[],
  truncated: boolean,
  diagnostics: readonly SubagentBranchDiagnostic[],
): SubagentSnapshot {
  return {
    entries,
    ...(truncated ? { truncated: true } : {}),
    ...(diagnostics.length === 0 ? {} : { diagnostics }),
  }
}

/** Stable comparison key for the native branch-diagnostic metadata. */
function diagnosticsKey(diagnostics: readonly SubagentBranchDiagnostic[]): string {
  return diagnostics.length === 0
    ? ''
    : diagnostics.map(entry => `${entry.id}>${entry.parentSessionId}@${entry.depth}:${entry.reason}`).join('|')
}

/**
 * Read one current-root subagent tree from native projections, publish
 * idempotent snapshots/upserts and remember which children the App follows.
 */
export class SubagentBridge {
  private readonly options: SubagentBridgeOptions
  private readonly nodes = new Map<string, ChildNode>()
  private readonly nodeOrder: ChildNode[] = []
  private readonly runStarts = new Map<string, RunState>()
  private readonly runEnds = new Map<string, EndState>()
  private readonly finishedRuns = new Set<string>()
  private readonly activities = new Map<string, string>()
  private readonly rootSeqs = new Map<string, number>()
  private readonly headers = new Map<string, SubagentHeader>()
  private readonly disposedAgents = new Set<string>()
  private readonly followed = new Set<string>()
  private readonly warned = new Set<string>()
  private root: string | undefined
  private cache: SubagentSnapshot | undefined
  private cacheRoot: string | undefined
  private diagnostics: readonly SubagentBranchDiagnostic[] = []
  private truncated = false
  private lastPublished: SubagentSnapshot | undefined
  private publishedRoot: string | undefined
  /** Stable key of the diagnostics on the last published snapshot. */
  private publishedDiagnosticsKey: string | undefined
  private announcedRoot: string | undefined
  private refreshing: Promise<void> | undefined
  private refreshQueued = false
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  private publishTimer: ReturnType<typeof setTimeout> | undefined
  private abortController = new AbortController()
  /** Set once a native listing proves the mounted enumeration unusable. */
  private listingBroken = false
  private closed = false
  private generation = 0

  constructor(options: SubagentBridgeOptions) {
    this.options = options
  }

  // ------------------------------------------------------------------ host

  private service(name: string): Record<string, unknown> | undefined {
    let value: unknown
    try {
      value = this.options.host.get(name)
    } catch {
      return undefined
    }
    return record(value)
  }

  private query(): (SessionQueryLike & Record<string, unknown>) | undefined {
    const service = this.service('sessionQuery')
    return service === undefined ? undefined : service as unknown as SessionQueryLike & Record<string, unknown>
  }

  private listing(): SubagentListingLike | undefined {
    const service = this.service('subagents')
    return service === undefined ? undefined : service as unknown as SubagentListingLike
  }

  /** The root attachment epoch's cancellation signal for native reads. */
  private signal(): AbortSignal {
    return this.abortController.signal
  }

  /** End the current epoch's native reads and start a fresh one. */
  private nextEpoch(): void {
    if (!this.abortController.signal.aborted) this.abortController.abort()
    this.abortController = new AbortController()
  }

  /** Whether a native read failed because this epoch was cancelled locally. */
  private cancelled(error: unknown): boolean {
    if (this.signal().aborted) return true
    const code = errorCode(error)
    return code === 'ABORTED' || code === 'CANCELLED' || code === 'SESSION_QUERY_ABORTED'
  }

  /**
   * Cancellation for one bounded native read: the root attachment epoch plus a
   * local deadline. A native read that supports cancellation is therefore
   * aborted on `setRoot`/`invalidate`/`close` and at its deadline instead of
   * being merely abandoned; the wait bound stays as the second line of defence
   * for reads without a signal parameter.
   */
  private readSignal(ms: number): AbortSignal {
    return AbortSignal.any([this.signal(), AbortSignal.timeout(ms)])
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return
    this.warned.add(key)
    try {
      this.options.warn?.(message)
    } catch {
      /* diagnostics must never break the adapter */
    }
  }

  /**
   * Whether this composition can read the native subagent directory at all.
   *
   * Both halves are required: the public `ctx.subagents` listing service and the
   * Session query the per-row projections and durable child reads come from.
   * Detection stays live so an HMR composition change is observed on the next
   * call instead of freezing a startup decision. A listing that reported a
   * missing service/projection registration is remembered until the next
   * invalidation, because it is a composition fact, not a transient read error.
   */
  available(): boolean {
    if (this.listingBroken) return false
    const query = this.query()
    const listing = this.listing()
    return query !== undefined &&
      typeof query.observeSession === 'function' &&
      listing !== undefined &&
      typeof listing.listDescendants === 'function'
  }

  // --------------------------------------------------------------- lifecycle

  get rootSessionId(): string | undefined {
    return this.root
  }

  /** Point the bridge at the current top-level session and clear stale state. */
  setRoot(sessionId: string | undefined): void {
    if (this.root === sessionId) return
    this.root = sessionId
    this.generation += 1
    this.nextEpoch()
    this.nodes.clear()
    this.nodeOrder.length = 0
    this.runStarts.clear()
    this.runEnds.clear()
    this.finishedRuns.clear()
    this.activities.clear()
    this.rootSeqs.clear()
    this.headers.clear()
    this.disposedAgents.clear()
    this.followed.clear()
    this.cache = undefined
    this.cacheRoot = undefined
    this.diagnostics = []
    this.truncated = false
    this.lastPublished = undefined
    this.publishedRoot = undefined
    this.announcedRoot = undefined
    this.clearTimers()
  }

  /** Drop cached facts after an HMR recomposition; the next event rebuilds. */
  invalidate(): void {
    this.generation += 1
    this.nextEpoch()
    this.listingBroken = false
    this.nodes.clear()
    this.nodeOrder.length = 0
    this.rootSeqs.clear()
    this.headers.clear()
    this.cache = undefined
    this.cacheRoot = undefined
    this.diagnostics = []
    this.truncated = false
    this.lastPublished = undefined
    this.publishedRoot = undefined
    this.announcedRoot = undefined
    this.warned.clear()
    this.clearTimers()
  }

  close(): void {
    this.closed = true
    this.clearTimers()
    this.setRoot(undefined)
    if (!this.abortController.signal.aborted) this.abortController.abort()
    this.followed.clear()
  }

  private clearTimers(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = undefined
    }
    if (this.publishTimer !== undefined) {
      clearTimeout(this.publishTimer)
      this.publishTimer = undefined
    }
  }

  // ------------------------------------------------------------- public read

  /**
   * The current root's tree snapshot, built on first use and refreshed by
   * native events afterwards. Never throws: an unreadable catalog is reported
   * as an absent snapshot, never as an empty tree.
   */
  async snapshotForRoot(rootSessionId: string): Promise<SubagentSnapshot | undefined> {
    if (this.closed || !this.available()) return undefined
    const root = this.root
    if (root === undefined || root !== rootSessionId) return undefined
    if (this.cache !== undefined && this.cacheRoot === root) return this.snapshotEntries()
    if (this.refreshing !== undefined) {
      await this.refreshing
      return this.cacheRoot === root ? this.cache : undefined
    }
    await this.refresh()
    return this.cacheRoot === root ? this.snapshotEntries() : undefined
  }

  /** One-off tree read for a child Session transcript (never mutates the root cache). */
  async snapshotAt(rootSessionId: string, seed?: { events?: readonly unknown[]; inheritedEventCount?: number }): Promise<SubagentSnapshot | undefined> {
    if (this.closed || !this.available()) return undefined
    const seqs = new Map<string, number>(rootSessionId === this.root ? this.rootSeqs : [])
    if (seed?.events !== undefined) {
      const inherited = seed.inheritedEventCount ?? 0
      for (const event of seed.events) {
        const item = record(event)
        if (item?.type !== 'subagent/catalog' || typeof item.seq !== 'number' || item.seq < inherited) continue
        const childId = text(record(item.data)?.childId)
        if (childId !== undefined && !seqs.has(childId)) seqs.set(childId, item.seq)
      }
    }
    try {
      const read = await this.readTree(rootSessionId, seqs)
      if (read === undefined) return undefined
      return withSnapshotMetadata(
        read.nodes.map(node => this.entryFor(node)),
        read.truncated,
        read.diagnostics,
      )
    } catch (error) {
      this.warnOnce(`tree:${rootSessionId}`, `the native subagent catalog for ${JSON.stringify(rootSessionId)} could not be read: ${messageOf(error)}`)
      return undefined
    }
  }

  /**
   * Native branch diagnostics for the current root, as validated metadata only.
   *
   * These are the rows the mounted `ctx.subagents.listDescendants` already
   * returned as diagnostics; the bridge never derives them from raw native
   * error strings. The same list travels on every snapshot as
   * `SubagentSnapshot.diagnostics`, so this is only the direct read face.
   */
  branchDiagnostics(): readonly SubagentBranchDiagnostic[] {
    const root = this.root
    if (root === undefined || this.cacheRoot !== root) return []
    return this.diagnostics
  }

  /** One cold-safe durable read of a child Session for the transcript command. */
  async readSession(sessionId: string): Promise<SubagentSessionRead | undefined> {
    if (this.closed) return undefined
    const query = this.query()
    if (query === undefined) return undefined
    if (typeof query.observeSession === 'function') {
      let observation: ObservationLike | undefined
      try {
        const pending = query.observeSession(sessionId, { signal: this.readSignal(MAX_SESSION_READ_MS) })
        observation = await timeoutAfter(pending, MAX_SESSION_READ_MS, 'subagent session observation', disposeObservation)
        const header = headerOf(observation.header)
        const events = observation.events
        if (!Array.isArray(events)) return undefined
        return {
          header,
          inheritedEventCount: integer(observation.inheritedEventCount) ?? 0,
          events,
          values: record(observation.projections?.values),
        }
      } catch (error) {
        // A cancellation (root switch, teardown, deadline) is not a failure of
        // the bundle and must not become a diagnostic message.
        if (!this.cancelled(error)) {
          this.warnOnce(`read:${sessionId}`, `the durable child session ${JSON.stringify(sessionId)} could not be observed: ${messageOf(error)}`)
        }
        return undefined
      } finally {
        if (observation !== undefined) disposeObservation(observation)
      }
    }
    if (typeof query.readSession !== 'function') return undefined
    try {
      const log = record(await timeoutAfter(query.readSession(sessionId), MAX_SESSION_READ_MS, 'subagent session read'))
      if (log === undefined) return undefined
      const events = Array.isArray(log.events) ? log.events : []
      const header = headerOf(log.session)
      const inheritedEventCount = integer(log.inheritedEventCount) ?? 0
      this.rememberHeader(header)
      return {
        header,
        inheritedEventCount,
        events,
        values: this.restoreValues(header, events, inheritedEventCount),
      }
    } catch (error) {
      this.warnOnce(`read:${sessionId}`, `the durable child session ${JSON.stringify(sessionId)} could not be read: ${messageOf(error)}`)
      return undefined
    }
  }

  /** Fold every registered projection over a cold log without creating an Agent. */
  private restoreValues(header: SubagentHeader | undefined, events: readonly unknown[], inheritedEventCount: number): Record<string, unknown> | undefined {
    const registry = this.service('sessionProjections') as unknown as ProjectionsLike | undefined
    if (registry === undefined || typeof registry.restore !== 'function' || header === undefined) return undefined
    try {
      const result = registry.restore({}, events, 0, header, inheritedEventCount)
      return record(result?.snapshot?.values)
    } catch {
      return undefined
    }
  }

  /** Durable header of one child (bounded cache; never creates an Agent). */
  async headerOf(sessionId: string): Promise<SubagentHeader | undefined> {
    if (this.closed) return undefined
    const cached = this.headers.get(sessionId)
    if (cached !== undefined) return cached
    const live = this.liveHeader(sessionId)
    if (live !== undefined) {
      this.rememberHeader(live)
      return live
    }
    const query = this.query()
    if (query === undefined || typeof query.observeSession !== 'function') return undefined
    let observation: ObservationLike | undefined
    try {
      observation = await timeoutAfter(
        query.observeSession(sessionId, {
          projectionMode: 'none',
          signal: this.readSignal(MAX_SESSION_READ_MS),
        }),
        MAX_SESSION_READ_MS,
        'subagent header observation',
        disposeObservation,
      )
      const header = headerOf(observation.header)
      this.rememberHeader(header)
      return header
    } catch {
      return undefined
    } finally {
      if (observation !== undefined) disposeObservation(observation)
    }
  }

  private liveHeader(sessionId: string): SubagentHeader | undefined {
    const sessions = this.service('sessions') as unknown as SessionsLike | undefined
    if (sessions === undefined || typeof sessions.get !== 'function') return undefined
    try {
      const session = record(sessions.get(sessionId))
      return headerOf(session?.header)
    } catch {
      return undefined
    }
  }

  private rememberHeader(header: SubagentHeader | undefined): void {
    if (header === undefined) return
    this.headers.delete(header.id)
    this.headers.set(header.id, header)
    while (this.headers.size > MAX_HEADER_CACHE) {
      const oldest = this.headers.keys().next()
      if (oldest.done === true) break
      this.headers.delete(oldest.value)
    }
  }

  // -------------------------------------------------------------- membership

  /**
   * Prove one child belongs to the current root tree.
   *
   * Order: the verified display row, then the exact durable direct-parent
   * catalog row through the public `listChildren` API, then the bounded lineage
   * walk, then (only when the child header is unreadable) a fresh native
   * descendant listing. Every step proves membership against the *current* root,
   * so nothing here can authorize an id from another tree. No display refresh
   * throttle participates: a control action never depends on when the UI last
   * rebuilt its tree, and a failed lookup still fails closed.
   */
  async membership(sessionId: string): Promise<SubagentMembership | undefined> {
    const root = this.root
    if (this.closed || root === undefined || sessionId === root || sessionId.length === 0) return undefined
    const known = this.membershipOfNode(sessionId)
    if (known !== undefined) return known
    if (!this.available()) return undefined
    const lineage = await this.lineageOf(sessionId)
    if (lineage !== undefined) {
      const row = await this.directRow(lineage.parentSessionId, sessionId)
      if (row !== undefined) {
        return {
          parentSessionId: lineage.parentSessionId,
          mode: row.mode,
          local: row.mode !== 'external',
          ...(row.label === undefined ? {} : { label: row.label }),
        }
      }
      return { parentSessionId: lineage.parentSessionId, mode: 'unknown', local: true, untracked: true }
    }
    const listed = await this.listedRow(root, sessionId)
    if (listed === undefined) return undefined
    return {
      parentSessionId: listed.parentId,
      mode: this.nativeRowMode(listed),
      local: listed.mode !== 'external',
      ...(listed.label === undefined ? {} : { label: listed.label }),
    }
  }

  /** Native mode of one directory row; an unreadable branch stays honestly unknown. */
  private nativeRowMode(row: ListedRow | CatalogRow): SubagentMode {
    if ('kind' in row) return row.kind === 'child' ? row.mode ?? 'unknown' : 'unknown'
    return row.mode
  }

  /** Read one direct parent's native catalog and return its row for `sessionId`. */
  private async directRow(parentSessionId: string, sessionId: string): Promise<CatalogRow | undefined> {
    const listing = this.listing()
    const listChildren = listing?.listChildren
    if (listing === undefined || typeof listChildren !== 'function') return undefined
    let rows: unknown
    try {
      rows = await timeoutAfter(
        Promise.resolve(listChildren.call(listing, parentSessionId,
          AbortSignal.any([this.signal(), AbortSignal.timeout(MAX_LISTING_MS)]))),
        MAX_LISTING_MS,
        'native subagent catalog read',
      )
    } catch (error) {
      this.noteListingFailure(error)
      return undefined
    }
    const parsed = catalogRows(rows)
    if (parsed === undefined) return undefined
    if (parsed.rejected > 0) {
      this.warnOnce('catalog:shape', `the native direct-child catalog returned ${parsed.rejected} unusable row(s); membership is unproven`)
    }
    return parsed.rows.find(row => row.id === sessionId)
  }

  /** Read the whole current tree's native listing and return one row. */
  private async listedRow(rootSessionId: string, sessionId: string): Promise<ListedRow | undefined> {
    try {
      const tree = await this.listed(rootSessionId)
      return tree.rows.find(row => row.id === sessionId)
    } catch (error) {
      this.noteListingFailure(error)
      return undefined
    }
  }

  /**
   * One unbounded-by-presentation native descendant listing.
   *
   * Native owns the walk, the visited guard and the lease release; a non-array
   * payload or a rejected call is a failure, never an empty tree.
   */
  private async listed(rootSessionId: string): Promise<ListedTree> {
    const listing = this.listing()
    const listDescendants = listing?.listDescendants
    if (listing === undefined || typeof listDescendants !== 'function') {
      throw backendError('CAPABILITY_UNAVAILABLE', 'the runtime mounts no native subagent listing (ctx.subagents.listDescendants)')
    }
    const raw = await timeoutAfter(
      Promise.resolve(listDescendants.call(listing, rootSessionId,
        AbortSignal.any([this.signal(), AbortSignal.timeout(MAX_LISTING_MS)]))),
      MAX_LISTING_MS,
      'native subagent listing',
    )
    const parsed = listedTree(raw)
    if (parsed === undefined) {
      throw backendError('RUNTIME_REQUEST_FAILED', 'the native subagent listing returned no row array')
    }
    if (parsed.rejected > 0) {
      this.warnOnce('listing:shape', `the native subagent listing returned ${parsed.rejected} unusable row(s); the tree is incomplete`)
    }
    return parsed
  }

  /**
   * Remember a native listing failure that proves the enumeration unusable.
   *
   * Only the native "missing service/projection" codes are sticky; every other
   * failure stays a per-read problem so a transient error never hides the tree.
   */
  private noteListingFailure(error: unknown): boolean {
    const code = errorCode(error)
    if (code === undefined || !UNUSABLE_LISTING_CODES.has(code)) return false
    this.listingBroken = true
    this.warnOnce('listing', `the native subagent listing is unavailable in this composition (${code}); the subagent tree stays closed`)
    return true
  }

  private membershipOfNode(sessionId: string): SubagentMembership | undefined {
    const node = this.nodes.get(sessionId)
    if (node === undefined) return undefined
    const mode = this.modeOfNode(node)
    const label = this.labelOfNode(node)
    return {
      parentSessionId: node.parentSessionId,
      mode,
      local: mode !== 'external',
      ...(label === undefined ? {} : { label }),
    }
  }

  /**
   * Walk immutable session headers up to the current root. This is the native
   * lineage proof used for a child whose catalog row is not observable yet; it
   * never invents membership and is bounded.
   */
  private async lineageOf(sessionId: string): Promise<{ parentSessionId: string } | undefined> {
    const root = this.root
    if (root === undefined) return undefined
    const seen = new Set<string>()
    let current = sessionId
    let directParent: string | undefined
    for (let hop = 0; hop < MAX_LINEAGE_HOPS; hop += 1) {
      if (seen.has(current)) return undefined
      seen.add(current)
      const header = await this.headerOf(current)
      if (header === undefined) return undefined
      if (current === sessionId) {
        if (header.origin !== 'subagent') return undefined
        if (header.parentSession === undefined) return undefined
        directParent = header.parentSession
      }
      const parent = header.parentSession
      if (parent === undefined) return undefined
      if (parent === root) return directParent === undefined ? undefined : { parentSessionId: directParent }
      current = parent
    }
    return undefined
  }

  /** Native origin for one exact child decision; undefined means out of tree. */
  async originFor(sessionId: string): Promise<DecisionOrigin | undefined> {
    const root = this.root
    if (this.closed || root === undefined || sessionId === root) return undefined
    const node = this.nodes.get(sessionId)
    if (node !== undefined) {
      const label = this.labelOfNode(node)
      return {
        rootSessionId: root,
        childSessionId: sessionId,
        parentSessionId: node.parentSessionId,
        ...(label === undefined ? {} : { label }),
      }
    }
    const membership = await this.membership(sessionId)
    if (membership === undefined) return undefined
    return {
      rootSessionId: root,
      childSessionId: sessionId,
      parentSessionId: membership.parentSessionId,
      ...(membership.label === undefined ? {} : { label: membership.label }),
      ...(membership.untracked === true ? { untracked: true } : {}),
    }
  }

  // ------------------------------------------------------------------ follow

  /** Followed children are the only ones whose own frames reach the main UI. */
  isFollowed(sessionId: string): boolean {
    return this.followed.has(sessionId)
  }

  /** Whether this id is a known child of the current root (fast cache check). */
  isKnownChild(sessionId: string): boolean {
    return this.nodes.has(sessionId)
  }

  follow(sessionId: string): void {
    if (this.root === undefined || sessionId === this.root) return
    this.followed.add(sessionId)
  }

  unfollow(sessionId: string): void {
    this.followed.delete(sessionId)
  }

  followedChildren(): string[] {
    return [...this.followed]
  }

  // ------------------------------------------------------- native lifecycle

  noteStart(info: Record<string, unknown>): void {
    const id = text(info.id)
    const runId = text(info.runId)
    if (id === undefined || runId === undefined) return
    if (this.finishedRuns.has(runId)) return
    const provider = text(info.provider)
    const local = info.local === true
    this.runStarts.set(id, { runId, ...(provider === undefined ? {} : { provider }), local })
    while (this.runStarts.size > MAX_PENDING_RUNS) {
      const oldest = this.runStarts.keys().next()
      if (oldest.done === true) break
      this.runStarts.delete(oldest.value)
    }
    this.runEnds.delete(id)
    this.disposedAgents.delete(id)
    if (!this.activities.has(id)) this.setActivity(id, 'started')
    this.scheduleRefresh()
  }

  noteEnd(info: Record<string, unknown>): void {
    const id = text(info.id)
    const runId = text(info.runId)
    const stopReason = text(info.stopReason)
    if (id === undefined || runId === undefined || stopReason === undefined) return
    if (this.finishedRuns.has(runId)) return
    this.finishedRuns.add(runId)
    while (this.finishedRuns.size > MAX_FINISHED_RUNS) {
      const oldest = this.finishedRuns.values().next()
      if (oldest.done === true) break
      this.finishedRuns.delete(oldest.value)
    }
    const active = this.runStarts.get(id)
    if (active !== undefined && active.runId === runId) this.runStarts.delete(id)
    this.runEnds.delete(id)
    this.runEnds.set(id, { runId, stopReason, local: info.local === true })
    while (this.runEnds.size > MAX_RUN_ENDS) {
      const oldest = this.runEnds.keys().next()
      if (oldest.done === true) break
      this.runEnds.delete(oldest.value)
    }
    this.scheduleRefresh()
  }

  noteAgentPresent(sessionId: string): void {
    if (!this.nodes.has(sessionId)) return
    this.disposedAgents.delete(sessionId)
    this.schedulePublish()
  }

  noteAgentDisposed(sessionId: string): void {
    if (!this.nodes.has(sessionId)) return
    this.disposedAgents.add(sessionId)
    while (this.disposedAgents.size > MAX_PENDING_RUNS) {
      const oldest = this.disposedAgents.values().next()
      if (oldest.done === true) break
      this.disposedAgents.delete(oldest.value)
    }
    this.schedulePublish()
  }

  /** Narrow native projection change: values are already the validated wire views. */
  noteProjection(session: unknown, key: string, value: unknown): void {
    if (this.closed || !SUBAGENT_KEYS.has(key)) return
    const sessionId = text(record(session)?.id)
    if (sessionId === undefined || sessionId !== this.root) {
      if (sessionId === undefined || !this.nodes.has(sessionId)) return
      const node = this.nodes.get(sessionId)
      if (node === undefined) return
      if (key === 'subagentCatalog') {
        // A branch may have become readable again; only a fresh listing decides.
        this.scheduleRefresh()
        return
      }
      // A native branch diagnostic is not a child row: value frames from an
      // unreadable branch must not upgrade it into a continuable identity.
      if (node.diagnostic !== undefined) return
      if (key === 'subagent') {
        this.applyIdentity(node, value)
        this.schedulePublish()
        return
      }
      if (key === 'subagentTiming') {
        node.timing = timingOf(value)
        this.schedulePublish()
        return
      }
      if (key === 'tokenUsage') {
        node.totalTokens = tokenTotalOf(value)
        this.schedulePublish()
      }
      return
    }
    if (key === 'subagentCatalog') this.scheduleRefresh()
  }

  /** One root session event: keep catalog anchoring and structural changes. */
  noteRootEvent(sessionId: string, event: unknown): void {
    if (this.closed || this.root === undefined || sessionId !== this.root) return
    const item = record(event)
    if (item?.type !== 'subagent/catalog') return
    const childId = text(record(item.data)?.childId)
    if (childId === undefined || typeof item.seq !== 'number') return
    this.rememberCatalogSeq(childId, item.seq)
    this.scheduleRefresh()
  }

  /** Seed catalog anchoring from one durable root log read. */
  noteCatalogEvents(sessionId: string, events: readonly unknown[], inheritedEventCount: number): void {
    if (this.closed || this.root === undefined || sessionId !== this.root) return
    for (const event of events) {
      const item = record(event)
      if (item?.type !== 'subagent/catalog') continue
      if (typeof item.seq !== 'number' || item.seq < inheritedEventCount) continue
      const childId = text(record(item.data)?.childId)
      if (childId === undefined) continue
      this.rememberCatalogSeq(childId, item.seq)
    }
  }

  private rememberCatalogSeq(childId: string, seq: number): void {
    if (this.rootSeqs.get(childId) === seq) return
    this.rootSeqs.set(childId, seq)
    const node = this.nodes.get(childId)
    if (node !== undefined) node.catalogSeq = seq
    while (this.rootSeqs.size > MAX_CATALOG_SEQS) {
      const oldest = this.rootSeqs.keys().next()
      if (oldest.done === true) break
      this.rootSeqs.delete(oldest.value)
    }
  }

  /** One child session event: keep exactly one bounded activity label. */
  noteChildEvent(sessionId: string, event: unknown): void {
    if (this.closed || !this.nodes.has(sessionId)) return
    const label = this.activityOf(event)
    if (label === undefined) return
    if (this.activities.get(sessionId) === label) return
    this.setActivity(sessionId, label)
    this.schedulePublish()
  }

  /** One child agent status edge; the live Agent remains the authority. */
  noteAgentStatus(sessionId: string): void {
    if (!this.nodes.has(sessionId)) return
    this.schedulePublish()
  }

  /** One child agent failure edge: bounded activity only, never a fake terminal status. */
  noteAgentError(sessionId: string): void {
    if (!this.nodes.has(sessionId)) return
    this.setActivity(sessionId, 'error reported')
    this.schedulePublish()
  }

  private setActivity(sessionId: string, label: string): void {
    const bounded = activityLabel(label)
    if (bounded === undefined) return
    this.activities.delete(sessionId)
    this.activities.set(sessionId, bounded)
    while (this.activities.size > MAX_ACTIVITIES) {
      const oldest = this.activities.keys().next()
      if (oldest.done === true) break
      this.activities.delete(oldest.value)
    }
  }

  private activityOf(event: unknown): string | undefined {
    const item = record(event)
    if (item === undefined || typeof item.type !== 'string') return undefined
    const data = record(item.data)
    switch (item.type) {
      case 'tool/call': {
        const name = text(data?.name)
        return name === undefined ? 'tool call' : `tool: ${name}`
      }
      case 'assistant/message':
        return 'reply'
      case 'user/message':
        return 'prompt'
      case 'turn/start':
        return data?.turn === undefined ? 'turn started' : `turn ${String(data.turn)}`
      case 'turn/end':
        return 'turn ended'
      case 'compaction/end':
        return 'compacted'
      case 'approval/asked':
        return 'awaiting approval'
      case 'agent-preset/selected':
        return 'preset selected'
      default:
        return undefined
    }
  }

  // --------------------------------------------------------------- announce

  /** Record the snapshot already delivered inside `SessionInfo` as published. */
  announce(rootSessionId: string, snapshot: SubagentSnapshot | undefined): void {
    if (this.closed) return
    if (this.root !== rootSessionId) return
    if (snapshot === undefined) {
      this.announcedRoot = rootSessionId
      return
    }
    this.announcedRoot = rootSessionId
    this.lastPublished = snapshot
    this.publishedRoot = rootSessionId
    // The announced snapshot already carried this metadata cut; recording it
    // here keeps the next publish an upsert instead of a redundant full replay.
    this.publishedDiagnosticsKey = diagnosticsKey(this.diagnostics)
    this.schedulePublish()
  }

  // ---------------------------------------------------------------- refresh

  private scheduleRefresh(delay = REFRESH_DEBOUNCE_MS): void {
    if (this.closed || this.root === undefined) return
    if (this.refreshTimer !== undefined) return
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      void this.refresh()
    }, delay)
    this.refreshTimer.unref?.()
  }

  private schedulePublish(delay = PUBLISH_DEBOUNCE_MS): void {
    if (this.closed || this.root === undefined) return
    if (this.publishTimer !== undefined) return
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined
      this.publish()
    }, delay)
    this.publishTimer.unref?.()
  }

  private async refresh(): Promise<void> {
    if (this.closed) return
    const root = this.root
    if (root === undefined || !this.available()) return
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = undefined
    }
    if (this.refreshing !== undefined) {
      this.refreshQueued = true
      await this.refreshing
      return
    }
    const generation = this.generation
    const task = (async () => {
      try {
        const read = await this.readTree(root, this.rootSeqs)
        if (this.closed || this.root !== root || this.generation !== generation) return
        if (read === undefined) {
          this.warnOnce('catalog', 'the mounted DSH composition exposes no readable native subagent directory; the subagent tree is unavailable')
          return
        }
        this.nodes.clear()
        this.nodeOrder.length = 0
        for (const node of read.nodes) {
          this.nodes.set(node.id, node)
          this.nodeOrder.push(node)
        }
        this.truncated = read.truncated
        this.diagnostics = read.diagnostics
        this.cacheRoot = root
        this.publish()
      } catch (error) {
        if (this.closed || this.root !== root || this.generation !== generation) return
        if (this.signal().aborted || errorCode(error) === 'ABORTED' || errorCode(error) === 'CANCELLED') return
        if (this.noteListingFailure(error)) return
        this.warnOnce('refresh', `the native subagent tree could not be refreshed: ${messageOf(error)}`)
      }
    })()
    this.refreshing = task
    try {
      await task
    } finally {
      this.refreshing = undefined
      if (this.refreshQueued) {
        this.refreshQueued = false
        this.scheduleRefresh(0)
      }
    }
  }

  // --------------------------------------------------------------- tree read

  /**
   * Fold the public native descendant listing into display rows.
   *
   * Native owns the traversal: pre-order, per-catalog event order, external
   * leaves, the visited guard and one released observation per branch. This
   * method only validates rows, applies the UI presentation bounds, retains the
   * native branch diagnostics as metadata and enriches each readable local
   * child with the projections native rows do not carry.
   *
   * A native diagnostic is never a child: it stays read-only `unknown` unless
   * the very same id also arrived as a valid child row, in which case the child
   * row keeps its exact membership/mode and the diagnostic is retained only as
   * separate branch metadata.
   */
  private async readTree(rootSessionId: string, seqs: Map<string, number>): Promise<TreeRead | undefined> {
    const query = this.query()
    if (query === undefined || typeof query.observeSession !== 'function') return undefined
    const listing = await this.listed(rootSessionId)
    let truncated = listing.rejected > 0
    const diagnostics: SubagentBranchDiagnostic[] = []
    const children = new Map<string, ListedRow>()
    const diagnosticRows = new Map<string, ListedRow>()
    const order: string[] = []
    const known = new Set<string>([rootSessionId])
    for (const row of listing.rows) {
      if (row.kind === 'diagnostic') {
        if (diagnostics.length < MAX_TREE_ENTRIES) {
          diagnostics.push({
            id: row.id,
            parentSessionId: row.parentId,
            depth: row.depth,
            reason: row.reason ?? 'unavailable',
          })
          this.warnOnce(
            `branch:${row.id}:${row.reason}`,
            row.reason === 'unsupported'
              ? `native subagent ${JSON.stringify(row.id)} under ${JSON.stringify(row.parentId)} is cataloged with an unsupported mode; its row stays unknown and that branch is incomplete`
              : `native subagent ${JSON.stringify(row.id)} under ${JSON.stringify(row.parentId)} has an unreadable catalog (${row.reason}); that branch is incomplete`,
          )
        } else {
          truncated = true
        }
        if (!diagnosticRows.has(row.id)) diagnosticRows.set(row.id, row)
      } else if (!children.has(row.id)) {
        children.set(row.id, row)
      } else {
        // A repeated valid row is a contradiction, never a second child.
        truncated = true
      }
      if (!known.has(row.id)) {
        known.add(row.id)
        order.push(row.id)
      }
    }
    const nodes: ChildNode[] = []
    for (const id of order) {
      if (this.closed) return undefined
      if (this.signal().aborted) throw backendError('ABORTED', 'the native subagent listing was cancelled')
      if (nodes.length >= MAX_TREE_ENTRIES) {
        truncated = true
        break
      }
      const child = children.get(id)
      const row = child ?? diagnosticRows.get(id)
      if (row === undefined) continue
      if (row.depth > MAX_TREE_DEPTH) {
        truncated = true
        continue
      }
      if (child === undefined) truncated = true
      const node: ChildNode = {
        id: row.id,
        parentSessionId: row.parentId,
        depth: row.depth,
        catalogMode: child === undefined ? 'unknown' : child.mode ?? 'unknown',
        ...(row.label === undefined ? {} : { catalogLabel: row.label }),
        ...(row.createdAt === undefined ? {} : { createdAt: row.createdAt }),
        ...(seqs.get(row.id) === undefined ? {} : { catalogSeq: seqs.get(row.id)! }),
        ...(child === undefined ? { diagnostic: row.reason ?? 'unavailable' } : {}),
      }
      nodes.push(node)
      if (child === undefined || child.mode === 'external') continue
      // A resident child is read from the public resident surface (no lease,
      // only this row's projection keys); everything else takes the native
      // `observeSession` lease with the epoch/deadline cancellation signal.
      const observation = this.residentRow(row.id) ?? await this.observe(query, row.id)
      if (observation === undefined) {
        // Membership is native and already known; only its projections are missing.
        truncated = true
        this.warnOnce(`child:${row.id}`, `the native projections of subagent ${JSON.stringify(row.id)} could not be read`)
        continue
      }
      const header = observation.header
      if (header !== undefined) {
        if (header.parentSession !== undefined && header.parentSession !== row.parentId) {
          truncated = true
          this.warnOnce(`lineage:${row.id}`, `subagent ${JSON.stringify(row.id)} is cataloged under ${JSON.stringify(row.parentId)} but its durable parent is ${JSON.stringify(header.parentSession)}; the inconsistent row was omitted`)
          nodes.pop()
          continue
        }
        if (header.origin !== undefined && header.origin !== 'subagent') {
          truncated = true
          this.warnOnce(`origin:${row.id}`, `subagent ${JSON.stringify(row.id)} is cataloged under ${JSON.stringify(row.parentId)} but its session header is not a subagent origin; the inconsistent row was omitted`)
          nodes.pop()
          continue
        }
        node.header = header
        if (node.createdAt === undefined && header.createdAt !== undefined) node.createdAt = header.createdAt
        this.rememberHeader(header)
      }
      this.applyValues(node, observation.values)
    }
    return { nodes, diagnostics, truncated }
  }

  private async observe(
    query: SessionQueryLike,
    sessionId: string,
  ): Promise<{ header?: SubagentHeader; values?: Record<string, unknown> } | undefined> {
    if (typeof query.observeSession !== 'function') return undefined
    let observation: ObservationLike | undefined
    try {
      observation = await timeoutAfter(
        query.observeSession(sessionId, {
          signal: this.readSignal(MAX_SESSION_READ_MS),
        }),
        MAX_SESSION_READ_MS,
        'subagent session observation',
        disposeObservation,
      )
      const header = headerOf(observation.header)
      const values = record(observation.projections?.values)
      return {
        ...(header === undefined ? {} : { header }),
        ...(values === undefined ? {} : { values }),
      }
    } catch {
      return undefined
    } finally {
      if (observation !== undefined) disposeObservation(observation)
    }
  }

  /**
   * Read one row from the resident public surface, or report "needs a lease".
   *
   * A child whose Session is already resident (`ctx.sessions.get`) carries the
   * same immutable `SessionHeader` and the same wire projection views that the
   * live `observeSession` lease would return, but the native observation would
   * fold **every** client-visible unit and hand back an asynchronous lease. This
   * read asks `sessionProjections.snapshot(session, keys)` for exactly the keys
   * a row folds instead, and owns no lease.
   *
   * `undefined` means "not resident, or the resident surface is not trustworthy":
   * the caller then takes the native `observeSession` lease, so a cold child, a
   * missing registry, a rejected or non-object snapshot and a stale resident
   * identity all keep the previous facts and failure modes instead of inventing
   * a header or silently dropping projection values. No `Session` internals are
   * touched: `id` and `header` are public, immutable session identity metadata.
   */
  private residentRow(sessionId: string): ResidentRowRead | undefined {
    const sessions = this.service('sessions') as unknown as SessionsLike | undefined
    if (sessions === undefined || typeof sessions.get !== 'function') return undefined
    let session: unknown
    try {
      session = sessions.get(sessionId)
    } catch {
      return undefined
    }
    const resident = record(session)
    // The resident object must be the exact requested Session: a stale or
    // foreign entry never contributes this row's identity.
    if (resident === undefined || text(resident.id) !== sessionId) return undefined
    const header = headerOf(resident.header)
    if (header === undefined || header.id !== sessionId) return undefined
    const registry = this.service('sessionProjections') as unknown as ProjectionsLike | undefined
    // No registry at all means no projection values — exactly what the live
    // observation reports in that composition. A registry that exists but
    // cannot cut one snapshot is a real read failure: keep the native path.
    if (registry === undefined) return { header }
    if (typeof registry.snapshot !== 'function') return undefined
    let cut: { readonly values?: unknown } | undefined
    try {
      cut = registry.snapshot(session, ROW_PROJECTION_KEYS)
    } catch {
      return undefined
    }
    const snapshot = record(cut)
    if (snapshot === undefined) return undefined
    const values = record(snapshot.values)
    return { header, ...(values === undefined ? {} : { values }) }
  }

  private applyIdentity(node: ChildNode, value: unknown): void {
    const identity = record(value)
    const mode = modeOf(identity?.mode)
    if (value === null) {
      node.identity = null
      return
    }
    if (identity === undefined || (mode !== 'one-shot' && mode !== 'continuable')) {
      node.identity = undefined
      return
    }
    const label = text(identity.label)
    node.identity = { mode, ...(label === undefined ? {} : { label }) }
  }

  private applyValues(node: ChildNode, values: Record<string, unknown> | undefined): void {
    if (values === undefined) return
    if (Object.prototype.hasOwnProperty.call(values, 'subagent')) this.applyIdentity(node, values.subagent)
    const timing = timingOf(values.subagentTiming)
    if (timing !== undefined) node.timing = timing
    const tokens = tokenTotalOf(values.tokenUsage)
    if (tokens !== undefined) node.totalTokens = tokens
    const route = modelSelectionRoute(values.modelSelection)
    if (route !== undefined) node.route = route
  }

  // ------------------------------------------------------------------ entries

  private modeOfNode(node: ChildNode): SubagentMode {
    if (node.catalogMode === 'external') return 'external'
    if (node.identity !== undefined && node.identity !== null) return node.identity.mode
    return node.catalogMode
  }

  private labelOfNode(node: ChildNode): string | undefined {
    if (node.identity !== undefined && node.identity !== null) return node.identity.label
    return node.catalogLabel
  }

  private statusOf(node: ChildNode, mode: SubagentMode): SubagentStatus {
    if (mode === 'external') return 'external'
    const sessionId = node.id
    const active = this.runStarts.get(sessionId)
    const ended = this.runEnds.get(sessionId)
    const agent = this.liveAgent(sessionId)
    if (active !== undefined) {
      if (agent !== undefined) return agent.status === 'running' ? 'running' : 'idle'
      return this.disposedAgents.has(sessionId) ? 'unknown' : 'initializing'
    }
    if (ended !== undefined) return statusFromStopReason(ended.stopReason, mode)
    if (agent !== undefined) return agent.status === 'running' ? 'running' : 'idle'
    if (this.liveSession(sessionId)) return 'initializing'
    // Durable evidence only. An open turn without a live child proves nothing
    // about execution, and a closed non-normal turn does not name its reason.
    if (node.timing?.activeSince !== undefined) return 'unknown'
    if (node.timing?.lastTurnCompleted === true) return mode === 'continuable' ? 'idle' : 'completed'
    return 'unknown'
  }

  private liveAgent(sessionId: string): AgentLike | undefined {
    const agents = this.service('agents') as unknown as AgentsLike | undefined
    if (agents === undefined || typeof agents.get !== 'function') return undefined
    try {
      return agents.get(sessionId)
    } catch {
      return undefined
    }
  }

  private liveSession(sessionId: string): boolean {
    const sessions = this.service('sessions') as unknown as SessionsLike | undefined
    if (sessions === undefined || typeof sessions.get !== 'function') return false
    try {
      return sessions.get(sessionId) !== undefined
    } catch {
      return false
    }
  }

  private liveRoute(sessionId: string): { provider?: string; model?: string; reasoningEffort?: string } | undefined {
    const agent = this.liveAgent(sessionId)
    const model = record(record(agent)?.model)
    if (model === undefined || typeof model.current !== 'function') return undefined
    try {
      return routeOf((model.current as () => unknown).call(model))
    } catch {
      return undefined
    }
  }

  private entryFor(node: ChildNode): SubagentEntry {
    const mode = this.modeOfNode(node)
    const label = this.labelOfNode(node)
    const active = this.runStarts.get(node.id)
    const ended = this.runEnds.get(node.id)
    const route = this.liveRoute(node.id) ?? node.route
    // A native branch diagnostic proves neither a local Session nor an external
    // leaf, so `local` stays absent instead of being guessed either way.
    const local = node.diagnostic !== undefined ? undefined : mode !== 'external'
    return {
      id: node.id,
      parentSessionId: node.parentSessionId,
      ...(node.catalogSeq === undefined ? {} : { catalogSeq: node.catalogSeq }),
      ...(node.createdAt === undefined ? {} : { createdAt: node.createdAt }),
      mode,
      ...(label === undefined ? {} : { label }),
      ...(route?.provider === undefined ? {} : { provider: route.provider }),
      ...(route?.model === undefined ? {} : { model: route.model }),
      ...(route?.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort }),
      ...(local === undefined ? {} : { local }),
      status: this.statusOf(node, mode),
      ...(this.activities.get(node.id) === undefined ? {} : { lastActivity: this.activities.get(node.id)! }),
      ...(active === undefined && ended === undefined ? {} : { lastRunId: active?.runId ?? ended?.runId }),
      ...(ended === undefined ? {} : { lastStopReason: ended.stopReason }),
      ...(node.totalTokens === undefined ? {} : { totalTokens: node.totalTokens }),
      ...(node.timing === undefined ? {} : { timing: node.timing }),
    }
  }

  // ---------------------------------------------------------------- publish

  /**
   * Re-derive entries from the current nodes and live native state.
   *
   * Value-only facts (activity label, token/timing projection frames, live
   * Agent status) update bridge state without a tree rebuild, so every read
   * and every publish must recompute instead of serving a stale row array.
   */
  private snapshotEntries(): SubagentSnapshot {
    const snapshot = withSnapshotMetadata(
      this.nodeOrder.map(node => this.entryFor(node)),
      this.truncated,
      this.diagnostics,
    )
    this.cache = snapshot
    return snapshot
  }

  /** Publish a full snapshot when membership changed; upserts for value-only diffs. */
  private publish(): void {
    if (this.closed) return
    const root = this.root
    // The ready payload is the first authoritative snapshot; nothing is pushed
    // before the App has seen the attachment (`ready`) it belongs to.
    if (root === undefined || this.cacheRoot !== root || this.announcedRoot !== root) return
    const next = this.snapshotEntries()
    if (this.publishedRoot !== root) {
      this.lastPublished = undefined
      this.publishedRoot = root
      this.publishedDiagnosticsKey = undefined
    }
    const nextDiagnosticsKey = diagnosticsKey(this.diagnostics)
    const diagnosticsChanged = this.publishedDiagnosticsKey !== nextDiagnosticsKey
    this.publishedDiagnosticsKey = nextDiagnosticsKey
    const previous = this.lastPublished
    if (previous === undefined) {
      this.lastPublished = next
      this.options.emit({ type: 'subagents', sessionId: root, value: next })
      return
    }
    const truncationChanged = (previous.truncated === true) !== (next.truncated === true)
    const previousKeys = previous.entries.map(structuralKey)
    const nextKeys = next.entries.map(structuralKey)
    const structural = truncationChanged ||
      diagnosticsChanged ||
      previousKeys.length !== nextKeys.length ||
      previousKeys.some((key, index) => key !== nextKeys[index])
    if (structural) {
      this.lastPublished = next
      this.options.emit({ type: 'subagents', sessionId: root, value: next })
      return
    }
    const previousById = new Map(previous.entries.map(entry => [entry.id, entry]))
    let changed = false
    for (const entry of next.entries) {
      const before = previousById.get(entry.id)
      if (before !== undefined && sameEntry(before, entry)) continue
      changed = true
      this.options.emit({ type: 'subagent', sessionId: root, value: entry })
    }
    if (changed) this.lastPublished = next
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name
  if (typeof error === 'string') return error
  return 'the native read failed without a diagnostic message'
}