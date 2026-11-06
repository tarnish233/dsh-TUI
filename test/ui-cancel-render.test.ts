import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { SessionEvent, SessionInfo } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { loadInputModule } from '../src/input/testing/harness.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import { TranscriptView, transcriptHints } from '../src/ui/transcript.ts'

const input = await loadInputModule()

const info = (events: SessionEvent[] = []): SessionInfo => ({
  sessionId: 's1',
  cwd: '/tmp/work',
  provider: 'demo',
  model: 'demo',
  capabilities: [],
  events,
})

const ev = (type: string, seq: number, data: unknown, extra: Partial<SessionEvent> = {}): SessionEvent => ({
  type,
  seq,
  time: 0,
  data,
  ...extra,
})

const newStore = (events: SessionEvent[] = []): TranscriptStore => {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info(events))
  return store
}

const assistant = (seq: number, text: string, thinking = ''): SessionEvent => ev('assistant/message', seq, {
  turn: 1,
  step: 1,
  message: {
    id: `a${seq}`,
    role: 'assistant',
    content: [
      ...(thinking === '' ? [] : [{ type: 'reasoning', text: thinking }]),
      ...(text === '' ? [] : [{ type: 'text', text }]),
    ],
    source: { kind: 'model', provider: 'demo', model: 'demo' },
  },
  stream: [],
}, { surfaceOp: 'append' })

const toolCall = (seq: number, callId: string, name: string, args: string): SessionEvent =>
  ev('tool/call', seq, { turn: 1, step: 1, callId, name, arguments: args })

function storeWithTool(opts: {
  name: string
  args: string
  resultText?: string
  meta?: unknown
  presentation?: Record<string, unknown>
}): TranscriptStore {
  const result = ev('tool/result', 3, {
    turn: 1,
    step: 1,
    message: {
      id: 'tr-call-1',
      role: 'tool',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: opts.resultText ?? '' }],
      isError: false,
      source: { kind: 'tool', callId: 'call-1' },
    },
    ...(opts.meta === undefined ? {} : { meta: opts.meta }),
  }, {
    surfaceOp: 'append',
    ...(opts.presentation === undefined ? {} : { toolPresentation: opts.presentation }),
  })
  return newStore([toolCall(2, 'call-1', opts.name, opts.args), result])
}

const rendered = (view: TranscriptView, width = 100): string => stripTerminalSequences(view.render(width).join('\n'))

