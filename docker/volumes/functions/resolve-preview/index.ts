// supabase/functions/resolve-preview/index.ts
//
// Best-effort link-preview resolver for content submissions.
//
// DEPLOYED COPY: this stack serves edge functions from
// `docker/volumes/functions/<name>/` (see the `functions` service in
// docker/docker-compose.yml). The file at
// `docker/volumes/functions/resolve-preview/index.ts` is a copy of this file;
// keep the two identical until T10 automates the sync (git pull + restart).
//
// Privacy stance: reads only public oEmbed / public-data endpoints, sends no
// platform credentials (except server-side API keys from env, never user
// sessions), performs no login, and NEVER fetches the user-supplied URL
// directly. The user URL is only ever sent as an encoded query parameter to a
// fixed provider endpoint. Anything unexpected degrades to
// `{ previewState: 'unavailable' }` — a preview outage must never fail a
// submission.
//
// Ladder:
//   1. oEmbed — YouTube (public, no key), TikTok, X (via publish.twitter.com)
//   2. Instagram Graph API oEmbed — only when INSTAGRAM_ACCESS_TOKEN is set
//   3. YouTube Data API — only when YOUTUBE_API_KEY is set
//   4. Link-card fallback — `{ previewState: 'unavailable' }`
//
// Runtime: Supabase self-hosted Edge Runtime (Deno). No npm/jsr imports.

const PREVIEW_TIMEOUT_MS = 3_500;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, content-profile",
};

type PlatformKind = "instagram" | "tiktok" | "youtube" | "x";

const PLATFORMS: readonly PlatformKind[] = [
  "instagram",
  "tiktok",
  "youtube",
  "x",
];

/**
 * Known platform hosts. Matching is suffix-based
 * (`host === h || host.endsWith('.' + h)`), never substring, so
 * `evil-instagram.com` does not pass.
 */
const PLATFORM_HOSTS: Record<PlatformKind, readonly string[]> = {
  instagram: ["instagram.com", "instagr.am"],
  tiktok: ["tiktok.com", "vm.tiktok.com", "vt.tiktok.com"],
  youtube: ["youtube.com", "youtu.be", "youtube-nocookie.com"],
  x: ["x.com", "twitter.com"],
};

type RawPreview = {
  title?: string | null;
  text?: string | null;
  thumbnailUrl?: string | null;
  authorName?: string | null;
  authorUrl?: string | null;
};

function isPlatform(value: unknown): value is PlatformKind {
  return (
    typeof value === "string" &&
    (PLATFORMS as readonly string[]).includes(value)
  );
}

function hostMatchesPlatform(hostname: string, platform: PlatformKind): boolean {
  const host = hostname.toLowerCase();
  return PLATFORM_HOSTS[platform].some(
    (h) => host === h || host.endsWith("." + h),
  );
}

/**
 * Independent SSRF guard: the URL must parse, be https:, and sit on a known
 * host for the claimed platform. Returns the trimmed URL string on success,
 * null otherwise. Never throws.
 */
function validateSubmissionUrl(
  url: unknown,
  platform: PlatformKind,
): string | null {
  if (typeof url !== "string") return null;
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  // Reject javascript:/data:/ftp:/http: and any other non-https scheme.
  if (parsed.protocol !== "https:") return null;
  if (!parsed.hostname) return null;
  if (!hostMatchesPlatform(parsed.hostname, platform)) return null;
  return trimmed;
}

/** Race a promise against a timeout; null on timeout or rejection. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    });
    const result = await Promise.race([promise, timeout]);
    return result;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Strip HTML tags, collapse whitespace, trim, truncate. Non-strings and
 * empty results become null so callers can distinguish "absent".
 */
function sanitize(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const stripped = value
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  if (!stripped) return null;
  return stripped.length > maxLength
    ? stripped.slice(0, maxLength).trimEnd()
    : stripped;
}

/** Keep only https: URLs for thumbnails / author links; else null. */
function sanitizeExternalUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:") return null;
    return trimmed;
  } catch {
    return null;
  }
}

async function fetchJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (typeof data !== "object" || data === null) return null;
    return data as Record<string, unknown>;
  } catch {
    return null;
  }
}

function strField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" && v ? v : null;
}

async function youtubeOembed(userUrl: string): Promise<RawPreview | null> {
  const data = await fetchJson(
    `https://www.youtube.com/oembed?url=${encodeURIComponent(userUrl)}&format=json`,
  );
  if (!data) return null;
  return {
    title: strField(data, "title"),
    text: null,
    thumbnailUrl: strField(data, "thumbnail_url"),
    authorName: strField(data, "author_name"),
    authorUrl: strField(data, "author_url"),
  };
}

async function tiktokOembed(userUrl: string): Promise<RawPreview | null> {
  const data = await fetchJson(
    `https://www.tiktok.com/oembed?url=${encodeURIComponent(userUrl)}`,
  );
  if (!data) return null;
  return {
    title: strField(data, "title"),
    text: null,
    thumbnailUrl: strField(data, "thumbnail_url"),
    authorName: strField(data, "author_name"),
    authorUrl: strField(data, "author_url"),
  };
}

async function xOembed(userUrl: string): Promise<RawPreview | null> {
  const data = await fetchJson(
    `https://publish.twitter.com/oembed?url=${encodeURIComponent(userUrl)}`,
  );
  if (!data) return null;
  // X oEmbed carries no title/thumbnail — author + embedded html text only.
  const html = strField(data, "html");
  return {
    title: null,
    text: html,
    thumbnailUrl: null,
    authorName: strField(data, "author_name"),
    authorUrl: strField(data, "author_url"),
  };
}

