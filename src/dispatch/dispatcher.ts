import { ConfigurationError } from '../errors.js'
import type { FirestoreEventStore } from '../events/event-store.js'
import type { StoredEvent } from '../events/queued-event.js'
import type { Unsubscribe } from '../firestore/firestore-types.js'
import type { Clock } from '../support/clock.js'
import { mapWithConcurrency } from '../support/concurrency.js'
import { createInstanceId } from '../support/ids.js'
import type { Logger } from '../support/logger.js'
import type { EventRunner, RunOutcome } from './event-runner.js'

/** What one pass of the dispatcher did. */
export interface TickSummary {
  /** Events this dispatcher successfully took ownership of. */
  claimed: number
  succeeded: number
  retried: number
  deadLettered: number
  /** Events another dispatcher took first, or took back mid-flight. */
  lost: number
  durationMs: number
}

export interface DispatcherOptions {
  /** Maximum handlers running at once. The real concurrency dial. */
  poolSize?: number
  /** Maximum events read per pass. Kept at or below `poolSize` in practice. */
  batchSize?: number
  /** How long a claim is valid. Defaults to twice the handler timeout. */
  leaseTtlMs?: number
  /** How long a handler may run before it is abandoned. Defaults to 60s. */
  handlerTimeoutMs?: number
  /** How often to look for due retries and lapsed leases. Defaults to 30s. */
  sweepIntervalMs?: number
  /** Whether to wake on new events via a Firestore listener. Defaults to true. */
  watchForNewEvents?: boolean
  /** Identifies this process in `leaseOwner`. Defaults to a random id. */
  instanceId?: string
  /** Called after every pass — handy for metrics. */
  onTick?: (summary: TickSummary) => void
}

export interface DispatcherDependencies {
  store: FirestoreEventStore
  runner: EventRunner
  clock: Clock
  logger: Logger
}

const DEFAULTS = {
  poolSize: 20,
  batchSize: 50,
  handlerTimeoutMs: 60_000,
  sweepIntervalMs: 30_000,
  watchForNewEvents: true,
} as const

/**
 * The orchestrator: it finds work, claims it, runs it and settles it.
 *
 * There are two ways to use it.
 *
 * **Long-running** — `start()` on a service with CPU always allocated. It
 * wakes on a Firestore listener when events arrive, and sweeps on a timer for
 * the things a listener cannot see: retries coming due, and leases whose
 * worker died.
 *
 * **Scheduled** — `runOnce()` from a cron job or an HTTP endpoint. Same code
 * path, no background timers, nothing to keep warm.
 *
 * ### Why there is no transaction anywhere in here
 *
 * Claiming one document does not need one. Each claim is a single write
 * conditioned on the document version we just read, which takes no lock: the
 * dispatchers that lose fail instantly and move on, instead of queuing behind
 * each other's read locks. See `docs/concurrency.md`.
 */
export class QueueDispatcher {
  readonly instanceId: string

  private readonly store: FirestoreEventStore
  private readonly runner: EventRunner
  private readonly clock: Clock
  private readonly logger: Logger

  private readonly poolSize: number
  private readonly batchSize: number
  private readonly leaseTtlMs: number
  private readonly handlerTimeoutMs: number
  private readonly sweepIntervalMs: number
  private readonly watchForNewEvents: boolean
  private readonly onTick: ((summary: TickSummary) => void) | undefined

  private started = false
  private unsubscribe: Unsubscribe | undefined
  private sweepTimer: ReturnType<typeof setInterval> | undefined
  /** The pass currently in flight, if any. */
  private pump: Promise<void> | undefined
  /** Something asked for a pass while one was already running. */
  private pumpAgain = false

  constructor(
    dependencies: DispatcherDependencies,
    options: DispatcherOptions = {},
  ) {
    this.store = dependencies.store
    this.runner = dependencies.runner
    this.clock = dependencies.clock
    this.logger = dependencies.logger

    this.poolSize = options.poolSize ?? DEFAULTS.poolSize
    this.batchSize = options.batchSize ?? DEFAULTS.batchSize
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULTS.handlerTimeoutMs
    this.leaseTtlMs = options.leaseTtlMs ?? this.handlerTimeoutMs * 2
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULTS.sweepIntervalMs
    this.watchForNewEvents =
      options.watchForNewEvents ?? DEFAULTS.watchForNewEvents
    this.onTick = options.onTick
    this.instanceId = options.instanceId ?? createInstanceId()

    this.assertUsableTimings()
  }

  /** Whether the background loop is running. */
  get running(): boolean {
    return this.started
  }

  // ── one pass ────────────────────────────────────────────────────────────

  /**
   * Claims up to `min(poolSize, batchSize)` due events, runs them with
   * bounded concurrency, and waits for all of them to settle.
   *
   * Safe to call directly — this is the whole dispatcher for anyone driving
   * it from a scheduler.
   */
  async runOnce(): Promise<TickSummary> {
    const startedAt = this.clock.now()
    const capacity = Math.min(this.poolSize, this.batchSize)

    const due = await this.store.findDue(capacity, this.clock.now())

    const outcomes = await mapWithConcurrency(
      due,
      this.poolSize,
      (stored) => this.claimAndRun(stored),
    )

    const summary = summarise(outcomes, this.clock.now() - startedAt)
    this.onTick?.(summary)
    return summary
  }

