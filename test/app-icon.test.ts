import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import sharp from 'sharp'
import { LOGO_BLUE, LOGO_GRID } from '../src/ui/logo.ts'

const assets = new URL('../assets/icon/', import.meta.url)
const names = ['dsh-tui.svg', 'dsh-tui.png', 'dsh-tui-64.png'] as const
const blue = '#' + LOGO_BLUE.map(channel => channel.toString(16).padStart(2, '0')).join('')

// These are static distribution assets, not a second image-rendering path in App.
test('app icon: standalone, accessible SVG with the approved asset palette', async () => {
  const svg = await readFile(new URL('dsh-tui.svg', assets), 'utf8')
  assert.match(svg, /viewBox="0 0 64 64"/)
  assert.match(svg, /role="img" aria-labelledby="title desc"/)
  assert.match(svg, /<title id="title">DSH TUI<\/title>/)
  assert.ok(svg.includes('fill="' + blue + '"'), 'asset blue follows the existing logo constant')
  assert.match(svg, /fill="#ffffff"/)
  assert.doesNotMatch(svg, /<(?:script|image|foreignObject|text)\b|\b(?:href|on[a-z]+)\s*=|<!ENTITY|data:/i)
  assert.doesNotMatch(svg, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u)
})

for (const [name, size] of [['dsh-tui.png', 512], ['dsh-tui-64.png', 64]] as const) {
  test('app icon: ' + size + 'px PNG has transparent corners and an opaque blue badge', async () => {
    const file = new URL(name, assets)
    const metadata = await sharp(await readFile(file)).metadata()
    assert.equal(metadata.format, 'png')
    assert.equal(metadata.width, size)
    assert.equal(metadata.height, size)
    assert.equal(metadata.hasAlpha, true)
    const { data, info } = await sharp(await readFile(file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    assert.equal(info.channels, 4)
    const at = (x: number, y: number): readonly number[] => [...data.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)]
    for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
      assert.equal(at(x!, y!)[3], 0, 'outer corner remains transparent')
    }
    assert.deepEqual(at(Math.floor(size / 2), Math.floor(size / 16)), [...LOGO_BLUE, 255])
    let white = 0
    for (let index = 0; index < data.length; index += 4) {
      if (data[index] === 255 && data[index + 1] === 255 && data[index + 2] === 255 && data[index + 3] === 255) white++
    }
    assert.ok(white > size * size * 0.15, 'the whale has visible white area at this size')
    assert.ok(white < size * size * 0.5, 'the badge retains a visible blue surround')
  })
}

test('app icon: all 384 sample centers retain the approved whale geometry', async () => {
  const { data, info } = await sharp(await readFile(new URL('dsh-tui.png', assets)))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  assert.equal(info.width, 512)
  for (let y = 0; y < LOGO_GRID.length; y++) {
    for (let x = 0; x < LOGO_GRID[y]!.length; x++) {
      // Independently decode the specified 50 x 37.5, centered, 2:1 samples.
      const px = Math.floor((7 + (x + 0.5) * 50 / 32) * 8)
      const py = Math.floor((13.25 + (y + 0.5) * 37.5 / 12) * 8)
      const offset = (py * 512 + px) * 4
      assert.deepEqual([...data.subarray(offset, offset + 4)],
        LOGO_GRID[y]![x] === 'B' ? [255, 255, 255, 255] : [...LOGO_BLUE, 255],
        'whale sample ' + x + ',' + y)
    }
  }
})

test('app icon: assets are covered by the package file list, without a fake terminal icon field', async () => {
  const raw: unknown = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(raw !== null && typeof raw === 'object' && !Array.isArray(raw))
  const files: unknown = (raw as Record<string, unknown>).files
  assert.ok(Array.isArray(files) && files.includes('assets'))
  const controller = await readFile(new URL('../src/ui/terminal-integration.ts', import.meta.url), 'utf8')
  assert.match(controller, /TERMINAL_APP_ID = 'dsh-tui'/)
  assert.doesNotMatch(controller, /\b(?:icon|logo|image)=/)
})

test('app icon: development consistency check is reproducible and does not touch files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-app-icon-'))
  const before = await Promise.all(names.map(async name => ({
    bytes: await readFile(new URL(name, assets)),
    mtime: (await stat(new URL(name, assets))).mtimeMs,
  })))
  try {
    const result = spawnSync(process.execPath, ['scripts/generate-app-icon.ts', '--check'], {
      cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 15_000,
      env: { ...process.env, HOME: home, USERPROFILE: home, DSH_HOME: join(home, 'dsh'), XDG_CONFIG_HOME: join(home, 'config') },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Verified 3 app icon assets/)
    for (let index = 0; index < names.length; index++) {
      const target = new URL(names[index]!, assets)
      assert.deepEqual(await readFile(target), before[index]!.bytes)
      assert.equal((await stat(target)).mtimeMs, before[index]!.mtime)
    }
  } finally { await rm(home, { recursive: true, force: true }) }
})
