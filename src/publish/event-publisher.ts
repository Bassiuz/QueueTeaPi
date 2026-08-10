import type { ResolvedDelivery } from '../config/queue-config.js'
import { ConfigurationError, QueueTeaPiError } from '../errors.js'
import type { FirestoreEventStore } from '../events/event-store.js'
import type {
  DeliveryMode,
  EventActor,
  EventStatus,
  QueuedEvent,
} from '../events/queued-event.js'
import type { EventRunner } from '../dispatch/event-runner.js'
import type { Clock } from '../support/clock.js'

/** Everything you can say when publishing an event. */
export interface PublishInput<Payload = unknown> {
  /** The stream this belongs to, e.g. `"medication-agreements"`. */
  topic: string
  /** What happened, e.g. `"stock-updated"`. */
  name: string
  /** The event body. Must be Firestore-serialisable; `undefined` is dropped. */
  payload?: Payload
  /** Who caused it. */
  actor?: EventActor | null
  /** Groups related events for tracing. Does not affect scheduling. */
  orderKey?: string | null
  /** Tracing headers to carry to the handler. */
  trace?: Record<string, string> | null
  /** Overrides the configured delivery mode for this one call. */
  mode?: DeliveryMode
  /** Hold the event back for this many milliseconds. Queued mode only. */
  delayMs?: number
  /** Hold the event back until this epoch millisecond. Queued mode only. */
  availableAt?: number
}

export interface PublishResult<Result = unknown> {
  /** The ledger document id. Keep it if you want to look the event up later. */
  id: string
  status: EventStatus
  /** The handler's return value for inline delivery; `null` for queued. */
  result: Result | null
  /** The event as written. */
  event: QueuedEvent
}

export interface EventPublisherOptions {
  store: FirestoreEventStore
  runner: EventRunner
  clock: Clock
  deliveryFor: (topic: string, eventName: string) => ResolvedDelivery
  /** Lease TTL used while an inline handler runs. */
  inlineLeaseTtlMs: number
  /** Identifies this process in `leaseOwner` for inline runs. */
  instanceId: string
}

/**
 * The producer seam: one method, and the only thing your application code
 * needs to know about the queue.
 *
 * Whether an event runs now or later is a configuration decision, not a
 * calling-convention one — the same `publish()` call does both.
 */
export class EventPublisher {
  private readonly options: EventPublisherOptions

  constructor(options: EventPublisherOptions) {
    this.options = options
  }

  /**
   * Writes an event to the ledger.
   *
   * With `mode: 'queued'` this returns as soon as the write lands, and a
   * dispatcher runs the handler later.
   *
   * With `mode: 'inline'` it runs the handler itself and resolves with the
   * handler's return value. If the handler throws, **the error is rethrown to
   * you and the event is still recorded** — retried or dead-lettered by the
   * normal policy — so an inline failure is not a lost event.
   */
  async publish<Payload = unknown, Result = unknown>(
    input: PublishInput<Payload>,
  ): Promise<PublishResult<Result>> {
    const delivery = this.options.deliveryFor(input.topic, input.name)
    const mode = input.mode ?? delivery.mode
    const availableAt = this.resolveAvailableAt(input, mode)

    const appendInput = {
      topic: input.topic,
      name: input.name,
      payload: input.payload,
      actor: input.actor ?? null,
      orderKey: input.orderKey ?? null,
      trace: input.trace ?? null,
      mode,
      maxAttempts: delivery.maxAttempts,
      availableAt,
    }

    if (mode === 'queued') {
      const stored = await this.options.store.append(appendInput)
      return {
        id: stored.event.id,
        status: stored.event.status,
        result: null,
        event: stored.event,
      }
    }

    // Inline: write the event already claimed, so there is a durable record
    // before the handler runs but no second round trip to claim it.
    const stored = await this.options.store.append(appendInput, {
      owner: `inline:${this.options.instanceId}`,
      ttlMs: this.options.inlineLeaseTtlMs,
    })

    const outcome = await this.options.runner.run(stored)

    if (outcome.status === 'succeeded') {
      return {
        id: outcome.event.id,
        status: outcome.event.status,
        result: (outcome.result ?? null) as Result | null,
        event: outcome.event,
      }
    }

    if (outcome.status === 'lost') {
      throw new InlineDeliveryLostError(outcome.event.id)
    }

    throw outcome.error
  }

  private resolveAvailableAt(
    input: PublishInput<unknown>,
    mode: DeliveryMode,
  ): number {
    const now = this.options.clock.now()
    const { availableAt, delayMs } = input

    if (availableAt !== undefined || delayMs !== undefined) {
      if (mode === 'inline') {
        throw new ConfigurationError(
          `Cannot delay an inline event ("${input.topic}/${input.name}"): inline ` +
            `delivery runs the handler during publish(). Use mode: "queued" for ` +
            `delayed delivery.`,
        )
      }
    }

    if (availableAt !== undefined) return availableAt
    if (delayMs !== undefined) return now + delayMs
    return now
  }
}

/**
 * Raised when an inline event was taken over by another process mid-run — so
 * we neither have a result nor an error to report. Vanishingly rare: it needs
 * the inline lease to lapse while the handler is still going.
 */
export class InlineDeliveryLostError extends QueueTeaPiError {
  constructor(readonly eventId: string) {
    super(
      `Inline event ${eventId} was reclaimed by another worker before it ` +
        `finished. It remains in the ledger and will be retried.`,
    )
  }
}
