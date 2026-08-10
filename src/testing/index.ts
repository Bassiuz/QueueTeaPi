/**
 * Test and local-development helpers, imported from `queueteapi/testing`.
 *
 * Kept out of the main entrypoint so nothing here ships in an application
 * bundle unless it is deliberately asked for.
 */
export {
  DocumentMissingError,
  MemoryFirestore,
  PreconditionFailedError,
  type FailureHook,
} from './memory-firestore.js'
