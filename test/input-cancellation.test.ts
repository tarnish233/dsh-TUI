/**
 * Focused regressions for review findings R08-R12 in the input subsystem.
 *
 * Everything here is offline: one Pi editor state, keymap + bracket-paste
 * framing only, no model or backend calls.
 */

import test from "node:test"
import assert from "node:assert/strict"

import { asTui, createFakeTui, loadInputModule, renderAt, testEditorTheme } from "../src/input/testing/harness.ts"
import type { CcActionEvent, CcEditorOptions } from "../src/input/index.ts"
import type { AutocompleteProvider } from "#pi-tui"

const mod = await loadInputModule()
type TestEditor = InstanceType<typeof mod.CcEditor>

const LARGE_PASTE = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n")

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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function paste(editor: TestEditor, text: string): void {
  editor.handleInput(`\x1b[200~${text}\x1b[201~`)
}

function actionIds(events: readonly CcActionEvent[]): string[] {
  return events.map((event) => event.id)
}

// --- R08: no-op replacement and marker-aware transpose ------------------

test("R08: no-op replaceDraftText preserves pastes, undo, cursor and chord state", () => {
  const { editor } = makeEditor()
  paste(editor, LARGE_PASTE)
  press(editor, " tail")
  const markerText = editor.getText()
  assert.match(markerText, /^\[paste #1/)
  editor.ccSetCursor(0, 3)
  const depth = editor.ccUndoDepth()
  const pastes = editor.ccGetPastes()

  assert.equal(editor.replaceDraftText(markerText), false)
  assert.equal(editor.getText(), markerText, "text is unchanged")
  assert.equal(editor.getExpandedText(), `${LARGE_PASTE} tail`, "the paste marker is not turned into bare text")
  assert.equal(editor.ccGetPastes().size, 1, "Pi's paste registry survives")
  assert.deepEqual([...editor.ccGetPastes().entries()], [...pastes.entries()])
  assert.equal(editor.ccUndoDepth(), depth, "no undo entry is pushed")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 3 }, "cursor is untouched")

  // Even a cursor hint on a no-op leaves the existing cursor alone.
  assert.equal(editor.replaceDraftText(markerText, { cursor: { line: 0, col: 0 } }), false)
  assert.deepEqual(editor.getCursor(), { line: 0, col: 3 })
  assert.equal(editor.ccGetPastes().size, 1)
})

test("R08: transpose is marker-aware and undoable (never splits a paste marker)", () => {
  const { editor } = makeEditor({ bindings: { "editor.transpose.chars": "ctrl+t" } })
  paste(editor, LARGE_PASTE)
  press(editor, "x")
  editor.ccSetCursor(0, editor.getText().length)
  const before = editor.getText()
  assert.match(before, /^\[paste #1 [^\]]+\]x$/)
  const depth = editor.ccUndoDepth()

  press(editor, "\x14") // Ctrl+T remapped to transpose
  const transposed = editor.getText()
  assert.match(transposed, /^x\[paste #1 [^\]]+\]$/, "the marker stays one atomic marker")
  assert.equal(editor.getExpandedText(), `x${LARGE_PASTE}`)
  assert.equal(editor.ccGetPastes().size, 1, "the paste registry still owns the marker")
  assert.equal(editor.ccUndoDepth(), depth + 1)

  press(editor, "\x1f") // undo
  assert.equal(editor.getText(), before)
  assert.equal(editor.getExpandedText(), `${LARGE_PASTE}x`)
  assert.equal(editor.ccGetPastes().size, 1)
})

test("R08: transpose exchanges graphemes around the cursor", () => {
  const { editor } = makeEditor({ bindings: { "editor.transpose.chars": "ctrl+t" } })
  editor.setText("abcd")
  editor.ccSetCursor(0, 2) // between b and c
  press(editor, "\x14")
  assert.equal(editor.getText(), "acbd")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 3 })
  press(editor, "\x1f")
  assert.equal(editor.getText(), "abcd")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 2 })
})

// --- R09: one chord owner, invalidation, paste and config ---------------

