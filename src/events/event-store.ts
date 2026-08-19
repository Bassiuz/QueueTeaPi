import type {
  CollectionReferenceLike,
  FirestoreLike,
  QueryLike,
  Unsubscribe,
} from '../firestore/firestore-types.js'
import { isLostClaimError } from '../firestore/precondition.js'
import type { Clock } from '../support/clock.js'
import { randomEventId, type IdGenerator } from '../support/ids.js'
import { stripUndefined } from '../support/sanitize.js'
import { fromDocument, toDocument } from './event-serialization.js'
import type {
  DeliveryMode,
  EventActor,
  EventError,
  EventStatus,
  QueuedEvent,
  StoredEvent,
} from './queued-event.js'

/** What you hand to `append` to put a new event in the ledger. */
export interface AppendInput {
  topic: string
  name: string
  payload?: unknown
  actor?: EventActor | null
  orderKey?: string | null
  trace?: Record<string, string> | null
  mode: DeliveryMode
  maxAttempts: number
  /** Epoch ms before which the event must not run. Defaults to now. */
  availableAt?: number
}

/** Claim the event as part of writing it — used by inline delivery. */
export interface AppendLease {
  owner: string
  ttlMs: number
}

/** Filters for `list`. */
export interface ListOptions {
  status?: EventStatus
  limit?: number
}

export interface EventStoreOptions {
  firestore: FirestoreLike
  collectionPath: string
  clock: Clock
  generateId?: IdGenerator
}

/**
 * Every read and write against the ledger, and nowhere else in the package.
 *
 * Two rules hold throughout:
 *
 * 1. **Every write after the first is conditional.** It carries the document
 *    version we last read, so a dispatcher can never clobber a document that
 *    moved on without it. No transactions, and therefore no locks: losers
 *    fail instantly and move to the next event instead of queuing behind
 *    each other.
 *
 * 2. **A lost write is not an error.** Methods that could lose a race return
 *    `null` rather than throwing, because losing is the expected outcome for
 *    all but one of the dispatchers reading the same event.
 */
export class FirestoreEventStore {
  private readonly firestore: FirestoreLike
  private readonly collectionPath: string
  private readonly clock: Clock
  private readonly generateId: IdGenerator

  constructor(options: EventStoreOptions) {
    this.firestore = options.firestore
    this.collectionPath = options.collectionPath
    this.clock = options.clock
    this.generateId = options.generateId ?? randomEventId
  }

  /** The Firestore collection backing the queue. */
  get collection(): CollectionReferenceLike {
    return this.firestore.collection(this.collectionPath)
  }

  /** Where the ledger lives, for logs and the dashboard header. */
  get path(): string {
    return this.collectionPath
  }

  // ── writing ─────────────────────────────────────────────────────────────

  /**
   * Writes a new event.
   *
   * Pass `lease` to have it written already claimed, which is how inline
   * delivery avoids a second round trip before it can run the handler.
   */
  async append(input: AppendInput, lease?: AppendLease): Promise<StoredEvent> {
    const now = this.clock.now()
    const id = this.generateId()

    const event: QueuedEvent = {
      id,
      topic: input.topic,
      name: input.name,
      payload: input.payload ?? null,
      actor: input.actor ?? null,
      orderKey: input.orderKey ?? null,
      trace: input.trace ?? null,

      mode: input.mode,
      status: lease ? 'leased' : 'pending',
      attempts: lease ? 1 : 0,
      maxAttempts: input.maxAttempts,
      nextAttemptAt: input.availableAt ?? now,
      leaseOwner: lease ? lease.owner : null,
      leaseExpiresAt: lease ? now + lease.ttlMs : null,

      result: null,
      lastError: null,

      createdAt: now,
      updatedAt: now,
      startedAt: lease ? now : null,
      finishedAt: null,
    }

    const write = await this.document(id).set(toDocument(event))
    return { event, version: write.writeTime }
  }

  /**
   * Takes ownership of a due event.
   *
   * Returns `null` when another dispatcher got there first — the whole of
   * our mutual exclusion, in one conditional write.
   */
  async claim(
    stored: StoredEvent,
    lease: AppendLease,
  ): Promise<StoredEvent | null> {
    const now = this.clock.now()
    return this.patch(stored, {
      status: 'leased',
      attempts: stored.event.attempts + 1,
      leaseOwner: lease.owner,
      leaseExpiresAt: now + lease.ttlMs,
      startedAt: now,
      updatedAt: now,
    })
  }

  /** Records a successful run. */
  async markDone(
    stored: StoredEvent,
    result: unknown,
  ): Promise<StoredEvent | null> {
    const now = this.clock.now()
    return this.patch(stored, {
      status: 'done',
      result: stripUndefined(result) ?? null,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: now,
      updatedAt: now,
    })
  }

  /** Records a failure and schedules the next attempt. */
  async markForRetry(
    stored: StoredEvent,
    error: EventError,
    nextAttemptAt: number,
  ): Promise<StoredEvent | null> {
    return this.patch(stored, {
      status: 'pending',
      lastError: error,
      nextAttemptAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: this.clock.now(),
    })
  }

