/**
 * Tool-details keyboard entry and modal keymap, offline only.
 *
 * No model, backend, DSH process, terminal or API call is involved: every test
 * feeds real terminal bytes into the shared `CcKeymap` / one Pi editor state
 * and inspects the resulting action events and draft state.
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
import type { CcActionEvent, CcContext, CcEditorOptions, CcKeyResolution } from "../src/input/index.ts"

const mod = await loadInputModule()
type TestEditor = InstanceType<typeof mod.CcEditor>

function makeEditor(options: CcEditorOptions = {}) {
  const tui = createFakeTui()
  const editor = new mod.CcEditor(asTui(tui), testEditorTheme, options)
  const events: CcActionEvent[] = []
  editor.onAction = (event) => {
    events.push(event)
  }
  renderAt(editor, 80)
  return { editor, tui, events }
}

function press(editor: TestEditor, ...keys: string[]): void {
  for (const key of keys) editor.handleInput(key)
  editor.flushInputBuffer()
}

function actionId(resolution: CcKeyResolution): string | undefined {
  return resolution.kind === "action" ? resolution.action.id : undefined
}

function actionIds(events: readonly CcActionEvent[]): string[] {
  return events.map((event) => event.id)
}

function resolveId(
  keymap: InstanceType<typeof mod.CcKeymap>,
  data: string,
  context: CcContext,
  now?: number,
) {
  return actionId(now === undefined ? keymap.resolve(data, context) : keymap.resolve(data, context, now))
}

// --- registration and contract -----------------------------------------

test("toolDetails context, fallback chain and action definitions match the contract", () => {
  const { CC_ACTIONS_BY_ID, CC_CONTEXTS, createCcKeymap } = mod
  assert.ok(CC_CONTEXTS.includes("toolDetails"))

  const keymap = createCcKeymap()
  assert.deepEqual(keymap.getFallbackChain("toolDetails"), ["toolDetails", "list", "dialog", "global"])
  // No editor fallback: editor movement/kill/undo must not reach a read-only
  // details modal.
  assert.equal(keymap.getFallbackChain("toolDetails").includes("editor"), false)

  // Existing chains are untouched.
  assert.deepEqual(keymap.getFallbackChain("editor"), ["editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("autocomplete"), ["autocomplete", "editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("historySearch"), ["historySearch", "editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("dialog"), ["dialog", "editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("list"), ["list", "global"])
  assert.deepEqual(keymap.getFallbackChain("modelPickerList"), ["modelPickerList", "list", "editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("modelPickerSearch"), ["modelPickerSearch", "editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("global"), ["global"])

  const details = CC_ACTIONS_BY_ID.get("app.tools.details")
  assert.ok(details)
  assert.equal(details.family, "app")
  assert.deepEqual(details.contexts, ["global"])
  assert.deepEqual(details.defaultBindings, ["ctrl+x ctrl+o"])
  assert.equal(details.implementor, "app")
  assert.notEqual(details.status, "cc-match")
  assert.notEqual(details.status, "cc-app-override")
  assert.equal(details.status, "tui-extension", "marked as this TUI's own capability, not a verified CC default")
  assert.match(details.note ?? "", /not a verified CC default/)
  assert.match(details.note ?? "", /ctrl\+o/i)
  assert.equal(details.description, "Open tools inspector (initial latest)")

  const next = CC_ACTIONS_BY_ID.get("tool.details.next-section")
  const previous = CC_ACTIONS_BY_ID.get("tool.details.previous-section")
  const previousTool = CC_ACTIONS_BY_ID.get("tool.details.previous-tool")
  const nextTool = CC_ACTIONS_BY_ID.get("tool.details.next-tool")
  const copy = CC_ACTIONS_BY_ID.get("tool.details.copy")
  assert.ok(next)
  assert.ok(previous)
  assert.ok(previousTool)
  assert.ok(nextTool)
  assert.ok(copy)
  for (const definition of [next, previous, previousTool, nextTool, copy]) {
    assert.deepEqual(definition.contexts, ["toolDetails"])
    assert.equal(definition.implementor, "app")
    assert.equal(definition.family, "dialog")
    assert.equal(definition.status, "tui-extension")
  }
  assert.deepEqual(next.defaultBindings, ["tab", "right"])
  assert.deepEqual(previous.defaultBindings, ["shift+tab", "left"])
  assert.deepEqual(previousTool.defaultBindings, ["[", "alt+left"])
  assert.deepEqual(nextTool.defaultBindings, ["]", "alt+right"])
  assert.deepEqual(copy.defaultBindings, ["c"])

  // The one grouped /settings shortcut list is built from keymap.getActions(),
  // so every new definition is listed without another config layer.
  const listed = keymap.getActions().map((action) => action.id)
  for (const id of [
    "app.tools.details",
    "tool.details.next-section",
    "tool.details.previous-section",
    "tool.details.previous-tool",
    "tool.details.next-tool",
    "tool.details.copy",
  ]) {
    assert.ok(listed.includes(id), `${id} must be listed`)
  }
  const help = keymap.getHelp()
  assert.ok(help.some((row) => row.action === "app.tools.details" && row.keysLabel === "Ctrl+X Ctrl+O"))
  assert.ok(help.some((row) => row.action === "tool.details.next-section" && row.keysLabel === "Tab, Right"))
  assert.ok(help.some((row) => row.action === "tool.details.previous-section" && row.keysLabel === "Shift+Tab, Left"))
  assert.ok(help.some((row) => row.action === "tool.details.previous-tool" && row.keysLabel === "[, Alt+Left"))
  assert.ok(help.some((row) => row.action === "tool.details.next-tool" && row.keysLabel === "], Alt+Right"))
  assert.ok(help.some((row) => row.action === "tool.details.copy" && row.keysLabel === "C"))
  assert.equal(keymap.getDiagnostics().some((diagnostic) => diagnostic.severity === "error"), false)
})

// --- opening details ----------------------------------------------------

test("Ctrl+X Ctrl+O opens tool details; bare Ctrl+O keeps app.tools.expand", () => {
  const keymap = mod.createCcKeymap()

  // Raw keymap: the chord prefix does not fire the simple Ctrl+O binding.
  const pending = keymap.resolve("\x18", "editor", 1_000)
  assert.equal(pending.kind, "pending")
  assert.deepEqual(keymap.getPendingChord(), ["ctrl+x"])
  const completed = keymap.resolve("\x0f", "editor", 1_010)
  assert.equal(completed.kind, "action")
  assert.equal(actionId(completed), "app.tools.details")
  assert.deepEqual(completed.kind === "action" ? completed.keys : undefined, ["ctrl+x", "ctrl+o"])

  // A fresh Ctrl+O alone is still the CC expand/collapse override.
  assert.equal(resolveId(keymap, "\x0f", "editor"), "app.tools.expand")

  // Real editor bytes: one details event, never a spurious expand event.
  const { editor, events } = makeEditor()
  press(editor, "\x18", "\x0f")
  assert.deepEqual(actionIds(events), ["app.tools.details"])
  assert.equal(events[0]?.context, "editor")
  assert.equal(events[0]?.key, "\x0f")
  assert.equal(editor.getKeymap().isPendingChord(), false)

  // Ctrl+X Ctrl+E still opens the external editor.
  const external = makeEditor()
  press(external.editor, "\x18", "\x05")
  assert.deepEqual(actionIds(external.events), ["app.editor.external"])
})

test("opening tool details preserves the draft, cursor, kill ring and undo stack", () => {
  const { editor, events } = makeEditor()
  editor.setText("first line\nsrc/utils/foo.ts")
  editor.ccSetCursor(1, "src/utils/foo.ts".length)
  press(editor, "\x17") // Ctrl+W: kill the whole path (kill ring entry)
  press(editor, "\x19") // Ctrl+Y: yank it back, one undoable edit
  editor.ccSetCursor(0, 3)
  const before = editor.captureDraft()
  const killRing = editor.ccGetKillRing()
  const undoDepth = editor.ccUndoDepth()

  press(editor, "\x18", "\x0f")

  assert.deepEqual(actionIds(events), ["app.tools.details"])
  assert.deepEqual(editor.captureDraft(), before, "opening the modal does not touch editor state")
  assert.equal(editor.getText(), "first line\nsrc/utils/foo.ts")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 3 })
  assert.deepEqual(editor.ccGetKillRing(), killRing)
  assert.equal(editor.ccUndoDepth(), undoDepth)
  assert.equal(editor.isPasting(), false)

  // The preserved undo stack still works after the modal action was emitted.
  press(editor, "\x1f") // undo yank
  assert.equal(editor.getText(), "first line\n")
  press(editor, "\x1f") // undo kill
  assert.equal(editor.getText(), "first line\nsrc/utils/foo.ts")
  assert.deepEqual(actionIds(events), ["app.tools.details"], "undo is editor-local, not an app action")
})

// --- modal keymap -------------------------------------------------------

test("toolDetails resolves real bytes for tool/section switching, copy, list scrolling and close", () => {
  const keymap = mod.createCcKeymap()

  // Tool switching: real ASCII brackets and Alt+Left/Right CSI bytes.
  assert.equal(resolveId(keymap, "[", "toolDetails"), "tool.details.previous-tool")
  assert.equal(resolveId(keymap, "]", "toolDetails"), "tool.details.next-tool")
  assert.equal(resolveId(keymap, "\x1b[1;3D", "toolDetails"), "tool.details.previous-tool")
  assert.equal(resolveId(keymap, "\x1b[1;3C", "toolDetails"), "tool.details.next-tool")

  // Section switching: Tab/Right forward, Shift+Tab/Left backward.
  assert.equal(resolveId(keymap, "\t", "toolDetails"), "tool.details.next-section")
  assert.equal(resolveId(keymap, "\x1b[C", "toolDetails"), "tool.details.next-section")
  assert.equal(resolveId(keymap, "\x1b[Z", "toolDetails"), "tool.details.previous-section")
  assert.equal(resolveId(keymap, "\x1b[D", "toolDetails"), "tool.details.previous-section")

  // Copy is modal-local and cannot steal `c` from the main editor.
  assert.equal(resolveId(keymap, "c", "toolDetails"), "tool.details.copy")
  assert.equal(keymap.resolve("c", "editor").kind, "none")

  // Scrolling reuses the shared list actions in the modal context.
  assert.equal(resolveId(keymap, "\x1b[A", "toolDetails"), "list.previous")
  assert.equal(resolveId(keymap, "\x1b[B", "toolDetails"), "list.next")
  assert.equal(resolveId(keymap, "\x10", "toolDetails"), "list.previous")
  assert.equal(resolveId(keymap, "\x0e", "toolDetails"), "list.next")
  assert.equal(resolveId(keymap, "k", "toolDetails"), "list.previous")
  assert.equal(resolveId(keymap, "j", "toolDetails"), "list.next")
  assert.equal(resolveId(keymap, "\x1b[5~", "toolDetails"), "list.page-up")
  assert.equal(resolveId(keymap, "\x1b[6~", "toolDetails"), "list.page-down")
  assert.equal(resolveId(keymap, "\x1b[H", "toolDetails"), "list.first")
  assert.equal(resolveId(keymap, "\x1b[F", "toolDetails"), "list.last")
  assert.equal(resolveId(keymap, "1", "toolDetails"), "list.select-digit")

  // Esc closes via list.cancel; default Ctrl+C is the same local cancel row.
  assert.equal(resolveId(keymap, "\x1b", "toolDetails"), "list.cancel")
  assert.equal(resolveId(keymap, "\x03", "toolDetails"), "list.cancel")

  // Ctrl+O is the dialog-local native-details row inside the modal chain; the
  // plain root prompt keeps app.tools.expand.
  assert.equal(resolveId(keymap, "\x0f", "toolDetails"), "dialog.details")
  assert.equal(resolveId(keymap, "\x0f", "editor"), "app.tools.expand")
})

test("read-only toolDetails never falls through to editor operations", () => {
  const keymap = mod.createCcKeymap()
  // Movement, word motion, kill/yank and undo are editor-only in this design.
  // Ctrl+W and Ctrl+L are contracted inspector browse actions instead (wrap /
  // tool call list), never editor kill/redraw.
  for (const [data, label] of [
    ["\x01", "Ctrl+A"],
    ["\x05", "Ctrl+E"],
    ["\x02", "Ctrl+B"],
    ["\x15", "Ctrl+U"],
    ["\x0b", "Ctrl+K"],
    ["\x19", "Ctrl+Y"],
    ["\x1by", "Alt+Y"],
    ["\x1f", "Ctrl+_"],
    ["\x7f", "Backspace"],
  ] as const) {
    assert.equal(keymap.resolve(data, "toolDetails").kind, "none", `${label} must not edit the modal`)
  }
  assert.equal(resolveId(keymap, "\x17", "toolDetails"), "tool.details.wrap")
  assert.equal(resolveId(keymap, "\x0c", "toolDetails"), "tool.details.toggle-calls")
  assert.equal(resolveId(keymap, "\x06", "toolDetails"), "modal.search")
  // The prompt keeps the CC meanings of those bytes.
  assert.equal(resolveId(keymap, "\x17", "editor"), "editor.kill.whitespace-backward")
  assert.equal(resolveId(keymap, "\x0c", "editor"), "app.redraw")
  assert.equal(resolveId(keymap, "\x06", "editor"), "editor.move.char-right")
  // Pi treats legacy ESC-b / ESC-f as Alt+Left / Alt+Right reads (readline word
  // aliases). In the read-only modal those become tool navigation, never editor
  // word movement; the modal does not own any editor state.
  assert.equal(resolveId(keymap, "\x1bb", "toolDetails"), "tool.details.previous-tool")
  assert.equal(resolveId(keymap, "\x1bf", "toolDetails"), "tool.details.next-tool")
  // Plain text is inert in the read-only surface (except the copy binding).
  for (const data of ["x", "q", " "]) {
    assert.equal(keymap.resolve(data, "toolDetails").kind, "none", data)
  }
})

test("brackets and Alt+arrows remain editor text/word motion, not inspector navigation", () => {
  const keymap = mod.createCcKeymap()
  assert.equal(keymap.resolve("[", "editor").kind, "none")
  assert.equal(keymap.resolve("]", "editor").kind, "none")
  assert.equal(resolveId(keymap, "\x1b[1;3D", "editor"), "editor.move.word-left")
  assert.equal(resolveId(keymap, "\x1b[1;3C", "editor"), "editor.move.word-right")

  const { editor, events } = makeEditor()
  typeText(editor, "a[b]c")
  assert.equal(editor.getText(), "a[b]c", "ASCII brackets are ordinary text")
  assert.deepEqual(actionIds(events), [], "no inspector action from the editor")

  editor.setText("one two")
  editor.ccSetCursor(0, "one two".length)
  press(editor, "\x1b[1;3D") // Alt+Left: editor word motion
  assert.deepEqual(editor.getCursor(), { line: 0, col: 4 })
  press(editor, "\x1b[1;3C") // Alt+Right: editor word motion
  assert.deepEqual(editor.getCursor(), { line: 0, col: 7 })
  assert.equal(editor.getText(), "one two", "word motion never changes text")
  assert.deepEqual(actionIds(events), [], "Alt+arrows never emit tool.details.previous/next-tool in the editor")
})

test("modal bytes dispatched through CcEditor emit only app-level tool details actions", () => {
  const { editor, events } = makeEditor({ context: "toolDetails" })
  editor.setText("draft stays untouched")

  press(editor, "[", "]", "\x1b[1;3D", "\x1b[1;3C", "\t", "\x1b[Z", "c", "\x1b[B")
  assert.deepEqual(actionIds(events), [
    "tool.details.previous-tool",
    "tool.details.next-tool",
    "tool.details.previous-tool",
    "tool.details.next-tool",
    "tool.details.next-section",
    "tool.details.previous-section",
    "tool.details.copy",
    "list.next",
  ])
  assert.equal(editor.getText(), "draft stays untouched")
  assert.equal(editor.getContext(), "toolDetails")

  // Unbound bytes are inert in the read-only modal: no text insertion.
  events.length = 0
  press(editor, "x", "z", " ")
  editor.handleInput("\x1b[200~secret\x1b[201~")
  editor.flushInputBuffer()
  assert.deepEqual(actionIds(events), [])
  assert.equal(editor.getText(), "draft stays untouched")

  events.length = 0
  press(editor, "\x1b")
  assert.deepEqual(actionIds(events), ["list.cancel"])
})

// --- remap / disable ----------------------------------------------------

test("every new binding can be remapped, and the old key stops working", () => {
  const keymap = mod.createCcKeymap({
    bindings: {
      "app.tools.details": "ctrl+x ctrl+d",
      "tool.details.next-section": "n",
      "tool.details.previous-section": "p",
      "tool.details.previous-tool": "h",
      "tool.details.next-tool": "l",
      "tool.details.copy": "y",
    },
  })
  assert.equal(keymap.getDiagnostics().some((diagnostic) => diagnostic.severity === "error"), false)

  // New chord works.
  assert.equal(keymap.resolve("\x18", "editor", 1_000).kind, "pending")
  assert.equal(resolveId(keymap, "\x04", "editor", 1_010), "app.tools.details")
  // Old chord no longer opens details; the second key is re-dispatched fresh.
  const old = keymap.resolve("\x18", "editor", 2_000)
  assert.equal(old.kind, "pending")
  const mismatch = keymap.resolve("\x0f", "editor", 2_010)
  assert.equal(mismatch.kind, "cancelled-chord")
  assert.equal(mismatch.kind === "cancelled-chord" ? mismatch.passthrough : "", "\x0f")
  assert.equal(resolveId(keymap, "\x0f", "editor"), "app.tools.expand")

  // New modal keys work; old keys resolve to their fallback or nothing.
  assert.equal(resolveId(keymap, "n", "toolDetails"), "tool.details.next-section")
  assert.equal(keymap.resolve("\t", "toolDetails").kind, "none")
  assert.equal(keymap.resolve("\x1b[C", "toolDetails").kind, "none")
  assert.equal(resolveId(keymap, "p", "toolDetails"), "tool.details.previous-section")
  assert.equal(keymap.resolve("\x1b[D", "toolDetails").kind, "none")
  assert.notEqual(resolveId(keymap, "\x1b[Z", "toolDetails"), "tool.details.previous-section")
  assert.equal(resolveId(keymap, "h", "toolDetails"), "tool.details.previous-tool")
  assert.equal(resolveId(keymap, "l", "toolDetails"), "tool.details.next-tool")
  for (const data of ["[", "]", "\x1b[1;3D", "\x1b[1;3C"]) {
    assert.notEqual(resolveId(keymap, data, "toolDetails"), "tool.details.previous-tool", data)
    assert.notEqual(resolveId(keymap, data, "toolDetails"), "tool.details.next-tool", data)
  }
  assert.equal(resolveId(keymap, "y", "toolDetails"), "tool.details.copy")
  assert.equal(keymap.resolve("c", "toolDetails").kind, "none")
})

test("new bindings can be disabled; disabled keys never resurrect defaults", () => {
  const keymap = mod.createCcKeymap({
    bindings: {
      "app.tools.details": null,
      "tool.details.next-section": null,
      "tool.details.previous-section": null,
      "tool.details.previous-tool": null,
      "tool.details.next-tool": null,
      "tool.details.copy": null,
    },
  })

  // Ctrl+X then Ctrl+O: no details chord remains; Ctrl+O falls back to expand.
  assert.equal(keymap.resolve("\x18", "editor", 1_000).kind, "pending")
  const mismatch = keymap.resolve("\x0f", "editor", 1_010)
  assert.equal(mismatch.kind, "cancelled-chord")
  assert.equal(resolveId(keymap, "\x0f", "editor"), "app.tools.expand")

  for (const data of ["\t", "\x1b[C", "\x1b[D", "c", "[", "]", "\x1b[1;3D", "\x1b[1;3C"]) {
    assert.equal(keymap.resolve(data, "toolDetails").kind, "none", data)
  }
  // Shift+Tab no longer switches sections; the global permission cycle is the
  // only remaining meaning in the fallback chain.
  assert.notEqual(resolveId(keymap, "\x1b[Z", "toolDetails"), "tool.details.previous-section")
})

test("remapped modal keys are dispatched by CcEditor and old keys emit nothing", () => {
  const { editor, events } = makeEditor({
    context: "toolDetails",
    bindings: {
      "tool.details.next-section": "n",
      "tool.details.previous-section": "p",
      "tool.details.previous-tool": "h",
      "tool.details.next-tool": "l",
      "tool.details.copy": "y",
    },
  })
  editor.setText("readonly")
  press(editor, "n", "p", "h", "l", "y")
  assert.deepEqual(actionIds(events), [
    "tool.details.next-section",
    "tool.details.previous-section",
    "tool.details.previous-tool",
    "tool.details.next-tool",
    "tool.details.copy",
  ])

  events.length = 0
  press(editor, "\t", "\x1b[Z", "[", "]", "\x1b[1;3D", "\x1b[1;3C")
  assert.deepEqual(
    actionIds(events).filter((id) => id.startsWith("tool.details.")),
    [],
    "the retired tool-details defaults do not fire",
  )
  assert.equal(editor.getText(), "readonly")
})

test("remapped details chord is dispatched by the editor; the old chord is not", () => {
  const remapped = makeEditor({ bindings: { "app.tools.details": "ctrl+x ctrl+d" } })
  press(remapped.editor, "\x18", "\x04")
  assert.deepEqual(actionIds(remapped.events), ["app.tools.details"])

  remapped.events.length = 0
  press(remapped.editor, "\x18", "\x0f")
  assert.deepEqual(actionIds(remapped.events), ["app.tools.expand"], "old chord only reaches the Ctrl+O fallback")
  assert.equal(remapped.editor.getKeymap().isPendingChord(), false)

  const disabled = makeEditor({ bindings: { "app.tools.details": null } })
  press(disabled.editor, "\x18", "\x0f")
  assert.deepEqual(actionIds(disabled.events), ["app.tools.expand"])
  assert.equal(disabled.editor.getKeymap().isPendingChord(), false)
})

// --- interrupt priority -------------------------------------------------

test("default Ctrl+C is local; an explicit app.interrupt keeps priority in toolDetails", () => {
  const keymap = mod.createCcKeymap()
  assert.deepEqual(keymap.getBindings("app.interrupt"), [])
  const changes: Array<readonly string[] | null> = []
  keymap.onChordChange((prefix) => changes.push(prefix))

  assert.equal(keymap.resolve("\x18", "toolDetails", 1_000).kind, "pending")
  assert.deepEqual(keymap.getPendingChord(), ["ctrl+x"])
  const cancelled = keymap.resolve("\x03", "toolDetails", 1_010)
  assert.equal(cancelled.kind, "cancelled-chord")
  assert.equal(cancelled.kind === "cancelled-chord" ? cancelled.passthrough : "", "\x03")
  assert.equal(keymap.isPendingChord(), false)
  assert.deepEqual(changes, [["ctrl+x"], null], "the hint is cleared exactly once")
  assert.equal(resolveId(keymap, "\x03", "toolDetails"), "list.cancel")

  // An explicitly remapped interrupt key keeps the same priority.
  const remapped = mod.createCcKeymap({ bindings: { "app.interrupt": "alt+q" } })
  assert.equal(remapped.resolve("\x18", "toolDetails", 1_000).kind, "pending")
  assert.equal(resolveId(remapped, "\x1bq", "toolDetails", 1_010), "app.interrupt")
  assert.equal(remapped.isPendingChord(), false)
  // The old Ctrl+C now reaches the local list.cancel in toolDetails.
  assert.equal(resolveId(remapped, "\x03", "toolDetails"), "list.cancel")

  // Disabling the explicit interrupt never invents a phantom priority; the
  // local cancel row receives Ctrl+C (the chord is handled first).
  const disabled = mod.createCcKeymap({ bindings: { "app.interrupt": null } })
  assert.equal(resolveId(disabled, "\x03", "toolDetails"), "list.cancel")
  assert.equal(disabled.resolve("\x18", "toolDetails", 2_000).kind, "pending")
  const cancelledByLocal = disabled.resolve("\x03", "toolDetails", 2_010)
  assert.equal(cancelledByLocal.kind, "cancelled-chord")
  assert.equal(
    resolveId(disabled, cancelledByLocal.kind === "cancelled-chord" ? cancelledByLocal.passthrough : "", "toolDetails"),
    "list.cancel",
  )

  // The picker keeps its default local cancel and the same explicit override.
  const picker = mod.createCcKeymap()
  assert.equal(picker.resolve("\x18", "modelPickerSearch", 3_000).kind, "pending")
  assert.equal(picker.resolve("\x03", "modelPickerSearch", 3_010).kind, "cancelled-chord")
  assert.equal(picker.isPendingChord(), false)
  assert.equal(resolveId(picker, "\x03", "modelPickerSearch"), "list.cancel")

  // Existing `list` semantics are deliberately unchanged.
  assert.equal(resolveId(mod.createCcKeymap(), "\x03", "list"), "list.cancel")
})

test("CcEditor in toolDetails cancels locally on Ctrl+C without touching the draft", () => {
  const { editor, events } = makeEditor({ context: "toolDetails" })
  editor.setText("readonly content")
  const before = editor.captureDraft()

  press(editor, "\x18")
  assert.equal(editor.getKeymap().isPendingChord(), true)
  press(editor, "\x03")

  assert.deepEqual(actionIds(events), ["list.cancel"])
  assert.equal(editor.getKeymap().isPendingChord(), false)
  assert.deepEqual(editor.captureDraft(), before)
  assert.equal(editor.getText(), "readonly content")

  // Only an explicit interrupt override is forwarded to the App.
  events.length = 0
  const explicit = makeEditor({ context: "toolDetails", bindings: { "app.interrupt": "alt+q" } })
  press(explicit.editor, "\x1bq")
  assert.deepEqual(actionIds(explicit.events), ["app.interrupt"])
})

// --- back to the editor -------------------------------------------------

test("returning to the editor makes `c` plain input and keeps readline behaviour", () => {
  const { editor, events } = makeEditor()
  editor.setContext("toolDetails")
  press(editor, "c")
  assert.deepEqual(actionIds(events), ["tool.details.copy"])
  assert.equal(editor.getText(), "")

  editor.setContext("editor")
  events.length = 0
  typeText(editor, "c")
  assert.equal(editor.getText(), "c", "`c` is ordinary text in the main editor")
  assert.deepEqual(actionIds(events), [])

  // The CC/readline family is intact after the modal context switch.
  editor.setText("src/utils/foo.ts")
  editor.ccSetCursor(0, "src/utils/foo.ts".length)
  press(editor, "\x17") // Ctrl+W: whole path
  assert.equal(editor.getText(), "")
  press(editor, "\x19") // Ctrl+Y
  assert.equal(editor.getText(), "src/utils/foo.ts")
  press(editor, "\x1f") // undo yank
  assert.equal(editor.getText(), "")
  press(editor, "\x1f") // undo kill
  assert.equal(editor.getText(), "src/utils/foo.ts")
  press(editor, "\x01") // Ctrl+A
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 })
  assert.deepEqual(actionIds(events), [], "readline edits stay editor-local")

  // App overrides still work, including both Ctrl+O forms.
  press(editor, "\x0f")
  press(editor, "\x18", "\x0f")
  assert.deepEqual(actionIds(events), ["app.tools.expand", "app.tools.details"])
})

test("disabling tool.details.copy does not affect `c` in the editor", () => {
  const keymap = mod.createCcKeymap({ bindings: { "tool.details.copy": null } })
  assert.equal(keymap.resolve("c", "toolDetails").kind, "none")
  assert.equal(keymap.resolve("c", "editor").kind, "none")

  const { editor, events } = makeEditor({ keymap })
  typeText(editor, "c")
  assert.equal(editor.getText(), "c")
  assert.deepEqual(actionIds(events), [])
})