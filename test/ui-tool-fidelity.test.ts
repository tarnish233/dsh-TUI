import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth } from '#pi-tui'
import type { ToolTranscriptItem } from '../src/state/transcript.ts'
import type { TranscriptViewOptions } from '../src/ui/blocks.ts'
import { ToolBlock } from '../src/ui/tool-block.ts'
import { renderDiffBlock } from '../src/ui/tool-diff.ts'
import {
  toolAppliedDiffs,
  toolCopyText,
  toolInputText,
  toolOutputText,
  toolProposedDiffs,
} from '../src/ui/tool-io.ts'
import { clearToolExpansion } from '../src/ui/tool-expansion.ts'

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

function flags(overrides: Partial<TranscriptViewOptions> = {}): TranscriptViewOptions {
  return {
    showThinking: false,
    expandTools: false,
    expandedInputMaxLines: 5,
    expandedOutputMaxLines: 10,
    toolLabelClip: 0,
    diffViewMode: 'auto',
    diffIndicatorMode: 'bars',
    diffSplitMinWidth: 120,
    editDiffCollapsedLines: 24,
    writeDiffCollapsedLines: 0,
    diffWordWrap: true,
    screen: 'inline',
    onRenderRequest: () => {},
    ...overrides,
  }
}

const plain = (block: { render(width: number): string[] }, width = 100): string =>
  block.render(width).map(line => stripTerminalSequences(line)).join('\n')

// ---------------------------------------------------------------------------
// 1. Oversized hunks

test('oversized hunks keep change facts and complete before/after without LCS', () => {
  clearToolExpansion()
  const oldText = `OLD_START\n${'o'.repeat(120_000)}\nOLD_END`
  const newText = `NEW_START\n${'n'.repeat(120_000)}\nNEW_END`
  const huge = { path: 'src/huge.ts', oldText, newText }
  const rendered = renderDiffBlock([huge], 80, {
    viewMode: 'unified',
    indicatorMode: 'bars',
    splitMinWidth: 120,
    wordWrap: true,
    expanded: true,
    collapsedLines: 24,
  })
  assert.equal(rendered.oversized, true)
  assert.deepEqual(rendered.lines, [], 'no LCS rows are materialized')

  const item = tool({ name: 'edit', arguments: '{"file_path":"src/huge.ts"}', resultText: 'Updated src/huge.ts', meta: { diffs: [huge] } })
  const folded = plain(new ToolBlock(item, flags()))
  assert.match(folded, /Changes present for src\/huge\.ts · hunk too large to count precisely/)
  assert.doesNotMatch(folded, /No file changes|No applied file changes observed/)
  const open = plain(new ToolBlock(item, flags({ expandTools: true })))
  assert.match(open, /Changes present for src\/huge\.ts · hunk too large to count precisely/)
  assert.match(open, /\(diff too large to display\)/)

  const output = toolOutputText(item)
  assert.match(output, /hunk too large for line diff/)
  assert.ok(output.includes(oldText), 'complete native before text survives')
  assert.ok(output.includes(newText), 'complete native after text survives')

  const copied = toolCopyText(item, 'output')
  assert.match(copied, /Structured diff \(source, no line-diff recomputation\):/)
  assert.ok(copied.includes(oldText))
  assert.ok(copied.includes(newText))
  assert.doesNotMatch(copied, /^\+ Old|^- Old/m, 'copy does not imply a recomputed line diff')
})

// ---------------------------------------------------------------------------
// 2. Applied vs proposed / Created only for all-new write

