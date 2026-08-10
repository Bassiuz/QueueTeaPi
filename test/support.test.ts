import { afterEach, describe, expect, it, vi } from 'vitest'

import { systemClock } from '../src/support/clock.js'
import {
  delay,
  mapWithConcurrency,
  withTimeout,
} from '../src/support/concurrency.js'
import { createInstanceId, randomEventId } from '../src/support/ids.js'
import { consoleLogger, silentLogger } from '../src/support/logger.js'
import { stripUndefined } from '../src/support/sanitize.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('systemClock', () => {
  it('reports the current wall-clock time', () => {
    const before = Date.now()
    const now = systemClock.now()
    expect(now).toBeGreaterThanOrEqual(before)
    expect(now).toBeLessThanOrEqual(Date.now())
  })
})

describe('ids', () => {
  it('generates a distinct id every time', () => {
    expect(randomEventId()).not.toBe(randomEventId())
  })

  it('gives an instance a readable prefix and a short random suffix', () => {
    const id = createInstanceId('sweeper', () => 'abcdefgh-ignored')
    expect(id).toBe('sweeper-abcdefgh')
  })

  it('defaults the prefix and still randomises', () => {
    expect(createInstanceId()).toMatch(/^dispatcher-[0-9a-f]{8}$/)
  })
})

describe('loggers', () => {
  it('silentLogger says nothing', () => {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {})
    silentLogger.log('info', 'ignored')
    expect(spy).not.toHaveBeenCalled()
  })

  it('consoleLogger writes at the requested level', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    consoleLogger.log('warn', 'careful')
    expect(spy).toHaveBeenCalledWith('[queueteapi] careful')
  })

  it('consoleLogger passes context through when there is some', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    consoleLogger.log('error', 'broke', { id: 'e1' })
    expect(spy).toHaveBeenCalledWith('[queueteapi] broke', { id: 'e1' })
  })
})

describe('mapWithConcurrency', () => {
  it('returns an empty array for no items, without calling the task', () => {
    const task = vi.fn()
    return expect(mapWithConcurrency([], 4, task)).resolves.toEqual([])
      .then(() => expect(task).not.toHaveBeenCalled())
  })

  it('preserves input order regardless of completion order', async () => {
    const results = await mapWithConcurrency([30, 10, 20], 3, async (ms) => {
      await delay(ms / 10)
      return ms
    })
    expect(results).toEqual([30, 10, 20])
  })

  it('never exceeds the concurrency limit', async () => {
    let running = 0
    let peak = 0

    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, async () => {
      running += 1
      peak = Math.max(peak, running)
      await delay(1)
      running -= 1
    })

    expect(peak).toBe(3)
  })

  it('uses one worker per item when there are fewer items than the limit', async () => {
    let peak = 0
    let running = 0

    await mapWithConcurrency([1, 2], 10, async () => {
      running += 1
      peak = Math.max(peak, running)
      await delay(1)
      running -= 1
    })

    expect(peak).toBe(2)
  })

  it('treats a limit below one as a single worker', async () => {
    const order: number[] = []
    await mapWithConcurrency([1, 2, 3], 0, async (item) => {
      order.push(item)
      await delay(1)
    })
    expect(order).toEqual([1, 2, 3])
  })

  it('rejects the whole batch when a task rejects', async () => {
    await expect(
      mapWithConcurrency([1], 1, async () => {
        throw new Error('nope')
      }),
    ).rejects.toThrow('nope')
  })

  it('passes the index alongside the item', async () => {
    const seen = await mapWithConcurrency(['a', 'b'], 1, async (item, index) =>
      `${index}:${item}`,
    )
    expect(seen).toEqual(['0:a', '1:b'])
  })
})

describe('withTimeout', () => {
  it('resolves with the operation when it finishes in time', async () => {
    const result = await withTimeout(
      Promise.resolve('quick'),
      1000,
      () => new Error('too slow'),
    )
    expect(result).toBe('quick')
  })

  it('rejects with the supplied error when the deadline passes', async () => {
    const never = new Promise<string>(() => {})
    await expect(
      withTimeout(never, 5, () => new Error('too slow')),
    ).rejects.toThrow('too slow')
  })

  it('propagates the operation’s own rejection', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 1000, () => new Error('x')),
    ).rejects.toThrow('boom')
  })

  it('waits indefinitely when the timeout is zero or not a number', async () => {
    await expect(
      withTimeout(Promise.resolve('ok'), 0, () => new Error('x')),
    ).resolves.toBe('ok')

    await expect(
      withTimeout(Promise.resolve('ok'), Number.NaN, () => new Error('x')),
    ).resolves.toBe('ok')
  })
})

describe('stripUndefined', () => {
  it('leaves primitives and null untouched', () => {
    expect(stripUndefined(5)).toBe(5)
    expect(stripUndefined('text')).toBe('text')
    expect(stripUndefined(null)).toBeNull()
  })

  it('removes undefined properties, at any depth', () => {
    expect(
      stripUndefined({
        keep: 1,
        drop: undefined,
        nested: { keep: true, drop: undefined },
      }),
    ).toEqual({ keep: 1, nested: { keep: true } })
  })

  it('keeps null, because null means something to Firestore', () => {
    expect(stripUndefined({ cleared: null })).toEqual({ cleared: null })
  })

  it('turns undefined array elements into null so indexes do not shift', () => {
    expect(stripUndefined([1, undefined, { drop: undefined, keep: 2 }])).toEqual([
      1,
      null,
      { keep: 2 },
    ])
  })

  it('does not rebuild class instances or dates', () => {
    const date = new Date(0)
    const result = stripUndefined({ date })
    expect(result.date).toBe(date)
  })

  it('survives a cyclic object instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    expect(() => stripUndefined(cyclic)).not.toThrow()
  })

  it('handles an object with a null prototype', () => {
    const bare = Object.create(null) as Record<string, unknown>
    bare.keep = 1
    bare.drop = undefined
    expect(stripUndefined(bare)).toEqual({ keep: 1 })
  })
})

describe('delay', () => {
  it('resolves after the requested time', async () => {
    const start = Date.now()
    await delay(10)
    expect(Date.now() - start).toBeGreaterThanOrEqual(8)
  })
})
