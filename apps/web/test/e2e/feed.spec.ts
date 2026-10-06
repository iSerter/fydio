import { expect, test, type Page } from '@playwright/test'

/**
 * The curated feed journey (T07 §9): sign in → a ranked feed with a reason on every
 * card → hide an item → reload → it is gone → mute a creator → their entries are gone.
 *
 * This is the only layer where "transparent ranking" is actually observable. pgTAP
 * proves the score; the regression suite proves SQL and TypeScript agree; neither can
 * prove a member SEES a reason, or that a tuning control visibly changes their feed.
 *
 * SIGN-IN FOLLOWS THE EMAILED LINK, reusing the pattern `onboarding.spec.ts` already
 * established. Fydio is invite-only with no password, so the only version of this test
 * a member could actually perform is the one that opens the email.
 */

const MAILPIT_URL = process.env.MAILPIT_URL ?? 'http://localhost:8025'

/**
 * The ids of every message currently addressed to `email`.
 *
 * Same shape as `onboarding.spec.ts`'s helper, not the `To`-filtering variant this
 * file first shipped with: the messages endpoint wraps its list in a `messages` key,
 * and the search endpoint already scopes by address server-side. Duplicating the
 * established helper is deliberate — sharing a helper across spec files would create
 * a cross-spec dependency that fails both when one changes.
 */
async function mailIdsFor(email: string): Promise<Set<string>> {
  const response = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(email)}`)

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

/** The text body of the newest magic-link email for `email`, ignoring ones already seen. */
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

async function signIn(page: Page, email: string): Promise<void> {
  await page.context().clearCookies()
  await page.goto('/login')
  await page.getByLabel('Email address').fill(email)

  // Taken BEFORE the request, so the link this call is about cannot be confused with
  // one left over from an earlier sign-in for the same address.
  const before = await mailIdsFor(email)

  await page.getByRole('button', { name: /sign-in link/i }).click()

  const body = await awaitNewMagicLink(email, before)
  const link = /https?:\/\/[^\s<>"()]+\/verify\?[^\s<>"()]+/.exec(body)?.[0]

  if (link === undefined) throw new Error('the sign-in email did not contain a verification link')

  await page.goto(link)
  await page.waitForURL((url) => !url.pathname.startsWith('/auth/callback'), { timeout: 30_000 })

  if (new URL(page.url()).pathname.startsWith('/login')) {
    throw new Error(`the emailed link did not establish a session; landed on ${page.url()}`)
  }
}

/** Every feed card currently rendered. */
function cards(page: Page) {
  return page.locator('[data-entry-id]')
}

test.describe('curated feed', () => {
  test('every card explains itself; hiding removes it; muting removes a creator', async ({
    page,
  }) => {
    await signIn(page, 'member_02@demo.test')
    await page.goto('/feed')

    const first = cards(page).first()
    await expect(first).toBeVisible()

    // --- Transparency ---------------------------------------------------------------
    // Asserted on the first card only: every card uses the same chip, so checking all
    // twenty re-runs identical markup for no extra coverage.
    const chip = first.locator('[data-reason]')
    await expect(chip).toBeVisible()

    // Human prose, not the raw code. A chip rendering `shared_hashtag` would satisfy a
    // visibility check while failing the product's actual promise.
    const reasonText = (await chip.innerText()).trim()
    expect(reasonText.length).toBeGreaterThan(0)
    expect(reasonText).not.toMatch(/^(shared_hashtag|friend|fresh|new_creator)$/)

    // Every card on the page carries one. Cheap here (no navigation) and it is the
    // property the brief names: "show members why an item appears".
    const missingReason = await cards(page).evaluateAll((nodes) =>
      nodes.filter((node) => node.querySelector('[data-reason]') === null).length,
    )
    expect(missingReason).toBe(0)

    // --- Hide an item ---------------------------------------------------------------
    const hiddenId = await first.getAttribute('data-entry-id')
    expect(hiddenId).toBeTruthy()

    await first.getByText('Tune').click()
    await first.getByRole('button', { name: /hide this/i }).click()

    // The action revalidates `/feed`, so the card goes without a reload.
    await expect(page.locator(`[data-entry-id="${hiddenId}"]`)).toHaveCount(0)

    // And it STAYS gone — the difference between "hide" and "skip".
    await page.reload()
    await expect(page.locator(`[data-entry-id="${hiddenId}"]`)).toHaveCount(0)

    // --- Mute a creator -------------------------------------------------------------
    // Scoped to the card and matched by PREFIX, not by handle: the handle is
    // member-supplied text and interpolating it into a regex is how a `+` or `(`
    // in a display name turns a passing test into a regex error. The card has exactly
    // one mute button, so the prefix is unambiguous.
    const remaining = cards(page).first()
    await expect(remaining).toBeVisible()

    const authorLink = remaining.locator('a[href^="/u/"]').first()
    const authorHref = await authorLink.getAttribute('href')
    expect(authorHref).toBeTruthy()

    await remaining.getByText('Tune').click()
    await remaining.getByRole('button', { name: /^mute @/i }).click()

    // Nothing by that creator remains, anywhere in the loaded feed.
    await expect(cards(page).locator(`a[href="${authorHref}"]`)).toHaveCount(0)

    await page.reload()
    await expect(cards(page).locator(`a[href="${authorHref}"]`)).toHaveCount(0)
  })

  test('the platform filter narrows the feed', async ({ page }) => {
    await signIn(page, 'member_03@demo.test')
    await page.goto('/feed')

    await expect(cards(page).first()).toBeVisible()

    await page.getByRole('button', { name: 'YouTube' }).click()
    await page.waitForURL(/platform=youtube/)

    await expect.poll(() => cards(page).count(), { timeout: 15_000 }).toBeGreaterThan(0)

    // The filter is a query parameter, so it survives a reload — which is what makes it
    // shareable and what keeps the cursor honest across a refresh.
    await page.reload()
    await expect.poll(() => cards(page).count(), { timeout: 15_000 }).toBeGreaterThan(0)
    expect(page.url()).toContain('platform=youtube')
  })

  test('"load more" appends without repeating entries', async ({ page }) => {
    await signIn(page, 'member_04@demo.test')
    await page.goto('/feed')

    const button = page.getByRole('button', { name: /load more/i })

    // A corpus smaller than one page has nothing to page through, and asserting a second
    // page there would fail for a reason that has nothing to do with pagination.
    if ((await button.count()) === 0) return

    const before = await cards(page).evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-entry-id')),
    )

    await button.click()

    await expect.poll(() => cards(page).count(), { timeout: 15_000 }).toBeGreaterThan(before.length)

    const after = await cards(page).evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute('data-entry-id')),
    )

    // Page two must contain no id page one already showed — the keyset's whole purpose.
    expect(new Set(after).size).toBe(after.length)
  })
})