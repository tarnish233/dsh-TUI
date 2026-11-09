// Must stay the FIRST import: forces truecolor before any src module (theme
// snapshots the terminal color mode at import time).
import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { SessionEvent, SessionInfo } from '../src/backend/types.ts'
import { TranscriptStore } from '../src/state/transcript.ts'
import { TranscriptView } from '../src/ui/transcript.ts'
import { createItemBlock } from '../src/ui/blocks.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'

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

const user = (text: string) => ({ id: `u${text}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })

const assistant = (seq: number, text: string, thinking = '', extra: Record<string, unknown> = {}) => ev('assistant/message', seq, {
  turn: 1,
  step: 1,
  message: {
    id: `a${seq}`,
    role: 'assistant',
    content: [
      ...(thinking === '' ? [] : [{ type: 'reasoning', text: thinking }]),
      { type: 'text', text },
    ],
    source: { kind: 'model', provider: 'demo', model: 'demo' },
  },
  stream: [],
  ...extra,
}, { surfaceOp: 'append' })

const toolResult = (callId: string, text: string, extra: Record<string, unknown> = {}) => ev('tool/result', 3, {
  turn: 1,
  step: 1,
  message: {
    id: `tr-${callId}`,
    role: 'tool',
    toolCallId: callId,
    content: [{ type: 'text', text }],
    isError: false,
    source: { kind: 'tool', callId },
  },
  ...extra,
}, { surfaceOp: 'append' })

/** The store consumes the backend's codec; tests use the offline fixture one. */
function newStore(events: SessionEvent[] = []): TranscriptStore {
  const store = new TranscriptStore({ codec: DEMO_TRANSCRIPT_CODEC })
  store.reset(info(events))
  return store
}

function longToolStore(lines: number): TranscriptStore {
  const text = Array.from({ length: lines }, (_, index) => `result line ${index + 1}`).join('\n')
  return newStore([
    ev('assistant/message', 1, {
      turn: 1,
      step: 1,
      message: {
        id: 'a-tool',
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-long', name: 'bash', arguments: '{"command":"printf hi"}' }],
        source: { kind: 'model', provider: 'demo', model: 'demo' },
      },
      stream: [],
    }, { surfaceOp: 'append' }),
    ev('tool/call', 2, { turn: 1, step: 1, callId: 'call-long', name: 'bash', arguments: '{"command":"printf hi"}' }),
    toolResult('call-long', text),
  ])
}

function assertWidths(view: TranscriptView, widths: readonly number[]): void {
  for (const width of widths) {
    const lines = view.render(width)
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)} ${JSON.stringify(line)}`)
  }
}

test('renders Markdown, Chinese, emoji, tool diff and stays within every tested width', () => {
  const diffMeta = {
    diffs: [{
      path: 'src/greet.ts',
      oldText: 'export const x = 1\nconsole.log(x)\n',
      newText: 'export const x = 2\nconsole.log(x)\n// 完成 ✅\n',
    }],
    operation: 'update',
  }
  const text = [
    '# Heading',
    '',
    '中文与 emoji 🚀👨‍👩‍👧‍👦 混排，长路径 `/a/very/long/path/that/should/wrap/at/the/edge.ts`。',
    '',
    '```ts',
    'export function greet(name: string): string {',
    '  return `你好, ${name}`',
    '}',
    '```',
    '',
    '- one',
    '- two',
  ].join('\n')
  const events: SessionEvent[] = [
    ev('user/message', 1, user('请更新文件 👋'), { surfaceOp: 'append' }),
    ev('assistant/message', 2, {
      turn: 1,
      step: 1,
      message: {
        id: 'a-diff',
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '需要先看一下文件。' },
          { type: 'text', text },
          { type: 'tool-call', id: 'call-edit', name: 'edit', arguments: '{"file_path":"src/greet.ts"}' },
        ],
        source: { kind: 'model', provider: 'demo', model: 'demo' },
      },
      stream: [],
    }, { surfaceOp: 'append' }),
    ev('tool/call', 3, { turn: 1, step: 1, callId: 'call-edit', name: 'edit', arguments: '{"file_path":"src/greet.ts"}' }),
    toolResult('call-edit', 'Updated src/greet.ts.', { meta: diffMeta }),
  ]
  const view = new TranscriptView(newStore(events), { showThinking: true, expandTools: false })
  assertWidths(view, [24, 40, 80, 120, 160])
  const output = stripTerminalSequences(view.render(100).join('\n'))
  assert.match(output, /Updated src\/greet\.ts with 2 additions and 1 removal/)
  assert.match(output, /完成 ✅/)
  assert.match(output, /需要先看一下文件/)
  // A hunk has no file coordinates: no absolute line-number gutter is invented.
  assert.doesNotMatch(output, /^\s*\d+\s+\d+\s+[+-]/m)
})

