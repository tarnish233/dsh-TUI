// Differential and budget tests for the thinking preview/full-wrap cache.
//
// Every expectation is derived from the shared exact reference
// `wrap(sanitize(text).replace(/\s+$/, ''), width)` - the formula the collapsed
// summary and the expanded body were always rendered from. Nothing here asserts
// an approximation or a wall-clock number; wrap work is proven with instrumented
// call/character counters injected through the cache's wrap/sanitize seams.
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { ThinkingPreviewCache, type ThinkingPreviewCacheStats } from '../src/ui/thinking-preview-cache.ts'
import { sanitize, wrap } from '../src/ui/text.ts'

interface Reference {
  empty: boolean
  total: number
  lines: string[]
  hidden: number
}

/** The historical collapsed measurement, verbatim. */
function referencePreview(raw: string, width: number, previewLines: number): Reference {
  const text = sanitize(raw)
  if (text.trim() === '') return { empty: true, total: 0, lines: [], hidden: 0 }
  const wrapped = wrap(text.replace(/\s+$/, ''), width)
  const preview = Math.max(0, Math.floor(previewLines))
  const shown = Math.min(wrapped.length, preview)
  return { empty: false, total: wrapped.length, lines: wrapped.slice(wrapped.length - shown), hidden: wrapped.length - shown }
}

/** The historical expanded measurement, verbatim. */
function referenceExpanded(raw: string, width: number): Reference {
  const text = sanitize(raw)
  if (text.trim() === '') return { empty: true, total: 0, lines: [], hidden: 0 }
  const wrapped = wrap(text.replace(/\s+$/, ''), width)
  return { empty: false, total: wrapped.length, lines: wrapped, hidden: 0 }
}

interface Counters {
  wraps: number
  wrappedChars: number
  sanitizes: number
  sanitizedChars: number
}

function countingCache(options: { tailLines?: number; maxStates?: number; maxChars?: number } = {}): { cache: ThinkingPreviewCache; counters: Counters } {
  const counters: Counters = { wraps: 0, wrappedChars: 0, sanitizes: 0, sanitizedChars: 0 }
  const cache = new ThinkingPreviewCache({
    ...options,
    wrap: (text, width) => {
      counters.wraps += 1
      counters.wrappedChars += text.length
      return wrap(text, width)
    },
    sanitize: text => {
      counters.sanitizes += 1
      counters.sanitizedChars += text.length
      return sanitize(text)
    },
  })
  return { cache, counters }
}

function plain(measured: { empty: boolean; total: number; lines: readonly string[]; hidden: number }): Reference {
  return { empty: measured.empty, total: measured.total, lines: [...measured.lines], hidden: measured.hidden }
}

function assertPreview(cache: ThinkingPreviewCache, index: number, raw: string, width: number, previewLines: number, label: string): void {
  assert.deepEqual(plain(cache.preview(index, raw, width, previewLines)), referencePreview(raw, width, previewLines), `${label} preview=${previewLines} width=${width}`)
}

function assertExpanded(cache: ThinkingPreviewCache, index: number, raw: string, width: number, label: string): void {
  assert.deepEqual(plain(cache.expanded(index, raw, width)), referenceExpanded(raw, width), `${label} expanded width=${width}`)
}

/** Deterministic xorshift so failures are reproducible without a seed run. */
function rng(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x1_0000_0000
  }
}

// ---------------------------------------------------------------------------
// Differential equality against the exact reference

