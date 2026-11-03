# DSH integration: native services plus a narrow TUI bridge

Verified installation: `@deepseek-ai/dsh@0.2.1-rc.5`, Node 26/macOS.
The version gate accepts that concrete release, not every `0.2.x` release;
`DSH_PI_TUI_ALLOW_UNSUPPORTED=1` is an explicit experimental escape hatch.

## Ownership boundary

Pi TUI supplies terminal rendering/input. It does not supply this application's
AgentSession, models, tools, commands, permissions or conversation persistence.
DSH remains the authority for all of those. The adapter is limited to process
isolation, transport, display projection, request correlation and human answers.

- `runtime/bridge.mjs`: native DSH services/events inside the actual launcher.
- `src/backend/client.ts`, `protocol.ts`: isolated process and versioned wire.
- `src/backend/native-codec.ts`: pure DSH helpers plus the installed public
  profile/composition API, resolved from the selected installation's exports;
  never a copied assembler/stream decoder or YAML merger.
- `src/backend/native-profile.ts`: native profile selection and the documented
  frontend-replacement policy (recognized `PROFILE_TEMPLATES` surfaces and the
  supported legacy TUI); ordinary plugin utility binaries are preserved, and
  configuration rows stay authoritative.
- `runtime-home.ts`: scratch home, read-only profile mirror and the bridge
  `--patch` overlay; the selected durable data home is only inherited.

The external SDK in this release does not expose raw `agent/assistant-stream`
or per-session cancellation. ACP deliberately forwards committed semantic
updates. These gaps justify a narrow wire to existing in-process APIs, not
another Harness or synthetic streaming from completed messages.

## Launch and configuration

Discovery validates the installed manifest and uses its public `bin` field.
Helpers are resolved with Node's package resolver seeded at that manifest;
`lib/` layouts are not assumed. The real DSH launcher is spawned as
`dsh --profile <name> --patch <bridge-overlay>` and owns `.env` layering,
runtime/package resolution, bundle composition, the telemetry switch and
failure reporting. Diagnostics use pipes, never the visible terminal.

Profile selection (`DshOptions.profile` / `--profile <name>`):

- without a selection, DSH's `DEFAULT_PROFILE_BUNDLES` initialize this
  application's profile (`initProfile`) in scratch — the same base composition
  `dsh plugin --profile <new>` would create;
- with a selection, native `resolveProfileDir`/`readProfileManifest` resolve the
  real profile, and its configuration is reused: its `cordis.patch.yml` is
  copied into the scratch profile and patch-relative assets are materialized
  there (Node resolves symlinks to their real path, which would otherwise
  anchor modules in the user's home); profile dependencies, `node_modules`
  and `compatibility.json` remain readable through the mirror;
- the profile's declared bundle list is filtered only for recognized
  application surfaces the TUI must not start a second time: bundles named by
  native `PROFILE_TEMPLATES` and the supported legacy TUI bundle. Ordinary
  plugins that merely ship a utility `bin` are kept, because that heuristic
  would drop valid bundles. Every replacement produces a startup warning; the
  profile's own configuration rows stay in force (frontend-owned rows become
  native "patch target not found" diagnostics). A patch or home patch that
  *inserts* a recognized application frontend is disabled by exact row id in
  the private highest-priority overlay, leaving the user patch untouched; if
  that inserted row has no stable id, the profile fails rather than starting a
  second terminal. A missing/invalid profile or one without the shared core
  bundle fails with `INVALID_OPTIONS` / `PROFILE_UNSUPPORTED`.

The selected data home is resolved with native `resolveDshHome`; existing
home-level config/auth, sessions and durable data are inherited through links.
The profile's `cordis.yml` and regenerated manifest are written only into the
scratch directory, so user profiles, patches and credentials are never edited.
Legacy `settings.yaml` is copied (not linked) because the native settings
import archives it. The bridge overlay mounts the agent-preset roster, disables
HMR/model-backed title generation, and disables the host-plane tool rows that a
per-Agent preset now owns; the native deterministic title service remains
available.

The TUI never imports Pi catalogs/auth: there is no `modelsFile` option,
`--models-file` fails with native-configuration guidance, and the removed
environment pointers are not read (an upgrading user gets one warning). A
`DshOptions.profile` warning can name replaced frontends; model routes come
only from DSH's mounted catalog (`ctx.llm.listProviders/listModels`,
`resolveModelInfo`, native `agent-default-model`). See [PROVIDERS.md](PROVIDERS.md).

