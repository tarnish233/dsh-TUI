/**
 * Cross-context keybinding shadow diagnostics.
 *
 * `CcKeymap.resolve()` picks the first binding of a *fallback chain*, so a key
 * can be bound twice — once in a local context layer and once in a more global
 * one — and only one of them ever fires. The shipped registry relies on that
 * order in documented places (Ctrl+D delete vs. exit, Ctrl+C interrupt vs. list
 * cancel, the Settings rows, the history-search layer), so those must stay
 * silent. What has to be reported is an *introduced* shadow:
 *
 * 1. an override whose own binding is unreachable in some context, and
 * 2. an override that takes a key away from a binding that owned it before.
 *
 * Every test checks the actual effective resolution (`resolve()` per affected
 * context and real `CcEditor` dispatch), not only that a diagnostic exists.
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  asTui,
  createFakeTui,
  loadInputModule,
  renderAt,
  testEditorTheme,
} from "../src/input/testing/harness.ts"
import type { CcActionEvent, CcContext, CcEditorOptions, CcKeymap, CcKeymapConfig } from "../src/input/index.ts"

const mod = await loadInputModule()
const { createCcKeymap } = mod

/**
 * The bindings the app always composes on top of the registry defaults
 * (`src/app.ts` `modeBindings`). Copied verbatim so the no-false-positive
 * expectation is about the shipped composition.
 */
const MODE_BINDINGS: CcKeymapConfig = {
  "historySearch.next": ["ctrl+r", "down", "ctrl+n"],
  "historySearch.previous": ["ctrl+shift+r", "up", "ctrl+p"],
  "historySearch.accept": ["enter", "tab", "escape"],
  "historySearch.cancel": ["ctrl+c"],
  "app.message.sendNow": ["ctrl+enter"],
  "app.message.steer": ["ctrl+x ctrl+s"],
  "app.message.followUp": ["ctrl+x enter"],
}

function shadows(keymap: CcKeymap) {
  return keymap.getConflicts().filter((diagnostic) => diagnostic.code === "cross-context-shadow")
}

/**
 * Effective resolution of one key in one context: action id, or the kind.
 * Any chord opened by an earlier probe is cancelled first so each probe starts
 * from the same idle resolver state.
 */
