import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { BackendEvent, DecisionRequest, SessionEvent } from '../src/backend/types.ts'
import {
  DEMO_COMMANDS,
  DEMO_HINTS,
  DEMO_MODEL,
  DEMO_PROVIDER,
  DEMO_TRANSCRIPT_CODEC,
  DemoBackend,
} from '../src/demo.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import { TranscriptView } from '../src/ui/transcript.ts'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'

function waitFor(backend: DemoBackend, predicate: (event: BackendEvent) => boolean): Promise<BackendEvent> {
  return new Promise(resolve => {
    const off = backend.onEvent(event => {
      if (predicate(event)) {
        off()
        resolve(event)
      }
    })
  })
}

/** Same wiring the app uses: the store consumes the backend's codec. */
function newStore(backend: DemoBackend): TranscriptStore {
  const codec = backend.transcriptCodec
  assert.ok(codec !== undefined, 'the offline demo must expose a fixture codec before ready')
  return new TranscriptStore({ codec })
}

async function pump(text: string): Promise<{ backend: DemoBackend; store: TranscriptStore; events: BackendEvent[] }> {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const store = newStore(backend)
  const events: BackendEvent[] = []
  backend.onEvent(event => {
    events.push(event)
    store.handle(event)
  })
  await backend.connect()
  await backend.send(text)
  await backend.whenIdle()
  return { backend, store, events }
}

const sessionEvents = (events: BackendEvent[]): SessionEvent[] =>
  events.flatMap(event => (event.type === 'session_event' ? [event.event] : []))

test('demo connect is visibly offline and emits ready info', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  const info = await backend.connect()
  assert.equal(info.provider, DEMO_PROVIDER)
  assert.equal(info.model, DEMO_MODEL)
  assert.deepEqual(info.permissions, { currentValue: 'workspace-write' })
  assert.equal(backend.demo, true)
  assert.ok(info.capabilities.includes('commands'))
  assert.ok(info.capabilities.includes('execute'))
  assert.equal(events[0]?.type, 'ready')
  assert.equal(events[1]?.type, 'status')
  assert.ok(DEMO_HINTS.length >= 4)
  await backend.close()
  assert.equal(events.at(-1)?.type, 'closed')
})

test('the demo codec is fixture-only, available before ready, and never exported by state', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  assert.equal(backend.transcriptCodec, DEMO_TRANSCRIPT_CODEC)
  const stream = backend.transcriptCodec!.createStream()
  stream.push({ type: 'block-start', index: 0, blockType: 'text' })
  stream.push({ type: 'text-delta', index: 0, text: 'partial' })
  assert.deepEqual(stream.snapshot(), { text: 'partial', thinking: '', toolNames: [] })
  // Surface classification mirrors DSH: append origin vs model-only replacement.
  assert.equal(backend.transcriptCodec!.surfaceKind({ type: 'assistant/message', seq: 1, data: {}, surfaceOp: 'append' }), 'append')
  assert.equal(backend.transcriptCodec!.surfaceKind({
    type: 'tool/result',
    seq: 2,
    data: {},
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
  }), 'replace')
  assert.equal(backend.transcriptCodec!.surfaceKind({ type: 'assistant/attempt', seq: 3, data: {} }), 'none')
  await backend.close()
})

