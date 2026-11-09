// Must stay the FIRST import: forces truecolor before src modules snapshot terminal mode.
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type {
  DisplayContentPart,
  FileAttachmentRef,
  SessionEvent,
  SessionInfo,
} from '../src/backend/types.ts'
import { TranscriptStore, type UserTranscriptItem } from '../src/state/transcript.ts'
import { TranscriptView } from '../src/ui/transcript.ts'
import { getTranscriptImages, itemContentParts, itemImageCount } from '../src/ui/image-data.ts'
import { fileDisplayName, fileMarkerChip, fileMarkerLine, fileSizeLabel } from '../src/ui/file-marker.ts'

/**
 * A3 regression: a native DSH `file` content block (FileBlock) is presentation
 * evidence, not an upload capability. These tests drive the compiled store and
 * view exactly like the audit probes (native-shaped `{type:'file',attachment}`
 * metadata only) and assert that the reference survives both durable routes,
 * keeps its position/repeats, stays a read-only metadata row, and is never
 * counted, clicked, fetched or decoded as an image.
 */

const REPORT: FileAttachmentRef = {
  attachmentId: 'sha256:6b1a4f0c9d2e8a7b5c3d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b',
  name: 'quarterly-report.csv',
  bytes: 32,
}
const NOTES: FileAttachmentRef = { attachmentId: 'sha256:notes', name: 'notes.md', bytes: 2048 }

const event = (type: string, seq: number, data: unknown, extra: Partial<SessionEvent> = {}): SessionEvent => ({
  type,
  seq,
  time: 1_700_000_000_000 + seq,
  data,
  surfaceOp: 'append',
  ...extra,
})

const userMessage = (content: unknown[]) => ({ id: 'u1', role: 'user', content, source: { kind: 'user' } })

const info = (events: SessionEvent[] = []): SessionInfo => ({
  sessionId: 'session-files',
  cwd: '/tmp/work',
  provider: 'fixture',
  model: 'fixture',
  capabilities: [],
  events,
})

/** Cold route: `ready` replays the durable snapshot (resume/rebuild). */
function coldStore(events: SessionEvent[] = []): TranscriptStore {
  const store = new TranscriptStore({ onChange: () => {} })
  store.handle({ type: 'ready', info: info(events) })
  return store
}

/** Live route: one durable `session_event` per native append. */
function liveStore(events: SessionEvent[] = []): TranscriptStore {
  const store = new TranscriptStore({ onChange: () => {} })
  store.handle({ type: 'ready', info: info([]) })
  for (const value of events) store.handle({ type: 'session_event', sessionId: 'session-files', event: value })
  return store
}

function userItems(store: TranscriptStore): UserTranscriptItem[] {
  return store.items.filter((item): item is UserTranscriptItem => item.kind === 'user')
}

function renderText(store: TranscriptStore, width = 80): string {
  const view = new TranscriptView(store, { showThinking: true, expandTools: false })
  return stripTerminalSequences(view.render(width).join('\n'))
}

const mixedContent = (): DisplayContentPart[] => [
  { type: 'text', text: 'please summarise the attached report' },
  { type: 'file', attachment: REPORT },
]

// ---------------------------------------------------------------------------
// Durable projection: both routes keep the native reference

test('cold replay keeps text/file order and the exact native file metadata', () => {
  const store = coldStore([event('user/message', 1, userMessage(mixedContent()))])
  const [user] = userItems(store)
  assert.ok(user, 'the mixed user row survives resume/rebuild')
  assert.equal(user.text, 'please summarise the attached report')
  assert.deepEqual(user.content?.map(part => part.type), ['text', 'file'], 'text/file order is preserved')
  const part = user.content?.find(value => value.type === 'file')
  assert.deepEqual(part?.attachment, REPORT, 'only the native immutability metadata ref is kept')
  assert.doesNotMatch(JSON.stringify(user), /mediaType|"data"|base64|path/i, 'no decoded bytes, payload or host path is carried')
  assert.equal(part?.attachment.bytes, REPORT.bytes, 'the native metadata size is passed through verbatim')
  assert.equal(itemImageCount(user), 0, 'a file block is not an image block')
  assert.deepEqual(getTranscriptImages(store.items), [], 'files never enter image navigation')
})

