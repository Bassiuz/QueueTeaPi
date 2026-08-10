import { beforeEach, describe, expect, it } from 'vitest'

import {
  FirestoreEventStore,
  type AppendInput,
} from '../src/events/event-store.js'
import type { StoredEvent } from '../src/events/queued-event.js'
import { MemoryFirestore } from '../src/testing/memory-firestore.js'
import { TestClock } from './support/harness.js'

const COLLECTION = 'ledger'

let firestore: MemoryFirestore
let clock: TestClock
let store: FirestoreEventStore
let sequence: number

beforeEach(() => {
  firestore = new MemoryFirestore()
  clock = new TestClock()
  sequence = 0
  store = new FirestoreEventStore({
    firestore,
    collectionPath: COLLECTION,
    clock,
    generateId: () => `event-${(sequence += 1)}`,
  })
})

function anInput(overrides: Partial<AppendInput> = {}): AppendInput {
  return {
    topic: 'orders',
    name: 'placed',
    payload: { total: 1 },
    mode: 'queued',
    maxAttempts: 3,
    ...overrides,
  }
}

describe('append', () => {
  it('writes a pending event that is due immediately', async () => {
    const { event } = await store.append(anInput())

    expect(event).toMatchObject({
      id: 'event-1',
      topic: 'orders',
      name: 'placed',
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
      nextAttemptAt: clock.now(),
      leaseOwner: null,
      leaseExpiresAt: null,
      startedAt: null,
      finishedAt: null,
      createdAt: clock.now(),
    })
  })

  it('defaults the optional envelope fields to null', async () => {
    const { event } = await store.append(anInput({ payload: undefined }))
    expect(event).toMatchObject({
      payload: null,
      actor: null,
      orderKey: null,
      trace: null,
      result: null,
      lastError: null,
    })
  })

  it('keeps the envelope fields it is given', async () => {
    const { event } = await store.append(
      anInput({
        actor: { id: 'user-1' },
        orderKey: 'order-9',
        trace: { 'sentry-trace': 'abc' },
      }),
    )

    expect(event.actor).toEqual({ id: 'user-1' })
    expect(event.orderKey).toBe('order-9')
    expect(event.trace).toEqual({ 'sentry-trace': 'abc' })
  })

  it('honours a future availableAt', async () => {
    const availableAt = clock.now() + 60_000
    const { event } = await store.append(anInput({ availableAt }))
    expect(event.nextAttemptAt).toBe(availableAt)
  })

  it('can write an event already claimed, for inline delivery', async () => {
    const { event } = await store.append(anInput(), {
      owner: 'inline:worker-1',
      ttlMs: 30_000,
    })

    expect(event).toMatchObject({
      status: 'leased',
      attempts: 1,
      leaseOwner: 'inline:worker-1',
      leaseExpiresAt: clock.now() + 30_000,
      startedAt: clock.now(),
    })
  })

  it('persists the event under its generated id', async () => {
    await store.append(anInput())
    expect(firestore.peek(COLLECTION, 'event-1')).toMatchObject({
      topic: 'orders',
    })
  })

  it('generates random ids when none is supplied', async () => {
    const defaultStore = new FirestoreEventStore({
      firestore,
      collectionPath: COLLECTION,
      clock,
    })

    const first = await defaultStore.append(anInput())
    const second = await defaultStore.append(anInput())
    expect(first.event.id).not.toBe(second.event.id)
  })

  it('exposes the collection path it was configured with', () => {
    expect(store.path).toBe(COLLECTION)
  })
})

