# Ghostty compatibility (verified source evidence)

Status: **source audit + offline protocol tests. No live GUI acceptance.** The
installed Ghostty was not driven here; the parent owns the isolated native-GUI
fixture. Everything below that says *verified* means "read in the Ghostty
source at the tag matching the installed version", not "observed on screen".

## 1. Versions and method

| item | version | how verified |
| --- | --- | --- |
| Installed Ghostty | `Ghostty.app` `1.4.0` (macOS) | `defaults read /Applications/Ghostty.app/Contents/MacOS/../Info.plist CFBundleShortVersionString` |
| Ghostty source | tag `v1.4.0` | `raw.githubusercontent.com/ghostty-org/ghostty/v1.4.0/...`; local copies in `.cache/terminal-integration/ghostty-docs/` |
| Ghostty tip | `main` | `src/termio/stream_handler.zig` re-checked for the two unimplemented actions |
| dsh-tui side | vendored Pi TUI `1.5.0` (`vendor/pi-tui`) | `test/input-terminal-integration.test.ts` (offline) |
| Official docs | <https://ghostty.org/docs/vt/reference> plus the linked OSC/CSI pages | fetched 2026-11 |

The audit deliberately does not use the official docs alone: several sequences
are *parsed* but not *used* by the GUI (see §3), and the docs describe the
parser, not the app. Strings in the binary are also not evidence: the OSC 7501
reply string is compiled in through the reusable `terminal/stream_terminal.zig`
handler even though the macOS app never registers that handler.

## 2. What a program sees

Verified in `src/termio/Exec.zig` (`TERM`, `COLORTERM`, `TERMINFO`,
`TERM_PROGRAM`, `TERM_PROGRAM_VERSION`) and `src/terminal/osc/parsers/report_pwd.zig`:

- `TERM_PROGRAM=ghostty`, `TERM_PROGRAM_VERSION=<version>`, `COLORTERM=truecolor`.
- `TERM=xterm-ghostty` **only when a resources directory is found**; otherwise
  `xterm-256color` plus a warning. Never rely on `TERM` alone.
- `TERMINFO=<bundle>/terminfo` when the bundled entry is used, so `xterm-ghostty`
  resolves locally but not on a remote host without the terminfo entry.
- `GHOSTTY_RESOURCES_DIR`/`GHOSTTY_BIN_DIR` are inherited, and
  `GHOSTTY_SHELL_FEATURES` describes the shell integration that was injected.

Consequence for dsh-tui: capability detection stays protocol-based (queries),
with `TERM_PROGRAM`/`GHOSTTY_*` only as hints. `src/input/native-autocomplete.ts`
and the renderer already treat escape sequences as non-text.

## 3. Sequence support that matters to this TUI

| sequence | Ghostty 1.4.0 | evidence |
| --- | --- | --- |
| Kitty keyboard flags `CSI > u`, `CSI < u`, `CSI ? u`, `CSI u` | full (all five flags) | `src/terminal/kitty/key.zig:79`, `src/terminal/stream.zig:2665-2716` |
| Bracketed paste (`?2004`) | yes | `src/terminal/modes.zig` |
| Focus reporting (`?1004` → `CSI I` / `CSI O`) | yes | `src/terminal/modes.zig:388`, `src/terminal/focus.zig`, `src/termio/Termio.zig:681` |
| Synchronized output (`?2026`) with render-hold callbacks | yes | `src/terminal/modes.zig:402`, `src/terminal/stream_terminal.zig:314` |
| Mouse `1000/1002/1003/1006/1015/1016`, alt screen `1049` | yes | `src/terminal/modes.zig` |
| Kitty graphics + `CSI 16 t` cell size | yes | `src/terminal/stream.zig:2596` (`size_report`), `src/terminal/kitty/graphics*.zig` |
| OSC 0/2 window title | yes | `src/terminal/osc/parsers/change_window_title.zig` |
| OSC 7 working directory | yes (may also set the title before a title is seen) | `src/termio/stream_handler.zig:1511` |
| OSC 9;4 progress | yes, `progress-style` default `true`; macOS clears after a hardcoded 15 s | `src/config/Config.zig:3902`, `macos/Sources/Ghostty/Surface View/SurfaceView_AppKit.swift:29` |
| OSC 9 / OSC 777 / OSC 99 notifications | yes, `desktop-notifications` default `true`; macOS needs notification authorization | `src/terminal/osc.zig:97,487`, `parsers/osc9.zig`, `parsers/rxvt_extension.zig`, `parsers/kitty_desktop_notification.zig`, `src/Surface.zig:1144` |
| Title stack `CSI 22;0t` / `CSI 23;0t` | **parsed, GUI ignores** | `src/terminal/stream.zig:4961,5064` (tests) vs `src/termio/stream_handler.zig:380-390` (`title_push`/`title_pop` in the *Unimplemented* branch) |
| OSC 7501 program status | **parsed, GUI ignores; no reply** | parser `src/terminal/osc/parsers/program_status.zig`; GUI dispatch `src/termio/stream_handler.zig:388` (`program_status` unimplemented). The reply exists only in `src/terminal/stream_terminal.zig:983`, an embedding API the app does not use. Same in `main`. |

