/** Offline PTY acceptance helper: replay stdin ANSI into an independent VT. */
import xterm from '@xterm/headless'

const columns = Number(process.argv[2])
const rows = Number(process.argv[3])
if (!Number.isSafeInteger(columns) || columns <= 0 || !Number.isSafeInteger(rows) || rows <= 0) {
  throw new Error('Usage: node scripts/ansi-screen.ts <columns> <rows> < capture.ansi')
}
const terminal = new xterm.Terminal({ cols: columns, rows, scrollback: 10000, allowProposedApi: true, logLevel: 'off' })
try {
  const chunks: Uint8Array[] = []
  for await (const chunk of process.stdin) {
    if (!(chunk instanceof Uint8Array)) throw new Error('Expected binary stdin')
    chunks.push(chunk)
  }
  await new Promise<void>(resolve => terminal.write(Buffer.concat(chunks), resolve))
  const buffer = terminal.buffer.active
  const lines = Array.from({ length: rows }, (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
  const attributes = Array.from({ length: rows }, (_, row) => {
    const line = buffer.getLine(buffer.viewportY + row)
    return Array.from({ length: columns }, (_, column) => {
      const cell = line?.getCell(column)
      return [cell?.getBgColorMode() ?? 0, cell?.getBgColor() ?? 0, Boolean(cell?.isInverse())]
    })
  })
  process.stdout.write(JSON.stringify({ lines, attributes }) + '\n')
} finally {
  terminal.dispose()
}
