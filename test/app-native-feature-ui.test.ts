import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, EncodedFileInput, FileAttachmentRef, JsonRecord, PromptContentPart, SessionInfo, WorkspaceChangeDiffResult } from '../src/backend/types.ts'
import { DecisionDialog, SelectDialog } from '../src/ui/dialogs.ts'
import { JobsDialog } from '../src/ui/jobs-dialog.ts'
import { NativeInspectionDialog } from '../src/ui/native-inspection-dialog.ts'
import { HistoryDialog } from '../src/ui/history-dialog.ts'
import { WorkspaceChangesDialog } from '../src/ui/workspace-changes-dialog.ts'
import type { WorkspaceChangesDetailsRequest } from '../src/ui/workspace-changes.ts'
import type { WorkspaceChangesTranscriptItem } from '../src/state/transcript.ts'
import type { TranscriptView } from '../src/ui/transcript.ts'
import { isToolExpanded, setToolExpanded, toolExpansionKey, toolGroupExpansionKey } from '../src/ui/tool-expansion.ts'
import { isThinkingExpanded, setThinkingExpanded, thinkingExpansionKey } from '../src/ui/thinking-block.ts'
import { delay, until, VirtualTerminal } from './helpers/terminal.ts'

class FeatureBackend implements Backend {
  readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly calls: Array<{ name: string; args?: JsonRecord }> = []
  readonly content: Array<readonly PromptContentPart[]> = []
  info: SessionInfo
  gate?: Promise<void>
  jobLabel = 'Native job A'
  failJobs = false
  queueFiles = 0
  defaultsRevision = 1
  defaultsValue = 'standard'
  nativeCommands: unknown[] = []
  historyGate?: Promise<void>
  historyOutline?: JsonRecord
  workspaceGate?: Promise<void>
  workspaceDiffPath = 'native.txt'
  readonly historyCalls: Array<{ seq: unknown; before: unknown; after: unknown }> = []
  constructor(cwd: string) { this.info = { sessionId: 'native-ui-root', attachmentId: 'native-ui-attachment', cwd,
    provider: 'fixture', model: 'fixture', capabilities: ['state', 'commands', 'execute', 'native-jobs', 'native-job-output', 'native-inventory', 'native-tools',
      'native-defaults', 'native-default-update', 'continued-questions', 'native-questions', 'native-question-answer', 'session-rename', 'session-fork', 'file-input', 'prompt-content', 'history-turns', 'history-window', 'workspace-changes', 'workspace-change-diff'], events: [] } }
  onEvent(listener: (event: BackendEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent) { for (const listener of this.listeners) listener(event) }
  changed(domain: Extract<BackendEvent, { type: 'native_ui_changed' }>['domain']) {
    this.emit({ type: 'native_ui_changed', sessionId: this.info.sessionId, attachmentId: this.info.attachmentId, domain })
  }
  async connect() { return this.info }
  async send() { throw new Error('Native feature UI must not synthesize model text') }
  async sendContent(content: readonly PromptContentPart[]) { this.content.push(content) }
  async stageFile(input: EncodedFileInput): Promise<FileAttachmentRef> { return { attachmentId: 'native-fixture-file', name: input.name ?? 'file', bytes: Buffer.from(input.data, 'base64').length } }
  async respond() { throw new Error('Continued questions never use blocking respond') }
  async cancel() {}
  async close() {}
  async command(name: string, args?: JsonRecord): Promise<unknown> {
    this.calls.push({ name, ...(args === undefined ? {} : { args }) })
    if (name === 'commands') return this.nativeCommands
    if (name === 'history-turns') {
      await this.historyGate
      if (this.historyOutline !== undefined) return this.historyOutline
      return { available: true, sessionId: this.info.sessionId, attachmentId: this.info.attachmentId, asOfSeq: 2,
        entries: [{ turn: 1, seq: 1, prompt: 'Native historical prompt', response: 'Native historical response' }] }
    }
    if (name === 'history-window') {
      this.historyCalls.push({ seq: args?.seq, before: args?.before, after: args?.after })
      return { sessionId: this.info.sessionId, attachmentId: this.info.attachmentId,
        targetSeq: args?.seq, startSeq: 1, endSeq: 2, inheritedEventCount: 0, hasOlder: false,
        events: [
          { type: 'user/message', seq: 1, data: { turn: 1, content: [{ type: 'text', text: 'Native historical prompt' }] } },
          { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } },
        ] }
    }
    if (name === 'workspace-change-diff') {
      const info = this.info, path = this.workspaceDiffPath
      await this.workspaceGate
      const result: WorkspaceChangeDiffResult = { sessionId: info.sessionId, attachmentId: info.attachmentId,
        seq: args?.seq as number, index: args?.index as number,
        diff: { kind: 'text', path, display: path, before: true, after: true, coarse: false,
          hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-old native', '+new native'] }] } }
      return result
    }
    if (name === 'auto-title') return { available: false }
    if (name === 'state') return { queued: this.queueFiles > 0 ? 1 : 0,
      queue: this.queueFiles > 0 ? [{ messageId: 'queued-native-files', text: '', target: 'next-turn', images: 0, files: this.queueFiles }] : [],
      pending: { nextTurn: 0, nextStep: 0 } }
    if (name === 'native-jobs') {
      const label = this.jobLabel
      await this.gate
      if (this.failJobs) throw new Error('controlled native jobs failure')
      return { available: true, complete: true, sessionId: this.info.sessionId, jobs: [{ id: 'job-a', kind: 'fixture', label, status: 'running', owned: true,
        startedAt: 1, output: { total: 10, earliest: 0, evicted: false } }] }
    }
    if (name === 'native-job-output') return { available: true, complete: true, sessionId: this.info.sessionId,
      job: { id: 'job-a', kind: 'fixture', label: this.jobLabel, status: 'running', owned: true, startedAt: 1, output: { total: 10, earliest: 0, evicted: false } },
      from: 0, next: 10, lossy: false, truncated: false, chunks: [{ at: 0, text: 'Native bounded output\n', channel: 'stdout' }] }
    if (name === 'native-inventory') return { available: true, complete: true,
      entries: [{ entryId: 'native-plugin', moduleName: '@fixture/native-plugin', enabled: true, fiberPhase: 'active' }],
      summary: { total: 1, enabled: 1, disabled: 0, active: 1, failed: 0, pending: 0, malformed: 0 }, diagnostics: [], diagnosticsTruncated: false }
    if (name === 'native-tools') return { available: true, complete: true, sessionId: this.info.sessionId,
      tools: [{ name: 'native-tool', description: 'Native safe description', executable: true, deferredLoading: false, presenter: { call: false, result: false } }],
      summary: { total: 1, executable: 1, deferred: 0 } }
    if (name === 'native-questions') return { available: true, sessionId: this.info.sessionId, attachmentId: this.info.attachmentId, active: [
      { callId: 'native-call', state: 'continued', replyQueued: false, questions: [{ id: 'native-question', question: 'Native late question', options: [{ label: 'Keep' }, { label: 'Switch' }] }] },
    ], settled: [], asOfSeq: 1 }
    if (name === 'native-question-answer') return { callId: args?.callId, outcome: 'accepted' }
    if (name === 'native-defaults') return { available: true, targets: [{ target: 'agent-preset-default', field: 'selectedDefault', available: true, writable: true,
      namespace: 'owned-native-registry', value: this.defaultsValue, effectiveValue: this.defaultsValue, revision: this.defaultsRevision,
      options: [{ id: 'standard', label: 'Standard native preset' }, { id: 'minimal', label: 'Minimal native preset' }] }] }
    if (name === 'native-default-update') {
      if (args?.expectedRevision !== this.defaultsRevision) return { ok: false, reason: 'conflict', message: 'Native revision conflict.', expectedRevision: args?.expectedRevision, actualRevision: this.defaultsRevision }
      this.defaultsRevision++; this.defaultsValue = args?.value as string
      return { ok: true, target: args?.target, namespace: 'owned-native-registry', field: 'selectedDefault', value: this.defaultsValue,
        revision: this.defaultsRevision, changed: true, stillCurrent: true }
    }
    if (name === 'session-rename') return { ok: true, sessionId: this.info.sessionId, attachmentId: this.info.attachmentId,
      title: args?.title, seq: 1, source: 'user', stillCurrent: true }
    if (name === 'session-fork') { this.info = { ...this.info, sessionId: 'forked-native-root', attachmentId: 'forked-native-attachment' }; return this.info }
    if (name === 'execute') return { commandId: 'native-command', result: { kind: 'success', text: 'Native override executed.' } }
    throw new Error('Unexpected native UI control: ' + name)
  }
}

async function fixture(screen: 'inline' | 'fullscreen' = 'fullscreen', capabilities?: readonly string[]) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-native-ui-parent-'))
  const terminal = new VirtualTerminal(110, 36), backend = new FeatureBackend(cwd)
  if (capabilities !== undefined) backend.info = { ...backend.info, capabilities: [...capabilities] }
  const app = new App({ backend, terminal, cwd, configDir: cwd, screen, registerSignals: false })
  await app.start()
  const paint = async () => { await delay(35); await terminal.flush() }
  return { cwd, app, backend, terminal, paint, async close() {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(cwd, { recursive: true, force: true }) }
  } }
}
const dialogOf = (app: App): unknown => (app as unknown as { dialog?: unknown }).dialog
const submitDialog = (dialog: DecisionDialog, value: unknown): void =>
  (dialog as unknown as { options: { onSubmit(value: unknown): void } }).options.onSubmit(value)

