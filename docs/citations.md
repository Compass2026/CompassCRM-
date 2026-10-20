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
`supabase/migrations/20261020230000_citations_foundation.sql`.

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
  written only by the trigger. Each check records the version **in effect on its
  date** (`checked_on`), not the one in force when it was typed in. A check dated
  before any approved identity records version 0.
- `citation_directories`: the shared publisher registry (17 seeded reference
  rows). `hidden_address_support` stays `unknown` until confirmed.
- `citation_listings`: one row per location × directory × `listing_key`. The
  key is the normalized URL, else the external id, else the one URL-less slot.
  Several keys for one directory are flagged as suspected duplicates. URL,
  location and directory are fixed after insert. `source_name / address /
  phone / website` are what the import or provider observed, with
  `source_provider`, `source_observed_on` and `last_imported_at` as provenance.
  Verification is **not stored** on the listing.
- `citation_checks`: append-only teammate evidence (date, method, result,
  observed fields, evidence text, optional link). The database refuses
  method/result pairs that cannot support each other. An accurate or
  discrepancy verdict must record at least one value that was seen.
- `citation_listing_overview`: **the one current-evidence projection**. The
  location page, the overview, the filters, the counts and the CSV all read it.
  For each listing it carries the latest check (by date, then entry time), that
  check's identity version, the identity-aware `verification_status`, the
  `current_*` observations, and the import's `source_*` values beside them.
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
| Independent verification | unverified, verified accurate, discrepancy, inaccessible, confirmed absent, **needs reverification** | derived in `citation_listing_overview` from the latest dated check and its identity version; nothing can store or edit it |
| Open issues | open / in progress / waiting tasks | the queue |

- A provider's "complete" never verifies anything. "Provider complete,
  unverified" is counted on its own and is part of "action required".
- A search that finds nothing is recorded as **not found**: the listing stays
  unverified.
- **Confirmed absent** needs `owner_dashboard` or `publisher_confirmation`.
- The latest check by date decides verification; a backdated entry never
  overrides a newer one. Ties on date and entry time are broken by the check's
  insertion order (`seq`), never by a random id.
- **Identity changes.**
  - A change to name, address, phone, website or the hidden-address setting
    creates a new version.
  - If the latest check was made against an older version, the listing becomes
    **needs reverification**: on the page, in the overview counts and filters,
    in "action required" and in the CSV. The check history is kept.
  - A notes-only or label-only edit changes nothing.
  - A new check dated on or after the change restores current verification.
  - A check dated before the change records the older version, so it cannot
    count for the new identity.
- **Current evidence** is the latest check's observations, and only for a
  verdict on the listing's content (accurate / discrepancy).
  - A blank field means "not recorded in that check".
  - An inaccessible, not found or confirmed absent check observes nothing, so
    there are no current values.
  - The import's values are never shown as checked. They stay in the
    `Source *` columns with their own dates.
  - The field-by-field comparison uses the latest content check. With no check
    at all it uses the import, labelled "imported observation, not verified".
- **Freshness.**
  - Evidence is **current** when the latest check is under 90 days old and was
    made against the current identity.
  - Otherwise it is **stale** (over 90 days), **superseded** (identity changed
    since the check) or **never checked**.
  - Reports show each of these separately.

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

Two formats:
- **Generic mapped CSV:** no provider format is assumed; the steps below.
- **BrightLocal Citation Builder campaign export:** a fixed contract taken from
  a real export. See the section after this one.

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
   rejects its rows; nothing is guessed. Any distinct value that looks like a
   secret is masked before it is shown.
4. **Directories.** A row's directory is matched against the registry by name,
   key, domain or alias (for example, `maps.apple.com` is Apple Business
   Connect), then by the listing URL's host. Unknown directories are rejected and
   named in the preview unless "add directories" is ticked. With it ticked, the
   preview lists every directory the import would add and writes nothing, so a
   person can check none is another name for an existing one.
