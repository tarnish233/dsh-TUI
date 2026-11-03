import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before } from 'node:test'
import { App } from '../src/app.ts'
import { DshBackend } from '../src/backend/index.ts'
import type { BackendEvent, JsonRecord } from '../src/backend/types.ts'
import { VirtualTerminal, delay, until } from './helpers/terminal.ts'

/**
 * End-to-end native configuration coverage.
 *
 * Everything below the TUI is real DSH: a temporary DSH home holds a real
 * profile whose own `cordis.patch.yml` configures the mounted `dsh-llm-pi-ai`
 * adapter (provider routes, protocol, endpoint, credential references,
 * gateway headers) and `agent-default-model`. The launcher composes the native
 * layers and the real pi-ai transports (Anthropic Messages, OpenAI Chat
 * Completions, OpenAI Responses) serialize the request, parse SSE and stream
 * into the App.
 *
 * Only the HTTP peer is local: one loopback server whose stream finish stays
 * held on a promise until the ANSI terminal proves the model prefix is already
 * painted while the session is still busy. An implementation that buffers the
 * whole answer (or replays it at the end) cannot satisfy that.
 *
 * Credentials are fake environment references; the profile stores only the
 * reference name, exactly as a configured DSH route does.
 */

const PREFIX = 'native-live 中文 '
const SUFFIX = '🚀 settled'
const SETTLED = PREFIX + SUFFIX

const MESSAGES_MODEL = 'local-messages-test'
const GPT_MODEL = 'local-gpt-test'
const CHAT_MODEL = 'local-chat-test'

const MESSAGES_PROVIDER = 'cloudagent'
const GPT_PROVIDER = 'cloudagent-gpt'
const CHAT_PROVIDER = 'cloudagent-chat'

/** Fake, non-functional credentials. Never a real key, never written to a profile. */
const MESSAGES_KEY = 'fake-native-messages-key-not-a-credential'
const GPT_KEY = 'fake-native-gpt-key-not-a-credential'
const CHAT_KEY = 'fake-native-chat-key-not-a-credential'
/** Fake configured gateway header value (profiles may carry non-secret deployment headers). */
const BEARER_VALUE = 'Bearer fake-native-bearer-not-a-credential'

const MESSAGES_KEY_ENV = 'DSH_TUI_TEST_MESSAGES_KEY'
const GPT_KEY_ENV = 'DSH_TUI_TEST_GPT_KEY'
const CHAT_KEY_ENV = 'DSH_TUI_TEST_CHAT_KEY'

const PROFILE = 'native-fixtures'

const ROUTES = {
  messages: '/anthropic/v1/messages',
  responses: '/openai/v1/responses',
  chat: '/go/v1/chat/completions',
} as const

type RouteName = keyof typeof ROUTES

interface Probe {
  path: string
  search: string
  method: string
  apiKey?: string
  authorization?: string
  body: Record<string, unknown>
  /** Set only once the server actually wrote the final bytes of that stream. */
  finishedAt?: number
}

interface SseScript {
  opening: Array<[string, unknown]>
  closing: Array<[string, unknown]>
}

const probes: Probe[] = []
const serverErrors: string[] = []
const holds = new Map<string, () => void>()
const preReleased = new Set<string>()
let origin = ''

function holdRoute(path: string): Promise<void> {
  if (preReleased.delete(path)) return Promise.resolve()
  return new Promise<void>(resolve => {
    holds.set(path, () => {
      holds.delete(path)
      resolve()
    })
  })
}

/** Release the server-side finish. Before a request arrives the release is remembered. */
function releaseRoute(path: string): void {
  preReleased.add(path)
  const hold = holds.get(path)
  if (hold !== undefined) hold()
}

function headerText(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && typeof value[0] === 'string') return value[0]
  return undefined
}

