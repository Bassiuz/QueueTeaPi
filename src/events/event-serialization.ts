import { stripUndefined } from '../support/sanitize.js'
import {
  EVENT_STATUSES,
  type DeliveryMode,
  type EventActor,
  type EventError,
  type EventStatus,
  type QueuedEvent,
} from './queued-event.js'

/**
 * Translating between a `QueuedEvent` and the plain object Firestore stores.
 *
 * Reading is deliberately forgiving. Documents in this collection get
 * hand-edited during incidents — replaying a dead event is literally "set
 * status back to pending" — and a typo there should not crash a dispatcher.
 * Anything missing or the wrong shape falls back to a safe default.
 */

/** Converts an event into the document body Firestore will store. */
export function toDocument(event: QueuedEvent): Record<string, unknown> {
  const { id: _id, ...fields } = event
  return stripUndefined({ ...fields }) as Record<string, unknown>
}

/** Rebuilds an event from its Firestore document. */
export function fromDocument(
  id: string,
  data: Record<string, unknown> | undefined,
): QueuedEvent {
  const source = data ?? {}

  return {
    id,
    topic: readString(source.topic, ''),
    name: readString(source.name, ''),
    payload: source.payload ?? null,
    actor: readObject<EventActor>(source.actor),
    orderKey: readNullableString(source.orderKey),
    trace: readObject<Record<string, string>>(source.trace),

    mode: readMode(source.mode),
    status: readStatus(source.status),
    attempts: readNumber(source.attempts, 0),
    maxAttempts: readNumber(source.maxAttempts, 1),
    nextAttemptAt: readNumber(source.nextAttemptAt, 0),
    leaseOwner: readNullableString(source.leaseOwner),
    leaseExpiresAt: readNullableNumber(source.leaseExpiresAt),

    result: source.result ?? null,
    lastError: readError(source.lastError),

    createdAt: readNumber(source.createdAt, 0),
    updatedAt: readNumber(source.updatedAt, 0),
    startedAt: readNullableNumber(source.startedAt),
    finishedAt: readNullableNumber(source.finishedAt),
  }
}

/** Captures whatever a handler threw in a form Firestore can store. */
export function describeError(
  error: unknown,
  at: number,
  permanent: boolean,
): EventError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack ?? null,
      permanent,
      at,
    }
  }

  return {
    name: 'NonError',
    message: safeStringify(error),
    stack: null,
    permanent,
    at,
  }
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

// ── field readers ─────────────────────────────────────────────────────────

function readString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function readNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readObject<Shape>(value: unknown): Shape | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  return value as Shape
}

function readMode(value: unknown): DeliveryMode {
  return value === 'inline' ? 'inline' : 'queued'
}

function readStatus(value: unknown): EventStatus {
  return EVENT_STATUSES.includes(value as EventStatus)
    ? (value as EventStatus)
    : 'pending'
}

function readError(value: unknown): EventError | null {
  const source = readObject<Record<string, unknown>>(value)
  if (source === null) return null

  return {
    name: readString(source.name, 'Error'),
    message: readString(source.message, ''),
    stack: readNullableString(source.stack),
    permanent: source.permanent === true,
    at: readNumber(source.at, 0),
  }
}
