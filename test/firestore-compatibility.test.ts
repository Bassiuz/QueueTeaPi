import type { Firestore } from 'firebase-admin/firestore'
import { describe, expect, it } from 'vitest'

import type { FirestoreLike } from '../src/firestore/firestore-types.js'
import { QueueTeaPi } from '../src/queue-tea-pi.js'
import { MemoryFirestore } from '../src/testing/memory-firestore.js'

/**
 * The point of this file is the *types*, not the assertions.
 *
 * QueueTeaPi describes Firestore structurally instead of importing
 * `firebase-admin`, which keeps the dependency optional. That only holds up if
 * a real `Firestore` genuinely satisfies `FirestoreLike` — so the compiler
 * checks it here. If someone narrows `FirestoreLike` in a way that would force
 * users to write `as unknown as`, this file stops compiling.
 */
describe('firebase-admin compatibility', () => {
  it('a real Firestore satisfies FirestoreLike, with no cast', () => {
    const accepts = (firestore: Firestore): FirestoreLike => firestore
    expect(typeof accepts).toBe('function')
  })

  it('a real Firestore can be handed straight to the constructor', () => {
    const build = (firestore: Firestore) => new QueueTeaPi({ firestore })
    expect(typeof build).toBe('function')
  })

  it('the in-memory double satisfies the same interface', () => {
    const accepts = (firestore: FirestoreLike): FirestoreLike => firestore
    expect(accepts(new MemoryFirestore())).toBeInstanceOf(MemoryFirestore)
  })
})
