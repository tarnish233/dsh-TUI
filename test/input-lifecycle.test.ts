/**
 * Terminal lifecycle regressions for the DSH host seam.
 *
 * A native DSH host mounts and unmounts the TUI plugin in-process (Cordis
 * `ctx.effect` disposers, HMR reload) and may call `start()` from more than one
 * place (session startup, suspend/resume, external editor return). Unloading, or
 * restarting, must never leave behind
 *
 *   - a `process.on('exit')` restore hook from a previous instance,
 *   - an extra `stdin` `'data'` or `stdout` `'resize'` listener (double input),
 *   - a render/throttle/cell-size timer that paints after the terminal is gone,
 *   - a terminal in raw mode (failed `start()`, `process.exit()` straight out),
 *   - a disposed editor that still edits text, emits app actions or submits.
 *
 * Two independent layers are checked:
 *
 *   1. In-process, against a recording fake `Terminal` that deliberately keeps
 *      its `input`/`resize` callbacks after `stop()` (a "leaky" host terminal),
 *      to prove the stopped renderer is inert rather than merely detached.
 *   2. In a private PTY (`script -q`, one child process per case) so the real
 *      `ProcessTerminal` stdin attach/detach, raw-mode capture/restore and the
 *      synchronous exit-restore bytes are observed on a terminal this test owns.
 *      The current pane is never touched: the child gets its own PTY, writes its
 *      result to a file, and its escape stream is captured to another file.
 *
 * Offline only: no model, backend, credential or user-configuration access.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"

import {
  resetCapabilitiesCache,
  setCapabilityOverrides,
  TuiAltScreen,
  TuiMainScreen,
  type ProgramStatus,
  type Terminal,
  type TUI,
} from "#pi-tui"

import { asTui, loadInputModule, testEditorTheme } from "../src/input/testing/harness.ts"

// --- recording terminal -------------------------------------------------

type LifecycleRenderer = TuiMainScreen | TuiAltScreen

/**
 * Minimal `Terminal` that records lifecycle calls.
 *
 * `stop()` intentionally keeps `input`/`resize` so the test can invoke stale
 * callbacks afterwards: a host that unloads a plugin may still deliver one more
 * resize or key byte.
 */
class RecordingTerminal implements Terminal {
  readonly frames: string[] = []
  readonly cursor: string[] = []
  readonly restore: Array<{ before: string; after: string }> = []
  startCalls = 0
  stopCalls = 0
  input?: (data: string) => void
  resize?: () => void
  /** Throw from `start()` to exercise the failed-start path. */
  failStart = false

  start(input: (data: string) => void, resize: () => void): void {
    this.startCalls += 1
    if (this.failStart) throw new Error("terminal start failed")
    this.input = input
    this.resize = resize
  }

  stop(): void {
    this.stopCalls += 1
  }

  restoreOnExit(before: string, after: string): void {
    this.restore.push({ before, after })
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.frames.push(data)
  }

  get columns(): number {
    return 80
  }

  get rows(): number {
    return 24
  }

  get kittyProtocolActive(): boolean {
    return false
  }

  moveBy(): void {}
  hideCursor(): void {
    this.cursor.push("hide")
  }
  showCursor(): void {
    this.cursor.push("show")
  }
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(_status: ProgramStatus): void {}
}

function recordingTui(Ctor: typeof TuiMainScreen | typeof TuiAltScreen = TuiMainScreen) {
  const terminal = new RecordingTerminal()
  const tui: LifecycleRenderer = new Ctor(terminal)
  tui.addChild({ render: () => ["ready"], invalidate() {} })
  return { terminal, tui }
}

/** Renderer- and process-level artifacts an unmount must remove. */
function hooks() {
  return {
    exit: process.listenerCount("exit"),
    stdinData: process.stdin.listenerCount("data"),
    stdoutResize: process.stdout.listenerCount("resize"),
    timeouts: process.getActiveResourcesInfo().filter((name) => name === "Timeout").length,
  }
}

/** Let queued `process.nextTick` render requests run. */
async function tick(): Promise<void> {
  await delay(0)
}

// --- renderer start/stop ------------------------------------------------

