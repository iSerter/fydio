import { execFileSync } from 'node:child_process'

import { expect, test, type Page } from '@playwright/test'

/**
 * The full invite-to-profile journey (T03 §9).
 *
 * `/invite/<token>` → account created → five wizard steps → profile renders.
 *
 * WHY THE INVITE IS ISSUED IN-PROCESS. The journey has to start from a real invitation, and the
 * raw token exists only at the moment `issue-invite.ts` runs -- only its SHA-256 digest is ever
 * stored, by design. So the script is invoked from the test rather than read from a fixture,
 * which is the only way to get a working token without weakening that property.
 */

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000'
const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025'

/** Run `issue-invite.ts` and return the raw token it printed. */
function issueInvite(email: string): string {
  const output = execFileSync(
    'pnpm',
    ['--filter', '@fydio/web', 'invite:new', '--email', email],
    { encoding: 'utf8', cwd: process.cwd() },
  )

  const match = /\/invite\/([0-9a-f]{64})/.exec(output)

  if (match?.[1] === undefined) {
    throw new Error(`could not read an invite token from the script output:\n${output}`)
  }

  return match[1]
}

/** Every message id currently in Mailpit for one address, newest included. */
async function mailIdsFor(email: string): Promise<Set<string>> {
  const response = await fetch(
    `${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(email)}`,
  )

  if (!response.ok) return new Set()

  const payload: unknown = await response.json()

  const messages =
    typeof payload === 'object' && payload !== null
      ? (payload as { messages?: { ID?: number | string }[] }).messages
      : undefined

  const ids = new Set<string>()

  for (const message of messages ?? []) {
    if (message.ID !== undefined) ids.add(String(message.ID))
  }

  return ids
}

/**
 * Wait for a message that did NOT exist when the request was made, and return its body.
 *
 * WHY THE "NEW" IS EMPHATICISED. Polling for "any message for this address" is the obvious
 * implementation and it is wrong the moment a member signs in twice, which is exactly what the
 * friendship tests do. The second request either produces no mail at all -- GoTrue rate-limits
 * repeated sends -- or produces one that arrives after the poll begins, and in both cases the
 * poll happily returns the FIRST, already-consumed message. The test then follows a dead link,
 * no session is created, and the failure is reported as broken sign-in rather than as a stale
 * fixture. Comparing against a snapshot taken before the request is what makes "the mail this
 * request caused" and "a mail that happens to exist" different things.
 *
 * Polled rather than read once, because delivery is asynchronous: the API returns as soon as
 * GoTrue has queued the message, not when Mailpit has it.
 */
