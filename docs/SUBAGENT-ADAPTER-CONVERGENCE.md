# Subagent adapter convergence

Scope: `src/backend/subagents.ts` only. DSH still owns every subagent fact; this
note records which native public API now owns what, the read budget that remains,
and the honest limits the adapter does **not** paper over. It is not a second
Harness and not a roadmap for new Jobs/Goal/settings surfaces.

## 1. What moved to the native SDK

`SubagentBridge.readTree` used to re-implement the recursive `subagentCatalog`
walk with `sessionQuery.observeSession`, its own visited set and its own
200/depth-8 truncation. Structure now comes from the public service methods
`ctx.subagents.listDescendants(rootSessionId, signal)` and
`ctx.subagents.listChildren(parentSessionId, signal)` (declared in
`@deepseek-ai/dsh-subagent` `SubagentRuntime`, implemented in
`lib/types/list-children.js`). Native owns, and the adapter must not duplicate:

| Native duty | Where it is used |
| --- | --- |
| stable pre-order, per-catalog event order | display row order, sibling order |
| external rows are leaves | no traversal under `mode:'external'` |
| visited guard (cycles) | adapter additionally denies duplicate/root ids |
| one Session observation per branch, released before the next | no adapter lease leaks |
| branch diagnostics `corrupt \| unsupported \| unavailable` | `SubagentSnapshot.diagnostics` |
| no Agent load/resume during discovery | verified: only the root resume runs |

`listChildren` is used only where an **exact direct-parent** row is required
(control membership), never to rebuild the tree.

There is **no** adapter-side recursive catalog walk and no fallback walker: when
the mounted composition cannot enumerate, the tree stays closed (see §4).

## 2. What intentionally remains in the adapter

Native listing rows carry `{id, mode, label, activity, parentId, depth,
hasChildren}` only. The TUI also renders per-row identity, timing, usage, route,
status and one activity label, so for every readable local child the bridge folds
`subagent`, `subagentTiming`, `tokenUsage`, `modelSelection`; live projection
frames still arrive through `noteProjection`. These are the essential live
projections, not a second enumeration.

### 2.1 Resident rows (read-cost convergence)

A child Agent that is already running has a **resident** Session, so its identity
and wire views are readable without an observation lease at all. The bridge now
prefers the resident public surface and only falls back to the leased
`sessionQuery.observeSession` when that surface cannot answer:

1. `ctx.sessions.get(id)` — the public `SessionStore`. Its `id` and immutable
   `header` are public session identity metadata (no private field, no `stateOf`).
2. `ctx.sessionProjections.snapshot(session, keys)` — one synchronous,
   schema-validated wire cut over exactly the four row keys, instead of every
   client-visible unit the full observation would fold.

The fallback is the previous path verbatim: native `observeSession` with the
epoch/deadline signal, a released lease and its own failure vocabulary. It is
taken when the Session is not resident (cold/persisted child, `sessions.get`
absent or `undefined`), when the resident object does not carry the exact
requested id, when the resident header is missing/foreign, and when the
projection cut is missing, throws or returns a non-object. Nothing is invented:
`undefined` always means "take the native lease", never "assume empty".

Measured per-refresh read counts (synthetic hosts, `test/backend-subagent-read-cost.test.ts`):

| Tree | native listings | `observeSession` leases | resident projection cuts |
| --- | --- | --- | --- |
| 2 resident children | 1 | **0** | 2 (4 keys each) |
| 2 cold children | 1 | 2 (both disposed) | 0 |
| 1 resident + 1 cold | 1 | 1 (disposed) | 1 |
| 1 resident + 1 external + 1 diagnostic branch | 1 | 0 | 1 |

Before this change the same 2-resident tree cost 2 leased observations, each
folding the whole client-visible key table, each allocating a 5s deadline
`AbortSignal.timeout` plus a wait `setTimeout`, and each disposed through
`Symbol.dispose`. Those are removed *read counts*, not a latency claim: the
remaining work is synchronous map lookups plus a four-key cut.

Boundaries kept by the resident path:

- Structure is still `listDescendants` only. Native list rows stay the sole
  membership/mode/label authority; the resident surface is used strictly to
  enrich a row native already listed.
- The exact lineage cross-checks are unchanged and run on the resident header too
  (catalog parent vs durable `parentSession`, non-`subagent` `origin` → row
  omitted, tree `truncated`), so a stale resident entry can never re-label a row.
- A foreign or stale resident object (id/header id not the requested child) is
  rejected before its header is used; the native lease then supplies the fact.
- External leaves and diagnostic branches are never resolved as local Sessions
  and never take a cut.
