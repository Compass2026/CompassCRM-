# PR2b: Confirm, supersede and retire claims (design for review)

**Status: design only.** Nothing here is built, migrated or deployed. It is
for ChatGPT's architectural review and then Tom's decision. It builds on PR2a
([pr2-controlled-claims-verification.md](pr2-controlled-claims-verification.md),
released Nov 6 2026; first real use A7 on Nov 16 2026).

## 1. Scope

PR2b adds the three owner decisions that PR2a deliberately left out, because
each one **changes what content may cite**:

| Decision | From | To | What content sees |
| --- | --- | --- | --- |
| **Confirm** | `unverified` | `confirmed`, verified | The claim becomes citable |
| **Supersede** | any citable claim | `unverified`, `superseded_by` = the replacement | The old claim stops being citable; the replacement is named |
| **Retire** | any claim | `unverified`, retired | The claim stops being citable, with no replacement |

It also carries the hardening that A7 showed is needed (§8).

**Out of scope:**
- Claude proposals (PR2c).
- The Proof Library (PR3).
- Any change to the content approval rules.
- Editing, unpublishing or re-linking any post or draft.
- Bulk decisions, and delegation of authority.
- Remediation of already published content. Lucas's live Business Profile post on the Lifetime claim stays with the Authority rollout team.

## 2. Constraints carried forward

- **Owner only.** Every PR2b writer requires a signed-in human session and Tom's live authority, as in PR2a. Claude, the worker, Edge Functions, the service role and Executive OS are never a reviewer.
- **Append-only ledger.** Each decision is a `claim_reviews` row, and `claims` stays a projection checked by `claims_registry_guard`.
- **No content approval rule changes.** The gates are untouched: `social_post_grounding_problems`, `content_draft_problems`, `creative_overlay_problems`, `content_edit_execute` and `site_program_readiness`. Approval hashes are untouched too.
- **Published history preserved.** Nothing published is edited, unpublished or re-pointed. It is listed for the content team.
- **Existing locks intact.** `claims_zz_recheck_posts` keeps pulling approved-but-unpublished posts back to review when what they stood on changes, and keeps recording `grounding_lapsed` on published ones. PR2b relies on that, not on new content logic.
- **Nothing automatic.** No decision is taken by a schedule, a trigger or an expiry.

## 3. The finding that shapes the design

