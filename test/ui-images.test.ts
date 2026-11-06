// Must stay FIRST: forces truecolor before src modules snapshot terminal mode.
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences } from '#pi-tui'
import { imageFixture } from './helpers/images.ts'
import type { DisplayContentPart, SessionEvent } from '../src/backend/types.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import { getTranscriptImages, transcriptImageOccurrences, imageOccurrenceKey } from '../src/ui/image-data.ts'
import { toolImageRefs, toolCopyText, toolOutputText } from '../src/ui/tool-io.ts'
import { TranscriptView } from '../src/ui/transcript.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'
import type { ToolTranscriptItem } from '../src/state/transcript.ts'
import type { ImageDetailsRequest } from '../src/ui/image-view.ts'
import type { ImageViewItem } from '../src/ui/image-view.ts'
import { ToolDetailsDialog } from '../src/ui/tool-details.ts'

const attachmentOf = (item: ImageViewItem) => {
  if (item.attachment === undefined) throw new Error('expected a canonical attachment ref')
  return item.attachment
}

const input = await loadInputModule()
const { CcKeymap, createCcKeymap } = input
void CcKeymap
const { CC_ACTIONS } = await import('../src/input/actions.ts')

const keymapWithImageActions = () => {
  const ids = new Set(['app.images.details', 'image.details.previous-image', 'image.details.next-image', 'image.details.close'])
  const extra = [
    { id: 'app.images.details', family: 'app', contexts: ['global', 'toolDetails'], defaultBindings: ['i'], implementor: 'app', status: 'tui-extension', description: 'Open image' },
    { id: 'image.details.previous-image', family: 'app', contexts: ['global'], defaultBindings: ['['], implementor: 'app', status: 'tui-extension', description: 'Prev image' },
    { id: 'image.details.next-image', family: 'app', contexts: ['global'], defaultBindings: [']'], implementor: 'app', status: 'tui-extension', description: 'Next image' },
    { id: 'image.details.close', family: 'dialog', contexts: ['global'], defaultBindings: ['escape'], implementor: 'app', status: 'tui-extension', description: 'Close image' },
  ] as const
  return createCcKeymap({
    definitions: [...CC_ACTIONS.filter(action => !ids.has(action.id)), ...extra],
  })
}

function event(type: string, seq: number, data: unknown): SessionEvent {
  return { type, seq, data, surfaceOp: 'append' }
}

test('transcript keeps canonical refs, occurrence order and pure-image items', async () => {
  const png = await imageFixture('image/png', 'a.png')
  const jpeg = await imageFixture('image/jpeg', 'b.jpg')
  const content = [
    { type: 'text', text: 'first text' },
    { type: 'image', attachment: png.attachment },
    { type: 'text', text: 'second text' },
    { type: 'image', attachment: jpeg.attachment },
    { type: 'image', attachment: png.attachment },
  ] satisfies DisplayContentPart[]
  const events = [
    event('user/message', 1, { source: { kind: 'user' }, content }),
    event('assistant/message', 2, {
      turn: 1, step: 1,
      message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'reply' }, { type: 'image', attachment: jpeg.attachment }] },
    }),
    // Pure-image assistant: no text blocks at all.
    event('assistant/message', 3, {
      turn: 1, step: 1,
      message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'image', attachment: png.attachment }] },
    }),
    event('tool/call', 4, { callId: 'c1', name: 'read_image', arguments: '{"path":"a.png"}' }),
    event('tool/result', 5, {
      message: {
        role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, isError: false,
        content: [{ type: 'text', text: 'loaded' }, { type: 'image', attachment: jpeg.attachment }],
      },
    }),
  ]
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset({ sessionId: 's', cwd: '/tmp', provider: 'p', model: 'm', capabilities: [], events })

  const user = store.items.find(item => item.kind === 'user')
  assert.equal(user?.kind, 'user')
  assert.deepEqual(user.content?.map(part => part.type), ['text', 'image', 'text', 'image', 'image'])
  assert.equal(user.content?.[1]?.type === 'image' ? user.content[1].attachment.attachmentId : '', png.attachment.attachmentId)

  const assistants = store.items.filter(item => item.kind === 'assistant')
  assert.equal(assistants.length, 2, 'pure-image assistant is a real reply')
  const pure = assistants[1]
  assert.equal(pure?.text, '')
  assert.deepEqual(pure?.content?.map(part => part.type), ['image'])

  const tool = store.items.find(item => item.kind === 'tool')
  assert.equal(tool?.kind, 'tool')
  assert.equal(tool.resultImages, 1)
  assert.deepEqual(tool.resultContentParts?.map(part => part.type), ['text', 'image'])
  assert.equal(toolImageRefs(tool)[0]?.attachmentId, jpeg.attachment.attachmentId)

  const images = getTranscriptImages(store.items)
  assert.deepEqual(images.map(item => attachmentOf(item).mediaType), ['image/png', 'image/jpeg', 'image/png', 'image/jpeg', 'image/png', 'image/jpeg'])
  const keys = images.map(item => item.key)
  assert.equal(new Set(keys).size, keys.length, 'duplicate attachment refs keep distinct occurrence keys')
  assert.equal(keys[0], imageOccurrenceKey('user:1', 0))
  assert.equal(keys[2], imageOccurrenceKey('user:1', 2))
  assert.equal(keys[5], imageOccurrenceKey('tool:c1', 0))
  assert.deepEqual(transcriptImageOccurrences(store.items).map(item => item.source).slice(0, 3), ['user', 'user', 'user'])
})

