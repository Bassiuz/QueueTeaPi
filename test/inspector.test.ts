import { beforeEach, describe, expect, it } from 'vitest'

import type { QueueInspector } from '../src/devtools/queue-inspector.js'
import { COLLECTION, createHarness, type Harness } from './support/harness.js'

let harness: Harness
let inspector: QueueInspector

beforeEach(() => {
  harness = createHarness()
  inspector = harness.queue.createInspector()
})

/** Publishes an event and drives it to `status`. */
async function anEventIn(status: 'pending' | 'leased' | 'done' | 'dead') {
  const { queue } = harness
  const { id } = await queue.publish({ topic: 'orders', name: 'placed' })
  const stored = (await queue.store.get(id))!

  if (status === 'pending') return id

  const claimed = (await queue.store.claim(stored, {
    owner: 'w',
    ttlMs: 60_000,
  }))!
  if (status === 'leased') return id

  if (status === 'done') await queue.store.markDone(claimed, { ok: true })
  else
    await queue.store.markDead(claimed, {
      name: 'Error',
      message: 'it broke',
      stack: null,
      permanent: false,
      at: harness.clock.now(),
    })

  return id
}

describe('stats', () => {
  it('reports an empty queue', async () => {
    const stats = await inspector.stats()

    expect(stats).toMatchObject({
      collection: COLLECTION,
      total: 0,
      dueNow: 0,
      oldestDue: null,
      counts: { pending: 0, leased: 0, done: 0, dead: 0 },
    })
    expect(stats.generatedAt).toBe(harness.clock.now())
  })

  it('counts every status', async () => {
    await anEventIn('pending')
    await anEventIn('leased')
    await anEventIn('done')
    await anEventIn('dead')
    await anEventIn('dead')

    const stats = await inspector.stats()

    expect(stats.counts).toEqual({ pending: 1, leased: 1, done: 1, dead: 2 })
    expect(stats.total).toBe(5)
  })

  it('counts only what is due right now as backlog', async () => {
    await anEventIn('pending')
    await harness.queue.publish({
      topic: 'orders',
      name: 'later',
      delayMs: 60_000,
    })

    const stats = await inspector.stats()

    expect(stats.counts.pending).toBe(2)
    expect(stats.dueNow).toBe(1)
  })

  it('reports how long the oldest due event has been waiting', async () => {
    await anEventIn('pending')
    harness.clock.advance(45_000)

    expect((await inspector.stats()).oldestDue).toEqual({
      id: 'event-1',
      topic: 'orders',
      name: 'placed',
      attempts: 0,
      waitingMs: 45_000,
    })
  })

  it('never reports a negative wait', async () => {
    await anEventIn('pending')
    expect((await inspector.stats()).oldestDue?.waitingMs).toBe(0)
  })

  it('lists what this process can handle', async () => {
    harness.queue.handlers
      .register('orders', 'placed', () => null)
      .registerTopic('invoices', () => null)

    expect((await inspector.stats()).handlers).toEqual([
      { topic: 'invoices', eventName: '*' },
      { topic: 'orders', eventName: 'placed' },
    ])
  })
})

describe('list', () => {
  it('returns the most recent events first', async () => {
    await harness.queue.publish({ topic: 'orders', name: 'first' })
    harness.clock.advance(10)
    await harness.queue.publish({ topic: 'orders', name: 'second' })

    expect((await inspector.list()).map((event) => event.name)).toEqual([
      'second',
      'first',
    ])
  })

  it('filters by status', async () => {
    await anEventIn('done')
    await anEventIn('pending')

    const done = await inspector.list({ status: 'done' })
    expect(done).toHaveLength(1)
    expect(done[0]?.status).toBe('done')
  })

  it('respects a limit', async () => {
    await anEventIn('pending')
    await anEventIn('pending')

    expect(await inspector.list({ limit: 1 })).toHaveLength(1)
  })

  it('returns plain events, without internal versions', async () => {
    await anEventIn('pending')
    expect(await inspector.list()).toEqual([
      expect.objectContaining({ id: 'event-1' }),
    ])
  })
})

describe('get', () => {
  it('returns one event in full', async () => {
    const id = await anEventIn('dead')

    expect(await inspector.get(id)).toMatchObject({
      id,
      status: 'dead',
      lastError: { message: 'it broke' },
    })
  })

  it('returns null for an unknown id', async () => {
    expect(await inspector.get('nope')).toBeNull()
  })
})

describe('replay', () => {
  it('returns a dead event to pending with a fresh budget', async () => {
    const id = await anEventIn('dead')
    harness.clock.advance(1_000)

    const replayed = await inspector.replay(id)

    expect(replayed).toMatchObject({
      status: 'pending',
      attempts: 0,
      finishedAt: null,
      nextAttemptAt: harness.clock.now(),
    })
  })

  it('keeps the failure that put it there, for context', async () => {
    const id = await anEventIn('dead')
    expect((await inspector.replay(id))?.lastError?.message).toBe('it broke')
  })

  it('returns null for an unknown id', async () => {
    expect(await inspector.replay('nope')).toBeNull()
  })

  it('returns null when the event changed between read and write', async () => {
    const id = await anEventIn('dead')
    const stored = (await harness.queue.store.get(id))!

    // Something else moves the event first, invalidating our version.
    await harness.queue.store.requeue(stored)
    const store = harness.queue.store
    const original = store.get.bind(store)
    store.get = async () => stored

    expect(await inspector.replay(id)).toBeNull()
    store.get = original
  })
})

describe('replayMany', () => {
  it('replays the dead-letter queue by default', async () => {
    await anEventIn('dead')
    await anEventIn('dead')
    await anEventIn('done')

    expect(await inspector.replayMany()).toEqual({ matched: 2, replayed: 2 })
    expect((await inspector.stats()).counts).toMatchObject({
      dead: 0,
      pending: 2,
      done: 1,
    })
  })

  it('can replay a different status', async () => {
    await anEventIn('done')

    expect(await inspector.replayMany({ status: 'done' })).toEqual({
      matched: 1,
      replayed: 1,
    })
  })

  it('reports nothing to do on an empty queue', async () => {
    expect(await inspector.replayMany()).toEqual({ matched: 0, replayed: 0 })
  })

  it('respects a limit', async () => {
    await anEventIn('dead')
    await anEventIn('dead')

    expect(await inspector.replayMany({ limit: 1 })).toEqual({
      matched: 1,
      replayed: 1,
    })
  })

  it('counts only the events it actually moved', async () => {
    await anEventIn('dead')
    await anEventIn('dead')

    const store = harness.queue.store
    const listed = await store.list({ status: 'dead' })

    // One of them is moved by someone else after we read it.
    await store.requeue(listed[0]!)
    const original = store.list.bind(store)
    store.list = async () => listed

    expect(await inspector.replayMany()).toEqual({ matched: 2, replayed: 1 })
    store.list = original
  })
})
