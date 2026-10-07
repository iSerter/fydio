import 'server-only'

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { getServerEnv } from '@fydio/env/server'

/**
 * Extension token verification (T08), shared with T10.
 *
 * WHY THE EXTENSION NEEDS A TOKEN RATHER THAN A SESSION. The browser companion
 * runs on `chrome://` and has no access to Fydio's cookies — and even if it could
 * read them, handing a page extension the member's full session would let any
 * bug in it act as the member everywhere, not just for telemetry. A token that is
 * scoped to one job and expires on its own limits the damage to "this member's
 * duration bands, until this timestamp".
 *
 * FORMAT. Three dot-separated parts, JWT-shaped but deliberately not a JWT:
 *
 *     base64url(payload) "." base64url(hmac_sha256(payload))
 *
 * No header, no `alg`, no `typ`. A JWT's flexibility is a liability here: an
 * implementation that honours the header's algorithm choice is one `alg: none`
 * away from accepting unsigned tokens. With no header there is nothing to
 * negotiate — the algorithm is the only one this function implements, and the
 * signature is verified before the payload is parsed.
 *
 * `node:crypto`, not `crypto.subtle`: this is a Route Handler running on Node,
 * and the sync HMAC keeps verification to a handful of microseconds. It also
 * means `timingSafeEqual` is available, which is the whole reason the signature
 * comparison is constant-time.
 */

/** Milliseconds in a second, named because the arithmetic below reads better with it. */
const SECOND_MS = 1000

/**
 * How long an extension token stays valid.
 *
 * Short, because the only thing it authorises is appending one row. T10 refreshes
 * it from a session the extension obtains through a normal Fydio page; nothing
 * long-lived depends on the token continuing to work, so there is no reason for
 * it to.
 */
export const EXTENSION_TOKEN_TTL_SECONDS = 15 * 60

/**
 * The jobs a token may be scoped to.
 *
 * A closed union rather than a free string: the scope is what makes the token
 * scoped, and a typo in a scope name would otherwise produce a token that grants
 * nothing (or, worse, that a later `if (scope)` treats as a wildcard).
 */
export const EXTENSION_TOKEN_SCOPES = ['telemetry:duration'] as const

export type ExtensionTokenScope = (typeof EXTENSION_TOKEN_SCOPES)[number]

/** What a verified token tells the caller. Nothing else is trusted from the wire. */
export interface VerifiedExtensionToken {
  readonly userId: string
  readonly scope: ExtensionTokenScope
  readonly expiresAt: Date
}

/** The payload as it travels, before signature verification. Never trusted. */
interface TokenClaims {
  /** Member id. */
  readonly sub: string
  readonly scope: string
  /** Issued-at, seconds since epoch. Informational. */
  readonly iat: number
  /** Expiry, seconds since epoch. Authoritative. */
  readonly exp: number
  /**
   * A random per-token value.
   *
   * An HMAC is deterministic, so two tokens issued for the same member, scope, and
   * second would otherwise be byte-identical. That is not a vulnerability on its
   * own — the claims are the same, so a replay buys nothing extra — but it makes a
   * captured token indistinguishable from every other copy of itself, which is a
   * poor property for a credential. A nonce costs 16 bytes and makes each token
   * unique, so one can be correlated with the request that used it.
   */
  readonly jti: string
}

/**
 * The signing secret, or `null` when unconfigured.
 *
 * `null` rather than a throw: an operator who has not set the secret yet should
 * get a 503 from the route that needs it ("not configured"), not a 500 from a
 * helper. The same shape as `refuseCron`'s `CRON_SECRET` handling.
 *
 * `EXTENSION_TOKEN_SECRET` is already declared as `min(32)` optional in
 * `@fydio/env`'s schema, so a short secret fails validation at boot rather than
 * producing weak HMACs here.
 */
function signingSecret(): string | null {
  return getServerEnv().EXTENSION_TOKEN_SECRET ?? null
}

/**
 * Base64url without padding.
 *
 * Hand-rolled rather than `Buffer.toString('base64url')` so the encoding is
 * explicit about the two properties that matter: URL-safe alphabet (so a token
 * survives being a query parameter) and no `=` padding (so it needs no escaping
 * either). `Buffer.from(x, 'base64url')` decodes both, so the wire format stays
 * conventional.
 */
function encodeSegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

/** Inverse of {@link encodeSegment}. */
function decodeSegment(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8')
}

/**
 * The HMAC over the encoded payload.
 *
 * The SIGNED STRING IS THE ENCODED PAYLOAD, not the decoded JSON. Signing the
 * bytes that travel means verification re-serialises nothing, so there is no
 * canonicalisation question — a payload that decodes to two different JSON
 * strings cannot produce two different valid signatures.
 */
function sign(payloadSegment: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadSegment).digest('base64url')
}

