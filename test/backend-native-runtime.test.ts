import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { App } from '../src/app.ts'
import { DshBackend } from '../src/backend/client.ts'
import { resolveDshInstall } from '../src/backend/discover.ts'
import type { BackendEvent, JsonRecord, SessionEvent, SessionInfo } from '../src/backend/types.ts'
import { ToolPresentation } from '../runtime/bridge.mjs'
import { VirtualTerminal, until } from './helpers/terminal.ts'

const object = (value: unknown): JsonRecord => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {}
const sessionEvents = (events: BackendEvent[]): SessionEvent[] => events.flatMap(event => event.type === 'session_event' ? [event.event] : [])
let nativePath: string | undefined
try { nativePath = resolveDshInstall().dir } catch { /* native-only tests skip without an installation */ }

async function fixture(withApp = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-boundary-'))
  const cwd = join(directory, 'workspace'), home = join(directory, 'home')
  await mkdir(cwd); await mkdir(home)
  const plugin = pathToFileURL(fileURLToPath(new URL('./fixtures/mock-stream.mjs', import.meta.url))).href
  await writeFile(join(home, 'cordis.patch.yml'), '- insert:\n    - id: native-boundary-fixture\n      name: ' + JSON.stringify(plugin) + '\n')
  const backend = new DshBackend({ cwd, home, dshPath: nativePath, provider: 'deepseek-official', model: 'deepseek-flash' })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  const info = await backend.connect()
  const terminal = withApp ? new VirtualTerminal(100, 35) : undefined
  const app = terminal ? new App({ backend, cwd, configDir: join(directory, 'tui'), terminal, screen: 'fullscreen', registerSignals: false }) : undefined
  if (app) await app.start()
  return { directory, cwd, backend, events, info, terminal, app, async close() {
    if (app) await app.shutdown(); else await backend.close()
    terminal?.dispose()
    await rm(directory, { recursive: true, force: true })
  } }
}

function execution(value: unknown) {
  const body = object(value), result = object(body.result)
  assert.equal(typeof body.commandId, 'string')
  assert.ok(result.kind === 'success' || result.kind === 'error')
  return { id: body.commandId as string, result }
}

function auditPair(events: BackendEvent[], id: string) {
  const relevant = sessionEvents(events).filter(event => object(event.data).commandId === id)
  assert.deepEqual(relevant.map(event => event.type), ['command/run', 'command/done'])
  assert.ok(relevant[0]!.seq < relevant[1]!.seq)
  return relevant
}

test('native /compact owns argument validation, structured outcomes and paired command audit', { skip: !nativePath }, async () => {
  const f = await fixture()
  try {
    const commands = await f.backend.command('commands') as JsonRecord[]
    assert.ok(commands.some(command => command.name === 'compact'))
    assert.ok(commands.some(command => command.name === 'goal'))
    const rawLine = '/compact \t unexpected  '
    const invalid = execution(await f.backend.command('execute', { line: rawLine }))
    assert.equal(invalid.result.kind, 'error')
    assert.match(String(invalid.result.text), /compact|usage/i)
    const pair = auditPair(f.events, invalid.id)
    assert.ok(String(object(pair[0]!.data).args).includes('\t'), 'native audit retains original whitespace')
    assert.equal(sessionEvents(f.events).some(event => event.type.startsWith('compaction/')), false, 'invalid arguments never reach compaction')

    const noHistory = execution(await f.backend.command('execute', { line: '/compact' }))
    assert.equal(noHistory.result.kind, 'success')
    assert.match(String(noHistory.result.text), /no compact|no.*history/i)
    auditPair(f.events, noHistory.id)
    const compatibility = execution(await f.backend.command('compact', { id: 'unexpected' }))
    assert.equal(compatibility.result.kind, 'error', 'compatibility alias does not discard arguments')
    auditPair(f.events, compatibility.id)
    assert.equal(f.events.some(event => event.type === 'stream_start'), false, 'no-history/invalid compact never calls a model')
    execution(await f.backend.command('execute', { line: '/fixture-title' }))
    const sessions = await f.backend.command('sessions') as JsonRecord[]
    assert.equal(sessions.find(session => session.id === f.info.sessionId)?.title, 'Native fixture title')
  } finally { await f.close() }
})

