/**
 * Native file attachments on the single editor state.
 *
 * A `[File #N]` marker is a **file** occurrence, never an image: the two marker
 * families keep separate ids, registries and payloads. DSH owns the durable
 * `FileAttachmentRef` (opaque attachment id, display name, byte size) and its
 * admission; the input layer only carries the ready `PromptContentPart` (the
 * shared `file` member) through the draft.
 *
 * Native queue `FileBlock` refs are already durable and admissible, so a recall
 * restores the ready part directly. The input layer never reads file bytes, a
 * path, a URL or a store, never calls `readImage` for a file, never uploads
 * automatically, and never invents an attachment from pasted path text.
 */

import type { FileAttachmentRef, PromptContentPart } from '../backend/types.ts'
import { asFileAttachmentRef } from '../attachments.ts'

/**
 * The shared `PromptContentPart` file member.
 *
 * Extracted from the parent-owned union instead of redefining the native shape:
 * when the public Host contract changes, this alias follows it and nothing in
 * the input layer silently drifts.
 */
export type CcFilePromptPart = Extract<PromptContentPart, { readonly type: 'file' }>

/** One parent-supplied file attachment payload (memory only). */
export interface CcFileUpload {
  readonly part: CcFilePromptPart
}

/** One `[File #N]` occurrence backed by a live upload. */
export interface CcFileAttachment {
  /** `[File #N]` marker id. Stable for the editor's life and never reused. */
  readonly id: number
  readonly part: CcFilePromptPart
  /** The same durable native ref as `part.attachment` (display/metadata only). */
  readonly attachment: FileAttachmentRef
}

/** True when `value` looks like the shared file prompt part. */
export function isCcFilePromptPart(value: unknown): value is CcFilePromptPart {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.type === 'file' && asFileAttachmentRef(record.attachment) !== undefined
}

/**
 * Validate and normalize one `insertFile` payload.
 *
 * Accepts either a `CcFileUpload` (`{ part }`) or the bare shared
 * `PromptContentPart.file`, and returns a normalized upload whose part contains
 * exactly the validated durable ref. A malformed value throws with an
 * actionable message; nothing is silently accepted, guessed or defaulted.
 */
export function asCcFileUpload(value: unknown): CcFileUpload {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
  const candidate = record === undefined ? undefined : record.type === 'file' ? record : record.part
  if (!isCcFilePromptPart(candidate)) {
    throw new Error(
      'insertFile requires a native file prompt part ({ type: "file", attachment: { attachmentId, name, bytes } }); ' +
        'stage the file through the native backend first. Paths, URLs and pasted text are never attached automatically.',
    )
  }
  const attachment = asFileAttachmentRef(candidate.attachment)
  if (attachment === undefined) {
    throw new Error('insertFile received a file part with malformed native metadata; the attachment was not added.')
  }
  return { part: { type: 'file', attachment } }
}