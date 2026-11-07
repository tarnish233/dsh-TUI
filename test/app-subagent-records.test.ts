import './helpers/truecolor.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { visibleWidth } from '#pi-tui'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, JsonRecord, SessionEvent, SessionInfo, SubagentEntry } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { delay, until, VirtualTerminal } from './helpers/terminal.ts'
import { imageFixture } from './helpers/images.ts'

const ROOT = 'records-root'
const ALPHA = 'records-child-a'
const BETA = 'records-child-b'
const ALPHA_LABEL = '甲号 👩‍💻 café'
const BETA_LABEL = '乙号任务'
function child(id: string, label: string, overrides: Partial<SubagentEntry> = {}): SubagentEntry {
  return { id, parentSessionId: ROOT, label, mode: 'continuable', status: 'idle', local: true, ...overrides }
}
function message(senderSessionId: string, sourceKind: 'subagent-settled' | 'agent-message', seq: number, text: string, summary?: string): SessionEvent {
  return {
    type: 'user/message', seq, time: 1_750_000_000_000 + seq, surfaceOp: 'append',
    data: { id: `records-message-${seq}`, role: 'user', content: [{ type: 'text', text }],
      source: { kind: sourceKind, senderSessionId, ...(summary === undefined ? {} : { summary }) } },
  }
}
function human(text: string, seq = 1): SessionEvent {
  return { type: 'user/message', seq, time: 1_750_000_000_000 + seq, surfaceOp: 'append',
    data: { id: `records-human-${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } }
}
const facts = [
  message(ALPHA, 'agent-message', 1, 'Alpha native result content 中文, not a root prompt.'),
  message(ALPHA, 'subagent-settled', 2, 'Native alpha completed\n\nAlpha native settlement detail.', 'Native alpha completed'),
  message(BETA, 'agent-message', 3, 'Beta native result content, preserved verbatim.'),
  message(BETA, 'subagent-settled', 4, 'Native beta completed\n\nBeta native settlement detail.', 'Native beta completed'),
]

/** Native-shaped projection/read fixture only. No Agent or remote model exists. */
class RecordBackend implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly calls: Array<{ name: string; args: JsonRecord }> = []
  info: SessionInfo
  entries: readonly SubagentEntry[]
  sends = 0
  cancels = 0
  constructor(cwd: string, entries: readonly SubagentEntry[], events: readonly SessionEvent[]) {
    this.entries = entries
    this.info = { sessionId: ROOT, attachmentId: 'records-attachment', cwd, provider: 'fixture', model: 'records-root-model',
      capabilities: ['commands', 'state', 'subagents', 'subagent-session', 'subagent-follow'], events: [...events], subagents: { entries } }
  }
  onEvent(listener: (event: BackendEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent): void { for (const listener of this.listeners) listener(event) }
  async connect(): Promise<SessionInfo> { this.emit({ type: 'ready', info: this.info }); return this.info }
  async send(): Promise<void> { this.sends += 1 }
  async cancel(): Promise<void> { this.cancels += 1 }
  async respond(): Promise<void> { throw new Error('record fixture never responds to decisions') }
  async close(): Promise<void> {}
  async command(name: string, args: JsonRecord = {}): Promise<unknown> {
    this.calls.push({ name, args })
    if (name === 'commands') return []
    if (name === 'state') return { pending: { nextTurn: 0, nextStep: 0 }, queued: 0, queue: [] }
    if (name === 'auto-title') return { available: false }
    if (name === 'subagent-follow') return { sessionId: args.sessionId, follow: args.follow, supported: true }
    if (name === 'subagent-session') {
      const entry = this.entries.find(value => value.id === args.sessionId)
      assert.ok(entry && entry.local !== false && entry.mode !== 'external', 'only native local catalog members may be read')
      return { sessionId: entry.id, cwd: this.info.cwd, provider: 'fixture', model: 'records-child-model', capabilities: [],
        events: [human(`Native child record view for ${entry.id}`)] } satisfies SessionInfo
    }
    throw new Error('unexpected records fixture command: ' + name)
  }
  catalog(entries: readonly SubagentEntry[]): void {
    this.entries = entries
    this.emit({ type: 'subagents', sessionId: ROOT, value: { entries } })
  }
}
async function paint(terminal: VirtualTerminal): Promise<void> { await delay(45); await terminal.flush() }
async function fixture(options: { screen?: 'inline' | 'fullscreen'; groupTools?: boolean; entries?: readonly SubagentEntry[]; events?: readonly SessionEvent[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-app-subagent-records-'))
  if (options.groupTools !== undefined) await writeFile(join(directory, 'settings.json'), JSON.stringify({ groupTools: options.groupTools }))
  const backend = new RecordBackend(directory, options.entries ?? [child(ALPHA, ALPHA_LABEL), child(BETA, BETA_LABEL)], options.events ?? facts)
  const terminal = new VirtualTerminal(140, 52)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen: options.screen ?? 'fullscreen', registerSignals: false })
  try {
    await app.start(); await paint(terminal)
    return { app, backend, terminal, async close() {
      try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
    } }
  } catch (error) {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
    throw error
  }
}
function lines(terminal: VirtualTerminal): string[] { return terminal.screen().split('\n') }
function rowFor(terminal: VirtualTerminal, title: string, label: string): number {
  const row = lines(terminal).findIndex(line => line.includes(title) && line.includes(label))
  assert.ok(row >= 0, `missing ${title} / ${label}\n${terminal.screen()}`)
  return row
}
function columnFor(line: string, text: string): number {
  const index = line.indexOf(text)
  assert.ok(index >= 0, `missing ${text} in ${line}`)
  return visibleWidth(line.slice(0, index))
}
function cell(terminal: VirtualTerminal, row: number, col: number) {
  const value = terminal.xterm.buffer.active.getLine(terminal.xterm.buffer.active.viewportY + row)?.getCell(col)
  assert.ok(value)
  return value
}
const press = (terminal: VirtualTerminal, x: number, y: number): void => terminal.type(`\x1b[<0;${x + 1};${y + 1}M`)
const release = (terminal: VirtualTerminal, x: number, y: number): void => terminal.type(`\x1b[<0;${x + 1};${y + 1}m`)
async function click(terminal: VirtualTerminal, x: number, y: number): Promise<void> { press(terminal, x, y); await paint(terminal); release(terminal, x, y); await paint(terminal) }
function controlCalls(backend: RecordBackend) { return backend.calls.filter(call => call.name.startsWith('subagent')) }
function copyPacket(terminal: VirtualTerminal, offset: number): string {
  const packets = [...terminal.writes.slice(offset).join('').matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/g)]
  assert.ok(packets.length > 0, 'private native selection emits its controlled clipboard packet')
  return Buffer.from(packets.at(-1)![1]!, 'base64').toString('utf8')
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`consecutive native subagent messages form one disclosure without changing facts (${screen})`, async () => {
    const f = await fixture({ screen })
    try {
      const stored = f.app.store.items.filter(item => item.kind === 'subagent-message')
      assert.equal(stored.length, 4)
      assert.deepEqual(stored.map(item => [item.seq, item.senderSessionId, item.text]), facts.map(event => {
        const data = event.data as { content: { text: string }[]; source: { senderSessionId: string } }
        return [event.seq, data.source.senderSessionId, data.content[0]!.text]
      }))
      const collapsed = f.terminal.screen()
      assert.equal(lines(f.terminal).filter(line => line.includes('Subagents:')).length, 1)
      assert.match(collapsed, /4 records/)
      assert.match(collapsed, /Task message received|Subtask status updated/)
      assert.doesNotMatch(collapsed, /Alpha native result content|Beta native settlement detail/)
      f.terminal.type('\x0f'); await paint(f.terminal)
      assert.match(f.terminal.screen(), /Alpha native result content/)
      assert.match(f.terminal.screen(), /Beta native settlement detail/)
      f.terminal.type('\x0f'); await paint(f.terminal)
      assert.doesNotMatch(f.terminal.screen(), /Alpha native result content/)
      assert.deepEqual(f.app.store.items.filter(item => item.kind === 'subagent-message'), stored)
      assert.equal(controlCalls(f.backend).length, 0, 'group/disclosure creates no native child read')
      assert.equal(f.backend.sends + f.backend.cancels, 0)
    } finally { await f.close() }
  })
}

for (const grouped of [false, true]) {
  for (const expanded of grouped ? [false, true] : [false]) {
    test(`both durable message types navigate only via the displayed catalog name (grouped=${grouped}, expanded=${expanded})`, async () => {
      const f = await fixture({ groupTools: grouped })
      try {
        f.terminal.type('records retained draft')
        const editor = f.app.editor, image = await imageFixture()
        editor.insertImage(image.upload)
        const draft = editor.captureDraft()
        if (expanded) { f.terminal.type('\x0f'); await paint(f.terminal) }
        for (const title of ['Task message received', 'Subtask status updated']) {
          const row = rowFor(f.terminal, title, ALPHA_LABEL)
          const line = lines(f.terminal)[row]!
          const start = columnFor(line, ALPHA_LABEL), end = start + visibleWidth(ALPHA_LABEL)
          assert.equal(Boolean(cell(f.terminal, row, start).isUnderline()), true)
          assert.equal(Boolean(cell(f.terminal, row, start).isBold()), true)
          assert.equal(Boolean(cell(f.terminal, row, end - 1).isUnderline()), true, 'wide/ZWJ name uses actual visible terminal cells')
          assert.equal(Boolean(cell(f.terminal, row, end).isUnderline()), false)
          const titleCol = columnFor(line, title)
          // A member's non-name cells are neither navigation nor disclosure.
          // Only the group header or Ctrl+O may toggle the group's body.
          for (const point of [0, titleCol + 2, start - 1, end, f.terminal.columns - 1]) {
            const current = rowFor(f.terminal, title, ALPHA_LABEL)
            await click(f.terminal, point, current)
            assert.equal(controlCalls(f.backend).length, 0, `non-name column ${point} never navigates`)
            assert.deepEqual(editor.captureDraft(), draft)
            if (expanded) assert.match(f.terminal.screen(), /Alpha native result content/, 'non-name member clicks do not collapse the disclosure')
          }
          const nameRow = rowFor(f.terminal, title, ALPHA_LABEL)
          await click(f.terminal, columnFor(lines(f.terminal)[nameRow]!, ALPHA_LABEL) + 1, nameRow)
          await until(() => f.terminal.screen().includes(`Native child record view for ${ALPHA}`), 'name link opens the exact native sender child')
          assert.equal(f.app.store.items.some(item => JSON.stringify(item).includes('Native child record view')), false)
          f.terminal.type('\x1b'); await paint(f.terminal)
          assert.deepEqual(editor.captureDraft(), draft)
          f.backend.calls.length = 0
          if (expanded && !f.terminal.screen().includes('Alpha native result content')) { f.terminal.type('\x0f'); await paint(f.terminal) }
        }
        assert.equal(f.app.editor, editor)
        assert.equal(f.backend.sends + f.backend.cancels, 0)
      } finally { await f.close() }
    })
  }
}

for (const grouped of [false, true]) {
  test(`native catalog arrival/removal updates message name links without rewriting the record (grouped=${grouped})`, async () => {
    const f = await fixture({ groupTools: grouped, entries: [] })
    try {
      const stored = f.app.store.items.filter(item => item.kind === 'subagent-message')
      let row = rowFor(f.terminal, 'Task message received', ALPHA)
      let col = columnFor(lines(f.terminal)[row]!, ALPHA)
      assert.equal(Boolean(cell(f.terminal, row, col).isUnderline()), false)
      await click(f.terminal, col + 1, row)
      assert.equal(controlCalls(f.backend).length, 0)
      f.backend.catalog([child(ALPHA, ALPHA_LABEL)]); await paint(f.terminal)
      row = rowFor(f.terminal, 'Task message received', ALPHA_LABEL)
      col = columnFor(lines(f.terminal)[row]!, ALPHA_LABEL)
      assert.equal(Boolean(cell(f.terminal, row, col).isUnderline()), true)
      f.backend.catalog([]); await paint(f.terminal)
      row = rowFor(f.terminal, 'Task message received', ALPHA)
      col = columnFor(lines(f.terminal)[row]!, ALPHA)
      assert.equal(Boolean(cell(f.terminal, row, col).isUnderline()), false)
      await click(f.terminal, col + 1, row)
      assert.equal(controlCalls(f.backend).length, 0)
      assert.deepEqual(f.app.store.items.filter(item => item.kind === 'subagent-message'), stored)
    } finally { await f.close() }
  })

  test(`leaving a hovered sender name preserves native selection and copy (grouped=${grouped})`, async () => {
    const f = await fixture({ groupTools: grouped })
    try {
      const row = rowFor(f.terminal, 'Task message received', ALPHA_LABEL)
      const line = lines(f.terminal)[row]!, name = columnFor(line, ALPHA_LABEL)
      const start = columnFor(line, 'Task message received'), end = start + 'Task message received'.length - 1
      f.terminal.type(`\x1b[<35;${name + 2};${row + 1}M`); await paint(f.terminal)
      const offset = f.terminal.writes.length
      press(f.terminal, start, row); await paint(f.terminal)
      f.terminal.type(`\x1b[<32;${end + 1};${row + 1}M`); await paint(f.terminal)
      release(f.terminal, end, row); await paint(f.terminal)
      assert.equal(copyPacket(f.terminal, offset).trim(), 'Task message received')
      assert.equal(controlCalls(f.backend).length, 0)
    } finally { await f.close() }
  })

  test(`a non-name press cannot become child navigation after native label growth (grouped=${grouped})`, async () => {
    const short = child(ALPHA, 'Short')
    const f = await fixture({ groupTools: grouped, entries: [short] })
    try {
      const row = rowFor(f.terminal, 'Task message received', 'Short')
      const x = columnFor(lines(f.terminal)[row]!, 'Short') + 8
      press(f.terminal, x, row); await paint(f.terminal)
      const grown = 'A much longer native sender label'
      f.backend.catalog([{ ...short, label: grown }]); await paint(f.terminal)
      const newRow = rowFor(f.terminal, 'Task message received', grown)
      assert.equal(newRow, row)
      assert.ok(x > columnFor(lines(f.terminal)[newRow]!, grown))
      release(f.terminal, x, row); await paint(f.terminal)
      assert.equal(controlCalls(f.backend).length, 0, 'outside-press tombstone survives native reflow')
      await click(f.terminal, columnFor(lines(f.terminal)[row]!, grown) + 1, row)
      await until(() => f.terminal.screen().includes(`Native child record view for ${ALPHA}`), 'fresh name click still opens')
    } finally { await f.close() }
  })

  test(`removing and reintroducing a sender link permanently voids its old press (grouped=${grouped})`, async () => {
    const f = await fixture({ groupTools: grouped })
    try {
      const row = rowFor(f.terminal, 'Task message received', ALPHA_LABEL)
      const col = columnFor(lines(f.terminal)[row]!, ALPHA_LABEL) + 1
      press(f.terminal, col, row); await paint(f.terminal)
      f.backend.catalog([child(BETA, BETA_LABEL)]); await paint(f.terminal)
      f.backend.catalog([child(ALPHA, ALPHA_LABEL), child(BETA, BETA_LABEL)]); await paint(f.terminal)
      release(f.terminal, col, row); await paint(f.terminal)
      assert.equal(controlCalls(f.backend).length, 0, 'reappeared name cannot accept the old click')
      const fresh = rowFor(f.terminal, 'Task message received', ALPHA_LABEL)
      await click(f.terminal, columnFor(lines(f.terminal)[fresh]!, ALPHA_LABEL) + 1, fresh)
      await until(() => f.terminal.screen().includes(`Native child record view for ${ALPHA}`), 'a fresh sender link press is admitted')
    } finally { await f.close() }
  })
}

test('expanded subagent record bodies stay selectable after a hovered name and never navigate', async () => {
  const f = await fixture()
  try {
    f.terminal.type('copy-safe original draft')
    const editor = f.app.editor, draft = editor.captureDraft()
    f.terminal.type('\x0f'); await paint(f.terminal)
    const nameRow = rowFor(f.terminal, 'Task message received', ALPHA_LABEL)
    const name = columnFor(lines(f.terminal)[nameRow]!, ALPHA_LABEL)
    f.terminal.type(`\x1b[<35;${name + 2};${nameRow + 1}M`); await paint(f.terminal)
    const text = 'Alpha native result content'
    const body = lines(f.terminal).findIndex(line => line.includes(text))
    assert.ok(body >= 0)
    const start = columnFor(lines(f.terminal)[body]!, text), end = start + text.length - 1
    const offset = f.terminal.writes.length
    press(f.terminal, start, body); await paint(f.terminal)
    f.terminal.type(`\x1b[<32;${end + 1};${body + 1}M`); await paint(f.terminal)
    release(f.terminal, end, body); await paint(f.terminal)
    assert.equal(copyPacket(f.terminal, offset).trim(), text)
    await click(f.terminal, start + 2, body)
    assert.match(f.terminal.screen(), /Alpha native result content/, 'body clicks are not navigation or disclosure controls')
    assert.equal(controlCalls(f.backend).length, 0)
    assert.equal(f.app.editor, editor)
    assert.deepEqual(editor.captureDraft(), draft)
  } finally { await f.close() }
})

test('the original native catalog row also restricts navigation to its name', async () => {
  const f = await fixture({ entries: [child(ALPHA, ALPHA_LABEL, { catalogSeq: 1 })], events: [human('Native catalog anchor', 1)] })
  try {
    const row = rowFor(f.terminal, 'continuable', ALPHA_LABEL)
    const line = lines(f.terminal)[row]!, start = columnFor(line, ALPHA_LABEL), end = start + visibleWidth(ALPHA_LABEL)
    assert.equal(Boolean(cell(f.terminal, row, start).isUnderline()), true)
    for (const col of [0, start - 1, end, columnFor(line, 'continuable') + 1, columnFor(line, 'idle'), f.terminal.columns - 1]) {
      await click(f.terminal, col, row)
      assert.equal(controlCalls(f.backend).length, 0, `catalog-row non-name column ${col} cannot navigate`)
    }
    await click(f.terminal, start + 1, row)
    await until(() => f.terminal.screen().includes(`Native child record view for ${ALPHA}`), 'catalog name still opens the native child')
  } finally { await f.close() }
})
