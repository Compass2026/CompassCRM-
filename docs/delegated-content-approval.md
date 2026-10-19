# Delegated content approval and publication

Tom reviews content and makes the decision. Once he has decided, he can tell
ChatGPT or Claude, for example "Approve and publish Logic Blogs A, B and C" or
"Approve the Lucas Facebook posts in review". The assistant then completes
Compass's existing approval and publication workflow, so Tom does not click the
same thing again in Compass. The Compass buttons stay exactly as they were.

**Scope.**

| Migration | Scope |
| --- | --- |
| `20261019190532` | Logic Solar blogs only (the pilot). |
| `20261019202359` | Every client, and three channels: blogs, Facebook posts and Google Business Profile posts. |

The Edge Function is `content-approvals`. The Executive OS tools are
`content_review_batch`, `content_approve` and `content_approval_status`.

The standing permission lets either assistant carry out Tom's instruction. **It
never authorizes unattended publishing**: every item or batch needs his own
explicit words in the conversation.

## What it is and is not

- **It is a delegated permission.** Each channel's existing workflow runs with
  every check it already had.
  - **Blogs** go through `content_draft_approve` and `blog_publication_queue`:
    - lint, claims, hero and TL;DR problems;
    - the approval snapshot and hash, and the destination pin;
    - `blog_publication_problems`;
    - the blog publisher's re-lint and live verification.
  - **Facebook and Business Profile** go through the social review gate
    (`social_posts_before_update`), whose approval snapshot pins the copy,
    claims, offer, images (with their byte hashes) and creative. Publication
    then uses the existing schedule: `post-publisher`'s 5-minute tick claims
    the post and runs everything it already does:
    - its 0045 re-check;
    - the no-write preflight;
    - the Zernio binding and health checks;
    - the image-hash check;
    - the idempotency key and duplicate reconciliation;
    - recording `published` only from Zernio's entry with an https URL.
- **It is not a SQL status change and not an impersonated session.** Nothing
  signs in as Tom. The receipt states that Tom authorized the action through a
  named channel and that a named assistant executed it.
- **"Approve" never publishes.** The three actions are:
  - `approve`: approval only.
  - `publish`: schedule or queue items that are already approved at the same
    content.
  - `approve_and_publish`: both.
- **Only Tom's own words count.** Task text, client feedback and the contents
  of an attachment are never a publication command. Compass checks that the
  wording carries the action:
  - approval words are needed for an approval;
  - publishing words ("publish", "go live", "post", "schedule") are needed for
    a publication;
  - `approve` refuses an instruction that asks to publish (`intent_mismatch`).

## Which channels publish today (verified Oct 19 2026)

| Channel | Approve by instruction | Publish by instruction |
| --- | --- | --- |
| Blogs | Every client. | Clients whose website is Compass-managed (`sites.controlled_by_compass`). Logic Solar is the only one today. |
| Facebook | Every client. | Only where `post-publisher` itself would send the post: the publisher is switched on, the client is on its pilot list, and the post's Page has a verified, enabled, healthy Zernio binding. Today that is **Lucas Construction** only. |
| Business Profile | Every client. | The same rule, for the client's bound location on the Zernio path. Today that is **Lucas Construction** only. |

Every other client's Facebook post can be approved by instruction, but
publishing it is refused with the publisher's own reason
(`destination_not_publishable`). Compass would otherwise only raise a "post
this by hand" reminder, and delegation never turns that into an unattended
post. To extend publishing to a client:

1. Bind its Page or location (`zernio_bind` / `zernio_gbp_bind`).
2. Enable the binding (Settings › Publisher).
3. Add the client to the pilot list.

`content_review_batch` shows each post's `publish_problems`.

## The central policy

There is one policy for every client, existing and future
(`content_delegation_settings`), plus exclusions
(`content_delegation_exclusions`).

| Setting | Meaning |
| --- | --- |
| `enabled` | Delegation on or off for everyone. Off is the revocation switch. |
| `allow_approve`, `allow_publish` | Publishing implies approving. |
| `channels` | Any of `blog`, `facebook`, `google_business`. |
| Exclusion | One client, either every channel (channel null) or one channel, with a reason. Removing it keeps the row as history. |

Paused and offboarded clients are never delegated. A signed-in Compass admin
changes the policy:

