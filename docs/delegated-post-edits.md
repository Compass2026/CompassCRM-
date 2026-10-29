# Delegated post edits

Tom (Oct 20, 2026): "I don't want to have to withdraw them, I want you 2 to
handle these kind of edits." Claude or ChatGPT, through Executive OS, can
revise **one** Facebook or Business Profile post that is waiting for Tom's
review. The first case was the holiday logo on the Lucas Christmas Lights
posts.

A revision does three things in **one transaction**, under a receipt:

1. withdraws the post from review;
2. replaces its media with bytes Compass measured itself;
3. resubmits the post for a **fresh** review.

If any check fails, nothing changes.

**It never approves, schedules or publishes.** It refuses approved, scheduled
and published posts. Reopening an approved post stays a signed-in teammate's
step, so no edit can carry an old approval with it. Tom still reviews every
revised post in Compass.

| Migration | Scope |
| --- | --- |
| `20261020200000` | Facebook and Business Profile posts in review; one operation, `replace_media`. |
| `20261029180000` | A second operation on the same door, `replace_copy` (see "Copy edits" below). |

The Edge Function is `content-approvals` (handler v3), with the same
delegation key as approvals. The Executive OS tools are `content_stage_media`,
`content_revise` and `content_revision_status`, under an Executive OS standing
editorial policy or Tom's approval of the single request. Executive OS's side
is described in its `docs/phase-5/CONTENT_EDITS.md`.

## Modes

| Mode | What it does |
| --- | --- |
| `stage_media` | Records a declared file for one post: sha256, size, type (PNG, JPEG or WebP), dimensions and file name. Returns a signed, single-use upload URL for its content-addressed path, `<client>/upload/<sha256>.<ext>`, which is never overwritten. If those bytes are already stored, it says so (`already_stored`) and returns no URL. It writes no post. The stage expires after 30 minutes. |
| `revise` | Records the receipt, measures the stored bytes, then executes the revision (steps below). |
| `revise_status` | Returns the receipt and the post now: review and publish status, review hash, media. |

### `revise` in detail

1. **Record the receipt** (`content_edit_record`). The same `operation_id` with
   the same request replays the existing receipt; with a different request it
   is refused as `operation_reused` (CD409).
2. **Measure the stored bytes** in the function: sha256, signature type, size
   and dimensions, using the same measurement as source-assets. The database
   never trusts a declared hash.
3. **Execute** (`content_edit_execute`). It checks everything before changing
   anything, then withdraws, unlinks the old brand-asset media, files or reuses
   the asset for these bytes, links it and resubmits. The existing grounding
   check runs, and the review task closes and opens again.

## Checks

Every check runs before anything changes. Each refusal has its own code.

**Policy**

- `content_delegation_settings.allow_edit` is Compass's own switch. It is
  seeded on with Tom's decision; an admin turns it off with
  `content_delegation_configure_edits(false)`.
- The client and channel exclusions apply.
- Paused and offboarded clients are never edited.
- The account must be a Compass admin.

**The post**

- It must belong to the client.
- `channel_mismatch`: its platform differs from the declared channel.
- `service_mismatch`: its service differs from the declared one.
- `outside_authority`: its channel, service or the operation is not covered by
  the authority Executive OS holds (the standing policy's channels and
  services, or the single approved request).
- `wrong_destination`: it no longer goes to the Page or location the assistant
  read.
- `not_editable`: it is not `in_review` / `not_scheduled` / unapproved.
- `content_changed`: its review hash differs from what the assistant read.
- `creative_engine_post`: its media is Creative Engine output, which goes
  through the Creative Engine instead.

**The file**

- `stage_not_found`: the stage belongs to another post.
- `stage_consumed`: the stage was already used.
- `stage_expired`: the stage is older than 30 minutes.
- `bytes_missing`: nothing was uploaded.
- `bytes_mismatch`: the measured hash, size, type or dimensions differ from the
  declared file.

## Identity and attribution

**Identity is bound to the transaction.** `content_edit_receipt()` returns the
receipt only while it is `executing` in this transaction (`executing_txid =
txid_current()`), for the service role. This is the same pattern as
`content_delegation_receipt()`. A `compass.content_edit` setting left on a
pooled connection, or a receipt forged into `executing`, confers nothing. The
sandbox suite tests both.

**The assistant is its own actor.**

- `post_caller_kind()` returns `assistant`.
- `post_events` rows carry `actor_kind = 'assistant'`, no `actor_id`, and
  `detail.edit = {receipt, executed_by, channel, authorized_by}`.
- The post history reads, for example: "Claude via Executive OS (authorized by
  Tom): Withdrew it from review".
- `social_posts.updated_by` is the authorizing admin.
- No event says Tom did it.

**The new asset** is a `social_post` brand asset:

- `creative_use = 'unreviewed'` and `depicts_own_work` null;
- its hash and measurement are recorded through `brand_asset_record_hash`;
- its notes carry the assistant's provenance (for AI art: illustrative,
  non-evidentiary) and the receipt.

If the same bytes are already filed for the client, that row is reused.

**Drafter-made posts.** `post_links_drafter_guard` admits the executing
receipt for **its own post's** brand-asset media only. Without the receipt, the
service role still cannot change a drafted post's media.