## Wire and lifecycle

- Parent requests: NDJSON on stdin, `{t:'req',id,method,params}`.
- Runtime events/responses: NDJSON on fd 3.
- stdout/stderr: bounded, redacted diagnostics; optional debug log is private.
- Hello carries `protocolVersion: 2`; incompatible/missing versions fail the
  handshake rather than being assumed compatible.
- `SessionInfo.attachmentId` is an ephemeral Agent-attachment epoch. It is not
  another durable session id and is not stored in DSH. Reattaching the same
  session produces a new epoch so the UI clears stale tentative streams even
  though the native frame revision counter restarts at 1.

Creation/resume uses `ctx.agents.create/resume` and their public setup hook.
Sending uses native `createUserMessage`, then `Agent.followup/steer`; its
promise means inbox acceptance, not model success. Optional session/attachment
correlation prevents a delayed send/recall from applying to a different Agent.
Native Agent object identity filters root streams; child streams are not mixed.

Close cancels pending decisions and native operations, drains the Agent,
flushes through `ctx.sessions`, and disposes the native handle. The bridge
releases its input channel and requests native `appExit`. It does not install
another `uncaughtException`/`unhandledRejection` policy or force an early exit
on top of the launcher's fail-loud/disposal behavior. The client retains bounded
transport shutdown/escalation for an unresponsive child.

## Events, original history and pure codecs

`agent/assistant-stream` produces start/chunk/end frames. `attemptId` identifies
an attempt; `revision` increases on EVERY frame inside an attachment, and
`index` is the attempt's dense chunk position. Durable settlement precedes the
committed end naming its exact `seq`. These native semantics are not changed.

`session/event` and query snapshots preserve the complete JSON event envelope,
including `surfaceOp` and `sourceEventSeqs`. The original append-origin message
is human transcript material. A model-only replacement (e.g. result pruning)
may change model context but must never overwrite the user's original output.
Non-surface tool-call, attempt, command and lifecycle records remain available.

Before ready, `DshBackend.transcriptCodec` supplies public native:

- `BlockAssembler` for incremental chunks and interrupted safe prefixes;
- `expandAssistantStream` for validating durable packed records;
- `assembleAssistantStream` for canonical assembly;
- `isAppendSurfaceEvent` / `isReplacementSurfaceEvent` for placement semantics.

The UI installs this codec before resetting history. Missing native helpers
fail startup; the explicit offline Demo codec is never a production fallback.
Attempt identity, render state and live/durable deduplication remain in the UI.
Active text uses the same layout as settled replies with no attempt/debug header;
only incomplete or unconfirmed responses get an explicit warning.

Snapshots use `sessionQuery.readSession`, not deprecated `snapshotEvents`.
The newest fitting suffix is limited to 8000 events and 4 MiB measured in UTF-8
bytes. Omitted history is marked `truncated/totalEvents`; durable content is
not cut or rewritten to fit the wire. Full DSH history remains authoritative.

## Native commands and controls

| Control | Native authority / response |
| --- | --- |
| `commands` | `ctx.commands.list(agent)` descriptors for help/autocomplete |
| `execute {line}` | `ctx.commands.execute(agent,line,[],signal)` -> native `{commandId,result}` |
| `compact` | Compatibility alias to native `/compact`, including its argument checks; no local compaction implementation |
| `model` | Native catalog/model validation and public `installModelSelection` slot; effort is preserved when the target supports it, otherwise the target default applies |
| `presets` | Read-only native `agentPresets.list()` roster plus current/default/blank state |
| `preset` | Native `agentPresets.select` on a blank session; a started session returns `locked` and keeps its composition |
| `efforts` | Native `llm.resolveModelInfo(provider, model).reasoning` levels, default and effective effort |
| `effort {id}` | Apply an adapter-owned effort to the current `ModelSelection`; `null`/`default` clears the explicit level |
| `permissions` | Read-only native `permissionPresets.catalog/current`; native option DTOs are preserved |
| `new/resume` | Native Agent registry and durable query snapshot, followed by ready |
| `sessions` | Native session query and title observations; `createdAt`, not invented activity time |
| `state` | Native session, model selection, status, inbox counts and token meter |
| `dequeue` | Native Inbox.remove for recalled human text; no scheduler, no deletion of injected context or attachments |
| `reload` | Backend syncs real profile/home config into scratch, then `ctx.hmr.runExclusive(reconcileProfile)`; returns warnings/pending/restartReason plus refreshed session info |

