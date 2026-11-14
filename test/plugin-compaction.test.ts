/** Native header provenance + real Cordis waterfall, with an offline recording LLM. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { canonicalHeader, foldRequestHeader, SessionSeq, type EpochHeader } from '@deepseek-ai/dsh-session'
import { installCompactionReasoningEffort, type CompactionSeamHost } from '../src/plugin/compaction.ts'
import { apply as applyPlugin } from '../src/plugin/index.ts'
import { STARTUP_SERVICE } from '../src/plugin/options.ts'

type RecordValue = Record<string, unknown>
interface FixtureHost extends CompactionSeamHost {
  provide(name: string, value: unknown): unknown
  waterfall(thisArg: unknown, name: string, ...args: unknown[]): unknown
}

function fixture(header: EpochHeader) {
  const context = new Context()
  const host = context as unknown as FixtureHost
  const sent: RecordValue[] = []
  const observed: RecordValue[] = []
  const folded = foldRequestHeader([{ type: 'request/header', seq: SessionSeq(0), time: 0,
    data: { header: canonicalHeader(header), reason: 'initial' } }])
  assert.ok(folded)
  const llm = {
    stream(request: RecordValue): AsyncIterable<unknown> {
      return host.waterfall(llm, 'llm/stream', request, () => {
        sent.push(request)
        return (async function* () {})()
      }) as AsyncIterable<unknown>
    },
  }
  host.provide('llm', llm)
  host.provide('sessions', { get: (id: string) => id === 'provenance-session'
    ? { requestHeader: () => folded } : undefined })
  host.on('llm/stream', (value, next) => {
    assert.ok(value !== null && typeof value === 'object')
    observed.push(value as RecordValue)
    return next()
  })
  const dispose = installCompactionReasoningEffort(host)
  return { llm, sent, observed, folded,
    async close() { dispose(); await context.fiber.dispose() } }
}

function request(overrides: RecordValue = {}): RecordValue {
  return Object.freeze({
    provider: 'fixture-provider', model: 'fixture-model', sessionId: 'provenance-session',
    purpose: 'compaction', messages: Object.freeze([{ role: 'user', content: 'offline fixture' }]),
    tools: Object.freeze([]), toolHistory: Object.freeze({ updates: [] }),
    maxTokens: 256, signal: new AbortController().signal, ...overrides,
  })
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) { /* The fixture emits no model chunks. */ }
}

for (const defaults of [undefined, { maxTokens: true as const }] as const) {
  test(`compaction native header: explicit effort is inherited, unrelated defaults do not suppress it (${defaults === undefined ? 'none' : 'maxTokens'})`, async () => {
    const f = fixture({ config: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: ReasoningEffortId('high') },
      ...(defaults === undefined ? {} : { adapterDefaults: defaults }) })
    try {
      const original = request()
      const before = JSON.stringify(f.folded)
      await drain(f.llm.stream(original))
      assert.equal(f.sent.length, 1)
      assert.equal(f.observed.length, 1, 'inner middleware runs once, only for the enriched request')
      assert.equal(f.sent[0]?.reasoningEffort, 'high')
      assert.equal(f.observed[0], f.sent[0])
      assert.notEqual(f.sent[0], original)
      for (const key of ['messages', 'tools', 'toolHistory', 'signal', 'maxTokens', 'sessionId', 'purpose', 'provider', 'model']) {
        assert.equal(f.sent[0]?.[key], original[key], `${key} identity/value is unchanged`)
      }
      assert.equal(original.reasoningEffort, undefined)
      assert.equal(JSON.stringify(f.folded), before, 'the native durable header is not mutated')
    } finally { await f.close() }
  })
}

test('compaction native header: adapter-defaulted effort remains a native default, never an explicit pin', async () => {
  const f = fixture({ config: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: ReasoningEffortId('high') },
    adapterDefaults: { reasoningEffort: true, maxTokens: true } })
  try {
    assert.equal(f.folded.adapterDefaults?.reasoningEffort, true, 'native canonical/fold retains provenance')
    const original = request()
    await drain(f.llm.stream(original))
    assert.equal(f.sent.length, 1)
    assert.equal(f.observed.length, 1)
    assert.equal(f.sent[0], original, 'the bridge continues the original native request')
    assert.equal(f.sent[0]?.reasoningEffort, undefined)
  } finally { await f.close() }
})

test('compaction native header: a configured summarizer effort wins even when the conversation effort was defaulted', async () => {
  const f = fixture({ config: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: ReasoningEffortId('high') },
    adapterDefaults: { reasoningEffort: true } })
  try {
    const original = request({ reasoningEffort: 'low' })
    await drain(f.llm.stream(original))
    assert.equal(f.sent[0], original)
    assert.equal(f.sent[0]?.reasoningEffort, 'low')
    assert.equal(f.sent.length, 1)
  } finally { await f.close() }
})

