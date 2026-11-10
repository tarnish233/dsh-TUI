/**
 * `CcEditor.measureRows(width)` — the dock editor's row count without a paint.
 *
 * The dock budget needs the editor height before it lays the transcript out, and
 * `docs/FRONTEND-CONTRACT.md` forbids re-rendering a member to count its rows.
 * These regressions pin the contract the parent relies on:
 *
 * 1. `measureRows(width) === render(width).length` for every draft shape,
 *    width and terminal height;
 * 2. measuring emits nothing and changes no editor state, so the render that
 *    follows a measurement is byte-identical (the viewport never moves);
 * 3. repeated measurements of unchanged state perform no layout at all
 *    (memoized), while every input the row count depends on invalidates it:
 *    text (including in-place single-line edits), cursor, scroll, width,
 *    terminal height, padding, paste/image/file marker registries and the
 *    completion menu.
 *
 * Layouts are counted by instrumenting the vendored `Editor.layoutText`, i.e. the
 * one wrapping implementation both the paint and the measurement use. No second
 * wrap algorithm is asserted against — it is the same function.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { Editor, type AutocompleteProvider } from "#pi-tui"

import {
  asTui,
  createFakeTui,
  loadInputModule,
  renderAt,
  testEditorTheme,
  typeText,
} from "../src/input/testing/harness.ts"

const mod = await loadInputModule()
type TestEditor = InstanceType<typeof mod.CcEditor>

// --- layout counter -----------------------------------------------------

/**
 * Private editor fields this test inspects: the render/scroll geometry
 * (`render` is the only writer) and the layout entry point being counted.
 */
interface EditorInternals {
  scrollOffset: number
  lastWidth: number
  renderedVisibleLineCount: number
  renderedAutocompleteHeight: number
  layoutText(width: number): Array<{ text: string; hasCursor: boolean; cursorPos?: number }>
}

const internals = (editor: { render(width: number): string[] }): EditorInternals =>
  editor as unknown as EditorInternals

let layouts = 0

/** Count every full layout (paint or measurement) by wrapping the vendored one. */
function instrumentLayouts(): () => void {
  const prototype = Editor.prototype as unknown as EditorInternals
  const original = prototype.layoutText
  prototype.layoutText = function (this: EditorInternals, width: number) {
    layouts += 1
    return original.call(this, width)
  }
  return () => {
    prototype.layoutText = original
  }
}

// The seam is installed by the input module; instrument before any editor work.
const restoreLayouts = instrumentLayouts()
test.after(() => restoreLayouts())

// --- helpers ------------------------------------------------------------

interface EditorState {
  text: string
  expandedText: string
  cursor: { line: number; col: number }
  /** Render geometry `render` writes and a measurement must not. */
  scrollOffset: number
  lastWidth: number
  renderedVisibleLineCount: number
  renderedAutocompleteHeight: number
  /** Native editing state a measurement must not touch either. */
  undoDepth: number
  killRing: string[]
  pasteIds: string
  imageIds: string
  fileIds: string
  autocomplete: boolean
  autocompleteSelection: number | undefined
  historyIndex: number
}

const editorState = (editor: TestEditor): EditorState => {
  const state = internals(editor)
  return {
    text: editor.getText(),
    expandedText: editor.getExpandedText(),
    cursor: editor.getCursor(),
    scrollOffset: state.scrollOffset,
    lastWidth: state.lastWidth,
    renderedVisibleLineCount: state.renderedVisibleLineCount,
    renderedAutocompleteHeight: state.renderedAutocompleteHeight,
    undoDepth: editor.ccUndoDepth(),
    killRing: editor.ccGetKillRing(),
    pasteIds: [...editor.ccGetPastes().keys()].sort((a, b) => a - b).join(","),
    imageIds: editor
      .getImageAttachmentEntries()
      .map(([id]) => id)
      .sort((a, b) => a - b)
      .join(","),
    fileIds: editor
      .getFileAttachmentEntries()
      .map(([id]) => id)
      .sort((a, b) => a - b)
      .join(","),
    autocomplete: editor.isShowingAutocomplete(),
    autocompleteSelection: editor.isShowingAutocomplete()
      ? (editor as unknown as { autocompleteList?: { getSelectedIndex(): number } }).autocompleteList?.getSelectedIndex()
      : undefined,
    historyIndex: editor.captureDraft().historyIndex,
  }
}