Native execution owns `command/run`, `command/done`, pairing IDs, parameter
validation, error classification and compaction source-event links. UI commands
(help/preferences/pickers) are handled locally; other business command
lines are forwarded without collapsing whitespace or multiline arguments.

There is no local `/mode` command or mode setter. `/permission` and the
Shift+Tab shortcut both execute the mounted native command, retaining command
audit and the approval service's Agent-aware setter. `SessionInfo.permissions`
and `permissions` events carry the native `{currentValue}` selection; updates
come directly from `sessionProjections.onChanged`, not a second permission fold.
Native `/plan` is independent: the tested base composition mounts
`dsh-plan-mode`, whose command/guidance/review semantics remain in DSH.

Keyboard configuration lives in `/settings` → Keyboard shortcuts, not a
standalone `/hotkeys` command. The grouped list/inline field and atomic binding
overrides are UI-only and never invoke DSH business commands or change the
main draft. Existing keymap validation/diagnostics are reused, without a second
key dispatch engine or configuration hierarchy. `/reload` re-reads the TUI
settings/binding files, syncs the selected real profile/home patch into the
private scratch tree, then asks native HMR to reconcile. It keeps the Agent,
transcript, draft and caches; a running turn, native command, or pending
decision refuses the operation. Bundle/package moves, credential-file changes
and TUI source changes still require a restart.

The client uses advertised capabilities instead of a second command-name
whitelist. Execution has a 200s caller deadline, catalogs 180s, ordinary requests
30s (test overrides exist). A timed-out execution sends `abort {id}` to cancel
the exact native command signal. `cancel` also aborts current-session native
commands and delegates Agent interruption. A timeout is not presented as proof
that an operation rolled back; native command audit/outcomes remain authoritative.

## Tool cards and human decisions

The bridge uses `tools.get(name,agent)` and pure `presentCall/presentResult`.
It adds ephemeral `{call?,result?}` `toolPresentation` to wire events, never to
DSH's log. Replay uses logged arguments/content/meta; it never re-executes tools
or reads files to guess a diff. The UI renders card intent, with generic fallback,
CC layout, width-safe coloring and real native read line numbers. A model
proposal is not execution, and absence of a result is not success/failure.

Approval and question answerers use the public waterfalls. DSH performs policy
and audit; the bridge only forwards human choices. Native question IDs/intent
survive projection; unknown intent can use the generic dialog. The App keeps
multiple requests in a FIFO and closes by exact ID; a late acknowledgement
cannot dismiss a newer dialog. Child decisions fall through to DSH fail-closed.

## Known limits and acceptance

- Single-root home isolation still needs link glue in this DSH release. Settings
  written to the private profile are not a permanent user-profile editor.
- Frontend replacement covers recognized DSH shipped application bundles and
  the supported legacy TUI. A profile whose patch inserts one of those
  frontends is refused instead of starting a second stdio consumer; ordinary
  plugin utility binaries are not treated as applications.
- A selected profile's non-application bundles are mounted; bundle-owned
  frontend rows from replaced bundles have no target and are reported by the
  native launcher, not silently rewritten.
- Configured gateway headers are native `llm-pi-ai` provider fields; the TUI
  owns no request-header shim, credential migration, or provider catalog.
- Queue recall is a text-only UI convenience, not a full edit/steer queue UI.
- Child panels, timed-question follow-up UI, images, fork/rewind and full native
  configuration UI are not implemented. Thinking display and reasoning effort
  are separate: the display toggle is UI-only; `/effort` owns the model level.
- Preset choices are not persisted as a TUI preference. A started Session keeps
  its composition; the staged preset applies to the next `/new` in this process.
- Native lifecycle/command/pruning/presenter regressions, strong pre-finish
  loopback SSE paint checks, CLI PTY and representative real providers are tested.
  See [ACCEPTANCE.md](ACCEPTANCE.md) for the current results and exclusions.
