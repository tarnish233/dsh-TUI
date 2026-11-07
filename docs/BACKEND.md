# DSH integration: in-process native adapter

Verified installation: `@deepseek-ai/dsh@0.2.2-rc.1`, Cordis `~4.1.0`, Node 26/macOS.
The parent plugin runs this adapter inside a DSH native application bundle; the
user's default profile remains `dsh-tui`, owned by the parent's bundle
composition.

## Ownership boundary

Pi TUI supplies terminal rendering/input. DSH owns Agents, model calls, tools,
permissions, commands, sessions and persistence. The adapter
(`src/backend/context.ts`) is a thin same-process seam:

- the host Cordis context is passed in; `createDshBackend(ctx, options)` returns
  the existing `Backend` contract (`src/backend/types.ts`) unchanged;
- no loopback wire, JSON request dispatch, stdin/fd3, spawned second DSH,
  scratch profile mirror, second persistence, scheduler, permission rule or
  model transport exists;
- `close()` releases only adapter-owned listeners, decisions, in-flight
  command/image operations and the Agent handle it created. It never disposes
  the host root, never calls `appExit`, and never exits the process. The parent
  plugin owns application shutdown and `ctx.effect` lifecycle.

Public services used (all through `ctx.get(name)` with capability validation):
`agents`, `commands`, `llm`, `attachments`, `sessionQuery`,
`sessionProjections`, `agentDefaultModel`, `permissionPresets`, `agentPresets`,
`sessions`, `hmr`, `tools`, `loader`, `sessionTitle`. Native pure helpers are
`createUserMessage` and
`BlockAssembler` / `expandAssistantStream` / `assembleAssistantStream` /
surface predicates; `makeTranscriptCodec(llmModule, sessionModule)` is a pure
factory and tests inject fakes. Production may pass `options.native` from the
parent bundle or omit it and let the adapter resolve the installed public
exports by their package names. There is no `packageJsonPath`, global
discovery, private config/env or `loadNativeHelpers` production entry.

## Host composition requirements (parent-owned)

The parent bundle must mount the shared `dsh-base` rows (agent, agent-loop,
commands, tools, llm, attachments, persistence/query, session-projection,
permission presets, approval, user-questions, hmr/config-editor when
profile-launched). For preset parity it must mount
`@deepseek-ai/dsh-agent-preset-registry`. `session-stats` is optional: an absent
service degrades explicitly instead of being faked. The parent adds the
`0.2.2-rc.1` peer dependencies
(`dsh-llm`, `dsh-session`, Cordis, agent services) and produces the publishable
JS build.

### Startup preset mount (`src/plugin/presets.ts`)

The TUI registers DSH's own `standard`/`ptc`/`minimal`/`cordis` declarations
from the packaged `dsh-web-app/presets/*.patch.yml` assets and mounts the
`@deepseek-ai/dsh-agent-preset` plugin class. Both are resolved through the
host installation anchor, never from this package's module URL:

