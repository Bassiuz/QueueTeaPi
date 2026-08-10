import { QueueTeaPi, consoleLogger, type FirestoreLike } from 'queueteapi'
import { MemoryFirestore } from 'queueteapi/testing'

import { prepare } from './kitchen.js'

/**
 * Standing the queue up — the part you would copy into your own app.
 *
 * The only thing that changes between running this on your laptop and running
 * it against a real project is which Firestore instance gets passed in. Every
 * other line is identical.
 */

export type Mode = 'memory' | 'emulator' | 'project'

export interface Kitchen {
  queue: QueueTeaPi
  mode: Mode
  /** A sentence for the page header explaining where the data is going. */
  description: string
  /** Only set in memory mode, so the demo can offer a "clear" button. */
  memory: MemoryFirestore | undefined
}

export const COLLECTION = process.env.QUEUE_COLLECTION ?? 'kitchen-orders'

/** Handlers get plenty of room; a pie only needs one second of it. */
const HANDLER_TIMEOUT_MS = 10_000

/**
 * Works out where to store events.
 *
 * - `QUEUETEAPI_MODE` wins if you set it.
 * - `FIRESTORE_EMULATOR_HOST` means the Firebase emulator is running.
 * - `GOOGLE_CLOUD_PROJECT` (or `GCLOUD_PROJECT`) means a real project.
 * - Otherwise everything stays in memory, so the demo runs with no setup.
 */
export function detectMode(env: NodeJS.ProcessEnv = process.env): Mode {
  const requested = env.QUEUETEAPI_MODE
  if (requested === 'memory' || requested === 'emulator' || requested === 'project') {
    return requested
  }

  if (env.FIRESTORE_EMULATOR_HOST) return 'emulator'
  if (env.GOOGLE_CLOUD_PROJECT ?? env.GCLOUD_PROJECT) return 'project'
  return 'memory'
}

export async function createKitchen(): Promise<Kitchen> {
  const mode = detectMode()
  const { firestore, description, memory } = await connect(mode)

  const queue = new QueueTeaPi({
    firestore,
    collection: COLLECTION,
    logger: consoleLogger,
    handlerTimeoutMs: HANDLER_TIMEOUT_MS,

    topics: {
      kitchen: {
        mode: 'queued',
        maxAttempts: 3,
        // Short waits so a failing order reaches the dead-letter queue while
        // you are still looking at the screen. Production defaults are
        // 10s → 600s over five attempts.
        backoff: { minMs: 2_000, maxMs: 15_000, factor: 2, jitter: 0.2 },
      },
    },
  })

  // Both event names run the same handler; only the sleep inside differs.
  queue.handlers.registerAll({
    kitchen: {
      'brew-tea': prepare,
      'bake-pie': prepare,
    },
  })

  return { queue, mode, description, memory }
}

interface Connection {
  firestore: FirestoreLike
  description: string
  memory: MemoryFirestore | undefined
}

async function connect(mode: Mode): Promise<Connection> {
  if (mode === 'memory') {
    const memory = new MemoryFirestore()
    return {
      firestore: memory,
      memory,
      description:
        'In-memory Firestore — nothing is written to disk or to the cloud, and everything vanishes when you stop the server.',
    }
  }

  const firestore = await connectToFirebase()

  return {
    firestore,
    memory: undefined,
    description:
      mode === 'emulator'
        ? `Firestore emulator at ${process.env.FIRESTORE_EMULATOR_HOST}. Open the emulator UI to watch documents change.`
        : `Firestore in project ${projectId()}. Orders are real documents in the "${COLLECTION}" collection.`,
  }
}

/**
 * Loaded at run time so that memory mode needs no credentials, no network and
 * no `firebase-admin` initialisation at all.
 */
async function connectToFirebase(): Promise<FirestoreLike> {
  const { getApps, initializeApp } = await import('firebase-admin/app')
  const { getFirestore } = await import('firebase-admin/firestore')

  // Against the emulator, credentials are neither needed nor available;
  // against a real project, firebase-admin picks up application default
  // credentials on its own. Either way there is nothing to pass here.
  const app = getApps()[0] ?? initializeApp({ projectId: projectId() })

  const databaseId = process.env.FIRESTORE_DATABASE_ID
  const firestore =
    databaseId === undefined ? getFirestore(app) : getFirestore(app, databaseId)

  return firestore as unknown as FirestoreLike
}

function projectId(): string {
  return (
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.GCLOUD_PROJECT ??
    // The emulator does not care what the project is called, but it insists
    // on being told something.
    'queueteapi-example'
  )
}

