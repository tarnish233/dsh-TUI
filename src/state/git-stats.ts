/**
 * Read-only local Git facts for the footer's diff/branch chip.
 *
 * DSH owns model calls, tools, permissions and durable sessions; this module
 * only observes the working tree the TUI is attached to. The observations are
 * purely local: `git diff --numstat HEAD --` and
 * `git status --porcelain --branch`. Nothing here fetches, stages, writes the
 * index, creates refs or otherwise mutates the repository — a missing
 * repository, an unborn HEAD, a timeout or an abort simply yields no chip
 * rather than an error.
 *
 * The numstat sums, branch header parsing and Starship-style status symbols
 * (`=` conflict, `!` modified, `?` untracked, `⇡`/`⇣` ahead/behind) follow the
 * "working" mode of pi-cc-extensions (MIT), adapted here to a promise-based
 * read plus DSH's coalescing refresher contract.
 *
 * @module dsh-tui/state/git-stats
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

export interface GitStats {
  branch: string | undefined
  add: number
  del: number
  status: string | undefined
}

const execFileAsync = promisify(execFile)
const TIMEOUT_MS = 2_000
const MAX_BUFFER = 16 * 1024 * 1024

/** Porcelain v1 XY codes that mean "unmerged path". */
const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'])

/**
 * Sum `git diff --numstat` output. Binary rows report `-` instead of counts and
 * are skipped, exactly like git's own `--shortstat` accounting.
 */
export function parseGitNumstat(stdout: string): { add: number; del: number } {
  let add = 0
  let del = 0
  for (const line of stdout.split('\n')) {
    const match = /^(\d+)\s+(\d+)/.exec(line)
    if (match === null) continue
    add += Number(match[1])
    del += Number(match[2])
  }
  return { add, del }
}

/**
 * Branch name from a `## ` header:
 *   `## main` / `## main...origin/main [ahead 1, behind 2]` -> `main`
 *   `## No commits yet on main`                           -> `main`
 *   `## HEAD (no branch)`                                 -> undefined
 */
function branchFromHeader(header: string): string | undefined {
  if (header === '' || header.startsWith('HEAD (no branch)')) return undefined
  const unborn = /^No commits yet on (.+)$/.exec(header)
  if (unborn !== null) return unborn[1]!.trim() === '' ? undefined : unborn[1]!.trim()
  let end = header.length
  const upstream = header.indexOf('...')
  if (upstream !== -1) end = Math.min(end, upstream)
  const aheadBehind = header.indexOf(' [')
  if (aheadBehind !== -1) end = Math.min(end, aheadBehind)
  const name = header.slice(0, end).trim()
  return name === '' ? undefined : name
}

/**
 * `git status --porcelain --branch`: the first `## ` row carries the branch and
 * upstream distance, the remaining rows are `XY path`. Returns the branch plus
 * Starship-style symbols; `status` is undefined when the tree is clean.
 */
export function parseGitStatusHeader(lines: string): {
  branch: string | undefined
  status: string | undefined
} {
  let branch: string | undefined
  let conflicted = false
  let modified = false
  let untracked = false
  let ahead = 0
  let behind = 0
  for (const raw of lines.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line === '') continue
    if (line.startsWith('## ')) {
      const header = line.slice(3).trim()
      branch = branchFromHeader(header)
      const aheadMatch = /ahead (\d+)/.exec(header)
      if (aheadMatch !== null) ahead = Number(aheadMatch[1])
      const behindMatch = /behind (\d+)/.exec(header)
      if (behindMatch !== null) behind = Number(behindMatch[1])
      continue
    }
    const code = line.slice(0, 2)
    if (code === '??') {
      untracked = true
      continue
    }
    if (CONFLICT_CODES.has(code)) {
      // An unmerged path always also carries uncommitted content, so `=` and `!`
      // describe the same row.
      conflicted = true
      modified = true
      continue
    }
    if (line.trim() !== '') modified = true
  }
  let status = ''
  if (conflicted) status += '='
  if (modified) status += '!'
  if (untracked) status += '?'
  if (ahead > 0) status += '⇡' + ahead
  if (behind > 0) status += '⇣' + behind
  return { branch, status: status === '' ? undefined : status }
}

/**
 * Read the attached repository's local state. DSH's session decides the cwd;
 * this only looks at it. Returns undefined for non-repositories, unborn HEADs,
 * timeouts and aborts, and never throws.
 */
export async function readGitStats(cwd: string, signal?: AbortSignal): Promise<GitStats | undefined> {
  const aborted = (): boolean => signal?.aborted === true
  const git = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      signal,
    })
    return stdout
  }
  try {
    if (aborted()) return undefined
    // `git diff HEAD` fails on an unborn HEAD ("bad revision"), so probe first:
    // a nested/non-repo cwd or a fresh `git init` has no comparable baseline.
    try {
      await git(['rev-parse', '--verify', 'HEAD'])
    } catch {
      return undefined
    }
    if (aborted()) return undefined
    const [numstat, statusOut] = await Promise.all([
      git(['diff', '--numstat', 'HEAD', '--']),
      git(['status', '--porcelain', '--branch']),
    ])
    if (aborted()) return undefined
    const { add, del } = parseGitNumstat(numstat)
    const { branch, status } = parseGitStatusHeader(statusOut)
    return { branch, add, del, status }
  } catch {
    // Non-repository, unborn HEAD, timeout, abort, missing git: no chip.
    return undefined
  }
}

function sameGitStats(a: GitStats | undefined, b: GitStats | undefined): boolean {
  if (a === undefined || b === undefined) return a === b
  return a.add === b.add && a.del === b.del && a.status === b.status && a.branch === b.branch
}

/**
 * Coalescing refresher for the footer. A refresh requested while one is running
 * marks a pending rerun (at most one), and results from a superseded generation
 * are dropped so a slow read can never overwrite fresher numbers. `onChange`
 * fires only when the observed facts actually changed.
 */
export function createGitStatsRefresher(options: {
  cwd: () => string
  query: (cwd: string, signal: AbortSignal) => Promise<GitStats | undefined>
  onChange: (stats: GitStats | undefined) => void
}): { refresh(): void; dispose(): void } {
  let current: GitStats | undefined
  let generation = 0
  let running = false
  let pending = false
  let disposed = false
  let controller: AbortController | undefined

  const publish = (next: GitStats | undefined): void => {
    if (sameGitStats(current, next)) return
    current = next
    options.onChange(next)
  }

  const refresh = (): void => {
    if (disposed) return
    // Bumped for every request, so an in-flight read is stale the moment a new
    // one is asked for; the pending rerun publishes the fresh result instead.
    const request = ++generation
    if (running) {
      pending = true
      return
    }
    running = true
    const queryController = new AbortController()
    controller = queryController
    void (async () => {
      let next: GitStats | undefined
      try {
        next = await options.query(options.cwd(), queryController.signal)
      } catch {
        // A failed read clears the chip rather than leaving stale numbers.
        next = undefined
      } finally {
        if (!disposed && request === generation) publish(next)
        running = false
        controller = undefined
        if (pending) {
          pending = false
          refresh()
        }
      }
    })()
  }

  return {
    refresh,
    dispose: (): void => {
      disposed = true
      generation++
      const inFlight = controller
      controller = undefined
      inFlight?.abort()
    },
  }
}