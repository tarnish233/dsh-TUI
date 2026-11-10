/**
 * Compact, turn-level changed-files card.
 *
 * DSH attaches `WorkspaceChangesSummary` to one **live** session event. The
 * store projects that native summary into a `WorkspaceChangesTranscriptItem`
 * only while the event still carries it, so this card is never fabricated for a
 * resumed transcript and never inferred from tool results or prose.
 *
 * The card prints only native facts: the announcing turn, the native file
 * count, the native `added`/`deleted` totals and one row per native file with
 * its display label, line counts and honest `binary`/`oversized` notes. No
 * path is resolved, no cwd is read, no file bytes are opened and no git state,
 * snapshot id or host path is exposed. The per-file action is a narrow parent
 * callback: the card itself never reads a diff.
 *
 * Rows keep the native `files` order and index exactly: the element index is
 * what the native diff service is asked for, so the card never re-orders,
 * filters or re-labels a row. A whitespace-only native `display` is quoted
 * instead of painted blank (see `workspaceDisplayLabel`).
 *
 * Mouse keys and hitboxes are the shared transcript layer (`HitboxRegistry`);
 * the card owns no input parser and writes no stdout.
 */
import type { TuiMouseEvent, TuiMouseEventResult } from '#pi-tui'
import type { WorkspaceChangeFile, WorkspaceChangesSummary } from '../backend/types.ts'
import type { TranscriptItem, WorkspaceChangesTranscriptItem } from '../state/transcript.ts'
import type { ItemBlock, TranscriptViewOptions } from './blocks.ts'
import { HitboxRegistry, type MouseHitbox } from './mouse.ts'
import { countCacheKeyBuild } from './render-counters.ts'
import { fit, oneLine, plural, sanitize, truncateToWidth, visibleWidth } from './text.ts'
import { bold, dim, t, underline, type Style } from './theme.ts'

/** Parent-facing request for one native file-diff surface. */
export interface WorkspaceChangesDetailsRequest {
  /**
   * Exact native session the card was observed in. The parent must refuse the
   * request when this is not the conversation the card/load belongs to.
   */
  readonly sessionId: string
  /** Exact process attachment identity captured with the card, when known. */
  readonly attachmentId?: string
  /**
   * Durable position of the **latest** live event that announced this turn's
   * summary. This is the position the native diff read must use.
   */
  readonly seq: number
  readonly turn: number
  readonly files: readonly WorkspaceChangeFile[]
  /** Native total file count; may exceed `files.length` for a bounded read. */
  readonly total: number
  readonly added: number
  readonly deleted: number
  /**
   * Native file row that was activated (index into the unchanged native
   * `files` array). Absent when the card header was used, so the parent may
   * open the list instead of a specific file.
   */
  readonly index?: number
}

const DOT = '⏺'
const ELBOW = '  ⎿  '
const INDENT = '     '

/** Link paint of a clickable file/header label (brand blue, underline on hover). */
function workspaceLinkStyle(hovered: boolean): Style {
  return hovered
    ? text => underline(bold(t.accentBright(text)))
    : text => underline(bold(t.accent(text)))
}

/** Honest one-line state of a native file row: `binary`/`oversized` beat counts. */
export function workspaceFileNotes(file: WorkspaceChangeFile): string {
  const notes: string[] = []
  if (file.binary === true) notes.push('binary')
  if (file.oversized === true) notes.push('oversized')
  return notes.join(' · ')
}

/**
 * Native file-count wording. `total` is authoritative; when the bounded row
 * list is shorter the header says so instead of pretending the rows are all.
 */
export function workspaceFileCountLabel(summary: Pick<WorkspaceChangesSummary, 'files' | 'total'>): string {
  if (summary.total === summary.files.length) return plural(summary.files.length, 'file')
  return `${summary.files.length} of ${plural(summary.total, 'file')}`
}

/**
 * Visible label of one native `display` string.
 *
 * DSH may legitimately report a whitespace-only display (`write './ '` creates
 * a single space file). A blank row would look like a missing file and makes
 * the native index unreadable, so such a label is quoted with its real content
 * instead. The label is sanitized and flattened first: no escape sequence, tab
 * or newline from a provider-controlled string can add a row or shift counts.
 */
