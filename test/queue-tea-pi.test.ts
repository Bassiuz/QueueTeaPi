import { describe, expect, it } from 'vitest'

import { DEFAULT_COLLECTION } from '../src/config/queue-config.js'
import { ConfigurationError } from '../src/errors.js'
import { HandlerRegistry } from '../src/handlers/handler-registry.js'
import { QueueTeaPi } from '../src/queue-tea-pi.js'
import { FakeFirestore } from './support/fake-firestore.js'
import { COLLECTION, createHarness } from './support/harness.js'

describe('construction', () => {
  it('needs a Firestore instance', () => {
    expect(
      () => new QueueTeaPi({ firestore: undefined as never }),
    ).toThrow(ConfigurationError)
    expect(() => new QueueTeaPi({ firestore: null as never })).toThrow(
      /needs a `firestore` instance/,
    )
  })

  it('rejects an empty collection path', () => {
    expect(
      () => new QueueTeaPi({ firestore: new FakeFirestore(), collection: '   ' }),
    ).toThrow(/must not be empty/)
  })

  it('defaults the collection', () => {
    const queue = new QueueTeaPi({ firestore: new FakeFirestore() })
    expect(queue.collection).toBe(DEFAULT_COLLECTION)
  })

  it('uses the collection it is given', () => {
    expect(createHarness().queue.collection).toBe(COLLECTION)
  })

  it('writes events into that collection and nowhere else', async () => {
    const { queue, firestore } = createHarness()
    await queue.publish({ topic: 'orders', name: 'placed' })

    expect(firestore.all(COLLECTION)).toHaveLength(1)
    expect(firestore.all('some-other-collection')).toHaveLength(0)
  })

  it('creates its own handler registry by default', () => {
    expect(createHarness().queue.handlers).toBeInstanceOf(HandlerRegistry)
  })

  it('accepts a registry shared with the rest of the application', () => {
    const handlers = new HandlerRegistry()
    handlers.register('orders', 'placed', () => 'shared')

    const { queue } = createHarness({ handlers })

    expect(queue.handlers).toBe(handlers)
    expect(queue.handlers.has('orders', 'placed')).toBe(true)
  })

  it('generates an instance id when none is given', () => {
    expect(createHarness().queue.instanceId).toMatch(/^dispatcher-/)
  })

  it('uses the instance id it is given', () => {
    expect(createHarness({ instanceId: 'api-3' }).queue.instanceId).toBe('api-3')
  })
})

describe('deliveryFor', () => {
  it('merges defaults, topic and event settings', () => {
    const { queue } = createHarness({
      defaults: { maxAttempts: 2 },
      topics: {
        orders: {
          mode: 'inline',
          events: { placed: { maxAttempts: 7 } },
        },
      },
    })

    expect(queue.deliveryFor('orders', 'placed')).toMatchObject({
      mode: 'inline',
      maxAttempts: 7,
    })
    expect(queue.deliveryFor('orders', 'shipped')).toMatchObject({
      mode: 'inline',
      maxAttempts: 2,
    })
    expect(queue.deliveryFor('invoices', 'issued')).toMatchObject({
      mode: 'queued',
      maxAttempts: 2,
    })
  })
})

