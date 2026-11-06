import assert from 'node:assert/strict'
import test from 'node:test'
import {
  formatElapsed,
  formatOutputRate,
  formatOutputTokens,
  OutputTracker,
} from '../src/state/output-stats.ts'

/**
 * The live working-indicator projection only: the footer's settled rate/TTFT
 * now come from DSH's native `sessionStats`, so there is no local settle/TTFT
 * machinery to test here.
 */

test('output tracker estimates deltas, accepts provider usage and sums attempts within a turn', () => {
  const tracker = new OutputTracker()
  tracker.beginTurn(1, 1_000)
  tracker.start(1, 'attempt-a', 1_000)
  tracker.chunk('attempt-a', { type: 'text-delta', text: 'abcd' }, 1_100)
  assert.equal(tracker.total(), 1)
  tracker.chunk('attempt-a', { type: 'tool-call-delta', argumentsDelta: '{"path":"a.txt"}' }, 1_200)
  assert.equal(tracker.total(), 5)
  tracker.chunk('attempt-a', { type: 'usage', usage: { outputTokens: 186 } }, 1_500)
  assert.equal(tracker.total(), 186, 'provider output usage is authoritative for the attempt')
  assert.ok(tracker.rate(2_000) > 0)

  tracker.start(1, 'attempt-b', 1_600)
  tracker.chunk('attempt-b', { type: 'reasoning-delta', text: 'abcdefgh' }, 1_700)
  assert.equal(tracker.total(), 188, 'tool-follow-up attempts accumulate within one turn')

  tracker.beginTurn(2, 5_000)
  assert.equal(tracker.total(), 0)
  assert.equal(tracker.startTime, 5_000)
})

test('output tracker counts CJK as one token and handles a chunk before stream_start', () => {
  const tracker = new OutputTracker()
  tracker.beginTurn(1, 1_000)
  tracker.chunk('late-attempt', { type: 'text-delta', text: '中文' }, 1_100)
  assert.equal(tracker.total(), 2)
})

test('live rate follows the turn wall clock and stays honest below the floor', () => {
  const tracker = new OutputTracker()
  // Nothing streamed yet: no invented numbers.
  tracker.beginTurn(1, 10_000)
  assert.equal(tracker.rate(10_400), 0)

  tracker.start(1, 'attempt-a', 10_000)
  // A usage-only frame carries no content but is still recorded output.
  tracker.chunk('attempt-a', { type: 'usage', usage: { outputTokens: 4 } }, 10_200)
  assert.equal(tracker.total(), 4)
  assert.equal(tracker.rate(10_200), 0, 'below the 250ms floor a rate would be misleading')

  // A tool wait inflates the denominator, not the token count.
  tracker.chunk('attempt-a', { type: 'usage', usage: { outputTokens: 99 } }, 12_000)
  assert.equal(tracker.total(), 99)
  assert.equal(tracker.rate(14_000), 24.75, 'live average includes tool waits')

  // The next turn starts from zero again; nothing is frozen for an idle footer.
  tracker.beginTurn(2, 20_000)
  assert.equal(tracker.total(), 0)
  assert.equal(tracker.rate(20_400), 0)
  tracker.start(2, 'c', 20_000)
  tracker.chunk('c', { type: 'text-delta', text: '中文' }, 20_900)
  assert.equal(tracker.total(), 2, 'CJK still counts as one token per character')
  assert.equal(tracker.rate(21_000), 2, '2 tokens over 1s')

  // reset clears the live projection (new attachment / session switch).
  tracker.reset()
  assert.equal(tracker.total(), 0)
  assert.equal(tracker.rate(22_000), 0)
  assert.equal(tracker.startTime, 0)
})

test('formatters stay compact', () => {
  assert.equal(formatOutputTokens(999), '999')
  assert.equal(formatOutputTokens(1_500), '1.5k')
  assert.equal(formatOutputTokens(12_000), '12k')
  assert.equal(formatOutputTokens(1_200_000), '1.2M')
  assert.equal(formatElapsed(0), '')
  assert.equal(formatElapsed(999), '')
  assert.equal(formatElapsed(9_000), '9s')
  assert.equal(formatElapsed(63_000), '1m 3s')
  assert.equal(formatElapsed(3_723_000), '1h 2m 3s')
  assert.equal(formatOutputRate(20.6), '21 tok/s')
  assert.equal(formatOutputRate(1_250), '1.3k tok/s')
  assert.equal(formatOutputRate(0), '')
})