import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_DELIVERY } from '../src/config/queue-config.js'
import { QueueDispatcher } from '../src/dispatch/dispatcher.js'
import { EventRunner } from '../src/dispatch/event-runner.js'
import { ConfigurationError, PermanentError } from '../src/errors.js'
import { FirestoreEventStore } from '../src/events/event-store.js'
import { HandlerRegistry } from '../src/handlers/handler-registry.js'
import { MemoryFirestore } from '../src/testing/memory-firestore.js'
import { RecordingLogger, TestClock, waitUntil } from './support/harness.js'

const COLLECTION = 'ledger'

let firestore: MemoryFirestore
let clock: TestClock
let logger: RecordingLogger
let store: FirestoreEventStore
let handlers: HandlerRegistry
let running: QueueDispatcher[]

beforeEach(() => {
  firestore = new MemoryFirestore()
  clock = new TestClock()
  logger = new RecordingLogger()
  handlers = new HandlerRegistry()
  running = []

  let sequence = 0
  store = new FirestoreEventStore({
    firestore,
    collectionPath: COLLECTION,
    clock,
    generateId: () => `event-${(sequence += 1)}`,
  })
})

afterEach(async () => {
  for (const dispatcher of running) await dispatcher.stop()
})

function createDispatcher(
  options: ConstructorParameters<typeof QueueDispatcher>[1] = {},
): QueueDispatcher {
  const runner = new EventRunner({
    store,
    handlers,
    clock,
    logger,
    handlerTimeoutMs: options.handlerTimeoutMs ?? 1_000,
    random: () => 0,
    deliveryFor: () => ({
      ...DEFAULT_DELIVERY,
      maxAttempts: 2,
      backoff: { ...DEFAULT_DELIVERY.backoff, jitter: 0 },
    }),
  })

  const dispatcher = new QueueDispatcher(
    { store, runner, clock, logger },
    { handlerTimeoutMs: 1_000, leaseTtlMs: 60_000, ...options },
  )
  running.push(dispatcher)
  return dispatcher
}

async function publishEvents(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await store.append({
      topic: 'orders',
      name: 'placed',
      payload: { index },
      mode: 'queued',
      maxAttempts: 2,
    })
  }
}

