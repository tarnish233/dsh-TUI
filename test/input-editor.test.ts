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
import type { AutocompleteProvider } from "@earendil-works/pi-tui"

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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test("Ctrl+W kills a whitespace-delimited path; yank restores it; undo reverts kill and yank", () => {
  const { editor } = makeEditor()
  editor.setText("src/utils/foo.ts")
  renderAt(editor, 80)

  press(editor, "\x17") // Ctrl+W
  assert.equal(editor.getText(), "")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 })
  assert.deepEqual(editor.ccGetKillRing(), ["src/utils/foo.ts"])

  press(editor, "\x19") // Ctrl+Y
  assert.equal(editor.getText(), "src/utils/foo.ts")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 16 })

  // Undo first reverts the yank, then the kill: the full state is preserved.
  press(editor, "\x1f")
  assert.equal(editor.getText(), "")
  press(editor, "\x1f")
  assert.equal(editor.getText(), "src/utils/foo.ts")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 16 })
})

test("Ctrl+W kills whole flags and accumulates into one kill entry", () => {
  const { editor } = makeEditor()
  editor.setText("run --flag=value now")
  renderAt(editor, 80)

  press(editor, "\x17")
  assert.equal(editor.getText(), "run --flag=value ")
  press(editor, "\x17")
  assert.equal(editor.getText(), "run ")
  assert.deepEqual(editor.ccGetKillRing(), ["--flag=value now"])
  press(editor, "\x19")
  assert.equal(editor.getText(), "run --flag=value now")
})

test("Ctrl+W (whitespace) and Alt+Backspace (word) use different boundaries", () => {
  const path = "src/utils/foo.ts"
  const whitespace = makeEditor()
  whitespace.editor.setText(path)
  press(whitespace.editor, "\x17")
  assert.equal(whitespace.editor.getText(), "")

  const word = makeEditor()
  word.editor.setText(path)
  press(word.editor, "\x1b\x7f") // Meta+Backspace (legacy ESC + DEL)
  assert.equal(word.editor.getText(), "src/utils/foo.")
  assert.deepEqual(word.editor.ccGetKillRing(), ["ts"])

  // xterm modifyOtherKeys / Kitty sequences for Alt+Backspace.
  const kitty = makeEditor()
  kitty.editor.setText("foo.bar baz")
  press(kitty.editor, "\x1b[127;3u")
  assert.equal(kitty.editor.getText(), "foo.bar ")
})

test("Meta word movement and Alt+D handle punctuation", () => {
  const { editor } = makeEditor()
  editor.setText("foo.bar baz")
  editor.ccSetCursor(0, 0)

  press(editor, "\x1bf") // Alt+F
  assert.deepEqual(editor.getCursor(), { line: 0, col: 3 })
  press(editor, "\x1bf")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 4 })
  press(editor, "\x1bf")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 7 })

  press(editor, "\x1bb") // Alt+B
  assert.deepEqual(editor.getCursor(), { line: 0, col: 4 })
  press(editor, "\x1bb")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 3 })

  const deleted = makeEditor()
  deleted.editor.setText("foo.bar baz")
  deleted.editor.ccSetCursor(0, 0)
  press(deleted.editor, "\x1bd") // Alt+D
  assert.equal(deleted.editor.getText(), ".bar baz")
  assert.deepEqual(deleted.editor.ccGetKillRing(), ["foo"])
})

test("word boundaries handle Chinese text and CJK punctuation", () => {
  const { editor } = makeEditor()
  editor.setText("你好世界 测试")
  renderAt(editor, 80)

  press(editor, "\x1bb")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 5 })
  press(editor, "\x1bb")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 2 })
  press(editor, "\x1bb")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 })

  const killed = makeEditor()
  killed.editor.setText("你好世界 测试")
  press(killed.editor, "\x1b\x7f")
  assert.equal(killed.editor.getText(), "你好世界 ")
})

