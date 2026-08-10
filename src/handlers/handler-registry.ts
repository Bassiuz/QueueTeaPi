import {
  toEventHandler,
  type EventHandler,
  type HandlerLike,
} from './event-handler.js'

/** Marks a registration that covers every event name in a topic. */
const WILDCARD = '*'

/** One registered handler, as reported by `describe()`. */
export interface HandlerRegistration {
  topic: string
  /** The event name, or `"*"` for a topic-wide handler. */
  eventName: string
}

/**
 * The wiring between event names and the code that runs them.
 *
 * This is the "orchestrator wiring" half of the package: publishing writes a
 * `topic` and a `name`, and the registry is what turns that pair back into a
 * function to call.
 *
 * Lookup tries the exact `topic/name` pair first, then falls back to a
 * topic-wide handler. That lets you start with one handler per topic and
 * split events out later without touching any publisher.
 */
export class HandlerRegistry {
  private readonly handlers = new Map<string, EventHandler>()

  /** Registers a handler for one specific event. */
  register<Payload, Result>(
    topic: string,
    eventName: string,
    handler: HandlerLike<Payload, Result>,
  ): this {
    this.handlers.set(keyFor(topic, eventName), toEventHandler(handler))
    return this
  }

  /** Registers a handler for every event in a topic that has no exact match. */
  registerTopic<Payload, Result>(
    topic: string,
    handler: HandlerLike<Payload, Result>,
  ): this {
    return this.register(topic, WILDCARD, handler)
  }

  /**
   * Registers many handlers at once.
   *
   * ```ts
   * registry.registerAll({
   *   'medication-agreements': {
   *     'stock-updated': onStockUpdated,
   *     'archived': onArchived,
   *   },
   * })
   * ```
   */
  registerAll(handlers: Record<string, Record<string, HandlerLike>>): this {
    for (const [topic, events] of Object.entries(handlers)) {
      for (const [eventName, handler] of Object.entries(events)) {
        this.register(topic, eventName, handler)
      }
    }
    return this
  }

  /** The handler for an event, or `undefined` if nothing is registered. */
  resolve(topic: string, eventName: string): EventHandler | undefined {
    return (
      this.handlers.get(keyFor(topic, eventName)) ??
      this.handlers.get(keyFor(topic, WILDCARD))
    )
  }

  /** Whether an event would find a handler. */
  has(topic: string, eventName: string): boolean {
    return this.resolve(topic, eventName) !== undefined
  }

  /** Forgets a registration. Returns whether there was one. */
  unregister(topic: string, eventName: string): boolean {
    return this.handlers.delete(keyFor(topic, eventName))
  }

  /** Everything registered, sorted — the dashboard's "wiring" panel. */
  describe(): HandlerRegistration[] {
    return [...this.handlers.keys()]
      .map((key) => {
        const separator = key.indexOf(SEPARATOR)
        return {
          topic: key.slice(0, separator),
          eventName: key.slice(separator + 1),
        }
      })
      .sort(
        (a, b) =>
          a.topic.localeCompare(b.topic) ||
          a.eventName.localeCompare(b.eventName),
      )
  }

  /** How many registrations exist. */
  get size(): number {
    return this.handlers.size
  }
}

/**
 * The byte that joins a topic to an event name.
 *
 * A NUL cannot appear in either half, so the key for `("a/b", "c")` can
 * never collide with the key for `("a", "b/c")`.
 */
const SEPARATOR = '\u0000'

/** Builds the map key for a topic/name pair. */
function keyFor(topic: string, eventName: string): string {
  return `${topic}${SEPARATOR}${eventName}`
}
