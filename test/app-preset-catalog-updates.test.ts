import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import { SelectDialog } from '../src/ui/dialogs.ts'
import type { Backend, BackendEvent, JsonRecord, SessionInfo } from '../src/backend/types.ts'
import { delay, until, VirtualTerminal } from './helpers/terminal.ts'

class PresetCatalogBackend implements Backend {
  readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly info: SessionInfo
  reads = 0
  selections = 0
  gate?: Promise<void>
  fail = false
  catalog: JsonRecord[] = [
    { id: 'standard', name: 'Standard', isDefault: true },
    { id: 'minimal', name: 'Minimal' },
  ]
  constructor(cwd: string) {
    this.info = { sessionId: 'preset-root', attachmentId: 'preset-attachment', cwd,
      provider: 'fixture', model: 'current', capabilities: ['commands', 'presets'], events: [] }
  }
  onEvent(listener: (event: BackendEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event?: BackendEvent): void { for (const listener of this.listeners) listener(event ?? {
    type: 'presets_changed', sessionId: this.info.sessionId, attachmentId: this.info.attachmentId,
  }) }
  async connect(): Promise<SessionInfo> { return this.info }
  async send(): Promise<void> { throw new Error('Metadata refresh may not send a prompt') }
  async cancel(): Promise<void> {}
  async respond(): Promise<void> { throw new Error('Metadata refresh may not answer a decision') }
  async close(): Promise<void> {}
  async command(name: string): Promise<unknown> {
    if (name === 'commands') return []
    if (name === 'auto-title') return { available: false }
    if (name === 'state') return { queued: 0, queue: [], pending: { nextTurn: 0, nextStep: 0 } }
    if (name === 'presets') {
      this.reads++
      const snapshot = { current: 'standard', blank: true, presets: this.catalog.map(row => ({ ...row })) }
      await this.gate
      if (this.fail) throw new Error('Synthetic native preset catalog read failed')
      return snapshot
    }
    if (name === 'preset') { this.selections++; throw new Error('Metadata refresh may not select a preset') }
    throw new Error('Unexpected command: ' + name)
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-preset-ui-'))
  const terminal = new VirtualTerminal(110, 36)
  const backend = new PresetCatalogBackend(directory)
  const app = new App({ backend, terminal, cwd: directory, configDir: directory, registerSignals: false })
  await app.start()
  return { app, backend, terminal, async close() {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  } }
}
function dialog(app: App): SelectDialog {
  const value = (app as unknown as { dialog?: unknown }).dialog
  assert.ok(value instanceof SelectDialog)
  return value
}
const selected = (panel: SelectDialog): unknown =>
  (panel as unknown as { items: Array<{ value: unknown }> }).items[panel.selectedIndex]?.value


test('preset metadata refresh preserves the selected native id across insertion/reorder and keeps the root draft', async () => {
  const f = await fixture()
  try {
    f.terminal.type('root draft 中文')
    const editor = f.app.editor, before = editor.captureDraft()
    await f.app.submit('/preset')
    const panel = dialog(f.app)
    f.terminal.type('\x1b[B')
    assert.equal(selected(panel), 'minimal')
    f.backend.catalog = [
      { id: 'new', name: 'New native preset' },
      { id: 'minimal', name: 'Minimal updated' },
      { id: 'standard', name: 'Standard', isDefault: true },
    ]
    f.backend.emit()
    await until(() => panel.render(100).join('\n').includes('Minimal updated'), 'native catalog refresh is visible')
    assert.equal(dialog(f.app), panel)
    assert.equal(selected(panel), 'minimal', 'new rows never change the id under the cursor')
    assert.equal(panel.focused, true)
    assert.equal(f.app.editor, editor)
    assert.deepEqual(editor.captureDraft(), before)
    assert.equal(f.backend.selections, 0)
  } finally { await f.close() }
})

test('preset invalidation burst makes one trailing current read and ignores obsolete catalog data', async () => {
  const f = await fixture()
  let release = () => {}
  try {
    await f.app.submit('/preset')
    const panel = dialog(f.app), reads = f.backend.reads
    f.backend.gate = new Promise<void>(resolve => { release = resolve })
    f.backend.catalog = [{ id: 'obsolete', name: 'Obsolete preset' }]
    f.backend.emit()
    await until(() => f.backend.reads === reads + 1, 'a real metadata read is held')
    f.backend.catalog = [{ id: 'fresh', name: 'Fresh preset' }]
    for (let count = 0; count < 10; count++) f.backend.emit()
    assert.equal(f.backend.reads, reads + 1)
    f.backend.gate = undefined; release()
    await until(() => panel.render(100).join('\n').includes('Fresh preset'), 'one trailing read delivers current native data')
    assert.equal(f.backend.reads, reads + 2)
    assert.doesNotMatch(panel.render(100).join('\n'), /Obsolete preset/)
    assert.equal(f.backend.selections, 0)
  } finally { release(); f.backend.gate = undefined; await f.close() }
})

test('failed preset metadata reads keep native rows and selection; a later event recovers without reopening', async () => {
  const f = await fixture()
  try {
    await f.app.submit('/preset')
    const panel = dialog(f.app)
    f.terminal.type('\x1b[B')
    f.backend.fail = true
    f.backend.emit()
    await until(() => panel.render(100).join('\n').includes('Could not load native presets'), 'read failure is explicit')
    assert.match(panel.render(100).join('\n'), /Minimal/)
    assert.equal(selected(panel), 'minimal')
    assert.equal(panel.focused, true)
    f.backend.fail = false
    f.backend.catalog[1] = { id: 'minimal', name: 'Minimal recovered', isDefault: true }
    f.backend.emit()
    await until(() => panel.render(100).join('\n').includes('Minimal recovered'), 'native metadata recovers')
    assert.doesNotMatch(panel.render(100).join('\n'), /Could not load native presets/)
    assert.equal(dialog(f.app), panel)
    assert.equal(selected(panel), 'minimal')
    assert.equal(f.backend.selections, 0)
  } finally { await f.close() }
})

test('preset metadata invalidation never opens a picker or revives dismissed/foreign surfaces', async () => {
  const f = await fixture()
  let release = () => {}
  try {
    f.backend.emit(); await delay(10)
    assert.equal(f.backend.reads, 0)
    await f.app.submit('/preset')
    const reads = f.backend.reads
    f.backend.emit({ type: 'presets_changed', sessionId: 'foreign-root', attachmentId: 'preset-attachment' })
    f.backend.emit({ type: 'presets_changed', sessionId: 'preset-root', attachmentId: 'old-attachment' })
    await delay(10)
    assert.equal(f.backend.reads, reads)
    f.backend.gate = new Promise<void>(resolve => { release = resolve })
    f.backend.emit()
    await until(() => f.backend.reads === reads + 1, 'current surface read is held')
    f.terminal.type('\x1b')
    assert.equal(f.app.editor.focused, true)
    const closingReads = f.backend.reads
    f.backend.emit()
    f.backend.gate = undefined; release()
    await delay(25)
    assert.equal(f.backend.reads, closingReads)
    assert.equal((f.app as unknown as { dialog?: unknown }).dialog, undefined)
    assert.equal(f.backend.selections, 0)
  } finally { release(); f.backend.gate = undefined; await f.close() }
})

test('native model route metadata is current-attachment-only, updates the footer and never chooses a model', async () => {
  const f = await fixture()
  try {
    const root = f.app.session?.sessionId, attachment = f.app.session?.attachmentId
    const draft = f.app.editor.captureDraft()
    f.backend.emit({ type: 'model_route', sessionId: 'foreign-root', provider: 'other', model: 'foreign' })
    assert.equal(f.app.session?.model, 'current')
    f.backend.emit({ type: 'model_route', sessionId: String(root), attachmentId: 'old', provider: 'other', model: 'old' })
    assert.equal(f.app.session?.model, 'current')
    f.backend.emit({ type: 'model_route', sessionId: String(root), attachmentId: attachment, provider: 'native', model: 'followed', reasoningEffort: 'high' })
    assert.equal(f.app.session?.provider, 'native')
    assert.equal(f.app.session?.model, 'followed')
    assert.equal(f.app.session?.reasoningEffort, 'high')
    f.backend.emit({ type: 'model_route', sessionId: String(root), attachmentId: attachment, provider: '', model: '' })
    assert.equal(f.app.session?.model, '')
    assert.equal(f.app.session?.reasoningEffort, undefined, 'unknown native route does not keep a stale effort')
    assert.deepEqual(f.app.editor.captureDraft(), draft)
    assert.equal(f.backend.selections, 0)
  } finally { await f.close() }
})
