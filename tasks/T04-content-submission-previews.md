# T04 — Content Submission, Platform Parsing & Previews

**Status:** Not started
**Depends on:** T02, T03
**Blocks:** T07, T08, T09
**Brief reference:** §3 Add content, §Include "Content submission for Instagram, TikTok, YouTube, and X URLs, with exactly three hashtags", §6 (open original), "Content previews: oEmbed or permitted public metadata where supported; graceful fallback to link cards."

---

## 1. Goal

Let a member spend **one Fydio Credit** to publish a public content link from Instagram, TikTok, YouTube, or X, with **exactly three hashtags**, an optional creator note, and an optional cover image — with previews resolved where permitted and a graceful link-card fallback everywhere else.

After T04 an entry exists in the database with correct metadata, and the credit has been debited atomically.

---

## 2. Why this position in the plan

The feed (T07) needs entries to rank, and outbound-click telemetry (T08) needs entries to point at. This is also where the credit economy becomes real for the first time, so the safeguards from T02 get exercised in a user-facing flow.

---

## 3. Scope

### In scope

- URL detection + canonicalization for all four platforms
- Submission form: URL, exactly 3 hashtags, optional creator note, optional "asks for feedback", optional cover upload
- Server-side platform allowlist enforcement (`PLATFORM_ALLOWLIST`)
- Preview resolution: oEmbed first, permitted public metadata second, link-card fallback last
- Supabase Edge Function `resolve-preview`
- Cover image upload to Storage with RLS policies
- Entry lifecycle: create, edit (hashtags/note only), hide, delete
- Duplicate detection and self-submission guard
- Public entry page at `/c/[id]`

### Explicitly out of scope

- Feed ranking (T07)
- Outbound click tracking and opened state (T08)
- Feedback on entries (T09)
- Automated scraping of private data, login walls, or any platform-credential access — the brief forbids credential collection

---

## 4. Deliverables

1. `@fydio/domain` platform detection module (extended from T01)
2. `POST /api/entries` submission route + server action
3. `/submit` page with live URL validation and a 3-hashtag picker
4. Edge Function `supabase/functions/resolve-preview/index.ts`
5. Storage bucket `covers` + RLS policies
6. `/c/[id]` public entry page with link-card fallback rendering
7. Entry edit/hide/delete actions
8. Tests for platform parsing, canonicalization, and the credit-spend integration

---

## 5. Technical design

### 5.1 Platform detection

`packages/domain/src/platforms.ts` is pure and unit-tested — it must match on **host suffixes**, never substring `includes()`, or `evil-instagram.com` would pass.

```ts
import { z } from 'zod'

export const platformKind = z.enum(['instagram', 'tiktok', 'youtube', 'x'])
export type PlatformKind = z.infer<typeof platformKind>

type Rule = {
  platform: PlatformKind
  hosts: readonly string[]
  pathHints: readonly RegExp[]
}

const RULES: readonly Rule[] = [
  {
    platform: 'instagram',
    hosts: ['instagram.com', 'www.instagram.com', 'm.instagram.com', 'instagr.am'],
    pathHints: [/^\/p\//, /^\/reel\//, /^\/reels\//, /^\/tv\//],
  },
  {
    platform: 'tiktok',
    hosts: ['tiktok.com', 'www.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
    pathHints: [/^\/video\//, /^\/@[\w.\-]+\/video\//, /^\/t\//],
  },
  {
    platform: 'youtube',
    hosts: [
      'youtube.com',
      'www.youtube.com',
      'm.youtube.com',
      'youtu.be',
      'youtube-nocookie.com',
      'www.youtube-nocookie.com',
    ],
    pathHints: [/^\/watch/, /^\/shorts\//, /^\/live\//, /^\/embed\//],
  },
  {
    platform: 'x',
    hosts: [
      'x.com',
      'www.x.com',
      'mobile.x.com',
      'twitter.com',
      'www.twitter.com',
      'mobile.twitter.com',
    ],
    pathHints: [/^\/[\w.\-]+\/status\/\d+/],
  },
]

export function detectPlatform(
  input: string,
): { platform: PlatformKind; canonicalUrl: string } | null {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    return null
  }

  if (url.protocol !== 'https:') return null // http only for explicit dev override

  const host = url.hostname.toLowerCase()
  const rule = RULES.find(
    (r) =>
      r.hosts.some((h) => host === h || host.endsWith(`.${h}`)) &&
      r.pathHints.some((p) => p.test(url.pathname)),
  )
  return rule ? { platform: rule.platform, canonicalUrl: canonicalize(url, rule.platform) } : null
}
```

