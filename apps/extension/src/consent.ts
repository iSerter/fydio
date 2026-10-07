/**
 * Consent management for the companion extension (T10).
 *
 * Tracks explicit, revocable opt-in consent in `chrome.storage.local`.
 * Scoped to a specific consent version (`DURATION_CONSENT_VERSION`).
 * Bumping the version string automatically invalidates prior grants until re-confirmed.
 */

export const CONSENT_KEY = 'fydio_duration_consent'
export const CONSENT_VERSION = '2026-01-dur-v1'

export interface ConsentRecord {
  readonly granted: boolean
  readonly version: string
  readonly at: number
}

function hasLocalStorage(): boolean {
  return typeof chrome !== 'undefined' && 'storage' in chrome && 'local' in chrome.storage
}

/** Check if the member has granted active consent under the current version. */
export async function isConsented(): Promise<boolean> {
  const state = await getConsentState()
  return state !== null && state.granted && state.version === CONSENT_VERSION
}

/** Retrieve the current stored consent record, or null if unset. */
export async function getConsentState(): Promise<ConsentRecord | null> {
  if (!hasLocalStorage()) {
    return null
  }

  const result = await chrome.storage.local.get(CONSENT_KEY)
  const stored = result[CONSENT_KEY] as Partial<ConsentRecord> | undefined

  if (!stored || typeof stored !== 'object') {
    return null
  }

  if (typeof stored.granted !== 'boolean' || typeof stored.version !== 'string') {
    return null
  }

  return {
    granted: stored.granted,
    version: stored.version,
    at: typeof stored.at === 'number' ? stored.at : Date.now(),
  }
}

/** Update the member's consent decision. Revocation is immediate. */
export async function setConsent(granted: boolean): Promise<void> {
  if (!hasLocalStorage()) {
    return
  }

  const record: ConsentRecord = {
    granted,
    version: CONSENT_VERSION,
    at: Date.now(),
  }

  await chrome.storage.local.set({
    [CONSENT_KEY]: record,
  })
}

/** Wipe stored consent state completely. */
export async function clearConsent(): Promise<void> {
  if (!hasLocalStorage()) {
    return
  }

  await chrome.storage.local.remove(CONSENT_KEY)
}
