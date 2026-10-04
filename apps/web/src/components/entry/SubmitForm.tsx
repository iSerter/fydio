'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

import type { HashtagOption } from '@/components/profile/HashtagPicker'
import { HashtagPicker } from '@/components/profile/HashtagPicker'

/**
 * Submission form (T04): URL with live validation, exactly-3 hashtag picker,
 * optional cover upload, creator note, feedback toggle, credit cost display.
 */
export function SubmitForm({ creditBalance, creditCost }: { readonly creditBalance: number | null; readonly creditCost: number }) {
  const router = useRouter()
  const [url, setUrl] = useState('')
  const [urlState, setUrlState] = useState<
    | { kind: 'idle' }
    | { kind: 'checking' }
    | { kind: 'ok'; platform: string; canonicalUrl: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' })
  const [tags, setTags] = useState<HashtagOption[]>([])
  const [note, setNote] = useState('')
  const [asks, setAsks] = useState(false)
  const [coverPath, setCoverPath] = useState<string | null>(null)
  const [coverPreview, setCoverPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [coverBusy, setCoverBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const validateSeq = useRef(0)

  async function validateUrl(value: string) {
    const trimmed = value.trim()
    const seq = validateSeq.current + 1
    validateSeq.current = seq
    if (!trimmed) {
      setUrlState({ kind: 'idle' })
      return
    }
    setUrlState({ kind: 'checking' })
    try {
      const response = await fetch('/api/entries/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      })
      if (validateSeq.current !== seq) return
      const payload = (await response.json().catch(() => null)) as {
        platform?: string
        canonicalUrl?: string
        error?: string
      } | null
      if (!response.ok) {
        setUrlState({ kind: 'error', message: payload?.error ?? 'That link is not supported.' })
        return
      }
      setUrlState({ kind: 'ok', platform: String(payload?.platform), canonicalUrl: String(payload?.canonicalUrl) })
    } catch {
      if (validateSeq.current !== seq) return
      setUrlState({ kind: 'error', message: 'Could not check that link. Try again.' })
    }
  }

  async function onCover(file: File | undefined) {
    if (!file || coverBusy) return
    // Client-declared pre-check only — the route re-validates MIME/size and
    // decodes with sharp. This just avoids a round trip for obvious rejects.
    if (file.size === 0 || file.size > 5 * 1024 * 1024) {
      setError('Covers must be 5 MB or smaller.')
      return
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Use a JPEG, PNG or WebP image.')
      return
    }
    setError(null)
    setCoverBusy(true)
    try {
      const form = new FormData()
      form.append('file', file)
      const response = await fetch('/api/entries/cover', { method: 'POST', body: form })
      const payload = (await response.json().catch(() => null)) as {
        coverPath?: string
        coverUrl?: string
        error?: string
      } | null
      if (!response.ok) {
        setError(payload?.error ?? 'That cover could not be uploaded.')
        return
      }
      if (payload?.coverPath) {
        setCoverPath(payload.coverPath)
        setCoverPreview(payload.coverUrl ?? null)
      }
    } finally {
      setCoverBusy(false)
    }
  }

  const canSubmit =
    !busy && !coverBusy && urlState.kind === 'ok' && tags.length === 3 && note.length <= 1000

  async function onSubmit(event: { preventDefault: () => void }) {
    event.preventDefault()
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/entries', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          hashtagIds: tags.map((t) => t.id),
          creatorNote: note.trim() ? note.trim() : undefined,
          asksForFeedback: asks,
          coverPath: coverPath ?? undefined,
        }),
      })
      const payload = (await response.json().catch(() => null)) as {
        entry?: { id?: string }
        error?: string
      } | null
      if (!response.ok) {
        setError(payload?.error ?? 'That submission could not be saved.')
        return
      }
      const id = payload?.entry?.id
      if (typeof id === 'string') {
        router.push(`/c/${id}?submitted=1`)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => {
      void onSubmit(e)
    }} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <label htmlFor="entry-url" className="text-sm font-medium">
          Content link
        </label>
        <input
          id="entry-url"
          type="url"
          required
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            // The ok/error state describes the URL as validated. Any edit
            // invalidates it — otherwise the form can submit an unvalidated URL
            // while displaying the previous URL's platform line.
            if (urlState.kind === 'ok' || urlState.kind === 'error') {
              validateSeq.current += 1
              setUrlState({ kind: 'idle' })
            }
          }}
          onBlur={() => {
            void validateUrl(url)
          }}
          placeholder="https://www.youtube.com/watch?v=…"
          className="rounded-control border border-border bg-surface px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand"
        />
        {urlState.kind === 'checking' ? <p className="text-xs text-ink-muted">Checking…</p> : null}
        {urlState.kind === 'ok' ? (
          <p className="text-xs text-ink-muted" aria-live="polite">
            {urlState.platform} · {urlState.canonicalUrl}
          </p>
        ) : null}
        {urlState.kind === 'error' ? (
          <p role="alert" className="text-sm text-critical">
            {urlState.message}
          </p>
        ) : null}
      </div>

      <HashtagPicker selected={tags} onChange={setTags} limit={3} />

      <div className="flex flex-col gap-2">
        <label htmlFor="creator-note" className="text-sm font-medium">
          Creator note <span className="font-normal text-ink-subtle">(optional, {note.length}/1000)</span>
        </label>
        <textarea
          id="creator-note"
          value={note}
          onChange={(e) => {
            setNote(e.target.value)
          }}
          maxLength={1000}
          rows={3}
          placeholder="What should viewers look for?"
          className="rounded-control border border-border bg-surface px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-brand"
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={asks}
          onChange={(e) => {
            setAsks(e.target.checked)
          }}
        />
        I&apos;m asking for feedback on this
      </label>

      <div className="flex flex-col gap-2">
        <label htmlFor="cover-input" className="text-sm font-medium">
          Cover image <span className="font-normal text-ink-subtle">(optional)</span>
        </label>
        <input
          id="cover-input"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={coverBusy}
          onChange={(e) => {
            void onCover(e.target.files?.[0])
          }}
          className="text-sm"
        />
        {coverBusy ? <p className="text-xs text-ink-muted">Uploading cover…</p> : null}
        {coverPreview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={coverPreview} alt="" className="aspect-[1200/630] w-full rounded-control object-cover" />
        ) : null}
      </div>

      <p className="text-sm text-ink-muted" aria-live="polite">
        {creditBalance === null
          ? 'Sign in to see your Credit balance.'
          : `Balance: ${creditBalance} Credit${creditBalance === 1 ? '' : 's'} · this submission costs ${creditCost}.`}
      </p>

      {error ? (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={!canSubmit}
        className="rounded-control bg-brand px-4 py-2 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? 'Publishing…' : `Publish for ${creditCost} Credit${creditCost === 1 ? '' : 's'}`}
      </button>
    </form>
  )
}
