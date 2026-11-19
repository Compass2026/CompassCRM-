# New Client Onboarding v1.0

Tom's handwritten master checklist (Oct 29 2026) is one reusable checklist per
client in the CRM. Migration `20261029170000_client_onboarding_checklist.sql`
adds it. It is **written, not applied**. Executive OS task
`b067f1cb-daec-48c1-b81e-036d4ca30a8f` tracks it, and ChatGPT reviewed it on
PR #200.

The checklist is not a second system. Each item points at the record that
already exists:

- the pipeline task (`tasks.key`);
- the Citation Tracker listing (`citation_listing_overview`);
- the Search Console / GA4 import receipts;
- the Zernio binding (`social_accounts`);
- the site record (`sites`);
- the Access tracker (`client_access`).

Those records appear beside each item as a *signal*. A signal never changes
an item's status. A teammate changes it, with evidence.

## Model

- **`onboarding_items`** is the standard: 26 items in five sections. Each item
  has a scope:
  - `client`: one row per client;
  - `site`: one row per `sites` row;
  - `location`: one row per active `citation_locations` row, the approved
    identity of a real business.

  Each item also records a default owner, whether it is required, its
  dependencies, the evidence source, the citation directory (for C items)
  and the linked pipeline task key.
- **`client_onboarding_items`** holds per-client state. Each row has:
  - status, required, owner, due date;
  - evidence URL and note;
  - blocking reason and next action;
  - `social_account_id`, the exact Business Profile or Facebook Page the item
    is about;
  - last verified time and who verified it.

  A row is unique per client, item, site and location.
- **`client_onboarding_events`** is append-only history of every change to
  status, evidence, blocker, next action or named account.
- **`client_onboarding_overview`** is an invoker view, so RLS applies. It
  returns each row with its scope label, linked pipeline task and `signal`
  JSON. The signal's `scope` tells you what it is about:
  - `exact`: this site, this location, or the named account;
  - `unlinked`: no account named yet, so the counts are client-wide and are
    not evidence;
  - `client`: a client-scoped item.
- **`client_onboarding_gaps`** is an invoker view. It lists what an enrolled
  client still lacks (see "Nothing is complete by omission").
- **`enroll_client_onboarding(client_id)`** adds missing rows and nothing else:
  - new items, sites and locations;
  - it never changes an existing row;
  - it returns the number of rows added, so a re-run returns 0.

## Nothing is complete by omission

This section answers the release-blocker items from the review.

**Scope is a decision.**

- Two required client items are scope decisions:
  - `scope_sites`: every website the client runs is recorded as a site, or
    "no website" is decided;
  - `scope_locations`: every listing-eligible location is approved on the
    Citations tab, or "none eligible" is decided.
- **Verified** is refused while nothing is recorded, or while any recorded
  site or location lacks its checklist rows.
- **Not applicable** needs a reason. It is refused while a site or location
  exists.
- `client_onboarding_gaps` reports each of these:

  | Gap | When |
  | --- | --- |
  | `no_site` | No site recorded and "no website" not decided |
  | `no_location` | No location approved and "none eligible" not decided |
  | `site_missing_items` / `location_missing_items` | A site or location has fewer rows than the standard (for example, the standard grew) |
  | `site_after_none` / `location_after_none` | A site or location was recorded after "none" was decided |

- **A client is complete only when there are no gaps and every required item
  is done.** A gap keeps the Control Center check "Blocked".
- **Scope added later.**
  - A site inserted for an enrolled client gets its rows at once
    (`sites_zz_onboarding_checklist`).
  - So does a location approved or re-activated
    (`citation_locations_zz_onboarding_checklist`).
  - A location that is archived keeps its rows as history; they stop counting.

**Prerequisites are enforced.**

- An item is verified only when every dependency row is done (verified, or
  not applicable). The dependency row must exist for the same site or
  location; a client-scoped dependency uses the client's row.
- A missing row is a **missing prerequisite** and is never treated as
  satisfied. Another site's or location's row never stands in.
- The migration refuses a registry dependency that crosses scopes.
- The UI shows "Missing prerequisite" / "Waiting on" on the item.
- A sign-off whose prerequisite is later reopened stops counting, and is
  listed as "Prerequisite reopened".
- Not applicable (with its reason) needs no prerequisite.

**Evidence is matched exactly.**

