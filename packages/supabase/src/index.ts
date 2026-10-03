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
export type { CookieStore } from './server.js'
export type { Database, FydioClient } from './types.js'
