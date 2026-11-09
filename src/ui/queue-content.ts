/** Byte-free presentation of native inbox attachment counts. */
import type { QueueEntry } from '../backend/types.ts'
import { oneLine } from './text.ts'

const count = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0

export function queueAttachmentLabel(entry: QueueEntry): string {
  const images = count(entry.images), files = count(entry.files)
  return [images > 0 ? `${images} ${images === 1 ? 'image' : 'images'}` : '',
    files > 0 ? `${files} ${files === 1 ? 'file' : 'files'}` : ''].filter(Boolean).join(' · ')
}

export function queueContentLabel(entry: QueueEntry): string {
  const text = oneLine(entry.text)
  if (text !== '') return text
  const images = count(entry.images), files = count(entry.files)
  return images > 0 && files > 0 ? '(attachments)' : images > 0 ? '(image)' : files > 0 ? '(file)' : '(empty)'
}
