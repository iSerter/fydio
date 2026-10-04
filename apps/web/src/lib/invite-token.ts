/**
 * Invite token hashing, shared by the accept route and the admin issuing script.
 *
 * Deliberately NOT in `packages/domain`: that package's header promises it touches no Node
 * built-ins, and `node:crypto` is a Node built-in. Importing this from a Client Component
 * would also pull it into the browser bundle, where it would fail to resolve.
 */
import { createHash, randomBytes } from 'node:crypto'

/**
 * A fresh raw invite token.
 *
 * 32 bytes of CSPRNG output, hex-encoded to 64 characters. The raw value goes into the
 * emailed link and is NEVER stored or logged -- only its digest is persisted, so a leaked
 * database yields nothing redeemable.
 */
export function generateInviteToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * The SHA-256 digest of a token, as the lowercase hex string `claim_invite` compares.
 *
 * Accepts the RAW token, never a digest, so no caller has to remember which form the
 * database wants -- the mistake that would otherwise produce a permanent "Invalid invite"
 * with no clue why. `claim_invite` decodes this hex back to bytes and compares against
 * `invites.token_hash`.
 */
export function hashInviteToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

/**
 * The digest in the `\\x`-prefixed hex form PostgREST needs for a `bytea` comparison.
 *
 * `invites.token_hash` is `bytea`. A bare hex string sent as a query parameter is compared as
 * TEXT, so it matches nothing and every redemption reports "Invalid invite" -- with no error
 * anywhere to indicate why. The `\\x` prefix is what tells Postgres to read the value as hex
 * bytes, which is how the issuing script writes it and how `claim_invite` decodes it.
 *
 * Both forms are derived from one function so they cannot drift: `hashInviteToken` for the SQL
 * side (which wants plain hex to `decode()`), this for the PostgREST side.
 */
export function inviteTokenHashParam(rawToken: string): string {
  return `\\x${hashInviteToken(rawToken)}`
}