import './helpers/truecolor.ts'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, JsonRecord, PromptContentPart, SessionInfo, SkillCatalogSnapshot } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC, DemoBackend } from '../src/demo.ts'
import { leadingSkillGestureName, readSkillCatalog } from '../src/skills.ts'
import { imageFixture } from './helpers/images.ts'
import { VirtualTerminal, delay, until } from './helpers/terminal.ts'

const CATALOG: SkillCatalogSnapshot = {
  entries: [
    { name: 'code-review', description: 'Native review metadata 中文 🚀', whenToUse: 'Review changes.', modelInvocable: true },
    { name: 'release-notes', description: 'Explicit user-only release metadata.', modelInvocable: false },
    { name: 'compact', description: 'Skill shadow must not replace the native command.', modelInvocable: true },
  ],
  available: true, complete: true,
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

/** Transport/metadata fixture only: no discovery, policy, body loading, Agent or model implementation. */
class SkillBackend implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly calls: Array<{ name: string; args: JsonRecord }> = []
  readonly sent: Array<{ text?: string; content?: readonly PromptContentPart[]; mode: string }> = []
  readonly executed: string[] = []
  catalog: unknown = CATALOG
  commands: JsonRecord[] = [{ name: 'compact', description: 'Native compact command', definitionId: '@deepseek-ai/fixture-compact' }]
  info: SessionInfo
  reads = 0
  cancels = 0
  skillGate?: Promise<void>
  routeGate?: Promise<void>
  sendGate?: Promise<void>
  readError?: Error
  sendError?: Error
  routeError?: Error
  forcedRoute?: 'command' | 'prompt'
  materializeOnRoute = false

  constructor(cwd: string, capabilities = ['commands', 'execute', 'state', 'skills', 'input-route', 'prompt-content']) {
    this.info = { sessionId: 'skill-root', attachmentId: 'skill-attachment', cwd, provider: 'fixture', model: 'fixture', capabilities, events: [] }
  }
  onEvent(listener: (event: BackendEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent) { for (const listener of this.listeners) listener(event) }
  async connect() { this.emit({ type: 'ready', info: this.info }); return this.info }
  async send(text: string, mode: 'followup' | 'steer' = 'followup') {
    await this.sendGate
    if (this.sendError !== undefined) throw this.sendError
    this.sent.push({ text, mode })
  }
  async sendContent(content: readonly PromptContentPart[], mode: 'followup' | 'steer' = 'followup') {
    await this.sendGate
    if (this.sendError !== undefined) throw this.sendError
    this.sent.push({ content, mode })
  }
  async cancel() { this.cancels++ }
  async respond() {}
  async close() {}
  async command(name: string, args: JsonRecord = {}): Promise<unknown> {
    this.calls.push({ name, args })
    if (name === 'commands') return this.commands
    if (name === 'skills') {
      this.reads++
      const catalog = this.catalog, error = this.readError
      await this.skillGate
      if (error !== undefined) throw error
      return catalog
    }
    if (name === 'input-route') {
      const info = this.info
      await this.routeGate
      if (this.routeError !== undefined) throw this.routeError
      if (this.materializeOnRoute) {
        this.materializeOnRoute = false
        this.catalog = CATALOG
        this.emit({ type: 'ready', info: this.info })
      }
      return { kind: this.forcedRoute ?? (args.name === 'compact' ? 'command' : 'prompt'), sessionId: info.sessionId, attachmentId: info.attachmentId }
    }
    if (name === 'execute') {
      this.executed.push(String(args.line))
      return { commandId: 'fixture-command', result: { kind: 'success', text: 'Native command completed.' } }
    }
    if (name === 'state') return { pending: { nextTurn: 0, nextStep: 0 }, queued: 0, queue: [] }
    if (name === 'auto-title') return { available: false }
    if (name === 'queue-send-now') { this.sent.push({ text: typeof args.text === 'string' ? args.text : undefined, mode: 'send-now' }); return { accepted: true } }
    throw new Error('Unexpected fixture control: ' + name)
  }
}

async function fixture(screen: 'inline' | 'fullscreen' = 'fullscreen', options: { catalog?: unknown; gate?: Promise<void>; capabilities?: string[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-skills-'))
  const backend = new SkillBackend(directory, options.capabilities)
  if (options.catalog !== undefined) backend.catalog = options.catalog
  backend.skillGate = options.gate
  const terminal = new VirtualTerminal(120, 58)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen, registerSignals: false })
  await app.start(); await paint(terminal)
  return { app, backend, terminal, directory, async close() {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  } }
}
async function paint(terminal: VirtualTerminal) { await delay(40); await terminal.flush() }
const notices = (app: App) => app.store.items.filter(item => item.kind === 'notice').map(item => item.text).join('\n')
const invalidate = (backend: SkillBackend) => backend.emit({ type: 'skills_changed', sessionId: backend.info.sessionId, attachmentId: backend.info.attachmentId })

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`Skills autocomplete is native /name metadata; Tab edits and Enter submits plain text (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      const editor = f.app.editor
      f.terminal.type('/code')
      await until(() => f.app.editor.isShowingAutocomplete(), 'native skill completion')
      await paint(f.terminal)
      assert.match(f.terminal.screen(), /code-review.*Skill.*Native review metadata/)
      assert.doesNotMatch(f.terminal.screen(), /skill:code-review/)
      assert.deepEqual(f.backend.sent, [])
      f.terminal.type('\t')
      assert.equal(editor.getText(), '/code-review ')
      assert.deepEqual(f.backend.sent, [], 'Tab is not a submission')
      f.terminal.type('inspect exact whitespace')
      f.terminal.type('\r')
      await until(() => f.backend.sent.length === 1, 'skill prompt admission')
      assert.equal(f.app.editor, editor)
      assert.deepEqual(f.backend.sent[0], { text: '/code-review inspect exact whitespace', mode: 'followup' })
      assert.deepEqual(f.backend.executed, [])
      assert.equal(f.backend.calls.filter(call => call.name === 'input-route').length, 1)
    } finally { await f.close() }
  })

  test(`Enter directly accepts and submits the selected skill through onSubmitContent (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.terminal.type('/code')
      await until(() => f.app.editor.isShowingAutocomplete(), 'selected skill before Enter')
      await paint(f.terminal)
      f.terminal.type('\r')
      await until(() => f.backend.sent.length === 1, 'single Enter submits the selected skill')
      assert.deepEqual(f.backend.sent[0], { text: '/code-review', mode: 'followup' })
      assert.deepEqual(f.backend.calls.find(call => call.name === 'input-route')?.args, { name: 'code-review' })
      assert.equal(f.backend.executed.length, 0)
      assert.equal(f.app.editor.getText(), '')
      assert.equal(f.app.editor.isShowingAutocomplete(), false)
    } finally { await f.close() }
  })

  test(`Enter directly executes the selected native command instead of its partial prefix (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.terminal.type('/comp')
      await until(() => f.app.editor.isShowingAutocomplete(), 'selected native command before Enter')
      f.terminal.type('\r')
      await until(() => f.backend.executed.length === 1, 'Enter executes completed native command')
      assert.deepEqual(f.backend.executed, ['/compact'])
      assert.equal(f.backend.sent.length, 0)
      assert.equal(f.app.editor.getText(), '')
    } finally { await f.close() }
  })

  test(`Enter on a UI-owned slash candidate opens that surface and never sends the prefix (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.terminal.type('/set')
      await until(() => f.app.editor.isShowingAutocomplete(), 'selected Settings candidate')
      f.terminal.type('\r')
      await paint(f.terminal)
      assert.match(f.terminal.screen(), /┌─ Settings/, 'single Enter opens the actual Settings modal, not an old General-row label')
      assert.equal(f.backend.sent.length, 0)
      assert.equal(f.backend.executed.length, 0)
      assert.equal(f.backend.calls.some(call => call.name === 'input-route'), false)
    } finally { await f.close() }
  })

  test(`Help shows native skills/user-only metadata and preserves the lossless Editor (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.terminal.type('keep draft 中文 ')
      f.app.editor.insertImage((await imageFixture()).upload)
      f.terminal.type('\x02')
      const editor = f.app.editor, before = editor.captureDraft(), items = [...f.app.store.items]
      await f.app.submit('/help'); await paint(f.terminal)
      f.terminal.type('\x1b[F'); await paint(f.terminal)
      assert.match(f.terminal.screen(), /Skills 3/)
      assert.match(f.terminal.screen(), /\/code-review/)
      assert.match(f.terminal.screen(), /\/release-notes \[user-only\]/)
      assert.doesNotMatch(f.terminal.screen(), /skill:/)
      f.terminal.type('\r19\t')
      await paint(f.terminal)
      assert.match(f.terminal.screen(), /Skills 3/)
      f.terminal.type('\x1b'); await paint(f.terminal)
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), before)
      assert.deepEqual(f.app.store.items, items)
      assert.equal(f.backend.calls.some(call => call.name === 'input-route'), false, 'Help never creates a submission scope')
      assert.deepEqual(f.backend.sent, [])
      assert.deepEqual(f.backend.executed, [])
    } finally { await f.close() }
  })

  test(`native command collisions stay command submissions while skill queue/steer preserves exact text (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.terminal.type('/compact'); await paint(f.terminal)
      assert.match(f.terminal.screen(), /compact.*Native compact command/)
      assert.doesNotMatch(f.terminal.screen(), /Skill shadow/)
      f.terminal.type('\x1b')
      const command = '/compact \t original  whitespace\nand next line  '
      await f.app.submit(command)
      assert.deepEqual(f.backend.executed, [command])
      assert.equal(f.backend.sent.length, 0)
      const prompt = '/release-notes \t exact  whitespace\nsecond line  '
      await f.app.submit(prompt, 'steer')
      assert.deepEqual(f.backend.sent[0], { text: prompt, mode: 'steer' })
      await f.app.submit('/code-review queue now', 'send-now')
      assert.equal(f.backend.sent[1]?.mode, 'send-now')
      assert.equal(f.backend.sent[1]?.text, '/code-review queue now')
      assert.equal(f.backend.cancels, 0)
    } finally { await f.close() }
  })
}

