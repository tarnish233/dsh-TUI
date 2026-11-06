/**
 * Offline fakes for the in-process DSH adapter contract tests.
 *
 * This module never reads a profile, credential, real session or model. It is
 * a minimal Cordis-shaped host plus one fake Agent registry; tests supply the
 * domain services they exercise.
 *
 * @module dsh-tui/backend/testing
 */
import type { DshHostContext, DshNativeHelpers } from './context.ts'
import type { DisplayStream, JsonRecord, PromptContentPart, StreamPresentation, TranscriptCodec } from './types.ts'

type Listener = (...args: unknown[]) => unknown

/** Minimal Cordis context: service lookup plus synchronous/waterfall events. */
export class FakeDshHost implements DshHostContext {
  readonly services = new Map<string, unknown>()
  readonly warnings: string[] = []
  readonly logger = { warn: (message: string): void => { this.warnings.push(message) } }
  private readonly listeners = new Map<string, Listener[]>()

  get(name: string): unknown {
    return this.services.get(name)
  }

  on(name: string, listener: unknown): unknown {
    if (typeof listener !== 'function') throw new Error('listener must be a function')
    const list = this.listeners.get(name) ?? []
    list.push(listener as Listener)
    this.listeners.set(name, list)
    return () => {
      const current = this.listeners.get(name)
      if (current === undefined) return
      const index = current.indexOf(listener as Listener)
      if (index >= 0) current.splice(index, 1)
    }
  }

  use(name: string, service: unknown): this {
    this.services.set(name, service)
    return this
  }

  listenerCount(name: string): number {
    return this.listeners.get(name)?.length ?? 0
  }

  /** Fire one emit event; listener failures propagate to the test. */
  emit(name: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(...args)
  }

  /**
   * Fire one waterfall event through the listener chain. A listener that
   * returns a value claims the request; otherwise `next` moves on.
   */
  async waterfall(name: string, ...payload: unknown[]): Promise<unknown> {
    const listeners = [...(this.listeners.get(name) ?? [])]
    const step = async (index: number): Promise<unknown> => {
      const listener = listeners[index]
      if (listener === undefined) return undefined
      let advanced = false
      const next = async (): Promise<unknown> => {
        advanced = true
        return await step(index + 1)
      }
      const value = await listener(...payload, next)
      if (advanced) return value
      return value
    }
    return await step(0)
  }
}

export interface FakeRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface FakeMessage {
  id: string
  content: readonly unknown[]
  source: { kind: string }
}

export interface FakeAgentOptions {
  id: string
  cwd?: string
  route?: FakeRoute
  inboxNextTurn?: FakeMessage[]
  inboxNextStep?: FakeMessage[]
  status?: 'idle' | 'running'
}

export interface FakeAgentState {
  readonly id: string
  readonly session: {
    id: string
    header: { cwd: string }
    requestHeader(): { config: FakeRoute } | undefined
  }
  route: FakeRoute | undefined
  status: 'idle' | 'running'
  readonly options: { provider?: string; model?: string; reasoningEffort?: string }
  readonly model: {
    current(): Readonly<FakeRoute> | undefined
    select(selection: Readonly<FakeRoute>): void
  }
  readonly inbox: {
    readonly nextTurn: FakeMessage[]
    readonly nextStep: FakeMessage[]
    remove(id: string): boolean
    replace(id: string, message: FakeMessage): boolean
    prepend(target: 'next-turn' | 'next-step', message: FakeMessage): void
    append(target: 'next-turn' | 'next-step', message: FakeMessage): void
  }
  readonly ctx: { name: string }
  readonly sent: Array<{ mode: 'followup' | 'steer'; message: unknown }>
  readonly cancellations: Array<{ cause: string; keepInbox: boolean }>
  readonly idleWaiters: Array<() => void>
  disposed: boolean
  whenIdle(): Promise<void>
  cancel(cause: { kind: string }, options?: { keepInbox?: boolean }): void
  followup(message: unknown): void
  steer(message: unknown): void
}

