import { describe, expect, it, vi } from 'vitest'

import { PermanentError } from '../src/errors.js'
import type { QueuedEvent } from '../src/events/queued-event.js'
import {
  HttpEventHandler,
  HttpHandlerError,
  PermanentHttpHandlerError,
  defaultMessageEncoder,
  toPubSubEnvelope,
} from '../src/handlers/http-event-handler.js'

function anEvent(overrides: Partial<QueuedEvent> = {}): QueuedEvent {
  return {
    id: 'event-1',
    topic: 'orders',
    name: 'placed',
    payload: { total: 42 },
    actor: { id: 'user-1' },
    orderKey: 'order-9',
    trace: { 'sentry-trace': 'trace-abc' },
    mode: 'queued',
    status: 'leased',
    attempts: 2,
    maxAttempts: 5,
    nextAttemptAt: 0,
    leaseOwner: 'worker-1',
    leaseExpiresAt: 0,
    result: null,
    lastError: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 0,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  }
}

function decode(envelope: { message: { data: string } }): unknown {
  return JSON.parse(Buffer.from(envelope.message.data, 'base64').toString())
}

/** Builds a `fetch` stand-in that always answers the same way. */
function respondWith(
  status: number,
  body: string,
): { fetch: typeof globalThis.fetch; calls: unknown[][] } {
  const calls: unknown[][] = []
  const fetch = vi.fn(async (...args: unknown[]) => {
    calls.push(args)
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    }
  })
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls }
}

describe('toPubSubEnvelope', () => {
  it('produces the body a Pub/Sub push subscription would send', () => {
    const envelope = toPubSubEnvelope(anEvent())

    expect(envelope.message.messageId).toBe('event-1')
    expect(envelope.message.publishTime).toBe(
      new Date(1_700_000_000_000).toISOString(),
    )
    expect(envelope.subscription).toBe('queueteapi/orders')
    expect(decode(envelope)).toEqual({
      eventId: 'event-1',
      topic: 'orders',
      name: 'placed',
      payload: { total: 42 },
      actor: { id: 'user-1' },
      orderKey: 'order-9',
    })
  })

  it('puts routing details and trace headers in the attributes', () => {
    expect(toPubSubEnvelope(anEvent()).message.attributes).toEqual({
      eventId: 'event-1',
      topic: 'orders',
      name: 'placed',
      attempts: '2',
      orderKey: 'order-9',
      'sentry-trace': 'trace-abc',
    })
  })

  it('omits an absent order key and copes without trace headers', () => {
    const attributes = toPubSubEnvelope(
      anEvent({ orderKey: null, trace: null }),
    ).message.attributes

    expect(attributes).not.toHaveProperty('orderKey')
    expect(attributes).toEqual({
      eventId: 'event-1',
      topic: 'orders',
      name: 'placed',
      attempts: '2',
    })
  })

  it('accepts a custom message shape for existing endpoints', () => {
    const envelope = toPubSubEnvelope(anEvent(), (event) => ({
      eventName: event.name,
      eventData: event.payload,
    }))

    expect(decode(envelope)).toEqual({
      eventName: 'placed',
      eventData: { total: 42 },
    })
  })

  it('exports its default encoder for reuse', () => {
    expect(defaultMessageEncoder(anEvent())).toMatchObject({ topic: 'orders' })
  })
})

