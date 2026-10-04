import { createServerClient } from '@fydio/supabase/server'
import type { CookieStore } from '@fydio/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * Request interception for the whole app (T03).
 *
 * NAME. This file is `proxy.ts`, not `middleware.ts`. Next.js 16 renamed the convention --
 * `middleware` is overloaded (Express middleware, and a feature Next now steers away from)
 * while `proxy` names the thing it actually is: a network boundary in front of the app.
 * `middleware.ts` still works in 16 but emits a deprecation warning on every build.
 *
 * WHAT RUNS HERE, AND WHY IT CANNOT RUN ANYWHERE ELSE. Three checks, in order:
 *
 *   1. session refresh -- the access token is short-lived and the refresh token lives in a
 *      cookie, so every navigation needs a chance to renew. Doing it here rather than in
 *      each route means one renewal path instead of N, and means a page rendered from a
 *      hard refresh has a fresh token.
 *   2. authentication -- anonymous visitors are sent to /login.
 *   3. onboarding and role gates.
 *
 * Every rule below is a CONVENIENCE LAYER, not the boundary. The real enforcement is RLS
 * and the RPC checks: this file exists so a member lands on the right screen, not so an
 * unauthorised read is impossible. A bug here must never widen what the database allows.
 * That is why the invite gate in particular is NOT here -- `/login` is public, and only
 * `claim_invite` (service-role only) can redeem a token.
 */

/**
 * Paths reachable without a session.
 *
 * Matched as PREFIXES, so `/login` also covers `/login/...` and `/invite` covers
 * `/invite/<token>`. `/auth` covers both `/auth/accept` and `/auth/callback`, neither of which
 * has a session: redemption happens before the member has one.
 *
 * NOTE WHAT IS *NOT* HERE. `/api/auth/accept-invite` used to be listed, on the reasoning that
 * redemption precedes the session. It does not need to be: every `/api/**` path is exempt from
 * the proxy's redirects outright (see `gate`), because the handler authorises itself and a 401 is
 * a better answer than a login page.
 */
const PUBLIC_PREFIXES = ['/login', '/invite', '/auth'] as const

/** Reserved for admins. T09 builds the console; the gate lands with the gate itself. */
const ADMIN_PREFIX = '/admin'

/**
 * The app root after a successful sign-in and after onboarding.
 *
 * `/feed` is T07's route. It does not exist yet, which is deliberate scope discipline:
 * T03's acceptance criteria end at "profile page renders", and building a feed now would
 * mean guessing at T07's ranking for no benefit. The redirect target is centralised here
 * so T07 only has to create the page.
 */
const POST_ONBOARDING_REDIRECT = '/feed'

/**
 * Adapt Next's request/response cookie plumbing to the `CookieStore` shape
 * `@fydio/supabase/server` expects.
 *
 * The package takes a structural `CookieStore` rather than importing `next/headers`, so it
 * stays testable in plain Node. This is the adapter that satisfies it here.
 *
 * `setAll` writes to BOTH the outgoing response and `request.cookies`. The first so the
 * browser receives the refreshed tokens; the second because Supabase's client reads the
 * session back during this same request, and a cookie written only to the response would
 * not be visible to it yet.
 */
function cookieStoreFor(request: NextRequest, response: NextResponse): CookieStore {
  return {
    getAll() {
      return request.cookies.getAll()
    },
    set(name, value, options) {
      request.cookies.set(name, value)
      // `?? {}` for the same reason as `lib/server.ts`: `@supabase/ssr` types options as
      // optional, but Next's `set` takes `cookie?: Partial<ResponseCookie>`, and
      // `exactOptionalPropertyTypes` rejects an explicit `undefined` there.
      response.cookies.set(name, value, options ?? {})
    },
  }
}

/** Is this path reachable without signing in? */
function isPublic(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}

/**
 * Redirect to `/login`, remembering where the member was going.
 *
 * `next` is carried as a query parameter so the login page can return them there. It is
 * only ever set to an internal pathname (never a full URL) -- see the guard on the login
 * page's use of it -- so this cannot be used as an open redirect.
 */
