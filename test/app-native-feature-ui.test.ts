import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, EncodedFileInput, FileAttachmentRef, JsonRecord, PromptContentPart, SessionInfo } from '../src/backend/types.ts'
import { DecisionDialog, SelectDialog } from '../src/ui/dialogs.ts'
import { JobsDialog } from '../src/ui/jobs-dialog.ts'
import { NativeInspectionDialog } from '../src/ui/native-inspection-dialog.ts'
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
  constructor(cwd: string) { this.info = { sessionId: 'native-ui-root', attachmentId: 'native-ui-attachment', cwd,
    provider: 'fixture', model: 'fixture', capabilities: ['state', 'commands', 'execute', 'native-jobs', 'native-job-output', 'native-inventory', 'native-tools',
      'native-defaults', 'native-default-update', 'continued-questions', 'native-questions', 'native-question-answer', 'session-rename', 'session-fork', 'file-input', 'prompt-content'], events: [] } }
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

async function fixture(screen: 'inline' | 'fullscreen' = 'fullscreen') {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-native-ui-parent-'))
  const terminal = new VirtualTerminal(110, 36), backend = new FeatureBackend(cwd)
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
