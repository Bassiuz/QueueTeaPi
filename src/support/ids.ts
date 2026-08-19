import { randomUUID } from 'node:crypto'

/** Produces a fresh, unique identifier. */
export type IdGenerator = () => string

/** Document ids for events. Random, so writes spread across index ranges. */
export const randomEventId: IdGenerator = () => randomUUID()

/**
 * A human-readable name for one dispatcher process, used as the lease owner.
 *
 * It only has to be unique among live dispatchers; it shows up in the
 * dashboard and in logs, so the readable prefix earns its keep.
 */
export function createInstanceId(
  prefix = 'dispatcher',
  generateId: IdGenerator = randomUUID,
): string {
  return `${prefix}-${generateId().slice(0, 8)}`
}
