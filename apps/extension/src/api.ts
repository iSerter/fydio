import type { Band } from './bands.js'

/**
 * Fydio API client for the companion extension (T10).
 *
 * RESTRICTION: Only calls Fydio's authenticated endpoints.
 * The extension never sends requests to third-party domains.
 */

export const DEFAULT_API_URL = 'http://localhost:3000'

export interface DurationEventPayload {
  readonly entryId: string
  readonly band: Band
  readonly returned?: boolean
}

export interface IngestResponse {
  readonly ok: boolean
  readonly id?: string
  readonly band?: Band
  readonly storedBand?: Band
  readonly consentVersion?: string
  readonly error?: string
}

export interface ReturnStatusResponse {
  readonly valid: boolean
  readonly entryId?: string | null
  readonly returned?: boolean
  readonly reason?: string
}

/**
 * Reports a coarse duration band to Fydio's telemetry endpoint.
 *
 * HARD PRIVACY INVARIANT: This payload contains ONLY `{ entryId, band, returned }`.
 * No raw millisecond count, no tab URL, no timestamps, and no browsing history.
 */
export async function postDurationEvent(
  apiBaseUrl: string,
  token: string,
  payload: DurationEventPayload,
): Promise<{ success: boolean; status: number; data?: IngestResponse }> {
  const url = `${apiBaseUrl.replace(/\/+$/, '')}/api/telemetry/duration`

  // Strict payload assembly: only the 3 permitted fields can ever be sent
  const wireBody: DurationEventPayload = {
    entryId: payload.entryId,
    band: payload.band,
    returned: Boolean(payload.returned),
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(wireBody),
    })

    const data = (await response.json().catch(() => ({}))) as IngestResponse

    return {
      success: response.ok,
      status: response.status,
      data,
    }
  } catch (error) {
    console.error('Failed to post duration event:', error)
    return {
      success: false,
      status: 0,
    }
  }
}

/**
 * Checks if a return token is still valid.
 */
export async function fetchReturnStatus(
  apiBaseUrl: string,
  returnToken: string,
): Promise<ReturnStatusResponse | null> {
  const url = `${apiBaseUrl.replace(/\/+$/, '')}/api/opened/status?token=${encodeURIComponent(returnToken)}`

  try {
    const response = await fetch(url, {
      method: 'GET',
      credentials: 'include',
    })

    if (!response.ok) {
      return null
    }

    return (await response.json()) as ReturnStatusResponse
  } catch (error) {
    console.error('Failed to check return token status:', error)
    return null
  }
}

/**
 * Requests a fresh scoped extension token from the web app using existing member session.
 */
export async function fetchExtensionToken(apiBaseUrl: string): Promise<{ token: string } | null> {
  const url = `${apiBaseUrl.replace(/\/+$/, '')}/api/extension/token`

  try {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
    })

    if (!response.ok) {
      return null
    }

    const data = (await response.json()) as { ok?: boolean; token?: string }
    return data.token ? { token: data.token } : null
  } catch (error) {
    console.error('Failed to obtain extension token:', error)
    return null
  }
}
