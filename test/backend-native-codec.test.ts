/**
 * Pure transcript-codec factory contract: it delegates entirely to the public
 * DSH helpers it is given and fails loudly when they are incomplete.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { displayContentParts } from '../src/attachments.ts'
import { makeTranscriptCodec } from '../src/backend/native-codec.ts'
import type { StreamPresentation, TranscriptCodec } from '../src/backend/types.ts'

class Assembler {
  readonly chunks: Array<Record<string, unknown>> = []
  push(chunk: Record<string, unknown>): void {
    this.chunks.push(chunk)
  }
  blocks(): unknown[] {
    return this.chunks.map(chunk => ({ type: 'text', text: String(chunk.text ?? '') }))
  }
  interruptedBlocks(): unknown[] {
    return this.blocks().filter(block => String((block as Record<string, unknown>).text).length > 0)
  }
}

const llm = {
  BlockAssembler: Assembler,
  expandAssistantStream(stream: unknown) {
    if (!Array.isArray(stream)) throw new Error('invalid stream')
    return stream
  },
  assembleAssistantStream(stream: unknown) {
    const assembler = new Assembler()
    for (const value of Array.isArray(stream) ? stream : []) {
      assembler.push(value as Record<string, unknown>)
    }
    return assembler
  },
}

const session = {
  isAppendSurfaceEvent: (event: Record<string, unknown>) => event.surfaceOp === 'append',
  isReplacementSurfaceEvent: (event: Record<string, unknown>) =>
    typeof event.surfaceOp === 'object' && event.surfaceOp !== null,
}

test('codec assembles live chunks and durable streams through the injected helpers', () => {
  const codec = makeTranscriptCodec(llm, session)
  const stream = codec.createStream()
  stream.push({ type: 'text-delta', text: 'a' })
  stream.push({ type: 'text-delta', text: 'b' })
  assert.equal(stream.snapshot().text, 'ab')
  assert.equal(stream.snapshot(true).text, 'ab')
  assert.equal(codec.assemble([{ type: 'text-delta', text: 'x' }, { type: 'text-delta', text: 'y' }]).text, 'xy')
  assert.throws(() => codec.assemble('not-a-stream'), /invalid stream/)
})

test('codec preserves canonical image references and order', () => {
  const codec = makeTranscriptCodec({
    ...llm,
    BlockAssembler: class extends Assembler {
      blocks(): unknown[] {
        return [
          { type: 'text', text: 'before ' },
          { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png', bytes: 4, width: 2, height: 2 } },
          { type: 'tool-call', name: 'bash' },
          { type: 'text', text: 'after' },
        ]
      }
    },
  }, session)
  const view = codec.createStream().snapshot()
  assert.equal(view.text, 'before after')
  assert.deepEqual(view.toolNames, ['bash'])
  assert.deepEqual(view.images?.map(image => image.attachmentId), ['a1'])
  assert.deepEqual(view.content?.map(part => part.type), ['text', 'image', 'text'])
})

test('surface classification uses the native helpers', () => {
  const codec = makeTranscriptCodec(llm, session)
  assert.equal(codec.surfaceKind({ type: 'user/message', seq: 0, data: {}, surfaceOp: 'append' }), 'append')
  assert.equal(codec.surfaceKind({ type: 'user/message', seq: 1, data: {}, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 0 } }), 'replace')
  assert.equal(codec.surfaceKind({ type: 'turn/start', seq: 2, data: {} }), 'none')
})

test('missing native helpers fail loudly instead of silently mirroring', () => {
  assert.throws(() => makeTranscriptCodec({}, session), /BlockAssembler/)
  assert.throws(() => makeTranscriptCodec(llm, {}), /isAppendSurfaceEvent/)
})

// ---------------------------------------------------------------------------
// Incremental projection: a streamed reply must not be re-scanned or re-joined
// per chunk. Every assertion below is a deterministic read counter plus full
// equality with an independent one-shot projection - never wall-clock.

/** Counted property reads, so a test can see exactly how much was re-scanned. */
interface ReadCounter {
  reads: number
}

/** One block whose property reads are counted: folding it is the work under test. */
function countedBlock(counter: ReadCounter, values: Record<string, string>): Record<string, unknown> {
  const block: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(block, key, { enumerable: true, get: () => { counter.reads += 1; return value } })
  }
  return block
}

interface FixturePart {
  readonly blockType: string
  text: string
  closed: boolean
  frozen?: unknown
}

