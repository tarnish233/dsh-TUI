# Vendored Pi TUI

This directory is the source of `@earendil-works/pi-tui` 1.5.0 used by DSH TUI.
It was extracted from the published package's JavaScript source maps (which
embed the upstream TypeScript sources), not from any Pi Agent/provider module.
Pi TUI is a terminal component library: it has no LLM provider, credential,
AgentSession, tool runtime or conversation persistence. DSH owns those.

Upstream: https://github.com/earendil-works/pi/tree/main/packages/tui
License: MIT, Copyright (c) 2025 Mario Zechner (see LICENSE).

The vendored source intentionally remains upstream code. DSH-specific editor
entry points live in `src/input/pi-tui-seam.js` and are installed onto the
public classes at runtime; this avoids pnpm patches and keeps the upstream
source easy to refresh.
