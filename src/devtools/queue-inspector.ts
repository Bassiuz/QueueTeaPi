import type { FirestoreEventStore } from '../events/event-store.js'
import {
  EVENT_STATUSES,
  type EventStatus,
  type QueuedEvent,
} from '../events/queued-event.js'
import type { HandlerRegistry } from '../handlers/handler-registry.js'
import type { HandlerRegistration } from '../handlers/handler-registry.js'
import type { Clock } from '../support/clock.js'
import { mapWithConcurrency } from '../support/concurrency.js'

/** A snapshot of queue health, cheap enough to poll every few seconds. */
export interface QueueStats {
  /** The Firestore collection being reported on. */
  collection: string
  /** When this snapshot was taken, epoch ms. */
  generatedAt: number
  /** How many events sit in each status. */
  counts: Record<EventStatus, number>
  /** Every event in the ledger. */
  total: number
  /** Pending events that are ready to run right now — the real backlog. */
  dueNow: number
  /** The event that has been waiting longest, if anything is waiting. */
  oldestDue: OldestDue | null
  /** What the process reporting these stats knows how to handle. */
  handlers: HandlerRegistration[]
}

export interface OldestDue {
  id: string
  topic: string
  name: string
  attempts: number
  /** How long past its due time this event is, in milliseconds. */
  waitingMs: number
}

export interface ListEventsOptions {
  status?: EventStatus
  limit?: number
}

export interface ReplayManyOptions {
  /** Which events to replay. Defaults to `dead`. */
  status?: EventStatus
  /** Cap on how many to move in one go. Defaults to 100. */
  limit?: number
}

export interface ReplayManyResult {
  /** How many events matched and were attempted. */
  matched: number
  /** How many were actually moved back to `pending`. */
  replayed: number
}

/**
 * Read-only insight into the queue, plus the one write an operator actually
 * needs: putting an event back.
 *
 * This is the data layer behind both the dashboard and the CLI. It is kept
 * separate from either so that "what is in my queue?" is answerable from a
 * test, a script, a health check, or your own admin UI.
 */
export class QueueInspector {
  private readonly store: FirestoreEventStore
  private readonly clock: Clock
  private readonly handlers: HandlerRegistry

  constructor(options: {
    store: FirestoreEventStore
    clock: Clock
    handlers: HandlerRegistry
  }) {
    this.store = options.store
    this.clock = options.clock
    this.handlers = options.handlers
  }

  /**
   * Counts per status, the due backlog, and the oldest waiting event.
   *
   * The counts are Firestore aggregate queries, so this costs a handful of
   * reads rather than one per event — it stays cheap on a queue of any size.
   */
  async stats(): Promise<QueueStats> {
    const now = this.clock.now()

    const [counts, dueNow, oldest] = await Promise.all([
      this.countEachStatus(),
      this.store.countDue(now),
      this.store.findOldestDue(now),
    ])

    return {
      collection: this.store.path,
      generatedAt: now,
      counts,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      dueNow,
      oldestDue:
        oldest === null
          ? null
          : {
              id: oldest.id,
              topic: oldest.topic,
              name: oldest.name,
              attempts: oldest.attempts,
              waitingMs: Math.max(0, now - oldest.nextAttemptAt),
            },
      handlers: this.handlers.describe(),
    }
  }

  /** One aggregate query per status, all four in flight at once. */
  private async countEachStatus(): Promise<Record<EventStatus, number>> {
    const counts: Record<EventStatus, number> = {
      pending: 0,
      leased: 0,
      done: 0,
      dead: 0,
    }

    await mapWithConcurrency(
      EVENT_STATUSES,
      EVENT_STATUSES.length,
      async (status) => {
        counts[status] = await this.store.count(status)
      },
    )

    return counts
  }

  /** The most recent events, newest first, optionally filtered by status. */
  async list(options: ListEventsOptions = {}): Promise<QueuedEvent[]> {
    const stored = await this.store.list({
      status: options.status,
      limit: options.limit ?? 50,
    })
    return stored.map((entry) => entry.event)
  }

  /** One event by id, or `null` if there is no such document. */
  async get(id: string): Promise<QueuedEvent | null> {
    const stored = await this.store.get(id)
    return stored?.event ?? null
  }

  /**
   * Puts an event back in the queue with a fresh attempt budget.
   *
   * This is the whole replay story — no console, no re-publishing, no
   * copying payloads around. Returns the requeued event, or `null` if it no
   * longer exists or changed underneath us.
   */
  async replay(id: string): Promise<QueuedEvent | null> {
    const stored = await this.store.get(id)
    if (stored === null) return null

    const requeued = await this.store.requeue(stored, {
      resetAttempts: true,
      availableAt: this.clock.now(),
    })

    return requeued?.event ?? null
  }

  /** Replays a batch — by default, everything in the dead-letter queue. */
  async replayMany(options: ReplayManyOptions = {}): Promise<ReplayManyResult> {
    const stored = await this.store.list({
      status: options.status ?? 'dead',
      limit: options.limit ?? 100,
    })

    const results = await mapWithConcurrency(stored, 10, async (entry) => {
      const requeued = await this.store.requeue(entry, {
        resetAttempts: true,
        availableAt: this.clock.now(),
      })
      return requeued !== null
    })

    return {
      matched: stored.length,
      replayed: results.filter(Boolean).length,
    }
  }
}
