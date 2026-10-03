# T08 — Outbound Clicks, Opened State & Duration Telemetry

**Status:** Not started
**Depends on:** T02, T04, T07
**Blocks:** T09, T10
**Brief reference:** §5 Open original content, §6 Optional browser companion, §Include "External link opening and opened-state history", §principle 3 "browsing-duration telemetry is opt-in and private".

---

## 1. Goal

Implement the moment Fydio sends someone to the original platform and everything around it:

- **Outbound click events** recorded when a card's link is activated
- **Opened state** marked per member — a personal feed-history signal, _not_ proof of viewing
- **Return-to-Fydio** deep links that bring the member back to the same entry with a feedback prompt
- **Coarse duration events** ingested only with explicit opt-in consent, in coarse time bands, private to the viewer, never a reward

After T08 the loop is closed: open → return → (optionally) leave feedback, with honest, privacy-respecting instrumentation.

---

## 2. Why this position in the plan

This is the hinge between discovery (T07) and feedback (T09). Feedback requires an "opened" state, so the T02 guard (`opened_entry`) cannot be satisfied until this task lands. The extension (T10) also consumes the telemetry endpoint defined here.

---

## 3. Scope

### In scope

- `record_outbound_click` RPC + click tracking on all entry links (feed, profile, entry page)
- Signed `return_token` enabling a return-to-Fydio deep link (`/opened/[token]`)
- `mark_entry_opened` upsert into `feed_impressions.opened` with `opened_at`
- `/opened/[token]` page: confirms the open, shows the entry, surfaces the feedback prompt
- Duration telemetry ingest endpoint with **coarse bands only** and a **consent version** gate
- Consent management UI (per-member opt-in, revocable) + consent audit trail
- Duration events used for the viewer's _own_ history and recommendations only
- Privacy: duration data readable only by the viewer (and admins for abuse), never public

### Explicitly out of scope

- The Chrome extension itself (T10) — this task defines the API it will call
- Automated platform interactions of any kind (likes, follows, shares, comments, votes) — **explicitly forbidden**
- Mobile-app handoff tracking — "Fydio does not attempt to track on-platform behavior"
- Precise timing, page content, or browsing-history capture — **explicitly forbidden**

---

## 4. Deliverables

1. `record_outbound_click` + `mark_entry_opened` wired into all link activations
2. Signed `return_token` generation and validation
3. `/opened/[token]` return page with feedback prompt
4. `record_duration_event` ingest endpoint (service-role) with consent enforcement
5. Consent grant/revoke UI + `duration_events.consent_version` audit
6. "Your activity" privacy panel showing the viewer's own open history
7. Tests: token tamper-proofing, consent enforcement, band clamping, privacy

---

## 5. Technical design

### 5.1 The outbound click

Selecting an entry opens the original post in a new browser tab on desktop; on mobile the OS may hand off to the native app. Either way Fydio records an outbound click event and marks the entry as _opened_ for that member.

```ts
// apps/web/src/components/entry/OpenOriginalButton.tsx
'use client'
import { useTransition } from 'react'
import { recordOutboundClick } from '@/lib/telemetry'

export function OpenOriginalButton({ entryId, url }: { entryId: string; url: string }) {
  const [pending, startTransition] = useTransition()

  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer nofollow"
      onClick={() => {
        // Fire-and-forget: never block navigation, never await the network.
        startTransition(() => { void recordOutboundClick(entryId) })
      }}
      className="..."
    >
      Open on {platformLabel} ↗
    </a>
  )
}
```

`recordOutboundClick` calls the RPC, which returns the signed `return_token`:

```sql
create or replace function record_outbound_click(
  p_entry_id uuid,
  p_client   text default 'web',
  p_source   text default 'feed'
) returns uuid
language plpgsql security definer set search_path = public
as $$
declare
  v_uid    uuid := auth.uid();
  v_token  uuid;
begin
  if v_uid is null then
    raise exception 'Authentication required' using errcode='insufficient_privilege';
  end if;

  insert into outbound_clicks (entry_id, user_id, client, source, clicked_at)
  values (p_entry_id, v_uid, p_client, p_source, now());

  -- A per-viewer, short-lived token the platform link can carry back.
  v_token := gen_random_uuid();
  insert into feed_impressions (entry_id, viewer_id, opened, opened_at, served_at)
  values (p_entry_id, v_uid, true, now(), now())
  on conflict (viewer_id, entry_id)
  do update set opened = true,
                opened_at = coalesce(feed_impressions.opened_at, now());

  update outbound_clicks
     set return_token = v_token
   where entry_id = p_entry_id and user_id = v_uid and return_token is null;

  return v_token;
end $$;
```

