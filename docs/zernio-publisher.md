# Zernio Social Publisher (Facebook v1, Business Profile)

Approved Facebook and Google Business Profile posts are published by the
existing `post-publisher` through Zernio, Lucas Construction first. Compass
decides what is posted, where and when. Zernio is transport only.

- **Facebook (Oct 10 2026):** built, migration applied, function deployed and
  Lucas bound. The publisher, the Lucas pilot and Lucas's Page are switched
  on, and the first Lucas Facebook post has been published.
- **Business Profile through Zernio (Oct 11 2026):** built and tested on a
  branch. Not yet applied, deployed or bound; see
  [Business Profile through Zernio](#business-profile-through-zernio). It
  replaces the direct Google path for a client only once that client has a
  bound location.

## Routing

| Post | Path |
| --- | --- |
| `google_business`, when its approved snapshot names a location or its client's Business Profile transport is `zernio` | Zernio only (`gbp-path.ts`); refused there when anything is missing, never sent to Google. See [Business Profile through Zernio](#business-profile-through-zernio). |
| Any other `google_business` | The direct Google path, unchanged (0046). |
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

## Business Profile through Zernio

Tom authorized the switch on Oct 10 2026 ("use Zernio for GBP"), while the
direct Google path's quota follow-up continues separately (My Business Account
Management requests/minute = 0 in project 308261457231; Google case
9-0457000041837). Nothing here needs that quota or Google OAuth.

### Route: exactly one publisher per post

`gbp.ts gbpRoute`, applied by the handler and shown on the post page:

| Business Profile post | Publisher |
| --- | --- |
| The approved snapshot names a location (`social_account_id` of a `google_business` row) | Zernio only |
| The client's transport is `zernio` (even if this post names none) | Zernio only; a post approved without a bound location is refused with a fix task |
| Otherwise | The direct Google path, unchanged |

**The client's transport is an explicit, durable choice**
(`publisher_client_transports`, history in `publisher_client_transport_events`):
- binding a location selects `zernio`, recorded as the publisher;
- **removing the binding does not change it**. The client's Business
  Profile posts stop (refused with a reason) instead of silently going back
  to Google;
- only a signed-in team admin returns a client to `google`
  (`publisher_set_gbp_transport`, Settings › **Return to direct Google**), and
  only once no location is bound;
- the worker's SQL cannot write either table, flag or not.

- A Zernio-routed post is **never** handed to the direct Google path: not when
  the publisher, the pilot list or the location's switch is off, not when the
  location is unhealthy or unbound, and not after an ambiguous result.
- The direct path's stuck and retry sweeps skip Zernio-routed posts, and the
  Zernio sweep skips direct ones.
- **An earlier direct-Google attempt without a settled answer** (`uncertain` or
  `ambiguous` Google run) blocks the Zernio send until a person checks the
  profile, so a post that may already be on Google is not posted twice.
