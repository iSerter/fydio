'use client'

import { useState } from 'react'

import { PLATFORMS, PLATFORM_LABELS, detectPlatform, type Platform } from '@fydio/domain'
import { Button, Card, Stack } from '@fydio/ui'

/**
 * Optional public platform links (T03).
 *
 * Fydio never asks for a third-party credential. These are public profile URLs shown as
 * "elsewhere" on a profile card, and that is the whole feature -- there is no OAuth path
 * anywhere in this codebase, by design.
 *
 * WHY THE PLATFORM IS DETECTED RATHER THAN CHOSEN. The member pastes a URL; we work out which
 * platform it belongs to. Offering a dropdown invites someone to file an Instagram link under
 * "TikTok", which then renders with the wrong label and looks broken to a reader. Detection
 * uses `detectPlatform`, which matches on label boundaries -- so
 * `https://evil.example/instagram.com/p/1` is correctly rejected rather than accepted.
 *
 * At most one link per platform, mirroring the `unique (profile_id, platform)` constraint.
 */
export interface PlatformLinkValue {
  readonly platform: Platform
  readonly url: string
}

export interface PlatformLinksEditorProps {
  readonly initial: readonly PlatformLinkValue[]
  readonly onSave: (links: readonly PlatformLinkValue[]) => void
  readonly saving?: boolean
  readonly error?: string | null
}

export function PlatformLinksEditor({
  initial,
  onSave,
  saving = false,
  error,
}: PlatformLinksEditorProps) {
  const [links, setLinks] = useState<PlatformLinkValue[]>([...initial])

  function update(platform: Platform, url: string) {
    setLinks((current) => {
      const without = current.filter((link) => link.platform !== platform)
      return url.trim() === '' ? without : [...without, { platform, url: url.trim() }]
    })
  }

  return (
    <Card title="Elsewhere (optional)">
      <Stack gap={4}>
        <p className="text-sm text-ink-muted">
          Link to where you already post. Public profile URLs only — Fydio never asks for your
          passwords, and never will.
        </p>

        <Stack gap={3}>
          {PLATFORMS.map((platform) => {
            const existing = links.find((link) => link.platform === platform)
            const typed = existing?.url ?? ''
            const detected = typed.trim() === '' ? null : detectPlatform(typed)
            const mismatch = detected !== null && detected !== platform

            return (
              <div key={platform} className="flex flex-col gap-1">
                <label className="text-sm font-medium text-ink" htmlFor={`link-${platform}`}>
                  {PLATFORM_LABELS[platform]}
                </label>
                <input
                  id={`link-${platform}`}
                  type="url"
                  inputMode="url"
                  value={typed}
                  placeholder={`https://${platform}.com/yourhandle`}
                  aria-invalid={mismatch}
                  onChange={(event) => { update(platform, event.target.value); }}
                  className="rounded-control border border-border bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand aria-[invalid=true]:border-critical"
                />
                {mismatch ? (
                  <p className="text-xs text-critical">
                    That URL looks like {PLATFORM_LABELS[detected]}, not{' '}
                    {PLATFORM_LABELS[platform]}.
                  </p>
                ) : null}
              </div>
            )
          })}
        </Stack>

        <Button variant="secondary" onClick={() => { onSave(links); }} disabled={saving}>
          {saving ? 'Saving…' : 'Save links'}
        </Button>

        {error ? (
          <p role="alert" className="text-sm text-critical">
            {error}
          </p>
        ) : null}
      </Stack>
    </Card>
  )
}