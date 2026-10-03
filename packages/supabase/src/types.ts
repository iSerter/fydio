import type { SupabaseClient } from '@supabase/supabase-js'

import type { Database as Generated } from './types.generated.js'

/**
 * The generated `Database` type.
 *
 * Produced by `pnpm db:types` against the local stack. It is gitignored because
 * it is a build artefact of the schema, not source: regenerating it is how a
 * schema change reaches TypeScript, and a stale committed copy would silently
 * disagree with the database.
 *
 * T01 has no business tables yet, so it generates the empty `[_ in never]` form.
 * T02 replaces it with the real schema; nothing else in this package changes.
 */
export type Database = Generated

/**
 * Supabase's own table/enum lookup helpers.
 *
 * Re-exported so callers can write `Tables<'content_entries'>` without importing the
 * generated file directly. The generated file is gitignored (it is a build artefact of
 * the live schema), so reaching into it would be reaching into something a fresh
 * checkout does not have.
 */
export type { Tables, TablesInsert, TablesUpdate, Enums, Json } from './types.generated.js'

/**
 * The Supabase client as Fydio uses it, pinned to the `public` schema.
 *
 * Written out rather than derived with `ReturnType<typeof createClient>`: the
 * factory is generic, and `ReturnType` resolves its type parameters to defaults
 * that do not line up with the `db.schema` option we pass, which produces an
 * unsatisfiable assignment under `exactOptionalPropertyTypes`.
 */
export type FydioClient = SupabaseClient<Database, 'public', 'public'>

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
