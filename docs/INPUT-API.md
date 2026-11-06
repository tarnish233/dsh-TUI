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
| `imageBudgets?: Partial<CcImageBudgets>` | in-memory image payload budget overrides (tests/constrained hosts) |

Editor methods that matter to the app:

- `getKeymap()` / `setKeymap(keymap)` / `setBindings(config)` – hot-reloadable bindings.
- `captureDraft(): CcDraftSnapshot` – **lossless**: text, cursor, history
  browsing state, kill ring, undo stack, large-paste registry, paste counter.
  Plain JSON; safe to serialize.
- `restoreDraft(snapshot, { notify?: boolean })` – restores the same editor
  instance (one editor state). Calls `onChange` unless `notify: false`.
- `replaceDraftText(text, { cursor? })` – **undoable** whole-draft replacement
  (pushed on the Pi undo stack; old text/cursor/pastes recoverable with
  Ctrl+_). Use it for cleared-draft recall and external-editor return. An
  unchanged text returns `false` without touching Pi state (paste registry,
  undo stack and cursor stay intact).
- `captureDraftForExternalEditor(): { snapshot, text, cursor }` – `text` has
  large-paste markers expanded (`getExpandedText()` equivalent).
- `applyExternalEdit(text, previousSnapshot?)` – unchanged text restores
  `previousSnapshot`; changed text routes through `replaceDraftText`.
- `getContext(): CcContext` / `setContext(context)` / `getActionContext()` /
  `setActionContext(context)` – switch the same editor between action contexts
  (e.g. `modelPickerList` ↔ `modelPickerSearch`) without touching text,
  cursor, undo, kill ring, history or pastes. A real switch cancels only a
  pending chord opened by this editor; another editor's chord on a shared
  keymap is left alone. See `docs/MODEL-INPUT-API.md`.
- `printableInput(data): string | undefined` (module export) – decode a raw
  terminal chunk as printable text for text-field routing (plain/Shift Kitty
  CSI-u included; Ctrl/Alt keys, ESC sequences, C0 and DEL return undefined).
  Pure helper; does not mutate the editor.
- `getExpandedText()`, `getText()`, `getCursor()`, `getLines()` – inherited Pi.
- `isPasting()`, `flushInputBuffer()` – bracketed-paste reassembly state.
- `cancelChord()` – one cancellation entry point: clears the chord timer and
  the keymap's pending prefix, notifying `onChordChange` once.
- `dispose()` – idempotent teardown: clears this editor's chord timer, detaches
  only this editor's listener from a shared keymap, and cancels the shared
  pending chord **only if this editor opened it** (keymap generation match).
  Disposing a hidden/inactive question editor therefore does not clear or
  break the focused prompt's chord; later focus/`cancelChord()` callbacks on
  the disposed editor are inert. Other live editors keep their listeners.
  Call it when the App replaces the editor or a question/dialog closes.
  `setKeymap(sameInstance)` is not teardown (it re-attaches).
- `onChordChange?: (prefix: string[] | null) => void` – optional key-hint UI.
  The keymap owns transitions (open, complete, cancel, mismatch, timeout); a
  render/`invalidate()` spinner refresh never changes chord state.

### Image attachments (CC-style, memory only)

```ts
import type { ImageUploadPart } from "./src/ui/image-view.ts"

editor.insertImage(image: ImageUploadPart): number            // -> [Image #N] marker id
editor.getImageAttachments(): Array<{ id: number; image: ImageUploadPart }>
editor.hasImageAttachments(): boolean
editor.getPromptContent(): PromptContentPart[]                // ordered text/image parts
editor.onSubmitContent?: (payload: CcSubmitPayload) => void
editor.onSubmitBlocked?: (error: Error) => void
```

- One editor state: the draft keeps an atomic `[Image #N]` marker; the encoded
  upload lives in the editor's in-memory payload registry. Nothing image-related
  is ever written to `history.json` or any durable draft file.
- Markers behave like large-paste markers: cursor movement, Backspace/Delete,
  Ctrl+W / Alt+Backspace, Ctrl+U/K, transpose and word motion treat the whole
  marker as one unit, so a kill can never split it into bare text.
