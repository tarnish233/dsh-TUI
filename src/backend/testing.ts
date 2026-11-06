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
import type { DisplayStream, JsonRecord, StreamPresentation, TranscriptCodec } from './types.ts'

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
    return resumed.handle
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
