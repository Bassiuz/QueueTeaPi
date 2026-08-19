/**
 * Runs `task` over every item, with at most `limit` of them in flight.
 *
 * This is the concurrency dial for the dispatcher: it is what stops a
 * ten-thousand-event backfill from opening ten thousand simultaneous calls to
 * your handlers.
 *
 * Results come back in the same order as `items`. `task` is expected to
 * absorb its own failures — a rejection here rejects the whole batch.
 */
export async function mapWithConcurrency<Item, Result>(
  items: readonly Item[],
  limit: number,
  task: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const results = new Array<Result>(items.length)
  if (items.length === 0) return results

  const workerCount = Math.max(1, Math.min(limit, items.length))
  let nextIndex = 0

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await task(items[index] as Item, index)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}

/** What `withTimeout` throws with when the deadline passes. */
export type TimeoutFactory = () => Error

/**
 * Rejects with `createError()` if `operation` has not settled within `ms`.
 *
 * The underlying promise is *abandoned*, not cancelled — JavaScript has no
 * way to stop work that is already running. That is exactly why the lease
 * outlives the handler timeout: a handler that ignores its deadline must
 * still finish before another dispatcher is allowed to take the event.
 */
export async function withTimeout<Result>(
  operation: Promise<Result>,
  ms: number,
  createError: TimeoutFactory,
): Promise<Result> {
  if (!Number.isFinite(ms) || ms <= 0) return operation

  let timer: ReturnType<typeof setTimeout> | undefined

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(createError()), ms)
    // Never hold the process open just because a deadline is pending.
    timer.unref?.()
  })

  try {
    return await Promise.race([operation, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Resolves after `ms`, without keeping the event loop alive. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
