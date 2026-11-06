import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { wrapTextWithAnsi } from '#pi-tui'
import { App } from '../src/app.ts'
import type { Backend, BackendEvent, JsonRecord, SessionInfo } from '../src/backend/types.ts'
import { DEMO_TRANSCRIPT_CODEC } from '../src/demo.ts'
import { delay, until, VirtualTerminal } from './helpers/terminal.ts'

/**
 * Parent-owned acceptance for the pi-cc-extensions-style status footer:
 * text-only effort rider, context bar, whole-log token total, cache-hit,
 * turns/steps, decode rate and its own TTFT chip on line 1, plus the cwd line
 * with the git chip and the permission value. Usage/git facts stay native or
 * read-only; the fixture only projects what the real bridge reports.
 */
class FooterBackend implements Backend {
  readonly transcriptCodec = DEMO_TRANSCRIPT_CODEC
  readonly listeners = new Set<(event: BackendEvent) => void>()
  /** Native state usage projection; chips stay absent when undefined. */
  usage: JsonRecord | undefined = {
    // DSH's official occupancy/cache-hit math, computed bridge-side:
    // 37% of a 1.0M window; the tokenUsage fold reports a 99% cache hit and a
    // 1.2M whole-log token total.
    used: 370_000, size: 1_000_000, cachePct: 99, totalTokens: 1_200_000,
  }
  /** Native sessionStats fold; when present it wins over the stream tracker. */
  stats: JsonRecord | undefined = {
    turns: 3, steps: 5, llmMs: 60_000, toolMs: 12_000,
    // 1400 tokens decoded in 100s -> 14 tok/s; average TTFT 4.7s.
    ttftMs: 9_400, ttftSteps: 2, decodeMs: 100_000, decodeTokens: 1_400,
  }
  info: SessionInfo
  constructor(cwd: string) {
    this.info = {
      sessionId: 'footer-session', attachmentId: 'footer-attachment', cwd,
      provider: 'fixture-provider', model: 'fixture-model', preset: 'standard',
      reasoningEffort: 'max', permissions: { currentValue: 'workspace-write' },
      capabilities: ['commands', 'state'],
    }
  }
  onEvent(listener: (event: BackendEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  emit(event: BackendEvent) { for (const listener of this.listeners) listener(event) }
  async connect() { this.emit({ type: 'ready', info: this.info }); return this.info }
  async send() {}
  async respond() { throw new Error('footer test never answers decisions') }
  async close() {}
  async cancel() {}
  async command(name: string, _args: JsonRecord = {}): Promise<unknown> {
    if (name === 'commands') return []
    if (name === 'auto-title') return { available: false }
    if (name === 'state') {
      return {
        pending: { nextTurn: 0, nextStep: 0 }, queued: 0,
        ...(this.usage === undefined ? {} : { usage: this.usage }),
        ...(this.stats === undefined ? {} : { stats: this.stats }),
      }
    }
    throw new Error('Unexpected control from the footer test: ' + name)
  }
}

/** A throwaway git repository: one empty commit, one staged edit, one untracked file. */
async function gitDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-footer-git-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory })
  git('init', '-b', 'main')
  git('-c', 'user.email=fixture@example.com', '-c', 'user.name=fixture', 'commit', '--allow-empty', '-m', 'base')
  await writeFile(join(directory, 'staged.txt'), 'one\ntwo\nthree\n')
  git('add', 'staged.txt')
  await writeFile(join(directory, 'untracked.txt'), 'not committed')
  return directory
}

/** A deliberately deep workspace: its cwd is longer than a terminal row. */
async function longDirectory(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-parent-footer-long-'))
  const segments = Array.from({ length: 4 }, (_, depth) => 'nested-directory-segment-' + depth)
  const directory = join(base, ...segments)
  await mkdir(directory, { recursive: true })
  return directory
}

async function paint(terminal: VirtualTerminal) { await delay(60); await terminal.flush() }

/**
 * The status footer is the block below the editor frame. The component renders
 * it as one or more wrapped rows, so a long TMPDIR legitimately produces
 * several physical rows; assertions isolate the block instead of assuming the
 * cwd line fits the terminal width.
 */
function footerBlock(terminal: VirtualTerminal): string[] {
  const rows = terminal.screen().split('\n').map(row => row.replace(/\s+$/, ''))
  // The editor frame is the bottom-most horizontal border; the footer starts
  // on the next row (the hint row above it is empty in these fixtures).
  const frame = rows.findLastIndex(row => row.startsWith('─'))
  assert.ok(frame >= 0, 'the editor frame is rendered above the footer')
  return rows.slice(frame + 1).filter(row => row !== '')
}

/**
 * Split the footer into its status line and its cwd line. Either may wrap when
 * the chips or the cwd are wider than the terminal, so the split comes from
 * where the cwd itself begins rather than from a fixed row count.
 */
function footerLines(terminal: VirtualTerminal, cwd: string): { status: string[]; place: string[] } {
  const block = footerBlock(terminal)
  const start = block.findIndex(row => row.length > 1 && (row.startsWith(cwd) || cwd.startsWith(row)))
  assert.ok(start > 0, 'the cwd line starts below the status line inside the footer')
  return { status: block.slice(0, start), place: block.slice(start) }
}

