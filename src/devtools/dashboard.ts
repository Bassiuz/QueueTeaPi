import { EVENT_STATUSES, type EventStatus } from '../events/queued-event.js'
import { renderDashboardPage } from './dashboard-page.js'
import type { QueueInspector, QueueStats } from './queue-inspector.js'

/** A request, reduced to the three things the dashboard cares about. */
export interface DashboardRequest {
  method: string
  /** Path *relative to the mount point*, always starting with `/`. */
  path: string
  query?: Record<string, string | undefined>
}

export interface DashboardResponse {
  status: number
  headers: Record<string, string>
  body: string
}

export type DashboardHandler = (
  request: DashboardRequest,
) => Promise<DashboardResponse>

export interface DashboardOptions {
  inspector: QueueInspector
  /**
   * Where the dashboard is mounted, so its own links and fetches resolve.
   * Defaults to `/`.
   */
  basePath?: string
  /**
   * Refuse every write, including replay. Worth turning on wherever the
   * dashboard is reachable by more people than you would hand a console to.
   */
  readOnly?: boolean
  /** Shown in the page header, e.g. `"staging"`. */
  title?: string
}

const MAX_LIMIT = 500
const DEFAULT_LIMIT = 50

/**
 * How long one `stats()` result is reused.
 *
 * `stats()` runs aggregate queries, and Firestore bills those per thousand
 * index entries matched — so their cost grows with the ledger rather than
 * being capped by a limit. Without this, every open tab pays that price on
 * its own timer. Two seconds is below the point a human notices staleness and
 * far above the polling interval, so ten dashboards cost what one does.
 */
const STATS_TTL_MS = 2_000

/**
 * A framework-agnostic dashboard.
 *
 * It takes a plain request description and returns a plain response, so it
 * can be mounted in Express, Fastify, a Cloud Function, or Node's own
 * `http` server (see `createNodeRequestListener`) without adapters or
 * dependencies.
 *
 * Routes:
 *
 * | Method | Path                       | What it does                      |
 * | ------ | -------------------------- | --------------------------------- |
 * | GET    | `/`                        | The HTML page                     |
 * | GET    | `/api/stats`               | Counts, backlog, oldest item      |
 * | GET    | `/api/events`              | Recent events, filterable         |
 * | GET    | `/api/events/{id}`         | One event in full                 |
 * | POST   | `/api/events/{id}/replay`  | Requeue one event                 |
 * | POST   | `/api/replay`              | Requeue a batch, dead by default  |
 */
export function createDashboard(options: DashboardOptions): DashboardHandler {
  const basePath = normaliseBasePath(options.basePath ?? '/')

  /** The in-flight or most recent `stats()`, shared by every caller. */
  let cached: { at: number; stats: Promise<QueueStats> } | undefined

  /**
   * The promise is cached rather than its result, so that N tabs arriving
   * together on an expired entry make one query instead of N.
   */
  function stats(): Promise<QueueStats> {
    const now = Date.now()
    if (cached !== undefined && now - cached.at < STATS_TTL_MS) {
      return cached.stats
    }

    const pending = options.inspector.stats()
    cached = { at: now, stats: pending }

    // A failure must not be served for the rest of the window.
    void pending.catch(() => {
      if (cached?.stats === pending) cached = undefined
    })

    return pending
  }

  return async function handle(request) {
    const path = normalisePath(request.path)
    const method = request.method.toUpperCase()
    const query = request.query ?? {}

    try {
      if (method === 'GET' && path === '/') {
        return html(
          renderDashboardPage({ basePath, title: options.title ?? 'QueueTeaPi' }),
        )
      }

      if (method === 'GET' && path === '/api/stats') {
        return json(200, await stats())
      }

      if (method === 'GET' && path === '/api/events') {
        const status = readStatus(query.status)
        if (status instanceof Error) return json(400, { error: status.message })

        return json(200, {
          events: await options.inspector.list({
            status,
            limit: readLimit(query.limit),
          }),
        })
      }

      const eventId = matchEventPath(path, '')
      if (method === 'GET' && eventId !== null) {
        const event = await options.inspector.get(eventId)
        return event === null
          ? json(404, { error: `No event with id "${eventId}".` })
          : json(200, { event })
      }

      const replayId = matchEventPath(path, '/replay')
      if (method === 'POST' && replayId !== null) {
        if (options.readOnly) return readOnlyResponse()

        const event = await options.inspector.replay(replayId)
        if (event === null) {
          return json(404, {
            error: `Event "${replayId}" could not be replayed; it no longer exists or changed.`,
          })
        }

        // The counts just moved, and the next refresh is immediate.
        cached = undefined
        return json(200, { event })
      }

      if (method === 'POST' && path === '/api/replay') {
        if (options.readOnly) return readOnlyResponse()

        const status = readStatus(query.status)
        if (status instanceof Error) return json(400, { error: status.message })

        const result = await options.inspector.replayMany({
          status: status ?? 'dead',
          limit: readLimit(query.limit),
        })

        cached = undefined
        return json(200, result)
      }

      return json(404, { error: `No dashboard route for ${method} ${path}.` })
    } catch (error) {
      return json(500, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

// ── routing helpers ───────────────────────────────────────────────────────

/**
 * Matches `/api/events/{id}${suffix}` and returns the id.
 *
 * Written by hand rather than with a regex so that an id containing a slash
 * — which Firestore ids never do, but URLs sometimes carry — cannot be
 * mistaken for a deeper route.
 */
function matchEventPath(path: string, suffix: string): string | null {
  const prefix = '/api/events/'
  if (!path.startsWith(prefix)) return null

  const rest = path.slice(prefix.length)
  if (suffix === '') {
    return rest.length > 0 && !rest.includes('/') ? decodeURIComponent(rest) : null
  }

  if (!rest.endsWith(suffix)) return null
  const id = rest.slice(0, -suffix.length)
  return id.length > 0 && !id.includes('/') ? decodeURIComponent(id) : null
}

function readStatus(value: string | undefined): EventStatus | undefined | Error {
  if (value === undefined || value === '' || value === 'all') return undefined

  if (!EVENT_STATUSES.includes(value as EventStatus)) {
    return new Error(
      `Unknown status "${value}". Expected one of: ${EVENT_STATUSES.join(', ')}.`,
    )
  }
  return value as EventStatus
}

function readLimit(value: string | undefined): number {
  const parsed = Number.parseInt(value ?? '', 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_LIMIT
  return Math.min(parsed, MAX_LIMIT)
}

/**
 * Turns a mount point into a prefix the page can concatenate onto: a leading
 * slash, no trailing one. `"/"` becomes `""`, so `${basePath}/api` is `/api`.
 */
function normaliseBasePath(basePath: string): string {
  const withLeading = basePath.startsWith('/') ? basePath : `/${basePath}`
  return withLeading.replace(/\/+$/, '')
}

/** Guarantees a leading slash and no trailing one, so route matching is exact. */
function normalisePath(path: string): string {
  const withLeading = path.startsWith('/') ? path : `/${path}`
  if (withLeading === '/') return '/'
  return withLeading.replace(/\/+$/, '') || '/'
}

// ── responses ─────────────────────────────────────────────────────────────

function json(status: number, body: unknown): DashboardResponse {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  }
}

function html(body: string): DashboardResponse {
  return {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
    body,
  }
}

function readOnlyResponse(): DashboardResponse {
  return json(403, {
    error: 'This dashboard is read-only; replay is disabled.',
  })
}
