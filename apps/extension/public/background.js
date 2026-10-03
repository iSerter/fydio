/**
 * T01 placeholder service worker.
 *
 * T10 replaces this with the real submission flow. It exists now so that
 * `chrome://extensions` can load an unpacked extension from `dist/` and confirm
 * the manifest wiring is correct before any product code exists.
 *
 * Deliberately inert: it grants no host access beyond the local stack, sends
 * nothing anywhere, and does not read the active tab. The product brief is
 * explicit that the extension must work only with explicit member consent.
 */
chrome.runtime.onInstalled.addListener(() => {
  // No-op until T10.
})