test('Enter submits the non-first selected native skill rather than the original query', async () => {
  const f = await fixture('fullscreen', { catalog: {
    entries: [
      { name: 'review-one', description: 'First skill.', modelInvocable: true },
      { name: 'review-two', description: 'Second skill.', modelInvocable: false },
    ], available: true, complete: true,
  } })
  try {
    f.terminal.type('/review-')
    await until(() => f.app.editor.isShowingAutocomplete(), 'two native skill candidates')
    f.terminal.type('\x1b[B')
    f.terminal.type('\r')
    await until(() => f.backend.sent.length === 1, 'Enter submits selected second candidate')
    assert.equal(f.backend.sent[0]?.text, '/review-two')
    assert.equal(f.backend.executed.length, 0)
  } finally { await f.close() }
})

test('pending metadata stays unavailable; explicit first input resolves against the native composed scope', async () => {
  const f = await fixture('fullscreen', { catalog: { entries: [], available: false, complete: false } })
  try {
    f.backend.commands = []
    f.backend.materializeOnRoute = true
    await f.app.submit('/help'); await paint(f.terminal)
    f.terminal.type('\x1b[F'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /No skill catalog is available/)
    assert.doesNotMatch(f.terminal.screen(), /No user-invocable skills/)
    assert.equal(f.backend.calls.some(call => call.name === 'input-route'), false)
    f.terminal.type('\x1b')
    await f.app.submit('/compact first-input native command')
    assert.deepEqual(f.backend.executed, ['/compact first-input native command'])
    assert.equal(f.backend.sent.length, 0)
    await f.app.submit('/not-in-the-ui-catalog native validation remains authoritative')
    assert.equal(f.backend.sent[0]?.text, '/not-in-the-ui-catalog native validation remains authoritative')
    assert.equal(f.backend.calls.filter(call => call.name === 'input-route').length, 2)
  } finally { await f.close() }
})

