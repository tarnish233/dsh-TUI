import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { SessionEvent, SessionInfo, TodoItem, TodosSnapshot } from '../src/backend/types.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import { TranscriptView } from '../src/ui/transcript.ts'
import { createItemBlock } from '../src/ui/blocks.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'

/**
 * DSH owns the `todos` projection: the bridge forwards the native snapshot and
 * the TUI only projects it as one live checklist block (append once, replace in
 * place, drop on null). These tests drive the store and the block directly.
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

const user = (text: string) => ({ id: `u${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

function newStore(events: SessionEvent[] = []): TranscriptStore {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info(events))
  return store
}

const todosOf = (store: TranscriptStore) => store.items.flatMap(item => (item.kind === 'todos' ? [item] : []))

function todosEvent(value: TodosSnapshot, sessionId = 's1') {
  return { type: 'todos', sessionId, value } as const
}

function view(store: TranscriptStore): TranscriptView {
  return new TranscriptView(store, { showThinking: false, expandTools: false })
}

function text(target: TranscriptView, width = 80): string {
  return stripTerminalSequences(target.render(width).join('\n'))
}

function assertWidths(target: TranscriptView, width: number): void {
  for (const line of target.render(width)) {
    assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${JSON.stringify(line)}`)
    assert.doesNotMatch(stripTerminalSequences(line), /\x1b/)
  }
}

const PLAN: TodoItem[] = [
  { content: 'Read the current resume flow', status: 'completed' },
  { content: 'Extract the picker scope filter', status: 'in_progress' },
  { content: 'Run the ui test suite', status: 'pending' },
]

test('a todos snapshot appends one item and updates it in place', () => {
  const store = newStore([ev('user/message', 1, user('plan this'), { surfaceOp: 'append' })])
  const changes: number[] = []
  store.onChange = () => { changes.push(1) }

  store.handle(todosEvent(PLAN))
  const first = todosOf(store)
  assert.equal(first.length, 1, 'the checklist is one item, not one per todo')
  assert.equal(first[0]?.kind, 'todos')
  assert.deepEqual(first[0]?.todos.map(todo => todo.status), ['completed', 'in_progress', 'pending'])
  assert.equal(changes.length, 1, 'the store notifies its owner once per projection event')
  const position = store.items.findIndex(item => item.kind === 'todos')
  const version = first[0]?.version

  // A second snapshot (progress) replaces the same item in place.
  const progressed: TodoItem[] = [
    { content: 'Read the current resume flow', status: 'completed' },
    { content: 'Extract the picker scope filter', status: 'completed' },
    { content: 'Run the ui test suite', status: 'in_progress' },
  ]
  store.handle(todosEvent(progressed))
  const second = todosOf(store)
  assert.equal(second.length, 1)
  assert.equal(store.items.findIndex(item => item.kind === 'todos'), position, 'the block keeps its transcript position')
  assert.deepEqual(second[0]?.todos.map(todo => todo.status), ['completed', 'completed', 'in_progress'])
  assert.ok((second[0]?.version ?? 0) > (version ?? 0), 'the version advances so the cached block re-renders')
  assert.equal(changes.length, 2)

  // A repeated identical snapshot is still the projection's fact: it notifies.
  store.handle(todosEvent(progressed))
  assert.equal(todosOf(store).length, 1)

  // Copies are kept, so a later native mutation cannot rewrite history.
  progressed[0] = { content: 'mutated', status: 'pending' }
  assert.equal(todosOf(store)[0]?.todos[0]?.content, 'Read the current resume flow')
})

test('null removes the checklist, another session is ignored and reset clears it', () => {
  const store = newStore()
  store.handle(todosEvent(PLAN))
  assert.equal(todosOf(store).length, 1)

  // A projection for a session this store no longer follows is not adopted.
  store.handle(todosEvent(PLAN, 'other-session'))
  assert.equal(todosOf(store).length, 1)

  store.handle(todosEvent(null))
  assert.equal(todosOf(store).length, 0, 'the fold reported null, so the block is gone')
  store.handle(todosEvent(null))
  assert.equal(todosOf(store).length, 0, 'a repeated null is a no-op')

  // A session switch (reset) drops the previous session's checklist.
  store.handle(todosEvent(PLAN))
  store.reset(info())
  assert.equal(todosOf(store).length, 0)
  // A snapshot replay re-projects the durable events only; no stale todos.
  assert.equal(store.items.length, 0)
})

test('the checklist renders a header and distinct pending/in-progress/completed rows', () => {
  const store = newStore()
  store.handle(todosEvent(PLAN))
  const rendered = text(view(store))
  assert.match(rendered, /Todos · 3/)
  assert.match(rendered, /☑ Read the current resume flow/)
  assert.match(rendered, /◐ Extract the picker scope filter/)
  assert.match(rendered, /☐ Run the ui test suite/)
  // The first row carries the elbow, later rows align under it.
  assert.match(rendered, /⎿  ☑/)
  assert.match(rendered.trimEnd().split('\n').at(-1) ?? '', /^\s+☐ Run the ui test suite$/)
})

test('an empty checklist paints nothing and every status survives an unknown one', () => {
  const store = newStore()
  store.handle(todosEvent([]))
  assert.equal(todosOf(store).length, 1, 'a non-null projection is still stored')
  assert.deepEqual(view(store).render(80), [], 'an empty checklist is chrome, so no lines are painted')

  store.handle(todosEvent([{ content: 'mystery step', status: 'blocked' as TodoItem['status'] }]))
  const rendered = text(view(store))
  assert.match(rendered, /Todos · 1/)
  assert.match(rendered, /☐ mystery step/, 'an unexpected status renders as still pending, never as done')
})

test('the checklist is width safe with CJK content and long steps', () => {
  const store = newStore()
  store.handle(todosEvent([
    { content: '实现待办列表的块渲染，并保持每行宽度安全 ✅ 这是一段很长的内容用来触发换行', status: 'in_progress' },
    { content: 'a'.repeat(200), status: 'pending' },
  ]))
  const target = view(store)
  for (const width of [8, 16, 24, 40, 80]) assertWidths(target, width)
  const narrow = text(target, 24)
  assert.match(narrow, /Todos · 2/)
  assert.match(narrow, /实现待办/)
})

test('the block caches lines by version and width and invalidates cleanly', () => {
  const store = newStore()
  store.handle(todosEvent(PLAN))
  const item = todosOf(store)[0]
  assert.ok(item !== undefined)
  const block = createItemBlock(item, { showThinking: false, expandTools: false })
  const first = block.render(40)
  assert.equal(block.render(40), first, 'an unchanged item reuses its cached lines')
  assert.notEqual(block.render(60), first, 'a new width re-renders')

  store.handle(todosEvent([
    { content: 'Read the current resume flow', status: 'completed' },
    { content: 'Extract the picker scope filter', status: 'completed' },
    { content: 'Run the ui test suite', status: 'completed' },
  ]))
  const updated = todosOf(store)[0]
  assert.ok(updated !== undefined)
  block.update(updated)
  const rebuilt = block.render(40)
  assert.match(stripTerminalSequences(rebuilt.join('\n')), /☑ Run the ui test suite/)
  block.invalidate()
  assert.deepEqual(block.render(40), rebuilt, 'invalidating rebuilds the same lines')
})