/**
 * Native sequence/count validation shared by the backend read adapters.
 *
 * DSH's own surface and cursor validators accept exactly
 * `Number.isSafeInteger(value) && value >= 0` (and no `-0`) for event seqs, and
 * `-1` for the projection snapshot's empty-log cursor. This module never
 * widens that: a non-finite, fractional, negative or negative-zero value is
 * not a native seq and must never reach a DTO as one.
 *
 * @module dsh-tui/backend/native-seq
 */

/**
 * One non-negative safe native event sequence, or `undefined`.
 *
 * @param value - raw wire value from a native event/response.
 * @returns the exact native seq, or undefined when it is not one.
 */
export function nativeSeq(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
    ? value
    : undefined
}

/**
 * One native projection cursor: a native seq, or `-1` for the empty log.
 *
 * @param value - raw `ProjectionSnapshot.asOfSeq`.
 * @returns the exact cursor, or undefined when it is not one.
 */
export function nativeCursor(value: unknown): number | undefined {
  if (value === -1) return -1
  return nativeSeq(value)
}