function chatChunk(delta: Record<string, unknown>, finish: string | null): unknown {
  return {
    object: 'chat.completion.chunk',
    id: 'chatcmpl-native-chat',
    created: 1_700_000_000,
    model: CHAT_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }
}

function gptItem(text: string, status: string): unknown {
  return {
    id: 'msg-native-gpt',
    type: 'message',
    role: 'assistant',
    status,
    content: text.length === 0 ? [] : [{ type: 'output_text', text, annotations: [] }],
  }
}

function script(route: RouteName): SseScript {
  if (route === 'messages') {
    return {
      opening: [
        ['message_start', {
          type: 'message_start',
          message: {
            id: 'msg-native-messages', type: 'message', role: 'assistant', model: MESSAGES_MODEL,
            content: [], usage: { input_tokens: 11, output_tokens: 0 },
          },
        }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: PREFIX } }],
      ],
      closing: [
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: SUFFIX } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } }],
        ['message_stop', { type: 'message_stop' }],
      ],
    }
  }
  if (route === 'responses') {
    return {
      opening: [
        ['response.created', {
          type: 'response.created',
          response: { id: 'resp-native-gpt', object: 'response', status: 'in_progress', model: GPT_MODEL, output: [] },
        }],
        ['response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 0,
          item: { id: 'msg-native-gpt', type: 'message', role: 'assistant', status: 'in_progress', content: [] },
        }],
        ['response.content_part.added', {
          type: 'response.content_part.added', item_id: 'msg-native-gpt', output_index: 0, content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        }],
        ['response.output_text.delta', {
          type: 'response.output_text.delta', item_id: 'msg-native-gpt', output_index: 0, content_index: 0, delta: PREFIX,
        }],
      ],
      closing: [
        ['response.output_text.delta', {
          type: 'response.output_text.delta', item_id: 'msg-native-gpt', output_index: 0, content_index: 0, delta: SUFFIX,
        }],
        ['response.output_text.done', {
          type: 'response.output_text.done', item_id: 'msg-native-gpt', output_index: 0, content_index: 0, text: SETTLED,
        }],
        ['response.content_part.done', {
          type: 'response.content_part.done', item_id: 'msg-native-gpt', output_index: 0, content_index: 0,
          part: { type: 'output_text', text: SETTLED, annotations: [] },
        }],
        ['response.output_item.done', {
          type: 'response.output_item.done', output_index: 0, item: gptItem(SETTLED, 'completed'),
        }],
        ['response.completed', {
          type: 'response.completed',
          response: {
            id: 'resp-native-gpt', object: 'response', status: 'completed', model: GPT_MODEL,
            output: [gptItem(SETTLED, 'completed')],
            usage: {
              input_tokens: 12, output_tokens: 8, total_tokens: 20,
              input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        }],
      ],
    }
  }
  return {
    opening: [['chat.completion.chunk', chatChunk({ role: 'assistant', content: PREFIX }, null)]],
    closing: [
      ['chat.completion.chunk', chatChunk({ content: SUFFIX }, null)],
      ['chat.completion.chunk', chatChunk({}, 'stop')],
      ['done', '[DONE]'],
    ],
  }
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  // The native Anthropic transport requests `/v1/messages?beta=true`, so compare pathnames.
  const url = new URL(request.url ?? '/', 'http://127.0.0.1')
  const path = url.pathname
  const route = (Object.keys(ROUTES) as RouteName[]).find(name => ROUTES[name] === path)
  if (request.method !== 'POST' || route === undefined) {
    serverErrors.push(`unexpected provider request: ${request.method} ${request.url}`)
    response.writeHead(404)
    response.end()
    return
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    bytes += buffer.length
    if (bytes > 2 * 1024 * 1024) throw new Error('test request exceeded 2 MiB')
    chunks.push(buffer)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), 'provider body is an object')
  const probe: Probe = {
    path,
    search: url.search,
    method: request.method,
    apiKey: headerText(request.headers['x-api-key']),
    authorization: headerText(request.headers.authorization),
    body: parsed as Record<string, unknown>,
  }
  probes.push(probe)
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const emit = ([type, payload]: [string, unknown]): void => {
    response.write(`event: ${type}\ndata: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`)
  }
  const events = script(route)
  for (const event of events.opening) emit(event)
  // The finish is not a timer: it waits for the test's explicit release.
  await holdRoute(path)
  if (response.destroyed) return
  for (const event of events.closing) emit(event)
  probe.finishedAt = performance.now()
  response.end()
}

