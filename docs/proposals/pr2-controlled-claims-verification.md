# PR2 — Controlled Claims Verification

COMPASS-2027-ROADMAP W1, P1.1b. Follows Claims Registry v1 (PR #218, merged as
`77a6992`, migration `20261103220000`, verified live Nov 4 2026).

| Revision | Date | What |
| --- | --- | --- |
| 1 | Nov 4 2026 | Proposal, Executive OS P0.3 result `12222fff` |
| 2 | Nov 4 2026 | ChatGPT architecture review: approved with three required refinements (owner authority, SHA-256 evidence with a working upload, history kept). This revision records them and scopes PR2a as built. |

Status: **PR2a is implemented as a draft PR. Nothing is merged, no migration is
applied, nothing is deployed, and no production data has changed.**

## 1. Recommendation in one paragraph

One append-only decision ledger, **`claim_reviews`**. The six registry
columns on `claims`, plus a new `review_id`, become a **projection** of it, and a
guard accepts a change only when it matches a ledger row that the same person
wrote in the same transaction. Only **the verification owner (Tom)** can write
ledger rows. That is recorded in `claim_verification_authorities` by a reviewed
migration, and checked in a signed-in human session through security-definer writers. Being an
admin is not enough. The worker, Edge Functions, the service role, Executive OS
instructions and Claude are never a reviewer. **Authoritative evidence is an
uploaded private file, pinned by SHA-256**: the CRM computes the hash itself from the
stored bytes, the file's path is its hash, and once registered it can't be
replaced or deleted. Web pages and listings count only as a **captured record**: an
uploaded capture with its URL and capture date, never a live URL or a Drive
link. Audit history stays in `creative_governance_events`. **A claim with review history
is never deleted**: retire / supersede come in PR2b. Content gates and approval
hashes don't change. PR2a never writes `claims.status`.

## 2. Starting point (production, read-only, Nov 4 2026)

| Fact | Value |
| --- | --- |
| Claims | 170. All six registry columns empty. 0 independently verified (the true state). |
| Team | 2 members, both `admin`: Thomas (`d73e1bf1`) and Jennifer. |
| Evidence today | `documents` bucket: private but team-writable (update/delete policies), 0 uploaded files, 17 Drive links. **No immutable evidence store exists.** |
| Precedent | `creative-assets` (0054): private, team read, no write policy, service-role uploads, an immutability trigger on `storage.objects`. PR2a copies this pattern. |
| Structured records | `citation_locations` with an append-only identity history (`citation_location_identities`, one row per `identity_version`). |
| Claim history | `creative_governance_events`, subject `claim`, written by trigger |

## 3. Decisions (ChatGPT review, Nov 4 2026)

| # | Decision | Outcome |
| --- | --- | --- |
| D1 | Ledger + projection vs jsonb-only | **Ledger approved.** `claim_reviews` + existing governance audit. |
| D2 | Reviewer authority | **Tom is the final verification authority.** It is not every admin, Claude, an Edge Function or an EOS instruction. It uses the simplest secure owner pattern Compass already has: reviewed configuration that only a migration changes (like `claim_review_intervals`). Delegation must be explicit and auditable, and is designed for, not built. |
| D3 | Evidence | **Private upload, immutable, SHA-256.** It needs a working upload and selection flow. A Drive link or mutable URL is never verification without a durable captured record. |
| D4 | PR2a and `claims.status` | **No status write.** An unverified claim never becomes confirmed automatically; that's PR2b, with the content-impact review. |
| D5 | EOS-delegated verification | **No.** |
| D6 | Deleting a reviewed claim | **Refused.** Any review history (classification included) keeps the claim; retirement is PR2b. |
| D7 | Captures for URL methods | **Required** (from D3): `client_published`, `platform_record` and `issuer_record` need an uploaded capture. |
| D8 | Claude | **It may propose a classification, never finalize a decision.** PR2a has no Claude path at all; proposals are PR2c. |
| D9 | Fingerprint | **SHA-256 over a canonical JSON** of `client_id`, `claim`, `source`, `kind`. |

