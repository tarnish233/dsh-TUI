/**
 * Vertical cursor movement measures terminal display columns, not UTF-16 offsets.
 *
 * A CJK ideograph is 1 UTF-16 unit but 2 terminal columns; a ZWJ emoji family is
 * 11 UTF-16 units but 2 columns; a combining sequence is 2 units but 1 column.
 * Sticky-column movement that subtracts UTF-16 offsets therefore loses the
 * caret's real column as soon as the text is not plain ASCII: the caret jumps
 * sideways, clamps to the wrong place, and can even land inside a grapheme
 * cluster (a following keystroke then splits it). These tests pin the display
 * column (the column the renderer wraps at) and grapheme boundaries.
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  asTui,
  createFakeTui,
  loadInputModule,
  renderAt,
  testEditorTheme,
} from "../src/input/testing/harness.ts"
import type { CcEditorOptions } from "../src/input/index.ts"
import { visibleWidth } from "#pi-tui"

const mod = await loadInputModule()

const FAMILY = "👨‍👩‍👧‍👦"
const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" })

function makeEditor(options: CcEditorOptions = {}) {
  const tui = createFakeTui()
  const editor = new mod.CcEditor(asTui(tui), testEditorTheme, options)
  return { editor, tui }
}

/** Terminal display column of the caret (what the user actually sees). */
function displayColumn(editor: { getCursor(): { line: number; col: number }; getLines(): string[] }): number {
  const { line, col } = editor.getCursor()
  return visibleWidth((editor.getLines()[line] ?? "").slice(0, col))
}

/** True when the caret sits on a grapheme boundary (or at the end of the line). */
function onGraphemeBoundary(editor: { getCursor(): { line: number; col: number }; getLines(): string[] }): boolean {
  const { line, col } = editor.getCursor()
  const text = editor.getLines()[line] ?? ""
  if (col === text.length) return true
  for (const segment of graphemeSegmenter.segment(text)) {
    if (segment.index === col) return true
  }
  return false
}

test("vertical movement keeps the display column across CJK and ASCII lines", () => {
  const { editor } = makeEditor()
  editor.setText("abcdefghij\n日本語日本語")
  editor.ccSetCursor(0, 6)
  renderAt(editor, 40)
  assert.equal(displayColumn(editor), 6)

  editor.handleInput("\x1b[B") // Down
  assert.deepEqual(editor.getCursor(), { line: 1, col: 3 }, "display column 6 = after 日本語")
  assert.equal(displayColumn(editor), 6)

  editor.handleInput("\x1b[A") // Up
  assert.deepEqual(editor.getCursor(), { line: 0, col: 6 })
  assert.equal(displayColumn(editor), 6)

  // The reverse direction: a wide line's caret column is not its UTF-16 length.
  const wide = makeEditor()
  wide.editor.setText("日本語日本語\nabcdefghij")
  wide.editor.ccSetCursor(0, 6)
  renderAt(wide.editor, 40)
  assert.equal(displayColumn(wide.editor), 12)
  wide.editor.handleInput("\x1b[B")
  assert.deepEqual(wide.editor.getCursor(), { line: 1, col: 10 }, "display column 12 clamps to the ASCII line end")
  assert.equal(displayColumn(wide.editor), 10)
})