function redirectToLogin(request: NextRequest): NextResponse {
  const url = request.nextUrl.clone()
  url.pathname = '/login'
  url.search = ''
  url.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`)
  return NextResponse.redirect(url)
}
/** The subset of `profiles` this file reads. */
interface ProfileShape {
  readonly display_name: string
  readonly role: string
  readonly onboarding_completed_at: string | null
}

/**
 * The profile behind the current session, or `null`.
 *
 * Uses the already-refreshed client rather than `getSessionUser` so this costs no extra
 * round trip to Auth: the `getUser()` in `proxy` has already verified the token.
 */
async function loadProfile(
  supabase: ReturnType<typeof createServerClient>,
): Promise<ProfileShape | null> {
  // `ensure_profile()` rather than a plain SELECT on `profiles`: an account created
  // between the auth.users insert and the profile insert (or restored from a dump) would
  // otherwise have a session but no row, and this function provisions one. It is the
  // idempotent path T02 built for exactly this.
  const { data, error } = await supabase.rpc('ensure_profile')

  if (error) return null

  // Narrowed at runtime rather than cast blindly: a shape change in the function should
  // surface as `null` and fail closed, not as `undefined` comparisons three frames later.
  // The single `typeof` test covers `null` too, which is why there is no separate null check.
  const row = data as unknown

  if (typeof row !== 'object' || row === null) return null

  const candidate = row as Partial<ProfileShape>

  if (typeof candidate.role !== 'string' || typeof candidate.display_name !== 'string') {
    return null
  }

  return {
    display_name: candidate.display_name,
    role: candidate.role,
    onboarding_completed_at:
      typeof candidate.onboarding_completed_at === 'string' ? candidate.onboarding_completed_at : null,
  }
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  // Seeded with `next({ request })` so a redirect returned by the library carries this
  // request's headers (notably the cookie jar) instead of a blank response.
  const response = NextResponse.next({ request })

  const supabase = createServerClient(cookieStoreFor(request, response))

  // `getUser()`, never `getSession()`. `getSession` reads the JWT the browser holds and
  // decodes it WITHOUT asking Auth whether it is still valid, so a tampered or revoked
  // token would be trusted. This is the single most important line in the file.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const outcome = await gate(request, supabase, user?.id ?? null)

  // Supabase may have refreshed the session while `getUser()` ran, writing new cookies
  // onto `response`. Returning a DIFFERENT response (a redirect, below) would discard
  // them, so they are copied onto whatever we end up returning. Skipping this logs the
  // member out on the very navigation that was meant to extend their session -- a bug that
  // only appears once an hour, which is exactly the kind that survives a demo.
  for (const cookie of response.cookies.getAll()) {
    outcome.cookies.set(cookie.name, cookie.value, cookie)
  }

  return outcome
}
/**
 * The access-control decisions, separated from session refresh so the ordering in `proxy`
 * stays readable and the rules read as one block.
 */
async function gate(
  request: NextRequest,
  supabase: ReturnType<typeof createServerClient>,
  userId: string | null,
): Promise<NextResponse> {
  const { pathname } = request.nextUrl

  // API routes are NEVER redirected.
  //
  // Every `/api/**` handler calls `requireUserId()` first and answers 401 itself, which is a far
  // more useful response than an HTML login page: a `fetch` that follows a redirect would
  // otherwise receive a 200 carrying markup where it expected JSON, and fail with a parse error
  // that says nothing about the actual cause.
  //
  // The onboarding gate has the same problem in a subtler form -- redirecting an API call to
  // `/onboarding` turns a POST into a GET of a wizard page, which is how an avatar upload ends
  // up silently discarded.
  if (pathname.startsWith('/api/')) return NextResponse.next()

  if (userId === null) {
    if (isPublic(pathname)) return NextResponse.next()
    return redirectToLogin(request)
  }

  const profile = await loadProfile(supabase)

  // ONBOARDING GATE.
  //
  // `onboarding_completed_at IS NULL` is the signal, NOT `display_name IS NULL`. The
  // `display_name` column is NOT NULL with a CHECK requiring 1-80 characters, and
  // `handle_new_user` fills in a placeholder, so the display-name test in the task text can
  // never be true and would silently never fire.
  //
  // This gate is what guarantees the feed never renders for a profile with zero hashtags:
  // the tags are what the feed ranks on, so an un-onboarded profile has no ranking inputs
  // and would otherwise appear in everyone's feed as an unmatched stranger.
  //
  // `/onboarding` is exempt, or a refresh mid-step would discard progress and trap the
  // member in a redirect loop.
  if (profile !== null && profile.onboarding_completed_at === null && pathname !== '/onboarding') {
    const url = request.nextUrl.clone()
    url.pathname = '/onboarding'
    url.search = ''
    return NextResponse.redirect(url)
  }

  // Signed in and looking at /login: send them somewhere useful rather than letting them
  // request another magic link.
  if (pathname === '/login') {
    const url = request.nextUrl.clone()
    url.pathname =
      profile !== null && profile.onboarding_completed_at === null
        ? '/onboarding'
        : POST_ONBOARDING_REDIRECT
    url.search = ''
    return NextResponse.redirect(url)
  }

  // ADMIN GATE.
  //
  // Checks the profile's stored role rather than the JWT claim. The role can change after a
  // token was issued, and a claim-based check would keep honouring the stale value until it
  // expired -- so an admin who was demoted would keep admin rights for up to an hour, and a
  // member promoted would not get them at all.
  if (pathname.startsWith(ADMIN_PREFIX) && profile?.role !== 'admin') {
    const url = request.nextUrl.clone()
    url.pathname = POST_ONBOARDING_REDIRECT
    url.search = ''
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  /**
   * Everything except static assets.
   *
   * Skipping `_next/static`, `_next/image` and favicon is not an optimisation: this file
   * calls Auth on every request it sees, and matching a stylesheet would add a session
   * lookup to each of the dozens of assets a page loads. The API routes are deliberately
   * INCLUDED -- each handler does its own authorisation, but an unauthenticated call
   * should get a 401 from a route that knows why rather than a redirect meant for a page.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|webp|gif)$).*)'],
}