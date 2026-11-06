import './helpers/truecolor.ts'
import { strict as assert } from 'node:assert'
import test from 'node:test'
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from '#pi-tui'
import type { ToolTranscriptItem } from '../src/state/transcript.ts'
import type { TranscriptViewOptions } from '../src/ui/blocks.ts'
import { createItemBlock } from '../src/ui/blocks.ts'
import { ToolBlock } from '../src/ui/tool-block.ts'
import { clearToolExpansion, isToolExpanded, setToolExpanded, toolExpansionKey } from '../src/ui/tool-expansion.ts'
import type { ToolDetailsRequest } from '../src/ui/tool-view.ts'

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

function mouse(type: TuiMouseEvent['type'], row: number, width = 80, height = 60, x = 2): TuiMouseEvent {
  return {
    type,
    button: 'left',
    x,
    y: row,
    screenX: x,
    screenY: row,
    width,
    height,
    shift: false,
    alt: false,
    ctrl: false,
    ...(type === 'click' ? { clickCount: 1 } : {}),
  }
}

function plain(block: { render(width: number): string[] }, width = 80): string[] {
  return block.render(width).map(line => stripTerminalSequences(line))
}

const lines = (count: number, prefix: string): string =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n')

// ---------------------------------------------------------------------------

test('folded cards show one count summary, the real shell duration and only real hints', () => {
  clearToolExpansion()
  const item = tool({
    name: 'bash',
    arguments: '{"command":"npm test"}',
    resultText: lines(14, 'result line'),
    durationMs: 1_234,
    presentation: { result: { card: 'terminal', output: lines(14, 'result line'), exitCode: 0 } },
  })
  const bare = plain(new ToolBlock(item, flags()))
  const bareText = bare.join('\n')
  assert.match(bareText, /14 lines returned/)
  assert.match(bareText, /1\.2s/)
  assert.doesNotMatch(bareText, /result line 1\b/, 'the folded card is not a 6-line preview')
  assert.doesNotMatch(bareText, /to expand|click to expand/, 'no key is invented without a real hint')

  const hinted = plain(new ToolBlock(item, flags({ hints: { expand: 'ctrl+o' } })))
  assert.match(hinted.join('\n'), /\(?ctrl\+o to expand\)?/)
  const remapped = plain(new ToolBlock(item, flags({ hints: { expand: 'alt+e' } })))
  assert.match(remapped.join('\n'), /alt\+e to expand/)
  assert.doesNotMatch(remapped.join('\n'), /ctrl\+o/)
  const fullscreen = plain(new ToolBlock(item, flags({ screen: 'fullscreen' })))
  assert.match(fullscreen.join('\n'), /click to expand/)

  const nonShell = tool({
    name: 'read',
    arguments: '{"file_path":"src/a.ts"}',
    resultText: 'ok',
    durationMs: 9_000,
    presentation: { result: { card: 'read', path: 'src/a.ts', offset: 1, totalLines: 1, lines: [{ number: 1, text: 'ok' }] } },
  })
  assert.doesNotMatch(plain(new ToolBlock(nonShell, flags({}))).join('\n'), /9\.0s/)
})

test('expanded cards honor the wrapped Input 5 / Output 10 budgets and expose precise details hitboxes', () => {
  clearToolExpansion()
  const longInput = JSON.stringify({ command: 'x'.repeat(400), note: 'n'.repeat(400) })
  const longOutput = lines(30, 'out line')
  const item = tool({ name: 'bash', arguments: longInput, resultText: longOutput })
  const seen: ToolDetailsRequest[] = []
  const block = new ToolBlock(item, flags({
    expandTools: true,
    hints: { expand: 'ctrl+o', toolsDetails: 'ctrl+x ctrl+o' },
    screen: 'fullscreen',
    onToolDetails: request => seen.push(request),
  }))
  const rows = plain(block)
  const text = rows.join('\n')
  assert.match(text, /├ Input/)
  assert.match(text, /└ Output/)
  assert.match(text, /more lines · click to show details/)
  const boxes = block.hitboxes()
  const inputMore = boxes.find(box => box.id === 'tool:call-1:input:more')
  const outputMore = boxes.find(box => box.id === 'tool:call-1:output:more')
  assert.ok(inputMore !== undefined)
  assert.ok(outputMore !== undefined)
  assert.equal(inputMore.claimPress, true)
  assert.equal(outputMore.claimPress, true)
  assert.match(rows[inputMore.startRow]!, /Input|more lines/)

  block.handleMouse(mouse('click', inputMore.startRow))
  block.handleMouse(mouse('click', outputMore.startRow))
  assert.deepEqual(seen, [
    { callId: 'call-1', section: 'input' },
    { callId: 'call-1', section: 'output' },
  ])
})

