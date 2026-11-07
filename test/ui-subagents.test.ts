// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent, type TuiMouseEventType } from '#pi-tui'
import type { BackendEvent, SessionEvent, SessionInfo, SubagentEntry, SubagentSnapshot } from '../src/backend/types.ts'
import { DEMO_HINTS, DEMO_MODEL, DEMO_PROVIDER, DEMO_TRANSCRIPT_CODEC, DemoBackend } from '../src/demo.ts'
import { SubagentProjection, buildSubagentTree, flattenSubagentTree } from '../src/state/subagents.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import { createItemBlock, type TranscriptViewOptions } from '../src/ui/blocks.ts'
import { TranscriptView } from '../src/ui/transcript.ts'
import { SubagentGroupBlock } from '../src/ui/subagent-group.ts'
import { clearToolExpansion } from '../src/ui/tool-expansion.ts'
import { AgentsOverlay } from '../src/ui/agents-overlay.ts'
import { ChildSessionView } from '../src/ui/child-session-view.ts'
import { SubagentProgress } from '../src/ui/subagent-progress.ts'
import { subagentCanReply, subagentCanStop } from '../src/ui/subagent-format.ts'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'

const input = await loadInputModule()
const keymap = (): InstanceType<typeof input.CcKeymap> => input.createCcKeymap()

/** Raw first key of a shared action, plus its display label. */
const actionKeys = (id: string, km = keymap()): { raw: string; label: string } => {
  const binding = km.getBindings(id)[0]
  assert.ok(binding !== undefined, `${id} has a default binding`)
  return { raw: binding, label: input.formatBinding(binding.split(' ')) }
}

const UP = '\x1b[A'
const DOWN = '\x1b[B'
const PAGE_DOWN = '\x1b[6~'
const HOME = '\x1b[H'
const END = '\x1b[F'
const ENTER = '\r'
const ESC = '\x1b'
const CTRL_C = '\x03'
const CTRL_D = '\x04'
const CTRL_O = '\x0f'
const CTRL_X = '\x18'
const CTRL_A = '\x01'
const ALT_P = '\x1bp'
const SHIFT_TAB = '\x1b[Z'

const info = (events: SessionEvent[] = [], subagents?: SubagentSnapshot): SessionInfo => ({
  sessionId: 's1',
  cwd: '/tmp/work',
  provider: DEMO_PROVIDER,
  model: DEMO_MODEL,
  capabilities: [],
  events,
  ...(subagents === undefined ? {} : { subagents }),
})

const ev = (type: string, seq: number, data: unknown, extra: Partial<SessionEvent> = {}): SessionEvent => ({
  type,
  seq,
  time: 1_750_000_000_000 + seq,
  data,
  ...extra,
})

const user = (text: string, source: Record<string, unknown> = { kind: 'user' }) => ({
  id: `u-${text}`,
  role: 'user',
  content: [{ type: 'text', text }],
  source,
})

const assistant = (seq: number, text: string) => ev('assistant/message', seq, {
  turn: 1,
  step: 1,
  message: {
    id: `a-${seq}`,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: { kind: 'model', provider: DEMO_PROVIDER, model: DEMO_MODEL },
  },
  stream: [],
}, { surfaceOp: 'append' })

const entry = (overrides: Partial<SubagentEntry> = {}): SubagentEntry => ({
  id: 'child-1',
  parentSessionId: 's1',
  mode: 'one-shot',
  status: 'running',
  ...overrides,
})

const snapshot = (...entries: SubagentEntry[]): SubagentSnapshot => ({ entries })

function newStore(options: { events?: SessionEvent[]; subagents?: SubagentSnapshot } = {}): TranscriptStore {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info(options.events ?? [], options.subagents))
  return store
}

const viewOptions = (extra: Partial<TranscriptViewOptions> = {}): TranscriptViewOptions => ({
  showThinking: true,
  expandTools: false,
  ...extra,
})

function mouse(type: TuiMouseEventType, x: number, y: number): TuiMouseEvent {
  return {
    type,
    x,
    y,
    button: 'left',
    screenX: x + 10,
    screenY: y + 3,
    width: 80,
    height: 24,
    shift: false,
    alt: false,
    ctrl: false,
  }
}

const plain = (lines: readonly string[]): string[] => lines.map(line => stripTerminalSequences(line))

/** Display column where `needle` starts in one plain painted line. */
function colOf(line: string, needle: string): number {
  const index = line.indexOf(needle)
  assert.ok(index >= 0, `missing ${JSON.stringify(needle)} in ${JSON.stringify(line)}`)
  return visibleWidth(line.slice(0, index))
}

function assertWidths(lines: readonly string[], width: number, label: string): void {
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `${label}: width ${width} got ${visibleWidth(line)} :: ${JSON.stringify(stripTerminalSequences(line))}`)
  }
}

// ---------------------------------------------------------------------------
// Catalog projection

test('snapshot and upsert folds are idempotent and keep stable identity', () => {
  const projection = new SubagentProjection()
  const a = entry({ id: 'a', label: 'Alpha', catalogSeq: 4, totalTokens: 10 })
  assert.equal(projection.applySnapshot(snapshot(a)), true)
  const first = projection.get('a')
  const revision = projection.revisionOf('a')
  assert.equal(projection.applySnapshot(snapshot({ ...a })), false)
  assert.equal(projection.get('a'), first, 'equal replayed snapshot keeps the same object')
  assert.equal(projection.revisionOf('a'), revision)
  assert.equal(projection.applyEntry({ ...a }), false, 'equal upsert is a no-op')
  assert.equal(projection.revisionOf('a'), revision)
  assert.equal(projection.applyEntry({ ...a, status: 'idle' }), true)
  assert.equal(projection.revisionOf('a'), revision + 1)
  assert.equal(projection.entries.length, 1)
})

test('a live upsert preserves a cold snapshot catalog anchor without inventing one', () => {
  const projection = new SubagentProjection()
  projection.applySnapshot(snapshot(
    entry({ id: 'cold', catalogSeq: 7, status: 'idle' }),
    entry({ id: 'unseq', status: 'idle' }),
  ))
  projection.applyEntry({ id: 'cold', parentSessionId: 's1', mode: 'continuable', status: 'running', lastActivity: 'reading' })
  assert.equal(projection.get('cold')?.catalogSeq, 7)
  projection.applyEntry(entry({ id: 'new-live' }))
  assert.equal(projection.get('new-live')?.catalogSeq, undefined, 'a live row can never guess a parent seq')
})

test('a full snapshot removes absent children and carries native truncation', () => {
  const projection = new SubagentProjection()
  projection.applySnapshot(snapshot(entry({ id: 'a' }), entry({ id: 'b' })))
  assert.equal(projection.applySnapshot({ entries: [entry({ id: 'a' })], truncated: true }), true)
  assert.equal(projection.get('b'), undefined)
  assert.equal(projection.truncated, true)
  assert.deepEqual(projection.snapshot?.entries.map(row => row.id), ['a'])
  // The rows are unchanged but the completeness flag is real native state, so
  // the store must still notify and repaint the notice.
  assert.equal(projection.applySnapshot({ entries: [entry({ id: 'a' })], truncated: true }), false)
  assert.equal(projection.applySnapshot({ entries: [entry({ id: 'a' })] }), true)
  assert.equal(projection.truncated, false)
  projection.clear()
  assert.equal(projection.entries.length, 0)
  assert.equal(projection.snapshot, undefined)
})

test('snapshot output stays in canonical native order and live-only rows expose a snapshot', () => {
  const projection = new SubagentProjection()
  projection.applySnapshot(snapshot(
    entry({ id: 'later', createdAt: 20 }),
    entry({ id: 'earlier', createdAt: 10 }),
    entry({ id: 'sequenced', catalogSeq: 1, createdAt: 30 }),
  ))
  assert.deepEqual(projection.entries.map(row => row.id), ['sequenced', 'earlier', 'later'])
  assert.deepEqual(projection.snapshot?.entries.map(row => row.id), ['sequenced', 'earlier', 'later'])
  const liveOnly = new SubagentProjection()
  liveOnly.applyEntry(entry({ id: 'live' }))
  assert.deepEqual(liveOnly.snapshot?.entries.map(row => row.id), ['live'])
})

test('only direct children with a trustworthy catalogSeq are anchored', () => {
  const store = newStore({
    events: [ev('user/message', 2, user('hello'))],
    subagents: snapshot(
      entry({ id: 'direct', catalogSeq: 4, status: 'completed' }),
      entry({ id: 'cold', status: 'idle' }),
      entry({ id: 'nested', parentSessionId: 'direct', catalogSeq: 1, status: 'idle' }),
      entry({ id: 'other-parent', parentSessionId: 's2', catalogSeq: 2, status: 'idle' }),
    ),
  })
  assert.deepEqual(store.items.map(item => item.kind), ['user', 'subagent'])
  const row = store.items[1]
  assert.equal(row?.kind, 'subagent')
  if (row?.kind !== 'subagent') return
  assert.equal(row.entry.id, 'direct')
  assert.equal(store.subagentEntries.length, 4, 'overlay still sees cold and nested rows')
  assert.equal(store.subagentEntry('cold')?.id, 'cold')
})

test('fork truncation and finish-before-spawn use the durable seq boundary, never a guess', () => {
  const afterTail = newStore({
    events: [ev('user/message', 2, user('before'))],
    subagents: snapshot(entry({ id: 'beyond', catalogSeq: 99, status: 'completed' })),
  })
  assert.deepEqual(afterTail.items.map(item => item.kind), ['user', 'subagent'])

  const beforeHead = newStore({
    events: [ev('user/message', 2, user('after'))],
    subagents: snapshot(entry({ id: 'head', catalogSeq: 0, status: 'running' })),
  })
  assert.deepEqual(beforeHead.items.map(item => item.kind), ['subagent', 'user'])

  // The child finished before the transcript window reached its catalog event:
  // the backend supplies the resolved entry, and its seq still anchors it at
  // the spawn position instead of at the later settlement.
  const finishedFirst = newStore({
    events: [ev('user/message', 2, user('prompt')), assistant(9, 'settlement arrived later')],
    subagents: snapshot(entry({ id: 'spawned', catalogSeq: 5, status: 'completed' })),
  })
  assert.deepEqual(finishedFirst.items.map(item => item.kind), ['user', 'subagent', 'assistant'])
  const row = finishedFirst.items[1]
  assert.equal(row?.kind, 'subagent')
  if (row?.kind === 'subagent') assert.equal(row.entry.status, 'completed')
})

test('one stable row per child; continuable reactivation is an in-place update', () => {
  const store = newStore({
    events: [ev('user/message', 2, user('go'))],
    subagents: snapshot(entry({
      id: 'cont',
      mode: 'continuable',
      status: 'completed',
      catalogSeq: 3,
      timing: { settledMs: 2_000, lastTurnCompleted: true },
    })),
  })
  const first = store.items.find(item => item.kind === 'subagent')
  assert.equal(first?.kind, 'subagent')
  if (first?.kind !== 'subagent') return
  assert.equal(store.items.filter(item => item.kind === 'subagent').length, 1)

  store.handle({ type: 'subagent', sessionId: 's1', value: entry({
    id: 'cont',
    mode: 'continuable',
    status: 'running',
    catalogSeq: 3,
    lastActivity: 'testing',
    timing: { settledMs: 2_000 },
  }) })
  const rows = store.items.filter(item => item.kind === 'subagent')
  assert.equal(rows.length, 1, 'reactivation never appends a second copy')
  const updated = rows[0]
  assert.equal(updated?.kind, 'subagent')
  if (updated?.kind !== 'subagent') return
  assert.equal(updated.entry.status, 'running')
  assert.equal(updated.entry.catalogSeq, 3, 'the cold anchor survived the live upsert')
})

test('replayed subagent events are idempotent and foreign sessions are ignored', () => {
  const store = newStore({ events: [ev('user/message', 2, user('go'))] })
  const value = snapshot(entry({ id: 'a', catalogSeq: 3 }))
  store.handle({ type: 'subagents', sessionId: 's1', value })
  const count = store.items.length
  store.handle({ type: 'subagents', sessionId: 's1', value })
  assert.equal(store.items.length, count)
  store.handle({ type: 'subagents', sessionId: 'foreign', value: snapshot(entry({ id: 'foreign', catalogSeq: 3 })) })
  assert.equal(store.subagentEntry('foreign'), undefined)
  store.handle({ type: 'subagent', sessionId: 'foreign', value: entry({ id: 'foreign', catalogSeq: 3 }) })
  assert.equal(store.subagentEntry('foreign'), undefined)
})

// ---------------------------------------------------------------------------
// Durable settlement / trigger rows

