# Vendored Pi TUI

This directory is the source of `@earendil-works/pi-tui` 1.5.0 used by DSH TUI.
It is reached only through the private `#pi-tui` package-import seam, so the
upstream package name and this vendored copy stay the single Pi TUI identity.
It was extracted from the published package's JavaScript source maps (which
embed the upstream TypeScript sources), not from any Pi Agent/provider module.
Pi TUI is a terminal component library: it has no LLM provider, credential,
AgentSession, tool runtime or conversation persistence. DSH owns those.

Upstream: https://github.com/earendil-works/pi/tree/main/packages/tui
License: MIT, Copyright (c) 2025 Mario Zechner (see LICENSE).

The vendored source remains upstream code except for the documented local
deviations below. DSH-specific editor entry points live in
`src/input/pi-tui-seam.js` and are installed onto the public classes at runtime;
this avoids pnpm patches and keeps the upstream source easy to refresh.

## Local deviations from upstream 1.5.0

1. `src/tui-alt-screen.ts` and `src/tui.ts` — image-safe screen clears and cell
   geometry.
   - A full redraw clears the screen, and terminals may recycle Kitty image data
     that has no placement left (Ghostty 1.4.x and Rex's
     `ImageStorage.clearScreen` do). The renderer therefore drops its
     `uploadedKittyImages` cache on every full redraw, re-transmitting visible
     images (`a=T`) instead of assuming the bytes are still resident. The
     placement-only optimisation and the offscreen cache budget are unchanged
     for ordinary frames that never clear. `resetRenderState()` also drops the
     cache because the next frame starts from an unknown screen state.
     Exit condition: a terminal-level guarantee that a clear keeps images.
   - A terminal resize re-sends `CSI 16 t` (debounced 150 ms, unref'd timer,
     cleared on `stop()`) so image-capable terminals that report cell geometry
     late or change it (font zoom) keep correct image dimensions. The query and
     the `CSI 6;height;width t` reply still use the existing write/input path —
     no second stdin reader and no direct tty control.
2. `src/components/editor.ts` — atomic image and file attachment markers.
   - `[Image #N]` / `[File #N]` markers join `[paste #n]` in
     `segmentWithMarkers`, so cursor movement, deletion, kill/yank, transpose,
     wrapping and word navigation treat each as one unit without per-action
     marker surgery or a second Editor.
   - Opaque host-owned image/file payload families have separate monotonic ids,
     registries and in-session history. Shared marker insertion/reachability
     helpers keep them symmetric; restored/persisted/hand-typed ids raise the
     high-water marks and cannot accidentally bind to a later attachment.
     Undo snapshots remain text-only; native file refs hold metadata, not bytes.
   - `findImageMarkerIds()` / `findFileMarkerIds()` are host helpers; the
     app-specific capture/restore/submit policies remain in
     `src/input/pi-tui-seam.js` and `CcEditor`, not a native business backend.
   - Exit condition: upstream exposes an atomic-marker extension point that the
     seam can use instead. File support was a parent-approved narrow extension,
     not a global Pi edit or a pnpm patch.

Rendering/marker deviations are covered by offline tests
(`test/input-image-screen.test.ts`, `test/input-image.test.ts`,
`test/input-image-details.test.ts`, `test/input-file.test.ts`); refresh them with
every Pi TUI upgrade. File tests include direct/keyboard dual-consumer multipart,
atomic undo/kill/history, snapshot high-water ids and unresolved-marker blocking.

3. `src/terminal.ts` — idempotent `ProcessTerminal.start()` / `stop()` attach.
   - `start()` returns immediately when the input wiring is already attached, so
     a repeated `start()` cannot add a second `stdin` `'data'` listener (every
     key dispatched twice) or re-capture `wasRaw` while the terminal is already
     raw (the following `stop()` would then leave raw mode on).
   - `stop()` returns immediately when nothing is attached, so it never writes
     mode resets for a terminal this instance does not own.
   - A different owner must `stop()` the terminal before starting it; the input
     path stays single-owner. Renderer-level `TUI.start()` is unchanged.
   - Exit condition: upstream makes attach/detach idempotent, or DSH never
     restarts a terminal without an intervening stop (single-owner effect in the
     host). This deviation exists because a DSH plugin unload/reload and the
     suspend/resume + external-editor paths all call `start()` from more than one
     place, and the failure mode was a shell left in raw mode.

