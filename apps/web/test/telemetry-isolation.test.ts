import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { DURATION_BANDS, DURATION_CONSENT_VERSION, RETURN_TOKEN_TTL_MINUTES } from '@fydio/domain'

/**
 * Structural telemetry guards (T08 §7, §8).
 *
 * The privacy promises in this task are the kind that survive review and fail
 * anyway — a query parameter appended "just for attribution", a duration column
 * added "for debugging", a `userId` search parameter on the privacy panel. Each of
 * those is a small, defensible-looking change that breaks a guarantee nobody is
 * checking, so each is asserted here against the source rather than trusted.
 *
 * These are structural assertions on purpose. A scenario test proves one path is
 * correct; a grep proves the path does not EXIST, which is the property that
 * matters when the failure mode is a future change nobody wrote a test for.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
// test/ → web/ → apps/ → repo root: three levels up.
const ROOT = join(HERE, '..', '..', '..')
const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations')
const SRC_DIR = join(HERE, '..', 'src')

function readMigrations(): { file: string; sql: string }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((file) => ({
      file,
      sql: stripComments(readFileSync(join(MIGRATIONS_DIR, file), 'utf8')),
    }))
}

/**
 * Remove `--` line comments so prose about a rule cannot match as the rule.
 * Same helper, and same documented approximation, as `credit-isolation.test.ts`.
 *
 * `comment on ...` statements are stripped too, for the same reason and with more
 * force: a `COMMENT ON TABLE` is documentation written as SQL, so a migration
 * that carefully explains "there is deliberately NO duration_ms column" would
 * otherwise be the one file that trips the check for having that name in it. The
 * invariant being tested is about COLUMN DEFINITIONS. Matched across newlines
 * because these statements wrap, and a line-anchored filter would only remove the
 * first line of a two-line comment and leave the part that names the column.
 */
function stripComments(sql: string): string {
  return sql
    .replace(/^\s*comment on [\s\S]*?;\s*$/gim, '')
    .split('\n')
    .map((line) => {
      const marker = line.indexOf('--')
      return marker === -1 ? line : line.slice(0, marker)
    })
    .join('\n')
}

/**
 * Strip TypeScript comments, so this file's greps test CODE rather than prose.
 *
 * THIS MATTERS MORE THAN IT LOOKS. Every module in this task explains in comments
 * exactly which patterns are forbidden — `utm_*`, `.eq('user_id'`, `durationMs` —
 * because a prohibition nobody understands is one somebody re-introduces. Left
 * un-stripped, those explanations would make every assertion in this file fail
 * against the very code that implements them.
 *
 * `//` is only treated as a comment when NOT preceded by `:`, so a URL inside a
 * string literal (`https://…`) survives. That is the one lexing subtlety here and
 * it is sufficient: the remaining imprecision is a `//` inside a longer string,
 * which no file in `src` contains.
 */
function stripTsComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const match = /\/\//.exec(line)

      if (match === null || match.index === 0) return line
      if (line[match.index - 1] === ':') return line

      return line.slice(0, match.index)
    })
    .join('\n')
}

/** Every `.ts`/`.tsx` file under `src`, as `{ file, source }` with comments removed. */
function readSources(): { file: string; source: string }[] {
  const found: { file: string; source: string }[] = []

  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)

      if (entry.isDirectory()) {
        walk(path)
        continue
      }

      if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
        found.push({
          file: path.slice(SRC_DIR.length + 1),
          source: stripTsComments(readFileSync(path, 'utf8')),
        })
      }
    }
  }

  walk(SRC_DIR)

  return found
}

const migrations = readMigrations()
const sources = readSources()

