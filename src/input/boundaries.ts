/**
 * Grapheme-safe helpers shared by the CC editor glue and its tests.
 * Pi's editor owns the editing state; these helpers only measure text.
 *
 * Word/whitespace boundary math lives in the editor seam
 * (`ccWordBoundary*` / `ccWhitespaceBoundary*`), which reads the same live
 * editor state; a second pure implementation here would be a second source of
 * truth, so this module only carries the grapheme segmentation the input layer
 * needs for atomic markers, vertical columns and jump targets.
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