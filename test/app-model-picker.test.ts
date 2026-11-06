import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, JsonRecord, SessionInfo } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { delay, until, VirtualTerminal } from './helpers/terminal.ts'

/** Parent-owned model-control responses; no Agent, native model calls or persistence. */
class ModelBackend implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly calls: Array<{ name: string; args: JsonRecord }> = []
  readonly modelCalls: string[] = []
  readonly sends: string[] = []
  cancels = 0
  catalogGate?: Promise<void>
  catalog: JsonRecord[] = [
    { id: 'opaque-alpha-shared', provider: 'alpha', model: 'shared', label: 'Shared Alpha' },
    { id: 'opaque-alpha-needle', provider: 'alpha', model: 'alpha-only', label: 'Alpha Needle', description: 'Search Alpha description' },
    { id: 'opaque-beta-shared', provider: 'beta', model: 'shared', label: 'Shared Beta' },
    { id: 'opaque-beta-needle', provider: 'beta', model: 'beta-only', label: 'Beta Needle', description: 'Search Beta description' },
  ]
  info: SessionInfo
  constructor(cwd: string) {
    this.info = { sessionId: 'model-picker-session', attachmentId: 'model-picker-attachment', cwd, provider: 'alpha', model: 'shared', preset: 'standard', permissions: { currentValue: 'workspace-write' }, capabilities: ['commands', 'models', 'state'], events: [] }
  }
  onEvent(listener: (event: BackendEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent) { for (const listener of this.listeners) listener(event) }
  async connect() { this.emit({ type: 'ready', info: this.info }); return this.info }
  async send(text: string) { this.sends.push(text) }
  async respond() { throw new Error('model picker never answers decisions') }
  async close() {}
  async cancel() { this.cancels++; this.emit({ type: 'status', sessionId: this.info.sessionId, status: 'idle' }) }
  async command(name: string, args: JsonRecord = {}): Promise<unknown> {
    this.calls.push({ name, args })
    if (name === 'commands') return []
    if (name === 'state') return { pending: { nextTurn: 0, nextStep: 0 }, queued: 0 }
    if (name === 'auto-title') return { available: false }
    if (name === 'models') { const snapshot = this.catalog.map(item => ({ ...item })); await this.catalogGate; return snapshot }
    if (name === 'model') {
      const selected = this.catalog.find(item => item.id === args.id)
      if (!selected) throw new Error('unknown fixture model')
      this.modelCalls.push(String(selected.id))
      this.info = { ...this.info, provider: String(selected.provider), model: String(selected.model) }
      return { provider: this.info.provider, model: this.info.model, defaultsPersisted: false, defaultPersistence: 'runtime', defaultWarning: 'Expected runtime save scope.' }
    }
    throw new Error('Unexpected control from model picker: ' + name)
  }
}

async function fixture(screen: 'inline' | 'fullscreen' = 'fullscreen', bindings?: JsonRecord) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-model-picker-'))
  if (bindings) await writeFile(join(directory, 'keybindings.json'), JSON.stringify(bindings))
  const backend = new ModelBackend(directory), terminal = new VirtualTerminal(110, 42)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen, registerSignals: false })
  await app.start(); await paint(terminal)
  return { app, backend, terminal, directory, async close() {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  } }
}
async function paint(terminal: VirtualTerminal) { await delay(35); await terminal.flush() }
async function open(f: Awaited<ReturnType<typeof fixture>>) { await f.app.submit('/model'); await paint(f.terminal); assert.match(f.terminal.screen(), /Choose model/) }

