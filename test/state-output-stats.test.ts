import assert from 'node:assert/strict'
import test from 'node:test'
import { OutputTracker } from '../src/state/output-stats.ts'

/**
 * The live output projection is presentation-only, so every number here is
 * driven by an explicit timestamp: no test waits on a wall clock.
 */

test('total is folded incrementally and keeps provider usage authoritative', () => {
  const tracker = new OutputTracker()
  tracker.beginTurn(1, 1_000)
  tracker.chunk('a', { type: 'text-delta', text: 'abcd' }, 1_100)
  assert.equal(tracker.total(), 1)
  tracker.chunk('b', { type: 'text-delta', text: 'abcdefgh' }, 1_150)
  assert.equal(tracker.total(), 3, 'two attempts add up')
  tracker.chunk('a', { type: 'usage', usage: { outputTokens: 9 } }, 1_200)
  assert.equal(tracker.total(), 11, 'usage replaces that attempt estimate')
  tracker.chunk('a', { type: 'usage', usage: { outputTokens: 4 } }, 1_250)
  assert.equal(tracker.total(), 11, 'a lower/stale usage never lowers the count')
  tracker.chunk('a', { type: 'text-delta', text: 'abcd' }, 1_300)
  assert.equal(tracker.total(), 11, 'usage keeps winning over a later estimate')
  tracker.chunk('b', { type: 'usage', usage: { outputTokens: 0 } }, 1_350)
  assert.equal(tracker.total(), 11, 'zero usage is not an authoritative reading')
  assert.equal(tracker.total(), 11, 'reads never change the fold')

  tracker.beginTurn(2, 2_000)
  assert.equal(tracker.total(), 0, 'a new turn restarts the fold')
  tracker.reset()
  assert.equal(tracker.total(), 0)
  assert.equal(tracker.startTime, 0)
})

test('rate reads the window without consuming it', () => {
  const tracker = new OutputTracker()
  tracker.beginTurn(1, 1_000)
  tracker.chunk('a', { type: 'text-delta', text: 'abcd' }, 1_100)
  tracker.chunk('a', { type: 'text-delta', text: 'abcd' }, 1_150)
  tracker.chunk('a', { type: 'text-delta', text: 'abcd' }, 1_550)

  const windowed = (2 * 1_000) / 450
  assert.equal(tracker.rate(1_400), windowed, 'two samples inside the live window')
  // The same read again answers from the same window: `rate` never takes the
  // samples the next render still needs.
  assert.equal(tracker.rate(1_400), windowed)
  // A later read ages the window out and falls back to the turn average.
  assert.equal(tracker.rate(2_600), (3 * 1_000) / 1_600)
  // Aging is monotone: a stale read is answered from the slowly-ticking turn
  // clock, never from samples the window already retired.
  assert.equal(tracker.rate(1_400), (3 * 1_000) / 400)
  assert.equal(tracker.total(), 3)
})

test('the live window boundary keeps a sample exactly at the cutoff', () => {
  const tracker = new OutputTracker()
  tracker.beginTurn(1, 1_000)
  tracker.chunk('a', { type: 'text-delta', text: 'abcd' }, 1_000)
  tracker.chunk('a', { type: 'text-delta', text: 'abcd' }, 1_250)
  tracker.chunk('a', { type: 'text-delta', text: 'abcd' }, 1_500)
  // cutoff = 2_000 - 1_000: the sample at exactly 1_000 is still in the window.
  assert.equal(tracker.rate(2_000), (2 * 1_000) / 500)
  // 1ms later it is outside; the remaining 250ms span is the live one.
  assert.equal(tracker.rate(2_001), (1 * 1_000) / 250)
})

test('a long delta stream keeps the live window exact and bounded', () => {
  const tracker = new OutputTracker()
  tracker.beginTurn(1, 1_000)
  for (let index = 0; index < 200; index += 1) {
    // 1 token per chunk, 10ms apart: the window is the last 1000ms of samples.
    tracker.chunk('a', { type: 'text-delta', text: 'abcd' }, 1_000 + index * 10)
  }
  assert.equal(tracker.total(), 200)
  const last = 1_000 + 199 * 10
  const expected = ((200 - 101) * 1_000) / (last - 2_000)
  assert.equal(tracker.rate(3_000), expected)
  assert.equal(tracker.rate(3_000), expected, 'repeated reads are stable after compaction')
  assert.equal(tracker.rate(3_000), 100, '100 chunks per second stay 100 tok/s')
  // Below the 250ms floor the number stays unclaimed, whatever the window holds.
  tracker.beginTurn(2, 4_000)
  tracker.chunk('b', { type: 'text-delta', text: 'abcd' }, 4_100)
  assert.equal(tracker.rate(4_200), 0)
})