test('subagent settlement and adjacent-agent messages stay durable, attributed rows', () => {
  const summary = 'Background subagent child-review finished. It cannot receive follow-up messages.'
  const settlementText = `${summary}\n\nIts closing message:\n\nNo blocking issues.`
  const agentText = 'Agent child-explore sent a message: \n\nFound the projection.'
  const events: SessionEvent[] = [
    ev('user/message', 1, user('human prompt')),
    ev('user/message', 2, {
      id: 'settle',
      role: 'user',
      content: [{ type: 'text', text: summary }, { type: 'text', text: 'Its closing message:' }, { type: 'text', text: 'No blocking issues.' }],
      source: { kind: 'subagent-settled', form: 'notice', summary, senderSessionId: 'child-review' },
    }),
    ev('user/message', 3, {
      id: 'agent',
      role: 'user',
      content: [{ type: 'text', text: 'Agent child-explore sent a message: ' }, { type: 'text', text: 'Found the projection.' }],
      source: { kind: 'agent-message', form: 'relay', senderSessionId: 'child-explore' },
    }),
  ]
  const store = newStore({ events })
  assert.deepEqual(store.items.map(item => item.kind), ['user', 'subagent-message', 'subagent-message'])
  const settlement = store.items[1]
  assert.equal(settlement?.kind, 'subagent-message')
  if (settlement?.kind === 'subagent-message') {
    assert.equal(settlement.seq, 2)
    assert.equal(settlement.sourceKind, 'subagent-settled')
    assert.equal(settlement.senderSessionId, 'child-review')
    assert.equal(settlement.summary, summary)
    assert.equal(settlement.text, settlementText)
  }
  const agent = store.items[2]
  assert.equal(agent?.kind, 'subagent-message')
  if (agent?.kind === 'subagent-message') {
    assert.equal(agent.sourceKind, 'agent-message')
    assert.equal(agent.senderSessionId, 'child-explore')
    assert.equal(agent.text, agentText)
  }
})

test('replacement copies, duplicate seqs and other synthetic sources keep existing behavior', () => {
  const source = { kind: 'subagent-settled', form: 'notice', summary: 's', senderSessionId: 'child' }
  const events: SessionEvent[] = [
    ev('user/message', 2, {
      id: 'settle',
      role: 'user',
      content: [{ type: 'text', text: 's' }],
      source,
    }),
    ev('user/message', 2, {
      id: 'duplicate',
      role: 'user',
      content: [{ type: 'text', text: 's' }],
      source,
    }),
    ev('user/message', 3, {
      id: 'replacement',
      role: 'user',
      content: [{ type: 'text', text: 's' }],
      source,
    }, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } }),
    ev('user/message', 4, {
      id: 'injected',
      role: 'user',
      content: [{ type: 'text', text: 'hidden context' }],
      source: { kind: 'plugin', plugin: 'agent-instructions', form: 'instructions' },
    }),
  ]
  const store = newStore({ events })
  assert.deepEqual(store.items.map(item => item.kind), ['subagent-message'])
  assert.equal(store.items.length, 1)
})

// ---------------------------------------------------------------------------
// Transcript render and mouse

function subagentStore(): TranscriptStore {
  return newStore({
    events: [ev('user/message', 2, user('请查看子代理'))],
    subagents: snapshot(
      entry({ id: 'explore', parentSessionId: 's1', catalogSeq: 4, mode: 'continuable', status: 'running', label: 'Explore 仓库', lastActivity: 'reading \x1b[31msrc/app.ts\x1b[0m', totalTokens: 12_345, timing: { settledMs: 2_000, activeSince: 1_000, activeThrough: 61_000 }, provider: DEMO_PROVIDER, model: DEMO_MODEL }),
      entry({ id: 'review', parentSessionId: 's1', catalogSeq: 5, mode: 'continuable', status: 'completed', label: 'Review changes', timing: { lastTurnCompleted: true } }),
      entry({ id: 'broken', parentSessionId: 's1', catalogSeq: 6, mode: 'one-shot', status: 'failed', label: 'Broken 构建' }),
    ),
  })
}

test('transcript rows are single-line, width-safe, sanitized and never show per-run metrics', () => {
  const store = subagentStore()
  // `groupTools: false` restores one row per record; grouping is covered below.
  const view = new TranscriptView(store, viewOptions({ groupTools: false }))
  for (const width of [24, 40, 80, 120, 160]) {
    const lines = view.render(width)
    assertWidths(lines, width, 'subagent row')
    for (const line of plain(lines)) assert.ok(!line.includes('\x1b'), 'no raw ANSI in painted rows')
  }
  const wide = plain(view.render(160)).join('\n')
  assert.ok(wide.includes('Explore 仓库'))
  assert.ok(wide.includes('running'))
  assert.ok(wide.includes('continuable'))
  assert.ok(wide.includes('reading src/app.ts'), 'sanitized activity remains readable')
  assert.ok(wide.includes('last run completed · idle'), 'continuable completion is not permanent Done')
  assert.ok(wide.includes('failed'))
  assert.ok(!wide.includes('tok'), 'no fabricated/per-run token metric on the transcript row')
  assert.ok(!/\b(last run completed · idle).*\b1m\b/.test(wide), 'no run stopwatch on the row')
  // One line per direct child, no accordion.
  const subagentLines = plain(view.render(80)).filter(line => /Explore 仓库|Review changes|Broken 构建/.test(line))
  assert.equal(subagentLines.length, 3)
})

test('transcript subagent rows expose no metrics when native timing/tokens are absent', () => {
  const store = newStore({
    events: [ev('user/message', 2, user('go'))],
    subagents: snapshot(entry({ id: 'bare', catalogSeq: 3, label: 'Bare child', status: 'running', lastActivity: 'working' })),
  })
  const view = new TranscriptView(store, viewOptions())
  const text = plain(view.render(120)).join('\n')
  assert.ok(text.includes('Bare child'))
  assert.ok(text.includes('working'))
  assert.ok(!text.includes('tok'))
  assert.ok(!/\b\d+m \d+s\b/.test(text))
})

test('only the painted name of a standalone row opens its details', () => {
  const store = subagentStore()
  const opened: string[] = []
  const view = new TranscriptView(store, viewOptions({ groupTools: false, onSubagentDetails: id => opened.push(id) }))
  const lines = plain(view.render(80))
  const row = lines.findIndex(line => line.includes('Explore 仓库'))
  assert.ok(row >= 0)
  const text = lines[row] ?? ''
  const name = colOf(text, 'Explore 仓库')
  // The status glyph, the guide gap, the mode/status/metrics and the hint are
  // plain text: a press there stays native (selection/copy), never navigation.
  for (const x of [name - 2, name - 1, name + visibleWidth('Explore 仓库'), colOf(text, 'continuable'), colOf(text, 'running')]) {
    assert.equal(view.handleMouse(mouse('press', x, row)), undefined, `col ${x} must stay unclaimed`)
    view.handleMouse(mouse('click', x, row))
  }
  assert.deepEqual(opened, [], 'no non-name cell can open the child')
  // The first and last display column of the name do.
  view.handleMouse(mouse('press', name, row))
  view.handleMouse(mouse('click', name, row))
  assert.deepEqual(opened, ['explore'])
  const nameEnd = name + visibleWidth('Explore 仓库') - 1
  view.handleMouse(mouse('press', nameEnd, row))
  view.handleMouse(mouse('click', nameEnd, row))
  assert.deepEqual(opened, ['explore', 'explore'])

  const inert = new TranscriptView(store, viewOptions({ groupTools: false }))
  inert.render(80)
  assert.equal(inert.handleMouse(mouse('click', name, row)), undefined)
})

test('an external row is visible but never advertises a local details surface', () => {
  const store = newStore({
    events: [ev('user/message', 2, user('go'))],
    subagents: snapshot(entry({
      id: 'external',
      parentSessionId: 's1',
      catalogSeq: 3,
      mode: 'external',
      status: 'external',
      label: 'External research',
      local: false,
    })),
  })
  const opened: string[] = []
  const view = new TranscriptView(store, viewOptions({ onSubagentDetails: id => opened.push(id) }))
  const lines = plain(view.render(80))
  const row = lines.findIndex(line => line.includes('External research'))
  assert.ok(row >= 0)
  assert.equal(lines[row]?.match(/external/g)?.length, 1, 'external is stated once, not external · external')
  assert.equal(view.handleMouse(mouse('click', 2, row)), undefined)
  assert.deepEqual(opened, [])
})

test('a press survives an in-place row update and still opens the pressed child', () => {
  const store = subagentStore()
  const item = store.items.find(value => value.kind === 'subagent' && value.entry.id === 'explore')
  assert.ok(item !== undefined && item.kind === 'subagent')
  if (item === undefined || item.kind !== 'subagent') return
  const opened: string[] = []
  const block = createItemBlock(item, viewOptions({ onSubagentDetails: id => opened.push(id) }))
  block.render(80)
  assert.deepEqual(block.handleMouse?.(mouse('press', 3, 0)), { handled: true })
  viewUpdate(store)
  const updated = store.items.find(value => value.kind === 'subagent' && value.entry.id === 'explore')
  assert.ok(updated !== undefined)
  if (updated === undefined) return
  block.update(updated)
  block.render(80)
  block.handleMouse?.(mouse('click', 3, 0))
  assert.deepEqual(opened, ['explore'])
})

/** Force a live upsert so the child row version changes between press and click. */
function viewUpdate(store: TranscriptStore): void {
  store.handle({
    type: 'subagent',
    sessionId: 's1',
    value: entry({
      id: 'explore',
      parentSessionId: 's1',
      catalogSeq: 4,
      mode: 'continuable',
      status: 'running',
      label: 'Explore 仓库',
      lastActivity: 'now testing',
      totalTokens: 12_345,
    }),
  })
}

test('settlement/trigger rows render native attribution and exact body, never a prompt band', () => {
  const summary = 'Background subagent child-review finished.'
  const store = newStore({
    events: [
      ev('user/message', 2, {
        id: 'settle',
        role: 'user',
        content: [{ type: 'text', text: summary }, { type: 'text', text: 'Closing: no blockers.' }],
        source: { kind: 'subagent-settled', form: 'notice', summary, senderSessionId: 'child-review' },
      }),
      ev('user/message', 3, {
        id: 'agent',
        role: 'user',
        content: [{ type: 'text', text: 'Agent child-explore sent a message: ' }, { type: 'text', text: 'Found it.' }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: 'child-explore' },
      }),
    ],
  })
  const opened: string[] = []
  // Two adjacent durable records would group; `groupTools: false` keeps one row
  // per record so this test stays about the standalone row paint.
  const view = new TranscriptView(store, viewOptions({ groupTools: false, onSubagentDetails: id => opened.push(id) }))
  const lines = view.render(100)
  assertWidths(lines, 100, 'settlement row')
  const text = plain(lines).join('\n')
  assert.ok(text.includes('Subtask status updated'))
  assert.ok(text.includes('Task message received'))
  assert.ok(text.includes('child-review'))
  assert.ok(text.includes('Closing: no blockers.'))
  assert.ok(text.includes('Found it.'))
  assert.ok(!text.includes('Agent child-explore sent a message: \n\nFound it.'), 'exact prefix is not repeated in the paint')
  assert.ok(!text.split('\n').some(line => line.startsWith('> ')), 'never a human prompt band')
  // No native catalog row exists for either sender here: the durable id is
  // painted as plain text and the row must not fake a navigation affordance.
  for (const title of ['Subtask status updated', 'Task message received']) {
    const row = plain(lines).findIndex(line => line.includes(title))
    assert.ok(row >= 0)
    const painted = plain(lines)[row] ?? ''
    for (const x of [colOf(painted, title), colOf(painted, 'child-')]) {
      assert.equal(view.handleMouse(mouse('press', x, row)), undefined, `${title} col ${x} stays sample text`)
      view.handleMouse(mouse('click', x, row))
    }
  }
  assert.deepEqual(opened, [])
})

test('a settlement/trigger sender links only its visible native label from the catalog', () => {
  const summary = 'Background subagent review finished.'
  const store = newStore({
    events: [
      ev('user/message', 2, {
        id: 'settle',
        role: 'user',
        content: [{ type: 'text', text: summary }],
        source: { kind: 'subagent-settled', form: 'notice', summary, senderSessionId: 'child-review' },
      }),
      ev('user/message', 3, {
        id: 'agent',
        role: 'user',
        content: [{ type: 'text', text: 'Agent child-external sent a message: ' }, { type: 'text', text: 'Remote result.' }],
        source: { kind: 'agent-message', form: 'relay', senderSessionId: 'child-external' },
      }),
    ],
    subagents: snapshot(
      entry({ id: 'child-review', parentSessionId: 's1', mode: 'continuable', status: 'completed', label: 'Review changes' }),
      entry({ id: 'child-external', parentSessionId: 's1', mode: 'external', status: 'external', label: 'External research' }),
    ),
  })
  const opened: string[] = []
  const view = new TranscriptView(store, viewOptions({ groupTools: false, onSubagentDetails: id => opened.push(id) }))
  const raw = view.render(100)
  const lines = plain(raw)
  const text = lines.join('\n')
  // The catalog knows the children, so their real labels replace the ids.
  assert.ok(text.includes('Review changes'), text)
  assert.ok(text.includes('External research'), text)
  assert.ok(!text.includes('child-review'), 'a known child is painted by its native label')
  const settleRow = lines.findIndex(line => line.includes('Subtask status updated'))
  const settleText = lines[settleRow] ?? ''
  const name = colOf(settleText, 'Review changes')
  // Attribution title and the gap are plain text.
  assert.equal(view.handleMouse(mouse('press', colOf(settleText, 'Subtask'), settleRow)), undefined)
  view.handleMouse(mouse('click', colOf(settleText, 'Subtask'), settleRow))
  assert.deepEqual(opened, [])
  // Only the visible name navigates.
  view.handleMouse(mouse('press', name, settleRow))
  view.handleMouse(mouse('click', name, settleRow))
  assert.deepEqual(opened, ['child-review'])
  // Exactly the name is underlined (one SGR-4 span on the header row).
  assert.equal((raw[settleRow] ?? '').split('\x1b[4m').length - 1, 1)

  // An external child is honestly non-openable: label painted, no link at all.
  const externalRow = lines.findIndex(line => line.includes('Task message received'))
  const externalText = lines[externalRow] ?? ''
  const externalName = colOf(externalText, 'External research')
  assert.equal(view.handleMouse(mouse('press', externalName, externalRow)), undefined)
  view.handleMouse(mouse('click', externalName, externalRow))
  assert.deepEqual(opened, ['child-review'])
  assert.equal((raw[externalRow] ?? '').split('\x1b[4m').length - 1, 0)
})