test("grapheme-safe movement and deletion (ZWJ emoji, combining marks)", () => {
  const { editor } = makeEditor()
  const family = "👨‍👩‍👧‍👦"
  editor.setText(`a${family}b`)
  const end = editor.getText().length
  editor.ccSetCursor(0, end)

  press(editor, "\x7f") // Backspace: deletes "b"
  assert.equal(editor.getText(), `a${family}`)
  press(editor, "\x7f") // deletes the whole ZWJ grapheme
  assert.equal(editor.getText(), "a")

  const moving = makeEditor()
  moving.editor.setText(`a${family}b`)
  moving.editor.ccSetCursor(0, end)
  press(moving.editor, "\x1b[D") // left
  assert.deepEqual(moving.editor.getCursor(), { line: 0, col: 1 + family.length })
  press(moving.editor, "\x1b[D")
  assert.deepEqual(moving.editor.getCursor(), { line: 0, col: 1 })
  press(moving.editor, "\x1b[3~") // forward delete at the emoji start
  assert.equal(moving.editor.getText(), "ab")

  const combining = makeEditor()
  combining.editor.setText("e\u0301x")
  combining.editor.ccSetCursor(0, 3)
  press(combining.editor, "\x1b[D")
  assert.deepEqual(combining.editor.getCursor(), { line: 0, col: 2 })
  press(combining.editor, "\x7f") // Backspace deletes the whole e+combining mark
  assert.equal(combining.editor.getText(), "x")
})

test("Ctrl+K / Ctrl+U keep kill-ring entries and merge newlines", () => {
  const { editor } = makeEditor()
  editor.setText("ab\ncd")
  editor.ccSetCursor(0, 1)

  press(editor, "\x0b") // Ctrl+K deletes "b"
  assert.equal(editor.getText(), "a\ncd")
  press(editor, "\x0b") // at end of line: kills the newline, merges lines
  assert.equal(editor.getText(), "acd")
  assert.deepEqual(editor.ccGetKillRing(), ["b\n"])

  press(editor, "\x15") // Ctrl+U kills from line start, accumulating the kill
  assert.equal(editor.getText(), "cd")
  assert.deepEqual(editor.ccGetKillRing(), ["ab\n"])

  const atLineStart = makeEditor()
  atLineStart.editor.setText("one\ntwo")
  atLineStart.editor.ccSetCursor(1, 0)
  press(atLineStart.editor, "\x15")
  assert.equal(atLineStart.editor.getText(), "onetwo")
  assert.deepEqual(atLineStart.editor.ccGetKillRing(), ["\n"])
})

test("consecutive kills accumulate; yank-pop cycles older entries", () => {
  const { editor } = makeEditor()
  editor.setText("one two three")
  renderAt(editor, 80)

  press(editor, "\x17") // kill "three"
  press(editor, "\x17") // kill "two " and accumulate
  assert.equal(editor.getText(), "one ")
  assert.deepEqual(editor.ccGetKillRing(), ["two three"])

  typeText(editor, "X")
  press(editor, "\x15") // non-adjacent kill creates a new ring entry
  assert.equal(editor.getText(), "")
  assert.deepEqual(editor.ccGetKillRing(), ["two three", "one X"])

  press(editor, "\x19") // yank "one X"
  assert.equal(editor.getText(), "one X")
  press(editor, "\x1by") // yank-pop -> "two three"
  assert.equal(editor.getText(), "two three")
  press(editor, "\x1by") // wrap around -> "one X"
  assert.equal(editor.getText(), "one X")

  // One undo reverts the last yank-pop but keeps the yank.
  press(editor, "\x1f")
  assert.equal(editor.getText(), "two three")
})

test("yank-pop is a no-op unless it immediately follows a yank", () => {
  const { editor } = makeEditor()
  editor.setText("alpha")
  press(editor, "\x17")
  typeText(editor, "beta")
  press(editor, "\x1by")
  assert.equal(editor.getText(), "beta")

  // With a single kill-ring entry there is nothing to cycle.
  press(editor, "\x19")
  const afterYank = editor.getText()
  press(editor, "\x1by")
  assert.equal(editor.getText(), afterYank)
})

