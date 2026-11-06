/** Independent, synthetic image fixtures. No user file, tool, model or clipboard is read. */
import { createHash } from 'node:crypto'
import sharp from 'sharp'
import type { ImageAttachmentRef, ImageAttachmentValue, ImageMediaType, PromptContentPart } from '../../src/backend/types.ts'

export async function imageFixture(mediaType: ImageMediaType = 'image/png', name = 'quadrants.png', width = 64, height = 32): Promise<{
  readonly attachment: ImageAttachmentRef
  readonly value: ImageAttachmentValue
  readonly upload: Extract<PromptContentPart, { readonly type: 'image' }>
  readonly bytes: Buffer
}> {
  const raw = Buffer.alloc(width * height * 3)
  const colors = [[240, 40, 40], [40, 220, 60], [30, 80, 240], [240, 210, 30]] as const
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = colors[(y < height / 2 ? 0 : 2) + (x < width / 2 ? 0 : 1)]!
    const offset = (y * width + x) * 3
    raw[offset] = color[0]; raw[offset + 1] = color[1]; raw[offset + 2] = color[2]
  }
  const pipeline = sharp(raw, { raw: { width, height, channels: 3 } })
  const bytes = await (mediaType === 'image/png' ? pipeline.png() : mediaType === 'image/jpeg' ? pipeline.jpeg() : mediaType === 'image/webp' ? pipeline.webp() : pipeline.gif()).toBuffer()
  const attachment: ImageAttachmentRef = {
    attachmentId: 'fixture:' + createHash('sha256').update(bytes).digest('hex'),
    mediaType, bytes: bytes.length, width, height, name,
  }
  const data = bytes.toString('base64')
  return { attachment, value: { attachment, data }, upload: { type: 'image', mediaType, data, name }, bytes }
}
