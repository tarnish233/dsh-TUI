/**
 * Native Agents overlay input contract, offline only.
 *
 * Two contexts (`subagentList`, `subagentSession`) reuse the shared list,
 * dialog and global app keys; there is no editor fallback. They add exactly
 * two overlay-local app actions, `subagent.reply` (`r`) and
 * `subagent.interrupt` (`s`), plus the global chord `app.subagents.details`
 * that opens the overlay. No terminal, backend, model or DSH process is
 * involved: raw terminal bytes go through the shared `CcKeymap` or one Pi
 * editor state, and the input layer only resolves/emits actions.
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
import type { CcActionDefinition, CcActionEvent, CcContext, CcEditorOptions } from "../src/input/index.ts"

const mod = await loadInputModule()
type TestEditor = InstanceType<typeof mod.CcEditor>
type TestKeymap = InstanceType<typeof mod.CcKeymap>

const SUBAGENT_CONTEXTS = ["subagentList", "subagentSession"] as const

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

function actionId(keymap: TestKeymap, data: string, context: CcContext, now?: number): string | undefined {
  const resolution = now === undefined ? keymap.resolve(data, context) : keymap.resolve(data, context, now)
  return resolution.kind === "action" ? resolution.action.id : undefined
}

function actionIds(events: readonly CcActionEvent[]): string[] {
  return events.map((event) => event.id)
}

function assertPending(keymap: TestKeymap, data: string, context: CcContext, now?: number): void {
  const resolution = now === undefined ? keymap.resolve(data, context) : keymap.resolve(data, context, now)
  assert.equal(resolution.kind, "pending")
}

// --- contract -----------------------------------------------------------

test("subagent contexts and fallback chains match the read-only contract", () => {
  const { CC_CONTEXTS, CC_ACTIONS_BY_ID, createCcKeymap } = mod
  for (const context of SUBAGENT_CONTEXTS) assert.ok(CC_CONTEXTS.includes(context), context)

  const keymap = createCcKeymap({ platform: "posix" })
  for (const context of SUBAGENT_CONTEXTS) {
    assert.deepEqual(keymap.getFallbackChain(context), [context, "list", "dialog", "global"])
    assert.equal(keymap.getFallbackChain(context).includes("editor"), false, "no editor fallback")
    assert.deepEqual(
      keymap.getActions(context).map((action) => action.id),
      ["subagent.reply", "subagent.interrupt"],
      `${context} adds only its two overlay-local actions; list.*, dialog.* and global app keys are reused`,
    )
  }
  // A returned chain is a copy, not internal state.
  keymap.getFallbackChain("subagentList").push("editor")
  assert.deepEqual(keymap.getFallbackChain("subagentList"), ["subagentList", "list", "dialog", "global"])

  // Existing chains are untouched.
  assert.deepEqual(keymap.getFallbackChain("editor"), ["editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("autocomplete"), ["autocomplete", "editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("historySearch"), ["historySearch", "editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("dialog"), ["dialog", "editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("list"), ["list", "global"])
  assert.deepEqual(keymap.getFallbackChain("modelPickerList"), ["modelPickerList", "list", "editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("modelPickerSearch"), ["modelPickerSearch", "editor", "global"])
  assert.deepEqual(keymap.getFallbackChain("toolDetails"), ["toolDetails", "list", "dialog", "global"])
  assert.deepEqual(keymap.getFallbackChain("imageDetails"), ["imageDetails", "list", "dialog", "global"])
  assert.deepEqual(keymap.getFallbackChain("global"), ["global"])

  const opening = CC_ACTIONS_BY_ID.get("app.subagents.details")
  assert.ok(opening, "app.subagents.details is registered")
  assert.equal(opening.family, "app")
  assert.deepEqual(opening.contexts, ["global"])
  assert.deepEqual(opening.defaultBindings, ["ctrl+x ctrl+a"])
  assert.equal(opening.implementor, "app")
  assert.equal(opening.status, "tui-extension", "marked as this TUI's own capability")
  assert.equal(opening.description, "Open the native Agents overlay")
  assert.match(opening.note ?? "", /not a verified CC default/)
})

test("the new chord is unique and appears in the one grouped shortcut list", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  assert.equal(keymap.getDiagnostics().some((diagnostic) => diagnostic.severity === "error"), false)
  assert.deepEqual(keymap.getConflicts().filter((diagnostic) => diagnostic.context === "global"), [])

  // The chord's second key is not reused by another default chord, and Ctrl+X
  // itself is not a competing single-key global binding.
  const chords = mod.CC_ACTIONS.flatMap((action) =>
    [...action.defaultBindings, ...(action.platformBindings?.posix ?? [])]
      .map((spec) => mod.parseBindingSpec(spec))
      .filter((keys): keys is string[] => keys !== undefined && keys.length > 1)
      .map((keys) => ({ id: action.id, sequence: keys.join(" ") })),
  )
  const matching = chords.filter((entry) => entry.sequence === "ctrl+x ctrl+a")
  assert.deepEqual(matching.map((entry) => entry.id), ["app.subagents.details"])
  assertPending(keymap, "\x18", "global")

  // The App supplies prompt-mode bindings on top of the registry. The new
  // chord must not collide with those either.
  const promptMode = mod.createCcKeymap({
    platform: "posix",
    bindings: {
      "app.message.sendNow": ["ctrl+enter"],
      "app.message.steer": ["ctrl+x ctrl+s"],
      "app.message.followUp": ["ctrl+x enter"],
    },
  })
  assert.equal(promptMode.getDiagnostics().some((diagnostic) => diagnostic.severity === "error"), false)
  assert.deepEqual(promptMode.getConflicts().filter((diagnostic) => diagnostic.context === "global"), [])
  assert.deepEqual(promptMode.getBindings("app.subagents.details"), ["ctrl+x ctrl+a"])
  assertPending(promptMode, "\x18", "editor", 1_000)
  assert.equal(actionId(promptMode, "\x01", "editor", 1_010), "app.subagents.details")
  promptMode.cancelChord()
  assertPending(promptMode, "\x18", "editor", 2_000)
  assert.equal(actionId(promptMode, "\x13", "editor", 2_010), "app.message.steer", "existing chord untouched")

  // One grouped Settings list: the action is a normal registry row; no
  // standalone hotkeys panel or subagent-specific config exists.
  const listed = keymap.getActions().filter((action) => action.id === "app.subagents.details")
  assert.equal(listed.length, 1)
  const help = keymap.getHelp()
  assert.ok(
    help.some(
      (row) =>
        row.action === "app.subagents.details" &&
        row.keysLabel === "Ctrl+X Ctrl+A" &&
        row.description === "Open the native Agents overlay" &&
        row.status === "tui-extension",
    ),
  )
})

// --- overlay-local reply / interrupt actions -----------------------------

test("subagent.reply and subagent.interrupt are overlay-local configurable actions", () => {
  const { CC_ACTIONS_BY_ID, createCcKeymap } = mod
  const expected = [
    { id: "subagent.reply", defaultBindings: ["r"], description: "Reply to the focused native subagent" },
    {
      id: "subagent.interrupt",
      defaultBindings: ["s"],
      description: "Interrupt (stop) the focused native subagent",
    },
  ] as const
  for (const item of expected) {
    const action = CC_ACTIONS_BY_ID.get(item.id)
    assert.ok(action, `${item.id} is registered`)
    assert.equal(action.family, "dialog", "modal-local family keeps it in the Lists & dialogs Settings group")
    assert.deepEqual(action.contexts, [...SUBAGENT_CONTEXTS])
    assert.deepEqual(action.defaultBindings, [...item.defaultBindings])
    assert.equal(action.implementor, "app")
    assert.equal(action.status, "tui-extension")
    assert.equal(action.description, item.description)
    assert.match(action.note ?? "", /not a verified CC default/)
  }

  const keymap = createCcKeymap({ platform: "posix" })
  for (const context of SUBAGENT_CONTEXTS) {
    assert.equal(actionId(keymap, "r", context), "subagent.reply")
    assert.equal(actionId(keymap, "s", context), "subagent.interrupt")
    // The existing globals are untouched by the overlay-local keys.
    assert.equal(actionId(keymap, "\x03", context), "app.interrupt", "Ctrl+C stays global interrupt")
    assert.equal(actionId(keymap, "\x04", context), "app.exit", "Ctrl+D stays global exit")
    assert.equal(actionId(keymap, "\x1b", context), "list.cancel", "Esc still closes the surface")
  }

  // Editor/global/list/dialog/details surfaces do not gain plain r/s, so the
  // root prompt keeps inserting them and no global fallback exists.
  for (const context of [
    "editor",
    "autocomplete",
    "list",
    "dialog",
    "historySearch",
    "modelPickerList",
    "modelPickerSearch",
    "toolDetails",
    "imageDetails",
    "global",
  ] as const) {
    assert.equal(
      keymap.getActions(context).some((action) => action.id === "subagent.reply" || action.id === "subagent.interrupt"),
      false,
      `${context} does not expose the overlay actions`,
    )
    assert.equal(keymap.resolve("r", context).kind, "none", `${context}: plain r is unbound`)
    assert.equal(keymap.resolve("s", context).kind, "none", `${context}: plain s is unbound`)
  }

  // Existing Ctrl+R / Ctrl+S app overrides keep their own keys.
  assert.equal(actionId(keymap, "\x12", "editor"), "app.history.search")
  assert.equal(actionId(keymap, "\x13", "editor"), "app.stash")

  const subagentConflictContexts = new Set<string>(SUBAGENT_CONTEXTS)
  assert.deepEqual(
    keymap.getConflicts().filter((diagnostic) => diagnostic.context !== undefined && subagentConflictContexts.has(diagnostic.context)),
    [],
  )
})

test("both overlay actions appear once in the single grouped Settings shortcut list", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  const listed = keymap.getActions().filter((action) => action.id.startsWith("subagent."))
  assert.deepEqual(
    listed.map((action) => action.id),
    ["subagent.reply", "subagent.interrupt"],
    "one registry row each; no separate hotkeys panel or subagent config",
  )
  for (const context of SUBAGENT_CONTEXTS) {
    assert.deepEqual(
      keymap.getHelp(context).map((row) => row.action),
      ["subagent.reply", "subagent.interrupt"],
    )
  }
  const help = keymap.getHelp()
  const reply = help.find((row) => row.action === "subagent.reply")
  const interrupt = help.find((row) => row.action === "subagent.interrupt")
  assert.equal(reply?.keysLabel, "R")
  assert.equal(reply?.status, "tui-extension")
  assert.equal(interrupt?.keysLabel, "S")
  assert.equal(interrupt?.status, "tui-extension")

  // A remap is reflected in the same row.
  keymap.setBindings({ "subagent.reply": "y" })
  assert.equal(keymap.getHelp().find((row) => row.action === "subagent.reply")?.keysLabel, "Y")

  // A disabled action keeps its Settings row (the dialog lists actions, not
  // only bound keys) but advertises no dead key.
  keymap.setBindings({ "subagent.reply": null })
  assert.ok(keymap.getActions().some((action) => action.id === "subagent.reply"))
  assert.deepEqual(
    keymap.getHelp("subagentList").map((row) => row.action),
    ["subagent.interrupt"],
  )

  // Deleting the override (reset) restores the default in the same list.
  keymap.setBindings({})
  assert.equal(keymap.getHelp().find((row) => row.action === "subagent.reply")?.keysLabel, "R")
})

test("plain r/s in the root editor insert text and emit no overlay action", () => {
  const { editor, events } = makeEditor()
  typeText(editor, "rs")
  press(editor, "r", "s")
  assert.equal(editor.getText(), "rsrs")
  assert.deepEqual(actionIds(events), [])

  // The existing Ctrl+R / Ctrl+S app overrides are untouched.
  press(editor, "\x12", "\x13")
  assert.deepEqual(actionIds(events), ["app.history.search", "app.stash"])
  assert.equal(editor.getText(), "rsrs")
})

test("r/s on a read-only subagent surface emit only the overlay action", () => {
  for (const context of SUBAGENT_CONTEXTS) {
    const { editor, events } = makeEditor({ context })
    editor.setText("hidden draft")
    editor.ccSetCursor(0, "hidden draft".length)
    const before = editor.captureDraft()

    press(editor, "r", "s")
    assert.deepEqual(actionIds(events), ["subagent.reply", "subagent.interrupt"])
    assert.deepEqual(events.map((event) => event.context), [context, context])
    assert.deepEqual(events.map((event) => event.key), ["r", "s"])
    assert.equal(events[0]?.definition?.id, "subagent.reply")
    assert.equal(events[1]?.definition?.id, "subagent.interrupt")
    assert.equal(editor.getText(), "hidden draft", `${context}: no text is inserted`)
    assert.deepEqual(editor.captureDraft(), before, `${context}: the hidden draft is untouched`)
    assert.equal(editor.getKeymap().isPendingChord(), false)

    // Without an onAction callback the input layer still only resolves the
    // action: no text edit, no submit and no fabricated backend effect.
    const silent = makeEditor({ context })
    silent.editor.onAction = undefined
    silent.editor.setText("hidden draft")
    press(silent.editor, "r", "s")
    assert.equal(silent.editor.getText(), "hidden draft")
    assert.deepEqual(actionIds(silent.events), [])

    // Other plain bytes stay inert: only the two registered keys act.
    typeText(silent.editor, "xy")
    assert.equal(silent.editor.getText(), "hidden draft")
    assert.deepEqual(actionIds(silent.events), [])
  }
})

test("overlay actions keep conflict and pending-chord semantics", () => {
  const conflicted = mod.createCcKeymap({ platform: "posix", bindings: { "subagent.reply": "s" } })
  const conflicts = conflicted.getConflicts()
  for (const context of SUBAGENT_CONTEXTS) {
    assert.ok(
      conflicts.some(
        (diagnostic) =>
          diagnostic.code === "conflict" &&
          diagnostic.context === context &&
          diagnostic.keys === "s" &&
          (diagnostic.action === "subagent.reply" || diagnostic.action === "subagent.interrupt"),
      ),
      `${context}: a duplicate overlay key is reported in the one keymap`,
    )
    assert.equal(actionId(conflicted, "s", context), "subagent.reply", "the first registry definition wins")
  }

  const chorded = mod.createCcKeymap({ platform: "posix", bindings: { "subagent.reply": "ctrl+x r" } })
  for (const context of SUBAGENT_CONTEXTS) {
    chorded.cancelChord()
    assertPending(chorded, "\x18", context, 1_000)
    assert.equal(actionId(chorded, "r", context, 1_010), "subagent.reply")
    assert.equal(chorded.isPendingChord(), false)
    assert.equal(actionId(chorded, "s", context), "subagent.interrupt")

    // A non-matching second key cancels the chord and is re-dispatched fresh:
    // plain `s` then reaches subagent.interrupt, never the remapped reply action.
    assertPending(chorded, "\x18", context, 2_000)
    const mismatch = chorded.resolve("s", context, 2_010)
    assert.equal(mismatch.kind, "cancelled-chord")
    assert.equal(mismatch.kind === "cancelled-chord" ? mismatch.passthrough : "", "s")
    assert.equal(actionId(chorded, "s", context), "subagent.interrupt")

    // Ctrl+C keeps interrupt priority over the overlay chord.
    assertPending(chorded, "\x18", context, 3_000)
    assert.equal(actionId(chorded, "\x03", context, 3_010), "app.interrupt")
    assert.equal(chorded.isPendingChord(), false)

    // The reply chord still works afterwards.
    assertPending(chorded, "\x18", context, 4_000)
    assert.equal(actionId(chorded, "r", context, 4_010), "subagent.reply")
  }
})

test("subagent.reply and subagent.interrupt can be remapped, disabled and reset", () => {
  const remapped = mod.createCcKeymap({
    platform: "posix",
    bindings: { "subagent.reply": "y", "subagent.interrupt": "ctrl+x s" },
  })
  for (const context of SUBAGENT_CONTEXTS) {
    assert.equal(actionId(remapped, "y", context), "subagent.reply")
    assert.equal(remapped.resolve("r", context).kind, "none", "the old reply key is inert")
    assert.equal(remapped.resolve("s", context).kind, "none", "the old stop key is inert")
    remapped.cancelChord()
    assertPending(remapped, "\x18", context, 1_000)
    assert.equal(actionId(remapped, "s", context, 1_010), "subagent.interrupt")
    assert.equal(remapped.isPendingChord(), false)
  }

  // A subagent-only remap never changes the root editor.
  const editorCase = makeEditor({ bindings: { "subagent.reply": "y", "subagent.interrupt": "ctrl+x s" } })
  typeText(editorCase.editor, "yrs")
  assert.equal(editorCase.editor.getText(), "yrs")
  assert.deepEqual(actionIds(editorCase.events), [])

  // Explicit disable removes both keys without a list/global fallback.
  const disabled = mod.createCcKeymap({
    platform: "posix",
    bindings: { "subagent.reply": null, "subagent.interrupt": null },
  })
  for (const context of SUBAGENT_CONTEXTS) {
    assert.deepEqual(disabled.getBindings("subagent.reply"), [])
    assert.deepEqual(disabled.getBindings("subagent.interrupt"), [])
    assert.equal(disabled.resolve("r", context).kind, "none")
    assert.equal(disabled.resolve("s", context).kind, "none")
    assert.equal(actionId(disabled, "\x1b[B", context), "list.next", "shared list keys still work")
    assert.equal(actionId(disabled, "\x04", context), "app.exit", "global exit still works")
  }

  // Deleting the one override (reset) restores the defaults; a remap is never
  // merged with the old key.
  remapped.setBindings({})
  for (const context of SUBAGENT_CONTEXTS) {
    assert.equal(actionId(remapped, "r", context), "subagent.reply")
    assert.equal(actionId(remapped, "s", context), "subagent.interrupt")
    assert.equal(remapped.resolve("y", context).kind, "none")
  }
})

test("mouse input stays outside the shared keymap and the overlay actions", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  const mouseReports = ["\x1b[<0;10;5M", "\x1b[<0;10;5m", "\x1b[<35;20;8M", "\x1b[<64;1;1M"]
  for (const context of SUBAGENT_CONTEXTS) {
    for (const data of mouseReports) {
      assert.equal(keymap.resolve(data, context).kind, "none", `${context} ${JSON.stringify(data)}`)
    }
  }

  // Mouse selection/scroll is a component concern (claimed press + hitboxes).
  // It is not a registry action and never becomes an escape-sequence key.
  assert.deepEqual(
    mod.CC_ACTIONS.filter((action) => /mouse|click|wheel/i.test(`${action.id} ${action.description}`)),
    [],
  )
  const subagentActions = mod.CC_ACTIONS.filter((action) => action.id.startsWith("subagent."))
  assert.deepEqual(
    subagentActions.flatMap((action) => action.defaultBindings),
    ["r", "s"],
    "the overlay actions are plain keyboard keys; mouse stays in the UI layer",
  )
})

// --- opening and draft preservation -------------------------------------

test("Ctrl+X Ctrl+A opens the Agents overlay without touching the draft", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  assertPending(keymap, "\x18", "editor", 1_000)
  assert.equal(actionId(keymap, "\x01", "editor", 1_010), "app.subagents.details")

  // Ctrl+A alone keeps its readline meaning; the chord does not steal it.
  assert.equal(actionId(keymap, "\x01", "editor"), "editor.move.line-start")
  for (const context of SUBAGENT_CONTEXTS) {
    assert.notEqual(actionId(keymap, "\x01", context), "app.subagents.details")
  }

  // Neighbouring chords keep their existing meaning.
  assertPending(keymap, "\x18", "editor", 2_000)
  assert.equal(actionId(keymap, "\x05", "editor", 2_010), "app.editor.external")
  assertPending(keymap, "\x18", "editor", 3_000)
  assert.equal(actionId(keymap, "\x0f", "editor", 3_010), "app.tools.details")
  assertPending(keymap, "\x18", "editor", 4_000)
  assert.equal(actionId(keymap, "\x09", "editor", 4_010), "app.images.details")

  const { editor, events } = makeEditor()
  editor.setText("first line\nsrc/utils/foo.ts")
  editor.ccSetCursor(1, "src/utils/foo.ts".length)
  press(editor, "\x17") // Ctrl+W: one kill-ring entry
  press(editor, "\x19") // Ctrl+Y: yank it back
  editor.ccSetCursor(0, 3)
  const before = editor.captureDraft()
  const killRing = editor.ccGetKillRing()
  const undoDepth = editor.ccUndoDepth()

  press(editor, "\x18", "\x01")
  assert.deepEqual(actionIds(events), ["app.subagents.details"])
  assert.equal(events[0]?.context, "editor")
  assert.equal(events[0]?.key, "\x01")
  assert.deepEqual(editor.captureDraft(), before)
  assert.equal(editor.getText(), "first line\nsrc/utils/foo.ts")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 3 })
  assert.deepEqual(editor.ccGetKillRing(), killRing)
  assert.equal(editor.ccUndoDepth(), undoDepth)
  assert.equal(editor.getKeymap().isPendingChord(), false)
})

// --- fallback -----------------------------------------------------------

test("both subagent surfaces reuse list, dialog and global keys with no editor layer", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  for (const context of SUBAGENT_CONTEXTS) {
    // list fallback: navigation, Enter and Esc.
    assert.equal(actionId(keymap, "\x1b[A", context), "list.previous")
    assert.equal(actionId(keymap, "\x1b[B", context), "list.next")
    assert.equal(actionId(keymap, "\x10", context), "list.previous")
    assert.equal(actionId(keymap, "\x0e", context), "list.next")
    assert.equal(actionId(keymap, "k", context), "list.previous")
    assert.equal(actionId(keymap, "j", context), "list.next")
    assert.equal(actionId(keymap, "\x1b[5~", context), "list.page-up")
    assert.equal(actionId(keymap, "\x1b[6~", context), "list.page-down")
    assert.equal(actionId(keymap, "\x1b[H", context), "list.first")
    assert.equal(actionId(keymap, "\x1b[F", context), "list.last")
    assert.equal(actionId(keymap, "1", context), "list.select-digit")
    assert.equal(actionId(keymap, "\r", context), "list.select")
    assert.equal(actionId(keymap, "\n", context), "list.select", "legacy ^J/^M share the Enter byte group")
    assert.equal(actionId(keymap, "\x1b", context), "list.cancel")

    // global fallback and the shared interrupt.
    assert.equal(actionId(keymap, "\x03", context), "app.interrupt")
    assert.equal(actionId(keymap, "\x0f", context), "app.tools.expand")
    assert.equal(actionId(keymap, "\x14", context), "app.todo")
    assert.equal(actionId(keymap, "\x04", context), "app.exit")
    assertPending(keymap, "\x18", context, 1_000)
    assert.equal(actionId(keymap, "\x01", context, 1_010), "app.subagents.details")

    // No editor fallback: movement, kill/yank/undo, deletion and submit are
    // not reachable through editor actions.
    for (const data of ["\x01", "\x05", "\x02", "\x06", "\x17", "\x15", "\x0b", "\x19", "\x1f", "\x1by", "\x7f"]) {
      assert.equal(keymap.resolve(data, context).kind, "none", `${context} ${JSON.stringify(data)}`)
    }
    // Plain text is inert (j/k/digits are already list actions above).
    for (const data of ["x", "q", " "]) {
      assert.equal(keymap.resolve(data, context).kind, "none", `${context} ${data}`)
    }
  }
})

test("the fallback chain really passes through list, then dialog, then global", () => {
  // With list.cancel/list.select disabled, the next layer (dialog) answers.
  const dialogLayer = mod.createCcKeymap({
    platform: "posix",
    bindings: { "list.cancel": null, "list.select": null },
  })
  // With list and dialog keys disabled, the global app layer answers.
  const globalLayer = mod.createCcKeymap({
    platform: "posix",
    bindings: {
      "list.cancel": null,
      "list.select": null,
      "dialog.cancel": null,
      "dialog.confirm": null,
    },
  })
  for (const context of SUBAGENT_CONTEXTS) {
    assert.equal(actionId(dialogLayer, "\x1b", context), "dialog.cancel")
    assert.equal(actionId(dialogLayer, "\r", context), "dialog.confirm")
    assert.equal(actionId(globalLayer, "\x1b", context), "app.cancel")
    // app.interrupt priority does not depend on the lower layers.
    assert.equal(actionId(globalLayer, "\x03", context), "app.interrupt")
  }

  // app.cancel still reaches the App through a CcEditor when the local close
  // layers are disabled; it never edits the hidden draft.
  const appCancel = makeEditor({
    context: "subagentList",
    bindings: { "list.cancel": null, "dialog.cancel": null },
  })
  appCancel.editor.setText("keep")
  press(appCancel.editor, "\x1b")
  assert.deepEqual(actionIds(appCancel.events), ["app.cancel"])
  assert.equal(appCancel.editor.getText(), "keep")
})

// --- read-only bytes ----------------------------------------------------

test("read-only subagent bytes never reach the hidden editor or submit", () => {
  for (const context of SUBAGENT_CONTEXTS) {
    const { editor, events } = makeEditor({ context })
    editor.setText("hidden draft")
    editor.ccSetCursor(0, 6)
    const before = editor.captureDraft()

    typeText(editor, "xq ")
    press(editor, "\x7f", "\x01", "\x17", "\x15", "\x0b", "\x19", "\x1f")
    editor.handleInput("\x1b[200~pasted secret\x1b[201~")
    editor.flushInputBuffer()
    assert.equal(editor.getText(), "hidden draft", `${context}: printable/editing bytes/paste are inert`)
    assert.deepEqual(editor.getCursor(), { line: 0, col: 6 })
    assert.deepEqual(actionIds(events), [], `${context}: no editor action is emitted`)
    assert.deepEqual(editor.captureDraft(), before)

    // Shared list keys remain the only non-global interaction.
    events.length = 0
    press(editor, "\x1b[B", "j", "\r", "\x1b")
    assert.deepEqual(actionIds(events), ["list.next", "list.next", "list.select", "list.cancel"])
    assert.deepEqual(
      events.map((event) => event.context),
      [context, context, context, context],
    )
    assert.equal(editor.getText(), "hidden draft")
  }
})

test("root-only editor commands fail closed on read-only subagent surfaces", () => {
  // A custom registry can make an editor-implemented command resolvable in a
  // read-only context. CcEditor must consume it instead of mutating the hidden
  // root editor state.
  const base = mod.CC_ACTIONS_BY_ID.get("editor.kill.line-start")
  assert.ok(base)
  const definitions: CcActionDefinition[] = [
    ...mod.CC_ACTIONS.filter((action) => action.id !== "editor.kill.line-start"),
    {
      ...base,
      contexts: ["subagentList", "subagentSession"],
      defaultBindings: ["ctrl+u"],
    },
  ]
  const keymap = mod.createCcKeymap({ definitions, platform: "posix" })

  for (const context of SUBAGENT_CONTEXTS) {
    assert.equal(actionId(keymap, "\x15", context), "editor.kill.line-start")
    const { editor, events } = makeEditor({ context, keymap })
    editor.setText("keep me")
    editor.ccSetCursor(0, "keep me".length)
    press(editor, "\x15")
    assert.equal(editor.getText(), "keep me", `${context}: the hidden draft is untouched`)
    assert.deepEqual(editor.ccGetKillRing(), [])
    assert.deepEqual(actionIds(events), [], `${context}: no app event for a failed-closed root command`)
  }

  // Control: the same command still works in the normal editor context.
  const control = makeEditor({ bindings: { "editor.kill.line-start": "ctrl+u" } })
  control.editor.setText("keep me")
  control.editor.ccSetCursor(0, "keep me".length)
  press(control.editor, "\x15")
  assert.equal(control.editor.getText(), "")
})

test("root-prompt app commands fail closed on read-only subagent surfaces", () => {
  // Prompt-mode chords/keys supplied by the App. They stay resolvable in the
  // keymap (Settings/diagnostics) but must not act on the hidden root draft
  // while a read-only Agents surface owns input.
  const bindings = {
    "app.message.sendNow": "ctrl+enter",
    "app.message.steer": "ctrl+x ctrl+s",
    "app.message.followUp": "ctrl+x enter",
  }
  for (const context of SUBAGENT_CONTEXTS) {
    const { editor, events } = makeEditor({ context, bindings })
    editor.setText("root draft")
    editor.ccSetCursor(0, "root draft".length)
    const before = editor.captureDraft()

    // stash, history search, external editor, paste image; Ctrl+D on a
    // non-empty root draft stays guarded by the existing empty-input policy
    press(editor, "\x13", "\x12", "\x07", "\x16", "\x04")
    // send-now / steer / follow-up submitted against the root prompt
    press(editor, "\x1b[13;5u", "\x18", "\x13", "\x18", "\r")

    assert.deepEqual(actionIds(events), [], `${context}: root-prompt commands are consumed`)
    assert.deepEqual(editor.captureDraft(), before, `${context}: the hidden root draft is untouched`)
    assert.equal(editor.getText(), "root draft", `${context}: Ctrl+D cannot quit on a non-empty root draft`)
    // App-level globals that are not root-editor commands still flow.
    press(editor, "\x0f", "\x14")
    assert.deepEqual(actionIds(events), ["app.tools.expand", "app.todo"])
  }
})

test("global app.exit remains available on read-only subagent surfaces", () => {
  for (const context of SUBAGENT_CONTEXTS) {
    const { editor, events } = makeEditor({ context })
    editor.setText("root draft")

    // The existing empty-draft guard still applies in the surface.
    press(editor, "\x04")
    assert.deepEqual(actionIds(events), [], `${context}: Ctrl+D cannot exit on a non-empty draft`)
    assert.equal(editor.getText(), "root draft")

    // On an empty draft the global exit is emitted; the App owns the actual
    // quit/arm policy, the input layer does not swallow it.
    editor.replaceDraftText("")
    press(editor, "\x04")
    assert.deepEqual(actionIds(events), ["app.exit"], `${context}: global exit remains reachable`)
    assert.equal(events[0]?.context, context)
  }
})

test("an abandoned jump cannot move the hidden cursor on a read-only surface", () => {
  const { editor, events } = makeEditor()
  editor.setText("abc@def")
  editor.ccSetCursor(0, 0)
  press(editor, "\x1d") // Ctrl+] jump forward in the prompt
  assert.equal(editor.ccGetJumpMode(), "forward")

  // The App opens the Agents overlay while the jump is still armed.
  editor.setContext("subagentList")
  press(editor, "@")
  assert.equal(editor.ccGetJumpMode(), null, "the stale jump is cancelled at the read-only boundary")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 }, "printable target never reaches the hidden editor")
  assert.equal(editor.getText(), "abc@def")
  assert.deepEqual(actionIds(events), [])
})

// --- config: remap / disable / reset ------------------------------------

test("shared list navigation can be remapped, disabled and reset for both contexts", () => {
  const remapped = mod.createCcKeymap({ platform: "posix", bindings: { "list.next": "n" } })
  for (const context of SUBAGENT_CONTEXTS) {
    assert.equal(actionId(remapped, "n", context), "list.next")
    assert.equal(remapped.resolve("j", context).kind, "none", "the old key is not a hardcoded fallback")
    assert.equal(actionId(remapped, "\x1b[A", context), "list.previous")
  }

  const disabled = mod.createCcKeymap({ platform: "posix", bindings: { "list.next": null } })
  for (const context of SUBAGENT_CONTEXTS) {
    assert.equal(disabled.resolve("j", context).kind, "none")
    assert.equal(disabled.resolve("n", context).kind, "none")
    assert.equal(actionId(disabled, "\x1b[A", context), "list.previous")
  }

  // Deleting the override (reset) restores the one default binding.
  remapped.setBindings({})
  for (const context of SUBAGENT_CONTEXTS) {
    assert.equal(actionId(remapped, "j", context), "list.next")
    assert.equal(remapped.resolve("n", context).kind, "none")
  }
})

test("app.subagents.details can be remapped, disabled and reset without resurrecting Ctrl+A", () => {
  const remapped = mod.createCcKeymap({
    platform: "posix",
    bindings: { "app.subagents.details": "ctrl+x ctrl+d" },
  })
  assert.deepEqual(remapped.getBindings("app.subagents.details"), ["ctrl+x ctrl+d"])
  assertPending(remapped, "\x18", "editor", 1_000)
  assert.equal(actionId(remapped, "\x04", "editor", 1_010), "app.subagents.details")

  // The retired chord re-dispatches its second key; it is never the action.
  assert.equal(remapped.resolve("\x18", "editor", 2_000).kind, "pending")
  const mismatch = remapped.resolve("\x01", "editor", 2_010)
  assert.equal(mismatch.kind, "cancelled-chord")
  assert.equal(mismatch.kind === "cancelled-chord" ? mismatch.passthrough : "", "\x01")
  assert.equal(actionId(remapped, "\x01", "editor"), "editor.move.line-start")
  for (const context of SUBAGENT_CONTEXTS) assert.equal(remapped.resolve("\x01", context).kind, "none")

  const disabled = mod.createCcKeymap({ platform: "posix", bindings: { "app.subagents.details": null } })
  assert.deepEqual(disabled.getBindings("app.subagents.details"), [])
  assert.equal(disabled.resolve("\x18", "editor", 3_000).kind, "pending")
  assert.equal(disabled.resolve("\x01", "editor", 3_010).kind, "cancelled-chord")
  assert.notEqual(actionId(disabled, "\x01", "editor"), "app.subagents.details")
  const disabledEditor = makeEditor({ bindings: { "app.subagents.details": null } })
  disabledEditor.editor.setText("line")
  disabledEditor.editor.ccSetCursor(0, "line".length)
  press(disabledEditor.editor, "\x18", "\x01")
  assert.deepEqual(actionIds(disabledEditor.events), [], "a disabled chord cannot open the overlay")
  assert.deepEqual(disabledEditor.editor.getCursor(), { line: 0, col: 0 }, "Ctrl+A keeps its editor meaning")

  // Reset by removing the single override restores the default chord.
  remapped.setBindings({})
  assert.deepEqual(remapped.getBindings("app.subagents.details"), ["ctrl+x ctrl+a"])
  assertPending(remapped, "\x18", "editor", 4_000)
  assert.equal(actionId(remapped, "\x01", "editor", 4_010), "app.subagents.details")
  assertPending(remapped, "\x18", "editor", 5_000)
  assert.equal(remapped.resolve("\x04", "editor", 5_010).kind, "cancelled-chord", "the remap is gone, not merged")
})

// --- interrupt priority -------------------------------------------------

test("Ctrl+C keeps priority over pending chords and list.cancel in both contexts", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  const changes: Array<readonly string[] | null> = []
  keymap.onChordChange((prefix) => changes.push(prefix))

  for (const context of SUBAGENT_CONTEXTS) {
    keymap.cancelChord()
    changes.length = 0
    assert.equal(keymap.resolve("\x18", context, 1_000).kind, "pending")
    assert.deepEqual(keymap.getPendingChord(), ["ctrl+x"])
    assert.equal(actionId(keymap, "\x03", context, 1_010), "app.interrupt")
    assert.equal(keymap.isPendingChord(), false, `${context}: the chord is cancelled, not completed`)
    assert.deepEqual(changes, [["ctrl+x"], null], `${context}: the hint clears exactly once`)
  }

  // A remapped interrupt key moves the priority with it; old Ctrl+C then
  // reaches the shared list.cancel.
  const remapped = mod.createCcKeymap({ platform: "posix", bindings: { "app.interrupt": "ctrl+q" } })
  for (const context of SUBAGENT_CONTEXTS) {
    assert.equal(remapped.resolve("\x18", context, 2_000).kind, "pending")
    assert.equal(actionId(remapped, "\x11", context, 2_010), "app.interrupt")
    assert.equal(remapped.isPendingChord(), false)
    assert.equal(actionId(remapped, "\x03", context), "list.cancel")
  }

  // Disabling the action exposes list.cancel; a pending chord is cancelled
  // and its passthrough is resolved fresh.
  const disabled = mod.createCcKeymap({ platform: "posix", bindings: { "app.interrupt": null } })
  for (const context of SUBAGENT_CONTEXTS) {
    assert.equal(actionId(disabled, "\x03", context), "list.cancel")
    assert.equal(disabled.resolve("\x18", context, 3_000).kind, "pending")
    const cancelled = disabled.resolve("\x03", context, 3_010)
    assert.equal(cancelled.kind, "cancelled-chord")
    assert.equal(
      actionId(disabled, cancelled.kind === "cancelled-chord" ? cancelled.passthrough : "", context),
      "list.cancel",
    )
  }

  // Existing plain-list semantics are deliberately unchanged.
  assert.equal(actionId(keymap, "\x03", "list"), "list.cancel")
})

test("CcEditor in a subagent surface emits the global interrupt, not the overlay interrupt", () => {
  for (const context of SUBAGENT_CONTEXTS) {
    const { editor, events, chordPrefixes } = makeEditor({ context })
    editor.setText("readonly content")
    const before = editor.captureDraft()

    press(editor, "\x18")
    assert.equal(editor.getKeymap().isPendingChord(), true)
    press(editor, "\x03")
    assert.deepEqual(actionIds(events), ["app.interrupt"])
    assert.equal(events[0]?.context, context)
    assert.notEqual(events[0]?.id, "subagent.interrupt", "Ctrl+C stays the global interrupt")
    assert.equal(editor.getKeymap().isPendingChord(), false)
    assert.deepEqual(chordPrefixes.at(-1), null)
    assert.deepEqual(editor.captureDraft(), before)

    // A disabled interrupt is not a phantom event; Esc still closes via list.cancel.
    events.length = 0
    press(editor, "\x1b")
    assert.deepEqual(actionIds(events), ["list.cancel"])
    assert.equal(editor.getText(), "readonly content")
  }
})

// --- chord cancellation and disposal ------------------------------------

test("context switches, paste and timeout cancel subagent chords without leaking keys", () => {
  const keymap = mod.createCcKeymap({ platform: "posix", chordTimeoutMs: 1_000 })
  // Timeout in a subagent context never completes the chord.
  assert.equal(keymap.resolve("\x18", "subagentList", 1_000).kind, "pending")
  const timeout = keymap.resolve("\x01", "subagentList", 2_001)
  assert.equal(timeout.kind, "cancelled-chord")
  assert.equal(timeout.kind === "cancelled-chord" ? timeout.reason : "", "timeout")
  assert.equal(actionId(keymap, "\x01", "subagentList"), undefined, "the A after a timeout is inert")

  const switched = makeEditor()
  press(switched.editor, "\x18")
  assert.equal(switched.editor.getKeymap().isPendingChord(), true)
  switched.editor.setContext("subagentList")
  assert.equal(switched.editor.getKeymap().isPendingChord(), false, "a chord compiled for editor is cancelled")
  assert.deepEqual(switched.chordPrefixes.at(-1), null)
  typeText(switched.editor, "a")
  assert.equal(switched.editor.getText(), "", "printable input stays inert after the context switch")
  assert.deepEqual(actionIds(switched.events), [])

  // A paste boundary invalidates the chord and pasted bytes are discarded.
  const pasted = makeEditor({ context: "subagentSession" })
  press(pasted.editor, "\x18")
  assert.equal(pasted.editor.getKeymap().isPendingChord(), true)
  pasted.editor.handleInput("\x1b[200~\x01secret\x1b[201~")
  pasted.editor.flushInputBuffer()
  assert.equal(pasted.editor.getKeymap().isPendingChord(), false)
  assert.equal(pasted.editor.getText(), "")
  assert.deepEqual(actionIds(pasted.events), [])
})

test("dispose is ownership-safe and leaves a subagent surface inert", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  const prompt = makeEditor({ keymap })
  const hidden = makeEditor({ keymap, context: "subagentList" })

  press(prompt.editor, "\x18")
  assert.equal(keymap.isPendingChord(), true)

  hidden.editor.dispose()
  hidden.editor.dispose() // idempotent
  assert.equal(keymap.isPendingChord(), true, "disposing a hidden subagent surface does not steal the chord")
  assert.deepEqual(prompt.chordPrefixes.at(-1), ["ctrl+x"])

  // Late focus/teardown callbacks and bytes on the disposed editor are inert.
  hidden.editor.focused = false
  hidden.editor.cancelChord()
  press(hidden.editor, "\x03", "x", "\x1b")
  assert.deepEqual(actionIds(hidden.events), [])
  assert.equal(keymap.isPendingChord(), true)
  assert.deepEqual(prompt.chordPrefixes.at(-1), ["ctrl+x"])

  // The prompt can still complete the chord.
  press(prompt.editor, "\x01")
  assert.deepEqual(actionIds(prompt.events), ["app.subagents.details"])
  assert.equal(keymap.isPendingChord(), false)

  // The active owner disposing cancels its own chord and clears the hint.
  const session = makeEditor({ context: "subagentSession" })
  press(session.editor, "\x18")
  assert.equal(session.editor.getKeymap().isPendingChord(), true)
  session.editor.dispose()
  assert.equal(session.editor.getKeymap().isPendingChord(), false)
  assert.deepEqual(session.chordPrefixes.at(-1), null)
  press(session.editor, "\x1b[B", "\x03", "z")
  assert.deepEqual(actionIds(session.events), [])
})