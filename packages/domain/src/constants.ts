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
