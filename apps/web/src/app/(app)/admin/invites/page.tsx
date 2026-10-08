import type { Metadata } from 'next'

import { Badge, Card, Stack } from '@fydio/ui'
import { createServiceClient } from '@fydio/supabase/service'

import { IssueInviteCodeForm } from './IssueInviteCodeForm'
import { RevokeCodeButton } from './RevokeCodeButton'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Invite Codes | Admin | Fydio',
}

function isCodeExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false
  return new Date(expiresAt).getTime() < Date.now()
}

export default async function AdminInvitesPage() {
  const service = createServiceClient()

  const { data: codes } = await service
    .from('invite_codes')
    .select('id, label, max_uses, used_count, created_at, expires_at, revoked_at')
    .order('created_at', { ascending: false })

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-bold text-ink">Invite Codes Management</h2>
        <p className="text-xs text-ink-muted">
          Mint limited-use Crockford base-32 links to admit cohorts without collecting email addresses in advance.
        </p>
      </div>

      <IssueInviteCodeForm />

      <Card title={`Active and past invite codes (${codes?.length ?? 0})`}>
        <Stack gap={4}>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border text-ink-muted">
                <tr>
                  <th className="py-2 pr-4 font-medium">Label</th>
                  <th className="py-2 pr-4 font-medium">Uses</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Expires</th>
                  <th className="py-2 pr-4 font-medium">Created</th>
                  <th className="py-2 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {(codes ?? []).map((code) => {
                  const isRevoked = code.revoked_at !== null
                  const isExpired = isCodeExpired(code.expires_at)
                  const isExhausted = code.used_count >= code.max_uses

                  let statusText = 'Active'
                  let tone: 'brand' | 'critical' | 'neutral' | 'warning' = 'brand'

                  if (isRevoked) {
                    statusText = 'Revoked'
                    tone = 'critical'
                  } else if (isExpired) {
                    statusText = 'Expired'
                    tone = 'warning'
                  } else if (isExhausted) {
                    statusText = 'Claimed'
                    tone = 'neutral'
                  }

                  const canRevoke = !isRevoked && !isExpired && !isExhausted

                  return (
                    <tr key={code.id} className="hover:bg-surface-muted/50">
                      <td className="py-2.5 pr-4 font-medium text-ink">
                        {code.label ?? <span className="text-ink-muted italic">(none)</span>}
                      </td>
                      <td className="py-2.5 pr-4 font-mono text-ink">
                        {code.used_count} / {code.max_uses}
                        <span className="text-ink-muted ml-1 font-sans">
                          ({code.max_uses - code.used_count} left)
                        </span>
                      </td>
                      <td className="py-2.5 pr-4">
                        <Badge tone={tone}>{statusText}</Badge>
                      </td>
                      <td className="py-2.5 pr-4 text-ink-muted">
                        {code.expires_at ? (
                          new Date(code.expires_at).toLocaleDateString()
                        ) : (
                          <span className="text-ink-muted italic">Never</span>
                        )}
                      </td>
                      <td className="py-2.5 pr-4 text-ink-muted">
                        {new Date(code.created_at).toLocaleDateString()}
                      </td>
                      <td className="py-2.5 text-right">
                        <RevokeCodeButton codeId={code.id} disabled={!canRevoke} />
                      </td>
                    </tr>
                  )
                })}

                {(codes ?? []).length === 0 && (
                  <tr>
                    <td colSpan={6} className="py-6 text-center text-ink-muted">
                      No invite codes have been minted yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Stack>
      </Card>
    </div>
  )
}