test("vertical movement handles ZWJ families, variation selectors and combining marks", () => {
  // ZWJ family: 11 UTF-16 units, 2 display columns.
  const zwj = makeEditor()
  zwj.editor.setText(`${FAMILY}x\nabcdefgh`)
  zwj.editor.ccSetCursor(0, `${FAMILY}x`.length)
  renderAt(zwj.editor, 40)
  assert.equal(displayColumn(zwj.editor), 3)
  zwj.editor.handleInput("\x1b[B")
  assert.deepEqual(zwj.editor.getCursor(), { line: 1, col: 3 })
  assert.equal(displayColumn(zwj.editor), 3)

  // Moving *into* a wide-cluster line must land on a grapheme boundary at the
  // requested display column, never inside a cluster.
  const into = makeEditor()
  into.editor.setText(`abcdefghij\n${FAMILY}${FAMILY}`)
  into.editor.ccSetCursor(0, 8)
  renderAt(into.editor, 40)
  into.editor.handleInput("\x1b[B")
  assert.equal(displayColumn(into.editor), 4, "display column 8 clamps to the wide line's width (4)")
  assert.deepEqual(into.editor.getCursor(), { line: 1, col: FAMILY.length * 2 })
  assert.equal(onGraphemeBoundary(into.editor), true)
  // A keystroke right after the move keeps both clusters intact.
  into.editor.handleInput("Z")
  assert.equal(into.editor.getText(), `abcdefghij\n${FAMILY}${FAMILY}Z`)

  // Combining mark: "cafe\u0301" is 5 UTF-16 units but 4 display columns.
  const combining = makeEditor()
  combining.editor.setText("cafe\u0301\nabcdefgh")
  combining.editor.ccSetCursor(0, "cafe\u0301".length)
  renderAt(combining.editor, 40)
  assert.equal(displayColumn(combining.editor), 4)
  combining.editor.handleInput("\x1b[B")
  assert.deepEqual(combining.editor.getCursor(), { line: 1, col: 4 })
  assert.equal(displayColumn(combining.editor), 4)

  // Variation selector: "❤️" is 2 UTF-16 units and 2 display columns, so the
  // cluster still has to be treated as one grapheme.
  const variant = makeEditor()
  variant.editor.setText("❤️x\nabcdefgh")
  variant.editor.ccSetCursor(0, "❤️x".length)
  renderAt(variant.editor, 40)
  variant.editor.handleInput("\x1b[B")
  assert.deepEqual(variant.editor.getCursor(), { line: 1, col: 3 })
  assert.equal(displayColumn(variant.editor), 3)
})

test("the desired display column is sticky through a shorter wide line", () => {
  const { editor } = makeEditor()
  editor.setText("日本語日本語\nabc\nabcdef日本語abcdef")
  editor.ccSetCursor(0, 6) // end of the wide line: display column 12
  renderAt(editor, 40)
  assert.equal(displayColumn(editor), 12)

  editor.handleInput("\x1b[B") // shorter line: clamp, remember 12
  assert.deepEqual(editor.getCursor(), { line: 1, col: 3 })
  assert.equal(displayColumn(editor), 3)

  editor.handleInput("\x1b[B") // long line fitting display column 12
  assert.equal(displayColumn(editor), 12)
  assert.deepEqual(editor.getCursor(), { line: 2, col: 9 }, "display 12 = after 'abcdef' + 日本語")

  // Coming back up restores the sticky display column, not a UTF-16 offset.
  editor.handleInput("\x1b[A")
  assert.deepEqual(editor.getCursor(), { line: 1, col: 3 })
  editor.handleInput("\x1b[A")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 6 })
  assert.equal(displayColumn(editor), 12)
})

test("wrapped mixed-width lines move inside the visual line and stay in its chunk", () => {
  // Width 6 leaves a 5-column layout: "日本" | "語" | "abcde" | "fg".
  const { editor } = makeEditor()
  editor.setText("日本語abcdefg")
  editor.ccSetCursor(0, 1) // display column 2, between 日 and 本
  renderAt(editor, 6)
  assert.equal(displayColumn(editor), 2)

  editor.handleInput("\x1b[B")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 2 }, "the single wide grapheme owns its whole chunk")
  assert.equal(displayColumn(editor), 4)

  editor.handleInput("\x1b[B") // "abcde"
  assert.deepEqual(editor.getCursor(), { line: 0, col: 5 })
  assert.equal(displayColumn(editor), 8)

  editor.handleInput("\x1b[B") // "fg"
  assert.deepEqual(editor.getCursor(), { line: 0, col: 10 })
  assert.equal(displayColumn(editor), 13, "the last visual line ends at the display end of the text")

  editor.handleInput("\x1b[A")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 5 })
  assert.equal(displayColumn(editor), 8)

  // Every landing position is a grapheme boundary: typing never splits a
  // cluster, and the wrapped CJK text survives the whole round trip.
  const visited: Array<{ line: number; col: number }> = []
  for (let step = 0; step < 4; step += 1) {
    editor.handleInput("\x1b[A")
    visited.push({ ...editor.getCursor() })
    assert.equal(onGraphemeBoundary(editor), true, `boundary after Up ${step}`)
  }
  assert.deepEqual(visited, [
    { line: 0, col: 2 },
    { line: 0, col: 1 },
    { line: 0, col: 1 },
    { line: 0, col: 1 },
  ])
  assert.equal(displayColumn(editor), 2, "a wide chunk clamps to the base of its last grapheme")
  assert.equal(editor.getText(), "日本語abcdefg")
})

