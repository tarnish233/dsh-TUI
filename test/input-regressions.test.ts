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
 *  I7 a no-op kill is not an edit and keeps history browsing (and its draft);
 *     the seam install asserts the wrappers it needs still exist
 *  I8 a held paste prefix released at the deadline is delivered as ordinary keys
 *     and its synthetic Escape is consumed by the input layer (never app.cancel)
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
  // Released as ordinary keys: the ESC is Escape, `[` is plain input, so no
  // held byte is swallowed and the next keystroke is independent of the hold.
  assert.equal(editor.getText(), "a[", "the held printable byte is delivered as input")
  editor.handleInput("b")
  assert.equal(editor.getText(), "a[b", "the keystroke after an expired hold types normally")
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

// --- I7: a no-op kill keeps history browsing ---------------------------

test("I7: a no-op Ctrl+W at column 0 keeps history browsing so Esc restores the draft", () => {
  const { editor } = makeEditor()
  const actions: string[] = []
  editor.onAction = (event) => {
    actions.push(event.id)
  }
  editor.addToHistory("recalled entry")
  editor.setText("my draft")
  renderAt(editor, 80)

  press(editor, "\x10") // Up enters browsing with the cursor at the entry's end
  assert.equal(editor.getText(), "recalled entry")
  assert.equal(editor.ccIsBrowsingHistory(), true)

  press(editor, "\x01") // Ctrl+A: column 0 of the first line, nothing to kill
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 })
  press(editor, "\x17") // Ctrl+W deletes nothing

  assert.equal(editor.getText(), "recalled entry")
  assert.equal(editor.ccIsBrowsingHistory(), true, "a kill with nothing to delete is not an edit")
  assert.deepEqual(editor.ccGetKillRing(), [], "a no-op kill pushes nothing onto the kill ring")

  press(editor, "\x1b") // Esc: the history layer restores the pre-browsing draft
  assert.equal(editor.getText(), "my draft")
  assert.equal(editor.ccIsBrowsingHistory(), false)
  assert.deepEqual(actions, [], "Esc was consumed by history restore, not app.cancel")
})

test("I7: no-op Ctrl+U, Backspace and Delete keep history browsing", () => {
  for (const [label, prepare, key] of [
    ["Ctrl+U", (editor: TestEditor) => press(editor, "\x01"), "\x15"],
    ["Backspace", (editor: TestEditor) => press(editor, "\x01"), "\x7f"],
    ["Delete", (_editor: TestEditor) => {}, "\x1b[3~"],
  ] as const) {
    const { editor } = makeEditor()
    editor.addToHistory("recalled entry")
    editor.setText("my draft")
    renderAt(editor, 80)
    press(editor, "\x10")
    assert.equal(editor.ccIsBrowsingHistory(), true, label)
    prepare(editor)
    press(editor, key)
    assert.equal(editor.getText(), "recalled entry", `${label} is a no-op`)
    assert.equal(editor.ccIsBrowsingHistory(), true, `${label} must not end browsing`)
    press(editor, "\x1b")
    assert.equal(editor.getText(), "my draft", `${label}: Esc restores the draft`)
  }
})

test("I7: a no-op Ctrl+K at the end of the draft keeps history browsing", () => {
  const { editor } = makeEditor()
  editor.addToHistory("recalled entry")
  editor.setText("my draft")
  renderAt(editor, 80)

  press(editor, "\x10")
  assert.equal(editor.getText(), "recalled entry")
  assert.equal(editor.ccIsBrowsingHistory(), true)

  press(editor, "\x05") // Ctrl+E: end of the recalled entry
  assert.deepEqual(editor.getCursor(), { line: 0, col: 14 })
  press(editor, "\x0b") // Ctrl+K: nothing left to kill on the last line

  assert.equal(editor.getText(), "recalled entry", "Ctrl+K at the end of the draft is a no-op")
  assert.equal(editor.ccIsBrowsingHistory(), true, "a no-op Ctrl+K must not end browsing")
  assert.deepEqual(editor.ccGetKillRing(), [], "a no-op Ctrl+K pushes nothing onto the kill ring")

  press(editor, "\x1b")
  assert.equal(editor.getText(), "my draft", "Ctrl+K: Esc still restores the pre-browsing draft")
})

/**
 * The history-preserving wrappers are installed by name on the vendored
 * Editor. A silently skipped wrapper (upstream rename/removal) would quietly
 * lose a documented rule, so the install asserts instead of logging.
 */
