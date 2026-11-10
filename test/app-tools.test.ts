import './helpers/truecolor.ts'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { visibleWidth } from '#pi-tui'
import { App } from '../src/app.ts'
import { defaults, type Settings } from '../src/config.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import type { Backend, BackendEvent, JsonRecord, SessionEvent, SessionInfo } from '../src/backend/types.ts'
import { isThinkingExpanded, thinkingExpansionKey } from '../src/ui/thinking-block.ts'
import { isToolExpanded, toolExpansionKey, toolGroupExpansionKey } from '../src/ui/tool-expansion.ts'
import { VirtualTerminal, delay, until } from './helpers/terminal.ts'

/** Test-only event source. No production adapter, tool body, model or clipboard is called. */
class ToolEventsBackend implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  readonly commands: Array<{ name: string; args?: JsonRecord }> = []
  readonly sent: string[] = []
  readonly responses: Array<{ id: string; value: unknown }> = []
  cancelCount = 0
  private sequence = 0
  private readonly listeners = new Set<(event: BackendEvent) => void>()
  info: SessionInfo
  constructor(cwd: string) {
    this.info = { sessionId: 'tools-acceptance', attachmentId: 'tools-attachment-a', cwd,
      provider: 'demo (offline)', model: 'tools-test', events: [],
      capabilities: ['state', 'commands', 'execute', 'auto-title', 'permissions'],
      permissions: { currentValue: 'default' },
    }
  }
  onEvent(listener: (event: BackendEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  emit(event: BackendEvent): void { for (const listener of this.listeners) listener(event) }
  async connect(): Promise<SessionInfo> {
    this.emit({ type: 'ready', info: this.info })
    this.emit({ type: 'status', sessionId: this.info.sessionId, status: 'idle' })
    return this.info
  }
  async send(text: string): Promise<void> { this.sent.push(text) }
  async cancel(): Promise<void> {
    this.cancelCount += 1
    this.durable('turn/end', { turn: 1, reason: { kind: 'cancelled' } })
    this.emit({ type: 'status', sessionId: this.info.sessionId, status: 'idle' })
  }
  async command(name: string, args?: JsonRecord): Promise<unknown> {
    this.commands.push({ name, args })
    if (name === 'state') return { queued: 0, pending: { nextTurn: 0, nextStep: 0 } }
    if (name === 'commands') return []
    if (name === 'auto-title') return { available: false }
    if (name === 'permissions') return { ...this.info.permissions, options: [{ value: 'default', label: 'Default' }, { value: 'full', label: 'Full' }] }
    if (name === 'reload') return { demo: true }
    return { available: true }
  }
  async respond(id: string, value: unknown): Promise<void> {
    this.responses.push({ id, value })
    this.emit({ type: 'decision_closed', sessionId: this.info.sessionId, id })
  }
  async close(): Promise<void> { this.emit({ type: 'closed', code: 0 }); this.listeners.clear() }
  durable(type: string, data: JsonRecord, extra: Partial<SessionEvent> = {}): SessionEvent {
    const event: SessionEvent = { type, seq: ++this.sequence, time: Date.now(), data, ...extra }
    this.info.events?.push(event)
    this.emit({ type: 'session_event', sessionId: this.info.sessionId, event })
    return event
  }
}

async function fixture(screen: 'inline' | 'fullscreen' = 'fullscreen', options: {
  settings?: Partial<Settings>; bindings?: JsonRecord; history?: number; columns?: number;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-tools-'))
  const settings = { ...defaults, showThinking: true, thinkingPreviewLines: 0, ...options.settings }
  await writeFile(join(directory, 'settings.json'), JSON.stringify(settings))
  if (options.bindings) await writeFile(join(directory, 'keybindings.json'), JSON.stringify(options.bindings))
  const terminal = new VirtualTerminal(options.columns ?? 80, 32)
  const backend = new ToolEventsBackend(directory), copies: string[] = []
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen, demo: true,
    registerSignals: false, copyText: async text => { copies.push(text) } })
  await app.start()
  await paint(terminal)
  if (options.history) backend.durable('user/message', { content: [{ type: 'text', text: Array.from({ length: options.history }, (_, index) => `preceding history ${index}`).join('\n') }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  return { app, backend, terminal, directory, copies, settings,
    async close() {
      try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
    },
  }
}

async function paint(terminal: VirtualTerminal): Promise<void> { await delay(35); await terminal.flush() }
function press(terminal: VirtualTerminal, x: number, y: number): void { terminal.type(`\x1b[<0;${x + 1};${y + 1}M`) }
function release(terminal: VirtualTerminal, x: number, y: number): void { terminal.type(`\x1b[<0;${x + 1};${y + 1}m`) }
async function click(terminal: VirtualTerminal, x: number, y: number): Promise<void> {
  press(terminal, x, y); await paint(terminal); release(terminal, x, y); await paint(terminal)
}
function cellFor(terminal: VirtualTerminal, label: string): { x: number; y: number } | undefined {
  const lines = terminal.screen().split('\n')
  for (let y = 0; y < lines.length; y++) {
    const offset = lines[y]!.indexOf(label)
    if (offset >= 0) return { x: visibleWidth(lines[y]!.slice(0, offset)), y }
  }
  return undefined
}
function requireCell(terminal: VirtualTerminal, label: string): { x: number; y: number } {
  const cell = cellFor(terminal, label)
  assert.ok(cell, `visible ${label}\n${terminal.screen()}`)
  return cell
}
function groupCell(terminal: VirtualTerminal): { x: number; y: number } {
  const lines = terminal.screen().split('\n')
  const y = lines.findIndex(line => /(?:Bash|Multiple Tools):/.test(line))
  assert.ok(y >= 0, terminal.screen())
  const line = lines[y]!, hint = line.indexOf('click')
  return { x: hint >= 0 ? visibleWidth(line.slice(0, hint)) + 3 : 4, y }
}
async function wheelUntil(terminal: VirtualTerminal, code: 64 | 65, condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 60 && !condition(); attempt++) {
    terminal.type(`\x1b[<${code};5;12M`)
    await paint(terminal)
  }
  assert.ok(condition(), terminal.screen())
}
function inverseCount(terminal: VirtualTerminal, rows: readonly number[]): number {
  const buffer = terminal.xterm.buffer.active
  let count = 0
  for (const y of rows) for (let x = 0; x < terminal.columns; x++) {
    if (buffer.getLine(buffer.viewportY + y)?.getCell(x)?.isInverse()) count += 1
  }
  return count
}

function addCall(backend: ToolEventsBackend, id: string, options: {
  name?: string; inputLines?: number; outputLines?: number; output?: string; settled?: boolean;
} = {}) {
  const name = options.name ?? 'bash'
  const command = [`INPUT-${id}`, ...Array.from({ length: options.inputLines ?? 12 }, (_, index) => `input-${id}-${index}`)].join('\n')
  const args = JSON.stringify({ command, description: `Inspect ${id}`, cwd: backend.info.cwd })
  const output = options.output ?? [`OUTPUT-${id}`, ...Array.from({ length: options.outputLines ?? 30 }, (_, index) => `result-${id}-${index}`)].join('\n')
  backend.durable('tool/call', { turn: 1, step: 1, callId: id, name, arguments: args }, {
    toolPresentation: { call: { card: 'terminal', title: command, cwd: backend.info.cwd } },
  })
  const result = (): void => {
    backend.durable('tool/result', { turn: 1, step: 1, message: { id: `result-${id}`, role: 'tool', toolCallId: id,
      content: [{ type: 'text', text: output }], isError: false, source: { kind: 'tool', callId: id } } }, {
      surfaceOp: 'append', toolPresentation: { result: { card: 'terminal', output, exitCode: 0 } },
    })
  }
  if (options.settled !== false) result()
  return { id, args, output, result }
}
function addThought(backend: ToolEventsBackend, text = 'THOUGHT-A\nTHOUGHT-B\nTHOUGHT-C'): string {
  const event = backend.durable('assistant/message', { turn: 1, step: 1,
    message: { id: 'thought-before-tools', role: 'assistant', content: [{ type: 'reasoning', text }], source: { kind: 'model', provider: 'demo', model: 'tools-test' } }, stream: [],
  }, { surfaceOp: 'append' })
  return `assistant:${event.seq}`
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`parent tools: real keyboard inspector preserves one editor and copies full sources (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      const output = 'OUTPUT-LARGE\n' + 'complete output 中文 '.repeat(1_500)
      const item = addCall(f.backend, 'large', { inputLines: 800, output })
      assert.ok(item.args.length > 8_000)
      assert.ok(item.output.length > 16_384)
      await paint(f.terminal)
      f.terminal.type('retained tools draft 中文 ')
      f.terminal.type('\x1b[200~paste one\npaste two\x1b[201~')
      f.terminal.type('\x02')
      const editor = f.app.editor, draft = editor.captureDraft()
      f.terminal.type('\x18'); f.terminal.type('\x0f'); await paint(f.terminal)
      assert.match(f.terminal.screen(), /┌─ Tools[\s\S]*?Bash/)
      assert.match(f.terminal.screen(), /OUTPUT-LARGE/)
      f.terminal.type('c'); await paint(f.terminal)
      assert.equal(f.copies[0], item.output, 'copy reaches the complete output source beyond 16k characters')
      f.terminal.type('\t'); await paint(f.terminal)
      f.terminal.type('c'); await paint(f.terminal)
      assert.equal(f.copies[1], item.args, 'copy reaches the exact model arguments beyond 8k characters')
      f.terminal.resize(40, 24); await paint(f.terminal)
      assert.match(f.terminal.screen(), /┌─ Tools/)
      f.terminal.type('\x1b'); await paint(f.terminal)
      assert.doesNotMatch(f.terminal.screen(), /┌─ Tools/)
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), draft)
      assert.equal(editor.focused, true)
      assert.deepEqual(f.backend.sent, [])
      assert.equal(f.backend.cancelCount, 0)
    } finally { await f.close() }
  })

  test(`parent tools: Tools settings apply hot, stay flat and preserve the draft (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      addCall(f.backend, 'setting-a'); addCall(f.backend, 'setting-b')
      await paint(f.terminal)
      f.terminal.type('settings retained draft')
      const editor = f.app.editor, draft = editor.captureDraft()
      await f.app.submit('/settings'); await paint(f.terminal)
      f.terminal.type('\x1b[C'); await paint(f.terminal)
      f.terminal.type('\x1b[C'); await paint(f.terminal)
      f.terminal.type('\r')
      assert.equal(f.app.store.items.filter(item => item.kind === 'tool').length, 2, 'the tool facts stay in the store')
      let saved: Record<string, unknown> = {}
      for (let attempt = 0; attempt < 100; attempt++) {
        saved = JSON.parse(await readFile(join(f.directory, 'settings.json'), 'utf8')) as Record<string, unknown>
        if (saved.groupTools === false) break
        await delay(10)
      }
      assert.equal(saved.groupTools, false)
      assert.equal(saved.expandedInputMaxLines, 5)
      assert.ok(!Object.hasOwn(saved, 'tools'))
      f.terminal.type('\x1b'); await paint(f.terminal)
      assert.doesNotMatch(f.terminal.screen(), /Bash: 2 done/)
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), draft)
      assert.equal(f.backend.commands.some(command => command.name === 'execute'), false)
    } finally { await f.close() }
  })
}

