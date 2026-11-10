import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, JsonRecord, SessionInfo } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { delay, modalScreen, until, VirtualTerminal } from './helpers/terminal.ts'

/** Parent-owned control fixture only; no Agent, native persistence or model calls. */
class HelpBackend implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly calls: Array<{ name: string; args: JsonRecord }> = []
  readonly sends: string[] = []
  readonly responses: string[] = []
  cancels = 0
  catalogReads = 0
  catalogGate?: Promise<void>
  catalog: JsonRecord[] = [
    { name: 'compact', description: 'Native compaction', definitionId: '@deepseek-ai/dsh-command-compact' },
    { name: 'profile-check', description: 'Profile custom command', definitionId: 'owned-profile/check', input: { hint: '<path>' } },
    { name: 'unattributed', description: 'Native registration without identity' },
    { name: 'help', description: 'Shadowed native help must not be shown', definitionId: '@outside/shadow-help' },
  ]
  info: SessionInfo

  constructor(cwd: string) {
    this.info = { sessionId: 'help-session', attachmentId: 'help-attachment', cwd, provider: 'fixture', model: 'fixture', capabilities: ['commands', 'execute', 'state'], events: [] }
  }
  onEvent(listener: (event: BackendEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent) { for (const listener of this.listeners) listener(event) }
  async connect() { this.emit({ type: 'ready', info: this.info }); return this.info }
  async send(text: string) { this.sends.push(text) }
  async respond(id: string) { this.responses.push(id) }
  async cancel() { this.cancels++; this.emit({ type: 'status', sessionId: this.info.sessionId, status: 'idle' }) }
  async close() {}
  async command(name: string, args: JsonRecord = {}): Promise<unknown> {
    this.calls.push({ name, args })
    if (name === 'commands') {
      this.catalogReads++
      const snapshot = this.catalog.map(row => ({ ...row }))
      await this.catalogGate
      return snapshot
    }
    if (name === 'state') return { pending: { nextTurn: 0, nextStep: 0 }, queued: 0 }
    if (name === 'auto-title') return { available: false }
    throw new Error('Help must not execute control: ' + name)
  }
}

async function fixture(screen: 'inline' | 'fullscreen' = 'fullscreen', bindings?: JsonRecord) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-help-'))
  if (bindings) await writeFile(join(directory, 'keybindings.json'), JSON.stringify(bindings))
  const backend = new HelpBackend(directory), terminal = new VirtualTerminal(120, 40)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen, registerSignals: false })
  await app.start(); await paint(terminal)
  return { app, backend, terminal, directory, async close() {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  } }
}
async function paint(terminal: VirtualTerminal) { await delay(35); await terminal.flush() }
const noticeText = (app: App) => app.store.items.filter(item => item.kind === 'notice').map(item => item.text).join('\n')

for (const screen of ['inline', 'fullscreen'] as const) {
  test('parent Help acceptance: readonly columns preserve the prompt and never execute (' + screen + ')', async () => {
    const f = await fixture(screen)
    try {
      f.terminal.type('draft before help 中文 😀 ')
      f.terminal.type('\x1b[200~' + 'large multiline paste\n'.repeat(40) + '\x1b[201~')
      f.terminal.type('\x02')
      const editor = f.app.editor, before = editor.captureDraft(), transcript = [...f.app.store.items]
      const attachment = f.app.session?.attachmentId
      await f.app.submit('/help'); await paint(f.terminal)
      const rendered = modalScreen(f.terminal, 'Help')
      assert.match(rendered, /Help/)
      const heading = rendered.split('\n').find(line => line.includes('Commands') && line.includes('Custom commands')) ?? ''
      assert.ok(heading, 'wide terminals show separate command columns')
      const customColumn = heading.indexOf('Custom commands')
      const builtin = rendered.split('\n').find(line => line.includes('/compact')) ?? ''
      const custom = rendered.split('\n').find(line => line.includes('/profile-check')) ?? ''
      assert.ok(builtin && builtin.indexOf('/compact') < customColumn, 'first-party identity stays with Commands')
      assert.ok(custom && custom.indexOf('/profile-check') >= customColumn, 'external native identity appears in Custom commands')
      assert.match(rendered, /<path>/, 'native input hints are displayed')
      assert.doesNotMatch(rendered, /Shadowed native help|Enter choose|Enter to select|Enter to execute|❯/)
      assert.deepEqual(f.app.store.items, transcript, 'opening Help appends no transcript notices')
      assert.equal(editor.focused, false, 'the read-only panel owns input while open')

      for (const key of ['\r', '1', '9', 'x', '\t', '\x1b[Z']) f.terminal.type(key)
      await paint(f.terminal)
      assert.match(f.terminal.screen(), /Custom commands/)
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), before, 'inert panel keys do not fill or modify the prompt')
      assert.equal(f.app.session?.attachmentId, attachment)
      assert.deepEqual(f.backend.sends, [])
      assert.deepEqual(f.backend.responses, [])
      assert.equal(f.backend.cancels, 0)
      assert.ok(f.backend.calls.every(call => ['commands', 'state', 'auto-title'].includes(call.name)), 'only read-only discovery controls were called')

      f.terminal.resize(40, 20); await paint(f.terminal)
      f.terminal.type('\x1b[F'); await paint(f.terminal)
      assert.match(f.terminal.screen(), /unattributed|identity/)
      f.terminal.resize(120, 40); await paint(f.terminal)
      f.terminal.type('\x1b')
      await paint(f.terminal)
      assert.equal(editor.focused, true)
      assert.deepEqual(editor.captureDraft(), before, 'closing Help restores the same lossless draft and editor')
      assert.deepEqual(f.app.store.items, transcript)
    } finally { await f.close() }
  })
}

