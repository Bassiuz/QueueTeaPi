import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createDashboard,
  createNodeRequestListener,
} from '../src/index.js'
import { createHarness, type Harness } from './support/harness.js'

/**
 * The dashboard over a genuine Node HTTP server.
 *
 * The unit tests drive the adapter with object literals; this one proves the
 * structural `NodeRequestLike` / `NodeResponseLike` types really are satisfied
 * by Node's own `IncomingMessage` and `ServerResponse`, and that the page and
 * its API work end to end.
 */
let harness: Harness
let server: Server
let origin: string

beforeEach(async () => {
  harness = createHarness()

  const dashboard = createDashboard({
    inspector: harness.queue.createInspector(),
    title: 'orders',
  })
  const listener = createNodeRequestListener(dashboard)

  server = createServer((request, response) => {
    void listener(request, response)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
})

/** Publishes an event and drives it into the dead-letter queue. */
async function aDeadEvent(): Promise<string> {
  const { queue, clock } = harness
  const { id } = await queue.publish({
    topic: 'orders',
    name: 'placed',
    payload: { total: 42 },
  })
  const stored = (await queue.store.get(id))!
  const claimed = (await queue.store.claim(stored, { owner: 'w', ttlMs: 1 }))!

  await queue.store.markDead(claimed, {
    name: 'Error',
    message: 'payment gateway timed out',
    stack: null,
    permanent: false,
    at: clock.now(),
  })
  return id
}

describe('the dashboard over HTTP', () => {
  it('serves a page a browser can render', async () => {
    const response = await fetch(`${origin}/`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')

    const html = await response.text()
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('<title>orders — queue</title>')
    // The page must be self-contained: no external scripts or stylesheets.
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+stylesheet/)
  })

  it('serves stats the page can read', async () => {
    await aDeadEvent()

    const response = await fetch(`${origin}/api/stats`)
    const stats = await response.json()

    expect(stats).toMatchObject({
      collection: 'test-events',
      total: 1,
      counts: { dead: 1, pending: 0 },
    })
  })

  it('lists events, filtered', async () => {
    await aDeadEvent()
    await harness.queue.publish({ topic: 'orders', name: 'other' })

    const response = await fetch(`${origin}/api/events?status=dead&limit=10`)
    const { events } = await response.json()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      status: 'dead',
      lastError: { message: 'payment gateway timed out' },
    })
  })

  it('replays a dead event and the stats then reflect it', async () => {
    const id = await aDeadEvent()

    const replay = await fetch(`${origin}/api/events/${id}/replay`, {
      method: 'POST',
    })
    expect(replay.status).toBe(200)

    const stats = await (await fetch(`${origin}/api/stats`)).json()
    expect(stats.counts).toMatchObject({ dead: 0, pending: 1 })
  })

  it('answers a bad request with a readable error, not a stack trace', async () => {
    const response = await fetch(`${origin}/api/events?status=exploded`)

    expect(response.status).toBe(400)
    expect((await response.json()).error).toContain('Unknown status')
  })

  it('404s an unknown path', async () => {
    expect((await fetch(`${origin}/nope`)).status).toBe(404)
  })
})
