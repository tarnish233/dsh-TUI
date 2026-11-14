import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, JsonRecord, SessionInfo } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { readNativeDefaults } from '../src/native-ui.ts'
import { SelectDialog } from '../src/ui/dialogs.ts'
import { ModelPickerDialog } from '../src/ui/model-picker.ts'
import { SettingsDialog } from '../src/ui/settings.ts'
import { delay, until, VirtualTerminal } from './helpers/terminal.ts'

/** Native-shaped control fixture only: no Agent, model transport or production persistence. */
class DefaultSettingsBackend implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly calls: Array<{ name: string; args: JsonRecord }> = []
  readonly info: SessionInfo
  readonly saved: { provider: string; model: string; reasoningEffort?: string } = {
    provider: 'native-alpha', model: 'saved-model', reasoningEffort: 'precise-native',
  }
  revision = 11
  writes = 0
  cancels = 0
  writable = true
  reasoning: 'supported' | 'unsupported' | 'unreadable' = 'supported'
  defaultsFailure?: Error
  modelsFailure?: Error
  writeOutcome?: JsonRecord | Error
  defaultsGate?: Promise<void>
  modelsGate?: Promise<void>
  catalog: JsonRecord[] = [
    { id: 'opaque#session', provider: 'session-provider', model: 'session-model', label: 'Current session route' },
    { id: 'opaque#saved', provider: 'native-alpha', model: 'saved-model', label: 'Saved native model' },
    { id: 'opaque#next', provider: 'native-beta', model: 'next-model', label: 'Native Needle 下一模型' },
  ]

  constructor(cwd: string) {
    this.info = { sessionId: 'default-settings-root', attachmentId: 'default-settings-attachment', cwd,
      provider: 'session-provider', model: 'session-model', reasoningEffort: 'session-effort',
      capabilities: ['commands', 'models', 'model', 'efforts', 'effort', 'state', 'native-defaults', 'native-default-update'], events: [] }
  }
  onEvent(listener: (event: BackendEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent): void { for (const listener of this.listeners) listener(event) }
  changed(domain: 'settings' | 'models' = 'settings'): void {
    this.emit(domain === 'models' ? { type: 'models_changed', sessionId: this.info.sessionId, attachmentId: this.info.attachmentId }
      : { type: 'native_ui_changed', domain: 'settings', sessionId: this.info.sessionId, attachmentId: this.info.attachmentId })
  }
  levels(): Array<{ id: string; label: string }> {
    return this.saved.model === 'next-model'
      ? [{ id: 'inspect-native', label: 'Native inspect' }, { id: 'full-native', label: 'Native full' }]
      : [{ id: 'balanced-native', label: 'Native balanced' }, { id: 'precise-native', label: 'Native precise' }]
  }
  defaults(): JsonRecord {
    const levels = this.reasoning === 'supported' ? this.levels() : []
    return { available: true, targets: [{ target: 'agent-default-model', field: 'model', namespace: 'owned-default-model',
      available: true, writable: this.writable, revision: this.revision,
      value: this.saved.provider + '/' + this.saved.model, effectiveValue: this.saved.provider + '/' + this.saved.model,
      ...this.saved, options: [], reasoningAvailable: this.reasoning !== 'unreadable', reasoningSupported: this.reasoning === 'supported',
      reasoningEfforts: levels, ...(levels.length === 0 ? {} : {
        defaultReasoningEffort: levels[0]!.id, effectiveReasoningEffort: this.saved.reasoningEffort ?? levels[0]!.id,
      }), ...(this.writable ? {} : { limitation: 'The native profile is read-only in this fixture.' }) }] }
  }
  async connect(): Promise<SessionInfo> { return this.info }
  async send(): Promise<void> { throw new Error('Default Settings must never send a model prompt') }
  async respond(): Promise<void> { throw new Error('Default Settings must never answer a native decision') }
  async cancel(): Promise<void> { this.cancels++; this.emit({ type: 'status', sessionId: this.info.sessionId, status: 'idle' }) }
  async close(): Promise<void> {}
  async command(name: string, args: JsonRecord = {}): Promise<unknown> {
    this.calls.push({ name, args })
    if (name === 'commands') return []
    if (name === 'auto-title') return { available: false }
    if (name === 'state') return { queued: 0, queue: [], pending: { nextTurn: 0, nextStep: 0 } }
    if (name === 'native-defaults') {
      const snapshot = structuredClone(this.defaults())
      const failure = this.defaultsFailure
      await this.defaultsGate
      if (failure !== undefined) throw failure
      return snapshot
    }
    if (name === 'models') {
      const snapshot = structuredClone(this.catalog), failure = this.modelsFailure
      await this.modelsGate
      if (failure !== undefined) throw failure
      return snapshot
    }
    if (name === 'native-default-update') {
      if (this.writeOutcome instanceof Error) throw this.writeOutcome
      if (this.writeOutcome !== undefined) return this.writeOutcome
      assert.equal(args.target, 'agent-default-model')
      if (args.expectedRevision !== this.revision) return { ok: false, reason: 'conflict', message: 'Native revision conflict.' }
      if (args.reasoningEffort !== undefined) {
        assert.equal(args.value, this.saved.provider + '/' + this.saved.model)
        if (args.reasoningEffort === null) delete this.saved.reasoningEffort
        else { assert.equal(typeof args.reasoningEffort, 'string'); this.saved.reasoningEffort = args.reasoningEffort as string }
      } else {
        const selected = this.catalog.find(row => row.id === args.value)
        assert.ok(selected, 'the selected native ID is forwarded without parsing')
        this.saved.provider = String(selected.provider); this.saved.model = String(selected.model)
        if (!this.levels().some(level => level.id === this.saved.reasoningEffort)) delete this.saved.reasoningEffort
      }
      this.writes++; this.revision++
      return { ok: true, target: 'agent-default-model', changed: true, revision: this.revision,
        value: this.saved.provider + '/' + this.saved.model, ...this.saved, stillCurrent: true }
    }
    throw new Error('Unexpected current-session or business operation in default Settings: ' + name)
  }
}