// ---------------------------------------------------------------------------
// Consecutive record grouping (Tools-style, display-only)

/** `user → [Alpha, Beta] → assistant → [Gamma, settled]` as durable facts. */
function groupedStore(): TranscriptStore {
  const summary = 'Background subagent gamma finished.'
  return newStore({
    events: [
      ev('user/message', 2, user('please check the children')),
      assistant(5, 'two children spawned'),
      ev('user/message', 7, {
        id: 'settle',
        role: 'user',
        content: [{ type: 'text', text: summary }, { type: 'text', text: 'Body: no blockers.' }],
        source: { kind: 'subagent-settled', form: 'notice', summary, senderSessionId: 'gamma' },
      }),
    ],
    subagents: snapshot(
      entry({ id: 'alpha', parentSessionId: 's1', catalogSeq: 3, mode: 'continuable', status: 'running', label: 'Alpha 仓库', lastActivity: 'reading src/app.ts' }),
      entry({ id: 'beta', parentSessionId: 's1', catalogSeq: 4, mode: 'one-shot', status: 'completed', label: 'Beta' }),
      entry({ id: 'gamma', parentSessionId: 's1', catalogSeq: 6, mode: 'one-shot', status: 'failed', label: 'Gamma' }),
    ),
  })
}

test('consecutive subagent records group like tools and never cross a real boundary', () => {
  const store = groupedStore()
  const view = new TranscriptView(store, viewOptions())
  const lines = plain(view.render(120))
  // Two runs, one assistant item between them: `[alpha, beta]` and `[gamma, settle]`.
  const headers = lines.filter(line => line.includes('Subagents:'))
  assert.equal(headers.length, 2, lines.join('\n'))
  assert.ok(headers[0]?.includes('2 records'), headers[0])
  assert.ok(headers[0]?.includes('1 running'), headers[0])
  assert.ok(headers[0]?.includes('1 completed'), headers[0])
  assert.ok(headers[1]?.includes('2 records'), headers[1])
  assert.ok(headers[1]?.includes('1 failed'), headers[1])
  assert.ok(headers[1]?.includes('1 message'), headers[1])
  // Members are painted as summary rows; the assistant item stays its own block.
  const text = lines.join('\n')
  assert.ok(text.includes('Alpha 仓库'), text)
  assert.ok(text.includes('Beta'), text)
  assert.ok(text.includes('Gamma'), text)
  assert.ok(text.includes('Subtask status updated'), text)
  assert.ok(text.includes('two children spawned'), text)
  // Collapsed rows stay summaries: the durable body is folded, the store keeps it.
  assert.ok(!text.includes('Body: no blockers.'), 'the collapsed group folds the body, it never deletes it')
  const stored = store.items.find(item => item.kind === 'subagent-message')
  assert.ok(stored !== undefined && stored.kind === 'subagent-message')
  if (stored === undefined || stored.kind !== 'subagent-message') return
  assert.equal(stored.seq, 7, 'the native seq is untouched by grouping')
  assert.equal(stored.senderSessionId, 'gamma')
  assert.ok(stored.text.includes('Body: no blockers.'), 'the exact native text stays in the store')
  // Grouping is a preference: `groupTools: false` restores one row per record,
  // and a non-record item between records never joins a run.
  const flat = new TranscriptView(store, viewOptions({ groupTools: false }))
  assert.equal(plain(flat.render(120)).filter(line => line.includes('Subagents:')).length, 0)
  assert.equal(plain(flat.render(120)).filter(line => /Alpha 仓库|Beta|Gamma|Subtask status updated/.test(line)).length, 4)
})

test('a group header only toggles the fold; every member body follows the disclosure', () => {
  const store = groupedStore()
  const opened: string[] = []
  const view = new TranscriptView(store, viewOptions({ hints: { expand: 'ctrl+o' }, onSubagentDetails: id => opened.push(id) }))
  const collapsed = plain(view.render(120))
  const headers = collapsed.map((line, index) => line.includes('Subagents:') ? index : -1).filter(index => index >= 0)
  assert.equal(headers.length, 2)
  assert.ok(collapsed[headers[0]!]?.includes('ctrl+o to expand'), collapsed[headers[0]!])
  // Click the SECOND group (the one holding the durable message body). The
  // header is a disclosure control: it never opens a child, even when the click
  // lands on the header text or on the count/chord.
  const secondRow = headers[1]!
  for (const x of [colOf(collapsed[secondRow] ?? '', 'Subagents'), colOf(collapsed[secondRow] ?? '', '2 records'), 1]) {
    view.handleMouse(mouse('press', x, secondRow))
    view.handleMouse(mouse('click', x, secondRow))
  }
  assert.deepEqual(opened, [])
  const expanded = plain(view.render(120))
  assert.ok(expanded[secondRow]?.includes('to collapse'), expanded[secondRow])
  assert.ok(expanded.join('\n').includes('Body: no blockers.'), 'the durable body is painted once expanded')
  // A local toggle is local: the other run keeps its own fold state.
  const firstRow = expanded.findIndex(line => line.includes('Subagents:'))
  assert.ok(expanded[firstRow]?.includes('to expand'), expanded[firstRow])
  // Ctrl+O is the existing transcript master switch: it unfolds the rest too.
  view.toggleToolsExpanded()
  const all = plain(view.render(120))
  assert.equal(all.join('\n').includes('Body: no blockers.'), true)
  assert.ok(all[firstRow]?.includes('to collapse'), all[firstRow])
  assert.deepEqual(opened, [], 'no disclosure path ever opens a child')
})

test('group member names are the only child links, collapsed or expanded', () => {
  const store = groupedStore()
  const opened: string[] = []
  const view = new TranscriptView(store, viewOptions({ onSubagentDetails: id => opened.push(id) }))
  const lines = plain(view.render(120))
  const alphaRow = lines.findIndex(line => line.includes('Alpha 仓库'))
  assert.ok(alphaRow >= 0)
  const alphaText = lines[alphaRow] ?? ''
  // Branch guide, status glyph, status text and the activity tail are plain text.
  for (const x of [0, 1, 2, 3, colOf(alphaText, 'running'), colOf(alphaText, 'reading')]) {
    assert.equal(view.handleMouse(mouse('press', x, alphaRow)), undefined, `collapsed col ${x} stays native text`)
    view.handleMouse(mouse('click', x, alphaRow))
  }
  assert.deepEqual(opened, [])
  const name = colOf(alphaText, 'Alpha 仓库')
  view.handleMouse(mouse('press', name, alphaRow))
  view.handleMouse(mouse('click', name, alphaRow))
  assert.deepEqual(opened, ['alpha'])
  // A settlement member's attribution stays inert; its sender name navigates.
  const settleRow = lines.findIndex(line => line.includes('Subtask status updated'))
  const settleText = lines[settleRow] ?? ''
  assert.equal(view.handleMouse(mouse('press', colOf(settleText, 'Subtask'), settleRow)), undefined)
  view.handleMouse(mouse('click', colOf(settleText, 'Subtask'), settleRow))
  assert.deepEqual(opened, ['alpha'])
  const sender = colOf(settleText, 'Gamma')
  view.handleMouse(mouse('press', sender, settleRow))
  view.handleMouse(mouse('click', sender, settleRow))
  assert.deepEqual(opened, ['alpha', 'gamma'])

  // Expanded members are the real child blocks: the same name-only geometry.
  view.toggleToolsExpanded()
  const expanded = plain(view.render(120))
  const memberRow = expanded.findIndex(line => line.includes('Alpha 仓库'))
  assert.ok(memberRow >= 0)
  const memberText = expanded[memberRow] ?? ''
  const memberName = colOf(memberText, 'Alpha 仓库')
  assert.equal(view.handleMouse(mouse('press', colOf(memberText, 'continuable'), memberRow)), undefined)
  view.handleMouse(mouse('press', memberName, memberRow))
  view.handleMouse(mouse('click', memberName, memberRow))
  assert.deepEqual(opened, ['alpha', 'gamma', 'alpha'])
})

test('a collapsed member name keeps a claimed press across later frames', () => {
  const store = groupedStore()
  const opened: string[] = []
  const view = new TranscriptView(store, viewOptions({ onSubagentDetails: id => opened.push(id) }))
  const lines = plain(view.render(120))
  const alphaRow = lines.findIndex(line => line.includes('Alpha 仓库'))
  const name = colOf(lines[alphaRow] ?? '', 'Alpha 仓库')
  const claimed = view.handleMouse(mouse('press', name, alphaRow))
  assert.equal(claimed?.handled, true, 'the member name claims the press')
  // A native catalog frame repaints the row in place between press and release.
  store.handle({
    type: 'subagent',
    sessionId: 's1',
    value: entry({ id: 'alpha', parentSessionId: 's1', catalogSeq: 3, mode: 'continuable', status: 'running', label: 'Alpha 仓库', lastActivity: 'now testing' }),
  })
  view.render(120)
  view.handleMouse(mouse('click', name, alphaRow))
  assert.deepEqual(opened, ['alpha'], 'the pinned press still opens the pressed child')
})

test('grouping is width-safe and never fakes a link for a clipped-away name', () => {
  const store = newStore({
    events: [
      ev('user/message', 2, {
        id: 'settle',
        role: 'user',
        content: [{ type: 'text', text: 'done' }],
        source: { kind: 'subagent-settled', form: 'notice', summary: 'done', senderSessionId: 'child-review' },
      }),
    ],
    subagents: snapshot(
      entry({ id: 'a', parentSessionId: 's1', catalogSeq: 3, mode: 'one-shot', status: 'completed', label: '探索仓库 🚀 子代理' }),
      entry({ id: 'child-review', parentSessionId: 's1', catalogSeq: 4, mode: 'one-shot', status: 'completed', label: 'Review changes' }),
    ),
  })
  const opened: string[] = []
  const view = new TranscriptView(store, viewOptions({ onSubagentDetails: id => opened.push(id) }))
  for (const width of [16, 24, 40, 60, 80, 120]) {
    const lines = view.render(width)
    assertWidths(lines, width, `group width ${width}`)
    for (const line of plain(lines)) assert.ok(!line.includes('\x1b'), `sanitized at ${width}`)
  }
  // At 16 columns the sender name starts beyond the last painted cell: no link,
  // no invisible hitbox, and the row still paints (clipped) attribution.
  const narrow = plain(view.render(16))
  const settleRow = narrow.findIndex(line => line.includes('Task message'))
  assert.ok(settleRow >= 0 || narrow.some(line => line.includes('Subtask')))
  const row = narrow.findIndex(line => /Subtask|Task message/.test(line))
  if (row >= 0) {
    for (let x = 0; x < width16(narrow[row] ?? ''); x += 1) view.handleMouse(mouse('click', x, row))
  }
  assert.deepEqual(opened, [], 'a clipped-away name never becomes a click target')
})

const width16 = (line: string): number => Math.min(16, visibleWidth(line))

test('hover still repaints but every move and drag stays unclaimed', () => {
  const store = subagentStore()
  const opened: string[] = []
  let renders = 0
  const view = new TranscriptView(store, viewOptions({
    groupTools: false,
    onSubagentDetails: id => opened.push(id),
    onRenderRequest: () => { renders += 1 },
  }))
  const lines = plain(view.render(80))
  const row = lines.findIndex(line => line.includes('Explore 仓库'))
  const text = lines[row] ?? ''
  const name = colOf(text, 'Explore 仓库')
  // Entering a name is a local hover repaint, never a claimed event.
  assert.equal(view.handleMouse(mouse('move', name, row)), undefined)
  assert.equal(renders, 1, 'hover asks the host for one repaint')
  assert.equal(view.handleMouse(mouse('move', colOf(text, 'running'), row)), undefined)
  // A press in plain text, then a drag across the name: nothing is claimed, so
  // the renderer keeps the text selection it started.
  assert.equal(view.handleMouse(mouse('press', 0, row)), undefined)
  assert.equal(view.handleMouse(mouse('drag', name, row)), undefined)
  assert.equal(view.handleMouse(mouse('click', name, row)), undefined, 'a drag is never a click jump')
  assert.deepEqual(opened, [])
  // A fresh press/click gesture on the same name still navigates.
  view.handleMouse(mouse('press', name, row))
  view.handleMouse(mouse('click', name, row))
  assert.deepEqual(opened, ['explore'])
})

