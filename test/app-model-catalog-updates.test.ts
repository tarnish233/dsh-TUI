import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import { ModelPickerDialog } from '../src/ui/model-picker.ts'
import type { Backend, BackendEvent, JsonRecord, SessionInfo } from '../src/backend/types.ts'
import { delay, until, VirtualTerminal } from './helpers/terminal.ts'

class ModelCatalogBackend implements Backend {
  readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly info: SessionInfo
  reads = 0
  selections = 0
  gate?: Promise<void>
  models: JsonRecord[] = [
    { id: 'fixture/current', provider: 'fixture', model: 'current', label: 'Keep target' },
    { id: 'fixture/other', provider: 'fixture', model: 'other', label: 'Unrelated target' },
  ]
  constructor(cwd: string) {
    this.info = { sessionId: 'models-root', attachmentId: 'models-attachment', cwd,
      provider: 'fixture', model: 'current', capabilities: ['commands', 'models'], events: [] }
  }
  onEvent(listener: (event: BackendEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event?: BackendEvent): void { for (const listener of this.listeners) listener(event ?? {
    type: 'models_changed', sessionId: this.info.sessionId, attachmentId: this.info.attachmentId,
  }) }
  async connect(): Promise<SessionInfo> { return this.info }
  async send(): Promise<void> { throw new Error('Model metadata test must not send a prompt') }
  async cancel(): Promise<void> {}
  async respond(): Promise<void> { throw new Error('Model metadata test must not answer a decision') }
  async close(): Promise<void> {}
  async command(name: string): Promise<unknown> {
    if (name === 'commands') return []
    if (name === 'auto-title') return { available: false }
    if (name === 'state') return { queued: 0, queue: [], pending: { nextTurn: 0, nextStep: 0 } }
    if (name === 'models') {
      this.reads++
      const snapshot = this.models.map(row => ({ ...row }))
      await this.gate
      return snapshot
    }
    if (name === 'model') { this.selections++; throw new Error('No model selection is authorized by a catalog refresh') }
    throw new Error('Unexpected command: ' + name)
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-catalog-ui-'))
  const terminal = new VirtualTerminal(110, 36)
  const backend = new ModelCatalogBackend(directory)
  const app = new App({ backend, terminal, cwd: directory, configDir: directory, registerSignals: false })
  await app.start()
  return { app, backend, terminal, async close() {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  } }
}
const panel = (app: App): ModelPickerDialog => {
  const value = (app as unknown as { dialog?: unknown }).dialog
  assert.ok(value instanceof ModelPickerDialog)
  return value
}
async function paint(terminal: VirtualTerminal): Promise<void> { await delay(25); await terminal.flush() }

test('native catalog invalidation refreshes an open picker while preserving query, focus and main draft', async () => {
  const f = await fixture()
  try {
    f.terminal.type('root draft 中文')
    const editor = f.app.editor, before = editor.captureDraft()
    await f.app.submit('/model')
    const dialog = panel(f.app)
    f.terminal.type('keep')
    await paint(f.terminal)
    assert.match(dialog.render(110).join('\n'), /Keep target/)
    f.backend.models = [
      { id: 'fixture/current', provider: 'fixture', model: 'current', label: 'Keep target updated' },
      { id: 'fixture/new', provider: 'fixture', model: 'new', label: 'Unrelated newly registered' },
    ]
    f.backend.emit()
    await until(() => dialog.render(110).join('\n').includes('Keep target updated'), 'the current native picker metadata refreshes')
    assert.equal(panel(f.app), dialog)
    assert.equal(dialog.focused, true)
    assert.doesNotMatch(dialog.render(110).join('\n'), /Unrelated newly registered/, 'the same query remains active')
    assert.equal(f.app.editor, editor)
    assert.deepEqual(editor.captureDraft(), before)
    assert.equal(f.backend.selections, 0)
  } finally { await f.close() }
})

test('a model catalog registration burst coalesces one trailing read and cannot paint an invalidated response', async () => {
  const f = await fixture()
  let release = () => {}
  try {
    await f.app.submit('/model')
    const dialog = panel(f.app), reads = f.backend.reads
    f.backend.gate = new Promise<void>(resolve => { release = resolve })
    f.backend.models = [{ id: 'fixture/obsolete', provider: 'fixture', model: 'obsolete', label: 'Obsolete model' }]
    f.backend.emit()
    await until(() => f.backend.reads === reads + 1, 'a catalog request is actually held')
    f.backend.models = [{ id: 'fixture/current', provider: 'fixture', model: 'current', label: 'Fresh model' }]
    for (let count = 0; count < 10; count++) f.backend.emit()
    assert.equal(f.backend.reads, reads + 1)
    f.backend.gate = undefined; release()
    await until(() => dialog.render(110).join('\n').includes('Fresh model'), 'one trailing native read provides current metadata')
    assert.equal(f.backend.reads, reads + 2)
    assert.doesNotMatch(dialog.render(110).join('\n'), /Obsolete model/)
    assert.equal(f.backend.selections, 0)
  } finally { release(); f.backend.gate = undefined; await f.close() }
})

test('catalog invalidation neither opens a picker nor revives a dismissed/foreign surface', async () => {
  const f = await fixture()
  let release = () => {}
  try {
    f.backend.emit()
    await delay(10)
    assert.equal(f.backend.reads, 0)
    await f.app.submit('/model')
    const reads = f.backend.reads
    f.backend.emit({ type: 'models_changed', sessionId: 'foreign-root', attachmentId: 'models-attachment' })
    f.backend.emit({ type: 'models_changed', sessionId: 'models-root', attachmentId: 'old-attachment' })
    await delay(10)
    assert.equal(f.backend.reads, reads)
    f.backend.gate = new Promise<void>(resolve => { release = resolve })
    f.backend.emit()
    await until(() => f.backend.reads === reads + 1, 'current refresh is held')
    f.terminal.type('\x1b')
    assert.equal(f.app.editor.focused, true)
    const calls = f.backend.reads
    f.backend.emit()
    f.backend.gate = undefined; release()
    await delay(30)
    assert.equal(f.backend.reads, calls)
    assert.equal((f.app as unknown as { dialog?: unknown }).dialog, undefined)
    assert.equal(f.backend.selections, 0)
  } finally { release(); f.backend.gate = undefined; await f.close() }
})
