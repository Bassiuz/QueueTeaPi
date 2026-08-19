import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DocumentMissingError,
  MemoryFirestore,
  PreconditionFailedError,
} from '../src/testing/index.js'

/**
 * `MemoryFirestore` is shipped, not just used internally, so it gets tested as
 * the public thing it is. The behaviour that matters most is the precondition:
 * everything QueueTeaPi does to avoid running an event twice rests on
 * `update()` failing when the document has moved on.
 */
let firestore: MemoryFirestore

beforeEach(() => {
  firestore = new MemoryFirestore()
})

const orders = () => firestore.collection('orders')

describe('documents', () => {
  it('round-trips a document', async () => {
    await orders().doc('a').set({ total: 42, name: 'first' })

    const snapshot = await orders().doc('a').get()

    expect(snapshot.exists).toBe(true)
    expect(snapshot.id).toBe('a')
    expect(snapshot.data()).toEqual({ total: 42, name: 'first' })
    expect(snapshot.updateTime).toBeDefined()
  })

  it('reports a missing document as absent, with no data', async () => {
    const snapshot = await orders().doc('nope').get()

    expect(snapshot.exists).toBe(false)
    expect(snapshot.data()).toBeUndefined()
    expect(snapshot.updateTime).toBeUndefined()
    expect(snapshot.id).toBe('nope')
  })

  it('exposes the document id on the reference', () => {
    expect(orders().doc('a').id).toBe('a')
  })

  it('hands out copies, so callers cannot mutate the store', async () => {
    await orders().doc('a').set({ nested: { count: 1 } })

    const snapshot = await orders().doc('a').get()
    const data = snapshot.data() as { nested: { count: number } }
    data.nested.count = 999

    expect(firestore.peek('orders', 'a')).toEqual({ nested: { count: 1 } })
  })

  it('deletes', async () => {
    await orders().doc('a').set({ total: 1 })
    await orders().doc('a').delete()

    expect((await orders().doc('a').get()).exists).toBe(false)
  })

  it('keeps collections separate', async () => {
    await firestore.collection('orders').doc('a').set({ kind: 'order' })
    await firestore.collection('invoices').doc('a').set({ kind: 'invoice' })

    expect(firestore.peek('orders', 'a')).toEqual({ kind: 'order' })
    expect(firestore.peek('invoices', 'a')).toEqual({ kind: 'invoice' })
  })
})

describe('write preconditions', () => {
  it('applies an update when the version still matches', async () => {
    const write = await orders().doc('a').set({ status: 'pending' })

    const result = await orders()
      .doc('a')
      .update({ status: 'leased' }, { lastUpdateTime: write.writeTime })

    expect(firestore.peek('orders', 'a')).toEqual({ status: 'leased' })
    expect(result.writeTime).not.toBe(write.writeTime)
  })

  it('merges the update into the existing document', async () => {
    await orders().doc('a').set({ status: 'pending', total: 42 })
    await orders().doc('a').update({ status: 'done' })

    expect(firestore.peek('orders', 'a')).toEqual({ status: 'done', total: 42 })
  })

  it('rejects an update against a stale version', async () => {
    const first = await orders().doc('a').set({ status: 'pending' })
    await orders().doc('a').update({ status: 'leased' })

    // `first.writeTime` is now two versions behind.
    const failure = await orders()
      .doc('a')
      .update({ status: 'done' }, { lastUpdateTime: first.writeTime })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(PreconditionFailedError)
    expect((failure as { code: number }).code).toBe(9)
    expect(firestore.peek('orders', 'a')).toEqual({ status: 'leased' })
  })

  it('applies an update with no precondition at all', async () => {
    await orders().doc('a').set({ status: 'pending' })
    await expect(
      orders().doc('a').update({ status: 'done' }),
    ).resolves.toBeDefined()
  })

  it('rejects an update to a document that is gone', async () => {
    const failure = await orders()
      .doc('missing')
      .update({ status: 'done' })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(DocumentMissingError)
    expect((failure as { code: number }).code).toBe(5)
  })

  it('gives every write a new version', async () => {
    const first = await orders().doc('a').set({ n: 1 })
    const second = await orders().doc('a').update({ n: 2 })

    expect(second.writeTime).not.toBe(first.writeTime)
  })
})

