import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, DecisionRequest, JsonRecord, SessionInfo } from '../src/backend/types.ts'
import { VirtualTerminal, delay } from './helpers/terminal.ts'

/** Control/transport fixture only. It has no model, tool loop, scheduler or durable mirror. */
class PiClearBackend implements Backend {
  readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly commands: string[] = []
  readonly responses: Array<{ id: string; value: unknown }> = []
  cancels = 0
  closes = 0
  info: SessionInfo
  constructor(cwd: string) {
    this.info = { sessionId: 'pi-clear-root', attachmentId: 'pi-clear-attachment', cwd,
      provider: 'fixture', model: 'fixture-model', capabilities: ['state', 'commands'], events: [] }
  }
  onEvent(listener: (event: BackendEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent): void { for (const listener of this.listeners) listener(event) }
  async connect() { this.emit({ type: 'ready', info: this.info }); return this.info }
  async send(_text: string) { this.emit({ type: 'status', sessionId: this.info.sessionId, status: 'running' }) }
  async cancel() { this.cancels++; this.emit({ type: 'status', sessionId: this.info.sessionId, status: 'idle' }) }
  async respond(id: string, value: unknown) { this.responses.push({ id, value }); this.emit({ type: 'decision_closed', sessionId: this.info.sessionId, id }) }
  async close() { this.closes++ }
  async command(name: string, _args: JsonRecord = {}) {
    this.commands.push(name)
    if (name === 'commands') return []
    if (name === 'state') return { sessionId: this.info.sessionId, pending: { nextTurn: 0, nextStep: 0 }, queued: 0, queue: [] }
    if (name === 'permissions') return { currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'safe', name: 'Safe' }] }
    if (name === 'efforts') return { available: true, reasoningEffort: 'low', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] }
    if (name === 'presets') return { blank: true, current: 'fixture', presets: [{ id: 'fixture', name: 'Fixture preset' }] }
    return undefined
  }
  running(): void { this.emit({ type: 'status', sessionId: this.info.sessionId, status: 'running' }) }
  decision(request: DecisionRequest): void { this.emit({ type: 'decision', sessionId: this.info.sessionId, request }) }
}

interface Inspection {
  exitArm?: { at: number; id: string }
  dialog?: unknown
  dialogOverlay?: unknown
  dialogPlacement: 'composer' | 'workspace'
  composerInteraction: { readonly active: boolean }
  subagentReplyTarget?: { childId: string; label: string; rootSessionId: string; parentSessionId: string }
  decisionDetailsOverlay?: { parent: unknown; dialog: unknown }
  pickPermission(): Promise<void>
  pickEffort(): Promise<void>
  pickPreset(existing?: JsonRecord): Promise<void>
  openSettings(): void
  dismissDialog(): void
  attachLocalFile(argument: string): Promise<void>
  nativeUi: { openRename(): void; openFork(): void }
}
const inspect = (app: App) => app as unknown as Inspection
const paint = async (terminal: VirtualTerminal) => { await delay(25); await terminal.flush() }

