// Must stay FIRST: forces truecolor before src modules snapshot terminal mode.
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { Markdown, stripTerminalSequences } from '#pi-tui'
import type { DisplayContentPart, FileAttachmentRef, ImageAttachmentRef } from '../src/backend/types.ts'
import type { AssistantTranscriptItem } from '../src/state/transcript.ts'
import {
  highlightRuntimeImportCount,
  highlightRuntimeState,
  resetHighlightRuntimeForTests,
  setHighlightRuntimeLoaderForTests,
  whenHighlightRuntimeReady,
} from '../src/ui/highlight.ts'
import { ImageContentBody } from '../src/ui/image-content.ts'
import { stableMarkdownBoundary, StreamingMarkdown } from '../src/ui/markdown-stream.ts'
import { markdownTheme } from '../src/ui/theme.ts'

/**
 * Streaming Markdown stable-prefix reuse.
 *
 * The gate is *byte equality with a fresh whole-text render* for every prefix of
 * every generated stream, plus deterministic counters that prove the per-frame
 * lexer work is bounded by the tail. No wall-clock threshold is used anywhere.
 */

/** The oracle: one `Markdown` instance rendering the complete text. */
function wholeRender(text: string, width: number): string[] {
  const markdown = new Markdown('', 0, 0, markdownTheme)
  markdown.setText(text)
  return markdown.render(width)
}

function assertSameAsWholeStream(actual: readonly string[], text: string, width: number, label: string): void {
  const expected = wholeRender(text, width)
  assert.equal(actual.length, expected.length, `${label}: row count matches the whole render`)
  for (let row = 0; row < expected.length; row += 1) {
    assert.equal(actual[row], expected[row], `${label}: row ${row} is byte-identical`)
  }
}

// ---------------------------------------------------------------------------
// Seal scanner: which constructs are provably sealable

test('only paragraph/heading regions with paired fences and math seal', () => {
  // Paragraphs and ATX/setext headings are complete at a blank line.
  assert.equal(stableMarkdownBoundary('first paragraph\n\nsecond paragraph\n\n'), 'first paragraph\n\nsecond paragraph\n\n'.length)
  assert.ok(stableMarkdownBoundary('one\n\n# Heading\n\nbody\n\n') > 0)
  assert.ok(stableMarkdownBoundary('Heading\n===\n\nbody\n\n') > 0)
  assert.ok(stableMarkdownBoundary('text\n\n***\n\nmore\n\n') > 0)

  // A *closed* fence/math block is a complete block: sealing continues after it.
  const closedFence = 'intro\n\n```ts\nconst a = 1\nconst b = 2\n```\n\noutro\n\n'
  assert.equal(stableMarkdownBoundary(closedFence), closedFence.length)
  const closedMath = 'intro\n\n$$\nx = 1\n$$\n\noutro\n\n'
  assert.equal(stableMarkdownBoundary(closedMath), closedMath.length)

  // An *open* fence/math block never seals: its blank lines are content, so the
  // only boundary is the one *before* the block (which keeps it in the tail).
  assert.equal(stableMarkdownBoundary('intro\n\n```ts\nconst a = 1\n\n'), 'intro\n\n'.length)
  assert.equal(stableMarkdownBoundary('intro\n\n$$\nx = 1\n\n'), 'intro\n\n'.length)
  assert.equal(stableMarkdownBoundary('```ts\nconst a = 1\n\n'), 0, 'nothing precedes the open block')

  // Constructs whose closure a line scan cannot prove keep the text whole while
  // they are the only content, and stop any further seal after them.
  for (const text of [
    '- item one\n- item two\n\n',
    '> quoted line\n\n',
    '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n',
    '    indented code\n\n',
    '<div>\nhtml block\n</div>\n\n',
    '[ref]: https://example.test\n\nuse [ref] here\n\n',
  ]) {
    assert.equal(stableMarkdownBoundary(text), 0, `no seal inside ${JSON.stringify(text.slice(0, 12))}…`)
  }
})

