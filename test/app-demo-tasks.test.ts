import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import { DemoBackend } from '../src/demo.ts'
import type { GoalProgress } from '../src/ui/goal-progress.ts'
import type { TodoBoard } from '../src/ui/todo-board.ts'
import type { SubagentProgress } from '../src/ui/subagent-progress.ts'
import { VirtualTerminal, delay, until } from './helpers/terminal.ts'

interface TaskDocks {
  readonly todoBoard: TodoBoard
  readonly goalProgress: GoalProgress
  readonly subagentProgress: SubagentProgress
  statusDockPool(): number
}

async function fixture(mode: 'inline' | 'fullscreen') {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-app-tasks-demo-'))
  const backend = new DemoBackend({ cwd: directory, delayMs: 0 })
  const terminal = new VirtualTerminal(110, 36)
  const app = new App({ backend, terminal, cwd: directory, configDir: directory, screen: mode,
    demo: true, initialPrompt: 'tasks', registerSignals: false })
  const docks = app as unknown as TaskDocks
  const close = async () => {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  }
  try {
    await app.start()
    await until(() => !app.isBusy && docks.todoBoard.counts.total >= 6 && docks.goalProgress.hasGoal &&
      docks.subagentProgress.hasActiveEntries, 'initial offline tasks scene')
  } catch (error) { await close(); throw error }
  const paint = async () => { await delay(45); await terminal.flush() }
  return { app, backend, terminal, docks, paint, close }
}

function dockHeader(lines: readonly string[], name: 'Todos' | 'Goal' | 'Agents'): number {
  const mark = name === 'Agents' ? '●' : '⏺'
  return lines.findIndex(line => line.trimStart().startsWith(mark + ' ' + name))
}

function assertAllDocks(f: Awaited<ReturnType<typeof fixture>>) {
  const lines = f.terminal.screen().split('\n')
  const indexes = (['Todos', 'Goal', 'Agents'] as const).map(name => dockHeader(lines, name))
  const editor = lines.findIndex(line => line.trimStart().startsWith('❯'))
  assert.ok(indexes.every(index => index >= 0) && indexes[0]! < indexes[1]! && indexes[1]! < indexes[2]! && indexes[2]! < editor,
    'all three fixture docks should share the fixed stack:\n' + lines.join('\n'))
  const width = f.terminal.columns
  const used = f.docks.todoBoard.render(width).length + f.docks.goalProgress.render(width).length +
    f.docks.subagentProgress.render(width).length
  assert.ok(used <= f.docks.statusDockPool())
}