test('native agent presets and reasoning effort use the mounted roster and model metadata', { skip: !nativePath }, async () => {
  const f = await fixture(true)
  try {
    assert.equal(f.info.preset, 'standard', 'a fresh session mounts the roster default')
    const roster = object(await f.backend.command('presets'))
    assert.equal(roster.current, 'standard')
    assert.equal(roster.blank, true)
    const rows = Array.isArray(roster.presets) ? roster.presets.map(object) : []
    assert.deepEqual(rows.map(row => row.id), ['standard', 'ptc', 'minimal', 'cordis'])
    assert.equal(rows.find(row => row.id === 'standard')?.isDefault, true)

    const efforts = object(await f.backend.command('efforts'))
    assert.equal(efforts.provider, 'deepseek-official')
    assert.equal(efforts.model, 'deepseek-flash')
    assert.equal(efforts.available, true)
    const levels = Array.isArray(efforts.efforts) ? efforts.efforts.map(object) : []
    assert.ok(levels.some(level => level.id === 'high'))
    assert.equal(efforts.defaultEffort, 'high')

    const changed = object(await f.backend.command('effort', { id: 'low' }))
    assert.equal(changed.reasoningEffort, 'low')
    assert.equal(object(await f.backend.command('state')).reasoningEffort, 'low')
    const cleared = object(await f.backend.command('effort', { id: null }))
    assert.equal(cleared.reasoningEffort, undefined)
    assert.equal(cleared.effectiveEffort, 'high', 'clearing returns to the adapter default')
    await assert.rejects(f.backend.command('effort', { id: 'not-a-level' }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'RUNTIME_REQUEST_FAILED')
      assert.equal((error as { detail?: string }).detail, 'UNKNOWN_EFFORT')
      return true
    })

    const selected = await f.backend.command('preset', { id: 'minimal' }) as SessionInfo
    assert.equal(selected.preset, 'minimal')
    const commands = await f.backend.command('commands') as JsonRecord[]
    assert.ok(commands.some(command => command.name === 'compact'))
    assert.ok(!commands.some(command => command.name === 'goal'), 'the minimal preset owns a different command set')

    await f.app!.submit('fixture:normal')
    await until(() => f.events.some(event => event.type === 'status' && event.status === 'idle'), 'minimal-preset turn finishes', 10_000)
    const locked = object(await f.backend.command('preset', { id: 'standard' }))
    assert.equal(locked.locked, true)
    assert.equal(locked.current, 'minimal')
    assert.equal(object(await f.backend.command('state')).preset, 'minimal')

    const fresh = await f.backend.command('new', { preset: 'standard' }) as SessionInfo
    assert.equal(fresh.preset, 'standard')
    assert.equal(object(await f.backend.command('presets')).blank, true)
  } finally { await f.close() }
})

test('native /reload applies a home patch through HMR without replacing the live session', { skip: !nativePath }, async () => {
  const f = await fixture(true)
  try {
    const home = join(f.directory, 'home')
    const patch = join(home, 'cordis.patch.yml')
    const probe = join(home, 'reload-probe.mjs')
    await writeFile(probe, [
      "export const name = 'reload-probe'",
      "export const inject = ['commands']",
      "export function apply(ctx) {",
      "  ctx.commands.register({ definitionId: 'reload-probe', name: 'reload-probe', description: 'HMR reload probe', handler: () => ({ kind: 'success', text: 'reload-probe-ok' }) })",
      "}",
      '',
    ].join('\n'))
    const existing = await readFile(patch, 'utf8')
    await writeFile(patch, existing + '- insert:\n    - id: reload-probe\n      name: ' + JSON.stringify(pathToFileURL(probe).href) + '\n')
    const itemsBefore = f.app!.store.items.length
    const result = object(await f.backend.command('reload'))
    assert.equal(result.available, true)
    assert.equal(object(result.info).sessionId, f.info.sessionId)
    assert.equal(f.app!.session?.sessionId, f.info.sessionId)
    assert.equal(f.app!.store.items.length, itemsBefore, 'reload never resets the transcript')
    const commands = await f.backend.command('commands') as JsonRecord[]
    assert.ok(commands.some(command => command.name === 'reload-probe'), 'new home-patch command is live')
    const execution = object(await f.backend.command('execute', { line: '/reload-probe' }))
    assert.equal(object(execution.result).kind, 'success')
    assert.equal(object(execution.result).text, 'reload-probe-ok')

    await writeFile(patch, '{ invalid')
    await assert.rejects(f.backend.command('reload'), (error: unknown) => {
      assert.match(String((error as Error).message), /failed to parse patches/)
      return true
    })
    assert.ok((await f.backend.command('commands') as JsonRecord[]).some(command => command.name === 'reload-probe'), 'invalid config leaves the running composition intact')
  } finally { await f.close() }
})

