/**
 * Reusable mouse hitbox layer for transcript-style components.
 *
 * One abstraction for every clickable/hoverable region rendered as plain
 * lines: a component keeps a `HitboxRegistry`, re-declares its hitboxes after
 * every render (`sync`), and forwards pi-tui mouse events to
 * `handleMouse` from its own `Component.handleMouse`. Thinking summaries,
 * tool cards, links and future affordances all consume this layer — no
 * feature may grow its own private SGR/mouse parsing or dispatch.
 *
 * The layer is deliberately dumb: it knows rows, columns and pi-tui event
 * semantics, nothing about thinking, tools or themes. Styling a hover hint is
 * the owning component's business; this module only reports enter/exit.
 *
 * Coordinate space: component-local, 0-based. TuiAltScreen dispatches with
 * `x`/`y` already translated to the receiving component's box origin, so a
 * registry used directly inside one component needs no further translation.
 * A parent that hosts multiple child blocks re-bases `y` before delegating;
 * see {@link dispatchToChild} for keeping that target attached to the child.
 */
import type { Component, TuiMouseEvent, TuiMouseEventResult } from '#pi-tui'

/** A clickable/hoverable region in component-local row/column space. */
export interface MouseHitbox {
  /** Stable id for this region. Hover enter/exit is diffed by id across syncs. */
  readonly id: string
  /** 0-based component-local row of the first line (inclusive). */
  readonly startRow: number
  /** 0-based component-local row of the last line (inclusive). */
  readonly endRow: number
  /** 0-based column where the region starts (inclusive). Omitted = full width. */
  readonly startCol?: number
  /** 0-based column where the region ends (inclusive). Omitted = full width. */
  readonly endCol?: number
  /** Left-click handler. Called on the pi-tui `click` event type only. */
  readonly onClick?: (hit: MouseHit) => void
  /** Hover transition handler; `true` = pointer entered, `false` = left. */
  readonly onHover?: (entering: boolean) => void
  /**
   * Whether a left press over this region is claimed from the native renderer
   * (default `true`).
   *
   * `true` — claim the press. TuiAltScreen then remembers this component as the
   * press target and delivers `release` plus the synthesized `click` back, which
   * lets the registry pin the click to the pressed region even when a repaint
   * moved its rows in between. Use it for small controls (summary rows, links,
   * chips) where a click must never degrade into a text selection.
   *
   * `false` — click-only. `press`, `move` and `drag` are passed through
   * untouched, so the native renderer keeps text selection, drag-to-select and
   * copy-on-select working; an undragged press still produces a native
   * synthesized `click` (vendored `TuiAltScreen.handleSelectionMouseEvent`),
   * which this registry consumes. Use it for large regions (an expanded
   * reasoning body) where selecting the text must stay possible while a plain
   * click still collapses the block.
   */
  readonly claimPress?: boolean
}

/** Normalized click information handed to `onClick`. */
export interface MouseHit {
  /** Component-local row of the click. */
  readonly row: number
  /** Component-local column of the click. */
  readonly col: number
  /** pi-tui click count (1, 2, 3 …) for single/double/triple detection. */
  readonly clickCount: number
  /** Decoded button name. */
  readonly button: string
  readonly shift: boolean
  readonly alt: boolean
  readonly ctrl: boolean
}

/** Hover transitions between two syncs or mouse moves. */
export interface MouseHoverChanges {
  readonly entered: MouseHitbox | undefined
  readonly exited: MouseHitbox | undefined
}

/**
 * Hitbox bookkeeping and pi-tui event dispatch for one component.
 *
 * Dispatch contract (see vendor/pi-tui/src/tui-alt-screen.ts):
 * - `press` over a claiming hitbox returns a handled result without side effects
 *   and pins the region; TuiAltScreen registers the press target and later
 *   synthesizes the `click` on release for components that handled the press.
 * - `press` over a `claimPress: false` hitbox (and every `move`/`drag` there)
 *   returns `undefined`, so the native renderer keeps selection and drag. Its
 *   synthesized `click` still resolves against every hitbox (see below).
 * - `click` runs `onClick` and returns a handled result with `render: true`.
 *   A click whose coordinates match a claimed press runs the *pressed* region
 *   even when the newest frame moved it, because pi-tui synthesizes the click
 *   after the release and re-resolves it against whatever frame is current.
 *   The pin is dropped by `click`, a new press, `drag`, `sync` losing the id and
 *   `clear`; `release` deliberately keeps it (it precedes the synthesized click).
 * - `move`/`drag` update hover state; enter/exit fire `onHover` and force a
 *   render only when the hovered hitbox actually changed. Motion that is
 *   neither over a hitbox nor leaving one returns `undefined`, so the pointer
 *   stays invisible to this component until it touches something.
 * - Events outside every hitbox return `undefined` so text selection,
 *   scrollbar drags and wheel routing keep working untouched.
 * - Only the left button is claimed; right-click paste, middle clicks and
 *   modifier-driven selection keep their native behavior.
 * - Overlapping hitboxes resolve to the first declared match, so a component
 *   lists specific regions before any full-width fallback.
 */
