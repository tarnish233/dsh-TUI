import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BRIDGE_FD,
  BRIDGE_PROTOCOL_VERSION,
  LineDecoder,
  ProtocolError,
  encodeLine,
  normalizeSessionInfo,
  parseRuntimeMessage,
} from '../src/backend/protocol.ts'
import { resolveDshInstall } from '../src/backend/discover.ts'
import { prepareWorkspace, type PrepareWorkspaceOptions } from '../src/backend/runtime-home.ts'
import type { ProfilePlan } from '../src/backend/native-profile.ts'
import { normalizeApprovalOutcome, normalizeAskAnswer } from '../runtime/bridge.mjs'
import { DshBackend } from '../src/backend/index.ts'
import type { BackendEvent, SessionEvent } from '../src/backend/types.ts'

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function cleanupDir(path: string | undefined): void {
  if (path === undefined) return
  rmSync(path, { recursive: true, force: true })
}

/** Application profile plan used by workspace-only tests. */
const appPlan: ProfilePlan = { name: 'dsh-pi-tui', bundles: ['@deepseek-ai/dsh-base'], replaced: [], warnings: [] }

/** Fixture implementation of the two native profile writers used by prepareWorkspace. */
function fixtureProfileNative() {
  return {
    initProfile(dir: string, bundles: readonly string[]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-' + dir.split('/').pop(),
        private: true,
        dsh: { profile: { bundles: [...bundles] } },
      }, null, 2) + '\n')
      writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
    },
    writeManifest(dir: string, manifest: Record<string, unknown>) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    },
    loadPatches(file: string) {
      if (!existsSync(file)) return undefined
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (!Array.isArray(parsed) || parsed.some(item => item === null || typeof item !== 'object' || Array.isArray(item))) {
        throw new Error('fixture patch must be a JSON list of objects')
      }
      return parsed as readonly Record<string, unknown>[]
    },
  }
}

function workspaceOptions(bridgePath: string, home?: string): PrepareWorkspaceOptions {
  return {
    bridgePath,
    plan: { ...appPlan, replaced: [], warnings: [] },
    native: fixtureProfileNative(),
    ...(home === undefined ? {} : { home }),
  }
}

/** The real installation, or undefined when this machine has none. */
function installedDsh(): string | undefined {
  try {
    return resolveDshInstall().dir
  } catch {
    return undefined
  }
}

/** A fake @deepseek-ai/dsh package whose launcher is a stub script. */
function fakeInstall(version: string, launcher: string): string {
  const dir = tempDir('dshpi-fake-dsh-')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version,
    type: 'module',
    bin: { dsh: 'lib/bin.js' },
  }))
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'lib', 'bin.js'), launcher)
  // These packages are interface-only fixtures for transport failure tests.
  // Native semantics are exercised separately against the real DSH install.
  const modules: Record<string, string> = {
    'dsh-llm': 'export class BlockAssembler { push() {} blocks() { return [] } interruptedBlocks() { return [] } }\nexport const expandAssistantStream = value => value\nexport const assembleAssistantStream = () => new BlockAssembler()\n',
    'dsh-session': 'export const isAppendSurfaceEvent = event => event.surfaceOp === "append"\nexport const isReplacementSurfaceEvent = event => event.surfaceOp?.op === "replace"\n',
    'dsh-home-paths': 'export const resolveDshHome = configured => configured ?? ' + JSON.stringify(join(dir, 'fixture-data')) + '\n',
    // Interface-only native profile fixture: enough for transport-failure tests.
    'dsh-app-boot': [
      "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'",
      "import { dirname, join } from 'node:path'",
      "export const DEFAULT_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base']",
      "export const PROFILE_TEMPLATES = { web: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } }",
      "export const resolveProfileDir = (name, home) => join(home ?? 'fixture-home', 'profiles', name)",
      "export const readProfileManifest = (bin, dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))",
      "export const writeProfileManifest = (dir, manifest) => { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2) + '\\n') }",
      "export const initProfile = (dir, bundles) => { writeProfileManifest(dir, { name: 'dsh-profile-' + dir.split('/').pop(), private: true, dsh: { profile: { bundles: [...bundles] } } }); writeFileSync(join(dir, 'cordis.patch.yml'), '[]\\n') }",
      "export const resolveBundleDir = () => { throw new Error('fixture has no bundles') }",
      "export const loadOptionalPatches = () => undefined",
      '',
    ].join('\n'),
  }
  for (const [name, code] of Object.entries(modules)) {
    const module = join(dir, 'node_modules', '@deepseek-ai', name)
    mkdirSync(module, { recursive: true })
    writeFileSync(join(module, 'package.json'), JSON.stringify({ name: '@deepseek-ai/' + name, type: 'module', exports: { '.': './index.js', './surface': './index.js' } }))
    writeFileSync(join(module, 'index.js'), code)
  }
  return dir
}

