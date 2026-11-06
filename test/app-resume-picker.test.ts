import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, JsonRecord, SessionInfo } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { delay, until, VirtualTerminal } from './helpers/terminal.ts'

/**
 * Parent-owned acceptance for the `--resume` picker: the startup surface and
 * the `/resume` command share one CC-style picker that lists this directory's
 * sessions, newest first. Session identity and switching stay DSH facts — the
 * fixture backend only records what the TUI asked for.
 */
class SessionBackend implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly commands: Array<{ name: string; args: JsonRecord }> = []
  readonly sends: string[] = []
  info: SessionInfo
  catalog: JsonRecord[] = []
  /** Phase-2 title source, recorded per call (only enabled by the fixture options). */
  readonly titleCalls: string[][] = []
  private readonly titlesCapable: boolean
  private readonly deferredSessions: boolean
  private readonly deferredTitles: boolean
  private sessionsGate?: (value: JsonRecord[]) => void
  private titlesRelease?: () => void
  constructor(cwd: string, titlesCapable = false, deferredSessions = false, deferredTitles = false) {
    this.titlesCapable = titlesCapable
    this.deferredSessions = deferredSessions
    this.deferredTitles = deferredTitles
    this.info = {
      sessionId: 'startup-fresh-session', attachmentId: 'startup-fresh-attachment', cwd,
      provider: 'fixture-provider', model: 'fixture-model',
      capabilities: ['commands', 'sessions', 'state', ...(titlesCapable ? ['titles'] : [])],
    }
  }
  /** Resolve the deferred `titles` response (two-phase test). */
  releaseTitles(): void {
    this.titlesRelease?.()
  }

  /** Resolve the deferred `sessions` response (loading-overlay test). */
  releaseSessions(): void {
    this.sessionsGate?.(this.catalog.map(item => ({ ...item })))
  }
  onEvent(listener: (event: BackendEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent) { for (const listener of this.listeners) listener(event) }
  async connect() { this.emit({ type: 'ready', info: this.info }); return this.info }
  async send(text: string) { this.sends.push(text) }
  async respond() { throw new Error('session picker never answers decisions') }
  async close() {}
  async cancel() {}
  async command(name: string, args: JsonRecord = {}): Promise<unknown> {
    this.commands.push({ name, args })
    if (name === 'commands') return []
    if (name === 'state') return { pending: { nextTurn: 0, nextStep: 0 }, queued: 0 }
    if (name === 'auto-title') return { available: false }
    if (name === 'sessions') {
      if (!this.deferredSessions) return this.catalog.map(item => ({ ...item }))
      return new Promise<JsonRecord[]>(resolve => { this.sessionsGate = value => { this.sessionsGate = undefined; resolve(value) } })
    }
    if (name === 'titles') {
      if (!this.titlesCapable) throw new Error('fixture has no titles capability')
      const ids = Array.isArray(args.ids) ? args.ids.map(String) : []
      this.titleCalls.push(ids)
      const known: Record<string, string | null> = {
        'old-local': 'Older local session',
        'new-local': 'Newer local session',
        'live-local': 'Live local session',
        'other-dir': 'Other directory session',
      }
      const rows = ids.map(id => ({ sessionId: id, title: known[id] ?? null }))
      if (!this.deferredTitles) return rows
      return new Promise<JsonRecord[]>(resolve => {
        this.titlesRelease = () => { this.titlesRelease = undefined; resolve(rows) }
      })
    }
    if (name === 'resume') {
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
      if (!this.catalog.some(item => item.id === sessionId)) throw new Error('unknown fixture session')
      this.info = { ...this.info, sessionId, attachmentId: 'resumed-' + sessionId, events: [] }
      this.emit({ type: 'ready', info: this.info })
      return this.info
    }
    throw new Error('Unexpected control from the session picker: ' + name)
  }
}

