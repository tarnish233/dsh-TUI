# Input subsystem: CC/readline behaviour on one Pi editor state

Owner: input developer (`src/input/`, `vendor/pi-tui/`, `test/input*.test.ts`, this doc).
Short API handoff: `docs/INPUT-API.md`.

## Architecture

- **One editor state.** `CcEditor extends Editor` (`@earendil-works/pi-tui`).
  Text, cursor, undo stack, kill ring, history, paste registry and autocomplete
  all stay inside Pi's editor. The CC layer never re-implements or rewrites
  that state; it routes keys and calls narrow seam methods.
- **Vendored TUI source** (`vendor/pi-tui/`) is the MIT Pi TUI 1.5.0 terminal
  library, extracted from the published package sources. It contains no
  provider, credential, Agent or conversation implementation. The app builds
  it with `pnpm build:pi-tui`.
- **Atomic attachment markers in the vendored editor** (approved additive
  seam): `[Image #N]` and `[File #N]` are two families with separate ids,
  registries and payloads, but one segmentation/undo/history mechanism. The
  vendored editor recognizes a marker only when its id is registered, so a
  hand-typed marker stays ordinary text and never becomes atomic by accident.
- **Seam installer** (`src/input/pi-tui-seam.js`) adds *only* the app entry
  points to Editor/SelectList prototypes: `ccCaptureSnapshot`,
  `ccRestoreSnapshot`, cursor/word/whitespace primitives, kill/yank/undo,
  history browsing, atomic replacement, marker-aware transpose, character
  jump (`ccStartJump`/`ccJumpToChar`), paste/insert, submit/newline,
  autocomplete step/accept, and completion selection access. It replaces the
  former pnpm patch; upstream source remains readable and updateable.
- **Keymap is independent.** `CcKeymap` does not import Pi's global
  keybindings; DSH configuration cannot accidentally inherit Pi application
  actions. Pi's `matchesKey` is reused for terminal parsing (legacy bytes,
  Kitty CSI-u, xterm modifyOtherKeys).
- **App vs editor actions.** App-level actions are forwarded to
  `CcEditor.onAction`; the app owns history search, stash, external editor,
  clipboard, queue/steer, dialogs. `getBindings(actionId)` supports
  non-mutating checks (e.g. cleared-draft Up/Down detection) without a second
  key dispatch.
- **Completion sources are callbacks, not indexes.** `/name` rows come from the
  mounted command roster plus App-owned skill metadata; `@path` rows come from
  the parent's `fileReferences(query, signal)` mapped through DSH's public
  `@file` grammar (`activeAtToken` / `formatFileMention`, imported lazily so the
  offline `--demo` entry loads without the native peers). The input layer keeps
  no catalog and no file index, never reads file contents, never stages or
  attaches a mentioned path, never scans the filesystem or falls back to `fd`,
  and still delegates plain path / argument / forced-Tab completion to Pi. See
  `docs/INPUT-API.md`.

## Vendored TUI integration (parent)

1. The vendored package is reached through the single package-import seam
   `#pi-tui` → `./vendor/pi-tui/dist/index.js` (plus `#pi-tui/package.json` for
   the manifest), so a DSH installation cannot resolve a different
   `@earendil-works/pi-tui` copy. `src/input/` and `test/input*.test.ts` import
   only `#pi-tui`; upstream names in copyright/attribution comments are kept.
2. `pnpm build:pi-tui` compiles the vendored TypeScript to
   `vendor/pi-tui/dist/` (the mapped entry). `pnpm check` runs it first.
3. `CcEditor` installs `src/input/pi-tui-seam.js` once at module load and
   throws an actionable error if the seam is missing.
4. Offline tests use the same vendored package; no module-loader redirect,
   patch hash or scratch-package copy is required. Refresh the vendored source
   from the pinned upstream release when upgrading, then rebuild and run the
   full input/terminal suite.
5. Terminal ownership, start/stop, raw-mode and exit restoration live in
   `docs/INPUT-LIFECYCLE.md` (`test/input-lifecycle.test.ts`).

## Behaviour coverage

Status vocabulary: **match** (intended CC/readline parity), **app override**
(CC repurposes the key), **Pi extension**, **TUI extension** (a DSH TUI
capability that is not a verified CC default), **unverified**, **unsupported**.