| Item | Verified requires |
| --- | --- |
| `gsc_verified` | A Search Console import whose property host (`sc-domain:` or URL prefix) is this site's own host. Another site's or client-wide property never counts. |
| `ga4_stream` | This site's measurement id, either on `sites.ga4_measurement_id` or `G-…` in the evidence. |
| `ga4_reporting` | A GA4 import whose recorded hostname is this site's host. |
| `gbp_ownership` (location) | This location's own Business Profile named on the item, or its GBP listing recorded on Citations. |
| `zernio_gbp` (location) | The named profile is a **verified Zernio binding**. |
| `zernio_facebook` (site) | The named Page is a verified Zernio binding. On a brand site it must be the brand's own Page (`client_brand_workspaces.facebook_account_id`). |

Account rules:

- A profile or Page can be named on one location or site per item (unique
  index). Wichita's binding can never credit Overland Park.
- A location's GBP items must name the same profile.
- The account must be this client's and on the right platform.

Pipeline tasks linked from items are labelled **client-wide**.

## Statuses and controls

The checklist keeps "access asked for", "connection works" and "data or
listing seen" apart:

| Status | Meaning | Rule |
| --- | --- | --- |
| `requested` | Access asked for | — |
| `in_progress` | Being worked | — |
| `submitted` | Listing created / submitted | evidence; citation items only |
| `claimed` | Listing claimed | evidence; a listing must be **recorded on the Citations tab** |
| `connected` | Connection works | evidence |
| `verified` | Data or listing evidence seen | evidence + prerequisites + exact match; **only a signed-in teammate**; citation items need a **current accurate check** |
| `needs_correction`, `inaccessible` | — | next action |
| `blocked` | — | blocking reason |
| `not_applicable` | — | reason |

- **No automatic sign-off.** `verified` is refused unless `auth.uid()` is a
  team member. That rules out the worker, the service role and a connected
  account. Once an item is verified, its sign-off cannot be re-attributed.
- **Isolation.** A row's site, location and named account must belong to its
  client. A row cannot move to another client, item or scope.
- **No credentials.** The database and the action both refuse anything that
  looks like a password, key or token.
- **Team only.**
  - RLS uses `is_team()`.
  - `authenticated` has no delete.
  - History and the registry are read-only to the app.
  - `service_role` can only select.
  - No portal view reads the checklist.

### Who is enrolled automatically

| Client | Enrolled? |
| --- | --- |
| New full-service client (New client dialog or a service-role load) | Yes, on insert (`clients_zz_onboarding_checklist`, gated on `service_scope = 'full'`); its site rows follow when the site is recorded |
| Map-tracking-only client (`service_scope = 'map_tracking'`) | **No.** The tab says so, and the Control Center lists full-service clients only. Starting the checklist there is a deliberate full-service step (the 20261015170000 rule). |
| Existing clients (before the migration) | **No.** Each is started from its Onboarding tab, and only with Tom's say-so. |

## Pipeline templates (future enrollments only)

| Was | Now (template) |
| --- | --- |
| Social › Brand & Content Setup: "Connect Metricool" | `zernio_connect`: connect and verify the exact Zernio Facebook Page / GBP destination and posting permission |
| SEO › Tracking Setup: `brightlocal_lsg` (billable LSG report) | `map_grid_profile`: Compass map-grid profile, weekly scans off until Tom enables them |
| SEO › Tracking Setup: `brightlocal_lrt` (billable LRT report) | `bing_webmaster`: Bing Webmaster Tools verified + sitemap (separate from Bing Places) |
| SEO › Local Citations: `citation_submit` "…or run BrightLocal Citation Builder (billable)" | create or claim the listings and record them on Citations; paid Citation Builder only with Tom's written approval |

**The migration changes no existing task.** Relabelling the still-open legacy
BrightLocal / Metricool tasks is a separate script,
`supabase/deferred/20261029_legacy_task_labels.sql`:

- **Preview first.** It carries a read-only preview query: task ids, clients
  and count.
- **Count guard.** It runs only with the reviewed count set
  (`compass.expected_legacy_tasks`); any other count refuses the whole script.
- **Labels only.** It prefixes "[Legacy — do not buy]" / "[Legacy]" and
  appends one dated note line. It never touches a done task, a status or an
  id.

The stage name "Tracking Setup (GSC, BrightLocal)" is kept because worker
fires and the skill use it as an identifier.

## Inventory: Tom's items vs the CRM (before → after)

