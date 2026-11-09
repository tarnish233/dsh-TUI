import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, SessionInfo, SubagentEntry, TodosSnapshot } from '../src/backend/types.ts'
import type { GoalRead } from '../src/backend/native-inspection.ts'
import type { GoalProgress } from '../src/ui/goal-progress.ts'
import type { TodoBoard } from '../src/ui/todo-board.ts'
import type { SubagentProgress } from '../src/ui/subagent-progress.ts'
import { VirtualTerminal, delay } from './helpers/terminal.ts'

/** Offline, attachment-scoped projection fixture; never calls a native model. */
class CoexistBackend implements Backend {
  private readonly listeners = new Set<(event: BackendEvent) => void>()
  readonly info: SessionInfo
  constructor(cwd: string) {
    this.info = { sessionId: 'coexist-root', attachmentId: 'coexist-attachment', cwd,
      provider: 'fixture', model: 'fixture', capabilities: ['commands'], events: [] }
  }
  onEvent(listener: (event: BackendEvent) => void) {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  emit(event: BackendEvent) { for (const listener of this.listeners) listener(event) }
  todos(value: TodosSnapshot) {
    this.emit({ type: 'todos', sessionId: this.info.sessionId, attachmentId: this.info.attachmentId, value })
  }
  children(entries: readonly SubagentEntry[]) {
    this.emit({ type: 'subagents', sessionId: this.info.sessionId, value: { entries: [...entries] } })
  }
  async connect() { return this.info }
  async send() { throw new Error('Coexistence tests only project offline native facts') }
  async respond() { throw new Error('Coexistence tests never answer a native decision') }
  async cancel() {}
  async close() {}
  async command(name: string): Promise<unknown> {
    if (name === 'commands') return []
    if (name === 'state') return { queue: [], queued: 0, pending: { nextTurn: 0, nextStep: 0 } }
    if (name === 'auto-title') return { available: false }
    throw new Error('Unexpected coexistence fixture read: ' + name)
  }
}

interface DockInternals {
  readonly todoBoard: TodoBoard
  readonly goalProgress: GoalProgress
  readonly subagentProgress: SubagentProgress
  statusDockPool(): number
  render(): void
}

async function fixture(mode: 'inline' | 'fullscreen', rows = 16) {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-dock-coexist-'))
  const backend = new CoexistBackend(cwd)
  const terminal = new VirtualTerminal(80, rows)
  const app = new App({ backend, terminal, cwd, configDir: cwd, screen: mode, registerSignals: false })
  await app.start()
  const ui = app as unknown as DockInternals
  const paint = async () => { ui.render(); await delay(45); await terminal.flush() }
  const draft = 'line one\nline two\n中文 😀\nline four\nDRAFT-TAIL'
  app.editor.replaceDraftText(draft)
  backend.todos(Array.from({ length: 6 }, (_, index) => ({ content: `TODO-LIVE-${index}`,
    status: index === 0 ? 'in_progress' as const : 'pending' as const })))
  const child: SubagentEntry = { id: 'coexist-child', parentSessionId: backend.info.sessionId,
    mode: 'one-shot', status: 'running', label: 'CHILD-LIVE', local: true, lastActivity: 'native current activity' }
  const goal: GoalRead = { available: true, complete: true, sessionId: backend.info.sessionId, goal: {
    id: 'coexist-goal', revision: 1, objective: 'GOAL-OBJECTIVE', phase: 'active', maxGoalRounds: 6,
    roundsStarted: 2, activation: 'armed' } }
  return { app, backend, terminal, ui, paint, draft, child, goal, async close() {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(cwd, { recursive: true, force: true }) }
  } }
}

function assertBudget(f: Awaited<ReturnType<typeof fixture>>) {
  const width = f.terminal.columns
  const heights = [f.ui.todoBoard.render(width).length, f.ui.goalProgress.render(width).length,
    f.ui.subagentProgress.render(width).length]
  assert.ok(heights.reduce((total, height) => total + height, 0) <= f.ui.statusDockPool(),
    `status heights ${heights.join('/')} exceed pool ${f.ui.statusDockPool()}`)
  return heights
}