const workspaceUi = (app: App) => app as unknown as {
  transcript: TranscriptView
  viewOptions: { onWorkspaceChangesDetails?: (request: WorkspaceChangesDetailsRequest) => void; showThinking: boolean }
  openWorkspaceChanges(request: WorkspaceChangesDetailsRequest): void
  commands(): Array<{ name: string; definitionId?: string }>
}
function workspaceItem(app: App): WorkspaceChangesTranscriptItem {
  const item = app.store.items.find(item => item.kind === 'workspace-changes')
  assert.ok(item && item.kind === 'workspace-changes')
  return item
}
function workspaceRequest(app: App, index?: number): WorkspaceChangesDetailsRequest {
  const item = workspaceItem(app)
  return {
    sessionId: item.sessionId,
    ...(item.attachmentId === undefined ? {} : { attachmentId: item.attachmentId }),
    seq: item.seq, turn: item.turn, files: item.files, total: item.total, added: item.added, deleted: item.deleted,
    ...(index === undefined ? {} : { index }),
  }
}
function emitWorkspace(backend: FeatureBackend, seq = 7, turn = 1, path = 'native.txt'): void {
  backend.emit({ type: 'session_event', sessionId: backend.info.sessionId, event: {
    type: 'workspace/changes', seq, data: { turn },
    workspaceChanges: { turn, files: [{ path, display: path, added: 1, deleted: 1 }], total: 1, added: 1, deleted: 1 },
  } })
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`native feature UI ${screen}: mounted read-only panels preserve the one editor and draft`, async () => {
    const f = await fixture(screen)
    try {
      f.terminal.type('retained native draft 中文')
      const editor = f.app.editor, before = editor.captureDraft()
      await f.app.submit('/jobs'); await f.paint()
      const jobs = dialogOf(f.app)
      assert.ok(jobs instanceof JobsDialog)
      assert.match(jobs.render(110).join('\n'), /Native job A/)
      f.terminal.type('\r'); await f.paint()
      assert.match(jobs.render(110).join('\n'), /Native bounded output/)
      f.terminal.type('\x1b'); f.terminal.type('\x1b')
      await f.app.submit('/inspect'); await f.paint()
      const inventory = dialogOf(f.app)
      assert.ok(inventory instanceof NativeInspectionDialog)
      assert.match(inventory.render(110).join('\n'), /native-plugin/)
      assert.match(inventory.render(110).join('\n'), /native-tool/)
      f.terminal.type('\x1b'); await f.paint()
      assert.equal(f.app.editor, editor)
      assert.equal(editor.focused, true)
      assert.deepEqual(editor.captureDraft(), before)
      assert.equal(f.backend.content.length, 0)
      assert.equal(f.backend.calls.some(call => ['session-fork', 'session-rename', 'native-default-update', 'native-question-answer'].includes(call.name)), false)
    } finally { await f.close() }
  })
}

