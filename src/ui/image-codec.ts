/**
 * Display-only image preparation.
 *
 * The renderer can only place PNG bytes reliably (Kitty accepts PNG; iTerm2
 * accepts PNG/JPEG but the dialog standardizes on PNG). DSH's own image
 * admission/model limits are irrelevant here: this module applies an explicit
 * *display* budget only, and it never mutates or replaces the canonical
 * attachment ref/data.
 *
 * Work happens once per loaded image, before the first frame that shows it:
 *   - a PNG inside the budget is passed through untouched (no decode);
 *   - JPEG/GIF/WebP and oversized PNGs are rotated (EXIF), downscaled and
 *     re-encoded to PNG through sharp's public asynchronous API;
 *   - anything outside the budget fails with a readable reason instead of
 *     blocking the event loop or reserving rows nobody can paint.
 *
 * Nothing here runs inside `render()`: the dialog awaits this while it shows
 * its loading state.
 */
import { createRequire } from 'node:module'
import type { ImageMediaType } from '../backend/types.ts'

/** Explicit renderer budget; intentionally independent from DSH model limits. */
export interface ImageDecodeBudget {
  /** Largest accepted encoded attachment payload (base64-decoded bytes). */
  readonly maxEncodedBytes: number
  /** Largest accepted source pixel count, enforced before decoding. */
  readonly maxSourcePixels: number
  /** Longest edge of the PNG handed to the terminal renderer. */
  readonly maxEdgePx: number
  /** Largest accepted decoded PNG payload. */
  readonly maxDecodedBytes: number
  /** Largest decoded pixel footprint kept in the display cache. */
  readonly maxDecodedPixels: number
}

export const IMAGE_DECODE_BUDGET: ImageDecodeBudget = {
  maxEncodedBytes: 16 * 1024 * 1024,
  maxSourcePixels: 40_000_000,
  maxEdgePx: 2048,
  maxDecodedBytes: 8 * 1024 * 1024,
  maxDecodedPixels: 8_000_000,
}

/** One display-ready PNG plus the metadata the dialog reports. */
export interface DisplayImage {
  /** Base64 PNG handed to Pi TUI's public `Image` component. */
  readonly pngData: string
  readonly mediaType: 'image/png'
  /** Declared wire media type of the source ref/upload. */
  readonly sourceMediaType: ImageMediaType
  readonly width: number
  readonly height: number
  readonly sourceWidth: number
  readonly sourceHeight: number
  /** Original encoded attachment size, when known. */
  readonly encodedBytes: number
  /** Byte length of the PNG payload above. */
  readonly decodedBytes: number
  readonly decodedPixels: number
  /** True when the bytes were rotated/resized/re-encoded. */
  readonly transcoded: boolean
  /** Approximate resident cost used by the byte cache. */
  readonly cacheBytes: number
}

export type ImageDecodeResult =
  | { readonly ok: true; readonly image: DisplayImage }
  | { readonly ok: false; readonly reason: string }

export interface ImageDecodeOptions {
  /**
   * True only for bytes already verified by DSH's own `readImage`, where an
   * encoded PNG can be trusted and passed through. Uploads/default exports must
   * leave this false: a partial/truncated PNG header is not an image.
   */
  readonly verified?: boolean
  readonly signal?: AbortSignal
}

/** Does a display-ready image still satisfy the caller's resource budget? */
export function imageWithinBudget(image: DisplayImage, budget: ImageDecodeBudget): boolean {
  return image.encodedBytes <= budget.maxEncodedBytes &&
    image.decodedBytes <= budget.maxDecodedBytes &&
    image.decodedPixels <= budget.maxDecodedPixels &&
    Math.max(image.width, image.height) <= budget.maxEdgePx
}

function abortError(): Error {
  const error = new Error('Image decoding was cancelled.')
  error.name = 'AbortError'
  return error
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError()
}

/**
 * Bound concurrent native decodes. An aborted waiter is removed before it can
 * start work; a decode already inside native sharp finishes and is discarded by
 * the caller (sharp cannot be interrupted mid-operation).
 */
const MAX_CONCURRENT_DECODES = 2
let activeDecodes = 0
const decodeWaiters: Array<() => void> = []