test("R09: spinner invalidate() does not cancel a chord; the timer/hint still expire", async () => {
  const { editor, events, chordPrefixes } = makeEditor({ chordTimeoutMs: 40 })
  editor.setText("abc")
  editor.ccSetCursor(0, 0)
  renderAt(editor, 80)

  press(editor, "\x18") // Ctrl+X
  assert.equal(editor.getKeymap().isPendingChord(), true)
  assert.deepEqual(chordPrefixes.at(-1), ["ctrl+x"])

  for (let index = 0; index < 5; index += 1) editor.invalidate()
  assert.equal(editor.getKeymap().isPendingChord(), true, "render invalidation is not input semantics")
  assert.deepEqual(chordPrefixes.at(-1), ["ctrl+x"])

  await sleep(150)
  assert.equal(editor.getKeymap().isPendingChord(), false)
  assert.equal(chordPrefixes.at(-1), null)

  press(editor, "\x05") // Ctrl+E after the timeout is a fresh line-end key
  assert.deepEqual(editor.getCursor(), { line: 0, col: 3 })
  assert.deepEqual(actionIds(events), [], "an expired chord cannot still complete")
})

test("R09: a fresh key after chord timeout is resolved against the keymap, not the old prefix", async () => {
  const { editor, events } = makeEditor({ chordTimeoutMs: 30 })
  press(editor, "\x18")
  await sleep(120)
  press(editor, "\x05") // would complete Ctrl+X Ctrl+E if the old chord were still usable
  assert.deepEqual(actionIds(events), [])
  assert.equal(editor.getKeymap().isPendingChord(), false)
})

test("R09: bracketed paste cancels a pending chord and pasted bytes never complete it", () => {
  const { editor, events, chordPrefixes } = makeEditor()
  editor.setText("abc")
  editor.ccSetCursor(0, 0)

  press(editor, "\x18") // Ctrl+X pending
  assert.equal(editor.getKeymap().isPendingChord(), true)

  // Fragmented start marker: the chord is cancelled as soon as paste begins.
  editor.handleInput("\x1b[2")
  editor.handleInput("00~he")
  assert.equal(editor.isPasting(), true)
  assert.equal(editor.getKeymap().isPendingChord(), false)
  assert.equal(chordPrefixes.at(-1), null)
  editor.handleInput("llo\x1b[201~")
  assert.equal(editor.isPasting(), false)
  assert.equal(editor.getText(), "helloabc")
  assert.deepEqual(actionIds(events), [], "no Ctrl+X Ctrl+E from pasted/next bytes")

  // The next real Ctrl+E is a fresh line-end key, not a chord completion.
  press(editor, "\x05")
  assert.deepEqual(actionIds(events), [])
  assert.deepEqual(editor.getCursor(), { line: 0, col: 8 })
})

test("R09: paste bytes cannot trigger global actions or chords", () => {
  const { editor, events } = makeEditor()
  press(editor, "\x18") // Ctrl+X
  paste(editor, "\x03\x05safe") // Ctrl+C / Ctrl+E bytes inside the paste
  assert.deepEqual(actionIds(events), [])
  assert.equal(editor.getText(), "safe")
  assert.equal(editor.getKeymap().isPendingChord(), false)

  press(editor, "\x03") // now a real Ctrl+C: Pi-style draft clear, not interrupt
  assert.deepEqual(actionIds(events), ["app.clear"])
})

test("R09: focus and binding/config changes cancel a pending chord consistently", () => {
  const focus = makeEditor()
  press(focus.editor, "\x18")
  assert.equal(focus.editor.getKeymap().isPendingChord(), true)
  focus.editor.focused = false
  assert.equal(focus.editor.getKeymap().isPendingChord(), false)
  assert.equal(focus.chordPrefixes.at(-1), null)

  const rebind = makeEditor()
  press(rebind.editor, "\x18")
  rebind.editor.setBindings({ "app.todo": "ctrl+t" })
  assert.equal(rebind.editor.getKeymap().isPendingChord(), false)
  assert.equal(rebind.chordPrefixes.at(-1), null)

  const swap = makeEditor()
  press(swap.editor, "\x18")
  const replacement = mod.createCcKeymap()
  swap.editor.setKeymap(replacement)
  assert.equal(replacement.isPendingChord(), false)
  assert.equal(swap.chordPrefixes.at(-1), null)

  const context = makeEditor()
  press(context.editor, "\x18")
  context.editor.setActionContext("dialog")
  assert.equal(context.editor.getKeymap().isPendingChord(), false)
  assert.equal(context.chordPrefixes.at(-1), null)
})