for (const mode of ['inline', 'fullscreen'] as const) {
  test(`Tasks demo App ${mode}: public initial prompt shows three dock projections while root is idle`, async () => {
    const f = await fixture(mode)
    try {
      await f.paint()
      assertAllDocks(f)
      assert.equal(f.backend.demo, true)
      assert.equal(f.app.isBusy, false)
      assert.equal(f.app.editor.focused, true)
      assert.ok(f.app.store.subagentEntries.filter(entry => entry.status === 'running' || entry.status === 'initializing').length >= 3)
      assert.match(f.terminal.screen(), /offline|离线/)
      assert.equal(f.docks.goalProgress.goal?.phase, 'active')
      assert.match(f.terminal.screen(), /tasks next/)
      assert.match(f.terminal.screen(), /Activities: 1 tool · 1 update/)
      assert.match(f.terminal.screen(), /DEMO CHILD MESSAGE/)
      assert.doesNotMatch(f.terminal.screen(), /DEMO STATUS NOTICE BODY/)
      assert.equal(f.app.store.items.filter(item => item.kind === 'tool').length, 1, 'only the declared fixture tool is counted')
      f.terminal.type('\x0f')
      await f.paint()
      assert.match(f.terminal.screen(), /DEMO STATUS NOTICE BODY/)
      assert.match(f.terminal.screen(), /DEMO CHILD MESSAGE/)
      f.terminal.type('\x0f')
      await f.paint()
      assert.doesNotMatch(f.terminal.screen(), /DEMO STATUS NOTICE BODY/)
      assert.match(f.terminal.screen(), /DEMO CHILD MESSAGE/)
    } finally { await f.close() }
  })

  test(`Tasks demo App ${mode}: finite controls update then retire the live projections without replacing the editor`, async () => {
    const f = await fixture(mode)
    try {
      const editor = f.app.editor
      const before = f.docks.todoBoard.counts.completed
      const rounds = f.docks.goalProgress.goal?.roundsStarted ?? 0
      await f.app.submit('tasks next')
      await until(() => !f.app.isBusy && f.docks.todoBoard.counts.completed > before &&
        (f.docks.goalProgress.goal?.roundsStarted ?? 0) > rounds, 'next fixture stage')
      await f.paint()
      assertAllDocks(f)
      await f.app.submit('tasks done')
      await until(() => !f.app.isBusy && !f.docks.todoBoard.hasOpenItems && !f.docks.subagentProgress.hasActiveEntries,
        'completed fixture stage')
      await f.paint()
      const done = f.terminal.screen().split('\n')
      assert.equal(dockHeader(done, 'Todos'), -1)
      assert.equal(dockHeader(done, 'Agents'), -1)
      assert.ok(dockHeader(done, 'Goal') >= 0)
      assert.notEqual(f.docks.goalProgress.goal?.phase, 'active')
      await f.app.submit('tasks clear')
      await until(() => !f.app.isBusy && !f.docks.goalProgress.hasGoal && f.docks.todoBoard.counts.total === 0,
        'cleared fixture stage')
      await f.paint()
      for (const name of ['Todos', 'Goal', 'Agents'] as const) assert.equal(dockHeader(f.terminal.screen().split('\n'), name), -1)
      await f.app.submit('tasks')
      await until(() => !f.app.isBusy && f.docks.goalProgress.hasGoal && f.docks.todoBoard.hasOpenItems &&
        f.docks.subagentProgress.hasActiveEntries, 'restarted fixture stage')
      await f.paint()
      assertAllDocks(f)
      assert.equal(f.app.editor, editor)
      assert.equal(f.app.editor.focused, true)
    } finally { await f.close() }
  })

  test(`Tasks demo App ${mode}: long history, compact resize and overlay navigation preserve the same multiline draft`, async () => {
    const f = await fixture(mode)
    try {
      const before = f.docks.todoBoard.counts
      const historyBefore = f.app.store.items.length
      await f.app.submit('tasks history')
      await until(() => !f.app.isBusy, 'bounded history fixture')
      await f.paint()
      assert.ok(f.app.store.items.length >= historyBefore + 10, 'history control must create actual bounded transcript facts')
      assert.deepEqual(f.docks.todoBoard.counts, before, 'history is not a task advance')
      const draft = 'line one\nline two\n中文 😀\nline four\nTASKS-DEMO-DRAFT'
      f.app.editor.replaceDraftText(draft)
      for (const [cols, rows] of [[80, 16], [40, 18], [110, 36]] as const) {
        f.terminal.resize(cols, rows)
        await f.paint()
        assertAllDocks(f)
        assert.match(f.terminal.screen(), /TASKS-DEMO-DRAFT/)
        assert.equal(f.app.editor.getExpandedText(), draft)
      }
      f.terminal.type('\x14')
      await f.paint()
      assert.equal(dockHeader(f.terminal.screen().split('\n'), 'Todos'), -1)
      assert.ok(dockHeader(f.terminal.screen().split('\n'), 'Goal') >= 0)
      assert.ok(dockHeader(f.terminal.screen().split('\n'), 'Agents') >= 0)
      f.terminal.type('\x14')
      await f.paint()
      assertAllDocks(f)
      const snapshot = f.app.editor.captureDraft()
      await f.app.submit('/agent')
      await until(() => f.terminal.screen().includes('┌─ Agents'), 'existing Agents view')
      f.terminal.type('\x1b')
      await f.paint()
      assert.doesNotMatch(f.terminal.screen(), /┌─ Agents/)
      assert.deepEqual(f.app.editor.captureDraft(), snapshot)
      await f.app.submit('/settings')
      await until(() => f.terminal.screen().includes('┌─ Settings'), 'existing Settings view')
      f.terminal.type('\x1b')
      await f.paint()
      assert.doesNotMatch(f.terminal.screen(), /┌─ Settings/)
      assert.deepEqual(f.app.editor.captureDraft(), snapshot)
      assert.equal(f.app.editor.focused, true)
    } finally { await f.close() }
  })
}
