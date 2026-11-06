/**
 * Bounded, ephemeral cache of display-ready image bytes.
 *
 * Identity is the complete canonical ref (attachmentId + mediaType + bytes +
 * dimensions) through `imageAttachmentKey`: a different verified payload can
 * never hit an old entry. This is a display cache, not an attachment store and
 * not a persistence layer; clearing it costs one decode.
 *
 * The budget is byte-based (PNG payload + RGBA footprint) with an entry cap,
 * so a session that shows many images cannot grow without bound.
 */
import type { ImageAttachmentRef } from '../backend/types.ts'
import { imageAttachmentKey } from '../attachments.ts'
import type { DisplayImage } from './image-codec.ts'

export interface ImageDisplayCacheOptions {
  /** Maximum sum of `DisplayImage.cacheBytes` kept resident. */
  readonly maxBytes?: number
  /** Maximum number of cached images. */
  readonly maxEntries?: number
}

const DEFAULT_MAX_BYTES = 48 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 24

export class ImageDisplayCache {
  private readonly entries = new Map<string, DisplayImage>()
  private readonly maxBytes: number
  private readonly maxEntries: number
  private residentBytes = 0

  constructor(options: ImageDisplayCacheOptions = {}) {
    this.maxBytes = Math.max(1, Math.floor(options.maxBytes ?? DEFAULT_MAX_BYTES))
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES))
  }

  static key(ref: ImageAttachmentRef): string {
    return imageAttachmentKey(ref)
  }

  get(ref: ImageAttachmentRef): DisplayImage | undefined {
    const key = ImageDisplayCache.key(ref)
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    // Refresh recency: Map preserves insertion order.
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  set(ref: ImageAttachmentRef, image: DisplayImage): void {
    const key = ImageDisplayCache.key(ref)
    const previous = this.entries.get(key)
    if (previous !== undefined) {
      this.entries.delete(key)
      this.residentBytes -= previous.cacheBytes
    }
    this.entries.set(key, image)
    this.residentBytes += image.cacheBytes
    this.evict()
  }

  /** Drop one identity (e.g. a stricter budget cannot reuse the payload). */
  delete(ref: ImageAttachmentRef): void {
    const key = ImageDisplayCache.key(ref)
    const value = this.entries.get(key)
    if (value === undefined) return
    this.entries.delete(key)
    this.residentBytes -= value.cacheBytes
  }

  clear(): void {
    this.entries.clear()
    this.residentBytes = 0
  }

  /** Diagnostics/tests. */
  get size(): number {
    return this.entries.size
  }

  /** Diagnostics/tests: current resident byte estimate. */
  get bytes(): number {
    return this.residentBytes
  }

  /** Diagnostics/tests: keys from least to most recently used. */
  keys(): string[] {
    return [...this.entries.keys()]
  }

  private evict(): void {
    while ((this.entries.size > this.maxEntries || this.residentBytes > this.maxBytes) && this.entries.size > 0) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      const value = this.entries.get(oldest)
      this.entries.delete(oldest)
      this.residentBytes -= value?.cacheBytes ?? 0
    }
  }
}

/** Session-wide display cache. The parent may clear it on session switch. */
export const imageDisplayCache = new ImageDisplayCache()

/** Tests/session switch: release every cached display payload. */
export function resetImageDisplayCache(): void {
  imageDisplayCache.clear()
}