test("CC history: Up on the first visual line browses history without jumping to column 0", () => {
  const { editor } = makeEditor()
  editor.addToHistory("older entry")
  editor.addToHistory("newest entry")
  editor.setText("draft text")
  editor.ccSetCursor(0, 5)
  renderAt(editor, 80)

  press(editor, "\x10") // Ctrl+P
  assert.equal(editor.getText(), "newest entry")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 })

  press(editor, "\x10")
  assert.equal(editor.getText(), "older entry")

  press(editor, "\x0e") // Ctrl+N
  assert.equal(editor.getText(), "newest entry")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 12 }, "newer history entries place the cursor at the end")

  press(editor, "\x0e")
  assert.equal(editor.getText(), "draft text")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 5 }, "draft and cursor are restored")
  assert.equal(editor.ccIsBrowsingHistory(), false)
})

test("multi-line history entries: visual lines move first, history at the boundaries", () => {
  const { editor } = makeEditor()
  editor.addToHistory("line1\nline2")
  editor.addToHistory("newest")
  renderAt(editor, 80)

  press(editor, "\x10") // empty draft -> history
  assert.equal(editor.getText(), "newest")
  press(editor, "\x10")
  assert.equal(editor.getText(), "line1\nline2")
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 })

  // Cursor is on the first visual line of a two-line entry: moving down stays
  // inside the entry.
  press(editor, "\x0e")
  assert.equal(editor.getText(), "line1\nline2")
  assert.deepEqual(editor.getCursor(), { line: 1, col: 0 })

  // On the last visual line Down browses to the newer entry.
  press(editor, "\x0e")
  assert.equal(editor.getText(), "newest")
  press(editor, "\x0e")
  assert.equal(editor.getText(), "")
  assert.equal(editor.ccIsBrowsingHistory(), false)
})

test("wrapped drafts move inside visual lines before browsing history", () => {
  const { editor } = makeEditor()
  editor.addToHistory("HIST")
  editor.setText("alpha beta gamma delta")
  const end = editor.getText().length
  editor.ccSetCursor(0, end)
  const rendered = renderAt(editor, 12)
  const visualLines = rendered.length - 2
  assert.ok(visualLines >= 2, `expected a wrapped draft, got ${visualLines} visual lines`)
  assert.equal(editor.ccIsOnLastVisualLine(), true)

  for (let index = 0; index < visualLines - 1; index += 1) {
    press(editor, "\x10")
    assert.equal(editor.getText(), "alpha beta gamma delta", "Up must not leave the draft yet")
  }
  assert.equal(editor.ccIsOnFirstVisualLine(), true)
  press(editor, "\x10")
  assert.equal(editor.getText(), "HIST")
})

test("Ctrl+A/E/B/F, Home/End and line-wrap movement", () => {
  const { editor } = makeEditor()
  editor.setText("abc\ndef")
  editor.ccSetCursor(0, 1)

  press(editor, "\x05") // Ctrl+E
  assert.deepEqual(editor.getCursor(), { line: 0, col: 3 })
  press(editor, "\x01") // Ctrl+A
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 })
  press(editor, "\x02") // Ctrl+B at start of line -> previous line end
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 })
  press(editor, "\x06") // Ctrl+F
  assert.deepEqual(editor.getCursor(), { line: 0, col: 1 })
  press(editor, "\x1b[F") // End
  assert.deepEqual(editor.getCursor(), { line: 0, col: 3 })
  press(editor, "\x1b[H") // Home
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 })
})

test("Ctrl+H aliases Backspace; Ctrl+D deletes forward and forwards app.exit when empty", () => {
  const { editor, events } = makeEditor()
  editor.setText("ab")
  editor.ccSetCursor(0, 1)
  press(editor, "\x08") // Ctrl+H
  assert.equal(editor.getText(), "b")
  press(editor, "\x04") // Ctrl+D
  assert.equal(editor.getText(), "")
  press(editor, "\x04") // empty draft -> app.exit
  assert.deepEqual(
    events.map((event) => event.id),
    ["app.exit"],
  )
})

