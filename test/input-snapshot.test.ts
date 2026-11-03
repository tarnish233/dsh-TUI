import test from "node:test"
import assert from "node:assert/strict"

import { asTui, createFakeTui, loadInputModule, renderAt, testEditorTheme } from "../src/input/testing/harness.ts"
import type { CcDraftSnapshot, CcEditorOptions } from "../src/input/index.ts"

const mod = await loadInputModule()
type TestEditor = InstanceType<typeof mod.CcEditor>

function makeEditor(options: CcEditorOptions = {}) {
  const editor = new mod.CcEditor(asTui(createFakeTui()), testEditorTheme, options)
  const changes: string[] = []
  editor.onChange = (text) => {
    changes.push(text)
  }
  renderAt(editor, 80)
  return { editor, changes }
}

const LARGE_PASTE = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n")

test("draft snapshots survive JSON round-trips with cursor, pastes, kill ring and undo depth", () => {
  const { editor } = makeEditor()
  editor.handleInput(`\x1b[200~${LARGE_PASTE}\x1b[201~`)
  editor.handleInput(" tail")
  editor.handleInput("\x17") // kill " tail" -> whitespace-delimited token
  assert.match(editor.getText(), /^\[paste #1/)
  editor.ccSetCursor(0, 0)
  const captured = editor.captureDraft()

  const parsed = mod.parseCcDraftSnapshot(JSON.parse(JSON.stringify(captured)))
  assert.equal(parsed.text, captured.text)
  assert.equal(parsed.expandedText, `${LARGE_PASTE} `)

  const restored = makeEditor()
  restored.editor.restoreDraft(parsed)
  assert.equal(restored.editor.getText(), editor.getText())
  assert.equal(restored.editor.getExpandedText(), editor.getExpandedText())
  assert.deepEqual(restored.editor.getCursor(), editor.getCursor())
  assert.deepEqual(restored.editor.ccGetKillRing(), editor.ccGetKillRing())
  assert.equal(restored.editor.ccUndoDepth(), editor.ccUndoDepth())
  assert.deepEqual([...restored.editor.ccGetPastes().entries()], [...editor.ccGetPastes().entries()])

  // The restored undo stack still works on the restored instance.
  const beforeUndo = restored.editor.getText()
  restored.editor.handleInput("\x1f")
  assert.notEqual(restored.editor.getText(), beforeUndo)
})

test("replaceDraftText is one undoable edit that preserves the old paste registry in undo", () => {
  const { editor } = makeEditor()
  editor.handleInput(`\x1b[200~${LARGE_PASTE}\x1b[201~`)
  assert.match(editor.getText(), /^\[paste #1/)

  const changed = editor.replaceDraftText("replacement")
  assert.equal(changed, true)
  assert.equal(editor.getText(), "replacement")
  assert.equal(editor.ccGetPastes().size, 0)

  editor.handleInput("\x1f") // undo
  assert.match(editor.getText(), /^\[paste #1/)
  assert.equal(editor.getExpandedText(), LARGE_PASTE)
  assert.equal(editor.ccGetPastes().size, 1)

  // Replacing with identical text is not an edit.
  editor.setText("same")
  const depth = editor.ccUndoDepth()
  assert.equal(editor.replaceDraftText("same"), false)
  assert.equal(editor.ccUndoDepth(), depth)
})

test("replaceDraftText accepts a cursor and normalizes line endings", () => {
  const { editor } = makeEditor()
  editor.replaceDraftText("one\r\ntwo\rthree", { cursor: { line: 1, col: 2 } })
  assert.equal(editor.getText(), "one\ntwo\nthree")
  assert.deepEqual(editor.getCursor(), { line: 1, col: 2 })
})

test("restoring a snapshot during history browsing keeps the browsing state and draft", () => {
  const { editor } = makeEditor()
  editor.addToHistory("older")
  editor.addToHistory("newest")
  editor.setText("my draft")
  editor.ccSetCursor(0, 3)
  renderAt(editor, 80)
  editor.handleInput("\x10") // browse newest
  editor.handleInput("\x10") // browse older
  assert.equal(editor.ccIsBrowsingHistory(), true)
  assert.equal(editor.getText(), "older")
  const browsing = editor.captureDraft()
  assert.equal(browsing.historyIndex, 1)
  assert.equal(browsing.historyDraft?.lines.join("\n"), "my draft")
  assert.equal(browsing.historyDraft?.cursorCol, 3)

  const restored = makeEditor()
  restored.editor.restoreDraft(browsing)
  assert.equal(restored.editor.ccIsBrowsingHistory(), true)
  assert.equal(restored.editor.getText(), "older")
  assert.deepEqual(restored.editor.ccGetHistory(), ["newest", "older"])

  restored.editor.handleInput("\x0e") // down -> newest
  assert.equal(restored.editor.getText(), "newest")
  restored.editor.handleInput("\x0e") // down -> draft
  assert.equal(restored.editor.getText(), "my draft")
  assert.deepEqual(restored.editor.getCursor(), { line: 0, col: 3 })
  assert.equal(restored.editor.ccIsBrowsingHistory(), false)
})

test("external-editor round trip: unchanged text keeps cursor/undo, changed text is undoable", () => {
  const { editor } = makeEditor()
  editor.handleInput(`\x1b[200~${LARGE_PASTE}\x1b[201~`)
  editor.handleInput(" tail")
  editor.ccSetCursor(0, 3)
  const request = editor.captureDraftForExternalEditor()
  assert.equal(request.text, `${LARGE_PASTE} tail`)
  assert.deepEqual(request.cursor, { line: 0, col: 3 })
  assert.match(request.snapshot.text, /^\[paste #1/)

  const depth = editor.ccUndoDepth()
  editor.applyExternalEdit(request.text, request.snapshot)
  assert.equal(editor.getText(), request.snapshot.text)
  assert.equal(editor.ccUndoDepth(), depth, "unchanged external text is not a new undo unit")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 3 })
  assert.equal(editor.getExpandedText(), `${LARGE_PASTE} tail`)

  editor.applyExternalEdit("edited text", request.snapshot)
  assert.equal(editor.getText(), "edited text")
  editor.handleInput("\x1f") // undo the external edit
  assert.match(editor.getText(), /^\[paste #1/)
})

test("restoreDraft notifies onChange unless notify is false", () => {
  const { editor, changes } = makeEditor()
  editor.setText("draft")
  const snapshot = editor.captureDraft()
  editor.setText("")
  changes.length = 0

  editor.restoreDraft(snapshot)
  assert.equal(editor.getText(), "draft")
  assert.equal(changes.at(-1), "draft")

  editor.setText("")
  changes.length = 0
  editor.restoreDraft(snapshot, { notify: false })
  assert.equal(editor.getText(), "draft")
  assert.equal(changes.length, 0)
})

test("snapshot validation rejects malformed drafts and accepts serialized ones", () => {
  const { editor } = makeEditor()
  editor.setText("hello")
  const snapshot = editor.captureDraft()

  assert.equal(mod.isCcDraftSnapshot(snapshot), true)
  assert.equal(mod.isCcDraftSnapshot({ ...snapshot, version: 2 }), false)
  assert.equal(mod.isCcDraftSnapshot({ ...snapshot, lines: "nope" }), false)
  assert.equal(mod.isCcDraftSnapshot(null), false)

  const serialized = mod.serializeCcDraftSnapshot(snapshot)
  const roundTripped = mod.deserializeCcDraftSnapshot(serialized)
  assert.equal(roundTripped.text, "hello")
  assert.throws(() => mod.parseCcDraftSnapshot({ version: 1 }), /Invalid CcDraftSnapshot/)
})

test("one editor state: snapshots drive the same instance and its undo stack", () => {
  const { editor } = makeEditor()
  editor.setText("abc")
  editor.ccSetCursor(0, 1)
  const snapshot = editor.captureDraft()
  editor.handleInput("\x1bd") // kill "bc"
  assert.equal(editor.getText(), "a")
  assert.equal(editor.ccUndoDepth(), snapshot.undoStack.length + 1)

  // Restoring reuses the Pi editor state and its undo stack (no external copy).
  editor.restoreDraft(snapshot)
  assert.equal(editor.getText(), "abc")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 1 })
  editor.handleInput("\x1f")
  assert.notEqual(editor.getText(), "abc")
})

const snapshotContract: CcDraftSnapshot = (() => {
  const { editor } = makeEditor()
  editor.setText("x")
  return editor.captureDraft()
})()
assert.equal(snapshotContract.text, "x")