/**
 * Unified modal / Settings input contract, offline only.
 *
 * The popup redesign adds four read-only browse contexts
 * (`settingsList`, `keybindingsList`, `modalList`, `queueList`) plus the one
 * editable `modalSearch` field, all inside the existing `src/input/` registry.
 * This file pins the contracted action ids, defaults, context overlap, chord
 * and interrupt behaviour. No terminal write, model/provider call, DSH process,
 * clipboard/profile/session read or global installation is involved: raw
 * terminal bytes go through the shared `CcKeymap` or one Pi editor state.
 */

import test from "node:test"
import assert from "node:assert/strict"

import {
  asTui,
  createFakeTui,
  loadInputModule,
  press,
  renderAt,
  testEditorTheme,
  typeText,
} from "../src/input/testing/harness.ts"
import type { CcActionEvent, CcContext, CcEditorOptions, CcKeyResolution } from "../src/input/index.ts"

const mod = await loadInputModule()
type TestKeymap = InstanceType<typeof mod.CcKeymap>
type TestEditor = InstanceType<typeof mod.CcEditor>

const BROWSE_CONTEXTS = ["settingsList", "keybindingsList", "modalList", "queueList"] as const
const NEW_CONTEXTS = [...BROWSE_CONTEXTS, "modalSearch"] as const

function actionId(keymap: TestKeymap, data: string, context: CcContext, now?: number): string | undefined {
  const resolution = now === undefined ? keymap.resolve(data, context) : keymap.resolve(data, context, now)
  return resolution.kind === "action" ? resolution.action.id : undefined
}

function resolve(keymap: TestKeymap, data: string, context: CcContext): CcKeyResolution {
  return keymap.resolve(data, context)
}

function actionIds(events: readonly CcActionEvent[]): string[] {
  return events.map((event) => event.id)
}

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

// --- contexts and fallback chains ---------------------------------------

