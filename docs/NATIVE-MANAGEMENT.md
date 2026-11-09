# Native management: explicit rename, root fork, safe defaults

`src/backend/native-management.ts` is the narrow backend adapter for three explicit user
actions on the **current root attachment**:

1. rename the current session through DSH's own title owner;
2. create the explicit native `SessionStore.fork` artifact and report its native lineage;
3. read and write exactly two allowlisted native defaults (`selectedDefault`,
   `defaultPreset`) with the native revision fence.

Verified installation: `@deepseek-ai/dsh@0.2.2-rc.1` (public types/source read-only).
The adapter consumes the supplied native Cordis services through the shared
`NativeUiAccess` seam (`src/backend/native-ui-scope.ts`, parent-owned, not modified).
It adds no second harness, IPC channel, profile mirror, store, timer, poller or renderer.

## Ownership boundary

DSH owns titles, sessions, forking, presets, permissions, settings documents and their
persistence. This module:

- calls only public service methods: `ctx.sessionTitle.get/rename`,
  `ctx.sessions.get/fork`, `ctx.settings.describe/mutate`, `ctx.loader.entries()`,
  `ctx.agentPresets.list/defaultId`, `ctx.permissionPresets.catalog()`;
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
   otherwise `session-not-live` (the native title/fork owner enforces the same rule).

The same scope is re-checked **after** every async step and after the synchronous native
append/fork. When the attachment moved while a write was in flight, the durable native
result is still reported (`ok: true`) with `stillCurrent: false`; the parent must not paint
it into the new attachment.

A pending attachment has no native Session yet. Rename and fork are explicit user actions,
so the parent may materialize the exact pending Agent first through its existing lazy path
and then call the adapter with the same explicit ids. The adapter itself never does that.

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

## Native fork artifact (`SessionStore.fork`)

`forkCurrent` calls `ctx.sessions.fork(exactLiveSource, atSeq?, childSessionId?)` and
reports only native facts:

- `boundary` (omitted for an empty-source fork) derived as `inheritedEventCount - 1`;
- `inheritedEventCount`, `isSeeded` from the native Session state/header;
- `origin`, `parentSessionId`, `delegationDepth`, `cwd`, `agentPreset` **only when the
  native header carries them** — ordinary forks omit `origin`/`parentSession`, so the
  adapter never invents lineage;
- optional child title written through the same native title service; a title refusal is
  reported as `titleError` while the fork itself stands. `title` is omitted when the
  native title read failed (unknown), never claimed as no-title.

**A `SessionStore.fork` child has no Agent and no public API can attach one.** The native
fork only creates a Session (owned by the SessionStore's fiber); the agent factory's
`prepare` rejects an existing id, and `agents.resume` requires a persisted log this child
never has. The outcome therefore carries `agentAcquisition: 'native-create-required'` and
is not an interactive switch. The parent's approved interactive fork is the native
controller parity flow below.

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

`sessionForkFacts(session, sourceSessionId)` is exported pure and reads only documented
Session fields, so the parent can report identical facts for a child it created itself.

## Safe native defaults

### Namespace resolution (no hardcoded profile ids)

| target | public package name | allowlisted field |
| --- | --- | --- |
| `agent-preset-default` | `@deepseek-ai/dsh-agent-preset-registry` | `selectedDefault` |
| `permission-default-preset` | `@deepseek-ai/dsh-permission-presets` | `defaultPreset` |

`ctx.loader.entries()` is scanned for the package name; the profile entry id
(`entry.options.id`) is the settings namespace, cross-checked against
`settings.describe()`'s `ns`. Zero matches ⇒ `namespace-unresolved`, more than one ⇒
`namespace-ambiguous` (two owners could be mounted; never guess), a missing live
descriptor ⇒ `namespace-unavailable`. No web id (`permission`,
`agent-preset-registry`) and no config file/env value is used or assumed.

### Read isolation

`settings.describe({redactSecrets:true})` is the only read. Native `describe` already
projects only `volatile` form fields and redacts declared secrets, but the adapter still
copies exactly one allowlisted scalar per target, plus the native revision, the resolved
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
targets read `available:true, writable:true`, namespaces resolved from the public Loader
(`dsh-tui-preset-registry`, `permission`), native revisions present, fields unset with
native effective fallbacks (`standard`, `workspace-write`), zero warnings. Evidence:
`.cache/native-ui-expansion/management/safe-schema-native.log` and
`.../safe-defaults-native.log` (keys/booleans/counts only; no values, credentials, other
namespaces or config dumps). `value` is the exact
stored scalar; `effectiveValue` is the native resolver fallback
(`agentPresets.defaultId` / `catalog.defaultPreset`) and only when that native read
succeeds. Options come from the native rosters (`agentPresets.list()` excluding `broken`
rows, `catalog().defaultOptions`); an unreadable roster makes the target read-only
(`options-unavailable`) instead of an empty authoritative enum.

### Explicit confirmed write

`updateDefault({ target, value, expectedRevision, attachmentId? })` requires the revision
returned by the confirmed read. It re-resolves namespace/field/schema, refuses a value the
native roster does not advertise (`not-an-option`, no native call), refuses a changed
revision (`conflict` with `expectedRevision`/`actualRevision` and a fresh view, no native
call), then calls exactly:

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

Invalidation is the parent's: on the settled `settings/document-updated(ns, revision)` /
`app-boot/config-reload()` signal it emits `native_ui_changed{domain:'settings'}` and
re-reads `defaultSettings()` only while the safe-defaults surface is open (single-flight
plus one trailing read). `describe()` itself may emit that native signal when the entry's
raw config changed since the previous read; that is a native read, not a write.

## Tests

`test/backend-native-management.test.ts` (19) and
`test/backend-native-management-settings.test.ts` (17) run offline with synthetic
native-shaped doubles and no real profile, credential, session log, file or model call:

- rename: exact accepted/normalized title, previous-title fact vs unknown, invalid-title
  refusal with zero appends, foreign/pending/child/non-live/stale/missing-service
  rejections with zero native calls, post-append attachment move reported truthfully;
- fork: exact live source/boundary/child id, facts derived from native header/inherited
  state (empty source ⇒ no boundary, no invented parent/origin), native fork error
  surfaced redacted, child-title success and title refusal with the fork standing,
  zero calls for rejected scopes;
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
- settings schema proof: the **actual** native serialized form (stripped `volatile`
  marker, field unset in `value`/`user`) is accepted; a field present only in `value`, an
  unresolvable ref, an explicit `volatile:false` and a missing field stay fail-closed.

## Known limits

- Rename needs a materialized live Session; the adapter never materializes one.
- `SessionStore.fork` is session-only by native contract; interactive forking stays the
  parent's atomic `agents.create` parity flow (§ above).
- Only the two allowlisted volatile fields are writable. There is no generic settings
  editor, credential/provider/endpoint management or document reconcile.
- `settings.describe` is the native read authority; an older/partial composition without
  it (or without the Loader tree) hides the whole surface (`missing-settings-service` /
  `missing-loader`) rather than showing an empty authoritative default.