import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after, before } from 'node:test'
import { TuiAltScreen, TuiMainScreen, type ProgramStatus } from '#pi-tui'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, DecisionRequest, JsonRecord, SessionInfo, SubagentEntry } from '../src/backend/types.ts'
import { SettingsDialog } from '../src/ui/settings.ts'
import { VirtualTerminal, delay, until } from './helpers/terminal.ts'

// App also launches read-only git probes: isolate their environment as well as
// the explicit settings/workspace paths. This test file runs in its own worker.
const homeKeys = ['HOME', 'USERPROFILE', 'DSH_HOME', 'XDG_CONFIG_HOME'] as const
const originalHomes = Object.fromEntries(homeKeys.map(key => [key, process.env[key]]))
let privateHome: string
before(async () => {
  privateHome = await mkdtemp(join(tmpdir(), 'dsh-terminal-app-home-'))
  await mkdir(join(privateHome, '.config'), { recursive: true })
  process.env.HOME = privateHome; process.env.USERPROFILE = privateHome
  process.env.DSH_HOME = join(privateHome, '.dsh'); process.env.XDG_CONFIG_HOME = join(privateHome, '.config')
})
after(async () => {
  for (const key of homeKeys) {
    if (originalHomes[key] === undefined) delete process.env[key]
    else process.env[key] = originalHomes[key]
  }
  await rm(privateHome, { recursive: true, force: true })
})

class PresentationTerminal extends VirtualTerminal {
  private readonly supportListeners = new Set<(supported: boolean) => void>()
  private readonly focusListeners = new Set<(focused: boolean) => void>()
  terminalFocused?: boolean
  focusReporting = false
  readonly titleStack: string[] = []
  readonly titleHistory: string[] = []
  progressFallback?: boolean
  peakRecords = 0
  override setProgramStatus(status: ProgramStatus): void {
    super.setProgramStatus(status)
    this.peakRecords = Math.max(this.peakRecords, this.statusRecords.size)
  }
  constructor(supported = true) { super(100, 35); this.programStatusSupported = supported; this.title = 'original shell title' }
  override setTitle(title: string): void { super.setTitle(title); this.titleHistory.push(title) }
  onProgramStatusSupportChange(listener: (supported: boolean) => void): () => void {
    this.supportListeners.add(listener); listener(this.programStatusSupported)
    return () => { this.supportListeners.delete(listener) }
  }
  onFocusChange(listener: (focused: boolean) => void): () => void {
    this.focusListeners.add(listener)
    return () => { this.focusListeners.delete(listener) }
  }
  support(supported: boolean): void {
    this.programStatusSupported = supported
    for (const listener of this.supportListeners) listener(supported)
  }
  focus(focused: boolean): void {
    this.terminalFocused = focused
    for (const listener of this.focusListeners) listener(focused)
  }
  setFocusReporting(enabled: boolean): void { this.focusReporting = enabled }
  saveTitle(): void { this.titleStack.push(this.title) }
  restoreTitle(): void { this.title = this.titleStack.pop() ?? this.title }
  setProgressFallback(enabled: boolean): void { this.progressFallback = enabled }
}

