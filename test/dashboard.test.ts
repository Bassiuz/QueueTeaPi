import { beforeEach, describe, expect, it } from 'vitest'

import {
  createDashboard,
  type DashboardHandler,
} from '../src/devtools/dashboard.js'
import { createNodeRequestListener } from '../src/devtools/dashboard-node.js'
import type { QueueInspector } from '../src/devtools/queue-inspector.js'
import { createHarness, type Harness } from './support/harness.js'

let harness: Harness
let inspector: QueueInspector
let dashboard: DashboardHandler

beforeEach(() => {
  harness = createHarness()
  inspector = harness.queue.createInspector()
  dashboard = createDashboard({ inspector })
})

/** Publishes an event and drives it into the dead-letter queue. */
async function aDeadEvent(): Promise<string> {
  const { queue, clock } = harness
  const { id } = await queue.publish({ topic: 'orders', name: 'placed' })
  const stored = (await queue.store.get(id))!
  const claimed = (await queue.store.claim(stored, { owner: 'w', ttlMs: 1 }))!

  await queue.store.markDead(claimed, {
    name: 'Error',
    message: 'it broke',
    stack: null,
    permanent: false,
    at: clock.now(),
  })
  return id
}

function body(response: { body: string }): any {
  return JSON.parse(response.body)
}

describe('the page', () => {
  it('serves HTML at the root', async () => {
    const response = await dashboard({ method: 'GET', path: '/' })

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('<!doctype html>')
  })

  it('never lets a browser cache queue state', async () => {
    const response = await dashboard({ method: 'GET', path: '/' })
    expect(response.headers['cache-control']).toBe('no-store')
  })

  it('points its fetches at the mount path', async () => {
    const mounted = createDashboard({ inspector, basePath: '/admin/queue/' })
    const response = await mounted({ method: 'GET', path: '/' })

    expect(response.body).toContain('"/admin/queue/api"')
  })

  it('adds the leading slash to a mount path given without one', async () => {
    const mounted = createDashboard({ inspector, basePath: 'admin/queue' })
    const response = await mounted({ method: 'GET', path: '/' })

    expect(response.body).toContain('"/admin/queue/api"')
  })

  it('escapes the title rather than trusting it', async () => {
    const titled = createDashboard({
      inspector,
      title: '<script>alert(1)</script>',
    })
    const response = await titled({ method: 'GET', path: '/' })

    expect(response.body).not.toContain('<script>alert(1)</script>')
    expect(response.body).toContain('&lt;script&gt;')
  })
})

describe('GET /api/stats', () => {
  it('returns the same stats the inspector reports', async () => {
    await harness.queue.publish({ topic: 'orders', name: 'placed' })

    const response = await dashboard({ method: 'GET', path: '/api/stats' })

    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(body(response)).toMatchObject({
      counts: { pending: 1 },
      dueNow: 1,
      total: 1,
    })
  })

  /**
   * `stats()` runs aggregate queries whose cost grows with the ledger, so
   * every open tab hitting Firestore on its own timer is how this dashboard
   * runs up a bill. These two tests pin the cache that prevents it.
   */
  it('serves repeated and concurrent calls from one inspector query', async () => {
    let calls = 0
    const counting = createDashboard({
      inspector: {
        ...inspector,
        stats: async () => {
          calls += 1
          return inspector.stats()
        },
      } as unknown as QueueInspector,
    })

    await counting({ method: 'GET', path: '/api/stats' })
    await counting({ method: 'GET', path: '/api/stats' })
    await Promise.all([
      counting({ method: 'GET', path: '/api/stats' }),
      counting({ method: 'GET', path: '/api/stats' }),
    ])

    expect(calls).toBe(1)
  })

  it('reflects a replay immediately rather than serving stale counts', async () => {
    const id = await aDeadEvent()

    expect(body(await dashboard({ method: 'GET', path: '/api/stats' })).counts)
      .toMatchObject({ dead: 1, pending: 0 })

    await dashboard({ method: 'POST', path: `/api/events/${id}/replay` })

    expect(body(await dashboard({ method: 'GET', path: '/api/stats' })).counts)
      .toMatchObject({ dead: 0, pending: 1 })
  })
})