async function awaitNewMagicLink(email: string, seen: Set<string>): Promise<string> {
  const deadline = Date.now() + 30_000

  while (Date.now() < deadline) {
    const fresh = [...(await mailIdsFor(email))]
      .filter((id) => !seen.has(id))
      .sort((a, b) => Number(b) - Number(a))

    const newest = fresh[0]

    if (newest !== undefined) {
      const detail = await fetch(`${MAILPIT_URL}/api/v1/message/${newest}`)

      if (detail.ok) {
        const body: unknown = await detail.json()
        const text = (body as { Text?: unknown }).Text

        if (typeof text === 'string' && text.length > 0) return text
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  throw new Error(`no new sign-in email arrived for ${email} within 30s`)
}

/**
 * Sign in by following the emailed link, exactly as a member does.
 *
 * WHY THE WHOLE LINK AND NOT A TOKEN. The email carries a PKCE one-time token and points at
 * Auth's `/verify` endpoint, which redirects back to the app's `/auth/callback` with the session
 * in the URL *fragment*. Reconstructing a `?token_hash=` call from the token alone -- the shape
 * invite redemption uses -- looks equivalent and is not: it bypasses the verify hop, so the
 * session never materialises and the member is left sitting on `/login` with no error to show.
 * Following the link is also the only version of this test that a member could actually perform.
 */
async function signInViaMagicLink(page: Page, email: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Email address').fill(email)

  // Taken BEFORE the request, so the link this call is about cannot be confused with one left
  // over from an earlier sign-in for the same address.
  const before = await mailIdsFor(email)

  await page.getByRole('button', { name: /sign-in link/i }).click()

  const body = await awaitNewMagicLink(email, before)

  // The link's host is whatever Auth is reachable at, which is not necessarily this app's, so
  // the URL is matched structurally rather than against a hard-coded origin.
  const link = /https?:\/\/[^\s<>"()]+\/verify\?[^\s<>"()]+/.exec(body)?.[0]

  if (link === undefined) {
    throw new Error('the sign-in email did not contain a verification link')
  }

  // Auth redirects back to /auth/callback, which exchanges the token and writes the session.
  await page.goto(link)
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/callback'), { timeout: 30_000 })

  // Verified HERE rather than left to the caller's next assertion. Sign-in can fail quietly:
  // Auth redirects through a real URL on its way to a page the proxy then bounces, so a test
  // that only checks "not /login" passes while no session exists at all. Naming the failure at
  // the point it happens is what turns that class of bug into a one-line diagnosis.
  if (new URL(page.url()).pathname.startsWith('/login')) {
    throw new Error(`the emailed link did not establish a session; landed on ${page.url()}`)
  }
}

/**
 * The error banner the app renders when something goes wrong.
 *
 * Scoped to `main` on purpose: Next.js mounts a hidden live region carrying `role="alert"` for its
 * own route announcements, so a bare `getByRole('alert')` matches two elements and fails in
 * strict mode on a page whose real error message renders perfectly well.
 */
function errorBanner(page: Page) {
  return page.locator('main').getByRole('alert')
}

test.describe('invite → onboarding → profile', () => {
  test('a member redeems an invitation and completes onboarding', async ({ page }) => {
    const email = `t03-e2e-${Date.now()}@demo.test`
    const token = issueInvite(email)

    // --- The invitation link ------------------------------------------------
    await page.goto(`/invite/${token}`)
    await expect(page.getByRole('heading', { name: /join fydio/i })).toBeVisible()

    await page.getByRole('link', { name: /create my account/i }).click()
    await expect(page).toHaveURL(/\/auth\/accept/)

    // --- Account creation ---------------------------------------------------
    await expect(page.getByRole('heading', { name: /set up your membership/i })).toBeVisible()

    // The account is created and the member lands on the wizard.
    await page.waitForURL(/\/onboarding/, { timeout: 30_000 })

    // --- Step 1: identity ---------------------------------------------------
    await expect(page.getByText('Step 1 of 5')).toBeVisible()
    await page.getByLabel('Display name').fill('Ada Lovelace')
    await page.getByRole('button', { name: /^Continue$/ }).click()

    // --- Step 2: avatar (skippable) -----------------------------------------
    await expect(page.getByText('Step 2 of 5')).toBeVisible()
    await page.getByRole('button', { name: /skip for now/i }).click()

    // --- Step 3: bio --------------------------------------------------------
    await expect(page.getByText('Step 3 of 5')).toBeVisible()
    await page.getByLabel(/a sentence or two/i).fill('Filmmaker working on short-form documentaries.')
    await page.getByRole('button', { name: /^Continue$/ }).click()

    // --- Step 4: hashtags, and the five-slot cap ----------------------------
    // The live counter and the disabled-at-five search ARE the acceptance criteria, so they are
    // asserted rather than trusted.
    await expect(page.getByText('Step 4 of 5')).toBeVisible()
    await expect(page.getByText('0 of 5 selected')).toBeVisible()

    // Scoped to the SUGGESTIONS list on purpose. The selected chips are also buttons whose names
    // start with `#`, so an unscoped `/^#/` click would hit whichever comes first in the DOM --
    // a selected chip, which REMOVES that tag, and the count would never rise.
    const suggestions = page.getByRole('list', { name: 'Suggested hashtags' })

    for (let index = 1; index <= 5; index += 1) {
      await suggestions.getByRole('button').first().click()
      await expect(page.getByText(`${index} of 5 selected`)).toBeVisible()
    }

    await expect(page.getByText('5 of 5 selected')).toBeVisible()
    await expect(page.getByLabel('Search or create a hashtag')).toBeDisabled()

    await page.getByRole('button', { name: /^Continue$/ }).click()

    // --- Step 5: handles ----------------------------------------------------
    await expect(page.getByText('Step 5 of 5')).toBeVisible()
    await page.getByRole('button', { name: /finish setup/i }).click()

    // --- Out of onboarding --------------------------------------------------
    await page.waitForURL(/\/feed/, { timeout: 30_000 })

    // The feed greets the member by the display name they just chose. This is T07's
    // feed page, not the T03 placeholder that used to say "Welcome, ..." — asserting
    // the greeting proves onboarding landed somewhere real rather than on a stub.
    await expect(page.getByRole('heading', { name: /hi, ada lovelace/i })).toBeVisible()
  })

  test('the same invitation cannot be redeemed twice', async ({ page }) => {
    const email = `t03-e2e-replay-${Date.now()}@demo.test`
    const token = issueInvite(email)

    await page.goto(`/auth/accept?token=${token}`)
    await page.waitForURL(/\/onboarding/, { timeout: 30_000 })

    // A fresh, anonymous visit with the same token: the account already exists, so the invite is
    // spent and the route must say so rather than minting a second account.
    await page.context().clearCookies()
    await page.goto(`/auth/accept?token=${token}`)

    await expect(errorBanner(page)).toContainText(/already been used|could not/i)
  })

  test('an unknown invitation is refused', async ({ page }) => {
    await page.goto(`/auth/accept?token=${'0'.repeat(64)}`)

    await expect(errorBanner(page)).toContainText(/not valid/i)
  })

  test('a malformed invitation link is refused before anything is created', async ({ page }) => {
    await page.goto('/invite/not-a-real-token')

    await expect(page.getByRole('heading', { name: /this link looks incomplete/i })).toBeVisible()
  })

  test('signing in with the emailed link reaches the app', async ({ page }) => {
    const email = `t03-e2e-login-${Date.now()}@demo.test`
    const token = issueInvite(email)

    // The invitation is redeemed FIRST, deliberately. Email sign-in is disabled for unknown
    // addresses -- that is the invite-only gate -- so a request for an account that was never
    // created is refused by GoTrue and no mail is sent. Creating the account through the invite
    // is what keeps this a test of *sign-in* rather than a second, weaker test of signup.
    await page.goto(`/auth/accept?token=${token}`)
    await page.waitForURL(/\/onboarding/, { timeout: 30_000 })

    // A member signing in again does it on a fresh device, so the session is dropped first. This
    // matters: with the session still present the proxy would bounce `/login` straight to
    // `/onboarding`, and the sign-in form this test is about would never render.
    await page.context().clearCookies()
    await signInViaMagicLink(page, email)

    // ASSERT A REAL SESSION, NOT JUST A URL.
    //
    // The obvious check here is `waitForURL(not '/login')`, and it is worthless: GoTrue
    // redirects through `/feed` on its way to the app, so the URL passes that test even when no
    // session cookie was ever written and the proxy immediately bounces back to `/login`. That
    // is exactly how a callback route which ignored the URL fragment shipped looking correct.
    //
    // Instead this asks for a page the proxy protects and demands it render -- which it cannot
    // without a session, and which does not exist for a member who has not onboarded.
    await page.goto('/settings/profile')
    await expect(page.getByRole('heading', { name: 'Your profile' })).toBeVisible({ timeout: 15_000 })
    await expect(page).not.toHaveURL(/\/login/)
  })

  test('an unknown address is not sent a sign-in link', async ({ page }) => {
    // Invite-only means invite-only: no mail goes out to anyone without an account. Asserting it
    // is the only way to catch a regression that quietly re-opens public sign-up.
    await page.goto('/login')
    await page.getByLabel('Email address').fill(`t03-e2e-stranger-${Date.now()}@demo.test`)
    await page.getByRole('button', { name: /sign-in link/i }).click()

    await expect(errorBanner(page)).toContainText(/no account|not been invited|invite/i)
  })
})

/**
 * Take a fresh browser all the way from invitation to a completed profile.
 *
 * Shared by the friendship tests so "how do I become a member" is written once. Left inline it
 * would be copied three more times, and the copies would drift -- the first one to gain a step
 * would make the friendship tests pass or fail for reasons unrelated to friendship.
 */
async function onboardMember(
  page: Page,
  displayName: string,
  /** A slug used only to make this test's email unique; the real handle is read back later. */
  slug: string,
): Promise<{ email: string; handle: string; displayName: string }> {
  const email = `t03-e2e-${slug}-${Date.now()}@demo.test`

  await page.context().clearCookies()
  await page.goto(`/auth/accept?token=${issueInvite(email)}`)
  await page.waitForURL(/\/onboarding/, { timeout: 30_000 })

  await page.getByLabel('Display name').fill(displayName)
  await page.getByRole('button', { name: /^Continue$/ }).click()

  await expect(page.getByText('Step 2 of 5')).toBeVisible()
  await page.getByRole('button', { name: /skip for now/i }).click()

  await expect(page.getByText('Step 3 of 5')).toBeVisible()
  await page.getByRole('button', { name: /^Continue$/ }).click()

  // All five, not one. Step 4 requires exactly five before Continue enables -- a floor, not a
  // cap, and the rule the onboarding test asserts. Taking fewer here would stall on a disabled
  // button and make these friendship tests fail for an unrelated reason.
  await expect(page.getByText('Step 4 of 5')).toBeVisible()
  const suggestions = page.getByRole('list', { name: 'Suggested hashtags' })
  for (let index = 1; index <= 5; index += 1) {
    await suggestions.getByRole('button').first().click()
    await expect(page.getByText(`${index} of 5 selected`)).toBeVisible()
  }
  await page.getByRole('button', { name: /^Continue$/ }).click()

  await expect(page.getByText('Step 5 of 5')).toBeVisible()
  await page.getByRole('button', { name: /finish setup/i }).click()

  await page.waitForURL(/\/feed/, { timeout: 30_000 })

  // The handle is derived from the EMAIL by `unique_handle_from_email`, not chosen during
  // onboarding, so the test cannot know it in advance. It is read from the browser by following
  // the "your public profile" link -- which also proves that link works, since a member has no
  // other way to reach their own profile without guessing a URL.
  await page.getByRole('link', { name: /view your public profile/i }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(displayName)

  const actualHandle = new URL(page.url()).pathname.replace(/^\/u\//, '')

  if (actualHandle.length === 0) throw new Error('could not read the handle from the profile URL')

  return { email, handle: actualHandle, displayName }
}

/**
 * Sign in as a member who already exists, dropping whatever session is in place.
 *
 * Friendship needs THREE distinct sessions in one test -- each member signs in, acts, and signs
 * out again -- because the whole point of the feature is that neither side can act alone.
 * Reusing one session would silently test the wrong thing: as Alice, Bob's profile shows "Add
 * friend" and Alice's own shows "This is you", so an accept button never appears and the test
 * fails for a reason that has nothing to do with friendship state.
 */
async function signInAs(page: Page, email: string): Promise<void> {
  await page.context().clearCookies()
  await signInViaMagicLink(page, email)
}

test.describe('mutual friendships', () => {
  test('a request sent by one member is accepted by the other', async ({ page }) => {
    // T03 §9: the journey ends with "send a friend request -> accept as the second user".
    // Both halves run in ONE test, serially, because each needs its own session and the suite
    // is deliberately single-worker: a parallel pair would race on the same profile page.
    const alice = await onboardMember(page, 'Ada Lovelace', 'adafriend')
    const bob = await onboardMember(page, 'Bob Table', 'bobfriend')

    await signInAs(page, alice.email)

    // --- Alice sends ---------------------------------------------------------
    await page.goto(`/u/${bob.handle}`)
    await page.getByRole('button', { name: /add friend/i }).click()

    // The sender sees their own request as sent, not as an instant friendship -- a mutual-only
    // model that let one click confirm both sides would make "accept" meaningless.
    await expect(page.getByText(/request sent/i)).toBeVisible()

    // And Alice is still not a friend of herself: nothing appears in the list yet.
    await page.goto(`/u/${alice.handle}`)
    await expect(page.getByRole('link', { name: 'Bob Table' })).toHaveCount(0)

    // --- Bob accepts ---------------------------------------------------------
    await signInAs(page, bob.email)
    await page.goto(`/u/${alice.handle}`)
    await page.getByRole('button', { name: /accept request/i }).click()

    // The list on ALICE's profile now contains Bob -- not Alice. Each profile shows that
    // member's own friends, so asserting the wrong name here would pass against a page that had
    // never rendered a friendship at all.
    await expect(page.getByRole('link', { name: 'Bob Table' })).toBeVisible()

    // And the other side of the same friendship, which is the "mutual" in mutual friendships.
    // A one-directional list would satisfy the assertion above and fail this one.
    await signInAs(page, alice.email)
    await page.goto(`/u/${bob.handle}`)
    await expect(page.getByRole('link', { name: 'Ada Lovelace' })).toBeVisible()
    await expect(page.getByRole('button', { name: /remove friend/i })).toBeVisible()
  })

  test('declining a request leaves no friendship behind', async ({ page }) => {
    const alice = await onboardMember(page, 'Decline Alice', 'declinealice')
    const bob = await onboardMember(page, 'Decline Bob', 'declinebob')

    await signInAs(page, alice.email)
    await page.goto(`/u/${bob.handle}`)
    await page.getByRole('button', { name: /add friend/i }).click()
    await expect(page.getByText(/request sent/i)).toBeVisible()

    // Bob declines. A decline is a decision, not an absence: the control must change, and no
    // friendship may appear on either side.
    await signInAs(page, bob.email)
    await page.goto(`/u/${alice.handle}`)
    await page.getByRole('button', { name: /decline/i }).click()
    await expect(page.getByRole('button', { name: /send request again/i })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Decline Alice' })).toHaveCount(0)

    // Only Alice can re-send, because a declined request belongs to these two people. If the
    // decline had left a dangling row, this would either offer Bob a duplicate or fail outright.
    await signInAs(page, alice.email)
    await page.goto(`/u/${bob.handle}`)
    await expect(page.getByRole('button', { name: /send request again/i })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Decline Bob' })).toHaveCount(0)
  })
})

test.describe('route protection', () => {
  test('an anonymous visitor is sent to sign in', async ({ page }) => {
    await page.goto('/feed')

    await expect(page).toHaveURL(new RegExp(`${APP_URL}/login`))
    await expect(page.getByRole('heading', { name: /sign in to fydio/i })).toBeVisible()
  })

  test('a member profile is not reachable anonymously', async ({ page }) => {
    await page.goto('/u/adalovelace')

    await expect(page).toHaveURL(new RegExp(`${APP_URL}/login`))
  })
})