test('thinking visibility is mutable and does not leak hidden reasoning', () => {
  const store = newStore([ev('assistant/message', 1, {
    turn: 1,
    step: 1,
    message: {
      id: 'a1',
      role: 'assistant',
      content: [{ type: 'reasoning', text: 'secret thought' }, { type: 'text', text: 'visible answer' }],
      source: { kind: 'model', provider: 'demo', model: 'demo' },
    },
    stream: [],
  }, { surfaceOp: 'append' })])
  const view = new TranscriptView(store, { showThinking: false, expandTools: false })
  const folded = stripTerminalSequences(view.render(60).join('\n'))
  assert.match(folded, /Thought/)
  assert.doesNotMatch(folded, /secret thought/)
  assert.match(folded, /visible answer/)

  view.options.showThinking = true
  const expanded = stripTerminalSequences(view.render(60).join('\n'))
  assert.match(expanded, /secret thought/)
  // Replacing the options object is supported too.
  view.options = { showThinking: false, expandTools: false }
  assert.doesNotMatch(stripTerminalSequences(view.render(60).join('\n')), /secret thought/)
})

test('expandTools folds long tool output and opens it on option change', () => {
  const store = longToolStore(14)
  const view = new TranscriptView(store, { showThinking: false, expandTools: false })
  const folded = stripTerminalSequences(view.render(70).join('\n'))
  // The folded card is a one-line count summary, not a six-line preview. No
  // keymap hints were supplied, so no shortcut is advertised (the old
  // hardcoded Ctrl+O text was a lie once the action is remapped or disabled).
  assert.match(folded, /14 lines returned/)
  assert.doesNotMatch(folded, /result line \d+/)
  assert.doesNotMatch(folded, /to expand/)
  view.options.hints = { expand: 'ctrl+o' }
  assert.match(stripTerminalSequences(view.render(70).join('\n')), /ctrl\+o to expand/)
  view.options.expandTools = true
  const opened = stripTerminalSequences(view.render(70).join('\n'))
  // The expanded preview honors expandedOutputMaxLines (default 10) while the
  // full result stays reachable through details/copy.
  assert.match(opened, /result line 10/)
  assert.match(opened, /4 more lines/)
  assert.doesNotMatch(opened, /result line 14/)
  assert.doesNotMatch(opened, /to expand/)
})

test('reuses one cached block per stable item and only invalidates the live item', () => {
  const store = newStore([ev('user/message', 1, user('one'), { surfaceOp: 'append' }), assistant(2, 'stable answer')])
  const view = new TranscriptView(store, { showThinking: false, expandTools: false })
  const first = view.render(80)
  assert.equal(view.cachedItemCount, 2)
  const second = view.render(80)
  assert.deepEqual(second, first)
  assert.equal(view.cachedItemCount, 2)

  store.handle({ type: 'stream_start', sessionId: 's1', attemptId: 'live', revision: 1, turn: 2, step: 1 })
  store.handle({ type: 'stream_chunk', sessionId: 's1', attemptId: 'live', revision: 2, index: 0, chunk: { type: 'text-delta', index: 0, text: 'streaming' } })
  const live = stripTerminalSequences(view.render(80).join('\n'))
  assert.match(live, /streaming/)
  assert.match(live, /stable answer/)
  assert.equal(view.cachedItemCount, 3)

  store.handle({ type: 'stream_chunk', sessionId: 's1', attemptId: 'live', revision: 3, index: 1, chunk: { type: 'text-delta', index: 0, text: ' more' } })
  assert.match(stripTerminalSequences(view.render(80).join('\n')), /streaming more/)
  assert.equal(view.cachedItemCount, 3)

  view.invalidate()
  assert.deepEqual(view.render(80), view.render(80))
})