function makeEditor(rows = 40, options: ConstructorParameters<typeof mod.CcEditor>[2] = {}) {
  const tui = createFakeTui(rows, 80)
  const editor = new mod.CcEditor(asTui(tui), testEditorTheme, options)
  return { editor, tui }
}

const WIDTHS = [1, 4, 8, 12, 20, 40, 80, 120] as const

/**
 * The whole contract for one editor state: paint, measure, measure again.
 *
 * The paint runs first so `scrollOffset` already holds the value the frame uses;
 * a measurement that moved the viewport would show up as a different second
 * paint, and a measurement that re-laid out unchanged state would show up in the
 * layout counter.
 */
function assertMeasured(editor: TestEditor, label: string, widths: readonly number[] = WIDTHS): void {
  for (const width of widths) {
    const painted = editor.render(width)
    const before = editorState(editor)

    layouts = 0
    const measured = editor.measureRows(width)
    const measureLayouts = layouts
    assert.equal(measured, painted.length, `${label} @${width}: measureRows !== render().length`)
    assert.notEqual(measureLayouts, 0, `${label} @${width}: a fresh measurement lays the text out once`)
    assert.deepEqual(editorState(editor), before, `${label} @${width}: measuring changed editor/render state`)

    // Painting after a measurement is byte-identical: the viewport did not move.
    assert.deepEqual(editor.render(width), painted, `${label} @${width}: render after measure differs`)

    // Same state, same width: memoized, so no second layout.
    layouts = 0
    for (let repeat = 0; repeat < 5; repeat += 1) {
      assert.equal(editor.measureRows(width), painted.length, `${label} @${width}: repeat measurement drifted`)
    }
    assert.equal(layouts, 0, `${label} @${width}: repeated measurements re-laid out the draft`)
  }
}

/** Mutating one input must invalidate the memoized count (it re-lays out). */
function assertInvalidated(editor: TestEditor, label: string, width: number): number {
  layouts = 0
  const measured = editor.measureRows(width)
  assert.equal(layouts, 1, `${label}: a mutation must invalidate the memoized row count (layouts: ${layouts})`)
  assert.equal(measured, editor.render(width).length, `${label}: stale measurement after a mutation`)
  return measured
}

const autocompleteProvider = (): AutocompleteProvider => ({
  triggerCharacters: ["@"],
  async getSuggestions() {
    return {
      items: [
        { value: "@alpha", label: "@alpha" },
        { value: "@beta", label: "@beta" },
        { value: "@gamma", label: "@gamma" },
      ],
      prefix: "@",
    }
  },
  applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
    const line = lines[cursorLine] ?? ""
    const start = cursorCol - prefix.length
    return {
      lines: [line.slice(0, start) + item.value + line.slice(cursorCol)],
      cursorLine,
      cursorCol: start + item.value.length,
    }
  },
})

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// --- 1. measureRows === render().length across the matrix ---------------

