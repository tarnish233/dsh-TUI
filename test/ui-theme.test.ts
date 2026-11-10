// Must stay the FIRST import: forces truecolor capabilities before any src
// module (theme.ts snapshots getTerminalColorMode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { BRAND_BLUE, BRAND_BLUE_BRIGHT } from '../src/ui/brand.ts'
import {
  bg,
  bold,
  cc,
  ccPalette,
  editorTheme,
  fg,
  markdownTheme,
  palette,
  selectListTheme,
  t,
  underline,
} from '../src/ui/theme.ts'

/**
 * Theme contract: ONE brand blue (单蓝) for all interface chrome, while
 * warning/error/success, diff add/delete and code content keep their own
 * semantic colors. The brand hue is defined exactly once — `BRAND_BLUE` in
 * src/ui/brand.ts — and every chrome token must resolve to it. Unchanged
 * cc-dark tokens stay pinned as hardcoded hex so a palette drift fails loudly.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC_DIR = join(ROOT, 'src')
const BRAND_FILE = join(SRC_DIR, 'ui', 'brand.ts')
const LOGO_FILE = join(SRC_DIR, 'ui', 'logo.ts')
/** The single place a literal brand-value hex is allowed: content syntax. */
/**
 * The content syntax palette. It moved out of `highlight.ts` when the grammar
 * tables became lazily loaded, so the hex allowlist follows the palette module.
 * `highlight.ts` (the lazy facade) and `highlight-runtime.ts` (the grammar
 * table) must not spell any color.
 */
const CONTENT_HEX_FILE = join(SRC_DIR, 'ui', 'highlight-palette.ts')
/** Retired chrome blues (names for history only): DeepSeek pixel blue, the old
 * cc-dark accent blue, the pre-cc-dark product brand blue. They must never
 * reappear anywhere under src/. */
const RETIRED_BLUES = ['#335de0', '#4d6bfe'] as const

function rgb(hex: string): { r: number; g: number; b: number } {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `not a hex color: ${hex}`)
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  }
}

function hue(hex: string): number {
  const { r, g, b } = rgb(hex)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const delta = max - min
  if (delta === 0) return 0
  const raw = max === r ? (g - b) / delta : max === g ? 2 + (b - r) / delta : 4 + (r - g) / delta
  return (raw * 60 + 360) % 360
}

function luminance(hex: string): number {
  const { r, g, b } = rgb(hex)
  const channel = (value: number): number => {
    const unit = value / 255
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((left, right) => right - left) as [number, number]
  return (light + 0.05) / (dark + 0.05)
}

function assertHue(name: string, hex: string, min: number, max: number): void {
  const value = hue(hex)
  assert.ok(value >= min && value <= max, `${name} hue ${value.toFixed(1)} outside ${min}..${max}: ${hex}`)
}

// The azure/sky blue family spans ~208-216 degrees of hue (brand tiers #4f9eff
// dim/bg surface tints); the retired pixel blue sat near 225 degrees. Anything
// outside that band is not "blue" here.
const assertBlue = (name: string, hex: string): void => assertHue(name, hex, 200, 255)

/** Every .ts file under src/, recursively. */
function sourceFiles(directory: string = SRC_DIR): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(full))
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(full)
  }
  return files
}

test('every palette token matches the theme exactly', () => {
  assert.deepEqual(
    {
      fg: palette.fg,
      muted: palette.muted,
      subtle: palette.subtle,
      canvas: palette.canvas,
      canvasSubtle: palette.canvasSubtle,
      border: palette.border,
      accent: palette.accent,
      accentBright: palette.accentBright,
      accentDim: palette.accentDim,
      accentBg: palette.accentBg,
      userBg: palette.userBg,
      diffAddBg: palette.diffAddBg,
      diffDelBg: palette.diffDelBg,
    },
    {
      fg: '#d6dde3',
      muted: '#929eab',
      subtle: '#768494',
      canvas: '#0d1117',
      canvasSubtle: '#1c2033',
      border: '#1c2d44',
      accent: '#4f9eff',
      accentBright: '#79c0ff',
      accentDim: '#2a4060',
      accentBg: '#1a4480',
      userBg: '#1a4480',
      diffAddBg: '#0f2a24',
      diffDelBg: '#261418',
    },
  )
  for (const name of ['accent', 'accentBright', 'accentDim', 'accentBg', 'userBg'] as const) {
    assertBlue(name, palette[name])
  }
})

