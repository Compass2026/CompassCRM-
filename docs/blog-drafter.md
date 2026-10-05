# Blog Drafter v1 (Oct 4 2026; Production MVP sprint)

```
Planner / Authority → Generate draft → the worker writes it (content-drafter)
  → Human review (reject / revise / edit / regenerate / submit)
  → Approve → ONE final content_posts row → Copy / Download Markdown
```

**Status:** 0066 and 0067 are written and sandbox-tested, but **not
applied**. The `content-drafter` Edge Function is **not deployed** (it is
on the deploy workflow's list). Nothing publishes.

## Model (Tom's decisions, Oct 4 2026)

- **`content_drafts` (0067)** is the mutable drafting state for blogs and,
  next, web pages. Each draft holds:
  - its plan item;
  - the brief inputs: topic, primary keyword, intent, service, Authority
    opportunity, the teammate's note;
  - the written article: title, slug, meta title and description, H1,
    outline, Markdown body, internal-link recommendations, CTA, structured
    data for pages;
  - `version` (every content change bumps it);
  - the drafter's brief, its hash, the runtime label and the lint result;
  - the review and approval metadata (who, when, the approved version, a
    hash and snapshot).
- **Claims are relations.** `content_draft_claims` holds the claims a draft
  stands on, each the client's own. The approval snapshot copies their text
  and source.
- **Draft attempts never count toward Billing.**
  - Billing's monthly quota (0062) counts Compass `content_posts` rows and
    open `blog_post` tasks. Drafts touch neither, however often they are
    generated, rejected, revised or regenerated.
  - Only `content_draft_approve` creates a `content_posts` row: **one per
    draft**, status `approved` (new in 0066), origin `compass`, the plan
    item's date as its due date.
  - It is idempotent. The draft is locked, the version pinned, and
    `final_content_post_id` is unique. Re-approving after a reopen updates
    the same row. The plan item links the final row.
  - Billing counts that row as planned until it is published, then as
    completed (Billing's existing rule; unchanged).
- **Web pages: approved target.** The final record will be one `change_log`
  row: `page_added` for a new page, `page_rewrite` for a substantial
  refresh. Billing already counts those rows. Draft attempts will never
  create one. The Web Page Drafter builds that promotion. Until then, an
  approved page draft records its approval and creates nothing.

**Who writes what** (the database refuses everything else):

| Who | What |
|---|---|
| A teammate | Generate (`content_draft_request`): one live request per plan item, a CLAUDE task `content_draft:<id>`, a worker fire. A location page needs an Authority `location_page` opportunity, never a service × city matrix. |
| The content-drafter function only (the drafter session) | `content_draft_write`: the brief, the content, the lint, the claims, then in review. It closes the request task. |
| A teammate | Edit content and claims while a draft or rejected (bumps the version); submit; withdraw; reject (a note is required); revise; regenerate (`content_draft_regenerate`, with a note); approve (`content_draft_approve`, the version they saw); reopen; delete an unapproved draft. |
| The worker's own SQL | Nothing. |

**Grounding** (`content_draft_problems`, checked at submit and approval):

- a title, slug, meta title (≤ 70) and meta description (≤ 170);
- an H1 and a body; a blog body of at least 300 words;
- every linked claim usable;
- for an informational, commercial or transactional draft, at least one
  claim linked.

## content-drafter (Edge Function)

Modes are `version`, `brief`, `check` and `submit`, as in `post-drafter`.
Callers are the worker (`x-cron-secret`) or a teammate (JWT on
`team_members`).

**Brief:**

- **Reused from `post-drafter`:**
  - the canonical loader (`client_intelligence_input`);
  - the per-draft gate: approved brand board, voice, facts and content
    rules ready;
  - the claim rule (`eligibleClaims`, extracted from `post-drafter`'s brief
    with no behaviour change; its 62 tests pass).
- **Links:** only the client's own pages. The approved services' pages,
  approved page groups, published articles and the home page. The
  service's page is required.
- **The CTA** is the brand board's standing CTA.
- **Rules:** 700–2,000 words (aim for 800–1,400), meta title ≤ 60 (70
  hard), meta description 120–160 (70–170 hard), at least three H2s.

**Lint:**

- **Reused from `post-drafter`:** the detectors (`rules.ts`) and the place
  rule, applied to every word a reader sees: title, meta, H1, headings,
  body and CTA. Facts appear only inside the exact words of a linked claim
  or as CRM facts: no prices, numbers, years, guarantees, licences,
  response times, reviews, materials, superlatives or diagnoses, and no
  unapproved places.
- **The article's own rules:**
  - structure: slug, lengths, H1 not in the body, the outline matching the
    body's headings;
  - links to approved pages only, the required link present, no bare URLs;
  - the standing CTA;
  - the keyword limit.

**Submit:**

- A stale brief → `409`.
- Lint problems → `422`, and nothing is written.
- Otherwise one `content_draft_write`.

The worker's playbook is *Content draft request* in
`.claude/skills/foundation-worker/SKILL.md`.

## Pages

- **Planner:**
  - A blog item that is Ready to generate has **Generate draft**, with an
    optional note.
  - An item with a draft has **Open the draft** and its status.
  - The board reads drafts: requested, draft or rejected → Drafting; in
    review → In review; approved (or the final row approved) → Approved;
    published → Delivered.
- **Draft** (`/clients/<id>/drafts/<draftId>`):
  - The brief, and the article: slug, meta with character counts, outline,
    the H1 and a Markdown preview (text only, http(s) links only), the CTA
    and the internal-link recommendations.
  - The claims with their sources, the drafter's warnings, and "not ready"
    problems.
  - Review: Submit, Withdraw, Approve, Reject, Revise, Regenerate, Reopen,
    Delete. Edit is a form with every field and the claim checkboxes.
  - **Copy Markdown** and **Download .md**: front matter (title, slug, meta
    title and description, primary keyword), `# H1`, the body and the CTA
    link.
- **Content tab:** shows the final article with status *approved* until it
  is published.

## Tests

| Command | What it covers |
|---|---|
| `npm test` | `tests/content-drafter.test.mjs` (9): the brief (gate, claims, links, CTA, refusals, hash), the lint (every factual refusal, structure, links, CTA, keyword), the handler (callers, stale brief, lint failure writes nothing, one write), the Markdown export. `tests/content-drafts-lib.test.mjs` (2): actions per status, the safe Markdown preview. |
| `npm run test:sandbox` | `content_drafts.test.sql` (33): request / regenerate, the drafter-only write, grounding, version-pinned idempotent approval to ONE row, reopen / re-approve, reject, web pages with no final record, Billing sees one article, team-only access. `portal_access.test.sql` lists the three team-callable draft functions (D11g). |
| `npm run test:blog-drafter-ui` | 8 browser checks, end to end with the real handler: Generate → the worker writes → review → Copy / Download → reject / revise / edit / submit → Approve (one row, Blogs 1/2) → reopen / regenerate / re-approve (the same row) → portal refused, phone width. |

## To go live (on Tom's approval)

1. Apply 0065 (planner), then 0066, then 0067, each with the standard
   preflight, verification and rollback probes.
2. Regenerate `src/lib/database.types.ts`. The planner and draft entries are
   hand-written until then.
3. Deploy `content-drafter` through the deploy workflow; check
   `{"mode": "version"}`.
4. The worker picks up *Content draft request* tasks on the next fire (the
   skill is versioned here).

## Not in this slice

- **The weekly blog (`blog_post`, 0035 / 0062)** still writes and files its
  post itself. Tom decided (Oct 3) it should write into review instead.
  Moving it onto `content_drafts` needs one more decision: when the weekly
  `blog_post` task closes, given that Billing counts an open `blog_post`
  task as planned until a `content_posts` row exists.
- **Web Page Drafter v1:** the same foundation, the `change_log` promotion
  above, and page types (service, use-case, commercial landing,
  comparison; location only from a `location_page` opportunity).
- **Automatic website publishing.**