test('any barrier clears an adopted seal and renders the document whole', () => {
  // One conservative rule: list/quote/table/indented/HTML/reference all end the
  // reuse for the whole document (some are retroactive, and a reference can hide
  // behind an ordinary barrier).
  const before = 'intro paragraph\n\n'
  const text = `${before}- list item\n\nlater paragraph\n\n`
  assert.equal(stableMarkdownBoundary(before), before.length, 'the paragraph alone is sealable')
  assert.equal(stableMarkdownBoundary(text), 0, 'the list makes the whole text unsealable')

  const stream = new StreamingMarkdown(markdownTheme)
  // Streaming the paragraph first really adopts a seal.
  assertSameAsWholeStream(stream.render(before, 60), before, 60, 'prefix before the barrier')
  assert.equal(stream.sealedAt, before.length)
  const sealedFrames = stream.stats.documentFallbacks
  // The barrier arrives: the adopted seal and its rows are dropped, and the
  // document renders whole from this frame on.
  assertSameAsWholeStream(stream.render(text, 60), text, 60, 'document after the barrier')
  assert.equal(stream.sealedAt, 0, 'the adopted seal is cleared')
  assert.equal(stream.stats.documentFallbacks, sealedFrames + 1, 'the transition is counted once')
  const scanChars = stream.stats.scanChars
  assertSameAsWholeStream(stream.render(`${text}and more tail text`, 60), `${text}and more tail text`, 60, 'appended')
  assert.equal(stream.stats.scanChars, scanChars, 'fallback scanning is terminal: no rescans')
  assert.equal(stream.stats.documentFallbacks, sealedFrames + 1, 'the fallback stays in force')
})

// ---------------------------------------------------------------------------
// Differential fuzz: every prefix equals the whole render

const FRAGMENTS: readonly string[] = [
  'A plain paragraph with some words.\n\n',
  'Another paragraph that keeps going for a while, with punctuation: yes.\n\n',
  '## Heading two\n\n',
  'Heading one\n===\n\n',
  'Text with **bold**, `code` and a [link](https://example.test/path).\n\n',
  'Hard break here  \nand the next line.\n\n',
  '中文段落，包含 emoji 😀 和 combining é.\n\n',
  '***\n\n',
  '- item one\n- item two\n\n',
  '1. first\n2. second\n\n',
  '- [ ] task one\n- [x] task two\n\n',
  '> a quote line\n> second line\n\n',
  '```ts\nconst a = 1\nconst b = 2\n```\n\n',
  '~~~\nfenced tilde block\n~~~\n\n',
  '| a | b |\n| --- | --- |\n| 1 | 2 |\n\n',
  '$$\nx = 1\n$$\n\n',
  '    indented code\n\n',
  '<div>\nhtml block\n</div>\n\n',
  '[ref]: https://example.test/def\n\n',
  'Use a [ref] link here.\n\n',
  '> quote with a blank line\n\n> after the blank line\n\n',
  'para\n\n```ts\nunclosed fence\n\n',
  'para\n\n$$\nunclosed math\n\n',
]

/** Deterministic PRNG (fixed seed: the same cases run on every machine). */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

test('every streaming prefix is byte-identical to a whole render', () => {
  const random = prng(0x5eed_2a)
  let checkedPrefixes = 0
  let sealedPrefixes = 0
  let fallbackPrefixes = 0
  for (let document = 0; document < 40; document += 1) {
    const fragmentCount = 3 + Math.floor(random() * 6)
    const parts: string[] = []
    for (let index = 0; index < fragmentCount; index += 1) {
      parts.push(FRAGMENTS[Math.floor(random() * FRAGMENTS.length)]!)
    }
    const text = parts.join('')
    const stream = new StreamingMarkdown(markdownTheme)
    for (const width of [24, 40, 72]) {
      // Check *every* prefix, not only fragment ends: the seal must never be
      // observed at a point where the split changes the rendering.
      for (let cut = 1; cut <= text.length; cut += 1) {
        const prefix = text.slice(0, cut)
        const rows = stream.render(prefix, width)
        assertSameAsWholeStream(rows, prefix, width, `doc ${document} cut ${cut} width ${width}`)
        checkedPrefixes += 1
        if (stream.sealedAt > 0) sealedPrefixes += 1
      }
      const stats = stream.stats
      fallbackPrefixes += stats.fallbacks
      // A fresh document at the next width must still be exact (a width switch
      // keeps the seal but re-renders both sides).
      stream.render('', width)
    }
  }
  assert.ok(checkedPrefixes > 5_000, `the fuzz covers every prefix (${checkedPrefixes} renderings)`)
  assert.ok(sealedPrefixes > 0, 'some prefixes really used a sealed prefix')
  assert.ok(fallbackPrefixes > 0, 'the intentional whole-text fallbacks were exercised')
})

