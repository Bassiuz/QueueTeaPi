# How two dispatchers avoid running the same event

This is the part of QueueTeaPi worth understanding properly, because the
obvious mental model is wrong in a way that costs an afternoon.

## The situation

Twenty dispatcher instances run the same query:

```ts
collection
  .where('status', '==', 'pending')
  .where('nextAttemptAt', '<=', now)
  .orderBy('nextAttemptAt', 'asc')
  .limit(capacity)
```

They all get the same documents. Exactly one of them must run each event.

The query result is only ever a **hint**. By the time any instance acts on it,
another may already have taken the event. Correctness cannot come from the
query; it has to come from the write.

## What we do

Claiming is one conditional write:

```ts
await ref.update(
  { status: 'leased', leaseOwner: instanceId, leaseExpiresAt: now + ttl, attempts: attempts + 1 },
  { lastUpdateTime: snapshot.updateTime },   // ← the whole mechanism
)
```

Firestore rejects the write with `FAILED_PRECONDITION` if the document changed
since it was read. The loser catches that, treats it as "not mine", and moves
to the next document. `src/firestore/precondition.ts` is the entire
implementation of that judgement.

Every write after the claim carries the version from the write before it. So a
dispatcher whose lease was reclaimed mid-handler cannot then write `done` over
whatever replaced it — that outcome is reported as `lost`, not as success and
not as failure.

## What we deliberately do not do

The intuitive alternative is a transaction:

```ts
await db.runTransaction(async (tx) => {
  const snap = await tx.get(ref)
  if (snap.get('status') !== 'pending') return null   // ← the actual exclusion
  tx.update(ref, lease)
})
```

This is correct, and it is worth being precise about *why* it is correct,
because it is not the reason most people assume.

Firestore does not reject B's write because `status` is "already filled" — it
never inspects field values at all. `firebase-admin` is a **server** client
library, and those use **pessimistic** concurrency: reading a document inside a
read-write transaction takes a lock on it.

```
 instance A                DomainEvents/{id}                instance B
     │                            │                             │
     │                        [pending]                         │
     │──── read (takes lock) ────►│                             │
     │                            │◄──── read — BLOCKS ─────────│
     │                            │                             ▓ waiting
     │──── commit: leased(A) ────►│                             ▓
     │                        [leased(A)]                       ▓
     │                            │────── read returns ────────►│
     │                            │                             │
     │  calls the handler         │        guard: status !== 'pending'
     │                            │        B writes nothing, takes the next doc
```

So B does not lose a race. **B queues.** And note what the lock does *not* do:
when B's read finally returns, B is perfectly free to write its own lease over
A's. Only the `if` in our own code stops it.

Two consequences follow, and both are why we use a precondition instead:

1. **Locks serialise workers that should run in parallel.** Twenty instances
   claiming from the same pending set would each wait on the one in front.
   With a precondition nobody blocks — the losers fail instantly.

2. **A worker that dies mid-transaction blocks others until Firestore times
   the transaction out** (60 seconds idle, 270 seconds maximum). With a
   precondition, a worker dying mid-claim cannot block anyone for even a
   millisecond, because there was never a lock to hold.

Nothing in this design needs two documents to move together, which is the only
thing a transaction is actually for. So there is no transaction anywhere in the
dispatcher.

## Two kinds of stuck, and only one is ours

The transaction lock and our lease look similar and behave nothing alike.
Confusing them is how a design like this ends up with events that never run and
nobody able to say why.

```
HELD BY FIRESTORE
  ┌───────────────┐
  │ transaction   │   milliseconds — released on commit, rollback, or
  │ lock          │   Firestore's own timeout. We do not use these at all.
  └───────────────┘

HELD BY A FIELD WE WROTE
        ┌─────────────────────────────────────────────┐
        │ leaseExpiresAt                              │  minutes — released by
        └─────────────────────────────────────────────┘  our settle, or by the
                                                         sweep. Firestore has
                                                         no opinion about it.
  claim ──────── leased ──────────────────────── settled
        ✕ die here                    ✕ die here
        nothing was held;             no lock exists — the event is stuck
        the event is still pending    at `leased` until the sweep reclaims it
```

| | Transaction lock | Our lease |
| --- | --- | --- |
| Held by | Firestore | a field in the document |
| Lasts | milliseconds | minutes |
| Worker dies | Firestore frees it | **only the sweep frees it** |
| Used here | no | yes |

**This is why the sweep is not optional.** A dispatcher killed after claiming an
event leaves a document that nothing else will ever move. `sweepOnce()` finds
leases where `leaseExpiresAt <= now` and returns them to `pending`.

It is also why `handlerTimeoutMs` must be strictly less than `leaseTtlMs` — the
constructor refuses the combination. If a handler could outlive its lease, the
sweep would hand the event to a second worker while the first was still running
it, turning at-least-once into concurrent-duplicate.

## What this means for your handlers

Delivery is **at-least-once**, exactly as with a message broker. An event can
run twice if a worker dies after doing the work but before recording it, or if
a lease lapses under a slow handler.

Handlers must therefore be idempotent. That is not a new requirement this
design introduces — it is the same one Pub/Sub already imposed.

## Where to look in the code

| File | What it holds |
| --- | --- |
| `src/events/event-store.ts` | Every read and write, and the `patch()` helper that makes writes conditional |
| `src/firestore/precondition.ts` | Deciding which errors mean "lost the race" |
| `src/dispatch/dispatcher.ts` | Claiming, the worker pool, and the sweep |
| `src/dispatch/event-runner.ts` | Running one claimed event and settling it |
| `test/event-store.test.ts` | The contention cases, against an in-memory Firestore that enforces preconditions |