for (const overrides of [
  { model: 'other-model' }, { provider: 'other-provider' }, { purpose: 'title' },
  { purpose: undefined }, { sessionId: 'another-session' },
]) {
  test(`compaction native header: no inheritance outside the exact conversation target/purpose (${JSON.stringify(overrides)})`, async () => {
    const f = fixture({ config: { provider: 'fixture-provider', model: 'fixture-model', reasoningEffort: ReasoningEffortId('high') } })
    try {
      const original = request(overrides)
      await drain(f.llm.stream(original))
      assert.equal(f.sent.length, 1)
      assert.equal(f.observed.length, 1)
      assert.equal(f.sent[0], original)
      assert.equal(f.sent[0]?.reasoningEffort, undefined)
    } finally { await f.close() }
  })
}

/**
 * Fake host for ownership tests: records listeners and effects instead of
 * providing a real Cordis fiber. No `effect` member unless a test adds one, so
 * the no-`effect` host shape is covered directly.
 */
function listenerHost(extra: Record<string, unknown> = {}) {
  const listeners: Array<(request: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>> = []
  let detached = 0
  const host: Record<string, unknown> = {
    get: () => undefined,
    on: (_name: string, listener: (request: unknown, next: () => AsyncIterable<unknown>) => AsyncIterable<unknown>) => {
      listeners.push(listener)
      return () => {
        detached += 1
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
    ...extra,
  }
  return { host: host as unknown as CompactionSeamHost, listeners, detachCount: () => detached }
}

test('a caller-owned install on a host without effect returns one idempotent detach', () => {
  const { host, listeners, detachCount } = listenerHost()
  const dispose = installCompactionReasoningEffort(host, { effectOwner: 'caller' })
  assert.equal(listeners.length, 1, 'one listener is registered for the owning caller')
  dispose()
  dispose()
  assert.equal(listeners.length, 0, 'the caller-owned disposer removes the listener')
  assert.equal(detachCount(), 1, 'a second dispose never detaches twice')
})

test('caller ownership never stacks a second host effect', () => {
  const labels: string[] = []
  const { host, listeners } = listenerHost({
    effect: (callback: () => unknown, label?: string) => {
      labels.push(label ?? 'anonymous')
      const disposer = callback()
      return () => { if (typeof disposer === 'function') (disposer as () => void)() }
    },
  })
  const dispose = installCompactionReasoningEffort(host, { effectOwner: 'caller' })
  assert.deepEqual(labels, [], 'the caller, not the host, owns the effect')
  assert.equal(listeners.length, 1)
  dispose()
  assert.equal(listeners.length, 0)
})

/** Fake plugin context: enough of the public Context surface for `apply`. */
function pluginHost() {
  const listeners = new Map<string, Set<unknown>>()
  const effects: Array<{ label: string; dispose: () => void }> = []
  const warnings: string[] = []
  const host = {
    appReady: { onReady: () => () => {} },
    appExit: () => {},
    logger: { warn: (message: string) => { warnings.push(message) }, error: () => {} },
    provide: () => {},
    get: (name: string) => (name === STARTUP_SERVICE ? { options: {} } : undefined),
    on: (name: string, listener: unknown) => {
      const registered = listeners.get(name) ?? new Set<unknown>()
      listeners.set(name, registered)
      registered.add(listener)
      return () => registered.delete(listener)
    },
    effect: (callback: () => unknown, label = 'anonymous') => {
      const disposer = callback()
      const effect = { label, dispose: () => { if (typeof disposer === 'function') (disposer as () => void)() } }
      effects.push(effect)
      return () => effect.dispose()
    },
  }
  return { host, listeners, effects, warnings }
}

test('the plugin mounts the compaction listener as its own effect and disposes it once', () => {
  const { host, listeners, effects } = pluginHost()
  applyPlugin(host as unknown as Parameters<typeof applyPlugin>[0], {})
  const stream = listeners.get('llm/stream')
  assert.equal(stream?.size, 1, 'one compaction listener is mounted by the plugin')
  const owned = effects.filter(effect => effect.label === 'dsh-tui.compaction-bridge')
  assert.equal(owned.length, 1, 'the listener is owned by exactly one plugin effect')
  // The bridge's own effect label (`plugin/compaction.ts` EFFECT_LABEL). Its
  // absence proves the install was mounted caller-owned: a second, nested owner
  // would dispose the same listener twice on Cordis unload.
  assert.equal(
    effects.filter(effect => effect.label === 'dsh-tui.compaction-reasoning-effort').length,
    0,
    'the plugin never mounts a second, host-owned compaction effect',
  )
  owned[0]!.dispose()
  assert.equal(listeners.get('llm/stream')?.size, 0, 'plugin cleanup removes the llm/stream listener')
  owned[0]!.dispose()
  assert.equal(listeners.get('llm/stream')?.size, 0, 'repeated cleanup is a no-op')
})