/**
 * The footer is rendered by the shared public wrapper, so the expected rows for
 * a cwd line are exactly that wrapper's rows: same content, same break points,
 * nothing truncated. A wrap may legitimately drop the space it breaks on.
 */
function wrappedRows(line: string, width: number): string[] {
  return wrapTextWithAnsi(line, width).map(row => row.trimEnd())
}

/** Comparison with the wrap-dropped whitespace removed; order is preserved. */
function squashed(value: string): string { return value.replace(/\s+/g, '') }

test('parent footer: text-only effort, desktop stat order, git chip and permission placement', async () => {
  const directory = await gitDirectory()
  const backend = new FooterBackend(directory)
  // Wide enough that line 1 stays on one row, so the whole order is asserted
  // in a single match.
  const terminal = new VirtualTerminal(200, 32)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen: 'fullscreen', registerSignals: false })
  try {
    await app.start()
    await until(() => {
      const screen = terminal.screen()
      return screen.includes('37%') && screen.includes('main')
    }, 'the usage and git chips land in the footer')
    await paint(terminal)
    const screen = terminal.screen()
    // Line 1 follows the desktop order: model + text-only effort, status,
    // preset value, then the native stat chips — context bar, whole-log token
    // total, cache hit, turns/steps, decode rate and TTFT on their own.
    assert.match(
      screen,
      /fixture-provider\/fixture-model max · ready · standard · ████░░░░░░ 37%\/1\.0M · 1\.2M tok · 󰆼 99% · 3 turns 5 steps · 14 tok\/s · TTFT: 4\.7s/,
      'line 1 keeps the desktop stat order',
    )
    assert.doesNotMatch(screen, /avg /, 'the token-rate chip carries no `avg ` prefix')
    assert.doesNotMatch(screen, /[●◕◔◉◎○]/, 'the effort is text only, with no circle glyph')
    assert.doesNotMatch(screen, /\(TTFT:/, 'TTFT is its own chip, not a suffix of the rate')
    assert.doesNotMatch(screen, /preset: |permission: |effort: /, 'no label prefixes in the footer')
    // Line 2: the cwd carries the permission value and then the git chip, in
    // that order. The line may wrap on a long cwd, so assert the logical line.
    const { status, place } = footerLines(terminal, directory)
    assert.equal(status.length, 1, '200 columns keep the status line on one row')
    const flat = squashed(place.join(''))
    assert.ok(flat.startsWith(squashed(directory + ' · workspace-write · ')), 'the permission rides directly behind the cwd path')
    assert.ok(flat.endsWith(squashed('main [!?](+3 −0)')), 'the git chip follows the permission value')
  } finally {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  }
})

test('parent footer: without usage facts or a git repository the chips stay absent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-parent-footer-plain-'))
  const backend = new FooterBackend(directory)
  backend.usage = undefined
  backend.stats = undefined
  const terminal = new VirtualTerminal(120, 32)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen: 'fullscreen', registerSignals: false })
  try {
    await app.start()
    await paint(terminal)
    const screen = terminal.screen()
    assert.match(screen, /fixture-provider\/fixture-model max · ready · standard/)
    assert.doesNotMatch(screen, /░|󰆼|tok\/s|37%|turns|TTFT/, 'no bar, token total, cache, turns/steps, rate or TTFT without native facts')
    assert.doesNotMatch(screen, /\btok\b/, 'the whole-log token chip is absent too')
    const { status, place } = footerLines(terminal, directory)
    assert.equal(status.length, 1, '120 columns keep the status line on one row')
    assert.deepEqual(place, wrappedRows(directory + ' · workspace-write', terminal.columns), 'the permission still rides behind the plain path, with nothing else appended')
  } finally {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  }
})

test('parent footer: a long cwd wraps across rows without truncating the path or permission', async () => {
  const directory = await longDirectory()
  const backend = new FooterBackend(directory)
  backend.usage = undefined
  backend.stats = undefined
  const terminal = new VirtualTerminal(60, 48)
  const app = new App({ backend, cwd: directory, configDir: directory, terminal, screen: 'fullscreen', registerSignals: false })
  try {
    await app.start()
    await paint(terminal)
    assert.ok(directory.length + ' · workspace-write'.length > terminal.columns, 'the cwd line is wider than one terminal row')
    const { status, place } = footerLines(terminal, directory)
    assert.equal(status.join(''), 'fixture-provider/fixture-model max · ready · standard', 'the short status line still fits one row')
    // A cwd longer than the terminal width must wrap. Truncating or eliding it
    // would hide which workspace the session writes to.
    assert.ok(place.length > 1, 'the long cwd wraps over several physical rows')
    assert.deepEqual(place, wrappedRows(directory + ' · workspace-write', terminal.columns), 'wrapping keeps the whole path and the permission value in order')
    assert.doesNotMatch(place.join(''), /…|\.\.\./, 'the footer wraps instead of truncating with an ellipsis')
  } finally {
    try { await app.shutdown() } finally { terminal.dispose(); await rm(directory, { recursive: true, force: true }) }
  }
})
