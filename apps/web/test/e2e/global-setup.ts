/**
 * Fail fast when the E2E prerequisites are not running.
 *
 * A missing app or stack otherwise produces a wall of connection-refused timeouts that read as
 * application failures. One line naming exactly what to start is far more useful than twenty
 * failures to triage.
 */
const APP_URL = process.env.APP_URL ?? 'http://localhost:3000'
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025'

/** True when the URL answers at all -- any status counts, including 401 or 500. */
async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(3000) })
    return true
  } catch {
    return false
  }
}

export default async function globalSetup(): Promise<void> {
  const missing: string[] = []

  if (!(await reachable(APP_URL))) {
    missing.push(`the app at ${APP_URL} — start it with: pnpm dev`)
  }

  if (!(await reachable(`${MAILPIT_URL}/api/v1/messages?limit=1`))) {
    missing.push(`Mailpit at ${MAILPIT_URL} — start it with: pnpm dev:stack`)
  }

  if (missing.length > 0) {
    throw new Error(
      `\nE2E prerequisites are not running:\n${missing.map((line) => `  - ${line}`).join('\n')}\n`,
    )
  }

  console.log('[e2e] app and Mailpit are reachable')
}