| Family | Keys | Semantics / status |
| --- | --- | --- |
| Line/char motion | Ctrl+A/E, Home/End, Ctrl+B/F, Left/Right | logical line start/end; grapheme movement; line-boundary wrap follows Pi. match |
| Word motion | Alt+B/F, Alt+Left/Right, Ctrl+Left/Right | punctuation + CJK aware via Intl.Segmenter; platform aliases bound together. match (terminal coverage caveat) |
| Vertical/history | Up/Down, Ctrl+P/N | visual line first; on first/last visual line browse history; **no Pi jump-to-column-0 step**; draft, cursor and paste markers restored. match |
| Char delete | Backspace, Ctrl+H, Delete, Ctrl+D | grapheme-safe; line-boundary merge; Ctrl+D exits only when empty, and the empty guard is independent of binding priority (disabling/rebinding forward-delete cannot resurrect global exit); empty Delete no-ops. match |
| Whitespace kill | Ctrl+W | shell-whitespace boundary: whole path/flag; paste markers atomic; column-0 merges newline. match |
| Word kill | Alt+Backspace, Ctrl+Backspace, Alt+D/Alt+Delete | punctuation/CJK boundaries (Option+Delete on macOS). match |
| Line kill | Ctrl+U, Ctrl+K | kill ring, newline merge at boundaries, empty-line behaviour = Pi. match |
| Yank | Ctrl+Y, Alt+Y | consecutive kills accumulate in kill direction; yank-pop only immediately after yank. match; CC yank-pop legality **unverified** |
| Undo | Ctrl+_ / Ctrl+- / Ctrl+Shift+- | restores text+cursor+paste registry; typing coalesced, kills/yanks/pastes atomic. match (byte equivalence documented) |
| Submit/newline | Enter, Shift+Enter, Ctrl+J, Alt+Enter, backslash+Enter | Enter submits; others newline; backslash fallback. match |
| Completion | Tab, Enter/Esc with menu, Ctrl+P/N in menu | menu owns nav/accept/cancel; editor editing works beneath. Exact `/name` ranks first (exact → prefix → fuzzy in the menu's name namespace), so an exact Skill is never replaced by an earlier prefix-sibling command; explicit navigation still wins, Tab only edits, Enter accepts then submits for a slash name. `@file` mentions are native (DSH grammar + `fileReferences`) and Enter/Tab only fill them; a second Enter submits. unverified for the remaining CC accept/submit split |
| Paste | bracketed paste, Ctrl+V | fragmented start/end markers reassembled; a paste start cancels any pending chord; pasted bytes never dispatched as keys/chords/global actions; large paste → `[paste #n ...]` marker with undo/snapshot preservation; submit expands. match |
| Editing aids | Ctrl+L, Ctrl+G / Ctrl+X Ctrl+E, Ctrl+S, Ctrl+R | forwarded to the app; editor forwards after closing completion / restoring history draft. app override |
| App overrides | Ctrl+T/O/V/S/G, Alt+P, Shift+Tab, Ctrl+Z | `app.todo/tools.expand/clipboard.pasteImage/stash/editor.external`, `app.model.select`, `app.mode.cycle`, `app.suspend`. app override |
| Tool details | Ctrl+X Ctrl+O, `[`/`]`, Alt+Left/Right, Tab/Right, Shift+Tab/Left, c | `app.tools.details` opens the tools inspector on the **latest tool** (TUI extension, not a CC default; plain Ctrl+O keeps expand/collapse). The read-only modal context `toolDetails → list → dialog → global` adds previous/next tool (`[` + Alt+Left, `]` + Alt+Right; Pi's legacy ESC-b/ESC-f reads alias Alt+Left/Right in this context), next/previous section, copy, shared list scrolling (`Up/Down`, `Ctrl+P/N`, `j/k`, PageUp/Down, Home/End), `Esc`/`list.cancel` close. `c` and brackets exist only in `toolDetails`, so they are ordinary text in the editor; unbound printable bytes are inert in the modal. |
| Native Agents overlay | Ctrl+X Ctrl+A; `r` reply, `s` stop, Tab filter, shared list keys, Enter/Esc, Ctrl+C | `app.subagents.details` opens the native Agents overlay (TUI extension, not a CC default) through the read-only `subagentList → list → dialog → global` and `subagentSession → list → dialog → global` contexts. The agent list and one agent's session view reuse `list.previous/next/pageUp/pageDown/first/last/select/cancel/select-digit` and global `app.interrupt`, and add overlay-local actions: `subagent.reply` (`r`; the App owns the reply target and `app.cancel` leaves it, no second editor target/mode action), `subagent.interrupt` (`s`; stops the focused child inside the overlay without rebinding Ctrl+C) and `subagent.filter.toggle` (`Tab`; Active/All filter of the current native catalog in the agent list only). All are ordinary rows in the same grouped Settings list and `keybindings.json` map (remap/disable/reset); plain `r`/`s`/Tab stay ordinary input in the prompt and every other context. Unbound printable bytes, editing bytes, pasted content and an abandoned character jump are inert (or cancelled) instead of reaching the hidden root editor; root-only editor commands and root-draft app actions (stash, paste, history search, external editor, send/steer/follow-up) fail closed, while global `app.exit` is not swallowed (the App keeps its empty-input policy). `Esc` closes via `list.cancel`, `Ctrl+C` keeps global interrupt priority. |
| Unified modal browse | `settingsList`, `keybindingsList`, `modalList`, `queueList` → `list → dialog → global` (no editor) | The popup/settings pass adds four read-only browse contexts with shared list/dialog/global keys and **no editor fallback**, so editor movement/kill/yank/undo can never type into a settings or queue surface. Context-local rows: `modal.search` (Ctrl+F; Settings, Keyboard shortcuts, generic modal lists, queue, tools inspector, Agents list/session — not the image viewer), `settings.reset` (Ctrl+R), `settings.previous-category`/`next-category` (Left/Shift+Tab, Right/Tab; jumps between groups on the one continuous Settings page, without filtering or clearing search), `keybindings.edit` (Enter), `keybindings.reset` (Ctrl+R), `keybindings.disable` (Ctrl+D), `session.scope.toggle` (Ctrl+A, generic modal list), `queue.edit` (`e`), `queue.cancel-entry` (`d`), `queue.send-now` (Ctrl+Enter), `tool.details.toggle-calls` (Ctrl+L), `tool.details.wrap` (Ctrl+W). Every row is remappable/disableable/reset in the one grouped Keyboard list; local keys never become global (e.g. Ctrl+D disables one shortcut row but still exits only from the prompt). `Ctrl+C` keeps the configured `app.interrupt` priority over `list.cancel` and over a pending chord. app override except the shared list keys |
| Modal search field | `modalSearch → editor → dialog → global` | A real text field for search input inside any modal: typing, word/whitespace deletion (Ctrl+W), kill/yank, undo and Ctrl+A/E/B/F stay the editor's, so modifiers are not stolen by list navigation. `modal.search` is deliberately not registered here: Ctrl+F stays editor char-right while typing and only opens search from the browse list. List navigation (Up/Down/Enter/Tab) is passed by the owning UI, not resolved from editor bindings; Esc resolves `editor.cancel` (field cancel, then `app.cancel`) and Ctrl+C keeps interrupt priority. No second editor state or input reader is created. |
| Queue | Ctrl+X Ctrl+Q opens; `e` edit, `d` cancel, Ctrl+Enter send now | `app.queue.open` (global chord) opens the queue list; the queue list itself is the read-only `queueList` context above. All three row actions are queue-local, so `e`/`d` stay ordinary text and Ctrl+D keeps forward-delete/exit in the prompt. Ctrl+Enter requires a terminal that reports the modified key (Kitty protocol / xterm modifyOtherKeys); legacy terminals deliver plain Enter, which stays `list.select` there, so the action is remappable. The queue remains a view of DSH's native inbox: the input layer only emits the named action. |
| Chords | Ctrl+X Ctrl+E + user chords | prefix wait, **3000 ms** default timeout (expires at the deadline), cancel on mismatch and redispatch, paste/focus/config changes cancel; the keymap owns pending state and hint notification (`onChordChange`), the editor only owns the timeout timer. match (timeout value per CC docs) |
| Cancel | Esc, Ctrl+C | Esc is contextual: close completion, restore the history-browsing draft, and only then forward `app.cancel`; a consumed local action never also reaches the app. Ctrl+C always resolves `app.interrupt` through the keymap (completion, jump mode, pending chord and dialogs do not swallow it); paste bytes are not keys. match |
| Character jump | Ctrl+] / Ctrl+Alt+] | Pi extension: only an actual target character (one grapheme) is consumed; DEL/Backspace, control keys and escape sequences cancel the jump and are re-dispatched through `CcKeymap`, so CC whitespace Ctrl+W, CC deletion, remaps and disabled actions still apply. No Pi default fallback. match |
| Config | all actions | multiple keys, disable (`null`), remap, contexts, hot reload, conflicts/byte-ambiguity/chord-shadow diagnostics, grouped Settings editor. match |
| Lists/dialogs/search | j/k/1-9, arrows, Enter/Esc, Ctrl+R | separate contexts; list keys never leak into text fields; search keeps editor editing fallback. app override |
| /model picker | Tab/Shift+Tab, Left/Right (browse), printable text | two contexts: `modelPickerList → list → editor → global` and `modelPickerSearch → editor → global`. Provider cycling uses registered `model.provider.*` actions only. In the picker `CcEditor` path, a plain printable chunk with no pending chord is query text in **both** contexts (first typed `j`/`k`/digit from browse focus, and cancelled-chord passthrough) instead of `list.next`/`list.select-digit`; text fields never lose letters. Enter/Esc are forwarded as `list.select`/`list.cancel`; Ctrl+C remains global. Raw `keymap.resolve(modelPickerList)` keeps the list defaults for custom list components. app override; see `docs/MODEL-INPUT-API.md` |