test('parent Help acceptance: F1 opens Help, inert Enter does not select, idle Ctrl+C only closes', async () => {
  const f = await fixture()
  try {
    f.terminal.type('retained draft')
    const before = f.app.editor.captureDraft()
    f.terminal.type('\x1bOP')
    await until(() => f.terminal.screen().includes('Custom commands'), 'configured F1 opens the Help panel')
    f.terminal.type('\r'); await paint(f.terminal)
    assert.equal(f.app.editor.focused, false)
    assert.deepEqual(f.app.editor.captureDraft(), before)
    f.terminal.type('\x03'); await paint(f.terminal)
    assert.equal(f.app.editor.focused, true)
    assert.equal(f.backend.cancels, 0, 'idle Help dismissal does not mutate DSH')
    assert.deepEqual(f.app.editor.captureDraft(), before)
  } finally { await f.close() }
})

test('parent Help acceptance: busy default Ctrl+C is local, explicit interrupt remains native', async () => {
  const f = await fixture()
  try {
    f.terminal.type('busy draft')
    const before = f.app.editor.captureDraft()
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'running' })
    await f.app.submit('/help'); await paint(f.terminal)
    f.terminal.type('\x03')
    await paint(f.terminal)
    assert.equal(f.backend.cancels, 0)
    assert.equal(f.app.isBusy, true)
    assert.deepEqual(f.backend.responses, [])
    assert.deepEqual(f.app.editor.captureDraft(), before)
    assert.equal(f.app.editor.focused, true)

    f.app.keymap.setBindings({ 'app.interrupt': 'ctrl+q' })
    await f.app.submit('/help'); await paint(f.terminal)
    f.terminal.type('\x11')
    await until(() => f.backend.cancels === 1 && !f.app.isBusy, 'explicit interrupt cancels the foreground through DSH')
    assert.deepEqual(f.app.editor.captureDraft(), before)
    f.terminal.type('\x1b'); await paint(f.terminal)
    assert.equal(f.app.editor.focused, true)
    assert.deepEqual(f.app.editor.captureDraft(), before)
  } finally { await f.close() }
})

test('parent Help acceptance: each opening refreshes the effective native roster without caching stale custom commands', async () => {
  const f = await fixture()
  try {
    await f.app.submit('/help'); await paint(f.terminal)
    f.terminal.type('\x1b'); await paint(f.terminal)
    const reads = f.backend.catalogReads
    f.backend.catalog = [{ name: 'new-profile-command', description: 'New live native registration', definitionId: '@fixture/new' }]
    await f.app.submit('/help'); await paint(f.terminal)
    assert.equal(f.backend.catalogReads, reads + 1)
    assert.match(f.terminal.screen(), /new-profile-command/)
    assert.doesNotMatch(f.terminal.screen(), /profile-check|Native compaction/)
    assert.equal(noticeText(f.app), '')
  } finally { await f.close() }
})

test('parent Help acceptance: a late catalog cannot replace a newer Settings panel', async () => {
  const f = await fixture()
  try {
    let release!: () => void
    f.backend.catalogGate = new Promise(resolve => { release = resolve })
    const reads = f.backend.catalogReads
    const opening = f.app.submit('/help')
    await until(() => f.backend.catalogReads === reads + 1, 'Help discovery is actually pending')
    await f.app.submit('/settings'); await paint(f.terminal)
    release(); await opening; await paint(f.terminal)
    assert.match(f.terminal.screen(), /Settings/)
    assert.doesNotMatch(f.terminal.screen(), /Custom commands/)
  } finally { await f.close() }
})

for (const change of ['attachment', 'route'] as const) {
  test('parent Help acceptance: a late catalog cannot open on a changed ' + change, async () => {
    const f = await fixture()
    try {
      let release!: () => void
      f.backend.catalogGate = new Promise(resolve => { release = resolve })
      const reads = f.backend.catalogReads
      const opening = f.app.submit('/help')
      await until(() => f.backend.catalogReads === reads + 1, 'old Help discovery is pending')
      f.backend.info = { ...f.backend.info, ...(change === 'attachment' ? { attachmentId: 'help-attachment-2' } : { model: 'new-route-model' }) }
      f.backend.emit({ type: 'ready', info: f.backend.info })
      release(); await opening; await paint(f.terminal)
      assert.doesNotMatch(f.terminal.screen(), /Custom commands/)
      assert.equal(f.app.editor.focused, true)
    } finally { await f.close() }
  })
}

test('parent Help acceptance: mounted approval keeps focus and Help cannot submit or displace it', async () => {
  const f = await fixture()
  try {
    f.backend.emit({ type: 'decision', sessionId: f.backend.info.sessionId, request: {
      id: 'help-approval', kind: 'approval', title: 'Resolve native approval', options: [{ label: 'Allow once', value: 'allowed-once' }, { label: 'Reject', value: 'rejected' }],
    } })
    await f.app.submit('/help'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /Resolve native approval/)
    assert.doesNotMatch(f.terminal.screen(), /Custom commands/)
    assert.equal(f.app.pendingDecisionCount, 1)
    assert.deepEqual(f.backend.responses, [])
    assert.match(noticeText(f.app), /Resolve the pending DSH decision/)
  } finally { await f.close() }
})