4. `src/terminal.ts` — injectable terminal writer.
   - `new ProcessTerminal({ write })` routes every renderer, cursor, clear,
     title, progress, protocol and capability-query write to the supplied
     `(data: string) => void` sink. The default is unchanged:
     `process.stdout.write` is still looked up at call time.
   - This exists so the native host can temporarily intercept JS
     `process.stdout`/`process.stderr` for diagnostics isolation while passing
     the original terminal writer (`lease.terminalWrite`) to the TUI. The
     renderer keeps sole ownership of visible terminal output; the host still
     owns the interception and its scoped restore.
   - `restoreOnExit()` deliberately remains a synchronous
     `fs.writeSync(process.stdout.fd, ...)` emergency path. It bypasses the
     injected writer so terminal modes are handed back on a direct
     `process.exit()` even when JS stdout is intercepted; it is renderer-owned
     exit output only, not a general write path.
   - Exit condition: upstream exposes an equivalent terminal writer injection
     point, or the host no longer needs to intercept process streams.

5. `src/program-status.ts`, `src/terminal.ts` — complete OSC 7501 records,
   capability policy, focus reporting and title-stack seams.
   - `ProgramStatus` gains optional `id`, `title` and `progress` with the exact
     revision 0.4 limits (4096-byte sequence, 2048/2732-byte `msg`,
     192/256-byte `title`, 32-byte `app`, 128-byte id over at most 8 segments of
     32 bytes). `formatProgramStatus()` returns `undefined` when a report must
     not be sent, including a malformed id: an invalid id never falls back to
     the root record.
   - `ProcessTerminal` keeps a bounded set of complete record snapshots
     (`PROGRAM_STATUS_MAX_RECORDS = 64`, least-recently-updated eviction), clears
     descendants with a parent clear, emits one root `state=clear` on `stop()`
     and replays only the records that are still current once support is
     confirmed again after a restart. No status heartbeat exists: records are
     replaced, never refreshed on a timer.
   - The support reply's `states`/`kinds` lists are parsed and honoured
     (`parseProgramStatusSupport`, `downgradeProgramStatus`). A reply whose
     `states` list contains no known state is treated as unsupported, and an
     unadvertised state degrades along a fixed chain (`blocked`→`working`→`idle`,
     `done`/`error`→`idle`) instead of becoming a false success.
   - New optional `Terminal` members: `programStatusSupported`,
     `onProgramStatusSupportChange`, `terminalFocused`, `onFocusChange`,
     `setFocusReporting`, `saveTitle`, `restoreTitle`, `setProgressFallback`.
     Focus reporting (DECSET 1004) and title-stack pushes are owned by the
     attached terminal instance: they are restored on `stop()`, on
     `restoreOnExit()` and re-armed on `start()`, and no write happens after
     ownership is released. `CSI I`/`CSI O` are consumed as terminal reports in
     the single input path, never as text, and an exact report also clears a
     stale CSI negotiation prefix so the prefix cannot flush into the editor.
     `restoreOnExit()` stops the legacy progress keepalive before writing its
     exit bytes, and a `stop()` after that emergency handoff still detaches the
     stdin handler, timers and raw mode while writing nothing visible.
   - Legacy OSC 9;4 is now idempotent (repeated frame-path calls write nothing)
     and is suppressed once a terminal negotiated rich OSC 7501 presentation;
     `setProgressFallback` lets the host override that policy per terminal.
   - Exit condition: upstream exposes id/title/progress records, a capability
     policy and focus/title lifecycle hooks.

6. `src/stdin-buffer.ts` — bounded, fail-closed reassembly of terminal replies.
   - `expectedReplyPrefixes`/`expectedReplyTimeout` let the owner declare a
     reply that may be split inside its header (for example a program-status
     query reply paused longer than the 50 ms sequence timeout) and hold it for
     a short bounded time. `replyTimeout` bounds any other recognized reply
     (OSC colour, XTVersion, Kitty graphics).
   - A recognized reply never becomes editor text. When it does not terminate
     inside its deadline, or when it exceeds `maxReplyBytes`, the payload is
     discarded and further input stays discarded (quarantine) until that
     reply's terminator (BEL/ST) arrives or the same finite deadline passes.
     While quarantined nothing is accumulated, so a stalled or hostile reply
     cannot grow memory; a bracketed paste ends the quarantine immediately so
     pasted content is never swallowed. Lone Escape, legacy `Alt+key`, ordinary
     typing after a completed/discarded reply and paste framing are unchanged.
   - Exit condition: upstream bounds reply reassembly and fails closed itself.

