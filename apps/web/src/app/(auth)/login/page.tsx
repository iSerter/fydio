import type { Metadata } from 'next'
import { Badge, Card, Stack } from '@fydio/ui'

import { MagicLinkForm } from '@/components/auth/MagicLinkForm'
import { safeNextPath } from '@/lib/next-path'

export const metadata: Metadata = {
  title: 'Sign in | Fydio',
}

/**
 * Dynamic because it reads search params.
 *
 * The `next` parameter decides where the member lands after signing in, so this cannot be
 * prerendered at build time with one baked-in value.
 */
export const dynamic = 'force-dynamic'

/**
 * The sign-in page (T03).
 *
 * There is deliberately no registration path. Fydio is invite-only: `DISABLE_SIGNUP=true`
 * on the Auth stack means `signUp` cannot succeed, and the only way an account comes into
 * existence is `claim_invite` redeeming a token an admin issued. The copy says so, because a
 * locked door with no explanation reads as a broken product.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const nextPath = safeNextPath(firstValue(params.next))

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-8 px-6 py-16">
      <Stack gap={3}>
        <Badge tone="brand">Invite only</Badge>
        <h1 className="text-3xl font-semibold tracking-tight">Sign in to Fydio</h1>
        <p className="text-ink-muted">
          Fydio is a private community. Accounts are created from an invitation, so there is
          nothing to register &mdash; enter the address your invitation was sent to and we
          will email a sign-in link.
        </p>
      </Stack>

      <MagicLinkForm nextPath={nextPath} />

      <Card title="Lost the invitation?">
        <p className="text-sm text-ink-muted">
          Ask whoever invited you to send another one. Invitations are single-use and can be
          revoked by an administrator.
        </p>
      </Card>
    </main>
  )
}

/**
 * A query parameter may arrive repeated (`?next=a&next=b`), which Next surfaces as an array.
 * Taking the first is enough -- `safeNextPath` validates whatever comes out.
 */
function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}