  /**
   * Returns events whose lease has lapsed to the queue.
   *
   * This is the only thing that rescues an event from a worker that was
   * killed mid-flight — nothing else will ever move it. Returns how many were
   * reclaimed.
   */
  async sweepOnce(): Promise<number> {
    const expired = await this.store.findExpiredLeases(
      this.batchSize,
      this.clock.now(),
    )

    const reclaimed = await mapWithConcurrency(
      expired,
      this.poolSize,
      async (stored) => (await this.store.requeue(stored)) !== null,
    )

    const count = reclaimed.filter(Boolean).length
    if (count > 0) {
      this.logger.log('warn', 'Reclaimed events from expired leases', {
        count,
        instanceId: this.instanceId,
      })
    }
    return count
  }

  // ── the background loop ─────────────────────────────────────────────────

  /** Starts the listener and the sweep. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true

    if (this.watchForNewEvents) {
      this.unsubscribe = this.store.watchPending(
        () => this.wake(),
        (error) => {
          this.logger.log('error', 'Pending-events listener failed', {
            error: error.message,
          })
        },
      )
    }

    this.sweepTimer = setInterval(() => {
      void this.sweepAndWake()
    }, this.sweepIntervalMs)

    this.logger.log('info', 'Dispatcher started', {
      instanceId: this.instanceId,
      collection: this.store.path,
      poolSize: this.poolSize,
      sweepIntervalMs: this.sweepIntervalMs,
    })

    this.wake()
  }

  /** Stops accepting new work and waits for in-flight handlers. Idempotent. */
  async stop(): Promise<void> {
    if (!this.started) return
    this.started = false

    this.unsubscribe?.()
    this.unsubscribe = undefined

    clearInterval(this.sweepTimer)
    this.sweepTimer = undefined

    await this.pump
    this.logger.log('info', 'Dispatcher stopped', {
      instanceId: this.instanceId,
    })
  }

  // ── internals ───────────────────────────────────────────────────────────

  private async claimAndRun(stored: StoredEvent): Promise<RunOutcome> {
    const claimed = await this.store.claim(stored, {
      owner: this.instanceId,
      ttlMs: this.leaseTtlMs,
    })

    // Another dispatcher claimed it between our query and our write. Expected,
    // cheap, and nothing to do about it.
    if (claimed === null) return { status: 'lost', event: stored.event }

    return this.runner.run(claimed)
  }

  /**
   * Asks for a pass, coalescing requests.
   *
   * Several things wake the dispatcher at once — a new event, the sweep, the
   * end of the previous pass. Without coalescing they would each start their
   * own pass and fight over the same documents.
   */
  private wake(): void {
    if (this.pump !== undefined) {
      this.pumpAgain = true
      return
    }

    this.pump = this.drain().finally(() => {
      this.pump = undefined
      if (this.pumpAgain && this.started) {
        this.pumpAgain = false
        this.wake()
      }
    })
  }

  /** Keeps running passes for as long as each one finds work. */
  private async drain(): Promise<void> {
    while (this.started) {
      try {
        const summary = await this.runOnce()
        if (summary.claimed === 0) return
      } catch (error) {
        // A failing pass is usually Firestore being briefly unavailable.
        // Stop draining and wait to be woken again rather than spinning.
        this.logger.log('error', 'Dispatcher pass failed', {
          instanceId: this.instanceId,
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }
    }
  }

  private async sweepAndWake(): Promise<void> {
    try {
      await this.sweepOnce()
    } catch (error) {
      this.logger.log('error', 'Sweep failed', {
        instanceId: this.instanceId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    // Even if the sweep found nothing, retries may have come due since the
    // last pass — and no listener will ever tell us that.
    this.wake()
  }

  /**
   * A handler that outlives its lease is the one genuinely dangerous
   * misconfiguration: the sweep would hand the event to a second worker while
   * the first is still running it.
   */
  private assertUsableTimings(): void {
    if (this.handlerTimeoutMs >= this.leaseTtlMs) {
      throw new ConfigurationError(
        `handlerTimeoutMs (${this.handlerTimeoutMs}) must be less than leaseTtlMs ` +
          `(${this.leaseTtlMs}), otherwise a slow handler has its event reclaimed ` +
          `and run a second time while it is still working.`,
      )
    }

    if (this.poolSize < 1) {
      throw new ConfigurationError(
        `poolSize must be at least 1, got ${this.poolSize}.`,
      )
    }

    if (this.batchSize < 1) {
      throw new ConfigurationError(
        `batchSize must be at least 1, got ${this.batchSize}.`,
      )
    }
  }
}

function summarise(outcomes: RunOutcome[], durationMs: number): TickSummary {
  const summary: TickSummary = {
    claimed: 0,
    succeeded: 0,
    retried: 0,
    deadLettered: 0,
    lost: 0,
    durationMs,
  }

  for (const outcome of outcomes) {
    if (outcome.status === 'lost') {
      summary.lost += 1
      continue
    }

    summary.claimed += 1
    if (outcome.status === 'succeeded') summary.succeeded += 1
    else if (outcome.status === 'retried') summary.retried += 1
    else summary.deadLettered += 1
  }

  return summary
}
