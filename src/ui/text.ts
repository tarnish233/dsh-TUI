/**
 * Display-width helpers shared by frontend components.
 *
 * Ported from agent_tui (MIT) src/ui/text.ts, rebuilt on Pi TUI's public width
 * functions only. Emoji, ANSI and CJK widths are measured by Pi TUI; earlier
 * local wrap/format helpers with no callers were deleted rather than kept as
 * untested dead surface.
 */
import { homedir } from 'node:os'
import { isAbsolute, relative } from 'node:path'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '#pi-tui'

export { truncateToWidth, visibleWidth }

/** Wrap plain or styled text into lines no wider than `width`. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      out.push('')
      continue
    }
    out.push(...wrapTextWithAnsi(paragraph, Math.max(1, width)))
  }
  return out
}

export function fit(line: string, width: number): string {
  return visibleWidth(line) <= width ? line : truncateToWidth(line, Math.max(1, width))
}

export function oneLine(value: unknown, max = 200): string {
  const text = (typeof value === 'string' ? value : JSON.stringify(value) ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

export function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`
}

/** cwd-relative when inside cwd, `~`-prefixed when inside home. */
export function displayPath(path: unknown, cwd: string): string {
  if (typeof path !== 'string' || path === '') return ''
  if (isAbsolute(path)) {
    const rel = relative(cwd, path)
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return rel
    const home = homedir()
    if (path === home) return '~'
    if (path.startsWith(`${home}/`)) return `~/${path.slice(home.length + 1)}`
  }
  return path
}

export function tildePath(path: string): string {
  const home = homedir()
  if (path === home) return '~'
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
}

/**
 * Strip ANSI/OSC sequences and control characters from untrusted display text.
 *
 * The C1 block (U+0080–U+009F) is stripped together with the C0/DEL bytes: an
 * 8-bit CSI/OSC/DCS written as a code point is still a control byte, not
 * printable text, and native provider/error bodies reach the notice plane
 * unclassified. Only the renderer may move the cursor.
 */
export function sanitize(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}
