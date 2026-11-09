/**
 * Input-layer defect regressions (I1–I6).
 *
 * Each test names the invariant it protects, not the implementation that
 * happens to satisfy it, so a later vendoring refresh or refactor keeps the
 * behaviour honest:
 *
 *  I1 history browsing must never destroy attachment payloads of the draft
 *  I2 a grapheme wider than the layout must overflow, never recurse forever
 *  I3 a recalled history entry resumes at its end (readline/CC parity)
 *  I4 hand-typed marker text is never silently upgraded by a later insert
 *  I5 a held fragmented-paste prefix has a deadline and cannot eat the next key
 *  I6 `text` and `content` describe the same, once-trimmed draft
 *
 * All tests are offline: no model, provider, credential, tty or network.
 */

import test from "node:test"
import assert from "node:assert/strict"

import {
  asTui,
  createFakeTui,
  loadInputModule,
  renderAt,
  testEditorTheme,
  typeText,
} from "../src/input/testing/harness.ts"
import type { CcEditorOptions } from "../src/input/index.ts"
import type { ImageUploadPart } from "../src/ui/image-view.ts"
import type { FileAttachmentRef } from "../src/backend/types.ts"

const mod = await loadInputModule()
type TestEditor = InstanceType<typeof mod.CcEditor>
type SubmitPayload = import("../src/input/index.ts").CcSubmitPayload

function upload(id: number): ImageUploadPart {
  return {
    type: "image",
    mediaType: "image/png",
    data: Buffer.alloc(16, id).toString("base64"),
    name: `shot-${id}.png`,
  }
}

function fileRef(id: string): FileAttachmentRef {
  return { attachmentId: id, name: `notes-${id}.txt`, bytes: 12 }
}

function filePart(id: string) {
  return { type: "file" as const, attachment: fileRef(id) }
}

interface Harness {
  editor: TestEditor
  payloads: SubmitPayload[]
  blocked: Error[]
  legacy: string[]
}

function makeEditor(options: CcEditorOptions = {}): Harness {
  const editor = new mod.CcEditor(asTui(createFakeTui()), testEditorTheme, options)
  const harness: Harness = { editor, payloads: [], blocked: [], legacy: [] }
  editor.onSubmitContent = (payload: SubmitPayload) => {
    harness.payloads.push(payload)
  }
  editor.onSubmitBlocked = (error: Error) => {
    harness.blocked.push(error)
  }
  editor.onSubmit = (text: string) => {
    harness.legacy.push(text)
  }
  renderAt(editor, 80)
  return harness
}

