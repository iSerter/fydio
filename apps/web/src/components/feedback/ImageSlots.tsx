'use client'

import { useRef, useState, type ChangeEvent } from 'react'
import Image from 'next/image'

import { MAX_FEEDBACK_IMAGES } from '@fydio/domain'

export interface UploadedImage {
  path: string
  url: string
}

export interface ImageSlotsProps {
  readonly images: UploadedImage[]
  readonly onChange: (images: UploadedImage[]) => void
  readonly maxImages?: number
  readonly disabled?: boolean
}

export function ImageSlots({
  images,
  onChange,
  maxImages = MAX_FEEDBACK_IMAGES,
  disabled = false,
}: ImageSlotsProps) {
  const [uploading, setUploading] = useState(false)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files
    if (!files || files.length === 0) return

    setUploadError(null)
    const remainingSlots = maxImages - images.length
    if (remainingSlots <= 0) return

    const filesToUpload = Array.from(files).slice(0, remainingSlots)
    setUploading(true)

    try {
      const newlyUploaded: UploadedImage[] = []
      for (const file of filesToUpload) {
        const formData = new FormData()
        formData.append('file', file)

        const response = await fetch('/api/feedback/cover', {
          method: 'POST',
          body: formData,
        })

        const payload = (await response.json().catch(() => null)) as {
          ok?: boolean
          imagePath?: string
          imageUrl?: string
          error?: string
        } | null

        if (!response.ok || !payload?.ok || !payload.imagePath || !payload.imageUrl) {
          throw new Error(payload?.error ?? 'Failed to upload image')
        }

        newlyUploaded.push({
          path: payload.imagePath,
          url: payload.imageUrl,
        })
      }

      onChange([...images, ...newlyUploaded])
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
    }
  }

  function handleRemove(index: number) {
    const updated = images.filter((_, i) => i !== index)
    onChange(updated)
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-ink-muted">
          Images (optional, up to {maxImages})
        </span>
        <span className="text-xs text-ink-subtle">
          {images.length} / {maxImages}
        </span>
      </div>

      <div className="flex flex-wrap gap-3">
        {images.map((img, idx) => (
          <div
            key={img.path}
            className="group relative h-20 w-20 overflow-hidden rounded-control border border-border bg-surface-muted"
          >
            <Image
              src={img.url}
              alt={`Feedback attachment ${idx + 1}`}
              fill
              unoptimized
              className="object-cover"
            />
            {!disabled && (
              <button
                type="button"
                onClick={() => { handleRemove(idx); }}
                aria-label={`Remove image ${idx + 1}`}
                className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60 text-xs text-white opacity-90 transition hover:bg-black group-hover:opacity-100"
              >
                ×
              </button>
            )}
          </div>
        ))}

        {images.length < maxImages && !disabled && (
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileInputRef.current?.click()}
            className="flex h-20 w-20 flex-col items-center justify-center rounded-control border border-dashed border-border bg-surface text-ink-subtle transition hover:border-ink-muted hover:text-ink disabled:opacity-50"
          >
            {uploading ? (
              <span className="text-xs animate-pulse">Uploading...</span>
            ) : (
              <>
                <span className="text-lg leading-none">+</span>
                <span className="mt-1 text-[10px]">Add image</span>
              </>
            )}
          </button>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        className="hidden"
        onChange={(e) => {
          void handleFileChange(e)
        }}
        disabled={disabled || uploading || images.length >= maxImages}
      />

      {uploadError && <p className="text-xs text-red-500">{uploadError}</p>}
    </div>
  )
}