const server = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    serverErrors.push(error instanceof Error ? error.message : String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end()
  })
})

before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object', 'loopback provider bound to a port')
  origin = `http://127.0.0.1:${address.port}`
})

after(async () => {
  for (const hold of [...holds.values()]) hold()
  holds.clear()
  await new Promise<void>(resolve => {
    server.closeAllConnections()
    server.close(() => resolve())
  })
})

/** Native `llm-pi-ai` routes exactly as a configured DSH profile declares them. */
function providerRoutes(): JsonRecord {
  return {
    [MESSAGES_PROVIDER]: {
      displayName: 'CloudAgent (Messages)',
      api: 'anthropic-messages',
      baseURL: `${origin}/anthropic`,
      apiKeyEnv: MESSAGES_KEY_ENV,
      // Deployment gateway header carried by native profile configuration; the
      // TUI owns no request header shim.
      headers: { Authorization: BEARER_VALUE },
      models: [{ id: MESSAGES_MODEL, name: 'Local Messages', contextWindow: 100_000, maxTokens: 4096 }],
    },
    [GPT_PROVIDER]: {
      displayName: 'CloudAgent (Responses)',
      api: 'openai-responses',
      baseURL: `${origin}/openai/v1`,
      apiKeyEnv: GPT_KEY_ENV,
      models: [{ id: GPT_MODEL, name: 'Local GPT', contextWindow: 100_000, maxTokens: 4096 }],
    },
    [CHAT_PROVIDER]: {
      displayName: 'Custom Chat',
      api: 'openai-completions',
      baseURL: `${origin}/go/v1`,
      apiKeyEnv: CHAT_KEY_ENV,
      compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
      models: [{ id: CHAT_MODEL, name: 'Local Chat', contextWindow: 100_000, maxTokens: 4096 }],
    },
  }
}

/** One native profile patch: provider routes plus the profile's default model. */
function profilePatch(defaultProvider: string, defaultModel: string): JsonRecord[] {
  return [
    { id: 'llm-pi-ai', config: { providers: providerRoutes() } },
    { id: 'agent-default-model', config: { provider: defaultProvider, model: defaultModel } },
  ]
}

async function writeProfile(home: string, patch: readonly JsonRecord[]): Promise<void> {
  const dir = join(home, 'profiles', PROFILE)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${PROFILE}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2) + '\n')
  await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify(patch, null, 2) + '\n', { mode: 0o600 })
}

interface CaseSpec {
  route: RouteName
  provider: string
  model: string
  /** Selected native profile default model; absent uses explicit provider/model. */
  expectDefault?: boolean
  /** Home-level native layer that overrides the profile's default model. */
  homeDefault?: { provider: string; model: string }
}

/**
 * One hermetic run: temp DSH home with a real native profile, temp cwd, temp
 * TUI config, fake credential environment, real DSH child, real App.
 */