test("new modal contexts exist with the contracted fallback chains", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  for (const context of NEW_CONTEXTS) {
    assert.ok(mod.CC_CONTEXTS.includes(context), `${context} is a registry context`)
  }

  for (const context of BROWSE_CONTEXTS) {
    assert.deepEqual(keymap.getFallbackChain(context), [context, "list", "dialog", "global"])
    assert.equal(
      keymap.getFallbackChain(context).includes("editor"),
      false,
      `${context} must not fall through to the editor layer`,
    )
  }
  assert.deepEqual(keymap.getFallbackChain("modalSearch"), ["modalSearch", "editor", "dialog", "global"])

  // The chain is a defensive copy, not internal state.
  keymap.getFallbackChain("settingsList").push("editor")
  assert.deepEqual(keymap.getFallbackChain("settingsList"), ["settingsList", "list", "dialog", "global"])

  // Every existing chain is unchanged by this pass.
  assert.deepEqual(keymap.getFallbackChain("editor"), ["editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("autocomplete"), ["autocomplete", "editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("historySearch"), ["historySearch", "editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("dialog"), ["dialog", "editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("list"), ["list", "global"])
  assert.deepEqual(keymap.getFallbackChain("modelPickerList"), ["modelPickerList", "list", "editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("modelPickerSearch"), ["modelPickerSearch", "editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("toolDetails"), ["toolDetails", "list", "dialog", "global"])
  assert.deepEqual(keymap.getFallbackChain("imageDetails"), ["imageDetails", "list", "dialog", "global"])
  assert.deepEqual(keymap.getFallbackChain("subagentList"), ["subagentList", "list", "dialog", "global"])
  assert.deepEqual(keymap.getFallbackChain("subagentSession"), ["subagentSession", "list", "dialog", "global"])
  assert.deepEqual(keymap.getFallbackChain("global"), ["global"])
})

test("browse contexts declare only their contracted local actions", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  const local: Record<string, string[]> = {
    settingsList: ["modal.search", "settings.reset", "settings.previous-category", "settings.next-category"],
    keybindingsList: ["modal.search", "keybindings.edit", "keybindings.reset", "keybindings.disable"],
    modalList: ["modal.search", "session.scope.toggle", "dialog.details"],
    queueList: ["modal.search", "queue.edit", "queue.cancel-entry", "queue.send-now"],
    // A search field is not a list: no context-local rows, only the editor,
    // dialog and global fallback layers.
    modalSearch: [],
  }
  for (const [context, ids] of Object.entries(local)) {
    assert.deepEqual(keymap.getActions(context as CcContext).map((action) => action.id), ids)
  }

  // Existing read-only modals only gain the shared modal.search row.
  const details = keymap.getActions("toolDetails").map((action) => action.id)
  for (const id of ["modal.search", "tool.details.toggle-calls", "tool.details.wrap"]) {
    assert.ok(details.includes(id), id)
  }
  assert.equal(details.includes("queue.edit"), false)
  // The image viewer is not a searchable surface.
  assert.equal(keymap.getActions("imageDetails").some((action) => action.id === "modal.search"), false)
})

test("contracted ids, contexts, defaults and statuses are pinned", () => {
  const { CC_ACTIONS_BY_ID } = mod
  const expected: Array<{
    id: string
    contexts: CcContext[]
    bindings: string[]
    family: string
  }> = [
    {
      id: "modal.search",
      contexts: [
        "settingsList",
        "keybindingsList",
        "modalList",
        "toolDetails",
        "subagentList",
        "subagentSession",
        "queueList",
      ],
      bindings: ["ctrl+f"],
      family: "dialog",
    },
    { id: "settings.reset", contexts: ["settingsList"], bindings: ["ctrl+r"], family: "dialog" },
    { id: "settings.previous-category", contexts: ["settingsList"], bindings: ["left", "shift+tab"], family: "dialog" },
    { id: "settings.next-category", contexts: ["settingsList"], bindings: ["right", "tab"], family: "dialog" },
    { id: "keybindings.edit", contexts: ["keybindingsList"], bindings: ["enter"], family: "dialog" },
    { id: "keybindings.reset", contexts: ["keybindingsList"], bindings: ["ctrl+r"], family: "dialog" },
    { id: "keybindings.disable", contexts: ["keybindingsList"], bindings: ["ctrl+d"], family: "dialog" },
    { id: "session.scope.toggle", contexts: ["modalList"], bindings: ["ctrl+a"], family: "list" },
    { id: "subagent.filter.toggle", contexts: ["subagentList"], bindings: ["tab"], family: "list" },
    { id: "tool.details.toggle-calls", contexts: ["toolDetails"], bindings: ["ctrl+l"], family: "dialog" },
    { id: "tool.details.wrap", contexts: ["toolDetails"], bindings: ["ctrl+w"], family: "dialog" },
    { id: "app.queue.open", contexts: ["global"], bindings: ["ctrl+x ctrl+q"], family: "app" },
    { id: "queue.edit", contexts: ["queueList"], bindings: ["e"], family: "dialog" },
    { id: "queue.cancel-entry", contexts: ["queueList"], bindings: ["d"], family: "dialog" },
    { id: "queue.send-now", contexts: ["queueList"], bindings: ["ctrl+enter"], family: "dialog" },
  ]

  for (const item of expected) {
    const definition = CC_ACTIONS_BY_ID.get(item.id)
    assert.ok(definition, `${item.id} is registered`)
    assert.deepEqual(definition.contexts, item.contexts, `${item.id} contexts`)
    assert.deepEqual(definition.defaultBindings, item.bindings, `${item.id} defaults`)
    assert.equal(definition.family, item.family, `${item.id} family (Settings group)`)
    assert.equal(definition.implementor, "app", `${item.id} is dispatched by the app/UI, not a hidden editor`)
    assert.equal(definition.status, "tui-extension", `${item.id} is not presented as a CC-verified default`)
    assert.ok((definition.note ?? "").length > 0, `${item.id} documents its scope and terminal caveats`)
  }

  // Every default is a single key or a chord the registry can parse, so the
  // Settings editor can remap/disable/reset each row through the same file.
  for (const item of expected) {
    for (const spec of item.bindings) {
      const keys = mod.parseBindingSpec(spec)
      assert.ok(keys && keys.length > 0, `${item.id}: ${spec}`)
    }
  }
})

// --- Ctrl+F browse/search split -----------------------------------------

test("Ctrl+F searches browse surfaces but stays editor char-right while typing", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  for (const context of ["settingsList", "keybindingsList", "modalList", "queueList", "toolDetails", "subagentList", "subagentSession"] as const) {
    assert.equal(actionId(keymap, "\x06", context), "modal.search", context)
  }
  // The modal text field keeps editor movement, and the prompt is untouched.
  assert.equal(actionId(keymap, "\x06", "modalSearch"), "editor.move.char-right")
  assert.equal(actionId(keymap, "\x06", "editor"), "editor.move.char-right")
  // The image viewer has no search field and no editor fallback.
  assert.equal(actionId(keymap, "\x06", "imageDetails"), undefined)
})

