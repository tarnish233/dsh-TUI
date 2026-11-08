import assert from 'node:assert/strict'
import test from 'node:test'
import type { TuiMouseEvent, TuiMouseEventType } from '#pi-tui'
import { createCcKeymap } from '../src/input/index.ts'
import { ModalFrame, modalBinding, modalHeight, modalOverlayOptions, type ModalFrameOptions } from '../src/ui/modal.ts'
import { truncateToWidth, visibleWidth } from '../src/ui/text.ts'

const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, '')
function event(type: TuiMouseEventType, x: number, y: number): TuiMouseEvent {
  return { type, x, y, screenX: x + 20, screenY: y + 4, width: 80, height: 24, button: 'left', shift: false, alt: false, ctrl: false }
}

for (const width of [1, 7, 14, 40, 64, 100, 160]) {
  for (const height of [1, 2, 5, 6, 8, 18, 40]) {
    test(`modal frame respects ${width} columns x ${height} rows with long native labels and wrapped chrome`, () => {
      const frame = new ModalFrame()
      const keymap = createCcKeymap()
      const options: ModalFrameOptions = {
        title: 'Settings › 中文 👩🏽‍💻 e\u0301 ' + 'a'.repeat(100), subtitle: 'A long native capability explanation with many words',
        before: ['Search…', 'General · Tools · Agents · Images'], after: ['Saving…', 'A retryable native failure'], maxHeight: height, keymap,
        actions: [
          { id: 'edit', label: 'Change value', action: 'list.select', onActivate: () => {} },
          { id: 'copy', label: 'Copy original available native source', action: 'tool.details.copy' },
          { id: 'close', label: 'Close', action: 'list.cancel', onActivate: () => {} },
        ], onClose: () => {},
      }
      const geometry = frame.measure(width, options)
      const body = Array.from({ length: Math.max(1, geometry.bodyHeight) }, (_, n) => truncateToWidth(`row ${n} 中文`, geometry.bodyWidth, ''))
      const output = frame.render(width, body, options)
      assert.ok(output.length <= height)
      assert.ok(output.every(line => visibleWidth(line) <= width), output.map(plain).join('\n'))
      assert.ok(geometry.bodyWidth >= 1)
      if (width >= 8 && height >= 6) {
        assert.equal(output.length, height)
        assert.ok(output.every(line => visibleWidth(line) === width), 'border and padding align in terminal columns')
        assert.match(plain(output.at(-1) ?? ''), /^└─*┘$/)
      }
    })
  }
}

test('body coordinates translate to the measured viewport, leaving chrome unowned by content', () => {
  const frame = new ModalFrame()
  const options = { title: 'Tools', before: ['Search…'], maxHeight: 18, onClose: () => {} }
  const geometry = frame.measure(80, options)
  frame.render(80, ['body'], options)
  const mapped = frame.bodyMouse(event('click', geometry.bodyCol + 4, geometry.bodyRow + 2))
  assert.equal(mapped?.x, 4)
  assert.equal(mapped?.y, 2)
  assert.equal(mapped?.width, geometry.bodyWidth)
  assert.equal(mapped?.height, geometry.bodyHeight)
  assert.equal(mapped?.screenX, geometry.bodyCol + 24)
  assert.equal(frame.bodyMouse(event('click', 1, geometry.bodyRow)), undefined)
  assert.equal(frame.bodyMouse(event('click', geometry.bodyCol, 0)), undefined)
  frame.invalidate()
  assert.equal(frame.bodyMouse(event('click', geometry.bodyCol, geometry.bodyRow)), undefined)
})

test('close hitbox activates only on completed click, not motion/press/drag or invalidated gestures', () => {
  const frame = new ModalFrame()
  let closed = 0
  const options = { title: 'Agent', maxHeight: 18, onClose: () => { closed += 1 } }
  frame.render(80, ['readonly'], options)
  const x = plain(frame.render(80, ['readonly'], options)[0] ?? '').indexOf('[×]')
  assert.ok(x > 0)
  frame.handleMouse(event('move', x, 0))
  assert.equal(closed, 0)
  frame.handleMouse(event('press', x, 0))
  assert.equal(closed, 0)
  frame.handleMouse(event('click', x, 0))
  assert.equal(closed, 1)
  frame.handleMouse(event('press', x, 0))
  frame.invalidate()
  frame.render(80, ['readonly'], options)
  frame.handleMouse(event('click', x, 0))
  assert.equal(closed, 1, 'same close button must not revive an old invalidated press')
})

test('disabled and unbound actions have honest labels and safe mouse behavior', () => {
  const frame = new ModalFrame()
  let actions = 0
  const keymap = createCcKeymap({ bindings: { 'tool.details.copy': null } })
  assert.equal(modalBinding(keymap, 'tool.details.copy'), undefined)
  const output = frame.render(64, ['body'], { title: 'Tool', maxHeight: 12, keymap,
    actions: [{ id: 'copy', label: 'Copy', action: 'tool.details.copy', onActivate: () => { actions++ } },
      { id: 'stop', label: 'Stop', disabled: true, onActivate: () => { actions++ } }],
  }).map(plain)
  const row = output.findIndex(line => line.includes('[Copy]'))
  assert.ok(row >= 0)
  assert.equal(output.join('\n').includes('ctrl+c Copy'), false)
  const copyX = output[row]!.indexOf('[Copy]')
  frame.handleMouse(event('click', copyX, row))
  assert.equal(actions, 1, 'unbound but clickable capability remains discoverable')
  frame.handleMouse(event('click', output[row]!.indexOf('[Stop]'), row))
  assert.equal(actions, 1)
})

test('frame keeps graphic transfers intact and protects metadata from raw terminal controls', () => {
  const frame = new ModalFrame()
  const graphic = '\x1b_Ga=T,f=100;AAAA\x1b\\'
  const output = frame.render(40, [graphic], { title: 'Image\x1b]52;c;bad\x07\x1b[2J', maxHeight: 8 })
  assert.ok(output.some(line => line.includes(graphic)))
  assert.equal(output.join('\n').includes('\x1b]52'), false)
  assert.equal(output.join('\n').includes('\x1b[2J'), false)
  assert.ok(output.every(line => visibleWidth(line) <= 40))
})

test('modal host sizing uses the same bounded height as the frame and no new renderer options', () => {
  for (const rows of [1, 3, 10, 24, 40]) {
    const tui = { terminal: { rows } } as Parameters<typeof modalHeight>[0]
    assert.ok(modalHeight(tui) <= Math.max(1, rows - 2))
    assert.ok(modalHeight(tui, 'compact') <= 18)
  }
  assert.equal(modalOverlayOptions('compact').width, 64)
  assert.equal(modalOverlayOptions('standard').width, 100)
  assert.equal(modalOverlayOptions('wide').width, '96%')
  assert.equal(Object.hasOwn(modalOverlayOptions(), 'opacity'), false)
})
