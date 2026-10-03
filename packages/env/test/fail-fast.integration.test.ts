import { describe, expect, it } from 'vitest'

// Imported from the specific entrypoints rather than the package root: the
// barrel deliberately re-exports only schemas and types, never live parsed
// values, so that importing it can never pull a secret into a client bundle.
import { parseClientEnv } from '../src/client.js'
import { parseServerEnv } from '../src/server.js'

/**
 * Acceptance criteria from T01 §8:
 *
 *   `NEXT_PUBLIC_SUPABASE_URL=not-a-url pnpm --filter @fydio/web dev`
 *   fails fast with a readable zod error.
 *
 * Asserted here at the boundary the CLI actually hits — the same
 * `parseClientEnv` the app calls at boot — rather than by shelling out to a dev
 * server, which would be slow and would fail for unrelated reasons (port in use,
 * a stale build cache from a previous run).
 */
describe('fail-fast boot validation', () => {
  const baseClient = {
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-that-is-long-enough-here',
  }

  it('rejects NEXT_PUBLIC_SUPABASE_URL=not-a-url with a readable error', () => {
    expect(() => parseClientEnv({ ...baseClient, NEXT_PUBLIC_SUPABASE_URL: 'not-a-url' })).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL/,
    )
  })

  it('names the offending variable and points at the env file', () => {
    let message = ''

    try {
      parseClientEnv({ ...baseClient, NEXT_PUBLIC_SUPABASE_URL: 'not-a-url' })
    } catch (error) {
      message = (error as Error).message
    }

    // A raw ZodError dump is technically "a readable error" but a poor one at
    // 3am; these assertions are what keep the formatting in errors.ts honest.
    expect(message).toContain('Client environment failed validation')
    expect(message).toContain('NEXT_PUBLIC_SUPABASE_URL')
    expect(message).toMatch(/url/i)
  })

  it('lists every missing variable at once rather than one per restart', () => {
    let message = ''

    try {
      parseServerEnv({ NODE_ENV: 'development' })
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('SUPABASE_URL')
    expect(message).toContain('SUPABASE_ANON_KEY')
    expect(message).toContain('SUPABASE_SERVICE_ROLE_KEY')
    expect(message).toContain('SUPABASE_JWT_SECRET')
  })
})
