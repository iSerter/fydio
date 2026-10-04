import { execFileSync } from 'node:child_process'

import { expect, test, type Page } from '@playwright/test'

/**
 * Credit economy journey (T05 §9): dashboard balance → submit spends one →
 * guard blocks the broke → feedback earns a held credit → submit spends again.
 *
 * The feedback composer is T09's UI; this spec drives the T05 API surface
 * (`/api/entries/[id]/open`, `/api/feedback`) the composer will use, so the
 * earn path is proven end-to-end before its UI exists.
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
): Promise<{ email: string }> {
  const email = `t05-e2e-${slug}-${Date.now()}@demo.test`
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

  return { email }
}

/** Publish one entry through the T04 form; returns the new entry id. */
async function publishEntry(page: Page, slug: string): Promise<string> {
  await page.goto('/submit')
  await expect(page.getByRole('heading', { name: /share something/i })).toBeVisible()
  await page
    .getByLabel('Content link')
    .fill(`https://www.youtube.com/watch?v=dQw4w9WgXcQ&t05=${slug}-${Date.now()}`)
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
async function apiPost(
  page: Page,
  path: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  return page.evaluate(
    async ({ url, payload }) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      return { status: response.status, json: (await response.json().catch(() => null)) as unknown }
    },
    { url: path, payload: body },
  )
}

test.describe('credit economy', () => {
  test('dashboard shows the balance; submitting spends exactly one', async ({ page }) => {
    const { email } = await onboardMember(page, 'Ada Creditor', 'creditor')
    grantStarter(email)

    await page.goto('/settings/credits')
    await expect(page.getByRole('heading', { name: /your credits/i })).toBeVisible()
    await expect(page.getByText('3 Credits', { exact: false }).first()).toBeVisible()

    await publishEntry(page, 'spend')

    await page.goto('/settings/credits')
    await expect(page.getByText('2 Credits', { exact: false }).first()).toBeVisible()
    await expect(page.getByText('Submission', { exact: false }).first()).toBeVisible()
  })

  test('a broke member sees the guard and cannot publish', async ({ page }) => {
    // No starter grant: a brand-new balance is zero.
    await onboardMember(page, 'Bo Broke', 'broke')

    await page.goto('/submit')
    // getByText, not getByRole('alert'): Next's route announcer also carries
    // role=alert, so the role query is ambiguous by design.
    await expect(page.getByText(/you need 1 credit to publish/i)).toBeVisible()
    await expect(page.getByRole('button', { name: /publish for/i })).toBeDisabled()
  })

  test('feedback earns a held credit that a later submission spends', async ({ page }) => {
    const { email: authorEmail } = await onboardMember(page, 'Amy Author', 'author')
    grantStarter(authorEmail)
    const entryId = await publishEntry(page, 'target')

    const { email: criticEmail } = await onboardMember(page, 'Cid Critic', 'critic')
    grantStarter(criticEmail)

    const opened = await apiPost(page, `/api/entries/${entryId}/open`, {})
    expect(opened.status).toBe(200)

    const left = await apiPost(page, '/api/feedback', {
      entryId,
      body: 'The hook lands in the first two seconds and the payoff is clearly framed; the middle third sags and could lose one beat.',
      tags: ['hook', 'storytelling'],
      imagePaths: [],
    })
    expect(left.status).toBe(201)
    expect((left.json as { creditHeld?: boolean }).creditHeld).toBe(true)

    // Earned but held: the spendable figure has not moved, and the dashboard
    // says why.
    await page.goto('/settings/credits')
    await expect(page.getByText('3 Credits', { exact: false }).first()).toBeVisible()
    await expect(page.getByText(/pending review/i).first()).toBeVisible()

    // Spending still works with a held credit in flight.
    await publishEntry(page, 'afterspend')
    await page.goto('/settings/credits')
    await expect(page.getByText('2 Credits', { exact: false }).first()).toBeVisible()
  })
})