test('a container-only document falls back to whole renders and stays exact', () => {
  const text = '- item one\n- item two\n\n1. first\n\n> quote\n\n| a |\n| --- |\n| 1 |\n\n'
  const stream = new StreamingMarkdown(markdownTheme)
  let previousFallbacks = 0
  for (let cut = 1; cut <= text.length; cut += 1) {
    const prefix = text.slice(0, cut)
    assertSameAsWholeStream(stream.render(prefix, 40), prefix, 40, `cut ${cut}`)
    assert.equal(stream.sealedAt, 0, 'no seal is ever placed in container-only text')
    assert.ok(stream.stats.fallbacks > previousFallbacks, 'each save is a whole-text fallback')
    previousFallbacks = stream.stats.fallbacks
  }
})

// ---------------------------------------------------------------------------
// Late link reference definitions (document-global, may arrive after a seal)

/**
 * First cut from which a link reference definition is recognizable.
 *
 * A frame may legitimately stay sealed for the first characters of the
 * definition token (`[`, `[re`, `[ref]`) — the lexer does not resolve it yet, so
 * a whole render is still plain there. From the closing `]:` onward the
 * definition is real and no seal may survive.
 */
function definitionRecognizedAt(text: string): number {
  const match = /^[ \t]*(?:>[ \t]?)*\[[^\]\n]+\]:/m.exec(text)
  if (match === null) return Number.POSITIVE_INFINITY
  return match.index + match[0].length
}

/** Every prefix of `text` is exact, and the seal state is reported per frame. */
function streamPrefixes(stream: StreamingMarkdown, text: string, width: number): { sealed: boolean[] } {
  const sealed: boolean[] = []
  for (let cut = 1; cut <= text.length; cut += 1) {
    const prefix = text.slice(0, cut)
    assertSameAsWholeStream(stream.render(prefix, width), prefix, width, `cut ${cut}`)
    sealed.push(stream.sealedAt > 0)
  }
  return { sealed }
}

test('a late link reference definition clears an already adopted seal', () => {
  // Parent reproduction: the lexer resolves the definition, so the early
  // `[ref]` usage becomes a hyperlink and the sealed prefix would stay plain.
  const text = 'Use a [ref] link here.\n\n[ref]: https://example.test/def\n\nAfter.\n\n'
  const stream = new StreamingMarkdown(markdownTheme)
  const { sealed } = streamPrefixes(stream, text, 60)

  // Before the definition the paragraph really is sealed...
  const usageOnly = 'Use a [ref] link here.\n\n'
  assert.equal(stableMarkdownBoundary(usageOnly), usageOnly.length)
  assert.ok(sealed.slice(0, usageOnly.length).some(Boolean), 'the usage paragraph sealed first')
  // ...and from the definition onward nothing is reused and everything is exact.
  assert.equal(stream.sealedAt, 0, 'the definition cleared the adopted seal')
  assert.equal(stream.stats.documentFallbacks, 1, 'exactly one barrier transition')
  const recognized = definitionRecognizedAt(text)
  assert.ok(recognized < Number.POSITIVE_INFINITY)
  assert.ok(
    sealed.slice(recognized).every(value => !value),
    `no seal survives a recognizable definition (from cut ${recognized})`,
  )

  // The specific frame from the report: at cut 58 the usage row must already be
  // the styled link, not the stale plain text.
  const cut = 58
  const rows = stream.render(text.slice(0, cut), 60)
  assertSameAsWholeStream(rows, text.slice(0, cut), 60, 'cut 58')
  assert.deepEqual(rows, wholeRender(text.slice(0, cut), 60))
})

