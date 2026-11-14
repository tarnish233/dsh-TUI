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
import type { CcActionEvent, CcEditorOptions } from "../src/input/index.ts"

// Same vendored Pi TUI instance as the input module; the seam is installed by
// CcEditor at module load. No model, backend or terminal is involved.
const mod = await loadInputModule()
type TestEditor = InstanceType<typeof mod.CcEditor>

function makeEditor(options: CcEditorOptions = {}) {
  const tui = createFakeTui()
  const editor = new mod.CcEditor(asTui(tui), testEditorTheme, options)
  const events: CcActionEvent[] = []
  const chordPrefixes: Array<string[] | null> = []
  editor.onAction = (event) => {
    events.push(event)
  }
  editor.onChordChange = (prefix) => {
    chordPrefixes.push(prefix)
  }
  renderAt(editor, 80)
  return { editor, tui, events, chordPrefixes }
}

function press(editor: TestEditor, ...keys: string[]): void {
  for (const key of keys) editor.handleInput(key)
  editor.flushInputBuffer()
}

function actionId(resolution: ReturnType<InstanceType<typeof mod.CcKeymap>["resolve"]>): string | undefined {
  return resolution.kind === "action" ? resolution.action.id : undefined
}

function actionIds(events: readonly CcActionEvent[]): string[] {
  return events.map((event) => event.id)
}

