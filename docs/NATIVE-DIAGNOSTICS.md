# Native diagnostics projection (frontend seam)

The frontend half of the approved terminal/diagnostic isolation fix. The
application/plugin owns terminal ownership, the bounded private log and fatal
restoration; the backend (`src/backend/terminal-output.ts`) owns raw capture,
classification, sanitization and the log itself. This module only decides which
already-classified record may become an existing transcript notice.

Proven defect: native DSH catalog diagnostics are written by a sibling plugin
through the global `console.error`/`console.warn` (fd 2), not `ctx.logger`. They
share the terminal with the renderer, start at the focused editor's caret and
overwrite its row/border, including on every successful listing refresh. See
`.cache/terminal-log-analysis/REPORT.md` and `.cache/input-stderr-demo/report.md`.
That evidence does not justify removing refresh/providers, a second backend or
an Editor that deletes matching text.

## Public interface

`src/ui/native-diagnostics.ts`

```ts
import { createNativeDiagnosticProjection } from './ui/native-diagnostics.ts'

const projection = createNativeDiagnosticProjection(
  (message, level) => this.reportNativeDiagnostic(message, level), // existing notice plane
  { maxNotices?, maxSignatures?, maxPreviewColumns?, windowMs?, now? },
)
projection.handle(record) // one backend TerminalDiagnosticRecord; safe after close
projection.dispose()      // idempotent, called on frontend teardown/shutdown
```

`level` is `'info' | 'error'` so the parent maps directly onto
`TranscriptStore.report(text, level)`. Warnings are muted (`'info'`) notices and
the limit line is informational; fatal text never reaches this plane. A
one-argument callback is also valid TypeScript.

No new logger, debug panel, setting, prompt, parallel editor or provider/catalog
classifier: the module has no editor/renderer/state and only invokes `report`.
`now` is a test seam, never a user setting.

## Backend record contract (backend-owned, type-only import)

The projection consumes the backend's own type, so the contract cannot drift:

```ts
export interface TerminalDiagnosticRecord {
  readonly channel: 'stdout' | 'stderr'
  readonly kind: 'routine' | 'warning' | 'fatal'
  readonly text: string // already sanitized single line, tag included
}
```

`import type` is erased at runtime: the frontend loads no backend adapter code.
The emitter tag stays inside `text` (e.g. `[llm-deepseek-account] …`); `channel`
is informational only and does not affect dedupe. The frontend adds no
provider/catalog rules — only `kind === 'warning'` is ever surfaced.

## Routing rules

| record | editor | transcript | bounded native log |
| --- | --- | --- | --- |
| `routine` (successful refresh), unknown kind | untouched | nothing | sanitized line |
| `warning`, first occurrence in the window | untouched | one `Native warning: …` notice | sanitized line |
| same sanitized text again (any window) | untouched | suppressed (deduped) | sanitized line |
| `warning` after the window's notice budget | untouched | nothing (one limit line was already shown) | sanitized line |
| `fatal` | untouched | **nothing** — parent restores the terminal and forwards native fatal stderr | sanitized line |

Preview safety: ANSI/OSC sequences and C0/C1 controls are stripped, whitespace
is collapsed to one line, and the preview is truncated by display width (default
160 columns, CJK/emoji safe), so a malformed record cannot repaint the screen
through the notice plane either.

## Bounds and lifetime

- **Notice budget per time window**: at most 8 warning notices per rolling 60 s
  window (`windowMs`, injectable; integration constant, not a user setting).
  A burst therefore stays quiet after a single explicit limit line —
  `Further native diagnostics are suppressed for now; recent lines remain in the
  bounded native log.` The native log is bounded (rotated/truncated), so no copy
  claims to hold the complete record.
- **The window rolls forward, so nothing is muted forever**: a later, genuinely
  new warning becomes visible again in the next window; each window gets its own
  one limit line. A backwards clock jump (suspend/resume) starts a new window; a
  non-finite clock reading leaves the current window alone instead of resetting
  the budget on every record.
- **Dedupe memory**: at most 32 remembered signatures of warnings the user
  actually saw (insertion-order eviction). A successfully reported diagnostic
  never repeats, across windows and streams. A record suppressed by the window
  budget or by a failed report callback is **not** remembered, so an important
  first-seen failure can still surface once a later window has budget again. An
  evicted very old signature may report once more, but the per-window notice
  ceiling still holds.
- **Closing**: a throwing report callback is swallowed (the line already reached
  the bounded native log), `dispose()` is idempotent, and `handle()` after
  `dispose()` is a no-op.

## Wiring notes for the parent

- Create one projection per frontend/App attachment and dispose it on frontend
  teardown/shutdown; do not recreate it per render, key press or model update.
- Hook it to the existing notice plane only (`App.reportNativeDiagnostic`).
  Do not feed `fatal` into `report`: the parent's terminal restore plus native
  fatal stderr is the visible path.
- The projection never touches drafts, the native inbox/queue, durable
  transcript items or the editor instance; only `report` appends one notice.

## Tests

`test/ui-native-diagnostics.test.ts` (synthetic fixtures, no profile, provider,
credential, PTY, network or model call): routine/fatal/malformed silence, one
width-safe notice, repeat dedupe across channels, bounded signature eviction,
per-window ceiling plus limit line, later-window visibility, per-window reset,
backwards/broken injected clock safety, dispose and throwing-callback safety,
and a `TranscriptStore` integration proving durable items, draft and queue are
unchanged apart from the intended notice rendering through `NoticeBlock` at
narrow widths.