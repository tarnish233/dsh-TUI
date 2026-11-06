/**
 * Offline contract tests for the native compaction reasoning-effort bridge.
 *
 * The harness is a real Cordis context: the listener runs through Cordis's own
 * `waterfall` dispatch, so ordering, `next()` semantics and fiber ownership are
 * the production mechanics rather than a hand-rolled imitation. A fake LLM
 * service mirrors `dsh-llm`'s public shape (`stream()` → `llm/stream`
 * waterfall → adapter) and records the exact request the adapter would see.
 *
 * No profile, credential, durable session, global installation or model is
 * read; nothing leaves the process.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { installCompactionReasoningEffort, type CompactionSeamHost } from '../src/plugin/compaction.ts'

interface DurableConfig {
  provider?: string
  model?: string
  reasoningEffort?: string
}

interface Captured {
  readonly requests: Record<string, unknown>[]
}

interface Session {
  readonly id: string
  requestHeader(): { config: DurableConfig } | undefined
}

interface Harness extends Captured {
  readonly host: CompactionSeamHost
  readonly context: Context
  readonly llm: { stream(options: unknown): AsyncIterable<unknown> }
  readonly session: Session
  install(): () => void
  dispose(): Promise<void>
}

type Runtime = {
  waterfall(thisArg: unknown, name: string, ...args: unknown[]): unknown
}

/**
 * The terminal chain every non-enriched path reaches. Cordis invokes the final
 * `waterfall` callback with no arguments, exactly like `dsh-llm`, whose
 * fallback closes over the original request; this closure does the same and
 * records the adapter-visible request.
 */
function adapterSink(requests: Record<string, unknown>[], options: unknown): () => AsyncIterable<unknown> {
  return () => {
    requests.push(options as Record<string, unknown>)
    return (async function* () {})()
  }
}

/**
 * Build one real Cordis context carrying a fake `llm`/`sessions` pair.
 *
 * @param header - durable request-header config for the single fake session.
 * @param overrides - replacement `sessions`/`llm` service values.
 */
function harness(header: DurableConfig | undefined, overrides: {
  sessionId?: string
  sessions?: unknown
  llm?: unknown
} = {}): Harness {
  const requests: Record<string, unknown>[] = []
  const context = new Context()
  const runtime = context as unknown as Runtime
  const sessionId = overrides.sessionId ?? 'session-1'
  const session: Session = {
    id: sessionId,
    requestHeader: () => (header === undefined ? undefined : { config: header }),
  }
  const llm = {
    stream(options: unknown): AsyncIterable<unknown> {
      return runtime.waterfall(llm, 'llm/stream', options, adapterSink(requests, options)) as AsyncIterable<unknown>
    },
  }
  const sessions = {
    get: (id: unknown) => (id === sessionId ? session : undefined),
  }
  if ('llm' in overrides) context.provide('llm', overrides.llm)
  else context.provide('llm', llm)
  if ('sessions' in overrides) context.provide('sessions', overrides.sessions)
  else context.provide('sessions', sessions)
  const host = context as unknown as CompactionSeamHost
  return {
    requests,
    host,
    context,
    llm,
    session,
    install: () => installCompactionReasoningEffort(host),
    dispose: async () => {
      // The bridge itself is disposed by its returned disposer; the root fiber
      // owns the fake services and is released last.
      await context.fiber.dispose()
    },
  }
}

/** Drain one stream so every lazily dispatched listener runs. */
async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** Every field the native summarizer sets on its compaction request. */
function compactionRequest(sessionId = 'session-1'): {
  readonly request: Record<string, unknown>
  readonly messages: readonly unknown[]
  readonly tools: readonly unknown[]
  readonly toolHistory: unknown
  readonly signal: AbortSignal
} {
  const messages = Object.freeze([{ role: 'user', content: [{ type: 'text', text: 'hello' }] }])
  const tools = Object.freeze([{ name: 'read', description: 'read a file', parameters: {} }])
  const toolHistory = Object.freeze({ added: tools })
  const signal = new AbortController().signal
  const request = Object.freeze({
    provider: 'cloudagent',
    model: 'glm-5.3',
    messages,
    toolHistory,
    tools,
    maxTokens: 128_000,
    sessionId,
    purpose: 'compaction',
    signal,
  })
  return { request, messages, tools, toolHistory, signal }
}

