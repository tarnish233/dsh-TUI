/**
 * Offline contract tests for native `/compact` failure diagnostics.
 *
 * DSH appends `compaction/end` (with its own `error` text) synchronously inside
 * the compaction transaction, before the command handler settles. The adapter
 * correlates that entry by `sourceCommandId` with the `/compact`
 * `CommandExecution` result and appends one bounded `Native cause:` line while
 * preserving the native generic text. These tests use the fake Cordis host
 * only: no durable session file, profile, credential or model is touched.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshBackend, type DshContextBackend } from '../src/backend/context.ts'
import type { BackendEvent } from '../src/backend/types.ts'
import { FakeAgentRegistry, FakeDshHost, fakeNativeHelpers, type FakeAgentState } from '../src/backend/testing.ts'

const GENERIC = 'Compaction could not produce a useful summary. The attempt is recorded in the session log.'

interface Harness {
  readonly host: FakeDshHost
  readonly agents: FakeAgentRegistry
  readonly backend: DshContextBackend
  readonly events: BackendEvent[]
  readonly agent: FakeAgentState
}

/** One connected backend with a live fake Agent; no network or disk access. */
async function harness(): Promise<Harness> {
  const host = new FakeDshHost()
  const agents = new FakeAgentRegistry()
  host.use('agents', agents)
  host.use('agentDefaultModel', {
    currentSelection: () => ({ provider: 'p1', model: 'm1' }),
    saveSelection: async () => {},
  })
  host.use('llm', {
    listProviders: () => [{ id: 'p1' }],
    listModels: async () => [{ id: 'm1' }],
    resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'low' }], defaultEffort: 'low' } }),
  })
  const backend = createDshBackend(host, { cwd: '/workspace', native: fakeNativeHelpers() })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  await backend.connect()
  await backend.send('prompt')
  const agent = agents.agents[0]
  assert.ok(agent)
  return { host, agents, backend, events, agent }
}

/** Append one native compaction/end event through the synchronous session feed. */
function compactionEnd(host: FakeDshHost, session: unknown, data: Record<string, unknown>): void {
  host.emit('session/event', session, { type: 'compaction/end', seq: 9, data })
}

/** Install one fake native command registry that appends its compaction end inline. */
function compactCommand(
  host: FakeDshHost,
  options: {
    commandId?: string
    text?: string
    kind?: 'success' | 'error'
    error?: string
    sourceCommandId?: string
    before?: () => void
  } = {},
): void {
  const commandId = options.commandId ?? 'command-42'
  host.use('commands', {
    execute: async (agent: unknown, _line: string) => {
      options.before?.()
      if (options.error !== undefined) {
        compactionEnd(host, (agent as FakeAgentState).session, {
          compactionId: 'compaction-1',
          sourceCommandId: options.sourceCommandId ?? commandId,
          turn: null,
          error: options.error,
        })
      }
      return {
        commandId,
        result: { kind: options.kind ?? 'error', text: options.text ?? GENERIC },
      }
    },
  })
}

/** Read the adapter's bounded correlation store for assertions only. */
function correlations(backend: DshContextBackend): Map<string, string> {
  return (backend as unknown as { compactionCauses: Map<string, string> }).compactionCauses
}

test('a failed /compact appends the native compaction cause and preserves the generic text', async () => {
  const { host, backend } = await harness()
  compactCommand(host, {
    error: '400 InvalidParameter: The value of the enable_thinking parameter is restricted to True.',
  })
  const execution = await backend.command('execute', { line: '/compact' }) as {
    commandId: string
    result: Record<string, unknown>
  }
  assert.equal(execution.commandId, 'command-42')
  assert.deepEqual(execution.result, {
    kind: 'error',
    text: `${GENERIC}\nNative cause: 400 InvalidParameter: The value of the enable_thinking parameter is restricted to True.`,
  })
  assert.equal(correlations(backend).size, 0, 'the correlation entry is consumed')
  await backend.close()
})

test('the native cause is redacted, single-line and control-free', async () => {
  const { host, backend } = await harness()
  compactCommand(host, {
    error: '\u001b[31mInvalidParameter\u001b[0m: api_key=sk-secretvalue123\n\u001b]8;;https://example.invalid\u0007second\u001b]8;;\u0007\tline\u009b31m with\u0085spacing',
  })
  const execution = await backend.command('execute', { line: '/compact' }) as {
    result: { kind: string; text: string }
  }
  const text = execution.result.text
  assert.ok(text.startsWith(GENERIC), 'generic native text is preserved verbatim as the prefix')
  assert.match(text, /Native cause: InvalidParameter: api_key=\[redacted\] second line with spacing/)
  assert.ok(!text.includes('sk-secretvalue123'))
  assert.ok(!text.includes('\u001b'))
  assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/)
  assert.equal(text.split('\n').length, 2, 'generic text and safe detail stay on separate rows')
  assert.ok(!text.includes('https://example.invalid'), 'OSC payload is removed with its control sequence')
  await backend.close()
})

test('the appended cause is bounded', async () => {
  const { host, backend } = await harness()
  compactCommand(host, { error: 'x'.repeat(2000) })
  const execution = await backend.command('execute', { line: '/compact' }) as {
    result: { text: string }
  }
  const detail = execution.result.text.slice(GENERIC.length + '\nNative cause: '.length)
  assert.equal(detail.length, 400)
  assert.ok(detail.endsWith('...'))
  assert.ok(execution.result.text.startsWith(GENERIC))
  await backend.close()
})