test('details clicks stay pinned through a repaint and body clicks remain click-only', () => {
  clearToolExpansion()
  const input = JSON.stringify({ command: 'z'.repeat(900) })
  const item = tool({ name: 'bash', arguments: input, resultText: lines(20, 'row') })
  const seen: ToolDetailsRequest[] = []
  const render = () => {}
  const block = new ToolBlock(item, flags({ expandTools: true, onToolDetails: request => seen.push(request), onRenderRequest: render }))
  block.render(80)
  const outputBox = block.hitboxes().find(box => box.id.endsWith(':output:more'))
  assert.ok(outputBox !== undefined)
  // Claim the press, then repaint with a new version that can move rows.
  assert.equal(block.handleMouse(mouse('press', outputBox.startRow))?.handled, true)
  block.update({ ...item, version: 2, resultText: lines(40, 'row'), presentation: { call: { card: 'terminal', title: 'run', description: 'row-shifting description' } } })
  block.render(80)
  block.handleMouse(mouse('click', outputBox.startRow))
  assert.deepEqual(seen, [{ callId: 'call-1', section: 'output' }])
  assert.equal(block.expanded, true, 'a details click is not a collapse')

  // Ordinary invalidate keeps the press pin too.
  const title = block.hitboxes().find(box => box.id.endsWith(':title'))
  assert.ok(title !== undefined)
  block.handleMouse(mouse('press', title.startRow))
  block.invalidate()
  block.render(80)
  block.handleMouse(mouse('click', title.startRow))
  assert.equal(block.expanded, false, 'the pinned title still collapses after a repaint')

  // Body: press/drag stay native (selection), an undragged click collapses.
  block.render(80)
  setToolExpanded(toolExpansionKey('call-1'), true)
  block.render(80)
  const body = block.hitboxes().find(box => box.id.endsWith(':body'))
  assert.ok(body !== undefined)
  assert.equal(body.claimPress, false)
  assert.equal(block.handleMouse(mouse('press', body.startRow + 1)), undefined)
  assert.equal(block.handleMouse(mouse('drag', body.startRow + 1)), undefined)
  block.handleMouse(mouse('click', body.startRow + 1))
  assert.equal(block.expanded, false, 'an undragged body click collapses the card')
})

test('group context owns expansion/collapse and never rewrites the local override', () => {
  clearToolExpansion()
  const item = tool({ name: 'bash', arguments: '{"command":"npm test"}', resultText: 'ok' })
  setToolExpanded(toolExpansionKey('call-1'), true)
  let groupExpanded = false
  let collapses = 0
  const block = new ToolBlock(item, flags())
  block.setToolGroupContext({
    key: 'group:g1',
    isExpanded: () => groupExpanded,
    collapse: () => { collapses += 1; groupExpanded = false },
  })
  assert.doesNotMatch(plain(block).join('\n'), /├ Input/, 'a collapsed group keeps the child folded')
  groupExpanded = true
  block.invalidate()
  const expandedRows = plain(block)
  assert.match(expandedRows.join('\n'), /├ Input/)
  const body = block.hitboxes().find(box => box.id.endsWith(':body'))
  assert.ok(body !== undefined)
  block.handleMouse(mouse('click', body.startRow + 1))
  assert.equal(collapses, 1)
  assert.equal(isToolExpanded(toolExpansionKey('call-1'), false), true, 'the child override survives a group collapse')

  // Leaving the group restores the child's own expansion state.
  block.setToolGroupContext(undefined)
  assert.match(plain(block).join('\n'), /├ Input/)

  // Group Output details remain independent of the group disclosure.
  const longOutput = tool({ name: 'bash', arguments: '{"command":"x"}', resultText: lines(30, 'row') })
  const seen: ToolDetailsRequest[] = []
  let group2 = true
  const child = new ToolBlock(longOutput, flags({ onToolDetails: request => seen.push(request) }))
  child.setToolGroupContext({ key: 'group:g2', isExpanded: () => group2, collapse: () => { group2 = false } })
  child.render(80)
  const outputMore = child.hitboxes().find(box => box.id.endsWith(':output:more'))
  assert.ok(outputMore !== undefined)
  // The group shifts child rows by its own `│ ` prefix; a full-row details
  // hitbox still resolves the Output section at any column inside it.
  child.handleMouse(mouse('click', outputMore.startRow, 80, 60, 50))
  assert.deepEqual(seen, [{ callId: 'call-1', section: 'output' }])
  assert.equal(group2, true, 'opening Output details does not collapse the group')
})

