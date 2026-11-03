import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { DshBackend } from '../src/backend/index.ts'
import type { BackendEvent } from '../src/backend/types.ts'
import { App } from '../src/app.ts'
import { VirtualTerminal, delay, until } from './helpers/terminal.ts'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-real-stream-'))
  const home = join(directory, 'home')
  const cwd = join(directory, 'workspace')
  await mkdir(home); await mkdir(cwd)
  const plugin = pathToFileURL(fileURLToPath(new URL('./fixtures/mock-stream.mjs', import.meta.url))).href
  await writeFile(join(home, 'cordis.patch.yml'), '- insert:\n    - id: test-model-stream\n      name: ' + JSON.stringify(plugin) + '\n')
  const backend = new DshBackend({ cwd, home, provider: 'deepseek-official', model: 'deepseek-flash' })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  const info = await backend.connect()
  return { backend, events, info, directory, async close() { await backend.close(); await rm(directory, { recursive: true, force: true }) } }
}

function delta(event: BackendEvent): event is Extract<BackendEvent, { type: 'stream_chunk' }> {
  return event.type === 'stream_chunk' && event.chunk.type === 'text-delta'
}
function idle(events: BackendEvent[]) { return events.some(event => event.type === 'status' && event.status === 'idle') }

test('real DSH publishes token chunks before durable message and committed end (no remote model)', async () => {
  const f = await fixture()
  try {
    await f.backend.send('fixture:normal')
    await until(() => idle(f.events), 'native stream settles')
    const chunks = f.events.filter(delta)
    assert.ok(chunks.length >= 4, JSON.stringify(f.events))
    assert.equal(chunks.map(event => event.chunk.text).join(''), 'fixture-live 中文 🚀 complete')
    const messageIndex = f.events.findIndex(event => event.type === 'session_event' && event.event.type === 'assistant/message')
    const firstDelta = f.events.findIndex(delta)
    const endIndex = f.events.findIndex(event => event.type === 'stream_end' && event.outcome === 'committed')
    assert.ok(firstDelta >= 0 && messageIndex > firstDelta && endIndex > messageIndex)
    const message = f.events[messageIndex] as Extract<BackendEvent, {type:'session_event'}>
    const end = f.events[endIndex] as Extract<BackendEvent, {type:'stream_end'}>
    assert.equal(end.seq, message.event.seq)
    assert.ok(chunks.every(event => event.sessionId === f.info.sessionId))
  } finally { await f.close() }
})

test('real DSH cancellation settles the streaming prefix and runtime remains usable', async () => {
  const f = await fixture()
  try {
    await f.backend.send('fixture:slow')
    await until(() => f.events.filter(delta).length >= 3, 'native slow stream begins')
    assert.ok(f.events.filter(delta).length < 80, 'cancel must happen while the provider is still producing tokens')
    assert.equal(idle(f.events), false, 'a replay of an already finished response is not streaming')
    await f.backend.cancel()
    await until(() => idle(f.events), 'native cancellation settles')
    assert.ok(f.events.some(event => event.type === 'session_event' && ['assistant/message','assistant/attempt'].includes(event.event.type)))
    assert.equal(f.events.some(event => event.type === 'closed'), false)
    const info = await f.backend.command('new')
    assert.ok(info)
    f.events.length = 0
    await f.backend.send('fixture:normal')
    await until(() => idle(f.events), 'native runtime accepts next turn')
    assert.equal(f.events.filter(delta).map(event => event.chunk.text).join(''), 'fixture-live 中文 🚀 complete')
  } finally { await f.close() }
})