/** One observable fake Agent matching the public native surface the adapter uses. */
export function createFakeAgent(options: FakeAgentOptions): { agent: FakeAgentState; handle: { agent: unknown; dispose(): Promise<void> } } {
  const state = {
    id: options.id,
    session: {
      id: options.id,
      header: { cwd: options.cwd ?? '/workspace' },
      requestHeader: () => options.route === undefined ? undefined : { config: options.route },
    },
    route: options.route,
    status: options.status ?? 'idle',
    options: options.route === undefined
      ? {}
      : {
          provider: options.route.provider,
          model: options.route.model,
          ...(options.route.reasoningEffort === undefined ? {} : { reasoningEffort: options.route.reasoningEffort }),
        },
    model: {
      current: () => state.route,
      select: (selection: Readonly<FakeRoute>) => {
        state.route = { ...selection }
      },
    },
    inbox: {
      nextTurn: options.inboxNextTurn ?? [],
      nextStep: options.inboxNextStep ?? [],
      remove(id: string) {
        for (const list of [state.inbox.nextTurn, state.inbox.nextStep]) {
          const index = list.findIndex(message => message.id === id)
          if (index >= 0) {
            list.splice(index, 1)
            return true
          }
        }
        return false
      },
      replace(id: string, message: FakeMessage) {
        for (const list of [state.inbox.nextTurn, state.inbox.nextStep]) {
          const index = list.findIndex(item => item.id === id)
          if (index >= 0) {
            list.splice(index, 1, message)
            return true
          }
        }
        return false
      },
      prepend(target: 'next-turn' | 'next-step', message: FakeMessage) {
        const list = target === 'next-turn' ? state.inbox.nextTurn : state.inbox.nextStep
        list.unshift(message)
      },
      append(target: 'next-turn' | 'next-step', message: FakeMessage) {
        const list = target === 'next-turn' ? state.inbox.nextTurn : state.inbox.nextStep
        list.push(message)
      },
    },
    ctx: { name: 'fake-agent-ctx' },
    sent: [] as Array<{ mode: 'followup' | 'steer'; message: unknown }>,
    cancellations: [] as Array<{ cause: string; keepInbox: boolean }>,
    idleWaiters: [] as Array<() => void>,
    disposed: false,
    whenIdle(): Promise<void> {
      if (state.status === 'idle') return Promise.resolve()
      return new Promise(resolve => state.idleWaiters.push(resolve))
    },
    cancel(cause: { kind: string }, cancelOptions?: { keepInbox?: boolean }): void {
      state.cancellations.push({ cause: cause.kind, keepInbox: cancelOptions?.keepInbox === true })
      state.status = 'idle'
      for (const resolve of state.idleWaiters.splice(0)) resolve()
    },
    followup(message: unknown): void {
      state.sent.push({ mode: 'followup', message })
      state.status = 'running'
    },
    steer(message: unknown): void {
      state.sent.push({ mode: 'steer', message })
      state.status = 'running'
    },
  }
  return {
    agent: state,
    handle: {
      agent: state,
      async dispose() {
        state.disposed = true
        state.status = 'idle'
        for (const resolve of state.idleWaiters.splice(0)) resolve()
      },
    },
  }
}

/** Fake Agent registry: records create/resume requests and returns prepared Agents. */
export class FakeAgentRegistry {
  readonly createCalls: unknown[] = []
  readonly resumeCalls: unknown[] = []
  readonly agents: FakeAgentState[] = []
  /** Process-local live entries, mirroring `ctx.agents.get`. */
  readonly live = new Map<string, FakeAgentState>()
  failCreate: Error | undefined
  failResume: Error | undefined
  /** Rejection thrown by the composition callback of the next create/resume, like native setup. */
  failSetup: Error | undefined
  route: FakeRoute | undefined
  cwd = '/workspace'
  private counter = 0