/**
 * R5: a desired display column that falls *inside* a 2-column grapheme (CJK,
 * emoji, ZWJ family) is rounded down to the cluster start — correctly, so the
 * caret never splits a cluster — but the unrounded goal must survive. Otherwise
 * the next vertical move measures the clamped caret, reads it as "the user
 * moved horizontally" and drops the sticky column (drift left by one column per
 * pass). Every case below is driven by real key input through the one editor
 * state; no external setText movement emulation.
 */
test("R5: the desired display column survives a mid-wide-grapheme clamp (review repro)", () => {
  const { editor } = makeEditor()
  editor.setText("abcdefgh\na漢cdefg\nabcdefgh")
  editor.ccSetCursor(0, 2)
  renderAt(editor, 40)
  assert.equal(displayColumn(editor), 2)

  editor.handleInput("\x1b[B") // down: display 2 is inside 漢 (columns 1-3)
  assert.deepEqual(editor.getCursor(), { line: 1, col: 1 }, "rounds down to the cluster start")
  assert.equal(displayColumn(editor), 1)
  assert.equal(onGraphemeBoundary(editor), true)

  editor.handleInput("\x1b[B") // down: goal column 2 is restored, not column 1
  assert.deepEqual(editor.getCursor(), { line: 2, col: 2 })
  assert.equal(displayColumn(editor), 2)

  editor.handleInput("\x1b[A") // up through the clamped caret
  assert.deepEqual(editor.getCursor(), { line: 1, col: 1 })
  editor.handleInput("\x1b[A")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 2 }, "round trip ends at the original column, not (0,1)")
  assert.equal(displayColumn(editor), 2)

  // The same path starting with Up, and through *two* consecutive clamping lines.
  const upFirst = makeEditor()
  upFirst.editor.setText("abcdefgh\na漢cdefg\nabcdefgh")
  upFirst.editor.ccSetCursor(2, 2)
  renderAt(upFirst.editor, 40)
  for (const expected of [
    { line: 1, col: 1 },
    { line: 0, col: 2 },
    { line: 1, col: 1 },
    { line: 2, col: 2 },
  ]) {
    upFirst.editor.handleInput(expected.line < upFirst.editor.getCursor().line ? "\x1b[A" : "\x1b[B")
    assert.deepEqual(upFirst.editor.getCursor(), expected)
  }

  const repeated = makeEditor()
  repeated.editor.setText("abcdefgh\na漢cdefg\na漢cdefg\nabcdefgh")
  repeated.editor.ccSetCursor(0, 2)
  renderAt(repeated.editor, 40)
  for (const expected of [
    { line: 1, col: 1 },
    { line: 2, col: 1 },
    { line: 3, col: 2 },
    { line: 2, col: 1 },
    { line: 1, col: 1 },
    { line: 0, col: 2 },
  ]) {
    const line = repeated.editor.getCursor().line
    repeated.editor.handleInput(expected.line > line ? "\x1b[B" : "\x1b[A")
    assert.deepEqual(repeated.editor.getCursor(), expected)
    assert.equal(onGraphemeBoundary(repeated.editor), true)
  }
  assert.equal(repeated.editor.getText(), "abcdefgh\na漢cdefg\na漢cdefg\nabcdefgh")
})

test("R5: a ZWJ/emoji clamp keeps the desired display column", () => {
  // Two ZWJ families: 2 display columns each, 11 UTF-16 units each.
  const { editor } = makeEditor()
  editor.setText(`${FAMILY}${FAMILY}\nabcdefgh\nabcdefgh`)
  editor.ccSetCursor(2, 3)
  renderAt(editor, 40)
  assert.equal(displayColumn(editor), 3)

  editor.handleInput("\x1b[A") // ASCII line, display 3
  assert.deepEqual(editor.getCursor(), { line: 1, col: 3 })
  editor.handleInput("\x1b[A") // display 3 is inside the second family (columns 2-4)
  assert.deepEqual(editor.getCursor(), { line: 0, col: FAMILY.length })
  assert.equal(displayColumn(editor), 2)
  assert.equal(onGraphemeBoundary(editor), true)

  editor.handleInput("\x1b[B") // goal column 3 survives the clamp
  assert.deepEqual(editor.getCursor(), { line: 1, col: 3 })
  assert.equal(displayColumn(editor), 3)
  editor.handleInput("\x1b[B")
  assert.deepEqual(editor.getCursor(), { line: 2, col: 3 })
  editor.handleInput("Z") // typing at the landed column never splits a cluster
  assert.equal(editor.getText(), `${FAMILY}${FAMILY}\nabcdefgh\nabcZdefgh`)
  assert.equal(onGraphemeBoundary(editor), true)
})

