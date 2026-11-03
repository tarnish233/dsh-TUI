/**
 * Grapheme-safe helpers shared by the CC editor glue and its tests.
 * Pi's editor owns the editing state; these helpers only measure text.
 */

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

export interface GraphemeSlice {
  segment: string
  /** UTF-16 index into the source string. */
  index: number
}

/** Segment text into grapheme clusters with UTF-16 indices. */
export function graphemes(text: string): GraphemeSlice[] {
  return [...graphemeSegmenter.segment(text)].map((entry) => ({
    segment: entry.segment,
    index: entry.index,
  }))
}

/** Grapheme ending exactly at `index`, if any. */
export function graphemeBefore(text: string, index: number): GraphemeSlice | undefined {
  let previous: GraphemeSlice | undefined
  for (const grapheme of graphemes(text)) {
    if (grapheme.index >= index) break
    previous = grapheme
  }
  return previous && previous.index + previous.segment.length === index ? previous : undefined
}

/** Grapheme starting at `index`, if any. */
export function graphemeAfter(text: string, index: number): GraphemeSlice | undefined {
  for (const grapheme of graphemes(text)) {
    if (grapheme.index === index) return grapheme
    if (grapheme.index > index) return undefined
  }
  return undefined
}

/** True when the character at `index` is Unicode whitespace. */
export function isWhitespaceAt(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false
  return /^\s$/u.test(text[index] ?? "")
}

/**
 * Start of the whitespace-delimited token before `cursor` (CC Ctrl+W).
 * Trailing whitespace is part of the killed range.
 */
export function whitespaceBoundaryBackward(text: string, cursor: number): number {
  let index = Math.max(0, Math.min(cursor, text.length))
  while (index > 0 && isWhitespaceAt(text, index - 1)) index -= 1
  while (index > 0 && !isWhitespaceAt(text, index - 1)) index -= 1
  return index
}

/** End of the whitespace-delimited token after `cursor`. */
export function whitespaceBoundaryForward(text: string, cursor: number): number {
  let index = Math.max(0, Math.min(cursor, text.length))
  while (index < text.length && isWhitespaceAt(text, index)) index += 1
  while (index < text.length && !isWhitespaceAt(text, index)) index += 1
  return index
}