test('a done call with only a call-side proposal keeps it as unapplied input', () => {
  clearToolExpansion()
  const item = tool({
    name: 'edit',
    arguments: '{"file_path":"src/a.ts"}',
    resultText: 'cached caption only',
    presentation: {
      call: { card: 'diff', title: 'Edit src/a.ts', diffs: [{ path: 'src/a.ts', oldText: 'a\n', newText: 'b\n' }] },
      result: { card: 'generic', content: [{ type: 'text', text: 'cached caption only' }] },
    },
  })
  assert.deepEqual(toolAppliedDiffs(item), [])
  assert.equal(toolProposedDiffs(item).length, 1)
  assert.doesNotMatch(plain(new ToolBlock(item, flags())), /Updated|Created/)
  const expanded = plain(new ToolBlock(item, flags({ expandTools: true })))
  assert.match(expanded, /Requested changes \(input preview, not execution result\):/)
  assert.match(expanded, /src\/a\.ts/)
  assert.match(expanded, /No applied diff hunk was forwarded/)
  assert.doesNotMatch(expanded, /Updated src\/a\.ts|Created src\/a\.ts/)

  const proposed = tool({
    name: 'edit',
    arguments: '{"file_path":"src/a.ts"}',
    status: 'proposed',
    presentation: { call: { card: 'diff', title: 'Edit src/a.ts', diffs: [{ path: 'src/a.ts', oldText: 'a\n', newText: 'b\n' }] } },
  })
  assert.match(toolInputText(proposed), /Requested changes \(not applied yet\):/)
  const running = tool({
    name: 'edit',
    arguments: '{"file_path":"src/a.ts"}',
    status: 'running',
    presentation: { call: { card: 'diff', title: 'Edit src/a.ts', diffs: [{ path: 'src/a.ts', oldText: 'a\n', newText: 'b\n' }] } },
  })
  assert.match(toolInputText(running), /Requested changes \(input preview, not execution result\):/)
})

test('errors never present a forwarded result hunk as applied', () => {
  clearToolExpansion()
  const item = tool({
    name: 'edit',
    arguments: '{"file_path":"src/a.ts"}',
    status: 'error',
    resultIsError: true,
    resultText: 'write failed',
    error: { name: 'ToolError', code: 'E_WRITE', reason: 'disk full' },
    meta: { diffs: [{ path: 'src/a.ts', oldText: 'a\n', newText: 'b\n' }] },
  })
  assert.deepEqual(toolAppliedDiffs(item), [])
  const rendered = plain(new ToolBlock(item, flags({ expandTools: true })))
  assert.match(rendered, /disk full/)
  assert.match(rendered, /Reported diff source \(tool error; application status unconfirmed\)/)
  assert.doesNotMatch(rendered, /Updated src\/a\.ts|Created src\/a\.ts/)
  const copied = toolCopyText(item, 'output')
  assert.match(copied, /Reported diff source \(tool error; application status unconfirmed\):/)
  assert.match(copied, /Before:\na/)
  assert.match(copied, /After:\nb/)
})

test('multi-file Write says Created only when every hunk has no previous content', () => {
  clearToolExpansion()
  const created = tool({
    name: 'write',
    arguments: '{"file_path":"src/a.ts"}',
    meta: { diffs: [
      { path: 'src/a.ts', oldText: null, newText: 'a\n' },
      { path: 'src/b.ts', oldText: null, newText: 'b\n' },
    ] },
  })
  assert.match(plain(new ToolBlock(created, flags())), /Created 2 files with 2 additions and 0 removals/)
  const mixed = tool({
    name: 'write',
    arguments: '{"file_path":"src/a.ts"}',
    meta: { diffs: [
      { path: 'src/a.ts', oldText: null, newText: 'a\n' },
      { path: 'src/b.ts', oldText: 'old\n', newText: 'b\n' },
    ] },
  })
  const mixedText = plain(new ToolBlock(mixed, flags()))
  assert.match(mixedText, /Updated 2 files/)
  assert.doesNotMatch(mixedText, /Created 2 files/)
})

test('empty or invalid diff arrays never create a fake 0-file diff', () => {
  clearToolExpansion()
  const empty = tool({
    name: 'edit',
    arguments: '{"file_path":"src/a.ts"}',
    resultText: 'caption',
    presentation: { result: { card: 'diff', diffs: [] } },
    meta: { diffs: [] },
  })
  assert.deepEqual(toolAppliedDiffs(empty), [])
  const text = plain(new ToolBlock(empty, flags({ expandTools: true })))
  assert.match(text, /caption/)
  assert.doesNotMatch(text, /diff 0 files|No file changes/)
  assert.equal(toolCopyText(empty, 'output'), 'caption')

  const invalid = tool({
    name: 'edit',
    arguments: '{"file_path":"src/a.ts"}',
    resultText: 'caption',
    meta: { diffs: [{ path: 'src/a.ts' }, { path: 42, oldText: null, newText: 'x' }] },
  })
  assert.deepEqual(toolAppliedDiffs(invalid), [])
  assert.doesNotMatch(plain(new ToolBlock(invalid, flags())), /diff|Updated|Created/)
})