test("R5: a short line between the clamp and the goal keeps the desired column", () => {
  const { editor } = makeEditor()
  editor.setText("abcdefgh\na漢cdefg\nxy\nabcdefgh")
  editor.ccSetCursor(0, 2)
  renderAt(editor, 40)
  const visited: Array<{ line: number; col: number }> = [
    { line: 1, col: 1 },
    { line: 2, col: 2 },
    { line: 3, col: 2 },
    { line: 2, col: 2 },
    { line: 1, col: 1 },
    { line: 0, col: 2 },
  ]
  for (const expected of visited) {
    const line = editor.getCursor().line
    editor.handleInput(expected.line > line ? "\x1b[B" : "\x1b[A")
    assert.deepEqual(editor.getCursor(), expected)
  }
})

test("R5: a softwrapped mid-glyph chunk keeps the desired display column", () => {
  // Width 8 leaves a 7-column layout: "abcdefg" | "abcd漢e" | "fg".
  const { editor } = makeEditor()
  editor.setText("abcdefg\nabcd漢efg")
  editor.ccSetCursor(0, 5)
  renderAt(editor, 8)
  assert.equal(displayColumn(editor), 5)

  editor.handleInput("\x1b[B") // display 5 is inside 漢 (columns 4-6) of the wrapped chunk
  assert.deepEqual(editor.getCursor(), { line: 1, col: 4 })
  assert.equal(displayColumn(editor), 4)
  assert.equal(onGraphemeBoundary(editor), true)

  editor.handleInput("\x1b[B") // continuation chunk: clamp, remember 5
  assert.deepEqual(editor.getCursor(), { line: 1, col: 8 })
  editor.handleInput("\x1b[A") // back into the wide chunk: display 5 again
  assert.deepEqual(editor.getCursor(), { line: 1, col: 4 })
  editor.handleInput("\x1b[A")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 5 }, "the desired column, not the clamped one")
  assert.equal(displayColumn(editor), 5)
  assert.equal(editor.getText(), "abcdefg\nabcd漢efg", "movement never edits the draft")
})

test("R5: page scroll through a mid-glyph clamp keeps the desired display column", () => {
  const tui = createFakeTui(20) // page size 6
  const editor = new mod.CcEditor(asTui(tui), testEditorTheme)
  editor.setText(["abcdefgh", "a漢cdefg", ...Array(6).fill("abcdefgh")].join("\n"))
  editor.ccSetCursor(0, 2)
  renderAt(editor, 40)

  editor.handleInput("\x1b[B") // clamp to display column 1, goal column 2
  assert.deepEqual(editor.getCursor(), { line: 1, col: 1 })
  editor.ccPageScroll(1)
  assert.deepEqual(editor.getCursor(), { line: 7, col: 2 }, "page down uses the goal, not the clamped column")
  assert.equal(displayColumn(editor), 2)
  editor.ccPageScroll(-1)
  assert.deepEqual(editor.getCursor(), { line: 1, col: 1 })
  editor.handleInput("\x1b[A")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 2 })
  assert.equal(displayColumn(editor), 2)
})