- `available()` still requires `sessionQuery.observeSession`, because a cold or
  non-resident child has no other read path; a reader that only skipped the
  lease for residents would silently advertise a tree it cannot complete.

Consequences worth stating plainly:

- **Read budget.** One native `listDescendants` (which itself observes every
  reachable catalog once, `N+1` observations) plus **at most** one adapter row
  read per readable local child (`≤` the row bound): a key-scoped projection cut
  for a resident child, a leased observation for a cold one. A refresh is
  therefore still `N+1+M` native reads with `M≤200` adapter row reads, but the
  `M` are no longer leases and no longer fold unrelated units. Native releases
  each of its own leases before the next branch.
- **Narrower projection cut.** A row read now validates only the four units the
  row renders. An unrelated wire unit that fails to project no longer degrades
  this row (the previous full cut would have raised
  `SESSION_QUERY_CORRUPT_SESSION` for the whole row). This is a deliberate
  narrowing of the read, not a relaxation of the row's own validation: the four
  keys still pass their unit `viewSchema` before leaving the registry.
- **Unbounded at the native side.** `listDescendants` imposes **no** row or depth
  cap. The adapter receives the complete listing and only then applies its
  presentation bounds (`MAX_TREE_ENTRIES = 200`, `MAX_TREE_DEPTH = 8`), marking
  the snapshot `truncated` when it cuts. That bound is a UI budget, not a claim
  that DSH stops walking; documenting it avoids pretending a private bounded
  walker exists. The resident path cuts *reads per row*, never rows.
- **`createdAt` source.** Native descendant rows drop the parent catalog row's
  `createdAt` (`{createdAt: _createdAt, ...identity}`), so the adapter falls back
  to the child Session header `createdAt` — resident header or observed header,
  both durable native facts, never invented. External rows and diagnostic
  candidates carry none.
- **Cancellation.** One `AbortController` per root attachment epoch is forwarded
  to the listing and every observation and is aborted by `setRoot`,
  `invalidate` and `close`; a late listing is discarded by a generation check.
  `MAX_LISTING_MS` (15s) bounds a hung native walk so single-flight cannot
  wedge. The forwarded signal also includes the listing/observation deadline
  (`AbortSignal.any` with native epoch and timeout), so supported native reads
  are cancelled rather than merely abandoned when their wait expires. A row that
  resolves after the abort is still disposed and dropped (`closed` is re-checked
  at the top of every row iteration).
- **Durable child reads carry the same signal.** `readSession` (the
  `subagent-session` transcript read) and `headerOf` (bounded lineage hop) used
  to race an unbounded `observeSession` against a local wait only. They now
  forward `AbortSignal.any([epoch, AbortSignal.timeout(MAX_SESSION_READ_MS)])`,
  so a root reattachment or teardown cancels them and their deadline is a real
  native cancel. The returned facts are unchanged — same header, same
  `inheritedEventCount`, same events, same values — because the signal only
  cancels; both reads also return `undefined` once the bridge is closed instead
  of observing through a torn-down epoch.

## 3. Diagnostics (approved metadata-only wire field)

`SubagentSnapshot.diagnostics?: readonly SubagentDiagnostic[]` where each row is
`{id, parentSessionId, depth, reason: 'corrupt'|'unsupported'|'unavailable'}`.
Opaque ids, edge distance and the native diagnostic class only — never a raw
native error string, message or credential. The field is absent when a
successful listing reports no branch diagnostics (rather than an empty array);
an unavailable listing remains an absent/incomplete snapshot, never a complete
empty tree. `SubagentBridge.branchDiagnostics()` is the direct read face for
the same list.

Mapping rules, all fail-closed:

- A diagnostic candidate with no valid child row is exposed as a read-only row
  with `mode:'unknown'`, `status:'unknown'` and **no** `local` claim; it is never
  continuable and never external. `unsupported` (unknown catalog mode) still has
  its own readable catalog, so native — and therefore the display – keeps
  traversing beneath it.
- A diagnostic for an id that *also* arrived as a valid child row never
  rewrites, demotes or deletes that row: the child keeps its exact
  membership/mode/label and the diagnostic is retained only as branch metadata.
- Any diagnostic marks the snapshot `truncated`. Rejected (malformed) native rows
  are counted the same way and reported once, so a partial service cannot look
  complete.
- Native lineage cross-checks stay: a cataloged child whose durable header names
  a different parent, or is not a subagent origin, is omitted and the tree is
  `truncated`.

## 4. Membership and control

`membership(sessionId)` answers "is this a child of the **current** root" in this
order, all against the current root:

1. the already verified display row;
2. `lineageOf` (bounded header walk, `≤16` hops, must end exactly at the root)
   plus a fresh `listChildren(directParent)` row for the exact direct parent and
   native mode;
3. lineage only → `{mode:'unknown', untracked:true}` (native lineage proves
   membership, not mode);
4. header unreadable → one fresh `listDescendants(root)` row, if the native
   directory still lists it.

Removed: the 750 ms `FORCED_REFRESH_INTERVAL_MS` display cooldown. Control no
longer waits on, or is authorized by, the display refresh: a freshly cataloged
continuable child is promptable immediately because step 2 reads the exact
direct-parent catalog, and a failed lookup still fails closed. Cross-tree ids,
the current root itself, cycles and diagnostic-only candidates stay rejected.

## 5. Availability

`available()` is true only for a genuinely usable read surface: a mounted
`ctx.subagents.listDescendants` **and** `sessionQuery.observeSession`. Mutation
methods alone do not advertise the tree, and `subagent-interrupt` /
`subagent-prompt` remain gated on that readable bridge plus their exact native
method. `observeSession` stays in that requirement even though a resident child
needs no lease: without it a cold child has no read path, so the tree would be
advertised but incomplete. `ctx.sessions` / `ctx.sessionProjections` are
optional accelerators — their absence only sends the row back to the lease. A
native listing rejection carrying
`SUBAGENT_CONTROL_{QUERY,PROJECTIONS,SESSION_STORE}_UNAVAILABLE` proves the
composition cannot enumerate at all: it sticks until the next `invalidate()`
(HMR) and is reported once with that exact code. Every other failure stays a
per-read warning, so a transient read error never hides an otherwise readable
tree. Re-announcing the changed capability set on the current attachment is
`src/backend/context.ts`'s job (parent-owned).

## 6. Tests

Offline only (synthetic hosts/`FakeSessionWorld`, no profile, credential, real
session, model call or Git operation):

- `test/backend-subagent-enumeration.test.ts` — native listing invocation and
  order, complete-empty vs failed root, per-row leases, diagnostics mapping and
  the child+diagnostic non-demotion rule, malformed/duplicate/cycle rows,
  external leaves, depth/row bounds, epoch cancellation and late-result discard,
  the freshly-cataloged prompt race, cross-tree/root protection, value-only
  frames, and unavailable compositions.
- `test/backend-subagent-read-cost.test.ts` — the read budget itself, counted per
  public call: one key-scoped cut per **resident** row and zero leases, one
  released lease per **cold** row, resident/cold/mixed trees, an A/B against the
  native-lease baseline (identical entries, 2 cuts vs 2 full folds), throwing /
  `undefined` / non-object / empty / absent-registry projection cuts, stale
  resident identity and header-id mismatch, durable parent/origin contradictions,
  diagnostics + external leaves + empty-versus-unavailable trees, root
  reattachment aborting the listing epoch with the late result discarded, a late
  row lease disposed exactly once after teardown, membership/lineage scopes with
  the forwarded signal (`projectionMode:'none'` on the header hop), the durable
  child read's forwarded signal, and no Agent creation / re-listing / extra cut on
  a value-only frame.
- `test/backend-subagents.test.ts`, `test/backend-subagent-control.test.ts` —
  the same native-shaped discovery double backs the existing projection,
  follow, decision and control contracts.

## 7. Settled SDK boundaries (not TODOs)

These are limits of the installed `0.2.2-rc.1` public surface as measured, kept
as deliberate boundaries rather than open work items:

- `sessionQuery.readSession(sessionId)` takes **no** `AbortSignal`, so that cold
  fallback can only be bounded by the adapter's wait (`MAX_SESSION_READ_MS`),
  not cancelled. It returns a plain snapshot (no lease), so there is nothing to
  release. The preferred `observeSession` path above does cancel.
- `sessionProjections.snapshot(session, keys)` is documented as *folding* a
  missing cell; it is not a zero-cost hint (that is the deprecated
  `cachedSnapshot`). The adapter therefore uses it as the authoritative row cut
  and never treats a cell as "already computed".
- The live observation is cheap in persistence terms (a resident Session is read
  from memory, not from the log), so the removed cost here is projection folding,
  lease/timer allocation and per-row `await` — no disk-read claim is made for it.
  Cold children still cost one real persistence observation each, and that is
  unavoidable through the public SDK.
- `ctx.subagents.listDescendants` still has no row/depth parameter: the TUI bound
  is presentation only (§2) and must not be re-implemented as a private walker.
- There is no public "catalog row → session" resolver beyond `ctx.sessions.get`
  plus a Session observation, so an unreadable branch can only be reported as a
  diagnostic (never repaired locally).