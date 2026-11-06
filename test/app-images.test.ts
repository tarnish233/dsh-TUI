import './helpers/truecolor.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCapabilities, setCapabilities, visibleWidth, type NativeClipboard } from '#pi-tui'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, ImageAttachmentRef, ImageAttachmentValue, JsonRecord, PromptContentPart, SessionEvent, SessionInfo } from '../src/backend/types.ts'
import { defaults } from '../src/config.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { resetImageDisplayCache } from '../src/ui/image-cache.ts'
import { imageFixture } from './helpers/images.ts'
import { VirtualTerminal, delay, until } from './helpers/terminal.ts'

/** Parent-owned App acceptance source, independent of UI/backend implementations. */
class ImagesBackend implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  readonly sent: string[] = []
  readonly contentSent: PromptContentPart[][] = []
  readonly reads: ImageAttachmentRef[] = []
  readonly readSignals: Array<AbortSignal | undefined> = []
  readonly values = new Map<string, ImageAttachmentValue>()
  readonly listeners = new Set<(event: BackendEvent) => void>()
  cancelCount = 0
  sequence = 0
  info: SessionInfo
  readOverride?: (ref: ImageAttachmentRef, signal?: AbortSignal) => Promise<ImageAttachmentValue>
  sendFailure?: Error
  queueEntries: JsonRecord[] = []
  dequeueCount = 0
  constructor(cwd: string) {
    this.info = { sessionId: 'images-parent', attachmentId: 'attachment-a', cwd, provider: 'fixture', model: 'text-only-fixture',
      capabilities: ['state', 'commands', 'images', 'prompt-content', 'dequeue'], events: [] }
  }
  onEvent(listener: (event: BackendEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent): void { for (const listener of this.listeners) listener(event) }
  async connect(): Promise<SessionInfo> { this.emit({ type: 'ready', info: this.info }); return this.info }
  async send(text: string): Promise<void> { if (this.sendFailure) throw this.sendFailure; this.sent.push(text) }
  async sendContent(content: readonly PromptContentPart[]): Promise<void> {
    if (this.sendFailure) throw this.sendFailure
    this.contentSent.push(structuredClone([...content]))
  }
  async readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<ImageAttachmentValue> {
    this.reads.push(ref); this.readSignals.push(signal)
    if (this.readOverride) return this.readOverride(ref, signal)
    const value = this.values.get(ref.attachmentId)
    if (!value) throw new Error('Fixture attachment missing')
    return value
  }
  async cancel(): Promise<void> { this.cancelCount += 1; this.emit({ type: 'status', sessionId: this.info.sessionId, status: 'idle' }) }
  async command(name: string, _args?: JsonRecord): Promise<unknown> {
    if (name === 'state') return { queued: this.queueEntries.length, pending: { nextTurn: this.queueEntries.length, nextStep: 0 } }
    if (name === 'dequeue') { this.dequeueCount += 1; const entries = this.queueEntries; this.queueEntries = []; return entries }
    if (name === 'commands') return []
    if (name === 'auto-title') return { available: false }
    return {}
  }
  async respond(): Promise<void> {}
  async close(): Promise<void> { this.emit({ type: 'closed', code: 0 }); this.listeners.clear() }
  durable(type: string, data: JsonRecord): SessionEvent {
    const event: SessionEvent = { type, seq: ++this.sequence, time: Date.now(), data, surfaceOp: 'append' }
    this.info.events?.push(event); this.emit({ type: 'session_event', sessionId: this.info.sessionId, event }); return event
  }
  user(content: unknown[]): void { this.durable('user/message', { content, source: { kind: 'user' } }) }
  tool(ref: ImageAttachmentRef, id = 'image-tool'): void {
    this.durable('tool/call', { callId: id, name: 'read_image', arguments: JSON.stringify({ path: 'fixture.png' }), turn: 1, step: 1 })
    this.durable('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: id, isError: false,
      content: [{ type: 'text', text: 'Image read from fixture.' }, { type: 'image', attachment: ref }], source: { kind: 'tool', callId: id } } })
  }
}