function press(editor: TestEditor, ...keys: string[]): void {
  for (const key of keys) editor.handleInput(key)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Types `text` one grapheme at a time and flushes held paste framing. */
function type(editor: TestEditor, text: string): void {
  typeText(editor, text)
}

// --- I1: history browsing must not destroy the draft's payloads ----------

test("I1: leaving history browsing with an edit keeps the draft's image payload resolvable", () => {
  const { editor, payloads, blocked } = makeEditor()
  editor.addToHistory("older entry")
  editor.insertImage(upload(1))
  assert.equal(editor.getText(), "[Image #1]")
  assert.equal(editor.getImageAttachmentEntries().length, 1)

  // Enter browsing (Ctrl+A then Up is the reported path), then leave it by
  // editing: the draft's marker text is still in the undo stack and must keep
  // resolving to its upload.
  press(editor, "\x01", "\x1b[A")
  assert.equal(editor.getText(), "older entry")
  type(editor, "x")
  assert.equal(editor.ccIsBrowsingHistory(), false)
  assert.doesNotThrow(() => editor.getPromptContent(), "typing after browsing must not orphan the draft image")

  press(editor, "\x1f") // undo the typed "x"
  assert.equal(editor.getText(), "older entry")
  press(editor, "\x1f") // undo the recall itself
  assert.equal(editor.getText(), "[Image #1]")
  assert.deepEqual(
    editor.getImageAttachmentEntries().map(([id]) => id),
    [1],
    "the pre-browsing draft payload is still registered",
  )
  assert.deepEqual(editor.getPromptContent(), [
    { type: "image", mediaType: "image/png", data: upload(1).data, name: "shot-1.png" },
  ])
  press(editor, "\r")
  assert.deepEqual(blocked, [])
  assert.equal(payloads[0]?.text, "[Image #1]", "the draft is sent with its real attachment")
})

test("I1: attaching an image right after history browsing keeps both payloads reachable", () => {
  const { editor } = makeEditor()
  editor.addToHistory("older entry")
  editor.insertImage(upload(1))
  press(editor, "\x01", "\x1b[A") // browse history (drops the draft from the text)
  const second = editor.insertImage(upload(2)) // insertImage leaves browsing mode
  assert.equal(second, 2)
  // The recalled entry is gone, but its marker text is on the undo stack and the
  // first payload must still resolve for that undo state.
  assert.equal(editor.getText(), "older entry [Image #2]")
  assert.doesNotThrow(() => editor.getPromptContent())
  const ids = editor.getImageAttachmentEntries().map(([id]) => id).sort()
  assert.deepEqual(ids, [1, 2], "the browsing draft's payload survives alongside the new one")
})

test("I1: the draft's file payload survives leaving history browsing", () => {
  const { editor } = makeEditor()
  editor.addToHistory("older entry")
  editor.insertFile(filePart("f1"))
  assert.equal(editor.getText(), "[File #1]")

  press(editor, "\x01", "\x1b[A")
  type(editor, "y")
  assert.doesNotThrow(() => editor.getPromptContent(), "typing after browsing must not orphan the draft file")
  press(editor, "\x1f", "\x1f")
  assert.equal(editor.getText(), "[File #1]")
  assert.deepEqual(editor.getFileAttachments().map((entry) => entry.id), [1])
  assert.deepEqual(editor.getPromptContent(), [
    { type: "file", attachment: { attachmentId: "f1", name: "notes-f1.txt", bytes: 12 } },
  ])
})

test("I1: a recalled history entry still resolves its own payload after the draft was merged back", () => {
  const { editor, payloads } = makeEditor()
  // Real submit path: the entry's own image payload is recorded with it.
  type(editor, "with image ")
  editor.insertImage(upload(1))
  press(editor, "\r")
  assert.equal(payloads.length, 1)
  editor.addToHistory(payloads[0]!.text)
  type(editor, "plain entry")
  press(editor, "\r")
  editor.addToHistory("plain entry")

  press(editor, "\x10") // "plain entry"
  press(editor, "\x10") // the image entry
  assert.deepEqual(
    editor.getImageAttachments().map((entry) => entry.id),
    [1],
    "the recalled entry keeps its own upload",
  )
  type(editor, " tail") // leaves browsing mode by editing
  assert.equal(editor.getText(), "with image [Image #1] tail")
  assert.doesNotThrow(() => editor.getPromptContent())
})

test("I1: image and file families stay independent across a history round trip", () => {
  const { editor } = makeEditor()
  editor.addToHistory("older entry")
  editor.insertImage(upload(1))
  type(editor, " and ")
  editor.insertFile(filePart("f1"))
  const before = editor.getPromptContent()

  press(editor, "\x01", "\x1b[A") // browse away
  type(editor, "z")
  press(editor, "\x1f") // undo the typed z
  press(editor, "\x1f") // undo the recall -> draft text back
  assert.equal(editor.getText(), "[Image #1] and [File #1]")
  assert.deepEqual(editor.getPromptContent(), before, "both families resolve to the same ordered parts as before")
})

// --- I2: a wide grapheme in a narrow layout must not recurse forever ----

test("I2: CJK, emoji and ZWJ text render at 1-3 columns without exhausting the stack", () => {
  const samples = ["你好", "👨‍👩‍👧‍👦 family", "👍🏽 ok", "混合 mixed 文字"]
  for (const width of [1, 2, 3]) {
    for (const text of samples) {
      const { editor } = makeEditor()
      editor.setText(text)
      editor.ccSetCursor(0, text.length)
      let lines: string[] = []
      assert.doesNotThrow(() => {
        lines = editor.render(width)
      }, `${JSON.stringify(text)} must render at width ${width}`)
      assert.ok(lines.length >= 3, "border + content + border")

      // Cursor movement over the same wrapped layout stays inside the draft.
      assert.doesNotThrow(() => editor.render(width))
      press(editor, "\x02") // Ctrl+B
      assert.doesNotThrow(() => editor.render(width), "cursor movement must not change the layout width")
    }
  }
})

test("I2: an atomic paste marker still wraps in a 1-2 column layout", () => {
  for (const width of [1, 2]) {
    const { editor } = makeEditor()
    editor.handleInput("\x1b[200~" + "x".repeat(1200) + "\x1b[201~")
    assert.match(editor.getText(), /^\[paste #1 \d+ chars\]$/)
    const lines = editor.render(width)
    assert.ok(lines.length > 3, `the marker must wrap over several visual lines at width ${width}`)
    // The marker stays one editing unit even though it is displayed in pieces.
    press(editor, "\x7f")
    assert.equal(editor.getText(), "", "Backspace still deletes the whole marker")
  }
})

// --- I3: a recalled entry resumes at its end -----------------------------

test("I3: typing right after recalling a history entry appends instead of prepending", () => {
  const { editor } = makeEditor()
  editor.addToHistory("older entry")
  press(editor, "\x1b[A")
  assert.equal(editor.getText(), "older entry")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 11 })
  type(editor, " longer")
  assert.equal(editor.getText(), "older entry longer")
})

test("I3: a multi-line history entry is still sticky without relying on the cursor column", () => {
  const { editor } = makeEditor()
  editor.addToHistory("one\ntwo")
  press(editor, "\x1b[A")
  assert.deepEqual(editor.getCursor(), { line: 1, col: 3 }, "recall ends at the end of the entry")
  press(editor, "\x1b[A") // Up moves inside the entry, not to older history
  assert.equal(editor.getText(), "one\ntwo")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 3 })
  assert.equal(editor.ccIsBrowsingHistory(), true)
})

