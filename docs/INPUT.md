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
- **Seam installer** (`src/input/pi-tui-seam.js`) adds *only* the app entry
  points to Editor/SelectList prototypes: `ccCaptureSnapshot`,
  `ccRestoreSnapshot`, cursor/word/whitespace primitives, kill/yank/undo,
  history browsing, atomic replacement, paste/insert, submit/newline,
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

## Vendored TUI integration (parent)

1. `pnpm install` links the local file dependency
   `@earendil-works/pi-tui: file:vendor/pi-tui`; there is no pnpm patch.
2. `pnpm build:pi-tui` compiles the vendored TypeScript to
   `vendor/pi-tui/dist/` (the package entry). `pnpm check` runs it first.
3. `CcEditor` installs `src/input/pi-tui-seam.js` once at module load and
   throws an actionable error if the seam is missing.
4. Offline tests use the same vendored package; no module-loader redirect,
   patch hash or scratch-package copy is required. Refresh the vendored source
   from the pinned upstream release when upgrading, then rebuild and run the
   full input/terminal suite.

## Behaviour coverage

Status vocabulary: **match** (intended CC/readline parity), **app override**
(CC repurposes the key), **Pi extension**, **unverified**, **unsupported**.

| Family | Keys | Semantics / status |
| --- | --- | --- |
| Line/char motion | Ctrl+A/E, Home/End, Ctrl+B/F, Left/Right | logical line start/end; grapheme movement; line-boundary wrap follows Pi. match |
| Word motion | Alt+B/F, Alt+Left/Right, Ctrl+Left/Right | punctuation + CJK aware via Intl.Segmenter; platform aliases bound together. match (terminal coverage caveat) |
| Vertical/history | Up/Down, Ctrl+P/N | visual line first; on first/last visual line browse history; **no Pi jump-to-column-0 step**; draft, cursor and paste markers restored. match |
| Char delete | Backspace, Ctrl+H, Delete, Ctrl+D | grapheme-safe; line-boundary merge; Ctrl+D exits only when empty **and** Ctrl+D is still bound to enabled `app.exit`; empty Delete no-ops. match |
| Whitespace kill | Ctrl+W | shell-whitespace boundary: whole path/flag; paste markers atomic; column-0 merges newline. match |
| Word kill | Alt+Backspace, Ctrl+Backspace, Alt+D/Alt+Delete | punctuation/CJK boundaries (Option+Delete on macOS). match |
| Line kill | Ctrl+U, Ctrl+K | kill ring, newline merge at boundaries, empty-line behaviour = Pi. match |
| Yank | Ctrl+Y, Alt+Y | consecutive kills accumulate in kill direction; yank-pop only immediately after yank. match; CC yank-pop legality **unverified** |
| Undo | Ctrl+_ / Ctrl+- / Ctrl+Shift+- | restores text+cursor+paste registry; typing coalesced, kills/yanks/pastes atomic. match (byte equivalence documented) |
| Submit/newline | Enter, Shift+Enter, Ctrl+J, Alt+Enter, backslash+Enter | Enter submits; others newline; backslash fallback. match |
| Completion | Tab, Enter/Esc with menu, Ctrl+P/N in menu | menu owns nav/accept/cancel; editor editing works beneath. unverified for exact CC accept/submit split |
| Paste | bracketed paste, Ctrl+V | fragmented start/end markers reassembled; pasted bytes never dispatched as keys/chords; large paste → `[paste #n ...]` marker with undo/snapshot preservation; submit expands. match |
| Editing aids | Ctrl+L, Ctrl+G / Ctrl+X Ctrl+E, Ctrl+S, Ctrl+R | forwarded to the app; editor forwards after closing completion / restoring history draft. app override |
| App overrides | Ctrl+T/O/V/S/G, Alt+P, Shift+Tab, Ctrl+Z | `app.todo/tools.expand/clipboard.pasteImage/stash/editor.external`, `app.model.select`, `app.mode.cycle`, `app.suspend`. app override |
| Chords | Ctrl+X Ctrl+E + user chords | prefix wait, **3000 ms** default timeout (expires at the deadline), cancel on mismatch and redispatch, `onChordChange` hint hook. match (timeout value per CC docs) |
| Config | all actions | multiple keys, disable (`null`), remap, contexts, hot reload, conflicts/byte-ambiguity/chord-shadow diagnostics, grouped Settings editor. match |
| Lists/dialogs/search | j/k/1-9, arrows, Enter/Esc, Ctrl+R | separate contexts; list keys never leak into text fields; search keeps editor editing fallback. app override |