### Keyboard settings and native permissions

Open `/settings` → **Keyboard shortcuts**. One grouped list shows current
keys and action descriptions, including unbound actions; there is no standalone
`/hotkeys` command, debug/compatibility columns, profile hierarchy or conflict
resolution wizard. TUI extensions such as `app.tools.details`,
`app.images.details`, `app.subagents.details`, `subagent.reply`,
`subagent.interrupt`, `subagent.filter.toggle` and every popup row
(`modal.search`, `settings.*`, `keybindings.*`, `session.scope.toggle`,
`queue.*`, `tool.details.toggle-calls`, `tool.details.wrap`, `app.queue.open`)
are ordinary rows in that same list, so they are remappable/disableable and
reset by deleting their one override. The pane's own controls are registry
rows too (`keybindings.edit` Enter, `keybindings.disable` Ctrl+D,
`keybindings.reset` Ctrl+R) rather than a second override hierarchy; the UI
owner wires them, and the input layer's `keybindingsList` chain keeps them
modal-local. `keybindings.edit` deliberately overlaps `list.select` on Enter:
the list-local row wins in that one context, and `list.select` is the
documented fallback if the edit action is disabled or remapped elsewhere.
Select a row to edit it; `keybindings.disable` disables it and
`keybindings.reset` removes just that override to restore the effective app
default.

