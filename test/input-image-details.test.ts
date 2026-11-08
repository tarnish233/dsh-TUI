/**
 * `imageDetails` read-only viewer context and the locked action ids.
 *
 * The frontend ImageDetailsDialog resolves raw bytes through the shared CcKeymap
 * in the `imageDetails` context. These tests pin the contract: context fallback
 * chain, bindings, close precedence, global interrupt priority and the platform
 * specific Alt+V clipboard alias. No terminal, clipboard or model is involved.
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
import type { CcActionEvent, CcContext } from "../src/input/index.ts"

const mod = await loadInputModule()

function actionId(keymap: InstanceType<typeof mod.CcKeymap>, data: string, context: CcContext): string | undefined {
  const resolution = keymap.resolve(data, context)
  return resolution.kind === "action" ? resolution.action.id : undefined
}

test("imageDetails context and fallback chain match the contract", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  assert.ok(mod.CC_CONTEXTS.includes("imageDetails"))
  assert.deepEqual(keymap.getFallbackChain("imageDetails"), ["imageDetails", "list", "dialog", "global"])
  assert.ok(!keymap.getFallbackChain("imageDetails").includes("editor"), "no editor fallback in a read-only viewer")
})

test("locked image viewer actions and their default bindings", () => {
  const { CC_ACTIONS_BY_ID, getDefaultBindings } = mod
  const expectations: Array<[string, string[], CcContext[]]> = [
    ["app.images.details", ["ctrl+x ctrl+i"], ["global"]],
    ["image.details.previous-image", ["[", "alt+left"], ["imageDetails"]],
    ["image.details.next-image", ["]", "alt+right"], ["imageDetails"]],
    ["image.details.close", ["escape"], ["imageDetails"]],
    ["image.details.toggle-preview", ["p"], ["imageDetails"]],
  ]
  for (const [id, bindings, contexts] of expectations) {
    const action = CC_ACTIONS_BY_ID.get(id)
    assert.ok(action, `${id} is registered`)
    assert.deepEqual([...getDefaultBindings(id)], bindings, `${id} default bindings`)
    assert.deepEqual([...action.contexts], contexts, `${id} contexts`)
    assert.equal(action.implementor, "app")
  }
  assert.equal(CC_ACTIONS_BY_ID.get("app.images.details")!.family, "app")
  assert.equal(CC_ACTIONS_BY_ID.get("image.details.close")!.family, "dialog")
})

test("viewer keys resolve in imageDetails and never in the editor", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  assert.equal(actionId(keymap, "[", "imageDetails"), "image.details.previous-image")
  assert.equal(actionId(keymap, "\x1b[1;3D", "imageDetails"), "image.details.previous-image") // Alt+Left
  assert.equal(actionId(keymap, "]", "imageDetails"), "image.details.next-image")
  assert.equal(actionId(keymap, "\x1b[1;3C", "imageDetails"), "image.details.next-image") // Alt+Right
  assert.equal(actionId(keymap, "\x1b", "imageDetails"), "image.details.close")

  // In the editor the same bytes keep their CC meaning.
  assert.equal(actionId(keymap, "[", "editor"), undefined, "`[` stays plain text")
  assert.equal(actionId(keymap, "]", "editor"), undefined, "`]` stays plain text")
  assert.equal(actionId(keymap, "\x1b[1;3D", "editor"), "editor.move.word-left")
  assert.equal(actionId(keymap, "\x1b[1;3C", "editor"), "editor.move.word-right")
})

test("viewer-only preview toggle: `p` is registered in imageDetails and nowhere else", () => {
  const { CC_ACTIONS_BY_ID, createCcKeymap } = mod
  const definition = CC_ACTIONS_BY_ID.get("image.details.toggle-preview")
  assert.ok(definition, "image.details.toggle-preview is registered")
  assert.equal(definition.family, "dialog")
  assert.deepEqual([...definition.contexts], ["imageDetails"])
  assert.deepEqual([...definition.defaultBindings], ["p"])
  assert.equal(definition.implementor, "app")
  assert.equal(definition.status, "tui-extension")

  const keymap = createCcKeymap({ platform: "posix" })
  // Action only in the read-only image viewer.
  assert.equal(actionId(keymap, "p", "imageDetails"), "image.details.toggle-preview")
  // Plain text in the prompt and in modal text fields / other modals.
  for (const context of [
    "editor",
    "autocomplete",
    "historySearch",
    "modalSearch",
    "settingsList",
    "queueList",
    "list",
    "toolDetails",
    "subagentList",
    "global",
  ] as const) {
    assert.equal(actionId(keymap, "p", context), undefined, `${context}: p stays text/inert`)
  }
  // One grouped Settings row, no new conflict, no error diagnostics.
  assert.ok(keymap.getHelp().some((row) => row.action === "image.details.toggle-preview" && row.keysLabel === "P"))
  assert.deepEqual(
    keymap.getConflicts().filter((diagnostic) => diagnostic.context === "imageDetails"),
    [],
  )
  assert.equal(keymap.getDiagnostics().some((diagnostic) => diagnostic.severity === "error"), false)

  // Remappable and disableable through the same override map; disabled `p` is
  // inert rather than falling through to a global action.
  const remapped = createCcKeymap({ platform: "posix", bindings: { "image.details.toggle-preview": "i" } })
  assert.equal(actionId(remapped, "i", "imageDetails"), "image.details.toggle-preview")
  assert.equal(actionId(remapped, "p", "imageDetails"), undefined)
  assert.equal(actionId(remapped, "i", "editor"), undefined, "i stays text in the prompt")
  const disabled = createCcKeymap({ platform: "posix", bindings: { "image.details.toggle-preview": null } })
  assert.deepEqual(disabled.getBindings("image.details.toggle-preview"), [])
  assert.equal(actionId(disabled, "p", "imageDetails"), undefined)
})

test("a viewer-hosted editor emits the preview toggle once without touching its draft", () => {
  const tui = createFakeTui()
  const editor = new mod.CcEditor(asTui(tui), testEditorTheme, { context: "imageDetails" })
  const events: CcActionEvent[] = []
  editor.onAction = (event: CcActionEvent) => {
    events.push(event)
    return true
  }
  renderAt(editor, 80)

  editor.handleInput("p")
  assert.deepEqual(events.map((event) => event.id), ["image.details.toggle-preview"])
  assert.equal(events[0]?.context, "imageDetails")
  assert.equal(editor.getText(), "", "the read-only viewer never gains an editable draft")

  editor.handleInput("p")
  assert.deepEqual(
    events.map((event) => event.id),
    ["image.details.toggle-preview", "image.details.toggle-preview"],
    "a repeated press is a plain mode toggle, not a chord",
  )
})

test("Esc closes the viewer instead of falling through to list.cancel", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  assert.equal(actionId(keymap, "\x1b", "list"), "list.cancel")
  assert.equal(actionId(keymap, "\x1b", "imageDetails"), "image.details.close")
  const conflicts = keymap.getConflicts().filter((diagnostic) => diagnostic.context === "imageDetails")
  assert.deepEqual(conflicts, [], "no binding conflict is reported for the viewer context")
})

test("app.interrupt keeps priority over viewer keys and pending chords", () => {
  const keymap = mod.createCcKeymap({ platform: "posix", bindings: { "app.interrupt": "ctrl+c" } })
  // A pending chord is not allowed to swallow the interrupt key.
  keymap.resolve("[", "imageDetails")
  assert.equal(actionId(keymap, "\x03", "imageDetails"), "app.interrupt")

  // Inside the viewer Ctrl+C is the app interrupt, while a plain list still
  // resolves it to list.cancel (no priority context there).
  assert.equal(actionId(keymap, "\x03", "imageDetails"), "app.interrupt")
  assert.equal(actionId(keymap, "\x03", "list"), "list.cancel")
  const remapped = mod.createCcKeymap({ platform: "posix", bindings: { "app.interrupt": "ctrl+g" } })
  remapped.resolve("]", "imageDetails")
  assert.equal(actionId(remapped, "\x07", "imageDetails"), "app.interrupt")
  assert.notEqual(actionId(remapped, "\x03", "imageDetails"), "app.interrupt")
})

test("chord Ctrl+X Ctrl+I opens the image details viewer", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  const first = keymap.resolve("\x18", "editor") // Ctrl+X
  assert.equal(first.kind, "pending")
  const second = keymap.resolve("\x09", "editor") // Ctrl+I
  assert.equal(second.kind, "action")
  if (second.kind !== "action") throw new Error("expected action")
  assert.equal(second.action.id, "app.images.details")

  // Ctrl+I alone is still completion, so the viewer never steals it.
  assert.equal(actionId(keymap, "\x09", "editor"), "editor.complete")
})

test("plain printable input is inert in the viewer context of a CcEditor", () => {
  const tui = createFakeTui()
  const editor = new mod.CcEditor(asTui(tui), testEditorTheme, { context: "imageDetails" })
  const events: CcActionEvent[] = []
  editor.onAction = (event: CcActionEvent) => {
    events.push(event)
    return true
  }
  renderAt(editor, 80)
  editor.setText("")
  renderAt(editor, 80)

  typeText(editor, "hello")
  editor.handleInput("\x7f")
  editor.handleInput("\x01")
  assert.equal(editor.getText(), "", "printable and editing bytes never reach a read-only viewer")
  assert.equal(events.length, 0)

  editor.handleInput("\x1b")
  editor.handleInput("[")
  editor.handleInput("]")
  assert.deepEqual(
    events.map((event) => event.id),
    ["image.details.close", "image.details.previous-image", "image.details.next-image"],
  )

  // Bracketed paste is discarded in the read-only context.
  editor.handleInput("\x1b[200~pasted text\x1b[201~")
  editor.flushInputBuffer?.()
  assert.equal(editor.getText(), "")
})

test("app.clipboard.pasteImage gains Alt+V only on Windows and WSL", () => {
  const posix = mod.createCcKeymap({ platform: "posix" })
  assert.deepEqual(posix.getBindings("app.clipboard.pasteImage"), ["ctrl+v"])
  assert.equal(actionId(posix, "\x1bv", "editor"), undefined, "Alt+V stays free on POSIX")

  for (const platform of ["windows", "wsl"] as const) {
    const keymap = mod.createCcKeymap({ platform })
    assert.deepEqual(keymap.getBindings("app.clipboard.pasteImage"), ["ctrl+v", "alt+v"])
    assert.equal(actionId(keymap, "\x16", "editor"), "app.clipboard.pasteImage", "Ctrl+V is unchanged")
    assert.equal(actionId(keymap, "\x1bv", "editor"), "app.clipboard.pasteImage")
  }

  // A user override replaces both platform and default bindings.
  const overridden = mod.createCcKeymap({ platform: "windows", bindings: { "app.clipboard.pasteImage": "ctrl+alt+v" } })
  assert.deepEqual(overridden.getBindings("app.clipboard.pasteImage"), ["ctrl+alt+v"])
  assert.equal(actionId(overridden, "\x1bv", "editor"), undefined)
})

test("platform detection covers Windows, WSL and POSIX", () => {
  assert.equal(mod.detectKeybindingPlatform({}, "darwin"), "posix")
  assert.equal(mod.detectKeybindingPlatform({}, "linux"), "posix")
  assert.equal(mod.detectKeybindingPlatform({}, "win32"), "windows")
  assert.equal(mod.detectKeybindingPlatform({ WSL_DISTRO_NAME: "Ubuntu" }, "linux"), "wsl")
  assert.equal(mod.detectKeybindingPlatform({ WSL_INTEROP: "/run/WSL/1_interop" }, "linux"), "wsl")
})