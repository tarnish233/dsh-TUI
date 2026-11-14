/**
 * DSH TUI editor/completion seam for the vendored Pi TUI.
 *
 * These are app-specific entry points, not a provider or Agent implementation.
 * Pi TUI remains the owner of text, cursor, undo, kill ring, paste and history.
 * Installing on the public class prototypes keeps vendor/pi-tui upstream source
 * untouched and replaces the former pnpm patch.
 *
 * Upstream: @earendil-works/pi-tui 1.5.0 (MIT), Copyright (c) 2025 Mario Zechner.
 */
import { Editor, SelectList } from '#pi-tui'
// The helpers below come from the same vendored build as the classes above: the
// `#pi-tui/*` package-import subpaths map to vendor/pi-tui/dist, so `KillRing`,
// `UndoStack` and the editor instances are single module identities.
import { KillRing } from '#pi-tui/kill-ring'
import { UndoStack } from '#pi-tui/undo-stack'
import { findWordBackward, findWordForward } from '#pi-tui/word-navigation'
import { isWhitespaceChar } from '#pi-tui/utils'
import { getKeybindings } from '#pi-tui/keybindings'

const PASTE_MARKER_SINGLE = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/
const IMAGE_MARKER_SINGLE = /^\[Image #(\d+)\]$/
const FILE_MARKER_SINGLE = /^\[File #(\d+)\]$/
function isPasteMarker(segment) {
  return segment.length >= 10 && PASTE_MARKER_SINGLE.test(segment)
}
/** Image attachment markers are atomic like paste markers. */
function isImageMarker(segment) {
  return segment.length >= 10 && IMAGE_MARKER_SINGLE.test(segment)
}
/** File attachment markers are their own atomic family (never an image). */
function isFileMarker(segment) {
  return segment.length >= 9 && FILE_MARKER_SINGLE.test(segment)
}
function isAtomicMarker(segment) {
  return isPasteMarker(segment) || isImageMarker(segment) || isFileMarker(segment)
}

let installed = false

class EditorSeam {
// ========================================================================
// DSH TUI CC editor seam for the vendored Pi TUI 1.5.0.
//
// This class only ADDS narrow public entry points. It never changes the
// behaviour of the vendored methods. The DSH input layer (src/input/cc-editor.ts)
// drives CC/readline semantics through these primitives while keeping this
// Editor as the single owner of text, cursor, undo, kill ring and paste state.
//
// Upstream: @earendil-works/pi-tui 1.5.0 (MIT).
// Copyright (c) 2025 Mario Zechner. Seam additions: DSH TUI contributors.
// ========================================================================

/** Lossless, JSON-serializable snapshot of the entire editor state. */
ccCaptureSnapshot() {
    const cloneState = (state) => ({
        lines: [...state.lines],
        cursorLine: state.cursorLine,
        cursorCol: state.cursorCol,
    });
    return {
        version: 1,
        lines: [...this.state.lines],
        cursorLine: this.state.cursorLine,
        cursorCol: this.state.cursorCol,
        pastes: [...this.pastes.entries()].map(([id, text]) => [id, text]),
        pasteCounter: this.pasteCounter,
        history: [...this.history],
        historyIndex: this.historyIndex,
        historyDraft: this.historyDraft ? cloneState(this.historyDraft) : null,
        killRing: [...this.killRing.ring],
        undoStack: this.undoStack.stack.map((snapshot) => ({
            ...cloneState(snapshot.state),
            pastes: [...snapshot.pastes.entries()].map(([id, text]) => [id, text]),
            pasteCounter: snapshot.pasteCounter,
        })),
        lastAction: this.lastAction,
        preferredVisualCol: this.preferredVisualCol,
        snappedFromCursorCol: this.snappedFromCursorCol,
        verticalGoal:
            this.verticalGoal && typeof this.verticalGoal === "object"
                ? {
                      cursorLine: this.verticalGoal.cursorLine,
                      cursorCol: this.verticalGoal.cursorCol,
                      visualCol: this.verticalGoal.visualCol,
                      width: this.verticalGoal.width,
                  }
                : null,
        scrollOffset: this.scrollOffset,
        jumpMode: this.jumpMode,
        isInPaste: this.isInPaste,
        pasteBuffer: this.pasteBuffer,
        imageAttachments: this.getImageAttachmentEntries(),
        imageCounter: this.imageCounter,
        fileAttachments: this.getFileAttachmentEntries(),
        fileCounter: this.fileCounter,
        text: this.getText(),
        expandedText: this.getExpandedText(),
    };
}

/** Restore a snapshot produced by `ccCaptureSnapshot`. */
ccRestoreSnapshot(snapshot, options = {}) {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.lines)) {
        throw new Error("ccRestoreSnapshot: invalid or unsupported snapshot");
    }
    const clamp = (value, min, max, fallback) => {
        const number = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
        return Math.max(min, Math.min(max, number));
    };
    const lines = snapshot.lines.length > 0 ? snapshot.lines.map((line) => String(line ?? "")) : [""];
    this.state = {
        lines,
        cursorLine: clamp(snapshot.cursorLine, 0, lines.length - 1, lines.length - 1),
        cursorCol: 0,
    };
    this.state.cursorCol = clamp(
        snapshot.cursorCol,
        0,
        (lines[this.state.cursorLine] || "").length,
        (lines[this.state.cursorLine] || "").length,
    );
    this.pastes = new Map(
        (Array.isArray(snapshot.pastes) ? snapshot.pastes : [])
            .filter((entry) => Array.isArray(entry) && Number.isFinite(Number(entry[0])))
            .map((entry) => [Number(entry[0]), String(entry[1] ?? "")]),
    );
    this.pasteCounter = Number.isFinite(snapshot.pasteCounter) ? Math.max(0, Math.floor(snapshot.pasteCounter)) : 0;
    this.history = (Array.isArray(snapshot.history) ? snapshot.history : [])
        .filter((entry) => typeof entry === "string")
        .map((entry) => entry);
    this.historyIndex = clamp(snapshot.historyIndex, -1, this.history.length - 1, -1);
    const draft = snapshot.historyDraft;
    this.historyDraft =
        draft && Array.isArray(draft.lines)
            ? {
                  lines: draft.lines.map((line) => String(line ?? "")),
                  cursorLine: Math.max(0, Math.floor(draft.cursorLine ?? 0)),
                  cursorCol: Math.max(0, Math.floor(draft.cursorCol ?? 0)),
              }
            : null;
    this.killRing = new KillRing();
    for (const entry of Array.isArray(snapshot.killRing) ? snapshot.killRing : []) {
        if (typeof entry === "string" && entry.length > 0) {
            this.killRing.push(entry, { prepend: false });
        }
    }
    this.undoStack = new UndoStack();
    for (const entry of Array.isArray(snapshot.undoStack) ? snapshot.undoStack : []) {
        if (!entry || !Array.isArray(entry.lines)) continue;
        const stackLines = entry.lines.length > 0 ? entry.lines.map((line) => String(line ?? "")) : [""];
        const cursorLine = Math.max(0, Math.min(stackLines.length - 1, Math.floor(entry.cursorLine ?? 0)));
        this.undoStack.stack.push({
            state: {
                lines: stackLines,
                cursorLine,
                cursorCol: Math.max(0, Math.floor(entry.cursorCol ?? 0)),
            },
            pastes: new Map(
                (Array.isArray(entry.pastes) ? entry.pastes : []).map((pair) => [Number(pair[0]), String(pair[1] ?? "")]),
            ),
            pasteCounter: Number.isFinite(entry.pasteCounter) ? Math.max(0, Math.floor(entry.pasteCounter)) : 0,
        });
    }
    this.lastAction = typeof snapshot.lastAction === "string" ? snapshot.lastAction : null;
    this.preferredVisualCol = Number.isFinite(snapshot.preferredVisualCol) ? snapshot.preferredVisualCol : null;
    this.snappedFromCursorCol = Number.isFinite(snapshot.snappedFromCursorCol)
        ? snapshot.snappedFromCursorCol
        : null;
    const goal = snapshot.verticalGoal;
    // `width` is the layout width the goal was measured in, so a restore at a
    // different width cannot replay a column computed for the old wrapping. A
    // snapshot without a usable width (older draft) simply drops the goal.
    this.verticalGoal =
        goal &&
        Number.isFinite(goal.cursorLine) &&
        Number.isFinite(goal.cursorCol) &&
        Number.isFinite(goal.visualCol) &&
        Number.isFinite(goal.width) &&
        goal.width >= 1
            ? {
                  cursorLine: Math.max(0, Math.floor(goal.cursorLine)),
                  cursorCol: Math.max(0, Math.floor(goal.cursorCol)),
                  visualCol: Math.max(0, Math.floor(goal.visualCol)),
                  width: Math.max(1, Math.floor(goal.width)),
              }
            : null;
    this.scrollOffset = Math.max(0, Math.floor(snapshot.scrollOffset ?? 0));
    this.jumpMode =
        snapshot.jumpMode === "forward" || snapshot.jumpMode === "backward" ? snapshot.jumpMode : null;
    this.isInPaste = snapshot.isInPaste === true;
    this.pasteBuffer = typeof snapshot.pasteBuffer === "string" ? snapshot.pasteBuffer : "";
    this.setImageAttachmentEntries(
        Array.isArray(snapshot.imageAttachments)
            ? snapshot.imageAttachments.filter((entry) => Array.isArray(entry) && entry.length === 2)
            : [],
        Number.isFinite(snapshot.imageCounter) ? snapshot.imageCounter : 0,
    );
    this.setFileAttachmentEntries(
        Array.isArray(snapshot.fileAttachments)
            ? snapshot.fileAttachments.filter((entry) => Array.isArray(entry) && entry.length === 2)
            : [],
        Number.isFinite(snapshot.fileCounter) ? snapshot.fileCounter : 0,
    );
    // An older snapshot must never roll the per-family id high-water mark back:
    // ids allocated after it was captured stay reserved, and markers in the
    // restored text reserve their own ids too.
    for (const line of this.state.lines) {
        this.noteImageMarkerIds(line);
        this.noteFileMarkerIds(line);
    }
    this.cancelAutocomplete();
    if (options.notify !== false && this.onChange) {
        this.onChange(this.getText());
    }
}

ccIsEmpty() {
    return this.isEditorEmpty();
}

ccGetJumpMode() {
    return this.jumpMode;
}

/** Enter Pi's character-jump mode for the next target character. */
ccStartJump(direction) {
    this.jumpMode = direction === "backward" ? "backward" : "forward";
}

/** Leave character-jump mode without performing a jump. */
ccCancelJump() {
    this.jumpMode = null;
}

/** Jump to `char`; only called with a single actual target character. */
ccJumpToChar(char, direction) {
    this.jumpMode = null;
    this.jumpToChar(char, direction === "backward" ? "backward" : "forward");
}

ccIsOnFirstVisualLine() {
    return this.isOnFirstVisualLine();
}

ccIsOnLastVisualLine() {
    return this.isOnLastVisualLine();
}

// --- cursor movement ----------------------------------------------------

ccMoveCursor(deltaLine, deltaCol) {
    this.moveCursor(deltaLine, deltaCol);
}

ccMoveLineStart() {
    this.moveToLineStart();
}

ccMoveLineEnd() {
    this.moveToLineEnd();
}

ccMoveWord(direction, mode = "word") {
    this.lastAction = null;
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    if (direction < 0) {
        if (this.state.cursorCol === 0) {
            if (this.state.cursorLine > 0) {
                this.state.cursorLine -= 1;
                const previousLine = this.state.lines[this.state.cursorLine] || "";
                this.setCursorCol(previousLine.length);
            }
            return;
        }
        const target =
            mode === "whitespace"
                ? this.ccWhitespaceBoundaryBackward(currentLine, this.state.cursorCol)
                : this.ccWordBoundaryBackward(currentLine, this.state.cursorCol);
        this.setCursorCol(target);
        return;
    }
    if (this.state.cursorCol >= currentLine.length) {
        if (this.state.cursorLine < this.state.lines.length - 1) {
            this.state.cursorLine += 1;
            this.setCursorCol(0);
        }
        return;
    }
    const target =
        mode === "whitespace"
            ? this.ccWhitespaceBoundaryForward(currentLine, this.state.cursorCol)
            : this.ccWordBoundaryForward(currentLine, this.state.cursorCol);
    this.setCursorCol(target);
}

ccPageScroll(direction) {
    this.pageScroll(direction < 0 ? -1 : 1);
}

// --- measurement (no paint) ---------------------------------------------

/**
 * Cheap fingerprint of every input `ccRenderRows(width)` reads.
 *
 * `render(width).length` is decided by: the width math (`width`, `paddingX`),
 * the terminal height (visible-line cap), the draft text and cursor, the marker
 * registries (paste/image/file ids change grapheme segmentation), the scroll
 * offset and the open completion menu (state, candidate count, selection,
 * visible cap). This string holds exactly those facts and nothing else, so a
 * memoized row count keyed on it can never survive a change that could alter
 * the height. Deliberately absent: `focused` (a zero-width cursor marker and a
 * highlighted cell — row count is unchanged), theme/border text (one border row
 * each) and paste payloads (`layoutText` sees the marker text, not the body).
 */
ccRenderSignature(width) {
    const lines = this.state.lines;
    const ids = (map) => [...map.keys()].sort((a, b) => a - b).join(",");
    const list = this.autocompleteList;
    // The row count of `SelectList.render` depends only on the candidate count,
    // the selection and the visible cap (one line per visible row plus the
    // scroll indicator), never on item text.
    const menu =
        this.autocompleteState !== null && list !== undefined
            ? `${typeof list.getItemCount === "function" ? list.getItemCount() : "?"}:${
                  typeof list.getSelectedIndex === "function" ? list.getSelectedIndex() : "?"
              }`
            : "-";
    return [
        width,
        this.paddingX,
        this.tui.terminal.rows,
        lines.length,
        this.state.cursorLine,
        this.state.cursorCol,
        this.scrollOffset,
        this.autocompleteState ?? "-",
        this.autocompleteMaxVisible,
        menu,
        ids(this.pastes),
        ids(this.imageAttachments),
        ids(this.fileAttachments),
        // Single-line edits mutate `lines[cursorLine]` in place, so the array
        // identity is not enough: the text itself is part of the fingerprint.
        // Lines never contain "\n", so this join is injective per line count.
        lines.join("\n"),
    ].join("\u0000");
}

/**
 * Row count of the next `render(width)` — computed, never painted.
 *
 * `render` builds the same layout and then pushes one top border, the visible
 * layout lines and one bottom border (plus the completion menu rows). It also
 * clamps/adjusts `scrollOffset`, records `lastWidth`/`renderedVisibleLineCount`/
 * `renderedAutocompleteHeight` and emits cursor cells; none of that is painted
 * here, so measuring cannot move the viewport or change a later frame.
 *
 * Wrapping, width and grapheme logic are reused verbatim (`layoutText`,
 * `paddingX` math, `SelectList.render`), never re-implemented. The private
 * fields read here are the ones `render` itself reads; this is the same
 * app-specific seam that already drives CC submission and snapshots.
 */
ccRenderRows(width) {
    // Same width math as `render` (horizontal padding, reserved cursor column).
    const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
    const paddingX = Math.min(this.paddingX, maxPadding);
    const contentWidth = Math.max(1, width - paddingX * 2);
    const layoutWidth = Math.max(1, contentWidth - (paddingX ? 0 : 1));
    const layoutLines = this.layoutText(layoutWidth);
    // Same visible-line cap as `render` (30% of the terminal height, min 5).
    const terminalRows = this.tui.terminal.rows;
    const maxVisibleLines = Math.max(5, Math.floor(terminalRows * 0.3));
    let cursorLineIndex = layoutLines.findIndex((line) => line.hasCursor);
    if (cursorLineIndex === -1) cursorLineIndex = 0;
    // The same scroll adjustment `render` applies, computed on a local copy so
    // the measurement never becomes the next frame's starting offset.
    let offset = this.scrollOffset;
    if (cursorLineIndex < offset) {
        offset = cursorLineIndex;
    } else if (cursorLineIndex >= offset + maxVisibleLines) {
        offset = cursorLineIndex - maxVisibleLines + 1;
    }
    const maxScrollOffset = Math.max(0, layoutLines.length - maxVisibleLines);
    offset = Math.max(0, Math.min(offset, maxScrollOffset));
    // Exactly the slice `render` paints (its `slice` semantics included).
    const visibleLines = layoutLines.slice(offset, offset + maxVisibleLines).length;
    // One top border, the visible layout lines, one bottom border.
    let rows = 2 + visibleLines;
    // An open completion menu paints its own rows below the frame.
    if (this.autocompleteState && this.autocompleteList) {
        rows += this.autocompleteList.render(contentWidth).length;
    }
    return rows;
}

/** Word/punctuation/CJK aware boundaries (Alt+B/F, Option+Delete). */
ccWordBoundaryBackward(text, cursor) {
    return findWordBackward(text, cursor, {
        segment: (value) => this.segment(value, "word"),
        isAtomicSegment: isAtomicMarker,
    });
}

ccWordBoundaryForward(text, cursor) {
    return findWordForward(text, cursor, {
        segment: (value) => this.segment(value, "word"),
        isAtomicSegment: isAtomicMarker,
    });
}

/**
 * Shell-whitespace boundaries (Ctrl+W): paths and flags are one unit.
 * Large-paste markers are atomic, so a kill can never split a marker.
 */
ccWhitespaceBoundaryBackward(text, cursor) {
    const units = [...this.segment(text, "grapheme")].filter((unit) => unit.index < cursor);
    const isSpace = (unit) => !isAtomicMarker(unit.segment) && isWhitespaceChar(unit.segment);
    let index = units.length;
    while (index > 0 && isSpace(units[index - 1])) index -= 1;
    if (index === 0) return 0;
    if (isAtomicMarker(units[index - 1].segment)) return units[index - 1].index;
    while (index > 0 && !isSpace(units[index - 1])) index -= 1;
    return index === 0 ? 0 : units[index].index;
}

ccWhitespaceBoundaryForward(text, cursor) {
    const units = [...this.segment(text, "grapheme")].filter((unit) => unit.index >= cursor);
    const isSpace = (unit) => !isAtomicMarker(unit.segment) && isWhitespaceChar(unit.segment);
    let index = 0;
    while (index < units.length && isSpace(units[index])) index += 1;
    if (index >= units.length) return text.length;
    if (isAtomicMarker(units[index].segment)) return units[index].index + units[index].segment.length;
    while (index < units.length && !isSpace(units[index])) index += 1;
    return index >= units.length ? text.length : units[index].index;
}

// --- deletion / kill ----------------------------------------------------

ccDeleteCharBackward() {
    this.handleBackspace();
}

ccDeleteCharForward() {
    this.handleForwardDelete();
}

ccKillToLineStart() {
    this.deleteToStartOfLine();
}

ccKillToLineEnd() {
    this.deleteToEndOfLine();
}

ccKillWord(direction, mode = "word") {
    // A no-op kill (nothing left of the cursor, col 0 of the first line) must
    // not leave history browsing: the recalled entry and the pre-browsing
    // draft stay reachable (Esc restores it). Only a real deletion is an edit.
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const wasKill = this.lastAction === "kill";
    const backward = direction < 0;
    let changed = false;
    if (backward) {
        if (this.state.cursorCol === 0) {
            if (this.state.cursorLine === 0) return false;
            this.pushUndoSnapshot();
            this.killRing.push("\n", { prepend: true, accumulate: wasKill });
            this.lastAction = "kill";
            const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
            this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
            this.state.lines.splice(this.state.cursorLine, 1);
            this.state.cursorLine -= 1;
            this.setCursorCol(previousLine.length);
            changed = true;
        } else {
            const target =
                mode === "whitespace"
                    ? this.ccWhitespaceBoundaryBackward(currentLine, this.state.cursorCol)
                    : this.ccWordBoundaryBackward(currentLine, this.state.cursorCol);
            if (target === this.state.cursorCol) return false;
            this.pushUndoSnapshot();
            this.killRing.push(currentLine.slice(target, this.state.cursorCol), {
                prepend: true,
                accumulate: wasKill,
            });
            this.lastAction = "kill";
            this.state.lines[this.state.cursorLine] =
                currentLine.slice(0, target) + currentLine.slice(this.state.cursorCol);
            this.setCursorCol(target);
            changed = true;
        }
    } else if (this.state.cursorCol >= currentLine.length) {
        if (this.state.cursorLine >= this.state.lines.length - 1) return false;
        this.pushUndoSnapshot();
        this.killRing.push("\n", { prepend: false, accumulate: wasKill });
        this.lastAction = "kill";
        const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
        this.state.lines[this.state.cursorLine] = currentLine + nextLine;
        this.state.lines.splice(this.state.cursorLine + 1, 1);
        changed = true;
    } else {
        const target =
            mode === "whitespace"
                ? this.ccWhitespaceBoundaryForward(currentLine, this.state.cursorCol)
                : this.ccWordBoundaryForward(currentLine, this.state.cursorCol);
        if (target === this.state.cursorCol) return false;
        this.pushUndoSnapshot();
        this.killRing.push(currentLine.slice(this.state.cursorCol, target), {
            prepend: false,
            accumulate: wasKill,
        });
        this.lastAction = "kill";
        this.state.lines[this.state.cursorLine] =
            currentLine.slice(0, this.state.cursorCol) + currentLine.slice(target);
        changed = true;
    }
    if (!changed) return false;
    this.exitHistoryBrowsing();
    if (this.onChange) {
        this.onChange(this.getText());
    }
    return true;
}

// --- yank / undo --------------------------------------------------------

ccYank() {
    this.yank();
}

ccYankPop() {
    this.yankPop();
}

ccUndo() {
    this.undo();
}

ccUndoDepth() {
    return this.undoStack.length;
}

ccGetKillRing() {
    return [...this.killRing.ring];
}

ccGetPastes() {
    return new Map(this.pastes);
}

// --- history ------------------------------------------------------------

ccHistoryPrevious() {
    this.cancelAutocomplete();
    this.navigateHistory(-1);
}

ccHistoryNext() {
    this.cancelAutocomplete();
    this.navigateHistory(1);
}

ccIsBrowsingHistory() {
    return this.historyIndex > -1;
}

ccGetHistory() {
    return [...this.history];
}

ccSetHistory(entries) {
    this.history = (Array.isArray(entries) ? entries : [])
        .filter((entry) => typeof entry === "string")
        .map((entry) => entry);
    if (this.historyIndex >= this.history.length) {
        this.historyIndex = Math.max(-1, this.history.length - 1);
    }
    // Persisted history carries marker text but no payloads. Keep the markers
    // unresolved (never silently dropped) and reserve their ids so a later paste
    // cannot allocate an id an older entry already points at.
    for (const entry of this.history) {
        this.noteImageMarkerIds(entry);
        this.noteFileMarkerIds(entry);
    }
    // Drop attachment payloads of entries the host no longer lists (bounded registry).
    this.pruneHistoryImages();
    this.pruneHistoryFiles();
}

// --- insertion / submit -------------------------------------------------

ccInsertCharacter(text) {
    this.insertCharacter(text);
}

ccInsertText(text) {
    this.insertTextAtCursor(text);
}

ccPaste(text) {
    this.handlePaste(text);
}

ccInsertNewLine() {
    this.addNewLine();
}

ccSubmit() {
    this.submitValue();
}

ccShouldSubmitOnBackslashEnter(data) {
    return this.shouldSubmitOnBackslashEnter(data, getKeybindings());
}

/**
 * Replace a logical range with text as one atomic undo unit.
 * Positions are clamped; reversed ranges are accepted.
 */
ccReplaceRange(from, to, text, options = {}) {
    const clampPosition = (position) => {
        const line = Math.max(
            0,
            Math.min(
                Math.floor(Number.isFinite(position?.line) ? position.line : 0),
                this.state.lines.length - 1,
            ),
        );
        const col = Math.max(
            0,
            Math.min(
                Math.floor(Number.isFinite(position?.col) ? position.col : 0),
                (this.state.lines[line] || "").length,
            ),
        );
        return { line, col };
    };
    let start = clampPosition(from);
    let end = clampPosition(to);
    if (start.line > end.line || (start.line === end.line && start.col > end.col)) {
        const swap = start;
        start = end;
        end = swap;
    }
    const normalized = this.normalizeText(typeof text === "string" ? text : "");
    if (start.line === end.line && start.col === end.col && normalized.length === 0) {
        return false;
    }
    const lines = this.state.lines;
    const before = (lines[start.line] || "").slice(0, start.col);
    const after = (lines[end.line] || "").slice(end.col);
    if (options.undo !== false) {
        this.pushUndoSnapshot();
    }
    this.lastAction = null;
    this.exitHistoryBrowsing();
    const inserted = normalized.split("\n");
    const replacement =
        inserted.length === 1
            ? [before + normalized + after]
            : [before + inserted[0], ...inserted.slice(1, -1), inserted[inserted.length - 1] + after];
    this.state.lines = [...lines.slice(0, start.line), ...replacement, ...lines.slice(end.line + 1)];
    this.state.cursorLine = start.line + inserted.length - 1;
    this.setCursorCol((inserted[inserted.length - 1] || "").length);
    if (this.onChange) {
        this.onChange(this.getText());
    }
    return true;
}

ccSetCursor(line, col) {
    const targetLine = Math.max(0, Math.min(Math.floor(line), this.state.lines.length - 1));
    this.state.cursorLine = targetLine;
    const targetCol = Math.max(0, Math.min(Math.floor(col), (this.state.lines[targetLine] || "").length));
    this.setCursorCol(targetCol);
}

/**
 * Transpose the two graphemes around the cursor as one undoable edit.
 * Uses Pi's marker-aware grapheme segmentation, so a large-paste marker is
 * moved as a whole and can never be split into raw text.
 */
ccTransposeChars() {
    const line = this.state.lines[this.state.cursorLine] || "";
    if (!line) return false;
    const segments = [...this.segment(line, "grapheme")];
    if (segments.length < 2) return false;
    const cursor = this.state.cursorCol;
    let rightIndex = segments.findIndex((segment) => segment.index === cursor);
    if (rightIndex === -1) {
        if (cursor !== line.length) return false;
        rightIndex = segments.length;
    }
    if (rightIndex === 0) return false;
    const leftIndex = rightIndex === segments.length ? segments.length - 2 : rightIndex - 1;
    const left = segments[leftIndex];
    const right = segments[rightIndex === segments.length ? segments.length - 1 : rightIndex];
    if (!left || !right) return false;
    const end = right.index + right.segment.length;
    const replaced = this.ccReplaceRange(
        { line: this.state.cursorLine, col: left.index },
        { line: this.state.cursorLine, col: end },
        right.segment + left.segment,
    );
    if (!replaced) return false;
    this.ccSetCursor(this.state.cursorLine, end);
    return true;
}

// --- autocomplete -------------------------------------------------------

ccHasAutocompleteProvider() {
    return this.autocompleteProvider !== undefined && this.autocompleteProvider !== null;
}

ccTriggerCompletion() {
    this.handleTabCompletion();
}

/**
 * Re-request candidates for the *current* draft without accepting them.
 * Used when asynchronous metadata settles while the menu is already open.
 * It never pushes undo, changes text or submits: an explicit Tab/Enter accept
 * stays the only apply path. Reuses Pi's request/abort state and debounce, so
 * this adds no Editor state, timer or stdin consumer of its own.
 */
ccRefreshAutocomplete() {
    this.requestAutocomplete({
        force: this.autocompleteState === "force",
        explicitTab: false,
    });
}

ccCancelAutocomplete() {
    this.cancelAutocomplete();
}

ccAutocompleteStep(delta) {
    if (!this.autocompleteList) return false;
    this.autocompleteList.moveSelection(delta < 0 ? -1 : 1);
    return true;
}

ccAutocompletePage(direction) {
    if (!this.autocompleteList) return false;
    const page = Math.max(1, this.autocompleteMaxVisible);
    this.autocompleteList.moveSelection((direction < 0 ? -1 : 1) * page);
    return true;
}

/**
 * Accept the highlighted completion.
 * `trigger` mirrors Pi's two accept paths: "tab" keeps editing after a
 * slash-command completion, "confirm" submits it.
 *
 * `onConfirmSubmit` lets the app run its own submit path *after* the candidate
 * was applied to this same Editor state, so a content-aware payload is captured
 * from the completed text. Without it, `confirm` keeps the historical
 * `submitValue()` behavior for direct seam consumers.
 */
ccAutocompleteAccept(trigger = "tab", onConfirmSubmit) {
    if (!this.autocompleteState || !this.autocompleteList) return false;
    const selected = this.autocompleteList.getSelectedItem();
    if (!selected || !this.autocompleteProvider) {
        this.cancelAutocomplete();
        return true;
    }
    this.pushUndoSnapshot();
    this.lastAction = null;
    const result = this.autocompleteProvider.applyCompletion(
        this.state.lines,
        this.state.cursorLine,
        this.state.cursorCol,
        selected,
        this.autocompletePrefix,
    );
    this.state.lines = result.lines;
    this.state.cursorLine = result.cursorLine;
    this.setCursorCol(result.cursorCol);
    const isSlashCommand = this.autocompletePrefix.startsWith("/");
    this.cancelAutocomplete();
    if (this.onChange) {
        this.onChange(this.getText());
    }
    if (trigger === "confirm" && isSlashCommand) {
        if (typeof onConfirmSubmit === "function") onConfirmSubmit();
        else this.submitValue();
        return true;
    }
    return true;
}
}

