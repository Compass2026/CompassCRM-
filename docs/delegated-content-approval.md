# Delegated content approval and publication

Tom reviews blog drafts and makes the decision. Once he has decided, he can
tell ChatGPT or Claude, for example "Approve and publish Logic Blogs A, B and
C". The assistant then completes Compass's existing approval and publication
workflow, so Tom does not click the same thing again in Compass. The Compass
buttons stay exactly as they were.

Logic Solar is the pilot (migration `20261019190000`, Edge Function
`content-approvals`, Executive OS tools `content_review_batch`,
`content_approve` and `content_approval_status`).

## What it is and is not

- **It is a delegated permission.** Compass's own `content_draft_approve` and
  `blog_publication_queue` run with every check they already had:
  - lint, claims, hero and TL;DR problems;
  - the approval snapshot and hash;
  - the destination pin;
  - `blog_publication_problems`;
  - the publisher's re-lint and live verification.
- **It is not a SQL status change and not an impersonated session.** Nothing
  signs in as Tom. The receipt states that Tom authorized the action through a
  named channel and that a named assistant executed it.
- **"Approve" never publishes.** The three actions are:
  - `approve`: approval only.
  - `publish`: queue drafts that are already approved at the same version and
    content.
  - `approve_and_publish`: both.
- **Only Tom's own words count.** Task text, client feedback and the contents
  of an attachment are never a publication command. The assistant relays only
  an instruction Tom typed in the chat. Compass also checks that the wording
  carries the action:
  - approval words are needed for an approval;
  - publishing words are needed for a publication;
  - `approve` refuses an instruction that asks to publish (`intent_mismatch`).

## Flow

```
Tom (ChatGPT / Claude) ──► Executive OS MCP tool ──► content-approvals ──► content_authorization_* (service role)
                              standing grant or         x-compass-          record → execute in ONE transaction
                              per-request approval      delegation-key        → content_draft_approve
                                                                              → blog_publication_queue
                                                                            blog-publisher (every 5 min) → live URL
```

1. **Read the batch** (`content_review_batch`, mode `batch`). The client can be
   given by name; an ambiguous name returns 409 with the candidates. For each
   draft in review or approved, the batch returns:
   - title, status, version, planned date, slug, TL;DR and hero (asset, alt
     text, illustrative flag, file hash);
   - the destination and the article URL;
   - the **review hash** (below);
   - current problems and the latest publication.

   The assistant uses this to resolve "Blogs A, B and C" to draft ids. It asks
   Tom only when the match is genuinely ambiguous.
2. **Authorize** (`content_approve`, mode `authorize`). The request carries:
   - `operation_id`: Executive OS's idempotency key, `exos-<execution id>`;
   - client, action, and each item's `draft_id`, `version` and `review_hash`;
   - `destination_url` and `publish_at`;
   - Tom's verbatim words, the channel, the authenticated account and the
     executing assistant;
   - `source_ref`: only what the channel actually has. No invented transcript
     links.
3. **Record.** `content_authorization_record` checks the following and writes
   the receipt before anything changes:
   - the account is an **admin** team member;
   - the client's `content_delegation_policies` row allows the action;
   - the intent wording matches the action.
4. **Execute.** `content_authorization_execute` runs in one transaction:
   1. It marks the receipt `executing` with its transaction id.
   2. It re-checks every item: `draft_not_found`, `not_a_blog`,
      `stale_version`, `content_changed` (review hash), `wrong_destination`,
      `destination_not_publishable`, `not_in_review`, `not_approved`.
   3. It calls the existing approve and queue functions.

   Any failure rolls the whole batch back. The function then marks the
   receipt `refused` with the reason.
