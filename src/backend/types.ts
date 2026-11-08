/** Neutral UI-facing contract. DSH owns the runtime and durable facts. */
export type JsonRecord = Record<string, unknown>

/** DSH's durable image vocabulary. The identifier is opaque, never a host path. */
export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export interface ImageAttachmentRef {
  readonly attachmentId: string
  readonly mediaType: ImageMediaType
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
  readonly originalDimensions?: { readonly width: number; readonly height: number }
}

/** One lazily read, DSH-verified image. Bytes never travel in transcript events. */
export interface ImageAttachmentValue {
  readonly attachment: ImageAttachmentRef
  readonly data: string
}

/** Public Host-style prompt parts; DSH owns image admission and durable promotion. */
export type PromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: ImageMediaType; readonly data: string; readonly name?: string }

/** Ordered, already admitted content used only for display projection. */
export type DisplayContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly attachment: ImageAttachmentRef }

/**
 * One recallable human inbox row. `next-turn` waits for a turn boundary;
 * `next-step` is delivered at the next step. Bytes stay in DSH.
 */
export interface QueueEntry {
  readonly messageId: string
  readonly text: string
  readonly target: 'next-turn' | 'next-step'
  readonly images: number
}

export type SurfaceOperation = 'append' | { op: 'replace'; startSeq: number; endSeq: number }

export interface SessionEvent {
  type: string
  seq: number
  time?: number
  data: unknown
  /** Preserve DSH's distinction between original transcript facts and model-only replacements. */
  surfaceOp?: SurfaceOperation
  sourceEventSeqs?: number[]
  /** Ephemeral render intent from the exact DSH tool definition; never persisted by this TUI. */
  toolPresentation?: JsonRecord
}

export interface StreamPresentation {
  text: string
  thinking: string
  toolNames: string[]
  /** Optional for legacy/demo codecs; real image references are never reduced to counts. */
  images?: readonly ImageAttachmentRef[]
  content?: readonly DisplayContentPart[]
}

export interface DisplayStream {
  push(chunk: JsonRecord): void
  snapshot(interrupted?: boolean): StreamPresentation
}

/** Pure projections supplied by the backend. Production uses DSH's public codecs, not a mirror. */
export interface TranscriptCodec {
  createStream(): DisplayStream
  assemble(stream: unknown, interrupted?: boolean): StreamPresentation
  surfaceKind(event: SessionEvent): 'append' | 'replace' | 'none'
}

/** Native permissions projection: independent from DSH plan mode. */
export interface PermissionSelection {
  currentValue: string
}

/** Read-only DSH skill metadata; the native registry has already resolved invocation policy. */
export interface SkillCatalogEntry {
  /** Native identifier, used literally as /name rather than a Pi skill: alias. */
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  /** False identifies a user-only skill; all entries permit user invocation. */
  readonly modelInvocable: boolean
}

/** A native Agent/preset-scope discovery observation, never a TUI-owned skill catalog. */
export interface SkillCatalogSnapshot {
  readonly entries: readonly SkillCatalogEntry[]
  /** False when the native registry/viewing scope cannot serve a metadata observation. */
  readonly available: boolean
  /** Native discovery completeness. Unavailable observations are never complete. */
  readonly complete: boolean
}

/**
 * Native command-versus-prompt discovery for an explicitly submitted slash name.
 * Unlike menu discovery, this may materialize the user's pending native Agent
 * so preset-scoped commands have priority even on the first submitted input.
 */
export interface InputRoute {
  readonly kind: 'command' | 'prompt'
  readonly sessionId: string
  readonly attachmentId?: string
}

export interface SessionInfo {
  /** Current root's native child catalog; child Sessions are not independently resumable. */
  subagents?: SubagentSnapshot
  /** Process-local Agent attachment epoch, not a second durable session identity. */
  attachmentId?: string
  sessionId: string
  cwd: string
  /** Native title projection; null means no title, undefined means the service is unavailable. */
  title?: string | null
  provider: string
  model: string
  /** Adapter-owned reasoning effort selected for the current route, when explicit. */
  reasoningEffort?: string
  /** Active native DSH Agent preset id, when the profile mounts a preset roster. */
  preset?: string
  permissions?: PermissionSelection
  capabilities: string[]
  /** Durable snapshot, never tentative live text. */
  events?: SessionEvent[]
  truncated?: boolean
  totalEvents?: number
  /**
   * DSH could not read the durable log for this session. The transcript is
   * incomplete rather than empty; the UI must not present it as a new session.
   */
  snapshotUnavailable?: boolean
}

export interface DecisionOption {
  label: string
  description?: string
  value: unknown
}

export interface Question {
  /** Native question identity and presentation intent survive the wire when available. */
  id?: string
  intent?: string | JsonRecord
  question: string
  header?: string
  /** Long-form supporting content (e.g. the full plan markdown of a plan review). */
  detail?: string
  multiSelect?: boolean
  options: Array<{ label: string; description?: string; preview?: string }>
}

/**
 * Native usage facts for the footer's stat chips, folded bridge-side from the
 * `contextPressure` / `tokenUsage` projections with the web client's formulas
 * (same source as the `state` command's `usage` field). Both occupancy fields
 * travel together: a bar needs `used` and `size` as one atomic reading.
 */
export interface UsageSnapshot {
  used?: number
  size?: number
  cachePct?: number
  totalTokens?: number
}

/**
 * DSH's native `sessionStats` fold, whitelisted to real non-negative numbers
 * (same source as the `state` command's `stats` field). Absent fields omit
 * their chips; the footer never falls back to a local rate estimate.
 */
export interface StatsSnapshot {
  turns?: number
  steps?: number
  llmMs?: number
  toolMs?: number
  ttftMs?: number
  ttftSteps?: number
  decodeMs?: number
  decodeTokens?: number
}