function effective(keymap: CcKeymap, data: string, context: CcContext, now = 0): string {
  keymap.cancelChord()
  const resolution = keymap.resolve(data, context, now)
  return resolution.kind === "action" ? resolution.action.id : resolution.kind
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Dispatch one terminal chunk through the one editor state. */
function press(editor: { handleInput(data: string): void }, data: string): void {
  editor.handleInput(data)
}

/**
 * Resolve a full key sequence from an idle resolver and report what really
 * happens at every step (pending -> action/none). Used instead of asserting
 * only "there is a diagnostic": the analysis must describe the real path.
 */
function resolveSequence(
  keymap: CcKeymap,
  keys: readonly string[],
  context: CcContext,
): { kinds: string[]; action?: string; keys?: string[] } {
  keymap.cancelChord()
  const kinds: string[] = []
  let action: string | undefined
  let matchedKeys: string[] | undefined
  for (const key of keys) {
    const resolution = keymap.resolve(key, context)
    kinds.push(resolution.kind)
    if (resolution.kind === "action") {
      action = resolution.action.id
      matchedKeys = [...resolution.keys]
    }
  }
  return { kinds, action, keys: matchedKeys }
}

test("a global override hidden behind a default editor binding is reported and is really dead", () => {
  assert.deepEqual(createCcKeymap().getConflicts(), [], "the shipped defaults have no conflicts")
  const keymap = createCcKeymap({ bindings: { "app.interrupt": "ctrl+w" } })
  assert.deepEqual(keymap.getBindings("app.interrupt"), ["ctrl+w"])

  const dead = shadows(keymap).find((diagnostic) => diagnostic.action === "app.interrupt")
  assert.ok(dead, "a silently shadowed global override is reported")
  assert.equal(dead.otherAction, "editor.kill.whitespace-backward")
  assert.equal(dead.keys, "ctrl+w")
  assert.equal(dead.severity, "warning")
  assert.match(dead.message, /never fires there/)
  assert.ok(dead.contexts && dead.contexts.includes("editor"), "the prompt context is named")
  assert.ok((dead.contexts ?? []).length >= 2, "one override yields one grouped message, not one per context")

  // Effective resolution for every context the diagnostic lists: the override
  // really loses to the local binding there...
  for (const context of dead.contexts ?? []) {
    assert.equal(effective(keymap, "\x17", context), "editor.kill.whitespace-backward", context)
  }
  // ...while the documented fallback still reaches it where nothing local owns
  // the key, so the diagnostic is about shadowing, not about a dead action.
  assert.equal(effective(keymap, "\x17", "list"), "app.interrupt")
  assert.equal(effective(keymap, "\x17", "toolDetails"), "app.interrupt")

  // Real dispatch through the one editor state: Ctrl+W edits, no interrupt.
  const { editor, events } = makeEditor({ bindings: { "app.interrupt": "ctrl+w" } })
  editor.setText("foo bar")
  renderAt(editor, 80)
  editor.handleInput("\x17")
  assert.equal(editor.getText(), "foo ")
  assert.deepEqual(
    events.filter((event) => event.id === "app.interrupt"),
    [],
    "the shadowed override never reaches the app from the editor",
  )
})

test("an override that takes a default global key away from the app is reported as stolen", () => {
  const keymap = createCcKeymap({ bindings: { "editor.kill.word-backward": "ctrl+t" } })
  const stolen = shadows(keymap)
  assert.equal(stolen.length, 1)
  const diagnostic = stolen[0]!
  assert.equal(diagnostic.action, "app.todo", "the loser is named")
  assert.equal(diagnostic.otherAction, "editor.kill.word-backward")
  assert.equal(diagnostic.keys, "ctrl+t")
  assert.match(diagnostic.message, /now bound to Ctrl\+T/)
  assert.match(diagnostic.message, /had that key in the shipped defaults/)

  // Effective resolution: Ctrl+T is the editor kill inside the prompt and the
  // app action everywhere the editor layer does not take part.
  assert.equal(effective(keymap, "\x14", "editor"), "editor.kill.word-backward")
  assert.equal(effective(keymap, "\x14", "autocomplete"), "editor.kill.word-backward")
  assert.equal(effective(keymap, "\x14", "list"), "app.todo")
  assert.equal(effective(keymap, "\x14", "toolDetails"), "app.todo")

  const { editor, events } = makeEditor({ bindings: { "editor.kill.word-backward": "ctrl+t" } })
  editor.setText("foo.bar")
  renderAt(editor, 80)
  editor.handleInput("\x14")
  assert.equal(editor.getText(), "foo.", "Ctrl+T killed the word backwards instead of opening the todo")
  assert.deepEqual(events.filter((event) => event.id === "app.todo"), [])
})

test("a chord prefix in another layer is reported as unreachable, and the timed-out prefix is really dropped", async () => {
  const keymap = createCcKeymap({ bindings: { "editor.move.line-start": "ctrl+x" } })
  const unreachable = shadows(keymap).find((diagnostic) => diagnostic.action === "editor.move.line-start")
  assert.ok(unreachable, "a single key behind a foreign chord prefix is reported")
  assert.equal(unreachable.otherAction, "app.editor.external")
  assert.equal(unreachable.keys, "ctrl+x")
  assert.equal(unreachable.contexts?.includes("editor"), true)
  // R11: CcEditor's timer expires the chord without replaying the prefix, so the
  // single binding is unreachable. The diagnostic must not claim a late fire.
  assert.match(unreachable.message, /chord prefix/)
  assert.match(unreachable.message, /never fires/)
  assert.match(unreachable.message, /drops the collected prefix/)
  assert.doesNotMatch(unreachable.message, /only fires after/)
  const delayed = unreachable

  // Effective resolution: the key opens the chord, it does not run the action.
  for (const context of delayed.contexts ?? []) {
    assert.equal(effective(keymap, "\x18", context), "pending", context)
  }
  // The default single-key behaviour is unchanged where no chord claims Ctrl+X.
  assert.equal(effective(createCcKeymap(), "\x18", "editor"), "pending", "Ctrl+X is a prefix by default too")
  assert.equal(effective(createCcKeymap(), "\x01", "editor"), "editor.move.line-start")

  const keymapInstance = createCcKeymap({ bindings: { "editor.move.line-start": "ctrl+x" } })
  const prefixes: Array<string[] | null> = []
  const { editor, events } = makeEditor({ keymap: keymapInstance })
  editor.onChordChange = (prefix) => {
    prefixes.push(prefix)
  }
  editor.setText("abc")
  editor.ccSetCursor(0, 2)
  renderAt(editor, 80)
  editor.handleInput("\x18")
  assert.equal(keymapInstance.isPendingChord(), true, "the single key starts the foreign chord")
  assert.deepEqual(prefixes, [["ctrl+x"]], "the editor reports the foreign chord prefix instead of moving")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 2 })
  assert.deepEqual(events.filter((event) => event.id === "editor.move.line-start"), [])
})

