'use client'

import { useState } from 'react'
import Image from 'next/image'

import {
  FEEDBACK_TAG_LABELS,
  isWithinFeedbackEditGrace,
  type FeedbackTag,
} from '@fydio/domain'

import { FeedbackComposer } from './FeedbackComposer'
import { RatingInput } from './RatingInput'
import { RatingStars } from './RatingStars'
import { ReportDialog } from './ReportDialog'

export interface FeedbackAuthor {
  readonly id: string
  readonly displayName: string
  readonly handle: string
  readonly avatarUrl?: string | null
  readonly reputationTotal?: number
}

export interface FeedbackCardProps {
  readonly id: string
  readonly entryId: string
  readonly author: FeedbackAuthor
  readonly body: string
  readonly tags: readonly FeedbackTag[]
  readonly imagePaths: readonly string[]
  readonly createdAt: string
  readonly editedAt?: string | null
  readonly score?: number | null
  readonly ratedAt?: string | null
  readonly eligibility?: string
  readonly currentUserId?: string | null
  readonly isEntryOwner?: boolean
  readonly onUpdated?: () => void
  readonly onRemoved?: () => void
}

export function FeedbackCard({
  id,
  entryId,
  author,
  body,
  tags,
  imagePaths,
  createdAt,
  editedAt,
  score,
  ratedAt,
  eligibility: _eligibility,
  currentUserId,
  isEntryOwner = false,
  onUpdated,
  onRemoved,
}: FeedbackCardProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activeImage, setActiveImage] = useState<string | null>(null)

  const isAuthor = currentUserId === author.id
  const isRated = typeof score === 'number' && score >= 1
  const canEdit = isAuthor && !isRated && isWithinFeedbackEditGrace(createdAt)

  async function handleRemove() {
    if (!window.confirm('Are you sure you want to remove this feedback?')) return
    setBusy(true)

    try {
      const response = await fetch(`/api/feedback/${id}`, { method: 'DELETE' })
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(payload?.error ?? 'Could not remove feedback.')
      }
      onRemoved?.()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not remove feedback.')
    } finally {
      setBusy(false)
    }
  }

  if (isEditing) {
    return (
      <FeedbackComposer
        entryId={entryId}
        initialFeedbackId={id}
        initialBody={body}
        initialTags={tags}
        initialImagePaths={imagePaths}
        onSubmitted={() => {
          setIsEditing(false)
          onUpdated?.()
        }}
        onCancel={() => { setIsEditing(false); }}
      />
    )
  }

  return (
    <article className="flex flex-col gap-3 rounded-control border border-border bg-surface p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          {author.avatarUrl ? (
            <Image
              src={author.avatarUrl}
              alt=""
              width={36}
              height={36}
              unoptimized
              className="h-9 w-9 rounded-full border border-border object-cover"
            />
          ) : (
            <div className="flex h-9 w-9 items-center justify-center rounded-full border border-border bg-surface-muted text-xs font-semibold text-ink">
              {author.displayName.slice(0, 1).toUpperCase()}
            </div>
          )}

          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-ink">
                {author.displayName}
              </span>
              <span className="text-xs text-ink-subtle">@{author.handle}</span>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-ink-muted">
              <span>{new Date(createdAt).toLocaleDateString()}</span>
              {editedAt && <span>(edited)</span>}
              {typeof author.reputationTotal === 'number' && (
                <span className="rounded bg-surface-muted px-1.5 py-0.5 text-ink-subtle">
                  Reputation: {author.reputationTotal}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {canEdit && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => { setIsEditing(true); }}
                className="text-xs text-ink-muted hover:text-ink underline"
              >
                Edit
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  void handleRemove()
                }}
                className="text-xs text-red-500 hover:text-red-700 underline"
              >
                Remove
              </button>
            </>
          )}

          {!isAuthor && (
            <ReportDialog
              targetType="feedback"
              targetId={id}
              targetLabel={`feedback by @${author.handle}`}
            />
          )}
        </div>
      </div>

      <p className="whitespace-pre-wrap text-sm text-ink leading-relaxed">
        {body}
      </p>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-border bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-ink-muted"
            >
              {FEEDBACK_TAG_LABELS[tag] || tag}
            </span>
          ))}
        </div>
      )}

      {imagePaths.length > 0 && (
        <div className="flex flex-wrap gap-2 pt-1">
          {imagePaths.map((path, idx) => {
            const url = `/storage/v1/object/public/feedback-images/${encodeURIComponent(path)}`
            return (
              <button
                key={path}
                type="button"
                onClick={() => { setActiveImage(url); }}
                className="relative h-20 w-20 overflow-hidden rounded-control border border-border bg-surface-muted hover:opacity-90"
              >
                <Image
                  src={url}
                  alt={`Attachment ${idx + 1}`}
                  fill
                  unoptimized
                  className="object-cover"
                />
              </button>
            )
          })}
        </div>
      )}

      {/* Creator rating section */}
      <div className="mt-2 border-t border-border pt-3">
        {isEntryOwner ? (
          <RatingInput
            feedbackId={id}
            initialScore={score ?? null}
            ratedAt={ratedAt ?? null}
            onRated={onUpdated}
          />
        ) : isRated ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-ink-muted">Creator rating:</span>
            <RatingStars score={score} />
            <span className="text-xs font-semibold text-ink">{score}/10</span>
          </div>
        ) : (
          <span className="text-xs text-ink-subtle">Not yet rated by creator</span>
        )}
      </div>

      {/* Lightbox Modal */}
      {activeImage && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => { setActiveImage(null); }}
        >
          <div className="relative max-h-[90vh] max-w-[90vw]">
            <Image
              src={activeImage}
              alt="Enlarged attachment"
              width={1200}
              height={800}
              unoptimized
              className="max-h-[85vh] max-w-[85vw] object-contain rounded-control"
            />
            <button
              type="button"
              onClick={() => { setActiveImage(null); }}
              className="absolute -top-3 -right-3 flex h-8 w-8 items-center justify-center rounded-full bg-black text-white hover:bg-black/80"
            >
              ×
            </button>
          </div>
        </div>
      )}
    </article>
  )
}
