# Default model and effort in Settings

## Intent

Expose two explicit DSH-owned defaults in the existing `/settings` page:

- **Default model**: choose from the mounted native provider/model catalog.
- **Default model effort**: choose a reasoning effort advertised by that default model, or use its native model/adapter default.

These are model execution settings, not the `Show thinking` transcript preference. The native catalog, configuration schema, composition, credentials and persistence remain DSH-owned. No model/effort fields are added to the TUI's local `settings.json`, no Pi model/auth configuration is read, and no per-model preference map or additional configuration hierarchy is introduced.

## Behaviour

- Default values are read from DSH's native default-selection/configuration services, never guessed from the current session, first provider or first catalog item.
- Reads and menu navigation do not select a session model, create an Agent, prepare a request, send a prompt or edit provider definitions.
- Saving a default uses a mounted public native mutation API. Native revision/attachment guards apply; failed or stale writes are not retried behind the user's back or silently converted into local preferences.
- The default effort roster belongs to the **default model**, which can differ from the logged/current session model. IDs, labels, descriptions and the native model default come from DSH metadata; the TUI does not invent a fixed low/medium/high roster or infer support from a model name.
- A model with no native reasoning levels is shown honestly as unsupported. Unknown/unreadable or malformed capability is not the same as a supported empty roster. An unreadable old roster disables only the effort row; when the native Settings owner/write path are proven, Default model remains usable to repair it through the native catalog. A necessary reasoning decision for the new target still refuses an unreadable answer.
- Using the model default removes the explicit effort override; it does not store the model's current effective default as an explicit effort.
- Default changes follow DSH's existing precedence: new/unselected sessions can follow native defaults, while explicit CLI choices and logged/selected/resumed session routes remain authoritative. The UI does not rewrite session history or impose a second default-follow policy.
- Current-session model/effort controls remain clearly distinct from default editing. Existing `/model` and `/effort` retain DSH's native side effect of also submitting the default selection; the new default controls never call the current Agent's model selector. Shortcuts, permissions, Plan and preset semantics are not merged into a new mode.

## Native seam

Both rows share the existing `native-defaults` / `native-default-update` operations and one new allowlisted target, `agent-default-model`. Its actual namespace comes from the unique Loader entry named `@deepseek-ai/dsh-agent-default-model`, not a guessed profile id. The descriptor proves the live `provider`, `model` and optional `reasoningEffort` paths and supplies a process-local revision.

An explicit model change consumes the existing native model catalog; the summary read never walks it and resolves reasoning metadata for the saved pair only. An effort-only write uses that saved pair and its own roster. Provider/model/effort operations are issued together in one native `settings.mutate(namespace, ops, expectedRevision)`; `reasoningEffort: null` maps to native `unset`. Native read-back, not the submitted value, supplies the result. A namespace/owner mismatch, stale attachment/revision or home/CLI-overlay refusal is reported rather than bypassed via another setter. Per-operation wait bounds and cancellation fences prevent an abandoned metadata lookup from starting a late mutation; they do not turn ConfigEditor's non-abortable write into a cancellable transaction.

## UI and lifecycle

Keep the continuous grouped Settings page and existing picker components. Native default selection stays a Settings-owned workspace interaction; short standalone effort selection retains its existing composer placement. Returning from a picker preserves Settings query, selected row and scroll, as well as the exact main Editor/draft/undo/paste/attachment state.

Only explicitly confirmed choices may mutate native defaults. Enter/selection confirms model and effort preferences directly; the existing additional confirmation for permission/preset defaults is unchanged. Loading, search, provider navigation, resize and cancel do not write. Closed, replaced, reattached or invalidated surfaces cannot apply stale selections or reopen themselves from late responses. Native metadata notifications refresh only existing views and coalesce concurrent reads; there is no polling router or second persistence.

Successful edits should be visible in Settings/status rather than echoed as conversation messages. Read/write failures and persistence limitations remain visible and truthful. A runtime-only or unavailable save seam must never be advertised as a confirmed persistent startup default.

## Development boundary and verification

Development edits are project-local. Installed packages are read-only source references; real user profiles/configuration/sessions/credentials are never read or changed by tests. Native acceptance uses owned temporary homes/workspaces, real native composition and hermetic model metadata/stream fixtures, with no remote model/provider calls.

Focused regressions cover independent defaults/current route, native effort IDs and reset, unsupported/unavailable services, Settings back navigation, main draft preservation, stale/invalidated responses and native revision conflicts. Native acceptance verifies the actual Settings-to-native mutation path and default reuse without model calls; persistence claims require an owned-profile restart/read-back rather than a mocked setter acknowledgement. Final build, strict typecheck and complete serial tests run with the input tree frozen.

No commit, tag, push, package publication or global executable replacement is part of this feature request. Schedule remains deferred.
