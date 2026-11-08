# DSH TUI app icon

The application icon is a static white pixel whale on a DeepSeek-blue rounded
square. It reuses the approved startup logo grid and its own asset blue; it does
not change the UI theme, the startup character-block logo, or DSH behavior.

## Assets

- `assets/icon/dsh-tui.svg`: self-contained vector artwork, 64 × 64 viewBox;
  no fonts, linked images, scripts, external resources or embedded raster data.
- `assets/icon/dsh-tui.png`: 512 × 512 transparent PNG.
- `assets/icon/dsh-tui-64.png`: 64 × 64 transparent PNG for small-size consumers.

The whale geometry comes from `assets/logo/grid.json`; the badge uses
`LOGO_BLUE` in `src/ui/logo.ts`, not a new brand-color override. The white
silhouette and blue negative space intentionally invert the startup grid so the
icon has contrast on both light and dark tab bars. These image assets remain
static and are never uploaded at runtime. The separate title-text animation
below does not consume them. The existing package file list includes `assets`.

Reproduce locally with the existing Sharp dependency, without adding packages:

```bash
node scripts/generate-app-icon.ts
node scripts/generate-app-icon.ts --check  # read-only consistency check
```

## Rex native terminal icon (explicitly selected)

The user accepted generic terminal activity classification. On Rex only, the
root/child/fatal OSC 7501 records use `app=terminal` so Rex selects its built-in
neutral `>_` icon instead of the Node.js glyph. Ghostty and other terminals still
report `app=dsh-tui`. Native DSH identity, sessions, process name, window title
and direct notification title are unchanged. No Rex configuration/resources
are modified and no image is uploaded.

This is an activity classification change, not an independent image override.
It requires Terminal status On and a supporting Rex connection; when reporting
is off/unsupported, Rex resumes its own foreground-process icon.

An owned Node.js probe verified the actual sidebar and pane-header image before
and after changing just `app`: Node green hexagon → generic terminal `>_`, with
the same process. The probe was removed and the original visible tab restored.
Evidence is in `.cache/rex-terminal-icon/`; the supplied pixel-whale artwork
remains separate from this built-in icon.

## Rex title marker (explicitly selected)

Rex title text uses only the user-selected static `🐳` Unicode prefix, not these
SVG/PNG files. The user removed the preceding star/work glyphs: no status marker,
animation frame, clock input or Reduced-motion branch remains in the title
controller. Working/blocked/done/idle transitions do not rewrite the title.

The existing Terminal title switch disables this presentation. Ghostty and
other terminals retain their plain titles. Native DSH session titles and the
Rex `>_` icon classification are unchanged. Ordinary editor/agent progress
animations still use their existing UI clock; this removal affects titles only.

## Verification

The initial artwork/startup/theme/welcome/terminal regressions passed **62/62**
(6 new icon tests), including PNG sizes/corners, all 384 source-grid sample
centers, safe SVG, package asset inclusion and a byte/mtime-preserving `--check`.
The latest static-title cleanup passes **111/111** focused checks, build and
strict TypeScript, real Rex App fixtures **2/2** and CLI/PTY **8/8**. Titles remain
static through working/blocked/settled states and the native `>_` classification
is unchanged. The preceding neutral-icon stage passed **1761/1761** full tests
and an owned GUI comparison verified `>_` in sidebar/pane header; the full suite
was not rerun for this cleanup.
Custom SVG/PNG icon-display acceptance is **not** claimed: our pixel-whale
artwork, title Unicode text and Rex’s built-in terminal glyph remain separate.

## Rex: artwork is not an icon registration protocol

Current Rex chooses program artwork on its side. OSC 7501's `app` field is a
stable grouping/filter/icon lookup key, not an image payload. The documented
protocol has `state/id/kind/progress/app/title/msg`, no image, icon, path or URL
field. OSC 0/2 is a plain-text title, not an image channel.

No public project-level SVG/PNG registration mechanism was found in the audited
Rex version (`0.0.1793890641-gaf0c20`, API revision 11). Consequently **shipping
these assets does not make Rex display them as a native tab/pane icon**. Rex
would need to recognize `dsh-tui` and supply/use matching artwork, or expose a
supported custom-icon mechanism. This work does not claim that step is done.

- Keep native DSH identity and title/notification labels as `dsh-tui`. The user
  rejected a Docker identity and later explicitly accepted generic Rex activity
  classification `app=terminal`; use that only for Rex status records. Do not
  rename the process or impersonate Docker/Grok/Pi. The title marker remains
  `🐳`, and image assets are unchanged.
- Do not invent `icon=` or `logo=` OSC fields: unknown keys are ignored.
- Do not replace Rex resources, change user config, rename user tabs, or install
  a private icon registry.
- The explicitly selected `🐳` title marker is Unicode text, **not** a native
  image icon. It does not use or upload the SVG/PNG assets.
- Status/attention indicators remain available through the existing generic
  program-status integration, independently of app artwork.

References: [Program Status Protocol](https://www.superlogical.com/rex/docs/build/program-status.md),
[Rex macOS settings](https://www.superlogical.com/rex/docs/reference/mac-settings.md),
[terminal support](TERMINALS.md). DeepSeek mark attribution remains in
[THIRD_PARTY_LICENSES](../THIRD_PARTY_LICENSES.md#deepseek-logo); no endorsement is
implied.
