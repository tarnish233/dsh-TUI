/**
 * Lazy, abortable loading of one image occurrence for the details viewer.
 *
 * Only an explicit viewer request reaches this module: transcript markers,
 * folded groups and streaming tokens never call `readImage`. The cache is
 * keyed by the complete ref identity and holds display-ready PNG bytes only.
 *
 * A disposed/aborted viewer must not be mutated by a late result. The loader
 * therefore checks the signal *after* every await and refuses to cache bytes
 * that arrived for an abandoned request; the dialog additionally guards with
 * its own request generation.
 */
import type { ImageAttachmentRef } from '../backend/types.ts'
import { imageAttachmentValue } from '../attachments.ts'
import type { ImageViewItem, ReadImageAttachment } from './image-view.ts'
import {
  IMAGE_DECODE_BUDGET,
  decodeImageForDisplay,
  imageWithinBudget,
  type ImageDecodeBudget,
  type ImageDecodeResult,
} from './image-codec.ts'
import { ImageDisplayCache, imageDisplayCache } from './image-cache.ts'

/** The request was superseded or the viewer was disposed; render nothing. */
export class ImageLoadAborted extends Error {
  constructor() {
    super('Image loading was cancelled.')
    this.name = 'AbortError'
  }
}

export interface LoadImageOptions {
  readonly readImage?: ReadImageAttachment
  readonly signal?: AbortSignal
  readonly cache?: ImageDisplayCache
  readonly budget?: ImageDecodeBudget
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

/**
 * Load one viewer item: uploads decode their in-memory data; attachments go
 * through the supplied `Backend.readImage` and the verified-byte cache.
 */
export async function loadImageItem(
  item: ImageViewItem,
  options: LoadImageOptions = {},
): Promise<ImageDecodeResult> {
  throwIfAborted(options.signal)
  if (item.attachment !== undefined) return loadAttachment(item.attachment, item.key, options)
  // Upload bytes were never verified by DSH: always do a real decode.
  const result = await decodeUpload(item, options)
  throwIfAborted(options.signal)
  return result
}

async function loadAttachment(
  attachment: ImageAttachmentRef,
  _key: string,
  options: LoadImageOptions,
): Promise<ImageDecodeResult> {
  const cache = options.cache ?? imageDisplayCache
  const budget = options.budget ?? IMAGE_DECODE_BUDGET
  const cached = cache.get(attachment)
  if (cached !== undefined) {
    throwIfAborted(options.signal)
    // A cached frame decoded under a larger budget must not bypass the current
    // one: drop it and re-read/decode against this request's limits.
    if (imageWithinBudget(cached, budget)) return { ok: true, image: cached }
    cache.delete(attachment)
  }
  const readImage = options.readImage
  if (readImage === undefined) {
    return { ok: false, reason: 'This session cannot read image attachments.' }
  }
  let value
  try {
    value = await readImage(attachment, options.signal)
  } catch (error) {
    if (options.signal?.aborted === true || isAbortError(error)) throw new ImageLoadAborted()
    return { ok: false, reason: `Could not read the image (${errorText(error)}).` }
  }
  // A result that arrives after the viewer closed/session switched is inert:
  // it is not decoded, not cached and never painted.
  throwIfAborted(options.signal)
  let verified
  try {
    // Validates the response against the exact ref that was requested.
    verified = imageAttachmentValue(value, attachment)
  } catch (error) {
    return { ok: false, reason: `The image response was invalid (${errorText(error)}).` }
  }
  let result: ImageDecodeResult
  try {
    result = await decodeImageForDisplay(
      verified.attachment.mediaType,
      verified.data,
      budget,
      { verified: true, ...(options.signal === undefined ? {} : { signal: options.signal }) },
    )
  } catch (error) {
    if (options.signal?.aborted === true || isAbortError(error)) throw new ImageLoadAborted()
    return { ok: false, reason: `The image could not be prepared (${errorText(error)}).` }
  }
  throwIfAborted(options.signal)
  if (result.ok) cache.set(verified.attachment, result.image)
  return result
}

async function decodeUpload(item: ImageViewItem, options: LoadImageOptions): Promise<ImageDecodeResult> {
  if (item.upload === undefined) return { ok: false, reason: 'The image has no payload.' }
  try {
    return await decodeImageForDisplay(
      item.upload.mediaType,
      item.upload.data,
      options.budget ?? IMAGE_DECODE_BUDGET,
      { verified: false, ...(options.signal === undefined ? {} : { signal: options.signal }) },
    )
  } catch (error) {
    if (options.signal?.aborted === true || isAbortError(error)) throw new ImageLoadAborted()
    return { ok: false, reason: `The image could not be prepared (${errorText(error)}).` }
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ImageLoadAborted()
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim()
}
