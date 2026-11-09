/**
 * Pure image projections for the transcript.
 *
 * This module never reads bytes, never decodes, and never invents an
 * attachment: it keeps the exact canonical refs that DSH put in the durable
 * log or the live stream, in their original item/content order. The parent
 * turns an occurrence key into an explicit `readImage` request only when the
 * user opens the image details surface.
 *
 * An occurrence key is `item identity + content position`, never just the
 * attachmentId: the same attachment may appear several times in one session
 * (user turn, tool result, repeated message), and each occurrence is a
 * separate navigation stop.
 */
import type { DisplayContentPart, ImageAttachmentRef, ImageMediaType } from '../backend/types.ts'
import type { ToolTranscriptItem, TranscriptItem } from '../state/transcript.ts'
import { asImageAttachmentRef } from '../attachments.ts'
import type { ImageViewItem } from './image-view.ts'

/** One displayable image occurrence in transcript order. */
export interface ImageOccurrence {
  /** `<item id>#<content image index>` — stable for the lifetime of the item. */
  readonly key: string
  /** Human-facing label, e.g. `Image 2`. */
  readonly label: string
  readonly attachment: ImageAttachmentRef
  readonly itemId: string
  readonly itemKind: TranscriptItem['kind']
  /** Short source label, e.g. `user`, `assistant`, `tool bash`. */
  readonly source: string
  /** 1-based position among all images of this transcript. */
  readonly ordinal: number
}

/**
 * Ordered display content of one item; absent means the item carries none.
 * Native file parts stay in this order (they are not image occurrences and are
 * skipped by the projections below), so text/image/file positions never drift.
 */
export function itemContentParts(item: TranscriptItem): readonly DisplayContentPart[] {
  if (item.kind === 'user' || item.kind === 'assistant' || item.kind === 'attempt') {
    return item.content ?? []
  }
  if (item.kind === 'tool') {
    if (item.resultContentParts !== undefined) return item.resultContentParts
    // Raw-only durable results still keep their canonical refs visible.
    return toolResultImageRefs(item).map(attachment => ({ type: 'image' as const, attachment }))
  }
  return []
}

/** Native image-block count of one item (valid refs *and* legacy placeholders). */
export function itemImageCount(item: TranscriptItem): number {
  if (item.kind === 'user') return item.imageCount
  if (item.kind === 'assistant') return item.imageCount ?? 0
  if (item.kind === 'attempt') return item.imageCount ?? 0
  if (item.kind === 'tool') return item.resultImages
  return 0
}

/** Image blocks whose bytes are unreachable (legacy `imageCount`-only data). */
export function legacyImagePlaceholders(item: TranscriptItem): number {
  const actual = itemContentParts(item).reduce((count, part) => count + (part.type === 'image' ? 1 : 0), 0)
  return Math.max(0, itemImageCount(item) - actual)
}

export function imageSourceLabel(item: TranscriptItem): string {
  switch (item.kind) {
    case 'user': return 'user'
    case 'assistant': return 'assistant'
    case 'attempt': return 'streaming attempt'
    case 'tool': return item.name.trim() === '' ? 'tool' : `tool ${item.name}`
    default: return item.kind
  }
}

/** Short label of a media type, used in compact metadata rows. */
export function imageMediaLabel(mediaType: ImageMediaType): string {
  switch (mediaType) {
    case 'image/png': return 'PNG'
    case 'image/jpeg': return 'JPEG'
    case 'image/webp': return 'WebP'
    case 'image/gif': return 'GIF'
  }
}

export function formatImageBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Compact, width-safe metadata: `PNG · 1024×768 · 128 KB`. */
export function imageRefSummary(ref: ImageAttachmentRef): string {
  return `${imageMediaLabel(ref.mediaType)} · ${ref.width}×${ref.height} · ${formatImageBytes(ref.bytes)}`
}

/** `name.png · PNG · 1024×768 · 128 KB`; the name is omitted when absent. */
export function imageRefTitle(ref: ImageAttachmentRef): string {
  const name = ref.name?.trim()
  return name === undefined || name === '' ? imageRefSummary(ref) : `${name} · ${imageRefSummary(ref)}`
}

/** Ordered occurrences in the transcript's declared order, duplicates kept. */
export function transcriptImageOccurrences(items: readonly TranscriptItem[]): ImageOccurrence[] {
  const occurrences: ImageOccurrence[] = []
  for (const item of items) {
    if (item.kind === 'notice' || item.kind === 'todos') continue
    const parts = itemContentParts(item)
    let within = 0
    for (const part of parts) {
      if (part.type !== 'image') continue
      const ordinal = occurrences.length + 1
      occurrences.push({
        key: imageOccurrenceKey(item.id, within),
        label: `Image ${ordinal}`,
        attachment: part.attachment,
        itemId: item.id,
        itemKind: item.kind,
        source: imageSourceLabel(item),
        ordinal,
      })
      within += 1
    }
  }
  return occurrences
}

/** `ImageViewItem[]` for the parent's image navigation (real refs only). */
export function getTranscriptImages(items: readonly TranscriptItem[]): ImageViewItem[] {
  return transcriptImageOccurrences(items).map(occurrence => ({
    key: occurrence.key,
    label: occurrence.label,
    attachment: occurrence.attachment,
  }))
}

/** Stable occurrence identity: item id plus the image position inside it. */
export function imageOccurrenceKey(itemId: string, withinItem: number): string {
  return `${itemId}#image-${withinItem}`
}

export function findImageOccurrence(
  items: readonly TranscriptItem[],
  key: string,
): ImageOccurrence | undefined {
  return transcriptImageOccurrences(items).find(occurrence => occurrence.key === key)
}

/** Ordered images of one tool result (same keys as the full transcript). */
export function toolImageOccurrences(item: ToolTranscriptItem): ImageOccurrence[] {
  const occurrences: ImageOccurrence[] = []
  const projected = (item.resultContentParts ?? []).flatMap(part => part.type === 'image' ? [part.attachment] : [])
  // Projected parts are the normal path; a hand-built/legacy projection may
  // carry only raw result blocks, so the nested refs are read as a fallback.
  const refs = projected.length > 0 ? projected : toolResultImageRefs(item)
  let within = 0
  for (const attachment of refs) {
    occurrences.push({
      key: imageOccurrenceKey(item.id, within),
      label: `Image ${within + 1}`,
      attachment,
      itemId: item.id,
      itemKind: 'tool',
      source: imageSourceLabel(item),
      ordinal: within + 1,
    })
    within += 1
  }
  return occurrences
}

/** Nested canonical refs of a durable tool result, in declared block order. */
export function toolResultImageRefs(item: ToolTranscriptItem): ImageAttachmentRef[] {
  const refs: ImageAttachmentRef[] = []
  for (const block of rawResultBlocks(item)) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) continue
    const record = block as Record<string, unknown>
    if (record.type !== 'image') continue
    const attachment = asImageAttachmentRef(record.attachment) ?? asImageAttachmentRef(record)
    if (attachment !== undefined) refs.push(attachment)
  }
  return refs
}

function rawResultBlocks(item: ToolTranscriptItem): readonly unknown[] {
  if (Array.isArray(item.resultContent)) return item.resultContent
  const raw = item.rawResult as Record<string, unknown> | undefined
  const message = raw?.message
  if (typeof message !== 'object' || message === null) return []
  const content = (message as Record<string, unknown>).content
  return Array.isArray(content) ? content : []
}
