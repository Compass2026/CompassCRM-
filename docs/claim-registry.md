# Claims Registry v1

COMPASS-2027-ROADMAP W1 (Living Client Intelligence), P1.1a. Executive OS
task `11454716` (P0.3): proposal `ae049b45`, ChatGPT architecture decision
`cabb4e9a`, PR #218 review `42aca6fb` (Nov 3 2026). Migration
`20261103220000_claim_registry.sql`.

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
| `claims_registry_guard` | **Locked until PR2** (replaced by PR2a's projection guard, below). No application caller may set those columns: not a signed-in teammate (the CRM's forms or a direct PostgREST write), not an Edge Function (service role), not the worker's SQL (42501). Only a superuser session can, which the CRM never is; the sandbox suites use it to seed fixtures. Ordinary claim edits are unaffected. PR2 replaces the lock with guarded, audited, owner-approved writers tied to evidence. |
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
5. **needs_review**: citable under current rules but not independently verified. That is: never verified, unclassified, verified by a method that is not authoritative for the kind (a confirmation from before the registry records none), or its text / source changed after verification (a material change asks for re-verification at once).
6. **due**: verified, review within 14 days.
7. **verified**: classified, verified by an authoritative method, current.

Each claim answers two separate questions (ChatGPT `42aca6fb` B):

- **Citable under current rules** (`legacy_usable`): today's gate rule, unchanged. Existing drafting, approval and publishing behave exactly as before.
- **Independently verified** (`verification_state`): a recorded, authoritative method. It is never true for a legacy confirmation or a URL alone.

A legacy confirmation (`status = confirmed`, `confirmed_on`) dates freshness
but reads "method not recorded". With the columns locked, **no claim is
independently verified** until PR2. That is the true state, not a defect. A
method token alone will not be verification in PR2 either: it must link
authoritative evidence specific to the subject and an authorized reviewer
(`42aca6fb` A).

## Indicators (never decisions)

- **Source class**: client's own website (any host on `clients.website_url`, `sites.url` or a brand workspace), Google listing, government site, third-party website, search or listing summary, confirmation note, note, none.
- **Contradictions**:
  - `superseded_by` (the record);
  - `supersession_mentioned`: **tentative**. Another claim's text or source says it supersedes this one, by its id or by the id's first eight characters as a word when they name only one of the client's claims. It never sets a bucket, gates nothing and migrates nothing; only `superseded_by` marks a claim superseded (`42aca6fb` C);
  - `conflict_noted`: the text mentions a conflict or inconsistency.
- **Structured-field precedence (D6)**: a phone in a claim is compared with the client-wide numbers (the client and its brand workspaces) and with each approved location's own number (`citation_locations`).
  - A client-wide match is a duplicate: the record governs.
  - A match with an **approved** location's number is that location's: no conflict. Approved means `status = 'active'`, `approved_at` set and a recorded approver (`approved_by`). `approved_at` defaults to `now()` on every row, so the approver is what proves an approval. An active location with no approver, or an archived one, does not count.
  - Anything else is only a **potential mismatch**, because other location-specific numbers (for example a GBP location phone) are not evaluated yet.
  - Nothing is retired automatically.
- **Affected content**: posts (`post_claims`) and drafts (`content_draft_claims`) with their review / publish state, published URL and a CRM link. `cited_while_unusable` / `published_while_unusable` mark content standing on a claim today's rule would refuse. Corrections belong to the content team; the registry does not touch content.

## Site programs (BHG)

A client with brand workspaces gets one program per workspace, scoped by the
workspace's `claim_ids` (authoritative for now, D4). A claim in two
workspaces is **shared** and labelled; a claim in none is **unassigned** and
counted for no program. A draft workspace's counts are null (unknown), shown
as "—", never 0. A client without workspaces is one program.

## Verification (PR2a, `20261104200000`)

ChatGPT's PR2 architecture review (Executive OS 11454716) approved the design in
`docs/proposals/pr2-controlled-claims-verification.md` with three refinements:
Tom is the only verification authority, evidence is a private SHA-256-pinned
upload, and review history is never deleted.

| Piece | What |
| --- | --- |
| `claim_verification_authorities` | Who decides: the owner (Tom) only. Written only by a reviewed migration (this one seeds team member `d73e1bf1`). One active owner. Delegation (`delegate`) is designed for, not built. |
| `claim_evidence` + `claim-evidence` bucket | Uploaded files at `<client>/<sha256>.<ext>`, private, team read, no write policy. Registered only through the service role (the `claim-evidence` Edge Function, after it re-hashes the stored bytes), answering a teammate's own upload request, which supplies the uploader; never replaced or deleted once registered. `document` or `capture` (a page or listing, with URL and capture date). |
| `claim_reviews` | The append-only decision ledger: classify / verify / review / revoke. Reviewer, authority, time and txid stamped by trigger. Each decision is also a `creative_governance_events` row. |
| `claims.review_id` + the projection guard | The registry columns change only to match a review written in the same transaction by the same owner. A claim with review history cannot be deleted. |
| `claim_classify` / `claim_verify` / `claim_revoke` | Security definer, for a signed-in owner only. The registry's `fingerprint` and `review_id` are passed back (a stale screen gets `CV409`). **None changes `claims.status`, text or source.** |
| `claim_registry` v2 | The review in force and its evidence; integrity reasons; `viewer.can_review`; the client's evidence files and approved locations. |
| Intelligence tab | **Claim evidence files**: any teammate uploads, with the hash shown and a re-check. On each registry row, for the owner only: Classify, Verify / Re-review, Revoke. Everyone else sees the decisions read-only. |

### Evidence each method needs (enforced in `claim_verify`)

| Method | Evidence |
| --- | --- |
| client contract, manufacturer document | An uploaded document, intact |
| client confirmation | An uploaded document and the client contact's name |
| client's published page | A capture of the claim's own site (its brand site's, for BHG), from the last 30 days |
| platform record, issuer record | A capture of a site that is not the client's own, from the last 30 days |
| verified CRM record | An approved, active location on the claim's brand site (or client-wide) whose phone the claim states; identity version pinned by SHA-256 |

These hold for every method:

- An excerpt and the day the evidence was examined are required.
- An expiry, if given, must be after both that day and today; it becomes `review_by`.
- A claim must be classified before it is verified.
- Verifying an `unverified` claim is refused: confirming it changes what content may cite, so it comes in PR2b with its impact review.

### Registry v2 reasons

- `verification_unrecorded`: verification columns set outside the ledger (needs review, never verified);
- `evidence_file_changed`, `evidence_location_changed`, `scope_changed_since_verified`: needs review;
- `evidence_expired`: stale;
- `changed_since_verified`: now also read from the fingerprint.

### Tests

- `supabase/tests/sandbox/claim_verification.test.sql` runs natively and through PGlite (`tests/claim-verification-database.test.mjs`, which also proves the rollback refuses once history exists).
- `tests/claim-evidence-handler.test.mjs` tests the Edge Function's request boundary.
- `tests/claim-verification.test.mjs` tests the words and options, held to the SQL.
- `tests/claim-verification-ui.mjs` (`npm run test:claim-verification-ui`) runs the browser flow: upload, classify, a refusal, verify, a second admin, phone width. Screenshots: `docs/screenshots/claim-verification/`.

### Rollback

`supabase/rollback/20261104200000_claim_verification.down.sql` restores v1
(the lock, the v1 registry) while nothing has been recorded. Once any review
or evidence exists it refuses, because history is never deleted; fix forward.

## Not in v1

- PR2: owner-approved writers for classification, verification, supersession and retirement (PR2a above: classification, verification, revocation).
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