describe('queries', () => {
  beforeEach(async () => {
    await orders().doc('a').set({ status: 'pending', due: 30, name: 'alpha' })
    await orders().doc('b').set({ status: 'pending', due: 10, name: 'bravo' })
    await orders().doc('c').set({ status: 'done', due: 20, name: 'charlie' })
  })

  const ids = (docs: { id: string }[]) => docs.map((doc) => doc.id)

  it('filters on equality', async () => {
    const snapshot = await orders().where('status', '==', 'pending').get()
    expect(ids(snapshot.docs).sort()).toEqual(['a', 'b'])
  })

  it('filters on inequality', async () => {
    const snapshot = await orders().where('status', '!=', 'pending').get()
    expect(ids(snapshot.docs)).toEqual(['c'])
  })

  it.each([
    ['<', 20, ['b']],
    ['<=', 20, ['b', 'c']],
    ['>', 20, ['a']],
    ['>=', 20, ['a', 'c']],
  ] as const)('filters on %s', async (operator, value, expected) => {
    const snapshot = await orders().where('due', operator, value).get()
    expect(ids(snapshot.docs).sort()).toEqual(expected)
  })

  it('combines filters', async () => {
    const snapshot = await orders()
      .where('status', '==', 'pending')
      .where('due', '<=', 20)
      .get()

    expect(ids(snapshot.docs)).toEqual(['b'])
  })

  it('sorts ascending and descending', async () => {
    expect(ids((await orders().orderBy('due', 'asc').get()).docs)).toEqual([
      'b',
      'c',
      'a',
    ])
    expect(ids((await orders().orderBy('due', 'desc').get()).docs)).toEqual([
      'a',
      'c',
      'b',
    ])
  })

  it('defaults to ascending', async () => {
    expect(ids((await orders().orderBy('due').get()).docs)).toEqual([
      'b',
      'c',
      'a',
    ])
  })

  it('sorts strings', async () => {
    expect(ids((await orders().orderBy('name', 'desc').get()).docs)).toEqual([
      'c',
      'b',
      'a',
    ])
  })

  it('applies later sorts as tie-breakers', async () => {
    await orders().doc('d').set({ status: 'done', due: 20, name: 'delta' })

    const snapshot = await orders()
      .orderBy('due', 'asc')
      .orderBy('name', 'desc')
      .get()

    expect(ids(snapshot.docs)).toEqual(['b', 'd', 'c', 'a'])
  })

  it('limits', async () => {
    expect((await orders().orderBy('due').limit(2).get()).docs).toHaveLength(2)
  })

  it('carries the document version on every result', async () => {
    const snapshot = await orders().limit(1).get()
    expect(snapshot.docs[0]?.updateTime).toBeDefined()
    expect(snapshot.docs[0]?.exists).toBe(true)
  })

  it('counts without applying the limit', async () => {
    const snapshot = await orders()
      .where('status', '==', 'pending')
      .limit(1)
      .count()
      .get()

    expect(snapshot.data().count).toBe(2)
  })

  it('counts an empty result', async () => {
    const snapshot = await orders().where('status', '==', 'nope').count().get()
    expect(snapshot.data().count).toBe(0)
  })

  it('leaves the original query untouched when refined', async () => {
    const pending = orders().where('status', '==', 'pending')
    await pending.where('due', '<', 20).get()

    expect((await pending.get()).docs).toHaveLength(2)
  })
})

describe('ordering against null, the way Firestore does it', () => {
  beforeEach(async () => {
    await orders().doc('unset').set({ expiresAt: null })
    await orders().doc('set').set({ expiresAt: 500 })
  })

  it('treats null as lower than any number', async () => {
    const above = await orders().where('expiresAt', '>', null).get()
    expect(above.docs.map((doc) => doc.id)).toEqual(['set'])

    const below = await orders().where('expiresAt', '<', 500).get()
    expect(below.docs.map((doc) => doc.id)).toEqual(['unset'])
  })

  it('treats equal values as equal', async () => {
    const snapshot = await orders().where('expiresAt', '<=', 500).get()
    expect(snapshot.docs.map((doc) => doc.id).sort()).toEqual(['set', 'unset'])
  })

  it('treats a missing field like null', async () => {
    await orders().doc('absent').set({ somethingElse: true })

    const snapshot = await orders().where('expiresAt', '<', 500).get()
    expect(snapshot.docs.map((doc) => doc.id).sort()).toEqual([
      'absent',
      'unset',
    ])
  })
})