test("R5: horizontal, cursor-placement and edit changes drop the clamped goal", () => {
  // Left+Right returns to the *same* caret: only an explicit reset can explain
  // the next Down targeting column 1 instead of the stale goal column 2.
  const { editor } = makeEditor()
  editor.setText("abcdefgh\na漢cdefg\nabcdefgh")
  editor.ccSetCursor(0, 2)
  renderAt(editor, 40)
  editor.handleInput("\x1b[B")
  assert.deepEqual(editor.getCursor(), { line: 1, col: 1 })
  editor.handleInput("\x1b[D")
  editor.handleInput("\x1b[C")
  assert.deepEqual(editor.getCursor(), { line: 1, col: 1 })
  editor.handleInput("\x1b[B")
  assert.deepEqual(editor.getCursor(), { line: 2, col: 1 }, "a horizontal move clears the sticky goal")

  // Programmatic cursor placement (click/`setText` path) is also a reset.
  const placed = makeEditor()
  placed.editor.setText("abcdefgh\na漢cdefg\nabcdefgh")
  placed.editor.ccSetCursor(0, 2)
  renderAt(placed.editor, 40)
  placed.editor.handleInput("\x1b[B")
  placed.editor.ccSetCursor(1, 1)
  placed.editor.handleInput("\x1b[B")
  assert.deepEqual(placed.editor.getCursor(), { line: 2, col: 1 })

  // An edit at the clamped caret re-measures from the new position.
  const edited = makeEditor()
  edited.editor.setText("abcdefgh\na漢cdefg\nabcdefgh")
  edited.editor.ccSetCursor(0, 2)
  renderAt(edited.editor, 40)
  edited.editor.handleInput("\x1b[B")
  edited.editor.handleInput("Z")
  assert.equal(edited.editor.getText(), "abcdefgh\naZ漢cdefg\nabcdefgh")
  edited.editor.handleInput("\x1b[B")
  assert.deepEqual(edited.editor.getCursor(), { line: 2, col: 2 })
})

test("R5: a draft snapshot keeps the clamped goal across restore", () => {
  const { editor } = makeEditor()
  editor.setText("abcdefgh\na漢cdefg\nabcdefgh")
  editor.ccSetCursor(0, 2)
  renderAt(editor, 40)
  editor.handleInput("\x1b[B")
  assert.deepEqual(editor.getCursor(), { line: 1, col: 1 })
  const snapshot = editor.captureDraft()
  // The goal carries the layout width it was measured in (39 = 40 - 1 for the
  // cursor column at paddingX 0), so it can never be replayed in another wrap.
  assert.deepEqual(snapshot.verticalGoal, { cursorLine: 1, cursorCol: 1, visualCol: 2, width: 39 })

  // Same one editor state, restored into a fresh instance (stash/external editor).
  const restored = makeEditor()
  restored.editor.restoreDraft(snapshot)
  renderAt(restored.editor, 40)
  assert.deepEqual(restored.editor.getCursor(), { line: 1, col: 1 })
  restored.editor.handleInput("\x1b[B")
  assert.deepEqual(restored.editor.getCursor(), { line: 2, col: 2 }, "the goal survives the round trip")
  restored.editor.handleInput("\x1b[A")
  restored.editor.handleInput("\x1b[A")
  assert.deepEqual(restored.editor.getCursor(), { line: 0, col: 2 })
})

test("R5: a resize drops the stale clamped goal and honours the rewrapped source column", () => {
  // 15/13/15 columns at paddingX 0: width 40 wraps to layoutWidth 39 (no wrap),
  // width 6 wraps to layoutWidth 5, where the same caret (1,6) belongs to a
  // different visual chunk. The goal recorded at the old width must not
  // override the source column the resize recomputed.
  const text = "abcdefghijklmno\nabcdef漢ijklm\nabcdefghijklmno"
  const make = () => makeEditor({ paddingX: 0 }).editor

  const resized = make()
  resized.setText(text)
  resized.ccSetCursor(0, 7)
  renderAt(resized, 40)
  resized.handleInput("\x1b[B")
  assert.deepEqual(resized.getCursor(), { line: 1, col: 6 }, "display column 7 rounds to the cluster start at 6")
  assert.equal(displayColumn(resized), 6)
  renderAt(resized, 6)
  resized.handleInput("\x1b[B")
  const down = { ...resized.getCursor() }

  // Control 1: the same caret placed directly in the new layout (no goal at all).
  const control = make()
  control.setText(text)
  control.ccSetCursor(1, 6)
  renderAt(control, 6)
  control.handleInput("\x1b[B")
  // Control 2: the goal explicitly cleared by a horizontal round trip, which
  // returns the caret to exactly (1,6) in the new layout.
  const cleared = make()
  cleared.setText(text)
  cleared.ccSetCursor(0, 7)
  renderAt(cleared, 40)
  cleared.handleInput("\x1b[B")
  renderAt(cleared, 6)
  cleared.handleInput("\x1b[D")
  cleared.handleInput("\x1b[C")
  assert.deepEqual(cleared.getCursor(), { line: 1, col: 6 })
  cleared.handleInput("\x1b[B")

  assert.deepEqual(down, { line: 1, col: 8 }, "the rewrapped source column (display 1) drives the move")
  assert.deepEqual(down, control.getCursor(), "identical to a caret that never had a goal")
  assert.deepEqual(down, cleared.getCursor(), "identical to a reset goal")
  assert.notDeepEqual(down, { line: 1, col: 12 }, "the stale goal's column 7 must not target the new line end")

  // Up direction after a resize follows the same rule.
  const up = make()
  up.setText(text)
  up.ccSetCursor(2, 7)
  renderAt(up, 40)
  up.handleInput("\x1b[A")
  assert.deepEqual(up.getCursor(), { line: 1, col: 6 })
  renderAt(up, 6)
  up.handleInput("\x1b[A")
  const upControl = make()
  upControl.setText(text)
  upControl.ccSetCursor(1, 6)
  renderAt(upControl, 6)
  upControl.handleInput("\x1b[A")
  assert.deepEqual(up.getCursor(), { line: 1, col: 1 })
  assert.deepEqual(up.getCursor(), upControl.getCursor(), "no stale goal, no jump")

  // Same width: the clamp goal is still reused (the fix, not a regression).
  const sameWidth = make()
  sameWidth.setText("abcdefgh\na漢cdefg\nabcdefgh")
  sameWidth.ccSetCursor(0, 2)
  renderAt(sameWidth, 40)
  sameWidth.handleInput("\x1b[B")
  sameWidth.handleInput("\x1b[B")
  assert.deepEqual(sameWidth.getCursor(), { line: 2, col: 2 })
})

