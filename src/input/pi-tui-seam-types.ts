/**
 * Typed access to the CC seam installed on the vendored `@earendil-works/pi-tui`.
 *
 * The seam is installed by `src/input/pi-tui-seam.js` onto the vendored
 * `vendor/pi-tui` classes and only *adds* narrow public entry points to the
 * existing `Editor` (and `SelectList`) classes. The editor remains the single
 * owner of text, cursor, undo stack, kill ring, paste registry and history;
 * this module never copies or rewrites that state.
 *
 * The ambient augmentation below keeps the app types exact, and
 * `assertCcEditorSeam` reports a missing installation instead of failing with a
 * vague `undefined is not a function`.
 */

import type { Editor } from "@earendil-works/pi-tui"

/** One undo-stack entry, flattened from the Pi editor snapshot. */
export interface CcUndoSnapshot {
  lines: string[]
  cursorLine: number
  cursorCol: number
  pastes: Array<[number, string]>
  pasteCounter: number
}

/**
 * Lossless editor snapshot.
 *
 * Plain JSON data (no Maps/classes), safe to clone, persist or hand to a
 * stash/search implementation, and rich enough to restore text, cursor,
 * history-browsing state, kill ring, undo stack and large-paste markers.
 */
export interface CcEditorSnapshot {
  version: 1
  lines: string[]
  cursorLine: number
  cursorCol: number
  pastes: Array<[number, string]>
  pasteCounter: number
  history: string[]
  historyIndex: number
  historyDraft: { lines: string[]; cursorLine: number; cursorCol: number } | null
  killRing: string[]
  undoStack: CcUndoSnapshot[]
  lastAction: string | null
  preferredVisualCol: number | null
  snappedFromCursorCol: number | null
  scrollOffset: number
  jumpMode: "forward" | "backward" | null
  isInPaste: boolean
  pasteBuffer: string
  /** `getText()` at capture time (large pastes appear as `[paste #n ...]`). */
  text: string
  /** `getExpandedText()` at capture time (paste markers expanded). */
  expandedText: string
}

declare module "@earendil-works/pi-tui" {
  interface Editor {
    ccCaptureSnapshot(): CcEditorSnapshot
    ccRestoreSnapshot(snapshot: CcEditorSnapshot, options?: { notify?: boolean }): void
    ccIsEmpty(): boolean
    ccGetJumpMode(): "forward" | "backward" | null
    ccIsOnFirstVisualLine(): boolean
    ccIsOnLastVisualLine(): boolean
    ccMoveCursor(deltaLine: number, deltaCol: number): void
    ccMoveLineStart(): void
    ccMoveLineEnd(): void
    ccMoveWord(direction: -1 | 1, mode?: "word" | "whitespace"): void
    ccPageScroll(direction: -1 | 1): void
    ccWordBoundaryBackward(text: string, cursor: number): number
    ccWordBoundaryForward(text: string, cursor: number): number
    ccWhitespaceBoundaryBackward(text: string, cursor: number): number
    ccWhitespaceBoundaryForward(text: string, cursor: number): number
    ccDeleteCharBackward(): void
    ccDeleteCharForward(): void
    ccKillToLineStart(): void
    ccKillToLineEnd(): void
    ccKillWord(direction: -1 | 1, mode?: "word" | "whitespace"): boolean
    ccYank(): void
    ccYankPop(): void
    ccUndo(): void
    ccUndoDepth(): number
    ccGetKillRing(): string[]
    ccGetPastes(): Map<number, string>
    ccHistoryPrevious(): void
    ccHistoryNext(): void
    ccIsBrowsingHistory(): boolean
    ccExitHistoryBrowsing(): void
    ccGetHistory(): string[]
    ccSetHistory(entries: string[]): void
    ccInsertCharacter(text: string): void
    ccInsertText(text: string): void
    ccPaste(text: string): void
    ccInsertNewLine(): void
    ccSubmit(): void
    ccShouldSubmitOnBackslashEnter(data: string): boolean
    ccDropUndoSnapshot(): void
    ccReplaceRange(
      from: { line: number; col: number },
      to: { line: number; col: number },
      text: string,
      options?: { undo?: boolean },
    ): boolean
    ccSetCursor(line: number, col: number): void
    ccHasAutocompleteProvider(): boolean
    ccTriggerCompletion(): void
    ccCancelAutocomplete(): void
    ccAutocompleteStep(delta: -1 | 1): boolean
    ccAutocompletePage(direction: -1 | 1): boolean
    ccAutocompleteAccept(trigger?: "tab" | "confirm"): boolean
  }

  interface SelectList {
    getSelectedIndex(): number
    getItemCount(): number
    moveSelection(delta: number): void
  }
}

const SEAM_METHODS = [
  "ccCaptureSnapshot",
  "ccRestoreSnapshot",
  "ccMoveCursor",
  "ccMoveWord",
  "ccKillWord",
  "ccYank",
  "ccYankPop",
  "ccUndo",
  "ccHistoryPrevious",
  "ccHistoryNext",
  "ccPaste",
  "ccReplaceRange",
  "ccAutocompleteStep",
  "ccAutocompleteAccept",
] as const

/** True when the loaded Pi TUI editor exposes the CC seam. */
export function hasCcEditorSeam(editorClass: { prototype: object }): boolean {
  const prototype = editorClass.prototype as Record<string, unknown>
  return SEAM_METHODS.every((method) => typeof prototype[method] === "function")
}

/**
 * Verify that the seam is present, with an actionable message.
 * Called once when a CcEditor is constructed.
 */
export function assertCcEditorSeam(editorClass: { prototype: object; name?: string }): void {
  const prototype = editorClass.prototype as Record<string, unknown>
  if (typeof prototype.ccCaptureSnapshot !== "function") {
    throw new Error(
      "CcEditor requires the vendored Pi TUI CC seam.\n" +
        "Import src/input/pi-tui-seam.js (installed by CcEditor) and ensure the\n" +
        "vendored package was built with pnpm build:pi-tui; see docs/INPUT.md.",
    )
  }
  const missing = SEAM_METHODS.filter((method) => typeof prototype[method] !== "function")
  if (missing.length > 0) {
    throw new Error(`CcEditor: seam-capable Pi editor is missing seam methods: ${missing.join(", ")}`)
  }
}

/** Narrow structural view of a seam-capable editor, for tests and adapters. */
export type SeamEditor = Editor