### Open for ChatGPT on this revision

- **O1. How Tom's authority is recorded.** PR2a seeds it in the migration, by
  team-member id (`d73e1bf1-…`), and the insert only matches if that member
  exists, is an admin and is linked to a sign-in. The row is written when the
  migration is applied at release, not before. The alternative is an empty table
  and a separate release-time grant. Both are reviewed, superuser-equivalent
  steps; the seed keeps the grant in git, next to the code that reads it.
- **O2. Who may upload evidence.** PR2a lets any signed-in teammate upload, and
  records them as the uploader. Only Tom can select evidence in a decision, so
  uploading decides nothing, and Jennifer can prepare files for Tom. The
  alternative is owner-only upload.

## 4. Data model (as built)

### `claim_verification_authorities`

| Column | Notes |
| --- | --- |
| `team_member_id` | The authorized person |
| `authority` | `owner` only in PR2a. A future delegation adds `delegate` rows, granted by the owner, with scope and expiry. |
| `basis`, `granted_by`, `granted_at` | Why. `granted_by` null means granted by a reviewed migration. |
| `revoked_at`, `revoked_by`, `revoke_reason` | Kept for the future revoke path |

- At most one active row per person, and at most one active owner.
- Insert, update, delete and truncate are refused for every session except a superuser. A grant is a migration, never an app call.
- Team read only.

`claim_reviewer_authority()` returns the authority id only when all of these hold:

- `post_caller_is_human()`: the PostgREST authenticator acting as `authenticated` with a team JWT;
- the caller (`task_actor()`) holds an active `owner` row;
- the caller is still an `admin`.

Otherwise it returns null.

### `claim_evidence` (uploaded files)

| Column | Notes |
| --- | --- |
| `client_id` | Client isolation; `(id, client_id)` is unique for composite foreign keys |
| `evidence_type` | `document` (contract, manufacturer document, signed form, saved email) or `capture` (a page or listing captured as PDF / image, with `source_url` and `captured_on`) |
| `storage_path` | `<client_id>/<sha256>.<ext>` in the new private `claim-evidence` bucket: the content address |
| `object_id`, `object_version`, `object_etag` | The `storage.objects` row pinned at registration |
| `sha256`, `size_bytes`, `mime_type` | Computed by the `claim-evidence` function from the stored bytes, never taken from the browser |
| `uploaded_by` | `team_members.id` from the caller's JWT |

- Writes go only through `claim_evidence_register(...)`, which only the service role can execute and which only accepts the function's own session. It checks that the storage object exists at the content address, with the same size and MIME type.
- Append-only. Only a client deletion cascades.
- The bucket has no insert, update or delete policy, so the browser can't write it. A trigger on `storage.objects` refuses renaming, re-versioning (overwrite) or deleting a registered evidence file.

### `claim_reviews` (the ledger)

| Column | Notes |
| --- | --- |
| `client_id`, `claim_id` | `(claim_id, client_id)` → `claims (id, client_id)`, no cascade |
| `action` | `classify`, `verify`, `review`, `revoke` (PR2a). PR2b adds `confirm`, `supersede`, `retire`. |
| `kind` | The kind in force after the decision |
| `method` | verify / review only; must be authoritative for the kind |
| `evidence_id`, `evidence_sha256` | A file (composite FK to the same client), its hash copied |
| `location_id`, `location_identity_id`, `location_identity_version`, `location_identity_sha256` | A structured record, pinned to the identity version in force |
| `excerpt`, `observed_on`, `expires_on`, `confirmed_by_contact`, `note`, `reason` | What the evidence says, when it was examined, the document's own expiry, the client contact, and the reason (revoke) |
| `claim_fingerprint` | SHA-256 of the canonical claim (D9), with the kind after this decision |
| `workspace_ids` | The brand workspaces holding the claim at decision time (the BHG scope snapshot) |
| `prior_review_id`, `in_force_verification_id` | The chain, and the verification that stands after this decision (itself for verify/review; null after revoke or classify) |
| `reviewer_id`, `authority_id`, `created_at`, `created_txid` | **Stamped by trigger**, never supplied |

