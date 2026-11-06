/**
 * ProcessTerminal output ownership (input-owned vendored seam).
 *
 * The native host may temporarily intercept JS `process.stdout`/`process.stderr`
 * so sibling-plugin diagnostics cannot overwrite the editor. Pi's renderer,
 * protocol negotiation, cursor, title and progress writes must still reach the
 * real terminal through an injected writer; restoring terminal modes on a
 * direct exit remains a synchronous renderer-owned fd write.
 *
 * Offline only: no model, backend, credential, user profile or clipboard
 * access. The PTY case runs in a private `script -q` child with temporary
 * HOME/DSH_HOME/config directories and synthetic writes.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Load the vendored source rather than #pi-tui/dist: this is a source-level
// regression test that must not race a package rebuild. App code still uses the
// private #pi-tui seam; final acceptance runs after the vendor dist build. The
// computed URL keeps vendor sources (which target ES2024) out of the app's ES2023
// typecheck graph.
interface WriterTerminal {
  write(data: string): void
  moveBy(lines: number): void
  hideCursor(): void
  showCursor(): void
  clearLine(): void
  clearFromCursor(): void
  clearScreen(): void
  setTitle(title: string): void
  setProgress(active: boolean): void
}
interface WriterScreen {
  addChild(component: { render(width: number): string[]; invalidate(): void }): void
  start(): void
  stop(): void
}
type ProcessTerminalConstructor = new (options?: { write?: (data: string) => void }) => WriterTerminal
type ScreenConstructor = new (terminal: WriterTerminal) => WriterScreen

const terminalModule = (await import(new URL("../vendor/pi-tui/src/terminal.ts", import.meta.url).href)) as {
  ProcessTerminal: ProcessTerminalConstructor
}
const screenModule = (await import(new URL("../vendor/pi-tui/src/tui-main-screen.ts", import.meta.url).href)) as {
  TuiMainScreen: ScreenConstructor
}
const ProcessTerminal = terminalModule.ProcessTerminal
const TuiMainScreen = screenModule.TuiMainScreen

const ROOT = mkdtempSync(join(tmpdir(), "dsh-input-terminal-output-"))
const HOME_DIR = join(ROOT, "home")
const DSH_HOME_DIR = join(ROOT, "dsh-home")
mkdirSync(HOME_DIR, { recursive: true })
mkdirSync(DSH_HOME_DIR, { recursive: true })

test.after(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

/** Count non-overlapping occurrences without regex escaping. */
function count(text: string, needle: string): number {
  return text.split(needle).length - 1
}

/**
 * Intercept JS stdout writes only. `fs.writeSync(process.stdout.fd, ...)` still
 * reaches the terminal/pipe, which is exactly the distinction under test.
 */
function interceptStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = []
  const original = process.stdout.write
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
    return true
  }) as typeof process.stdout.write
  return {
    writes,
    restore: () => {
      process.stdout.write = original
    },
  }
}

test("default ProcessTerminal still writes through process.stdout.write at call time", () => {
  // Hermetic: never let a host PI_TUI_WRITE_LOG path turn this probe into a file write.
  const previousWriteLog = process.env.PI_TUI_WRITE_LOG
  delete process.env.PI_TUI_WRITE_LOG
  // Construct before interception: the default must look up the current stdout
  // writer per call, not capture it at construction.
  const terminal = new ProcessTerminal()
  const captured = interceptStdout()
  try {
    terminal.write("frame")
    terminal.moveBy(2)
    terminal.moveBy(-1)
    terminal.moveBy(0)
    terminal.hideCursor()
    terminal.showCursor()
    terminal.clearLine()
    terminal.clearFromCursor()
    terminal.clearScreen()
    terminal.setTitle("default")
    terminal.setProgress(true)
    terminal.setProgress(false)
  } finally {
    captured.restore()
    if (previousWriteLog === undefined) delete process.env.PI_TUI_WRITE_LOG
    else process.env.PI_TUI_WRITE_LOG = previousWriteLog
  }

  assert.deepEqual(captured.writes, [
    "frame",
    "\x1b[2B",
    "\x1b[1A",
    "\x1b[?25l",
    "\x1b[?25h",
    "\x1b[K",
    "\x1b[J",
    "\x1b[2J\x1b[H",
    "\x1b]0;default\x07",
    "\x1b]9;4;3\x07",
    "\x1b]9;4;0\x07",
  ])
})