/**
 * Chunk-driven fixture with the native assembler's two observable properties
 * the projection memo relies on: `blocks()` builds a new array on every read
 * and materializes a fresh object for a block it is still assembling, while a
 * closed block keeps the object it already returned.
 */
class FixtureAssembler {
  readonly counter: ReadCounter = { reads: 0 }
  private readonly parts = new Map<number, FixturePart>()
  private readonly order: number[] = []

  push(chunk: Record<string, unknown>): void {
    const index = Number(chunk.index)
    const type = String(chunk.type)
    if (type === 'block-start') {
      if (this.parts.has(index)) return
      this.order.push(index)
      this.parts.set(index, { blockType: String(chunk.blockType), text: '', closed: false })
      return
    }
    const blockType = type === 'reasoning-delta' ? 'reasoning' : 'text'
    let part = this.parts.get(index)
    if (part === undefined) {
      part = { blockType, text: '', closed: false }
      this.parts.set(index, part)
      this.order.push(index)
    }
    if (type === 'block-end') {
      part.closed = true
      return
    }
    // A delta for a block already closed by `block-end` is ignored, as native.
    if (!part.closed) part.text += String(chunk.text ?? '')
  }

  /** The same projection as plain data, for the independent reference. */
  plain(): Array<Record<string, unknown>> {
    return this.order.map((index) => {
      const part = this.parts.get(index) as FixturePart
      return { type: part.blockType, text: part.text }
    })
  }

  blocks(): unknown[] {
    return this.order.map((index) => {
      const part = this.parts.get(index) as FixturePart
      if (part.closed && part.frozen !== undefined) return part.frozen
      const block = countedBlock(this.counter, { type: part.blockType, text: part.text })
      if (part.closed) part.frozen = block
      return block
    })
  }

  interruptedBlocks(): unknown[] {
    return this.blocks()
  }
}

/** One-shot projection of the same blocks, independent of the codec's memo. */
function naivePresentation(blocks: readonly Record<string, unknown>[]): StreamPresentation {
  const text: string[] = []
  const thinking: string[] = []
  const toolNames: string[] = []
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text)
    else if (block.type === 'reasoning' && typeof block.text === 'string') thinking.push(block.text)
    else if (block.type === 'tool-call' && typeof block.name === 'string' && block.name.length > 0) toolNames.push(block.name)
  }
  const view: StreamPresentation = { text: text.join(''), thinking: thinking.join(''), toolNames }
  const content = displayContentParts(blocks)
  const images = content.flatMap(part => part.type === 'image' ? [part.attachment] : [])
  if (images.length === 0) return view
  return { ...view, images, content }
}

/** The codec plus the exact assembler instance its stream owns. */
function fixtureCodec(): { codec: TranscriptCodec; assembler: () => FixtureAssembler } {
  let created: FixtureAssembler | undefined
  class Tracked extends FixtureAssembler {
    constructor() {
      super()
      created = this
    }
  }
  const codec = makeTranscriptCodec({
    BlockAssembler: Tracked,
    expandAssistantStream(stream: unknown) { return stream },
    assembleAssistantStream() { return new FixtureAssembler() },
  }, session)
  return {
    codec,
    assembler: () => {
      if (created === undefined) throw new Error('the test must create the stream first')
      return created
    },
  }
}

interface StreamedRun {
  /** Block property reads the codec charged per snapshot, in order. */
  readonly perFrameReads: readonly number[]
  readonly views: readonly StreamPresentation[]
}

/**
 * Stream one settled prefix of `settled` closed text blocks plus `frames`
 * deltas on one still-open block, checking every frame against the independent
 * one-shot projection of the same blocks.
 */
function streamed(frames: number, settled: number): StreamedRun {
  const { codec, assembler } = fixtureCodec()
  const stream = codec.createStream()
  for (let index = 0; index < settled; index += 1) {
    stream.push({ type: 'block-start', index, blockType: 'text' })
    stream.push({ type: 'text-delta', index, text: `block ${index} ` })
    stream.push({ type: 'block-end', index })
  }
  assert.deepEqual(stream.snapshot(), naivePresentation(assembler().plain()), 'the settled prefix projects like a full scan')
  const perFrameReads: number[] = []
  const views: StreamPresentation[] = []
  for (let frame = 0; frame < frames; frame += 1) {
    stream.push({ type: 'text-delta', index: settled, text: `delta ${frame} ` })
    const before = assembler().counter.reads
    const view = stream.snapshot()
    perFrameReads.push(assembler().counter.reads - before)
    views.push(view)
    assert.deepEqual(view, naivePresentation(assembler().plain()), `frame ${String(frame)} matches the full projection`)
  }
  return { perFrameReads, views }
}