// --- Settings list ------------------------------------------------------

test("settingsList: group jumps, reset, select and no editor fallthrough", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  // Left/Right and Shift+Tab/Tab are the same two group-navigation actions.
  assert.equal(actionId(keymap, "\x1b[D", "settingsList"), "settings.previous-category")
  assert.equal(actionId(keymap, "\x1b[C", "settingsList"), "settings.next-category")
  assert.equal(actionId(keymap, "\t", "settingsList"), "settings.next-category")
  assert.equal(actionId(keymap, "\x1b[Z", "settingsList"), "settings.previous-category")
  assert.equal(actionId(keymap, "\x12", "settingsList"), "settings.reset")
  assert.equal(actionId(keymap, "\r", "settingsList"), "list.select")
  assert.equal(actionId(keymap, "\x1b", "settingsList"), "list.cancel")
  assert.equal(actionId(keymap, "\x10", "settingsList"), "list.previous")
  assert.equal(actionId(keymap, "\x0e", "settingsList"), "list.next")
  assert.equal(actionId(keymap, "k", "settingsList"), "list.previous")
  assert.equal(actionId(keymap, "j", "settingsList"), "list.next")

  // No editor fallthrough: kill/yank/undo/char movement cannot reach a draft.
  for (const data of ["\x17", "\x19", "\x1f", "\x02", "\x05", "\x01"]) {
    assert.equal(actionId(keymap, data, "settingsList"), undefined, JSON.stringify(data))
  }
  // Ctrl+A is not a settings action and not line-start here.
  assert.equal(actionId(keymap, "\x01", "settingsList"), undefined)
  assert.equal(actionId(keymap, "\x01", "editor"), "editor.move.line-start")

  // Ctrl+O is the dialog-local native-details row inside a modal list; the
  // plain root prompt keeps app.tools.expand.
  assert.equal(actionId(keymap, "\x0f", "settingsList"), "dialog.details")
  assert.equal(actionId(keymap, "\x0f", "editor"), "app.tools.expand")
  // Other global app actions still fall through; Ctrl+R never means history here.
  assert.equal(actionId(keymap, "\x12", "editor"), "app.history.search")

  // In the modal search field the same keys are text-field/global keys.
  assert.equal(actionId(keymap, "\x12", "modalSearch"), "app.history.search")
  assert.equal(actionId(keymap, "\x1b[D", "modalSearch"), "editor.move.char-left")
  assert.equal(actionId(keymap, "\x1b[C", "modalSearch"), "editor.move.char-right")
  assert.equal(actionId(keymap, "\x17", "modalSearch"), "editor.kill.whitespace-backward")
  assert.equal(actionId(keymap, "\x01", "modalSearch"), "editor.move.line-start")
  assert.equal(actionId(keymap, "\x1b", "modalSearch"), "editor.cancel")
})

// --- keyboard shortcuts list -------------------------------------------

test("keybindingsList: Enter edits (explicit edit/select precedence), disable/reset stay local", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  assert.equal(actionId(keymap, "\r", "keybindingsList"), "keybindings.edit")
  assert.equal(actionId(keymap, "\x12", "keybindingsList"), "keybindings.reset")
  assert.equal(actionId(keymap, "\x04", "keybindingsList"), "keybindings.disable")
  assert.equal(actionId(keymap, "\x1b", "keybindingsList"), "list.cancel")

  // The edit/select overlap is deliberate and explicit: keybindings.edit wins
  // in this one context, and list.select is the documented fallback if the
  // action is disabled or remapped elsewhere.
  const disabledEdit = mod.createCcKeymap({ bindings: { "keybindings.edit": null }, platform: "posix" })
  assert.equal(actionId(disabledEdit, "\r", "keybindingsList"), "list.select")
  assert.deepEqual(disabledEdit.getBindings("keybindings.edit"), [])
  const remappedEdit = mod.createCcKeymap({ bindings: { "keybindings.edit": "ctrl+e" }, platform: "posix" })
  assert.equal(actionId(remappedEdit, "\x05", "keybindingsList"), "keybindings.edit")
  assert.equal(actionId(remappedEdit, "\r", "keybindingsList"), "list.select")

  // Ctrl+D never becomes a global disable: the prompt keeps forward delete and
  // global app.exit keeps its existing meaning outside this list.
  assert.deepEqual(mod.CC_ACTIONS_BY_ID.get("keybindings.disable")?.contexts, ["keybindingsList"])
  assert.equal(actionId(keymap, "\x04", "editor"), "editor.delete.char-forward")
  assert.equal(actionId(keymap, "\x04", "global"), "app.exit")
  assert.equal(actionId(keymap, "d", "editor"), undefined, "d is ordinary text in the prompt")

  // No editor fallthrough in the shortcut list either.
  assert.equal(actionId(keymap, "\x17", "keybindingsList"), undefined)
  assert.equal(actionId(keymap, "\x19", "keybindingsList"), undefined)
})

