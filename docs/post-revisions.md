# Rejection corrections

Tom (Oct 26 2026): "when we reject a post will it automatically update and
fix the rejected post? We need this to happen." Executive OS task
`f28c9de7-f303-4463-baf4-8edd61d58290`.

## The bug this fixes

Lucas Business Profile post `2cc7a18b` was rejected with feedback about its
**image** (the blue line, the heading's capitals). Three things went wrong:

- The image was an attached file, not Creative Engine output. Only Creative
  Engine output could be rejected as "the graphic", so the rejection was
  recorded as **copy**.
- `rejected>draft` only reopened the post. `draft>in_review` then cleared
  `review_note` and opened a new review task. The post went back **unchanged**
  and the feedback disappeared from the page.
- Nothing was routed to anyone. No worker, assistant or task picked up the
  work.

## What happens now

| Step | What happens |
| --- | --- |
| Reject | A reviewer rejects the caption, the image or both. Any media can be rejected as the image: an attached file or a rendered graphic. One `post_revision_requests` row is created per rejection event (unique), holding the exact feedback, the copy and media hashes at rejection, and the destination, service and keyword. |
| Route (automatic, default) | **Caption → Claude:** Postgres fires the worker Routine (`fire_foundation_worker`, reason `Post revision request <id>`), the same unattended runner as the rest of the worker. The fire is in `worker_fires`. **Image → ChatGPT:** a row in `post_revision_outbox`. Executive OS reads it (`content-approvals` `revision_queue`) and records a receipt (`revision_ack`). Nothing wakes an idle ChatGPT; the page says "Queued for ChatGPT" until it acts. **Rendered (Creative Engine) graphic → a teammate**, who presses Request new graphic and Generate graphic. ChatGPT does not edit Creative Engine output. |
| Correct | **Claude** corrects the caption through `post-drafter` v9's `revision_brief`, `revision_check` and `revision_submit`. That means the post's own target, the live brief, the drafter's linter, the same claims and a caption that must differ. The write is one call to `post_revision_write_copy`, which re-checks everything under a row lock. **ChatGPT** uses `content_stage_media` and `content_revise` (`replace_media`) as before; it now also works on a rejected or draft post that has an open automatic image correction. |
| Wait | A mixed rejection keeps both parts. The post stays a draft until both are met. |
| Return | When every rejected part is met, the post goes back for a **fresh** review: a new review task, nothing approved, nothing scheduled. |
| Guard | `draft>in_review` is refused while a rejected part is unmet. Unmet means the caption hash is unchanged, or the media hash is unchanged (removing the media is not a revision), and no teammate has recorded that it needs no change. This applies whoever resubmits. |

Request states: `open`, then `returned` (back in review), then `accepted`
(approved). A later rejection marks the request `superseded`.

Obligation states (caption and image each):

| State | Meaning |
| --- | --- |
| `not_needed` | That part was not rejected. |
| `queued` | Dispatched, waiting for its owner. |
| `working` | Claimed (caption) or picked up by Executive OS (image). |
| `blocked` | The correction is blocked. The reason is shown and one TOM task is opened or reopened. |
| `manual` | A teammate edits it by hand. |
| `ready` | Corrected. |
| `resolved` | A teammate recorded that it needs no change (note required, attributed). |

## Teammate actions (post page › Rejection feedback)

- **Retry / Request automatic correction**: dispatches the unmet parts again.
  Each retry is a new fire. The outbox item keeps its id and bumps its
  generation, so no duplicate post or task is created.
- **Reopen to edit by hand**: the request turns manual. The worker and
  ChatGPT stand down and the outbox item is cancelled. A rejected post
  becomes a draft and the feedback stays. A plain status transition is
  never an AI revision.
- **Needs no change**: records the resolution with a note and the
  teammate's name.
- **Change category**: corrects what was rejected. The original
  `rejection_classified` event stays; the correction is its own
  `rejection_reclassified` post event. The new part is dispatched.
- **Edit caption** (on a post in review or rejected): one transaction,
  `social_post_edit_caption`. It withdraws or reopens the post, changes only
  the caption and resubmits it. It is bound to the caption the page showed.
  Image, claims, keyword, service and destination stay. A teammate's own
  caption or image edit meets that part and releases the worker's claim.

## Executive OS (content-approvals v4)

| Mode | What it does |
| --- | --- |
| `revision_queue` | Pending image corrections, with `review_hash`, `destination`, `service_id`, the feedback and the media. Writes nothing. |
| `revision_ack` | `{outbox_id, generation, receipt: {id, …}}`. Idempotent per item and generation. Another receipt answers `already_delivered`; a re-queued item answers `stale_generation`. |
| `revise` | Now also takes `change.kind = replace_copy` with `{copy, previous_copy_hash}`: a chat-requested caption edit, bound to the caption the assistant read. The authority must list `replace_copy`. |

**Not built here (Executive OS repository):**

- a poller or tool that reads `revision_queue` and hands each item to
  ChatGPT as a task (then `revision_ack`);
- `replace_copy` in `content_revise`'s schema and the editorial policy's
  operations.

Until those exist, image corrections wait in the outbox and the page says so.

## Deployment order

1. Apply `20261026200000_post_revision_requests.sql`. Its backfill runs
   once: see below.
2. Merge. The app and the worker skill go live with it.
3. Deploy `post-drafter` (v9) and `content-approvals` (v4) from `main`.
   Until `post-drafter` answers v9 with `revisions`, the worker's preflight
   stops without writing (the claim lapses after an hour), and "Retry"
   dispatches it again.

## Backfill (production, read-only preview, Oct 26 2026)

Each unapproved, unpublished post whose latest rejection has no later
approval gets a **manual** request: feedback recovered from the rejection
event, nothing dispatched. Copy or media changed after that rejection counts
as resolved by the backfill. The preview found three Lucas posts:

| Post | Rejected | Feedback | Outcome |
| --- | --- | --- | --- |
| `2cc7a18b` | Oct 26 19:20 | "Take 'Illustrative Concept' off." | Recorded as copy. Its image fix is ChatGPT's: reclassify it to Image and request automatic correction, after coordinating. |
| `d3447086` | Sept 28 | A rewrite request | Manual caption request. |
| `226ccecd` | Sept 25 | "This was only a rejection test" | Resolve with "No change needed", or delete the draft. |

## Tests

- `supabase/tests/sandbox/post_revisions.test.sql` (PR1–PR20, 28 checks)
  covers:
  - doors and permissions;
  - the attached-image rejection;
  - duplicates;
  - unchanged resubmission;
  - the worker fire;
  - claims;
  - the caption writer's refusals (claimant, stale copy, unchanged copy,
    another client, destination changed);
  - mixed rejections completed by `content_edit`;
  - the outbox and its acknowledgements;
  - rendered graphics;
  - manual mode, "no change needed" and reclassification;
  - approval and a later rejection;
  - `replace_copy`;
  - an unconfigured dispatcher and its retry;
  - the backfill;
  - the review-screen caption edit.
- `portal_access.test.sql` lists the new teammate functions and checks that
  a portal user is refused.
- `tests/post-drafter-revision.test.mjs` and `tests/content-edits.test.mjs`
  cover the handlers over fake stores.
- `npm run test:post-revisions-ui` runs Chromium over the replay. The real
  post-drafter and content-approvals handlers run behind PostgREST.
  Screenshots: `SCREENSHOTS=dir`.

## Rollback

1. Drop the post_events trigger `post_events_zz_revision` and the
   `social_posts_zz_revision_edit` / `post_assets_zz_revision_edit`
   triggers.
2. Drop the `post_revision_*` functions, `social_post_edit_caption` and the
   three tables.
3. Remove `rejection_reclassified` from `post_events_kind_check`.
4. Restore these from their previous migrations:

   | Object | From |
   | --- | --- |
   | `social_posts_creative_guard`, `request_new_creative` | `0054` |
   | `social_posts_before_update`, `content_edit_record`, `content_edit_execute` | `20261020200000` |

5. Make `content_edit_receipts.stage_id` not null again (there must be no
   `replace_copy` receipts).
6. Redeploy `post-drafter` v8 and `content-approvals` v3.