  /**
   * Run the caller's setup callback the way the native factory does, before
   * publication. A setup rejection is a failed create/resume: the Agent is
   * never registered and no handle is returned.
   */
  private async compose(options: unknown, agent: FakeAgentState): Promise<void> {
    const setup = (options as { setup?: unknown }).setup
    if (typeof setup !== 'function') return
    if (this.failSetup !== undefined) throw this.failSetup
    await (setup as (ctx: unknown, agent: unknown) => unknown)(agent.ctx, agent)
  }

  async create(_options: unknown): Promise<{ agent: unknown; dispose(): Promise<void> }> {
    this.createCalls.push(_options)
    if (this.failCreate !== undefined) throw this.failCreate
    const request = _options as { sessionId?: string }
    const created = createFakeAgent({
      id: typeof request.sessionId === 'string' ? request.sessionId : `agent-${++this.counter}`,
      cwd: this.cwd,
      ...(this.route === undefined ? {} : { route: this.route }),
    })
    await this.compose(_options, created.agent)
    this.agents.push(created.agent)
    this.live.set(created.agent.id, created.agent)
    return created.handle
  }

  async resume(_options: unknown): Promise<{ agent: unknown; dispose(): Promise<void> }> {
    this.resumeCalls.push(_options)
    if (this.failResume !== undefined) throw this.failResume
    const request = _options as { resumeSessionId?: string }
    const resumed = createFakeAgent({
      id: typeof request.resumeSessionId === 'string' ? request.resumeSessionId : `resumed-${++this.counter}`,
      cwd: this.cwd,
      ...(this.route === undefined ? {} : { route: this.route }),
    })
    await this.compose(_options, resumed.agent)
    this.agents.push(resumed.agent)
    this.live.set(resumed.agent.id, resumed.agent)
    return resumed.handle
  }

  /** Publish one pre-existing child Agent without recording a create/resume call. */
  enter(agent: FakeAgentState): void {
    this.live.set(agent.id, agent)
  }

  /** Remove one exact live entry, like a settled activation's disposal. */
  remove(id: string): void {
    this.live.delete(id)
  }

  get(id: string): FakeAgentState | undefined {
    return this.live.get(id)
  }

  list(): FakeAgentState[] {
    return [...this.live.values()]
  }

  roots(): FakeAgentState[] {
    return [...this.live.values()]
  }

  isOwnedBy(id: string, owner: FakeAgentState): boolean {
    return this.live.get(id) !== undefined && owner !== undefined
  }
}

/** One lazy stream assembler sufficient to verify frame forwarding, not DSH's algorithm. */
function fakeCodec(): TranscriptCodec {
  return {
    createStream(): DisplayStream {
      const text: string[] = []
      return {
        push(chunk: JsonRecord) {
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text.push(chunk.text)
        },
        snapshot(): StreamPresentation {
          return { text: text.join(''), thinking: '', toolNames: [] }
        },
      }
    },
    assemble(stream) {
      const text: string[] = []
      if (Array.isArray(stream)) {
        for (const value of stream) {
          if (value !== null && typeof value === 'object' && (value as Record<string, unknown>).type === 'text') {
            const part = (value as Record<string, unknown>).text
            if (typeof part === 'string') text.push(part)
          }
        }
      }
      return { text: text.join(''), thinking: '', toolNames: [] }
    },
    surfaceKind(event) {
      if (event.surfaceOp === 'append') return 'append'
      if (typeof event.surfaceOp === 'object') return 'replace'
      return 'none'
    },
  }
}

/** Native helpers for offline tests: deterministic message ids plus a fake codec. */
export function fakeNativeHelpers(): DshNativeHelpers & { messages: unknown[] } {
  let seq = 0
  const messages: unknown[] = []
  const codec = fakeCodec()
  return {
    messages,
    transcriptCodec: codec,
    createUserMessage(input) {
      const message = { id: `message-${++seq}`, ...input }
      messages.push(message)
      return message
    },
  }
}