for (const screen of ['inline', 'fullscreen'] as const) {
  test('parent model picker: provider tabs/search keep main draft and choose the native opaque ID (' + screen + ')', async () => {
    const f = await fixture(screen)
    try {
      f.terminal.type('draft before models 中文 ')
      f.terminal.type('\x1b[200~' + 'lossless draft paste\n'.repeat(35) + '\x1b[201~')
      f.terminal.type('\x02')
      const editor = f.app.editor, draft = editor.captureDraft(), before = [...f.app.store.items]
      await open(f)
      assert.match(f.terminal.screen(), /Shared Alpha/)
      assert.doesNotMatch(f.terminal.screen(), /Shared Beta/)
      f.terminal.type('\t'); await paint(f.terminal)
      assert.match(f.terminal.screen(), /Shared Beta/)
      assert.doesNotMatch(f.terminal.screen(), /Shared Alpha/)
      f.terminal.type('\x1b[Z'); await paint(f.terminal)
      assert.match(f.terminal.screen(), /Shared Alpha/)
      f.terminal.type('\x1b[C'); await paint(f.terminal)
      assert.match(f.terminal.screen(), /Shared Beta/)
      f.terminal.type('\x1b[D'); await paint(f.terminal)
      assert.match(f.terminal.screen(), /Shared Alpha/)
      f.terminal.type('nEeDlE'); await paint(f.terminal)
      assert.match(f.terminal.screen(), /Alpha Needle/)
      assert.doesNotMatch(f.terminal.screen(), /Shared Alpha/)
      f.terminal.type('\t'); await paint(f.terminal)
      assert.match(f.terminal.screen(), /Beta Needle/)
      assert.doesNotMatch(f.terminal.screen(), /Shared Beta/)
      assert.deepEqual(f.backend.modelCalls, [], 'navigation/search does not change the native route')
      assert.equal(f.app.session?.permissions?.currentValue, 'workspace-write', 'Shift+Tab in this panel is not permission switching')
      assert.deepEqual(f.backend.sends, [])
      assert.deepEqual(f.app.store.items, before)
      f.terminal.resize(40, 22); await paint(f.terminal)
      f.terminal.resize(110, 42); await paint(f.terminal)
      f.terminal.type('\r')
      await until(() => f.app.session?.provider === 'beta' && f.app.session.model === 'beta-only', 'one confirmed native selection applies')
      await paint(f.terminal)
      assert.deepEqual(f.backend.modelCalls, ['opaque-beta-needle'], 'IDs are not synthesized or parsed by the frontend')
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), draft)
      assert.deepEqual(f.app.store.items, before, 'successful model switch remains quiet')
      assert.equal(editor.focused, true)
    } finally { await f.close() }
  })
}

test('parent model picker: typing j/k/digits searches, never quick-selects a list item', async () => {
  const f = await fixture()
  try {
    f.backend.catalog.push({ id: 'opaque-literal', provider: 'alpha', model: 'literal', label: 'Literal jk42' })
    await open(f)
    f.terminal.type('jk42'); await paint(f.terminal)
    assert.deepEqual(f.backend.modelCalls, [])
    assert.match(f.terminal.screen(), /Literal jk42/)
    assert.doesNotMatch(f.terminal.screen(), /Shared Alpha/)
    f.terminal.type('\r')
    await until(() => f.backend.modelCalls.length === 1, 'Enter explicitly confirms the filtered literal match')
    assert.deepEqual(f.backend.modelCalls, ['opaque-literal'])
  } finally { await f.close() }
})

test('parent model picker: standard character movement edits search rather than switching providers', async () => {
  const f = await fixture()
  try {
    f.backend.catalog.push(
      { id: 'opaque-abc', provider: 'alpha', model: 'abc', label: 'Alpha exact abc' },
      { id: 'opaque-abxc', provider: 'alpha', model: 'abxc', label: 'Alpha edited abxc' },
    )
    await open(f)
    f.terminal.type('abc'); f.terminal.type('\x02'); f.terminal.type('x'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /Alpha edited abxc/)
    assert.doesNotMatch(f.terminal.screen(), /Alpha exact abc/)
    assert.deepEqual(f.backend.modelCalls, [])
    f.terminal.type('\x05'); f.terminal.type('\x15'); await paint(f.terminal)
    f.terminal.type('abc'); f.terminal.type('\x1b[D'); f.terminal.type('x'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /Alpha edited abxc/, 'Left in the query is readline cursor movement')
    f.terminal.type('\x05'); f.terminal.type('\x15'); f.terminal.type('\x1b[C'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /Shared Alpha/, 'empty search retains editing focus; Right is not a provider switch')
    assert.doesNotMatch(f.terminal.screen(), /Shared Beta/)
  } finally { await f.close() }
})

