'use client'

import { useState } from 'react'

import {
  MAX_RATING,
  MIN_RATING,
  isWithinRatingRevisionWindow,
} from '@fydio/domain'

import { RatingStars } from './RatingStars'

export interface RatingInputProps {
  readonly feedbackId: string
  readonly initialScore?: number | null | undefined
  readonly ratedAt?: string | null | undefined
  readonly onRated?: ((score: number) => void) | undefined
  readonly disabled?: boolean | undefined
}

export function RatingInput({
  feedbackId,
  initialScore = null,
  ratedAt = null,
  onRated,
  disabled = false,
}: RatingInputProps) {
  const [score, setScore] = useState<number | null>(initialScore)
  const [selectedScore, setSelectedScore] = useState<number>(initialScore ?? 8)
  const [isEditing, setIsEditing] = useState<boolean>(initialScore === null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const canRevise =
    score !== null &&
    (ratedAt === null || isWithinRatingRevisionWindow(ratedAt))

  async function submitRating(newScore: number) {
    if (disabled || busy) return
    setBusy(true)
    setError(null)
    setNotice(null)

    const isRevision = score !== null
    const method = isRevision ? 'PUT' : 'POST'

    try {
      const response = await fetch(`/api/feedback/${feedbackId}/rate`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ score: newScore }),
      })

      const payload = (await response.json().catch(() => null)) as {
        ok?: boolean
        error?: string
      } | null

      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error ?? 'Could not save rating.')
      }

      setScore(newScore)
      setIsEditing(false)
      setNotice(isRevision ? 'Rating revised' : 'Rating saved')
      onRated?.(newScore)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save rating.')
    } finally {
      setBusy(false)
    }
  }

  if (!isEditing && score !== null) {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <RatingStars score={score} />
            <span className="text-sm font-semibold text-ink">{score}/10</span>
          </div>

          {canRevise && !disabled && (
            <button
              type="button"
              onClick={() => { setIsEditing(true); }}
              className="text-xs text-ink-muted underline hover:text-ink"
            >
              Revise rating
            </button>
          )}
        </div>

        {notice && <p className="text-xs text-brand">{notice}</p>}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-control border border-border bg-surface p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink">
          {score !== null ? 'Revise usefulness rating (1–10)' : 'Rate usefulness (1–10)'}
        </span>
        <span className="text-xs text-ink-subtle">
          Judged by you
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {Array.from({ length: MAX_RATING - MIN_RATING + 1 }, (_, i) => i + MIN_RATING).map((val) => (
          <button
            key={val}
            type="button"
            disabled={disabled || busy}
            onClick={() => { setSelectedScore(val); }}
            className={`flex h-8 w-8 items-center justify-center rounded-control text-xs font-medium transition ${
              selectedScore === val
                ? 'bg-brand text-white shadow-sm'
                : 'border border-border bg-surface hover:bg-surface-muted text-ink'
            }`}
          >
            {val}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => {
            void submitRating(selectedScore)
          }}
          className="rounded-control bg-brand px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Saving...' : score !== null ? 'Update rating' : 'Submit rating'}
        </button>

        {score !== null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => { setIsEditing(false); }}
            className="rounded-control border border-border px-2.5 py-1.5 text-xs text-ink-muted hover:bg-surface-muted"
          >
            Cancel
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  )
}