test("/model picker contexts exist with the approved fallback chains", () => {
  const { CC_CONTEXTS, createCcKeymap } = mod
  assert.ok(CC_CONTEXTS.includes("modelPickerList"))
  assert.ok(CC_CONTEXTS.includes("modelPickerSearch"))

  const keymap = createCcKeymap()
  assert.deepEqual(keymap.getFallbackChain("modelPickerList"), [
    "modelPickerList",
    "list",
    "editor",
    "global",
  ])
  assert.deepEqual(keymap.getFallbackChain("modelPickerSearch"), [
    "modelPickerSearch",
    "editor",
    "global",
  ])
  // Every existing chain is preserved.
  assert.deepEqual(keymap.getFallbackChain("editor"), ["editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("autocomplete"), ["autocomplete", "editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("historySearch"), ["historySearch", "editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("dialog"), ["dialog", "editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("list"), ["list", "global"])
  assert.deepEqual(keymap.getFallbackChain("global"), ["global"])

  // The returned chain is a copy, not internal state.
  keymap.getFallbackChain("modelPickerList").push("editor")
  assert.deepEqual(keymap.getFallbackChain("modelPickerList"), [
    "modelPickerList",
    "list",
    "editor",
    "global",
  ])
})

test("browse-mode keymap defaults: provider keys, shared list keys and editor fallback", () => {
  // Note: CcEditor applies picker text priority on top of this (see the text
  // priority test below), so list j/k/digits are only reachable by direct
  // keymap consumers, not by typed input into the picker editor.
  const keymap = mod.createCcKeymap()
  // Tab / Shift+Tab exist in both picker contexts.
  assert.equal(actionId(keymap.resolve("\t", "modelPickerList")), "model.provider.next")
  assert.equal(actionId(keymap.resolve("\x1b[Z", "modelPickerList")), "model.provider.previous")
  // Arrows cycle providers only in browse mode.
  assert.equal(actionId(keymap.resolve("\x1b[D", "modelPickerList")), "model.provider.previousArrow")
  assert.equal(actionId(keymap.resolve("\x1b[C", "modelPickerList")), "model.provider.nextArrow")
  // Existing configurable list navigation remains in the browse context.
  assert.equal(actionId(keymap.resolve("\x1b[A", "modelPickerList")), "list.previous")
  assert.equal(actionId(keymap.resolve("\x1b[B", "modelPickerList")), "list.next")
  assert.equal(actionId(keymap.resolve("\x10", "modelPickerList")), "list.previous")
  assert.equal(actionId(keymap.resolve("\x0e", "modelPickerList")), "list.next")
  assert.equal(actionId(keymap.resolve("k", "modelPickerList")), "list.previous")
  assert.equal(actionId(keymap.resolve("j", "modelPickerList")), "list.next")
  assert.equal(actionId(keymap.resolve("1", "modelPickerList")), "list.select-digit")
  assert.equal(actionId(keymap.resolve("\r", "modelPickerList")), "list.select")
  assert.equal(actionId(keymap.resolve("\x1b", "modelPickerList")), "list.cancel")
  // Default Ctrl+C is the local list.cancel in the picker context; the global
  // app.clear fallback is never reached by default.
  assert.equal(actionId(keymap.resolve("\x03", "modelPickerList")), "list.cancel")
  // Editing fallback underneath the list layer.
  assert.equal(actionId(keymap.resolve("\x17", "modelPickerList")), "editor.kill.whitespace-backward")
  assert.equal(actionId(keymap.resolve("\x01", "modelPickerList")), "editor.move.line-start")
  // Unbound printable characters stay unbound in the browse context.
  assert.equal(keymap.resolve("a", "modelPickerList").kind, "none")
})

test("search-mode defaults: provider keys, Enter/Esc, text editing and no list selection", () => {
  const keymap = mod.createCcKeymap()
  assert.equal(actionId(keymap.resolve("\t", "modelPickerSearch")), "model.provider.next")
  assert.equal(actionId(keymap.resolve("\x1b[Z", "modelPickerSearch")), "model.provider.previous")
  // Arrows edit text / move focus, they never cycle providers in search mode.
  assert.equal(actionId(keymap.resolve("\x1b[D", "modelPickerSearch")), "editor.move.char-left")
  assert.equal(actionId(keymap.resolve("\x1b[C", "modelPickerSearch")), "editor.move.char-right")
  assert.equal(actionId(keymap.resolve("\x1b[A", "modelPickerSearch")), "editor.move.line-up")
  assert.equal(actionId(keymap.resolve("\x1b[B", "modelPickerSearch")), "editor.move.line-down")
  assert.equal(actionId(keymap.resolve("\x10", "modelPickerSearch")), "editor.move.line-up")
  assert.equal(actionId(keymap.resolve("\x0e", "modelPickerSearch")), "editor.move.line-down")
  // Enter is forwarded as the existing list action; a bare LF is Ctrl+J and
  // keeps its editor newline meaning in the query field.
  assert.equal(actionId(keymap.resolve("\r", "modelPickerSearch")), "list.select")
  assert.equal(actionId(keymap.resolve("\n", "modelPickerSearch")), "editor.newline")
  assert.equal(actionId(keymap.resolve("\x1b", "modelPickerSearch")), "list.cancel")
  // Ctrl+C cancels the picker locally through its list.cancel row.
  assert.equal(actionId(keymap.resolve("\x03", "modelPickerSearch")), "list.cancel")
  // Standard readline edits are available.
  assert.equal(actionId(keymap.resolve("\x02", "modelPickerSearch")), "editor.move.char-left")
  assert.equal(actionId(keymap.resolve("\x06", "modelPickerSearch")), "editor.move.char-right")
  assert.equal(actionId(keymap.resolve("\x01", "modelPickerSearch")), "editor.move.line-start")
  assert.equal(actionId(keymap.resolve("\x05", "modelPickerSearch")), "editor.move.line-end")
  assert.equal(actionId(keymap.resolve("\x1bb", "modelPickerSearch")), "editor.move.word-left")
  assert.equal(actionId(keymap.resolve("\x1bf", "modelPickerSearch")), "editor.move.word-right")
  assert.equal(actionId(keymap.resolve("\x17", "modelPickerSearch")), "editor.kill.whitespace-backward")
  assert.equal(actionId(keymap.resolve("\x1b\x7f", "modelPickerSearch")), "editor.kill.word-backward")
  assert.equal(actionId(keymap.resolve("\x19", "modelPickerSearch")), "editor.yank")
  assert.equal(actionId(keymap.resolve("\x1by", "modelPickerSearch")), "editor.yank-pop")
  assert.equal(actionId(keymap.resolve("\x1f", "modelPickerSearch")), "editor.undo")
  // j/k/digits/spaces are text, never list selection in the search context.
  for (const data of ["j", "k", "1", "9", " "]) {
    assert.equal(keymap.resolve(data, "modelPickerSearch").kind, "none", `search ${JSON.stringify(data)}`)
  }
})

test("picker actions are configurable: remap, disable and remapped simple actions", () => {
  const disabled = mod.createCcKeymap({ bindings: { "model.provider.next": null } })
  assert.deepEqual(disabled.getBindings("model.provider.next"), [])
  // At keymap level the key falls through to the editor completion binding...
  assert.equal(actionId(disabled.resolve("\t", "modelPickerSearch")), "editor.complete")
  assert.equal(actionId(disabled.resolve("\t", "modelPickerList")), "editor.complete")

  // ...but CcEditor consumes it in picker contexts: only a registered
  // model.provider.* action may change the provider group.
  for (const context of ["modelPickerSearch", "modelPickerList"] as const) {
    const disabledEditor = makeEditor({ bindings: { "model.provider.next": null } })
    disabledEditor.editor.setContext(context)
    typeText(disabledEditor.editor, "que")
    const textBefore = disabledEditor.editor.getText()
    press(disabledEditor.editor, "\t")
    assert.deepEqual(disabledEditor.events, [], `disabled Tab must not emit editor.complete in ${context}`)
    assert.equal(disabledEditor.editor.getText(), textBefore)
  }

  // A disabled provider.previous also exposes a global fallback at keymap
  // level, but never a model.provider.* event.
  const disabledPrevious = makeEditor({ bindings: { "model.provider.previous": null } })
  disabledPrevious.editor.setContext("modelPickerSearch")
  press(disabledPrevious.editor, "\x1b[Z")
  assert.deepEqual(
    actionIds(disabledPrevious.events).filter((id) => id.startsWith("model.provider.")),
    [],
  )

  // Disabling list.select leaves Enter inert in the picker: it never falls
  // through to editor.submit (no onSubmit/clear) in browse or search mode.
  for (const context of ["modelPickerSearch", "modelPickerList"] as const) {
    const noSelect = makeEditor({ bindings: { "list.select": null } })
    noSelect.editor.setContext(context)
    let submitted: string | undefined
    noSelect.editor.onSubmit = (text) => {
      submitted = text
    }
    typeText(noSelect.editor, "que")
    press(noSelect.editor, "\r")
    assert.equal(submitted, undefined, context)
    assert.equal(noSelect.editor.getText(), "que", context)
    assert.deepEqual(noSelect.events, [], context)
  }

  const remapped = mod.createCcKeymap({
    bindings: { "model.provider.next": "ctrl+t" },
  })
  assert.deepEqual(remapped.getBindings("model.provider.next"), ["ctrl+t"])
  assert.equal(actionId(remapped.resolve("\t", "modelPickerSearch")), "editor.complete")
  assert.equal(actionId(remapped.resolve("\x14", "modelPickerSearch")), "model.provider.next")
  assert.equal(actionId(remapped.resolve("\x14", "modelPickerList")), "model.provider.next")

  // list navigation overrides still apply in browse mode only.
  const listRemap = mod.createCcKeymap({ bindings: { "list.next": "x" } })
  assert.equal(actionId(listRemap.resolve("x", "modelPickerList")), "list.next")
  assert.equal(listRemap.resolve("x", "modelPickerSearch").kind, "none")

  const arrowRemap = mod.createCcKeymap({
    bindings: { "model.provider.nextArrow": "ctrl+n" },
  })
  assert.equal(actionId(arrowRemap.resolve("\x0e", "modelPickerList")), "model.provider.nextArrow")
  assert.equal(actionId(arrowRemap.resolve("\x1b[C", "modelPickerList")), "editor.move.char-right")

  // Unknown picker action ids are diagnosed like any other action.
  const unknown = mod.createCcKeymap({ bindings: { "model.provider.unknown": "ctrl+q" } })
  assert.ok(unknown.getDiagnostics().some((diagnostic) => diagnostic.code === "unknown-action"))
})

test("picker config remap to a printable key still yields text, never a provider change", () => {
  const { editor, events } = makeEditor({
    bindings: { "app.todo": "j", "editor.move.line-end": "l", "model.provider.next": "g" },
  })
  editor.setContext("modelPickerSearch")
  typeText(editor, "jgl")
  assert.equal(editor.getText(), "jgl")
  assert.deepEqual(events, [], "printable remaps never fire simple-key actions in the query")

  // Tab is no longer provider.next (remapped to 'g') and the generic
  // editor.complete fallback is consumed by the picker: no provider event.
  press(editor, "\t")
  assert.deepEqual(events, [])

  // The remapped provider key is still text in both picker contexts.
  editor.setContext("modelPickerList")
  typeText(editor, "g")
  assert.equal(editor.getText(), "jglg")
  assert.deepEqual(events, [])

  // Outside a picker, disabling/remapping app.todo to 'j' restores the global
  // action: old contexts are untouched by text-first routing.
  const regular = makeEditor({ bindings: { "app.todo": "j" } })
  press(regular.editor, "j")
  assert.deepEqual(actionIds(regular.events), ["app.todo"])
  assert.equal(regular.editor.getText(), "")
})

test("chords stay usable in the picker; printable chord prefixes and mismatches are text", () => {
  const { editor, events, chordPrefixes } = makeEditor({
    bindings: { "model.provider.next": "ctrl+x p" },
  })
  editor.setContext("modelPickerSearch")

  press(editor, "\x18") // Ctrl+X
  assert.deepEqual(editor.getKeymap().getPendingChord(), ["ctrl+x"])
  assert.equal(editor.getText(), "")
  press(editor, "p") // completes the chord, and 'p' is not inserted
  assert.deepEqual(actionIds(events), ["model.provider.next"])
  assert.equal(editor.getText(), "")
  assert.equal(editor.getKeymap().isPendingChord(), false)
  assert.deepEqual(chordPrefixes.at(-1), null)

  // A mismatching printable after a chord prefix is safely re-dispatched as
  // text, even in browse mode (where 'j' would otherwise be list.next).
  editor.setContext("modelPickerList")
  press(editor, "\x18")
  press(editor, "j")
  assert.equal(editor.getKeymap().isPendingChord(), false)
  assert.equal(editor.getText(), "j")
  assert.deepEqual(actionIds(events), ["model.provider.next"])

  // Digit shortcuts are not executed either.
  press(editor, "\x18")
  press(editor, "7")
  assert.equal(editor.getText(), "j7")
  assert.deepEqual(actionIds(events), ["model.provider.next"])
})

test("a configured printable chord cannot swallow query letters in the picker", () => {
  // Raw keymap behaviour is unchanged: a printable can still prefix a chord.
  const rawKeymap = mod.createCcKeymap({ bindings: { "model.provider.next": "j k" } })
  assert.equal(rawKeymap.resolve("j", "modelPickerSearch").kind, "pending")
  rawKeymap.cancelChord()
  assert.equal(rawKeymap.resolve("j", "modelPickerList").kind, "pending")
  rawKeymap.cancelChord()

  // The CcEditor picker path inserts the printable instead of starting it.
  for (const context of ["modelPickerSearch", "modelPickerList"] as const) {
    const { editor, events, chordPrefixes } = makeEditor({
      bindings: { "model.provider.next": "j k" },
    })
    editor.setContext(context)
    typeText(editor, "jk")
    assert.equal(editor.getText(), "jk", context)
    assert.equal(editor.getKeymap().isPendingChord(), false, context)
    assert.deepEqual(events, [], context)
    assert.deepEqual(chordPrefixes, [], context)
  }
})

test("a timed-out chord re-dispatches its printable as query text", async () => {
  const { editor, events } = makeEditor()
  editor.setContext("modelPickerSearch")
  // Start a modifier chord (not printable), let it expire, then type.
  editor.setKeymap(
    mod.createCcKeymap({
      bindings: { "model.provider.next": "ctrl+x p" },
      chordTimeoutMs: 40,
    }),
  )
  press(editor, "\x18")
  assert.equal(editor.getKeymap().isPendingChord(), true)
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(editor.getKeymap().isPendingChord(), false)
  typeText(editor, "j")
  assert.equal(editor.getText(), "j")
  assert.deepEqual(events, [])
  editor.dispose()
})

test("picker text priority covers j/k/digits/spaces from BOTH browse and search focus", () => {
  for (const context of ["modelPickerList", "modelPickerSearch"] as const) {
    const { editor, events } = makeEditor()
    editor.setContext(context)
    typeText(editor, "j k 12 deep")
    assert.equal(editor.getText(), "j k 12 deep", context)
    assert.deepEqual(events, [], `${context}: typed printables must be query text`)

    // Non-printable list navigation still works in browse mode.
    if (context === "modelPickerList") {
      press(editor, "\x1b[A")
      press(editor, "\x1b[B")
      assert.deepEqual(actionIds(events), ["list.previous", "list.next"])
    }
  }
})

test("setContext keeps one editor state: text, cursor, undo, kill ring and pastes", () => {
  const { editor } = makeEditor()
  typeText(editor, "src/utils/foo.ts")
  press(editor, "\x17") // kill the whole path into the kill ring
  typeText(editor, "beta")
  editor.ccSetCursor(0, 2)
  renderAt(editor, 80)

  // Add a large paste marker and make sure the undo stack is non-trivial.
  const content = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n")
  editor.handleInput(`\x1b[200~${content}\x1b[201~`)
  renderAt(editor, 80)
  const before = editor.captureDraft()
  assert.match(editor.getText(), /\[paste #1 \+20 lines\]/)
  assert.deepEqual(editor.ccGetKillRing(), ["src/utils/foo.ts"])

  editor.setContext("modelPickerSearch")
  assert.equal(editor.getContext(), "modelPickerSearch")
  assert.deepEqual(editor.captureDraft(), before, "no text/cursor/undo/kill/paste state may change")
  assert.deepEqual(editor.ccGetKillRing(), ["src/utils/foo.ts"])
  assert.equal(editor.getExpandedText().includes(content), true)

  editor.setContext("modelPickerList")
  assert.equal(editor.getContext(), "modelPickerList")
  assert.deepEqual(editor.captureDraft(), before)

  // Undo history still spans the pre-switch edits.
  press(editor, "\x1f")
  assert.equal(editor.getText(), "beta", "undo reverts the paste insertion after switching")
  press(editor, "\x1f")
  assert.equal(editor.getText(), "", "undo still reaches the pre-switch typing")
  assert.notEqual(editor.getText(), before.text)

  // Alias API remains available for existing callers.
  assert.equal(editor.getActionContext(), "modelPickerList")
  editor.setActionContext("modelPickerSearch")
  assert.equal(editor.getContext(), "modelPickerSearch")
})

test("setContext cancels only this editor's owned pending chord", () => {
  const sharedKeymap = mod.createCcKeymap()
  const first = makeEditor({ keymap: sharedKeymap, context: "modelPickerList" })
  const second = makeEditor({ keymap: sharedKeymap, context: "modelPickerList" })

  press(first.editor, "\x18") // Ctrl+X in the first editor
  assert.equal(sharedKeymap.isPendingChord(), true)

  // A context change in another editor must not disturb the focused chord.
  second.editor.setContext("modelPickerSearch")
  assert.equal(sharedKeymap.isPendingChord(), true)
  press(first.editor, "\x05") // Ctrl+E completes app.editor.external
  assert.deepEqual(actionIds(first.events), ["app.editor.external"])
  assert.equal(sharedKeymap.isPendingChord(), false)

  // The owner cancels its own chord when the context really changes.
  press(first.editor, "\x18")
  assert.equal(sharedKeymap.isPendingChord(), true)
  first.editor.setContext("modelPickerSearch")
  assert.equal(sharedKeymap.isPendingChord(), false)
  assert.deepEqual(first.chordPrefixes.at(-1), null)

  // Same context is a true no-op, including the pending chord.
  press(first.editor, "\x18")
  first.editor.setContext("modelPickerSearch")
  assert.equal(sharedKeymap.isPendingChord(), true)
  first.editor.cancelChord()

  // Non-owned chord in the second editor survives the first editor's change.
  press(second.editor, "\x18")
  first.editor.setContext("modelPickerList")
  assert.equal(sharedKeymap.isPendingChord(), true)
  second.editor.cancelChord()
})

test("Enter/Esc in search mode are list actions, never submit or clear the query", () => {
  const { editor, events } = makeEditor()
  editor.setContext("modelPickerSearch")
  typeText(editor, "deep")
  renderAt(editor, 80)
  const cursor = editor.getCursor()
  let submitted: string | undefined
  editor.onSubmit = (text) => {
    submitted = text
  }

  press(editor, "\r")
  assert.deepEqual(actionIds(events), ["list.select"])
  assert.equal(submitted, undefined, "Enter must not submit/clear the editor in the picker query")
  assert.equal(editor.getText(), "deep")
  assert.deepEqual(editor.getCursor(), cursor)

  press(editor, "\x1b")
  assert.deepEqual(actionIds(events), ["list.select", "list.cancel"])
  assert.equal(editor.getText(), "deep")

  // Enter in browse mode is the same list action; the printable 'j' became
  // query text instead of list.next (text-first picker routing).
  const browse = makeEditor()
  browse.editor.setContext("modelPickerList")
  press(browse.editor, "j")
  press(browse.editor, "\r")
  assert.equal(browse.editor.getText(), "j")
  assert.deepEqual(actionIds(browse.events), ["list.select"])
})

test("default Ctrl+C cancels both picker contexts locally (chord and paste semantics)", () => {
  const search = makeEditor()
  search.editor.setContext("modelPickerSearch")
  typeText(search.editor, "que")
  press(search.editor, "\x03")
  assert.deepEqual(actionIds(search.events), ["list.cancel"])
  assert.equal(search.editor.getText(), "que", "the local cancel does not clear the query")

  const browse = makeEditor()
  browse.editor.setContext("modelPickerList")
  press(browse.editor, "\x03")
  assert.deepEqual(actionIds(browse.events), ["list.cancel"])

  // Pending chord: the keymap drops the prefix and re-dispatches Ctrl+C once.
  const chord = makeEditor()
  chord.editor.setContext("modelPickerSearch")
  press(chord.editor, "\x18")
  press(chord.editor, "\x03")
  assert.equal(chord.editor.getKeymap().isPendingChord(), false)
  assert.deepEqual(actionIds(chord.events), ["list.cancel"])

  // Pasted Ctrl+C bytes are text/paste content, never a cancel key.
  const pasted = makeEditor()
  pasted.editor.setContext("modelPickerSearch")
  pasted.editor.handleInput("\x1b[200~a\x03b\x1b[201~")
  pasted.editor.flushInputBuffer()
  assert.deepEqual(pasted.events, [])
  assert.equal(pasted.editor.getText().includes("a"), true)

  // An explicit interrupt override keeps its priority in the picker contexts.
  const remapped = makeEditor({ bindings: { "app.interrupt": "ctrl+q" } })
  remapped.editor.setContext("modelPickerSearch")
  press(remapped.editor, "\x11")
  press(remapped.editor, "\x03")
  assert.deepEqual(actionIds(remapped.events), ["app.interrupt", "list.cancel"])

  // Disabling the local cancel row never invents a new fallback and never
  // clears hidden root state from the picker (app.clear is root-only).
  const disabled = makeEditor({ bindings: { "list.cancel": null } })
  disabled.editor.setContext("modelPickerSearch")
  press(disabled.editor, "\x03")
  assert.deepEqual(actionIds(disabled.events), [])
})

test("standard readline edits still work inside the picker search field", () => {
  const { editor, events } = makeEditor()
  editor.setContext("modelPickerSearch")
  typeText(editor, "src/utils/foo.ts")
  press(editor, "\x17") // Ctrl+W: whole path
  assert.equal(editor.getText(), "")
  press(editor, "\x19") // Ctrl+Y restores it
  assert.equal(editor.getText(), "src/utils/foo.ts")

  press(editor, "\x1f") // undo the yank
  assert.equal(editor.getText(), "")
  press(editor, "\x1f") // undo the kill
  assert.equal(editor.getText(), "src/utils/foo.ts")

  press(editor, "\x01") // Ctrl+A
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 })
  press(editor, "\x06") // Ctrl+F
  press(editor, "\x06")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 2 })
  press(editor, "\x02") // Ctrl+B
  assert.deepEqual(editor.getCursor(), { line: 0, col: 1 })
  press(editor, "\x05") // Ctrl+E
  assert.deepEqual(editor.getCursor(), { line: 0, col: 16 })

  press(editor, "\x1bb") // Alt+B word left: back over "ts"
  assert.deepEqual(editor.getCursor(), { line: 0, col: 14 })
  press(editor, "\x1bb") // back over the "." separator
  assert.deepEqual(editor.getCursor(), { line: 0, col: 13 })
  press(editor, "\x1bb") // back over "foo"
  assert.deepEqual(editor.getCursor(), { line: 0, col: 10 })
  press(editor, "\x1bf") // Alt+F word right
  assert.deepEqual(editor.getCursor(), { line: 0, col: 13 })
  press(editor, "\x05") // Ctrl+E back to the end for the word kill

  // Word kill vs whitespace kill stay distinct in the query field.
  press(editor, "\x1b\x7f") // Alt+Backspace kills "ts"
  assert.equal(editor.getText().endsWith("foo."), true)
  assert.deepEqual(events, [])

  // Grapheme-safe insertion/deletion.
  const emoji = makeEditor()
  emoji.editor.setContext("modelPickerSearch")
  typeText(emoji.editor, "a👨‍👩‍👧‍👦b")
  press(emoji.editor, "\x7f")
  press(emoji.editor, "\x7f")
  assert.equal(emoji.editor.getText(), "a")

  // Global app actions still work while typing in the query.
  press(editor, "\x12") // Ctrl+R history search
  press(editor, "\x0c") // Ctrl+L redraw
  press(editor, "\x1bp") // Alt+P model picker
  assert.deepEqual(actionIds(events), ["app.history.search", "app.redraw", "app.model.select"])
})