test("R5: a restored draft snapshot drops the goal when the render width changed", () => {
  const text = "abcdefghijklmno\nabcdef漢ijklm\nabcdefghijklmno"
  const source = makeEditor({ paddingX: 0 }).editor
  source.setText(text)
  source.ccSetCursor(0, 7)
  renderAt(source, 40)
  source.handleInput("\x1b[B")
  const snapshot = source.captureDraft()
  assert.deepEqual(snapshot.verticalGoal, { cursorLine: 1, cursorCol: 6, visualCol: 7, width: 39 })

  // Restored into a different layout: the goal is not replayed.
  const narrow = makeEditor({ paddingX: 0 }).editor
  narrow.restoreDraft(snapshot)
  renderAt(narrow, 6)
  assert.equal(narrow.getCursor().line, 1)
  assert.equal(narrow.getCursor().col, 6)
  narrow.handleInput("\x1b[B")
  assert.deepEqual(narrow.getCursor(), { line: 1, col: 8 })

  // Restored into the same layout: the clamped goal still works as before.
  const wide = makeEditor({ paddingX: 0 }).editor
  wide.restoreDraft(snapshot)
  renderAt(wide, 40)
  wide.handleInput("\x1b[B")
  assert.deepEqual(wide.getCursor(), { line: 2, col: 7 }, "display column 7 = after 'abcdef漢'")

  // An older/synthetic snapshot without a usable width drops the goal instead
  // of guessing (fail closed), and the draft still restores.
  const legacy = makeEditor({ paddingX: 0 }).editor
  const stripped = { ...snapshot, verticalGoal: { cursorLine: 1, cursorCol: 6, visualCol: 7 } }
  legacy.restoreDraft(stripped as typeof snapshot)
  renderAt(legacy, 40)
  legacy.handleInput("\x1b[B")
  assert.deepEqual(legacy.getCursor(), { line: 2, col: 6 }, "no goal: the measured column (display 6) drives the move")
})

test("wide-character history browsing still uses visual lines first", () => {
  const { editor } = makeEditor()
  editor.addToHistory("HIST")
  editor.setText("日本語日本語日本語")
  editor.ccSetCursor(0, 0)
  renderAt(editor, 8) // 7-column layout: wraps into several visual lines
  assert.equal(editor.ccIsOnFirstVisualLine(), true)

  editor.handleInput("\x1b[B") // Down from the first visual line stays in the draft
  assert.equal(editor.getText(), "日本語日本語日本語")
  assert.ok(!editor.ccIsOnFirstVisualLine())

  editor.handleInput("\x1b[A")
  assert.equal(editor.ccIsOnFirstVisualLine(), true)
  assert.equal(editor.getText(), "日本語日本語日本語", "Up on the first visual line has not browsed yet")

  editor.handleInput("\x1b[A") // Up on the first visual line browses history
  assert.equal(editor.getText(), "HIST")
})