test('an outside press never becomes a link when a label grows or the catalog arrives', () => {
  const summary = 'Background subagent review finished.'
  const store = newStore({
    events: [
      ev('user/message', 2, {
        id: 'settle',
        role: 'user',
        content: [{ type: 'text', text: summary }],
        source: { kind: 'subagent-settled', form: 'notice', summary, senderSessionId: 'child-review' },
      }),
    ],
  })
  const opened: string[] = []
  const view = new TranscriptView(store, viewOptions({ groupTools: false, onSubagentDetails: id => opened.push(id) }))
  const before = plain(view.render(100))
  const row = before.findIndex(line => line.includes('Subtask status updated'))
  const idStart = colOf(before[row] ?? '', 'child-review')
  // Press on the durable id: no native catalog row exists yet, so there is no
  // link there and the press must stay unclaimed for native selection.
  assert.equal(view.handleMouse(mouse('press', idStart + 2, row)), undefined)
  // A later native catalog frame resolves the id into a real child label whose
  // columns cover the press point.
  store.handle({
    type: 'subagents',
    sessionId: 's1',
    value: snapshot(entry({
      id: 'child-review', parentSessionId: 's1', mode: 'continuable', status: 'completed', label: 'Review changes and follow-ups',
    })),
  })
  const after = plain(view.render(100))
  assert.equal(colOf(after[row] ?? '', 'Review changes'), idStart, 'the grown label covers the pressed column')
  assert.equal(view.handleMouse(mouse('click', idStart + 2, row)), undefined, 'the outside-press tombstone keeps selection native')
  assert.deepEqual(opened, [])
  // A fresh gesture on the grown label does navigate.
  view.handleMouse(mouse('press', idStart + 2, row))
  view.handleMouse(mouse('click', idStart + 2, row))
  assert.deepEqual(opened, ['child-review'])
})

test('a claimed sender name that vanishes and reappears before release never fires', () => {
  const summary = 'Background subagent review finished.'
  const store = newStore({
    events: [
      ev('user/message', 2, {
        id: 'settle',
        role: 'user',
        content: [{ type: 'text', text: summary }],
        source: { kind: 'subagent-settled', form: 'notice', summary, senderSessionId: 'child-review' },
      }),
    ],
    subagents: snapshot(entry({
      id: 'child-review', parentSessionId: 's1', mode: 'continuable', status: 'completed', label: 'Review changes',
    })),
  })
  const opened: string[] = []
  const view = new TranscriptView(store, viewOptions({ groupTools: false, onSubagentDetails: id => opened.push(id) }))
  const lines = plain(view.render(100))
  const row = lines.findIndex(line => line.includes('Subtask status updated'))
  const name = colOf(lines[row] ?? '', 'Review changes')
  assert.equal(view.handleMouse(mouse('press', name, row))?.handled, true)
  // A narrow frame clips the name away entirely (no link, no hitbox) …
  const narrow = plain(view.render(12))
  assert.ok(!narrow.join('\n').includes('Review changes'))
  // … and a later wide frame brings the same link back under the same columns.
  view.render(100)
  const result = view.handleMouse(mouse('click', name, row))
  assert.equal(result?.handled, true, 'the stale press is swallowed, not retargeted')
  assert.deepEqual(opened, [], 'a reappearing link never receives the old gesture')
})

test('a grouped collapsed name whose link vanishes before release never fires', () => {
  const store = groupedStore()
  const opened: string[] = []
  const view = new TranscriptView(store, viewOptions({ onSubagentDetails: id => opened.push(id) }))
  const lines = plain(view.render(120))
  // The second run holds the durable settlement; its sender name is the last row.
  const row = lines.findIndex(line => line.includes('Subtask status updated'))
  const name = colOf(lines[row] ?? '', 'Gamma')
  assert.equal(view.handleMouse(mouse('press', name, row))?.handled, true)
  // 16 columns clips the whole sender segment (no link, no hitbox) …
  assert.ok(!plain(view.render(16)).join('\n').includes('Gamma'))
  // … and a later wide frame brings the same member link back.
  view.render(120)
  assert.equal(view.handleMouse(mouse('click', name, row))?.handled, true)
  assert.deepEqual(opened, [], 'the vanished group member link is void for this gesture')
})

test('an expanded group body is selectable text: a click never toggles or opens a child', () => {
  const store = groupedStore()
  const opened: string[] = []
  const view = new TranscriptView(store, viewOptions({ hints: { expand: 'ctrl+o' }, onSubagentDetails: id => opened.push(id) }))
  view.toggleToolsExpanded()
  const lines = plain(view.render(120))
  const bodyRow = lines.findIndex(line => line.includes('Body: no blockers.'))
  assert.ok(bodyRow >= 0, lines.join('\n'))
  const x = colOf(lines[bodyRow] ?? '', 'Body:')
  // Press/drag inside an expanded member body belongs to native selection.
  assert.equal(view.handleMouse(mouse('press', x, bodyRow)), undefined)
  assert.equal(view.handleMouse(mouse('drag', x, bodyRow)), undefined)
  // Even a plain click reports unhandled, so no disclosure can retarget there.
  assert.equal(view.handleMouse(mouse('click', x, bodyRow)), undefined)
  const after = plain(view.render(120))
  assert.ok(after.join('\n').includes('Body: no blockers.'), 'the group stays expanded')
  // Motion across an expanded member (name or body) is never claimed either.
  const memberRow = after.findIndex(line => line.includes('Alpha 仓库'))
  assert.ok(memberRow >= 0)
  assert.equal(view.handleMouse(mouse('move', colOf(after[memberRow] ?? '', 'Alpha'), memberRow)), undefined)
  assert.equal(view.handleMouse(mouse('drag', colOf(after[memberRow] ?? '', 'Alpha'), memberRow)), undefined)
  assert.equal(view.handleMouse(mouse('click', colOf(after[memberRow] ?? '', 'Alpha'), memberRow)), undefined)
  assert.deepEqual(opened, [])
})

test('group prefixes, member width and mouse offsets share one consistent budget', () => {
  clearToolExpansion()
  const store = groupedStore()
  const flags = viewOptions({ expandTools: true, onSubagentDetails: () => {} })
  const records = store.items.filter(item => item.kind === 'subagent' || item.kind === 'subagent-message')
  assert.equal(records.length, 4)
  const members = records.map(item => ({ item, block: createItemBlock(item, flags) }) as never)
  const group = new SubagentGroupBlock(records[0] as never, flags)
  group.setMembers(members)
  const width = 80
  const lines = plain(group.render(width))
  assert.ok(lines[0]?.includes('Subagents:'), lines[0])
  const spans = group.rowSpans
  assert.equal(spans.length, 4)
  for (const span of spans) {
    // One prefix width is used for render, child width and pointer re-basing.
    assert.equal(span.xOffset, 2, 'prefix/xOffset agree')
    const standalone = plain(span.block.render(width - span.xOffset))
    const expanded = lines.slice(span.startRow, span.endRow + 1)
    assert.equal(expanded.length, standalone.length, 'no member row is dropped or added by the prefix')
    expanded.forEach((line, index) => {
      const prefix = line.slice(0, 2)
      assert.ok(['├ ', '└ ', '│ ', '  '].includes(prefix), `unexpected prefix ${JSON.stringify(prefix)}`)
      assert.equal(line.slice(2), standalone[index], 'the member paint is never over-clipped by the final fit')
    })
  }
  for (const line of lines) assert.ok(line.length <= width)
  // The same width discipline holds at narrow terminals.
  for (const narrow of [16, 24, 40]) {
    const narrowLines = group.render(narrow)
    assertWidths(narrowLines, narrow, `group ${narrow}`)
    for (const span of group.rowSpans) {
      assert.equal(span.xOffset, 2)
      assert.ok(span.endRow >= span.startRow)
    }
  }
  group.dispose()
  clearToolExpansion()
})

test('a native label with LF/CR/TAB stays one flattened row and keeps honest link columns', () => {
  const store = newStore({
    events: [ev('user/message', 2, user('go'))],
    subagents: snapshot(entry({
      id: 'weird',
      parentSessionId: 's1',
      catalogSeq: 3,
      mode: 'continuable',
      status: 'running',
      label: 'Multi\nLine\tLabel',
      lastActivity: 'x\ty\nz',
    })),
  })
  const opened: string[] = []
  const view = new TranscriptView(store, viewOptions({ groupTools: false, onSubagentDetails: id => opened.push(id) }))
  const lines = plain(view.render(80))
  const row = lines.findIndex(line => line.includes('Multi Line Label'))
  assert.ok(row >= 0, lines.join('\n'))
  assert.equal(lines.filter(line => line.includes('Multi')).length, 1, 'the flattened label adds no row')
  const name = colOf(lines[row] ?? '', 'Multi Line Label')
  // The stored native label keeps its exact bytes.
  assert.equal(store.subagentEntry('weird')?.label, 'Multi\nLine\tLabel')
  view.handleMouse(mouse('press', name, row))
  view.handleMouse(mouse('click', name, row))
  assert.deepEqual(opened, ['weird'])
  assertWidths(view.render(80), 80, 'flattened label')
})

test('a narrow trigger row clips the sender name partially and links only visible cells', () => {
  const summary = 'done'
  const store = newStore({
    events: [
      ev('user/message', 2, {
        id: 'settle',
        role: 'user',
        content: [{ type: 'text', text: summary }],
        source: { kind: 'subagent-settled', form: 'notice', summary, senderSessionId: 'child-review' },
      }),
    ],
    subagents: snapshot(entry({
      id: 'child-review', parentSessionId: 's1', mode: 'continuable', status: 'completed', label: 'Review changes',
    })),
  })
  const opened: string[] = []
  const view = new TranscriptView(store, viewOptions({ groupTools: false, onSubagentDetails: id => opened.push(id) }))
  // 40 columns: the attribution fits, the name is partially clipped but readable.
  const lines = plain(view.render(40))
  const row = lines.findIndex(line => line.includes('Subtask status updated'))
  const text = lines[row] ?? ''
  assert.ok(text.endsWith('...'), 'the clipped tail is explicit')
  assert.ok(!text.includes('Review changes'), 'only a readable prefix of the name survives')
  const visibleName = text.indexOf('Review')
  assert.ok(visibleName >= 0, text)
  const nameCol = visibleWidth(text.slice(0, visibleName))
  // The one surviving name cell navigates; the ellipsis cells never do.
  const lastPainted = visibleWidth(text) - 1
  assert.equal(view.handleMouse(mouse('press', lastPainted, row)), undefined, 'ellipsis cells are not link text')
  view.handleMouse(mouse('click', lastPainted, row))
  assert.deepEqual(opened, [])
  view.handleMouse(mouse('press', nameCol, row))
  view.handleMouse(mouse('click', nameCol, row))
  assert.deepEqual(opened, ['child-review'])
})

// ---------------------------------------------------------------------------
// Agents overlay

function overlayEntries(): SubagentEntry[] {
  return [
    entry({ id: 'root-run', parentSessionId: 's1', createdAt: 1, mode: 'continuable', status: 'running', label: 'Explore', lastActivity: 'reading', totalTokens: 12_000, timing: { settledMs: 60_000 } }),
    entry({ id: 'root-idle', parentSessionId: 's1', createdAt: 2, mode: 'continuable', status: 'completed', label: 'Review', timing: { lastTurnCompleted: true } }),
    entry({ id: 'nested', parentSessionId: 'root-run', createdAt: 3, mode: 'one-shot', status: 'idle', label: 'Run tests' }),
    entry({ id: 'external', parentSessionId: 's1', createdAt: 4, mode: 'external', status: 'external', label: 'External research' }),
  ]
}

test('the overlay projects a parentSessionId tree with native ordering and external leaves', () => {
  const tree = buildSubagentTree(overlayEntries())
  const flat = flattenSubagentTree(tree)
  assert.deepEqual(flat.map(node => [node.entry.id, node.depth, node.external]), [
    ['root-run', 0, false],
    ['nested', 1, false],
    ['root-idle', 0, false],
    ['external', 0, true],
  ])
})

test('overlay navigation selects, opens local children and never opens external tasks', () => {
  const tui = createFakeTui(30, 80)
  const opened: SubagentEntry[] = []
  const closed: string[] = []
  const overlay = new AgentsOverlay(asTui(tui), {
    entries: overlayEntries(),
    keymap: keymap(),
    onClose: () => closed.push('close'),
    onOpen: value => opened.push(value),
    now: () => 100_000,
  })
  overlay.focused = true
  const text = plain(overlay.render(80)).join('\n')
  assert.ok(text.includes('Agents'))
  assert.ok(text.includes('Explore'))
  assert.ok(text.includes('running'))
  assert.ok(text.includes('12k tok'), 'native session-total token count is shown')
  assert.ok(text.includes('1m 0s'), 'native session-total duration is shown')
  assert.ok(text.includes('last run completed · idle'))

  // Initial selection is the first root; Enter opens it.
  overlay.handleInput(ENTER)
  assert.deepEqual(opened.map(value => value.id), ['root-run'])
  // Next is its nested child, then the second root, then the external leaf.
  overlay.handleInput(DOWN)
  overlay.handleInput(ENTER)
  overlay.handleInput(DOWN)
  overlay.handleInput(ENTER)
  overlay.handleInput(DOWN)
  overlay.handleInput(ENTER)
  assert.deepEqual(opened.map(value => value.id), ['root-run', 'nested', 'root-idle'])
  assert.ok(!opened.some(value => value.id === 'external'), 'external rows are leaves')
  overlay.handleInput(ESC)
  assert.deepEqual(closed, ['close'])
})

