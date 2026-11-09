/** Parent-owned UI/native-contract regression checks. All I/O is in an owned temp workspace. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, ImageAttachmentRef, JsonRecord, SessionInfo } from '../src/backend/types.ts'
import { HelpPanel } from '../src/ui/help.ts'
import { delay, modalScreen, until, VirtualTerminal } from './helpers/terminal.ts'

class AuditBackend implements Backend {
  readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly calls: Array<{ name: string; args: JsonRecord }> = []
  catalog: JsonRecord[] = []
  catalogReads = 0
  catalogGate?: Promise<void>
  closeGate?: Promise<void>
  closes = 0
  sends = 0
  imageReads = 0
  queued = 0
  dequeueResult: unknown[] = []
  permissionOptions: JsonRecord[] = []
  sessions: JsonRecord[] = []
  readonly titleCalls: string[][] = []
  titleResult: (ids: string[]) => unknown = ids => ids.map(sessionId => ({ sessionId, title: null }))
  info: SessionInfo

  constructor(cwd: string) {
    this.info = { sessionId: 'audit-root', attachmentId: 'audit-attachment-1', cwd,
      provider: 'fixture', model: 'fixture', events: [], capabilities: ['commands', 'state', 'sessions', 'titles', 'permissions', 'execute', 'dequeue'] }
  }
  onEvent(listener: (event: BackendEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent): void { for (const listener of this.listeners) listener(event) }
  invalidate(): void { this.emit({ type: 'commands_changed', sessionId: this.info.sessionId, attachmentId: this.info.attachmentId }) }
  async connect(): Promise<SessionInfo> { this.emit({ type: 'ready', info: this.info }); return this.info }
  async send(): Promise<void> { this.sends++; throw new Error('No model prompts are allowed in this fixture') }
  async cancel(): Promise<void> {}
  async respond(): Promise<void> { throw new Error('No decisions are submitted in this fixture') }
  async close(): Promise<void> { this.closes++; await this.closeGate }
  async readImage(_attachment: ImageAttachmentRef): Promise<never> { this.imageReads++; throw new Error('No image reads are allowed in this fixture') }
  async command(name: string, args: JsonRecord = {}): Promise<unknown> {
    this.calls.push({ name, args })
    if (name === 'commands') {
      this.catalogReads++
      const snapshot = this.catalog.map(row => ({ ...row }))
      await this.catalogGate
      return snapshot
    }
    if (name === 'auto-title') return { available: false }
    if (name === 'state') return { queued: this.queued,
      queue: this.queued > 0 ? [{ messageId: 'file-inbox', text: 'Native queued input', target: 'next-turn', images: 0 }] : [],
      pending: { nextTurn: this.queued, nextStep: 0 } }
    if (name === 'dequeue') return this.dequeueResult
    if (name === 'permissions') return { currentValue: 'workspace-write', options: this.permissionOptions }
    if (name === 'sessions') return this.sessions
    if (name === 'titles') {
      const ids = Array.isArray(args.ids) ? args.ids.filter((id): id is string => typeof id === 'string') : []
      this.titleCalls.push(ids)
      return this.titleResult(ids)
    }
    throw new Error('Unexpected control call: ' + name)
  }
}

async function fixture(screen: 'inline' | 'fullscreen' = 'fullscreen', prepare?: (backend: AuditBackend) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-native-audit-fix-'))
  const terminal = new VirtualTerminal(110, 36)
  const backend = new AuditBackend(directory)
  prepare?.(backend)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen, registerSignals: false })
  try { await app.start(); await paint(terminal) }
  catch (error) { await app.shutdown(1); terminal.dispose(); await rm(directory, { recursive: true, force: true }); throw error }
  return { app, backend, terminal, directory, async close() {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  } }
}
async function paint(terminal: VirtualTerminal): Promise<void> { await delay(35); await terminal.flush() }
const notices = (app: App): string => app.store.items.filter(item => item.kind === 'notice').map(item => item.text).join('\n')

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`App commands/change: a newly registered command refreshes an active missing-prefix menu without editing (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.terminal.type('/late-nat')
      await delay(0)
      assert.equal(f.app.editor.isShowingAutocomplete(), false)
      const editor = f.app.editor, draft = editor.captureDraft()
      const reads = f.backend.catalogReads
      f.backend.catalog = [{ name: 'late-native', description: 'Late native registration', input: { hint: '<scope>' } }]
      f.backend.invalidate()
      await until(() => editor.isShowingAutocomplete(), 'native invalidation reopens the still-active missing-prefix query')
      assert.equal(f.backend.catalogReads, reads + 1)
      assert.match(editor.render(100).join('\n'), /late-native/)
      assert.match(editor.render(100).join('\n'), /<scope>/, 'native hint survives App mapping and provider consumption')
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), draft)
      assert.equal(f.backend.sends, 0)
      assert.equal(f.backend.calls.some(call => call.name === 'execute'), false)
    } finally { await f.close() }
  })
}

test('App commands/change: a registration burst coalesces and invalidated reads cannot paint a stale roster', async () => {
  const f = await fixture()
  let release = () => {}
  try {
    const reads = f.backend.catalogReads
    f.backend.catalogGate = new Promise<void>(resolve => { release = resolve })
    f.backend.catalog = [{ name: 'late-old', description: 'Obsolete snapshot' }]
    f.backend.invalidate()
    await until(() => f.backend.catalogReads === reads + 1, 'the first catalog read is blocked')
    f.terminal.type('/late-n')
    const draft = f.app.editor.captureDraft()
    f.backend.catalog = [{ name: 'late-new', description: 'Current registration' }]
    for (let count = 0; count < 12; count++) f.backend.invalidate()
    assert.equal(f.backend.catalogReads, reads + 1, 'burst adds no overlapping reads')
    f.backend.catalogGate = undefined
    release()
    await until(() => f.app.editor.isShowingAutocomplete(), 'one trailing fresh roster fills the active query')
    assert.equal(f.backend.catalogReads, reads + 2)
    assert.match(f.app.editor.render(100).join('\n'), /late-new/)
    assert.doesNotMatch(f.app.editor.render(100).join('\n'), /late-old/)
    assert.deepEqual(f.app.editor.captureDraft(), draft)
  } finally { release(); f.backend.catalogGate = undefined; await f.close() }
})

test('App commands/change: Escape-dismissed autocomplete and foreign attachments are not revived', async () => {
  const f = await fixture('fullscreen', backend => { backend.catalog = [{ name: 'late-a', description: 'Initial entry' }] })
  try {
    f.terminal.type('/late')
    await until(() => f.app.editor.isShowingAutocomplete(), 'initial menu opens')
    f.terminal.type('\x1b')
    assert.equal(f.app.editor.isShowingAutocomplete(), false)
    const draft = f.app.editor.captureDraft(), reads = f.backend.catalogReads
    f.backend.emit({ type: 'commands_changed', sessionId: 'foreign-root', attachmentId: 'audit-attachment-1' })
    f.backend.emit({ type: 'commands_changed', sessionId: 'audit-root', attachmentId: 'old-attachment' })
    await delay(20)
    assert.equal(f.backend.catalogReads, reads)
    f.backend.catalog.push({ name: 'late-b', description: 'Additional entry' })
    f.backend.invalidate()
    await until(() => f.backend.catalogReads === reads + 1, 'current invalidation is read')
    await paint(f.terminal)
    assert.equal(f.app.editor.isShowingAutocomplete(), false)
    assert.deepEqual(f.app.editor.captureDraft(), draft)
  } finally { await f.close() }
})

test('App commands/change: Help updates in place while keeping the focused search and underlying draft', async () => {
  const f = await fixture()
  try {
    f.terminal.type('unchanged root draft 中文')
    const draft = f.app.editor.captureDraft()
    await f.app.submit('/help')
    await paint(f.terminal)
    const panel = (f.app as unknown as { dialog?: unknown }).dialog
    assert.ok(panel instanceof HelpPanel)
    f.terminal.type('\x06'); f.terminal.type('late')
    await paint(f.terminal)
    assert.equal(panel.searching, true)
    f.backend.catalog = [{ name: 'late-native', description: 'Arrived while searching' }]
    f.backend.invalidate()
    await until(() => panel.render(110).join('\n').includes('late-native'), 'Help receives the fresh read-only catalog')
    assert.equal((f.app as unknown as { dialog?: unknown }).dialog, panel)
    assert.equal(panel.searching, true)
    assert.equal(panel.focused, true)
    assert.deepEqual(f.app.editor.captureDraft(), draft)
    assert.equal(f.backend.sends, 0)
    assert.equal(notices(f.app), '')
  } finally { await f.close() }
})

test('App permission picker: native name wins over a conflicting label and confirmation remains explicit', async () => {
  const f = await fixture('fullscreen', backend => {
    backend.permissionOptions = [
      { value: 'workspace-write', name: '允许工作区编辑', label: 'Wrong label field', description: 'Native localized option' },
      { value: 'strict', name: '', description: 'Missing display name falls back to the native key' },
      { value: '../invalid', name: 'Invalid key' },
    ]
  })
  try {
    await f.app.submit('/settings')
    f.terminal.type('\x06'); f.terminal.type('Current permission')
    await paint(f.terminal)
    f.terminal.type('\r')
    await until(() => f.terminal.screen().includes('Native permission preset'), 'Settings opens the native permission picker')
    await paint(f.terminal)
    const screen = modalScreen(f.terminal, 'Native permission preset')
    assert.match(screen, /允许工作区编辑/)
    assert.match(screen, /strict/)
    assert.doesNotMatch(screen, /Wrong label field|Invalid key/)
    f.terminal.type('\r')
    await paint(f.terminal)
    assert.match(f.terminal.screen(), /Confirm native permission change/)
    assert.equal(f.backend.calls.some(call => call.name === 'execute'), false)
  } finally { await f.close() }
})

test('App titles: unknown stays uncached, native null stays known, and a reopened picker can recover', async () => {
  const f = await fixture('fullscreen', backend => {
    backend.sessions = [
      { id: 'unknown-title', cwd: backend.info.cwd }, { id: 'native-no-title', cwd: backend.info.cwd },
    ]
    backend.titleResult = ids => ids.map(sessionId => sessionId === 'native-no-title'
      ? { sessionId, title: null }
      : backend.titleCalls.length === 1 ? { sessionId } : { sessionId, title: 'Recovered native title' })
  })
  try {
    await f.app.submit('/resume')
    await until(() => f.backend.titleCalls.length === 1, 'first visible titles queried')
    await paint(f.terminal)
    assert.match(f.terminal.screen(), /\(title unknown\)/)
    assert.match(f.terminal.screen(), /\(untitled\)/)
    f.terminal.type('\x1b')
    await f.app.submit('/resume')
    await until(() => f.backend.titleCalls.length === 2, 'only unknown title is retried on explicit reopen')
    assert.deepEqual(f.backend.titleCalls[1], ['unknown-title'])
    await until(() => f.terminal.screen().includes('Recovered native title'), 'the native title recovered')
    assert.equal(f.backend.sends, 0)
    assert.equal(notices(f.app), '')
  } finally { await f.close() }
})

test('App recalled content: native file refs restore ready metadata, never read/submitted as an image', async () => {
  const f = await fixture('fullscreen', backend => {
    backend.queued = 1
    backend.dequeueResult = [{ messageId: 'file-inbox', content: [{ type: 'file',
      attachment: { attachmentId: 'opaque-native-file', name: 'evidence.csv', bytes: 32 } }] }]
  })
  try {
    await until(() => f.app.queuedCount === 1, 'a native-shaped queued input is visible')
    f.terminal.type('\x10')
    await until(() => f.app.editor.hasFileAttachments(), 'native file reference becomes a ready file marker')
    assert.equal(f.backend.imageReads, 0)
    assert.equal(f.backend.sends, 0)
    assert.deepEqual(f.app.editor.getPromptContent(), [{ type: 'file', attachment: { attachmentId: 'opaque-native-file', name: 'evidence.csv', bytes: 32 } }])
    assert.equal(f.app.editor.focused, true)
    const calls = f.backend.calls.filter(call => call.name === 'dequeue').length
    f.terminal.type('\x10')
    await delay(20)
    assert.equal(f.backend.calls.filter(call => call.name === 'dequeue').length, calls, 'non-empty recovered draft never re-dequeues or auto-submits')
  } finally { await f.close() }
})

for (const held of ['backend', 'settings', 'drain'] as const) {
  test(`App native exit handoff precedes held ${held} cleanup; reentry joins native disposal and keeps first code`, { timeout: 5000 }, async () => {
    const f = await fixture()
    const host = new Context()
    const requests: number[] = []
    let disposal: Promise<void> | undefined
    let disposalDone = false
    provideCmdline(host, { args: [], exit: code => {
      requests.push(code)
      disposal = host.fiber.dispose().then(() => { disposalDone = true })
    } })
    host.effect(() => () => f.app.shutdown(0), 'native-exit-fixture.owned-cleanup')
    const nativeExit = host.appExit
    assert.ok(nativeExit)
    void f.app.exitRequested.then(nativeExit)
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    let restore = () => {}
    if (held === 'backend') f.backend.closeGate = gate
    else if (held === 'settings') {
      const settings = (f.app as unknown as { settings: { flush(): Promise<void> } }).settings
      const original = settings.flush.bind(settings)
      settings.flush = async () => { await gate; await original() }
      restore = () => { settings.flush = original }
    } else {
      const original = f.terminal.drainInput.bind(f.terminal)
      f.terminal.drainInput = async () => { await gate; await original() }
      restore = () => { f.terminal.drainInput = original }
    }
    try {
      const closing = f.app.shutdown(130)
      assert.equal(f.terminal.stopped, true, 'terminal handback is synchronous')
      assert.equal(await f.app.exitRequested, 130)
      await until(() => requests.length === 1, 'the public native exit request is already issued')
      const reentry = f.app.shutdown(0)
      let joined = false
      void reentry.then(() => { joined = true })
      await delay(25)
      assert.equal(joined, false, 'reentry must await actual cleanup')
      assert.equal(disposalDone, false, 'native disposal owns the still-pending App cleanup')
      assert.deepEqual(requests, [130])
      release(); restore()
      await Promise.all([closing, reentry])
      await disposal
      assert.equal(disposalDone, true)
      assert.equal(await f.app.exited, 130)
      assert.equal(f.backend.closes, 1)
      assert.deepEqual(requests, [130])
    } finally {
      release(); restore()
      f.backend.closeGate = undefined
      await f.close()
      await host.fiber.dispose()
    }
  })
}
