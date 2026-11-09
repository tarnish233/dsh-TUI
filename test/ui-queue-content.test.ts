import assert from 'node:assert/strict'
import test from 'node:test'
import type { QueueEntry } from '../src/backend/types.ts'
import { QueueList } from '../src/ui/queue-list.ts'
import { queueAttachmentLabel, queueContentLabel } from '../src/ui/queue-content.ts'
import { stripTerminalSequences } from '#pi-tui'
import { visibleWidth } from '../src/ui/text.ts'

const row = (patch: Partial<QueueEntry> = {}): QueueEntry => ({ messageId: 'native-file-queue', text: '', target: 'next-turn', images: 0, ...patch })

test('native queued files never look like empty/image-only messages', () => {
  assert.equal(queueContentLabel(row({ files: 1 })), '(file)')
  assert.equal(queueAttachmentLabel(row({ files: 1 })), '1 file')
  assert.equal(queueAttachmentLabel(row({ files: 2, images: 1 })), '1 image · 2 files')
  assert.equal(queueContentLabel(row({ files: 2, images: 1 })), '(attachments)')
  assert.equal(queueContentLabel(row({ text: 'native text', files: 2 })), 'native text')
  assert.equal(queueContentLabel(row()), '(empty)', 'older/demo rows keep the text-only fallback')
})

test('unknown/invalid queued file counts are not fabricated positive counts', () => {
  for (const files of [-1, Number.NaN, Infinity, 1.5]) {
    assert.equal(queueAttachmentLabel(row({ files })), '')
  }
  assert.equal(queueContentLabel(row({ images: 1 })), '(image)')
})

test('fixed native queue list retains file counts, actions and column safety', () => {
  const list = new QueueList({ sendNow() {}, edit() {}, cancel() {}, changed() {} })
  list.rows = [row({ files: 2 }), row({ messageId: 'mixed', images: 1, files: 1, text: '中文 😀 text' })]
  const text = list.render(110).map(stripTerminalSequences).join('\n')
  assert.match(text, /\(file\).*2 files/)
  assert.match(text, /1 image · 1 file/)
  assert.match(text, /\[Send now\].*\[Edit\].*\[Cancel\]/)
  for (const width of [1, 4, 10, 24, 40, 80, 110]) for (const line of list.render(width)) assert.ok(visibleWidth(line) <= width)
})
