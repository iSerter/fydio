'use client'

import { useActionState, useState } from 'react'

import { Card, Stack } from '@fydio/ui'

import { createInviteCodeAction, type CreateInviteCodeResult } from './actions'

const initialState: CreateInviteCodeResult = { ok: false }

export function IssueInviteCodeForm() {
  const [state, formAction, isPending] = useActionState(createInviteCodeAction, initialState)
  const [copied, setCopied] = useState(false)

  const rawCode = state.ok && state.rawCode ? state.rawCode : null
  const displayLink = rawCode ? `/join/${rawCode}` : null

  function handleCopy() {
    if (!rawCode) return
    const fullLink = `${window.location.origin}/join/${rawCode}`
    void navigator.clipboard.writeText(fullLink).then(() => {
      setCopied(true)
      setTimeout(() => {
        setCopied(false)
      }, 2000)
    })
  }

  return (
    <Card title="Issue limited-use invite code">
      <Stack gap={4}>
        <p className="text-xs text-ink-muted">
          Mint a short, shareable Crockford base-32 code that can be redeemed up to a maximum number of times.
        </p>

        {displayLink && (
          <div className="rounded-control border border-brand/30 bg-brand/5 p-4">
            <Stack gap={2}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-brand">Invitation link generated</span>
                <span className="text-[11px] text-ink-muted">Shown once</span>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  readOnly
                  value={displayLink}
                  className="flex-1 font-mono text-xs rounded-control border border-border bg-surface px-2.5 py-1.5 text-ink select-all"
                />
                <button
                  type="button"
                  onClick={handleCopy}
                  className="rounded-control bg-brand px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-brand-hover"
                >
                  {copied ? 'Copied!' : 'Copy full URL'}
                </button>
              </div>
              <p className="text-[11px] text-ink-muted">
                Only the SHA-256 digest is stored in the database. If this link is lost, mint a new one.
              </p>
            </Stack>
          </div>
        )}

        <form action={formAction}>
          <Stack gap={3}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="flex flex-col gap-1">
                <label htmlFor="max_uses" className="text-xs font-medium text-ink">
                  Max uses <span className="text-critical">*</span>
                </label>
                <input
                  id="max_uses"
                  name="max_uses"
                  type="number"
                  min="1"
                  max="1000"
                  required
                  placeholder="e.g. 5"
                  className="rounded-control border border-border bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="label" className="text-xs font-medium text-ink">
                  Label <span className="text-ink-muted">(internal note)</span>
                </label>
                <input
                  id="label"
                  name="label"
                  type="text"
                  placeholder="e.g. March newsletter"
                  className="rounded-control border border-border bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label htmlFor="days" className="text-xs font-medium text-ink">
                  Expires in <span className="text-ink-muted">(days)</span>
                </label>
                <input
                  id="days"
                  name="days"
                  type="number"
                  min="1"
                  placeholder="e.g. 14"
                  className="rounded-control border border-border bg-surface px-3 py-1.5 text-sm text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none"
                />
              </div>
            </div>

            {state.error && (
              <p role="alert" className="text-xs text-critical">
                {state.error}
              </p>
            )}

            <div className="flex justify-end pt-1">
              <button
                type="submit"
                disabled={isPending}
                className="inline-flex items-center justify-center rounded-control bg-brand px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-brand-hover disabled:opacity-50"
              >
                {isPending ? 'Generating…' : 'Generate invite link'}
              </button>
            </div>
          </Stack>
        </form>
      </Stack>
    </Card>
  )
}
