import './helpers/truecolor.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { App } from '../src/app.ts'
import { RenderingFixture } from './helpers/rendering-fixture.ts'
import { VirtualTerminal, delay } from './helpers/terminal.ts'

async function fixture(screen: 'inline' | 'fullscreen') {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-render-four-'))
  await writeFile(join(cwd, 'settings.json'), JSON.stringify({ showThinking: true, thinkingPreviewLines: 3, groupTools: true, groupSubagentMessages: true }))
  const terminal = new VirtualTerminal(110, 50), backend = new RenderingFixture(cwd)
  const app = new App({ backend, terminal, cwd, configDir: cwd, screen, registerSignals: false })
  const paint = async () => { await delay(45); await terminal.flush() }
  const close = async () => { try { await app.shutdown() } finally { terminal.dispose(); await rm(cwd, { recursive: true, force: true }) } }
  try { await app.start(); await paint() } catch (error) { await close(); throw error }
  return { app, terminal, paint, close }
}

function hintPositions(terminal: VirtualTerminal) {
  return terminal.screen().split('\n').flatMap((line, y) => {
    const match = /click to (?:expand|show more)/.exec(line)
    return match === null ? [] : [{ y, x: match.index, text: match[0] }]
  })
}

function colorAt(terminal: VirtualTerminal, position: { x: number; y: number }) {
  const cell = terminal.xterm.buffer.active.getLine(terminal.xterm.buffer.active.viewportY + position.y)?.getCell(position.x)
  return [cell?.getFgColorMode(), cell?.getFgColor()]
}

function move(terminal: VirtualTerminal, position: { x: number; y: number }) {
  terminal.type(`\x1b[<35;${position.x + 2};${position.y + 1}M`)
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test(`Rendering App ${screen}: native image title has a separator and never overwrites the one draft`, async () => {
    const f = await fixture(screen)
    try {
      const text = f.terminal.screen()
      assert.match(text, /Read Image \/fixture\/image\.png/)
      assert.doesNotMatch(text, /Read ImageRead image/)
      f.terminal.type('root draft 中文')
      await f.paint()
      assert.equal(f.app.editor.getExpandedText(), 'root draft 中文')
      assert.equal(f.app.editor.focused, true)
    } finally { await f.close() }
  })
}

test('Rendering App fullscreen: only the pointer-owned hint stays accented across tools, thinking, group and editor', async () => {
  const f = await fixture('fullscreen')
  try {
    const positions = hintPositions(f.terminal)
    assert.ok(positions.length >= 5, 'two tools/two thinking headers/one group must be visible')
    const first = positions.find(position => position.text === 'click to expand')!
    const second = positions.filter(position => position.text === 'click to expand')[1]!
    const thinking = positions.find(position => position.text === 'click to show more')!
    const group = positions.at(-1)!
    const resting = positions.map(position => colorAt(f.terminal, position))
    f.terminal.type('kept hover draft')
    const draft = f.app.editor.captureDraft()
    move(f.terminal, first); await f.paint()
    assert.notDeepEqual(colorAt(f.terminal, first), resting[positions.indexOf(first)], 'current tool hint is accented')
    move(f.terminal, second); await f.paint()
    assert.deepEqual(colorAt(f.terminal, first), resting[positions.indexOf(first)], 'old tool hover retires')
    assert.notDeepEqual(colorAt(f.terminal, second), resting[positions.indexOf(second)])
    move(f.terminal, thinking); await f.paint()
    assert.deepEqual(colorAt(f.terminal, second), resting[positions.indexOf(second)])
    move(f.terminal, group); await f.paint()
    assert.deepEqual(colorAt(f.terminal, thinking), resting[positions.indexOf(thinking)])
    const editorRow = f.terminal.screen().split('\n').findIndex(line => line.includes('kept hover draft'))
    assert.ok(editorRow >= 0)
    move(f.terminal, { x: 10, y: editorRow }); await f.paint()
    for (let index = 0; index < positions.length; index++) assert.deepEqual(colorAt(f.terminal, positions[index]!), resting[index],
      'leaving transcript clears every old expand hint')
    assert.deepEqual(f.app.editor.captureDraft(), draft)
    move(f.terminal, first); await f.paint()
    const view = (f.app as unknown as { transcript: { hoverOwnerItemId?: string } }).transcript
    assert.ok(view.hoverOwnerItemId)
    f.terminal.type('\x1b[O'); await f.paint()
    assert.equal(view.hoverOwnerItemId, undefined, 'terminal focus-out clears stale hover without changing the draft')
    f.terminal.type('\x1b[I'); await f.paint()
    move(f.terminal, first); await f.paint()
    f.terminal.type('\x1bOP'); await f.paint()
    assert.match(f.terminal.screen(), /┌─ Help/)
    assert.equal(view.hoverOwnerItemId, undefined, 'overlay entry retires background pointer ownership')
    f.terminal.type('\x1b'); await f.paint()
    assert.deepEqual(f.app.editor.captureDraft(), draft)
    assert.equal(f.app.editor.focused, true)
  } finally { await f.close() }
})
