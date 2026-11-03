import xterm from '@xterm/headless'
import type { ProgramStatus, Terminal } from '@earendil-works/pi-tui'
import { setTimeout as delay } from 'node:timers/promises'

/** Independent ANSI emulator for integration tests, not a substitute for PTY tests. */
export class VirtualTerminal implements Terminal {
  readonly xterm: InstanceType<typeof xterm.Terminal>
  readonly writes: string[] = []
  private input?: (data: string) => void
  private changed?: () => void
  private cols: number
  private height: number
  stopped = false
  title = ''
  progress = false
  status?: ProgramStatus

  constructor(cols = 100, rows = 32) {
    this.cols = cols
    this.height = rows
    this.xterm = new xterm.Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true, logLevel: 'off' })
    this.xterm.onData(data => this.input?.(data))
  }

  start(input: (data: string) => void, changed: () => void): void { this.input = input; this.changed = changed; this.stopped = false }
  stop(): void { this.input = undefined; this.changed = undefined; this.stopped = true }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.writes.push(data); this.xterm.write(data) }
  get columns(): number { return this.cols }
  get rows(): number { return this.height }
  get kittyProtocolActive(): boolean { return false }
  moveBy(lines: number): void { if (lines) this.write('\x1b[' + Math.abs(lines) + (lines > 0 ? 'B' : 'A')) }
  hideCursor(): void { this.write('\x1b[?25l') }
  showCursor(): void { this.write('\x1b[?25h') }
  clearLine(): void { this.write('\x1b[K') }
  clearFromCursor(): void { this.write('\x1b[J') }
  clearScreen(): void { this.write('\x1b[2J\x1b[H') }
  setTitle(title: string): void { this.title = title }
  setProgress(progress: boolean): void { this.progress = progress }
  setProgramStatus(status: ProgramStatus): void { this.status = status }

  type(data: string): void {
    if (data.startsWith('\x1b') || data.length === 1) this.input?.(data)
    else for (const char of data) this.input?.(char)
  }

  resize(cols: number, rows: number): void {
    this.cols = cols; this.height = rows
    this.xterm.resize(cols, rows)
    this.changed?.()
  }

  flush(): Promise<void> { return new Promise(resolve => this.xterm.write('', resolve)) }

  screen(): string {
    const buffer = this.xterm.buffer.active
    return Array.from({ length: this.height }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '').join('\n')
  }

  document(): string {
    const buffer = this.xterm.buffer.active
    return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? '').join('\n')
  }

  dispose(): void { this.xterm.dispose() }
}

export async function until(condition: () => boolean, label: string, timeout = 5000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out: ' + label)
    await delay(10)
  }
}

export { delay }
