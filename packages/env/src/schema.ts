import { z } from 'zod'

/** Platforms Fydio accepts content links for. */
export const platformKind = z.enum(['instagram', 'tiktok', 'youtube', 'x'])

export type PlatformKind = z.infer<typeof platformKind>

/**
 * A number that may arrive as an empty string.
 *
 * `z.coerce.number()` turns `''` into `0`, which is never what an operator means
 * by "not set" for a tuning knob — an empty `FEED_PAGE_SIZE` should fall back to
 * the default, not silently become a one-item page.
 *
 * Empty strings are mapped to `undefined` *before* coercion, then the `.optional()`
 * in the middle swallows that value so the final `.transform` can apply the
 * default. Doing it in this order matters: coercing first would produce `NaN`,
 * which fails validation instead of falling back.
 */
const numeric = (schema: z.ZodType<number | undefined>, fallback: number) =>
  z
    .preprocess(
      (value) =>
        typeof value === 'string' && value.trim() === ''
          ? undefined
          : value === ''
            ? undefined
            : value,
      schema.optional(),
    )
    .transform((value) => value ?? fallback)

/** A bounded integer with a default. */
const boundedInt = (min: number, max: number, fallback: number) =>
  numeric(z.coerce.number().int().min(min).max(max), fallback)

/** A finite number with a default; `NaN`/`Infinity` are rejected. */
const finiteNumber = (fallback: number) =>
  numeric(z.coerce.number().refine(Number.isFinite, 'Must be a finite number'), fallback)

/**
 * A comma-separated list of platforms.
 *
 * `z.array()` cannot parse a raw env string on its own; `PLATFORM_ALLOWLIST`
 * arrives as `"instagram,tiktok"`, so we split before validating.
 */
const platformList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  )
  .pipe(z.array(platformKind))
  .default(['instagram', 'tiktok', 'youtube', 'x'])

/** Server-only configuration. Validated once, at boot, in `instrumentation.ts`. */
export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  // --- Supabase (server-only) ---
  SUPABASE_URL: z.url(),
  SUPABASE_ANON_KEY: z.string().min(20),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  SUPABASE_JWT_SECRET: z.string().min(32),
  DATABASE_URL: z.string().optional(),

  // --- App ---
  APP_NAME: z.string().min(1).default('Fydio'),
  APP_URL: z.url().default('http://localhost:3000'),

  // --- Feed ranking tunables ---
  FEED_PAGE_SIZE: boundedInt(5, 50, 20),
  FEED_FRIEND_AFFINITY_BOOST: finiteNumber(0.35),
  FEED_FRESHNESS_HALF_LIFE_HOURS: finiteNumber(36),
  FEED_FEEDBACK_NEED_BOOST: finiteNumber(0.15),
  FEED_DIVERSITY_MAX_PER_CREATOR: boundedInt(1, 50, 2),
  FEED_DIVERSITY_MAX_PER_PLATFORM: boundedInt(1, 50, 6),
  FEED_MAX_AGE_HOURS: finiteNumber(720),

  // --- Credits ---
  CREDIT_SUBMISSION_COST: boundedInt(1, 100, 1),
  CREDIT_WEEKLY_STARTER_ALLOWANCE: boundedInt(0, 1000, 3),
  CREDIT_PER_DAY_CAP: boundedInt(1, 1000, 5),
  CREDIT_PER_CREATOR_CAP: boundedInt(1, 1000, 2),
  CREDIT_HOLD_HOURS: boundedInt(0, 8760, 48),
  CREDIT_NEW_MEMBER_SUBMISSION_CAP: boundedInt(1, 1000, 3),
  CREDIT_NEW_MEMBER_GRACE_DAYS: boundedInt(0, 365, 14),

  // --- Feedback ---
  FEEDBACK_MIN_CHARS: boundedInt(0, 10_000, 40),
  FEEDBACK_MAX_IMAGES: boundedInt(0, 10, 3),
  FEEDBACK_EDIT_GRACE_HOURS: boundedInt(0, 8760, 48),
  RATING_REVISION_WINDOW_HOURS: boundedInt(0, 8760, 24),

  // --- Content / platforms ---
  PLATFORM_ALLOWLIST: platformList,
  URL_PREVIEW_TIMEOUT_MS: boundedInt(500, 60_000, 4000),

  // --- Storage buckets ---
  STORAGE_BUCKET_AVATARS: z.string().min(1).default('avatars'),
  STORAGE_BUCKET_COVERS: z.string().min(1).default('covers'),
  STORAGE_BUCKET_FEEDBACK: z.string().min(1).default('feedback-images'),

  // --- Extension ---
  EXTENSION_ID: z.string().optional(),
  EXTENSION_TOKEN_SECRET: z.string().min(32).optional(),

  // --- Scheduled jobs (T05 cron routes, scheduled in T10) ---
  // Optional until an operator configures a scheduler: the cron routes refuse
  // to run without it (503) rather than running unguarded.
  CRON_SECRET: z.string().min(16).optional(),
})

/**
 * The validated server environment.
 *
 * `isProduction` is absent from the schema on purpose: it is *derived* from
 * `NODE_ENV` in `parseServerEnv`, never read from the environment. Keeping it
 * out of the schema means there is no way to inject it.
 */
export type ServerEnv = z.infer<typeof serverEnvSchema> & {
  readonly isProduction: boolean
}

/**
 * Browser-visible configuration.
 *
 * Every key is `NEXT_PUBLIC_`-prefixed, which is what makes it safe to inline
 * into the client bundle. Note there is deliberately no way to express a
 * server-only variable here.
 */
export const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_NAME: z.string().min(1).default('Fydio'),
  NEXT_PUBLIC_APP_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(20),
  NEXT_PUBLIC_EXTENSION_ID: z.string().optional(),
})

export type ClientEnv = z.infer<typeof clientEnvSchema>