async function fixture(screen: 'inline' | 'fullscreen', bindings?: JsonRecord) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tui-pi-clear-'))
  if (bindings !== undefined) await writeFile(join(directory, 'keybindings.json'), JSON.stringify(bindings))
  const terminal = new VirtualTerminal(100, 30)
  const backend = new PiClearBackend(directory)
  const app = new App({ backend, cwd: directory, configDir: directory, screen, terminal,
    registerSignals: false, installCrashHandlers: false })
  await app.start(); await paint(terminal)
  return { app, backend, terminal,
    async close() { await app.shutdown(); terminal.dispose(); await rm(directory, { recursive: true, force: true }) },
  }
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`Pi clear: ${screen} busy draft clears without cancelling root/tool/child and Up restores`, async () => {
    const f = await fixture(screen)
    try {
      f.backend.running()
      f.app.editor.setText('draft before clearing\nsecond line')
      f.app.editor.handleInput('\x1b[200~' + 'large pasted context '.repeat(300) + '\x1b[201~')
      f.app.editor.insertImage({ type: 'image', mediaType: 'image/png', data: Buffer.alloc(16, 3).toString('base64'), name: 'fixture.png' })
      f.app.editor.insertFile({ type: 'file', attachment: { attachmentId: 'fixture-file', name: 'fixture.txt', bytes: 4 } })
      const text = f.app.editor.getText(), expanded = f.app.editor.getExpandedText(), cursor = f.app.editor.getCursor()
      const editor = f.app.editor
      const commands = f.backend.commands.length
      f.terminal.type('\x03')
      assert.equal(f.app.editor, editor)
      assert.equal(f.app.editor.getText(), '')
      assert.equal(f.backend.cancels, 0)
      assert.equal(f.backend.closes, 0)
      assert.equal(f.backend.commands.length, commands, 'clear does not stop a child, execute a command, or change the native queue')
      assert.equal(f.app.isBusy, true)
      assert.equal(inspect(f.app).exitArm?.id, 'app.clear')
      f.terminal.type('\x1b[A')
      assert.equal(f.app.editor.getText(), text)
      assert.equal(f.app.editor.getExpandedText(), expanded)
      assert.deepEqual(f.app.editor.getCursor(), cursor)
      assert.equal(inspect(f.app).exitArm, undefined, 'explicit cleared-draft recovery leaves the exit window')
    } finally { await f.close() }
  })

  test(`Pi clear: ${screen} one clear is one undo unit and retains paste/attachment content`, async () => {
    const f = await fixture(screen)
    try {
      f.backend.running()
      f.app.editor.setText('undo this clear')
      f.app.editor.handleInput('\x1b[200~' + 'owned paste '.repeat(500) + '\x1b[201~')
      const text = f.app.editor.getText(), expanded = f.app.editor.getExpandedText(), cursor = f.app.editor.getCursor()
      f.terminal.type('\x03')
      assert.equal(f.app.editor.getText(), '')
      f.terminal.type('\x1f')
      assert.equal(f.app.editor.getText(), text)
      assert.equal(f.app.editor.getExpandedText(), expanded)
      assert.deepEqual(f.app.editor.getCursor(), cursor)
      assert.equal(f.backend.cancels, 0)
    } finally { await f.close() }
  })

  test(`Pi clear: ${screen} two physical clears exit safely even while root is busy`, async () => {
    const f = await fixture(screen)
    try {
      f.backend.running(); f.app.editor.setText('busy draft')
      f.terminal.type('\x03')
      assert.equal(f.backend.cancels, 0)
      f.terminal.type('\x03')
      assert.equal(await f.app.exited, 0)
      assert.equal(f.terminal.stopped, true)
      assert.equal(f.backend.closes, 1)
      assert.equal(f.backend.cancels, 0, 'exit delegates native root lifecycle, not an extra UI cancellation loop')
    } finally { await f.close() }
  })

  test(`Pi clear: ${screen} Esc is the native interrupt and preserves a busy draft`, async () => {
    const f = await fixture(screen)
    try {
      f.backend.running(); f.app.editor.setText('keep this while interrupting')
      f.terminal.type('\x1b')
      await paint(f.terminal)
      assert.equal(f.backend.cancels, 1)
      assert.equal(f.app.editor.getExpandedText(), 'keep this while interrupting')
      assert.equal(f.backend.closes, 0)
    } finally { await f.close() }
  })
}

test('Pi clear 500ms boundary uses installed-Pi timing, independently of busy state', async () => {
  const f = await fixture('fullscreen')
  const originalNow = Date.now, originalShutdown = f.app.shutdown.bind(f.app)
  let now = 10_000, requests = 0
  Date.now = () => now
  f.app.shutdown = async () => { requests++ }
  try {
    f.backend.running(); f.app.editor.setText('first')
    f.terminal.type('\x03')
    assert.equal(requests, 0)
    now += 500
    f.terminal.type('\x03')
    assert.equal(requests, 0, 'exactly 500ms is a fresh first press, not an exit')
    now += 499
    f.terminal.type('\x03')
    assert.equal(requests, 1, '499ms is inside the second-press window')
    assert.equal(f.backend.cancels, 0)
  } finally { Date.now = originalNow; f.app.shutdown = originalShutdown; await f.close() }
})

test('Pi clear window remains after ordinary typing, matching the installed Pi handler', async () => {
  const f = await fixture('fullscreen')
  const originalNow = Date.now, originalShutdown = f.app.shutdown.bind(f.app)
  let now = 20_000, requests = 0
  Date.now = () => now
  f.app.shutdown = async () => { requests++ }
  try {
    f.app.editor.setText('clear me'); f.terminal.type('\x03')
    now += 100
    f.terminal.type('new draft')
    f.terminal.type('\x03')
    assert.equal(requests, 1)
    assert.equal(f.backend.cancels, 0)
  } finally { Date.now = originalNow; f.app.shutdown = originalShutdown; await f.close() }
})

