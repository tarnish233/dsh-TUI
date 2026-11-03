import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { App } from '../src/app.ts'
import { DemoBackend } from '../src/demo.ts'
import { PromptHistory } from '../src/config.ts'
import type { Backend, BackendEvent, JsonRecord, SessionInfo } from '../src/backend/types.ts'
import { VirtualTerminal, delay, until } from './helpers/terminal.ts'

async function fixture(screen: 'inline' | 'fullscreen' = 'fullscreen', config?: JsonRecord) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pi-app-'))
  if (config) await writeFile(join(directory, 'keybindings.json'), JSON.stringify(config))
  const terminal = new VirtualTerminal(90, 30)
  const backend = new DemoBackend({ cwd: directory, delayMs: 1 })
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen, demo: true, registerSignals: false })
  await app.start()
  await delay(25); await terminal.flush()
  return { app, terminal, backend, directory, async close() { await app.shutdown(); terminal.dispose(); await rm(directory, { recursive: true, force: true }) } }
}

async function painted(terminal: VirtualTerminal) { await delay(25); await terminal.flush() }

test('actual installed Pi patch + App: CC input, clipboard paste markers, clear recall and exit', async () => {
  const f = await fixture()
  try {
    assert.match(f.terminal.screen(), /DeepSeek Harness/)
    assert.match(f.terminal.screen(), /DEMO/)
    assert.doesNotMatch(f.terminal.screen(), /Ctrl\+P\/N history/)
    const initialLines = f.terminal.screen().split('\n')
    const footerLine = initialLines.findIndex(line => line.includes('demo (offline)/deepseek-demo'))
    assert.ok(footerLine > 0)
    assert.notEqual(initialLines[footerLine - 1]?.trim(), '', 'no empty shortcut row above the footer')
    f.terminal.type('src/utils/foo.ts')
    f.terminal.type('\x17')
    assert.equal(f.app.editor.getText(), '')
    f.terminal.type('\x19')
    assert.equal(f.app.editor.getText(), 'src/utils/foo.ts')
    f.terminal.type('\x1b[127;5u')
    assert.equal(f.app.editor.getText(), 'src/utils/foo.', 'Ctrl+Backspace is ordinary-word deletion, not Ctrl+W')
    f.app.editor.handleInput('\x1f')
    assert.equal(f.app.editor.getText(), 'src/utils/foo.ts')
    const before = f.app.editor.captureDraft()
    f.terminal.type('\x03')
    assert.equal(f.app.editor.getText(), '')
    f.terminal.type('\x10')
    assert.equal(f.app.editor.getExpandedText(), before.expandedText)
    f.terminal.type('\x0e')
    assert.equal(f.app.editor.getText(), '')
    f.terminal.type('\x1b[3~')
    assert.equal(f.terminal.stopped, false, 'Delete on empty draft never exits')
    f.terminal.type('\x04'); f.terminal.type('\x04')
    assert.equal(await f.app.exited, 0)
    assert.equal(f.terminal.stopped, true)
  } finally { await f.close() }
})

test('App stash preserves a large paste, cursor and undo on the same editor instance', async () => {
  const f = await fixture()
  try {
    const editor = f.app.editor
    const pasted = Array.from({ length: 25 }, (_, index) => 'line ' + index).join('\n')
    f.terminal.type('\x1b[200~' + pasted + '\x1b[201~')
    f.terminal.type('\x02')
    const previous = editor.captureDraft()
    f.terminal.type('\x13')
    assert.equal(editor.getText(), '')
    f.terminal.type('\x13')
    assert.equal(f.app.editor, editor)
    assert.equal(editor.getExpandedText(), previous.expandedText)
    assert.deepEqual(editor.getCursor(), { line: previous.cursorLine, col: previous.cursorCol })
    assert.deepEqual(editor.captureDraft().pastes, previous.pastes)
    editor.handleInput('\x1f')
    assert.equal(editor.getExpandedText(), '', 'undo after restore retains original paste undo state')
  } finally { await f.close() }
})