describe('runOnce', () => {
  it('does nothing when the queue is empty', async () => {
    const summary = await createDispatcher().runOnce()

    expect(summary).toMatchObject({
      claimed: 0,
      succeeded: 0,
      retried: 0,
      deadLettered: 0,
      lost: 0,
    })
  })

  it('claims and runs everything that is due', async () => {
    const handled: number[] = []
    handlers.register('orders', 'placed', (event) => {
      handled.push((event.payload as { index: number }).index)
    })
    await publishEvents(3)

    const summary = await createDispatcher().runOnce()

    expect(summary).toMatchObject({ claimed: 3, succeeded: 3 })
    expect(handled.sort()).toEqual([0, 1, 2])
    expect(await store.count('done')).toBe(3)
  })

  it('leaves events that are not due yet alone', async () => {
    handlers.register('orders', 'placed', () => null)
    await store.append({
      topic: 'orders',
      name: 'placed',
      mode: 'queued',
      maxAttempts: 2,
      availableAt: clock.now() + 60_000,
    })

    expect((await createDispatcher().runOnce()).claimed).toBe(0)
  })

  it('takes no more than batchSize in one pass', async () => {
    handlers.register('orders', 'placed', () => null)
    await publishEvents(5)

    const dispatcher = createDispatcher({ batchSize: 2 })

    expect((await dispatcher.runOnce()).claimed).toBe(2)
    expect((await dispatcher.runOnce()).claimed).toBe(2)
    expect((await dispatcher.runOnce()).claimed).toBe(1)
  })

  it('takes no more than poolSize in one pass', async () => {
    handlers.register('orders', 'placed', () => null)
    await publishEvents(5)

    expect((await createDispatcher({ poolSize: 3 }).runOnce()).claimed).toBe(3)
  })

  it('never runs more handlers at once than poolSize allows', async () => {
    let inFlight = 0
    let peak = 0

    handlers.register('orders', 'placed', async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 2))
      inFlight -= 1
    })
    await publishEvents(8)

    await createDispatcher({ poolSize: 2, batchSize: 8 }).runOnce()

    expect(peak).toBe(2)
  })

  it('counts retried and dead-lettered events separately', async () => {
    handlers.register('orders', 'placed', () => {
      throw new Error('always fails')
    })
    await publishEvents(1)

    const dispatcher = createDispatcher()

    expect((await dispatcher.runOnce()).retried).toBe(1)

    clock.advance(20_000)
    expect((await dispatcher.runOnce()).deadLettered).toBe(1)
  })

  it('reports events another dispatcher claimed first as lost, not failed', async () => {
    handlers.register('orders', 'placed', () => null)
    await publishEvents(1)

    // Both read the same pending event before either writes.
    const first = createDispatcher({ instanceId: 'first' })
    const second = createDispatcher({ instanceId: 'second' })

    const [a, b] = await Promise.all([first.runOnce(), second.runOnce()])

    expect(a.claimed + b.claimed).toBe(1)
    expect(a.lost + b.lost).toBe(1)
    expect(await store.count('done')).toBe(1)
  })

  it('stamps its own instance id on the lease it holds', async () => {
    let ownerWhileRunning: string | null = null
    handlers.register('orders', 'placed', (event) => {
      // The lease is only held while the handler runs; it is released on settle.
      ownerWhileRunning = event.leaseOwner
      expect(firestore.peek(COLLECTION, 'event-1')).toMatchObject({
        status: 'leased',
        leaseOwner: 'dispatcher-abc',
      })
    })
    await publishEvents(1)

    await createDispatcher({ instanceId: 'dispatcher-abc' }).runOnce()

    expect(ownerWhileRunning).toBe('dispatcher-abc')
  })

  it('reports how long the pass took', async () => {
    handlers.register('orders', 'placed', () => {
      clock.advance(25)
    })
    await publishEvents(1)

    expect((await createDispatcher().runOnce()).durationMs).toBe(25)
  })

  it('calls onTick with the summary', async () => {
    const onTick = vi.fn()
    handlers.register('orders', 'placed', () => null)
    await publishEvents(1)

    await createDispatcher({ onTick }).runOnce()

    expect(onTick).toHaveBeenCalledWith(
      expect.objectContaining({ claimed: 1, succeeded: 1 }),
    )
  })

  it('dead-letters a permanent failure on the first attempt', async () => {
    handlers.register('orders', 'placed', () => {
      throw new PermanentError('malformed')
    })
    await publishEvents(1)

    expect((await createDispatcher().runOnce()).deadLettered).toBe(1)
  })
})

describe('sweepOnce', () => {
  it('returns lapsed leases to the queue', async () => {
    handlers.register('orders', 'placed', () => new Promise(() => {}))
    await publishEvents(1)

    await createDispatcher({ handlerTimeoutMs: 5, leaseTtlMs: 10 }).runOnce()
    expect(firestore.peek(COLLECTION, 'event-1')).toMatchObject({
      status: 'pending',
    })

    // Put it back into a leased state that has since expired.
    const stored = (await store.get('event-1'))!
    await store.claim(stored, { owner: 'dead-worker', ttlMs: 10 })
    clock.advance(1_000)

    expect(await createDispatcher().sweepOnce()).toBe(1)
    expect(firestore.peek(COLLECTION, 'event-1')).toMatchObject({
      status: 'pending',
      leaseOwner: null,
    })
  })

  it('leaves a lease that is still valid alone', async () => {
    await publishEvents(1)
    const stored = (await store.get('event-1'))!
    await store.claim(stored, { owner: 'busy-worker', ttlMs: 60_000 })

    expect(await createDispatcher().sweepOnce()).toBe(0)
    expect(firestore.peek(COLLECTION, 'event-1')).toMatchObject({
      status: 'leased',
    })
  })

  it('returns zero and stays quiet when there is nothing to reclaim', async () => {
    expect(await createDispatcher().sweepOnce()).toBe(0)
    expect(logger.messages('warn')).not.toContain(
      'Reclaimed events from expired leases',
    )
  })

  it('logs what it rescued', async () => {
    await publishEvents(1)
    const stored = (await store.get('event-1'))!
    await store.claim(stored, { owner: 'dead-worker', ttlMs: 10 })
    clock.advance(1_000)

    await createDispatcher().sweepOnce()

    expect(logger.messages('warn')).toContain(
      'Reclaimed events from expired leases',
    )
  })

  it('does not double-count a lease two sweeps race over', async () => {
    await publishEvents(1)
    const stored = (await store.get('event-1'))!
    await store.claim(stored, { owner: 'dead-worker', ttlMs: 10 })
    clock.advance(1_000)

    const results = await Promise.all([
      createDispatcher().sweepOnce(),
      createDispatcher().sweepOnce(),
    ])

    expect(results[0] + results[1]).toBe(1)
  })
})

