# Content Planner (Oct 4 2026; Production MVP sprint)

Tom's weekly question, per managed client: what is due, and what is ready?

```
Social X/2 | GBP X/2 | Blogs X/2 | Web Pages X/1
```

X counts the pieces that are **approved or delivered**. The targets are a
cadence, not a quota: Authority and quality stay the gate, so a slot may
stay empty rather than be filled with weak work.

**Status:** migration 0065 is written and sandbox-tested, but **not
applied**. The pages are built and tested against the sandbox.

## Model (0065)

`content_plan_items` holds one row per planned piece, for a client and a
week (`week_start` is a Monday).

**Columns:**

| Field | Values |
|---|---|
| `deliverable` | `social`, `gbp`, `blog`, `web_page` |
| `channel` | `google_business` for gbp; facebook / instagram / linkedin / x / tiktok for social; none for blog and web page |
| `purpose` | `authority`, `educational`, `service`, `review`, `seasonal_offer`, `community_team`, `real_work` |
| `topic` | Required: the topic or target keyword in words |
| `search_intent` | navigational / informational / commercial / transactional; optional until generation |
| `keyword_id`, `service_id` | The client's own (composite foreign keys) |
| `authority_opportunity_id` | Set **exactly** when the purpose is `authority` |
| `target_url` | The destination page |
| `planned_date` | Inside the week |
| `social_post_id` / `content_post_id` | The linked draft. A post fills one slot of its own channel; a blog fills one blog slot. |
| `hold` + `hold_reason` | A teammate's `blocked` (the reason is required) or `delivered` |
| `output_url` | Where the piece went live |

**What the database enforces:**

- An Authority opportunity can only fill the matching kind of slot:
  - `gbp_post` → gbp
  - `blog_post` / `blog_refresh` → blog
  - `service_page` / `location_page` / `page_improvement` → web page
- A dismissed or suppressed opportunity is refused.
- Authority has no social content type yet, so social items are never
  `authority`.
- The guard stamps `created_by` / `updated_by`.
- Access is team only (`is_team()`). Portal contacts and anon see nothing.

**`content_plan_board`** is a security-invoker view that derives each item's
status. The first match wins:

| Status | When |
|---|---|
| Blocked | A teammate's hold |
| Delivered | A teammate's hold, the linked post published, or the linked blog published |
| Approved | The linked post is approved |
| In review | The post or blog is in review |
| Drafting | A linked draft (rejected counts as rework), or an open *Draft with AI* request for the item's opportunity |
| Ready to generate | An intent, plus a service, an opportunity or (for a blog) just the topic |
| Planned | Anything else |

**Billing:** 0062's monthly quota accounting counts the posts and blogs
themselves. The planner adds no count of its own and touches no billing
object.

## Pages

- **Production** (main nav, `/production?week=`): every active or launching
  client's week in one table.
  - Each slot shows `done/target` and chips for the rest by status, with
    "N to plan".
  - It totals across clients and counts what is waiting for review or
    blocked.
- **Planner** (client tab, `/clients/<id>/planner?week=`):
  - The four slots, each with its plan items.
  - Per item: status, purpose, channel, intent, service, keyword,
    destination, Authority link, linked draft, delivered link and the next
    step.
  - Actions: **Link an existing draft**, **Unlink**, **Remove** (only
    without a draft), **Block / Mark delivered**, **Edit details**, and a
    **Plan N more** form per slot.
  - **From Authority** lists ready opportunities that fit a slot. **Plan
    this week** copies the topic, intent, service, keyword and target page
    (site + path).

## The next slices (scoped, not built)

1. **Generate from the plan (Social + GBP).** The item's **Generate** opens
   a CLAUDE task and fires the worker (Tom's call: the worker Routine, not
   a direct model call). The worker drafts through `post-drafter`'s brief /
   check / submit and links the post to the item.
   - **GBP** reuses the current drafter. Authority GBP items reuse
     `authority_apply('request_draft')`.
   - **Social** needs `post-drafter` to learn Facebook / Instagram: channel
     rules, copy that is not a duplicate caption, and the same claim
     governance.
   - **Graphics** come from the Creative Engine's post mode (its own PR).
2. **Blog Drafter v1** — built (`docs/blog-drafter.md`; 0066 + 0067, not applied). The original scope follows.
   - A brief from the plan item: topic, primary keyword, intent, Authority
     opportunity, service page, internal links, governed claims, CTA.
   - The worker drafts: title, slug, meta, H1, outline, body, internal
     links, CTA and claim traceability.
   - A review gate (draft → in review → approved / rejected), mirroring
     0045. Export as Markdown or by Copy.
   - The Wednesday weekly blog writes into review instead of publishing
     (Tom, Oct 3 2026).
   - **Open question:** a new `content_drafts` table, or body columns on
     `content_posts`. Billing's quota already counts `content_posts`.
3. **Web Page Drafter v1.**
   - The same review gate and export.
   - Page types: service, use-case / problem, commercial landing,
     comparison. A location page only from an Authority `location_page`
     opportunity, never a service × city matrix.
4. **Copy / Markdown export** on approved blogs and pages; approved posts
   already have Copy text (Creative Engine PR).

## Tests

| Command | What it covers |
|---|---|
| `npm test` | `tests/content-planner.test.mjs` (4): Central-time weeks, the roll-up, the Authority mapping, form parsing. |
| `npm run test:sandbox` | `content_planner.test.sql` (41): shapes, same-client links, Authority mapping and refusals, one slot per draft, each derived status through the real review gate, holds, who changed what, team-only access. |
| `npm run test:planner-ui` | 11 browser checks: Production 0/2…; plan a GBP post (Ready to generate) and a social post (Planned); plan from Authority; link a draft (Drafting → In review); block / unblock / deliver (Social 1/2); Production follows; remove; separate weeks; portal sees nothing; phone width. |

## To go live (on Tom's approval)

1. Apply 0065, with the dry run and verification as for earlier
   migrations.
2. Regenerate `src/lib/database.types.ts` from production. The planner
   entries in it are hand-written until then.
3. Merge. The Production link and the Planner tab appear on deploy.
