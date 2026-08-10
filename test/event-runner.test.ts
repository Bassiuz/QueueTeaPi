import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_DELIVERY } from '../src/config/queue-config.js'
import { EventRunner } from '../src/dispatch/event-runner.js'
import { PermanentError } from '../src/errors.js'
import { FirestoreEventStore } from '../src/events/event-store.js'
import type { StoredEvent } from '../src/events/queued-event.js'
import { HandlerRegistry } from '../src/handlers/handler-registry.js'
import { FakeFirestore } from './support/fake-firestore.js'
import { RecordingLogger, TestClock } from './support/harness.js'

const COLLECTION = 'ledger'

let firestore: FakeFirestore
let clock: TestClock
let logger: RecordingLogger
let store: FirestoreEventStore
let handlers: HandlerRegistry
let maxAttempts: number

beforeEach(() => {
  firestore = new FakeFirestore()
  clock = new TestClock()
  logger = new RecordingLogger()
  handlers = new HandlerRegistry()
  maxAttempts = 3

  let sequence = 0
  store = new FirestoreEventStore({
    firestore,
    collectionPath: COLLECTION,
    clock,
    generateId: () => `event-${(sequence += 1)}`,
  })
})

function createRunner(handlerTimeoutMs = 1_000): EventRunner {
  return new EventRunner({
    store,
    handlers,
    clock,
    logger,
    handlerTimeoutMs,
    random: () => 0,
    deliveryFor: () => ({
      ...DEFAULT_DELIVERY,
      maxAttempts,
      backoff: { ...DEFAULT_DELIVERY.backoff, jitter: 0 },
    }),
  })
}

/** Writes an event and claims it, which is the state the runner expects. */
async function claimAnEvent(attempts = 1): Promise<StoredEvent> {
  const stored = await store.append({
    topic: 'orders',
    name: 'placed',
    payload: { total: 1 },
    mode: 'queued',
    maxAttempts,
  })

  let claimed = (await store.claim(stored, { owner: 'w', ttlMs: 60_000 }))!
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    claimed = (await store.claim(
      (await store.requeue(claimed))!,
      { owner: 'w', ttlMs: 60_000 },
    ))!
  }
  return claimed
}

describe('a handler that succeeds', () => {
  it('marks the event done and reports the result', async () => {
    handlers.register('orders', 'placed', () => ({ charged: true }))

    const outcome = await createRunner().run(await claimAnEvent())

    expect(outcome.status).toBe('succeeded')
    expect(outcome.result).toEqual({ charged: true })
    expect(outcome.event.status).toBe('done')
    expect(firestore.peek(COLLECTION, 'event-1')).toMatchObject({
      status: 'done',
      result: { charged: true },
    })
  })

  it('receives the whole event, including its attempt count', async () => {
    const handler = vi.fn()
    handlers.register('orders', 'placed', handler)

    await createRunner().run(await claimAnEvent())

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'event-1', attempts: 1, topic: 'orders' }),
    )
  })

  it('accepts a synchronous handler', async () => {
    handlers.register('orders', 'placed', () => 'sync')
    const outcome = await createRunner().run(await claimAnEvent())
    expect(outcome.result).toBe('sync')
  })

  it('logs the success at debug level', async () => {
    handlers.register('orders', 'placed', () => null)
    await createRunner().run(await claimAnEvent())
    expect(logger.messages('debug')).toContain('Event handled')
  })
})

