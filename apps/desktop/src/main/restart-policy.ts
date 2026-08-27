/**
 * Restart backoff arithmetic for the sidecar lifecycle: a pure decision
 * function with no timers or processes, so the state machine's timing is a
 * table-tested policy rather than scattered literals.
 * @module @deepseek-ai/dsh-desktop/restart-policy
 */

/** Delay before the first automatic restart attempt. */
const BASE_DELAY_MS = 1_000
/** The delay plateau; later attempts stop doubling. */
const MAX_DELAY_MS = 16_000
/** One past the final allowed restart attempt. */
export const RESTART_ATTEMPT_LIMIT = 5

/**
 * Exponential backoff for the given zero-based restart attempt.
 * @param attempt - the number of restarts already performed for one manager
 * lifetime (0 = the first automatic restart).
 * @returns the delay before this attempt, or null once the attempt budget is
 * exhausted and the caller must move to its terminal stopped/failed state.
 */
export function nextBackoffDelayMs(attempt: number): number | null {
  if (attempt >= RESTART_ATTEMPT_LIMIT) return null
  return Math.min(BASE_DELAY_MS << attempt, MAX_DELAY_MS)
}