- `profileContext.installAnchor` (the launcher's own package manifest) is the
  primary anchor;
- `pluginPackages.packageOf('@deepseek-ai/dsh-web-app', import.meta.url)` is the
  public fallback for an embedded host without the profile launcher.

A globally installed or linked TUI package sits outside the profile's runtime
resolution scope, so the same bare import from `import.meta.url` fails with
`Cannot find package '@deepseek-ai/dsh-web-app'`. Resolving from the installation
anchor also guarantees the mounted plugin class is DSH's own copy. A missing
anchor or missing exported asset fails loudly; no YAML, tool inventory, fake
preset or web frontend is substituted. `test/backend-presets.test.ts` proves the
contract against a temporary local installation (exported preset assets plus one
fake plugin class), so an accidental peer/root resolution fails the test.

### Compaction reasoning and failure detail

`src/plugin/compaction.ts` is a narrow listener on DSH's public `llm/stream`
waterfall, owned by the frontend plugin fiber. It does not replace the
compaction engine. For `purpose: 'compaction'` only, when no effort is already
present and the request target exactly matches the session's latest durable
`request/header`, it re-enters the public LLM stream with that header's
`reasoningEffort` added. The adapter still runs once. A different configured
summarization target, a missing effort and every non-compaction purpose keep
the native request unchanged; messages, tools, tool history, output budget,
session id and cancellation are preserved. Listener disposal follows the same
HMR lifecycle as the TUI plugin.

For a failed native `/compact`, the adapter correlates the synchronous live
`compaction/end.data.error` by both session id and `sourceCommandId`. It keeps
the native generic result and appends `\\nNative cause: …`, with credential
redaction, ANSI/C0/C1 cleanup, whitespace collapsing and a 400-character cap.
At most 32 causes of 4096 characters are retained, entries are consumed once,
and all are cleared on close. Successes, other commands and results without an
observed cause remain byte-identical; no durable session file is read.

## Interface

```ts
interface DshHostContext {
  get(name: string): unknown
  on(name: string, listener: unknown): unknown
  logger?: { warn?(message: string): void }
}

interface DshContextBackendOptions {
  cwd: string
  resume?: string
  provider?: string
  model?: string
  native?: { createUserMessage(input): unknown; transcriptCodec: TranscriptCodec }
  warn?(message: string): void
}

class DshContextBackend implements Backend
function createDshBackend(ctx: DshHostContext, options): DshContextBackend
```

`transcriptCodec` is available before the first `ready`; a missing native codec
fails `connect()` loudly rather than substituting a mirror.

## Lifecycle and attachments

A plain launch (and `/new`) creates no Agent: `connect` enters a pending session
with adapter-minted `sessionId`/`attachmentId`. The first `send`, image prompt
or command needing live Agent state materializes it through
`ctx.agents.create` with those exact ids and the staged route/preset; a `ready`
event follows. A launch that never sends leaves no durable session.
`connect({resume})` and `/resume` use `ctx.agents.resume` and return the durable
snapshot from `sessionQuery.readSession`; a failed read reports
`snapshotUnavailable` (with a warning) instead of an empty conversation.

An explicit resume of the session this adapter is **already attached to** is a
no-op reattachment: the current attachment is reported (same `attachmentId`,
same durable snapshot) and no native resume is attempted. Installed native
contracts allow no alternative: `AgentRegistry.enter` is the authoritative
collision boundary and rejects a second live entry for one id
(`agent "<id>" is already registered`), and `SessionPersistence.open(id,'write')`
claims single-writer ownership and rejects an existing owner with
`SessionAlreadyOwnedError`. A prepared same-id candidate can therefore never
coexist with the live one, so closing first and resuming after would have no
rollback: one native resume/setup failure would leave the process attached to
nothing. Native `session-controller.resolve()` resolves the same situation the
same way, by returning the live Agent. Consequences, all deliberate: the
attachment epoch, native queues, pending decisions and the owned handle survive
a reattachment; a running turn is not cancelled; the transcript is not rebuilt
from the log. A resume of a *different* id still prepares and commits the
candidate first and retires the previous Agent only afterwards, so its failure
keeps the current attachment (see `test/backend-reattach.test.ts`).

The attachment epoch (`attachmentId`) is process-local and not a second durable
identity. Native `agent/assistant-stream`, `session/event`, `agent/status` and
`agent/error` payloads are forwarded only while their Agent/session object is
the exact one this adapter owns, so a late frame after `/new` or resume cannot
reach the UI. `/new` validates the requested preset first and retires the old
Agent only after the new pending session exists.

`closeAgent` settles decisions, calls native
`agent.cancel({kind:'user'},{keepInbox:true})`, waits boundedly for
`whenIdle`, skips the explicit `sessions.flush` only when the native
turn-boundary projection proves no turn started (an explicit flush would
materialize an empty session), then disposes the owned handle. Errors during
disposal are contained.

## Streaming and durable facts

- `stream_start/chunk/end` mirror native `attemptId`, `revision`, `turn`,
  `step`, chunk `index`/`time` and the committed/abandoned outcome with its
  committed `seq`. `revision` increases on every frame; it is not constant per
  attempt.
- `session_event` preserves the complete JSON event envelope including
  `surfaceOp` and `sourceEventSeqs`; a model-only replacement never overwrites
  the original user output.
- `toolPresentation` is ephemeral: `ctx.tools.get(name, agent)` plus only the
  definition's pure `presentCall`/`presentResult`; no tool is re-executed and
  nothing is written back to DSH's log.
- Snapshots keep the newest suffix within 8000 events and 4 MiB UTF-8; omissions
  are reported as `truncated`/`totalEvents`, durable text is never rewritten.

## Decisions and cancellation

Approval and user-question answerers are registered on the public
`approval/request` and `user-questions/request` waterfalls and answer only their
exact Agent; every other request calls `next()` and keeps DSH's fail-closed
behavior. Human answers are normalized to native outcomes
(`allowed-once`/`rejected`/`cancelled`) and native answer batches. A question
cancel settles the exact native request as `ASK_CANCELLED`; a signal/turn abort
settles it as `ASK_ABORTED`, so Esc and Ctrl+C stay distinguishable. Every path
emits `decision_closed` once before settling.

Foreground interruption is native `Agent.cancel({kind:'user'},{keepInbox:true})`.
It also aborts the exact AbortController of in-flight native commands and
settles pending decisions; queued inbox input survives, no TUI scheduler is
introduced. `state.pending` reports raw inbox lengths, while `state.queued` and
`dequeue` share one predicate (`source.kind === 'user'` and only text/image
blocks), so native context notices are neither counted nor recalled.

## Commands, models, presets, permissions

`command()` keeps the UI-facing names. Session-less commands (`state`,
`commands`, `sessions`, `titles`, `models`, `presets`, `permissions`, `new`,
`resume`, `auto-title`, `dequeue`, `cancel`) never materialize a pending
session. `model`/`preset`/`effort` stage on a pending session; they apply through
DSH's own owners when live:

- live route: `agent.model.select({provider,model,reasoningEffort?})`, the only
  native write; the footer reads `agent.model.current()` plus the creation
  fallback;
- default save: `agentDefaultModel.saveSelection()` followed by a getter match.
  Metadata says `defaultPersistence:'native'` and `defaultsPersisted:false`
  because persistence is owned by the host's mounted ConfigEditor and this
  adapter cannot confirm a profile flush. No scratch/runtime wording is
  hardcoded;
- presets: read-only native roster plus `blank`/`current`; a started session
  returns `locked`; a pending session stages the preset;
- permissions: `permissionPresets.catalog()/current(session)` passthrough;
  switching executes the mounted native `/permission` command, and native
  `/plan` remains independent;
- commands: `ctx.commands.list(agent)` descriptors and
  `ctx.commands.execute(agent, line, [], signal)`; DSH mints
  `command/run`/`command/done` and owns validation/audit;
- model catalog: the mounted native `ctx.llm.listProviders()` /
  `listModels(provider)` / `resolveModelInfo(provider, model)` plus
  `agentDefaultModel.currentSelection()`. `src/backend/model-view.ts` is a
  small pure projection that only renames fields into UI rows
  (`id/provider/model/label/description/reasoning/isDefault`); the `id` is a UI
  correlation key and native provider/model values pass through unchanged.
  Provider failures keep their native message (redacted) and never hide the
  successful rows. There is no external/Pi catalog import, credential policy,
  router or second default policy; `models` is advertised only when
  `listProviders` and `listModels` are really mounted.
- reasoning metadata: DSH 0.2.2 list DTOs may omit `reasoning`. When a model is
  selected, the adapter resolves that **target only** through
  `llm.resolveModelInfo(provider, model)` and carries an existing explicit
  level only if the target still advertises it; otherwise the route omits
  effort and DSH's own adapter default applies (a target default is never
  promoted to an explicit level). The metadata await is followed by a fresh
  pending/live route and attachment-identity check, so a late answer cannot
  overwrite a switch. A missing resolver means no level can be carried; model
  selection itself still works and `efforts` retains its existing capability
  semantics.