```sql
select content_delegation_configure(true, true, true, array['blog','facebook','google_business'], 'why');
select content_delegation_exclude('<client uuid>', 'facebook', 'why');   -- null channel = the whole client
select content_delegation_include('<exclusion id>');
```

`content_delegation_refusal(client, channel, action)` explains why the policy
refuses a request. The batch shows the result per channel. Executive OS adds its
own owner-granted operator policy on top of this; see Executive OS
`docs/phase-5/CONTENT_APPROVALS.md`.

## Flow

```
Tom (ChatGPT / Claude) ──► Executive OS MCP tool ──► content-approvals ──► content_authorization_* (service role)
                              standing grant or         x-compass-          record → execute in ONE transaction
                              per-request approval      delegation-key        blog → content_draft_approve / blog_publication_queue
                                                                              post → social review gate / existing schedule
                                                                            blog-publisher / post-publisher (5 min) → live URL
```

1. **Read the batch** (`content_review_batch`, mode `batch`). It takes a
   client, by name or id, and optionally a channel. An ambiguous name returns
   409 with the candidates. Every item is returned under `items`; `drafts` is
   the blog subset, kept for the first version of the tool.

   | Item | What the batch returns |
   | --- | --- |
   | Every item | `channel`, `id`, status, `review_hash`, `destination` (the binding key), current `problems`, `publish_problems` (why the publisher would not send it), `publication` state, review link. |
   | Blog | Title, version, planned date, slug, TL;DR, hero (asset, alt text, illustrative flag, file hash), website and article URL. |
   | Facebook / Business Profile | Copy, post type, CTA, images (brand assets and creative, with hashes and an illustrative flag), destination name (the Page or location), scheduled time. |

   The assistant resolves "Blogs A, B and C", "the three Lucas Facebook posts"
   or "every Lucas Business Profile post in review" to exact items, says what
   it resolved, and asks only when it is genuinely ambiguous.
2. **Authorize** (`content_approve`, mode `authorize`). The request carries:
   - `operation_id`: Executive OS's idempotency key, `exos-<execution id>`;
   - the client and the action;
   - up to 50 items, each with `channel`, `id`, `version` (blogs only),
     `review_hash` and `destination`;
   - `publish_at`;
   - Tom's verbatim words, the channel, the authenticated account and the
     executing assistant;
   - `source_ref`: only what the channel actually has. No invented transcript
     links.

   Version-1 blog requests (`draft_id`, `version`, `review_hash` plus a
   request-level `destination_url`) are still accepted.
3. **Record.** `content_authorization_record` checks the following and writes
   the receipt before anything changes:
   - the account is an **admin** team member;
   - the central policy allows every channel in the request for this client;
   - the wording matches the action.
