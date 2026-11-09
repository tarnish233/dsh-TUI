/** Native header provenance + real Cordis waterfall, with an offline recording LLM. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { canonicalHeader, foldRequestHeader, SessionSeq, type EpochHeader } from '@deepseek-ai/dsh-session'
import { installCompactionReasoningEffort, type CompactionSeamHost } from '../src/plugin/compaction.ts'

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