## Auto-title

No new title service or persistence rule. The adapter toggles the existing
native Loader entries (`@deepseek-ai/dsh-session-title-*-llm`) through
`entry.update({disabled})`. The `inherit` baseline is the first native state the
adapter observed at runtime (the host composition is original, so there is no
scratch-profile comparison). `enabled:null` restores that baseline; title
generation remains DSH-owned and may issue model requests only when a native
provider is enabled.

## Projections and footer metrics

`sessionProjections.onChanged` is only a hint. `permissions` is forwarded as
the native `{currentValue}`; `todos` is trimmed to `{content,status}`; `plan`
re-reads the full host state and publishes only when the trimmed
`{active,wanted,running}` fact changes, publishing an unengaged init view never.
Footer `usage`/`stats` read the official wire views
(`snapshot(session,keys)` with a `stateOf` fallback), re-read all contributing
keys, and publish only on value change. The occupancy pair is atomic; cache
share and whole-log total use the native token buckets; `sessionStats` fields
are whitelisted non-negative numbers. One attach snapshot per new attachment
replays the current facts.

## Subagents

DSH owns every subagent fact. `src/backend/subagents.ts` is a read-only bridge
over the public projections `subagentCatalog` (parent-owned membership),
`subagent` (child descriptor identity/mode/label), `subagentTiming` and
`tokenUsage`, plus the optional `modelSelection` route fold. It does not create,
resume, prompt, interrupt, drain or persist a child Agent; `subagent-session`
and every tree refresh use `sessionQuery.observeSession`, a live-preferred cold
observation that materializes no Agent. The two control commands below are the
only mutation path, and they call the public `ctx.subagents` primitives
`prompt`/`interrupt` directly: no scheduler, persistence layer or second Agent
is introduced.

