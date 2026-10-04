import { describe, expect, it } from 'vitest'

import { parseClientEnv } from './client.js'
import { clientEnvSchema } from './schema.js'

import { validEnv } from '../test/fixtures.js'

const validClientEnv = {
  NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:8000',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-that-is-definitely-long-enough',
}

/** A shallow copy of `source` with `key` removed. */
function withoutKey(source: Record<string, string>, key: string): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...source }
  Reflect.deleteProperty(copy, key)
  return copy
}

describe('parseClientEnv', () => {
  it('parses a valid client environment', () => {
    const env = parseClientEnv(validClientEnv)

    expect(env.NEXT_PUBLIC_APP_NAME).toBe('Fydio')
    expect(env.NEXT_PUBLIC_APP_URL).toBe('http://localhost:3000')
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe('http://127.0.0.1:8000')
  })

  it('rejects a malformed NEXT_PUBLIC_SUPABASE_URL', () => {
    expect(() =>
      parseClientEnv({ ...validClientEnv, NEXT_PUBLIC_SUPABASE_URL: 'not-a-url' }),
    ).toThrow(/NEXT_PUBLIC_SUPABASE_URL/)
  })

  it('requires a client app URL', () => {
    expect(() => parseClientEnv(withoutKey(validClientEnv, 'NEXT_PUBLIC_APP_URL'))).toThrow(
      /NEXT_PUBLIC_APP_URL/,
    )
  })

  it('requires a client anon key', () => {
    expect(() =>
      parseClientEnv(withoutKey(validClientEnv, 'NEXT_PUBLIC_SUPABASE_ANON_KEY')),
    ).toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY/)
  })

  /**
   * The isolation guarantee from the task spec, asserted rather than assumed.
   *
   * A server secret present in the input must be *dropped*, never surfaced on
   * the client object. If someone widens `clientEnvSchema` by accident, this
   * fails and the leak is caught before it reaches a browser bundle.
   *
   * The assertion checks exact key names and the secret *values*, not
   * substrings: `NEXT_PUBLIC_SUPABASE_URL` legitimately contains the characters
   * `SUPABASE_URL`, so a substring check would be a false alarm.
   */
  it('never exposes server-only secrets, even when they are present in the source', () => {
    const secretValues = {
      SUPABASE_SERVICE_ROLE_KEY: validEnv.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_JWT_SECRET: validEnv.SUPABASE_JWT_SECRET,
      EXTENSION_TOKEN_SECRET: 'x'.repeat(32),
    }

    const env = parseClientEnv({
      ...validClientEnv,
      ...secretValues,
      SUPABASE_URL: validEnv.SUPABASE_URL,
      CREDIT_SUBMISSION_COST: '99',
      FEED_PAGE_SIZE: '999',
    })

    const keys = Object.keys(env)
    const serialised = JSON.stringify(env)

    for (const key of Object.keys(secretValues)) {
      expect(keys, `${key} must not appear on the client env`).not.toContain(key)
    }

    for (const key of ['SUPABASE_URL', 'CREDIT_SUBMISSION_COST', 'FEED_PAGE_SIZE']) {
      expect(keys, `${key} must not appear on the client env`).not.toContain(key)
    }

    // The dangerous failure mode is the secret *value* surviving, so check those
    // directly rather than relying on the key check alone.
    for (const value of Object.values(secretValues)) {
      expect(serialised).not.toContain(value)
    }
  })

  it('only declares NEXT_PUBLIC_-prefixed keys in its schema', () => {
    for (const key of Object.keys(clientEnvSchema.shape)) {
      expect(key.startsWith('NEXT_PUBLIC_'), `${key} must be NEXT_PUBLIC_ prefixed`).toBe(true)
    }
  })

  it('has no schema key matching a known server-only secret', () => {
    const keys = Object.keys(clientEnvSchema.shape)

    for (const key of keys) {
      expect(key).not.toBe('SUPABASE_SERVICE_ROLE_KEY')
      expect(key).not.toBe('SUPABASE_JWT_SECRET')
      expect(key).not.toBe('EXTENSION_TOKEN_SECRET')
    }
  })
})

describe('client env inlining', () => {
  /**
   * A regression guard for a bug that nothing else in this file can catch.
   *
   * `readClientEnv()` builds its object from literal `process.env.NEXT_PUBLIC_*` reads because the
   * bundler replaces exactly those expressions with string literals. Any other shape -- spreading
   * `process.env`, destructuring it, reading it dynamically -- compiles cleanly, passes every test
   * above, and then fails at runtime in the browser with "Client environment failed validation",
   * because the bundle was emitted with no values to substitute in.
   *
   * No unit test can observe the substitution itself, so this asserts the *source* property that
   * makes it possible: every schema key is named through a static member access, and the bare
   * `process.env` form is absent.
   */
  it('reads every schema key through a static process.env.NEXT_PUBLIC_* expression', async () => {
    const { readFile } = await import('node:fs/promises')
    const { fileURLToPath } = await import('node:url')

    const source = await readFile(fileURLToPath(new URL('./client.ts', import.meta.url)), 'utf8')

    for (const key of Object.keys(clientEnvSchema.shape)) {
      expect(source, `${key} must be read as \`process.env.${key}\``).toContain(
        `process.env.${key}`,
      )
    }

    // The exact failure mode: handing the whole object to the schema produced an un-inlinable
    // bundle. Asserting both shapes are gone keeps that from being reintroduced.
    expect(source).not.toMatch(/safeParse\(process\.env\)/)
    expect(source).not.toMatch(/source:\s*Record<[^>]+>\s*=\s*process\.env\b/)
  })
})
