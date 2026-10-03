import { describe, expect, it } from 'vitest'

/**
 * Live-stack smoke test (T01 §9).
 *
 * Skipped unless `SUPABASE_URL` is set, so CI — which has no stack — does not
 * fail, while a developer running `pnpm test` with the stack up gets a real
 * assertion that the gateway answers.
 *
 * This is deliberately an HTTP probe rather than a client round-trip: it proves
 * the pieces the app depends on are wired together (gateway → Auth) without
 * needing a business schema that T02 has not created yet.
 */
const supabaseUrl = process.env.SUPABASE_URL
const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

const describeIfStack = supabaseUrl ? describe : describe.skip

describeIfStack('local Supabase stack', () => {
  // Narrowed via the constants rather than an in-body throw: `describeIfStack`
  // only runs this suite when `SUPABASE_URL` is set, and a top-level throw
  // would execute at import time and fail the whole file — including in CI,
  // where the suite is meant to skip cleanly.
  const base = supabaseUrl?.replace(/\/$/, '') ?? ''
  const key = anonKey ?? ''

  it('reports Auth healthy through the gateway', async () => {
    // Kong/Envoy requires an apikey on every route, including /health.
    const response = await fetch(`${base}/auth/v1/health`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(5000),
    })

    expect(response.status).toBe(200)

    const body: unknown = await response.json()
    expect(body).toMatchObject({ name: 'GoTrue' })
  })

  it('accepts the anon key and rejects a wrong one', async () => {
    const url = `${base}/auth/v1/health`

    const [withGoodKey, withBadKey] = await Promise.all([
      fetch(url, { headers: { apikey: key }, signal: AbortSignal.timeout(5000) }),
      fetch(url, {
        headers: { apikey: 'not-a-valid-key' },
        signal: AbortSignal.timeout(5000),
      }),
    ])

    expect(withGoodKey.status).toBe(200)
    expect(withBadKey.status).toBe(401)
  })
})