test('appended chunks of every hazard class match the exact wrap/count/tail', () => {
  const chunks = [
    'alpha ', 'beta ', 'gamma delta ', 'x'.repeat(37), 'supercalifragilisticexpialidocious',
    '漢字かなカナ', '😀👍🏽', '👨‍👩‍👧‍👦', '🧑🏽‍🚀', 'e\u0301', 'n\u0303', 'a\u200db',
    '\n', '\n\n', '\r\n', '\r', '\t', '   ', ' ', '. ', ', ',
    '\x1b[31m', '\x1b[0m', '\x1b]0;window title\x07', '\x1b[?25h', '\x1b(', 'm',
    '\x1b[', '31m', '\x1b]0;t', '\nmore text', '\x07', '\x1b', '\\',
    '\x00', '\x7f', '\x9b', '\u00a0', '\u3000', '\u2028',
  ]
  const widths = [4, 7, 13, 40, 80]
  const next = rng(0x5eed)
  for (let run = 0; run < 24; run += 1) {
    const cache = new ThinkingPreviewCache()
    let text = ''
    let width = widths[Math.floor(next() * widths.length)]!
    const steps = 1 + Math.floor(next() * 10)
    for (let step = 0; step < steps; step += 1) {
      const size = 1 + Math.floor(next() * 4)
      for (let part = 0; part < size; part += 1) text += chunks[Math.floor(next() * chunks.length)]!
      const preview = Math.floor(next() * 11)
      assertPreview(cache, 0, text, width, preview, `run ${run} step ${step}`)
      assertExpanded(cache, 0, text, width, `run ${run} step ${step}`)
      // Frozen snapshots are read-only inputs as far as the cache is concerned.
      const frozen = Object.freeze(text)
      assertPreview(cache, 0, frozen, width, preview, `run ${run} step ${step} frozen`)
      if (next() < 0.2) width = widths[Math.floor(next() * widths.length)]!
    }
  }
})

test('rewrites, shortening, removals and width changes invalidate safely', () => {
  const cache = new ThinkingPreviewCache()
  const full = 'first line of reasoning\nsecond line is longer than the width\nthird'
  const cases: Array<{ text: string; width: number }> = [
    { text: full, width: 40 },
    { text: full.slice(0, full.length - 3), width: 40 },
    { text: full.replace('second', 'SECOND'), width: 40 },
    { text: '', width: 40 },
    { text: '\x1b[31m', width: 40 },
    { text: '   \n\n', width: 40 },
    { text: full, width: 12 },
    { text: full, width: 40 },
    { text: `${full}\nappended after a shrink`, width: 40 },
    { text: full, width: 4 },
    { text: `${full}\n`, width: 4 },
  ]
  for (const entry of cases) {
    for (const preview of [0, 1, 3, 10]) assertPreview(cache, 0, entry.text, entry.width, preview, JSON.stringify(entry.text.slice(0, 24)))
    assertExpanded(cache, 0, entry.text, entry.width, JSON.stringify(entry.text.slice(0, 24)))
  }
  // A run that disappears is pruned, and the next render of that index is cold.
  assertPreview(cache, 1, 'another run', 40, 3, 'index 1')
  cache.prune(1)
  assert.equal(cache.stateCount, 1)
  cache.prune(0)
  assert.equal(cache.stateCount, 0)
})

test('CR/LF, tabs, trailing whitespace and trailing newlines stay exact frame to frame', () => {
  const cache = new ThinkingPreviewCache()
  const steps = ['alpha', '\r', '\n', 'beta', '\t', '   ', 'gamma', '\n', '\n', '  ', 'delta\r\nepsilon', '\r\n', 'zeta']
  let text = ''
  for (const step of steps) {
    text += step
    for (const preview of [0, 1, 3, 10]) assertPreview(cache, 0, text, 11, preview, JSON.stringify(text))
    assertExpanded(cache, 0, text, 11, JSON.stringify(text))
  }
})

test('long whitespace-free ASCII and long words keep matching the reference', () => {
  const cache = new ThinkingPreviewCache()
  const token = 'A'.repeat(300)
  const paragraph = `${token} ${'word '.repeat(60).trim()} ${'B'.repeat(120)} tail`
  let text = ''
  for (let index = 0; index < paragraph.length; index += 7) {
    text = paragraph.slice(0, index)
    assertPreview(cache, 0, text, 17, 3, `prefix ${index}`)
    assertExpanded(cache, 0, text, 17, `prefix ${index}`)
  }
})