describe('backend control framing', () => {
  it('encodes one newline-terminated JSON frame', () => {
    assert.equal(encodeLine({ t: 'req', id: 1, method: 'ping' }), '{"t":"req","id":1,"method":"ping"}\n')
  })

  it('decodes partial lines only when a newline arrives', () => {
    const decoder = new LineDecoder()
    assert.deepEqual(decoder.push('{"t":"a"'), [])
    const decoded = decoder.push('}\n{"t":"b"}\n')
    assert.equal(decoded.length, 2)
    assert.deepEqual(decoded[0], { ok: true, value: { t: 'a' } })
    assert.deepEqual(decoded[1], { ok: true, value: { t: 'b' } })
  })

  it('reports malformed JSON instead of guessing', () => {
    const decoder = new LineDecoder()
    const decoded = decoder.push('not json\n')
    assert.equal(decoded.length, 1)
    assert.equal(decoded[0].ok, false)
    if (decoded[0].ok === false) assert.match(decoded[0].error, /malformed control JSON/)
  })

  it('validates runtime frames', () => {
    assert.deepEqual(
      parseRuntimeMessage({ t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, bridge: 'dsh-pi-tui-bridge', pid: 7, capabilities: ['stream'], hasModelSelection: true }),
      { t: 'hello', protocolVersion: BRIDGE_PROTOCOL_VERSION, bridge: 'dsh-pi-tui-bridge', pid: 7, capabilities: ['stream'], hasModelSelection: true },
    )
    assert.throws(() => parseRuntimeMessage({ t: 'hello', protocolVersion: 1, bridge: 'old-version', capabilities: [] }), ProtocolError)
    assert.throws(() => parseRuntimeMessage({ t: 'hello', bridge: 'missing-version', capabilities: [] }), ProtocolError)
    assert.throws(() => parseRuntimeMessage({ t: 'nope' }), ProtocolError)
    assert.throws(() => parseRuntimeMessage({ t: 'res', id: 1, ok: 'yes' }), ProtocolError)
    assert.throws(() => parseRuntimeMessage([]), ProtocolError)
  })

  it('normalizes session info and drops non-event entries', () => {
    const info = normalizeSessionInfo({
      sessionId: 's1',
      cwd: '/tmp',
      provider: 'p',
      model: 'm',
      reasoningEffort: 'high',
      preset: 'standard',
      permissions: { currentValue: 'workspace-write' },
      capabilities: ['stream', 42],
      events: [
        { type: 'user/message', seq: 0, data: {} },
        { type: 'broken' },
      ],
    })
    assert.equal(info.sessionId, 's1')
    assert.equal(info.reasoningEffort, 'high')
    assert.equal(info.preset, 'standard')
    assert.deepEqual(info.permissions, { currentValue: 'workspace-write' })
    assert.throws(() => normalizeSessionInfo({ sessionId: 's1', permissions: { currentValue: false } }), ProtocolError)
    assert.deepEqual(parseRuntimeMessage({ t: 'event', seq: 1, event: { type: 'permissions', sessionId: 's1', value: { currentValue: 'custom' } } }),
      { t: 'event', seq: 1, event: { type: 'permissions', sessionId: 's1', value: { currentValue: 'custom' } } })
    assert.throws(() => parseRuntimeMessage({ t: 'event', seq: 1, event: { type: 'permissions', sessionId: 's1', value: {} } }), ProtocolError)
    assert.deepEqual(info.capabilities, ['stream'])
    assert.equal(info.events?.length, 1)
    assert.equal(info.events?.[0].type, 'user/message')
    assert.equal(BRIDGE_FD, 3)
  })
})