The inline CC editor takes one alternative per line (Shift+Enter adds a line);
spaces retain native chord syntax, e.g. `ctrl+x ctrl+e`. Option is an alias of
Alt in this field. Enter saves, Esc cancels. The existing keymap validates keys
and reports newly introduced conflicts before an atomic write to the same
`keybindings.json` override map. Malformed files and failed validation are not
overwritten; unrelated overrides are preserved, defaults are never dumped.

This configuration pane alone reserves arrows, Enter/Esc, and its own
`keybindings.*` list rows as recovery controls, so editing navigation cannot
lock out its user (the legacy literal `d`/`r` list keys are superseded by
those remappable rows once the Settings UI adopts them). Normal
editors and other dialogs still honor configured/disabled bindings. Changes
apply immediately without changing the main draft/undo/paste state. Saving the
file externally also applies automatically; `/reload` is the manual full
refresh for TUI settings/keybindings plus DSH profile/home configuration. It
does not recreate the session or the editor draft.

Shift+Tab executes native `/permission` using the native permission catalog.
The old `app.mode.cycle` configuration ID is retained for binding compatibility,
but there is no UI `/mode` or combined permission/plan mode. Native `/plan` is
a separate command owned by the mounted DSH plugin.

### Grapheme handling

Movement/deletion uses Pi's grapheme+paste-marker segmentation. ZWJ emoji,
combining marks and large-paste markers are atomic. Transpose now runs through
the seam (`ccTransposeChars`) with the same marker-aware segmentation, so it
cannot split a large-paste marker; it stays one undoable edit.

### Context fallback chains

- `editor → global`
- `autocomplete → editor → global`
- `historySearch → editor → global`
- `dialog → editor → global`
- `list → global`
- `modelPickerList → list → editor → global`
- `modelPickerSearch → editor → global`
- `toolDetails → list → dialog → global` (no editor fallback: editor
  movement/kill/undo bindings never reach a read-only details surface; an
  unbound printable byte is inert even if the modal is hosted by `CcEditor`)
- `imageDetails → list → dialog → global` (same read-only shape as
  `toolDetails`). Context-local rows: `image.details.previous-image`
  (`[`/Alt+Left), `image.details.next-image` (`]`/Alt+Right),
  `image.details.close` (Esc) and `image.details.toggle-preview` (`p`;
  renderer-only automatic/text-only display toggle — text-only starts no
  read/decode and changes no facts), so `p`/brackets stay plain text in the
  prompt and in modal text fields)
- `subagentList → list → dialog → global` (native Agents overlay list)
- `subagentSession → list → dialog → global` (one agent's read-only session
  view). Both subagent contexts add `subagent.reply` (`r`),
  `subagent.interrupt` (`s`) and `modal.search` (Ctrl+F) on top of list,
  dialog and global app keys, plus `subagent.filter.toggle` (Tab) in the agent
  list only; there is no editor layer and no root-editor target/mode action.

Local actions win; global app bindings are a fallback. This is why Ctrl+W,
Ctrl+A, Alt+B etc. still edit while completion or history search is open, and
why Ctrl+C/Esc still reach the app in dialogs.