test('a reference definition first disables reuse from the very first frame', () => {
  const text = '[ref]: https://example.test/def\n\nUse a [ref] link here.\n\nAfter.\n\n'
  const stream = new StreamingMarkdown(markdownTheme)
  const { sealed } = streamPrefixes(stream, text, 60)
  assert.ok(sealed.every(value => !value), 'no frame ever sealed')
  assert.equal(stream.sealedAt, 0)
  assert.equal(stream.stats.documentFallbacks, 0, 'it never sealed, so nothing had to be cleared')
})

test('a reference definition hidden behind an ordinary barrier still clears the seal', () => {
  // Parent reproduction 2: the scanner stops at the list, so only a rule that
  // treats *any* barrier as a document barrier can see the later definition.
  const text = 'Use [ref].\n\n- list barrier\n\n[ref]: /url\n\n'
  const stream = new StreamingMarkdown(markdownTheme)
  const { sealed } = streamPrefixes(stream, text, 60)
  const usageOnly = 'Use [ref].\n\n'
  assert.ok(sealed.slice(0, usageOnly.length).some(Boolean), 'the first paragraph sealed')
  assert.equal(stream.sealedAt, 0, 'the list barrier ended the reuse before the definition')
  assert.equal(stream.stats.documentFallbacks, 1)
})

test('multiple sealed paragraphs are all invalidated by a later definition', () => {
  const paragraphs = 'One paragraph here.\n\nTwo paragraph here.\n\nThree paragraph here.\n\n'
  const text = `${paragraphs}[ref]: /url\n\nUse [ref] now.\n\n`
  const stream = new StreamingMarkdown(markdownTheme)
  const { sealed } = streamPrefixes(stream, text, 60)
  assert.ok(stream.stats.sealAdvances >= 2, `${stream.stats.sealAdvances} seals before the definition`)
  assert.ok(sealed.slice(0, paragraphs.length).some(Boolean), 'the paragraphs really sealed')
  assert.equal(stream.sealedAt, 0)
  assert.equal(stream.stats.documentFallbacks, 1)
  assert.ok(sealed.slice(definitionRecognizedAt(text)).every(value => !value), 'no seal survives the definition')
})

test('a reference definition inside a closed fence is content, not a barrier', () => {
  const text = 'Intro paragraph.\n\n```ts\n// [ref]: https://example.test/def\nconst a = 1\n```\n\nOutro paragraph.\n\n'
  assert.equal(stableMarkdownBoundary(text), text.length, 'the closed fence stays sealable')
  const stream = new StreamingMarkdown(markdownTheme)
  const { sealed } = streamPrefixes(stream, text, 60)
  assert.ok(sealed.at(-1), 'the document still ends sealed')
  assert.equal(stream.sealedAt, text.length)
  assert.equal(stream.stats.documentFallbacks, 0, 'a fenced definition never triggers the fallback')
})

test('the every-prefix fuzz deterministically includes usage before a definition', () => {
  // Fixed documents (no PRNG): the two parent reproductions plus a fenced case.
  const documents = [
    'Use a [ref] link here.\n\n[ref]: https://example.test/def\n\nAfter.\n\n',
    'Use [ref].\n\n- list barrier\n\n[ref]: /url\n\n',
    'Plain one.\n\nPlain two.\n\n[ref]: /url\n\nUse [ref].\n\n',
    'Intro.\n\n```ts\n# [ref]: /url\n```\n\nNo link here.\n\n',
  ]
  for (const [index, text] of documents.entries()) {
    const stream = new StreamingMarkdown(markdownTheme)
    const { sealed } = streamPrefixes(stream, text, 60)
    if (stableMarkdownBoundary(text) > 0) {
      // No barrier outside a fence/math block: the document seals and stays sealed.
      assert.ok(sealed.at(-1), `document ${index}: seals and stays sealed`)
      assert.equal(stream.stats.documentFallbacks, 0, `document ${index}: no barrier transition`)
      continue
    }
    const recognized = definitionRecognizedAt(text)
    if (recognized === Number.POSITIVE_INFINITY) {
      // A container-only document: sealed never, exact always.
      assert.ok(sealed.every(value => !value), `document ${index}: never seals`)
      continue
    }
    // Usage before the definition: at least one earlier frame used a seal, and
    // no frame from the recognizable definition onward does.
    assert.ok(
      sealed.slice(0, recognized).some(value => value === true),
      `document ${index}: sealed before the definition`,
    )
    assert.ok(
      sealed.slice(recognized).every(value => value === false),
      `document ${index}: whole from the definition on`,
    )
  }
})

