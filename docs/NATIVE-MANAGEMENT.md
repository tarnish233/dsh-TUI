# Native management: explicit rename, safe defaults, interactive fork preparation

`src/backend/native-management.ts` is the narrow backend adapter for two explicit user
actions on the **current root attachment**, plus one pure preparation helper:

1. rename the current session through DSH's own title owner;
2. read and write the **three** allowlisted native default targets — `selectedDefault`,
   `defaultPreset` and the one native `agent-default-model` selection
   (`provider`/`model`/`reasoningEffort`) — always with the native revision fence;
3. `buildInteractiveForkInput` (pure) prepares the parent's native `/fork` creation.

The seam exposes **no** session-only `SessionStore.fork` adapter: such a child owns no
Agent and cannot be attached (§ below), and production `/fork` is the parent's native
`agents.create` flow.

Verified installation: `@deepseek-ai/dsh@0.2.2-rc.1` (public types/source read-only).
The adapter consumes the supplied native Cordis services through the shared
`NativeUiAccess` seam (`src/backend/native-ui-scope.ts`, parent-owned, not modified).
It adds no second harness, IPC channel, profile mirror, store, timer, poller or renderer.

## Ownership boundary

DSH owns titles, sessions, forking, presets, permissions, settings documents and their
persistence. This module:

