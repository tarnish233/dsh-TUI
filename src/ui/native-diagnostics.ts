/**
 * Native runtime diagnostics -> the existing transcript notice plane.
 *
 * Proven defect (see AGENTS.md and `.cache/terminal-log-analysis/REPORT.md`):
 * a native DSH sibling plugin writes its catalog diagnostics through the global
 * `console.error`/`console.warn` (fd 2), not through `ctx.logger`. Those bytes
 * share the terminal with the renderer, start at the focused editor's physical
 * caret and overwrite its row/border. Every successful model-listing refresh
 * writes such a line even when nothing changed.
 *
 * The application/plugin owns terminal isolation, the bounded private log and
 * fatal-stderr restoration/forwarding (`src/backend/terminal-output.ts`, whose
 * `TerminalDiagnosticRecord` is the contract this module projects). This module
 * is only the frontend half: a pure projection that decides which
 * already-classified record may become one ordinary transcript notice.
 *
 * Rules:
 *   - `routine` success (every successful listing refresh) never reaches the
 *     editor or transcript; it stays in the bounded native log;
 *   - one `warning` becomes ONE existing notice; repeats of the same text are
 *     dropped (the bounded native log still has them);
 *   - `fatal` is NOT transformed: the parent restores the terminal and forwards
 *     the native fatal stderr, so a notice would only duplicate it;
 *   - anything unrecognized is treated as routine. The frontend does not guess
 *     provider/catalog meaning; classification, sanitization and the log stay
 *     backend-owned;
 *   - notices are budgeted per rolling time window, so a long conversation is
 *     never permanently muted: a burst stays quiet after one explicit limit
 *     line, and a later new warning becomes visible again in the next window;
 *   - previews are defensive: ANSI/OSC and control characters are stripped and
 *     the text is collapsed to one width-bounded line, so a malformed record
 *     cannot paint the screen through the notice plane either.
 *
 * The helper owns no editor, no renderer, no settings and no logger. It only
 * calls the injected report callback, tolerates the app closing underneath it
 * and keeps bounded state.
 */
import { stripTerminalSequences } from '#pi-tui'
// Type-only: the backend owns this record, its classification and sanitization.
// Nothing from the backend adapter is loaded at runtime through this seam.
import type { TerminalDiagnosticRecord } from '../backend/terminal-output.ts'
import { sanitize, truncateToWidth, visibleWidth } from './text.ts'

/** The backend's sanitized record, used as-is so the agreed contract cannot drift. */
export type NativeDiagnosticRecord = TerminalDiagnosticRecord

/** Notice levels the transcript store already renders (info = muted, error = red). */
export type NativeNoticeLevel = 'info' | 'error'

/**
 * Parent hook: forward to the app's existing notice plane, e.g.
 * `App.reportNativeDiagnostic(message, level)` -> `store.report(message, level)`.
 * A one-argument callback (always `'error'`, or always info) is also valid
 * TypeScript.
 */
export type NativeDiagnosticReport = (message: string, level: NativeNoticeLevel) => void

export interface NativeDiagnosticProjectionOptions {
  /** Maximum number of individual notices per time window. */
  maxNotices?: number
  /** Maximum distinct diagnostic texts remembered for deduping. */
  maxSignatures?: number
  /** Display columns reserved for the one-line message preview. */
  maxPreviewColumns?: number
  /** Length of the notice budget window in milliseconds. */
  windowMs?: number
  /**
   * Test seam only (never a user setting): monotonic clock in milliseconds.
   * A non-finite reading is ignored, so a broken clock cannot wedge the window.
   */
  now?: () => number
}

export interface NativeDiagnosticProjection {
  /** Project one backend record. Safe to call after `dispose()`. */
  handle(record: NativeDiagnosticRecord | null | undefined): void
  /** Idempotent: stop reporting and drop the dedupe state. */
  dispose(): void
  readonly disposed: boolean
}

/** Defaults keep the notice plane useful without letting it become a log view. */
export const NATIVE_DIAGNOSTIC_DEFAULTS = {
  notices: 8,
  signatures: 32,
  previewColumns: 160,
  windowMs: 60_000,
} as const