test("measureRows equals render(width).length for every draft shape", () => {
  // Empty draft.
  const empty = makeEditor()
  renderAt(empty.editor, 80)
  assertMeasured(empty.editor, "empty")
  assert.equal(empty.editor.measureRows(80), 3, "top border + cursor row + bottom border")

  // One logical line.
  const single = makeEditor()
  single.editor.setText("hello world")
  assertMeasured(single.editor, "single line")

  // Soft wraps: a long single line re-wraps per width.
  const wrapping = makeEditor()
  wrapping.editor.setText("the quick brown fox jumps over the lazy dog and keeps on running past the margin")
  assertMeasured(wrapping.editor, "soft wrap")
  assert.ok(wrapping.editor.measureRows(20) > wrapping.editor.measureRows(80), "narrower width wraps into more rows")

  // CJK, emoji and ZWJ clusters count their real display width.
  const wide = makeEditor()
  wide.editor.setText("中文内容 😀🎉 mixed text 中文字符 👨‍👩‍👧‍👦 ZWJ 家族 ｶﾀｶﾅ")
  assertMeasured(wide.editor, "CJK/emoji/ZWJ")

  // Multiple logical lines.
  const multiline = makeEditor()
  multiline.editor.setText("first line\nsecond line\nthird line")
  assertMeasured(multiline.editor, "multi-line")

  // A 150-line draft: more logical lines than the visible window at any width.
  const long = makeEditor()
  long.editor.setText(Array.from({ length: 150 }, (_, index) => `line ${index} with enough text to wrap`).join("\n"))
  assertMeasured(long.editor, "150-line draft")

  // Image and file markers (atomic units, never split across visual lines).
  const markers = makeEditor()
  const imageId = markers.editor.insertImage({ type: "image", mediaType: "image/png", data: "aGVsbG8=" })
  const fileId = markers.editor.insertFile({
    part: { type: "file", attachment: { attachmentId: "att-1", name: "notes.txt", bytes: 12 } },
  })
  markers.editor.setText(`before [Image #${imageId}] middle [File #${fileId}] after`)
  assertMeasured(markers.editor, "image/file markers")

  // Large-paste marker: the registry id makes the marker atomic in the layout.
  const pasted = makeEditor()
  pasted.editor.ccPaste(`${"long pasted line\n".repeat(40)}`)
  assert.equal(pasted.editor.getText().includes("[paste #1"), true, "the paste became one atomic marker")
  assertMeasured(pasted.editor, "large-paste marker")
})

test("measureRows equals render(width).length for scrolled drafts and short terminals", () => {
  // A long draft scrolled to the bottom: the cursor sits past the visible window.
  const tall = makeEditor(40)
  tall.editor.setText(Array.from({ length: 60 }, (_, index) => `row ${index}`).join("\n"))
  tall.editor.ccSetCursor(59, 0)
  assertMeasured(tall.editor, "scrolled to the bottom")
  assert.ok(internals(tall.editor).scrollOffset > 0, "the draft really is scrolled")

  // Scrolled to the top, then to the middle.
  tall.editor.ccSetCursor(0, 0)
  assertMeasured(tall.editor, "scrolled to the top")
  tall.editor.ccSetCursor(30, 0)
  assertMeasured(tall.editor, "scrolled to the middle")

  // A short terminal keeps the minimum five-row window (30% of 10 rows < 5).
  const short = makeEditor(10)
  short.editor.setText(Array.from({ length: 40 }, (_, index) => `row ${index}`).join("\n"))
  short.editor.ccSetCursor(39, 0)
  assertMeasured(short.editor, "short terminal, scrolled")

  // Zero padding reserves the cursor column; padding 2 uses the full content width.
  const padded = makeEditor(24)
  padded.editor.setPaddingX(2)
  padded.editor.setText(Array.from({ length: 20 }, (_, index) => `padded row ${index}`).join("\n"))
  assertMeasured(padded.editor, "padded scrolled draft")
})

test("measureRows equals render(width).length with the completion menu open and closed", async () => {
  const { editor } = makeEditor()
  editor.setAutocompleteProvider(autocompleteProvider())
  editor.setText("@")
  assertMeasured(editor, "completion menu closed")

  editor.ccTriggerCompletion()
  await sleep(30)
  assert.equal(editor.isShowingAutocomplete(), true)
  assertMeasured(editor, "completion menu open")

  // Navigating the menu keeps the row count (and the measurement) exact.
  editor.ccAutocompleteStep(1)
  assertMeasured(editor, "completion menu selection moved")

  // A menu over a wrapped draft still adds exactly its own rows.
  editor.ccCancelAutocomplete()
  editor.setText(`@${"alpha ".repeat(20)}`)
  editor.ccTriggerCompletion()
  await sleep(30)
  assertMeasured(editor, "completion menu over a wrapped draft")

  editor.ccCancelAutocomplete()
  assert.equal(editor.isShowingAutocomplete(), false)
  assertMeasured(editor, "completion menu re-closed")
})

