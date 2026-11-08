# Terminal native mapping (Rex / Ghostty)

Status: **read-only audit and recommendation.** No backend, app, contract,
manifest or existing doc is changed by this document. The parent owns the
controller/app implementation; the backend remains a transport/mapping adapter,
never a second scheduler or notification service.

Detailed evidence: `.cache/terminal-integration/research-native-lifecycle.md`
and `.cache/terminal-integration/research-native-protocols.md`.

## 1. Boundary

- DSH owns turns, tools, permissions, decisions, titles and durability.
- The frontend owns terminal presentation only: title, program status/progress,
  and one-shot notifications derived from native facts.
- No terminal status may be invented from assistant text, `stream_end`,
  `agent/error` alone, or a timer. Status reporting is not a second agent loop
  and not a second session state machine.
- The persistent session title is always **native DSH title**. Rex adds only
  a static terminal-only `🐳` prefix; star/work glyphs and the title clock seam
  have been removed. Title presentation never settles work, estimates progress
  or depends on work state. Other terminal families keep plain native/fallback
  titles. The editor/agent UI clock and native status reporting are unchanged.

## 2. Exact status source

Use these native facts, in this order:

| fact | durable? | use |
| --- | --- | --- |
| `status` event (`running`/`idle`, exact Agent) | live process state | working/idle baseline |
| `session_event` `turn/start` | durable | turn open/working |
| `session_event` `turn/end` **`data.reason`** | durable | done/error/cancel/idle |
| `decision` / `decision_closed` | live native request | blocked (permission/question) |
| `session_event` `session/title` | durable | title |
| `subagent` / `subagents` (`SubagentStatus`) | mixed: `running` is live; stop reasons are durable | bounded child aggregation only |
| `stream_start/chunk/end` | live, tentative | transcript preview only; never terminal outcome |
| `agent/error` | live, not durable | transcript diagnostic only |

`turn/end` payload is `{ turn, reason }`; **there is no `data.outcome`**.
`outcome` belongs to the live assistant-stream end frame
(`committed`/`abandoned`) and must not be mapped to done/error.

### Reason mapping

| `turn/end.reason.kind` | terminal | notification |
| --- | --- | --- |
| `completed` | `done` | one completion notification |
| `error` | `error` | one failure notification (bounded text) |
| `aborted` | clear/idle | none |
| `blocked` | clear/idle | none — this is an `agent/pre-step` rejection, **not** a permission prompt |
| `interrupted` | clear/idle | none |
| `forked` | clear/idle | none |
| `max-tokens` | clear/idle or `error` with explicit "output limit" text | optional; document the lossy mapping |

### Native command outcome

`command/run` and `command/done` are durable, log-only session events
(`@deepseek-ai/dsh-commands/lib/types/types.d.ts:107-124`):

```ts
'command/run': { commandId, name, args?, source }
'command/done': { commandId, kind: 'success' | 'error', text?, sourceEventSeq? }
```

They pair by `commandId`. Use `command/run` → active command, and
`command/done.kind` for the command's real outcome. `kind: 'success'` is the
only command success; do not infer it from `execute` return text or from a
later assistant message. A command settling does not end a turn: the root
`status` remains authoritative for whether work continues.

`aborted.reason.kind === 'user'` does **not** prove the user pressed Esc: the
backend also uses `cancel({kind:'user'})` for session teardown and
`queue-send-now` (`src/backend/context.ts:1397`, `:3673`, `:2262`). Do not key
notifications or UX on it.

### Ordering / races

- `turn/end` is appended before `agent/status: idle`; keep `working` until the
  durable end or idle, never set idle on the Esc keypress.
- `agent/error` arrives before `turn/end` error; ignore it for terminal outcome.
- A committed `stream_end` means the durable assistant event exists, not that
  the turn completed.
- On `ready` with a changed `sessionId` **or** `attachmentId`: clear the old
  terminal record/notification identity, then report the new idle state.
