import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import {
  createGitStatsRefresher,
  parseGitNumstat,
  parseGitStatusHeader,
  readGitStats,
  type GitStats,
} from '../src/state/git-stats.ts'

const execFileAsync = promisify(execFile)

const git = async (cwd: string, args: string[]): Promise<void> => {
  await execFileAsync('git', args, { cwd, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 })
}

/** Temp workspace outside the repository; never touches the real checkout. */
const makeTempDir = (prefix: string): Promise<string> => mkdtemp(join(tmpdir(), prefix))

/** A real repo with one commit, so HEAD exists and numstat has a baseline. */
const makeRepo = async (): Promise<string> => {
  const dir = await makeTempDir('dsh-tui-git-stats-')
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.email', 'dev@example.invalid'])
  await git(dir, ['config', 'user.name', 'DSH TUI Test'])
  await git(dir, ['config', 'commit.gpgsign', 'false'])
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\n')
  await git(dir, ['add', 'a.txt'])
  await git(dir, ['commit', '-m', 'initial', '--no-gpg-sign'])
  return dir
}

test('parseGitNumstat sums added/deleted lines and skips binary rows', () => {
  assert.deepEqual(parseGitNumstat(''), { add: 0, del: 0 })
  assert.deepEqual(parseGitNumstat('12\t3\tsrc/a.ts\n0\t1\tb.ts\n'), { add: 12, del: 4 })
  // Binary files report `-` instead of counts; git's own shortstat ignores them.
  assert.deepEqual(parseGitNumstat('-\t-\tassets/logo.png\n5\t0\tREADME.md\n'), { add: 5, del: 0 })
  // Renames still carry counts; a rename with no content change reports 0/0.
  assert.deepEqual(parseGitNumstat('0\t0\tsrc/{old.ts => new.ts}\n'), { add: 0, del: 0 })
})

test('parseGitStatusHeader reads the branch header and builds status symbols', () => {
  assert.deepEqual(parseGitStatusHeader('## main\n'), { branch: 'main', status: undefined })
  assert.deepEqual(parseGitStatusHeader('## feature\n'), { branch: 'feature', status: undefined })
  assert.deepEqual(parseGitStatusHeader('## main...origin/main\n'), { branch: 'main', status: undefined })
  assert.deepEqual(parseGitStatusHeader('## main...origin/main [ahead 1, behind 2]\n'), {
    branch: 'main',
    status: '⇡1⇣2',
  })
  assert.deepEqual(parseGitStatusHeader('## feature/x...origin/feature/x [ahead 3]\n'), {
    branch: 'feature/x',
    status: '⇡3',
  })
  assert.deepEqual(parseGitStatusHeader('## main...origin/main [gone]\n'), { branch: 'main', status: undefined })
  assert.deepEqual(parseGitStatusHeader('## HEAD (no branch)\n'), { branch: undefined, status: undefined })
  assert.deepEqual(parseGitStatusHeader('## HEAD (no branch)\n M a.txt\n'), { branch: undefined, status: '!' })
  assert.deepEqual(parseGitStatusHeader('## No commits yet on main\n'), { branch: 'main', status: undefined })
  assert.deepEqual(parseGitStatusHeader('## No commits yet on main\n?? a.txt\n'), {
    branch: 'main',
    status: '?',
  })
  assert.deepEqual(parseGitStatusHeader(''), { branch: undefined, status: undefined })
})

test('parseGitStatusHeader distinguishes modified, staged, conflicted and untracked rows', () => {
  // Unstaged and staged edits are both "dirty content".
  assert.deepEqual(parseGitStatusHeader('## main\n M src/a.ts\n').status, '!')
  assert.deepEqual(parseGitStatusHeader('## main\nM  src/a.ts\n').status, '!')
  assert.deepEqual(parseGitStatusHeader('## main\nMM src/a.ts\n').status, '!')
  assert.deepEqual(parseGitStatusHeader('## main\nD  src/a.ts\n').status, '!')
  // Untracked only.
  assert.deepEqual(parseGitStatusHeader('## main\n?? new.txt\n').status, '?')
  // Conflicts: `=` and `!` describe the same unmerged row.
  for (const code of ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']) {
    assert.equal(parseGitStatusHeader(`## main\n${code} src/a.ts\n`).status, '=!', code)
  }
  assert.equal(parseGitStatusHeader('## main\nUU a\nAA b\n?? c\n').status, '=!?')
  // Combined with upstream distance, in pi's symbol order.
  assert.equal(parseGitStatusHeader('## main...origin/main [ahead 1, behind 2]\n M a\n?? b\n').status, '!?⇡1⇣2')
  // Clean tree: no symbols at all.
  assert.equal(parseGitStatusHeader('## main...origin/main\n').status, undefined)
  // CRLF porcelain output (core.autocrlf / Windows) is tolerated.
  assert.deepEqual(parseGitStatusHeader('## main\r\n M a.txt\r\n'), { branch: 'main', status: '!' })
})