for (const Ctor of [TuiMainScreen, TuiAltScreen] as const) {
  test(`${Ctor.name}: start/stop leaves no exit, stdin or resize hook behind`, async () => {
    const before = hooks()
    const { terminal, tui } = recordingTui(Ctor)

    tui.start()
    assert.equal(hooks().exit, before.exit + 1, "a running renderer owns exactly one exit restore hook")
    assert.equal(terminal.startCalls, 1)
    assert.deepEqual(terminal.cursor, ["hide"], "the running renderer hides the cursor")

    await tick()
    tui.stop()

    assert.equal(hooks().exit, before.exit, "stop removes the last-resort exit restore hook")
    assert.ok(terminal.cursor.includes("show"), "stop hands the cursor back")
    assert.equal(terminal.stopCalls, 1)
  })

  test(`${Ctor.name}: suspend/resume cycles do not accumulate hooks or timers`, async () => {
    const before = hooks()
    const { terminal, tui } = recordingTui(Ctor)

    for (let cycle = 0; cycle < 3; cycle += 1) {
      tui.start()
      await tick()
      // Ctrl+Z suspend: Pi keeps the screen and restores modes; resume starts again.
      tui.stop({ preserveScreen: true })
      assert.equal(hooks().exit, before.exit, `cycle ${cycle}: the exit hook is not duplicated`)
    }

    tui.start()
    tui.stop()
    await tick()
    assert.deepEqual(hooks(), before, "three suspend/resume cycles plus a final stop return to the baseline")
    assert.equal(terminal.startCalls, 4, "each resume attaches exactly once")
  })

  test(`${Ctor.name}: a stopped renderer ignores stale key and resize callbacks`, async () => {
    const { terminal, tui } = recordingTui(Ctor)
    tui.start()
    await tick()
    terminal.input?.("a")
    terminal.resize?.()
    await tick()

    tui.stop()
    const framesAfterStop = terminal.frames.length
    const timersAfterStop = hooks().timeouts

    // A leaky host terminal still holds the callbacks: they must be inert.
    terminal.input?.("b")
    terminal.input?.("\x1b[200~late paste\x1b[201~")
    terminal.resize?.()
    tui.requestRender()
    await delay(40)

    assert.equal(terminal.frames.length, framesAfterStop, "no frame is painted after stop")
    assert.equal(hooks().timeouts, timersAfterStop, "no render/resize timer survives stop")
  })
}

test("stop before start and repeated stop are inert", async () => {
  const before = hooks()
  const { terminal, tui } = recordingTui()

  tui.stop() // plugin disposed before it ever attached
  tui.stop()
  assert.deepEqual(hooks(), before)
  assert.equal(terminal.startCalls, 0)

  tui.start()
  await tick()
  tui.stop()
  const frames = terminal.frames.length
  tui.stop()
  tui.stop()
  await delay(20)
  assert.deepEqual(hooks(), before, "extra stops never re-register the exit hook")
  assert.equal(terminal.frames.length, frames, "extra stops neither render nor re-enter the terminal")
})