  /** Records a failure that has run out of retries. */
  async markDead(
    stored: StoredEvent,
    error: EventError,
  ): Promise<StoredEvent | null> {
    const now = this.clock.now()
    return this.patch(stored, {
      status: 'dead',
      lastError: error,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: now,
      updatedAt: now,
    })
  }

  /**
   * Returns an event to the queue.
   *
   * Used for two things: the sweep reclaiming a lease whose worker died, and
   * an operator replaying a dead event from the dashboard.
   */
  async requeue(
    stored: StoredEvent,
    options: { resetAttempts?: boolean; availableAt?: number } = {},
  ): Promise<StoredEvent | null> {
    const now = this.clock.now()
    return this.patch(stored, {
      status: 'pending',
      attempts: options.resetAttempts ? 0 : stored.event.attempts,
      nextAttemptAt: options.availableAt ?? now,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: null,
      updatedAt: now,
    })
  }

  // ── reading ─────────────────────────────────────────────────────────────

  /** Events that are ready to run right now, oldest deadline first. */
  async findDue(limit: number, now: number): Promise<StoredEvent[]> {
    const query = this.collection
      .where('status', '==', 'pending')
      .where('nextAttemptAt', '<=', now)
      .orderBy('nextAttemptAt', 'asc')
      .limit(limit)

    return this.readAll(query)
  }

  /** Leases that have lapsed, meaning the worker holding them is gone. */
  async findExpiredLeases(limit: number, now: number): Promise<StoredEvent[]> {
    const query = this.collection
      .where('status', '==', 'leased')
      .where('leaseExpiresAt', '<=', now)
      .orderBy('leaseExpiresAt', 'asc')
      .limit(limit)

    return this.readAll(query)
  }

  /** One event by id, or `null` if it has been deleted. */
  async get(id: string): Promise<StoredEvent | null> {
    const snapshot = await this.document(id).get()
    if (!snapshot.exists) return null

    return {
      event: fromDocument(snapshot.id, snapshot.data()),
      version: snapshot.updateTime,
    }
  }

  /**
   * Newest events first, optionally filtered by status. Used by the dashboard.
   *
   * Versions come back with the events so that a dashboard action — replaying
   * a dead event, say — is still a conditional write and cannot stomp on a
   * change made between the page load and the click.
   */
  async list(options: ListOptions = {}): Promise<StoredEvent[]> {
    let query: QueryLike = this.collection

    if (options.status !== undefined) {
      query = query.where('status', '==', options.status)
    }

    return this.readAll(
      query.orderBy('createdAt', 'desc').limit(options.limit ?? 50),
    )
  }

  /** How many events have a given status. A server-side aggregate, not a scan. */
  async count(status?: EventStatus): Promise<number> {
    const query: QueryLike =
      status === undefined
        ? this.collection
        : this.collection.where('status', '==', status)

    const snapshot = await query.count().get()
    return snapshot.data().count
  }

  /** How many pending events are due right now — the real backlog figure. */
  async countDue(now: number): Promise<number> {
    const snapshot = await this.collection
      .where('status', '==', 'pending')
      .where('nextAttemptAt', '<=', now)
      .count()
      .get()

    return snapshot.data().count
  }

  /** The event that has been waiting longest, for an "oldest item" gauge. */
  async findOldestDue(now: number): Promise<QueuedEvent | null> {
    const [oldest] = await this.findDue(1, now)
    return oldest?.event ?? null
  }

  // ── watching ────────────────────────────────────────────────────────────

  /**
   * Calls `onChange` whenever the set of pending events changes.
   *
   * Only one document is streamed: this is a doorbell, not a feed. The
   * dispatcher does its own query once woken, so paying to stream the whole
   * backlog would buy nothing.
   *
   * A listener cannot see time pass, so it never fires for an event whose
   * retry simply came due. That is what the sweep is for.
   */
  watchPending(
    onChange: () => void,
    onError?: (error: Error) => void,
  ): Unsubscribe {
    return this.collection
      .where('status', '==', 'pending')
      .orderBy('nextAttemptAt', 'asc')
      .limit(1)
      .onSnapshot(() => onChange(), onError)
  }

  // ── internals ───────────────────────────────────────────────────────────

  private document(id: string) {
    return this.collection.doc(id)
  }

  private async readAll(query: QueryLike): Promise<StoredEvent[]> {
    const snapshot = await query.get()
    return snapshot.docs.map((doc) => ({
      event: fromDocument(doc.id, doc.data()),
      version: doc.updateTime,
    }))
  }

  /**
   * Applies `changes`, but only if the document is still at the version we
   * read. Returns the updated event, or `null` if we lost the race.
   */
  private async patch(
    stored: StoredEvent,
    changes: Partial<QueuedEvent>,
  ): Promise<StoredEvent | null> {
    try {
      const write = await this.document(stored.event.id).update(
        stripUndefined(changes) as Record<string, unknown>,
        { lastUpdateTime: stored.version },
      )

      return {
        event: { ...stored.event, ...changes },
        version: write.writeTime,
      }
    } catch (error) {
      if (isLostClaimError(error)) return null
      throw error
    }
  }
}