test("fragmented paste in search mode is text and never list navigation", () => {
  const { editor, events } = makeEditor()
  editor.setContext("modelPickerSearch")
  editor.handleInput("\x1b[2")
  editor.handleInput("00~j1 ")
  editor.handleInput("\x1b[20")
  editor.handleInput("1~")
  editor.flushInputBuffer()
  assert.equal(editor.isPasting(), false)
  assert.equal(editor.getText(), "j1 ")
  assert.deepEqual(events, [])
})

test("old contexts do not inherit picker routing", () => {
  const keymap = mod.createCcKeymap()
  // list still owns Ctrl+C and printable selection; editor stays text.
  assert.equal(actionId(keymap.resolve("\x03", "list")), "list.cancel")
  assert.equal(actionId(keymap.resolve("\x03", "dialog")), "dialog.cancel")
  assert.equal(actionId(keymap.resolve("\x03", "editor")), "app.clear")
  assert.equal(actionId(keymap.resolve("j", "list")), "list.next")
  assert.equal(keymap.resolve("j", "editor").kind, "none")
  assert.equal(actionId(keymap.resolve("\t", "editor")), "editor.complete")
  assert.equal(actionId(keymap.resolve("\x1b[Z", "editor")), "app.mode.cycle")
  assert.equal(actionId(keymap.resolve("\x1b[D", "editor")), "editor.move.char-left")

  // Editor-level text priority is not applied outside modelPickerSearch.
  const editorContext = makeEditor({ bindings: { "app.todo": "j" } })
  typeText(editorContext.editor, "j")
  assert.equal(editorContext.editor.getText(), "")
  assert.deepEqual(actionIds(editorContext.events), ["app.todo"])
})