test('file-only user messages stay visible on cold, live and rebuilt transcripts', () => {
  const events = [event('user/message', 1, userMessage([{ type: 'file', attachment: REPORT }]))]
  for (const [label, store] of [
    ['cold ready', coldStore(events)],
    ['live session_event', liveStore(events)],
  ] as const) {
    const [user] = userItems(store)
    assert.ok(user, `${label}: a file-only prompt must not be dropped`)
    assert.equal(user.text, '', `${label}: no prompt text is invented`)
    assert.deepEqual(user.content?.map(part => part.type), ['file'], `${label}: the file part is preserved`)
    assert.equal(user.imageCount, 0, `${label}: a native file is not counted as an image`)
  }

  // Rebuild/resume is a replay of the same durable snapshot: same rows, no copy.
  const rebuilt = coldStore(events)
  rebuilt.handle({ type: 'ready', info: info(events) })
  assert.equal(userItems(rebuilt).length, 1, 'replaying the snapshot does not duplicate the row')
  assert.deepEqual(userItems(rebuilt)[0]?.content?.map(part => part.type), ['file'])
})

test('repeated native file refs keep every occurrence and order', () => {
  const content: DisplayContentPart[] = [
    { type: 'file', attachment: REPORT },
    { type: 'text', text: 'compare with the notes' },
    { type: 'file', attachment: REPORT },
    { type: 'file', attachment: NOTES },
  ]
  const store = coldStore([event('user/message', 1, userMessage(content))])
  const [user] = userItems(store)
  assert.ok(user)
  assert.deepEqual(itemContentParts(user).map(part => part.type), ['file', 'text', 'file', 'file'])
  assert.deepEqual(
    itemContentParts(user).flatMap(part => part.type === 'file' ? [part.attachment.attachmentId] : []),
    [REPORT.attachmentId, REPORT.attachmentId, NOTES.attachmentId],
    'the same durable ref may occur more than once and is never collapsed',
  )
})

test('invalid file metadata is not displayed and cannot fake a message', () => {
  const store = coldStore([
    event('user/message', 1, userMessage([{ type: 'file', attachment: { attachmentId: '', name: 'x', bytes: 1 } }])),
    event('user/message', 2, userMessage([{ type: 'file', attachment: { attachmentId: 'id', name: '', bytes: 1 } }])),
    event('user/message', 3, userMessage([{ type: 'file', attachment: { attachmentId: 'id', name: 'x', bytes: -1 } }])),
    event('user/message', 4, userMessage([{ type: 'file', attachment: { attachmentId: 'id', name: 'x', bytes: 1.5 } }])),
    // Positive control: an empty native file is valid (bytes >= 0).
    event('user/message', 5, userMessage([{ type: 'file', attachment: { attachmentId: 'empty', name: 'empty.txt', bytes: 0 } }])),
  ])
  const rows = userItems(store)
  assert.equal(rows.length, 1, 'malformed file-only messages add no fabricated row')
  assert.equal(rows[0]?.seq, 5)
  assert.deepEqual(itemContentParts(rows[0]!), [{ type: 'file', attachment: { attachmentId: 'empty', name: 'empty.txt', bytes: 0 } }])
})

// ---------------------------------------------------------------------------
// Rendering: compact read-only marker, never image chrome