test('human turns use the cc-dark selection background band', () => {
  const store = newStore([ev('user/message', 1, user('my query'), { surfaceOp: 'append' })])
  const view = new TranscriptView(store, { showThinking: false, expandTools: false })
  const raw = view.render(60).join('\n')
  assert.match(raw, /\x1b\[48;2;26;68;128m/, 'cc-dark selection #1a4480 fills the human turn')
})

test('removes cache entries for reset or removed items', () => {
  const store = newStore([ev('user/message', 1, user('one'), { surfaceOp: 'append' })])
  const view = new TranscriptView(store, { showThinking: false, expandTools: false })
  view.render(40)
  assert.equal(view.cachedItemCount, 1)
  store.reset(info())
  assert.deepEqual(view.render(40), [])
  assert.equal(view.cachedItemCount, 0)
})

test('renders native card intents for pending, diff, read and terminal results', () => {
  const store = newStore([
    ev('assistant/message', 1, {
      turn: 1,
      step: 1,
      message: {
        id: 'a-native',
        role: 'assistant',
        content: [
          { type: 'tool-call', id: 'call-diff', name: 'edit', arguments: '{"file_path":"src/a.ts"}' },
          { type: 'tool-call', id: 'call-read', name: 'read', arguments: '{"file_path":"src/b.ts"}' },
          { type: 'tool-call', id: 'call-term', name: 'bash', arguments: '{"command":"npm test"}' },
        ],
        source: { kind: 'model', provider: 'demo', model: 'demo' },
      },
      stream: [],
    }, { surfaceOp: 'append' }),
    ev('tool/call', 2, { turn: 1, step: 1, callId: 'call-diff', name: 'edit', arguments: '{"file_path":"src/a.ts"}' }, {
      toolPresentation: {
        call: {
          card: 'diff',
          title: 'Edit src/a.ts',
          diffs: [{ path: 'src/a.ts', oldText: null, newText: 'const a = 1\n' }],
          locations: [{ path: 'src/a.ts' }],
        },
      },
    }),
    ev('tool/result', 3, {
      turn: 1,
      step: 1,
      message: {
        id: 'tr-diff',
        role: 'tool',
        toolCallId: 'call-diff',
        content: [{ type: 'text', text: 'Updated src/a.ts' }],
        isError: false,
        source: { kind: 'tool', callId: 'call-diff' },
      },
    }, {
      surfaceOp: 'append',
      toolPresentation: {
        result: {
          card: 'diff',
          diffs: [{ path: 'src/a.ts', oldText: 'const a = 0\n', newText: 'const a = 1\n' }],
        },
      },
    }),
    ev('tool/call', 4, { turn: 1, step: 1, callId: 'call-read', name: 'read', arguments: '{"file_path":"src/b.ts"}' }, {
      toolPresentation: { call: { card: 'generic', title: 'Read src/b.ts', kind: 'read', locations: [{ path: 'src/b.ts', line: 1 }] } },
    }),
    ev('tool/result', 5, {
      turn: 1,
      step: 1,
      message: {
        id: 'tr-read',
        role: 'tool',
        toolCallId: 'call-read',
        content: [{ type: 'text', text: 'b.ts body' }],
        isError: false,
        source: { kind: 'tool', callId: 'call-read' },
      },
    }, {
      surfaceOp: 'append',
      toolPresentation: {
        result: {
          card: 'read',
          path: 'src/b.ts',
          offset: 120,
          totalLines: 400,
          lang: 'ts',
          lines: [
            { number: 120, text: 'export const b = 2' },
            { number: 121, text: 'export const c = 3' },
          ],
          content: [{ type: 'text', text: 'b.ts body' }],
        },
      },
    }),
    ev('tool/call', 6, { turn: 1, step: 1, callId: 'call-term', name: 'bash', arguments: '{"command":"npm test"}' }, {
      toolPresentation: { call: { card: 'terminal', title: 'npm test', description: 'Run the test suite', cwd: '.' } },
    }),
    ev('tool/result', 7, {
      turn: 1,
      step: 1,
      message: {
        id: 'tr-term',
        role: 'tool',
        toolCallId: 'call-term',
        content: [{ type: 'text', text: 'all good' }],
        isError: false,
        source: { kind: 'tool', callId: 'call-term' },
      },
    }, {
      surfaceOp: 'append',
      toolPresentation: { result: { card: 'terminal', output: 'all good\n2 passing', exitCode: 0 } },
    }),
  ])
  const view = new TranscriptView(store, { showThinking: false, expandTools: true })
  assertWidths(view, [32, 60, 100, 140])
  const output = stripTerminalSequences(view.render(110).join('\n'))
  // Diff card: applied hunk from the tool, no invented line numbers.
  assert.match(output, /Update src\/a\.ts/)
  assert.match(output, /Updated src\/a\.ts with 1 addition and 1 removal/)
  assert.doesNotMatch(output, /^\s*\d+\s*\d*\s*[+-]/m)
  // Read card keeps the native absolute line numbers (they are real coordinates).
  assert.match(output, /Read src\/b\.ts/)
  assert.match(output, /\(120-121 of 400 · ts\)/)
  assert.match(output, /120 export const b = 2/)
  // Terminal card: command header + captured output + exit code.
  assert.match(output, /Bash npm test/)
  assert.match(output, /Run the test suite/)
  assert.match(output, /2 passing/)
  assert.match(output, /exit code 0/)
})

test('a proposed or unresolved call never claims to be running', () => {
  const store = newStore()
  const send = (event: SessionEvent): void => {
    store.handle({ type: 'session_event', sessionId: 's1', event })
  }
  send(ev('assistant/message', 1, {
    turn: 1,
    step: 1,
    message: {
      id: 'a-proposed',
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call-prop', name: 'write', arguments: '{"file_path":"src/new.ts"}' }],
      source: { kind: 'model', provider: 'demo', model: 'demo' },
    },
    stream: [],
  }, { surfaceOp: 'append' }))
  const view = new TranscriptView(store, { showThinking: false, expandTools: false })
  const proposed = stripTerminalSequences(view.render(90).join('\n'))
  assert.match(proposed, /◌/)
  assert.match(proposed, /Proposed/)
  assert.doesNotMatch(proposed, /Running/)

  send(ev('tool/call', 2, { turn: 1, step: 1, callId: 'call-prop', name: 'write', arguments: '{"file_path":"src/new.ts"}' }))
  const running = stripTerminalSequences(view.render(90).join('\n'))
  assert.match(running, /Running…/)

  send(ev('turn/end', 3, { turn: 1, reason: { kind: 'cancelled' } }))
  const unknown = stripTerminalSequences(view.render(90).join('\n'))
  assert.match(unknown, /No result observed/)
  assert.doesNotMatch(unknown, /Running/)
  assert.doesNotMatch(unknown, /Updated /)
  assertWidths(view, [30, 60, 90])
})

test('generic fallback keeps the CC tool summary when no native card is forwarded', () => {
  const store = newStore([
    ev('user/message', 1, user('run it'), { surfaceOp: 'append' }),
    ev('assistant/message', 2, {
      turn: 1,
      step: 1,
      message: {
        id: 'a-generic',
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'call-g', name: 'bash', arguments: '{"command":"npm test"}' }],
        source: { kind: 'model', provider: 'demo', model: 'demo' },
      },
      stream: [],
    }, { surfaceOp: 'append' }),
    ev('tool/call', 3, { turn: 1, step: 1, callId: 'call-g', name: 'bash', arguments: '{"command":"npm test"}' }),
    toolResult('call-g', 'ok\n'),
  ])
  const view = new TranscriptView(store, { showThinking: false, expandTools: false })
  const output = stripTerminalSequences(view.render(80).join('\n'))
  assert.match(output, /Bash npm test/)
  // Folded output is a count summary; the result text itself is only reachable
  // after expanding (and then within the preview budget).
  assert.match(output, /1 line returned/)
  assert.doesNotMatch(output, /^ok$/m)
  assertWidths(view, [24, 40, 80])
})