test('CJK, emoji, combining marks and ZWJ splits at every offset match the reference', () => {
  const cache = new ThinkingPreviewCache()
  const text = '思考 e\u0301 😀👨‍👩‍👧‍👦 🧑🏽‍🚀汉字かなカナ'
  for (let cut = 0; cut <= text.length; cut += 1) {
    const partial = text.slice(0, cut)
    assertPreview(cache, 0, partial, 9, 3, `cut ${cut}`)
    assertExpanded(cache, 0, partial, 9, `cut ${cut}`)
  }
})

test('split control, OSC and ANSI sequences fall back to an exact rebuild', () => {
  const cache = new ThinkingPreviewCache()
  const sequences = ['\x1b[31mred\x1b[0m text', '\x1b]0;title with\nnewline\x07after', '\x1b[?25h visible']
  for (const sequence of sequences) {
    let text = 'lead '
    assertPreview(cache, 0, text, 20, 2, 'lead')
    for (const character of sequence) {
      text += character
      assertPreview(cache, 0, text, 20, 2, `prefix ${JSON.stringify(text)}`)
      assertExpanded(cache, 0, text, 20, `prefix ${JSON.stringify(text)}`)
    }
    text += ' tail'
    assertPreview(cache, 0, text, 20, 2, 'tail')
  }
})

// ---------------------------------------------------------------------------
// Repaint cost

test('an unchanged source and width costs no sanitize, no segmentation and no wrap', () => {
  const { cache, counters } = countingCache()
  const text = Array.from({ length: 40 }, (_, line) => `reasoning line ${line} with enough words to wrap`).join('\n')
  assertPreview(cache, 0, text, 60, 3, 'cold')
  const cold: Counters = { ...counters }
  const stats: ThinkingPreviewCacheStats = cache.stats()
  assert.equal(stats.rebuilds, 1)
  for (let frame = 0; frame < 25; frame += 1) {
    assertPreview(cache, 0, text, 60, frame % 11, `repaint ${frame}`)
  }
  assert.deepEqual(counters, cold, 'a timer/hover repaint costs nothing')
  assert.equal(cache.stats().hits > 0, true)
  // The expanded body is built at most once for the same source/width.
  assertExpanded(cache, 0, text, 60, 'expand once')
  const expanded: Counters = { ...counters }
  for (let frame = 0; frame < 10; frame += 1) assertExpanded(cache, 0, text, 60, `expanded repaint ${frame}`)
  assert.deepEqual(counters, expanded, 'an open body is served from cache while nothing changes')
  assert.equal(cache.stats().expandedHits > 0, true)
})

test('a stable 1400 line prefix is never re-wrapped for appends', () => {
  const { cache, counters } = countingCache()
  const prefix = Array.from({ length: 1_400 }, (_, line) => `line ${line}: stable reasoning text that already wrapped once`).join('\n')
  const width = 80
  assertPreview(cache, 0, prefix, width, 3, 'cold prefix')
  const cold: Counters = { ...counters }
  const frames = 200
  let text = prefix
  let naiveChars = 0
  for (let frame = 0; frame < frames; frame += 1) {
    text += ` token${frame} more`
    naiveChars += text.length
    const measured = cache.preview(0, text, width, 3)
    if (frame % 20 === 0) assert.deepEqual(plain(measured), referencePreview(text, width, 3), `frame ${frame}`)
    else assert.equal(measured.total, referencePreview(text, width, 3).total, `frame ${frame} count`)
  }
  const appendWraps = counters.wraps - cold.wraps
  const appendChars = counters.wrappedChars - cold.wrappedChars
  assert.equal(appendWraps, frames, 'one restart wrap per append, nothing else')
  // Each restart wrap is one visual line plus the appended token, not the document.
  assert.ok(appendChars < 30_000, `preview appends wrapped ${appendChars} chars`)
  assert.ok(naiveChars > 10_000_000, `the naive path would wrap ${naiveChars} chars`)
  assert.ok(appendChars * 100 < naiveChars, 'reused work is orders of magnitude below a per-frame full wrap')

  // Opening the body is lazy: the first open pays exactly one pass over the run
  // (the documented one-time cold rewrap), then appends reuse that array.
  const beforeExpand = { ...counters }
  assertExpanded(cache, 0, text, width, 'expanded after appends')
  const firstOpenChars = counters.wrappedChars - beforeExpand.wrappedChars
  assert.ok(firstOpenChars >= text.length * 0.9, `the first open wraps the run once (${firstOpenChars} of ${text.length})`)
  assert.ok(firstOpenChars <= text.length * 1.1, `the first open wraps nothing twice (${firstOpenChars} of ${text.length})`)
  const afterExpand = { ...counters }
  for (let frame = 0; frame < 50; frame += 1) {
    text += ' more'
    assertExpanded(cache, 0, text, width, `expanded append ${frame}`)
  }
  const expandedAppendChars = counters.wrappedChars - afterExpand.wrappedChars
  assert.ok(expandedAppendChars < 8_000, `expanded appends stayed incremental (${expandedAppendChars} chars)`)
  assert.ok(expandedAppendChars * 100 < naiveChars, `expanded appends reuse the stable prefix (${expandedAppendChars} chars)`)
})

