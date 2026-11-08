# DeepSeek theme and static character logo

Presentation only. DSH owns model calls, tools, permissions, sessions and native
configuration; Pi TUI owns terminal rendering. Input/readline, native command
semantics and credential paths are unchanged.

## Current startup artwork

The user supplied a DeepSeek logo reference and asked for a static character-block
mosaic with the enclosed negative space filled white. That is the only runtime
artwork now; the earlier hand-drawn whale, the upstream pixel whale, the 2px PNG
and every startup animation are retired and no longer referenced.

Source and generated data:

- `assets/logo/reference/deepseek-logo.png` — the supplied reference.
- `assets/logo/grid.json` — the runtime grid. One sample per quadrant sub-cell,
  `columns: 32`, `pixelRows: 12`, palette `B`/`W`, transparent samples `.`.
- `scripts/generate-logo-assets.py` — development-only Pillow resampling:
  extract the blue silhouette, drop the round gray badge, resample to 32×12,
  flood-fill the outside, mark the enclosed negative space `W`, then reject any
  terminal cell that would need three colors. Pillow is not a runtime dependency.

Pixel size:

- 32×12 samples become **16 columns × 6 terminal rows**; every cell carries a
  2×2 quadrant.
- Quadrant glyphs (`▘▝▖▗▌▐▀▄▚▞▙▛▜▟█`) keep each pixel **half a cell wide and half
  a cell tall**, i.e. half the area of the previous half-block pixel (full cell
  wide, half cell tall). The sample grid is anisotropic on purpose: terminal
  cells are taller than wide, so 32×12 samples preserve the logo's proportions
  in 16×6 cells.
- `B` is the DeepSeek reference pixel blue `#335DE0` (51,93,224) — an ASSET
  color deliberately independent of the 品牌蓝 tiers (user reinstated it,
  2026-11-05; `LOGO_BLUE` in `src/ui/logo.ts` is its only definition);
  `W` is white `#FFFFFF`; `.` stays transparent so the terminal background
  shows through.
- 48 of the 384 samples are white interior.
- The reference crown is almost flat, which reads as a cut-off head at this
  resolution. The generator therefore raises the middle third of the topmost crown
  run by one sample, on whole cell boundaries, so the top edge gains a shallow
  arc without the diagonal notch a per-sample profile left at the left shoulder.
  Only row-0 blue samples are added; blowhole/spout peaks and every white
  interior sample are left untouched. Apart from that documented arc the outline
  is not repainted or hand-edited.

## Separate application icon assets

The [application icon](APP-ICON.md) reuses this approved whale grid as a white
silhouette on an asset-blue rounded-square badge. Its standalone SVG/PNG files
are distribution artwork, not runtime terminal images: they do not replace this
startup logo, add image uploads/animation, or change the interface color roles.

## One renderer path

`src/ui/logo.ts` renders the grid itself as character cells. It uses only Pi TUI
public helpers (`foregroundAnsi`, `backgroundAnsi`, `rgbColor`,
`getTerminalColorMode`, `truncateToWidth`):

- the same rows, glyphs and geometry on every terminal, including Rex;
- no `Image`, no Kitty/iTerm2 placement, no image id, no Braille fallback and no
  terminal-specific branch;
- truecolor and 256-color modes share identical geometry, only the color
  encoding differs;
- no direct terminal writes, no console output, no new settings key.

A cell is rendered from its four samples: one color becomes the foreground over
the default background, and a cell with blue and white uses blue foreground over
white background so both colors stay exact.

## Header composition

`src/ui/welcome.ts` keeps our identity:

- `DeepSeek Harness`
- `DSH TUI · v0.1.1` (rendered in the 品牌蓝; the version is read from the
  shared `src/version.ts` `VERSION`, so the welcome tagline never carries an
  independent version literal)
- explicit `DEMO / NO MODEL CALLS` for the offline demo

The logo occupies 16 columns, a two-column gap follows, and the text starts at
column 18. The header needs at least 34 columns for the logo; narrower windows
render the identity only (and clip below four columns). A normal header is six
rows; the demo badge joins the fourth column when it fits and otherwise adds one
last row, so demo headers stay at most seven rows. Trailing spaces are trimmed,
and every logo row resets its styling so the white background cannot leak into
the metadata text. A single blank row follows the header so the first
conversation never sits directly under the logo, and a single blank row sits
above the editor panel so the conversation never touches the input border.

## No startup animation

The startup is fully static:

- no frame table, animation sequence or pose data in the assets;
- no `setAnimationFrame`/frame setter, no playback state and no welcome timer in
  the component or in `App`;
- no start/pause/resume/exit hooks for the logo, because there is nothing to
  stop;
- the logo is rendered once and its cache is invalidated only by resize or a
  terminal color-mode change.

The Working status and its spinner/elapsed counters are normal business state
and are unaffected.

## Interface colors

`src/ui/theme.ts` remains the ordinary UI palette. Every token it shares with
pi-cc-extensions' **cc-dark** theme (MIT) uses that theme's exact value:

