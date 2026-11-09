import assert from 'node:assert/strict'
import test from 'node:test'
import { surfaces, t, cc } from '../src/ui/theme.ts'
import { visibleWidth } from '../src/ui/text.ts'

for (const role of ['raised', 'selected'] as const) {
  test(`semantic ${role} surface restores the outer background after nested chips`, () => {
    const surface = surfaces[role]
    const value = surface.fill('before ' + cc.chip('chip') + ' after', 32)
    assert.ok(value.includes('\x1b[49m' + surface.open), 'a child background close restores the parent surface')
    assert.equal(visibleWidth(value), 32)
    assert.ok(value.endsWith(surface.close))
  })
  test(`semantic ${role} surface handles combined resets without confusing RGB channels`, () => {
    const surface = surfaces[role]
    assert.equal(surface.style('a\x1b[39;49mb'), surface.open + 'a\x1b[39;49m' + surface.open + 'b' + surface.close)
    assert.equal(surface.style('\x1b[38;2;0;0;255mblue'), surface.open + '\x1b[38;2;0;0;255mblue' + surface.close)
    assert.equal(surface.style('\x1b[38:2::0:0:255mblue'), surface.open + '\x1b[38:2::0:0:255mblue' + surface.close)
    assert.equal(surface.style('a\x1b[mb'), surface.open + 'a\x1b[m' + surface.open + 'b' + surface.close)
  })
}

test('transparent canvas/dialog keeps caller foreground resets and generates no private plate', () => {
  const styled = t.red('overlong colored content')
  for (const role of ['canvas', 'dialog', 'overlay'] as const) {
    const line = surfaces[role].fill(styled, 10)
    assert.equal(visibleWidth(line), 10)
    assert.ok(line.includes('\x1b[0m'), 'Pi clipping closes the foreground even under a transparent parent')
    assert.doesNotMatch(line, /\x1b\[(?:48;|40m|100m)/)
  }
})
