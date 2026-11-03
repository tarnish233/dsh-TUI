/**
 * Display-width helpers shared by frontend components.
 *
 * Ported from agent_tui (MIT) src/ui/text.ts, itself built on Pi TUI's public
 * width functions. The CJK line-breaking rules keep closing punctuation with
 * the preceding character; emoji and ANSI are measured by Pi TUI.
 */
import { homedir } from 'node:os'
import { isAbsolute, relative } from 'node:path'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'

export { truncateToWidth, visibleWidth, wrapTextWithAnsi }

/** Wrap and prefix: the first line gets `first`, continuation lines `rest`. */
export function prefixLines(lines: readonly string[], first: string, rest: string): string[] {
  return lines.map((line, index) => `${index === 0 ? first : rest}${line}`)
}

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

const NO_LINE_START = new Set('，。、；：！？）」』】》〉’”…,.;:!?)]}%')
const NO_LINE_END = new Set('（「『【《〈‘“([{')
const TOKEN = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]|[^\s\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]+|\s+/gu

/**
 * Wrap plain (unstyled) text that mixes Chinese and English: break between CJK
 * characters or at spaces, never inside a word unless it alone is too wide.
 */
export function wrapText(text: string, width: number): string[] {
  const max = Math.max(4, width)
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    const lines: string[][] = [[]]
    let used = 0
    for (const token of paragraph.match(TOKEN) ?? []) {
      let line = lines[lines.length - 1]!
      const size = visibleWidth(token)
      if (/^\s+$/.test(token)) {
        if (line.length > 0 && used + size <= max) {
          line.push(token)
          used += size
        }
        continue
      }
      if (used + size > max && line.length > 0) {
        const carry: string[] = []
        const trim = (): void => {
          while (line.length > 0 && line[line.length - 1]!.trim() === '') line.pop()
        }
        trim()
        while (line.length > 1 && (NO_LINE_START.has((carry[0] ?? token)[0]!) || NO_LINE_END.has(line[line.length - 1]!.slice(-1)))) {
          carry.unshift(line.pop()!)
          trim()
        }
        line = carry
        lines.push(line)
        used = carry.reduce((sum, part) => sum + visibleWidth(part), 0)
      }
      if (size > max) {
        for (const piece of wrapTextWithAnsi(token, max)) {
          if (used > 0) {
            line = []
            lines.push(line)
            used = 0
          }
          line.push(piece)
          used = visibleWidth(piece)
        }
        continue
      }
      line.push(token)
      used += size
    }
    out.push(...lines.map(line => line.join('').trimEnd()))
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

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s'
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return minutes < 60 ? `${minutes}m ${rest}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
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

/** Strip ANSI/OSC sequences and control characters from tool output. */
export function sanitize(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}
