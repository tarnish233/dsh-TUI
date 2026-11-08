/**
 * Settings group/section navigation input contract, offline only.
 *
 * `/settings` is one continuous grouped list (no category tabs). The stable
 * actions `settings.previous-category` / `settings.next-category` now mean
 * "previous/next group (section)" and are bound to Left + Shift+Tab and
 * Right + Tab in the `settingsList` browse context only.
 *
 * Root cause this file pins: Tab had no binding anywhere in the
 * `settingsList → list → dialog → global` chain (so it resolved to nothing),
 * while Shift+Tab fell through to the global `app.mode.cycle` action and was
 * therefore consumed as an inert non-settings action inside the modal. There
 * was never a terminal-protocol problem: the raw bytes parse correctly, the
 * defaults simply did not exist.
 *
 * No terminal write, model/provider call, DSH process, clipboard/profile/
 * session read or global installation is involved: raw terminal bytes go
 * through the shared `CcKeymap` or one Pi editor state.
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
import type { CcActionDefinition, CcActionEvent, CcContext, CcEditorOptions } from "../src/input/index.ts"

const mod = await loadInputModule()
type TestKeymap = InstanceType<typeof mod.CcKeymap>
type TestEditor = InstanceType<typeof mod.CcEditor>

/** Legacy terminal encodings plus the Kitty / modifyOtherKeys equivalents. */
const NEXT_GROUP_BYTES = {
  /** Legacy Tab (0x09), identical to Ctrl+I. */
  legacyTab: "\t",
  ctrlI: "\x09",
  /** Kitty CSI-u: Tab, no modifiers. */
  kittyTab: "\x1b[9;1u",
} as const
const PREVIOUS_GROUP_BYTES = {
  /** Legacy Shift+Tab (CSI Z). */
  legacyShiftTab: "\x1b[Z",
  /** Kitty CSI-u: Shift+Tab. */
  kittyShiftTab: "\x1b[9;2u",
  /** xterm modifyOtherKeys: Shift+Tab. */
  xtermShiftTab: "\x1b[27;2;9~",
} as const

function actionId(keymap: TestKeymap, data: string, context: CcContext): string | undefined {
  const resolution = keymap.resolve(data, context)
  return resolution.kind === "action" ? resolution.action.id : undefined
}

function actionIds(events: readonly CcActionEvent[]): string[] {
  return events.map((event) => event.id)
}

function makeEditor(options: CcEditorOptions = {}, keymap?: TestKeymap) {
  const tui = createFakeTui()
  const editor = new mod.CcEditor(
    asTui(tui),
    testEditorTheme,
    keymap === undefined ? options : { ...options, keymap },
  )
  const events: CcActionEvent[] = []
  editor.onAction = (event) => {
    events.push(event)
  }
  renderAt(editor, 80)
  return { editor, tui, events }
}

// --- registry metadata --------------------------------------------------

test("Settings group navigation keeps the stable ids and describes groups, not tabs", () => {
  const previous = mod.CC_ACTIONS_BY_ID.get("settings.previous-category")
  const next = mod.CC_ACTIONS_BY_ID.get("settings.next-category")
  assert.ok(previous)
  assert.ok(next)

  // Stable ids: existing keybindings.json overrides keep working unchanged.
  assert.equal(previous.id, "settings.previous-category")
  assert.equal(next.id, "settings.next-category")

  assert.deepEqual(previous.defaultBindings, ["left", "shift+tab"])
  assert.deepEqual(next.defaultBindings, ["right", "tab"])
  assert.deepEqual(previous.contexts, ["settingsList"])
  assert.deepEqual(next.contexts, ["settingsList"])
  assert.equal(previous.family, "dialog")
  assert.equal(next.family, "dialog")
  assert.equal(previous.implementor, "app")
  assert.equal(next.implementor, "app")
  assert.equal(previous.status, "tui-extension")
  assert.equal(next.status, "tui-extension")

  // Metadata talks about the grouped list's sections, never about tab pages.
  for (const action of [previous, next]) {
    assert.match(action.description, /group/i, action.id)
    assert.match(action.description, /section/i, action.id)
    assert.doesNotMatch(action.description, /tab/i, `${action.id} description`)
    assert.match(action.note ?? "", /group/i, `${action.id} note`)
    assert.doesNotMatch(action.note ?? "", /tab page/i, `${action.id} note`)
    assert.match(action.note ?? "", /legacy (config )?ID/i, `${action.id} note keeps the id contract visible`)
  }

  // Every default is one parseable key, so the Settings editor can remap it.
  for (const spec of [...previous.defaultBindings, ...next.defaultBindings]) {
    assert.ok(mod.parseBindingSpec(spec)?.length, spec)
  }

  // No new override layer and no duplicate group-navigation action.
  const groupActions = mod.CC_ACTIONS.filter(
    (action) => action.id.startsWith("settings.") && /previous-category|next-category/.test(action.id),
  )
  assert.deepEqual(
    groupActions.map((action) => action.id),
    ["settings.previous-category", "settings.next-category"],
  )
})

