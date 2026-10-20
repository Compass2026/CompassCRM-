# Citations — Phase 1 (inventory, import, evidence, corrections)

Built Oct 20 2026 for Executive OS task `c0e9965e` (parent initiative
`db316478`). ChatGPT owns strategy, provider research, budget and review;
this slice is the provider-neutral foundation. **It is not deployed to
production and its migration is not applied there.**

Out of scope, on purpose: automatic crawling, scheduled paid checks, provider
order APIs, live publisher writes, any BrightLocal-specific mapping, LLM / AI
visibility (V2). Nothing in this module calls a provider, crawls a directory,
spends credits or sends mail.

## What exists

| Where | What |
| --- | --- |
| `/citations` | Agency overview: every client's active business locations with counts (listings, verified, discrepancies, unverified, provider complete but unverified, open tasks, stale / never checked, action required); cross-client filters; manual fulfillment cash, approved budgets and pending approvals; prepaid credit balances and the credit-entry form. |
| `/clients/[id]/citations` | Client tab: location cards (the public address form), add a location, recent imports, client-safe and internal CSV export, directory registry. |
| `/clients/[id]/citations/[locationId]` | Approved identity (edit with a reason, version history), inventory with filters (all / action required / discrepancies / unverified / inaccessible / stale), field-by-field comparison, checks and evidence, tasks, fulfillment requests. |
| `/clients/[id]/citations/import` | Generic mapped CSV import with preview. |
| `/clients/[id]/citations/export?variant=client\|internal&location=&view=` | CSV report. |

Code: `src/lib/citations.ts` (pure rules, CSV, mapping, comparison, export),
`src/lib/citations-data.ts` (reads), `src/app/citation-actions.ts` (writes),
`src/components/citations/*`, migration
`supabase/migrations/20261020200000_citations_foundation.sql`.

## Overlap with what was already there

- **`locations`** holds rank-tracking cities and service areas. Its rows carry
  `brightlocal_location_id` / `gbp_place_id` but no address or phone. A citation
  location can link one (`tracking_location_id`); it does not replace it.
- **`clients`** has one address (`address_line1, city, state, zip`) and
  `business_type`. There is no hidden-address flag anywhere else.
  `citation_locations.hide_address` is the first. Locations are entered
  deliberately, not copied from `clients`, so a stale intake address does not
  become the "approved" one.
