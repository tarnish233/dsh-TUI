/**
 * Offline contract tests for the approval proposal preview: the pure native
 * `presentCall(args)` view cached from an assistant message's tool-call blocks
 * and attached to the approval decision that precedes the durable `tool/call`.
 *
 * Every service is a local fake: no tool executes, no result presenter runs,
 * no file is read and no profile/credential/session log is touched.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDshBackend, type DshContextBackend } from '../src/backend/context.ts'
import type { BackendEvent, DecisionRequest, SessionInfo } from '../src/backend/types.ts'
import { FakeAgentRegistry, FakeDshHost, fakeNativeHelpers, nextTask, type FakeAgentState } from '../src/backend/testing.ts'

interface Harness {
  host: FakeDshHost
  agents: FakeAgentRegistry
  backend: DshContextBackend
  events: BackendEvent[]
  warnings: string[]
}

function harness(extra: (host: FakeDshHost) => void = () => {}): Harness {
  const host = new FakeDshHost()
  const agents = new FakeAgentRegistry()
  host.use('agents', agents)
  host.use('agentDefaultModel', {
    currentSelection: () => ({ provider: 'p1', model: 'm1' }),
    saveSelection: async () => {},
  })
  extra(host)
  const warnings: string[] = []
  const backend = createDshBackend(host, {
    cwd: '/workspace',
    native: fakeNativeHelpers(),
    warn: (message: string) => warnings.push(message),
  })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  return { host, agents, backend, events, warnings }
}

async function liveHarness(extra: (host: FakeDshHost) => void = () => {}): Promise<Harness & { agent: FakeAgentState; info: SessionInfo }> {
  const value = harness(extra)
  await value.backend.connect()
  await value.backend.send('prompt')
  const agent = value.agents.agents[0]
  assert.ok(agent)
  const info = await value.backend.connect()
  return { ...value, agent, info }
}

function assistantMessage(seq: number, calls: Array<{ id: string; name: string; arguments: string }>): Record<string, unknown> {
  return {
    type: 'assistant/message',
    seq,
    time: 1_700_000_000_000 + seq,
    data: {
      turn: 1,
      step: 1,
      message: {
        id: `message-${seq}`,
        role: 'assistant',
        source: { kind: 'model', provider: 'p1', model: 'm1' },
        content: [
          { type: 'text', text: 'about to use a tool' },
          ...calls.map(call => ({ type: 'tool-call', ...call })),
        ],
      },
      stream: [],
    },
  }
}

function lastDecision(events: BackendEvent[], kind: 'approval' | 'question' = 'approval'): DecisionRequest {
  const event = events.filter(item => item.type === 'decision').at(-1)
  assert.ok(event?.type === 'decision', 'a decision was announced')
  assert.equal(event.request.kind, kind)
  return event.request
}

/** One approve/reject round trip through the native waterfall. */
async function decide(value: Harness, decision: DecisionRequest): Promise<unknown> {
  const approval = value.host.waterfall('approval/request', {
    agent: value.agents.agents[0],
    toolName: 'bash',
    callId: decision.callId,
  })
  await nextTask()
  const request = lastDecision(value.events)
  await value.backend.respond(request.id, 'rejected')
  return await approval
}

test('an assistant-message proposal caches the pure presentCall view for the approval decision', async () => {
  const toolCalls: Array<{ name: string; scope: unknown; args: unknown }> = []
  let presentCalls = 0
  let presentResults = 0
  let executes = 0
  const { backend, host, events, agent } = await liveHarness((fakeHost) => {
    fakeHost.use('tools', {
      get: (name: string, scope?: unknown) => {
        toolCalls.push({ name, scope, args: undefined })
        return {
          presentCall: (args: unknown) => {
            presentCalls += 1
            toolCalls.at(-1)!.args = args
            return { card: 'terminal', title: `run ${String((args as { command?: unknown }).command)}`, cwd: '/workspace' }
          },
          presentResult: () => { presentResults += 1; return { card: 'terminal', output: 'x' } },
          execute: async () => { executes += 1; return {} },
        }
      },
    })
  })
  const before = events.length
  host.emit('session/event', agent.session, assistantMessage(4, [
    { id: 'call-1', name: 'bash', arguments: '{"command":"ls -la"}' },
  ]))
  const proposalEvent = events.slice(before).filter(event => event.type === 'session_event')
  assert.equal(proposalEvent.length, 1)
  assert.equal(
    proposalEvent[0]?.type === 'session_event' ? proposalEvent[0].event.toolPresentation : 'x',
    undefined,
    'an assistant message carries no single event-level tool presentation',
  )
  assert.equal(presentCalls, 1, 'the pure presenter ran once for the proposal')
  assert.deepEqual(toolCalls[0], { name: 'bash', scope: agent, args: { command: 'ls -la' } })

  const controller = new AbortController()
  const approval = host.waterfall('approval/request', {
    agent,
    toolName: 'bash',
    callId: 'call-1',
    reason: 'list files',
    signal: controller.signal,
  })
  await nextTask()
  const decision = lastDecision(events)
  assert.deepEqual(decision, {
    id: decision.id,
    kind: 'approval',
    title: 'Approve bash',
    message: 'list files',
    options: [
      { label: 'Allow once', description: 'Permit exactly this action.', value: 'allowed-once' },
      { label: 'Reject', description: 'Decline the action.', value: 'rejected' },
    ],
    callId: 'call-1',
    toolPresentation: {
      call: { card: 'terminal', title: 'run ls -la', cwd: '/workspace' },
    },
  })
  await backend.respond(decision.id, 'allowed-once')
  assert.equal(await approval, 'allowed-once')
  assert.equal(presentResults, 0, 'no result presenter runs for a proposal')
  assert.equal(executes, 0, 'no tool executes for a proposal')
  assert.equal(presentCalls, 1, 'the cached view is reused, not recomputed')
  assert.ok(events.some(event => event.type === 'decision_closed' && event.id === decision.id))
  await backend.close()
})