// ---------------------------------------------------------------------------
// 3. Duplicate native previews / annotations

test('native previews never duplicate the most complete durable text', () => {
  clearToolExpansion()
  const terminal = tool({
    name: 'bash',
    arguments: '{"command":"run"}',
    resultText: 'prefix\nfull-tail',
    resultContent: [{ type: 'text', text: 'prefix\nfull-tail' }],
    presentation: { result: { card: 'terminal', output: 'prefix', exitCode: 0 } },
  })
  const terminalOutput = toolOutputText(terminal)
  assert.equal(terminalOutput.match(/prefix/g)?.length, 1)
  assert.match(terminalOutput, /full-tail/)
  assert.equal(terminalOutput.match(/exit code 0/g)?.length, 1)

  const generic = tool({
    name: 'custom',
    arguments: '{}',
    resultText: 'same body',
    resultContent: [{ type: 'text', text: 'same body' }],
    presentation: { result: { card: 'generic', content: [{ type: 'text', text: 'same body' }] } },
  })
  assert.equal(toolOutputText(generic).match(/same body/g)?.length, 1)

  const counted = tool({ name: 'bash', arguments: '{"command":"run"}', resultText: 'one\ntwo\nthree\nfour', presentation: { result: { card: 'terminal', output: 'one\ntwo' } } })
  assert.match(plain(new ToolBlock(counted, flags())), /4 lines returned/)
})

test('DSH truncation annotations and display budgets stay distinct and deduped', () => {
  clearToolExpansion()
  const item = tool({
    name: 'bash',
    arguments: '{"command":"run"}',
    resultText: 'one\ntwo',
    rawResult: { truncated: true },
    resultContent: [{ type: 'text', text: 'one\ntwo' }],
    presentation: { result: { card: 'terminal', output: 'one\ntwo', truncated: true, exitCode: 1 } },
  })
  const output = toolOutputText(item)
  assert.equal(output.match(/native terminal output truncated/g)?.length, 1)
  assert.equal(output.match(/durable result truncated/g)?.length, 1)
  assert.match(output, /native terminal output truncated/)
  assert.match(output, /durable result truncated/)
  const expanded = plain(new ToolBlock(item, flags({ expandTools: true, expandedOutputMaxLines: 1 })))
  assert.match(expanded, /more lines/, 'display budget text is not a native truncation claim')
  assert.doesNotMatch(expanded, /truncated by display|display truncated/)
})

test('durable resultText survives beside native read/search/web rows when it is not covered', () => {
  clearToolExpansion()
  const readLines = Array.from({ length: 500 }, (_, index) => ({ number: index + 1, text: `real line ${index + 1}` }))
  const item = tool({
    name: 'read',
    arguments: '{"file_path":"src/big.ts"}',
    resultText: 'read ok',
    resultContent: [{ type: 'text', text: 'read ok' }],
    presentation: { result: { card: 'read', path: 'src/big.ts', offset: 1, totalLines: 500, lines: readLines } },
  })
  const output = toolOutputText(item)
  assert.match(output, /500 real line 500/)
  assert.match(output, /read ok/)
  const expanded = plain(new ToolBlock(item, flags({ expandTools: true, expandedOutputMaxLines: 5000 })), 100)
  assert.match(expanded, /500 real line 500/)
  assert.match(expanded, /read ok/)

  const search = tool({
    name: 'grep',
    arguments: '{"pattern":"x"}',
    resultText: 'search ok',
    resultContent: [{ type: 'text', text: 'search ok' }],
    presentation: { result: { card: 'search', files: [{ path: 'src/a.ts', matches: [{ lineNumber: 7, line: 'x = 1' }] }], paths: [], truncated: false } },
  })
  const searchOutput = toolOutputText(search)
  assert.match(searchOutput, /7 x = 1/)
  assert.match(searchOutput, /search ok/)

  const web = tool({
    name: 'webfetch',
    arguments: '{"url":"https://example.test"}',
    resultText: 'fetch ok',
    resultContent: [{ type: 'text', text: 'fetch ok' }],
    presentation: { result: { card: 'web', kind: 'fetch', url: 'https://example.test', statusCode: 200 } },
  })
  const webOutput = toolOutputText(web)
  assert.match(webOutput, /https:\/\/example\.test/)
  assert.match(webOutput, /fetch ok/)
})