test('live text renders directly, with no empty attempt row or settlement layout jump', () => {
  for (const showThinking of [false, true]) {
    const store = newStore([])
    // Layout is under test, not elapsed time: pin the renderer clock so a
    // millisecond crossed between synthetic live and untimed settlement frames
    // cannot produce a spurious "Thought for 1ms" comparison. Timing has its own tests.
    const view = new TranscriptView(store, { showThinking, expandTools: false, now: () => 0, thinkingLiveTimerMs: 0 })
    store.handle({ type: 'stream_start', sessionId: 's1', attemptId: 'plain-live', revision: 1, turn: 1, step: 1 })
    assert.deepEqual(view.render(80), [], 'waiting for the first chunk adds no transcript placeholder')
    store.handle({ type: 'stream_chunk', sessionId: 's1', attemptId: 'plain-live', revision: 2, index: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'private reasoning' } })
    store.handle({ type: 'stream_chunk', sessionId: 's1', attemptId: 'plain-live', revision: 3, index: 1, chunk: { type: 'text-delta', index: 1, text: 'Hello **streaming** 中文 😀' } })
    const widths = [32, 80]
    const live = widths.map(width => stripTerminalSequences(view.render(width).join('\n')))
    for (const content of live) {
      assert.match(content, /Hello streaming/)
      assert.doesNotMatch(content, /Streaming attempt|Attempt committed|◌/)
      assert.equal(content.includes('private reasoning'), showThinking)
    }
    store.handle({ type: 'stream_end', sessionId: 's1', attemptId: 'plain-live', revision: 4, outcome: 'committed', seq: 2 })
    assert.deepEqual(widths.map(width => stripTerminalSequences(view.render(width).join('\n'))), live, 'waiting for settlement does not add a debug header')
    store.handle({ type: 'session_event', sessionId: 's1', event: assistant(2, 'Hello **streaming** 中文 😀', 'private reasoning') })
    assert.equal(store.hasLiveAttempt, false)
    assert.deepEqual(widths.map(width => stripTerminalSequences(view.render(width).join('\n'))), live, 'settlement changes bookkeeping, not the visible response layout')
  }
})

