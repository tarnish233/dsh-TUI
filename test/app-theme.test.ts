import './helpers/truecolor.ts'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { App } from '../src/app.ts'
import { PromptHistory } from '../src/config.ts'
import { DemoBackend } from '../src/demo.ts'
import type { SessionInfo } from '../src/backend/types.ts'
import { VERSION } from '../src/version.ts'
import { palette } from '../src/ui/theme.ts'
import { LOGO_BLUE } from '../src/ui/logo.ts'
import { VirtualTerminal, delay, until } from './helpers/terminal.ts'
import { after } from 'node:test'

const hex = (value: string): number => Number.parseInt(value.slice(1), 16)
/** Parent-owned acceptance checks the actual rendered terminal cells. The
 * expected hues derive from the live palette (single source: brand.ts), so a
 * brand-color change can never leave these assertions stale. */
const BRAND_BLUE = hex(palette.accent) // 品牌蓝主档 (src/ui/brand.ts): logo blocks, prompt arrow, frame, footer
const CC_DARK_TEXT_BLUE = hex(palette.accent) // the deep primary doubles as the text chrome accent
const CC_DARK_HEADING_BLUE = hex(palette.accentBright) // 品牌蓝亮档 (cc-dark blueBright): welcome/dialog titles
/** The vivid per-character hues of the top effort marker (pink/orange/cyan). */
const CC_MAX_EFFORT_HUES = [0xf778ba, 0xf0883e, 0x39c5cf]
const OLD_CC_ACCENTS = new Set([0xd77757, 0xf0883e, 0xb1b9f9, 0xbe8fff, 0x6d86ff, 0x9fb3ff])

async function paint(terminal: VirtualTerminal): Promise<void> {
  await delay(35)
  await terminal.flush()
}

/** Cell-level RGB foreground of every character of the first `text` run on a line. */
function runForegrounds(terminal: VirtualTerminal, text: string, lineContains?: string): (number | undefined)[] {
  const wanted = Array.from(text).length
  const buffer = terminal.xterm.buffer.active
  for (let row = 0; row < terminal.rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row)
    if (!line) continue
    let contents = ''
    const positions: number[] = []
    for (let column = 0; column < terminal.columns; column++) {
      const cell = line.getCell(column)
      if (!cell || cell.getWidth() === 0) continue
      const chars = cell.getChars() || ' '
      for (let index = 0; index < chars.length; index++) positions.push(column)
      contents += chars
    }
    if (lineContains !== undefined && !contents.includes(lineContains)) continue
    const index = contents.indexOf(text)
    if (index < 0) continue
    const colors: (number | undefined)[] = []
    for (let offset = 0; offset < wanted; offset++) {
      const cell = line.getCell(positions[index + offset] ?? 0)
      colors.push(cell?.isFgRGB() ? cell.getFgColor() : undefined)
    }
    return colors
  }
  return []
}

function foregroundFor(terminal: VirtualTerminal, text: string, lineContains?: string): number | undefined {
  return runForegrounds(terminal, text, lineContains)[0]
}

/**
 * Hue of the footer's working-directory line. A cwd longer than the terminal
 * wraps over several rows, so measure the first row that starts the path
 * instead of requiring the whole path on one row.
 */
function pathForeground(terminal: VirtualTerminal, cwd: string): number | undefined {
  const buffer = terminal.xterm.buffer.active
  for (let row = 0; row < terminal.rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row)
    if (!line) continue
    const contents = line.translateToString(true)
    if (contents.length < 2 || !(contents.startsWith(cwd) || cwd.startsWith(contents))) continue
    const cell = line.getCell(0)
    return cell?.isFgRGB() ? cell.getFgColor() : undefined
  }
  return undefined
}

/** The DeepSeek logo asset blue as a single 0xRRGGBB number (independent of the brand tiers). */
const LOGO_ASSET_BLUE = (LOGO_BLUE[0] << 16) | (LOGO_BLUE[1] << 8) | LOGO_BLUE[2]

function bluePixelCount(terminal: VirtualTerminal): number {
  const buffer = terminal.xterm.buffer.active
  let count = 0
  for (let row = 0; row < terminal.rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row)
    if (!line) continue
    for (let column = 0; column < terminal.columns; column++) {
      const cell = line.getCell(column)
      if (cell && /[\u2580-\u259f]/u.test(cell.getChars()) && cell.isFgRGB() && cell.getFgColor() === LOGO_ASSET_BLUE) count++
    }
  }
  return count
}