async function fixture(screen: 'inline' | 'fullscreen' = 'fullscreen', options: {
  images?: boolean; columns?: number; rows?: number; bindings?: JsonRecord; clipboard?: NativeClipboard;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-images-'))
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ ...defaults, screen, expandTools: true }))
  if (options.bindings) await writeFile(join(directory, 'keybindings.json'), JSON.stringify(options.bindings))
  const caps = getCapabilities(); setCapabilities({ images: options.images === false ? null : 'kitty', trueColor: true, hyperlinks: true })
  resetImageDisplayCache()
  const terminal = new VirtualTerminal(options.columns ?? 90, options.rows ?? 32), backend = new ImagesBackend(directory)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen, demo: true, registerSignals: false, clipboard: options.clipboard })
  await app.start(); await paint(terminal)
  return { app, terminal, backend, directory, async close() {
    try { await app.shutdown() } finally { terminal.dispose(); setCapabilities(caps); resetImageDisplayCache(); await rm(directory, { recursive: true, force: true }) }
  } }
}
async function paint(terminal: VirtualTerminal): Promise<void> { await delay(40); await terminal.flush() }
async function open(terminal: VirtualTerminal): Promise<void> { terminal.type('\x18'); terminal.type('\t'); await paint(terminal) }
async function ready(terminal: VirtualTerminal): Promise<void> { await until(() => terminal.screen().includes('Ready'), 'image ready'); await paint(terminal) }
function cell(terminal: VirtualTerminal, text: string): { x: number; y: number } {
  const lines = terminal.screen().split('\n')
  const y = lines.findIndex(line => line.includes(text)); assert.ok(y >= 0, `Missing ${text}\n${terminal.screen()}`)
  return { x: visibleWidth(lines[y]!.slice(0, lines[y]!.indexOf(text))), y }
}
async function click(terminal: VirtualTerminal, point: { x: number; y: number }): Promise<void> {
  terminal.type(`\x1b[<0;${point.x + 1};${point.y + 1}M`); await paint(terminal)
  terminal.type(`\x1b[<0;${point.x + 1};${point.y + 1}m`); await paint(terminal)
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`parent image App: lazy native refs become real PNG transmission (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      const image = await imageFixture(); f.backend.values.set(image.attachment.attachmentId, image.value)
      f.backend.user([{ type: 'text', text: 'Before image' }, { type: 'image', attachment: image.attachment }, { type: 'text', text: 'After image' }])
      await paint(f.terminal)
      assert.equal(f.backend.reads.length, 0, 'marker repaint must not read bytes')
      f.app.editor.handleInput('keep draft')
      await open(f.terminal); await ready(f.terminal)
      assert.match(f.terminal.screen(), /Image details/)
      assert.equal(f.backend.reads.length, 1)
      assert.ok(f.terminal.writes.join('').includes(image.value.data), 'actual obtained PNG payload reaches terminal encoder')
      assert.match(f.terminal.writes.join(''), /\x1b_Ga=T,f=100/)
      f.terminal.type('\x03'); await paint(f.terminal)
      assert.equal(f.backend.cancelCount, 0, 'idle Ctrl+C only closes viewer')
      assert.equal(f.app.editor.getExpandedText(), 'keep draft')
      assert.doesNotMatch(f.terminal.screen(), /Image details/)
    } finally { await f.close() }
  })

  test(`parent image App: occurrence navigation retains duplicates and declaration order (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      const image = await imageFixture(); f.backend.values.set(image.attachment.attachmentId, image.value)
      f.backend.user([{ type: 'image', attachment: image.attachment }, { type: 'image', attachment: image.attachment }])
      f.backend.tool(image.attachment)
      await open(f.terminal); await ready(f.terminal)
      assert.match(f.terminal.screen(), /Image 3 of 3/)
      f.terminal.type('['); await paint(f.terminal); assert.match(f.terminal.screen(), /Image 2 of 3/)
      f.terminal.type('['); await paint(f.terminal); assert.match(f.terminal.screen(), /Image 1 of 3/)
      f.terminal.type('['); await paint(f.terminal); assert.match(f.terminal.screen(), /Image 1 of 3/)
      assert.equal(f.backend.contentSent.length, 0)
      assert.equal(f.backend.sent.length, 0)
      f.terminal.type('\x1b'); await paint(f.terminal)
    } finally { await f.close() }
  })
}