test("I7: the seam install asserts every history-preserving wrapper target exists", async () => {
  const { Editor } = await import("#pi-tui")
  const descriptor = Object.getOwnPropertyDescriptor(Editor.prototype, "deleteToEndOfLine")
  assert.ok(descriptor, "the vendored editor still has deleteToEndOfLine")

  // A cache-busted copy of the seam module has its own `installed` flag, so the
  // install can run again against the same (temporarily incomplete) Editor.
  const specifier: string = "../src/input/pi-tui-seam.js?seam-missing-wrapper"
  const fresh = (await import(specifier)) as { installPiTuiSeam: () => void }
  delete (Editor.prototype as unknown as Record<string, unknown>).deleteToEndOfLine
  try {
    assert.throws(
      () => fresh.installPiTuiSeam(),
      /deleteToEndOfLine/,
      "a missing upstream method must fail the install instead of silently skipping the wrapper",
    )
  } finally {
    Object.defineProperty(Editor.prototype, "deleteToEndOfLine", descriptor)
  }

  // The assertion does not misfire: a complete seam installs without throwing.
  const healthySpecifier: string = "../src/input/pi-tui-seam.js?seam-complete"
  const healthy = (await import(healthySpecifier)) as { installPiTuiSeam: () => void }
  assert.doesNotThrow(() => healthy.installPiTuiSeam())
})

test("I7: a real Ctrl+W deletion still leaves history browsing", () => {
  const { editor } = makeEditor()
  editor.addToHistory("older entry")
  editor.addToHistory("alpha beta")
  renderAt(editor, 80)

  press(editor, "\x10")
  assert.equal(editor.getText(), "alpha beta")
  assert.equal(editor.ccIsBrowsingHistory(), true)

  press(editor, "\x17") // deletes "beta" for real
  assert.equal(editor.getText(), "alpha ")
  assert.equal(editor.ccIsBrowsingHistory(), false, "a real edit ends browsing")
  assert.deepEqual(editor.ccGetKillRing(), ["beta"])
})

// --- I8: a held paste prefix is released as ordinary keys ---------------

test("I8: a held paste prefix released at the deadline is not swallowed", async () => {
  const { editor } = makeEditor({ pasteHoldTimeoutMs: 10 })
  const actions: string[] = []
  editor.onAction = (event) => {
    actions.push(event.id)
  }
  renderAt(editor, 80)

  type(editor, "ab")
  editor.handleInput("\x1b[2") // a strict prefix of ESC[200~: held, not dispatched
  assert.equal(editor.isPasting(), true)
  assert.equal(editor.getText(), "ab")

  await sleep(40)
  assert.equal(editor.isPasting(), false)
  assert.equal(
    editor.getText(),
    "ab[2",
    "the released prefix is ordinary input: ESC becomes Escape, ESC[2 leaves [2 behind",
  )
  assert.deepEqual(actions, [], "the released ESC is consumed by the input layer: no host sees app.cancel")

  type(editor, "~")
  assert.equal(editor.getText(), "ab[2~", "the late ~ is typed text, never the tail of the held sequence")
  assert.deepEqual(actions, [], "releasing the hold emits nothing else")

  // A physical Escape is still a cancel: the consumption is scoped to the
  // released held bytes, never to the Escape key.
  press(editor, "\x1b")
  assert.deepEqual(actions, ["app.cancel"], "a real Escape still reaches the host")
})

test("I8: a released held prefix is not a cancel for the history layer either", async () => {
  const { editor } = makeEditor({ pasteHoldTimeoutMs: 10 })
  const actions: string[] = []
  editor.onAction = (event) => {
    actions.push(event.id)
  }
  editor.addToHistory("recalled entry")
  editor.setText("my draft")
  renderAt(editor, 80)

  press(editor, "\x10")
  assert.equal(editor.getText(), "recalled entry")
  assert.equal(editor.ccIsBrowsingHistory(), true)

  editor.handleInput("\x1b[2")
  await sleep(40)
  assert.equal(
    editor.getText(),
    "recalled entry[2",
    "the synthetic Escape neither forwarded app.cancel nor restored the pre-browsing draft",
  )
  assert.deepEqual(actions, [], "nothing reached a host")
})

test("I8: ESC[Z is untouched, whole or fragmented inside the deadline", async () => {
  const whole = makeEditor({ pasteHoldTimeoutMs: 10 })
  const wholeActions: string[] = []
  whole.editor.onAction = (event) => {
    wholeActions.push(event.id)
  }
  renderAt(whole.editor, 80)
  type(whole.editor, "ab")
  whole.editor.handleInput("\x1b[Z") // Shift+Tab arrives in one chunk
  assert.equal(whole.editor.getText(), "ab", "a complete sequence is never inserted as text")
  assert.deepEqual(wholeActions, ["app.mode.cycle"])
  await sleep(40)
  assert.equal(whole.editor.getText(), "ab", "the sequence is not re-released as text after the deadline")

  // Fragmented inside the hold window: the bytes are still one Shift+Tab, not
  // Escape + "[" + "Z" (the hold only exists for a possible paste marker).
  const split = makeEditor({ pasteHoldTimeoutMs: 500 })
  const splitActions: string[] = []
  split.editor.onAction = (event) => {
    splitActions.push(event.id)
  }
  renderAt(split.editor, 80)
  type(split.editor, "ab")
  split.editor.handleInput("\x1b[")
  assert.equal(split.editor.isPasting(), true)
  split.editor.handleInput("Z")
  assert.equal(split.editor.isPasting(), false)
  assert.equal(split.editor.getText(), "ab")
  assert.deepEqual(splitActions, ["app.mode.cycle"])
  await sleep(20)
  assert.equal(split.editor.getText(), "ab")
})