test('ordinary prompt emits live frames, durable messages, tool call/result with diff', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const store = newStore(backend)
  const events: BackendEvent[] = []
  let midStream: { text: string; kinds: string[] } | undefined
  backend.onEvent(event => {
    events.push(event)
    store.handle(event)
    if (midStream === undefined && event.type === 'stream_chunk' && event.chunk.type === 'text-delta') {
      const live = store.items.find(item => item.kind === 'attempt')
      // Partial output is visible BEFORE any provider finish / settlement.
      midStream = { text: live?.kind === 'attempt' ? live.text : '', kinds: store.items.map(item => item.kind) }
    }
  })
  await backend.connect()
  await backend.send('hello')
  await backend.whenIdle()

  const types = events.map(event => event.type)
  assert.ok(types.includes('stream_start'))
  assert.ok(types.includes('stream_chunk'))
  assert.ok(types.includes('stream_end'))
  const revisions = events.flatMap(event => event.type === 'stream_start' || event.type === 'stream_chunk' || event.type === 'stream_end' ? [event.revision] : [])
  assert.ok(revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!), 'demo must use native DSH per-frame revisions, not hide protocol bugs')
  const durable = sessionEvents(events)
  const durableTypes = durable.map(event => event.type)
  assert.ok(durableTypes.includes('assistant/message'))
  assert.ok(durableTypes.includes('tool/call'))
  assert.ok(durableTypes.includes('tool/result'))
  // Truthful append surface metadata for every surface event.
  for (const event of durable) {
    if (['user/message', 'assistant/message', 'tool/result', 'system/message', 'developer/message'].includes(event.type)) {
      assert.equal(event.surfaceOp, 'append', `${event.type} must declare its append origin`)
    } else {
      assert.equal(event.surfaceOp, undefined, `${event.type} is log-only and cannot carry surface metadata`)
    }
  }
  // Native tool render intents travel with the durable events, not the model text.
  const toolCall = durable.find(event => event.type === 'tool/call')
  const toolResult = durable.find(event => event.type === 'tool/result')
  assert.equal((toolCall?.toolPresentation as { call?: { card?: string } } | undefined)?.call?.card, 'diff')
  assert.equal((toolResult?.toolPresentation as { result?: { card?: string } } | undefined)?.result?.card, 'diff')

  assert.ok(midStream !== undefined)
  assert.ok(midStream.text.length > 0, 'streamed text must appear before finish')
  assert.ok(!midStream.kinds.includes('assistant'), 'no durable reply before settlement')

  assert.deepEqual(store.items.map(item => item.kind), ['user', 'assistant', 'tool', 'assistant'])
  const tool = store.items[2]
  assert.equal(tool?.kind, 'tool')
  if (tool?.kind !== 'tool') return
  assert.equal(tool.callId, 'call-demo-edit')
  assert.equal(tool.status, 'done')
  assert.ok(tool.meta !== undefined)
  const meta = tool.meta as { diffs?: Array<{ path: string; oldText: string | null; newText: string }> }
  assert.equal(meta.diffs?.[0]?.path, 'src/greet.ts')
  assert.match(meta.diffs?.[0]?.newText ?? '', /你好/)
  assert.equal((tool.presentation as { result?: { card?: string } } | undefined)?.result?.card, 'diff')

  const view = new TranscriptView(store, { showThinking: true, expandTools: false })
  for (const width of [40, 80, 120]) {
    const lines = view.render(width)
    for (const line of lines) assert.ok(visibleWidth(line) <= width)
  }
  const rendered = stripTerminalSequences(view.render(100).join('\n'))
  assert.match(rendered, /中文/)
  assert.match(rendered, /🚀/)
  assert.match(rendered, /Updated src\/greet\.ts with 1 addition and 1 removal/)
  // Hunk line numbers are not file coordinates.
  assert.doesNotMatch(rendered, /^\s*\d+\s+\d*\s*[+-]/m)
  await backend.close()
})

test('tools fixture emits a native terminal call and result card', async () => {
  const { backend, store } = await pump('tools')
  const tool = store.items.find(item => item.kind === 'tool')
  assert.equal(tool?.kind, 'tool')
  if (tool?.kind !== 'tool') return
  assert.equal(tool.callId, 'call-demo-bash')
  assert.equal(tool.name, 'bash')
  assert.equal(tool.status, 'done')
  const presentation = tool.presentation as {
    call?: { card?: string }
    result?: { card?: string; exitCode?: number; output?: string }
  }
  assert.equal(presentation.call?.card, 'terminal')
  assert.equal(presentation.result?.card, 'terminal')
  assert.equal(presentation.result?.exitCode, 0)
  assert.match(presentation.result?.output ?? '', /\/tmp\/demo/)
  const view = new TranscriptView(store, { showThinking: false, expandTools: false })
  const rendered = stripTerminalSequences(view.render(90).join('\n'))
  const edit = store.items.find(item => item.kind === 'tool' && item.callId === 'call-demo-tools-edit')
  assert.equal(edit?.kind, 'tool')
  if (edit?.kind !== 'tool') return
  assert.equal(edit.status, 'done')
  assert.equal((edit.presentation as { result?: { card?: string } } | undefined)?.result?.card, 'diff')
  assert.match(rendered, /Bash pwd/)
  assert.match(rendered, /Show the demo workspace/)
  assert.match(rendered, /1 line returned/)
  assert.doesNotMatch(rendered, /Update Edit/, 'the native tool verb is not duplicated by its CC label')
  assert.match(rendered, /Update src\/greet\.ts/)
  view.options.expandTools = true
  const details = stripTerminalSequences(view.render(90).join('\n'))
  assert.match(details, /exit code 0/, 'native exit code belongs to expanded Output')
  assert.match(rendered, /你好/)
  assert.match(rendered, /Both cards came from the offline demo/)
  assert.match(rendered, /No command\s+ran/)
  await backend.close()
})

