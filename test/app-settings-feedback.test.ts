import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { App } from '../src/app.ts'
import type { JsonRecord } from '../src/backend/types.ts'
import { DemoBackend } from '../src/demo.ts'
import { wrapTextWithAnsi } from '#pi-tui'
import { delay, until, VirtualTerminal } from './helpers/terminal.ts'

/** Offline control responses only; no Agent loop, persistence or model transport. */
class FeedbackBackend extends DemoBackend {
  readonly replies = new Map<string, unknown>()
  readonly calls: Array<{ name: string; args: JsonRecord }> = []

  override async command(name: string, args: JsonRecord = {}): Promise<unknown> {
    this.calls.push({ name, args })
    if (this.replies.has(name)) {
      const reply = this.replies.get(name)
      if (reply instanceof Error) throw reply
      return reply
    }
    return await super.command(name, args)
  }
}

async function fixture(screen: 'inline' | 'fullscreen' = 'fullscreen') {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tui-settings-feedback-'))
  const terminal = new VirtualTerminal(110, 35)
  const backend = new FeedbackBackend({ cwd: directory, delayMs: 0 })
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen, demo: true, registerSignals: false })
  await app.start()
  await paint(terminal)
  return { app, backend, terminal, directory, async close() {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  } }
}

async function paint(terminal: VirtualTerminal) { await delay(30); await terminal.flush() }

/** Search the native read-only row without depending on its roster position. */
async function showAutoTitle(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await f.app.submit('/settings'); await paint(f.terminal)
  f.terminal.type('\x06')
  for (const char of 'auto title') f.terminal.type(char)
  await paint(f.terminal)
  await until(() => f.terminal.screen().includes('Auto title'), 'native auto-title row is visible')
    .catch(error => { throw new Error(String(error) + '\n' + f.terminal.screen()) })
}

/**
 * The status footer is the block below the editor frame, rendered as one or
 * more wrapped rows. A long TMPDIR legitimately wraps it, so assertions isolate
 * the block and describe the product's value order, not the wrap column.
 */
function footerLines(terminal: VirtualTerminal, cwd: string): { status: string[]; place: string[] } {
  const rows = terminal.screen().split('\n').map(row => row.replace(/\s+$/, ''))
  const frame = rows.findLastIndex(row => row.startsWith('─'))
  assert.ok(frame >= 0, 'the editor frame is rendered above the footer')
  const block = rows.slice(frame + 1).filter(row => row !== '')
  const start = block.findIndex(row => row.length > 1 && (row.startsWith(cwd) || cwd.startsWith(row)))
  assert.ok(start > 0, 'the cwd line starts below the status line inside the footer')
  return { status: block.slice(0, start), place: block.slice(start) }
}

/** The shared public wrapper's rows: same content and break points as the footer. */
function wrappedRows(line: string, width: number): string[] {
  return wrapTextWithAnsi(line, width).map(row => row.trimEnd())
}

const notices = (app: App) => app.store.items.filter(item => item.kind === 'notice')

for (const screen of ['inline', 'fullscreen'] as const) {
  test('successful setting commands and pickers update status without transcript messages (' + screen + ')', async () => {
    const f = await fixture(screen)
    try {
      const before = f.app.store.items.length
      await f.app.submit('/model demo/changed-model')
      assert.equal(f.app.session?.model, 'changed-model')
      await f.app.submit('/effort max')
      assert.equal(f.app.session?.reasoningEffort, 'max')
      await f.app.submit('/preset minimal')
      assert.equal(f.app.session?.preset, 'minimal')
      await f.app.submit('/permission danger-full-access')
      const permissionLine = '/permission   \nworkspace-write'
      await f.app.submit(permissionLine)
      assert.equal(f.app.session?.permissions?.currentValue, 'workspace-write')
      assert.ok(f.backend.calls.some(call => call.name === 'execute' && call.args.line === permissionLine), 'native arguments are still forwarded unchanged')
      await paint(f.terminal)
      const { status, place } = footerLines(f.terminal, f.directory)
      assert.match(status.join(''), /changed-model max · ready · minimal/, 'the text-only effort and the preset value ride behind the model')
      assert.deepEqual(place, wrappedRows(f.directory + ' · workspace-write', f.terminal.columns), 'the permission value shows without its label prefix')
      for (const line of [...status, ...place]) assert.doesNotMatch(line, /preset: |permission: |effort: /, 'no label prefixes remain in the footer')

      for (let index = 0; index < 6; index++) {
        const previous = f.app.session?.permissions?.currentValue
        f.terminal.type('\x1b[Z')
        await until(() => f.app.session?.permissions?.currentValue !== previous && !f.app.isBusy, 'Shift+Tab applies one native permission change')
        assert.equal(f.app.queuedCount, 0)
      }

      f.terminal.type('\x1bp')
      await paint(f.terminal)
      assert.match(f.terminal.screen(), /Choose model/)
      f.terminal.type('\r')
      await until(() => f.app.session?.model === 'deepseek-demo', 'model picker selection applies')
      await f.app.submit('/effort'); await paint(f.terminal)
      f.terminal.type('2')
      await until(() => f.app.session?.reasoningEffort === 'low', 'effort picker selection applies')
      await f.app.submit('/preset'); await paint(f.terminal)
      f.terminal.type('1')
      await until(() => f.app.session?.preset === 'standard', 'preset picker selection applies')
      await f.app.submit('/effort default')
      assert.equal(f.app.session?.reasoningEffort, undefined, 'reset still uses the native model default')
      await paint(f.terminal)
      assert.equal(f.app.store.items.length, before, 'successful control changes add neither notices nor conversation messages')
      assert.doesNotMatch(f.terminal.document(), /Reasoning effort:|Agent preset:|Demo permission preset|Saved through DSH/)
      assert.equal(f.backend.info.events?.some(event => event.type === 'turn/start'), false, 'settings never send a prompt')
      assert.equal(f.app.editor.getExpandedText(), '')
    } finally { await f.close() }
  })
}