test('parent image App: fullscreen chip pointer opens image; stale deleted targets do nothing', async () => {
  const f = await fixture()
  try {
    const image = await imageFixture(); f.backend.values.set(image.attachment.attachmentId, image.value)
    f.backend.user([{ type: 'image', attachment: image.attachment }]); await paint(f.terminal)
    const point = cell(f.terminal, '[Image #1]')
    await click(f.terminal, point); await ready(f.terminal)
    f.terminal.type('\x1b'); await paint(f.terminal)
    f.backend.info = { ...f.backend.info, sessionId: 'replacement', attachmentId: 'attachment-b', events: [] }
    f.backend.emit({ type: 'ready', info: f.backend.info }); await paint(f.terminal)
    await click(f.terminal, point)
    assert.doesNotMatch(f.terminal.screen(), /Image details/)
  } finally { await f.close() }
})

test('parent image App: image viewing returns to the original tool inspector and draft', async () => {
  const f = await fixture(), image = await imageFixture()
  try {
    f.backend.values.set(image.attachment.attachmentId, image.value)
    f.backend.tool(image.attachment)
    f.app.editor.handleInput('inspector draft stays')
    f.terminal.type('\x18'); f.terminal.type('\x0f'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /Tool details/)
    await open(f.terminal); await ready(f.terminal)
    assert.match(f.terminal.screen(), /Image details/)
    f.terminal.type('\x1b'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /Tool details/)
    assert.match(f.terminal.screen(), /Output/)
    f.terminal.type('\x1b'); await paint(f.terminal)
    assert.equal(f.app.editor.getExpandedText(), 'inspector draft stays')
    assert.doesNotMatch(f.terminal.screen(), /Tool details|Image details/)
  } finally { await f.close() }
})

test('parent image App: closing a pending read aborts it and a late value never draws', async () => {
  const f = await fixture()
  try {
    const image = await imageFixture(), pending = deferred<ImageAttachmentValue>()
    f.backend.readOverride = () => pending.promise
    f.backend.user([{ type: 'image', attachment: image.attachment }]); await open(f.terminal)
    assert.equal(f.backend.reads.length, 1)
    f.terminal.type('\x1b'); await paint(f.terminal)
    assert.equal(f.backend.readSignals[0]?.aborted, true)
    const start = f.terminal.writes.length
    pending.resolve(image.value); await paint(f.terminal)
    assert.ok(!f.terminal.writes.slice(start).join('').includes(image.value.data))
    assert.doesNotMatch(f.terminal.screen(), /Image details/)
  } finally { await f.close() }
})

test('parent image App: same-session attachment replacement retires pending viewer', async () => {
  const f = await fixture()
  try {
    const image = await imageFixture(), pending = deferred<ImageAttachmentValue>()
    f.backend.readOverride = () => pending.promise
    f.backend.user([{ type: 'image', attachment: image.attachment }]); await open(f.terminal)
    f.backend.info = { ...f.backend.info, attachmentId: 'new-native-attachment', events: [] }
    f.backend.emit({ type: 'ready', info: f.backend.info }); await paint(f.terminal)
    assert.equal(f.backend.readSignals[0]?.aborted, true)
    pending.resolve(image.value); await paint(f.terminal)
    assert.doesNotMatch(f.terminal.screen(), /Image details/)
  } finally { await f.close() }
})

