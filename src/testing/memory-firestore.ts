import type {
  AggregateQueryLike,
  CollectionReferenceLike,
  DocumentReferenceLike,
  DocumentSnapshotLike,
  FirestoreLike,
  OrderDirection,
  PreconditionLike,
  QueryLike,
  QuerySnapshotLike,
  Unsubscribe,
  WhereOperator,
  WriteResultLike,
} from '../firestore/firestore-types.js'

/**
 * An in-memory Firestore, for tests and for running an app with no cloud
 * project at all.
 *
 * ```ts
 * import { QueueTeaPi } from 'queueteapi'
 * import { MemoryFirestore } from 'queueteapi/testing'
 *
 * const queue = new QueueTeaPi({ firestore: new MemoryFirestore() })
 * ```
 *
 * It implements exactly the behaviour QueueTeaPi relies on — including the one
 * the whole design rests on: `update()` with a `lastUpdateTime` precondition
 * fails when the document has changed since it was read. Contention, lost
 * claims and lease recovery therefore behave here the way they behave in
 * production.
 *
 * Document versions are a monotonically increasing counter rather than a
 * timestamp, which is easier to reason about and closer to what the
 * precondition actually means: "the same revision I read".
 *
 * It is **not** a general-purpose Firestore emulator. It supports the query
 * shapes this package issues — equality and range filters, `orderBy`, `limit`,
 * `count()` and `onSnapshot` — and nothing more. For anything else, reach for
 * the real Firestore emulator.
 *
 * Everything is lost when the process exits.
 */

/** The error a real Firestore raises when a precondition does not hold. */
export class PreconditionFailedError extends Error {
  readonly code = 9

  constructor(path: string) {
    super(`Document "${path}" has changed since it was read.`)
    this.name = 'PreconditionFailedError'
  }
}

/** The error a real Firestore raises when updating a missing document. */
export class DocumentMissingError extends Error {
  readonly code = 5

  constructor(path: string) {
    super(`No document to update: ${path}`)
    this.name = 'DocumentMissingError'
  }
}

interface StoredDocument {
  data: Record<string, unknown>
  version: number
}

interface Filter {
  field: string
  operator: WhereOperator
  value: unknown
}

interface Sort {
  field: string
  direction: OrderDirection
}

interface QueryState {
  filters: Filter[]
  sorts: Sort[]
  limit: number | undefined
}

/** Lets a test make a specific call fail, to cover the unhappy paths. */
export type FailureHook = (
  operation: 'get' | 'set' | 'update' | 'delete' | 'query' | 'count',
  path: string,
) => void

export class MemoryFirestore implements FirestoreLike {
  private readonly documents = new Map<string, StoredDocument>()
  private readonly listeners = new Set<() => void>()
  private nextVersion = 1

  /** Set this to make operations throw; useful for error-path tests. */
  failWith: FailureHook | undefined

  /** Every write attempted, in order. Handy for asserting on call counts. */
  readonly writes: Array<{ path: string; operation: string }> = []

  collection(collectionPath: string): CollectionReferenceLike {
    return new MemoryCollectionReference(this, collectionPath)
  }

  // ── inspection helpers for tests ────────────────────────────────────────

  /** The raw stored body of a document, or `undefined`. */
  peek(collectionPath: string, id: string): Record<string, unknown> | undefined {
    return this.documents.get(`${collectionPath}/${id}`)?.data
  }

  /** Every document in a collection, as stored. */
  all(collectionPath: string): Record<string, unknown>[] {
    return [...this.documents.entries()]
      .filter(([key]) => key.startsWith(`${collectionPath}/`))
      .map(([, stored]) => stored.data)
  }

  /** How many snapshot listeners are currently attached. */
  get listenerCount(): number {
    return this.listeners.size
  }

  /** How many documents are stored, across every collection. */
  get size(): number {
    return this.documents.size
  }

  /**
   * Empties the store.
   *
   * Listeners stay attached and are notified, so a dispatcher watching this
   * instance keeps working against the now-empty collection.
   */
  clear(): void {
    this.documents.clear()
    this.writes.length = 0
    this.notify()
  }

  /** Writes a document directly, bypassing preconditions. */
  seed(collectionPath: string, id: string, data: Record<string, unknown>): void {
    this.documents.set(`${collectionPath}/${id}`, {
      data: clone(data),
      version: this.nextVersion++,
    })
  }

  // ── internals used by the reference classes ─────────────────────────────

  private guard(operation: Parameters<FailureHook>[0], path: string): void {
    this.failWith?.(operation, path)
  }

  read(path: string): DocumentSnapshotLike {
    this.guard('get', path)
    const stored = this.documents.get(path)
    const id = path.slice(path.lastIndexOf('/') + 1)

    if (stored === undefined) {
      return { id, exists: false, updateTime: undefined, data: () => undefined }
    }
    return {
      id,
      exists: true,
      updateTime: stored.version,
      data: () => clone(stored.data),
    }
  }

  write(path: string, data: Record<string, unknown>): WriteResultLike {
    this.guard('set', path)
    this.writes.push({ path, operation: 'set' })

    const version = this.nextVersion++
    this.documents.set(path, { data: clone(data), version })
    this.notify()
    return { writeTime: version }
  }

