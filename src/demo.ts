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
 *   question  ordered AskUserQuestion fixture (multi-select + single select)
 *   approval  opaque approval values
 *   abort     a streamed attempt that is abandoned mid-flight
 *   fail      a committed assistant/attempt settlement + nonfatal error
 *   pending   an admitted tool call that never receives a result
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
  JsonRecord,
  SessionEvent,
  SessionInfo,
  StreamPresentation,
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
  '任何文本  → Markdown、代码块、中文/emoji、edit 工具与 diff',
  'question → 多选 + 单选 AskUserQuestion 问卷',
  'approval → 审批选项（opaque value）',
  'abort    → 流式尝试被放弃',
  'fail     → assistant/attempt 结算 + 非致命错误',
  'pending  → 已受理但没有结果的工具调用（显示 unknown）',
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
const DEMO_CWD_FALLBACK = process.cwd()

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
  private readonly parts = new Map<number, { kind: 'text' | 'reasoning' | 'tool-call'; text: string; toolName: string }>()
  private readonly order: number[] = []

  push(chunk: JsonRecord): void {
    const type = typeof chunk.type === 'string' ? chunk.type : ''
    const index = typeof chunk.index === 'number' && Number.isFinite(chunk.index) ? chunk.index : 0
    switch (type) {
      case 'block-start': {
        const blockType = typeof chunk.blockType === 'string' ? chunk.blockType : ''
        this.ensure(index, blockType === 'reasoning' ? 'reasoning' : blockType === 'tool-call' ? 'tool-call' : 'text')
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
        const part = this.ensure(index, blockType === 'reasoning' ? 'reasoning' : blockType === 'tool-call' ? 'tool-call' : 'text')
        if ((blockType === 'text' || blockType === 'reasoning') && part.text === '' && typeof block?.text === 'string') part.text = block.text
        if (blockType === 'tool-call' && part.toolName === '' && typeof block?.name === 'string') part.toolName = block.name
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
    for (const index of this.order) {
      const part = this.parts.get(index)
      if (part === undefined) continue
      if (part.kind === 'text') text.push(part.text)
      else if (part.kind === 'reasoning') thinking.push(part.text)
      else if (part.toolName !== '') toolNames.push(part.toolName)
    }
    return { text: text.join(''), thinking: thinking.join(''), toolNames }
  }

  private ensure(index: number, kind: 'text' | 'reasoning' | 'tool-call'): { kind: 'text' | 'reasoning' | 'tool-call'; text: string; toolName: string } {
    const existing = this.parts.get(index)
    if (existing !== undefined) return existing
    const part = { kind, text: '', toolName: '' }
    this.parts.set(index, part)
    this.order.push(index)
    return part
  }
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
      capabilities: ['stream', 'streaming', 'tools', 'questions', 'approval', 'cancel', 'followup', 'steer', 'new', 'resume', 'state', 'models', 'permissions', 'presets', 'preset', 'efforts', 'effort', 'dequeue', 'commands', 'execute', 'demo'],
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
    this.queue.push(text)
    this.runQueue()
  }

  async cancel(): Promise<void> {
    this.abortFlag = true
    this.queue.length = 0
    for (const [id, pending] of this.pendingDecisions) {
      this.pendingDecisions.delete(id)
      pending.resolve(CANCELLED)
      this.emit({ type: 'decision_closed', sessionId: this.infoValue.sessionId, id })
    }
  }

  async respond(id: string, value: unknown): Promise<void> {
    const pending = this.pendingDecisions.get(id)
    if (pending === undefined) throw new Error(`No pending demo decision "${id}"`)
    this.pendingDecisions.delete(id)
    this.emit({ type: 'decision_closed', sessionId: this.infoValue.sessionId, id })
    pending.resolve(value)
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
        this.events.length = 0
        this.seq = 0
        this.emit({ type: 'ready', info: this.infoValue })
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
          queued: this.queue.length,
        }
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
        return removed
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

  /** Test/demo helper: resolves when no turn, queue or decision remains. */
  whenIdle(): Promise<void> {
    if (!this.running && this.queue.length === 0 && this.pendingDecisions.size === 0) return Promise.resolve()
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
    this.events.length = 0
    this.seq = 0
    this.emit({ type: 'ready', info: this.infoValue })
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

  private resolveIdle(): void {
    if (this.running || this.queue.length > 0 || this.pendingDecisions.size > 0) return
    for (const idle of this.idleWaiters.splice(0)) idle()
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
        if (this.queue.length > 0) this.runQueue()
        else this.resolveIdle()
      })
  }

  private async runTurn(text: string): Promise<void> {
    const turn = ++this.turnCounter
    const step = 1
    this.abortFlag = false
    this.append('turn/start', { turn })
    this.append('user/message', {
      id: `demo-user-${turn}`,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    this.append('step/start', { turn, step })

    const lower = text.toLowerCase()
    let reason: unknown = { kind: 'completed' }
    if (lower.includes('question') || text.includes('问题') || text.includes('问卷')) {
      reason = await this.questionFlow(turn, step)
    } else if (lower.includes('approval') || lower.includes('permission') || text.includes('审批')) {
      reason = await this.approvalFlow(turn, step)
    } else if (lower.includes('abort') || lower.includes('cancel') || text.includes('取消')) {
      reason = await this.abortFlow(turn, step)
    } else if (lower.includes('fail') || lower.includes('error') || text.includes('错误')) {
      reason = await this.failFlow(turn, step)
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

  private terminalChunks(): DemoChunk[] {
    return [
      { type: 'usage', usage: { inputTokens: 42, outputTokens: 128, totalTokens: 170 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
  }

  // -------------------------------------------------------------------------
  // Fixtures

  private async normalFlow(turn: number, step: number): Promise<unknown> {
    const reasoning = 'Demo reasoning: build a deterministic reply, then update a file through the edit tool.'
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
    if (value === CANCELLED) return { kind: 'aborted' }
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
    if (value === CANCELLED) return { kind: 'aborted' }
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

function questionAnswerSummary(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.answers)) return '(unexpected demo answer)'
  return value.answers.map(answer => (Array.isArray(answer) ? `[${answer.map(String).join(', ')}]` : String(answer))).join(' | ')
}
