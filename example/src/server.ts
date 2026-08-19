import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createDashboard,
  createNodeRequestListener,
  type QueuedEvent,
} from 'queueteapi'

import type { Order, Served } from './kitchen.js'
import {
  PIE_BAKE_MS,
  SHOWSTOPPER_BAKE_MS,
  SHOWSTOPPER_FAILURE_RATE,
  TEA_BREW_MS,
  pickRandom,
  type ItemKind,
} from './menu.js'
import { COLLECTION, createKitchen } from './queue.js'

/**
 * The whole demo server: a tea room that runs on QueueTeaPi.
 *
 * Two things worth noticing while reading this file.
 *
 * The served list is not a second data store. It is `inspector.list({ status:
 * 'done' })` — the queue's own ledger, read back. Every cup on the page is an
 * event document.
 *
 * And the dispatcher is just started, once, in the same process. In production
 * you would run it on its own service; here it shares the web server so the
 * whole thing is one `npm start`.
 */

const PORT = Number(process.env.PORT ?? 4000)

/** Handlers running at once. Low enough that a bulk order visibly drains. */
const POOL_SIZE = Number(process.env.QUEUE_POOL_SIZE ?? 10)

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web')

const kitchen = await createKitchen()
const { queue } = kitchen
const inspector = queue.createInspector()

/**
 * Whether reads cost money here.
 *
 * Memory and the emulator are free, so the demo can be as impatient as it
 * likes — that impatience is the point, it is what lets you watch a hundred
 * pies drain. A real project is metered, and the same settings there read 150
 * documents nearly three times a second, which empties a free-tier daily
 * quota in about two minutes of watching.
 */
const METERED = kitchen.mode === 'project'

/** How many served items the page shows. The ledger keeps all of them. */
const SERVED_ON_SCREEN = METERED ? 50 : 150

/** How often the page refetches. Every pass re-reads the served list. */
const POLL_MS = METERED ? 5_000 : 400

// ponytail: throttling is enough for a demo you watch for a few minutes. The
// real fix is a listener on `status == 'done'` feeding an in-memory list, so
// polls cost nothing and each completion costs one read — worth building if
// this page ever becomes something people leave open.

const dispatcher = queue.createDispatcher({
  poolSize: POOL_SIZE,
  batchSize: 50,
  // A pie needs a second; give the sweep something to do on a human timescale.
  // Each sweep is two queries, so on a metered project that alone would spend
  // ~86k reads a day doing nothing.
  sweepIntervalMs: METERED ? 30_000 : 2_000,
})
dispatcher.start()

const dashboard = createNodeRequestListener(
  createDashboard({
    inspector,
    basePath: '/queue',
    title: `Tea Room — ${kitchen.mode} mode`,
  }),
  { basePath: '/queue' },
)

// ── routes ─────────────────────────────────────────────────────────────────

const server = createServer((request, response) => {
  void route(request, response).catch((error: unknown) => {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    })
  })
})

