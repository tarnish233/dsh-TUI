/**
 * Kitty image rendering state on cleared screens (input-owned vendored fix).
 *
 * Ghostty 1.4.x and Rex (ImageStorage.clearScreen) are allowed to recycle Kitty
 * image data that has no placement left once the screen is cleared. The
 * fullscreen renderer used to keep its `uploadedKittyImages` cache across a
 * full redraw, so after `a=d,d=a` + CSI 2J it re-placed images with placement
 * only commands (`a=p`) whose bytes no longer existed in terminal memory.
 *
 * These tests drive the real renderer with a recording terminal and assert the
 * emitted ANSI sequences, never a real tty or clipboard.
 */

import test, { afterEach } from "node:test"
import assert from "node:assert/strict"

import {
  getCellDimensions,
  renderImage,
  resetCapabilitiesCache,
  setCapabilities,
  setCellDimensions,
  TuiAltScreen,
  type ProgramStatus,
  type Terminal,
  type TerminalCapabilities,
} from "#pi-tui"

/** Recording terminal: keeps every write so the test can inspect raw ANSI. */
class RecordingTerminal implements Terminal {
  writes: string[] = []
  private inputHandler?: (data: string) => void
  private resizeHandler?: () => void
  cols = 40
  height = 6
  stopped = false

  start(input: (data: string) => void, onResize: () => void): void {
    this.inputHandler = input
    this.resizeHandler = onResize
    this.stopped = false
  }
  stop(): void {
    this.stopped = true
  }
  async drainInput(): Promise<void> {}
  write(data: string): void {
    this.writes.push(data)
  }
  get columns(): number {
    return this.cols
  }
  get rows(): number {
    return this.height
  }
  get kittyProtocolActive(): boolean {
    return false
  }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(_status: ProgramStatus): void {}

  /** Simulate a terminal resize, including Pi's resize callback. */
  resize(cols: number, rows: number): void {
    this.cols = cols
    this.height = rows
    this.resizeHandler?.()
  }

  /** Feed bytes back as terminal input (query responses). */
  feed(data: string): void {
    this.inputHandler?.(data)
  }

  /** Return everything written since the last call. */
  take(): string {
    const output = this.writes.join("")
    this.writes = []
    return output
  }
}

/** Minimal component whose lines the test controls. */
class Document {
  lines: string[]
  constructor(lines: string[]) {
    this.lines = lines
  }
  render(_width: number): string[] {
    return this.lines
  }
  invalidate(): void {}
}

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
]).toString("base64")

const KITTY_CAPABILITIES: TerminalCapabilities = { images: "kitty", trueColor: true, hyperlinks: false }
const DEFAULT_CELL_DIMENSIONS = { widthPx: 9, heightPx: 18 }

/** Renderers that are still running; released after every test, including failed ones. */
const runningTuis = new Set<TuiAltScreen>()

/**
 * Capabilities are process-global in the vendored renderer and fall back to
 * environment detection (`TERM_PROGRAM`, `COLORTERM`, ...) while the cache is
 * empty. These tests inject the capability they exercise so that neither image
 * sequence creation nor frame rendering depends on the developer's terminal.
 */
function useKittyCapabilities(): void {
  setCapabilities({ ...KITTY_CAPABILITIES })
}

function kittyLine(imageId: number, widthPx = 32, heightPx = 16): string {
  // Set before renderImage(): detection is only consulted when no capability is cached.
  useKittyCapabilities()
  const rendered = renderImage(PNG_HEADER, { widthPx, heightPx }, { maxWidthCells: 8, imageId })
  assert.ok(rendered, "kitty image sequence expected")
  return rendered.sequence
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** True when the frame re-transmits image data (`a=T`), not just placements (`a=p`). */
function transmitsImages(output: string): boolean {
  return output.includes("a=T")
}

function placementOnly(output: string): boolean {
  return output.includes("a=p") && !output.includes("a=T")
}

/** Mount a renderer with whatever capabilities the caller already set. */
function mountTui(lines: string[]) {
  const terminal = new RecordingTerminal()
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false })
  const doc = new Document(lines)
  tui.addChild(doc as unknown as Parameters<typeof tui.addChild>[0])
  tui.start()
  terminal.take() // alt-screen entry, not part of a frame
  runningTuis.add(tui)
  return { terminal, tui, doc }
}

