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

test('renders real APC graphics with blank placement rows and width-safe chrome', async () => {
  await withCapabilities('kitty', async () => {
    const dialog = new ImageDetailsDialog(asTui(createFakeTui(40, 100)), {
      image: item(), keymap: keymap(), readImage: async () => PNG.value, maxHeight: 30,
      onClose: () => {},
    })
    await settle(dialog)
    assert.equal(dialog.loadStatus, 'ready')
    const lines = dialog.render(40)
    const apc = lines.findIndex(line => line.includes('\x1b_G'))
    assert.ok(apc >= 0, 'dialog emits a real Kitty APC line')
    assert.ok(!stripTerminalSequences(lines[apc]!).includes('[Image:'), 'not a marker-only fallback')
    // Kitty: APC line followed by one empty line per additional pixel row.
    let blanks = 0
    for (let index = apc + 1; index < lines.length && lines[index] === ''; index += 1) blanks += 1
    assert.ok(blanks > 0, 'blank placement rows account for the image height')
    for (const line of lines) {
      if (line.includes('\x1b_G')) continue
      assert.ok(visibleWidth(line) <= 40, `line exceeds width: ${JSON.stringify(stripTerminalSequences(line))}`)
    }
    assert.ok(lines.length <= 30, 'stays inside maxHeight')
    assert.match(lines.map(line => stripTerminalSequences(line)).join('\n'), /Close/)
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
    const tall = dialog.render(40)
    assert.ok(tall.some(line => line.includes('\x1b_G')))
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
    const again = dialog.render(40)
    assert.ok(again.some(line => line.includes('\x1b_G')))
    assert.equal(dialog.decoded, decoded, 'decoded bytes stay cached across render-only resizes')

    // Cell-geometry change (CSI 16t) invalidates the retained instance and
    // produces a new row count instead of the old pixel-per-cell frame.
    setCellDimensions({ widthPx: 1, heightPx: 18 })
    const tallCells = again.filter(line => line.includes('\x1b_G')).length
    const rowsAfter = dialog.render(40)
    assert.ok(rowsAfter.some(line => line.includes('\x1b_G')))
    assert.ok(rowsAfter.filter(line => line === '').length < again.filter(line => line === '').length)
    assert.equal(dialog.decoded, decoded)
    void tallCells
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

test('header controls click through the hitbox layer and tiny viewports keep close', async () => {
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
    const lines = dialog.render(60)
    const plain = lines.map(line => stripTerminalSequences(line))
    const row = plain.findIndex(line => line.includes('[‹ Prev]') && line.includes('[Next ›]') && line.includes('[Close]'))
    assert.ok(row >= 0, plain.join('\n'))
    const click = (label: string) => {
      const col = plain[row]!.indexOf(label)
      assert.ok(col >= 0)
      return dialog.handleMouse({
        type: 'click', button: 'left', x: col + 1, y: row,
        screenX: col + 1, screenY: row, width: 60, height: lines.length,
        shift: false, alt: false, ctrl: false, clickCount: 1,
      })
    }
    assert.ok(click('Next')?.handled)
    assert.ok(click('Prev')?.handled)
    assert.deepEqual(calls, ['next', 'prev'])
    index = 0
    // Re-render so the hitboxes reflect the new boundary state.
    dialog.render(60)
    const currentPlain = dialog.render(60).map(line => stripTerminalSequences(line))
    const currentRow = currentPlain.findIndex(line => line.includes('[‹ Prev]'))
    assert.ok(currentRow >= 0)
    // Disabled boundary control has no hitbox.
    const disabled = dialog.handleMouse({
      type: 'click', button: 'left', x: currentPlain[currentRow]!.indexOf('Prev') + 1, y: currentRow,
      screenX: 0, screenY: 0, width: 60, height: 40,
      shift: false, alt: false, ctrl: false, clickCount: 1,
    })
    assert.equal(disabled, undefined)
    assert.ok(click('Close')?.handled)
    assert.deepEqual(calls, ['next', 'prev', 'close'])
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