In `modelPickerList`, `modelPickerSearch`, `toolDetails`, `imageDetails`,
`subagentList` and `subagentSession`, the configured **simple**
`app.interrupt` binding (Ctrl+C by default) is checked before a pending chord
and before the context chain. A typed chord prefix therefore cannot swallow
the interrupt: the pending chord is cancelled (the key hint clears once) and
`app.interrupt` is dispatched. Disabling/remapping the action moves or removes
this priority; Ctrl+C then falls back to `list.cancel`. Existing
`list`/`dialog` behaviour is unchanged.

Picker specifics (details: `docs/MODEL-INPUT-API.md`):

- `list.select` / `list.cancel` also apply in `modelPickerSearch`, so Enter and
  Esc are forwarded as list actions; Enter never submits/clears the query.
- The picker `CcEditor` path inserts a plain printable chunk into the query
  before the keymap (when no chord is pending), in both picker contexts. This
  includes the first `j`/`k`/digit typed from browse focus and printable bytes
  re-dispatched after a chord mismatch/timeout. Modifier-led pending chords
  still complete first, and existing editor/list/dialog/history-search
  contexts are unchanged.
- `model.provider.*` are the only events that may change the provider group.
  If `model.provider.next` is disabled, the generic `editor.complete` fallback
  for Tab is consumed in picker contexts instead of being emitted.
- In both picker contexts the configured `app.interrupt` key keeps priority
  over the local `list.cancel` Ctrl+C binding.

### Disabled/remapped keys

- `null` disables an action; the physical key is consumed by `CcEditor` and
  **does not** fall through to Pi's editor defaults.
- Invalid bindings produce `error` diagnostics and disable the action rather
  than silently using defaults; unknown action ids are reported and ignored.
- Byte-equivalent bindings (`^H`, `^M`, `^[`, `^_`, Tab/Ctrl+I) are reported as
  `byte-ambiguous` when they collide in one context.
- `render / invalidate()` never changes input state: a spinner refresh no
  longer drops a pending chord timer or leaves a stale hint. `cancelChord()`
  is the single editor entry point (timer + keymap pending + hint); the keymap
  itself notifies on open/complete/cancel/timeout.
- `dispose()` is idempotent. It clears this editor's timer and detaches only
  its own shared-keymap chord listener, so an App editor replacement or a
  closed question/dialog cannot leave the old editor receiving hints; other
  live editors stay attached. Shared pending is cancelled only when this
  editor still owns it (generation match): disposing a hidden editor does not
  disturb the focused prompt's chord. `setKeymap(sameInstance)` re-attaches
  rather than disposing.
- `app.exit` remap/disable is honoured contextually for Ctrl+D, and the
  empty-draft guard applies before any global fallback.

## Draft / stash / search / external editor

- `captureDraft()` — lossless JSON: text, `expandedText`, cursor, pastes +
  counter, history + index + draft, kill ring, undo stack, last action,
  preferred column, scroll, paste-framing state.
- `restoreDraft(snapshot, {notify})` — same instance; restores browsing state
  and undo stack; `onChange` unless `notify:false`.
- `replaceDraftText(text, {cursor})` — undoable whole-draft replacement;
  Pi-normalizes CRLF/CR→LF and tabs→4 spaces, clears large-paste markers, and
  pushes the old state (including pastes) on the undo stack. An unchanged text
  is a true no-op: it returns false without calling Pi `setText`, so the paste
  registry, undo stack, cursor and held paste framing are preserved.
- `captureDraftForExternalEditor()` / `applyExternalEdit(text, snapshot)`.
- `restoreHistoryDraft()` — Esc while browsing returns the pre-browsing draft
  and consumes the key (no `app.cancel`/interrupt for that Esc).
- History entries are restored by snapshot, so search cancel can restore the
  exact draft without string hacks.

## Image attachments (CC style, memory only)

- `insertImage(upload)` inserts one atomic `[Image #N]` marker; the encoded
  upload stays in the editor's in-memory registry. `captureDraft()` /
  `restoreDraft()` carry it (memory snapshots only — never `history.json`).
- Atomicity uses the same segmentation as large-paste markers, so Backspace,
  Delete, Ctrl+W, Alt+Backspace, Ctrl+U/K, transpose, word motion and wrapped
  cursor movement never split a marker into bare text.
- Marker ids are monotonic and never reused. The high-water mark is raised by
  marker text that arrives from outside the editor — restored snapshots and
  `history.json` entries — so a new paste cannot take an id an older entry
  already points at. Restoring a *newer* draft or an older snapshot never rolls
  the mark back. At `Number.MAX_SAFE_INTEGER` the id space is exhausted and
  `insertImage` throws instead of wrapping.
- Unknown markers stay unresolved: a history entry or hand-typed `[Image #N]`
  without an upload is preserved verbatim, never upgraded to an attachment, and
  blocks the send through `onSubmitBlocked` (the draft is not cleared, so nothing
  is silently sent as text only).
