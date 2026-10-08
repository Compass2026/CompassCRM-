# Social History / Client Social Style

**Status (Oct 8 2026):**

- The architecture was approved on Oct 7 2026; the decisions are recorded
  below.
- **SH1 is live for Lucas.**
  - Migration `20261008015642_social_history.sql` was applied Oct 8 2026 as
    `20261008015642`. The recorded SQL is identical to the file (md5
    `a8c3d1f0…`).
  - `social-history` v1 is deployed with `verify_jwt = true`.
  - Lucas's Facebook history is imported; see "SH1 production" below.
- SH2 (the Social Style Analyzer) is in progress. SH3 (drafter use) and SH4
  (Creative Engine use) do not exist.
- Pilot client: Lucas Construction (`102d3b20-2795-44ae-bd64-d1e43916291c`).

## SH1 production (Oct 8 2026)

**How it was called:** through the operator door (`x-cron-secret`, sent by
Postgres via pg_net, as every worker-callable Compass function is), because
no teammate session exists in the agent's environment. `requested_by` is
therefore NULL on both imports.

**Steps:**

1. `version`: 200, `key_present: true`, GET-only allowlist.
2. `plan`: 53 available, no blockers. Same profile, account and Page as the
   dry run.
3. `import` with limit 100: `completed`. 53 fetched, 53 inserted, 53
   snapshots, 0 skipped, 0 missing.
4. `import` again (the metrics refresh): `completed`. 53 unchanged, 0 new
   snapshots, because Zernio had not re-synced since 01:23:04 UTC.

**Binding:** one `social_accounts` row, Lucas / facebook / `103977857788955`
"LUCAS Construction", `manual_only`, no token. Both imports bound to Zernio
account `6ac6efe9621dc76465184742`.

**Posts:**

- 53 posts with 53 distinct Facebook ids (0 duplicates), Oct 11 2025 → Sep
  23 2026.
- All external: 0 Compass, 0 paid, 0 not authored by the Page, 0 missing.
- 34 reels, 17 photos, 1 album, 1 text; 3 without a caption.
- Every post has one snapshot. `saves` is NULL / unavailable on all of them.
  Reach and impressions are present on all.
- All 53 are learnable: Lucas has no Compass Facebook post to exclude.

**Isolation:**

- No function, view or trigger outside `social_history_*` reads the history.
- `client_intelligence_input(Lucas)` and Lucas's claims, services, keywords
  and posts are hash-identical to before. Offers 0; latest Authority run
  Sep 28.
- anon has no access, and the pg_net queue is empty.

**Difference from the dry run:** none in content. The count is 53 (not ~55),
and the metrics are the same snapshot the dry run saw.

## Approved decisions (Oct 7 2026)

1. A proposed Social Style Profile must be approved by a human teammate
   before the AI Drafter or the Creative Engine may use it.
2. Historical posts are style / performance evidence only. They never
   become factual grounding or usable claims; the existing Authority /
   Client Intelligence claim rules remain the only factual authority. A
   client's own past post is not, by itself, a source for a claim.
3. A same-platform recent-content duplicate guard with a 90-day window. It
   targets substantially similar copy, not topic repetition: a recurring
   service or topic is never blocked just because it was discussed recently.
   This arrives with SH3 (the drafter). The drafter writes Business Profile
   posts only today, and the imported history is Facebook, so a
   same-platform check has nothing to compare until a Facebook drafting
   channel exists.
4. A dedicated read-only Zernio key in Vault (`ZERNIO_READ_API_KEY`). It is
   never reused for publishing, and no write-capable Zernio credential is
   created.
5. The profile distinguishes representative posts, top performers relative
   to the client's own baseline, and excluded / do-not-learn posts.
6. Compass-generated content never feeds style learning.
7. Performance is measured against the client's own historical baseline,
   never generic engagement benchmarks.
8. Social History stays outside factual grounding: no history table is read
   by Client Intelligence or Authority evidence functions.

## SH1 as built (Oct 8 2026)

**Schema** (`supabase/migrations/20261008015642_social_history.sql`,
additive):

- **Tables:** `social_history_imports`, `social_history_posts` (natural key
  `(platform, platform_post_id)`) and `social_history_metrics` (append-only
  snapshots).
- **Views:** `social_history_post_latest`, and
  `social_history_learnable_posts`, the only input SH2's analyzer may read.
- **`social_accounts`** gets a partial unique index per external (Page) id.
- **Writers:**
  - `social_history_begin_import`, `_record_posts` and `_finish_import`,
    for the social-history function's session only (authenticator +
    service_role). A guard trigger refuses every other write, including
    the worker's SQL, SET ROLE and the write flag set by hand.
  - `social_history_set_learning`, for a signed-in teammate only: include or
    exclude a post, with a note to exclude.
- **Decided by the database, never by the caller:**
  - **Origin.** `compass` when the post matches a Compass `social_posts`
    row by platform id, published URL or (40+ characters) the same copy.
    It never reverts.
  - **The copy hash.**
  - **Snapshots.** A new one is recorded only when the provider's numbers
    changed.
- **Missing posts.** A complete listing that no longer returns a post sets
  `missing_since`; nothing is deleted.
- **The learnable view** excludes:
  - Compass posts, both stored and matched live, so a Compass post published
    after the import is excluded at once (decision 6);
  - paid posts (Zernio `isAd`);
  - posts the Page did not author (`isOwner = false`);
  - posts a teammate excluded;
  - posts missing from the platform.
- **The verify block** refuses the migration if any function or view
  outside the `social_history_*` family reads these tables, or if a
  Social History function writes a grounding table.
- **Rollback** is in the migration header.