test('structured copy includes native read/search/web sources plus uncovered durable text', () => {
  const read = tool({
    name: 'read',
    arguments: '{"file_path":"src/big.ts"}',
    resultText: 'read ok',
    resultContent: [{ type: 'text', text: 'read ok' }],
    presentation: { result: { card: 'read', path: 'src/big.ts', offset: 1, totalLines: 500, lines: [
      { number: 1, text: 'first row' },
      { number: 500, text: 'last row' },
    ] } },
  })
  const readCopy = toolCopyText(read, 'output')
  assert.match(readCopy, /read ok/)
  assert.match(readCopy, /Native read card \(source\):/)
  assert.match(readCopy, /500 last row/)
  assert.match(readCopy, /of 500/)

  const search = tool({
    name: 'grep',
    arguments: '{"pattern":"x"}',
    resultText: 'search ok',
    presentation: { result: { card: 'search', files: [{ path: 'src/a.ts', matches: [{ lineNumber: 7, line: 'x = 1' }] }], paths: [], truncated: false } },
  })
  const searchCopy = toolCopyText(search, 'output')
  assert.match(searchCopy, /search ok/)
  assert.match(searchCopy, /Native search card \(source\):/)
  assert.match(searchCopy, /7 x = 1/)

  const web = tool({
    name: 'webfetch',
    arguments: '{"url":"https://example.test"}',
    resultText: 'fetch ok',
    presentation: { result: { card: 'web', kind: 'fetch', url: 'https://example.test', statusCode: 200 } },
  })
  const webCopy = toolCopyText(web, 'output')
  assert.match(webCopy, /fetch ok/)
  assert.match(webCopy, /Native web card \(source\):/)
  assert.match(webCopy, /HTTP 200/)
})

test('ordinary custom JSON data strings are copied; only recognizable binary is omitted', () => {
  const item = tool({
    name: 'custom',
    arguments: '{}',
    resultText: '',
    resultContent: [
      { type: 'json', data: 'ordinary text payload that must survive' },
      { type: 'image', mimeType: 'image/png', data: 'A'.repeat(200) },
      { type: 'binary', data: 'B'.repeat(200) },
    ],
  })
  const copied = toolCopyText(item, 'output')
  assert.match(copied, /ordinary text payload that must survive/)
  assert.doesNotMatch(copied, /A{200}|B{200}/)
  assert.match(copied, /\[image\].*no attachment ref; not viewable/)
})

test('read totalLines is metadata, not the returned line count', () => {
  clearToolExpansion()
  const item = tool({
    name: 'read',
    arguments: '{"file_path":"src/a.ts"}',
    presentation: { result: { card: 'read', path: 'src/a.ts', offset: 120, totalLines: 400, lines: [
      { number: 120, text: 'a' },
      { number: 121, text: 'b' },
    ] } },
  })
  assert.match(plain(new ToolBlock(item, flags())), /2 lines loaded/)
  assert.doesNotMatch(plain(new ToolBlock(item, flags())), /400 lines loaded/)
  assert.match(toolOutputText(item), /\(120-121 of 400\)/)
})

// ---------------------------------------------------------------------------
// 4. Empty native cards

