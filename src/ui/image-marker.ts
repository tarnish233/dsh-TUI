/**
 * Compact, width-safe transcript markers for image occurrences.
 *
 * A marker is one line and carries only metadata already present on the
 * canonical ref: it never reads, decodes or prefetches bytes. The actual
 * viewer is a separate fullscreen overlay opened by an explicit user action.
 *
 * Affordance honesty:
 *   - a real ref with a parent-provided `onImageDetails` is clickable in
 *     fullscreen mode and advertises the parent's real `app.images.details`
 *     key label in inline mode (where the terminal has no mouse routing);
 *   - without that callback (or for legacy `imageCount`-only data) the marker
 *     is inert and says so instead of showing a fake hint.
 */
import type { ImageAttachmentRef } from '../backend/types.ts'
import { dim, t, bold } from './theme.ts'
import { sanitize, truncateToWidth, visibleWidth } from './text.ts'

export interface ImageMarkerSpec {
  /** Item-local display ordinal (`Image #3`); never a global transcript id. */
  readonly number: number
  /** Canonical ref; absent for a legacy count-only placeholder. */
  readonly attachment?: ImageAttachmentRef
  /** Stable occurrence key, required for a clickable marker. */
  readonly key?: string
  /** Label of the real keyboard action, e.g. `ctrl+x ctrl+i`. */
  readonly hint?: string
  /** The parent supplied an image-details handler. */
  readonly interactive?: boolean
  /** Terminal mode of the transcript. */
  readonly fullscreen?: boolean
  readonly hovered?: boolean
}

export interface ImageMarkerHit {
  readonly key: string
}

/** Short chip label; stable and orientation-free. */
export function imageMarkerChip(number: number): string {
  return `[Image #${number}]`
}

/** True when this spec can actually open the viewer. */
export function imageMarkerIsInteractive(spec: ImageMarkerSpec): boolean {
  return spec.interactive === true && spec.attachment !== undefined && spec.key !== undefined && spec.key !== ''
}

/**
 * One marker row. Never wider than `width`; the hint is dropped before the
 * metadata chip is truncated, and the whole line is width-clipped as a last
 * resort (CJK/emoji names included).
 */
export function imageMarkerLine(spec: ImageMarkerSpec, width: number): string {
  const safeWidth = Math.max(1, Math.floor(width))
  const interactive = imageMarkerIsInteractive(spec)
  const chip = imageMarkerChip(spec.number)
  const chipStyle = interactive ? bold(t.accentBright(chip)) : dim(t.muted(chip))

  if (spec.attachment === undefined) {
    const placeholder = `${chipStyle}${dim(t.subtle(' · attachment unavailable'))}`
    return truncateToWidth(placeholder, safeWidth)
  }

  const ref = spec.attachment
  const media = shortMedia(ref.mediaType)
  const size = `${ref.width}×${ref.height}`
  const bytes = shortBytes(ref.bytes)
  const name = sanitize(ref.name?.trim() ?? '')
  const hint = imageMarkerHint(spec, interactive)
  const hintWidth = hint === '' ? 0 : visibleWidth(hint) + 1

  // Build the richest suffix that still fits, richest first. An inline keyboard
  // hint is reserved up front so a long name cannot silently remove the only
  // real entry point on a mouse-less terminal.
  const candidates = [
    [name, media, size, bytes].filter(Boolean),
    [media, size, bytes],
    [media, size],
    [media],
  ].map(parts => parts.join(' · '))

  const suffixBudget = Math.max(0, safeWidth - visibleWidth(chip) - 1 - hintWidth)
  let suffix = ''
  for (const candidate of candidates) {
    if (visibleWidth(candidate) <= suffixBudget) { suffix = candidate; break }
  }
  if (suffix === '' && suffixBudget > 0) {
    suffix = truncateToWidth(candidates[candidates.length - 1]!, suffixBudget)
  }

  let line = `${chipStyle}${suffix === '' ? '' : t.muted(` ${suffix}`)}`
  if (hint !== '') {
    const room = safeWidth - visibleWidth(line) - visibleWidth(hint) - 1
    if (room >= 0) line += spec.hovered === true ? t.accentBright(` ${hint}`) : t.subtle(` ${hint}`)
  }
  return truncateToWidth(line, safeWidth)
}

/** Full-screen click affordance or the parent's real key label (inline). */
function imageMarkerHint(spec: ImageMarkerSpec, interactive: boolean): string {
  if (!interactive) return ''
  if (spec.fullscreen === true) return '· click to view'
  const key = spec.hint?.trim() ?? ''
  return key === '' ? '' : `· ${key} to view`
}

function shortMedia(mediaType: ImageAttachmentRef['mediaType']): string {
  switch (mediaType) {
    case 'image/png': return 'PNG'
    case 'image/jpeg': return 'JPEG'
    case 'image/webp': return 'WebP'
    case 'image/gif': return 'GIF'
  }
}

function shortBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}