class SelectListSeam {
// ========================================================================
// DSH TUI completion-list seam for the vendored Pi TUI 1.5.0.
// Additions only; lets the CC keymap drive completion navigation with
// configurable keys instead of Pi's global select keybindings.
// Upstream: @earendil-works/pi-tui 1.5.0 (MIT), Copyright (c) 2025 Mario Zechner.
// ========================================================================
getSelectedIndex() {
    return this.selectedIndex;
}
getItemCount() {
    return this.filteredItems.length;
}
/** Move the highlight by `delta`, wrapping like the arrow-key handling. */
moveSelection(delta) {
    const count = this.filteredItems.length;
    if (count === 0) return;
    const step = Math.trunc(delta);
    const next = (((this.selectedIndex + step) % count) + count) % count;
    this.setSelectedIndex(next);
}
}

function copySeamMethods(target, source) {
  for (const name of Object.getOwnPropertyNames(source.prototype)) {
    if (name === "constructor") continue
    Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(source.prototype, name))
  }
}

/**
 * Keep history browsing across a no-op deletion.
 *
 * Pi's vendored deletion helpers call `exitHistoryBrowsing()` before checking
 * whether there is anything to delete. A no-op Backspace/Delete/Ctrl+U/Ctrl+K
 * must not discard the recalled entry or the pre-browsing draft; only a real
 * edit ends browsing. These wrappers are the smallest seam because the vendored
 * source remains untouched.
 */
