# Native inspection adapter

Scope: `src/backend/native-inspection.ts` only. DSH owns every fact this module
reads — background jobs, goals, the effective working directory, the Loader /
agent-preset plugin inventory and the active Agent's tool definitions. The
adapter is a **read-only projection with validation**, not a second Harness: no
job supervisor, no kill policy, no goal lifecycle verbs, no directory mutation,
no plugin configuration writer, no tool execution/resolution, no polling, no
cache and no Agent/Session materialization. Iteration 1 of the native UI
expansion; experimental/Web-only surfaces stay inactive.

The module is constructed with the parent-owned `NativeUiAccess` seam
(`src/backend/native-ui-scope.ts`): exact supplied host, `service(name)`,
`current()`, `isCurrent(scope)` and optional `warn`. The seam file is not
modified here.

## 1. Native public API used

| Domain | Public native surface | Adapter behavior |
| --- | --- | --- |
| Jobs roster | `ctx.jobs.list(caller?: SessionId): JobView[]` | called with the current `sessionId`; native returns own + unowned jobs in registration order |
| One job | `ctx.jobs.get(id, caller?)` | identity/lifecycle projection only |
| Output | `ctx.jobs.readAt(id, from, caller?)` | non-consuming absolute-offset read; `ctx.jobs.read` is **not** used because it advances the model's completion cursor |
| Job events | `ctx.jobs.events.subscribe({ owner: sessionId }, listener)` | mapped to neutral invalidations, filtered again by owner and attachment |
| Goal | `ctx.goals.get(agent): GoalView \| undefined` | only with the exact live Agent in the current scope; `GoalError('GOAL_AGENT_NOT_LIVE')` falls back instead of failing |
| Goal durable | `ctx.sessionProjections.snapshot(session, ['goal']).values.goal: GoalProjection \| null` | no live Agent needed; activation stays unknown (`complete:false`) |
| Working directory | `ctx.workingDirectory.get(session): string` | synchronous committed read; `set`/`ensure` are never called |
| Directory durable | `ctx.sessionProjections.snapshot(session, ['workingDirectory']).values.workingDirectory: string \| null` | `recordedCwd`: `null` = no recorded change |
| Plugin inventory | injected `readPluginInventory(ctx)` from `@deepseek-ai/dsh-host-plugin-inventory` | optional helper; absent means the capability stays unavailable |
| Tools | `ctx.tools.definitions(agent): readonly ToolDefinition[]` and `ctx.tools.executable(name, agent)` | exact active Agent scope only; `resolve`/`schemas`/`execute`/`register`/`restrict`/`guard` are never called |

Packages are not added as dependencies; the helper is injected by the parent
with a computed specifier, as the backend already resolves other native peer
packages.

## 2. Exported API

```ts
new NativeInspection({
  access,                       // NativeUiAccess (required)
  readPluginInventory?,         // (host: unknown) => Promise<unknown>
  maxOutputBytes?,              // default 65536
  maxTextChars?,                // default 512
  maxDiagnostics?,              // default 20
  warn?,                        // adapter diagnostics; falls back to access.warn
})

jobs(): Promise<JobsRead>
jobOutput(jobId, from?): Promise<JobOutputRead>
goal(): Promise<GoalRead>
workingDirectory(): Promise<WorkingDirectoryRead>
pluginInventory(): Promise<PluginInventoryRead>
toolCatalog(): Promise<ToolCatalogRead>
subscribeJobs(listener): () => void
```

Pure mappings for the parent's bindings:

- `jobEventInvalidation(event, sessionId)` — one `jobs.events` event
- `goalChangedInvalidation(payload, access.current())` — one `goal/changed` payload
- `projectionInvalidationDomain(key)` — `'goal' | 'working-directory' | undefined`
- `toolsInvalidationDomain()` → `'tools'`
- `inventoryInvalidationDomain()` → `'inventory'`

Every read returns either an `available: true` immutable snapshot or
`{ available: false, reason }` with one of `no-attachment`, `stale-attachment`,
`missing-service`, `native-failed`, `malformed`, `no-session`, `no-agent`,
`invalid-request`. A failed read is never converted into an empty authoritative
list. `complete:false` marks native data that was partially readable (dropped
malformed rows, unknown activation, an unreadable effective directory, a
truncated diagnostic set).

## 3. Invalidation signals (parent binds; no poller)

| Neutral domain | Public signal |
| --- | --- |
| `jobs` | `ctx.jobs.events.subscribe({ owner: sessionId }, listener)` |
| `goal` | `ctx.on('goal/changed', ({ agent, change }) => …)`; `ctx.on('goal/activation-changed', …)`; `sessionProjections.onChanged` key `goal` |
| `working-directory` | `sessionProjections.onChanged` key `workingDirectory` (folds durable `working-directory/change`) |
| `tools` | `ctx.on('tools/change')` (unfiltered registry emit) |
| `inventory` | `ctx.on('app-boot/config-reload')`, `loader/entry-init`, `loader/config-update`, `plugin-manager/changed` when mounted |