test('native jobs refresh is single-flight, keeps native identity, displays failure and cannot revive a closed view', async () => {
  const f = await fixture()
  let release = () => {}
  try {
    await f.app.submit('/jobs'); await f.paint()
    const dialog = dialogOf(f.app)
    assert.ok(dialog instanceof JobsDialog)
    const reads = f.backend.calls.filter(call => call.name === 'native-jobs').length
    f.backend.gate = new Promise<void>(resolve => { release = resolve })
    f.backend.jobLabel = 'obsolete metadata'; f.backend.changed('jobs')
    await until(() => f.backend.calls.filter(call => call.name === 'native-jobs').length === reads + 1, 'held native read')
    f.backend.jobLabel = 'fresh native metadata'
    for (let i = 0; i < 10; i++) f.backend.changed('jobs')
    f.backend.gate = undefined; release()
    await until(() => dialog.render(110).join('\n').includes('fresh native metadata'), 'one trailing native refresh')
    assert.equal(f.backend.calls.filter(call => call.name === 'native-jobs').length, reads + 2)
    assert.doesNotMatch(dialog.render(110).join('\n'), /obsolete metadata/)
    f.backend.failJobs = true; f.backend.changed('jobs'); await f.paint()
    assert.match(dialog.render(110).join('\n'), /native-failed|unavailable/i)
    f.terminal.type('\x1b'); await f.paint()
    const closed = f.backend.calls.length
    f.backend.changed('jobs'); await f.paint()
    assert.equal(dialogOf(f.app), undefined)
    assert.equal(f.backend.calls.length, closed)
  } finally { release(); f.backend.gate = undefined; await f.close() }
})