- Row shapes are enforced by check constraints.
- Insert requires `claim_reviewer_authority()`, so even the table owner's SQL (the worker) is refused.
- Update and delete are refused for everyone, a superuser included; only a client deletion cascades.
- Each insert writes a `creative_governance_events` row (`classified` / `verified` / `reviewed` / `revoked`) with the decision. The projection update writes the usual field-diff `updated` row.

### The projection on `claims`

`review_id` is added. `claims_registry_guard` is replaced. A change to any of
the seven columns is allowed only when one of these holds:

- **(a)** it is a superuser session (platform administration and test fixtures, as in v1); or
- **(b)** all of the following:
  - `new.review_id` is a review of this claim and client, written in this transaction (`created_txid = txid_current()`) by this caller (`reviewer_id = task_actor()`), under the caller's live authority;
  - it chains from `old.review_id`;
  - `superseded_by` is unchanged;
  - the new values equal that review's projection: `kind`; plus method, `verified_at`, `verified_by` and `review_by` from the verification in force, or null.

`claims_keep_reviewed` refuses deleting a claim that has review history. A client deletion still cascades.

## 5. Lifecycle (PR2a)

| Writer | What it does |
| --- | --- |
| `claim_classify(claim, kind, expected_fingerprint, expected_review_id, note)` | Sets `kind`. It **always clears** a verification in force, because a different kind of fact needs re-verification. An unverified claim may be classified, since classifying changes nothing a post may cite. |
| `claim_verify(claim, 'verify' \| 'review', method, evidence_id \| location_id, excerpt, observed_on, expires_on, confirmed_by_contact, note, expected_…)` | It requires all of these: a classified claim; status `confirmed` or `sourced` (never `unverified`, D4); a method authoritative for the kind; and evidence that passes §6. `verify` needs no verification in force, and `review` needs one. It sets the method, `verified_at` / `verified_by` (the review's stamp), and `review_by` (the document's expiry). |
| `claim_revoke(claim, reason, expected_…)` | Clears the verification and keeps the kind. Needs a reason. |

**Shared rules**

- Security definer, `search_path` fixed. Execute is granted to `authenticated` only.
- Checks run in this order:
  1. a human session;
  2. owner authority;
  3. lock the claim (`for update`);
  4. the expected fingerprint and review id (a stale screen gets `CV409`, with no partial write);
  5. not superseded;
  6. the evidence rules.
- Every refusal has its own message. The codes are `42501` (who / isolation), `22023` (evidence rules) and `CV409` (stale).

## 6. Evidence rules (enforced in SQL)

| Method | Kinds | Evidence required |
| --- | --- | --- |
| `client_contract` | offering, warranty_guarantee | An uploaded `document` of this client, intact |
| `manufacturer_document` | warranty_guarantee | An uploaded `document`, intact |
| `client_confirmation` | offering, service_description, experience_stat | An uploaded `document` (signed form, saved email) **and** the client contact's name |
| `client_published` | service_description | A `capture` whose URL is the client's own site. For a claim on BHG brand sites, it must be **that claim's** site. Captured in the last 30 days. |
| `platform_record` | rating_review | A `capture` whose URL is not the client's own site, captured in the last 30 days |
| `issuer_record` | credential, reference_fact | A `capture` whose URL is not the client's own site, captured in the last 30 days |
| `structured_record` | contact_identity | An approved `citation_locations` row of this client (active, with a recorded approver). Its identity version is pinned with a SHA-256. It must be client-wide or on one of the claim's brand sites, and **the claim's phone must equal the location's**. PR2a verifies phone claims only. |

These hold for every method:

- An excerpt is required, 1–2000 characters.
- `observed_on` is required and cannot be in the future.
- `expires_on`, if given, must be after both `observed_on` and today.
- "Intact" means the pinned `storage.objects` row still exists at the content address, with the same version and size.

**Integrity in the registry.** Each of these drops a verified claim to *needs
review* with a reason line; nothing is retired automatically:

