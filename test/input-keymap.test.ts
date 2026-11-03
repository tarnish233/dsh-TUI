import test from "node:test"
import assert from "node:assert/strict"

import { loadInputModule } from "../src/input/testing/harness.ts"
import type { CcActionDefinition, CcContext, CcKeyResolution } from "../src/input/index.ts"

// The input module and tests use the same vendored Pi TUI package instance.
// The seam is installed by the input module before any editor is constructed.
const mod = await loadInputModule()
const { createCcKeymap, formatBinding, isValidKeyId, parseBindingSpec, CC_ACTIONS } = mod

function actionId(resolution: CcKeyResolution): string | undefined {
  return resolution.kind === "action" ? resolution.action.id : undefined
}

test("keymap resolves editor actions with CC defaults", () => {
  const keymap = createCcKeymap()
  assert.equal(actionId(keymap.resolve("\x17", "editor")), "editor.kill.whitespace-backward")
  assert.equal(actionId(keymap.resolve("\x15", "editor")), "editor.kill.line-start")
  assert.equal(actionId(keymap.resolve("\x0b", "editor")), "editor.kill.line-end")
  assert.equal(actionId(keymap.resolve("\x19", "editor")), "editor.yank")
  assert.equal(actionId(keymap.resolve("\x1by", "editor")), "editor.yank-pop")
  assert.equal(actionId(keymap.resolve("\x1f", "editor")), "editor.undo")
  assert.equal(actionId(keymap.resolve("\x01", "editor")), "editor.move.line-start")
  assert.equal(actionId(keymap.resolve("\x05", "editor")), "editor.move.line-end")
  assert.equal(actionId(keymap.resolve("\x02", "editor")), "editor.move.char-left")
  assert.equal(actionId(keymap.resolve("\x06", "editor")), "editor.move.char-right")
  assert.equal(actionId(keymap.resolve("\x1b[1;3D", "editor")), "editor.move.word-left")
  assert.equal(actionId(keymap.resolve("\x1b[1;3C", "editor")), "editor.move.word-right")
  assert.equal(actionId(keymap.resolve("\x1bb", "editor")), "editor.move.word-left")
  assert.equal(actionId(keymap.resolve("\x1bf", "editor")), "editor.move.word-right")
  assert.equal(actionId(keymap.resolve("\x1b[1;5D", "editor")), "editor.move.word-left")
  assert.equal(actionId(keymap.resolve("\x1b[1;5C", "editor")), "editor.move.word-right")
})

test("bare LF resolves to newline (registry order), CR submits", () => {
  const keymap = createCcKeymap()
  assert.equal(actionId(keymap.resolve("\n", "editor")), "editor.newline")
  assert.equal(actionId(keymap.resolve("\r", "editor")), "editor.submit")
  assert.equal(actionId(keymap.resolve("\x1b[13;2u", "editor")), "editor.newline")
  assert.equal(actionId(keymap.resolve("\x1b\r", "editor")), "editor.newline")
})

test("modifier aliases match legacy bytes and CSI-u sequences", () => {
  const keymap = createCcKeymap()
  // Ctrl+W: legacy ^W, xterm modifyOtherKeys, Kitty CSI-u.
  for (const data of ["\x17", "\x1b[27;5;119~", "\x1b[119;5u"]) {
    assert.equal(actionId(keymap.resolve(data, "editor")), "editor.kill.whitespace-backward", data)
  }
  // CC distinguishes Ctrl+W (whitespace) from Ctrl/Alt+Backspace (ordinary word).
  assert.equal(actionId(keymap.resolve("\x1b[127;5u", "editor")), "editor.kill.word-backward")
  assert.equal(actionId(keymap.resolve("\x1b[127;3u", "editor")), "editor.kill.word-backward")
  // Ctrl+_ / Ctrl+- / Ctrl+Shift+- are byte-equivalent (^_).
  for (const data of ["\x1f"]) {
    assert.equal(actionId(keymap.resolve(data, "editor")), "editor.undo")
  }
  // Meta aliases for word motion.
  assert.equal(actionId(keymap.resolve("\x1b[1;3D", "editor")), "editor.move.word-left")
  assert.equal(actionId(keymap.resolve("\x1b[1;5D", "editor")), "editor.move.word-left")
  // Delete / Ctrl+D share forward delete (context handled in CcEditor).
  assert.equal(actionId(keymap.resolve("\x1b[3~", "editor")), "editor.delete.char-forward")
  assert.equal(actionId(keymap.resolve("\x04", "editor")), "editor.delete.char-forward")
})