- In-session history keeps images: submitting records the payloads referenced by
  that entry's own text, so Up recalls real images and a payload can never be
  attached to a marker it did not come from. The history payload registry is
  pruned with the history list and trimmed oldest-first by budget.
- Ordered content: one image part per visible marker occurrence, in place —
  repeating the same marker sends the same upload twice (the input layer never
  de-duplicates or rewrites the prompt; DSH stores content-addressed bytes).
- Budget: payloads still reachable from the draft, the real undo stack, the kill
  ring, the pre-browsing draft or the in-session history registry are never
  reclaimed; only unreachable spares are dropped. If the protected set would
  exceed the hard budget, `insertImage` refuses with `CcImageBudgetError`
  *before* editing the draft, so a new paste is rejected instead of breaking
  Ctrl+_ / Ctrl+Y on an older image.

## Submit dispatch (one capture path)

Every submit entry point captures the payload in `CcEditor.submitNow()` before
Pi clears the draft: Enter, backslash-Enter, autocomplete confirm, and the
public `ccSubmit()` override. The App calls `ccSubmit()` directly for send-now,
steer, follow-up and queue delivery, so routing it through the same capture is
what guarantees:

- a draft holding any `[Image #N]` **or** `[File #N]` marker is delivered to
  `onSubmitContent(payload)` whenever that consumer exists — the plain
  `onSubmit(text)` consumer never receives marker text (production installs
  both callbacks, so this is the normal path, not a corner case);
- unresolved typed/persisted markers block instead of being sent as text;
- attachments with no content consumer are blocked and the draft is preserved
  (undo/kill/yank keep working on it);
- a text-only draft keeps its existing callback behaviour (content consumer when
  installed, otherwise the legacy `onSubmit(text)`);
- `payload.snapshot` is the same pre-clear capture used by the Enter path, so a
  native rejection restores the identical draft (attachments and counters
  included).

## File attachments (native refs, memory only)

`[File #N]` is its own marker family, **not** an image with a different label.

- Native shape (parent-owned, shared `PromptContentPart`):
  `{ type: "file", attachment: { attachmentId, name, bytes } }`. The
  attachment id is opaque, `name`/`bytes` are metadata (never a host path and
  never inline bytes), and `bytes: 0` is a valid empty file. The parent stages
  bytes (`Backend.stageFile`) and hands the durable ref to the editor; the input
  layer never reads a file, a URL or a store, never calls `readImage` for a file
  and never promotes pasted path text into an attachment (`/attach <path>` is an
  explicit parent action).
- `insertFile({ part })` (or the bare part) inserts one atomic `[File #N]`
  marker; `addFile` is the same method. The ready part stays in the editor's
  in-memory registry, carried by `captureDraft()` / `restoreDraft()` only, never
  mirrored into `history.json`. A durable native `FileBlock` ref recalled from
  the DSH queue is **already admissible**, so it restores as a ready part
  directly (no byte read, no re-upload).
- Ids are separate from image ids and monotonic per family, never reused. A
  hand-typed `[File #N]` reserves its id before the next `insertFile`, so a new
  attachment can never silently resolve marker text it did not come from; that
  marker stays unresolved and blocks the send.
- Atomicity, undo, kill/yank, transpose, word/whitespace deletion, history
  recall, stash, external editor and pre-submit snapshot restore are identical
  to images: the marker is one unit and its payload stays resolvable while the
  draft, undo stack, kill ring, pre-browsing draft or in-session history can
  still reach it.
- Ordered content: one file part per visible marker occurrence, in place, with
  text/image/file interleaved exactly as typed. Repeating a marker repeats the
  part; nothing is de-duplicated or rewritten. `getFileAttachments()`,
  `getAttachmentOccurrences()` and `getAttachmentCounts()` are the preview/count
  source (data only; the UI renders it).
- Blocked submits keep the draft: a `[File #N]` marker without a native payload
  raises `CcUnresolvedFileAttachmentError` (after the image check, so a mixed
  draft reports images first), and any attachment without an `onSubmitContent`
  consumer is refused instead of being sent as text only.
- The one shared attachment budget (`imageBudgets`, kept by name for
  compatibility) now also bounds file payloads. It measures what this layer
  actually holds (the serialized part), never the declared file size, so a 10 MB
  file costs metadata only. `insertFile` refuses with `CcFileBudgetError` before
  editing the draft when the protected set would exceed the budget.

## Terminal limitations (honest gaps)