test("R11: an expired chord prefix key is dropped, so the shadowed single binding never fires", async () => {
  const keymap = createCcKeymap({ bindings: { "editor.move.line-start": "ctrl+x" }, chordTimeoutMs: 20 })
  const { editor, events } = makeEditor({ keymap })
  const prefixes: Array<string[] | null> = []
  editor.onChordChange = (prefix) => {
    prefixes.push(prefix)
  }
  editor.setText("abc")
  editor.ccSetCursor(0, 2)
  renderAt(editor, 80)
  press(editor, "\x18") // Ctrl+X: opens app.editor.external's chord, no action
  await sleep(120) // timer fires: expireChord() drops the prefix without dispatching it
  assert.equal(keymap.isPendingChord(), false)
  assert.deepEqual(prefixes.at(-1), null, "the hint clears")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 2 }, "the overdue single binding did not move the caret")
  assert.deepEqual(
    events.filter((event) => event.id === "editor.move.line-start" || event.id === "app.editor.external"),
    [],
    "neither the chord nor the shadowed single key ran: the prefix is unreachable, not delayed",
  )
})

test("the explicitly configured interrupt key is reported against the contexts that check it first", () => {
  // app.interrupt ships unbound (the old Ctrl+C default moved to app.clear);
  // the priority rule and its diagnostics exist only for an explicit override.
  assert.deepEqual(createCcKeymap().getBindings("app.interrupt"), [])
  const keymap = createCcKeymap({ bindings: { "app.interrupt": "alt+g", "queue.send-now": "alt+g" } })
  assert.deepEqual(keymap.getBindings("queue.send-now"), ["alt+g"])
  const blocked = shadows(keymap).find((diagnostic) => diagnostic.action === "queue.send-now")
  assert.ok(blocked, "an override under the interrupt priority is reported")
  assert.equal(blocked.otherAction, "app.interrupt")
  assert.equal(blocked.keys, "alt+g")
  assert.match(blocked.message, /checked before the context chain/)
  assert.ok(blocked.contexts?.includes("queueList"))

  // Effective resolution: the configured interrupt stays global in the
  // priority context, so the queue-local override can never run there...
  for (const context of blocked.contexts ?? []) {
    assert.equal(effective(keymap, "\x1bg", context), "app.interrupt", context)
  }
  // ...and the same shadowing does not touch contexts outside that rule: the
  // editor layer keeps its own Ctrl+G external-editor binding, so Alt+G is
  // simply the configured global interrupt there without a priority takeover.
  assert.equal(effective(keymap, "\x1bg", "editor"), "app.interrupt")
  assert.equal(effective(keymap, "\x07", "editor"), "app.editor.external")

  // The reverse direction: moving `app.interrupt` onto a read-only surface's
  // own key is reported as stealing that surface's key.
  const stolen = createCcKeymap({ bindings: { "app.interrupt": "ctrl+w" } })
  const taken = shadows(stolen).find(
    (diagnostic) => diagnostic.action === "tool.details.wrap" && diagnostic.otherAction === "app.interrupt",
  )
  assert.ok(taken, "the interrupt key stealing a local modal key is reported")
  assert.deepEqual(taken.contexts, ["toolDetails"])
  assert.match(taken.message, /now takes Ctrl\+W away from tool\.details\.wrap/)
  assert.equal(effective(stolen, "\x17", "toolDetails"), "app.interrupt")
})

