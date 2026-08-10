import { PermanentError } from 'queueteapi'
import type { QueuedEvent } from 'queueteapi'

import {
  findItem,
  preparationMs,
  type ItemKind,
  type MenuItem,
} from './menu.js'

/**
 * The handlers — the only code in this example that does any actual work.
 *
 * Everything else (publishing, retrying, dead-lettering, the dashboard) is
 * QueueTeaPi. These two functions are the whole application.
 */

/** What an order looks like on the wire. */
export interface Order {
  varietyId: string
  kind: ItemKind
  /** Set by the "clumsy waiter" button to make the handler fail on purpose. */
  clumsy?: boolean
}

/** What comes back out — this is what the web page renders. */
export interface Served {
  varietyId: string
  kind: ItemKind
  name: string
  emoji: string
  hue: number
  /** How long the handler itself took, in milliseconds. */
  preparedInMs: number
}

/**
 * Brews a tea or bakes a pie.
 *
 * One handler covers both, because the only difference is how long it takes —
 * which is exactly the point being demonstrated: a slow handler does not need
 * different plumbing, just a queue that will wait for it.
 */
export async function prepare(event: QueuedEvent<Order>): Promise<Served> {
  const order = event.payload
  const item = findItem(order.varietyId)

  // Retrying will not conjure a variety that is not on the menu, so this
  // failure skips the retry budget and goes straight to the dead-letter queue.
  if (item === undefined) {
    throw new PermanentError(`"${order.varietyId}" is not on the menu`)
  }

  if (order.clumsy === true) {
    // An ordinary Error, so the event is retried with backoff and only
    // dead-lettered once its attempt budget runs out. Watch it happen in the
    // dashboard at /queue.
    throw new Error(`Dropped the ${item.name} ${item.kind} on the way out`)
  }

  const takes = preparationMs(item.kind)
  await sleep(takes)

  return toServed(item, takes)
}

/** Shapes a menu item into the record stored on the event as its result. */
export function toServed(item: MenuItem, preparedInMs: number): Served {
  return {
    varietyId: item.id,
    kind: item.kind,
    name: item.name,
    emoji: item.emoji,
    hue: item.hue,
    preparedInMs,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