test('Pi clear remapping has no old-key fallback; explicit native interrupt remains independent', async () => {
  const f = await fixture('fullscreen', { 'app.clear': 'ctrl+q', 'app.interrupt': 'ctrl+x ctrl+i' })
  try {
    f.backend.running(); f.app.editor.setText('remapped clear')
    f.terminal.type('\x03')
    assert.equal(f.app.editor.getText(), 'remapped clear')
    assert.equal(f.backend.cancels, 0)
    f.terminal.type('\x11')
    assert.equal(f.app.editor.getText(), '')
    assert.equal(f.backend.cancels, 0)
    f.app.editor.setText('explicit interrupt keeps draft')
    f.terminal.type('\x18'); f.terminal.type('\x09')
    assert.equal(f.backend.cancels, 1)
    assert.equal(f.app.editor.getText(), 'explicit interrupt keeps draft')
  } finally { await f.close() }
})

test('Pi clear disabled leaves Ctrl+C inert at the root without implicit native abort', async () => {
  const f = await fixture('fullscreen', { 'app.clear': [] })
  try {
    f.backend.running(); f.app.editor.setText('clear disabled')
    f.terminal.type('\x03')
    assert.equal(f.app.editor.getText(), 'clear disabled')
    assert.equal(f.backend.cancels, 0)
    assert.equal(inspect(f.app).exitArm, undefined)
  } finally { await f.close() }
})

test('default Ctrl+C cancels only the native question in composer and leaves root draft/work intact', async () => {
  const f = await fixture('fullscreen')
  try {
    f.backend.running(); f.app.editor.setText('draft behind question')
    const editor = f.app.editor, before = f.app.editor.captureDraft()
    f.app.store.report('READABLE_CONTEXT_BEFORE_QUESTION')
    f.backend.decision({ id: 'question-pi-clear', kind: 'question', title: 'Fixture native question',
      questions: [{ question: 'Pick an option', options: [{ label: 'Blue' }, { label: 'Green' }] }] })
    await paint(f.terminal)
    assert.equal(inspect(f.app).dialogPlacement, 'composer')
    assert.equal(inspect(f.app).dialogOverlay, undefined)
    assert.equal(inspect(f.app).composerInteraction.active, true)
    assert.match(f.terminal.screen(), /READABLE_CONTEXT_BEFORE_QUESTION/)
    f.terminal.type('\x03')
    assert.deepEqual(f.backend.responses, [{ id: 'question-pi-clear', value: { cancelled: true } }])
    assert.equal(f.backend.cancels, 0)
    assert.equal(f.app.isBusy, true)
    assert.equal(f.app.editor, editor)
    assert.deepEqual(f.app.editor.captureDraft(), before)
    assert.equal(inspect(f.app).composerInteraction.active, false)
    assert.equal(inspect(f.app).exitArm, undefined)
  } finally { await f.close() }
})

test('default Ctrl+C rejects only the current approval and does not globally abort the turn', async () => {
  const f = await fixture('fullscreen')
  try {
    f.backend.running(); f.app.editor.setText('draft behind approval')
    f.backend.decision({ id: 'approval-pi-clear', kind: 'approval', title: 'Fixture approval',
      options: [{ label: 'Allow once', value: 'allowed-once' }, { label: 'Reject', value: 'rejected' }] })
    f.terminal.type('\x03')
    assert.deepEqual(f.backend.responses, [{ id: 'approval-pi-clear', value: 'rejected' }])
    assert.equal(f.backend.cancels, 0)
    assert.equal(f.app.editor.getText(), 'draft behind approval')
    assert.equal(inspect(f.app).exitArm, undefined)
  } finally { await f.close() }
})