- **`client_brand_workspaces`** (BHG's three sites) can be referenced
  (`brand_workspace_id`). Several websites do not create several locations.
- **`tasks`** (owner enum TOM/CLAUDE, no evidence fields) is not reused. Citation
  corrections need a listing, a dated resolution and evidence, so they live in
  `citation_tasks`. They don't appear on the agency Tasks page yet; that is a
  review decision.
- The SEO › Local Citations stage tasks (`citation_list`, `nap_sweep`,
  `citation_submit`, `citation_sheet`) are unchanged.
- **Backlinks** is the pattern this follows: a record plus append-only dated
  checks, client-generated ids for retry, and guard triggers.

## Data model

- `citation_locations`: the approved identity per actual business location.
  This is business name, address, phone, website and `hide_address`. A storefront needs a
  street and city; a hidden-address location may omit them. A change to any
  identity field needs `identity_note` and bumps `identity_version`.
- `citation_location_identities`: append-only history of each approved version,
  written only by the trigger. Checks record the version they compared against.
- `citation_directories`: the shared publisher registry (17 seeded reference
  rows). `hidden_address_support` stays `unknown` until confirmed.
- `citation_listings`: one row per location × directory × `listing_key`. The
  key is the normalized URL, else the external id, else the one URL-less slot.
  Several keys for one directory are flagged as suspected duplicates. URL,
  location and directory are fixed after insert.
- `citation_checks`: append-only teammate evidence (date, method, result,
  observed fields, evidence text, optional link). The database refuses
  method/result pairs that cannot support each other.
- `citation_tasks`: the correction / verification queue: kind, reason,
  owner (`team_members`), due date, status. At most one open task per listing
  and kind. Resolving needs a resolution, a confirmation date between opening
  and today, and an evidence reference or a check on that listing. Reopening
  clears the resolution.
- `citation_fulfillment_requests`: a manual record of a provider request:
  directory, action (create / update / remove duplicate), provider and
  reference, status, approved budget, actual cash and currency, and
  `credits_used`. Approval is admin-only (`is_team_admin()`), and so is changing
  an approved budget. Submitted / complete / failed require an approval.
  These statuses are mirrored to the listing's `fulfillment_status`; verification
  is never touched.
- `citation_credit_entries`: append-only prepaid credit ledger (opening balance,
  purchase with its one-time cash, adjustment). `citation_credit_balances` =
  recorded − used on requests.
- `citation_imports` / `citation_import_rows`: one header per committed file
  (hash, provider label, mapping by header name, counts that must add up). Each
  row records its number, a content hash, the outcome and the reason. Raw rows
  are not stored.

### Three dimensions, never merged

| Dimension | Values | Set by |
| --- | --- | --- |
| Provider fulfillment | none, submitted, pending, provider complete, failed | import, manual entry, fulfillment request |
| Independent verification | unverified, verified accurate, discrepancy, inaccessible, confirmed absent | only the latest dated check (trigger); a direct edit is refused |
| Open issues | open / in progress / waiting tasks | the queue |

- A provider's "complete" never verifies anything. "Provider complete,
  unverified" is counted on its own and is part of "action required".
- A search that finds nothing is recorded as **not found**: the listing stays
  unverified.
- **Confirmed absent** needs `owner_dashboard` or `publisher_confirmation`.
- The latest check by date decides verification; a backdated entry never
  overrides a newer one.
- Evidence older than 90 days is **stale**. Reports show current, stale and
  never checked separately.

### Access

Every table has RLS with the single `is_team()` policy. Grants are revoked from
`anon` and `service_role`. Nobody gets delete, and history tables cannot be
updated. There is no portal view: a client contact reads nothing, and hidden
addresses never leave the team.

Team access is team-wide (the CRM has no per-client team scoping). The
cross-client guarantees are these:
- every write is checked against the client in the URL (actions) and against
  the location's client (triggers);
- an import id cannot move between clients;
- a location under the wrong client is a 404;
- an export for client B never includes client A's listings.

The two read models are `security_invoker`.

## Import

Generic and mapped. **No provider format is assumed.** A BrightLocal mapping is
added only after a real export has been reviewed.

1. **File and source.** A CSV up to 900 KB / 5,000 rows, plus a provider
   label: manual, BrightLocal, Advice Local, Synup, Whitespark, other.
   Credential-like headers (password, login, username, token, API key, secret,
   PIN) are never offered and are refused if mapped. Their cells are never
   carried or stored.
2. **Columns.** Exact generic header names are pre-selected (Location,
   Directory, Listing URL, Status, Business Name, Address, Phone, Website, Date
   checked, Notes). The teammate confirms each one.

   | Field | Notes |
   | --- | --- |
   | Business location | mapped explicitly below |
   | Directory / publisher | registry name, key or domain; falls back to the URL's host |
   | Listing URL | http(s), no credentials; normalized for the key |
   | External listing id | key when there is no URL |
   | Provider status | submitted / sent; pending / in progress / processing / queued; complete / completed / done / live; failed / error / rejected. Anything else is rejected. |
   | Observed name / address / phone / website | the source's observation, not verification |
   | Source observation date | YYYY-MM-DD or MM/DD/YYYY, not future |
   | Notes | |

3. **Locations.** Either "every row is one location", or a column whose
   distinct values are each mapped to a location by hand. An unmapped value
   rejects its rows; nothing is guessed. Unknown directories are rejected unless
   "add directories" is ticked.
4. **Preview, then import.** Both run `citation_import()`; the preview rolls
   back (SQLSTATE `CIT01` inside the function). Counts are added / updated /
   skipped / rejected, with a reason per row, and always reconcile.
   - A repeat import of the same rows adds nothing.
   - Committing the same import id twice returns the first result.
   - A row identical to the stored one is "unchanged".
   - An observation older than the stored one is skipped.
   - Empty cells never clear stored values.
   - Two rows for the same listing in one file: the second is rejected.

Fixtures: `tests/fixtures/citations/` (fictional, labeled SAMPLE, not a
provider export).

## Exports

- **Client-safe** (the default): a hidden-address location's street (approved
  or observed) is never written. A public observed address becomes "Address
  shown publicly (should be hidden)".