test("injected writer receives frame, cursor, clear, title and progress writes; stdout stays untouched", () => {
  const previousWriteLog = process.env.PI_TUI_WRITE_LOG
  delete process.env.PI_TUI_WRITE_LOG
  const captured = interceptStdout()
  const injected: string[] = []
  const options: { write: (data: string) => void } = { write: (data) => injected.push(data) }
  try {
    const terminal = new ProcessTerminal(options)
    terminal.write("frame")
    terminal.moveBy(3)
    terminal.moveBy(-2)
    terminal.moveBy(0)
    terminal.hideCursor()
    terminal.showCursor()
    terminal.clearLine()
    terminal.clearFromCursor()
    terminal.clearScreen()
    terminal.setTitle("injected")
    terminal.setProgress(true)
    terminal.setProgress(false)
  } finally {
    captured.restore()
    if (previousWriteLog === undefined) delete process.env.PI_TUI_WRITE_LOG
    else process.env.PI_TUI_WRITE_LOG = previousWriteLog
  }

  assert.deepEqual(captured.writes, [], "no TUI write falls through to process.stdout.write")
  assert.deepEqual(injected, [
    "frame",
    "\x1b[3B",
    "\x1b[2A",
    "\x1b[?25l",
    "\x1b[?25h",
    "\x1b[K",
    "\x1b[J",
    "\x1b[2J\x1b[H",
    "\x1b]0;injected\x07",
    "\x1b]9;4;3\x07",
    "\x1b]9;4;0\x07",
  ])
})