async function fixture(options: { resumePicker?: boolean; catalog?: JsonRecord[]; titles?: boolean; deferredSessions?: boolean; deferredTitles?: boolean } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-resume-picker-'))
  const backend = new SessionBackend(directory, options.titles === true, options.deferredSessions === true, options.deferredTitles === true)
  // The native sessionQuery listing arrives newest-first; the picker never
  // re-sorts. The fixture mirrors that order.
  backend.catalog = options.catalog ?? [
    { id: 'other-dir', title: 'Other directory session', cwd: '/definitely/elsewhere', createdAt: Date.now() },
    { id: 'live-local', title: 'Live local session', cwd: directory, createdAt: Date.now() - 60 * 1000, live: true },
    { id: 'new-local', title: 'Newer local session', cwd: directory, createdAt: Date.now() - 5 * 60 * 1000 },
    { id: 'old-local', title: 'Older local session', cwd: directory, createdAt: Date.now() - 2 * 60 * 60 * 1000 },
    { id: 'no-cwd', title: 'Directoryless session', createdAt: Date.now() - 3 * 60 * 60 * 1000 },
  ]
  if (options.titles === true) {
    // Headers-only phase 1: the catalog itself carries no titles; the `titles`
    // command is the only source, exactly like the native two-phase bridge.
    backend.catalog = backend.catalog.map(item => { const { title: _drop, ...rest } = item as { title?: string } & JsonRecord; return rest })
  }
  const terminal = new VirtualTerminal(110, 32)
  const app = new App({
    backend, cwd: directory, configDir: directory, terminal, screen: 'fullscreen', registerSignals: false,
    ...(options.resumePicker === true ? { resumePicker: true } : {}),
    ...(options.resumePicker === true ? { initialPrompt: 'positional prompt' } : {}),
  })
  await app.start(); await paint(terminal)
  return { app, backend, terminal, directory, async close() {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  } }
}
async function paint(terminal: VirtualTerminal) { await delay(35); await terminal.flush() }

for (const picker of [false, true] as const) {
  test('parent resume picker: ' + (picker ? '--resume without an id opens the startup picker' : '/resume without an id opens the picker'), async () => {
    const f = await fixture({ resumePicker: picker })
    try {
      if (!picker) { await f.app.submit('/resume'); await paint(f.terminal) }
      await until(() => f.terminal.screen().includes('Resume session'), 'the picker dialog is painted')
      const screen = f.terminal.screen()
      // CC-style listing: this directory's sessions only, newest first.
      assert.match(screen, /Resume session/)
      assert.ok(screen.indexOf('Live local session') < screen.indexOf('Newer local session'), 'newest session sorts first')
      assert.ok(screen.indexOf('Newer local session') < screen.indexOf('Older local session'), 'age column sorts newest first')
      assert.ok(!screen.includes('Other directory session'), 'other directories are filtered out')
      assert.ok(!screen.includes('Directoryless session'), 'records without a cwd are filtered out')
      assert.match(screen, /5m ago/)
      assert.match(screen, /2h ago/)
      assert.ok(screen.includes('open elsewhere'), 'the live session is marked')
      assert.equal(f.backend.commands.filter(call => call.name === 'sessions').length, 1, 'one native sessions listing backs the picker')
      const sessionsCall = f.backend.commands.find(call => call.name === 'sessions')
      assert.equal(sessionsCall?.args.limit, 200, 'the picker asks for the widest native listing window')
      assert.equal(sessionsCall?.args.titles, false, 'phase 1 is headers-only: no per-session title decompression')
      // Selecting the top row (the newest: the live one) resumes that session
      // and submits the staged prompt.
      f.terminal.type('\r')
      await until(() => f.app.session?.sessionId === 'live-local', 'the selected session becomes current')
      await paint(f.terminal)
      assert.ok(!f.terminal.screen().includes('Resume session'), 'the picker closes after a selection')
      assert.deepEqual(f.backend.commands.filter(call => call.name === 'resume').map(call => call.args.sessionId), ['live-local'])
      await until(() => f.backend.sends.includes('positional prompt') || !picker, 'the positional prompt is sent after the resume settles')
      if (picker) assert.deepEqual(f.backend.sends, ['positional prompt'])
    } finally { await f.close() }
  })

  test('parent resume picker: ' + (picker ? 'Esc keeps the fresh startup session' : 'Esc cancels without switching'), async () => {
    const f = await fixture({ resumePicker: picker })
    try {
      if (!picker) { await f.app.submit('/resume'); await paint(f.terminal) }
      await until(() => f.terminal.screen().includes('Resume session'), 'the picker dialog is painted')
      f.terminal.type('\x1b')
      await paint(f.terminal)
      assert.ok(!f.terminal.screen().includes('Resume session'), 'Esc dismisses the picker')
      assert.equal(f.app.session?.sessionId, 'startup-fresh-session', 'no session switch happened')
      assert.deepEqual(f.backend.commands.filter(call => call.name === 'resume'), [], 'no resume command ran')
      await until(() => f.backend.sends.includes('positional prompt') || !picker, 'the positional prompt is sent on the fresh session')
      if (picker) {
        assert.deepEqual(f.backend.sends, ['positional prompt'])
        assert.equal(f.app.editor.focused, true, 'the editor owns focus after cancelling the startup picker')
      }
    } finally { await f.close() }
  })
}