test('native /reload mirrors a selected profile patch without writing the real profile', { skip: !nativePath }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-reload-profile-'))
  const cwd = join(directory, 'workspace'), home = join(directory, 'home')
  const profile = join(home, 'profiles', 'reload-profile')
  await mkdir(cwd); await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-reload-profile', private: true, dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2))
  await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
  const probe = join(profile, 'profile-reload-probe.mjs')
  await writeFile(probe, [
    "export const name = 'profile-reload-probe'",
    "export const inject = ['commands']",
    "export function apply(ctx) {",
    "  ctx.commands.register({ definitionId: 'profile-reload-probe', name: 'profile-reload-probe', description: 'Profile HMR probe', handler: () => ({ kind: 'success', text: 'profile-reload-ok' }) })",
    "}",
    '',
  ].join('\n'))
  const backend = new DshBackend({ cwd, home, profile: 'reload-profile', dshPath: nativePath, provider: 'deepseek-official', model: 'deepseek-flash' })
  try {
    const info = await backend.connect()
    assert.equal(info.preset, 'standard')
    const patch = join(profile, 'cordis.patch.yml')
    const before = await readFile(patch, 'utf8')
    await writeFile(patch, JSON.stringify([{ insert: [{ id: 'profile-reload-probe', name: pathToFileURL(probe).href }] }], null, 2))
    const result = object(await backend.command('reload'))
    assert.equal(result.available, true)
    assert.equal(object(result.info).sessionId, info.sessionId)
    const commands = await backend.command('commands') as JsonRecord[]
    assert.ok(commands.some(command => command.name === 'profile-reload-probe'))
    const execution = object(await backend.command('execute', { line: '/profile-reload-probe' }))
    assert.equal(object(execution.result).kind, 'success')
    assert.equal(await readFile(patch, 'utf8'), JSON.stringify([{ insert: [{ id: 'profile-reload-probe', name: pathToFileURL(probe).href }] }], null, 2), 'the real profile patch is untouched by the bridge')
  } finally {
    await backend.close()
    await rm(directory, { recursive: true, force: true })
  }
})

test('native command cancellation reaches its signal and settles audit without killing DSH', { skip: !nativePath }, async () => {
  const f = await fixture(true)
  try {
    const pending = f.app!.submit('/fixture-wait')
    await until(() => f.app!.isBusy, 'native command/run controls UI working state')
    assert.equal(f.terminal!.progress, true)
    f.terminal!.type('\x1b')
    await pending
    await until(() => !f.app!.isBusy, 'native command/done clears working state')
    const runs = sessionEvents(f.events).filter(event => event.type === 'command/run' && object(event.data).name === 'fixture-wait')
    assert.equal(runs.length, 1)
    const pair = auditPair(f.events, String(object(runs[0]!.data).commandId))
    assert.equal(object(pair[1]!.data).kind, 'error')
    assert.match(String(object(pair[1]!.data).text), /cancel|abort/i)
    assert.equal(f.events.some(event => event.type === 'closed'), false)
    assert.equal(object(await f.backend.command('state')).sessionId, f.info.sessionId)
  } finally { await f.close() }
})

test('transport timeout requests native command cancellation rather than leaving hidden work running', { skip: !nativePath }, async () => {
  const f = await fixture(true)
  const previous = process.env.DSH_PI_TUI_REQUEST_TIMEOUT_MS
  try {
    process.env.DSH_PI_TUI_REQUEST_TIMEOUT_MS = '100'
    await assert.rejects(f.backend.command('execute', { line: '/fixture-wait' }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'REQUEST_TIMEOUT')
      assert.match(String((error as Error).message), /cancellation was requested/)
      return true
    })
    await until(() => sessionEvents(f.events).some(event => event.type === 'command/done'), 'timed-out native operation settles its signal')
    const run = sessionEvents(f.events).find(event => event.type === 'command/run' && object(event.data).name === 'fixture-wait')
    assert.ok(run)
    const pair = auditPair(f.events, String(object(run.data).commandId))
    assert.equal(object(pair[1]!.data).kind, 'error')
    assert.equal(f.app!.isBusy, false)
    assert.equal(f.events.some(event => event.type === 'closed'), false)
  } finally {
    if (previous === undefined) delete process.env.DSH_PI_TUI_REQUEST_TIMEOUT_MS
    else process.env.DSH_PI_TUI_REQUEST_TIMEOUT_MS = previous
    await f.close()
  }
})