function assertBlue(terminal: VirtualTerminal, text: string): void {
  const color = foregroundFor(terminal, text)
  assert.notEqual(color, undefined, 'RGB styling is present on ' + text)
  assert.ok(color !== undefined && !OLD_CC_ACCENTS.has(color), 'no old CC orange/lavender accent on ' + text)
  if (color === undefined) return
  const red = color >> 16 & 255, green = color >> 8 & 255, blue = color & 255
  assert.ok(blue > red && blue > green && blue - red >= 30, text + ' uses a saturated DeepSeek-blue family color')
}

async function fixture(screen: 'inline' | 'fullscreen', options: { fail?: boolean; history?: boolean; delayMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-theme-'))
  if (options.history) await new PromptHistory(directory, directory).add('theme latest needle')
  class FailingBackend extends DemoBackend {
    override async connect(): Promise<SessionInfo> { throw new Error('synthetic startup failure') }
  }
  const terminal = new VirtualTerminal(110, 32)
  const backend = options.fail ? new FailingBackend({ cwd: directory, delayMs: 0 }) : new DemoBackend({ cwd: directory, delayMs: options.delayMs ?? 0 })
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen, demo: true, registerSignals: false })
  await app.start()
  await paint(terminal)
  return {
    app, backend, terminal, directory,
    async close() {
      try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
    },
  }
}

