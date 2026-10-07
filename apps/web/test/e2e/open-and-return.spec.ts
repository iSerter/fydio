import { execFileSync } from 'node:child_process'

import { expect, test, type Page } from '@playwright/test'

/**
 * Open → return → prompt (T08 §9).
 *
 * THE JOURNEY. Sign in → publish an entry → open its outbound link → the platform
 * tab opens on the ORIGINAL, UNMODIFIED url → come back to Fydio → the return link
 * resolves and offers feedback.
 *
 * WHY THE PLATFORM TAB IS INTERCEPTED. The link goes to youtube.com, and a test
 * that actually loads YouTube would depend on the network, on consent walls, and on
 * whatever that site serves today. Every `route()` here answers from the test, so
 * the assertion is about Fydio's behaviour: WHICH url was requested and what the
 * Fydio tab does afterwards. That is the whole subject of this task.
 *
 * WHY THE URL IS ASSERTED CHARACTER BY CHARACTER. "Fydio appends nothing to the
 * outbound link" is a promise the pgTAP suite cannot check and this one can. It is
 * the assertion that would fail if someone later added a `?fydio_ref=` "just for
 * attribution" — so it is here, against a real navigation, rather than in a comment.
 *
 * MEMBERS ARRIVE THROUGH AN INVITATION. Fydio is invite-only with no password, so
 * this reuses the redemption path `credits.spec.ts` established rather than
 * inventing a sign-in the product does not have.
 */

/** A raw invite token, printed by the T03 issuing script. */
function issueInvite(email: string): string {
  const output = execFileSync('pnpm', ['--filter', '@fydio/web', 'invite:new', '--email', email], {
    encoding: 'utf8',
    cwd: process.cwd(),
  })

  const match = /\/invite\/([0-9a-f]{64})/.exec(output)

  if (match?.[1] === undefined) throw new Error(`no invite token in output:\n${output}`)

  return match[1]
}

/** Give the new member the weekly starter allowance, so they can publish. */
function grantStarter(email: string): void {
  execFileSync('pnpm', ['--filter', '@fydio/web', 'credits:allowance', '--email', email], {
    encoding: 'utf8',
    cwd: process.cwd(),
  })
}

/**
 * Onboard a member through the wizard; returns their email.
 *
 * `/auth/accept?token=` redeems the invitation and signs the member in directly, so
 * there is no email to wait for on this path — the link a member follows is the
 * invitation they were sent. `feed.spec.ts` waits for mail because it signs in
 * through `/login`, which is a different journey.
 */
async function onboardMember(page: Page, displayName: string, slug: string): Promise<string> {
  const email = `t08-e2e-${slug}-${Date.now()}@demo.test`

  await page.context().clearCookies()
  await page.goto(`/auth/accept?token=${issueInvite(email)}`)

  await page.waitForURL(/\/onboarding/, { timeout: 30_000 })
  await page.getByLabel('Display name').fill(displayName)
  await page.getByRole('button', { name: /^Continue$/ }).click()
  await expect(page.getByText('Step 2 of 5')).toBeVisible()
  await page.getByRole('button', { name: /skip for now/i }).click()
  await expect(page.getByText('Step 3 of 5')).toBeVisible()
  await page.getByRole('button', { name: /^Continue$/ }).click()
  await expect(page.getByText('Step 4 of 5')).toBeVisible()

  const suggestions = page.getByRole('list', { name: 'Suggested hashtags' })
  for (let i = 1; i <= 5; i += 1) {
    await suggestions.getByRole('button').first().click()
    await expect(page.getByText(`${i} of 5 selected`)).toBeVisible()
  }

  await page.getByRole('button', { name: /^Continue$/ }).click()
  await expect(page.getByText('Step 5 of 5')).toBeVisible()
  await page.getByRole('button', { name: /finish setup/i }).click()
  await page.waitForURL(/\/feed/, { timeout: 30_000 })

  return email
}