test('native continued question local dismissal sends nothing; answer routes to native answer, never respond', async () => {
  const f = await fixture()
  try {
    f.terminal.type('root question draft')
    const before = f.app.editor.captureDraft()
    await f.app.submit('/questions'); await f.paint()
    assert.ok(dialogOf(f.app) instanceof SelectDialog)
    f.terminal.type('\x1b'); await f.paint()
    assert.equal(f.backend.calls.filter(call => call.name === 'native-question-answer').length, 0)
    await f.app.submit('/questions'); await f.paint(); f.terminal.type('\r')
    await until(() => dialogOf(f.app) instanceof DecisionDialog, 'native answer dialog')
    const dialog = dialogOf(f.app)
    assert.ok(dialog instanceof DecisionDialog)
    submitDialog(dialog, { answers: ['Keep'] })
    await f.paint()
    const writes = f.backend.calls.filter(call => call.name === 'native-question-answer')
    assert.deepEqual(writes.map(call => call.args), [{ callId: 'native-call', answer: { answers: ['Keep'] } }])
    assert.deepEqual(f.app.editor.captureDraft(), before)
  } finally { await f.close() }
})

test('safe native default selection requires confirmation and passes the captured native revision without retries', async () => {
  const f = await fixture()
  try {
    const controller = (f.app as unknown as { nativeUi: { openDefaults(target: string): void } }).nativeUi
    controller.openDefaults('agent-preset-default'); await f.paint()
    assert.ok(dialogOf(f.app) instanceof SelectDialog)
    f.terminal.type('\x1b[B'); f.terminal.type('\r')
    const confirmation = dialogOf(f.app)
    assert.ok(confirmation instanceof DecisionDialog)
    assert.equal(f.backend.calls.filter(call => call.name === 'native-default-update').length, 0)
    f.backend.defaultsRevision = 2
    submitDialog(confirmation, true)
    await f.paint()
    const writes = f.backend.calls.filter(call => call.name === 'native-default-update')
    assert.equal(writes.length, 1)
    assert.equal(writes[0]?.args?.expectedRevision, 1)
    assert.equal(writes[0]?.args?.value, 'minimal')
    assert.equal(f.backend.defaultsValue, 'standard', 'conflict is not silently retried')
    assert.match(f.terminal.screen(), /Native revision conflict/)
  } finally { await f.close() }
})

test('literal rename and confirmed fork use explicit native session operations', async () => {
  const f = await fixture()
  try {
    await f.app.submit('/rename Chosen native title')
    await until(() => f.app.session?.title === 'Chosen native title', 'native title applied')
    const rename = f.backend.calls.find(call => call.name === 'session-rename')
    assert.equal(rename?.args?.sessionId, 'native-ui-root')
    assert.equal(rename?.args?.attachmentId, 'native-ui-attachment')
    await f.app.submit('/fork')
    const confirmation = dialogOf(f.app)
    assert.ok(confirmation instanceof DecisionDialog)
    assert.equal(f.backend.calls.filter(call => call.name === 'session-fork').length, 0)
    submitDialog(confirmation, true)
    await until(() => f.app.session?.sessionId === 'forked-native-root', 'explicit native fork switches')
    assert.equal(f.backend.calls.filter(call => call.name === 'session-fork').length, 1)
  } finally { await f.close() }
})

test('explicit local file input stages native refs and direct submit uses multipart, never marker text', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.cwd, 'local file.txt'), 'fixture bytes')
    await f.app.submit('/attach "local file.txt"')
    assert.equal(f.app.editor.getAttachmentCounts().files, 1)
    f.app.editor.ccSubmit()
    await until(() => f.backend.content.length === 1, 'file multipart accepted')
    assert.deepEqual(f.backend.content[0], [{ type: 'file', attachment: { attachmentId: 'native-fixture-file', name: 'local file.txt', bytes: 13 } }])
  } finally { await f.close() }
})