Membership is the recursive pre-order walk of reachable parent catalogs. Fork-
inherited catalog facts stay excluded because the native projection already
filters them by `inheritedEventCount`; the bridge additionally keeps only the
root's own-suffix `subagent/catalog` event seq for transcript anchoring
(`catalogSeq`). Each local child's immutable header is checked against the
catalog parent (`parentSession`, and `origin` when present); a conflicting row
is omitted and the snapshot is marked `truncated`. External rows are leaves and
are never observed or traversed. Bounds: 200 entries, depth 8, one 5 s read per
session, bounded header/run/activity caches.

`SessionInfo.subagents` carries the cached snapshot on connect/resume and after
each root switch; the `ready` payload is the first authoritative copy.
`BackendEvent` publishes `{type:'subagents', sessionId, value}` (full snapshot)
when membership, truncation or a structural row field changes, and
`{type:'subagent', sessionId, value}` (upsert) for value-only changes. Both are
rooted at the current top-level `sessionId`; only real changes are emitted, and
nothing is published before `ready`. Entries are re-derived from live native
state on every read/publish, so an activity label or projection frame never
serves a stale row.

Status is mapped honestly. A native `subagent/end` stop reason becomes
`completed|aborted|error|max-tokens|refusal` → `completed|stopped|failed|
max-tokens|refusal`; a continuable child settles to `idle` with the same
`lastStopReason`, a one-shot child may stay `completed`, and an unknown
extensible reason stays `unknown`. A started run reports `running`/`idle` from
the exact live Agent, `initializing` before it resolves, and `unknown` when the
Agent disappeared without an end. Durable-only rows use `subagentTiming`:
`lastTurnCompleted === true` becomes `idle` (continuable) or `completed`; an open
turn without a live child, or a closed non-normal turn whose reason is not in
this projection, stays `unknown` — never a fabricated `stopped`. `runId` is
process-local and absent from cold rows; an end seen before its start or before
the catalog row is retained and applied once, and repeated continuable
activations replace the previous run state. `provider`/`model`/
`reasoningEffort` are the child's native LLM route (live `agent.model.current()`
or durable `modelSelection`), not the `ctx.subagents` backend name; `local`
distinguishes session-backed children from external leaves.