function assertWidths(view: TranscriptView, widths: readonly number[]): void {
  for (const width of widths) {
    for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`)
  }
}

const lines = (count: number, prefix: string): string => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n') + '\n'

// ---------------------------------------------------------------------------
// R20: key hints come from the real keymap

test('transcriptHints uses the effective keymap and omits unbound actions', () => {
  const fallback = input.createCcKeymap()
  assert.deepEqual(transcriptHints(fallback), { expand: 'ctrl+o', toolsDetails: 'ctrl+x ctrl+o' }, 'app.thinking.toggle remains unbound by default')
  const custom = input.createCcKeymap({ bindings: { 'app.tools.expand': 'alt+e', 'app.thinking.toggle': 'ctrl+g', 'app.tools.details': 'ctrl+x ctrl+d' } })
  assert.deepEqual(transcriptHints(custom), { expand: 'alt+e', thinking: 'ctrl+g', toolsDetails: 'ctrl+x ctrl+d' })
  const disabled = input.createCcKeymap({ bindings: { 'app.tools.expand': null } })
  assert.deepEqual(transcriptHints(disabled), { toolsDetails: 'ctrl+x ctrl+o' }, 'disabling expand does not erase a different action')
  const allDisabled = input.createCcKeymap({ bindings: { 'app.tools.expand': null, 'app.tools.details': null } })
  assert.deepEqual(transcriptHints(allDisabled), {}, 'disabled actions advertise no keys')
})

test('the folded thinking hint never claims Ctrl+T and only shows a real binding', () => {
  const store = newStore([assistant(1, 'visible answer', 'secret thought')])
  const plain = new TranscriptView(store, { showThinking: false, expandTools: false })
  const folded = rendered(plain)
  assert.match(folded, /Thought \(hidden\)/)
  assert.doesNotMatch(folded, /ctrl\+t/i)
  assert.match(folded, /visible answer/)

  const hinted = new TranscriptView(store, { showThinking: false, expandTools: false, hints: { thinking: 'ctrl+g' } })
  assert.match(rendered(hinted), /Thought \(ctrl\+g to show\)/)
  assert.doesNotMatch(rendered(hinted), /ctrl\+t/i)

  const shown = new TranscriptView(store, { showThinking: true, expandTools: false, hints: { thinking: 'ctrl+g' } })
  const expanded = rendered(shown)
  assert.match(expanded, /secret thought/)
  assert.doesNotMatch(expanded, /to show/)
})

test('folded summaries and expanded I/O hints use only real bindings and do not cap the source', () => {
  const store = storeWithTool({ name: 'bash', args: '{"command":"printf hi"}', resultText: lines(14, 'line') })
  const plain = new TranscriptView(store, { showThinking: false, expandTools: false })
  const folded = rendered(plain)
  assert.match(folded, /14 lines returned/)
  assert.doesNotMatch(folded, /line 14|ctrl\+o|show details/, 'no hidden output or invented key is painted')
  const hinted = new TranscriptView(store, { showThinking: false, expandTools: false, hints: { expand: 'ctrl+o' } })
  assert.match(rendered(hinted), /ctrl\+o to expand/)
  const remapped = new TranscriptView(store, { showThinking: false, expandTools: false, hints: { expand: 'alt+e' } })
  assert.match(rendered(remapped), /alt\+e to expand/)
  assert.doesNotMatch(rendered(remapped), /ctrl\+o/)

  const longStore = storeWithTool({ name: 'bash', args: '{"command":"print"}', resultText: lines(402, 'row') })
  const preview = new TranscriptView(longStore, { showThinking: false, expandTools: true, hints: { expand: 'ctrl+o', toolsDetails: 'ctrl+x ctrl+o' } })
  const painted = rendered(preview)
  assert.match(painted, /more lines.*ctrl\+x ctrl\+o to inspect tools/)
  assert.doesNotMatch(painted, /row 402|to expand|\(truncated\)/, 'a preview budget is not a backend truncation')
  preview.options.expandedOutputMaxLines = 5_000
  assert.match(rendered(preview), /row 402/, 'raising only the display budget reveals the retained complete result')
  assert.doesNotMatch(rendered(preview), /more lines/)
})

test('native read output preserves real line numbers beyond its preview budget', () => {
  const readLines = Array.from({ length: 500 }, (_, index) => ({ number: index + 1, text: 'line ' + (index + 1) }))
  const store = storeWithTool({
    name: 'read', args: '{"file_path":"src/big.ts"}', resultText: 'read ok',
    presentation: { result: { card: 'read', path: 'src/big.ts', offset: 1, totalLines: 500, lines: readLines } },
  })
  const view = new TranscriptView(store, { showThinking: false, expandTools: true, hints: { expand: 'ctrl+o', toolsDetails: 'ctrl+x ctrl+o' } })
  const output = rendered(view, 90)
  assert.match(output, /more lines.*to inspect tools/)
  assert.doesNotMatch(output, /line 500|to expand|\(truncated\)/)
  view.options.expandedOutputMaxLines = 5_000
  const complete = rendered(view, 90)
  assert.match(complete, /500\s+line 500/, 'the native last line retains its real absolute coordinate')
  assert.match(complete, /read ok/, 'the durable textual result is retained alongside the native card')
})

test('multi-file diff counts all files and expanded view no longer has the old 400-row cap', () => {
  const diffs = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map(path => ({ path, oldText: '', newText: lines(10, path.replace('src/', '')) }))
  const store = storeWithTool({ name: 'edit', args: '{"file_path":"src/a.ts"}', resultText: 'updated', meta: { diffs } })
  const folded = new TranscriptView(store, { showThinking: false, expandTools: false, editDiffCollapsedLines: 16, hints: { expand: 'ctrl+o' } })
  const output = rendered(folded, 100)
  assert.match(output, /Updated 3 files with 30 additions and 0 removals/)
  assert.match(output, /src\/a\.ts/)
  assert.match(output, /src\/b\.ts/)
  assert.match(output, /more lines.*ctrl\+o to expand/)
  assert.doesNotMatch(output, /c\.ts 10/, 'later-file content remains folded rather than lost from the totals')
  assertWidths(folded, [40, 80, 120])

  const single = storeWithTool({ name: 'edit', args: '{"file_path":"src/a.ts"}', resultText: 'updated', meta: { diffs: [diffs[0]!] } })
  assert.match(rendered(new TranscriptView(single, { showThinking: false, expandTools: false }), 100), /Updated src\/a\.ts with 10 additions and 0 removals/)

  const bigDiffs = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map(path => ({ path, oldText: '', newText: lines(200, path.replace('src/', '')) }))
  const big = storeWithTool({ name: 'edit', args: '{"file_path":"src/a.ts"}', resultText: 'updated', meta: { diffs: bigDiffs } })
  const expanded = new TranscriptView(big, { showThinking: false, expandTools: true, hints: { expand: 'ctrl+o' } })
  const expandedText = rendered(expanded, 100)
  assert.match(expandedText, /Updated 3 files with 600 additions and 0 removals/)
  assert.match(expandedText, /c\.ts 200/, 'last-file content after row 400 is reachable')
  assert.doesNotMatch(expandedText, /\(truncated\)|to expand/)
  assertWidths(expanded, [40, 80, 120])
})

test('changing the hint option invalidates only the cached hint text', () => {
  const store = storeWithTool({ name: 'bash', args: '{"command":"x"}', resultText: lines(14, 'row') })
  const view = new TranscriptView(store, { showThinking: false, expandTools: false })
  assert.doesNotMatch(rendered(view), /to expand/)
  view.options.hints = { expand: 'ctrl+o' }
  assert.match(rendered(view), /ctrl\+o to expand/)
  view.options.hints = { expand: 'alt+e' }
  const remapped = rendered(view)
  assert.match(remapped, /alt\+e to expand/)
  assert.doesNotMatch(remapped, /ctrl\+o/)
})