// --- generic modal list and queue list ----------------------------------

test("modalList: Ctrl+A toggles scope only there", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  assert.equal(actionId(keymap, "\x01", "modalList"), "session.scope.toggle")
  assert.equal(actionId(keymap, "\x01", "settingsList"), undefined)
  assert.equal(actionId(keymap, "\x01", "queueList"), undefined)
  assert.equal(actionId(keymap, "\x01", "modalSearch"), "editor.move.line-start")
  assert.equal(actionId(keymap, "\x01", "editor"), "editor.move.line-start")
  assert.equal(actionId(keymap, "\r", "modalList"), "list.select")
  assert.equal(actionId(keymap, "\x1b", "modalList"), "list.cancel")
})

test("queueList: e/d/Ctrl+Enter are queue-local and Enter still selects", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  assert.equal(actionId(keymap, "e", "queueList"), "queue.edit")
  assert.equal(actionId(keymap, "d", "queueList"), "queue.cancel-entry")
  // Ctrl+Enter only exists where a terminal can report it (Kitty / modifyOtherKeys).
  assert.equal(actionId(keymap, "\x1b[13;5u", "queueList"), "queue.send-now")
  assert.equal(actionId(keymap, "\x1b[27;5;13~", "queueList"), "queue.send-now")
  // Legacy Enter is still plain select, never an implicit "send now".
  assert.equal(actionId(keymap, "\r", "queueList"), "list.select")
  assert.equal(actionId(keymap, "\r", "list"), "list.select")
  assert.equal(actionId(keymap, "j", "queueList"), "list.next")

  // The same printable keys stay text/list-neutral outside the queue list.
  for (const context of ["editor", "list", "global", "settingsList", "modalSearch"] as const) {
    assert.notEqual(actionId(keymap, "e", context), "queue.edit", context)
    assert.notEqual(actionId(keymap, "d", context), "queue.cancel-entry", context)
  }
  assert.equal(actionId(keymap, "\x1b[13;5u", "editor"), undefined)
  assert.equal(actionId(keymap, "\x1b[13;5u", "settingsList"), undefined)
})

test("subagentList Tab filters, toolDetails Ctrl+L/Ctrl+W are browse-only", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  assert.equal(actionId(keymap, "\t", "subagentList"), "subagent.filter.toggle")
  assert.equal(actionId(keymap, "\t", "subagentSession"), undefined)
  assert.equal(actionId(keymap, "\t", "editor"), "editor.complete")

  assert.equal(actionId(keymap, "\x0c", "toolDetails"), "tool.details.toggle-calls")
  assert.equal(actionId(keymap, "\x17", "toolDetails"), "tool.details.wrap")
  // The prompt keeps its CC meanings; a tool text field keeps editor kill.
  assert.equal(actionId(keymap, "\x0c", "editor"), "app.redraw")
  assert.equal(actionId(keymap, "\x17", "editor"), "editor.kill.whitespace-backward")
  assert.equal(actionId(keymap, "\x17", "modalSearch"), "editor.kill.whitespace-backward")
  assert.equal(actionId(keymap, "\x17", "settingsList"), undefined)
  assert.equal(actionId(keymap, "\x0c", "queueList"), "app.redraw")
})

// --- global opening chord ------------------------------------------------