| token | hex | cc-dark source |
| --- | --- | --- |
| `fg` | `#d6dde3` | `fg` |
| `muted` | `#929eab` | `fgMuted` |
| `subtle` | `#768494` | `fgSubtle` |
| `canvas` | `#0d1117` | `canvas` |
| `canvasSubtle` | `#1c2033` | `canvasSubtle` |
| `border` | `#1c2d44` | `border` |
| `accent` | `#4f9eff` | 品牌蓝主档 (cc-dark `blue`) |
| `accentBright` | `#79c0ff` | 品牌蓝亮档 (cc-dark `blueBright`) |
| `accentDim` | `#2a4060` | surface rule (not brand-derived) |
| `accentBg` | `#1a4480` | surface (`selection`) |
| `userBg` | `#1a4480` | surface (`selection`, human-turn band) |
| `diffAddBg` | `#0f2a24` | `diffAddBg` |
| `diffDelBg` | `#261418` | `diffDelBg` |
| `green`/`red`/`redSoft`/`yellow`/`orange`/`orangeSoft`/`purple`/`pink`/`cyan` | unchanged | same names |

The accent family replicates cc-dark's two-step azure ramp: the primary
`#4f9eff` for prompt arrow, spinner, hints, links, selected prefix and the
startup tagline; the bright `#79c0ff` for headings, focused labels, chips and
list bullets (user decision, 2026-11-05). `#2a4060` and `#1a4480` are dark blue
**surfaces** (rules, quote borders, badge/human-turn bands), deliberately not
derived from the brand hues. The retired blues (`#335DE0`, `#4D6BFE`) must not
reappear anywhere in `src/`, and the two brand hexes must stay confined to
`src/ui/brand.ts` (a source-scan guard test enforces both).

## 品牌蓝（cc-dark 复刻双档，唯一真相：`src/ui/brand.ts`）

品牌蓝 = 双档结构（user, 2026-11-05 定案）:主档 `BRAND_BLUE` `#4f9eff`
（cc-dark `blue`,`❯`/编辑框边框/状态栏/tagline/链接/logo 块/选定前缀)+
亮档 `BRAND_BLUE_BRIGHT` `#79c0ff`（cc-dark `blueBright`,大标题/焦点标签/
列表符号/徽章/对话框标题）。**两个 hex 只出现在 `src/ui/brand.ts`**;
`theme.ts` 的 `accent`/`accentBright` 两个角色分别指向两档,换品牌色只改
brand.ts 一个文件。logo `LOGO_BLUE` 是独立的 DeepSeek 资产蓝(仅定义于
src/ui/logo.ts,见上文 `B`)。`#4d6bfe` 全域封禁、`#335de0` 仅允许出现在
logo.ts(资产),两档品牌 hex 同样不得内联在 brand.ts 之外。

The PTY smoke scripts keep a python mirror (`scripts/pty-common.py`) synced by
hand (both tiers mirrored); `test/app-theme.test.ts` fails with a pointed
message when either drifts from the live palette.

Markdown follows cc-dark too: inline code is `mdCode` **`#a5d6ff`** (content,
not chrome), the quote border is `mdQuoteBorder` `#2a4060`, list bullets and
headings use the bright 品牌蓝 tier (`#79c0ff`) while links use the primary, and
the code-block border is `mdCodeBlockBorder` = `border`. Syntax highlighting
in `src/ui/highlight.ts` keeps its own content palette (its `#79c0ff` number/
section hues coincidentally equal the brand blue — content, not derived).
Errors/warnings/success and the
diff bands keep their semantic meanings.

Error notices follow CC's transcript layout: one `●` marker row with the
headline, then the message detail indented to the marker width, all in the
semantic red. The bridge's wire-level `agent error:` prefix is presented as the
`API Error` label (presentation only — the error text itself is not rewritten).
Info notices keep the quiet muted bullet.

## Verification

- `test/ui-welcome.test.ts` (7): independent terminal-cell decoding of all 384
  quadrant samples (blue, white, transparency, 48 white samples), identical
  output for Kitty/iTerm2/no-image capabilities, truecolor vs 256-color
  geometry, header identity/resize/cache, width safety from 1 to 160 columns and
  a source audit for image/frame/timer paths.
- `test/app-logo.test.ts` (2 modes + source audit): real App start with the Kitty
  capability forced, character blocks only, no image upload/placement, no
  startup interval or `advanceWelcomeStep` timeout, stable idle screen, and
  draft/Help/resize/shutdown preservation.
- `test/app-theme.test.ts` (10): the blue palette and the logo cells are checked
  on the actual rendered terminal.
- `scripts/pty-static-logo-smoke.py`: inline/fullscreen × Kitty hint/no hint and
  an external SIGINT, **6/6**; checks the blue and white escapes, block glyphs,
  no image protocol, no Braille, no idle repaint, draft/resize and terminal
  restoration.
- `scripts/pty-theme-smoke.py`, `pty-help-smoke.py`, `pty-model-picker-smoke.py`,
  `pty-cancel-smoke.py`, `pty-smoke.py`: the existing CLI/PTY groups were rerun
  after the change.

Latest full check: **898/898**, no failures/skips/cancellations; build and strict
TypeScript pass. Tests use temporary config and offline data; no real
model/credential/config changes.

Restart dsh-tui to load source changes. `/reload` does not replace already loaded
TUI JavaScript.