- Legacy terminals cannot distinguish Ctrl+H/Backspace, Ctrl+M/Enter,
  Ctrl+[/Esc, Ctrl+_/Ctrl+-. Kitty CSI-u or modifyOtherKeys is needed for
  Option/Alt+Backspace vs Ctrl+W, Ctrl+Shift+-, etc.
- macOS Option-as-Meta is terminal-configuration dependent; without CSI-u,
  Option+Delete may arrive as Ctrl+W.
- tmux/screen prefix keys and SSH splitting: paste markers are reassembled;
  chord bytes may still be intercepted by the multiplexer.
- Lone ESC is treated as Escape immediately; a paste marker fragmented to a
  single leading ESC byte is not reassembled (documented trade-off).
- IME composition/commit sequences are not interpreted here.

## Unverified / unsupported

- Exact CC yank-pop legality and ring-rotation order (Pi semantics used).
- PageUp/PageDown cursor paging inside the editor; list/dialog paging defaults.
- `Ctrl+Shift+R` (search forward) and `app.message.sendNow/followUp` defaults
  are unbound by design; app-state dependent.
- GNU commands not implemented: redo, quoted-insert (Ctrl+V is the CC clipboard
  override), numeric arguments, incremental forward search, history
  meta-commands, case conversion, full transpose-word.
- `editor.transpose.chars` is opt-in only because CC binds Ctrl+T to todo.
- `app.thinking.toggle`, `app.help` are DSH/Pi concepts, not CC defaults.

## Tests

`node --test test/input*.test.ts` (offline, no model calls, no readline):

- `test/input-keymap.test.ts` — defaults, contexts, fallback chains, aliases,
  chords (3000 ms), timeout/mismatch, disable/remap, diagnostics, help.
- `test/input-editor.test.ts` — Ctrl+W path/flag/yank/undo, word vs whitespace,
  punctuation/CJK word motion, grapheme emoji/combining, Ctrl+U/K + newline
  merges, accumulate/yank-pop, CC history boundaries (draft mid-line,
  multi-line, wrapped), Ctrl+A/E/B/F, Ctrl+D/Delete semantics, fragmented
  paste, large-paste marker + submit expansion, chord actions/cancel/timer,
  app overrides, disabled/remapped keys, printable vs list, submit/newline,
  completion nav/accept/edit-fallback.
- `test/input-skills.test.ts` — slash menu over native command/skill metadata:
  exact-name priority in the mixed command+skill catalog (exact Skill vs
  longer prefix command, pure-command and same-name controls), explicit
  navigation vs the exact default, Tab-edits/Enter-submits split through
  `onSubmitContent`, native `inputHint`/Pi `argumentHint` descriptions,
  dedupe/sanitization, delegation to Pi for plain path/argument/forced
  completion (with an explicit no-`fileReferences` `@` case), and
  single-flight/retryable skill refresh. `test/input-file-mentions.test.ts`
  covers the native `@file` domain.
- `test/input-image.test.ts` — `[Image #N]` atomicity (Backspace, Ctrl+W,
  Alt+Backspace, kill/yank), undo restores marker + payload, prompt content
  interleaving with repeated occurrences kept in order, undo/kill-ring payload
  protection and budget refusal, hand-typed markers blocked, pre-clear submit payload, image-only
  submit, no-content-consumer refusal, stash/snapshot round-trip, in-session
  history recall, persisted-history identity (id reservation, unresolved
  markers), safe-integer boundary, budget reclaim.
- `test/input-file.test.ts` — native file attachments: canonical
  `{ type: "file", attachment }` parts, `insertFile`/`addFile`, separate
  monotonic ids and mixed image/file order, atomicity for
  Backspace/Delete/Ctrl+W/Alt+Backspace/Ctrl+U/K/undo/yank, file-only submit,
  no-consumer refusal, hand-typed and persisted `[File #N]` markers blocking the
  send (and reserving their id before the next attach), plain-text/pasted paths
  never promoted, empty files and metadata-only sizes, snapshot JSON round trip
  with id high-water preservation and malformed-payload rejection, stash/modal
  context/external-editor transitions, in-session history recall, ready
  `FileBlock` recall without any byte read, budget refusal and per-family
  reclaim of unreachable payloads; plus the production **dual-consumer**
  dispatch regressions (outputs on both `onSubmit` and `onSubmitContent`, direct
  `ccSubmit()`): file-only/mixed/image drafts reach only the multipart consumer,
  text-only keeps its existing callback, no-consumer and unresolved-marker cases
  block with the draft/undo preserved, and multiline/bracketed-paste drafts keep
  their content and snapshot identity.
- `test/input-file-mentions.test.ts` — native `@file` mentions: DSH grammar
  tokens only (`abc@def`/`(@src` are not triggers), bare `@` empty query,
  callback order passthrough (no local sort/fuzzy), file/dir/spaced-quote
  mapping (closed submittable quote with the cursor before it, then drill-down),
  grammar-unrepresentable/malformed rows dropped, forced Tab, silent
  rejection/abort/stale and no reopened menu, no skill refresh, Enter/Tab
  fill-only plus second-Enter submit, and a child-process proof that slash /
  argument / non-`@` completion never loads the `@file` grammar (the offline
  `--demo` shape) while a missing grammar is a silent empty `@` domain.
- `test/input-image-details.test.ts` — `imageDetails` context/chain, locked
  action ids and bindings, Esc close precedence, preview toggle (`p`
  viewer-only, remap/disable, no conflict), global interrupt priority,
  read-only inertness (printable/editing/paste), Windows/WSL Alt+V alias.
- `test/input-image-screen.test.ts` — kitty full-redraw re-upload after a clear
  (Ghostty/Rex), placement-only optimisation on ordinary frames, resize
  cell-size re-query, no image work when the terminal reports no image
  protocol. The file injects the Kitty capability and restores default cell
  geometry through an `afterEach` hook (also after failed assertions), so it
  never depends on the host terminal's `TERM_PROGRAM`/`COLORTERM`.
- `test/input-snapshot.test.ts` — JSON snapshot round-trip, undo/kill/pastes,
  history-browsing restore, external-editor round trip, `replaceDraftText`
  undo, validation, one-editor-state invariants.
- `test/input-cancellation.test.ts` — review R08-R12 regressions: no-op
  replacement preserving pastes/undo/cursor, marker-aware transpose + undo,
  spinner invalidation vs chord timeout, paste/chord isolation, focus/config
  chord cancellation, non-empty Ctrl+D with disabled/rebound forward-delete or
  `app.exit`, jump target/control-key routing (Ctrl+W remap and DEL/Backspace),
  history-Esc consumption, completion Esc vs global Ctrl+C, Ctrl+C through
  pending chord/jump state, and idempotent `dispose()` with shared-keymap
  listener isolation.
- `test/input-model-picker.test.ts` — /model picker: new contexts/chains,
  raw keymap vs `CcEditor` text-first routing in both picker contexts, printable
  chord-prefix suppression, pending modifier chords and mismatch/timeout
  passthrough, digit quick-select suppression, action remap/disable
  (disabled Tab never emits `editor.complete`), `setContext()` snapshot and
  chord-ownership preservation, Enter/Esc forwarding without submit/clear,
  Ctrl+C priority, standard readline edits, fragmented paste and old-context
  regressions.
- `test/input-tool-details.test.ts` — tool details: action contract and one
  grouped Settings list registration; Ctrl+X Ctrl+O opens the latest-tool
  inspector while bare Ctrl+O keeps expand; draft/cursor/kill-ring/undo
  preservation; modal bytes for `[`/`]`/Alt+Left/Right tool switching,
  Tab/Shift+Tab/arrows/copy/list scrolling/Esc; no editor fallthrough in the
  read-only context; editor brackets stay text and Alt+Left/Right stay word
  motion; remap/disable of every new binding with old keys inert; Ctrl+C
  priority through a pending chord and local list.cancel; and the return to the
  editor where `c` is text again and readline edits still work.
- `test/input-subagents.test.ts` — native Agents overlay: `subagentList` and
  `subagentSession` contexts/chains, the two overlay-local actions
  (`subagent.reply`/`subagent.interrupt`) and their grouped Settings rows,
  `app.subagents.details` contract, chord uniqueness against prompt-mode
  chords, draft preservation, shared list/dialog/global fallback, read-only
  printable/editing/paste/jump inertness with `r`/`s` emitted as actions only,
  no callback and no editor/global leakage, root-only editor/app-draft commands
  failing closed while global `app.exit`, `app.interrupt` and `list.cancel`
  keep working, list/overlay/opening-chord remap/disable/reset, conflicts,
  Ctrl+C priority through pending chords, mouse input staying outside the
  keymap, and context-switch/paste/timeout/dispose chord ownership.
- `test/input-lifecycle.test.ts` — terminal start/stop ownership: one exit
  hook, one stdin/resize wiring, suspend/resume cycles without accumulation,
  a stopped renderer ignoring stale key/resize callbacks, stop-before-start and
  repeated stop, exit-restore on a direct process exit, failed start keeping
  the restore hook, debounced+cancelled cell-size query, disposed `CcEditor`
  inertness; plus private-PTY (`script -q`) cases for real raw-mode
  capture/restore, repeated `start()` idempotency with a single dispatch, and
  the fatal `process.exit()` restore byte stream (bracketed paste, keyboard
  protocol, cursor, alt screen). See `docs/INPUT-LIFECYCLE.md`.

Vendored TUI build: `pnpm build:pi-tui` (writes `vendor/pi-tui/dist/`).

## Attribution

Vendored source and the seam target `@earendil-works/pi-tui` 1.5.0 (MIT),
Copyright (c) 2025 Mario Zechner. The seam adds methods only and preserves the
upstream copyright/licence; THIRD_PARTY notices are handled by the parent.
