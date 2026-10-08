import { z } from 'zod'

/**
 * Crockford Base-32 Alphabet (T11 §5.2).
 *
 * 32 symbols: digits 0-9 and uppercase letters excluding I, L, O, and U.
 * Excluded to prevent visual ambiguity (1/I/L and 0/O) and accidental obscenity (U).
 */
export const INVITE_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' as const

export const MIN_INVITE_CODE_LENGTH = 16
export const MAX_INVITE_CODE_LENGTH = 32
export const DEFAULT_INVITE_CODE_LENGTH = 20

const INVITE_CODE_REGEX = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/

/**
 * Normalise a raw invite code according to Crockford base-32 rules (T11 §5.2).
 *
 *  - Strips leading/trailing and embedded whitespace
 *  - Upper-cases all letters
 *  - Folds look-alike characters: I -> 1, L -> 1, O -> 0, U -> V
 *  - Rejects any character not in the Crockford base-32 alphabet
 */
export function normalizeInviteCode(raw: string): string {
  if (typeof raw !== 'string') {
    throw new Error('Invite code must be a string')
  }

  // Remove whitespace and uppercase
  const cleaned = raw.replace(/\s+/g, '').toUpperCase()

  if (cleaned.length === 0) {
    throw new Error('Invite code cannot be empty')
  }

  // Fold I/L -> 1, O -> 0, U -> V
  let folded = ''
  for (const char of cleaned) {
    if (char === 'I' || char === 'L') {
      folded += '1'
    } else if (char === 'O') {
      folded += '0'
    } else if (char === 'U') {
      folded += 'V'
    } else {
      folded += char
    }
  }

  if (!INVITE_CODE_REGEX.test(folded)) {
    throw new Error('Invite code contains disallowed characters')
  }

  return folded
}

/**
 * Zod schema for Crockford base-32 invite codes.
 *
 * Normalises input before verifying length constraints (16-32 chars).
 */
export const inviteCodeSchema = z
  .string()
  .transform((val, ctx) => {
    try {
      return normalizeInviteCode(val)
    } catch {
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid invite code format',
      })
      return z.NEVER
    }
  })
  .pipe(
    z
      .string()
      .min(MIN_INVITE_CODE_LENGTH, `Invite code must be at least ${MIN_INVITE_CODE_LENGTH} characters`)
      .max(MAX_INVITE_CODE_LENGTH, `Invite code cannot exceed ${MAX_INVITE_CODE_LENGTH} characters`),
  )

/**
 * Generate a cryptographically random, unbiased Crockford base-32 invite code (T11 §5.2, §9).
 *
 * Uses `globalThis.crypto.getRandomValues` for platform-agnostic CSPRNG entropy.
 * Employs unbiased rejection sampling so the character distribution is strictly uniform.
 */
export function generateInviteCode(length: number = DEFAULT_INVITE_CODE_LENGTH): string {
  if (!Number.isInteger(length) || length < MIN_INVITE_CODE_LENGTH || length > MAX_INVITE_CODE_LENGTH) {
    throw new Error(
      `Invite code length must be an integer between ${MIN_INVITE_CODE_LENGTH} and ${MAX_INVITE_CODE_LENGTH}`,
    )
  }

  const alphabet = INVITE_CODE_ALPHABET
  const alphabetLen = alphabet.length
  // For alphabet length 32, 256 is an exact multiple (32 * 8 = 256), but rejection sampling
  // formula is kept generic so it does not depend on alphabet length.
  const maxValid = 256 - (256 % alphabetLen)

  let result = ''
  const buffer = new Uint8Array(length * 2)

  while (result.length < length) {
    globalThis.crypto.getRandomValues(buffer)
    for (const byte of buffer) {
      if (result.length >= length) break
      if (byte < maxValid) {
        const char = alphabet[byte % alphabetLen]
        if (char !== undefined) {
          result += char
        }
      }
    }
  }

  return result
}