class FixtureBackend implements Backend {
  private readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly commands: string[] = []
  readonly sent: string[] = []
  readonly answers: Array<{ id: string; value: unknown }> = []
  info: SessionInfo
  seq = 0
  connectError?: Error
  constructor(cwd: string, initial: Partial<SessionInfo> = {}) {
    this.info = { sessionId: 'native-root', attachmentId: 'native-attachment-1', cwd, provider: 'fixture', model: 'fixture-model', capabilities: [], events: [], ...initial }
    for (const event of this.info.events ?? []) this.seq = Math.max(this.seq, event.seq)
  }
  onEvent(listener: (event: BackendEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent): void { for (const listener of this.listeners) listener(event) }
  async connect(): Promise<SessionInfo> {
    if (this.connectError) throw this.connectError
    this.emit({ type: 'ready', info: this.info }); return this.info
  }
  async send(text: string): Promise<void> { this.sent.push(text) }
  async cancel(): Promise<void> {
    this.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    this.emit({ type: 'status', sessionId: this.info.sessionId, status: 'idle' })
  }
  async command(name: string): Promise<unknown> { this.commands.push(name); return {} }
  async respond(id: string, value: unknown): Promise<void> { this.answers.push({ id, value }); this.emit({ type: 'decision_closed', sessionId: this.info.sessionId, id }) }
  async close(): Promise<void> {}
  append(type: string, data: unknown): BackendEvent {
    const event: BackendEvent = { type: 'session_event', sessionId: this.info.sessionId, event: { type, data, seq: ++this.seq } }
    this.emit(event); return event
  }
  begin(turn = 1): void {
    this.emit({ type: 'status', sessionId: this.info.sessionId, status: 'running' })
    this.append('turn/start', { turn })
  }
  finish(turn = 1, kind = 'completed'): BackendEvent {
    const event = this.append('turn/end', { turn, reason: { kind } })
    this.emit({ type: 'status', sessionId: this.info.sessionId, status: 'idle' })
    return event
  }
  ready(info: SessionInfo): void { this.info = info; this.emit({ type: 'ready', info }) }
}

async function fixture(options: {
  screen?: 'inline' | 'fullscreen'
  family?: 'rex' | 'ghostty' | 'unknown'
  supported?: boolean
  settings?: JsonRecord
  info?: Partial<SessionInfo>
  failConnect?: boolean
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-terminal-app-'))
  if (options.settings) await writeFile(join(directory, 'settings.json'), JSON.stringify(options.settings))
  const terminal = new PresentationTerminal(options.supported ?? true)
  const backend = new FixtureBackend(directory, options.info)
  if (options.failConnect) backend.connectError = new Error('PRIVATE startup failure marker')
  const app = new App({ backend, cwd: directory, terminal, screen: options.screen ?? 'fullscreen', configDir: directory, registerSignals: false,
    terminalEnvironment: { TERM_PROGRAM: options.family ?? 'rex', TERM: options.family === 'ghostty' ? 'xterm-ghostty' : 'xterm-256color' } })
  try { await app.start() }
  catch (error) { await app.shutdown(1); terminal.dispose(); await rm(directory, { recursive: true, force: true }); throw error }
  return { app, backend, terminal, directory, async close() { await app.shutdown(); terminal.dispose(); await rm(directory, { recursive: true, force: true }) } }
}

const root = (terminal: PresentationTerminal): ProgramStatus | undefined => terminal.statusRecords.get('')
const rootReports = (terminal: PresentationTerminal, state?: ProgramStatus['state']) => terminal.statusReports.filter(report => report.id === undefined && (state === undefined || report.state === state))
const notifications = (terminal: PresentationTerminal) => terminal.writes.filter(data => data.includes('\x1b]777;notify;'))

function child(id: string, parent = 'native-root', status: SubagentEntry['status'] = 'running'): SubagentEntry {
  return { id, parentSessionId: parent, mode: 'continuable', local: true, label: id, status, lastRunId: 'current-native-run-' + id }
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`App terminal (${screen}): durable outcomes, not tentative streams or idle, drive completion once`, async () => {
    const f = await fixture({ screen })
    try {
      assert.equal(root(f.terminal)?.state, 'idle')
      const nativeReads = [...f.backend.commands]
      f.backend.begin()
      assert.equal(root(f.terminal)?.state, 'working')
      f.backend.emit({ type: 'stream_start', sessionId: f.backend.info.sessionId, attemptId: 'tentative', revision: 1, turn: 1, step: 1 })
      f.backend.emit({ type: 'stream_end', sessionId: f.backend.info.sessionId, attemptId: 'tentative', revision: 2, outcome: 'committed', seq: 1 })
      assert.equal(root(f.terminal)?.state, 'working')
      assert.equal(rootReports(f.terminal, 'done').length, 0)
      const end = f.backend.finish()
      assert.equal(root(f.terminal)?.state, 'done')
      f.backend.emit(end)
      f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'idle' })
      await delay(150)
      assert.equal(rootReports(f.terminal, 'done').length, 1, 'duplicates/animation cannot replace or re-notify a completion')
      assert.equal(notifications(f.terminal).length, 0, 'Rex owns program-activity notifications')
      assert.deepEqual(f.backend.commands, nativeReads, 'terminal projection adds no calls to the existing read-only startup query')
      assert.equal(f.backend.sent.length, 0, 'terminal projection never submits a prompt')
    } finally { await f.close() }
  })

  test(`App terminal (${screen}): native decisions block with correct kinds, local dialogs do not`, async () => {
    const f = await fixture({ screen, family: 'ghostty', supported: false })
    try {
      f.terminal.focus(false)
      await f.app.submit('/settings')
      assert.equal(root(f.terminal)?.state, 'idle')
      assert.equal(notifications(f.terminal).length, 0)
      f.terminal.type('\x1b')
      f.backend.begin()
      const requests: DecisionRequest[] = [
        { id: 'native-approval', kind: 'approval', title: 'PRIVATE approval context', message: 'PRIVATE tool argument context', options: [{ label: 'Allow', value: 'allowed' }, { label: 'Reject', value: 'rejected' }] },
        { id: 'native-question', kind: 'question', title: 'PRIVATE question context', questions: [{ question: 'PRIVATE question text', options: [{ label: 'One' }, { label: 'Two' }] }] },
      ]
      for (const request of requests) {
        f.backend.emit({ type: 'decision', sessionId: f.backend.info.sessionId, request })
        assert.equal(root(f.terminal)?.state, 'blocked')
        assert.equal(root(f.terminal)?.kind, request.kind === 'question' ? 'question' : 'permission')
        const count = notifications(f.terminal).length
        f.backend.emit({ type: 'decision', sessionId: f.backend.info.sessionId, request })
        assert.equal(notifications(f.terminal).length, count, 'same native request is not a new attention transition')
        f.backend.emit({ type: 'decision_closed', sessionId: f.backend.info.sessionId, id: request.id })
        assert.equal(root(f.terminal)?.state, 'working')
        assert.equal(root(f.terminal)?.kind, undefined, 'complete replacement drops the old blocked kind')
      }
      assert.equal(notifications(f.terminal).length, 2)
      for (const notification of notifications(f.terminal)) assert.doesNotMatch(notification, /PRIVATE|argument|context|fixture-model/)
      assert.equal(f.backend.sent.length, 0)
      assert.equal(f.backend.answers.length, 0, 'reporting does not answer decisions')
    } finally { await f.close() }
  })
}

