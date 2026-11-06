"""Shared PTY color mirrors, synced from src/ui/brand.ts.

The python smoke scripts cannot import the TypeScript theme, so the escape
bytes live here as the single python-side copy. test/app-theme.test.ts guards
that these values match the live palette; when the brand colors change, update
this file (the guard failure message says exactly that).
"""


# 品牌蓝主档 (src/ui/brand.ts BRAND_BLUE): cc-dark `blue`, the deep primary —
# prompt arrow, editor frame, footer, tagline.
BRAND_BLUE = b'\x1b[38;2;79;158;255m'
# 品牌蓝亮档 (BRAND_BLUE_BRIGHT): cc-dark `blueBright` — headings, focused
# labels, dialog/picker titles, list bullets.
HEADING_BLUE = b'\x1b[38;2;121;192;255m'
# DeepSeek logo asset blue (src/ui/logo.ts LOGO_BLUE): the original reference
# pixel color, deliberately independent of the brand tiers.
LOGO_BLUE = b'\x1b[38;2;51;93;224m'
# Logo asset white (not brand-derived): the whale interior pixels.
WHITE_FG = b'\x1b[38;2;255;255;255m'
WHITE_BG = b'\x1b[48;2;255;255;255m'
