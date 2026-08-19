/**
 * Moving off Pub/Sub without touching the code that receives events.
 *
 * If your handlers are HTTP endpoints today — a push subscription POSTing to a
 * private function URL — `HttpEventHandler` sends the byte-identical envelope
 * to the same URL with the same OIDC token. The receiving end cannot tell
 * which transport delivered it.
 */
import { getFirestore } from 'firebase-admin/firestore'

import { HttpEventHandler, QueueTeaPi } from 'queueteapi'

const queue = new QueueTeaPi({
  firestore: getFirestore(),
  collection: 'domain-events',
})

// ── 1. Point a topic at the endpoint it already has ────────────────────────

queue.handlers.register(
  'medication-agreements',
  'stock-updated',
  new HttpEventHandler({
    url: 'https://europe-west1-my-project.cloudfunctions.net/onStockUpdated',

    // Exactly the token a push subscription's OIDC config would have minted.
    getAuthorization: async (url) => `Bearer ${await mintIdentityToken(url)}`,
  }),
)

// ── 2. Keep an existing message shape, if your handlers expect one ─────────

queue.handlers.register(
  'medication-agreements',
  'archived',
  new HttpEventHandler({
    url: 'https://europe-west1-my-project.cloudfunctions.net/onArchived',
    getAuthorization: async (url) => `Bearer ${await mintIdentityToken(url)}`,

    // The default body is { eventId, topic, name, payload, actor, orderKey }.
    // Override it to match what the endpoint already parses.
    encodeMessage: (event) => ({
      eventName: event.name,
      eventData: event.payload,
      eventActor: event.actor,
    }),
  }),
)

// ── 3. Migrate one event at a time ─────────────────────────────────────────

/**
 * Rolling out gradually is a config decision, not a code change: keep both
 * transports live and move one entry at a time.
 *
 * Publish through QueueTeaPi where this returns true, and through your
 * existing Pub/Sub client everywhere else. Rollback is deleting one line.
 */
const MIGRATED = new Set(['medication-agreements/stock-updated'])

export async function publishDomainEvent(
  topic: string,
  name: string,
  payload: unknown,
  orderKey?: string,
): Promise<void> {
  if (MIGRATED.has(`${topic}/${name}`)) {
    await queue.publish({ topic, name, payload, orderKey })
    return
  }

  await publishToPubSub(topic, name, payload, orderKey)
}

// ── stand-ins for your own code ────────────────────────────────────────────

declare function mintIdentityToken(audience: string): Promise<string>
declare function publishToPubSub(
  topic: string,
  name: string,
  payload: unknown,
  orderKey?: string,
): Promise<void>