// --- legacy and Kitty encodings -----------------------------------------

test("legacy Tab/ESC[Z and Kitty Shift+Tab reach the Settings group jumps", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  for (const data of Object.values(NEXT_GROUP_BYTES)) {
    assert.equal(actionId(keymap, data, "settingsList"), "settings.next-category", JSON.stringify(data))
  }
  for (const data of Object.values(PREVIOUS_GROUP_BYTES)) {
    assert.equal(actionId(keymap, data, "settingsList"), "settings.previous-category", JSON.stringify(data))
  }

  // The arrows that already worked still resolve to the same two actions.
  assert.equal(actionId(keymap, "\x1b[D", "settingsList"), "settings.previous-category")
  assert.equal(actionId(keymap, "\x1b[C", "settingsList"), "settings.next-category")

  // Effective hints come from the same registry rows.
  const help = keymap.getHelp("settingsList")
  assert.equal(help.find((row) => row.action === "settings.previous-category")?.keysLabel, "Left, Shift+Tab")
  assert.equal(help.find((row) => row.action === "settings.next-category")?.keysLabel, "Right, Tab")

  // No reader/terminal-protocol change was needed: the same bytes stay editor
  // completion and permission cycling outside the Settings browse list.
  assert.equal(actionId(keymap, "\t", "editor"), "editor.complete")
  assert.equal(actionId(keymap, "\x1b[Z", "editor"), "app.mode.cycle")
})

test("CcEditor dispatches the Settings group jumps and never types them into the list", () => {
  const { editor, events } = makeEditor({ context: "settingsList" })
  typeText(editor, "ti")
  assert.equal(editor.getText(), "", "a read-only browse list never accepts text")
  press(editor, "\t")
  press(editor, "\x1b[Z")
  press(editor, "\x1b[9;2u")
  press(editor, "\x1b[C")
  press(editor, "\x1b[D")
  assert.equal(editor.getText(), "")
  assert.deepEqual(actionIds(events), [
    "settings.next-category",
    "settings.previous-category",
    "settings.previous-category",
    "settings.next-category",
    "settings.previous-category",
  ])
})

// --- user overrides and disabling ---------------------------------------