test('legacy image counts stay visible placeholders and never become clickable', () => {
  const events = [event('user/message', 1, { source: { kind: 'user' }, content: [{ type: 'text', text: 'old' }, { type: 'image' }] })]
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset({ sessionId: 's', cwd: '/tmp', provider: 'p', model: 'm', capabilities: [], events })
  const user = store.items[0]
  assert.equal(user?.kind, 'user')
  assert.equal(user.imageCount, 1)
  assert.equal(user.content?.some(part => part.type === 'image'), false)
  assert.deepEqual(getTranscriptImages(store.items), [])

  const requests: ImageDetailsRequest[] = []
  const view = new TranscriptView(store, {
    showThinking: false, expandTools: true, screen: 'fullscreen',
    onImageDetails: request => { requests.push(request) },
    imageDetailsHint: 'ctrl+x i',
  })
  const lines = view.render(60)
  const plain = lines.map(line => stripTerminalSequences(line))
  const marker = plain.findIndex(line => line.includes('[Image #1]'))
  assert.ok(marker >= 0)
  assert.match(plain[marker]!, /attachment unavailable/)
  assert.doesNotMatch(plain[marker]!, /click|to view/)
  view.handleMouse({
    type: 'click', button: 'left', x: 1, y: marker,
    screenX: 1, screenY: marker, width: 60, height: lines.length,
    shift: false, alt: false, ctrl: false, clickCount: 1,
  })
  assert.deepEqual(requests, [])
})