describe('claim', () => {
  it('takes ownership and counts the attempt', async () => {
    const stored = await store.append(anInput())

    const claimed = await store.claim(stored, { owner: 'worker-1', ttlMs: 5_000 })

    expect(claimed?.event).toMatchObject({
      status: 'leased',
      attempts: 1,
      leaseOwner: 'worker-1',
      leaseExpiresAt: clock.now() + 5_000,
      startedAt: clock.now(),
    })
  })

  it('returns null when another worker claimed it first', async () => {
    const stored = await store.append(anInput())

    const first = await store.claim(stored, { owner: 'worker-1', ttlMs: 5_000 })
    const second = await store.claim(stored, { owner: 'worker-2', ttlMs: 5_000 })

    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(firestore.peek(COLLECTION, 'event-1')).toMatchObject({
      leaseOwner: 'worker-1',
    })
  })

  it('returns null when the document has been deleted', async () => {
    const stored = await store.append(anInput())
    await store.collection.doc(stored.event.id).delete()

    expect(await store.claim(stored, { owner: 'w', ttlMs: 1 })).toBeNull()
  })

  it('gives back a version that can be used for the next write', async () => {
    const stored = await store.append(anInput())
    const claimed = await store.claim(stored, { owner: 'w', ttlMs: 5_000 })

    expect(await store.markDone(claimed!, { ok: true })).not.toBeNull()
  })

  it('rethrows errors that are not a lost race', async () => {
    const stored = await store.append(anInput())
    firestore.failWith = (operation) => {
      if (operation === 'update') throw new Error('network down')
    }

    await expect(
      store.claim(stored, { owner: 'w', ttlMs: 1 }),
    ).rejects.toThrow('network down')
  })
})

describe('settling', () => {
  let claimed: StoredEvent

  beforeEach(async () => {
    const stored = await store.append(anInput())
    claimed = (await store.claim(stored, { owner: 'w', ttlMs: 5_000 }))!
  })

  it('markDone stores the result and releases the lease', async () => {
    clock.advance(1_000)
    const settled = await store.markDone(claimed, { charged: true })

    expect(settled?.event).toMatchObject({
      status: 'done',
      result: { charged: true },
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: clock.now(),
    })
  })

  it('markDone turns an undefined result into null', async () => {
    const settled = await store.markDone(claimed, undefined)
    expect(settled?.event.result).toBeNull()
    expect(firestore.peek(COLLECTION, 'event-1')).toMatchObject({ result: null })
  })

  it('markForRetry puts the event back with its error and next attempt time', async () => {
    const error = {
      name: 'Error',
      message: 'flaky',
      stack: null,
      permanent: false,
      at: clock.now(),
    }

    const settled = await store.markForRetry(claimed, error, clock.now() + 10_000)

    expect(settled?.event).toMatchObject({
      status: 'pending',
      lastError: error,
      nextAttemptAt: clock.now() + 10_000,
      leaseOwner: null,
      attempts: 1,
    })
  })

  it('markDead records the error and finishes the event', async () => {
    const error = {
      name: 'PermanentError',
      message: 'never going to work',
      stack: null,
      permanent: true,
      at: clock.now(),
    }

    const settled = await store.markDead(claimed, error)

    expect(settled?.event).toMatchObject({
      status: 'dead',
      lastError: error,
      finishedAt: clock.now(),
      leaseOwner: null,
    })
  })

  it('returns null when the event was taken back before settling', async () => {
    await store.requeue(claimed)
    expect(await store.markDone(claimed, 'too late')).toBeNull()
  })
})

describe('requeue', () => {
  it('returns an event to pending, keeping its attempt count', async () => {
    const stored = await store.append(anInput())
    const claimed = (await store.claim(stored, { owner: 'w', ttlMs: 1 }))!

    const requeued = await store.requeue(claimed)

    expect(requeued?.event).toMatchObject({
      status: 'pending',
      attempts: 1,
      leaseOwner: null,
      leaseExpiresAt: null,
      finishedAt: null,
      nextAttemptAt: clock.now(),
    })
  })

  it('can reset the attempt budget, which is what replay wants', async () => {
    const stored = await store.append(anInput())
    const claimed = (await store.claim(stored, { owner: 'w', ttlMs: 1 }))!

    const requeued = await store.requeue(claimed, { resetAttempts: true })
    expect(requeued?.event.attempts).toBe(0)
  })

  it('can schedule the retry for later', async () => {
    const stored = await store.append(anInput())
    const requeued = await store.requeue(stored, {
      availableAt: clock.now() + 900,
    })
    expect(requeued?.event.nextAttemptAt).toBe(clock.now() + 900)
  })
})