test("overrides keep working: remap, disable and reset are per action, not per key", () => {
  // A removed/disabled row really stops navigating and never resurrects a default.
  const disabledNext = mod.createCcKeymap({ bindings: { "settings.next-category": null }, platform: "posix" })
  assert.deepEqual(disabledNext.getBindings("settings.next-category"), [])
  assert.equal(actionId(disabledNext, "\t", "settingsList"), undefined)
  assert.equal(actionId(disabledNext, "\x1b[C", "settingsList"), undefined)
  assert.equal(actionId(disabledNext, "\x1b[D", "settingsList"), "settings.previous-category", "the other row is untouched")
  assert.equal(disabledNext.getHelp("settingsList").some((row) => row.action === "settings.next-category"), false)

  const disabledPrevious = mod.createCcKeymap({ bindings: { "settings.previous-category": [] }, platform: "posix" })
  assert.deepEqual(disabledPrevious.getBindings("settings.previous-category"), [])
  assert.equal(actionId(disabledPrevious, "\x1b[Z", "settingsList"), "app.mode.cycle")
  assert.equal(actionId(disabledPrevious, "\x1b[D", "settingsList"), undefined)
  // Shift+Tab falls back to the unchanged global permission preset only at the
  // keymap layer; the Settings dialog treats that non-settings action as inert.
  assert.equal(actionId(disabledPrevious, "\x1b[Z", "editor"), "app.mode.cycle")

  // A user remap replaces the whole row, exactly like every other action.
  const remapped = mod.createCcKeymap({
    bindings: { "settings.next-category": ["alt+right"], "settings.previous-category": "alt+left" },
    platform: "posix",
  })
  assert.equal(actionId(remapped, "\x1b[1;3C", "settingsList"), "settings.next-category")
  assert.equal(actionId(remapped, "\x1b[1;3D", "settingsList"), "settings.previous-category")
  for (const data of ["\t", "\x1b[C"]) assert.equal(actionId(remapped, data, "settingsList"), undefined, data)
  assert.equal(actionId(remapped, "\x1b[D", "settingsList"), undefined)
  // A remapped Shift+Tab falls back to the unchanged global permission action
  // (inert inside the Settings dialog, exactly like any other non-settings id).
  assert.equal(actionId(remapped, "\x1b[Z", "settingsList"), "app.mode.cycle")
  assert.equal(remapped.getDiagnostics().some((diagnostic) => diagnostic.severity === "error"), false)

  // An invalid override disables the row visibly instead of silently keeping a default.
  const invalid = mod.createCcKeymap({ bindings: { "settings.next-category": "tab+" }, platform: "posix" })
  assert.deepEqual(invalid.getBindings("settings.next-category"), [])
  assert.equal(actionId(invalid, "\t", "settingsList"), undefined)
  assert.ok(
    invalid
      .getDiagnostics()
      .some((diagnostic) => diagnostic.action === "settings.next-category" && diagnostic.code === "invalid-binding"),
  )

  // Reset by deleting one override: the same defaults come back.
  const reset = mod.createCcKeymap({ platform: "posix" })
  reset.setBindings({ "settings.next-category": "alt+]" })
  assert.equal(actionId(reset, "\t", "settingsList"), undefined)
  reset.setBindings({})
  assert.equal(actionId(reset, "\t", "settingsList"), "settings.next-category")
  assert.equal(actionId(reset, "\x1b[Z", "settingsList"), "settings.previous-category")
})

// --- no root model / permission bleed -----------------------------------

test("root Shift+Tab still only cycles the native permission preset", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })
  for (const context of ["editor", "global", "list", "autocomplete", "historySearch"] as const) {
    assert.equal(actionId(keymap, "\x1b[Z", context), "app.mode.cycle", context)
  }
  const cycle = mod.CC_ACTIONS_BY_ID.get("app.mode.cycle")
  assert.ok(cycle)
  assert.deepEqual(cycle.defaultBindings, ["shift+tab"])
  assert.match(cycle.description, /permission/i)
  assert.notEqual(cycle.id, "settings.previous-category")

  // Tab in the prompt is still completion, never a Settings jump or a picker.
  assert.equal(actionId(keymap, "\t", "editor"), "editor.complete")
  for (const data of ["\t", "\x1b[Z", "\x1b[C", "\x1b[D"]) {
    assert.notEqual(actionId(keymap, data, "editor"), "settings.next-category", JSON.stringify(data))
  }
  // No model switch moved onto these keys either.
  assert.equal(actionId(keymap, "\x1bp", "editor"), "app.model.select")
  assert.equal(actionId(keymap, "\t", "modelPickerList"), "model.provider.next")
  assert.equal(actionId(keymap, "\x1b[Z", "modelPickerList"), "model.provider.previous")
})

// --- other contexts stay intact -----------------------------------------

