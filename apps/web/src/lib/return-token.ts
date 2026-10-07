'use client'

/**
 * The Fydio tab's copy of the return token (T08).
 *
 * WHY THE TOKEN IS HELD HERE AT ALL. The outbound URL belongs to the platform, so
 * it cannot carry anything of ours — Fydio appends nothing to it, and that is the
 * design, not a limitation. The consequence is that the Fydio tab is the only
 * place a return token can live, which makes this module the hinge of the return
 * leg: the click handler stores a token, and the tab looks it up when the member
 * comes back.
 *
 * WHY `sessionStorage` AND NOT `localStorage`. A return token is short-lived and
 * belongs to one browsing session. `sessionStorage` dies with the tab, so closing
 * the tab discards it — which is the correct lifetime for a credential that resolves
 * one fact about one open. `localStorage` would leave it lying around on disk for
 * weeks, and a page that outlives its token has no use for it.
 *
 * WHY THIS IS A SEPARATE MODULE FROM THE COMPONENT. The store is read by the
 * watcher and written by the click handler, which are different components
 * rendering at different times. A shared module is the only place both can agree on
 * the key, and a duplicated string literal in two components is exactly how one of
 * them ends up reading a key nobody writes.
 */

/** Storage key. Namespaced, and versioned so a format change cannot misread old data. */
const STORAGE_KEY = 'fydio:return-token:v1'

/**
 * What the tab remembers about an open.
 *
 * `platform` is stored alongside the token purely so the watcher can say "Back from
 * Instagram" without a lookup — the token resolves the entry, but the member is
 * looking at a prompt, not at a database record. It is a display string chosen by
 * Fydio's own vocabulary, never anything from the destination.
 */
export interface RememberedReturn {
  readonly token: string
  readonly platformLabel: string
  /** Epoch milliseconds, used to avoid treating the click's own blur as a return. */
  readonly clickedAt: number
}

/** The 64-hex shape `record_outbound_click` mints. Checked before storing or using. */
const TOKEN_SHAPE = /^[0-9a-f]{64}$/

/**
 * Record the token from a click.
 *
 * Silently ignores a malformed token rather than storing it: the token came from
 * our own RPC, so a bad value is a bug, and storing it would produce a watcher that
 * polls a nonsense query string forever.
 */
export function rememberReturnToken(token: string, platformLabel: string): void {
  if (typeof window === 'undefined') return
  if (!TOKEN_SHAPE.test(token)) return

  try {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ token, platformLabel, clickedAt: Date.now() } satisfies RememberedReturn),
    )
  } catch {
    // Private browsing modes can refuse storage. The return leg then simply does
    // not happen, which is a worse experience but never a broken one — so it is
    // swallowed rather than surfaced on a link the member is already clicking.
  }
}

/**
 * The remembered return, or `null`.
 *
 * A stored value that does not parse is CLEARED rather than returned: a corrupt
 * entry would otherwise be re-read on every focus and produce the same silent
 * failure forever.
 */
export function readRememberedReturn(): RememberedReturn | null {
  if (typeof window === 'undefined') return null

  let raw: string | null

  try {
    raw = window.sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }

  if (raw === null) return null

  try {
    const parsed: unknown = JSON.parse(raw)

    if (typeof parsed !== 'object' || parsed === null) {
      forgetReturnToken()
      return null
    }

    const { token, platformLabel, clickedAt } = parsed as Partial<RememberedReturn>

    if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) {
      forgetReturnToken()
      return null
    }

    return {
      token,
      platformLabel: typeof platformLabel === 'string' ? platformLabel : 'the platform',
      clickedAt: typeof clickedAt === 'number' ? clickedAt : 0,
    }
  } catch {
    forgetReturnToken()

    return null
  }
}

/** Drop the remembered return. Called once it has been acted on. */
export function forgetReturnToken(): void {
  if (typeof window === 'undefined') return

  try {
    window.sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    // As above: a storage that refuses writes also refuses deletes, and there is
    // nothing useful to do about either from here.
  }
}
