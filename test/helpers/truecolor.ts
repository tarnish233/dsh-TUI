/**
 * Deterministic truecolor for cell-level color assertions.
 *
 * `src/ui/theme.ts` snapshots `getTerminalColorMode()` at import time, so a
 * test that imports any src module must force the capability cache BEFORE that
 * import evaluates. This module has no src imports, so declaring it as the
 * FIRST import of a color-asserting test guarantees the snapshot is truecolor
 * regardless of the ambient COLORTERM/TERM environment.
 */
import { setCapabilities } from '#pi-tui'

process.env.COLORTERM = 'truecolor'
setCapabilities({ images: null, trueColor: true, hyperlinks: false })