test("no false positives: shipped mode bindings, restated defaults and default saves stay silent", () => {
  // Shipped composition (baselineBindings declares what the host always binds).
  const shipped = createCcKeymap({ bindings: MODE_BINDINGS, baselineBindings: MODE_BINDINGS })
  assert.deepEqual(shadows(shipped), [], "the host's own mode bindings are not ambiguous overrides")
  assert.deepEqual(
    shipped.getDiagnostics().filter((diagnostic) => diagnostic.severity === "error"),
    [],
  )

  // The app builds the save-time preview as `{ ...modeBindings, ...config }`
  // without declaring a baseline. Those facts are identical on both sides of a
  // save, so the existing "new conflict" diff must stay empty: no save is
  // blocked by a host-composed binding.
  const preview = (config: CcKeymapConfig) => createCcKeymap({ bindings: { ...MODE_BINDINGS, ...config } })
  const before = new Set(preview({}).getConflicts().map((diagnostic) => diagnostic.message))
  for (const config of [
    { "editor.move.line-start": ["home", "ctrl+a"] },
    { "editor.move.line-start": "home", "ctrl+a": undefined },
    { "editor.move.line-start": "ctrl+q" },
    { "app.model.select": "alt+m" },
    { "editor.move.line-start": null },
  ] as CcKeymapConfig[]) {
    const introduced = preview(config)
      .getConflicts()
      .filter((diagnostic) => !before.has(diagnostic.message))
    assert.deepEqual(introduced, [], `no new conflict for ${JSON.stringify(config)}`)
  }

  // Restating an effective default is not a new precedence decision.
  assert.deepEqual(shadows(createCcKeymap({ bindings: { "editor.move.line-start": ["home", "ctrl+a"] } })), [])
  assert.deepEqual(shadows(createCcKeymap({ bindings: { "editor.move.line-start": "home" } })), [])

  // Intentional documented precedence stays silent for every default config,
  // including the mode-bindings composition with the declared baseline.
  assert.deepEqual(createCcKeymap().getConflicts(), [])
  assert.deepEqual(shadows(createCcKeymap({ bindings: { ...MODE_BINDINGS }, baselineBindings: MODE_BINDINGS })), [])

  // A real override on top of the shipped baseline still reports only itself.
  const withOverride = createCcKeymap({
    bindings: { ...MODE_BINDINGS, "app.interrupt": "ctrl+w" },
    baselineBindings: MODE_BINDINGS,
  })
  assert.deepEqual(
    shadows(withOverride)
      .map((diagnostic) => `${diagnostic.action}<${diagnostic.otherAction}`)
      .sort(),
    [
      "app.interrupt<editor.kill.whitespace-backward",
      "editor.kill.whitespace-backward<app.interrupt",
      "tool.details.wrap<app.interrupt",
    ],
  )
})

test("cross-context diagnostics do not replace the existing same-context ones", () => {
  // Same-context duplicate: unchanged, and it is not re-labelled as a
  // cross-context shadow (both bindings live in the same layer).
  const sameContext = createCcKeymap({ bindings: { "list.previous": "j", "list.next": "j" } })
  assert.ok(sameContext.getConflicts().some((diagnostic) => diagnostic.code === "conflict" && diagnostic.context === "list"))
  assert.deepEqual(shadows(sameContext), [])

  // Same-context chord prefix: still exactly one `chord-shadow`, not two.
  const chord = createCcKeymap({ definitions: mod.CC_ACTIONS })
  assert.deepEqual(shadows(chord), [])

  // Diagnostics stay grouped: one override, one message per affected pair,
  // carrying every affected context instead of one message per context.
  const grouped = createCcKeymap({ bindings: { "app.interrupt": "escape" } })
  const escapeShadows = shadows(grouped).filter((diagnostic) => diagnostic.keys === "escape")
  assert.ok(escapeShadows.length >= 2)
  const interruptDead = escapeShadows.filter((diagnostic) => diagnostic.action === "app.interrupt")
  assert.ok(interruptDead.length >= 2, "the dead Escape override is reported for each distinct winner")
  for (const diagnostic of interruptDead) {
    assert.equal(diagnostic.keys, "escape")
    assert.ok((diagnostic.contexts ?? []).length >= 1)
  }
  assert.equal(
    new Set(escapeShadows.map((diagnostic) => `${diagnostic.action}|${diagnostic.otherAction}`)).size,
    escapeShadows.length,
    "no duplicate pair is reported twice",
  )
})
// --- R6: full-sequence (chord vs. chord) analysis ------------------------

