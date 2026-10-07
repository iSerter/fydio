'use client'

import { useState, type SyntheticEvent } from 'react'

import {
  FEEDBACK_COPY,
  MIN_FEEDBACK_CHARS,
  meetsQualityGate,
  type FeedbackTag,
} from '@fydio/domain'

import { ImageSlots, type UploadedImage } from './ImageSlots'
import { TagPicker } from './TagPicker'

export interface FeedbackComposerProps {
  readonly entryId: string
  readonly initialFeedbackId?: string
  readonly initialBody?: string
  readonly initialTags?: readonly FeedbackTag[]
  readonly initialImagePaths?: readonly string[]
  readonly onSubmitted?: (feedback: unknown) => void
  readonly onCancel?: () => void
}

export function FeedbackComposer({
  entryId,
  initialFeedbackId,
  initialBody = '',
  initialTags = [],
  initialImagePaths = [],
  onSubmitted,
  onCancel,
}: FeedbackComposerProps) {
  const isEditing = Boolean(initialFeedbackId)
  const [body, setBody] = useState(initialBody)
  const [tags, setTags] = useState<FeedbackTag[]>([...initialTags])
  const [images, setImages] = useState<UploadedImage[]>(
    initialImagePaths.map((p) => ({
      path: p,
      url: `/storage/v1/object/public/feedback-images/${encodeURIComponent(p)}`,
    })),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const charCount = body.trim().length
  const meetsQuality = meetsQualityGate(body, images.length, MIN_FEEDBACK_CHARS)
  const isValidLength = charCount >= 10 && charCount <= 4000

  async function handleSubmit(e: SyntheticEvent) {
    e.preventDefault()
    if (!isValidLength || busy) return

    setBusy(true)
    setError(null)
    setStatusMessage(null)

    const payload = {
      entryId,
      body: body.trim(),
      tags,
      imagePaths: images.map((img) => img.path),
    }

    try {
      const url = isEditing ? `/api/feedback/${initialFeedbackId}` : '/api/feedback'
      const method = isEditing ? 'PUT' : 'POST'

      const response = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })

      const data = (await response.json().catch(() => null)) as {
        ok?: boolean
        feedback?: unknown
        eligibility?: string
        creditHeld?: boolean
        error?: string
      } | null

      if (!response.ok || !data?.ok) {
        throw new Error(data?.error ?? 'Could not share feedback.')
      }

      const isEligible = data.creditHeld ?? data.eligibility === 'eligible'
      const toastText = isEditing
        ? isEligible
          ? FEEDBACK_COPY.toastEditedEligible
          : FEEDBACK_COPY.toastEditedIneligible
        : isEligible
          ? FEEDBACK_COPY.toastEligible
          : FEEDBACK_COPY.toastIneligible

      setStatusMessage(toastText)

      setTimeout(() => {
        onSubmitted?.(data.feedback)
      }, 1200)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not share feedback.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-control border border-border bg-surface p-5 shadow-sm">
      <div className="mb-4">
        <h3 className="text-base font-semibold text-ink">
          {isEditing ? 'Edit feedback' : 'Leave constructive feedback'}
        </h3>
        <p className="mt-1 text-xs text-ink-muted leading-relaxed">
          {FEEDBACK_COPY.composerHelper}
        </p>
      </div>

      {statusMessage ? (
        <div role="status" className="rounded-control border border-brand/20 bg-brand-soft p-4 text-center text-sm font-medium text-brand">
          {statusMessage}
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            void handleSubmit(e)
          }}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="feedback-body" className="text-xs font-medium text-ink">
              Your critique
            </label>
            <textarea
              id="feedback-body"
              rows={4}
              value={body}
              onChange={(e) => { setBody(e.target.value); }}
              placeholder="What worked well? What could be improved regarding pacing, delivery, hook, or visuals?"
              className="rounded-control border border-border bg-surface px-3 py-2.5 text-sm text-ink placeholder:text-ink-subtle focus:border-brand focus:outline-none"
              disabled={busy}
            />
            <div className="flex items-center justify-between text-xs">
              <span
                className={
                  charCount === 0
                    ? 'text-ink-subtle'
                    : charCount < 10
                      ? 'text-red-500'
                      : meetsQuality
                        ? 'text-brand font-medium'
                        : 'text-amber-600'
                }
              >
                {charCount < 10
                  ? `${10 - charCount} more characters required`
                  : meetsQuality
                    ? 'Qualifies for Credit review'
                    : `${MIN_FEEDBACK_CHARS - charCount} more characters or an image to qualify for a Credit`}
              </span>
              <span className="text-ink-subtle">{charCount} / 4000</span>
            </div>
          </div>

          <TagPicker selectedTags={tags} onChange={setTags} disabled={busy} />

          <ImageSlots images={images} onChange={setImages} disabled={busy} />

          {error && <p className="text-xs text-red-500">{error}</p>}

          <div className="flex items-center justify-between pt-2 border-t border-border">
            <span className="text-[11px] text-ink-subtle">
              {FEEDBACK_COPY.optionalDisclaimer}
            </span>

            <div className="flex items-center gap-2">
              {onCancel && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onCancel}
                  className="rounded-control border border-border px-3 py-1.5 text-xs text-ink-muted hover:bg-surface-muted"
                >
                  Cancel
                </button>
              )}
              <button
                type="submit"
                disabled={!isValidLength || busy}
                className="rounded-control bg-brand px-4 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
              >
                {busy
                  ? 'Saving...'
                  : isEditing
                    ? 'Save changes'
                    : 'Share feedback'}
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  )
}