**Function** (`supabase/functions/social-history/`, team JWT,
`verify_jwt = true`, on the deploy workflow's list):

- `zernio.ts`, the only Zernio client:
  - It sends GET only, with no body and no redirects.
  - Four allowlisted paths, each with its own allowlisted query names:
    `/v1/profiles`, `/v1/accounts`, `/v1/accounts/{id}/facebook-page` and
    `/v1/analytics`. Anything else throws before fetch.
  - The key travels only in the Authorization header and is scrubbed from
    every error.
  - A 429 with Retry-After of 20 s or less is retried once.
- `map.ts` holds the mapping rules:
  - Zernio's `likes` is stored as `reactions`.
  - `saves` is NULL (not a Facebook metric).
  - Zero reach and impressions next to real engagement are recorded as "not
    supplied" (NULL plus `unavailable`), never as 0.
  - Story clicks are NULL.
  - Pending analytics give no snapshot.
  - No media dimensions are recorded (Zernio has none).
  - A post without this account's entry, a platform id or a publish time is
    skipped with a reason.
- `handler.ts` modes:
  - `version`.
  - `plan` is the dry run and writes nothing. It returns what the key sees,
    the account and Page, and a sample of up to 25 posts (default 20) as
    Zernio returned them next to the row Compass would store. It also
    returns a field-quality report, the blockers, and the exact import
    request.
  - `import` is admin only. The request must repeat the plan's `account_id`
    and `page_id`, and Zernio must still agree. It imports the latest 1–100
    posts (default 100) over the last 365 days, in batches of 25, and
    finishes `completed` / `partial` / `failed`.
- Metric refresh is a re-run of `import`: unchanged posts are no-ops, and
  changed numbers append a snapshot. A scheduled refresh is not built.

**Tests:**

- `tests/social-history-zernio.test.mjs` proves the credential cannot write.
  The reader exposes only read methods. Every request the fake Zernio sees
  is a GET with no body. Every write path (publish, sync-external, connect,
  inbox, webhooks, keys, media) is refused before fetch. The function's
  sources name no other HTTP method. No other function or app file mentions
  Zernio or its key.
- `tests/social-history-map.test.mjs` and
  `tests/social-history-handler.test.mjs` cover the mapping and the handler.
  The plan writes nothing. A plan never picks one of several accounts. A
  Page recorded for another client is a blocker. The import is bound to the
  plan. Re-import is a no-op. Edits and metric changes are the only updates.
  An import ends partial or failed as it should.
- The sandbox's `social_history.test.sql` proves that history cannot become
  grounding:
  - no function, view or trigger outside the family, and no Client
    Intelligence / Authority / grounding / drafter function, reads history;
  - Client Intelligence's input, the Authority fingerprint and every claim,
    offer, service, keyword, post and post claim are identical before and
    after the imports;
  - only the function writes, and the teammate, portal, stranger and anon
    boundaries hold;
  - Compass posts never reach the learnable view.

**To the first Lucas import** (each step a person's go-ahead):

1. **In Zernio (Tom):**
   - Create a profile, "Compass – Lucas Construction".
   - Connect Lucas's Facebook Page to it with the analytics scope only
     (`scopes=analytics`) and select the Page.
   - Create an API key: `permission: read`, `scope: profiles` (that profile
     only), the engagement, messages, contacts, ads, telephony, billing and
     webhooks groups disabled, and an expiry.
2. **In Supabase (Tom):** add the key to Vault as `ZERNIO_READ_API_KEY`
   (Dashboard › Vault). Never paste it into a chat or the repository.
3. **Apply and deploy:**
   - Apply the migration: a rolled-back dry run first, then for real,
     verified by md5.
   - Deploy `social-history`.
   - Check `{"mode": "version"}` reports `key_present: true`.
4. **The dry run:** `{"mode": "plan", "client_id": "<Lucas>"}` returns a
   20-post sample. Read the field quality together.
5. **If the fields look right:** send the plan's `import_request` (50–100
   posts), then spot-check 10 posts against Facebook.

## Lucas dry run (Oct 8 2026; nothing imported, applied or deployed)

**How it ran:** the real `plan` handler, replayed over Zernio responses that
Postgres fetched through pg_net with `get_secret('ZERNIO_READ_API_KEY')`.
The key never left the database. The responses were checked by md5 against
`net._http_response`.

**Result:** 200, no blockers, four GETs, zero writes.

**Profile and Page:**

- Profile **Compass - Lucas Construction**: the only one the key sees.
- Account `6ac6efe9621dc76465184742`, Page `103977857788955` (LUCAS
  Construction, 1,835 followers).

**The key:**

- Restricted (`zrk_`; key management refused with 403
  `insufficient_permissions`) and profile-scoped.
- `read` vs `read-write` is not visible to a restricted key; Tom confirms it
  in the dashboard.
- The Zernio connection itself holds `pages_manage_posts`,
  `pages_messaging` and ads permissions. The Facebook token expires
  2026-11-27.

**Posts:**

- 53 posts, Oct 11 2025 → Sep 23 2026 (Zernio keeps ~12 months; the year
  before returns 0).
- All external and owned by the Page. 0 stories, 0 paid, 0 Compass posts.
- All metrics synced in one snapshot at 2026-10-08 01:23:04 UTC.
- 34 reels, 17 photos, 1 album, 1 text; 3 without a caption. None filtered
  by SH1.

**Not returned by Zernio:**

- media width / height and alt text;
- the reaction breakdown (`likes` = all reactions);
- `saves` (always 0);
- `views` on non-video posts (0, not applicable). Open decision: store NULL.

**Fixed with tests:**

- `platformUserId` arrives as `<user>:page:<page>` (`pageIdOf`).
- The bare `lastUpdated` timestamp is read as UTC.

The full report and the 20-post table were delivered in the session, not
committed: they hold client copy.

## Purpose and boundaries

Social History is a read-only intelligence layer. It learns how a client
naturally communicates on social from the client's real published posts, and
which formats have historically performed. Its output is **style and
performance guidance only**.

| Layer | Owns | Never owns |
| --- | --- | --- |
| Authority Engine | What topics matter; which service, page, keyword and intent a post supports; which content opportunities deserve to exist; what evidence the analysis prefers | Voice or format |
| Client Intelligence | Factual grounding: claims (`confirmed`, or `sourced` with a source), offers, approved services, CRM facts | Style |
| **Social History** | How the client writes; formats and visual styles they use; cadence; which categories and formats performed | Topics a post must cover, facts, evidence, publishing |
| AI Drafter / Creative Engine | Producing a draft or graphic inside all of the above | Deciding any of the above |

Zernio is an **ingestion provider only**. It is never a source of truth for
content strategy, it never decides anything, and Compass never publishes,
schedules, messages or changes an account through it. Publishing is
unchanged: the Business Profile publisher (0046) and manual publication
(0045) are the only paths.

## 1. What already exists and can be reused

Inspected Oct 7 2026 (repository at `main` plus read-only queries on
production).

| Object | What it is | Reuse for Social History? |
| --- | --- | --- |
| `social_accounts` (0001; composite key `(id, client_id)` from 0045) | One row per client and platform: `platform`, `external_account_id`, `display_name`, `access_token`, `status` (`connected` / `expired` / `manual_only`). **0 rows in production.** | **Yes, as the account identity.** Lucas's Facebook Page becomes one row (`platform = facebook`, `external_account_id` = the Page id, `status = manual_only`). `access_token` stays NULL: the Zernio key is never stored in a column. |
| `social_posts` (0001, rebuilt by 0045) | The governed record of every Compass-drafted or hand-written post: review gate, grounding, approval hash, publish state, `post_claims`, `post_assets`, `post_events`. Production: 4 rows, all `google_business` (Lucas). | **No, not for history.** Every row is a post that went through, or is waiting for, Compass's review and grounding. Imported history has no claims, no approval and no intent, and the 0045 triggers would refuse it or force a fake approval. Putting history here would also put it within reach of the publisher, the review tasks, Authority's "recent posts" and the drafter's duplicate check without any of those having been designed for it. The only link is a nullable pointer from a history row to the Compass post it turns out to be (matched by `external_post_id`). |
| `content_posts` (0001, `origin` from 0050) | Blog / site content. | No (different channel). |
| `report_measurements` (0041) | The append-only nine-area scorecard ledger. Social metrics (`social_posts`, `social_reach`, `social_engagements`, `social_clicks`, `social_followers`) are **monthly aggregates per platform**, recorded by hand. None are recorded in production. | **Not as storage.** It holds aggregates with a person's evidence line, not per-post data. Later, a monthly social row could be *derived* from Social History and appended by a person or the Reporting worker, with Social History named as the source. Out of scope for the first deliverable. |
| `brand_assets` + creative-use governance (0009, 0054, 0055) | The governed source-image library (hash, own-work flag, focal point, subjects, review). Lucas: 15 assets, all hashed. | **Not for historical media.** A historical post's image is not a brand asset. If a teammate wants one, it goes through the existing `brand-scan` import mode and arrives `unreviewed`, then through Creative use like any other file. |
| `claims`, `offers`, `services` (0010, 0044) | The facts posts may stand on. Lucas: 9 `sourced`, 4 `unverified`. | Read-only, by the analyzer, to tell **which historical statements are already covered by a usable claim** and which are not. Social History never writes them. |
| `client_brands` / brand board (`hard_rules`, `words_we_avoid`, `ai_guidance`) and the Creative Engine kits (`kits.ts`: `LUCAS.blocked_phrases`) | Brand rules. | Read-only, as the "do not learn" filter (section 8). |
| `post-drafter/rules.ts` `DETECTORS`, `MATERIAL_RE`, `NUMBER_RE` | The drafter's deterministic fact detectors (reviews, address, pricing, tenure, response time, credential / warranty, diagnosis, …). | **Yes, imported as-is** by the analyzer to mark factual spans in historical copy. One definition of "a factual assertion" for drafting and for learning. |
| `post-drafter/authority.ts` `duplicateProblems` (shingles, same opening) | The `duplicate_recent_post` lint. | **Yes.** The same function runs against same-channel history (section 6). |
| Run / ledger pattern: `rank_runs`, `authority_runs`, `billing_reconciliation_runs`, `drafter_runs` | One row per run, a claim that refuses a second concurrent run, counts, failure reason. | **Yes, the pattern** for import runs. |
| Edge Function pattern: `handler.ts` factory over an injected store and fetch, `index.ts` wiring, `version` mode, team JWT or `x-cron-secret`, 202 + `EdgeRuntime.waitUntil` | Every function since site-push v9. | **Yes.** |
| Write boundary pattern (0045, 0047, 0054, 0063): tables written only by named security-definer functions inside the function's service session; team read-only; worker SQL refused | | **Yes**, at a lighter weight (section 4). |
| Vault + `get_secret()`; `secret_present()` for yes / no status | | **Yes** for the key, with the caveat in section 3. |

**Conclusion:** no existing table can hold imported posts or their metrics
without breaking a rule it already enforces. `social_accounts` is the only
table to reuse as is. Everything else needed is new, and small.

### Two constraints the rest of this design respects

- **Do not extend `client_intelligence_input()` or `authority_input()`.**
  Authority fingerprints the Intelligence document, so a new field there
  marks every Authority run stale (the reason 0056 kept the Canva folders
  out). Social History gets its own read model, as Canva did.
- **The AI Drafter is Business Profile only today** (`DRAFT_CHANNELS =
  ["google_business"]`), and its prompt forbids emoji, hashtags and links.
  Lucas's history will be Facebook. Until a Facebook drafting channel
  exists, only the channel-neutral parts of a Facebook-derived profile may
  reach a Business Profile draft (section 6).

## 2. New tables and fields

Four new tables. Nothing is added to an existing table except one partial
unique index on `social_accounts`.

### 2.1 `social_history_imports`: one row per import run

| Column | Notes |
| --- | --- |
| `id` uuid PK, `client_id`, `social_account_id` | `(social_account_id, client_id)` composite FK, as in 0045 |
| `provider` text | `'zernio'` (check list; future `'meta'`, `'csv'`) |
| `mode` text | `plan` (dry run, never stored), `import`, `refresh_metrics` |
| `status` text | `running` → `completed` / `partial` / `failed` |
| `requested_by` uuid → `team_members` | NULL for a scheduled run |
| `started_at`, `finished_at` | |
| `window_from`, `window_to`, `limit_requested` | What was asked for, e.g. latest 100 |
| `provider_sync` jsonb | The provider's index state as read (`syncStatus` / `lastUpdated` counts); Compass never starts a provider sync |
| `fetched`, `inserted`, `updated`, `unchanged`, `metrics_captured`, `skipped` int | |
| `error` text | Required when `failed` |

A partial unique index allows one `running` import per account. A run left
`running` for 30 minutes is failed by the next begin, as in `authority_runs`.

### 2.2 `social_history_posts`: the canonical imported post

| Column | Notes |
| --- | --- |
| `id` uuid PK, `client_id`, `social_account_id` | Composite FKs; `unique (id, client_id)` |
| `platform` `social_platform` | `facebook` for the pilot |
| `platform_post_id` text NOT NULL | Facebook's id (`<page>_<post>`). **`unique (platform, platform_post_id)`** is the natural key that makes re-import a no-op |
| `provider`, `provider_post_id` | `'zernio'` and Zernio's own id, kept so a refresh can address the post |
| `origin` text | `external` (published directly on the platform), `provider_scheduled` (published through Zernio by someone else), `compass` (matches a `social_posts` row) |
| `compass_post_id` uuid NULL | `(compass_post_id, client_id)` → `social_posts`, set when `social_posts.external_post_id` matches. Lets the analyzer separate the client's own voice from Compass's output (section 5) |
| `permalink` text | https only |
| `published_at` timestamptz NOT NULL | |
| `copy` text, `copy_hash` text | sha256 of the normalised copy; an edit on the platform changes it |
| `format` text | `text`, `photo`, `album`, `video`, `reel`, `link`, `share`, `event`, `other` (from the provider's media type) |
| `media` jsonb | Array of `{type, url, thumbnail_url, width, height, duration_s, alt}`, metadata and links only. **No bytes are downloaded or stored** in v1 |
| `is_shared_content` bool | A re-share of another page's post: excluded from voice learning |
| `first_imported_at`, `last_seen_at`, `last_import_id` | |
| `missing_since` timestamptz NULL | Set when a full re-listing no longer returns the post. A row is never deleted by a sync |
| `learning_status` text | `included` (default), `excluded`. Set by a teammate with `learning_note` (e.g. "hiring post", "shared from supplier", "contains an old promotion") |
| `raw` jsonb | The provider's post object, trimmed to known fields, for audit. Never tokens; never comment text |

**Comment text, commenter names and DMs are never imported.** Only counts.

### 2.3 `social_history_metrics`: append-only metric snapshots

Engagement keeps growing after a post goes up, so a single overwritten
number cannot be compared fairly across posts of different ages.

| Column | Notes |
| --- | --- |
| `id` bigint identity, `post_id`, `client_id`, `import_id` | |
| `captured_at` timestamptz | |
| `age_hours` int | `captured_at - published_at`, stored for the analyzer's age rule |
| `reactions`, `likes`, `comments`, `shares`, `clicks`, `impressions`, `reach`, `video_views`, `saves` bigint NULL | NULL = not provided. **0 is a real zero, NULL is unknown**, never conflated |
| `reaction_breakdown` jsonb NULL | When the provider gives one |
| `unavailable` text[] | Metrics the provider said it cannot supply for this post or account (e.g. reach without Page insights permission) |
| `raw` jsonb | |

A view `social_history_post_latest` gives each post's newest snapshot.

### 2.4 `client_social_style_profiles`: the derived profile

Immutable, versioned, and proposed by the analyzer for a person to review.
Structure in section 5.

| Column | Notes |
| --- | --- |
| `id`, `client_id`, `platform`, `version` int | `unique (client_id, platform, version)` |
| `analyzer_version` text | e.g. `social-style-v1` |
| `input_fingerprint` text | sha256 over the included posts' `(id, copy_hash)` and the metric snapshot ids used. Re-running on unchanged data produces the same fingerprint and no new version |
| `window_from`, `window_to`, `posts_considered`, `posts_included` | |
| `profile` jsonb | The profile document |
| `status` text | `proposed` → `approved` → `superseded`, or `rejected` |
| `reviewed_by`, `reviewed_at`, `review_note` | A teammate through PostgREST only, as in 0045 (`session_user = 'authenticator'`, role `authenticated`, on `team_members`) |
| `created_at` | |

A partial unique index allows one `approved` profile per client and
platform. Approving a new version supersedes the old one in the same
transaction.

**Why a person approves it:** the profile becomes input to AI drafting.
Every other input of that kind (the brand board, services, claims, Authority
decisions) is a person's decision, and the "do not learn" list (section 8)
is exactly where a teammate's judgement matters. Approval is a read of one
page, not a workflow.

### 2.5 Access and write boundary

- RLS on all four tables with the single `(select is_team())` policy;
  `anon` none; `authenticated` select only.
- Imports, posts and metrics are written **only** by
  `social_history_begin_import`, `social_history_record_posts`
  (batch upsert by natural key) and `social_history_finish_import`. They are
  security definer with `search_path = public, pg_temp`, revoked from
  `public, anon, authenticated`, executable by `service_role`, and refuse
  any session other than the function's (the 0054 pattern). The worker's
  SQL cannot write history: that is what stops an agent session from
  "importing" text that was never published.
- Profiles are written only by `social_style_record_profile` (the
  analyzer, service session; always `proposed`) and reviewed only by
  `social_style_review` (a teammate).
- A teammate may set `learning_status` / `learning_note` on a post through
  a narrow function. They cannot edit imported copy, timestamps or metrics.
- No `portal_*` view references any of it.
- `social_accounts` gains a partial unique index
  `(client_id, platform, external_account_id) where external_account_id is
  not null`.

## 3. Zernio read-only integration contract

Based on Zernio's public documentation only (docs.zernio.com and its
OpenAPI spec v1.240.0, read Oct 7 2026). No account, key or authenticated
call was used. Zernio is the rebrand of Late (getlate.dev): the SDK still
accepts `LATE_API_KEY`, and the `source` value `late` means "posted through
Zernio". Every point marked **verify** is checked by the `plan` dry run
before anything is stored.

**Zernio's model.** A *profile* groups a client's connected *accounts*. One
`facebook` account is one Page, identified by Zernio's 24-character
`accountId`. Compass uses one Zernio profile per client: "Compass – Lucas
Construction" holds only Lucas's Facebook Page.

**The key** (`Authorization: Bearer …`, base `https://zernio.com/api/v1`):

- `permission: "read"`, which Zernio defines as GET requests only;
- `scope: "profiles"` with `profileIds = [<Lucas profile>]`;
- `disabledResourceGroups`: `engagement`, `messages`, `contacts`, `ads`,
  `telephony`, `billing`, `webhooks`;
- an expiry (`expiresIn`, e.g. 365 days). Rotation means creating a new key
  and deleting the old one, because Zernio has no key update.
- **Verify:** the docs suggest that the post listings sit in the
  "publishing" resource group. If so, disabling that group would block the
  reads we need, so `publishing`, `analytics` and `accounts` stay enabled,
  and `permission: read` is what makes them read-only. `plan` confirms that
  a GET in each group we use succeeds. Our client never sends anything but
  GET, so it never observes the refusal Zernio would give for a write.

**What Compass calls: GET only, enforced in code.** `zernio.ts` exposes
nothing but `get(path, query)`. Its path allowlist (unit-tested; any other
method or path throws before a request is made):

| Call | Use |
| --- | --- |
| `GET /v1/profiles`, `GET /v1/accounts?profileId=` | `plan`: which profiles and accounts the key sees; match the Page |
| `GET /v1/accounts/{id}/facebook-page` | `plan`: confirm the selected Page id equals `social_accounts.external_account_id` |
| `GET /v1/analytics?accountId=&source=all&fromDate=&page=&limit=100` | **The import listing.** Content, permalink, `publishedAt`, `mediaType`, `mediaItems[]`, `thumbnailUrl`, `latePostId`, metrics, `syncStatus`, `lastUpdated`, in one paged call. `fromDate` = 12 months back (Zernio's maximum range is 366 days; its default is 90) |
| `GET /v1/posts?source=external&accountId=&page=&limit=` | Fallback / cross-check listing of Zernio's external-post index |
| `GET /v1/analytics/delta?cursor=` | `refresh_metrics` after the first import: changed snapshots only (a rolling 7-day log, so the weekly refresh must run within 6 days or fall back to the full listing) |
| `GET /v1/accounts/{id}/facebook-post-reactions?postId=` | Optional, one call per post: the reaction breakdown. Off in SH1 |

**Never called, and absent from the client:** everything under `POST`,
`PUT`, `PATCH` and `DELETE`. That covers publish, edit, unpublish, retry and
bulk upload; **`/posts/sync-external`** (a POST, see below); `/connect/*`
and Page selection; account and profile changes; inbox comments, messages,
broadcasts and review replies; webhooks settings; API keys; ads; Business
Profile writes; queue; and media upload.

**Historical posts without a write.** Zernio indexes posts published
directly on the platform in two ways. When the account is first connected,
it backfills every existing native post. After that, a background sync runs
about every 90 minutes. History is kept for "up to the last ~12 months per
account". The on-demand `POST /posts/sync-external` is a write in Zernio's
terms, so the read-only key cannot call it, and it is not needed. The
import reads what Zernio has already indexed and records each item's
`syncStatus` / `lastUpdated`.
**Verify** how deep the first Facebook backfill went (the docs only say
"every existing native post" and ~12 months). For Lucas the target is the
latest 50–100 posts, which should fall inside that window.

**Origin flag.** The analytics listing reports `isExternal: true` even on
posts scheduled through Zernio. The importer uses `latePostId` instead:
non-null → `provider_scheduled`, null → `external`. It then matches
`social_posts.external_post_id` for `compass`.

**Metrics for Facebook.** Zernio's post analytics include impressions,
reach, likes, comments, shares, saves, clicks and views. Notes:

- On Facebook, `likes` is the **aggregate reaction count**. A per-type
  breakdown costs one extra call per post.
- Reach and impressions need Meta's `read_insights`, which Zernio requests
  only when the Page is connected with the analytics area
  (`scopes=analytics`).
- Values are cached for about 60 minutes. A single-post read can answer 202
  (sync pending) or 424.
- Page-level insights cover at most 89 days, and Meta retired
  `page_impressions` / `page_fans` on Nov 15 2025. Page followers are out
  of scope for SH1.
- Anything missing is recorded in `unavailable`, never as 0.

**Media.** Zernio returns `mediaItems[] {type, url, thumbnail, altText}`
and `thumbnailUrl`, and **no width or height**. In v1 the profile's
orientation is therefore `null`, never guessed. Meta images are re-hosted
and cached by Zernio, but Meta video URLs are signed and expire. Compass
stores the links as metadata and downloads no bytes, so an expired link is
expected and harmless.

**Limits and cost.** 60 requests a minute for accounts with 0–2 connected
accounts. Analytics endpoints use a per-second window of max(6, per-minute
÷ 60). Responses carry `X-RateLimit-*` headers, and a 429 carries
`Retry-After`, which the client honours (one wait, then the run ends
`partial`). A 100-post import is one or two listing pages. Pricing: the
first two connected accounts are free; legacy plans answer 402
`analytics_addon_required`.

**Webhooks: not in SH1.** `post.external.*` and `analytics.synced` exist,
but creating a subscription is a write that needs the webhooks group and a
public endpoint. Polling the delta feed weekly is enough for style data.

**What the Zernio connection itself can do.** The key is read-only, but the
Facebook connection Zernio holds is not: connecting a Page through Zernio's
OAuth always requests `pages_messaging` and `pages_manage_metadata`, and
the default connect also requests `pages_manage_posts`. Mitigations:

- connect with `scopes=analytics` only;
- connect inside a Zernio profile that contains nothing else;
- never create a full-access key or a "Connected App" (Zernio's OAuth apps
  are documented as full account access);
- restrict the Zernio login to the owner;
- Tom accepts this residual risk explicitly before connecting, because it
  sits with Zernio and Meta, not Compass.

**Secret storage.** `ZERNIO_READ_API_KEY` in Vault, read only through
`get_secret()` by `social-history`. The billing decision barred *live
Stripe* secrets from the shared Vault because every Edge Function can read
it. A key that can only GET one profile's posts and analytics carries far
less risk, so Vault is proposed for this key only. If `plan` shows the key
can do anything but GET (it should not), the key is deleted, and this
choice comes back for review. Nothing logs the key or returns it, and
`secret_present()` gives the page yes / no only.

## 4. Sync / import flow

New Edge Function **`social-history`** (`handler.ts` factory; `zernio.ts`
read-only client; `map.ts` pure mapping; `store.ts`; later `analyze.ts`).
`verify_jwt = true`. Callers: a team JWT (admin for `import`, any teammate
for `plan` / `version`), or `x-cron-secret` for the scheduled metrics
refresh once one is approved.

**Modes**

- `version`: function version, analyzer version, the GET allowlist, and
  whether the key is present (yes / no only).
- `plan` (dry run, writes nothing): the profiles and accounts the key can
  see; the account that would be used for the client, matched to
  `social_accounts.external_account_id`; the index's `syncStatus` /
  `lastUpdated`; the number of posts the first page would return and the
  oldest `publishedAt` available; and, for a sample of five posts, which
  fields arrived and which metrics are missing. This is how we confirm the
  API's real shape for Lucas **before** anything is stored. It also confirms
  the key's reach: one allowed GET in each resource group we use succeeds,
  and only the expected profile is visible.
- `import {client_id, platform: "facebook", limit: 100}`: the first import.
- `refresh_metrics {client_id}`: new metric snapshots only, for posts
  published in the last 90 days.

**`import`, step by step**

1. Check the teammate and the client (not offboarded); resolve the client's
   `social_accounts` row (created by hand for Lucas before the first
   import: the Page id, display name, `manual_only`).
2. `social_history_begin_import` (refuses a second running import; 202 with
   the run id; the rest runs in `EdgeRuntime.waitUntil`).
3. Resolve the Zernio account for that Page id. Refuse (`account_mismatch`)
   if the key sees zero, or more than one, account for it. Never pick one.
4. No sync is requested. The read-only key cannot call Zernio's on-demand
   sync, so the import reads what Zernio's backfill and its 90-minute
   background sync have already indexed, and it records each item's
   `syncStatus` / `lastUpdated` in `provider_sync`.
5. List the account's posts through `GET /v1/analytics` (section 3), newest
   first, page by page, until `limit` (100) or the end of the list. The first
   import targets 50–100 posts; there is no back-fill beyond what the
   provider returns (about 12 months).
6. Map each post (pure, unit-tested): platform id, permalink, published
   time, copy, format, media metadata, `origin`. Then match
   `social_posts.external_post_id` to set `compass_post_id` / `origin =
   compass`.
7. The same listing carries each post's metrics. Record one snapshot per
   post with `age_hours`. A post whose analytics are still pending (202) is
   stored with no snapshot and picked up by the next refresh.
8. `social_history_record_posts` in batches of 25: insert new posts, update
   `copy` / `copy_hash` / `media` / `last_seen_at` on existing ones (an
   edited post keeps its id; the profile fingerprint changes), and append
   the metric snapshots.
9. `social_history_finish_import` with counts. Posts missing from a complete
   listing get `missing_since`; nothing is deleted.

**Failure rules (same as the other functions):** a provider 429 / 5xx /
timeout ends the run `partial` or `failed` with the provider's message; 401 /
403 is `failed` with "key rejected or out of scope" and opens one TOM task
(`social_history_access`); any non-GET call is impossible by construction
(section 3). A rerun is always safe because every write is keyed on
`(platform, platform_post_id)`.

**Schedule:** none for the pilot. After the pilot, an optional weekly
`refresh_metrics` (pg_cron, off until a person switches it on in
`app_settings.social_history`), because engagement settles within about two
weeks and only recent posts change.

**Analysis** is a separate mode (`analyze {client_id, platform}`) that reads
only the stored tables and records a `proposed` profile (section 5). It
never calls Zernio, so the profile can be rebuilt and diffed without network
access.

## 5. Social Style Profile structure

The analyzer is deterministic TypeScript (`analyze.ts`, pure, like the
Authority Engine): the same stored posts and snapshots always give the same
profile and fingerprint. Category labels come from a fixed lexicon and media
metadata in v1. A model may later **suggest** a category or a visual tag per
post. Suggestions are stored apart and shown as suggestions, never counted
until a teammate accepts them (the `creative_suggestions` rule from 0054).

**Distributions, not averages.** Every numeric trait is given as a
distribution (p10 / p25 / median / p75 / p90, or bucket shares), split by
format where the formats differ.

**The client's own voice.** Posts with `origin = compass`,
`is_shared_content` or `learning_status = excluded` are left out of every
voice and style statistic. Compass-originated posts are still counted in
performance and cadence, labelled as such, so the drafter does not learn
from its own output.

```jsonc
{
  "schema": "compass-social-style/1",
  "analyzer_version": "social-style-v1",
  "platform": "facebook",
  "window": { "from": "2025-04-02", "to": "2026-10-01", "posts_considered": 100, "posts_included": 87 },
  "exclusions": { "compass_origin": 0, "shared": 6, "excluded_by_team": 3, "no_copy": 4 },

  "length": {
    "chars": { "p10": 40, "p25": 90, "median": 180, "p75": 320, "p90": 600 },
    "by_format": { "photo": { "median": 150 }, "album": { "median": 260 }, "video": { "median": 90 } },
    "buckets": { "one_liner": 0.22, "short": 0.41, "medium": 0.27, "long": 0.10 }
  },
  "openings": [
    // Recurring opening patterns, each with share and post ids (never invented text)
    { "pattern": "project_reveal", "label": "Another one done / Finished up…", "share": 0.24, "example_post_ids": ["…", "…"] },
    { "pattern": "location_lead", "label": "Starts with the town", "share": 0.18, "example_post_ids": ["…"] },
    { "pattern": "question", "share": 0.07, "example_post_ids": ["…"] }
  ],
  "sentences": { "words_per_sentence": { "median": 9, "p90": 18 }, "exclamation_share": 0.31, "question_share": 0.08,
                 "person": { "we": 0.62, "i": 0.04, "you": 0.21, "third_person": 0.13 } },
  "tone_markers": ["plain", "proud of finished work", "neighbourly"],  // from a fixed vocabulary, each with evidence counts
  "emoji": { "posts_with_any": 0.45, "per_post_median_when_used": 2, "top": ["🏠", "🔨", "👍"], "position": { "end": 0.7, "inline": 0.3 } },
  "hashtags": { "posts_with_any": 0.12, "per_post_median_when_used": 3, "top": ["#roofing", "#wentzville"] },
  "cta": {
    "posts_with_cta": 0.38,
    "styles": [ { "style": "call_us", "share": 0.20 }, { "style": "message_us", "share": 0.11 }, { "style": "link_to_site", "share": 0.07 } ],
    "phrases": [ { "text": "Give us a call", "count": 9 } ]   // verbatim, counted, already filtered by section 8
  },
  "places": { "posts_naming_a_place": 0.34,
              "approved": [ { "place": "Wentzville", "count": 11 } ],
              "unapproved": [ { "place": "Chesterfield", "count": 4 } ] },   // reported, never learned (section 8)
  "categories": {
    // Fixed taxonomy; a post may carry up to two
    "mix": { "project_showcase": 0.46, "before_after": 0.14, "team": 0.08, "community": 0.06,
             "educational": 0.09, "promotional": 0.07, "seasonal": 0.05, "hiring": 0.03, "review_or_testimonial": 0.02 },
    "by_format": { "project_showcase": { "album": 0.6, "photo": 0.35, "video": 0.05 } }
  },
  "visual": {
    "formats": { "photo": 0.48, "album": 0.33, "video": 0.11, "text": 0.05, "link": 0.03 },
    "album_size": { "median": 4, "p90": 10 },
    "orientation": null,          // Zernio returns no media dimensions; null, never guessed
    "graphic_vs_photo": null,     // unknown in v1 (needs image analysis); stays null, never guessed
    "notes": ["Real job-site photography dominates; designed graphics are rare."]   // generated from the numbers above only
  },
  "cadence": {
    "posts_per_week": { "median": 1.5, "p90": 4 },
    "longest_gap_days": 41,
    "weekday_share": { "mon": 0.1, "tue": 0.2, "wed": 0.18, "thu": 0.2, "fri": 0.17, "sat": 0.1, "sun": 0.05 },
    "hour_local_share": { "morning": 0.3, "midday": 0.25, "afternoon": 0.3, "evening": 0.15 }
  },
  "performance": {
    "metric_basis": "engagements = reactions + comments + shares (reach unavailable: Page insights not provided)",
    "age_rule": "snapshot nearest 7 days after publishing; posts younger than 7 days excluded",
    "baseline": "rolling median of the 20 previous posts",
    "by_category": [ { "category": "before_after", "posts": 12, "median_lift": 1.8 }, { "category": "team", "posts": 7, "median_lift": 1.3 } ],
    "by_format": [ { "format": "album", "posts": 29, "median_lift": 1.4 } ],
    "small_sample": ["review_or_testimonial", "hiring"],   // < 5 posts: reported, not ranked
    "confidence": "low"   // low / medium / high from post count and metric coverage
  },
  "top_performers": [
    // At most 8: highest lift, at least 2 categories represented, no two from the same week
    { "post_id": "…", "permalink": "…", "published_at": "…", "category": "before_after", "format": "album", "lift": 3.2,
      "copy_masked": "Before and after on this one in Wentzville… [fact removed: warranty]", "facts_masked": ["credential"] }
  ],
  "representative": [
    // 1–2 per major category: the posts closest to that category's typical length, opening, emoji and CTA profile
    { "post_id": "…", "category": "project_showcase", "why": "median length, location lead, 1 emoji, call CTA", "copy_masked": "…" }
  ],
  "do_not_learn": [ /* section 8 */ ],
  "transfer": {
    // Which traits may reach a draft on another channel (section 6)
    "channel_neutral": ["openings", "sentences", "tone_markers", "cta.styles", "places.approved", "categories"],
    "same_channel_only": ["length", "emoji", "hashtags", "visual", "cadence"]
  }
}
```

**Examples are kept, not averaged away:** at most 8 top performers and up to
2 representative posts per major category (so no more than about 20 in all).
Every example is stored by post id with its **masked** copy (section 8). The
full copy stays only in `social_history_posts`.

**Performance is relative and age-fair.** v1 ranks on engagements at about
7 days of age against the client's own rolling baseline, within a format.
It does not use raw totals (a page's audience grows) or a mix of snapshot
ages. Reach-based rates are used only when reach is present for at least 80%
of the posts compared. A category with fewer than 5 posts is reported but
not ranked, and the profile states its confidence.

## 6. How the AI Drafter consumes it

- **A separate read.** `client_social_style(p_client_id, p_platform)`
  (invoker rights, team + service role) returns the **approved** profile:
  id, version, fingerprint, and the profile without unmasked copy. The
  drafter's `store.ts` loads it next to `client_intelligence_input()`, which
  is unchanged, so the Authority fingerprint is untouched.
- **A new brief section, `brief.style`** (`DrafterInput` gains a `style`
  section in `DRAFTER_INPUT_FIELDS`, so SQL, field list and type stay
  pinned): `{profile_id, version, source_platform, applies: "same_channel" |
  "channel_neutral_only", traits, examples}`. It is part of the brief hash,
  so an approved new version makes an in-flight brief stale, and
  `drafter_runs` records `style_profile_id` for provenance.
- **Precedence, written into the prompt and enforced by the linter:**
  Compass channel rules (e.g. GBP: no emoji, hashtags or links; 300–900
  characters) > brand hard rules and words to avoid > the Authority target
  and allowed facts > the style profile. Style can shape *how* the post
  says what the brief allows. It can never add a fact, a place, a topic or a
  CTA type.
- **Cross-channel transfer.** Today's channel is the Business Profile, and
  Lucas's history is Facebook. A Facebook profile therefore contributes only
  `transfer.channel_neutral` traits to a Business Profile draft (openings,
  sentence rhythm, person, tone markers, CTA style, approved-place habit).
  Length, emoji, hashtags and visual traits apply only once the drafter
  writes Facebook posts, and then only to Facebook.
- **Examples in the prompt:** two or three masked examples (one top
  performer and one or two representative posts of the target's category),
  introduced as *"How this client sounds. These show voice and shape only;
  they are not facts and nothing in them may be repeated as a fact."*
- **Lint.** Style mismatches are **warnings only** (`style_length_atypical`,
  `style_opening_atypical`, `style_cta_atypical`); they never block. One
  rule blocks: `duplicate_recent_post` also runs, unchanged, against the
  same platform's imported history for the last 90 days, so a draft cannot
  repeat something the client already posted. Every existing fact rule is
  unchanged and source-agnostic, which is the main guarantee in section 8.
- **No profile, no change.** Without an approved profile the brief carries
  `style: null` and the drafter behaves exactly as today.

## 7. How the Creative Engine consumes it

The Creative Engine's guarantees stay as they are: words come only from
governed references, photos only from approved brand assets, renders are
deterministic, and nothing falls back. Social History influences
**selection**, never the rendered bytes.

- **Family preference.** `visual.formats`, `categories.by_format` and
  `performance.by_category` map to the five cleared families (e.g. strong
  before / after and project albums → prefer **Real Work Showcase**;
  educational posts performing → **Trust & Know-How**). This appears as a
  ranked recommendation on Creative previews and in the `post` mode's
  plan. It never registers, approves or changes a template.
- **Text density.** If the client is photo-first with little overlay text,
  the recommendation favours families with fewer text slots. Governed word
  limits still decide what fits.
- **Photo choice among already-approved assets.** When several approved
  own-work photos of the service qualify, prefer the subjects and
  orientation that historically performed (e.g. a finished roof over a crew
  shot; orientation only once dimensions are available). The candidate set is unchanged; only the order is affected.
- **Provenance, not determinism.** `creative_runs` records
  `style_profile_id`. The spec hash and output bytes never depend on the
  profile; a profile only changes which template or photo is requested,
  and that request is what gets recorded.
- **Historical images are not sources.** A historical post's photo or
  thumbnail can only be used after a teammate imports it through
  `brand-scan` import mode and approves it in Creative use (hash, own-work,
  focal point, subjects).
- **No new families from history.** If the history shows a style no
  cleared family covers (e.g. text-heavy graphics), the profile reports it.
  A new family is a design decision made through the existing registry
  review.

## 8. Keeping unsupported historical claims out of grounding

Historical posts are style data. They never become evidence automatically.
Five layers enforce that:

1. **No code path from history to grounding.** `claims`, `offers`,
   `post_claims`, `social_post_grounding_problems`, `usableClaims`,
   `client_intelligence_input` and `authority_input` never read a
   `social_history_*` or `client_social_style_*` object. A sandbox test
   fails if any function body or view definition in those groups mentions
   them (the 0037 verify-block technique).
2. **The linter does not care where a fact came from.** The drafter's
   linter already refuses every factual assertion that is not a CRM fact
   or the verbatim text of a linked usable claim. A warranty, a year, a
   price or an unapproved town copied from an old post fails exactly as an
   invented one does. Nothing in Social History weakens that.
3. **Facts are masked before examples leave the database read model.** The
   analyzer runs the drafter's own `DETECTORS`, `MATERIAL_RE` and
   `NUMBER_RE`, the gazetteer place check, the brand's `words_we_avoid` /
   hard rules and the kit's `blocked_phrases` over every example. Each
   factual span becomes `[fact removed: <category>]` unless it is the
   verbatim text of a currently usable claim, a CRM fact or an approved
   place. An example that is more than about a third masked is not used as
   an example at all. CTA phrases and openings are filtered the same way
   before they are counted.
4. **`do_not_learn` is explicit, and a teammate reads it before
   approving.** Every pattern the analyzer refused to learn, with counts
   and post ids, for example for Lucas:
   - warranty language ("lifetime workmanship warranty"): owner
     confirmation pending (kit `blocked_phrases`);
   - "free inspection": inspections are not an approved service;
   - unapproved markets (Chesterfield, Ballwin, St. Louis County …);
   - "locally owned", "family owned", tenure and "since" statements;
   - prices, discounts and expired promotions;
   - review counts, star ratings and testimonials;
   - diagnosis language ("needs a new roof");
   - anything conflicting with the brand board's hard rules.

   Each item says *why* (the rule it conflicts with) and what would make it
   usable: the normal Client Intelligence path. The claim is added,
   confirmed with the client, or sourced, then approved.
5. **A historical post is not a source.** A client's own past post may
   *prompt* a teammate to create a claim, but the post's URL alone does not
   make that claim `sourced`. The client confirms it (`confirmed`), or it
   cites an independent source. Claim *candidates* from history may be
   listed on the review page as suggestions; nothing is ever inserted into
   `claims` by Social History.

Authority stays the owner of topics. `performance.by_category` and
`top_performers` are never fed into `authority_input`. A future Content
Planner may *order* opportunities Authority already marks Ready by
historical format performance. It may not create an opportunity, revive a
dismissed one or change an intent.

## 9. The smallest first coding deliverable

**SH1: canonical store and read-only importer, dry run first. No analysis,
no consumers, no UI beyond a count.**

1. Migration (additive): the three history tables (`social_history_imports`,
   `social_history_posts`, `social_history_metrics`), the latest-snapshot
   view, the three recording functions, the `learning_status` setter, the
   `social_accounts` partial unique index, RLS / grants / service-session
   guard, and a verify block. `client_social_style_profiles` waits for SH2.
2. `supabase/functions/social-history/`: `zernio.ts` (the GET-only
   allowlisted client), `map.ts` (pure provider → canonical mapping),
   `handler.ts` (`version`, `plan`, `import`), `store.ts`, `index.ts`.
3. Tests: `npm test` (the mapper over recorded fixtures; the client refuses
   every non-GET method and non-allowlisted path; the handler over a fake
   Zernio, including re-import as a no-op, an edited post, a missing post,
   a 429 mid-run and an ambiguous account); the sandbox's
   `social_history.test.sql` (worker SQL, service role outside the
   function, a non-team sign-in, anon and a portal contact all refused;
   `(platform, platform_post_id)` uniqueness; the grounding-isolation
   check from section 8.1).
4. Pilot sequence, each step a person's go-ahead:
   (a) Tom creates the read-only key in Zernio, scoped as narrowly as
   section 3 allows, and stores it in Vault;
   (b) `plan` for Lucas, read with Tom (which fields arrive, which metrics
   are missing);
   (c) the Lucas `social_accounts` row;
   (d) `import` latest 100;
   (e) spot-check 10 posts against Facebook.

**SH2:** `analyze.ts`, `client_social_style_profiles`, the review page
(Social › History: profile, examples, `do_not_learn`, Approve / Reject).
**SH3:** drafter `brief.style` and the warnings. **SH4:** Creative Engine
family and photo ordering.

The questions this review raised were answered on Oct 7 2026: see
"Approved decisions" at the top. The architecture sections above (1–9) are
kept as reviewed. Where SH1 differs, "SH1 as built" is authoritative:

- no `refresh_metrics` mode (re-run the import instead);
- the dry run is a 20-post sample;
- SH3's duplicate guard targets substantially similar copy, not topics.