test('busy input history Ctrl+C locally restores the draft without cancelling root', async () => {
  const f = await fixture('fullscreen')
  try {
    f.backend.running(); f.app.editor.setText('draft before searching')
    const before = f.app.editor.captureDraft()
    f.terminal.type('\x12')
    assert.equal(inspect(f.app).composerInteraction.active, true)
    f.terminal.type('query'); f.terminal.type('\x03')
    assert.deepEqual(f.app.editor.captureDraft(), before)
    assert.equal(f.backend.cancels, 0)
    assert.equal(f.app.isBusy, true)
    assert.equal(inspect(f.app).composerInteraction.active, false)
  } finally { await f.close() }
})

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`composer decisions ${screen}: actual viewport retains context, selected choice and actions across short/wide resize`, async () => {
    const f = await fixture(screen)
    try {
      f.app.editor.setText('preserved multiline draft\nsecond line\nthird line')
      const before = f.app.editor.captureDraft(), editor = f.app.editor
      f.app.store.report('CONTEXT_VISIBLE_FOR_DECISION')
      for (const [cols, rows] of [[40, 12], [80, 18], [80, 24], [120, 40]] as const) {
        f.terminal.resize(cols, rows)
        const id = `geometry-${cols}-${rows}`
        f.backend.decision({ id, kind: 'question', title: 'Geometry question', questions: [
          { question: 'Choose a color', options: [{ label: 'Blue' }, { label: 'Green' }] },
        ] })
        await paint(f.terminal)
        const visible = f.terminal.screen()
        assert.match(visible, /CONTEXT_VISIBLE_FOR_DECISION/, `${cols}x${rows} must retain the actual transcript context`)
        assert.match(visible, /Blue|Green/, `${cols}x${rows} must paint a real choice, not just invisible keyboard targets`)
        assert.match(visible, /Cancel|cancel/, `${cols}x${rows} must keep a local cancellation affordance`)
        assert.equal(inspect(f.app).dialogOverlay, undefined)
        f.terminal.type('\x03')
        assert.equal(f.app.editor, editor)
        assert.deepEqual(f.app.editor.captureDraft(), before)
      }
      assert.equal(f.backend.cancels, 0)
    } finally { await f.close() }
  })

  test(`composer native detail ${screen}: full read/back retains the same question and custom answer`, async () => {
    const f = await fixture(screen)
    try {
      f.app.editor.setText('main draft must survive details')
      const before = f.app.editor.captureDraft()
      const detail = '# Native plan\n\n' + Array.from({ length: 75 }, (_, index) => `Native line ${index}`).join('\n\n') + '\n\nPLAN_FINAL_LINE'
      f.backend.decision({ id: 'full-native-plan', kind: 'question', title: 'Review plan', questions: [
        { question: 'Review the native plan', detail, options: [{ label: 'Approve' }, { label: 'Explain' }] },
      ] })
      const parent = inspect(f.app).dialog
      f.terminal.type('3'); f.terminal.type('custom answer kept')
      f.terminal.type('\x0f'); await paint(f.terminal)
      assert.equal(inspect(f.app).decisionDetailsOverlay?.parent === parent, true)
      assert.equal(inspect(f.app).dialog === parent, true, 'full-detail reading must not replace or dispose the pending decision')
      assert.equal(f.backend.responses.length, 0)
      f.terminal.type('\x1b[F'); await paint(f.terminal)
      assert.match(f.terminal.screen(), /PLAN_FINAL_LINE/, 'the native plan is fully readable, not permanently clipped to the composer preview')
      f.terminal.type('\x03'); await paint(f.terminal)
      assert.equal(inspect(f.app).decisionDetailsOverlay === undefined, true)
      assert.equal(inspect(f.app).dialog === parent, true)
      assert.equal(f.backend.responses.length, 0)
      f.terminal.type('\r')
      assert.deepEqual(f.backend.responses, [{ id: 'full-native-plan', value: { answers: ['custom answer kept'] } }])
      assert.deepEqual(f.app.editor.captureDraft(), before)
      assert.equal(f.backend.cancels, 0)
    } finally { await f.close() }
  })
}

test('quick choices and local attachment use composer; Settings children retain workspace placement', async () => {
  const f = await fixture('fullscreen')
  try {
    f.app.editor.setText('draft across quick operations')
    const before = f.app.editor.captureDraft(), api = inspect(f.app)
    for (const open of [() => api.pickPermission(), () => api.pickEffort(), () => api.pickPreset(), () => api.attachLocalFile('')]) {
      await open()
      assert.equal(api.dialogPlacement, 'composer')
      assert.equal(api.dialogOverlay, undefined)
      f.terminal.type('\x03')
      assert.deepEqual(f.app.editor.captureDraft(), before)
    }
    api.openSettings()
    assert.equal(api.dialogPlacement, 'workspace')
    await api.pickPermission()
    assert.equal(api.dialogPlacement, 'workspace', 'a Settings child remains in the parent workspace, not the main composer')
    assert.notEqual(api.dialogOverlay, undefined)
    f.terminal.type('\x03')
    assert.deepEqual(f.app.editor.captureDraft(), before)
    assert.equal(f.backend.cancels, 0)
  } finally { await f.close() }
})

