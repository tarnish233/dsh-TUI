/**
 * Native subagent labels and honest metric formatting.
 *
 * These helpers are pure and presentation-only: they never infer a status from
 * prose, never measure a run locally and never turn an absent native total into
 * `0`. The transcript row, Agents overlay and child-session header share them so
 * one child reads identically in all three surfaces.
 */
import type { SubagentEntry, SubagentMode, SubagentStatus, SubagentTiming } from '../backend/types.ts'
import { formatElapsed, formatOutputTokens } from '../state/output-stats.ts'
import { fit, oneLine, sanitize, visibleWidth } from './text.ts'
import { bold, t, underline, type Style } from './theme.ts'

/** Native mode vocabulary; `unknown` is a real native answer, not a fallback guess. */
export function subagentModeLabel(mode: SubagentMode): string {
  switch (mode) {
    case 'one-shot': return 'one-shot'
    case 'continuable': return 'continuable'
    case 'external': return 'external'
    case 'unknown': return 'unknown mode'
  }
}

/**
 * Native status label.
 *
 * A continuable child can be activated again, so its finished state is the end
 * of one run (`last run completed · idle`), never a permanent `Done`. A
 * one-shot child really is terminal once completed. External tasks are leaves
 * with no local Session to report on.
 */
export function subagentStatusLabel(entry: Pick<SubagentEntry, 'mode' | 'status' | 'timing'>): string {
  if (entry.mode === 'external' || entry.status === 'external') return 'external'
  switch (entry.status) {
    case 'completed':
      return entry.mode === 'continuable' ? 'last run completed · idle' : 'completed'
    case 'idle':
      return entry.mode === 'continuable' && entry.timing?.lastTurnCompleted === true
        ? 'last run completed · idle'
        : 'idle'
    case 'max-tokens': return 'max tokens'
    case 'refusal': return 'refused'
    case 'stopped': return 'stopped'
    case 'failed': return 'failed'
    case 'initializing': return 'initializing'
    case 'running': return 'running'
    case 'unknown': return 'unknown'
  }
}

/** Coarse state used only to pick a glyph/color; never a second status source. */
export type SubagentTone = 'running' | 'done' | 'idle' | 'failed' | 'stopped' | 'external' | 'unknown'

export function subagentTone(entry: Pick<SubagentEntry, 'mode' | 'status'>): SubagentTone {
  if (entry.mode === 'external' || entry.status === 'external') return 'external'
  switch (entry.status) {
    case 'running':
    case 'initializing': return 'running'
    case 'completed': return 'done'
    case 'idle': return 'idle'
    case 'failed': return 'failed'
    case 'stopped': return 'stopped'
    case 'max-tokens':
    case 'refusal': return 'failed'
    case 'unknown': return 'unknown'
  }
}

/** Display label: native label when present, durable id otherwise. */
export function subagentLabel(entry: Pick<SubagentEntry, 'id' | 'label'>): string {
  const label = entry.label === undefined ? '' : sanitize(entry.label).trim()
  return label === '' ? sanitize(entry.id) : label
}

/** Compact one-line sender identity for trigger rows/details. */
export function subagentSenderLabel(sessionId: string): string {
  return sanitize(oneLine(sessionId, 80))
}

/**
 * The single current activity. A stale activity label is not repeated for an
 * idle/finished child: DSH's `lastActivity` describes the latest activation,
 * and showing it as "current" afterwards would invent live work.
 */
export function subagentActivity(entry: Pick<SubagentEntry, 'status' | 'lastActivity'>): string | undefined {
  if (entry.status !== 'running') return undefined
  const activity = entry.lastActivity === undefined ? '' : sanitize(oneLine(entry.lastActivity, 100)).trim()
  return activity === '' ? undefined : activity
}

/**
 * Session-total active time from native timing fields.
 *
 * This is the same fold the DSH web client uses: accumulated settled time plus
 * the currently open turn (`activeThrough`, or `now` while running). It is a
 * whole-session total, never a per-activation stopwatch, and no local timer is
 * created — callers re-render on native updates and may inject `now` in tests.
 */