for (const mode of ['inline', 'fullscreen'] as const) {
  test(`Status coexistence ${mode}: child start cannot replace a two-row Todo, settlement releases its slot`, async () => {
    const f = await fixture(mode)
    try {
      await f.paint()
      assert.match(f.terminal.screen(), /TODO-LIVE-0/)
      assert.equal(f.ui.statusDockPool(), 2, 'deliberately constrained to the previously failing pool')
      const before = f.app.editor.captureDraft()
      const historyCount = f.app.store.items.length
      f.backend.children([f.child])
      await f.paint()
      assert.match(f.terminal.screen(), /Todos/)
      assert.match(f.terminal.screen(), /TODO-LIVE-0/)
      assert.match(f.terminal.screen(), /Agents/)
      assert.deepEqual(assertBudget(f), [1, 0, 1], 'both live statuses survive as compact rows')
      assert.deepEqual(f.app.editor.captureDraft(), before)
      assert.equal(f.app.editor.focused, true)
      f.backend.children([{ ...f.child, status: 'completed' }])
      await f.paint()
      assert.match(f.terminal.screen(), /TODO-LIVE-0/)
      assert.doesNotMatch(f.terminal.screen(), /Agents/)
      assert.deepEqual(assertBudget(f), [2, 0, 0], 'settled catalog entries cannot hold a phantom reservation')
      assert.deepEqual(f.app.editor.captureDraft(), before)
      assert.equal(f.app.store.items.length, historyCount, 'compaction is display-only, not new transcript facts')
    } finally { await f.close() }
  })

  test(`Status coexistence ${mode}: all three retain a row before the editor in a short multiline terminal`, async () => {
    const f = await fixture(mode)
    try {
      f.ui.goalProgress.status = f.goal
      f.backend.children([f.child])
      await f.paint()
      const lines = f.terminal.screen().split('\n')
      const todoRow = lines.findIndex(line => line.includes('TODO-LIVE-0'))
      const goalRow = lines.findIndex(line => line.includes('Goal'))
      const agentsRow = lines.findIndex(line => line.includes('Agents'))
      const draftRow = lines.findIndex(line => line.includes('DRAFT-TAIL'))
      assert.equal(f.ui.statusDockPool(), 3, 'borrow only the minimum transcript space necessary for coexistence')
      assert.deepEqual(assertBudget(f), [1, 1, 1])
      assert.ok(todoRow >= 0 && todoRow < goalRow && goalRow < agentsRow && agentsRow < draftRow,
        'Todo → Goal → Agents → one unchanged editor')
      assert.equal(f.app.editor.getExpandedText(), f.draft)
      assert.equal(f.app.editor.focused, true)
    } finally { await f.close() }
  })

  test(`Status coexistence ${mode}: resize and late activity never erase live Todo to make room for children`, async () => {
    const f = await fixture(mode, 32)
    try {
      f.app.store.report(Array.from({ length: 70 }, (_, index) => 'stable history ' + index).join('\n'))
      f.ui.goalProgress.status = f.goal
      f.backend.children([f.child, { ...f.child, id: 'second-child', label: 'SECOND-CHILD', status: 'initializing' }])
      for (const [columns, rows] of [[100, 32], [80, 24], [40, 20], [40, 18], [80, 16], [40, 16], [80, 12], [80, 24]] as const) {
        f.terminal.resize(columns, rows)
        await f.paint()
        const pool = f.ui.statusDockPool()
        const screen = f.terminal.screen()
        assertBudget(f)
        if (pool >= 1) assert.match(screen, /TODO-LIVE-0/, `Todo must keep its compact row at ${columns}x${rows}`)
        if (pool >= 3) {
          assert.match(screen, /Goal/, `Goal compact row at ${columns}x${rows}`)
          assert.match(screen, /Agents/, `Agents compact row at ${columns}x${rows}`)
        }
        assert.match(screen, /DRAFT-TAIL/)
        assert.equal(f.app.editor.getExpandedText(), f.draft)
        assert.equal(f.app.editor.focused, true)
      }
      const before = f.app.editor.captureDraft()
      f.backend.todos([{ content: 'TODO-UPDATED-IN-PLACE', status: 'in_progress' }])
      f.backend.children([{ ...f.child, lastActivity: 'updated native activity' }])
      await f.paint()
      assert.match(f.terminal.screen(), /TODO-UPDATED-IN-PLACE/)
      assert.doesNotMatch(f.terminal.screen(), /TODO-LIVE-0/)
      assert.equal(f.terminal.screen().split('TODO-UPDATED-IN-PLACE').length - 1, 1)
      assert.deepEqual(f.app.editor.captureDraft(), before)
    } finally { await f.close() }
  })

  test(`Status coexistence ${mode}: Ctrl+T releases Todo's minimum row but native updates do not reopen it`, async () => {
    const f = await fixture(mode)
    try {
      f.ui.goalProgress.status = f.goal
      f.backend.children([f.child])
      await f.paint()
      f.terminal.type('\x14')
      await f.paint()
      assert.equal(f.ui.statusDockPool(), 2)
      assert.doesNotMatch(f.terminal.screen(), /TODO-LIVE-0/)
      assert.match(f.terminal.screen(), /Goal/)
      assert.match(f.terminal.screen(), /Agents/)
      assert.deepEqual(assertBudget(f), [0, 1, 1])
      f.backend.todos([{ content: 'HIDDEN-NATIVE-UPDATE', status: 'pending' }])
      await f.paint()
      assert.doesNotMatch(f.terminal.screen(), /HIDDEN-NATIVE-UPDATE/)
      f.terminal.type('\x14')
      await f.paint()
      assert.match(f.terminal.screen(), /HIDDEN-NATIVE-UPDATE/)
      assert.deepEqual(assertBudget(f), [1, 1, 1])
      assert.equal(f.app.editor.getExpandedText(), f.draft)
      assert.equal(f.app.editor.focused, true)
    } finally { await f.close() }
  })
}
