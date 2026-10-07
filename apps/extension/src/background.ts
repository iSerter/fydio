import {
  DEFAULT_API_URL,
  fetchExtensionToken,
  fetchReturnStatus,
  postDurationEvent,
} from './api.js'
import { toBand, type Band } from './bands.js'
import { isConsented } from './consent.js'

/**
 * Service worker for the Fydio companion extension (T10).
 *
 * PRIVACY SPECIFICATION:
 * - Only monitors tabs initiated by an explicit Fydio outbound click.
 * - Does NOT read page content, credentials, DOM, network requests, or browsing history.
 * - Raw active durations are converted into coarse bands and immediately discarded.
 * - If the member has not granted consent, NO duration data is sent.
 */

interface TrackedTab {
  tabId: number
  entryId: string
  returnToken?: string | undefined
  token?: string | undefined
  startedAt: number
}

interface PendingClick {
  entryId: string
  returnToken?: string | undefined
  token?: string | undefined
  registeredAt: number
}

interface OutboundClickMessage {
  readonly type: 'FYDIO_OUTBOUND_CLICK'
  readonly entryId: string
  readonly returnToken?: string
  readonly token?: string
}

interface ReturnStatusMessage {
  readonly type: 'CHECK_RETURN_STATUS'
  readonly returnToken: string
}

function isOutboundClickMessage(val: unknown): val is OutboundClickMessage {
  return (
    typeof val === 'object' &&
    val !== null &&
    (val as Record<string, unknown>).type === 'FYDIO_OUTBOUND_CLICK' &&
    typeof (val as Record<string, unknown>).entryId === 'string'
  )
}

function isReturnStatusMessage(val: unknown): val is ReturnStatusMessage {
  return (
    typeof val === 'object' &&
    val !== null &&
    (val as Record<string, unknown>).type === 'CHECK_RETURN_STATUS' &&
    typeof (val as Record<string, unknown>).returnToken === 'string'
  )
}

// In-memory worker state
let pendingClick: PendingClick | null = null
let currentTracking: TrackedTab | null = null
let apiBaseUrl: string = DEFAULT_API_URL

/** Configuration helper */
export function setApiBaseUrl(url: string): void {
  apiBaseUrl = url
}

export function getApiBaseUrl(): string {
  return apiBaseUrl
}

/**
 * Handle incoming outbound click notification from Fydio web application.
 */
export async function handleOutboundClick(message: {
  entryId: string
  returnToken?: string | undefined
  token?: string | undefined
}): Promise<void> {
  if (!message.entryId) return

  const click: PendingClick = {
    entryId: message.entryId,
    returnToken: message.returnToken,
    token: message.token,
    registeredAt: Date.now(),
  }

  // If no token was provided by the web app, attempt to obtain one via existing session
  if (!click.token) {
    const freshToken = await fetchExtensionToken(apiBaseUrl)
    if (freshToken) {
      click.token = freshToken.token
    }
  }

  pendingClick = click
}

/**
 * Complete tracking for the active tab and report the coarse band if consented.
 */
export async function finishTracking(returnedToFydio = false): Promise<Band | null> {
  if (!currentTracking) {
    return null
  }

  const tracking = currentTracking
  currentTracking = null

  const elapsedMs = Date.now() - tracking.startedAt
  const band = toBand(elapsedMs)

  // Verify consent before sending any telemetry
  const consented = await isConsented()
  if (!consented) {
    return null
  }

  const token = tracking.token ?? (await fetchExtensionToken(apiBaseUrl))?.token
  if (token) {
    await postDurationEvent(apiBaseUrl, token, {
      entryId: tracking.entryId,
      band,
      returned: returnedToFydio,
    })
  }

  return band
}

/**
 * Start tracking a specific tab ID for the current pending click.
 */
export function startTracking(tabId: number): boolean {
  if (pendingClick && Date.now() - pendingClick.registeredAt < 15_000) {
    if (currentTracking) {
      void finishTracking(false)
    }

    currentTracking = {
      tabId,
      entryId: pendingClick.entryId,
      returnToken: pendingClick.returnToken,
      token: pendingClick.token,
      startedAt: Date.now(),
    }
    pendingClick = null
    return true
  }
  return false
}

// Setup Chrome event listeners if running in extension runtime
if (typeof chrome !== 'undefined' && 'tabs' in chrome && 'runtime' in chrome) {
  // Listen for messages from Fydio web pages (externally_connectable)
  if ('onMessageExternal' in chrome.runtime) {
    chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
      if (isOutboundClickMessage(message)) {
        void handleOutboundClick({
          entryId: message.entryId,
          returnToken: message.returnToken,
          token: message.token,
        }).then(() => {
          sendResponse({ ok: true })
        })
        return true // keep message channel open for async response
      }
      return false
    })
  }

  // Internal extension messages (e.g. from popup or unit tests)
  if ('onMessage' in chrome.runtime) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (isOutboundClickMessage(message)) {
        void handleOutboundClick({
          entryId: message.entryId,
          returnToken: message.returnToken,
          token: message.token,
        }).then(() => {
          sendResponse({ ok: true })
        })
        return true
      }
      if (isReturnStatusMessage(message)) {
        void fetchReturnStatus(apiBaseUrl, message.returnToken).then((status) => {
          sendResponse(status)
        })
        return true
      }
      return false
    })
  }

  // Tab activation listener
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    if (startTracking(tabId)) {
      return
    }

    // If moving away from the tracked tab, finish tracking
    if (currentTracking && currentTracking.tabId !== tabId) {
      void finishTracking(true)
    }
  })

  // Tab closure listener
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (currentTracking?.tabId === tabId) {
      void finishTracking(false)
    }
  })
}
