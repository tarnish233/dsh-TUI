// Must stay the FIRST import: forces truecolor before src/ui/theme.ts snapshots
// getTerminalColorMode() at import time.
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { backgroundAnsi, parseColor, stripTerminalSequences, visibleWidth } from '#pi-tui'
import { BRAND_BLUE, BRAND_BLUE_BRIGHT } from '../src/ui/brand.ts'
import { bg, fg, palette, surfaces, t, type SurfaceRole } from '../src/ui/theme.ts'

/**
 * Semantic surface contract.
 *
 * The Settings panel used to paint a private near-black plate
 * (`bg('#111113')` in src/ui/modal.ts) over a transcript that paints no
 * background at all, which is why it looked black instead of matching the main
 * UI. These tests pin the replacement: one surface ladder, a transparent
 * canvas/dialog that inherits the terminal background, and width-safe painting
 * that survives Pi's clip resets. Text roles, brand blue and `t`/`cc` stay
 * untouched.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC_DIR = join(ROOT, 'src')
const execute = promisify(execFile)

const ANSI = /\x1b\[[0-9;]*m/
const BACKGROUND_SGR = /\x1b\[(?:4[0-7]|10[0-7]|48;|49m)/

function sourceFiles(directory: string = SRC_DIR): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full)
  }
  return files
}

const open = (role: SurfaceRole): string => surfaces[role].open

test('no component paints its own background plate: the surface ladder is the only source', () => {
  for (const file of sourceFiles()) {
    const relative = file.slice(SRC_DIR.length + 1)
    // theme.ts defines the factories; the logo is an asset image whose white
    // interior is part of the approved artwork, not interface chrome.
    if (relative === join('ui', 'theme.ts') || relative === join('ui', 'logo.ts')) continue
    const source = readFileSync(file, 'utf8')
    assert.equal(/\bbg\(/.test(source), false, `${relative} must use surfaces.<role>.fill/style, not bg()`)
  }
  const modal = readFileSync(join(SRC_DIR, 'ui', 'modal.ts'), 'utf8')
  for (const stale of ['#111113', '#000000', '16;16;19'])
    assert.equal(modal.includes(stale), false, `the modal must not fall back to a private dark plate (${stale})`)
})

test('canvas, dialog and overlay inherit the terminal background and emit no ANSI at all', () => {
  for (const role of ['canvas', 'dialog', 'overlay'] as const) {
    const surface = surfaces[role]
    assert.equal(surface.transparent, true, `${role} is transparent`)
    assert.equal(surface.color, undefined, `${role} has no private color`)
    assert.equal(surface.open, '', `${role} opens no background`)
    assert.equal(surface.close, '', `${role} closes no background`)
    assert.equal(surface.style('text'), 'text', `${role}.style is the identity`)
    assert.equal(surface.style(''), '', `${role}.style keeps the empty string empty`)
    assert.equal(surface.fill('ab', 5), 'ab   ', `${role}.fill pads plainly`)
    assert.equal(BACKGROUND_SGR.test(surface.fill(t.accent('ab'), 5)), false, `${role}.fill paints no background`)
  }
})

test('a popup can never disagree with the canvas it floats over', () => {
  // One switch (canvasBackground) feeds both roles; a tinted dialog over a
  // transparent root is exactly the black-slab bug this replaced.
  assert.equal(open('dialog'), open('canvas'))
  assert.equal(surfaces.dialog.color, surfaces.canvas.color)
  assert.equal(surfaces.dialog.transparent, surfaces.canvas.transparent)
  assert.equal(Object.isFrozen(surfaces), true, 'the surface ladder is a constant')
  assert.deepEqual(Object.keys(surfaces).sort(), ['canvas', 'dialog', 'overlay', 'raised', 'selected'])
})

test('raised and selected are the only tinted roles and reuse existing surface tokens', () => {
  assert.equal(surfaces.raised.transparent, false)
  assert.equal(surfaces.raised.color, palette.canvasSubtle)
  assert.equal(surfaces.selected.transparent, false)
  // The selection band IS the human-turn band color: one band blue, two uses.
  assert.equal(surfaces.selected.color, palette.userBg)
  assert.equal(surfaces.selected.color, palette.accentBg)
  assert.equal(open('raised'), backgroundAnsi(parseColor(palette.canvasSubtle), 'truecolor'))
  assert.equal(open('selected'), backgroundAnsi(parseColor(palette.accentBg), 'truecolor'))
  assert.equal(surfaces.raised.close, '\x1b[49m')
  assert.equal(surfaces.selected.close, '\x1b[49m')
})

test('existing text roles and the brand blue are untouched by the surface layer', () => {
  assert.equal(palette.accent, BRAND_BLUE)
  assert.equal(palette.accentBright, BRAND_BLUE_BRIGHT)
  assert.equal(t.text('x'), fg(palette.fg)('x'))
  assert.equal(t.userBg('x'), bg(palette.userBg)('x'), 'the human-turn band keeps its own helper')
  assert.equal(t.userBg('x'), surfaces.selected.style('x'), 'and matches the semantic selection band')
  assert.equal(bg('#0d1117')('x'), '\x1b[48;2;13;17;23mx\x1b[49m', 'bg() keeps its escape shape')
})

test('fill() is exactly the requested column count for wide and combining text', () => {
  const samples = ['plain', '中文标签', '👩🏽‍💻 emoji', 'e\u0301 combining', t.accent('styled'), '']
  for (const width of [1, 2, 5, 12, 40]) {
    for (const sample of samples) {
      for (const role of ['canvas', 'dialog', 'raised', 'selected', 'overlay'] as const) {
        const line = surfaces[role].fill(sample, width)
        assert.equal(visibleWidth(line), width, `${role}.fill(${JSON.stringify(sample)}, ${width})`)
      }
    }
  }
  assert.equal(surfaces.raised.fill('', 0), '', 'a zero width paints nothing')
  assert.equal(surfaces.raised.fill('abc', Number.NaN), '', 'a non-finite width paints nothing')
  assert.equal(visibleWidth(surfaces.raised.fill('abc', 2.9)), 2, 'a fractional width floors to columns')
})

test('fill() clips overlong content with Pi width helpers instead of splitting cells', () => {
  const long = '中文描述'.repeat(20)
  const line = surfaces.raised.fill(long, 11)
  assert.equal(visibleWidth(line), 11)
  assert.equal(stripTerminalSequences(line), '中文描述...', 'no cell is split by the clip')
  const clipped = surfaces.dialog.fill(long, 11)
  assert.equal(visibleWidth(clipped), 11)
  assert.equal(stripTerminalSequences(clipped), '中文描述...')
  assert.equal(BACKGROUND_SGR.test(clipped), false)
})

test('a clip reset inside a band cannot cancel the surface before the right edge', () => {
  // Pi's truncateToWidth() appends \x1b[0m; padding after it used to fall back
  // to the terminal default and leave an unstyled right edge.
  const reset = '\x1b[0m'
  const body = fg(palette.fg)('x'.repeat(200)) + reset
  const line = surfaces.selected.fill(body, 10)
  assert.ok(line.startsWith(open('selected')))
  assert.ok(line.endsWith('\x1b[49m'), 'the band closes after its padding')
  assert.equal(visibleWidth(line), 10)
  const plain = stripTerminalSequences(line)
  assert.equal(plain.length, 10, 'the padding belongs to the band')
  // No bare reset may appear after the surface opened but before the close.
  const inner = line.slice(open('selected').length, -'\x1b[49m'.length)
  assert.equal(/(?:\x1b\[0m)(?!\x1b\[48;)/.test(inner), false, 'every internal reset re-opens the band')
  // A transparent fill keeps Pi's in-line reset (it closes styling before the
  // ellipsis) but never leaves one dangling past the right edge.
  assert.equal(/\x1b\[0m$/.test(surfaces.dialog.fill(body, 10)), true, 'transparent fills preserve the caller foreground/clip reset')
})

test('style() keeps inline styling safe inside a band and restores the surface after a reset', () => {
  const inner = fg(palette.accentBright)('chip')
  assert.equal(surfaces.selected.style(inner), open('selected') + inner + '\x1b[49m')
  assert.equal(
    surfaces.selected.style('a\x1b[0mb'),
    open('selected') + 'a\x1b[0m' + open('selected') + 'b' + '\x1b[49m',
    'a nested full reset re-opens the surface instead of dropping the band',
  )
  assert.equal(surfaces.dialog.style(inner), inner, 'a transparent surface adds no escapes')
})

test('256-color terminals get the same roles with an indexed escape and identical geometry', async () => {
  const themeUrl = new URL('../src/ui/theme.ts', import.meta.url).href
  const script = `const s = await import(${JSON.stringify(themeUrl)});\n` +
    `console.log(JSON.stringify({ mode: process.env.PI_TRUE_COLOR, raised: s.surfaces.raised.open, canvas: s.surfaces.canvas.open, closed: s.surfaces.raised.close, padded: s.surfaces.raised.fill('x', 4) }))\n`
  const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 30_000, env: { ...process.env, PI_TRUE_COLOR: '0', COLORTERM: '', TERM: 'xterm-256color' },
  })
  const parsed = JSON.parse(stdout.trim()) as { raised: string; canvas: string; closed: string; padded: string }
  assert.match(parsed.raised, /^\x1b\[48;5;\d+m$/, '256-color mode uses the indexed background escape')
  assert.equal(parsed.canvas, '', 'transparency does not depend on the color mode')
  assert.equal(parsed.closed, '\x1b[49m')
  assert.equal(visibleWidth(parsed.padded), 4)
})

test('no-color rendering stays safe: transparent fills add no attribute codes at all', () => {
  const line = surfaces.dialog.fill('plain status row', 24)
  assert.equal(ANSI.test(line), false)
  assert.equal(line, 'plain status row'.padEnd(24))
})