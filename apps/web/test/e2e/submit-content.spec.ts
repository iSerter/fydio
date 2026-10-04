import { execFileSync } from 'node:child_process'

import { expect, test, type Page } from '@playwright/test'

/**
 * Submission journey (T04 §9): sign in → /submit → invalid URL shows an inline
 * error → valid URL + 3 hashtags + note → lands on /c/[id] → outbound link
 * points at the original platform.
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

async function onboardMember(page: Page, displayName: string, slug: string): Promise<{ email: string }> {
  const email = `t04-e2e-${slug}-${Date.now()}@demo.test`
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

  // A member created mid-test has no Credits until someone grants them. This
  // inserts the same row the weekly sweeper would have written, for this
  // member only (the sweeper itself is idempotent per week and already ran).
  execFileSync(
    'pnpm',
    ['--filter', '@fydio/web', 'credits:allowance', '--email', email],
    { encoding: 'utf8', cwd: process.cwd() },
  )

  return { email }
}

test.describe('content submission', () => {
  test('invalid URL shows an inline error; valid URL + 3 hashtags publishes', async ({ page }) => {
    await onboardMember(page, 'Tess Submitter', 'submitter')
    await page.goto('/submit')
    await expect(page.getByRole('heading', { name: /share something/i })).toBeVisible()

    // Invalid URL → inline error, no navigation.
    await page.getByLabel('Content link').fill('https://evil-instagram.com/p/x')
    await page.getByLabel('Content link').blur()
    await expect(page.getByRole('alert').first()).toContainText(/not a supported post/i)

    // Valid URL + exactly 3 hashtags + note → /c/[id].
    const original = `https://www.youtube.com/watch?v=dQw4w9WgXcQ&t04=${Date.now()}`
    await page.getByLabel('Content link').fill(original)
    await page.getByLabel('Content link').blur()
    await expect(page.getByText('youtube', { exact: false }).first()).toBeVisible({ timeout: 15_000 })

    const suggestions = page.getByRole('list', { name: 'Suggested hashtags' })
    for (let i = 1; i <= 3; i += 1) {
      await suggestions.getByRole('button').first().click()
      await expect(page.getByText(`${i} of 3 selected`)).toBeVisible()
    }
    await page.getByLabel(/creator note/i).fill('Watch the first minute.')
    await page.getByRole('button', { name: /publish for/i }).click()

    await page.waitForURL(/\/c\//, { timeout: 30_000 })
    const outbound = page.getByRole('link', { name: /open on youtube/i })
    await expect(outbound).toBeVisible()
    await expect(outbound).toHaveAttribute('href', original)
    await expect(outbound).toHaveAttribute('target', '_blank')
  })
})
