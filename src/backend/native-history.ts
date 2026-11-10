/**
 * Pure validation of the two native history read faces.
 *
 * `ctx.sessionProjections.snapshot(session,['turnOutline'])` serves the
 * whole-log turn outline registered by `@deepseek-ai/dsh-session-turn-outline`;
 * `ctx.sessionQuery.readEvent(request, signal)` serves one full event plus a
 * bounded raw-log context window. DSH owns both folds and every durable fact.
 * This module only proves the native values are the shapes their public types
 * declare and projects them, field by field, into the neutral DTOs. It never
 * reads a log, derives a preview, merges partial rows or invents a window.
 *
 * @module dsh-tui/backend/native-history
 */
import { nativeCursor, nativeSeq } from './native-seq.ts'
import type { HistoryTurnEntry } from './types.ts'

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * One validated `turnOutline` cut.
 *
 * `available:false` is capability absence, an unreadable cut or a corrupt wire
 * value — never "this session has no turns". A native empty outline is
 * `available:true` with no entries.
 */
export interface TurnOutlineCut {
  readonly available: boolean
  readonly asOfSeq?: number
  readonly entries: readonly HistoryTurnEntry[]
}

const UNAVAILABLE_TURNS: TurnOutlineCut = { available: false, entries: [] }

/**
 * Validate one native `ProjectionSnapshot` containing `turnOutline`.
 *
 * The native wire value is the complete entry array, strictly increasing by
 * turn. A malformed row (missing/unsafe `turn`/`seq`, non-string preview, or a
 * non-increasing order) discards the whole cut: a partial outline would claim
 * turns the user cannot page to, so the honest answer is "unavailable".
 *
 * @param snapshot - raw `sessionProjections.snapshot(session,['turnOutline'])`.
 * @returns the validated cut, or the unavailable result.
 */
export function turnOutlineCut(snapshot: unknown): TurnOutlineCut {
  const cut = record(snapshot)
  const values = record(cut?.values)
  if (cut === undefined || values === undefined) return UNAVAILABLE_TURNS
  const rows = values.turnOutline
  if (!Array.isArray(rows)) return UNAVAILABLE_TURNS
  const entries: HistoryTurnEntry[] = []
  // `-1` is below every legal native turn/seq, so the first row only has to be
  // non-negative and the loop proves strict increase from there.
  let previousTurn = -1
  let previousSeq = -1
  for (const row of rows) {
    const entry = record(row)
    if (entry === undefined) return UNAVAILABLE_TURNS
    const turn = nativeSeq(entry.turn)
    const seq = nativeSeq(entry.seq)
    if (turn === undefined || seq === undefined) return UNAVAILABLE_TURNS
    if (typeof entry.prompt !== 'string' || typeof entry.response !== 'string') return UNAVAILABLE_TURNS
    if (turn <= previousTurn || seq <= previousSeq) return UNAVAILABLE_TURNS
    previousTurn = turn
    previousSeq = seq
    entries.push({ turn, seq, prompt: entry.prompt, response: entry.response })
  }
  const asOfSeq = nativeCursor(cut.asOfSeq)
  return {
    available: true,
    ...(asOfSeq === undefined ? {} : { asOfSeq }),
    entries,
  }
}

/** The exact native request one event-window read was made with. */
export interface EventWindowRequest {
  readonly sessionId: string
  readonly seq: number
  readonly before: number
  readonly after: number
}

/**
 * One `before`/`after` pair of raw-event context bounds.
 *
 * Used both for the request the caller asked for and for the request that was
 * actually dispatched after a proven smaller native `readWindowMax` was
 * applied.
 */
export interface EventWindowBounds {
  readonly before: number
  readonly after: number
}

/**
 * The native session-query failure code for a rejected `before`/`after` bound.
 *
 * `@deepseek-ai/dsh-session-query` publishes the effective `readWindowMax`
 * only as configuration input; the service type exposes no getter for the
 * resolved bound, so this closed-taxonomy code plus its exact message is the
 * only public surface that names the accepted maximum.
 */
const INVALID_WINDOW_CODE = 'SESSION_QUERY_INVALID_WINDOW'
/** Longest diagnostic still treated as a bound; anything longer is not one. */
const MAX_WINDOW_LIMIT_MESSAGE_CHARS = 96
/** Exact native grammar: `<before|after> must be an integer between 0 and N`. */
const WINDOW_LIMIT_MESSAGE = /^(?:before|after) must be an integer between 0 and ([0-9]{1,15})$/u

/**
 * Read the proven raw-event maximum from one native window rejection.
 *
 * `SessionQueryEngine._readWindow` rejects with `SessionQueryError`
 * `SESSION_QUERY_INVALID_WINDOW` and the exact message
 * `` `${name} must be an integer between 0 and ${readWindowMax}` `` where
 * `name` is `before` or `after`. Only that code and that whole bounded message
 * are accepted: any other failure, an interpolated/extra suffix, a negative or
 * non-integer value, or a value outside the safe-integer range proves nothing
 * and must fail closed.
 *
 * @param error - the rejection the native read produced.
 * @returns the proven non-negative safe-integer maximum, or undefined.
 */