test('empty search, read and web cards are valid and stay honest', () => {
  clearToolExpansion()
  const emptySearch = tool({
    name: 'grep',
    arguments: '{"pattern":"none"}',
    presentation: { result: { card: 'search', files: [], paths: [], truncated: false } },
  })
  const searchText = plain(new ToolBlock(emptySearch, flags()))
  assert.match(searchText, /0 matches in 0 files/)
  assert.match(toolOutputText(emptySearch), /0 matches in 0 files/)
  assert.doesNotMatch(searchText, /capped at/)

  const truncatedSearch = tool({
    name: 'grep',
    arguments: '{"pattern":"x"}',
    presentation: { result: { card: 'search', files: [{ path: 'a.ts', matches: [{ lineNumber: 1, line: 'x' }] }], paths: [], truncated: true } },
  })
  const truncatedText = plain(new ToolBlock(truncatedSearch, flags()))
  assert.match(truncatedText, /1 match in 1 file \(truncated\)/)
  assert.match(toolOutputText(truncatedSearch), /1 match in 1 file \(truncated\)/)
  assert.doesNotMatch(truncatedText, /capped at 1\b/)

  const emptyRead = tool({
    name: 'read',
    arguments: '{"file_path":"src/empty.ts"}',
    presentation: { result: { card: 'read', path: 'src/empty.ts', offset: 0, totalLines: 12, lines: [] } },
  })
  const readText = toolOutputText(emptyRead)
  assert.match(readText, /Read src\/empty\.ts \(no lines returned of 12\)/)
  assert.doesNotMatch(readText, /1-1/)
  assert.match(plain(new ToolBlock(emptyRead, flags())), /0 lines loaded/)

  const unsafeLines = tool({
    name: 'read',
    arguments: '{"file_path":"src/a.ts"}',
    presentation: { result: { card: 'read', path: 'src/a.ts', offset: 1.5, totalLines: -1, lines: [
      { number: 1.5, text: 'invalid' },
      { number: -2, text: 'invalid' },
      { number: 7, text: 'valid' },
    ] } },
  })
  const safeText = toolOutputText(unsafeLines)
  assert.match(safeText, /7 valid/)
  assert.doesNotMatch(safeText, /invalid|1\.5|-2/)
  assert.doesNotMatch(safeText, /of -1/)

  const emptyUrl = tool({
    name: 'webfetch',
    arguments: '{"url":""}',
    presentation: { result: { card: 'web', kind: 'fetch', url: '', statusCode: 204 } },
  })
  const webText = toolOutputText(emptyUrl)
  assert.equal(webText.startsWith('\n'), false, 'no leading blank line for an empty URL')
  assert.match(webText, /^HTTP 204/)
  assert.match(plain(new ToolBlock(emptyUrl, flags())), /Fetch · HTTP 204/)
})

// ---------------------------------------------------------------------------
// 5. Structured copy / attachments