test('native rename/fork main forms use composer while Settings-initiated forms remain workspace', async () => {
  const f = await fixture('fullscreen')
  try {
    f.backend.info = { ...f.backend.info, capabilities: [...f.backend.info.capabilities, 'session-rename', 'session-fork'] }
    f.backend.emit({ type: 'ready', info: f.backend.info })
    const api = inspect(f.app)
    api.nativeUi.openRename()
    assert.equal(api.dialogPlacement, 'composer')
    f.terminal.type('\x03')
    api.nativeUi.openFork()
    assert.equal(api.dialogPlacement, 'composer')
    f.terminal.type('\x03')
    api.openSettings()
    api.nativeUi.openRename()
    assert.equal(api.dialogPlacement, 'workspace')
    f.terminal.type('\x03')
    api.openSettings()
    api.nativeUi.openFork()
    assert.equal(api.dialogPlacement, 'workspace')
    f.terminal.type('\x03')
    assert.equal(f.backend.cancels, 0)
  } finally { await f.close() }
})

test('busy cleared-draft Up recovery wins over an empty native dequeue', async () => {
  const f = await fixture('fullscreen')
  try {
    f.backend.info = { ...f.backend.info, capabilities: [...f.backend.info.capabilities, 'dequeue'] }
    f.backend.emit({ type: 'ready', info: f.backend.info })
    f.backend.running()
    f.app.editor.setText('saved while the Agent runs')
    const before = f.app.editor.captureDraft()
    f.terminal.type('\x03')
    assert.equal(f.app.editor.getText(), '')
    f.terminal.type('\x1b[A')
    assert.equal(f.app.editor.getExpandedText(), before.expandedText)
    assert.equal(f.backend.commands.includes('dequeue'), false, 'no competing human inbox exists')
    assert.equal(f.backend.cancels, 0)
  } finally { await f.close() }
})

test('Pi clear in a child-addressed main editor clears only text and keeps the native destination', async () => {
  const f = await fixture('fullscreen')
  try {
    const api = inspect(f.app)
    f.backend.info = { ...f.backend.info, capabilities: [...f.backend.info.capabilities, 'subagent-prompt', 'subagent-interrupt'] }
    f.backend.emit({ type: 'ready', info: f.backend.info })
    f.backend.emit({ type: 'subagents', sessionId: f.backend.info.sessionId, value: { entries: [{
      id: 'fixture-child', parentSessionId: f.backend.info.sessionId, mode: 'continuable', local: true,
      label: 'Fixture child', status: 'running',
    }] } })
    api.subagentReplyTarget = { childId: 'fixture-child', label: 'Fixture child', rootSessionId: f.backend.info.sessionId, parentSessionId: f.backend.info.sessionId }
    f.backend.running()
    f.app.editor.setText('draft for the child')
    const reads = f.backend.commands.length
    f.terminal.type('\x03')
    assert.equal(f.app.editor.getText(), '')
    assert.equal(api.subagentReplyTarget?.childId, 'fixture-child')
    assert.equal(f.backend.cancels, 0)
    assert.equal(f.backend.commands.length, reads, 'clear never calls a native child stop/prompt operation')
  } finally { await f.close() }
})

for (const replacement of ['decision-closed', 'attachment'] as const) {
  test(`native decision details retire synchronously on ${replacement}, without reviving a stale question`, async () => {
    const f = await fixture('fullscreen')
    try {
      f.backend.decision({ id: 'retire-detail', kind: 'question', title: 'Detail lifetime', questions: [
        { question: 'Read the native detail', detail: '# Read-only native detail', options: [{ label: 'One' }, { label: 'Two' }] },
      ] })
      f.terminal.type('\x0f')
      assert.notEqual(inspect(f.app).decisionDetailsOverlay, undefined)
      if (replacement === 'decision-closed') f.backend.emit({ type: 'decision_closed', sessionId: f.backend.info.sessionId, id: 'retire-detail' })
      else {
        f.backend.info = { ...f.backend.info, attachmentId: 'fresh-attachment' }
        f.backend.emit({ type: 'ready', info: f.backend.info })
      }
      assert.equal(inspect(f.app).decisionDetailsOverlay === undefined, true)
      assert.equal(inspect(f.app).dialog === undefined, true)
      assert.equal(inspect(f.app).composerInteraction.active, false)
      f.backend.decision({ id: 'fresh-after-detail', kind: 'question', title: 'Fresh question', questions: [
        { question: 'Current request', options: [{ label: 'Fresh one' }, { label: 'Fresh two' }] },
      ] })
      f.terminal.type('\x03')
      assert.equal(f.backend.responses.at(-1)?.id, 'fresh-after-detail')
      assert.equal(f.backend.cancels, 0)
    } finally { await f.close() }
  })
}