Cordis `internal/*` events, `hmr/change`, the Web `pluginInventory` Remote and
any TUI-side poller are deliberately not used. `agentPresets.register/unregister`
outside a profile reload has no public catalog event upstream; the inventory
refreshes on the next explicit read after the listed signals.

Each binding must capture the current attachment when armed and re-check
`access.isCurrent(captured)` plus the captured `attachmentId` before publishing
`native_ui_changed`. `subscribeJobs` already does this for the jobs stream and
stops delivering after an attachment switch.

## 4. Identity, staleness and Agent materialization

- Every read captures `access.current()` **before** the native call and verifies
  the same scope is still current **after** it resolves (including the exact
  `attachmentId`). Stale results are dropped as `stale-attachment`; a hostile
  `isCurrent` that returns `true` for a replaced attachment is not trusted.
- Pending identity (`current()` with `sessionId` but no `session`/`agent`) is a
  valid scope: jobs and plugin inventory can be read; goal and working directory
  report `no-session`; the tool catalog reports `no-agent`. No read creates an
  Agent or Session, and no read calls `ctx.agents.get/create/resume`.
- Goal uses `goals.get` only when the current scope holds the live Agent; a
  `GOAL_AGENT_NOT_LIVE` edge falls back to the durable projection silently, and
  other failures are warned (redacted) and may still fall back.

## 5. Bounds, terminal safety and privacy

- Job output is read from `output.earliest` by default, in native chunk order,
  and bounded by `maxOutputBytes` UTF-8 bytes. Chunks are never split in a way
  that would duplicate text: when chunks are omitted, `next` is the `at` offset
  of the first omitted chunk; when a single chunk exceeds the budget, a head
  bounded by whole code points ships and `next` stays the native offset with
  `truncated:true`.
- Output, labels, progress, detail, descriptions and diagnostics are sanitized:
  OSC/CSI sequences are removed, `\r\n?` is normalized to `\n`, and remaining C0
  / DEL / C1 control characters are dropped. Text is truncated without splitting
  a surrogate pair.
- Job status lines and output are the user's own command output; they are **not**
  credential-redacted (matching a terminal view). Adapter diagnostics
  (`warn`), plugin inventory diagnostics and the summary's derived diagnostics
  **are** passed through `redactDiagnostic` and bounded.
- Never exposed: job `owner` id (only an `owned` boolean), `outputLimitBytes`,
  `output.spillPaths` (host paths), Loader entry `meta`, preset row `condition`,
  plugin `managementAvailable`, tool `parameters`, `output.schema`/`render`,
  `execute`, presenter payloads, and every plugin configuration value.

## 6. Not implemented on purpose

- Job kill/wait/remove/start, job supervisors, roster frame coalescing and any
  business timer. The adapter is read-only for this iteration.
- Goal create/edit/pause/resume/complete/block/clear, `/mode`, or a second loop;
  `/goal` stays native passthrough.
- `workingDirectory.set`/`ensure`, directory validation, automatic cwd changes
  or OSC7 rewrites.
- Plugin enable/disable/install/update, profile or settings mutation, and any
  direct Loader/Cordis private walk — inventory comes from the public helper.
- Tool resolution, admission, execution, schemas, or a tool catalog copy.
- Web/experimental packages and remote model calls.

## 7. Tests

`test/backend-native-inspection.test.ts` (22 offline tests) uses synthetic
Cordis-shaped doubles of the public signatures only:

- native order for job rows, output chunks and tool definitions; unowned job
  rows; host spur paths and `owner` omitted from DTOs
- foreign-owner and malformed rows dropped with `complete:false`
- missing service, failing service, non-array result, pending identity, stale
  attachment (including a hostile `isCurrent`) and async staleness with a
  deferred plugin-inventory read
- non-consuming `readAt` from `earliest`, byte bounds with chunk-boundary resume,
  oversized single chunk, ANSI/control stripping, out-of-order chunks
- goal live view with activation, `GOAL_AGENT_NOT_LIVE` projection fallback,
  authoritative `null`, pending/no-session, malformed and failing projections
- immutable workspace cwd vs effective directory, projection-only fallback,
  recorded `null`, relative path rejection, and `set`/`ensure` never called
- plugin inventory whitelist/counts, redacted diagnostics, diagnostic cap,
  malformed rows, missing/failing helper, preset rows (`conditional`, `broken`)
- tool catalog exact-Agent scope, no schema/body/executor leakage, presenter
  flags, malformed definitions, pending/no-Agent, failing registry
- job subscription owner filter, mapped reasons, attachment silence, disposer,
  hostile getter, non-disposer and redacted subscribe failure

No test reads a real profile, credential, session log, Loader tree, or creates an
Agent; no model call or terminal is involved.