test('parent model picker: Ctrl+W, yank, word kill and undo share the original readline search state', async () => {
  const f = await fixture()
  try {
    f.backend.catalog.push(
      { id: 'native/src/utils/foo.ts', provider: 'alpha', model: 'file-ts', label: 'TS route' },
      { id: 'native/src/utils/foo.js', provider: 'alpha', model: 'file-js', label: 'JS route' },
    )
    await open(f)
    f.terminal.type('src/utils/foo.ts'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /TS route/)
    assert.doesNotMatch(f.terminal.screen(), /JS route/)
    f.terminal.type('\x17'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /Shared Alpha/, 'Ctrl+W deletes the whole whitespace-delimited path')
    f.terminal.type('\x19'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /TS route/)
    assert.doesNotMatch(f.terminal.screen(), /Shared Alpha/)
    f.terminal.type('\x1b\x7f'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /TS route/)
    assert.match(f.terminal.screen(), /JS route/, 'ordinary word kill removes only the punctuation-delimited suffix')
    assert.doesNotMatch(f.terminal.screen(), /Shared Alpha/)
    f.terminal.type('\x1f'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /TS route/)
    assert.doesNotMatch(f.terminal.screen(), /JS route/, 'undo restores the original suffix in the same editor state')
  } finally { await f.close() }
})

test('parent model picker: no matches cannot confirm a stale hidden model', async () => {
  const f = await fixture()
  try {
    await open(f)
    f.terminal.type('definitely-no-model'); f.terminal.type('\r'); await paint(f.terminal)
    assert.deepEqual(f.backend.modelCalls, [])
    assert.equal(f.app.editor.focused, false)
    f.terminal.type('\x1b'); await paint(f.terminal)
    assert.equal(f.app.editor.focused, true)
  } finally { await f.close() }
})

test('parent model picker: registered provider remaps/disable are honored and do not resurrect permission shortcuts', async () => {
  const f = await fixture('fullscreen', { 'model.provider.next': 'ctrl+q', 'model.provider.previous': null, 'model.provider.nextArrow': null, 'model.provider.previousArrow': null })
  try {
    await open(f)
    f.terminal.type('needle'); f.terminal.type('\t'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /Alpha Needle/, 'disabled/default Tab fallback does not switch a provider')
    f.terminal.type('\x11'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /Beta Needle/)
    f.terminal.type('\x1b[Z'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /Beta Needle/)
    assert.equal(f.app.session?.permissions?.currentValue, 'workspace-write')
    assert.deepEqual(f.backend.modelCalls, [])
    assert.ok(f.backend.calls.every(call => ['models', 'commands', 'state', 'auto-title'].includes(call.name)))
  } finally { await f.close() }
})

test('parent model picker: fragmented query paste containing Ctrl+C does not reach global cancellation', async () => {
  const f = await fixture()
  try {
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'running' })
    await open(f)
    f.terminal.type('\x1b[20'); f.terminal.type('0~'); f.terminal.type('query'); f.terminal.type('\x03'); f.terminal.type('\x1b[201~')
    await paint(f.terminal)
    assert.equal(f.backend.cancels, 0, 'pasted Ctrl+C is query text, not a global shortcut')
    assert.deepEqual(f.backend.modelCalls, [])
    assert.deepEqual(f.backend.sends, [])
    f.terminal.type('\x03')
    await until(() => f.backend.cancels === 1 && !f.app.isBusy, 'real Ctrl+C outside paste remains global')
  } finally { await f.close() }
})

test('parent model picker: a long roster keeps the selected row, query and footer visible on a short terminal', async () => {
  const f = await fixture()
  try {
    f.backend.catalog = Array.from({ length: 100 }, (_, index) => ({ id: 'opaque-' + index, provider: 'alpha', model: 'item-' + index, label: 'Catalog item ' + index }))
    f.backend.info = { ...f.backend.info, model: 'item-50' }
    f.backend.emit({ type: 'ready', info: f.backend.info })
    f.terminal.resize(80, 22); await paint(f.terminal)
    await open(f)
    assert.match(f.terminal.screen(), /Search/)
    assert.match(f.terminal.screen(), /Catalog item 50/)
    assert.match(f.terminal.screen(), /item-50 · ready/, 'App footer must not be cropped by a full-terminal panel')
    f.terminal.type('\x1b[F'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /Catalog item 99/, 'last selected result stays visible')
    assert.match(f.terminal.screen(), /item-50 · ready/)
  } finally { await f.close() }
})

test('parent model picker: a late model roster cannot replace Settings', async () => {
  const f = await fixture()
  try {
    let release!: () => void
    f.backend.catalogGate = new Promise(resolve => { release = resolve })
    const opening = f.app.submit('/model')
    await until(() => f.backend.calls.some(call => call.name === 'models'), 'model catalog request is actually pending')
    await f.app.submit('/settings'); await paint(f.terminal)
    release(); await opening; await paint(f.terminal)
    assert.match(f.terminal.screen(), /Settings/)
    assert.doesNotMatch(f.terminal.screen(), /Choose model/)
  } finally { await f.close() }
})