test('parent tools: bottom group expands/collapses repeatedly at the actual same hint point', async () => {
  const f = await fixture('fullscreen', { history: 80 })
  try {
    addCall(f.backend, 'bottom-a'); addCall(f.backend, 'bottom-b')
    await paint(f.terminal)
    const point = groupCell(f.terminal), key = toolGroupExpansionKey('bottom-a')
    assert.match(f.terminal.screen(), /├ ✓ Bash/)
    assert.match(f.terminal.screen(), /└ ✓ Bash/)
    for (let attempt = 0; attempt < 3; attempt++) {
      await click(f.terminal, point.x, point.y)
      assert.equal(isToolExpanded(key), true)
      assert.equal(groupCell(f.terminal).y, point.y, 'expansion keeps the clicked header under the pointer')
      assert.ok(requireCell(f.terminal, 'Back to bottom').y > point.y, 'follow affordance cannot overlap the group')
      await click(f.terminal, point.x, point.y)
      assert.equal(isToolExpanded(key), false)
      assert.equal(groupCell(f.terminal).y, point.y)
    }
  } finally { await f.close() }
})

test('parent tools: scrolled group body still collapses, while the first native drag selects', async () => {
  const f = await fixture()
  try {
    addCall(f.backend, 'select-a'); addCall(f.backend, 'select-b')
    await paint(f.terminal)
    const point = groupCell(f.terminal)
    f.terminal.type(`\x1b[<35;${point.x + 1};${point.y + 1}M`)
    await click(f.terminal, point.x, point.y)
    await wheelUntil(f.terminal, 65, () => Boolean(cellFor(f.terminal, 'OUTPUT-select-a')))
    const body = requireCell(f.terminal, 'OUTPUT-select-a')
    const before = inverseCount(f.terminal, [body.y, body.y + 1])
    press(f.terminal, body.x, body.y)
    f.terminal.type(`\x1b[<32;${body.x + 9};${body.y + 2}M`)
    await paint(f.terminal)
    assert.ok(inverseCount(f.terminal, [body.y, body.y + 1]) > before, 'the first drag already selected actual tool output cells')
    release(f.terminal, body.x + 8, body.y + 1); await paint(f.terminal)
    assert.equal(isToolExpanded(toolGroupExpansionKey('select-a')), true)
    await wheelUntil(f.terminal, 65, () => !cellFor(f.terminal, 'Bash:') && Boolean(cellFor(f.terminal, 'result-select-b-')))
    const tail = requireCell(f.terminal, 'result-select-b-')
    await click(f.terminal, tail.x + 3, tail.y)
    assert.equal(isToolExpanded(toolGroupExpansionKey('select-a')), false)
    await wheelUntil(f.terminal, 64, () => Boolean(cellFor(f.terminal, 'Bash:')))
    assert.match(f.terminal.screen(), /Bash: 2 done/)
  } finally { await f.close() }
})