test('parent image App: native decisions preempt viewing and busy Ctrl+C cancels once', async () => {
  const f = await fixture()
  try {
    const image = await imageFixture(); f.backend.values.set(image.attachment.attachmentId, image.value)
    f.backend.user([{ type: 'image', attachment: image.attachment }]); await open(f.terminal); await ready(f.terminal)
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'running' })
    f.terminal.type('\x03'); await paint(f.terminal); assert.equal(f.backend.cancelCount, 1)
    await open(f.terminal); await ready(f.terminal)
    f.backend.emit({ type: 'decision', sessionId: f.backend.info.sessionId, request: { id: 'image-decision', kind: 'approval', title: 'Native image permission', options: [{ label: 'No', value: false }] } })
    await paint(f.terminal)
    assert.doesNotMatch(f.terminal.screen(), /Image details/)
    assert.match(f.terminal.screen(), /Native image permission/)
  } finally { await f.close() }
})

test('parent image App: forced redraw and height-only resize reupload valid image bytes', async () => {
  const f = await fixture()
  try {
    const image = await imageFixture(); f.backend.values.set(image.attachment.attachmentId, image.value)
    f.backend.user([{ type: 'image', attachment: image.attachment }]); await open(f.terminal); await ready(f.terminal)
    let start = f.terminal.writes.length
    f.app.tui.requestRender(true); await paint(f.terminal)
    assert.ok(f.terminal.writes.slice(start).join('').includes(image.value.data), 'a cleared terminal receives bytes, not only a stale placement id')
    start = f.terminal.writes.length
    f.terminal.resize(f.terminal.columns, 24); await paint(f.terminal)
    assert.ok(f.terminal.writes.slice(start).join('').includes(image.value.data))
    assert.match(f.terminal.screen(), /Image details/)
  } finally { await f.close() }
})

test('parent image App: unsupported terminal remains readable without graphic sequences', async () => {
  const f = await fixture('fullscreen', { images: false })
  try {
    const image = await imageFixture(); f.backend.values.set(image.attachment.attachmentId, image.value)
    f.backend.user([{ type: 'image', attachment: image.attachment }]); await open(f.terminal); await ready(f.terminal)
    assert.match(f.terminal.screen(), /cannot display|unsupported|\[Image/i)
    assert.doesNotMatch(f.terminal.writes.join(''), /\x1b_Ga=T/)
    f.terminal.type('\x1b'); await paint(f.terminal)
    assert.doesNotMatch(f.terminal.screen(), /Image details/)
  } finally { await f.close() }
})

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`parent image App: clipboard image-only sends native content, never marker text (${screen})`, async () => {
    const image = await imageFixture()
    let textReads = 0
    const f = await fixture(screen, { clipboard: { getImage: async () => image.bytes, getText: async () => { textReads++; return 'wrong text branch' } } })
    try {
      f.terminal.type('\x16'); await paint(f.terminal)
      assert.equal(f.app.editor.getImageAttachments().length, 1)
      assert.equal(textReads, 0)
      f.terminal.type('\r'); await paint(f.terminal)
      assert.equal(f.backend.sent.length, 0)
      assert.equal(f.backend.contentSent.length, 1)
      assert.equal(f.backend.contentSent[0]!.filter(part => part.type === 'image').length, 1)
      assert.ok(!f.backend.contentSent[0]!.some(part => part.type === 'text' && part.text.includes('[Image #')))
      assert.equal(f.app.editor.getImageAttachments().length, 0)
    } finally { await f.close() }
  })

  test(`parent image App: failed native image admission restores full editable draft (${screen})`, async () => {
    const image = await imageFixture(), f = await fixture(screen)
    try {
      f.app.editor.handleInput('before '); f.app.editor.insertImage(image.upload); f.app.editor.handleInput('after')
      const expected = f.app.editor.getPromptContent()
      f.backend.sendFailure = new Error('native attachment refused')
      f.terminal.type('\r'); await paint(f.terminal)
      assert.deepEqual(f.app.editor.getPromptContent(), expected)
      assert.equal(f.app.editor.getImageAttachments().length, 1)
      assert.match(f.terminal.screen(), /native attachment refused/)
      assert.equal(f.backend.contentSent.length, 0)
    } finally { await f.close() }
  })
}