for (const screen of ['inline', 'fullscreen'] as const) {
  test('parent theme: startup pixel whale and brand are blue without changing input or transcript (' + screen + ')', async () => {
    const f = await fixture(screen)
    try {
      assert.match(f.terminal.screen(), /DeepSeek Harness/)
      assert.ok(f.terminal.screen().includes('DSH TUI · v' + VERSION), 'the tagline carries the shared application version')
      assert.match(f.terminal.screen(), /DEMO \/ NO MODEL CALLS/)
      assert.doesNotMatch(f.terminal.screen(), /prototype|Claude Code|🐳|🐋/u)
      assert.equal(foregroundFor(f.terminal, 'DeepSeek Harness'), CC_DARK_HEADING_BLUE, 'startup text uses the cc-dark blueBright heading tint')
      assert.equal(foregroundFor(f.terminal, 'v' + VERSION), CC_DARK_TEXT_BLUE, 'the startup tagline uses the cc-dark blue accent')
      assert.ok(bluePixelCount(f.terminal) >= 8, 'the static reference logo is visible in the DeepSeek asset blue')
      assert.equal(foregroundFor(f.terminal, '❯'), CC_DARK_TEXT_BLUE, 'the prompt arrow stays the cc-dark blue accent')
      assert.deepEqual(f.app.store.items, [], 'the welcome component does not create conversation messages')
      assert.equal(f.app.editor.focused, true)

      f.terminal.type('same readline draft 中文 ')
      f.terminal.type('\x1b[200~paste one\npaste two\x1b[201~')
      f.terminal.type('\x02')
      const editor = f.app.editor, draft = editor.captureDraft()
      // The 40-column step keeps enough rows for the identity block: with a long
      // TMPDIR the footer legitimately wraps and the follow-end viewport would
      // otherwise scroll the header (not the draft) out of view.
      for (const [columns, rows] of [[80, 22], [40, 34], [120, 32]] as const) {
        f.terminal.resize(columns, rows)
        await paint(f.terminal)
        assert.match(f.terminal.screen(), /DeepSeek Harness/)
        assert.match(f.terminal.screen(), /DEMO \/ NO MODEL CALLS/)
        assert.match(f.terminal.screen(), /same readline draft/)
        assert.match(f.terminal.screen(), /ready/)
        assert.equal(f.app.editor, editor)
        assert.deepEqual(editor.captureDraft(), draft)
      }
      assert.ok(bluePixelCount(f.terminal) >= 8)
      assert.equal(foregroundFor(f.terminal, '❯'), CC_DARK_TEXT_BLUE)
      // CC-style status footer: the model route and working directory are the
      // cc-dark blue accent; the status segments stay dim.
      assert.equal(foregroundFor(f.terminal, 'demo (offline)/deepseek-demo'), CC_DARK_TEXT_BLUE, 'footer model route is cc-dark blue')
      assert.equal(pathForeground(f.terminal, f.directory), CC_DARK_TEXT_BLUE, 'footer working directory is cc-dark blue')
      // The effort is text-only now and rides the model as one visual unit: a
      // non-max level shares the model's blue accent (no circle glyph).
      assert.match(f.terminal.screen(), /demo \(offline\)\/deepseek-demo high/, 'the effort renders as plain text behind the model')
      assert.equal(foregroundFor(f.terminal, 'high', 'demo (offline)/deepseek-demo'), CC_DARK_TEXT_BLUE, 'non-max effort uses the same blue as the model route')
      // The input frame is interaction chrome in the 品牌蓝 (cc-dark accent blue):
      // the content-rule border (#1c2d44) was nearly invisible and the retired
      // DeepSeek pixel blue (#335de0) too dark, so the editor box shares the
      // single brand-baseline accent. A full-width `─` run on the editor rows
      // must carry it (top and bottom border), harmonizing with `❯` and footer.
      const editorBorderHue = foregroundFor(f.terminal, '─'.repeat(20))
      assert.equal(editorBorderHue, BRAND_BLUE, 'the editor frame uses the 品牌蓝 baseline, not the invisible content border')
      assert.notEqual(editorBorderHue, 0x1c2d44, 'the near-invisible cc-dark border never frames the input')
      assert.notEqual(editorBorderHue, 0x335de0, 'the retired DeepSeek pixel blue never frames the input')
    } finally { await f.close() }
  })

  test('parent theme: max effort is a per-character multicolor marker while the model stays blue (' + screen + ')', async () => {
    const f = await fixture(screen)
    try {
      await f.app.submit('/effort max')
      await until(() => f.app.session?.reasoningEffort === 'max', 'max effort is selected natively')
      await paint(f.terminal)
      assert.match(f.terminal.screen(), /demo \(offline\)\/deepseek-demo max · /, 'max renders as text directly behind the model')
      assert.doesNotMatch(f.terminal.screen(), /[●◕◔◉◎○]/, 'no circle glyph marks the effort any more')
      const hues = runForegrounds(f.terminal, 'max', 'demo (offline)/deepseek-demo')
      assert.equal(hues.length, 3, 'the whole `max` run is measured cell by cell')
      assert.ok(hues.every(hue => hue !== undefined), 'every character of `max` carries an explicit RGB hue')
      assert.equal(new Set(hues).size, 3, '`max` cycles three DIFFERENT hues, one per character (not one flat pink)')
      assert.deepEqual(hues, CC_MAX_EFFORT_HUES, 'the cycle is the vivid pink/orange/cyan marker')
      assert.equal(foregroundFor(f.terminal, 'demo (offline)/deepseek-demo'), CC_DARK_TEXT_BLUE, 'the model route next to it stays blue')
    } finally { await f.close() }
  })

  test('parent theme: Working status shares the blue accent and cancellation keeps the same editor (' + screen + ')', async () => {
    const f = await fixture(screen, { delayMs: 24 })
    try {
      await f.app.submit('offline theme working color acceptance')
      await until(() => f.terminal.screen().includes('Working'), 'Working status is actually painted')
      await paint(f.terminal)
      assert.equal(foregroundFor(f.terminal, 'Working'), CC_DARK_TEXT_BLUE)
      assert.doesNotMatch(f.terminal.screen(), /Streaming attempt/)
      f.terminal.type('working retained draft')
      f.terminal.type('\x02')
      const editor = f.app.editor, draft = editor.captureDraft()
      f.terminal.type('\x1b')
      await until(() => !f.app.isBusy, 'offline turn settles after Esc native interruption')
      await paint(f.terminal)
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), draft)
      assert.equal(foregroundFor(f.terminal, '❯'), CC_DARK_TEXT_BLUE)
      assert.match(f.terminal.screen(), /ready/)
    } finally { await f.close() }
  })

  test('parent theme: Help, provider picker and shortcut Settings use blue while keeping the main draft (' + screen + ')', async () => {
    const f = await fixture(screen)
    try {
      f.terminal.type('theme overlay retained draft')
      const editor = f.app.editor, draft = editor.captureDraft(), items = [...f.app.store.items]
      f.terminal.type('\x1bOP')
      await paint(f.terminal)
      assert.match(f.terminal.screen(), /Help/)
      assertBlue(f.terminal, 'Help')
      f.terminal.type('\r19')
      await paint(f.terminal)
      assert.match(f.terminal.screen(), /Help/)
      f.terminal.type('\x1b')
      await paint(f.terminal)

      f.terminal.type('\x1bp')
      await paint(f.terminal)
      assert.match(f.terminal.screen(), /Choose model/)
      assertBlue(f.terminal, 'Choose model')
      f.terminal.type('no-such-theme-model')
      await paint(f.terminal)
      f.terminal.type('\r')
      await paint(f.terminal)
      assert.match(f.terminal.screen(), /Choose model/, 'no result cannot choose a hidden model')
      f.terminal.type('\x1b')
      await paint(f.terminal)

      await f.app.submit('/settings')
      await paint(f.terminal)
      assertBlue(f.terminal, 'Settings')
      for (let step = 0; step < 6; step++) f.terminal.type('\x1b[C')
      f.terminal.type('\r') // Keyboard is an explicit Settings category.
      await paint(f.terminal)
      assert.match(f.terminal.screen(), /Keyboard shortcuts/)
      assertBlue(f.terminal, 'Keyboard shortcuts')
      f.terminal.type('\x1b')
      await paint(f.terminal)
      f.terminal.type('\x1b')
      await paint(f.terminal)
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), draft)
      assert.deepEqual(f.app.store.items, items)
      assert.equal(editor.focused, true)
    } finally { await f.close() }
  })

  test('parent theme: history search uses the shared blue accent rather than hardcoded CC orange (' + screen + ')', async () => {
    const f = await fixture(screen, { history: true })
    try {
      f.terminal.type('search retained draft')
      f.terminal.type('\x02')
      const editor = f.app.editor, draft = editor.captureDraft()
      f.terminal.type('\x12')
      f.terminal.type('needle')
      await paint(f.terminal)
      assert.match(f.terminal.screen(), /History search/)
      assert.match(f.terminal.screen(), /theme latest needle/)
      assert.equal(foregroundFor(f.terminal, 'History search'), CC_DARK_TEXT_BLUE)
      assert.equal(foregroundFor(f.terminal, 'needle', 'theme latest needle'), CC_DARK_TEXT_BLUE, 'matched history text is styled by the theme')
      assert.ok(!f.terminal.writes.join('').includes('\x1b[38;2;215;119;87m'), 'no literal CC orange styling remains in the search')
      f.terminal.type('\x03')
      await paint(f.terminal)
      assert.equal(f.app.editor, editor)
      assert.deepEqual(editor.captureDraft(), draft)
      assert.equal(editor.focused, true)
    } finally { await f.close() }
  })

  test('parent theme: backend startup failure stays readable and visibly red, not successful blue (' + screen + ')', async () => {
    const f = await fixture(screen, { fail: true })
    try {
      assert.match(f.terminal.screen(), /DeepSeek Harness/)
      assert.match(f.terminal.screen(), /Could not start DSH: synthetic startup failure/)
      assert.match(f.terminal.screen(), /disconnected/)
      const color = foregroundFor(f.terminal, 'Could not start DSH')
      assert.notEqual(color, BRAND_BLUE)
      assert.ok(color !== undefined && (color >> 16 & 255) > (color & 255), 'a failure retains a red semantic accent')
      assert.equal(f.app.store.items.filter(item => item.kind === 'notice').length, 1, 'no fake successful greeting is inserted into the conversation')
    } finally { await f.close() }
  })
}