test('structured copy keeps plain text exact and adds complete sources without binary dumps', () => {
  const bigBase64 = 'A'.repeat(20_000)
  const mixed = tool({
    name: 'custom',
    arguments: '{}',
    resultText: 'caption text',
    resultContent: [
      { type: 'text', text: 'caption text' },
      { type: 'image', mimeType: 'image/png', name: 'shot.png', data: bigBase64 },
      { type: 'file', path: '/tmp/report.txt', mediaType: 'text/plain' },
      { type: 'custom', kind: 'artifact', data: bigBase64, label: 'custom payload' },
    ],
  })
  const copied = toolCopyText(mixed, 'output')
  assert.ok(copied.startsWith('caption text'))
  assert.match(copied, /Attachments \/ structured blocks \(references only\):/)
  assert.match(copied, /\[image\].*shot\.png.*no attachment ref; not viewable/)
  assert.match(copied, /\[file\].*not read/)
  assert.match(copied, /\[custom\]\s*\{[\s\S]*binary omitted/)
  assert.equal(copied.includes(bigBase64), false, 'binary payload is never copied')
})

test('pure binary, diff+message, empty diff and native-truncated copies stay lossless but bounded', () => {
  const pdf = tool({
    name: 'custom',
    arguments: '{}',
    resultText: '',
    resultContent: [{ type: 'image', mimeType: 'application/pdf', data: 'QUJDREVGRw==' }],
  })
  const binary = toolCopyText(pdf, 'output')
  assert.match(binary, /\[image\].*application\/pdf/)
  assert.match(binary, /no attachment ref; not viewable/)
  assert.doesNotMatch(binary, /QUJDREVGRw==/)

  const diffItem = tool({
    name: 'edit',
    arguments: '{"file_path":"src/a.ts"}',
    resultText: 'Updated src/a.ts',
    resultContent: [{ type: 'text', text: 'Updated src/a.ts' }],
    meta: { diffs: [{ path: 'src/a.ts', oldText: 'before\n', newText: 'after\n' }] },
  })
  const diffCopy = toolCopyText(diffItem, 'output')
  assert.ok(diffCopy.startsWith('Updated src/a.ts'))
  assert.match(diffCopy, /Structured diff \(source, no line-diff recomputation\):/)
  assert.match(diffCopy, /Before:\nbefore/)
  assert.match(diffCopy, /After:\nafter/)

  const emptyDiff = tool({ name: 'edit', arguments: '{}', resultText: 'caption', meta: { diffs: [] } })
  assert.equal(toolCopyText(emptyDiff, 'output'), 'caption')

  const truncated = tool({
    name: 'bash',
    arguments: '{"command":"x"}',
    resultText: 'x',
    resultContent: [{ type: 'text', text: 'x' }],
    rawResult: { truncated: true },
    presentation: { result: { card: 'terminal', output: 'x', truncated: true } },
  })
  const annotations = toolOutputText(truncated)
  assert.equal(annotations.match(/native terminal output truncated/g)?.length, 1)
  assert.equal(annotations.match(/durable result truncated/g)?.length, 1)
})

// ---------------------------------------------------------------------------
// 6. Split layout edges

test('split rules align with body separators and 40..56-column layouts never overflow', () => {
  const one = { path: 'src/a.ts', oldText: 'const a = 0\nconst b = 1\n', newText: 'const a = 1\nconst b = 1\n' }
  for (let width = 40; width <= 56; width += 1) {
    for (const viewMode of ['auto', 'split'] as const) {
      const result = renderDiffBlock([one], width, {
        viewMode,
        indicatorMode: 'bars',
        splitMinWidth: 40,
        wordWrap: true,
        expanded: true,
        collapsedLines: 24,
        layoutWidth: width,
      })
      for (const line of result.lines) assert.ok(visibleWidth(line) <= width, `width ${width}: ${visibleWidth(line)}`)
    }
  }
  for (const width of [120, 160]) {
    const result = renderDiffBlock([one], width, {
      viewMode: 'auto',
      indicatorMode: 'bars',
      splitMinWidth: 120,
      wordWrap: true,
      expanded: true,
      collapsedLines: 24,
    })
    const rows = result.lines.map(line => stripTerminalSequences(line))
    const body = rows.find(line => line.includes('│') && line.includes('const a = 0'))
    const rule = rows.find(line => line.includes('┼'))
    assert.ok(body !== undefined && rule !== undefined)
    assert.equal(visibleWidth(rule!), width, 'the horizontal rule spans the full column width')
    assert.equal(rule!.indexOf('┼'), body!.indexOf('│'), 'the rule centre sits under the body separator')
  }
})

// ---------------------------------------------------------------------------
// 7. Hints

test('inline overflow hints point to the tools inspector; fullscreen keeps the call-specific click', () => {
  clearToolExpansion()
  const item = tool({ name: 'bash', arguments: JSON.stringify({ command: 'x'.repeat(500) }), resultText: 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven' })
  const inline = plain(new ToolBlock(item, flags({ expandTools: true, hints: { expand: 'ctrl+o', toolsDetails: 'ctrl+x ctrl+o' } })))
  assert.match(inline, /ctrl\+x ctrl\+o to inspect tools/)
  assert.doesNotMatch(inline, /for details|click to show details/)
  const fullscreen = plain(new ToolBlock(item, flags({ expandTools: true, hints: { toolsDetails: 'ctrl+x ctrl+o' }, screen: 'fullscreen' })))
  assert.match(fullscreen, /click to show details/)
})

// ---------------------------------------------------------------------------
// 8. Duration 0 semantics

test('a measured 0ms duration is printed and a missing duration is not', () => {
  clearToolExpansion()
  const measured = tool({ name: 'bash', arguments: '{"command":"x"}', resultText: 'ok', durationMs: 0 })
  assert.match(plain(new ToolBlock(measured, flags())), /0ms/)
  const missing = tool({ name: 'bash', arguments: '{"command":"x"}', resultText: 'ok' })
  assert.doesNotMatch(plain(new ToolBlock(missing, flags())), /\b\d+(?:\.\d+)?ms\b/)
})