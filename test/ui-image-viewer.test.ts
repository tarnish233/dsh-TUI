// Must stay FIRST: forces truecolor before src modules snapshot terminal mode.
import './helpers/truecolor.ts'
import { createRequire } from 'node:module'
import { strict as assert } from 'node:assert'
import test, { beforeEach } from 'node:test'
import {
  getCapabilities,
  getCellDimensions,
  setCapabilities,
  setCellDimensions,
  stripTerminalSequences,
  visibleWidth,
} from '#pi-tui'
import { imageFixture } from './helpers/images.ts'
import { createCcKeymap, type CcKeymap } from '../src/input/index.ts'
import { asTui, createFakeTui } from '../src/input/testing/harness.ts'
import { ImageDetailsDialog } from '../src/ui/image-details.ts'
import { ImageDisplayCache, imageDisplayCache, resetImageDisplayCache } from '../src/ui/image-cache.ts'
import { IMAGE_DECODE_BUDGET, decodeImageForDisplay } from '../src/ui/image-codec.ts'
import { loadImageItem } from '../src/ui/image-loader.ts'
import type { ImageViewItem } from '../src/ui/image-view.ts'
import type { ImageAttachmentRef, ImageAttachmentValue } from '../src/backend/types.ts'

const PNG = await imageFixture('image/png', 'quadrants.png')
const JPEG = await imageFixture('image/jpeg', 'photo.jpg')

beforeEach(() => { resetImageDisplayCache() })

function item(ref: ImageAttachmentRef = PNG.attachment, key = 'occ-1'): ImageViewItem {
  return { key, label: `Image ${key}`, attachment: ref }
}

function withCapabilities<T>(images: 'kitty' | 'iterm2' | null, fn: () => Promise<T>, cells = { widthPx: 1, heightPx: 1 }): Promise<T> {
  const previousCaps = getCapabilities()
  const previousCells = getCellDimensions()
  setCapabilities({ images, trueColor: true, hyperlinks: false })
  setCellDimensions(cells)
  return fn().finally(() => {
    setCapabilities(previousCaps)
    setCellDimensions(previousCells)
  })
}

async function settle(dialog: ImageDetailsDialog): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (dialog.loadStatus !== 'loading') return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`image dialog stayed ${dialog.loadStatus}`)
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const keymap = (): CcKeymap => createCcKeymap()

/** Border/APC-aware view of the measured image body (frame chrome excluded). */
function bodyView(dialog: ImageDetailsDialog, width: number): {
  geometry: ReturnType<ImageDetailsDialog['measure']>
  lines: string[]
  body: string[]
  blankRows: number
  /** Kitty `r=` rows of the actual APC placement (0 when no graphics). */
  apcRows: number
  ipcRows: number
} {
  const geometry = dialog.measure(width)
  const lines = dialog.render(width)
  const body = lines.slice(geometry.bodyRow, geometry.bodyRow + geometry.bodyHeight)
  const isBlank = (line: string): boolean => {
    if (line.includes('\x1b_G') || line.includes('\x1b]1337;File=')) return false
    return stripTerminalSequences(line).replace(/[│┌┐└┘─]/g, '').trim() === ''
  }
  // Kitty carries the real placement size in its APC; padding rows below the
  // image are indistinguishable from placement rows, so read the geometry from
  // the native sequence instead of counting blanks.
  const apcRows = Number(/(?:^|,)r=(\d+)/.exec(lines.find(line => line.includes('\x1b_G')) ?? '')?.[1] ?? 0)
  const blankRows = body.filter(isBlank).length
  const ipcRows = lines.filter(line => line.includes('\x1b_G')).length
  return { geometry, lines, body, blankRows, apcRows, ipcRows }
}

/** Click a rendered footer action by its visible label text (frame coordinates). */
function clickLabel(dialog: ImageDetailsDialog, width: number, label: string): boolean | undefined {
  const lines = dialog.render(width)
  const row = lines.findIndex(line => stripTerminalSequences(line).includes(label))
  assert.ok(row >= 0, `${label} is rendered`)
  const plain = stripTerminalSequences(lines[row]!)
  const col = visibleWidth(plain.slice(0, plain.indexOf(label)))
  return dialog.handleMouse({
    type: 'click', button: 'left', x: col + 1, y: row,
    screenX: col + 1, screenY: row, width, height: lines.length,
    shift: false, alt: false, ctrl: false, clickCount: 1,
  })?.handled
}

