import { getServerEnv } from '@fydio/env/server'
import { Badge, Card, Stack } from '@fydio/ui'

/**
 * Force server rendering on every request.
 *
 * The page reports live Supabase connectivity, and a prerendered page would
 * freeze that result at build time — showing a stale "Unreachable" forever, or
 * worse, a stale "Reachable" after the stack has been stopped.
 */
export const dynamic = 'force-dynamic'

/**
 * The T01 landing page.
 *
 * Its job is to prove the foundation works end to end: the environment contract
 * validates, the workspace packages are importable, and the Supabase stack is
 * actually reachable. There is no product surface here yet by design.
 */
export default async function HomePage() {
  const env = getServerEnv()
  const stack = await probeSupabaseStack(env.SUPABASE_URL, env.SUPABASE_ANON_KEY)

  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <Stack gap={2}>
        <Badge tone="brand">T01 · foundation</Badge>
        <h1 className="text-4xl font-semibold tracking-tight">{env.APP_NAME} is running</h1>
        <p className="text-ink-muted">
          Curated Feeds — discover relevant content from people you trust, and give feedback that
          helps them improve.
        </p>
      </Stack>

      <Card title="Environment">
        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-ink-muted">App name</dt>
          <dd className="font-medium">{env.APP_NAME}</dd>

          <dt className="text-ink-muted">App URL</dt>
          <dd className="font-mono text-xs">{env.APP_URL}</dd>

          <dt className="text-ink-muted">Supabase URL</dt>
          <dd className="font-mono text-xs">{env.SUPABASE_URL}</dd>

          <dt className="text-ink-muted">Platforms</dt>
          <dd className="font-medium">{env.PLATFORM_ALLOWLIST.join(', ')}</dd>

          <dt className="text-ink-muted">Feed page size</dt>
          <dd className="font-medium">{env.FEED_PAGE_SIZE}</dd>
        </dl>
      </Card>

      <Card title="Supabase connectivity">
        <Stack gap={2}>
          <Badge tone={stack.ok ? 'positive' : 'critical'}>
            {stack.ok ? 'Reachable' : 'Unreachable'}
          </Badge>
          <p className="text-sm text-ink-muted">{stack.detail}</p>
          {!stack.ok ? (
            <p className="text-sm text-ink-subtle">
              Start the local stack with <code className="font-mono">pnpm dev:stack</code>.
            </p>
          ) : null}
        </Stack>
      </Card>
    </main>
  )
}

/**
 * Probe the Supabase Auth health endpoint through Kong.
 *
 * Deliberately a plain `fetch` rather than a Supabase client: this page should
 * still render when the database is empty or down, and a client would throw on
 * a connection failure instead of letting us report it.
 *
 * Cached per render so a slow stack cannot turn this into two sequential waits.
 */
async function probeSupabaseStack(
  supabaseUrl: string,
  anonKey: string,
): Promise<{ ok: boolean; detail: string }> {
  const url = `${supabaseUrl.replace(/\/$/, '')}/auth/v1/health`

  try {
    const response = await fetch(url, {
      // Kong/Envoy returns 401 without an apikey, even on /health — without this
      // header the page reports "Unreachable" while the stack is perfectly fine.
      headers: { apikey: anonKey },
      // Never cache a health check — a stale "healthy" is worse than none.
      cache: 'no-store',
      signal: AbortSignal.timeout(5000),
    })

    if (response.ok) {
      const body: unknown = await response.json().catch(() => null)
      const version =
        typeof body === 'object' && body !== null && 'version' in body
          ? String(body.version)
          : 'unknown'

      return { ok: true, detail: `Auth is healthy (version ${version}).` }
    }

    return { ok: false, detail: `Auth responded with HTTP ${response.status}.` }
  } catch (error) {
    return {
      ok: false,
      detail: `Could not reach ${url}: ${error instanceof Error ? error.message : 'unknown error'}`,
    }
  }
}