async function runNativeCase(spec: CaseSpec): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-profile-stream-'))
  const home = join(directory, 'home')
  const cwd = join(directory, 'workspace')
  const configDir = join(directory, 'tui')
  await mkdir(home, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await mkdir(configDir, { recursive: true })

  // The profile chooses its own default route; the home patch may override it,
  // and DSH's native precedence (home after profile) must decide.
  await writeProfile(home, profilePatch(
    spec.homeDefault === undefined ? spec.provider : CHAT_PROVIDER,
    spec.homeDefault === undefined ? spec.model : CHAT_MODEL,
  ))
  if (spec.homeDefault !== undefined) {
    await writeFile(join(home, 'cordis.patch.yml'), JSON.stringify([
      { id: 'agent-default-model', config: { provider: spec.homeDefault.provider, model: spec.homeDefault.model } },
    ], null, 2) + '\n', { mode: 0o600 })
  }

  const previousKeys = new Map<string, string | undefined>()
  const setKey = (name: string, value: string): void => {
    previousKeys.set(name, process.env[name])
    process.env[name] = value
  }
  setKey(MESSAGES_KEY_ENV, MESSAGES_KEY)
  setKey(GPT_KEY_ENV, GPT_KEY)
  setKey(CHAT_KEY_ENV, CHAT_KEY)

  const backend = new DshBackend({
    cwd,
    home,
    profile: PROFILE,
    ...(spec.expectDefault === true ? {} : { provider: spec.provider, model: spec.model }),
  })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  const terminal = new VirtualTerminal(100, 32)
  const app = new App({ backend, cwd, configDir, terminal, screen: 'fullscreen', registerSignals: false })
  const routePath = ROUTES[spec.route]
  // Each case owns exactly one held finish for its route.
  preReleased.delete(routePath)
  const errorBase = serverErrors.length
  const probeBase = probes.length
  let released = false
  try {
    await app.start()
    assert.ok(app.session, 'DSH connects against the native profile route without a real credential')
    assert.equal(app.session.provider, spec.provider)
    assert.equal(app.session.model, spec.model)
    events.length = 0

    await app.submit('Reply with the requested text only. Do not use tools.')

    // 1. The prefix must be painted from real SSE before the server is allowed to finish.
    await until(
      () => terminal.document().includes(PREFIX),
      'native provider prefix is visible while the server still holds its finish',
      20_000,
    ).catch(error => {
      const failures = events.flatMap(event => event.type === 'error' ? [event.message] : [])
      throw new Error(String(error) + (failures.length > 0 ? ': ' + failures.join('; ') : ''))
    })
    await terminal.flush()
    const caseProbes = probes.slice(probeBase)
    const probe = caseProbes.find(item => item.path === routePath)
    assert.ok(probe, 'the configured route received exactly the expected endpoint request')
    assert.equal(caseProbes.filter(item => item.path === routePath).length, 1)
    assert.equal(probe.method, 'POST')
    assert.equal(probe.finishedAt, undefined, 'the HTTP finish is still held by the test')
    assert.equal(app.isBusy, true, 'the session is still streaming when the prefix is visible')

    // 2. Prefix-only content: no settle/duplicate, no durable assistant message yet.
    assert.match(terminal.document(), /native-live 中文/)
    assert.doesNotMatch(terminal.document(), /🚀 settled/)
    assert.equal(
      events.some(event => event.type === 'session_event' && event.event.type === 'assistant/message'),
      false,
      'no durable assistant message exists before the provider finishes',
    )
    const live = app.store.items.find(item => item.kind === 'attempt')
    assert.ok(live?.kind === 'attempt' && live.text === PREFIX, 'the live attempt holds exactly the streamed prefix')

    // 3. The editor stays editable while the stream is open.
    terminal.type('draft while native stream is open')
    await delay(25)
    await terminal.flush()
    assert.equal(app.editor.getText(), 'draft while native stream is open')
    assert.equal(app.isBusy, true)
    assert.equal(probe.finishedAt, undefined, 'typing did not release the provider finish')

    // 4. Only now may the server send its suffix and terminal events.
    released = true
    releaseRoute(routePath)
    await until(
      () => events.some(event => event.type === 'status' && event.status === 'idle'),
      'the native stream settles',
      20_000,
    )
    await delay(25)
    await terminal.flush()
    assert.ok(probe.finishedAt !== undefined, 'the provider wrote its finish after the release')

    // 5. One settled assistant message, one contiguous answer, no duplication.
    const document = terminal.document()
    assert.ok(document.includes(SETTLED), 'the settled answer is rendered contiguously')
    assert.equal((document.match(/native-live/g) ?? []).length, 1, 'the prefix is painted exactly once')
    assert.equal(app.store.items.filter(item => item.kind === 'assistant').length, 1)
    assert.equal(app.store.hasLiveAttempt, false)
    assert.equal(app.editor.getText(), 'draft while native stream is open', 'the draft survived settlement')
    assert.equal(app.isBusy, false)

    // 6. Strictly increasing DSH stream revisions, settlement ordered after durability.
    const revisions = events.flatMap(event =>
      event.type === 'stream_start' || event.type === 'stream_chunk' || event.type === 'stream_end' ? [event.revision] : [])
    assert.ok(revisions.length >= 6, 'the real auxiliary stream published multiple frames')
    assert.ok(revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!))
    const durable = events.findIndex(event => event.type === 'session_event' && event.event.type === 'assistant/message')
    const end = events.findIndex(event => event.type === 'stream_end' && event.outcome === 'committed')
    assert.ok(durable >= 0, 'the durable assistant message arrived')
    assert.ok(end > durable, 'the committed stream end follows the durable message')
    assert.equal(events.some(event => event.type === 'error'), false)
    for (const secret of [MESSAGES_KEY, GPT_KEY, CHAT_KEY]) {
      assert.equal(JSON.stringify(events).includes(secret), false, 'credentials never enter protocol or durable session events')
    }
    assert.deepEqual(serverErrors.slice(errorBase), [])

    // 7. Route, protocol and native configuration actually reached the wire.
    if (spec.route === 'messages') {
      assert.equal(probe.apiKey, MESSAGES_KEY, 'Anthropic Messages keeps its native SDK x-api-key credential')
      assert.equal(probe.authorization, BEARER_VALUE, 'the profile-configured gateway header reached the request')
      assert.equal(probe.body.model, MESSAGES_MODEL)
      assert.equal(probe.body.stream, true)
      assert.equal(typeof probe.body.max_tokens, 'number')
      assert.ok((probe.body.max_tokens as number) > 0)
    } else if (spec.route === 'responses') {
      assert.equal(probe.authorization, `Bearer ${GPT_KEY}`, 'OpenAI Responses authenticates with the native credential reference')
      assert.equal(probe.authorization?.includes(','), false, 'no duplicated Authorization header')
      assert.equal(probe.apiKey, undefined)
      assert.equal(probe.body.model, GPT_MODEL)
      assert.equal(probe.body.stream, true)
      const input = probe.body.input
      assert.ok(Array.isArray(input) && input.length > 0, 'Responses sends an input transcript')
      assert.ok(input.some(item => (item as { role?: unknown }).role === 'system'), 'the system instruction keeps the system role')
    } else {
      assert.equal(probe.authorization, `Bearer ${CHAT_KEY}`, 'Chat Completions authenticates with the native credential reference')
      assert.equal(probe.apiKey, undefined)
      assert.equal(probe.body.model, CHAT_MODEL)
      assert.equal(probe.body.stream, true)
      // Native route compat: no store field, no developer role, max_tokens spelling.
      assert.equal('store' in probe.body, false)
      assert.equal('max_completion_tokens' in probe.body, false)
      assert.equal(probe.body.max_tokens, 4096, 'the profile model maxTokens reached the request')
      const messages = probe.body.messages
      assert.ok(Array.isArray(messages) && messages.length > 0, 'chat completions sends messages')
      assert.equal(JSON.stringify(messages).includes('"developer"'), false, 'no developer role is used')
      assert.ok(JSON.stringify(messages).includes('"system"'), 'the system instruction keeps the system role')
    }

    await app.shutdown()
    assert.equal(terminal.stopped, true, 'the terminal is released on shutdown')
  } finally {
    if (!released) releaseRoute(routePath)
    await app.shutdown().catch(() => {})
    terminal.dispose()
    await backend.close().catch(() => {})
    for (const [name, value] of previousKeys) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(directory, { recursive: true, force: true })
  }
}

