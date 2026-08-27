/** Restart backoff policy table: doubling with a plateau and a hard budget. */

import { describe, expect, it } from 'vitest'
import { nextBackoffDelayMs, RESTART_ATTEMPT_LIMIT } from '../src/main/restart-policy.ts'

describe('nextBackoffDelayMs', () => {
  it.each([
    [0, 1_000],
    [1, 2_000],
    [2, 4_000],
    [3, 8_000],
    [4, 16_000],
    [5, null],
    [9, null],
  ])('attempt %i yields backoff %j', (attempt, delay) => {
    expect(nextBackoffDelayMs(attempt)).toBe(delay)
  })

  it('exposes the attempt limit consistent with the table', () => {
    // attempt === RESTART_ATTEMPT_LIMIT is one past the final allowed try.
    expect(nextBackoffDelayMs(RESTART_ATTEMPT_LIMIT - 1)).not.toBeNull()
    expect(nextBackoffDelayMs(RESTART_ATTEMPT_LIMIT)).toBeNull()
  })
})
