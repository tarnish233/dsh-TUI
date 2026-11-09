import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import type { ToolTranscriptItem } from '../src/state/transcript.ts'
import {
  getToolSummary,
  toolCopyText,
  toolInputText,
  toolOutputText,
} from '../src/ui/tool-io.ts'

function tool(overrides: Partial<ToolTranscriptItem> & Pick<ToolTranscriptItem, 'name' | 'arguments'>): ToolTranscriptItem {
  return {
    kind: 'tool',
    id: `tool:${overrides.callId ?? 'call-1'}`,
    callId: 'call-1',
    status: 'done',
    resultText: '',
    resultImages: 0,
    resultIsError: false,
    meta: undefined,
    version: 1,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Summary

test('summary prefers native titles, includes the label once, and clips by config', () => {
  const terminal = tool({
    name: 'bash',
    arguments: '{"command":"npm test"}',
    durationMs: 1_250,
    presentation: {
      call: { card: 'terminal', title: 'npm test', description: 'Run the suite', cwd: '/tmp/work' },
      result: { card: 'terminal', title: 'npm test', output: 'ok\n', exitCode: 0 },
    },
  })
  assert.deepEqual(getToolSummary(terminal, '/tmp/work', 0), {
    label: 'Bash',
    text: 'Bash npm test',
    // The header paints `label` + real space + `detail`, never a re-split text.
    detail: 'npm test',
    durationMs: 1_250,
  })

  const read = tool({
    name: 'read',
    arguments: '{"file_path":"/tmp/work/src/a.ts","offset":10,"limit":5}',
    presentation: { call: { card: 'generic', title: 'Read src/a.ts' } },
    durationMs: 12,
  })
  const summary = getToolSummary(read, '/tmp/work', 0)
  assert.equal(summary.label, 'Read')
  assert.equal(summary.text, 'Read src/a.ts')
  assert.equal(summary.durationMs, undefined, 'non-shell cards never advertise a duration')

  // A native verb that differs from the label keeps both, once each.
  const edit = tool({
    name: 'edit',
    arguments: '{"file_path":"src/a.ts"}',
    presentation: { call: { card: 'diff', title: 'Edit src/a.ts' } },
  })
  assert.equal(getToolSummary(edit, '/tmp/work', 0).text, 'Update src/a.ts')

  // No native title: the real name and real arguments are the fallback.
  const fallback = tool({ name: 'grep', arguments: '{"pattern":"needle","path":"src"}' })
  assert.equal(getToolSummary(fallback, '/tmp/work', 0).text, 'Search "needle", src')
  assert.equal(getToolSummary(fallback, '/tmp/work', 12).text.length, 12)
  assert.ok(getToolSummary(fallback, '/tmp/work', 12).text.endsWith('…'))
})

// ---------------------------------------------------------------------------
// Input

test('input formatting is complete, field-first and never applies the 8k preview cap', () => {
  const large = 'x'.repeat(9_000)
  const item = tool({
    name: 'bash',
    arguments: JSON.stringify({ command: large, cwd: '/tmp/work', note: 'line one\nline two', nested: { a: [1, 2] } }),
  })
  const input = toolInputText(item)
  assert.ok(input.length > 9_000, 'the complete argument value survives')
  assert.match(input, /^command:/)
  assert.match(input, /cwd: \/tmp\/work/)
  assert.match(input, /note:\n  line one\n  line two/)
  assert.match(input, /nested:\n  \{\n    "a": \[/)
  assert.equal(toolCopyText(item, 'input'), item.arguments, 'copy returns the exact original string')

  const malformed = tool({ name: 'bash', arguments: '{"command": "unterminated' })
  assert.match(toolInputText(malformed), /unterminated/)
  assert.equal(toolCopyText(malformed, 'input'), malformed.arguments)
})

// ---------------------------------------------------------------------------
// Output

test('output keeps >16k real text and copy returns the raw result without a preview budget', () => {
  const long = Array.from({ length: 500 }, (_, index) => `output line ${index + 1} ${'y'.repeat(40)}`).join('\n')
  const item = tool({ name: 'bash', arguments: '{"command":"run"}', resultText: long, resultContent: [{ type: 'text', text: long }] })
  const output = toolOutputText(item)
  assert.ok(output.length > 16_000)
  assert.match(output, /output line 500/)
  assert.equal(toolCopyText(item, 'output'), long)
})

test('native terminal, read, search, web and diff cards retain their real facts', () => {
  const terminal = tool({
    name: 'bash',
    arguments: '{"command":"false"}',
    resultText: 'failed',
    presentation: { result: { card: 'terminal', output: 'first\nsecond\n', exitCode: 2, signal: 'SIGTERM', truncated: true } },
  })
  const terminalText = toolOutputText(terminal)
  assert.match(terminalText, /first\nsecond/)
  assert.match(terminalText, /exit code 2/)
  assert.match(terminalText, /signal SIGTERM/)
  assert.match(terminalText, /output truncated/)

  const read = tool({
    name: 'read',
    arguments: '{"file_path":"src/b.ts"}',
    resultText: 'b.ts body',
    presentation: {
      result: {
        card: 'read',
        path: 'src/b.ts',
        offset: 120,
        totalLines: 400,
        lang: 'ts',
        truncated: true,
        lines: [{ number: 120, text: 'export const b = 2' }, { number: 121, text: 'export const c = 3' }],
      },
    },
  })
  const readText = toolOutputText(read)
  assert.match(readText, /Read src\/b\.ts \(120-121 of 400 · ts\)/)
  assert.match(readText, /120 export const b = 2/)
  assert.match(readText, /121 export const c = 3/)
  assert.doesNotMatch(readText, /^\s*1\s+1\s+/m, 'no invented absolute coordinates')

  const search = tool({
    name: 'grep',
    arguments: '{"pattern":"x"}',
    resultText: '2 matches',
    presentation: {
      result: {
        card: 'search',
        truncated: true,
        total: 50,
        files: [{ path: 'src/a.ts', matches: [{ lineNumber: 7, line: 'x = 1' }] }],
      },
    },
  })
  const searchText = toolOutputText(search)
  assert.match(searchText, /1 match in 1 file \(capped at 50\)/)
  assert.match(searchText, /src\/a\.ts/)
  assert.match(searchText, /7 x = 1/)

  const web = tool({
    name: 'websearch',
    arguments: '{"query":"dsh"}',
    resultText: 'answer',
    presentation: {
      result: {
        card: 'web',
        kind: 'search',
        truncated: true,
        answer: 'synthetic answer',
        sources: [{ url: 'https://example.test/a', title: 'Example', snippet: 'snippet' }],
      },
    },
  })
  const webText = toolOutputText(web)
  assert.match(webText, /1 source \(capped\)/)
  assert.match(webText, /synthetic answer/)
  assert.match(webText, /https:\/\/example\.test\/a/)

  const diff = tool({
    name: 'edit',
    arguments: '{"file_path":"src/a.ts"}',
    resultText: 'Updated src/a.ts.',
    meta: {
      diffs: [{ path: 'src/a.ts', oldText: 'const a = 0\n', newText: 'const a = 1\n' }],
    },
  })
  const diffText = toolOutputText(diff)
  assert.match(diffText, /diff src\/a\.ts/)
  assert.match(diffText, /- const a = 0/)
  assert.match(diffText, /\+ const a = 1/)
  assert.doesNotMatch(diffText, /^\s*\d+\s+\d*\s*[+-]/m, 'a hunk has no absolute file coordinates')
})

test('proposed, running and unknown calls expose no fabricated output', () => {
  for (const status of ['proposed', 'running', 'unknown'] as const) {
    const item = tool({
      name: 'bash',
      arguments: '{"command":"echo hi"}',
      status,
      resultText: 'stale bytes must not surface',
      presentation: { result: { card: 'terminal', output: 'stale bytes must not surface', exitCode: 0 } },
    })
    assert.equal(toolOutputText(item), '')
    assert.equal(toolCopyText(item, 'output'), '')
  }
})

test('errors and rejected results stay honest and keep their real detail', () => {
  const rejected = tool({
    name: 'webfetch',
    arguments: '{"url":"https://example.test"}',
    status: 'error',
    resultText: 'policy rejected the request',
    resultIsError: true,
    error: { name: 'ToolError', code: 'POLICY_REJECTED', reason: 'Permission denied by policy' },
    presentation: { result: { card: 'generic', content: [{ type: 'text', text: 'policy rejected the request' }] } },
  })
  const text = toolOutputText(rejected)
  assert.match(text, /Permission denied by policy/)
  assert.match(text, /policy rejected the request/)

  const errorFlag = tool({
    name: 'bash',
    arguments: '{"command":"false"}',
    status: 'done',
    resultText: 'exit 1',
    resultIsError: true,
    error: { name: 'ToolError', code: 'EXIT_1' },
  })
  assert.match(toolOutputText(errorFlag), /EXIT_1/)
  assert.match(toolOutputText(errorFlag), /exit 1/)

  const truncated = tool({
    name: 'bash',
    arguments: '{"command":"run"}',
    resultText: 'long bytes',
    rawResult: { truncated: true },
  })
  assert.match(toolOutputText(truncated), /result truncated/)
})

test('copy falls back to the original raw result envelope when no text block exists', () => {
  const item = tool({
    name: 'custom',
    arguments: '{"x":1}',
    resultText: '',
    rawResult: { content: [{ type: 'image', data: 'abc' }], meta: { truncated: true } },
  })
  const copied = toolCopyText(item, 'output')
  assert.match(copied, /"type": "image"/)
  assert.match(copied, /"truncated": true/)
})