test('App history search retains readline edits and cancellation restores lossless draft', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pi-search-'))
  const history = new PromptHistory(directory, directory)
  await history.add('one older prompt'); await history.add('two latest prompt')
  const terminal = new VirtualTerminal(80, 25)
  const app = new App({ backend: new DemoBackend({ cwd: directory, delayMs: 0 }), cwd: directory, configDir: directory, terminal, screen: 'inline', registerSignals: false, demo: true })
  try {
    await app.start(); await painted(terminal)
    const pasted = '中文草稿\n' + 'long draft '.repeat(120)
    terminal.type('\x1b[200~' + pasted + '\x1b[201~')
    terminal.type('\x02')
    const original = app.editor.captureDraft()
    terminal.type('\x12'); terminal.type('older'); await painted(terminal)
    assert.match(terminal.screen(), /History search/)
    terminal.type('\x17'); await painted(terminal)
    assert.match(terminal.screen(), /2/)
    terminal.type('\x03'); await painted(terminal)
    assert.equal(app.editor.getExpandedText(), original.expandedText)
    assert.deepEqual(app.editor.captureDraft().pastes, original.pastes)
    assert.deepEqual(app.editor.getCursor(), { line: original.cursorLine, col: original.cursorCol })
    terminal.type('\x12'); terminal.type('older'); terminal.type('\x1b'); await painted(terminal)
    assert.equal(app.editor.getText(), 'one older prompt', 'inline Esc accepts search match for editing')
    terminal.type('\x1f')
    assert.equal(app.editor.getExpandedText(), original.expandedText)
  } finally { await app.shutdown(); terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('App model picker, shared configured list keys and actual Shift+Tab permission cycle', async () => {
  const f = await fixture('fullscreen', { 'list.next': 'ctrl+f', 'list.previous': 'ctrl+b' })
  try {
    await f.app.submit('/model'); await painted(f.terminal)
    assert.match(f.terminal.screen(), /Choose model/)
    assert.match(f.terminal.screen(), /Demo model/)
    f.terminal.type('\r'); await painted(f.terminal)
    assert.equal(f.app.editor.focused, true)
    f.terminal.type('\x1b[Z')
    await until(() => f.app.session?.permissions?.currentValue === 'danger-full-access', 'permission preset changes via native-shaped command')
    assert.ok(f.backend.info.events?.every(event => event.type !== 'plan/mode'), 'permission shortcut never creates a plan mode')
    await f.app.submit('/settings'); await painted(f.terminal)
    f.terminal.type('\x06'); await painted(f.terminal)
    const screen = f.terminal.screen()
    assert.ok(screen.split('\n').some(line => line.includes('❯') && line.includes('Thinking')), screen)
    f.terminal.type('\x1b'); await painted(f.terminal)
    f.terminal.type('abc'); f.terminal.type('\x02')
    assert.equal(f.app.editor.getCursor().col, 2, 'Ctrl+B remains text movement outside lists')
  } finally { await f.close() }
})

test('App resolves native-shaped demo approvals and remains usable after cancellation', async () => {
  const f = await fixture()
  try {
    await f.app.submit('approval'); await painted(f.terminal)
    assert.match(f.terminal.screen(), /Approve|Approval|Allow/i)
    f.terminal.type('\x1b')
    await f.backend.whenIdle(); await painted(f.terminal)
    assert.equal(f.app.isBusy, false)
    await f.app.submit('a streaming demonstration')
    await f.backend.whenIdle(); await painted(f.terminal)
    assert.ok(f.terminal.screen().includes('ready'))
    assert.ok(f.terminal.writes.some(write => write.includes('\x1b[?2026h')))
  } finally { await f.close() }
})

test('App stream can resize repeatedly; final document is readable and backend stays separate', async () => {
  for (const screen of ['inline', 'fullscreen'] as const) {
    const f = await fixture(screen)
    try {
      await f.app.submit('中文 😀 code and streaming')
      for (const [width, height] of [[40, 20], [120, 40], [60, 18], [90, 30]]) {
        f.terminal.resize(width!, height!); await painted(f.terminal)
      }
      await f.backend.whenIdle(); await painted(f.terminal)
      const document = f.terminal.document()
      assert.match(document, /ready/)
      assert.match(document, /demo/i)
      assert.ok(!document.includes('undefined'))
      assert.equal(f.terminal.progress, false)
    } finally { await f.close() }
  }
})

test('App takes queued text back into the editor with Ctrl+P and restores empty draft with Ctrl+N', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pi-queue-'))
  const terminal = new VirtualTerminal(90, 30)
  const backend = new DemoBackend({ cwd: directory, delayMs: 20 })
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen: 'fullscreen', registerSignals: false, demo: true })
  try {
    await app.start()
    await app.submit('ongoing turn')
    await until(() => app.isBusy, 'demo turn running')
    await app.submit('queued followup')
    terminal.type('\x10')
    await until(() => app.editor.getText() === 'queued followup', 'queued text returned')
    terminal.type('\x0e')
    assert.equal(app.editor.getText(), '')
    await backend.cancel()
  } finally { await app.shutdown(); terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('App question tabs and multi-select submit through the backend callback', async () => {
  const f = await fixture()
  try {
    await f.app.submit('question')
    await until(() => f.terminal.screen().includes('Which demo colors'), 'question dialog appears')
    await painted(f.terminal)
    assert.match(f.terminal.screen(), /Which demo colors/)
    f.terminal.type('1'); f.terminal.type('2'); f.terminal.type('\t'); await painted(f.terminal)
    assert.match(f.terminal.screen(), /Pick one delivery mode/)
    f.terminal.type('2'); f.terminal.type('\r')
    await f.backend.whenIdle(); await painted(f.terminal)
    assert.equal(f.app.isBusy, false)
    assert.match(f.terminal.document(), /Expanded/)
  } finally { await f.close() }
})

class ControlledBackend implements Backend {
  private listeners = new Set<(event: BackendEvent) => void>()
  readonly sent: string[] = []
  nextSend?: () => Promise<void>
  info: SessionInfo
  constructor(cwd: string) { this.info = { sessionId: 'controlled-session', cwd, provider: 'test', model: 'test', capabilities: [] } }
  onEvent(listener: (event: BackendEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  async connect() { for (const listener of this.listeners) listener({ type: 'ready', info: this.info }); return this.info }
  async send(text: string) { this.sent.push(text); await this.nextSend?.() }
  async cancel() {}
  async command() { return this.info }
  async respond() {}
  async close() {}
}

test('late send rejection never overwrites a fresh draft', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pi-reject-'))
  const terminal = new VirtualTerminal()
  const backend = new ControlledBackend(directory)
  let reject!: (error: Error) => void
  backend.nextSend = () => new Promise<void>((_, no) => { reject = no })
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, registerSignals: false })
  try {
    await app.start()
    const sending = app.submit('old unsent message')
    terminal.type('fresh new draft')
    reject(new Error('delayed failure')); await sending
    assert.equal(app.editor.getText(), 'fresh new draft')
  } finally { await app.shutdown(); terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('recall-history write failure never retries an accepted backend prompt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-pi-history-fail-'))
  const terminal = new VirtualTerminal()
  const backend = new ControlledBackend(directory)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, registerSignals: false })
  try {
    await app.start()
    await mkdir(join(directory, 'history.json'))
    terminal.type('fresh draft')
    await app.submit('accepted prompt')
    await delay(30)
    assert.deepEqual(backend.sent, ['accepted prompt'])
    assert.equal(app.editor.getText(), 'fresh draft')
  } finally { await app.shutdown(); terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
})