Token totals sum the four disjoint native `tokenUsage` buckets; timing is the
projection's per-child-session totals (`settledMs`, `activeSince`,
`activeThrough`, `lastTurnCompleted`). The bridge fabricates no per-run metric,
per-run token count, tool count or duration, and never forwards a child stream to
the main transcript.

`lastActivity` is one bounded label per child (64 chars, control/ANSI stripped)
derived only from selected native facts: `subagent/start`, live Agent status,
and child `tool/call`, `assistant/message`, `user/message`, `turn/*`,
`compaction/end`, `approval/asked` or an agent error. It is not a transcript and
is absent for cold children.

`command('subagent-session', {sessionId})` validates that the id is a child in
the current root tree (catalog row or native header-lineage proof) and then
returns a `SessionInfo` for that child: the cold-safe durable event log (same
8000-event/4 MiB bound, `truncated`/`totalEvents`, `snapshotUnavailable` on a
failed read), the child's own nested `subagents` snapshot with its direct-child
`catalogSeq` anchored from that log, and the native route. The events are the
unmodified DSH payloads, so the installed `transcriptCodec` assembles them
exactly like a root snapshot. This command never calls `agents.create/resume`;
the root id, a non-child, an out-of-tree id and an external leaf (which has no
local Session) are rejected as `INVALID_ARGUMENT`.

`command('subagent-follow', {sessionId, follow})` proves tree membership and
returns `{sessionId, follow}`. `follow:true` fails closed for a native external
(non-local) leaf with `INVALID_ARGUMENT`, exactly like `subagent-session`: such a
row owns no local Session, so admitting a follow would promise frames that can
never exist. After normal argument/capability validation, `follow:false` releases
process-local follow state without rechecking tree membership or localness.
When membership is already known from the bridge's native catalog, follow does
not observe the child transcript or wait for a pending `subagent-session` read.
An unknown id may still require the existing bounded catalog/header-lineage
refresh to prove membership. A freshly cataloged local child is enterable while
its status is still `initializing`, even with no resident child Agent; neither
follow nor the read creates or resumes one.
Only followed children emit their own
`session_event`, `stream_start/chunk/end` and `status`, always under their own
`sessionId`, so the App can attach a separate store without mixing parent and
child data; root events are unchanged and unfollowed children emit nothing.
Follow state is process-local and clears on root switch and `close()`. Events
after the follow acknowledgement are gap-free; the App still buffers between
that acknowledgement and its snapshot reset.

`command('subagent-interrupt', {sessionId})` proves current-root tree membership
with the same catalog/lineage proof and then calls the core public primitive
`ctx.subagents.interrupt(childSessionId, {kind:'user', parentSessionId})`, where
`parentSessionId` is the child's *exact durable direct parent* from membership —
for a nested child that is its own parent session, never the root. Both one-shot
and continuable children use this path; `interruptByParent` is deliberately not
used because it only addresses continuable children and cannot stop a one-shot
run. The root id, an empty id and an out-of-tree id are rejected as
`INVALID_ARGUMENT` before any native call; external leaves are forwarded with
their catalog parent and the native authority decides. Success returns
`{sessionId, parentSessionId, accepted:true}`: this is cancel-signal admission,
which may be a native no-op (target absent/idle/already complete) and does not
mean the target is quiescent. The adapter never cancels the root, drains or
disposes the child, advances a run state or publishes `stopped`; only the
native `subagent/end`/Agent facts change a row afterwards.

`command('subagent-prompt', {sessionId, delivery?, text?, content?, requestId?})`
requires membership with `mode === 'continuable'` and `local === true`, then
calls `ctx.subagents.prompt({requestId, parentSessionId, childSessionId,
mode:'continuable', delivery, content}, signal)` under the same exact direct
parent address. `delivery` defaults to `queue` (`steer` targets the nearest
step); exactly one of `text`/`content` is required — `text` becomes one text
part, `content` is validated by the same `normalizePromptContent` used by
`sendContent` (native text/image parts, canonical base64, no local attachment
or model-vision rule). An absent `requestId` is one fresh `randomUUID()` per
command invocation and a supplied one is used verbatim and must be non-empty;
the identity is never retried automatically. Success returns the native
`{messageId}` plus `{sessionId, parentSessionId, delivery, requestId}` and
proves inbox acceptance only: later execution is DSH-owned and no optimistic
transcript, status or queue row is written. Root, out-of-tree, one-shot,
external and read-only (lineage-only `unknown` mode) children are rejected as
`INVALID_ARGUMENT` before the native call.