**Opened semantics (important).** `feed_impressions.opened = true` means _"this member activated the link."_ It is deliberately **not** called viewed, not counted as engagement, and never grants anything. The brief is explicit: "An opened state is a personal feed-history signal, not proof of viewing or engagement." The T02 feedback guard checks `opened`, which is exactly the "connected to an entry they opened" requirement — not a viewing-time requirement.

### 5.2 Return-to-Fydio

The original platform URL cannot carry Fydio parameters (we must not modify the destination URL). Instead, the opened token is stored server-side and reachable via the Fydio tab:

- The Fydio tab holds the token; when the member returns, the app polls `/api/opened/status?token=...` on focus, or the extension calls it (T10).
- `/opened/[token]` validates the token and shows "Back from Instagram — leaving feedback?" with the entry context.

Validation is strict — the token must exist, belong to the caller, and be recent:

```ts
export async function validateReturnToken(token: string) {
  const supabase = createServerClient(await cookies())
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data } = await supabase.rpc('validate_return_token', { p_token: token })
  return data?.[0] ?? null // null if unknown, expired, or not this viewer's
}
```

```sql
create or replace function validate_return_token(p_token uuid)
returns table (entry_id uuid, opened_at timestamptz)
language sql stable security definer set search_path = public as $$
  select oc.entry_id, oc.clicked_at
    from outbound_clicks oc
   where oc.return_token = p_token
     and oc.user_id = auth.uid()      -- only the viewer who opened it
     and oc.clicked_at > now() - interval '30 minutes'
   limit 1;
$$;
```

> **Design constraint honored:** the outbound URL is always the **original, unmodified** platform URL. Fydio never appends tracking parameters to someone else's link, never proxies it, and never wraps it.

### 5.3 Duration telemetry (opt-in, coarse, private)

The brief permits the extension to report, **with explicit permission**:

- that the user navigated to the URL Fydio opened;
- the active-tab duration in a **coarse time band** (`<15s`, `15–60s`, `1–3min`, `>3min`);
- whether the user returned to Fydio.

It must not collect credentials, read private messages, inspect unrelated browsing, replay actions, automate platform actions, or bypass safeguards.

**Fydio stores only the band. Never a raw duration.** The ingest endpoint clamps anything outside the enum to `'unknown'`:

```ts
// apps/web/src/app/api/telemetry/duration/route.ts
const BANDS = ['lt_15s', 's15_60', 'm1_3', 'gt_3', 'unknown'] as const
const CURRENT_CONSENT_VERSION = '2026-01-dur-v1'

export async function POST(req: Request) {
  // The extension authenticates with a scoped token (T10), not a session cookie.
  const auth = await verifyExtensionToken(req)
  if (!auth) return unauthorized()

  const body = await req.json().catch(() => null)
  const parsed = durationEventSchema.safeParse(body)
  if (!parsed.success) return badRequest()

  // Coarse band only: a raw duration, if sent, is discarded, never stored.
  const band = BANDS.includes(parsed.data.band) ? parsed.data.band : 'unknown'

  const supabase = createServiceClient()

  // Consent gate: reject unless the member has an active, current-version grant.
  const { data: consent } = await supabase
    .from('duration_consents')
    .select('*')
    .eq('user_id', auth.userId)
    .eq('consent_version', CURRENT_CONSENT_VERSION)
    .eq('revoked_at', null)
    .maybeSingle()

  if (!consent) {
    return forbidden('Duration tracking is not enabled for this member')
  }

  await supabase.from('duration_events').insert({
    user_id: auth.userId,
    entry_id: parsed.data.entryId,
    band,
    returned: parsed.data.returned ?? false,
    consent_version: CURRENT_CONSENT_VERSION,
    received_at: new Date().toISOString(),
  })

  return accepted()
}
```