- `evidence_file_changed`: the file is missing, or its version or size changed;
- `evidence_location_changed`: the identity version moved, or the location was archived or lost its approver;
- `changed_since_verified`: the fingerprint changed;
- `scope_changed_since_verified`: the brand-site set changed;
- `verification_unrecorded`: verification columns set with no ledger entry. This is never independent verification.

A passed `expires_on` makes the claim *stale*, with `evidence_expired`.

**Re-checking a hash.** The `claim-evidence` function's `check` mode downloads
the file, recomputes SHA-256 and compares it with the registered value. It is
available from the registry row.

## 7. Upload flow (`claim-evidence` Edge Function)

The function accepts a team JWT only (403 for anyone else), with no cron path. It has three modes:

1. **`prepare`** `{client_id, sha256, size, mime_type}`. The browser hashes the file first, to name the path. The function validates the request: team, client, MIME type (PDF / PNG / JPEG / WebP), 10 MB maximum. It then returns either the already-registered evidence (the same bytes for the same client) or a **signed one-time upload URL** for exactly `<client>/<sha256>.<ext>`.
2. The browser uploads straight to Storage, so there is no server-action or Vercel body limit.
3. **`finalize`** `{client_id, path, evidence_type, label, source_url?, captured_on?, original_name?}`. The function downloads the stored bytes, recomputes SHA-256 and sniffs the type from magic bytes. If either disagrees with the path, it deletes the unregistered object and refuses. Otherwise it calls `claim_evidence_register`.
4. **`check`** `{evidence_id}`. Re-hashes a registered file.

## 8. Isolation and BHG

- Every evidence reference is checked against the claim's client, by composite foreign keys (`claim_evidence`) and in the writer (locations).
- A location on another brand site is refused, and so is a capture of another brand site for a `client_published` claim.
- Each decision snapshots the claim's workspace set, and a later change is flagged. Workspace assignment itself is untouched (v1 D4).
- The portal never sees any of this: the base tables are team-only.

## 9. PR2a scope (as built)

**In**

- Migration `20261104200000_claim_verification.sql`:
  - the v1-lock precondition;
  - the hash pin over every other function that reads `claims`;
  - a claims digest (zero rows changed);
  - the authority table and the owner seed;
  - the `claim-evidence` bucket, its team-read policy and the immutability trigger;
  - `claim_evidence` and `claim_reviews` with their guards and audit;
  - the projection guard, delete protection, fingerprint helpers and the three writers;
  - `claim_registry` v2 (review in force, evidence and integrity reasons, viewer authority, evidence and location options);
  - a verify block.
- Rollback file. It refuses once any review or evidence exists, because history is never deleted; after that, the fix is a forward migration.
- `claim-evidence` Edge Function (handler + index), not deployed.
- On the Intelligence tab:
  - an **Evidence files** panel with upload for any teammate, the hash shown, and a re-check;
  - **Classify / Verify / Re-review / Revoke** on each claim row, for the verification owner only;
  - members see the decisions read-only.
- Docs: `docs/claim-registry.md` and AGENTS.md.

**Out:** supersede, retire, confirm-with-evidence, any `claims.status` write,
Claude proposals, delegation, Drive pinning, server-side URL capture, the Proof
Library (PR3), enforcement (PR5), and any production change.

## 10. Acceptance tests

They run in the sandbox SQL suite (native and PGlite), as handler unit tests, as lib unit tests, and in the browser harness.

**Security**

- S1. The owner can classify, verify, re-review and revoke. A second admin with no authority is refused (42501), and so is a member.
- S2. The worker (`postgres`), the service role, anon, a sign-in on no team row, and a revoked authority are each refused by every writer.
- S3. Direct writes to the seven columns are refused for a teammate, the owner, the service role and the worker. A forged `review_id` (an older review, another claim's review, or another transaction's) is refused.
- S4. Direct insert, update and delete on `claim_reviews`, `claim_evidence` and `claim_verification_authorities` are refused for every application role and the worker. Update and delete of reviews are refused even for a superuser. A client deletion cascades.
- S5. A stale fingerprint or review id is refused with `CV409` and nothing is written.