test('overlay setEntries is idempotent, preserves selection and disposal is idempotent', () => {
  const tui = createFakeTui(24, 60)
  const renders: number[] = []
  const overlay = new AgentsOverlay(asTui(tui), {
    entries: overlayEntries(),
    keymap: keymap(),
    onClose: () => {},
    onRenderRequest: () => renders.push(tui.renderRequests),
  })
  overlay.render(60)
  overlay.handleInput(DOWN)
  const selected = overlay.selectedEntry?.id
  overlay.setEntries(overlayEntries())
  assert.equal(overlay.selectedEntry?.id, selected)
  const before = overlay.entries.length
  overlay.setEntry(entry({ id: 'new', parentSessionId: 's1', mode: 'one-shot', status: 'idle', label: 'New child' }))
  assert.equal(overlay.entries.length, before + 1)
  overlay.setEntry(entry({ id: 'new', parentSessionId: 's1', mode: 'one-shot', status: 'idle', label: 'New child' }))
  assert.equal(overlay.entries.length, before + 1)
  overlay.dispose()
  overlay.dispose()
  assert.equal(overlay.isDisposed, true)
  assert.deepEqual(overlay.render(60), [])
})

test('overlay is read-only: unrelated global and printable keys are inert', () => {
  const tui = createFakeTui(24, 80)
  const opened: SubagentEntry[] = []
  const closed: string[] = []
  const overlay = new AgentsOverlay(asTui(tui), {
    entries: overlayEntries(),
    keymap: keymap(),
    onClose: () => closed.push('close'),
    onOpen: value => opened.push(value),
  })
  overlay.focused = true
  for (const key of ['a', 'x', '\t', SHIFT_TAB, CTRL_O, '?']) overlay.handleInput(key)
  assert.deepEqual(opened, [])
  assert.deepEqual(closed, [])
  overlay.handleInput(CTRL_C)
  assert.deepEqual(closed, ['close'])
})

test('overlay forwards only app.exit and keeps every other parent action inert', () => {
  const tui = createFakeTui(24, 80)
  const opened: SubagentEntry[] = []
  const closed: string[] = []
  const globals: string[] = []
  const overlay = new AgentsOverlay(asTui(tui), {
    entries: overlayEntries(),
    keymap: keymap(),
    onClose: () => closed.push('close'),
    onOpen: value => opened.push(value),
    onGlobalAction: id => globals.push(id),
  })
  overlay.focused = true
  // Printable keys, permission cycle, tools expand, model select and the
  // overlay's own parent action must not reach the parent.
  for (const key of ['a', 'hello', '\t', SHIFT_TAB, CTRL_O, ALT_P, CTRL_X, CTRL_A]) overlay.handleInput(key)
  assert.deepEqual(globals, [])
  assert.deepEqual(opened, [])
  assert.deepEqual(closed, [])
  overlay.handleInput(CTRL_D)
  assert.deepEqual(globals, ['app.exit'], 'global quit is forwarded, not swallowed')
  assert.deepEqual(closed, [], 'forwarding exit does not close the overlay by itself')
})

test('overlay app.exit without a parent callback stays inert instead of closing', () => {
  const tui = createFakeTui(24, 80)
  const closed: string[] = []
  const overlay = new AgentsOverlay(asTui(tui), {
    entries: overlayEntries(),
    keymap: keymap(),
    onClose: () => closed.push('close'),
  })
  overlay.focused = true
  overlay.handleInput(CTRL_D)
  assert.deepEqual(closed, [])
  assert.equal(overlay.isDisposed, false)
})

test('overlay widths are safe, truncation is explicit and no metric is fabricated', () => {
  const tui = createFakeTui(24, 80)
  const overlay = new AgentsOverlay(asTui(tui), {
    entries: [
      entry({ id: 'cjk', parentSessionId: 's1', label: '并行子代理 🚀', mode: 'continuable', status: 'running', lastActivity: '读取 中文路径', catalogSeq: 2 }),
      entry({ id: 'bare', parentSessionId: 's1', label: 'Bare', mode: 'unknown', status: 'unknown' }),
    ],
    truncated: true,
    keymap: keymap(),
    onClose: () => {},
    now: () => 0,
  })
  for (const width of [20, 32, 40, 60, 80, 120, 160]) {
    const lines = overlay.render(width)
    assertWidths(lines, width, 'overlay')
  }
  const text = plain(overlay.render(120)).join('\n')
  assert.ok(text.includes('incomplete catalog'))
  assert.ok(text.includes('并行子代理 🚀'))
  assert.ok(text.includes('unknown mode'))
  assert.ok(text.includes('unknown'))
  assert.ok(!text.includes('tok'), 'no token metric was supplied, so none is painted')
  // A bare entry refresh cannot silently erase a native truncation notice.
  overlay.setEntries([
    entry({ id: 'cjk', parentSessionId: 's1', label: '并行子代理 🚀', mode: 'continuable', status: 'running', lastActivity: '读取 中文路径', catalogSeq: 2 }),
  ])
  assert.equal(overlay.truncated, true)
  overlay.setEntries(overlay.entries, { truncated: false })
  assert.equal(overlay.truncated, false)
})

test('overlay mouse clicks select and open; wheel is handled', () => {
  const tui = createFakeTui(24, 80)
  const opened: SubagentEntry[] = []
  const overlay = new AgentsOverlay(asTui(tui), {
    entries: overlayEntries(),
    keymap: keymap(),
    onClose: () => {},
    onOpen: value => opened.push(value),
  })
  const lines = overlay.render(80)
  const row = plain(lines).findIndex(line => line.includes('Review'))
  assert.ok(row >= 0)
  overlay.handleMouse(mouse('press', 2, row))
  overlay.handleMouse(mouse('click', 2, row))
  assert.deepEqual(opened.map(value => value.id), ['root-idle'])
  assert.deepEqual(overlay.handleMouse({ ...mouse('click', 1, 1), type: 'wheel', wheelDelta: 1 }), { handled: true, render: true })
})

test('overlay focus is preserved across updates and short/fullscreen viewports degrade safely', () => {
  const tui = createFakeTui(6, 30)
  const overlay = new AgentsOverlay(asTui(tui), {
    entries: overlayEntries(),
    keymap: keymap(),
    onClose: () => {},
    maxHeight: 6,
  })
  overlay.focused = true
  overlay.setEntry(entry({ id: 'root-run', parentSessionId: 's1', createdAt: 1, mode: 'continuable', status: 'running', label: 'Explore', lastActivity: 'still working' }))
  assert.equal(overlay.focused, true)
  const lines = overlay.render(30)
  assert.ok(lines.length <= 6)
  assertWidths(lines, 30, 'overlay compact')
  overlay.focused = false
  assert.equal(overlay.focused, false)
  assert.equal(overlay.isDisposed, false)
  overlay.focused = true
  assert.equal(overlay.focused, true)
})

test('child view focus/dispose never closes, and a short inline viewport keeps identity plus close', () => {
  const harness = childHarness({ maxHeight: 6 })
  harness.child.focused = true
  harness.child.update({})
  assert.equal(harness.child.focused, true)
  const lines = harness.child.render(60)
  assert.ok(lines.length <= 6)
  assertWidths(lines, 60, 'child view compact')
  const text = plain(lines).join('\n')
  assert.ok(text.includes('Agents'))
  assert.ok(text.includes('close') || text.includes('read-only'))
  harness.child.focused = false
  assert.deepEqual(harness.closed, [])
})

test('overlay and child view create no hidden timers', () => {
  const originalSetInterval = globalThis.setInterval
  let intervals = 0
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    intervals += 1
    return originalSetInterval(...args)
  }) as typeof setInterval
  try {
    const tui = createFakeTui(30, 80)
    const overlay = new AgentsOverlay(asTui(tui), { entries: overlayEntries(), keymap: keymap(), onClose: () => {}, now: () => 1 })
    overlay.render(80)
    overlay.handleInput(DOWN)
    const child = childHarness()
    child.view.render(80)
    child.child.render(80)
    overlay.dispose()
    child.child.dispose()
  } finally {
    globalThis.setInterval = originalSetInterval
  }
  assert.equal(intervals, 0)
})

// ---------------------------------------------------------------------------
// Child Session view

function childHarness(options: {
  entry?: SubagentEntry
  events?: SessionEvent[]
  rows?: number
  maxHeight?: number
  onClose?: () => void
  onInterrupt?: () => void
  onReply?: (entry: SubagentEntry) => void
  onStop?: (entry: SubagentEntry) => void
  onGlobalAction?: (id: string) => void
  now?: () => number
  loading?: boolean
} = {}) {
  const tui = createFakeTui(options.rows ?? 32, 100)
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info(options.events ?? [
    ev('turn/start', 1, { turn: 1 }),
    ev('user/message', 2, user('child task')),
    assistant(3, 'child answer 中文'),
    ev('turn/end', 4, { turn: 1 }),
  ]))
  const view = new TranscriptView(store, viewOptions())
  const closed: string[] = []
  const globals: string[] = []
  const replies: string[] = []
  const stops: string[] = []
  const child = new ChildSessionView(asTui(tui), {
    entry: options.entry ?? entry({
      id: 'child-1',
      parentSessionId: 's1',
      mode: 'continuable',
      status: 'running',
      label: 'Explore repository',
      provider: DEMO_PROVIDER,
      model: DEMO_MODEL,
      totalTokens: 12_000,
      timing: { settledMs: 60_000 },
    }),
    store,
    view,
    keymap: keymap(),
    onClose: () => { closed.push('close'); options.onClose?.() },
    ...(options.onInterrupt === undefined ? {} : { onInterrupt: options.onInterrupt }),
    ...(options.onReply === undefined ? {} : { onReply: (value: SubagentEntry) => { replies.push(value.id); options.onReply?.(value) } }),
    ...(options.onStop === undefined ? {} : { onStop: (value: SubagentEntry) => { stops.push(value.id); options.onStop?.(value) } }),
    onGlobalAction: id => { globals.push(id); options.onGlobalAction?.(id) },
    ...(options.maxHeight === undefined ? {} : { maxHeight: options.maxHeight }),
    now: options.now ?? (() => 100_000),
    ...(options.loading === undefined ? {} : { loading: options.loading }),
  })
  child.focused = true
  return { tui, store, view, child, closed, globals, replies, stops }
}

test('child view frames the read-only conversation with breadcrumb, native status, model and session totals', () => {
  const harness = childHarness()
  const lines = harness.child.render(100)
  assertWidths(lines, 100, 'child view')
  const text = plain(lines).join('\n')
  assert.ok(text.includes('Agents'))
  assert.ok(text.includes('s1'))
  assert.ok(text.includes('Explore repository'))
  assert.ok(text.includes('running'))
  assert.ok(text.includes('continuable'))
  assert.ok(text.includes(`${DEMO_PROVIDER}/${DEMO_MODEL}`))
  assert.ok(text.includes('12k tok'))
  assert.ok(text.includes('1m 0s'))
  assert.ok(text.includes('child task'))
  assert.ok(text.includes('child answer 中文'))
  assert.ok(text.includes('read-only'))
  assert.ok(!text.includes('╭'), 'no composer frame')
})

test('child view is genuinely read-only: typing and parent actions do nothing; Esc closes', () => {
  const harness = childHarness()
  const before = harness.child.store.items.length
  for (const key of ['a', 'hello', '\t', SHIFT_TAB, CTRL_O, '?']) harness.child.handleInput(key)
  assert.equal(harness.child.store.items.length, before)
  assert.deepEqual(harness.closed, [])
  harness.child.handleInput(ESC)
  assert.deepEqual(harness.closed, ['close'])
})

test('child view forwards global quit but never parent model/tool/settings actions', () => {
  const harness = childHarness()
  harness.child.handleInput(CTRL_D)
  assert.deepEqual(harness.globals, ['app.exit'])
  assert.deepEqual(harness.closed, [])
  for (const key of [SHIFT_TAB, CTRL_O]) harness.child.handleInput(key)
  assert.deepEqual(harness.globals, ['app.exit'])
})

test('child view scrolls the conversation with list keys and the wheel', () => {
  const events: SessionEvent[] = [ev('user/message', 1, user('first'))]
  for (let index = 0; index < 80; index += 1) events.push(assistant(index + 2, `line ${index} 中文`))
  const harness = childHarness({ events, rows: 16 })
  harness.child.render(80)
  const before = harness.child.render(80)
  assert.ok(before.length <= 14)
  harness.child.handleInput(HOME)
  const top = plain(harness.child.render(80)).join('\n')
  assert.ok(top.includes('first'))
  harness.child.handleInput(END)
  const end = plain(harness.child.render(80)).join('\n')
  assert.ok(end.includes('line 79'))
  const handled = harness.child.handleMouse({ ...mouse('click', 1, 1), type: 'wheel', wheelDelta: -1 })
  assert.deepEqual(handled, { handled: true, render: true })
})

test('child view external tasks show no local transcript, and short viewports degrade safely', () => {
  const external = childHarness({
    entry: entry({ id: 'ext', parentSessionId: 's1', mode: 'external', status: 'external', label: 'External research' }),
    maxHeight: 8,
    loading: true, // Even a stray presentation hint must not promise a local read.
  })
  const text = plain(external.child.render(50)).join('\n')
  assert.ok(text.includes('External task'))
  assert.ok(text.includes('no local transcript'))
  assert.ok(!text.includes('Loading child session'))
  const full = childHarness({ entry: external.child.entry, loading: true })
  const fullText = plain(full.child.render(100)).join('\n')
  assert.ok(fullText.includes('no local Session transcript'))
  assert.ok(!fullText.includes('Loading child session'))
  assert.ok(!fullText.includes('No messages in this agent session'))
  assert.ok(!fullText.includes('child answer'))
  for (const width of [16, 24, 40]) {
    const lines = external.child.render(width)
    assertWidths(lines, width, 'external child compact')
  }
  // The supplied child transcript is never painted for an external row.
  assert.ok(!text.includes('child answer'))
})

