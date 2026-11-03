# Prototype integration contract

Entry is `dsh-pi-tui`; `--demo` uses an offline mock, normal startup must use real DSH. Read AGENTS.md and docs/PROPOSAL.zh-CN.md.

## Input (delegated)

Own src/input/, vendor/pi-tui/, test/input*.test.ts. Export CcEditor (same constructor as Pi Editor, inherited onSubmit/onChange) and keymap configuration from src/input/index.ts. Parent routes app actions/dialogs; agree on a semantic contextual action lookup API in your report. Provide lossless draft capture/restore if needed. Do not bypass editor state with string rewrites losing undo/pastes. Use the vendored TUI source and the app-owned seam installer only; never modify global Pi. Do not edit package.json; tell parent new dependencies required. The vendored TUI is built with pnpm build:pi-tui.

## Backend (delegated)

Own src/backend/ except shared types.ts, runtime/, test/backend*.test.ts. Export DshBackend implementing Backend (constructor DshOptions) from src/backend/index.ts. Contract is src/backend/types.ts. Stream events carry real process-local agent/assistant-stream; session_event carries authoritative v2 settlements. Do not fake realtime tokens from SDK/ACP committed records. Reuse installed DSH launcher/profile via a private overlay/bridge if practical. Scratch overlays/config are project/temp-local; never mutate global dsh/profiles. Inherit existing DSH credentials safely; never print them. Do not read arbitrary user session content.

connect returns SessionInfo and emits ready. resume/new returns or emits fresh info with durable snapshot. Handle bad path/version, rejected requests, disconnect, shutdown, fatal errors and cancellation. No real remote model prompts: parent owns live smoke. Offline control-plane startup in a throwaway workspace is allowed.

Approval options use opaque values; ordered strings/string arrays for question answers. Models/sessions commands return normalized JSON arrays; model/permissions/compact reject clearly if unavailable. Permissions is read-only catalog/selection data; switches execute native `/permission`, while native `/plan` stays independent. `presets`/`efforts` are read-only native roster/model metadata; `preset`/`effort` update only the native Agent composition/model-selection slot. Claim only exercised capabilities.

## Parent

Own manifest/lock, Backend types, CLI/app/state/UI/demo, shared test harness, terminal replay, live acceptance, README. Node >=22.19 strips TS: use erasable syntax. Gates are pnpm typecheck and pnpm test. Consult ownership before touching shared files.
