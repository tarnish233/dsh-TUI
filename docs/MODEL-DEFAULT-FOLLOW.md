# Model route following (native defaults)

Implementation note for the in-process adapter's model route in
`src/backend/context.ts` (routes / pending / `prepareAgent` / `agentRoute` /
`setModel` / `setEffort`). It complements `docs/BACKEND.md` (lifecycle) and
`docs/PROVIDERS.md` (catalog/interactive commands); neither file changes here.

## Rule

| Session state | Route source | Behaviour after another surface moves the native default |
| --- | --- | --- |
| pending, no explicit choice | live `agentDefaultModel.currentSelection()` | follows on the next read (`connect`/`state`/`ready`) |
| pending, staged `/model` or `/effort` | adapter pin on `PendingSession.route` | pin wins; the moved default does not apply |
| pending, explicit `--provider/--model` | adapter pin (`explicitConfigRoute()`) | pin wins |
| live, no native selection/request yet | live `AgentOptions` getters (see below) | the Agent itself follows; the adapter re-reads, never re-creates |
| live, native `model/selection` or `request/header` | DSH-owned fold (`agent.model.current()`) | logged fact wins; defaults no longer apply |
| live, adapter `/model` or `/effort` | `agent.model.select()` pin (+ `live.route`) | pin wins |
| resumed | the Session's own logged selection/request | logged fact wins; the CLI pair never rewrites it |
| resumed, nothing logged | live `AgentOptions` getters | follows, like the native session controller |

An absent or failing `currentSelection()`/`agent.model.current()` read stays
**unknown** (`''`, no `reasoningEffort`) instead of being guessed from the last
route the adapter saw. Nothing is promoted from a default into an explicit
choice: `carriedEffort` still only carries a level the newly selected target
advertises, and a followed default supplies no "selected" provenance.

## Native evidence

- `@deepseek-ai/dsh-agent` `AgentOptions` (`lib/types/runtime-types.d.ts`):
  "Route fields may be live accessors until the Session records a selection or
  request; step preparation captures their value." `assertAgentOptions` in
  `dsh-agent-loop` validates only `maxTokens`, so accessors survive creation.
- `AgentModel.current()` (`lib/types/model-selection.js`): `recorded pending ??
  last request ?? options` — the recorded facts always precede the accessors,
  and each `pre-step` re-reads `current()`.
- `@deepseek-ai/dsh-api-session-controller` `lib/types/agent.js#agentOptions()`:
  the packaged native host passes exactly three getters reading
  `ctx.agentDefaultModel.currentSelection()`, for **both** `agents.create` and
  `agents.resume` ("A Session that records no selection or request follows
  default changes"). The adapter now mirrors that shape; it does not add a mode,
  endpoint or credential policy, and it never calls `model.select` on someone
  else's behalf.
- `agentDefaultModel.currentSelection()` is a plain getter over the owning
  config references, so a native `settings`/`configEditor` write is visible on
  the next access. No cache, timer or subscription is added for it here.

## Deliberate differences and limits

- A failing default read inside the option accessors is reported as *unknown*
  (`undefined`) rather than thrown. The packaged controller lets it escape; the
  adapter's own display reads (`sessionInfo`/`state`) also consult
  `agent.options`, so a throwing getter would turn a footer refresh into a hard
  failure. The native loop then reports its own missing route at step
  preparation, and no fabricated route is stored.
- Resume precedence is unchanged except that the dead `loggedRoute` parameter
  and the duplicated `resolveRoute()`/`routeForPending()` chain are gone: a
  resumed Session is `logged request header` (native authority) else the live
  default. The explicit CLI pair pins **new** sessions only; it is no longer a
  display fallback for a resumed conversation, matching the native session
  controller and the documented "resume keeps its own route" rule.
- `setModel`/`setEffort` re-check the followed route after their asynchronous
  catalog/metadata reads. If another surface moved the default (or the
  attachment changed) meanwhile, the obsolete choice fails with
  `STALE_SESSION` instead of pinning a route whose premise changed; nothing is
  selected or saved.
- Integration uses public settled `app-boot/config-reload` and
  `settings/document-updated` in the parent-owned `bindHost` section. Signals
  coalesce and read `agentRoute()` once; current-attachment `model_route` updates
  the footer/current badge without selecting a model, preparing a request or
  adding a polling router. Catalog invalidations refresh existing surfaces only.

## Verification

`test/backend-default-follow.test.ts` uses a native-shaped fixture (the fake
registry keeps the exact `agentOptions` object; its Agent resolves
`pending ?? lastRequest ?? options`, and the default service is a mutable
getter):

1. pending follows a moved default, creates no Agent, and performs no scheduled
   read;
2. a failing default read is unknown and blocks effort validation instead of
   inventing a level, while `/model` still works;
3. a materialized but unrequested Agent follows the default through **true
   getters** and records no selection;
4. a native `model/selection` and a native `request/header` pin the route and
   the logged header is left untouched;
5. a staged `/model` produces a complete static `agentOptions` snapshot; later
   defaults do not move it;
6. a selected `/effort` keeps its provenance while the default effort moves;
7. the CLI pair pins a new session, is absent from `agents.resume`, and a logged
   route survives an unreadable default;
8. same-attachment async races (pending and live `/model`, pending `/effort`)
   fail closed with `STALE_SESSION` and save nothing.

Pre-change/fixed-after control: replaying the same file against a private cache
snapshot of the previous route logic fails 10 of 11 tests (the explicit-choice
control passes in both). Logs:
`.cache/default-follow-check/logs/pre-fix-behaviour.log`. The source-level run
is 11/11. The parent rebuilt the real `lib/` and replayed
`test/acceptance-default-follow.test.ts`: 4/4 real native cases pass, including
settled config-to-footer metadata. The previous compiled baseline had 2 failing
implicit-default cases and 2 passing explicit-choice controls; evidence is in
`.cache/adapter-convergence-final/native-default-before.log`. Latest full
acceptance: 1910/1910, see ADAPTER-CONVERGENCE-COMPLETE.zh-CN.md.