test("a decorated subclass keeps the same row count as its paint", () => {
  // Mirrors the App's `PromptEditor`: border/cell decoration only, no extra rows.
  class Decorated extends mod.CcEditor {
    protected renderTopBorder(width: number, hiddenLineCount: number): string {
      const base = super.renderTopBorder(width, hiddenLineCount)
      if (width <= 4) return base
      return `❯ ${base.slice(2)}`
    }
    render(width: number): string[] {
      const lines = super.render(width)
      if (lines.length > 2 && lines[1]?.startsWith("  ")) lines[1] = `❯ ${lines[1].slice(2)}`
      return lines
    }
  }
  const tui = createFakeTui(40, 80)
  const editor = new Decorated(asTui(tui), testEditorTheme, { paddingX: 2 })
  editor.setText("decorated prompt text that wraps at narrow widths\nsecond line")
  assertMeasured(editor as unknown as TestEditor, "decorated editor")
})

// --- 2. measuring is inert ----------------------------------------------

test("measuring the dock editor never moves the viewport or rewrites the draft", () => {
  const assertInert = (editor: TestEditor, label: string): void => {
    const before = editorState(editor)
    const painted = editor.render(60)
    // Measure a *different* width than the one painted: the visible frame must
    // not follow the measurement (checked after every single measurement, so a
    // later measurement cannot quietly restore a moved viewport).
    for (const width of [8, 120, 23, 60, 8]) {
      editor.measureRows(width)
      assert.deepEqual(editorState(editor), before, `${label}: measuring @${width} changed editor/render state`)
    }
    assert.deepEqual(editor.render(60), painted, `${label}: the frame after measuring is byte-identical`)
    assert.equal(editor.getText(), before.text, `${label}: the draft was not rewritten`)
    assert.deepEqual(editor.getCursor(), before.cursor, `${label}: the cursor did not move`)
  }

  // A draft that actually wraps: measuring another width produces another height.
  const { editor } = makeEditor(40)
  editor.setText(
    ["alpha beta gamma delta epsilon", "zeta eta theta iota kappa", "lambda mu nu xi omicron"].join("\n"),
  )
  const painted = editor.render(60)
  const narrow = editor.measureRows(8)
  const wide = editor.measureRows(120)
  assert.notEqual(narrow, wide, "widths really do produce different heights")
  assert.equal(wide, painted.length, "the painted width is measured exactly")
  assertInert(editor, "wrapping draft")

  // Same, on a scrolled 40-row draft where the visible window is capped.
  const scrolled = makeEditor(24)
  scrolled.editor.setText(Array.from({ length: 40 }, (_, index) => `row ${index} ${"x".repeat(index % 17)}`).join("\n"))
  scrolled.editor.ccSetCursor(39, 2)
  scrolled.editor.render(60)
  assert.ok(editorState(scrolled.editor).scrollOffset > 0, "the draft is scrolled before measuring")
  assertInert(scrolled.editor, "scrolled draft")
})

test("measuring twice returns the same answer without a second layout", () => {
  const { editor } = makeEditor()
  editor.setText("stable draft")
  editor.render(80)
  layouts = 0
  const first = editor.measureRows(80)
  const firstLayouts = layouts
  layouts = 0
  const second = editor.measureRows(80)
  assert.equal(second, first)
  assert.equal(firstLayouts, 1)
  assert.equal(layouts, 0, "the memoized answer needed no layout")
})

// --- 3. complete invalidation inputs ------------------------------------

