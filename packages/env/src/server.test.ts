import { describe, expect, it } from 'vitest'

import { serverEnvSchema, parseServerEnv } from './server.js'

import { validEnv } from '../test/fixtures.js'

/** Every variable the server schema requires, so the "missing" test is exhaustive. */
const REQUIRED_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_JWT_SECRET',
] as const

describe('parseServerEnv', () => {
  it('parses a valid environment and applies documented defaults', () => {
    const env = parseServerEnv(validEnv)

    expect(env.SUPABASE_URL).toBe('http://127.0.0.1:8000')
    expect(env.APP_NAME).toBe('Fydio')
    expect(env.APP_URL).toBe('http://localhost:3000')
    expect(env.FEED_PAGE_SIZE).toBe(20)
    expect(env.FEED_FRIEND_AFFINITY_BOOST).toBe(0.35)
    expect(env.CREDIT_SUBMISSION_COST).toBe(1)
    expect(env.STORAGE_BUCKET_FEEDBACK).toBe('feedback-images')
    expect(env.PLATFORM_ALLOWLIST).toEqual(['instagram', 'tiktok', 'youtube', 'x'])
  })

  it.each(REQUIRED_KEYS)('rejects the environment when %s is missing', (key) => {
    // Rebuild the object without the key rather than `delete`, which
    // no-dynamic-delete rejects and which would leave a hole in the type.
    const partial: Record<string, unknown> = { ...validEnv }
    Reflect.deleteProperty(partial, key)

    const result = serverEnvSchema.safeParse(partial)
    expect(result.success, `${key} should be required`).toBe(false)

    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes(key))).toBe(true)
    }
  })

  it('rejects a malformed URL with a readable error', () => {
    expect(() => parseServerEnv({ ...validEnv, SUPABASE_URL: 'not-a-url' })).toThrow(/SUPABASE_URL/)
  })

  it('rejects a JWT secret shorter than 32 characters', () => {
    expect(() => parseServerEnv({ ...validEnv, SUPABASE_JWT_SECRET: 'too-short' })).toThrow(
      /SUPABASE_JWT_SECRET/,
    )
  })

  it('names the missing variables in the error message', () => {
    let message = ''
    try {
      parseServerEnv({ NODE_ENV: 'test' })
    } catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('Server environment failed validation')
    expect(message).toContain('SUPABASE_URL')
    expect(message).toContain('Missing required variable(s)')
  })

  it('coerces numeric strings', () => {
    const env = parseServerEnv({ ...validEnv, FEED_PAGE_SIZE: '35', CREDIT_PER_DAY_CAP: '9' })

    expect(env.FEED_PAGE_SIZE).toBe(35)
    expect(env.CREDIT_PER_DAY_CAP).toBe(9)
  })

  it('falls back to defaults for empty numeric strings instead of coercing to 0', () => {
    // `z.coerce.number()` turns '' into 0; an unset knob must not become zero.
    const env = parseServerEnv({ ...validEnv, FEED_PAGE_SIZE: '', CREDIT_PER_DAY_CAP: '' })

    expect(env.FEED_PAGE_SIZE).toBe(20)
    expect(env.CREDIT_PER_DAY_CAP).toBe(5)
  })

  it('rejects numeric values outside their documented bounds', () => {
    expect(() => parseServerEnv({ ...validEnv, FEED_PAGE_SIZE: '999' })).toThrow(/FEED_PAGE_SIZE/)
    expect(() => parseServerEnv({ ...validEnv, FEED_PAGE_SIZE: '2' })).toThrow(/FEED_PAGE_SIZE/)
    expect(() => parseServerEnv({ ...validEnv, FEED_PAGE_SIZE: '12.5' })).toThrow(/FEED_PAGE_SIZE/)
  })

  it('parses a comma-separated platform allowlist', () => {
    const env = parseServerEnv({ ...validEnv, PLATFORM_ALLOWLIST: 'instagram, YouTube ,x' })

    expect(env.PLATFORM_ALLOWLIST).toEqual(['instagram', 'youtube', 'x'])
  })

  it('rejects an unknown platform in the allowlist', () => {
    expect(() => parseServerEnv({ ...validEnv, PLATFORM_ALLOWLIST: 'instagram,myspace' })).toThrow(
      /PLATFORM_ALLOWLIST/,
    )
  })

  it('derives isProduction from NODE_ENV and ignores a caller-supplied value', () => {
    expect(parseServerEnv({ ...validEnv, NODE_ENV: 'development' }).isProduction).toBe(false)
    expect(parseServerEnv({ ...validEnv, NODE_ENV: 'production' }).isProduction).toBe(true)

    // `isProduction` is not part of the schema, so a hostile value in the source
    // cannot flip it — it is always recomputed from NODE_ENV.
    const env = parseServerEnv({ ...validEnv, NODE_ENV: 'development', isProduction: true })
    expect(env.isProduction).toBe(false)
  })

  it('requires an extension token secret to be at least 32 characters when present', () => {
    expect(() => parseServerEnv({ ...validEnv, EXTENSION_TOKEN_SECRET: 'short' })).toThrow(
      /EXTENSION_TOKEN_SECRET/,
    )

    const env = parseServerEnv({ ...validEnv, EXTENSION_TOKEN_SECRET: 'x'.repeat(32) })
    expect(env.EXTENSION_TOKEN_SECRET).toBe('x'.repeat(32))
  })
})