test('new UI names yield to a mounted native command and unmounted views are not advertised', async () => {
  const f = await fixture()
  try {
    f.backend.nativeCommands = [{ name: 'jobs', description: 'Mounted native jobs command' }]
    f.backend.emit({ type: 'commands_changed', sessionId: f.backend.info.sessionId, attachmentId: f.backend.info.attachmentId })
    await f.paint()
    await f.app.submit('/jobs'); await f.paint()
    assert.equal(dialogOf(f.app), undefined)
    assert.equal(f.backend.calls.some(call => call.name === 'execute' && call.args?.line === '/jobs'), true)
    f.backend.info = { ...f.backend.info, capabilities: ['commands', 'execute'] }
    f.backend.emit({ type: 'ready', info: f.backend.info })
    const commands = (f.app as unknown as { commands(): Array<{ name: string }> }).commands()
    assert.equal(commands.some(command => ['inspect', 'questions', 'attach', 'rename', 'fork'].includes(command.name)), false)
  } finally { await f.close() }
})

test('native file count changes survive App queue DTO mapping and repaint the fixed queue', async () => {
  const f = await fixture()
  try {
    f.backend.queueFiles = 1
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'idle' })
    await until(() => f.terminal.screen().includes('1 file'), 'native file count shown')
    assert.equal(f.app.queuedCount, 1)
    f.backend.queueFiles = 2
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'idle' })
    await until(() => f.terminal.screen().includes('2 files'), 'same native row with changed file count repaints')
    assert.equal(f.app.queuedCount, 1)
    assert.doesNotMatch(f.terminal.screen(), /\(empty\)/)
    assert.equal(f.backend.content.length, 0)
  } finally { await f.close() }
})

test('native /history accepts the empty outline cursor -1 without inventing a turn', async () => {
  const f = await fixture()
  try {
    f.backend.historyOutline = { available: true, sessionId: f.backend.info.sessionId,
      attachmentId: f.backend.info.attachmentId, asOfSeq: -1, entries: [] }
    await f.app.submit('/history')
    await until(() => dialogOf(f.app) instanceof HistoryDialog && (dialogOf(f.app) as HistoryDialog).turnsStatus === 'ready', 'empty native outline ready')
    const dialog = dialogOf(f.app)
    assert.ok(dialog instanceof HistoryDialog)
    assert.match(dialog.render(110).join('\n'), /No native turns in this session/)
    assert.equal(f.backend.historyCalls.length, 0, 'an empty outline opens no event window')
  } finally { await f.close() }
})

test('native /history loads the exact outline and bounded window into a separate read-only view', async () => {
  const f = await fixture()
  try {
    const liveStore = f.app.store
    await f.app.submit('/history')
    await until(() => dialogOf(f.app) instanceof HistoryDialog && (dialogOf(f.app) as HistoryDialog).turnsStatus === 'ready', 'native outline ready')
    const dialog = dialogOf(f.app)
    assert.ok(dialog instanceof HistoryDialog)
    assert.match(dialog.render(110).join('\n'), /Native historical prompt/)
    f.terminal.type('\r')
    await until(() => f.backend.historyCalls.length > 0 && dialog.detailEventCount === 2, 'native turn window loaded')
    assert.deepEqual(f.backend.historyCalls[0], { seq: 1, before: 50, after: 50 })
    assert.match(dialog.render(110).join('\n'), /Native historical prompt/)
    assert.equal(f.app.store, liveStore, 'the live transcript was not reset or replaced')
    assert.equal(f.backend.calls.some(call => call.name === 'execute'), false)
    f.terminal.type('\x1b')
    f.terminal.type('\x1b')
    await f.paint()
    assert.equal(dialogOf(f.app), undefined)
    assert.equal(dialog.isDisposed, true)
  } finally { await f.close() }
})

test('live native workspace events open the exact scoped diff through the App callback', async () => {
  const f = await fixture()
  try {
    emitWorkspace(f.backend)
    await f.paint()
    const callback = workspaceUi(f.app).viewOptions.onWorkspaceChangesDetails
    assert.ok(callback)
    callback(workspaceRequest(f.app, 0))
    await until(() => dialogOf(f.app) instanceof WorkspaceChangesDialog && f.backend.calls.some(call => call.name === 'workspace-change-diff'), 'native workspace read')
    const dialog = dialogOf(f.app)
    assert.ok(dialog instanceof WorkspaceChangesDialog)
    await until(() => dialog.render(110).join('\n').includes('new native'), 'native hunk painted')
    const call = f.backend.calls.find(call => call.name === 'workspace-change-diff')
    assert.deepEqual(call?.args, { sessionId: f.backend.info.sessionId, attachmentId: f.backend.info.attachmentId, seq: 7, index: 0 })
    assert.match(dialog.render(110).join('\n'), /old native/)
    assert.equal(f.backend.calls.some(call => call.name === 'execute'), false)
  } finally { await f.close() }
})

