/**
 * Duration telemetry vocabulary (T08).
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: Fydio stores a BAND, never a duration.
 * A millisecond count is a measurement of one person's afternoon; a band is a
 * sentence about whether they stayed long enough to be worth following up on.
 * Only the band crosses the network, only the band reaches the database, and
 * `classifyDurationMs` is the one place a raw number is allowed to exist — inside
 * the extension, at the moment it reports, where it is immediately discarded.
 *
 * WHY THE BANDS LIVE IN `@fydio/domain` AND NOT IN THE WEB APP. The extension
 * (T10) has to classify, the ingest route has to validate, and pgTAP has to
 * assert the stored values. Three consumers, two runtimes, so the vocabulary
 * cannot belong to either of them. It mirrors the `duration_band` enum in
 * `supabase/migrations/0001` and `current_duration_consent_version()` in 0025;
 * `apps/web/test/telemetry-isolation.test.ts` fails if the three drift apart.
 */

/**
 * Coarse active-tab time bands, in the enum's order.
 *
 * `'unknown'` is a real value rather than a nullable column: an event whose band
 * could not be determined is still an event that happened, and storing `null`
 * would make "we did not know" indistinguishable from "we stored nothing".
 */
export const DURATION_BANDS = ['lt_15s', 's15_60', 'm1_3', 'gt_3', 'unknown'] as const

export type DurationBand = (typeof DURATION_BANDS)[number]

/**
 * What each band means, for the member reading their own history.
 *
 * Plain-language on purpose. "1–3 minutes" is a range a person recognises from
 * their own life; "m1_3" is a database value, and this panel is the one place a
 * member sees the vocabulary rather than the storage.
 */
export const DURATION_BAND_LABELS: Record<DurationBand, string> = {
  lt_15s: 'under 15 seconds',
  s15_60: '15 seconds to a minute',
  m1_3: '1 to 3 minutes',
  gt_3: 'more than 3 minutes',
  unknown: 'not recorded',
}

/**
 * Boundary values in milliseconds, in band order.
 *
 * Exported rather than inlined in the classifier because the ingest route's
 * tests and the pgTAP band assertions both need to state the same boundaries
 * independently — a classifier and a test that share a constant cannot disagree,
 * and that is the point.
 */
export const DURATION_BAND_BOUNDS_MS = {
  lt_15s: 15_000,
  s15_60: 60_000,
  m1_3: 180_000,
} as const

/**
 * The consent text a member agreed to.
 *
 * Bumping this string invalidates every existing grant and every event recorded
 * under it, which is the point: consent is to a SPECIFIC description, so a
 * change to what is collected must re-ask rather than inherit. Mirrored by
 * `current_duration_consent_version()` in migration 0025.
 */
export const DURATION_CONSENT_VERSION = '2026-01-dur-v1'

/**
 * How long a return token stays valid.
 *
 * Thirty minutes is long enough that someone can read a post, walk away, come
 * back and still be offered the feedback prompt, and short enough that a token
 * pasted into a chat somewhere next month does nothing. The token is
 * viewer-scoped as well, so expiry is the second lock rather than the only one.
 */
export const RETURN_TOKEN_TTL_MINUTES = 30

/**
 * Classify a raw active-tab duration into a band.
 *
 * EXISTS ONLY TO BE CALLED AND THROTTEN AWAY. The number it takes is never
 * returned, never logged, and never sent anywhere: the return value is the whole
 * message. Keeping the input and the output different types is what stops a
 * future caller from "helpfully" persisting the argument.
 *
 * Boundaries are lower-inclusive, so `15_000` is `s15_60` and `15_000` is not
 * `lt_15s`. Anything that is not a finite, non-negative number — a negative
 * clock reading, `NaN`, `Infinity`, a string that survived a cast — is
 * `'unknown'`. Clamping to a band we can defend beats reporting a precise range
 * derived from a number we do not trust.
 */
export function classifyDurationMs(rawMs: number): DurationBand {
  if (!Number.isFinite(rawMs) || rawMs < 0) return 'unknown'

  const { lt_15s, s15_60, m1_3 } = DURATION_BAND_BOUNDS_MS

  if (rawMs < lt_15s) return 'lt_15s'
  if (rawMs < s15_60) return 's15_60'
  if (rawMs < m1_3) return 'm1_3'

  return 'gt_3'
}

/**
 * Narrow an untrusted value to a band, mapping anything else to `'unknown'`.
 *
 * This is the boundary the ingest route uses: the extension is a browser process
 * the member could have modified, so its `band` arrives as a plain string. The
 * zod schema already rejects a non-enum value, and this exists for the same
 * reason a belt and braces exist — the guarantee "an out-of-enum band is stored
 * as `'unknown'`" should not depend on a single validation layer being the one
 * that holds.
 */
export function coerceDurationBand(raw: unknown): DurationBand {
  return typeof raw === 'string' && (DURATION_BANDS as readonly string[]).includes(raw)
    ? (raw as DurationBand)
    : 'unknown'
}

/**
 * The member-facing consent copy, in one place.
 *
 * The privacy panel and the extension's consent screen both render THIS string,
 * so the two cannot describe different scopes. Narrow on purpose: a rough range,
 * private to you, for your own history and feed tuning, never affecting Credits
 * or Reputation, revocable, deletable.
 */
export const DURATION_CONSENT_COPY =
  'Fydio can record how long you keep a Fydio-opened tab active, as a rough range only. ' +
  'This is private to you, used for your own history and to tune your feed, and never ' +
  'affects Credits or Reputation. You can turn this off and delete past records at any time.'

/**
 * The one sentence that must appear wherever the toggle is offered.
 *
 * Extracted rather than retyped so a test can assert the disclaimer is present
 * wherever consent is asked for, rather than trusting review to notice its
 * absence.
 */
export const DURATION_CONSENT_DISCLAIMER =
  'Private to you. Never affects Credits or Reputation. Turn it off or delete past records at any time.'
