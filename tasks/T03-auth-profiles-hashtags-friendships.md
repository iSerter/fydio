# T03 — Invite-Only Auth, Profiles, Hashtags & Friendships

**Status:** Complete
**Depends on:** T02
**Blocks:** T04, T07, T09
**Brief reference:** §1 Onboarding and profile, §4 (friend affinity), §Include "Invite-only authentication", "Profiles with avatar, bio, and a five-hashtag maximum", "Admin controls for users".

---

## 1. Goal

Deliver the complete **invite-only authentication** flow and the member identity layer: display name, avatar, short bio, up to five profile hashtags, optional connected public handles, and mutual friend connections.

After T03 a new member can redeem an invite, land on an onboarding wizard, and end up with a profile that has ≤5 hashtags and ≥1 friend request capability.

---

## 2. Why this position in the plan

Everything personalized depends on profile hashtags — they are "the primary matching signal for the home feed" (T07). Feedback requires knowing who is who (T09). Auth must be closed from day one because the product is explicitly invite-only.

---

## 3. Scope

### In scope

- Email magic-link / OTP sign-in via `@supabase/ssr`; invite redemption gate
- Route protection middleware (`(auth)`, `(app)`, `(admin)` groups)
- Onboarding wizard: display name, avatar upload, bio, 5 hashtags, optional platform handles
- Profile edit + public profile view
- Hashtag catalog browsing, tag search, community rule validation on creation
- Friend requests: send, accept, decline, block, unfriend; mutual-only confirmed friendships
- Account settings: notification prefs (minimal), session sign-out, data/account overview
- Storage buckets for avatars with RLS storage policies

### Explicitly out of scope

- Content submission (T04)
- Feed (T07)
- Feedback (T09)
- Any third-party OAuth or credential collection — explicitly excluded by the brief
- Reputation display beyond a placeholder; full reputation UI lands in T06/T09

---

## 4. Deliverables

1. Auth routes: `/login`, `/auth/callback`, `/invite/[token]`, `/auth/accept`
2. Middleware enforcing invite-only access and role-based route protection
3. Onboarding wizard (5 steps) + profile edit page
4. Public profile page at `/u/[handle]`
5. Hashtag picker component with search, creation rules, and a hard 5-slot counter
6. Friend request UI + `/api/friendships` route handlers
7. Avatar upload to Supabase Storage with correct RLS policies
8. Tests covering invite gating, the 5-hashtag cap in UI, and friendship state machine

---

## 5. Technical design

### 5.1 Invite-only access model

Two-layer gate:

**Layer 1 — Auth config.** In Supabase Auth, disable open sign-up (`GOTRUE_DISABLE_SIGNUP=true` in the stack env). No `signUp()` call exists anywhere in the client bundle. Only admin-created users can authenticate.

**Layer 2 — Invite redemption.** An admin issues an `invites` row; the invitee receives a link containing a raw token. The app stores only `token_hash = sha256(token)`, so a database leak cannot be replayed.

```
Admin UI (T09) ──► invite email: https://<app>/invite/<raw-token>
                        │
                        ▼
            GET /invite/[token]
      hash token ──► invites lookup (valid, not revoked, not expired)
                        │
                        ▼
            redirect /auth/accept?token=…
                        │
                        ▼
   POST /api/auth/accept-invite
     1. hash token, lock invite row FOR UPDATE
     2. verify valid + not accepted + not expired + not revoked
     3. supabase.auth.admin.createUser({ email, email_confirm: true })
     4. insert invites.accepted_at, accepted_by
     5. create profile row via handle_new_user() trigger (T02)
     6. issue a one-time session link → redirect to /onboarding
```

RPC for the atomic claim (prevents a race where one invite signs up two accounts):