test("the exit restore hook fires once on a direct process.exit and is removed by stop", async () => {
  const { terminal, tui } = recordingTui()
  const baseline = process.listenerCount("exit")
  tui.start()
  await tick()
  assert.equal(process.listenerCount("exit"), baseline + 1, "a running renderer registers exactly one restore hook")

  process.emit("exit", 0)
  assert.equal(terminal.restore.length, 1, "a direct process.exit restores the terminal synchronously")
  assert.match(terminal.restore[0]!.before, /\x1b\[\?25h/, "the restore prefix shows the cursor again")
  assert.equal(process.listenerCount("exit"), baseline + 1, "the hook is installed once, not once per start")

  tui.stop()
  assert.equal(process.listenerCount("exit"), baseline, "stop removes the hook")
  process.emit("exit", 0)
  assert.equal(terminal.restore.length, 1, "a stopped renderer is not restored a second time")
})

test("a failed terminal start keeps the last-resort exit restore instead of stranding raw mode", () => {
  const baseline = process.listenerCount("exit")
  const { terminal, tui } = recordingTui()
  terminal.failStart = true

  assert.throws(() => tui.start(), /terminal start failed/)
  assert.equal(process.listenerCount("exit"), baseline + 1, "the half-started renderer keeps its restore hook")
  process.emit("exit", 1)
  assert.equal(terminal.restore.length, 1, "a start failure still restores on exit")
  tui.stop() // idempotent teardown of the half-started renderer
  assert.equal(process.listenerCount("exit"), baseline, "teardown after the failure removes the hook again")
})

test("an image-capable resize query is debounced and cancelled by stop", async () => {
  setCapabilityOverrides({ images: "kitty" })
  resetCapabilitiesCache()
  try {
    const { terminal, tui } = recordingTui()
    const queries = () => terminal.frames.filter((frame) => frame === "\x1b[16t").length

    tui.start()
    assert.equal(queries(), 1, "start queries the cell size once for an image terminal")

    terminal.resize?.()
    terminal.resize?.()
    terminal.resize?.()
    assert.equal(queries(), 1, "rapid resizes are coalesced by the 150 ms debounce")
    await delay(220)
    assert.equal(queries(), 2, "the debounced resize re-queries once")

    terminal.resize?.()
    tui.stop()
    await delay(220)
    assert.equal(queries(), 2, "stop cancels the pending resize query")
  } finally {
    setCapabilityOverrides({})
    resetCapabilitiesCache()
  }
})

// --- disposed editor ----------------------------------------------------

const mod = await loadInputModule()

test("a disposed CcEditor consumes late terminal input without editing, acting or submitting", async () => {
  const terminal = new RecordingTerminal()
  const tui: TUI = new TuiMainScreen(terminal)
  const editor = new mod.CcEditor(asTui(tui as never), testEditorTheme)
  const actions: string[] = []
  let submits = 0
  editor.onAction = (event) => {
    actions.push(event.id)
  }
  editor.onSubmitContent = () => {
    submits += 1
  }
  tui.addChild(editor)
  tui.setFocus(editor)
  tui.start()

  // Live editor: keys reach it and app actions are emitted.
  terminal.input?.("ab")
  assert.equal(editor.getText(), "ab")
  terminal.input?.("\x18") // Ctrl+X
  terminal.input?.("\x05") // Ctrl+E completes the CC chord
  assert.deepEqual(actions, ["app.editor.external"], "a live editor still dispatches app actions")

  editor.dispose()
  const eventsAfterDispose = actions.length
  const textAfterDispose = editor.getText()

  // Bytes already in flight while the host tears down must change nothing.
  terminal.input?.("cd")
  terminal.input?.("\x1b[200~pasted\x1b[201~")
  terminal.input?.("\x18\x05")
  terminal.input?.("\r")
  editor.flushInputBuffer()

  assert.equal(editor.getText(), textAfterDispose, "late input does not edit a disposed editor")
  assert.equal(actions.length, eventsAfterDispose, "late input does not emit app actions")
  assert.equal(submits, 0, "late Enter does not submit after disposal")
  assert.equal(hooks().timeouts, 0, "dispose left no chord timer behind")

  tui.stop()
  editor.dispose() // idempotent
})

// --- private PTY --------------------------------------------------------

const PTY_DIR = mkdtempSync(join(tmpdir(), "dsh-input-lifecycle-"))

/** Run `args` in a private PTY and return the child's exit code and output stream. */
function runInPty(
  args: readonly string[],
  name: string,
  expectedStatus = 0,
): { status: number | null; output: string } {
  const capture = join(PTY_DIR, `${name}.stream`)
  const command =
    process.platform === "darwin"
      ? ["-q", capture, ...args]
      : ["-q", "-c", args.map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`).join(" "), capture]
  const result = spawnSync("/usr/bin/script", command, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  })
  if (result.error) {
    throw new Error(`PTY lifecycle test needs a POSIX 'script' (${process.platform}): ${result.error.message}`)
  }
  const output = readFileSync(capture, "utf8")
  assert.equal(result.status, expectedStatus, `PTY child exit status (stream tail: ${output.slice(-400)})`)
  return { status: result.status, output }
}

/** Run an inline ES module in a PTY child and return only its captured escape stream. */
function runInPtySource(source: string, name: string, expectedStatus = 0): { status: number | null; output: string } {
  return runInPty([process.execPath, "--input-type=module", "-e", source], name, expectedStatus)
}

/** Run an inline ES module in a PTY child; the child must write its result JSON to its last argv. */
function runInPtyModule(
  source: string,
  name: string,
  expectedStatus = 0,
): { status: number | null; output: string; result: unknown } {
  const resultPath = join(PTY_DIR, `${name}.json`)
  const { status, output } = runInPty(
    [process.execPath, "--input-type=module", "-e", source, resultPath],
    name,
    expectedStatus,
  )
  return { status, output, result: JSON.parse(readFileSync(resultPath, "utf8")) }
}

const PTY_CYCLES = `
import { ProcessTerminal, TuiMainScreen } from "#pi-tui"
import { writeFileSync } from "node:fs"

const snap = () => ({
  isRaw: process.stdin.isRaw === true,
  stdinData: process.stdin.listenerCount("data"),
  stdoutResize: process.stdout.listenerCount("resize"),
  exit: process.listenerCount("exit"),
})

const steps = { base: snap(), liveKeys: 0, lateKeys: 0, visited: [] }
const terminal = new ProcessTerminal()
const tui = new TuiMainScreen(terminal)
tui.addChild({ render: () => ["pty lifecycle"], invalidate() {} })
let live = 0
let late = 0
tui.addInputListener((data) => {
  // The PTY also delivers a synthetic EOT byte when its input side is closed;
  // only the explicitly emitted bytes count as a dispatch.
  if (data === "x") live += 1
  if (data === "y") late += 1
})

tui.start()
steps.visited.push(["start", snap()])
// A second start without a stop must not add a second stdin wiring or
// re-capture wasRaw while the terminal is already raw.
tui.start()
steps.visited.push(["start-again", snap()])
tui.start()
steps.visited.push(["start-third", snap()])

process.stdin.emit("data", "x")
await new Promise((resolve) => setTimeout(resolve, 30))
steps.liveKeys = live

tui.stop()
steps.visited.push(["stop", snap()])
tui.stop()
tui.stop()
steps.visited.push(["stop-repeated", snap()])

for (let cycle = 0; cycle < 3; cycle += 1) {
  tui.start()
  tui.stop()
}
steps.visited.push(["three-cycles", snap()])

process.stdin.emit("data", "y")
await new Promise((resolve) => setTimeout(resolve, 30))
steps.lateKeys = late
steps.visited.push(["final", snap()])

writeFileSync(process.argv.at(-1), JSON.stringify(steps))
`

test("real PTY: repeated start/stop cycles restore raw mode and keep one input wiring", () => {
  const { result } = runInPtyModule(PTY_CYCLES, "cycles")
  const run = result as {
    base: { isRaw: boolean; stdinData: number; stdoutResize: number; exit: number }
    liveKeys: number
    lateKeys: number
    visited: Array<[string, { isRaw: boolean; stdinData: number; stdoutResize: number; exit: number }]>
  }
  const at = (label: string) => {
    const step = run.visited.find(([name]) => name === label)
    assert.ok(step, `step ${label} was recorded`)
    return step[1]
  }

  assert.deepEqual(run.base, { isRaw: false, stdinData: 0, stdoutResize: 0, exit: 0 }, "clean PTY baseline")

  const started = at("start")
  assert.equal(started.isRaw, true, "start puts the real terminal in raw mode")
  assert.equal(started.stdinData, run.base.stdinData + 1, "start attaches one stdin listener")
  assert.equal(started.stdoutResize, run.base.stdoutResize + 1, "start attaches one resize listener")
  assert.equal(started.exit, run.base.exit + 1, "start attaches one exit restore hook")

  for (const label of ["start-again", "start-third"]) {
    const repeated = at(label)
    assert.deepEqual(
      repeated,
      started,
      `${label}: a repeated start is idempotent (no second stdin/resize wiring, one exit hook)`,
    )
  }
  assert.equal(run.liveKeys, 1, "one key byte is dispatched exactly once after repeated starts")

  for (const label of ["stop", "stop-repeated", "three-cycles", "final"]) {
    assert.deepEqual(at(label), run.base, `${label}: the terminal is fully detached and no longer raw`)
  }
  assert.equal(run.lateKeys, 0, "input arriving after stop is not dispatched")
})

const PTY_FATAL_EXIT = `
import { ProcessTerminal, TuiAltScreen } from "#pi-tui"

const tui = new TuiAltScreen(new ProcessTerminal())
tui.addChild({ render: () => ["fatal exit"], invalidate() {} })
tui.start()
process.stdout.write("PRE-EXIT")
// No stop(): the synchronous exit restore hook must hand the terminal back.
process.exit(3)
`

test("real PTY: a direct process.exit restores bracketed paste, keyboard protocol and the alt screen", () => {
  const { status, output } = runInPtySource(PTY_FATAL_EXIT, "fatal", 3)
  assert.equal(status, 3, "the child's own exit code is preserved")
  const marker = output.indexOf("PRE-EXIT")
  assert.ok(marker >= 0, "the child reached the fatal exit")

  const restore = output.slice(marker)
  assert.ok(restore.includes("\x1b[?2004l"), "bracketed paste is disabled on the fatal path")
  assert.ok(restore.includes("\x1b[<u"), "the Kitty keyboard protocol is popped on the fatal path")
  assert.ok(restore.includes("\x1b[?25h"), "the cursor is shown again on the fatal path")
  assert.ok(restore.includes("\x1b[?1049l"), "the alternate screen is left on the fatal path")
})

// --- packaging boundary -------------------------------------------------

test("the seam installs onto the same vendored module identity the app imports", async () => {
  const pkg = await import("#pi-tui")
  const keybindings = await import("#pi-tui/keybindings")
  const killRing = await import("#pi-tui/kill-ring")
  const undoStack = await import("#pi-tui/undo-stack")
  const wordNavigation = await import("#pi-tui/word-navigation")
  const utils = await import("#pi-tui/utils")

  // One module graph: a dist subpath and the package entry must resolve to the
  // same module instance, or `instanceof`/prototype patches would split in two.
  assert.equal(keybindings.getKeybindings, pkg.getKeybindings, "#pi-tui/keybindings is the package entry's module")
  assert.equal(typeof killRing.KillRing, "function", "#pi-tui/kill-ring resolves the vendored class")
  assert.equal(typeof undoStack.UndoStack, "function", "#pi-tui/undo-stack resolves the vendored class")
  assert.equal(typeof wordNavigation.findWordBackward, "function")
  assert.equal(typeof wordNavigation.findWordForward, "function")
  assert.equal(typeof utils.isWhitespaceChar, "function")

  // The seam patches the public Editor class; the app's own import sees it.
  assert.equal(typeof pkg.Editor.prototype.ccCaptureSnapshot, "function", "the seam is installed on the imported Editor")

  const terminal = new RecordingTerminal()
  const tui = new TuiMainScreen(terminal)
  const editor = new mod.CcEditor(asTui(tui as never), testEditorTheme)
  assert.ok(editor instanceof pkg.Editor, "CcEditor extends the same vendored Editor class")
  assert.equal(
    Object.getPrototypeOf(Object.getPrototypeOf(editor)),
    pkg.Editor.prototype,
    "the prototype chain ends at the imported Editor class, not a second copy",
  )
  tui.stop()
})

test("the seam does not import vendor sources outside the built package", () => {
  const source = readFileSync(new URL("../src/input/pi-tui-seam.js", import.meta.url), "utf8")
  const specifiers = [...source.matchAll(/^import\s[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1])
  assert.ok(specifiers.length > 0, "the seam has runtime imports")
  for (const specifier of specifiers) {
    assert.ok(
      specifier === "#pi-tui" || specifier.startsWith("#pi-tui/"),
      `seam import '${specifier}' must use the #pi-tui package-import seam`,
    )
  }
})

test.after(() => {
  rmSync(PTY_DIR, { recursive: true, force: true })
})