test('approval identity survives without a proposal cache, and absent callId adds no preview fields', async () => {
  let presentCalls = 0
  const { backend, host, events, agent } = await liveHarness((fakeHost) => {
    fakeHost.use('tools', {
      get: () => ({ presentCall: () => { presentCalls += 1; return { card: 'generic', title: 'x' } } }),
    })
  })
  const withoutProposal = host.waterfall('approval/request', { agent, toolName: 'bash', callId: 'call-unknown' })
  await nextTask()
  const first = lastDecision(events)
  assert.equal(first.callId, 'call-unknown', 'the native call identity is preserved')
  assert.equal(first.toolPresentation, undefined, 'no preview is fabricated without a proposal')
  await backend.respond(first.id, 'rejected')
  await withoutProposal

  const withoutCallId = host.waterfall('approval/request', { agent, toolName: 'bash' })
  await nextTask()
  const second = lastDecision(events)
  assert.equal(Object.hasOwn(second, 'callId'), false)
  assert.equal(Object.hasOwn(second, 'toolPresentation'), false)
  await backend.respond(second.id, 'rejected')
  await withoutCallId
  assert.equal(presentCalls, 0, 'an approval never computes a view on demand')
  await backend.close()
})

test('malformed or non-JSON native call views are omitted instead of previewed', async () => {
  const views: Array<{ name: string; value: unknown }> = [
    { name: 'undefined', value: undefined },
    { name: 'string', value: 'view' },
    { name: 'no title', value: { card: 'generic' } },
    { name: 'unknown card', value: { card: 'patch', title: 'x' } },
    { name: 'bad kind', value: { card: 'generic', title: 'x', kind: 'explode' } },
    { name: 'terminal cwd number', value: { card: 'terminal', title: 'x', cwd: 7 } },
    { name: 'diff without diffs', value: { card: 'diff', title: 'x' } },
    { name: 'diff with non-string newText', value: { card: 'diff', title: 'x', diffs: [{ path: 'a', oldText: null, newText: 7 }] } },
    { name: 'diff with bad locations', value: { card: 'diff', title: 'x', diffs: [], locations: [{ line: 2 }] } },
  ]
  for (const entry of views) {
    const { backend, host, events, agent } = await liveHarness((fakeHost) => {
      fakeHost.use('tools', { get: () => ({ presentCall: () => entry.value }) })
    })
    host.emit('session/event', agent.session, assistantMessage(1, [
      { id: `call-${entry.name}`, name: 'bash', arguments: '{"command":"ls"}' },
    ]))
    const approval = host.waterfall('approval/request', { agent, toolName: 'bash', callId: `call-${entry.name}` })
    await nextTask()
    const decision = lastDecision(events)
    assert.equal(decision.callId, `call-${entry.name}`, entry.name)
    assert.equal(decision.toolPresentation, undefined, entry.name)
    await backend.respond(decision.id, 'rejected')
    await approval
    await backend.close()
  }
})

test('a valid call view is JSON-safe: unserializable fields are dropped, never carried into the decision', async () => {
  const { backend, host, events, agent } = await liveHarness((fakeHost) => {
    fakeHost.use('tools', {
      get: () => ({ presentCall: () => ({ card: 'generic', title: 'x', rawInput: () => 'no', extra: undefined }) }),
    })
  })
  host.emit('session/event', agent.session, assistantMessage(1, [
    { id: 'call-json', name: 'bash', arguments: '{"command":"ls"}' },
  ]))
  const approval = host.waterfall('approval/request', { agent, toolName: 'bash', callId: 'call-json' })
  await nextTask()
  const decision = lastDecision(events)
  assert.deepEqual(decision.toolPresentation, { call: { card: 'generic', title: 'x' } })
  await backend.respond(decision.id, 'rejected')
  await approval
  await backend.close()
})

