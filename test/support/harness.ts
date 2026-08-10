import { QueueTeaPi, type QueueTeaPiOptions } from '../../src/index.js'
import type { Clock } from '../../src/support/clock.js'
import type { LogLevel, Logger } from '../../src/support/logger.js'
import { FakeFirestore } from './fake-firestore.js'

/** A clock the test drives by hand. */
export class TestClock implements Clock {
  constructor(private current = 1_700_000_000_000) {}

  now(): number {
    return this.current
  }

  /** Moves time forward. */
  advance(ms: number): this {
    this.current += ms
    return this
  }

  /** Jumps to an absolute epoch millisecond. */
  set(epochMs: number): this {
    this.current = epochMs
    return this
  }
}

export interface RecordedLog {
  level: LogLevel
  message: string
  context: Record<string, unknown> | undefined
}

/** A logger that remembers everything, so tests can assert on reporting. */
export class RecordingLogger implements Logger {
  readonly entries: RecordedLog[] = []

  log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>,
  ): void {
    this.entries.push({ level, message, context })
  }

  /** Messages logged at a given level. */
  messages(level: LogLevel): string[] {
    return this.entries
      .filter((entry) => entry.level === level)
      .map((entry) => entry.message)
  }
}

export const COLLECTION = 'test-events'

export interface Harness {
  queue: QueueTeaPi
  firestore: FakeFirestore
  clock: TestClock
  logger: RecordingLogger
  /** Every event document currently in the ledger. */
  documents(): Record<string, unknown>[]
}

/**
 * Builds a fully wired queue backed by the in-memory Firestore, with time,
 * ids and jitter all made deterministic.
 *
 * Ids are sequential (`event-1`, `event-2`, …) so assertions can name them,
 * and `random` is pinned so backoff is exact rather than approximately right.
 */
export function createHarness(
  overrides: Partial<QueueTeaPiOptions> = {},
): Harness {
  const firestore = new FakeFirestore()
  const clock = new TestClock()
  const logger = new RecordingLogger()

  let sequence = 0

  const queue = new QueueTeaPi({
    firestore,
    collection: COLLECTION,
    clock,
    logger,
    generateId: () => `event-${(sequence += 1)}`,
    random: () => 0,
    ...overrides,
  })

  return {
    queue,
    firestore,
    clock,
    logger,
    documents: () => firestore.all(COLLECTION),
  }
}

/** Lets pending promise callbacks run. */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve)
  })
}

/**
 * Waits for `predicate` to hold, or fails the test with `description`.
 *
 * Background work — the dispatcher's listener, its sweep — settles on its own
 * schedule, so tests assert on the outcome rather than guessing how many
 * microtasks it took to get there.
 */
export async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting until ${description}.`)
}
