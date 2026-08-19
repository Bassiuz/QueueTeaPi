import {
  DEFAULT_COLLECTION,
  resolveDelivery,
  type DeliverySettings,
  type ResolvedDelivery,
  type TopicConfig,
} from './config/queue-config.js'
import { QueueInspector } from './devtools/queue-inspector.js'
import {
  QueueDispatcher,
  type DispatcherOptions,
} from './dispatch/dispatcher.js'
import { EventRunner } from './dispatch/event-runner.js'
import { ConfigurationError } from './errors.js'
import { FirestoreEventStore } from './events/event-store.js'
import type { FirestoreLike } from './firestore/firestore-types.js'
import { HandlerRegistry } from './handlers/handler-registry.js'
import {
  EventPublisher,
  type PublishInput,
  type PublishResult,
} from './publish/event-publisher.js'
import { systemClock, type Clock } from './support/clock.js'
import { createInstanceId, type IdGenerator } from './support/ids.js'
import { silentLogger, type Logger } from './support/logger.js'

/** Everything needed to stand up a queue. Only `firestore` is required. */
export interface QueueTeaPiOptions {
  /**
   * The Firestore instance to store events in.
   *
   * This is also how you choose the *target*: pass a Firestore handle bound
   * to whichever project or named database you want, e.g.
   * `getFirestore(app, 'events-db')`.
   */
  firestore: FirestoreLike

  /**
   * Collection path holding the ledger. Defaults to `"queueteapi-events"`.
   *
   * Nested paths work too (`"system/queue/events"`), so the queue can live
   * out of the way of your domain collections.
   */
  collection?: string

  /** Per-topic and per-event delivery settings. */
  topics?: Record<string, TopicConfig>

  /** Settings applied to any topic that does not override them. */
  defaults?: DeliverySettings

  /** Bring your own registry, e.g. one shared across modules. */
  handlers?: HandlerRegistry

  /** How long an inline handler may run. Defaults to 60s. */
  handlerTimeoutMs?: number

  /** Where QueueTeaPi reports what it is doing. Silent by default. */
  logger?: Logger

  /** Overridable for tests. */
  clock?: Clock
  /** Overridable for tests. */
  generateId?: IdGenerator
  /** Overridable for tests; used for backoff jitter. */
  random?: () => number
  /** Identifies this process in `leaseOwner`. Defaults to a random id. */
  instanceId?: string
}

const DEFAULT_HANDLER_TIMEOUT_MS = 60_000

/**
 * The queue.
 *
 * ```ts
 * const queue = new QueueTeaPi({ firestore: getFirestore() })
 *
 * queue.handlers.register('orders', 'placed', async (event) => {
 *   await chargeCard(event.payload)
 * })
 *
 * await queue.publish({ topic: 'orders', name: 'placed', payload: order })
 *
 * queue.createDispatcher().start()
 * ```
 *
 * One object owns the three seams: `publish()` puts events in,
 * `handlers` says what runs them, and `createDispatcher()` moves them. Your
 * application only ever touches those.
 */
export class QueueTeaPi {
  /** Where handlers are wired to topics and event names. */
  readonly handlers: HandlerRegistry

  /** Direct access to the ledger. Rarely needed; useful for custom tooling. */
  readonly store: FirestoreEventStore

  /** Identifies this process in `leaseOwner` and in logs. */
  readonly instanceId: string

  private readonly options: QueueTeaPiOptions
  private readonly clock: Clock
  private readonly logger: Logger
  private readonly handlerTimeoutMs: number
  private readonly publisher: EventPublisher

  constructor(options: QueueTeaPiOptions) {
    if (options.firestore === undefined || options.firestore === null) {
      throw new ConfigurationError(
        'QueueTeaPi needs a `firestore` instance, e.g. getFirestore() from firebase-admin.',
      )
    }

    const collection = options.collection ?? DEFAULT_COLLECTION
    if (collection.trim() === '') {
      throw new ConfigurationError('`collection` must not be empty.')
    }

    this.options = options
    this.clock = options.clock ?? systemClock
    this.logger = options.logger ?? silentLogger
    this.handlerTimeoutMs =
      options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS
    this.handlers = options.handlers ?? new HandlerRegistry()
    this.instanceId = options.instanceId ?? createInstanceId()

    this.store = new FirestoreEventStore({
      firestore: options.firestore,
      collectionPath: collection,
      clock: this.clock,
      generateId: options.generateId,
    })

    this.publisher = new EventPublisher({
      store: this.store,
      runner: this.createRunner(this.handlerTimeoutMs),
      clock: this.clock,
      deliveryFor: (topic, name) => this.deliveryFor(topic, name),
      inlineLeaseTtlMs: this.handlerTimeoutMs * 2,
      instanceId: this.instanceId,
    })
  }

  /** The collection path the ledger lives in. */
  get collection(): string {
    return this.store.path
  }

  /**
   * Publishes an event.
   *
   * Returns once the event is durably written (queued mode) or once the
   * handler has finished (inline mode). See {@link EventPublisher.publish}.
   */
  publish<Payload = unknown, Result = unknown>(
    input: PublishInput<Payload>,
  ): Promise<PublishResult<Result>> {
    return this.publisher.publish<Payload, Result>(input)
  }

  /**
   * Builds a dispatcher.
   *
   * Call `start()` on it in a long-running service, or `runOnce()` from a
   * scheduled job. Nothing happens until you do one of those.
   */
  createDispatcher(options: DispatcherOptions = {}): QueueDispatcher {
    const handlerTimeoutMs = options.handlerTimeoutMs ?? this.handlerTimeoutMs

    return new QueueDispatcher(
      {
        store: this.store,
        runner: this.createRunner(handlerTimeoutMs),
        clock: this.clock,
        logger: this.logger,
      },
      { instanceId: this.instanceId, ...options, handlerTimeoutMs },
    )
  }

  /** Builds the read-only view used by the dashboard and the CLI. */
  createInspector(): QueueInspector {
    return new QueueInspector({
      store: this.store,
      clock: this.clock,
      handlers: this.handlers,
    })
  }

  /** The settings that apply to a given event, after all layers are merged. */
  deliveryFor(topic: string, eventName: string): ResolvedDelivery {
    return resolveDelivery(
      topic,
      eventName,
      this.options.topics,
      this.options.defaults,
    )
  }

  private createRunner(handlerTimeoutMs: number): EventRunner {
    return new EventRunner({
      store: this.store,
      handlers: this.handlers,
      clock: this.clock,
      logger: this.logger,
      deliveryFor: (topic, name) => this.deliveryFor(topic, name),
      handlerTimeoutMs,
      random: this.options.random,
    })
  }
}
