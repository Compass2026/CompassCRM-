# PR2 — Controlled Claims Verification

COMPASS-2027-ROADMAP W1, P1.1b. Follows Claims Registry v1 (PR #218, merged as
`77a6992`, migration `20261103220000`, verified live Nov 4 2026).

| Revision | Date | What |
| --- | --- | --- |
| 1 | Nov 4 2026 | Proposal, Executive OS P0.3 result `12222fff` |
| 2 | Nov 4 2026 | ChatGPT architecture review: approved with three required refinements (owner authority, SHA-256 evidence with a working upload, history kept). This revision records them and scopes PR2a as built. |
| 3 | Nov 5 2026 | ChatGPT's second review (three pre-release checks). Owner decisions recorded (O1 closed as Tom only; O2 closed: teammates upload with recorded provenance). The register's trust boundary corrected and provenance bound to the teammate's own session (§4, §7, §12a); the status race assessed (§12b); real Supabase Storage verified on a nonproduction local stack (§12c). |

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

### Owner decisions (ChatGPT's second review, Nov 5 2026)

- **Tom remains the only final claim-verification authority.**
- **Signed-in teammates may upload evidence with recorded provenance; uploading
  does not authorize verification.** O2 below is closed on that basis.

### Open for ChatGPT on revision 2 (kept for the record)

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
| `uploaded_by` | The requester of the upload request it answers (below), never an argument |
| `upload_id` | The `claim_evidence_uploads` row it answers; unique, so a request is used once |

- Writes go only through `claim_evidence_register(...)`, which **the service role** can execute (a PostgREST service-role session). That is every holder of the service-role key, i.e. every deployed Edge Function, not only `claim-evidence`; the database cannot tell them apart. It checks that the storage object exists at the content address, with the same size and MIME type, and that it answers a live upload request for exactly that client, hash, size and type.

### `claim_evidence_uploads` (who asked to upload what)

| Column | Meaning |
| --- | --- |
| `client_id`, `sha256`, `size_bytes`, `mime_type` | The file the teammate asked to upload |
| `requested_by` | Stamped from the caller's own JWT (`task_actor()`) by the guard |
| `created_at`, `expires_at` | Valid for one hour |

- Written only through `claim_evidence_request_upload(client, sha256, size, mime)`, executable by `authenticated` and refused unless the session is a signed-in teammate's own (`post_caller_is_human()`). The service role, the worker's SQL, a portal contact, a stranger and anon are all refused; direct inserts are refused for everyone but a superuser (fixtures). Never changed; only a client deletion removes rows.
- The `claim-evidence` function calls it at `prepare`, **forwarding the caller's JWT** (a caller-scoped client), so the database records the requester itself.
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

1. **`prepare`** `{client_id, sha256, size, mime_type}`. The browser hashes the file first, to name the path. The function validates the request: team, client, MIME type (PDF / PNG / JPEG / WebP), 10 MB maximum. It then returns either the already-registered evidence (the same bytes for the same client), or records the **upload request from the caller's own session** and returns its `upload_id` with a **signed one-time upload URL** for exactly `<client>/<sha256>.<ext>`.
2. The browser uploads straight to Storage, so there is no server-action or Vercel body limit.
3. **`finalize`** `{client_id, upload_id, path, evidence_type, label, source_url?, captured_on?, original_name?}`. The request must be this caller's, for this file (403 / 404 otherwise). The function downloads the stored bytes, recomputes SHA-256 and sniffs the type from magic bytes. If either disagrees with the path, it deletes the unregistered object and refuses. Otherwise it calls `claim_evidence_register` with the request, which supplies the client, hash, size, type and uploader.
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
- **Storage semantics.** Verified on real Supabase Storage (§12c); the
  sandbox's emulation matched. What remains is the hosted service's version.
- **The storage delete guard.** It reads `claim_evidence`. Verified against
  Storage's own delete path (§12c). If Supabase changes how Storage issues
  deletes, re-run `tests/claim-evidence-storage-integration.mjs`.
- **Two-person team.** Separation of duties comes from the owner rule: Jennifer
  can prepare evidence, and only Tom decides.

### 12a. The register's trust boundary (second review, check 2)

Revision 2 said the register "only accepts the function's own session". That
was wrong: `drafter_caller_is_service()` is true for **any** PostgREST
service-role session, and every deployed Edge Function holds the service-role
key. The register also took `p_uploaded_by` as an argument, so any
service-role holder could register a file in any linked teammate's name.

