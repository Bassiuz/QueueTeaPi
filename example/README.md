# The QueueTeaPi Tea Room ✿

A small, extremely pastel tea room that runs on QueueTeaPi `(づ｡◕‿‿◕｡)づ`

You order teas and pies; the queue makes them. Teas take 200ms, pies take a
second, and showstoppers take a second and a half and fall over half the time —
which is the whole point, and the reason you can watch a hundred pies drain
while two hundred teas fly past.

> The example is deliberately cute. The dashboard it mounts at `/queue` is the
> package's own, and is deliberately not.

```bash
cd example
npm install
npm start
```

Then open **http://localhost:4000**. That is it — no cloud project, no
emulator, no credentials. Events go into an in-memory Firestore that lives as
long as the process does.

| | |
| --- | --- |
| The tea room | http://localhost:4000 |
| The queue dashboard | http://localhost:4000/queue |

---

## What to try

**Order a tea** and **Order a pie** use `mode: 'inline'`. `publish()` runs the
handler itself and resolves with what it returned, so the button stays busy for
200ms or a full second. This is the mode for work a user is waiting on.

**Brew 200 teas** and **Bake 100 pies** use the default queued mode. All three
hundred `publish()` calls return in well under a second, because each one just
writes a document. Then watch the tiles: `in the queue` falls, `being made`
pins at exactly ten — the dispatcher's `poolSize` — and `served` climbs. Teas
come out at 50/second, pies at 10/second, which is `poolSize ÷ how long one
takes`.

**Attempt a showstopper** orders a soufflé, a croquembouche or another hard
bake. They take 1.5s and **fail half the time**, which is the most realistic
button on the page — it is what a flaky dependency actually looks like. Each
retry is a fresh roll of the dice, so with three attempts allowed:

| | |
| --- | --- |
| first go | ~50% |
| second go | ~25% |
| third go | ~12% |
| never | ~12% → dead-letter queue |

A run of 40 came out 32 served / 8 given up, with 13 of the survivors needing
more than one attempt. Served cards show a **`2 tries`** badge when they had to
be redone, so you can see the retries in the wall itself.

Ordering one inline is worth doing too: half the time `publish()` throws, the
page tells you what went wrong — and the event is *still in the queue*, so it
quietly succeeds a few seconds later without you doing anything.

**Drop a tray on purpose** publishes an order whose handler always throws. It
retries twice with backoff, then lands in the dead-letter queue about nine
seconds later. Open the dashboard, filter to **Dead**, and press **Replay**.

Everything on the *Served* wall is a `done` event read back out of the ledger
with `inspector.list({ status: 'done' })`. There is no second data store — the
queue is the audit log, so the page is just a view of it.

---

## Where the code is

| File | What it shows |
| --- | --- |
| `src/queue.ts` | Standing the queue up, and choosing a Firestore |
| `src/kitchen.ts` | The handlers — the only code here that does real work |
| `src/server.ts` | Publishing, reading the ledger back, mounting the dashboard |
| `src/menu.ts` | Teas, pies, showstoppers, and how long each takes |
| `snippets/` | Short, typechecked examples of other things the package does |

The interesting parts are small on purpose. `kitchen.ts` is one function with a
`sleep` in it; everything else — retries, leases, dead-lettering, the
dashboard — comes from the package.

---

## Running it against Firestore for real

Three modes, picked automatically from the environment:

| Mode | When | Needs |
| --- | --- | --- |
| `memory` | nothing else is set | nothing |
| `emulator` | `FIRESTORE_EMULATOR_HOST` is set | the Firebase emulator |
| `project` | `GOOGLE_CLOUD_PROJECT` is set | a real project |

Set `QUEUETEAPI_MODE` to force one.

### Against the Firestore emulator

```bash
npm run emulator
```

That starts the emulator, runs the tea room against it, and shuts the emulator
down when you stop. Documents show up in the emulator UI at
http://localhost:4001/firestore, and — unlike memory mode — **the CLI can see
them too**.

Needs Java, which the Firebase emulator requires.

### Against a real Google Cloud project

```bash
./scripts/scaffold.sh --project my-project
```

The script checks your tooling, enables the Firestore API, creates a database
if the project has none, and deploys the three composite indexes the queue
needs. Everything it does is additive and idempotent, it prints every command
before running it, and `--dry-run` prints without running. Then:

```bash
export GOOGLE_CLOUD_PROJECT=my-project
gcloud auth application-default login    # once per machine
npm start
```

Useful flags: `--location eur3`, `--database <id>`, `--collection <path>`,
`--dry-run`, `--yes`.

---

## Trying the CLI

The CLI opens Firestore directly, so it needs the emulator or a real project —
in memory mode the events only exist inside the server process, and there is
nothing for another process to read. Start the emulator (`npm run emulator`),
order a few things, then in a second terminal:

```bash
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
export GOOGLE_CLOUD_PROJECT=queueteapi-example

npx queueteapi stats  --collection kitchen-orders
npx queueteapi list   --collection kitchen-orders --status dead
npx queueteapi show   --collection kitchen-orders <event-id>
npx queueteapi replay --collection kitchen-orders <event-id>
npx queueteapi serve  --collection kitchen-orders --port 4300
```

`--collection kitchen-orders` matters every time; without it the CLI looks in
its default collection and finds nothing.

---

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `4000` | Web server port |
| `QUEUE_COLLECTION` | `kitchen-orders` | Firestore collection for the ledger |
| `QUEUE_POOL_SIZE` | `10` | Handlers running at once |
| `QUEUETEAPI_MODE` | auto | `memory`, `emulator` or `project` |
| `GOOGLE_CLOUD_PROJECT` | — | Project id, for `project` mode |
| `FIRESTORE_DATABASE_ID` | default | A named Firestore database |
| `FIRESTORE_EMULATOR_HOST` | — | e.g. `127.0.0.1:8080` |

Turn `QUEUE_POOL_SIZE` down to 2 and order a hundred pies to see the queue
really back up; turn it up to 50 to watch it disappear.

---

## Notes

**The dispatcher runs inside the web server here.** One `npm start`, one
process. In production you would run it as its own service — see
`snippets/basic-usage.ts` for both shapes.

**Retry timings are deliberately impatient.** The example waits 2s → 4s over
three attempts so a dropped tray reaches the dead-letter queue while you are
still looking at it. The package defaults are 10s → 600s over five attempts.

**`MetadataLookupWarning` in emulator mode is harmless.** It is
`google-auth-library` checking for a GCE metadata server that is not there.

**Clearing only works in memory mode.** Against the emulator or a real project
the button is hidden, because it would delete real documents.
