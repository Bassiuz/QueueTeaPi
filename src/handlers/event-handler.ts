import type { QueuedEvent } from '../events/queued-event.js'

/**
 * The one thing you write yourself.
 *
 * A handler receives the whole event — payload, actor, attempt count and all
 * — and either returns (success) or throws (failure). Returning a value is
 * optional; with `mode: 'inline'` it is handed back to whoever published.
 *
 * Handlers must be **idempotent**. Delivery is at-least-once: a worker that
 * dies after doing the work but before recording it will have the event run
 * again, exactly as a message broker would.
 */
export interface EventHandler<Payload = any, Result = any> {
  handle(event: QueuedEvent<Payload>): Promise<Result> | Result
}

/** A handler written as a plain function, for when a class is overkill. */
export type HandlerFunction<Payload = any, Result = any> = (
  event: QueuedEvent<Payload>,
) => Promise<Result> | Result

/** Either form is accepted everywhere a handler is expected. */
export type HandlerLike<Payload = any, Result = any> =
  | EventHandler<Payload, Result>
  | HandlerFunction<Payload, Result>

/** Normalises the function form into the object form. */
export function toEventHandler<Payload, Result>(
  handler: HandlerLike<Payload, Result>,
): EventHandler<Payload, Result> {
  return typeof handler === 'function' ? { handle: handler } : handler
}
