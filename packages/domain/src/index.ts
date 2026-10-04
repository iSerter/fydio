/**
 * `@fydio/domain` — framework-free rules shared by the web app and the extension.
 *
 * Nothing here touches React, Next.js, Supabase or `process.env`. That is
 * deliberate: the ranking formula and the hashtag caps are the parts most likely
 * to drift between the client, the server and the SQL, so they need to be
 * testable in isolation and importable from anywhere.
 */
export * from './constants.js'
export * from './platforms.js'
export * from './canonicalize.js'
export * from './ranking.js'
export * from './feed.js'
export * from './validation.js'
export * from './signals.js'
export * from './profile.js'
