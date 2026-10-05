# Web Page Drafter v1 (Oct 4 2026; Production MVP sprint)

```
Planner / Authority → Generate page draft (page type, new or refresh)
  → the worker writes it (content-drafter) → Human review
  → Approve → ONE change_log row (page_added / page_rewrite) → Copy / Download
```

**Status:** migration 0069 is written and sandbox-tested, but **not
applied**. It sits on 0066–0068 (the Blog Drafter) and 0065 (the Planner).
`content-drafter` v3 is **not deployed**. Nothing publishes.

It is the same drafting foundation as the Blog Drafter
(`docs/blog-drafter.md`): `content_drafts`, the claims as relations, the
drafter-only write, version-pinned approval, reopen and regenerate.

## Page types (v1)

| Type | Rule |
|---|---|
| Service | Names its service (on the plan item). It is the service's page, so it does not link to itself. |
| Location | Only from an Authority `location_page` opportunity (0067). Never a service × city matrix. Only approved places. |
| Use-case / problem | Answers one problem; links its service's page. |
| Commercial landing | One offer of the client's services; no prices (the fact rule). |
| Comparison | Only when justified: an Authority opportunity, or the teammate's reason in the note. Never names a competitor. |

**New or refresh:**

- A **new page** (`page_added`) proposes its URL path.
- A **refresh** (`page_rewrite`) rewrites the plan item's target page and
  keeps its URL; moving it would be a new page.

## Output

| Field | What it is |
|---|---|
| Proposed URL path | e.g. `/services/roof-replacement`; its last segment is the slug |
| Title, meta title, meta description, H1 | |
| Page objective | One or two sentences: what the page is for |
| Section structure | The outline: at least three H2s, each a heading in the copy |
| Complete page copy | Markdown, 400–2,000 words |
| Internal links, CTA | The client's approved pages only; the CTA is the standing CTA |
| Structured data | Optional JSON-LD: `https://schema.org`, an `@type` the page type allows, the client's own name, phone and URLs. Every string goes through the same fact rule, so no address, rating or other client's URL. |
| Claims | The claims it stands on, with their sources |

## Finalization (0069; Tom, Oct 4 2026)

- **Approval writes exactly one `change_log` row:**
  - `change_type`: `page_added` (new) or `page_rewrite` (refresh);
  - `object_type 'site'`, and `object_id` = the draft;
  - `before` = the existing page's URL, for a refresh;
  - `after` = URL, path, title, meta, H1, type, objective, word count,
    draft, version and the approved hash;
  - `reasoning` = the objective, and `evidence` = the claims with their
    sources;
  - `status 'approved'`, and `reviewed_by` / `reviewed_on` = the teammate
    and the time.
- **Exactly one row per draft:** `final_change_log_id` is unique. Approving
  again is a no-op, and a re-approval after a reopen updates the same row.
- **Drafts, regenerations, rejections and review never create a row.** The
  sandbox (P6, P7) and the browser test count the rows at every step.
- **Reopening** returns the row to `proposed`:
  - the Planner slot stops counting (Web Pages 1/1 → 0/1) until the page
    is approved again;
  - Billing's existing rule (0062: approved `page_added` / `page_rewrite`
    rows are completed, the rest planned) counts it as planned meanwhile.
  No Billing object changes.
- The final row is approval's alone: a teammate cannot set or clear
  `final_change_log_id`, or change a draft's kind or new / refresh.

## Pages

- **Planner:** a web page item with an intent has **Generate page draft**:
  the page type, new or refresh (refresh needs the item's target page),
  and a note. An item with a draft has **Open the draft**.
- **Draft page:**
  - the proposed URL, objective, sections, a copy preview, the JSON-LD and
    the final record ("new page in the change log (approved)");
  - edit covers the path, objective and JSON-LD too;
  - **Download .md** front matter adds `url_path`, `page_type`, `change`,
    `objective` and `structured_data` (JSON, valid YAML).

## Tests

| Command | What it covers |
|---|---|
| `npm test` | `tests/content-drafter.test.mjs` adds 5 page tests: the brief (type, new / refresh, schema types, links, CTA, refusals), path / slug / objective / refresh URL, structured data (types, schema.org, off-site URLs, address, ratings, phone), the handler writing the page fields, the page export. |
| `npm run test:sandbox` | `content_drafts.test.sql` sections D (D5–D6) and G, plus P1–P8: the request rules (R7), the 250-word floor, ONE `page_added` row with its fields, a no-op re-approval, the row approval's alone, reopen → `proposed`, re-approval updating the same row, a refresh's `page_rewrite` naming the existing page, no row in review or on rejection. |
| `npm run test:page-drafter-ui` | 8 browser checks, end to end with the real handler: Generate → write → review → reject / revise / edit (objective, JSON-LD) / submit → Approve (one row, Web Pages 1/1) → Download → reopen (`proposed`, 0/1) / regenerate / re-approve (the same row) → a refresh (`page_rewrite`, URL kept) → portal refused, phone width. |

## To go live (after 0065–0068, on Tom's approval)

1. Apply 0069 with the standard preflight, verification and rollback
   probes.
2. Regenerate the types.
3. Deploy `content-drafter` (v3).