function preserveHistoryOnNoop(name, isNoop) {
  const original = Editor.prototype[name]
  Object.defineProperty(Editor.prototype, name, {
    configurable: true,
    writable: true,
    value: function (...args) {
      if (this.ccIsBrowsingHistory && this.ccIsBrowsingHistory() && isNoop(this)) return
      return Reflect.apply(original, this, args)
    },
  })
}

/**
 * Deletion methods whose no-op must not end history browsing.
 *
 * `handleBackspace`/`handleForwardDelete` are the keys, `deleteToStartOfLine`
 * is Ctrl+U and `deleteToEndOfLine` is Ctrl+K.
 */
const HISTORY_NOOP_WRAPPERS = [
  ["handleBackspace", editor => editor.state.cursorLine === 0 && editor.state.cursorCol === 0],
  ["deleteToStartOfLine", editor => editor.state.cursorLine === 0 && editor.state.cursorCol === 0],
  [
    "handleForwardDelete",
    editor => {
      const line = editor.state.lines[editor.state.cursorLine] || ""
      return editor.state.cursorLine === editor.state.lines.length - 1 && editor.state.cursorCol >= line.length
    },
  ],
  [
    "deleteToEndOfLine",
    editor => {
      const line = editor.state.lines[editor.state.cursorLine] || ""
      return editor.state.cursorLine === editor.state.lines.length - 1 && editor.state.cursorCol >= line.length
    },
  ],
]

export function installPiTuiSeam() {
  if (installed) return
  copySeamMethods(Editor.prototype, EditorSeam)
  copySeamMethods(SelectList.prototype, SelectListSeam)
  // Install-time assertion, not a log line: silently skipping a wrapper would
  // quietly lose a documented rule (history browsing would end on a no-op
  // Ctrl+K/Backspace/Delete), so a vendored refresh that renames one of these
  // methods fails loudly here instead.
  const missing = HISTORY_NOOP_WRAPPERS.map(([name]) => name).filter(
    (name) => typeof Editor.prototype[name] !== "function",
  )
  if (missing.length > 0) {
    throw new Error(
      `pi-tui seam: Editor no longer exposes ${missing.join(", ")}; ` +
        "the history-preserving no-op wrapper cannot be installed (see src/input/pi-tui-seam.js).",
    )
  }
  installed = true
  for (const [name, isNoop] of HISTORY_NOOP_WRAPPERS) preserveHistoryOnNoop(name, isNoop)
}
