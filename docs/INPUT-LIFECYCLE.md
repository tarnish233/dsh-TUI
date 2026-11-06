# Input / terminal lifecycle seam

Short report for the app and host-plugin owner. Everything below is observed
behaviour of the vendored Pi TUI (`vendor/pi-tui`, `#pi-tui`) plus the input
subsystem (`src/input/`), not a proposal for a new terminal abstraction.

## Who owns what

| layer | owns | does not own |
| --- | --- | --- |
| DSH host (Cordis) | process lifetime, `SIGINT`/`SIGTERM`/`SIGHUP`, `ctx.effect` disposal, `installFailLoud` release budget, `ctx.logger` | terminal modes, stdin, rendering |
| App (parent) | when the TUI starts/stops, suspend/resume, shutdown order, exit code | raw bytes, key semantics |
| `ProcessTerminal` (vendor) | raw mode, bracketed paste, keyboard-protocol negotiation, `stdin`/`stdout` handlers, exit-restore bytes | app state |
| `TUI` renderer (vendor) | focus, frames, overlays, render throttle, resize debounce, process exit hook | the terminal interface implementation |
| `CcEditor` (`src/input/`) | one editor state, keymap, chords, paste framing | process/terminal hooks |

There is exactly one stdin consumer (`ProcessTerminal.start`) and one editor
state. Nothing in `src/input/` reads `process.stdin`, writes `process.stdout`,
or installs signal handlers.

## Startup protocol queries never block

`ProcessTerminal.start()` writes bracketed-paste enable, the Kitty keyboard
flags query, a DA1 sentinel, the optional OSC 7501 program-status query and
(only for image-capable terminals) `CSI 16 t`, then returns immediately. It
never awaits a reply, and `TuiMainScreen` / `TuiAltScreen` `start()` are
synchronous, so a terminal that ignores every capability query cannot stall the
first frame or the host's ready path. Late/split replies are handled on the same
single stdin consumer; an unanswered query simply leaves the legacy key fallback
in place.

Observed offline in a private PTY with a temporary `HOME`/`DSH_HOME` and config
dir, using the alias `bin/dsh-tui.mjs --demo` and a terminal that deliberately
answered no queries:

- no screen flag → default fullscreen enters the alternate screen, reaches
  `ready` in ~0.2 s, and restores paste mode, cursor and alt screen on exit;
- explicit `--inline` → main screen, same startup path, no alternate-screen
  bytes.

No model, backend, real profile, clipboard or terminal query reply was
involved. The existing private-PTY lifecycle cases (`script -q`) exercise the
same non-answering terminal path for `ProcessTerminal` start/stop.

## Injected terminal writer

`new ProcessTerminal({ write })` (vendor local deviation 4) routes every
renderer, cursor, clear, title, progress, protocol and capability-query write to
the supplied `(data: string) => void` sink. Omitting it keeps the previous
behaviour: `process.stdout.write` is called at write time.

This is the renderer half of the host's diagnostic-isolation seam. When the host
temporarily intercepts JS `process.stdout`/`process.stderr`, it passes the
original terminal writer (for example a `lease.terminalWrite`) to
`ProcessTerminal`; TUI bytes keep reaching the terminal while sibling-plugin
diagnostics go to the host's controlled log sink. The host, not Pi TUI, owns
capturing, sanitizing, bounding and restoring the intercepted streams.

`restoreOnExit()` intentionally stays a synchronous
`fs.writeSync(process.stdout.fd, ...)` emergency path. It bypasses the injected
writer so a direct `process.exit()` hands the terminal back even when JS stdout
is intercepted. It emits only renderer-owned mode-reset/exit bytes; it is not a
general output path and does not make fd-level isolation universal.

## Lifecycle contract (verified by `test/input-lifecycle.test.ts`)

`TuiMainScreen` / `TuiAltScreen`:

- `start()` registers **one** `process.on("exit")` last-resort restore hook,
  attaches the terminal, hides the cursor and requests a frame.
- `stop({ preserveScreen? })` removes that hook, cancels the render throttle and
  the cell-size query timer, shows the cursor and detaches the terminal.
