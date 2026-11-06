/**
 * 品牌蓝 (brand blue), two tiers, both spelled ONLY in this file (the single
 * source of truth; user decision 2026-11-05: 复刻 cc-dark 双蓝).
 *
 * - BRAND_BLUE — the primary deep blue of cc-dark (`blue`): prompt arrow,
 *   editor frame, footer, tagline, links and the selected prefix. (The
 *   character-block logo keeps its own DeepSeek asset blue — see LOGO_BLUE.)
 * - BRAND_BLUE_BRIGHT — the heading tier of cc-dark (`blueBright`): welcome
 *   title, dialog/picker titles, focused labels, chips, list bullets.
 *
 * Re-branding is editing this one file; every branded surface follows through
 * the `accentBlue` / `accentBrightBlue` assignments in src/ui/theme.ts
 * (call sites never change).
 *
 * Deliberately NOT derived from these values:
 * - surface tints (accentDim / accentBg / userBg): dark blue bands, not brand
 *   text chrome;
 * - content colors (inline code, syntax highlighting): content, not chrome.
 */
export const BRAND_BLUE = '#4f9eff'
export const BRAND_BLUE_BRIGHT = '#79c0ff'