  patch(
    path: string,
    changes: Record<string, unknown>,
    precondition: PreconditionLike | undefined,
  ): WriteResultLike {
    this.guard('update', path)
    this.writes.push({ path, operation: 'update' })

    const stored = this.documents.get(path)
    if (stored === undefined) throw new DocumentMissingError(path)

    if (
      precondition?.lastUpdateTime !== undefined &&
      precondition.lastUpdateTime !== stored.version
    ) {
      throw new PreconditionFailedError(path)
    }

    const version = this.nextVersion++
    this.documents.set(path, {
      data: { ...stored.data, ...clone(changes) },
      version,
    })
    this.notify()
    return { writeTime: version }
  }

  remove(path: string): WriteResultLike {
    this.guard('delete', path)
    this.writes.push({ path, operation: 'delete' })
    this.documents.delete(path)
    this.notify()
    return { writeTime: this.nextVersion++ }
  }

  runQuery(collectionPath: string, state: QueryState): QuerySnapshotLike {
    this.guard('query', collectionPath)

    const matches = [...this.documents.entries()]
      .filter(([key]) => key.startsWith(`${collectionPath}/`))
      .filter(([, stored]) =>
        state.filters.every((filter) => matchesFilter(stored.data, filter)),
      )
      .map(([key, stored]) => ({ key, stored }))

    for (const sort of [...state.sorts].reverse()) {
      matches.sort((a, b) => {
        const order = compare(a.stored.data[sort.field], b.stored.data[sort.field])
        return sort.direction === 'desc' ? -order : order
      })
    }

    const limited =
      state.limit === undefined ? matches : matches.slice(0, state.limit)

    return {
      docs: limited.map(({ key, stored }) => ({
        id: key.slice(key.lastIndexOf('/') + 1),
        exists: true,
        updateTime: stored.version,
        data: () => clone(stored.data),
      })),
    }
  }

  countQuery(collectionPath: string, state: QueryState): number {
    this.guard('count', collectionPath)
    return this.runQuery(collectionPath, { ...state, limit: undefined }).docs
      .length
  }

  listen(notify: () => void): Unsubscribe {
    this.listeners.add(notify)
    // Firestore delivers an initial snapshot as soon as a listener attaches.
    notify()
    return () => {
      this.listeners.delete(notify)
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

class MemoryQuery implements QueryLike {
  constructor(
    protected readonly firestore: MemoryFirestore,
    protected readonly collectionPath: string,
    protected readonly state: QueryState = {
      filters: [],
      sorts: [],
      limit: undefined,
    },
  ) {}

  where(field: string, operator: WhereOperator, value: unknown): QueryLike {
    return new MemoryQuery(this.firestore, this.collectionPath, {
      ...this.state,
      filters: [...this.state.filters, { field, operator, value }],
    })
  }

  orderBy(field: string, direction: OrderDirection = 'asc'): QueryLike {
    return new MemoryQuery(this.firestore, this.collectionPath, {
      ...this.state,
      sorts: [...this.state.sorts, { field, direction }],
    })
  }

  limit(count: number): QueryLike {
    return new MemoryQuery(this.firestore, this.collectionPath, {
      ...this.state,
      limit: count,
    })
  }

  async get(): Promise<QuerySnapshotLike> {
    return this.firestore.runQuery(this.collectionPath, this.state)
  }

  count(): AggregateQueryLike {
    const { firestore, collectionPath, state } = this
    return {
      async get() {
        const count = firestore.countQuery(collectionPath, state)
        return { data: () => ({ count }) }
      },
    }
  }

  onSnapshot(
    onNext: (snapshot: QuerySnapshotLike) => void,
    _onError?: (error: Error) => void,
  ): Unsubscribe {
    return this.firestore.listen(() => {
      onNext(this.firestore.runQuery(this.collectionPath, this.state))
    })
  }
}

class MemoryCollectionReference
  extends MemoryQuery
  implements CollectionReferenceLike
{
  doc(documentId: string): DocumentReferenceLike {
    return new MemoryDocumentReference(
      this.firestore,
      `${this.collectionPath}/${documentId}`,
      documentId,
    )
  }
}

class MemoryDocumentReference implements DocumentReferenceLike {
  constructor(
    private readonly firestore: MemoryFirestore,
    private readonly path: string,
    readonly id: string,
  ) {}

  async get(): Promise<DocumentSnapshotLike> {
    return this.firestore.read(this.path)
  }

  async set(data: Record<string, unknown>): Promise<WriteResultLike> {
    return this.firestore.write(this.path, data)
  }

  async update(
    data: Record<string, unknown>,
    precondition?: PreconditionLike,
  ): Promise<WriteResultLike> {
    return this.firestore.patch(this.path, data, precondition)
  }

  async delete(): Promise<WriteResultLike> {
    return this.firestore.remove(this.path)
  }
}

function matchesFilter(
  data: Record<string, unknown>,
  filter: Filter,
): boolean {
  const actual = data[filter.field]

  switch (filter.operator) {
    case '==':
      return actual === filter.value
    case '!=':
      return actual !== filter.value
    case '<':
      return compare(actual, filter.value) < 0
    case '<=':
      return compare(actual, filter.value) <= 0
    case '>':
      return compare(actual, filter.value) > 0
    default:
      return compare(actual, filter.value) >= 0
  }
}

/**
 * Firestore orders null before numbers before strings. Only the cases the
 * queue actually sorts on are implemented.
 */
function compare(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return -1
  if (b === null || b === undefined) return 1
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

function clone<Value>(value: Value): Value {
  return structuredClone(value)
}