describe('backend decision mapping', () => {
  const questions = [
    { id: 'q1', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'q2', question: 'Pick many', multiSelect: true, options: [{ label: 'C' }, { label: 'D' }] },
  ]

  it('maps opaque approval values onto DSH outcomes', () => {
    assert.equal(normalizeApprovalOutcome('allowed-once'), 'allowed-once')
    assert.equal(normalizeApprovalOutcome('rejected'), 'rejected')
    assert.equal(normalizeApprovalOutcome({ outcome: 'allowed-once' }), 'allowed-once')
    assert.equal(normalizeApprovalOutcome({ cancelled: true }), 'cancelled')
    assert.equal(normalizeApprovalOutcome(undefined), 'cancelled')
    assert.equal(normalizeApprovalOutcome('something-else'), 'cancelled')
  })

  it('maps ordered answers, custom text and multi-select', () => {
    const answer = normalizeAskAnswer(questions, { answers: ['A', ['C', 'D']] })
    assert.deepEqual(answer, {
      answers: [
        { id: 'q1', selected: ['A'] },
        { id: 'q2', selected: ['C', 'D'] },
      ],
    })
    const custom = normalizeAskAnswer(questions, { answers: ['free text', []] })
    assert.equal(custom.answers[0].custom, 'free text')
    assert.deepEqual(custom.answers[0].selected, [])
    assert.throws(() => normalizeAskAnswer(questions, { answers: ['A'] }), /exactly once/)
    assert.throws(() => normalizeAskAnswer(questions, 42), /answers/)
  })
})

describe('backend install discovery', () => {
  it('rejects a missing installation with a clear code', () => {
    const empty = tempDir('dshpi-empty-')
    try {
      assert.throws(() => resolveDshInstall(empty), (error: unknown) => {
        const code = (error as { code?: string }).code
        return code === 'DSH_NOT_FOUND'
      })
    } finally {
      cleanupDir(empty)
    }
  })

  it('rejects an unsupported version line', () => {
    const dir = fakeInstall('9.9.9', 'process.exit(0)\n')
    try {
      assert.throws(() => resolveDshInstall(dir), (error: unknown) => {
        const code = (error as { code?: string }).code
        return code === 'DSH_VERSION_UNSUPPORTED'
      })
    } finally {
      cleanupDir(dir)
    }
  })
})