7. `src/components/editor.ts` — history browsing keeps the draft's attachment
   payloads and recalls entries at their end.
   - `exitHistoryBrowsing()` (called by 18 edit paths: typing, undo, insert,
     kill, delete, …) used to null `historyDraftImages`/`historyDraftFiles`
     without merging them back into the live registries. The pre-browsing
     draft's `[Image #N]`/`[File #N]` text stays on the undo stack and in the
     kill ring, so its payloads became unreachable and the host refused the
     draft with an unresolved-marker error even though Ctrl+_ restored the
     markers. The method now merges the draft payloads into the live registries
     before clearing them. Id spaces are monotonic, so merging cannot rebind an
     id (live entries stay authoritative, draft-only ids are added).
   - The only other restore path (`navigateHistory()` with `historyIndex ===
     -1`, i.e. Down/Esc back to the draft) is unchanged: it installs the draft
     registry instead of merging.
   - A recalled entry now places the cursor at the end of the entry
     (`setTextInternal()` default) instead of at column 0 for the Up direction.
     Readline/CC/Pi all resume a recalled entry at its end, so a keystroke after
     Up appends instead of prepending. Multi-line "sticky" behaviour does not
     depend on the cursor: it is decided by `historyIndex > -1`.
   - Exit condition: upstream keeps the pre-browsing draft's attachment
     registries alive on its own and resumes recall at the end of the entry.

8. `src/components/editor.ts` — `wordWrapLine()` terminates for a grapheme wider
   than the layout.
   - A segment wider than `maxWidth` is re-wrapped at grapheme granularity. For
     an atomic marker (paste/image/file) that split makes progress, but a single
     wide grapheme (CJK, emoji, ZWJ sequence) has no smaller unit, so
     `wordWrapLine(grapheme, maxWidth)` recursed with identical arguments. In a
     1-column layout (`layoutWidth === Math.max(1, …)`) every wide grapheme is
     wider than the width, so `render(1)`/`render(2)` on CJK text crashed with
     `RangeError: Maximum call stack size exceeded`.
   - The re-wrap now only runs when the segment contains more than one grapheme;
     an unsplittable grapheme stays one chunk and the visual line overflows the
     column instead of crashing. Cursor movement, marker atomicity and the
     marker-in-a-narrow-terminal split are unchanged.
   - Exit condition: upstream word-wrap handles an unsplittable wide grapheme.

9. `src/components/editor.ts` — a large paste never takes an id that existing
   marker text already uses.
   - `notePasteMarkerIds()` (new, public, mirrors `noteImageMarkerIds`/
     `noteFileMarkerIds`) raises `pasteCounter` from `[paste #N …]` text already
     in the draft, and the large-paste path calls it before allocating an id.
     Otherwise a hand-typed or restored `[paste #1 999 chars]` made the next
     large paste take id 1, and submit expanded the typed marker into that
     paste's content (`expandPasteMarkers` matches by id). The typed marker now
     stays literal text and the new paste gets the next free id.
   - Id reservation is one-way: it never rewrites marker text and never expands
     a typed marker. Pi's marker deletion/renumbering path is untouched.
   - Exit condition: upstream reserves paste ids from existing marker text.

All deviations are covered by DSH TUI's offline tests
(`test/input-lifecycle.test.ts` covers the lifecycle one with a private PTY and
a fake terminal; `test/input-terminal-output.test.ts` covers writer injection
with an in-process stream probe and a private PTY;
`test/input-terminal-integration.test.ts` covers OSC 7501 encoding/limits,
capability policy, record replay/clear, focus isolation from input and paste,
title-stack balance, progress policy, after-stop write gating and the bounded
reply reassembly; `test/input-regressions.test.ts` covers deviations 7-9 —
history-browsing payload survival for both attachment families, the 1-3 column
CJK/emoji/ZWJ and paste-marker wrap layouts, recall-at-end, and paste-id
reservation); refresh them with every Pi TUI upgrade.
