/**
 * Test-time stand-in for the `server-only` package.
 *
 * The real module throws on import unless it is being evaluated by a React
 * Server Component graph. Vitest is not, so the guard is swapped out for this
 * no-op — the actual protection still applies in `next build`, which is where a
 * Client Component accidentally importing `@fydio/env/server` must fail.
 */
export {}