async function withDecodeSlot<T>(signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  throwIfAborted(signal)
  if (activeDecodes >= MAX_CONCURRENT_DECODES) {
    await new Promise<void>((resolve, reject) => {
      const start = (): void => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      }
      const onAbort = (): void => {
        const index = decodeWaiters.indexOf(start)
        if (index >= 0) decodeWaiters.splice(index, 1)
        reject(abortError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      decodeWaiters.push(start)
    })
  }
  throwIfAborted(signal)
  activeDecodes += 1
  try {
    return await work()
  } finally {
    activeDecodes -= 1
    const next = decodeWaiters.shift()
    next?.()
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)
}

/** PNG IHDR dimensions; no decode, no dependency. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (!isPng(bytes) || bytes.length < 24) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(12) !== 0x49484452) return undefined
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (width <= 0 || height <= 0) return undefined
  return { width, height }
}

function base64Bytes(data: string): Buffer | undefined {
  if (typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0) return undefined
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return undefined
  const bytes = Buffer.from(data, 'base64')
  return bytes.length === 0 || bytes.toString('base64') !== data ? undefined : bytes
}

const errorText = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim()

/**
 * Load sharp lazily: a text-only session never pays for the native addon.
 *
 * The native host is one process, and DSH itself uses the same public package,
 * so sharp may already be in Node's CommonJS cache before this module is
 * evaluated. Resolving the public package through Node's CommonJS loader keeps
 * that single cached instance instead of asking the ESM loader to translate a
 * CJS package the host already required (which is where a native host's CJS/ESM
 * hand-off can assert). No path, cache or resolver is patched here.
 */
const requireFromHere = createRequire(import.meta.url)
let sharpLoader: Promise<typeof import('sharp').default> | undefined

/** The public CJS entry exports the factory itself; interop objects are tolerated. */
function sharpFactoryFromCjs(): typeof import('sharp').default {
  const loaded: unknown = requireFromHere('sharp')
  if (typeof loaded === 'function') return loaded as typeof import('sharp').default
  if (loaded !== null && typeof loaded === 'object' && 'default' in loaded) {
    const candidate: unknown = (loaded as { default: unknown }).default
    if (typeof candidate === 'function') return candidate as typeof import('sharp').default
  }
  throw new TypeError('The public sharp package did not expose a factory function.')
}

async function loadSharp(): Promise<typeof import('sharp').default> {
  // Kept async and memoized: the addon never loads during module evaluation, and
  // concurrent decoders share one attempt (and one rejection).
  sharpLoader ??= Promise.resolve().then(sharpFactoryFromCjs)
  return sharpLoader
}

/**
 * Prepare image bytes for display.
 *
 * `mediaType` is the declared wire type. Only bytes already verified by DSH's
 * `readImage` may use the PNG header fast path; uploads and other callers are
 * fully decoded by sharp before anything is declared ready. All resource
 * budgets (encoded, decoded bytes/pixels, edge) apply to the pass-through too;
 * anything that does not fit is transcoded or clearly rejected.
 */
export async function decodeImageForDisplay(
  mediaType: ImageMediaType,
  data: string,
  budget: ImageDecodeBudget = IMAGE_DECODE_BUDGET,
  options: ImageDecodeOptions = {},
): Promise<ImageDecodeResult> {
  throwIfAborted(options.signal)
  const bytes = base64Bytes(data)
  if (bytes === undefined) return { ok: false, reason: 'The image payload is not valid base64.' }
  if (bytes.byteLength > budget.maxEncodedBytes) {
    return { ok: false, reason: `The image is larger than the ${formatLimit(budget.maxEncodedBytes)} display budget.` }
  }

  // Trusted fast path only: DSH verified these exact bytes. Every budget still
  // applies, including the PNG payload/decoded byte ceiling.
  if (options.verified === true && mediaType === 'image/png' && isPng(bytes)) {
    const dimensions = pngDimensions(bytes)
    if (dimensions !== undefined) {
      const pixels = dimensions.width * dimensions.height
      if (pixels > budget.maxSourcePixels) {
        return { ok: false, reason: `The PNG is too large to decode (${dimensions.width}×${dimensions.height}).` }
      }
      if (Math.max(dimensions.width, dimensions.height) <= budget.maxEdgePx &&
          pixels <= budget.maxDecodedPixels &&
          bytes.byteLength <= budget.maxDecodedBytes) {
        return {
          ok: true,
          image: {
            pngData: data,
            mediaType: 'image/png',
            sourceMediaType: mediaType,
            width: dimensions.width,
            height: dimensions.height,
            sourceWidth: dimensions.width,
            sourceHeight: dimensions.height,
            encodedBytes: bytes.byteLength,
            decodedBytes: bytes.byteLength,
            decodedPixels: pixels,
            transcoded: false,
            cacheBytes: bytes.byteLength + pixels * 4,
          },
        }
      }
      // Falls through to a real decode/shrink: a header never proves validity,
      // and a pass-through that breaks a budget must not be reported as ready.
    }
  }

  return transcodeToPng(bytes, mediaType, budget, options.signal)
}

async function transcodeToPng(
  bytes: Buffer,
  mediaType: ImageMediaType,
  budget: ImageDecodeBudget,
  signal: AbortSignal | undefined,
): Promise<ImageDecodeResult> {
  let sharp: typeof import('sharp').default
  try {
    sharp = await loadSharp()
  } catch (error) {
    return { ok: false, reason: `Image transcoding is unavailable (${errorText(error)}).` }
  }
  throwIfAborted(signal)

  try {
    return await withDecodeSlot(signal, async () => {
      const probe = sharp(bytes, {
        animated: false,
        failOn: 'error',
        limitInputPixels: budget.maxSourcePixels,
      })
      const meta = await probe.metadata()
      throwIfAborted(signal)
      if (meta.format === undefined) return { ok: false, reason: 'The image format could not be identified.' }
      const supported = new Set(['png', 'jpeg', 'webp', 'gif'])
      if (!supported.has(meta.format)) {
        return { ok: false, reason: `The image format (${meta.format}) is not supported for display.` }
      }
      const sourceWidth = meta.width ?? 0
      const sourceHeight = meta.pageHeight ?? meta.height ?? 0
      if (sourceWidth <= 0 || sourceHeight <= 0) {
        return { ok: false, reason: 'The image has no usable dimensions.' }
      }
      if (sourceWidth * sourceHeight > budget.maxSourcePixels) {
        return { ok: false, reason: `The image is too large to decode (${sourceWidth}×${sourceHeight}).` }
      }

      // Respect both an edge and a total-pixel ceiling (square worst case).
      const pixelEdge = Math.floor(Math.sqrt(budget.maxDecodedPixels))
      let edge = Math.max(1, Math.min(budget.maxEdgePx, pixelEdge, Math.max(sourceWidth, sourceHeight)))
      for (let attempt = 0; attempt < 3; attempt += 1) {
        // A cancelled request never starts another compression-ladder step.
        throwIfAborted(signal)
        const output = await sharp(bytes, {
          animated: false,
          failOn: 'error',
          limitInputPixels: budget.maxSourcePixels,
        })
          .rotate()
          .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
          .png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
          .toBuffer({ resolveWithObject: true })
        // The native work above cannot be interrupted; if the viewer went away
        // while it ran, its result is dropped here instead of retried/cached.
        throwIfAborted(signal)
        const width = output.info.width
        const height = output.info.height
        const pixels = width * height
        if (pixels > budget.maxDecodedPixels || width > budget.maxEdgePx || height > budget.maxEdgePx) {
          edge = Math.max(1, Math.floor(edge * 0.75))
          continue
        }
        if (output.data.byteLength > budget.maxDecodedBytes) {
          edge = Math.max(1, Math.floor(edge * 0.75))
          continue
        }
        return {
          ok: true,
          image: {
            pngData: output.data.toString('base64'),
            mediaType: 'image/png',
            sourceMediaType: mediaType,
            width,
            height,
            sourceWidth,
            sourceHeight,
            encodedBytes: bytes.byteLength,
            decodedBytes: output.data.byteLength,
            decodedPixels: pixels,
            transcoded: true,
            cacheBytes: output.data.byteLength + pixels * 4,
          },
        }
      }
      return { ok: false, reason: 'The decoded image exceeds the display decode budget.' }
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    return { ok: false, reason: `The image could not be decoded (${errorText(error)}).` }
  }
}

function formatLimit(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(0)} MB` : `${Math.round(bytes / 1024)} KB`
}
