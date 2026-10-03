/**
 * Narrow row and enum aliases over the generated `Database` type.
 *
 * These exist so application code writes `type Profile = Tables<'profiles'>` rather
 * than the twelve-line shape, and so a schema change surfaces as a compile error at
 * every use site instead of drifting silently.
 *
 * WHERE THIS FILE LIVES MATTERS
 *
 * The task brief suggested `packages/domain/src/db-types.ts`. That is the wrong
 * package, for a reason that is already written into `@fydio/domain`'s own header:
 *
 *   "Nothing here touches React, Next.js, Supabase or `process.env`."
 *
 * Putting these types in `domain` would either add `@fydio/supabase` as a dependency
 * — pulling `@supabase/supabase-js` and `server-only` into the Chrome extension, which
 * depends on `domain` and must stay bundle-free — or duplicate the types. Keeping
 * them here preserves the boundary and the extension's build.
 *
 * Every alias is a direct re-export rather than a hand-written shape, so there is no
 * second definition to fall out of date.
 */
import type { Database, Enums, Tables, TablesInsert } from './types.js'

/* --- Identity ------------------------------------------------------------------ */

export type Profile = Tables<'profiles'>

/**
 * A row to insert.
 *
 * `TablesInsert<'profiles'>` is the correct helper here — `Tables<'profiles', …>`
 * with a schema option constrains `TableName` to `never`, because the second type
 * parameter only exists for the schema form. Spelled out rather than derived with a
 * conditional type so the alias reads as the thing it is.
 */
export type ProfileInsert = TablesInsert<'profiles'>

export type Invite = Tables<'invites'>
export type Friendship = Tables<'friendships'>
export type ProfileLink = Tables<'profile_links'>
export type ProfileHashtag = Tables<'profile_hashtags'>

/* --- Content ------------------------------------------------------------------- */

export type Hashtag = Tables<'hashtags'>
export type ContentEntry = Tables<'content_entries'>
export type ContentHashtag = Tables<'content_hashtags'>

/* --- Feedback ------------------------------------------------------------------- */

export type Feedback = Tables<'feedback'>
export type FeedbackRating = Tables<'feedback_ratings'>
export type CreditEligibilityReview = Tables<'credit_eligibility_reviews'>

/* --- Feed ------------------------------------------------------------------------ */

export type FeedImpression = Tables<'feed_impressions'>
export type FeedSignal = Tables<'feed_signals'>
export type Mute = Tables<'mutes'>
export type OutboundClick = Tables<'outbound_clicks'>
export type DurationEvent = Tables<'duration_events'>

/* --- Moderation -------------------------------------------------------------------- */

export type ModerationReport = Tables<'moderation_reports'>
export type ModerationAction = Tables<'moderation_actions'>

/* --- Ledgers ------------------------------------------------------------------------ */

export type CreditLedgerEntry = Tables<'credit_ledger'>
export type ReputationLedgerEntry = Tables<'reputation_ledger'>
export type WeeklyAllowanceRun = Tables<'weekly_allowance_runs'>

/* --- Views ---------------------------------------------------------------------------- */

export type ProfileReputationView = Tables<'profile_reputation'>
export type EntryFeedbackSummaryView = Tables<'entry_feedback_summary'>
export type WeeklyEngagementView = Tables<'weekly_engagement_dashboard'>

/* --- Enums ----------------------------------------------------------------------------
 *
 * Re-exported from the generated type rather than from `@fydio/domain`, because
 * these are the values Postgres actually stores. `@fydio/domain` keeps its own
 * union types for client-side validation (it must not import the database types), and
 * the pgTAP suite plus the RPC signatures are what keep the two in agreement.
 */

export type PlatformKind = Enums<'platform_kind'>
export type ProfileRole = Enums<'profile_role'>
export type FriendshipState = Enums<'friendship_state'>
export type EntryState = Enums<'entry_state'>
export type PreviewState = Enums<'preview_state'>
export type CreditKind = Enums<'credit_kind'>
export type ReputationKind = Enums<'reputation_kind'>
export type LedgerStatus = Enums<'ledger_status'>
export type EligibilityState = Enums<'eligibility_state'>
export type FeedbackTagDb = Enums<'feedback_tag'>
export type FeedSignalKind = Enums<'feed_signal_kind'>
export type DurationBand = Enums<'duration_band'>
export type ReportState = Enums<'report_state'>
export type ReportTarget = Enums<'report_target'>

/**
 * A member's spendable Credit balance.
 *
 * NOT a stored column: it is derived by `get_credit_balance`, which is the only
 * sanctioned way to ask. The type is here so call sites can name what they hold
 * without inventing a table shape for a value the database computes.
 */
export type CreditBalance = number

/**
 * The public reputation card, as returned by `get_reputation`.
 *
 * `badge` is null below the first threshold — there is no "newcomer" tier, because
 * inventing one would imply a status the product has not defined.
 */
export interface ReputationSummary {
  readonly user_id: string
  readonly handle: string
  readonly reputation_total: number
  readonly rated_feedback_count: number
  readonly reputation_avg: number | null
  readonly badge: 'mentor' | 'trusted' | 'established' | null
}

/** A ranked feed item, as returned by `rank_feed`. */
export interface RankedEntry {
  readonly rank: number
  readonly entry: ContentEntry
  readonly score: number
  readonly reason_code: 'shared_hashtag' | 'friend' | 'fresh' | 'new_creator'
}

/** Re-exported so consumers need not reach into the generated file. */
export type { Database, Enums, Tables, TablesInsert }