/**
 * The context set of a chord conflict: every chain that contains both the
 * editor layer (where the override lives) and the global layer (where the
 * shipped chord lives).
 */
const EDITOR_CHAIN_CONTEXTS: CcContext[] = [
  "editor",
  "autocomplete",
  "dialog",
  "historySearch",
  "modelPickerList",
  "modelPickerSearch",
  "modalSearch",
]

/** The App's save-time conflict diff (`src/app.ts` `saveKeybinding`). */
function saveGateIntroduced(config: CcKeymapConfig): string[] {
  const preview = (extra: CcKeymapConfig) => createCcKeymap({ bindings: { ...MODE_BINDINGS, ...extra } })
  const before = new Set(preview({}).getConflicts().map((diagnostic) => diagnostic.message))
  return preview(config)
    .getConflicts()
    .filter((diagnostic) => !before.has(diagnostic.message))
    .map((diagnostic) => diagnostic.message)
}

test("R6: a chord that reuses a shipped chord on another layer is diagnosed and really steals it", () => {
  const keymap = createCcKeymap({ bindings: { "editor.move.line-start": "ctrl+x ctrl+e" } })
  const stolen = shadows(keymap).find((diagnostic) => diagnostic.action === "app.editor.external")
  assert.ok(stolen, "the identical chord on the global layer is reported as stolen")
  assert.equal(stolen.code, "cross-context-shadow")
  assert.equal(stolen.otherAction, "editor.move.line-start")
  assert.equal(stolen.keys, "ctrl+x ctrl+e", "the whole chord is reported, not just its first key")
  assert.deepEqual([...(stolen.contexts ?? [])].sort(), [...EDITOR_CHAIN_CONTEXTS].sort())
  assert.match(stolen.message, /identical chord/)
  assert.match(stolen.message, /had that chord in the shipped defaults/)

  // Real resolver outcome: the first key is pending in every context that has
  // an editor layer, and the second key completes the override there.
  for (const context of EDITOR_CHAIN_CONTEXTS) {
    const sequence = resolveSequence(keymap, ["\x18", "\x05"], context)
    assert.deepEqual(sequence.kinds, ["pending", "action"], context)
    assert.equal(sequence.action, "editor.move.line-start", context)
    assert.deepEqual(sequence.keys, ["ctrl+x", "ctrl+e"], context)
  }
  // Without an editor layer the shipped global chord still fires.
  const list = resolveSequence(keymap, ["\x18", "\x05"], "list")
  assert.deepEqual(list.kinds, ["pending", "action"])
  assert.equal(list.action, "app.editor.external")

  // The unmodified keymap keeps the shipped owner everywhere.
  const shipped = createCcKeymap()
  assert.equal(resolveSequence(shipped, ["\x18", "\x05"], "editor").action, "app.editor.external")

  // Real dispatch through the one editor state: line start, never the external
  // editor. Then the App's save gate rejects the change instead of accepting it.
  const { editor, events } = makeEditor({ keymap })
  editor.setText("abcdef")
  editor.ccSetCursor(0, 4)
  renderAt(editor, 80)
  press(editor, "\x18")
  press(editor, "\x05")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 }, "the override moved the caret")
  assert.deepEqual(events, [], "the stolen app action never reached the App (editor actions are local)")
  const introduced = saveGateIntroduced({ "editor.move.line-start": "ctrl+x ctrl+e" })
  assert.equal(introduced.length, 1, "one grouped message, not one per context")
  assert.match(introduced[0]!, /identical chord/)
})

