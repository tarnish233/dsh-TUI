import { strict as assert } from 'node:assert'
import test from 'node:test'
import { asTui, createFakeTui, loadInputModule } from '../src/input/testing/harness.ts'

/**
 * The inline answer row inspects configured bindings of `editor.move.line-up` /
 * `editor.move.line-down` at the visual boundary before forwarding a key. That
 * inspection must use the input owner's `matchesConfiguredKey`, so a bare LF
 * (Ctrl+J) stays a newline even when a user binds those actions to
 * `enter`/`return`; a real CR keeps its Enter meaning.
 */

const input = await loadInputModule()
const { InlineAnswer } = await import('../src/ui/inline-editor.ts')

type CcKeymap = InstanceType<typeof input.CcKeymap>
type Answer = InstanceType<typeof InlineAnswer>

function answer(bindings: Record<string, string | string[] | null | undefined>): { answer: Answer; keymap: CcKeymap } {
  const keymap = input.createCcKeymap({ bindings })
  return { answer: new InlineAnswer(asTui(createFakeTui(10, 60)), keymap), keymap }
}

test('a bare LF never resolves an enter/return binding of line-up/line-down', () => {
  const { answer: field } = answer({
    'editor.move.line-up': 'enter',
    'editor.move.line-down': 'return',
  })
  // The field is empty, so the caret is on the first and last visual line: an
  // Enter match would hand the key to the dialog as navigation.
  assert.equal(field.handleKey('\n'), 'handled', 'Ctrl+J is a newline, not line-up')
  assert.equal(field.handleKey('\n'), 'handled', 'the second Ctrl+J is a newline too')
  assert.equal(field.editor.getText(), '\n\n', 'both LF bytes stayed editor text')

  // A real CR still reaches the configured boundary binding.
  const { answer: cr } = answer({ 'editor.move.line-up': 'enter' })
  assert.equal(cr.handleKey('\r'), 'up', 'a real CR keeps its Enter binding')
})

test('a configured ctrl+j binding still wins over the LF guard where it is explicit', () => {
  const { answer: field } = answer({ 'editor.move.line-up': 'ctrl+j' })
  assert.equal(field.handleKey('\n'), 'up', 'an explicit ctrl+j binding is not suppressed by the enter/return rule')
})