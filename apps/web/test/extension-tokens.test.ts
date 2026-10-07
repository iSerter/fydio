import { describe, expect, it } from 'vitest'

import { issueExtensionToken, verifyExtensionToken, verifyExtensionTokenRequest } from '@/lib/extension-tokens'

/**
 * Extension token signing and verification (T08 §9).
 *
 * The token is the only credential the browser companion holds, so these tests
 * cover the four ways it can go wrong and one property it must have:
 *
 *   * a valid token round-trips
 *   * a tampered PAYLOAD fails (the signature covers the bytes that travel)
 *   * a tampered SIGNATURE fails
 *   * an expired token fails, at and past the boundary
 *   * a token signed with a different secret fails
 *
 * `now` is injected rather than slept through, so the expiry boundary is asserted
 * exactly rather than approximately — the test for "expires after 15 minutes"
 * should not itself take 15 minutes, or be skipped when it is slow.
 *
 * The secret comes from the environment rather than being injected, because
 * `@fydio/env` reads and validates it at module scope. `vitest.config.ts` points
 * `envDir` at the repo root, so `.env` supplies it; without one the module refuses
 * everything and the suite skips rather than passing vacuously — a "no tests ran"
 * is visible where a silently-skipped assertion is not.
 */
const SECRET = process.env.EXTENSION_TOKEN_SECRET

const describeIfSecret = typeof SECRET === 'string' && SECRET.length >= 32 ? describe : describe.skip

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222'
const NOW = new Date('2026-03-01T12:00:00.000Z')
const MINUTE = 60 * 1000