for (const replacement of ['session', 'attachment'] as const) {
  test(`workspace App rejects a retired ${replacement} callback even when the new card has the same seq/index/path`, async () => {
    const f = await fixture()
    try {
      emitWorkspace(f.backend)
      const ui = workspaceUi(f.app)
      ui.transcript.render(110)
      const previous = workspaceItem(f.app), request = workspaceRequest(f.app, 0)
      const span = ui.transcript.rowSpans.find(span => span.itemId === previous.id)
      assert.ok(span)
      const callback = ui.viewOptions.onWorkspaceChangesDetails
      assert.ok(callback)
      const before = f.backend.calls.filter(call => call.name === 'workspace-change-diff').length
      f.backend.info = { ...f.backend.info,
        sessionId: replacement === 'session' ? 'replacement-root' : f.backend.info.sessionId,
        attachmentId: 'replacement-attachment', events: [] }
      f.backend.emit({ type: 'ready', info: f.backend.info })
      assert.equal(ui.transcript.rowSpans.length, 0, 'old pointer targets retire synchronously, not at the deferred paint')
      emitWorkspace(f.backend) // the new attachment really owns a same-path/seq file
      callback(request) // a separately held old callback must fail at the App boundary too
      const mouse = (type: 'press' | 'click') => ({ type, button: 'left' as const,
        x: 4, y: span.startRow + 1, screenX: 4, screenY: span.startRow + 1,
        width: 110, height: 36, shift: false, alt: false, ctrl: false,
        ...(type === 'click' ? { clickCount: 1 } : {}) })
      ui.transcript.handleMouse(mouse('press'))
      ui.transcript.handleMouse(mouse('click'))
      assert.equal(dialogOf(f.app) === undefined, true, 'a retired origin cannot open any modal')
      assert.equal(f.backend.calls.filter(call => call.name === 'workspace-change-diff').length, before)
      ui.transcript.render(110)
      ui.viewOptions.onWorkspaceChangesDetails?.(workspaceRequest(f.app, 0))
      await until(() => dialogOf(f.app) instanceof WorkspaceChangesDialog && f.backend.calls.filter(call => call.name === 'workspace-change-diff').length === before + 1, 'fresh scoped workspace callback')
      assert.deepEqual(f.backend.calls.findLast(call => call.name === 'workspace-change-diff')?.args,
        { sessionId: f.backend.info.sessionId, attachmentId: f.backend.info.attachmentId, seq: 7, index: 0 })
    } finally { await f.close() }
  })
}

test('a superseded same-turn workspace callback cannot read the old announcing seq', async () => {
  const f = await fixture()
  try {
    emitWorkspace(f.backend)
    const ui = workspaceUi(f.app)
    ui.transcript.render(110)
    const request = workspaceRequest(f.app, 0)
    emitWorkspace(f.backend, 12)
    assert.equal(workspaceItem(f.app).seq, 12)
    ui.viewOptions.onWorkspaceChangesDetails?.(request)
    assert.equal(dialogOf(f.app), undefined)
    assert.equal(f.backend.calls.some(call => call.name === 'workspace-change-diff'), false)
    ui.viewOptions.onWorkspaceChangesDetails?.(workspaceRequest(f.app, 0))
    await until(() => f.backend.calls.some(call => call.name === 'workspace-change-diff'), 'latest announcing seq read')
    assert.equal(f.backend.calls.find(call => call.name === 'workspace-change-diff')?.args?.seq, 12)
  } finally { await f.close() }
})

test('workspace summary remains readable but has no diff action when its native capability is missing', async () => {
  const f = await fixture('fullscreen', ['commands', 'state', 'workspace-changes'])
  try {
    emitWorkspace(f.backend)
    const ui = workspaceUi(f.app)
    assert.equal(ui.viewOptions.onWorkspaceChangesDetails, undefined)
    assert.match(ui.transcript.render(110).join('\n'), /native\.txt/)
    ui.openWorkspaceChanges(workspaceRequest(f.app, 0)) // stale/external intent must fail closed as well
    assert.equal(dialogOf(f.app) === undefined, true, 'missing native diff capability keeps this intent inert')
    assert.equal(f.backend.calls.some(call => call.name === 'workspace-change-diff'), false)
    assert.equal(f.app.store.items.some(item => item.kind === 'workspace-changes'), true)
  } finally { await f.close() }
})