test('the expanded body is lazy: a collapsed frame never wraps the full run', () => {
  const { cache, counters } = countingCache()
  const text = Array.from({ length: 300 }, (_, line) => `line ${line} of a long thought body`).join('\n')
  assertPreview(cache, 0, text, 70, 3, 'collapsed')
  const collapsedChars = counters.wrappedChars
  assert.ok(collapsedChars < text.length * 1.1, 'the cold collapsed pass wraps the document once')
  // Only the collapsed slice is needed, so preview requests stay cheap.
  for (const preview of [0, 1, 3, 5, 10]) assertPreview(cache, 0, text, 70, preview, `preview ${preview}`)
  assert.equal(counters.wrappedChars, collapsedChars, 'preview policy changes never re-wrap')
})

// ---------------------------------------------------------------------------
// Bounds

test('state count and retained characters stay inside their budgets', () => {
  const { cache } = countingCache({ maxStates: 4, maxChars: 2_048 })
  for (let index = 0; index < 40; index += 1) {
    const text = Array.from({ length: 60 }, (_, line) => `run ${index} line ${line} of a thought`).join('\n')
    assertPreview(cache, index, text, 40, 3, `run ${index}`)
    cache.expanded(index, text, 40)
    assert.ok(cache.stateCount <= 4, `state count ${cache.stateCount}`)
    assert.ok(cache.retainedChars <= 2_048, `retained ${cache.retainedChars} chars`)
  }
  // A single run far larger than the budget keeps only accounting: memory stays
  // bounded and the next frame simply takes the cold exact path again.
  const huge = 'x'.repeat(64 * 1_024)
  assertPreview(cache, 99, huge, 60, 3, 'huge')
  assert.ok(cache.retainedChars <= 2_048, `retained ${cache.retainedChars} chars after a huge run`)
  assertPreview(cache, 99, `${huge}y`, 60, 3, 'huge append')
})

test('per-instance state does not leak across caches and clearing is explicit', () => {
  const first = new ThinkingPreviewCache()
  const second = new ThinkingPreviewCache()
  assertPreview(first, 0, 'one thought', 40, 3, 'first')
  assertPreview(second, 0, 'another thought', 40, 3, 'second')
  assert.equal(first.stateCount, 1)
  assert.equal(second.stateCount, 1)
  first.clear()
  assert.equal(first.stateCount, 0)
  assert.equal(first.retainedChars, 0)
  assert.equal(second.stateCount, 1, 'clearing one block never touches another')
})
test('a preview larger than the retained tail window still matches the reference', () => {
  const cache = new ThinkingPreviewCache({ tailLines: 1 })
  const raw = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda'
  for (const preview of [0, 1, 2, 5, 10]) {
    for (const width of [7, 13, 40]) assertPreview(cache, 0, raw, width, preview, `tailLines=1 preview=${preview}`)
  }
  // Frozen and unchanged, the wider request is still a hit.
  const { cache: counted, counters } = countingCache({ tailLines: 1 })
  assertPreview(counted, 0, raw, 13, 10, 'wide preview cold')
  const cold = { ...counters }
  assertPreview(counted, 0, raw, 13, 10, 'wide preview warm')
  assert.deepEqual(counters, cold)
})

