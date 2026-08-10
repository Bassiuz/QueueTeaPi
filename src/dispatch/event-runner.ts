import { computeBackoffMs } from '../config/backoff.js'
import type { ResolvedDelivery } from '../config/queue-config.js'
import {
  HandlerTimeoutError,
  PermanentError,
  UnregisteredHandlerError,
} from '../errors.js'
import { describeError } from '../events/event-serialization.js'
import type { FirestoreEventStore } from '../events/event-store.js'
import type { QueuedEvent, StoredEvent } from '../events/queued-event.js'
import type { HandlerRegistry } from '../handlers/handler-registry.js'
import type { Clock } from '../support/clock.js'
import { withTimeout } from '../support/concurrency.js'
import type { Logger } from '../support/logger.js'

/**
 * How a single attempt ended.
 *
 * `lost` is not a failure of the event — it means another dispatcher had
 * already taken it, or the sweep reclaimed it while our handler was still
 * running. Either way the event is somebody else's problem now.
 */
export type RunStatus = 'succeeded' | 'retried' | 'dead' | 'lost'

export interface RunOutcome<Result = unknown> {
  status: RunStatus
  /** The event as it now stands in the ledger. */
  event: QueuedEvent
  /** What the handler returned, when it succeeded. */
  result?: Result
  /** What the handler threw, when it did not. */
  error?: unknown
}

export interface EventRunnerOptions {
  store: FirestoreEventStore
  handlers: HandlerRegistry
  clock: Clock
  logger: Logger
  /** Looks up the retry policy for a topic/name pair. */
  deliveryFor: (topic: string, eventName: string) => ResolvedDelivery
  /** How long a handler may run before it is abandoned. */
  handlerTimeoutMs: number
  /** Injectable for deterministic backoff jitter in tests. */
  random?: () => number
}

/**
 * Runs one already-claimed event and writes down what happened.
 *
 * Both delivery modes end up here: the dispatcher uses it for queued events,
 * and `publish()` uses it directly for inline ones. That is deliberate —
 * there is exactly one place where a handler is called, timed out,
 * retried and dead-lettered, so the two modes cannot drift apart.
 */
export class EventRunner {
  private readonly options: EventRunnerOptions

  constructor(options: EventRunnerOptions) {
    this.options = options
  }

  async run(claimed: StoredEvent): Promise<RunOutcome> {
    const { store, handlers, logger, handlerTimeoutMs } = this.options
    const { event } = claimed

    try {
      const handler = handlers.resolve(event.topic, event.name)
      if (handler === undefined) {
        throw new UnregisteredHandlerError(event.topic, event.name)
      }

      const result = await withTimeout(
        Promise.resolve(handler.handle(event)),
        handlerTimeoutMs,
        () =>
          new HandlerTimeoutError(event.topic, event.name, handlerTimeoutMs),
      )

      const settled = await store.markDone(claimed, result)
      if (settled === null) return this.lost(event, 'success')

      logger.log('debug', 'Event handled', {
        eventId: event.id,
        topic: event.topic,
        name: event.name,
        attempts: event.attempts,
      })

      return { status: 'succeeded', event: settled.event, result }
    } catch (error) {
      return this.recordFailure(claimed, error)
    }
  }

  private async recordFailure(
    claimed: StoredEvent,
    error: unknown,
  ): Promise<RunOutcome> {
    const { store, clock, logger, deliveryFor } = this.options
    const { event } = claimed

    const delivery = deliveryFor(event.topic, event.name)
    const permanent = error instanceof PermanentError
    const budgetSpent = event.attempts >= delivery.maxAttempts
    const described = describeError(error, clock.now(), permanent)

    if (permanent || budgetSpent) {
      const settled = await store.markDead(claimed, described)
      if (settled === null) return this.lost(event, 'failure')

      logger.log('error', 'Event dead-lettered', {
        eventId: event.id,
        topic: event.topic,
        name: event.name,
        attempts: event.attempts,
        reason: permanent ? 'permanent-error' : 'attempts-exhausted',
        error: described.message,
      })

      return { status: 'dead', event: settled.event, error }
    }

    const backoffMs = computeBackoffMs(
      event.attempts,
      delivery.backoff,
      this.options.random,
    )
    const nextAttemptAt = clock.now() + backoffMs

    const settled = await store.markForRetry(claimed, described, nextAttemptAt)
    if (settled === null) return this.lost(event, 'failure')

    logger.log('warn', 'Event failed, retry scheduled', {
      eventId: event.id,
      topic: event.topic,
      name: event.name,
      attempts: event.attempts,
      maxAttempts: delivery.maxAttempts,
      retryInMs: backoffMs,
      error: described.message,
    })

    return { status: 'retried', event: settled.event, error }
  }

  /** The settle write was rejected: the event is no longer ours to record. */
  private lost(event: QueuedEvent, after: 'success' | 'failure'): RunOutcome {
    this.options.logger.log('warn', 'Lost the event before settling it', {
      eventId: event.id,
      topic: event.topic,
      name: event.name,
      after,
    })
    return { status: 'lost', event }
  }
}