### Keyboard settings and native permissions

Open `/settings` → **Keyboard shortcuts**. One grouped list shows current
keys and action descriptions, including unbound actions; there is no standalone
`/hotkeys` command, debug/compatibility columns, profile hierarchy or conflict
resolution wizard. Select a row to edit it; `d` disables it and `r` removes just
that override to restore the effective app default.

The inline CC editor takes one alternative per line (Shift+Enter adds a line);
spaces retain native chord syntax, e.g. `ctrl+x ctrl+e`. Option is an alias of
Alt in this field. Enter saves, Esc cancels. The existing keymap validates keys
and reports newly introduced conflicts before an atomic write to the same
`keybindings.json` override map. Malformed files and failed validation are not
overwritten; unrelated overrides are preserved, defaults are never dumped.

This configuration pane alone reserves arrows, Enter/Esc, and list-mode d/r
as recovery controls, so editing navigation cannot lock out its user. Normal
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
combining marks and large-paste markers are atomic. `ccReplaceRange` (used by
transpose) is grapheme-boundary safe as called by the editor glue.

### Context fallback chains

- `editor → global`
- `autocomplete → editor → global`
- `historySearch → editor → global`
- `dialog → editor → global`
- `list → global`

Local actions win; global app bindings are a fallback. This is why Ctrl+W,
Ctrl+A, Alt+B etc. still edit while completion or history search is open, and
why Ctrl+C/Esc still reach the app in dialogs.

### Disabled/remapped keys

- `null` disables an action; the physical key is consumed by `CcEditor` and
  **does not** fall through to Pi's editor defaults.
- Invalid bindings produce `error` diagnostics and disable the action rather
  than silently using defaults; unknown action ids are reported and ignored.
- Byte-equivalent bindings (`^H`, `^M`, `^[`, `^_`, Tab/Ctrl+I) are reported as
  `byte-ambiguous` when they collide in one context.
- `app.exit` remap/disable is honoured contextually for Ctrl+D.

## Draft / stash / search / external editor

- `captureDraft()` — lossless JSON: text, `expandedText`, cursor, pastes +
  counter, history + index + draft, kill ring, undo stack, last action,
  preferred column, scroll, paste-framing state.
- `restoreDraft(snapshot, {notify})` — same instance; restores browsing state
  and undo stack; `onChange` unless `notify:false`.
- `replaceDraftText(text, {cursor})` — undoable whole-draft replacement;
  Pi-normalizes CRLF/CR→LF and tabs→4 spaces, clears large-paste markers, and
  pushes the old state (including pastes) on the undo stack.
- `captureDraftForExternalEditor()` / `applyExternalEdit(text, snapshot)`.
- `restoreHistoryDraft()` — Esc while browsing returns the pre-browsing draft.
- History entries are restored by snapshot, so search cancel can restore the
  exact draft without string hacks.

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
- `test/input-snapshot.test.ts` — JSON snapshot round-trip, undo/kill/pastes,
  history-browsing restore, external-editor round trip, `replaceDraftText`
  undo, validation, one-editor-state invariants.

Vendored TUI build: `pnpm build:pi-tui` (writes `vendor/pi-tui/dist/`).

## Attribution

Vendored source and the seam target `@earendil-works/pi-tui` 1.5.0 (MIT),
Copyright (c) 2025 Mario Zechner. The seam adds methods only and preserves the
upstream copyright/licence; THIRD_PARTY notices are handled by the parent.
