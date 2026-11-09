/**
 * Compact, width-safe, read-only marker for one native file occurrence.
 *
 * A `file` content block is DSH's durable FileBlock metadata: attachment id,
 * display name and byte size. The marker shows exactly that — it never reads,
 * fetches, decodes, copies or uploads bytes, never guesses a host path, and has
 * no keyboard/mouse affordance. It exists so a prompt that carried a file stays
 * visible in the transcript instead of disappearing.
 *
 * The name is untrusted display text (DSH verifies the attachment, not the
 * label), so it is sanitized and collapsed to one line before it can reach a
 * terminal; the chip is preserved first and the metadata is truncated by real
 * display width (CJK/emoji included) as a last resort.
 */
import type { FileAttachmentRef } from '../backend/types.ts'
import { dim, t } from './theme.ts'
import { sanitize, truncateToWidth, visibleWidth } from './text.ts'

/** Stable chip label; orientation-free and independent of the file name. */
export function fileMarkerChip(number: number): string {
  return `[File #${number}]`
}

/** One-line display name; sanitized, whitespace-collapsed, never empty. */
export function fileDisplayName(name: unknown): string {
  const raw = typeof name === 'string' ? name : ''
  const clean = sanitize(raw).replace(/\s+/g, ' ').trim()
  return clean === '' ? 'file' : clean
}

/** Compact byte size from the native metadata only. */
export function fileSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'size unknown'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * One marker row, never wider than `width`. The name is the identifying part,
 * so it wins over the size when the terminal is narrow; both are dropped before
 * the chip itself is clipped.
 */
export function fileMarkerLine(number: number, attachment: FileAttachmentRef, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width))
  const chip = dim(t.muted(fileMarkerChip(number)))
  const budget = safeWidth - visibleWidth(chip) - 1
  if (budget <= 0) return truncateToWidth(chip, safeWidth)

  const name = fileDisplayName(attachment.name)
  const size = fileSizeLabel(attachment.bytes)
  const candidates = [`${name} · ${size}`, name, size]
  for (const candidate of candidates) {
    if (visibleWidth(candidate) <= budget) return `${chip}${t.muted(` ${candidate}`)}`
  }
  return `${chip}${t.muted(` ${truncateToWidth(name, budget)}`)}`
}