The prompt call owns its `AbortController` until inbox acceptance and is
registered in the existing active-command table, so `close()` (and a root
`cancel()`) abort the carrier signal and surface `ABORTED` instead of leaving a
pending native call; `/reload` still refuses while a command is active. The
adapter never passes an undefined signal. A native refusal is reported as
`RUNTIME_REQUEST_FAILED` with the redacted native diagnostic; a receipt without
a non-empty `messageId` is a failure, never a fabricated success.

Child `approval/request` and `user-questions/request` waterfalls are answered
only for a child proven in the current tree (catalog row, or a bounded native
header lineage chain to the root). The `decision` event stays rooted at the
root `sessionId` and carries `DecisionRequest.origin`
`{rootSessionId, childSessionId, parentSessionId, label?, untracked?}`;
`untracked` marks lineage-proven membership whose catalog row is not loaded yet.
Answers settle the exact adapter request id and keep the native return
semantics; responses are never auto-answered locally. Out-of-tree requests call
`next()` (fail closed), and a root decision payload is unchanged.

Capability detection stays live: `subagents`, `subagent-session` and
`subagent-follow` appear only while `sessionQuery.observeSession` and the
catalog projection are readable; `subagent-interrupt` additionally requires an
exact `ctx.subagents.interrupt` function and `subagent-prompt` an exact
`ctx.subagents.prompt` function, so a partial or older composition never
advertises a mutation it cannot perform. If the native service appears only
after the initial pending/root announcement, `subagent/start`/`subagent/end`
trigger one coalesced refresh: changed control capabilities are re-announced on
the **same session and attachment**, without a durable snapshot, Editor reset or
transcript replay; unchanged capabilities do not re-announce. No new Cordis
`inject` entries are required — `subagents`, `sessionQuery`,
`sessionProjections`, `tools` and `agents.get` are resolved optionally through
`ctx.get`, so a composition without the subagent plugin still loads. Listeners,
timers, run state, cached rows,
follow state and any in-flight prompt carrier are disposed/cleared on `close()`;
`/reload` invalidates the cached tree, re-resolves services after reconciliation
and re-announces the refreshed snapshot so later child changes are published
again. Reads require `sessionQuery.observeSession` (DSH 0.2.2's concrete engine
exposes it); without it the snapshot is omitted rather than faked empty.

## Images

`readImage(ref, signal)` is read-only and session-independent: no Agent is
created, no tool re-runs, no path/URL is derived. It calls
`ctx.attachments.readImage`, verifies the returned identity, MIME and byte
length, and returns verified base64 bytes. There is no IPC frame cap; the image
is bounded only by DSH's own storage/admission limits and the UI's display
budget. Cancellation only aborts that read, never a turn.

`sendContent` text-only delegates to `send`. Content with an image uses exactly
the documented public sequence `attachments.admitPromptContent(content)` →
native `createUserMessage` → the current Agent's `followup/steer`. The TUI is
not a Remote caller: it mounts no SessionController, calls no
`prompt`/`resolveAgent`, and adds no vision/permission gate. DSH owns canonical
base64, media/count/pixel limits, model-vision projection, admission and durable
promotion; refusals happen before materializing a pending session and keep the
draft retryable.

## Diagnostics privacy