describe('queries', () => {
  beforeEach(async () => {
    // due now
    await store.append(anInput({ name: 'first' }))
    clock.advance(10)
    await store.append(anInput({ name: 'second' }))
    // not due yet
    clock.advance(10)
    await store.append(
      anInput({ name: 'later', availableAt: clock.now() + 60_000 }),
    )
  })

  it('findDue returns only events whose time has come, earliest first', async () => {
    const due = await store.findDue(10, clock.now())
    expect(due.map((entry) => entry.event.name)).toEqual(['first', 'second'])
  })

  it('findDue respects its limit', async () => {
    expect(await store.findDue(1, clock.now())).toHaveLength(1)
  })

  it('findDue picks up an event once its retry falls due', async () => {
    clock.advance(60_000)
    const due = await store.findDue(10, clock.now())
    expect(due.map((entry) => entry.event.name)).toContain('later')
  })

  it('findDue carries the document version for the claim that follows', async () => {
    const [first] = await store.findDue(1, clock.now())
    expect(first?.version).toBeDefined()
    expect(await store.claim(first!, { owner: 'w', ttlMs: 1 })).not.toBeNull()
  })

  it('findExpiredLeases finds only leases that have lapsed', async () => {
    const [first, second] = await store.findDue(2, clock.now())
    await store.claim(first!, { owner: 'w', ttlMs: 1_000 })
    await store.claim(second!, { owner: 'w', ttlMs: 90_000 })

    clock.advance(5_000)

    const expired = await store.findExpiredLeases(10, clock.now())
    expect(expired.map((entry) => entry.event.name)).toEqual(['first'])
  })

  it('countDue counts the backlog without reading it', async () => {
    expect(await store.countDue(clock.now())).toBe(2)
  })

  it('count reports per status, and everything when unfiltered', async () => {
    expect(await store.count('pending')).toBe(3)
    expect(await store.count('done')).toBe(0)
    expect(await store.count()).toBe(3)
  })

  it('findOldestDue returns the longest-waiting event', async () => {
    expect((await store.findOldestDue(clock.now()))?.name).toBe('first')
  })

  it('findOldestDue returns null when nothing is due', async () => {
    const empty = new FirestoreEventStore({
      firestore: new MemoryFirestore(),
      collectionPath: 'empty',
      clock,
    })
    expect(await empty.findOldestDue(clock.now())).toBeNull()
  })

  it('list returns newest first', async () => {
    const listed = await store.list()
    expect(listed.map((entry) => entry.event.name)).toEqual([
      'later',
      'second',
      'first',
    ])
  })

  it('list can filter by status', async () => {
    const [first] = await store.findDue(1, clock.now())
    const claimed = (await store.claim(first!, { owner: 'w', ttlMs: 1 }))!
    await store.markDone(claimed, null)

    const done = await store.list({ status: 'done' })
    expect(done.map((entry) => entry.event.name)).toEqual(['first'])
  })

  it('list caps how much it returns', async () => {
    expect(await store.list({ limit: 2 })).toHaveLength(2)
  })

  it('get returns the event and its version', async () => {
    const stored = await store.get('event-1')
    expect(stored?.event.name).toBe('first')
    expect(stored?.version).toBeDefined()
  })

  it('get returns null for an id that is not there', async () => {
    expect(await store.get('nope')).toBeNull()
  })
})

describe('watchPending', () => {
  it('calls back when the pending set changes, and stops when unsubscribed', async () => {
    let calls = 0
    const unsubscribe = store.watchPending(() => {
      calls += 1
    })

    // Firestore delivers an initial snapshot on attach.
    expect(calls).toBe(1)

    await store.append(anInput())
    expect(calls).toBe(2)

    unsubscribe()
    await store.append(anInput())
    expect(calls).toBe(2)
    expect(firestore.listenerCount).toBe(0)
  })

  it('accepts an error callback', () => {
    const unsubscribe = store.watchPending(
      () => {},
      () => {},
    )
    expect(firestore.listenerCount).toBe(1)
    unsubscribe()
  })
})