export class HitboxRegistry {
  private boxes: readonly MouseHitbox[] = []
  private hovered: MouseHitbox | undefined
  /**
   * Region claimed by the last left press plus the press coordinates.
   * pi-tui keeps the press point for the synthesized click but resolves it
   * against the newest frame, so a repaint between press and release would
   * otherwise deliver the click to whatever row happens to be under the pointer
   * by then (streaming, live-timer and hover repaints all do this).
   */
  private pinned: { box: MouseHitbox; x: number; y: number } | undefined

  /**
   * Replace the hitboxes for the frame that was just rendered. Returns the
   * hover transition implied by the new layout (an id that vanished counts
   * as an exit; `onHover` callbacks are NOT run by sync itself).
   *
   * A surviving id keeps the hover only while its rect is unchanged; the same
   * id moving to a different rect is reported as exit-then-enter. Newly
   * appearing ids never produce an enter: without pointer motion there was no
   * transition to report.
   */
  sync(hitboxes: readonly MouseHitbox[]): MouseHoverChanges {
    this.boxes = [...hitboxes]
    const pinned = this.pinned
    if (pinned !== undefined) {
      // A region that no longer exists cannot receive its own click: dropping
      // the pin keeps a vanished affordance (e.g. hidden reasoning) inert.
      const next = this.boxes.find((box) => box.id === pinned.box.id)
      this.pinned = next === undefined ? undefined : { box: next, x: pinned.x, y: pinned.y }
    }
    const previous = this.hovered
    if (!previous) return { entered: undefined, exited: undefined }
    const next = this.boxes.find((box) => box.id === previous.id)
    if (!next) {
      this.hovered = undefined
      return { entered: undefined, exited: previous }
    }
    // Refresh the reference so handlers from the newest frame win.
    this.hovered = next
    if (sameRect(previous, next)) return { entered: undefined, exited: undefined }
    return { entered: next, exited: previous }
  }

  /** pi-tui `Component.handleMouse` adapter. See the class doc for semantics. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    switch (event.type) {
      case 'press':
        return this.handlePress(event)
      case 'click':
        return this.handleClick(event)
      case 'move':
      case 'drag':
        return this.handleMotion(event)
      default:
        // `release` (click synthesis) and `wheel` (scroll routing) belong to
        // TuiAltScreen; the registry stays out of both.
        return undefined
    }
  }

  /**
   * Claim a left press over a press-claiming hitbox so TuiAltScreen registers
   * this component as the press target; the synthesized `click` then comes back
   * here. The claimed region is pinned for that click.
   */
  private handlePress(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Any new press starts a new gesture: the previous pin is stale by then.
    this.pinned = undefined
    if (event.button !== 'left') return undefined
    const box = this.claimableAt(event.y, event.x)
    if (!box) return undefined
    this.pinned = { box, x: event.x, y: event.y }
    return { handled: true }
  }

