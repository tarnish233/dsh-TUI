# DSH Pi TUI development

Read docs/PROPOSAL.zh-CN.md, especially section 5, before implementation.

- DSH owns model calls, tools, permissions and durable sessions. Pi TUI owns the terminal. Do not use Pi AgentSession as the backend.
- Reuse DSH public services/APIs and packaged adapters directly. The backend directory is an integration adapter, not a second Harness: only process/terminal isolation, transport, event/decision mapping and calls into DSH belong there. Do not duplicate Agent loops, scheduling, tool execution, permission rules, compaction, persistence, or model transport. A gap in the external SDK is a reason for a narrow event bridge, not a new backend.
- CC/Pi reuse is for input/rendering UX, not an excuse to invent DSH business modes. `/permission` and native `/plan` are independent; only expose mounted native commands/capabilities, never a combined Plan permission preset or a second `/mode` setter. Normal streaming should show content, not internal attempt/settlement diagnostics.
- Model catalogs, profiles and credential semantics belong to DSH. Use its native configuration/composition and public model/credential services directly. Do not read Pi models.json/auth.json, import/group provider catalogs, migrate credentials, or add a TUI-owned endpoint/auth subsystem. DSH may internally use a packaged pi-ai adapter; that remains DSH-owned, not a TUI backend. Pi TUI is only a terminal/input dependency.
- Develop only in this directory. Other workspace projects and global installations are read-only references; do not modify them or user credentials/configuration.
- Use Node-compatible TypeScript with erasable types (no enums, parameter properties or decorators). Native Node runs the sources.
- Use TypeScript strict mode; prefer unknown with validation to any. Relative TS imports use .ts.
- Only the renderer writes to the visible terminal. Backend diagnostics go to controlled pipes/logs. Never write console output while a TUI is active.
- Preserve terminal state on exit, failure, interruption and suspend/resume.
- Input follows CC, including full readline command families, word vs whitespace deletion, kill/yank, undo, history, multiline, contextual navigation and configurable bindings. Do not just map Ctrl+P/N.
- Keyboard configuration belongs in `/settings`: one grouped editable shortcut list, no standalone `/hotkeys`, debug-heavy panels, profiles or redundant override hierarchies. Reuse the existing keymap and override file; defaults reset by deleting one override.
- Keep one editor state. Pi TUI is vendored source under vendor/pi-tui/; app-specific Editor/SelectList entry points live in src/input/pi-tui-seam.js. Never edit installed global Pi and do not reintroduce pnpm patches.
- Do not commit, publish, push, or install/replace a global executable as part of normal development. Local Git initialization/commits are allowed when explicitly requested by the user; never add credentials, runtime state, caches or build output. A user-requested local symlink for manual testing is allowed and must be reported; never publish a package or push without explicit authorization.
- Tests use temporary homes/workspaces. Parent owns live model acceptance testing; no remote model calls in delegated tasks.
- Parallel ownership: input developer owns src/input/, vendor/pi-tui/, test/input*.test.ts and input docs. Backend developer owns src/backend/ except types.ts, runtime/, test/backend*.test.ts and backend docs. Frontend developer owns src/ui/, src/state/, src/demo.ts and test/ui*.test.ts. Parent owns manifest/lock, src/backend/types.ts, app/CLI/config, shared test helpers, independent rendering/PTY tests and final integration.
- Ask parent before changing shared contracts, dependency manifests or another owner's files.
