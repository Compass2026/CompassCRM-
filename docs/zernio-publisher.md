# Zernio Social Publisher v1 (Facebook)

Approved Facebook posts are published by the existing `post-publisher`
through Zernio, Lucas Construction first. Compass decides what is posted,
where and when. Zernio is transport only.

- **Status (Oct 10 2026):** built, migration applied, function deployed, and
  Lucas bound.
- **Nothing is published:** the publisher switch is off, the pilot list is
  empty, and Lucas's Page has publishing off.
- **The first live post is Tom's step:** see [Final steps](#toms-final-steps).

## Routing

| Post | Path |
| --- | --- |
| `google_business` | The Google path, unchanged (0046). |
| `facebook`, with all of the following holding: the publisher is on, the client is on the pilot list, and the post's Page has a verified Zernio binding of the same client that is switched on | Zernio (`supabase/functions/post-publisher/facebook-path.ts`). |
| Any other `facebook` post, and Instagram / LinkedIn / X / TikTok | The "post this by hand" reminder, unchanged. |

## The binding

`social_accounts` gains an explicit, client-bound binding: `publish_provider`
(`zernio`), `publish_account_id` (the Zernio account), `publish_page_id`, the
account name, `publish_verified_at`, `publish_health` and `publish_enabled`.

- **It is never inferred.** The publisher does not search Zernio or pick an
  account at publish time.
- **Binding** (`zernio_bind`) runs only in the publisher's service session,
  through `publisher_bind_account`. It names one Compass account and one
  Zernio account, then re-reads that account with the publish key. All of
  these must hold:
  - the account is listed as Facebook, active, and does not need reconnection;
  - its selected Page and its Page list contain this row's
    `external_account_id`;
  - its health is not `error`, the token is valid and posting is granted.
- **Binding never enables publishing.** Binding a different Zernio account
  switches publishing off.
- **Enable, disable and unbind** are for a signed-in team admin only
  (`publisher_set_account_enabled` against the account id they saw, and
  `publisher_unbind_account`).
- **The worker's SQL cannot write any of it**, with or without the flag.
- **One Zernio account serves one Compass account.** The Page must equal the
  row's Page id, and a bound row keeps its Page id.
- **History:** `social_account_publish_events` is append-only and team-read.

## The publish gate

A Facebook post goes to Zernio only when every check below holds.

**Before the claim:**
- The client is piloted.
- The approved snapshot can be published on Facebook as it is:
  - it has copy;
  - it is a standard post;
  - it has no Business Profile button;
  - it names a Page;
  - it has at most one image, which is stored and hashed.
- The snapshot's Page passes `bindingProblems`: the same client, Facebook,
  bound, the binding's Page equals the row's Page, enabled, and not
  `error` health.
- The publish key is in Vault and is **not** the read key.
- The image's stored bytes re-hash to the hash the approval bound (sha256),
  and the image type is sniffed from the bytes (JPEG, PNG or WebP).

**At the claim (0045, unchanged):**
- The post is approved.
- The snapshot hash still matches.
- Grounding still holds.
- A refusal sends the post back to review (`lapsed`).

**What is sent:**
- Only `approved_snapshot`: the exact approved copy, the bound Zernio
  account, and `platformSpecificData.pageId` pinned to the Page.
- No caller can pass text.

Publish now and scheduled posts take the same path.

- **Compass holds the schedule.** The 5-minute tick claims a post when its
  time comes (re-checking the approval) and sends it with `publishNow: true`.
- **Zernio's scheduler is not used.** That way the approval and grounding
  check happens at send time.
- The preflight shows the time in America/Chicago.

## Never a second post

- **Idempotency key:** every create carries
  `Idempotency-Key: compass-<publish_key>-g<generation>`. `publish_key` is
  0045's per-approval key.
- **Write-ahead run:** an `uncertain` run is written *before* the create, so
  a run cut off mid-request is still seen as sent.