test('late metadata repaints the newest active prefix without a keypress or modifying draft/undo', async () => {
  const gate = deferred()
  const f = await fixture('fullscreen', { gate: gate.promise })
  try {
    f.terminal.type('/code')
    await paint(f.terminal)
    assert.equal(f.app.editor.isShowingAutocomplete(), false)
    const editor = f.app.editor, before = editor.captureDraft()
    gate.resolve()
    await until(() => editor.isShowingAutocomplete(), 'late native skill metadata repaints the live query')
    await paint(f.terminal)
    assert.match(f.terminal.screen(), /code-review.*Skill/)
    assert.deepEqual(editor.captureDraft(), before)
    assert.equal(f.backend.sent.length, 0)
    assert.equal(f.backend.executed.length, 0)
  } finally { gate.resolve(); await f.close() }
})

test('Esc tombstones an in-flight autocomplete intent and late metadata never reopens it', async () => {
  const gate = deferred()
  const f = await fixture('fullscreen', { gate: gate.promise })
  try {
    f.terminal.type('/co')
    await until(() => f.app.editor.isShowingAutocomplete(), 'existing command menu while Skills load')
    f.terminal.type('\x1b')
    assert.equal(f.app.editor.isShowingAutocomplete(), false)
    const before = f.app.editor.captureDraft()
    gate.resolve(); await paint(f.terminal); await paint(f.terminal)
    assert.equal(f.app.editor.isShowingAutocomplete(), false)
    assert.deepEqual(f.app.editor.captureDraft(), before)
    assert.equal(f.backend.cancels, 0)
  } finally { gate.resolve(); await f.close() }
})

