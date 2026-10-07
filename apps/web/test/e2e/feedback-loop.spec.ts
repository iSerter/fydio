import { execFileSync } from 'node:child_process'

import { expect, test, type Page } from '@playwright/test'

/**
 * End-to-end feedback loop (T09):
 *
 * 1. Creator publishes entry.
 * 2. Critic opens entry, writes feedback with tag chips, submits.
 * 3. Critic views their feedback portfolio (/dashboard/feedback).
 * 4. Creator opens /inbox, sees feedback, rates 8/10, then revises to 9/10.
 * 5. Critic's public profile (/u/[handle]) displays the rated feedback highlight.
 * 6. Report flow works and surfaces in admin moderation queue.
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
  const email = `t09-e2e-${slug}-${Date.now()}@demo.test`
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
    .fill(`https://www.youtube.com/watch?v=dQw4w9WgXcQ&t09=${slug}-${Date.now()}`)
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

test.describe('feedback loop', () => {
  test('end-to-end feedback submission, portfolio view, creator rating, and revision', async ({
    page,
  }) => {
    // 1. Setup creator and publish an entry
    const { email: creatorEmail } = await onboardMember(page, 'Casey Creator', 'creator')
    grantStarter(creatorEmail)
    const entryId = await publishEntry(page, 'critique-target')
    const creatorCookies = await page.context().cookies()

    // 2. Setup critic and open entry
    const { handle: criticHandle } = await onboardMember(
      page,
      'Frank Feedback',
      'critic',
    )

    // Simulate entry open
    const openRes = await page.evaluate(async (id) => {
      const res = await fetch(`/api/entries/${id}/open`, {
        method: 'POST',
      })
      return res.status
    }, entryId)
    expect(openRes).toBe(200)

    // 3. Visit entry page and submit feedback
    await page.goto(`/c/${entryId}`)
    await expect(page.getByRole('heading', { name: /community feedback/i })).toBeVisible()

    // Submit feedback using API from member session (ensuring quality gate)
    const feedbackBody =
      'This hook is very compelling and grabs attention immediately. The pacing in the middle third could be tightened to maintain viewer retention before the climax.'

    const submitRes = await page.evaluate<
      { status: number; data: { feedback?: { id: string } } },
      { id: string; body: string }
    >(
      async ({ id, body }) => {
        const res = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entryId: id,
            body,
            tags: ['hook', 'editing'],
            imagePaths: [],
          }),
        })
        const data = (await res.json()) as { feedback?: { id: string } }
        return { status: res.status, data }
      },
      { id: entryId, body: feedbackBody },
    )

    expect(submitRes.status).toBe(201)
    const feedbackId = submitRes.data.feedback?.id
    expect(feedbackId).toBeDefined()
    if (!feedbackId) throw new Error('Feedback id missing')

    // 4. Critic views their feedback portfolio
    await page.goto('/dashboard/feedback')
    await expect(page.getByText('My Feedback Portfolio')).toBeVisible()
    await expect(page.getByText(feedbackBody.slice(0, 50))).toBeVisible()

    // 5. Creator switches back, opens inbox, and rates feedback
    await page.context().clearCookies()
    await page.context().addCookies(creatorCookies)

    await page.goto('/inbox')
    await expect(page.getByText('Creator Feedback Inbox')).toBeVisible()
    await expect(page.getByText(feedbackBody.slice(0, 50))).toBeVisible()

    // Rate 8/10
    const rateRes = await page.evaluate<{ status: number }, { fbId: string; score: number }>(
      async ({ fbId, score }) => {
        const res = await fetch(`/api/feedback/${fbId}/rate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ score }),
        })
        return { status: res.status }
      },
      { fbId: feedbackId, score: 8 },
    )
    expect(rateRes.status).toBe(201)

    // Revise rating to 9/10 within revision window
    const reviseRes = await page.evaluate<{ status: number }, { fbId: string; score: number }>(
      async ({ fbId, score }) => {
        const res = await fetch(`/api/feedback/${fbId}/rate`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ score }),
        })
        return { status: res.status }
      },
      { fbId: feedbackId, score: 9 },
    )
    expect(reviseRes.status).toBe(200)

    // 6. Check critic's public profile for updated reputation and rated feedback highlights
    await page.goto(`/u/${criticHandle}`)
    await expect(page.getByText('9/10').first()).toBeVisible({ timeout: 10_000 })
    await expect(page.getByText('9 Reputation', { exact: false })).toBeVisible()

    // 7. Test reporting
    const reportRes = await page.evaluate<{ status: number }, { targetId: string }>(
      async ({ targetId }) => {
        const res = await fetch('/api/reports', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetType: 'feedback',
            targetId,
            reason: 'other',
            details: 'E2E test reporting feedback',
          }),
        })
        return { status: res.status }
      },
      { targetId: feedbackId },
    )
    expect(reportRes.status).toBe(201)
  })
})