- calls only public service methods: `ctx.sessionTitle.get/rename`,
  `ctx.sessions.get`, `ctx.settings.describe/mutate`, `ctx.loader.entries()`,
  `ctx.agentPresets.list/defaultId`, `ctx.permissionPresets.catalog()`, plus the three
  **injected** default-model faces (`agentDefaultModel.currentSelection`, one exact-route
  `llm.resolveModelInfo` and the adapter's own model catalog);
- never creates, resumes, prompts, cancels or switches an Agent, and never touches
  `agentOptions`, `agentPresets.mount`, `agents.create/resume` or the attachment;
- never writes a file, never reconciles/repairs a settings document, never calls
  `settings.update`/`replace`, never reads a credential, an unrelated namespace, an
  unrelated field, `base`/`user` sections, a schema dump or a `secrets` sidecar;
- keeps no state between calls (no cache, no queue, no "last value", no timers);
- returns typed outcomes instead of throwing for runtime conditions; only a broken request
  contract throws `BackendError('INVALID_ARGUMENT')` / `('INVALID_OPTIONS')`.

Read-only paths (`capabilities`, `defaultSettings`) materialize nothing.

## Attachment identity gate

Every root-scoped action validates, in this order, against the exact supplied scope:

1. `access.current()` exists — otherwise `no-attachment`;
2. `access.isCurrent(scope)` is true — otherwise `stale-attachment`;
3. `scope.sessionId === request.sessionId` — otherwise `foreign-session` (only the exact
   current root; the adapter never selects the newest session or resolves an id from a
   list);
4. when `request.attachmentId` is supplied it must equal `scope.attachmentId` — otherwise
   `stale-attachment`;
5. `scope.session` is a readable native Session with a header whose `id` equals the
   scope's session id — otherwise `no-session`;
6. the native header is not a subagent child (`origin === 'subagent'` or
   `delegationDepth > 0`) — otherwise `child-session`;
7. when `ctx.sessions.get` is mounted, the exact object must be the live store instance —
   otherwise `session-not-live` (native callers resolve the same live-instance rule).

The same scope is re-checked **after** every async step and after the synchronous native
append. When the attachment moved while a write was in flight, the durable native
result is still reported (`ok: true`) with `stillCurrent: false`; the parent must not paint
it into the new attachment.

A pending attachment has no native Session yet. Rename is an explicit user action, so the
parent may materialize the exact pending Agent first through its existing lazy path and then
call the adapter with the same explicit ids. The adapter itself never does that.

## Rename

`ctx.sessionTitle.rename(session, rawTitle)` is the only call (synchronous). Native
behaviour (verified in the installed source): rejects a non-live Session, normalizes the
text, throws `SessionTitleInvalidError` when nothing visible remains, then appends a
durable `session/title` event with `source:{kind:'user'}` and returns the folded snapshot.
`previousTitle` is read from `ctx.sessionTitle.get(session)` before the append: `null` is
the native "no title" fact, and the field is omitted when that read failed (unknown, never
claimed as no-title).

```ts
renameCurrent({ sessionId, attachmentId?, title }): SessionRenameOutcome
// ok: true  { sessionId, attachmentId?, title, seq, source:'user', previousTitle?, stillCurrent }
// ok: false { reason: 'title-invalid' | 'rename-failed' | <gate reason>, message? }
```

The outcome carries the **accepted normalized** title and the durable event seq, so the UI
never displays the raw input as if it were accepted. The title also arrives through the
normal `session/event`/projection feed; the parent must not double-write it.

## No session-only fork adapter (verified native limit)

`SessionStore.fork` is public, but a child it creates is **not usable as an interactive
fork**, so this seam does not expose it:

- `fork` only calls `store.create` (`dsh-session/lib/index.js:2025-2047`); the child Session
  is owned by the SessionStore's fiber and, per the store's own contract, "a session
  published outside that lifecycle persists nothing";
- no public API attaches an Agent to that existing live Session: `SessionStore.prepare`
  rejects an id already in the store (`session "<id>" already exists`,
  `dsh-session/lib/index.js:1814`), the agent factory enters its Session through `prepare`,
  and `agents.resume` needs a persisted log the child never has;
- the native API controller's own `session/fork` therefore never calls `SessionStore.fork`;
  it builds a seed and mints the session through `agents.create`
  (`dsh-api-session-controller`).

Pre-forking would also be actively harmful: the live child id makes the parent's own
`agents.create` for that id fail. `/fork` is therefore exactly the interactive preparation
below, and there is no "fork artifact" capability to render.

### Interactive fork preparation (parent-owned creation)

The parent needs the complete native event log, not the TUI's bounded transcript snapshot.
The public Session method is `session.snapshotEvents()` with **no bounds** (from seq 0 to
the current end; public and frozen, coalescing with `session.seq`). `buildInteractiveForkInput`
enumerates exactly that, rejects a log that does not start at seq 0 (a truncated tail),
rejects gaps, validates the explicit inclusive cut, then calls the **injected** public
`buildForkSeed(events, boundary)` from `@deepseek-ai/dsh-session`:

```ts
buildInteractiveForkInput({ sourceSession, childSessionId, atSeq, buildForkSeed, agentPreset?, cwd? })
// ok: true  { sessionId, sourceSessionId, boundary, inheritedEventCount, seed, meta:{cwd?, isSeeded:true, agentPreset?} }
// ok: false { reason: 'invalid-request' | 'event-log-unavailable' | 'boundary-invalid' | 'seed-invalid' }
```

It verifies the copied prefix keeps the exact native event identities (`seed[i] ===
events[i]`), so a re-deriving builder is refused. It never folds headers, picks a cut,
resolves a preset, mints an attachment or calls `agents.create`. The parent then calls
`ctx.agents.create` with the returned inputs, its own `agentOptions` and its mounted
preset `setup`, and switches explicitly through its existing flow. `SessionStore.fork` must
not run first (the id would already exist).

The returned `inheritedEventCount`/`boundary`/`meta` are the native creation facts the
parent reports; no separate lineage reader is exposed, so nothing can re-describe a child
that this process never created.

## Safe native defaults

### Namespace resolution (no hardcoded profile ids)

| target | public package name | allowlisted field(s) — the real write/read paths |
| --- | --- | --- |
| `agent-preset-default` | `@deepseek-ai/dsh-agent-preset-registry` | `selectedDefault` |
| `permission-default-preset` | `@deepseek-ai/dsh-permission-presets` | `defaultPreset` |
| `agent-default-model` | `@deepseek-ai/dsh-agent-default-model` | `provider`, `model`, `reasoningEffort` (in write order) |

Each target's `fields` list is the **only** allowlist representation: schema membership,
the read path, the write ops and the public `field` label all derive from it. `field` is
just that derived display/route label (`selectedDefault`, `defaultPreset`, or
`provider,model,reasoningEffort`) — it is **not** one native config path, so a consumer
must use the target's `fields`/documented paths and never write `field` as a single key.
The multi-field target cannot be split into three targets: DSH reads the three paths as
one selection, so two writes could leave a provider/model pair the composition cannot
route.

`ctx.loader.entries()` is scanned for the package name; the profile entry id
(`entry.options.id`) is the settings namespace, cross-checked against
`settings.describe()`'s `ns`. Zero matches ⇒ `namespace-unresolved`, more than one ⇒
`namespace-ambiguous` (two owners could be mounted; never guess), a missing live
descriptor ⇒ `namespace-unavailable`. No web id (`permission`,
`agent-preset-registry`, `agent-default-model`) and no config file/env value is used or
assumed.

### Read isolation

`settings.describe({redactSecrets:true})` is the only read. Native `describe` already
projects only `volatile` form fields and redacts declared secrets, but the adapter still
copies exactly the target's allowlisted scalars, plus the native revision, the resolved
namespace and the native option ids.

**Actual native form shape (verified in the installed `0.2.2-rc.1`, not assumed):**
`schema` is `{uid, refs}`; the root object node lives at `refs[String(uid)]` with
`dict: { <field>: <numeric ref> }`, and the field node is
`{type:'string', meta:{}}` — `volatileForm` keeps only volatile fields but
`plainSchema` **deletes** the `meta.volatile` marker from this client-facing form. The
field is also commonly **unset** in `value`/`user`. The proof of the allowlisted field is
therefore its membership in the form's root `dict` (resolved to a schema node with a
string `type`), accepting a retained `meta.volatile` and refusing an explicit
`volatile:false`. `value` presence is never used to select or promote a field. A missing
field, an unresolvable ref or a non-schema node fails closed with `field-not-volatile`, and
native `settings.mutate()` still validates `isVolatilePath` as the final write authority.
A non-string value is `value-malformed`, never coerced.