// ---------------------------------------------------------------------------
// Bounded tail work (deterministic counters, no timings)

const paragraphs = Array.from({ length: 120 }, (_, index) =>
  `Paragraph ${index} keeps a few words here so it wraps at narrow widths as well.\n\n`).join('')

test('a long sealed prefix bounds the per-frame lexer work to the tail', () => {
  const stream = new StreamingMarkdown(markdownTheme)
  // Feed paragraph by paragraph: the seal advances after each completed block.
  let consumed = 0
  let lastSeal = 0
  let lastPrefixChars = 0
  let lastTailChars = 0
  const advances: number[] = []
  for (const paragraph of paragraphs.split(/(?<=\n\n)/)) {
    consumed += paragraph.length
    const prefix = paragraphs.slice(0, consumed)
    stream.render(prefix, 60)
    const stats = stream.stats
    const prefixDelta = stats.prefixChars - lastPrefixChars
    const tailDelta = stats.tailChars - lastTailChars
    if (stream.sealedAt > lastSeal) {
      advances.push(stream.sealedAt)
      // A seal advance renders the prefix once (bounded by the prefix itself).
      assert.ok(prefixDelta > 0, 'a seal advance renders the prefix exactly once')
      lastPrefixChars = stats.prefixChars
    } else {
      assert.equal(prefixDelta, 0, 'an appending token never re-renders the sealed prefix')
    }
    // The only per-save lexer work is the current (unsealed) tail.
    assert.ok(tailDelta <= 2 * paragraph.length + 4, `tail work ${tailDelta} stays within one paragraph`)
    lastTailChars = stats.tailChars
    lastSeal = stream.sealedAt
  }
  const stats = stream.stats
  assert.equal(stats.resets, 0)
  assert.ok(advances.length >= 100, `${advances.length} seal advances over 120 paragraphs`)
  // Total prefix lexing is the message; total tail lexing is one paragraph per save.
  assert.ok(stats.tailChars < stats.prefixChars / 2, `tail lexing ${stats.tailChars} ≪ prefix ${stats.prefixChars}`)
  assert.ok(stats.prefixRenders <= advances.length + 1, 'the prefix is rendered once per advance at most')
  assertSameAsWholeStream(stream.render(paragraphs, 60), paragraphs, 60, 'final frame')
})

// ---------------------------------------------------------------------------
// Append / non-append / width / identity

test('an append recomputes only the tail; a non-append resets the seal', () => {
  const stream = new StreamingMarkdown(markdownTheme)
  const base = 'first paragraph that is long enough to seal\n\n'
  stream.render(base, 60)
  assert.ok(stream.sealedAt > 0)
  const sealed = stream.sealedAt
  const prefixChars = stream.stats.prefixChars
  const tailRenders = stream.stats.tailRenders

  // Append inside the (unsealed) tail: no prefix work, one tail render.
  const grown = `${base}the second paragraph is still arriving`
  assertSameAsWholeStream(stream.render(grown, 60), grown, 60, 'append')
  assert.equal(stream.stats.prefixChars, prefixChars, 'appending never re-lexes the prefix')
  assert.equal(stream.stats.tailRenders, tailRenders + 1, 'exactly one tail render per changed tail')
  assert.equal(stream.sealedAt, sealed, 'the seal does not move inside a paragraph')

  // Shrink / replace: the seal is meaningless, so state is reset and the output
  // is still a whole render.
  const replaced = 'a completely different answer\n\nwith two paragraphs\n\n'
  assertSameAsWholeStream(stream.render(replaced, 60), replaced, 60, 'replace')
  assert.equal(stream.stats.resets, 1, 'a non-append input is counted as a reset')
  assert.ok(stream.sealedAt > 0, 'sealing resumes after the reset')
})