export function workspaceDisplayLabel(display: string): string {
  const flat = oneLine(sanitize(display), Number.MAX_SAFE_INTEGER)
  if (flat !== '') return flat
  const raw = sanitize(typeof display === 'string' ? display : '')
    .replace(/\r\n/g, ' ')
    .replace(/[\r\n]/g, ' ')
  // Single quotes make the invisible identity readable without resolving or
  // normalizing it; an embedded quote/backslash is escaped, never dropped.
  return `'${raw.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** Plain (unstyled) per-file suffix shared by the card and the details dialog. */
export function workspaceFileSuffix(file: WorkspaceChangeFile): string {
  const notes = workspaceFileNotes(file)
  if (notes !== '') return notes
  return `+${file.added} -${file.deleted}`
}

/** Style a file suffix with the same semantic roles as the diff cards. */
export function workspaceFileSuffixStyle(file: WorkspaceChangeFile): string {
  const notes = workspaceFileNotes(file)
  if (notes !== '') return t.subtle(notes)
  return `${t.greenBright(`+${file.added}`)} ${t.redSoft(`-${file.deleted}`)}`
}

/** Header facts (native turn, count, totals) as plain text. */
export function workspaceSummaryFacts(summary: Pick<WorkspaceChangesSummary, 'turn' | 'files' | 'total' | 'added' | 'deleted'>): string {
  return `turn ${summary.turn} · ${workspaceFileCountLabel(summary)} · +${summary.added} -${summary.deleted}`
}

interface WorkspaceCache {
  readonly width: number
  readonly key: string
  readonly lines: string[]
}

/**
 * The one cached block for a live workspace summary.
 *
 * The fast path returns the exact previously painted lines array while width,
 * item version, handler availability and hover are unchanged, so row spans and
 * hitboxes stay valid. Every other paint-affecting input (handler/hint changes
 * arrive through `TranscriptView.paintSignature`, hover and updates through
 * `invalidate`) drops the cache first.
 */
export class WorkspaceChangesBlock implements ItemBlock {
  readonly itemId: string
  readonly kind = 'workspace-changes' as const
  version: number
  paintRevision = 0
  private item: WorkspaceChangesTranscriptItem
  private readonly flags: TranscriptViewOptions
  private hovered: number | 'header' | undefined
  private boxes: MouseHitbox[] = []
  private readonly registry = new HitboxRegistry()
  /** Native target lifetime, separate from hover/cache invalidations. */
  private pointerGeneration = 0
  private pressedPointerGeneration: number | undefined
  private cache: WorkspaceCache | undefined

  constructor(item: WorkspaceChangesTranscriptItem, flags: TranscriptViewOptions) {
    this.itemId = item.id
    this.version = item.version
    this.item = item
    this.flags = flags
  }

  update(item: TranscriptItem): void {
    if (item.kind !== 'workspace-changes' || item.version === this.version) return
    // The turn card id is stable, but the announcing seq and each file's native
    // identity are not. A press on the old summary must not be rebound to a new
    // file/snapshot when the next paint reuses this block and its hitbox ids.
    this.clearMouse()
    this.item = item
    this.version = item.version
    this.invalidate()
  }

  invalidate(): void {
    this.paintRevision += 1
    this.cache = undefined
  }

  /** Diagnostics/tests: hitboxes of the last paint. */
  hitboxes(): readonly MouseHitbox[] {
    return this.boxes
  }

  private get handler(): ((request: WorkspaceChangesDetailsRequest) => void) | undefined {
    return this.flags.onWorkspaceChangesDetails
  }

  private linkable(): boolean {
    return this.handler !== undefined
  }

  private request(index?: number): WorkspaceChangesDetailsRequest {
    return {
      sessionId: this.item.sessionId,
      ...(this.item.attachmentId === undefined ? {} : { attachmentId: this.item.attachmentId }),
      seq: this.item.seq,
      turn: this.item.turn,
      files: this.item.files,
      total: this.item.total,
      added: this.item.added,
      deleted: this.item.deleted,
      ...(index === undefined ? {} : { index }),
    }
  }

  private hover(target: number | 'header', entering: boolean): void {
    const next = entering ? target : this.hovered === target ? undefined : this.hovered
    if (next === this.hovered) return
    this.hovered = next
    // Hover is a cache-key input but not an item version: drop the fast path so
    // the link can never repaint from the previous frame.
    this.invalidate()
    this.flags.onRenderRequest?.()
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === 'click' && event.button === 'left') {
      const pressed = this.pressedPointerGeneration
      this.pressedPointerGeneration = undefined
      // HitboxRegistry can resolve an unpinned click against the latest frame.
      // Retaining this lifetime witness prevents a retired claimed press from
      // becoming such a fresh click after this stable turn block is repainted.
      if (pressed !== undefined && pressed !== this.pointerGeneration) return { handled: true, render: false }
    } else if (event.type === 'press' || event.type === 'drag') {
      this.pressedPointerGeneration = undefined
    }
    const result = this.registry.handleMouse(event)
    if (event.type === 'press' && event.button === 'left' && result?.handled === true) {
      this.pressedPointerGeneration = this.pointerGeneration
    }
    return result
  }

  clearMouse(): void {
    this.pointerGeneration += 1
    this.hovered = undefined
    this.boxes = []
    this.registry.clear()
  }

  private syncMouse(): void {
    if (this.boxes.length === 0) {
      if (this.pressedPointerGeneration !== undefined) this.pointerGeneration += 1
      this.registry.clear()
    } else this.registry.sync(this.boxes)
  }

  private cacheKey(): string {
    return `${this.version}|${this.handler === undefined ? 'inert' : 'open'}|${this.flags.workspaceChangesDetailsHint ?? ''}|${this.hovered ?? ''}`
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, Math.floor(width))
    const key = this.cacheKey()
    const cache = this.cache
    if (cache !== undefined && cache.width === safeWidth && cache.key === key) return cache.lines
    countCacheKeyBuild()
    const lines = this.build(safeWidth).map(line => fit(line, safeWidth))
    this.cache = { width: safeWidth, key, lines }
    this.syncMouse()
    return lines
  }

  private build(width: number): string[] {
    const item = this.item
    const linkable = this.linkable()
    const headerStyle = linkable && this.hovered === 'header'
    const label = headerStyle ? workspaceLinkStyle(true)('Workspace changes') : bold(t.text('Workspace changes'))
    const facts = [
      t.muted(`turn ${item.turn}`),
      t.muted(workspaceFileCountLabel(item)),
      t.greenBright(`+${item.added}`),
      t.redSoft(`-${item.deleted}`),
    ].join(dim(' · '))
    let header = `${t.muted(DOT)} ${label} ${dim('·')} ${facts}`
    const hint = this.flags.workspaceChangesDetailsHint?.trim() ?? ''
    if (hint !== '') {
      const withHint = `${header} ${dim('·')} ${t.subtle(hint)}`
      if (visibleWidth(withHint) <= width) header = withHint
    }
    const lines: string[] = [header]
    const boxes: MouseHitbox[] = []
    if (linkable) {
      boxes.push({
        id: `${this.itemId}:header`,
        startRow: 0,
        endRow: 0,
        claimPress: true,
        onClick: () => this.handler?.(this.request()),
        onHover: entering => this.hover('header', entering),
      })
    }
    item.files.forEach((file, index) => {
      const lead = index === 0 ? ELBOW : INDENT
      const suffixPlain = workspaceFileSuffix(file)
      const suffixWidth = visibleWidth(suffixPlain)
      const gap = '  '
      const room = width - visibleWidth(lead) - suffixWidth - visibleWidth(gap)
      // The label is sanitized and flattened before any width math: a hostile
      // native display string can never add a row or shift the counts. A
      // whitespace-only native label stays visible as a quoted one.
      const display = workspaceDisplayLabel(file.display)
      const hovered = linkable && this.hovered === index
      if (room < 4) {
        // Extremely narrow terminal: keep the identity readable and degrade the
        // counts rather than printing a clipped, ambiguous `+…`.
        const shown = truncateToWidth(display, Math.max(1, width - visibleWidth(lead)), '…')
        lines.push(`${dim(lead)}${hovered ? workspaceLinkStyle(true)(shown) : t.text(shown)}`)
        return
      }
      const shown = truncateToWidth(display, room, '…')
      const styled = hovered ? workspaceLinkStyle(true)(shown) : t.text(shown)
      lines.push(`${dim(lead)}${styled}${gap}${workspaceFileSuffixStyle(file)}`)
      if (linkable) {
        const row = lines.length - 1
        boxes.push({
          id: `${this.itemId}:file:${index}`,
          startRow: row,
          endRow: row,
          claimPress: true,
          onClick: () => this.handler?.(this.request(index)),
          onHover: entering => this.hover(index, entering),
        })
      }
    })
    this.boxes = boxes
    return lines
  }
}