/**
 * CC-style image attachments on the single Pi editor state (input-owned).
 *
 * Attachments are memory-only: `[Image #N]` markers stay atomic in the draft and
 * the encoded upload lives in the vendored editor registry (never in
 * history.json). These tests drive real key sequences and assert text, cursor,
 * registry and prompt content — no clipboard, model or tty is involved.
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

const mod = await loadInputModule()
type TestEditor = InstanceType<typeof mod.CcEditor>
type SubmitPayload = import("../src/input/index.ts").CcSubmitPayload

/** Small deterministic fake uploads; DSH owns real admission and decoding. */
function upload(id: number, bytes = 64): ImageUploadPart {
  return {
    type: "image",
    mediaType: "image/png",
    data: Buffer.alloc(bytes, id).toString("base64"),
    name: `shot-${id}.png`,
  }
}

interface Harness {
  editor: TestEditor
  payloads: SubmitPayload[]
  blocked: Error[]
  legacy: string[]
}

function makeEditor(options: CcEditorOptions = {}): Harness {
  const tui = createFakeTui()
  const editor = new mod.CcEditor(asTui(tui), testEditorTheme, options)
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

function markerIds(editor: TestEditor): string[] {
  return editor.getText().match(/\[Image #\d+\]/g) ?? []
}

test("insertImage writes one atomic marker and exposes the attachment", () => {
  const { editor } = makeEditor()
  editor.setText("look at this")
  renderAt(editor, 80)
  press(editor, "\x05") // Ctrl+E: end of line

  const id = editor.insertImage(upload(1))
  assert.equal(id, 1)
  assert.equal(editor.getText(), "look at this [Image #1]")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 23 })
  assert.ok(editor.hasImageAttachments())
  const attachments = editor.getImageAttachments()
  assert.equal(attachments.length, 1)
  assert.equal(attachments[0]!.id, 1)
  assert.deepEqual(attachments[0]!.image, upload(1))
  // A marker inserted in the middle of a word never glues onto it.
  editor.insertImage(upload(2))
  assert.equal(editor.getText(), "look at this [Image #1] [Image #2]")
})

test("Backspace and word/whitespace kills treat the marker as one unit", () => {
  const { editor } = makeEditor()
  editor.setText("a")
  renderAt(editor, 80)
  press(editor, "\x05")
  editor.insertImage(upload(1))
  typeText(editor, "b")
  // A marker inserted at end of line keeps no trailing space; text typed right
  // after it stays a separate token because the marker is atomic.
  assert.equal(editor.getText(), "a [Image #1]b")
  editor.setText("a [Image #1] b")
  renderAt(editor, 80)

  // Cursor right after the marker: Backspace removes the whole token at once.
  editor.ccSetCursor(0, "a [Image #1]".length)
  press(editor, "\x7f")
  assert.equal(editor.getText(), "a  b")
  assert.ok(!editor.getText().includes("Image"), "no partial marker text is left")
  press(editor, "\x1f") // undo restores text and payload together
  assert.equal(editor.getText(), "a [Image #1] b")
  assert.ok(editor.hasImageAttachments())

  // Ctrl+W at the same spot deletes the whitespace token, which is the marker.
  editor.ccSetCursor(0, "a [Image #1]".length)
  press(editor, "\x17")
  assert.equal(editor.getText(), "a  b")
  press(editor, "\x1f")
  assert.equal(editor.getText(), "a [Image #1] b")

  // Word deletion (Alt+Backspace) also removes the marker as one segment.
  editor.ccSetCursor(0, "a [Image #1]".length)
  press(editor, "\x1b\x7f")
  assert.equal(editor.getText(), "a  b")
  press(editor, "\x19") // Ctrl+Y yanks the killed marker back
  assert.equal(editor.getText(), "a [Image #1] b")
  assert.equal(editor.getImageAttachments()[0]!.id, 1)
})

test("undo, kill/yank and clear restore markers with their uploads", () => {
  const { editor } = makeEditor()
  editor.setText("keep")
  renderAt(editor, 80)
  press(editor, "\x05")
  editor.insertImage(upload(1))
  assert.equal(editor.getText(), "keep [Image #1]")

  // Kill the marker (Ctrl+K kills to end of line) then yank it back.
  editor.ccSetCursor(0, "keep ".length)
  press(editor, "\x0b")
  assert.equal(editor.getText(), "keep ")
  press(editor, "\x19") // Ctrl+Y
  assert.equal(editor.getText(), "keep [Image #1]")
  assert.ok(editor.hasImageAttachments(), "yank restores a resolvable marker")

  // Undo the yank, then undo the kill: both states stay consistent.
  press(editor, "\x1f")
  assert.equal(editor.getText(), "keep ")
  press(editor, "\x1f")
  assert.equal(editor.getText(), "keep [Image #1]")
  assert.deepEqual(
    editor.getImageAttachments().map((entry) => entry.id),
    [1],
  )
  assert.doesNotThrow(() => editor.getPromptContent())

  // Backspace-delete the marker, then undo restores marker and payload.
  editor.ccSetCursor(0, editor.getText().length)
  press(editor, "\x7f")
  assert.equal(editor.getText(), "keep ")
  press(editor, "\x1f")
  assert.equal(editor.getText(), "keep [Image #1]")
  assert.equal(editor.getPromptContent().filter((part) => part.type === "image").length, 1)
})

test("prompt content interleaves text and images in marker order", () => {
  const { editor } = makeEditor()
  editor.setText("first")
  renderAt(editor, 80)
  press(editor, "\x05")
  editor.insertImage(upload(1))
  typeText(editor, "second")
  editor.insertImage(upload(2))

  const content = editor.getPromptContent()
  assert.deepEqual(content, [
    { type: "text", text: "first " },
    { type: "image", mediaType: "image/png", data: upload(1).data, name: "shot-1.png" },
    { type: "text", text: "second " },
    { type: "image", mediaType: "image/png", data: upload(2).data, name: "shot-2.png" },
  ])
  // No marker text leaks into the model prompt.
  for (const part of content) {
    if (part.type === "text") assert.ok(!part.text.includes("[Image #"))
  }
})

test("repeated markers keep every position and image part in order", () => {
  const { editor } = makeEditor()
  // One real upload, then the same known marker duplicated in two later spots
  // (what kill/yank or a literal copy of an existing id produces).
  editor.insertImage(upload(1))
  editor.setText("text A [Image #1] text B [Image #1] text C")
  renderAt(editor, 80)

  const image = { type: "image", mediaType: "image/png", data: upload(1).data, name: "shot-1.png" } as const
  const content = editor.getPromptContent()
  // Whitespace around each marker is user content and stays verbatim.
  assert.deepEqual(content, [
    { type: "text", text: "text A " },
    image,
    { type: "text", text: " text B " },
    image,
    { type: "text", text: " text C" },
  ])
  // Removing only the markers reproduces the input character for character.
  assert.equal(
    content.map((part) => (part.type === "text" ? part.text : "|")).join(""),
    "text A | text B | text C",
  )
  // Nothing was merged away: the second marker is a real image part, not text.
  assert.equal(content.filter((part) => part.type === "image").length, 2)
  assert.equal(
    content.map((part) => part.type).join(","),
    "text,image,text,image,text",
  )

  // Preview and content agree: one entry per visible occurrence.
  assert.deepEqual(
    editor.getImageAttachments().map((entry) => entry.id),
    [1, 1],
  )

  // Image-only repeated markers keep both parts; the single space between them
  // is user content and stays a text block (nothing is merged or dropped).
  editor.setText("[Image #1] [Image #1]")
  renderAt(editor, 80)
  assert.deepEqual(editor.getPromptContent(), [image, { type: "text", text: " " }, image])
})

test("text blocks keep indentation and newlines exactly as typed", () => {
  const { editor } = makeEditor()
  editor.insertImage(upload(1))
  const input = "def run():\n    value = (\n        [Image #1]\n    )\n    return value\n"
  editor.setText(input)
  renderAt(editor, 80)

  const content = editor.getPromptContent()
  const segments = content.map((part) => (part.type === "text" ? part.text : "\u0000IMAGE\u0000"))
  // Only the marker is replaced; every space, indent and newline survives.
  assert.equal(segments.join(""), input.replace("[Image #1]", "\u0000IMAGE\u0000"))
  assert.deepEqual(segments, ["def run():\n    value = (\n        ", "\u0000IMAGE\u0000", "\n    )\n    return value\n"])

  // Two markers inside one indented block keep both positions and both gaps
  // (Pi normalizes tabs to four spaces when text enters the editor).
  editor.setText("    x [Image #1]\n\n  [Image #1]    y\n")
  renderAt(editor, 80)
  const twice = editor.getPromptContent()
  assert.equal(
    twice.map((part) => (part.type === "text" ? part.text : "\u0000")).join(""),
    editor.getText().replaceAll("[Image #1]", "\u0000"),
  )
  assert.equal(twice.filter((part) => part.type === "image").length, 2)
})

test("repeating one marker through kill/yank preserves ordered content", () => {
  const { editor } = makeEditor()
  editor.setText("text A ")
  renderAt(editor, 80)
  press(editor, "\x05")
  editor.insertImage(upload(1))
  // Kill the marker, then yank it back twice: two live occurrences, one upload.
  editor.ccSetCursor(0, "text A [Image #1]".length)
  press(editor, "\x17")
  assert.equal(editor.getText(), "text A ")
  press(editor, "\x19")
  typeText(editor, " text B ")
  press(editor, "\x19")
  typeText(editor, " text C")
  assert.equal(editor.getText(), "text A [Image #1] text B [Image #1] text C")

  const content = editor.getPromptContent()
  assert.equal(content.filter((part) => part.type === "image").length, 2)
  assert.deepEqual(
    content.map((part) => part.type),
    ["text", "image", "text", "image", "text"],
  )
  assert.deepEqual(
    content.filter((part) => part.type === "text").map((part) => (part.type === "text" ? part.text : "")),
    ["text A ", " text B ", " text C"],
  )
})

test("hand-typed markers are not attachments and block the send", () => {
  const { editor, payloads, blocked } = makeEditor()
  typeText(editor, "see [Image #42] please")
  assert.deepEqual(editor.getImageAttachments(), [])
  assert.equal(editor.hasImageAttachments(), false)
  assert.throws(() => editor.getPromptContent(), (error: unknown) => {
    assert.ok(error instanceof mod.CcUnresolvedImageMarkerError)
    assert.deepEqual((error as InstanceType<typeof mod.CcUnresolvedImageMarkerError>).markerIds, [42])
    return true
  })

  press(editor, "\r") // Enter
  assert.equal(payloads.length, 0, "the draft is never submitted as text only")
  assert.equal(editor.getText(), "see [Image #42] please", "the draft is preserved")
  assert.equal(blocked.length, 1)
  assert.ok(blocked[0] instanceof mod.CcUnresolvedImageMarkerError)
})

test("submit delivers pre-clear text, content and snapshot, then clears", () => {
  const { editor, payloads, legacy } = makeEditor()
  editor.setText("describe")
  renderAt(editor, 80)
  press(editor, "\x05")
  editor.insertImage(upload(1))
  typeText(editor, " this")

  press(editor, "\r")
  assert.equal(payloads.length, 1, "onSubmitContent receives exactly one payload")
  assert.equal(legacy.length, 0, "the legacy text callback is not also fired")
  const payload = payloads[0]!
  assert.equal(payload.text, "describe [Image #1] this")
  assert.deepEqual(
    payload.content.map((part) => part.type),
    ["text", "image", "text"],
  )
  assert.equal(payload.images.length, 1)
  assert.equal(payload.wasBrowsingHistory, false)
  // Snapshot is the pre-clear state, so the app can recover a failed admission.
  assert.deepEqual(payload.snapshot.lines, ["describe [Image #1] this"])
  assert.equal(payload.snapshot.imageAttachments.length, 1)
  assert.equal(editor.getText(), "", "the editor cleared after the capture")

  // The captured snapshot restores the full draft, images included.
  editor.restoreDraft(payload.snapshot)
  assert.equal(editor.getText(), "describe [Image #1] this")
  assert.equal(editor.getPromptContent().filter((part) => part.type === "image").length, 1)
})

test("an image-only draft submits without relying on trimmed text", () => {
  const { editor, payloads } = makeEditor()
  editor.insertImage(upload(1))
  assert.equal(editor.getText(), "[Image #1]")
  press(editor, "\r")
  assert.equal(payloads.length, 1)
  const payload = payloads[0]!
  assert.equal(payload.content.length, 1)
  assert.equal(payload.content[0]!.type, "image")
  assert.equal(editor.getText(), "")
})

test("images without a content consumer are never sent as text only", () => {
  const ctx = makeEditor()
  ctx.editor.onSubmitContent = undefined
  const blocked: Error[] = []
  ctx.editor.onSubmitBlocked = (error: Error) => {
    blocked.push(error)
  }
  typeText(ctx.editor, "caption ")
  ctx.editor.insertImage(upload(1))
  press(ctx.editor, "\r")
  assert.equal(blocked.length, 1)
  assert.match(blocked[0]!.message, /no prompt-content consumer/)
  assert.equal(ctx.editor.getText(), "caption [Image #1]")
  assert.equal(ctx.legacy.length, 0)
})

test("text-only drafts keep the legacy onSubmit(text) behaviour", () => {
  const ctx = makeEditor()
  ctx.editor.onSubmitContent = undefined
  typeText(ctx.editor, "hello")
  press(ctx.editor, "\r")
  assert.deepEqual(ctx.legacy, ["hello"])
  assert.equal(ctx.blocked.length, 0)
})

test("snapshots round-trip image payloads for stash and cleared-draft recovery", () => {
  const { editor } = makeEditor()
  typeText(editor, "note")
  editor.insertImage(upload(3))
  const snapshot = editor.captureDraft()
  assert.equal(snapshot.imageAttachments.length, 1)
  assert.ok(mod.isCcDraftSnapshot(JSON.parse(JSON.stringify(snapshot))), "memory snapshots stay JSON-safe")

  editor.replaceDraftText("")
  assert.equal(editor.hasImageAttachments(), false)
  editor.restoreDraft(JSON.parse(JSON.stringify(snapshot)))
  assert.equal(editor.getText(), "note [Image #1]")
  assert.equal(editor.getImageAttachments()[0]!.id, 1)
  assert.deepEqual(editor.getImageAttachments()[0]!.image, upload(3))

  // Ids keep counting up, so a restored marker can never point at a new image.
  press(editor, "\x05")
  assert.equal(editor.insertImage(upload(4)), 2)
})

test("in-session history recall keeps real images", () => {
  const { editor, payloads } = makeEditor()
  typeText(editor, "with image ")
  editor.insertImage(upload(1))
  press(editor, "\r")
  assert.equal(editor.getText(), "")
  editor.addToHistory(payloads[0]!.text) // the app records history after a submit

  typeText(editor, "plain entry")
  press(editor, "\r")
  editor.addToHistory("plain entry")

  // Up recalls the newest entry, Up again the image entry.
  press(editor, "\x10")
  assert.equal(editor.getText(), "plain entry")
  press(editor, "\x10")
  assert.equal(editor.getText(), "with image [Image #1]")
  assert.deepEqual(
    editor.getImageAttachments().map((entry) => entry.id),
    [1],
  )
  assert.doesNotThrow(() => editor.getPromptContent())

  // Down returns to the (empty) draft without leaving dangling attachments.
  press(editor, "\x0e", "\x0e")
  assert.equal(editor.getText(), "")
  assert.equal(editor.hasImageAttachments(), false)
})

test("a draft restored from persisted history cannot silently send text only", () => {
  const { editor, blocked } = makeEditor()
  // history.json only stores text: the marker survives, the upload does not.
  editor.addToHistory("[Image #7] look at this")
  editor.ccSetHistory(["[Image #7] look at this"])
  press(editor, "\x10")
  assert.equal(editor.getText(), "[Image #7] look at this")
  assert.deepEqual(editor.getImageAttachments(), [])
  press(editor, "\r")
  assert.equal(blocked.length, 1)
  assert.ok(blocked[0] instanceof mod.CcUnresolvedImageMarkerError)
  assert.equal(editor.getText(), "[Image #7] look at this")
})

test("payloads reachable from the native undo stack are never reclaimed", () => {
  // The spare budget is zero: only undo reachability protects the payloads.
  const { editor } = makeEditor({ imageBudgets: { liveBytes: 1_000_000, sparePayloads: 0, historyBytes: 1_000_000 } })
  renderAt(editor, 80)
  editor.setText("a ")
  press(editor, "\x05")
  editor.insertImage(upload(1))
  editor.ccSetCursor(0, editor.getText().length)
  press(editor, "\x7f")
  assert.equal(editor.getText(), "a ")
  assert.ok(!editor.hasImageAttachments(), "the draft no longer shows the marker")

  // The payload is still reachable through the real undo stack, so it survives.
  const entries = editor.getImageAttachmentEntries().map(([id]) => id)
  assert.deepEqual(entries, [1], "undo-reachable payload was kept")
  press(editor, "\x1f")
  assert.equal(editor.getText(), "a [Image #1]")
  assert.doesNotThrow(() => editor.getPromptContent(), "Ctrl+_ restores a resolvable image")

  // A kill-ring copy is protected the same way.
  editor.ccSetCursor(0, editor.getText().length)
  press(editor, "\x17")
  assert.ok(editor.ccGetKillRing().some((entry) => entry.includes("[Image #1]")))
  editor.insertImage(upload(2)) // triggers a reclaim pass
  press(editor, "\x19")
  assert.doesNotThrow(() => editor.getPromptContent(), "Ctrl+Y restores a resolvable image")
})

test("the budget refuses new pastes instead of destroying undoable images", () => {
  const { editor } = makeEditor({ imageBudgets: { liveBytes: 1200, sparePayloads: 0, historyBytes: 1_000_000 } })
  renderAt(editor, 80)
  const inserted: number[] = []
  let refused: Error | undefined
  for (let index = 0; index < 10; index += 1) {
    try {
      inserted.push(editor.insertImage(upload(index + 1, 400)))
    } catch (error) {
      refused = error as Error
      break
    }
    press(editor, "\x7f") // delete again: the payload stays undo-reachable
  }
  assert.ok(refused instanceof mod.CcImageBudgetError, "the budget reports a clear error")
  assert.ok(inserted.length >= 2, "several undoable images were accepted first")
  assert.equal(editor.getText(), "", "a refused insert does not edit the draft")

  // Every accepted image is still undoable and resolvable.
  for (let index = inserted.length; index > 0; index -= 1) {
    press(editor, "\x1f")
    assert.doesNotThrow(() => editor.getPromptContent(), `undo step ${index} stays resolvable`)
  }
})

test("spare payloads are reclaimed once neither draft, undo, kill ring nor history can reach them", () => {
  const { editor, payloads } = makeEditor({ imageBudgets: { liveBytes: 1_000_000, sparePayloads: 1, historyBytes: 1_000_000 } })
  for (let index = 0; index < 4; index += 1) {
    editor.insertImage(upload(index + 1, 64))
    press(editor, "\r") // submit clears the undo stack and the draft
    editor.addToHistory(payloads[payloads.length - 1]!.text)
  }
  // Submitted entries keep their payloads through the history registry.
  assert.ok(editor.getHistoryImageAttachmentEntries().length >= 1)
  editor.ccSetHistory([]) // the app drops its history list
  editor.insertImage(upload(9, 64)) // triggers the reclaim pass
  const live = editor.getImageAttachmentEntries().map(([id]) => id)
  assert.ok(live.length <= 2, `unreachable payloads are reclaimed, got ${live.length}`)
})

test("history payload registry is bounded and pruned with the history list", () => {
  const { editor, payloads } = makeEditor({ imageBudgets: { liveBytes: 4096, sparePayloads: 2, historyBytes: 1200 } })
  for (let index = 0; index < 6; index += 1) {
    editor.insertImage(upload(index + 1, 256))
    typeText(editor, ` entry ${index}`)
    press(editor, "\r")
    editor.addToHistory(payloads[payloads.length - 1]!.text)
  }
  const kept = editor.getHistoryImageAttachmentEntries()
  const total = kept.reduce(
    (sum, [, stored]) =>
      sum + stored.reduce((inner, [, payload]) => inner + String((payload as ImageUploadPart).data).length, 0),
    0,
  )
  assert.ok(total <= 1200, `history payloads stay within budget, got ${total}`)
  assert.ok(kept.length <= 6)

  // Replacing the history list drops the payloads of entries that are gone.
  editor.ccSetHistory([])
  assert.deepEqual(editor.getHistoryImageAttachmentEntries(), [])
})
// --- marker identity ---------------------------------------------------------

test("a persisted history marker reserves its id so a new paste cannot reuse it", () => {
  const { editor, blocked } = makeEditor()
  // Startup: history.json only kept the old marker text, no upload.
  editor.ccSetHistory(["[Image #1] old screenshot", "plain entry"])
  press(editor, "\x10")
  assert.equal(editor.getText(), "[Image #1] old screenshot", "the unresolved marker is preserved verbatim")
  assert.deepEqual(editor.getImageAttachments(), [])
  assert.throws(() => editor.getPromptContent(), mod.CcUnresolvedImageMarkerError)

  // Back to the empty draft, paste a new image: it must not become id 1.
  press(editor, "\x0e")
  assert.equal(editor.getText(), "")
  const id = editor.insertImage(upload(9))
  assert.equal(id, 2, "the persisted marker kept id 1 reserved")
  assert.equal(editor.getText(), "[Image #2]")
  assert.deepEqual(
    editor.getImageAttachments().map((entry) => entry.image.data),
    [upload(9).data],
  )

  // The old entry still resolves to nothing, so it can never point at the new image.
  press(editor, "\x10")
  assert.equal(editor.getText(), "[Image #1] old screenshot")
  assert.deepEqual(editor.getImageAttachments(), [])
  press(editor, "\r")
  assert.equal(blocked.length, 1, "the old entry is still explicitly unsendable")
})

test("restoring an older snapshot never reuses ids allocated afterwards", () => {
  const { editor } = makeEditor()
  editor.setText("draft")
  renderAt(editor, 80)
  press(editor, "\x05")
  assert.equal(editor.insertImage(upload(1)), 1)
  const older = editor.captureDraft()

  // Allocate more ids after the snapshot was taken.
  assert.equal(editor.insertImage(upload(2)), 2)
  assert.equal(editor.insertImage(upload(3)), 3)

  editor.restoreDraft(JSON.parse(JSON.stringify(older)))
  assert.equal(editor.getText(), "draft [Image #1]")
  press(editor, "\x05")
  assert.equal(editor.insertImage(upload(4)), 4, "the high-water mark survives the restore")

  // Restoring a snapshot that carries a *lower* counter cannot roll it back either.
  const rewritten = { ...older, imageCounter: 1 }
  editor.restoreDraft(JSON.parse(JSON.stringify(rewritten)))
  press(editor, "\x05")
  assert.equal(editor.insertImage(upload(5)), 5)
})

test("marker text set from outside also reserves ids", () => {
  const { editor } = makeEditor()
  // e.g. a restored draft or a queued message re-applied through setText.
  editor.setText("[Image #41] earlier draft")
  assert.equal(editor.insertImage(upload(1)), 42)

  // Safe-integer boundary: a marker at the top of the range is accepted once and
  // then the id space is exhausted instead of wrapping or colliding.
  editor.replaceDraftText("[Image #9007199254740991] top")
  assert.throws(() => editor.insertImage(upload(2)), /id space exhausted/)
  assert.equal(editor.getText(), "[Image #9007199254740991] top", "the refused insert did not edit the draft")
})

test("history payload mappings only ever reference their own entry text", () => {
  const { editor, payloads } = makeEditor()
  editor.setText("alpha ")
  renderAt(editor, 80)
  press(editor, "\x05")
  editor.insertImage(upload(1))
  press(editor, "\r")
  editor.addToHistory(payloads[0]!.text)

  // A later draft with the same visible text but a different image must map only
  // to its own marker id, never back onto the older entry's payload.
  editor.setText("beta ")
  renderAt(editor, 80)
  press(editor, "\x05")
  editor.insertImage(upload(2))
  press(editor, "\r")
  editor.addToHistory(payloads[1]!.text)

  const mapping = new Map(editor.getHistoryImageAttachmentEntries())
  assert.deepEqual([...mapping.keys()].sort(), ["alpha [Image #1]", "beta [Image #2]"])
  assert.deepEqual(
    mapping.get("alpha [Image #1]")!.map(([id]) => id),
    [1],
  )
  assert.deepEqual(
    mapping.get("beta [Image #2]")!.map(([id]) => id),
    [2],
  )

  // Recalling each entry restores exactly its own upload.
  press(editor, "\x10")
  assert.equal(editor.getText(), "beta [Image #2]")
  assert.equal(editor.getImageAttachments()[0]!.image.data, upload(2).data)
  press(editor, "\x10")
  assert.equal(editor.getText(), "alpha [Image #1]")
  assert.equal(editor.getImageAttachments()[0]!.image.data, upload(1).data)
})
