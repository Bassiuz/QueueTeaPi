# QueueTeaPi

A durable event queue whose entire backing store is **one Firestore collection**.
That collection is the queue, the dead-letter queue and the audit log at the
same time — so "what happened to that event?" is a document you can open, not a
support ticket.

```ts
import { QueueTeaPi } from 'queueteapi'
import { getFirestore } from 'firebase-admin/firestore'

const queue = new QueueTeaPi({ firestore: getFirestore() })

queue.handlers.register('orders', 'placed', async (event) => {
  await chargeCard(event.payload)
})

await queue.publish({ topic: 'orders', name: 'placed', payload: order })

queue.createDispatcher().start()
```

That is the whole API surface most applications ever touch: **publish** puts
events in, **handlers** says what runs them, **dispatcher** moves them.

## Try it in thirty seconds

```bash
git clone https://github.com/Bassiuz/QueueTeaPi && cd QueueTeaPi/example
npm install && npm start
```

Opens a tea room at http://localhost:4000 where you order teas (200ms), pies
(1s) and showstoppers (1.5s, and they fail half the time), inline or a hundred
at a time, and watch the queue drain — with the dashboard mounted at `/queue`.
No cloud project, no emulator, no credentials. See [`example/`](./example).

---

## Contents

- [Why](#why)
- [Install](#install)
- [The three seams](#the-three-seams)
- [Delivery modes](#delivery-modes)
- [Configuration](#configuration)
- [Running the dispatcher](#running-the-dispatcher)
- [Failure, retries and the dead-letter queue](#failure-retries-and-the-dead-letter-queue)
- [Dev tools](#dev-tools)
- [Firestore indexes](#firestore-indexes)
- [The event document](#the-event-document)
- [Concurrency: why there are no transactions](#concurrency-why-there-are-no-transactions)
- [Ordering is not provided](#ordering-is-not-provided)
- [Migrating from Pub/Sub](#migrating-from-pubsub)
- [The example app](#the-example-app)
- [Testing your handlers](#testing-your-handlers)
- [Test coverage](#test-coverage)
- [API reference](#api-reference)

---

## Why

A managed message broker gives you delivery and takes away visibility. You get
a topic, a subscription, a dead-letter topic, a retry policy and a metrics
dashboard that can tell you a message failed but not *what it was* or *why*.

QueueTeaPi keeps every event as a document you already know how to read:

|                              | Message broker            | QueueTeaPi                        |
| ---------------------------- | ------------------------- | --------------------------------- |
| Where is my event now?       | Not addressable           | `collection.doc(id)`              |
| Why did it fail?             | Gone, unless you logged it| `lastError` on the document       |
| What did it return?          | Discarded                 | `result` on the document          |
| Replay a dead letter         | Console surgery           | One field back to `pending`       |
| Infrastructure per event type| Topic, DLQ, subscription… | Nothing — it is a row             |
| Local development            | Emulator or a real topic  | The Firestore you already run     |

The trade is real and worth stating: Firestore joins your publish path, and
this is a queue, not a log — see
[Ordering is not provided](#ordering-is-not-provided).

---

## Install

```bash
npm install queueteapi firebase-admin
```

`firebase-admin` is an **optional peer dependency**. The library itself never
imports it — it describes the bits of Firestore it uses structurally — so you
can supply any compatible instance, and tests need no emulator. You will want
the real thing in production, and the CLI requires it.

Node 18 or newer.

---

## The three seams

### 1. Publish

```ts
const { id } = await queue.publish({
  topic: 'orders',
  name: 'placed',
  payload: { orderId, total },
  actor: { id: userId, type: 'customer' },   // optional
  orderKey: orderId,                          // optional, for tracing
  trace: { 'sentry-trace': span.toTraceparent() }, // optional
})
```

`topic` and `name` are how the event finds its handler. Everything else is
yours. `undefined` values are stripped on the way in, because Firestore rejects
them and `{ note: maybeUndefined }` is an entirely ordinary thing to publish.

### 2. Handlers

A handler is anything with a `handle` method, or just a function:

```ts
queue.handlers.register('orders', 'placed', async (event) => {
  await chargeCard(event.payload)
  return { charged: true }        // stored on the event; returned by inline mode
})

// One handler for every event in a topic:
queue.handlers.registerTopic('audit', auditHandler)

// Or a whole map at once:
queue.handlers.registerAll({
  orders: { placed: onPlaced, shipped: onShipped },
  invoices: { issued: onIssued },
})
```

Lookup tries the exact `topic/name` pair first, then the topic-wide handler.
That lets you start with one handler per topic and split events out later
without touching a single publisher.

Handlers must be **idempotent**. Delivery is at-least-once — the same guarantee
a message broker gives you.

### 3. Dispatcher

```ts
const dispatcher = queue.createDispatcher({ poolSize: 20 })
dispatcher.start()

process.on('SIGTERM', () => void dispatcher.stop())  // waits for in-flight work
```

See [Running the dispatcher](#running-the-dispatcher) for the deployment
choices.

---

## Delivery modes

Both modes write the same document and run the same handler. The only
difference is whether `publish()` waits.

```
queued   publish ──► [ document ] ····· later ····► dispatcher ──► handler
                         │
                         └──► returns immediately, with an event id

inline   publish ──► [ document ] ──────────────────────────────► handler
                                                                     │
                     returns the handler's value ◄──────────────────┘
```

```ts
// Queued (the default): returns as soon as the write lands.
const { id } = await queue.publish({ topic: 'orders', name: 'placed' })

// Inline: runs the handler now and hands back its return value.
const { result } = await queue.publish({
  topic: 'orders',
  name: 'placed',
  mode: 'inline',
})
```

Use **inline** when a user is waiting on the outcome, and **queued** for
everything else.

An inline handler that throws rethrows to the caller **and** leaves the event
recorded — retried or dead-lettered by the normal policy. An inline failure is
never a lost event.

Delayed delivery is queued-only, since inline runs during `publish()`:

```ts
await queue.publish({ topic: 'orders', name: 'reminder', delayMs: 60_000 })
await queue.publish({ topic: 'orders', name: 'reminder', availableAt: someEpochMs })
```

---

## Configuration

Everything is optional except `firestore`.

```ts
const queue = new QueueTeaPi({
  // Which Firestore, and which collection in it. This is the "target".
  firestore: getFirestore(app, 'events-db'),   // any project or named database
  collection: 'system/queue/events',            // nested paths are fine

  // Applied to any topic that does not override them.
  defaults: {
    mode: 'queued',
    maxAttempts: 5,
    backoff: { minMs: 10_000, maxMs: 600_000, factor: 2, jitter: 0.2 },
  },

  // Per topic, and per event name within a topic.
  topics: {
    'medication-agreements': {
      mode: 'queued',
      events: {
        'stock-updated': { mode: 'inline' },        // a user waits on this one
        'archived': { maxAttempts: 10 },
      },
    },
  },

  handlerTimeoutMs: 60_000,
  logger: consoleLogger,      // silent by default
})
```

Settings resolve in layers, each stating only what it changes:

```
package defaults  ◄  your `defaults`  ◄  topic  ◄  event name
```

An unconfigured topic is not an error — it gets the defaults. Publishing a new
event never requires a config change first.

### Choosing the target collection

The collection is where the queue lives, and it is chosen twice over: the
`firestore` instance picks the project and database, `collection` picks the
path within it.

```ts
// A named database, dedicated to events
new QueueTeaPi({ firestore: getFirestore(app, 'events-db') })

// Out of the way of your domain collections
new QueueTeaPi({ firestore: getFirestore(), collection: 'system/queue/events' })

// Separate queues that share one database
const emails = new QueueTeaPi({ firestore, collection: 'queues/email/events' })
const exports = new QueueTeaPi({ firestore, collection: 'queues/export/events' })
```

Two queues on two collections are fully independent: separate dispatchers,
separate dashboards, separate backlogs.

---

## Running the dispatcher

### Long-running service

```ts
const dispatcher = queue.createDispatcher({
  poolSize: 20,            // maximum handlers at once — the real concurrency dial
  batchSize: 50,           // maximum events read per pass
  handlerTimeoutMs: 60_000,
  leaseTtlMs: 120_000,     // defaults to 2 × handlerTimeoutMs
  sweepIntervalMs: 30_000,
})

dispatcher.start()
```

It wakes two ways: a Firestore listener on the pending set fires the moment an
event arrives, and a slow sweep catches what a listener structurally cannot
see — retries whose time has come, and leases whose worker died. No write
happens when a retry falls due, so **the sweep is not optional**.

> **On Cloud Run, this needs CPU always allocated and `min-instances ≥ 1`.**
> Outside a request, CPU is throttled to near zero, and a background loop or a
> snapshot listener in a request-scoped container simply stops running between
> requests. That also makes it a service you pay for continuously.

### Scheduled job

If you would rather not keep anything warm:

```ts
// Cloud Scheduler → HTTP function, every minute
export const drainQueue = onRequest(async (_request, response) => {
  const dispatcher = queue.createDispatcher({ watchForNewEvents: false })
  const summary = await dispatcher.runOnce()
  await dispatcher.sweepOnce()
  response.json(summary)
})
```

`runOnce()` claims up to `min(poolSize, batchSize)` due events, runs them with
bounded concurrency, waits for all of them, and returns a summary. Same code
path, no timers, nothing to keep alive.

### Many dispatchers

Run as many as you like. They coordinate through the documents themselves —
see [Concurrency](#concurrency-why-there-are-no-transactions). Total
concurrency is `poolSize × instances`, which is what to size against whatever
your handlers talk to.

### Tuning

| Knob               | Start at            | What it trades                                                                 |
| ------------------ | ------------------- | ------------------------------------------------------------------------------ |
| `poolSize`         | 20 per instance     | The real concurrency dial — what stops a backfill flooding your handlers        |
| `batchSize`        | 50                  | Bigger batches mean fewer queries but more wasted claims when instances collide |
| `handlerTimeoutMs` | 60s                 | Must be **strictly below** `leaseTtlMs`; the constructor enforces it            |
| `leaseTtlMs`       | 2 × handler timeout | Too short and a slow handler's event is stolen; too long and a crash sits idle  |
| `sweepIntervalMs`  | 30s                 | Only affects how late a due retry is noticed, never correctness                 |
| `maxAttempts`      | 5                   | Attempts before dead-lettering                                                  |
| `backoff`          | 10s → 600s          | How hard a failing dependency gets hit                                          |

---

## Failure, retries and the dead-letter queue

```
  pending ──claim──► leased ──returns──────────────► done
     ▲                 │
     │                 ├──throws, budget left──────► pending   (backoff)
     │                 │
     │                 └──throws, budget spent ────► dead
     │                 │
     └──lease expired──┘   worker died; the sweep frees it
```

A handler that **returns** succeeds. A handler that **throws** fails, and the
event is retried with exponential backoff until `maxAttempts` is spent, at
which point it becomes `dead` and stops on its own.

To skip the remaining budget — a malformed payload, a record that is gone, a
rule that will never pass — throw a `PermanentError`:

```ts
import { PermanentError } from 'queueteapi'

queue.handlers.register('orders', 'placed', async (event) => {
  const order = await orders.find(event.payload.orderId)
  if (!order) throw new PermanentError(`Order ${event.payload.orderId} is gone`)
  await chargeCard(order)
})
```

A handler that hangs is abandoned at `handlerTimeoutMs` and retried. The work
itself is not cancelled — JavaScript cannot do that — which is exactly why the
lease outlives the timeout: a handler ignoring its deadline must still finish
before anyone else is allowed to take the event.

**Replay** is a status change, not an archaeology project:

```ts
const inspector = queue.createInspector()
await inspector.replay('event-id')                       // one
await inspector.replayMany({ status: 'dead', limit: 100 }) // the backlog
```

---

## Dev tools

### The dashboard

A framework-agnostic request handler and a zero-dependency HTML page. No build
step, no CDN, nothing to deploy separately.

```ts
import { createDashboard, createNodeRequestListener } from 'queueteapi'
import { createServer } from 'node:http'

const dashboard = createDashboard({ inspector: queue.createInspector() })

createServer(createNodeRequestListener(dashboard)).listen(3000)
```

Mounted under a prefix — tell both halves where they are:

```ts
const dashboard = createDashboard({
  inspector: queue.createInspector(),
  basePath: '/admin/queue',
  readOnly: process.env.NODE_ENV === 'production',   // disables replay
  title: 'orders queue — staging',
})

app.use('/admin/queue', createNodeRequestListener(dashboard, {
  basePath: '/admin/queue',
}))
```

The page shows live counts per status, the due backlog, how long the oldest
event has been waiting, which handlers this process has registered, a
filterable event table with the last error inline, and a replay button per row.

Routes, if you would rather build your own UI:

| Method | Path                      | Returns                             |
| ------ | ------------------------- | ----------------------------------- |
| `GET`  | `/`                       | The HTML page                       |
| `GET`  | `/api/stats`              | Counts, backlog, oldest, handlers   |
| `GET`  | `/api/events?status=&limit=` | Recent events                    |
| `GET`  | `/api/events/{id}`        | One event in full                   |
| `POST` | `/api/events/{id}/replay` | Requeue one event                   |
| `POST` | `/api/replay?status=dead` | Requeue a batch                     |

> The dashboard has no authentication of its own — it shows payloads and can
> requeue work. Mount it behind whatever protects the rest of your admin
> surface, and set `readOnly` where you would not hand someone a console.

### The CLI

```bash
npx queueteapi stats --collection domain-events
npx queueteapi list --status dead --limit 20
npx queueteapi show <event-id>
npx queueteapi replay <event-id>
npx queueteapi replay-all --status dead --limit 500
npx queueteapi serve --port 4300          # the dashboard, locally
```

Credentials come from the usual Google application default credentials, and
`FIRESTORE_EMULATOR_HOST` works, so pointing it at a local emulator needs no
flags. `--project` and `--database` select a target; `--json` gives
machine-readable output.

### Programmatic access

Everything above is a thin layer over `QueueInspector`, which you can use
directly — in a health check, a test, a Slack bot, your own admin page:

```ts
const stats = await queue.createInspector().stats()

if (stats.counts.dead > 0 || stats.dueNow > 1_000) {
  await pageSomeone(stats)
}
```

---

## Firestore indexes

Three composite indexes, all on the events collection. Copy them into your
`firestore.indexes.json` (a ready-made copy ships in this repo — change the
collection name if you configured a different one):

| Fields                             | Used by                                  |
| ---------------------------------- | ---------------------------------------- |
| `status` ASC, `nextAttemptAt` ASC  | claiming due work, the backlog count, the listener |
| `status` ASC, `leaseExpiresAt` ASC | the sweep reclaiming dead workers        |
| `status` ASC, `createdAt` DESC     | the dashboard's filtered list            |

```bash
firebase deploy --only firestore:indexes
```

Nothing else is needed. The dashboard's unfiltered list and the per-status
counts use single-field indexes, which Firestore maintains automatically. Those
counts are aggregate queries, so the dashboard costs a handful of reads on a
queue of any size rather than one read per event.

**One thing for the back of a drawer:** `createdAt` increases monotonically, so
every new event lands at the same end of that index. At sustained high write
rates that becomes a hotspot. It is not worth engineering around now — a queue
that drains is a collection that stays small — but if write latency on the
collection ever starts climbing, that is the cause.

---

## The event document

The top half is the envelope you published. The bottom half is what a broker
normally hides from you.

```jsonc
{
  // the envelope
  "topic": "orders",
  "name": "placed",
  "payload": { "orderId": "o_123", "total": 4200 },
  "actor": { "id": "u_9", "type": "customer" },
  "orderKey": "o_123",
  "trace": { "sentry-trace": "…" },

  // the queue state
  "mode": "queued",
  "status": "pending",        // pending · leased · done · dead
  "attempts": 2,
  "maxAttempts": 5,
  "nextAttemptAt": 1786371200000,
  "leaseOwner": null,
  "leaseExpiresAt": null,

  // the outcome
  "result": null,
  "lastError": {
    "name": "Error",
    "message": "payment gateway timed out",
    "stack": "…",
    "permanent": false,
    "at": 1786371190000
  },

  // timings
  "createdAt": 1786371180000,
  "updatedAt": 1786371190000,
  "startedAt": 1786371185000,
  "finishedAt": null
}
```

Two deliberate choices worth knowing about:

**Timestamps are epoch milliseconds, not Firestore `Timestamp` objects.** One
numeric representation keeps comparisons, queries, indexes and tests identical
everywhere. The dashboard renders them as dates.

**There is no `failed` status.** An event that failed but still has retries left
is `pending` again with `lastError` set. One claimable status keeps the claim
query — and its index — to a single shape. The dashboard shows those as
retrying, because `attempts > 0` says so.

---

## Concurrency: why there are no transactions

Twenty dispatchers query the pending set. They all see the same events. Exactly
one must run each of them.

The obvious answer is a transaction, and it is the wrong one. In
`firebase-admin` — a *server* client library — transactions are **pessimistic**:
reading a document inside one takes a lock on it. So a second dispatcher
reading the same event does not lose a race and move on. It **blocks**, waits
for the first to commit, then reads a document it must now discard. Twenty
workers claiming from one pending set would serialise on each other's read
locks instead of working in parallel.

QueueTeaPi claims with a single conditional write instead:

```ts
await ref.update(lease, { lastUpdateTime: snapshot.updateTime })
```

Firestore rejects that write — `FAILED_PRECONDITION` — if the document changed
since it was read. No lock is taken, so nobody ever blocks: the losers fail
instantly and move to the next document. It also keys on the document's
**version**, not on any field's value, which is much closer to the intuition of
"rejected because it already changed".

Every subsequent write is conditional on the version from the previous one, so
a dispatcher can never settle an event that was taken back from it while its
handler ran. That case is reported as `lost` rather than treated as a failure.

Two kinds of "stuck" follow from this, and only one is ours:

| | Transaction lock | Our lease |
| --- | --- | --- |
| Held by | Firestore | a field we wrote |
| Lasts | milliseconds | minutes |
| A worker dies | Firestore times it out | **nothing frees it but the sweep** |

Since we take no locks at all, only the second row exists here — which is why
`sweepIntervalMs` matters and why the sweep is not optional.

---

## Ordering is not provided

Two events sharing an `orderKey` can be picked up by two dispatchers at the
same moment, and one may finish before the other. This is deliberate.

Guaranteeing order means one worker owning a key at a time, which means
partitioning the collection into shards, leasing the shards, and rebalancing
them as instances come and go. That machinery has its own costs: shard count
caps useful instances, a rebalance stalls a shard for a lease, and one slow
event blocks every later event sharing its key.

`publish()` still accepts `orderKey` and the ledger still stores it, so related
events remain easy to find and trace. It simply has no effect on scheduling. If
sequencing turns out to matter somewhere specific, the cheap answer is for that
handler to be order-insensitive, not for the queue to become a partitioned log.

**If you are migrating off an ordered Pub/Sub subscription, this is the one
thing on this page worth a second opinion from whoever knows those handlers
best.**

---

## Migrating from Pub/Sub

If your handlers are HTTP endpoints today — a push subscription POSTing to a
private function URL — you do not have to touch them. `HttpEventHandler` sends
the byte-identical envelope:

```ts
import { HttpEventHandler } from 'queueteapi'
import { getIdTokenProvider } from './auth.js'   // your OIDC minting

queue.handlers.register(
  'medication-agreements',
  'stock-updated',
  new HttpEventHandler({
    url: 'https://europe-west1-project.cloudfunctions.net/onStockUpdated',
    getAuthorization: async (url) => `Bearer ${await getIdTokenProvider(url)}`,
  }),
)
```

The receiving endpoint gets exactly what a push subscription sends:

```jsonc
{
  "message": {
    "data": "eyJldmVudElkIjoi…",     // base64 JSON
    "attributes": { "eventId": "…", "topic": "…", "name": "…", "attempts": "2" },
    "messageId": "…",
    "publishTime": "2026-08-10T12:00:00.000Z"
  },
  "subscription": "queueteapi/medication-agreements"
}
```

Pass `encodeMessage` if your endpoints expect a different body shape.

HTTP failures are classified the way a queue should classify them: 5xx, 408 and
429 are retried; every other 4xx is the endpoint saying the request is wrong,
so those go straight to `dead`.

A per-event `transport` switch makes the rollout gradual — flip one entry in
your config, watch it, flip the next. Rollback is deleting one line.

---

## The example app

[`example/`](./example) is a working tea room: order a random tea (200ms) or a
random pie (1s) one at a time and wait for it, or send two hundred teas and a
hundred pies to the kitchen and watch the queue drain at exactly `poolSize`
at a time. Every cup on the page is a `done` event read back out of the ledger.

```bash
cd example && npm install && npm start
```

**Showstoppers** — soufflés, croquembouches — take 1.5s and fail half the time,
which makes them the most realistic button on the page. Retries, backoff and
the dead-letter queue stop being abstractions: a run of forty comes out around
32 served and 8 given up, and the served cards show how many attempts each one
took.

It runs three ways from the same code — in memory with no setup at all, against
the Firestore emulator, or against a real project. `example/scripts/scaffold.sh`
prepares a fresh Google Cloud project: enables the API, creates the database,
deploys the indexes. It is additive, idempotent, and has a `--dry-run`.

---

## Testing your handlers

The library never imports `firebase-admin`, so a handler test needs no
emulator, no network and no credentials. `queueteapi/testing` ships an
in-memory Firestore that enforces the one behaviour that matters — a write
whose precondition no longer holds is rejected — so contention, lost claims and
lease recovery behave in a test the way they behave in production.

```ts
import { QueueTeaPi } from 'queueteapi'
import { MemoryFirestore } from 'queueteapi/testing'

const queue = new QueueTeaPi({
  firestore: new MemoryFirestore(),
  clock: { now: () => 1_700_000_000_000 },   // deterministic timestamps
  generateId: () => 'event-1',               // predictable ids
  random: () => 0,                           // exact backoff, not approximate
})

queue.handlers.register('orders', 'placed', onOrderPlaced)
await queue.publish({ topic: 'orders', name: 'placed', payload: order })

const summary = await queue.createDispatcher().runOnce()
expect(summary.succeeded).toBe(1)
```

`runOnce()` is synchronous-ish and returns a summary, so a test never waits on
a background loop. `clock` and `generateId` are the two things that otherwise
make queue tests flaky.

`MemoryFirestore` is not a general-purpose emulator — it supports the query
shapes this package issues and nothing more. For anything else, point
`firestore` at the real Firestore emulator instead.

---

## Test coverage

100% of statements, branches, functions and lines, enforced as a threshold —
`npm test` fails below it. There are no coverage-ignore comments anywhere in
the source; where a branch was unreachable, the branch was removed rather than
annotated.

Two files are excluded, both presentation:

- `src/devtools/dashboard-page.ts` — the inline HTML/CSS/JS template
- `src/cli/cli.ts` — argument plumbing over stdout, process signals and a live
  Firestore connection

The logic behind both — `QueueInspector` and `parseArgs` — is covered in full.

```bash
npm test          # tests + coverage thresholds
npm run typecheck
npm run build
```

The suite includes a compile-time check that a real `firebase-admin`
`Firestore` satisfies the structural interface with no cast, so the optional
peer dependency cannot silently drift out of compatibility.

---

## API reference

### `new QueueTeaPi(options)`

| Option             | Default              | Meaning                                        |
| ------------------ | -------------------- | ---------------------------------------------- |
| `firestore`        | *required*           | Any Firestore-shaped instance                  |
| `collection`       | `queueteapi-events`  | Collection path holding the ledger             |
| `topics`           | `{}`                 | Per-topic and per-event settings               |
| `defaults`         | `{}`                 | Settings for topics that do not override them  |
| `handlers`         | a new registry       | Bring your own `HandlerRegistry`               |
| `handlerTimeoutMs` | `60_000`             | How long an inline handler may run             |
| `logger`           | `silentLogger`       | Where QueueTeaPi reports what it is doing      |
| `clock`            | `systemClock`        | Test seam                                      |
| `generateId`       | random UUID          | Test seam                                      |
| `random`           | `Math.random`        | Test seam for backoff jitter                   |
| `instanceId`       | random               | Identifies this process in `leaseOwner`        |

**Members:** `publish()`, `handlers`, `store`, `collection`, `instanceId`,
`createDispatcher()`, `createInspector()`, `deliveryFor()`.

### `queueteapi/testing`

`MemoryFirestore` — an in-memory Firestore for tests and local runs. Beyond the
Firestore surface it also offers `peek()`, `all()`, `seed()`, `clear()`,
`size`, `writes`, `listenerCount`, and a `failWith` hook for forcing errors.

### `QueueDispatcher`

`start()` · `stop()` · `runOnce(): Promise<TickSummary>` ·
`sweepOnce(): Promise<number>` · `running` · `instanceId`

`TickSummary` is `{ claimed, succeeded, retried, deadLettered, lost, durationMs }`.
Pass `onTick` to feed it straight into metrics.

### `QueueInspector`

`stats()` · `list({ status, limit })` · `get(id)` · `replay(id)` ·
`replayMany({ status, limit })`

### Errors

`QueueTeaPiError` is the base. `PermanentError` skips the retry budget.
`HandlerTimeoutError`, `UnregisteredHandlerError` and `ConfigurationError`
carry the details that make them actionable.

An event with **no registered handler is retried, not dead-lettered** — the
usual cause is a deploy that has not landed yet, and backoff lets it recover on
its own once it has.

---

## Licence

MIT
