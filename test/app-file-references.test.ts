import './helpers/truecolor.ts'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, FileReferenceCandidate, JsonRecord, SessionInfo } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { VirtualTerminal, delay, until } from './helpers/terminal.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

class FileReferenceBackend implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly queries: Array<{ query: string; signal: AbortSignal | undefined }> = []
  readonly sent: string[] = []
  info: SessionInfo
  candidates: readonly FileReferenceCandidate[] = []
  gate?: Promise<readonly FileReferenceCandidate[]>
  failure?: Error

  constructor(cwd: string) {
    this.info = {
      sessionId: 'file-reference-root', attachmentId: 'file-reference-attachment', cwd,
      provider: 'fixture', model: 'fixture', capabilities: ['file-references'], events: [],
    }
  }

  onEvent(listener: (event: BackendEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent) { for (const listener of this.listeners) listener(event) }
  async connect() { this.emit({ type: 'ready', info: this.info }); return this.info }
  async listFileReferences(query: string, signal?: AbortSignal) {
    this.queries.push({ query, signal })
    const value = this.gate === undefined ? this.candidates : await this.gate
    if (signal?.aborted) throw new Error('fixture file-reference request aborted')
    if (this.failure !== undefined) throw this.failure
    return value
  }
  async send(text: string) { this.sent.push(text) }
  async cancel() {}
  async respond() {}
  async close() {}
  async command(name: string, _args: JsonRecord = {}) { throw new Error('Unexpected fixture command: ' + name) }
}

async function fixture(screen: 'inline' | 'fullscreen', capabilities: string[] = ['file-references']) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-app-file-references-'))
  const backend = new FileReferenceBackend(directory)
  backend.info = { ...backend.info, capabilities }
  const terminal = new VirtualTerminal(120, 42)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen, registerSignals: false })
  await app.start(); await delay(30); await terminal.flush()
  return { app, backend, terminal, directory, async close() {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  } }
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`App @file completion uses native candidates and Enter stays fill-only (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.backend.candidates = [{ path: 'src/reference-target.ts', kind: 'file' }]
      f.terminal.type('@reference-t')
      await until(() => f.app.editor.isShowingAutocomplete(), 'native @file menu')
      await delay(20); await f.terminal.flush()
      assert.match(f.terminal.screen(), /reference-target\.ts/)
      assert.deepEqual(f.backend.queries.map(item => item.query).at(-1), 'reference-t')
      assert.equal(f.backend.queries.at(-1)?.signal?.aborted, false)
      assert.deepEqual(f.backend.sent, [])

      f.terminal.type('\r')
      assert.equal(f.app.editor.getText(), '@src/reference-target.ts ')
      assert.equal(f.app.editor.isShowingAutocomplete(), false)
      assert.equal(f.app.editor.hasFileAttachments(), false, '@path is ordinary native mention text, not /attach')
      assert.deepEqual(f.backend.sent, [], 'accepting a file candidate does not submit')

      f.terminal.type('\r')
      await until(() => f.backend.sent.length === 1, 'second Enter submits the completed mention')
      assert.deepEqual(f.backend.sent, ['@src/reference-target.ts'])
    } finally { await f.close() }
  })
}

test('native file-reference lookup failures stay out of the prompt transcript', async () => {
  const f = await fixture('fullscreen')
  try {
    f.backend.failure = new Error('synthetic native candidate failure')
    const notices = f.app.store.items.length
    f.terminal.type('@broken')
    await until(() => f.backend.queries.length > 0, 'failed native candidate query')
    await delay(50); await f.terminal.flush()
    assert.equal(f.app.editor.isShowingAutocomplete(), false)
    assert.equal(f.app.editor.getText(), '@broken')
    assert.equal(f.app.store.items.length, notices, 'high-frequency completion failures are intentionally quiet')
  } finally { await f.close() }
})

test('App never calls an unmounted native file-reference capability', async () => {
  const f = await fixture('fullscreen', [])
  try {
    f.backend.candidates = [{ path: 'must-not-appear.ts', kind: 'file' }]
    f.terminal.type('@must')
    await delay(80); await f.terminal.flush()
    assert.equal(f.app.editor.isShowingAutocomplete(), false)
    assert.deepEqual(f.backend.queries, [])
    assert.equal(f.app.editor.getText(), '@must')
  } finally { await f.close() }
})

test('late native @file candidates cannot reopen a replacement attachment editor', async () => {
  const f = await fixture('fullscreen')
  const gate = deferred<readonly FileReferenceCandidate[]>()
  try {
    f.backend.gate = gate.promise
    const retired = f.app.editor
    f.terminal.type('@retired')
    await until(() => f.backend.queries.length === 1, 'in-flight native file-reference query')

    f.backend.info = { ...f.backend.info, attachmentId: 'replacement-file-reference-attachment', events: [] }
    f.backend.emit({ type: 'ready', info: f.backend.info })
    assert.notEqual(f.app.editor, retired)
    f.terminal.type('new attachment draft')
    gate.resolve([{ path: 'retired-only.ts', kind: 'file' }])
    await delay(80); await f.terminal.flush()

    assert.equal(f.app.editor.getText(), 'new attachment draft')
    assert.equal(f.app.editor.isShowingAutocomplete(), false)
    assert.deepEqual(f.backend.sent, [])
  } finally { gate.resolve([]); await f.close() }
})