### Why "the binary contains the reply string" is not evidence

`stream_terminal.zig` is the reusable libghostty handler: it writes
`osc.program_status.query_reply` only when `effects.program_status != null`.
The macOS app uses `src/termio/stream_handler.zig`, whose OSC switch lists
`.program_status` (and `.title_push`, `.title_pop`, `.kitty_dnd`,
`.osc_unknown`) under `// Unimplemented => {}`. A support query therefore gets
no reply, and reports are dropped. Any live GUI result that shows a reply would
contradict the v1.4.0 source and should be re-checked against the installed
version before being encoded as a capability.

**Consequence in dsh-tui:** a Ghostty pane keeps the legacy OSC 9;4 progress
path (`programStatusSupported === false`), and the title stack is a no-op there,
so a caller must keep an explicit title fallback. If a future Ghostty version
implements the handler, the same code switches to 7501 records with no change.

## 4. Focus, titles and progress policy

- Focus: Ghostty emits `CSI I` / `CSI O` only while DECSET 1004 is enabled. The
  TUI enables it through `Terminal.setFocusReporting(true)` (owned by the
  attached terminal instance, restored on stop/emergency exit). Reports are
  consumed in the single stdin path and never reach the editor.
- Titles: `saveTitle()`/`restoreTitle()` write the xterm title stack
  (`CSI 22;0t` / `23;0t`) and are **best effort only**. Ghostty 1.4.0 parses and
  ignores both (`src/termio/stream_handler.zig`, unimplemented branch); the
  installed Rex version also ignores the stack and does not answer the
  `CSI 21 t` title query (owned live probe logs). No restoration may be claimed
  anywhere: the caller keeps the last title it set and re-applies it explicitly
  on resume, and the push/pop pair exists only so that terminals which do honour
  the stack unwind correctly on stop and on the emergency exit path.
- Progress: legacy `OSC 9;4` is idempotent and keepalive-bounded (1 s, below
  Ghostty's 15 s staleness window). Once a terminal negotiates rich OSC 7501
  presentation the fallback is suppressed; `setProgressFallback(true)` keeps it
  available for a terminal that advertises 7501 but has no presentation for it,
  `setProgressFallback(false)` suppresses it unconditionally.
- Notifications (OSC 9/777/99) are **not** written by the vendored terminal and
  are not part of this seam. The policy owner decides whether to send them, and
  Ghostty's own authorization/rate limits stay terminal-owned.

## 5. Multiplexers

tmux does not forward these protocols unchanged, and the defaults are
restrictive (checked in `options-table.c` for tmux 3.8 and master):

| tmux option | default | effect on dsh-tui |
| --- | --- | --- |
| `extended-keys` | `off` | Kitty flags are not negotiated; the DA1 sentinel arrives first, so the terminal falls back to `modifyOtherKeys` (`CSI > 4;2m`), and without `extended-keys on` modified keys stay legacy-encoded |
| `focus-events` | `off` | no `CSI I`/`CSI O` are delivered even when 1004 is enabled |
| title stack / `CSI 21 t` | emulator-specific | Ghostty 1.4.0 ignores both; treat title restore as best effort only |
| `allow-passthrough` | `off` | bare OSC 9/99/777/7501/9;4 are dropped; only DCS-wrapped (`ESC P tmux; … ESC \`) sequences pass, and only when enabled |
| `set-clipboard` | `on` | OSC 52 writes are intercepted by tmux |

No automatic passthrough is implemented: the TUI negotiates with the terminal it
actually has and downgrades safely (no status, no notifications, legacy keys).
Passthrough remains an explicit, documented opt-in for users who configure tmux
themselves.

## 6. Verified offline, and what is still open

Verified by `test/input-terminal-integration.test.ts` (private PTY, temporary
homes, no model/credential access):

- fragmented OSC 7501 reply (split inside the header, pause longer than the
  50 ms sequence timeout) is reassembled and consumed, never typed; a stalled,
  oversized or unterminated recognized reply (OSC colour, XTVersion, Kitty
  graphics, expected 7501) is discarded with its tail instead of being reparsed
  as keys, and typing resumes after its terminator or the finite deadline;
- no status bytes before negotiation, no bytes to a DA1-only terminal, bounded
  record replay after renegotiation, cleared records not replayed;
- focus reports delivered once per transition and never forwarded as input;
  focus/capability literals inside a bracketed paste stay paste content;
- title stack pushes/pops balanced and restored on stop and on the emergency
  exit path; no writes after ownership is released;
- legacy progress suppressed after negotiation, re-enabled by policy, and
  idempotent on repeated frame calls.

Open (parent-owned): a live Ghostty GUI check of §3's two "GUI ignores" rows.
Success criteria: sending `ESC ] 7501 ; ? ST` followed by `CSI c` from a pane
yields `CSI ?…c` only, and `CSI 22;0t` does not restore a title. A reply would
mean the installed build differs from the v1.4.0 source and the capability
matrix must be updated before enabling 7501-specific behaviour.