test('demo event flow is deterministic for the same prompt', async () => {
  const first = await pump('hello')
  const second = await pump('hello')
  const normalize = (events: BackendEvent[]): string => JSON.stringify(events)
  assert.equal(normalize(first.events), normalize(second.events))
  await first.backend.close()
  await second.backend.close()
})

test('question fixture waits for ordered answers then completes', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const store = newStore(backend)
  backend.onEvent(event => store.handle(event))
  await backend.connect()
  const decisionPromise = waitFor(backend, event => event.type === 'decision')
  await backend.send('question')
  const event = await decisionPromise
  assert.equal(event.type, 'decision')
  if (event.type !== 'decision') return
  const request: DecisionRequest = event.request
  assert.equal(request.kind, 'question')
  assert.equal(request.questions?.length, 2)
  assert.equal(request.questions?.[0]?.multiSelect, true)
  assert.equal(request.questions?.[1]?.multiSelect, undefined)
  assert.equal(store.status, 'running')
  await backend.respond(request.id, { answers: [['Blue', 'custom'], 'Compact'] })
  await backend.whenIdle()
  const final = store.items.filter(item => item.kind === 'assistant').at(-1)
  assert.equal(final?.kind, 'assistant')
  if (final?.kind !== 'assistant') return
  assert.match(final.text, /Blue, custom/)
  assert.match(final.text, /Compact/)
  assert.equal(store.status, 'idle')
  await backend.close()
})

test('approval fixture preserves opaque values and settles the request', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const store = newStore(backend)
  backend.onEvent(event => store.handle(event))
  await backend.connect()
  const decisionPromise = waitFor(backend, event => event.type === 'decision')
  await backend.send('approval')
  const event = await decisionPromise
  assert.equal(event.type, 'decision')
  if (event.type !== 'decision') return
  const values = event.request.options?.map(option => option.value)
  assert.ok(values?.some(value => typeof value === 'object' && value !== null))
  const chosen = event.request.options?.[0]?.value
  await backend.respond(event.request.id, chosen)
  await backend.whenIdle()
  const final = store.items.filter(item => item.kind === 'assistant').at(-1)
  assert.equal(final?.kind, 'assistant')
  if (final?.kind !== 'assistant') return
  assert.match(final.text, /allow/)
  await backend.close()
})

test('abort fixture leaves an abandoned tentative attempt, never a reply', async () => {
  const { backend, store } = await pump('abort')
  const attempts = store.items.filter(item => item.kind === 'attempt')
  assert.equal(attempts.length, 1)
  const attempt = attempts[0]
  assert.equal(attempt?.kind, 'attempt')
  if (attempt?.kind !== 'attempt') return
  assert.equal(attempt.status, 'abandoned')
  assert.equal(attempt.tentative, true)
  assert.equal(store.items.some(item => item.kind === 'assistant'), false)
  await backend.close()
})

test('failure fixture settles assistant/attempt and reports a nonfatal error', async () => {
  const { backend, store } = await pump('fail')
  const attempts = store.items.filter(item => item.kind === 'attempt')
  assert.equal(attempts.length, 1)
  const attempt = attempts[0]
  assert.equal(attempt?.kind, 'attempt')
  if (attempt?.kind !== 'attempt') return
  assert.equal(attempt.status, 'abandoned')
  assert.equal(attempt.tentative, false)
  assert.match(attempt.text, /partial reply/)
  assert.equal(store.items.some(item => item.kind === 'assistant'), false)
  const notice = store.items.find(item => item.kind === 'notice')
  assert.equal(notice?.kind, 'notice')
  if (notice?.kind !== 'notice') return
  assert.equal(notice.level, 'error')
  assert.match(notice.text, /simulated provider stream error/)
  await backend.close()
})

