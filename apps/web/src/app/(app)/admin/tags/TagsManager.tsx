'use client'

import { useState, type SyntheticEvent } from 'react'

export interface AdminTagItem {
  id: string
  slug: string
  label: string
  is_official: boolean
  usageCount: number
  created_at: string
}

export function TagsManager({ initialTags }: { initialTags: AdminTagItem[] }) {
  const [tags, setTags] = useState<AdminTagItem[]>(initialTags)
  const [newSlug, setNewSlug] = useState('')
  const [newLabel, setNewLabel] = useState('')
  const [newIsOfficial, setNewIsOfficial] = useState(true)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editIsOfficial, setEditIsOfficial] = useState(false)
  const [updating, setUpdating] = useState(false)

  async function handleCreate(e: SyntheticEvent) {
    e.preventDefault()
    if (!newSlug.trim()) return

    setCreating(true)
    setCreateError(null)

    try {
      const res = await fetch('/api/admin/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: newSlug.trim(),
          label: newLabel.trim() ? newLabel.trim() : undefined,
          isOfficial: newIsOfficial,
        }),
      })

      const json = (await res.json().catch(() => null)) as {
        tag?: {
          id: string
          slug: string
          label: string
          is_official: boolean
          created_at: string
        }
        error?: string
      } | null

      if (!res.ok || !json?.tag) {
        throw new Error(json?.error ?? 'Failed to create tag')
      }

      const created: AdminTagItem = {
        id: json.tag.id,
        slug: json.tag.slug,
        label: json.tag.label,
        is_official: json.tag.is_official,
        usageCount: 0,
        created_at: json.tag.created_at,
      }

      setTags((prev) => [created, ...prev])
      setNewSlug('')
      setNewLabel('')
      setNewIsOfficial(true)
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Create failed')
    } finally {
      setCreating(false)
    }
  }

  function startEdit(tag: AdminTagItem) {
    setEditingId(tag.id)
    setEditLabel(tag.label)
    setEditIsOfficial(tag.is_official)
  }

  async function saveEdit(id: string) {
    setUpdating(true)
    try {
      const res = await fetch('/api/admin/tags', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          label: editLabel.trim(),
          isOfficial: editIsOfficial,
        }),
      })

      const json = (await res.json().catch(() => null)) as {
        tag?: {
          label: string
          is_official: boolean
        }
        error?: string
      } | null

      const updatedTag = json?.tag
      if (!res.ok || !updatedTag) {
        throw new Error(json?.error ?? 'Failed to update tag')
      }

      setTags((prev) =>
        prev.map((t) =>
          t.id === id
            ? { ...t, label: updatedTag.label, is_official: updatedTag.is_official }
            : t,
        ),
      )
      setEditingId(null)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setUpdating(false)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Create New Tag Form */}
      <form
        onSubmit={(e) => {
          void handleCreate(e)
        }}
        className="flex flex-col gap-4 rounded-control border border-border bg-surface p-4"
      >
        <h3 className="text-sm font-semibold text-ink">Create New Hashtag</h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label htmlFor="new-tag-slug" className="block text-[11px] font-medium text-ink-muted mb-1">
              Slug (e.g. webdev)
            </label>
            <input
              id="new-tag-slug"
              type="text"
              required
              value={newSlug}
              onChange={(e) => { setNewSlug(e.target.value); }}
              placeholder="slug-name"
              className="w-full rounded-control border border-border bg-surface px-3 py-1.5 text-xs text-ink focus:border-brand focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="new-tag-label" className="block text-[11px] font-medium text-ink-muted mb-1">
              Display Label (optional)
            </label>
            <input
              id="new-tag-label"
              type="text"
              value={newLabel}
              onChange={(e) => { setNewLabel(e.target.value); }}
              placeholder="Web Development"
              className="w-full rounded-control border border-border bg-surface px-3 py-1.5 text-xs text-ink focus:border-brand focus:outline-none"
            />
          </div>

          <div className="flex items-center gap-2 pt-5">
            <input
              type="checkbox"
              id="is-official"
              checked={newIsOfficial}
              onChange={(e) => { setNewIsOfficial(e.target.checked); }}
              className="rounded border-border text-brand focus:ring-brand"
            />
            <label htmlFor="is-official" className="text-xs font-medium text-ink cursor-pointer">
              Mark as Official Tag
            </label>
          </div>
        </div>

        {createError && <p className="text-xs text-rose-600">{createError}</p>}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={creating}
            className="rounded-control bg-brand px-4 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:opacity-50 transition"
          >
            {creating ? 'Creating...' : 'Create Tag'}
          </button>
        </div>
      </form>

      {/* Tags List */}
      <div className="overflow-x-auto rounded-control border border-border bg-surface">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-border bg-surface-muted/60 text-ink-muted">
            <tr>
              <th className="px-4 py-3 font-semibold">Slug</th>
              <th className="px-3 py-3 font-semibold">Label</th>
              <th className="px-3 py-3 font-semibold">Type</th>
              <th className="px-3 py-3 font-semibold text-right">Usage Count</th>
              <th className="px-3 py-3 font-semibold">Created</th>
              <th className="px-4 py-3 font-semibold text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {tags.map((tag) => (
              <tr key={tag.id} className="hover:bg-surface-muted/30">
                <td className="px-4 py-3 font-medium text-ink font-mono text-[11px]">
                  #{tag.slug}
                </td>

                <td className="px-3 py-3 text-ink">
                  {editingId === tag.id ? (
                    <input
                      type="text"
                      value={editLabel}
                      onChange={(e) => { setEditLabel(e.target.value); }}
                      className="rounded border border-border bg-surface px-2 py-1 text-xs text-ink focus:border-brand focus:outline-none"
                    />
                  ) : (
                    tag.label
                  )}
                </td>

                <td className="px-3 py-3">
                  {editingId === tag.id ? (
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={editIsOfficial}
                        onChange={(e) => { setEditIsOfficial(e.target.checked); }}
                        className="rounded border-border text-brand"
                      />
                      <span className="text-[11px] text-ink">Official</span>
                    </label>
                  ) : tag.is_official ? (
                    <span className="rounded bg-brand/10 px-2 py-0.5 text-[10px] font-bold text-brand uppercase">
                      Official
                    </span>
                  ) : (
                    <span className="rounded bg-surface-muted px-2 py-0.5 text-[10px] font-medium text-ink-muted">
                      Community
                    </span>
                  )}
                </td>

                <td className="px-3 py-3 text-right font-medium text-ink">
                  {tag.usageCount}
                </td>

                <td className="px-3 py-3 text-ink-muted whitespace-nowrap">
                  {new Date(tag.created_at).toLocaleDateString()}
                </td>

                <td className="px-4 py-3 text-right">
                  {editingId === tag.id ? (
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => { void saveEdit(tag.id) }}
                        disabled={updating}
                        className="rounded-control bg-brand px-2.5 py-1 text-[11px] font-semibold text-white hover:opacity-90"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => { setEditingId(null); }}
                        className="rounded-control border border-border px-2.5 py-1 text-[11px] font-medium text-ink hover:bg-surface-muted"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { startEdit(tag); }}
                      className="rounded-control border border-border px-2.5 py-1 text-[11px] font-medium text-ink hover:bg-surface-muted transition"
                    >
                      Edit
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