test("printableInput helper decodes text without touching editor state", () => {
  assert.equal(mod.printableInput("j"), "j")
  assert.equal(mod.printableInput("hi"), "hi")
  assert.equal(mod.printableInput(" "), " ")
  assert.equal(mod.printableInput("你"), "你")
  assert.equal(mod.printableInput("\x1b[106u"), "j", "plain Kitty CSI-u text")
  assert.equal(mod.printableInput("\x1b[106:74;2u"), "J", "shifted Kitty CSI-u text")
  assert.equal(mod.printableInput("\x1b[106;5u"), undefined, "Ctrl+J is a control key")
  assert.equal(mod.printableInput("\x1b[106;3u"), undefined, "Alt+J is a modifier key")
  assert.equal(mod.printableInput("\x1b"), undefined)
  assert.equal(mod.printableInput("\x1b[2~"), undefined)
  assert.equal(mod.printableInput("\r"), undefined)
  assert.equal(mod.printableInput("\t"), undefined)
  assert.equal(mod.printableInput("\x7f"), undefined)
  assert.equal(mod.printableInput(""), undefined)
})

test("picker actions are registered for the grouped /settings list", () => {
  const byId = new Map(mod.CC_ACTIONS.map((action) => [action.id, action]))
  const previous = byId.get("model.provider.previous")
  const next = byId.get("model.provider.next")
  const previousArrow = byId.get("model.provider.previousArrow")
  const nextArrow = byId.get("model.provider.nextArrow")
  for (const action of [previous, next, previousArrow, nextArrow]) {
    assert.ok(action, "picker action missing from CC_ACTIONS")
    assert.equal(action.implementor, "app")
    assert.equal(action.family, "list")
    assert.equal(action.status, "cc-app-override")
  }
  assert.deepEqual(previous?.defaultBindings, ["shift+tab"])
  assert.deepEqual(previous?.contexts, ["modelPickerList", "modelPickerSearch"])
  assert.deepEqual(next?.defaultBindings, ["tab"])
  assert.deepEqual(next?.contexts, ["modelPickerList", "modelPickerSearch"])
  assert.deepEqual(previousArrow?.defaultBindings, ["left"])
  assert.deepEqual(previousArrow?.contexts, ["modelPickerList"])
  assert.deepEqual(nextArrow?.defaultBindings, ["right"])
  assert.deepEqual(nextArrow?.contexts, ["modelPickerList"])

  // getActions() feeds the existing Settings rows; both modes are covered.
  const keymap = mod.createCcKeymap()
  const pickerActions = keymap
    .getActions()
    .filter((action) => action.id.startsWith("model.provider."))
    .map((action) => action.id)
  assert.deepEqual(pickerActions.sort(), [
    "model.provider.next",
    "model.provider.nextArrow",
    "model.provider.previous",
    "model.provider.previousArrow",
  ])
  assert.ok(keymap.getHelp().some((row) => row.action === "model.provider.next" && row.keysLabel === "Tab"))
  assert.ok(keymap.getHelp().some((row) => row.action === "model.provider.previous" && row.keysLabel === "Shift+Tab"))
})