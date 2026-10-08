'use client'

import { useTransition } from 'react'

import { revokeInviteCodeAction } from './actions'

interface RevokeCodeButtonProps {
  readonly codeId: string
  readonly disabled?: boolean
}

export function RevokeCodeButton({ codeId, disabled }: RevokeCodeButtonProps) {
  const [isPending, startTransition] = useTransition()

  function handleRevoke() {
    if (!confirm('Are you sure you want to revoke this invite code? It will immediately stop working.')) {
      return
    }
    startTransition(async () => {
      await revokeInviteCodeAction(codeId)
    })
  }

  return (
    <button
      type="button"
      disabled={disabled ?? isPending}
      onClick={handleRevoke}
      className="text-xs font-medium text-critical hover:underline disabled:opacity-30 disabled:no-underline"
    >
      {isPending ? 'Revoking…' : 'Revoke'}
    </button>
  )
}
