import { describe, expect, it, vi } from 'vitest'

import { toEventHandler } from '../src/handlers/event-handler.js'
import { HandlerRegistry } from '../src/handlers/handler-registry.js'
import type { QueuedEvent } from '../src/events/queued-event.js'

const anEvent = { id: 'e1', topic: 'orders', name: 'placed' } as QueuedEvent

describe('toEventHandler', () => {
  it('wraps a plain function', async () => {
    const handler = toEventHandler((event: QueuedEvent) => event.id)
    expect(await handler.handle(anEvent)).toBe('e1')
  })

  it('passes an object handler through unchanged', () => {
    const handler = { handle: () => 'done' }
    expect(toEventHandler(handler)).toBe(handler)
  })
})

describe('HandlerRegistry', () => {
  it('resolves an exactly registered handler', () => {
    const registry = new HandlerRegistry()
    const handler = { handle: () => 'ok' }

    registry.register('orders', 'placed', handler)

    expect(registry.resolve('orders', 'placed')).toBe(handler)
    expect(registry.has('orders', 'placed')).toBe(true)
  })

  it('falls back to a topic-wide handler', () => {
    const registry = new HandlerRegistry()
    const catchAll = { handle: () => 'ok' }

    registry.registerTopic('orders', catchAll)

    expect(registry.resolve('orders', 'anything-at-all')).toBe(catchAll)
  })

  it('prefers the exact match over the topic-wide one', () => {
    const registry = new HandlerRegistry()
    const exact = { handle: () => 'exact' }
    const catchAll = { handle: () => 'catch-all' }

    registry.registerTopic('orders', catchAll).register('orders', 'placed', exact)

    expect(registry.resolve('orders', 'placed')).toBe(exact)
    expect(registry.resolve('orders', 'shipped')).toBe(catchAll)
  })

  it('does not leak handlers between topics', () => {
    const registry = new HandlerRegistry()
    registry.registerTopic('orders', { handle: () => 'ok' })

    expect(registry.resolve('invoices', 'placed')).toBeUndefined()
    expect(registry.has('invoices', 'placed')).toBe(false)
  })

  it('cannot confuse "a/b" + "c" with "a" + "b/c"', () => {
    const registry = new HandlerRegistry()
    const first = { handle: () => 1 }
    const second = { handle: () => 2 }

    registry.register('a/b', 'c', first).register('a', 'b/c', second)

    expect(registry.resolve('a/b', 'c')).toBe(first)
    expect(registry.resolve('a', 'b/c')).toBe(second)
    expect(registry.size).toBe(2)
  })

  it('registers a whole map at once', () => {
    const registry = new HandlerRegistry()
    const placed = vi.fn(() => 'placed')
    const shipped = vi.fn(() => 'shipped')

    registry.registerAll({
      orders: { placed, shipped },
      invoices: { issued: vi.fn(() => 'issued') },
    })

    expect(registry.size).toBe(3)
    expect(registry.resolve('orders', 'placed')?.handle).toBe(placed)
    expect(registry.resolve('orders', 'shipped')?.handle).toBe(shipped)
  })

  it('replaces a handler when the same key is registered twice', () => {
    const registry = new HandlerRegistry()
    const second = { handle: () => 'second' }

    registry
      .register('orders', 'placed', { handle: () => 'first' })
      .register('orders', 'placed', second)

    expect(registry.size).toBe(1)
    expect(registry.resolve('orders', 'placed')).toBe(second)
  })

  it('unregisters, reporting whether there was anything to remove', () => {
    const registry = new HandlerRegistry()
    registry.register('orders', 'placed', { handle: () => 'ok' })

    expect(registry.unregister('orders', 'placed')).toBe(true)
    expect(registry.unregister('orders', 'placed')).toBe(false)
    expect(registry.has('orders', 'placed')).toBe(false)
  })

  it('describes what is wired up, sorted for a stable display', () => {
    const registry = new HandlerRegistry()

    registry
      .register('orders', 'shipped', { handle: () => 1 })
      .registerTopic('invoices', { handle: () => 2 })
      .register('orders', 'placed', { handle: () => 3 })

    expect(registry.describe()).toEqual([
      { topic: 'invoices', eventName: '*' },
      { topic: 'orders', eventName: 'placed' },
      { topic: 'orders', eventName: 'shipped' },
    ])
  })

  it('sorts by event name within the same topic', () => {
    const registry = new HandlerRegistry()
    registry
      .register('orders', 'b', { handle: () => 1 })
      .register('orders', 'a', { handle: () => 2 })

    expect(registry.describe().map((entry) => entry.eventName)).toEqual([
      'a',
      'b',
    ])
  })

  it('starts empty', () => {
    expect(new HandlerRegistry().describe()).toEqual([])
    expect(new HandlerRegistry().size).toBe(0)
  })
})
