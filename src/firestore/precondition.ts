/**
 * Recognising "someone else changed this document first".
 *
 * QueueTeaPi claims an event with a single conditional write:
 *
 *     ref.update(lease, { lastUpdateTime: snapshot.updateTime })
 *
 * Firestore rejects that write if the document changed since we read it.
 * The rejection is not an outage — it is the normal, expected outcome for
 * every dispatcher that was a few milliseconds too slow. This module turns
 * those particular errors into a boolean so the caller can simply move on to
 * the next event.
 */

/** gRPC status code for a failed write precondition. */
const FAILED_PRECONDITION = 9

/** gRPC status code for a document that no longer exists. */
const NOT_FOUND = 5

/** gRPC status code for a transaction/write that Firestore gave up on. */
const ABORTED = 10

const LOST_CLAIM_CODES = new Set<number>([FAILED_PRECONDITION, NOT_FOUND, ABORTED])

/**
 * True when `error` means "the document moved on without us".
 *
 * Anything else — permission denied, network failure, quota — is a real
 * problem and must keep propagating.
 */
export function isLostClaimError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false

  const code = (error as { code?: unknown }).code

  if (typeof code === 'number') return LOST_CLAIM_CODES.has(code)

  // Some Firestore transports report the status by name instead of number.
  if (typeof code === 'string') {
    const normalised = code.toUpperCase()
    return (
      normalised === 'FAILED_PRECONDITION' ||
      normalised === 'NOT_FOUND' ||
      normalised === 'ABORTED'
    )
  }

  return false
}