test('native DSH approval grants and rejects once, with paired durable audit facts', async () => {
  const f = await fixture()
  try {
    for (const outcome of ['rejected', 'allowed-once']) {
      if (outcome === 'allowed-once') await f.backend.command('new')
      f.events.length = 0
      await f.backend.send('fixture:approval')
      await until(() => f.events.some(event => event.type === 'decision'), 'native approval request').catch(error => { throw new Error(String(error) + ': ' + JSON.stringify(f.events.filter(event => event.type === 'error'))) })
      const request = f.events.find(event => event.type === 'decision') as Extract<BackendEvent, {type:'decision'}>
      assert.equal(request.request.kind, 'approval')
      await f.backend.respond(request.request.id, outcome)
      await until(() => idle(f.events), 'native approval response settles')
      const audits = f.events.filter(event => event.type === 'session_event' && event.event.type === 'approval/decided') as Extract<BackendEvent, {type:'session_event'}>[]
      assert.equal(audits.length, 1)
      assert.equal((audits[0]!.event.data as {outcome:string}).outcome, outcome)
      assert.ok(f.events.filter(delta).map(event => event.chunk.text).join('').includes('approval-' + outcome))
    }
  } finally { await f.close() }
})

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`real DSH paints an incomplete answer before settlement (${screen})`, async () => {
    const f = await fixture()
    const terminal = new VirtualTerminal(90, 30)
    const app = new App({ backend: f.backend, cwd: f.info.cwd, configDir: join(f.directory, 'tui'), terminal, screen, registerSignals: false })
    try {
      await app.start()
      f.events.length = 0
      await app.submit('fixture:slow')
      await until(() => terminal.document().includes('slow-0'), 'first tokens painted while generation is in progress')
      await terminal.flush()
      assert.equal(app.isBusy, true)
      assert.equal(idle(f.events), false)
      assert.ok(f.events.filter(delta).length > 0 && f.events.filter(delta).length < 80)
      assert.equal(f.events.some(event => event.type === 'session_event' && event.event.type === 'assistant/message'), false)
      assert.match(terminal.document(), /slow-0/)
      assert.doesNotMatch(terminal.document(), /slow-79/)
      terminal.type('draft while streaming')
      await delay(25); await terminal.flush()
      assert.equal(app.editor.getText(), 'draft while streaming')
      assert.equal(app.isBusy, true)
      await app.interrupt()
      await until(() => idle(f.events), 'incomplete answer cancellation settles')
    } finally { await app.shutdown(); terminal.dispose(); await f.close() }
  })
}

test('full real DSH → App → ANSI terminal question and streaming path', async () => {
  const f = await fixture()
  const terminal = new VirtualTerminal(90, 30)
  const app = new App({ backend: f.backend, cwd: f.info.cwd, configDir: join(f.directory, 'tui'), terminal, screen: 'fullscreen', registerSignals: false })
  try {
    await app.start()
    f.events.length = 0
    await app.submit('fixture:question')
    await until(() => f.events.some(event => event.type === 'decision'), 'native UI question')
    await delay(25); await terminal.flush()
    assert.match(terminal.screen(), /Choose a native fixture answer/)
    terminal.type('2')
    await until(() => idle(f.events), 'native UI answer completes')
    await delay(25); await terminal.flush()
    assert.match(terminal.document(), /question-complete/)
    assert.ok(f.events.filter(delta).length >= 4)
  } finally { await app.shutdown(); terminal.dispose(); await f.close() }
})

test('native DSH ask_user_question crosses the bridge and accepts an ordered answer', async () => {
  const f = await fixture()
  try {
    await f.backend.send('fixture:question')
    await until(() => f.events.some(event => event.type === 'decision'), 'native question reaches client')
    const decision = f.events.find(event => event.type === 'decision') as Extract<BackendEvent, {type:'decision'}>
    assert.equal(decision.request.kind, 'question')
    assert.equal(decision.request.questions?.[0]?.question, 'Choose a native fixture answer?')
    await f.backend.respond(decision.request.id, { answers: ['Beta'] })
    await until(() => idle(f.events), 'native answered question completes')
    assert.ok(f.events.some(event => event.type === 'decision_closed' && event.id === decision.request.id))
    assert.ok(f.events.filter(delta).map(event => event.chunk.text).join('').includes('question-complete'))
    await assert.rejects(f.backend.respond(decision.request.id, { answers: ['Alpha'] }), /no longer|stale|unknown/i)
  } finally { await f.close() }
})
