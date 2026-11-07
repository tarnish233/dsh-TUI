/**
 * Name-link gesture handling for the transcript's subagent surfaces.
 *
 * The generic {@link HitboxRegistry} resolves a synthesized click against the
 * *current* frame when no region was claimed: after an unclaimed (selection)
 * press, a later repaint that grows a label — or a native catalog frame that
 * finally resolves a durable sender id into a real child name — would put a link
 * under the press coordinates and turn a selection gesture into navigation.
 * It also retargets a click when a claimed region simply vanished before the
 * release.
 *
 * `SubagentLinkHitboxes` is the narrow feature helper for exactly one concern:
 * an internal **child-name link** list inside one transcript block or group.
 * It is deliberately not a change to `HitboxRegistry`, so Tools/Thinking keep
 * their established click-only and selection semantics.
 *
 * Rules (the same gesture discipline the above-editor `SubagentProgress` uses):
 * - only a left press on a *visible* link region claims the gesture; any other
 *   press is remembered as an outside press and returns unhandled, leaving text
 *   selection, drag-to-select and copy-on-select entirely native;
 * - move/drag are never claimed: hover only updates local paint state, and a
 *   drag that started in plain text is not stolen by crossing a link;
 * - a click is accepted only for the claimed region, unchanged identity, same
 *   press coordinates, no drag and no invalidation — it is never re-derived from
 *   the newest frame's coordinates;
 * - a claimed region that disappears for any frame voids the gesture permanently,
 *   even if the same region id returns before the release;
 * - an ordinary repaint keeps a claimed press pinned (a row that updates in
 *   place still opens its child); `clear()` (eviction, session replacement,
 *   dispose) drops everything.
 *
 * No timer, no stdout, no focus and no keyboard behavior live here.
 */
import type { TuiMouseEvent, TuiMouseEventResult } from '#pi-tui'
import type { MouseHit, MouseHitbox } from './mouse.ts'

function contains(box: MouseHitbox, row: number, col: number): boolean {
  return (
    row >= box.startRow &&
    row <= box.endRow &&
    (box.startCol === undefined || col >= box.startCol) &&
    (box.endCol === undefined || col <= box.endCol)
  )
}

export class SubagentLinkHitboxes {
  private boxes: readonly MouseHitbox[] = []
  private hovered: MouseHitbox | undefined
  /** Region claimed by the last left press plus its press coordinates. */
  private pressed: { box: MouseHitbox; x: number; y: number } | undefined
  /**
   * The press began outside every link. A later synthesized click must never
   * resolve a name that a repaint (label growth, catalog arrival, resize) moved
   * under those coordinates.
   */
  private pressOutside = false
  /** A drag was observed: the gesture can never become a navigation jump. */
  private dragged = false
  /** The claimed region vanished, or the frame was invalidated. */
  private voided = false

  /** Id of the link the pointer is currently inside, if any (hover paint state). */
  get hoveredId(): string | undefined {
    return this.hovered?.id
  }

  /** True between a claimed press and its synthesized click (diagnostics/tests). */
  get pressPending(): boolean {
    return this.pressed !== undefined
  }

  /**
   * Replace this frame's links.
   *
   * A claimed region that is no longer present permanently voids the gesture; a
   * surviving region keeps the pin (its rect may have moved with a reflow).
   * Hover is dropped when the region disappears and moved when its rect changes,
   * without running the hover callback from inside a render.
   */
  sync(boxes: readonly MouseHitbox[]): void {
    this.boxes = [...boxes]
    const pressed = this.pressed
    if (pressed !== undefined) {
      const next = this.boxes.find(box => box.id === pressed.box.id)
      if (next === undefined) this.voided = true
      else pressed.box = next
    }
    const hovered = this.hovered
    if (hovered !== undefined) {
      this.hovered = this.boxes.find(box => box.id === hovered.id)
    }
  }

  /** Drop frame, hover and press state (block/group eviction or teardown). */
  clear(): void {
    this.boxes = []
    this.hovered = undefined
    this.resetGesture()
  }

  /** pi-tui `Component.handleMouse` adapter. Motion is never claimed. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    switch (event.type) {
      case 'press': return this.handlePress(event)
      case 'click': return this.handleClick(event)
      case 'move':
      case 'drag': {
        if (event.type === 'drag') {
          // The renderer suppresses the click after a drag; keep no stale pin.
          this.dragged = true
          this.pressed = undefined
        }
        this.trackHover(event)
        // Never claim motion: native selection and drag stay untouched.
        return undefined
      }
      default:
        // `release` and `wheel` belong to the renderer.
        return undefined
    }
  }

  private handlePress(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // A real new press always starts a new gesture.
    this.resetGesture()
    if (event.button !== 'left') return undefined
    const box = this.claimableAt(event.y, event.x)
    if (box === undefined) {
      // Outside every link: claim nothing so the renderer keeps the press for
      // text selection, and remember it so its release stays unhandled too.
      this.pressOutside = true
      return undefined
    }
    this.pressed = { box, x: event.x, y: event.y }
    return { handled: true }
  }

  private handleClick(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== 'left') return undefined
    const pressed = this.pressed
    const current = pressed === undefined ? undefined : this.boxes.find(box => box.id === pressed.box.id)
    const outside = this.pressOutside
    const dragged = this.dragged
    const voided = this.voided
    this.resetGesture()
    // No claimed press (including a press that began outside every link) belongs
    // to the renderer: report it unhandled so selection/copy is untouched.
    if (pressed === undefined || outside) return undefined
    // A drag is never a click jump, and a vanished/invalidated region or moved
    // press coordinates must not resolve whatever now sits under the pointer.
    if (dragged || voided || current === undefined || pressed.x !== event.x || pressed.y !== event.y) {
      return { handled: true }
    }
    current.onClick?.({
      row: event.y,
      col: event.x,
      clickCount: event.clickCount ?? 1,
      button: event.button,
      shift: event.shift,
      alt: event.alt,
      ctrl: event.ctrl,
    })
    return { handled: true, render: true }
  }

  private trackHover(event: TuiMouseEvent): void {
    const box = this.claimableAt(event.y, event.x)
    if (box?.id === this.hovered?.id) {
      // Still over the same link (or still over nothing): nothing changed.
      this.hovered = box
      return
    }
    const previous = this.hovered
    this.hovered = box
    previous?.onHover?.(false)
    box?.onHover?.(true)
  }

  /** First press-claiming link under a cell (declaration order wins). */
  private claimableAt(row: number, col: number): MouseHitbox | undefined {
    return this.boxes.find(box => box.claimPress !== false && contains(box, row, col))
  }

  private resetGesture(): void {
    this.pressed = undefined
    this.pressOutside = false
    this.dragged = false
    this.voided = false
  }
}

/** Hit shape handed to a link's `onClick` (same fields as the shared registry). */
export type SubagentLinkHit = MouseHit