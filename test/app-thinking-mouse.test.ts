// Must be first: theme colors are fixed at module import time.
import './helpers/truecolor.ts'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { TuiAltScreen } from '#pi-tui'
import { App } from '../src/app.ts'
import { DemoBackend } from '../src/demo.ts'
import type { SessionEvent } from '../src/backend/types.ts'
import { thinkingExpandedCount } from '../src/ui/thinking-block.ts'
import { VirtualTerminal, delay } from './helpers/terminal.ts'

const paint = async (terminal: VirtualTerminal) => { await delay(35); await terminal.flush() }
const thought = (count = 100) => Array.from({ length: count }, (_, index) => `thought line ${index}`).join('\n')

function assistant(reasoning: string, second?: string): SessionEvent {
  return {
    type: 'assistant/message', seq: 2, time: 2000, surfaceOp: 'append',
    data: {
      turn: 1, step: 1,
      message: {
        id: 'a2', role: 'assistant',
        content: [{ type: 'reasoning', text: reasoning }, ...(second === undefined ? [] : [
          { type: 'text', text: 'Between the two thinking runs.' },
          { type: 'reasoning', text: second },
        ])],
        source: { kind: 'model', provider: 'demo', model: 'demo' },
      },
      stream: [],
    },
  }
}

async function fixture(options: { preview?: number; preceding?: number; events?: SessionEvent[] } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-mouse-'))
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ showThinking: true, thinkingPreviewLines: options.preview ?? 3 }))
  const terminal = new VirtualTerminal(80, 32)
  const backend = new DemoBackend({ cwd: directory, delayMs: 0 })
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen: 'fullscreen', demo: true, registerSignals: false })
  try {
    await app.start()
    const events: SessionEvent[] = []
    if (options.preceding) events.push({
      type: 'user/message', seq: 1, time: 0, surfaceOp: 'append',
      data: {
        id: 'u1', role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: Array.from({ length: options.preceding }, (_, index) => `preceding line ${index}`).join('\n') }],
      },
    })
    events.push(...(options.events ?? [assistant(thought())]))
    app.store.reset({ ...backend.info, events })
    await paint(terminal)
    assert.ok(app.tui instanceof TuiAltScreen)
    return {
      app, terminal, backend, tui: app.tui,
      async close() { await app.shutdown(); terminal.dispose(); await rm(directory, { recursive: true, force: true }) },
    }
  } catch (error) {
    await app.shutdown(); terminal.dispose(); await rm(directory, { recursive: true, force: true })
    throw error
  }
}

const lines = (terminal: VirtualTerminal) => terminal.screen().split('\n')
const summaryRows = (terminal: VirtualTerminal) => lines(terminal).flatMap((line, row) => /✻ (?:Thought|Thinking)/.test(line) ? [row] : [])
const press = (terminal: VirtualTerminal, x: number, y: number) => terminal.type(`\x1b[<0;${x + 1};${y + 1}M`)
const release = (terminal: VirtualTerminal, x: number, y: number) => terminal.type(`\x1b[<0;${x + 1};${y + 1}m`)
async function click(terminal: VirtualTerminal, x: number, y: number) {
  // Include the native press-forced repaint, rather than injecting type:click.
  press(terminal, x, y); await paint(terminal)
  release(terminal, x, y); await paint(terminal)
}

test('fullscreen: repeated clicks at the actual hint column collapse a bottom-row summary without a follow-overlay stealing them', async () => {
  const f = await fixture({ preview: 0, preceding: 40 })
  try {
    assert.equal(thinkingExpandedCount(), 0)
    const row = summaryRows(f.terminal)[0]!
    const column = lines(f.terminal)[row]!.indexOf('click to show more') + 5
    assert.ok(column > 5)
    assert.equal(f.tui.isFollowingOutput, true)
    for (let cycle = 0; cycle < 3; cycle++) {
      await click(f.terminal, column, row)
      assert.equal(thinkingExpandedCount(), 1, `expand ${cycle}`)
      assert.equal(summaryRows(f.terminal)[0], row, 'expanded summary stays under the pointer')
      assert.match(lines(f.terminal)[row]!, /click to collapse/)
      const followRow = lines(f.terminal).findIndex(line => line.includes('Back to bottom'))
      assert.ok(followRow > row, 'follow affordance occupies the separator outside the transcript')
      assert.equal(f.tui.isFollowingOutput, false)
      await click(f.terminal, column, row)
      assert.equal(thinkingExpandedCount(), 0, `collapse ${cycle}`)
      assert.equal(summaryRows(f.terminal)[0], row)
      assert.match(lines(f.terminal)[row]!, /click to show more/)
      assert.equal(f.tui.isFollowingOutput, true)
    }
    // The separated follow button still works; it must not close a thinking run.
    await click(f.terminal, column, row)
    const followRow = lines(f.terminal).findIndex(line => line.includes('Back to bottom'))
    const followColumn = lines(f.terminal)[followRow]!.indexOf('Back to bottom') + 5
    await click(f.terminal, followColumn, followRow)
    assert.equal(thinkingExpandedCount(), 1)
    assert.equal(f.tui.isFollowingOutput, true)
    assert.doesNotMatch(f.terminal.screen(), /Back to bottom/)
  } finally { await f.close() }
})

