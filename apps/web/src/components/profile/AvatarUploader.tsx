'use client'

import { useRef, useState } from 'react'

import Image from 'next/image'

import { describeAvatarRejection } from '@fydio/domain'
import { Card, Stack } from '@fydio/ui'

/**
 * Avatar upload control (T03).
 *
 * The file is POSTed to `POST /api/profile/avatar`, never uploaded to Supabase Storage
 * directly. That route re-encodes with `sharp` and enforces the size and type rules, so a
 * client that skipped it would be able to store an undecodable file or a decompression bomb.
 *
 * The checks here are for the MEMBER'S benefit -- an immediate message rather than a failed
 * round trip -- and are the same rule the server applies, imported from `@fydio/domain` so the
 * two cannot describe the limit differently.
 */
export interface AvatarUploaderProps {
  readonly currentUrl: string | null
  readonly onUploaded: (result: { avatarPath: string; avatarUrl: string }) => void
}

export function AvatarUploader({ currentUrl, onUploaded }: AvatarUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [preview, setPreview] = useState<string | null>(currentUrl)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSelect(file: File | undefined) {
    if (file === undefined) return

    // The same rule the route applies, so a 6 MB file is refused before it is read rather
    // than after a slow upload.
    const rejection = describeAvatarRejection({ type: file.type, size: file.size })

    if (rejection !== null) {
      setError(rejection)
      return
    }

    setError(null)
    setBusy(true)

    // Local preview via an object URL, so the member sees the crop before the round trip
    // completes. Revoked on replacement -- an unreleased object URL is a memory leak that
    // only shows up after a dozen uploads.
    const objectUrl = URL.createObjectURL(file)
    setPreview(objectUrl)

    try {
      const form = new FormData()
      form.append('file', file)

      const response = await fetch('/api/profile/avatar', { method: 'POST', body: form })
      const payload: unknown = await response.json().catch(() => null)

      if (!response.ok) {
        URL.revokeObjectURL(objectUrl)
        setPreview(currentUrl)
        setError(readError(payload) ?? 'That image could not be uploaded.')
        return
      }

      const result = (payload as { avatarPath?: unknown; avatarUrl?: unknown })

      if (typeof result.avatarPath !== 'string' || typeof result.avatarUrl !== 'string') {
        URL.revokeObjectURL(objectUrl)
        setPreview(currentUrl)
        setError('That image could not be uploaded.')
        return
      }

      URL.revokeObjectURL(objectUrl)
      setPreview(result.avatarUrl)
      onUploaded({ avatarPath: result.avatarPath, avatarUrl: result.avatarUrl })
    } catch {
      URL.revokeObjectURL(objectUrl)
      setPreview(currentUrl)
      setError('That image could not be uploaded.')
    } finally {
      setBusy(false)
      // Reset the input so re-picking the SAME file fires `change` again -- otherwise a member
      // who dislikes their first choice cannot undo it without choosing a different file.
      if (inputRef.current !== null) inputRef.current.value = ''
    }
  }

  return (
    <Card title="Profile photo">
      <Stack gap={4}>
        <div className="flex items-center gap-4">
          {preview === null ? (
            <div
              aria-hidden="true"
              className="h-20 w-20 rounded-full border border-border bg-surface-muted"
            />
          ) : (
            // `next/image` with `unoptimized`. The source is a public Storage object that is
            // already a 512px WebP under 200 KB -- re-encoding it would be pure loss, and the
            // optimiser's own cache would just duplicate bytes Storage already serves well.
            // `fill` plus a sized parent is what keeps the square crop without layout shift.
            <Image
              src={preview}
              alt="Your profile photo"
              width={80}
              height={80}
              unoptimized
              className="h-20 w-20 rounded-full border border-border object-cover"
            />
          )}

          <div className="flex flex-col gap-2">
            <input
              ref={inputRef}
              id="avatar-input"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="sr-only"
              onChange={(event) => void onSelect(event.target.files?.[0])}
            />
            <label
              htmlFor="avatar-input"
              className="inline-flex cursor-pointer items-center justify-center rounded-control border border-border bg-surface px-4 py-2 text-sm font-medium text-ink hover:bg-surface-muted"
            >
              {busy ? 'Uploading…' : preview === null ? 'Choose a photo' : 'Change photo'}
            </label>
            <p className="text-xs text-ink-subtle">
              JPEG, PNG or WebP, up to 5 MB. Resized to a square automatically — you can skip
              this step.
            </p>
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-critical">
            {error}
          </p>
        ) : null}
      </Stack>
    </Card>
  )
}

function readError(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null

  const error = (payload as { error?: unknown }).error

  return typeof error === 'string' ? error : null
}