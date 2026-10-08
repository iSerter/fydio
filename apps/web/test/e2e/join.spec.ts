import { execFileSync } from 'node:child_process'

import { expect, test } from '@playwright/test'

const APP_URL = process.env.APP_URL ?? 'http://localhost:3000'

/** Run `issue-invite-code.ts` and return the raw code it printed. */
function issueInviteCode(uses: number, label?: string): string {
  const args = ['--filter', '@fydio/web', 'invite:code', '--uses', String(uses)]
  if (label) {
    args.push('--label', label)
  }

  const output = execFileSync('pnpm', args, {
    encoding: 'utf8',
    cwd: process.cwd(),
  })

  const match = /\/join\/([0-9ABCDEFGHJKMNPQRSTVWXYZ]{16,32})/i.exec(output)
  if (!match?.[1]) {
    throw new Error(`could not read an invite code from the script output:\n${output}`)
  }

  return match[1]
}

test.describe('T11 Limited-use invite codes (/join/{code})', () => {
  test('landing page hides remaining count, takes email, provisions account to onboarding, and exhausts cap', async ({
    page,
    browser,
  }) => {
    // 1. Issue a code with cap of 2
    const code = issueInviteCode(2, 'e2e-capped-batch')

    // 2. Visitor 1 views landing page
    await page.goto(`${APP_URL}/join/${code}`)
    await expect(page.getByRole('heading', { name: 'Join Fydio' })).toBeVisible()
    await expect(page.getByText("You're invited")).toBeVisible()
    await expect(page.getByRole('link', { name: 'Continue' })).toBeVisible()

    // Non-oracle assertion: no mention of "2 left" or "0 of 2" to visitors
    await expect(page.getByText('2 of 2')).not.toBeVisible()
    await expect(page.getByText('left')).not.toBeVisible()

    // 3. Visitor 1 proceeds to join form
    await page.getByRole('link', { name: 'Continue' }).click()
    await page.waitForURL(`**/join/${code}/join`)

    const email1 = `e2e-join-1-${Date.now()}@demo.test`
    await page.getByLabel('Email address').fill(email1)
    await page.getByRole('button', { name: 'Create my account' }).click()

    // Successfully logged in and redirected to onboarding
    await page.waitForURL('**/onboarding', { timeout: 15_000 })
    await expect(page).toHaveURL(new RegExp('/onboarding'))

    // 4. Visitor 2 in a clean context takes the second slot
    const context2 = await browser.newContext()
    const page2 = await context2.newPage()

    await page2.goto(`${APP_URL}/join/${code}/join`)
    const email2 = `e2e-join-2-${Date.now()}@demo.test`
    await page2.getByLabel('Email address').fill(email2)
    await page2.getByRole('button', { name: 'Create my account' }).click()

    await page2.waitForURL('**/onboarding', { timeout: 15_000 })
    await expect(page2).toHaveURL(new RegExp('/onboarding'))
    await context2.close()

    // 5. Visitor 3 in a clean context sees the code is exhausted
    const context3 = await browser.newContext()
    const page3 = await context3.newPage()

    await page3.goto(`${APP_URL}/join/${code}`)
    await expect(page3.getByText('This link is fully claimed')).toBeVisible()
    await expect(page3.getByText('Everyone this link was shared with has already joined.')).toBeVisible()
    await expect(page3.getByRole('link', { name: 'Continue' })).not.toBeVisible()

    // Direct navigation to form also shows exhausted state
    await page3.goto(`${APP_URL}/join/${code}/join`)
    await expect(page3.getByText('This link is fully claimed')).toBeVisible()
    await expect(page3.getByLabel('Email address')).not.toBeVisible()

    await context3.close()
  })

  test('reports invalid code cleanly when code is malformed', async ({ page }) => {
    await page.goto(`${APP_URL}/join/malformed-code-123`)
    await expect(page.getByText('This link is not valid')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Go to sign in' })).toBeVisible()
  })
})