test('same-attachment capability loss closes a pending workspace read and late data cannot revive it', async () => {
  const f = await fixture()
  let release = () => {}
  try {
    f.terminal.type('kept native workspace draft')
    const editor = f.app.editor, draft = editor.captureDraft()
    emitWorkspace(f.backend)
    f.backend.workspaceGate = new Promise<void>(resolve => { release = resolve })
    const ui = workspaceUi(f.app)
    ui.viewOptions.onWorkspaceChangesDetails?.(workspaceRequest(f.app, 0))
    const dialog = dialogOf(f.app)
    assert.ok(dialog instanceof WorkspaceChangesDialog)
    await until(() => f.backend.calls.some(call => call.name === 'workspace-change-diff'), 'held native diff read')
    f.backend.info = { ...f.backend.info, capabilities: f.backend.info.capabilities.filter(capability => capability !== 'workspace-change-diff') }
    f.backend.emit({ type: 'ready', info: f.backend.info })
    assert.equal(dialogOf(f.app), undefined)
    assert.equal(dialog.isDisposed, true)
    assert.equal(ui.viewOptions.onWorkspaceChangesDetails, undefined)
    release(); f.backend.workspaceGate = undefined
    await f.paint()
    assert.equal(dialogOf(f.app), undefined)
    assert.equal(f.app.editor, editor)
    assert.deepEqual(editor.captureDraft(), draft)
    f.backend.info = { ...f.backend.info, capabilities: [...f.backend.info.capabilities, 'workspace-change-diff'] }
    f.backend.emit({ type: 'ready', info: f.backend.info })
    const callback = workspaceUi(f.app).viewOptions.onWorkspaceChangesDetails
    assert.ok(callback)
    callback(workspaceRequest(f.app, 0))
    await until(() => dialogOf(f.app) instanceof WorkspaceChangesDialog && f.backend.calls.filter(call => call.name === 'workspace-change-diff').length === 2, 'capability reappears without resetting editor or summary')
  } finally { release(); await f.close() }
})

for (const missing of ['history-turns', 'history-window'] as const) {
  test(`history is not advertised without ${missing}`, async () => {
    const capabilities = ['commands', 'state', 'history-turns', 'history-window'].filter(capability => capability !== missing)
    const f = await fixture('fullscreen', capabilities)
    try {
      assert.equal(workspaceUi(f.app).commands().some(command => command.name === 'history'), false)
      assert.equal(f.backend.calls.some(call => ['history-turns', 'history-window'].includes(call.name)), false)
    } finally { await f.close() }
  })
}

test('a mounted native history command still wins over the fully mounted optional history UI', async () => {
  const f = await fixture()
  try {
    f.backend.nativeCommands = [{ name: 'history', definitionId: 'fixture/native-history', description: 'Native history override' }]
    f.backend.emit({ type: 'commands_changed', sessionId: f.backend.info.sessionId, attachmentId: f.backend.info.attachmentId })
    await until(() => workspaceUi(f.app).commands().find(command => command.name === 'history')?.definitionId === 'fixture/native-history', 'native command roster refresh')
    await f.app.submit('/history native-argument')
    assert.equal(dialogOf(f.app), undefined)
    assert.equal(f.backend.calls.some(call => call.name === 'execute' && call.args?.line === '/history native-argument'), true)
    assert.equal(f.backend.calls.some(call => ['history-turns', 'history-window'].includes(call.name)), false)
  } finally { await f.close() }
})

