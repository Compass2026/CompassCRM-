# Claims Registry v1

COMPASS-2027-ROADMAP W1 (Living Client Intelligence), P1.1a. Executive OS
task `11454716` (P0.3): proposal `ae049b45`, ChatGPT architecture decision
`cabb4e9a` (Nov 3 2026). Migration `20261103220000_claim_registry.sql`.

## What it is

A read-only view of every claim a client has, on the existing **Intelligence**
tab: its source, who verified it and when, when it is due for review, which
brand site may use it, which posts and drafts cite it, and indicators for
contradictions and structured-field conflicts. It extends `claims`; there is
no second claims table.

**It changes no gate.** What a post or draft may cite is still decided by
`social_post_grounding_problems` / `content_draft_problems`: a confirmed claim,
or a sourced one with a source, never an unverified one. The registry reports
that rule as `legacy_usable` and does not read or change it. The migration's
verify block hashes every function that reads `claims` (or `claim_ids`) before
and after and refuses to commit if any changed.

## Pieces

| Piece | What |
| --- | --- |
| `claim_review_intervals` | One reviewed row per claim kind: how often it is reviewed, and which verification methods are authoritative for it. Team read; changed only by a reviewed migration. |
| `claims` columns | `kind`, `verification_method`, `verified_at`, `verified_by`, `review_by`, `superseded_by`. All nullable and **empty**: no backfill. |
| `claims_registry_guard` | Only a signed-in teammate (or the database owner) may set those columns. `verified_by` is stamped from the session (`task_actor()`); a caller cannot name someone else. Edge Functions (service role) and the worker's own SQL are refused (42501); their ordinary claim edits are unaffected. |
| Claim history | The existing `creative_governance_events` store, `subject_type = 'claim'`: created / updated (field diffs) / deleted, actor from the session, append-only, written only by trigger, team read. A deleted claim keeps its history; a deleted client takes its history with it. |
| `claim_registry(client, today?)` | STABLE, security invoker, team only (42501 otherwise), no execute for anon. |
| Intelligence tab | "Claims registry" section: per-site counts and the claims grouped by bucket. No control of any kind. |

## Review intervals (ChatGPT D1)

A review is a prompt to re-check, not an expiry of the fact. A verified
document's own expiry goes on `claims.review_by`; the earlier date wins.

| Kind | Review | Authoritative methods |
| --- | --- | --- |
| `rating_review` | 30 days | platform record |
| `offering` | 90 | client confirmation, client contract |
| `contact_identity` | 90 | verified structured record |
| `service_description` | 180 | client confirmation, client's published page |
| `warranty_guarantee` | 180 | client contract, manufacturer document |
| `experience_stat` | 365 | client confirmation |
| `credential` | 365 (or the document's expiry) | issuer record |
| `reference_fact` | 365 | issuer record |
| unclassified (no kind) | 90 | none: never verified until classified |

The methods implement D2 (fact-type authoritative evidence): the signed
project agreement governs a client's own workmanship term, a manufacturer
document governs product coverage, the issuer governs a licence, verified
structured records govern NAP. Anything else is supporting evidence.

## Buckets

One per claim, first match wins:

1. **superseded**: `superseded_by` is set.
2. **unverified**: status unverified.
3. **missing_source**: sourced with a blank source (today's rule refuses it).
4. **stale**: a verification whose review date has passed.
5. **needs_review**: citable today but not verified for the registry. That is: never verified, unclassified, verified by a method that is not authoritative for the kind (a confirmation from before the registry records none), or its text / source changed after verification (a material change asks for re-verification at once).
6. **due**: verified, review within 14 days.
7. **verified**: classified, verified by an authoritative method, current.

A sourced claim is never verified because it has a URL. A legacy confirmation
(`status = confirmed`, `confirmed_on`) counts as a verification date for
freshness but not as an authoritative verification, so until PR2 classifies
and verifies claims **no claim is in the verified bucket**. That is the true
state, not a defect.

## Indicators (never decisions)

- **Source class**: client's own website (any host on `clients.website_url`, `sites.url` or a brand workspace), Google listing, government site, third-party website, search or listing summary, confirmation note, note, none.
- **Contradictions**:
  - `superseded_by` (the record);
  - `named_as_superseded`: another claim's text or source says it supersedes this one by its id, or by the id's first eight characters as a word when they name only one of the client's claims;
  - `conflict_noted`: the text mentions a conflict or inconsistency.
- **Structured-field precedence (D6)**: a phone in a claim is compared with the client's and its brand workspaces' phones. A match is a duplicate (the record governs); a different number is flagged. Nothing is retired automatically.
- **Affected content**: posts (`post_claims`) and drafts (`content_draft_claims`) with their review / publish state, published URL and a CRM link. `cited_while_unusable` / `published_while_unusable` mark content standing on a claim today's rule would refuse. Corrections belong to the content team; the registry does not touch content.

## Site programs (BHG)

A client with brand workspaces gets one program per workspace, scoped by the
workspace's `claim_ids` (authoritative for now, D4). A claim in two
workspaces is **shared** and labelled; a claim in none is **unassigned** and
counted for no program. A draft workspace's counts are null (unknown), shown
as "—", never 0. A client without workspaces is one program.

## Not in v1

- PR2: owner-approved writers for classification, verification, supersession and retirement.
- PR3: proof objects and media provenance (the Proof Library, W3).
- PR4: readiness integration.
- PR5: fail-closed enforcement, only after a real client impact report.
- Service and market scope on claims is deferred (no unchecked uuid arrays).
- Website pages are not linked to claims yet.

## Tests

- `supabase/tests/sandbox/claim_registry.test.sql`:
  - native in `scripts/test-portal-sandbox.sh`, and through PGlite in `tests/claim-registry-database.test.mjs`;
  - buckets, freshness, source classes, indicators, affected content, three brand sites;
  - the guard as person / Edge Function / worker, and history;
  - approval hashes unchanged, access, no writes, client delete, down then up.
- `tests/claim-registry.test.mjs`: the labels, held to the SQL (every bucket, reason and source class has words; unknown is "—").
- `tests/claim-registry-ui.mjs` (`npm run test:claim-registry-ui`): the tab on a replayed database through PostgREST. No control in the section, links to the published post and drafts, three brand sites, phone width, no writes. Screenshots: `docs/screenshots/claim-registry/`.

## Rollback

`supabase/rollback/20261103220000_claim_registry.down.sql` drops the
function, triggers, columns and intervals table. The claim history rows stay,
and so does `'claim'` in the event store's subject check.
