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
editor.getPromptContent(): PromptContentPart[]                // ordered text/image/file parts
editor.onSubmitContent?: (payload: CcSubmitPayload) => void
editor.onSubmitBlocked?: (error: Error) => void
```

### File attachments (native refs, memory only)

```ts
import type { FileAttachmentRef, PromptContentPart } from "./src/backend/types.ts"

/** The shared `PromptContentPart.file` member (parent-owned native shape). */
type CcFilePromptPart = Extract<PromptContentPart, { type: "file" }>
// { type: "file", attachment: { attachmentId, name, bytes } }

editor.insertFile(upload: { part: CcFilePromptPart } | CcFilePromptPart): number // -> [File #N]
editor.addFile(same): number                                  // alias of insertFile
editor.getFileAttachments(): Array<{ id: number; part: CcFilePromptPart; attachment: FileAttachmentRef }>
editor.hasFileAttachments(): boolean
editor.getAttachmentOccurrences(): CcAttachmentOccurrence[]   // mixed image/file, draft order
editor.getAttachmentCounts(): { images: number; files: number }
```

- `[File #N]` is a **file** marker: its own atomic marker family, its own
  monotonic id space and its own registry — never a relabelled image. Marker
  atomicity/undo/kill/yank/history/snapshot behaviour is identical to images.
- The parent stages bytes (`Backend.stageFile({ data, name })` → durable
  `FileAttachmentRef`) and passes the ready part; the input layer never reads a
  file/path/URL, never calls `readImage` for a file and never attaches pasted
  path text. `/attach <local path>` is an explicit App action.
- A durable native `FileBlock` ref recalled from the DSH queue is already
  admissible: re-insert the ready part (`{ type: "file", attachment: ref }`)
  directly — no `readFile`/`readImage`, no bytes, no re-upload.
- Ids are never reused. A hand-typed `[File #N]` reserves its id before the next
  `insertFile` (so a new attachment can never silently resolve marker text it
  did not come from); the typed marker itself stays unresolved and blocks the
  send with `CcUnresolvedFileAttachmentError` (`.markerIds`).
- Empty files are valid (`bytes: 0`). Metadata (`name`, `bytes`) is display data
  only; the attachment id is opaque. Malformed parts/refs throw before the draft
  changes (`asCcFileUpload`/`isCcFilePromptPart` are exported for hosts).
- The shared attachment budget (`imageBudgets`, name kept for compatibility) now
  bounds both families and measures what the editor holds, not the declared file
  size; refusal is `CcFileBudgetError` before any draft edit.

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

Submit contract (all paths: Enter, backslash-Enter, autocomplete confirm, and a
direct `editor.ccSubmit()` — the App uses the latter for send-now, steer,
follow-up and queue delivery):

| situation | behaviour |
| --- | --- |
| `onSubmitContent` set | payload delivered after the draft is cleared, `onSubmit` is not also called |
| no `onSubmitContent`, no attachments | legacy `onSubmit(text)` unchanged |
| no `onSubmitContent`, draft has images **or files** | blocked: `onSubmitBlocked(error)`, draft preserved |
| unresolved image/file marker in the draft | blocked: `onSubmitBlocked(CcUnresolvedImageMarkerError)` / `CcUnresolvedFileAttachmentError`, draft preserved |

`ccSubmit()` is overridden in `CcEditor` so every submit entry point captures the
same pre-clear payload. A direct App call can therefore never hand literal
`[Image #N]`/`[File #N]` marker text to the plain `onSubmit(text)` consumer while
the draft holds attachments; production installs both consumers, and only the
multipart one can receive an attachment draft. `pendingSubmit` is set exactly
while one capture is in flight, so a re-entrant call is not captured twice.

```ts
interface CcSubmitPayload {
  text: string                              // draft text with visible attachment markers, pastes expanded
  content: readonly PromptContentPart[]     // image/file parts replace their own marker in place
  snapshot: CcDraftSnapshot                 // full pre-clear state, attachments included (memory only)
  images: readonly { id: number; image: ImageUploadPart }[]
  files: readonly { id: number; part: CcFilePromptPart; attachment: FileAttachmentRef }[]
  wasBrowsingHistory: boolean
}
```

`getPromptContent()` throws `CcUnresolvedImageMarkerError` (`.markerIds`) for
image markers without an upload, then `CcUnresolvedFileAttachmentError` for file
markers without a native part (deterministic order for mixed drafts). `content`
never contains `[Image #N]`/`[File #N]` text, and an image-only or file-only draft
is a valid submit (no dependence on trimmed text). Every attachment without an
`onSubmitContent` consumer is refused with the draft kept. The app restores
`payload.snapshot` with `restoreDraft()` when native admission fails; the App's
send gate must count file parts too (`part.type === 'image' || part.type === 'file'`).

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
| `app.todo` | `ctrl+t` | CC Ctrl+T is todo, not transpose. The App now uses it as the live dock visibility toggle for native todos above the editor; the binding id/default are unchanged. |
| `app.thinking.toggle` | (unbound) | DSH/Pi concept; bind explicitly |
| `app.model.select` | `alt+p` | Ctrl+P stays history |
| `app.mode.cycle` | `shift+tab` | legacy config ID retained; executes native `/permission` only, never `/plan` |
| `app.clipboard.pasteImage` | `ctrl+v` (`alt+v` added on Windows/WSL) | CC override, not quoted-insert; the platform alias never replaces an existing binding and a user override wins |
| `app.images.details` | `ctrl+x ctrl+i` | TUI extension; opens the image viewer. Plain Ctrl+I stays completion |
| `image.details.previous-image` | `[`, `alt+left` | `imageDetails` only; stays plain text/word motion in the editor |
| `image.details.next-image` | `]`, `alt+right` | `imageDetails` only; stays plain text/word motion in the editor |
| `image.details.close` | `escape` | `imageDetails` only; wins over `list.cancel` for Esc |
| `image.details.toggle-preview` | `p` | TUI extension; `imageDetails` only. Renderer-only automatic/text-only display toggle (text-only starts no read/decode, changes no facts); `p` stays text in the prompt and modal fields |
| `app.subagents.details` | `ctrl+x ctrl+a` | TUI extension; opens the native Agents overlay (`subagentList` / `subagentSession`). Plain Ctrl+A stays line start in the prompt |
| `subagent.reply` | `r` | TUI extension; `subagentList`/`subagentSession` only. Sets the App-owned reply target; leave it with `app.cancel`. Plain `r` stays text in the prompt and every other context |
| `subagent.interrupt` | `s` | TUI extension; `subagentList`/`subagentSession` only. Stops the focused child inside the overlay. Ctrl+C remains the global `app.interrupt` |
| `app.suspend` | `ctrl+z` | parent must restore terminal state; see `docs/INPUT-LIFECYCLE.md` |
| `app.message.sendNow` | (unbound) | app-state dependent |
| `app.message.followUp` | (unbound) | app-state dependent |
| `app.help` | `f1` | |

Also available for non-editor surfaces (same keymap instance):
`list.previous/next/pageUp/pageDown/first/last/select/cancel/select-digit`,
`dialog.confirm/cancel`, `historySearch.next/previous/accept/cancel`,
`autocomplete.*`, `model.provider.previous/next/previousArrow/nextArrow`, and
the overlay-local `subagent.reply`/`subagent.interrupt` (Agents contexts only).
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
them. `image.details.toggle-preview` (`p`) is a renderer-only automatic /
text-only display toggle; text-only mode must not start a read/decode and
attachments/facts stay intact. All four viewer actions appear in the same
grouped Settings list and use the same single override map.

The native Agents overlay uses two read-only contexts, `subagentList` (agent
list) and `subagentSession` (one agent's session view):
`subagentList → list → dialog → global` and
`subagentSession → list → dialog → global`, both **without** an editor layer.
`app.subagents.details` (`ctrl+x ctrl+a`, TUI extension) opens it and is
forwarded through the same `APP_FALLBACK_ACTIONS` path as the other overlay
openers. The surface reuses `list.previous/next/pageUp/pageDown/first/last/
select/cancel/select-digit`, `dialog.*` and global `app.interrupt`, and adds
exactly two overlay-local, app-implemented actions:

- `subagent.reply` (default `r`): the App sets the focused child as the reply
  target. Leaving the target stays `app.cancel`; there is no second
  target/mode action on the root editor.
- `subagent.interrupt` (default `s`): stops the focused child inside the
  overlay. It does not rebind Ctrl+C; global `app.interrupt` keeps its priority
  and the root Ctrl+C semantics.

Both actions are ordinary rows in the one grouped Settings shortcut list and
the one `keybindings.json` override map (remap, disable, or reset by deleting
the override); there is no subagent-specific config or standalone hotkeys
panel. Plain `r`/`s` remain ordinary text in the root prompt and in every other
context, because the actions are registered only for
`subagentList`/`subagentSession`. In `CcEditor`, printable bytes, editing bytes,
bracketed paste and an abandoned character jump never reach the hidden root
editor; editor-implemented (root-only) commands and root-draft app actions
(stash, paste image, history search, external editor, send/steer/follow-up)
fail closed, while `subagent.reply`/`subagent.interrupt` are emitted to
`onAction` and the App performs the operation. The input layer only resolves or
emits the action; it never calls the backend, and without an `onAction` handler
the key has no effect. `app.cancel`, `list.cancel` and global `app.interrupt`
keep their documented behavior. Global `app.exit` is **not** swallowed: Ctrl+D
still reaches the App, which keeps its existing empty-input policy. Esc resolves
to `list.cancel` and Ctrl+C keeps interrupt priority over a pending chord.

Plain keys: the frontend can keep using Pi's `getKeybindings().matches` for
non-chord app keys, but then the YAML/JSON override in `CcKeymap` is not in
effect. Preferred: `editor.getKeymap().resolve(data, context)`.

## Slash completion (commands + DSH skills)

```ts
import { NativeAutocompleteProvider, createNativeAutocompleteProvider } from "./src/input/index.ts"

const provider = new NativeAutocompleteProvider({
  commands: () => [...uiCommands, ...nativeCommands], // readonly NativeCommandEntry[]
  skills: () => skillEntries,                          // readonly SkillCatalogEntry[] (backend/types.ts)
  basePath: cwd,
  refreshSkills: async (signal) => { /* parent single-flight/dirty query */ },
  // Optional native @file domain (DSH file-reference discovery behind the backend):
  fileReferences: async (query, signal) =>
    backend.listFileReferences(query, signal),         // readonly FileReferenceCandidate[]
})
editor.setAutocompleteProvider(provider)
```

Both the class and `createNativeAutocompleteProvider(options)` return the same
object; the options object is the stable API. A command entry is Pi's
`SlashCommand` plus the App-mapped native descriptor field `inputHint`
(`input.hint`); Pi's `argumentHint` remains valid as a fallback. The roster
shape is the existing command catalog, not a second registry.
`commands`/`skills` are **getters** called on every request, so asynchronous
metadata updates need no cache invalidation here. Nothing else is cached (no
catalog, no Editor state, no timers, no raw stdin).

Behavior:

- Slash-name menu (`/` at the trimmed line start, no space yet, not forced):
  native names only — `/name`. There is no `/skill` wrapper and no Pi
  `skill:` / `skill:name` alias; a skill entry never becomes a fake command and
  its body is never read or expanded.
- Order is exact name first, then name-prefix matches, then fuzzy-only
  matches; ties keep the roster order (commands in roster order, then skills
  in catalog order). Pi's editor selects by comparing `item.value` with the
  suggestion `prefix`, and this provider's slash prefix includes `/`, so the
  provider itself must rank in the name namespace. Typing an exact `/name`
  therefore highlights that name even when an earlier command is only a prefix
  sibling (`/review` with a `review-all` command and an exact `review` Skill).
  Explicit `Up`/`Down`/`Ctrl+P`/`Ctrl+N` still moves the highlight and Enter
  submits the highlighted item. A name collision shows only the command
  (command wins).
- Command descriptions prefix the native/`argumentHint` hint when present
  (`<preset> — Choose a permission preset`); metadata is sanitized exactly like
  descriptions.
- Skill descriptions are labelled with `Skill — …`; `modelInvocable: false`
  (and any non-`true` value) is labelled `Skill (user-only) — …`. Description /
  name metadata is stripped of ANSI escapes, C0/C1 control characters and
  Unicode line separators before it reaches the menu; names that cannot be
  invoked as `/name` (whitespace, `/`, `\`) are omitted.
- `@file` mentions are native when `fileReferences` is configured (see below);
  everything else is delegated unchanged to Pi's `CombinedAutocompleteProvider`:
  relative/absolute/`~` paths, quoted paths, command argument completion,
  forced (`Tab`) completion, the insertion/cursor rules and
  `shouldTriggerFileCompletion`.
- Slash-name requests **start** `refreshSkills(signal)` and return immediately
  from the current getters (never awaiting the parent query); menu data remains
  usable if the refresh rejects. It is strictly single-flight: while one parent
  call is pending, keystrokes, the same menu re-triggered, and background
  metadata re-queries add no second call. Once it settles, **every** regular
  slash query may ask again — even the exact same text. The provider does not
  memoize the query; dirty/in-flight/catalog-validity/scope caching belongs to
  the parent, which returns an already-fresh catalog without refetching. That
  keeps unavailable/error/scope changes retryable by the next genuine user
  query or menu reopen. `file`/`@`/argument/forced completion never refreshes.
- The signal passed to `refreshSkills` is the provider's lifetime controller and
  aborts on `provider.dispose()` (and only then): a per-keystroke Editor abort
  must not cancel the parent's catalog query.
- Diagnostics: `provider.isRefreshingSkills()`; `provider.dispose()` is
  idempotent and late refresh results are ignored.

### Native `@file` mentions (`fileReferences`)

`@` completion has two mutually exclusive shapes. Both are pure prompt text:
a mention is a **path reference** for the model, the input layer never reads the
file, never stages/attaches it, never uploads anything and never turns a path
into a `[File #N]` attachment (`/attach` is the only attachment path).

1. **No `fileReferences` callback** (offline `--demo`, or a backend without
   `listFileReferences`): `@` stays exactly Pi's own behavior — no local index,
   no filesystem scan, no `fd` fallback, no skill refresh. In practice this
   yields no `@` rows and never fabricates a candidate.
2. **With `fileReferences(query, signal)`**: the provider asks the parent and
   maps its rows. Call `editor.setAutocompleteProvider(provider)` once; every
   other context (slash, argument, plain path, forced Tab) is untouched.

Grammar, not local tokenization: the provider calls DSH's public
`activeAtToken(line, cursorCol)` from `@deepseek-ai/dsh-file-reference/grammar`
to decide whether the cursor is inside an `@path` or `@"path with spaces"` token,
and `formatFileMention(candidate, token.quoted)` to spell the accepted mention.
No regex, quoting rule or path format is re-implemented here.

- Trigger: only DSH grammar tokens — an `@` at the start of the line or after
  whitespace, optionally opened with `@"`. `abc@def`, `(@src` and `@` inside
  another word never open the file menu (they keep their existing path/argument
  behavior).
- Menu mapping, in the **callback's own order** (no local sort, no fuzzy, no
  re-ranking): `label` = entry name (`dir/` for directories, Pi's directory
  marker), `description` = parent path (omitted for workspace-root entries),
  `value` = `formatFileMention` output, `prefix` = the active token prefix
  (`@foo` / `@"foo`). A candidate the grammar cannot spell (quote or C0/C1
  control character in the path) or a malformed record contributes no row.
- Accept keeps Pi's single edit state: a file inserts `@path ` (one trailing
  space); an unquoted directory inserts `@dir/` with the cursor after the slash;
  a quoted directory inserts `@"my dir/"` — a complete, submittable mention whose
  cursor stops **before** the closing quote, so the next keystroke continues
  inside the token and drills another level. Pi's own
  `applyCompletion`/undo/`[Image #N]`/getPath registry are the only paths.
- Tab and Enter accept/fill only, never submit an `@` candidate (only slash-name
  confirm submits); a second Enter submits the completed draft. Esc, Up/Down,
  Ctrl+P/N and mouse keep Pi's menu behavior.
- Failure is silent: a rejection, a synchronous throw, a non-array result, a
  cancelled request or an already-stale answer produces **no rows** (the menu
  closes) and never a message in the prompt or transcript. A cancelled/older
  request cannot reopen the menu (Pi's request identity is the only apply gate).
- The `@file` grammar is loaded **lazily** (cached `import()`) and only for a
  non-slash draft containing `@` while `fileReferences` is configured. Slash
  menus, argument completion and plain-path completion never import it, and a
  load failure is treated as an unavailable native domain: the provider, the
  `--demo` entry and every non-`@` completion keep working.
- `fileReferences` is never called for slash/argument/path/forced completion, and
  `@` completion never starts the `refreshSkills` parent query.

When metadata settles, the parent re-triggers Pi's completion with the seam
method below (not with a Tab/accept path), so the open menu re-reads the getters.

### `ccRefreshAutocomplete()`

```ts
editor.ccRefreshAutocomplete() // after metadata settles while the menu is open
```

Calls Pi's internal `requestAutocomplete({ force: this.autocompleteState === "force",
explicitTab: false })`. It re-requests candidates for the current draft and
never applies a completion, pushes undo, changes text or submits — a background
refresh with exactly one new candidate cannot auto-accept it. It reuses Pi's
existing request/abort state and debounce (no new Editor state, timer or stdin
consumer) and does nothing useful without an autocomplete provider. Esc still
closes the menu; suppressing later refreshes after Esc is the parent's
scope/tombstone policy, not the seam's.

### Enter acceptance and content-aware payloads

`autocomplete.accept` on Enter (`ccAutocompleteAccept("confirm", onSubmit?)`)
applies the highlighted candidate to this same Editor state **first**, then
runs `onSubmit`. `CcEditor` passes a callback that captures the content-aware
`CcSubmitPayload` on the completed draft (`/review`, not the typed `/rev`) and
only then calls Pi's clear/submit, so `onSubmitContent` text/content/snapshot
and the accepted name always agree. Semantics kept:

- Tab (and any Tab-style accept) only edits the draft; it never submits.
- Without a selected candidate, Enter cancels the menu and submits nothing.
- File/`@`/argument completions keep Enter as fill-only, even for image-bearing
  drafts (no content validation or send).
- The seam's default `confirm` without a callback still calls `submitValue()`,
  so direct seam consumers are unchanged.
- Rejected native admission restores `payload.snapshot`, i.e. the completed
  image-bearing draft, never the stale typed prefix.
- The candidate apply keeps Pi's undo snapshot, paste/`[Image #N]` registry and
  prompt-part order; kill/yank/undo and remapped/disabled accept keys are not
  affected (an unbound Enter keeps its existing submit fallback).

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
  `modelPickerList`, `modelPickerSearch`, `toolDetails`, `imageDetails`,
  `subagentList`, `subagentSession`, `settingsList`, `keybindingsList`,
  `modalList`, `queueList`, `modalSearch`, `global`. Fallback
  chains (first match wins): `autocomplete → editor → global`,
  `historySearch → editor → global`, `dialog → editor → global`,
  `editor → global`, `list → global`,
  `modelPickerList → list → editor → global`,
  `modelPickerSearch → editor → global`,
  `toolDetails → list → dialog → global`,
  `imageDetails → list → dialog → global`,
  `subagentList → list → dialog → global`,
  `subagentSession → list → dialog → global`,
  `settingsList → list → dialog → global`,
  `keybindingsList → list → dialog → global`,
  `modalList → list → dialog → global`,
  `queueList → list → dialog → global`,
  `modalSearch → editor → dialog → global` (the four modal *browse* chains
  deliberately have no editor layer; `modalSearch` is the modal text field and
  keeps editor editing). Completion/search/modal-search keys win locally, but
  editor editing (Ctrl+A/W/K, Alt+B/F, word deletion, undo, …) keeps working
  underneath. `getFallbackChain(ctx)` exposes the chain.

### Modal / Settings / queue contexts (popup pass)

The unified popup surfaces are keyed by these contexts. Hosts call
`keymap.resolve(data, ctx)` (or host one `CcEditor` with
`setContext("modalSearch")` for the search field) and dispatch the returned
action; the input layer owns no dialog/host state, no second editor and no
queue storage.

| context | chain | local rows (defaults) |
| --- | --- | --- |
| `settingsList` | `settingsList → list → dialog → global` | `modal.search` (Ctrl+F), `settings.reset` (Ctrl+R), `settings.previous-category` (Left, Shift+Tab), `settings.next-category` (Right, Tab) |
| `keybindingsList` | `keybindingsList → list → dialog → global` | `modal.search` (Ctrl+F), `keybindings.edit` (Enter), `keybindings.reset` (Ctrl+R), `keybindings.disable` (Ctrl+D) |
| `modalList` | `modalList → list → dialog → global` | `modal.search` (Ctrl+F), `session.scope.toggle` (Ctrl+A) |
| `queueList` | `queueList → list → dialog → global` | `modal.search` (Ctrl+F), `queue.edit` (`e`), `queue.cancel-entry` (`d`), `queue.send-now` (Ctrl+Enter) |
| `modalSearch` | `modalSearch → editor → dialog → global` | none (a field, not a list) |

Host guidance (contract):

- Settings is one continuous grouped page. The existing `settings.*-category` IDs are retained for user overrides but mean section jumps, not tab pages. Context-local rows win over inherited dialog/global Tab bindings; root Shift+Tab still only executes native `/permission`. In search/value fields, editing keeps its context and never touches the hidden prompt. Non-text Settings lists/pickers ignore bracketed paste via the existing filter; active paste blocks mouse focus/mode changes until its end.
- Browse lists never fall through to the editor, so printable/editing bytes are
  inert. `CcEditor` hosted with these contexts also consumes unbound bytes
  (`settingsList`/`keybindingsList`/`modalList`/`queueList` are read-only
  surfaces) and emits only app actions.
- The modal search field is a real text field: typing, Ctrl+W word kill,
  kill/yank, undo and Ctrl+A/E/B/F come from the one Pi editor state. Up/Down/
  Enter/Tab list navigation is passed explicitly by the UI, not resolved from
  editor bindings. Ctrl+F stays `editor.move.char-right` there (`modal.search`
  is registered only in browse contexts).
- `toolDetails` gains `modal.search`, `tool.details.toggle-calls` (Ctrl+L) and
  `tool.details.wrap` (Ctrl+W); `subagentList` gains `modal.search` and
  `subagent.filter.toggle` (Tab); `subagentSession` gains `modal.search`.
  `imageDetails` gains no search field; the viewer's own `p` preview toggle is
  documented above.
- `keybindings.edit` intentionally overlaps `list.select` on Enter in
  `keybindingsList`; the list-local row wins there and `list.select` is the
  documented fallback when the edit row is disabled/remapped.
- `app.queue.open` (Ctrl+X Ctrl+Q) is the only global addition; it is a chord
  and takes no new single-key global binding. `queue.send-now` needs a terminal
  that reports Ctrl+Enter (Kitty / modifyOtherKeys); plain Enter stays
  `list.select`.
- The configured simple `app.interrupt` key keeps priority over local bindings
  and pending chords in all five new contexts (as in the picker/details/Agents
  contexts), so Ctrl+C is never swallowed by `list.cancel`.
- All rows are ordinary `CC_ACTIONS` entries: remap/disable (`null`)/reset in
  the one grouped Keyboard list and `keybindings.json` map. Local rows never
  become global (e.g. `keybindings.disable` Ctrl+D is not a global disable and
  the prompt keeps forward-delete/exit).

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
- In picker contexts, `toolDetails`, `imageDetails`, `subagentList`,
  `subagentSession`, `settingsList`, `keybindingsList`, `modalList`,
  `queueList` and `modalSearch` the configured simple
  `app.interrupt` key keeps priority over local bindings (e.g. `list.cancel`
  Ctrl+C) **and over a pending chord**. The chord is cancelled and
  `app.interrupt` is dispatched, so the modal/picker/overlay cannot swallow
  Ctrl+C. Disabled provider actions never fall through to a generic
  `editor.complete` event in the picker (only `model.provider.*` events may
  change the provider group).

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