test('parent image App: in-flight native failure does not overwrite a newer draft', async () => {
  const f = await fixture(), image = await imageFixture(), pending = deferred<void>()
  try {
    f.backend.sendContent = async () => { await pending.promise; throw new Error('late native rejection') }
    f.app.editor.insertImage(image.upload); f.terminal.type('\r'); await paint(f.terminal)
    f.app.editor.handleInput('new draft stays')
    pending.resolve(); await paint(f.terminal)
    assert.equal(f.app.editor.getExpandedText(), 'new draft stays')
    assert.equal(f.app.editor.getImageAttachments().length, 0)
  } finally { await f.close() }
})

test('parent image App: missing send capability keeps image rather than sending phantom text', async () => {
  const f = await fixture(), image = await imageFixture()
  try {
    Object.defineProperty(f.backend, 'sendContent', { value: undefined })
    f.app.editor.insertImage(image.upload); f.terminal.type('\r'); await paint(f.terminal)
    assert.equal(f.app.editor.getImageAttachments().length, 1)
    assert.match(f.terminal.screen(), /does not support native image/)
    assert.equal(f.backend.sent.length, 0)
  } finally { await f.close() }
})

test('parent image App: draft image previews without reading a durable attachment', async () => {
  const f = await fixture(), image = await imageFixture()
  try {
    f.app.editor.insertImage(image.upload)
    await open(f.terminal); await ready(f.terminal)
    assert.match(f.terminal.screen(), /Draft image 1/)
    assert.equal(f.backend.reads.length, 0)
    assert.match(f.terminal.writes.join(''), /\x1b_Ga=T,f=100/)
    f.terminal.type('\x1b'); await paint(f.terminal)
    assert.equal(f.app.editor.getImageAttachments().length, 1)
  } finally { await f.close() }
})

test('parent image App: text clipboard fallback remains atomic and never submits', async () => {
  const f = await fixture('fullscreen', { clipboard: { getImage: async () => null, getText: async () => 'clipboard text\nnext line' } })
  try {
    f.terminal.type('\x16'); await paint(f.terminal)
    assert.equal(f.app.editor.getExpandedText(), 'clipboard text\nnext line')
    assert.equal(f.app.editor.getImageAttachments().length, 0)
    assert.equal(f.backend.sent.length, 0)
    f.terminal.type('\x1f'); await paint(f.terminal)
    assert.equal(f.app.editor.getExpandedText(), '')
  } finally { await f.close() }
})

test('parent image App: cancelling clipboard read prevents late insertion and does not arm exit', async () => {
  const image = await imageFixture(), pending = deferred<Uint8Array | null>()
  const f = await fixture('fullscreen', { clipboard: { getImage: () => pending.promise, getText: async () => null } })
  try {
    f.terminal.type('\x16'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /Pasting/)
    f.terminal.type('\x03'); await paint(f.terminal)
    pending.resolve(image.bytes); await paint(f.terminal)
    assert.equal(f.app.editor.getExpandedText(), '')
    assert.equal(f.app.editor.getImageAttachments().length, 0)
    assert.doesNotMatch(f.terminal.screen(), /again to exit/)
  } finally { await f.close() }
})

test('parent image App: image draft survives clear recall and stash restore', async () => {
  const f = await fixture(), image = await imageFixture()
  try {
    f.app.editor.handleInput('photo: '); f.app.editor.insertImage(image.upload)
    const expected = f.app.editor.getPromptContent()
    f.terminal.type('\x03'); await paint(f.terminal)
    assert.equal(f.app.editor.getExpandedText(), '')
    f.terminal.type('\x10'); await paint(f.terminal)
    assert.deepEqual(f.app.editor.getPromptContent(), expected)
    f.terminal.type('\x13'); await paint(f.terminal)
    assert.equal(f.app.editor.getExpandedText(), '')
    f.terminal.type('\x13'); await paint(f.terminal)
    assert.deepEqual(f.app.editor.getPromptContent(), expected)
  } finally { await f.close() }
})

