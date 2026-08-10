import { createServer } from 'node:http'

import { DEFAULT_COLLECTION } from '../config/queue-config.js'
import { createDashboard } from '../devtools/dashboard.js'
import { createNodeRequestListener } from '../devtools/dashboard-node.js'
import type { QueueInspector } from '../devtools/queue-inspector.js'
import { EVENT_STATUSES, type EventStatus } from '../events/queued-event.js'
import type { FirestoreLike } from '../firestore/firestore-types.js'
import { QueueTeaPi } from '../queue-tea-pi.js'
import { numberFlag, parseArgs, stringFlag, type ParsedArgs } from './args.js'

const USAGE = `
queueteapi — inspect and repair a Firestore-backed event queue

Usage
  queueteapi <command> [options]

Commands
  stats                    Counts per status, backlog and oldest waiting event
  list                     Recent events, newest first
  show <id>                One event in full
  replay <id>              Send one event back to pending
  replay-all               Send a whole status back to pending (default: dead)
  serve                    Serve the web dashboard
  help                     This text

Options
  --collection <path>      Ledger collection (default: ${DEFAULT_COLLECTION})
  --database <id>          Named Firestore database (default: the default one)
  --project <id>           Google Cloud project id
  --status <status>        One of: ${EVENT_STATUSES.join(', ')}
  --limit <n>              How many events to act on (default: 25)
  --port <n>               Port for 'serve' (default: 4300)
  --read-only              Disable replay in 'serve'
  --json                   Machine-readable output

Credentials come from the usual Google application default credentials, so
GOOGLE_APPLICATION_CREDENTIALS or 'gcloud auth application-default login'
both work, as does FIRESTORE_EMULATOR_HOST for a local emulator.
`.trim()

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)

  if (args.command === 'help' || args.flags.help === true) {
    console.log(USAGE)
    return 0
  }

  const commands: Record<string, (args: ParsedArgs) => Promise<number>> = {
    stats: runStats,
    list: runList,
    show: runShow,
    replay: runReplay,
    'replay-all': runReplayAll,
    serve: runServe,
  }

  const command = commands[args.command]
  if (command === undefined) {
    console.error(`Unknown command "${args.command}".\n`)
    console.error(USAGE)
    return 1
  }

  return command(args)
}

// ── commands ──────────────────────────────────────────────────────────────

async function runStats(args: ParsedArgs): Promise<number> {
  const stats = await (await inspectorFor(args)).stats()

  if (args.flags.json === true) {
    console.log(JSON.stringify(stats, null, 2))
    return 0
  }

  console.log(`collection   ${stats.collection}`)
  console.log(`total        ${stats.total}`)
  for (const status of EVENT_STATUSES) {
    console.log(`${status.padEnd(12)} ${stats.counts[status]}`)
  }
  console.log(`due now      ${stats.dueNow}`)
  console.log(
    `oldest due   ${
      stats.oldestDue
        ? `${stats.oldestDue.topic}/${stats.oldestDue.name} waiting ${Math.round(
            stats.oldestDue.waitingMs / 1000,
          )}s`
        : '—'
    }`,
  )
  return 0
}

async function runList(args: ParsedArgs): Promise<number> {
  const events = await (await inspectorFor(args)).list({
    status: statusFlag(args),
    limit: numberFlag(args.flags, 'limit', 25),
  })

  if (args.flags.json === true) {
    console.log(JSON.stringify(events, null, 2))
    return 0
  }

  if (events.length === 0) {
    console.log('No events matched.')
    return 0
  }

  for (const event of events) {
    console.log(
      [
        event.id.padEnd(38),
        event.status.padEnd(8),
        `${event.attempts}/${event.maxAttempts}`.padEnd(6),
        `${event.topic}/${event.name}`,
        event.lastError ? `— ${event.lastError.message}` : '',
      ].join(' '),
    )
  }
  return 0
}