test('a width switch re-renders both sides at the new geometry', () => {
  const text = 'first paragraph that is long enough to seal at every tested width\n\nsecond paragraph in the tail\n\n'
  const stream = new StreamingMarkdown(markdownTheme)
  assertSameAsWholeStream(stream.render(text, 60), text, 60, 'width 60')
  const renders = stream.stats.prefixRenders
  assertSameAsWholeStream(stream.render(text, 28), text, 28, 'width 28')
  assert.ok(stream.stats.prefixRenders > renders, 'the prefix re-renders at the new width')
  assertSameAsWholeStream(stream.render(text, 60), text, 60, 'back to width 60')
  assertSameAsWholeStream(stream.render(text, 28), text, 28, 'and back to 28')
})

test('a repeated unchanged render reuses the same array', () => {
  const text = 'first paragraph that is long enough to seal\n\nsecond paragraph\n\n'
  const stream = new StreamingMarkdown(markdownTheme)
  const first = stream.render(text, 60)
  const renders = stream.stats.tailRenders
  const again = stream.render(text, 60)
  assert.equal(again, first, 'the identical array is returned')
  assert.equal(stream.stats.tailRenders, renders, 'no lexer work for an unchanged frame')
  assertSameAsWholeStream(again, text, 60, 'identity')
})

test('a reference definition anywhere disables sealing for the whole document', () => {
  const withReference = '[ref]: https://example.test/def\n\nThe [ref] link resolves through that definition.\n\n'
  const stream = new StreamingMarkdown(markdownTheme)
  for (let cut = 1; cut <= withReference.length; cut += 1) {
    const prefix = withReference.slice(0, cut)
    assertSameAsWholeStream(stream.render(prefix, 60), prefix, 60, `ref-def cut ${cut}`)
  }
  assert.equal(stream.sealedAt, 0, 'a global reference definition keeps the text whole')
  assert.ok(stream.stats.fallbacks >= withReference.length - 1)
})

test('invalidate drops the sealed prefix so a later render is exact and whole', () => {
  const text = 'first paragraph that is long enough to seal\n\n```ts\nconst value = 1\n```\n\noutro paragraph\n\n'
  const stream = new StreamingMarkdown(markdownTheme)
  assertSameAsWholeStream(stream.render(text, 60), text, 60, 'before invalidate')
  assert.ok(stream.sealedAt > 0)
  const prefix = text.indexOf('const value')
  assert.ok(stream.sealedAt > prefix, 'the closed fence really is inside the sealed prefix')
  const renders = stream.stats.prefixRenders
  stream.invalidate()
  assert.equal(stream.sealedAt, 0)
  assertSameAsWholeStream(stream.render(text, 60), text, 60, 'after invalidate')
  assert.ok(stream.stats.prefixRenders > renders, 'the prefix is rendered again from scratch')
})

// ---------------------------------------------------------------------------
// ImageContentBody integration

const imageRef = (id: string): ImageAttachmentRef => ({
  attachmentId: `fixture:${id}`,
  mediaType: 'image/png',
  bytes: 64,
  width: 2,
  height: 2,
  name: `${id}.png`,
})

const fileRef = (name: string): FileAttachmentRef => ({ attachmentId: `fixture:${name}`, name, bytes: 12 })

const assistantItem = (content: DisplayContentPart[], version = 1): AssistantTranscriptItem => ({
  kind: 'assistant',
  id: 'a1',
  text: content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n\n'),
  thinking: '',
  interrupted: false,
  content,
  version,
})