5. **Preview, then import.** Both run `citation_import()`; the preview rolls
   back (SQLSTATE `CIT01` inside the function). Counts are added / updated /
   skipped / rejected / **held**, with a reason per row, and always reconcile.
   Held rows are attempts a provider-format preparation routed to review or
   history. They are recorded on the import and are never listings.
   - A repeat import of the same rows adds nothing.
   - Committing the same import id twice returns the first result.
   - A row identical to the stored one is "unchanged".
   - An observation older than the stored one is skipped.
   - Empty cells never clear stored values.
   - Two rows for the same listing in one file: the second is rejected.

Fixtures: `tests/fixtures/citations/`. Everything there is fictional and
labeled SAMPLE / SYNTHETIC; no real customer export is committed.

### Content screening (credentials and private links)

Column headers that look like logins are refused (`isCredentialHeader`), but a
mapped column can still carry secrets in its cells. A real BrightLocal export's
Notes held a plaintext login and a tokenized verification link.
`sensitiveContent()` screens:
- every mapped cell (on the server, before anything is written);
- every free-text form field (notes, evidence, reasons, resolutions, references,
  identity notes);
- the distinct location values before the browser shows them.

It recognizes:
- credential assignments: `Password: …`, `login = …`, `user name = …`, `PIN: …`,
  `API key …`, `token: …`, `… password is …`;
- tokenized links: `?token=` / `code=` / `sig=` / `reset=` … with a long value,
  `/verify/…`, `/confirm/…` or `/reset/…` paths ending in a long token, and JWTs.

A flagged import row is rejected with a generic reason ("Notes looks like it
contains a login or a private account / verification link"). The value is
never echoed into the preview, the row outcome, the import record or an error.
A flagged form field is refused the same way.

**The serialization boundary.** No recognized value leaves through import
metadata either:
- **Held rows (BrightLocal):** Status, Site and No go through `safeLabel()`
  before any reason or count key is built. A flagged value becomes "(withheld:
  looked like a login or private link)". A non-numeric row number is shown as
  "?". Counts stay exact.
- **Location mapping:** the stored mapping (`storedLocationMapping`) keeps only
  screened values that point at one of the client's locations. A flagged key is
  dropped and counted (`withheld`), even when other rows import.
- **File and headers:** the file name is withheld when flagged
  (`storedFileName`). A mapped header that looks like a secret is refused; such
  headers are not offered in the column choices, and the browser masks the file
  name and location values.