Three deliberate choices:

- **`host === h || host.endsWith('.' + h)`** — suffix matching, not substring. `notinstagram.com` is rejected.
- **Path hints required** — `https://instagram.com/` is not a post, so it is rejected rather than creating a broken entry.
- **HTTPS only** — rejects `javascript:` and `data:` payloads, which matters because the URL is rendered into an `href`.

Canonicalization removes tracking noise so the same post is never submitted twice:

```ts
function canonicalize(url: URL, platform: PlatformKind): string {
  const u = new URL(url.toString())
  u.hash = ''
  u.protocol = 'https:'
  u.hostname = u.hostname.replace(/^www\./, '').replace(/^m\./, '')

  for (const p of [
    'fbclid',
    'gclid',
    'igshid',
    'igsh',
    'si',
    'share_id',
    'ref_src',
    'ref_url',
    's',
    '_r',
    't',
  ]) {
    u.searchParams.delete(p)
  }
  if (platform === 'youtube' && u.searchParams.has('v')) {
    u.pathname = `/watch`
    return `https://youtube.com/watch?v=${u.searchParams.get('v')}`
  }
  return u.toString()
}
```

> YouTube shorts (`/shorts/<id>`) normalize to `https://youtube.com/shorts/<id>` rather than `watch?v=`, since both resolve and `watch?v=` on a Shorts ID often lands on the wrong surface.

### 5.2 Submission flow

```
/submit
  │
  ├─ URL field ──► onBlur ──► POST /api/entries/validate ──► { platform, canonicalUrl, preview }
  │                                    │
  │                                    └─ rejects unsupported host / path / protocol
  │
  ├─ 3-hashtag picker (exactly 3 required, live counter)
  ├─ Optional: cover upload ──► POST /api/entries/cover ──► Storage `covers`
  ├─ Optional: creator note (≤1000 chars) + "asks for feedback" toggle
  │
  └─ Submit ──► POST /api/entries
                 1. zod validation (client and server share the schema)
                 2. detectPlatform + PLATFORM_ALLOWLIST check
                 3. preview resolution (cached; never blocks submission)
                 4. rpc('create_content_entry', {...})   ◄── spends 1 Credit atomically
                 5. upload cover to Storage
                 6. redirect /c/<id>?submitted=1
```

Preview resolution is **deliberately non-blocking**. If oEmbed times out, the entry is still created with `preview_state='unavailable'` and renders as a link card. A preview outage must never cost someone their credit.

```ts
// apps/web/src/app/api/entries/route.ts
export async function POST(req: Request) {
  const parsed = submitEntrySchema.safeParse(await req.json())
  if (!parsed.success) return badRequest(parsed.error.flatten())

  const detected = detectPlatform(parsed.data.url)
  if (!detected) return badRequest({ url: 'Unsupported URL for Instagram, TikTok, YouTube, or X' })
  if (!env.PLATFORM_ALLOWLIST.includes(detected.platform)) {
    return badRequest({ url: `${detected.platform} is not currently allowed` })
  }

  const supabase = createServerClient(cookies())
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return unauthorized()

  // Preview is best-effort: failure degrades to a link card.
  const preview = await resolvePreviewSafely({
    url: detected.canonicalUrl,
    platform: detected.platform,
    timeoutMs: env.URL_PREVIEW_TIMEOUT_MS,
  })

  // The RPC spends the Credit. If it throws, nothing was written.
  const { data: entry, error } = await supabase.rpc('create_content_entry', {
    p_platform: detected.platform,
    p_url: parsed.data.url,
    p_canonical_url: detected.canonicalUrl,
    p_title: preview.title ?? null,
    p_caption: preview.caption ?? null,
    p_creator_note: parsed.data.creatorNote ?? null,
    p_asks_for_feedback: parsed.data.asksForFeedback,
    p_hashtags: parsed.data.hashtags,
    p_cover_path: parsed.data.coverPath ?? null,
  })

  if (error) return mapDbError(error) // 'Insufficient Credits' surfaces verbatim

  void persistPreviewAsync(entry.id, preview)
  return created({ id: entry.id })
}
```