/** Await pending microtasks/macrotasks so adapter setImmediate snapshots run. */
export async function nextTask(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

// ---------------------------------------------------------------- subagents

/** One synthetic durable session event (never a real DSH log). */
export interface FakeSessionEvent {
  type: string
  seq?: number
  time?: number
  data?: unknown
  surfaceOp?: unknown
  sourceEventSeqs?: number[]
}

export interface FakeSessionOptions {
  id: string
  cwd?: string
  createdAt?: number
  parentSession?: string
  origin?: 'subagent'
  delegationDepth?: number
  agentPreset?: string
  isSeeded?: boolean
  inheritedEventCount?: number
  events?: FakeSessionEvent[]
  /** Native wire projection values (`subagentCatalog`, `subagent`, `subagentTiming`, `tokenUsage`, …). */
  projections?: Record<string, unknown>
  /** Whether `ctx.sessions.get` resolves this session. */
  live?: boolean
}

interface StoredFakeSession {
  readonly options: FakeSessionOptions
  readonly header: Record<string, unknown>
  readonly events: FakeSessionEvent[]
  readonly values: Record<string, unknown>
  live: boolean
}

type ProjectionChangeListener = (session: unknown, key: string, value: unknown, seq: unknown) => void

/**
 * Offline session world: a tiny `ctx.sessions`, `ctx.sessionQuery` and
 * `ctx.sessionProjections` over synthetic headers/events/projection values.
 *
 * It never reads DSH persistence, a profile, a credential or a session file.
 * `sessionQuery.observeSession` mirrors the public live/preferred observation
 * shape (header, inherited count, lazy events, one projection cut) so the
 * subagent bridge can be exercised without an Agent.
 */
export class FakeSessionWorld {
  private readonly entries = new Map<string, StoredFakeSession>()
  private readonly listeners = new Set<ProjectionChangeListener>()
  private seq = 0

  readonly store = {
    get: (id: string): { id: string; header: Record<string, unknown> } | undefined => {
      const entry = this.entries.get(id)
      return entry?.live === true ? { id, header: entry.header } : undefined
    },
    list: (): Array<{ id: string; header: Record<string, unknown> }> => [...this.entries.values()]
      .filter(entry => entry.live)
      .map(entry => ({ id: String(entry.header.id), header: entry.header })),
    flush: async (): Promise<void> => {},
  }

  readonly sessionProjections = {
    snapshot: (session: unknown, keys?: readonly string[]): { asOfSeq: number; values: Record<string, unknown> } => {
      const id = String((session as { id?: unknown } | null)?.id)
      const entry = this.entries.get(id)
      if (entry === undefined) return { asOfSeq: -1, values: {} }
      const values: Record<string, unknown> = {}
      const selected = keys === undefined ? Object.keys(entry.values) : keys
      for (const key of selected) {
        if (Object.hasOwn(entry.values, key)) values[key] = entry.values[key]
      }
      return { asOfSeq: Math.max(-1, entry.events.length - 1), values }
    },
    stateOf: (session: unknown, key: string): unknown => {
      const id = String((session as { id?: unknown } | null)?.id)
      return this.entries.get(id)?.values[key]
    },
    onChanged: (listener: ProjectionChangeListener): (() => void) => {
      this.listeners.add(listener)
      return () => {
        this.listeners.delete(listener)
      }
    },
  }

  readonly sessionQuery = {
    observeSession: async (id: string, options?: { projectionMode?: 'all' | 'none' }): Promise<Record<string, unknown>> => {
      const entry = this.entries.get(id)
      if (entry === undefined) throw sessionNotFound(id)
      const observation: Record<string, unknown> = {
        source: entry.live ? 'live' : 'prepared',
        header: entry.header,
        inheritedEventCount: entry.options.inheritedEventCount ?? 0,
        get events(): FakeSessionEvent[] {
          return entry.events.map(event => ({ ...event }))
        },
        cursor: Math.max(-1, entry.events.length - 1),
      }
      if (options?.projectionMode !== 'none') {
        observation.projections = {
          asOfSeq: Math.max(-1, entry.events.length - 1),
          values: { ...entry.values },
        }
      }
      Object.defineProperty(observation, Symbol.dispose, { value: () => {}, enumerable: false })
      return observation
    },
    readSession: async (id: string): Promise<Record<string, unknown>> => {
      const entry = this.entries.get(id)
      if (entry === undefined) throw sessionNotFound(id)
      return {
        session: entry.header,
        inheritedEventCount: entry.options.inheritedEventCount ?? 0,
        events: entry.events.map(event => ({ ...event })),
      }
    },
    listSessions: async (): Promise<Array<Record<string, unknown>>> => [...this.entries.values()]
      .map(entry => ({ header: entry.header, live: entry.live, persisted: true })),
    readTitleSnapshots: async (ids: readonly string[]): Promise<Array<Record<string, unknown>>> =>
      ids.map(sessionId => ({ sessionId, status: 'fulfilled', value: {} })),
  }

  /** Install this world's services on a fake host. */
  attach(host: FakeDshHost): this {
    host.use('sessions', this.store)
    host.use('sessionQuery', this.sessionQuery)
    host.use('sessionProjections', this.sessionProjections)
    return this
  }

  add(options: FakeSessionOptions): StoredFakeSession {
    const events = (options.events ?? []).map((event, index) => ({
      ...event,
      seq: typeof event.seq === 'number' ? event.seq : index,
    }))
    const header: Record<string, unknown> = {
      version: 4,
      id: options.id,
      createdAt: options.createdAt ?? Date.now(),
      cwd: options.cwd ?? '/workspace',
      isSeeded: options.isSeeded === true,
      ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.delegationDepth === undefined ? {} : { delegationDepth: options.delegationDepth }),
      ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
    }
    const entry: StoredFakeSession = {
      options: { ...options },
      header,
      events,
      values: { ...(options.projections ?? {}) },
      live: options.live === true,
    }
    this.entries.set(options.id, entry)
    return entry
  }

  remove(id: string): boolean {
    return this.entries.delete(id)
  }

  setLive(id: string, live: boolean): void {
    const entry = this.entries.get(id)
    if (entry !== undefined) entry.live = live
  }

  has(id: string): boolean {
    return this.entries.has(id)
  }

  eventsOf(id: string): readonly FakeSessionEvent[] {
    return this.entries.get(id)?.events ?? []
  }

  valuesOf(id: string): Record<string, unknown> {
    return { ...(this.entries.get(id)?.values ?? {}) }
  }

  /** Append one synthetic durable event and return it with its assigned seq. */
  appendEvent(id: string, event: FakeSessionEvent): FakeSessionEvent {
    const entry = this.entries.get(id)
    if (entry === undefined) throw sessionNotFound(id)
    const appended = { ...event, seq: typeof event.seq === 'number' ? event.seq : entry.events.length }
    entry.events.push(appended)
    return appended
  }

  /** Replace one whole projection value without notifying listeners. */
  setProjections(id: string, values: Record<string, unknown>): void {
    const entry = this.entries.get(id)
    if (entry === undefined) throw sessionNotFound(id)
    for (const [key, value] of Object.entries(values)) entry.values[key] = value
  }

  /** Replace one projection value and (by default) drive the change feed. */
  setProjection(id: string, key: string, value: unknown, notify = true): void {
    const entry = this.entries.get(id)
    if (entry === undefined) throw sessionNotFound(id)
    entry.values[key] = value
    if (notify) this.changed(id, key, value)
  }

  /** Drive one native projection change frame exactly like `sessionProjections.onChanged`. */
  changed(id: string, key: string, value: unknown): void {
    const seq = Math.max(-1, (this.entries.get(id)?.events.length ?? 1) - 1)
    const session = { id }
    for (const listener of [...this.listeners]) listener(session, key, value, seq)
  }

  nextSessionId(prefix = 'child'): string {
    this.seq += 1
    return `${prefix}-${this.seq}`
  }
}

