/**
 * Hard product constants.
 *
 * These are the numbers the brief treats as product rules, not tunables:
 * five profile hashtags is a hard maximum, a content entry carries exactly
 * three, feedback takes at most three images, and a rating is 1–10. They live
 * here so the web app, the extension and the SQL in T02/T07 cannot disagree.
 */

/** Profile hashtags: the hard maximum from the brief. */
export const MAX_PROFILE_HASHTAGS = 5

/** A content entry carries exactly this many hashtags — no more, no fewer. */
export const EXACT_CONTENT_HASHTAGS = 3

/** Images attached to a single feedback item. */
export const MAX_FEEDBACK_IMAGES = 3

/** Feedback text minimum length, in characters. */
export const MIN_FEEDBACK_CHARS = 40

/** Rating bounds. Zero is not a rating, and eleven is not enthusiasm. */
export const MIN_RATING = 1
export const MAX_RATING = 10

/* --- Profile (T03) ---------------------------------------------------------------- */

/**
 * Display-name bounds.
 *
 * The database CHECK allows 1-80, but the product asks for 2-60. The narrower rule lives
 * here rather than in the schema because it is a product decision about how a name reads
 * in a profile card, not a storage concern -- and because the wizard needs to reject a
 * one-character name before the member reaches the confirmation step.
 */
export const MIN_DISPLAY_NAME_CHARS = 2
export const MAX_DISPLAY_NAME_CHARS = 60

/** A short self-description. Optional, but bounded when present. */
export const MAX_BIO_CHARS = 280

/**
 * Hashtag slug bounds.
 *
 * The canonical separator is `-`, matching the seeded vocabulary (`hook-analysis`,
 * `color-grading`). Both `-` and `_` are accepted on input and collapsed to `-`, so
 * `snake_case` and `snake-case` are one tag rather than two half-used ones.
 *
 * These MUST stay equal to `hashtag_slug_format` in supabase/migrations/0002 and to
 * `normalize_hashtag` in 0012. The pgTAP suite asserts every seeded slug round-trips, so
 * a divergence here fails the database tests rather than silently producing tags the
 * picker cannot find.
 */
export const MIN_HASHTAG_CHARS = 2
export const MAX_HASHTAG_CHARS = 40

/** New hashtags one member may create per day. Vocabulary-spam guard. */
export const HASHTAG_DAILY_CREATION_CAP = 5

/** Friend requests one member may send per hour. */
export const FRIEND_REQUEST_HOURLY_CAP = 10

/** Avatar upload limits, enforced before the bytes reach Storage. */
export const MAX_AVATAR_UPLOAD_BYTES = 5 * 1024 * 1024
export const AVATAR_OUTPUT_SIZE = 512
export const MAX_AVATAR_OUTPUT_BYTES = 200 * 1024

/** The MIME types the avatar route will accept. */
export const AVATAR_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const

export type AvatarMimeType = (typeof AVATAR_MIME_TYPES)[number]

/** Platforms Fydio accepts links for, in the order they appear in the UI. */
export const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x'] as const

export type Platform = (typeof PLATFORMS)[number]

/** Display names, so the UI never has to title-case a slug itself. */
export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: 'Instagram',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  x: 'X',
}

/**
 * The structured feedback vocabulary.
 *
 * Feedback is tagged rather than free-form so a creator can see *what kind* of
 * critique they are getting. The order is the order they appear in the composer.
 */
export const FEEDBACK_TAGS = [
  'hook',
  'clarity',
  'editing',
  'storytelling',
  'thumbnail',
  'cta',
  'audience_fit',
] as const

export type FeedbackTag = (typeof FEEDBACK_TAGS)[number]

export const FEEDBACK_TAG_LABELS: Record<FeedbackTag, string> = {
  hook: 'Hook',
  clarity: 'Clarity',
  editing: 'Editing',
  storytelling: 'Storytelling',
  thumbnail: 'Thumbnail',
  cta: 'Call to action',
  audience_fit: 'Audience fit',
}

/**
 * Why an item appears in the feed.
 *
 * Every ranked item carries at least one reason so the UI can explain itself —
 * "transparent ranking" is a product principle, not a nice-to-have.
 */
export const FEED_REASONS = ['shared_hashtag', 'friend', 'fresh', 'new_creator'] as const

export type FeedReason = (typeof FEED_REASONS)[number]

export const FEED_REASON_LABELS: Record<FeedReason, string> = {
  shared_hashtag: 'Matches your hashtags',
  friend: 'Shared by a friend',
  fresh: 'Recently shared',
  new_creator: 'From a new creator',
}

/**
 * The two community signals, named distinctly.
 *
 * Credits are spendable; Reputation is not. They are never interchangeable, and
 * the product brief is explicit that calling either of them "points" makes a
 * quality signal feel like money — so there is deliberately no generic term here
 * for both.
 */
export const CREDIT_LABEL = 'Credits'
export const CREDIT_LABEL_LONG = 'Fydio Credits'
export const REPUTATION_LABEL = 'Reputation'
export const REPUTATION_LABEL_LONG = 'Feedback Reputation'