test('a state dropped for budget never answers as if it still held its source', () => {
  // Regression: the dropped state used to be marked with `raw: ''`, which made
  // the next lookup of a genuinely empty source report the old document's count
  // and tail.
  const cache = new ThinkingPreviewCache({ maxChars: 1_024 })
  const huge = 'x'.repeat(5_000)
  const big = cache.preview(0, huge, 20, 3)
  assert.deepEqual(plain(big), referencePreview(huge, 20, 3))
  assert.equal(big.total, 250)
  // Empty source must be measured from scratch, not served from the old state.
  assertPreview(cache, 0, '', 20, 3, 'empty after drop')
  assert.deepEqual(plain(cache.preview(0, '', 20, 3)), { empty: true, total: 0, lines: [], hidden: 0 })
  // Whitespace-only source is empty too, and stays exact.
  for (const whitespace of ['   ', '\n\n', '\t', '\u3000', '\x1b[31m']) {
    assertPreview(cache, 0, whitespace, 20, 3, `whitespace after drop ${JSON.stringify(whitespace)}`)
    assertExpanded(cache, 0, whitespace, 20, `whitespace after drop ${JSON.stringify(whitespace)}`)
  }
  // A rewrite of the same index also rebuilds (append-only was impossible).
  assertPreview(cache, 0, 'short rewrite', 20, 3, 'rewrite after drop')
  assertExpanded(cache, 0, 'short rewrite', 20, 'rewrite after drop')
  // Oversized again, then expanded: still no stale lines.
  assertPreview(cache, 0, huge, 20, 10, 'huge again')
  assert.deepEqual(plain(cache.expanded(0, '', 20)), { empty: true, total: 0, lines: [], hidden: 0 })
  assert.ok(cache.retainedChars <= 1_024)
})

test('the default budget and non-finite options stay bounded and exact', () => {
  // Unknown/non-finite values fall back to the finite defaults instead of
  // turning every bound into NaN.
  const cache = new ThinkingPreviewCache({ maxChars: Number.NaN, maxStates: Number.POSITIVE_INFINITY, tailLines: Number.NaN })
  const text = Array.from({ length: 200 }, (_, line) => `run line ${line} of a thought body`).join('\n')
  for (let index = 0; index < 60; index += 1) {
    assertPreview(cache, index, text, 40, 10, `nan options run ${index}`)
    cache.expanded(index, text, 40)
    assert.ok(Number.isFinite(cache.stateCount) && cache.stateCount <= 16, `state count ${cache.stateCount}`)
    assert.ok(Number.isFinite(cache.retainedChars) && cache.retainedChars <= 256 * 1_024, `retained ${cache.retainedChars}`)
  }
  // The default budget still drops a single oversized run rather than retaining it,
  // and the follow-up empty lookup is measured, not inherited.
  const huge = 'y'.repeat(600 * 1_024)
  assertPreview(cache, 0, huge, 60, 3, 'huge over default budget')
  assert.ok(cache.retainedChars <= 256 * 1_024, `retained ${cache.retainedChars} after a 600kB run`)
  assert.deepEqual(plain(cache.preview(0, '', 60, 3)), { empty: true, total: 0, lines: [], hidden: 0 })
  assertPreview(cache, 1, 'after the huge run', 60, 3, 'neighbour run after drop')
})