test('streaming a long reply never re-scans the already settled blocks', () => {
  const short = streamed(12, 4)
  const long = streamed(12, 64)
  // The still-open block is the only changed position, so one frame costs the
  // same number of block reads no matter how many blocks precede it.
  assert.deepEqual(long.perFrameReads, short.perFrameReads, 'the per-frame cost is independent of the settled prefix')
  for (const reads of long.perFrameReads) {
    assert.ok(reads <= 8, `one frame read ${String(reads)} block properties, expected the changed block only`)
  }
  const expected = `${Array.from({ length: 64 }, (_, index) => `block ${String(index)} `).join('')}${
    Array.from({ length: 12 }, (_, index) => `delta ${String(index)} `).join('')}`
  assert.equal(long.views.at(-1)?.text, expected)
})

test('an unchanged closed stream reuses its projection without reading any block again', () => {
  const { codec, assembler } = fixtureCodec()
  const stream = codec.createStream()
  for (const [index, text] of ['once', '+two'].entries()) {
    stream.push({ type: 'block-start', index, blockType: 'text' })
    stream.push({ type: 'text-delta', index, text })
    stream.push({ type: 'block-end', index })
  }
  const first = stream.snapshot()
  const afterFirst = assembler().counter.reads
  const second = stream.snapshot()
  assert.equal(assembler().counter.reads, afterFirst, 'a repeated snapshot reads no block')
  assert.equal(second.text, first.text)
  assert.deepEqual(second, naivePresentation(assembler().plain()))

  // A still-open block is materialized fresh by the native assembler, so it is
  // re-checked on its two projected fields - never re-folded or re-joined.
  stream.push({ type: 'text-delta', index: 2, text: ' open' })
  stream.snapshot()
  const afterOpen = assembler().counter.reads
  assert.deepEqual(stream.snapshot(), naivePresentation(assembler().plain()))
  assert.ok(assembler().counter.reads - afterOpen <= 2, 'one unchanged open block costs at most a field re-check')
})

test('reasoning and tool names keep native order when the assembler rebuilds every block', () => {
  const blocks = [
    { type: 'reasoning', text: 'why' },
    { type: 'tool-call', name: 'bash' },
    { type: 'text', text: 'then ' },
  ]
  const counter: ReadCounter = { reads: 0 }
  // Every read returns new objects, so the memo must fall back to the shallow
  // field compare instead of object identity.
  class Rebuilt {
    push(): void {}
    blocks(): unknown[] {
      return blocks.map(block => countedBlock(counter, {
        type: block.type,
        ...(block.text === undefined ? {} : { text: block.text }),
        ...(block.name === undefined ? {} : { name: block.name }),
      }))
    }
    interruptedBlocks(): unknown[] { return this.blocks() }
  }
  const codec = makeTranscriptCodec({
    BlockAssembler: Rebuilt,
    expandAssistantStream(stream: unknown) { return stream },
    assembleAssistantStream() { return new Rebuilt() },
  }, session)
  const stream = codec.createStream()
  const view = stream.snapshot()
  assert.equal(view.text, 'then ')
  assert.equal(view.thinking, 'why')
  assert.deepEqual(view.toolNames, ['bash'])
  assert.deepEqual(view, naivePresentation(blocks))
  const afterFirst = counter.reads
  assert.deepEqual(stream.snapshot(), view, 'an unchanged rebuilt stream projects identically')
  assert.deepEqual(stream.snapshot(true), view, 'the interrupted accessor keeps its own memo')
  assert.ok(counter.reads > afterFirst, 'a rebuilt block is re-checked, not assumed unchanged')
})

test('a cut projection and the full projection do not share state', () => {
  const { codec, assembler } = fixtureCodec()
  const stream = codec.createStream()
  stream.push({ type: 'block-start', index: 0, blockType: 'text' })
  stream.push({ type: 'text-delta', index: 0, text: 'one ' })
  stream.push({ type: 'block-end', index: 0 })
  stream.push({ type: 'text-delta', index: 1, text: 'two' })
  const full = stream.snapshot()
  const cut = stream.snapshot(true)
  assert.equal(full.text, 'one two')
  assert.equal(cut.text, 'one two')
  assert.deepEqual(full, naivePresentation(assembler().plain()))
  assert.deepEqual(cut, naivePresentation(assembler().plain()))
  stream.push({ type: 'text-delta', index: 1, text: ' three' })
  assert.equal(stream.snapshot().text, 'one two three')
  assert.equal(stream.snapshot(true).text, 'one two three')
})

