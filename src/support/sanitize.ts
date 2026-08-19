/**
 * Firestore refuses to store `undefined` and fails the whole write with a
 * message that points at the field, not at the line that produced it. Since
 * `{ note: someOptional }` is an entirely ordinary thing to publish, we drop
 * undefined values on the way in rather than letting the queue reject the
 * event at 3am.
 *
 * Everything else is passed through untouched: `null`, dates, nested objects
 * and arrays all mean something to Firestore and are not ours to reinterpret.
 */
export function stripUndefined<Value>(value: Value): Value {
  return strip(value, new WeakSet<object>()) as Value
}

function strip(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value

  // A cycle cannot be stored in Firestore either way; leave it for Firestore
  // to reject with its own message rather than looping forever here.
  if (seen.has(value)) return value
  seen.add(value)

  if (Array.isArray(value)) {
    // Removing an element would shift every later index, so array holes
    // become `null` — the same thing `JSON.stringify` does.
    return value.map((item) => (item === undefined ? null : strip(item, seen)))
  }

  // Anything that is not a plain object (Date, Firestore GeoPoint, a class
  // instance) is meaningful as-is and must not be rebuilt.
  if (!isPlainObject(value)) return value

  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    result[key] = strip(item, seen)
  }
  return result
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