test('parent tools: non-last group Output details never become Input and background clicks stay inert', async () => {
  const f = await fixture()
  try {
    const first = addCall(f.backend, 'io-first'), second = addCall(f.backend, 'io-last')
    await paint(f.terminal)
    const head = groupCell(f.terminal)
    await click(f.terminal, head.x, head.y)
    // Input and Output both overflow. The non-last member has the group's outer │.
    await wheelUntil(f.terminal, 65, () => Boolean(cellFor(f.terminal, 'OUTPUT-io-first')) && f.terminal.screen().split('\n').some(line => /more lines.*details/.test(line) && !/│\s*│/.test(line)))
    const lines = f.terminal.screen().split('\n')
    const outputRow = lines.findIndex(line => /more lines.*details/.test(line) && !/│\s*│/.test(line))
    assert.ok(outputRow >= 0, f.terminal.screen())
    const label = lines[outputRow]!, offset = label.indexOf('click')
    await click(f.terminal, visibleWidth(label.slice(0, offset)) + 3, outputRow)
    assert.match(f.terminal.screen(), /┌─ Tools[\s\S]*?Bash/)
    f.terminal.type('c'); await paint(f.terminal)
    assert.equal(f.copies[0], first.output)
    assert.notEqual(f.copies[0], first.args)
    assert.notEqual(f.copies[0], second.output)
    const key = toolGroupExpansionKey('io-first')
    assert.equal(isToolExpanded(key), true)
    await click(f.terminal, 0, 0)
    assert.equal(isToolExpanded(key), true)
    f.terminal.type('\x1b'); await paint(f.terminal)
    assert.doesNotMatch(f.terminal.screen(), /┌─ Tools/)
    assert.equal(isToolExpanded(key), true)
  } finally { await f.close() }
})