test('App terminal: cancellation, pre-step rejection, interrupted/forked turns and output limits never report success', async () => {
  const f = await fixture({ family: 'ghostty', supported: false, settings: { terminalNotifications: 'always' } })
  try {
    const kinds = ['aborted', 'blocked', 'interrupted', 'forked', 'max-tokens']
    for (let index = 0; index < kinds.length; index++) {
      f.backend.begin(index + 1)
      f.backend.emit({ type: 'stream_end', sessionId: f.backend.info.sessionId, attemptId: 'abandoned', revision: index + 2, outcome: 'abandoned' })
      assert.equal(rootReports(f.terminal, 'error').length, 0, 'an abandoned attempt is not a failed turn')
      f.backend.finish(index + 1, kinds[index])
      assert.equal(root(f.terminal)?.state, 'idle')
    }
    assert.equal(rootReports(f.terminal, 'done').length, 0)
    assert.equal(notifications(f.terminal).length, 0)
    f.backend.begin(9)
    await f.app.interrupt()
    assert.equal(root(f.terminal)?.state, 'idle')
    assert.equal(notifications(f.terminal).length, 0)
  } finally { await f.close() }
})

test('App terminal: durable error gives one generic alert; a live nonfatal diagnostic does not', async () => {
  const f = await fixture({ family: 'ghostty', supported: false, settings: { terminalNotifications: 'always' } })
  try {
    f.backend.begin()
    f.backend.emit({ type: 'error', message: 'PRIVATE transient diagnostic marker', fatal: false })
    assert.equal(root(f.terminal)?.state, 'working')
    assert.equal(notifications(f.terminal).length, 0)
    f.backend.append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'PRIVATE provider error marker' } } })
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'idle' })
    assert.equal(root(f.terminal)?.state, 'error')
    assert.equal(rootReports(f.terminal, 'error').length, 1)
    assert.equal(notifications(f.terminal).length, 1)
    assert.doesNotMatch(notifications(f.terminal)[0]!, /PRIVATE|provider|diagnostic|fixture-model/)
  } finally { await f.close() }
})