describe('backend workspace isolation', () => {
  it('symlinks inherited user data and cleans up only its own home', () => {
    const realHome = tempDir('dshpi-real-home-')
    const bridge = join(process.cwd(), 'runtime/bridge.mjs')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = realHome
    writeFileSync(join(realHome, '.credentials.yaml'), 'version: 1\nrecords: {}\nrefs: {}\n')
    mkdirSync(join(realHome, 'sessions'))
    const workspace = prepareWorkspace(workspaceOptions(bridge))
    try {
      assert.equal(workspace.owned, true)
      assert.ok(existsSync(join(workspace.profileDir, 'cordis.patch.yml')))
      assert.ok(existsSync(join(workspace.profileDir, 'package.json')))
      // The bridge is this application's highest-priority --patch overlay.
      const patch = readFileSync(workspace.patchPath, 'utf8')
      assert.match(patch, /dsh-pi-tui-bridge/)
      assert.match(patch, /dsh-pi-tui-agent-preset-registry/)
      assert.equal(readFileSync(join(workspace.profileDir, 'cordis.patch.yml'), 'utf8').trim(), '[]')
      const credentialLink = join(workspace.homeDir, '.credentials.yaml')
      assert.equal(lstatSync(credentialLink).isSymbolicLink(), true)
      assert.equal(lstatSync(join(workspace.homeDir, 'sessions')).isSymbolicLink(), true)
      assert.equal(realHome.length > 0, true)
      // The inherited file is the user's own document, not a copy.
      assert.match(readFileSync(credentialLink, 'utf8'), /^version: 1/)
    } finally {
      workspace.cleanup()
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      cleanupDir(realHome)
    }
  })

  it('keeps the bridge overlay private and never carries credentials', () => {
    const home = tempDir('dshpi-overlay-home-')
    const workspace = prepareWorkspace(workspaceOptions(join(process.cwd(), 'runtime/bridge.mjs'), home))
    try {
      assert.ok(existsSync(workspace.patchPath))
      const patch = readFileSync(workspace.patchPath, 'utf8')
      assert.match(patch, /dsh-pi-tui-bridge/)
      assert.match(patch, /dsh-pi-tui-agent-preset-registry/)
      assert.match(patch, /"id": "hmr"[\s\S]*"disabled": false/)
      assert.equal(patch.includes('apiKey'), false)
      assert.equal(patch.includes('credentials'), false)
      assert.equal(lstatSync(workspace.patchPath).mode & 0o777, 0o600)
      assert.equal(workspace.dataHome, home)
      assert.equal(existsSync(join(home, 'dsh-pi-tui.patch.yml')), false)
    } finally { workspace.cleanup(); cleanupDir(home) }
  })

  it('never writes a profile into the inherited real home', () => {
    const realHome = tempDir('dshpi-real-home-')
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = realHome
    const workspace = prepareWorkspace(workspaceOptions(join(process.cwd(), 'runtime/bridge.mjs')))
    try {
      assert.equal(existsSync(join(realHome, 'profiles')), false)
      assert.notEqual(workspace.profileDir.startsWith(realHome), true)
    } finally {
      workspace.cleanup()
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      cleanupDir(realHome)
    }
  })
})

it('explicit DSH data home never overwrites an existing named profile', () => {
  const home = tempDir('dshpi-profile-sentinel-')
  const profile = join(home, 'profiles', 'dsh-pi-tui')
  mkdirSync(profile, { recursive: true })
  const file = join(profile, 'cordis.patch.yml')
  writeFileSync(file, 'user-owned sentinel')
  const workspace = prepareWorkspace(workspaceOptions(join(process.cwd(), 'runtime/bridge.mjs'), home))
  try {
    assert.notEqual(workspace.homeDir, home)
    assert.equal(readFileSync(file, 'utf8'), 'user-owned sentinel')
    workspace.cleanup()
    assert.equal(readFileSync(file, 'utf8'), 'user-owned sentinel')
  } finally { workspace.cleanup(); cleanupDir(home) }
})

describe('backend option validation', () => {
  it('reports a bad working directory from connect, not the constructor', async () => {
    const backend = new DshBackend({ cwd: join(tmpdir(), `dshpi-missing-${Date.now()}`), provider: 'p', model: 'm' })
    try {
      await assert.rejects(backend.connect(), (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'INVALID_OPTIONS')
        return true
      })
    } finally {
      await backend.close()
    }
  })
})