test('parent tools: a group header press remains bound through actual streaming row drift', async () => {
  const f = await fixture()
  try {
    const sessionId = f.backend.info.sessionId
    f.backend.emit({ type: 'stream_start', sessionId, attemptId: 'tools-drift', revision: 1, turn: 1, step: 1 })
    f.backend.emit({ type: 'stream_chunk', sessionId, attemptId: 'tools-drift', revision: 2, index: 0, time: Date.now(), chunk: { type: 'text-delta', index: 0, text: 'answer before tool group' } })
    addCall(f.backend, 'drift-a'); addCall(f.backend, 'drift-b')
    await paint(f.terminal)
    const point = groupCell(f.terminal)
    press(f.terminal, point.x, point.y)
    f.backend.emit({ type: 'stream_chunk', sessionId, attemptId: 'tools-drift', revision: 3, index: 1, time: Date.now(), chunk: { type: 'text-delta', index: 0, text: '\nadded streamed line one\nadded streamed line two\nadded streamed line three' } })
    await paint(f.terminal)
    assert.notEqual(groupCell(f.terminal).y, point.y, 'the painted group actually moved while held')
    release(f.terminal, point.x, point.y); await paint(f.terminal)
    assert.equal(isToolExpanded(toolGroupExpansionKey('drift-a')), true)
    const moved = groupCell(f.terminal)
    await click(f.terminal, moved.x, moved.y)
    assert.equal(isToolExpanded(toolGroupExpansionKey('drift-a')), false)
  } finally { await f.close() }
})

