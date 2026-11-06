// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { after } from 'node:test'
import { resetCapabilitiesCache, setCapabilities, stripTerminalSequences, visibleWidth } from '#pi-tui'
import {
  DeepSeekLogo, LOGO_BLUE, LOGO_BLOCK_GLYPHS, LOGO_COLUMNS, LOGO_GLYPHS, LOGO_GRID,
  LOGO_PIXEL_ROWS, LOGO_ROWS, LOGO_SAMPLE_COLUMNS, LOGO_WHITE,
} from '../src/ui/logo.ts'
import { VERSION } from '../src/version.ts'
import { WelcomeHeader, WELCOME_LOGO_MIN_WIDTH } from '../src/ui/welcome.ts'
import { bold, t } from '../src/ui/theme.ts'
import { VirtualTerminal } from './helpers/terminal.ts'

after(() => resetCapabilitiesCache())
const caps = (images: 'kitty' | 'iterm2' | null, trueColor = true) => setCapabilities({ images, trueColor, hyperlinks: false })
const rgb = (value: number) => [value >> 16 & 255, value >> 8 & 255, value & 255]
const glyphBits = new Map<string, number>(LOGO_GLYPHS.map((glyph, index) => [glyph, index]))

/** Sub-cell tags of one 2x2 cell: upper-left, upper-right, lower-left, lower-right. */
function subcells(x: number, y: number): string[] {
  return [LOGO_GRID[y * 2][x * 2], LOGO_GRID[y * 2][x * 2 + 1], LOGO_GRID[y * 2 + 1][x * 2], LOGO_GRID[y * 2 + 1][x * 2 + 1]]
}

// Independent terminal-cell decoding: every 2x2 quadrant is checked against the
// sample grid, including the explicit white interior.
test('quadrant character blocks render smaller pixels in blue and fill the internal negative space white', async () => {
  caps('kitty')
  const logo = new DeepSeekLogo(), terminal = new VirtualTerminal(24, 10)
  try {
    assert.equal(LOGO_COLUMNS, 16)
    assert.equal(LOGO_SAMPLE_COLUMNS, 32)
    assert.equal(LOGO_PIXEL_ROWS, 12)
    assert.equal(LOGO_ROWS, 6)
    assert.equal(LOGO_GRID.length, LOGO_PIXEL_ROWS)
    assert.ok(LOGO_GRID.join('').includes('W'), 'internal areas are not left transparent')
    logo.render(LOGO_COLUMNS).forEach((row, index) => terminal.write(`\x1b[${index + 1};1H${row}`))
    await terminal.flush()
    let white = 0
    for (let y = 0; y < LOGO_ROWS; y++) {
      for (let x = 0; x < LOGO_COLUMNS; x++) {
        const cell = terminal.xterm.buffer.active.getLine(y)?.getCell(x)
        assert.ok(cell)
        const tags = subcells(x, y)
        const char = cell.getChars() || ' '
        const fg = cell.isFgRGB() ? rgb(cell.getFgColor()) : null
        const bg = cell.isBgRGB() ? rgb(cell.getBgColor()) : null
        const bits = glyphBits.get(char)
        if (bits === undefined) assert.fail(`cell ${x},${y} is not a block glyph: ${JSON.stringify(char)}`)
        const hasBlue = tags.includes('B'), hasWhite = tags.includes('W')
        if (!hasBlue && !hasWhite) {
          assert.equal(bits, 0, `transparent cell ${x},${y}`)
          assert.deepEqual([fg, bg], [null, null], `transparent cell ${x},${y} keeps the default background`)
          continue
        }
        const fgTag = hasBlue ? 'B' : 'W'
        const bgTag = hasBlue && hasWhite ? 'W' : null
        assert.equal(fg?.join(','), (fgTag === 'B' ? LOGO_BLUE : LOGO_WHITE).join(','), `foreground ${x},${y}`)
        assert.equal(bg === null ? null : bg.join(','), bgTag === null ? null : LOGO_WHITE.join(','), `background ${x},${y}`)
        for (let index = 0; index < 4; index++) {
          const tag = tags[index]
          const painted: boolean = (bits & (1 << index)) !== 0
          if (tag === fgTag) assert.equal(painted, true, `sub-cell ${index} foreground coverage ${x},${y}`)
          else if (bgTag !== null) assert.equal(painted, false, `sub-cell ${index} is the background color ${x},${y}`)
          else assert.equal(painted, false, `sub-cell ${index} stays transparent ${x},${y}`)
          if (tag === 'W') white++
        }
      }
    }
    assert.equal(white, 48, 'white interior samples stay white')
  } finally { terminal.dispose() }
})

