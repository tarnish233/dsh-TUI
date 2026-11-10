// Must stay FIRST: forces truecolor before src modules snapshot terminal mode.
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { HLJSApi } from 'highlight.js'
import {
  clearHighlightCache,
  highlightCacheSize,
  highlightCode,
  whenHighlightRuntimeReady,
} from '../src/ui/highlight.ts'
import { plainHighlightLines } from '../src/ui/highlight-palette.ts'

const require = createRequire(import.meta.url)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FACADE = readFileSync(join(ROOT, 'src/ui/highlight.ts'), 'utf8')
const RUNTIME = readFileSync(join(ROOT, 'src/ui/highlight-runtime.ts'), 'utf8')

test('the public highlight.js package is loaded through Node\'s CommonJS loader', async () => {
  // The native host is a single process and may already hold highlight.js in
  // Node's CommonJS cache. The one CommonJS file in this graph is the core
  // (`es/core.js` is a thin wrapper over `lib/core.js`), so the runtime module
  // resolves the public package with require() instead of asking the ESM loader
  // to translate a CJS file the host may already have evaluated.
  assert.ok(
    !/\bfrom\s+'highlight\.js\/lib\/core'/.test(RUNTIME),
    'src/ui/highlight-runtime.ts must not statically import the CommonJS core through ESM',
  )
  assert.match(RUNTIME, /createRequire\(import\.meta\.url\)/)
  // The eager facade must not reach highlight.js at all: startup only pays for
  // the palette, and the grammar module arrives through one dynamic import.
  assert.ok(
    !/from\s+'highlight\.js/.test(FACADE),
    'src/ui/highlight.ts must not import a highlight.js module into the startup graph',
  )
  assert.match(FACADE, /import\('\.\/highlight-runtime\.ts'\)/)
  // Loading the grammar module through the public entry registers its table on
  // the same instance the host sees.
  await whenHighlightRuntimeReady()
  // Node's CommonJS build and its ESM wrapper are the same object, so the
  // factory keeps one shared instance whether or not the host required it first.
  const shared: HLJSApi = require('highlight.js/lib/core')
  assert.equal(typeof shared.registerLanguage, 'function')
  assert.equal(shared, require('highlight.js/lib/core'))
})

test('languages register on the shared public instance, not a private copy', async () => {
  await whenHighlightRuntimeReady()
  const shared: HLJSApi = require('highlight.js/lib/core')
  // The runtime module registered this module's language table; the native host
  // sees the identical table because it is one CommonJS instance.
  for (const name of ['bash', 'typescript', 'json', 'yaml', 'xml']) {
    assert.notEqual(shared.getLanguage(name), undefined, `${name} is registered on the shared instance`)
  }
  assert.equal(shared.getLanguage('brainfuck'), undefined)
})

test('highlighting stays ANSI-only, cache-backed and width-neutral', async () => {
  await whenHighlightRuntimeReady()
  clearHighlightCache()
  assert.equal(highlightCacheSize(), 0)
  const lines = highlightCode('const value = 1', 'ts')
  assert.equal(lines.length, 1)
  assert.match(lines[0] ?? '', /\x1b\[38;2;\d+;\d+;\d+m/)
  assert.ok(!/[<>]/.test(lines[0] ?? ''), 'no HTML leaks into the renderer')
  assert.equal(lines[0]?.endsWith('\x1b[39m'), true)
  assert.equal(highlightCacheSize(), 1)
  // A cache hit must return the identical array without re-running the grammar.
  assert.equal(highlightCode('const value = 1', 'ts'), lines)
  assert.equal(highlightCacheSize(), 1)
})

test('unknown languages and oversized blocks fall back to plain styled text', async () => {
  await whenHighlightRuntimeReady()
  clearHighlightCache()
  const plainLines = highlightCode('not a known language', 'nonsense')
  assert.deepEqual(plainLines, plainHighlightLines('not a known language'))
  assert.match(plainLines[0] ?? '', /\x1b\[38;2;\d+;\d+;\d+mnot a known language\x1b\[39m$/)
  const oversized = `${'x'.repeat(6001)}`
  assert.deepEqual(highlightCode(oversized, 'bash').length, 1)
  clearHighlightCache()
  assert.equal(highlightCacheSize(), 0)
})