test("R6: a chord behind a shorter shipped chord is an unreachable override", () => {
  const keymap = createCcKeymap({ bindings: { "editor.move.line-start": "ctrl+x ctrl+e ctrl+f" } })
  const dead = shadows(keymap).find((diagnostic) => diagnostic.action === "editor.move.line-start")
  assert.ok(dead, "the longer chord can never complete")
  assert.equal(dead.otherAction, "app.editor.external")
  assert.equal(dead.keys, "ctrl+x ctrl+e ctrl+f")
  assert.match(dead.message, /shorter Ctrl\+X Ctrl\+E/)
  assert.match(dead.message, /completes first/)
  assert.match(dead.message, /never fires/)

  // Real resolver: the shorter shipped chord completes at the second key, so the
  // third key is a fresh key (its own binding), never the last chord step.
  const sequence = resolveSequence(keymap, ["\x18", "\x05", "\x06"], "editor")
  assert.deepEqual(sequence.kinds, ["pending", "action", "action"])
  assert.equal(sequence.action, "editor.move.char-right")

  const { editor, events } = makeEditor({ keymap })
  editor.setText("abc")
  editor.ccSetCursor(0, 2)
  renderAt(editor, 80)
  for (const key of ["\x18", "\x05", "\x06"]) press(editor, key)
  assert.deepEqual(events.filter((event) => event.id === "editor.move.line-start"), [])
  assert.deepEqual(events.filter((event) => event.id === "app.editor.external").length, 1)
  assert.notEqual(saveGateIntroduced({ "editor.move.line-start": "ctrl+x ctrl+e ctrl+f" }).length, 0)
})

test("R6: distinct chords sharing a first key are peers, not conflicts", () => {
  // A chord with a new suffix only adds a path to the prefix tree: no binding
  // loses anything, so nothing is reported and the keymap stays usable.
  const keymap = createCcKeymap({ bindings: { "editor.move.line-start": "ctrl+x ctrl+f" } })
  assert.deepEqual(shadows(keymap), [], "a same-prefix sibling is not a conflict")
  assert.deepEqual(saveGateIntroduced({ "editor.move.line-start": "ctrl+x ctrl+f" }), [])

  // Both shipped chords still resolve, and so does the added one.
  assert.equal(resolveSequence(keymap, ["\x18", "\x05"], "editor").action, "app.editor.external")
  assert.equal(resolveSequence(keymap, ["\x18", "\x0f"], "editor").action, "app.tools.details")
  const added = resolveSequence(keymap, ["\x18", "\x06"], "editor")
  assert.deepEqual(added.kinds, ["pending", "action"])
  assert.equal(added.action, "editor.move.line-start")
})

test("R6: restating or rebuilding a shipped chord stays silent", () => {
  // Same effective binding list: `changed` is empty, so no precedence decision
  // was introduced and the save gate stays open.
  assert.deepEqual(shadows(createCcKeymap({ bindings: { "app.editor.external": ["ctrl+g", "ctrl+x ctrl+e"] } })), [])
  assert.deepEqual(saveGateIntroduced({ "app.editor.external": ["ctrl+g", "ctrl+x ctrl+e"] }), [])
  // Replacing the two shipped chords with the chord alone drops Ctrl+G but takes
  // nothing away from another action.
  assert.deepEqual(shadows(createCcKeymap({ bindings: { "app.editor.external": "ctrl+x ctrl+e" } })), [])
  // Reusing the chord for a *different action in the same global layer* is the
  // existing same-context `conflict`, not a second cross-context message.
  const sameLayer = createCcKeymap({ bindings: { "app.queue.open": "ctrl+x ctrl+e" } })
  assert.ok(sameLayer.getConflicts().some((diagnostic) => diagnostic.code === "conflict"))
  assert.deepEqual(shadows(sameLayer), [])
})