- The registry is monotonic and append-only per editor instance: marker ids are
  never reused. Deleting a marker keeps its payload (undo, kill/yank), and ids
  allocated after a snapshot was captured stay reserved when an older snapshot
  is restored. Marker ids that arrive from outside the editor (restored text or
  persisted history) raise the same high-water mark, so a later paste can never
  take an id an older history entry already points at. Once the id reaches
  `Number.MAX_SAFE_INTEGER`, `insertImage` throws instead of wrapping.
- Unknown markers are **never** upgraded to attachments. A draft containing
  `[Image #N]` without an upload (a history entry restored from `history.json`,
  or hand-typed text) is kept verbatim and cannot be sent as text only.
- Ordered content, no hidden de-duplication: every visible marker occurrence
  produces its own image part at its own position, so `A [Image #1] B [Image #1]
  C` sends text/image/text/image/text with the same upload referenced twice.
  DSH's content-addressed store de-duplicates bytes; the input layer never
  rewrites the prompt. `getImageAttachments()` lists the same occurrences.
- Bounded memory without losing undo: payloads still reachable from the **real**
  native state — current draft, every undo-stack entry, the kill ring, the
  pre-browsing history draft — plus ids referenced by the in-session history
  registry are never reclaimed. Only payloads nothing can reach are dropped
  (newest kept, capped by `imageBudgets.sparePayloads`); the history registry is
  trimmed oldest-first (`imageBudgets.historyBytes`, max 100 entries). When the
  protected set itself would exceed `imageBudgets.liveBytes`, `insertImage`
  throws `CcImageBudgetError` before touching the draft, so a new paste is
  refused instead of destroying an image that Ctrl+_ / Ctrl+Y can restore.

Submit contract (all paths: Enter, backslash-Enter, `ccSubmit`, autocomplete
confirm):

| situation | behaviour |
| --- | --- |
| `onSubmitContent` set | payload delivered after the draft is cleared, `onSubmit` is not also called |
| no `onSubmitContent`, no images | legacy `onSubmit(text)` unchanged |
| no `onSubmitContent`, draft has images | blocked: `onSubmitBlocked(error)`, draft preserved |
| unresolved marker in the draft | blocked: `onSubmitBlocked(CcUnresolvedImageMarkerError)`, draft preserved |

```ts
interface CcSubmitPayload {
  text: string                              // draft text with visible [Image #N] markers, pastes expanded
  content: readonly PromptContentPart[]     // image parts replace their marker in place
  snapshot: CcDraftSnapshot                 // full pre-clear state, images included (memory only)
  images: readonly { id: number; image: ImageUploadPart }[]
  wasBrowsingHistory: boolean
}
```

`getPromptContent()` throws `CcUnresolvedImageMarkerError` (`.markerIds`) for
markers without an upload; `content` never contains `[Image #N]` text, and an
image-only draft is a valid submit (no dependence on trimmed text). The app
restores `payload.snapshot` with `restoreDraft()` when native admission fails.

### `CcActionEvent`

```ts
{ id, key, context, text, expandedText, empty, cursor, isBrowsingHistory, definition? }
```

`key` is the raw terminal data that triggered the action.

## App actions (defaults)

