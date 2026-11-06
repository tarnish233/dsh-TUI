import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { BackendEvent, SessionEvent } from '../src/backend/types.ts'
import { defaults } from '../src/config.ts'
import { DEMO_TRANSCRIPT_CODEC, DemoBackend } from '../src/demo.ts'
import { TranscriptStore, type ToolTranscriptItem } from '../src/state/transcript.ts'

/**
 * Offline acceptance of the explicit `tools-group` demo fixture.
 *
 * It asserts only synthetic facts: event order/counts, durable times, proposed
 * -> call -> result transitions, turn-scoped ids and native presentation
 * metadata. No model call, command or file write happens here.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const asString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** Tool-call ids of one durable assistant message, in content order. */
function toolCallIds(data: unknown): string[] {
  const message = isRecord(data) && isRecord(data.message) ? data.message : undefined
  const content = message !== undefined && Array.isArray(message.content) ? message.content : []
  return content.flatMap(block =>
    isRecord(block) && block.type === 'tool-call' && typeof block.id === 'string' ? [block.id] : [],
  )
}

const sessionEvents = (events: BackendEvent[]): SessionEvent[] =>
  events.flatMap(event => (event.type === 'session_event' ? [event.event] : []))

const toolItems = (store: TranscriptStore): ToolTranscriptItem[] =>
  store.items.filter((item): item is ToolTranscriptItem => item.kind === 'tool')

interface Pumped {
  backend: DemoBackend
  store: TranscriptStore
  events: BackendEvent[]
  durable: SessionEvent[]
  /** Tool statuses at the moment each proposed call/result was observed. */
  proposed: Map<string, string>
  running: Map<string, string>
}

async function pumpToolsGroup(sends = 1): Promise<Pumped> {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo-group' })
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  const events: BackendEvent[] = []
  const proposed = new Map<string, string>()
  const running = new Map<string, string>()
  backend.onEvent(event => {
    events.push(event)
    store.handle(event)
    if (event.type !== 'session_event') return
    const durable = event.event
    const statusOf = (callId: string): string | undefined =>
      toolItems(store).find(item => item.callId === callId)?.status
    if (durable.type === 'assistant/message') {
      for (const callId of toolCallIds(durable.data)) {
        if (!proposed.has(callId)) proposed.set(callId, statusOf(callId) ?? 'missing')
      }
    } else if (durable.type === 'tool/call' && isRecord(durable.data)) {
      const callId = asString(durable.data.callId)
      if (callId !== undefined) running.set(callId, statusOf(callId) ?? 'missing')
    }
  })
  await backend.connect()
  for (let index = 0; index < sends; index++) await backend.send('tools-group')
  await backend.whenIdle()
  return { backend, store, events, durable: sessionEvents(events), proposed, running }
}

function eventIndex(durable: SessionEvent[], predicate: (event: SessionEvent) => boolean): number {
  const index = durable.findIndex(predicate)
  assert.ok(index >= 0, 'expected durable event was not emitted')
  return index
}