test('parent tools: Thinking and tool groups share follow anchoring without double-counting children', async () => {
  const f = await fixture()
  try {
    const thoughtId = addThought(f.backend)
    addCall(f.backend, 'coexist-a'); addCall(f.backend, 'coexist-b')
    await paint(f.terminal)
    const thought = requireCell(f.terminal, 'Thought')
    await click(f.terminal, thought.x + 2, thought.y)
    assert.equal(isThinkingExpanded(thinkingExpansionKey(thoughtId, 0)), true)
    const group = groupCell(f.terminal)
    await click(f.terminal, group.x, group.y)
    assert.equal(isToolExpanded(toolGroupExpansionKey('coexist-a')), true)
    assert.equal(isThinkingExpanded(thinkingExpansionKey(thoughtId, 0)), true, 'mouse tool accordion never silently closes Thinking')
    assert.equal(isToolExpanded(toolExpansionKey('coexist-a')), false, 'a group does not write child expansion overrides')
    const current = groupCell(f.terminal)
    await click(f.terminal, current.x, current.y)
    assert.ok(cellFor(f.terminal, 'Back to bottom'), 'closing tools must not restore follow while Thinking is open')
    const last = requireCell(f.terminal, 'Thought')
    await click(f.terminal, last.x + 2, last.y)
    assert.equal(isThinkingExpanded(thinkingExpansionKey(thoughtId, 0)), false)
    assert.equal(cellFor(f.terminal, 'Back to bottom'), undefined, 'last disclosure returns follow when the user has not scrolled')
  } finally { await f.close() }
})

test('parent tools: details refresh live, then native approval preempts without answering or losing a draft', async () => {
  const f = await fixture()
  try {
    const item = addCall(f.backend, 'pending', { settled: false })
    f.terminal.type('pending retained draft')
    const editor = f.app.editor, draft = editor.captureDraft()
    f.terminal.type('\x18'); f.terminal.type('\x0f'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /┌─ Tools/)
    assert.doesNotMatch(f.terminal.screen(), /OUTPUT-pending/)
    item.result(); await paint(f.terminal)
    assert.match(f.terminal.screen(), /OUTPUT-pending/)
    f.backend.emit({ type: 'decision', sessionId: f.backend.info.sessionId, request: {
      id: 'tools-priority-approval', kind: 'approval', title: 'Native tool permission',
      options: [{ label: 'Reject', value: 'rejected' }, { label: 'Allow once', value: 'allowed-once' }],
    } })
    await paint(f.terminal)
    assert.doesNotMatch(f.terminal.screen(), /┌─ Tools/)
    assert.match(f.terminal.screen(), /Native tool permission/)
    assert.deepEqual(f.backend.responses, [])
    assert.equal(f.app.editor, editor)
    assert.deepEqual(editor.captureDraft(), draft)
    f.terminal.type('\x1b'); await paint(f.terminal)
    assert.deepEqual(f.backend.responses, [{ id: 'tools-priority-approval', value: 'rejected' }])
  } finally { await f.close() }
})

