'use client'

import { useState } from 'react'

import { MAX_BIO_CHARS, MAX_DISPLAY_NAME_CHARS, displayNameSchema } from '@fydio/domain'
import { Button, Card, Stack } from '@fydio/ui'

import { AvatarUploader } from '@/components/profile/AvatarUploader'
import { BioField } from '@/components/profile/BioField'
import { HashtagPicker, type HashtagOption } from '@/components/profile/HashtagPicker'
import { PlatformLinksEditor } from '@/components/profile/PlatformLinksEditor'
import { OnboardingStepper } from '@/components/onboarding/OnboardingStepper'
import { completeOnboarding, saveOnboardingStep, saveProfileLinks, setHashtags } from './actions'

/**
 * The five-step onboarding wizard (T03).
 *
 * | Step        | Fields          | Rule                            |
 * | ----------- | --------------- | ------------------------------- |
 * | 1. Identity | display name    | 2-60 chars, required            |
 * | 2. Avatar   | upload or skip  | JPEG/PNG/WebP <= 5 MB           |
 * | 3. Bio      | short text      | <= 280 chars, optional          |
 * | 4. Hashtags | exactly five    | the DB hard-caps at five        |
 * | 5. Handles  | platform links  | one per platform, URL must match|
 *
 * WHY STEP 4 IS "EXACTLY FIVE" AND STEPS 2/5 ARE OPTIONAL. The five tags are the feed's
 * primary matching signal: a profile with zero tags ranks against nothing, which is why the
 * proxy keeps an un-onboarded member out of the feed entirely. The photo and the links are
 * presentation and cannot affect ranking, so requiring them would add friction to the one step
 * that genuinely matters.
 *
 * WHY EACH STEP SAVES AS IT IS COMPLETED. Losing step 2 to a refresh is the single most likely
 * way a new member abandons onboarding, so each step is saved on advance rather than only on
 * final submit. `onboarding_completed_at` is set by `completeOnboarding` alone -- a partial
 * save must not open the rest of the app.
 */
const STEPS = ['Identity', 'Avatar', 'Bio', 'Hashtags', 'Handles'] as const

export interface OnboardingLink {
  readonly platform: 'instagram' | 'tiktok' | 'youtube' | 'x'
  readonly url: string
}

export interface OnboardingWizardProps {
  readonly initialDisplayName: string
  readonly initialBio: string
  readonly initialHashtags: readonly HashtagOption[]
  readonly initialAvatarUrl: string | null
  readonly initialLinks: readonly OnboardingLink[]
}

export function OnboardingWizard(props: OnboardingWizardProps) {
  const [step, setStep] = useState(0)
  const [displayName, setDisplayName] = useState(props.initialDisplayName)
  const [bio, setBio] = useState(props.initialBio)
  const [hashtags, setHashtagsLocal] = useState<HashtagOption[]>([...props.initialHashtags])
  const [avatarUrl, setAvatarUrl] = useState(props.initialAvatarUrl)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nameError, setNameError] = useState<string | null>(null)

  /** Whether the wizard may advance. Step 4 is the only one with a hard requirement. */
  function stepValid(index: number): boolean {
    if (index === 0) return displayNameSchema.safeParse(displayName).success
    if (index === 3) return hashtags.length === 5
    return true
  }

  async function advance() {
    setError(null)
    setNameError(null)

    if (step === 0) {
      const parsed = displayNameSchema.safeParse(displayName)

      if (!parsed.success) {
        setNameError(parsed.error.issues[0]?.message ?? 'Pick a display name.')
        return
      }
    }

    setBusy(true)

    try {
      if (step === 0 || step === 2) {
        const saved = await saveOnboardingStep({ displayName, bio })

        if (!saved.ok) {
          setError(saved.message ?? 'Could not save that step.')
          return
        }
      }

      if (step === 3) {
        const saved = await setHashtags(hashtags.map((tag) => tag.id))

        if (!saved.ok) {
          setError(saved.message ?? 'Could not save your hashtags.')
          return
        }
      }

      setStep((current) => Math.min(current + 1, STEPS.length - 1))
    } finally {
      setBusy(false)
    }
  }

  async function finish() {
    setBusy(true)
    setError(null)

    try {
      const result = await completeOnboarding({
        displayName,
        bio: bio.slice(0, MAX_BIO_CHARS),
        hashtags: hashtags.map((tag) => tag.id),
      })

      if (!result.ok) {
        setError(result.message ?? 'Could not finish setting up your profile.')
        return
      }

      // The onboarding gate in the proxy only re-evaluates on a server request, so a client-side
      // push would still treat the member as un-onboarded and bounce them straight back here.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- deliberate full navigation
      window.location.assign('/feed')
    } finally {
      setBusy(false)
    }
  }
const isLast = step === STEPS.length - 1

  return (
    <Stack gap={6}>
      <OnboardingStepper steps={STEPS} current={step} />

      {step === 0 ? (
        <Card title="What should we call you?">
          <Stack gap={2}>
            <label className="text-sm font-medium text-ink" htmlFor="display-name">
              Display name
            </label>
            <input
              id="display-name"
              value={displayName}
              maxLength={MAX_DISPLAY_NAME_CHARS}
              aria-invalid={nameError !== null}
              onChange={(event) => { setDisplayName(event.target.value); }}
              placeholder="Ada Lovelace"
              className="rounded-control border border-border bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-brand aria-[invalid=true]:border-critical"
            />
            <p className="text-xs text-ink-subtle">
              Shown on your profile and beside anything you post. You can change it later.
            </p>
            {nameError ? (
              <p role="alert" className="text-sm text-critical">
                {nameError}
              </p>
            ) : null}
          </Stack>
        </Card>
      ) : null}

      {step === 1 ? (
        <AvatarUploader currentUrl={avatarUrl} onUploaded={(r) => { setAvatarUrl(r.avatarUrl); }} />
      ) : null}

      {step === 2 ? <BioField value={bio} onChange={setBio} /> : null}

      {step === 3 ? (
        <HashtagPicker selected={hashtags} onChange={setHashtagsLocal} limit={5} />
      ) : null}

      {step === 4 ? (
        <PlatformLinksEditor
          initial={props.initialLinks}
          saving={busy}
          error={error}
          onSave={(links) => {
            void saveProfileLinks(links).then((result) => {
              setError(result.ok ? null : (result.message ?? 'Could not save your links.'))
            })
          }}
        />
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-critical">
          {error}
        </p>
      ) : null}

      <div className="flex items-center justify-between">
        <Button
          variant="ghost"
          onClick={() => { setStep((current) => Math.max(current - 1, 0)); }}
          disabled={step === 0 || busy}
        >
          Back
        </Button>

        {isLast ? (
          <Button onClick={() => void finish()} disabled={busy}>
            {busy ? 'Finishing…' : 'Finish setup'}
          </Button>
        ) : (
          <Button onClick={() => void advance()} disabled={busy || !stepValid(step)}>
            {busy ? 'Saving…' : step === 1 ? 'Skip for now' : 'Continue'}
          </Button>
        )}
      </div>
    </Stack>
  )
}