## Not covered (deliberately)

- **Copy edits** were left out in v1; `20261029180000` adds them (below).
- **Approved, scheduled and published posts.** A published post's image is
  changed by a new post or a provider-side edit, under Tom's separate decision.
- **Clients with brand workspaces.** A new asset is not assigned to a brand, so
  the resubmission fails grounding (`grounding_failed`) and nothing changes.
  Assign the asset in the workspace first.

## Copy edits (`20261029180000`, content-approvals v4)

The first copy correction (a Facebook post that did not answer its keyword
question, Oct 29 2026) showed the gap: the media door could not answer it, and the only
other route was a teammate withdrawing, retyping, relinking and resubmitting
by hand, recorded as that person's edit. `replace_copy` is the same door
with one more change kind:

```json
{ "mode": "revise", "change": { "kind": "replace_copy", "copy": "…", "claim_ids": ["…"] }, … }
```

1. **Record** the receipt as for media. A copy edit carries no file
   (`stage_id`, `sha256` are refused) and the receipt has no stage.
2. **Check the copy here.** content-approvals rebuilds the brief for the
   post's own target (its channel, type, intent, service, keyword, CTA,
   offer, destination and current media; a drafted post's campaign mode from
   its run) from live Client Intelligence and runs the post-drafter's linter
   on the proposed copy and claims (`copy-check.ts`, the drafter's own
   `buildBrief` / `lintDraft`). A refusal is recorded on the receipt as
   `lint_failed` (or `brief_refused`) with the problems; nothing changes.
3. **Execute** in one transaction: every media-path check (policy, client,
   channel, service, authority, destination, in review and unscheduled,
   review hash, no Creative Engine media), then `lint_failed` unless the
   function says the copy was checked clean **and** that copy is the
   receipt's, `claims_unusable` unless every claim is a confirmed or sourced
   claim of this client; then withdraw, set the copy, link exactly the listed
   claims (unlinking the rest), resubmit through the existing grounding
   check (the promotion hold and core-keyword gate apply as to anyone).

- The authority must list `replace_copy` in `operations`. A standing policy
  for `replace_media` does not cover copy.
- The same post, slot, destination, keyword, service, CTA and media; only
  the copy and claim links change. The receipt's result keeps the previous
  and new copy hashes, the brief hash, lint warnings and the unlinked claims.
- Gates: `social_posts_drafter_guard` admits the executing copy receipt
  changing its own post's copy to exactly its copy (no other content field);
  `post_links_drafter_guard` admits linking its listed claims and unlinking
  others on its post. Without the receipt the service role still cannot
  touch a drafted post's copy or claims, and a media receipt admits neither.
- History and attribution are the media path's: `actor_kind = 'assistant'`
  with the receipt, `updated_by` the authorizing admin.
- **Executive OS** needs its side before anyone can use it: `content_revise`
  accepting `change.kind = "replace_copy"` with `copy` and `claim_ids`, and
  `replace_copy` as an editorial-policy operation. Until then nothing calls it.

Tests: `tests/content-edit-copy.test.mjs` (request validation, record → check
→ execute, lint refusals on the receipt, replay, no check deployed, and the
copy check over the real drafter brief and linter);
`tests/content-edit-copy-integration.mjs` (`npm run test:content-edit-copy`, in CI:
the deployed handler, stores and copy check through PostgREST on the replayed
schema; the post-target read on a drafted post (both `social_posts` ↔
`drafter_runs` foreign keys, so the embed names `social_posts_drafter_run_fk`)
and on a post with no run and media; refusals, the edit, replay);
`supabase/tests/sandbox/content_edit_copy.test.sql` (CC1–CC9, including the
rollback restoring the pre-release definitions byte for byte). Rollback:
`supabase/rollback/20261029180000_content_edit_copy.down.sql` (stops if a
copy-edit receipt exists; receipts are records); then content-approvals v3.

## Tests

- `tests/content-edits.test.mjs` covers the handler:
  - validation and whitelisting;
  - bytes measured in the function, never declared;
  - refused vs unknown outcomes;
  - replays and status.
- `supabase/tests/sandbox/content_edits.test.sql` (CE1–CE14) covers:
  - the function doors and the batch's `service_id`;
  - staging;
  - a non-admin, the switch and an exclusion;
  - a full revision with its history and asset;
  - replay and conflict;
  - a drafter-made Business Profile post;
  - a stale or forged identity;
  - service, authority, destination and stale state;
  - approved, published and scheduled posts;
  - bytes, missing upload and expired stages;
  - Creative Engine posts;
  - status;
  - "every refusal changed nothing".
- `tests/social-posts.test.mjs` covers the history line.
- `portal_access.test.sql` lists the new admin door.

## Rollback

Drop the five `content_edit_*` functions, the identity helpers, the
`post_events_edit_detail` trigger and both tables, and drop `allow_edit`.
Restore these from their previous migrations:

| Object | From |
| --- | --- |
| `post_caller_kind` | `0054` |
| `post_links_drafter_guard` | `0054` |
| `post_events_actor_kind_check` | `0054` |
| `social_posts_before_update` | `20261019202359` |
| `content_review_batch` | `20261019202359` |

Restore content-approvals handler v2.