```sql
-- duration_events accepts ONLY the coarse band; there is no duration_ms column.
create table duration_events (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references profiles(id) on delete cascade,
  entry_id        uuid references content_entries(id) on delete set null,
  band            duration_band not null,     -- lt_15s | s15_60 | m1_3 | gt_3 | unknown
  returned        boolean not null default false,
  consent_version text not null,
  received_at     timestamptz not null default now()
);
create index duration_events_user_time_idx on duration_events (user_id, received_at desc);
```

**Usage policy, enforced by design:**

- Used for the viewer's **own history** (e.g., "you opened this") and Fydio recommendations.
- **Never** a reward, completion requirement, or public score.
- **Never** attached to credit eligibility — the T02 credit function does not read `duration_events` at all (verified by the CI grep test).
- Readable only by the viewer and admins; no public or cross-member exposure.

### 5.4 Consent management

| Aspect          | Decision                                                                                                 |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| Granularity     | Per member, opt-in, revocable                                                                            |
| Consent version | `2026-01-dur-v1`; bumping it silently invalidates prior events until re-consent                          |
| Storage         | `duration_consents` (grant + revoke timestamps, version, source)                                         |
| UI              | `/settings/privacy` — a clear toggle with plain-language scope and a "delete my duration history" action |
| Enforcement     | Every ingest checks an active, current-version grant server-side; absence → reject                       |

Consent copy (deliberately narrow):

> "Fydio can record how long you keep a Fydio-opened tab active, as a rough range only. This is private to you, used for your own history and to tune your feed, and never affects Credits or Reputation. You can turn this off and delete past records at any time."

### 5.5 Privacy panel

`/settings/privacy` and a per-entry "Your activity on this entry" section show the viewer:

- Entries they have opened, with timestamps
- Their duration bands (their own only)
- A "Clear my activity" action (anonymizes or deletes, per a `privacy` setting)

No other member can see any of this — enforced by RLS (`duration_events` and `outbound_clicks` are own-rows-only; `force row level security`).

---

## 6. Files to create

| Path                                                   | Purpose                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| `supabase/migrations/0024_return_tokens.sql`           | `return_token` column, `validate_return_token`, `mark_entry_opened` |
| `supabase/migrations/0025_duration_consent.sql`        | `duration_consents` table + consent-version enforcement helper      |
| `supabase/migrations/0026_outbound_click_rpc.sql`      | `record_outbound_click` (full)                                      |
| `apps/web/src/components/entry/OpenOriginalButton.tsx` | Click-tracking link                                                 |
| `apps/web/src/app/opened/[token]/page.tsx`             | Return-to-Fydio page                                                |
| `apps/web/src/app/api/opened/status/route.ts`          | Return-token status poll                                            |
| `apps/web/src/app/api/telemetry/duration/route.ts`     | Duration ingest (consented, coarse only)                            |
| `apps/web/src/lib/telemetry.ts`                        | `recordOutboundClick` client helper                                 |
| `apps/web/src/app/settings/privacy/page.tsx`           | Consent + data controls                                             |
| `apps/web/src/components/privacy/ConsentToggle.tsx`    | Opt-in toggle                                                       |
| `apps/web/src/components/privacy/ActivityList.tsx`     | Viewer's own open history                                           |
| `apps/web/src/lib/extension-tokens.ts`                 | Extension token verify helper (shared with T10)                     |
| `supabase/tests/010_telemetry.sql`                     | pgTAP: tokens, consent, bands, privacy                              |
| `tests/e2e/open-and-return.spec.ts`                    | Playwright: open → return → prompt                                  |

---

## 7. Implementation steps

- [ ] Migration `0024`: add `return_token` to `outbound_clicks`; `mark_entry_opened`; `validate_return_token` (viewer-scoped, 30-min expiry)
- [ ] Migration `0025`: `duration_consents` table + `has_current_duration_consent(user_id, version)` helper
- [ ] Migration `0026`: full `record_outbound_click` returning the token and upserting `opened`
- [ ] Add `OpenOriginalButton` to feed cards, entry pages, and profile entry lists
- [ ] Implement `recordOutboundClick` client helper (fire-and-forget; never blocks navigation)
- [ ] Build `/opened/[token]` — validate token, show entry context, render the feedback prompt (feedback form itself in T09)
- [ ] Build `/api/opened/status` poll endpoint
- [ ] Implement the extension-token verifier (HS256, scoped, expiring) in `lib/extension-tokens.ts`
- [ ] Build `/api/telemetry/duration` with band clamping and the server-side consent gate
- [ ] Add the hard guard: no duration column in `duration_events` (schema-level)
- [ ] Build `/settings/privacy` with the consent toggle, scope copy, and "delete my history" action
- [ ] Build the viewer's own activity list (own-rows only via RLS)
- [ ] Grep-test: `evaluate_feedback_eligibility` and other credit paths never read `duration_events`
- [ ] Write pgTAP suite `010_telemetry.sql`
- [ ] Write the Playwright open-and-return spec
- [ ] Verify consent revocation immediately blocks further duration ingest