test('no observed cause leaves the generic native result untouched', async () => {
  const { host, backend } = await harness()
  compactCommand(host)
  const execution = await backend.command('execute', { line: '/compact' }) as {
    result: Record<string, unknown>
  }
  assert.deepEqual(execution.result, { kind: 'error', text: GENERIC })
  await backend.close()
})

test('a successful result is never altered', async () => {
  const { host, backend } = await harness()
  const success = { kind: 'success', text: 'Compacted 12 history items (~3456 tokens).', sourceEventSeq: 30 }
  compactCommand(host, { kind: 'success', text: success.text, error: 'must not appear' })
  host.use('commands', {
    execute: async (agent: unknown) => {
      compactionEnd(host, (agent as FakeAgentState).session, {
        compactionId: 'compaction-1',
        sourceCommandId: 'command-42',
        turn: null,
        error: 'must not appear',
      })
      return { commandId: 'command-42', result: success }
    },
  })
  const execution = await backend.command('execute', { line: '/compact' }) as {
    result: Record<string, unknown>
  }
  assert.deepEqual(execution.result, success)
  await backend.close()
})

test('any other command keeps its own result text even with a correlated cause', async () => {
  const { host, backend } = await harness()
  host.use('commands', {
    execute: async (agent: unknown, line: string) => {
      compactionEnd(host, (agent as FakeAgentState).session, {
        compactionId: 'compaction-1',
        sourceCommandId: 'command-7',
        turn: null,
        error: 'native compaction detail',
      })
      return { commandId: 'command-7', result: { kind: 'error', text: `failed ${line}` } }
    },
  })
  const execution = await backend.command('execute', { line: '/permission read-only' }) as {
    result: Record<string, unknown>
  }
  assert.deepEqual(execution.result, { kind: 'error', text: 'failed /permission read-only' })
  await backend.close()
})

test('a cause observed after the command settles cannot rewrite the returned result', async () => {
  const { host, backend, agent } = await harness()
  host.use('commands', {
    execute: async () => {
      // Native appends the marker synchronously inside the transaction; a late
      // observation must not retroactively alter a settled result.
      setImmediate(() => compactionEnd(host, agent.session, {
        compactionId: 'compaction-1',
        sourceCommandId: 'command-42',
        turn: null,
        error: 'late native detail',
      }))
      return { commandId: 'command-42', result: { kind: 'error', text: GENERIC } }
    },
  })
  const execution = await backend.command('execute', { line: '/compact' }) as {
    result: Record<string, unknown>
  }
  assert.deepEqual(execution.result, { kind: 'error', text: GENERIC })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(correlations(backend).size, 1, 'the late entry is retained for the bounded window')
  await backend.close()
})

test('a correlation entry is consumed once and never reused', async () => {
  const { host, backend, agent } = await harness()
  let executions = 0
  host.use('commands', {
    execute: async () => {
      executions += 1
      if (executions === 1) {
        compactionEnd(host, agent.session, {
          compactionId: 'compaction-1',
          sourceCommandId: 'command-42',
          turn: null,
          error: 'first native detail',
        })
      }
      return { commandId: 'command-42', result: { kind: 'error', text: GENERIC } }
    },
  })
  const first = await backend.command('execute', { line: '/compact' }) as { result: { text: string } }
  assert.match(first.result.text, /Native cause: first native detail/)
  assert.equal(correlations(backend).size, 0)
  const second = await backend.command('execute', { line: '/compact' }) as { result: Record<string, unknown> }
  assert.deepEqual(second.result, { kind: 'error', text: GENERIC })
  await backend.close()
})

test('only live-session events with both identifiers are correlated', async () => {
  const { host, backend, agent } = await harness()
  // Another session object, a missing sourceCommandId and empty error text.
  compactionEnd(host, { id: 'other-session' }, { compactionId: 'c', sourceCommandId: 'command-1', turn: null, error: 'wrong session' })
  compactionEnd(host, agent.session, { compactionId: 'c', turn: null, error: 'no command id' })
  compactionEnd(host, agent.session, { compactionId: 'c', sourceCommandId: 'command-2', turn: null, error: '   ' })
  compactionEnd(host, agent.session, { compactionId: 'c', sourceCommandId: 'command-3', turn: null })
  assert.equal(correlations(backend).size, 0)
  host.use('commands', {
    execute: async () => ({ commandId: 'command-1', result: { kind: 'error', text: GENERIC } }),
  })
  const execution = await backend.command('execute', { line: '/compact' }) as { result: Record<string, unknown> }
  assert.deepEqual(execution.result, { kind: 'error', text: GENERIC })
  await backend.close()
})

test('the correlation store is bounded and cleared on close', async () => {
  const { host, backend, agent } = await harness()
  compactionEnd(host, agent.session, {
    compactionId: 'compaction-huge',
    sourceCommandId: 'command-huge',
    turn: null,
    error: 'y'.repeat(10_000),
  })
  assert.equal([...correlations(backend).values()][0]?.length, 4_096, 'one retained cause is capped')
  correlations(backend).clear()
  for (let index = 0; index < 40; index += 1) {
    compactionEnd(host, agent.session, {
      compactionId: `compaction-${index}`,
      sourceCommandId: `command-${index}`,
      turn: null,
      error: `native detail ${index}`,
    })
  }
  const store = correlations(backend)
  assert.equal(store.size, 32)
  assert.equal([...store.values()].includes('native detail 0'), false, 'the oldest entry is evicted')
  assert.equal([...store.values()].at(-1), 'native detail 39')
  await backend.close()
  assert.equal(store.size, 0)
  assert.deepEqual([...store.keys()], [])
})