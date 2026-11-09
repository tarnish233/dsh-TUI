import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, SessionInfo, TodosSnapshot } from '../src/backend/types.ts'
import type { GoalRead } from '../src/backend/native-inspection.ts'
import { GoalProgress } from '../src/ui/goal-progress.ts'
import { TodoBoard } from '../src/ui/todo-board.ts'
import { SubagentProgress } from '../src/ui/subagent-progress.ts'
import { VirtualTerminal, delay, until } from './helpers/terminal.ts'

class DockBackend implements Backend {
  readonly listeners = new Set<(event: BackendEvent) => void>()
  info: SessionInfo
  constructor(cwd: string) { this.info = { sessionId: 'dock-root', attachmentId: 'dock-attachment', cwd,
    provider: 'fixture', model: 'fixture', capabilities: ['commands'], events: [] } }
  onEvent(listener: (event: BackendEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent) { for (const listener of this.listeners) listener(event) }
  todos(value: TodosSnapshot) { this.emit({ type: 'todos', sessionId: this.info.sessionId, attachmentId: this.info.attachmentId, value }) }
  async connect() { return this.info }
  async send() { throw new Error('Dock projection tests never send prompts') }
  async respond() { throw new Error('Dock projection tests never answer native decisions') }
  async cancel() {}
  async close() {}
  async command(name: string): Promise<unknown> {
    if (name === 'commands') return []
    if (name === 'state') return { queue: [], queued: 0, pending: { nextTurn: 0, nextStep: 0 } }
    if (name === 'auto-title') return { available: false }
    throw new Error('Unexpected read from dock fixture: ' + name)
  }
}

async function fixture(screen: 'inline' | 'fullscreen', rows = 24) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-fixed-todos-'))
  const backend = new DockBackend(cwd), terminal = new VirtualTerminal(100, rows)
  const app = new App({ backend, terminal, cwd, configDir: cwd, screen, registerSignals: false })
  await app.start()
  const paint = async () => { await delay(45); await terminal.flush() }
  return { app, backend, terminal, paint, async close() {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(cwd, { recursive: true, force: true }) }
  } }
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`Todo dock ${screen}: remains above the editor through long history and updates in place`, async () => {
    const f = await fixture(screen)
    try {
      f.backend.todos([{ content: 'TODO-DOCK-SENTINEL', status: 'in_progress' }, { content: 'next native step', status: 'pending' }])
      await until(() => f.terminal.screen().includes('TODO-DOCK-SENTINEL'), 'initial todo dock')
      f.app.store.report(Array.from({ length: 70 }, (_, i) => 'History-growth-' + i).join('\n'))
      f.terminal.type('kept-root-draft')
      await f.paint()
      const lines = f.terminal.screen().split('\n')
      assert.ok(lines.findIndex(line => line.includes('TODO-DOCK-SENTINEL')) >= 0)
      assert.ok(lines.findIndex(line => line.includes('TODO-DOCK-SENTINEL')) < lines.findIndex(line => line.includes('kept-root-draft')))
      assert.equal(f.terminal.screen().split('TODO-DOCK-SENTINEL').length - 1, 1)
      assert.equal(f.app.editor.focused, true)
      const before = f.app.editor.captureDraft()
      f.backend.todos([{ content: 'TODO-DOCK-SENTINEL', status: 'completed' }, { content: 'updated native step', status: 'in_progress' }])
      await f.paint()
      assert.match(f.terminal.screen(), /updated native step/)
      assert.doesNotMatch(f.terminal.screen(), /next native step/)
      assert.deepEqual(f.app.editor.captureDraft(), before)
      const transcript = (f.app as unknown as { transcript: { render(width: number): string[] } }).transcript.render(100).join('\n')
      assert.doesNotMatch(transcript, /TODO-DOCK-SENTINEL|updated native step/, 'one live host, not a second checklist in history')
    } finally { await f.close() }
  })

  test(`Todo dock ${screen}: Ctrl+T hides across updates, clear/complete retires, new attachment resets`, async () => {
    const f = await fixture(screen)
    try {
      f.backend.todos([{ content: 'native-open-task', status: 'in_progress' }])
      await f.paint()
      const count = f.app.store.items.length
      f.terminal.type('\x14')
      await f.paint()
      assert.doesNotMatch(f.terminal.screen(), /native-open-task/)
      f.backend.todos([{ content: 'native-updated-task', status: 'pending' }])
      await f.paint()
      assert.doesNotMatch(f.terminal.screen(), /native-updated-task/)
      f.terminal.type('\x14')
      await f.paint()
      assert.match(f.terminal.screen(), /native-updated-task/)
      assert.equal(f.app.store.items.length, count)
      f.backend.todos([{ content: 'native-updated-task', status: 'completed' }])
      await f.paint()
      assert.doesNotMatch(f.terminal.screen(), /native-updated-task/)
      f.terminal.type('\x14')
      await f.paint()
      assert.equal(f.app.store.items.length, count, 'completed CC tray is quiet, no summary append')
      f.backend.todos(null)
      await f.paint()
      f.backend.info = { ...f.backend.info, attachmentId: 'replacement-attachment' }
      f.backend.emit({ type: 'ready', info: f.backend.info })
      f.backend.todos([{ content: 'replacement-open-task', status: 'pending' }])
      await f.paint()
      assert.match(f.terminal.screen(), /replacement-open-task/)
    } finally { await f.close() }
  })
}

