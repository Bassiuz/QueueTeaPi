import type { DocumentVersion } from '../firestore/firestore-types.js'

/**
 * Where an event is in its life.
 *
 * ```
 *   pending ──claim──► leased ──2xx──────────────► done
 *      ▲                 │
 *      │                 └──error, budget left──► pending  (with lastError set)
 *      │                 │
 *      │                 └──error, budget spent─► dead
 *      │                 │
 *      └──lease expired──┘   (a worker died mid-flight; the sweep frees it)
 * ```
 *
 * There is deliberately no separate `failed` status. An event that failed but
 * still has retries left is simply `pending` again with `lastError` filled in
 * — one claimable status keeps the claim query (and its index) to a single
 * shape. The dashboard shows those as "retrying".
 */
export type EventStatus = 'pending' | 'leased' | 'done' | 'dead'

/** All statuses, in the order a dashboard should present them. */
export const EVENT_STATUSES: readonly EventStatus[] = [
  'pending',
  'leased',
  'done',
  'dead',
]

/**
 * Whether `publish()` waits for the handler.
 *
 * - `inline`  — publish runs the handler itself and returns its result. Use
 *               it when a user is waiting on the outcome.
 * - `queued`  — publish returns as soon as the event is written, and a
 *               dispatcher runs it later.
 *
 * Both modes write the same document and run the same handler. Only the
 * moment of execution differs.
 */
export type DeliveryMode = 'inline' | 'queued'

/** Who or what caused an event. Free-form; stored as-is. */
export interface EventActor {
  id?: string
  type?: string
  [key: string]: unknown
}

/** A serialisable snapshot of whatever a handler threw. */
export interface EventError {
  name: string
  message: string
  stack: string | null
  /** True when the error asked to skip the remaining retry budget. */
  permanent: boolean
  /** When the failure was recorded, in epoch milliseconds. */
  at: number
}

/**
 * One row in the ledger.
 *
 * The top half is the envelope — what you published. The bottom half is the
 * queue state — what a message broker normally hides from you.
 *
 * All timestamps are epoch milliseconds (`Date.now()`), not Firestore
 * `Timestamp` objects. One numeric representation keeps comparisons,
 * queries, indexes and tests identical everywhere.
 */
export interface QueuedEvent<Payload = unknown, Result = unknown> {
  /** Firestore document id. */
  id: string

  // ── the envelope ────────────────────────────────────────────────────────
  /** Logical stream this event belongs to, e.g. `"medication-agreements"`. */
  topic: string
  /** What happened, e.g. `"stock-updated"`. */
  name: string
  /** The event body. Must be Firestore-serialisable. */
  payload: Payload
  /** Who triggered it, if known. */
  actor: EventActor | null
  /**
   * Groups related events so they can be found and traced together.
   *
   * Recorded only — the dispatcher does not order by it. See the "Ordering"
   * section of the README.
   */
  orderKey: string | null
  /** Distributed-tracing headers to propagate, e.g. `sentry-trace`. */
  trace: Record<string, string> | null

  // ── the queue state ─────────────────────────────────────────────────────
  mode: DeliveryMode
  status: EventStatus
  /** How many times a handler has been started for this event. */
  attempts: number
  /** Attempt budget; on exhaustion the event becomes `dead`. */
  maxAttempts: number
  /** Epoch ms; the event is claimable once `nextAttemptAt <= now`. */
  nextAttemptAt: number
  /** Which dispatcher instance currently owns the event, if any. */
  leaseOwner: string | null
  /** Epoch ms; after this the sweep may reclaim the event. */
  leaseExpiresAt: number | null

  // ── the outcome ─────────────────────────────────────────────────────────
  /** Whatever the handler returned. `null` until it succeeds. */
  result: Result | null
  /** The most recent failure. Kept even after a later success. */
  lastError: EventError | null

  // ── timings ─────────────────────────────────────────────────────────────
  createdAt: number
  updatedAt: number
  /** When the most recent attempt was claimed. */
  startedAt: number | null
  /** When the event reached `done` or `dead`. */
  finishedAt: number | null
}

/**
 * An event together with the document version it was read at.
 *
 * The version is what every subsequent write is conditioned on, so a
 * dispatcher can never overwrite work another dispatcher has already claimed.
 */
export interface StoredEvent<Payload = unknown, Result = unknown> {
  event: QueuedEvent<Payload, Result>
  version: DocumentVersion
}