test('fullscreen: with the title scrolled away, a body click collapses but a body drag still selects text', async () => {
  const f = await fixture()
  try {
    const titleRow = summaryRows(f.terminal)[0]!
    f.terminal.type(`\x1b[<35;5;${titleRow + 1}M`)
    await click(f.terminal, 4, titleRow)
    assert.equal(thinkingExpandedCount(), 1)
    f.tui.scrollBy(40); await paint(f.terminal)
    assert.equal(summaryRows(f.terminal).length, 0, 'long thought title is genuinely off-screen')
    let bodyRow = lines(f.terminal).findIndex(line => /^  thought line /.test(line)) + 2
    assert.ok(bodyRow >= 2)
    press(f.terminal, 3, bodyRow); await paint(f.terminal)
    f.terminal.type(`\x1b[<32;19;${bodyRow + 1}M`)
    await paint(f.terminal)
    assert.equal(f.tui.hasActiveSelection(), true, 'even the first drag after hovering the title reaches native selection')
    release(f.terminal, 18, bodyRow); await paint(f.terminal)
    assert.equal(thinkingExpandedCount(), 1, 'drag is not collapsed into a click')
    assert.equal(f.tui.hasActiveSelection(), true, 'native text selection is preserved')
    bodyRow = lines(f.terminal).findIndex(line => /^  thought line /.test(line)) + 3
    await click(f.terminal, 5, bodyRow)
    assert.equal(thinkingExpandedCount(), 0, 'completed single click on the body collapses its run')
    assert.equal(f.tui.hasActiveSelection(), false, 'renderer clears selection after handling the click')
    assert.match(f.terminal.screen(), /more lines/)
  } finally { await f.close() }
})

test('fullscreen: a summary press remains pinned while streamed answer content repaints and scrolls before release', async () => {
  const f = await fixture({ preceding: 40, events: [] })
  try {
    const sessionId = f.backend.info.sessionId
    f.app.store.handle({ type: 'stream_start', sessionId, attemptId: 'live-click', revision: 1, turn: 1, step: 1 })
    f.app.store.handle({ type: 'stream_chunk', sessionId, attemptId: 'live-click', revision: 2, index: 0, time: Date.now(), chunk: { type: 'reasoning-delta', index: 0, text: thought(15) } })
    await paint(f.terminal)
    const row = summaryRows(f.terminal)[0]!
    assert.ok(row >= 0)
    press(f.terminal, 4, row); await paint(f.terminal)
    f.app.store.handle({ type: 'stream_chunk', sessionId, attemptId: 'live-click', revision: 3, index: 1, time: Date.now(), chunk: { type: 'text-delta', index: 1, text: 'First streamed answer line.\nSecond streamed answer line.\nThird streamed answer line.' } })
    await paint(f.terminal)
    assert.ok(summaryRows(f.terminal)[0]! < row, 'the frame actually moved between press and release')
    release(f.terminal, 4, row); await paint(f.terminal)
    assert.equal(thinkingExpandedCount(), 1, 'release activates the pressed run, not the new content at that coordinate')
    await click(f.terminal, 4, summaryRows(f.terminal)[0]!)
    assert.equal(thinkingExpandedCount(), 0)
  } finally { await f.close() }
})

test('fullscreen: closing one of multiple expanded runs does not restore follow until the last run closes', async () => {
  const f = await fixture({ events: [assistant(thought(6), thought(6))] })
  try {
    await click(f.terminal, 3, summaryRows(f.terminal)[0]!)
    await click(f.terminal, 3, summaryRows(f.terminal)[1]!)
    assert.equal(thinkingExpandedCount(), 2)
    assert.equal(f.tui.isFollowingOutput, false)
    await click(f.terminal, 3, summaryRows(f.terminal)[0]!)
    assert.equal(thinkingExpandedCount(), 1)
    assert.equal(f.tui.isFollowingOutput, false)
    await click(f.terminal, 3, summaryRows(f.terminal)[0]!) // reopen first
    assert.equal(thinkingExpandedCount(), 2)
    await click(f.terminal, 3, summaryRows(f.terminal)[1]!) // close second
    assert.equal(thinkingExpandedCount(), 1)
    assert.equal(f.tui.isFollowingOutput, false)
    await click(f.terminal, 3, summaryRows(f.terminal)[0]!)
    assert.equal(thinkingExpandedCount(), 0)
    assert.equal(f.tui.isFollowingOutput, true)
  } finally { await f.close() }
})

test('fullscreen: removing or replacing the pressed item cancels its stale click target', async () => {
  for (const replacement of [false, true]) {
    const f = await fixture({ preceding: 40 })
    try {
      const row = summaryRows(f.terminal)[0]!
      press(f.terminal, 4, row); await paint(f.terminal)
      f.app.store.reset({
        ...f.backend.info,
        sessionId: replacement ? 'replacement-session' : f.backend.info.sessionId,
        events: replacement ? [assistant(thought(12))] : [],
      })
      await paint(f.terminal)
      release(f.terminal, 4, row); await paint(f.terminal)
      assert.equal(thinkingExpandedCount(), 0, 'a detached block cannot flip an invisible expansion')
      assert.doesNotMatch(f.terminal.screen(), /click to collapse/)
      if (replacement) assert.match(f.terminal.screen(), /9 more lines/, 'a new session with the same item id has its own content')
    } finally { await f.close() }
  }
})
