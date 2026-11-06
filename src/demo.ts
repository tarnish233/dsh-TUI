/**
 * Deterministic, offline demo backend.
 *
 * DemoBackend is only constructed by the CLI when `--demo` is explicit. It is
 * never a fallback for a failed real DSH connection. The frames and durable
 * events use the same wire shapes as the real backend:
 *
 *   live:    stream_start -> dense stream_chunk* -> stream_end(outcome, seq)
 *   durable: session_event 'user/message', 'assistant/message',
 *            'assistant/attempt', 'tool/call', 'tool/result',
 *            'command/run', 'command/done'
 *
 * It performs no network or filesystem work. Keywords select fixtures:
 *   anything  ordinary Markdown/code + Chinese/emoji + edit tool with diff
 *   tools-group adjacent Bash/MCP cards (long input/output) + a native diff separator
 *   question  ordered AskUserQuestion fixture (multi-select + single select)
 *   approval  opaque approval values
 *   abort     a streamed attempt that is abandoned mid-flight
 *   fail      a committed assistant/attempt settlement + nonfatal error
 *   pending   an admitted tool call that never receives a result
 *
 * Decision cancellation follows DSH: a cancelled approval/question (native
 * `{cancelled:true}` or the local cancel sentinel) is reported as cancelled, not
 * recorded as a deny or an unexpected answer. `cancel()` mirrors native
 * `keepInbox:true`: queued input is preserved and paused, and the next explicit
 * `send()` resumes it.
 *
 * The real backend injects DSH's own public BlockAssembler/assistant-stream/
 * surface helpers as `transcriptCodec`. This file ships a clearly separate
 * fixture codec so `--demo` and pure UI tests run without DSH installed; it is
 * never a production fallback and is not a copy of the native algorithms.
 */
import type {
  Backend,
  BackendEvent,
  DecisionRequest,
  DisplayStream,
  DisplayContentPart,
  ImageAttachmentRef,
  ImageAttachmentValue,
  ImageMediaType,
  JsonRecord,
  SessionEvent,
  SessionInfo,
  StreamPresentation,
  SubagentEntry,
  SubagentSnapshot,
  TranscriptCodec,
} from './backend/types.ts'

export interface DemoBackendOptions {
  cwd?: string
  delayMs?: number
}

export const DEMO_PROVIDER = 'demo (offline)'
export const DEMO_MODEL = 'deepseek-demo'
export const DEMO_HINTS = [
  'tools    → terminal 工具调用 + edit diff',
  'tools-group → 相邻/混合工具组（长输入输出）+ native diff 隔断',
  'thinking → 折叠的思考摘要（/settings → Thinking 打开显示）',
  'images   → 真实图片 ref（PNG/JPEG、重复出现、纯图 assistant/工具结果）+ 相邻工具/长输出/diff',
  '任何文本  → Markdown、代码块、中文/emoji、edit 工具与 diff',
  'question → 多选 + 单选 AskUserQuestion 问卷',
  'approval → 审批选项（opaque value）；Esc 返回原生拒绝值',
  'Esc/Ctrl+C → 问卷隐藏可重开；Ctrl+C 中断但保留排队输入',
  'abort    → 流式尝试被放弃（aborted attempt）',
  'fail     → assistant/attempt 结算 + 非致命错误',
  'pending  → 已受理但没有结果的工具调用（显示 unknown）',
  'subagent → 原生子 Agent 目录（并行运行/空闲/失败/外部）+ 结算与触发消息',
] as const

/** Mirrors DSH's public `CommandDescriptor`; the demo never invents capabilities. */
export interface DemoCommandDescriptor {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string; readonly attachments?: boolean }
}

/** Ephemeral display extra the backend may attach to a durable event. */
interface EventExtras {
  readonly toolPresentation?: JsonRecord
}

export const DEMO_COMMANDS: readonly DemoCommandDescriptor[] = [
  { name: 'compact', description: 'Compact the demo session (simulated; DSH owns real compaction).' },
  { name: 'permission', description: 'Switch an offline permission preset (simulated).', input: { hint: '<preset>' } },
  { name: 'status', description: 'Show the offline demo session state.' },
  { name: 'help', description: 'List the offline demo commands.' },
  { name: 'echo', description: 'Echo free-form demo input.', input: { hint: 'text to echo' } },
]

const DEMO_PRESETS = [
  { id: 'standard', name: 'Standard mode', description: 'Demo full tool set; no real tools execute.' },
  { id: 'minimal', name: 'Minimal mode', description: 'Demo persistent-shell preset; no real tools execute.' },
] as const

const DEMO_EFFORTS = [
  { id: 'low', name: 'Low', description: 'Demo low reasoning effort.' },
  { id: 'medium', name: 'Medium', description: 'Demo medium reasoning effort.' },
  { id: 'high', name: 'High', description: 'Demo high reasoning effort.' },
  { id: 'max', name: 'Max', description: 'Demo maximum reasoning effort.' },
] as const

const DEMO_DEFAULT_EFFORT = 'high'

const DEMO_PERMISSION_OPTIONS = [
  { value: 'workspace-write', name: 'workspace-write', description: 'Demo workspace permission preset; no real tools execute.' },
  { value: 'danger-full-access', name: 'danger-full-access', description: 'Demo full-access preset; no real permissions change.' },
] as const

type DemoChunk = Record<string, unknown>

interface TimedChunk {
  index: number
  time: number
  chunk: DemoChunk
}

interface StreamMeta {
  attemptId: string
  revision: number
  timed: TimedChunk[]
}

interface PendingDecision {
  resolve: (value: unknown) => void
}

export interface DemoCommandExecution {
  readonly commandId: string
  readonly result:
    | { readonly kind: 'success'; readonly text?: string; readonly sourceEventSeq?: number }
    | { readonly kind: 'error'; readonly text: string }
}

const CANCELLED = Symbol('demo-cancelled')
const DEMO_BASE_TIME = 1_750_000_000_000

/**
 * Deterministic child identities of the offline subagent fixture. These are
 * fixture-only durable ids; `subagent-session` returns a synthetic child
 * SessionInfo for the local ones, while the external id deliberately has no
 * local transcript at all.
 */
const DEMO_CHILD_EXPLORE = 'demo-child-explore'
const DEMO_CHILD_REVIEW = 'demo-child-review'
const DEMO_CHILD_VERIFY = 'demo-child-verify'
const DEMO_CHILD_TEST = 'demo-child-test'
const DEMO_CHILD_EXTERNAL = 'demo-child-external'

const DEMO_CHILD_SESSIONS: Readonly<Record<string, string>> = {
  [DEMO_CHILD_EXPLORE]: 'I mapped the transcript projection, the live settlement path and the keys that will open the Agents overlay.',
  [DEMO_CHILD_REVIEW]: 'I reviewed the frontend diff. No blocking issues; two width-safe edge cases are covered by the new tests.',
  [DEMO_CHILD_VERIFY]: 'The demo verification fixture stopped before it could run the full suite.',
  [DEMO_CHILD_TEST]: 'Focused UI tests passed against the fixture codec; no model or network call was made.',
}
const DEMO_CWD_FALLBACK = process.cwd()

/**
 * Offline image fixtures: real encoded bytes, canonical DSH-shaped refs.
 * `readImage` serves them from memory; no file, clipboard or network is read.
 */
interface DemoImageFixture {
  readonly attachment: ImageAttachmentRef
  readonly value: ImageAttachmentValue
}

function demoImageValue(
  attachmentId: string,
  mediaType: ImageMediaType,
  name: string,
  width: number,
  height: number,
  data: string,
): DemoImageFixture {
  const attachment: ImageAttachmentRef = {
    attachmentId,
    mediaType,
    bytes: Buffer.from(data, 'base64').byteLength,
    width,
    height,
    name,
  }
  return { attachment, value: { attachment, data } }
}

/** 4×4 synthetic PNG/JPEG generated offline for fixtures only. */
const DEMO_PNG = demoImageValue(
  'demo:image:png-quadrants',
  'image/png',
  'quadrants.png',
  4,
  4,
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAL0lEQVQImR3GQREAMBACsVOCEkQgGxGIWAmdaV45Omp1qo+aP3VHRqxM8RHzp+wB5tIZ8f97ukgAAAAASUVORK5CYII=',
)
const DEMO_JPEG = demoImageValue(
  'demo:image:jpeg-quadrants',
  'image/jpeg',
  'quadrants.jpg',
  4,
  4,
  '/9j/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAEAAQDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAb/xAAiEAAABAQHAAAAAAAAAAAAAAAAAQIDBQYHEQQTMUFEUfD/xAAVAQEBAAAAAAAAAAAAAAAAAAAGB//EACQRAAADBQkAAAAAAAAAAAAAAAABBAIDBSNCBhQVMjNRUmFx/9oADAMBAAIRAxEAPwCIqPVCacXO8UWuLWMsnisHqy2rdB9+O5gACmo0KW7OpTOUqS28AK0kNRY2ukMarykuZ9D/2Q==',
)

const DEMO_IMAGE_VALUES: ReadonlyMap<string, ImageAttachmentValue> = new Map([
  [DEMO_PNG.attachment.attachmentId, DEMO_PNG.value],
  [DEMO_JPEG.attachment.attachmentId, DEMO_JPEG.value],
])

function throwIfDemoAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return
  const error = new Error('Demo image read was cancelled.')
  error.name = 'AbortError'
  throw error
}

/** Event types that carry native surface metadata (append/replace origin). */
const DEMO_SURFACE_TYPES: ReadonlySet<string> = new Set([
  'system/message',
  'developer/message',
  'user/message',
  'assistant/message',
  'tool/result',
])

/**
 * Fixture-only stream projection used by `--demo`.
 *
 * It understands exactly the chunk shapes this file emits/settles (block,
 * text/reasoning/tool-call deltas, usage, finish). It is deliberately small and
 * documented as non-production: the real backend passes DSH's public
 * `BlockAssembler` and `assembleAssistantStream` through `transcriptCodec`.
 */
class DemoStreamBuilder implements DisplayStream {
  private readonly parts = new Map<number, { kind: 'text' | 'reasoning' | 'tool-call' | 'image'; text: string; toolName: string; attachment?: ImageAttachmentRef }>()
  private readonly order: number[] = []

  push(chunk: JsonRecord): void {
    const type = typeof chunk.type === 'string' ? chunk.type : ''
    const index = typeof chunk.index === 'number' && Number.isFinite(chunk.index) ? chunk.index : 0
    switch (type) {
      case 'block-start': {
        const blockType = typeof chunk.blockType === 'string' ? chunk.blockType : ''
        const part = this.ensure(index, blockType === 'reasoning' ? 'reasoning' : blockType === 'tool-call' ? 'tool-call' : blockType === 'image' ? 'image' : 'text')
        if (blockType === 'image') part.attachment = asDemoAttachment(chunk.attachment) ?? part.attachment
        return
      }
      case 'text-delta':
      case 'reasoning-delta': {
        const part = this.ensure(index, type === 'text-delta' ? 'text' : 'reasoning')
        if (typeof chunk.text === 'string') part.text += chunk.text
        return
      }
      case 'tool-call-delta': {
        const part = this.ensure(index, 'tool-call')
        if (typeof chunk.name === 'string' && chunk.name !== '') part.toolName = chunk.name
        if (typeof chunk.argumentsDelta === 'string') part.text += chunk.argumentsDelta
        return
      }
      case 'block-end': {
        const block = typeof chunk.block === 'object' && chunk.block !== null && !Array.isArray(chunk.block)
          ? chunk.block as Record<string, unknown>
          : undefined
        const blockType = block !== undefined && typeof block.type === 'string' ? block.type : ''
        const part = this.ensure(index, blockType === 'reasoning' ? 'reasoning' : blockType === 'tool-call' ? 'tool-call' : blockType === 'image' ? 'image' : 'text')
        if ((blockType === 'text' || blockType === 'reasoning') && part.text === '' && typeof block?.text === 'string') part.text = block.text
        if (blockType === 'tool-call' && part.toolName === '' && typeof block?.name === 'string') part.toolName = block.name
        if (blockType === 'image') part.attachment = asDemoAttachment(block?.attachment) ?? part.attachment
        return
      }
      default:
        return
    }
  }