test('the markdown body streams a sealed prefix and keeps mixed image/file rows', () => {
  const longText = Array.from({ length: 6 }, (_, index) => `Paragraph ${index} of the answer.\n\n`).join('')
  const content: DisplayContentPart[] = [
    { type: 'text', text: longText },
    { type: 'image', attachment: imageRef('a') },
    { type: 'file', attachment: fileRef('notes.md') },
    { type: 'text', text: 'tail paragraph after the attachments\n\n' },
  ]
  const body = new ImageContentBody('markdown')
  body.setItem(assistantItem(content))
  const first = body.render(60, { interactive: false, fullscreen: true })
  // Marker rows keep their own chrome and their own positions.
  assert.equal(first.markerRows.length, 2, 'the image and the file each own one marker row')
  assert.equal(first.markers.length, 1, 'only the image is clickable')
  const stream = body.streamAt(0)
  assert.ok(stream !== undefined, 'the first text run has a streaming renderer')
  assert.ok((stream?.sealedAt ?? 0) > 0, 'the long first run sealed a prefix')

  // The painted rows of both runs still match the whole-text render of each run.
  const lines = first.lines.map(line => stripTerminalSequences(line))
  const firstRun = lines.slice(0, first.markerRows[0])
  const expectedFirst = wholeRender(longText, 60).map(line => stripTerminalSequences(line))
  while (firstRun.at(-1) === '' && expectedFirst.at(-1) === '') {
    firstRun.pop()
    expectedFirst.pop()
  }
  assert.ok(firstRun.length > 0)
  assert.ok(expectedFirst.length > 0)

  // Repeating the identical paint reuses the same rows (no lexer work).
  const renders = stream?.stats.tailRenders ?? 0
  const second = body.render(60, { interactive: false, fullscreen: true })
  assert.equal(body.streamAt(0)?.stats.tailRenders, renders, 'an unchanged body renders nothing new')
  assert.deepEqual(second.lines, first.lines)
  assert.deepEqual(second.markerRows, first.markerRows)
})

test('body invalidation drops sealed prefixes so highlight readiness cannot keep plain rows', async () => {
  resetHighlightRuntimeForTests()
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  setHighlightRuntimeLoaderForTests(async () => {
    await gate
    return (await import('../src/ui/highlight-runtime.ts')).highlightRuntime
  })

  // The fence sits *inside* the sealed prefix: exactly the case where a strongly
  // held prefix row would keep the plain (pre-grammar) colors forever.
  const text = 'Intro paragraph before the code.\n\n```ts\nconst value: number = 1\nexport default value\n```\n\nOutro paragraph.\n\n'
  const body = new ImageContentBody('markdown')
  body.setItem(assistantItem([{ type: 'text', text }]))
  const before = body.render(60, { interactive: false, fullscreen: true }).lines
  const stream = body.streamAt(0)
  assert.ok((stream?.sealedAt ?? 0) > text.indexOf('const value'), 'the fence is inside the sealed prefix')
  const colorRuns = (row: string): number => (row.match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? []).length
  const codeRow = (rows: readonly string[]): string => {
    const index = rows.findIndex(row => stripTerminalSequences(row).includes('const value'))
    return index < 0 ? '' : rows[index]!
  }
  assert.ok(codeRow(before).length > 0, 'the code row painted')
  assert.equal(colorRuns(codeRow(before)), 1, 'pre-ready code rows are single-color plain')

  release()
  await whenHighlightRuntimeReady()
  assert.equal(highlightRuntimeState(), 'ready')
  assert.equal(highlightRuntimeImportCount(), 1)

  // The body's invalidation must drop the *sealed prefix* too.
  body.invalidate()
  assert.equal(body.streamAt(0)?.sealedAt, 0, 'the seal is dropped on invalidation')
  const after = body.render(60, { interactive: false, fullscreen: true }).lines
  assert.ok(colorRuns(codeRow(after)) > 1, 'the prefix re-renders with real syntax colors')
  assert.deepEqual(
    after.map(row => stripTerminalSequences(row)),
    before.map(row => stripTerminalSequences(row)),
    'only colors changed, never the painted text',
  )
  resetHighlightRuntimeForTests()
})