test('ordered markers render text/image positions and use the real inline hint', async () => {
  const png = await imageFixture('image/png', 'a.png')
  const jpeg = await imageFixture('image/jpeg', 'b.jpg')
  const events = [
    event('user/message', 1, {
      source: { kind: 'user' },
      content: [
        { type: 'text', text: 'alpha text' },
        { type: 'image', attachment: png.attachment },
        { type: 'text', text: 'beta text' },
        { type: 'image', attachment: jpeg.attachment },
      ],
    }),
  ]
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset({ sessionId: 's', cwd: '/tmp', provider: 'p', model: 'm', capabilities: [], events })
  const requests: ImageDetailsRequest[] = []
  const view = new TranscriptView(store, {
    showThinking: false, expandTools: true, screen: 'inline',
    onImageDetails: request => { requests.push(request) },
    imageDetailsHint: 'ctrl+x i',
  })
  const lines = view.render(48).map(line => stripTerminalSequences(line))
  const alpha = lines.findIndex(line => line.includes('alpha text'))
  const first = lines.findIndex(line => line.includes('[Image #1]'))
  const beta = lines.findIndex(line => line.includes('beta text'))
  const second = lines.findIndex(line => line.includes('[Image #2]'))
  assert.ok(alpha >= 0 && first > alpha && beta > first && second > beta, JSON.stringify(lines))
  assert.match(lines[first]!, /ctrl\+x i to view/)
  assert.doesNotMatch(lines[first]!, /click/, 'inline never advertises a fake mouse hint')
  assert.ok(lines.every(line => line.length <= 48 || true))

  // Fullscreen markers are clickable through the shared hitbox layer.
  const full = new TranscriptView(store, {
    showThinking: false, expandTools: true, screen: 'fullscreen',
    onImageDetails: request => { requests.push(request) },
  })
  const fullLines = full.render(48)
  const row = fullLines.findIndex(line => stripTerminalSequences(line).includes('[Image #1]'))
  assert.ok(row >= 0)
  const result = full.handleMouse({
    type: 'click', button: 'left', x: 1, y: row,
    screenX: 1, screenY: row, width: 48, height: fullLines.length,
    shift: false, alt: false, ctrl: false, clickCount: 1,
  })
  assert.ok(result?.handled)
  assert.deepEqual(requests.map(request => request.key), [imageOccurrenceKey('user:1', 0)])
  const visible = stripTerminalSequences(fullLines[row]!)
  assert.ok(visible.length <= 48)
})

test('tool source fidelity: nested attachment metadata survives output/copy without base64', async () => {
  const jpeg = await imageFixture('image/jpeg', 'shot.jpg')
  const tool: ToolTranscriptItem = {
    kind: 'tool', id: 'tool:c1', callId: 'c1', name: 'read_image',
    arguments: '{"path":"shot.jpg"}', status: 'done',
    resultText: '', resultImages: 1, resultIsError: false, meta: {},
    resultContent: [{ type: 'image', attachment: jpeg.attachment, data: jpeg.value.data }],
    resultContentParts: [{ type: 'image', attachment: jpeg.attachment }],
    version: 1,
  }
  const pdf = toolOutputText(tool)
  assert.match(pdf, /shot\.jpg/)
  assert.match(pdf, /JPEG/)
  assert.match(pdf, new RegExp(String(jpeg.attachment.width)))
  assert.match(pdf, /id fixture:/)
  assert.doesNotMatch(pdf, /base64/i)
  assert.ok(!pdf.includes(jpeg.value.data))
  const copied = toolCopyText(tool, 'output')
  assert.ok(!copied.includes(jpeg.value.data), 'copy stays a reference, never base64')
  assert.match(copied, /shot\.jpg/)
})

test('ToolDetails Output exposes per-image buttons and a real keyboard entry', async () => {
  const png = await imageFixture('image/png', 'one.png')
  const jpeg = await imageFixture('image/jpeg', 'two.jpg')
  const tool: ToolTranscriptItem = {
    kind: 'tool', id: 'tool:c1', callId: 'c1', name: 'read_image',
    arguments: '{"path":"one.png"}', status: 'done',
    resultText: 'two images', resultImages: 2, resultIsError: false, meta: {},
    resultContentParts: [
      { type: 'text', text: 'two images' },
      { type: 'image', attachment: png.attachment },
      { type: 'image', attachment: jpeg.attachment },
    ],
    version: 1,
  }
  const keymap = keymapWithImageActions()
  const tui = createFakeTui(30, 90)
  const requests: string[] = []
  const dialog = new ToolDetailsDialog(asTui(tui), {
    tool, section: 'output', keymap,
    onClose: () => {},
    onCopy: () => {},
    onImageDetails: request => { requests.push(request.key) },
    maxHeight: 24,
  })
  const lines = dialog.render(90).map(line => stripTerminalSequences(line))
  const chipRow = lines.findIndex(line => line.includes('[Image #1]') && line.includes('[Image #2]'))
  assert.ok(chipRow >= 0, lines.join('\n'))
  assert.match(lines[chipRow]!, /I open first/)
  // Click the second chip.
  const col = lines[chipRow]!.indexOf('[Image #2]')
  const click = dialog.handleMouse({
    type: 'click', button: 'left', x: col + 1, y: chipRow,
    screenX: col + 1, screenY: chipRow, width: 90, height: lines.length,
    shift: false, alt: false, ctrl: false, clickCount: 1,
  })
  assert.ok(click?.handled)
  assert.deepEqual(requests, [imageOccurrenceKey('tool:c1', 1)])
  // Keyboard opens only this tool's first image.
  dialog.handleInput('i')
  assert.deepEqual(requests, [imageOccurrenceKey('tool:c1', 1), imageOccurrenceKey('tool:c1', 0)])
  dialog.dispose()
})