### 5.3 Preview resolution Edge Function

Self-hosted Supabase runs Edge Functions from the bind-mounted functions directory, so deployment is `git pull` + restart (no `supabase functions deploy` round-trip — a T10 detail).

Resolution ladder, in order:

| Tier | Source                        | Applies to                                                               | Notes                                                                       |
| ---- | ----------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| 1    | **oEmbed endpoint**           | YouTube (`https://www.youtube.com/oembed`), TikTok (partial), X (varies) | Public, sanctioned, no scraping                                             |
| 2    | **Permitted public metadata** | Instagram oEmbed via Graph API when `INSTAGRAM_ACCESS_TOKEN` is set      | Without a token, fall straight to tier 3                                    |
| 3    | **YouTube Data API**          | YouTube only                                                             | Only if `YOUTUBE_API_KEY` is configured                                     |
| 4    | **Link card fallback**        | All                                                                      | `preview_state='unavailable'`; render platform badge + host + canonical URL |

```ts
// supabase/functions/resolve-preview/index.ts
const OAUTH_TIMEOUT_MS = 3_500

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  try {
    return await p
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

const PROVIDERS: Record<PlatformKind, (u: string) => Promise<RawPreview | null>> = {
  youtube: youtubeOembed, // public endpoint, no key required
  tiktok: tiktokOembed,
  x: xOembed,
  instagram: instagramOembed, // null unless INSTAGRAM_ACCESS_TOKEN is set
}

Deno.serve(async (req) => {
  const { url, platform } = await req.json()
  if (!PLATFORMS.includes(platform)) return json({ previewState: 'unavailable' })

  const raw = await withTimeout(PROVIDERS[platform](url), OAUTH_TIMEOUT_MS)
  if (!raw?.thumbnailUrl) return json({ previewState: 'unavailable' })

  // Store preview metadata + the ORIGINAL external thumbnail URL.
  // We never mirror third-party media: the brief says Fydio stores a preview
  // and metadata only where permitted, and the platform stays the source.
  return json({
    previewState: 'resolved',
    title: sanitize(raw.title, 300),
    caption: sanitize(raw.text, 1000),
    thumbnailPath: null,
    thumbnailSource: raw.thumbnailUrl,
    authorName: sanitize(raw.authorName, 80),
  })
})
```

**Privacy stance, stated explicitly:** the function reads only public oEmbed endpoints, sends no platform credentials, performs no login, and never follows a user session. If a platform blocks it, the entry degrades to a link card — it never fails.

### 5.4 Cover image upload

- Bucket `covers`, **public read**, owner-scoped writes
- Path: `{user_id}/{entry_or_temp_id}/{timestamp}.{ext}`
- Validate MIME (`image/jpeg|png|webp`), size ≤5 MB, and dimensions ≥400×225
- Re-encode via `sharp` to WebP, 1200×630 cover crop, ≤300 KB
- Uploads happen **after** `create_content_entry` succeeds, so a failed upload never costs a credit

### 5.5 Entry lifecycle

| Action                     | Allowed                     | Implementation                                                                      |
| -------------------------- | --------------------------- | ----------------------------------------------------------------------------------- |
| Edit hashtags              | Author only, no credit cost | `set_entry_hashtags(p_entry_id, p_hashtags uuid[])` — keeps the exactly-3 invariant |
| Edit creator note          | Author only                 | `update_entry_note()`                                                               |
| Hide                       | Author or admin             | `status='hidden'`; removes from feed but keeps data and metrics                     |
| Delete                     | Author (soft)               | `status='removed'`, `deleted_at=now()`; admin hard-delete is a moderation action    |
| Toggle "asks for feedback" | Author only                 | `update_entry()`                                                                    |

