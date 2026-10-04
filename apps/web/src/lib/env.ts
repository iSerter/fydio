import 'server-only'

import { getServerEnv } from '@fydio/env/server'

/**
 * Server-only configuration, re-exported in a form that can be read at MODULE scope.
 *
 * WHY THIS EXISTS. `@fydio/env`'s `getServerEnv()` validates lazily and memoises, which is
 * the right behaviour for a function called during a request. It is the wrong shape for a
 * `const` read at import time: a module that does `const X = getServerEnv().APP_URL` is
 * evaluated during `next build`, in a context where a legitimately-missing variable would
 * freeze `undefined` into the build output rather than failing at boot.
 *
 * So the values exported here are read through a FUNCTION, which defers resolution to the
 * first request. Every call site in T03 uses this module rather than reaching past
 * `@fydio/env` directly, so there is one place to look when a value needs auditing.
 */

/** The app's public base URL, e.g. `http://localhost:3000`. */
export function appUrl(): string {
  return getServerEnv().APP_URL
}

/** The avatars Storage bucket name. Configurable so an operator can rename it. */
export function avatarBucket(): string {
  return getServerEnv().STORAGE_BUCKET_AVATARS
}

/** The display name for the product. */
export function appName(): string {
  return getServerEnv().APP_NAME
}

/**
 * The absolute public URL of a Storage object.
 *
 * WHY ABSOLUTE. `next/image` fetches from the origin it is given, so a relative
 * `/storage/v1/object/public/...` resolves against the APP's origin. That happens to work only
 * when the app and Supabase share a host -- true for the local stack behind one gateway, false
 * the moment they are deployed separately, where every avatar silently 404s.
 *
 * `encodeURIComponent` on each path segment, not the whole path: object keys contain `/` and
 * that separator is meaningful. Without it a key with a space or a `#` produces a URL that
 * stops at the wrong place.
 *
 * Returns `null` rather than a broken URL when there is no object, so callers can branch
 * instead of rendering an image that will not load.
 */
export function publicStorageUrl(bucket: string, path: string | null): string | null {
  if (path === null || path.length === 0) return null

  const encoded = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')

  return `${getServerEnv().SUPABASE_URL}/storage/v1/object/public/${bucket}/${encoded}`
}