/**
 * Bounded code highlighting for Pi TUI Markdown code blocks.
 *
 * Adapted from agent_tui (MIT) src/ui/highlight.ts and its cc-dark palette.
 * Unlike the streaming renderer, this module refuses to highlight large or
 * very long code blocks and reuses a small LRU by code+language, so a token
 * update cannot re-run highlight.js on already-stable code.
 *
 * The core is the one CommonJS file in this module graph (`es/core.js` is a thin
 * wrapper over `lib/core.js`). Loading it through Node's CommonJS loader keeps a
 * single cached public instance when the native host has already required
 * highlight.js, instead of making the ESM loader translate that CJS file again.
 * Language definitions stay ESM: those files have no CJS counterpart in this path.
 */
import { createRequire } from 'node:module'
import type { HLJSApi } from 'highlight.js'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import shell from 'highlight.js/lib/languages/shell'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { foregroundAnsi, getTerminalColorMode, parseColor } from '#pi-tui'

const requireFromHere = createRequire(import.meta.url)
/** Public package, CommonJS build: `module.exports` is the highlight.js instance. */
const hljs = requireFromHere('highlight.js/lib/core') as HLJSApi

const languages: Record<string, unknown> = {
  bash, c, cpp, css, diff, go, ini, java, javascript, json, kotlin, markdown, python, rust, shell, sql, swift, typescript, xml, yaml,
}
for (const [name, definition] of Object.entries(languages)) hljs.registerLanguage(name, definition as never)

const aliases: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript',
  sh: 'bash', zsh: 'bash', console: 'shell', py: 'python', rs: 'rust', golang: 'go', yml: 'yaml', toml: 'ini', html: 'xml',
  htm: 'xml', svg: 'xml', md: 'markdown', kt: 'kotlin', 'c++': 'cpp', h: 'c', hpp: 'cpp', jsonc: 'json', json5: 'json', patch: 'diff',
}

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
const DEFAULT = color('#d6dde3')

const MAX_HIGHLIGHT_CHARS = 6000
const MAX_HIGHLIGHT_LINES = 200
const MAX_CACHE_ENTRIES = 64
const cache = new Map<string, string[]>()

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

function toAnsiLines(html: string): string[] {
  const lines: string[] = ['']
  const stack: string[] = []
  const current = (): string => stack.at(-1) ?? DEFAULT
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

function plain(code: string): string[] {
  return code.split('\n').map(line => (line === '' ? '' : `${DEFAULT}${line}\x1b[39m`))
}

/**
 * Highlight one code block, or return plain styled lines when it is too large.
 * The returned array length matches the input line count.
 */
export function highlightCode(code: string, lang?: string): string[] {
  if (code.length > MAX_HIGHLIGHT_CHARS || code.split('\n').length > MAX_HIGHLIGHT_LINES) return plain(code)
  const key = `${lang ?? ''}\u0000${code}`
  const hit = cache.get(key)
  if (hit !== undefined) {
    // Refresh LRU position.
    cache.delete(key)
    cache.set(key, hit)
    return hit
  }
  const name = lang === undefined ? undefined : (aliases[lang.toLowerCase()] ?? lang.toLowerCase())
  let lines = plain(code)
  if (name !== undefined && hljs.getLanguage(name) !== undefined) {
    try {
      lines = toAnsiLines(hljs.highlight(code, { language: name, ignoreIllegals: true }).value)
    } catch {
      lines = plain(code)
    }
  }
  cache.set(key, lines)
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return lines
}

/** Test/diagnostic hook; not used by the renderer. */
export function highlightCacheSize(): number {
  return cache.size
}

/** Test/diagnostic hook; not used by the renderer. */
export function clearHighlightCache(): void {
  cache.clear()
}