| action | default key(s) | notes |
| --- | --- | --- |
| `app.interrupt` | `ctrl+c` | global interrupt; completion/jump/pending/dialog UI cannot swallow it (paste bytes are not keys) |
| `app.cancel` | `escape` | contextual fallback: editor closes completion and restores the history-browsing draft first, then forwards |
| `app.exit` | `ctrl+d` | editor emits it only when the draft is empty; this guard is independent of binding priority |
| `app.redraw` | `ctrl+l` | preserve draft |
| `app.history.search` | `ctrl+r` | parent UI |
| `app.stash` | `ctrl+s` | CC override, not flow control |
| `app.editor.external` | `ctrl+g`, chord `ctrl+x ctrl+e` | parent editor |
| `app.tools.expand` | `ctrl+o` | CC override |
| `app.tools.details` | `ctrl+x ctrl+o` | TUI extension (DSH TUI capability, not a verified CC default); opens the tools inspector on the latest tool and is forwarded through `CcEditor` APP_FALLBACK actions to the App. Plain Ctrl+O stays expand/collapse. |
| `tool.details.previous-tool` | `[`, `alt+left` | `toolDetails` only; ASCII `[` and Alt+Left stay text/word motion in the editor |
| `tool.details.next-tool` | `]`, `alt+right` | `toolDetails` only; ASCII `]` and Alt+Right stay text/word motion in the editor |
| `tool.details.next-section` | `tab`, `right` | `toolDetails` only |
| `tool.details.previous-section` | `shift+tab`, `left` | `toolDetails` only; cannot cycle permission presets while the modal owns the key |
| `tool.details.copy` | `c` | `toolDetails` only; `c` stays plain text in the main editor |
| `app.todo` | `ctrl+t` | CC Ctrl+T is todo, not transpose |
| `app.thinking.toggle` | (unbound) | DSH/Pi concept; bind explicitly |
| `app.model.select` | `alt+p` | Ctrl+P stays history |
| `app.mode.cycle` | `shift+tab` | legacy config ID retained; executes native `/permission` only, never `/plan` |
| `app.clipboard.pasteImage` | `ctrl+v` (`alt+v` added on Windows/WSL) | CC override, not quoted-insert; the platform alias never replaces an existing binding and a user override wins |
| `app.images.details` | `ctrl+x ctrl+i` | TUI extension; opens the image viewer. Plain Ctrl+I stays completion |
| `image.details.previous-image` | `[`, `alt+left` | `imageDetails` only; stays plain text/word motion in the editor |
| `image.details.next-image` | `]`, `alt+right` | `imageDetails` only; stays plain text/word motion in the editor |
| `image.details.close` | `escape` | `imageDetails` only; wins over `list.cancel` for Esc |
| `app.suspend` | `ctrl+z` | parent must restore terminal state; see `docs/INPUT-LIFECYCLE.md` |
| `app.message.sendNow` | (unbound) | app-state dependent |
| `app.message.followUp` | (unbound) | app-state dependent |
| `app.help` | `f1` | |

Also available for non-editor surfaces (same keymap instance):
`list.previous/next/pageUp/pageDown/first/last/select/cancel/select-digit`,
`dialog.confirm/cancel`, `historySearch.next/previous/accept/cancel`,
`autocomplete.*`, `model.provider.previous/next/previousArrow/nextArrow`.
The /model picker contract (contexts, text-first query routing, provider
navigation) is documented in `docs/MODEL-INPUT-API.md`.

The tool-details modal uses the `toolDetails` context
(`toolDetails → list → dialog → global`; **no `editor` fallback**). It reuses
`list.*` for scrolling and `list.cancel` for close, so a read-only details
pane never receives editor movement/kill/undo actions, and `CcEditor` in this
context consumes unbound printable bytes instead of inserting them. The
inspector opens on the latest tool; `tool.details.previous-tool` /
`next-tool` browse the panel. Pi parses legacy ESC-b/ESC-f as Alt+Left/Right
reads, so those bytes also navigate tools inside `toolDetails`; in the editor
they remain word motion. All six tool-details actions appear in the same
grouped Settings shortcut list and use the same single `keybindings.json`
override map; there is no modal-specific config.
In `toolDetails` (as in the two picker contexts) the configured simple
`app.interrupt` key wins even while a chord is pending. The App owns the
interrupt handler/DSH cancellation; the input layer only emits `app.interrupt`.

The image-details viewer uses the `imageDetails` context
(`imageDetails → list → dialog → global`; **no `editor` fallback**), exactly like
`toolDetails`: Esc closes the viewer (not `list.cancel`), the configured
`app.interrupt` key always wins (even mid-chord), and `CcEditor` in this context
discards printable input, editing bytes and bracketed paste instead of inserting
them. All three viewer actions appear in the same grouped Settings list and use
the same single override map.

Plain keys: the frontend can keep using Pi's `getKeybindings().matches` for
non-chord app keys, but then the YAML/JSON override in `CcKeymap` is not in
effect. Preferred: `editor.getKeymap().resolve(data, context)`.

## Keymap

```ts
import { createCcKeymap, CcKeymap, CC_ACTIONS } from "./src/input/index.ts"

const keymap = createCcKeymap({
  platform: detectKeybindingPlatform(),   // "posix" | "windows" | "wsl"; defaults to the process
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
keymap.getPendingChordGeneration() // ownership token (null when idle)
keymap.cancelChord()           // notifies onChordChange(null) when it was pending
keymap.onChordChange((prefix) => {}) // subscribe; returns unsubscribe
keymap.getDiagnostics()        // errors/warnings: unknown action, invalid key,
                               // duplicate binding, byte ambiguity, chord shadow
keymap.getHelp(context?)       // metadata for Settings/diagnostic consumers
```

