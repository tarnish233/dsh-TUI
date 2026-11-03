/**
 * CcEditor: a Claude-Code/readline compatible editor on top of Pi's Editor.
 *
 * There is exactly one editor state. This subclass only routes keys and adds
 * CC semantics through the narrow public seam added by the local Pi TUI patch
 * (`ccMoveWord`, `ccKillWord`, `ccCaptureSnapshot`, ...). Text is never rewritten
 * from the outside, undo/kill/yank/paste state stays in the Pi editor, and
 * `onSubmit`/`onChange` keep their Pi signatures.
 *
 * App-level actions (Ctrl+R, Ctrl+S, Ctrl+T, ...) are forwarded through
 * `onAction`; the app owns history search, stash, external editor, clipboard,
 * queueing and dialogs.
 */

import {
  decodeKittyPrintable,
  Editor,
  matchesKey,
  type EditorOptions,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui"
import type { CcActionDefinition, CcContext } from "./actions.ts"
import { graphemes } from "./boundaries.ts"
import { CcKeymap, createCcKeymap, type CcKeymapConfig } from "./keymap.ts"
import { BracketedPasteFilter, type PasteToken } from "./paste.ts"
import { assertCcEditorSeam, type CcEditorSnapshot } from "./pi-tui-seam-types.ts"
import { installPiTuiSeam } from "./pi-tui-seam.js"

// App-specific entry points on the vendored TUI. This is not a Pi provider or
// Agent feature; it replaces the former pnpm patch to Editor/SelectList.
installPiTuiSeam()
import type { CcDraftSnapshot } from "./snapshot.ts"

/** Event forwarded to the app for actions the editor does not implement. */
export interface CcActionEvent {
  /** Action id, e.g. `app.history.search`. */
  id: string
  /** Raw terminal data that triggered the action. */
  key: string
  context: CcContext
  /** Current draft with large-paste markers (what `onSubmit` will receive, expanded). */
  text: string
  /** Draft with large-paste markers expanded. */
  expandedText: string
  /** True when the whole draft is empty. */
  empty: boolean
  cursor: { line: number; col: number }
  isBrowsingHistory: boolean
  definition?: CcActionDefinition
}

export interface CcEditorOptions extends EditorOptions {
  /** Keymap instance; defaults to a new CC keymap. */
  keymap?: CcKeymap
  /** Shorthand for `keymap: createCcKeymap({ bindings })`. */
  bindings?: CcKeymapConfig
  /** Keyboard chord timeout in milliseconds (CC default 3000). */
  chordTimeoutMs?: number
  /** Editor-side action context (default `"editor"`). */
  context?: CcContext
  /** Receives app-level actions; return true to report "handled". */
  onAction?: (event: CcActionEvent) => boolean | void
}

export interface CcExternalEditorRequest {
  snapshot: CcDraftSnapshot
  /** Full text with paste markers expanded, for the external editor. */
  text: string
  cursor: { line: number; col: number }
}

/** Actions that exist in the registry but are implemented by the app. */
const APP_FALLBACK_ACTIONS = new Set([
  "app.interrupt",
  "app.cancel",
  "app.exit",
  "app.redraw",
  "app.history.search",
  "app.stash",
  "app.editor.external",
  "app.tools.expand",
  "app.todo",
  "app.thinking.toggle",
  "app.model.select",
  "app.mode.cycle",
  "app.clipboard.pasteImage",
  "app.suspend",
  "app.message.sendNow",
  "app.message.followUp",
  "app.help",
  "list.previous",
  "list.next",
  "list.page-up",
  "list.page-down",
  "list.first",
  "list.last",
  "list.select",
  "list.cancel",
  "list.select-digit",
  "dialog.confirm",
  "dialog.cancel",
  "historySearch.next",
  "historySearch.previous",
  "historySearch.accept",
  "historySearch.cancel",
])

export class CcEditor extends Editor {
  /** App-level action sink. Set after construction or via options.onAction. */
  onAction?: (event: CcActionEvent) => boolean | void
  /** Called whenever a chord prefix is opened/closed (for a key hint UI). */
  onChordChange?: (prefix: string[] | null) => void

  private keymapInstance: CcKeymap
  private readonly pasteFilter = new BracketedPasteFilter()
  private actionContext: CcContext
  private chordTimer: ReturnType<typeof setTimeout> | undefined

  constructor(tui: TUI, theme: EditorTheme, options: CcEditorOptions = {}) {
    super(tui, theme, options)
    assertCcEditorSeam(Editor)
    this.keymapInstance =
      options.keymap ??
      createCcKeymap({
        bindings: options.bindings,
        chordTimeoutMs: options.chordTimeoutMs,
      })
    this.actionContext = options.context ?? "editor"
    this.onAction = options.onAction
  }

  // --- configuration -----------------------------------------------------

  getKeymap(): CcKeymap {
    return this.keymapInstance
  }

  setKeymap(keymap: CcKeymap): void {
    this.clearChordTimer()
    this.keymapInstance.cancelChord()
    this.keymapInstance = keymap
    this.requestRender()
  }

  /** Replace user bindings on the current keymap (hot reload). */
  setBindings(bindings: CcKeymapConfig): void {
    this.clearChordTimer()
    this.keymapInstance.setBindings(bindings)
    this.requestRender()
  }

  getActionContext(): CcContext {
    return this.actionContext
  }

  /** Context used for editor key dispatch (default `"editor"`). */
  setActionContext(context: CcContext): void {
    this.actionContext = context
  }

  /** True while a bracketed paste is partially received. */
  isPasting(): boolean {
    return this.pasteFilter.isPasting
  }

  /** Flush bytes held back while waiting for a fragmented paste marker. */
  flushInputBuffer(): void {
    this.dispatchTokens(this.pasteFilter.flush())
  }

  // --- drafts ------------------------------------------------------------

  /** Lossless, JSON-serializable capture of text, cursor, history, kill ring, undo and pastes. */
  captureDraft(): CcDraftSnapshot {
    return this.ccCaptureSnapshot()
  }

  /** Restore a snapshot captured earlier (stash, history search cancel, suspend/resume). */
  restoreDraft(snapshot: CcDraftSnapshot, options: { notify?: boolean } = {}): void {
    this.pasteFilter.reset()
    this.clearChordTimer()
    this.keymapInstance.cancelChord()
    this.ccRestoreSnapshot(snapshot, options)
  }

  /** Everything needed to round-trip a draft through an external editor. */
  captureDraftForExternalEditor(): CcExternalEditorRequest {
    return {
      snapshot: this.captureDraft(),
      text: this.getExpandedText(),
      cursor: this.getCursor(),
    }
  }

  /**
   * Apply text returned by an external editor. Unchanged text restores the
   * original snapshot (keeping cursor, undo, pastes); changed text becomes one
   * atomic undoable edit and large-paste markers are dropped, matching Pi's
   * `setText`.
   */
  applyExternalEdit(text: string, previous?: CcDraftSnapshot): void {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    if (previous && normalized === previous.expandedText) {
      this.restoreDraft(previous)
      return
    }
    this.replaceDraftText(normalized)
  }

  /**
   * Replace the whole draft with `text` as one undoable edit.
   *
   * Backs the app's cleared-draft recall / external-editor return path: the
   * previous text, cursor, undo stack and paste registry are pushed onto the
   * editor undo stack first, so Ctrl+_ restores the full pre-replacement state.
   * Large-paste markers inside the old draft are dropped (as with Pi's
   * `setText`), and the cursor lands at `options.cursor` or at the end.
   * Returns true when the text actually changed.
   */
  replaceDraftText(text: string, options: { cursor?: { line: number; col: number } } = {}): boolean {
    const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    const changed = this.getText() !== normalized
    this.pasteFilter.reset()
    this.clearChordTimer()
    this.keymapInstance.cancelChord()
    this.setText(normalized)
    if (options.cursor) {
      this.ccSetCursor(options.cursor.line, options.cursor.col)
    }
    return changed
  }

  /** Restore the pre-history-browsing draft (Esc while browsing). */
  restoreHistoryDraft(): boolean {
    if (!this.ccIsBrowsingHistory()) return false
    let guard = this.ccGetHistory().length + 2
    while (this.ccIsBrowsingHistory() && guard > 0) {
      this.ccHistoryNext()
      guard -= 1
    }
    return true
  }

  // --- input -------------------------------------------------------------

  override handleInput(data: string): void {
    this.dispatchTokens(this.pasteFilter.push(data))
  }

  private dispatchTokens(tokens: readonly PasteToken[]): void {
    for (const token of tokens) {
      if (token.kind === "paste") {
        if (token.text.length > 0) {
          this.ccPaste(token.text)
          this.requestRender()
        }
      } else {
        this.dispatchKeys(token.data)
      }
    }
  }

  private dispatchKeys(data: string): void {
    if (!data) return
    // Pi's character-jump mode owns the next key event.
    if (this.ccGetJumpMode() !== null) {
      super.handleInput(data)
      return
    }
    const context: CcContext = this.isShowingAutocomplete() ? "autocomplete" : this.actionContext
    const resolution = this.keymapInstance.resolve(data, context)
    switch (resolution.kind) {
      case "pending":
        this.armChordTimer()
        this.onChordChange?.(resolution.prefix)
        this.requestRender()
        return
      case "cancelled-chord":
        this.clearChordTimer()
        this.onChordChange?.(null)
        if (resolution.passthrough.length > 0) {
          this.dispatchKeys(resolution.passthrough)
        }
        return
      case "action":
        this.clearChordTimer()
        this.onChordChange?.(null)
        this.runAction(resolution.action, data, context)
        // A completion menu goes stale as soon as a non-completion action edits
        // or moves the draft; close it rather than showing a wrong prefix.
        if (
          context === "autocomplete" &&
          !resolution.action.id.startsWith("autocomplete.") &&
          this.isShowingAutocomplete()
        ) {
          this.ccCancelAutocomplete()
        }
        return
      case "none":
        this.dispatchUnbound(data, context)
        return
    }
  }

  private dispatchUnbound(data: string, context: CcContext): void {
    const printable = decodeKittyPrintable(data)
    if (printable !== undefined) {
      this.ccInsertCharacter(printable)
      return
    }
    if (data.charCodeAt(0) >= 32) {
      // Printable chunk (possibly several graphemes from one terminal read).
      this.ccInsertCharacter(data)
      return
    }
    // Unbound control byte: consume it. Never fall through to Pi defaults:
    // a disabled or remapped action must not silently resurrect Pi behaviour.
    void context
  }

  // --- action dispatch ---------------------------------------------------

  private runAction(action: CcActionDefinition, data: string, context: CcContext): void {
    switch (action.id) {
      case "editor.move.char-left":
        this.ccMoveCursor(0, -1)
        return
      case "editor.move.char-right":
        this.ccMoveCursor(0, 1)
        return
      case "editor.move.line-start":
        this.ccMoveLineStart()
        return
      case "editor.move.line-end":
        this.ccMoveLineEnd()
        return
      case "editor.move.word-left":
        this.ccMoveWord(-1, "word")
        return
      case "editor.move.word-right":
        this.ccMoveWord(1, "word")
        return
      case "editor.move.line-up":
        this.moveVertical(-1)
        return
      case "editor.move.line-down":
        this.moveVertical(1)
        return
      case "editor.move.page-up":
        this.ccPageScroll(-1)
        return
      case "editor.move.page-down":
        this.ccPageScroll(1)
        return
      case "editor.history.previous":
        this.ccHistoryPrevious()
        return
      case "editor.history.next":
        this.ccHistoryNext()
        return
      case "editor.jump.forward":
      case "editor.jump.backward":
        // Pi extension: let Pi's own jump mode handle the next key.
        super.handleInput(data)
        return
      case "editor.insert-space":
        this.ccInsertCharacter(" ")
        return
      case "editor.delete.char-backward":
        this.ccDeleteCharBackward()
        return
      case "editor.delete.char-forward":
        if (this.ccIsEmpty() && this.isActionBoundToKey("app.exit", data)) {
          this.emitAction("app.exit", data, context)
          return
        }
        // Empty draft + a Delete key that is not the exit binding is a no-op.
        this.ccDeleteCharForward()
        return
      case "editor.kill.whitespace-backward":
        this.ccKillWord(-1, "whitespace")
        return
      case "editor.kill.word-backward":
        this.ccKillWord(-1, "word")
        return
      case "editor.kill.word-forward":
        this.ccKillWord(1, "word")
        return
      case "editor.kill.whitespace-forward":
        this.ccKillWord(1, "whitespace")
        return
      case "editor.kill.line-start":
        this.ccKillToLineStart()
        return
      case "editor.kill.line-end":
        this.ccKillToLineEnd()
        return
      case "editor.yank":
        this.ccYank()
        return
      case "editor.yank-pop":
        this.ccYankPop()
        return
      case "editor.undo":
        this.ccUndo()
        return
      case "editor.transpose.chars":
        this.transposeChars()
        return
      case "editor.newline":
        this.insertNewLineOrSubmitOnBackslash(data)
        return
      case "editor.submit":
        this.submitOrInsertNewLine(data)
        return
      case "editor.complete":
        if (this.ccHasAutocompleteProvider()) {
          this.ccTriggerCompletion()
          return
        }
        this.emitAction("editor.complete", data, context)
        return
      case "editor.cancel":
        if (this.isShowingAutocomplete()) {
          this.ccCancelAutocomplete()
          return
        }
        this.restoreHistoryDraft()
        this.emitAction("app.cancel", data, context)
        return
      case "autocomplete.previous":
        this.ccAutocompleteStep(-1)
        return
      case "autocomplete.next":
        this.ccAutocompleteStep(1)
        return
      case "autocomplete.page-up":
        this.ccAutocompletePage(-1)
        return
      case "autocomplete.page-down":
        this.ccAutocompletePage(1)
        return
      case "autocomplete.accept":
        this.ccAutocompleteAccept(matchesKey(data, "enter") ? "confirm" : "tab")
        return
      case "autocomplete.cancel":
        this.ccCancelAutocomplete()
        return
      default:
        break
    }
    if (APP_FALLBACK_ACTIONS.has(action.id) || action.implementor === "app") {
      this.emitAction(action.id, data, context)
      return
    }
    // Unknown editor-side action from a custom registry: forward to the app
    // instead of silently dropping the key.
    this.emitAction(action.id, data, context)
  }

  /**
   * True when `data` is one of the enabled physical bindings of `actionId`.
   * Used for contextual app actions such as Ctrl+D (exit only when the key is
   * still bound to app.exit, so remapped/disabled exit genuinely disables it).
   */
  isActionBoundToKey(actionId: string, data: string): boolean {
    return this.keymapInstance
      .getBindings(actionId)
      .some((binding) => binding.split(" ").length === 1 && matchesKey(data, binding as Parameters<typeof matchesKey>[1]))
  }

  private emitAction(id: string, data: string, context: CcContext): boolean {
    const event: CcActionEvent = {
      id,
      key: data,
      context,
      text: this.getText(),
      expandedText: this.getExpandedText(),
      empty: this.ccIsEmpty(),
      cursor: this.getCursor(),
      isBrowsingHistory: this.ccIsBrowsingHistory(),
      definition: this.keymapInstance.getAction(id),
    }
    const handled = this.onAction?.(event)
    return handled === true
  }

  private moveVertical(direction: -1 | 1): void {
    if (direction < 0) {
      // CC: visual-line movement first; on the first visual line Up browses
      // history directly (no Pi "jump to column 0" step).
      if (this.ccIsOnFirstVisualLine()) {
        this.ccHistoryPrevious()
        return
      }
      this.ccMoveCursor(-1, 0)
      return
    }
    if (this.ccIsOnLastVisualLine()) {
      this.ccHistoryNext()
      return
    }
    this.ccMoveCursor(1, 0)
  }

  private insertNewLineOrSubmitOnBackslash(data: string): void {
    if (this.ccShouldSubmitOnBackslashEnter(data)) {
      this.ccDeleteCharBackward()
      this.ccSubmit()
      return
    }
    this.ccInsertNewLine()
  }

  private submitOrInsertNewLine(data: string): void {
    if (this.disableSubmit) return
    const cursor = this.getCursor()
    const line = this.getLines()[cursor.line] ?? ""
    if (cursor.col > 0 && line[cursor.col - 1] === "\\") {
      this.ccDeleteCharBackward()
      this.ccInsertNewLine()
      return
    }
    this.ccSubmit()
    void data
  }

  private transposeChars(): void {
    const cursor = this.getCursor()
    const line = this.getLines()[cursor.line] ?? ""
    if (!line) return
    const clusters = graphemes(line)
    let rightIndex = clusters.findIndex((cluster) => cluster.index === cursor.col)
    if (rightIndex === -1) {
      if (cursor.col !== line.length) return
      rightIndex = clusters.length
    }
    if (rightIndex < 2 && cursor.col === line.length) return
    const leftIndex = rightIndex === clusters.length ? clusters.length - 2 : rightIndex - 1
    if (leftIndex < 0) return
    const left = clusters[leftIndex]
    const right = clusters[rightIndex === clusters.length ? clusters.length - 1 : rightIndex]
    if (!left || !right) return
    const replaced = this.ccReplaceRange(
      { line: cursor.line, col: left.index },
      { line: cursor.line, col: right.index + right.segment.length },
      right.segment + left.segment,
    )
    if (!replaced) return
    // Cursor after the transposed pair (GNU transpose-chars behaviour).
    this.ccSetCursor(cursor.line, right.index + right.segment.length)
  }

  // --- chord timer -------------------------------------------------------

  private armChordTimer(): void {
    this.clearChordTimer()
    this.chordTimer = setTimeout(() => {
      this.chordTimer = undefined
      const expired = this.keymapInstance.expireChord()
      if (expired) {
        this.onChordChange?.(null)
        this.requestRender()
      }
    }, Math.ceil(this.keymapInstance.getChordTimeoutMs()) + 1)
    // Round up and allow a 1ms clock-resolution margin: never drop a one-shot
    // timer while the keymap still considers the exact deadline pending.
    // Do not keep the process alive for a pending chord.
    this.chordTimer.unref?.()
  }

  private clearChordTimer(): void {
    if (this.chordTimer !== undefined) {
      clearTimeout(this.chordTimer)
      this.chordTimer = undefined
    }
  }

  /** Redraw hook shared by chord and paste state changes. */
  private requestRender(): void {
    try {
      this.tui.requestRender()
    } catch {
      // A detached editor (tests, teardown) must not throw on redraw.
    }
  }

  override invalidate(): void {
    this.clearChordTimer()
    super.invalidate()
  }
}