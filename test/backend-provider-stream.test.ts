import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { App } from '../src/app.ts'
import { DshBackend } from '../src/backend/index.ts'
import type { BackendEvent } from '../src/backend/types.ts'
import { VirtualTerminal, delay, until } from './helpers/terminal.ts'

const KEY_ENV = 'DSH_PI_TUI_LOOPBACK_TEST_KEY'
const TEST_KEY = 'local-sse-test-only-not-a-real-credential'
const PREFIX = 'sse-live 中文 '
const SUFFIX = '🚀 complete'

/**
 * A real HTTP SSE response whose finish is controlled by the test, not a timer.
 * No llm/stream override: DSH's actual provider serialization, HTTP transport,
 * SSE parser, translator, Agent frames, bridge and renderer all remain active.
 */
async function localProvider() {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const requests: Array<{ path: string; key?: string; body: Record<string, unknown> }> = []
  const errors: string[] = []
  let finishedAt: number | undefined
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/anthropic/v1/messages') {
        errors.push(`Unexpected provider request: ${request.method} ${request.url}`)
        response.writeHead(404); response.end(); return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > 1024 * 1024) throw new Error('test request exceeded 1 MiB')
        chunks.push(buffer)
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid provider body')
      const key = request.headers['x-api-key']
      requests.push({ path: request.url, key: typeof key === 'string' ? key : undefined, body: body as Record<string, unknown> })
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const emit = (event: Record<string, unknown>) => {
        response.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
      }
      emit({ type: 'message_start', message: { id: 'local-message', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: PREFIX } })
      await held
      if (response.destroyed) return
      emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: SUFFIX } })
      emit({ type: 'content_block_stop', index: 0 })
      emit({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } })
      emit({ type: 'message_stop' })
      finishedAt = performance.now()
      response.end()
    })().catch(error => {
      errors.push(error instanceof Error ? error.message : String(error))
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('loopback provider did not bind')
  return {
    baseURL: `http://127.0.0.1:${address.port}/anthropic`, requests, errors, release,
    get finishedAt() { return finishedAt },
    async close() {
      release()
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        server.closeAllConnections()
      })
    },
  }
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`real DeepSeek provider paints SSE before the server sends its finish (${screen})`, async () => {
    const provider = await localProvider()
    const directory = await mkdtemp(join(tmpdir(), 'dsh-provider-sse-'))
    const home = join(directory, 'home'), cwd = join(directory, 'workspace')
    await mkdir(home); await mkdir(cwd)
    await writeFile(join(home, 'cordis.patch.yml'), `- id: llm-deepseek\n  config:\n    baseURL: ${JSON.stringify(provider.baseURL)}\n    apiKeyEnv: ${KEY_ENV}\n    models:\n      - id: deepseek-flash\n`)
    const previousKey = process.env[KEY_ENV]
    process.env[KEY_ENV] = TEST_KEY
    const backend = new DshBackend({ home, cwd, provider: 'deepseek-official', model: 'deepseek-flash' })
    const events: BackendEvent[] = []
    backend.onEvent(event => events.push(event))
    const terminal = new VirtualTerminal(90, 30)
    const app = new App({ backend, cwd, configDir: join(directory, 'tui'), terminal, screen, registerSignals: false })
    try {
      await app.start()
      assert.ok(app.session, 'DSH connects without real credentials or a remote endpoint')
      events.length = 0
      await app.submit('Verify the local incremental transport. Do not use tools.')
      await until(() => terminal.document().includes('sse-live'), 'SSE prefix is visible before the server is released', 10000).catch(error => {
        const failures = events.flatMap(event => event.type === 'error' ? [event.message] : [])
        throw new Error(String(error) + ': ' + failures.join('; '))
      })
      await terminal.flush()
      assert.equal(provider.requests.length, 1)
      assert.equal(provider.requests[0]?.body.stream, true)
      assert.equal(provider.requests[0]?.key, TEST_KEY)
      assert.equal(provider.finishedAt, undefined, 'finish is still held at the HTTP server')
      assert.equal(app.isBusy, true)
      assert.match(terminal.document(), /sse-live 中文/)
      assert.doesNotMatch(terminal.document(), /complete/)
      assert.equal(events.some(event => event.type === 'session_event' && event.event.type === 'assistant/message'), false)
      const live = app.store.items.find(item => item.kind === 'attempt')
      assert.ok(live?.kind === 'attempt' && live.text === PREFIX)
      terminal.type('editable draft during SSE')
      await delay(25); await terminal.flush()
      assert.equal(app.editor.getText(), 'editable draft during SSE')
      assert.equal(app.isBusy, true)

      provider.release()
      await until(() => events.some(event => event.type === 'status' && event.status === 'idle'), 'real provider settles')
      await delay(25); await terminal.flush()
      assert.match(terminal.document(), /sse-live 中文 🚀 complete/)
      assert.equal((terminal.document().match(/sse-live/g) ?? []).length, 1)
      assert.equal(app.store.items.filter(item => item.kind === 'assistant').length, 1)
      assert.equal(app.store.hasLiveAttempt, false)
      assert.equal(app.editor.getText(), 'editable draft during SSE')
      const revisions = events.flatMap(event => event.type === 'stream_start' || event.type === 'stream_chunk' || event.type === 'stream_end' ? [event.revision] : [])
      assert.ok(revisions.length >= 6)
      assert.ok(revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!))
      const durable = events.findIndex(event => event.type === 'session_event' && event.event.type === 'assistant/message')
      const end = events.findIndex(event => event.type === 'stream_end' && event.outcome === 'committed')
      assert.ok(durable >= 0 && end > durable)
      assert.deepEqual(provider.errors, [])
      assert.equal(events.some(event => event.type === 'error'), false)
    } finally {
      provider.release()
      await app.shutdown(); terminal.dispose(); await backend.close()
      await provider.close()
      if (previousKey === undefined) delete process.env[KEY_ENV]
      else process.env[KEY_ENV] = previousKey
      await rm(directory, { recursive: true, force: true })
    }
  })
}