- **Choosing the key** (`planSend`):
  - Nothing sent yet: generation 1.
  - Zernio has a post for this generation: `GET /v1/posts/{id}` first. Send
    generation + 1 only if Zernio says that post failed or was cancelled.
  - A definite answer that created nothing (4xx / 429 / 5xx): generation + 1.
  - No definite answer (timeout, `idempotency_conflict`, cut off): send the
    same key with the same body and the same uploaded image URL
    (`provider_media_url`), so Zernio returns the original. This is allowed
    only inside 23 hours (Zernio's window is 24 hours). After that, a person
    looks (`publisher_check_post`).
- **409 duplicate** (`details.existingPostId`): the publisher reads that
  post. It is reconciled only when it is the exact copy on the same account;
  otherwise a person looks. It is never posted again.
- **207:** the platform entry decides, not the HTTP status.
  - `published` with an https URL → `published`.
  - `pending` / `processing` → `submitted`, and the tick reads it back.
  - `failed` → `failed`. A transient error category is retried on the shared
    10 / 30 / 120-minute backoff, as a new generation. `auth_expired` /
    `account_issue` open `publisher_reconnect_zernio`.
- **Recorded published** only from Zernio's Facebook entry with an https
  `platformPostUrl`:
  - `external_post_id` = `platformPostId`;
  - `published_url` = `platformPostUrl`;
  - `published_at` = its `publishedAt`.
- **Pending for over 24 hours** goes to a person.

## Zernio endpoints (the only ones)

`supabase/functions/post-publisher/zernio.ts`: an allowlist of method + path
pairs. Anything else is refused before fetch.

| Call | Use |
| --- | --- |
| `GET /v1/accounts?platform=facebook` | Verify / bind / preflight |
| `GET /v1/accounts/{id}/facebook-page` | The selected Page and the Page list |
| `GET /v1/accounts/{id}/health` | Token and posting permission |
| `GET /v1/posts/{id}` | Reconciliation |
| `POST /v1/media/presign` | The upload link for the one image |
| `PUT <uploadUrl>` | The image bytes (https only, never carries the key) |
| `POST /v1/posts` | The create (never without an Idempotency-Key) |

There is no delete, edit, unpublish, retry, account connection or webhook
call. Webhooks are a v1.1 item; v1 reconciles by polling every tick.

The image goes to Zernio's own temp media store, so Zernio can hand it to
Facebook. Compass storage stays private: no public URL or signed link is
handed out.

## Secret

| Secret | Notes |
| --- | --- |
| `ZERNIO_PUBLISH_API_KEY` | In Vault, read only by `post-publisher` through `get_secret`. Never returned, logged or put in a run, task or error (`scrub`). |
| `ZERNIO_READ_API_KEY` | Social History's key. Never used here; the publisher refuses to run if the two are the same. |

The app shows only whether the publish key is present (`secret_present`).

## Schema

Migration `20261010224407_zernio_publisher.sql`, applied Oct 10 2026 as
`20261010224407`. The recorded SQL matches the file by md5. It is additive:

- **`social_accounts` binding:**
  - the publish columns and three checks;
  - the unique index on `(publish_provider, publish_account_id)`;
  - the guard trigger.
- **`social_account_publish_events`:** RLS `is_team()` read, no API writes,
  append-only.
- **Binding functions:**
  - `publisher_bind_account` (service role only);
  - `publisher_set_account_enabled` and `publisher_unbind_account`
    (authenticated; admin checked inside).
- **`publisher_runs`** gains these columns, with checks: `transport`
  (`google` / `zernio` / `manual`; existing reminder runs → `manual`),
  `provider_post_id`, `provider_status`, `target_account_id`, `request_key`
  and `provider_media_url`. It also gains the outcome `submitted`.
- **`publisher_post_gate(post)`:** the claim's re-check, read without
  claiming. Service role only; used by the no-write preflight.
- **`post_assets_zz_brand_hash`:** a brand asset linked to a post carries its
  measured hash (0055). Without the hash a Facebook image is refused.

The app attaches the client's Facebook Page to a Facebook draft when the
client has exactly one Page.

## Function modes (post-publisher v2)

| Mode | Caller | Writes |
| --- | --- | --- |
| tick | cron | as before, plus the Facebook path |
| `now` | teammate | Publish now (Business Profile, or Facebook through Zernio) |
| `preflight` (`post_id` or `fixture`) | teammate or cron | none: no Compass row, no Zernio write |
| `zernio_accounts` | teammate or cron | none |
| `zernio_bind` | admin or cron | the binding only (never enables) |

## UI

- **Post page:**
  - shows the Facebook destination (the Page and the Zernio account) and why
    a post is not routed;
  - **Publish now** appears when the post is routed, and Mark published is
    then hidden except after a failure;
  - the run history shows the transport, the Zernio post id and its status;
  - a publishing post shows "waiting for Facebook's result".
- **Settings › Facebook through Zernio:**
  - shows the publish key's presence (never the key) and **Verify with
    Zernio**;
  - lists each client's Page with its binding, verification time and health;
  - admins can **Verify and bind**, **Switch publishing on / off** and
    **Remove binding**.

## Lucas state (Oct 10 2026)

- **The publish key** is readable server-side and distinct from the read key
  (`zernio_accounts`: `key.ok`, `distinct_from_read_key`).
- **The key sees one Facebook account:** `6ac6efe9621dc76465184742`
  "LUCAS Construction".
  - It is active.
  - Its selected Page is `103977857788955`, and that is its only Page.
  - Health is `healthy`, the token is valid and posting is granted.
- **Exact match:** Compass `social_accounts` `1ab8af8e-d720-47ed-8818-e0f2fa91a01e`
  (Lucas, Page `103977857788955`).
- **Bound** by `zernio_bind` at 2026-10-10 22:53 UTC (event `bound`, actor
  `publisher`).
- **`publish_enabled = false`.** Publisher switch off, pilot list empty.

## Preflight result (Lucas fixture, no writes)

**Fixture:**
- Sprint 03 #3 refined Facebook copy ("Quick one for anyone cleaning out
  gutters this fall. …"), exactly as written.
- The roof-edge photo (brand asset `8dfb59dd-…`,
  `102d3b20-…/scan/photo-1789337329451-11.jpg`).

**Passed:**
- platform Facebook;
- content publishable on Facebook as approved;
- the account belongs to the same client;
- a verified Zernio binding;
- the publish key is readable and distinct from the read key;
- the Zernio account is listed and active;
- Zernio posts to exactly Page `103977857788955`;
- healthy, with posting permission;
- the image bytes match the approved hash (`efad04c0…2074e`, 145,092 bytes,
  `image/jpeg`).

**Blocking, by design:**
- the publisher switch is off;
- Lucas is not on the pilot list;
- the account's publishing is not enabled.

The approval, hash and grounding checks do not apply to a fixture. They are
exercised by the real claim (tests below).

**Exact request:**
- `POST https://zernio.com/api/v1/posts`
- `Idempotency-Key: compass-<publish_key>-g1`
- the body is the exact copy, with
  `platforms: [{platform: "facebook", accountId: "6ac6efe9621dc76465184742", platformSpecificData: {pageId: "103977857788955"}}]`;
- one `mediaItems` image (the URL is the upload made at publish time);
- `publishNow: true`;
- steps: presign → PUT bytes (no key) → create.

**Timing:**
- Publish now → `publish_now`.
- `scheduled_at` 2026-10-14T14:00Z → "Oct 14, 2026, 9:00 AM CDT", sent by
  the tick that reaches it.

**Text-only fixture:** the same request without `mediaItems`.

**Nothing written:** `publisher_runs` 0, publisher tasks 0, no post changed,
and no Zernio write.

## Facebook drafts (Oct 11 2026; migration `20261011040705` applied, `post-drafter` v3)

Applied Oct 11 2026 as `20261011040705`: the recorded SQL and the
`drafter_write` body match the file by md5; grants unchanged (service_role
only).

The AI Drafter now writes Facebook drafts through the same governed path as
Business Profile drafts, so a Facebook post no longer has to be typed in by
hand to reach review. Nothing in it approves, schedules or publishes.

- **Target:** `{channel: "facebook", postType: "standard", ctaType: null,
  socialAccountId: <the client's Facebook Page row>, assetIds: [≤ 1]}`. The
  Page is named explicitly, never inferred; the brief carries it as
  `target.social_account` and `drafter_write` stores it on
  `social_posts.social_account_id`, so the approval snapshot binds it.
- **Refused** (brief and database): no Page, another client's Page, an
  Instagram account, a button, an offer post, two images, an image that is
  not a stored, hashed `photo` or `social_post` of the client, an Authority
  hand-off (Business Profile only). A Business Profile brief that names a
  social account is refused; Business Profile drafting is otherwise
  unchanged (same brief hash, same one-open-per-service-and-intent rule).
- **Fact rules are the drafter's:** the same brief, approved service and
  page, usable claims only, the same linter (no unapproved place,
  credential, tenure, pricing, response time, superlative, material or
  digit without its linked claim). Facebook adds its own channel rules: no
  hashtags, no URL in the copy, 200–1,200 characters.
- **One open draft per concept:** no two open drafted Facebook posts may
  share the same copy or the same image (`23505`). Several concepts for one
  service and intent may queue side by side.
- **The review gate is 0045's:** the post lands `in_review` /
  `not_scheduled` with a `CLAUDE_APPROVAL` `post_review` task; a teammate
  approves it, and only then can it be scheduled for the Zernio path above.
- **Generated graphics** are filed by `source-assets` v2: `upload_slot`
  returns a signed upload URL for `<client>/upload/<sha256>.<ext>` in the
  private `brand-assets` bucket (no row; an existing object is never
  overwritten), and `register` reads the object back, refuses bytes that do
  not hash to their address, inserts an unreviewed `social_post` brand asset
  whose notes record "<tool>-generated / non-evidentiary visual" and its
  source, and records the hash. A generated graphic is never a photo of the
  client's work, never a claim, source or E-E-A-T evidence; approving it for
  creative use stays a teammate's step on Brand › Creative use.
- **Tests:** `tests/post-drafter-facebook.test.mjs`, `tests/source-assets.test.mjs`,
  the sandbox's `drafter_facebook.test.sql`.

## Tests

- **Unit** (`npm test`, `tests/post-publisher-zernio.test.mjs`, 37 cases):
  - every case in the task;
  - plus the media hash, the image count, the key-equals-read-key check, the
    allowlist, and binding / verification.
- **Existing suites:**
  - `post-publisher-handler` (Google) passes unchanged;
  - `publisher-app` adds `zernioRoute` / `availableActions`;
  - `social-history-zernio`'s isolation guard now allows exactly the two
    clients.
- **Sandbox** (`npm run test:sandbox`, `zernio_publisher.test.sql`, 44
  checks), covering:
  - worker / flag / SET ROLE refusals;
  - the binding rules;
  - admin-only enable;
  - append-only history;
  - the gate read;
  - the brand-hash trigger;
  - the `publisher_runs` constraints;
  - the portal allowlist for the two admin functions.
- **PostgREST end to end** (`npm run test:publisher`, now 15): the real
  handler and store, with a fake Zernio.
  - The worker cannot bind.
  - `zernio_bind` binds without enabling.
  - The preflight writes nothing and sees a valid approval.
  - A teammate enables.
  - The approved copy is published as the publisher, with the live URL.
  - The hand reminder closes.
  - The post is never sent twice.
- **UI:** `npm run test:posts-ui` passes (16).

## Deployment order

1. Apply the migration (done; recorded `20261010224407`).
2. Deploy `post-publisher` v2 (done; all 8 files byte-identical to the repo).
3. Verify the key and accounts (`zernio_accounts`) and bind Lucas
   (`zernio_bind`); both done.
4. Merge the PR so the app (Settings card, post page, Publish now) deploys
   to Vercel.

## Tom's final steps

1. Approve one Lucas Facebook post in Compass (copy, Page and, optionally, one
   photo).
2. In Settings › Facebook through Zernio, **Switch publishing on** for Lucas's
   Page (an admin).
3. In Settings › Publisher, switch the publisher on with Lucas on the pilot
   list.
   - This also lets a scheduled Lucas **Business Profile** post go to
     Google.
   - Google is not connected, so such a post would be blocked with a
     `publisher_connect_google` task rather than sent.
4. On the post, run the preflight from the function, or simply press
   **Publish now**.

### STOP

**Nothing has been published.** The first live Facebook post happens only when
Tom does steps 2–4.