test("empty Delete is a no-op; Ctrl+D only exits when app.exit is still bound to it", () => {
  const plain = makeEditor()
  press(plain.editor, "\x1b[3~") // Delete on empty draft
  assert.deepEqual(plain.events, [])
  assert.equal(plain.editor.getText(), "")

  const disabled = makeEditor({ bindings: { "app.exit": null } })
  press(disabled.editor, "\x04") // Ctrl+D on empty draft, app.exit disabled
  assert.deepEqual(disabled.events, [])
  press(disabled.editor, "\x1b[3~") // Delete on empty draft
  assert.deepEqual(disabled.events, [])

  const remapped = makeEditor({ bindings: { "app.exit": "ctrl+q" } })
  press(remapped.editor, "\x04")
  assert.deepEqual(remapped.events, [], "Ctrl+D is no longer the exit key")
  press(remapped.editor, "\x11")
  assert.deepEqual(
    remapped.events.map((event: CcActionEvent) => event.id),
    ["app.exit"],
  )
})

test("completion open: editor editing keys still work, completion keys win", async () => {
  const { editor } = makeEditor()
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
  press(editor, "\x17") // Ctrl+W must still edit while completion is open
  assert.equal(editor.getText(), "")
  assert.equal(editor.isShowingAutocomplete(), false, "stale completion closes after an edit")
  press(editor, "\x01") // Ctrl+A must still move the cursor
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 })
})

test("fragmented bracketed paste is reassembled and never executed as keys", () => {
  const { editor, events } = makeEditor()
  editor.handleInput("\x1b[2")
  editor.handleInput("00~hello")
  assert.equal(editor.isPasting(), true)
  editor.handleInput(" world\x1b[20")
  editor.handleInput("1~")
  assert.equal(editor.isPasting(), false)
  assert.equal(editor.getText(), "hello world")
  assert.deepEqual(events, [])

  // Paste bytes that look like shortcuts stay text (control chars are filtered
  // by Pi's paste path; nothing is dispatched).
  const next = makeEditor()
  next.editor.handleInput("\x1b[200~\x17ctrl+x\x1b[201~")
  assert.equal(next.editor.getText(), "ctrl+x")
  assert.deepEqual(next.events, [])
})

