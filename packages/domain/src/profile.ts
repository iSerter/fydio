import { z } from 'zod'

import { detectPlatform } from './platforms.js'
import {
  MAX_AVATAR_UPLOAD_BYTES,
  MAX_BIO_CHARS,
  MAX_DISPLAY_NAME_CHARS,
  MAX_HASHTAG_CHARS,
  MAX_PROFILE_HASHTAGS,
  MIN_DISPLAY_NAME_CHARS,
  MIN_HASHTAG_CHARS,
  PLATFORMS,
  type Platform,
} from './constants.js'

/**
 * Profile rules (T03).
 *
 * This module is the TypeScript half of a three-way agreement: it, the `hashtags` schema
 * CHECK in migration 0002, and `normalize_hashtag` in 0012 all describe the same slug
 * grammar. They have to agree, because a tag the client will accept but the database
 * rejects surfaces as an opaque constraint error mid-onboarding.
 *
 * The tests in `profile.test.ts` and the pgTAP assertions in `005_friendships.sql` exist to
 * make a divergence loud rather than subtle.
 */

/**
 * Normalise a hashtag the same way `normalize_hashtag` does.
 *
 * Deliberately NOT reusing `validation.ts`'s `hashtagSchema`, which validates but does not
 * canonicalise: it accepts both `-` and `_` and keeps whichever was typed, so `#Hook_Analysis`
 * and `hook-analysis` would pass as distinct tags. This function returns the single canonical
 * spelling, which is what the picker and the create RPC both need.
 *
 * Returns `null` for input that cannot become a valid slug, rather than throwing -- callers
 * are UI inputs that need a message, not an exception.
 */
export function normalizeHashtagSlug(raw: string): string | null {
  const lowered = raw.trim().toLowerCase().replace(/^#+/, '')

  // Collapse every run of non-alphanumeric, non-separator characters into one hyphen.
  let slug = lowered.replace(/[^a-z0-9_-]+/g, '-')

  // One canonical separator, never doubled.
  slug = slug.replace(/[-_]+/g, '-')

  // Neither end may be a separator.
  slug = slug.replace(/^-+/, '').replace(/-+$/, '')

  if (slug.length < MIN_HASHTAG_CHARS || slug.length > MAX_HASHTAG_CHARS) return null

  return slug
}

/** A display name, trimmed and bounded. */
export const displayNameSchema = z
  .string()
  .trim()
  .min(MIN_DISPLAY_NAME_CHARS, `Pick at least ${MIN_DISPLAY_NAME_CHARS} characters`)
  .max(MAX_DISPLAY_NAME_CHARS, `Keep it under ${MAX_DISPLAY_NAME_CHARS} characters`)

/**
 * A short bio.
 *
 * Optional, but a blank string must become `null` rather than `''` -- the column is
 * nullable and an empty string would render as an empty paragraph on the profile card.
 */
export const bioSchema = z
  .string()
  .trim()
  .max(MAX_BIO_CHARS, `Keep your bio under ${MAX_BIO_CHARS} characters`)
  .transform((value) => (value.length === 0 ? null : value))
  .nullable()
  .optional()

/**
 * A handle, normalised the way the database CHECK expects.
 *
 * The column is `citext` with a `^[a-z0-9_]{3,30}$` check, so case is already
 * case-insensitive at the storage layer. Normalising here keeps the URL a member shares
 * matching the one in the address bar.
 */
export const handleSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,30}$/, 'Handles use 3-30 lowercase letters, numbers or underscores')

export function normalizeHandle(raw: string): string {
  return raw.trim().toLowerCase()
}

/**
 * A public profile link for a supported platform.
 *
 * The platform is DETECTED from the URL rather than chosen by the member. Letting someone
 * file an Instagram URL under "TikTok" would show a mismatched label on their profile and
 * make the link look broken to a reader, so `superRefine` reports it instead.
 *
 * Fydio never asks for a third-party credential -- these are public URLs shown as
 * "elsewhere", which is why they are optional and why nothing here reads a token.
 */
export const profileLinkSchema = z.object({
  platform: z.enum(PLATFORMS),
  url: z.url('Enter a valid link'),
  label: z.string().trim().max(60).optional(),
})

/**
 * At most one link per platform.
 *
 * Mirrors the `unique (profile_id, platform)` constraint on `profile_links`, so a
 * duplicate is caught in the form rather than as a constraint violation on save.
 */
export const profileLinksSchema = z
  .array(profileLinkSchema)
  .max(PLATFORMS.length, `Add at most one link per platform`)
  .superRefine((links, ctx) => {
    const seen = new Set<Platform>()

    links.forEach((link, index) => {
      const detected = detectPlatform(link.url)

      if (detected === null) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'url'],
          message: 'That link is not on a platform Fydio recognises',
        })
        return
      }

      if (detected !== link.platform) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'platform'],
          message: `That URL looks like ${detected}, not ${link.platform}`,
        })
        return
      }

      if (seen.has(link.platform)) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'platform'],
          message: 'You already added a link for this platform',
        })
      }

      seen.add(link.platform)
    })
  })

/**
 * The whole onboarding draft.
 *
 * Step-scoped partials are NOT modelled here. The wizard collects one step at a time and
 * each step validates on its own, so a single all-or-nothing schema would force the member
 * to satisfy step 5 before step 1 would accept anything. The final submission uses
 * `onboardingSchema` with `hashtags` at its exact length.
 */
export const onboardingSchema = z.object({
  displayName: displayNameSchema,
  bio: bioSchema,
  hashtags: z
    .array(z.uuid())
    .length(MAX_PROFILE_HASHTAGS, `Choose exactly ${MAX_PROFILE_HASHTAGS} hashtags`),
  links: profileLinksSchema.default([]),
})

export type OnboardingInput = z.input<typeof onboardingSchema>
export type OnboardingDraft = z.output<typeof onboardingSchema>

/** The editable profile form. Hashtags may be fewer than five here. */
export const profileEditSchema = z.object({
  displayName: displayNameSchema,
  bio: bioSchema,
  hashtags: z.array(z.uuid()).max(MAX_PROFILE_HASHTAGS).default([]),
  links: profileLinksSchema.default([]),
})

export type ProfileEditInput = z.input<typeof profileEditSchema>

/**
 * Is this an avatar we will accept?
 *
 * Checks the declared MIME type and size only. It cannot prove the bytes really are a
 * JPEG -- a caller can label anything `image/jpeg` -- which is exactly why the upload
 * route also re-encodes with `sharp`: decoding fails on a non-image, so the declared type
 * is a cheap first gate rather than the real one.
 */
export function isAcceptableAvatar(file: { type: string; size: number }): boolean {
  return describeAvatarRejection(file) === null
}

/**
 * A readable explanation for a rejected upload, or `null` when it is acceptable.
 *
 * Separate from `isAcceptableAvatar` so the route and the client component render the same
 * wording from the same rule rather than each describing the limit in their own words.
 */
export function describeAvatarRejection(file: {
  type: string
  size: number
}): string | null {
  const allowed = new Set<string>(['image/jpeg', 'image/png', 'image/webp'])

  if (!allowed.has(file.type)) return 'Use a JPEG, PNG or WebP image'
  if (file.size === 0) return 'That file is empty'
  if (file.size > MAX_AVATAR_UPLOAD_BYTES) return 'Images must be 5 MB or smaller'

  return null
}