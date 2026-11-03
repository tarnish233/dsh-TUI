# Input API (short report for the app owner)

Source: `src/input/` (owned by the input developer). Import from `src/input/index.ts`.

## Editor

```ts
import { CcEditor } from "./src/input/index.ts"

const editor = new CcEditor(tui, theme, options?) // constructor identical to Pi Editor
editor.onSubmit = (text) => {}                   // as in Pi
editor.onChange = (text) => {}                   // as in Pi
editor.onAction = (event: CcActionEvent) => {}   // app-level actions, see below
```

`CcEditorOptions` extends Pi's `EditorOptions`:

| option | meaning |
| --- | --- |
| `keymap?: CcKeymap` | shared keymap instance (also configurable at runtime) |
| `bindings?: CcKeymapConfig` | shorthand for a keymap with user overrides |
| `chordTimeoutMs?: number` | chord timeout, CC default 3000 ms |
| `context?: CcContext` | editor dispatch context, default `"editor"` |
| `onAction?: (event) => boolean \| void` | app action sink (same as `editor.onAction`) |

Editor methods that matter to the app:

- `getKeymap()` / `setKeymap(keymap)` / `setBindings(config)` – hot-reloadable bindings.
- `captureDraft(): CcDraftSnapshot` – **lossless**: text, cursor, history
  browsing state, kill ring, undo stack, large-paste registry, paste counter.
  Plain JSON; safe to serialize.
- `restoreDraft(snapshot, { notify?: boolean })` – restores the same editor
  instance (one editor state). Calls `onChange` unless `notify: false`.
- `replaceDraftText(text, { cursor? })` – **undoable** whole-draft replacement
  (pushed on the Pi undo stack; old text/cursor/pastes recoverable with
  Ctrl+_). Use it for cleared-draft recall and external-editor return.
- `captureDraftForExternalEditor(): { snapshot, text, cursor }` – `text` has
  large-paste markers expanded (`getExpandedText()` equivalent).
- `applyExternalEdit(text, previousSnapshot?)` – unchanged text restores
  `previousSnapshot`; changed text routes through `replaceDraftText`.
- `getExpandedText()`, `getText()`, `getCursor()`, `getLines()` – inherited Pi.
- `isPasting()`, `flushInputBuffer()` – bracketed-paste reassembly state.
- `onChordChange?: (prefix: string[] | null) => void` – optional key-hint UI.

### `CcActionEvent`

```ts
{ id, key, context, text, expandedText, empty, cursor, isBrowsingHistory, definition? }
```

`key` is the raw terminal data that triggered the action.

## App actions (defaults)

| action | default key(s) | notes |
| --- | --- | --- |
| `app.interrupt` | `ctrl+c` | cancel operation/dialog |
| `app.cancel` | `escape` | editor forwards after closing completion / restoring history draft |
| `app.exit` | `ctrl+d` | editor emits it only when the draft is empty |
| `app.redraw` | `ctrl+l` | preserve draft |
| `app.history.search` | `ctrl+r` | parent UI |
| `app.stash` | `ctrl+s` | CC override, not flow control |
| `app.editor.external` | `ctrl+g`, chord `ctrl+x ctrl+e` | parent editor |
| `app.tools.expand` | `ctrl+o` | CC override |
| `app.todo` | `ctrl+t` | CC Ctrl+T is todo, not transpose |
| `app.thinking.toggle` | (unbound) | DSH/Pi concept; bind explicitly |
| `app.model.select` | `alt+p` | Ctrl+P stays history |
| `app.mode.cycle` | `shift+tab` | legacy config ID retained; executes native `/permission` only, never `/plan` |
| `app.clipboard.pasteImage` | `ctrl+v` | CC override, not quoted-insert |
| `app.suspend` | `ctrl+z` | parent must restore terminal state |
| `app.message.sendNow` | (unbound) | app-state dependent |
| `app.message.followUp` | (unbound) | app-state dependent |
| `app.help` | `f1` | |

Also available for non-editor surfaces (same keymap instance):
`list.previous/next/pageUp/pageDown/first/last/select/cancel/select-digit`,
`dialog.confirm/cancel`, `historySearch.next/previous/accept/cancel`,
`autocomplete.*`.

Plain keys: the frontend can keep using Pi's `getKeybindings().matches` for
non-chord app keys, but then the YAML/JSON override in `CcKeymap` is not in
effect. Preferred: `editor.getKeymap().resolve(data, context)`.

## Keymap

```ts
import { createCcKeymap, CcKeymap, CC_ACTIONS } from "./src/input/index.ts"

const keymap = createCcKeymap({
  bindings: {
    "editor.kill.whitespace-backward": ["ctrl+w"],
    "editor.kill.word-backward": ["alt+backspace", "ctrl+backspace"],
    "app.todo": null,                       // explicitly disabled
    "app.thinking.toggle": "alt+t",         // opt-in binding
  },
  chordTimeoutMs: 3000,
})

keymap.resolve(data, "editor") // -> action | pending | cancelled-chord | none
keymap.expireChord(now?)       // -> expired prefix | null
keymap.cancelChord()
keymap.getDiagnostics()        // errors/warnings: unknown action, invalid key,
                               // duplicate binding, byte ambiguity, chord shadow
keymap.getHelp(context?)       // metadata for Settings/diagnostic consumers
```

- Contexts: `editor`, `autocomplete`, `list`, `dialog`, `historySearch`,
  `global`. Fallback chains (first match wins):
  `autocomplete → editor → global`, `historySearch → editor → global`,
  `dialog → editor → global`, `editor → global`, `list → global`.
  Completion/search keys win locally, but editor editing (Ctrl+A/W/K, Alt+B/F,
  word deletion, undo, …) keeps working underneath. `getFallbackChain(ctx)`
  exposes the chain.
- A binding may be one key or a chord (`"ctrl+x ctrl+e"`).
- Unknown action ids and malformed keys produce error diagnostics and are
  ignored/disable the action; they never silently fall back to a default.
- Disabled/unbound control keys are consumed by `CcEditor`; they do not fall
  through to Pi's editor defaults.
- Ctrl+D exits only when the physical key is still one of the enabled
  `app.exit` bindings. Empty-draft Delete is a no-op; disablng/remapping
  `app.exit` disables Ctrl+D exit (`editor.isActionBoundToKey("app.exit", data)`
  is public for similar contextual checks).
- An open completion menu closes when a non-completion action edits/moves the
  draft (stale prefixes are never shown).
- `list` context binds `j`/`k`/digits; the `editor` context does not, so typing
  in a text field never triggers list navigation.

## Vendored TUI integration (parent action)

The app depends on `file:vendor/pi-tui`, a source-vendored MIT Pi TUI 1.5.0.
`pnpm build:pi-tui` compiles it to `vendor/pi-tui/dist/`; there is no pnpm
patch. `src/input/pi-tui-seam.js` installs the narrow Editor/SelectList entry
points at input-module load. Tests use the same package directly, without a
module loader redirect. `CcEditor` throws an actionable error when the seam is
missing.

## Known gaps / unverified

See `docs/INPUT.md`. Highlights: CC yank-pop legality, PageUp/PageDown inside
the editor, `Ctrl+Shift+R`, `app.message.*`, Mac Option-as-Meta in terminals
that don't send CSI-u, and legacy `^H` ambiguity. No Node readline is used.