test("R09: the keymap is the single chord cancellation/hint notification owner", () => {
  const keymap = mod.createCcKeymap({ chordTimeoutMs: 1000 })
  const changes: Array<readonly string[] | null> = []
  const unsubscribe = keymap.onChordChange((prefix) => changes.push(prefix))

  keymap.resolve("\x18", "editor") // Ctrl+X -> pending
  assert.deepEqual(changes, [["ctrl+x"]])
  keymap.cancelChord()
  assert.deepEqual(changes, [["ctrl+x"], null])
  keymap.cancelChord() // already idle: no duplicate hint event
  assert.deepEqual(changes, [["ctrl+x"], null])

  keymap.resolve("\x18", "editor", 10_000)
  keymap.setBindings({ "app.todo": "ctrl+t" })
  assert.deepEqual(changes, [["ctrl+x"], null, ["ctrl+x"], null])

  unsubscribe()
  keymap.resolve("\x18", "editor")
  assert.equal(changes.length, 4, "unsubscribed listeners no longer fire")
})

// --- R10: non-empty Ctrl+D cannot fall back to app.exit -----------------

test("R10: non-empty Ctrl+D cannot exit when forward-delete is disabled", () => {
  const { editor, events } = makeEditor({ bindings: { "editor.delete.char-forward": null } })
  editor.setText("abc")
  editor.ccSetCursor(0, 0)
  press(editor, "\x04")
  assert.deepEqual(actionIds(events), [], "empty-input exit guard is independent of binding priority")
  assert.equal(editor.getText(), "abc")

  // Still exits on an empty draft because Ctrl+D is the enabled app.exit key.
  editor.replaceDraftText("")
  press(editor, "\x04")
  assert.deepEqual(actionIds(events), ["app.exit"])
})

test("R10: non-empty Ctrl+D cannot exit when forward-delete is rebound", () => {
  const { editor, events } = makeEditor({ bindings: { "editor.delete.char-forward": "ctrl+q" } })
  editor.setText("abc")
  editor.ccSetCursor(0, 0)
  press(editor, "\x04")
  assert.deepEqual(actionIds(events), [])
  assert.equal(editor.getText(), "abc")

  press(editor, "\x11") // the new forward-delete binding
  assert.equal(editor.getText(), "bc")
  assert.deepEqual(actionIds(events), [])
})

test("R10: a remapped app.exit still only exits on an empty draft", () => {
  const { editor, events } = makeEditor({ bindings: { "app.exit": "ctrl+q" } })
  editor.setText("abc")
  press(editor, "\x11")
  assert.deepEqual(actionIds(events), [], "Ctrl+Q only exits on an empty draft")
  assert.equal(editor.getText(), "abc")

  editor.replaceDraftText("")
  press(editor, "\x11")
  assert.deepEqual(actionIds(events), ["app.exit"])
})

// --- R11: character jump ------------------------------------------------

test("R11: jump only accepts the target character; control keys go back to CcKeymap", () => {
  const { editor } = makeEditor()
  editor.setText("@a@b@c")
  editor.ccSetCursor(0, 0)
  press(editor, "\x1d") // Ctrl+] jump forward
  assert.equal(editor.ccGetJumpMode(), "forward")
  press(editor, "@")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 2 })
  assert.equal(editor.ccGetJumpMode(), null)

  // Control key cancels the jump and is then handled by the CC keymap.
  press(editor, "\x1d")
  assert.equal(editor.ccGetJumpMode(), "forward")
  press(editor, "\x05") // Ctrl+E: line end, not a Pi fallback
  assert.equal(editor.ccGetJumpMode(), null)
  assert.deepEqual(editor.getCursor(), { line: 0, col: 6 })

  // Pressing the jump key again cancels without re-arming.
  press(editor, "\x1d")
  press(editor, "\x1d")
  assert.equal(editor.ccGetJumpMode(), null)
})