test('an admitted tool call without a result settles as unknown, never as Running or success', async () => {
  const { backend, store } = await pump('pending')
  const tool = store.items.find(item => item.kind === 'tool')
  assert.equal(tool?.kind, 'tool')
  if (tool?.kind !== 'tool') return
  assert.equal(tool.callId, 'call-demo-pending')
  assert.equal(tool.status, 'unknown')
  assert.equal(tool.resultText, '')
  assert.equal((tool.presentation as { call?: { card?: string } } | undefined)?.call?.card, 'generic')
  const view = new TranscriptView(store, { showThinking: false, expandTools: false })
  const rendered = stripTerminalSequences(view.render(90).join('\n'))
  assert.match(rendered, /No result observed/)
  assert.doesNotMatch(rendered, /Running/)
  assert.doesNotMatch(rendered, /Updated /)
  assert.equal(store.items.some(item => item.kind === 'assistant' && /tool failed/i.test(item.text)), false)
  await backend.close()
})

test('cancel interrupts a running ordinary turn and settles no reply', async () => {
  const backend = new DemoBackend({ delayMs: 2, cwd: '/tmp/demo' })
  const store = newStore(backend)
  backend.onEvent(event => store.handle(event))
  await backend.connect()
  const chunkPromise = waitFor(backend, event => event.type === 'stream_chunk' && event.chunk.type === 'text-delta')
  await backend.send('hello')
  await chunkPromise
  await backend.cancel()
  await backend.whenIdle()
  assert.equal(store.hasLiveAttempt, false)
  assert.equal(store.items.some(item => item.kind === 'assistant'), false)
  const attempt = store.items.find(item => item.kind === 'attempt')
  assert.equal(attempt?.kind, 'attempt')
  if (attempt?.kind !== 'attempt') return
  assert.equal(attempt.status, 'abandoned')
  await backend.close()
})

test('demo commands expose native descriptors and execute returns paired CommandExecution', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const store = newStore(backend)
  const events: BackendEvent[] = []
  backend.onEvent(event => {
    events.push(event)
    store.handle(event)
  })
  await backend.connect()

  const descriptors = await backend.command('commands')
  assert.deepEqual(descriptors, DEMO_COMMANDS.map(command => ({ ...command })))

  const execution = await backend.command('execute', { line: '/echo hello' }) as {
    commandId: string
    result: { kind: string; text?: string }
  }
  assert.match(execution.commandId, /^demo-command-/)
  assert.equal(execution.result.kind, 'success')
  assert.equal(execution.result.text, 'hello')
  const durable = sessionEvents(events)
  const run = durable.find(event => event.type === 'command/run')
  const done = durable.find(event => event.type === 'command/done')
  assert.equal((run?.data as { name?: string }).name, 'echo')
  assert.equal((done?.data as { commandId?: string }).commandId, execution.commandId)
  assert.equal((done?.data as { kind?: string }).kind, 'success')
  // Command lifecycle records are log-only: no fabricated surface metadata.
  assert.equal(run?.surfaceOp, undefined)

  const unknown = await backend.command('execute', { line: '/nope' }) as { result: { kind: string; text: string } }
  assert.equal(unknown.result.kind, 'error')
  assert.match(unknown.result.text, /Unknown demo command/)

  // `/compact` is a compatibility alias for the native execute path.
  const compacted = await backend.command('compact') as { result: { kind: string; text?: string } }
  assert.equal(compacted.result.kind, 'success')
  assert.match(compacted.result.text ?? '', /Demo compaction simulated/)

  await assert.rejects(backend.command('execute', {}), /non-empty \{ line \}/)
  await assert.rejects(backend.command('execute', { line: 'compact' }), /must start with/)
  await assert.rejects(backend.command('not-a-command'), /demo is not a real backend/)
  await backend.close()
})

test('demo retains the other offline commands and never claims real effects', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  await backend.connect()
  assert.ok(Array.isArray(await backend.command('models')))
  assert.ok(Array.isArray(await backend.command('sessions')))
  const state = await backend.command('state')
  assert.equal((state as { demo?: boolean }).demo, true)
  assert.deepEqual(await backend.command('dequeue'), [])
  const info = await backend.command('new')
  assert.equal((info as { sessionId?: string }).sessionId, 'demo-session-2')
  const resumed = await backend.command('resume', { sessionId: 'demo-resumed' })
  assert.equal((resumed as { sessionId?: string }).sessionId, 'demo-resumed')
  const reModeled = await backend.command('model', { model: 'demo-other' })
  assert.equal((reModeled as { model?: string }).model, 'demo-other')
  await backend.close()
})