/** Publish one entry through the T04 form; returns `{ entryId, url }`. */
async function publishEntry(page: Page, slug: string): Promise<{ entryId: string; url: string }> {
  const url = `https://www.youtube.com/watch?v=t08e2e${slug}${Date.now()}`

  await page.goto('/submit')
  await expect(page.getByRole('heading', { name: /share something/i })).toBeVisible()
  await page.getByLabel('Content link').fill(url)
  await page.getByLabel('Content link').blur()
  await expect(page.getByText('youtube', { exact: false }).first()).toBeVisible({ timeout: 15_000 })

  const suggestions = page.getByRole('list', { name: 'Suggested hashtags' })
  for (let i = 1; i <= 3; i += 1) {
    await suggestions.getByRole('button').first().click()
    await expect(page.getByText(`${i} of 3 selected`)).toBeVisible()
  }

  await page.getByRole('button', { name: /publish for/i }).click()
  await page.waitForURL(/\/c\//, { timeout: 30_000 })

  const match = /\/c\/([0-9a-f-]{36})/.exec(page.url())

  if (match?.[1] === undefined) throw new Error(`no entry id in url: ${page.url()}`)

  return { entryId: match[1], url }
}

test.describe('open and return', () => {
  test('opens the original link untouched and returns to a feedback prompt', async ({
    page,
    context,
  }) => {
    const email = await onboardMember(page, 'Olive Returner', 'returner')
    grantStarter(email)

    const { entryId, url } = await publishEntry(page, 'return')

    // Every outbound request is answered by the test, and the requested URL is
    // recorded. Nothing reaches the real internet, so the assertion below is about
    // the href Fydio produced rather than about YouTube.
    const requested: string[] = []

    await context.route('**/*', (route) => {
      const requestedUrl = route.request().url()

      // Only the platform. Fydio's own assets must still load, or the page would
      // render unstyled and the locators below would have nothing to find.
      if (!requestedUrl.startsWith(url)) {
        void route.continue()
        return
      }

      requested.push(requestedUrl)

      void route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><title>Platform stand-in</title><p>pretend post</p>',
      })
    })

    const outbound = page.getByRole('link', { name: /open on youtube/i }).first()

    // The href is the entry's original URL, byte for byte. This is the load-bearing
    // assertion of the whole task: no query parameter, no fragment, no Fydio domain
    // in sight. `getAttribute` rather than `getProperty('href')`, because the
    // property resolves the URL against the page and would normalise away the very
    // difference being tested.
    expect(await outbound.getAttribute('href')).toBe(url)
    expect(await outbound.getAttribute('target')).toBe('_blank')
    expect(await outbound.getAttribute('rel')).toBe('noopener noreferrer nofollow')

    // The link opens a new tab. `waitForEvent('popup')` rather than clicking and
    // hoping: without it the assertion could pass against the original tab, which
    // would prove nothing about `target="_blank"`.
    const [platform] = await Promise.all([context.waitForEvent('page'), outbound.click()])

    await platform.waitForLoadState('domcontentloaded')

    expect(requested).toEqual([url])

    // The click was recorded: `opened` is marked, which is what the feedback
    // prerequisite reads. Read through the app's own API rather than the database,
    // because that is the surface a member's browser actually uses.
    const marked = await page.evaluate(async (id) => {
      const response = await fetch(`/api/entries/${id}/open`, { method: 'POST' })
      return response.status
    }, entryId)

    expect(marked).toBe(200)

    await platform.close()

    // THE RETURN LEG. The Fydio tab holds the return token — the outbound URL carries
    // nothing, which is why this is a server-side lookup rather than a redirect, and
    // why the token has to be minted by the app rather than derived from the link.
    const returnToken = await page.evaluate(async (id) => {
      const response = await fetch('/api/opened/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entryId: id }),
      })

      if (!response.ok) return null

      const payload = (await response.json()) as { token?: string }

      return payload.token ?? null
    }, entryId)

    expect(returnToken, 'a click must yield a return token').toMatch(/^[0-9a-f]{64}$/)

    await page.goto(`/opened/${String(returnToken)}`)

    await expect(page.getByText('Back from the platform')).toBeVisible()
    await expect(page.getByRole('link', { name: /leave feedback/i })).toBeVisible()
    // And the entry it is about, so the prompt is anchored to real context.
    await expect(page.locator(`a[href="/c/${entryId}"]`).first()).toBeVisible()
  })

  test('shows a safe fallback for a tampered return link', async ({ page }) => {
    await onboardMember(page, 'Tamper Tester', 'tamper')

    // All `f`s: the right SHAPE, no matching click. A token of the wrong shape would
    // be rejected before the database was consulted, which is a different path from
    // the one this asserts — the token probe happening and finding nothing.
    await page.goto(`/opened/${'f'.repeat(64)}`)

    await expect(page.getByRole('heading', { name: /this link has expired/i })).toBeVisible()
    await expect(page.getByRole('link', { name: /go to your feed/i })).toBeVisible()
    // No internal detail: not a stack trace, not a database error, not a 500.
    await expect(page.getByText(/relation .* does not exist/i)).toHaveCount(0)
  })

  test('the privacy panel shows the member their own opens, and consent is off by default', async ({
    page,
  }) => {
    await onboardMember(page, 'Private Pender', 'pender')

    await page.goto('/settings/privacy')

    await expect(page.getByRole('heading', { name: 'Privacy' })).toBeVisible()

    // The consent control starts OFF for a brand-new member. This is the default
    // that makes "opt-in" true rather than aspirational.
    const consent = page.getByRole('checkbox')
    await expect(consent).not.toBeChecked()

    // The scope text is on the page wherever the toggle is, not only in a policy
    // document somewhere else. `.first()` because the full consent copy AND the short
    // disclaimer both contain the Credits-or-Reputation guarantee, deliberately — two
    // independent renderings of the same promise, and a strict-mode violation here
    // would be the test being stricter than the product needs to be.
    await expect(page.getByText(/rough range only/i).first()).toBeVisible()
    await expect(
      page.getByText(/never affects Credits or Reputation/i).first(),
    ).toBeVisible()

    // And the deletion control exists, because the consent copy promises it.
    await expect(page.getByRole('button', { name: /delete my duration history/i })).toBeVisible()

    // Turning it on persists, and the panel says so.
    await consent.check()
    await expect(page.getByText(/on since/i)).toBeVisible()

    await page.reload()
    await expect(page.getByRole('checkbox')).toBeChecked()

    // Turning it back off persists too: revocation has to be as durable as the
    // grant, or "turn this off" would be a suggestion.
    await page.getByRole('checkbox').uncheck()
    await expect(page.getByText(/on since/i)).toHaveCount(0)

    await page.reload()
    await expect(page.getByRole('checkbox')).not.toBeChecked()
  })

  test('lists the entries the member opened, and nobody else can', async ({ page }) => {
    const email = await onboardMember(page, 'Opener Opener', 'opener')
    grantStarter(email)

    const { entryId } = await publishEntry(page, 'activity')

    // No consent yet, so no duration band — only the open. The panel must show the
    // open without inventing a measurement beside it.
    const returnToken = await page.evaluate(async (id) => {
      const response = await fetch('/api/opened/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ entryId: id }),
      })

      return ((await response.json()) as { token?: string }).token ?? null
    }, entryId)

    expect(returnToken).toMatch(/^[0-9a-f]{64}$/)

    await page.goto('/settings/privacy')

    await expect(page.getByRole('heading', { name: 'Your activity' })).toBeVisible()
    // The entry they opened is listed, linked to its own page.
    await expect(page.locator(`a[href="/c/${entryId}"]`).first()).toBeVisible()

    // No duration claim anywhere: without consent there is no band, and the panel
    // says "private to you" rather than implying a measurement exists.
    await expect(page.getByText(/private to you/i).first()).toBeVisible()
    await expect(page.getByText(/stayed /i)).toHaveCount(0)
  })

  test('offers the return prompt when the member comes back to their tab', async ({
    page,
    context,
  }) => {
    // Publishing needs a starter allowance, and the address is generated inside
    // `onboardMember`, so the grant is applied against the email it reports.
    const email = await onboardMember(page, 'Comer Backer', 'comer')
    grantStarter(email)

    const { url } = await publishEntry(page, 'prompt')

    await context.route('**/*', (route) => {
      if (!route.request().url().startsWith(url)) {
        void route.continue()
        return
      }

      void route.fulfill({ status: 200, contentType: 'text/html', body: '<p>platform</p>' })
    })

    const outbound = page.getByRole('link', { name: /open on youtube/i }).first()
    const [platform] = await Promise.all([context.waitForEvent('page'), outbound.click()])

    await platform.waitForLoadState('domcontentloaded')
    await platform.close()

    // The token was stored by the click handler, in this tab's sessionStorage.
    // Reading it here is what a return leg does — the same key, the same shape.
    const stored = await page.evaluate(() => {
      const raw = window.sessionStorage.getItem('fydio:return-token:v1')
      return raw === null ? null : (JSON.parse(raw) as { token?: string; platformLabel?: string })
    })

    expect(stored?.token).toMatch(/^[0-9a-f]{64}$/)
    expect(stored?.platformLabel).toBe('YouTube')

    // The prompt appears once the settle delay has passed and this tab regains
    // focus. Re-dispatching `focus` is what a real tab switch produces, and the
    // five-second delay is why this waits rather than asserting immediately.
    await page.waitForTimeout(5500)
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'))
    })

    const prompt = page.getByRole('status').filter({ hasText: /back from youtube/i })
    await expect(prompt).toBeVisible()
    await expect(prompt.getByRole('link', { name: /continue/i })).toBeVisible()

    // Following it lands on the prompt page for the entry that was opened.
    await prompt.getByRole('link', { name: /continue/i }).click()
    await expect(page.getByText('Back from the platform')).toBeVisible()
    await expect(page.getByRole('link', { name: /leave feedback/i })).toBeVisible()

    // And the token is consumed, so a reload does not offer the same return twice.
    expect(
      await page.evaluate(() => window.sessionStorage.getItem('fydio:return-token:v1')),
    ).toBeNull()
  })
})