test("app.queue.open is a chord-aware global action that stays remappable", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  assert.equal(resolve(keymap, "\x18", "editor").kind, "pending")
  assert.equal(actionId(keymap, "\x11", "editor"), "app.queue.open")

  // No other default binding takes Ctrl+Q, and the chord prefix is shared with
  // the existing Ctrl+X app chords without shadowing a single-key binding.
  const ctrlQ = mod.CC_ACTIONS.filter((action) =>
    action.defaultBindings.some((spec) => mod.parseBindingSpec(spec)?.includes("ctrl+q")),
  )
  assert.deepEqual(ctrlQ.map((action) => action.id), ["app.queue.open"])

  // Disabling the chord leaves the prefix waiting, then mismatches safely
  // (redispatch) instead of firing a different app action.
  const disabled = mod.createCcKeymap({ bindings: { "app.queue.open": null }, platform: "posix" })
  assert.equal(resolve(disabled, "\x18", "editor").kind, "pending")
  const cancelled = disabled.resolve("\x11", "editor")
  assert.equal(cancelled.kind, "cancelled-chord")
  assert.equal(cancelled.kind === "cancelled-chord" ? cancelled.reason : "", "mismatch")
  assert.equal(cancelled.kind === "cancelled-chord" ? cancelled.passthrough : "", "\x11")

  // A remapped modal.search chord completes inside the browse context while
  // the global Ctrl-X chords stay intact.
  const remapped = mod.createCcKeymap({ bindings: { "modal.search": "ctrl+x ctrl+f" }, platform: "posix" })
  assert.equal(resolve(remapped, "\x18", "settingsList").kind, "pending")
  assert.equal(actionId(remapped, "\x06", "settingsList"), "modal.search")
  assert.equal(actionId(remapped, "\x06", "editor"), "editor.move.char-right")
})

// --- interrupt priority -------------------------------------------------

test("default Ctrl+C is local in every new modal context; an explicit interrupt keeps priority", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  assert.deepEqual(keymap.getBindings("app.interrupt"), [], "app.interrupt ships unbound")
  // Default Ctrl+C reaches the local cancel/reject row, never a hidden root
  // clear or a global native abort.
  for (const context of BROWSE_CONTEXTS) {
    assert.equal(actionId(keymap, "\x03", context), "list.cancel", context)
  }
  assert.equal(actionId(keymap, "\x03", "modalSearch"), "dialog.cancel", "the modal field cancels its dialog")

  // Read-only browse lists: a pending chord is dropped, then the local row
  // receives the key (the editor re-dispatches the passthrough once).
  for (const context of BROWSE_CONTEXTS) {
    assert.equal(resolve(keymap, "\x18", context).kind, "pending", context)
    const cancelled = keymap.resolve("\x03", context)
    assert.equal(cancelled.kind, "cancelled-chord", `${context} drops the chord prefix`)
    assert.equal(cancelled.kind === "cancelled-chord" ? cancelled.passthrough : "", "\x03")
    assert.equal(keymap.isPendingChord(), false, `${context} chord is cancelled`)
    assert.equal(actionId(keymap, "\x03", context), "list.cancel")
  }

  // An explicit interrupt override is honoured, not a hardcoded byte, and it
  // wins before the chain and before a pending chord in these contexts.
  const remapped = mod.createCcKeymap({ bindings: { "app.interrupt": "ctrl+g" }, platform: "posix" })
  for (const context of NEW_CONTEXTS) {
    assert.equal(actionId(remapped, "\x07", context), "app.interrupt", context)
  }
  for (const context of BROWSE_CONTEXTS) {
    assert.equal(resolve(remapped, "\x18", context).kind, "pending", context)
    assert.equal(actionId(remapped, "\x07", context), "app.interrupt", `${context} over a pending chord`)
    assert.equal(remapped.isPendingChord(), false, `${context} chord is cancelled by the interrupt`)
  }
  // Old Ctrl+C then resolves through the normal chain (list.cancel in browse lists).
  assert.equal(actionId(remapped, "\x03", "settingsList"), "list.cancel")
  assert.equal(actionId(remapped, "\x03", "modalSearch"), "dialog.cancel")

  // Esc keeps its local meaning: close the browse surface / cancel the field.
  assert.equal(actionId(keymap, "\x1b", "queueList"), "list.cancel")
  assert.equal(actionId(keymap, "\x1b", "modalSearch"), "editor.cancel")
})

// --- discoverability and diagnostics ------------------------------------