test('compaction inherits the exact durable effort for the same target and copies every other field', async () => {
  const value = harness({ provider: 'cloudagent', model: 'glm-5.3', reasoningEffort: 'max' })
  const dispose = value.install()
  const { request, messages, tools, toolHistory, signal } = compactionRequest()
  await collect(value.llm.stream(request))
  assert.equal(value.requests.length, 1, 'the adapter is reached exactly once')
  const sent = value.requests[0]!
  assert.equal(sent.reasoningEffort, 'max')
  assert.equal(sent.provider, 'cloudagent')
  assert.equal(sent.model, 'glm-5.3')
  assert.equal(sent.messages, messages, 'replayed prefix messages stay identical for the warm cache')
  assert.equal(sent.tools, tools, 'tool schemas stay identical for the warm cache')
  assert.equal(sent.toolHistory, toolHistory)
  assert.equal(sent.maxTokens, 128_000)
  assert.equal(sent.sessionId, 'session-1')
  assert.equal(sent.purpose, 'compaction')
  assert.equal(sent.signal, signal)
  assert.notEqual(sent, request)
  assert.equal((request as Record<string, unknown>).reasoningEffort, undefined, 'the native request object is never mutated')
  dispose()
  await value.dispose()
})

test('a different configured summarizer target receives no incompatible effort', async () => {
  const value = harness({ provider: 'cloudagent', model: 'glm-5.3', reasoningEffort: 'max' })
  const dispose = value.install()
  const { request } = compactionRequest()
  await collect(value.llm.stream({ ...request, provider: 'other-provider', model: 'small-model' }))
  assert.equal(value.requests.length, 1)
  assert.equal(value.requests[0]!.reasoningEffort, undefined)
  dispose()
  await value.dispose()
})

test('the same provider with another model is not an inheritance source', async () => {
  const value = harness({ provider: 'cloudagent', model: 'glm-5.3', reasoningEffort: 'max' })
  const dispose = value.install()
  const { request } = compactionRequest()
  await collect(value.llm.stream({ ...request, model: 'glm-other' }))
  assert.equal(value.requests[0]!.reasoningEffort, undefined)
  dispose()
  await value.dispose()
})

test('no durable header, or one without an explicit effort, leaves the native default in place', async () => {
  for (const header of [undefined, { provider: 'cloudagent', model: 'glm-5.3' }] as const) {
    const value = harness(header)
    const dispose = value.install()
    const { request } = compactionRequest()
    await collect(value.llm.stream(request))
    assert.equal(value.requests.length, 1)
    assert.equal(value.requests[0]!.reasoningEffort, undefined)
    dispose()
    await value.dispose()
  }
})

test('only compaction requests are considered', async () => {
  const value = harness({ provider: 'cloudagent', model: 'glm-5.3', reasoningEffort: 'max' })
  const dispose = value.install()
  const { request } = compactionRequest()
  await collect(value.llm.stream({ ...request, purpose: 'title' }))
  await collect(value.llm.stream({ ...request, purpose: undefined }))
  await collect(value.llm.stream({ ...request, purpose: 'compaction', reasoningEffort: 'low' }))
  assert.deepEqual(value.requests.map(sent => sent.reasoningEffort), [undefined, undefined, 'low'])
  dispose()
  await value.dispose()
})

test('an explicit effort in the request is authoritative', async () => {
  const value = harness({ provider: 'cloudagent', model: 'glm-5.3', reasoningEffort: 'max' })
  const dispose = value.install()
  const { request } = compactionRequest()
  await collect(value.llm.stream({ ...request, reasoningEffort: 'medium' }))
  assert.equal(value.requests.length, 1)
  assert.equal(value.requests[0]!.reasoningEffort, 'medium')
  dispose()
  await value.dispose()
})

test('a request missing its target or session identity is untouched', async () => {
  const value = harness({ provider: 'cloudagent', model: 'glm-5.3', reasoningEffort: 'max' })
  const dispose = value.install()
  const { request } = compactionRequest()
  await collect(value.llm.stream({ ...request, sessionId: undefined }))
  await collect(value.llm.stream({ ...request, provider: undefined }))
  await collect(value.llm.stream({ ...request, model: undefined }))
  await collect(value.llm.stream({ ...request, sessionId: 'other-session' }))
  assert.deepEqual(value.requests.map(sent => sent.reasoningEffort), [undefined, undefined, undefined, undefined])
  dispose()
  await value.dispose()
})

