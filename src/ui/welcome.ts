/** Static blue/white character-block logo; one terminal-independent path. */
import { getTerminalColorMode, type Component } from '#pi-tui'
import { VERSION } from '../version.ts'
import { DeepSeekLogo, LOGO_COLUMNS, LOGO_ROWS } from './logo.ts'
import { bold, t } from './theme.ts'
import { fit, visibleWidth, wrap } from './text.ts'

export interface WelcomeHeaderOptions { demo?: boolean }
export const WELCOME_ART_ROWS = LOGO_ROWS
export const WELCOME_ART_GAP = 2
export const WELCOME_LOGO_MIN_WIDTH = LOGO_COLUMNS + WELCOME_ART_GAP + 16

const TITLE = 'DeepSeek Harness'
/** The tagline version comes from the one shared release identity. */
const TAGLINE = 'DSH TUI · v' + VERSION
const DEMO = 'DEMO / NO MODEL CALLS'

export class WelcomeHeader implements Component {
  private readonly demo: boolean
  private readonly logo = new DeepSeekLogo()
  private cache?: { width: number; mode: string; rows: string[] }

  constructor(options: WelcomeHeaderOptions = {}) { this.demo = options.demo === true }
  hasLogo(width: number): boolean { return Number.isFinite(width) && Math.floor(width) >= WELCOME_LOGO_MIN_WIDTH }
  invalidate(): void { this.cache = undefined; this.logo.invalidate() }

  render(width: number): string[] {
    if (!Number.isFinite(width) || width < 1) return []
    const safeWidth = Math.floor(width)
    const mode = getTerminalColorMode()
    if (this.cache?.width === safeWidth && this.cache.mode === mode) return this.cache.rows
    if (!this.hasLogo(safeWidth)) {
      const rows = safeWidth < 4 ? [bold(t.accentBright(TITLE.slice(0, safeWidth)))] :
        [fit(bold(t.accentBright(TITLE)), safeWidth), ...this.tagline(safeWidth), ...(this.demo ? [this.badge(safeWidth)] : [])]
      this.cache = { width: safeWidth, mode, rows }
      return rows
    }
    const art = this.logo.render(LOGO_COLUMNS)
    const textWidth = safeWidth - LOGO_COLUMNS - WELCOME_ART_GAP
    const badgeFits = this.demo && visibleWidth(` ${DEMO} `) <= textWidth
    const right = [fit(bold(t.accentBright(TITLE)), textWidth), ...this.tagline(textWidth)]
    if (badgeFits) { right.push(''); right.push(this.badge(textWidth)) }
    const height = Math.max(LOGO_ROWS, right.length)
    const rows = Array.from({ length: height }, (_, row) => {
      const left = art[row] ?? ''
      return fit(left + ' '.repeat(Math.max(0, LOGO_COLUMNS - visibleWidth(left)) + WELCOME_ART_GAP) + (right[row] ?? ''), safeWidth).replace(/ +$/, '')
    })
    if (this.demo && !badgeFits) rows.push(this.badge(safeWidth))
    this.cache = { width: safeWidth, mode, rows }
    return rows
  }

  private tagline(width: number): string[] { return (width >= 16 ? wrap(TAGLINE, width) : [fit(TAGLINE, width)]).map(t.accent) }
  private badge(width: number): string {
    const label = visibleWidth(` ${DEMO} `) <= width ? ` ${DEMO} ` : DEMO
    return fit(t.accentBg(bold(t.accentBright(label))), width)
  }
}