test('App terminal: restored durable history is not fresh completion or failure attention', async () => {
  const f = await fixture({ family: 'ghostty', supported: false, settings: { terminalNotifications: 'always' }, info: {
    title: 'Native restored title', events: [{ seq: 90, type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } }],
  } })
  try {
    assert.match(f.terminal.title, /Native restored title/)
    f.backend.emit({ type: 'session_event', sessionId: f.backend.info.sessionId, event: { seq: 90, type: 'turn/end', data: { turn: 5, reason: { kind: 'completed' } } } })
    assert.equal(root(f.terminal)?.state, 'idle')
    assert.equal(rootReports(f.terminal, 'done').length, 0)
    assert.equal(notifications(f.terminal).length, 0)
  } finally { await f.close() }
})

for (const screen of ['inline', 'fullscreen'] as const) {
  test('App Rex title (' + screen + '): only the whale remains throughout work, decisions and settlement', async () => {
    const f = await fixture({ screen, info: { title: 'Whale title' } })
    try {
      assert.equal(f.terminal.title, '🐳 Whale title — dsh-tui')
      const nativeReads = [...f.backend.commands]
      f.terminal.type('same editor draft')
      const editor = f.app.editor
      const draft = editor.captureDraft()
      f.backend.begin()
      assert.equal(f.terminal.title, '🐳 Whale title — dsh-tui')
      const reports = f.terminal.statusReports.length
      const titles = f.terminal.titleHistory.length
      await delay(1150)
      assert.equal(f.terminal.titleHistory.length, titles, 'Working UI ticks no longer feed the terminal title')
      assert.equal(f.terminal.statusReports.length, reports)
      assert.equal(f.backend.info.title, 'Whale title')
      f.backend.emit({ type: 'decision', sessionId: f.backend.info.sessionId, request: {
        id: 'title-approval', kind: 'approval', title: 'Allow fixture?',
        options: [{ label: 'Allow', value: 'allow' }, { label: 'Reject', value: 'reject' }],
      } })
      assert.equal(root(f.terminal)?.state, 'blocked')
      assert.equal(f.terminal.title, '🐳 Whale title — dsh-tui')
      await delay(1100)
      assert.equal(f.terminal.titleHistory.length, titles)
      f.backend.emit({ type: 'decision_closed', sessionId: f.backend.info.sessionId, id: 'title-approval' })
      f.backend.finish()
      assert.equal(f.terminal.title, '🐳 Whale title — dsh-tui')
      await delay(1100)
      assert.equal(f.terminal.titleHistory.length, titles)
      assert.equal(f.terminal.titleStack.length, 1)
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), draft)
      assert.deepEqual(f.backend.commands, nativeReads)
      assert.deepEqual(f.backend.sent, [])
      assert.deepEqual(f.backend.answers, [])
      assert.ok(f.terminal.statusReports.every(report => report.state === 'clear' || report.app === 'terminal'))
    } finally { await f.close() }
    assert.equal(f.terminal.title, 'original shell title')
  })
}

test('App Rex title: Reduced motion remains a UI preference and cannot add a title marker', async () => {
  const f = await fixture({ settings: { reducedMotion: true }, info: { title: 'Still whale' } })
  try {
    f.backend.begin()
    assert.equal(f.terminal.title, '🐳 Still whale — dsh-tui')
    const titles = f.terminal.titleHistory.length
    await delay(1150)
    assert.equal(f.terminal.titleHistory.length, titles)
    assert.equal(root(f.terminal)?.state, 'working')
    assert.equal(f.backend.info.title, 'Still whale')
    f.backend.finish()
    assert.equal(f.terminal.title, '🐳 Still whale — dsh-tui')
  } finally { await f.close() }
})