describe('createDispatcher', () => {
  it('shares the queue instance id by default', () => {
    const { queue } = createHarness({ instanceId: 'worker-1' })
    expect(queue.createDispatcher().instanceId).toBe('worker-1')
  })

  it('can be given its own instance id', () => {
    const { queue } = createHarness({ instanceId: 'worker-1' })
    expect(
      queue.createDispatcher({ instanceId: 'worker-2' }).instanceId,
    ).toBe('worker-2')
  })

  it('runs handlers registered on the queue', async () => {
    const { queue } = createHarness()
    const seen: string[] = []
    queue.handlers.register('orders', 'placed', (event) => {
      seen.push(event.id)
    })

    await queue.publish({ topic: 'orders', name: 'placed' })
    const summary = await queue.createDispatcher().runOnce()

    expect(summary.succeeded).toBe(1)
    expect(seen).toEqual(['event-1'])
  })

  it('picks up handlers registered after the dispatcher was created', async () => {
    const { queue } = createHarness()
    const dispatcher = queue.createDispatcher()

    await queue.publish({ topic: 'orders', name: 'placed' })
    queue.handlers.register('orders', 'placed', () => 'late but fine')

    expect((await dispatcher.runOnce()).succeeded).toBe(1)
  })

  it('inherits the queue handler timeout', async () => {
    const { queue, firestore } = createHarness({ handlerTimeoutMs: 5 })
    queue.handlers.register('orders', 'placed', () => new Promise(() => {}))

    await queue.publish({ topic: 'orders', name: 'placed' })
    await queue.createDispatcher().runOnce()

    expect(firestore.peek(COLLECTION, 'event-1')).toMatchObject({
      lastError: { name: 'HandlerTimeoutError' },
    })
  })

  it('lets a dispatcher override the handler timeout', async () => {
    const { queue, firestore } = createHarness({ handlerTimeoutMs: 60_000 })
    queue.handlers.register('orders', 'placed', () => new Promise(() => {}))

    await queue.publish({ topic: 'orders', name: 'placed' })
    await queue.createDispatcher({ handlerTimeoutMs: 5 }).runOnce()

    expect(firestore.peek(COLLECTION, 'event-1')).toMatchObject({
      lastError: { name: 'HandlerTimeoutError' },
    })
  })

  it('applies the per-event retry budget from config', async () => {
    const { queue, firestore, clock } = createHarness({
      topics: { orders: { maxAttempts: 1 } },
    })
    queue.handlers.register('orders', 'placed', () => {
      throw new Error('nope')
    })

    await queue.publish({ topic: 'orders', name: 'placed' })
    await queue.createDispatcher().runOnce()
    clock.advance(1)

    expect(firestore.peek(COLLECTION, 'event-1')).toMatchObject({
      status: 'dead',
    })
  })
})

describe('end to end', () => {
  it('publishes, dispatches, fails, retries and finally succeeds', async () => {
    const { queue, clock, firestore } = createHarness({
      topics: { orders: { maxAttempts: 3 } },
    })

    let attempts = 0
    queue.handlers.register('orders', 'placed', () => {
      attempts += 1
      if (attempts < 3) throw new Error(`attempt ${attempts} failed`)
      return { charged: true }
    })

    await queue.publish({ topic: 'orders', name: 'placed', payload: { id: 'o1' } })
    const dispatcher = queue.createDispatcher()

    // First attempt fails and is scheduled 10s out.
    expect((await dispatcher.runOnce()).retried).toBe(1)
    expect((await dispatcher.runOnce()).claimed).toBe(0)

    clock.advance(10_000)
    expect((await dispatcher.runOnce()).retried).toBe(1)

    clock.advance(20_000)
    expect((await dispatcher.runOnce()).succeeded).toBe(1)

    expect(firestore.peek(COLLECTION, 'event-1')).toMatchObject({
      status: 'done',
      attempts: 3,
      result: { charged: true },
    })
  })

  it('surfaces the whole story through the inspector', async () => {
    const { queue, clock } = createHarness({
      topics: { orders: { maxAttempts: 1 } },
    })
    queue.handlers.register('orders', 'placed', () => {
      throw new Error('permanently broken dependency')
    })

    await queue.publish({ topic: 'orders', name: 'placed' })
    await queue.createDispatcher().runOnce()

    const inspector = queue.createInspector()
    const stats = await inspector.stats()

    expect(stats.counts.dead).toBe(1)
    expect((await inspector.list({ status: 'dead' }))[0]?.lastError).toMatchObject(
      { message: 'permanently broken dependency' },
    )

    // And an operator can put it back.
    clock.advance(1_000)
    await inspector.replay('event-1')
    expect((await inspector.stats()).counts).toMatchObject({
      dead: 0,
      pending: 1,
    })
  })
})