test('Skills invalidation drops stale candidates and coalesces a current-scope trailing read', async () => {
  const f = await fixture()
  const gate = deferred()
  try {
    f.terminal.type('/code')
    await until(() => f.app.editor.isShowingAutocomplete(), 'initial skill menu')
    const editor = f.app.editor, before = editor.captureDraft(), reads = f.backend.reads
    f.backend.skillGate = gate.promise
    invalidate(f.backend)
    f.backend.catalog = { entries: [{ name: 'code-review-new', description: 'NEW_NATIVE_METADATA', modelInvocable: true }], available: true, complete: true }
    invalidate(f.backend); invalidate(f.backend)
    gate.resolve()
    await until(() => f.backend.reads >= reads + 2, 'coalesced fresh native observation')
    await paint(f.terminal); await paint(f.terminal)
    assert.ok(f.backend.reads <= reads + 2, 'no per-skill timers or discovery polling')
    assert.match(f.terminal.screen(), /code-review-new.*NEW_NATIVE_METADATA/)
    assert.doesNotMatch(f.terminal.screen(), /Native review metadata/)
    assert.deepEqual(editor.captureDraft(), before)
  } finally { gate.resolve(); await f.close() }
})

test('same-attachment preset changes retire visible skill candidates without changing the draft', async () => {
  const f = await fixture()
  try {
    f.terminal.type('/code')
    await until(() => f.app.editor.isShowingAutocomplete(), 'standard skill candidate')
    const editor = f.app.editor, draft = editor.captureDraft()
    f.backend.catalog = { entries: [], available: false, complete: false }
    f.backend.info = { ...f.backend.info, preset: 'minimal' }
    f.backend.emit({ type: 'ready', info: f.backend.info })
    await until(() => !editor.isShowingAutocomplete(), 'unavailable preset removes the old skill candidate')
    assert.deepEqual(editor.captureDraft(), draft)
    assert.equal(f.app.editor, editor)
    assert.equal(f.backend.sent.length, 0)
  } finally { await f.close() }
})

test('unavailable metadata is retried for the same prefix instead of being cached forever', async () => {
  const f = await fixture('fullscreen', { catalog: { entries: [], available: false, complete: false } })
  try {
    f.terminal.type('/code'); await paint(f.terminal)
    assert.equal(f.app.editor.isShowingAutocomplete(), false)
    const before = f.app.editor.captureDraft(), reads = f.backend.reads
    f.backend.catalog = CATALOG
    // This is a genuine user menu request, not a Ready event or /help warm-up.
    f.terminal.type('\t')
    await until(() => f.app.editor.isShowingAutocomplete(), 'same-prefix retry sees the native catalog')
    await paint(f.terminal)
    assert.match(f.terminal.screen(), /code-review.*Skill/)
    assert.deepEqual(f.app.editor.captureDraft(), before)
    assert.ok(f.backend.reads > reads)
    assert.equal(f.backend.sent.length, 0)
  } finally { await f.close() }
})

test('retired attachment queries and invalidations cannot install or refresh an old skill catalog', async () => {
  const f = await fixture()
  const gate = deferred()
  try {
    f.backend.skillGate = gate.promise
    invalidate(f.backend)
    const oldInfo = f.backend.info
    f.backend.skillGate = undefined
    f.backend.catalog = { entries: [{ name: 'new-scope-skill', description: 'NEW_SCOPE_ONLY', modelInvocable: true }], available: true, complete: true }
    f.backend.info = { ...oldInfo, attachmentId: 'new-skill-attachment', events: [] }
    f.backend.emit({ type: 'ready', info: f.backend.info })
    f.terminal.type('/new-scope')
    await until(() => f.app.editor.isShowingAutocomplete(), 'new attachment skill menu')
    gate.resolve()
    f.backend.emit({ type: 'skills_changed', sessionId: oldInfo.sessionId, attachmentId: oldInfo.attachmentId })
    await paint(f.terminal)
    assert.match(f.terminal.screen(), /new-scope-skill.*NEW_SCOPE_ONLY/)
    assert.doesNotMatch(f.terminal.screen(), /Native review metadata/)
  } finally { gate.resolve(); await f.close() }
})

