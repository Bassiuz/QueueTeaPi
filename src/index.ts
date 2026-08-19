/**
 * QueueTeaPi — a durable event queue whose backing store is one Firestore
 * collection. That collection is the queue, the dead-letter queue and the
 * audit log at the same time.
 *
 * Start here:
 *
 * ```ts
 * import { QueueTeaPi } from 'queueteapi'
 *
 * const queue = new QueueTeaPi({ firestore: getFirestore() })
 * queue.handlers.register('orders', 'placed', onOrderPlaced)
 *
 * await queue.publish({ topic: 'orders', name: 'placed', payload: order })
 * queue.createDispatcher().start()
 * ```
 */

// ── the queue ─────────────────────────────────────────────────────────────
export { QueueTeaPi, type QueueTeaPiOptions } from './queue-tea-pi.js'

export {
  EventPublisher,
  InlineDeliveryLostError,
  type EventPublisherOptions,
  type PublishInput,
  type PublishResult,
} from './publish/event-publisher.js'

// ── handlers ──────────────────────────────────────────────────────────────
export {
  toEventHandler,
  type EventHandler,
  type HandlerFunction,
  type HandlerLike,
} from './handlers/event-handler.js'

export {
  HandlerRegistry,
  type HandlerRegistration,
} from './handlers/handler-registry.js'

export {
  HttpEventHandler,
  HttpHandlerError,
  PermanentHttpHandlerError,
  defaultMessageEncoder,
  toPubSubEnvelope,
  type HttpEventHandlerOptions,
  type MessageEncoder,
  type PubSubPushEnvelope,
} from './handlers/http-event-handler.js'

// ── dispatching ───────────────────────────────────────────────────────────
export {
  QueueDispatcher,
  type DispatcherDependencies,
  type DispatcherOptions,
  type TickSummary,
} from './dispatch/dispatcher.js'

export {
  EventRunner,
  type EventRunnerOptions,
  type RunOutcome,
  type RunStatus,
} from './dispatch/event-runner.js'

// ── the ledger ────────────────────────────────────────────────────────────
export {
  FirestoreEventStore,
  type AppendInput,
  type AppendLease,
  type EventStoreOptions,
  type ListOptions,
} from './events/event-store.js'

export {
  describeError,
  fromDocument,
  toDocument,
} from './events/event-serialization.js'

export {
  EVENT_STATUSES,
  type DeliveryMode,
  type EventActor,
  type EventError,
  type EventStatus,
  type QueuedEvent,
  type StoredEvent,
} from './events/queued-event.js'

// ── configuration ─────────────────────────────────────────────────────────
export {
  DEFAULT_COLLECTION,
  DEFAULT_DELIVERY,
  resolveDelivery,
  type DeliverySettings,
  type ResolvedDelivery,
  type TopicConfig,
} from './config/queue-config.js'

export {
  DEFAULT_BACKOFF,
  computeBackoffMs,
  type BackoffPolicy,
} from './config/backoff.js'

// ── dev tools ─────────────────────────────────────────────────────────────
export {
  QueueInspector,
  type ListEventsOptions,
  type OldestDue,
  type QueueStats,
  type ReplayManyOptions,
  type ReplayManyResult,
} from './devtools/queue-inspector.js'

export {
  createDashboard,
  type DashboardHandler,
  type DashboardOptions,
  type DashboardRequest,
  type DashboardResponse,
} from './devtools/dashboard.js'

export {
  createNodeRequestListener,
  type NodeAdapterOptions,
  type NodeRequestLike,
  type NodeResponseLike,
} from './devtools/dashboard-node.js'

// ── errors ────────────────────────────────────────────────────────────────
export {
  ConfigurationError,
  HandlerTimeoutError,
  PermanentError,
  QueueTeaPiError,
  UnregisteredHandlerError,
} from './errors.js'

// ── plumbing you can replace ──────────────────────────────────────────────
export { systemClock, type Clock } from './support/clock.js'
export { consoleLogger, silentLogger, type LogLevel, type Logger } from './support/logger.js'
export { createInstanceId, randomEventId, type IdGenerator } from './support/ids.js'

export type {
  CollectionReferenceLike,
  DocumentReferenceLike,
  DocumentSnapshotLike,
  DocumentVersion,
  FirestoreLike,
  QueryLike,
  QuerySnapshotLike,
  Unsubscribe,
} from './firestore/firestore-types.js'
