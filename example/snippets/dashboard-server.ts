/**
 * Serving the dev tools.
 *
 * Three ways, depending on where you want them: standalone, mounted inside an
 * existing app, or queried programmatically for a health check.
 */
import { createServer } from 'node:http'

import { getFirestore } from 'firebase-admin/firestore'

import {
  QueueTeaPi,
  createDashboard,
  createNodeRequestListener,
} from 'queueteapi'

const queue = new QueueTeaPi({
  firestore: getFirestore(),
  collection: 'domain-events',
})

// ── standalone ─────────────────────────────────────────────────────────────

/** A dashboard on its own port. Handy locally and on an internal service. */
export function serveDashboard(port = 4300): void {
  const dashboard = createDashboard({
    inspector: queue.createInspector(),
    title: 'domain-events',
  })

  createServer((request, response) => {
    void createNodeRequestListener(dashboard)(request, response)
  }).listen(port, () => {
    console.info(`QueueTeaPi dashboard on http://localhost:${port}`)
  })
}

// ── mounted under a prefix ─────────────────────────────────────────────────

/**
 * Mounted inside an existing app. Tell both halves where they are: the
 * dashboard needs it to build its own URLs, the adapter needs it to strip the
 * prefix off incoming ones.
 *
 * The dashboard has no authentication of its own — it shows payloads and can
 * requeue work — so mount it behind whatever guards the rest of your admin
 * surface, and set `readOnly` anywhere you would not hand someone a console.
 */
export function mountDashboard(app: MinimalExpressApp): void {
  const basePath = '/admin/queue'

  const dashboard = createDashboard({
    inspector: queue.createInspector(),
    basePath,
    readOnly: process.env.NODE_ENV === 'production',
    title: `domain-events — ${process.env.NODE_ENV ?? 'local'}`,
  })

  app.use(basePath, requireAdmin, createNodeRequestListener(dashboard, { basePath }))
}

// ── programmatic ───────────────────────────────────────────────────────────

/** The same data the dashboard shows, for a health check or an alert. */
export async function checkQueueHealth(): Promise<{
  healthy: boolean
  reason?: string
}> {
  const stats = await queue.createInspector().stats()

  if (stats.counts.dead > 0) {
    return { healthy: false, reason: `${stats.counts.dead} dead events` }
  }

  // A backlog is fine; a backlog that is not moving is not.
  const stalled = (stats.oldestDue?.waitingMs ?? 0) > 5 * 60_000
  if (stalled) {
    return {
      healthy: false,
      reason: `oldest event has waited ${Math.round(
        (stats.oldestDue?.waitingMs ?? 0) / 1000,
      )}s — is a dispatcher running?`,
    }
  }

  return { healthy: true }
}

// ── stand-ins for your own code ────────────────────────────────────────────

type Middleware = (request: never, response: never, next: () => void) => void

interface MinimalExpressApp {
  use(path: string, ...handlers: unknown[]): unknown
}

declare const requireAdmin: Middleware