describe('GET /api/events', () => {
  it('lists events', async () => {
    await harness.queue.publish({ topic: 'orders', name: 'placed' })

    const response = await dashboard({ method: 'GET', path: '/api/events' })

    expect(body(response).events).toHaveLength(1)
  })

  it('filters by status', async () => {
    await aDeadEvent()
    await harness.queue.publish({ topic: 'orders', name: 'other' })

    const response = await dashboard({
      method: 'GET',
      path: '/api/events',
      query: { status: 'dead' },
    })

    expect(body(response).events).toHaveLength(1)
  })

  it('treats "all" and an empty filter as no filter', async () => {
    await aDeadEvent()
    await harness.queue.publish({ topic: 'orders', name: 'other' })

    for (const status of ['all', '']) {
      const response = await dashboard({
        method: 'GET',
        path: '/api/events',
        query: { status },
      })
      expect(body(response).events).toHaveLength(2)
    }
  })

  it('rejects a status it does not recognise', async () => {
    const response = await dashboard({
      method: 'GET',
      path: '/api/events',
      query: { status: 'exploded' },
    })

    expect(response.status).toBe(400)
    expect(body(response).error).toContain('Unknown status "exploded"')
  })

  it('honours a limit', async () => {
    await harness.queue.publish({ topic: 'orders', name: 'a' })
    await harness.queue.publish({ topic: 'orders', name: 'b' })

    const response = await dashboard({
      method: 'GET',
      path: '/api/events',
      query: { limit: '1' },
    })

    expect(body(response).events).toHaveLength(1)
  })

  it.each(['0', '-5', 'many', ''])(
    'falls back to the default limit for %p',
    async (limit) => {
      const response = await dashboard({
        method: 'GET',
        path: '/api/events',
        query: { limit },
      })
      expect(response.status).toBe(200)
    },
  )

  it('caps an outrageous limit', async () => {
    const response = await dashboard({
      method: 'GET',
      path: '/api/events',
      query: { limit: '100000' },
    })
    expect(response.status).toBe(200)
  })
})

describe('GET /api/events/{id}', () => {
  it('returns one event', async () => {
    const id = await aDeadEvent()

    const response = await dashboard({
      method: 'GET',
      path: `/api/events/${id}`,
    })

    expect(body(response).event).toMatchObject({ id, status: 'dead' })
  })

  it('404s for an unknown id', async () => {
    const response = await dashboard({ method: 'GET', path: '/api/events/nope' })

    expect(response.status).toBe(404)
    expect(body(response).error).toContain('No event with id "nope"')
  })

  it('decodes an escaped id', async () => {
    const response = await dashboard({
      method: 'GET',
      path: '/api/events/a%20b',
    })
    expect(body(response).error).toContain('"a b"')
  })

  it('does not treat a deeper path as an event id', async () => {
    const response = await dashboard({
      method: 'GET',
      path: '/api/events/one/two',
    })
    expect(response.status).toBe(404)
    expect(body(response).error).toContain('No dashboard route')
  })

  it('does not treat a bare /api/events/ as an event id', async () => {
    const response = await dashboard({ method: 'GET', path: '/api/events/' })

    // The trailing slash is normalised away, so this is the list route.
    expect(response.status).toBe(200)
    expect(body(response)).toHaveProperty('events')
  })
})