test('actual history detail lifecycle preserves the live thinking/tool/group disclosures and the one editor', async () => {
  const f = await fixture()
  try {
    const ui = workspaceUi(f.app)
    ui.viewOptions.showThinking = true
    f.backend.emit({ type: 'session_event', sessionId: f.backend.info.sessionId, event: { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1,
      message: { role: 'assistant', content: [
        { type: 'reasoning', text: 'native thinking line\n'.repeat(20) },
        { type: 'text', text: 'Live native response' },
        ...['live-a', 'live-b'].map(id => ({ type: 'tool-call', id, name: 'bash', arguments: '{"command":"echo live"}' })),
      ] } } } })
    let seq = 3
    for (const callId of ['live-a', 'live-b']) {
      f.backend.emit({ type: 'session_event', sessionId: f.backend.info.sessionId, event: { type: 'tool/call', seq: seq++, data: { turn: 1, step: 1, callId, name: 'bash', arguments: '{"command":"echo live"}' } } })
      f.backend.emit({ type: 'session_event', sessionId: f.backend.info.sessionId, event: { type: 'tool/result', seq: seq++, data: { turn: 1, step: 1, message: { toolCallId: callId, content: [{ type: 'text', text: 'live result\n'.repeat(20) }] } } } })
    }
    f.backend.emit({ type: 'session_event', sessionId: f.backend.info.sessionId, event: { type: 'turn/end', seq, data: { turn: 1, reason: { kind: 'completed' } } } })
    ui.transcript.render(110)
    const assistant = f.app.store.items.find(item => item.kind === 'assistant' && item.thinking.length > 0)
    assert.ok(assistant && assistant.kind === 'assistant')
    const thinking = thinkingExpansionKey(assistant.thinkingKey ?? assistant.id, 0)
    const tool = toolExpansionKey('live-a'), group = toolGroupExpansionKey('live-a')
    setThinkingExpanded(thinking, true); setToolExpanded(tool, true); setToolExpanded(group, true)
    const assertDisclosures = () => {
      assert.equal(isThinkingExpanded(thinking), true)
      assert.equal(isToolExpanded(tool), true)
      assert.equal(isToolExpanded(group), true)
    }
    f.terminal.type('retained read-only history draft')
    const editor = f.app.editor, draft = editor.captureDraft(), store = f.app.store
    await f.app.submit('/history')
    const dialog = dialogOf(f.app)
    assert.ok(dialog instanceof HistoryDialog)
    await until(() => dialog.turnsStatus === 'ready', 'history outline ready for isolation')
    f.terminal.type('\r')
    await until(() => dialog.detailEventCount === 2, 'history detail ready for isolation')
    dialog.render(110); assertDisclosures()
    dialog.invalidate(); dialog.render(110); assertDisclosures()
    f.terminal.type('\x1b'); f.terminal.type('\x1b')
    await f.paint(); assertDisclosures()
    assert.equal(f.app.store, store)
    assert.equal(f.app.editor, editor)
    assert.deepEqual(editor.captureDraft(), draft)
    assert.equal(dialog.isDisposed, true)
  } finally { await f.close() }
})

test('Settings rejects a newly stolen full chord without changing the keymap file or draft', async () => {
  const f = await fixture()
  try {
    f.terminal.type('keep keyboard draft')
    const editor = f.app.editor, draft = editor.captureDraft()
    const file = join(f.cwd, 'keybindings.json')
    const before = await readFile(file, 'utf8').catch(() => undefined)
    const binding = f.app.keymap.getBindings('editor.move.line-start')
    const app = f.app as unknown as { saveKeybinding(id: string, bindings: string[]): Promise<void> }
    await assert.rejects(app.saveKeybinding('editor.move.line-start', ['ctrl+x ctrl+e']), /Shortcut conflict:.*app\.editor\.external/s)
    assert.deepEqual(f.app.keymap.getBindings('editor.move.line-start'), binding)
    assert.equal(await readFile(file, 'utf8').catch(() => undefined), before)
    assert.equal(f.app.editor, editor)
    assert.deepEqual(editor.captureDraft(), draft)
  } finally { await f.close() }
})

test('native approval decisions render the proposed diff without executing or claiming an applied result', async () => {
  const f = await fixture()
  try {
    f.backend.emit({ type: 'decision', sessionId: f.backend.info.sessionId, request: {
      id: 'approval-native-diff', kind: 'approval', title: 'Native file edit', message: 'Review the proposed edit.',
      callId: 'call-native-edit',
      options: [{ label: 'Allow', value: true }, { label: 'Reject', value: false }],
      toolPresentation: { card: 'diff', title: 'Edit native.txt', diffs: [{ path: 'native.txt', oldText: 'old native', newText: 'new native' }] },
    } })
    await f.paint()
    const dialog = dialogOf(f.app)
    assert.ok(dialog instanceof DecisionDialog)
    const text = dialog.render(110).join('\n')
    assert.match(text, /Proposal/)
    assert.match(text, /not run yet/)
    assert.match(text, /new native/)
    assert.doesNotMatch(text, /Applied|executed result/)
    assert.equal(f.backend.calls.some(call => call.name === 'execute'), false)
  } finally { await f.close() }
})