describe('HttpEventHandler', () => {
  it('POSTs the envelope as JSON', async () => {
    const { fetch, calls } = respondWith(200, '{"ok":true}')
    const handler = new HttpEventHandler({ url: 'https://fn.example/orders', fetch })

    const result = await handler.handle(anEvent())

    expect(result).toEqual({ ok: true })
    expect(calls[0]?.[0]).toBe('https://fn.example/orders')

    const init = calls[0]?.[1] as RequestInit
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'application/json',
    )
    expect(JSON.parse(init.body as string)).toMatchObject({
      subscription: 'queueteapi/orders',
    })
  })

  it('adds an Authorization header when a token is provided', async () => {
    const { fetch, calls } = respondWith(200, '')
    const handler = new HttpEventHandler({
      url: 'https://fn.example/orders',
      fetch,
      getAuthorization: async (url) => `Bearer token-for-${url}`,
    })

    await handler.handle(anEvent())

    const headers = (calls[0]?.[1] as RequestInit).headers as Record<
      string,
      string
    >
    expect(headers.authorization).toBe(
      'Bearer token-for-https://fn.example/orders',
    )
  })

  it('sends no Authorization header when the provider returns null', async () => {
    const { fetch, calls } = respondWith(200, '')
    const handler = new HttpEventHandler({
      url: 'https://fn.example/orders',
      fetch,
      getAuthorization: () => null,
    })

    await handler.handle(anEvent())

    const headers = (calls[0]?.[1] as RequestInit).headers as Record<
      string,
      string
    >
    expect(headers).not.toHaveProperty('authorization')
  })

  it('merges extra headers', async () => {
    const { fetch, calls } = respondWith(200, '')
    const handler = new HttpEventHandler({
      url: 'https://fn.example/orders',
      fetch,
      headers: { 'x-source': 'queueteapi' },
    })

    await handler.handle(anEvent())

    const headers = (calls[0]?.[1] as RequestInit).headers as Record<
      string,
      string
    >
    expect(headers['x-source']).toBe('queueteapi')
  })

  it('returns null for an empty body', async () => {
    const { fetch } = respondWith(204, '')
    const handler = new HttpEventHandler({ url: 'https://fn.example', fetch })
    expect(await handler.handle(anEvent())).toBeNull()
  })

  it('returns the raw text when the body is not JSON', async () => {
    const { fetch } = respondWith(200, 'thanks')
    const handler = new HttpEventHandler({ url: 'https://fn.example', fetch })
    expect(await handler.handle(anEvent())).toBe('thanks')
  })

  it.each([500, 502, 503, 408, 429])(
    'treats %i as worth retrying',
    async (status) => {
      const { fetch } = respondWith(status, 'later')
      const handler = new HttpEventHandler({ url: 'https://fn.example', fetch })

      const error = await handler.handle(anEvent()).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(HttpHandlerError)
      expect(error).not.toBeInstanceOf(PermanentError)
    },
  )

  it.each([400, 401, 403, 404, 422])(
    'treats %i as permanent, so it goes straight to dead',
    async (status) => {
      const { fetch } = respondWith(status, 'no')
      const handler = new HttpEventHandler({ url: 'https://fn.example', fetch })

      const error = await handler.handle(anEvent()).catch((e: unknown) => e)

      expect(error).toBeInstanceOf(PermanentHttpHandlerError)
      expect(error).toBeInstanceOf(PermanentError)
    },
  )

  it('reports the status and body in the error message', async () => {
    const { fetch } = respondWith(500, 'stack trace here')
    const handler = new HttpEventHandler({ url: 'https://fn.example', fetch })

    await expect(handler.handle(anEvent())).rejects.toThrow(
      'POST https://fn.example responded 500: stack trace here',
    )
  })

  it('truncates a very long error body', async () => {
    const { fetch } = respondWith(500, 'x'.repeat(900))
    const handler = new HttpEventHandler({ url: 'https://fn.example', fetch })

    const error = (await handler
      .handle(anEvent())
      .catch((e: unknown) => e)) as Error

    expect(error.message).toContain('…')
    expect(error.message.length).toBeLessThan(600)
  })

  it('uses the global fetch when none is injected', async () => {
    const globalFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"via":"global"}', { status: 200 }))

    const handler = new HttpEventHandler({ url: 'https://fn.example' })
    expect(await handler.handle(anEvent())).toEqual({ via: 'global' })

    globalFetch.mockRestore()
  })
})
