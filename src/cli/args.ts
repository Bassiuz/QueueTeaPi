/** A parsed command line: the command, its positional arguments and its flags. */
export interface ParsedArgs {
  command: string
  positionals: string[]
  flags: Record<string, string | boolean>
}

/**
 * A deliberately small argument parser.
 *
 * Supports `--flag value`, `--flag=value` and bare `--flag` (which becomes
 * `true`). That covers everything the CLI needs, and keeps the package
 * dependency-free.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string

    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }

    const body = token.slice(2)
    const equals = body.indexOf('=')

    if (equals !== -1) {
      flags[body.slice(0, equals)] = body.slice(equals + 1)
      continue
    }

    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[body] = next
      index += 1
    } else {
      flags[body] = true
    }
  }

  return {
    command: positionals.shift() ?? 'help',
    positionals,
    flags,
  }
}

/** Reads a flag as a string, or `undefined` if it was absent or bare. */
export function stringFlag(
  flags: ParsedArgs['flags'],
  name: string,
): string | undefined {
  const value = flags[name]
  return typeof value === 'string' ? value : undefined
}

/** Reads a flag as a positive integer, falling back to `fallback`. */
export function numberFlag(
  flags: ParsedArgs['flags'],
  name: string,
  fallback: number,
): number {
  const parsed = Number.parseInt(stringFlag(flags, name) ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