test('proposed, running, unknown and error cards never claim an executed result', () => {
  clearToolExpansion()
  const base = { name: 'write', arguments: '{"file_path":"src/a.ts","content":"x"}' } as const
  const proposed = plain(new ToolBlock(tool({ ...base, status: 'proposed' }), flags({ expandTools: true })))
    .join('\n')
  assert.match(proposed, /Proposed/)
  assert.match(proposed, /not run/i)
  assert.doesNotMatch(proposed, /Updated |Created |Running/)

  const running = plain(new ToolBlock(tool({ ...base, status: 'running', startedAt: 1_000 }), flags({ expandTools: true, now: () => 2_000 })))
    .join('\n')
  assert.match(running, /Running|running/)
  assert.match(running, /No result yet/)
  assert.doesNotMatch(running, /Updated |Created /)

  const unknown = plain(new ToolBlock(tool({ ...base, status: 'unknown' }), flags({ expandTools: true }))).join('\n')
  assert.match(unknown, /No result observed/)
  assert.doesNotMatch(unknown, /Updated |Created |Running/)

  const rejected = tool({
    ...base,
    status: 'error',
    resultIsError: true,
    resultText: 'write rejected',
    error: { name: 'ToolError', code: 'EACCES', reason: 'Permission denied' },
  })
  const rejectedRaw = new ToolBlock(rejected, flags({ expandTools: true })).render(80).join('\n')
  const rejectedText = stripTerminalSequences(rejectedRaw)
  assert.match(rejectedText, /Permission denied/)
  assert.match(rejectedText, /write rejected/)
  assert.doesNotMatch(rejectedText, /Updated |Created /)
  assert.match(rejectedRaw, /\x1b\[38;2;255;123;114m/, 'rejected detail keeps the error red')
})

test('native terminal/read/search cards keep exit codes, absolute lines and capped counts', () => {
  clearToolExpansion()
  const terminal = tool({
    name: 'bash',
    arguments: '{"command":"npm test"}',
    resultText: 'all good',
    presentation: {
      call: { card: 'terminal', title: 'npm test', description: 'Run the test suite' },
      result: { card: 'terminal', output: 'all good\n2 passing', exitCode: 0 },
    },
  })
  const terminalText = plain(new ToolBlock(terminal, flags({ expandTools: true })), 100).join('\n')
  assert.match(terminalText, /Bash npm test/)
  assert.match(terminalText, /Run the test suite/)
  assert.match(terminalText, /2 passing/)
  assert.match(terminalText, /exit code 0/)

  const read = tool({
    name: 'read',
    arguments: '{"file_path":"src/b.ts"}',
    resultText: 'b.ts body',
    presentation: {
      call: { card: 'generic', title: 'Read src/b.ts' },
      result: { card: 'read', path: 'src/b.ts', offset: 120, totalLines: 400, lang: 'ts', lines: [{ number: 120, text: 'export const b = 2' }] },
    },
  })
  const readText = plain(new ToolBlock(read, flags({ expandTools: true })), 100).join('\n')
  assert.match(readText, /120-120 of 400 · ts/)
  assert.match(readText, /120 export const b = 2/)

  const search = tool({
    name: 'grep',
    arguments: '{"pattern":"x"}',
    resultText: 'matches',
    presentation: {
      result: {
        card: 'search',
        truncated: true,
        total: 50,
        files: [{ path: 'src/a.ts', matches: [{ lineNumber: 7, line: 'x = 1' }] }],
      },
    },
  })
  const searchText = plain(new ToolBlock(search, flags())).join('\n')
  assert.match(searchText, /1 match in 1 file \(capped at 50\)/)
})

test('every tool card stays within widths 1/24/40/80/120/160', () => {
  clearToolExpansion()
  const samples = [
    tool({ name: 'bash', arguments: '{"command":"x".repeat(90)}', resultText: lines(40, 'row'), durationMs: 500 }),
    tool({ name: 'read', arguments: '{"file_path":"/tmp/work/src/a.ts"}', resultText: 'a', presentation: { result: { card: 'read', path: 'src/a.ts', offset: 1, totalLines: 3, lines: [{ number: 1, text: 'a'.repeat(200) }] } } }),
    tool({ name: 'edit', arguments: '{"file_path":"src/a.ts"}', resultText: 'Updated', meta: { diffs: [{ path: 'src/a.ts', oldText: 'a\nb\n', newText: 'a\nc\n' }] } }),
    tool({ name: 'write', arguments: '{"file_path":"src/new.ts","content":"x"}', resultText: 'Created', meta: { diffs: [{ path: 'src/new.ts', oldText: null, newText: 'x\n' }] } }),
    tool({ name: 'unknown_tool', arguments: '{"value":"中文😀"}', status: 'unknown' }),
    tool({ name: 'edit', arguments: '{"file_path":"src/a.ts"}', status: 'proposed', presentation: { call: { card: 'diff', title: 'Edit src/a.ts' } } }),
  ]
  for (const width of [1, 24, 40, 80, 120, 160]) {
    for (const expandTools of [false, true]) {
      for (const item of samples) {
        const block = new ToolBlock(item, flags({ expandTools, screen: 'fullscreen', hints: { expand: 'ctrl+o', toolsDetails: 'ctrl+x ctrl+o' } }))
        for (const line of block.render(width)) {
          assert.ok(visibleWidth(line) <= width, `width ${width} ${item.name}: ${visibleWidth(line)} ${JSON.stringify(stripTerminalSequences(line))}`)
        }
      }
    }
  }
})

test('the render cache key includes settings, hover and live duration', () => {
  clearToolExpansion()
  const item = tool({ name: 'bash', arguments: '{"command":"sleep 5"}', status: 'running', startedAt: 10_000 })
  const options = flags({ expandTools: true })
  let now = 10_500
  const block = new ToolBlock(item, { ...options, now: () => now })
  const first = block.render(80)
  now = 12_500
  const second = block.render(80)
  assert.notDeepEqual(second, first, 'live shell duration advances the frame')

  const settle = tool({ name: 'bash', arguments: '{"command":"x"}', resultText: lines(20, 'ok'), durationMs: 5 })
  const configured = new ToolBlock(settle, flags({ expandTools: true, expandedOutputMaxLines: 1 }))
  const narrow = plain(configured)
  ;(configured as unknown as { flags: TranscriptViewOptions }).flags.expandedOutputMaxLines = 10
  const wide = plain(configured)
  assert.notDeepEqual(wide, narrow, 'expandedOutputMaxLines participates in the cache key')

  const hovered = new ToolBlock(settle, flags({ hints: { expand: 'ctrl+o' } }))
  const before = hovered.render(80)
  hovered.handleMouse(mouse('move', 1, 80, 60, 2))
  const after = hovered.render(80)
  assert.notDeepEqual(after, before, 'hovering the summary repaints its hint')
})

test('clearMouse removes pointer state; a card without hitboxes cannot swallow clicks', () => {
  clearToolExpansion()
  const item = tool({ name: 'bash', arguments: '{"command":"x"}', resultText: 'ok' })
  const block = new ToolBlock(item, flags({ hints: { expand: 'ctrl+o' } }))
  block.render(80)
  assert.ok(block.hitboxes().length > 0)
  block.handleMouse(mouse('press', 0))
  block.clearMouse()
  assert.equal(block.hitboxes().length, 0)
  assert.equal(block.handleMouse(mouse('click', 0)), undefined)
  assert.deepEqual(block.render(80), block.render(80))
})

test('the factory uses the new tool block and keeps the item id/kind', () => {
  clearToolExpansion()
  const item = tool({ name: 'bash', arguments: '{"command":"x"}', resultText: 'ok' })
  const block = createItemBlock(item, flags())
  assert.equal(block.itemId, item.id)
  assert.equal(block.kind, 'tool')
  assert.match(plain(block).join('\n'), /Bash x/)
  assert.equal(typeof (block as ToolBlock).hitboxes, 'function')
})