export function subagentTimingLabel(timing: SubagentTiming | undefined, now = Date.now()): string | undefined {
  if (timing === undefined) return undefined
  let total = timing.settledMs ?? 0
  if (timing.activeSince !== undefined) {
    const end = timing.activeThrough ?? now
    total += Math.max(0, end - timing.activeSince)
  }
  if (!(total > 0)) return undefined
  const formatted = formatElapsed(total)
  return formatted === '' ? undefined : formatted
}

/** Native session-total token count (`totalTokens` is already the sum of buckets). */
export function subagentTokensLabel(totalTokens: number | undefined): string | undefined {
  if (totalTokens === undefined || !Number.isFinite(totalTokens) || totalTokens < 0) return undefined
  return `${formatOutputTokens(totalTokens)} tok`
}

/** `provider/model · effort` without inventing a missing half. */
export function subagentRouteLabel(entry: Pick<SubagentEntry, 'provider' | 'model' | 'reasoningEffort'>): string | undefined {
  const provider = entry.provider === undefined ? '' : sanitize(entry.provider).trim()
  const model = entry.model === undefined ? '' : sanitize(entry.model).trim()
  const effort = entry.reasoningEffort === undefined ? '' : sanitize(entry.reasoningEffort).trim()
  const route = provider === '' ? model : model === '' ? provider : `${provider}/${model}`
  const parts = [route, effort].filter(value => value !== '')
  return parts.length === 0 ? undefined : parts.join(' · ')
}

/** Status + mode + optional activity, joined for a compact secondary label. */
export function subagentSecondary(entry: SubagentEntry): string {
  const parts = [subagentModeLabel(entry.mode), subagentStatusLabel(entry)]
  const activity = subagentActivity(entry)
  if (activity !== undefined) parts.push(activity)
  return parts.join(' · ')
}

/**
 * Whether this child has a local child Session the UI may open. `external` is
 * the native leaf; `local: false` is an explicit non-local fact and is honored
 * even for an otherwise unknown mode. An absent `local` is not treated as
 * external (cold catalog rows may omit it).
 */
export function subagentOpenable(entry: Pick<SubagentEntry, 'mode' | 'status' | 'local'>): boolean {
  return entry.mode !== 'external' && entry.status !== 'external' && entry.local !== false
}

/** Status label for a raw native status (used by tests/diagnostics). */
export function subagentRawStatusLabel(status: SubagentStatus): string {
  return status === 'max-tokens' ? 'max tokens' : status
}

/**
 * Whether a native reply (follow-up prompt) may be requested for this child.
 *
 * Only a **local continuable** child can receive another prompt: a one-shot
 * child is terminal, and an external task has no local Session to prompt. The
 * status is deliberately not part of the test — a continuable child that is
 * running/idle/finished/stopped/failed is prompted the same way, and DSH decides
 * whether that activates it again or steers the current run. Nothing here is
 * inferred from `lastActivity` or prose.
 */
export function subagentCanReply(entry: Pick<SubagentEntry, 'mode' | 'status' | 'local'>): boolean {
  return subagentOpenable(entry) && entry.mode === 'continuable'
}

/**
 * Whether a native stop may be requested for this child.
 *
 * Only a local child the native lifecycle currently reports as
 * `running`/`initializing` is stoppable; idle/completed/failed/stopped rows are
 * not, and an external task has no local Agent to interrupt. A duplicated
 * `status: 'external'` never becomes stoppable through `mode` alone.
 */
export function subagentCanStop(entry: Pick<SubagentEntry, 'mode' | 'status' | 'local'>): boolean {
  if (!subagentOpenable(entry)) return false
  return entry.status === 'running' || entry.status === 'initializing'
}

const DOT = '⏺'
const HOLLOW = '◌'

/** Native status glyph per coarse tone (same mapping as the Agents overlay). */
export const SUBAGENT_GLYPHS: Readonly<Record<SubagentTone, string>> = {
  running: DOT,
  done: '●',
  idle: HOLLOW,
  failed: '●',
  stopped: HOLLOW,
  external: HOLLOW,
  unknown: HOLLOW,
}

