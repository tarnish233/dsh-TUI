/**
 * DSH TUI theme: a compact Claude-Code-like dark palette built from Pi TUI's
 * public color helpers. No Pi Agent components or private renderer state.
 *
 * The palette and the markdown/select shape are adapted from agent_tui
 * (MIT, /Users/fulei/workspace/agent_tui/src/ui/theme.ts) and pi-cc-extensions'
 * `cc-dark` theme (MIT), which is the authoritative source for every shared
 * token: fg/muted/subtle, canvas/canvasSubtle, border, the blue family,
 * selection, the diff bands and the markdown chrome. Keep attribution when
 * copying.
 *
 * 品牌蓝双档 (cc-dark 复刻), user decision 2026-11-05:
 * - `BRAND_BLUE` (cc-dark `blue`, deep) is the primary interface blue: prompt
 *   arrow, editor frame, working status, footer, tagline and links. (The
 *   logo keeps its own DeepSeek asset blue in src/ui/logo.ts.) `BRAND_BLUE_BRIGHT` (cc-dark `blueBright`) is the heading tier:
 *   welcome/dialog/picker titles, focused labels, chips, list bullets. Both
 *   hexes are defined only in src/ui/brand.ts; re-branding edits that file.
 * - `accent` and `accentBright` are the two ROLE tokens mapped onto those two
 *   tiers by the assignments of `accentBlue` / `accentBrightBlue` below — no
 *   call site ever changes.
 * - Layers are kept apart on purpose: surfaces (accentDim/accentBg/userBg) are
 *   dark blue bands, not brand text chrome; content colors (inline code,
 *   syntax highlighting in src/ui/highlight.ts) are content, not chrome.
 * Retired blues — names only, their hexes must never reappear anywhere under
 * src/: the DeepSeek pixel blue, the former cc-dark accent blue and the old
 * product brand blue that preceded it.
 * Warning/error/success, diff add/delete and code syntax keep their own
 * semantic colors; see docs/THEME.md before adding a new accent.
 */
import {
  backgroundAnsi,
  foregroundAnsi,
  getTerminalColorMode,
  type MarkdownTheme,
  parseColor,
  type SelectListTheme,
  type EditorTheme,
} from '#pi-tui'
import { BRAND_BLUE, BRAND_BLUE_BRIGHT } from './brand.ts'
import { highlightCode } from './highlight.ts'

export type Style = (text: string) => string

const mode = getTerminalColorMode()

export function fg(hex: string): Style {
  const open = foregroundAnsi(parseColor(hex), mode)
  return text => (text === '' ? '' : `${open}${text}\x1b[39m`)
}

export function bg(hex: string): Style {
  const open = backgroundAnsi(parseColor(hex), mode)
  return text => (text === '' ? '' : `${open}${text}\x1b[49m`)
}

export const bold: Style = text => (text === '' ? '' : `\x1b[1m${text}\x1b[22m`)
export const dim: Style = text => (text === '' ? '' : `\x1b[2m${text}\x1b[22m`)
export const italic: Style = text => (text === '' ? '' : `\x1b[3m${text}\x1b[23m`)
export const underline: Style = text => (text === '' ? '' : `\x1b[4m${text}\x1b[24m`)
export const strike: Style = text => (text === '' ? '' : `\x1b[9m${text}\x1b[29m`)
export const inverse: Style = text => (text === '' ? '' : `\x1b[7m${text}\x1b[27m`)

/**
 * 单蓝 role tokens. The two names survive the single-hue decision so a ramp can
 * come back without touching call sites; today both values are the brand blue.
 */
/** Interface accent: prompt arrow, editor frame, working status, footer. */
const accentBlue = BRAND_BLUE
/** Headings, focused labels, list bullets, dialog titles (the bright tier). */
const accentBrightBlue = BRAND_BLUE_BRIGHT
/**
 * Surface family (not brand-derived): the dim blue for rules/dividers and the
 * blue tint behind chips, badges and human turns. These are backgrounds/bands
 * rather than brand text chrome, so they keep their own literal values.
 */
const accentDimBlue = '#2a4060'
/** Surface family: blue tint behind chips/badges and human turns. */
const accentBgBlue = '#1a4480'
/** Content color (not brand-derived): inline code blue, from cc-dark `mdCode`. */
const inlineCode = fg('#a5d6ff')
/** Surface color: markdown quote rules share the dim blue band. */
const quoteBorder = fg('#2a4060')