test('native lookup failures and malformed requests degrade to the unchanged request', async () => {
  const throwingSessions = { get: () => { throw new Error('native session store unavailable') } }
  const brokenHeader = {
    id: 'session-1',
    requestHeader: () => { throw new Error('header fold failed') },
  }
  const missingHeader = { id: 'session-1', requestHeader: () => undefined }
  for (const sessions of [
    throwingSessions,
    { get: () => ({ id: 'session-1', requestHeader: () => ({ config: { provider: 'cloudagent', model: 'other-model', reasoningEffort: 'max' } }) }) },
    { get: () => brokenHeader },
    { get: () => missingHeader },
    undefined,
    'not-a-service',
  ]) {
    const value = harness({ provider: 'cloudagent', model: 'glm-5.3', reasoningEffort: 'max' }, { sessions })
    const dispose = value.install()
    const { request } = compactionRequest()
    await collect(value.llm.stream(request))
    await collect(value.llm.stream(null))
    await collect(value.llm.stream('not-a-request'))
    await collect(value.llm.stream([request]))
    assert.equal(value.requests.length, 4, 'every dispatch still reaches the adapter exactly once')
    assert.equal(value.requests[0]!.reasoningEffort, undefined)
    dispose()
    await value.dispose()
  }
})

test('a missing llm service or a broken re-dispatch falls back to the native chain exactly once', async () => {
  for (const llm of [undefined, { stream: () => { throw new Error('adapter dispatch failed') } }]) {
    const value = harness({ provider: 'cloudagent', model: 'glm-5.3', reasoningEffort: 'max' }, { llm })
    const dispose = value.install()
    const { request } = compactionRequest()
    // A broken re-dispatch must call next() once and let the unmodified native
    // request reach the adapter; it must never duplicate the dispatch.
    await collect(value.llm.stream(request))
    assert.equal(value.requests.length, 1)
    assert.equal(value.requests[0]!.reasoningEffort, undefined)
    dispose()
    await value.dispose()
  }
})

test('the bridge is outermost: inner listeners and the adapter see only the corrected request', async () => {
  const value = harness({ provider: 'cloudagent', model: 'glm-5.3', reasoningEffort: 'max' })
  const observer: Array<Record<string, unknown>> = []
  value.host.on('llm/stream', (options, next) => {
    observer.push(options as Record<string, unknown>)
    return next()
  })
  const dispose = value.install()
  const { request } = compactionRequest()
  await collect(value.llm.stream(request))
  assert.equal(observer.length, 1, 'the inner listener runs once, for the corrected request only')
  assert.equal(observer[0]!.reasoningEffort, 'max')
  assert.equal(value.requests.length, 1)
  assert.equal(value.requests[0]!.reasoningEffort, 'max')
  dispose()
  await value.dispose()
})

test('the disposer removes the listener and reinstalling never stacks a second rewrite', async () => {
  const value = harness({ provider: 'cloudagent', model: 'glm-5.3', reasoningEffort: 'max' })
  const first = value.install()
  const second = value.install()
  const { request } = compactionRequest()
  await collect(value.llm.stream(request))
  assert.equal(value.requests.length, 1, 'two mounted listeners still produce one adapter call')
  assert.equal(value.requests[0]!.reasoningEffort, 'max')
  first()
  second()
  value.requests.length = 0
  await collect(value.llm.stream(request))
  assert.equal(value.requests[0]!.reasoningEffort, undefined, 'disposed listeners never rewrite')
  await value.dispose()
})

test('installation degrades to a no-op disposer on a host without the seam', () => {
  const warnings: string[] = []
  const invalid = {} as CompactionSeamHost
  const dispose = installCompactionReasoningEffort(invalid, { warn: message => warnings.push(message) })
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.equal(warnings.length, 0)

  const broken = {
    get: () => undefined,
    on: () => { throw new Error('event dispatch unavailable') },
  } as unknown as CompactionSeamHost
  const brokenDispose = installCompactionReasoningEffort(broken, { warn: message => warnings.push(message) })
  assert.equal(typeof brokenDispose, 'function')
  brokenDispose()
  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /compaction/)
})

test('a context without effect support still registers a removable listener', async () => {
  const requests: Record<string, unknown>[] = []
  const listeners: Array<(options: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>> = []
  let configured = true
  const host: CompactionSeamHost = {
    get: (name: string) => name === 'sessions'
      ? { get: () => ({ id: 'session-1', requestHeader: () => (configured ? { config: { provider: 'cloudagent', model: 'glm-5.3', reasoningEffort: 'max' } } : undefined) }) }
      : { stream: (options: unknown) => { requests.push(options as Record<string, unknown>); return (async function* () {})() } },
    on: (_name, listener) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
  }
  const dispose = installCompactionReasoningEffort(host)
  assert.equal(listeners.length, 1)
  const { request } = compactionRequest()
  await collect(listeners[0]!(request, () => { requests.push({ fallback: true }); return (async function* () {})() }))
  assert.equal(requests[0]!.reasoningEffort, 'max')
  configured = false
  await collect(listeners[0]!(request, () => { requests.push({ fallback: true }); return (async function* () {})() }))
  assert.deepEqual(requests[1], { fallback: true })
  dispose()
  assert.equal(listeners.length, 0)
})