test('tools-group proposes a mixed adjacent group, then settles each call with real times', async () => {
  const { backend, store, events, durable, proposed, running } = await pumpToolsGroup()
  assert.equal(backend.demo, true, 'the demo stays explicit/offline')
  assert.equal(events[0]?.type, 'ready')

  const assistantMessages = durable.filter(event => event.type === 'assistant/message')
  const calls = durable.filter(event => event.type === 'tool/call')
  const results = durable.filter(event => event.type === 'tool/result')
  assert.equal(assistantMessages.length, 3, 'proposal, diff divider and final answer')
  assert.equal(calls.length, 4)
  assert.equal(results.length, 4)

  const callIds = calls.map(event => asString((event.data as Record<string, unknown>).callId))
  assert.deepEqual(callIds, [
    'call-demo-group-1-bash-1',
    'call-demo-group-1-bash-2',
    'call-demo-group-1-mcp',
    'call-demo-group-1-edit',
  ])
  assert.equal(new Set(callIds).size, 4)
  for (const callId of callIds) assert.match(callId ?? '', /-1-/, 'call ids carry the turn number')

  // Every call is a model request first, then an admitted call.
  assert.deepEqual([...proposed.keys()].sort(), [...callIds].sort())
  for (const status of proposed.values()) assert.equal(status, 'proposed')
  for (const status of running.values()) assert.equal(status, 'running', 'each call is observable before its result')

  for (const callId of callIds) {
    const proposal = eventIndex(durable, event => event.type === 'assistant/message' && toolCallIds(event.data).includes(callId ?? ''))
    const call = eventIndex(durable, event => event.type === 'tool/call' && event.data !== null && asString((event.data as Record<string, unknown>).callId) === callId)
    const result = eventIndex(durable, event => event.type === 'tool/result' && asString(
      (((event.data as Record<string, unknown>).message as unknown) as Record<string, unknown>).toolCallId,
    ) === callId)
    assert.ok(proposal < call, `${callId}: proposed before the durable call`)
    assert.ok(call < result, `${callId}: call before its result`)
  }

  // Native surface metadata: only append-origin message/result events carry it.
  for (const event of durable) {
    if (event.type === 'assistant/message' || event.type === 'tool/result' || event.type === 'user/message') {
      assert.equal(event.surfaceOp, 'append', `${event.type} declares its append origin`)
    } else {
      assert.equal(event.surfaceOp, undefined, `${event.type} is a log-only lifecycle record`)
    }
    assert.ok((event.time ?? 0) > 0, `${event.type} carries its own durable time`)
  }
  assert.deepEqual(
    [...durable].map(event => event.time ?? 0).sort((left, right) => left - right),
    durable.map(event => event.time ?? 0),
    'durable times are monotonic',
  )

  const tools = toolItems(store)
  assert.equal(tools.length, 4)
  // Rendering adjacency: the three mixed cards stay consecutive, and the
  // native Edit diff is preceded by its own assistant line (a group boundary).
  const toolOrder = store.items.flatMap(item => (item.kind === 'tool' ? [item.callId] : []))
  assert.deepEqual(toolOrder, [
    'call-demo-group-1-bash-1',
    'call-demo-group-1-bash-2',
    'call-demo-group-1-mcp',
    'call-demo-group-1-edit',
  ])
  const groupStart = store.items.findIndex(item => item.kind === 'tool' && item.callId === 'call-demo-group-1-bash-1')
  assert.deepEqual(
    store.items.slice(groupStart, groupStart + 3).map(item => (item.kind === 'tool' ? item.callId : item.kind)),
    ['call-demo-group-1-bash-1', 'call-demo-group-1-bash-2', 'call-demo-group-1-mcp'],
    'the mixed Bash/MCP group is adjacent',
  )
  assert.equal(store.items[groupStart - 1]?.kind, 'assistant')
  const editIndex = store.items.findIndex(item => item.kind === 'tool' && item.callId === 'call-demo-group-1-edit')
  assert.equal(store.items[editIndex - 1]?.kind, 'assistant', 'the diff card is separated from the group')
  assert.equal(store.items.at(-1)?.kind, 'assistant', 'the turn ends with a plain assistant answer')
  const callEvents = new Map(calls.map(event => [asString((event.data as Record<string, unknown>).callId) ?? '', event]))
  const resultEvents = new Map(results.map(event => [
    asString(((event.data as Record<string, unknown>).message as Record<string, unknown>).toolCallId) ?? '',
    event,
  ]))
  for (const item of tools) {
    assert.equal(item.status, 'done')
    const callEvent = callEvents.get(item.callId)
    const resultEvent = resultEvents.get(item.callId)
    assert.ok(callEvent !== undefined && resultEvent !== undefined)
    assert.equal(item.startedAt, callEvent.time, 'start time is the durable tool/call time')
    assert.equal(item.settledAt, resultEvent.time, 'settlement time is the durable tool/result time')
    assert.equal(item.durationMs, (resultEvent.time ?? 0) - (callEvent.time ?? 0))
    assert.equal(item.callSeq, callEvent.seq)
    assert.equal(item.resultSeq, resultEvent.seq)
    assert.equal(item.turn, 1)
    assert.equal(item.step, 1)
  }

  // Inputs and outputs are longer than the collapsed preview windows, so the
  // PTY check can expand a non-last Bash output and see the nested tree lines.
  const bashOne = tools.find(item => item.callId.endsWith('bash-1'))
  const bashTwo = tools.find(item => item.callId.endsWith('bash-2'))
  assert.ok(bashOne !== undefined && bashTwo !== undefined)
  for (const bash of [bashOne, bashTwo]) {
    const args = JSON.parse(bash.arguments) as { command: string }
    assert.ok(args.command.split('\n').length > defaults.expandedInputMaxLines)
    assert.ok(bash.resultText.split('\n').length > defaults.expandedOutputMaxLines)
    const presentation = bash.presentation as {
      call?: { card?: string; cwd?: string }
      result?: { card?: string; exitCode?: number; output?: string }
    }
    assert.equal(presentation.call?.card, 'terminal')
    assert.equal(presentation.call?.cwd, '/tmp/demo-group')
    assert.equal(presentation.result?.card, 'terminal')
    assert.equal(presentation.result?.exitCode, 0)
    assert.ok((presentation.result?.output ?? '').split('\n').length > defaults.expandedOutputMaxLines)
    assert.deepEqual(bash.resultContent, [{ type: 'text', text: bash.resultText }], 'raw result blocks are kept')
    assert.ok(isRecord(bash.rawResult), 'raw result envelope is kept')
  }

  const mcp = tools.find(item => item.callId.endsWith('mcp'))
  assert.ok(mcp !== undefined)
  assert.equal(mcp.name, 'mcp__demo__notes')
  assert.ok(mcp.arguments.split('\n').length > defaults.expandedInputMaxLines, 'the generic input is also long')
  const mcpPresentation = mcp.presentation as {
    call?: { card?: string; title?: string; kind?: string }
    result?: { card?: string }
  }
  assert.equal(mcpPresentation.call?.card, 'generic')
  assert.equal(mcpPresentation.call?.kind, 'mcp')
  assert.equal(mcpPresentation.result?.card, 'generic')
  assert.deepEqual(mcp.meta, { server: 'demo', tool: 'notes.lookup', matches: 3 })

  const edit = tools.find(item => item.callId.endsWith('edit'))
  assert.ok(edit !== undefined)
  const editPresentation = edit.presentation as {
    call?: { card?: string; title?: string; diffs?: Array<{ path?: string; oldText?: string | null; newText?: string }> }
    result?: { card?: string; diffs?: Array<{ path?: string; oldText?: string | null; newText?: string }> }
  }
  assert.equal(editPresentation.call?.card, 'diff')
  assert.equal(editPresentation.result?.card, 'diff')
  assert.equal(editPresentation.result?.diffs?.[0]?.path, 'src/group-demo.ts')
  assert.match(editPresentation.result?.diffs?.[0]?.newText ?? '', /after/)
  const editMeta = edit.meta as { diffs?: Array<{ oldText?: string; newText?: string }> }
  assert.match(editMeta.diffs?.[0]?.oldText ?? '', /before/)
  assert.match(editMeta.diffs?.[0]?.newText ?? '', /after/)

  // The turn ends with a plain assistant answer and the backend is ready/idle.
  const final = durable.filter(event => event.type === 'assistant/message').at(-1)
  assert.ok(final !== undefined)
  const finalMessage = (final.data as Record<string, unknown>).message as Record<string, unknown>
  const finalText = (finalMessage.content as Array<Record<string, unknown>>)
    .filter(block => block.type === 'text')
    .map(block => String(block.text))
    .join('\n')
  assert.match(finalText, /offline fixtures/)
  assert.equal(durable.at(-1)?.type, 'turn/end')
  assert.equal(store.status, 'idle')
  await backend.close()
})

