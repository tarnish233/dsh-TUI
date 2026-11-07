import './helpers/truecolor.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TuiAltScreen, visibleWidth } from '#pi-tui'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, JsonRecord, SessionEvent, SessionInfo, SubagentEntry } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { delay, until, VirtualTerminal } from './helpers/terminal.ts'
import { imageFixture } from './helpers/images.ts'

/** A projection-only native fixture: observing progress never starts a child. */
class ProgressBackend implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  readonly calls: Array<{ name: string; args: JsonRecord }> = []
  readonly listeners = new Set<(event: BackendEvent) => void>()
  info: SessionInfo
  entries: readonly SubagentEntry[] = []
  sends = 0
  cancels = 0

  constructor(cwd: string, events: readonly SessionEvent[] = []) {
    this.info = {
      sessionId: 'progress-root', attachmentId: 'progress-attachment', cwd,
      provider: 'fixture', model: 'fixture-model',
      capabilities: ['commands', 'state', 'subagents', 'subagent-session', 'subagent-follow'],
      events: [...events],
    }
  }
  onEvent(listener: (event: BackendEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  emit(event: BackendEvent): void { for (const listener of this.listeners) listener(event) }
  async connect(): Promise<SessionInfo> { this.emit({ type: 'ready', info: this.info }); return this.info }
  async send(): Promise<void> { this.sends += 1 }
  async cancel(): Promise<void> { this.cancels += 1 }
  async respond(): Promise<void> { throw new Error('progress fixture never answers a decision') }
  async close(): Promise<void> {}
  async command(name: string, args: JsonRecord = {}): Promise<unknown> {
    this.calls.push({ name, args })
    if (name === 'commands') return []
    if (name === 'auto-title') return { available: false }
    if (name === 'state') return { pending: { nextTurn: 0, nextStep: 0 }, queued: 0, queue: [] }
    if (name === 'subagent-follow') return { sessionId: args.sessionId, follow: args.follow, supported: true }
    if (name === 'subagent-session') {
      const entry = this.entries.find(row => row.id === args.sessionId)
      assert.ok(entry && entry.local !== false && entry.mode !== 'external', 'only a local catalog member may be read')
      return {
        sessionId: entry.id, cwd: this.info.cwd,
        provider: 'fixture', model: 'fixture-child-model', capabilities: [],
        events: [userFact(`native durable child fact for ${entry.id}`, 1)],
      } satisfies SessionInfo
    }
    throw new Error('unexpected progress fixture control: ' + name)
  }
  catalog(entries: readonly SubagentEntry[], truncated = false): void {
    this.entries = entries
    this.emit({ type: 'subagents', sessionId: this.info.sessionId, value: { entries, ...(truncated ? { truncated: true } : {}) } })
  }
  upsert(entry: SubagentEntry): void {
    this.entries = this.entries.map(previous => previous.id === entry.id ? entry : previous)
    this.emit({ type: 'subagent', sessionId: this.info.sessionId, value: entry })
  }
  replace(info: SessionInfo): void {
    this.info = info
    this.entries = info.subagents?.entries ?? []
    this.emit({ type: 'ready', info })
  }
}

function userFact(text: string, seq: number): SessionEvent {
  return {
    type: 'user/message', seq, time: 1_750_000_000_000 + seq, surfaceOp: 'append',
    data: { id: `fixture-user-${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
  }
}

function child(id: string, overrides: Partial<SubagentEntry> = {}): SubagentEntry {
  return {
    id, parentSessionId: 'progress-root', mode: 'continuable', local: true,
    status: 'running', label: id, provider: 'fixture', model: 'child-model',
    ...overrides,
  }
}

async function paint(terminal: VirtualTerminal): Promise<void> { await delay(45); await terminal.flush() }

async function fixture(screen: 'inline' | 'fullscreen', history = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-app-progress-'))
  const events = history ? [userFact(Array.from({ length: 50 }, (_, index) => `root history ${index}`).join('\n'), 1)] : []
  const backend = new ProgressBackend(directory, events)
  const terminal = new VirtualTerminal(110, 38)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen, registerSignals: false })
  try {
    await app.start()
    await paint(terminal)
    return { app, backend, terminal, async close() {
      try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
    } }
  } catch (error) {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
    throw error
  }
}

const screenLines = (terminal: VirtualTerminal): string[] => terminal.screen().split('\n')
const headerRow = (terminal: VirtualTerminal): number => screenLines(terminal).findIndex(line => line.includes('● Agents'))
const agentsOverlayVisible = (terminal: VirtualTerminal): boolean => screenLines(terminal).some(line => /(?<!● )Agents ·/.test(line))
const agentRow = (terminal: VirtualTerminal, label: string): number => {
  const lines = screenLines(terminal)
  const header = headerRow(terminal)
  return lines.findIndex((line, index) => index > header && line.includes(label))
}
const press = (terminal: VirtualTerminal, x: number, y: number): void => terminal.type(`\x1b[<0;${x + 1};${y + 1}M`)
const release = (terminal: VirtualTerminal, x: number, y: number): void => terminal.type(`\x1b[<0;${x + 1};${y + 1}m`)
async function click(terminal: VirtualTerminal, x: number, y: number): Promise<void> {
  press(terminal, x, y); await paint(terminal)
  release(terminal, x, y); await paint(terminal)
}

/** Convert a string location to the real terminal columns (not UTF-16 offsets). */
function columnFor(line: string, text: string): number {
  const index = line.indexOf(text)
  assert.ok(index >= 0, `missing ${JSON.stringify(text)} in ${JSON.stringify(line)}`)
  return visibleWidth(line.slice(0, index))
}

function screenCell(terminal: VirtualTerminal, row: number, column: number) {
  const buffer = terminal.xterm.buffer.active
  const cell = buffer.getLine(buffer.viewportY + row)?.getCell(column)
  assert.ok(cell, `missing screen cell ${column},${row}`)
  return cell
}

/** The fake terminal captures OSC52; it never changes the real system clipboard. */
function selectedCopy(terminal: VirtualTerminal, offset: number): string {
  const packets = [...terminal.writes.slice(offset).join('').matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]+)\x07/g)]
  const encoded = packets.at(-1)?.[1]
  assert.equal(typeof encoded, 'string', 'native selection emitted a controlled clipboard packet')
  return Buffer.from(encoded!, 'base64').toString('utf8')
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`progress is a live Pi-style tree immediately above the one Editor (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      assert.equal(headerRow(f.terminal), -1, 'an empty catalog consumes no widget row')
      f.terminal.type('parent retained draft')
      const editor = f.app.editor
      const draft = editor.captureDraft()
      const rootCount = f.app.store.items.length
      const alpha = child('Alpha agent', {
        lastActivity: 'reading src/app.ts', totalTokens: 1200,
        timing: { settledMs: 9000 },
      })
      f.backend.catalog([alpha, child('Beta agent', { mode: 'one-shot', status: 'initializing' })])
      await paint(f.terminal)
      const lines = screenLines(f.terminal)
      const header = headerRow(f.terminal)
      const first = agentRow(f.terminal, 'Alpha agent')
      const prompt = lines.findIndex(line => line.includes('❯ parent retained draft'))
      assert.ok(header >= 0 && first > header && prompt > first, lines.join('\n'))
      assert.match(lines[first]!, /[├└]─/, 'the agent summary uses the supplied Pi tree style')
      assert.match(lines.slice(first + 1, prompt).join('\n'), /reading src\/app\.ts/, 'the next line carries native current activity')
      assert.match(lines[first]!, /running/)
      assert.match(lines[first]!, /1\.2k tok/)
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), draft)
      assert.equal(f.app.store.items.length, rootCount, 'unsequenced catalog progress creates no transcript facts')
      assert.equal(f.app.isBusy, false, 'a running child does not mark the root running')
      assert.equal(f.terminal.progress, false)
      assert.equal(f.backend.calls.some(call => call.name.startsWith('subagent')), false, 'rendering progress performs no native child read/control')

      f.backend.upsert({ ...alpha, lastActivity: 'checking a native fixture', totalTokens: 2400 })
      await paint(f.terminal)
      assert.match(f.terminal.screen(), /checking a native fixture/)
      assert.doesNotMatch(f.terminal.screen(), /reading src\/app\.ts/, 'old activity is replaced, not appended')
      f.backend.upsert({ ...alpha, status: 'idle', timing: { settledMs: 10000, lastTurnCompleted: true } })
      await paint(f.terminal)
      assert.equal(agentRow(f.terminal, 'Alpha agent'), -1, 'idle children retire from active progress')
      assert.equal(f.app.store.subagentEntry(alpha.id)?.status, 'idle', 'retirement leaves the native child catalog intact')
      assert.doesNotMatch(f.terminal.screen(), /reading src\/app\.ts|checking a native fixture/, 'idle children never show stale work as live')

      // The progress component never owns input. These printable control-like
      // letters still edit the root, rather than invoking a child action.
      f.terminal.type('rs')
      assert.equal(editor.getExpandedText(), 'parent retained draftrs')
      f.backend.catalog([])
      await paint(f.terminal)
      assert.equal(headerRow(f.terminal), -1)
      assert.doesNotMatch(f.terminal.screen(), /Alpha agent|Beta agent/)
      assert.equal(f.app.editor, editor)
      assert.equal(editor.getExpandedText(), 'parent retained draftrs')
      assert.equal(f.backend.sends + f.backend.cancels, 0)
    } finally { await f.close() }
  })

  test(`progress stays bounded and resize/multiline cannot displace the Editor (${screen})`, async () => {
    const f = await fixture(screen, true)
    try {
      f.terminal.type('retained draft')
      const editor = f.app.editor
      const entries = [
        ...Array.from({ length: 15 }, (_, index) => child(`Finished ${index}`, { mode: 'one-shot', status: 'completed', createdAt: index })),
        ...Array.from({ length: 4 }, (_, index) => child(`Active ${index}`, { createdAt: index + 20, lastActivity: `native work ${index}` })),
      ]
      f.backend.catalog(entries, true)
      await paint(f.terminal)
      const header = headerRow(f.terminal)
      const lines = screenLines(f.terminal)
      const prompt = lines.findIndex(line => line.includes('❯ retained draft'))
      assert.ok(header >= 0 && prompt > header && prompt - header <= 9, lines.join('\n'))
      assert.ok(lines.slice(header, prompt).some(line => line.includes('Active 0')), 'active work is not crowded out by old terminal children')
      assert.match(lines.slice(header, prompt).join('\n'), /native work 0/, 'Pi-style active detail outranks finished history')
      assert.match(lines.slice(header, prompt).join('\n'), /native work 1/, 'parallel active children retain their activity lines')
      assert.ok(lines.slice(header, prompt).filter(line => /Active [0-9]|Finished [0-9]/.test(line)).length < entries.length, 'overflow is bounded rather than a growing panel')

      for (const [columns, rows] of [[40, 18], [40, 12], [110, 38]] as const) {
        f.terminal.resize(columns, rows)
        await paint(f.terminal)
        assert.match(f.terminal.screen(), /retained draft/, `draft remains visible at ${columns}×${rows}`)
        assert.equal(f.app.editor, editor)
        assert.equal(editor.getExpandedText(), 'retained draft')
      }
      f.terminal.resize(40, 18)
      const multiline = '\n' + Array.from({ length: 10 }, (_, index) => `draft line ${index}`).join('\n') + '\nlast draft line'
      // A large bracketed paste is intentionally an atomic collapsed marker.
      // Exercise actual Editor height growth with normal Ctrl+J/typing instead.
      for (const line of multiline.slice(1).split('\n')) {
        f.terminal.type('\x0a')
        f.terminal.type(line)
      }
      await paint(f.terminal)
      assert.equal(editor.getExpandedText(), 'retained draft' + multiline)
      assert.match(f.terminal.screen(), /last draft line/, 'growing input, not the widget, retains the focused cursor tail')
      f.terminal.resize(110, 38)
      await paint(f.terminal)
      assert.equal(editor.getExpandedText(), 'retained draft' + multiline)
      assert.equal(f.backend.calls.some(call => call.name.startsWith('subagent')), false)
    } finally { await f.close() }
  })
}

test('fullscreen progress click opens the exact child and Esc returns directly to the unchanged Editor', async () => {
  const f = await fixture('fullscreen')
  try {
    f.terminal.type('same root draft')
    const editor = f.app.editor
    const image = await imageFixture()
    editor.insertImage(image.upload)
    const draft = editor.captureDraft()
    f.backend.catalog([child('Clickable agent', { lastActivity: 'native current operation' })])
    await paint(f.terminal)
    const row = agentRow(f.terminal, 'Clickable agent')
    assert.ok(row >= 0)
    const col = screenLines(f.terminal)[row]!.indexOf('Clickable agent') + 2
    await click(f.terminal, col, row)
    await until(() => f.terminal.screen().includes('native durable child fact for Clickable agent'), 'progress opens the native child snapshot')
    assert.deepEqual(f.backend.calls.filter(call => call.name.startsWith('subagent')), [
      { name: 'subagent-follow', args: { sessionId: 'Clickable agent', follow: true } },
      { name: 'subagent-session', args: { sessionId: 'Clickable agent' } },
    ])
    assert.equal(f.app.store.items.some(item => JSON.stringify(item).includes('native durable child fact')), false)
    f.terminal.type('\x1b')
    await paint(f.terminal)
    assert.doesNotMatch(f.terminal.screen(), /native durable child fact/)
    assert.equal(headerRow(f.terminal) >= 0, true)
    assert.equal(f.app.editor, editor)
    assert.deepEqual(editor.captureDraft(), draft)
    assert.equal(f.backend.calls.at(-1)?.name, 'subagent-follow')
    assert.equal(f.backend.calls.at(-1)?.args.follow, false)
    assert.equal(f.backend.cancels, 0, 'Esc is close, not interrupt')
    const reopenedRow = agentRow(f.terminal, 'Clickable agent')
    await click(f.terminal, screenLines(f.terminal)[reopenedRow]!.indexOf('Clickable agent') + 2, reopenedRow)
    await until(() => f.backend.calls.filter(call => call.name === 'subagent-session').length === 2, 'Esc immediately restores progress mouse actions without typing or native frames')
    assert.deepEqual(editor.captureDraft(), draft, 'reopening also preserves the same image-bearing draft')
  } finally { await f.close() }
})

test('fullscreen progress header opens Agents while the progress remains outside the scrolling transcript', async () => {
  const f = await fixture('fullscreen', true)
  try {
    f.terminal.type('scroll-safe draft')
    f.backend.catalog([child('Pinned progress agent', { lastActivity: 'native work' })])
    await paint(f.terminal)
    assert.ok(f.app.tui instanceof TuiAltScreen)
    const before = headerRow(f.terminal)
    assert.ok(before >= 0)
    f.app.tui.scrollBy(-10)
    await paint(f.terminal)
    assert.equal(headerRow(f.terminal), before, 'progress is pinned above the prompt, not inside scrollback')
    assert.match(f.terminal.screen(), /Back to bottom/)
    const draft = f.app.editor.captureDraft()
    const row = headerRow(f.terminal)
    const col = screenLines(f.terminal)[row]!.indexOf('Agents') + 2
    await click(f.terminal, col, row)
    await until(() => agentsOverlayVisible(f.terminal), 'header opens the existing list')
    f.terminal.type('\x1b')
    await paint(f.terminal)
    assert.deepEqual(f.app.editor.captureDraft(), draft)
    assert.equal(f.backend.calls.some(call => call.name.startsWith('subagent')), false, 'the list header itself never reads/resumes a child')
    const childRow = agentRow(f.terminal, 'Pinned progress agent')
    await click(f.terminal, screenLines(f.terminal)[childRow]!.indexOf('Pinned progress agent') + 2, childRow)
    await until(() => f.terminal.screen().includes('native durable child fact for Pinned progress agent'), 'closing Agents immediately re-enables the progress row')
  } finally { await f.close() }
})

test('fullscreen external history stays in /agent and cannot open a local child transcript', async () => {
  const f = await fixture('fullscreen')
  try {
    f.backend.catalog([child('External task', { mode: 'external', status: 'external', local: false })])
    await paint(f.terminal)
    assert.equal(headerRow(f.terminal), -1, 'external history does not hold open active progress')
    assert.doesNotMatch(f.terminal.screen(), /External task/)
    await f.app.submit('/agent'); await paint(f.terminal)
    assert.equal(agentsOverlayVisible(f.terminal), true)
    const row = screenLines(f.terminal).findIndex(line => line.includes('External task'))
    assert.ok(row >= 0)
    await click(f.terminal, screenLines(f.terminal)[row]!.indexOf('External task') + 2, row)
    assert.equal(f.backend.calls.some(call => call.name.startsWith('subagent')), false)
    assert.match(f.terminal.screen(), /external/)
    assert.equal(agentsOverlayVisible(f.terminal), true)
  } finally { await f.close() }
})

test('fullscreen removal, reappearance and attachment replacement cannot retarget a progress press', async () => {
  for (const scenario of ['removed', 'replaced', 'reappeared', 'remaining'] as const) {
    const f = await fixture('fullscreen')
    try {
      const pressed = child('Pressed child', { lastActivity: 'old native work' })
      const remaining = child('Remaining child', { lastActivity: 'other native work' })
      f.backend.catalog([pressed, remaining])
      await paint(f.terminal)
      const row = agentRow(f.terminal, 'Pressed child')
      const col = screenLines(f.terminal)[row]!.indexOf('Pressed child') + 2
      press(f.terminal, col, row)
      await paint(f.terminal)
      if (scenario === 'replaced') {
        f.backend.replace({ ...f.backend.info, attachmentId: 'new-attachment', subagents: { entries: [child('Pressed child', { lastActivity: 'new attachment work' })] } })
      } else if (scenario === 'remaining') f.backend.catalog([remaining])
      else f.backend.catalog([])
      await paint(f.terminal)
      if (scenario === 'reappeared') {
        f.backend.catalog([{ ...pressed, lastActivity: 'reappeared native work' }])
        await paint(f.terminal)
      }
      release(f.terminal, col, row)
      await paint(f.terminal)
      assert.equal(f.backend.calls.some(call => call.name.startsWith('subagent')), false, `stale ${scenario} gesture cannot read another/native-replaced child`)
    } finally { await f.close() }
  }
})

test('progress ignores foreign-root frames and clears on an explicit native session replacement', async () => {
  const f = await fixture('fullscreen')
  try {
    f.backend.catalog([child('Current child', { lastActivity: 'current native work' })])
    await paint(f.terminal)
    f.backend.emit({ type: 'subagent', sessionId: 'foreign-root', value: child('Foreign child') })
    await paint(f.terminal)
    assert.doesNotMatch(f.terminal.screen(), /Foreign child/)
    f.backend.replace({ ...f.backend.info, sessionId: 'replacement-root', attachmentId: 'replacement-attachment', subagents: { entries: [] } })
    await paint(f.terminal)
    assert.equal(headerRow(f.terminal), -1)
    f.backend.emit({ type: 'subagent', sessionId: 'progress-root', value: child('Late old child') })
    await paint(f.terminal)
    assert.doesNotMatch(f.terminal.screen(), /Late old child|Current child/)
    assert.equal(f.backend.calls.some(call => call.name.startsWith('subagent')), false)
  } finally { await f.close() }
})

test('fullscreen progress overflow opens the full Agents tree without reading a hidden child', async () => {
  const f = await fixture('fullscreen')
  try {
    f.terminal.type('overflow-safe draft')
    const draft = f.app.editor.captureDraft()
    f.backend.catalog([
      ...Array.from({ length: 12 }, (_, index) => child(`Finished ${index}`, { mode: 'one-shot', status: 'completed' })),
      ...Array.from({ length: 6 }, (_, index) => child(`Working ${index}`, { lastActivity: `native activity ${index}` })),
    ])
    await paint(f.terminal)
    const lines = screenLines(f.terminal)
    const row = lines.findIndex(line => /\+[0-9]+ more/.test(line))
    assert.ok(row > headerRow(f.terminal), lines.join('\n'))
    await click(f.terminal, lines[row]!.indexOf('+') + 2, row)
    await until(() => agentsOverlayVisible(f.terminal), 'overflow opens the full tree')
    assert.equal(f.backend.calls.some(call => call.name.startsWith('subagent')), false)
    f.terminal.type('\x1b')
    await paint(f.terminal)
    assert.deepEqual(f.app.editor.captureDraft(), draft)
  } finally { await f.close() }
})

test('a native decision blocks underlying progress mouse actions until it closes', async () => {
  const f = await fixture('fullscreen')
  try {
    f.backend.catalog([child('Decision-blocked child', { lastActivity: 'waiting on a native decision' })])
    f.backend.emit({
      type: 'decision', sessionId: f.backend.info.sessionId,
      request: {
        id: 'progress-decision', kind: 'approval', title: 'Native fixture approval',
        options: [{ label: 'Allow once', value: 'allowed-once' }, { label: 'Reject', value: 'rejected' }],
      },
    })
    await until(() => f.app.pendingDecisionCount === 1, 'the native decision owns focus')
    await paint(f.terminal)
    const row = agentRow(f.terminal, 'Decision-blocked child')
    assert.ok(row > headerRow(f.terminal))
    await click(f.terminal, screenLines(f.terminal)[row]!.indexOf('Decision-blocked child') + 2, row)
    assert.equal(f.backend.calls.some(call => call.name.startsWith('subagent')), false, 'progress never steals an approval')
    assert.equal(f.app.pendingDecisionCount, 1)
    f.backend.emit({ type: 'decision_closed', sessionId: f.backend.info.sessionId, id: 'progress-decision' })
    await until(() => f.app.pendingDecisionCount === 0, 'the native decision closes')
    await paint(f.terminal)
    const next = agentRow(f.terminal, 'Decision-blocked child')
    await click(f.terminal, screenLines(f.terminal)[next]!.indexOf('Decision-blocked child') + 2, next)
    await until(() => f.terminal.screen().includes('native durable child fact for Decision-blocked child'), 'progress becomes clickable after the decision closes')
  } finally { await f.close() }
})

test('fullscreen native transcript child row remains clickable alongside the pinned progress widget', async () => {
  const f = await fixture('fullscreen', true)
  try {
    f.terminal.type('anchored-row draft')
    const draft = f.app.editor.captureDraft()
    f.backend.catalog([child('Anchored native child', { catalogSeq: 1, lastActivity: 'native current work' })])
    await paint(f.terminal)
    const lines = screenLines(f.terminal)
    const header = headerRow(f.terminal)
    const row = lines.findIndex((line, index) => index < header && line.includes('Anchored native child'))
    assert.ok(row >= 0 && header > row, lines.join('\n'))
    assert.equal(f.app.store.items.some(item => item.kind === 'subagent' && item.entry.id === 'Anchored native child'), true)
    await click(f.terminal, lines[row]!.indexOf('Anchored native child') + 2, row)
    await until(() => f.terminal.screen().includes('native durable child fact for Anchored native child'), 'the original transcript click still opens the native child')
    f.terminal.type('\x1b')
    await paint(f.terminal)
    assert.deepEqual(f.app.editor.captureDraft(), draft)
    assert.equal(agentsOverlayVisible(f.terminal), false, 'direct transcript navigation returns to the Editor')
    assert.equal(headerRow(f.terminal) >= 0, true)
  } finally { await f.close() }
})

test('fullscreen progress only the agent name is a styled navigation link', async () => {
  const f = await fixture('fullscreen')
  try {
    f.terminal.type('name-only retained draft')
    const draft = f.app.editor.captureDraft()
    f.backend.catalog([child('Link-only child', { lastActivity: 'native activity words', totalTokens: 1200, timing: { settledMs: 9000 } })])
    await paint(f.terminal)
    const lines = screenLines(f.terminal)
    const row = agentRow(f.terminal, 'Link-only child')
    const start = columnFor(lines[row]!, 'Link-only child')
    const end = start + visibleWidth('Link-only child')
    assert.equal(Boolean(screenCell(f.terminal, row, start).isUnderline()), true, 'the actual VT underlines the name')
    assert.equal(Boolean(screenCell(f.terminal, row, start).isBold()), true)
    assert.equal(Boolean(screenCell(f.terminal, row, end).isUnderline()), false, 'the gap after the name is not part of the link')
    assert.equal(Boolean(screenCell(f.terminal, row, columnFor(lines[row]!, 'running')).isUnderline()), false)
    const activity = lines.findIndex((line, index) => index > row && line.includes('native activity words'))
    const points = [
      [0, row], [start - 2, row], [start - 1, row], [end, row],
      [columnFor(lines[row]!, 'continuable') + 1, row],
      [columnFor(lines[row]!, 'running') + 1, row],
      [columnFor(lines[row]!, '9s'), row],
      [columnFor(lines[row]!, '1.2k tok') + 1, row],
      [columnFor(lines[row]!, 'fixture/child-model') + 2, row],
      [f.terminal.columns - 1, row],
      [columnFor(lines[activity]!, 'native activity words') + 2, activity],
    ]
    for (const [x, y] of points) {
      await click(f.terminal, x!, y!)
      assert.equal(f.backend.calls.some(call => call.name.startsWith('subagent')), false, `non-name cell ${x},${y} does not navigate`)
      assert.equal(agentsOverlayVisible(f.terminal), false)
      assert.deepEqual(f.app.editor.captureDraft(), draft)
    }
    await click(f.terminal, start + 2, row)
    await until(() => f.terminal.screen().includes('native durable child fact for Link-only child'), 'the name link opens the child')
    f.terminal.type('\x1b'); await paint(f.terminal)
    assert.deepEqual(f.app.editor.captureDraft(), draft)
  } finally { await f.close() }
})

test('fullscreen Agents and overflow links exclude glyphs, counts, hints and padding', async () => {
  const f = await fixture('fullscreen')
  try {
    f.terminal.type('literal links draft')
    const draft = f.app.editor.captureDraft()
    f.backend.catalog([
      ...Array.from({ length: 12 }, (_, index) => child(`Settled ${index}`, { status: 'completed', mode: 'one-shot' })),
      ...Array.from({ length: 6 }, (_, index) => child(`Working ${index}`, { lastActivity: `native work ${index}` })),
    ])
    await paint(f.terminal)
    const lines = screenLines(f.terminal)
    const header = headerRow(f.terminal)
    const heading = lines[header]!
    const titleStart = columnFor(heading, 'Agents')
    const overflow = lines.findIndex(line => /\+[0-9]+ more/.test(line))
    assert.ok(overflow > header)
    const label = /\+[0-9]+ more/.exec(lines[overflow]!)?.[0]
    assert.ok(label)
    const moreStart = columnFor(lines[overflow]!, label)
    assert.equal(Boolean(screenCell(f.terminal, header, titleStart).isUnderline()), true)
    assert.equal(Boolean(screenCell(f.terminal, overflow, moreStart).isUnderline()), true)
    const points = [
      [0, header], [titleStart - 1, header], [titleStart + 6, header],
      [columnFor(heading, 'children') + 2, header],
      [columnFor(heading, 'Ctrl+X') + 1, header], [f.terminal.columns - 1, header],
      [0, overflow], [moreStart - 1, overflow], [moreStart + label.length, overflow],
      [columnFor(lines[overflow]!, 'running') + 1, overflow], [f.terminal.columns - 1, overflow],
    ]
    for (const [x, y] of points) {
      await click(f.terminal, x!, y!)
      assert.equal(agentsOverlayVisible(f.terminal), false, `non-link title/overflow cell ${x},${y} is inert`)
    }
    await click(f.terminal, titleStart + 2, header)
    await until(() => agentsOverlayVisible(f.terminal), 'the Agents word opens the list')
    f.terminal.type('\x1b'); await paint(f.terminal)
    const nextLines = screenLines(f.terminal)
    const nextOverflow = nextLines.findIndex(line => /\+[0-9]+ more/.test(line))
    await click(f.terminal, columnFor(nextLines[nextOverflow]!, '+') + 2, nextOverflow)
    await until(() => agentsOverlayVisible(f.terminal), 'the overflow text opens the list')
    f.terminal.type('\x1b'); await paint(f.terminal)
    assert.deepEqual(f.app.editor.captureDraft(), draft)
    assert.equal(f.backend.calls.some(call => call.name.startsWith('subagent')), false)
  } finally { await f.close() }
})

test('native selection and copy survive leaving a hovered name and crossing link boundaries', async () => {
  const f = await fixture('fullscreen')
  try {
    f.terminal.type('selection-safe draft')
    const draft = f.app.editor.captureDraft()
    f.backend.catalog([child('Selection child', { lastActivity: 'native selection words', totalTokens: 1200 })])
    await paint(f.terminal)
    assert.ok(f.app.tui instanceof TuiAltScreen)
    const lines = screenLines(f.terminal)
    const row = agentRow(f.terminal, 'Selection child')
    const nameStart = columnFor(lines[row]!, 'Selection child')
    const activity = lines.findIndex((line, index) => index > row && line.includes('native selection words'))
    const ranges = [
      { row, start: columnFor(lines[row]!, 'running'), end: columnFor(lines[row]!, 'running') + 'running'.length - 1, expected: 'running' },
      { row: activity, start: columnFor(lines[activity]!, 'native selection words'), end: columnFor(lines[activity]!, 'native selection words') + 'native selection words'.length - 1, expected: 'native selection words' },
    ]
    for (const range of ranges) {
      f.app.tui.resetTextSelection()
      f.terminal.type(`\x1b[<35;${nameStart + 2};${row + 1}M`)
      await paint(f.terminal)
      const offset = f.terminal.writes.length
      press(f.terminal, range.start, range.row); await paint(f.terminal)
      f.terminal.type(`\x1b[<32;${range.end + 1};${range.row + 1}M`)
      await paint(f.terminal)
      assert.equal(f.app.tui.hasActiveSelection(), true, 'the first drag after hovering a name reaches native selection')
      release(f.terminal, range.end, range.row); await paint(f.terminal)
      assert.equal(f.app.tui.hasActiveSelection(), true)
      assert.equal(selectedCopy(f.terminal, offset).trim(), range.expected)
      assert.equal(f.backend.calls.some(call => call.name.startsWith('subagent')), false)
    }
    f.app.tui.resetTextSelection()
    const offset = f.terminal.writes.length
    const tokenEnd = columnFor(lines[row]!, 'tok') + 2
    press(f.terminal, tokenEnd, row); await paint(f.terminal)
    f.terminal.type(`\x1b[<32;${nameStart + 2};${row + 1}M`)
    await paint(f.terminal)
    assert.equal(f.app.tui.hasActiveSelection(), true, 'a drag started in metrics may cross into the name')
    release(f.terminal, nameStart + 1, row); await paint(f.terminal)
    assert.equal(f.app.tui.hasActiveSelection(), true)
    assert.match(selectedCopy(f.terminal, offset), /running/)
    assert.equal(f.backend.calls.some(call => call.name.startsWith('subagent')), false)
    assert.deepEqual(f.app.editor.captureDraft(), draft)
  } finally { await f.close() }
})

test('a press outside the name stays non-navigation across label growth and reattachment', async () => {
  for (const reattach of [false, true]) {
    const f = await fixture('fullscreen')
    try {
      const entry = child('outside-reflow-child', { label: 'Short', lastActivity: 'native work' })
      f.backend.catalog([entry]); await paint(f.terminal)
      const row = agentRow(f.terminal, 'Short')
      const x = columnFor(screenLines(f.terminal)[row]!, 'Short') + 'Short'.length + 4
      press(f.terminal, x, row); await paint(f.terminal)
      const grown = 'A much longer visible agent name'
      if (reattach) f.backend.replace({ ...f.backend.info, attachmentId: 'outside-press-new-attachment', subagents: { entries: [{ ...entry, label: grown }] } })
      else f.backend.upsert({ ...entry, label: grown })
      await paint(f.terminal)
      const updated = screenLines(f.terminal)[row]!
      const start = columnFor(updated, grown)
      assert.ok(x >= start && x < start + visibleWidth(grown), 'the new name actually moved under the old press coordinate')
      release(f.terminal, x, row); await paint(f.terminal)
      assert.equal(f.backend.calls.some(call => call.name.startsWith('subagent')), false, `outside press does not navigate after ${reattach ? 'reattach' : 'reflow'}`)
      await click(f.terminal, start + 1, row)
      await until(() => f.terminal.screen().includes('native durable child fact for outside-reflow-child'), 'a fresh name press still navigates')
    } finally { await f.close() }
  }
})

test('dragging a claimed name does not turn the drag into child navigation', async () => {
  const f = await fixture('fullscreen')
  try {
    f.backend.catalog([child('Dragged name', { lastActivity: 'native work' })]); await paint(f.terminal)
    const row = agentRow(f.terminal, 'Dragged name')
    const line = screenLines(f.terminal)[row]!
    const start = columnFor(line, 'Dragged name')
    const end = columnFor(line, 'running') + 2
    press(f.terminal, start + 1, row); await paint(f.terminal)
    f.terminal.type(`\x1b[<32;${end + 1};${row + 1}M`); await paint(f.terminal)
    release(f.terminal, end, row); await paint(f.terminal)
    assert.equal(f.backend.calls.some(call => call.name.startsWith('subagent')), false)
    assert.equal(agentsOverlayVisible(f.terminal), false)
  } finally { await f.close() }
})

test('CJK and emoji name-link boundaries use visible terminal columns', async () => {
  const f = await fixture('fullscreen')
  try {
    const label = '探索 👩‍💻 café'
    f.backend.catalog([child('unicode-link-child', { label, lastActivity: 'native work' })]); await paint(f.terminal)
    const row = agentRow(f.terminal, label)
    const line = screenLines(f.terminal)[row]!
    const start = columnFor(line, label)
    const end = start + visibleWidth(label)
    assert.notEqual(visibleWidth(label), label.length, 'the fixture really differs from UTF-16 length')
    assert.equal(Boolean(screenCell(f.terminal, row, end - 1).isUnderline()), true)
    assert.equal(Boolean(screenCell(f.terminal, row, end).isUnderline()), false)
    await click(f.terminal, end, row)
    assert.equal(f.backend.calls.some(call => call.name.startsWith('subagent')), false)
    await click(f.terminal, start + 1, row)
    await until(() => f.terminal.screen().includes('native durable child fact for unicode-link-child'), 'clicking the wide name cell opens its child')
  } finally { await f.close() }
})

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`settled children leave progress but remain available through /agent and native reactivation (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.terminal.type('history navigation draft')
      const editor = f.app.editor, draft = editor.captureDraft()
      const active = child('History child', { lastActivity: 'native current activity', lastRunId: 'first-run' })
      f.backend.catalog([active]); await paint(f.terminal)
      assert.ok(headerRow(f.terminal) >= 0)
      const finished = { ...active, status: 'idle' as const, lastStopReason: 'completed', timing: { settledMs: 8000, lastTurnCompleted: true } }
      f.backend.upsert(finished); await paint(f.terminal)
      assert.equal(headerRow(f.terminal), -1, 'the settled child no longer consumes above-editor progress space')
      assert.doesNotMatch(f.terminal.screen(), /History child|native current activity/)
      assert.deepEqual(f.app.store.subagentEntries, [finished], 'retirement changes display only, not the native catalog')
      assert.equal(f.backend.calls.some(call => call.name.startsWith('subagent')), false, 'retirement performs no child command')

      await f.app.submit('/agent'); await paint(f.terminal)
      assert.equal(agentsOverlayVisible(f.terminal), true)
      assert.match(f.terminal.screen(), /History child/)
      assert.equal(f.backend.calls.some(call => call.name.startsWith('subagent')), false, '/agent opens the native catalog without child reads')
      f.terminal.type('\r')
      await until(() => f.terminal.screen().includes('native durable child fact for History child'), 'settled native child remains readable from /agent')
      f.terminal.type('\x1b'); await paint(f.terminal)
      assert.equal(agentsOverlayVisible(f.terminal), true)
      f.terminal.type('\x1b'); await paint(f.terminal)
      assert.equal(headerRow(f.terminal), -1)
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), draft)

      f.backend.upsert({ ...active, lastRunId: 'second-run', lastActivity: 'native reactivated activity' }); await paint(f.terminal)
      assert.ok(headerRow(f.terminal) >= 0, 'native reactivation returns the same child to progress')
      assert.match(f.terminal.screen(), /native reactivated activity/)
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), draft)
      assert.equal(f.backend.sends + f.backend.cancels, 0)
    } finally { await f.close() }
  })
}

test('settlement retires progress without closing a manually opened child conversation', async () => {
  const f = await fixture('fullscreen')
  try {
    f.terminal.type('read final output draft')
    const editor = f.app.editor, draft = editor.captureDraft()
    const active = child('Finishing viewed child', { lastActivity: 'native work' })
    f.backend.catalog([active]); await paint(f.terminal)
    const row = agentRow(f.terminal, active.id)
    await click(f.terminal, columnFor(screenLines(f.terminal)[row]!, active.id) + 1, row)
    await until(() => f.terminal.screen().includes('native durable child fact for Finishing viewed child'), 'child opened before settlement')
    f.backend.upsert({ ...active, status: 'idle', lastStopReason: 'completed', timing: { settledMs: 9000, lastTurnCompleted: true } })
    await paint(f.terminal)
    assert.match(f.terminal.screen(), /native durable child fact for Finishing viewed child/, 'the final conversation remains readable')
    assert.match(f.terminal.screen(), /idle/, 'the viewed child header receives native settlement')
    assert.equal(f.backend.calls.some(call => call.name === 'subagent-follow' && call.args.follow === false), false, 'settlement does not unfollow the user-owned view')
    f.terminal.type('\x1b'); await paint(f.terminal)
    assert.equal(headerRow(f.terminal), -1)
    assert.deepEqual(editor.captureDraft(), draft)
    assert.equal(f.app.editor, editor)
    assert.equal(f.app.store.subagentEntries.length, 1)
  } finally { await f.close() }
})

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`live child progress shares Working frames while the root remains ready (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.terminal.type('animation retained draft')
      const editor = f.app.editor, draft = editor.captureDraft()
      const active = child('Alpha spinner', { lastActivity: 'native spinning activity' })
      const initializing = child('Beta spinner', { status: 'initializing' })
      f.backend.catalog([active, initializing]); await paint(f.terminal)
      const frame = (label: string): string => {
        const row = agentRow(f.terminal, label)
        assert.ok(row >= 0)
        const start = columnFor(screenLines(f.terminal)[row]!, label)
        return screenCell(f.terminal, row, start - 2).getChars()
      }
      const family = new Set(['·', '✻', '✶', '✳'])
      const observed = new Set([frame('Alpha spinner')])
      const deadline = Date.now() + 1500
      while (observed.size < 2 && Date.now() < deadline) {
        await delay(110); await paint(f.terminal)
        observed.add(frame('Alpha spinner'))
      }
      assert.ok(observed.size >= 2, 'native terminal cells visibly animate without another backend event')
      assert.ok([...observed].every(glyph => family.has(glyph)), 'uses the existing Working glyph family')
      assert.equal(frame('Beta spinner'), frame('Alpha spinner'), 'initializing/running share one frame clock')
      assert.equal(f.app.isBusy, false, 'child animation never fabricates root work')
      assert.equal(f.terminal.progress, false)
      assert.doesNotMatch(f.terminal.screen(), /Working…/)
      assert.match(f.terminal.screen(), /native spinning activity/, 'the second activity line stays intact')
      assert.deepEqual(editor.captureDraft(), draft)
      assert.equal(f.backend.calls.some(call => call.name.startsWith('subagent')), false, 'animation makes no backend reads')

      f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'running' }); await paint(f.terminal)
      const workingRow = screenLines(f.terminal).findIndex(line => line.includes('Working…'))
      assert.ok(workingRow >= 0)
      assert.equal(screenCell(f.terminal, workingRow, 0).getChars(), frame('Alpha spinner'), 'the editor and children paint the exact same current frame')
      f.backend.emit({ type: 'status', sessionId: f.backend.info.sessionId, status: 'idle' }); await paint(f.terminal)
      assert.equal(f.app.isBusy, false)
      assert.ok(family.has(frame('Alpha spinner')), 'root settling does not stop active child animation')

      f.backend.upsert({ ...active, status: 'idle' })
      f.backend.upsert({ ...initializing, status: 'idle' }); await paint(f.terminal)
      assert.equal(headerRow(f.terminal), -1)
      await delay(180); await f.terminal.flush()
      const written = f.terminal.writes.length
      await delay(260); await f.terminal.flush()
      assert.equal(f.terminal.writes.length, written, 'all settled work stops the animation clock and idle repainting')
      assert.deepEqual(editor.captureDraft(), draft)
    } finally { await f.close() }
  })

  test(`animated children do not intercept the empty-root exit confirmation (${screen})`, async () => {
    const f = await fixture(screen)
    try {
      f.backend.catalog([child('Exit-safe spinner', { lastActivity: 'native work' })]); await paint(f.terminal)
      assert.equal(f.app.isBusy, false)
      f.terminal.type('\x03'); await paint(f.terminal)
      assert.match(f.terminal.screen(), /Press the same exit key again to exit/)
      assert.equal(f.backend.cancels, 0)
      f.terminal.type('\x03')
      assert.equal(await f.app.exited, 0)
      assert.equal(f.terminal.stopped, true)
      assert.equal(f.backend.cancels, 0, 'an exit confirmation is not a fabricated child/root interrupt')
    } finally { await f.close() }
  })
}