test('a locked preset is staged quietly and the footer distinguishes the next session from the current one', async () => {
  const f = await fixture()
  try {
    await f.app.submit('offline streaming fixture')
    await f.backend.whenIdle(); await paint(f.terminal)
    const before = [...f.app.store.items]
    await f.app.submit('/preset minimal'); await paint(f.terminal)
    assert.equal(f.app.session?.preset, 'standard', 'a started Agent keeps its native composition')
    assert.deepEqual(f.app.store.items, before, 'staging is not a transcript message')
    assert.doesNotMatch(f.terminal.screen(), / · preset: /)
    assert.match(f.terminal.screen(), /next preset: minimal/)
    await f.app.submit('/new'); await paint(f.terminal)
    assert.equal(f.app.session?.preset, 'minimal')
    assert.doesNotMatch(f.terminal.screen(), /next preset:/)
    assert.deepEqual(notices(f.app), [])
  } finally { await f.close() }
})

for (const shape of ['route', 'session'] as const) {
  test('successful runtime default saves stay quiet with native ' + shape + ' responses', async () => {
    const f = await fixture()
    try {
      const saved = {
        defaultsPersisted: false,
        defaultPersistence: 'runtime',
        defaultWarning: "Saved through DSH's native default-selection service for this runtime; the real profile is not modified.",
      }
      const route = { provider: 'feedback', model: 'selected', reasoningEffort: 'max' }
      f.backend.replies.set('model', { ...(shape === 'session' ? f.backend.info : {}), ...route, ...saved })
      await f.app.submit('/model feedback/selected')
      assert.equal(f.app.session?.model, 'selected')
      f.backend.replies.set('effort', { ...route, reasoningEffort: 'low', effectiveEffort: 'low', ...saved })
      await f.app.submit('/effort low'); await paint(f.terminal)
      assert.equal(f.app.session?.reasoningEffort, 'low')
      assert.match(f.terminal.screen(), /feedback\/selected/)
      assert.match(f.terminal.screen(), /selected low/, 'the text-only effort rides behind the model')
      assert.deepEqual(notices(f.app), [], 'runtime scope is expected metadata, not a repeated success warning')
      assert.doesNotMatch(f.terminal.document(), /Saved through DSH|Reasoning effort:/)
    } finally { await f.close() }
  })
}

test('confirmed native default-save acknowledgements stay in metadata, not the transcript', async () => {
  const f = await fixture()
  try {
    f.backend.replies.set('model', {
      provider: 'feedback', model: 'selected', defaultsPersisted: false,
      defaultPersistence: 'native',
      defaultWarning: "Saved through DSH's native default-selection service. Persistence is owned by the host's mounted ConfigEditor; this adapter cannot confirm a profile flush.",
    })
    await f.app.submit('/model feedback/selected')
    assert.equal(f.app.session?.model, 'selected')
    assert.deepEqual(notices(f.app), [])
  } finally { await f.close() }
})

test('failed, unavailable and unrecognized default-save warnings remain visible for model and effort changes', async () => {
  const f = await fixture()
  try {
    for (const command of ['model', 'effort']) {
      for (const scope of ['failed', 'unavailable', 'native', 'future-scope', undefined]) {
        const warning = command + ' default save warning: ' + (scope ?? 'unclassified')
        f.backend.replies.set(command, {
          provider: 'feedback', model: 'selected', reasoningEffort: 'max', effectiveEffort: 'max',
          defaultsPersisted: false, defaultWarning: warning,
          ...(scope === undefined ? {} : { defaultPersistence: scope }),
        })
        const before = notices(f.app).length
        await f.app.submit(command === 'model' ? '/model feedback/selected' : '/effort max')
        assert.deepEqual(notices(f.app).slice(before).map(item => item.text), [warning], 'only an actionable warning, not a setting confirmation, is reported')
      }
    }
    assert.equal(f.app.session?.model, 'selected')
    assert.equal(f.app.session?.reasoningEffort, 'max')
  } finally { await f.close() }
})