test('App terminal: native title/null, current workspace and attachment guards survive session replacement', async () => {
  const f = await fixture({ info: { title: 'Native title 中文 😀' } })
  try {
    assert.equal(f.terminal.title, '🐳 Native title 中文 😀 — dsh-tui')
    const original = { ...f.backend.info }
    f.backend.emit({ type: 'subagent', sessionId: original.sessionId, value: child('old-worker') })
    assert.ok([...f.terminal.statusRecords.values()].some(record => record.id !== undefined && record.state === 'working'))
    f.backend.ready({ ...original, sessionId: 'new-root', attachmentId: 'native-attachment-2', title: null, cwd: join(f.directory, 'new workspace'), events: [], subagents: { entries: [] } })
    assert.equal(f.terminal.statusRecords.size, 1, 'new root clears retired child records before replay state can retain them')
    assert.equal(root(f.terminal)?.state, 'idle')
    assert.match(f.terminal.title, /new workspace/)
    assert.ok(f.terminal.writes.some(write => write.includes(']7;file://') && write.includes('/new%20workspace')))
    const title = f.terminal.title
    const reports = f.terminal.statusReports.length
    f.backend.emit({ type: 'title', sessionId: 'new-root', attachmentId: original.attachmentId, value: 'STALE same-session title' })
    f.backend.emit({ type: 'title', sessionId: original.sessionId, attachmentId: original.attachmentId, value: 'STALE retired title' })
    f.backend.emit({ type: 'session_event', sessionId: original.sessionId, event: { seq: 500, type: 'turn/end', data: { turn: 99, reason: { kind: 'completed' } } } })
    f.backend.emit({ type: 'status', sessionId: original.sessionId, status: 'running' })
    assert.equal(f.terminal.title, title)
    assert.equal(f.terminal.statusReports.length, reports)
    f.backend.emit({ type: 'title', sessionId: 'new-root', attachmentId: 'native-attachment-2', value: 'New native title' })
    assert.equal(f.terminal.title, '🐳 New native title — dsh-tui')
    f.backend.emit({ type: 'title', sessionId: 'new-root', attachmentId: 'native-attachment-2', value: null })
    assert.match(f.terminal.title, /new workspace/)
    assert.equal(f.terminal.titleStack.length, 1, 'context/capability changes do not leak title saves')
  } finally { await f.close() }
  assert.equal(f.terminal.title, 'original shell title')
  assert.equal(f.terminal.titleStack.length, 0)
  assert.equal(f.terminal.focusReporting, false)
  assert.equal(f.terminal.statusRecords.size, 0)
})

test('App terminal: independently running nested workers never make the native root busy', async () => {
  const cold = { ...child('historic-completed', 'native-root', 'completed'), lastRunId: undefined }
  const f = await fixture({ info: { subagents: { entries: [cold] } } })
  try {
    assert.equal(root(f.terminal)?.state, 'idle')
    assert.ok([...f.terminal.statusRecords.values()].every(record => record.state !== 'done' && record.state !== 'error'), 'cold child history is not new attention')
    f.backend.emit({ type: 'subagents', sessionId: f.backend.info.sessionId, value: { entries: [child('parent-worker'), child('nested-worker', 'parent-worker'), cold] } })
    assert.equal(f.app.isBusy, false)
    assert.equal(root(f.terminal)?.state, 'idle')
    const working = [...f.terminal.statusRecords.values()].filter(record => record.id !== undefined && record.state === 'working')
    assert.equal(working.length, 2, 'nested current-tree workers have their own records')
    f.backend.emit({ type: 'subagent', sessionId: f.backend.info.sessionId, value: child('nested-worker', 'parent-worker', 'completed') })
    assert.equal(root(f.terminal)?.state, 'idle')
    assert.ok([...f.terminal.statusRecords.values()].some(record => record.id !== undefined && record.title === 'nested-worker' && record.state === 'done'))
  } finally { await f.close() }
})

