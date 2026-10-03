import type { z } from 'zod'

/**
 * Turn a Zod error into something an operator can act on at 3am.
 *
 * The default `ZodError.message` is a JSON blob of every issue, which buries the
 * one variable that is actually wrong. This prints `VAR: reason` per line and
 * flags the variables that are missing entirely, which is the common case.
 */
export function formatEnvError(error: z.ZodError, label: string): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    return `  • ${path}: ${issue.message}`
  })

  const missing = error.issues
    .filter((issue) => issue.code === 'invalid_type' && issue.input === undefined)
    .map((issue) => issue.path.join('.'))

  const missingHint =
    missing.length > 0
      ? `\n\nMissing required variable(s): ${[...new Set(missing)].join(', ')}\n` +
        `Check your .env (copy it from .env.example) and restart.`
      : ''

  return `${label} failed validation:\n${lines.join('\n')}${missingHint}`
}

/** Collect a Zod failure into a single readable `Error`. */
export function envValidationError(error: z.ZodError, label: string): Error {
  return new Error(formatEnvError(error, label))
}