/** Run an inline ES module in a private PTY, with temp homes and a result file. */
function runInPty(source: string, name: string): { output: string; result: { injected: string[]; leaked: string[] } } {
  const streamPath = join(ROOT, `${name}.stream`)
  const resultPath = join(ROOT, `${name}.json`)
  const args = [process.execPath, "--input-type=module", "-e", source, resultPath]
  const command =
    process.platform === "darwin"
      ? ["-q", streamPath, ...args]
      : ["-q", "-c", args.map((arg) => `'${arg.replaceAll("'", `'\\''`)}'`).join(" "), streamPath]
  const proc = spawnSync("/usr/bin/script", command, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    env: {
      ...process.env,
      HOME: HOME_DIR,
      DSH_HOME: DSH_HOME_DIR,
      XDG_CONFIG_HOME: join(HOME_DIR, ".config"),
      PI_PROGRAM_STATUS: "1",
      PI_TUI_WRITE_LOG: "",
    },
  })
  if (proc.error) {
    throw new Error(`terminal writer PTY test needs a POSIX 'script' (${process.platform}): ${proc.error.message}`)
  }
  const output = readFileSync(streamPath, "utf8")
  assert.equal(proc.status, 0, `PTY child exit status (stream tail: ${output.slice(-400)})`)
  return { output, result: JSON.parse(readFileSync(resultPath, "utf8")) }
}

const PTY_WRITER = `
import { ProcessTerminal } from "./vendor/pi-tui/src/terminal.ts"
import { TuiMainScreen } from "./vendor/pi-tui/src/tui-main-screen.ts"
import { writeFileSync } from "node:fs"

const resultPath = process.argv.at(-1)
const injected = []
const leaked = []
const terminal = new ProcessTerminal({ write: (data) => injected.push(data) })
terminal.setProgramStatus({ state: "working", app: "dsh-tui", message: "synthetic writer probe" })

const tui = new TuiMainScreen(terminal)
tui.addChild({ render: () => ["INJECTED-RENDER-MARKER"], invalidate() {} })

const originalWrite = process.stdout.write
process.stdout.write = ((chunk) => {
  leaked.push(String(chunk))
  return true
})

try {
  tui.start()
  await new Promise((resolve) => setTimeout(resolve, 100))
  terminal.setTitle("Writer Probe")
  terminal.setProgress(true)
  terminal.setProgress(false)
  terminal.setProgramStatus({ state: "idle", app: "dsh-tui", message: "writer probe idle" })
  // A non-Kitty negotiation reply exercises the modifyOtherKeys protocol writes.
  process.stdin.emit("data", "\\x1b[?0u")
  await new Promise((resolve) => setTimeout(resolve, 50))
  tui.stop()

  // Restart without an intervening owner: start/stop lifetime must keep using
  // the same injected writer and never fall back to process.stdout.write.
  tui.start()
  await new Promise((resolve) => setTimeout(resolve, 50))
  tui.stop()

  process.stdout.write("EXPLICIT-STDOUT-LEAK")
  // Emergency restore bypasses the injected writer and uses the real fd.
  terminal.restoreOnExit("\\x1b[?25h", "\\x1b]0;PTY-RESTORE-BYPASS\\x07")
} finally {
  process.stdout.write = originalWrite
  writeFileSync(resultPath, JSON.stringify({ injected, leaked }))
}
`

test("private PTY: injected writer owns startup, protocol, rendering, title, progress, cleanup and restart", () => {
  const { output, result } = runInPty(PTY_WRITER, "writer")
  const injected = result.injected.join("")
  const leaked = result.leaked.join("")

  assert.equal(leaked, "EXPLICIT-STDOUT-LEAK", "only the probe's explicit stdout write bypassed the injected writer")

  assert.match(injected, /\x1b\[\?2004h/, "bracketed-paste enable reaches the injected writer")
  assert.match(injected, /\x1b\[>7u\x1b\[\?u/, "Kitty keyboard protocol query reaches the injected writer")
  assert.match(injected, /\x1b\[c/, "DA1 capability query reaches the injected writer")
  assert.match(injected, /\x1b\]7501;state=working/, "startup program status reaches the injected writer")
  assert.match(injected, /INJECTED-RENDER-MARKER/, "the renderer frame reaches the injected writer")
  assert.match(injected, /\x1b\]0;Writer Probe\x07/, "the window title reaches the injected writer")
  assert.match(injected, /\x1b\]9;4;3\x07/, "progress start reaches the injected writer")
  assert.match(injected, /\x1b\]9;4;0\x07/, "progress clear reaches the injected writer")
  assert.match(injected, /\x1b\[>4;2m/, "modifyOtherKeys enable reaches the injected writer")
  assert.match(injected, /\x1b\[\?25l/, "cursor hide reaches the injected writer")
  assert.match(injected, /\x1b\[\?25h/, "cursor show reaches the injected writer")
  assert.match(injected, /\x1b\[\?2004l/, "bracketed-paste disable reaches the injected writer")
  assert.match(injected, /\x1b\]7501;state=clear/, "program status clear reaches the injected writer")
  assert.match(injected, /\x1b\[<u/, "keyboard-protocol pop reaches the injected writer")
  assert.match(injected, /\x1b\[>4;0m/, "modifyOtherKeys disable reaches the injected writer")

  assert.equal(count(injected, "\x1b[?2004h"), 2, "both starts enable bracketed paste through the writer")
  assert.equal(count(injected, "\x1b[?2004l"), 2, "both stops disable bracketed paste through the writer")

  assert.equal(count(injected, "PTY-RESTORE-BYPASS"), 0, "restoreOnExit bypasses the injected writer")
  assert.ok(output.includes("PTY-RESTORE-BYPASS"), "restoreOnExit writes the real terminal fd synchronously")
})
