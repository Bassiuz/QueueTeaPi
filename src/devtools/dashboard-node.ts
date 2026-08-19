import type { DashboardHandler } from './dashboard.js'

/**
 * The parts of Node's `IncomingMessage` the adapter reads. Declared
 * structurally so a real request satisfies it and a test can pass an object
 * literal.
 */
export interface NodeRequestLike {
  method?: string | undefined
  url?: string | undefined
}

/** The parts of Node's `ServerResponse` the adapter writes. */
export interface NodeResponseLike {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

export interface NodeAdapterOptions {
  /**
   * The path the dashboard is mounted at, stripped from incoming URLs before
   * routing. Defaults to `/`.
   */
  basePath?: string
}

/**
 * Adapts the dashboard to Node's `http` server and to anything that speaks
 * the same shape — Express and Fastify both do.
 *
 * ```ts
 * import { createServer } from 'node:http'
 *
 * const dashboard = createDashboard({ inspector: queue.createInspector() })
 * createServer(createNodeRequestListener(dashboard)).listen(3000)
 * ```
 *
 * Mounted under a prefix, tell both halves where they are:
 *
 * ```ts
 * const dashboard = createDashboard({ inspector, basePath: '/admin/queue' })
 * app.use('/admin/queue', createNodeRequestListener(dashboard, { basePath: '/admin/queue' }))
 * ```
 */
export function createNodeRequestListener(
  dashboard: DashboardHandler,
  options: NodeAdapterOptions = {},
): (request: NodeRequestLike, response: NodeResponseLike) => Promise<void> {
  const basePath = trimTrailingSlash(options.basePath ?? '')

  return async function listener(request, response) {
    // The origin is irrelevant — `URL` just needs one to parse a path.
    const url = new URL(request.url ?? '/', 'http://queueteapi.invalid')

    const result = await dashboard({
      method: request.method ?? 'GET',
      path: stripBasePath(url.pathname, basePath),
      query: Object.fromEntries(url.searchParams),
    })

    response.statusCode = result.status
    for (const [name, value] of Object.entries(result.headers)) {
      response.setHeader(name, value)
    }
    response.end(result.body)
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/**
 * Removes the mount prefix so the dashboard always sees paths relative to
 * itself. Frameworks that already strip it (Express `app.use`) leave nothing
 * to remove, which is why a missing prefix is not an error.
 */
function stripBasePath(pathname: string, basePath: string): string {
  if (basePath === '' || !pathname.startsWith(basePath)) return pathname

  const remainder = pathname.slice(basePath.length)
  if (remainder === '') return '/'
  return remainder.startsWith('/') ? remainder : pathname
}