test("every new action is one grouped Settings row with no default conflict", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  assert.equal(keymap.getDiagnostics().some((diagnostic) => diagnostic.severity === "error"), false)
  const newContexts = new Set<string>(NEW_CONTEXTS)
  assert.deepEqual(
    keymap.getConflicts().filter((diagnostic) => diagnostic.context !== undefined && newContexts.has(diagnostic.context)),
    [],
  )

  const labels: Record<string, string> = {
    "modal.search": "Ctrl+F",
    "settings.reset": "Ctrl+R",
    "settings.previous-category": "Left, Shift+Tab",
    "settings.next-category": "Right, Tab",
    "keybindings.edit": "Enter",
    "keybindings.reset": "Ctrl+R",
    "keybindings.disable": "Ctrl+D",
    "session.scope.toggle": "Ctrl+A",
    "subagent.filter.toggle": "Tab",
    "tool.details.toggle-calls": "Ctrl+L",
    "tool.details.wrap": "Ctrl+W",
    "app.queue.open": "Ctrl+X Ctrl+Q",
    "queue.edit": "E",
    "queue.cancel-entry": "D",
    "queue.send-now": "Ctrl+Enter",
  }
  const listed = keymap.getActions().map((action) => action.id)
  const help = keymap.getHelp()
  for (const [id, keysLabel] of Object.entries(labels)) {
    assert.ok(listed.includes(id), `${id} is listed in the Settings shortcut list`)
    assert.equal(help.find((row) => row.action === id)?.keysLabel, keysLabel, `${id} effective hint`)
  }

  // A disabled row keeps its Settings entry but advertises no dead key.
  keymap.setBindings({ "modal.search": null })
  assert.ok(keymap.getActions().some((action) => action.id === "modal.search"))
  assert.equal(keymap.getHelp().some((row) => row.action === "modal.search"), false)
  assert.equal(keymap.getHelp("settingsList").some((row) => row.action === "modal.search"), false)
  // Reset (delete one override) restores the same row.
  keymap.setBindings({})
  assert.equal(keymap.getHelp("settingsList").find((row) => row.action === "modal.search")?.keysLabel, "Ctrl+F")
})

// --- one editor state ---------------------------------------------------

test("modalSearch edits through the one editor; browse contexts fail closed", () => {
  const search = makeEditor({ context: "modalSearch" })
  typeText(search.editor, "model")
  assert.equal(search.editor.getText(), "model")
  press(search.editor, "\x17")
  assert.equal(search.editor.getText(), "", "Ctrl+W is CC whitespace-kill in the search field")

  // Word kill, yank and undo stay the editor's own tested behaviour; the seam
  // is the same one Pi editor state, not a second editor.
  typeText(search.editor, "alpha beta")
  press(search.editor, "\x17")
  assert.equal(search.editor.getText(), "alpha ")
  press(search.editor, "\x19")
  assert.equal(search.editor.getText(), "alpha beta")
  press(search.editor, "\x1f")
  assert.equal(search.editor.getText(), "alpha ")
  assert.deepEqual(actionIds(search.events), [], "text editing emits no app action")

  // Ctrl+F moves the cursor in the field instead of opening a second search.
  typeText(search.editor, "xy")
  const textBefore = search.editor.getText()
  const before = search.editor.getCursor()
  press(search.editor, "\x1b[D")
  assert.equal(search.editor.getCursor().col, before.col - 1)
  press(search.editor, "\x06")
  assert.equal(search.editor.getCursor().col, before.col, "Ctrl+F moves right, no modal.search here")
  assert.equal(search.editor.getText(), textBefore)
  assert.deepEqual(actionIds(search.events), [])

  // Esc in the field forwards app.cancel; Ctrl+C cancels the containing dialog
  // locally (dialog.cancel) instead of clearing the hidden root draft.
  press(search.editor, "\x1b")
  press(search.editor, "\x03")
  assert.deepEqual(actionIds(search.events), ["app.cancel", "dialog.cancel"])

  // A read-only browse surface never types into a hidden draft: printable and
  // editing bytes are inert, list keys resolve to their named actions.
  const browse = makeEditor({ context: "settingsList" })
  typeText(browse.editor, "zz")
  press(browse.editor, "\x17")
  press(browse.editor, "\x19")
  press(browse.editor, "\x1f")
  press(browse.editor, "\x06")
  press(browse.editor, "\r")
  press(browse.editor, "\x04")
  assert.equal(browse.editor.getText(), "")
  assert.deepEqual(actionIds(browse.events), ["modal.search", "list.select", "app.exit"])

  const shortcuts = makeEditor({ context: "keybindingsList" })
  typeText(shortcuts.editor, "ab")
  press(shortcuts.editor, "\r")
  press(shortcuts.editor, "\x04")
  press(shortcuts.editor, "\x12")
  assert.equal(shortcuts.editor.getText(), "")
  assert.deepEqual(actionIds(shortcuts.events), ["keybindings.edit", "keybindings.disable", "keybindings.reset"])
})