test("R11: Ctrl+W after jump uses CC whitespace kill, honouring remaps", () => {
  const defaults = makeEditor()
  defaults.editor.setText("src/utils/foo.ts")
  defaults.editor.ccSetCursor(0, defaults.editor.getText().length)
  press(defaults.editor, "\x1d")
  press(defaults.editor, "\x17") // Ctrl+W cancels jump, then CC whitespace kill
  assert.equal(defaults.editor.getText(), "")
  assert.deepEqual(defaults.editor.ccGetKillRing(), ["src/utils/foo.ts"])

  const remapped = makeEditor({ bindings: { "editor.kill.whitespace-backward": "alt+w" } })
  remapped.editor.setText("src/utils/foo.ts")
  remapped.editor.ccSetCursor(0, remapped.editor.getText().length)
  press(remapped.editor, "\x1d")
  press(remapped.editor, "\x17") // no longer bound: must not fall back to Pi word delete
  assert.equal(remapped.editor.getText(), "src/utils/foo.ts")
  assert.equal(remapped.editor.ccGetJumpMode(), null)
  assert.deepEqual(remapped.editor.ccGetKillRing(), [])

  press(remapped.editor, "\x1bw") // the configured binding still kills
  assert.equal(remapped.editor.getText(), "")
})

// --- R12 / cancellation UX: Esc contextual, Ctrl+C global ---------------

test("R12: Esc restoring the history draft is consumed and does not emit app.cancel", () => {
  const { editor, events, chordPrefixes } = makeEditor()
  editor.addToHistory("older entry")
  editor.addToHistory("newest entry")
  editor.setText("my draft")
  editor.ccSetCursor(0, 3)
  renderAt(editor, 80)

  press(editor, "\x10") // Ctrl+P browses newest
  assert.equal(editor.ccIsBrowsingHistory(), true)
  assert.equal(editor.getText(), "newest entry")

  press(editor, "\x1b") // Esc restores the draft, local layer consumed it
  assert.equal(editor.ccIsBrowsingHistory(), false)
  assert.equal(editor.getText(), "my draft")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 3 })
  assert.deepEqual(actionIds(events), [], "restoring a draft must not interrupt/cancel the app")
  assert.equal(chordPrefixes.length, 0)

  press(editor, "\x1b") // no local layer left: now the app gets app.cancel
  assert.deepEqual(actionIds(events), ["app.cancel"])
})