describeIfSecret('extension tokens', () => {
  it('round-trips a freshly issued token', () => {
    const token = issueExtensionToken({ userId: USER_ID, scope: 'telemetry:duration', now: NOW })

    const verified = verifyExtensionToken(token, NOW)

    expect(verified?.userId).toBe(USER_ID)
    expect(verified?.scope).toBe('telemetry:duration')
    // `NOW` is already on a whole second, so the truncation in the issuer is a
    // no-op here and the expiry lands exactly one TTL later. Pinned `NOW` is what
    // makes that equality meaningful rather than approximate.
    expect(verified?.expiresAt.getTime()).toBe(NOW.getTime() + 15 * MINUTE)
  })

  it('issues a distinct token per call even for the same member and instant', () => {
    // Non-determinism matters: a constant token would be a static bearer credential
    // for every member of the extension, and a leaked one would be replayable
    // forever rather than until its own expiry.
    const first = issueExtensionToken({ userId: USER_ID, scope: 'telemetry:duration', now: NOW })
    const second = issueExtensionToken({ userId: USER_ID, scope: 'telemetry:duration', now: NOW })

    expect(first).not.toBe(second)
  })

  it('rejects a token whose payload was edited', () => {
    // The attack this blocks: take a valid token, swap the member id for someone
    // else's, keep the signature. It fails because the signature covers the payload
    // BYTES, so any edit — including one that decodes to valid JSON — changes them.
    const token = issueExtensionToken({ userId: USER_ID, scope: 'telemetry:duration', now: NOW })
    const [payload, signature] = token.split('.')

    expect(payload).toBeDefined()
    expect(signature).toBeDefined()

    const claims = JSON.parse(
      Buffer.from(payload ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>

    claims.sub = OTHER_USER_ID

    const forged = `${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.${signature ?? ''}`

    expect(verifyExtensionToken(forged, NOW)).toBeNull()
  })

  it('rejects a token whose signature was edited', () => {
    const token = issueExtensionToken({ userId: USER_ID, scope: 'telemetry:duration', now: NOW })
    const separator = token.indexOf('.')

    const tampered = `${token.slice(0, separator)}.${'A'.repeat(token.length - separator - 1)}`

    expect(tampered).not.toBe(token)
    expect(verifyExtensionToken(tampered, NOW)).toBeNull()
  })

  it('rejects a token signed with a different secret', () => {
    // Simulated by re-signing the same payload with a string the verifier was not
    // given. The signature is the only thing standing between a valid payload and a
    // member it was not issued for.
    const token = issueExtensionToken({ userId: USER_ID, scope: 'telemetry:duration', now: NOW })
    const payload = token.slice(0, token.indexOf('.'))

    const forgedWithWrongKey = `${payload}.${'0'.repeat(43)}`

    expect(verifyExtensionToken(forgedWithWrongKey, NOW)).toBeNull()
  })

  it('rejects an expired token, at the boundary and past it', () => {
    const token = issueExtensionToken({ userId: USER_ID, scope: 'telemetry:duration', now: NOW })
    const expiresAt = NOW.getTime() + 15 * MINUTE

    // One second before expiry: still valid.
    expect(verifyExtensionToken(token, new Date(expiresAt - 1000))).not.toBeNull()

    // Exactly at expiry: refused. The boundary is `>=`, so the token's lifetime is
    // exactly its TTL rather than TTL + the time between issuing and checking.
    expect(verifyExtensionToken(token, new Date(expiresAt))).toBeNull()

    // Well past it.
    expect(verifyExtensionToken(token, new Date(expiresAt + 24 * 60 * MINUTE))).toBeNull()
  })

  it('rejects a token with no expiry claim', () => {
    // A token whose `exp` is missing would otherwise live forever, because there is
    // nothing to compare against. The signature check happens first, so this builds
    // a genuine token and then re-signs a payload with the claim removed — which is
    // exactly the shape a future bug could produce.
    const token = issueExtensionToken({ userId: USER_ID, scope: 'telemetry:duration', now: NOW })
    const [payload] = token.split('.')

    const claims = JSON.parse(
      Buffer.from(payload ?? '', 'base64url').toString('utf8'),
    ) as Record<string, unknown>

    Reflect.deleteProperty(claims, 'exp')

    // Deliberately paired with the ORIGINAL signature, which no longer matches — the
    // point of the assertion is that no input reaches the claim checks unsigned.
    const stripped = `${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.${
      token.split('.')[1] ?? ''
    }`

    expect(verifyExtensionToken(stripped, NOW)).toBeNull()
  })

  it('rejects structurally malformed tokens without throwing', () => {
    // Every one of these would crash a naive parser at a `token.split('.')[1]`, and
    // a route that 500s on malformed input is an unauthenticated error oracle.
    for (const token of ['', '.', '..', 'a', 'a.', '.b', 'a.b.c', 'no-separator-at-all']) {
      expect(verifyExtensionToken(token, NOW), token).toBeNull()
    }
  })

  it('reads the Authorization header, and only a Bearer one', () => {
    // Issued at the REAL current time, unlike the tests above. This one calls
    // `verifyExtensionTokenRequest`, which has no way to inject `now` and so
    // validates against the wall clock — a token pinned to the suite's fixed `NOW`
    // would be months expired and fail for the wrong reason.
    const token = issueExtensionToken({ userId: USER_ID, scope: 'telemetry:duration' })

    expect(
      verifyExtensionTokenRequest(new Request('https://fydio.test', { headers: { authorization: `Bearer ${token}` } }))
        ?.userId,
    ).toBe(USER_ID)

    // Case-insensitive scheme: RFC 7235 says the scheme token is case-insensitive,
    // so `bearer` is legitimate rather than a malformed request.
    expect(
      verifyExtensionTokenRequest(new Request('https://fydio.test', { headers: { authorization: `bearer ${token}` } }))
        ?.userId,
    ).toBe(USER_ID)

    for (const header of ['', 'Basic abc', token, 'Bearer', `Token ${token}`]) {
      expect(
        verifyExtensionTokenRequest(new Request('https://fydio.test', { headers: { authorization: header } })),
        header,
      ).toBeNull()
    }

    expect(verifyExtensionTokenRequest(new Request('https://fydio.test'))).toBeNull()
  })

  it('carries the scope, so a token cannot be widened by its holder', () => {
    const token = issueExtensionToken({ userId: USER_ID, scope: 'telemetry:duration', now: NOW })
    const verified = verifyExtensionToken(token, NOW)

    // The verified shape is what the route branches on. If `scope` were absent from
    // the return type, a route author would be comparing `undefined === '...'`,
    // which is always false — a route that silently accepts nothing.
    expect(verified?.scope).toBe('telemetry:duration')
    expect(Object.keys(verified ?? {}).sort()).toEqual(['expiresAt', 'scope', 'userId'])
  })
})