Adapter-origin diagnostics (warnings, thrown `BackendError` text, `warn()` logs,
native-failure strings, default-save warnings, title-toggle errors) pass through
`redactDiagnostic()`: `Authorization` values, bearer tokens, `api_key` /
`token` / `secret` / `password` assignments — quoted JSON keys and escaped
quoted values included — and common `sk-…` key shapes become `[redacted]`.
`asBackendError()` never serializes an arbitrary thrown object: only its scalar
`message`/`name`/`detail` fields become (redacted) diagnostics, so enumerable
`stack`, `cause` or credential-shaped properties cannot reach the UI; an object
without a usable message becomes one generic sentence. This is textual
diagnostics hygiene only. Native session events,
tool calls/results, `toolPresentation` and decision payloads are never rewritten,
and image bytes/base64 never enter diagnostics.

## Terminal diagnostic isolation

Native DSH plugins can write diagnostics the Cordis logger never sees: the shared
provider listing cache (`createModelListingCache` in the installed
`dsh-llm-deepseek`) hardcodes `console.error(tag, …)` / `console.warn(tag, …)`, so
a periodic successful catalog refresh lands on fd 2 — the same terminal the
renderer owns — and overwrites the focused editor row while leaving
`ctx.logger.exporter` empty. `src/backend/terminal-output.ts` owns the narrow
application-lifecycle lease for that path; the backend adapter, provider catalogs,
credentials, refresh cadence and the DSH Agent are untouched.

`createTerminalOutputLease({directory, onRecord, onFatal})` opens one private log
and returns `{logPath, terminalWrite, install, restore, flush, close}`. While
`install()` is active it patches the two JavaScript writers
`process.stdout.write` and `process.stderr.write`; nothing is forwarded to the
terminal. The renderer therefore writes through `lease.terminalWrite` (the parent
supplies it to `ProcessTerminal`), so renderer bytes never enter the diagnostic
path and the lease never inspects, special-cases or pattern-matches screen text or
escape prefixes. `Buffer`/`Uint8Array` chunks are reassembled by a per-channel
`StringDecoder` (a UTF-8 sequence split across writes stays intact and a chunk's
encoding argument never reinterprets its bytes); `string` chunks flush held bytes
first; an unknown string encoding is rejected exactly as Node's `write()` does
(`ERR_UNKNOWN_ENCODING`) and is never captured; write callbacks settle once and
captured writes report no backpressure. `terminalWrite` always resolves the real
pre-capture stdout writer (this lease's, an active lease's, or the current one) and
lets terminal errors propagate: a dead terminal must surface, not be masked.

Classification is deliberately text-based and small: the native fail-loud labels
(`<bin>: fatal load failure:` / `<bin>: fatal uncaught exception:`) are `fatal`;
the exact periodic model-listing success line
(`model listing from <url> loaded <n> model(s), skipped <m> row(s)`) is `routine`
(log-only, never a transcript line); every other stderr line is `warning`, so
native errors are never silently swallowed; unknown stdout stays `routine`
log-only unless it plainly reads as a warning/failure (`error`, `failed`,
`exception`, `denied`, `refused`, …), which keeps generic `console.log` chatter
out of the transcript. Lines are stripped of ANSI/CSI/OSC sequences and C0/C1
control characters (tabs become spaces) and passed through `redactDiagnostic()`:
credential values never reach the UI or the log, and a credential line split
across writes is still redacted as one complete line.

A `fatal` line releases the capture first and then invokes `onFatal(text)`
synchronously, **before** anything is forwarded to the original stderr writer.
The hook therefore sees an unpatched terminal and can write terminal-restore
sequences directly. Native fail-loud writes one multiline `util.inspect`
diagnostic, so the rest of that same write (code/cause/context/stack lines) is
recorded as `fatal` continuation records and forwarded, sanitized and in order,
after the hook: nothing of the fatal report is lost, and the native exit policy
stays intact.

Bounds: the log lives in an application-private directory (created `0700`, an
existing directory that is group/other-writable is refused) with mode `0600`; one
generation is capped at 1 MiB, then a single `.1` rotation, then in-place
truncation. An existing log that is a symlink, a non-regular file or not
owner-only is refused rather than chmodded or appended to, and a symlinked or
special rotation target is never replaced. The in-memory queue is bounded (512
lines / 256 KiB, with a drop note) and `flush()`/`close()` wait at most 1 s. A
line longer than 64 KiB is discarded from the point of overflow through its
terminating newline — across later writes, with exactly one marker per complete
line — so the continuation of an over-long line is never mistaken for a fresh
diagnostic and a credential split across those writes cannot be stored as a
tail. A sink failure stops persistence without recursing into another log write
(a sink that writes synchronously is dropped rather than re-captured), emits
exactly one sanitized `warning` record stating that storage failed and that
further diagnostics may not be persisted, and keeps capture safe; a log that
cannot be opened fails the lease before any stream is patched.

