/**
 * CC-style native file attachments on the single Pi editor state (input-owned).
 *
 * `[File #N]` is its own atomic marker family: separate ids and registry from
 * `[Image #N]`, mixed text/image/file order preserved verbatim, memory-only
 * payloads, and the exact shared `PromptContentPart.file` shape
 * (`{ type: "file", attachment: { attachmentId, name, bytes } }`).
 *
 * DSH owns staging/admission; these tests drive real key sequences and assert
 * text, cursor, registry, snapshot and prompt content. No file is read, no
 * clipboard/model/tty is involved and no path is ever auto-uploaded.
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
import type { FileAttachmentRef } from "../src/backend/types.ts"

const mod = await loadInputModule()
type TestEditor = InstanceType<typeof mod.CcEditor>
type SubmitPayload = import("../src/input/index.ts").CcSubmitPayload

/** Native metadata only; no bytes, path or store id. Empty files are valid. */
function ref(id: string, name = `notes-${id}.txt`, bytes = 12): FileAttachmentRef {
  return { attachmentId: id, name, bytes }
}

/** The shared file prompt part the parent builds from a durable native ref. */
function filePart(attachment: FileAttachmentRef) {
  return { type: "file" as const, attachment }
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

function fileMarkerIds(editor: TestEditor): string[] {
  return editor.getText().match(/\[File #\d+\]/g) ?? []
}

test("insertFile writes one atomic [File #N] marker with its native ref", () => {
  const { editor } = makeEditor()
  editor.setText("read this")
  renderAt(editor, 80)
  press(editor, "\x05") // Ctrl+E: end of line

  const id = editor.insertFile({ part: filePart(ref("att-1")) })
  assert.equal(id, 1)
  assert.equal(editor.getText(), "read this [File #1]")
  assert.deepEqual(editor.getCursor(), { line: 0, col: "read this [File #1]".length })
  assert.ok(editor.hasFileAttachments())
  assert.equal(editor.hasImageAttachments(), false)
  const files = editor.getFileAttachments()
  assert.equal(files.length, 1)
  assert.equal(files[0]!.id, 1)
  assert.deepEqual(files[0]!.part, filePart(ref("att-1")))
  assert.deepEqual(files[0]!.attachment, ref("att-1"))
  assert.deepEqual(editor.getAttachmentCounts(), { images: 0, files: 1 })

  // The bare shared part is accepted too, and the alias is the same method.
  assert.deepEqual(
    editor.insertFile(filePart(ref("att-2"))),
    2,
    "the marker id is monotonic per file family",
  )
  assert.deepEqual(editor.insertFile(filePart(ref("att-3"))), 3)
  assert.equal(editor.getText(), "read this [File #1] [File #2] [File #3]")

  // A marker inserted in the middle of a word never glues onto it.
  editor.setText("a")
  renderAt(editor, 80)
  press(editor, "\x05")
  editor.insertFile(filePart(ref("att-4")))
  assert.equal(editor.getText(), "a [File #4]")
  typeText(editor, "b")
  // Typing at the end of the line does not insert a spacer (same as images):
  // the marker stays one atomic token, so the typed letter is its own token.
  assert.equal(editor.getText(), "a [File #4]b")
  press(editor, "\x7f")
  assert.equal(editor.getText(), "a [File #4]", "Backspace removed only the typed letter")
  press(editor, "\x7f")
  assert.equal(editor.getText(), "a ", "the whole marker goes in one Backspace")
})

test("addFile is the same single-editor insert path", () => {
  const { editor } = makeEditor()
  const id = editor.addFile(filePart(ref("att-add")))
  assert.equal(id, 1)
  assert.equal(editor.getText(), "[File #1]")
  assert.deepEqual(editor.getFileAttachments()[0]!.attachment, ref("att-add"))
})

test("images and files keep separate ids, registries and markers", () => {
  const { editor } = makeEditor()
  editor.insertImage({ type: "image", mediaType: "image/png", data: Buffer.from("img").toString("base64") })
  editor.insertFile(filePart(ref("att-1")))
  editor.insertImage({ type: "image", mediaType: "image/png", data: Buffer.from("img2").toString("base64") })

  assert.equal(editor.getText(), "[Image #1] [File #1] [Image #2]")
  assert.deepEqual(editor.getAttachmentCounts(), { images: 2, files: 1 })
  const occurrences = editor.getAttachmentOccurrences()
  assert.deepEqual(
    occurrences.map((occurrence) => [occurrence.kind, occurrence.id]),
    [
      ["image", 1],
      ["file", 1],
      ["image", 2],
    ],
  )
  // A file marker never resolves to an image payload and vice versa.
  assert.equal(editor.getImageAttachments().length, 2)
  assert.equal(editor.getFileAttachments().length, 1)
})

test("file markers are atomic for backspace, Delete, Ctrl+W, line kills, undo and yank", () => {
  const { editor } = makeEditor()
  editor.insertFile(filePart(ref("att-1")))
  editor.setText("a [File #1] b")
  renderAt(editor, 80)

  // Backspace right after the marker removes the whole token at once.
  editor.ccSetCursor(0, "a [File #1]".length)
  press(editor, "\x7f")
  assert.equal(editor.getText(), "a  b")
  assert.ok(!editor.getText().includes("File"), "no partial marker text is left")
  press(editor, "\x1f") // undo restores text and the native part together
  assert.equal(editor.getText(), "a [File #1] b")
  assert.equal(editor.getFileAttachments().length, 1)

  // Forward delete at the start of the marker is the same atomic unit.
  editor.ccSetCursor(0, "a ".length)
  press(editor, "\x1b[3~")
  assert.equal(editor.getText(), "a  b")
  press(editor, "\x1f")
  assert.equal(editor.getText(), "a [File #1] b")

  // Ctrl+W (whitespace kill) and Alt+Backspace (word kill) never split it.
  editor.ccSetCursor(0, "a [File #1]".length)
  press(editor, "\x17")
  assert.equal(editor.getText(), "a  b")
  assert.deepEqual(editor.ccGetKillRing()[0], "[File #1]", "the marker is the whole killed token")
  press(editor, "\x1f")
  editor.ccSetCursor(0, "a [File #1]".length)
  press(editor, "\x1b\x7f") // Alt+Backspace: word kill
  assert.equal(editor.getText(), "a  b")
  press(editor, "\x1f")
  assert.equal(editor.getText(), "a [File #1] b")

  // Kill + yank keeps the payload resolvable through the kill ring.
  editor.ccSetCursor(0, "a [File #1]".length)
  press(editor, "\x0b") // Ctrl+K: kill to end of line
  assert.equal(editor.getText(), "a [File #1]")
  press(editor, "\x19") // Ctrl+Y: yank it back
  assert.equal(editor.getText(), "a [File #1] b")
  assert.equal(editor.getFileAttachments().length, 1)
  assert.deepEqual(editor.getFileAttachments()[0]!.attachment, ref("att-1"))
})

test("mixed text/image/file prompt content keeps every position and repeated marker", () => {
  const { editor } = makeEditor()
  const image = { type: "image" as const, mediaType: "image/png" as const, data: Buffer.from("png").toString("base64") }
  editor.insertImage(image)
  const file = ref("att-1", "报告 📊.txt", 0) // empty file + CJK/emoji metadata
  editor.insertFile(filePart(file))
  editor.setText("开头 [Image #1] 中间 [File #1] 结尾 [File #1] 🎉")
  renderAt(editor, 80)

  const content = editor.getPromptContent()
  assert.deepEqual(
    content.map((part) => part.type),
    ["text", "image", "text", "file", "text", "file", "text"],
  )
  assert.deepEqual(content[0], { type: "text", text: "开头 " })
  assert.equal(content[1]!.type, "image")
  assert.deepEqual(content[2], { type: "text", text: " 中间 " })
  assert.deepEqual(content[3], { type: "file", attachment: file })
  assert.deepEqual(content[4], { type: "text", text: " 结尾 " })
  // A repeated marker is repeated content: the input layer never de-duplicates.
  assert.deepEqual(content[5], { type: "file", attachment: file })
  assert.deepEqual(content[6], { type: "text", text: " 🎉" })
  assert.equal(editor.getFileAttachments().length, 2)
  assert.deepEqual(editor.getAttachmentCounts(), { images: 1, files: 2 })
})

test("text around markers keeps indentation, newlines, CJK and emoji verbatim", () => {
  const { editor } = makeEditor()
  editor.insertFile(filePart(ref("att-1")))
  editor.setText("  缩进\n[File #1]\n\t制表符 🚀")
  renderAt(editor, 80)
  const content = editor.getPromptContent()
  assert.deepEqual(
    content.map((part) => part.type),
    ["text", "file", "text"],
  )
  assert.deepEqual(content[0], { type: "text", text: "  缩进\n" })
  // Pi `setText` normalizes tabs to four spaces (upstream draft storage rule);
  // the CJK/emoji text after the marker is preserved verbatim.
  assert.deepEqual(content[2], { type: "text", text: "\n    制表符 🚀" })
})

test("file-only submit delivers the native part and clears the draft", () => {
  const { editor, payloads, legacy } = makeEditor()
  const file = ref("att-only", "empty.csv", 0)
  editor.insertFile(filePart(file))
  assert.equal(editor.getText(), "[File #1]")

  press(editor, "\r")
  assert.equal(payloads.length, 1)
  assert.equal(legacy.length, 0, "the legacy text callback is not also fired")
  const payload = payloads[0]!
  assert.equal(payload.text, "[File #1]")
  assert.deepEqual(payload.content, [{ type: "file", attachment: file }])
  assert.equal(payload.files.length, 1)
  assert.equal(payload.images.length, 0)
  assert.equal(payload.wasBrowsingHistory, false)
  assert.equal(editor.getText(), "", "the editor cleared after the capture")
  assert.equal(editor.hasFileAttachments(), false)

  // The pre-clear snapshot restores the exact draft, native part included.
  editor.restoreDraft(payload.snapshot)
  assert.equal(editor.getText(), "[File #1]")
  assert.deepEqual(editor.getFileAttachments()[0]!.part, filePart(file))
})

test("files without a content consumer are never sent as text only", () => {
  const ctx = makeEditor()
  ctx.editor.onSubmitContent = undefined
  typeText(ctx.editor, "caption ")
  ctx.editor.insertFile(filePart(ref("att-1")))
  press(ctx.editor, "\r")
  assert.equal(ctx.blocked.length, 1)
  assert.match(ctx.blocked[0]!.message, /no prompt-content consumer/)
  assert.equal(ctx.editor.getText(), "caption [File #1]")
  assert.equal(ctx.legacy.length, 0)
})

test("a typed [File #N] marker is not an attachment and blocks the send", () => {
  const { editor, payloads, blocked } = makeEditor()
  typeText(editor, "see [File #9] please")
  assert.equal(editor.hasFileAttachments(), false)
  assert.equal(editor.getAttachmentCounts().files, 0)

  press(editor, "\r")
  assert.equal(payloads.length, 0)
  assert.equal(blocked.length, 1)
  assert.ok(blocked[0] instanceof mod.CcUnresolvedFileAttachmentError)
  assert.deepEqual((blocked[0] as InstanceType<typeof mod.CcUnresolvedFileAttachmentError>).markerIds, [9])
  assert.equal(editor.getText(), "see [File #9] please", "the draft is kept, never sent as text only")

  // The typed marker reserved its id: a later attach cannot reuse it.
  press(editor, "\x05")
  assert.equal(editor.insertFile(filePart(ref("att-later"))), 10)
})

test("plain text paths and pasted paths are never promoted to file attachments", () => {
  const { editor, payloads } = makeEditor()
  typeText(editor, "check ./docs/notes.md and /tmp/report.csv")
  press(editor, "\x1b[200~/Users/me/quarterly report.csv\x1b[201~")
  assert.equal(editor.hasFileAttachments(), false)
  assert.deepEqual(editor.getAttachmentCounts(), { images: 0, files: 0 })
  // Pi prepends one readability space when a path-like paste follows a word
  // character; that is draft text only and still creates no attachment.
  assert.equal(
    editor.getText(),
    "check ./docs/notes.md and /tmp/report.csv /Users/me/quarterly report.csv",
  )

  press(editor, "\r")
  assert.equal(payloads.length, 1)
  assert.deepEqual(payloads[0]!.files, [])
  assert.deepEqual(
    payloads[0]!.content.map((part) => part.type),
    ["text"],
    "no marker, no attachment part: the path stays text",
  )
  assert.match((payloads[0]!.content[0] as { text: string }).text, /notes\.md/)
})

test("invalid or guessed file payloads are rejected before the draft changes", () => {
  const { editor } = makeEditor()
  typeText(editor, "keep me")
  const before = { text: editor.getText(), cursor: editor.getCursor() }

  assert.throws(() => editor.insertFile({} as never), /native file prompt part/i)
  assert.throws(() => mod.asCcFileUpload({ type: "text", text: "not a file" }), /native file prompt part/i)
  assert.throws(
    () => editor.insertFile({ type: "file", attachment: { attachmentId: "", name: "", bytes: -1 } }),
    /malformed native metadata|native file prompt part/i,
  )
  assert.throws(() => mod.asCcFileUpload({ part: { type: "file", attachment: { attachmentId: "x" } } }), /native file prompt part/i)

  assert.deepEqual({ text: editor.getText(), cursor: editor.getCursor() }, before)
  assert.equal(editor.hasFileAttachments(), false)
})

test("snapshots carry file payloads and older snapshots stay compatible", () => {
  const { editor } = makeEditor()
  typeText(editor, "note ")
  const file = ref("att-1", "资料.txt", 128)
  editor.insertFile(filePart(file))
  const snapshot = editor.captureDraft()
  assert.deepEqual(snapshot.fileAttachments, [[1, { part: filePart(file) }]])
  assert.equal(snapshot.fileCounter, 1)

  const serialized = mod.serializeCcDraftSnapshot(snapshot)
  assert.ok(mod.isCcDraftSnapshot(JSON.parse(serialized)), "memory snapshots stay JSON-safe")
  assert.ok(!serialized.includes("streamed-bytes"), "no invented byte field is written")

  editor.replaceDraftText("")
  assert.equal(editor.hasFileAttachments(), false)
  editor.restoreDraft(mod.deserializeCcDraftSnapshot(serialized))
  assert.equal(editor.getText(), "note [File #1]")
  assert.deepEqual(editor.getFileAttachments()[0]!.attachment, file)

  // Ids keep counting up, so a restored marker can never point at a new file.
  press(editor, "\x05")
  assert.equal(editor.insertFile(filePart(ref("att-2"))), 2)

  // Pre-file snapshots (no file fields at all) still parse.
  const legacy = JSON.parse(serialized) as Record<string, unknown>
  delete legacy.fileAttachments
  delete legacy.fileCounter
  const parsed = mod.parseCcDraftSnapshot(JSON.parse(JSON.stringify(legacy)))
  assert.deepEqual(parsed.fileAttachments, [])
  assert.equal(parsed.fileCounter, 0)
})

test("a malformed file payload is rejected instead of poisoning a restore", () => {
  const { editor } = makeEditor()
  editor.insertFile(filePart(ref("att-1")))
  const serialized = mod.serializeCcDraftSnapshot(editor.captureDraft())

  const broken = JSON.parse(serialized) as Record<string, unknown>
  broken.fileAttachments = [[1, { part: { type: "file", attachment: { attachmentId: "", name: "", bytes: -4 } } }]]
  assert.equal(mod.isCcDraftSnapshot(broken), false)
  assert.throws(() => mod.parseCcDraftSnapshot(broken), /Invalid CcDraftSnapshot/)
  assert.throws(() => editor.restoreDraft(JSON.parse(JSON.stringify(broken))), /native file prompt part|malformed/i)
})

test("restoring an older file snapshot never reuses ids allocated afterwards", () => {
  const { editor } = makeEditor()
  const before = editor.captureDraft()
  editor.insertFile(filePart(ref("att-1")))
  editor.insertFile(filePart(ref("att-2")))
  editor.restoreDraft(before)
  assert.equal(editor.getText(), "")
  press(editor, "\x05")
  assert.equal(editor.insertFile(filePart(ref("att-3"))), 3, "ids stay monotonic across restore")
})

test("file payloads survive stash, modal context switches and external editing", () => {
  const { editor } = makeEditor()
  typeText(editor, "draft ")
  editor.insertFile(filePart(ref("att-1")))
  const stashed = editor.captureDraft()

  // Modal text field / model picker: same editor state, attachments untouched.
  editor.setContext("modalSearch")
  const search = editor.captureDraft()
  editor.restoreDraft(search)
  editor.setContext("editor")
  assert.equal(editor.getText(), "draft [File #1]")
  assert.equal(editor.getAttachmentCounts().files, 1)

  editor.replaceDraftText("")
  assert.equal(editor.hasFileAttachments(), false)
  editor.restoreDraft(stashed, { notify: false })
  assert.equal(editor.getText(), "draft [File #1]")
  assert.deepEqual(editor.getFileAttachments()[0]!.attachment, ref("att-1"))

  // External editor round trip: unchanged text restores the same attachment.
  const external = editor.captureDraftForExternalEditor()
  assert.equal(external.text, "draft [File #1]")
  editor.applyExternalEdit(external.text, external.snapshot)
  assert.equal(editor.getAttachmentCounts().files, 1)
  assert.deepEqual(editor.getFileAttachments()[0]!.attachment, ref("att-1"))
})

test("in-session history recall keeps real file attachments", () => {
  const { editor, payloads } = makeEditor()
  typeText(editor, "with file ")
  editor.insertFile(filePart(ref("att-1")))
  press(editor, "\r")
  assert.equal(editor.getText(), "")
  editor.addToHistory(payloads[0]!.text) // the app records history after a submit

  typeText(editor, "plain entry")
  press(editor, "\r")
  editor.addToHistory("plain entry")

  press(editor, "\x10") // Up: the plain entry
  assert.equal(editor.getText(), "plain entry")
  press(editor, "\x10") // Up: the file entry
  assert.equal(editor.getText(), "with file [File #1]")
  assert.deepEqual(editor.getFileAttachments()[0]!.attachment, ref("att-1"))
  assert.equal(editor.getPromptContent().filter((part) => part.type === "file").length, 1)

  // A recalled entry can be sent again with its native part.
  press(editor, "\r")
  assert.equal(payloads.length, 3, "the first submit, the plain submit and the recall")
  assert.deepEqual(payloads[2]!.files[0]!.attachment, ref("att-1"))
  assert.deepEqual(payloads[2]!.content, [{ type: "text", text: "with file " }, { type: "file", attachment: ref("att-1") }])
})

test("a file marker restored from persisted history cannot silently send text only", () => {
  const { editor, payloads, blocked } = makeEditor()
  editor.ccSetHistory(["old [File #3] entry"])
  press(editor, "\x10")
  assert.equal(editor.getText(), "old [File #3] entry")
  press(editor, "\r")
  assert.equal(payloads.length, 0)
  assert.equal(blocked.length, 1)
  assert.ok(blocked[0] instanceof mod.CcUnresolvedFileAttachmentError)
})

test("capture restore after a native rejection preserves order and re-submits", () => {
  const { editor, payloads } = makeEditor()
  const image = { type: "image" as const, mediaType: "image/png" as const, data: Buffer.from("png").toString("base64") }
  const fileA = ref("att-a", "a.txt", 3)
  const fileB = ref("att-b", "b.bin", 0)
  typeText(editor, "顺序 ")
  editor.insertFile(filePart(fileA))
  typeText(editor, " tail ")
  editor.insertImage(image)
  typeText(editor, " ")
  editor.insertFile(filePart(fileB))

  press(editor, "\r")
  const payload = payloads[0]!
  assert.deepEqual(
    payload.content.map((part) => part.type),
    ["text", "file", "text", "image", "text", "file"],
  )
  const draftBefore = payload.snapshot

  // Native admission rejected: the app restores the captured snapshot, unless a
  // newer draft/stale attachment appeared (that guard is the parent's).
  editor.restoreDraft(draftBefore)
  assert.equal(editor.getText(), "顺序 [File #1] tail [Image #1] [File #2]")
  assert.deepEqual(editor.getAttachmentCounts(), { images: 1, files: 2 })

  // A newer draft is not overwritten by a stale restore (parent policy: skip).
  editor.replaceDraftText("newer")
  assert.equal(editor.hasFileAttachments(), false)

  // A successful re-submit of the restored snapshot keeps the same order.
  editor.restoreDraft(draftBefore)
  press(editor, "\r")
  assert.equal(payloads.length, 2)
  assert.deepEqual(
    payloads[1]!.content.map((part) => part.type),
    ["text", "file", "text", "image", "text", "file"],
  )
})

test("the attachment budget refuses a new file instead of breaking undo", () => {
  const { editor } = makeEditor({ imageBudgets: { liveBytes: 150, sparePayloads: 0, historyBytes: 1024 } })
  const first = ref("att-1")
  assert.equal(editor.insertFile(filePart(first)), 1)
  const payloadBytes = JSON.stringify({ part: filePart(first) }).length
  assert.ok(payloadBytes < 150, "the measured payload fits the test budget")

  assert.throws(() => editor.insertFile(filePart(ref("att-2"))), mod.CcFileBudgetError)
  assert.equal(editor.getText(), "[File #1]", "the refused insert never touched the draft")
  assert.deepEqual(editor.getFileAttachments()[0]!.attachment, first)

  // Nothing was destroyed: kill/yank and undo still resolve the same payload.
  press(editor, "\x15") // Ctrl+U
  assert.equal(editor.getText(), "")
  press(editor, "\x19") // Ctrl+Y
  assert.equal(editor.getText(), "[File #1]")
  assert.deepEqual(editor.getFileAttachments()[0]!.attachment, first)
  press(editor, "\x1f") // undo the yank/kill edit
  assert.equal(editor.getText(), "")
  assert.equal(editor.getAttachmentCounts().files, 0)
})

// --- production dual-consumer dispatch -----------------------------------
//
// The production App installs BOTH `onSubmit` (legacy text) and
// `onSubmitContent` (multipart), and calls `editor.ccSubmit()` directly for
// send-now / steer / follow-up / queue delivery. These regressions pin the
// dispatch: any attached image or file must reach the multipart consumer, and
// the plain text consumer must never receive draft marker text.

test("a direct ccSubmit routes a file-only draft to the multipart consumer", () => {
  const { editor, payloads, legacy, blocked } = makeEditor()
  const file = ref("att-only", "report.csv", 0)
  editor.insertFile(filePart(file))
  // Exactly what the production App can observe before submitting.
  assert.deepEqual(editor.getPromptContent(), [{ type: "file", attachment: file }])

  editor.ccSubmit() // App path: send-now / steer / follow-up / queue
  assert.equal(blocked.length, 0)
  assert.equal(legacy.length, 0, "the plain onSubmit never receives '[File #1]'")
  assert.equal(payloads.length, 1)
  const payload = payloads[0]!
  assert.deepEqual(payload.content, [{ type: "file", attachment: file }])
  assert.deepEqual(payload.files.map((entry) => entry.attachment), [file])
  assert.deepEqual(payload.images, [])
  // Capture identity: the pre-clear draft, not the cleared text.
  assert.deepEqual(payload.snapshot.lines, ["[File #1]"])
  assert.deepEqual(payload.snapshot.fileAttachments, [[1, { part: filePart(file) }]])
  assert.equal(payload.snapshot.fileCounter, 1)
  assert.equal(editor.getText(), "", "the draft cleared through the same path as Enter")
})

test("ccSubmit sends mixed text+file (and image) drafts only to the multipart consumer", () => {
  const { editor, payloads, legacy } = makeEditor()
  const image = { type: "image" as const, mediaType: "image/png" as const, data: Buffer.from("png").toString("base64") }
  const file = ref("att-mixed", "数据.txt", 7)
  typeText(editor, "前 ")
  editor.insertImage(image)
  typeText(editor, " 中 ")
  editor.insertFile(filePart(file))
  typeText(editor, " 后")

  editor.ccSubmit()
  assert.equal(legacy.length, 0)
  assert.equal(payloads.length, 1)
  assert.deepEqual(payloads[0]!.content, [
    { type: "text", text: "前 " },
    { type: "image", mediaType: "image/png", data: image.data },
    { type: "text", text: " 中 " },
    { type: "file", attachment: file },
    { type: "text", text: " 后" },
  ])
  assert.equal(editor.getText(), "")
})

test("an image-only ccSubmit is unchanged: multipart, never marker text", () => {
  const { editor, payloads, legacy } = makeEditor()
  const image = { type: "image" as const, mediaType: "image/png" as const, data: Buffer.from("png").toString("base64") }
  editor.insertImage(image)
  editor.ccSubmit()
  assert.equal(legacy.length, 0)
  assert.deepEqual(payloads[0]!.content, [{ type: "image", mediaType: "image/png", data: image.data }])
})

test("multiline and bracketed-paste drafts keep their content through ccSubmit", () => {
  const { editor, payloads, legacy } = makeEditor()
  const file = ref("att-ml", "notes.txt", 3)
  typeText(editor, "line one")
  press(editor, "\x1b\r") // Alt+Enter / newline (not submit)
  editor.insertFile(filePart(file))
  press(editor, "\x1b[200~pasted line\x1b[201~")
  typeText(editor, "\nline three")
  assert.match(editor.getText(), /^line one\n\[File #1\]pasted line\nline three$/m)

  editor.ccSubmit()
  assert.equal(legacy.length, 0)
  assert.equal(payloads.length, 1)
  assert.equal(payloads[0]!.text, "line one\n[File #1]pasted line\nline three")
  assert.deepEqual(payloads[0]!.content, [
    { type: "text", text: "line one\n" },
    { type: "file", attachment: file },
    { type: "text", text: "pasted line\nline three" },
  ])
})

test("Enter and ccSubmit deliver the same payload for the same draft", () => {
  const viaEnter = makeEditor()
  const viaSubmit = makeEditor()
  for (const harness of [viaEnter, viaSubmit]) {
    typeText(harness.editor, "same ")
    harness.editor.insertFile(filePart(ref("att-same")))
  }
  press(viaEnter.editor, "\r")
  viaSubmit.editor.ccSubmit()
  assert.equal(viaEnter.payloads.length, 1)
  assert.equal(viaSubmit.payloads.length, 1)
  assert.deepEqual(viaSubmit.payloads[0]!.content, viaEnter.payloads[0]!.content)
  assert.deepEqual(viaSubmit.payloads[0]!.text, viaEnter.payloads[0]!.text)
  assert.deepEqual(viaSubmit.payloads[0]!.files, viaEnter.payloads[0]!.files)
  assert.equal(viaEnter.legacy.length + viaSubmit.legacy.length, 0)
})

test("text-only drafts keep their existing callback behaviour on ccSubmit", () => {
  const withConsumer = makeEditor()
  typeText(withConsumer.editor, "plain text")
  withConsumer.editor.ccSubmit()
  assert.equal(withConsumer.legacy.length, 0, "a content consumer keeps the multipart path (as with Enter)")
  assert.deepEqual(withConsumer.payloads[0]!.content, [{ type: "text", text: "plain text" }])

  const legacyOnly = makeEditor()
  legacyOnly.editor.onSubmitContent = undefined
  typeText(legacyOnly.editor, "plain text")
  legacyOnly.editor.ccSubmit()
  assert.deepEqual(legacyOnly.legacy, ["plain text"], "no consumer: the legacy text callback is unchanged")
  assert.equal(legacyOnly.blocked.length, 0)
})

test("ccSubmit without a content consumer blocks and preserves draft and undo", () => {
  const { editor, payloads, legacy, blocked } = makeEditor()
  editor.onSubmitContent = undefined
  const file = ref("att-legacy", "keep.txt", 1)
  editor.insertFile(filePart(file))
  typeText(editor, " tail")

  editor.ccSubmit()
  assert.equal(payloads.length, 0)
  assert.equal(legacy.length, 0, "attachments are never sent as marker text")
  assert.equal(blocked.length, 1)
  assert.match(blocked[0]!.message, /no prompt-content consumer/)
  assert.equal(editor.getText(), "[File #1] tail", "the draft is kept")
  assert.deepEqual(editor.getFileAttachments()[0]!.attachment, file)

  // The kept draft is still one editable state: deletion + undo work, and the
  // attachment payload survives undo of the surrounding text.
  press(editor, "\x7f") // Backspace: delete the trailing "l"
  assert.equal(editor.getText(), "[File #1] tai")
  press(editor, "\x1f") // Ctrl+_
  assert.equal(editor.getText(), "[File #1] tail")
  assert.deepEqual(editor.getFileAttachments()[0]!.attachment, file)
})

test("ccSubmit never sends unresolved typed markers as text", () => {
  const { editor, payloads, legacy, blocked } = makeEditor()
  typeText(editor, "手写 [File #7] 标记")
  editor.ccSubmit()
  assert.equal(payloads.length, 0)
  assert.equal(legacy.length, 0, "unresolved marker text is never submitted as text")
  assert.equal(blocked.length, 1)
  assert.ok(blocked[0] instanceof mod.CcUnresolvedFileAttachmentError)
  assert.equal(editor.getText(), "手写 [File #7] 标记")

  // Same rule for a persisted image marker without an upload (unchanged).
  const imageCase = makeEditor()
  typeText(imageCase.editor, "see [Image #5]")
  imageCase.editor.ccSubmit()
  assert.equal(imageCase.legacy.length, 0)
  assert.ok(imageCase.blocked[0] instanceof mod.CcUnresolvedImageMarkerError)
})

test("ccSubmit honours disableSubmit and the disposed-editor contract", () => {
  const { editor, payloads, legacy, blocked } = makeEditor()
  editor.insertFile(filePart(ref("att-disabled")))
  editor.disableSubmit = true
  editor.ccSubmit()
  assert.equal(payloads.length, 0)
  assert.equal(legacy.length, 0)
  assert.equal(blocked.length, 0)
  assert.equal(editor.getText(), "[File #1]")

  editor.disableSubmit = false
  editor.dispose()
  editor.ccSubmit()
  assert.equal(payloads.length, 0)
  assert.equal(legacy.length, 0)
})