test('App terminal: auto uses positive focus evidence, notifications Off is independent, and support changes do not leak titles', async () => {
  const f = await fixture({ family: 'ghostty', supported: false })
  try {
    f.backend.begin(1); f.backend.finish(1)
    assert.equal(notifications(f.terminal).length, 0, 'unknown focus is conservative')
    f.terminal.focus(true)
    f.backend.begin(2); f.backend.finish(2)
    assert.equal(notifications(f.terminal).length, 0, 'focused work completion is not an interruption')
    f.terminal.focus(false)
    f.backend.begin(3); f.backend.finish(3)
    assert.equal(notifications(f.terminal).length, 1)
    f.terminal.support(true)
    assert.equal(f.terminal.titleStack.length, 1)
    assert.equal(notifications(f.terminal).length, 1, 'capability confirmation is not a new completion')
    f.backend.begin(4)
    assert.equal(f.terminal.progress, true, 'Ghostty retains its supported legacy progress display')
  } finally { await f.close() }

  const off = await fixture({ family: 'ghostty', supported: false, settings: { terminalNotifications: 'off' } })
  try {
    off.terminal.focus(false); off.backend.begin(); off.backend.finish()
    assert.equal(notifications(off.terminal).length, 0)
    assert.equal(root(off.terminal)?.state, 'done', 'Off only disables direct notifications, not native status')
  } finally { await off.close() }
})

test('App terminal: native status disabled clears records but explicitly requested notification policy still works', async () => {
  const f = await fixture({ family: 'ghostty', supported: false, settings: { terminalStatus: false, terminalNotifications: 'always' } })
  try {
    f.backend.begin(); f.backend.finish()
    assert.equal(f.terminal.statusRecords.size, 0)
    assert.equal(f.terminal.progress, false)
    assert.equal(notifications(f.terminal).length, 1, 'notification presentation and native status reporting are independent preferences')
  } finally { await f.close() }
})

test('App terminal: unsupported generic terminal retains progress fallback, negotiated Rex does not', async () => {
  const f = await fixture({ family: 'unknown', supported: false })
  try {
    f.backend.begin()
    assert.equal(f.terminal.progress, true)
    assert.notEqual(f.terminal.progressFallback, false, 'the controller must not explicitly disable unknown-terminal fallback')
    f.terminal.support(true)
    assert.equal(f.terminal.progress, false)
    assert.equal(f.terminal.titleStack.length, 1)
  } finally { await f.close() }
})

test('App terminal: fatal/startup failure is generic; restoring the terminal makes every late event silent', async () => {
  for (const failConnect of [false, true]) {
    const f = await fixture({ family: 'ghostty', supported: false, failConnect, settings: { terminalNotifications: 'always' } })
    try {
      if (!failConnect) f.backend.emit({ type: 'error', message: 'PRIVATE fatal native failure marker', fatal: true })
      assert.ok(rootReports(f.terminal, 'error').length > 0, 'a fatal outcome must not vanish into a clear/no-op')
      for (const report of rootReports(f.terminal, 'error')) assert.doesNotMatch(report.message ?? '', /PRIVATE|marker/)
      for (const notice of notifications(f.terminal)) assert.doesNotMatch(notice, /PRIVATE|marker/)
      f.app.restoreTerminal()
      const reports = f.terminal.statusReports.length
      const writes = f.terminal.writes.length
      f.backend.emit({ type: 'title', sessionId: f.backend.info.sessionId, value: 'LATE native title' })
      f.backend.begin(20); f.backend.finish(20)
      await delay(40)
      assert.equal(f.terminal.statusReports.length, reports)
      assert.equal(f.terminal.writes.length, writes)
      assert.equal(f.terminal.statusRecords.size, 0)
      assert.equal(f.terminal.focusReporting, false)
    } finally { await f.close() }
  }
})