test('a file renders as one compact read-only metadata row in place', () => {
  const store = coldStore([
    event('user/message', 1, userMessage([
      { type: 'text', text: 'first paragraph' },
      { type: 'file', attachment: REPORT },
      { type: 'text', text: 'second paragraph' },
    ])),
  ])
  const text = renderText(store, 100)
  const first = text.indexOf('first paragraph')
  const marker = text.indexOf(fileMarkerChip(1))
  const second = text.indexOf('second paragraph')
  assert.ok(first >= 0 && marker > first && second > marker, `content order: ${JSON.stringify(text)}`)
  assert.match(text, /quarterly-report\.csv · 32 B/, 'name and native byte size are shown')
  assert.doesNotMatch(text, /\[Image #/, 'a file is never presented as an image')
  assert.doesNotMatch(text, /click|to view/, 'the file marker advertises no affordance')
})

test('hostile file names are sanitized to one width-safe line', () => {
  const hostile = 'evil\x1b[31mred\x1b[0m\nname\u0007.csv '
  assert.equal(fileDisplayName(hostile), 'evilred name.csv')
  assert.equal(fileDisplayName('\x1b]0;pwned\x07'), 'file', 'an OSC payload is stripped with its sequence')
  assert.equal(fileDisplayName('a\u0000b\x07c'), 'abc', 'control bytes are removed')
  assert.equal(fileDisplayName('   '), 'file')

  const ref: FileAttachmentRef = { attachmentId: 'sha256:hostile', name: hostile, bytes: 1536 }
  for (const width of [1, 2, 5, 10, 20, 40]) {
    const line = fileMarkerLine(1, ref, width)
    assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`)
    assert.ok(!line.includes('\x1b[31m'), 'hostile ANSI never reaches the line')
    assert.ok(!line.includes('\n') && !line.includes('\u0007'), 'hostile controls/newlines stay out of the row')
  }
  const wide = stripTerminalSequences(fileMarkerLine(1, ref, 40))
  assert.match(wide, /^\[File #1\] evilred name\.csv/)
  assert.match(wide, /1\.5 KB/, 'size uses 1024-based units with bounded precision')
  assert.equal(fileSizeLabel(0), '0 B')
  assert.equal(fileSizeLabel(32), '32 B')
})

test('CJK/emoji file names stay width-correct and the chip survives narrow widths', () => {
  const ref: FileAttachmentRef = { attachmentId: 'sha256:cjk', name: '报告 📄 quarterly 数据.csv', bytes: 4096 }
  for (const width of [4, 8, 12, 20, 40, 80]) {
    const line = fileMarkerLine(1, ref, width)
    assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`)
  }
  const comfortable = stripTerminalSequences(fileMarkerLine(1, ref, 40))
  assert.match(comfortable, /\[File #1\]/)
  assert.match(comfortable, /报告 📄 quarterly 数据\.csv/)
  // Repeated renders are stable (no accumulating truncation in the cache path).
  assert.equal(fileMarkerLine(1, ref, 40), fileMarkerLine(1, ref, 40))
})

test('the transcript view keeps widths, order and cache stability for mixed file content', () => {
  const store = coldStore([
    event('user/message', 1, userMessage([
      { type: 'file', attachment: REPORT },
      { type: 'text', text: 'please compare 报告 📄 with the previous run' },
      { type: 'file', attachment: NOTES },
    ])),
  ])
  const view = new TranscriptView(store, { showThinking: true, expandTools: false })
  for (const width of [20, 40, 80, 120]) {
    const lines = view.render(width)
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${JSON.stringify(line)}`)
    const text = stripTerminalSequences(lines.join('\n'))
    assert.ok(text.indexOf('[File #1]') < text.indexOf('[File #2]'), `file order at width ${width}`)
  }
  const first = view.render(80)
  const again = view.render(80)
  assert.deepEqual(again, first, 'an unchanged transcript re-uses its rendered frame')
})

test('images still work and are the only attachment kind that is clickable', () => {
  const image = { attachmentId: 'sha256:control', mediaType: 'image/png' as const, bytes: 68, width: 1, height: 1 }
  const store = coldStore([
    event('user/message', 1, userMessage([{ type: 'file', attachment: REPORT }])),
    event('user/message', 2, userMessage([{ type: 'text', text: 'see image' }, { type: 'image', attachment: image }])),
  ])
  const [fileRow, imageRow] = userItems(store)
  assert.ok(fileRow && imageRow)
  assert.equal(itemImageCount(fileRow), 0)
  assert.equal(itemImageCount(imageRow), 1)
  const imageAttachmentIds = getTranscriptImages(store.items).flatMap(item =>
    item.attachment === undefined ? [] : [item.attachment.attachmentId])
  assert.deepEqual(imageAttachmentIds, ['sha256:control'])

  const requests: string[] = []
  const view = new TranscriptView(store, {
    showThinking: true,
    expandTools: false,
    imageDetailsHint: 'ctrl+i',
    onImageDetails: request => { requests.push(request.key) },
  })
  const text = stripTerminalSequences(view.render(100).join('\n'))
  assert.match(text, /\[File #1\] quarterly-report\.csv/, 'the file marker is inert metadata')
  assert.match(text, /\[Image #1\]/, 'the image positive control keeps its marker')
  assert.match(text, /ctrl\+i to view/, 'the image control still advertises the real binding')
  assert.deepEqual(requests, [], 'rendering never opens or fetches an attachment')
})

test('a text-only message is unchanged by the file projection', () => {
  const store = coldStore([event('user/message', 1, userMessage([{ type: 'text', text: 'plain prompt' }]))])
  const [user] = userItems(store)
  assert.ok(user)
  assert.equal(user.text, 'plain prompt')
  assert.equal(user.content, undefined, 'text-only rows keep their historical shape')
  assert.match(renderText(store), /> plain prompt/)
})