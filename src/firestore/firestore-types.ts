/**
 * The slice of the Firestore API that QueueTeaPi actually uses.
 *
 * These interfaces are written structurally so that a real
 * `firebase-admin` Firestore instance satisfies them without any casting,
 * while tests (and anyone building an adapter) can supply a stand-in.
 * That is also why `firebase-admin` is an *optional* peer dependency:
 * this package never imports it.
 */

/** A Firestore query comparison operator. */
export type WhereOperator = '==' | '!=' | '<' | '<=' | '>' | '>='

/** Sort direction for `orderBy`. */
export type OrderDirection = 'asc' | 'desc'

/**
 * An opaque document version, as produced by Firestore's `updateTime` /
 * `writeTime`. We never inspect it — we only hand it back to Firestore as a
 * write precondition, which is how two dispatchers avoid running the same
 * event. See `docs/concurrency.md`.
 */
export type DocumentVersion = unknown

/** Cancels a snapshot listener. */
export type Unsubscribe = () => void

export interface DocumentSnapshotLike {
  readonly id: string
  readonly exists: boolean
  /** Firestore's `updateTime`; `undefined` for a document that does not exist. */
  readonly updateTime?: DocumentVersion
  data(): Record<string, unknown> | undefined
}

export interface QuerySnapshotLike {
  readonly docs: DocumentSnapshotLike[]
}

export interface AggregateSnapshotLike {
  data(): { count: number }
}

export interface AggregateQueryLike {
  get(): Promise<AggregateSnapshotLike>
}

export interface WriteResultLike {
  /** The document's `updateTime` after this write. */
  readonly writeTime: DocumentVersion
}

/** Firestore's write precondition — the whole basis of our locking strategy. */
export interface PreconditionLike {
  lastUpdateTime?: DocumentVersion
  exists?: boolean
}

export interface QueryLike {
  where(field: string, operator: WhereOperator, value: unknown): QueryLike
  orderBy(field: string, direction?: OrderDirection): QueryLike
  limit(count: number): QueryLike
  get(): Promise<QuerySnapshotLike>
  count(): AggregateQueryLike
  onSnapshot(
    onNext: (snapshot: QuerySnapshotLike) => void,
    onError?: (error: Error) => void,
  ): Unsubscribe
}

export interface DocumentReferenceLike {
  readonly id: string
  get(): Promise<DocumentSnapshotLike>
  set(data: Record<string, unknown>): Promise<WriteResultLike>
  update(
    data: Record<string, unknown>,
    precondition?: PreconditionLike,
  ): Promise<WriteResultLike>
  delete(): Promise<WriteResultLike>
}

export interface CollectionReferenceLike extends QueryLike {
  doc(documentId: string): DocumentReferenceLike
}

export interface FirestoreLike {
  collection(collectionPath: string): CollectionReferenceLike
}
