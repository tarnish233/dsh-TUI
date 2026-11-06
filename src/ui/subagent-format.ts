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
import { oneLine, sanitize } from './text.ts'

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