test('Todo dock ignores stale same-session attachment and foreign roots without losing the draft', async () => {
  const f = await fixture('fullscreen')
  try {
    f.backend.todos([{ content: 'authorized task 中文', status: 'in_progress' }])
    f.terminal.type('原稿 😀')
    const before = f.app.editor.captureDraft()
    f.backend.emit({ type: 'todos', sessionId: 'foreign-root', value: [{ content: 'FOREIGN', status: 'pending' }] })
    f.backend.emit({ type: 'todos', sessionId: f.backend.info.sessionId, attachmentId: 'retired-attachment', value: [{ content: 'STALE', status: 'pending' }] })
    await f.paint()
    assert.match(f.terminal.screen(), /authorized task 中文/)
    assert.doesNotMatch(f.terminal.screen(), /FOREIGN|STALE/)
    assert.deepEqual(f.app.editor.captureDraft(), before)
  } finally { await f.close() }
})

test('Todo/Goal/Subagent share one adaptive height pool through resize and multiline editing', async () => {
  const f = await fixture('fullscreen', 32)
  try {
    f.backend.todos(Array.from({ length: 9 }, (_, i) => ({ content: `native step ${i} 中文😀`, status: i === 0 ? 'in_progress' as const : 'pending' as const })))
    f.backend.emit({ type: 'subagents', sessionId: f.backend.info.sessionId, value: { entries: [{ id: 'child', parentSessionId: f.backend.info.sessionId,
      mode: 'one-shot', status: 'running', label: 'native child', local: true }] } })
    const internals = f.app as unknown as { todoBoard: TodoBoard; goalProgress: GoalProgress; subagentProgress: SubagentProgress; statusDockPool(): number; render(): void }
    const goal: GoalRead = { available: true, complete: true, sessionId: f.backend.info.sessionId, goal: {
      id: 'goal', revision: 1, objective: 'native objective', phase: 'active', maxGoalRounds: 6, roundsStarted: 2, activation: 'armed' } }
    internals.goalProgress.status = goal
    for (const rows of [32, 24, 18, 12]) {
      f.terminal.resize(40, rows)
      f.app.editor.replaceDraftText('multiline\n中文 😀\nkept')
      internals.render()
      await f.paint()
      const total = internals.todoBoard.render(40).length + internals.goalProgress.render(40).length + internals.subagentProgress.render(40).length
      assert.ok(total <= internals.statusDockPool(), `${total} dock rows exceed pool at ${rows}`)
      assert.equal(f.app.editor.focused, true)
      assert.equal(f.app.editor.getExpandedText(), 'multiline\n中文 😀\nkept')
      assert.match(f.terminal.screen(), /kept/)
    }
  } finally { await f.close() }
})
