import { execFileSync } from 'node:child_process'

import { expect, test, type Page } from '@playwright/test'

/**
 * Reputation journey (T06 §9): creator rates a member's feedback 1–10 →
 * the giver's public profile shows the updated total, rated count and average.
 *
 * Rating input UI lands in T09; this spec drives the T06 API surface
 * (`/api/feedback/[id]/rate`) the inbox will use, so the ledger path is proven
 * end-to-end before its UI exists.
 */

function issueInvite(email: string): string {
  const output = execFileSync('pnpm', ['--filter', '@fydio/web', 'invite:new', '--email', email], {
    encoding: 'utf8',
    cwd: process.cwd(),
  })
  const match = /\/invite\/([0-9a-f]{64})/.exec(output)
  if (match?.[1] === undefined) throw new Error(`no invite token in output:\n${output}`)
  return match[1]
}

function grantStarter(email: string): void {
  execFileSync('pnpm', ['--filter', '@fydio/web', 'credits:allowance', '--email', email], {
    encoding: 'utf8',
    cwd: process.cwd(),
  })
}

async function onboardMember(
  page: Page,
  displayName: string,
  slug: string,
): Promise<{ email: string; handle: string }> {
  const email = `t06-e2e-${slug}-${Date.now()}@demo.test`
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

  // Handle is derived from the email local part; read it from the account page.
  await page.goto('/settings/account')
  const handleText = await page.getByText(/^@/).first().textContent()
  const handle = handleText?.replace(/^@/, '').trim() ?? ''
  return { email, handle }
}

async function publishEntry(page: Page, slug: string): Promise<string> {
  await page.goto('/submit')
  await expect(page.getByRole('heading', { name: /share something/i })).toBeVisible()
  await page
    .getByLabel('Content link')
    .fill(`https://www.youtube.com/watch?v=dQw4w9WgXcQ&t06=${slug}-${Date.now()}`)
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
  if (!match?.[1]) throw new Error(`no entry id in url: ${page.url()}`)
  return match[1]
}

/** Fetch from inside the page so the member's session cookies travel along. */
async function apiFetch(
  page: Page,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<{ status: number; json: unknown }> {
  return page.evaluate(
    async ({ url, method, payload }) => {
      const init: RequestInit =
        payload === undefined
          ? { method: method ?? 'GET' }
          : {
              method: method ?? 'GET',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload),
            }
      const response = await fetch(url, init)
      return { status: response.status, json: (await response.json().catch(() => null)) as unknown }
    },
    { url: path, method: init?.method, payload: init?.body },
  )
}

test.describe('reputation', () => {
  test('creator rates feedback and the giver profile shows the new total', async ({ page }) => {
    const { email: authorEmail } = await onboardMember(page, 'Rita Rater', 'rater')
    grantStarter(authorEmail)
    const entryId = await publishEntry(page, 'target')

    // Critic session: open + leave feedback. Capture the session cookies, then
    // restore the author session by re-onboarding state via cookie save/restore.
    const authorCookies = await page.context().cookies()

    const { email: criticEmail, handle: criticHandle } = await onboardMember(
      page,
      'Gus Giver',
      'giver',
    )
    grantStarter(criticEmail)

    const opened = await apiFetch(page, `/api/entries/${entryId}/open`, {
      method: 'POST',
      body: {},
    })
    expect(opened.status).toBe(200)

    const left = await apiFetch(page, '/api/feedback', {
      method: 'POST',
      body: {
        entryId,
        body: 'The hook lands in the first two seconds and the payoff is clearly framed; the middle third sags and could lose one beat.',
        tags: ['hook', 'storytelling'],
        imagePaths: [],
      },
    })
    expect(left.status).toBe(201)
    const feedbackId = (left.json as { feedback?: { id?: string } }).feedback?.id
    expect(feedbackId).toMatch(/^[0-9a-f-]{36}$/i)

    // Back to the author session to rate.
    await page.context().clearCookies()
    for (const cookie of authorCookies) {
      await page.context().addCookies([cookie])
    }

    const rated = await apiFetch(page, `/api/feedback/${feedbackId}/rate`, {
      method: 'POST',
      body: { score: 8 },
    })
    expect(rated.status).toBe(201)

    // The giver's PUBLIC profile shows the updated reputation — visible to the
    // author, proving the same numbers every member sees.
    await page.goto(`/u/${criticHandle}`)
    await expect(page.getByText('8 Reputation', { exact: false })).toBeVisible()
    await expect(page.getByText(/8\.00 average from 1 rating/i)).toBeVisible()
  })
})
