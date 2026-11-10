# Native history, live workspace changes and approval previews

Verified installation: `@deepseek-ai/dsh@0.2.2-rc.1` (public `.d.ts` and shipped
implementation under the installed `@deepseek-ai/*` tree, read-only). This
document describes three same-process adapter reads added to
`src/backend/context.ts` and their pure validators. Nothing here starts a
process, owns a store/fold/timer, reads a file, runs git, watches the tree or
creates an Agent.

## Ownership boundary

| fact | owner | adapter role |
| --- | --- | --- |
| whole-log turn outline (`turnOutline`) | `@deepseek-ai/dsh-session-turn-outline` registered on `ctx.sessionProjections` | one `snapshot(session,['turnOutline'])` cut, validated |
| full event + raw-log context window | `ctx.sessionQuery.readEvent` (persistence/live corpus) | request validation, bounded wait, response validation, wire mapping |
| per-turn changed files | `@deepseek-ai/dsh-workspace-changes` recorder and `ctx.workspaceChanges.summary` | live-event lookup, field whitelist |
| per-file turn-start/end comparison | `ctx.workspaceChanges.diff` (git snapshots + whole-file captures) | exact-args read under owned signal, union validation |
| pending tool-call render intent | each tool's pure `ToolDefinition.presentCall(args)` | cached from the assistant proposal, attached to the approval decision |

The adapter never calls `sessionProjections.stateOf` (the deprecated raw fold
read), never re-folds a log, never derives a preview/diff/path and never
materializes a pending Agent for these read-only faces.

## History reads

`command('history-turns', {sessionId?, attachmentId?})` →
`HistoryTurnsResult`:

- live: `ctx.sessionProjections.snapshot(exactSession, ['turnOutline'])`.
  `values.turnOutline` must be an array of
  `{turn, seq, prompt, response}` with non-negative safe-integer `turn`/`seq`,
  strictly increasing on both, and string previews. `asOfSeq` is the native
  projection cursor (`-1` for the empty log). Native extra fields are dropped.
- absent/unreadable/malformed: `available:false, entries:[]` (never an
  authoritative empty outline). A genuinely empty native outline is
  `available:true, entries:[]`.
- pending attachment: `available:false` for its minted id; no Agent creation.
- a supplied `sessionId`/`attachmentId` must equal the current attachment,
  otherwise `STALE_SESSION`.

`command('history-window', {sessionId?, attachmentId?, seq, before?, after?})` →
`HistoryWindowResult`:

- request: `seq` must be a native seq; `before`/`after` integers in `0..50`
  (omitted = `0`, the native default) validated before the call. 50 is the
  adapter's own safety cap, not a claim about the mounted runtime.
- call: `ctx.sessionQuery.readEvent({sessionId, seq, before, after}, signal)`
  inside the existing 5 s `durableRead` carrier (owned signal, aborted by
  `close()` and attachment retirement; a late value is never published).
- smaller native `readWindowMax`: the effective bound is profile
  configuration, not a readable service fact —
  `@deepseek-ai/dsh-session-query` exports only the `Config` input and keeps
  the resolved bound private (the SQLite backend's `config` field is an
  implementation detail, not a documented read API), so nothing is read off
  the service. Instead one rejection carrying exactly
  `SESSION_QUERY_INVALID_WINDOW` **and** the exact bounded message
  `<before|after> must be an integer between 0 and N` proves `N`, and both
  sides are clamped to `N` in **one** retry inside the same `durableRead`
  signal/deadline. The proven bound is cached per mounted service object +
  `readEvent` identity (a replaced service or hot-patched method starts over)
  and narrows later requests before dispatch; a narrower caller request is
  never widened to it. A generic, malformed, paraphrased, non-narrowing or
  above-cap bound, or a close/switch/abort that already happened, fails closed
  with the original rejection and no second native call.
- response validation: non-negative `inheritedEventCount`; native
  `startSeq`/`endSeq`; `startSeq <= endSeq`; target inside the window; the
  window stays inside the bounds that were **actually dispatched**
  (`startSeq >= seq - before`, `endSeq <= seq + after`); `events`
  count equals `endSeq - startSeq + 1`; contiguous native seqs from `startSeq`.
  Any mismatch rejects `RUNTIME_REQUEST_FAILED`; no empty corpus is returned.
- mapping: each raw event goes through the same `sessionEventWire` used for
  live/snapshot facts, preserving `surfaceOp`, `sourceEventSeqs`, `time` and
  the ephemeral `toolPresentation`; `inheritedEventCount` is forwarded as the
  native fact.
- `hasOlder = startSeq > 0` (the only proof one window gives). The DTO has no
  `hasNewer` field and the adapter never claims it.
- pending attachment: `NOT_CONNECTED`, no Agent creation.
- native rejection: uncoded values become one coded, redacted
  `RUNTIME_REQUEST_FAILED`; `CLOSED`/`ABORTED`/`STALE_SESSION` keep their code.

## Live workspace changes

`workspace/changes` is a log-only event `{turn}`; the summary lives on the Host
for the live Session. DSH's own contract says the latest event for one turn
replaces earlier ones, and a turn really is recorded more than once: the
recorder's `stopping()` records inside the turn, and `end()` records the same
turn again when a later tool result advanced its last tool-result seq. The
latest record is therefore the current summary for that turn, and earlier
records of the same turn are not an additional summary. The official recorder
appends that event **before** it inserts the corresponding in-memory record. The
adapter therefore holds this synchronous append window for one microtask, then
calls `ctx.workspaceChanges.summary(exactLiveSessionId, exactRawEventSeq)` and,
when the native value validates, attaches
`SessionEvent.workspaceChanges = {turn, files[], total, added, deleted}`.
Events emitted in that short window retain native order; close invalidates the
pending projection, and a session switch can never trap the new `ready`.
Each file is `{path, display, added, deleted, binary?, oversized?}`.