test('the PTY color mirror stays in sync with the live palette', () => {
  const mirror = readFileSync(new URL('../scripts/pty-common.py', import.meta.url), 'utf8')
  const mirrorEscape = (name: string): number[] | undefined => {
    const match = new RegExp(`${name} = b'\\\\x1b\\[38;2;(\\d+);(\\d+);(\\d+)m'`).exec(mirror)
    return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
  }
  const rgb = (value: number): number[] => [(value >> 16) & 255, (value >> 8) & 255, value & 255]
  const primary = mirrorEscape('BRAND_BLUE')
  assert.ok(primary !== undefined, 'pty-common.py defines the BRAND_BLUE truecolor escape')
  if (primary !== undefined) {
    assert.deepEqual(primary, rgb(hex(palette.accent)),
      'scripts/pty-common.py mirrors the 品牌蓝主档 — when the brand color changes, update that mirror file too')
  }
  const heading = mirrorEscape('HEADING_BLUE')
  assert.ok(heading !== undefined, 'pty-common.py defines the HEADING_BLUE truecolor escape')
  if (heading !== undefined) {
    assert.deepEqual(heading, rgb(hex(palette.accentBright)),
      'scripts/pty-common.py mirrors the 品牌蓝亮档 — when the heading tier changes, update that mirror file too')
  }
  const logo = mirrorEscape('LOGO_BLUE')
  assert.ok(logo !== undefined, 'pty-common.py defines the LOGO_BLUE truecolor escape')
  if (logo !== undefined) {
    assert.deepEqual(logo, [...LOGO_BLUE],
      'scripts/pty-common.py mirrors the DeepSeek logo asset blue (src/ui/logo.ts) — when the logo color changes, update that mirror file too')
  }
})