test('a throwing or unavailable tool definition never leaks its diagnostic into the decision', async () => {
  const secret = 'sk-live-deadbeef'
  const cases: Array<{ name: string; service: unknown }> = [
    {
      name: 'throwing presentCall',
      service: { get: () => ({ presentCall: () => { throw new Error(`presenter exploded: Authorization: Bearer ${secret}`) } }) },
    },
    {
      name: 'throwing get',
      service: { get: () => { throw new Error(`lookup exploded: api_key=${secret}`) } },
    },
    {
      name: 'definition without presentCall',
      service: { get: () => ({ presentResult: () => ({ card: 'terminal' }) }) },
    },
    { name: 'no tools service', service: undefined },
  ]
  for (const entry of cases) {
    const { backend, host, events, warnings, agent } = await liveHarness((fakeHost) => {
      if (entry.service !== undefined) fakeHost.use('tools', entry.service)
    })
    host.emit('session/event', agent.session, assistantMessage(2, [
      { id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
    ]))
    const approval = host.waterfall('approval/request', { agent, toolName: 'bash', callId: 'call-1' })
    await nextTask()
    const decision = lastDecision(events)
    assert.equal(decision.callId, 'call-1', entry.name)
    assert.equal(decision.toolPresentation, undefined, entry.name)
    assert.equal(JSON.stringify(events).includes(secret), false, entry.name)
    assert.equal(JSON.stringify(warnings).includes(secret), false, entry.name)
    await backend.respond(decision.id, 'rejected')
    await approval
    await backend.close()
  }
})

test('unparsable proposal arguments are never presented from a guess', async () => {
  let presentCalls = 0
  const { backend, host, events, agent } = await liveHarness((fakeHost) => {
    fakeHost.use('tools', {
      get: () => ({ presentCall: () => { presentCalls += 1; return { card: 'generic', title: 'guessed' } } }),
    })
  })
  host.emit('session/event', agent.session, assistantMessage(3, [
    { id: 'call-bad', name: 'bash', arguments: '{"command":' },
  ]))
  assert.equal(presentCalls, 0, 'no presenter runs without parsed args')
  const approval = host.waterfall('approval/request', { agent, toolName: 'bash', callId: 'call-bad' })
  await nextTask()
  const decision = lastDecision(events)
  assert.equal(decision.callId, 'call-bad')
  assert.equal(decision.toolPresentation, undefined)
  await backend.respond(decision.id, 'rejected')
  await approval
  await backend.close()
})

test('the approval preview is detached from the cached view used by durable tool events', async () => {
  const { backend, host, events, agent } = await liveHarness((fakeHost) => {
    fakeHost.use('tools', {
      get: () => ({
        presentCall: () => ({ card: 'diff', title: 'original', diffs: [{ path: 'a.ts', oldText: null, newText: '+a' }] }),
        presentResult: () => ({ card: 'terminal', output: 'done' }),
      }),
    })
  })
  host.emit('session/event', agent.session, assistantMessage(1, [
    { id: 'call-detach', name: 'bash', arguments: '{"command":"ls"}' },
  ]))
  const approval = host.waterfall('approval/request', { agent, toolName: 'bash', callId: 'call-detach' })
  await nextTask()
  const decision = lastDecision(events)
  const view = decision.toolPresentation?.call as {
    title?: string
    diffs?: Array<{ path: string; oldText: string | null; newText: string }>
  }
  assert.equal(view.title, 'original')
  // Nested arrays are the harder case: a shallow copy would share them.
  view.diffs?.[0] && (view.diffs[0].newText = 'MUTATED BY UI')
  await backend.respond(decision.id, 'rejected')
  await approval

  const before = events.length
  host.emit('session/event', agent.session, {
    type: 'tool/result', seq: 5,
    data: { message: { toolCallId: 'call-detach', content: [{ type: 'text', text: 'x' }], isError: false } },
  })
  const resultEvent = events.slice(before).filter(event => event.type === 'session_event').at(-1)
  const presentation = resultEvent?.type === 'session_event' ? resultEvent.event.toolPresentation : undefined
  assert.deepEqual(presentation, {
    call: { card: 'diff', title: 'original', diffs: [{ path: 'a.ts', oldText: null, newText: '+a' }] },
    result: { card: 'terminal', output: 'done' },
  }, 'a UI mutation of the decision copy never rewrites the cached native view')
  await backend.close()
})

test('one assistant message caches every proposed call, and only real tool-call blocks are looked up', async () => {
  const lookups: string[] = []
  const { backend, host, events, agent } = await liveHarness((fakeHost) => {
    fakeHost.use('tools', {
      get: (name: string) => {
        lookups.push(name)
        return { presentCall: (args: unknown) => ({ card: 'generic', title: `${name}:${String((args as { target?: unknown }).target)}` }) }
      },
    })
  })
  host.emit('session/event', agent.session, assistantMessage(5, [
    { id: 'call-a', name: 'read', arguments: '{"target":"a.ts"}' },
    { id: 'call-b', name: 'edit', arguments: '{"target":"b.ts"}' },
  ]))
  assert.deepEqual(lookups, ['read', 'edit'])
  for (const [callId, title] of [['call-a', 'read:a.ts'], ['call-b', 'edit:b.ts']] as const) {
    const approval = host.waterfall('approval/request', { agent, toolName: 'read', callId })
    await nextTask()
    const decision = lastDecision(events)
    assert.deepEqual(decision.toolPresentation, { call: { card: 'generic', title } })
    await backend.respond(decision.id, 'rejected')
    await approval
  }
  // A block that is not a complete tool call is never looked up or guessed.
  host.emit('session/event', agent.session, {
    type: 'assistant/message', seq: 6,
    data: { message: { content: [
      { type: 'tool-call', id: '', name: 'read', arguments: '{}' },
      { type: 'tool-call', id: 'call-missing-name', arguments: '{}' },
      { type: 'tool-call', id: 'call-missing-args', name: 'read' },
      { type: 'text', text: 'not a call' },
      'garbage',
    ] } },
  })
  assert.deepEqual(lookups, ['read', 'edit'], 'incomplete proposal blocks are ignored')
  await backend.close()
})

test('the proposal cache stays bounded by the existing tool-call budget', async () => {
  const budget = 2048
  const { backend, host, events, agent } = await liveHarness((fakeHost) => {
    fakeHost.use('tools', {
      get: () => ({ presentCall: (args: unknown) => ({ card: 'generic', title: String((args as { command?: unknown }).command) }) }),
    })
  })
  const total = budget + 2
  for (let index = 0; index < total; index += 1) {
    host.emit('session/event', agent.session, assistantMessage(10 + index, [
      { id: `call-${index}`, name: 'bash', arguments: `{"command":"cmd-${index}"}` },
    ]))
  }
  // The oldest entries were evicted; the newest survive. Either way the call
  // identity is preserved and no preview is recomputed at approval time.
  for (const [callId, expected] of [
    ['call-0', undefined],
    ['call-1', undefined],
    [`call-${total - 1}`, 'cmd-' + String(total - 1)],
  ] as const) {
    const approval = host.waterfall('approval/request', { agent, toolName: 'bash', callId })
    await nextTask()
    const decision = lastDecision(events)
    assert.equal(decision.callId, callId)
    if (expected === undefined) assert.equal(decision.toolPresentation, undefined, callId)
    else assert.deepEqual(decision.toolPresentation, { call: { card: 'generic', title: expected } }, callId)
    await backend.respond(decision.id, 'rejected')
    await approval
  }
  await backend.close()
})

test('proposal presentation never executes tools, presents results, reads files or creates sessions', async () => {
  let executes = 0
  let presentResults = 0
  let fsReads = 0
  const { backend, host, events, agents, agent } = await liveHarness((fakeHost) => {
    fakeHost.use('fs', { readFile: async () => { fsReads += 1; throw new Error('adapter must not read files') } })
    fakeHost.use('tools', {
      get: () => ({
        presentCall: () => ({ card: 'diff', title: 'Write a.ts', diffs: [{ path: 'a.ts', oldText: null, newText: '+a' }] }),
        presentResult: () => { presentResults += 1; return { card: 'diff', diffs: [] } },
        execute: async () => { executes += 1; return {} },
      }),
    })
  })
  const createCalls = agents.createCalls.length
  host.emit('session/event', agent.session, assistantMessage(1, [
    { id: 'call-write', name: 'write', arguments: '{"path":"a.ts","content":"a\\n"}' },
  ]))
  const approval = host.waterfall('approval/request', { agent, toolName: 'write', callId: 'call-write' })
  await nextTask()
  const decision = lastDecision(events)
  assert.deepEqual(decision.toolPresentation, {
    call: { card: 'diff', title: 'Write a.ts', diffs: [{ path: 'a.ts', oldText: null, newText: '+a' }] },
  })
  await backend.respond(decision.id, 'rejected')
  await approval
  assert.equal(executes, 0)
  assert.equal(presentResults, 0)
  assert.equal(fsReads, 0)
  assert.equal(agents.createCalls.length, createCalls, 'no Agent is created by a proposal or an approval preview')
  await backend.close()
})