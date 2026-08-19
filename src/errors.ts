/** Every error this package throws inherits from `QueueTeaPiError`. */
export class QueueTeaPiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

/**
 * Throw this from a handler when retrying cannot possibly help — a malformed
 * payload, a record that has been deleted, a business rule that will never
 * pass. The event skips its remaining retry budget and goes straight to
 * `dead`, where you can inspect and replay it.
 */
export class PermanentError extends QueueTeaPiError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    if (options && 'cause' in options) this.cause = options.cause
  }
}

/** A handler ran longer than `handlerTimeoutMs` and was abandoned. */
export class HandlerTimeoutError extends QueueTeaPiError {
  constructor(
    readonly topic: string,
    readonly eventName: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Handler for "${topic}/${eventName}" did not settle within ${timeoutMs}ms.`,
    )
  }
}

/**
 * No handler was registered for an event's topic/name pair.
 *
 * This is treated as an ordinary failure rather than a permanent one: the
 * usual cause is a deploy that has not landed yet, and retrying with backoff
 * lets the event recover on its own once it has.
 */
export class UnregisteredHandlerError extends QueueTeaPiError {
  constructor(
    readonly topic: string,
    readonly eventName: string,
  ) {
    super(
      `No handler registered for "${topic}/${eventName}". ` +
        `Register one with queue.handlers.register("${topic}", "${eventName}", handler).`,
    )
  }
}

/** The options passed to QueueTeaPi cannot produce a working queue. */
export class ConfigurationError extends QueueTeaPiError {}