test("search fields and every other modal context keep their existing Tab behaviour", () => {
  const keymap = mod.createCcKeymap({ platform: "posix" })

  // The Settings search field is a real text field: Tab is completion, the
  // arrows are readline movement, Shift+Tab keeps its documented fallback.
  assert.equal(actionId(keymap, "\t", "modalSearch"), "editor.complete")
  assert.equal(actionId(keymap, "\x1b[D", "modalSearch"), "editor.move.char-left")
  assert.equal(actionId(keymap, "\x1b[C", "modalSearch"), "editor.move.char-right")
  assert.equal(actionId(keymap, "\x1b[Z", "modalSearch"), "app.mode.cycle")
  assert.notEqual(actionId(keymap, "\x1b[Z", "modalSearch"), "settings.previous-category")

  // Browse modals that are not Settings were never bound to these keys.
  for (const context of ["keybindingsList", "modalList", "queueList"] as const) {
    assert.equal(actionId(keymap, "\t", context), undefined, context)
    assert.equal(actionId(keymap, "\x1b[Z", context), "app.mode.cycle", context)
  }

  // Modal-local Tab actions are untouched and still win in their own contexts.
  assert.equal(actionId(keymap, "\t", "toolDetails"), "tool.details.next-section")
  assert.equal(actionId(keymap, "\x1b[Z", "toolDetails"), "tool.details.previous-section")
  assert.equal(actionId(keymap, "\t", "subagentList"), "subagent.filter.toggle")
  assert.equal(actionId(keymap, "\t", "subagentSession"), undefined)
  assert.equal(actionId(keymap, "\t", "imageDetails"), undefined)
  assert.equal(actionId(keymap, "\t", "autocomplete"), "autocomplete.accept")
  assert.equal(actionId(keymap, "\t", "historySearch"), "historySearch.accept")

  // The search editor keeps one readline surface: typing, word kill and yank.
  const search = makeEditor({ context: "modalSearch" })
  typeText(search.editor, "group")
  press(search.editor, "\x17")
  assert.equal(search.editor.getText(), "")
  press(search.editor, "\x19")
  assert.equal(search.editor.getText(), "group")
  press(search.editor, "\x1b[D")
  assert.deepEqual(actionIds(search.events), [], "text editing emits no Settings group action")
})

// --- inherited dialog Tab binding cannot swallow Settings jumps ---------

test("an inherited dialog/global Tab binding never swallows the Settings jumps", () => {
  // Simulates a future generic `dialog.focus-next`/`dialog.focus-previous`
  // pair on Tab/Shift+Tab. `dialog` is a fallback layer of `settingsList`, so
  // the context-local Settings rows must still win.
  const focusActions: CcActionDefinition[] = [
    {
      id: "dialog.focus-next",
      family: "dialog",
      contexts: ["dialog"],
      defaultBindings: ["tab"],
      implementor: "app",
      status: "tui-extension",
      description: "Move focus to the next dialog control (test-only inherited action)",
    },
    {
      id: "dialog.focus-previous",
      family: "dialog",
      contexts: ["dialog"],
      defaultBindings: ["shift+tab"],
      implementor: "app",
      status: "tui-extension",
      description: "Move focus to the previous dialog control (test-only inherited action)",
    },
  ]
  const keymap = mod.createCcKeymap({
    definitions: [...mod.CC_ACTIONS, ...focusActions],
    platform: "posix",
  })

  assert.equal(actionId(keymap, "\t", "settingsList"), "settings.next-category")
  assert.equal(actionId(keymap, "\x1b[Z", "settingsList"), "settings.previous-category")
  // The inherited dialog rows still work where they belong.
  assert.equal(actionId(keymap, "\t", "dialog"), "dialog.focus-next")
  assert.equal(actionId(keymap, "\x1b[Z", "dialog"), "dialog.focus-previous")
  // And `settingsList` keeps no editor fallback: nothing types into the list.
  assert.equal(actionId(keymap, "\x02", "settingsList"), undefined)
  assert.equal(keymap.getFallbackChain("settingsList").includes("editor"), false)
})

test("a Settings-local Tab chord/remap cannot leak into other contexts", () => {
  const keymap = mod.createCcKeymap({
    bindings: { "settings.next-category": "ctrl+x ctrl+g" },
    platform: "posix",
  })
  assert.equal(keymap.resolve("\x18", "settingsList").kind, "pending")
  assert.equal(actionId(keymap, "\x07", "settingsList"), "settings.next-category")
  // The prompt keeps its own Ctrl+X chord behaviour and Tab completion.
  assert.equal(keymap.resolve("\x18", "editor").kind, "pending")
  assert.equal(actionId(keymap, "\x07", "editor"), undefined, "Ctrl+X Ctrl+G is Settings-only")
  assert.equal(actionId(keymap, "\t", "editor"), "editor.complete")
  assert.equal(actionId(keymap, "\t", "settingsList"), undefined, "the remap replaced the Tab default")
})