The brief states that "an entry's unused submission Credit is not refundable after it enters the feed" — so **no refund path exists**. Hide and remove leave the credit ledger untouched; only admin `admin_reverse_credit` can return credits, and that writes an explicit reversal pair with a reason.

### 5.6 Public entry page

`/c/[id]` renders:

- Creator identity (avatar, display name, handle)
- Platform badge with a `target="_blank" rel="noopener noreferrer nofollow"` link to the original URL
- Thumbnail if resolved, otherwise a platform-branded link card
- Title / caption excerpt
- Exactly three hashtags, each linking to a tag pool
- Creator note, rendered as a prompt
- "Opens on the original platform" notice
- Placeholders for the feedback section (T09) and open/click actions (T08)

The link always points to the **original URL** the member submitted. Fydio never proxies, embeds, or mirrors the content.

---

## 6. Files to create

| Path                                                | Purpose                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/domain/src/platforms.ts`                  | `detectPlatform`, `canonicalizeUrl`, host/path rules               |
| `packages/domain/src/entry.ts`                      | Submission zod schema, limits                                      |
| `apps/web/src/app/submit/page.tsx`                  | Submission form                                                    |
| `apps/web/src/app/submit/actions.ts`                | Server actions                                                     |
| `apps/web/src/app/c/[id]/page.tsx`                  | Public entry page                                                  |
| `apps/web/src/app/api/entries/route.ts`             | Create entry (spends credit)                                       |
| `apps/web/src/app/api/entries/validate/route.ts`    | Live URL detection + preview probe                                 |
| `apps/web/src/app/api/entries/cover/route.ts`       | Cover upload + re-encode                                           |
| `apps/web/src/app/api/entries/[id]/route.ts`        | Edit / hide / delete                                               |
| `apps/web/src/components/entry/*`                   | SubmitForm, PlatformBadge, EntryCard, LinkCardFallback, TagTriplet |
| `apps/web/src/components/storage/ImageUploader.tsx` | Shared uploader (reused by avatar in T03)                          |
| `supabase/functions/resolve-preview/index.ts`       | Preview Edge Function                                              |
| `supabase/functions/resolve-preview/deno.json`      | Deno config                                                        |
| `supabase/migrations/0014_entry_lifecycle.sql`      | `set_entry_hashtags`, `update_entry`, `hide_entry`, `remove_entry` |
| `supabase/tests/006_content_entries.sql`            | pgTAP: entry lifecycle + credit integration                        |
| `tests/e2e/submit-content.spec.ts`                  | Playwright: submit → entry page                                    |
| `.env.example` (update)                             | `INSTAGRAM_ACCESS_TOKEN`, `YOUTUBE_API_KEY` as optional            |

---

## 7. Implementation steps

- [ ] Extend `packages/domain/src/platforms.ts` with suffix-safe host matching and path hints
- [ ] Add 40+ URL fixtures covering all four platforms plus adversarial hosts
- [ ] Create the `covers` Storage bucket and RLS policies
- [ ] Write `POST /api/entries/cover` with MIME/size/dimension validation + `sharp` re-encode
- [ ] Write the `resolve-preview` Edge Function with the 4-tier ladder and hard timeouts
- [ ] Wire preview resolution to be non-blocking on submission
- [ ] Write `POST /api/entries` with full validation → allowlist → preview → RPC → upload
- [ ] Write `POST /api/entries/validate` for live in-form feedback
- [ ] Build `/submit` with live URL validation, the exactly-3 picker, cover upload, note, and feedback toggle
- [ ] Show the current Credit balance and the cost of submitting on `/submit`
- [ ] Build `/c/[id]` with thumbnail-or-link-card rendering and the original-platform link
- [ ] Write `set_entry_hashtags`, `update_entry`, `hide_entry`, `remove_entry` (migration `0014`)
- [ ] Add edit/hide/delete controls for the author
- [ ] Add pgTAP suite `006_content_entries.sql`
- [ ] Write the Playwright submission spec
- [ ] Verify the "no credit, no entry" invariant end to end

---

## 8. Acceptance criteria

- [ ] All four platforms detect correctly across 40+ real URL fixtures
- [ ] `https://evil-instagram.com/p/x` is rejected
- [ ] `https://instagram.com/` (no post path) is rejected
- [ ] `http://` and `javascript:` URLs are rejected
- [ ] Tracking params are stripped by canonicalization, and canonicalization is idempotent
- [ ] The same URL submitted twice by the same member fails with "already submitted"
- [ ] Submitting with 0 Credits fails with an explicit `Insufficient Credits` message and **creates no entry**
- [ ] Exactly 3 hashtags are required; 2 or 4 is rejected by both the form and the DB
- [ ] An entry submitted with the oEmbed service unreachable still appears as a link card
- [ ] The entry's outbound link is the original URL with `target="_blank" rel="noopener noreferrer"`
- [ ] Cover upload rejects files >5 MB and non-image MIME types
- [ ] No refund path exists on hide/remove — credit rows are unchanged
- [ ] Editing hashtags on an entry preserves the exactly-3 invariant
- [ ] A member cannot edit or hide another member's entry

---

## 9. Tests

- **Unit (`packages/domain`)**: platform detection table tests; adversarial hosts; path hints; canonicalization idempotency; zod schema boundaries (note length, exactly-3 array)
- **Unit (Edge Function)**: `withTimeout` behavior; each provider's happy and null paths; the fallback ladder; sanitization/truncation of hostile titles
- **pgTAP**: entry lifecycle RPCs; duplicate URL; exactly-3 on edit; author-only permissions; "no credit, no entry"
- **Integration**: full submit via the route handler against the dev stack, asserting the credit ledger delta is exactly `-1`
- **E2E (Playwright)**: sign in → `/submit` → invalid URL shows an inline error → valid URL + 3 hashtags + note → lands on `/c/[id]` → link points at the original platform

---

## 10. Verification commands

```bash
pnpm --filter @fydio/web test -- platforms
supabase test db --file supabase/tests/006_content_entries.sql
supabase functions serve resolve-preview --env-file docker/.env &
curl -s -X POST http://127.0.0.1:54321/functions/v1/resolve-preview \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ","platform":"youtube"}' | jq

psql "$DATABASE_URL" -c "select ce.id, p.platform, p.canonical_url, ce.preview_state from content_entries ce join profiles p on p.id=ce.author_id order by ce.created_at desc limit 5;"
psql "$DATABASE_URL" -c "select user_id, delta, kind, status, note from credit_ledger order by created_at desc limit 5;"
psql "$DATABASE_URL" -c "select entry_id, count(*) from content_hashtags group by 1 having count(*) <> 3;"  -- must return 0 rows
```

---

## 11. Risks & mitigations

| Risk                                                     | Mitigation                                                                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Platforms block or change oEmbed endpoints               | Preview is best-effort and non-blocking; link-card fallback always works; resolver is a separate deployable unit         |
| oEmbed HTML injection via title/caption                  | Strip tags and escape before render; never `dangerouslySetInnerHTML` preview metadata                                    |
| Hotlinking external thumbnails breaks or leaks referrers | Render through a controlled `<img>` with `referrerPolicy="no-referrer"`; store the URL, do not proxy                     |
| SSRF via user-supplied URL in the Edge Function          | Strict platform allowlist + HTTPS-only + resolved-host check; **never** fetch a URL that is not on a known platform host |
| Credit spent but entry failed (or vice versa)            | `create_content_entry` is one transaction: entry + ledger debit + hashtags commit together or not at all                 |
| Instagram oEmbed requires a Meta app token               | Make `INSTAGRAM_ACCESS_TOKEN` optional; document it in T10; without it, Instagram uses link cards                        |
| Abusive cover images                                     | Re-encode strips EXIF and validates dimensions; admin moderation queue in T09                                            |

---

## 12. Definition of done

A member can spend one Credit to publish a real Instagram/TikTok/YouTube/X link with exactly three hashtags, the preview degrades gracefully, the original URL is always the destination, and no code path exists to refund the spent Credit automatically.