- Contexts: `editor`, `autocomplete`, `list`, `dialog`, `historySearch`,
  `modelPickerList`, `modelPickerSearch`, `toolDetails`, `global`. Fallback
  chains (first match wins): `autocomplete → editor → global`,
  `historySearch → editor → global`, `dialog → editor → global`,
  `editor → global`, `list → global`,
  `modelPickerList → list → editor → global`,
  `modelPickerSearch → editor → global`,
  `toolDetails → list → dialog → global` (deliberately no editor layer).
  Completion/search keys win locally, but editor editing (Ctrl+A/W/K, Alt+B/F,
  word deletion, undo, …) keeps working underneath. `getFallbackChain(ctx)`
  exposes the chain.
- A binding may be one key or a chord (`"ctrl+x ctrl+e"`).
- Unknown action ids and malformed keys produce error diagnostics and are
  ignored/disable the action; they never silently fall back to a default.
- Disabled/unbound control keys are consumed by `CcEditor`; they do not fall
  through to Pi's editor defaults.
- Ctrl+D exits only when the draft is empty, even after forward-delete is
  disabled or rebound (the global `app.exit` fallback keeps the empty guard).
  Empty-draft Delete is a no-op; disabling/remapping `app.exit` also disables
  Ctrl+D exit (`editor.isActionBoundToKey("app.exit", data)` is public for
  similar contextual checks).
- Ctrl+C is a global keymap action, not a hardcoded branch. Esc closes local
  completion/history state first and a consumed local Esc does not also emit
  `app.cancel`.
- Character jump consumes only a real target character; control keys (including
  DEL/Backspace and escape sequences) cancel the jump and continue through the
  same `CcKeymap` (Ctrl+W stays whitespace kill, Backspace stays CC backward
  delete, remaps/disabled actions still apply).
- An open completion menu closes when a non-completion action edits/moves the
  draft (stale prefixes are never shown).
- `list` context binds `j`/`k`/digits; the `editor` context does not, so typing
  in a text field never triggers list navigation. In the `CcEditor` picker path
  (`modelPickerList`/`modelPickerSearch`) a plain printable chunk with no
  pending chord is inserted into the query before the keymap is consulted;
  raw `keymap.resolve("j", "modelPickerList")` still reports `list.next` for
  custom list components. Only picker contexts get this text-first routing.
- In picker contexts and `toolDetails` the configured simple
  `app.interrupt` key keeps priority over local bindings (e.g. `list.cancel`
  Ctrl+C) **and over a pending chord**. The chord is cancelled and
  `app.interrupt` is dispatched, so the modal/picker cannot swallow Ctrl+C.
  Disabled provider actions never fall through to a generic `editor.complete`
  event in the picker (only `model.provider.*` events may change the provider
  group).

## Vendored TUI integration (parent action)

The app depends on `file:vendor/pi-tui`, a source-vendored MIT Pi TUI 1.5.0,
resolved through the single `#pi-tui` package-import seam (`#pi-tui` →
`./vendor/pi-tui/dist/index.js`, `#pi-tui/package.json` → the vendor manifest) so
a DSH installation cannot resolve a different `@earendil-works/pi-tui` copy.
`pnpm build:pi-tui` compiles the vendor sources to `vendor/pi-tui/dist/`; there is
no pnpm patch. `src/input/pi-tui-seam.js` installs the narrow Editor/SelectList
entry points at input-module load. Tests use the same seam directly, without a
module loader redirect. `CcEditor` throws an actionable error when the seam is
missing.

Terminal ownership, start/stop, raw-mode restore, exit hooks and the disposed
-editor contract are in `docs/INPUT-LIFECYCLE.md`
(`test/input-lifecycle.test.ts`).

## Known gaps / unverified

See `docs/INPUT.md`. Highlights: CC yank-pop legality, PageUp/PageDown inside
the editor, `Ctrl+Shift+R`, `app.message.*`, Mac Option-as-Meta in terminals
that don't send CSI-u, and legacy `^H` ambiguity. No Node readline is used.