test("every input the row count depends on invalidates the memoized measurement", async () => {
  const { editor, tui } = makeEditor()
  editor.setText("draft")
  assert.equal(editor.measureRows(40), editor.render(40).length)

  // Width.
  assertInvalidated(editor, "width change", 24)

  // Text through the public setter.
  editor.setText("draft with more text that certainly wraps at a narrow width")
  assertInvalidated(editor, "setText", 24)

  // In-place single-line edit: the line array identity is unchanged, only its
  // content differs — a fingerprint based on array identity would go stale.
  const linesBefore = (editor as unknown as { state: { lines: string[] } }).state.lines
  typeText(editor, " and typed")
  assert.equal((editor as unknown as { state: { lines: string[] } }).state.lines, linesBefore, "in-place edit")
  assertInvalidated(editor, "in-place typed text", 24)

  // Text that changes while the cursor stays put: the row count is the only
  // differing fact, so the text itself must be part of the fingerprint.
  const textOnly = makeEditor()
  textOnly.editor.setText("aaaa bbbb cccc dddd")
  textOnly.editor.ccSetCursor(0, 4)
  const shortRows = textOnly.editor.measureRows(16)
  const linesIdentity = (textOnly.editor as unknown as { state: { lines: string[] } }).state.lines
  typeText(textOnly.editor, "z".repeat(16))
  textOnly.editor.ccSetCursor(0, 4)
  assert.equal(
    (textOnly.editor as unknown as { state: { lines: string[] } }).state.lines,
    linesIdentity,
    "the edit was in place: same array, different content",
  )
  assert.deepEqual(textOnly.editor.getCursor(), { line: 0, col: 4 }, "the cursor is back where it was")
  const longRows = assertInvalidated(textOnly.editor, "text-only change", 16)
  assert.notEqual(longRows, shortRows, "the longer line wraps into more rows")

  // Cursor position.
  editor.ccSetCursor(0, 0)
  assertInvalidated(editor, "cursor move", 24)

  // Padding (changes the derived layout width).
  editor.setPaddingX(2)
  assertInvalidated(editor, "padding change", 24)
  editor.setPaddingX(0)

  // Terminal height (the visible-line cap is 30% of the terminal rows).
  editor.setText(Array.from({ length: 40 }, (_, index) => `row ${index}`).join("\n"))
  assertInvalidated(editor, "baseline rows 40", 40)
  tui.terminal.rows = 10
  assertInvalidated(editor, "terminal resize", 40)
  tui.terminal.rows = 40
  assertInvalidated(editor, "terminal resize back", 40)

  // Scroll offset, without touching any other input.
  const internalsBeforeScroll = internals(editor)
  const scrollBefore = internalsBeforeScroll.scrollOffset
  internalsBeforeScroll.scrollOffset = scrollBefore + 3
  assertInvalidated(editor, "scroll offset", 40)
  internalsBeforeScroll.scrollOffset = scrollBefore
  assertInvalidated(editor, "scroll offset restored", 40)

  // Paste registry: only the id set changes, the text does not.
  editor.setText("[paste #1 (5 chars)] tail")
  assertInvalidated(editor, "plain paste-marker text", 16)
  editor.ccPaste("hello")
  assertInvalidated(editor, "paste registry and text", 16)

  // Image registry: the *same* marker text becomes atomic once id 1 exists, so
  // the row count changes while the draft text does not.
  const registry = makeEditor()
  registry.editor.setText("aaaa bbbb [Image #1] cccc dddd")
  const plainRows = registry.editor.measureRows(20)
  registry.editor.setImageAttachmentEntries([[1, { type: "image", mediaType: "image/png", data: "aGVsbG8=" }]])
  const atomicRows = assertInvalidated(registry.editor, "image registry", 20)
  assert.equal(registry.editor.getText(), "aaaa bbbb [Image #1] cccc dddd", "only the registry changed")
  assert.notEqual(atomicRows, plainRows, "the atomic marker found a different wrap")

  // File registry, same atomicity rule.
  const files = makeEditor()
  files.editor.setText("aaaa bbbb [File #1] cccc dddd")
  const plainFileRows = files.editor.measureRows(18)
  files.editor.setFileAttachmentEntries([[1, { part: { type: "file", attachment: { attachmentId: "a", name: "n.txt", bytes: 1 } } }]])
  const atomicFileRows = assertInvalidated(files.editor, "file registry", 18)
  assert.equal(files.editor.getText(), "aaaa bbbb [File #1] cccc dddd", "only the registry changed")
  assert.notEqual(atomicFileRows, plainFileRows, "the atomic file marker found a different wrap")

  // Real attachments through the public API.
  const attached = makeEditor()
  attached.editor.setText("attach here")
  assertInvalidated(attached.editor, "baseline before attachments", 40)
  attached.editor.insertImage({ type: "image", mediaType: "image/png", data: "aGVsbG8=" })
  assertInvalidated(attached.editor, "insertImage", 40)
  attached.editor.insertFile({
    part: { type: "file", attachment: { attachmentId: "att-2", name: "a.txt", bytes: 3 } },
  })
  assertInvalidated(attached.editor, "insertFile", 40)
})