Verified against the real native scene in a temp owned profile (safe metadata only): both
single-field targets read `available:true, writable:true`, namespaces resolved from the
public Loader (`dsh-tui-preset-registry`, `permission`), native revisions present, fields
unset with native effective fallbacks (`standard`, `workspace-write`), zero warnings.
Evidence: `.cache/native-ui-expansion/management/safe-schema-native.log` and
`.../safe-defaults-native.log` (keys/booleans/counts only; no values, credentials, other
namespaces or config dumps). The `agent-default-model` target shares that form shape and
is proven by the offline native-shaped fixtures (`test/backend-default-model-settings.test.ts`);
its live acceptance stays the parent's owned-profile check. `value` is the exact
stored scalar (`provider/model` pair + level for the model target); `effectiveValue` is
the native resolver fallback (`agentPresets.defaultId` / `catalog.defaultPreset`) and only
when that native read succeeds. Options come from the native rosters
(`agentPresets.list()` excluding `broken` rows, `catalog().defaultOptions`); an unreadable
roster makes the target read-only (`options-unavailable`) instead of an empty
authoritative enum. The default-model target carries no `options` at all: its pair list
belongs to the adapter's model catalog, and its effort row is gated by
`reasoningAvailable`/`reasoningSupported` plus the advertised level list.

### Explicit confirmed write

`updateDefault({ target, value, expectedRevision, attachmentId?, reasoningEffort? })`
requires the revision returned by the confirmed read. It re-resolves
namespace/field/schema, refuses a value the native roster does not advertise
(`not-an-option`, no native call), refuses a changed revision (`conflict` with
`expectedRevision`/`actualRevision` and a fresh view, no native call), then calls exactly:

```ts
settings.mutate(ns, [{ op: 'set', path: [field], value }], expectedRevision)
```

which validates the volatile path and merges into the current section, so unrelated
settings (and secrets the caller never saw) are preserved. A native
`SettingsConflictError` is mapped to `conflict` with the native `expected`/`actual` and a
fresh read; a native failure is `write-failed` with one redacted diagnostic. Success is
confirmed by a fresh `describe` read-back: `changed` is true only when the stored value
equals the requested value, and `revision` is the new native revision. No automatic retry,
no wildcard write, no `update`/`replace`, no file write.

### `agent-default-model`: one selection, one mutate

`provider`/`model`/`reasoningEffort` are one native selection, so this target never uses
the single-field op above. One `settings.mutate(ns, ops, expectedRevision)` carries:

- a pair change: `set provider`, `set model`, then the reasoning decision;
- an effort-only edit (`value` is the persisted `provider/model` pair or the bare model
  id): only the level op.

`requestedEffort` semantics: an explicit level id is `set` and must be advertised by the
**target** model; `null` is the native `unset` (the model/adapter default applies again);
omitted keeps the stored level only when the new model still advertises it. Otherwise the
level is removed with the same native `unset`, which is exactly the native
`saveSelection()` omission semantic. Two refusals stay deliberately distinct:

- an **explicit** level whose target metadata is unreadable/malformed is refused
  (`unavailable`, no mutation) — it cannot be validated;
- a **stored** level whose new-model metadata is unreadable does **not** block the model
  switch: the write applies and removes the old level with that `unset`, and reports
  `reasoningEffortReset: true`. Refusing instead would strand the broken saved pair this
  target exists to repair, and DSH's own selection writer omits an unprovable level too.

Confirming the selection that is already stored produces **no ops**, so it is a successful
no-op rather than a malformed request: `ok:true, changed:false` with the current native
`revision`/`value`/`provider`/`model`/`reasoningEffort` taken from a fresh `describe`
read-back, the resolved `namespace`/`field`, `attachmentId` when supplied and
`stillCurrent`. Nothing is mutated, so no revision moves and no fence is needed. Without
a readable descriptor the confirmation fails `unavailable` instead of inventing a shape.