| Item | Before this change | After |
| --- | --- | --- |
| 1 GSC | **Partial.** `gsc_verify` task, `clients.gsc_property` / brand `gsc_property`, imports, integration health; nothing per site | `gsc_verified` (site), exact host match |
| 2 GA4 | **Partial.** `ga4` task, `sites.ga4_measurement_id`, GA4 imports for some clients | `ga4_stream` (tag) and `ga4_reporting` (data for this host) kept separate |
| GSC ↔ GA4 link | **Missing** | `gsc_ga4_link` (site) |
| GBP ("connect GBP & GA4") | **Partial.** Foundation `google_access`, Zernio GBP binding, GBP directory | `gbp_ownership`, `citation_gbp`, `zernio_gbp` (per location, named profile) |
| 3 Bing | Bing Places directory only. **Bing Webmaster Tools missing.** | `bing_webmaster` (site + template), `citation_bing_places` |
| 4 Apple Maps | Directory exists | `citation_apple` |
| 5 BBB (free) | Directory exists | `citation_bbb`, free listing only |
| 6 Socials ("in GSC") | Zernio FB / GBP binding; Metricool template outdated. GSC has no social integration. | `zernio_facebook` (site, named Page), `zernio_gbp`, `social_profile_links` (links + `sameAs`), `other_social_channels` (optional) |
| 7 MapQuest | Directory exists | `citation_mapquest` |
| 8 Yelp | Directory exists | `citation_yelp` |
| 9 Nextdoor | Directory exists | `citation_nextdoor` |
| Website Builds | Website pipeline, `sites.work_mode`, `launched_at` | `website_path`, `website_live_measured` (built ≠ launched ≠ indexed ≠ measured). The detailed list waits on Tom's notes. |
| Identity / scope | Overview Business card; Citations identities | `identity_business`, `scope_sites`, `scope_locations`, `identity_location`, `service_areas`, `website_owner`, `access_requests` |

## Where it shows

- **Client › Onboarding** (`/clients/[id]/onboarding`):
  - required items done, and whether the client is complete;
  - progress by section;
  - outstanding blockers: scope gaps, blocked, needs correction, missing or
    reopened prerequisites, overdue;
  - each item with its signal (client-wide signals labelled), linked
    pipeline task, prerequisites, named-account selector and edit form.
- **Control Center › Client onboarding**: one check per client.
  - Missing until started.
  - Blocked while any gap or blocker is open.
  - Recorded only when complete.

## Applying it

1. Wait for ChatGPT's final review and Tom's go-ahead. Then apply
   `20261029170000_client_onboarding_checklist.sql` **before** deploying the
   code. Until it is applied, the tab shows "could not be read" and the
   Control Center check shows "unavailable".
2. Start one client from its Onboarding tab, with Tom's authorization.
3. Optionally, after review of its preview, run the deferred legacy-label
   script.
4. Rollback: `supabase/rollback/20261029170000_client_onboarding_checklist.down.sql`.
   Export the checklist tables first if any client was enrolled. The rollback
   also undoes the deferred labels.

## Tests

- **`tests/client-onboarding-database.test.mjs`** (PGlite) replays every
  migration, with replay hooks putting open and done legacy tasks on
  fictional clients. It then runs `supabase/tests/sandbox/client_onboarding.test.sql`:
  - **L** the migration rewrites no existing task;
  - **T** templates and a new social enrollment;
  - **E** enrollment: later sites and locations, service-role inserts,
    map-tracking excluded, idempotent;
  - **G** gaps: no site / no location, "none" decisions, scope added after
    "none", a standard item added later;
  - **S** isolation;
  - **P** prerequisites: same scope only, missing is never satisfied;
  - **M** exact matching: GSC / GA4 host, Wichita vs Overland Park, brand
    Page, another client's or the wrong platform's account;
  - **V** evidence and sign-off;
  - **C** the Citation Tracker gate;
  - **O** overview;
  - **A** team-only access.

  The runner then exercises the deferred script (refuses without or with the
  wrong count, labels open tasks only) and the rollback. The same suite runs
  natively in `scripts/test-portal-sandbox.sh`.
- **`tests/client-onboarding.test.mjs`** covers the pure helpers (no false
  green with gaps, exact prerequisites, labelled signals, update validation)
  and the Control Center check.
- **`npm run test:onboarding-ui`**
  (`scripts/test-tasks-ui.sh` + `tests/onboarding-ui.mjs` +
  `onboarding_ui_fixtures.sql`) runs a throwaway Postgres replay behind
  PostgREST, `next dev` and Chrome. It covers:
  - the Onboarding tab;
  - sign-off, and refusal on an unmet prerequisite;
  - the Citation Tracker link;
  - Start and re-run on an existing client, with its scope gaps;
  - Control Center progress;
  - New client creation;
  - the map-tracking notice;
  - phone width.

  Nothing touches the Supabase project.