test('replaying tools-group uses turn-scoped ids and never overwrites settled cards', async () => {
  const { backend, store, durable } = await pumpToolsGroup(2)
  const calls = durable
    .filter(event => event.type === 'tool/call')
    .map(event => asString((event.data as Record<string, unknown>).callId) ?? '')
  assert.equal(calls.length, 8)
  assert.equal(new Set(calls).size, 8, 'the second replay does not reuse call ids')
  assert.ok(calls.some(callId => callId.includes('-1-')))
  assert.ok(calls.some(callId => callId.includes('-2-')))
  const tools = toolItems(store)
  assert.equal(tools.length, 8)
  assert.ok(tools.every(item => item.status === 'done'), 'settled cards from the first replay stay done')
  assert.ok(tools.every(item => item.durationMs !== undefined && item.durationMs >= 0))
  await backend.close()
})

test('the existing tools keyword keeps its original fixtures', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  const events: BackendEvent[] = []
  backend.onEvent(event => {
    events.push(event)
    store.handle(event)
  })
  await backend.connect()
  await backend.send('tools')
  await backend.whenIdle()
  const tools = toolItems(store)
  assert.deepEqual(tools.map(item => item.callId), ['call-demo-bash', 'call-demo-tools-edit'])
  assert.ok(tools.every(item => item.status === 'done'))
  const callIds = sessionEvents(events)
    .filter(event => event.type === 'tool/call')
    .map(event => asString((event.data as Record<string, unknown>).callId))
  assert.deepEqual(callIds, ['call-demo-bash', 'call-demo-tools-edit'])
  await backend.close()
})