```sql
create or replace function claim_invite(p_token_hash text, p_user_id uuid)
returns invites
language plpgsql security definer set search_path = public
as $$
declare v_invite invites;
begin
  select * into v_invite from invites
   where token_hash = p_token_hash for update;

  if not found then raise exception 'Invalid invite' using errcode='no_data_found'; end if;
  if v_invite.revoked_at is not null then raise exception 'Invite revoked' using errcode='check_violation'; end if;
  if v_invite.accepted_at is not null then raise exception 'Invite already used' using errcode='unique_violation'; end if;
  if v_invite.expires_at < now() then raise exception 'Invite expired' using errcode='check_violation'; end if;

  update invites set accepted_at = now(), accepted_by = p_user_id where id = v_invite.id;
  return v_invite;
end $$;
```

### 5.2 Route protection

`apps/web/src/middleware.ts` uses `@supabase/ssr` to refresh the session and enforce access:

```ts
const PUBLIC_ROUTES = ['/login', '/invite', '/auth']
const ADMIN_PREFIX = '/admin'

export async function middleware(req: NextRequest) {
  const res = NextResponse.next()
  const supabase = createServerClient(cookies(), res)
  const {
    data: { user },
  } = await supabase.auth.getUser() // verified, not getSession()

  const { pathname } = req.nextUrl
  const isPublic = PUBLIC_ROUTES.some((p) => pathname.startsWith(p))

  if (!user && !isPublic) {
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  if (user && pathname === '/login') return NextResponse.redirect(new URL('/feed', req.url))

  if (user && pathname.startsWith(ADMIN_PREFIX)) {
    const { data: profile } = await supabase.rpc('ensure_profile')
    if (profile?.role !== 'admin') return NextResponse.redirect(new URL('/feed', req.url))
  }

  return res
}
```

Onboarding gate: if `profiles.display_name IS NULL OR profiles.onboarding_completed_at IS NULL`, redirect to `/onboarding` from any `(app)` route. This guarantees the feed never renders for a profile with 0 hashtags.

### 5.3 Onboarding wizard (5 steps)

| Step        | Fields                                          | Validation                                             |
| ----------- | ----------------------------------------------- | ------------------------------------------------------ |
| 1. Identity | Display name                                    | 2–60 chars, required                                   |
| 2. Avatar   | Image upload or skip                            | JPEG/PNG/WebP ≤5 MB, re-encoded to 512×512 via `sharp` |
| 3. Bio      | Short text                                      | ≤280 chars, optional                                   |
| 4. Hashtags | **Exactly 5** from catalog or newly created     | Exactly 5; the DB hard-caps at 5; UI shows "5 of 5"    |
| 5. Handles  | Optional `profile_links` rows, one per platform | Valid public URL for the detected platform             |

Step 4 is the highest-friction screen, so:

- The picker shows a live counter: `3 of 5 selected`
- At 5 selected, the search field disables with the message "Five hashtags is the maximum — remove one to swap"
- Suggestions are ranked by `hashtags.usage_count DESC` so a new member can reach a valid state in one pass
- Each selected hashtag shows a one-line helper: "Describe your expertise or interests — these drive what appears in your feed"
- Submission is a single RPC `set_profile_hashtags(p_hashtags uuid[])` that deletes and re-inserts inside one transaction, so the deferred constraint trigger sees a valid end state

```sql
create or replace function set_profile_hashtags(p_hashtags uuid[])
returns void language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if coalesce(array_length(p_hashtags,1),0) > 5 then
    raise exception 'Profile hashtag limit exceeded' using errcode='check_violation';
  end if;
  delete from profile_hashtags where profile_id = v_uid;
  insert into profile_hashtags (profile_id, hashtag_id, position)
  select v_uid, h, ord - 1 from unnest(p_hashtags) with ordinality as t(h, ord);
end $$;
```

### 5.4 Hashtag creation rules

Tags are a community vocabulary, not free text, so creation is constrained:

```sql
create or replace function normalize_hashtag(p_raw text)
returns text language plpgsql immutable as $$
declare v text := lower(trim(p_raw));
begin
  v := regexp_replace(v, '^#+', '', 'g');
  v := regexp_replace(v, '[^a-z0-9_]', '', 'g');
  v := regexp_replace(v, '_{2,}', '_', 'g');
  v := trim(both '_' from v);
  if char_length(v) < 2 then
    raise exception 'Hashtag must be at least 2 characters' using errcode='check_violation';
  end if;
  if char_length(v) > 30 then
    raise exception 'Hashtag must be 30 characters or fewer' using errcode='check_violation';
  end if;
  return v;
end $$;
```

Additional rules enforced in `create_hashtag(p_label text)`:

- Normalized form must be unique; conflicts return the existing tag rather than erroring (so the picker is idempotent)
- `usage_count` increments via trigger whenever `content_hashtags` gains a row
- A member may create at most 5 new hashtags per day (prevents vocabulary spam in a 30-person community)
- `is_official` is admin-only; official tags sort first in the picker

### 5.5 Friendship state machine

Friend affinity in the feed counts only **mutual, confirmed** connections — "a transparent, limited boost for confirmed friends" (T07).

```
            send request                accept
   none ──────────────────────► pending ───────────► accepted
     ▲                             │                    │
     │            decline          │     block          │  block
     └─────────────────────────────┘                    ▼
                                                 blocked ──(unblock)──► none
```

| Transition           | Actor          | RPC                                                 | Notes                                                                             |
| -------------------- | -------------- | --------------------------------------------------- | --------------------------------------------------------------------------------- |
| `none → pending`     | requester      | `send_friend_request(p_addressee)`                  | Rejected if blocked either direction, self, or already pending/accepted           |
| `pending → accepted` | addressee only | `respond_friend_request(p_friendship_id, p_accept)` | On accept, normalized `pair_key` means both directions collapse to one row        |
| `pending → declined` | addressee only | same RPC, `p_accept = false`                        | Row retained for audit                                                            |
| any → `blocked`      | either party   | `block_member(p_user_id)`                           | Insert-or-update; also hides that member's entries from the blocked viewer's feed |
| `accepted → none`    | either party   | `remove_friend(p_friendship_id)`                    | Keeps an audit row with `state='declined'`                                        |

Mutual-only is structural: the row is keyed on a sorted pair, so there is never a half-friendship:

```sql
alter table friendships add column pair_key text
  generated always as (least(requester_id::text, addressee_id::text)
                       || ':' ||
                       greatest(requester_id::text, addressee_id::text)) stored;
create unique index friendships_pair_key_idx on friendships (pair_key);
```

### 5.6 Avatar upload

- Bucket `avatars`, **public read**, owner-only write. Path convention: `{user_id}/{timestamp}.{ext}` so listing a user's objects only ever returns their own files.
- Server route `POST /api/profile/avatar` validates MIME + size, re-encodes with `sharp` (512×512 cover crop, WebP, ≤200 KB), uploads, then writes `profiles.avatar_path`.
- Client never uploads directly to Storage — going through the route keeps size validation and re-encoding off the client and out of reach of a bypass.

Storage policies:

```sql
create policy "avatars are publicly readable"
  on storage.objects for select using (bucket_id = 'avatars');

create policy "members upload to their own avatar folder"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars'
              and (storage.foldername(name))[1] = auth.uid()::text);

create policy "members update their own avatar"
  on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and owner_id = auth.uid()::text);
```

### 5.7 Page & component inventory

| Route               | Purpose                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `/login`            | Email entry; magic-link request; explains invite-only                  |
| `/invite/[token]`   | Validates a raw token, redirects to `/auth/accept`                     |
| `/auth/accept`      | Completes account creation from a valid invite                         |
| `/auth/callback`    | PKCE/OAuth code exchange + session cookie write                        |
| `/onboarding`       | 5-step wizard; guarded by middleware until complete                    |
| `/settings/profile` | Edit display name, avatar, bio, hashtags, handles                      |
| `/settings/account` | Session, sign-out, account overview                                    |
| `/u/[handle]`       | Public profile — reputation (T06), entries, friends, accepted feedback |

