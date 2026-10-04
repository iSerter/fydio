/**
 * Post-sign-in navigation, and why it must be sanitised here.
 *
 * The `next` parameter arrives from a query string the member (or anyone) controls, and it
 * is passed straight back to `router.push`. Without this guard, `/login?next=https://evil.test`
 * would make the callback route bounce a freshly-authenticated member to an attacker page --
 * a credential-phishing primitive delivered by our own login form, which is worse than the
 * same trick on an unknown domain because the member has just typed their email into us.
 *
 * Only same-origin PATHS are allowed. A value with a scheme, a host, or a leading `//` is
 * replaced with the app root.
 */
const FALLBACK = '/feed'

export function safeNextPath(raw: string | null | undefined): string {
  if (typeof raw !== 'string' || raw === '') return FALLBACK

  // `//evil.test` is a protocol-relative URL and would leave the origin despite having no
  // scheme -- the reason this checks for slashes before parsing rather than after.
  if (!raw.startsWith('/') || raw.startsWith('//')) return FALLBACK

  try {
    const url = new URL(raw, 'https://placeholder.invalid')
    // A parsed origin equal to the base means the value stayed relative, which is the only
    // shape we accept.
    if (url.origin !== 'https://placeholder.invalid') return FALLBACK
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return FALLBACK
  }
}