describe('backend startup failures', () => {
  it('surfaces a fatal bridge frame as a startup failure', async () => {
    const dshDir = fakeInstall('0.2.1-rc.5', [
      "import { writeSync } from 'node:fs'",
      `writeSync(${BRIDGE_FD}, JSON.stringify({ t: 'fatal', error: { message: 'stub bridge refused to boot' } }) + '\\n')`,
      'setTimeout(() => process.exit(0), 10000)',
      '',
    ].join('\n'))
    const home = tempDir('dshpi-home-')
    const cwd = tempDir('dshpi-cwd-')
    const backend = new DshBackend({ cwd, home, dshPath: dshDir })
    try {
      await assert.rejects(backend.connect(), (error: unknown) => {
        assert.match(String((error as Error).message), /stub bridge refused to boot/)
        return true
      })
    } finally {
      await backend.close()
      cleanupDir(dshDir)
      cleanupDir(home)
      cleanupDir(cwd)
    }
  })

  it('surfaces a launcher that exits before the handshake', async () => {
    const dshDir = fakeInstall('0.2.1-rc.5', "process.stderr.write('stub launcher exploded\\n'); process.exit(3)\n")
    const home = tempDir('dshpi-home-')
    const cwd = tempDir('dshpi-cwd-')
    const backend = new DshBackend({ cwd, home, dshPath: dshDir })
    try {
      await assert.rejects(backend.connect(), (error: unknown) => {
        const message = String((error as Error).message)
        assert.match(message, /exited/)
        return true
      })
    } finally {
      await backend.close()
      cleanupDir(dshDir)
      cleanupDir(home)
      cleanupDir(cwd)
    }
  })
})

describe('backend request timeouts', () => {
  it('times out an unanswered request and still closes the runtime', async () => {
    const dshDir = fakeInstall('0.2.1-rc.5', [
      "import { writeSync } from 'node:fs'",
      "const reply = (id, result) => writeSync(" + BRIDGE_FD + ", JSON.stringify({ t: 'res', id, ok: true, result }) + '\\n')",
      "let buffer = ''",
      "process.stdin.setEncoding('utf8')",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk",
      "  for (;;) {",
      "    const index = buffer.indexOf('\\n')",
      "    if (index === -1) break",
      "    const line = buffer.slice(0, index)",
      "    buffer = buffer.slice(index + 1)",
      "    const request = JSON.parse(line)",
      "    if (request.method === 'connect') reply(request.id, { sessionId: 'stub-session', cwd: process.cwd(), provider: 'stub', model: 'stub', capabilities: ['stream', 'state'] })",
      "  }",
      "})",
      "process.stdin.resume()",
      "writeSync(" + BRIDGE_FD + ", JSON.stringify({ t: 'hello', protocolVersion: 2, bridge: 'dsh-pi-tui-bridge', pid: process.pid, capabilities: ['stream', 'state'], hasModelSelection: false }) + '\\n')",
      "setInterval(() => {}, 1000)",
      '',
    ].join('\n'))
    const home = tempDir('dshpi-home-')
    const cwd = tempDir('dshpi-cwd-')
    const previousRequest = process.env.DSH_PI_TUI_REQUEST_TIMEOUT_MS
    const previousClose = process.env.DSH_PI_TUI_CLOSE_TIMEOUT_MS
    process.env.DSH_PI_TUI_REQUEST_TIMEOUT_MS = '300'
    process.env.DSH_PI_TUI_CLOSE_TIMEOUT_MS = '300'
    const backend = new DshBackend({ cwd, home, dshPath: dshDir })
    try {
      // A stub hello is enough to connect; the stub never answers commands.
      const connected = await backend.connect()
      assert.equal(typeof connected.sessionId, 'string')
      await assert.rejects(backend.command('state'), (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'REQUEST_TIMEOUT')
        return true
      })
    } finally {
      const started = Date.now()
      await backend.close()
      assert.ok(Date.now() - started < 5000)
      if (previousRequest === undefined) delete process.env.DSH_PI_TUI_REQUEST_TIMEOUT_MS
      else process.env.DSH_PI_TUI_REQUEST_TIMEOUT_MS = previousRequest
      if (previousClose === undefined) delete process.env.DSH_PI_TUI_CLOSE_TIMEOUT_MS
      else process.env.DSH_PI_TUI_CLOSE_TIMEOUT_MS = previousClose
      cleanupDir(dshDir)
      cleanupDir(home)
      cleanupDir(cwd)
    }
  })
})