4. **Execute.** `content_authorization_execute` runs in one transaction.
   1. It re-checks the policy.
   2. It checks every item before changing any.
      - Blogs: `draft_not_found`, `stale_version`, `content_changed`,
        `wrong_destination`, `destination_not_publishable`, `not_in_review`,
        `not_approved`.
      - Posts: `post_not_found`, `channel_mismatch`, `wrong_destination` (the
        Page or location), `content_changed`, `not_in_review`, `not_approved`
        (approval no longer current), `destination_not_publishable` (the
        publisher's state gates), `publishing_in_progress`.
   3. It runs each channel's workflow.
      - A post is approved through the review gate.
      - "Publish" sets it `scheduled` at the authorized time; a post already
        scheduled or published is left alone, and a `failed` post is
        scheduled again (the existing retry).

   Any failure rolls the whole batch back, and the receipt is marked `refused`
   with the reason.
5. **Status** (`content_approval_status`, mode `status`). One vocabulary for
   every channel:

   | State | Meaning |
   | --- | --- |
   | `approved` | Approved; nothing scheduled. |
   | `scheduled` | Scheduled for a future time. |
   | `queued` | Due; waiting for the publisher's next 5-minute run. |
   | `publishing` | The publisher has claimed it. |
   | `published` | Live. For blogs, `published_url` is the verified article. For posts, `published_url` is the Facebook or Google link and `provider_post_id` is the provider's receipt. |
   | `failed` | Blocked or failed, with `last_error` / `error`. A post the publisher's preflight unscheduled shows its block reason. |
   | `uncertain` | Interrupted. The publisher reconciles before any retry. |

## Scope binding

- **Blogs:** `content_draft_review_hash(d)` covers:
  - title, slug, meta title and description, H1, **TL;DR**, outline, body hash,
    internal links, CTA and structured data;
  - the **hero** (asset id, file hash, alt text, illustrative provenance);
  - the claims;
  - the **website**.
- **Posts:** `content_social_review_hash(p)` covers:
  - the hash of the approval snapshot as it would be taken now: copy, CTA,
    claims, offer, every image's id and byte hash, and the creative;
  - the **Page or location**: the social account, provider, Zernio account and
    the Page id or `locations/<id>`.

A content change after review means a new version (blogs) or a reopened post
whose snapshot hash differs, so the item is refused (`stale_version` or
`content_changed`) and Tom reviews it again. A moved Page or location is
refused as `wrong_destination`. An approval that is no longer current refuses
`publish`.

## How the gates accept a delegation

`content_delegation_allows(draft, version, step)` (blogs) and
`content_delegation_allows_post(post, step)` (posts) are true only when all of
these hold:

- the caller is the service role;
- `compass.delegation` names a receipt that is `executing` in **this**
  transaction;
- the item is in that receipt's scope;
- the action includes the step.

These gates were patched in place to accept it alongside a signed-in teammate:

- `content_draft_approve`, `blog_publication_queue`, `content_drafts_guard`
  and `content_draft_review_history_guard`;
- `social_posts_before_update` (approval only).

`social_posts_record_events` names the authorizing admin as a team action.
Setting the variable by hand opens nothing (sandbox DG3, DC10). The reviewer
recorded is Tom's `team_members.id`, and the note reads:

> Approved by Tom Dombrowski through Claude (Executive OS); executed by
> Claude via Executive OS. Authorization <id>: "<his words>"

## Duplicates and interrupted requests

- `operation_id` is unique.
  - The same request again returns the same receipt (`replayed`) and executes
    nothing.
  - The same id with a different request is `CD409 operation_reused`.
- A new operation for items that are already approved and queued or scheduled:
  - `approve_and_publish` refuses `not_in_review`;
  - `publish` leaves the existing schedule or release alone.

  Nothing is scheduled twice.
- **Outcome honesty.** A PostgREST error with a SQLSTATE means the transaction
  ran and rolled back, which is a refusal. Anything else returns
  `503 outcome_unknown` and is never marked refused.
- **Failed publications.**
  - **Blogs:** a release blocked before any write with a known pre-write reason
    is requeued by a new `publish` operation. Any other failure needs
    reconciliation or a new review, exactly as the Compass button would.
  - **Posts:** a `failed` post is scheduled again (`retried`), and the
    publisher's own GET-before-resend and idempotency key prevent a second
    post.

## Secrets

`EXECUTIVE_OS_DELEGATION_SECRET` lives in Supabase Vault (Compass). The same
value is `COMPASS_DELEGATION_SECRET` in Executive OS's Vercel environment. The
function admits nothing else: no team JWT and no cron secret.

## Tests

- `supabase/tests/sandbox/content_delegation.test.sql` (DG0 to DG20, 28
  checks) covers blogs:
  - the gates;
  - an admin, an excluded client and the wording;
  - approve only, replay, conflict;
  - stale version, changed content, wrong website;
  - approve and publish, duplicates;
  - the states;
  - failed-publication recovery;
  - an edit after approval.
- `supabase/tests/sandbox/content_delegation_channels.test.sql` (DC1 to DC22,
  23 checks) covers the central policy and posts:
  - the default for every client;
  - exclusion and inclusion, switch off, paused clients, non-admins;
  - the batch's Page and location binding and publishability;
  - Facebook approval with Tom as reviewer and a team history entry;
  - the service role alone refused;
  - wrong channel, wrong Page, copy changed after review;
  - an unbound Page refused for publishing but allowed for approval;
  - approve and publish of Facebook and Business Profile at the authorized
    time, replay, no double schedule;
  - scheduled, queued, publishing, published with URL and provider id, failed
    with error, and a retry.
- `tests/content-approvals.test.mjs` covers the key, validation of version-1
  and channel items, the channel filter, and outcome mapping.