test('keyboard help lives in Settings; /reload applies TUI resources and keeps the DSH boundary', async () => {
  const f = await fixture('inline')
  try {
    const events: BackendEvent[] = []
    f.backend.onEvent(event => events.push(event))
    const lastNotice = () => f.app.store.items.filter(item => item.kind === 'notice').at(-1)?.text ?? ''
    await f.app.submit('/help')
    assert.ok(!lastNotice().includes('/hotkeys'))
    assert.match(lastNotice(), /\/reload —/)
    await f.app.submit('/settings'); await painted(f.terminal)
    assert.match(f.terminal.screen(), /Keyboard shortcuts/)
    f.terminal.type('4'); await painted(f.terminal)
    assert.match(f.terminal.screen(), /Navigation/)
    assert.match(f.terminal.screen(), /Start of line/)
    f.terminal.type(String.fromCharCode(27)); await painted(f.terminal)
    f.terminal.type(String.fromCharCode(27)); await painted(f.terminal)

    await writeFile(join(f.directory, 'keybindings.json'), JSON.stringify({ 'app.model.select': 'ctrl+x ctrl+m' }))
    await writeFile(join(f.directory, 'settings.json'), JSON.stringify({ screen: 'fullscreen', showThinking: true }))
    f.terminal.type('reload keeps this draft')
    const draft = f.app.editor.captureDraft()
    await f.app.submit('/reload')
    assert.deepEqual(f.app.keymap.getBindings('app.model.select'), ['ctrl+x ctrl+m'])
    assert.equal(f.app.editor.getText(), 'reload keeps this draft')
    assert.deepEqual(f.app.editor.getCursor(), { line: draft.cursorLine, col: draft.cursorCol })
    assert.deepEqual(f.app.editor.captureDraft().pastes, draft.pastes)
    assert.match(lastNotice(), /TUI reloaded/)
    assert.match(lastNotice(), /Screen change applies on the next launch/)
    assert.match(lastNotice(), /Demo backend/)
    await writeFile(join(f.directory, 'keybindings.json'), '{ INVALID JSON')
    const before = f.app.store.items.length
    await f.app.submit('/reload')
    assert.deepEqual(f.app.keymap.getBindings('app.model.select'), ['ctrl+x ctrl+m'])
    const notices = f.app.store.items.slice(before).filter(item => item.kind === 'notice').map(item => item.text).join('\n')
    assert.match(notices, /Keybindings not applied/)
    assert.match(notices, /TUI reloaded/)

    await writeFile(join(f.directory, 'keybindings.json'), JSON.stringify({ 'app.model.select': 'ctrl+x ctrl+d' }))
    await until(() => f.app.keymap.getBindings('app.model.select')[0] === 'ctrl+x ctrl+d', 'saving the binding file applies without any slash command')
    assert.equal(events.some(event => event.type === 'session_event' && event.event.type === 'command/run'), false, 'help and reload never execute DSH business commands')
  } finally { await f.close() }
})