async function route(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host}`)
  const path = url.pathname
  const method = request.method ?? 'GET'

  // The QueueTeaPi dashboard, mounted whole.
  if (path === '/queue' || path.startsWith('/queue/')) {
    return dashboard(request, response)
  }

  if (method === 'GET' && path === '/') return sendFile(response, 'index.html')
  if (method === 'GET' && path === '/app.js') return sendFile(response, 'app.js')
  if (method === 'GET' && path === '/styles.css') {
    return sendFile(response, 'styles.css')
  }

  if (method === 'GET' && path === '/api/config') {
    return sendJson(response, 200, {
      mode: kitchen.mode,
      description: kitchen.description,
      collection: COLLECTION,
      poolSize: POOL_SIZE,
      teaBrewMs: TEA_BREW_MS,
      pieBakeMs: PIE_BAKE_MS,
      showstopperBakeMs: SHOWSTOPPER_BAKE_MS,
      showstopperFailureRate: SHOWSTOPPER_FAILURE_RATE,
      servedOnScreen: SERVED_ON_SCREEN,
      pollMs: POLL_MS,
      metered: METERED,
      canClear: kitchen.memory !== undefined,
    })
  }

  if (method === 'GET' && path === '/api/stats') {
    return sendJson(response, 200, await inspector.stats())
  }

  if (method === 'GET' && path === '/api/served') {
    return sendJson(response, 200, { served: await servedItems() })
  }

  // ── ordering ─────────────────────────────────────────────────────────────

  if (method === 'POST' && path === '/api/order/inline') {
    const kind = readKind(url.searchParams.get('kind'))

    try {
      return sendJson(response, 200, { served: await orderInline(kind) })
    } catch (error) {
      // Inline delivery rethrows whatever the handler threw. The event is
      // still in the ledger and will be retried on its own, so this is a
      // disappointment rather than an error — 200 with the bad news in it, and
      // the page says so.
      return sendJson(response, 200, {
        served: null,
        failed: true,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  if (method === 'POST' && path === '/api/order/bulk') {
    const kind = readKind(url.searchParams.get('kind'))
    const body = await readJsonBody(request)
    const count = clamp(Number(body.count ?? 10), 1, 1_000)

    return sendJson(response, 200, { queued: await orderBulk(kind, count) })
  }

  if (method === 'POST' && path === '/api/order/clumsy') {
    return sendJson(response, 200, { id: await orderClumsily() })
  }

  if (method === 'POST' && path === '/api/clear') {
    if (kitchen.memory === undefined) {
      return sendJson(response, 400, {
        error:
          'Clearing is only offered in memory mode — this would delete real documents.',
      })
    }
    kitchen.memory.clear()
    return sendJson(response, 200, { cleared: true })
  }

  sendJson(response, 404, { error: `No route for ${method} ${path}` })
}

// ── the four buttons ───────────────────────────────────────────────────────

/**
 * Inline: `publish()` runs the handler itself and resolves with what it
 * returned, so the caller waits — 200ms for a tea, a second for a pie.
 */
async function orderInline(kind: ItemKind): Promise<Served | null> {
  const item = pickRandom(kind)

  const { result } = await queue.publish<Order, Served>({
    topic: 'kitchen',
    name: eventNameFor(kind),
    mode: 'inline',
    payload: { varietyId: item.id, kind },
    orderKey: `counter-${kind}`,
  })

  return result
}

/**
 * Queued: each `publish()` returns as soon as the document is written. The
 * dispatcher works through them at `poolSize` at a time, which is what makes
 * the page fill up gradually rather than all at once.
 */
async function orderBulk(kind: ItemKind, count: number): Promise<number> {
  const orders = Array.from({ length: count }, () => pickRandom(kind))

  await Promise.all(
    orders.map((item) =>
      queue.publish<Order>({
        topic: 'kitchen',
        name: eventNameFor(kind),
        payload: { varietyId: item.id, kind },
        orderKey: `bulk-${kind}`,
      }),
    ),
  )

  return count
}

/** An order that always fails, to put something in the dead-letter queue. */
async function orderClumsily(): Promise<string> {
  const item = pickRandom(Math.random() < 0.5 ? 'tea' : 'pie')

  const { id } = await queue.publish<Order>({
    topic: 'kitchen',
    name: eventNameFor(item.kind),
    payload: { varietyId: item.id, kind: item.kind, clumsy: true },
  })

  return id
}

// ── reading the ledger back ────────────────────────────────────────────────

interface ServedRow extends Served {
  id: string
  orderedAt: number
  servedAt: number | null
  /** Order to plate, including any time spent waiting in the queue. */
  waitedMs: number
  attempts: number
  mode: string
}

/**
 * The list on the page.
 *
 * There is no separate "served" collection — these are the queue's own `done`
 * events, with the handler's return value stored on each one.
 */
async function servedItems(): Promise<ServedRow[]> {
  const events = await inspector.list({
    status: 'done',
    limit: SERVED_ON_SCREEN,
  })

  return events.flatMap((event) => {
    const served = (event as QueuedEvent<Order, Served>).result
    if (served === null) return []

    return [
      {
        ...served,
        id: event.id,
        orderedAt: event.createdAt,
        servedAt: event.finishedAt,
        waitedMs: (event.finishedAt ?? event.updatedAt) - event.createdAt,
        attempts: event.attempts,
        mode: event.mode,
      },
    ]
  })
}

// ── plumbing ───────────────────────────────────────────────────────────────

function eventNameFor(kind: ItemKind): string {
  if (kind === 'tea') return 'brew-tea'
  if (kind === 'pie') return 'bake-pie'
  return 'bake-showstopper'
}

function readKind(value: string | null): ItemKind {
  if (value === 'pie') return 'pie'
  if (value === 'showstopper') return 'showstopper'
  return 'tea'
}

function clamp(value: number, low: number, high: number): number {
  if (!Number.isFinite(value)) return low
  return Math.min(Math.max(Math.round(value), low), high)
}

async function readJsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(chunk as Buffer)

  const body = Buffer.concat(chunks).toString('utf8')
  if (body.length === 0) return {}

  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    return {}
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
}

async function sendFile(response: ServerResponse, name: string): Promise<void> {
  const body = await readFile(join(WEB_ROOT, name))
  const extension = name.slice(name.lastIndexOf('.'))

  response.statusCode = 200
  response.setHeader('content-type', CONTENT_TYPES[extension] ?? 'text/plain')
  response.setHeader('cache-control', 'no-store')
  response.end(body)
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.statusCode = status
  response.setHeader('content-type', 'application/json; charset=utf-8')
  response.setHeader('cache-control', 'no-store')
  response.end(JSON.stringify(body))
}

// ── go ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.info('')
  console.info(`  🫖 QueueTeaPi example — ${kitchen.mode} mode`)
  console.info(`     ${kitchen.description}`)
  console.info('')
  console.info(`     tea room   http://localhost:${PORT}`)
  console.info(`     dashboard  http://localhost:${PORT}/queue`)
  console.info('')
})

async function shutDown(): Promise<void> {
  console.info('\n  Closing the tea room…')
  await dispatcher.stop() // waits for whatever is mid-brew
  server.close()
}

process.on('SIGINT', () => void shutDown())
process.on('SIGTERM', () => void shutDown())