/**
 * One honest line when a window's notice budget is exhausted. The native log is
 * bounded (it rotates and truncates), so it is never described as complete.
 */
const LIMIT_NOTICE = 'Further native diagnostics are suppressed for now; recent lines remain in the bounded native log.'

/** Strip terminal/layout bytes and collapse to one bounded display-width line. */
function previewOf(value: unknown, columns: number): string {
  if (typeof value !== 'string') return ''
  // `sanitize` already removes terminal sequences and C0/C1 control bytes.
  const text = sanitize(value).replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  if (visibleWidth(text) <= columns) return text
  // Pi's width truncation keeps styling bookkeeping (reset sequences) for the
  // renderer; this preview is plain notice text, so the result is stripped.
  return stripTerminalSequences(truncateToWidth(text, columns, '…'))
}

function bound(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback
}

export function createNativeDiagnosticProjection(
  report: NativeDiagnosticReport,
  options: NativeDiagnosticProjectionOptions = {},
): NativeDiagnosticProjection {
  const maxNotices = bound(options.maxNotices, NATIVE_DIAGNOSTIC_DEFAULTS.notices)
  const maxSignatures = bound(options.maxSignatures, NATIVE_DIAGNOSTIC_DEFAULTS.signatures)
  const previewColumns = bound(options.maxPreviewColumns, NATIVE_DIAGNOSTIC_DEFAULTS.previewColumns)
  const windowMs = bound(options.windowMs, NATIVE_DIAGNOSTIC_DEFAULTS.windowMs)
  const clock: () => number = typeof options.now === 'function' ? options.now : Date.now

  /**
   * Bounded, cross-window dedupe memory of warnings the user actually saw. A
   * budget-suppressed or failed-callback record is never added, so it can still
   * surface once a later window has budget again.
   */
  const seen = new Set<string>()
  /** Per-window state; only the window rolls, so history never mutes forever. */
  let windowStart: number | undefined
  let notices = 0
  let limitReported = false
  let disposed = false

  // A broken clock reading is ignored; the previous window continues instead of
  // resetting the budget on every record (which would defeat the throttle).
  const advanceWindow = (): void => {
    const at = clock()
    if (!Number.isFinite(at)) return
    if (windowStart === undefined || at < windowStart || at - windowStart >= windowMs) {
      windowStart = at
      notices = 0
      limitReported = false
    }
  }

  // A closing app may throw from the report path. The record already reached
  // the bounded native log, so a failed callback is dropped, not propagated.
  const emit = (message: string, level: NativeNoticeLevel): boolean => {
    try {
      report(message, level)
      return true
    } catch {
      return false
    }
  }

  const remember = (signature: string): void => {
    seen.add(signature)
    while (seen.size > maxSignatures) {
      const oldest = seen.values().next()
      if (oldest.done === true) break
      seen.delete(oldest.value)
    }
  }

  return {
    get disposed(): boolean {
      return disposed
    },

    handle(record: NativeDiagnosticRecord | null | undefined): void {
      if (disposed || record === null || typeof record !== 'object') return
      // Only an explicit backend `warning` may surface. Routine catalog success,
      // raw stdout and fatal (parent-forwarded native stderr) never do.
      if (record.kind !== 'warning') return
      const preview = previewOf(record.text, previewColumns)
      if (preview === '') return
      // The backend already sanitized and tagged the text (e.g. `[owner] …`);
      // channel is informational only, so the same line dedupes on either stream.
      const signature = preview
      if (seen.has(signature)) return
      advanceWindow()
      if (notices >= maxNotices) {
        if (!limitReported) {
          limitReported = true
          emit(LIMIT_NOTICE, 'info')
        }
        // Not remembered: a budget-suppressed warning must be able to surface in
        // a later window instead of being muted for the whole conversation.
        return
      }
      // Remember only a diagnostic the user actually saw. A failed callback (app
      // closing) is not remembered either, so it is not silently swallowed.
      if (emit(`Native warning: ${preview}`, 'info')) {
        notices += 1
        remember(signature)
      }
    },

    dispose(): void {
      if (disposed) return
      disposed = true
      seen.clear()
    },
  }
}