Read from production on Nov 16 2026: every content gate decides citability
from `claims.status` alone ("confirmed, or sourced with a source, never
unverified"). **None reads `superseded_by`.** `claims.status` has only three
values: `sourced`, `unverified` and `confirmed`.

So a claim can be made uncitable without touching any gate only by setting its
status to `unverified`. **Recommendation:** supersede and retire set
`status = 'unverified'` and record the reason in the ledger and projection.
The registry shows such a claim as *superseded* or *retired*, never as merely
unverified. The alternative, a new `retired` status taught to five gates, is
a gate change and is listed as Q1.

## 4. The three writers

All are security definer with a fixed `search_path`, execute granted to
`authenticated` only. They run the PR2a check order: human session → owner
authority → `for update` lock → expected fingerprint and review id (`CV409`)
→ not superseded → evidence rules. Added to that order:

- The **impact token** (§5). The writer recomputes it, and a mismatch is `CV409`.
- The claim's own **status write**, made in the same transaction as the ledger row. The guard accepts it only when it equals that row's projection.

### Confirm

`claim_confirm(claim, method, evidence_id, excerpt, observed_on, expires_on, contact, note, expected_fingerprint, expected_review_id, impact_token)`

- Requires a classified claim with status `unverified`, an authoritative method and evidence passing PR2a §6. The evidence rules are the same as for verify.
- Writes one row, `action = 'confirm'`, which is also the verification in force.
- Projects `status = 'confirmed'`, the PR2a verification columns, and `confirmed_by` / `confirmed_on` (Tom, now), so v1 readers stay consistent.
- Effect on content: the claim becomes citable. Drafts and in-review posts that already cite it lose that grounding problem. Nothing is approved or published by it.

### Supersede

`claim_supersede(claim, replacement, reason, expected_…, impact_token)`

- The replacement must:
  - belong to the same client;
  - not be superseded or retired;
  - be citable now;
  - have the same `kind`, and the claim being replaced must be classified.
- The replacement must also be independently verified (Q2). The A7 example qualifies: e7da11c6 would supersede the Lifetime claim 64d13e2d.
- Writes one row, `action = 'supersede'`, with `replacement_claim_id`. It clears any verification in force on the old claim.
- Projects `superseded_by = replacement` and `status = 'unverified'`.
- The status write fires the existing recheck:
  - approved posts not yet published go back to *in review*;
  - in-review posts show the grounding problem;
  - published posts get a `grounding_lapsed` event.
- **Links are not rewritten.** No post or draft is moved to the replacement automatically. The correction list names the replacement so the content team can.

### Retire

`claim_retire(claim, reason, expected_…, impact_token)`

- Supersede without a replacement: `action = 'retire'`. It projects `retired_at` (new) and `status = 'unverified'`.
- It is for claims that are false or no longer offered and have no true successor.

**Not in PR2b:** reversing a supersession or retirement (Q4). Until then, the
way back is a new claim, recorded and confirmed on its own evidence.

## 5. Whole-content impact preview

Each of the three decisions changes what content may cite. So each one shows
Tom the whole effect first and pins what he saw.

- **`claim_impact(claim, action, replacement)`** is a stable, team-readable function. It returns every dependent item, grouped by what will happen:
  - Posts via `post_claims`, by review and publish state, with the published URL. Outcomes: *returns to review*, *shows a grounding problem*, *published: recorded and listed for correction*.
  - Blog and page drafts via `content_draft_claims`, by state.
  - Creative overlays and content edits that quote the claim.
  - Site-program readiness: whether any client area changes readiness.
  - For confirm: the content that becomes grounded.
- **`impact_token`** is a SHA-256 over canonical JSON of:
  - the affected set, as (table, id, state, the hash the item is approved on);
  - the claim's and the replacement's fingerprints and review ids.

  The writer recomputes it. Content that changed between preview and decision gets `CV409`, "the impact changed, review it again".
- **The decision stores what was shown:** `claim_reviews.impact` (jsonb) and `impact_sha256`. The audit answers "what did Tom know when he decided".
- **UI:** the decision form opens on the preview, not the fields. Recording requires a deliberate confirmation naming the counts, for example "3 posts return to review, 1 published post is listed for correction".

## 6. Locks

- **Superseded and retired claims become read-only to ordinary edits.** Today any teammate can change a claim's status. Without a lock, a status edit back to `confirmed` would silently make a retired claim citable again. The extended guard refuses changes to `status`, `claim` and `source` on a superseded or retired claim except through the owner writers. This is the one new restriction on ordinary edits, and it is listed as Q3.
- Deleting a claim with review history is already refused (`claims_keep_reviewed`).
- The PR2a rule stays: a status change after verification needs the owner's fresh review (§12e). Confirm, supersede and retire are those reviews.

## 7. Correction list (read-only)

Published content that cites a superseded or retired claim appears in three places:
- in the registry, with the existing `published_while_unusable` marker;
- in the decision's stored impact;
- in a "Needs correction" group on the client's Content view, with the replacement named when there is one.

It is a list for the content team. PR2b never edits, unpublishes, re-links or
posts anything.

## 8. Hardening from A7 (first real verification, Nov 16)

| # | What happened | Change |
| --- | --- | --- |
| H1 | The excerpt saved the form's placeholder text ("Quote the words that support the claim"), and the database accepted it | `claim_verify` / `claim_confirm` refuse an excerpt equal to the placeholder, shorter than 20 characters, or equal to the note. The UI makes the same checks before sending. |
| H2 | The correction's note was pasted into the excerpt | The note gets its own labelled field. Recording first shows a read-back: "You are recording: method, evidence (label + SHA-256), excerpt, note". |
| H3 | A prefilled form was lost and the decision came from another window | The form keeps unsent values across re-renders and reloads (per claim and review id, in session storage). A stale screen's `CV409` says plainly "this form is out of date; reload". |
| H4 | The CRM had no way to look at an evidence file, so it was inspected in the Supabase dashboard | A team-only **View** on each evidence row: the `claim-evidence` function returns a 60-second signed URL. Each view is logged; the bucket stays private. |
| H5 | The file picker in the Claude app's built-in browser re-encoded a PNG as JPEG, and nobody noticed until the hashes were compared | Before upload, the form shows the picked file's name, type, size and the SHA-256 computed in the browser. Tom can paste the expected SHA-256 (optional), and a mismatch is refused before upload. The registered row keeps the picked name. |
| H6 | The decision form was opened twice (prefilled tab and another window) | The registry shows "decision in progress elsewhere" only as a hint. The real guard stays the fingerprint and review-id check, which worked. |

## 9. Data model changes

- `claim_reviews.action` gains `confirm`, `supersede` and `retire`. New columns: `replacement_claim_id`, `impact` (jsonb) and `impact_sha256`.
- `claims` gains `retired_at`, a projection column under the guard. `superseded_by` becomes writable through the guard.
- `claims_registry_guard` is extended:
  - status writes are allowed only as the projection of a confirm / supersede / retire row in the same transaction by the same owner;
  - the §6 lock applies.
- `claim_registry` v3 adds the *superseded* and *retired* buckets from the ledger, the replacement link and the correction list.
- `claim-evidence` gains a `view` mode.
- No change to the content gates, `post_claims`, `content_draft_claims`, approval hashes or publishers. The verify block hash-pins every function that reads `claims`, as PR2a did.

## 10. Acceptance tests (outline)

- **Confirm:**
  - refused unless the claim is unverified and classified, with an authoritative method and intact evidence;
  - refused by a stale impact token (`CV409`);
  - makes the claim citable; approves nothing.
- **Supersede:**
  - refused across clients, onto a superseded, retired or uncitable replacement, across kinds, or (with Q2) onto an unverified replacement;
  - pulls approved, unpublished posts back to review through the existing trigger;
  - records `grounding_lapsed` on published posts;
  - rewrites no link.
- **Retire:** the same as supersede, without a replacement.
- **Lock:** a teammate's status edit on a superseded or retired claim is refused. Ordinary edits on other claims are unchanged.
- **Authority:** non-owner, worker, service-role and Claude sessions are refused on every writer, as in PR2a.
- **Regression:**
  - content gate function hashes unchanged;
  - `legacy_usable` unchanged for every claim not decided;
  - PR2a suites pass.
- **H1–H5** each have a refusal test. The UI tests cover the read-back, preserved form values and the pre-upload hash.

## 11. Release

The same staged pattern as PR2a, each step authorized separately:
1. read-only preflight;
2. migration;
3. merge and deploy;
4. function deploy;
5. fictional-client smoke test, then cleanup;
6. docs.

Rollback is permitted only while no PR2b decision is recorded; after that, fix
forward. The first real use, separately authorized, would be Tom superseding
the Lifetime Workmanship claim with the verified 3-Year claim.

## 12. Questions for ChatGPT

- **Q1.** Make claims uncitable by `status = 'unverified'` with the reason in the ledger (no gate change, recommended)? Or add a `retired` status and change five gates?
- **Q2.** Must a replacement be independently verified (recommended), or only citable?
- **Q3.** Lock ordinary edits on superseded and retired claims (recommended), or leave them editable and rely on the registry's "status changed since decided" warning?
- **Q4.** Reversal (reinstate) in PR2b, or later?
- **Q5.** Should confirm also accept `sourced` → `confirmed`? It does not change citability, so the recommendation is to leave it to the existing confirmation path.
- **Q6.** Ship H1–H5 as a small PR2a.1 ahead of PR2b (recommended: they protect every verification from now on), or inside PR2b?