test('parent tools: readonly details ignore disabled section fallbacks and idle Ctrl+C only closes', async () => {
  const f = await fixture('fullscreen', { bindings: { 'tool.details.previous-section': null } })
  try {
    addCall(f.backend, 'readonly')
    f.terminal.type('readonly draft')
    const editor = f.app.editor, draft = editor.captureDraft(), before = f.backend.commands.length
    f.terminal.type('\x18'); f.terminal.type('\x0f'); await paint(f.terminal)
    f.terminal.type('\x1b[Z'); f.terminal.type('\x0f'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /┌─ Tools/)
    assert.equal(f.backend.commands.slice(before).some(command => command.name === 'execute'), false)
    f.terminal.type('\x03'); await paint(f.terminal)
    assert.doesNotMatch(f.terminal.screen(), /┌─ Tools/)
    assert.equal(f.backend.cancelCount, 0)
    assert.equal(f.app.editor, editor)
    assert.deepEqual(editor.captureDraft(), draft)
  } finally { await f.close() }
})

test('parent tools: busy default Ctrl+C closes only the inspector and preserves root work/draft', async () => {
  const f = await fixture()
  try {
    addCall(f.backend, 'cancel', { settled: false })
    f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'running' })
    f.terminal.type('busy retained tools draft')
    const editor = f.app.editor, draft = editor.captureDraft()
    f.terminal.type('\x18'); f.terminal.type('\x0f'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /┌─ Tools/)
    f.terminal.type('\x03'); await paint(f.terminal)
    assert.equal(f.backend.cancelCount, 0)
    assert.equal(f.app.isBusy, true)
    assert.doesNotMatch(f.terminal.screen(), /┌─ Tools/)
    assert.equal(f.app.editor, editor)
    assert.deepEqual(editor.captureDraft(), draft)
    assert.equal(f.app.store.items.find(item => item.kind === 'tool')?.kind, 'tool')
  } finally { await f.close() }
})

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`parent tools: keyboard inspector can reach every earlier call without editing or executing (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      const first = addCall(f.backend, 'nav-first'), middle = addCall(f.backend, 'nav-middle'), last = addCall(f.backend, 'nav-last')
      f.terminal.type('all calls retained draft []')
      const editor = f.app.editor, draft = editor.captureDraft()
      f.terminal.type('\x18'); f.terminal.type('\x0f'); await paint(f.terminal)
      assert.match(f.terminal.screen(), /Tool 3\s*\/\s*3/)
      f.terminal.type('c'); await paint(f.terminal)
      assert.equal(f.copies.at(-1), last.output)
      f.terminal.type('['); await paint(f.terminal)
      assert.match(f.terminal.screen(), /Tool 2\s*\/\s*3/)
      f.terminal.type('c'); await paint(f.terminal)
      assert.equal(f.copies.at(-1), middle.output)
      f.terminal.type('\x1b[1;3D'); await paint(f.terminal)
      assert.match(f.terminal.screen(), /Tool 1\s*\/\s*3/)
      f.terminal.type('c'); await paint(f.terminal)
      assert.equal(f.copies.at(-1), first.output)
      f.terminal.type('['); await paint(f.terminal)
      assert.match(f.terminal.screen(), /Tool 1\s*\/\s*3/, 'left boundary does not wrap or execute anything')
      f.terminal.type(']'); await paint(f.terminal)
      f.terminal.type('\t'); await paint(f.terminal)
      f.terminal.type('c'); await paint(f.terminal)
      assert.equal(f.copies.at(-1), middle.args, 'navigation preserves the chosen Input/Output section')
      assert.deepEqual(f.backend.sent, [])
      assert.equal(f.backend.commands.some(command => command.name === 'execute'), false)
      f.terminal.type('\x1b'); await paint(f.terminal)
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), draft)
    } finally { await f.close() }
  })
}

test('parent tools: actual overlay mouse navigation selects one earlier call and survives a narrow resize', async () => {
  const f = await fixture()
  try {
    const first = addCall(f.backend, 'mouse-nav-first'), last = addCall(f.backend, 'mouse-nav-last')
    f.terminal.type('\x18'); f.terminal.type('\x0f'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /Tool 2\s*\/\s*2/)
    const prev = requireCell(f.terminal, 'Prev')
    await click(f.terminal, prev.x + 1, prev.y)
    assert.match(f.terminal.screen(), /Tool 1\s*\/\s*2/)
    f.terminal.type('c'); await paint(f.terminal)
    assert.equal(f.copies.at(-1), first.output)
    f.terminal.resize(40, 24); await paint(f.terminal)
    f.terminal.type(']'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /Tool 2\s*\/\s*2/)
    f.terminal.type('c'); await paint(f.terminal)
    assert.equal(f.copies.at(-1), last.output)
    f.terminal.type('\x1b'); await paint(f.terminal)
  } finally { await f.close() }
})

test('parent tools: an Output-detail press remains the same section when a hot setting moves its footer', async () => {
  const f = await fixture()
  try {
    const first = addCall(f.backend, 'footer-drift-a')
    addCall(f.backend, 'footer-drift-b')
    await paint(f.terminal)
    const head = groupCell(f.terminal)
    await click(f.terminal, head.x, head.y)
    const findOutputFooter = (): number => f.terminal.screen().split('\n').findIndex(line => /more lines.*details/.test(line) && !/│\s*│/.test(line))
    await wheelUntil(f.terminal, 65, () => Boolean(cellFor(f.terminal, 'OUTPUT-footer-drift-a')) && findOutputFooter() >= 0)
    const y = findOutputFooter(), line = f.terminal.screen().split('\n')[y]!
    const x = visibleWidth(line.slice(0, line.indexOf('click'))) + 3
    press(f.terminal, x, y)
    await writeFile(join(f.directory, 'settings.json'), JSON.stringify({ ...f.settings, expandedInputMaxLines: 20 }))
    await f.app.submit('/reload'); await paint(f.terminal)
    assert.notEqual(findOutputFooter(), y, 'a real preference repaint moved the Output row while held')
    release(f.terminal, x, y); await paint(f.terminal)
    assert.match(f.terminal.screen(), /┌─ Tools[\s\S]*?Bash/)
    f.terminal.type('c'); await paint(f.terminal)
    assert.equal(f.copies.at(-1), first.output, 'the pinned callId+Output target beats current row contents')
    f.terminal.type('\x1b'); await paint(f.terminal)
  } finally { await f.close() }
})

test('parent tools: deleting a pressed group or the inspected call leaves no stale target', async () => {
  const f = await fixture()
  try {
    addCall(f.backend, 'remove-a'); addCall(f.backend, 'remove-b')
    await paint(f.terminal)
    const point = groupCell(f.terminal)
    press(f.terminal, point.x, point.y)
    f.app.store.reset({ ...f.backend.info, events: [] })
    await paint(f.terminal)
    release(f.terminal, point.x, point.y); await paint(f.terminal)
    assert.equal(isToolExpanded(toolGroupExpansionKey('remove-a')), false)
    assert.doesNotMatch(f.terminal.screen(), /┌─ Tools/)
    addCall(f.backend, 'inspect-remove')
    f.terminal.type('\x18'); f.terminal.type('\x0f'); await paint(f.terminal)
    assert.match(f.terminal.screen(), /┌─ Tools/)
    f.app.store.reset({ ...f.backend.info, events: [] }); await paint(f.terminal)
    assert.doesNotMatch(f.terminal.screen(), /┌─ Tools/)
    assert.equal(f.app.editor.focused, true)
  } finally { await f.close() }
})