test('removing streaming diagnostics still marks discarded and unconfirmed responses', () => {
  for (const outcome of ['abandoned', 'closed'] as const) {
    const store = newStore([])
    const view = new TranscriptView(store, { showThinking: false, expandTools: false })
    store.handle({ type: 'stream_start', sessionId: 's1', attemptId: 'unfinished', revision: 1, turn: 1, step: 1 })
    store.handle({ type: 'stream_chunk', sessionId: 's1', attemptId: 'unfinished', revision: 2, index: 0, chunk: { type: 'text-delta', index: 0, text: 'partial, not final' } })
    if (outcome === 'closed') store.handle({ type: 'closed', code: 1 })
    else store.handle({ type: 'stream_end', sessionId: 's1', attemptId: 'unfinished', revision: 3, outcome: 'abandoned' })
    const content = stripTerminalSequences(view.render(80).join('\n'))
    assert.match(content, /partial, not final/)
    assert.match(content, outcome === 'closed' ? /Response result unknown/ : /Incomplete response/)
    assert.match(content, /◌/)
    assert.equal(store.items.some(item => item.kind === 'assistant'), false)
  }
})

test('error notices follow the CC API-error layout and stay red', () => {
  const store = newStore([])
  const view = new TranscriptView(store, { showThinking: false, expandTools: false })
  store.report('agent error: 400 event:error\ndata:{"code":"InvalidParameter"}', 'error')
  store.report('Could not start DSH: synthetic startup failure', 'error')
  store.report('Reloaded settings, keybindings and DSH configuration.', 'info')
  const lines = view.render(80)
  const plain = lines.map(line => stripTerminalSequences(line))
  const red = '\x1b[38;2;255;123;114m'
  // The bridge's `agent error:` wire prefix becomes CC's `API Error` label.
  assert.equal(plain[0], '● API Error: 400 event:error')
  assert.ok(lines[0]!.startsWith(red + '● '), 'the marker and headline are red')
  // The message detail is indented to the marker width, not an elbow row.
  assert.equal(plain[1], '  data:{"code":"InvalidParameter"}')
  assert.ok(lines[1]!.startsWith('  ' + red), 'the detail row keeps the error red')
  assert.ok(plain.every(line => !line.includes('⎿')), 'errors no longer render as tool-elbow rows')
  // Other error notices keep their own text under the same marker.
  const failure = plain.findIndex(line => line.startsWith('● Could not start DSH:'))
  assert.ok(failure > 0)
  assert.ok(lines[failure]!.startsWith(red + '● '))
  // Info notices keep the quiet muted bullet style.
  const info = plain.findIndex(line => line.startsWith('· Reloaded settings'))
  assert.ok(info > 0)
  assert.ok(!lines[info]!.includes(red), 'info notices are not red')
  for (const width of [24, 40, 80, 120]) {
    for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}`)
  }
})

test('tool cards render one aligned elbow row and a consistent header column', () => {
  const flags = { showThinking: false, expandTools: false }
  const base = {
    kind: 'tool' as const, id: 't1', callId: 'c1', name: 'bash', arguments: '{}',
    status: 'done' as const, resultText: '', resultImages: 0, resultIsError: false,
    meta: undefined, version: 1,
  }
  const terminal = {
    ...base,
    presentation: {
      call: { card: 'terminal', title: "grep -n 'stdio' src/backend/client.ts", description: 'Confirm how the client spawns the bridge', diffs: [], contentText: '' },
      result: { card: 'terminal', output: '164:    this.spawn()\n192:      stdio:', exitCode: 0, diffs: [], contentText: '' },
    },
  }
  const read = {
    ...base, id: 't2', name: 'read',
    presentation: {
      call: { card: 'generic', title: 'Read /tmp/runtime/bridge.mjs (610 - 709)', diffs: [], contentText: '' },
      result: { card: 'read', path: 'runtime/bridge.mjs', offset: 610, totalLines: 2596, lang: 'js', lines: [{ number: 610, text: 'client-side write' }], diffs: [], contentText: '' },
    },
  }
  const lines = [
    ...createItemBlock(terminal, flags).render(84),
    ...createItemBlock(read, flags).render(84),
  ].map(line => stripTerminalSequences(line))
  // Exactly one elbow per tool card: the description (or first body row) owns it,
  // later body rows align under it instead of repeating the marker.
  const elbows = lines.filter(line => line.startsWith('  ⎿  '))
  assert.equal(elbows.length, 2, 'one elbow per tool card')
  assert.equal(lines[0], '⏺ Bash grep -n \'stdio\' src/backend/client.ts')
  assert.equal(lines[1], '  ⎿  Confirm how the client spawns the bridge')
  // Folded results are one-line counts; captured output and exit code belong to
  // the expanded Input/Output view.
  assert.match(lines[2] ?? '', /2 lines returned/)
  const readHeader = lines.indexOf('⏺ Read /tmp/runtime/bridge.mjs (610 - 709)')
  assert.ok(readHeader >= 0, 'the native read title is the header once')
  assert.equal(lines[readHeader + 1], '  ⎿  1 line loaded')
  for (const width of [24, 40, 84, 120]) {
    for (const item of [terminal, read]) {
      for (const line of createItemBlock(item, flags).render(width)) {
        assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)}`)
      }
    }
  }
})
