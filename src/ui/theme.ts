/**
 * DSH TUI theme: a compact Claude-Code-like dark palette built from Pi TUI's
 * public color helpers. No Pi Agent components or private renderer state.
 *
 * The palette and the markdown/select shape are adapted from agent_tui
 * (MIT, /Users/fulei/workspace/agent_tui/src/ui/theme.ts) and the cc-dark
 * values used by pi-cc-extensions (MIT). Keep attribution when copying.
 */
import {
  backgroundAnsi,
  foregroundAnsi,
  getTerminalColorMode,
  type MarkdownTheme,
  parseColor,
  type SelectListTheme,
  type EditorTheme,
} from '@earendil-works/pi-tui'
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

export const palette = {
  fg: '#d6dde3',
  muted: '#929eab',
  subtle: '#768494',
  canvas: '#0d1117',
  canvasSubtle: '#1c2033',
  border: '#2b3d57',
  blue: '#4f9eff',
  blueBright: '#79c0ff',
  /** DSH "Gentle Mist Blue" dark accent and brand blue. */
  dshBlue: '#7DA1DE',
  dshBrandBlue: '#4D6BFE',
  green: '#37b34a',
  greenBright: '#56d364',
  red: '#ff6e62',
  redSoft: '#ff7b72',
  yellow: '#cb9214',
  orange: '#f0883e',
  orangeSoft: '#ffa657',
  purple: '#be8fff',
  pink: '#f778ba',
  cyan: '#39c5cf',
  diffAddBg: '#12351c',
  diffDelBg: '#3d1518',
  /** DSH dark `selectionBg`: a mist-blue tint, used for human turns. */
  userBg: '#3B4A66',
} as const

export const t = {
  text: fg(palette.fg),
  muted: fg(palette.muted),
  subtle: fg(palette.subtle),
  border: fg(palette.border),
  accent: fg(palette.orange),
  blue: fg(palette.blue),
  blueBright: fg(palette.blueBright),
  dshBlue: fg(palette.dshBlue),
  dshBrandBlue: fg(palette.dshBrandBlue),
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

/** Claude Code's semantic dialog colors (suggestion/success/inactive/chip). */
export const ccPalette = {
  permission: '#b1b9f9',
  suggestion: '#b1b9f9',
  success: '#4eba65',
  inactive: '#999999',
  warning: '#ffc107',
  error: '#ff6b80',
  inverseText: '#000000',
  claude: '#d77757',
} as const

export const cc = {
  permission: fg(ccPalette.permission),
  suggestion: fg(ccPalette.suggestion),
  success: fg(ccPalette.success),
  inactive: fg(ccPalette.inactive),
  warning: fg(ccPalette.warning),
  error: fg(ccPalette.error),
  claude: fg(ccPalette.claude),
  /** Active dialog tab: inverse text on the permission color. */
  chip: (text: string): string => bg(ccPalette.permission)(fg(ccPalette.inverseText)(text)),
}

export const markdownTheme: MarkdownTheme = {
  heading: text => bold(t.blueBright(text)),
  link: text => underline(t.blue(text)),
  linkUrl: text => t.subtle(text),
  code: text => t.orangeSoft(text),
  codeBlock: text => t.text(text),
  codeBlockBorder: text => t.subtle(text),
  quote: text => italic(t.muted(text)),
  quoteBorder: text => t.border(text),
  hr: text => t.border(text),
  listBullet: text => t.muted(text),
  bold: text => bold(text),
  italic: text => italic(text),
  strikethrough: text => strike(text),
  underline: text => underline(text),
  highlightCode,
}

export const selectListTheme: SelectListTheme = {
  selectedPrefix: text => t.blue(text),
  selectedText: text => bold(t.blue(text)),
  description: text => t.muted(text),
  scrollInfo: text => t.subtle(text),
  noMatch: text => t.yellow(text),
}

export const editorTheme: EditorTheme = {
  borderColor: t.border,
  selectList: selectListTheme,
}