test('parent resume picker: a directory with no sessions shows the empty state and Tab reaches all', async () => {
  const f = await fixture({ resumePicker: true, catalog: [{ id: 'other-dir', title: 'Elsewhere', cwd: '/definitely/elsewhere', createdAt: Date.now() }] })
  try {
    await until(() => f.terminal.screen().includes('Resume session'), 'the picker opens with the empty directory state')
    await paint(f.terminal)
    assert.ok(f.terminal.screen().includes('No sessions in current folder'), 'the empty state explains the directory scope')
    assert.ok(f.terminal.screen().includes('Tab'), 'the empty state points at the scope toggle')
    // Tab switches to the all-scope, where the other directory's session appears.
    f.terminal.type('\t')
    await paint(f.terminal)
    assert.ok(f.terminal.screen().includes('Elsewhere'), 'the all scope lists other directories')
    // Esc keeps the fresh session; the positional prompt still submits.
    f.terminal.type('\x1b')
    await paint(f.terminal)
    assert.ok(!f.terminal.screen().includes('Resume session'), 'Esc dismisses the picker')
    await until(() => f.backend.sends.includes('positional prompt'), 'the positional prompt is sent on the fresh session')
    assert.equal(f.app.session?.sessionId, 'startup-fresh-session')
  } finally { await f.close() }
})

test('parent resume picker: /resume with an explicit id skips the picker', async () => {
  const f = await fixture()
  try {
    await f.app.submit('/resume new-local')
    await paint(f.terminal)
    await until(() => f.app.session?.sessionId === 'new-local', 'the explicit id resumes directly')
    assert.ok(!f.terminal.screen().includes('Resume session'), 'no picker dialog for an explicit id')
    assert.deepEqual(f.backend.commands.filter(call => call.name === 'resume').map(call => call.args.sessionId), ['new-local'])
  } finally { await f.close() }
})

test('parent resume picker: the overlay opens in loading state before the listing arrives', async () => {
  const f = await fixture({ resumePicker: true, deferredSessions: true })
  try {
    await paint(f.terminal)
    assert.ok(f.terminal.screen().includes('Resume session'), 'the dialog shell is visible immediately')
    assert.ok(f.terminal.screen().includes('Loading sessions'), 'phase 1 has not resolved yet')
    assert.ok(!f.terminal.screen().includes('Live local session'), 'no rows before the listing lands')
    f.backend.releaseSessions()
    await until(() => f.terminal.screen().includes('Live local session'), 'rows appear after the deferred listing resolves')
    await until(() => f.app.session?.sessionId === 'live-local' || true, 'settled')
    f.terminal.type('\r')
    await until(() => f.app.session?.sessionId === 'live-local', 'a selection made after loading still resumes')
    await until(() => f.backend.sends.includes('positional prompt'), 'the positional prompt is submitted after the resume')
  } finally { await f.close() }
})

test('parent resume picker: titles stream in only for the visible rows (two-phase listing)', async () => {
  const f = await fixture({ resumePicker: true, titles: true, deferredTitles: true })
  try {
    await until(() => f.terminal.screen().includes('Resume session'), 'the picker opens')
    // Phase 1 rows are headers-only: titles are unknown until phase 2 lands.
    await until(() => f.backend.titleCalls.length > 0, 'the visible window requested its titles')
    await paint(f.terminal)
    assert.ok(f.terminal.screen().includes('(untitled)'), 'rows render before any title arrives')
    f.backend.releaseTitles()
    await until(() => f.terminal.screen().includes('Live local session'), 'the title command fills the visible rows')
    await paint(f.terminal)
    assert.ok(f.terminal.screen().includes('Newer local session'))
    assert.ok(!f.terminal.screen().includes('Other directory session'), 'out-of-scope rows never request titles')
    const requested = f.backend.titleCalls.flat()
    assert.ok(requested.includes('live-local') && requested.includes('new-local'), 'visible rows requested titles')
    assert.ok(!requested.includes('other-dir'), 'the title window never includes out-of-directory sessions')
    const batches = f.backend.titleCalls.map(ids => ids.length)
    assert.ok(batches.every(count => count <= 100), 'title batches stay bounded')
    // A second picker open reuses the in-launch title cache: no extra fetch.
    const callsBefore = f.backend.titleCalls.length
    f.terminal.type('\x1b')
    await paint(f.terminal)
    await f.app.submit('/resume')
    await until(() => f.terminal.screen().includes('Resume session'), 'the in-session picker reopens')
    await paint(f.terminal)
    await until(() => f.terminal.screen().includes('Live local session'), 'cached titles render without a new request')
    assert.equal(f.backend.titleCalls.length, callsBefore, 'the title cache serves the reopened picker')
  } finally { await f.close() }
})
