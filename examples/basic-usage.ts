/**
 * The shape of a normal application: publish events, register handlers, run a
 * dispatcher.
 *
 * These examples import from `../src/index.js` so they are typechecked along
 * with the library. In your own code the import is `from 'queueteapi'`.
 */
import { getFirestore } from 'firebase-admin/firestore'

import { PermanentError, QueueTeaPi, consoleLogger } from '../src/index.js'

interface OrderPlaced {
  orderId: string
  customerId: string
  totalCents: number
}

// ── 1. Build the queue ─────────────────────────────────────────────────────

export const queue = new QueueTeaPi({
  firestore: getFirestore(),
  collection: 'domain-events',
  logger: consoleLogger,

  defaults: {
    maxAttempts: 5,
    backoff: { minMs: 10_000, maxMs: 600_000, factor: 2, jitter: 0.2 },
  },

  topics: {
    orders: {
      events: {
        // A user is watching the spinner for this one, so run it during publish.
        'placed': { mode: 'inline' },
        // This one can take its time, and deserves more patience.
        'receipt-requested': { mode: 'queued', maxAttempts: 10 },
      },
    },
  },
})

// ── 2. Wire up the handlers ────────────────────────────────────────────────

queue.handlers.register<OrderPlaced, { charged: boolean }>(
  'orders',
  'placed',
  async (event) => {
    const order = await findOrder(event.payload.orderId)

    // Retrying will never make a deleted order reappear.
    if (order === null) {
      throw new PermanentError(`Order ${event.payload.orderId} no longer exists`)
    }

    // Anything thrown from here is retried with backoff.
    await chargeCard(order)

    // Returned values are stored on the event, and handed back by inline mode.
    return { charged: true }
  },
)

queue.handlers.register<OrderPlaced, void>(
  'orders',
  'receipt-requested',
  async (event) => {
    await emailReceipt(event.payload.customerId, event.payload.orderId)
  },
)

// ── 3. Publish ─────────────────────────────────────────────────────────────

export async function placeOrder(order: OrderPlaced): Promise<boolean> {
  // Inline: this resolves once the card is charged, with the handler's result.
  const { result } = await queue.publish<OrderPlaced, { charged: boolean }>({
    topic: 'orders',
    name: 'placed',
    payload: order,
    actor: { id: order.customerId, type: 'customer' },
    orderKey: order.orderId,
  })

  // Queued: this resolves as soon as the event is durably written.
  await queue.publish({
    topic: 'orders',
    name: 'receipt-requested',
    payload: order,
    delayMs: 5_000, // give the payment webhook a moment to land first
  })

  return result?.charged ?? false
}

// ── 4. Run the dispatcher ──────────────────────────────────────────────────

/** For a long-running service with CPU always allocated. */
export function startDispatcher(): () => Promise<void> {
  const dispatcher = queue.createDispatcher({
    poolSize: 20,
    handlerTimeoutMs: 60_000,
    sweepIntervalMs: 30_000,
    onTick: (summary) => {
      if (summary.deadLettered > 0) reportToMetrics(summary.deadLettered)
    },
  })

  dispatcher.start()

  // Stop waits for in-flight handlers, so shutdown does not orphan work.
  return () => dispatcher.stop()
}

/** For a scheduled job instead — no timers, nothing to keep warm. */
export async function drainOnce(): Promise<void> {
  const dispatcher = queue.createDispatcher({ watchForNewEvents: false })

  await dispatcher.sweepOnce() // rescue anything a dead worker was holding
  await dispatcher.runOnce()
}

// ── stand-ins for your own code ────────────────────────────────────────────

declare function findOrder(orderId: string): Promise<OrderPlaced | null>
declare function chargeCard(order: OrderPlaced): Promise<void>
declare function emailReceipt(customerId: string, orderId: string): Promise<void>
declare function reportToMetrics(deadLettered: number): void
