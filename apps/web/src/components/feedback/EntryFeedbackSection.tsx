'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

import type { FeedbackTag } from '@fydio/domain'

import { FeedbackCard, type FeedbackAuthor } from './FeedbackCard'
import { FeedbackComposer } from './FeedbackComposer'
import { ReportDialog } from './ReportDialog'

export interface FeedbackItemData {
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
}

export interface EntryFeedbackSectionProps {
  readonly entryId: string
  readonly isAuthor: boolean
  readonly hasOpened: boolean
  readonly currentUserId: string | null
  readonly initialFeedback: readonly FeedbackItemData[]
}

export function EntryFeedbackSection({
  entryId,
  isAuthor,
  hasOpened,
  currentUserId,
  initialFeedback,
}: EntryFeedbackSectionProps) {
  const router = useRouter()
  const [showComposer, setShowComposer] = useState(false)

  const userFeedback = initialFeedback.find((f) => f.author.id === currentUserId)
  const hasLeftFeedback = Boolean(userFeedback)

  return (
    <section id="feedback-section" className="flex flex-col gap-6 pt-6 border-t border-border">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-ink">Community Feedback</h2>
          <p className="text-xs text-ink-muted mt-0.5">
            Peer critiques and usefulness ratings from creators who opened this post.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <ReportDialog
            targetType="content_entry"
            targetId={entryId}
            targetLabel="this entry"
            triggerLabel="Report entry"
          />

          {!isAuthor && hasOpened && !hasLeftFeedback && !showComposer && (
            <button
              type="button"
              onClick={() => { setShowComposer(true); }}
              className="rounded-control bg-brand px-3.5 py-1.5 text-xs font-medium text-white hover:opacity-90 transition"
            >
              Leave feedback
            </button>
          )}
        </div>
      </div>

      {/* Composer state */}
      {!isAuthor && hasOpened && !hasLeftFeedback && showComposer && (
        <div id="leave-feedback">
          <FeedbackComposer
            entryId={entryId}
            onSubmitted={() => {
              setShowComposer(false)
              router.refresh()
            }}
            onCancel={() => { setShowComposer(false); }}
          />
        </div>
      )}

      {!isAuthor && !hasOpened && (
        <div className="rounded-control border border-border bg-surface-muted p-4 text-xs text-ink-muted">
          <span>Open the original content to unlock the voluntary feedback composer.</span>
        </div>
      )}

      {/* Feedback list */}
      <div className="flex flex-col gap-4">
        {initialFeedback.length === 0 ? (
          <div className="rounded-control border border-border bg-surface p-6 text-center text-sm text-ink-muted">
            No feedback left yet. Be the first to open the post and leave constructive critique!
          </div>
        ) : (
          initialFeedback.map((fb) => (
            <FeedbackCard
              key={fb.id}
              {...fb}
              currentUserId={currentUserId}
              isEntryOwner={isAuthor}
              onUpdated={() => { router.refresh(); }}
              onRemoved={() => { router.refresh(); }}
            />
          ))
        )}
      </div>
    </section>
  )
}