test('unclassified native notes are not discarded as routine runtime-save confirmations', async () => {
  const f = await fixture()
  try {
    for (const command of ['model', 'effort']) {
      const note = command + ': native configuration needs attention'
      f.backend.replies.set(command, { provider: 'feedback', model: 'selected', reasoningEffort: 'max', note })
      await f.app.submit(command === 'model' ? '/model feedback/selected' : '/effort max')
      assert.equal(notices(f.app).at(-1)?.text, note)
    }
  } finally { await f.close() }
})

test('setting queries stay quiet while native business output and validation errors remain visible', async () => {
  const f = await fixture()
  try {
    const before = [...f.app.store.items]
    for (const line of ['/preset status', '/effort status', '/permission', '/permission   ']) {
      await f.app.submit(line)
      assert.deepEqual(f.app.store.items, before, 'status already exists in the footer; no query echo is appended')
      assert.equal(f.app.editor.focused, true, 'status queries do not open a picker')
    }
    assert.equal(f.app.session?.preset, 'standard')
    assert.equal(f.app.session?.permissions?.currentValue, 'workspace-write')
    await f.app.submit('/compact')
    assert.match(notices(f.app).at(-1)?.text ?? '', /Demo compaction simulated/)
    await f.app.submit('/status')
    assert.match(notices(f.app).at(-1)?.text ?? '', /Demo session/)
    for (const line of ['/permission nonexistent', '/effort nonexistent', '/preset nonexistent']) {
      const before = notices(f.app).length
      await f.app.submit(line)
      assert.equal(notices(f.app).length, before + 1)
      assert.equal(notices(f.app).at(-1)?.level, 'error')
      assert.match(notices(f.app).at(-1)?.text ?? '', /[Uu]nknown/)
    }
    assert.equal(f.app.session?.permissions?.currentValue, 'workspace-write')
  } finally { await f.close() }
})

test('failed preset, effort and permission status queries remain visible', async () => {
  const f = await fixture()
  try {
    for (const [command, line] of [['presets', '/preset status'], ['efforts', '/effort status'], ['execute', '/permission']]) {
      const text = 'Native status query failed: ' + command
      f.backend.replies.set(command, new Error(text))
      const before = notices(f.app).length
      await f.app.submit(line)
      assert.deepEqual(notices(f.app).slice(before).map(item => ({ text: item.text, level: item.level })), [{ text, level: 'error' }])
      f.backend.replies.delete(command)
    }
  } finally { await f.close() }
})

test('model command failures are not hidden by quiet success feedback', async () => {
  const f = await fixture()
  try {
    f.backend.replies.set('model', new Error('native model selection failed'))
    await f.app.submit('/model feedback/selected')
    assert.equal(notices(f.app).at(-1)?.text, 'native model selection failed')
    assert.equal(notices(f.app).at(-1)?.level, 'error')
    assert.equal(f.app.session?.model, 'deepseek-demo')
  } finally { await f.close() }
})

for (const screen of ['inline', 'fullscreen'] as const) {
  test('native auto-title is a read-only DSH row without transcript messages (' + screen + ')', async () => {
    const f = await fixture(screen)
    try {
      f.backend.replies.set('auto-title', { available: true, enabled: true, editable: false })
      const before = [...f.app.store.items]
      await showAutoTitle(f)
      await until(() => f.terminal.screen().split('\n').some(line => line.includes('Auto title') && /On · read-only/.test(line)), 'native state is reflected in Settings')
      assert.equal(f.backend.calls.some(call => call.name === 'auto-title' && call.args.enabled !== undefined), false, 'the UI never requests a native composition change')
      assert.deepEqual(f.app.store.items, before)
      assert.match(f.terminal.screen(), /native titles may[\s\S]*the model/, 'model-backed title disclosure remains in the native row')
    } finally { await f.close() }
  })
}

test('native auto-title details and an unconfirmed effective value stay in the row', async () => {
  for (const field of ['note', 'warning', 'limitation', 'unconfirmed']) {
    const f = await fixture()
    try {
      const warning = 'Native title configuration needs attention: ' + field
      f.backend.replies.set('auto-title', field === 'unconfirmed' ? { available: true, editable: false } : { available: true, enabled: true, editable: false, [field]: warning })
      await showAutoTitle(f)
      await paint(f.terminal)
      if (field === 'unconfirmed') assert.match(f.terminal.screen(), /Read-only/)
      else assert.match(f.terminal.screen(), new RegExp(warning))
      assert.equal(f.backend.calls.some(call => call.name === 'auto-title' && call.args.enabled !== undefined), false)
      assert.deepEqual(notices(f.app), [], 'read-only native details do not become transcript notices')
    } finally { await f.close() }
  }
})

test('an unwritable local settings path cannot turn the native auto-title row into a write', async () => {
  const f = await fixture()
  try {
    f.backend.replies.set('auto-title', { available: true, enabled: true, editable: false })
    await mkdir(join(f.directory, 'settings.json'))
    await showAutoTitle(f)
    f.terminal.type('\r'); await paint(f.terminal)
    assert.equal(f.backend.calls.some(call => call.name === 'auto-title' && call.args.enabled !== undefined), false)
    assert.equal(notices(f.app).some(item => item.text.includes('local TUI preference')), false)
  } finally { await f.close() }
})