- On same-attachment `ready` (pending materialization, capability refresh,
  reload): do not clear or re-notify.
- Ignore stale events from another session/attachment. The backend identity
  filters the root stream/status; the app currently filters by `sessionId` only
  because `status`, `stream_*`, `decision`, `decision_closed` and
  `session_event` carry no `attachmentId`.
- A late event after `closed`, fatal error, shutdown or terminal restore must
  not write OSC bytes.

## 3. Terminal writes

Rex supports OSC 7501; Ghostty 1.4.0 parses it. Whether the released Ghostty
GUI also installs the status effect, answers the query and presents records is
**uncertain until a live probe** (release notes say the GUI ignores it, while
the 1.4.0 parser contains the query reply path). Do not assert either outcome
in code or docs; parent tests the actual terminal.
Pi TUI exposes the public seam (`vendor/pi-tui/dist/terminal.d.ts:35-55`):

```ts
terminal.setTitle(nativeTitle)
terminal.setProgramStatus({ state, app: 'dsh-tui', kind?, message? })
terminal.setProgress(active)   // existing OSC 9;4;3 / 9;4;0
```

### Rex

- Use `setProgramStatus` as the primary source: tab indicators and
  background notifications are then Rex's own user settings
  ("Show activity in tabs", "Show system notifications").
- Do not also send OSC 9/777 on Rex; that duplicates Rex's program-status
  notification.
- Include `app: 'dsh-tui'`; include `kind` only with `blocked`.
- `msg` is one line, sanitized and bounded (≤2048 UTF-8 bytes); never include
  assistant stream text or raw provider errors.

### Ghostty 1.4.0 (protocol runtime/presentation unverified)

- Treat 7501 support as **uncertain** until the parent probes the actual GUI:
  if it answers `OSC 7501 ; ? ST`, use `setProgramStatus`; if not, keep the
  existing `setProgress` working indicator and `setTitle`.
- For attention events use at most one OSC 777 notification per transition:
  `ESC ] 777 ; notify ; <title> ; <body> BEL` (Ghostty 1.4 supports
  OSC 9/777 and OSC 9;4). Fall back to OSC 9 only if 777 is unsupported.
- Ghostty resets stale progress after ~15 s; the existing 1 s `setProgress`
  keepalive is sufficient. Never send duplicate status and notification paths
  based on an unverified capability.

### Unknown terminals

Title is always safe. Do not send program status or notifications unless the
terminal confirms OSC 7501 or an explicit opt-in setting enables OSC 9/777.

## 4. Native title

Native sources (do not scrape assistant text):

1. live `session_event` `session/title` (`{title, messageSeqs, source}`), ordered
   by `seq`;
2. `sessionProjections` key `title` (`string | null`) and its `onChanged`;
3. `ctx.sessionTitle.get(session)` for the full snapshot
   (`eventSeq`/`updatedAt`/`source`);
4. `sessionQuery.readTitle(sessionId)` / `readTitleSnapshot(sessionId)` for an
   initial or reload read (live-preferred, durable).

`SessionInfo` has no title, and the bounded snapshot suffix can omit an old
`session/title` event. A title hook must therefore use the projection/query,
not `info.events`.

Title format should mirror DSH's web client
(`dsh-client-ui-layout/lib/client.js:58-71`):

```
<native title> — dsh-tui
fallback: dsh-tui · <cwd basename>
```

Sanitize control characters and bound the length before `setTitle` (OSC 0 uses
BEL and would end early on a stray BEL/ESC).

## 5. Minimal app hooks (parent-owned)

1. **One state projection** in `App`:
   `{ kind: 'idle'|'working'|'blocked'|'done'|'error', kindDetail?, message?,
   key, turn?, decisionId? }`.
   Recompute only from: root status/turn/decisions/ready; never per chunk.