  private handleClick(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== 'left') return undefined
    const pinned = this.pinned
    this.pinned = undefined
    // The claimed press wins over the newest frame: pi-tui guarantees the
    // synthesized click carries the press coordinates, so the region the user
    // pressed is the region that runs even after its rows moved.
    const pinnedBox =
      pinned !== undefined && pinned.x === event.x && pinned.y === event.y
        ? this.boxes.find((entry) => entry.id === pinned.box.id)
        : undefined
    const box = pinnedBox ?? this.hitAt(event.y, event.x)
    if (!box) return undefined
    box.onClick?.({
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

  private handleMotion(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // Moving while pressed means the native renderer suppresses the click.
    if (event.type === 'drag') this.pinned = undefined
    // Click-only regions own no hover: the pointer keeps its text behavior there.
    const box = this.claimableAt(event.y, event.x)
    const previous = this.hovered
    if (box?.id === previous?.id) {
      // Refresh the reference so handlers from the newest frame win.
      this.hovered = box
      // Still over the same region (or still over nothing) — nothing changed.
      return box ? { handled: true } : undefined
    }
    this.hovered = box
    previous?.onHover?.(false)
    box?.onHover?.(true)
    // An exit callback can request its owner's repaint, but must not consume
    // the first native drag over a click-only region after hovering a control.
    if (this.hitAt(event.y, event.x)?.claimPress === false) return undefined
    return { handled: true, render: true }
  }

  /** First hitbox (declaration order) containing the cell, if any. */
  private hitAt(row: number, col: number): MouseHitbox | undefined {
    return this.boxes.find((box) => contains(box, row, col))
  }

  /** First resolved hitbox, only when it claims the press (see `claimPress`). */
  private claimableAt(row: number, col: number): MouseHitbox | undefined {
    const box = this.hitAt(row, col)
    // Declaration order still wins: a specific click-only region must not be
    // overridden by a later broad press-claiming fallback.
    return box?.claimPress === false ? undefined : box
  }

  /** The hitbox currently under the pointer, if any. */
  hoverTarget(): MouseHitbox | undefined {
    return this.hovered
  }

  /** Drop frame, hover and press state (non-interactive frame / teardown). */
  clear(): void {
    this.boxes = []
    this.hovered = undefined
    this.pinned = undefined
  }
}

/**
 * The synthetic `move` that means "the pointer is no longer over you".
 *
 * It is deliberately a plain motion outside every declarable rect (rows and
 * columns are 0-based, so `-1` can never be inside a hitbox) and never a
 * `press`/`click`/`drag`: a receiving registry reports the hover exit through
 * `onHover(false)` and keeps its pressed row, drag and native selection state
 * exactly as they were. Nothing is parsed and no paint happens here.
 */
export function hoverExitEvent(base: TuiMouseEvent): TuiMouseEvent {
  return {
    ...base,
    type: 'move',
    button: 'none',
    x: -1,
    y: -1,
    screenX: -1,
    screenY: -1,
    ...(base.wheelDelta === undefined ? {} : { wheelDelta: undefined }),
    ...(base.clickCount === undefined ? {} : { clickCount: undefined }),
  }
}

/**
 * Is this the synthetic out-of-rect leave handed to a previous hover owner?
 *
 * Hosts use it to tell "the pointer left the host" (only release local hover)
 * apart from "the pointer moved to a different target here" (adopt the new one).
 */
export function isHoverExit(event: TuiMouseEvent): boolean {
  return event.type === 'move' && (event.x < 0 || event.y < 0)
}

/**
 * One ephemeral hover owner per visible pointer target.
 *
 * A host that routes each pointer event to *one* child at a time (the
 * transcript to its row span, a group to the child that painted the row) can
 * only forward motion to the child currently under the pointer. A
 * `HitboxRegistry` — or `SubagentLinkHitboxes` — can therefore only learn about
 * a hover exit it is told about: the child the pointer just left would keep its
 * `hovered` id forever and paint a blue "click to expand" hint on a historical
 * card that nobody is pointing at.
 *
 * This helper keeps that single owner and, whenever the pointer's target
 * changes, asks the previous owner to drop its hover with
 * {@link hoverExitEvent}. A target is a component plus the host-defined
 * placement slot it was painted at (`row` of its first line, `header`, …): the
 * same child re-based by a repaint is a *different* target, so a scroll/stream
 * that moved the hitbox away cannot leave the hint painted where the pointer
 * no longer is.
 *
 * It never claims or routes an event and never touches a press pin, a drag, a
 * selection, a disclosure, focus or cached lines: a hover callback in the owner
 * requests its own repaint, exactly as it does for a real exit.
 */
export interface HoverSlot {
  /** Component that paints the target (a child block, or the host itself). */
  readonly component: Component
  /** Host-local placement of the target; a re-based target is a new target. */
  readonly slot: string
}

/** Placement token of a target painted from `row` downward. */
export function hoverRowSlot(row: number): string {
  return `row ${row}`
}

/**
 * The hover target for a host control that is painted on exactly one row.
 *
 * A group may only claim the pointer for itself on the row its control is
 * really painted on (row 0, the header). Every other row of a collapsed group
 * is plain member text that advertises no hover, and a synthetic leave adopts
 * nothing: adopting the header for those rows would claim a target the pointer
 * is not on and would hand the previous owner an exit it never caused.
 */
export function hoverControlAt(
  event: TuiMouseEvent,
  component: Component,
  row: number,
  slot: string,
): HoverSlot | undefined {
  if (isHoverExit(event) || event.y !== row) return undefined
  return { component, slot }
}

export class HoverOwnership {
  private owner: HoverSlot | undefined
  /** Last real motion, reused to shape the synthetic exit (coordinates are ignored). */
  private base: TuiMouseEvent | undefined

  /** The component that currently believes the pointer is inside it, if any. */
  get current(): Component | undefined {
    return this.owner?.component
  }

  /** Placement of the current owner inside its host (`header`, `row 7`, …). */
  get placement(): string | undefined {
    return this.owner?.slot
  }

  /**
   * Point motion at `next` (a child, `this` for the host's own controls, or
   * `undefined` for a gap). Any different previous owner is released first.
   */
  moveTo(next: HoverSlot | undefined, event: TuiMouseEvent): void {
    this.base = event
    const previous = this.owner
    if (previous?.component === next?.component && previous?.slot === next?.slot) return
    // Clear the owner *before* releasing it: the release is delivered as a
    // nested `handleMouse`, and a host that forwards it to its own ownership
    // (a group re-entering this helper for the synthetic leave) would otherwise
    // see — and drop — the target that is being adopted right now.
    this.owner = undefined
    if (previous !== undefined) this.leave(previous.component)
    this.owner = next
  }

  /** The pointer left the host (gap, wheel scroll, overlay, teardown). */
  release(event?: TuiMouseEvent): void {
    if (event !== undefined) this.base = event
    const previous = this.owner
    this.owner = undefined
    if (previous !== undefined) this.leave(previous.component)
  }

  /**
   * Drop the hover when the freshly composed frame no longer paints the owner
   * at the slot it was entered in — the owner left the frame, or the repaint
   * re-based its rows away from the stationary pointer.
   */
  retain(slots: Iterable<HoverSlot>): void {
    const owner = this.owner
    if (owner === undefined) return
    for (const slot of slots) {
      if (slot.component === owner.component && slot.slot === owner.slot) return
    }
    this.release()
  }

  private leave(component: Component): void {
    const base = this.base
    if (base === undefined || typeof component.handleMouse !== 'function') return
    // The result is intentionally dropped: the owner's `onHover(false)` asks for
    // its own repaint, while the real event still routes to the new target.
    component.handleMouse(hoverExitEvent(base))
  }
}

/** Does the cell fall inside the hitbox rect? */
function contains(box: MouseHitbox, row: number, col: number): boolean {
  return (
    row >= box.startRow &&
    row <= box.endRow &&
    (box.startCol === undefined || col >= box.startCol) &&
    (box.endCol === undefined || col <= box.endCol)
  )
}

/** Same region in the same place? Hover identity requires id AND rect. */
function sameRect(a: MouseHitbox, b: MouseHitbox): boolean {
  return a.startRow === b.startRow && a.endRow === b.endRow && a.startCol === b.startCol && a.endCol === b.endCol
}

/** Host-side dispatch metadata: the real child plus its screen origin. */
export interface MouseDispatchTarget {
  readonly component: Component
  readonly originX: number
  readonly originY: number
  readonly width: number
  readonly height: number
}

/**
 * A child result that keeps the child as the mouse target.
 *
 * pi-tui's matching helpers (`dispatchMouseEvent`, `TuiMouseDispatchTarget`) are
 * internal to the vendored package, so a host that renders sibling blocks
 * reproduces the same shape here: the renderer then addresses the *child* for
 * the rest of the gesture (`originY` is captured at press time), so `release`
 * and the synthesized `click` keep the press-time local row instead of a row
 * re-derived from a possibly scrolled frame.
 */
export interface MouseDispatchResult extends TuiMouseEventResult {
  readonly handled: true
  readonly target: MouseDispatchTarget
}

/**
 * Dispatch to a child component and retain the coordinate transform, exactly
 * like pi-tui's `Container` does. Returns `undefined` when the child is not
 * interested, leaving selection, scrollbar and wheel routing to the renderer.
 */
export function dispatchToChild(component: Component, event: TuiMouseEvent): MouseDispatchResult | undefined {
  const result = component.handleMouse?.(event)
  if (!result) return undefined
  if ('target' in result) return result as MouseDispatchResult
  if (!result.handled && !result.capture && !result.focus) return undefined
  return {
    ...result,
    handled: true,
    target: {
      component,
      originX: event.screenX - event.x,
      originY: event.screenY - event.y,
      width: event.width,
      height: event.height,
    },
  }
}