function sessionNotFound(id: string): Error {
  const error = new Error(`session "${id}" not found`)
  Object.assign(error, { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
  return error
}

// ------------------------------------------------------- subagent mutation

/** One observed `ctx.subagents.prompt` call (synthetic, never a real child). */
export interface FakeSubagentPromptCall {
  readonly requestId: string
  readonly parentSessionId: string
  readonly childSessionId: string
  readonly mode: 'continuable'
  readonly delivery: 'queue' | 'steer'
  readonly content: readonly PromptContentPart[]
  /** The exact carrier signal the adapter handed to the native call. */
  readonly signal: AbortSignal
}

/** One observed `ctx.subagents.interrupt` call. */
export interface FakeSubagentInterruptCall {
  readonly targetSessionId: string
  readonly kind: 'user'
  readonly parentSessionId: string
}

function abortedError(): Error {
  const error = new Error('the fake native subagent prompt was aborted')
  error.name = 'AbortError'
  return error
}

/**
 * Observable fake of the public `ctx.subagents` mutation surface.
 *
 * It records every prompt/interrupt with the exact request/authority the
 * adapter produced, can fail or hold a prompt, and records the drain calls the
 * adapter must never make. Attach it explicitly with {@link attach}; a host
 * that never attaches it advertises no mutation capability.
 */
export class FakeSubagentsService {
  readonly promptCalls: FakeSubagentPromptCall[] = []
  readonly interruptCalls: FakeSubagentInterruptCall[] = []
  /** Native drain surfaces; the adapter must never call these. */
  readonly drainCalls = { descendants: 0, children: 0 }
  failPrompt: Error | undefined
  failInterrupt: Error | undefined
  /** Hold every prompt until its carrier signal aborts (close/cancel tests). */
  holdPrompt = false
  /** Receipt override; `null` models a receipt with no message id. */
  promptReceipt: unknown
  private messages = 0
  private readonly held: Array<{ resolve(value: unknown): void }> = []

  attach(host: FakeDshHost): this {
    host.use('subagents', this)
    return this
  }

  prompt(
    request: Omit<FakeSubagentPromptCall, 'signal'>,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.promptCalls.push({ ...request, content: [...request.content], signal })
    if (this.failPrompt !== undefined) return Promise.reject(this.failPrompt)
    if (this.holdPrompt) {
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(abortedError())
          return
        }
        const entry = { resolve }
        this.held.push(entry)
        signal.addEventListener('abort', () => {
          const index = this.held.indexOf(entry)
          if (index >= 0) this.held.splice(index, 1)
          reject(abortedError())
        }, { once: true })
      })
    }
    if (this.promptReceipt !== undefined) return Promise.resolve(this.promptReceipt)
    this.messages += 1
    return Promise.resolve({ messageId: `fake-subagent-prompt-${this.messages}` })
  }

  interrupt(targetSessionId: string, authority: { readonly kind: 'user'; readonly parentSessionId: string }): void {
    this.interruptCalls.push({
      targetSessionId,
      kind: authority.kind,
      parentSessionId: authority.parentSessionId,
    })
    if (this.failInterrupt !== undefined) throw this.failInterrupt
  }

  async drainDescendants(): Promise<void> {
    this.drainCalls.descendants += 1
  }

  async drainChildren(): Promise<void> {
    this.drainCalls.children += 1
  }

  /** Resolve one held prompt like an accepted native message. */
  releasePrompt(messageId?: string): void {
    const entry = this.held.shift()
    if (entry === undefined) return
    this.messages += 1
    entry.resolve({ messageId: messageId ?? `fake-subagent-prompt-${this.messages}` })
  }

  heldCount(): number {
    return this.held.length
  }
}

/** Build one native `subagent/catalog` event payload for a synthetic parent. */
export function fakeCatalogEvent(
  childId: string,
  mode: 'one-shot' | 'continuable' | 'external' | 'unknown',
  label?: string,
): { type: 'subagent/catalog'; data: Record<string, unknown> } {
  return {
    type: 'subagent/catalog',
    data: {
      version: mode === 'external' ? 2 : mode === 'unknown' ? 1 : 0,
      childId,
      childCreatedAt: 1,
      mode,
      ...(label === undefined ? {} : { label }),
    },
  }
}