async function runShow(args: ParsedArgs): Promise<number> {
  const id = args.positionals[0]
  if (id === undefined) {
    console.error('Usage: queueteapi show <id>')
    return 1
  }

  const event = await (await inspectorFor(args)).get(id)
  if (event === null) {
    console.error(`No event with id "${id}".`)
    return 1
  }

  console.log(JSON.stringify(event, null, 2))
  return 0
}

async function runReplay(args: ParsedArgs): Promise<number> {
  const id = args.positionals[0]
  if (id === undefined) {
    console.error('Usage: queueteapi replay <id>')
    return 1
  }

  const event = await (await inspectorFor(args)).replay(id)
  if (event === null) {
    console.error(`Could not replay "${id}": it no longer exists or changed.`)
    return 1
  }

  console.log(`Replayed ${id}; it is pending again.`)
  return 0
}

async function runReplayAll(args: ParsedArgs): Promise<number> {
  const status = statusFlag(args) ?? 'dead'
  const result = await (await inspectorFor(args)).replayMany({
    status,
    limit: numberFlag(args.flags, 'limit', 100),
  })

  console.log(
    `Replayed ${result.replayed} of ${result.matched} "${status}" events.`,
  )
  return 0
}

async function runServe(args: ParsedArgs): Promise<number> {
  const inspector = await inspectorFor(args)
  const port = numberFlag(args.flags, 'port', 4300)

  const dashboard = createDashboard({
    inspector,
    readOnly: args.flags['read-only'] === true,
    title: stringFlag(args.flags, 'collection') ?? DEFAULT_COLLECTION,
  })

  const server = createServer((request, response) => {
    void createNodeRequestListener(dashboard)(request, response)
  })

  await new Promise<void>((resolve) => server.listen(port, resolve))
  console.log(`QueueTeaPi dashboard on http://localhost:${port}`)

  // Resolves only when the process is interrupted.
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => server.close(() => resolve()))
    process.on('SIGTERM', () => server.close(() => resolve()))
  })
  return 0
}

// ── wiring ────────────────────────────────────────────────────────────────

function statusFlag(args: ParsedArgs): EventStatus | undefined {
  const value = stringFlag(args.flags, 'status')
  if (value === undefined) return undefined

  if (!EVENT_STATUSES.includes(value as EventStatus)) {
    throw new Error(
      `Unknown status "${value}". Expected one of: ${EVENT_STATUSES.join(', ')}.`,
    )
  }
  return value as EventStatus
}

async function inspectorFor(args: ParsedArgs): Promise<QueueInspector> {
  const queue = new QueueTeaPi({
    firestore: await connectToFirestore(args),
    collection: stringFlag(args.flags, 'collection') ?? DEFAULT_COLLECTION,
  })
  return queue.createInspector()
}

/**
 * Loads `firebase-admin` at run time.
 *
 * It is an optional peer dependency because the library itself never needs
 * it — only this CLI does, and only when it is actually run.
 */
async function connectToFirestore(args: ParsedArgs): Promise<FirestoreLike> {
  // Described locally rather than imported: firebase-admin is optional, so its
  // types are not guaranteed to be installed when this package is compiled.
  interface AdminAppModule {
    getApps(): unknown[]
    initializeApp(options: { projectId?: string }): unknown
  }
  interface AdminFirestoreModule {
    getFirestore(app: unknown, databaseId?: string): unknown
  }

  let appModule: AdminAppModule
  let firestoreModule: AdminFirestoreModule

  try {
    appModule = (await import('firebase-admin/app')) as AdminAppModule
    firestoreModule = (await import(
      'firebase-admin/firestore'
    )) as AdminFirestoreModule
  } catch {
    throw new Error(
      'The queueteapi CLI needs firebase-admin. Install it with: npm install firebase-admin',
    )
  }

  const projectId = stringFlag(args.flags, 'project')
  const existing = appModule.getApps()
  const app =
    existing[0] ??
    appModule.initializeApp(projectId === undefined ? {} : { projectId })

  const databaseId = stringFlag(args.flags, 'database')
  return (
    databaseId === undefined
      ? firestoreModule.getFirestore(app)
      : firestoreModule.getFirestore(app, databaseId)
  ) as unknown as FirestoreLike
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
