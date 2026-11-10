/**
 * Content syntax palette and the one plain-text code rendering.
 *
 * This module is deliberately free of `highlight.js`: it is on the startup path
 * of every UI surface (through `theme.ts`), so it may only depend on the public
 * Pi TUI color helpers. The grammar-driven part lives in
 * `src/ui/highlight-runtime.ts` and is reached through the lazy facade in
 * `src/ui/highlight.ts`.
 *
 * `plainHighlightLines` is the single definition of the unstyled fallback. The
 * facade must return byte-identical lines while the runtime is not loaded, so
 * the two paths share this function instead of duplicating the palette.
 *
 * Adapted from agent_tui (MIT) src/ui/highlight.ts and its cc-dark palette.
 */
import { foregroundAnsi, getTerminalColorMode, parseColor } from '#pi-tui'

const mode = getTerminalColorMode()
const color = (hex: string): string => foregroundAnsi(parseColor(hex), mode)

/**
 * Content syntax palette: independent of the interface chrome brand color.
 * `#79c0ff` (numbers, literals, properties, selectors) merely happens to equal
 * the brand blue's current value — it is NOT derived from src/ui/brand.ts.
 * Do not "tidy" these into the theme tokens: code color is content, the brand
 * hue is chrome, and a future brand change must not recolor syntax.
 */
const scopeColors: Record<string, string> = {
  keyword: color('#ff7b72'), 'selector-tag': color('#ff7b72'), 'template-tag': color('#ff7b72'), doctag: color('#ff7b72'),
  built_in: color('#ffa657'), type: color('#ffa657'), 'title.class': color('#ffa657'), 'title.class.inherited': color('#ffa657'),
  title: color('#d2a8ff'), 'title.function': color('#d2a8ff'), section: color('#79c0ff'),
  string: color('#a5d6ff'), regexp: color('#a5d6ff'), 'meta string': color('#a5d6ff'),
  number: color('#79c0ff'), literal: color('#79c0ff'), symbol: color('#79c0ff'), attr: color('#79c0ff'), attribute: color('#79c0ff'),
  property: color('#79c0ff'), variable: color('#ffa657'), 'template-variable': color('#ffa657'), meta: color('#79c0ff'),
  comment: color('#8b949e'), quote: color('#8b949e'), addition: color('#56d364'), deletion: color('#ffa198'),
  name: color('#7ee787'), 'selector-id': color('#79c0ff'), 'selector-class': color('#79c0ff'), bullet: color('#f2cc60'),
}

/** Default code foreground (cc-dark `mdCodeText`). */
export const DEFAULT_CODE_COLOR = color('#d6dde3')

/** One code block as unstyled-but-colored rows: the exact lazy fallback shape. */
export function plainHighlightLines(code: string): string[] {
  return code.split('\n').map(line => (line === '' ? '' : `${DEFAULT_CODE_COLOR}${line}\x1b[39m`))
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

function scopeColor(classes: string): string | undefined {
  const parts = classes.split(/\s+/).map(part => part.replace(/^hljs-/, '').replace(/_+$/, ''))
  const joined = parts.join('.')
  return scopeColors[joined] ?? scopeColors[parts[0] ?? ''] ?? undefined
}

/**
 * Convert highlight.js HTML into ANSI rows.
 *
 * Styling is applied here, at output time: the palette is the only place a
 * syntax color is chosen, and the renderer only ever sees ANSI + plain text.
 */
export function highlightedAnsiLines(html: string): string[] {
  const lines: string[] = ['']
  const stack: string[] = []
  const current = (): string => stack.at(-1) ?? DEFAULT_CODE_COLOR
  const pattern = /<span class="([^"]+)">|<\/span>|([^<]+)/g
  for (const match of html.matchAll(pattern)) {
    if (match[1] !== undefined) {
      stack.push(scopeColor(match[1]) ?? current())
    } else if (match[0] === '</span>') {
      stack.pop()
    } else if (match[2] !== undefined) {
      const pieces = decodeEntities(match[2]).split('\n')
      pieces.forEach((piece, index) => {
        if (index > 0) lines.push('')
        if (piece !== '') lines[lines.length - 1] += `${current()}${piece}\x1b[39m`
      })
    }
  }
  return lines
}