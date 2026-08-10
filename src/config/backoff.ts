/** How long to wait before retrying a failed event. */
export interface BackoffPolicy {
  /** Delay before the first retry, in milliseconds. */
  minMs: number
  /** Ceiling for the delay, in milliseconds. */
  maxMs: number
  /** Multiplier applied per attempt. `2` doubles the wait each time. */
  factor: number
  /**
   * Fraction of the delay that is randomised, between 0 and 1.
   *
   * `0.2` means "somewhere between 80% and 100% of the computed delay".
   * Without it, a hundred events that failed together retry together, and
   * hammer the same struggling dependency in lockstep.
   */
  jitter: number
}

/** Matches the retry policy a Pub/Sub subscription is usually given. */
export const DEFAULT_BACKOFF: BackoffPolicy = {
  minMs: 10_000,
  maxMs: 600_000,
  factor: 2,
  jitter: 0.2,
}

/**
 * The delay before attempt number `attempts + 1`.
 *
 * `attempts` is how many attempts have already been made, so the first
 * failure (`attempts === 1`) waits `minMs`.
 */
export function computeBackoffMs(
  attempts: number,
  policy: BackoffPolicy,
  random: () => number = Math.random,
): number {
  const steps = Math.max(0, attempts - 1)
  const exponential = policy.minMs * Math.pow(policy.factor, steps)
  const capped = Math.min(exponential, policy.maxMs)

  if (policy.jitter <= 0) return Math.round(capped)

  const spread = Math.min(policy.jitter, 1)
  const scale = 1 - spread * random()
  return Math.round(capped * scale)
}
