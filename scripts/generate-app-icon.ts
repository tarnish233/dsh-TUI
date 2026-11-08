/**
 * Development-only app artwork. Reuses the approved startup whale grid and its
 * asset palette; never uploads an image or changes the terminal app identity.
 * Run with --check to verify the checked-in SVG/PNG files without writing them.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import sharp from 'sharp'
import { LOGO_BLUE, LOGO_GRID, LOGO_PIXEL_ROWS, LOGO_SAMPLE_COLUMNS } from '../src/ui/logo.ts'

const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  throw new Error('Usage: node scripts/generate-app-icon.ts [--check]')
}
const check = args[0] === '--check'
const directory = new URL('../assets/icon/', import.meta.url)
const blue = '#' + LOGO_BLUE.map(channel => channel.toString(16).padStart(2, '0')).join('')

// A quadrant sample is twice as tall as it is wide in the startup artwork.
// Keep those proportions: a 50 x 37.5 whale, centered in a 64 x 64 badge.
const scaleX = 50 / LOGO_SAMPLE_COLUMNS
const scaleY = scaleX * 2
const offsetX = (64 - LOGO_SAMPLE_COLUMNS * scaleX) / 2
const offsetY = (64 - LOGO_PIXEL_ROWS * scaleY) / 2
const runs: string[] = []
for (let y = 0; y < LOGO_GRID.length; y++) {
  const row = LOGO_GRID[y]!
  for (let x = 0; x < row.length;) {
    if (row[x] !== 'B') { x++; continue }
    const start = x
    while (x < row.length && row[x] === 'B') x++
    const length = x - start
    runs.push('M' + start + ' ' + y + 'h' + length + 'v1h-' + length + 'Z')
  }
}
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" role="img" aria-labelledby="title desc">\n' +
  '  <title id="title">DSH TUI</title>\n' +
  '  <desc id="desc">White pixel whale on a DeepSeek blue rounded-square badge. Derived from the approved startup logo grid.</desc>\n' +
  '  <rect x="2" y="2" width="60" height="60" rx="14" fill="' + blue + '"/>\n' +
  '  <path fill="#ffffff" transform="translate(' + offsetX + ' ' + offsetY + ') scale(' + scaleX + ' ' + scaleY + ')" d="' + runs.join('') + '"/>\n' +
  '</svg>\n'
const source = Buffer.from(svg)
const assets = new Map<string, Buffer>([
  ['dsh-tui.svg', source],
  ['dsh-tui.png', await sharp(source, { density: 72 * 8 }).png({ compressionLevel: 9 }).toBuffer()],
  ['dsh-tui-64.png', await sharp(source).png({ compressionLevel: 9 }).toBuffer()],
])

if (!check) await mkdir(directory, { recursive: true })
for (const [name, bytes] of assets) {
  const target = new URL(name, directory)
  if (check) {
    const stored = await readFile(target)
    if (!stored.equals(bytes)) throw new Error('App icon is stale: ' + name)
  } else await writeFile(target, bytes)
}
process.stdout.write((check ? 'Verified' : 'Generated') + ' 3 app icon assets; no terminal/config changes.\n')
