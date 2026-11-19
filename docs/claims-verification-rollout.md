# Controlled Claims Verification, PR2a: production release record

COMPASS-2027-ROADMAP W1, P1.1b. Executive OS task 11454716 (P0.3). Released Nov 6 2026, step by step, each step authorized by Tom.
Design: `docs/proposals/pr2-controlled-claims-verification.md` (rev 4). Behaviour: `docs/claim-registry.md` §Verification.

## Pins

| Item | Value |
| --- | --- |
| Reviewed commit (ChatGPT accepted) | `4e9073824c1b58b9f043e558ea442e328ad3ad83` (PR #220) |
| Merge commit | `8724e6bc189686c93886b20327c2cc694b8b172b` (tree `dd11172a1e6d820b907a0444b9978b01356433db`, identical to the reviewed commit) |
| Migration | `supabase/migrations/20261104200000_claim_verification.sql`, sha256 `86f53fd3fb312d4479b17dcadb97222d5b86dc4733f760b7d0bf07643e5cba59`, md5 `1040960a1b08214836b5e8b46118438a`, 92,671 bytes |
| Rollback | `supabase/rollback/20261104200000_claim_verification.down.sql`, sha256 `a13dce30a7277516fa019674b9d3236a1e561bc8d0d67b95e5daac41b6c4fc34` |
| Function | `claim-evidence`, tree `793a5b5e7228b34f05c145bffdebc62ceab848a5`. Deployed version 1, `verify_jwt=true`, `ezbr_sha256` `d46f0828b3888b2f9c94b01cd70f41086aa3a199c89fc7bbb2cd10af9ec493d8` |
| CRM | Vercel production `dpl_89GNUhzFQPPSyJ9H3iZKwNBGX1nQ` (`8724e6b`). The previous production deployment was `dpl_8fnTub6AUK8hj6YUZtdRWs4SJMxM` (`77a6992`) |

## Steps

| Step | What happened |
| --- | --- |
| P1 preflight | Read-only. Every value matched the Nov 5 read: migrations, absent PR2a objects, the v1 lock, Tom an admin linked to a sign-in, the helpers, default privileges, hosted Storage schema and triggers, the function not deployed, the code pins. The baselines below were captured here |
| A1 migration | `apply_migration` once, with no production dry run (ChatGPT's adjustment). The recorded statements' md5 = the pin, 92,671 bytes. Production recorded the apply time `20261106200324` as the version, re-stamped to `20261104200000` (as with v1), guarded on the md5. The migration's verify block passed |
| P2 invariants | Read-only. Claims, statuses, citability and `approved_hash` unchanged. Ledger, evidence and upload requests empty; one owner (Tom). Bucket private, 10 MB, four types, `DISABLED`, no lifecycle, one SELECT policy. Both guards present and the existing Storage triggers intact. Registry v2 ran on all 16 clients without error (170 claims, 0 verified, 129 citable). No new error-level advisor |
| A2 merge | Merge commit pinned to the reviewed head (`--match-head-commit`). The diff to `4e90738` is empty. The Vercel production build is READY, with no runtime errors |
| A3 function | The first run was stopped by the workflow's commit check: PR #221 (docs only) had moved `main` to `7d038be`. Tom re-authorized. The second run deployed from `7d038be`, whose `claim-evidence` tree is the pin. ACTIVE, `verify_jwt` on, an unauthenticated POST answers 401 |
| A4 smoke test | Fictional client `0e5a0000-0000-4000-b000-00000000c0de` (`map_tracking`, offboarded, so no automation fired). Fictional PDF of 745 bytes, SHA-256 `5fa3126b5c2c5c3a1963f3285509f6f6c7aabdf831b213dc53c975a9b9fd5f1f`. Results below |
| A5 cleanup | Smoke client deleted, its rows cascading through the guards. The PDF and the dashboard's folder placeholder were deleted through the Storage API (the dashboard). Receipt below |

### A4 results

- **S1, upload by Tom:** registered as a Document.
- **S2, the record:** the SHA-256, size and type match the file; the object id, version and eTag are pinned to the Storage row, which is unversioned, not a marker, not archived; the record is intact. `uploaded_by` = `requested_by` = Tom.
- **S3, Re-check hash:** the server re-hashed the stored bytes and found them intact.
- **S5, anonymous access:** refused everywhere. The public and authenticated paths, the list, the REST tables and the function.
- **S7, refusal probes:** a rolled-back batch of 19 attempted writes as `postgres`, every one refused with 42501:
  - on the registered object: version, rename, archive, delete marker, `is_versioned`, eTag, a second row, and a delete the way the Storage API does it;
  - on the bucket: versioning, lifecycle, public, delete;
  - direct writes to evidence and upload requests, and calls to the register and request functions.

  It replaced the manual dashboard test (S6), at Tom's request.

- **S4, a second admin's read-only view:** optional; not run.
- **Open P2 item closed:** the release CRM rendered the Intelligence tab for Tom (S1).

### A5 receipt

1. **The smoke client.** Deleted first, before the file deletes below, by `delete from clients`, guarded on its id, name and `offboarded` status. The cascade removed its evidence row (`66b187dd…`) and its upload request (`723fc1f0…`); the guards allow this because the client itself is gone. No review was ever written.
2. **The PDF.** Tom deleted it in the Supabase dashboard (Storage API) at 22:40:35Z (`ObjectRemoved:Delete`). It was no longer registered, so the guard allowed it.
3. **The placeholder.** At 22:40:36Z the dashboard created `0e5a0000-…c0de/.emptyFolderPlaceholder` (id `fa3829ec…`, 0 bytes) to keep the empty folder visible. Tom deleted the folder in the dashboard. It was present at the 22:50Z read and gone at ChatGPT's 23:09Z check (Executive OS result `e6bb2628-9896-4580-9e4e-108efeda9fd9`). The log stream held no entry for this delete when this was written.
4. **Verified at 23:21Z** (read-only):
   - 0 objects in `claim-evidence`; the bucket private, `DISABLED`, no lifecycle;
   - 0 `claim_evidence`, 0 `claim_evidence_uploads`, 0 `claim_reviews`;
   - no smoke client, and nothing of it in claims, tasks or history;
   - the original 170 claims' digest still `8c335f10b81f671c143acd256b969515`;
   - 0 claims carrying verification fields;
   - Tom the sole active authority;
   - both guards present;
   - the migration record `20261104200000` with md5 `1040960a…`.

   184 claims exist from normal activity since P1; no real client data was touched.

Production is back to "nothing recorded", so the rollback path is open again.

## Baselines (captured at P1, Nov 6 2026)

| Item | Value |
| --- | --- |
| Claims | 170, full-row digest `8c335f10b81f671c143acd256b969515`; 21 confirmed, 108 sourced, 41 unverified |
| Citability | md5 `32b3f0f2fd57ed58a52979a4a93be534`; 129 citable |
| Posts | `social_posts.approved_hash` md5 `1cb84473d80f739ca69af027930b4896` (87 posts) |

Ordinary claim creation continued during the release; its rows carry no verification fields. Later comparisons use the original 170 rows, whose digest is unchanged.

## Security testing

### Before release (reviewed commit `4e90738`)

| Suite | Result |
| --- | --- |
| Native PostgreSQL 17 sandbox: every migration replayed and every suite run | exit 0 |
| PR2a database suite | 71/71: owner-only decisions; refusals for the worker, service role, anon, portal and second admin; evidence rules; the projection guard; stale screens (CV409); the H1–H5 Storage hardening; the W1–W6 status rule; client-deletion cascade |
| Portal access / v1 registry | 900/900 / 50/50 |
| PGlite suite | pass, including B3: the rollback refuses once history exists |
| Real Supabase stack (local, nonproduction, with production's default privileges) and the real Edge runtime | 13/13 through the real Storage API. Signed upload; server re-hash; pinned version and eTag; overwrite, move and delete refused; bucket settings fixed; anon, stranger and portal refused; mismatched bytes and wrong types deleted; cleanup |
| Handler / registry library | 11/11 / 5/5 |
| `npm test` | 1420/1420 |
| Browser: PR2a / v1 | 11/11 / 8/8 |
| GitHub CI | 14 pass, 1 skipped |

### In production (Nov 6)

- **Preflight and invariants:** P1 and P2, both read-only.
- **Smoke test:** A4 S1–S7, including the rolled-back refusal batch: 19 of 19 refused.
- **Advisors:** no new error-level finding. The four PR2a functions callable by signed-in users appear in the expected advisor warning, matching the portal-access allowlist.

## Operating instructions

**Who does what**
- Only Tom classifies, verifies, re-reviews and revokes claims. He is the one active `claim_verification_authorities` row.
- Any signed-in teammate may upload evidence. Uploading decides nothing.
- Nobody else holds decision authority: Claude, the worker, Edge Functions, Executive OS instructions, a second admin, portal contacts.
- Delegation is designed for (`authority 'delegate'`) but not built. Granting or revoking authority is a reviewed migration, never a UI action.

**Evidence**
- Upload on the client's Intelligence tab (**Claim evidence files**):
  - a contract, manufacturer document, signed form or saved email is a **Document**;
  - a saved copy of a web page or listing is a **Page capture**, with its address and capture date. A capture counts for 30 days.
- A Drive link or a live web address is never evidence on its own.
- Files are private, named by their SHA-256, and never replaced or deleted once registered. New bytes get a new address. **Re-check hash** re-downloads a file and re-hashes it.

**Decisions**
1. Classify the claim first.
2. Verify it against intact evidence of the kind its method needs. Phone claims are verified against an approved location record.
3. Re-review when the registry says it's due, or after any change.
4. Revoke with a reason.

Every decision is a permanent ledger row, and a claim with review history is never deleted. Retirement and supersession are PR2b. Verifying never changes what posts and drafts may cite; the citing rules are unchanged.

**When the registry flags a claim** (*needs review*), re-review it. A changed file needs a fresh upload. The reasons:
- `evidence_file_changed` or `evidence_location_changed`: the evidence moved;
- `changed_since_verified` or `scope_changed_since_verified`: the claim's text, source or brand sites changed;
- `status_changed_since_verified`: its status changed after the verification, even if it was put back;
- `evidence_expired`: the evidence's own expiry passed.

An unverified claim can't be verified in this release.

**Standing checks** (read-only; run after any Supabase Storage change):

```sql
select public, versioning_status, lifecycle_configuration
  from storage.buckets where id = 'claim-evidence';  -- expect false, DISABLED, null
select count(*) from pg_trigger
 where tgname in ('claim_evidence_objects_immutable', 'claim_evidence_bucket_guard');  -- expect 2
select team_member_id, authority from claim_verification_authorities
 where revoked_at is null;  -- expect Tom only
```

**Never:**
- toggle versioning or a lifecycle rule on `claim-evidence`; the guard refuses it, and on Supabase enabling versioning is irreversible;
- delete Storage objects with SQL; use the Storage API;
- write the evidence, upload or review tables directly.

**After a Supabase Storage upgrade,** re-run `tests/claim-evidence-storage-integration.mjs` against a nonproduction stack.

## Rollback

- **While nothing is recorded** (0 reviews, 0 evidence, 0 upload requests, 0 objects in `claim-evidence`; true now): the pinned down script restores v1, with Tom's authorization. The CRM's rollback target is `dpl_8fnTub6…`.
- **Once anything is recorded:** fix forward only. The down script refuses rather than destroy evidence or review history.
- **Containment that deletes nothing:**
  - roll back the Vercel deployment (the v1 UI reads v2 data);
  - remove the `claim-evidence` function;
  - revoke Tom's authority through a reviewed migration.

## Remaining risks

- **Byte integrity trusts the service-role key.** Postgres can't read object storage, and every Edge Function holds that key. A malicious holder could store wrong bytes under a teammate's live upload request. It cannot create the request, change its client, or name the uploader. Re-check hash detects it (proposal §12a).
- **The `postgres` role** (migrations, the worker's SQL) owns these objects and could change a guard with DDL. The same is true of every Compass gate; only review stops it.
- **Storage's maintenance role** (`supabase_storage_admin`) is exempt from the bucket guard, so platform migrations aren't blocked. A registered file stays protected by the objects trigger, which has no exemption.
- **Hosted versioning itself** was never exercised; it is refused by the guard and was checked by rolled-back probes. Re-test after Supabase Storage changes.
- **A new Supabase project** with today's default privileges would need explicit API grants for Compass. This one has the older defaults.
- **Two-person team.** Separation of duties comes from the owner rule: Jennifer can prepare evidence, and only Tom decides.

## Open after release

- **A7:** Tom's own first real upload and verification, for example Lucas's contract excerpt and then verifying `e7da11c6`. It needs its own authorization; nothing real has been uploaded.
- PR2b (confirm-with-evidence, supersede, retire) and PR2c (Claude proposals) are not started.