**Evidence**

- E1. A non-authoritative method is refused, and so is an unclassified claim.
- E2. Refused: another client's evidence (42501); a capture used for a document method; a document used for a capture method; a file whose object is missing or re-versioned.
- E3. A location is refused when it is archived, has no approver, belongs to another client or another brand site, or has a phone that doesn't match.
- E4. Host rules are enforced: client_published on a third-party or wrong-brand host is refused; platform and issuer records on the client's own host are refused; a capture older than 30 days is refused.
- E5. Refused: a missing excerpt, a future `observed_on`, an `expires_on` not after today, and client_confirmation without a contact.
- E6. Verifying an `unverified` claim is refused (D4). Classifying one is allowed.
- E7. Registration refuses any caller but the function, an object that isn't at its content address, and a size or MIME mismatch. Storage refuses overwriting or deleting a registered file.

**Registry**

- R1. A ledger verification gives *verified*; with an expiry within 14 days, *due*; past it, *stale*. Verification columns with no ledger entry give *needs review* (`verification_unrecorded`).
- R2. After verification, each of these gives *needs review* with its reason: editing the claim, a re-versioned or missing file, a bumped location identity, a moved brand site.
- R3. Re-classify clears the verification. Revoke returns the claim to *needs review* and keeps the kind.
- R4. BHG per-program verified counts are right.

**Audit**

- A1. Every action writes one review row (with stamped reviewer, authority and txid), one decision event and one field-diff event.
- A2. A claim with any review history can't be deleted (23001). A claim without history still deletes.

**Invariants**

- I1. The hash pin passes.
- I2. A post's approved hash and a draft's review hash are unchanged through a full classify → verify → re-review → revoke cycle.
- I3. No writer changes `status`, `claim`, `source`, `confirmed_by` or `confirmed_on`, and `legacy_usable` is unchanged.
- I4. The migration changes zero claim rows.
- I5. Down (empty ledger) then up replays. Down refuses once history exists.

**UI**

- U1. The owner sees the controls. A second admin and a member see none, but see the decisions.
- U2. A full flow on fictional data: upload a PDF, see its SHA-256, classify, verify, and the row moves to *Verified* with its evidence line.
- U3. A refusal shows the database's message in place.
- U4. Phone width works; fictional data only.

**Production release (when authorized, not now).** The shape is the same as v1:
baseline digests, apply, reconcile the migration ledger, deploy the
`claim-evidence` function, merge, deploy the app. Then confirm live that there are
0 reviews, 0 evidence files, 1 owner row (Tom), and identical content digests.
The first real verification is Tom's: upload Lucas's contract excerpt, then verify
`e7da11c6` with `client_contract`.

## 11. W3 (PR3, Proof Library)

`claim_evidence` already holds what a proof object needs: a content-addressed
file, its hash, who uploaded it and when. PR3 can promote evidence rows to
`proof_items` (or point `proof_items` at them) and add `claim_reviews.proof_id`
without changing a rule or the audit trail.

## 12. Risks and unresolved concerns

- **The `postgres` role.** It runs migrations and the worker's SQL, and it owns
  these tables, so it could disable a trigger with DDL. The guards stop its DML;
  only review and repository control stop its DDL. This is the same trust
  boundary as v1 and every Compass gate.
- **Browser-side hash.** It only names the path. The function recomputes it
  from the stored bytes before anything is registered, and a mismatch is
  deleted.
- **Storage semantics.** Supabase's `storage.objects` has `version` and
  `metadata` (`size`, `mimetype`, `eTag`). The sandbox emulates them. The
  first real upload must be checked on a Supabase branch before release.
- **The storage delete guard.** It reads `claim_evidence`. If Supabase's storage
  admin role changes how deletes are issued, the guard must be re-verified on
  the branch.
- **Two-person team.** Separation of duties comes from the owner rule: Jennifer
  can prepare evidence, and only Tom decides.
