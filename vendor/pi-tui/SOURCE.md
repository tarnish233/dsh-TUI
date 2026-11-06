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
2. `src/components/editor.ts` — atomic image attachment markers.
   - `[Image #N]` markers are merged in `segmentWithMarkers` alongside
     `[paste #n]` markers, so every upstream editing path (cursor movement,
     deletion, kill, transpose, wrapping, word navigation) already treats them
     as one unit without per-call-site special cases.
   - The editor keeps an opaque, host-owned payload registry
     (`insertImageAttachment`, `getImageAttachment*`, `setImageAttachmentEntries`),
     an in-session history registry, and a monotonic id high-water mark that is
     raised by marker text from restored drafts and persisted history. Undo
     snapshots stay text-only, so encoded bytes are never cloned per keystroke.
   - `findImageMarkerIds()` is exported for the host layer.
   - Exit condition: upstream exposes an atomic-marker extension point that the
     seam can use instead.

Both deviations are covered by DSH TUI's offline tests
(`test/input-image-screen.test.ts`, `test/input-image.test.ts`,
`test/input-image-details.test.ts`); refresh them with every Pi TUI upgrade.

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

All deviations are covered by DSH TUI's offline tests
(`test/input-lifecycle.test.ts` covers the lifecycle one with a private PTY and
a fake terminal; `test/input-terminal-output.test.ts` covers writer injection
with an in-process stream probe and a private PTY); refresh them with every Pi
TUI upgrade.
