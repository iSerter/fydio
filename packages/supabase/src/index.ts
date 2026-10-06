/**
 * `@fydio/supabase` — client factories for every execution context.
 *
 * Each entrypoint is imported by its environment rather than picked from a
 * factory at runtime, so that a wrong-context import is a build error rather
 * than a runtime surprise:
 *
 *  - `@fydio/supabase/browser` — Client Components
 *  - `@fydio/supabase/server`  — RSC and Route Handlers (cookie-scoped)
 *  - `@fydio/supabase/service` — admin/jobs; bypasses RLS, server-only
 *  - `@fydio/supabase/session` — `getUser()` helpers
 *
 * Types are safe to import from anywhere.
 */
export type { CookieStore, CookieOptions } from './server.js'
export type { Database, FydioClient } from './types.js'

/**
 * Runtime parsing for `rank_feed`'s jsonb payload.
 *
 * The one place where a value from the database is turned into a typed object. Kept
 * out of the type-only exports above because it is code, not a type.
 */
export { feedEntryPayloadSchema, parseRankedRow, parseRankedRows } from './feed-payload.js'
export type {
  ContentEntry,
  ContentHashtag,
  CreditBalance,
  CreditKind,
  CreditLedgerEntry,
  DurationBand,
  DurationEvent,
  EligibilityState,
  EntryState,
  FeedEntryParsed,
  RankedFeedRow,
  Feedback,
  FeedbackRating,
  FeedImpression,
  FeedSignal,
  FeedSignalKind,
  Friendship,
  FriendshipState,
  Hashtag,
  Invite,
  LedgerStatus,
  ModerationAction,
  ModerationReport,
  Mute,
  OutboundClick,
  PlatformKind,
  PreviewState,
  Profile,
  ProfileHashtag,
  ProfileLink,
  ProfileReputationView,
  ProfileRole,
  RankedEntry,
  ReputationKind,
  ReputationLedgerEntry,
  ReputationSummary,
  ReportState,
  ReportTarget,
  WeeklyAllowanceRun,
} from './db-types.js'
