/**
 * Ordered transcript content rendering (text, image and file markers).
 *
 * A message's durable `content` array is the authority for content order. This
 * renderer keeps that order instead of concatenating text and appending chrome:
 * every text run is rendered by its own cached renderer (Markdown for assistant
 * output, width-wrapped plain text for human turns), every image occurrence
 * becomes one compact marker row, and every native file occurrence becomes one
 * read-only metadata row.
 *
 * Markdown instances are reused per text-run slot, so an unchanged run is never
 * re-lexed when another part changes. Image bytes are never touched here, and a
 * file block is never treated as an image or fetched.
 */
import type { DisplayContentPart, FileAttachmentRef, ImageAttachmentRef } from '../backend/types.ts'
import type { TranscriptItem } from '../state/transcript.ts'
import { itemContentParts, legacyImagePlaceholders, imageOccurrenceKey } from './image-data.ts'
import { fileMarkerLine } from './file-marker.ts'
import { imageMarkerLine, type ImageMarkerSpec } from './image-marker.ts'
import { StreamingMarkdown } from './markdown-stream.ts'
import { markdownTheme } from './theme.ts'
import { wrap } from './text.ts'

type TextMode = 'markdown' | 'plain'

interface TextRun {
  readonly kind: 'text'
  readonly text: string
  /** Slot index for the reused renderer. */
  readonly slot: number
}

interface ImageRun {
  readonly kind: 'image'
  readonly attachment: ImageAttachmentRef
  /** 0-based position among the item's real image parts. */
  readonly imageIndex: number
  readonly key: string
}

interface FileRun {
  readonly kind: 'file'
  readonly attachment: FileAttachmentRef
  /** 1-based position among the item's native file parts. */
  readonly fileNumber: number
}

interface PlaceholderRun {
  readonly kind: 'placeholder'
  readonly imageIndex: number
}

type Run = TextRun | ImageRun | FileRun | PlaceholderRun

export interface ContentRenderOptions {
  readonly hoveredKey?: string
  /** Real keyboard action label for inline mode. */
  readonly hint?: string
  readonly fullscreen?: boolean
  readonly interactive: boolean
}

export interface ContentMarkerRow {
  /** 0-based row inside the returned lines. */
  readonly row: number
  readonly key: string
}

export interface ContentBodyResult {
  readonly lines: string[]
  /**
   * Rows rendered as non-text markers (image markers including inert legacy
   * placeholders, and read-only file markers). Rows that already carry their own
   * styling must not be passed through the body's text style.
   */
  readonly markerRows: readonly number[]
  /** Clickable marker rows only (legacy placeholders and files never appear here). */
  readonly markers: readonly ContentMarkerRow[]
}

/** Group consecutive text parts and keep image/file placeholders in item order. */
function buildRuns(item: TranscriptItem): Run[] {
  const runs: Run[] = []
  const parts = itemContentParts(item)
  let text: string[] = []
  let slot = 0
  let imageIndex = 0
  let fileNumber = 0
  const flushText = (): void => {
    if (text.length === 0) return
    runs.push({ kind: 'text', text: text.join('\n\n'), slot: slot++ })
    text = []
  }
  for (const part of parts) {
    if (part.type === 'text') {
      text.push(part.text)
      continue
    }
    flushText()
    if (part.type === 'file') {
      fileNumber += 1
      runs.push({ kind: 'file', attachment: part.attachment, fileNumber })
      continue
    }
    runs.push({
      kind: 'image',
      attachment: part.attachment,
      imageIndex,
      key: imageOccurrenceKey(item.id, imageIndex),
    })
    imageIndex += 1
  }
  flushText()
  const fallbackText = item.kind === 'user' || item.kind === 'assistant' || item.kind === 'attempt' ? item.text : ''
  if (runs.length === 0 && fallbackText.trim() !== '') {
    // Text-only items (including hand-built test projections and legacy
    // summaries) have no `content` array; the joined text is still the body.
    runs.push({ kind: 'text', text: fallbackText, slot: slot++ })
  }
  const placeholders = legacyImagePlaceholders(item)
  for (let index = 0; index < placeholders; index += 1) {
    runs.push({ kind: 'placeholder', imageIndex: imageIndex + index })
  }
  return runs
}