test('the brand blue tiers are defined once in brand.ts (cc-dark 复刻双蓝)', () => {
  // The ONLY brand-hex locks: the role tokens must BE the brand constants, not
  // copies of their values, so re-branding stays a one-file change in brand.ts.
  assert.equal(palette.accent, BRAND_BLUE, 'the interface accent IS the primary brand constant')
  assert.equal(palette.accentBright, BRAND_BLUE_BRIGHT, 'the heading tier IS the bright brand constant')
  // Two-tier cc-dark look (user, 2026-11-05): the bright tier must be a
  // distinct, lighter step above the primary (never equal, never reversed).
  assert.notEqual(palette.accent, palette.accentBright, 'the heading tier is a separate ramp step')
  assert.ok(luminance(palette.accentBright) > luminance(palette.accent), 'accentBright is lighter than accent')
  assertBlue('accent', palette.accent)
  assertBlue('accentBright', palette.accentBright)
  assertBlue('accentDim', palette.accentDim)
  assertBlue('accentBg', palette.accentBg)
})

test('the dead blue aliases are gone from palette, t and the cc family', () => {
  for (const name of ['dshBlue', 'blue', 'blueBright', 'brandBlue'] as const) {
    assert.equal(Object.hasOwn(palette, name), false, `palette.${name} is a dead alias`)
    assert.equal(Object.hasOwn(t, name), false, `t.${name} is a dead alias`)
  }
  assert.equal(Object.hasOwn(ccPalette, 'claude'), false, 'ccPalette.claude is a dead alias')
  assert.equal(Object.hasOwn(cc, 'claude'), false, 'cc.claude is a dead alias')
})

test('dialogs, lists, markdown chrome and the editor frame share the brand blue', () => {
  assertBlue('cc permission', ccPalette.permission)
  assertBlue('cc suggestion', ccPalette.suggestion)
  // cc-dark look: dialog titles/suggestions ride the bright tier; the editor
  // frame and selected prefix ride the primary.
  assert.equal(cc.permission('Title'), t.accentBright('Title'))
  assert.equal(cc.suggestion('❯'), t.accentBright('❯'))
  assert.equal(ccPalette.permission, BRAND_BLUE_BRIGHT)
  assert.equal(ccPalette.suggestion, BRAND_BLUE_BRIGHT)
  assert.equal(cc.chip(' Active '), bg(ccPalette.permission)(fg(ccPalette.inverseText)(' Active ')))

  assert.equal(selectListTheme.selectedPrefix('❯'), t.accent('❯'))
  assert.equal(selectListTheme.selectedText('row'), bold(t.accentBright('row')))
  assert.equal(markdownTheme.heading('Heading'), bold(t.accentBright('Heading')))
  assert.equal(markdownTheme.link('link'), underline(t.accent('link')))
  assert.equal(markdownTheme.listBullet('•'), t.accentBright('•'))
  // Surface rule: the quote border is the dim blue band, unrelated to the brand
  // hue (kept literal on purpose — surfaces are not brand-derived).
  assert.equal(markdownTheme.quoteBorder('│'), fg(palette.accentDim)('│'))
  assert.equal(markdownTheme.codeBlockBorder('```'), t.border('```'))
  // The editor frame is interaction chrome: the brand blue, not the
  // near-invisible content-rule border (#1c2d44).
  assert.equal(editorTheme.borderColor, t.accent)
  assert.equal(editorTheme.selectList, selectListTheme)
})

test('the blue accent is readable on the dark canvas', () => {
  const ratio = contrast(palette.accent, palette.canvas)
  assert.ok(ratio >= 4.5, `accent contrast ${ratio.toFixed(2)} on the dark canvas`)
  const badge = contrast(palette.accentBright, palette.accentBg)
  assert.ok(badge >= 4.5, `badge text contrast ${badge.toFixed(2)} on the blue tint`)
  const inverseChip = contrast(ccPalette.inverseText, ccPalette.permission)
  assert.ok(inverseChip >= 4.5, `inverse chip contrast ${inverseChip.toFixed(2)}`)
})

test('the previous CC orange and lavender chrome is gone', () => {
  for (const stale of ['#f0883e', '#d77757', '#b1b9f9', '#ffa657']) {
    for (const [name, hex] of [
      ['accent', palette.accent],
      ['accentBright', palette.accentBright],
      ['permission', ccPalette.permission],
      ['suggestion', ccPalette.suggestion],
    ] as const) {
      assert.notEqual(hex, stale, `${name} still uses ${stale}`)
    }
  }
})