test('native Anthropic Messages route streams incrementally over real SSE', { timeout: 180_000 }, async () => {
  await runNativeCase({ route: 'messages', provider: MESSAGES_PROVIDER, model: MESSAGES_MODEL })
})

test('native OpenAI Responses route streams incrementally over real SSE', { timeout: 180_000 }, async () => {
  await runNativeCase({ route: 'responses', provider: GPT_PROVIDER, model: GPT_MODEL })
})

test('native Chat Completions route streams incrementally over real SSE', { timeout: 180_000 }, async () => {
  await runNativeCase({ route: 'chat', provider: CHAT_PROVIDER, model: CHAT_MODEL })
})

test('the selected profile\'s native default model is honored without CLI overrides', { timeout: 180_000 }, async () => {
  await runNativeCase({ route: 'messages', provider: MESSAGES_PROVIDER, model: MESSAGES_MODEL, expectDefault: true })
})

test('the home patch outranks the selected profile default model (native precedence)', { timeout: 180_000 }, async () => {
  await runNativeCase({
    route: 'messages',
    provider: MESSAGES_PROVIDER,
    model: MESSAGES_MODEL,
    expectDefault: true,
    homeDefault: { provider: MESSAGES_PROVIDER, model: MESSAGES_MODEL },
  })
})