- `cwd` and the git `snapshot` ids are never copied.
- `binary`/`oversized` are forwarded only as literal `true`.
- every count must be a non-negative safe integer (`total >= files.length`).
- a missing/turn-less/malformed summary or a throwing lookup leaves the field
  absent; it is never `files: []` and never breaks the event.
- only live events are looked up. A resumed durable snapshot (`readSession`)
  is mapped without summaries, because the recorder's summaries do not survive
  a Host restart and the adapter must not fabricate a card.

`command('workspace-change-diff', {sessionId?, attachmentId?, seq, index})` →
`WorkspaceChangeDiffResult`:

- validates the exact live session/attachment, a native event `seq` and a
  non-negative safe integer `index`, then calls
  `ctx.workspaceChanges.diff(sessionId, seq, index, signal)` under the existing
  8 s `nativeUiRead` owned signal/identity guard.
- `text` requires `path`, `display`, booleans `before`/`after`/`coarse`, and
  hunks with `oldStart/oldLines/newStart/newLines` non-negative safe integers
  plus a string-only `lines` array. `binary`/`oversized` require
  `path`/`display`. Unknown kinds or malformed fields reject
  `RUNTIME_REQUEST_FAILED`.
- native `undefined` is "no comparison": the DTO omits `diff`.
- pending attachment: `NOT_CONNECTED`, no Agent creation.

Pure validators: `src/backend/native-history.ts`,
`src/backend/native-workspace.ts`, shared `src/backend/native-seq.ts`.

## Approval proposal preview

Approval (`user-approval` `approval/request`) is raised from the native
`tools/pre-execute` gate inside `pipeline.prepare`. The shipped scheduler appends
the durable `tool/call` **before** that gate (`dsh-tools`
`BatchSettlement.start` → `pipeline.prepare`), so the durable call already
exists when the human is asked — but nothing has been executed yet, and the
approval decision can reach this adapter before it has mapped the `tool/call`
event. The proposal is therefore still the assistant message's
`message.content[]` block `{type:'tool-call', id, name, arguments}`, and a
durable call is never treated as evidence of execution.

- On a live assistant message the adapter parses each block's raw JSON
  `arguments`, resolves only `ctx.tools.get(name, exactAgent)` and caches
  `presentCall(args)` (JSON-safe) in the same bounded `ToolPresenter.calls` map
  that serves `tool/call`/`tool/result` (`MAX_CACHED_TOOL_CALLS = 2048`,
  oldest-first eviction). No tool executes and no `presentResult` runs.
- `askApproval` copies `request.callId` and, when the exact owning Agent's
  presenter has a cached view, validates the `generic`/`terminal`/`diff` tagged
  view and emits `toolPresentation: {call}`.
- missing `callId`, missing/evicted proposal, unparsable arguments, a throwing
  lookup/presenter or a malformed view all yield a normal approval with no
  fabricated preview; presenter diagnostics are swallowed, so no secret or
  stack reaches the decision.
- the assistant event itself carries no event-level `toolPresentation` because
  one message may propose several calls.

Pure validator: `src/backend/native-presentation.ts`.

## Tests

- `test/backend-native-history.test.ts` — snapshot/window exact args and
  signal, `stateOf` trap, strict outline validation, unavailable-vs-empty,
  window bounds/contiguity/target/count validation, `hasOlder` proof, pending
  no-Agent creation, close/switch abort, coded/redacted failures, and the R7
  negotiation set: proven smaller bound (50 → 20) negotiated once and reused,
  `0`/`1` boundaries, generic/malformed/non-matching/widening failures never
  retried, one shared 5 s deadline and one durable carrier across the retry,
  close/switch before the retry, service/method replacement invalidation, and
  responses outside the actually dispatched bounds.
- `test/backend-native-workspace.test.ts` — live summary args and whitelist
  (no `cwd`/`snapshot`), the official append-before-record timing, ordered
  release and close/switch guards, malformed/turn-less omission, live-only and
  resumed-snapshot omission, capability advertisement, diff args/owned signal,
  text/binary/oversized/absent/malformed outcomes, seq/index/identity guards,
  close/switch abort, redaction, no fs/subprocess access.
- `test/backend-approval-presentation.test.ts` — proposal caching provenance
  (`tools.get(name, agent)` + `presentCall` only), multi-call messages,
  malformed/JSON-unsafe views, unparsable args, throwing lookups, bounded
  cache eviction, `callId`/`toolPresentation` fallbacks, no execute/
  `presentResult`/file read/Agent creation.

All backend unit tests are offline fakes; no provider, profile, credential,
session log, file read, git command or terminal writer is used.
`test/acceptance-native-history-workspace.test.ts` separately composes the
real official plugins in an owned temporary HOME/workspace (inline and
fullscreen). Its hermetic stream follows the native read-only sandbox
escalation protocol: the approval shows the real `presentCall` proposal, the
chosen native option permits one write, and the test then verifies the owned
file, live summary/diff, two native history pages and `/history`. It never
calls a real Provider or touches a user profile/session.