async function instagramOembed(userUrl: string): Promise<RawPreview | null> {
  let token: string | undefined;
  try {
    token = Deno.env.get("INSTAGRAM_ACCESS_TOKEN") ?? undefined;
  } catch {
    token = undefined;
  }
  if (!token) return null; // Without a token, skip straight to fallback.
  const data = await fetchJson(
    `https://graph.facebook.com/v19.0/instagram_oembed?url=${encodeURIComponent(userUrl)}&access_token=${encodeURIComponent(token)}`,
  );
  if (!data) return null;
  return {
    title: strField(data, "title"),
    text: null,
    thumbnailUrl: strField(data, "thumbnail_url"),
    authorName: strField(data, "author_name"),
    authorUrl: strField(data, "author_url"),
  };
}

/** Extract a YouTube video id from watch?v=, youtu.be/, shorts/, live/, embed/. */
function extractYoutubeId(userUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(userUrl);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  let candidate: string | null = null;

  if (host === "youtu.be" || host.endsWith(".youtu.be")) {
    candidate = parsed.pathname.split("/").filter(Boolean)[0] ?? null;
  } else {
    const v = parsed.searchParams.get("v");
    if (v) {
      candidate = v;
    } else {
      const parts = parsed.pathname.split("/").filter(Boolean);
      // /shorts/<id>, /live/<id>, /embed/<id>, /v/<id>
      if (
        parts.length >= 2 &&
        (parts[0] === "shorts" ||
          parts[0] === "live" ||
          parts[0] === "embed" ||
          parts[0] === "v")
      ) {
        candidate = parts[1];
      }
    }
  }

  if (!candidate || !/^[A-Za-z0-9_-]{6,20}$/.test(candidate)) return null;
  return candidate;
}

async function youtubeDataApi(userUrl: string): Promise<RawPreview | null> {
  let apiKey: string | undefined;
  try {
    apiKey = Deno.env.get("YOUTUBE_API_KEY") ?? undefined;
  } catch {
    apiKey = undefined;
  }
  if (!apiKey) return null;
  const videoId = extractYoutubeId(userUrl);
  if (!videoId) return null;
  const data = await fetchJson(
    `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${encodeURIComponent(videoId)}&key=${encodeURIComponent(apiKey)}`,
  );
  if (!data) return null;
  const items = data["items"];
  if (!Array.isArray(items) || items.length === 0) return null;
  const first = items[0];
  if (typeof first !== "object" || first === null) return null;
  const snippet = (first as Record<string, unknown>)["snippet"];
  if (typeof snippet !== "object" || snippet === null) return null;
  const sn = snippet as Record<string, unknown>;
  let thumbnailUrl: string | null = null;
  const thumbnails = sn["thumbnails"];
  if (typeof thumbnails === "object" && thumbnails !== null) {
    const th = thumbnails as Record<string, unknown>;
    for (const key of ["maxres", "standard", "high", "medium", "default"]) {
      const entry = th[key];
      if (typeof entry === "object" && entry !== null) {
        const u = (entry as Record<string, unknown>)["url"];
        if (typeof u === "string" && u) {
          thumbnailUrl = u;
          break;
        }
      }
    }
  }
  return {
    title: strField(sn, "title"),
    text: strField(sn, "description"),
    thumbnailUrl,
    authorName: strField(sn, "channelTitle"),
    authorUrl: null,
  };
}

const PROVIDERS: Record<PlatformKind, (u: string) => Promise<RawPreview | null>> = {
  youtube: youtubeOembed, // public endpoint, no key required
  tiktok: tiktokOembed,
  x: xOembed,
  instagram: instagramOembed, // null unless INSTAGRAM_ACCESS_TOKEN is set
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function unavailable(status = 200): Response {
  return jsonResponse({ previewState: "unavailable" }, status);
}

Deno.serve(async (req: Request): Promise<Response> => {
  try {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (req.method !== "POST") {
      return unavailable(200);
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      // Only malformed JSON is a 400; everything else degrades to 200.
      return unavailable(400);
    }
    if (typeof body !== "object" || body === null) {
      return unavailable(200);
    }
    const { url, platform } = body as { url?: unknown; platform?: unknown };

    if (!isPlatform(platform)) {
      return unavailable(200);
    }
    const safeUrl = validateSubmissionUrl(url, platform);
    if (!safeUrl) {
      return unavailable(200);
    }

    // Tier 1: platform oEmbed. Tier 3: YouTube Data API fallback.
    let raw: RawPreview | null = await withTimeout(
      PROVIDERS[platform](safeUrl),
      PREVIEW_TIMEOUT_MS,
    );
    if (!raw && platform === "youtube") {
      raw = await withTimeout(youtubeDataApi(safeUrl), PREVIEW_TIMEOUT_MS);
    }

    if (
      !raw ||
      (!raw.thumbnailUrl && !raw.title && !raw.authorName && !raw.text)
    ) {
      return unavailable(200);
    }

    const title = sanitize(raw.title, 300);
    const caption = sanitize(raw.text, 1000);
    const authorName = sanitize(raw.authorName, 80);
    const thumbnailSource = sanitizeExternalUrl(raw.thumbnailUrl);
    const authorUrl = sanitizeExternalUrl(raw.authorUrl);

    // Resolved requires at least one meaningful field after sanitization.
    if (!title && !caption && !authorName && !thumbnailSource) {
      return unavailable(200);
    }

    const payload: Record<string, unknown> = {
      previewState: "resolved",
      title,
      caption,
      thumbnailSource,
      authorName,
      thumbnailPath: null,
    };
    if (authorUrl) {
      payload["authorUrl"] = authorUrl;
    }
    return jsonResponse(payload, 200);
  } catch {
    // Never throw: any unexpected failure is a graceful fallback.
    try {
      return unavailable(200);
    } catch {
      return new Response('{"previewState":"unavailable"}', {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  }
});