test('renders real APC graphics with blank placement rows and width-safe chrome', async () => {
  await withCapabilities('kitty', async () => {
    const dialog = new ImageDetailsDialog(asTui(createFakeTui(40, 100)), {
      image: item(), keymap: keymap(), readImage: async () => PNG.value, maxHeight: 30,
      onClose: () => {},
    })
    await settle(dialog)
    assert.equal(dialog.loadStatus, 'ready')
    const view = bodyView(dialog, 40)
    const apc = view.lines.findIndex(line => line.includes('\x1b_G'))
    assert.ok(apc >= 0, 'dialog emits a real Kitty APC line')
    assert.ok(!stripTerminalSequences(view.lines[apc]!).includes('[Image:'), 'not a marker-only fallback')
    // Genuine payload: the real PNG bytes travel in the Kitty APC transmission.
    const apcLine = view.lines[apc]!
    assert.match(apcLine, /\x1b_Ga=T,f=100/)
    assert.ok(apcLine.includes(PNG.value.data.slice(32, 96)), 'APC carries the actual PNG payload')
    // The image area starts at the measured body row and occupies its budget.
    assert.equal(apc, view.geometry.bodyRow, 'graphics begin at the framed body origin')
    assert.equal(view.body.length, view.geometry.bodyHeight)
    assert.ok(view.blankRows > 0, 'blank placement rows account for the image height')
    assert.ok(view.apcRows <= view.geometry.bodyHeight, 'the declared placement fits the measured body')
    assert.equal(view.blankRows, view.geometry.bodyHeight - 1, 'the rest of the body is placement/padding rows')
    for (const line of view.lines) {
      if (line.includes('\x1b_G')) continue
      assert.ok(visibleWidth(line) <= 40, `line exceeds width: ${JSON.stringify(stripTerminalSequences(line))}`)
    }
    assert.ok(view.lines.length <= 30, 'stays inside maxHeight')
    assert.match(view.lines.map(line => stripTerminalSequences(line)).join('\n'), /Close/)
    dialog.dispose()
  })
})