- **The destination is part of the approval.** `social_post_snapshot`
  includes `social_account_id`, so naming the location on an already approved
  post means Reopen → Save draft (Compass names the client's bound location)
  → Submit → Approve. Nothing rewrites an approval.
- **The destination is stable in flight.** Every Zernio run records the
  account and location it was pinned to (`target_account_id`,
  `target_location_id`). A binding changed under an in-flight post goes to a
  person (`targetDrift`); it is never re-targeted. With the binding removed,
  a post Zernio already accepted is still read back at the recorded
  destination (GET only).
- **A re-send passes every write gate again** (Facebook and Business Profile
  alike). A request without a definite answer is re-sent with the same key
  only after the sweep re-checks:
  - the binding: same client and platform, bound, switched on, healthy;
  - the approved content;
  - no unsettled attempt by another transport;
  - the approval hash and grounding (`publisher_post_gate`).

  A closed gate sends nothing and records the block once. The post stays
  `publishing` with its key, body and image link on record, and goes out
  with the same key once the gate opens (inside Zernio's window). Reading
  back an accepted post is always allowed.

### The binding

The client's `social_accounts` row for `google_business`:
- `external_account_id` = `publish_page_id` = the Google location resource
  `locations/<id>`;
- `publish_account_id` = the Zernio `googlebusiness` account id.

Rules:
- **One bound location per client** (unique index): no multi-location fan-out,
  and a client's transport is unambiguous.
- **Recorded and bound only by the publisher** (`zernio_gbp_bind` →
  `publisher_bind_gbp_location`, service session only). It names one client,
  one Zernio account and one location, after re-reading with the publish key:
  - the account is listed as `googlebusiness`, active, not needing
    reconnection;
  - the location is in the account's `GET /v1/accounts/{id}/gmb-locations`;
  - health is not `error`, the token is valid, posting is not refused.
- **No name-only binding.** The accounts report shows each location's name,
  address and website and a same-website hint per client; the binding is the
  admin's explicit choice of ids.
- **Binding never enables.** A team admin switches it on
  (`publisher_set_account_enabled`) or removes it, as for Facebook. The
  history is the same append-only `social_account_publish_events`.
- Lucas's Facebook-only Zernio account (`6ac6efe9621dc76465184742`) can never
  be a Business Profile target: one Zernio account serves one Compass row,
  only a `googlebusiness` account binds a location, and a post's location must
  be a `google_business` row of the same client.

### The publish gate (Business Profile)

**Before the claim:**
- The client is piloted, and the publisher is on.
- The approved snapshot can go as approved (`gbpProblems`):
  - copy of at most 1,500 characters, exactly as approved;
  - a standard post. Offer and event posts are refused explicitly (not sent
    without their fields);
  - a button only if Zernio can carry it as approved: `LEARN_MORE`, `BOOK`,
    `ORDER`, `SHOP`, `SIGN_UP` with an https link. A Call button is refused,
    because Zernio's button needs a link;
  - a named location;
  - at most one photo, stored and hashed.
- The location passes `gbpBindingProblems`:
  - the same client and `google_business`;
  - bound to a Zernio account;
  - the binding's location equals the row's;
  - switched on and not `error` health.
- No unsettled direct-Google attempt.
- The publish key is in Vault and is not the read key.
- The photo's stored bytes re-hash to the approved sha256, then:
  - the type is sniffed (JPEG or PNG only);
  - it is at most 5 MB;
  - it is at least 400 × 300, read from the bytes.
  Nothing is converted or compressed.

**At the claim (0045, unchanged):** approval, snapshot hash and grounding are
re-checked; a refusal sends the post back to review.

**What is sent:**
```
POST https://zernio.com/api/v1/posts
Idempotency-Key: compass-<publish_key>-g<n>
{ "content": <approved copy, unchanged>,
  "platforms": [{ "platform": "googlebusiness", "accountId": <bound account>,
                  "platformSpecificData": { "locationId": "locations/<id>", "topicType": "STANDARD",
                                            "callToAction": { "type", "url" } (only when approved) } }],
  "mediaItems": [{ "type": "image", "url": <Zernio upload of the approved bytes> }] (only with a photo),
  "publishNow": true }
```

Publish now and Compass-held schedules take the same path.

**Never a second post:** the same machinery as Facebook (`zernio-path.ts`,
shared):
- the Idempotency-Key (24-hour window, confirmed in Zernio's OpenAPI spec:
  a same-key retry returns the original post with HTTP 200, whatever the
  body);
- the write-ahead `uncertain` run;
- `GET /v1/posts/{id}` before any re-send;
- a 409 duplicate is reconciled only when it is the exact copy on the same
  account **and the same echoed location**;
- on a 207, the `googlebusiness` entry for exactly this account and location
  decides (`platformSpecificData` is echoed back per the spec).

**Recorded published** only from that entry with an https `platformPostUrl`:
- `external_post_id` = the Google post id (`platformPostId`);
- `published_url` = `platformPostUrl`;
- `published_at` = its time.

### Endpoints added to the allowlist

| Call | Use |
| --- | --- |
| `GET /v1/accounts?platform=googlebusiness` | Verify / bind / preflight |
| `GET /v1/accounts/{id}/gmb-locations` (`limit`) | The account's locations and its default |

Nothing else was added: no location switching (`PUT …/gmb-locations`), no
connect, edit, delete or webhook call.

### Function modes added

| Mode | Caller | Writes |
| --- | --- | --- |
| `zernio_gbp_accounts` | teammate or cron | none |
| `zernio_gbp_bind` `{client_id, zernio_account_id, location_id}` | admin or cron | the binding only (never enables) |
| `preflight` `{post_id}` on a Business Profile post | teammate or cron | none |

### Schema

Migration `20261011050000_zernio_gbp_publisher.sql` (additive):
- the binding check also allows `google_business` with `locations/<id>`;
- `social_accounts_one_gbp_binding`, a unique index (one bound location per
  client);
- `publisher_bind_account` accepts `google_business` rows (Facebook unchanged);
- `publisher_bind_gbp_location` (service role only);
- `publisher_runs.target_location_id` (Zernio runs only).
- `publisher_client_transports` and `publisher_client_transport_events`
  (team read; written only through `publisher_bind_gbp_location` and
  `publisher_set_gbp_transport`, both guarded by session).

### UI

- **Post page (Business Profile):**
  - the route: Zernio with the exact location and account and its switch, or
    "directly to Google";
  - why a post is not sent yet;
  - **Check without sending** (the no-write preflight through the function);
  - the pinned location on each run.
- **Settings › Business Profile through Zernio:**
  - **Verify Business Profile locations** (read only);
  - one row per piloted client;
  - for admins: **Verify and bind**, **Switch publishing on / off** and
    **Remove binding**.
- The draft form names the client's bound location when the draft is saved.

### Tests

- `tests/post-publisher-gbp.test.mjs` (35 cases, including the review's
  `REVIEW:` regressions): payload and exact target,
  photo limits, unsupported fields, approval and media mismatch, cross-client
  and Facebook-account refusal, switch gates with no direct fallback, the
  route, an unsettled Google attempt, sweep separation, timeout / 409 / 207
  reconciliation, in-flight drift, retries, verification, binding, preflight
  and secrets.
- `supabase/tests/sandbox/zernio_gbp.test.sql` (41 checks).
- `npm run test:publisher`: 18, including Business Profile end to end through
  PostgREST and the unbind case.
- `npm run test:posts-ui`: 25, including the draft destination, the post page
  route and preflight through the real function, and Settings.
- The Facebook suites pass unchanged.

### Deployment order

1. Merge the PR after review. It deploys the app to Vercel; Business Profile
   routing stays inert until a location is bound.
2. Apply `20261011050000_zernio_gbp_publisher.sql` to production
   (`iokcopiyzajigvhwexhe`).
3. Deploy `post-publisher` from this branch: `handler.ts`, `zernio-path.ts`,
   `facebook-path.ts`, `facebook.ts`, `gbp-path.ts`, `gbp.ts`, `zernio.ts`,
   `store.ts`, `channel.ts`, `google.ts`, `index.ts`.
   - Until a location is bound, every Business Profile post keeps the direct
     path.
   - Facebook behaviour is unchanged.

### Lucas readiness and the steps to the first Business Profile post

Not verified live yet: this session holds no credential that may call the
publisher's read modes. A teammate's click or the operator door does that
after step 3.
- Lucas has no `google_business` row in Compass today.
- GBP post `aca2b919-3993-445d-b520-cc529cd3da6f` is approved with no location
  named (approved before locations existed).
- Its photo `8dfb59dd-…` is a stored 950 × 1200 JPEG of 145,092 bytes; the
  link hash equals the approved hash (`efad04c0…2074e`). It meets the
  Business Profile limits.
- The static rule check on its snapshot finds only "names no location".

Steps:
1. **Settings › Business Profile through Zernio › Verify Business Profile
   locations.**
   - If no `googlebusiness` account is listed, connect Lucas's Google Business
     Profile in Zernio, in the same Zernio profile the publish key is scoped
     to, then verify again.
   - Check the listed location: name, address, website lucasconstructionmo.com.
2. **An admin: Verify and bind** Lucas with that Zernio account id and
   location id. Then **Switch publishing on**.
3. **On `aca2b919`:**
   - Reopen (clears approval) → Save draft. The Account line shows the
     location.
   - Submit → Tom approves. The copy and photo are unchanged.
4. **Check without sending** on the post. Every gate should pass.
5. **STOP.** The live Business Profile post is Tom's: Publish now, or a
   schedule. Do not publish the other approved posts in bulk.