export class ImageContentBody {
  private readonly mode: TextMode
  /**
   * One streaming renderer per text-run slot (markdown mode only).
   *
   * A `Markdown` instance re-lexes the whole source after every `setText`, so a
   * streaming body would pay the full message on every frame. `StreamingMarkdown`
   * keeps a sealed prefix (its rows held strongly) and re-renders only the tail;
   * the rows it returns are byte-identical to a whole-text render.
   */
  private readonly streams: StreamingMarkdown[] = []
  private runs: Run[] = []
  private itemId = ''
  private signature = ''

  constructor(mode: TextMode) {
    this.mode = mode
  }

  /** Re-read the item; reuses text renderers when the run text did not change. */
  setItem(item: TranscriptItem): void {
    const signature = `${item.id}|${item.version}`
    if (signature === this.signature) return
    this.signature = signature
    this.itemId = item.id
    this.runs = buildRuns(item)
  }

  /** True when the item has at least one image/file occurrence (or placeholder). */
  get hasAttachments(): boolean {
    return this.runs.some(run => run.kind !== 'text')
  }

  /**
   * Drop every derived row of this body: the tail renderer's lines **and** the
   * sealed prefix rows plus their renderer.
   *
   * A `Markdown` instance memoizes its rendered lines by `(text, width)`, which
   * is a *different* cache from the owning block's, and the sealed prefix rows
   * are held strongly so a repaint never re-lexes them. Both must go when a
   * theme-level renderer changes behind the body's back — above all the lazily
   * loaded highlight grammar, whose `ready` edge would otherwise leave plain
   * (pre-grammar) rows in a sealed prefix forever.
   *
   * The authored text is kept; only derived state is released, so the next paint
   * is one whole render and re-seals as the message continues.
   */
  invalidate(): void {
    for (const stream of this.streams) stream.invalidate()
  }

  render(width: number, options: ContentRenderOptions): ContentBodyResult {
    const safeWidth = Math.max(1, Math.floor(width))
    const lines: string[] = []
    const markers: ContentMarkerRow[] = []
    const markerRows: number[] = []
    let textSlot = 0

    /**
     * Append one text run below a single blank separator.
     *
     * Adjacent runs are separated by *at most* one empty row: a marker row that
     * is already followed by a blank one (or a run that paints nothing after
     * its edges were trimmed) must not stack a second separator, and the body
     * never ends on a dangling blank row. Marker rows keep their own adjacency
     * — they are already one compact row each.
     */
    const pushText = (text: string): void => {
      const rendered = this.renderText(text, safeWidth, textSlot++)
      // Trim the edges: adjacent image markers provide their own spacing.
      while (rendered.length > 0 && rendered[0]!.trim() === '') rendered.shift()
      while (rendered.length > 0 && rendered[rendered.length - 1]!.trim() === '') rendered.pop()
      if (rendered.length === 0) return
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
      for (const line of rendered) lines.push(line)
    }

    for (const run of this.runs) {
      if (run.kind === 'text') {
        pushText(run.text)
        continue
      }
      if (run.kind === 'file') {
        lines.push(fileMarkerLine(run.fileNumber, run.attachment, safeWidth))
        markerRows.push(lines.length - 1)
        continue
      }
      const spec: ImageMarkerSpec = {
        number: run.imageIndex + 1,
        ...(run.kind === 'image' ? { attachment: run.attachment, key: run.key } : {}),
        ...(options.hint === undefined ? {} : { hint: options.hint }),
        interactive: options.interactive,
        ...(options.fullscreen === undefined ? {} : { fullscreen: options.fullscreen }),
        ...(options.hoveredKey === undefined || run.kind !== 'image' || options.hoveredKey !== run.key
          ? {}
          : { hovered: true }),
      }
      lines.push(imageMarkerLine(spec, safeWidth))
      markerRows.push(lines.length - 1)
      if (run.kind === 'image') markers.push({ row: lines.length - 1, key: run.key })
    }

    return { lines, markerRows, markers }
  }

  private renderText(text: string, width: number, slot: number): string[] {
    // Plain human-turn bodies keep their `wrap()` path: no Markdown, no lexing,
    // no streaming state.
    if (this.mode === 'plain') return wrap(text, width)
    let stream = this.streams[slot]
    if (stream === undefined) {
      stream = new StreamingMarkdown(markdownTheme)
      this.streams[slot] = stream
    }
    return stream.render(text, width)
  }

  /** Diagnostics/tests: the streaming renderer of one text slot. */
  streamAt(slot: number): StreamingMarkdown | undefined {
    return this.streams[slot]
  }
}
