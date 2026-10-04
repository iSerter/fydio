import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig, devices } from '@playwright/test'

/**
 * The config's own directory, normalised.
 *
 * `testDir` and `globalSetup` are resolved relative to the CWD in some invocations and to the
 * config file in others, so both are anchored here. That is what lets `pnpm test:e2e` work from
 * the repo root and from inside `apps/web` alike.
 *
 * `resolve` matters: Playwright `require`s `globalSetup` by path, and an un-normalised
 * `…/apps/web/../tests/…` is a different string from `…/tests/…` even though they are the same
 * file -- so the lookup fails with a confusing "cannot find module" for a file that is present.
 *
 * `import.meta.url` rather than `__dirname`: `apps/web/package.json` declares
 * `"type": "module"`, so this file is loaded as ESM and `__dirname` does not exist there.
 */
const HERE = fileURLToPath(new URL('.', import.meta.url))

/** A repo-relative path, normalised and slash-terminated. */
function fromHere(...parts: string[]): string {
  return join(HERE, ...parts)
}

/**
 * End-to-end configuration (T03 §9).
 *
 * These specs drive a real browser against a real stack, so they need three things running:
 * the Supabase stack (`pnpm dev:stack`), the app (`pnpm dev`), and — because the journey begins
 * with an emailed invitation — a way to obtain a token. `issue-invite.ts` prints the link, and
 * `globalSetup` captures it from the Mailpit API rather than asking a developer to paste it.
 *
 * Browsers are NOT installed by `pnpm install`. Run `pnpm exec playwright install chromium` once
 * before `pnpm test:e2e`; without it the suite fails with a missing-executable error that says
 * nothing about the application.
 */
export default defineConfig({
  testDir: fromHere('test/e2e'),
  // Serial, not parallel. Every test in this suite creates a member and redeems a single-use
  // invitation, and they share one database and one Mailpit inbox. Running them concurrently
  // would make assertions about "the" magic link depend on which test wrote last.
  fullyParallel: false,
  workers: 1,
  forbidOnly: process.env.CI === 'true',
  retries: process.env.CI === 'true' ? 1 : 0,
  reporter: process.env.CI === 'true' ? 'github' : 'list',
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: process.env.APP_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  /**
   * Fail fast when the prerequisites are missing.
   *
   * Without this, a missing app produces a page of connection-refused timeouts that read as
   * application failures. One clear line naming what to start is far more useful.
   */
  globalSetup: fromHere('test/e2e/global-setup.ts'),
})