describe('snapshot listeners', () => {
  it('fires on attach, then on every write', async () => {
    const seen: number[] = []
    const unsubscribe = orders().onSnapshot((snapshot) => {
      seen.push(snapshot.docs.length)
    })

    expect(seen).toEqual([0])

    await orders().doc('a').set({ n: 1 })
    await orders().doc('b').set({ n: 2 })

    expect(seen).toEqual([0, 1, 2])
    unsubscribe()
  })

  it('respects the query it was attached to', async () => {
    const seen: string[][] = []
    const unsubscribe = orders()
      .where('status', '==', 'pending')
      .onSnapshot((snapshot) => {
        seen.push(snapshot.docs.map((doc) => doc.id))
      })

    await orders().doc('a').set({ status: 'pending' })
    await orders().doc('b').set({ status: 'done' })

    expect(seen).toEqual([[], ['a'], ['a']])
    unsubscribe()
  })

  it('fires on update and delete too', async () => {
    await orders().doc('a').set({ status: 'pending' })

    const seen: number[] = []
    const unsubscribe = orders().onSnapshot((snapshot) => {
      seen.push(snapshot.docs.length)
    })

    await orders().doc('a').update({ status: 'done' })
    await orders().doc('a').delete()

    expect(seen).toEqual([1, 1, 0])
    unsubscribe()
  })

  it('stops firing once unsubscribed', async () => {
    const listener = vi.fn()
    const unsubscribe = orders().onSnapshot(listener)

    unsubscribe()
    await orders().doc('a').set({ n: 1 })

    expect(listener).toHaveBeenCalledTimes(1) // the attach snapshot only
    expect(firestore.listenerCount).toBe(0)
  })

  it('accepts an error callback it never needs to call', async () => {
    const unsubscribe = orders().onSnapshot(
      () => {},
      () => {},
    )
    expect(firestore.listenerCount).toBe(1)
    unsubscribe()
  })

  it('supports several listeners at once', () => {
    const first = orders().onSnapshot(() => {})
    const second = orders().onSnapshot(() => {})

    expect(firestore.listenerCount).toBe(2)
    first()
    second()
  })
})

describe('the failure hook', () => {
  it.each([
    ['get', async () => orders().doc('a').get()],
    ['set', async () => orders().doc('a').set({})],
    ['update', async () => orders().doc('a').update({})],
    ['delete', async () => orders().doc('a').delete()],
    ['query', async () => orders().get()],
    ['count', async () => orders().count().get()],
  ] as const)('can make %s fail', async (operation, run) => {
    firestore.failWith = (attempted) => {
      if (attempted === operation) throw new Error(`${operation} is down`)
    }

    await expect(run()).rejects.toThrow(`${operation} is down`)
  })

  it('reports the path of the failing operation', async () => {
    const paths: string[] = []
    firestore.failWith = (_operation, path) => {
      paths.push(path)
    }

    await orders().doc('a').set({ n: 1 })
    await orders().get()

    expect(paths).toEqual(['orders/a', 'orders'])
  })

  it('lets everything through once cleared', async () => {
    firestore.failWith = () => {
      throw new Error('down')
    }
    firestore.failWith = undefined

    await expect(orders().doc('a').set({ n: 1 })).resolves.toBeDefined()
  })
})

describe('inspection helpers', () => {
  it('peeks at one document and lists a whole collection', async () => {
    await orders().doc('a').set({ n: 1 })
    await orders().doc('b').set({ n: 2 })
    await firestore.collection('other').doc('c').set({ n: 3 })

    expect(firestore.peek('orders', 'a')).toEqual({ n: 1 })
    expect(firestore.peek('orders', 'missing')).toBeUndefined()
    expect(firestore.all('orders')).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('seeds a document without going through a write', async () => {
    firestore.seed('orders', 'a', { status: 'dead' })

    expect((await orders().doc('a').get()).data()).toEqual({ status: 'dead' })
    expect(firestore.writes).toEqual([])
  })

  it('records every write, in order', async () => {
    await orders().doc('a').set({ n: 1 })
    await orders().doc('a').update({ n: 2 })
    await orders().doc('a').delete()

    expect(firestore.writes).toEqual([
      { path: 'orders/a', operation: 'set' },
      { path: 'orders/a', operation: 'update' },
      { path: 'orders/a', operation: 'delete' },
    ])
  })

  it('reports how many documents it holds', async () => {
    expect(firestore.size).toBe(0)

    await orders().doc('a').set({ n: 1 })
    await firestore.collection('other').doc('b').set({ n: 2 })

    expect(firestore.size).toBe(2)
  })

  it('clears everything, notifying listeners so a dispatcher keeps working', async () => {
    await orders().doc('a').set({ n: 1 })

    const seen: number[] = []
    const unsubscribe = orders().onSnapshot((snapshot) => {
      seen.push(snapshot.docs.length)
    })

    firestore.clear()

    expect(firestore.size).toBe(0)
    expect(firestore.writes).toEqual([])
    expect(seen).toEqual([1, 0])
    expect(firestore.listenerCount).toBe(1)
    unsubscribe()
  })
})