test("large paste becomes a marker, survives snapshot/undo, and submit expands it", () => {
  const { editor } = makeEditor()
  const content = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n")
  editor.handleInput(`\x1b[200~${content}\x1b[201~`)
  assert.match(editor.getText(), /^\[paste #1 \+\d+ lines\]$/)
  assert.equal(editor.getExpandedText(), content)

  press(editor, "\x17") // kill the marker
  assert.equal(editor.getText(), "")
  press(editor, "\x19") // yank restores the same marker
  assert.equal(editor.getExpandedText(), content)

  let submitted: string | undefined
  editor.onSubmit = (text) => {
    submitted = text
  }
  press(editor, "\r")
  assert.equal(submitted, content)
})

test("chord Ctrl+X Ctrl+E forwards app.editor.external; printable cancels a chord", () => {
  const { editor, events, chordPrefixes } = makeEditor()

  press(editor, "\x18") // Ctrl+X
  assert.deepEqual(editor.getKeymap().getPendingChord(), ["ctrl+x"])
  assert.deepEqual(chordPrefixes.at(-1) ?? null, ["ctrl+x"])
  press(editor, "\x05") // Ctrl+E
  assert.deepEqual(
    events.map((event) => event.id),
    ["app.editor.external"],
  )
  assert.equal(editor.getKeymap().isPendingChord(), false)

  press(editor, "\x18")
  press(editor, "b")
  assert.equal(editor.getText(), "b", "the cancelling key is dispatched normally")
  assert.equal(events.length, 1)
})

test("chord expires through the editor timer", async () => {
  const { editor, chordPrefixes } = makeEditor({ chordTimeoutMs: 40 })
  press(editor, "\x18")
  assert.equal(editor.getKeymap().isPendingChord(), true)
  await sleep(300)
  assert.equal(editor.getKeymap().isPendingChord(), false)
  assert.equal(chordPrefixes.at(-1), null)
})

test("CC app overrides emit contextual actions and never insert text", () => {
  const { editor, events } = makeEditor()
  press(editor, "\x14") // Ctrl+T todo
  press(editor, "\x0f") // Ctrl+O tools
  press(editor, "\x16") // Ctrl+V clipboard
  press(editor, "\x13") // Ctrl+S stash
  press(editor, "\x07") // Ctrl+G external editor
  press(editor, "\x0c") // Ctrl+L redraw
  press(editor, "\x12") // Ctrl+R history search
  press(editor, "\x1a") // Ctrl+Z suspend
  press(editor, "\x1bp") // Alt+P model
  press(editor, "\x1b[Z") // Shift+Tab mode
  press(editor, "\x03") // Ctrl+C interrupt
  assert.deepEqual(
    events.map((event) => event.id),
    [
      "app.todo",
      "app.tools.expand",
      "app.clipboard.pasteImage",
      "app.stash",
      "app.editor.external",
      "app.redraw",
      "app.history.search",
      "app.suspend",
      "app.model.select",
      "app.mode.cycle",
      "app.interrupt",
    ],
  )
  assert.equal(editor.getText(), "")
})

test("disabled Ctrl+W does nothing (no Pi fallback); remap moves the action", () => {
  const disabled = makeEditor({
    bindings: { "editor.kill.whitespace-backward": null },
  })
  disabled.editor.setText("foo bar")
  press(disabled.editor, "\x17")
  assert.equal(disabled.editor.getText(), "foo bar")

  const remapped = makeEditor({
    bindings: { "editor.kill.whitespace-backward": "alt+w" },
  })
  remapped.editor.setText("foo bar")
  press(remapped.editor, "\x17")
  assert.equal(remapped.editor.getText(), "foo bar")
  press(remapped.editor, "\x1bw")
  assert.equal(remapped.editor.getText(), "foo ")
})

test("printable input is text in the editor, list bindings never swallow it", () => {
  const { editor, events } = makeEditor()
  typeText(editor, "jk12")
  assert.equal(editor.getText(), "jk12")
  assert.deepEqual(events, [])

  const keymap = editor.getKeymap()
  assert.equal(keymap.resolve("j", "list").kind, "action")
  assert.equal(keymap.resolve("j", "editor").kind, "none")
})

test("submit / newline: Shift+Enter inserts, trailing backslash submits via newline", () => {
  const { editor } = makeEditor()
  let submitted: string | undefined
  editor.onSubmit = (text) => {
    submitted = text
  }
  typeText(editor, "one")
  press(editor, "\x1b[13;2u") // Shift+Enter
  typeText(editor, "two")
  assert.equal(editor.getText(), "one\ntwo")
  press(editor, "\r")
  assert.equal(submitted, "one\ntwo")

  // Backslash + Enter is Pi's fallback for terminals without Shift+Enter.
  typeText(editor, "line\\")
  press(editor, "\r")
  assert.equal(editor.getText(), "line\n")
  assert.equal(submitted, "one\ntwo")
})

test("autocomplete: Ctrl+P/N navigate, Tab accepts, Enter accepts, Escape closes", async () => {
  const { editor } = makeEditor()
  const provider: AutocompleteProvider = {
    triggerCharacters: ["@"],
    async getSuggestions(lines, cursorLine, cursorCol) {
      const before = (lines[cursorLine] ?? "").slice(0, cursorCol)
      const start = before.lastIndexOf("@")
      return {
        items: [
          { value: "@alpha", label: "@alpha" },
          { value: "@beta", label: "@beta" },
          { value: "@gamma", label: "@gamma" },
        ],
        prefix: before.slice(start),
      }
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

  press(editor, "\x0e") // Ctrl+N
  press(editor, "\t") // Tab accepts
  assert.equal(editor.getText(), "@beta")
  assert.equal(editor.isShowingAutocomplete(), false)

  editor.setText("")
  editor.handleInput("@")
  await sleep(60)
  assert.equal(editor.isShowingAutocomplete(), true)
  press(editor, "\x1b")
  assert.equal(editor.isShowingAutocomplete(), false)

  editor.setText("")
  editor.handleInput("@")
  await sleep(60)
  press(editor, "\x10") // Ctrl+P wraps to the last item
  press(editor, "\r") // Enter accepts (plain completion, no submit)
  assert.equal(editor.getText(), "@gamma")
})