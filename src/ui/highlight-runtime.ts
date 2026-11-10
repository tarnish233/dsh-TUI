/**
 * The grammar-driven half of code highlighting — loaded on demand.
 *
 * Nothing here may be imported statically from the startup path: the
 * highlight.js core plus its twenty language definitions cost tens of
 * milliseconds, and a session may never show a code block. `src/ui/highlight.ts`
 * owns the lazy state machine and reaches this module through exactly one
 * dynamic import; see that module for the fallback, invalidation and
 * subscriber contract.
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
import { highlightedAnsiLines, plainHighlightLines } from './highlight-palette.ts'

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

/**
 * The loaded grammar table.
 *
 * `highlight` never throws: an unknown language and a grammar failure both
 * return the shared plain rows, which is what the eager implementation did
 * before the split.
 */
export interface HighlightRuntime {
  /** ANSI rows for one code block; the array length matches the line count. */
  highlight(code: string, language: string | undefined): string[]
}

export const highlightRuntime: HighlightRuntime = {
  highlight(code, language) {
    const name = language === undefined ? undefined : (aliases[language.toLowerCase()] ?? language.toLowerCase())
    if (name === undefined || hljs.getLanguage(name) === undefined) return plainHighlightLines(code)
    try {
      return highlightedAnsiLines(hljs.highlight(code, { language: name, ignoreIllegals: true }).value)
    } catch {
      return plainHighlightLines(code)
    }
  },
}