Fixed in this revision, minimally:

- The uploader is no longer an argument. A teammate's own signed-in session
  writes an upload request (`claim_evidence_uploads`); the register answers
  one request, once, within an hour, and takes the client, SHA-256, size,
  type and uploader from it. Nothing holding only the service-role key can
  write a request.
- The comments, error messages and docs now say "the service role (the
  claim-evidence function)" instead of claiming one function.

What the boundary still is, stated plainly:

- **Byte integrity rests on the service role.** Postgres cannot read object
  storage, and the service role can also write the bucket directly (it
  bypasses Storage policies). A malicious service-role holder could therefore
  register bytes under a teammate's live request for a hash those bytes do
  not have. It cannot invent the request, change its client, or name the
  uploader. Anyone can detect it: **Re-check hash** re-downloads and
  re-hashes the file. Tom decides only on files he can open.
- **Provenance rests on the teammate's JWT,** the same boundary as every
  Compass human-only writer (`post_caller_is_human()`). Every JWT-authorized
  Edge Function receives callers' JWTs; that is unchanged platform trust.
- **Postgres DDL**, as before (§12).

### 12b. A status change while a decision form is open (second review, check 3)

Assessed: **not an approval-integrity problem, so no behaviour change.**

- The fingerprint pins what a decision is about: client, text, source and kind.
  A text or source edit after the form loaded refuses the old screen (CV409).
- `status` is today's separate citing rule, which a decision neither reads to
  decide nor writes. The one rule that reads it (an unverified claim is not
  verified in this release) is checked against the claim row **locked
  `for update` at submit**. A form loaded before a status change can never
  record what the rules would refuse, and a concurrent status edit waits for
  the decision's commit.
- A status-only change (for example sourced to confirmed) leaves the evidence
  decision valid. It records, and the status it found is untouched.

Regression tests T1 to T3 hold all three. Two related points, neither of them
a form problem, stay as designed in D4:

- A verification in force stays in force if a teammate later marks the claim
  unverified. The claim leaves the citable set at once (status rules). The
  registry lists it under *Unverified* while showing that the owner's
  verification is still recorded, and the owner can revoke it.
- The ledger does not copy the claim's status at decision time; claim history
  (`creative_governance_events`) records every status change with its time.

### 12c. Real Supabase Storage (second review, check 1)

There is no Supabase branch on the project, and creating one is billed. So the
check ran on a **free, nonproduction local Supabase stack** (CLI 2.109,
`storage-api` v1.58.17, `postgres` 17.6.1, `gotrue` v2.189, `edge-runtime`
1.74). Every migration was replayed as `postgres`, with production's default
privileges (read from the project on Nov 5). The real `claim-evidence` function
was served on the Edge runtime. Fictional data only, all removed at the end.
`tests/claim-evidence-storage-integration.mjs` is the script (12 checks; it
refuses the production project):

1. The function: no sign-in 401; stranger and portal contact 403.
2. `prepare` writes the upload request with the requester from the caller's
   JWT and signs a one-time upload for the content address.
3. Upload requests are refused for a portal contact, a stranger, the service
   role and anon. A teammate cannot call the register.
4. A teammate and a portal contact cannot write the bucket directly.
5. The signed upload stores the bytes. Storage records `version`, `size`,
   `mimetype` and `eTag`. The same token cannot write a second time.
6. `finalize` (by the requester only; another teammate 403) re-hashes the
   stored bytes and pins the SHA-256, object id, version and eTag. `check`
   re-hashes intact.
7. Overwrite (`upsert`, `update`), `move` and delete (teammate, and the service
   role through Storage's own API) are all refused. The storage row, version
   and bytes are unchanged and still hash intact.
8. A teammate reads the file. Anon, a stranger and a portal contact cannot
   download, list or see the rows, and there is no public URL.
9. Bytes uploaded under another file's hash are refused (422), deleted from
   Storage, and never registered.
10. An HTML file sent as a PDF is refused from its bytes (422) and deleted.
11. The same bytes again return the registered row.
12. Cleanup: deleting the client cascades through uploads and evidence, after
    which Storage deletes the files. Nothing is left.

One finding from setting up the stack, which is not a defect in this PR: a
fresh local stack no longer grants new `public` tables to the API roles, so
`service_role` could not read `team_members`. Production does grant them (its
default privileges were read on Nov 5), so the replay sets the same defaults.
A future project created with Supabase's newer defaults would need those
grants before any Compass function works.