test("the completion menu invalidates the measurement when it opens and closes", async () => {
  const { editor } = makeEditor()
  editor.setAutocompleteProvider(autocompleteProvider())
  editor.setText("@al")
  const closedRows = assertInvalidated(editor, "menu closed", 40)
  editor.ccTriggerCompletion()
  await sleep(30)
  assert.equal(editor.isShowingAutocomplete(), true)
  const openRows = assertInvalidated(editor, "menu opened", 40)
  assert.ok(openRows > closedRows, "the open menu adds its own rows")

  // Selection changes must keep the measurement exact (recomputed or cached).
  editor.ccAutocompleteStep(1)
  assert.equal(editor.measureRows(40), editor.render(40).length, "menu navigation keeps the row count exact")

  editor.ccCancelAutocomplete()
  const reclosedRows = assertInvalidated(editor, "menu closed again", 40)
  assert.equal(reclosedRows, closedRows, "closing the menu restores the frame height")
})
// --- 4. deterministic width/shape sweep ---------------------------------

test("a seeded sweep of widths, heights, paddings and drafts never drifts from the paint", () => {
  // Deterministic LCG: same sequence every run, no timing or randomness source.
  let seed = 0x2f6e2b1
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!
  const words = [
    "alpha",
    "中文字符",
    "😀🎉",
    "👨‍👩‍👧‍👦",
    "e\u0301", // combining acute
    "supercalifragilisticexpialidocious",
    "--flag=value",
    "[Image #1]", // plain text here: id 1 is never registered in this sweep
    "   ",
  ] as const
  const widths = [1, 2, 3, 4, 5, 7, 9, 13, 17, 23, 31, 40, 57, 80] as const
  const heights = [1, 5, 10, 17, 24, 40] as const

  for (let iteration = 0; iteration < 60; iteration += 1) {
    const { editor } = makeEditor(pick(heights))
    const lineCount = Math.floor(random() ** 2 * 40)
    const lines = Array.from({ length: lineCount }, () =>
      Array.from({ length: Math.floor(random() * 24) }, () => pick(words)).join(" "),
    )
    editor.setText(lines.join("\n"))
    if (random() < 0.3) editor.setPaddingX(Math.floor(random() * 3))
    // A previous paint at another width seeds a scroll offset.
    editor.ccSetCursor(pick([0, Math.max(0, lineCount - 1), Math.floor(lineCount / 2)]), 0)
    editor.render(pick(widths))
    for (const width of [pick(widths), pick(widths)]) {
      const painted = editor.render(width).length
      assert.equal(
        editor.measureRows(width),
        painted,
        `sweep ${iteration} @${width}: rows ${editor.getLines().length}, padding ${editor.getPaddingX()}`,
      )
      assert.equal(editor.measureRows(width), painted, `sweep ${iteration} @${width}: repeat`)
    }
  }
})
