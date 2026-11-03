# Native DSH model/configuration pass

User direction: this is DSH TUI, not Pi/CC Agent. Replace the remaining Pi models/auth import path with DSH's native configuration, profiles, catalog and credential ownership. User specifically requested cloudagent/deepseek-v4.1-flash-1017 as developer; parent owns independent acceptance.

## Single developer ownership for this pass

The backend-developer is explicitly authorized to edit src/backend/* (including DshOptions in types.ts), runtime/*, src/cli.ts, test/backend*.test.ts, scripts/live-providers-smoke.ts, docs/BACKEND.md and docs/PROVIDERS.md. Parent owns App/input/UI/config, README, AGENTS, this contract, independent NEW test/backend-dsh-config.test.ts and final artifacts/acceptance. Manifests/lock and installed/global/user configuration must remain unchanged. Previous REFACTOR-CONTRACT provider-import instructions are superseded by this pass.

## Target contract

- Remove DshOptions.modelsFile and the --models-file CLI path; never inspect Pi catalog/auth files or their environment pointers. A removed-option error may explain native DSH configuration, but must never import it.
- Add DshOptions.profile?: string and --profile <name> for choosing a real DSH profile. Native launcher/profile services own resolution/composition and precedence. Default selection must be grounded in those APIs, not guessed from the first provider or first profile.
- Catalog and credentials come from the mounted DSH runtime. Keep ctx.llm listProviders/listModels/resolveModelInfo and native model-selection/agentDefaultModel semantics; no copied catalog, route aliases, inferred capabilities or key migration.
- Remove production external-models/provider-profiles and the migration auth shim rather than hiding/relocating them. DSH's native llm-pi-ai is a valid DSH adapter, not a Pi Agent/TUI-owned transport. Custom gateways must be configured/authenticated in DSH.
- Reuse selected DSH profile configuration, including its model-provider composition and native auth/default-model settings. Do not silently drop named-profile configuration, clone all profiles, or reimplement YAML/merge/provider/credential algorithms.
- Retain only evidenced process/terminal isolation glue if the installed public API lacks a safe native attach seam. All writes are scratch/test-local; existing user profile/config/credentials are never edited. Report concrete unresolved API gaps instead of asserting complete native support.
- Native raw streaming, pure codecs, event metadata, approvals, /compact/commands, attachment epochs and terminal restoration must remain intact. No AgentSession, new LLM client, second persistence, SDK completed-message replay or relaxed permission policy.

## Developer test requirements

Only temporary homes/workspaces and fake keys/loopback SSE. No remote model prompts, OAuth/login, credential commands, real .credentials/.env/Pi auth reads, or raw user patch dumps. Installed DSH package docs/types are read-only references. Preserve all strong Messages/Responses/Completions pre-finish UI assertions by converting Pi-import fixtures to native DSH profile/config fixtures; never skip/weaken them to make deletion pass. Test native profile/default-model/catalog propagation, no Pi reads/fallback, removed CLI flag, provider/auth isolation and cleanup.

## Parent acceptance

Verify actual changes, run full typecheck/tests, direct native temporary-profile/default/catalog/credential probes, held-SSE paints in both renderers, and real CLI PTY recovery. Real model tests only if the route is already configured natively; do not silently import/read Pi or rewrite user settings to keep an old test command working. Clearly distinguish native configured models from routes that still require user configuration in DSH.