describe('a handler that fails', () => {
  it('schedules a retry while budget remains', async () => {
    handlers.register('orders', 'placed', () => {
      throw new Error('flaky dependency')
    })

    const outcome = await createRunner().run(await claimAnEvent())

    expect(outcome.status).toBe('retried')
    expect(outcome.event.status).toBe('pending')
    expect(outcome.event.nextAttemptAt).toBe(clock.now() + 10_000)
    expect(outcome.event.lastError).toMatchObject({
      name: 'Error',
      message: 'flaky dependency',
      permanent: false,
    })
  })

  it('backs off further on each subsequent attempt', async () => {
    handlers.register('orders', 'placed', () => {
      throw new Error('still flaky')
    })

    const outcome = await createRunner().run(await claimAnEvent(2))
    expect(outcome.event.nextAttemptAt).toBe(clock.now() + 20_000)
  })

  it('dead-letters once the attempt budget is spent', async () => {
    handlers.register('orders', 'placed', () => {
      throw new Error('never works')
    })

    const outcome = await createRunner().run(await claimAnEvent(maxAttempts))

    expect(outcome.status).toBe('dead')
    expect(outcome.event.status).toBe('dead')
    expect(outcome.event.finishedAt).toBe(clock.now())
    expect(logger.messages('error')).toContain('Event dead-lettered')
  })

  it('dead-letters a PermanentError immediately, budget or not', async () => {
    handlers.register('orders', 'placed', () => {
      throw new PermanentError('payload will never be valid')
    })

    const outcome = await createRunner().run(await claimAnEvent())

    expect(outcome.status).toBe('dead')
    expect(outcome.event.attempts).toBe(1)
    expect(outcome.event.lastError?.permanent).toBe(true)
    expect(
      logger.entries.find((e) => e.message === 'Event dead-lettered')?.context,
    ).toMatchObject({ reason: 'permanent-error' })
  })

  it('records why an exhausted event died', async () => {
    handlers.register('orders', 'placed', () => {
      throw new Error('nope')
    })

    await createRunner().run(await claimAnEvent(maxAttempts))

    expect(
      logger.entries.find((e) => e.message === 'Event dead-lettered')?.context,
    ).toMatchObject({ reason: 'attempts-exhausted' })
  })

  it('logs the scheduled retry with its delay', async () => {
    handlers.register('orders', 'placed', () => {
      throw new Error('flaky')
    })

    await createRunner().run(await claimAnEvent())

    expect(
      logger.entries.find((e) => e.message === 'Event failed, retry scheduled')
        ?.context,
    ).toMatchObject({ retryInMs: 10_000, attempts: 1, maxAttempts: 3 })
  })

  it('keeps the returned error for the caller', async () => {
    const thrown = new Error('handler said no')
    handlers.register('orders', 'placed', () => {
      throw thrown
    })

    expect((await createRunner().run(await claimAnEvent())).error).toBe(thrown)
  })
})

describe('a handler that hangs', () => {
  it('is abandoned at the timeout and retried', async () => {
    handlers.register('orders', 'placed', () => new Promise(() => {}))

    const outcome = await createRunner(5).run(await claimAnEvent())

    expect(outcome.status).toBe('retried')
    expect(outcome.event.lastError).toMatchObject({
      name: 'HandlerTimeoutError',
      message: expect.stringContaining('did not settle within 5ms'),
    })
  })
})

describe('an event with no handler', () => {
  it('is retried rather than dead-lettered, so a late deploy can rescue it', async () => {
    const outcome = await createRunner().run(await claimAnEvent())

    expect(outcome.status).toBe('retried')
    expect(outcome.event.lastError).toMatchObject({
      name: 'UnregisteredHandlerError',
      permanent: false,
    })
    expect(outcome.event.lastError?.message).toContain(
      'No handler registered for "orders/placed"',
    )
  })
})

describe('losing the event mid-flight', () => {
  it('reports "lost" when the success write is rejected', async () => {
    const claimed = await claimAnEvent()
    handlers.register('orders', 'placed', async () => {
      // Something else — the sweep, say — takes the event back while we work.
      await store.requeue(claimed)
      return 'done anyway'
    })

    const outcome = await createRunner().run(claimed)

    expect(outcome.status).toBe('lost')
    expect(firestore.peek(COLLECTION, 'event-1')).toMatchObject({
      status: 'pending',
    })
    expect(logger.messages('warn')).toContain('Lost the event before settling it')
  })

  it('reports "lost" when the retry write is rejected', async () => {
    const claimed = await claimAnEvent()
    handlers.register('orders', 'placed', async () => {
      await store.requeue(claimed)
      throw new Error('and it failed too')
    })

    expect((await createRunner().run(claimed)).status).toBe('lost')
  })

  it('reports "lost" when the dead-letter write is rejected', async () => {
    const claimed = await claimAnEvent()
    handlers.register('orders', 'placed', async () => {
      await store.requeue(claimed)
      throw new PermanentError('give up')
    })

    expect((await createRunner().run(claimed)).status).toBe('lost')
  })
})
