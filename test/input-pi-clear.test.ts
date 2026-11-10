/**
 * Pi-style Ctrl+C clear / explicit native interrupt split (focused regressions).
 *
 * Chosen policy: installed Pi 1.5.1 CustomEditor checks Ctrl+C before base
 * autocomplete handling, clears the whole root draft, and treats a second press
 * within 500 ms as exit. That is NOT a current-CC match (CC Ctrl+C cancels).
 * This file pins the input-layer half only: the App owns the draft replacement
 * and the 500 ms exit arm. No App/UI/provider/session/credential access.
 *
 * Also pins the explicitly configurable native interrupt (empty default) and
 * the dialog-local `dialog.details` (Ctrl+O) row.
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
import type {
  CcActionEvent,
  CcContext,
  CcEditorOptions,
  CcKeyResolution,
} from "../src/input/index.ts"
import type { AutocompleteProvider } from "#pi-tui"

const mod = await loadInputModule()
const { createCcKeymap } = mod

function actionId(keymap: InstanceType<typeof mod.CcKeymap>, data: string, context: CcContext): string | undefined {
  keymap.cancelChord()
  const resolution = keymap.resolve(data, context)
  return resolution.kind === "action" ? resolution.action.id : undefined
}

function resolution(keymap: InstanceType<typeof mod.CcKeymap>, data: string, context: CcContext): CcKeyResolution {
  return keymap.resolve(data, context)
}

function actionIds(events: readonly CcActionEvent[]): string[] {
  return events.map((event) => event.id)
}

function makeEditor(options: CcEditorOptions = {}) {
  const tui = createFakeTui()
  const editor = new mod.CcEditor(asTui(tui), testEditorTheme, options)
  const events: CcActionEvent[] = []
  const chordPrefixes: Array<readonly string[] | null> = []
  editor.onAction = (event) => {
    events.push(event)
  }
  editor.onChordChange = prefix => { chordPrefixes.push(prefix === null ? null : [...prefix]) }
  renderAt(editor, 80)
  return { editor, tui, events, chordPrefixes }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function autocompleteProvider(): AutocompleteProvider {
  return {
    triggerCharacters: ["@"],
    async getSuggestions() {
      return { items: [{ value: "@alpha", label: "@alpha" }], prefix: "@" }
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const line = lines[cursorLine] ?? ""
      const start = cursorCol - prefix.length
      return {
        lines: [line.slice(0, start) + item.value + line.slice(cursorCol)],
        cursorLine,
        cursorCol: start + item.value.length,
      }
    },
  }
}

// --- registry defaults -------------------------------------------------

test("app.clear ships on Ctrl+C; app.interrupt ships unbound; Esc stays app.cancel", () => {
  const clear = mod.CC_ACTIONS_BY_ID.get("app.clear")
  const interrupt = mod.CC_ACTIONS_BY_ID.get("app.interrupt")
  const cancel = mod.CC_ACTIONS_BY_ID.get("app.cancel")
  assert.ok(clear && interrupt && cancel)
  assert.deepEqual(clear.defaultBindings, ["ctrl+c"])
  assert.deepEqual(clear.contexts, ["global"])
  assert.equal(clear.implementor, "app")
  assert.equal(clear.status, "pi-extension")
  assert.match(clear.note ?? "", /not a current-CC match/)
  assert.match(clear.note ?? "", /500 ms/)
  assert.deepEqual(interrupt.defaultBindings, [])
  assert.equal(interrupt.status, "tui-extension")
  assert.match(interrupt.note ?? "", /old Ctrl\+C default moved to app\.clear/)
  assert.deepEqual(cancel.defaultBindings, ["escape"])

  // Ctrl+C is not a completion cancel: Esc is the only completion cancel.
  assert.deepEqual(mod.CC_ACTIONS_BY_ID.get("autocomplete.cancel")?.defaultBindings, ["escape"])

  const keymap = createCcKeymap({ platform: "posix" })
  assert.deepEqual(keymap.getBindings("app.clear"), ["ctrl+c"])
  assert.deepEqual(keymap.getBindings("app.interrupt"), [])
  assert.equal(actionId(keymap, "\x03", "editor"), "app.clear")
  assert.equal(actionId(keymap, "\x1b", "editor"), "editor.cancel")
  assert.deepEqual(keymap.getConflicts(), [], "the shipped split has no conflict")
})

test("dialog.details ships on Ctrl+O in dialog/modalList and nowhere root-global", () => {
  const action = mod.CC_ACTIONS_BY_ID.get("dialog.details")
  assert.ok(action)
  assert.deepEqual(action.defaultBindings, ["ctrl+o"])
  assert.deepEqual(action.contexts, ["dialog", "modalList"])
  assert.equal(action.status, "tui-extension")
  assert.equal(action.implementor, "app")

  const keymap = createCcKeymap({ platform: "posix" })
  assert.equal(actionId(keymap, "\x0f", "dialog"), "dialog.details")
  assert.equal(actionId(keymap, "\x0f", "modalList"), "dialog.details")
  // Modal chains that include the dialog layer show the same row.
  for (const context of ["settingsList", "keybindingsList", "queueList", "toolDetails", "subagentList"] as const) {
    assert.equal(actionId(keymap, "\x0f", context), "dialog.details", context)
  }
  // The root prompt keeps the CC tool-expand action.
  assert.equal(actionId(keymap, "\x0f", "editor"), "app.tools.expand")
  assert.deepEqual(keymap.getConflicts(), [])
})

// --- raw / Kitty / modifyOtherKeys / release / repeat / paste ----------

test("raw, Kitty CSI-u and xterm modifyOtherKeys Ctrl+C all resolve to the same clear action", () => {
  const keymap = createCcKeymap({ platform: "posix" })
  for (const data of ["\x03", "\x1b[99;5u", "\x1b[27;5;99~"]) {
    assert.equal(actionId(keymap, data, "editor"), "app.clear", JSON.stringify(data))
  }
  // The keymap maps Kitty press/repeat/release sequences; CcEditor is the
  // layer that refuses release/repeat dispatch (next test).
  assert.equal(actionId(keymap, "\x1b[99;5:2u", "editor"), "app.clear")
  assert.equal(actionId(keymap, "\x1b[99;5:3u", "editor"), "app.clear")
})

test("CcEditor emits one clear for press encodings, none for Kitty release/repeat", () => {
  for (const data of ["\x03", "\x1b[99;5u", "\x1b[27;5;99~"]) {
    const { editor, events } = makeEditor()
    editor.setText("draft")
    press(editor, data)
    assert.deepEqual(actionIds(events), ["app.clear"], JSON.stringify(data))
    assert.equal(events[0]?.key, data)
    assert.equal(events[0]?.empty, false)
  }

  // A held Ctrl+C repeat is one physical press for exit policy.
  const repeat = makeEditor()
  repeat.editor.setText("draft")
  press(repeat.editor, "\x1b[99;5:2u")
  assert.deepEqual(actionIds(repeat.events), [], "repeat never arms a second exit")
  assert.equal(repeat.editor.getText(), "draft", "input layer never rewrites the draft")

  // A release after a press is not a second press either.
  const release = makeEditor()
  release.editor.setText("draft")
  press(release.editor, "\x1b[99;5u")
  press(release.editor, "\x1b[99;5:3u")
  assert.deepEqual(actionIds(release.events), ["app.clear"])
  assert.equal(release.editor.getKeymap().isPendingChord(), false)
  assert.equal(release.editor.ccGetJumpMode(), null)
})

test("bracketed paste treats Ctrl+C bytes as content, never as clear", () => {
  const { editor, events } = makeEditor()
  editor.setText("keep")
  editor.handleInput("\x1b[200~a\x03b\x1b[201~")
  editor.flushInputBuffer()
  assert.deepEqual(actionIds(events), [])
  assert.equal(editor.getExpandedText(), "keepab", "pasted control byte is content, never a key")

  // A fragmented paste whose bytes look like a Kitty repeat/release marker is
  // still content: it cannot suppress or arm anything.
  const fragmented = makeEditor()
  fragmented.editor.handleInput("\x1b[20")
  fragmented.editor.handleInput("0~x\x03y\x1b[201~")
  fragmented.editor.flushInputBuffer()
  assert.deepEqual(actionIds(fragmented.events), [])
  assert.equal(fragmented.editor.getExpandedText(), "xy")
})

// --- once per physical press: chord / jump / autocomplete -------------

test("Ctrl+C clears once through a pending chord and jump mode", () => {
  const chord = makeEditor()
  press(chord.editor, "\x18") // Ctrl+X pending
  assert.equal(chord.editor.getKeymap().isPendingChord(), true)
  assert.deepEqual(chord.chordPrefixes.at(-1), ["ctrl+x"], "the actual hint observed the prefix")
  press(chord.editor, "\x03")
  assert.equal(chord.editor.getKeymap().isPendingChord(), false)
  assert.deepEqual(actionIds(chord.events), ["app.clear"], "prefix dropped, clear fired once")
  assert.equal(chord.chordPrefixes.at(-1), null, "the actual prefix hint was retired")

  const jump = makeEditor()
  press(jump.editor, "\x1d") // jump mode
  assert.equal(jump.editor.ccGetJumpMode(), "forward")
  press(jump.editor, "\x03")
  assert.equal(jump.editor.ccGetJumpMode(), null)
  assert.deepEqual(actionIds(jump.events), ["app.clear"], "jump cancel plus clear is one action")
})

test("Ctrl+C while completion is open clears the whole draft once and closes the menu", async () => {
  const { editor, events } = makeEditor()
  editor.setAutocompleteProvider(autocompleteProvider())
  typeText(editor, "@al")
  await sleep(60)
  assert.equal(editor.isShowingAutocomplete(), true)

  press(editor, "\x03")
  assert.deepEqual(actionIds(events), ["app.clear"], "Pi checks clear before completion handling")
  assert.notEqual(events[0]?.id, "autocomplete.cancel")
  assert.equal(editor.isShowingAutocomplete(), false, "the stale menu closes naturally")

  // Esc remains the local completion-only cancel.
  events.length = 0
  typeText(editor, "@al")
  await sleep(60)
  assert.equal(editor.isShowingAutocomplete(), true)
  press(editor, "\x1b")
  assert.equal(editor.isShowingAutocomplete(), false)
  assert.deepEqual(actionIds(events), [], "Esc never forwards app.clear/app.cancel here")
})

// --- clear remap / disable / reset ------------------------------------

test("app.clear remap, disable and reset are explicit and never resurrect Pi defaults", () => {
  const remapped = createCcKeymap({ platform: "posix", bindings: { "app.clear": "alt+c" } })
  assert.deepEqual(remapped.getBindings("app.clear"), ["alt+c"])
  assert.equal(actionId(remapped, "\x1bc", "editor"), "app.clear")
  assert.equal(resolution(remapped, "\x03", "editor").kind, "none", "old Ctrl+C is inert, not a Pi fallback")

  const disabled = createCcKeymap({ platform: "posix", bindings: { "app.clear": null } })
  assert.deepEqual(disabled.getBindings("app.clear"), [])
  assert.equal(resolution(disabled, "\x03", "editor").kind, "none")
  const disabledEditor = makeEditor({ bindings: { "app.clear": null } })
  press(disabledEditor.editor, "\x03")
  assert.deepEqual(actionIds(disabledEditor.events), [], "a disabled clear never falls through")

  // Deleting the one override restores the effective default.
  remapped.setBindings({})
  assert.deepEqual(remapped.getBindings("app.clear"), ["ctrl+c"])
  assert.equal(actionId(remapped, "\x03", "editor"), "app.clear")
})

test("dialog.details remap, disable and reset are explicit; Ctrl+O falls back to tool expand", () => {
  const remapped = createCcKeymap({ platform: "posix", bindings: { "dialog.details": "alt+d" } })
  assert.deepEqual(remapped.getBindings("dialog.details"), ["alt+d"])
  assert.equal(actionId(remapped, "\x1bd", "dialog"), "dialog.details")
  assert.equal(actionId(remapped, "\x0f", "dialog"), "app.tools.expand", "old Ctrl+O is the shipped global fallback")

  const disabled = createCcKeymap({ platform: "posix", bindings: { "dialog.details": null } })
  assert.deepEqual(disabled.getBindings("dialog.details"), [])
  assert.equal(actionId(disabled, "\x0f", "dialog"), "app.tools.expand")

  remapped.setBindings({})
  assert.deepEqual(remapped.getBindings("dialog.details"), ["ctrl+o"])
  assert.equal(actionId(remapped, "\x0f", "modalList"), "dialog.details")
})

// --- explicit interrupt -------------------------------------------------

test("an explicit Ctrl+C interrupt is reported, keeps intent and is never rewritten", () => {
  const keymap = createCcKeymap({ platform: "posix", bindings: { "app.interrupt": "ctrl+c" } })
  // The clear default is untouched; the collision is visible.
  assert.deepEqual(keymap.getBindings("app.clear"), ["ctrl+c"])
  assert.deepEqual(keymap.getBindings("app.interrupt"), ["ctrl+c"])
  const conflict = keymap.getConflicts().find(
    (diagnostic) => diagnostic.code === "conflict" && diagnostic.keys === "ctrl+c" &&
      diagnostic.action === "app.clear" && diagnostic.otherAction === "app.interrupt",
  )
  assert.ok(conflict, "the old interrupt override colliding with the clear default is reported")
  assert.equal(conflict.context, "global")

  // Explicit intent wins in the root prompt and in the priority modal contexts.
  assert.equal(actionId(keymap, "\x03", "editor"), "app.interrupt")
  assert.equal(actionId(keymap, "\x03", "settingsList"), "app.interrupt")
  assert.equal(actionId(keymap, "\x03", "toolDetails"), "app.interrupt")
  // Outside the priority rule, local cancel still wins first.
  assert.equal(actionId(keymap, "\x03", "list"), "list.cancel")
  assert.equal(actionId(keymap, "\x03", "dialog"), "dialog.cancel")
})

test("a remapped explicit interrupt keeps priority without stealing default clear", () => {
  const keymap = createCcKeymap({ platform: "posix", bindings: { "app.interrupt": "alt+q" } })
  assert.deepEqual(keymap.getBindings("app.clear"), ["ctrl+c"])
  assert.equal(actionId(keymap, "\x1bq", "settingsList"), "app.interrupt")
  assert.equal(actionId(keymap, "\x03", "settingsList"), "list.cancel")
  assert.equal(actionId(keymap, "\x03", "editor"), "app.clear")

  const explicit = makeEditor({ bindings: { "app.interrupt": "alt+q" } })
  press(explicit.editor, "\x18") // pending chord
  press(explicit.editor, "\x1bq")
  assert.deepEqual(actionIds(explicit.events), ["app.interrupt"])
  assert.equal(explicit.editor.getKeymap().isPendingChord(), false)

  explicit.events.length = 0
  press(explicit.editor, "\x03")
  assert.deepEqual(actionIds(explicit.events), ["app.clear"], "clear stays on its own key")
})

// --- no hidden-root action / no phantom surface action ----------------

test("disabled history-search cancel fails closed instead of resurrecting global clear", () => {
  const keymap = createCcKeymap({ platform: "posix", bindings: { "historySearch.cancel": null } })
  // The resolver would reach the global clear fallback...
  assert.equal(actionId(keymap, "\x03", "historySearch"), "app.clear")

  // ...but the input layer refuses the hidden root clear.
  const { editor, events } = makeEditor({ context: "historySearch", bindings: { "historySearch.cancel": null } })
  editor.setText("search draft")
  const before = editor.captureDraft()
  press(editor, "\x03")
  assert.deepEqual(actionIds(events), [], "no hidden-root clear and no invented search cancel")
  assert.deepEqual(editor.captureDraft(), before)

  // The default still cancels/restores the search even while the root is busy.
  const normal = makeEditor({ context: "historySearch" })
  press(normal.editor, "\x03")
  assert.deepEqual(actionIds(normal.events), ["historySearch.cancel"])
})

test("disabling local cancel rows never emits clear from a surface context", () => {
  const cases: Array<{ context: CcContext; bindings: Record<string, null> }> = [
    { context: "settingsList", bindings: { "list.cancel": null, "dialog.cancel": null } },
    { context: "modalSearch", bindings: { "dialog.cancel": null } },
    { context: "modelPickerSearch", bindings: { "list.cancel": null } },
    { context: "toolDetails", bindings: { "list.cancel": null, "dialog.cancel": null } },
  ]
  for (const item of cases) {
    const { editor, events } = makeEditor({ context: item.context, bindings: item.bindings })
    editor.setText("keep")
    const before = editor.captureDraft()
    press(editor, "\x03")
    assert.deepEqual(actionIds(events), [], `${item.context}: no phantom action and no hidden clear`)
    assert.deepEqual(editor.captureDraft(), before, `${item.context}: draft untouched`)
  }
})

test("two separate physical Ctrl+C presses reach the App twice (500 ms timing is App-owned)", () => {
  const { editor, events } = makeEditor()
  editor.setText("draft")
  press(editor, "\x03")
  press(editor, "\x03")
  assert.deepEqual(actionIds(events), ["app.clear", "app.clear"])
  // The input layer never measures time or mutates the draft: the App's
  // clear/exit arm decides whether the second press exits.
  assert.equal(editor.getText(), "draft")
})
