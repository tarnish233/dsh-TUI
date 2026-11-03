/** Neutral UI-facing contract. DSH owns the runtime and durable facts. */
export type JsonRecord = Record<string, unknown>

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

export interface SessionInfo {
  /** Process-local Agent attachment epoch, not a second durable session identity. */
  attachmentId?: string
  sessionId: string
  cwd: string
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
  multiSelect?: boolean
  options: Array<{ label: string; description?: string; preview?: string }>
}

export interface DecisionRequest {
  id: string
  kind: 'approval' | 'question'
  title: string
  message?: string
  options?: DecisionOption[]
  questions?: Question[]
}

/**
 * Live frames use attemptId as identity. revision increases on every frame
 * within an attached DSH Agent lifecycle (and restarts after replacement);
 * it is NOT constant for the duration of an attempt.
 */
export type BackendEvent =
  | { type: 'ready'; info: SessionInfo }
  | { type: 'status'; sessionId: string; status: 'running' | 'idle' }
  | { type: 'permissions'; sessionId: string; value: PermissionSelection }
  | { type: 'stream_start'; sessionId: string; attemptId: string; revision: number; turn: number; step: number }
  | { type: 'stream_chunk'; sessionId: string; attemptId: string; revision: number; index: number; chunk: JsonRecord }
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
  cancel(): Promise<void>
  /** Control methods plus commands (native descriptors) and execute ({line}, native CommandExecution). */
  command(name: string, args?: JsonRecord): Promise<unknown>
  /** Approval: option.value or {cancelled:true}. Questions: {answers:(string|string[])[],cancelled?:boolean}. */
  respond(id: string, value: unknown): Promise<void>
  close(): Promise<void>
}

export interface DshOptions {
  cwd: string
  dshPath?: string
  home?: string
  resume?: string
  provider?: string
  model?: string
  /**
   * Real DSH profile whose native configuration is reused (`dsh --profile`).
   * Absent selects this application's base composition, composed by DSH from
   * `DEFAULT_PROFILE_BUNDLES`; the home patch and credentials still apply.
   */
  profile?: string
}
