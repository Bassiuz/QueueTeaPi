import { PermanentError, QueueTeaPiError } from '../errors.js'
import type { QueuedEvent } from '../events/queued-event.js'
import type { EventHandler } from './event-handler.js'

/** The body a Pub/Sub push subscription POSTs to its endpoint. */
export interface PubSubPushEnvelope {
  message: {
    data: string
    attributes: Record<string, string>
    messageId: string
    publishTime: string
  }
  subscription: string
}

/** Builds the `message.data` payload before it is base64-encoded. */
export type MessageEncoder = (event: QueuedEvent) => unknown

/**
 * The default body: the parts of the event that describe *what happened*,
 * without the queue bookkeeping. Override it with `encodeMessage` if your
 * existing handlers expect a different shape.
 */
export const defaultMessageEncoder: MessageEncoder = (event) => ({
  eventId: event.id,
  topic: event.topic,
  name: event.name,
  payload: event.payload,
  actor: event.actor,
  orderKey: event.orderKey,
})

/**
 * Wraps an event in the exact envelope a Pub/Sub push subscription sends, so
 * an endpoint written for Pub/Sub cannot tell which transport delivered it.
 */
export function toPubSubEnvelope(
  event: QueuedEvent,
  encodeMessage: MessageEncoder = defaultMessageEncoder,
): PubSubPushEnvelope {
  const attributes: Record<string, string> = {
    eventId: event.id,
    topic: event.topic,
    name: event.name,
    attempts: String(event.attempts),
    ...(event.orderKey === null ? {} : { orderKey: event.orderKey }),
    ...(event.trace ?? {}),
  }

  return {
    message: {
      data: Buffer.from(JSON.stringify(encodeMessage(event))).toString('base64'),
      attributes,
      messageId: event.id,
      publishTime: new Date(event.createdAt).toISOString(),
    },
    subscription: `queueteapi/${event.topic}`,
  }
}

/** A non-2xx response from the endpoint. */
export class HttpHandlerError extends QueueTeaPiError {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`POST ${url} responded ${status}: ${truncate(body, 500)}`)
  }
}

/** The same, for statuses that retrying will never fix. */
export class PermanentHttpHandlerError extends PermanentError {
  constructor(
    readonly url: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`POST ${url} responded ${status}: ${truncate(body, 500)}`)
  }
}

export interface HttpEventHandlerOptions {
  /** The endpoint to POST to. */
  url: string
  /**
   * Supplies the `Authorization` header value, typically an OIDC identity
   * token minted for `url`. Return `null` for an unauthenticated endpoint.
   */
  getAuthorization?: (url: string) => Promise<string | null> | string | null
  /** Extra headers sent with every request. */
  headers?: Record<string, string>
  /** Overrides the message body shape. */
  encodeMessage?: MessageEncoder
  /** Injectable for tests; defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch
}

/**
 * A handler that forwards events to an HTTP endpoint.
 *
 * This is the migration path off Pub/Sub: point it at the same private
 * function URL your push subscription used, with the same OIDC token, and the
 * receiving code needs no change at all.
 *
 * Failure is classified the way a queue should classify it — 5xx and 429 are
 * worth retrying, other 4xx responses are the endpoint telling you the
 * request itself is wrong, so those go straight to `dead`.
 */
export class HttpEventHandler implements EventHandler<unknown, unknown> {
  private readonly options: HttpEventHandlerOptions

  constructor(options: HttpEventHandlerOptions) {
    this.options = options
  }

  async handle(event: QueuedEvent): Promise<unknown> {
    const { url } = this.options
    const doFetch = this.options.fetch ?? globalThis.fetch

    const authorization = await this.options.getAuthorization?.(url)

    const response = await doFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...this.options.headers,
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(toPubSubEnvelope(event, this.options.encodeMessage)),
    })

    const body = await response.text()

    if (!response.ok) {
      throw isRetryableStatus(response.status)
        ? new HttpHandlerError(url, response.status, body)
        : new PermanentHttpHandlerError(url, response.status, body)
    }

    return parseJsonOrText(body)
  }
}

/**
 * 5xx means the endpoint is having a bad time; 408 and 429 are explicit
 * "try again" signals. Every other 4xx is a complaint about the request.
 */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}

function parseJsonOrText(body: string): unknown {
  if (body.length === 0) return null
  try {
    return JSON.parse(body)
  } catch {
    return body
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}