const localPreferences = '{"formatVersion":2,"showThinking":true,"reducedMotion":true}\n'
async function fixture(screen: 'inline' | 'fullscreen' = 'fullscreen') {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-model-default-settings-'))
  await writeFile(join(directory, 'settings.json'), localPreferences)
  const backend = new DefaultSettingsBackend(directory), terminal = new VirtualTerminal(110, 35)
  const app = new App({ backend, terminal, cwd: directory, configDir: directory, screen, registerSignals: false })
  await app.start(); await paint(terminal)
  return { app, backend, terminal, directory, async close() {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  } }
}
async function paint(terminal: VirtualTerminal): Promise<void> { await delay(25); await terminal.flush() }
const dialogOf = (app: App): unknown => (app as unknown as { dialog?: unknown }).dialog
function settings(app: App): SettingsDialog { const dialog = dialogOf(app); assert.ok(dialog instanceof SettingsDialog); return dialog }
const reads = (backend: DefaultSettingsBackend, name: string): number => backend.calls.filter(call => call.name === name).length
const updates = (backend: DefaultSettingsBackend): JsonRecord[] => backend.calls.filter(call => call.name === 'native-default-update').map(call => call.args)

async function selectRow(f: Awaited<ReturnType<typeof fixture>>, id: 'native.defaultModel' | 'native.defaultEffort', query: string): Promise<SettingsDialog> {
  await f.app.submit('/settings'); await paint(f.terminal)
  const dialog = settings(f.app)
  await until(() => dialog.allRows.some(row => row.id === 'native:' + id && !row.value.includes('Reading')), 'native default summary arrives')
  f.terminal.type('\x06')
  for (const char of query) f.terminal.type(char)
  await paint(f.terminal)
  const target = 'native:' + id
  assert.ok(dialog.getVisibleRows().some(row => row.id === target), 'default entry is searchable in the same Settings page')
  for (let i = 0; i < dialog.getVisibleRows().length && dialog.activeRowId !== target; i++) f.terminal.type('\x1b[B')
  assert.equal(dialog.activeRowId, target)
  await paint(f.terminal)
  return dialog
}
async function openModel(f: Awaited<ReturnType<typeof fixture>>): Promise<ModelPickerDialog> {
  await selectRow(f, 'native.defaultModel', 'default model')
  f.terminal.type('\r'); await paint(f.terminal)
  const dialog = dialogOf(f.app)
  assert.ok(dialog instanceof ModelPickerDialog)
  await until(() => dialog.render(110).join('\n').includes('Saved native model'), 'native default model picker is loaded')
  return dialog
}
async function openEffort(f: Awaited<ReturnType<typeof fixture>>): Promise<SelectDialog> {
  await selectRow(f, 'native.defaultEffort', 'default effort')
  f.terminal.type('\r'); await paint(f.terminal)
  const dialog = dialogOf(f.app)
  assert.ok(dialog instanceof SelectDialog)
  await until(() => dialog.render(110).join('\n').includes('Native precise'), 'default-scoped native effort list is loaded')
  return dialog
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`Settings default model uses saved tuple, native opaque ID and revision, not current-session control (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.terminal.type('retained default draft 中文 ')
      f.terminal.type('\x1b[200~' + 'native defaults retained paste\n'.repeat(20) + '\x1b[201~')
      f.terminal.type('\x02')
      const editor = f.app.editor, draft = editor.captureDraft(), transcript = [...f.app.store.items]
      const original = await selectRow(f, 'native.defaultModel', 'default model')
      const state = original.captureView()
      f.terminal.type('\r'); await paint(f.terminal)
      const dialog = dialogOf(f.app)
      assert.ok(dialog instanceof ModelPickerDialog)
      await until(() => dialog.render(110).join('\n').includes('Saved native model'), 'the saved default provider is highlighted')
      assert.match(dialog.render(110).join('\n'), /Choose default model/)
      assert.match(dialog.render(110).join('\n'), /default native-alpha\/saved-model/)
      assert.doesNotMatch(dialog.render(110).join('\n'), /Current session route|current native-alpha/)
      assert.equal((f.app as unknown as { dialogPlacement: string }).dialogPlacement, 'workspace')
      f.terminal.type('nEeDlE'); f.terminal.type('\t'); await paint(f.terminal)
      assert.match(dialog.render(110).join('\n'), /Native Needle/)
      assert.deepEqual(updates(f.backend), [], 'search and provider navigation are read-only')
      f.terminal.type('\r')
      await until(() => dialogOf(f.app) instanceof SettingsDialog && f.backend.writes === 1, 'save returns to Settings')
      await paint(f.terminal)
      assert.deepEqual(updates(f.backend), [{ target: 'agent-default-model', value: 'opaque#next', expectedRevision: 11, attachmentId: 'default-settings-attachment' }])
      assert.deepEqual(settings(f.app).captureView(), state)
      assert.match(settings(f.app).allRows.find(row => row.id === 'native:native.defaultModel')!.value, /native-beta\/next-model/)
      assert.match(f.terminal.screen(), /Default model saved through DSH/)
      assert.equal(f.app.session?.provider, 'session-provider')
      assert.equal(f.app.session?.model, 'session-model')
      assert.equal(f.app.session?.reasoningEffort, 'session-effort')
      assert.equal(reads(f.backend, 'model'), 0)
      assert.equal(reads(f.backend, 'effort'), 0)
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), draft)
      assert.deepEqual(f.app.store.items, transcript, 'success is a Settings message, not conversation output')
      assert.equal(await readFile(join(f.directory, 'settings.json'), 'utf8'), localPreferences, 'DSH model defaults never enter local TUI preferences')
    } finally { await f.close() }
  })

  test(`Settings default effort uses default model's IDs and native unset, preserving the current route (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.terminal.type('default effort draft')
      const editor = f.app.editor, draft = editor.captureDraft(), transcript = [...f.app.store.items]
      const dialog = await openEffort(f)
      assert.match(dialog.render(110).join('\n'), /Native balanced|Native precise/)
      assert.doesNotMatch(dialog.render(110).join('\n'), /session-effort|\b(low|medium|high|xhigh)\b/)
      assert.equal(reads(f.backend, 'efforts'), 0, 'the current-session effort roster is not queried')
      f.terminal.type('2')
      await until(() => dialogOf(f.app) instanceof SettingsDialog && f.backend.writes === 1, 'native default effort selection returns')
      assert.equal(f.backend.saved.reasoningEffort, 'balanced-native')
      assert.deepEqual(updates(f.backend)[0], { target: 'agent-default-model', value: 'native-alpha/saved-model', expectedRevision: 11,
        attachmentId: 'default-settings-attachment', reasoningEffort: 'balanced-native' })
      await openEffort(f)
      f.terminal.type('1')
      await until(() => dialogOf(f.app) instanceof SettingsDialog && f.backend.writes === 2, 'native default effort reset returns')
      assert.equal(f.backend.saved.reasoningEffort, undefined)
      assert.equal(updates(f.backend)[1]?.reasoningEffort, null, 'Default is native unset, not an explicit provider default value')
      assert.match(settings(f.app).allRows.find(row => row.id === 'native:native.defaultEffort')!.value, /Model default \(balanced-native\)/)
      assert.equal(f.app.session?.reasoningEffort, 'session-effort')
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), draft)
      assert.deepEqual(f.app.store.items, transcript)
      assert.equal(await readFile(join(f.directory, 'settings.json'), 'utf8'), localPreferences)
    } finally { await f.close() }
  })

  test(`local cancel returns from default pickers without clearing draft or interrupting a busy native session (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.terminal.type('busy native default draft')
      const draft = f.app.editor.captureDraft(), editor = f.app.editor
      f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'running' })
      const model = await openModel(f)
      f.terminal.type('\x03'); await paint(f.terminal)
      assert.ok(dialogOf(f.app) instanceof SettingsDialog)
      assert.equal(model.isDone, true)
      await openEffort(f)
      f.terminal.type('\x03'); await paint(f.terminal)
      assert.ok(dialogOf(f.app) instanceof SettingsDialog)
      assert.deepEqual(updates(f.backend), [])
      assert.equal(f.backend.cancels, 0)
      assert.equal(f.app.isBusy, true)
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), draft)
    } finally { await f.close() }
  })
}

for (const state of ['unsupported', 'unreadable', 'read-only'] as const) {
  test(`Settings default effort distinguishes ${state} and never invents a local preference`, async () => {
    const f = await fixture()
    try {
      if (state === 'read-only') f.backend.writable = false
      else f.backend.reasoning = state
      const dialog = await selectRow(f, 'native.defaultEffort', 'default effort')
      const row = dialog.activeRow
      assert.equal(row?.available, false)
      if (state === 'unsupported') assert.match(row!.value, /Not supported by default model/)
      if (state === 'unreadable') assert.match(row!.value, /Reasoning metadata unavailable/)
      if (state === 'read-only') assert.match(row!.description ?? '', /read-only/)
      f.terminal.type('\r'); await paint(f.terminal)
      assert.equal(dialogOf(f.app), dialog)
      assert.deepEqual(updates(f.backend), [])
      assert.equal(await readFile(join(f.directory, 'settings.json'), 'utf8'), localPreferences)
    } finally { await f.close() }
  })
}

for (const outcome of ['conflict', 'read-back-mismatch', 'failed'] as const) {
  test(`default model ${outcome} is visible in restored Settings without a fake successful value`, async () => {
    const f = await fixture()
    try {
      f.backend.writeOutcome = outcome === 'conflict' ? { ok: false, reason: 'conflict', message: 'Native revision conflict.' }
        : outcome === 'failed' ? new Error('Native profile write failed.') : { ok: true, changed: false }
      const before = [...f.app.store.items]
      await openModel(f)
      f.terminal.type('\t'); f.terminal.type('\r')
      await until(() => dialogOf(f.app) instanceof SettingsDialog && updates(f.backend).length === 1, 'failed save returns to Settings')
      await paint(f.terminal)
      assert.match(settings(f.app).allRows.find(row => row.id === 'native:native.defaultModel')!.value, /native-alpha\/saved-model/)
      assert.match(f.terminal.screen(), outcome === 'conflict' ? /Native revision conflict/ : outcome === 'failed' ? /Native profile write failed/ : /read-back value is not confirmed/)
      assert.equal(f.backend.writes, 0)
      assert.deepEqual(f.app.store.items, before, 'failure is visible in its Settings owner, not a duplicate notice')
      assert.equal(await readFile(join(f.directory, 'settings.json'), 'utf8'), localPreferences)
    } finally { await f.close() }
  })
}

test('a cancelled default write returns to Settings without a red failure line', async () => {
  const f = await fixture()
  try {
    f.backend.writeOutcome = Object.assign(new Error('native default update cancelled'), { code: 'ABORTED' })
    await openModel(f)
    f.terminal.type('\t')
    f.terminal.type('\r')
    await until(() => dialogOf(f.app) instanceof SettingsDialog && updates(f.backend).length === 1, 'cancel returns to Settings')
    await paint(f.terminal)
    assert.doesNotMatch(f.terminal.screen(), /native default update cancelled|Native default update failed/)
    assert.match(settings(f.app).allRows.find(row => row.id === 'native:native.defaultModel')!.value, /native-alpha\/saved-model/)
  } finally { await f.close() }
})

test('session model_route cannot relabel or reselect the saved-default picker', async () => {
  const f = await fixture()
  try {
    const dialog = await openModel(f)
    f.terminal.type('saved')
    f.backend.emit({ type: 'model_route', sessionId: f.backend.info.sessionId, attachmentId: f.backend.info.attachmentId,
      provider: 'another-session-provider', model: 'another-session-model', reasoningEffort: 'another-session-effort' })
    await paint(f.terminal)
    assert.equal(dialogOf(f.app), dialog)
    assert.equal(/default native-alpha\/saved-model/.test(dialog.render(110).join('\n')), true, 'the default tuple is not the session route')
    assert.equal(/default another-session-provider|Current session route/.test(dialog.render(110).join('\n')), false)
    assert.deepEqual(updates(f.backend), [])
  } finally { await f.close() }
})

test('native model invalidation coalesces, blocks stale Enter, and keeps the default picker/query', async () => {
  const f = await fixture()
  let release = () => {}
  try {
    const dialog = await openModel(f), before = reads(f.backend, 'models')
    f.terminal.type('saved')
    f.backend.modelsGate = new Promise<void>(resolve => { release = resolve })
    f.backend.changed('models')
    await until(() => reads(f.backend, 'models') === before + 1, 'default-model refresh is held')
    f.terminal.type('\r')
    assert.deepEqual(updates(f.backend), [])
    assert.equal(dialog.isDone, false, 'a loading selection must not retire the picker')
    f.backend.catalog[1] = { ...f.backend.catalog[1], label: 'Fresh saved native model' }
    for (let i = 0; i < 10; i++) f.backend.changed('models')
    f.backend.modelsGate = undefined; release()
    await until(() => dialog.render(110).join('\n').includes('Fresh saved native model'), 'one trailing native read refreshes the preserved query')
    assert.equal(reads(f.backend, 'models'), before + 2)
    assert.equal(dialogOf(f.app), dialog)
    assert.doesNotMatch(dialog.render(110).join('\n'), /Native Needle/)
    assert.deepEqual(updates(f.backend), [])
    f.terminal.type('\r')
    await until(() => f.backend.writes === 1, 'only the refreshed selection may save')
  } finally { release(); f.backend.modelsGate = undefined; await f.close() }
})

test('default-effort refresh blocks stale digit and later selects the refreshed native value', async () => {
  const f = await fixture()
  let release = () => {}
  try {
    const dialog = await openEffort(f), before = reads(f.backend, 'native-defaults')
    f.backend.defaultsGate = new Promise<void>(resolve => { release = resolve })
    f.backend.changed()
    await until(() => reads(f.backend, 'native-defaults') === before + 1, 'default-effort metadata is held')
    f.terminal.type('2')
    assert.deepEqual(updates(f.backend), [])
    f.backend.revision++
    f.backend.changed()
    f.backend.defaultsGate = undefined; release()
    await until(() => reads(f.backend, 'native-defaults') === before + 2, 'native effort refresh performs one trailing read')
    await paint(f.terminal)
    assert.equal(dialogOf(f.app), dialog)
    f.terminal.type('2')
    await until(() => f.backend.writes === 1, 'fresh native effort selection succeeds')
    assert.equal(updates(f.backend)[0]?.expectedRevision, 12)
  } finally { release(); f.backend.defaultsGate = undefined; await f.close() }
})

test('a dismissed or reattached default picker cannot write or revive from late metadata', async () => {
  const f = await fixture()
  let release = () => {}
  try {
    const dialog = await openModel(f), before = reads(f.backend, 'models')
    f.backend.modelsGate = new Promise<void>(resolve => { release = resolve })
    f.backend.changed('models')
    await until(() => reads(f.backend, 'models') === before + 1, 'a native default picker read is held')
    f.terminal.type('\x1b'); await paint(f.terminal)
    const returned = settings(f.app), closed = reads(f.backend, 'models')
    f.backend.changed('models')
    f.backend.modelsGate = undefined; release(); await paint(f.terminal)
    assert.equal(dialogOf(f.app), returned)
    assert.equal(reads(f.backend, 'models'), closed)
    ;(dialog as unknown as { onSelect(value: string): void }).onSelect('opaque#next')
    assert.deepEqual(updates(f.backend), [], 'the obsolete surface callback is attachment/surface guarded')
    f.backend.emit({ type: 'ready', info: { ...f.backend.info, sessionId: 'replacement-root', attachmentId: 'replacement-attachment' } })
    ;(dialog as unknown as { onSelect(value: string): void }).onSelect('opaque#next')
    assert.deepEqual(updates(f.backend), [])
    await paint(f.terminal)
    assert.equal(dialogOf(f.app), undefined)
  } finally { release(); f.backend.modelsGate = undefined; await f.close() }
})

test('default metadata failures are unavailable rather than an endless loading or current-session fallback', async () => {
  const f = await fixture()
  try {
    f.backend.defaultsFailure = new Error('Native default state cannot be read.')
    const dialog = await selectRow(f, 'native.defaultModel', 'default model')
    assert.equal(dialog.activeRow?.available, false)
    assert.match(dialog.activeRow?.value ?? '', /Unavailable/)
    assert.match(dialog.activeRow?.description ?? '', /Native default state cannot be read/)
    f.terminal.type('\r'); await paint(f.terminal)
    assert.equal(dialogOf(f.app), dialog)
    assert.deepEqual(updates(f.backend), [])
    assert.equal(reads(f.backend, 'efforts'), 0)
  } finally { await f.close() }
})

test('unreadable old effort metadata disables effort but leaves Default model repair selectable', async () => {
  const f = await fixture()
  try {
    f.backend.reasoning = 'unreadable'
    const original = await selectRow(f, 'native.defaultModel', 'default model')
    assert.equal(original.activeRow?.available, true)
    assert.equal(original.allRows.find(row => row.id === 'native:native.defaultEffort')?.available, false)
    f.terminal.type('\r'); await paint(f.terminal)
    const dialog = dialogOf(f.app)
    assert.ok(dialog instanceof ModelPickerDialog)
    await until(() => dialog.render(110).join('\n').includes('Saved native model'), 'the model catalog is independent of old effort metadata')
    f.terminal.type('\t'); f.terminal.type('\r')
    await until(() => f.backend.writes === 1 && dialogOf(f.app) instanceof SettingsDialog, 'a native model repair can be submitted')
    assert.equal(updates(f.backend)[0]?.value, 'opaque#next')
    assert.equal(f.app.session?.model, 'session-model')
    assert.equal(reads(f.backend, 'efforts'), 0)
  } finally { await f.close() }
})

test('default model catalog failure stays visible, unselectable and locally cancellable', async () => {
  const f = await fixture()
  try {
    f.backend.modelsFailure = new Error('Native model catalog failed.')
    f.terminal.type('catalog failure retained draft')
    const editor = f.app.editor, draft = editor.captureDraft(), transcript = [...f.app.store.items]
    await selectRow(f, 'native.defaultModel', 'default model')
    f.terminal.type('\r'); await paint(f.terminal)
    const dialog = dialogOf(f.app)
    assert.ok(dialog instanceof ModelPickerDialog)
    await until(() => dialog.render(110).join('\n').includes('Native model catalog failed'), 'failure is displayed in the owning default picker')
    f.terminal.type('\r')
    assert.equal(dialog.isDone, false)
    assert.deepEqual(updates(f.backend), [])
    f.terminal.type('\x03'); await paint(f.terminal)
    assert.ok(dialogOf(f.app) instanceof SettingsDialog)
    assert.equal(f.backend.cancels, 0)
    assert.equal(f.app.editor, editor)
    assert.deepEqual(editor.captureDraft(), draft)
    assert.deepEqual(f.app.store.items, transcript)
  } finally { await f.close() }
})

test('default model neutral reader validates native reasoning metadata and preserves reset provenance', () => {
  const backend = new DefaultSettingsBackend('/owned-fixture')
  const good = backend.defaults()
  assert.ok(readNativeDefaults(good))
  const base = (good.targets as JsonRecord[])[0]!
  for (const patch of [
    { target: 'provider-credentials' }, { provider: 5 }, { model: null }, { reasoningEffort: 1 },
    { reasoningSupported: 'yes' }, { reasoningAvailable: 'yes' }, { defaultReasoningEffort: false },
    { reasoningEfforts: [{ id: 'native', label: 7 }] }, { reasoningEfforts: [{ id: 7 }] },
  ]) assert.equal(readNativeDefaults({ available: true, targets: [{ ...base, ...patch }] }), undefined)
  const reset = readNativeDefaults({ available: true, targets: [{ ...base, reasoningEffort: undefined, effectiveReasoningEffort: 'balanced-native' }] })
  assert.ok(reset)
  assert.equal(reset.targets[0]?.reasoningEffort, undefined, 'effective provider default is not promoted into a persisted override')
})