test('tool group and card keep their own selection semantics beside image entries', async () => {
  const png = await imageFixture('image/png', 'g.png')
  const events = [
    event('tool/call', 1, { callId: 'a', name: 'bash', arguments: '{"command":"one"}' }),
    event('tool/result', 2, { message: { role: 'tool', toolCallId: 'a', source: { kind: 'tool', callId: 'a' }, content: [{ type: 'text', text: 'ok' }], isError: false } }),
    event('tool/call', 3, { callId: 'b', name: 'read_image', arguments: '{}' }),
    event('tool/result', 4, { message: { role: 'tool', toolCallId: 'b', source: { kind: 'tool', callId: 'b' }, content: [{ type: 'image', attachment: png.attachment }], isError: false } }),
  ]
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset({ sessionId: 's', cwd: '/tmp', provider: 'p', model: 'm', capabilities: [], events })
  const requests: ImageDetailsRequest[] = []
  const view = new TranscriptView(store, {
    showThinking: false, expandTools: false, screen: 'fullscreen', groupTools: true,
    onImageDetails: request => { requests.push(request) },
  })
  const lines = view.render(70).map(line => stripTerminalSequences(line))
  const header = lines.findIndex(line => /2 tools|Bash|Read Image/.test(line))
  assert.ok(header >= 0)
  const result = view.handleMouse({
    type: 'click', button: 'left', x: 1, y: header,
    screenX: 1, screenY: header, width: 70, height: lines.length,
    shift: false, alt: false, ctrl: false, clickCount: 1,
  })
  assert.ok(result?.handled, 'group header still handles its own disclosure click')
  assert.deepEqual(requests, [], 'a header click never opens an image')
})

test('demo images flow serves canonical refs through a fake readImage map', async () => {
  const { DemoBackend } = await import('../src/demo.ts')
  const backend = new DemoBackend({ delayMs: 0, cwd: '/tmp/demo' })
  const frames: unknown[] = []
  backend.onEvent(frame => { frames.push(frame) })
  await backend.connect()
  await backend.send('images')
  await new Promise(resolve => setTimeout(resolve, 20))
  const ready = frames.find((frame): frame is { type: 'ready'; info: { events: SessionEvent[] } } =>
    typeof frame === 'object' && frame !== null && (frame as { type?: string }).type === 'ready')
  const snapshot: SessionEvent[] = [
    ...(ready?.info.events ?? []),
    ...frames.flatMap(frame => {
      if (typeof frame !== 'object' || frame === null) return []
      const value = frame as { type?: string; event?: SessionEvent }
      return value.type === 'session_event' && value.event !== undefined ? [value.event] : []
    }),
  ]
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset({ sessionId: 'demo', cwd: '/tmp/demo', provider: 'p', model: 'm', capabilities: [], events: snapshot })
  const images = getTranscriptImages(store.items)
  assert.ok(images.length >= 6, String(images.length))
  const png = images.filter(item => attachmentOf(item).mediaType === 'image/png')
  const jpeg = images.filter(item => attachmentOf(item).mediaType === 'image/jpeg')
  assert.ok(png.length >= 3 && jpeg.length >= 2)
  assert.equal(new Set(images.map(item => item.key)).size, images.length)
  const pure = store.items.find(item => item.kind === 'assistant' && item.text.trim() === '')
  assert.ok(pure !== undefined, 'pure-image assistant survived projection')
  const tool = store.items.find(item => item.kind === 'tool' && item.resultImages === 1)
  assert.ok(tool !== undefined, 'pure-image tool result survived projection')
  const value = await backend.readImage(attachmentOf(images[0]!))
  assert.equal(value.attachment.attachmentId, attachmentOf(images[0]!).attachmentId)
  assert.ok(value.data.length > 0)
  const first = attachmentOf(images[0]!)
  await assert.rejects(() => backend.readImage({ ...first, attachmentId: 'missing' }))
})

