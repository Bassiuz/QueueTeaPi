import { describe, expect, it } from 'vitest'

import {
  describeError,
  fromDocument,
  toDocument,
} from '../src/events/event-serialization.js'
import type { QueuedEvent } from '../src/events/queued-event.js'

function anEvent(overrides: Partial<QueuedEvent> = {}): QueuedEvent {
  return {
    id: 'event-1',
    topic: 'orders',
    name: 'placed',
    payload: { total: 42 },
    actor: { id: 'user-1' },
    orderKey: 'order-9',
    trace: { 'sentry-trace': 'abc' },
    mode: 'queued',
    status: 'pending',
    attempts: 0,
    maxAttempts: 5,
    nextAttemptAt: 1_000,
    leaseOwner: null,
    leaseExpiresAt: null,
    result: null,
    lastError: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  }
}

describe('toDocument', () => {
  it('drops the id, because Firestore already knows it', () => {
    expect(toDocument(anEvent())).not.toHaveProperty('id')
  })

  it('keeps every other field', () => {
    const document = toDocument(anEvent())
    expect(document).toMatchObject({
      topic: 'orders',
      name: 'placed',
      status: 'pending',
      maxAttempts: 5,
      leaseOwner: null,
    })
  })

  it('strips undefined out of the payload', () => {
    const document = toDocument(
      anEvent({ payload: { keep: 1, drop: undefined } }),
    )
    expect(document.payload).toEqual({ keep: 1 })
  })
})

describe('fromDocument', () => {
  it('round-trips an event written by toDocument', () => {
    const original = anEvent()
    expect(fromDocument('event-1', toDocument(original))).toEqual(original)
  })

  it('produces a usable event from an empty document', () => {
    const event = fromDocument('event-1', undefined)

    expect(event).toMatchObject({
      id: 'event-1',
      topic: '',
      name: '',
      payload: null,
      actor: null,
      orderKey: null,
      trace: null,
      mode: 'queued',
      status: 'pending',
      attempts: 0,
      maxAttempts: 1,
      nextAttemptAt: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      result: null,
      lastError: null,
      startedAt: null,
      finishedAt: null,
    })
  })

  it('falls back to pending for a status nobody recognises', () => {
    expect(fromDocument('e', { status: 'exploded' }).status).toBe('pending')
  })

  it('reads inline mode, and treats anything else as queued', () => {
    expect(fromDocument('e', { mode: 'inline' }).mode).toBe('inline')
    expect(fromDocument('e', { mode: 'telepathy' }).mode).toBe('queued')
  })

  it('ignores non-finite numbers', () => {
    const event = fromDocument('e', {
      attempts: Number.NaN,
      leaseExpiresAt: Number.POSITIVE_INFINITY,
    })
    expect(event.attempts).toBe(0)
    expect(event.leaseExpiresAt).toBeNull()
  })

  it('ignores arrays and non-objects where an object is expected', () => {
    expect(fromDocument('e', { actor: ['nope'] }).actor).toBeNull()
    expect(fromDocument('e', { trace: 'nope' }).trace).toBeNull()
    expect(fromDocument('e', { lastError: 7 }).lastError).toBeNull()
  })

  it('fills in a partially written lastError', () => {
    expect(fromDocument('e', { lastError: {} }).lastError).toEqual({
      name: 'Error',
      message: '',
      stack: null,
      permanent: false,
      at: 0,
    })
  })

  it('reads a fully written lastError', () => {
    const lastError = {
      name: 'PermanentError',
      message: 'bad payload',
      stack: 'at somewhere',
      permanent: true,
      at: 55,
    }
    expect(fromDocument('e', { lastError }).lastError).toEqual(lastError)
  })
})

describe('describeError', () => {
  it('captures an Error', () => {
    const described = describeError(new TypeError('bad input'), 99, false)

    expect(described).toMatchObject({
      name: 'TypeError',
      message: 'bad input',
      permanent: false,
      at: 99,
    })
    expect(described.stack).toContain('TypeError')
  })

  it('records a stackless Error as null rather than undefined', () => {
    const error = new Error('no stack')
    error.stack = undefined
    expect(describeError(error, 1, false).stack).toBeNull()
  })

  it('marks permanent failures', () => {
    expect(describeError(new Error('x'), 1, true).permanent).toBe(true)
  })

  it('handles a thrown string', () => {
    expect(describeError('just a string', 1, false)).toMatchObject({
      name: 'NonError',
      message: 'just a string',
    })
  })

  it('serialises a thrown object', () => {
    expect(describeError({ code: 7 }, 1, false).message).toBe('{"code":7}')
  })

  it('falls back to String() for something unserialisable', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(describeError(cyclic, 1, false).message).toBe('[object Object]')
  })

  it('falls back to String() when JSON.stringify returns undefined', () => {
    expect(describeError(() => {}, 1, false).message).toContain('=>')
  })
})