test('all terminals use exactly the same character path, never native images or Braille', () => {
  const logo = new DeepSeekLogo(), header = new WelcomeHeader({ demo: true })
  const blocks = new RegExp(`[${LOGO_BLOCK_GLYPHS}]`, 'u')
  let first: string[] | undefined
  for (const images of ['kitty', 'iterm2', null] as const) {
    caps(images)
    const rows = logo.render(16), welcome = header.render(80)
    first ??= rows
    assert.deepEqual(rows, first)
    assert.match(rows.join(''), blocks)
    assert.doesNotMatch([...rows, ...welcome].join(''), /\x1b_G|\x1b\]1337;File=|[\u2800-\u28ff]/u)
  }
})

test('truecolor and 256-color output preserve identical blue/white glyph geometry', () => {
  const logo = new DeepSeekLogo()
  caps(null, true)
  const truecolor = logo.render(16)
  caps(null, false)
  const indexed = logo.render(16)
  assert.match(indexed.join(''), /\x1b\[38;5;/)
  assert.deepEqual(indexed.map(stripTerminalSequences), truecolor.map(stripTerminalSequences))
})

// The visible identity is the shared release version, never a second literal.
const TAGLINE = 'DSH TUI · v' + VERSION

test('header preserves identity, v' + VERSION + ' and explicit offline disclaimer', () => {
  caps(null)
  const rows = new WelcomeHeader().render(80)
  const normal = rows.map(stripTerminalSequences).join('\n')
  assert.match(normal, /DeepSeek Harness/)
  assert.ok(normal.includes(TAGLINE), 'the tagline carries the shared application version')
  assert.doesNotMatch(normal, /prototype|DEMO/)
  // The startup tagline is the 品牌蓝, not muted chrome; the title above it uses
  // the heading role of the same single brand hue.
  assert.ok(rows.some(row => row.endsWith(t.accent(TAGLINE))), 'the tagline renders in the brand blue')
  assert.ok(!rows.some(row => row.endsWith(t.muted(TAGLINE))), 'the tagline is no longer muted')
  assert.ok(rows.some(row => row.endsWith(bold(t.accentBright('DeepSeek Harness')))), 'the title uses the heading role')
  const demo = new WelcomeHeader({ demo: true }).render(40).map(stripTerminalSequences).join('\n')
  assert.match(demo, /DEMO \/ NO MODEL CALLS/)
})

test('static logo/header cache remains deterministic through resize and invalidate', () => {
  caps('kitty')
  const header = new WelcomeHeader({ demo: true }), first = header.render(80)
  assert.deepEqual(header.render(80), first)
  header.render(40); header.invalidate()
  assert.deepEqual(header.render(80), first)
  const surface = header as unknown as Record<string, unknown>
  assert.equal(surface.setAnimationFrame, undefined)
  assert.equal(surface.handleInput, undefined)
  assert.equal(surface.capturesViewportInput, undefined)
})

test('all lines fit the terminal and the whole character logo fits a 40-column window', () => {
  caps(null)
  for (const width of [1, 2, 4, 12, 24, 32, 34, 40, 80, 120, 160]) {
    const rows = new WelcomeHeader({ demo: true }).render(width)
    assert.ok(rows.length <= 9)
    rows.forEach(row => assert.ok(visibleWidth(row) <= width, `width ${width}`))
  }
  assert.equal(WELCOME_LOGO_MIN_WIDTH, 34)
  assert.equal(new WelcomeHeader().hasLogo(40), true)
  assert.equal(new WelcomeHeader().render(40).length, 6, 'the whole 16x6 logo fits 40 columns')
})

test('logo implementation contains no image transport, frame data or scheduled playback', () => {
  const logo = readFileSync(new URL('../src/ui/logo.ts', import.meta.url), 'utf8')
  const welcome = readFileSync(new URL('../src/ui/welcome.ts', import.meta.url), 'utf8')
  for (const source of [logo, welcome]) {
    assert.doesNotMatch(source, /new Image\(|allocateImageId|getCapabilities\(|setTimeout\(|setInterval\(|setAnimationFrame|LOGO_OPENING|LOGO_IMAGES|LOGO_DOTS|[\u2800-\u28ff]/u)
  }
  // One release identity: the welcome tagline reads src/version.ts instead of
  // hard-coding a version that could drift from the CLI/plugin version.
  assert.match(welcome, /import \{ VERSION \} from '\.\.\/version\.ts'/)
  assert.doesNotMatch(welcome, /\bv?\d+\.\d+\.\d+\b/, 'the tagline version is not a second literal')
})