function setup(lines: string[]) {
  useKittyCapabilities()
  return mountTui(lines)
}

function cleanup(tui: TuiAltScreen): void {
  runningTuis.delete(tui)
  tui.stop({ preserveScreen: true })
  resetCapabilitiesCache()
}

// Deterministic teardown: a failing assertion must not leave a renderer, an
// injected Kitty capability or test cell geometry behind for the next test.
afterEach(() => {
  try {
    for (const tui of runningTuis) tui.stop({ preserveScreen: true })
  } finally {
    runningTuis.clear()
    resetCapabilitiesCache()
    setCellDimensions({ ...DEFAULT_CELL_DIMENSIONS })
  }
})

test("force redraw re-transmits kitty images after the screen clear", () => {
  const image = kittyLine(7)
  const { terminal, tui } = setup([image, "a", "b", "c", "d", "e"])

  tui.renderNow()
  const first = terminal.take()
  assert.ok(transmitsImages(first), "first frame transmits the image")
  assert.ok(first.includes("\x1b[2J"), "first frame is a full redraw")

  tui.renderNow()
  const idle = terminal.take()
  assert.ok(!idle.includes("a=T") && !idle.includes("a=p"), "an unchanged frame has no image work")
  assert.ok(!idle.includes("\x1b[2J"), "an unchanged frame does not clear")

  // Ctrl+L / any forced redraw: the clear must be followed by a real upload.
  tui.renderNow(true)
  const forced = terminal.take()
  assert.ok(forced.includes("\x1b[2J"), "forced redraw clears the screen")
  assert.ok(transmitsImages(forced), "images are re-uploaded after the clear")
  assert.ok(!placementOnly(forced), "no placement-only command for reclaimed bytes")
  assert.ok(forced.includes("d=A"), "cleared frames free image data as well as placements")

  cleanup(tui)
})

test("height-only resize re-transmits kitty images", () => {
  const image = kittyLine(7)
  const { terminal, tui, doc } = setup([image, "a", "b", "c", "d", "e"])
  tui.renderNow()
  terminal.take()

  doc.lines = [image, "a", "b", "c", "d", "e", "f"]
  terminal.height = 7
  tui.renderNow()
  const resized = terminal.take()
  assert.ok(resized.includes("\x1b[2J"), "a height change forces a full redraw")
  assert.ok(transmitsImages(resized), "the image is uploaded again for the new screen")

  cleanup(tui)
})

test("ordinary moves keep the placement-only optimisation and never clear", () => {
  const image = kittyLine(7)
  const { terminal, tui, doc } = setup([image, "a", "b", "c", "d", "e"])
  tui.renderNow()
  terminal.take()

  // Same screen size, image anchor moves: a partial redraw that must reuse the
  // bytes already in terminal memory instead of re-sending them.
  doc.lines = ["a", image, "b", "c", "d", "e"]
  tui.renderNow()
  const moved = terminal.take()
  assert.ok(!moved.includes("\x1b[2J"), "a partial redraw does not clear the screen")
  assert.ok(moved.includes("d=a"), "only placements are deleted")
  assert.ok(placementOnly(moved), "the cached image is re-placed, not re-uploaded")
  assert.equal(count(moved, "a=p"), 1)

  cleanup(tui)
})

test("deleting and re-adding the same image reuses the cached bytes", () => {
  const image = kittyLine(7)
  const { terminal, tui, doc } = setup([image, "a", "b", "c", "d", "e"])
  tui.renderNow()
  terminal.take()

  doc.lines = ["a", "b", "c", "d", "e", "f"]
  tui.renderNow()
  const removed = terminal.take()
  assert.ok(!removed.includes("a=T"), "removing an image transmits nothing")
  assert.ok(!removed.includes("\x1b[2J"), "removing an image is not a full redraw")

  doc.lines = ["a", "b", "c", "d", "e", image]
  tui.renderNow()
  const readded = terminal.take()
  assert.ok(placementOnly(readded), "unchanged bytes are placed again, not uploaded")
  assert.equal(count(readded, "a=p"), 1)

  cleanup(tui)
})