// --- I4: hand-typed markers are never silently upgraded ----------------

test("I4: a hand-typed [Image #N] is not resolved by the next upload", () => {
  const { editor, blocked } = makeEditor()
  type(editor, "[Image #1]")
  const id = editor.insertImage(upload(2))
  assert.equal(id, 2, "the typed marker reserves id 1, so the upload takes the next id")
  assert.equal(editor.getText(), "[Image #1] [Image #2]")
  assert.deepEqual(editor.getAttachmentCounts(), { images: 1, files: 0 }, "only the real upload is an attachment")
  assert.throws(
    () => editor.getPromptContent(),
    (error: unknown) => {
      assert.ok(error instanceof mod.CcUnresolvedImageMarkerError)
      assert.deepEqual([...(error as InstanceType<typeof mod.CcUnresolvedImageMarkerError>).markerIds], [1])
      return true
    },
    "the typed marker stays unresolved instead of becoming a second copy of the upload",
  )
  press(editor, "\r")
  assert.equal(blocked.length, 1)
  assert.equal(editor.getText(), "[Image #1] [Image #2]", "a blocked send keeps the draft")
})

test("I4: a hand-typed [paste #n] marker is not expanded by a later large paste", () => {
  const { editor, payloads, legacy } = makeEditor()
  type(editor, "[paste #1 999 chars] ")
  editor.handleInput("\x1b[200~" + "p".repeat(1200) + "\x1b[201~")
  assert.equal(editor.getText(), "[paste #1 999 chars] [paste #2 1200 chars]")
  press(editor, "\r")
  const submitted = payloads[0]?.text ?? legacy[0] ?? ""
  assert.ok(submitted.includes("[paste #1 999 chars]"), "the typed marker is still literal text")
  assert.ok(submitted.includes("p".repeat(1200)), "the real paste is expanded")
  assert.equal(submitted.match(/p{1200}/g)?.length, 1, "the typed marker did not become a second copy of the paste")
})

// --- I5: a held paste prefix has a deadline -----------------------------

test("I5: a held fragmented-paste prefix is released as keys so the next keystroke is not swallowed", async () => {
  const { editor } = makeEditor({ pasteHoldTimeoutMs: 10 })
  editor.handleInput("a")
  editor.handleInput("\x1b[")
  assert.equal(editor.getText(), "a")
  assert.equal(editor.isPasting(), true, "held bytes are visible to the host's paste protection")
  await sleep(40)
  assert.equal(editor.isPasting(), false, "the deadline released the held prefix")
  editor.handleInput("b")
  assert.equal(editor.getText(), "ab", "the keystroke after an expired hold types normally")
})

test("I5: a real fragmented paste start still reassembles inside the deadline", async () => {
  const { editor, payloads } = makeEditor({ pasteHoldTimeoutMs: 500 })
  editor.handleInput("\x1b[20")
  assert.equal(editor.isPasting(), true)
  editor.handleInput("0~hello\x1b[20")
  editor.handleInput("1~")
  assert.equal(editor.isPasting(), false)
  assert.equal(editor.getText(), "hello")
  await sleep(20)
  press(editor, "\r")
  assert.deepEqual(payloads.map((payload) => payload.text), ["hello"])
})

test("I5: disposing the editor drops a held prefix without editing or throwing", async () => {
  const { editor } = makeEditor({ pasteHoldTimeoutMs: 10 })
  editor.handleInput("a")
  editor.handleInput("\x1b[")
  editor.dispose()
  await sleep(40)
  assert.equal(editor.getText(), "a")
  editor.handleInput("b")
  assert.equal(editor.getText(), "a", "a disposed editor stays inert")
})

// --- I6: text and content describe the same trimmed draft ---------------

test("I6: submit text and content are trimmed the same way", () => {
  const { editor } = makeEditor()
  editor.setText("  hello  ")
  const payload = editor.captureSubmitPayload()
  assert.equal(payload.text, "hello")
  assert.deepEqual(payload.content, [{ type: "text", text: "hello" }])
  const textParts = payload.content.filter((part) => part.type === "text").map((part) => part.text)
  assert.equal(textParts.join(""), payload.text, "concatenated text parts equal the submitted text")
})

test("I6: a whitespace-only draft submits empty text with an empty content part", () => {
  const { editor } = makeEditor()
  editor.setText("   \n  ")
  const payload = editor.captureSubmitPayload()
  assert.equal(payload.text, "")
  assert.deepEqual(payload.content, [{ type: "text", text: "" }])
})

test("I6: a trimmed attachment draft keeps text and content in agreement", () => {
  const { editor } = makeEditor()
  editor.setText("  ")
  editor.insertImage(upload(1))
  editor.setText(editor.getText().replace("[Image #1]", "  [Image #1]  "))
  const payload = editor.captureSubmitPayload()
  assert.equal(payload.text, "[Image #1]")
  assert.deepEqual(payload.content, [
    { type: "image", mediaType: "image/png", data: upload(1).data, name: "shot-1.png" },
  ])
})