/** Split a migration into top-level function bodies by name, as credit-isolation does. */
function functionSpans(sql: string): { name: string; body: string }[] {
  const pattern = /create or replace function public\.(\w+)\(/g
  const found: { name: string; start: number }[] = []
  let match: RegExpExecArray | null

  while ((match = pattern.exec(sql)) !== null) {
    const name = match[1]
    if (name !== undefined) found.push({ name, start: match.index })
  }

  return found.map((fn, index) => {
    const next: { start: number } | undefined = found[index + 1]
    return { name: fn.name, body: sql.slice(fn.start, next === undefined ? sql.length : next.start) }
  })
}

const functions = migrations.flatMap(({ file, sql }) =>
  functionSpans(sql).map((fn) => ({ ...fn, file })),
)

/**
 * The credit-bearing functions, named.
 *
 * The property under test is "duration data never reaches a Credit", so the list is
 * the credit side: what mints, releases, reverses, or caps one. Anything added to
 * this list is a function that would have to be re-checked.
 */
const CREDIT_FUNCTIONS = [
  'evaluate_feedback_eligibility',
  'release_held_credits',
  'admin_grant_credit',
  'admin_reverse_credit',
  'admin_cap_credit',
  'grant_weekly_allowance',
  'create_content_entry',
] as const

describe('duration telemetry never touches the credit economy', () => {
  it('no credit function reads duration data', () => {
    const offenders = functions
      .filter((fn) => (CREDIT_FUNCTIONS as readonly string[]).includes(fn.name))
      .filter((fn) => /duration_events|duration_band|duration_consents/i.test(fn.body))
      .map((fn) => `${fn.file}:${fn.name}`)

    expect(
      offenders,
      'duration data must never appear in a credit or eligibility function',
    ).toEqual([])
  })

  it('no credit function writes a credit from an open or a click', () => {
    // The distinction this encodes: opened state MAY gate feedback eligibility
    // (brief §2), engagement may never PAY. A function that both reads
    // `feed_impressions` and inserts a ledger row would be paying for an open.
    const engagement = /duration_events|outbound_clicks|feed_impressions/i
    const offenders = functions
      .filter((fn) => (CREDIT_FUNCTIONS as readonly string[]).includes(fn.name))
      .filter((fn) => /insert into public\.credit_ledger/i.test(fn.body) && engagement.test(fn.body))
      .map((fn) => `${fn.file}:${fn.name}`)

    expect(offenders, 'an open may gate feedback, never mint a Credit').toEqual([])
  })

  it('no view joins duration data into anything credit-bearing', () => {
    const offenders = migrations
      .flatMap(({ file, sql }) =>
        [...sql.matchAll(/create or replace view public\.(\w+)[\s\S]*?;/g)].map((m) => ({
          file,
          name: m[1] ?? 'unknown',
          body: m[0],
        })),
      )
      .filter((view) => /duration_events/i.test(view.body) && /credit/i.test(view.body))
      .map((view) => `${view.file}:${view.name}`)

    expect(offenders, 'no view may join duration events into credits').toEqual([])
  })
})

describe('the outbound URL is never modified', () => {
  /**
   * THE PROHIBITION, ASSERTED. Fydio appends nothing to a destination it does not
   * control: no `utm_*`, no `?fydio_ref=`, no redirect of our own, no proxy.
   *
   * Matched on the `OpenOriginalButton` source specifically rather than anywhere in
   * `src`, because `URLSearchParams` legitimately appears elsewhere — preview
   * resolution rewrites a submitted URL on the way IN, which is the member's own
   * link and not an outbound click.
   */
  it('adds no tracking parameters to the outbound href', () => {
    const source = sources.find((s) => s.file.endsWith('OpenOriginalButton.tsx'))

    expect(source, 'OpenOriginalButton.tsx must exist').toBeDefined()

    const body = source?.source ?? ''

    // The href must be the raw prop, with no expression built around it.
    expect(body).toMatch(/href=\{originalUrl\}/)

    for (const pattern of [
      /utm_/i,
      /fydio_ref/i,
      /URLSearchParams/,
      /new URL\(/,
      /searchParams\.set/,
    ]) {
      expect(body, `outbound link must not use ${String(pattern)}`).not.toMatch(pattern)
    }
  })

  it('opens in a new tab with noopener, noreferrer and nofollow', () => {
    const source = sources.find((s) => s.file.endsWith('OpenOriginalButton.tsx'))
    const body = source?.source ?? ''

    expect(body).toMatch(/target="_blank"/)
    // Asserted as all three, because each covers a different leak: window handle,
    // referrer, and link-equity.
    expect(body).toMatch(/noopener/)
    expect(body).toMatch(/noreferrer/)
    expect(body).toMatch(/nofollow/)
  })

  it('never awaits the click recording inside the click handler', () => {
    // Awaiting inside the handler risks the popup being blocked: the user-gesture
    // window closes while the network call is in flight. `void` is what makes the
    // fire-and-forget contract explicit.
    const source = sources.find((s) => s.file.endsWith('OpenOriginalButton.tsx'))
    const body = source?.source ?? ''

    expect(body).not.toMatch(/onClick=\{async/)
    expect(body).not.toMatch(/await recordOutboundClick/)
    expect(body).toMatch(/void recordOutboundClick/)
  })
})

describe('no automated platform interaction exists anywhere', () => {
  /**
   * The brief's hardest prohibition: Fydio never likes, follows, shares, comments
   * or votes on a platform, and never automates one. There is no legitimate reason
   * for the web app to speak any platform's action API, so any mention of one of
   * these in application code is a finding.
   *
   * Scoped to `src` and not the migrations: the migrations name the platforms Fydio
   * accepts LINKS for, and `content_entries.platform` is that vocabulary.
   */
  it('contains no platform action automation', () => {
    const offenders: string[] = []

    for (const { file, source } of sources) {
      for (const pattern of [
        /graph\.facebook\.com/i,
        /instagram\.com\/api/i,
        /tiktok\.com\/api/i,
        /youtube\.com\/feeds/i,
        /api\.x\.com/i,
        /api\.twitter\.com/i,
        /\bchrome\.scripting\b/,
        /\bchrome\.webRequest\b/,
      ]) {
        if (pattern.test(source)) offenders.push(`${file}: ${String(pattern)}`)
      }
    }

    expect(
      offenders,
      'no platform API or browser-automation entry point may appear in the app',
    ).toEqual([])
  })
})

describe('the privacy panel cannot read another member', () => {
  it('takes no member id as an argument on any query it makes', () => {
    const page = sources.find((s) => s.file.endsWith('settings/privacy/page.tsx'))

    expect(page, 'the privacy page must exist').toBeDefined()

    const body = page?.source ?? ''

    // The dangerous shape is a `?userId=` parameter or an `.eq('user_id', …)`
    // sourced from anywhere but the session. `requireUserId()` returning a value
    // that is never used in a filter is the correct pattern, so the check is that
    // no filter is built from it.
    expect(body).not.toMatch(/searchParams/)
    expect(body).not.toMatch(/\.eq\(\s*'user_id'/)
    expect(body).not.toMatch(/p_user_id/)
  })
})

describe('duration storage holds bands only', () => {
  it('declares no duration column in any migration', () => {
    const offenders: string[] = []

    for (const { file, sql } of migrations) {
      for (const pattern of [/duration_ms/i, /duration_seconds/i, /elapsed_ms/i, /dwell/i]) {
        if (pattern.test(sql)) offenders.push(`${file}: ${String(pattern)}`)
      }
    }

    expect(
      offenders,
      'duration_events stores a band; a measurement column must never appear',
    ).toEqual([])
  })

  it('the ingest schema accepts no duration field', () => {
    const route = sources.find((s) => s.file.endsWith('api/telemetry/duration/route.ts'))

    expect(route, 'the duration ingest route must exist').toBeDefined()

    const body = route?.source ?? ''

    // Not merely "not stored" — not ACCEPTED. A field the schema rejects cannot be
    // sent at all, so the lossless-measurement path does not exist to be abused.
    expect(body).not.toMatch(/durationMs|duration_ms|elapsed/i)
    // `.strict()` is what enforces that; without it zod silently drops unknown keys
    // and an extension sending extra data gets a 201 instead of a 400.
    expect(body).toMatch(/\.strict\(\)/)
  })

  it('clamps an out-of-enum band rather than rejecting it', () => {
    const route = sources.find((s) => s.file.endsWith('api/telemetry/duration/route.ts'))
    const body = route?.source ?? ''

    // The band is `z.string()`, not `z.enum(DURATION_BANDS)`: a rejected event
    // leaves a member's activity list silently incomplete, while a clamped one says
    // "we did not know". The SQL side clamps too, and pgTAP asserts it.
    expect(body).toMatch(/coerceDurationBand/)
    expect(body).not.toMatch(/z\.enum\(DURATION_BANDS\)/)
  })
})

describe('the consent vocabulary has one definition', () => {
  it('the SQL consent version matches the TypeScript constant', () => {
    // Bumping one without the other invalidates every member's grant, silently and
    // globally. It is the single most consequential drift in this task, so it is
    // asserted rather than documented.
    const declaring = migrations.filter(({ sql }) =>
      /select\s+'[0-9]{4}-[0-9]{2}-dur-v\d+'::text/.test(sql),
    )

    expect(declaring.length, 'exactly one migration declares the consent version').toBe(1)

    const match = /select\s+'([^']+)'::text/.exec(declaring[0]?.sql ?? '')

    expect(match?.[1]).toBe(DURATION_CONSENT_VERSION)
  })

  it('every band in the vocabulary exists in the SQL enum', () => {
    const enumSql = migrations.find(({ file }) => file.startsWith('0001'))?.sql ?? ''
    const declared = /create type duration_band as enum \(([\s\S]*?)\);/.exec(enumSql)

    expect(declared, 'the duration_band enum must exist in 0001').not.toBeNull()

    const values = [...(declared?.[1] ?? '').matchAll(/'([a-z0-9_]+)'/g)]
      .map((m) => m[1])
      .filter((value): value is string => value !== undefined)

    expect([...values].sort()).toEqual([...DURATION_BANDS].sort())
  })

  it('the return-token window in TypeScript matches the SQL interval', () => {
    // `validate_return_token` hard-codes `make_interval(mins => 30)`. A TS constant
    // that disagreed would make the UI promise a window the database does not honour.
    const sql = migrations
      .filter(({ file }) => file.includes('0024'))
      .map(({ sql: body }) => body)
      .join('\n')

    const minutes = [...sql.matchAll(/make_interval\(mins\s*=>\s*(\d+)\)/g)].map((m) =>
      Number(m[1]),
    )

    expect(minutes.length).toBeGreaterThan(0)

    for (const value of minutes) {
      expect(value).toBe(RETURN_TOKEN_TTL_MINUTES)
    }
  })
})

describe('the duration ingest is service-role only', () => {
  it('is revoked from authenticated and anon in SQL', () => {
    // This function takes a `p_user_id` argument. Left granted to `authenticated`,
    // any signed-in member could write a duration event against any other member —
    // forging somebody else's private history. This image's default privileges
    // grant EXECUTE to `authenticated` at CREATE time, so the revoke is the
    // protection, not the absence of a grant.
    const sql = migrations
      .filter(({ file }) => file.includes('0026'))
      .map(({ sql: body }) => body)
      .join('\n')

    expect(sql).toMatch(
      /revoke execute on function public\.ingest_duration_event\(uuid, uuid, text, boolean\) from authenticated;?/,
    )
    expect(sql).toMatch(
      /revoke execute on function public\.ingest_duration_event\(uuid, uuid, text, boolean\) from anon;?/,
    )
    expect(sql).toMatch(
      /grant execute on function public\.ingest_duration_event\(uuid, uuid, text, boolean\) to service_role;?/,
    )
  })

  it('is not reachable from any member-facing route', () => {
    const offenders = sources
      .filter((source) => source.file.startsWith('app/api/'))
      .filter((source) => source.source.includes('memberClient()'))
      .filter((source) => source.source.includes('ingest_duration_event'))
      .map((source) => source.file)

    expect(
      offenders,
      'the member client has BYPASSRLS off and must never call the service-only ingest',
    ).toEqual([])
  })
})
