'use client'

import { useState, useTransition } from 'react'

import { Button, Card } from '@fydio/ui'

import { setHashtags, updateProfile } from '@/app/(app)/onboarding/actions'
import { AvatarUploader } from './AvatarUploader'
import { BioField } from './BioField'
import { HashtagPicker, type HashtagOption } from './HashtagPicker'
import { PlatformLinksEditor, type PlatformLinkValue } from './PlatformLinksEditor'

/**
 * The editable profile form (T03 §7 -- "Build /settings/profile reusing the same components").
 *
 * REUSING THE ONBOARDING COMPONENTS IS THE POINT, not a convenience. The five-hashtag cap, the
 * display-name length limit, the bio limit and the per-platform URL rules all live in those
 * components and in `@fydio/domain`. A second set of inputs written for this page would be a
 * second implementation of the same rules, and the two would drift -- most visibly, a member who
 * could not pick a sixth tag during onboarding would find a way to do it here.
 *
 * THE ONE DELIBERATE DIFFERENCE FROM ONBOARDING. Onboarding requires exactly five hashtags;
 * editing allows fewer. Forcing a member who is removing a tag they regret to pick a
 * replacement before they can save anything is a good way to make them not bother. The database
 * cap is unchanged either way -- this is a floor, not a ceiling.
 */

export interface ProfileEditorProps {
  readonly initialDisplayName: string
  readonly initialBio: string
  readonly initialHashtags: readonly HashtagOption[]
  readonly initialAvatarUrl: string | null
  readonly initialLinks: readonly PlatformLinkValue[]
}

export function ProfileEditor(props: ProfileEditorProps) {
  const [displayName, setDisplayName] = useState(props.initialDisplayName)
  const [bio, setBio] = useState(props.initialBio)
  const [hashtags, setHashtagsLocal] = useState<HashtagOption[]>([...props.initialHashtags])
  const [avatarUrl, setAvatarUrl] = useState(props.initialAvatarUrl)

  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null)

  function save() {
    setMessage(null)

    startTransition(async () => {
      const details = await updateProfile({ displayName, bio })
      if (!details.ok) {
        setMessage({ tone: 'bad', text: details.message ?? 'Check those details.' })
        return
      }

      const tags = await setHashtags(hashtags.map((tag) => tag.id))
      if (!tags.ok) {
        setMessage({ tone: 'bad', text: tags.message ?? 'Could not save your hashtags.' })
        return
      }

      setMessage({ tone: 'ok', text: 'Profile saved.' })
    })
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        save()
      }}
      className="flex flex-col gap-6"
    >
      <Card title="Photo">
        <AvatarUploader
          currentUrl={avatarUrl}
          onUploaded={(result) => { setAvatarUrl(result.avatarUrl) }}
        />
      </Card>

      <Card title="Display name">
        <label className="flex flex-col gap-2">
          <span className="sr-only">Display name</span>
          <input
            id="display-name"
            aria-label="Display name"
            value={displayName}
            onChange={(event) => { setDisplayName(event.target.value) }}
            required
            maxLength={60}
            className="rounded-control border border-border bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand"
          />
        </label>
      </Card>

      {/* `BioField` brings its own Card, so it is not nested inside one here. */}
      <BioField value={bio} onChange={setBio} />

      <Card title="Hashtags">
        <HashtagPicker selected={hashtags} onChange={setHashtagsLocal} />
      </Card>

      {/* Saved on its own, immediately, rather than joining the submit below: the editor is
          self-contained and reports its own outcome, and a member who adds one link should not
          have to also press "Save changes" to keep it. */}
      <PlatformLinksEditor
        initial={props.initialLinks}
        saving={pending}
        onSave={() => {
          // `PlatformLinksEditor` persists its own changes through `saveProfileLinks` and
          // reports the outcome itself, so there is nothing to mirror here. The whole list is
          // re-read on the next render, which is the same refresh-then-trust approach the
          // connection button uses.
        }}
      />

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving…' : 'Save changes'}
        </Button>

        {message === null ? null : (
          <p
            role="status"
            className={message.tone === 'ok' ? 'text-sm text-positive' : 'text-sm text-critical'}
          >
            {message.text}
          </p>
        )}
      </div>
    </form>
  )
}