test('App terminal settings remain one page: typed notifications and per-key reset do not change DSH title enablement', async () => {
  const f = await fixture()
  try {
    f.app.editor.setText('same main draft')
    const editor = f.app.editor
    await f.app.submit('/settings')
    const nativeReads = [...f.backend.commands]
    const tui = f.app.tui
    assert.ok(tui instanceof TuiAltScreen || tui instanceof TuiMainScreen)
    const dialog = tui.getFocusedComponent()
    assert.ok(dialog instanceof SettingsDialog)
    assert.ok(dialog.rows().some(row => row.id === 'terminalNotifications'))
    dialog.handleInput('\x06')
    for (const character of 'terminal notifications') dialog.handleInput(character)
    assert.equal(dialog.rows().length, 1)
    dialog.handleInput('\x1b')
    dialog.handleInput('\r'); dialog.handleInput('\x1b[F'); dialog.handleInput('\r')
    const path = join(f.directory, 'settings.json')
    await until(() => dialog.settings.terminalNotifications === 'always', 'typed notification preference applied')
    await until(() => !dialog.isSaving, 'notification preference settled')
    const saved: unknown = JSON.parse(await readFile(path, 'utf8'))
    assert.ok(saved !== null && typeof saved === 'object')
    assert.equal((saved as JsonRecord).terminalNotifications, 'always')
    assert.equal(Object.hasOwn(saved, 'autoTitle'), false)
    dialog.handleInput('\x12')
    await until(() => dialog.settings.terminalNotifications === 'auto', 'single terminal override reset')
    await delay(30)
    const reset: unknown = JSON.parse(await readFile(path, 'utf8'))
    assert.ok(reset !== null && typeof reset === 'object')
    assert.equal(Object.hasOwn(reset, 'terminalNotifications'), false)
    dialog.handleInput('\x1b')
    assert.equal(f.app.editor, editor)
    assert.equal(editor.getText(), 'same main draft')
    assert.deepEqual(f.backend.commands, nativeReads)
    assert.equal(f.backend.sent.length, 0)
  } finally { await f.close() }
})

for (const kind of ['success', 'error'] as const) {
  test(`App terminal: matched native command ${kind} has a distinct work outcome, not a fabricated turn`, async () => {
    const f = await fixture({ family: 'ghostty', supported: false, settings: { terminalNotifications: 'always' } })
    try {
      f.backend.append('command/done', { commandId: 'unmatched', kind: 'error', text: 'PRIVATE unmatched result' })
      assert.equal(root(f.terminal)?.state, 'idle')
      f.backend.append('command/run', { commandId: 'native-command', name: 'compact' })
      assert.equal(root(f.terminal)?.state, 'working')
      const done = f.backend.append('command/done', { commandId: 'native-command', kind, text: 'PRIVATE command output' })
      assert.equal(root(f.terminal)?.state, kind === 'success' ? 'done' : 'error')
      assert.equal(root(f.terminal)?.message, kind === 'success' ? 'Command complete' : 'Command failed')
      f.backend.emit(done)
      assert.equal(notifications(f.terminal).length, 1)
      assert.match(notifications(f.terminal)[0]!, /Command/)
      assert.doesNotMatch(notifications(f.terminal)[0]!, /PRIVATE|Turn/)
      assert.equal(f.backend.sent.length, 0)
    } finally { await f.close() }
  })
}

test('App terminal: a completed native turn does not announce that an independently running command is finished', async () => {
  const f = await fixture({ family: 'ghostty', supported: false, settings: { terminalNotifications: 'always' } })
  try {
    f.backend.begin()
    f.backend.append('command/run', { commandId: 'remaining-command', name: 'compact' })
    f.backend.finish()
    assert.equal(f.app.isBusy, true)
    assert.equal(root(f.terminal)?.state, 'working')
    assert.equal(notifications(f.terminal).length, 0)
    f.backend.append('command/done', { commandId: 'remaining-command', kind: 'success' })
    assert.equal(f.app.isBusy, false)
    assert.equal(root(f.terminal)?.message, 'Command complete')
    assert.equal(notifications(f.terminal).length, 1)

    f.backend.begin(2)
    f.backend.append('command/run', { commandId: 'nested-command', name: 'plan' })
    f.backend.append('command/done', { commandId: 'nested-command', kind: 'success' })
    assert.equal(root(f.terminal)?.state, 'working', 'an active native turn still owns its own completion')
    assert.equal(notifications(f.terminal).length, 1)
    f.backend.finish(2)
    assert.equal(root(f.terminal)?.message, 'Turn complete')
    assert.equal(notifications(f.terminal).length, 2)
  } finally { await f.close() }
})