describe('configuration', () => {
  it('rejects a handler timeout that outlives its lease', () => {
    expect(() =>
      createDispatcher({ handlerTimeoutMs: 60_000, leaseTtlMs: 30_000 }),
    ).toThrow(ConfigurationError)
  })

  it('explains why that combination is dangerous', () => {
    expect(() =>
      createDispatcher({ handlerTimeoutMs: 10, leaseTtlMs: 10 }),
    ).toThrow(/run a second time while it is still working/)
  })

  it('defaults the lease to twice the handler timeout, which is valid', () => {
    expect(() =>
      createDispatcher({ handlerTimeoutMs: 1_000, leaseTtlMs: undefined }),
    ).not.toThrow()
  })

  it('rejects a pool that cannot run anything', () => {
    expect(() => createDispatcher({ poolSize: 0 })).toThrow(/poolSize/)
  })

  it('rejects a batch that cannot read anything', () => {
    expect(() => createDispatcher({ batchSize: 0 })).toThrow(/batchSize/)
  })

  it('generates an instance id when none is given', () => {
    expect(createDispatcher().instanceId).toMatch(/^dispatcher-/)
  })

  it('runs on sensible defaults with no options at all', async () => {
    handlers.register('orders', 'placed', () => 'ok')
    await publishEvents(1)

    const runner = new EventRunner({
      store,
      handlers,
      clock,
      logger,
      handlerTimeoutMs: 1_000,
      deliveryFor: () => ({ ...DEFAULT_DELIVERY, maxAttempts: 2 }),
    })
    const dispatcher = new QueueDispatcher({ store, runner, clock, logger })
    running.push(dispatcher)

    // The default 60s handler timeout and its implied 120s lease are valid.
    expect((await dispatcher.runOnce()).succeeded).toBe(1)
  })
})

