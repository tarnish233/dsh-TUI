import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, SessionInfo, TodosSnapshot } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { delay, until, VirtualTerminal } from './helpers/terminal.ts'

/**
 * Parent-owned acceptance for the native todos/plan projections: the bridge
 * forwards DSH's own folds as events; the bottom dock shows the live checklist
 * while plan transitions stay notices. Ctrl+T toggles without writing history.
 */
class ProjectionBackend implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  readonly listeners = new Set<(event: BackendEvent) => void>()
  info: SessionInfo
  constructor(cwd: string) {
    this.info = {
      sessionId: 'todos-session', attachmentId: 'todos-attachment', cwd,
      provider: 'fixture-provider', model: 'fixture-model', capabilities: ['commands'],
    }
  }
  onEvent(listener: (event: BackendEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent) { for (const listener of this.listeners) listener(event) }
  async connect() { this.emit({ type: 'ready', info: this.info }); return this.info }
  async send() {}
  async respond() { throw new Error('todos test never answers decisions') }
  async close() {}
  async cancel() {}
  async command(name: string): Promise<unknown> {
    if (name === 'commands') return []
    if (name === 'auto-title') return { available: false }
    throw new Error('Unexpected control from the todos test: ' + name)
  }
  todos(value: TodosSnapshot): void {
    this.emit({ type: 'todos', sessionId: this.info.sessionId, value })
  }
  plan(active: boolean): void {
    this.emit({ type: 'plan', sessionId: this.info.sessionId, value: { active } })
  }
}

async function paint(terminal: VirtualTerminal) { await delay(40); await terminal.flush() }

test('parent projections: the native todos fold renders a single live checklist', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-todos-'))
  const backend = new ProjectionBackend(directory)
  const terminal = new VirtualTerminal(110, 32)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen: 'fullscreen', registerSignals: false })
  try {
    await app.start()
    backend.todos([
      { content: 'survey the projections', status: 'completed' },
      { content: 'wire the checklist block', status: 'in_progress' },
      { content: 'accept the fold', status: 'pending' },
    ])
    await until(() => terminal.screen().includes('wire the checklist block'), 'the checklist renders')
    await paint(terminal)
    const screen = terminal.screen()
    assert.ok(screen.includes('survey the projections') && screen.includes('accept the fold'), 'every item renders')
    assert.equal(terminal.screen().split('wire the checklist block').length - 1, 1, 'one checklist block, not one per event')
    // A todo/write update replaces the block in place.
    backend.todos([
      { content: 'survey the projections', status: 'completed' },
      { content: 'wire the checklist block', status: 'completed' },
      { content: 'accept the fold', status: 'in_progress' },
    ])
    await paint(terminal)
    assert.equal(terminal.screen().split('accept the fold').length - 1, 1, 'the update replaces, it does not append')
    // The fold clears on turn start: null removes the block.
    backend.todos(null)
    await paint(terminal)
    assert.ok(!terminal.screen().includes('survey the projections'), 'a null snapshot removes the checklist')
  } finally {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  }
})

test('parent projections: Ctrl+T toggles the tracked todos without appending notices', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-todos-'))
  const backend = new ProjectionBackend(directory)
  const terminal = new VirtualTerminal(110, 32)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen: 'fullscreen', registerSignals: false })
  try {
    await app.start()
    terminal.type('\x14') // Ctrl+T (app.todo)
    await paint(terminal)
    assert.ok(!terminal.screen().includes('No todos in this session yet.'), 'an empty CC toggle is quiet')
    backend.todos([{ content: 'only one todo', status: 'in_progress' }])
    await until(() => terminal.screen().includes('only one todo'), 'the checklist renders')
    const before = app.store.items.length
    terminal.type('\x14')
    await paint(terminal)
    assert.ok(!terminal.screen().includes('only one todo'), 'first press hides the dock')
    assert.equal(app.store.items.length, before, 'hide appends no transcript summary')
    terminal.type('\x14')
    await paint(terminal)
    assert.ok(terminal.screen().includes('only one todo'), 'second press shows the same native snapshot')
    assert.equal(app.store.items.length, before, 'show appends no transcript summary')
  } finally {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  }
})

test('parent projections: plan-mode transitions surface as notices, repeats stay quiet', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-plan-'))
  const backend = new ProjectionBackend(directory)
  const terminal = new VirtualTerminal(110, 32)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen: 'fullscreen', registerSignals: false })
  try {
    await app.start()
    backend.plan(true)
    await paint(terminal)
    assert.ok(terminal.screen().includes('Plan mode is active.'), 'activation is surfaced')
    backend.plan(true)
    await paint(terminal)
    assert.equal(terminal.screen().split('Plan mode is active.').length - 1, 1, 'a repeated snapshot adds no notice')
    backend.plan(false)
    await paint(terminal)
    assert.ok(terminal.screen().includes('Plan mode is off.'), 'deactivation is surfaced')
  } finally {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  }
})
