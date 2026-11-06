# DSH TUI integration contract

Application/package/entry identity is `dsh-tui`. Read `AGENTS.md` and `docs/PROPOSAL.zh-CN.md`, especially section 5. The upstream vendored package remains Pi TUI and every app import goes through `#pi-tui`.

## Native application

Production is an ordered DSH application bundle plus same-process Cordis startup/terminal plugins. The native DSH launcher composes the profile and owns the root lifecycle. The compatibility entry may attach this local application through the selected DSH installation's public package APIs before delegating to native `dsh`; it must not write a private profile engine, copy profiles/credentials, or replace unrelated frontends. The explicit `--demo` is fixture-only and never a fallback for failed native startup.

DSH owns Agent/model/tools/permissions/presets/commands/sessions/persistence and attachment admission. Do not use Pi AgentSession, implement another Agent loop/model transport, or restore a private backend process/IPC bridge. Preset resources and the preset plugin class resolve from the host's public installation anchor, not the TUI package's peer lookup.

## Input owner

Own `src/input/`, `vendor/pi-tui/`, `test/input*.test.ts` and input docs. Reuse one Editor state, kill ring, undo, history and paste/image atoms. Parent routes app actions and dialogs through semantic contextual actions. Keep the app-owned seam; never edit installed Pi or bypass the private `#pi-tui` import seam. The vendor is built before the app.

## Backend owner

Own `src/backend/` except shared `types.ts`, `test/backend*.test.ts` and backend docs. Adapt the supplied host Context to `Backend` in `src/backend/types.ts`. Preserve genuine process-local native streams, authoritative settlements, attachment epochs and explicit recovery. Reuse native cancellation/queues/decisions/model/permission services; never replace them with local policy or a fake production implementation. Only stable, sanitized scalar diagnostics may leave the adapter; raw canonical events/tools/images stay faithful.

## Frontend owner

Own `src/ui/`, `src/state/`, `src/demo.ts` and `test/ui*.test.ts`. Render from backend facts with cached/stable components and one input state. Only the renderer writes while a TUI is active. Normal success updates the footer; internal settlement/attempt diagnostics do not enter the transcript. Native `/permission` and `/plan` are separate.

## Parent / integration

Own manifests/lock, shared backend types/helpers, `src/plugin/`, app/CLI/config, independent PTY/rendering tests and final integration. Delegate another owner's file explicitly before editing it. Node-compatible strict TypeScript uses erasable syntax and relative `.ts` imports; shipped entrypoints run compiled JS. Keep version identity in `src/version.ts` and preserve every terminal lifecycle path.

Tests use temporary homes/workspaces and mock or native offline fixtures. No real profile patches/credential values, remote model calls, global installation changes, commits, publication or pushes. Existing unrelated dirty-tree work must remain intact. Final gates are build, strict typecheck, complete tests and native/compiled-entry acceptance; inspect actual delegated changes before reporting completion.
