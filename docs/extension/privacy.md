# Fydio Companion Extension — Privacy & Data Flow Specification

The Fydio Companion is an **optional, opt-in** browser extension (Chrome Manifest V3) designed to record coarse browsing duration on content opened through Fydio and to facilitate the return-to-Fydio feedback loop.

---

## 1. Core Principles

1. **Consent-First**: The extension collects nothing until the member explicitly turns on duration tracking in the companion popup or in `/settings/privacy`.
2. **Coarse Bands Only**: Fydio never stores, logs, or transmits raw milliseconds or precise timestamps of third-party activity. Milliseconds are mapped into one of five broad bands and immediately thrown away.
3. **No Automated Actions**: The extension never performs automated interactions (likes, shares, follows, comments, votes) on any external platform.
4. **Scoped to Fydio Opens**: The extension tracks only tabs that originated from an outbound click within Fydio. Unrelated browsing is invisible to the extension.
5. **No Commercial or Credit Invariant**: Duration data is strictly private to the viewer, used solely for personal history and feed tuning. It is never rewarded with Credits, never influences Reputation, and is never visible to other members or creators.

---

## 2. Permissions Breakdown

The extension requests the minimal permissions required for its function:

| Permission         | Purpose                                                                                                                                   |
| :----------------- | :---------------------------------------------------------------------------------------------------------------------------------------- |
| `storage`          | Stores the member's opt-in consent decision (`fydio_duration_consent`) and consent version locally on their machine.                      |
| `activeTab`        | Grants temporary access to observe when a tab opened from Fydio is the focused tab.                                                       |
| `tabs`             | Listens to `onActivated` and `onRemoved` events to compute active-time duration and detect return to the Fydio tab.                       |
| `alarms`           | Manages timer intervals without keeping persistent background scripts awake.                                                              |
| `host_permissions` | Restricted to `http://localhost:3000/api/*` and `https://*.fydio.app/api/*`. The extension can communicate **only** with Fydio's own API. |

### Forbidden & Absent Permissions

The following permissions are **strictly forbidden** by architecture and absent from `manifest.json`:

- `<all_urls>` / `*://*/*` — **Absent**. Broad host access is refused.
- `webRequest` / `webRequestBlocking` — **Absent**. The extension cannot intercept or inspect network requests.
- `cookies` — **Absent**. The extension cannot read browser cookies from Fydio or third-party platforms.
- `history` — **Absent**. The extension cannot query browser browsing history.
- `bookmarks` — **Absent**.
- `desktopCapture` / `tabCapture` — **Absent**.
- `debugger` — **Absent**.

---

## 3. Data Collection & Duration Bands

When a member clicks "Open on [Platform]" on a Fydio card:

1. The web application issues an outbound click RPC, generating a short-lived `return_token`.
2. The web page notifies the companion extension via `chrome.runtime.sendMessage`.
3. The extension tracks the newly activated tab.
4. When the member switches away or closes the tab, the extension computes elapsed active duration:
   ```ts
   // Raw duration is mapped to a band and immediately discarded
   export function toBand(ms: number): Band {
     if (ms < 15_000) return 'lt_15s'
     if (ms < 60_000) return 's15_60'
     if (ms < 180_000) return 'm1_3'
     return 'gt_3'
   }
   ```
5. If consent is **OFF**, the event is silently discarded.
6. If consent is **ON**, the extension POSTs `{ entryId, band, returned }` to `/api/telemetry/duration`.

### Exact Wire Format

```json
{
  "entryId": "b5a932b7-a3f2-401d-91b4-2b7e64bc38e1",
  "band": "s15_60",
  "returned": true
}
```

The wire schema is `.strict()`. Any unexpected properties (such as URLs, milliseconds, or DOM content) trigger a 400 Bad Request rejection at the server.

---

## 4. User Controls & Revocation

- **Toggle Consent**: Members can toggle duration telemetry on or off at any moment in the extension popup or in `/settings/privacy`. Revocation is immediate.
- **Audit & History**: Members can view their duration bands in the "Your activity" panel in `/settings/privacy`.
- **Clear History**: Clicking "Clear my activity" wipes past duration records.
- **Version Invalidation**: Any change to the consent text or scope bumps `DURATION_CONSENT_VERSION` (`2026-01-dur-v1`), which automatically invalidates prior grants until re-confirmed.
