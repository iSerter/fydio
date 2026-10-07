import { z } from 'zod'

import {
  FEEDBACK_TAGS,
  type FeedbackTag,
  MAX_FEEDBACK_IMAGES,
  MIN_FEEDBACK_CHARS,
  MIN_RATING,
  MAX_RATING,
} from './constants.js'

/** Re-export for compatibility with T09 spec. */
export const feedbackTags = FEEDBACK_TAGS
export type { FeedbackTag }
export { MIN_RATING, MAX_RATING }

export const submitFeedbackSchema = z.object({
  entryId: z.uuid(),
  body: z
    .string()
    .trim()
    .min(10, 'Write at least 10 characters')
    .max(4000, 'Feedback must be 4000 characters or fewer'),
  tags: z.array(z.enum(FEEDBACK_TAGS)).max(7).default([]),
  imagePaths: z
    .array(z.string().min(1))
    .max(MAX_FEEDBACK_IMAGES, `Up to ${MAX_FEEDBACK_IMAGES} images`)
    .default([]),
})

export type SubmitFeedbackInput = z.infer<typeof submitFeedbackSchema>

/**
 * Quality gate mirrors the SQL: enough text OR at least one image.
 *
 * Short notes (>= 10 chars) are accepted into the database as ineligible,
 * but only notes meeting this quality gate qualify for pending credit evaluation.
 */
export function meetsQualityGate(
  body: string,
  imageCount: number,
  minChars: number = MIN_FEEDBACK_CHARS,
): boolean {
  return body.trim().length >= minChars || imageCount > 0
}

/* --- Moderation & Reporting ------------------------------------------------ */

export const REPORT_TARGETS = ['content_entry', 'feedback', 'user', 'hashtag'] as const
export type ReportTarget = (typeof REPORT_TARGETS)[number]

export const REPORT_REASONS: Record<ReportTarget, readonly string[]> = {
  content_entry: ['Spam', 'Off-topic', 'Broken or invalid link', 'Inappropriate', 'Other'],
  feedback: ['Abusive', 'Unhelpful or spam', 'Other'],
  user: ['Harassment', 'Spam', 'Impersonation', 'Other'],
  hashtag: ['Inappropriate', 'Spam', 'Other'],
}

export const submitReportSchema = z
  .object({
    targetType: z.enum(REPORT_TARGETS),
    targetId: z.string().min(1, 'Target ID is required'),
    reason: z.string().min(3, 'Reason must be at least 3 characters').max(200),
    details: z.string().max(2000).optional(),
  })
  .refine(
    (val) => {
      const valid = REPORT_REASONS[val.targetType]
      const norm = val.reason.toLowerCase().replace(/[^a-z0-9]/g, '_')
      return valid.some(
        (r) =>
          r.toLowerCase() === val.reason.toLowerCase() ||
          r.toLowerCase().replace(/[^a-z0-9]/g, '_') === norm,
      )
    },
    {
      message: 'Invalid reason for report target',
      path: ['reason'],
    },
  )

export type SubmitReportInput = z.infer<typeof submitReportSchema>

/* --- Lifecycle windows ---------------------------------------------------- */

export const DEFAULT_FEEDBACK_EDIT_GRACE_HOURS = 48
export const DEFAULT_RATING_REVISION_WINDOW_HOURS = 24

/** Check whether a feedback item is within its edit grace window. */
export function isWithinFeedbackEditGrace(
  createdAt: Date | string | number,
  graceHours: number = DEFAULT_FEEDBACK_EDIT_GRACE_HOURS,
  now: Date | number = Date.now(),
): boolean {
  const createdMs = typeof createdAt === 'object' ? createdAt.getTime() : new Date(createdAt).getTime()
  const nowMs = typeof now === 'object' ? now.getTime() : typeof now === 'number' ? now : Date.now()
  return nowMs - createdMs < graceHours * 3600 * 1000
}

/** Check whether a rating is within its 24-hour revision window. */
export function isWithinRatingRevisionWindow(
  createdAt: Date | string | number,
  windowHours: number = DEFAULT_RATING_REVISION_WINDOW_HOURS,
  now: Date | number = Date.now(),
): boolean {
  const createdMs = typeof createdAt === 'object' ? createdAt.getTime() : new Date(createdAt).getTime()
  const nowMs = typeof now === 'object' ? now.getTime() : typeof now === 'number' ? now : Date.now()
  return nowMs - createdMs < windowHours * 3600 * 1000
}

/* --- Canonical copy strings (checked by copy-guard) ----------------------- */

export const FEEDBACK_COPY = {
  composerHelper:
    'Helpful feedback earns a Fydio Credit (pending review) and builds your Reputation when the creator rates it.',
  toastEligible: 'Feedback shared — +1 Credit pending review',
  toastIneligible: 'Feedback shared',
  toastEditedEligible: 'Feedback updated — +1 Credit pending review',
  toastEditedIneligible: 'Feedback updated',
  portfolioNote: "Reputation is private signal, not a leaderboard — it can't be spent.",
  optionalDisclaimer: 'Feedback is optional, and you can skip or close this at any time.',
} as const