test('metadata failures retain command completion; incomplete/empty snapshots are reported honestly', async () => {
  const f = await fixture()
  try {
    f.backend.readError = new Error('synthetic skill discovery refusal')
    invalidate(f.backend); await paint(f.terminal)
    f.terminal.type('/compact'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /Native compact command/)
    assert.match(notices(f.app), /Could not read DSH skills/)
    f.terminal.type('\x1b')
    f.backend.readError = undefined
    f.backend.catalog = { entries: [], available: true, complete: false }
    await f.app.submit('/help'); await paint(f.terminal)
    f.terminal.type('\x1b[F'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /Skills 0 incomplete/)
    assert.doesNotMatch(f.terminal.screen(), /No user-invocable skills/)
    f.terminal.type('\x1b')
    f.backend.catalog = { entries: [], available: true, complete: true }
    await f.app.submit('/help'); await paint(f.terminal)
    f.terminal.type('\x1b[F'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /No user-invocable skills/)
  } finally { await f.close() }
})

test('skill image submissions keep native content and restore the complete image-bearing draft on refusal', async () => {
  const f = await fixture()
  try {
    const image = await imageFixture()
    f.terminal.type('/code-review inspect image')
    f.app.editor.insertImage(image.upload)
    const editor = f.app.editor, before = editor.captureDraft()
    f.backend.sendError = new Error('synthetic native image refusal')
    f.terminal.type('\r')
    await until(() => notices(f.app).includes('Prompt not accepted'), 'native refusal restores skill image draft')
    assert.deepEqual(editor.captureDraft(), before)
    f.backend.sendError = undefined
    f.terminal.type('\r')
    await until(() => f.backend.sent.length === 1, 'skill image admission')
    const content = f.backend.sent[0]?.content
    assert.ok(content)
    assert.ok(content.some(part => part.type === 'image' && part.data === image.upload.data))
    assert.ok(content.some(part => part.type === 'text' && part.text.startsWith('/code-review inspect image')))
    assert.deepEqual(f.backend.executed, [])
    const route = f.backend.calls.find(call => call.name === 'input-route')
    assert.deepEqual(route?.args, { name: 'code-review' }, 'classification carries only a name, never image bytes')
  } finally { await f.close() }
})

test('Enter completion captures the completed image-bearing draft before clearing or refusal', async () => {
  const f = await fixture()
  try {
    const image = await imageFixture()
    const editor = f.app.editor
    editor.insertTextAtCursor('/code ')
    editor.insertImage(image.upload)
    const original = editor.captureDraft()
    editor.restoreDraft({ ...original, cursorLine: 0, cursorCol: 5 })
    editor.ccRefreshAutocomplete()
    await until(() => editor.isShowingAutocomplete(), 'skill completion ahead of the image suffix')
    f.backend.sendError = new Error('synthetic completed-image refusal')
    f.terminal.type('\r')
    await until(() => notices(f.app).includes('Prompt not accepted'), 'native refusal restores completed draft')
    assert.ok(editor.getText().startsWith('/code-review '), 'the restored name is the selected completion, not /code')
    assert.ok(editor.getPromptContent().some(part => part.type === 'image' && part.data === image.upload.data))
    assert.equal(f.backend.sent.length, 0)
    f.backend.sendError = undefined
    f.terminal.type('\r')
    await until(() => f.backend.sent.length === 1, 'retry submits completed image content')
    assert.ok(f.backend.sent[0]?.content?.some(part => part.type === 'text' && part.text.startsWith('/code-review ')))
    assert.ok(f.backend.sent[0]?.content?.some(part => part.type === 'image' && part.data === image.upload.data))
  } finally { await f.close() }
})

test('missing native image admission rejects before a submitted skill creates any native scope', async () => {
  const f = await fixture('fullscreen', { capabilities: ['commands', 'execute', 'state', 'skills', 'input-route'] })
  try {
    f.terminal.type('/code-review image task')
    f.app.editor.insertImage((await imageFixture()).upload)
    const before = f.app.editor.captureDraft()
    f.terminal.type('\r')
    await until(() => /no native (?:image|attachment) prompt admission/.test(notices(f.app)), 'missing native admission keeps skill image draft')
    assert.deepEqual(f.app.editor.captureDraft(), before)
    assert.equal(f.backend.calls.some(call => call.name === 'input-route'), false)
    assert.equal(f.backend.sent.length, 0)
  } finally { await f.close() }
})