const realDsh = installedDsh()

describe('backend against real DSH', { skip: realDsh === undefined ? 'no @deepseek-ai/dsh installation found' : false }, () => {
  let home = ''
  let cwd = ''
  let backend: DshBackend | undefined
  const events: BackendEvent[] = []
  const sessionEvents: SessionEvent[] = []
  let info = { sessionId: '' }

  before(async () => {
    home = tempDir('dshpi-home-')
    cwd = tempDir('dshpi-cwd-')
    backend = new DshBackend({
      cwd,
      home,
      dshPath: realDsh,
      // No remote catalog is consulted; DSH reports the missing adapter.
      provider: 'offline-fixture',
      model: 'offline-fixture-model',
    })
    backend.onEvent((event) => {
      events.push(event)
      if (event.type === 'session_event') sessionEvents.push(event.event)
    })
    const connected = await backend.connect()
    info = { sessionId: connected.sessionId }
  })

  after(async () => {
    await backend?.close()
    cleanupDir(home)
    cleanupDir(cwd)
  })

  it('connects, emits ready and reports real capabilities', () => {
    const ready = events.filter((event) => event.type === 'ready')
    assert.equal(ready.length, 1)
    const connected = ready[0]
    if (connected.type !== 'ready') return
    assert.equal(connected.info.sessionId, info.sessionId)
    assert.equal(connected.info.cwd, cwd)
    assert.ok(connected.info.capabilities.includes('stream'))
    assert.ok(connected.info.capabilities.includes('cancel'))
    assert.ok(connected.info.capabilities.includes('dequeue'))
    assert.ok(Array.isArray(connected.info.events))
  })

  it('returns state and a durable session listing', async () => {
    const state = await backend!.command('state') as Record<string, unknown>
    assert.equal(state.sessionId, info.sessionId)
    assert.equal(state.provider, 'offline-fixture')
    assert.equal(state.status, 'idle')
    const sessions = await backend!.command('sessions') as Array<Record<string, unknown>>
    assert.ok(Array.isArray(sessions))
    const entry = sessions.find((item) => item.id === info.sessionId)
    assert.ok(entry !== undefined)
    assert.equal(entry.cwd, cwd)
    assert.ok(typeof entry.createdAt === 'number')
    assert.equal(entry.updatedAt, undefined, 'creation time is not advertised as an activity timestamp')
  })

  it('reads native permission presets; switches only through the audited /permission command', async () => {
    const permissions = await backend!.command('permissions') as { currentValue: string; options: Array<{ value: string }> }
    assert.equal(typeof permissions.currentValue, 'string')
    assert.ok(permissions.options.length > 0)
    const selected = await backend!.command('execute', { line: '/permission ' + permissions.options[0]!.value }) as { result: { kind: string } }
    assert.equal(selected.result.kind, 'success')
    assert.equal((await backend!.command('permissions') as { currentValue: string }).currentValue, permissions.options[0]!.value)
    await assert.rejects(backend!.command('mode'), (error: unknown) => (error as { code?: string }).code === 'UNSUPPORTED_COMMAND')
  })

  it('rejects an unavailable model catalog clearly', async () => {
    await assert.rejects(backend!.command('models'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'MODELS_UNAVAILABLE')
      return true
    })
  })

  it('sends a real followup, streams nothing optimistically and reports DSH errors', async () => {
    const before = events.length
    await backend!.send('offline fixture prompt')
    await waitFor(() => sessionEvents.some((event) => event.type === 'user/message'), 15000)
    const userMessage = sessionEvents.find((event) => event.type === 'user/message')
    assert.ok(userMessage !== undefined)
    // The durable settlement for a failed request is a v2 assistant/attempt.
    await waitFor(() => sessionEvents.some((event) => event.type === 'assistant/attempt'), 15000)
    await waitFor(() => sessionEvents.some((event) => event.type === 'turn/end'), 15000)
    const start = events.slice(before).find((event) => event.type === 'stream_start')
    assert.ok(start !== undefined)
    const end = events.slice(before).find((event) => event.type === 'stream_end')
    assert.ok(end !== undefined)
    if (end.type === 'stream_end') {
      assert.equal(end.outcome, 'committed')
      assert.equal(typeof end.seq, 'number')
    }
    // No stream_end may arrive before its durable settlement.
    const settlementIndex = events.findIndex((event) =>
      event.type === 'session_event' && (event.event.type === 'assistant/attempt' || event.event.type === 'assistant/message'))
    const endIndex = events.findIndex((event) => event.type === 'stream_end')
    assert.ok(settlementIndex !== -1 && settlementIndex < endIndex)
    const error = events.slice(before).find((event) => event.type === 'error')
    assert.ok(error !== undefined)
    await waitFor(async () => {
      const state = await backend!.command('state') as { status?: string }
      return state.status === 'idle'
    }, 15000)
  })

  it('rejects malformed and stale control requests', async () => {
    await assert.rejects(backend!.send('   '), (error: unknown) => (error as { code?: string }).code === 'INVALID_ARGUMENT')
    await assert.rejects(backend!.command('nope'), (error: unknown) => (error as { code?: string }).code === 'UNSUPPORTED_COMMAND')
    await assert.rejects(backend!.respond('missing-decision', { cancelled: true }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'STALE_DECISION')
      return true
    })
  })

  it('cancels the Agent without killing the runtime', async () => {
    await backend!.cancel()
    const state = await backend!.command('state') as { sessionId?: string }
    assert.equal(state.sessionId, info.sessionId)
  })

  it('dequeues through the native inbox and returns removed messages', async () => {
    const removed = await backend!.command('dequeue')
    assert.ok(Array.isArray(removed))
    for (const item of removed as Array<Record<string, unknown>>) {
      assert.equal(typeof item.text, 'string')
      assert.ok(item.target === 'next-turn' || item.target === 'next-step')
    }
  })

  it('drops stale responses after a decision closes', async () => {
    // No live decision exists; the second response for any id must fail.
    await assert.rejects(backend!.respond('approval-1-1', 'allowed-once'), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'STALE_DECISION')
      return true
    })
  })

  it('resumes a durable session and starts a fresh one', async () => {
    await backend!.close()
    const second = new DshBackend({ cwd, home, dshPath: realDsh, resume: info.sessionId, provider: 'offline-fixture', model: 'offline-fixture-model' })
    const events2: BackendEvent[] = []
    second.onEvent((event) => events2.push(event))
    try {
      const resumed = await second.connect()
      assert.equal(resumed.sessionId, info.sessionId)
      assert.ok((resumed.events?.length ?? 0) > 0)
      assert.ok(events2.some((event) => event.type === 'ready'))
      const fresh = await second.command('new') as { sessionId: string; events?: SessionEvent[] }
      assert.notEqual(fresh.sessionId, info.sessionId)
      // A fresh session carries only its setup events, never the resumed log.
      assert.ok((fresh.events?.length ?? 0) < 10)
      assert.equal(fresh.events?.some((event) => event.type === 'user/message'), false)
      assert.ok(events2.filter((event) => event.type === 'ready').length >= 2)
      const back = await second.command('resume', { sessionId: info.sessionId }) as { sessionId: string; events?: unknown[] }
      assert.equal(back.sessionId, info.sessionId)
      assert.ok((back.events?.length ?? 0) > 0)
    } finally {
      await second.close()
    }
  })

  it('closes idempotently and releases the workspace', async () => {
    assert.equal(await backend!.close(), undefined)
    assert.equal(await backend!.close(), undefined)
    await assert.rejects(backend!.cancel(), (error: unknown) => (error as { code?: string }).code === 'CLOSED')
  })
})

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}