test('success, warning and error keep their meaning', () => {
  assert.equal(ccPalette.success, '#4eba65')
  assert.equal(ccPalette.warning, '#ffc107')
  assert.equal(ccPalette.error, '#ff6b80')
  assert.equal(ccPalette.inactive, '#999999')
  assertHue('success', ccPalette.success, 100, 160)
  assertHue('warning', ccPalette.warning, 35, 65)
  // Red wraps around 0 degrees.
  assert.ok(hue(ccPalette.error) >= 340 || hue(ccPalette.error) <= 20, `error is not red: ${ccPalette.error}`)
  const semantic: Array<readonly [string, string, string]> = [
    ['success', cc.success('ok'), t.accent('ok')],
    ['warning', cc.warning('careful'), t.accent('careful')],
    ['error', cc.error('failed'), t.accent('failed')],
    ['tool error', t.redSoft('error text'), t.accent('error text')],
    ['status done', t.green('done'), t.accent('done')],
  ]
  for (const [name, rendered, accent] of semantic) {
    assert.notEqual(rendered, accent, `${name} must not be painted with the brand blue`)
  }
})

test('diff and code colors stay semantic', () => {
  assert.equal(t.diffAddBg('x'), bg(palette.diffAddBg)('x'))
  assert.equal(t.diffDelBg('x'), bg(palette.diffDelBg)('x'))
  // The added band is a green-teal (#0f2a24, ~167 degrees), so the band accepts
  // the wider green range; the removed band stays red in hue.
  assertHue('diff add band', palette.diffAddBg, 100, 185)
  assert.ok(hue(palette.diffDelBg) >= 340 || hue(palette.diffDelBg) <= 20, 'diff delete band stays red')
  assert.notEqual(palette.diffAddBg, palette.accentBg)
  assert.notEqual(palette.diffDelBg, palette.accentBg)

  // Inline code is CONTENT, not chrome: it keeps its own content blue and is
  // deliberately not derived from the brand hue.
  const contentInlineCode = '#a5d6ff'
  assert.equal(markdownTheme.code('inline'), fg(contentInlineCode)('inline'))
  assert.notEqual(markdownTheme.code('inline'), t.accent('inline'))
  assert.notEqual(markdownTheme.code('inline'), t.orangeSoft('inline'))
})

test('no retired brand hex survives anywhere under src', () => {
  const files = sourceFiles()
  assert.ok(files.length > 0)
  assert.ok(files.includes(BRAND_FILE), 'the brand truth point exists')
  for (const file of files) {
    const source = readFileSync(file, 'utf8').toLowerCase()
    const name = relative(ROOT, file)
    for (const retired of RETIRED_BLUES) {
      // The DeepSeek logo asset blue is reinstated by the user (2026-11-05)
      // and lives ONLY in the logo module, as an asset color next to white.
      if (retired === '#335de0' && file === LOGO_FILE) continue
      assert.ok(!source.includes(retired), `${name} still contains the retired blue ${retired}`)
    }
    // The current brand VALUE as a literal is only legal in the content syntax
    // palette (src/ui/highlight-palette.ts) — there it is a coincidence, not a
    // derivation. The truth point itself is excluded (it spells the brand).
    if (file === BRAND_FILE) continue
    if (file === CONTENT_HEX_FILE) continue
    assert.ok(
      !source.includes(BRAND_BLUE.toLowerCase()),
      `${name} inlines the brand hex; import BRAND_BLUE from src/ui/brand.ts instead`,
    )
    assert.ok(
      !source.includes(BRAND_BLUE_BRIGHT.toLowerCase()),
      `${name} inlines the bright brand hex; import BRAND_BLUE_BRIGHT from src/ui/brand.ts instead`,
    )
  }
})

test('no leftover orange, purple or turquoise UI accent in src/ui', () => {
  // `theme.ts` owns the palette and the content syntax palette is its own module.
  const files = readdirSync(join(SRC_DIR, 'ui')).filter(file =>
    file.endsWith('.ts') && file !== 'theme.ts' && file !== 'highlight-palette.ts')
  assert.ok(files.length > 0)
  for (const file of files) {
    const source = readFileSync(join(SRC_DIR, 'ui', file), 'utf8')
    for (const style of ['t.orange(', 't.purple(', 't.pink(', 't.cyan(', 'cc.claude(']) {
      assert.ok(!source.includes(style), `${file} still uses ${style} as interface chrome`)
    }
    assert.ok(!/#(?:f0883e|be8fff|f778ba|39c5cf|d77757|b1b9f9)/i.test(source), `${file} inlines a stale accent hex`)
  }
  // The brand blue is the interface highlight in rendered conversation chrome.
  const blocks = readFileSync(join(SRC_DIR, 'ui', 'blocks.ts'), 'utf8')
  assert.ok(blocks.includes('t.accent('), 'blocks.ts highlights chips with the brand blue')
})

test('human turns keep the blue selection band (surface, not brand-derived)', () => {
  assertBlue('user band', palette.userBg)
  assert.ok(luminance(palette.userBg) < luminance(palette.fg), 'the human-turn band stays darker than body text')
  assert.equal(palette.userBg, palette.accentBg)
  assert.notEqual(palette.userBg, palette.accent, 'the band is a surface tint, not the brand text hue')
})