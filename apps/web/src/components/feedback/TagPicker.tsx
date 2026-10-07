'use client'

import {
  FEEDBACK_TAG_LABELS,
  FEEDBACK_TAGS,
  type FeedbackTag,
} from '@fydio/domain'

export interface TagPickerProps {
  readonly selectedTags: readonly FeedbackTag[]
  readonly onChange: (tags: FeedbackTag[]) => void
  readonly disabled?: boolean
}

export function TagPicker({ selectedTags, onChange, disabled = false }: TagPickerProps) {
  function toggleTag(tag: FeedbackTag) {
    if (disabled) return
    if (selectedTags.includes(tag)) {
      onChange(selectedTags.filter((t) => t !== tag))
    } else {
      if (selectedTags.length >= 7) return
      onChange([...selectedTags, tag])
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink-muted">
          Focus tags (optional)
        </span>
        <span className="text-xs text-ink-subtle">
          {selectedTags.length} / 7
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FEEDBACK_TAGS.map((tag) => {
          const isSelected = selectedTags.includes(tag)
          const label = FEEDBACK_TAG_LABELS[tag]

          return (
            <button
              key={tag}
              type="button"
              disabled={disabled}
              onClick={() => { toggleTag(tag); }}
              aria-pressed={isSelected}
              className={`rounded-full px-2.5 py-1 text-xs font-medium transition ${
                isSelected
                  ? 'bg-brand text-white'
                  : 'border border-border bg-surface text-ink-muted hover:border-ink-muted hover:text-ink'
              } disabled:opacity-50`}
            >
              {label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