- **Internal:** carries it, marked "[HIDDEN — internal only]".
- Every cell is quoted, and a leading `= + - @`, tab or CR (after any spaces)
  is prefixed with `'`.
- Columns include the source, source observation date, import time, last
  checked date and evidence freshness.

## Cost measurement points (no prices invented)

Phase 1 records costs; it does not estimate them. These are the points a later
reviewed phase reads to compare providers. The current BrightLocal baseline
($191/month for ten locations; 194 prepaid credits) lives in Executive OS, not
here.

- **One-time fulfillment cash:** `citation_fulfillment_requests.actual_amount`
  and `actual_currency`, per request, location, directory and provider.
- **Prepaid credits:** `credits_used` per request, against
  `citation_credit_entries` (opening balance, purchases with their own one-time
  cash).
- **Approved and pending spend:** `approved_budget` and approval stamps, plus
  `pending_approval` requests.
- **Labor (not tracked here):** checks (`citation_checks.recorded_at`, count per
  location per month) and task cycle time (`opened_at` → `resolved_at`) are the
  inputs. Hours are not recorded.
- **Recurring tools (not tracked here):** monitoring subscriptions are
  account-level. The 10 / 20 / 40-location model stays with ChatGPT's budget
  work.
- **Future paid checks / orders:** the next slice should record
  per-call cost on the run row (as `rank_runs` does for DataForSEO) before any
  schedule is turned on.

## Turning it on (not done)

1. Review this PR.
2. Apply `20261020200000_citations_foundation.sql` through the Supabase MCP
   (`apply_migration`). It is additive: ten tables, two views, one function, and
   seventeen reference directories. It inserts no client rows. Rename the file to
   the recorded version.
3. Set `CITATIONS_ENABLED=true` in the Vercel environment (server-only; anything
   else is off). Until then the nav item and tab are hidden, every page is a
   404, the export returns 404 and every action refuses. Merging without
   the migration is therefore safe.
4. Record each pilot location's approved identity, then import its first
   file.

### Rollback

- **Before any real data:** unset `CITATIONS_ENABLED`, then
  `drop view citation_listing_overview, citation_credit_balances; drop table
  citation_import_rows, citation_imports, citation_credit_entries,
  citation_fulfillment_requests, citation_tasks, citation_checks,
  citation_listings, citation_directories, citation_location_identities,
  citation_locations; drop function citation_import(jsonb,jsonb,jsonb,boolean),
  citation_listing_key(text,text)`, plus the trigger functions:
  `guard_citation_location`, `record_citation_identity`, `guard_append_only`,
  `guard_citation_listing`, `guard_citation_check`, `record_citation_check`,
  `guard_citation_task`, `guard_citation_request`, `mirror_citation_request`,
  `stamp_citation_entry`, `stamp_citation_directory`.
- **After real data:** turn the flag off only. The tables are append-only
  evidence; export them first if anything is ever dropped.

## Verification

- `npm test`:
  - `tests/citations.test.mjs`: CSV, mapping, credential refusal, validation,
    keys, comparison, hidden address, export safety, freshness.
  - `tests/citations-database.test.mjs`: PGlite replay plus
    `supabase/tests/sandbox/citations.test.sql`.
- `scripts/test-portal-sandbox.sh` runs the same SQL suite on real Postgres.
- `npm run test:citations-ui` drives the browser flows. Screenshots are in
  `docs/screenshots/citations/`.