test('text fallback when the terminal has no inline-image protocol', async () => {
  await withCapabilities(null, async () => {
    const dialog = new ImageDetailsDialog(asTui(createFakeTui(40, 100)), {
      image: item(), keymap: keymap(), readImage: async () => PNG.value, maxHeight: 30,
      onClose: () => {},
    })
    await settle(dialog)
    const text = dialog.render(160).map(line => stripTerminalSequences(line)).join('\n')
    assert.match(text, /\[Image:/)
    assert.match(text, /terminal cannot display inline images/)
    assert.match(text, /quadrants\.png/)
    assert.match(text, new RegExp(`id ${PNG.attachment.attachmentId}`))
    assert.doesNotMatch(text, /\x1b_G/)
    dialog.dispose()
  })
})

test('height budget follows maxHeight, falls back compactly, and never slices APC rows', async () => {
  await withCapabilities('kitty', async () => {
    let height = 40
    const options = {
      image: item(), keymap: keymap(), readImage: async () => PNG.value,
      onClose: () => {},
      get maxHeight(): number { return height },
    }
    const dialog = new ImageDetailsDialog(asTui(createFakeTui(60, 100)), options)
    await settle(dialog)
    const tall = bodyView(dialog, 40)
    assert.ok(tall.ipcRows > 0)
    assert.ok(tall.apcRows > 1, 'the APC declares the real placement rows')
    assert.equal(tall.body.length, tall.geometry.bodyHeight, 'image rows equal the measured body budget')
    const decoded = dialog.decoded
    assert.ok(decoded !== undefined)

    // Height-only shrink: compact text, close hint retained, no truncated APC.
    height = 10
    const short = dialog.render(40)
    assert.ok(short.length <= 10)
    const shortText = short.map(line => stripTerminalSequences(line)).join('\n')
    assert.doesNotMatch(shortText, /\x1b_G/)
    assert.match(shortText, /close/i)
    assert.ok(short.every(line => visibleWidth(line) <= 40))

    // Grow back: the same decoded payload paints real image rows again.
    height = 50
    const again = bodyView(dialog, 40)
    assert.ok(again.ipcRows > 0)
    assert.equal(dialog.decoded, decoded, 'decoded bytes stay cached across render-only resizes')

    // Cell-geometry change (CSI 16t) invalidates the retained instance and
    // produces fewer placement rows for the same pixel image.
    setCellDimensions({ widthPx: 1, heightPx: 18 })
    const rowsAfter = bodyView(dialog, 40)
    assert.ok(rowsAfter.ipcRows > 0)
    assert.ok(rowsAfter.apcRows > 0 && rowsAfter.apcRows < again.apcRows, 'taller cells need fewer placement rows')
    assert.ok(rowsAfter.body.length <= rowsAfter.geometry.bodyHeight)
    assert.equal(dialog.decoded, decoded)
    assert.equal(dialog.invalidate(), undefined)
    dialog.dispose()
  })
})

test('loading closes on Esc, ignores unrelated global actions, and defers interrupt to the parent', async () => {
  const pending = deferred<ImageAttachmentValue>()
  const events: string[] = []
  const dialog = new ImageDetailsDialog(asTui(createFakeTui(40, 100)), {
    image: item(), keymap: keymap(),
    readImage: () => pending.promise,
    maxHeight: 30,
    onClose: () => { events.push('close') },
    onInterrupt: () => { events.push('interrupt') },
  })
  assert.match(dialog.render(60).map(line => stripTerminalSequences(line)).join('\n'), /Loading image/)
  // app.tools.expand (ctrl+o) is a global action; it must not leak into the viewer.
  dialog.handleInput('\x0f')
  assert.deepEqual(events, [])
  assert.equal(dialog.isDisposed, false)
  // Ctrl+C is delegated whole; the parent decides busy vs idle.
  dialog.handleInput('\x03')
  assert.deepEqual(events, ['interrupt'])
  // Esc still closes while loading.
  dialog.handleInput('\x1b')
  assert.deepEqual(events, ['interrupt', 'close'])
  pending.resolve(PNG.value)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(dialog.loadStatus, 'loading', 'late result after close is not painted')
  dialog.dispose()
})

test('navigation honors the shared keymap and disables boundary moves', async () => {
  const calls: string[] = []
  let index = 1
  const dialog = new ImageDetailsDialog(asTui(createFakeTui(40, 100)), {
    image: item(), keymap: keymap(), readImage: async () => PNG.value, maxHeight: 30,
    onClose: () => { calls.push('close') },
    onInterrupt: () => { calls.push('interrupt') },
    getImageNavigation: () => ({ index, total: 3 }),
    onPreviousImage: () => { calls.push('prev') },
    onNextImage: () => { calls.push('next') },
  })
  await settle(dialog)
  const hint = dialog.render(80).map(line => stripTerminalSequences(line)).join('\n')
  assert.match(hint, /\[ previous/)
  assert.match(hint, /\] next/)
  assert.match(hint, /Escape close/i)
  dialog.handleInput('[')
  dialog.handleInput(']')
  assert.deepEqual(calls, ['prev', 'next'])
  index = 0
  dialog.handleInput('[')
  index = 2
  dialog.handleInput(']')
  assert.deepEqual(calls, ['prev', 'next'], 'boundary moves never call the parent')
  // A chord prefix is held by the shared keymap; interrupt still belongs to the parent.
  dialog.handleInput('\x18')
  dialog.handleInput('\x03')
  assert.deepEqual(calls, ['prev', 'next', 'interrupt'], 'interrupt after a pending chord still belongs to the parent')
  dialog.dispose()
})

test('reused occurrence key with changed ref reloads and stale results stay inert', async () => {
  const requests: string[] = []
  const pending = new Map<string, ReturnType<typeof deferred<ImageAttachmentValue>>>()
  const readImage = (ref: ImageAttachmentRef): Promise<ImageAttachmentValue> => {
    requests.push(ref.attachmentId)
    const entry = deferred<ImageAttachmentValue>()
    pending.set(ref.attachmentId, entry)
    return entry.promise
  }
  const other: ImageAttachmentRef = { ...JPEG.attachment, attachmentId: 'fixture:other-jpeg' }
  const dialog = new ImageDetailsDialog(asTui(createFakeTui(40, 100)), {
    image: item(PNG.attachment, 'same-key'), keymap: keymap(), readImage, maxHeight: 30,
    onClose: () => {},
  })
  // A same-key item with a new ref is a different image and must reload.
  dialog.setImage(item(other, 'same-key'))
  assert.deepEqual(requests, [PNG.attachment.attachmentId, 'fixture:other-jpeg'])
  // Resolve the abandoned first read: it must not paint and must not be cached.
  pending.get(PNG.attachment.attachmentId)!.resolve(PNG.value)
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(dialog.loadStatus, 'loading')
  assert.equal(imageDisplayCache.size, 0)
  // Dispose before the live request resolves: still inert, nothing cached.
  pending.get('fixture:other-jpeg')!.resolve({ attachment: other, data: JPEG.value.data })
  dialog.dispose()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(dialog.decoded, undefined)
  assert.equal(imageDisplayCache.size, 0)
  assert.deepEqual(dialog.render(40), [])
})

test('a live cycle decodes once and the byte cache serves the next occurrence', async () => {
  let reads = 0
  const readImage = async (ref: ImageAttachmentRef): Promise<ImageAttachmentValue> => {
    reads += 1
    return { attachment: ref, data: (await imageFixture(ref.mediaType, ref.name ?? 'x')).bytes.toString('base64') }
  }
  const first = new ImageDetailsDialog(asTui(createFakeTui(40, 100)), {
    image: item(), keymap: keymap(), readImage, maxHeight: 30, onClose: () => {},
  })
  await settle(first)
  assert.equal(first.loadStatus, 'ready')
  first.dispose()
  const second = new ImageDetailsDialog(asTui(createFakeTui(40, 100)), {
    image: item(PNG.attachment, 'occ-2'), keymap: keymap(), readImage, maxHeight: 30, onClose: () => {},
  })
  await settle(second)
  assert.equal(reads, 1, 'same full ref identity hits the display cache')
  assert.equal(imageDisplayCache.size, 1)
  second.dispose()
})

test('image decode budget, verified PNG passthrough, upload decode and invalid bytes', async () => {
  const png = await decodeImageForDisplay('image/png', PNG.value.data, IMAGE_DECODE_BUDGET, { verified: true })
  assert.equal(png.ok, true)
  if (png.ok) {
    assert.equal(png.image.transcoded, false)
    assert.equal(png.image.pngData, PNG.value.data)
    assert.equal(png.image.width, PNG.attachment.width)
  }
  // Without DSH verification the same bytes are fully decoded by sharp.
  const uploadPng = await decodeImageForDisplay('image/png', PNG.value.data)
  assert.equal(uploadPng.ok, true)
  if (uploadPng.ok) {
    assert.equal(uploadPng.image.transcoded, true)
    assert.equal(uploadPng.image.width, PNG.attachment.width)
  }
  const jpeg = await decodeImageForDisplay('image/jpeg', JPEG.value.data)
  assert.equal(jpeg.ok, true)
  if (jpeg.ok) {
    assert.equal(jpeg.image.transcoded, true)
    assert.equal(jpeg.image.sourceMediaType, 'image/jpeg')
    assert.equal(jpeg.image.pngData.slice(0, 8), PNG.value.data.slice(0, 8))
  }
  const bounded = await decodeImageForDisplay('image/jpeg', JPEG.value.data, {
    maxEncodedBytes: 1024 * 1024, maxSourcePixels: 1_000_000,
    maxEdgePx: 2, maxDecodedBytes: 1024 * 1024, maxDecodedPixels: 100,
  })
  assert.equal(bounded.ok, true)
  if (bounded.ok) assert.ok(bounded.image.width <= 2 && bounded.image.height <= 2)
  const huge = await decodeImageForDisplay('image/png', PNG.value.data, {
    maxEncodedBytes: 10, maxSourcePixels: 100, maxEdgePx: 2, maxDecodedBytes: 10, maxDecodedPixels: 10,
  })
  assert.equal(huge.ok, false)
  if (!huge.ok) assert.match(huge.reason, /display budget/)
  const invalid = await decodeImageForDisplay('image/png', Buffer.from('not-an-image').toString('base64'))
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.match(invalid.reason, /decode|could not/i)
})

test('transcoding loads the public sharp package through Node\'s CommonJS loader', async () => {
  // The native host is one process and uses the same public sharp package. The
  // ESM loader must not be asked to translate a CJS package the host may already
  // hold; resolving it with require() keeps the single cached instance.
  const require = createRequire(import.meta.url)
  const entry = require.resolve('sharp')
  assert.equal(entry.endsWith('.cjs'), true, 'the public package resolves to its CommonJS entry')
  const jpeg = await imageFixture('image/jpeg', 'cjs-loader.jpg', 128, 64)
  const result = await decodeImageForDisplay('image/jpeg', jpeg.value.data)
  assert.equal(result.ok, true)
  assert.ok(
    Object.hasOwn(require.cache, entry),
    'sharp is loaded through the CommonJS cache so the host graph is never re-translated',
  )
  assert.equal(typeof require.cache[entry]?.exports, 'function', 'the CommonJS export is the factory')
})

test('byte cache is a bounded LRU keyed by the complete ref identity', async () => {
  const cache = new ImageDisplayCache({ maxBytes: 150, maxEntries: 2 })
  const fake = (bytes: number) => ({
    pngData: '', mediaType: 'image/png' as const, sourceMediaType: 'image/png' as const,
    width: 1, height: 1, sourceWidth: 1, sourceHeight: 1, encodedBytes: bytes,
    decodedBytes: bytes, decodedPixels: 1, transcoded: false, cacheBytes: bytes,
  })
  const a = { ...PNG.attachment, attachmentId: 'a' }
  const b = { ...PNG.attachment, attachmentId: 'b' }
  const c = { ...PNG.attachment, attachmentId: 'c' }
  cache.set(a, fake(60))
  cache.set(b, fake(60))
  assert.equal(cache.size, 2)
  assert.equal(cache.get(a)?.cacheBytes, 60, 'get refreshes recency')
  cache.set(c, fake(60))
  assert.equal(cache.size, 2)
  assert.deepEqual(cache.keys(), [ImageDisplayCache.key(a), ImageDisplayCache.key(c)])
  // A changed payload of the same attachmentId is a different identity.
  const changed = { ...a, bytes: a.bytes + 1 }
  assert.equal(cache.get(changed), undefined)
  cache.clear()
  assert.equal(cache.size, 0)
  assert.match(ImageDisplayCache.key(a), new RegExp(a.attachmentId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('invalid readImage response fails cleanly and dispose never calls onClose', async () => {
  const dialog = new ImageDetailsDialog(asTui(createFakeTui(40, 100)), {
    image: item(), keymap: keymap(), maxHeight: 30, onClose: () => {},
    readImage: async () => ({ attachment: { ...PNG.attachment, bytes: PNG.attachment.bytes + 1 }, data: PNG.value.data }),
  })
  await settle(dialog)
  assert.equal(dialog.loadStatus, 'error')
  assert.match(dialog.errorReason ?? '', /invalid/i)
  dialog.dispose()
  dialog.dispose()
  assert.equal(dialog.isDisposed, true)
  assert.deepEqual(dialog.render(40), [])
})

test('frame actions click through the shared hitbox layer and tiny viewports keep close', async () => {
  await withCapabilities('kitty', async () => {
    let height = 2
    const calls: string[] = []
    let index = 1
    const dialog = new ImageDetailsDialog(asTui(createFakeTui(40, 100)), {
      image: item(), keymap: keymap(), readImage: async () => PNG.value,
      onClose: () => { calls.push('close') },
      getImageNavigation: () => ({ index, total: 3 }),
      onPreviousImage: () => { calls.push('prev') },
      onNextImage: () => { calls.push('next') },
      get maxHeight(): number { return height },
    })
    await settle(dialog)
    const tiny = dialog.render(60)
    assert.ok(tiny.length <= 2)
    assert.match(tiny.map(line => stripTerminalSequences(line)).join('\n'), /close/i)
    assert.ok(!tiny.some(line => line.includes('\x1b_G')))

    height = 40
    assert.ok(clickLabel(dialog, 60, 'Next'))
    assert.ok(clickLabel(dialog, 60, 'Prev'))
    assert.deepEqual(calls, ['next', 'prev'])

    // Boundary: the disabled Prev chip has no hitbox at all.
    index = 0
    dialog.render(60)
    assert.equal(clickLabel(dialog, 60, 'Prev'), undefined)
    assert.notEqual(clickLabel(dialog, 60, 'Next'), undefined)
    assert.ok(clickLabel(dialog, 60, 'Close'))
    assert.deepEqual(calls, ['next', 'prev', 'next', 'close'])
    dialog.dispose()
  })
})

test('unverified PNG headers, broken chunks and missing IDAT/IEND never become Ready', async () => {
  const pngBytes = PNG.bytes
  const truncatedHeader = pngBytes.subarray(0, 24)
  const ihdrOnly = pngBytes.subarray(0, 33)
  const badChunkLength = Buffer.from(pngBytes)
  badChunkLength.writeUInt32BE(0x7fffffff, 8)
  const brokenIdat = Buffer.from(pngBytes)
  const idat = brokenIdat.indexOf(Buffer.from('IDAT'))
  assert.ok(idat > 0)
  brokenIdat[idat + 8] = brokenIdat[idat + 8]! ^ 0xff
  for (const [name, bytes] of [
    ['24-byte IHDR', truncatedHeader],
    ['complete IHDR without IDAT/IEND', ihdrOnly],
    ['invalid chunk length', badChunkLength],
    ['corrupt IDAT', brokenIdat],
  ] as const) {
    const result = await decodeImageForDisplay('image/png', Buffer.from(bytes).toString('base64'))
    assert.equal(result.ok, false, `${name} must fail`)
    if (!result.ok) assert.ok(result.reason.length > 0)
  }
})

test('all display budgets apply to the PNG fast path and to cache hits', async () => {
  const strictBytes = { ...IMAGE_DECODE_BUDGET, maxDecodedBytes: 1 }
  for (const verified of [true, false]) {
    const tooBig = await decodeImageForDisplay('image/png', PNG.value.data, strictBytes, { verified })
    assert.equal(tooBig.ok, false, `maxDecodedBytes must bind (verified=${verified})`)
    if (!tooBig.ok) assert.match(tooBig.reason, /budget/i)
  }
  // A cache entry decoded under a larger budget cannot satisfy a stricter one.
  const cache = new ImageDisplayCache()
  const entry = { key: 'cache-budget', label: 'Image', attachment: PNG.attachment }
  const first = await loadImageItem(entry, { readImage: async () => PNG.value, cache })
  assert.equal(first.ok, true)
  assert.equal(cache.size, 1)
  let reads = 0
  const second = await loadImageItem(entry, {
    cache,
    budget: strictBytes,
    readImage: async () => { reads += 1; return PNG.value },
  })
  assert.equal(reads, 1, 'stricter budget forces a fresh verified read')
  assert.equal(second.ok, false)
  assert.equal(cache.size, 0)
})

test('same key with new display metadata refreshes chrome without re-reading bytes', async () => {
  let reads = 0
  const readImage = async (ref: ImageAttachmentRef): Promise<ImageAttachmentValue> => {
    reads += 1
    return { attachment: ref, data: PNG.value.data }
  }
  const dialog = new ImageDetailsDialog(asTui(createFakeTui(40, 120)), {
    image: item(PNG.attachment, 'meta'), keymap: keymap(), readImage, maxHeight: 30, onClose: () => {},
  })
  await settle(dialog)
  const decoded = dialog.decoded
  assert.ok(decoded !== undefined)
  const renamed: ImageAttachmentRef = {
    ...PNG.attachment,
    name: 'renamed.png',
    originalDimensions: { width: 128, height: 64 },
  }
  dialog.setImage({ key: 'meta', label: 'Image renamed', attachment: renamed })
  assert.equal(reads, 1, 'metadata-only change never re-reads bytes')
  assert.equal(dialog.decoded, decoded, 'decoded payload is reused')
  const text = dialog.render(120).map(line => stripTerminalSequences(line)).join('\n')
  assert.match(text, /Image renamed/)
  assert.match(text, /renamed\.png/)
  assert.match(text, /original 128×64/)
  dialog.dispose()
})

test('decode observes abort and does not start another ladder step', async () => {
  const big = await imageFixture('image/jpeg', 'big.jpg', 512, 512)
  const controller = new AbortController()
  const promise = decodeImageForDisplay('image/jpeg', big.value.data, IMAGE_DECODE_BUDGET, {
    signal: controller.signal,
  })
  queueMicrotask(() => controller.abort())
  await assert.rejects(promise, error => (error as Error).name === 'AbortError')
  const preAborted = new AbortController()
  preAborted.abort()
  await assert.rejects(
    decodeImageForDisplay('image/png', PNG.value.data, IMAGE_DECODE_BUDGET, { signal: preAborted.signal }),
    error => (error as Error).name === 'AbortError',
  )
})

// ---------------------------------------------------------------------------
// Preview display preference (renderer-only)

test('text preview never reads/decodes on open and keeps ref identity', async () => {
  await withCapabilities('kitty', async () => {
    let reads = 0
    const dialog = new ImageDetailsDialog(asTui(createFakeTui(40, 100)), {
      image: item(), keymap: keymap(), maxHeight: 24, onClose: () => {},
      preview: 'text',
      readImage: async () => { reads += 1; return PNG.value },
    })
    assert.equal(reads, 0, 'constructing in text mode must not read the image')
    assert.equal(dialog.loadStatus, 'text')
    assert.equal(dialog.preview, 'text')
    const view = bodyView(dialog, 200)
    assert.equal(view.ipcRows, 0, 'no graphics sequence in text preview')
    const text = view.lines.map(line => stripTerminalSequences(line)).join('\n')
    assert.match(text, /Text preview/)
    assert.match(text, /quadrants\.png/)
    assert.match(text, new RegExp(`id ${PNG.attachment.attachmentId}`))
    assert.equal(
      dialog.currentImage.attachment?.attachmentId,
      PNG.attachment.attachmentId,
      'the occurrence/ref identity is unchanged',
    )
    assert.equal(dialog.decoded, undefined)
    assert.equal(reads, 0)
    dialog.dispose()
  })
})

test('switching to text aborts and tombstones a pending read; late bytes stay inert', async () => {
  await withCapabilities('kitty', async () => {
    const pending = deferred<ImageAttachmentValue>()
    const signals: AbortSignal[] = []
    let reads = 0
    const dialog = new ImageDetailsDialog(asTui(createFakeTui(40, 100)), {
      image: item(), keymap: keymap(), maxHeight: 24, onClose: () => {},
      readImage: (ref, signal) => {
        reads += 1
        if (signal !== undefined) signals.push(signal)
        void ref
        return pending.promise
      },
    })
    assert.equal(reads, 1)
    dialog.setPreview('text')
    assert.equal(dialog.loadStatus, 'text')
    assert.equal(signals[0]?.aborted, true, 'the pending read is aborted')
    pending.resolve(PNG.value)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(dialog.loadStatus, 'text', 'late bytes never become ready in text mode')
    assert.equal(dialog.decoded, undefined)
    assert.equal(imageDisplayCache.size, 0, 'an abandoned read is never cached')
    assert.equal(reads, 1)
    assert.equal(bodyView(dialog, 60).ipcRows, 0)
    dialog.dispose()
  })
})

test('preview toggle clicks and the p binding share one mode switch without extra reads', async () => {
  await withCapabilities('kitty', async () => {
    let reads = 0
    const persisted: string[] = []
    const dialog = new ImageDetailsDialog(asTui(createFakeTui(40, 100)), {
      image: item(), keymap: keymap(), maxHeight: 24, onClose: () => {},
      readImage: async () => { reads += 1; return PNG.value },
      setPreview: value => { persisted.push(value) },
    })
    await settle(dialog)
    assert.equal(reads, 1)
    assert.equal(dialog.loadStatus, 'ready')
    const decoded = dialog.decoded
    assert.ok(decoded !== undefined)

    // Clicking the frame action persists + applies text mode immediately.
    assert.ok(clickLabel(dialog, 80, 'Text only'))
    assert.deepEqual(persisted, ['text'])
    assert.equal(dialog.loadStatus, 'text')
    assert.equal(bodyView(dialog, 80).ipcRows, 0)
    assert.equal(dialog.decoded, decoded, 'decoded payload is retained, not discarded')

    // The real key binding (p) switches back and reuses bytes: no second read.
    assert.deepEqual(createCcKeymap().getBindings('image.details.toggle-preview'), ['p'])
    dialog.handleInput('p')
    assert.deepEqual(persisted, ['text', 'auto'])
    assert.equal(dialog.loadStatus, 'ready')
    assert.equal(reads, 1, 'switching back never re-reads the decoded occurrence')
    assert.ok(bodyView(dialog, 80).ipcRows > 0)
    dialog.dispose()
  })
})

test('preview binding remaps/disables while the unbound capability stays clickable', async () => {
  await withCapabilities('kitty', async () => {
    const remapped = new ImageDetailsDialog(asTui(createFakeTui(40, 100)), {
      image: item(), keymap: createCcKeymap({ bindings: { 'image.details.toggle-preview': 'x' } }),
      maxHeight: 24, onClose: () => {}, readImage: async () => PNG.value,
    })
    await settle(remapped)
    remapped.handleInput('p')
    assert.equal(remapped.preview, 'auto', 'the old key no longer toggles')
    remapped.handleInput('x')
    assert.equal(remapped.preview, 'text')
    remapped.dispose()

    const disabled = new ImageDetailsDialog(asTui(createFakeTui(40, 100)), {
      image: item(), keymap: createCcKeymap({ bindings: { 'image.details.toggle-preview': null } }),
      maxHeight: 24, onClose: () => {}, readImage: async () => PNG.value,
    })
    await settle(disabled)
    assert.equal(disabled.preview, 'auto')
    disabled.handleInput('p')
    assert.equal(disabled.preview, 'auto')
    // No fake key label, but the capability remains a clickable action.
    const lines = disabled.render(80).map(line => stripTerminalSequences(line))
    const footer = lines.find(line => line.includes('Text only'))
    assert.ok(footer !== undefined)
    assert.doesNotMatch(footer, /\bp Text only|p  *Text only/)
    assert.ok(clickLabel(disabled, 80, 'Text only'))
    assert.equal(disabled.preview, 'text')
    disabled.dispose()
  })
})

test('text mode never reads a newly selected occurrence and keeps its metadata', async () => {
  await withCapabilities('kitty', async () => {
    const jpegReads: string[] = []
    const other: ImageAttachmentRef = { ...JPEG.attachment, attachmentId: 'fixture:other-jpeg' }
    const dialog = new ImageDetailsDialog(asTui(createFakeTui(40, 100)), {
      image: item(), keymap: keymap(), maxHeight: 24, onClose: () => {},
      preview: 'text',
      readImage: async ref => {
        jpegReads.push(ref.attachmentId)
        return { attachment: ref, data: JPEG.value.data }
      },
    })
    dialog.setImage({ key: 'occ-2', label: 'Second occurrence', attachment: other })
    assert.deepEqual(jpegReads, [], 'text preview never reads a new occurrence')
    assert.equal(dialog.loadStatus, 'text')
    assert.equal(dialog.currentImage.key, 'occ-2')
    const text = dialog.render(100).map(line => stripTerminalSequences(line)).join('\n')
    assert.match(text, /Second occurrence/)
    assert.match(text, /photo\.jpg/)
    assert.match(text, new RegExp(`id ${other.attachmentId}`))
    dialog.dispose()
  })
})

test('a pressed image action never fires for a different occurrence or preview mode', async () => {
  await withCapabilities('kitty', async () => {
    const pending = deferred<ImageAttachmentValue>()
    const other: ImageAttachmentRef = { ...JPEG.attachment, attachmentId: 'fixture:other-jpeg' }
    const dialog = new ImageDetailsDialog(asTui(createFakeTui(40, 100)), {
      image: item(), keymap: keymap(), maxHeight: 24, onClose: () => {},
      readImage: () => pending.promise,
    })
    const lines = dialog.render(80)
    const row = lines.findIndex(line => stripTerminalSequences(line).includes('Text only'))
    assert.ok(row >= 0)
    const plain = stripTerminalSequences(lines[row]!)
    const col = visibleWidth(plain.slice(0, plain.indexOf('Text only')))
    const press = dialog.handleMouse({
      type: 'press', button: 'left', x: col + 1, y: row, screenX: col + 1, screenY: row,
      width: 80, height: lines.length, shift: false, alt: false, ctrl: false,
    })
    assert.equal(press?.handled, true)
    // The occurrence changes between press and release; the repaint that the
    // host schedules for setImage publishes the new owner identity.
    dialog.setImage({ key: 'occ-2', label: 'Other', attachment: other })
    dialog.render(80)
    const click = dialog.handleMouse({
      type: 'click', button: 'left', x: col + 1, y: row, screenX: col + 1, screenY: row,
      width: 80, height: lines.length, shift: false, alt: false, ctrl: false, clickCount: 1,
    })
    assert.equal(click?.handled, true)
    assert.equal(dialog.preview, 'auto', 'the stale press cannot toggle the new occurrence')
    assert.equal(dialog.currentImage.key, 'occ-2')
    dialog.dispose()
  })
})

test('live parent preference changes apply through invalidate/refreshPreview', async () => {
  await withCapabilities('kitty', async () => {
    let preference: 'auto' | 'text' = 'auto'
    let reads = 0
    const options = {
      image: item(), keymap: keymap(), maxHeight: 24, onClose: () => {},
      readImage: async () => { reads += 1; return PNG.value },
      get preview(): 'auto' | 'text' { return preference },
    }
    const dialog = new ImageDetailsDialog(asTui(createFakeTui(40, 100)), options)
    await settle(dialog)
    assert.equal(reads, 1)
    const decoded = dialog.decoded

    preference = 'text'
    dialog.refreshPreview()
    assert.equal(dialog.loadStatus, 'text')
    assert.equal(bodyView(dialog, 80).ipcRows, 0)
    assert.equal(dialog.decoded, decoded)

    preference = 'auto'
    dialog.invalidate()
    assert.equal(dialog.loadStatus, 'ready')
    assert.equal(reads, 1, 'the cached decode is reused')
    assert.ok(bodyView(dialog, 80).ipcRows > 0)
    dialog.dispose()
  })
})
