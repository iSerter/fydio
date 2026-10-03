import { z } from 'zod'

import {
  EXACT_CONTENT_HASHTAGS,
  MAX_FEEDBACK_IMAGES,
  MAX_PROFILE_HASHTAGS,
  MAX_RATING,
  MIN_FEEDBACK_CHARS,
  MIN_RATING,
  PLATFORMS,
} from './constants.js'

/**
 * Hashtag validation.
 *
 * A hashtag is a lowercase slug: letters, digits and single separators. The
 * leading `#` is stripped on input and never stored, so `#Design` and `design`
 * cannot become two different tags in the pool.
 */
const hashtagSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^#+/, '').toLowerCase())
  .pipe(
    z
      .string()
      .min(1, 'Hashtag cannot be empty')
      .max(40, 'Hashtag is too long')
      .regex(
        /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/,
        'Use letters, numbers and single dashes or underscores',
      ),
  )

/** Up to five, deduplicated. Five is the hard maximum from the brief. */
export const profileHashtagsSchema = z
  .array(hashtagSchema)
  .max(MAX_PROFILE_HASHTAGS, `A profile may have at most ${MAX_PROFILE_HASHTAGS} hashtags`)
  .transform((tags) => [...new Set(tags)])

/**
 * Exactly three.
 *
 * `.length()` rather than `.min()/.max()` because the brief is explicit that a
 * content entry carries three — not "up to three" — and a two-tag entry should
 * fail the form before it reaches the credit-debiting RPC.
 */
export const contentHashtagsSchema = z
  .array(hashtagSchema)
  .length(
    EXACT_CONTENT_HASHTAGS,
    `A content entry must have exactly ${EXACT_CONTENT_HASHTAGS} hashtags`,
  )
  .transform((tags) => [...new Set(tags)])

/** Optional structured feedback. */
export const feedbackSchema = z.object({
  body: z
    .string()
    .trim()
    .min(MIN_FEEDBACK_CHARS, `Feedback should be at least ${MIN_FEEDBACK_CHARS} characters`)
    .max(4000, 'Feedback is too long'),
  tags: z.array(
    z.enum(['hook', 'clarity', 'editing', 'storytelling', 'thumbnail', 'cta', 'audience_fit']),
  ),
  imagePaths: z
    .array(z.string().min(1))
    .max(MAX_FEEDBACK_IMAGES, `At most ${MAX_FEEDBACK_IMAGES} images`)
    .default([]),
})

/** A 1–10 rating. Zero is not a rating; eleven is not enthusiasm. */
export const ratingSchema = z.coerce.number().int().min(MIN_RATING).max(MAX_RATING)

/** A submitted content link, before platform detection. */
export const contentSubmissionSchema = z.object({
  url: z.url('Enter a valid link'),
  hashtags: contentHashtagsSchema,
  comment: z.string().trim().max(280).optional(),
})

/** Profile onboarding. */
export const profileSchema = z.object({
  displayName: z.string().trim().min(1, 'Pick a display name').max(60),
  bio: z.string().trim().max(280).optional(),
  avatarPath: z.string().optional(),
  coverPath: z.string().optional(),
  hashtags: profileHashtagsSchema,
  /** Optional public creator handles/URLs, shown as "elsewhere". */
  externalLinks: z.array(z.url()).max(5).default([]),
})

export const PLATFORM_ENUM = z.enum(PLATFORMS)

export type FeedbackInput = z.infer<typeof feedbackSchema>
export type ContentSubmission = z.infer<typeof contentSubmissionSchema>
export type ProfileInput = z.infer<typeof profileSchema>
