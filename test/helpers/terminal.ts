import xterm from '@xterm/headless'
import type { ProgramStatus, Terminal } from '#pi-tui'
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
  /** Capability intent is injectable; xterm itself is not evidence of OSC 7501 support. */
  programStatusSupported = false
  /** Independent OSC 7501 record semantics for parent-owned App acceptance. */
  readonly statusReports: ProgramStatus[] = []
  readonly statusRecords = new Map<string, ProgramStatus>()

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
  setProgramStatus(status: ProgramStatus): void {
    this.statusReports.push({ ...status })
    const id = status.id ?? ''
    if (status.state === 'clear') {
      if (id === '') this.statusRecords.clear()
      else for (const key of this.statusRecords.keys()) if (key === id || key.startsWith(id + '/')) this.statusRecords.delete(key)
    } else this.statusRecords.set(id, { ...status })
    if (id === '') this.status = { ...status }
  }

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

/** Read only the actual modal cell rectangle, excluding the frozen composer behind it. */
export function modalScreen(terminal: VirtualTerminal, title: string): string {
  const buffer = terminal.xterm.buffer.active
  const rows = terminal.rows, cols = terminal.columns
  for (let y = 0; y < rows; y++) {
    const line = buffer.getLine(buffer.viewportY + y)
    if (!line?.translateToString(true).includes('┌─ ' + title)) continue
    let left = -1, right = -1
    for (let x = 0; x < cols; x++) {
      const chars = line.getCell(x)?.getChars()
      if (chars === '┌' && left < 0) left = x
      if (chars === '┐' && left >= 0) { right = x; break }
    }
    if (left < 0 || right < 0) continue
    const content: string[] = []
    for (let row = y; row < rows; row++) {
      const current = buffer.getLine(buffer.viewportY + row)
      content.push(current?.translateToString(true, left, right + 1) ?? '')
      if (row > y && current?.getCell(left)?.getChars() === '└' && current.getCell(right)?.getChars() === '┘') return content.join('\n')
    }
    throw new Error('Modal bottom border was clipped: ' + title)
  }
  throw new Error('Modal is not visible: ' + title)
}

export { delay }