/** Styled native status glyph; the tone only picks a palette member. */
export function subagentGlyph(tone: SubagentTone): string {
  const glyph = SUBAGENT_GLYPHS[tone]
  switch (tone) {
    case 'running': return t.accent(glyph)
    case 'done': return t.green(glyph)
    case 'failed': return t.redSoft(glyph)
    case 'stopped': return t.yellow(glyph)
    case 'idle': return t.muted(glyph)
    case 'external': return t.subtle(glyph)
    case 'unknown': return t.subtle(glyph)
  }
}

/** Styled status text for one coarse tone. */
export function subagentStatusStyle(tone: SubagentTone, text: string): string {
  switch (tone) {
    case 'running': return t.accent(text)
    case 'done': return t.green(text)
    case 'failed': return t.redSoft(text)
    case 'stopped': return t.yellow(text)
    case 'idle': return t.muted(text)
    case 'external': return t.subtle(text)
    case 'unknown': return t.subtle(text)
  }
}

// ---------------------------------------------------------------------------
// Internal child links

/** Inclusive component-local columns of one painted internal link. */
export interface SubagentLinkSpan {
  readonly startCol: number
  readonly endCol: number
}

/**
 * Internal TUI link style: bold brand blue + underline, brighter while hovered.
 *
 * These are hitbox-backed links, never OSC 8 hyperlinks: the underline is real
 * SGR inside the painted label and no URL, browser destination or custom scheme
 * is ever generated.
 */
export function subagentLinkStyle(hovered: boolean): Style {
  return hovered
    ? text => underline(bold(t.accentBright(text)))
    : text => underline(bold(t.accent(text)))
}

/** One painted line plus the link geometry that actually survived the clip. */
export interface SubagentPaintedLink {
  readonly line: string
  /** Absent when the link is inert or its text was clipped out of view. */
  readonly link?: SubagentLinkSpan
}

/**
 * Paint one line and derive its link geometry from the text that survives.
 *
 * `fit` clips through Pi TUI's `truncateToWidth`, so the painted content is a
 * contiguous prefix of the raw line: all of it when the line fits, otherwise
 * only the columns left by the three-cell ellipsis that replaces the tail.
 * Geometry therefore never covers an ellipsis cell or any clipped-away label:
 * a label that starts at or beyond the last painted content cell yields no span
 * at all, and a partially clipped one stops at the last visible column. All
 * coordinates are display columns (CJK/emoji/ANSI safe), never UTF-16 lengths.
 */
export function subagentPaintedLink(
  raw: string,
  width: number,
  prefixWidth: number,
  textWidth: number,
  linkable: boolean,
): SubagentPaintedLink {
  const line = fit(raw, width)
  if (!linkable || textWidth <= 0) return { line }
  const contentWidth = paintedContentWidth(visibleWidth(raw), width)
  if (prefixWidth >= contentWidth) return { line }
  return {
    line,
    link: {
      startCol: prefixWidth,
      endCol: Math.min(prefixWidth + textWidth - 1, contentWidth - 1),
    },
  }
}

/** Columns of a raw line whose original text is still painted after `fit`. */
function paintedContentWidth(rawWidth: number, width: number): number {
  if (rawWidth <= width) return rawWidth
  return Math.max(0, width - visibleWidth('...'))
}

// ---------------------------------------------------------------------------
// Durable trigger sender identity

/**
 * Display identity of a durable settlement/trigger sender.
 *
 * When the native catalog already knows the child, the row shows that child's
 * own label and may offer a link to its session; the catalog entry is the only
 * proof of an openable local Session. Without an entry the durable sender id is
 * shown exactly as stored and `openable` is `false`, so no surface paints a link
 * (or claims a click) for a child the parent could not actually open. Nothing
 * here is fetched: the caller passes the catalog it already holds.
 */
export interface SubagentSenderDisplay {
  readonly label: string
  readonly openable: boolean
}

export function subagentSenderDisplay(
  senderSessionId: string,
  entries: readonly SubagentEntry[] | undefined,
): SubagentSenderDisplay {
  const entry = entries?.find(candidate => candidate.id === senderSessionId)
  if (entry === undefined) return { label: subagentSenderLabel(senderSessionId), openable: false }
  return {
    label: oneLine(subagentLabel(entry), Number.MAX_SAFE_INTEGER),
    openable: subagentOpenable(entry),
  }
}