test('a late input route cannot submit to a replacement attachment or overwrite a competing draft', async () => {
  const f = await fixture()
  const gate = deferred()
  try {
    f.backend.routeGate = gate.promise
    f.terminal.type('/code-review original submission')
    f.terminal.type('\r')
    await until(() => f.backend.calls.some(call => call.name === 'input-route'), 'in-flight native input route')
    f.backend.info = { ...f.backend.info, attachmentId: 'replacement-input-attachment', events: [] }
    f.backend.emit({ type: 'ready', info: f.backend.info })
    f.terminal.type('new attachment draft')
    gate.resolve(); await paint(f.terminal)
    assert.deepEqual(f.backend.sent, [])
    assert.deepEqual(f.backend.executed, [])
    assert.equal(f.app.editor.getText(), 'new attachment draft')
  } finally { gate.resolve(); await f.close() }
})

test('without Skills capability no query is invented and unknown slash remains native execution', async () => {
  const f = await fixture('fullscreen', { capabilities: ['commands', 'execute', 'state'] })
  try {
    assert.equal(f.backend.reads, 0)
    f.terminal.type('/code'); await paint(f.terminal)
    assert.equal(f.app.editor.isShowingAutocomplete(), false)
    await f.app.submit('/code-review')
    assert.deepEqual(f.backend.executed, ['/code-review'])
    assert.deepEqual(f.backend.sent, [])
    assert.equal(f.backend.calls.some(call => call.name === 'input-route'), false)
  } finally { await f.close() }
})

test('Help shows unavailable Skills even when the composition exposes no metadata capability', async () => {
  const f = await fixture('fullscreen', { capabilities: ['commands', 'execute', 'state'] })
  try {
    await f.app.submit('/help'); await paint(f.terminal)
    f.terminal.type('\x1b[F'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /Skills \?/)
    assert.match(f.terminal.screen(), /No skill catalog is available/)
    assert.equal(f.backend.reads, 0, 'no unsupported registry call is fabricated')
    assert.equal(f.backend.calls.some(call => call.name === 'input-route'), false)
  } finally { await f.close() }
})

test('root Skills metadata is not advertised as a child reply scope and child slash text never executes at root', async () => {
  class RecordingDemo extends DemoBackend {
    readonly calls: string[] = []
    override async command(name: string, args: JsonRecord = {}) { this.calls.push(name); return super.command(name, args) }
  }
  const directory = await mkdtemp(join(tmpdir(), 'dsh-child-skill-scope-'))
  const backend = new RecordingDemo({ cwd: directory, delayMs: 0 })
  const terminal = new VirtualTerminal(120, 48)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen: 'fullscreen', demo: true, registerSignals: false })
  try {
    await app.start(); await app.submit('subagent')
    await until(() => app.store.subagentEntries.length === 5 && !app.isBusy, 'child fixture catalog')
    await app.submit('/agent'); await paint(terminal)
    terminal.type('r')
    await until(() => app.replyTargetSessionId !== undefined, 'child reply destination')
    terminal.type('/code'); await paint(terminal)
    assert.equal(app.editor.isShowingAutocomplete(), false, 'the root skill catalog is not a child catalog')
    terminal.type('-review literal child text'); terminal.type('\r')
    await until(() => backend.calls.includes('subagent-prompt'), 'child native prompt')
    assert.equal(backend.calls.includes('execute'), false)
    assert.equal(backend.calls.includes('input-route'), false)
  } finally { await app.shutdown(); terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
})

test('neutral skill parsing retains metadata only and never mistakes file paths/Pi aliases for native gestures', () => {
  const input = { entries: [{ ...CATALOG.entries[0], content: 'MUST_NOT_CROSS_METADATA', path: '/fixture/secret', locator: { secret: true } }], available: true, complete: true }
  const parsed = readSkillCatalog(input)
  assert.deepEqual(parsed, { entries: [CATALOG.entries[0]], available: true, complete: true })
  assert.equal(JSON.stringify(parsed).includes('MUST_NOT_CROSS_METADATA'), false)
  assert.equal(readSkillCatalog({ entries: [] }), undefined)
  assert.deepEqual(readSkillCatalog({ entries: [{ name: 'bad/name' }], available: true, complete: true }), { entries: [], available: true, complete: false })
  for (const value of ['/usr/bin', '/skill:code-review', '/Code-review', '/', '5/8', 'Use /code-review']) assert.equal(leadingSkillGestureName(value), undefined)
  assert.equal(leadingSkillGestureName('/code-review\t task\nmore'), 'code-review')
})