test('refresher coalesces overlapping reads and reruns once', async () => {
  let running = 0
  let maxRunning = 0
  const calls: string[] = []
  const gates: Array<(value: GitStats | undefined) => void> = []
  const changes: Array<GitStats | undefined> = []
  const refresher = createGitStatsRefresher({
    cwd: () => '/tmp/work',
    query: async (cwd) => {
      running += 1
      maxRunning = Math.max(maxRunning, running)
      calls.push(cwd)
      const value = await new Promise<GitStats | undefined>((resolve) => gates.push(resolve))
      running -= 1
      return value
    },
    onChange: (stats) => changes.push(stats),
  })

  refresher.refresh()
  refresher.refresh()
  refresher.refresh()
  assert.equal(calls.length, 1, 'requests during a read are coalesced into one pending rerun')

  gates[0]!({ branch: 'main', add: 1, del: 0, status: '!' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(changes.length, 0, 'a superseded read never publishes')
  assert.equal(calls.length, 2, 'exactly one rerun')

  gates[1]!({ branch: 'main', add: 4, del: 2, status: '!?' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(changes, [{ branch: 'main', add: 4, del: 2, status: '!?' }])
  assert.equal(maxRunning, 1, 'never two reads at once')
  assert.deepEqual(calls, ['/tmp/work', '/tmp/work'])
  refresher.dispose()
})

test('refresher publishes only real changes and clears on a failed read', async () => {
  const results: Array<GitStats | undefined> = [
    { branch: 'main', add: 2, del: 1, status: '!' },
    { branch: 'main', add: 2, del: 1, status: '!' },
    { branch: 'main', add: 2, del: 1, status: '!' },
    { branch: 'main', add: 0, del: 0, status: undefined },
    undefined,
  ]
  const changes: Array<GitStats | undefined> = []
  const refresher = createGitStatsRefresher({
    cwd: () => '/tmp/work',
    query: async () => results.shift(),
    onChange: (stats) => changes.push(stats),
  })

  for (let i = 0; i < 5; i++) {
    refresher.refresh()
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.deepEqual(changes, [
    { branch: 'main', add: 2, del: 1, status: '!' },
    { branch: 'main', add: 0, del: 0, status: undefined },
    undefined,
  ])
  refresher.dispose()
})

test('refresher reads the current cwd and stops cleanly on dispose', async () => {
  let cwd = '/tmp/one'
  const seen: string[] = []
  const changes: Array<GitStats | undefined> = []
  const refresher = createGitStatsRefresher({
    cwd: () => cwd,
    query: async (target) => {
      seen.push(target)
      return { branch: target, add: 0, del: 0, status: undefined }
    },
    onChange: (stats) => changes.push(stats),
  })

  refresher.refresh()
  await new Promise((resolve) => setImmediate(resolve))
  cwd = '/tmp/two'
  refresher.refresh()
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(seen, ['/tmp/one', '/tmp/two'])
  assert.deepEqual(changes, [
    { branch: '/tmp/one', add: 0, del: 0, status: undefined },
    { branch: '/tmp/two', add: 0, del: 0, status: undefined },
  ])
  refresher.dispose()

  // A slow read that is still running: dispose aborts it, drops the result and
  // cancels the pending rerun instead of leaving a loop behind.
  let running = 0
  let slowSignal: AbortSignal | undefined
  let finishSlow: (value: GitStats | undefined) => void = () => {}
  const slowChanges: Array<GitStats | undefined> = []
  const slow = createGitStatsRefresher({
    cwd: () => '/tmp/three',
    query: async (_target, signal) => {
      running += 1
      slowSignal = signal
      return await new Promise<GitStats | undefined>((resolve) => {
        finishSlow = resolve
      })
    },
    onChange: (stats) => slowChanges.push(stats),
  })
  slow.refresh()
  slow.refresh() // pending rerun
  await new Promise((resolve) => setImmediate(resolve))
  slow.dispose()
  assert.equal(slowSignal?.aborted, true, 'dispose aborts the in-flight read')
  slow.refresh()
  finishSlow({ branch: 'late', add: 9, del: 9, status: '!' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(running, 1, 'the pending rerun never starts after dispose')
  assert.deepEqual(slowChanges, [], 'nothing publishes after dispose')
})

test('readGitStats observes a real repository read-only', async (t) => {
  const dir = await makeRepo()
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // Clean tree: no numbers to show, but the branch is known.
  assert.deepEqual(await readGitStats(dir), { branch: 'main', add: 0, del: 0, status: undefined })

  // Unstaged edit + staged new file + untracked file.
  await writeFile(join(dir, 'a.txt'), 'one\nTWO\nthree\nfour\n')
  await writeFile(join(dir, 'b.txt'), 'alpha\nbeta\n')
  await git(dir, ['add', 'b.txt'])
  await writeFile(join(dir, 'c.txt'), 'untracked\n')

  const stats = await readGitStats(dir)
  assert.deepEqual(stats, {
    branch: 'main',
    add: 4, // 2 changed/added lines in a.txt + 2 added lines in b.txt
    del: 1, // "two" replaced by "TWO"
    status: '!?', // modified + untracked
  })

  // The observation is read-only: the index and the worktree are untouched.
  const { stdout: porcelainAfter } = await execFileAsync('git', ['status', '--porcelain'], { cwd: dir })
  assert.equal(porcelainAfter, ' M a.txt\nA  b.txt\n?? c.txt\n')
  const { stdout: unstagedAfter } = await execFileAsync('git', ['diff', '--numstat'], { cwd: dir })
  assert.equal(unstagedAfter, '2\t1\ta.txt\n')
})

test('readGitStats reports the branch header variants from a real repository', async (t) => {
  const dir = await makeRepo()
  t.after(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // Detached HEAD: no branch to show, but the diff is still real.
  await git(dir, ['checkout', '--detach'])
  await writeFile(join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n')
  const detached = await readGitStats(dir)
  assert.deepEqual(detached, { branch: undefined, add: 1, del: 0, status: '!' })
})

test('readGitStats reports ahead/behind from a real local clone', async (t) => {
  const origin = await makeRepo()
  const clone = await makeTempDir('dsh-tui-git-clone-')
  t.after(async () => {
    await rm(origin, { recursive: true, force: true })
    await rm(clone, { recursive: true, force: true })
  })

  // A local-path clone only: no network, and the module itself never fetches.
  await git(clone, ['clone', '--quiet', origin, '.'])
  await git(clone, ['config', 'user.email', 'dev@example.invalid'])
  await git(clone, ['config', 'user.name', 'DSH TUI Test'])
  await writeFile(join(clone, 'a.txt'), 'one\ntwo\nthree\nfour\n')
  await git(clone, ['commit', '-am', 'ahead', '--no-gpg-sign'])

  assert.deepEqual(await readGitStats(clone), {
    branch: 'main',
    add: 0,
    del: 0,
    status: '⇡1',
  })
})

test('readGitStats returns undefined without a usable repository', async (t) => {
  const plain = await makeTempDir('dsh-tui-git-norepo-')
  const unborn = await makeTempDir('dsh-tui-git-unborn-')
  const repo = await makeRepo()
  t.after(async () => {
    await rm(plain, { recursive: true, force: true })
    await rm(unborn, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  })

  assert.equal(await readGitStats(plain), undefined, 'plain directory is not a repository')

  // `git init` without a commit has an unborn HEAD: nothing to diff against.
  await git(unborn, ['init', '-b', 'main'])
  assert.equal(await readGitStats(unborn), undefined, 'unborn HEAD yields no stats')

  // A subdirectory of a repository is resolved by git itself (upward search).
  const nested = join(plain, 'sub', 'deeper')
  await mkdir(nested, { recursive: true })
  assert.equal(await readGitStats(nested), undefined, 'no repository is found by walking upwards')

  // A missing cwd must never throw.
  assert.equal(await readGitStats(join(plain, 'does-not-exist')), undefined)

  // A pre-aborted signal is honoured before anything runs.
  const controller = new AbortController()
  controller.abort()
  assert.equal(await readGitStats(repo, controller.signal), undefined)
})