test("replacing image bytes re-transmits, duplicate occurrences place once", () => {
  const image = kittyLine(7)
  const { terminal, tui, doc } = setup([image, "a", "b", "c", "d", "e"])
  tui.renderNow()
  terminal.take()

  // New bytes for the same image id bump the transmission generation on render.
  const replacement = kittyLine(7, 40, 24)
  doc.lines = ["a", "b", "c", "d", "e", replacement]
  tui.renderNow()
  const replaced = terminal.take()
  assert.ok(transmitsImages(replaced), "new bytes for the same image id are uploaded")
  assert.ok(!replaced.includes("\x1b[2J"), "the replacement is a partial redraw")

  // The same attachment rendered twice: one transmission, then a placement.
  const other = kittyLine(8, 48, 32)
  doc.lines = [other, other, "a", "b", "c", "d"]
  tui.renderNow()
  const duplicate = terminal.take()
  assert.equal(count(duplicate, "a=T"), 1, "the duplicate occurrence reuses the upload")
  assert.equal(count(duplicate, "a=p"), 1, "the duplicate occurrence is placed")

  cleanup(tui)
})

test("a cleared frame followed by the image returning re-uploads the bytes", () => {
  const image = kittyLine(7)
  const { terminal, tui, doc } = setup([image, "a", "b", "c", "d", "e"])
  tui.renderNow()
  terminal.take()

  // Text-only document + forced redraw: the cache must not survive the clear.
  doc.lines = ["a", "b", "c", "d", "e", "f"]
  tui.renderNow(true)
  assert.ok(!terminal.take().includes("a=T"), "text-only frame has no image work")

  doc.lines = ["a", "b", "c", "d", "e", image]
  tui.renderNow()
  const back = terminal.take()
  assert.ok(transmitsImages(back), "the image is uploaded again after the clear")
  assert.ok(!back.includes("\x1b[2J"), "the returning image itself is a partial redraw")

  cleanup(tui)
})

test("resize re-queries cell size through the renderer's own input path", async () => {
  const image = kittyLine(7)
  const { terminal, tui } = setup([image, "a", "b", "c", "d", "e"])
  tui.renderNow()
  terminal.take()
  assert.ok(!terminal.take().includes("\x1b[16t"), "no cell-size query per frame")

  setCellDimensions({ widthPx: 9, heightPx: 18 })
  terminal.resize(50, 12)
  await new Promise((resolve) => setTimeout(resolve, 250))
  const query = terminal.take()
  assert.ok(query.includes("\x1b[16t"), "a resize re-queries the cell size")
  assert.ok(query.includes("\x1b[2J"), "the resize also redraws")

  // The answer is consumed by the existing terminal input path.
  terminal.feed("\x1b[6;40;20t")
  assert.deepEqual(getCellDimensions(), { widthPx: 20, heightPx: 40 })

  cleanup(tui)
})

test("no cell-size query when the terminal has no image support", async () => {
  // Explicit degradation: no image protocol, so no cell-size query.
  setCapabilities({ images: null, trueColor: true, hyperlinks: false })
  const { terminal, tui } = mountTui(["a", "b", "c", "d", "e", "f"])

  terminal.resize(50, 12)
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.ok(!terminal.take().includes("\x1b[16t"), "images are the only consumer of cell size")

  cleanup(tui)
})

test("stopping the TUI cancels a pending cell-size query", async () => {
  const image = kittyLine(7)
  const { terminal, tui } = setup([image, "a", "b", "c", "d", "e"])
  tui.renderNow()
  terminal.take()

  terminal.resize(50, 12)
  tui.stop({ preserveScreen: true })
  terminal.take()
  await new Promise((resolve) => setTimeout(resolve, 250))
  assert.ok(!terminal.take().includes("\x1b[16t"), "no write after stop")
  resetCapabilitiesCache()
})