- Repeated suspend/resume cycles (`stop({ preserveScreen: true })` then
  `start()`) do not accumulate hooks, listeners or timers.
- After `stop()` the renderer is inert: a host terminal that still holds the
  input/resize callbacks cannot paint, schedule a frame or start a query.
- `stop()` before `start()` and extra `stop()` calls do not throw and never
  re-register the exit hook.
- A throwing `terminal.start()` leaves the restore hook installed, so a fatal
  path still hands the terminal back; a later `stop()` cleans up.
- An image-capable terminal gets one `CSI 16 t` on start and one debounced
  re-query per resize burst; `stop()` cancels a pending re-query.

`ProcessTerminal` (private PTY tests):

- `start()` puts the real terminal in raw mode, attaches exactly one `stdin`
  `data` listener, one `stdout` `resize` listener and one exit hook.
- A repeated `start()` without an intervening `stop()` is a no-op: no second
  stdin wiring, and the first captured `wasRaw` is kept, so a later `stop()`
  really restores the shell. This is local deviation 3 in
  `vendor/pi-tui/SOURCE.md`; the pre-fix behaviour dispatched every key twice
  and could leave the shell in raw mode.
- `stop()` restores raw mode, removes every handler, pauses stdin and is a no-op
  when nothing is attached (it never writes mode resets for a terminal it does
  not own).
- `process.exit()` without `stop()` still writes the synchronous restore
  sequence: bracketed paste off, Kitty keyboard-protocol pop, cursor show, and
  the alternate-screen exit for `TuiAltScreen`.

`CcEditor`:

- `dispose()` is idempotent and removes only this editor's shared-keymap
  listener; a pending chord is cancelled only when this editor opened it.
- After `dispose()` the editor is inert: late terminal input cannot edit text,
  emit `onAction`, queue a submit or leave a chord timer behind. A host that
  disposes the editor before the renderer has stopped therefore cannot run an
  app action from bytes still in flight.

## Host integration notes

1. Start and stop the TUI from a single owner (one Cordis effect, one
   `terminalOwner` flag). `start()` before another `start()` is tolerated by the
   terminal but silently keeps the first owner's callbacks, so only the host
   state machine can guarantee a correct re-target.
2. Register the teardown effect **last**: Cordis runs disposers in reverse
   registration order, so the terminal is handed back before other plugins
   release their resources.
3. The restore path must be synchronous and idempotent (`tui.stop()` guarded by
   a `restored` flag, skipping the second stop while the TUI is paused for
   suspend or an external editor). `drainInput()` belongs after that, bounded,
   and must tolerate a terminal that is already gone.
4. A fatal path exits through the host's release hook; the exit-restore bytes
   are the last layer of defence, not the primary one.
5. While the TUI is active, diagnostics go to `ctx.logger` only. Do not write
   `process.stdout`/`process.stderr` or use `console.*`; the renderer owns the
   visible terminal and raw mode is on.
6. `Ctrl+Z` stays bound to `app.suspend` (CC default) and is host policy, not a
   keymap option: suspending needs `SIGTSTP`/`SIGCONT`, which is independent of
   whether the host registered `SIGINT`/`SIGTERM`.
7. Keep exactly one stdin consumer. A stdin-EOF policy (host shutdown when the
   terminal goes away) must be an `'end'` listener that neither reads nor
   resumes stdin.

## Tests

`test/input-lifecycle.test.ts` — recording fake terminal (in-process) and
private PTY children (`script -q`, one PTY per case, results in files, the
current pane is never touched). No model, backend, credential or user-profile
access.

`test/input-terminal-output.test.ts` — source-level writer injection against the
vendored `ProcessTerminal`/`TuiMainScreen`: default `process.stdout.write`
behaviour, injected startup/protocol/render/title/progress/cleanup writes with
stdout intercepted, restart lifetime, and the synchronous `restoreOnExit` fd
bypass in a private PTY with temporary homes. Rebuild `vendor/pi-tui/dist` before
package/runtime acceptance; the test imports source and does not race the build.
