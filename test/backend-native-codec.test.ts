/**
 * Pure transcript-codec factory contract: it delegates entirely to the public
 * DSH helpers it is given and fails loudly when they are incomplete.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeTranscriptCodec } from '../src/backend/native-codec.ts'

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