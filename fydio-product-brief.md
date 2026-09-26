# Fydio | Curated Feeds

## Product brief

### Product summary

Fydio is a private, interest-led discovery web app for creators and their trusted circles. It creates curated feeds from public Instagram, TikTok, YouTube, and X content shared by members. Instead of promising engagement or asking members to perform actions, Fydio helps people discover relevant work, open it in its original context, and exchange useful feedback.

**Tagline:** Curated Feeds

**One-line promise:** Discover relevant content from people you trust—and give feedback that helps them improve.

### Problem

Creators want their work seen by relevant peers, but mainstream social feeds are noisy, unpredictable, and optimized for platform-level engagement. Small creator communities often default to chat groups and spreadsheets, which make discovery, feedback, and reciprocity difficult to organize.

### Solution

Fydio turns a private creator community into a lightweight discovery network:

- Members publish public content links with three hashtags.
- Hashtags operate as content pools and interest signals.
- Each member has a focused profile with exactly five hashtags, plus a short text and image profile.
- The home feed ranks shared content by profile relevance, recency, friend affinity, and variety.
- Clicking an item opens the original post in a new tab or, on mobile, the relevant native app when available.
- Members can leave structured, optional feedback after viewing content.
- Creators review received feedback and award a 1–10 quality rating that contributes to the feedback giver’s reputation.
- A separate, spendable credit balance keeps content submission fair without turning reputation into a currency.

Fydio is a discovery and feedback layer. It does not automate, require, or reward third-party likes, follows, shares, votes, comments, or viewing behavior.

## Audience and first use case

**Initial audience:** A private group of 20–30 friends who create or share content across Instagram, TikTok, YouTube, and X.

**Primary job to be done:** “Help me regularly discover posts that are relevant to me or made by people I know, then make it simple to give useful feedback.”

## Core experience

### 1. Onboarding and profile

Each user creates a profile containing:

- Display name, avatar, and short bio.
- Up to five profile hashtags; five is the hard maximum.
- Optional connected public creator handles/URLs.
- Optional friend connections, created by a mutual connection request.

Profile hashtags describe both subject expertise and interests. They are the primary matching signal for the home feed.

### 2. Credits and submission access

Fydio uses two deliberately separate community signals:

| System | Purpose | How it changes | Can it be spent? |
| --- | --- | --- | --- |
| **Fydio Credits** | Fair access to submit content to the shared feed | Earned through eligible peer-feedback contributions; spent to submit content | Yes |
| **Feedback Reputation** | A signal of how useful a member’s feedback has been | Increases when creators rate a feedback item from 1–10 | No |

Do **not** call both systems “points.” It makes a quality signal feel like money and makes the product harder to understand. The interface may shorten *Fydio Credits* to **Credits** and *Feedback Reputation* to **Reputation**.

Every member receives a small weekly starter-credit allowance so a new or quiet member can participate. Publishing an entry costs one Credit. An entry’s unused submission Credit is not refundable after it enters the feed.

Members earn a Credit by leaving an eligible feedback item on another creator’s content. An eligible item must meet minimum community-quality requirements, be connected to an entry they opened, and not be reported or removed. Credits are never awarded for external-platform viewing time, likes, follows, shares, comments, or votes.

The initial MVP rule set:

- One Credit is required to publish one content entry.
- One eligible feedback item earns one Credit, subject to per-day and per-creator caps.
- A member cannot earn a Credit for feedback on their own content or content from a blocked account.
- Reputation ratings do not change the Credit amount in the MVP; they remain a quality signal only.
- Admins can grant, reverse, or cap Credits for abuse handling and onboarding.

This design creates a fair contribution loop: creators who ask the community for attention are also encouraged to contribute thoughtful feedback, while reputation rewards quality independently of volume.

### 3. Add content

A user spends one Fydio Credit to submit a public post URL from Instagram, TikTok, YouTube, or X.

Required fields:

- Original content URL.
- Exactly three hashtags, selected from existing tags or created within community rules.

Optional fields:

- A short creator note: context, question, or the type of feedback desired.
- Cover image/thumbnail when a platform preview is unavailable.

Fydio stores a preview and metadata only where permitted. The original platform remains the source of the content and the destination for viewing.

### 4. Curated home feed

The home page is a scrollable feed of content entries. Every entry displays creator identity, platform, thumbnail/preview, title or caption excerpt, hashtags, and any creator feedback prompt.

Initial ranking model:

`relevance = tag_match + friend_affinity + freshness + feedback_need + diversity_adjustment`

- **Tag match:** overlap between the content’s three hashtags and the viewer’s five profile hashtags.
- **Friend affinity:** a transparent, limited boost for confirmed friends.
- **Freshness:** newer content gets a gradual boost that decays over time.
- **Feedback need:** entries requesting feedback can receive a modest boost.
- **Diversity adjustment:** prevents one creator, platform, or tag pool from dominating the feed.

Users can tune their feed with “more like this,” “less like this,” mute creator, and hide item controls. These signals affect only Fydio’s recommendations.

### 5. Open original content

Selecting an entry opens the original post in a new browser tab on desktop. On mobile, the operating system may open the relevant native platform app.

Fydio records an **outbound click event** and marks the entry as *opened* for that member. An opened state is a personal feed-history signal, not proof of viewing or engagement.

### 6. Optional browser companion

The Fydio browser extension is optional and opt-in. Its purpose is to help the member return to Fydio and offer a feedback prompt after they leave a supported public content page.

With explicit permission, the extension may report:

- that the user navigated to the URL that Fydio opened;
- the active-tab duration in a coarse time band (for example: under 15 seconds, 15–60 seconds, 1–3 minutes, over 3 minutes);
- whether the user returned to Fydio from the destination.

It must not read private messages, collect credentials, inspect unrelated browsing activity, replay user actions, automate platform actions, or attempt to bypass platform safeguards. Duration data is private to the viewer by default and is used for their own history and Fydio recommendations—not as a reward, completion requirement, or public score.

For mobile-app handoffs, Fydio does not attempt to track on-platform behavior. The member can return to Fydio and add feedback manually.

### 7. Feedback

Feedback is voluntary and attached to a content entry. A feedback item contains:

- A text note.
- Up to three attached images.
- Optional structured tags such as *hook*, *clarity*, *editing*, *storytelling*, *thumbnail*, *CTA*, or *audience fit*.

The creator can view all received feedback on the entry and from their profile dashboard. The feedback giver can edit or remove their feedback until it is rated or after a short grace period.

### 8. Reputation

After reviewing feedback, the content owner rates its usefulness from **1 to 10**. The score adds to the feedback giver’s reputation total.

Reputation should represent helpfulness, not popularity. It is non-transferable and cannot be spent to publish content. The profile displays:

- Reputation total.
- Number of rated feedback items.
- Average received feedback rating.
- Optional badges at meaningful thresholds.

To prevent score farming:

- only a content owner can rate feedback on their own entry;
- each feedback item may be rated once;
- self-feedback and duplicate-account activity are blocked;
- ratings can be revised within a short window;
- moderation can remove abusive feedback and reverse reputation changes;
- public rankings should be avoided in the MVP.

### 9. Credit safeguards

Credit controls are required because the submission economy is only useful if contributors cannot cheaply game it:

- Cap eligible feedback Credits per day and per creator.
- Require a minimum text length or an attached annotation/image before feedback is eligible.
- Do not award Credits for duplicate feedback, self-feedback, or feedback on the same entry more than once.
- Hold newly earned Credits for a short review window; reverse them if feedback is removed for abuse.
- Apply rate limits to content submission, especially for new members.
- Keep Credit balances private in the MVP. Show reputation publicly, with an explanation of what it represents.

## MVP scope

### Include

- Invite-only authentication and private community access.
- Profiles with avatar, bio, and a five-hashtag maximum.
- Content submission for Instagram, TikTok, YouTube, and X URLs, with exactly three hashtags.
- Feed ranking by tag overlap, friends, freshness, and diversity.
- External link opening and opened-state history.
- Optional feedback with text and up to three images.
- Creator feedback inbox and 1–10 feedback ratings.
- Separate Fydio Credits for submission access and Feedback Reputation for feedback quality.
- Credit ledger, starter-credit allowance, contribution caps, reputation totals, and basic anti-abuse controls.
- Admin controls for users, content, tags, reports, and moderation.
- Optional Chrome extension with explicit consent and coarse active-tab duration tracking.

### Exclude from MVP

- Third-party account login or credential collection.
- Automated views, likes, follows, shares, comments, or votes.
- Credits tied to social-platform actions, viewing time, likes, follows, shares, comments, or votes.
- Guaranteed reach, views, or engagement.
- Full mobile apps; launch as a responsive web app, with mobile web support.
- Complex recommendation AI. Use deterministic ranking first.

## Key product principles

1. **Human choice first.** Discovery is curated; every third-party interaction is voluntary.
2. **Useful feedback over vanity metrics.** Reputation rewards helpful critique; Credits reward eligible contribution, never likes or viewing time.
3. **Private by default.** The community is invite-only; browsing-duration telemetry is opt-in and private.
4. **Transparent ranking.** Show members why an item appears: shared hashtag, friend connection, or freshness.
5. **Platform-respectful.** Fydio sends people to the original content and does not automate social-platform behavior.

## Success metrics

For the first 30-member community, measure:

- Weekly active members.
- Content submissions per active member.
- Feed open rate.
- Feedback items per opened entry.
- Credits earned through eligible feedback and Credits spent on content submissions.
- Percentage of feedback rated by creators.
- Average rated feedback score.
- Seven- and 28-day retention.
- Distribution fairness: percentage of active creators receiving at least one feed open or feedback item.

Do not use external likes, views, followers, shares, or watch time as product success metrics.

## Suggested implementation

- **Web app:** Next.js, TypeScript, Tailwind CSS.
- **Backend:** Supabase Auth, Postgres, Storage, and Edge Functions.
- **Browser companion:** Chrome Manifest V3 extension communicating only with Fydio’s authenticated API.
- **Content previews:** oEmbed or permitted public metadata where supported; graceful fallback to link cards.
- **Hosting:** Vercel plus Supabase.

Core entities: `users`, `profiles`, `hashtags`, `profile_hashtags`, `friendships`, `content_entries`, `content_hashtags`, `feed_impressions`, `outbound_clicks`, `duration_events`, `feedback`, `feedback_ratings`, `reputation_ledger`, `credit_ledger`, `credit_eligibility_reviews`, and `moderation_reports`.

## Future opportunities

- Topic-specific private circles.
- Feedback templates by content type.
- Creator requests such as “Which hook is stronger?”
- Personal feedback-quality portfolio.
- Weekly curated digest of friends’ and topic-matched content.
- Mobile app after web retention and feedback quality are proven.

## Positioning

**Fydio is not an engagement pod.**

Fydio is a private, creator-led discovery and feedback network: curated feeds from people and topics that matter to you.