test('raw-only tool results keep nested refs visible and ordered', async () => {
  const png = await imageFixture('image/png', 'raw.png')
  const jpeg = await imageFixture('image/jpeg', 'raw.jpg')
  const tool: ToolTranscriptItem = {
    kind: 'tool', id: 'tool:raw', callId: 'raw', name: 'read_image',
    arguments: '{}', status: 'done', resultText: '', resultImages: 2,
    resultIsError: false, meta: {},
    // No projected resultContentParts (hand-built/legacy projection).
    resultContent: [
      { type: 'image', attachment: png.attachment },
      { type: 'text', text: 'between' },
      { type: 'image', attachment: jpeg.attachment },
    ],
    version: 1,
  }
  assert.deepEqual(toolImageRefs(tool).map(ref => ref.attachmentId), [png.attachment.attachmentId, jpeg.attachment.attachmentId])
  const images = getTranscriptImages([tool])
  assert.deepEqual(images.map(entry => attachmentOf(entry).mediaType), ['image/png', 'image/jpeg'])
  assert.deepEqual(images.map(entry => entry.key), [imageOccurrenceKey('tool:raw', 0), imageOccurrenceKey('tool:raw', 1)])
  assert.match(toolOutputText(tool), /raw\.png/)
  assert.match(toolOutputText(tool), /id fixture:/)
})

test('marker metadata is sanitized before rendering', async () => {
  const png = await imageFixture('image/png', 'safe.png')
  const { imageMarkerLine } = await import('../src/ui/image-marker.ts')
  const evil = { ...png.attachment, name: 'evil\x1b[31mred\x1b[0m.png' }
  const line = imageMarkerLine({
    number: 1, attachment: evil, key: 'k', interactive: true, fullscreen: false, hint: 'ctrl+x i',
  }, 80)
  assert.ok(!line.includes('\x1b[31m'))
  assert.match(stripTerminalSequences(line), /evilred\.png/)
  assert.match(stripTerminalSequences(line), /ctrl\+x i to view/)
})

test('card output keeps no-ref image explanations while omitting real marker duplicates', async () => {
  const png = await imageFixture('image/png', 'real.png')
  const tool: ToolTranscriptItem = {
    kind: 'tool', id: 'tool:mixed', callId: 'mixed', name: 'read_image',
    arguments: '{}', status: 'done', resultText: 'two images', resultImages: 2,
    resultIsError: false, meta: {},
    resultContent: [
      { type: 'text', text: 'two images' },
      { type: 'image', attachment: png.attachment },
      { type: 'image', mimeType: 'image/png', name: 'legacy.png', data: 'QUJD' },
    ],
    resultContentParts: [{ type: 'text', text: 'two images' }, { type: 'image', attachment: png.attachment }],
    version: 1,
  }
  const card = toolOutputText(tool, { imageRefs: 'omit' })
  assert.match(card, /legacy\.png/)
  assert.match(card, /no attachment ref; not viewable/)
  assert.doesNotMatch(card, /real\.png/, 'real ref is rendered as a marker, not duplicated text')
  const copied = toolCopyText(tool, 'output')
  assert.match(copied, /real\.png/)
  assert.match(copied, /legacy\.png/)
  assert.match(copied, /no attachment ref; not viewable/)
  assert.ok(!copied.includes('QUJD'))
})