/** Native todo item of the `todos` projection. */
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

/**
 * DSH's native `todos` projection: the whole list, or null before the first
 * `todo/write` of a turn (the fold clears on `turn/start`).
 */
export type TodosSnapshot = TodoItem[] | null

/**
 * DSH's native `plan` projection, trimmed to presentation-relevant fields:
 * plan mode is active / was requested and which command run toggled it.
 */
export interface PlanSnapshot {
  active: boolean
  wanted: boolean | null
  running: { commandId: string; wanted: boolean } | null
}

export type SubagentMode = 'one-shot' | 'continuable' | 'external' | 'unknown'

/** UI vocabulary mapped from native lifecycle/status facts, never inferred from prose. */
export type SubagentStatus =
  | 'initializing'
  | 'running'
  | 'idle'
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'max-tokens'
  | 'refusal'
  | 'unknown'
  | 'external'

/** Native per-child-session totals. These are not per-activation measurements. */
export interface SubagentTiming {
  settledMs?: number
  activeSince?: number
  activeThrough?: number
  lastTurnCompleted?: boolean
}

/** Lightweight direct/nested child row. Full child transcripts use a separate read path. */
export interface SubagentEntry {
  /** Durable child session identity. */
  id: string
  /** Durable direct-parent session identity. */
  parentSessionId: string
  /** Parent catalog event seq when available; unsequenced rows stay out of the ordered transcript. */
  catalogSeq?: number
  createdAt?: number
  mode: SubagentMode
  label?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  local?: boolean
  status: SubagentStatus
  /** One bounded native activity label, never the child's full stream. */
  lastActivity?: string
  /** Process-local activation identity; absent from cold catalog reads. */
  lastRunId?: string
  /** Native stop reason for the latest observed activation. */
  lastStopReason?: string
  /** Sum of native tokenUsage buckets for the whole child session. */
  totalTokens?: number
  timing?: SubagentTiming
}

export interface SubagentSnapshot {
  entries: readonly SubagentEntry[]
  /** True only when native data is known to be incomplete; never a guess from an empty list. */
  truncated?: boolean
}

export interface DecisionOrigin {
  rootSessionId: string
  childSessionId: string
  parentSessionId?: string
  label?: string
  untracked?: boolean
}

export interface DecisionRequest {
  id: string
  kind: 'approval' | 'question'
  title: string
  message?: string
  options?: DecisionOption[]
  questions?: Question[]
  /** Present when DSH attributes this exact decision to a child in the current tree. */
  origin?: DecisionOrigin
}

/**
 * Live frames use attemptId as identity. revision increases on every frame
 * within an attached DSH Agent lifecycle (and restarts after replacement);
 * it is NOT constant for the duration of an attempt.
 */
export type BackendEvent =
  | { type: 'ready'; info: SessionInfo }
  | { type: 'status'; sessionId: string; status: 'running' | 'idle' }
  /** Read-only native title projection; identity is the supplied host attachment, not a local title writer. */
  | { type: 'title'; sessionId: string; attachmentId?: string; value: string | null }
  | { type: 'permissions'; sessionId: string; value: PermissionSelection }
  | { type: 'todos'; sessionId: string; value: TodosSnapshot }
  | { type: 'plan'; sessionId: string; value: PlanSnapshot }
  | { type: 'metrics'; sessionId: string; usage?: UsageSnapshot; stats?: StatsSnapshot }
  | { type: 'subagents'; sessionId: string; value: SubagentSnapshot }
  | { type: 'subagent'; sessionId: string; value: SubagentEntry }
  /** Unfiltered native invalidation: consumers refetch metadata for their current attachment. */
  | { type: 'skills_changed'; sessionId: string; attachmentId?: string }
  | { type: 'stream_start'; sessionId: string; attemptId: string; revision: number; turn: number; step: number }
  | { type: 'stream_chunk'; sessionId: string; attemptId: string; revision: number; index: number; chunk: JsonRecord; /** DSH wall-clock timestamp (epoch ms) of the frame; optional on the wire. */ time?: number }
  | { type: 'stream_end'; sessionId: string; attemptId: string; revision: number; outcome: 'committed' | 'abandoned'; seq?: number }
  | { type: 'session_event'; sessionId: string; event: SessionEvent }
  | { type: 'decision'; sessionId: string; request: DecisionRequest }
  | { type: 'decision_closed'; sessionId: string; id: string }
  | { type: 'warning'; message: string }
  | { type: 'error'; message: string; fatal?: boolean }
  | { type: 'closed'; code: number | null; signal?: string | null }

export interface Backend {
  /** Available before ready; Demo supplies an explicitly fixture-only implementation. */
  readonly transcriptCodec?: TranscriptCodec
  onEvent(listener: (event: BackendEvent) => void): () => void
  connect(): Promise<SessionInfo>
  send(text: string, mode?: 'followup' | 'steer'): Promise<void>
  /** Native multimodal prompt admission; optional when a backend has no attachment capability. */
  sendContent?(content: readonly PromptContentPart[], mode?: 'followup' | 'steer'): Promise<void>
  /** Read-only attachment retrieval, independent from model vision and session creation. */
  readImage?(attachment: ImageAttachmentRef, signal?: AbortSignal): Promise<ImageAttachmentValue>
  cancel(): Promise<void>
  /** Control methods plus commands (native descriptors) and execute ({line}, native CommandExecution). */
  command(name: string, args?: JsonRecord): Promise<unknown>
  /** Approval: option.value or {cancelled:true}. Questions: {answers:(string|string[])[],cancelled?:boolean}. */
  respond(id: string, value: unknown): Promise<void>
  close(): Promise<void>
}