test("R12: cancellation UX — completion Esc is local, Ctrl+C clears the root draft once", async () => {
  const { editor, events } = makeEditor()
  const provider: AutocompleteProvider = {
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
  editor.setAutocompleteProvider(provider)
  editor.handleInput("@")
  await sleep(60)
  assert.equal(editor.isShowingAutocomplete(), true)

  press(editor, "\x1b") // Esc closes completion only
  assert.equal(editor.isShowingAutocomplete(), false)
  assert.deepEqual(actionIds(events), [])

  editor.handleInput("@")
  await sleep(60)
  assert.equal(editor.isShowingAutocomplete(), true)
  // Installed Pi CustomEditor checks Ctrl+C before base autocomplete
  // handling: the entire root draft clears once and the stale menu closes.
  press(editor, "\x03")
  assert.equal(editor.isShowingAutocomplete(), false, "the cleared draft closes the stale menu")
  assert.deepEqual(actionIds(events), ["app.clear"], "one root clear, not a completion-only cancel")

  // Ctrl+C while browsing root history is the Pi-style clear action: the App
  // receives app.clear and owns the draft replacement/exit arm. It is not a
  // hidden interrupt and no local draft restore silently swallows the key.
  editor.ccCancelAutocomplete()
  editor.addToHistory("history entry")
  editor.replaceDraftText("draft")
  press(editor, "\x10")
  assert.equal(editor.ccIsBrowsingHistory(), true)
  events.length = 0
  press(editor, "\x03")
  assert.deepEqual(actionIds(events), ["app.clear"])
})

test("R12: Ctrl+C clears once through a pending chord and jump mode", () => {
  const chord = makeEditor()
  press(chord.editor, "\x18") // Ctrl+X pending
  press(chord.editor, "\x03")
  assert.equal(chord.editor.getKeymap().isPendingChord(), false)
  assert.deepEqual(actionIds(chord.events), ["app.clear"], "the prefix is dropped and clear fires once")
  assert.equal(chord.chordPrefixes.at(-1), null)

  const jump = makeEditor()
  press(jump.editor, "\x1d") // jump mode
  press(jump.editor, "\x03")
  assert.equal(jump.editor.ccGetJumpMode(), null)
  assert.deepEqual(actionIds(jump.events), ["app.clear"], "jump cancel and clear produce one action")
})
test("R11: Backspace (DEL) during jump cancels the jump and deletes through CcKeymap", () => {
  const { editor } = makeEditor()
  editor.setText("abc")
  editor.ccSetCursor(0, 3)

  press(editor, "\x1d") // Ctrl+] jump forward
  assert.equal(editor.ccGetJumpMode(), "forward")
  press(editor, "\x7f") // DEL: must not become a jump target
  assert.equal(editor.ccGetJumpMode(), null)
  assert.equal(editor.getText(), "ab", "CC backward delete ran after the jump was cancelled")

  // Forward Delete (legacy ESC[3~) also cancels and then deletes.
  editor.setText("abc")
  editor.ccSetCursor(0, 0)
  press(editor, "\x1d")
  editor.handleInput("\x1b[3~")
  assert.equal(editor.ccGetJumpMode(), null)
  assert.equal(editor.getText(), "bc")
})

test("dispose is idempotent and detaches only this editor from a shared keymap", () => {
  const keymap = mod.createCcKeymap()
  const first = makeEditor({ keymap })
  const second = makeEditor({ keymap })

  press(first.editor, "\x18")
  assert.equal(keymap.isPendingChord(), true)
  assert.deepEqual(first.chordPrefixes.at(-1), ["ctrl+x"])
  assert.deepEqual(second.chordPrefixes.at(-1), ["ctrl+x"], "all live editors observe the shared keymap")

  first.editor.dispose()
  first.editor.dispose() // idempotent
  assert.equal(keymap.isPendingChord(), false)
  assert.equal(first.chordPrefixes.at(-1), null)

  const disposedEvents = first.chordPrefixes.length
  press(second.editor, "\x18")
  assert.equal(keymap.isPendingChord(), true)
  assert.deepEqual(second.chordPrefixes.at(-1), ["ctrl+x"], "the other editor stays attached")
  assert.equal(first.chordPrefixes.length, disposedEvents, "the disposed editor is not notified")

  second.editor.dispose()
  assert.equal(keymap.isPendingChord(), false)
})

test("setKeymap with the same instance re-attaches instead of disposing the editor", () => {
  const { editor, events, chordPrefixes } = makeEditor()
  const keymap = editor.getKeymap()
  editor.setKeymap(keymap)
  press(editor, "\x18") // Ctrl+X
  assert.equal(keymap.isPendingChord(), true)
  assert.deepEqual(chordPrefixes.at(-1), ["ctrl+x"])
  press(editor, "\x05") // Ctrl+E completes the chord
  assert.deepEqual(actionIds(events), ["app.editor.external"])
  assert.equal(keymap.isPendingChord(), false)
})

test("disposing an inactive editor does not cancel the focused editor's shared-keymap chord", () => {
  const keymap = mod.createCcKeymap()
  const hidden = makeEditor({ keymap })
  const prompt = makeEditor({ keymap })

  press(prompt.editor, "\x18") // prompt owns Ctrl+X
  assert.equal(keymap.isPendingChord(), true)
  assert.deepEqual(prompt.chordPrefixes.at(-1), ["ctrl+x"])

  hidden.editor.dispose() // inactive hidden question editor closes asynchronously
  assert.equal(keymap.isPendingChord(), true, "the prompt's chord still belongs to the prompt")
  assert.deepEqual(prompt.chordPrefixes.at(-1), ["ctrl+x"], "the prompt hint is not cleared")

  // A late focus/teardown callback on the disposed editor is inert too.
  hidden.editor.focused = false
  hidden.editor.cancelChord()
  assert.equal(keymap.isPendingChord(), true)
  assert.deepEqual(prompt.chordPrefixes.at(-1), ["ctrl+x"])

  press(prompt.editor, "\x05") // the chord can still complete
  assert.deepEqual(actionIds(prompt.events), ["app.editor.external"])
  assert.equal(keymap.isPendingChord(), false)

  // The active owner disposing still cancels its own pending chord.
  press(prompt.editor, "\x18")
  assert.equal(keymap.isPendingChord(), true)
  prompt.editor.dispose()
  assert.equal(keymap.isPendingChord(), false)
  assert.equal(prompt.chordPrefixes.at(-1), null, "owner disposal clears its own hint")
  prompt.editor.dispose() // idempotent
})