2. **One title slot**: `nativeTitle` updated by `session/title`, title
   projection/query on ready/reload, cleared on session change. `setTitle` only
   when the string changes.
3. **One terminal emitter**: a single `syncTerminalPresentation()` called after
   the existing render/event state settles, which diffs state and calls
   `setProgramStatus` (Rex/7501), `setProgress` (Ghostty), and at most one
   notification per transition. It must be idempotent and safe after restore.
4. **Notification dedupe**: key by
   `{sessionId, attachmentId, turn, reasonKind}` for turn end and
   `{sessionId, attachmentId, decisionId}` for blocked. Never notify for
   stale, same-transition repeats, `stream_end`, `aborted`, or `blocked`
   pre-step reasons.
5. **Child aggregation is separate from root busy**: root `working` MUST stay
the existing native root busy/`isBusy` truth (root status, open turn, active
native command). A native root can legitimately be idle while child workers
continue, so never set root `working` from a child's `running` status.
Optional child records are separate, bounded records. A child may map to
`working` only when that child's own native status is known-live (`running`;
`initializing` only if the native fact proves a live activation), never as a
proxy for the root. Child completion never implies root completion.
6. **Decision message**: `permission`/`question` from the pending root
   `DecisionRequest`; if `origin` is present, prefix the bounded child label.
   `decision_closed` recomputes: still blocked if another decision is pending,
   otherwise working/idle. Never mark done on decision close.

A small optional setting (for example `terminalNotifications: 'auto' | 'off'`)
is a presentation preference, not a DSH policy; default `auto` keeps Rex's
native behavior and enables the Ghostty fallback only when the environment is
recognized.

## 6. Native title seam and remaining gaps

Implemented narrow optional seam (parent-owned contract, backend-read only):

- `SessionInfo.title?: string | null` baseline: `null` = native no-title,
  omitted = projection unavailable. Read through the existing public
  `sessionProjections.stateOf(session,'title')`; no log scrape, query,
  generator, cache or provider call.
- `BackendEvent {type:'title'; sessionId; attachmentId?; value: string|null}`:
  emitted from the same projection's existing `onChanged` feed, guarded by the
  exact live session and carrying the current attachment id. `undefined`
  projection values are ignored; no TUI-owned title is synthesized.

Remaining missing facts (not implemented here):

1. No baseline/event for title when the runtime mounts no title projection;
   the field stays omitted rather than falling back to a TUI-derived title.
2. No `attachmentId` on `status`, `stream_*`, `decision`, `decision_closed`,
   or `session_event`.
3. No turn-outcome event; the app must read `session_event` `turn/end`.
4. No native "blocked on user" agent status; decisions are the only source.
5. No focus/visibility fact in the bridge or Pi TUI; exact "notify only when
   unfocused" is unavailable (Rex handles background-only natively).
6. No terminal notification API in `Terminal`; OSC 9/777 requires `write()`
   or an input-owner seam extension.
7. Cancel cause cannot identify the UI action (see §2).

If a future contract field is needed, prefer an optional `attachmentId` on
session-scoped events over parsing the transcript.

## 7. Acceptance (synthetic, no model/profile)

- `turn/end completed/error/aborted` produce exactly one status transition,
  with `turn/end` observed before idle.
- `stream_end`/chunks never produce done/error or a notification; abandoned
  previews are not success.
- `agent/error` alone does not produce a terminal error.
- Root decisions produce `blocked` with `permission`/`question`; close returns
  to working/idle; child origin keeps the root record with a bounded label.
- Session switch/resume clears the old record; stale frames do not write.
- Native title updates once per higher `session/title` seq; fallback title
  appears before the first native title.
- Rex: 7501 bytes sent only after the query is answered; one working, one
  blocked, one done. Ghostty: probe actual 7501 support; if confirmed use it,
  otherwise one 777 notification per transition with title/progress correct;
  no duplicate notification from repeated renders.
- Terminal restore/exit clears progress/status and never leaves a working
  record.