Ordinary wording passes ("owner verification required", "client login required
for edits", "verification email not received"). This catches the obvious
cases; it is **not** universal secret detection. Credentials belong in the
approved secret store.

## BrightLocal campaign exports

Contract from the real export for Logic Solar Overland Park (campaign 908272,
reconciled by ChatGPT on Oct 20 2026): the columns `No, Citation Site, Type of
Site, Domain Authority, Citation Value, Submitted, Status, Citation Link,
Notes`, in that order. There is one row per directory attempt, then a
single-cell "Aggregator/Network" footer that is not a listing.
`src/lib/citations-brightlocal.ts` and the import's "File format" choice
(auto-detected from the header) prepare it:

| CSV | Becomes |
| --- | --- |
| Status `Live` / `Updated` | listing, provider status **provider complete** (never verification) |
| Status `Submitted` | listing, provider status **submitted** |
| Any other status (`Unavailable`, blank, anything new) | **held** on the import with its (screened) CSV status and submitted date: not a listing, not proof of absence, no spend |
| `Submitted` date | kept in the listing's note as "provider submitted YYYY-MM-DD (not an observation date)"; never `source_observed_on` |
| `Notes` | **never read.** Only the count of non-empty Notes is reported. A separately reviewed safe summary per row can be added in code (`safeNotes`), and it is screened |
| footer row | skipped and counted |

- **Held-only files.** A file of only historical attempts (or a repeat file
  whose active rows all skip) can be saved. The button says "Save import
  history (N held, no listings)" or "Import N rows and record M held". An
  import with nothing to save stays disabled ("Nothing to import"). The import
  id keeps a retried save idempotent.
- One campaign export is one business location, chosen by hand.
- The provider label is BrightLocal.
- BrightLocal's UI shows some held attempts as "Replaced". The CSV doesn't say
  that, so the CSV's own status is what's kept.
- The synthetic fixture `synthetic-brightlocal-campaign.csv` follows the
  contract exactly, including fake secrets in Notes.

## Pilot: Logic Solar, Overland Park (sandbox rehearsal, Oct 20 2026)

**Rehearsed:**
- `npm run test:citations-pilot` replays the whole pilot in the sandbox with the
  synthetic campaign file. That is the committed evidence.
- With `PILOT_CSV=<sanitized generic CSV> PILOT_IDENTITY=<json>` the same
  rehearsal runs on the real sanitized rows. Both inputs stay outside the
  repository, and so should `SCREENSHOTS`.
- On Oct 20 it ran on the real 11 rows. They were rebuilt from ChatGPT's
  transcription of campaign 908272 (exact URLs and statuses, safe notes only),
  because the sanitized library file is not reachable from this machine.

**Steps and results:**
1. **Identity.** The proposed identity was entered by hand as a hidden-address
   location (sandbox only).
2. **Directory review, without creation.** 2 rows resolve (Yelp; Apple via the
   `maps.apple.com` alias). The 9 others are named and rejected:
   merchantcircle.com, provenexpert.com, brownbook.net, tupalo.com,
   callupcontact.com, cybo.com, trepup.com, ezlocal.com, us-info.com.
3. **Directory review, with creation.** The preview lists those 9 and writes
   nothing.
4. **Import.** 11 added, 0 rejected. The synthetic file additionally holds 4.
5. **Repeat.** 0 added, 11 skipped, no new directories.
6. **State.** 11 listings:
   - 9 provider complete, 2 submitted;
   - all 11 unverified;
   - 0 check dates, 0 observation dates, no observed NAP;
   - 9 with URLs, 11 distinct keys;
   - no raw Notes anywhere.
7. **Review queue** (nothing marked corrected):
   - 9 verify tasks, one per linked listing, opened by "Queue verification for
     linked listings". A repeat run adds 0;
   - Yelp owner verification (personal + phone, flagged by BrightLocal);
   - Apple: find the current listing and who controls it;
   - Bing: presence / ownership investigation before any creation.
8. **Export.** 11 rows, all Unverified / Never checked, street withheld in the
   client-safe file.

**Reconciliation of campaign 908272** (15 directory rows + footer):

| Source rows | Directory | CSV status | Pilot treatment |
| --- | --- | --- | --- |
| 2–9 | merchantcircle.com, provenexpert.com, brownbook.net, tupalo.com, callupcontact.com, cybo.com, trepup.com, ezlocal.com | Live | listing, provider complete, unverified, verify task |
| 10 | us-info.com | Updated | listing, provider complete, unverified, verify task |
| 11 | maps.apple.com | Submitted | listing (Apple Business Connect), submitted, no URL; investigate task |
| 12 | yelp.com | Submitted | listing, submitted, no URL; owner verification task |
| 13 | manta.com | Unavailable (UI: Replaced) | **held**: provider says the confirmation email was not received |
| 14 | bing.com | blank (UI: Replaced) | **held**: historical provider technical issue. Not absence, not a current outage. Bing investigation task at the location |
| 15 | all.biz | blank (UI: Replaced) | **held**: provider reports uncontrolled merging of locations; **excluded from the fulfillment queue** pending review |
| 16 | clutch.co | blank (UI: Replaced) | **held**: provider cited B2B eligibility (not independently confirmed) |

Totals: 8 Live + 1 Updated + 2 Submitted + 1 Unavailable + 3 blank = 15.
That is 11 active rows and 4 historical exceptions. No spend or credits were
recorded for any of them. The raw export (SHA-256 `5c81a4d0…f6`) is held by
Tom and is not in the repository.

**Address decision (resolved Oct 20 2026):** `hide_address = true` for Logic
Overland Park. Tom explicitly said Logic is a service-area business with no
public address and chose Overland Park for this pilot. That takes precedence
over the older brand-board text (approved Oct 19), which describes a public
Google Business Profile street address.
- The brand-board conflict is **recorded for later correction**, not silently
  rewritten.
- The decision does not verify current GBP visibility, and it does not approve
  the proposed identity (Logic Solar, phone 816-300-5781, website
  https://logic-solar.com, linked to the Overland Park tracking location,
  BrightLocal 3895356). That identity is entered deliberately, never
  auto-approved from `clients.address`.
- Wichita stays separate.
- Verification tasks for a hidden-address location say: if the listing shows a
  street address, record a discrepancy, and never add the street.
- The nine missing registry directories are created through the reviewed
  preview. `hidden_address_support` stays unknown until it is checked.

**Before a production pilot:**
- Who may approve spend: approval is admin-only in code; actual role
  assignments need checking.
- The production migration (`20261020230000`) and `CITATIONS_ENABLED`:
  explicit approval.

## Exports

- Columns come from the overview projection:
  - verification, freshness, last checked, last check result;
  - the identity version checked against, and the current version;
  - current name / address / phone / website;
  - source, source observed, imported at, source name / address / phone / website.
- **Client-safe** (the default): a hidden-address location's street (approved,
  checked or imported) is never written. A public observed address becomes "Address
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
2. Apply `20261020230000_citations_foundation.sql` through the Supabase MCP
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
  citation_locations; drop function citation_import(jsonb,jsonb,jsonb,boolean,jsonb),
  citation_listing_key(text,text)`, plus the trigger functions:
  `guard_citation_location`, `record_citation_identity`, `guard_append_only`,
  `guard_citation_listing`, `guard_citation_check`,
  `guard_citation_task`, `guard_citation_request`, `mirror_citation_request`,
  `stamp_citation_entry`, `stamp_citation_directory`.
- **After real data:** turn the flag off only. The tables are append-only
  evidence; export them first if anything is ever dropped.

## Complete reads

PostgREST caps every response (`db-max-rows`), and a single `.limit(n)` returns
at most the cap without saying so. Every Citations list (listings, tasks,
locations, requests, credit balances, directories, a page's check history, the
export) is read through `src/lib/fetch-all.ts`:
- it asks for an exact count;
- it advances by the rows actually received, so a cap below the page size cannot
  skip rows;
- it fails if the total is not reached, the count moves mid-read, or a page
  comes back empty early.

On failure the page hides its counts and tables and says why. It never shows a
partial list as if it were complete.

Latest evidence per listing comes from the overview projection (one lateral
lookup per listing). A busy listing's history therefore cannot displace another
listing's latest check. The location page pages its display at 100 listings;
counts and filters always cover the whole location.

## Verification

- `npm test`:
  - `tests/citations.test.mjs`: CSV, mapping, credential refusal, validation,
    keys, comparison, hidden address, export safety, freshness.
  - `tests/citations-database.test.mjs`: PGlite replay plus
    `supabase/tests/sandbox/citations.test.sql`.
- `scripts/test-portal-sandbox.sh` runs the same SQL suite on real Postgres.
- `tests/fetch-all.test.mjs`: complete reads through a 1,000-row cap and a cap
  below the page size; partial, uncountable or moving data is an error.
- `tests/citations-brightlocal.test.mjs`: the campaign contract, held rows,
  status mapping, Notes exclusion, content screening (positives and innocuous
  negatives) and form-field screening, all on synthetic data.
- `npm run test:citations-pilot`: the pilot rehearsal above. It also covers a
  held-only history file, and secrets in a held row's Status / Site / No and in
  a location-map key, checked in the preview and in what was stored.
- `npm run test:citations-ui` drives the browser flows with PostgREST capped at
  1,000 rows. It includes the identity-change sequence, current evidence vs.
  the import, and 1,200 extra listings (one with 3,500 checks). Screenshots are
  in `docs/screenshots/citations/`.