---

## 8. Acceptance criteria

- [ ] Clicking "Open on [platform]" records an `outbound_clicks` row and sets `opened = true` for that member
- [ ] The outbound `href` is the **original unmodified URL** with `target="_blank" rel="noopener noreferrer nofollow"`
- [ ] `opened` is set for the clicking member only, never for others
- [ ] The returned token validates only for the viewer who opened it, and expires in 30 minutes
- [ ] A tampered or unknown token returns no data and shows a safe fallback
- [ ] `/opened/[token]` shows the entry and a feedback prompt after a valid return
- [ ] Duration ingest is rejected without an active, current-version consent
- [ ] Revoking consent immediately blocks further duration events
- [ ] Duration storage contains **only** coarse bands — no raw milliseconds column or value exists
- [ ] An out-of-enum band is stored as `'unknown'`, never as a numeric duration
- [ ] `duration_events` is readable only by the viewer (and admins); cross-member reads return 0 rows
- [ ] No credit function reads `duration_events` (grep test)
- [ ] Consent copy states it is private, opt-in, revocable, and never affects Credits or Reputation
- [ ] No automated platform interaction exists anywhere in the code

---

## 9. Tests

- **pgTAP**: `mark_entry_opened` idempotency; click records and returns a token; `validate_return_token` scoping + expiry; consent gate accept/reject; band clamping to `'unknown'`; RLS own-rows-only for `duration_events` and `outbound_clicks`.
- **Unit**: band classifier mapping raw ranges → enum (only for tests, not stored); token signing/verification round-trip; expired token rejection.
- **Integration**: POST a duration event with a valid extension token + consent → 200; without consent → 403; with a forged token → 401.
- **E2E (Playwright)**: click Open on the entry → new tab with the platform URL → return to Fydio → `/opened/[token]` shows the prompt.

---

## 10. Verification commands

```bash
supabase test db --file supabase/tests/010_telemetry.sql

psql "$DATABASE_URL" -c "select entry_id, viewer_id, opened, opened_at from feed_impressions where opened order by opened_at desc limit 10;"
psql "$DATABASE_URL" -c "select band, count(*) from duration_events group by 1 order by 1;"
psql "$DATABASE_URL" -c "\d duration_events"   # confirm: no duration_ms column
psql "$DATABASE_URL" -c "select count(*) from duration_events where user_id <> auth.uid();"  # privacy

grep -rn "duration_events" supabase/migrations | grep -i "credit"  # must return 0 lines
```

---

## 11. Risks & mitigations

| Risk                                           | Mitigation                                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Duration data feels like surveillance          | Explicit opt-in, coarse bands only, private to viewer, revocable, clear narrow scope copy                                                                                 |
| Extension over-collects (reads page content)   | The ingest endpoint accepts **only** `{ entryId, band, returned }`; extra fields are dropped by the zod schema; the extension manifest requests no broad host permissions |
| Return tokens leak or are forged               | HMAC-signed, viewer-scoped, short expiry; a forged token yields no data                                                                                                   |
| Outbound URLs get tracking parameters appended | Never modify the destination URL; tokens are stored server-side and reached via the Fydio tab or extension                                                                |
| Band data mistaken for engagement              | Named `duration_events` with band-only schema; never joined into credit logic; the UI labels it "private to you"                                                          |
| Consent versioning mishandled                  | Every ingest checks the current version; bumping `CURRENT_CONSENT_VERSION` invalidates old grants and events                                                              |

---

## 12. Definition of done

Fydio can send a member to the original content, record an honest outbound click and personal opened state, bring them back with a feedback prompt, and — only with explicit opt-in — store coarse duration bands privately, without any automated platform interaction and without duration data ever touching the credit economy.