test('native filesystem presenter and real pruner replacements preserve original human output on replay', { skip: !nativePath }, async () => {
  const f = await fixture(true)
  try {
    const lines = Array.from({ length: 160 }, (_, index) => 'native-line-' + index.toString().padStart(3, '0') + ' ' + '原始工具输出 '.repeat(18))
    const file = join(f.cwd, 'native-output.txt')
    await writeFile(file, lines.join('\n') + '\n')
    await f.app!.submit('fixture:tool')
    await until(() => f.events.some(event => event.type === 'status' && event.status === 'idle'), 'native read and second model step finish', 10_000)
    const results = sessionEvents(f.events).filter(event => event.type === 'tool/result')
    const original = results.find(event => event.surfaceOp === 'append')
    const replacement = results.find(event => typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace')
    assert.ok(original, 'real native read result is append-origin')
    assert.equal(object(object(original.data).message).isError, false, JSON.stringify(original.data))
    assert.ok(replacement, 'mounted native tool-result-pruner produces a model-only replacement')
    assert.deepEqual(replacement.sourceEventSeqs, [original.seq])
    const content = object(original.data).message as { content: Array<{ type: string; text?: string }> }
    const originalText = content.content.filter(block => block.type === 'text').map(block => block.text).join('\n\n')
    assert.ok(originalText.length > 8192)
    const tool = f.app!.store.items.find(item => item.kind === 'tool')
    assert.equal(tool?.kind, 'tool')
    if (tool?.kind !== 'tool') throw new Error('missing tool')
    assert.equal(tool.resultText, originalText)
    assert.equal(tool.status, 'done')
    assert.equal(object(original.toolPresentation?.result).card, 'read', 'the actual native presenter runs')
    assert.equal(object(tool.presentation?.result).card, 'read')
    assert.ok(sessionEvents(f.events).every(event => typeof event.seq === 'number'))

    await unlink(file)
    const before = f.info.attachmentId
    const resumed = await f.backend.command('resume', { sessionId: f.info.sessionId }) as SessionInfo
    assert.equal(resumed.sessionId, f.info.sessionId)
    assert.notEqual(resumed.attachmentId, before)
    const replayed = f.app!.store.items.find(item => item.kind === 'tool')
    if (replayed?.kind !== 'tool') throw new Error('missing replayed tool')
    assert.equal(replayed.resultText, originalText, 'native log replay does not replace human output or re-execute the missing file')
    assert.equal(replayed.status, 'done')
    assert.equal(object(replayed.presentation?.result).card, 'read')
    assert.ok(resumed.events?.some(event => typeof event.surfaceOp === 'object' && event.surfaceOp.op === 'replace'))
    assert.ok(!f.events.some(event => event.type === 'error'), JSON.stringify(f.events.filter(event => event.type === 'error')))
  } finally { await f.close() }
})

test('same-session reattachment resets stream lifecycle and remains usable after an invalid resume', { skip: !nativePath }, async () => {
  const f = await fixture(true)
  try {
    await f.app!.submit('fixture:slow')
    await until(() => f.app!.store.hasLiveAttempt, 'native first attachment streams')
    const resumed = await f.backend.command('resume', { sessionId: f.info.sessionId }) as SessionInfo
    assert.notEqual(resumed.attachmentId, f.info.attachmentId)
    assert.equal(f.app!.store.hasLiveAttempt, false, 'old native lifecycle is not left as an active stream')
    f.events.length = 0
    await f.app!.submit('fixture:normal')
    await until(() => f.events.some(event => event.type === 'status' && event.status === 'idle'), 'second attachment finishes')
    assert.ok(f.events.some(event => event.type === 'stream_start' && event.revision === 1), 'native revision counter can restart')
    assert.ok(f.app!.store.items.some(item => item.kind === 'assistant' && item.text.includes('fixture-live')))
    await assert.rejects(f.backend.command('resume', { sessionId: 'missing-native-session' }))
    const fresh = await f.backend.command('new') as SessionInfo
    assert.notEqual(fresh.sessionId, resumed.sessionId)
    assert.equal(f.app!.session?.sessionId, fresh.sessionId)
  } finally { await f.close() }
})

test('tool presenter uses the exact native agent scope and cannot mutate durable results', () => {
  const agent = {}, meta = Object.freeze({ sentinel: 'unchanged' })
  const content = [{ type: 'text', text: 'native result' }]
  let calls = 0, results = 0
  const presenter = new ToolPresentation({ get(name, scope) {
    assert.equal(name, 'custom'); assert.equal(scope, agent)
    return {
      presentCall(args) { calls++; assert.deepEqual(args, { input: 'value' }); return { card: 'generic', title: 'Native custom call' } },
      presentResult(args, result) { results++; assert.deepEqual(args, { input: 'value' }); assert.equal(result.meta, meta); assert.equal(result.content, content); return { card: 'generic', title: 'Native custom result' } },
    }
  } }, agent)
  const pending = presenter.of({ type: 'tool/call', seq: 1, data: { name: 'custom', callId: 'call', arguments: '{"input":"value"}' } })
  const completed = presenter.of({ type: 'tool/result', seq: 2, data: { message: { toolCallId: 'call', source: { callId: 'call' }, content, isError: false }, meta } })
  assert.equal(pending?.call?.title, 'Native custom call')
  assert.equal(completed?.result?.title, 'Native custom result')
  assert.equal(calls, 1); assert.equal(results, 1)
  assert.deepEqual(content, [{ type: 'text', text: 'native result' }])
})


test('native /plan is independent from permissions; Shift+Tab executes audited /permission', { skip: !nativePath }, async () => {
  const f = await fixture(true)
  try {
    const commands = await f.backend.command('commands') as JsonRecord[]
    assert.ok(commands.some(command => command.name === 'plan'), 'the installed base composition really provides /plan')
    assert.ok(commands.some(command => command.name === 'permission'))
    assert.ok(!f.info.capabilities.includes('mode'))
    assert.ok(f.info.capabilities.includes('permissions'))
    assert.deepEqual(f.info.permissions, { currentValue: 'workspace-write' })
    await f.app!.submit('/help')
    const help = f.app!.store.items.filter(item => item.kind === 'notice').map(item => item.text).join('\n')
    assert.match(help, /\/plan —/)
    assert.match(help, /\/permission —/)
    assert.doesNotMatch(help, /\/mode —/)
    assert.match(help, /\/reload —/)

    const initial = object(await f.backend.command('permissions')).currentValue
    await f.app!.submit('/plan')
    const planEvents = () => sessionEvents(f.events).filter(event => event.type === 'plan/mode')
    assert.equal(object(planEvents().at(-1)?.data).active, true)
    assert.equal(object(await f.backend.command('permissions')).currentValue, initial, 'entering native plan mode never switches the permission preset')
    assert.equal(f.events.some(event => event.type === 'stream_start'), false, 'bare /plan is not a model request')

    f.terminal!.type('\x1b[Z')
    await until(() => f.app!.session?.permissions?.currentValue === 'danger-full-access', 'native permission projection reaches the footer')
    await until(() => !f.app!.isBusy, 'native command/done completes the permission change')
    const permissionRun = sessionEvents(f.events).filter(event => event.type === 'command/run' && object(event.data).name === 'permission').at(-1)!
    assert.equal(object(permissionRun.data).args, ' danger-full-access', 'native audit retains the original separator whitespace')
    auditPair(f.events, String(object(permissionRun.data).commandId))
    assert.equal(object(planEvents().at(-1)?.data).active, true, 'the shortcut does not exit or toggle plan mode')
    assert.ok(f.events.some(event => event.type === 'permissions' && event.value.currentValue === 'danger-full-access'))

    const rejected = execution(await f.backend.command('execute', { line: '/permission plan' }))
    assert.equal(rejected.result.kind, 'error', 'Plan is not fabricated as a permission option')
    auditPair(f.events, rejected.id)
    assert.equal(object(await f.backend.command('permissions')).currentValue, 'danger-full-access')
    await f.app!.submit('/plan off')
    assert.equal(object(planEvents().at(-1)?.data).active, false)
    assert.equal(f.app!.session?.permissions?.currentValue, 'danger-full-access')
    await assert.rejects(f.backend.command('mode'), (error: unknown) => (error as { code?: string }).code === 'UNSUPPORTED_COMMAND')
    assert.equal(f.events.some(event => event.type === 'stream_start'), false)
  } finally { await f.close() }
})