/**
 * Constant-time signature comparison.
 *
 * `timingSafeEqual` throws on a length mismatch, so lengths are compared first —
 * and that early return leaks only the length of the signature, which is fixed
 * by the algorithm and therefore not a secret.
 */
function signaturesMatch(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(presented, 'utf8')

  if (a.length !== b.length) return false

  return timingSafeEqual(a, b)
}

/**
 * Mint a token for a member. Used by T10's provisioning route and by tests.
 *
 * Exported from a server-only module, so it cannot be reached from a Client
 * Component — the signing key must never travel to a browser.
 */
export function issueExtensionToken(input: {
  readonly userId: string
  readonly scope: ExtensionTokenScope
  readonly ttlSeconds?: number
  readonly now?: Date
}): string {
  const secret = signingSecret()

  if (secret === null) {
    throw new Error('EXTENSION_TOKEN_SECRET is not configured')
  }

  const now = input.now ?? new Date()
  const ttl = input.ttlSeconds ?? EXTENSION_TOKEN_TTL_SECONDS

  const claims: TokenClaims = {
    sub: input.userId,
    scope: input.scope,
    iat: Math.floor(now.getTime() / SECOND_MS),
    exp: Math.floor(now.getTime() / SECOND_MS) + ttl,
    // `randomBytes`, not `randomUUID`: the value's only job is to make the signed
    // payload differ between two otherwise identical tokens, and 16 hex-encoded
    // bytes is enough for that at a fraction of the UUID's text.
    jti: randomBytes(16).toString('hex'),
  }

  const payload = encodeSegment(JSON.stringify(claims))

  return `${payload}.${sign(payload, secret)}`
}

/**
 * Verify a token and return what it authorises, or `null` for any failure.
 *
 * EVERY failure is `null`. An expired token, a forged signature, a truncated
 * token, a token that is not JSON, a token whose scope is not one we issue, and a
 * token signed with a different secret are indistinguishable to the caller — and
 * that is deliberate. A caller that could tell "wrong signature" from "expired"
 * could use the difference to probe, and the route would have to leak those
 * distinctions into its status codes.
 *
 * ORDER MATTERS. The signature is checked BEFORE the payload is parsed. Parsing
 * first would mean interpreting attacker-controlled JSON before knowing whether
 * the sender was authorised, and `JSON.parse` on untrusted input is a place where
 * a future change could go wrong.
 *
 * `now` is injectable so the expiry boundary is testable without sleeping.
 */
export function verifyExtensionToken(token: string, now: Date = new Date()): VerifiedExtensionToken | null {
  const secret = signingSecret()

  if (secret === null) return null

  const separator = token.indexOf('.')

  // No separator, or an empty segment on either side: not our format.
  if (separator <= 0 || separator === token.length - 1) return null

  const payloadSegment = token.slice(0, separator)
  const signature = token.slice(separator + 1)

  if (!signaturesMatch(sign(payloadSegment, secret), signature)) return null

  let claims: unknown

  try {
    claims = JSON.parse(decodeSegment(payloadSegment))
  } catch {
    // A valid signature over something that is not JSON means the secret is in
    // the hands of someone who should not have it, or the token was minted by a
    // different version of this module. Either way: refuse.
    return null
  }

  if (typeof claims !== 'object' || claims === null) return null

  const { sub, scope, exp } = claims as Partial<TokenClaims>

  if (typeof sub !== 'string' || sub.length === 0) return null
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null
  if (!isExtensionTokenScope(scope)) return null

  // Expiry is `>=`-inclusive at the boundary: a token is valid up to the instant
  // it expires and not after. A token expiring "now" has no remaining use, and
  // treating it as valid would make the lifetime `ttl + 1` seconds depending on
  // when the check happened to run.
  if (Math.floor(now.getTime() / SECOND_MS) >= exp) return null

  return { userId: sub, scope, expiresAt: new Date(exp * SECOND_MS) }
}

/** Narrow an untrusted scope claim to one we issue. */
function isExtensionTokenScope(value: unknown): value is ExtensionTokenScope {
  return typeof value === 'string' && (EXTENSION_TOKEN_SCOPES as readonly string[]).includes(value)
}

/**
 * Verify the `Authorization` header on a request.
 *
 * Returns `null` for a missing, malformed, or unrecognised header — including one
 * using a scheme other than `Bearer`. Accepting more than one scheme here would
 * be a decision the route should make explicitly, and there is no second scheme
 * to support.
 */
export function verifyExtensionTokenRequest(request: Request): VerifiedExtensionToken | null {
  const header = request.headers.get('authorization')

  if (header === null) return null

  const prefix = 'bearer '

  if (!header.toLowerCase().startsWith(prefix)) return null

  const token = header.slice(prefix.length).trim()

  if (token.length === 0) return null

  return verifyExtensionToken(token)
}