test('child view loading shell states the pending read and keeps the native chrome', () => {
  const harness = childHarness({ loading: true })
  const lines = harness.child.render(100)
  assertWidths(lines, 100, 'loading child view')
  const text = plain(lines).join('\n')
  assert.ok(text.includes('Loading child session…'), text)
  assert.ok(!text.includes('No messages in this agent session'), 'loading never claims an empty conversation')
  assert.ok(!text.includes('child answer 中文'), 'the conversation is not painted while loading')
  // Header/footer chrome and intervention gating are the normal ones.
  assert.ok(text.includes('Explore repository'))
  assert.ok(text.includes('running'))
  assert.ok(text.includes('continuable'))
  assert.ok(text.includes('12k tok'))
  // Scrolling stays inert until the native snapshot arrives.
  const before = harness.child.render(100)
  harness.child.handleInput(END)
  harness.child.handleInput(PAGE_DOWN)
  assert.deepEqual(plain(harness.child.render(100)), plain(before))
  assert.equal(
    harness.child.handleMouse({ ...mouse('click', 1, 1), type: 'wheel', wheelDelta: -1 }),
    undefined,
    'wheel navigation is inert while loading',
  )
  // Clearing the shell paints the real conversation again; Esc still closes.
  harness.child.setLoading(false)
  const loaded = plain(harness.child.render(100)).join('\n')
  assert.ok(!loaded.includes('Loading child session…'))
  assert.ok(loaded.includes('child answer 中文'))
  harness.child.handleInput(ESC)
  assert.deepEqual(harness.closed, ['close'])
})

test('child view loading switch is idempotent and keeps the optional native info path', () => {
  const harness = childHarness()
  harness.child.setLoading(true)
  assert.equal(harness.child.loading, true)
  const first = harness.child.render(80)
  harness.child.setLoading(true)
  assert.deepEqual(harness.child.render(80), first, 'setting the same value changes nothing')
  // The parent still supplies the real native snapshot through update({info}).
  harness.child.update({ info: { sessionId: 'child-1', cwd: '/tmp', provider: 'native-p', model: 'native-m', capabilities: [] } })
  assert.equal(harness.child.info?.sessionId, 'child-1')
  harness.child.setLoading(false)
  assert.equal(harness.child.loading, false)
  const text = plain(harness.child.render(80)).join('\n')
  assert.ok(!text.includes('Loading child session…'))
  assert.ok(text.includes('child answer'))
  assert.equal(harness.child.info?.provider, 'native-p')

  // A short viewport keeps the compact frame and still states the pending read.
  const compact = childHarness({ rows: 9, maxHeight: 8 })
  compact.child.setLoading(true)
  const compactText = plain(compact.child.render(60)).join('\n')
  assert.ok(compactText.includes('Loading child session…'), compactText)
  assert.ok(!compactText.includes('No messages in this agent session'))
  assert.ok(compactText.includes('Explore repository'))
})

test('child view dispose is idempotent, never closes, and releases the owned view', () => {
  const harness = childHarness()
  let disposed = 0
  const original = harness.view.dispose.bind(harness.view)
  harness.view.dispose = () => { disposed += 1; original() }
  harness.child.dispose()
  harness.child.dispose()
  assert.equal(disposed, 1)
  assert.deepEqual(harness.closed, [])
  assert.deepEqual(harness.child.render(80), [])
})

test('child view timing advances from injected now without an interval', () => {
  const clock = { value: 60_000 }
  const harness = childHarness({
    entry: entry({
      id: 'live',
      parentSessionId: 's1',
      mode: 'continuable',
      status: 'running',
      label: 'Live child',
      timing: { activeSince: 0 },
    }),
    now: () => clock.value,
  })
  const first = plain(harness.child.render(80)).join('\n')
  assert.ok(first.includes('1m 0s'))
  clock.value = 120_000
  const second = plain(harness.child.render(80)).join('\n')
  assert.ok(second.includes('2m 0s'))
})

// ---------------------------------------------------------------------------
// Demo fixtures

test('demo subagent fixture is deterministic: parallel children, triggers, child snapshot and follow', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const events: BackendEvent[] = []
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  backend.onEvent(event => {
    events.push(event)
    store.handle(event)
  })
  await backend.connect()
  await backend.send('please show the subagents')
  await backend.whenIdle()

  const snapshots = events.filter((event): event is Extract<BackendEvent, { type: 'subagents' }> => event.type === 'subagents')
  assert.equal(snapshots.length, 1)
  const entries = snapshots[0]?.value.entries ?? []
  // The initial snapshot is a settled/idle catalog; the live upsert below
  // reactivates the continuable child without appending a second row.
  assert.deepEqual(entries.map(row => row.status).sort(), ['completed', 'external', 'failed', 'idle', 'idle'])
  assert.equal(entries.filter(row => row.parentSessionId === 'demo-session-1').length, 4)
  const explore = entries.find(row => row.id === 'demo-child-explore')
  assert.equal(explore?.mode, 'continuable')
  assert.equal(explore?.catalogSeq !== undefined, true)
  const external = entries.find(row => row.id === 'demo-child-external')
  assert.equal(external?.mode, 'external')
  assert.equal(external?.catalogSeq, undefined, 'cold external row stays out of the ordered transcript')

  const upserts = events.filter((event): event is Extract<BackendEvent, { type: 'subagent' }> => event.type === 'subagent')
  assert.equal(upserts.length, 1)
  assert.equal(upserts[0]?.value.status, 'running')
  assert.equal(upserts[0]?.value.lastActivity, 'reading src/state/transcript.ts')

  const durable = events.flatMap(event => event.type === 'session_event' ? [event.event] : [])
  const settlement = durable.find(event => event.type === 'user/message' && typeof event.data === 'object' && event.data !== null && (event.data as Record<string, unknown>).source !== undefined && ((event.data as Record<string, unknown>).source as Record<string, unknown>).kind === 'subagent-settled')
  const agentMessage = durable.find(event => event.type === 'user/message' && typeof event.data === 'object' && event.data !== null && (event.data as Record<string, unknown>).source !== undefined && ((event.data as Record<string, unknown>).source as Record<string, unknown>).kind === 'agent-message')
  assert.ok(settlement !== undefined)
  assert.ok(agentMessage !== undefined)
  assert.ok(store.items.some(item => item.kind === 'subagent'))
  assert.equal(store.items.filter(item => item.kind === 'subagent').length, 3, 'only direct anchored children')
  assert.equal(store.items.filter(item => item.kind === 'subagent-message').length, 2)

  const child = await backend.command('subagent-session', { sessionId: 'demo-child-explore' }) as SessionInfo
  assert.equal(child.sessionId, 'demo-child-explore')
  assert.equal(child.provider, DEMO_PROVIDER)
  assert.ok((child.events ?? []).some(event => event.type === 'assistant/message'))
  const childStore = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  childStore.reset(child)
  assert.ok(childStore.items.some(item => item.kind === 'assistant'))

  const follow = await backend.command('subagent-follow', { sessionId: 'demo-child-explore', follow: true }) as Record<string, unknown>
  assert.deepEqual(follow, {
    sessionId: 'demo-child-explore',
    follow: true,
    following: false,
    supported: false,
    demo: true,
  })
  await assert.rejects(
    () => backend.command('subagent-session', { sessionId: 'demo-child-external' }),
    /no local transcript/,
  )
  await backend.close()
})

test('demo subagent events are replay-safe through the shared store', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  backend.onEvent(event => store.handle(event))
  await backend.connect()
  await backend.send('subagent replay')
  await backend.whenIdle()
  const infoValue = backend.info
  assert.ok(infoValue.subagents !== undefined)
  const replay = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  replay.reset(infoValue)
  const before = replay.items.map(item => item.kind)
  replay.reset(infoValue)
  assert.deepEqual(replay.items.map(item => item.kind), before)
  assert.equal(replay.items.filter(item => item.kind === 'subagent').length, 3)
  assert.equal(replay.items.filter(item => item.kind === 'subagent-message').length, 2)
  await backend.close()
})

test('demo hint advertises the subagent fixture without adding a model capability', () => {
  assert.ok(DEMO_HINTS.some(hint => hint.includes('subagent')))
})

test('demo subagent-many scenario adds only live continuable overflow rows', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  backend.onEvent(event => store.handle(event))
  await backend.connect()
  await backend.send('subagent-many')
  await backend.whenIdle()

  const entries = store.subagentEntries
  assert.equal(entries.length, 8, 'the default five-row fixture plus three live extras')
  const active = entries.filter(row => row.status === 'running' || row.status === 'initializing')
  assert.deepEqual(active.map(row => row.label), [
    'Explore repository', 'Search callers', 'Audit fixtures', 'Map adapters',
  ])
  for (const row of active.slice(1)) {
    assert.equal(row.mode, 'continuable')
    assert.equal(row.local, true)
    assert.equal(row.parentSessionId, 'demo-session-1')
    assert.equal(row.catalogSeq, undefined, 'a fixture-only extra invents no transcript anchor')
    assert.equal(row.totalTokens, undefined, 'no session total the fixture did not observe')
    assert.equal(row.timing, undefined)
    assert.ok((row.lastActivity ?? '').length > 0, 'a live row carries its current fixture activity')
  }
  // The default durable transcript anchors are unchanged: extras add no rows.
  assert.equal(store.items.filter(item => item.kind === 'subagent').length, 3)
  assert.equal(store.items.filter(item => item.kind === 'subagent-message').length, 2)

  // Active-only progress: four live rows overflow a bounded budget as live only.
  const progress = new SubagentProgress({ keymap: keymap(), maxRows: 6 })
  progress.entries = store.subagentEntries
  const lines = plain(progress.render(100))
  assert.equal(lines[0], '● Agents · 4 children · Ctrl+X Ctrl+A open')
  assert.ok(lines.includes('└─ +2 more (2 running)'), lines.join('\n'))
  assert.ok(!lines.join('\n').includes('Review changes'), 'settled fixture history is never progress')
  progress.dispose()

  // The extra rows are real fixture catalogue children: their read path works.
  const child = await backend.command('subagent-session', { sessionId: 'demo-child-active-2' }) as SessionInfo
  assert.equal(child.sessionId, 'demo-child-active-2')
  await backend.close()
})

// ---------------------------------------------------------------------------
// Native intervention: Reply / Stop gating (pure helpers)

test('reply/stop gating covers every native mode/status/locality combination', () => {
  const modes = ['one-shot', 'continuable', 'external', 'unknown'] as const
  const statuses = ['initializing', 'running', 'idle', 'completed', 'failed', 'stopped', 'max-tokens', 'refusal', 'unknown', 'external'] as const
  for (const mode of modes) {
    for (const status of statuses) {
      for (const local of [true, false, undefined] as const) {
        const value = entry({ mode, status, ...(local === undefined ? {} : { local }) })
        const localTranscript = mode !== 'external' && status !== 'external' && local !== false
        assert.equal(
          subagentCanReply(value),
          localTranscript && mode === 'continuable',
          `reply gate: ${mode}/${status}/local=${String(local)}`,
        )
        assert.equal(
          subagentCanStop(value),
          localTranscript && (status === 'running' || status === 'initializing'),
          `stop gate: ${mode}/${status}/local=${String(local)}`,
        )
      }
    }
  }
  // Activity prose never decides gating: only native status/mode/locality do.
  assert.equal(subagentCanStop(entry({ status: 'idle', lastActivity: 'working' })), false)
  assert.equal(subagentCanStop(entry({ status: 'stopped', lastActivity: 'reading' })), false)
  assert.equal(subagentCanReply(entry({ mode: 'one-shot', status: 'idle' })), false)
  assert.equal(subagentCanReply(entry({ mode: 'continuable', status: 'stopped' })), true)
})

// ---------------------------------------------------------------------------
// Agents overlay: Reply / Stop requests

function interventionEntries(): SubagentEntry[] {
  return [
    entry({ id: 'live', parentSessionId: 's1', createdAt: 1, mode: 'continuable', status: 'running', label: 'Explore' }),
    entry({ id: 'settled', parentSessionId: 's1', createdAt: 2, mode: 'continuable', status: 'completed', label: 'Review' }),
    entry({ id: 'once', parentSessionId: 's1', createdAt: 3, mode: 'one-shot', status: 'running', label: 'Build' }),
    entry({ id: 'ext', parentSessionId: 's1', createdAt: 4, mode: 'external', status: 'external', label: 'External' }),
  ]
}

function selectRow(overlay: AgentsOverlay, id: string): void {
  const rows = flattenSubagentTree(buildSubagentTree(overlay.entries))
  const index = rows.findIndex(node => node.entry.id === id)
  assert.ok(index >= 0, `row ${id} exists`)
  const current = rows.findIndex(node => node.entry.id === overlay.selectedEntry?.id)
  const delta = index - current
  for (let step = 0; step < Math.abs(delta); step += 1) overlay.handleInput(delta > 0 ? DOWN : UP)
  assert.equal(overlay.selectedEntry?.id, id)
}