test('an appended block keeps the earlier joined text and tool roster intact', () => {
  const { codec, assembler } = fixtureCodec()
  const stream = codec.createStream()
  stream.push({ type: 'text-delta', index: 0, text: 'first' })
  const first = stream.snapshot()
  stream.push({ type: 'block-start', index: 1, blockType: 'text' })
  stream.push({ type: 'text-delta', index: 1, text: ' second' })
  const second = stream.snapshot()
  assert.equal(first.text, 'first')
  assert.equal(second.text, 'first second')
  assert.equal(first.text, 'first', 'a presentation already handed out never changes')
  assert.deepEqual(second, naivePresentation(assembler().plain()))
})

test('a stream with an image keeps ordered content when a block is appended', () => {
  const attachment = { attachmentId: 'a1', mediaType: 'image/png', bytes: 4, width: 2, height: 2 }
  // One stable image block (as a closed block) and one rebuilt text block: the
  // append path must still fold the appended part into `content`.
  const image = { type: 'image', attachment }
  let text = 'look '
  const trailing: Array<Record<string, unknown>> = []
  class Rebuilt {
    push(): void {}
    blocks(): unknown[] {
      return [{ type: 'text', text }, image, ...trailing.map(block => ({ ...block }))]
    }
    interruptedBlocks(): unknown[] { return this.blocks() }
  }
  const codec = makeTranscriptCodec({
    BlockAssembler: Rebuilt,
    expandAssistantStream(stream: unknown) { return stream },
    assembleAssistantStream() { return new Rebuilt() },
  }, session)
  const stream = codec.createStream()
  const first = stream.snapshot()
  assert.equal(first.text, 'look ')
  assert.deepEqual(first.content?.map(part => part.type), ['text', 'image'])
  trailing.push({ type: 'text', text: 'again' })
  const second = stream.snapshot()
  assert.equal(second.text, 'look again')
  assert.deepEqual(second.content?.map(part => part.type), ['text', 'image', 'text'])
  assert.deepEqual(second.images?.map(ref => ref.attachmentId), ['a1'])
  assert.deepEqual(second.content, displayContentParts([{ type: 'text', text }, image, ...trailing]))
  // A changed leading block leaves the append path: the projection is rebuilt.
  text = ''
  const cleared = stream.snapshot()
  assert.equal(cleared.text, 'again')
  assert.deepEqual(cleared.content, displayContentParts([{ type: 'text', text: '' }, image, ...trailing]))
})

test('a throwing blocks() read falls back to the interrupted projection and later reads stay correct', () => {
  // A tentative stream can hold an open unknown block, so the native
  // `blocks()` accessor may throw while `interruptedBlocks()` still answers the
  // safe prefix. The snapshot must return that prefix (`interruptedBlocks()`
  // empty-string blocks are dropped here to make the two orders differ) without
  // throwing, and the following full read must still project the full text.
  let broken = true
  const texts = ['ok ']
  class Tentative {
    push(): void {}
    blocks(): unknown[] {
      if (broken) throw new Error('open unknown block')
      return texts.map(text => ({ type: 'text', text }))
    }
    interruptedBlocks(): unknown[] {
      return texts.map(text => ({ type: 'text', text })).filter(block => block.text.length > 0)
    }
  }
  const codec = makeTranscriptCodec({
    BlockAssembler: Tentative,
    expandAssistantStream(stream: unknown) { return stream },
    assembleAssistantStream() { return new Tentative() },
  }, session)
  const stream = codec.createStream()
  const fallback = stream.snapshot()
  // Value-equivalent to a one-shot projection of the interrupted blocks: the
  // fallback is a projection, never a partial or stale view.
  assert.deepEqual(fallback, naivePresentation([{ type: 'text', text: 'ok ' }]))
  broken = false
  texts.push('more')
  assert.equal(stream.snapshot().text, 'ok more', 'the full accessor recovers on the next readable blocks()')
  assert.equal(stream.snapshot(true).text, 'ok more', 'the interrupted accessor keeps its own memo')
})