Lifecycle: `install()` is idempotent (double install/HMR cannot stack a second
capture) and refuses to install while *any* lease in the process is capturing —
the marker lives on a `Symbol.for` key, so a second module instance (HMR,
duplicated bundle) cannot stack a capture whose writer would hijack the other
lease's patch. `restore()` is synchronous and idempotent, records any partial or
discarded line instead of losing it, releases that process-wide marker only if
it is still ours, and never clobbers a writer another component installed on top.
The application keeps the capture installed while it pauses for an external
editor — child-UI output is *not* claimed captured — and calls `restore()` then
`close()` on final UI detach. `close()` re-refuses `install()`.

Limits, stated in the module: this is JavaScript-write interception, not
descriptor isolation. Writes from a native addon, from a child process that
inherited fd 1/fd 2, or from an independently opened `/dev/tty` bypass the lease;
while it is installed, all same-process JS stdout/stderr text (including
`console.*`) is treated as diagnostics. `test/backend-terminal-output.test.ts`
covers classification, sanitization, split-UTF-8 and split-credential lines,
discard-until-newline for over-long lines, log bounds and rotation, storage
failure reporting, symlink/mode refusals, multiline fatal ordering and its
continuation, cross-lease refusal, encoding rejection, renderer error
propagation, install/restore idempotency, and one child process whose real fd
1/fd 2 are inspected; all fixtures are synthetic and offline.

## Reload

`/reload` is a single-step native operation: the adapter's own idle gate (agent
status, active commands, pending decisions, native inbox except
`user-approval` notices) runs first, then
`hmr.runExclusive(() => hmr.reconcileProfile())`. `reconcileProfile` requires
that exclusive context; there is no nested acquisition, no prepare/commit
reservation and no scratch sync. The result is DSH's own
warnings/pending/restartReason plus refreshed `info`. `close()` never awaits an
in-flight reload, so a recomposition that unloads this plugin cannot deadlock on
its own disposal; an absent HMR service returns `available:false`.

## Removed architecture

Deleted in this pass: `runtime/bridge.mjs`, `runtime/bridge.d.mts`,
`src/backend/client.ts`, `discover.ts`, `protocol.ts`, `runtime-home.ts`,
`native-profile.ts`, and the wire/discovery/mirror-specific backend tests. The
semantic coverage (native streaming, images, decisions, queue, models,
permissions, commands, resume, lazy creation, metrics, titles) was migrated to
`test/backend-context.test.ts`, `test/backend-context-native.test.ts`,
`test/backend-native-codec.test.ts` and `test/backend-privacy.test.ts`, which run
against an offline fake Cordis host (`src/backend/testing.ts`). No tests read a real profile, credential,
session log or provider.

## Known limits

- The TUI is not a Remote caller: image prompts always use public attachment
  admission + native message/inbox delivery. No SessionController is mounted,
  called or required.
- ConfigEditor flush is not provable from the public default-model service;
  `defaultsPersisted` therefore stays `false` with `defaultPersistence:'native'`.
- Model rows are a presentation projection of the mounted native LLM registry;
  the adapter owns no provider catalog, credential validity, routing or default
  policy. Native service failures remain visible and redacted.
- The parent bundle owns `dsh-tui` profile assembly, `session-stats`, JS build
  output and `package.json` peer dependencies. The startup preset mount reads
  the official preset assets/plugin from the host installation; it adds no web
  frontend, copied preset or second preset implementation.
- Parent-owned files still referencing the deleted modules must be migrated by
  their owners (see the delegation report); this adapter does not edit them.