describe('start and stop', () => {
  it('processes events as they arrive, without being asked', async () => {
    const handled: string[] = []
    handlers.register('orders', 'placed', (event) => {
      handled.push(event.id)
    })

    const dispatcher = createDispatcher({ sweepIntervalMs: 10_000 })
    dispatcher.start()

    await publishEvents(2)
    await waitUntil(() => handled.length === 2, 'both events are handled')

    expect(await store.count('done')).toBe(2)
  })

  it('reports that it is running', async () => {
    const dispatcher = createDispatcher()
    expect(dispatcher.running).toBe(false)

    dispatcher.start()
    expect(dispatcher.running).toBe(true)

    await dispatcher.stop()
    expect(dispatcher.running).toBe(false)
  })

  it('starting twice attaches only one listener', () => {
    const dispatcher = createDispatcher()
    dispatcher.start()
    dispatcher.start()

    expect(firestore.listenerCount).toBe(1)
  })

  it('stopping detaches the listener', async () => {
    const dispatcher = createDispatcher()
    dispatcher.start()
    await dispatcher.stop()

    expect(firestore.listenerCount).toBe(0)
  })

  it('stopping twice is harmless', async () => {
    const dispatcher = createDispatcher()
    dispatcher.start()
    await dispatcher.stop()
    await expect(dispatcher.stop()).resolves.toBeUndefined()
  })

  it('stopping before starting is harmless', async () => {
    await expect(createDispatcher().stop()).resolves.toBeUndefined()
  })

  it('waits for in-flight handlers before resolving stop', async () => {
    let finished = false
    handlers.register('orders', 'placed', async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      finished = true
    })

    await publishEvents(1)
    const dispatcher = createDispatcher()
    dispatcher.start()

    await waitUntil(
      () => firestore.peek(COLLECTION, 'event-1')?.status === 'leased',
      'the handler has started',
    )
    await dispatcher.stop()

    expect(finished).toBe(true)
  })

  it('can run without a listener, for a poll-only deployment', async () => {
    handlers.register('orders', 'placed', () => null)
    await publishEvents(1)

    const dispatcher = createDispatcher({
      watchForNewEvents: false,
      sweepIntervalMs: 5,
    })
    dispatcher.start()

    expect(firestore.listenerCount).toBe(0)
    await waitUntil(
      () => firestore.peek(COLLECTION, 'event-1')?.status === 'done',
      'the sweep wakes the dispatcher',
    )
  })

  it('sweeps on its interval, picking up retries that came due', async () => {
    let attempts = 0
    handlers.register('orders', 'placed', () => {
      attempts += 1
      if (attempts === 1) throw new Error('first attempt fails')
    })

    await publishEvents(1)
    const dispatcher = createDispatcher({ sweepIntervalMs: 5 })
    dispatcher.start()

    await waitUntil(() => attempts === 1, 'the first attempt has failed')

    // Nothing is written when a retry falls due, so only the sweep notices.
    clock.advance(60_000)
    await waitUntil(
      () => firestore.peek(COLLECTION, 'event-1')?.status === 'done',
      'the retry runs',
    )
  })

  it('logs a listener failure instead of crashing', async () => {
    const dispatcher = createDispatcher()
    const watch = vi.spyOn(store, 'watchPending').mockImplementation(
      (_onChange, onError) => {
        onError?.(new Error('listener exploded'))
        return () => {}
      },
    )

    dispatcher.start()

    expect(logger.messages('error')).toContain('Pending-events listener failed')
    watch.mockRestore()
  })

  it('logs a failing pass and waits to be woken again', async () => {
    handlers.register('orders', 'placed', () => null)
    await publishEvents(1)

    const dispatcher = createDispatcher({ sweepIntervalMs: 10_000 })
    const findDue = vi
      .spyOn(store, 'findDue')
      .mockRejectedValue(new Error('Firestore unavailable'))

    dispatcher.start()

    await waitUntil(
      () => logger.messages('error').includes('Dispatcher pass failed'),
      'the failure is reported',
    )
    expect(
      logger.entries.find((e) => e.message === 'Dispatcher pass failed')?.context,
    ).toMatchObject({ error: 'Firestore unavailable' })

    // The dispatcher stays up and recovers on the next wake-up.
    findDue.mockRestore()
    expect(dispatcher.running).toBe(true)
    expect((await dispatcher.runOnce()).succeeded).toBe(1)
  })

  it('logs a failing sweep and keeps going', async () => {
    const dispatcher = createDispatcher({ sweepIntervalMs: 5 })
    const sweep = vi
      .spyOn(dispatcher, 'sweepOnce')
      .mockRejectedValue(new Error('sweep broke'))

    dispatcher.start()

    await waitUntil(
      () => logger.messages('error').includes('Sweep failed'),
      'the sweep failure is reported',
    )
    expect(dispatcher.running).toBe(true)
    sweep.mockRestore()
  })

  it('reports a non-Error thrown by a pass', async () => {
    const dispatcher = createDispatcher({ sweepIntervalMs: 10_000 })
    vi.spyOn(store, 'findDue').mockRejectedValue('just a string')

    dispatcher.start()

    await waitUntil(
      () => logger.messages('error').includes('Dispatcher pass failed'),
      'the failure is reported',
    )
    expect(
      logger.entries.find((e) => e.message === 'Dispatcher pass failed')?.context,
    ).toMatchObject({ error: 'just a string' })
  })

  it('reports a non-Error thrown by the sweep', async () => {
    const dispatcher = createDispatcher({ sweepIntervalMs: 5 })
    vi.spyOn(dispatcher, 'sweepOnce').mockRejectedValue('just a string')

    dispatcher.start()

    await waitUntil(
      () => logger.messages('error').includes('Sweep failed'),
      'the sweep failure is reported',
    )
    expect(
      logger.entries.find((e) => e.message === 'Sweep failed')?.context,
    ).toMatchObject({ error: 'just a string' })
  })

  it('coalesces overlapping wake-ups into one pass at a time', async () => {
    // Every claim and settle writes, and each write fires the listener, so a
    // busy queue asks for a new pass while one is already running.
    handlers.register('orders', 'placed', async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
    })
    await publishEvents(6)

    const dispatcher = createDispatcher({ batchSize: 2, sweepIntervalMs: 10_000 })
    dispatcher.start()

    await waitUntil(
      () => firestore.all(COLLECTION).every((doc) => doc.status === 'done'),
      'every event is handled exactly once',
    )
    expect(await store.count('done')).toBe(6)
  })
})