Every asynchronous phase (fresh native catalog read, exact-route metadata probe) is
followed by a cancellation, attachment, revision, pair and **owner** re-check: the unique
Loader namespace and the mounted `currentSelection()` are re-read from the live services,
so a deadline, a moved attachment, a moved revision, a recomposed owner or a runtime owner
that no longer reports this entry never reaches the mutation. A confirmed revision that
has already moved is a `conflict` before any bounded read is paid.

Bounded waits (each owns one cleared timer, nothing runs in the background): the
`llm.resolveModelInfo` probe of the **read** is bounded at 4 s, inside the shared 8 s
`nativeUiRead` bound, so the read can answer `reasoningAvailable:false` instead of being
abandoned as one opaque timeout; the write is an active command with no outer deadline of
its own, so its fresh catalog read and the preset roster read each carry an 8 s bound of
the same order. A caller-owned signal is still passed to the native read (the bound only
ends *this* wait), and an already-cancelled operation observes a late rejection instead of
letting it become an unhandled rejection. Expiry/cancellation never continues to a write.

Invalidation is the parent's: on the settled `settings/document-updated(ns, revision)` /
`app-boot/config-reload()` signal it emits `native_ui_changed{domain:'settings'}` and
re-reads `defaultSettings()` only while the safe-defaults surface is open (single-flight
plus one trailing read). `describe()` itself may emit that native signal when the entry's
raw config changed since the previous read; that is a native read, not a write.

## Tests

`test/backend-native-management.test.ts` (12),
`test/backend-native-management-settings.test.ts` (22) and
`test/backend-default-model-settings.test.ts` (25) run offline with synthetic
native-shaped doubles and no real profile, credential, session log, file or model call:

- rename: exact accepted/normalized title, previous-title fact vs unknown, invalid-title
  refusal with zero appends, foreign/pending/child/non-live/stale/missing-service
  rejections with zero native calls, post-append attachment move reported truthfully;
- interactive preparation: full-log enumeration, truncated tail/gap/boundary refusals,
  re-derived seed refusal, identity-preserving prefix, cwd override and builder failure;
- settings: namespace from profile-owned loader ids (not web ids), redaction-only
  describes, allowlist projection with decoy secret/namespace/extra fields never copied,
  ambiguous/missing/unexposed namespace, malformed value, unreadable roster, distinct read
  reasons, confirmed write with exactly one path op and preserved neighbours,
  stale-revision conflict before any call, native conflict with expected/actual and fresh
  view, redacted write failure, non-roster value refusal, attachment fence for read and
  write, native-normalizing read-back (`changed:false`), unmounted-service and
  invalid-contract paths;
- default model: persisted pair/level read and one exact-route metadata probe, distinct
  unsupported vs unreadable vs malformed metadata, effort-only `set`/`unset` in one
  mutate, carried vs dropped stored level by the **new** model, a model switch with
  unreadable new metadata applying with `reasoningEffortReset` while an explicit level on
  the same target is refused with zero mutations, all-provider and partial catalog
  failures, empty-catalog never becoming "not an option", stale revision before any
  bounded read, moved revision/pair/owner/attachment/cancel fences, the successful
  current-selection no-op (`changed:false`, fresh read-back, no mutate) and the unchanged
  native `saveSelection` side effect of `/model` and `/effort`;
- settings schema proof: the **actual** native serialized form (stripped `volatile`
  marker, field unset in `value`/`user`) is accepted; a field present only in `value`, an
  unresolvable ref, an explicit `volatile:false` and a missing field stay fail-closed.

## Known limits

- Rename needs a materialized live Session; the adapter never materializes one.
- Interactive forking stays the parent's atomic `agents.create` parity flow (§ above); the
  session-only `SessionStore.fork` artifact is deliberately not adapted because its child
  can never own an Agent.
- Only the three allowlisted targets (four native paths: `selectedDefault`,
  `defaultPreset`, and the `provider`/`model`/`reasoningEffort` selection) are writable.
  There is no generic settings editor, credential/provider/endpoint management or document
  reconcile.
- The model target reports `changed:false` for a confirmed current selection. A consumer
  that paints every `changed:false` as a warning must special-case that documented no-op,
  because the native read-back is exactly the requested state and nothing was written.
- `settings.describe` is the native read authority; an older/partial composition without
  it (or without the Loader tree) hides the whole surface (`missing-settings-service` /
  `missing-loader`) rather than showing an empty authoritative default.