for (const screen of ['inline', 'fullscreen'] as const) {
  test('Settings shortcut editor saves, disables and resets one binding without losing the draft (' + screen + ')', async () => {
    const f = await fixture(screen)
    try {
      const events: BackendEvent[] = []
      f.backend.onEvent(event => events.push(event))
      f.terminal.type('draft preserved ')
      f.terminal.type('\x1b[200~' + '中文 draft\n'.repeat(30) + '\x1b[201~')
      const editor = f.app.editor, before = editor.captureDraft()
      await f.app.submit('/settings'); f.terminal.type('4'); await painted(f.terminal)
      assert.match(f.terminal.screen(), /Keyboard shortcuts/)
      assert.match(f.terminal.screen(), /Navigation/)
      assert.doesNotMatch(f.terminal.screen(), /cc-match|editor\.move/)
      f.terminal.type('\r'); await painted(f.terminal)
      assert.match(f.terminal.screen(), /One binding per line/)
      for (let count = 0; count < 4; count++) f.terminal.type('\x15')
      f.terminal.type('ctrl+q'); f.terminal.type('\r')
      await until(() => f.app.keymap.getBindings('editor.move.line-start').join(' ') === 'ctrl+q', 'saved key is live')
      await painted(f.terminal)
      assert.match(f.terminal.screen(), /Saved/)
      const file = join(f.directory, 'keybindings.json')
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { 'editor.move.line-start': ['ctrl+q'] })
      f.terminal.type('\x1b'); await painted(f.terminal)
      assert.match(f.terminal.screen(), /Settings/)
      f.terminal.type('\x1b'); await painted(f.terminal)
      assert.equal(f.app.editor, editor)
      assert.equal(editor.getExpandedText(), before.expandedText)
      assert.deepEqual(editor.getCursor(), { line: before.cursorLine, col: before.cursorCol })
      assert.deepEqual(editor.captureDraft().pastes, before.pastes)
      f.terminal.type('\x11')
      assert.equal(editor.getCursor().col, 0, 'the edited shortcut executes on the real main editor')

      await f.app.submit('/settings'); f.terminal.type('4'); await painted(f.terminal)
      f.terminal.type('d')
      await until(() => !f.app.keymap.getBindings('editor.move.line-start').length, 'disabled action is live')
      await painted(f.terminal)
      assert.equal(JSON.parse(await readFile(file, 'utf8'))['editor.move.line-start'], null)
      f.terminal.type('r')
      await until(() => f.app.keymap.getBindings('editor.move.line-start').includes('ctrl+a'), 'default restored')
      await painted(f.terminal)
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {})
      assert.equal(events.some(event => event.type === 'session_event' && event.event.type === 'command/run'), false, 'keyboard settings never execute a DSH business command')
    } finally { await f.close() }
  })
}