  snapshot(): StreamPresentation {
    const text: string[] = []
    const thinking: string[] = []
    const toolNames: string[] = []
    const content: DisplayContentPart[] = []
    const images: ImageAttachmentRef[] = []
    for (const index of this.order) {
      const part = this.parts.get(index)
      if (part === undefined) continue
      if (part.kind === 'text') {
        text.push(part.text)
        content.push({ type: 'text', text: part.text })
      } else if (part.kind === 'reasoning') thinking.push(part.text)
      else if (part.kind === 'tool-call' && part.toolName !== '') toolNames.push(part.toolName)
      else if (part.kind === 'image' && part.attachment !== undefined) {
        content.push({ type: 'image', attachment: part.attachment })
        images.push(part.attachment)
      }
    }
    return {
      text: text.join(''),
      thinking: thinking.join(''),
      toolNames,
      ...(images.length === 0 ? {} : { content, images }),
    }
  }

  private ensure(index: number, kind: 'text' | 'reasoning' | 'tool-call' | 'image'): { kind: 'text' | 'reasoning' | 'tool-call' | 'image'; text: string; toolName: string; attachment?: ImageAttachmentRef } {
    const existing = this.parts.get(index)
    if (existing !== undefined) return existing
    const part = { kind, text: '', toolName: '' }
    this.parts.set(index, part)
    this.order.push(index)
    return part
  }
}

/** Shape-validate a fixture stream image ref; no policy, just the wire shape. */
function asDemoAttachment(value: unknown): ImageAttachmentRef | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.attachmentId !== 'string' || record.attachmentId === '') return undefined
  if (record.mediaType !== 'image/png' && record.mediaType !== 'image/jpeg' && record.mediaType !== 'image/webp' && record.mediaType !== 'image/gif') return undefined
  const numbers = [record.bytes, record.width, record.height]
  if (!numbers.every(entry => typeof entry === 'number' && Number.isSafeInteger(entry) && entry > 0)) return undefined
  return {
    attachmentId: record.attachmentId,
    mediaType: record.mediaType,
    bytes: record.bytes as number,
    width: record.width as number,
    height: record.height as number,
    ...(typeof record.name === 'string' ? { name: record.name } : {}),
  }
}

/**
 * Fixture-only follow-up prompt payload: text and/or ordered content blocks.
 *
 * This validates the wire shape and nothing else. Image blocks keep their
 * canonical attachment ref (an unfetchable placeholder is counted but not
 * painted, exactly like the durable projection), so a demo reply never loses
 * an image the caller included. It is never a production admission path.
 */
function demoPromptBlocks(args: JsonRecord): unknown[] {
  const contentValue = args.content
  if (contentValue !== undefined) {
    if (args.text !== undefined) {
      throw new Error('DemoBackend subagent-prompt accepts either text or content, not both')
    }
    if (!Array.isArray(contentValue)) {
      throw new Error('DemoBackend subagent-prompt content must be an array of prompt parts')
    }
    const blocks: unknown[] = []
    let usable = false
    for (const value of contentValue) {
      if (!isRecord(value)) continue
      if (value.type === 'text' && typeof value.text === 'string') {
        blocks.push({ type: 'text', text: value.text })
        if (value.text.trim() !== '') usable = true
        continue
      }
      if (value.type === 'image') {
        // Keep the caller's ordered image part (bytes/mediaType included) and
        // add the canonical display ref when one is already known.
        const attachment = asDemoAttachment(value.attachment)
        blocks.push(attachment === undefined ? { ...value } : { ...value, attachment })
        usable = true
      }
    }
    if (!usable) {
      throw new Error('DemoBackend subagent-prompt content requires non-whitespace text or an image')
    }
    return blocks
  }
  const text = args.text
  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('DemoBackend command "subagent-prompt" needs a non-empty { text } or { content }')
  }
  return [{ type: 'text', text }]
}

/** Delivery mode of a fixture follow-up: `queue` (next turn) or `steer` (next step). */
function demoPromptDelivery(args: JsonRecord): 'queue' | 'steer' {
  const raw = typeof args.delivery === 'string' ? args.delivery : typeof args.mode === 'string' ? args.mode : 'queue'
  if (raw !== 'queue' && raw !== 'steer') {
    throw new Error(`DemoBackend subagent-prompt delivery must be "queue" or "steer", got "${raw}"`)
  }
  return raw
}

/** Expand the demo's compact `AssistantStreamRecord[]` fixture records. */
export function expandDemoStream(records: unknown): JsonRecord[] {
  const out: JsonRecord[] = []
  for (const record of Array.isArray(records) ? records : []) {
    if (typeof record !== 'object' || record === null || Array.isArray(record)) continue
    const entry = record as Record<string, unknown>
    if (entry.type === 'chunk' && typeof entry.chunk === 'object' && entry.chunk !== null) {
      out.push(entry.chunk as JsonRecord)
      continue
    }
    const index = typeof entry.index === 'number' ? entry.index : 0
    if (entry.type === 'text-chunks' && Array.isArray(entry.texts)) {
      for (const text of entry.texts) if (typeof text === 'string') out.push({ type: 'text-delta', index, text })
      continue
    }
    if (entry.type === 'reasoning-chunks' && Array.isArray(entry.texts)) {
      for (const text of entry.texts) if (typeof text === 'string') out.push({ type: 'reasoning-delta', index, text })
      continue
    }
    if (entry.type === 'tool-call-chunks' && Array.isArray(entry.args)) {
      const id = typeof entry.id === 'string' ? entry.id : ''
      const name = typeof entry.name === 'string' ? entry.name : undefined
      for (const fragment of entry.args) {
        if (typeof fragment !== 'string') continue
        out.push({ type: 'tool-call-delta', index, id, ...(name === undefined ? {} : { name }), argumentsDelta: fragment })
      }
    }
  }
  return out
}

/**
 * Mock-only transcript codec for the offline demo and pure UI tests.
 *
 * NOT a DSH implementation and never a production fallback: the real backend
 * supplies native `BlockAssembler`/assistant-stream/surface helpers, and the
 * store refuses to guess when no codec is installed.
 */
export class DemoTranscriptCodec implements TranscriptCodec {
  createStream(): DisplayStream {
    return new DemoStreamBuilder()
  }

  assemble(stream: unknown): StreamPresentation {
    const builder = new DemoStreamBuilder()
    for (const chunk of expandDemoStream(stream)) builder.push(chunk)
    return builder.snapshot()
  }

  surfaceKind(event: SessionEvent): 'append' | 'replace' | 'none' {
    if (!DEMO_SURFACE_TYPES.has(event.type)) return 'none'
    return event.surfaceOp === undefined || event.surfaceOp === 'append' ? 'append' : 'replace'
  }
}

export const DEMO_TRANSCRIPT_CODEC: TranscriptCodec = new DemoTranscriptCodec()

