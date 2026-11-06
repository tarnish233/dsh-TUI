/** Image transport/display vocabulary, not an attachment store or admission policy. */
import type {
  DisplayContentPart, ImageAttachmentRef, ImageAttachmentValue, ImageMediaType,
} from './backend/types.ts'

const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export function isImageMediaType(value: unknown): value is ImageMediaType {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp' || value === 'image/gif'
}

/** Shape validation only. DSH readImage remains the authority for integrity and format. */
export function asImageAttachmentRef(value: unknown): ImageAttachmentRef | undefined {
  const ref = object(value)
  if (!ref || typeof ref.attachmentId !== 'string' || ref.attachmentId.length === 0 ||
      !isImageMediaType(ref.mediaType) || !positiveInteger(ref.bytes) ||
      !positiveInteger(ref.width) || !positiveInteger(ref.height)) return undefined
  if (ref.name !== undefined && typeof ref.name !== 'string') return undefined
  const original = object(ref.originalDimensions)
  if (ref.originalDimensions !== undefined &&
      (!original || !positiveInteger(original.width) || !positiveInteger(original.height))) return undefined
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...(typeof ref.name === 'string' ? { name: ref.name } : {}),
    ...(original ? { originalDimensions: { width: original.width as number, height: original.height as number } } : {}),
  }
}

/** Preserve repeated image occurrences and their order; never invent refs from inline test data. */
export function displayContentParts(value: unknown): DisplayContentPart[] {
  if (!Array.isArray(value)) return []
  const parts: DisplayContentPart[] = []
  for (const block of value) {
    const item = object(block)
    if (item?.type === 'text' && typeof item.text === 'string') parts.push({ type: 'text', text: item.text })
    else if (item?.type === 'image') {
      const attachment = asImageAttachmentRef(item.attachment)
      if (attachment) parts.push({ type: 'image', attachment })
    }
  }
  return parts
}

export function imageAttachments(value: unknown): ImageAttachmentRef[] {
  return displayContentParts(value).flatMap(part => part.type === 'image' ? [part.attachment] : [])
}

/** Transport equivalence excludes display names, which DSH intentionally does not verify. */
export function sameImageAttachment(a: ImageAttachmentRef, b: ImageAttachmentRef): boolean {
  return a.attachmentId === b.attachmentId && a.mediaType === b.mediaType && a.bytes === b.bytes &&
    a.width === b.width && a.height === b.height
}

/** Identity for an ephemeral verified-byte cache, never a storage path. */
export function imageAttachmentKey(ref: ImageAttachmentRef): string {
  return JSON.stringify([ref.attachmentId, ref.mediaType, ref.bytes, ref.width, ref.height])
}

/** Reject corrupt/truncated wire values before they can reach a terminal encoder. */
export function imageAttachmentValue(value: unknown, expected?: ImageAttachmentRef): ImageAttachmentValue {
  const body = object(value)
  const attachment = asImageAttachmentRef(body?.attachment)
  const data = body?.data
  if (!attachment || typeof data !== 'string' || data.length === 0 || data.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(data) ||
      (expected !== undefined && !sameImageAttachment(attachment, expected))) {
    throw new Error('Invalid image attachment response.')
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.length !== attachment.bytes || bytes.toString('base64') !== data) {
    throw new Error('Image attachment response is truncated or malformed.')
  }
  return { attachment, data }
}

/** Label clipboard bytes for the native admission API; this is not a decoder or permission check. */
export function imageMediaTypeFromBytes(bytes: Uint8Array): ImageMediaType | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && String.fromCharCode(...bytes.subarray(0, 6)).match(/^GIF8[79]a$/)) return 'image/gif'
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return undefined
}
