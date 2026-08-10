/**
 * The one place time enters the system.
 *
 * Every timestamp QueueTeaPi writes and every "is this due yet?" comparison
 * goes through a `Clock`, so tests can decide what time it is instead of
 * waiting for it.
 */
export interface Clock {
  /** The current time in epoch milliseconds. */
  now(): number
}

/** The clock you want in production. */
export const systemClock: Clock = {
  now: () => Date.now(),
}
