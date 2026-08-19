/** Severity levels QueueTeaPi logs at. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * A deliberately tiny logging surface, so any logger you already use
 * (pino, winston, `console`, Cloud Logging) can be adapted in a few lines.
 */
export interface Logger {
  log(level: LogLevel, message: string, context?: Record<string, unknown>): void
}

/** The default. QueueTeaPi is silent unless you ask it not to be. */
export const silentLogger: Logger = {
  log: () => {},
}

/** A ready-made logger for local development. */
export const consoleLogger: Logger = {
  log(level, message, context) {
    const line = `[queueteapi] ${message}`
    if (context === undefined) console[level](line)
    else console[level](line, context)
  },
}