test('removed Pi catalog environment pointers never feed the native catalog', { timeout: 180_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-no-pi-'))
  const home = join(directory, 'home')
  const cwd = join(directory, 'workspace')
  await mkdir(home, { recursive: true })
  await mkdir(cwd, { recursive: true })
  await writeProfile(home, profilePatch(MESSAGES_PROVIDER, MESSAGES_MODEL))
  const piDir = join(directory, 'pi')
  await mkdir(piDir, { recursive: true })
  const piCatalog = join(piDir, 'models.json')
  await writeFile(piCatalog, JSON.stringify({
    providers: { 'pi-only-route': { api: 'openai-completions', baseUrl: `${origin}/pi`, apiKey: 'fake-pi-key', models: [{ id: 'pi-only-model' }] } },
  }), { mode: 0o600 })
  const previous = new Map<string, string | undefined>()
  for (const [name, value] of [
    ['DSH_PI_TUI_MODELS_FILE', piCatalog],
    ['DSH_PI_TUI_IMPORT_MODELS', '1'],
    [MESSAGES_KEY_ENV, MESSAGES_KEY],
  ] as const) {
    previous.set(name, process.env[name])
    process.env[name] = value
  }
  const backend = new DshBackend({ cwd, home, profile: PROFILE, provider: MESSAGES_PROVIDER, model: MESSAGES_MODEL })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  try {
    const info = await backend.connect()
    assert.equal(info.provider, MESSAGES_PROVIDER)
    const models = await backend.command('models') as Array<{ id: string }>
    assert.ok(models.some(item => item.id === `${MESSAGES_PROVIDER}/${MESSAGES_MODEL}`), 'native route is catalogued')
    assert.equal(models.some(item => item.id.startsWith('pi-only-route/')), false, 'the Pi catalog was never imported')
    const warnings = events.flatMap(event => event.type === 'warning' ? [event.message] : [])
    assert.ok(warnings.some(message => /DSH_PI_TUI_MODELS_FILE/.test(message) && /no longer read/.test(message)), JSON.stringify(warnings))
    assert.equal(JSON.stringify(events).includes('fake-pi-key'), false)
  } finally {
    await backend.close().catch(() => {})
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(directory, { recursive: true, force: true })
  }
})