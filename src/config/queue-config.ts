import { ConfigurationError } from '../errors.js'
import type { DeliveryMode } from '../events/queued-event.js'
import { DEFAULT_BACKOFF, type BackoffPolicy } from './backoff.js'

/** Settings that can be set globally, per topic, or per event name. */
export interface DeliverySettings {
  /** Whether `publish()` waits for the handler. Defaults to `queued`. */
  mode?: DeliveryMode
  /** Attempts before the event is dead-lettered. Defaults to `5`. */
  maxAttempts?: number
  /** Retry timing. Defaults to 10s → 600s, doubling, with 20% jitter. */
  backoff?: Partial<BackoffPolicy>
}

/** Per-topic settings, plus optional overrides for individual event names. */
export interface TopicConfig extends DeliverySettings {
  events?: Record<string, DeliverySettings>
}

/** The settings that apply to one specific event, with nothing left optional. */
export interface ResolvedDelivery {
  mode: DeliveryMode
  maxAttempts: number
  backoff: BackoffPolicy
}

/** The package defaults, applied when nothing more specific is configured. */
export const DEFAULT_DELIVERY: ResolvedDelivery = {
  mode: 'queued',
  maxAttempts: 5,
  backoff: DEFAULT_BACKOFF,
}

/** Default Firestore collection holding the ledger. */
export const DEFAULT_COLLECTION = 'queueteapi-events'

/**
 * Works out the settings for one event by layering three levels of config:
 *
 *     package defaults  ◄  your `defaults`  ◄  topic  ◄  event name
 *
 * Each level only has to state what it changes. Unknown topics are not an
 * error — they simply get the defaults, so publishing a new event never
 * requires a config change first.
 */
export function resolveDelivery(
  topic: string,
  eventName: string,
  topics: Record<string, TopicConfig> = {},
  defaults: DeliverySettings = {},
): ResolvedDelivery {
  const topicConfig = topics[topic]
  const eventConfig = topicConfig?.events?.[eventName]

  const layers = [defaults, topicConfig, eventConfig]

  let resolved: ResolvedDelivery = DEFAULT_DELIVERY

  for (const layer of layers) {
    if (!layer) continue
    resolved = {
      mode: layer.mode ?? resolved.mode,
      maxAttempts: layer.maxAttempts ?? resolved.maxAttempts,
      backoff: { ...resolved.backoff, ...layer.backoff },
    }
  }

  assertValidDelivery(topic, eventName, resolved)
  return resolved
}

function assertValidDelivery(
  topic: string,
  eventName: string,
  delivery: ResolvedDelivery,
): void {
  const where = `"${topic}/${eventName}"`

  if (!Number.isInteger(delivery.maxAttempts) || delivery.maxAttempts < 1) {
    throw new ConfigurationError(
      `maxAttempts for ${where} must be an integer of at least 1, got ${delivery.maxAttempts}.`,
    )
  }

  const { minMs, maxMs, factor, jitter } = delivery.backoff

  if (!(minMs >= 0)) {
    throw new ConfigurationError(
      `backoff.minMs for ${where} must be 0 or more, got ${minMs}.`,
    )
  }
  if (!(maxMs >= minMs)) {
    throw new ConfigurationError(
      `backoff.maxMs for ${where} must be at least backoff.minMs (${minMs}), got ${maxMs}.`,
    )
  }
  if (!(factor >= 1)) {
    throw new ConfigurationError(
      `backoff.factor for ${where} must be 1 or more, got ${factor}.`,
    )
  }
  if (!(jitter >= 0 && jitter <= 1)) {
    throw new ConfigurationError(
      `backoff.jitter for ${where} must be between 0 and 1, got ${jitter}.`,
    )
  }
}