export function nativeEventWindowLimit(error: unknown): number | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const item = error as { code?: unknown; message?: unknown }
  if (item.code !== INVALID_WINDOW_CODE) return undefined
  const message = item.message
  if (typeof message !== 'string' || message.length > MAX_WINDOW_LIMIT_MESSAGE_CHARS) return undefined
  const matched = WINDOW_LIMIT_MESSAGE.exec(message)
  if (matched === null) return undefined
  const limit = Number(matched[1])
  return Number.isSafeInteger(limit) && limit >= 0 ? limit : undefined
}

/**
 * The single strict narrowing of one request to a proven native maximum.
 *
 * The adapter's own cap (`<= 50`) is a safety bound, never a claim about the
 * mounted runtime. A proven native maximum only ever *narrows* an existing
 * request: it must be a non-negative safe integer that is at most the adapter
 * cap and strictly below at least one requested side. Anything that would
 * widen a side, keep both sides identical or exceed the adapter cap is not an
 * adaptation, so the caller must fail closed instead of retrying.
 *
 * @param limit - proven native maximum, or undefined when nothing was proven.
 * @param request - the bounds about to be dispatched (or already dispatched).
 * @param adapterMax - the adapter's own per-side safety cap.
 * @returns the clamped bounds, or undefined when no safe narrowing exists.
 */
export function clampEventWindow(
  limit: number | undefined,
  request: EventWindowBounds,
  adapterMax: number,
): EventWindowBounds | undefined {
  if (limit === undefined) return undefined
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > adapterMax) return undefined
  if (!Number.isSafeInteger(request.before) || !Number.isSafeInteger(request.after)) return undefined
  if (request.before < 0 || request.after < 0) return undefined
  const before = Math.min(request.before, limit)
  const after = Math.min(request.after, limit)
  if (before === request.before && after === request.after) return undefined
  return { before, after }
}

/** One validated native raw-log window, still holding the native event objects. */
export interface NativeEventWindow {
  readonly inheritedEventCount: number
  readonly startSeq: number
  readonly endSeq: number
  readonly events: readonly unknown[]
}

/** Validation outcome of one `sessionQuery.readEvent` response. */
export type EventWindowValidation =
  | { readonly ok: true; readonly window: NativeEventWindow }
  | { readonly ok: false; readonly reason: string }

function invalid(reason: string): EventWindowValidation {
  return { ok: false, reason }
}

/**
 * Validate one native `SessionEventWindow` against the exact request.
 *
 * Native contract: the target event is included, `startSeq`/`endSeq` bound the
 * included raw events, and `events` is that contiguous slice. Requiring the
 * boundary/count/order self-consistency is what lets the caller claim
 * `hasOlder` from `startSeq > 0` without a second read: a mismatched response
 * is malformed, never an empty corpus.
 *
 * The response must also stay inside the bounds that were *actually*
 * dispatched: `startSeq >= seq - before` and `endSeq <= seq + after`. A wider
 * slice would hand the UI events it never asked for, and after a negotiated
 * narrowing it would hide that the native maximum was not honoured.
 *
 * @param value - raw native response.
 * @param request - the exact request the adapter issued (the dispatched
 *   bounds, which may already be narrowed to a proven native maximum).
 * @returns the validated window or a bounded malformed reason.
 */
export function eventWindowOf(value: unknown, request: EventWindowRequest): EventWindowValidation {
  const item = record(value)
  if (item === undefined) return invalid('the native response is not an object')
  const inheritedEventCount = nativeSeq(item.inheritedEventCount)
  if (inheritedEventCount === undefined) return invalid('inheritedEventCount is not a non-negative safe integer')
  const startSeq = nativeSeq(item.startSeq)
  const endSeq = nativeSeq(item.endSeq)
  if (startSeq === undefined || endSeq === undefined) return invalid('the window bounds are not native event seqs')
  if (startSeq > endSeq) return invalid('the window bounds are reversed')
  if (startSeq < request.seq - request.before) {
    return invalid('the returned window starts before the requested before bound')
  }
  if (endSeq > request.seq + request.after) {
    return invalid('the returned window ends after the requested after bound')
  }
  if (request.seq < startSeq || request.seq > endSeq) return invalid('the target seq is outside the returned window')
  const events = item.events
  if (!Array.isArray(events)) return invalid('the returned events are not an array')
  if (events.length !== endSeq - startSeq + 1) return invalid('the returned event count does not match the window bounds')
  for (let index = 0; index < events.length; index += 1) {
    const event = record(events[index])
    const seq = nativeSeq(event?.seq)
    if (event === undefined || seq === undefined) return invalid('a returned event carries no native seq')
    if (seq !== startSeq + index) return invalid('the returned window is not contiguous')
  }
  return { ok: true, window: { inheritedEventCount, startSeq, endSeq, events } }
}

/**
 * Whether a validated window proves that raw events exist before `startSeq`.
 *
 * `startSeq > 0` is the only proof a single `readEvent` gives; the DTO offers
 * no `hasNewer` claim because this read never proves events after `endSeq`
 * exist (the log may end there).
 *
 * @param window - one validated native window.
 * @returns true only when the native bounds prove older raw events.
 */
export function windowHasOlder(window: NativeEventWindow): boolean {
  return window.startSeq > 0
}