test('an unsettled boundary still serves identical-source hits', () => {
  const { cache, counters } = countingCache()
  const partial = 'think \x1b[3'
  assertPreview(cache, 0, partial, 20, 2, 'partial escape cold')
  const cold = { ...counters }
  assertPreview(cache, 0, partial, 20, 2, 'partial escape warm')
  assert.deepEqual(counters, cold, 'the pending escape is not re-sanitized for a repaint')
  assertExpanded(cache, 0, partial, 20, 'partial escape first open')
  const opened = { ...counters }
  assertExpanded(cache, 0, partial, 20, 'partial escape open warm')
  assert.deepEqual(counters, opened, 'an open body with a pending escape is served from cache')
  // The append after it must still rebuild (the visible `[3` disappears).
  assertPreview(cache, 0, `${partial}1m`, 20, 2, 'completed escape')
  assertPreview(cache, 0, `${partial}1m`, 20, 2, 'completed escape warm')
})

test('an earlier unfinished CSI exposed by a later OSC removal rebuilds exactly', () => {
  // sanitize() is sequential: removing the OSC makes the earlier CSI complete,
  // so appending must not be treated as "sanitize(prefix) + sanitize(delta)".
  const raw = '\u200d文\x1b[\x1b]title     á\x07abcdefghijklm中文'
  const width = 20
  let prefix = ''
  for (const character of raw) {
    prefix += character
    assertPreview(cacheForRun(prefix.length), 0, prefix, width, 3, `char ${prefix.length}`)
    assertExpanded(cacheForRun(prefix.length), 0, prefix, width, `char ${prefix.length}`)
  }

  // Coarser split positions, including splits inside both sequences.
  for (const cut of [2, 3, 4, 5, 6, 9, 14, 20, 22, 26, raw.length - 1]) {
    const cache = new ThinkingPreviewCache()
    assertPreview(cache, 0, raw.slice(0, cut), width, 3, `prefix ${cut}`)
    assertPreview(cache, 0, raw, width, 3, `complete ${cut}`)
    assertExpanded(cache, 0, raw, width, `complete ${cut} expanded`)
  }
  // The whole text in one step is the old exact answer.
  const cache = new ThinkingPreviewCache()
  assert.deepEqual(plain(cache.preview(0, raw, width, 10)), {
    empty: false,
    total: referencePreview(raw, width, 10).total,
    lines: ['\u200d文bcdefghijklm中文'],
    hidden: referencePreview(raw, width, 10).hidden,
  })
})

test('a complete ANSI sequence disables the append fast path but stays exact', () => {
  const { cache, counters } = countingCache()
  const width = 24
  // First frame already carries a complete CSI: subsequent appends rebuild.
  let text = 'a\x1b[31mred\x1b[0m'
  assertPreview(cache, 0, text, width, 2, 'cold with ansi')
  const coldRebuilds = cache.stats().rebuilds
  for (let frame = 0; frame < 6; frame += 1) {
    text += ` plain${frame}`
    assertPreview(cache, 0, text, width, 2, `append ${frame}`)
    const before = { ...counters }
    assertPreview(cache, 0, text, width, 2, `repaint ${frame}`)
    assert.deepEqual(counters, before, `repaint ${frame} is still a hit`)
    assert.ok(cache.stats().rebuilds > coldRebuilds + frame, 'appends rebuild while an escape is retained')
  }
  assertExpanded(cache, 0, text, width, 'expanded with ansi')
  // Introducing the first escape incrementally is allowed, then it falls back.
  const plainCache = new ThinkingPreviewCache()
  assertPreview(plainCache, 0, 'plain start', width, 2, 'plain cold')
  assertPreview(plainCache, 0, 'plain start\x1b[0m', width, 2, 'escape introduced')
  assertPreview(plainCache, 0, 'plain start\x1b[0m more', width, 2, 'after the escape')
  assertPreview(plainCache, 0, 'plain start\x1b[0m more text', width, 2, 'later append')
})

/** A fresh cache per prefix, so each step is the cold exact path it must match. */
function cacheForRun(_labelLength: number): ThinkingPreviewCache {
  return new ThinkingPreviewCache()
}