export const palette = {
  fg: '#d6dde3',
  muted: '#929eab',
  subtle: '#768494',
  canvas: '#0d1117',
  canvasSubtle: '#1c2033',
  border: '#1c2d44',
  /** Primary interface accent: the 品牌蓝 (brand blue). */
  accent: accentBlue,
  /** Headings/focus role: same brand hue today (single-blue decision). */
  accentBright: accentBrightBlue,
  /** Dim blue surface for rules/dividers on blue-tinted bands. */
  accentDim: accentDimBlue,
  /** Blue tint background for the demo badge and chips. */
  accentBg: accentBgBlue,
  green: '#37b34a',
  greenBright: '#56d364',
  red: '#ff6e62',
  redSoft: '#ff7b72',
  yellow: '#cb9214',
  /** Warning-ish/amber family. Syntax variable/signature use `orangeSoft`; never chrome. */
  orange: '#f0883e',
  orangeSoft: '#ffa657',
  /** Extra hues retained for syntax/diff/diagnostic use only. */
  purple: '#be8fff',
  pink: '#f778ba',
  cyan: '#39c5cf',
  diffAddBg: '#0f2a24',
  diffDelBg: '#261418',
  /** Blue tint band behind human turns (surface, not brand text chrome). */
  userBg: '#1a4480',
} as const

export const t = {
  text: fg(palette.fg),
  muted: fg(palette.muted),
  subtle: fg(palette.subtle),
  border: fg(palette.border),
  /** The one interface accent: the 品牌蓝 (brand blue). */
  accent: fg(palette.accent),
  accentBright: fg(palette.accentBright),
  accentDim: fg(palette.accentDim),
  accentBg: bg(palette.accentBg),
  green: fg(palette.green),
  greenBright: fg(palette.greenBright),
  red: fg(palette.red),
  redSoft: fg(palette.redSoft),
  yellow: fg(palette.yellow),
  orange: fg(palette.orange),
  orangeSoft: fg(palette.orangeSoft),
  purple: fg(palette.purple),
  pink: fg(palette.pink),
  cyan: fg(palette.cyan),
  diffAddBg: bg(palette.diffAddBg),
  diffDelBg: bg(palette.diffDelBg),
  userBg: bg(palette.userBg),
}

/**
 * Claude Code's semantic dialog colors. Dialog titles, section headings and
 * focused rows use the 品牌蓝 (brand blue, both roles share the hue today);
 * success/warning/error stay semantic. `inverseText` is the black label on a
 * bright brand chip.
 */
export const ccPalette = {
  permission: accentBrightBlue,
  suggestion: accentBrightBlue,
  success: '#4eba65',
  inactive: '#999999',
  warning: '#ffc107',
  error: '#ff6b80',
  inverseText: '#000000',
} as const

export const cc = {
  permission: fg(ccPalette.permission),
  suggestion: fg(ccPalette.suggestion),
  success: fg(ccPalette.success),
  inactive: fg(ccPalette.inactive),
  warning: fg(ccPalette.warning),
  error: fg(ccPalette.error),
  /** Active dialog tab: inverse text on the permission color. */
  chip: (text: string): string => bg(ccPalette.permission)(fg(ccPalette.inverseText)(text)),
}

export const markdownTheme: MarkdownTheme = {
  heading: text => bold(t.accentBright(text)),
  link: text => underline(t.accent(text)),
  linkUrl: text => t.subtle(text),
  /**
   * Inline code is content, not interface chrome: it uses the content blue
   * (#a5d6ff, cc-dark `mdCode`) rather than the brand hue or the syntax orange.
   */
  code: inlineCode,
  codeBlock: text => t.text(text),
  /** cc-dark `mdCodeBlockBorder` = border. */
  codeBlockBorder: text => t.border(text),
  quote: text => italic(t.muted(text)),
  /** Dim blue surface rule (#2a4060), not brand-derived. */
  quoteBorder: quoteBorder,
  hr: text => t.border(text),
  /** List bullets are interface chrome: the 品牌蓝. */
  listBullet: text => t.accentBright(text),
  bold: text => bold(text),
  italic: text => italic(text),
  strikethrough: text => strike(text),
  underline: text => underline(text),
  highlightCode,
}

export const selectListTheme: SelectListTheme = {
  selectedPrefix: text => t.accent(text),
  selectedText: text => bold(t.accentBright(text)),
  description: text => t.muted(text),
  scrollInfo: text => t.subtle(text),
  noMatch: text => t.yellow(text),
}

export const editorTheme: EditorTheme = {
  // The input frame is interaction chrome in the 品牌蓝 (t.accent, i.e. the
  // single brand hue): the plain `border` swatch (#1c2d44) is nearly invisible
  // on the dark canvas, and the retired DeepSeek pixel blue reads too dark for
  // a frame.
  borderColor: t.accent,
  selectList: selectListTheme,
}