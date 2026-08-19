import { describe, expect, it, vi } from 'vitest'

import { ConfigurationError, PermanentError } from '../src/errors.js'
import { InlineDeliveryLostError } from '../src/publish/event-publisher.js'
import { COLLECTION, createHarness } from './support/harness.js'

describe('queued delivery', () => {
  it('returns as soon as the event is written, without running anything', async () => {
    const { queue, firestore } = createHarness()
    const handler = vi.fn()
    queue.handlers.register('orders', 'placed', handler)

    const result = await queue.publish({
      topic: 'orders',
      name: 'placed',
      payload: { total: 42 },
    })

    expect(result).toMatchObject({ id: 'event-1', status: 'pending', result: null })
    expect(handler).not.toHaveBeenCalled()
    expect(firestore.peek(COLLECTION, 'event-1')).toMatchObject({
      status: 'pending',
      payload: { total: 42 },
    })
  })

  it('is the default mode', async () => {
    const { queue } = createHarness()
    expect((await queue.publish({ topic: 'orders', name: 'placed' })).status).toBe(
      'pending',
    )
  })

  it('records the envelope it was given', async () => {
    const { queue } = createHarness()

    const { event } = await queue.publish({
      topic: 'orders',
      name: 'placed',
      payload: { total: 1 },
      actor: { id: 'user-7', type: 'staff' },
      orderKey: 'order-9',
      trace: { 'sentry-trace': 'abc' },
    })

    expect(event).toMatchObject({
      actor: { id: 'user-7', type: 'staff' },
      orderKey: 'order-9',
      trace: { 'sentry-trace': 'abc' },
    })
  })

  it('takes the attempt budget from the resolved config', async () => {
    const { queue } = createHarness({
      topics: { orders: { maxAttempts: 9 } },
    })

    const { event } = await queue.publish({ topic: 'orders', name: 'placed' })
    expect(event.maxAttempts).toBe(9)
  })

  it('can hold an event back by a delay', async () => {
    const { queue, clock } = createHarness()

    const { event } = await queue.publish({
      topic: 'orders',
      name: 'placed',
      delayMs: 5_000,
    })

    expect(event.nextAttemptAt).toBe(clock.now() + 5_000)
  })

  it('can hold an event back until an absolute time', async () => {
    const { queue, clock } = createHarness()
    const availableAt = clock.now() + 60_000

    const { event } = await queue.publish({
      topic: 'orders',
      name: 'placed',
      availableAt,
    })

    expect(event.nextAttemptAt).toBe(availableAt)
  })

  it('drops undefined out of the payload, which Firestore would reject', async () => {
    const { queue, firestore } = createHarness()

    await queue.publish({
      topic: 'orders',
      name: 'placed',
      payload: { keep: 1, drop: undefined },
    })

    expect(firestore.peek(COLLECTION, 'event-1')?.payload).toEqual({ keep: 1 })
  })
})

describe('inline delivery', () => {
  it('runs the handler and returns its value', async () => {
    const { queue, firestore } = createHarness({
      defaults: { mode: 'inline' },
    })
    queue.handlers.register('orders', 'placed', (event) => ({
      doubled: (event.payload as { total: number }).total * 2,
    }))

    const result = await queue.publish({
      topic: 'orders',
      name: 'placed',
      payload: { total: 21 },
    })

    expect(result.result).toEqual({ doubled: 42 })
    expect(result.status).toBe('done')
    expect(firestore.peek(COLLECTION, 'event-1')).toMatchObject({
      status: 'done',
      mode: 'inline',
      attempts: 1,
    })
  })

  it('can be chosen per call, overriding the configured mode', async () => {
    const { queue } = createHarness()
    queue.handlers.register('orders', 'placed', () => 'ran')

    const result = await queue.publish({
      topic: 'orders',
      name: 'placed',
      mode: 'inline',
    })

    expect(result.result).toBe('ran')
  })

  it('returns null when the handler returns nothing', async () => {
    const { queue } = createHarness()
    queue.handlers.register('orders', 'placed', () => {})

    const result = await queue.publish({
      topic: 'orders',
      name: 'placed',
      mode: 'inline',
    })

    expect(result.result).toBeNull()
  })

  it('rethrows the handler error to the caller', async () => {
    const { queue } = createHarness()
    queue.handlers.register('orders', 'placed', () => {
      throw new Error('card declined')
    })

    await expect(
      queue.publish({ topic: 'orders', name: 'placed', mode: 'inline' }),
    ).rejects.toThrow('card declined')
  })

  it('still records a failed inline event, so it is not lost', async () => {
    const { queue, firestore, clock } = createHarness()
    queue.handlers.register('orders', 'placed', () => {
      throw new Error('card declined')
    })

    await queue
      .publish({ topic: 'orders', name: 'placed', mode: 'inline' })
      .catch(() => {})

    expect(firestore.peek(COLLECTION, 'event-1')).toMatchObject({
      status: 'pending',
      attempts: 1,
      nextAttemptAt: clock.now() + 10_000,
    })
  })

  it('dead-letters a permanent inline failure rather than retrying it', async () => {
    const { queue, firestore } = createHarness()
    queue.handlers.register('orders', 'placed', () => {
      throw new PermanentError('never valid')
    })

    await expect(
      queue.publish({ topic: 'orders', name: 'placed', mode: 'inline' }),
    ).rejects.toThrow('never valid')

    expect(firestore.peek(COLLECTION, 'event-1')).toMatchObject({
      status: 'dead',
    })
  })

  it('refuses a delay, because inline runs during publish', async () => {
    const { queue } = createHarness({ defaults: { mode: 'inline' } })

    await expect(
      queue.publish({ topic: 'orders', name: 'placed', delayMs: 1_000 }),
    ).rejects.toThrow(ConfigurationError)

    await expect(
      queue.publish({ topic: 'orders', name: 'placed', delayMs: 1_000 }),
    ).rejects.toThrow(/Use mode: "queued" for delayed delivery/)
  })

  it('refuses an absolute availableAt for the same reason', async () => {
    const { queue, clock } = createHarness()

    await expect(
      queue.publish({
        topic: 'orders',
        name: 'placed',
        mode: 'inline',
        availableAt: clock.now() + 10,
      }),
    ).rejects.toThrow(ConfigurationError)
  })

  it('reports a lost inline event distinctly from a handler failure', async () => {
    const { queue, clock } = createHarness()

    queue.handlers.register('orders', 'placed', async () => {
      // Simulate the inline lease lapsing and another worker taking the event.
      const stored = (await queue.store.get('event-1'))!
      await queue.store.requeue(stored)
      clock.advance(1)
      return 'finished anyway'
    })

    await expect(
      queue.publish({ topic: 'orders', name: 'placed', mode: 'inline' }),
    ).rejects.toThrow(InlineDeliveryLostError)
  })

  it('holds the lease under an identifiable owner while it runs', async () => {
    const { queue, firestore } = createHarness({ instanceId: 'api-1' })

    queue.handlers.register('orders', 'placed', () => {
      expect(firestore.peek(COLLECTION, 'event-1')).toMatchObject({
        status: 'leased',
        leaseOwner: 'inline:api-1',
      })
    })

    await queue.publish({ topic: 'orders', name: 'placed', mode: 'inline' })
  })
})