test('overlay requests reply/stop through the shared keymap, gated by the native row', () => {
  const tui = createFakeTui(30, 100)
  const replies: string[] = []
  const stops: string[] = []
  const overlay = new AgentsOverlay(asTui(tui), {
    entries: interventionEntries(),
    keymap: keymap(),
    onClose: () => {},
    onReply: value => replies.push(value.id),
    onStop: value => stops.push(value.id),
  })
  overlay.focused = true
  const replyKey = actionKeys('subagent.reply')
  const stopKey = actionKeys('subagent.interrupt')
  const press = (key: { raw: string }): void => overlay.handleInput(key.raw)

  // running continuable: both requests are available and advertised.
  selectRow(overlay, 'live')
  let text = plain(overlay.render(100)).join('\n')
  assert.ok(text.includes(`[${replyKey.label}] reply`), 'reply hint comes from the keymap')
  assert.ok(text.includes(`[${stopKey.label}] stop`), 'stop hint comes from the keymap')
  press(replyKey)
  press(stopKey)
  assert.deepEqual(replies, ['live'])
  assert.deepEqual(stops, ['live'])

  // completed continuable: reply only.
  selectRow(overlay, 'settled')
  text = plain(overlay.render(100)).join('\n')
  assert.ok(text.includes('reply'))
  assert.ok(!text.includes('stop'), 'a finished child is never advertised as stoppable')
  press(stopKey)
  press(replyKey)
  assert.deepEqual(stops, ['live'], 'stop on a completed child is inert')
  assert.deepEqual(replies, ['live', 'settled'])

  // running one-shot: stop only, never reply.
  selectRow(overlay, 'once')
  text = plain(overlay.render(100)).join('\n')
  assert.ok(text.includes('stop'))
  assert.ok(!text.includes('reply'), 'a one-shot child cannot receive a follow-up prompt')
  press(replyKey)
  press(stopKey)
  assert.deepEqual(replies, ['live', 'settled'], 'reply on a one-shot child is inert')
  assert.deepEqual(stops, ['live', 'once'])

  // external leaf: neither.
  selectRow(overlay, 'ext')
  text = plain(overlay.render(100)).join('\n')
  assert.ok(!text.includes('reply'))
  assert.ok(!text.includes('stop'))
  press(replyKey)
  press(stopKey)
  assert.deepEqual(replies, ['live', 'settled'])
  assert.deepEqual(stops, ['live', 'once'])
})

test('overlay action hints and keys follow shared keymap remap and disable', () => {
  const tui = createFakeTui(30, 100)
  const replies: string[] = []
  const stops: string[] = []
  const remapped = new input.CcKeymap({ bindings: { 'subagent.reply': 'p', 'subagent.interrupt': null } })
  const overlay = new AgentsOverlay(asTui(tui), {
    entries: interventionEntries(),
    keymap: remapped,
    onClose: () => {},
    onReply: value => replies.push(value.id),
    onStop: value => stops.push(value.id),
  })
  overlay.focused = true
  selectRow(overlay, 'live')
  const text = plain(overlay.render(100)).join('\n')
  const remappedLabel = input.formatBinding(['p'])
  assert.ok(text.includes(`[${remappedLabel}] reply`), 'the remapped key is advertised')
  assert.ok(!text.includes('stop'), 'a disabled action is not advertised')
  overlay.handleInput('p')
  assert.deepEqual(replies, ['live'])
  // The old default and the disabled action are both dead keys.
  for (const key of ['r', 's']) overlay.handleInput(key)
  assert.deepEqual(replies, ['live'])
  assert.deepEqual(stops, [])
})

test('overlay without reply/stop callbacks is inert and paints no action chips', () => {
  const tui = createFakeTui(30, 100)
  const closed: string[] = []
  const overlay = new AgentsOverlay(asTui(tui), {
    entries: interventionEntries(),
    keymap: keymap(),
    onClose: () => closed.push('close'),
  })
  overlay.focused = true
  selectRow(overlay, 'live')
  const lines = plain(overlay.render(100))
  const text = lines.join('\n')
  assert.ok(!text.includes('reply'))
  assert.ok(!text.includes('stop'))
  overlay.handleInput(actionKeys('subagent.reply').raw)
  overlay.handleInput(actionKeys('subagent.interrupt').raw)
  // Every cell of the frame is inert for interaction (rows still open, footer
  // does not), and nothing closed the modal.
  const footerRow = lines.length - 1
  for (let col = 0; col < 100; col += 1) {
    overlay.handleMouse(mouse('press', col, footerRow))
    overlay.handleMouse(mouse('click', col, footerRow))
  }
  assert.deepEqual(closed, [])
  assert.equal(overlay.isDisposed, false)
})

test('overlay Reply/Stop chips are clickable and a vanished chip cannot fire', () => {
  const tui = createFakeTui(30, 100)
  const replies: string[] = []
  const stops: string[] = []
  const overlay = new AgentsOverlay(asTui(tui), {
    entries: interventionEntries(),
    keymap: keymap(),
    onClose: () => {},
    onReply: value => replies.push(value.id),
    onStop: value => stops.push(value.id),
  })
  selectRow(overlay, 'live')
  const lines = plain(overlay.render(100))
  const footerRow = lines.findIndex(line => line.includes('reply') && line.includes('stop'))
  assert.ok(footerRow >= 0, 'the selected child footer carries both actions')
  const replyCol = (lines[footerRow] ?? '').indexOf('reply')
  const stopCol = (lines[footerRow] ?? '').indexOf('stop')
  assert.ok(replyCol > 0 && stopCol > replyCol)

  overlay.handleMouse(mouse('press', replyCol, footerRow))
  overlay.handleMouse(mouse('click', replyCol, footerRow))
  assert.deepEqual(replies, ['live'])
  overlay.handleMouse(mouse('press', stopCol, footerRow))
  overlay.handleMouse(mouse('click', stopCol, footerRow))
  assert.deepEqual(stops, ['live'])

  // Press a chip, then lose it (selection moves to a row without actions):
  // the pinned region is dropped, so the click cannot run a hidden action.
  overlay.handleMouse(mouse('press', replyCol, footerRow))
  selectRow(overlay, 'ext')
  const after = plain(overlay.render(100))
  assert.ok(!(after[footerRow] ?? '').includes('reply'))
  overlay.handleMouse(mouse('click', replyCol, after.length - 1))
  assert.deepEqual(replies, ['live'], 'no hidden chip fired')
})

test('overlay Ctrl+C stops the active child first, then falls back to interrupt/close', () => {
  const tui = createFakeTui(30, 100)
  const stops: string[] = []
  const interrupts: string[] = []
  const closed: string[] = []
  const overlay = new AgentsOverlay(asTui(tui), {
    entries: interventionEntries(),
    keymap: keymap(),
    onClose: () => closed.push('close'),
    onStop: value => stops.push(value.id),
    onInterrupt: () => interrupts.push('interrupt'),
  })
  overlay.focused = true
  selectRow(overlay, 'live')
  overlay.handleInput(CTRL_C)
  assert.deepEqual(stops, ['live'], 'Ctrl+C stops a stoppable child instead of closing')
  assert.equal(closed.length, 0)
  selectRow(overlay, 'settled')
  overlay.handleInput(CTRL_C)
  assert.deepEqual(interrupts, ['interrupt'], 'a settled row keeps the interrupt fallback')
  selectRow(overlay, 'live')
  overlay.handleInput(ESC)
  assert.deepEqual(closed, ['close'], 'Esc always closes and never stops')
  assert.deepEqual(stops, ['live'])

  // Without onStop, Ctrl+C keeps the historical close behavior.
  const plainOverlay = new AgentsOverlay(asTui(createFakeTui(30, 100)), {
    entries: interventionEntries(),
    keymap: keymap(),
    onClose: () => closed.push('closed-plain'),
  })
  plainOverlay.handleInput(CTRL_C)
  assert.deepEqual(closed, ['close', 'closed-plain'])
})

test('narrow or short overlays omit action chips and keep no invisible hitbox', () => {
  const tui = createFakeTui(30, 100)
  const replies: string[] = []
  const stops: string[] = []
  const overlay = new AgentsOverlay(asTui(tui), {
    entries: interventionEntries(),
    keymap: keymap(),
    onClose: () => {},
    onReply: value => replies.push(value.id),
    onStop: value => stops.push(value.id),
  })
  selectRow(overlay, 'live')
  for (const width of [12, 20, 28, 34]) {
    const lines = overlay.render(width)
    assertWidths(lines, width, 'narrow overlay')
    const text = plain(lines).join('\n')
    assert.ok(!text.includes('reply'), `width ${width} does not advertise a clipped action`)
    assert.ok(!text.includes('stop'), `width ${width} does not advertise a clipped action`)
    for (let row = 0; row < lines.length; row += 1) {
      for (let col = 0; col < width; col += 1) {
        overlay.handleMouse(mouse('press', col, row))
        overlay.handleMouse(mouse('click', col, row))
      }
    }
  }
  // The narrow sweep may have opened rows (Enter/open semantics), but it must
  // never have triggered an intervention the user cannot see.
  assert.equal(replies.length, 0)
  assert.deepEqual(stops, [])

  const short = new AgentsOverlay(asTui(createFakeTui(6, 30)), {
    entries: interventionEntries(),
    keymap: keymap(),
    onClose: () => {},
    onReply: value => replies.push(value.id),
    maxHeight: 6,
  })
  const compact = short.render(30)
  assert.ok(compact.length <= 6)
  assert.ok(!plain(compact).join('\n').includes('reply'))
  for (let row = 0; row < compact.length; row += 1) {
    for (let col = 0; col < 30; col += 1) {
      short.handleMouse(mouse('press', col, row))
      short.handleMouse(mouse('click', col, row))
    }
  }
  // A click may open the selected child; it never replies.
  assert.deepEqual(replies, [])
})

test('dispose releases overlay action hitboxes', () => {
  const replies: string[] = []
  const overlay = new AgentsOverlay(asTui(createFakeTui(30, 100)), {
    entries: interventionEntries(),
    keymap: keymap(),
    onClose: () => {},
    onReply: value => replies.push(value.id),
  })
  selectRow(overlay, 'live')
  const lines = plain(overlay.render(100))
  const row = lines.findIndex(line => line.includes('reply'))
  const col = (lines[row] ?? '').indexOf('reply')
  overlay.dispose()
  overlay.handleMouse(mouse('press', col, row))
  overlay.handleMouse(mouse('click', col, row))
  assert.deepEqual(replies, [])
})

// ---------------------------------------------------------------------------
// Child Session view: Reply / Stop requests

test('child view reply asks the parent to return to its main Editor and creates no editor', () => {
  const harness = childHarness({ onReply: () => {}, onStop: () => {} })
  const before = harness.store.items.length
  const lines = harness.child.render(100)
  assertWidths(lines, 100, 'child view actions')
  const text = plain(lines).join('\n')
  const replyKey = actionKeys('subagent.reply')
  const stopKey = actionKeys('subagent.interrupt')
  assert.ok(text.includes(`[${replyKey.label}] reply`))
  assert.ok(text.includes(`[${stopKey.label}] stop`))
  assert.ok(!text.includes('read-only'), 'an intervention-capable surface is not labelled read-only')
  assert.ok(!text.includes('╭'), 'no composer is created inside the child view')
  harness.child.handleInput(replyKey.raw)
  assert.deepEqual(harness.replies, ['child-1'])
  assert.equal(harness.store.items.length, before, 'reply does not write into the child transcript')
  assert.deepEqual(harness.closed, [], 'the parent owns where the reply goes')
  assert.equal(harness.child.isDone, false)
})

test('child view stops only an active local child; Esc closes without stopping', () => {
  const harness = childHarness({ onStop: () => {}, onReply: () => {}, onInterrupt: () => {} })
  const stopKey = actionKeys('subagent.interrupt')
  harness.child.handleInput(stopKey.raw)
  assert.deepEqual(harness.stops, ['child-1'], 'a running local child can be stopped')
  harness.child.handleInput(CTRL_C)
  assert.deepEqual(harness.stops, ['child-1', 'child-1'], 'Ctrl+C stops the active child')
  assert.deepEqual(harness.closed, [])
  harness.child.handleInput(ESC)
  assert.deepEqual(harness.closed, ['close'], 'Esc always closes')
  assert.deepEqual(harness.stops, ['child-1', 'child-1'], 'Esc never stops the child')

  // A settled child: stop is inert, Ctrl+C falls back to interrupt/close.
  const interrupts: string[] = []
  const settled = childHarness({
    entry: entry({ id: 'settled', parentSessionId: 's1', mode: 'continuable', status: 'completed', label: 'Review' }),
    onStop: () => {},
    onReply: () => {},
    onInterrupt: () => interrupts.push('interrupt'),
  })
  const text = plain(settled.child.render(100)).join('\n')
  assert.ok(!text.includes('stop'))
  assert.ok(text.includes('reply'), 'a completed continuable child can still be replied to')
  settled.child.handleInput(stopKey.raw)
  assert.deepEqual(settled.stops, [])
  settled.child.handleInput(CTRL_C)
  assert.deepEqual(interrupts, ['interrupt'])

  // External task: no local Agent, so no intervention at all.
  const external = childHarness({
    entry: entry({ id: 'ext', parentSessionId: 's1', mode: 'external', status: 'external', label: 'External' }),
    onStop: () => {},
    onReply: () => {},
    onInterrupt: () => interrupts.push('external-interrupt'),
  })
  const externalText = plain(external.child.render(100)).join('\n')
  assert.ok(!externalText.includes('reply'))
  assert.ok(!externalText.includes('stop'))
  external.child.handleInput(actionKeys('subagent.reply').raw)
  external.child.handleInput(stopKey.raw)
  assert.deepEqual(external.replies, [])
  assert.deepEqual(external.stops, [])
})