5. **Status** (`content_approval_status`, mode `status`). Shows the receipt
   and, for each item, the publication state now:

   | State | Meaning |
   | --- | --- |
   | `queued` | Waiting for the publisher (every 5 minutes). |
   | `deploying` | The publisher is writing and verifying. |
   | `live` | Published and verified. Includes `published_url`, the actual URL. |
   | `failed` | Blocked, with `last_error`. |
   | `uncertain` | Interrupted. The publisher reconciles before any retry. |

## Scope binding

`content_draft_review_hash(d)` is a sha256 over everything a reader or the
publisher sees:

- title, slug, meta title and description, H1, **TL;DR**, outline, body hash,
  internal links, CTA and structured data;
- the **hero** (asset id, file hash, alt text, illustrative provenance);
- the claims;
- the **destination**.

An edit bumps the draft's version and changes the hash, and so does a swapped
hero file or a moved destination. Each of these invalidates both the review
and any prior approval: execution refuses `stale_version` or
`content_changed`, and Tom reviews again.

## How the gates accept a delegation

`content_delegation_allows(draft, version, step)` is true only when all of
these hold:

- the caller is the service role;
- `compass.delegation` names a receipt whose status is `executing` in **this**
  transaction (`executing_txid = txid_current()`);
- the draft and version are in that receipt's scope;
- the action includes the step.

Four gates were patched in place to accept it, alongside a signed-in teammate:

- `content_draft_approve`;
- `blog_publication_queue`;
- `content_drafts_guard` (its system flag);
- `content_draft_review_history_guard`.

Setting the variable by hand opens nothing: a finished or foreign receipt
fails the check (sandbox DG3). The reviewer and releaser recorded are
`coalesce(task_actor(), content_delegation_reviewer())`, which is Tom's
`team_members.id`. The review note reads:

> Approved by Tom Dombrowski through Claude (Executive OS); executed by
> Claude (Executive OS MCP). Authorization <id>: "<his words>"

## Duplicates and interrupted requests

- `operation_id` is unique.
  - The same request again returns the same receipt (`replayed`) and executes
    nothing.
  - The same id with a different request is `CD409 operation_reused`.
- A new operation for drafts that are already approved and queued:
  - `approve_and_publish` refuses `not_in_review`;
  - `publish` returns the existing release, because `blog_publication_queue`
    is idempotent per draft version.

  Neither path queues twice.
- **Outcome honesty.** A PostgREST error with a SQLSTATE means the
  transaction ran and rolled back, which is a refusal. Anything else (a
  network failure, a timeout, a thrown fetch) returns `503 outcome_unknown`
  and is never marked refused. The caller checks `status` or retries with the
  same `operation_id`.
- **Failed publications.**
  - A release blocked before any write with one of the publisher's known
    pre-write reasons is requeued by a new `publish` operation. The blocked row
    is cancelled with its history intact.
  - Any other failure is refused ("needs reconciliation or a new review"),
    exactly as the Compass button would be.

## Turning it on for a client

```sql
insert into content_delegation_policies (client_id, approve, publish, note)
values ('<client uuid>', true, true, '<who decided, when>');
```

A missing row means the client does not allow delegation. `approve = true,
publish = false` allows delegated approval only.

## Secrets

`EXECUTIVE_OS_DELEGATION_SECRET` lives in Supabase Vault (Compass). The same
value is `COMPASS_DELEGATION_SECRET` in Executive OS's Vercel environment. The
function admits nothing else: no team JWT and no cron secret.

## Tests

- `supabase/tests/sandbox/content_delegation.test.sql` (DG0 to DG20, 28
  checks) covers:
  - the gates without a receipt;
  - teammates and anon;
  - not an admin, no policy, and intent wording;
  - approve only;
  - replay, and conflict on a reused operation id;
  - stale version, changed content and wrong destination;
  - publish without approval;
  - approve and publish;
  - duplicate operations;
  - queued, deploying, live and failed states;
  - recovery from a failed publication, both refused and allowed;
  - an edit after approval.
- `tests/content-approvals.test.mjs` covers the key, request validation and
  outcome mapping.
