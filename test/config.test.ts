import { describe, expect, it } from 'vitest'

import { DEFAULT_BACKOFF, computeBackoffMs } from '../src/config/backoff.js'
import {
  DEFAULT_DELIVERY,
  resolveDelivery,
  type TopicConfig,
} from '../src/config/queue-config.js'
import { ConfigurationError } from '../src/errors.js'

const noJitter = { ...DEFAULT_BACKOFF, jitter: 0 }

describe('computeBackoffMs', () => {
  it('waits minMs before the first retry', () => {
    expect(computeBackoffMs(1, noJitter)).toBe(10_000)
  })

  it('multiplies by the factor for each further attempt', () => {
    expect(computeBackoffMs(2, noJitter)).toBe(20_000)
    expect(computeBackoffMs(3, noJitter)).toBe(40_000)
  })

  it('never exceeds maxMs', () => {
    expect(computeBackoffMs(50, noJitter)).toBe(noJitter.maxMs)
  })

  it('treats a zeroth attempt as the first', () => {
    expect(computeBackoffMs(0, noJitter)).toBe(10_000)
  })

  it('subtracts up to the jitter fraction from the delay', () => {
    const policy = { ...DEFAULT_BACKOFF, jitter: 0.5 }
    expect(computeBackoffMs(1, policy, () => 0)).toBe(10_000)
    expect(computeBackoffMs(1, policy, () => 1)).toBe(5_000)
  })

  it('clamps jitter above one to a full spread', () => {
    const policy = { ...DEFAULT_BACKOFF, jitter: 5 }
    expect(computeBackoffMs(1, policy, () => 1)).toBe(0)
  })

  it('uses Math.random when no source is supplied', () => {
    const value = computeBackoffMs(1, DEFAULT_BACKOFF)
    expect(value).toBeGreaterThanOrEqual(8_000)
    expect(value).toBeLessThanOrEqual(10_000)
  })
})

describe('resolveDelivery', () => {
  it('falls back to package defaults for an unconfigured topic', () => {
    expect(resolveDelivery('unknown', 'thing')).toEqual(DEFAULT_DELIVERY)
  })

  it('applies global defaults', () => {
    const resolved = resolveDelivery('orders', 'placed', {}, { maxAttempts: 2 })
    expect(resolved.maxAttempts).toBe(2)
    expect(resolved.mode).toBe('queued')
  })

  it('lets a topic override the global defaults', () => {
    const topics: Record<string, TopicConfig> = {
      orders: { mode: 'inline', maxAttempts: 3 },
    }
    const resolved = resolveDelivery('orders', 'placed', topics, {
      maxAttempts: 9,
    })
    expect(resolved).toMatchObject({ mode: 'inline', maxAttempts: 3 })
  })

  it('lets an event name override its topic', () => {
    const topics: Record<string, TopicConfig> = {
      orders: {
        mode: 'queued',
        events: { placed: { mode: 'inline' } },
      },
    }
    expect(resolveDelivery('orders', 'placed', topics).mode).toBe('inline')
    expect(resolveDelivery('orders', 'shipped', topics).mode).toBe('queued')
  })

  it('merges backoff partially, keeping the fields not mentioned', () => {
    const resolved = resolveDelivery(
      'orders',
      'placed',
      { orders: { backoff: { minMs: 500 } } },
      { backoff: { maxMs: 5_000 } },
    )

    expect(resolved.backoff).toEqual({
      minMs: 500,
      maxMs: 5_000,
      factor: DEFAULT_BACKOFF.factor,
      jitter: DEFAULT_BACKOFF.jitter,
    })
  })

  it('ignores an events map that has no entry for this event', () => {
    const topics: Record<string, TopicConfig> = {
      orders: { maxAttempts: 4, events: { other: { maxAttempts: 1 } } },
    }
    expect(resolveDelivery('orders', 'placed', topics).maxAttempts).toBe(4)
  })

  describe('rejects settings that cannot produce a working queue', () => {
    it('maxAttempts below one', () => {
      expect(() =>
        resolveDelivery('t', 'e', {}, { maxAttempts: 0 }),
      ).toThrow(ConfigurationError)
    })

    it('a fractional maxAttempts', () => {
      expect(() =>
        resolveDelivery('t', 'e', {}, { maxAttempts: 1.5 }),
      ).toThrow(/must be an integer/)
    })

    it('a negative minMs', () => {
      expect(() =>
        resolveDelivery('t', 'e', {}, { backoff: { minMs: -1 } }),
      ).toThrow(/backoff.minMs/)
    })

    it('a maxMs below minMs', () => {
      expect(() =>
        resolveDelivery('t', 'e', {}, { backoff: { minMs: 100, maxMs: 10 } }),
      ).toThrow(/backoff.maxMs/)
    })

    it('a factor below one', () => {
      expect(() =>
        resolveDelivery('t', 'e', {}, { backoff: { factor: 0.5 } }),
      ).toThrow(/backoff.factor/)
    })

    it('jitter outside zero to one', () => {
      expect(() =>
        resolveDelivery('t', 'e', {}, { backoff: { jitter: 1.5 } }),
      ).toThrow(/backoff.jitter/)
      expect(() =>
        resolveDelivery('t', 'e', {}, { backoff: { jitter: -0.1 } }),
      ).toThrow(/backoff.jitter/)
    })
  })
})