test('child view without callbacks is inert; the footer still says read-only', () => {
  const harness = childHarness()
  const text = plain(harness.child.render(100)).join('\n')
  assert.ok(text.includes('read-only'))
  assert.ok(!text.includes('reply'))
  assert.ok(!text.includes('stop'))
  harness.child.handleInput(actionKeys('subagent.reply').raw)
  harness.child.handleInput(actionKeys('subagent.interrupt').raw)
  assert.deepEqual(harness.replies, [])
  assert.deepEqual(harness.stops, [])
  assert.deepEqual(harness.closed, [])
})

test('child view action chips are clickable and a narrow footer paints none', () => {
  const harness = childHarness({ onReply: () => {}, onStop: () => {} })
  const lines = plain(harness.child.render(100))
  const row = lines.findIndex(line => line.includes('reply') && line.includes('stop'))
  assert.ok(row >= 0)
  const replyCol = (lines[row] ?? '').indexOf('reply')
  const stopCol = (lines[row] ?? '').indexOf('stop')
  harness.child.handleMouse(mouse('press', replyCol, row))
  harness.child.handleMouse(mouse('click', replyCol, row))
  assert.deepEqual(harness.replies, ['child-1'])
  harness.child.handleMouse(mouse('press', stopCol, row))
  harness.child.handleMouse(mouse('click', stopCol, row))
  assert.deepEqual(harness.stops, ['child-1'])

  const narrow = childHarness({ onReply: () => {}, onStop: () => {}, rows: 20 })
  for (const width of [12, 18, 24]) {
    const compactLines = narrow.child.render(width)
    assertWidths(compactLines, width, 'narrow child view')
    assert.ok(!plain(compactLines).join('\n').includes('reply'))
    for (let lineRow = 0; lineRow < compactLines.length; lineRow += 1) {
      for (let col = 0; col < width; col += 1) {
        narrow.child.handleMouse(mouse('press', col, lineRow))
        narrow.child.handleMouse(mouse('click', col, lineRow))
      }
    }
  }
  assert.deepEqual(narrow.replies, [])
  assert.deepEqual(narrow.stops, [])
})

test('child view dispose releases action hitboxes and keeps forwarding app.exit', () => {
  const harness = childHarness({ onReply: () => {}, onStop: () => {} })
  const lines = plain(harness.child.render(100))
  const row = lines.findIndex(line => line.includes('reply'))
  const col = (lines[row] ?? '').indexOf('reply')
  harness.child.handleInput(CTRL_D)
  assert.deepEqual(harness.globals, ['app.exit'])
  harness.child.dispose()
  harness.child.handleMouse(mouse('press', col, row))
  harness.child.handleMouse(mouse('click', col, row))
  assert.deepEqual(harness.replies, [])
})

// ---------------------------------------------------------------------------
// Demo fixtures: reply / stop / reactivation

const settleDemo = async (): Promise<void> => {
  for (let tick = 0; tick < 12; tick += 1) await Promise.resolve()
}

async function demoSubagentBackend(): Promise<{ backend: DemoBackend; events: BackendEvent[] }> {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const events: BackendEvent[] = []
  backend.onEvent(event => events.push(event))
  await backend.connect()
  await backend.send('please show the subagents')
  await backend.whenIdle()
  return { backend, events }
}

test('demo advertises the native subagent commands it actually implements', async () => {
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  await backend.connect()
  for (const capability of ['subagents', 'subagent-session', 'subagent-follow', 'subagent-prompt', 'subagent-interrupt']) {
    assert.ok(backend.info.capabilities.includes(capability), `capability ${capability}`)
  }
  await backend.close()
})

test('demo subagent-prompt appends a durable reply and reactivates the continuable child', async () => {
  const { backend, events } = await demoSubagentBackend()
  const before = backend.info.subagents?.entries.find(row => row.id === 'demo-child-explore')
  assert.equal(before?.status, 'running', 'the fixture starts the continuable child in a live run')

  const receipt = await backend.command('subagent-prompt', {
    sessionId: 'demo-child-explore',
    text: '继续探索 overlay',
    delivery: 'queue',
    requestId: 'demo-request-1',
  }) as Record<string, unknown>
  assert.equal(receipt.messageId, 'demo-child-user-prompt-1')
  assert.equal(receipt.requestId, 'demo-request-1')
  assert.equal(receipt.delivery, 'queue')
  assert.equal(receipt.parentSessionId, 'demo-session-1')

  // The durable user message exists immediately ... (no optimistic UI state).
  const first = await backend.command('subagent-session', { sessionId: 'demo-child-explore' }) as SessionInfo
  const userEvent = (first.events ?? []).find(event => event.type === 'user/message' &&
    typeof event.data === 'object' && event.data !== null && (event.data as Record<string, unknown>).id === 'demo-child-user-prompt-1')
  assert.ok(userEvent !== undefined, 'the accepted message is durable in the child log')
  assert.ok(events.some(event => event.type === 'subagent' && event.value.id === 'demo-child-explore' && event.value.status === 'running'),
    'reactivation is a native-shaped live upsert')

  await settleDemo()
  const live = events.filter((event): event is Extract<BackendEvent, { type: 'session_event' }> =>
    event.type === 'session_event' && event.sessionId === 'demo-child-explore')
  assert.ok(live.some(event => event.event.type === 'assistant/message'), 'the fixture assistant reply is observed live')
  assert.ok(live.some(event => event.event.type === 'turn/end'))

  const second = await backend.command('subagent-session', { sessionId: 'demo-child-explore' }) as SessionInfo
  const answer = (second.events ?? []).filter(event => event.type === 'assistant/message')
  assert.equal(answer.length, 2, 'the durable child log keeps the original answer and the fixture reply')
  const projected = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  projected.reset(second)
  const assistantText = projected.items.flatMap(item => item.kind === 'assistant' ? [item.text ?? ''] : []).join('\n')
  assert.ok(assistantText.includes('continue') || assistantText.includes('Follow-up received') || assistantText.includes('offline fixture'))
  assert.ok(assistantText.includes('继续探索 overlay') === false)
  const userText = projected.items.flatMap(item => item.kind === 'user' ? [item.text ?? ''] : []).join('\n')
  assert.ok(userText.includes('继续探索 overlay'))

  const after = backend.info.subagents?.entries.find(row => row.id === 'demo-child-explore')
  assert.equal(after?.status, 'idle', 'a continuable fixture run settles to idle with its native stop reason')
  assert.equal(after?.timing?.lastTurnCompleted, true)
  assert.equal(after?.lastActivity, undefined, 'no stale activity is projected after the run')
  await backend.close()
})

test('demo subagent-prompt keeps image content and refuses external/one-shot children', async () => {
  const { backend } = await demoSubagentBackend()
  const image = {
    type: 'image',
    mediaType: 'image/png',
    data: 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAL0lEQVQImR3GQREAMBACsVOCEkQgGxGIWAmdaV45Omp1qo+aP3VHRqxM8RHzp+wB5tIZ8f97ukgAAAAASUVORK5CYII=',
    name: 'quadrants.png',
  }
  const receipt = await backend.command('subagent-prompt', {
    sessionId: 'demo-child-explore',
    content: [{ type: 'text', text: '请看这张图' }, image],
    delivery: 'steer',
  }) as Record<string, unknown>
  assert.equal(receipt.delivery, 'steer')
  const child = await backend.command('subagent-session', { sessionId: 'demo-child-explore' }) as SessionInfo
  const user = (child.events ?? []).find(event => event.type === 'user/message' &&
    typeof event.data === 'object' && event.data !== null && (event.data as Record<string, unknown>).id === receipt.messageId)
  const content = ((user?.data as Record<string, unknown> | undefined)?.content ?? []) as Array<Record<string, unknown>>
  assert.equal(content[0]?.type, 'text')
  assert.equal(content[1]?.type, 'image', 'the image part survives in the durable message')
  assert.equal(content[1]?.data, image.data)
  assert.equal(content[1]?.mediaType, 'image/png')

  await assert.rejects(() => backend.command('subagent-prompt', { sessionId: 'demo-child-external', text: 'hi' }), /external task/)
  await assert.rejects(() => backend.command('subagent-prompt', { sessionId: 'demo-child-review', text: 'hi' }), /one-shot|cannot receive follow-up/)
  await assert.rejects(() => backend.command('subagent-prompt', { sessionId: 'demo-child-explore', text: 'a', content: [{ type: 'text', text: 'b' }] }), /not both/)
  await assert.rejects(() => backend.command('subagent-prompt', { sessionId: 'demo-child-explore' }), /non-empty/)
  await assert.rejects(() => backend.command('subagent-prompt', { sessionId: 'demo-child-explore', text: 'hi', delivery: 'later' }), /queue.*steer|steer.*queue/)
  await assert.rejects(() => backend.command('subagent-interrupt', { sessionId: 'demo-child-external' }), /external task/)
  await backend.close()
})

test('demo subagent-interrupt projects the applicable child as stopped and allows reactivation', async () => {
  const { backend, events } = await demoSubagentBackend()
  const stopped = await backend.command('subagent-interrupt', { sessionId: 'demo-child-explore' }) as Record<string, unknown>
  assert.equal(stopped.accepted, true)
  assert.equal(stopped.stopped, true)
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.parentSessionId, 'demo-session-1')

  const entry = backend.info.subagents?.entries.find(row => row.id === 'demo-child-explore')
  assert.equal(entry?.status, 'stopped')
  assert.equal(entry?.lastStopReason, 'aborted')
  assert.equal(entry?.lastActivity, undefined, 'a stopped child shows no live activity')
  assert.ok(events.some(event => event.type === 'subagent' && event.value.id === 'demo-child-explore' && event.value.status === 'stopped'))

  // A settled child accepts the interrupt but nothing changes (native truth).
  const again = await backend.command('subagent-interrupt', { sessionId: 'demo-child-review' }) as Record<string, unknown>
  assert.equal(again.accepted, true)
  assert.equal(again.stopped, false)
  assert.equal(again.status, 'completed')

  // Native-like reactivation: a stopped continuable child can be prompted again.
  await backend.command('subagent-prompt', { sessionId: 'demo-child-explore', text: 'resume the work' })
  assert.ok(
    events.some(event => event.type === 'subagent' && event.value.id === 'demo-child-explore' && event.value.status === 'running'),
    'the prompt reactivated the stopped child with a live running upsert',
  )
  await settleDemo()
  const settledAgain = backend.info.subagents?.entries.find(row => row.id === 'demo-child-explore')
  assert.equal(settledAgain?.status, 'idle')
  await backend.close()
})

test('a demo-backed overlay drives reply/stop through the real fixture transitions', async () => {
  const { backend, events } = await demoSubagentBackend()
  const tui = createFakeTui(32, 100)
  const requests: string[] = []
  const overlay = new AgentsOverlay(asTui(tui), {
    entries: backend.info.subagents?.entries ?? [],
    keymap: keymap(),
    maxHeight: 20,
    onClose: () => {},
    onReply: value => {
      requests.push('reply:' + value.id)
      void backend.command('subagent-prompt', { sessionId: value.id, text: '继续，附上 fixup' })
    },
    onStop: value => {
      requests.push('stop:' + value.id)
      void backend.command('subagent-interrupt', { sessionId: value.id })
    },
  })
  overlay.focused = true
  const sync = (): void => {
    overlay.setSnapshot({
      entries: backend.info.subagents?.entries ?? [],
      ...(backend.info.subagents?.truncated === true ? { truncated: true } : {}),
    })
  }
  // The catalog opens on the running continuable child.
  assert.equal(overlay.selectedEntry?.id, 'demo-child-explore')
  assert.equal(overlay.selectedEntry?.status, 'running')
  overlay.handleInput(actionKeys('subagent.interrupt').raw)
  await settleDemo()
  sync()
  assert.deepEqual(requests, ['stop:demo-child-explore'])
  assert.equal(overlay.selectedEntry?.status, 'stopped')
  assert.ok(events.some(event => event.type === 'subagent' && event.value.status === 'stopped'))

  overlay.handleInput(actionKeys('subagent.reply').raw)
  await settleDemo()
  sync()
  assert.deepEqual(requests, ['stop:demo-child-explore', 'reply:demo-child-explore'])
  assert.equal(overlay.selectedEntry?.status, 'idle')
  assert.equal(overlay.selectedEntry?.timing?.lastTurnCompleted, true)

  // The child surface reads the durable reply the overlay just requested.
  const child = await backend.command('subagent-session', { sessionId: 'demo-child-explore' }) as SessionInfo
  const childStore = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  childStore.reset(child)
  const childView = new TranscriptView(childStore, viewOptions())
  const surface = new ChildSessionView(asTui(createFakeTui(32, 100)), {
    entry: overlay.selectedEntry ?? childStore.subagentEntries[0]!,
    info: child,
    store: childStore,
    view: childView,
    keymap: keymap(),
    onClose: () => {},
    onReply: () => {},
    onStop: () => {},
  })
  const text = plain(surface.render(100)).join('\n')
  assert.ok(text.includes('继续，附上 fixup'), 'the durable user message is visible in the child view')
  assert.ok(text.includes('offline fixture'), 'the durable fixture assistant reply is visible')
  surface.dispose()
  await backend.close()
})