test('parent image App: native queued image content is restored in order without dropping pixels', async () => {
  const f = await fixture(), image = await imageFixture()
  try {
    f.backend.values.set(image.attachment.attachmentId, image.value)
    f.backend.queueEntries = [{ messageId: 'queued-image', text: 'before after', content: [
      { type: 'text', text: 'before ' }, { type: 'image', attachment: image.attachment }, { type: 'text', text: ' after' },
    ] }]
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'running' }); await paint(f.terminal)
    f.terminal.type('\x10'); await paint(f.terminal)
    assert.equal(f.backend.dequeueCount, 1)
    const parts = f.app.editor.getPromptContent()
    assert.deepEqual(parts.map(part => part.type), ['text', 'image', 'text'])
    assert.equal(parts.find(part => part.type === 'image')?.data, image.value.data)
    assert.equal(f.backend.contentSent.length, 0, 'recall never re-sends automatically')
  } finally { await f.close() }
})

test('parent image App: failed queue image read retains refs for explicit retry, not phantom text', async () => {
  const f = await fixture(), image = await imageFixture()
  try {
    let attempt = 0
    f.backend.readOverride = async () => { if (attempt++ === 0) throw new Error('temporary image read failure'); return image.value }
    f.backend.queueEntries = [{ messageId: 'queued-retry', text: '', content: [{ type: 'image', attachment: image.attachment }] }]
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'running' }); await paint(f.terminal)
    f.terminal.type('\x10'); await paint(f.terminal)
    assert.equal(f.app.editor.getExpandedText(), '')
    assert.match(f.terminal.screen(), /temporary image read failure/)
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'idle' }); await paint(f.terminal)
    f.terminal.type('\x10'); await paint(f.terminal)
    assert.equal(f.app.editor.getImageAttachments().length, 1)
    assert.equal(f.backend.dequeueCount, 1, 'retry uses retained receipt, not another dequeue')
    assert.equal(f.backend.contentSent.length, 0)
  } finally { await f.close() }
})

test('parent image App: queue image loading does not replace a competing new draft', async () => {
  const f = await fixture(), image = await imageFixture(), pending = deferred<ImageAttachmentValue>()
  try {
    let attempt = 0
    f.backend.readOverride = () => attempt++ === 0 ? pending.promise : Promise.resolve(image.value)
    f.backend.queueEntries = [{ messageId: 'queued-competing', text: 'queued', content: [{ type: 'image', attachment: image.attachment }] }]
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'running' }); await paint(f.terminal)
    f.terminal.type('\x10'); await paint(f.terminal)
    f.app.editor.handleInput('new draft preserved')
    pending.resolve(image.value); await paint(f.terminal)
    assert.equal(f.app.editor.getExpandedText(), 'new draft preserved')
    f.terminal.type('\x13'); await paint(f.terminal)
    f.terminal.type('\x10'); await paint(f.terminal)
    assert.equal(f.app.editor.getImageAttachments().length, 1)
    assert.equal(f.backend.dequeueCount, 1)
  } finally { await f.close() }
})

test('parent image App: missing native attachment yields actionable viewer error', async () => {
  const f = await fixture()
  try {
    const image = await imageFixture()
    f.backend.user([{ type: 'image', attachment: image.attachment }]); await open(f.terminal)
    await until(() => f.terminal.screen().includes('Fixture attachment missing'), 'missing image error')
    assert.doesNotMatch(f.terminal.writes.join(''), /\x1b_Ga=T/)
    f.terminal.type('\x1b'); await paint(f.terminal)
  } finally { await f.close() }
})