Components: `HashtagPicker`, `AvatarUploader`, `BioField`, `PlatformLinksEditor`, `FriendRequestButton`, `FriendList`, `ProfileCard`, `OnboardingStepper`, `InviteAcceptanceCard`.

---

## 6. Files to create

| Path                                                 | Purpose                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/web/src/middleware.ts`                         | Session refresh + route protection                                                       |
| `apps/web/src/app/(auth)/login/page.tsx`             | Magic-link request                                                                       |
| `apps/web/src/app/(auth)/invite/[token]/page.tsx`    | Invite validation                                                                        |
| `apps/web/src/app/(auth)/auth/accept/page.tsx`       | Account creation                                                                         |
| `apps/web/src/app/(auth)/auth/callback/route.ts`     | PKCE exchange                                                                            |
| `apps/web/src/app/onboarding/page.tsx`               | 5-step wizard                                                                            |
| `apps/web/src/app/onboarding/actions.ts`             | Server actions                                                                           |
| `apps/web/src/app/settings/profile/page.tsx`         | Profile editor                                                                           |
| `apps/web/src/app/settings/account/page.tsx`         | Account settings                                                                         |
| `apps/web/src/app/u/[handle]/page.tsx`               | Public profile                                                                           |
| `apps/web/src/api/auth/accept-invite/route.ts`       | Invite claim                                                                             |
| `apps/web/src/api/profile/avatar/route.ts`           | Avatar upload + re-encode                                                                |
| `apps/web/src/api/friendships/route.ts`              | Send/respond/remove/block                                                                |
| `apps/web/src/components/profile/*`                  | HashtagPicker, AvatarUploader, BioField, PlatformLinksEditor                             |
| `apps/web/src/components/social/*`                   | FriendRequestButton, FriendList, ProfileCard                                             |
| `apps/web/src/components/onboarding/*`               | OnboardingStepper + step components                                                      |
| `supabase/migrations/0012_hashtag_normalization.sql` | `normalize_hashtag()`, `create_hashtag()`, usage triggers                                |
| `supabase/migrations/0013_friend_requests.sql`       | `send_friend_request()`, `respond_friend_request()`, `block_member()`, `remove_friend()` |
| `supabase/tests/005_friendships.sql`                 | pgTAP: state machine                                                                     |
| `packages/domain/src/profile.ts`                     | Profile zod schemas, handle rules, bio limits                                            |
| `tests/e2e/onboarding.spec.ts`                       | Playwright: invite → onboarding → profile                                                |

---

## 7. Implementation steps

- [x] Set `GOTRUE_DISABLE_SIGNUP=true`; confirm `supabase.auth.signUp` is unreachable in the client bundle
- [x] Migration `0012`: `normalize_hashtag()`, `create_hashtag()`, daily-creation cap, `usage_count` triggers
- [x] Migration `0013`: friendship RPCs + `pair_key` uniqueness + `set_profile_hashtags()`
- [x] Create the `avatars` Storage bucket and its RLS policies (dev + prod via migration)
- [x] Write `middleware.ts` with session refresh, public-route allowlist, admin gate, onboarding gate
- [x] Build `/login` with `signInWithOtp`; handle rate-limit and expiry messaging
- [x] Build `/invite/[token]` + `/auth/accept` + `POST /api/auth/accept-invite`
- [x] Add an admin-only helper script to issue invites (full admin UI in T09)
- [x] Build the onboarding wizard with server actions and per-step validation
- [x] Build `HashtagPicker` with search, suggestions, create flow, and the hard 5-slot counter
- [x] Build `AvatarUploader` + `POST /api/profile/avatar` with `sharp` re-encoding
- [x] Build `BioField` (280 chars) and `PlatformLinksEditor` with per-platform URL validation
- [x] Build `/settings/profile` reusing the same components
- [x] Build friendship route handlers + `FriendRequestButton` / `FriendList`
- [x] Build `/u/[handle]` with an empty-state placeholder for entries (populated in T04)
- [x] Add pgTAP suite `005_friendships.sql`
- [x] Write the Playwright onboarding spec
- [x] Add an ESLint `no-restricted-syntax` rule banning direct `process.env` outside `packages/env`

---

## 8. Acceptance criteria

- [x] Signing up without an invite is impossible (no `signUp` call path; Auth sign-up disabled)
- [x] A valid invite creates exactly one account; the same token a second time returns "Invite already used"
- [x] An expired or revoked invite is rejected with a clear message
- [x] Only `token_hash` is stored — grep the `invites` table for raw tokens and find none
- [x] The onboarding wizard cannot be submitted with ≠5 hashtags
- [x] Attempting to select a 6th hashtag is impossible in the UI, and blocked by the DB if forced
- [x] The UI shows a live "n of 5" counter and disables search at 5
- [x] Avatar upload rejects a 6 MB file and a non-image MIME type
- [x] Uploaded avatars are re-encoded to ≤200 KB WebP
- [x] A member cannot write to another member's avatar folder (storage policy test)
- [x] Friend requests require mutual acceptance before appearing in the friends list
- [x] Only the addressee can accept or decline a request
- [x] Blocking removes existing friendship and hides the blocked member's entries from the feed
- [x] `/u/[handle]` is publicly readable for any signed-in member but unreachable by anon users
- [x] Handles are unique, case-insensitive, and normalized

---

## 9. Tests

- **Unit**: `normalize_hashtag` (leading `#`, punctuation, spaces, underscores, length bounds); bio limits; handle normalization
- **pgTAP**: friendship state machine transitions; `pair_key` uniqueness; self-request rejection; blocked-pair rejection; `set_profile_hashtags` cap
- **Integration**: invite claim happy path + replay path; avatar storage policy denial
- **E2E (Playwright)**: full journey — `/invite/<token>` → account created → 5 wizard steps → profile page renders → send a friend request → accept as the second user

---

## 10. Verification commands

```bash
pnpm db:reset
supabase test db
pnpm --filter @fydio/web test -- onboarding
pnpm dev
# invite issue (local)
pnpm --filter @fydio/web exec tsx scripts/issue-invite.ts --email tester@demo.test --role member

curl -fsS http://localhost:8025/api/v1/messages   # Mailpit: confirm the magic-link email
psql "$DATABASE_URL" -c "select handle, display_name, role from profiles order by created_at limit 10;"
psql "$DATABASE_URL" -c "select p.handle, count(*) from profile_hashtags ph join profiles p on p.id=ph.profile_id group by 1 having count(*) > 5;"
```

---

## 11. Risks & mitigations

| Risk                                                         | Mitigation                                                                                                                                                     |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Magic-link emails land in spam for a real community          | Document adding SPF/DKIM in T10; Mailpit in dev; keep invite acceptance independent of the email round-trip                                                    |
| `handle_new_user()` firing before the invite is claimed      | The trigger creates a bare profile; `claim_invite` sets `role` and `display_name` after. Guard the trigger so it never runs for admin-created service accounts |
| A member deletes their avatar and orphans the Storage object | Delete the previous object inside the upload route after a successful replace                                                                                  |
| Hashtag vocabulary fragmentation                             | Normalization + uniqueness + usage-count ranking + a 5-per-day creation cap                                                                                    |
| `sharp` native binary breaks the Docker build                | Use the platform-appropriate `sharp` version; verify in the T10 multi-stage build                                                                              |
| Friendship requests become a spam vector                     | One pending request per pair, block support, and rate-limit request sends to 10/hour                                                                           |

---

## 12. Definition of done

A member can go from raw invite link to a complete, validated profile with five hashtags and at least one confirmed friend, with every access rule enforced by RLS or a trigger rather than by the UI.

---

## 13. Verification record

Run against a fresh `pnpm db:reset` on a local stack.

| Check | Command | Result |
| --- | --- | --- |
| Migrations + seed | `pnpm db:reset` | pass |
| Database behaviour | `pnpm db:test` | **155 tests, 5 files, PASS** |
| Domain rules | `pnpm --filter @fydio/domain test` | **120 passed** |
| App integration | `pnpm --filter @fydio/web test` | **22 passed** (19 live-HTTP) |
| Lint, typecheck, build | `pnpm validate` | **36/36 tasks** |
| Production build | `pnpm --filter @fydio/web build` | pass, Proxy registered |
| Browser journey | `pnpm --filter @fydio/web test:e2e` | **10 passed** |

### Manual acceptance

- **Replay refused.** Redeeming once returns a session; the same token again returns
  `That invitation has already been used.`; an unknown token returns
  `That invitation link is not valid.`
- **No raw token at rest.** A PL/pgSQL scan of every `text`/`varchar`/`json`/`jsonb` column in
  `public` and `auth` for the issued token's prefix returns nothing. `invites.token_hash` is
  `bytea` — the SHA-256 digest, never the token.
- **Invite-only holds.** `signInWithOtp` refuses an address with no account; no `signUp` call
  path exists in the client bundle.

### Defects found and fixed while verifying

These were not pre-existing bugs in the feature; each was a real defect that only a browser,
rather than a unit test, could surface.

1. **Magic-link sign-in was impossible.** Auth redirects with the session in the URL
   *fragment*, which never reaches a server, so the `/auth/callback` Route Handler exchanged
   nothing and the member landed signed-out. It is now a page whose client component performs
   the exchange and scrubs the fragment. The original E2E test passed while this was broken
   because it only asserted "not on `/login`", and Auth redirects *through* a real URL on its
   way there; the assertion now demands a session by loading a protected page.
2. **Every sign-in email linked to a 401.** Auth builds the link as
   `<API_EXTERNAL_URL><URLPaths.MagicLink>`, and the default `/verify` is not a gateway route —
   `/auth/v1/verify` is. The gateway's own log named the variable; the fix is
   `GOTRUE_MAILER_URLPATHS_*`. Note the path cannot live on `GOTRUE_API_EXTERNAL_URL`, because
   the mailer resolves with `url.ResolveReference("/verify")`, which discards a base path.
3. **`NEXT_PUBLIC_*` never reached the browser.** `@fydio/env` handed the whole `process.env`
   object to Zod, and a bundler only inlines *static* `process.env.NEXT_PUBLIC_X` member
   expressions — so every client-side env read was `undefined` at runtime. Surfaced only once
   T03 added the first browser-side Supabase client.
4. **A second email to one address was impossible for 114 years.** The dev stack set
   `GOTRUE_SMTP_MAX_FREQUENCY: '1000000h'`, and invite redemption spends the address's only
   allowed send, so the magic link that follows it was refused. Note `0s` does **not** work: a
   zero duration reads as unset and falls back to the one-minute default.
5. **Mailpit was unreachable from Auth.** `docker-compose.dev.yml` defined the service without
   joining the `fydio` network, so it landed on `fydio_default` and `mailpit` did not resolve.
6. **A successful accept reported itself as a decline.** `FriendRequestButton` collapsed
   `accept` and `decline` into one branch, showing "Send request again" for a friendship that
   had just been made.

### Deliberately not built

- **Admin UI.** §7 scopes this to "an admin-only helper script to issue invites (full admin UI
  in T09)". `pnpm --filter @fydio/web invite:new --email <address>` is the script.
- **Notification preferences.** §3 asks for "notification prefs (minimal)"; the account page
  carries the session controls and overview this task needs, and notification delivery has no
  consumer until T04/T07/T09.
