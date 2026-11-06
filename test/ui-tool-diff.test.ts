import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { MetaDiff } from '../src/ui/tool-io.ts'
import { diffStats, renderDiffBlock, type DiffRenderOptions } from '../src/ui/tool-diff.ts'

const diff = (overrides: Partial<MetaDiff> = {}): MetaDiff => ({
  path: 'src/a.ts',
  oldText: 'const a = 0\nconst b = 1\nconst c = 2\n',
  newText: 'const a = 1\nconst b = 1\nconst c = 3\n',
  ...overrides,
})

function options(overrides: Partial<DiffRenderOptions> = {}): DiffRenderOptions {
  return {
    viewMode: 'auto',
    indicatorMode: 'bars',
    splitMinWidth: 120,
    wordWrap: true,
    expanded: true,
    collapsedLines: 24,
    ...overrides,
  }
}

const plain = (lines: readonly string[]): string[] => lines.map(line => stripTerminalSequences(line))

test('auto mode switches to split at diffSplitMinWidth=120 and unified below it', () => {
  const at119 = plain(renderDiffBlock([diff()], 119, options()).lines)
  assert.doesNotMatch(at119.join('\n'), /old\s+│\s+new/)
  const at120 = plain(renderDiffBlock([diff()], 120, options()).lines)
  assert.match(at120.join('\n'), /old\s+│\s+new/)
  assert.match(at120.join('\n'), /┼/)
  // Explicit split falls back to unified when the columns cannot fit.
  const narrowSplit = plain(renderDiffBlock([diff()], 40, options({ viewMode: 'split' })).lines)
  assert.doesNotMatch(narrowSplit.join('\n'), /old\s+│\s+new/)
  // A content width can be separated from the layout threshold.
  const indented = plain(renderDiffBlock([diff()], 116, options({ layoutWidth: 120 })).lines)
  assert.match(indented.join('\n'), /old\s+│\s+new/)
  const unified = plain(renderDiffBlock([diff()], 160, options({ viewMode: 'unified' })).lines)
  assert.doesNotMatch(unified.join('\n'), /old\s+│\s+new/)
})

test('bars, classic and none indicators preserve add/delete facts', () => {
  const bars = plain(renderDiffBlock([diff()], 60, options({ viewMode: 'unified', indicatorMode: 'bars' })).lines)
  assert.match(bars.join('\n'), /▌ const a = 0/)
  const classic = plain(renderDiffBlock([diff()], 60, options({ viewMode: 'unified', indicatorMode: 'classic' })).lines)
  assert.match(classic.join('\n'), /- const a = 0/)
  assert.match(classic.join('\n'), /\+ const a = 1/)
  const none = plain(renderDiffBlock([diff()], 60, options({ viewMode: 'unified', indicatorMode: 'none' })).lines)
  assert.doesNotMatch(none.join('\n'), /[▌+-] const a = 0/)
  // The delete/add content remains in every indicator mode.
  for (const mode of ['bars', 'classic', 'none'] as const) {
    const text = plain(renderDiffBlock([diff()], 60, options({ viewMode: 'unified', indicatorMode: mode })).lines).join('\n')
    assert.match(text, /const a = 0/)
    assert.match(text, /const a = 1/)
  }
})

test('word wrap wraps long diff lines and wrap=false truncates within width', () => {
  const long = diff({ oldText: `${'a'.repeat(120)}\n`, newText: `${'b'.repeat(120)}\n` })
  const wrapped = plain(renderDiffBlock([long], 40, options({ viewMode: 'unified', wordWrap: true })).lines)
  assert.ok(wrapped.length >= 6, 'both long lines become multiple physical rows')
  const truncated = plain(renderDiffBlock([long], 40, options({ viewMode: 'unified', wordWrap: false })).lines)
  assert.equal(truncated.length, 2)
  assert.ok(truncated.every(line => line.length <= 40))
})

test('Edit folds at 24 rows, Write at 0, and expansion is never budgeted', () => {
  const rows = Array.from({ length: 40 }, (_, index) => `line ${index}`)
  const big = diff({ oldText: '', newText: `${rows.join('\n')}\n` })
  const editFolded = renderDiffBlock([big], 80, options({ expanded: false, collapsedLines: 24 }))
  assert.equal(editFolded.hidden, 16)
  assert.equal(editFolded.lines.length, 24)
  const editOpen = renderDiffBlock([big], 80, options({ expanded: true, collapsedLines: 24 }))
  assert.equal(editOpen.hidden, 0)
  assert.equal(editOpen.lines.length, 40)

  const writeFolded = renderDiffBlock([big], 80, options({ expanded: false, collapsedLines: 0 }))
  assert.deepEqual(writeFolded.lines, [])
  assert.equal(writeFolded.hidden, 40)
  assert.equal(writeFolded.added, 40)
  assert.equal(writeFolded.removed, 0)
  const writeOpen = renderDiffBlock([big], 80, options({ expanded: true, collapsedLines: 0 }))
  assert.equal(writeOpen.lines.length, 40)
})

test('a direct hunk never invents absolute file line numbers', () => {
  const text = plain(renderDiffBlock([diff()], 120, options()).lines).join('\n')
  assert.doesNotMatch(text, /^\s*\d+\s+\d*\s*[+-]/m)
  assert.doesNotMatch(text, /^\s*\d+\s*[│|]/m)
  // Only the real content and the split labels remain.
  assert.match(text, /const a = 0/)
  assert.match(text, /const a = 1/)
})

test('multiple files keep their identity, totals and all hidden rows', () => {
  const diffs = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map(path => ({
    path,
    oldText: '',
    newText: Array.from({ length: 10 }, (_, index) => `${path} ${index}`).join('\n') + '\n',
  }))
  const folded = renderDiffBlock(diffs, 100, options({ expanded: false, collapsedLines: 16 }))
  assert.equal(folded.files, 3)
  assert.equal(folded.added, 30)
  assert.equal(folded.hidden, 14, 'later files still count as hidden')
  const text = plain(folded.lines).join('\n')
  assert.match(text, /▸ src\/a\.ts/)
  assert.match(text, /▸ src\/b\.ts/)
  const stats = diffStats(diffs)
  assert.deepEqual(stats, { added: 30, removed: 0, oversized: false })
})

test('oversized hunks are reported honestly instead of materialized', () => {
  const huge = diff({ oldText: '', newText: `${'x'.repeat(160_000)}\n` })
  const result = renderDiffBlock([huge], 80, options())
  assert.equal(result.oversized, true)
  assert.deepEqual(result.lines, [])
  assert.equal(diffStats([huge]).oversized, true)
})

test('every diff layout stays within 1/24/40/80/120/160 columns', () => {
  const long = diff({
    oldText: `${'古'.repeat(90)}\nplain\n`,
    newText: `${'😀'.repeat(90)}\nplain\n`,
  })
  for (const width of [1, 24, 40, 80, 120, 160]) {
    for (const viewMode of ['auto', 'split', 'unified'] as const) {
      for (const indicatorMode of ['bars', 'classic', 'none'] as const) {
        for (const wordWrap of [true, false]) {
          const result = renderDiffBlock([long], width, options({ viewMode, indicatorMode, wordWrap }))
          for (const line of result.lines) {
            assert.ok(visibleWidth(line) <= width, `width=${width} ${viewMode}/${indicatorMode}/${wordWrap}: ${visibleWidth(line)} ${JSON.stringify(stripTerminalSequences(line))}`)
          }
        }
      }
    }
  }
})