/**
 * Draft snapshots: validation and JSON-safe helpers.
 *
 * A snapshot is produced by the vendored Pi editor seam (`ccCaptureSnapshot`) and is
 * lossless: text, cursor, history browsing state, kill ring, undo stack and
 * large-paste registry. It is plain JSON (arrays/objects only), so the app can
 * persist stashes, implement Ctrl+R history search without mutating the live
 * editor, or hand a draft to an external editor.
 */

import type { CcEditorSnapshot, CcUndoSnapshot } from "./pi-tui-seam-types.ts"
import type { ImageUploadPart } from "../ui/image-view.ts"

export type CcDraftSnapshot = CcEditorSnapshot

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}

function isPastePairs(value: unknown): value is Array<[number, string]> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === "number" &&
        Number.isFinite(entry[0]) &&
        typeof entry[1] === "string",
    )
  )
}

/**
 * Image attachment payloads in a snapshot.
 *
 * Only the marker id and the encoded upload are validated here; DSH remains the
 * authority for image formats and admission, exactly as for a live paste. A
 * snapshot with image payloads is memory-only and must never be persisted.
 */
function isImageAttachmentEntries(value: unknown): value is Array<[number, ImageUploadPart]> {
  if (!Array.isArray(value)) return false
  return value.every((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2) return false
    const id = entry[0]
    const payload = entry[1]
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return false
    if (typeof payload !== "object" || payload === null) return false
    const part = payload as Record<string, unknown>
    return part.type === "image" && typeof part.data === "string" && part.data.length > 0
  })
}

function isUndoSnapshot(value: unknown): value is CcUndoSnapshot {
  if (!isRecord(value)) return false
  return (
    isStringArray(value.lines) &&
    typeof value.cursorLine === "number" &&
    typeof value.cursorCol === "number" &&
    isPastePairs(value.pastes) &&
    typeof value.pasteCounter === "number"
  )
}

/** Structural check for snapshots restored from JSON/user config. */
export function isCcDraftSnapshot(value: unknown): value is CcDraftSnapshot {
  if (!isRecord(value)) return false
  return (
    value.version === 1 &&
    isStringArray(value.lines) &&
    value.lines.length > 0 &&
    typeof value.cursorLine === "number" &&
    typeof value.cursorCol === "number" &&
    isPastePairs(value.pastes) &&
    typeof value.pasteCounter === "number" &&
    isStringArray(value.history) &&
    typeof value.historyIndex === "number" &&
    Array.isArray(value.undoStack) &&
    value.undoStack.every(isUndoSnapshot) &&
    isStringArray(value.killRing) &&
    // Older snapshots (pre image attachments) simply carry no image payloads.
    (value.imageAttachments === undefined || isImageAttachmentEntries(value.imageAttachments)) &&
    (value.imageCounter === undefined ||
      (typeof value.imageCounter === "number" && Number.isSafeInteger(value.imageCounter) && value.imageCounter >= 0))
  )
}

/** Validate a snapshot, throwing a descriptive error when malformed. */
export function parseCcDraftSnapshot(value: unknown): CcDraftSnapshot {
  if (!isCcDraftSnapshot(value)) {
    throw new Error(
      "Invalid CcDraftSnapshot: expected version 1 with lines/cursor/pastes/history/undoStack/killRing fields",
    )
  }
  return {
    ...value,
    imageAttachments: value.imageAttachments ?? [],
    imageCounter: value.imageCounter ?? 0,
  }
}

/**
 * Serialize a draft snapshot. Image payloads are still part of the returned
 * JSON: only use this for memory/transport, never for `history.json` or any
 * durable draft file.
 */
export function serializeCcDraftSnapshot(snapshot: CcDraftSnapshot): string {
  return JSON.stringify(snapshot)
}

/** Parse a serialized snapshot back into a validated draft. */
export function deserializeCcDraftSnapshot(serialized: string): CcDraftSnapshot {
  return parseCcDraftSnapshot(JSON.parse(serialized))
}