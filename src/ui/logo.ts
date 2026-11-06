/**
 * Static character-block DeepSeek logo on every terminal. The reference
 * silhouette is sampled into a blue/white quadrant grid: every terminal cell
 * carries 2x2 samples, so 32x12 samples become 16x6 cells and each pixel is
 * half the area of the old half-block pixel (half a cell wide, half a cell
 * tall). Enclosed negative spaces stay white and the sampled crown gets a
 * shallow arc so the head does not read as cut off.
 * No image protocol, terminal-specific branch, animation/frame state, timers
 * or direct terminal writes.
 */
import { readFileSync } from 'node:fs'
import { backgroundAnsi, foregroundAnsi, getTerminalColorMode, rgbColor, truncateToWidth, type Component } from '#pi-tui'

export const LOGO_COLUMNS = 16
export const LOGO_SAMPLE_COLUMNS = 32
export const LOGO_PIXEL_ROWS = 12
export const LOGO_ROWS = LOGO_PIXEL_ROWS / 2
/**
 * The DeepSeek reference pixel blue (#335DE0, 51,93,224) — an ASSET color like
 * LOGO_WHITE, deliberately independent of the chrome 品牌蓝 tiers in
 * src/ui/brand.ts (user reinstated the original logo blue, 2026-11-05).
 */
export const LOGO_BLUE = [51, 93, 224] as const
export const LOGO_WHITE = [255, 255, 255] as const
/** Quadrant glyphs by sub-cell bits: 1 upper-left, 2 upper-right, 4 lower-left, 8 lower-right. */
export const LOGO_GLYPHS = [' ', '▘', '▝', '▀', '▖', '▌', '▞', '▛', '▗', '▚', '▐', '▜', '▄', '▙', '▟', '█'] as const
export const LOGO_BLOCK_GLYPHS = LOGO_GLYPHS.slice(1).join('')

const data: unknown = JSON.parse(readFileSync(new URL('../../assets/logo/grid.json', import.meta.url), 'utf8'))
const record = data !== null && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : undefined
const candidate: unknown = record?.rows
if (!Array.isArray(candidate) || candidate.length !== LOGO_PIXEL_ROWS || candidate.some(row =>
  typeof row !== 'string' || row.length !== LOGO_SAMPLE_COLUMNS || !/^[.BW]+$/.test(row),
)) throw new Error('Invalid static DeepSeek logo grid')
export const LOGO_GRID = candidate as readonly string[]

for (let y = 0; y < LOGO_ROWS; y++) {
  for (let x = 0; x < LOGO_COLUMNS; x++) {
    const tags = new Set([LOGO_GRID[y * 2][x * 2], LOGO_GRID[y * 2][x * 2 + 1], LOGO_GRID[y * 2 + 1][x * 2], LOGO_GRID[y * 2 + 1][x * 2 + 1]])
    // A cell carries one foreground and one background color: blue, white and
    // transparency cannot share a cell.
    if (tags.size > 2) throw new Error(`Ambiguous static DeepSeek logo cell ${x},${y}`)
  }
}

export class DeepSeekLogo implements Component {
  private cache?: { mode: string; rows: string[] }

  invalidate(): void { this.cache = undefined }

  render(width: number): string[] {
    if (!Number.isFinite(width) || width < 1) return []
    const mode = getTerminalColorMode()
    if (this.cache?.mode !== mode) {
      const blue = rgbColor(...LOGO_BLUE), white = rgbColor(...LOGO_WHITE)
      const foreground: Record<'B' | 'W', string> = { B: foregroundAnsi(blue, mode), W: foregroundAnsi(white, mode) }
      const background: Record<'B' | 'W', string> = { B: backgroundAnsi(blue, mode), W: backgroundAnsi(white, mode) }
      const rows: string[] = []
      for (let y = 0; y < LOGO_ROWS; y++) {
        let line = '', activeForeground = '', activeBackground = ''
        for (let x = 0; x < LOGO_COLUMNS; x++) {
          const tags = [LOGO_GRID[y * 2][x * 2], LOGO_GRID[y * 2][x * 2 + 1], LOGO_GRID[y * 2 + 1][x * 2], LOGO_GRID[y * 2 + 1][x * 2 + 1]]
          let bits = 0, hasBlue = false, hasWhite = false
          for (let index = 0; index < 4; index++) {
            if (tags[index] === 'B') { bits |= 1 << index; hasBlue = true }
            if (tags[index] === 'W') hasWhite = true
          }
          if (bits === 0 && !hasWhite) {
            if (activeForeground !== '' || activeBackground !== '') { line += '\x1b[0m'; activeForeground = ''; activeBackground = '' }
            line += ' '
            continue
          }
          const fg = hasBlue ? 'B' : 'W'
          const bg = hasBlue && hasWhite ? 'W' : undefined
          let pattern = 0
          for (let index = 0; index < 4; index++) if (tags[index] === fg) pattern |= 1 << index
          const foregroundAnsiCode = foreground[fg]
          const backgroundAnsiCode = bg === undefined ? '\x1b[49m' : background[bg]
          if (activeForeground !== foregroundAnsiCode) { line += foregroundAnsiCode; activeForeground = foregroundAnsiCode }
          if (activeBackground !== backgroundAnsiCode) { line += backgroundAnsiCode; activeBackground = backgroundAnsiCode }
          line += LOGO_GLYPHS[pattern] ?? ' '
        }
        rows.push(line.replace(/ +$/, '') + '\x1b[0m')
      }
      this.cache = { mode, rows }
    }
    return this.cache.rows.map(row => truncateToWidth(row, Math.min(Math.floor(width), LOGO_COLUMNS), ''))
  }
}