test('shortcut conflicts stay in the edit pane and malformed configuration is never overwritten', async () => {
  const f = await fixture()
  try {
    const file = join(f.directory, 'keybindings.json')
    await writeFile(file, JSON.stringify({ 'app.model.select': 'alt+m' }))
    await until(() => f.app.keymap.getBindings('app.model.select')[0] === 'alt+m', 'unrelated override applied')
    await f.app.submit('/settings'); f.terminal.type('4'); f.terminal.type('\r'); await painted(f.terminal)
    for (let count = 0; count < 4; count++) f.terminal.type('\x15')
    f.terminal.type('ctrl+e'); f.terminal.type('\r')
    await until(() => f.terminal.screen().includes('Shortcut conflict'), 'conflict rendered without saving')
    assert.deepEqual(f.app.keymap.getBindings('editor.move.line-start'), ['home', 'ctrl+a'])
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { 'app.model.select': 'alt+m' })
    for (let count = 0; count < 4; count++) f.terminal.type('\x15')
    f.terminal.type('ctrl+q')
    await writeFile(file, '{ INVALID JSON')
    f.terminal.type('\r'); await painted(f.terminal)
    assert.equal(await readFile(file, 'utf8'), '{ INVALID JSON')
    assert.deepEqual(f.app.keymap.getBindings('editor.move.line-start'), ['home', 'ctrl+a'])
    assert.match(f.terminal.screen(), /One binding per line/, 'failed save keeps the field available for repair')
  } finally { await f.close() }
})

test('App exposes /preset and /effort pickers; started sessions stage the preset for /new', async () => {
  const f = await fixture()
  try {
    await f.app.submit('/preset'); await painted(f.terminal)
    assert.match(f.terminal.screen(), /Choose agent preset/)
    assert.match(f.terminal.screen(), /Standard mode/)
    assert.match(f.terminal.screen(), /Minimal mode/)
    f.terminal.type('\x1b[B'); f.terminal.type('\r'); await painted(f.terminal)
    assert.equal(f.app.session?.preset, 'minimal')
    assert.match(f.terminal.screen(), /Agent preset: Minimal mode/)
    assert.match(f.terminal.screen(), /preset: minimal/)

    await f.app.submit('/preset status')
    let notice = f.app.store.items.filter(item => item.kind === 'notice').at(-1)?.text ?? ''
    assert.match(notice, /Agent preset: minimal/)
    assert.match(notice, /Available: standard, minimal/)

    await f.app.submit('/effort'); await painted(f.terminal)
    assert.match(f.terminal.screen(), /Choose reasoning effort/)
    assert.match(f.terminal.screen(), /High/)
    f.terminal.type('\x1b[B'); f.terminal.type('\r'); await painted(f.terminal)
    assert.equal(f.app.session?.reasoningEffort, 'low')
    assert.match(f.terminal.screen(), /Reasoning effort: low/)
    assert.match(f.terminal.screen(), /effort: low/)

    await f.app.submit('/effort status')
    notice = f.app.store.items.filter(item => item.kind === 'notice').at(-1)?.text ?? ''
    assert.match(notice, /Reasoning effort: low/)
    assert.match(notice, /Available: low, medium, high, max/)

    await f.app.submit('tools')
    await f.backend.whenIdle(); await painted(f.terminal)
    await f.app.submit('/preset'); await painted(f.terminal)
    f.terminal.type('\r'); await painted(f.terminal)
    assert.equal(f.app.session?.preset, 'minimal', 'a started session keeps its preset')
    notice = f.app.store.items.filter(item => item.kind === 'notice').at(-1)?.text ?? ''
    assert.match(notice, /next \/new session/)
    assert.match(f.terminal.screen(), /next preset: standard/)

    await f.app.submit('/new'); await painted(f.terminal)
    assert.equal(f.app.session?.preset, 'standard')
    assert.doesNotMatch(f.terminal.screen(), /next preset/)
  } finally { await f.close() }
})