function splitGraphemes(text: string, size: number): string[] {
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
  const graphemes = [...segmenter.segment(text)].map(part => part.segment)
  const out: string[] = []
  for (let index = 0; index < graphemes.length; index += size) out.push(graphemes.slice(index, index + size).join(''))
  return out.length > 0 ? out : ['']
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Compact raw chunks into DSH AssistantStreamRecord[] (delta runs + raw chunks). */
export function compactStream(timed: readonly TimedChunk[]): unknown[] {
  const out: unknown[] = []
  let run: { type: 'text' | 'reasoning' | 'tool'; index: number; time0: number; dt: number[]; texts: string[]; id?: string; name?: string } | undefined
  const flush = (): void => {
    if (run === undefined) return
    if (run.type === 'text') {
      out.push({ type: 'text-chunks', time0: run.time0, index: run.index, dt: run.dt, texts: run.texts })
    } else if (run.type === 'reasoning') {
      out.push({ type: 'reasoning-chunks', time0: run.time0, index: run.index, dt: run.dt, texts: run.texts })
    } else {
      out.push({ type: 'tool-call-chunks', time0: run.time0, index: run.index, dt: run.dt, id: run.id ?? '', name: run.name, args: run.texts })
    }
    run = undefined
  }
  for (const entry of timed) {
    const type = entry.chunk.type
    if (type === 'text-delta' || type === 'reasoning-delta' || type === 'tool-call-delta') {
      const kind = type === 'text-delta' ? 'text' : type === 'reasoning-delta' ? 'reasoning' : 'tool'
      const index = typeof entry.chunk.index === 'number' ? entry.chunk.index : 0
      if (run === undefined || run.type !== kind || run.index !== index) {
        flush()
        run = { type: kind, index, time0: entry.time, dt: [0], texts: [] }
      }
      const delta = type === 'tool-call-delta' ? entry.chunk.argumentsDelta : entry.chunk.text
      if (typeof delta === 'string') run.texts.push(delta)
      run.dt.push(Math.max(0, entry.time - run.time0))
      if (type === 'tool-call-delta') {
        if (typeof entry.chunk.id === 'string') run.id = entry.chunk.id
        if (typeof entry.chunk.name === 'string') run.name = entry.chunk.name
      }
      continue
    }
    flush()
    out.push({ type: 'chunk', time: entry.time, chunk: entry.chunk })
  }
  flush()
  return out
}

export class DemoBackend implements Backend {
  /** Explicit marker so the host can prove this is the offline fixture. */
  readonly demo = true
  /**
   * Fixture-only codec, available before `connect()`/ready. The real backend
   * supplies DSH's native codec here; the demo never stands in for it.
   */
  readonly transcriptCodec: TranscriptCodec = DEMO_TRANSCRIPT_CODEC
  private readonly listeners = new Set<(event: BackendEvent) => void>()
  private readonly delayMs: number
  private readonly events: SessionEvent[] = []
  private readonly timers = new Map<ReturnType<typeof setTimeout>, () => void>()
  private readonly pendingDecisions = new Map<string, PendingDecision>()
  private readonly idleWaiters: Array<() => void> = []
  private readonly queue: string[] = []
  private infoValue: SessionInfo
  private clock = 0
  private seq = 0
  private turnCounter = 0
  private attemptCounter = 0
  private revisionCounter = 0
  private sessionCounter = 1
  private decisionCounter = 0
  private commandCounter = 0
  private running = false
  private closed = false
  private abortFlag = false
  /** Native `keepInbox:true`: a cancelled turn pauses the queue instead of dropping it. */
  private paused = false
  /**
   * Fixture child catalog. The native rows this file projects are the same rows
   * `subagent-prompt` / `subagent-interrupt` mutate; nothing here is a second
   * catalog — it is the offline stand-in for DSH's durable child state.
   */
  private readonly demoSubagents = new Map<string, SubagentEntry>()
  /** Deterministic durable event log per local child Session (fixture only). */
  private readonly demoChildEvents = new Map<string, SessionEvent[]>()
  private subagentMessageCounter = 0

  constructor(options: DemoBackendOptions = {}) {
    const delay = options.delayMs ?? 24
    this.delayMs = Number.isFinite(delay) ? Math.max(0, Math.min(1000, Math.floor(delay))) : 24
    this.infoValue = {
      sessionId: 'demo-session-1',
      cwd: options.cwd ?? DEMO_CWD_FALLBACK,
      provider: DEMO_PROVIDER,
      model: DEMO_MODEL,
      permissions: { currentValue: 'workspace-write' },
      preset: 'standard',
      reasoningEffort: DEMO_DEFAULT_EFFORT,
      capabilities: ['stream', 'streaming', 'tools', 'questions', 'approval', 'cancel', 'followup', 'steer', 'new', 'resume', 'state', 'models', 'permissions', 'presets', 'preset', 'efforts', 'effort', 'dequeue', 'commands', 'execute', 'subagents', 'subagent-session', 'subagent-follow', 'subagent-prompt', 'subagent-interrupt', 'demo'],
      events: [],
    }
  }

  get info(): SessionInfo {
    return this.infoValue
  }

  get busy(): boolean {
    return this.running
  }

  onEvent(listener: (event: BackendEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async connect(): Promise<SessionInfo> {
    if (this.closed) throw new Error('DemoBackend is closed')
    this.infoValue = { ...this.infoValue, events: [...this.events] }
    this.emit({ type: 'ready', info: this.infoValue })
    this.emit({ type: 'status', sessionId: this.infoValue.sessionId, status: 'idle' })
    return this.infoValue
  }

  async send(text: string, _mode: 'followup' | 'steer' = 'followup'): Promise<void> {
    if (this.closed) throw new Error('DemoBackend is closed')
    if (text.trim() === '') throw new Error('DemoBackend refuses empty input')
    // An explicit user send is the only thing that resumes a paused queue.
    this.paused = false
    this.queue.push(text)
    this.runQueue()
  }

  async cancel(): Promise<void> {
    this.abortFlag = true
    // Mirrors native SessionController.cancel({ keepInbox: true }): queued
    // inputs stay in the inbox and the queue is paused. There is no automatic
    // drain and no remove-then-re-add; the next explicit send resumes it.
    this.paused = true
    for (const [id, pending] of this.pendingDecisions) {
      this.pendingDecisions.delete(id)
      pending.resolve(CANCELLED)
      this.emit({ type: 'decision_closed', sessionId: this.infoValue.sessionId, id })
    }
    if (!this.running) this.resolveIdle()
  }

  async respond(id: string, value: unknown): Promise<void> {
    const pending = this.pendingDecisions.get(id)
    if (pending === undefined) throw new Error(`No pending demo decision "${id}"`)
    this.pendingDecisions.delete(id)
    this.emit({ type: 'decision_closed', sessionId: this.infoValue.sessionId, id })
    pending.resolve(value)
  }

  /**
   * Fixture-only `readImage`: serves the known canonical refs from memory and
   * honors the caller's signal. Unknown ids fail instead of fabricating bytes;
   * no DSH admission or display policy is reimplemented here.
   */
  async readImage(attachment: ImageAttachmentRef, signal?: AbortSignal): Promise<ImageAttachmentValue> {
    throwIfDemoAborted(signal)
    await this.pause()
    throwIfDemoAborted(signal)
    const value = DEMO_IMAGE_VALUES.get(attachment.attachmentId)
    if (value === undefined) throw new Error(`No demo image attachment "${attachment.attachmentId}"`)
    return value
  }

  async command(name: string, args: JsonRecord = {}): Promise<unknown> {
    switch (name) {
      case 'models':
        return [{ id: DEMO_PROVIDER + '/' + DEMO_MODEL, provider: DEMO_PROVIDER, model: DEMO_MODEL, label: 'Demo model (offline)' }]
      case 'sessions':
        return [{ id: this.infoValue.sessionId, title: 'Demo session', cwd: this.infoValue.cwd, updatedAt: this.now() }]
      case 'new': {
        const preset = typeof args.preset === 'string' && args.preset.length > 0 ? args.preset : 'standard'
        if (!DEMO_PRESETS.some(item => item.id === preset)) throw new Error(`Unknown demo agent preset: ${preset}`)
        this.resetSession(preset)
        return this.infoValue
      }
      case 'resume': {
        const sessionId = typeof args.sessionId === 'string' && args.sessionId !== '' ? args.sessionId : `demo-session-${++this.sessionCounter}`
        this.infoValue = { ...this.infoValue, sessionId, events: [] }
        delete this.infoValue.subagents
        this.demoSubagents.clear()
        this.demoChildEvents.clear()
        this.events.length = 0
        this.seq = 0
        this.queue.length = 0
        this.paused = false
        this.emit({ type: 'ready', info: this.infoValue })
        this.resolveIdle()
        return this.infoValue
      }
      case 'model': {
        const model = typeof args.model === 'string' ? args.model : typeof args.id === 'string' ? args.id.slice(args.id.indexOf('/') + 1) : undefined
        if (model === undefined || model === '') throw new Error('DemoBackend command "model" needs a model string or id')
        this.infoValue = { ...this.infoValue, model, events: [...this.events] }
        this.emit({ type: 'ready', info: this.infoValue })
        return this.infoValue
      }
      case 'presets': {
        const current = this.infoValue.preset
        const blank = !this.events.some(event => event.type === 'turn/start')
        return {
          current: current ?? null,
          blank,
          default: 'standard',
          presets: DEMO_PRESETS.map(item => ({
            ...item,
            current: item.id === current,
            ...(item.id === 'standard' ? { isDefault: true } : {}),
          })),
        }
      }
      case 'preset': {
        const id = typeof args.id === 'string' ? args.id : ''
        const entry = DEMO_PRESETS.find(item => item.id === id)
        if (!entry) throw new Error(`Unknown demo agent preset: ${id}`)
        if (this.events.some(event => event.type === 'turn/start')) {
          return { id, current: this.infoValue.preset ?? null, locked: true }
        }
        this.infoValue = { ...this.infoValue, preset: id, events: [...this.events] }
        this.append('agent-preset/selected', { agentPreset: id })
        this.emit({ type: 'ready', info: this.infoValue })
        return this.infoValue
      }
      case 'efforts': {
        const selected = this.infoValue.reasoningEffort
        const effective = selected ?? DEMO_DEFAULT_EFFORT
        return {
          provider: this.infoValue.provider,
          model: this.infoValue.model,
          ...(selected === undefined ? {} : { reasoningEffort: selected }),
          defaultEffort: DEMO_DEFAULT_EFFORT,
          effectiveEffort: effective,
          available: true,
          efforts: DEMO_EFFORTS.map(option => ({ ...option })),
        }
      }
      case 'effort': {
        const wanted = args.id
        if (wanted === null || wanted === undefined || wanted === 'default') {
          this.infoValue = { ...this.infoValue, events: [...this.events] }
          delete this.infoValue.reasoningEffort
        } else {
          const id = String(wanted)
          const entry = DEMO_EFFORTS.find(item => item.id === id)
          if (!entry) throw new Error(`Unknown demo reasoning effort: ${id}`)
          this.infoValue = { ...this.infoValue, reasoningEffort: id, events: [...this.events] }
        }
        this.emit({ type: 'ready', info: this.infoValue })
        return {
          provider: this.infoValue.provider,
          model: this.infoValue.model,
          ...(this.infoValue.reasoningEffort === undefined ? {} : { reasoningEffort: this.infoValue.reasoningEffort }),
          effectiveEffort: this.infoValue.reasoningEffort ?? DEMO_DEFAULT_EFFORT,
        }
      }
      case 'reload':
        return { available: false, demo: true, warnings: [], pending: [] }
      case 'permissions':
        return { currentValue: this.infoValue.permissions?.currentValue, options: DEMO_PERMISSION_OPTIONS.map(option => ({ ...option })) }
      case 'state':
        return {
          sessionId: this.infoValue.sessionId,
          cwd: this.infoValue.cwd,
          provider: this.infoValue.provider,
          model: this.infoValue.model,
          ...(this.infoValue.reasoningEffort === undefined ? {} : { reasoningEffort: this.infoValue.reasoningEffort }),
          ...(this.infoValue.preset === undefined ? {} : { preset: this.infoValue.preset }),
          permissions: this.infoValue.permissions,
          status: this.running ? 'running' : 'idle',
          demo: true,
          pendingDecisions: [...this.pendingDecisions.keys()],
          // Native session state exposes the inbox counts, not a TUI-owned
          // `queued` field: `pending.nextTurn` survives a cancel.
          pending: { nextTurn: this.queue.length, nextStep: 0 },
          queue: this.queue.map((text, index) => ({
            messageId: 'demo-pending-' + index,
            text,
            target: 'next-turn' as const,
            images: 0,
          })),
          usage: null,
        }
      case 'subagent-session': {
        // Fixture-only child snapshot: no child backend is attached, so the
        // demo serves deterministic durable events for the local children it
        // advertises. An external child genuinely has no local Session.
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
        if (sessionId === '') throw new Error('DemoBackend command "subagent-session" needs { sessionId }')
        const event = DEMO_CHILD_SESSIONS[sessionId]
        if (event === undefined) {
          throw new Error(`No demo child session "${sessionId}" (external tasks have no local transcript)`)
        }
        return this.childSessionInfo(sessionId, event)
      }
      case 'subagent-follow': {
        // Fixture no-op with a truthful shape: the offline demo never streams a
        // child Agent, so it cannot actually follow one.
        const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
        if (sessionId === '') throw new Error('DemoBackend command "subagent-follow" needs { sessionId }')
        return {
          sessionId,
          follow: args.follow !== false,
          following: false,
          supported: false,
          demo: true,
        }
      }
      case 'subagent-prompt':
        return await this.subagentPromptCommand(args)
      case 'subagent-interrupt':
        return this.subagentInterruptCommand(args)
      case 'compact':
        // Compatibility alias for the native command path; never its own
        // compactNow wrapper.
        return this.executeLine('/compact')
      case 'commands':
        return DEMO_COMMANDS.map(command => ({ ...command }))
      case 'execute': {
        const line = typeof args.line === 'string' ? args.line : undefined
        if (line === undefined || line.trim() === '') throw new Error('DemoBackend command "execute" needs a non-empty { line }')
        return this.executeLine(line)
      }
      case 'dequeue': {
        const removed = this.queue.map((text, index) => ({ text, target: 'next-turn', messageId: 'demo-pending-' + index }))
        this.queue.length = 0
        this.paused = false
        this.resolveIdle()
        return removed
      }
      case 'queue-remove': {
        const index = this.demoQueueIndex(args.messageId)
        this.queue.splice(index, 1)
        return { removed: args.messageId }
      }
      case 'queue-replace': {
        const index = this.demoQueueIndex(args.messageId)
        const text = typeof args.text === 'string' ? args.text : ''
        if (text.trim() === '') throw new Error('queue-replace requires text')
        this.queue[index] = text
        return { messageId: 'demo-pending-' + index }
      }
      case 'queue-send-now': {
        const text = typeof args.text === 'string' ? args.text : undefined
        const messageId = typeof args.messageId === 'string' ? args.messageId : undefined
        let chosen: string | undefined
        if (messageId !== undefined) {
          const index = this.demoQueueIndex(messageId)
          const current = this.queue[index] ?? ''
          this.queue.splice(index, 1)
          chosen = text !== undefined && text.trim() !== '' ? text : current
        } else if (text !== undefined && text.trim() !== '') {
          chosen = text
        }
        if (chosen === undefined || chosen.trim() === '') throw new Error('queue-send-now requires text or messageId')
        this.queue.unshift(chosen)
        this.abortFlag = true
        this.paused = false
        if (!this.running) this.runQueue()
        return { ok: true }
      }
      default:
        throw new Error(`DemoBackend does not implement command "${name}" (demo is not a real backend)`)
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.abortFlag = true
    this.queue.length = 0
    for (const idle of this.idleWaiters.splice(0)) idle()
    for (const [timer, resolve] of this.timers) {
      clearTimeout(timer)
      resolve()
    }
    this.timers.clear()
    for (const [id, pending] of this.pendingDecisions) {
      pending.resolve(CANCELLED)
      this.emit({ type: 'decision_closed', sessionId: this.infoValue.sessionId, id })
    }
    this.pendingDecisions.clear()
    this.emit({ type: 'closed', code: 0 })
  }

  /**
   * Test/demo helper modelling native session idleness: no active turn and no
   * pending decision. A paused inbox still holds queued input, but that input
   * is not active work, so it does not keep the fixture busy forever.
   */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.push(resolve))
  }

  // -------------------------------------------------------------------------
  // Internals

  private resetSession(preset = 'standard'): void {
    this.infoValue = {
      ...this.infoValue,
      sessionId: `demo-session-${++this.sessionCounter}`,
      preset,
      events: [],
    }
    // A fresh root Session has its own direct-child catalog; the previous one
    // must not leak into a fixture that reports native state.
    delete this.infoValue.subagents
    this.demoSubagents.clear()
    this.demoChildEvents.clear()
    this.events.length = 0
    this.seq = 0
    // A fresh Agent attachment has its own inbox: the old queued input is not
    // silently carried into the new session.
    this.queue.length = 0
    this.paused = false
    this.emit({ type: 'ready', info: this.infoValue })
    this.resolveIdle()
  }

  private emit(event: BackendEvent): void {
    if (this.closed && event.type !== 'closed') return
    for (const listener of [...this.listeners]) listener(event)
  }

  private now(): number {
    this.clock += 17
    return DEMO_BASE_TIME + this.clock
  }

  private nextSeq(): number {
    this.seq += 1
    return this.seq
  }

  private append(type: string, data: unknown, extra?: EventExtras): SessionEvent {
    return this.appendAt(this.nextSeq(), type, data, extra)
  }

  private appendAt(seq: number, type: string, data: unknown, extra?: EventExtras): SessionEvent {
    const event: SessionEvent = {
      type,
      seq,
      time: this.now(),
      data,
      // Truthful append origin for every surface-producing event: this fixture
      // never fabricates replacements or compaction shadowing.
      ...(DEMO_SURFACE_TYPES.has(type) ? { surfaceOp: 'append' as const } : {}),
      ...(extra?.toolPresentation === undefined ? {} : { toolPresentation: extra.toolPresentation }),
    }
    this.events.push(event)
    this.emit({ type: 'session_event', sessionId: this.infoValue.sessionId, event })
    return event
  }

  /**
   * Native-shaped command execution: durable `command/run` + `command/done`
   * pairing plus the handler's normalized result. Entirely offline.
   */
  private executeLine(line: string): DemoCommandExecution {
    const trimmed = line.trim()
    if (!trimmed.startsWith('/')) throw new Error(`Demo command line must start with "/": ${trimmed}`)
    const body = trimmed.slice(1)
    const separator = body.search(/\s/)
    const name = separator < 0 ? body : body.slice(0, separator)
    const args = separator < 0 ? '' : body.slice(separator).trim()
    const commandId = `demo-command-${++this.commandCounter}`
    const descriptor = DEMO_COMMANDS.find(command => command.name === name)
    this.append('command/run', { commandId, name, ...(args === '' ? {} : { args }), source: { kind: 'user' } })
    let result: DemoCommandExecution['result']
    try {
      result = descriptor === undefined
        ? { kind: 'error', text: `Unknown demo command "/${name}". Try ${DEMO_COMMANDS.map(command => '/' + command.name).join(', ')}.` }
        : { kind: 'success', text: this.runDemoCommand(name, args) }
    } catch (error) {
      result = { kind: 'error', text: error instanceof Error ? error.message : String(error) }
    }
    this.append('command/done', {
      commandId,
      kind: result.kind,
      ...(result.text === undefined ? {} : { text: result.text }),
    })
    return { commandId, result }
  }

  private runDemoCommand(name: string, args: string): string {
    switch (name) {
      case 'compact':
        return 'Demo compaction simulated. DSH owns real compaction, durable history and model-visible surface replacement.'
      case 'permission': {
        if (!args) return `Demo current preset ${this.infoValue.permissions?.currentValue} (available: ${DEMO_PERMISSION_OPTIONS.map(option => option.value).join(', ')})`
        if (!DEMO_PERMISSION_OPTIONS.some(option => option.value === args)) throw new Error(`Unknown demo permission preset: ${args}`)
        const value = { currentValue: args }
        this.infoValue = { ...this.infoValue, permissions: value }
        this.append('permission/preset', { preset: args })
        this.emit({ type: 'permissions', sessionId: this.infoValue.sessionId, value })
        return `Demo permission preset ${args} (simulated; no real permissions changed).`
      }
      case 'status':
        return `Demo session ${this.infoValue.sessionId} · ${this.running ? 'running' : 'idle'} · ${this.queue.length} queued`
      case 'help':
        return DEMO_COMMANDS.map(command => `/${command.name} — ${command.description}`).join('\n')
      case 'echo':
        return args === '' ? '(nothing to echo)' : args
      default:
        return 'No demo behavior for this command.'
    }
  }

  private pause(): Promise<void> {
    if (this.closed) return Promise.resolve()
    if (this.delayMs === 0) return Promise.resolve()
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        resolve()
      }, this.delayMs)
      this.timers.set(timer, resolve)
    })
  }

  /** No active turn/decision; a paused inbox is retained but not "running". */
  private isIdle(): boolean {
    if (this.running || this.pendingDecisions.size > 0) return false
    return this.paused || this.queue.length === 0
  }

  private resolveIdle(): void {
    if (!this.isIdle()) return
    for (const idle of this.idleWaiters.splice(0)) idle()
  }

  private demoQueueIndex(messageId: unknown): number {
    const id = typeof messageId === 'string' ? messageId : ''
    const index = Number(id.slice('demo-pending-'.length))
    if (!id.startsWith('demo-pending-') || !Number.isInteger(index) || index < 0 || index >= this.queue.length) {
      throw new Error('queued message is gone')
    }
    return index
  }

  private runQueue(): void {
    if (this.running || this.closed) return
    const text = this.queue.shift()
    if (text === undefined) {
      this.resolveIdle()
      return
    }
    this.running = true
    this.abortFlag = false
    this.emit({ type: 'status', sessionId: this.infoValue.sessionId, status: 'running' })
    void this.runTurn(text)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.emit({ type: 'error', message: `Demo fixture failed: ${message}`, fatal: false })
      })
      .finally(() => {
        this.running = false
        if (this.closed) {
          this.resolveIdle()
          return
        }
        this.emit({ type: 'status', sessionId: this.infoValue.sessionId, status: 'idle' })
        // A paused queue is retained but never drained automatically.
        if (!this.paused && this.queue.length > 0) this.runQueue()
        else this.resolveIdle()
      })
  }

  private async runTurn(text: string): Promise<void> {
    const turn = ++this.turnCounter
    const step = 1
    this.abortFlag = false
    this.append('turn/start', { turn })
    const lower = text.toLowerCase()
    const imageRequest = lower.includes('images') || lower.includes('image') || text.includes('图片')
    this.append('user/message', {
      id: `demo-user-${turn}`,
      role: 'user',
      // The images fixture carries real canonical refs in text/image order;
      // every other flow stays the historical single text block.
      content: imageRequest
        ? [
            { type: 'text', text: text.trim() === '' ? '请查看这两张图片。' : text },
            { type: 'image', attachment: DEMO_PNG.attachment },
            { type: 'text', text: '第一张是 PNG，第二张是 JPEG；同一张 PNG 会在工具结果里再次出现。' },
            { type: 'image', attachment: DEMO_JPEG.attachment },
            { type: 'image', attachment: DEMO_PNG.attachment },
          ]
        : [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    this.append('step/start', { turn, step })

    let reason: unknown = { kind: 'completed' }
    if (imageRequest) {
      reason = await this.imagesFlow(turn, step)
    } else if (lower.includes('subagent') || lower.includes('agents') || text.includes('子代理') || text.includes('子任务')) {
      reason = await this.subagentFlow(turn, step)
    } else if (lower.includes('question') || text.includes('问题') || text.includes('问卷')) {
      reason = await this.questionFlow(turn, step)
    } else if (lower.includes('approval') || lower.includes('permission') || text.includes('审批')) {
      reason = await this.approvalFlow(turn, step)
    } else if (lower.includes('abort') || lower.includes('cancel') || text.includes('取消')) {
      reason = await this.abortFlow(turn, step)
    } else if (lower.includes('fail') || lower.includes('error') || text.includes('错误')) {
      reason = await this.failFlow(turn, step)
    } else if (lower.includes('tools-group') || lower.includes('tools group')) {
      reason = await this.toolsGroupFlow(turn, step)
    } else if (lower.includes('tool') || text.includes('工具')) {
      reason = await this.toolsFlow(turn, step)
    } else if (lower.includes('pending') || lower.includes('unresolved')) {
      reason = await this.pendingToolFlow(turn, step)
    } else {
      reason = await this.normalFlow(turn, step)
    }
    this.append('turn/end', { turn, reason })
  }

  // -------------------------------------------------------------------------
  // Streams

  private async liveStream(turn: number, step: number, chunks: readonly DemoChunk[], abortAfter?: number): Promise<StreamMeta | undefined> {
    const attemptId = `attempt-${++this.attemptCounter}`
    let revision = ++this.revisionCounter
    this.emit({ type: 'stream_start', sessionId: this.infoValue.sessionId, attemptId, revision, turn, step })
    const timed: TimedChunk[] = []
    for (const chunk of chunks) {
      if (this.abortFlag || this.closed) {
        this.emit({ type: 'stream_end', sessionId: this.infoValue.sessionId, attemptId, revision: ++this.revisionCounter, outcome: 'abandoned' })
        return undefined
      }
      const index = timed.length
      const time = this.now()
      timed.push({ index, time, chunk })
      // Match native DSH: every publication gets a new revision.
      revision = ++this.revisionCounter
      this.emit({ type: 'stream_chunk', sessionId: this.infoValue.sessionId, attemptId, revision, index, chunk: chunk as JsonRecord })
      if (abortAfter !== undefined && index + 1 >= abortAfter) this.abortFlag = true
      await this.pause()
    }
    if (this.abortFlag || this.closed) {
      this.emit({ type: 'stream_end', sessionId: this.infoValue.sessionId, attemptId, revision: ++this.revisionCounter, outcome: 'abandoned' })
      return undefined
    }
    return { attemptId, revision, timed }
  }

  private commitMessage(meta: StreamMeta, turn: number, step: number, content: readonly unknown[], interrupted = false): SessionEvent {
    const seq = this.nextSeq()
    const event = this.appendAt(seq, 'assistant/message', {
      turn,
      step,
      message: {
        id: `demo-assistant-${seq}`,
        role: 'assistant',
        content,
        source: { kind: 'model', provider: DEMO_PROVIDER, model: this.infoValue.model },
      },
      stream: compactStream(meta.timed),
      ...(interrupted ? { interrupted: true } : {}),
      usage: { inputTokens: 42, outputTokens: Math.max(1, meta.timed.length * 3) },
    })
    this.emit({ type: 'stream_end', sessionId: this.infoValue.sessionId, attemptId: meta.attemptId, revision: ++this.revisionCounter, outcome: 'committed', seq })
    return event
  }

  private commitAttempt(meta: StreamMeta, turn: number, step: number): SessionEvent {
    const seq = this.nextSeq()
    const event = this.appendAt(seq, 'assistant/attempt', { turn, step, stream: compactStream(meta.timed) })
    this.emit({ type: 'stream_end', sessionId: this.infoValue.sessionId, attemptId: meta.attemptId, revision: ++this.revisionCounter, outcome: 'committed', seq })
    return event
  }

  /** Build block-start/delta/block-end/usage/finish chunks for one text block. */
  private textChunks(index: number, text: string, kind: 'text' | 'reasoning'): DemoChunk[] {
    const out: DemoChunk[] = [
      { type: 'block-start', index, blockType: kind },
      ...splitGraphemes(text, 14).map(fragment => ({ type: kind === 'text' ? 'text-delta' : 'reasoning-delta', index, text: fragment })),
      { type: 'block-end', index, block: { type: kind, text } },
    ]
    return out
  }

  private toolChunks(index: number, id: string, name: string, args: string): DemoChunk[] {
    return [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'tool-call-delta', index, id, name, argumentsDelta: args },
      { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } },
    ]
  }

  /**
   * Image block in the fixture stream. Only this offline codec produces it;
   * the store still treats the resulting ref as opaque display data.
   */
  private imageChunks(index: number, attachment: ImageAttachmentRef): DemoChunk[] {
    return [
      { type: 'block-start', index, blockType: 'image', attachment },
      { type: 'block-end', index, block: { type: 'image', attachment } },
    ]
  }

  private terminalChunks(): DemoChunk[] {
    return [
      { type: 'usage', usage: { inputTokens: 42, outputTokens: 128, totalTokens: 170 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
  }

  // -------------------------------------------------------------------------
  // Fixtures

  /**
   * Offline image showcase: canonical PNG/JPEG refs, a duplicate occurrence,
   * a pure-image assistant turn, a pure-image tool result, and an adjacent
   * long-output/diff tool group. No bytes are fetched while folded/streaming:
   * the UI reads them only when an image viewer opens.
   */
  private async imagesFlow(turn: number, step: number): Promise<unknown> {
    const reasoning = [
      'Demo reasoning: the user attached real image refs, so the projection must keep their positions.',
      'The reply itself also carries images: one JPEG and one PNG that repeats the user turn ref.',
      'After the answer a pure-image assistant message proves it is not dropped for having no text.',
      'Then a read_image tool result returns another canonical ref, followed by adjacent bash/edit tools.',
    ].join('\n')
    const intro = '图片按 text/image 原始顺序投影：先 PNG，后 JPEG，再重复一次 PNG。\n\n下面是我的两张图。'
    const chunks = [
      ...this.textChunks(0, reasoning, 'reasoning'),
      ...this.textChunks(1, intro, 'text'),
      ...this.imageChunks(2, DEMO_JPEG.attachment),
      ...this.imageChunks(3, DEMO_PNG.attachment),
      ...this.terminalChunks(),
    ]
    const meta = await this.liveStream(turn, step, chunks)
    if (meta === undefined) return { kind: 'aborted' }
    this.commitMessage(meta, turn, step, [
      { type: 'reasoning', text: reasoning },
      { type: 'text', text: intro },
      { type: 'image', attachment: DEMO_JPEG.attachment },
      { type: 'image', attachment: DEMO_PNG.attachment },
    ])

    // Pure-image assistant message: no text block at all, still a real reply.
    this.append('assistant/message', {
      turn,
      step,
      message: {
        id: `demo-assistant-image-${this.seq + 1}`,
        role: 'assistant',
        content: [{ type: 'image', attachment: DEMO_PNG.attachment }],
        source: { kind: 'model', provider: DEMO_PROVIDER, model: this.infoValue.model },
      },
      usage: { inputTokens: 42, outputTokens: 12 },
    })

    // Adjacent tool calls in one turn: the pure-image read_image result, a long
    // terminal output and an applied diff. The UI may group them; the image
    // ref stays a per-tool entry and never merges with transcript occurrences.
    const readId = `call-demo-image-${turn}`
    const readArgs = JSON.stringify({ path: 'demo/quadrants.png' })
    this.append('tool/call', { turn, step, callId: readId, name: 'read_image', arguments: readArgs }, {
      toolPresentation: {
        call: { card: 'generic', title: 'Read demo/quadrants.png', content: [{ type: 'text', text: 'read the synthetic image fixture' }] },
      },
    })
    this.append('tool/result', {
      turn,
      step,
      message: {
        id: `demo-tool-result-${this.seq + 1}`,
        role: 'tool',
        toolCallId: readId,
        content: [{ type: 'image', attachment: DEMO_PNG.attachment }],
        isError: false,
        source: { kind: 'tool', callId: readId },
      },
      meta: { mediaType: DEMO_PNG.attachment.mediaType },
    }, {
      toolPresentation: { result: { card: 'generic', content: [{ type: 'image', attachment: DEMO_PNG.attachment }] } },
    })

    const bashId = `call-demo-image-bash-${turn}`
    const bashOutput = Array.from({ length: 16 }, (_, index) => `image fixture line ${index + 1}`).join('\n')
    const bashArgs = JSON.stringify({ command: 'printf "image fixture\\n"', description: 'Long adjacent output' })
    this.append('tool/call', { turn, step, callId: bashId, name: 'bash', arguments: bashArgs }, {
      toolPresentation: { call: { card: 'terminal', title: 'image fixture output', description: 'Adjacent long terminal output', cwd: this.infoValue.cwd } },
    })
    this.append('tool/result', {
      turn,
      step,
      message: {
        id: `demo-tool-result-${this.seq + 1}`,
        role: 'tool',
        toolCallId: bashId,
        content: [{ type: 'text', text: bashOutput }],
        isError: false,
        source: { kind: 'tool', callId: bashId },
      },
    }, {
      toolPresentation: { result: { card: 'terminal', output: bashOutput + '\n', exitCode: 0 } },
    })

    const editId = `call-demo-image-edit-${turn}`
    const editArgs = JSON.stringify({ file_path: 'src/image-demo.ts', old_string: 'before', new_string: 'after' })
    this.append('tool/call', { turn, step, callId: editId, name: 'edit', arguments: editArgs }, {
      toolPresentation: {
        call: {
          card: 'diff',
          title: 'Edit src/image-demo.ts',
          diffs: [{ path: 'src/image-demo.ts', oldText: null, newText: 'after  // synthetic image fixture' }],
          locations: [{ path: 'src/image-demo.ts' }],
        },
      },
    })
    this.append('tool/result', {
      turn,
      step,
      message: {
        id: `demo-tool-result-${this.seq + 1}`,
        role: 'tool',
        toolCallId: editId,
        content: [{ type: 'text', text: 'Updated src/image-demo.ts with 1 addition.' }],
        isError: false,
        source: { kind: 'tool', callId: editId },
      },
      meta: {
        diffs: [{ path: 'src/image-demo.ts', oldText: 'before\n', newText: 'after  // synthetic image fixture\n' }],
        operation: 'update',
      },
    }, {
      toolPresentation: {
        result: { card: 'diff', diffs: [{ path: 'src/image-demo.ts', oldText: 'before\n', newText: 'after  // synthetic image fixture\n' }] },
      },
    })

    const finalText = '图片 fixture 完成：PNG/JPEG、重复 ref、纯图 assistant、纯图工具结果与相邻工具组都来自离线 fixture；没有读取真实文件或调用模型。'
    const second = await this.liveStream(turn, step, [
      ...this.textChunks(0, finalText, 'text'),
      ...this.terminalChunks(),
    ])
    if (second === undefined) return { kind: 'aborted' }
    this.commitMessage(second, turn, step, [{ type: 'text', text: finalText }])
    return { kind: 'completed' }
  }

  /**
   * Native subagent showcase: parallel direct children (running / completed /
   * failed), one nested child, one external task with no local Session, the
   * durable settlement + adjacent-Agent trigger messages, and a live
   * continuable reactivation (idle snapshot -> running upsert).
   *
   * Catalog seqs are real parent log seqs, so the transcript anchors one row
   * per direct child exactly where DSH recorded it. The external and nested
   * rows have no root transcript anchor; they remain in progress/Agents views.
   */
  private async subagentFlow(turn: number, step: number): Promise<unknown> {
    const sessionId = this.infoValue.sessionId
    const at = this.now()
    const exploreSeq = this.append('subagent/catalog', {
      version: 0,
      childId: DEMO_CHILD_EXPLORE,
      childCreatedAt: at - 3_000,
      mode: 'continuable',
      label: 'Explore repository',
    }).seq
    const reviewSeq = this.append('subagent/catalog', {
      version: 0,
      childId: DEMO_CHILD_REVIEW,
      childCreatedAt: at - 2_000,
      mode: 'one-shot',
      label: 'Review changes',
    }).seq
    const verifySeq = this.append('subagent/catalog', {
      version: 0,
      childId: DEMO_CHILD_VERIFY,
      childCreatedAt: at - 1_000,
      mode: 'one-shot',
      label: 'Verify build',
    }).seq

    const exploreIdle: SubagentEntry = {
      id: DEMO_CHILD_EXPLORE,
      parentSessionId: sessionId,
      catalogSeq: exploreSeq,
      createdAt: at - 3_000,
      mode: 'continuable',
      label: 'Explore repository',
      provider: this.infoValue.provider,
      model: this.infoValue.model,
      reasoningEffort: this.infoValue.reasoningEffort ?? DEMO_DEFAULT_EFFORT,
      local: true,
      status: 'idle',
      lastRunId: 'demo-run-2',
      lastStopReason: 'completed',
      totalTokens: 18_420,
      timing: { settledMs: 42_000, lastTurnCompleted: true },
    }
    const review: SubagentEntry = {
      id: DEMO_CHILD_REVIEW,
      parentSessionId: sessionId,
      catalogSeq: reviewSeq,
      createdAt: at - 2_000,
      mode: 'one-shot',
      label: 'Review changes',
      provider: this.infoValue.provider,
      model: this.infoValue.model,
      local: true,
      status: 'completed',
      lastStopReason: 'completed',
      totalTokens: 9_310,
      timing: { settledMs: 63_000, lastTurnCompleted: true },
    }
    const verify: SubagentEntry = {
      id: DEMO_CHILD_VERIFY,
      parentSessionId: sessionId,
      catalogSeq: verifySeq,
      createdAt: at - 1_000,
      mode: 'one-shot',
      label: 'Verify build',
      provider: this.infoValue.provider,
      model: this.infoValue.model,
      local: true,
      status: 'failed',
      lastStopReason: 'error',
      totalTokens: 5_120,
      timing: { settledMs: 18_000, lastTurnCompleted: false },
    }
    const nested: SubagentEntry = {
      id: DEMO_CHILD_TEST,
      parentSessionId: DEMO_CHILD_EXPLORE,
      createdAt: at - 1_500,
      mode: 'one-shot',
      label: 'Run focused tests',
      provider: this.infoValue.provider,
      model: this.infoValue.model,
      local: true,
      status: 'idle',
      lastRunId: 'demo-run-2',
      lastStopReason: 'completed',
      totalTokens: 2_210,
      timing: { settledMs: 9_000, lastTurnCompleted: true },
    }
    const external: SubagentEntry = {
      id: DEMO_CHILD_EXTERNAL,
      parentSessionId: sessionId,
      createdAt: at - 500,
      mode: 'external',
      label: 'External research',
      status: 'external',
      local: false,
    }

    const summary = `Background subagent ${DEMO_CHILD_REVIEW} finished. It cannot receive follow-up messages.`
    this.append('user/message', {
      id: 'demo-subagent-settlement',
      role: 'user',
      content: [
        { type: 'text', text: summary },
        { type: 'text', text: 'Its closing message:' },
        { type: 'text', text: 'Reviewed the frontend diff; no blocking issues.' },
      ],
      source: {
        kind: 'subagent-settled',
        form: 'notice',
        summary,
        senderSessionId: DEMO_CHILD_REVIEW,
      },
    })
    this.append('user/message', {
      id: 'demo-subagent-agent-message',
      role: 'user',
      content: [
        { type: 'text', text: `Agent ${DEMO_CHILD_EXPLORE} sent a message: ` },
        { type: 'text', text: 'The transcript projection is in src/state/transcript.ts; the overlay list is in src/ui/agents-overlay.ts.' },
      ],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: DEMO_CHILD_EXPLORE },
    })

    const idleSnapshot: SubagentSnapshot = { entries: [exploreIdle, review, verify, nested, external] }
    this.infoValue = { ...this.infoValue, subagents: idleSnapshot }
    this.emit({ type: 'subagents', sessionId, value: idleSnapshot })
    this.registerDemoChildren(idleSnapshot.entries)

    const exploreRunning: SubagentEntry = {
      id: DEMO_CHILD_EXPLORE,
      parentSessionId: sessionId,
      catalogSeq: exploreSeq,
      createdAt: at - 3_000,
      mode: 'continuable',
      label: 'Explore repository',
      provider: this.infoValue.provider,
      model: this.infoValue.model,
      reasoningEffort: this.infoValue.reasoningEffort ?? DEMO_DEFAULT_EFFORT,
      local: true,
      status: 'running',
      lastActivity: 'reading src/state/transcript.ts',
      lastRunId: 'demo-run-3',
      totalTokens: 18_420,
      timing: { settledMs: 42_000, activeSince: at, activeThrough: at + 2_000 },
    }
    this.emit({ type: 'subagent', sessionId, value: exploreRunning })
    this.demoSubagents.set(DEMO_CHILD_EXPLORE, exploreRunning)
    const finalSnapshot: SubagentSnapshot = {
      entries: [exploreRunning, review, verify, nested, external],
    }
    this.infoValue = { ...this.infoValue, subagents: finalSnapshot }

    const text = [
      '已载入原生 **子 Agent** 目录（fixture）。',
      '',
      '- Explore repository：continuable，当前运行中，可点击编辑框上方的 agent 名字链接查看子会话。',
      '- Review changes：one-shot 已完成，并写入原生结算消息。',
      '- Verify build：one-shot 失败，不伪装成成功。',
      '- External research：外部任务，进度区／Agents 树可见，没有本地会话。',
      '',
      '仅点击带下划线的 agent 名字进入子会话，Esc 返回原编辑框；状态／指标／活动可选字复制但不跳转。`app.subagents.details` 打开完整 Agents 树。`subagent.reply` / `subagent.interrupt` 分别请求继续对话与停止（仅对适用的子 Agent）。以上全部为离线确定性 fixture，不调用模型。',
    ].join('\n')
    const chunks = [...this.textChunks(0, text, 'text'), ...this.terminalChunks()]
    const meta = await this.liveStream(turn, step, chunks)
    if (meta === undefined) return { kind: 'aborted' }
    this.commitMessage(meta, turn, step, [{ type: 'text', text }])
    // Keep the fixture snapshot replayable: the demo's `info.events` is the
    // durable log a resume/ready snapshot would carry.
    this.infoValue = {
      ...this.infoValue,
      subagents: finalSnapshot,
      events: [...this.events],
    }
    return { kind: 'completed' }
  }

  /** Deterministic durable child transcript served by `subagent-session`. */
  private childSessionInfo(sessionId: string, answer: string): SessionInfo {
    const cached = this.demoChildEvents.get(sessionId)
    const events = cached ?? this.createChildEvents(sessionId, answer)
    this.demoChildEvents.set(sessionId, events)
    return {
      sessionId,
      cwd: this.infoValue.cwd,
      provider: DEMO_PROVIDER,
      model: DEMO_MODEL,
      capabilities: [],
      // A copy: the caller folds its own projection and must not mutate the log.
      events: [...events],
    }
  }

  /** Baseline durable child log: one completed fixture turn, no model call. */
  private createChildEvents(sessionId: string, answer: string): SessionEvent[] {
    const time = DEMO_BASE_TIME + 10_000
    return [
      { type: 'turn/start', seq: 1, time, data: { turn: 1 }, surfaceOp: 'append' },
      {
        type: 'user/message',
        seq: 2,
        time: time + 1,
        data: {
          id: `demo-child-user-${sessionId}`,
          role: 'user',
          content: [{ type: 'text', text: `Fixture task for ${sessionId}.` }],
          source: { kind: 'user' },
        },
        surfaceOp: 'append',
      },
      { type: 'step/start', seq: 3, time: time + 2, data: { turn: 1, step: 1 } },
      {
        type: 'assistant/message',
        seq: 4,
        time: time + 3,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: `demo-child-assistant-${sessionId}`,
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'Deterministic demo reasoning; no model call is made.' },
              { type: 'text', text: answer },
            ],
            source: { kind: 'model', provider: DEMO_PROVIDER, model: DEMO_MODEL },
          },
          stream: [],
        },
        surfaceOp: 'append',
      },
      { type: 'turn/end', seq: 5, time: time + 4, data: { turn: 1, reason: { kind: 'completed' } }, surfaceOp: 'append' },
    ]
  }

  /**
   * Remember the fixture catalog rows so the intervention commands can resolve
   * a child exactly like the native catalog does (and refuse anything else).
   */
  private registerDemoChildren(entries: readonly SubagentEntry[]): void {
    for (const entry of entries) this.demoSubagents.set(entry.id, entry)
  }

  /** Store one mutated fixture row and emit the native upsert a surface folds. */
  private projectDemoChild(entry: SubagentEntry): void {
    this.demoSubagents.set(entry.id, entry)
    const snapshot = this.infoValue.subagents
    if (snapshot !== undefined) {
      this.infoValue = {
        ...this.infoValue,
        subagents: {
          entries: snapshot.entries.map(row => row.id === entry.id ? entry : row),
          ...(snapshot.truncated === true ? { truncated: true } : {}),
        },
      }
    }
    this.emit({ type: 'subagent', sessionId: this.infoValue.sessionId, value: entry })
  }

  /** Append one durable child event and emit it for an already-open child view. */
  private appendChildEvent(sessionId: string, events: SessionEvent[], type: string, data: unknown): SessionEvent {
    const previous = events[events.length - 1]
    const seq = (previous?.seq ?? 0) + 1
    const event: SessionEvent = {
      type,
      seq,
      time: this.now(),
      data,
      ...(DEMO_SURFACE_TYPES.has(type) ? { surfaceOp: 'append' as const } : {}),
    }
    events.push(event)
    this.emit({ type: 'session_event', sessionId, event })
    return event
  }

  /** Resolve a fixture child that really has a local Session to mutate. */
  private demoLocalChild(sessionId: string, verb: string): SubagentEntry {
    const entry = this.demoSubagents.get(sessionId)
    if (entry === undefined) {
      if (sessionId === DEMO_CHILD_EXTERNAL) {
        throw new Error(`No demo child session "${sessionId}" (external tasks have no local transcript)`)
      }
      throw new Error(`No demo child session "${sessionId}"`)
    }
    if (entry.mode === 'external' || entry.status === 'external' || entry.local === false) {
      throw new Error(`Demo child "${sessionId}" is an external task and cannot ${verb}`)
    }
    return entry
  }

  /**
   * Fixture-only native interrupt: the addressed child becomes `stopped` when
   * the native lifecycle says it is running/initializing.
   *
   * No Agent is cancelled and no model call exists here; this is the demo's
   * explicit state transition so the Stop affordance can be exercised offline.
   * The response mirrors the adapter's `{sessionId, parentSessionId, accepted}`
   * shape and adds the fixture marker plus what actually changed.
   */
  private subagentInterruptCommand(args: JsonRecord): unknown {
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
    if (sessionId === '') throw new Error('DemoBackend command "subagent-interrupt" needs { sessionId }')
    const entry = this.demoLocalChild(sessionId, 'be interrupted')
    const stoppable = entry.status === 'running' || entry.status === 'initializing'
    if (stoppable) this.projectDemoChild(this.stoppedChild(entry))
    const projected = this.demoSubagents.get(sessionId) ?? entry
    return {
      accepted: true,
      demo: true,
      sessionId,
      parentSessionId: entry.parentSessionId,
      stopped: stoppable,
      status: projected.status,
    }
  }

  /** Project one running child as stopped, folding the open turn into settled time. */
  private stoppedChild(entry: SubagentEntry): SubagentEntry {
    const at = this.now()
    const timing = entry.timing
    const open = timing?.activeSince === undefined ? 0 : Math.max(0, at - timing.activeSince)
    const next: SubagentEntry = {
      ...entry,
      status: 'stopped',
      lastStopReason: 'aborted',
      timing: {
        settledMs: (timing?.settledMs ?? 0) + open,
        activeThrough: at,
        lastTurnCompleted: false,
      },
    }
    delete next.lastActivity
    return next
  }

  /**
   * Fixture-only follow-up prompt: append the durable user message (keeping
   * image blocks intact), reactivate the continuable child and schedule one
   * deterministic assistant reply. No model, network or filesystem is used.
   */
  private async subagentPromptCommand(args: JsonRecord): Promise<unknown> {
    const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
    if (sessionId === '') throw new Error('DemoBackend command "subagent-prompt" needs { sessionId }')
    const child = this.demoLocalChild(sessionId, 'receive a follow-up prompt')
    if (child.mode !== 'continuable') {
      throw new Error(`Demo child "${sessionId}" is ${child.mode} and cannot receive follow-up messages`)
    }
    const content = demoPromptBlocks(args)
    const delivery = demoPromptDelivery(args)
    const requestedId = args.requestId
    if (requestedId !== undefined && (typeof requestedId !== 'string' || requestedId === '')) {
      throw new Error('DemoBackend subagent-prompt requestId must be a non-empty string when present')
    }
    const events = this.demoChildEvents.get(sessionId) ?? this.createChildEvents(sessionId, DEMO_CHILD_SESSIONS[sessionId] ?? '')
    this.demoChildEvents.set(sessionId, events)
    const counter = ++this.subagentMessageCounter
    const messageId = `demo-child-user-prompt-${counter}`
    const requestId = typeof requestedId === 'string' ? requestedId : `demo-child-request-${counter}`
    const turn = events.reduce((count, event) => count + (event.type === 'turn/start' ? 1 : 0), 0) + 1
    this.appendChildEvent(sessionId, events, 'turn/start', { turn })
    this.appendChildEvent(sessionId, events, 'user/message', {
      id: messageId,
      role: 'user',
      content,
      source: { kind: 'user' },
    })
    this.appendChildEvent(sessionId, events, 'step/start', { turn, step: 1 })
    const runId = `demo-run-child-${counter}`
    this.projectDemoChild({
      ...child,
      status: 'running',
      lastActivity: delivery === 'steer' ? 'applying the steered prompt' : 'reading the follow-up prompt',
      lastRunId: runId,
      timing: { settledMs: child.timing?.settledMs ?? 0, activeSince: this.now() },
    })
    void this.completeDemoChildPrompt(sessionId, runId, delivery)
    return {
      messageId,
      requestId,
      sessionId,
      parentSessionId: child.parentSessionId,
      delivery,
      runId,
      demo: true,
    }
  }

  /**
   * Deterministic follow-up completion. Aborts silently when the fixture was
   * interrupted/replaced (the run id no longer matches) or the backend closed.
   */
  private async completeDemoChildPrompt(sessionId: string, runId: string, delivery: 'queue' | 'steer'): Promise<void> {
    await this.pause()
    if (this.closed) return
    const current = this.demoSubagents.get(sessionId)
    if (current === undefined || current.lastRunId !== runId) return
    const events = this.demoChildEvents.get(sessionId)
    if (events === undefined) return
    const turn = events.reduce((count, event) => count + (event.type === 'turn/start' ? 1 : 0), 0)
    const text = delivery === 'steer'
      ? 'Acknowledged the steered prompt at the next step boundary (offline fixture).'
      : 'Follow-up received (offline fixture). The continuable child completed another deterministic run; no model call was made.'
    this.appendChildEvent(sessionId, events, 'assistant/message', {
      turn,
      step: 1,
      message: {
        id: `demo-child-assistant-${runId}`,
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: DEMO_PROVIDER, model: DEMO_MODEL },
      },
      stream: [],
    })
    this.appendChildEvent(sessionId, events, 'turn/end', { turn, reason: { kind: 'completed' } })
    const at = this.now()
    const timing = current.timing
    const open = timing?.activeSince === undefined ? 0 : Math.max(0, at - timing.activeSince)
    const next: SubagentEntry = {
      ...current,
      status: 'idle',
      lastStopReason: 'completed',
      timing: { settledMs: (timing?.settledMs ?? 0) + open, activeThrough: at, lastTurnCompleted: true },
    }
    delete next.lastActivity
    this.projectDemoChild(next)
  }

  private async normalFlow(turn: number, step: number): Promise<unknown> {
    // Long enough to fold: the transcript shows `✻ Thought for … · n more lines`
    // with the tail of this text as the preview (default 3 lines), and clicking
    // the summary (or `app.thinking.toggle`) expands the whole reasoning.
    const reasoning = [
      'Demo reasoning: build a deterministic reply, then update a file through the edit tool.',
      'The reply needs Markdown, a Chinese sentence and an emoji so the projection is visible in one pass.',
      'After that the edit tool gets a native diff card, which the transcript renders from the presentation intent.',
    ].join('\n')
    const firstText = [
      'Here is a deterministic **demo** of the DSH → Pi TUI projection.',
      '',
      '中文、emoji 🚀，以及一段 TypeScript：',
      '',
      '```ts',
      'export function greet(name: string): string {',
      '  return `你好, ${name} 👋`',
      '}',
      '```',
      '',
      '接下来我会展示一个带 diff 的工具结果。',
    ].join('\n')
    const args = JSON.stringify({ file_path: 'src/greet.ts', old_string: 'Hello, ${name}!', new_string: '你好, ${name} 👋' })
    const chunks = [
      ...this.textChunks(0, reasoning, 'reasoning'),
      ...this.textChunks(1, firstText, 'text'),
      ...this.toolChunks(2, 'call-demo-edit', 'edit', args),
      ...this.terminalChunks(),
    ]
    const meta = await this.liveStream(turn, step, chunks)
    if (meta === undefined) return { kind: 'aborted' }
    this.commitMessage(meta, turn, step, [
      { type: 'reasoning', text: reasoning },
      { type: 'text', text: firstText },
      { type: 'tool-call', id: 'call-demo-edit', name: 'edit', arguments: args },
    ])
    this.append('tool/call', { turn, step, callId: 'call-demo-edit', name: 'edit', arguments: args }, {
      // Native `presentCall` intent for this exact edit call (fixture copy).
      toolPresentation: {
        call: {
          card: 'diff',
          title: 'Edit src/greet.ts',
          diffs: [{ path: 'src/greet.ts', oldText: null, newText: '你好, ${name} 👋' }],
          locations: [{ path: 'src/greet.ts' }],
        },
      },
    })
    const oldText = [
      'export function greet(name: string): string {',
      '  return `Hello, ${name}!`',
      '}',
      '',
    ].join('\n')
    const newText = [
      'export function greet(name: string): string {',
      '  return `你好, ${name} 👋`',
      '}',
      '',
    ].join('\n')
    this.append('tool/result', {
      turn,
      step,
      message: {
        id: `demo-tool-result-${this.seq + 1}`,
        role: 'tool',
        toolCallId: 'call-demo-edit',
        content: [{ type: 'text', text: 'Updated src/greet.ts with 2 additions and 1 removal.' }],
        isError: false,
        source: { kind: 'tool', callId: 'call-demo-edit' },
      },
      meta: { diffs: [{ path: 'src/greet.ts', oldText, newText }], operation: 'update' },
    }, {
      // Native `presentResult` intent: the applied hunk from the tool itself.
      toolPresentation: { result: { card: 'diff', diffs: [{ path: 'src/greet.ts', oldText, newText }] } },
    })
    const finalText = '完成。Demo 没有执行真实文件或网络操作；输入 `question`、`approval`、`abort`、`fail` 或 `pending` 可以回放其他路径。'
    const second = await this.liveStream(turn, step, [...this.textChunks(0, finalText, 'text'), ...this.terminalChunks()])
    if (second === undefined) return { kind: 'aborted' }
    this.commitMessage(second, turn, step, [{ type: 'text', text: finalText }])
    return { kind: 'completed' }
  }

  /** Explicit offline tool showcase: terminal call/result, then final text. */
  private async toolsFlow(turn: number, step: number): Promise<unknown> {
    const intro = [
      'Here is an offline **tool call** demo.',
      '',
      'I will run a safe terminal command, then show a file edit diff as well.',
    ].join('\n')
    const args = JSON.stringify({ command: 'pwd' })
    const chunks = [
      ...this.textChunks(0, intro, 'text'),
      ...this.toolChunks(1, 'call-demo-bash', 'bash', args),
      ...this.terminalChunks(),
    ]
    const meta = await this.liveStream(turn, step, chunks)
    if (meta === undefined) return { kind: 'aborted' }
    this.commitMessage(meta, turn, step, [
      { type: 'text', text: intro },
      { type: 'tool-call', id: 'call-demo-bash', name: 'bash', arguments: args },
    ])
    this.append('tool/call', { turn, step, callId: 'call-demo-bash', name: 'bash', arguments: args }, {
      toolPresentation: {
        call: {
          card: 'terminal',
          title: 'pwd',
          description: 'Show the demo workspace',
          cwd: this.infoValue.cwd,
        },
      },
    })
    this.append('tool/result', {
      turn,
      step,
      message: {
        id: `demo-tool-result-${this.seq + 1}`,
        role: 'tool',
        toolCallId: 'call-demo-bash',
        content: [{ type: 'text', text: `Demo workspace: ${this.infoValue.cwd}` }],
        isError: false,
        source: { kind: 'tool', callId: 'call-demo-bash' },
      },
    }, {
      toolPresentation: {
        result: { card: 'terminal', output: this.infoValue.cwd + '\n', exitCode: 0 },
      },
    })
    const oldText = [
      'export function greet(name: string): string {',
      '  return `Hello, ${name}!`',
      '}',
      '',
    ].join('\n')
    const newText = [
      'export function greet(name: string): string {',
      '  return `你好, ${name} 👋`',
      '}',
      '',
    ].join('\n')
    const editArgs = JSON.stringify({ file_path: 'src/greet.ts', old_string: 'Hello, ${name}!', new_string: '你好, ${name} 👋' })
    this.append('tool/call', { turn, step, callId: 'call-demo-tools-edit', name: 'edit', arguments: editArgs }, {
      toolPresentation: {
        call: {
          card: 'diff',
          title: 'Edit src/greet.ts',
          diffs: [{ path: 'src/greet.ts', oldText: null, newText: '你好, ${name} 👋' }],
          locations: [{ path: 'src/greet.ts' }],
        },
      },
    })
    this.append('tool/result', {
      turn,
      step,
      message: {
        id: `demo-tool-result-${this.seq + 1}`,
        role: 'tool',
        toolCallId: 'call-demo-tools-edit',
        content: [{ type: 'text', text: 'Updated src/greet.ts with 1 addition and 1 removal.' }],
        isError: false,
        source: { kind: 'tool', callId: 'call-demo-tools-edit' },
      },
      meta: { diffs: [{ path: 'src/greet.ts', oldText, newText }], operation: 'update' },
    }, {
      toolPresentation: { result: { card: 'diff', diffs: [{ path: 'src/greet.ts', oldText, newText }] } },
    })
    const finalText = 'Both cards came from the offline demo: the terminal call and the edit diff. No command ran and no file was changed.'
    const second = await this.liveStream(turn, step, [...this.textChunks(0, finalText, 'text'), ...this.terminalChunks()])
    if (second === undefined) return { kind: 'aborted' }
    this.commitMessage(second, turn, step, [{ type: 'text', text: finalText }])
    return { kind: 'completed' }
  }

  /**
   * Explicit offline tool-group showcase.
   *
   * Two Bash cards and one generic MCP card are proposed together, so the
   * renderer sees an adjacent mixed group. Their command inputs and outputs are
   * deliberately longer than one preview screen (collapsed input/output row
   * limits), which makes a non-last item's expanded tree lines observable. A
   * native Edit diff follows after a plain assistant line and separates the
   * group from the final answer. Nothing executes and no file changes.
   *
   * Every call/result id carries the turn number: replaying the keyword in the
   * same demo session creates fresh cards instead of overwriting settled ones.
   * Event times come from `append`, and short pauses keep `tool/call` visible as
   * Running before its `tool/result` settles.
   */
  private async toolsGroupFlow(turn: number, step: number): Promise<unknown> {
    const bashOneId = `call-demo-group-${turn}-bash-1`
    const bashTwoId = `call-demo-group-${turn}-bash-2`
    const mcpId = `call-demo-group-${turn}-mcp`
    const editId = `call-demo-group-${turn}-edit`

    const bashOneCommand = Array.from({ length: 8 }, (_, index) => `printf 'bash-one line ${index + 1}\\n'`).join('\n')
    const bashTwoCommand = Array.from({ length: 9 }, (_, index) => `printf 'bash-two line ${index + 1}\\n'`).join('\n')
    const bashOneOutput = Array.from({ length: 14 }, (_, index) => `bash-one output line ${index + 1}`).join('\n')
    const bashTwoOutput = Array.from({ length: 18 }, (_, index) => `bash-two output line ${index + 1}`).join('\n')
    const bashOneArgs = JSON.stringify({ command: bashOneCommand, description: 'Print the first grouped Bash fixture' })
    const bashTwoArgs = JSON.stringify({ command: bashTwoCommand, description: 'Print the second grouped Bash fixture', timeout: 5000 })
    const mcpArgs = JSON.stringify({
      server: 'demo',
      tool: 'notes.lookup',
      query: 'group fixture',
      filters: { scope: 'synthetic', limit: 3 },
    }, null, 2)
    const mcpOutput = [
      'Demo MCP note 1: synthetic group entry.',
      'Demo MCP note 2: a longer preview line keeps the generic card expandable.',
      'Demo MCP note 3: no network call was made.',
    ].join('\n')

    const editPath = 'src/group-demo.ts'
    const oldText = [
      'export function groupDemo(): string {',
      "  return 'before'  // synthetic fixture",
      '}',
      '',
    ].join('\n')
    const newText = [
      'export function groupDemo(): string {',
      "  return 'after'  // synthetic fixture",
      '  // no file was written by the demo',
      '}',
      '',
    ].join('\n')
    const editArgs = JSON.stringify({ file_path: editPath, old_string: oldText, new_string: newText })

    const intro = [
      'Here is an offline **tool group** fixture.',
      '',
      'Two Bash calls and one generic MCP call are proposed together and stay adjacent.',
      'Their inputs and outputs are longer than one preview screen, so expanding a non-last output shows the nested tree lines.',
    ].join('\n')
    const first = await this.liveStream(turn, step, [
      ...this.textChunks(0, intro, 'text'),
      ...this.toolChunks(1, bashOneId, 'bash', bashOneArgs),
      ...this.toolChunks(2, bashTwoId, 'bash', bashTwoArgs),
      ...this.toolChunks(3, mcpId, 'mcp__demo__notes', mcpArgs),
      ...this.terminalChunks(),
    ])
    if (first === undefined) return { kind: 'aborted' }
    // The proposals are model requests only; no call is admitted yet.
    this.commitMessage(first, turn, step, [
      { type: 'text', text: intro },
      { type: 'tool-call', id: bashOneId, name: 'bash', arguments: bashOneArgs },
      { type: 'tool-call', id: bashTwoId, name: 'bash', arguments: bashTwoArgs },
      { type: 'tool-call', id: mcpId, name: 'mcp__demo__notes', arguments: mcpArgs },
    ])
    await this.pause()

    // Each admitted call stays visible as Running until its result settles.
    this.append('tool/call', { turn, step, callId: bashOneId, name: 'bash', arguments: bashOneArgs }, {
      toolPresentation: {
        call: { card: 'terminal', title: 'bash-one grouped fixture', description: 'First adjacent Bash card', cwd: this.infoValue.cwd },
      },
    })
    await this.pause()
    await this.pause()
    this.append('tool/result', {
      turn,
      step,
      message: {
        id: `demo-tool-result-${this.seq + 1}`,
        role: 'tool',
        toolCallId: bashOneId,
        content: [{ type: 'text', text: bashOneOutput }],
        isError: false,
        source: { kind: 'tool', callId: bashOneId },
      },
    }, {
      toolPresentation: { result: { card: 'terminal', output: bashOneOutput + '\n', exitCode: 0 } },
    })
    await this.pause()

    this.append('tool/call', { turn, step, callId: bashTwoId, name: 'bash', arguments: bashTwoArgs }, {
      toolPresentation: {
        call: { card: 'terminal', title: 'bash-two grouped fixture', description: 'Second adjacent Bash card', cwd: this.infoValue.cwd },
      },
    })
    await this.pause()
    await this.pause()
    this.append('tool/result', {
      turn,
      step,
      message: {
        id: `demo-tool-result-${this.seq + 1}`,
        role: 'tool',
        toolCallId: bashTwoId,
        content: [{ type: 'text', text: bashTwoOutput }],
        isError: false,
        source: { kind: 'tool', callId: bashTwoId },
      },
    }, {
      toolPresentation: { result: { card: 'terminal', output: bashTwoOutput + '\n', exitCode: 0 } },
    })
    await this.pause()

    this.append('tool/call', { turn, step, callId: mcpId, name: 'mcp__demo__notes', arguments: mcpArgs }, {
      toolPresentation: {
        call: {
          card: 'generic',
          title: 'MCP demo notes lookup',
          kind: 'mcp',
          content: [{ type: 'text', text: 'query: group fixture (synthetic MCP call)' }],
        },
      },
    })
    await this.pause()
    await this.pause()
    this.append('tool/result', {
      turn,
      step,
      message: {
        id: `demo-tool-result-${this.seq + 1}`,
        role: 'tool',
        toolCallId: mcpId,
        content: [{ type: 'text', text: mcpOutput }],
        isError: false,
        source: { kind: 'tool', callId: mcpId },
      },
      meta: { server: 'demo', tool: 'notes.lookup', matches: 3 },
    }, {
      toolPresentation: { result: { card: 'generic', content: [{ type: 'text', text: mcpOutput }] } },
    })
    await this.pause()

    // The native Edit diff is the boundary between the mixed group and the answer.
    const divider = 'One native diff card now separates the mixed group from the final answer.'
    const second = await this.liveStream(turn, step, [
      ...this.textChunks(0, divider, 'text'),
      ...this.toolChunks(1, editId, 'edit', editArgs),
      ...this.terminalChunks(),
    ])
    if (second === undefined) return { kind: 'aborted' }
    this.commitMessage(second, turn, step, [
      { type: 'text', text: divider },
      { type: 'tool-call', id: editId, name: 'edit', arguments: editArgs },
    ])
    await this.pause()
    this.append('tool/call', { turn, step, callId: editId, name: 'edit', arguments: editArgs }, {
      toolPresentation: {
        call: {
          card: 'diff',
          title: `Edit ${editPath}`,
          diffs: [{ path: editPath, oldText: null, newText }],
          locations: [{ path: editPath }],
        },
      },
    })
    await this.pause()
    await this.pause()
    this.append('tool/result', {
      turn,
      step,
      message: {
        id: `demo-tool-result-${this.seq + 1}`,
        role: 'tool',
        toolCallId: editId,
        content: [{ type: 'text', text: `Updated ${editPath} with 2 additions and 1 removal.` }],
        isError: false,
        source: { kind: 'tool', callId: editId },
      },
      meta: { diffs: [{ path: editPath, oldText, newText }], operation: 'update' },
    }, {
      toolPresentation: { result: { card: 'diff', diffs: [{ path: editPath, oldText, newText }] } },
    })
    await this.pause()

    const finalText = [
      'The group, the generic MCP card and the native diff all came from offline fixtures.',
      '',
      'No command ran, no MCP server was contacted and no file was changed.',
    ].join('\n')
    const final = await this.liveStream(turn, step, [...this.textChunks(0, finalText, 'text'), ...this.terminalChunks()])
    if (final === undefined) return { kind: 'aborted' }
    this.commitMessage(final, turn, step, [{ type: 'text', text: finalText }])
    return { kind: 'completed' }
  }

  private async questionFlow(turn: number, step: number): Promise<unknown> {
    const intro = 'I have two demo questions. Choose options, add a custom answer, then submit.'
    const meta = await this.liveStream(turn, step, [...this.textChunks(0, intro, 'text'), ...this.terminalChunks()])
    if (meta === undefined) return { kind: 'aborted' }
    this.commitMessage(meta, turn, step, [{ type: 'text', text: intro }])

    const id = `demo-question-${++this.decisionCounter}`
    const request: DecisionRequest = {
      id,
      kind: 'question',
      title: 'Demo AskUserQuestion',
      message: 'Ordered answers are returned as { answers: (string | string[])[] }.',
      questions: [
        {
          question: 'Which demo colors do you want?',
          header: 'Colors',
          multiSelect: true,
          options: [
            { label: 'Blue', description: 'The default suggestion color.' },
            { label: 'Green', description: 'Used for successful choices.' },
            { label: 'Purple', description: 'A preview-capable option.', preview: '```\n#be8fff  purple\n```\nA tiny preview, rendered as plain text in the dialog.' },
          ],
        },
        {
          question: 'Pick one delivery mode.',
          header: 'Mode',
          options: [
            { label: 'Compact', description: 'Folded tool cards and short result summaries.' },
            { label: 'Expanded', description: 'Show long tool output and diff rows.' },
          ],
        },
      ],
    }
    const value = await this.waitDecision(request)
    if (isCancelledDecisionValue(value)) return this.cancelledDecision(turn, step, 'question')
    const summary = questionAnswerSummary(value)
    const text = `Recorded demo answers: ${summary}`
    const answerMeta = await this.liveStream(turn, step, [...this.textChunks(0, text, 'text'), ...this.terminalChunks()])
    if (answerMeta === undefined) return { kind: 'aborted' }
    this.commitMessage(answerMeta, turn, step, [{ type: 'text', text }])
    return { kind: 'completed' }
  }

  private async approvalFlow(turn: number, step: number): Promise<unknown> {
    const intro = 'This is an offline approval fixture. The selected option value stays opaque.'
    const meta = await this.liveStream(turn, step, [...this.textChunks(0, intro, 'text'), ...this.terminalChunks()])
    if (meta === undefined) return { kind: 'aborted' }
    this.commitMessage(meta, turn, step, [{ type: 'text', text: intro }])
    const id = `demo-approval-${++this.decisionCounter}`
    const value = await this.waitDecision({
      id,
      kind: 'approval',
      title: 'Demo approval',
      message: 'Allow this demo action? No real tool will run.',
      options: [
        { label: 'Allow once', description: 'Return an opaque object value.', value: { allow: true, scope: 'once' } },
        { label: 'Always allow (demo)', description: 'Return a different opaque object.', value: { allow: true, scope: 'always' } },
        { label: 'Deny', description: 'Return deny without running anything.', value: { allow: false, scope: 'deny' } },
      ],
    })
    if (isCancelledDecisionValue(value)) return this.cancelledDecision(turn, step, 'approval')
    const allowed = isRecord(value) && value.allow === true
    const text = allowed ? 'Demo approval recorded: allow (no tool ran).' : 'Demo approval recorded: deny.'
    const answerMeta = await this.liveStream(turn, step, [...this.textChunks(0, text, 'text'), ...this.terminalChunks()])
    if (answerMeta === undefined) return { kind: 'aborted' }
    this.commitMessage(answerMeta, turn, step, [{ type: 'text', text }])
    return { kind: 'completed' }
  }

  private async abortFlow(turn: number, step: number): Promise<unknown> {
    const reasoning = 'This attempt will be abandoned before it can commit a reply.'
    const text = 'Streaming a partial answer that must never become a completed message…'
    const chunks = [...this.textChunks(0, reasoning, 'reasoning'), ...this.textChunks(1, text, 'text'), ...this.terminalChunks()]
    const meta = await this.liveStream(turn, step, chunks, 5)
    if (meta === undefined) return { kind: 'aborted' }
    return { kind: 'completed' }
  }

  private async failFlow(turn: number, step: number): Promise<unknown> {
    const reasoning = 'A failure happens after some visible content.'
    const text = 'This partial reply will settle as assistant/attempt, not as a completed assistant message.'
    const chunks = [...this.textChunks(0, reasoning, 'reasoning'), ...this.textChunks(1, text, 'text'), ...this.terminalChunks()]
    const meta = await this.liveStream(turn, step, chunks)
    if (meta === undefined) return { kind: 'aborted' }
    this.commitAttempt(meta, turn, step)
    this.emit({ type: 'error', message: 'Demo failure: simulated provider stream error after settlement.', fatal: false })
    return { kind: 'error', message: 'simulated provider stream error' }
  }

  /**
   * A tool call DSH admitted but never settled: the turn ends with no
   * `tool/result`, so the card must report an unknown outcome, not Running and
   * not a fabricated success/failure.
   */
  /**
   * A cancelled decision (native `{cancelled:true}` or the local `CANCELLED`
   * sentinel) settles the request without inventing an answer, a deny or a tool
   * outcome. The demo records the cancellation truthfully and completes the
   * turn, matching the native approval/question cancellation path.
   */
  private async cancelledDecision(turn: number, step: number, kind: 'question' | 'approval'): Promise<unknown> {
    const text = kind === 'question'
      ? 'Demo question cancelled; no answers were recorded.'
      : 'Demo approval cancelled; no tool ran and no decision was recorded.'
    const meta = await this.liveStream(turn, step, [...this.textChunks(0, text, 'text'), ...this.terminalChunks()])
    if (meta === undefined) return { kind: 'aborted' }
    this.commitMessage(meta, turn, step, [{ type: 'text', text }])
    return { kind: 'completed' }
  }

  private async pendingToolFlow(turn: number, step: number): Promise<unknown> {
    const text = 'I will inspect the file before editing it.'
    const args = '{"file_path":"src/greet.ts","limit":20}'
    const chunks = [
      ...this.textChunks(0, text, 'text'),
      ...this.toolChunks(1, 'call-demo-pending', 'read', args),
      ...this.terminalChunks(),
    ]
    const meta = await this.liveStream(turn, step, chunks)
    if (meta === undefined) return { kind: 'aborted' }
    this.commitMessage(meta, turn, step, [
      { type: 'text', text },
      { type: 'tool-call', id: 'call-demo-pending', name: 'read', arguments: args },
    ])
    this.append('tool/call', { turn, step, callId: 'call-demo-pending', name: 'read', arguments: args }, {
      toolPresentation: {
        call: {
          card: 'generic',
          title: 'Read src/greet.ts (20 lines)',
          kind: 'read',
          locations: [{ path: 'src/greet.ts', line: 1 }],
        },
      },
    })
    return { kind: 'completed' }
  }

  private waitDecision(request: DecisionRequest): Promise<unknown> {
    return new Promise(resolve => {
      // Register before emitting: listeners may respond synchronously.
      this.pendingDecisions.set(request.id, { resolve })
      this.emit({ type: 'decision', sessionId: this.infoValue.sessionId, request })
    })
  }
}

/**
 * Native decision cancellation: the local sentinel, the wire's
 * `{cancelled:true}` and the bridge's `'cancelled'` string. These are not
 * answers, so the demo must never record them as deny/unexpected data.
 */
function isCancelledDecisionValue(value: unknown): boolean {
  if (value === CANCELLED) return true
  if (typeof value === 'string') return value.trim().toLowerCase() === 'cancelled'
  return isRecord(value) && value.cancelled === true
}

function questionAnswerSummary(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.answers)) return '(unexpected demo answer)'
  return value.answers.map(answer => (Array.isArray(answer) ? `[${answer.map(String).join(', ')}]` : String(answer))).join(' | ')
}