describe('POST /api/events/{id}/replay', () => {
  it('sends an event back to pending', async () => {
    const id = await aDeadEvent()

    const response = await dashboard({
      method: 'POST',
      path: `/api/events/${id}/replay`,
    })

    expect(response.status).toBe(200)
    expect(body(response).event).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('404s when there is nothing to replay', async () => {
    const response = await dashboard({
      method: 'POST',
      path: '/api/events/nope/replay',
    })

    expect(response.status).toBe(404)
    expect(body(response).error).toContain('could not be replayed')
  })

  it('is refused on a read-only dashboard', async () => {
    const id = await aDeadEvent()
    const readOnly = createDashboard({ inspector, readOnly: true })

    const response = await readOnly({
      method: 'POST',
      path: `/api/events/${id}/replay`,
    })

    expect(response.status).toBe(403)
    expect(await inspector.get(id)).toMatchObject({ status: 'dead' })
  })

  it('is not matched when the id is missing', async () => {
    const response = await dashboard({
      method: 'POST',
      path: '/api/events//replay',
    })

    expect(response.status).toBe(404)
    expect(body(response).error).toContain('No dashboard route')
  })

  it('is not matched when the id would span path segments', async () => {
    const response = await dashboard({
      method: 'POST',
      path: '/api/events/one/two/replay',
    })

    expect(response.status).toBe(404)
    expect(body(response).error).toContain('No dashboard route')
  })
})

describe('POST /api/replay', () => {
  it('replays the dead-letter queue', async () => {
    await aDeadEvent()
    await aDeadEvent()

    const response = await dashboard({ method: 'POST', path: '/api/replay' })

    expect(body(response)).toEqual({ matched: 2, replayed: 2 })
  })

  it('can target another status', async () => {
    await harness.queue.publish({ topic: 'orders', name: 'placed' })

    const response = await dashboard({
      method: 'POST',
      path: '/api/replay',
      query: { status: 'pending' },
    })

    expect(body(response)).toEqual({ matched: 1, replayed: 1 })
  })

  it('rejects an unknown status', async () => {
    const response = await dashboard({
      method: 'POST',
      path: '/api/replay',
      query: { status: 'sideways' },
    })
    expect(response.status).toBe(400)
  })

  it('is refused on a read-only dashboard', async () => {
    const readOnly = createDashboard({ inspector, readOnly: true })
    const response = await readOnly({ method: 'POST', path: '/api/replay' })

    expect(response.status).toBe(403)
    expect(body(response).error).toContain('read-only')
  })
})

describe('routing', () => {
  it('accepts a lower-case method', async () => {
    expect((await dashboard({ method: 'get', path: '/' })).status).toBe(200)
  })

  it('tolerates a missing leading slash', async () => {
    expect((await dashboard({ method: 'GET', path: 'api/stats' })).status).toBe(
      200,
    )
  })

  it('tolerates a trailing slash', async () => {
    expect((await dashboard({ method: 'GET', path: '/api/stats/' })).status).toBe(
      200,
    )
  })

  it('treats a path of only slashes as the root', async () => {
    expect((await dashboard({ method: 'GET', path: '//' })).status).toBe(200)
  })

  it('404s an unknown route', async () => {
    const response = await dashboard({ method: 'GET', path: '/api/nothing' })

    expect(response.status).toBe(404)
    expect(body(response).error).toContain('No dashboard route for GET')
  })

  it('404s a known path with the wrong method', async () => {
    expect(
      (await dashboard({ method: 'DELETE', path: '/api/stats' })).status,
    ).toBe(404)
  })

  it('turns an unexpected failure into a 500 rather than crashing', async () => {
    harness.firestore.failWith = () => {
      throw new Error('Firestore unavailable')
    }

    const response = await dashboard({ method: 'GET', path: '/api/stats' })

    expect(response.status).toBe(500)
    expect(body(response).error).toBe('Firestore unavailable')
  })

  it('reports a non-Error failure too', async () => {
    const broken = createDashboard({
      inspector: {
        stats: async () => {
          throw 'just a string'
        },
      } as unknown as QueueInspector,
    })

    const response = await broken({ method: 'GET', path: '/api/stats' })

    expect(response.status).toBe(500)
    expect(body(response).error).toBe('just a string')
  })
})

describe('the Node adapter', () => {
  /** A stand-in for Node's ServerResponse. */
  function fakeResponse() {
    return {
      statusCode: 0,
      headers: {} as Record<string, string>,
      body: '',
      setHeader(name: string, value: string) {
        this.headers[name] = value
      },
      end(body?: string) {
        this.body = body ?? ''
      },
    }
  }

  it('routes a request and writes the response', async () => {
    const listener = createNodeRequestListener(dashboard)
    const response = fakeResponse()

    await listener({ method: 'GET', url: '/api/stats' }, response)

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(JSON.parse(response.body)).toMatchObject({ total: 0 })
  })

  it('passes the query string through', async () => {
    const listener = createNodeRequestListener(dashboard)
    const response = fakeResponse()

    await listener({ method: 'GET', url: '/api/events?status=exploded' }, response)

    expect(response.statusCode).toBe(400)
  })

  it('defaults a missing method and url', async () => {
    const listener = createNodeRequestListener(dashboard)
    const response = fakeResponse()

    await listener({}, response)

    expect(response.statusCode).toBe(200)
    expect(response.body).toContain('<!doctype html>')
  })

  it('strips the mount prefix', async () => {
    const listener = createNodeRequestListener(dashboard, {
      basePath: '/admin/queue',
    })
    const response = fakeResponse()

    await listener({ method: 'GET', url: '/admin/queue/api/stats' }, response)

    expect(response.statusCode).toBe(200)
  })

  it('maps the bare mount path to the page', async () => {
    const listener = createNodeRequestListener(dashboard, {
      basePath: '/admin/queue/',
    })
    const response = fakeResponse()

    await listener({ method: 'GET', url: '/admin/queue' }, response)

    expect(response.body).toContain('<!doctype html>')
  })

  it('leaves a path that does not start with the prefix alone', async () => {
    const listener = createNodeRequestListener(dashboard, { basePath: '/admin' })
    const response = fakeResponse()

    await listener({ method: 'GET', url: '/api/stats' }, response)

    expect(response.statusCode).toBe(200)
  })

  it('does not strip a prefix that only matches partially', async () => {
    const listener = createNodeRequestListener(dashboard, { basePath: '/admin' })
    const response = fakeResponse()

    // "/administration" starts with "/admin" but is a different route.
    await listener({ method: 'GET', url: '/administration/api/stats' }, response)

    expect(response.statusCode).toBe(404)
  })
})