test('App terminal: normal native close is not a failure, while fatal alerts obey disabled-status preferences', async () => {
  const normal = await fixture({ family: 'ghostty', supported: false, settings: { terminalNotifications: 'always' } })
  try {
    normal.backend.emit({ type: 'closed', code: 0 })
    assert.equal(normal.terminal.statusRecords.size, 0)
    assert.equal(rootReports(normal.terminal, 'error').length, 0)
    assert.equal(notifications(normal.terminal).length, 0)
  } finally { await normal.close() }

  const failed = await fixture({ family: 'ghostty', supported: false, failConnect: true, settings: { terminalStatus: false, terminalNotifications: 'always' } })
  try {
    assert.equal(failed.terminal.statusRecords.size, 0)
    assert.equal(notifications(failed.terminal).length, 1)
    assert.match(notifications(failed.terminal)[0]!, /Session unavailable/)
  } finally { await failed.close() }
})

test('App terminal: directory reporting is independent of native window-title presentation', async () => {
  const f = await fixture({ settings: { terminalTitle: false }, info: { title: 'Native hidden title' } })
  try {
    assert.equal(f.terminal.title, 'original shell title')
    assert.equal(f.terminal.titleStack.length, 0)
    assert.ok(f.terminal.writes.some(data => data.includes(']7;file://') && data.includes(f.directory)))
    assert.equal(root(f.terminal)?.state, 'idle')
  } finally { await f.close() }
})

test('App terminal: a genuine native ready re-arms same-session presentation and forgets a previous fatal exit status', async () => {
  for (const fatal of [false, true]) {
    const f = await fixture({ family: 'ghostty', supported: false, settings: { terminalNotifications: 'always' } })
    try {
      if (fatal) f.backend.emit({ type: 'error', message: 'PRIVATE disconnected failure', fatal: true })
      else f.backend.emit({ type: 'closed', code: 0 })
      const alerts = notifications(f.terminal).length
      f.backend.ready({ ...f.backend.info })
      assert.equal(root(f.terminal)?.state, 'idle')
      f.backend.begin(9); f.backend.finish(9)
      assert.equal(root(f.terminal)?.state, 'done')
      assert.equal(notifications(f.terminal).length, alerts + 1)
      f.backend.emit({ type: 'error', message: 'PRIVATE second failure', fatal: true })
      assert.equal(notifications(f.terminal).length, alerts + 2, 'a recovered connection has a new failure identity')
    } finally { await f.close() }
  }
})

test('App terminal: authoritative native command activity prevents completion after the bounded correlation set overflows', async () => {
  const f = await fixture({ family: 'ghostty', supported: false, settings: { terminalNotifications: 'always' } })
  try {
    for (let index = 0; index < 65; index++) f.backend.append('command/run', { commandId: 'native-' + index, name: 'fixture-command' })
    f.backend.begin(); f.backend.finish()
    assert.equal(root(f.terminal)?.state, 'working')
    for (let index = 1; index < 65; index++) f.backend.append('command/done', { commandId: 'native-' + index, kind: 'success' })
    assert.equal(f.app.isBusy, true)
    assert.equal(root(f.terminal)?.state, 'working', 'the oldest native command still belongs to App, not the small presentation cache')
    assert.equal(notifications(f.terminal).length, 0)
    f.backend.append('command/done', { commandId: 'native-0', kind: 'error' })
    assert.equal(root(f.terminal)?.state, 'error')
    assert.equal(root(f.terminal)?.message, 'Command failed')
    assert.equal(notifications(f.terminal).length, 1)
  } finally { await f.close() }
})

test('App terminal: Rex automatic alerts have a focus-safe OSC 777 fallback when native status is disabled', async () => {
  const f = await fixture({ family: 'rex', supported: true, settings: { terminalStatus: false, terminalNotifications: 'auto' } })
  try {
    f.terminal.focus(false)
    f.backend.emit({ type: 'error', message: 'PRIVATE native failure', fatal: true })
    assert.equal(f.terminal.statusRecords.size, 0)
    assert.deepEqual(notifications(f.terminal), ['\x1b]777;notify;dsh-tui;Session unavailable\x07'])
  } finally { await f.close() }
})