test("global app actions are a fallback for local contexts; local bindings win", () => {
  const keymap = createCcKeymap()
  assert.equal(actionId(keymap.resolve("\x14", "editor")), "app.todo")
  assert.equal(actionId(keymap.resolve("\x0f", "editor")), "app.tools.expand")
  assert.equal(actionId(keymap.resolve("\x16", "editor")), "app.clipboard.pasteImage")
  assert.equal(actionId(keymap.resolve("\x13", "editor")), "app.stash")
  assert.equal(actionId(keymap.resolve("\x07", "editor")), "app.editor.external")
  assert.equal(actionId(keymap.resolve("\x0c", "editor")), "app.redraw")
  assert.equal(actionId(keymap.resolve("\x12", "editor")), "app.history.search")
  assert.equal(actionId(keymap.resolve("\x1bp", "editor")), "app.model.select")
  assert.equal(actionId(keymap.resolve("\x1b[Z", "editor")), "app.mode.cycle")
  // Ctrl+C is only an app action, so the editor context falls through to global.
  assert.equal(actionId(keymap.resolve("\x03", "editor")), "app.interrupt")
})

test("context fallback chains: completion/search keep editor editing beneath them", () => {
  const keymap = createCcKeymap()
  assert.deepEqual(keymap.getFallbackChain("autocomplete"), ["autocomplete", "editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("historySearch"), ["historySearch", "editor", "global"])
  // Own actions win...
  assert.equal(actionId(keymap.resolve("\x0e", "autocomplete")), "autocomplete.next")
  assert.equal(actionId(keymap.resolve("\x12", "historySearch")), "historySearch.next")
  // ...then editor editing still works while completion/search is open.
  assert.equal(actionId(keymap.resolve("\x17", "autocomplete")), "editor.kill.whitespace-backward")
  assert.equal(actionId(keymap.resolve("\x01", "autocomplete")), "editor.move.line-start")
  assert.equal(actionId(keymap.resolve("\x17", "historySearch")), "editor.kill.whitespace-backward")
  assert.equal(actionId(keymap.resolve("\x02", "historySearch")), "editor.move.char-left")
})

test("printable text is never list navigation in the editor context", () => {
  const keymap = createCcKeymap()
  for (const data of ["j", "k", "1", "9"]) {
    assert.equal(keymap.resolve(data, "editor").kind, "none", `editor ${data}`)
    assert.equal(keymap.resolve(data, "list").kind, "action", `list ${data}`)
  }
  assert.equal(actionId(keymap.resolve("j", "list")), "list.next")
  assert.equal(actionId(keymap.resolve("k", "list")), "list.previous")
  assert.equal(actionId(keymap.resolve("1", "list")), "list.select-digit")
  assert.equal(actionId(keymap.resolve("\x10", "list")), "list.previous")
  assert.equal(actionId(keymap.resolve("\x0e", "list")), "list.next")
  assert.equal(actionId(keymap.resolve("\x1b", "dialog")), "dialog.cancel")
  assert.equal(actionId(keymap.resolve("\x12", "historySearch")), "historySearch.next")
})

test("chord: prefix, completion, cancel and timeout (CC default 3000ms)", () => {
  const keymap = createCcKeymap()
  assert.equal(keymap.getChordTimeoutMs(), 3000)
  const pending = keymap.resolve("\x18", "editor", 1_000)
  assert.equal(pending.kind, "pending")
  assert.deepEqual(keymap.getPendingChord(), ["ctrl+x"])
  const completed = keymap.resolve("\x05", "editor", 1_010)
  assert.equal(completed.kind, "action")
  assert.equal(actionId(completed), "app.editor.external")
  assert.deepEqual(completed.kind === "action" ? completed.keys : undefined, ["ctrl+x", "ctrl+e"])

  // Mismatch cancels the chord and asks the caller to redispatch the key.
  assert.equal(keymap.resolve("\x18", "editor", 1_000).kind, "pending")
  const mismatch = keymap.resolve("b", "editor", 1_010)
  assert.equal(mismatch.kind, "cancelled-chord")
  assert.equal(mismatch.kind === "cancelled-chord" ? mismatch.reason : "", "mismatch")
  assert.equal(mismatch.kind === "cancelled-chord" ? mismatch.passthrough : "", "b")
  assert.equal(keymap.isPendingChord(), false)

  // Timeout between chord keys.
  assert.equal(keymap.resolve("\x18", "editor", 2_000).kind, "pending")
  const timeout = keymap.resolve("\x05", "editor", 5_601)
  assert.equal(timeout.kind, "cancelled-chord")
  assert.equal(timeout.kind === "cancelled-chord" ? timeout.reason : "", "timeout")
  assert.deepEqual(timeout.kind === "cancelled-chord" ? timeout.prefix : undefined, ["ctrl+x"])

  // Explicit expiry used by the editor timer.
  assert.equal(keymap.resolve("\x18", "editor", 5_000).kind, "pending")
  assert.deepEqual(keymap.expireChord(5_100), null)
  assert.deepEqual(keymap.expireChord(8_100), ["ctrl+x"])
  assert.equal(keymap.isPendingChord(), false)

  // The editor timer may fire at the exact deadline, not a millisecond later.
  assert.equal(keymap.resolve("\x18", "editor", 5_000).kind, "pending")
  assert.equal(keymap.expireChord(7_999), null)
  assert.deepEqual(keymap.expireChord(8_000), ["ctrl+x"])
  assert.equal(keymap.resolve("\x18", "editor", 5_000).kind, "pending")
  const exact = keymap.resolve("\x05", "editor", 8_000)
  assert.equal(exact.kind, "cancelled-chord")
  assert.equal(exact.kind === "cancelled-chord" ? exact.reason : "", "timeout")
})

test("disabled and remapped actions are explicit, not Pi fallbacks", () => {
  const disabled = createCcKeymap({ bindings: { "editor.kill.whitespace-backward": null } })
  assert.deepEqual(disabled.getBindings("editor.kill.whitespace-backward"), [])
  assert.equal(disabled.resolve("\x17", "editor").kind, "none")

  const remapped = createCcKeymap({
    bindings: { "editor.kill.whitespace-backward": "alt+w" },
  })
  assert.deepEqual(remapped.getBindings("editor.kill.whitespace-backward"), ["alt+w"])
  assert.equal(remapped.resolve("\x17", "editor").kind, "none")
  assert.equal(actionId(remapped.resolve("\x1bw", "editor")), "editor.kill.whitespace-backward")
})

test("configuration diagnostics: unknown action, invalid key, conflicts", () => {
  const unknown = createCcKeymap({ bindings: { "editor.not.a.real.action": "ctrl+q" } })
  assert.ok(unknown.getDiagnostics().some((d) => d.code === "unknown-action" && d.severity === "error"))

  const invalid = createCcKeymap({
    bindings: { "editor.kill.whitespace-backward": "ctrl+notakey" },
  })
  const invalidDiagnostics = invalid.getDiagnostics()
  assert.ok(invalidDiagnostics.some((d) => d.code === "invalid-binding" && d.severity === "error"))
  // An invalid override disables the action instead of silently using defaults.
  assert.deepEqual(invalid.getBindings("editor.kill.whitespace-backward"), [])
  assert.equal(invalid.resolve("\x17", "editor").kind, "none")

  const conflict = createCcKeymap({
    bindings: {
      "list.previous": "j",
      "list.next": "j",
    },
  })
  assert.ok(conflict.getConflicts().some((d) => d.code === "conflict" && d.context === "list"))

  const byteAmbiguous = createCcKeymap({
    bindings: { "editor.move.line-start": "ctrl+i" },
  })
  assert.ok(
    byteAmbiguous
      .getDiagnostics()
      .some((d) => d.code === "byte-ambiguous" && d.keys?.includes("tab")),
  )
})

test("chord prefix shadows a single-key binding in the same context", () => {
  const definitions: CcActionDefinition[] = [
    {
      id: "test.simple",
      family: "editing",
      contexts: ["editor"],
      defaultBindings: ["ctrl+x"],
      implementor: "editor",
      status: "unverified",
      description: "simple",
    },
    {
      id: "test.chord",
      family: "editing",
      contexts: ["editor"],
      defaultBindings: ["ctrl+x ctrl+e"],
      implementor: "editor",
      status: "unverified",
      description: "chord",
    },
  ]
  const keymap = createCcKeymap({ definitions })
  assert.ok(keymap.getConflicts().some((d) => d.code === "chord-shadow" && d.action === "test.simple"))
  // Chord prefix wins immediately; the single key is only reachable after the
  // chord is cancelled, which the diagnostics warn about.
  assert.equal(keymap.resolve("\x18", "editor", 0).kind, "pending")
})

test("hot reload replaces bindings and clears pending chords", () => {
  const keymap = createCcKeymap()
  keymap.resolve("\x18", "editor", 0)
  assert.equal(keymap.isPendingChord(), true)
  keymap.setBindings({ "editor.kill.whitespace-backward": "ctrl+q" })
  assert.equal(keymap.isPendingChord(), false)
  assert.deepEqual(keymap.getBindings("editor.kill.whitespace-backward"), ["ctrl+q"])
  assert.equal(actionId(keymap.resolve("\x11", "editor")), "editor.kill.whitespace-backward")
})

test("binding spec helpers", () => {
  assert.deepEqual(parseBindingSpec("ctrl+x ctrl+e"), ["ctrl+x", "ctrl+e"])
  assert.deepEqual(parseBindingSpec("  Alt+Left "), ["alt+left"])
  assert.equal(parseBindingSpec("ctrl+"), undefined)
  assert.equal(parseBindingSpec("ctrl+notakey"), undefined)
  assert.equal(parseBindingSpec(""), undefined)
  assert.equal(isValidKeyId("pageUp"), true)
  assert.equal(isValidKeyId("esc"), true)
  assert.equal(isValidKeyId("ctrl+shift+up"), true)
  assert.equal(isValidKeyId("ctrl++"), true, "ctrl++ is the Ctrl+'+' key")
  assert.equal(isValidKeyId("hyper+a"), false)
  assert.equal(formatBinding(["ctrl+x", "ctrl+e"]), "Ctrl+X Ctrl+E")
})

test("CC_ACTIONS registry covers the required families with honest statuses", () => {
  const byId = new Map(CC_ACTIONS.map((action) => [action.id, action]))
  const required = [
    "editor.move.line-up",
    "editor.move.line-down",
    "editor.move.word-left",
    "editor.move.word-right",
    "editor.kill.whitespace-backward",
    "editor.kill.word-backward",
    "editor.kill.line-start",
    "editor.kill.line-end",
    "editor.yank",
    "editor.yank-pop",
    "editor.undo",
    "editor.newline",
    "editor.submit",
    "editor.complete",
    "app.interrupt",
    "app.history.search",
    "app.stash",
    "app.editor.external",
    "app.tools.expand",
    "app.todo",
    "app.model.select",
    "app.mode.cycle",
    "app.clipboard.pasteImage",
    "list.previous",
    "list.next",
    "dialog.cancel",
    "historySearch.accept",
  ]
  for (const id of required) assert.ok(byId.has(id), `missing ${id}`)
  assert.equal(byId.get("app.todo")?.status, "cc-app-override")
  assert.equal(byId.get("app.thinking.toggle")?.defaultBindings.length, 0)
  const contexts: CcContext[] = ["editor", "autocomplete", "list", "dialog", "historySearch", "global"]
  for (const context of contexts) {
    assert.ok(mod.CC_CONTEXTS.includes(context))
  }
})