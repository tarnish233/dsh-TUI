// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences } from '#pi-tui'
import type { BackendEvent, SessionEvent, SessionInfo, TodoItem, TodosSnapshot } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import { TranscriptView } from '../src/ui/transcript.ts'

/**
 * Opt-in transcript suppression for the parent-hosted todo dock.
 *
 * `suppressLiveTodos` must skip ONLY the live `TodosTranscriptItem` display
 * node. The native store projection, durable tool/event rows, notices and the
 * default standalone transcript rendering stay untouched.
 */

const info = (events: SessionEvent[] = []): SessionInfo => ({
  sessionId: 's1',
  cwd: '/tmp/work',
  provider: 'demo',
  model: 'demo',
  capabilities: [],
  events,
})

const ev = (type: string, seq: number, data: unknown, extra: Partial<SessionEvent> = {}): SessionEvent => ({
  type,
  seq,
  time: 0,
  data,
  ...extra,
})

const userEvent = (seq: number, text: string): SessionEvent =>
  ev('user/message', seq, { id: `u${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, { surfaceOp: 'append' })

const callEvent = (seq: number, callId: string, command: string): SessionEvent =>
  ev('tool/call', seq, { turn: 1, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command }) })

const resultEvent = (seq: number, callId: string, text: string): SessionEvent => ev('tool/result', seq, {
  turn: 1,
  step: 1,
  message: {
    id: `res-${seq}`,
    role: 'tool',
    toolCallId: callId,
    content: [{ type: 'text', text }],
    isError: false,
    source: { kind: 'tool', callId },
  },
}, { surfaceOp: 'append' })

const PLAN: TodoItem[] = [
  { content: 'inspect the transcript cache', status: 'completed' },
  { content: 'mount the dock above the editor', status: 'in_progress' },
  { content: 'verify durable tool rows', status: 'pending' },
]

function newStore(events: SessionEvent[] = []): TranscriptStore {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info(events))
  return store
}

function todosEvent(value: TodosSnapshot): { type: 'todos'; sessionId: string; value: TodosSnapshot } {
  return { type: 'todos', sessionId: 's1', value }
}

function view(store: TranscriptStore, suppressLiveTodos?: boolean): TranscriptView {
  return new TranscriptView(store, {
    showThinking: false,
    expandTools: true,
    groupTools: false,
    ...(suppressLiveTodos === undefined ? {} : { suppressLiveTodos }),
  })
}

const text = (target: TranscriptView, width = 100): string =>
  stripTerminalSequences(target.render(width).join('\n'))

const DURABLE = [
  userEvent(1, 'please track this work'),
  callEvent(2, 'c1', 'npm test'),
  resultEvent(3, 'c1', 'all tests passed'),
]

test('default standalone rendering still paints the live checklist', () => {
  const store = newStore(DURABLE)
  store.handle(todosEvent(PLAN))
  const rendered = text(view(store))
  assert.match(rendered, /Todos · 3/)
  assert.match(rendered, /inspect the transcript cache/)
  assert.match(rendered, /mount the dock above the editor/)
  // Durable rows are present too.
  assert.match(rendered, /please track this work/)
  assert.match(rendered, /npm test/)
})

test('suppressLiveTodos skips only the todos node and keeps every durable row', () => {
  const store = newStore(DURABLE)
  store.handle(todosEvent(PLAN))
  const rendered = text(view(store, true))
  assert.ok(!rendered.includes('Todos ·'), 'no duplicate checklist heading')
  for (const todo of PLAN) assert.ok(!rendered.includes(todo.content), `suppressed ${todo.content}`)
  // User turn, tool call and tool result are untouched.
  assert.match(rendered, /please track this work/)
  assert.match(rendered, /npm test/)
  assert.match(rendered, /all tests passed/)
  // The store still holds the native projection; only the view omitted it.
  assert.equal(store.items.filter(item => item.kind === 'todos').length, 1)
})

test('native todo updates stay invisible while suppressed and reappear when re-enabled', () => {
  const store = newStore(DURABLE)
  const target = view(store, true)
  store.handle(todosEvent(PLAN))
  const hidden = text(target)
  assert.ok(!hidden.includes('Todos ·'))
  const next: TodoItem[] = [
    { content: 'first done', status: 'completed' },
    { content: 'second running', status: 'in_progress' },
  ]
  store.handle(todosEvent(next))
  assert.equal(text(target), hidden, 'a suppressed frame is not recomputed or stale')
  // Parent turns the dock off (or the feature flag flips): the same cached view
  // must evict its hidden todos block and paint the current native snapshot.
  target.options.suppressLiveTodos = false
  target.invalidate()
  const shown = text(target)
  assert.match(shown, /Todos · 2/)
  assert.match(shown, /first done/)
  assert.match(shown, /second running/)
  assert.ok(!shown.includes('mount the dock above the editor'), 'the old snapshot is not resurrected')
  // And suppressing again removes only that node.
  target.options.suppressLiveTodos = true
  target.invalidate()
  assert.ok(!text(target).includes('Todos ·'))
  assert.match(text(target), /please track this work/)
})

test('suppression leaves notices and the native todos item lifecycle intact', () => {
  const store = newStore(DURABLE)
  store.report('a native notice', 'info')
  const target = view(store, true)
  store.handle(todosEvent(PLAN))
  assert.match(text(target), /a native notice/)
  store.handle(todosEvent(null))
  assert.ok(!text(target).includes('Todos ·'))
  assert.equal(store.items.filter(item => item.kind === 'todos').length, 0, 'null still removes the store item')
  // No module-level cache survives to leak the removed checklist.
  store.handle(todosEvent([{ content: 'new native row', status: 'pending' }]))
  target.invalidate()
  assert.ok(!text(target).includes('new native row'), 'suppression is not bypassed by a new snapshot')
  target.options.suppressLiveTodos = false
  target.invalidate()
  const shown = text(target)
  assert.match(shown, /new native row/)
  assert.ok(!shown.includes('mount the dock above the editor'))
})
test('suppression is applied after grouping, so the hidden todo still breaks tool runs', () => {
  const store = newStore()
  const target = new TranscriptView(store, { showThinking: false, expandTools: true, groupTools: true, suppressLiveTodos: true })
  const live = (event: SessionEvent): BackendEvent => ({ type: 'session_event', sessionId: 's1', event })
  store.handle(live(callEvent(1, 'c1', 'one')))
  store.handle(live(resultEvent(2, 'c1', 'first output')))
  store.handle(todosEvent([{ content: 'boundary row', status: 'in_progress' }]))
  store.handle(live(callEvent(3, 'c2', 'two')))
  store.handle(live(resultEvent(4, 'c2', 'second output')))
  const rendered = text(target)
  assert.doesNotMatch(rendered, /boundary row/)
  // If suppression had filtered before grouping, the two calls would merge into
  // one `● Bash:` group. Grouping first keeps two independent cards.
  assert.doesNotMatch(rendered, /● Bash:/)
  assert.equal(rendered.split('\n').filter(line => line.trimStart().startsWith('⏺ Bash')).length, 2)
  assert.match(rendered, /one/)
  assert.match(rendered, /two/)
})
