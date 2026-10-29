# New Client Onboarding v1.0

Tom's handwritten master checklist (Oct 29 2026) is one reusable checklist per
client in the CRM. Migration `20261029170000_client_onboarding_checklist.sql`
adds it. The migration is **written, not applied**. Executive OS task
`b067f1cb-daec-48c1-b81e-036d4ca30a8f` tracks it.

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

- **`onboarding_items`** is the standard: 24 items in five sections. Each item
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
  - last verified time and who verified it.

  A row is unique per client, item, site and location.
- **`client_onboarding_events`** is append-only history. It records every
  change to status, evidence, blocker or next action, so completion
  evidence is never lost.
- **`client_onboarding_overview`** is an invoker view, so RLS applies. It
  returns each row plus its registry fields, scope label, linked pipeline
  task and `signal` JSON.
- **`enroll_client_onboarding(client_id)`** adds missing rows and nothing
  else:
  - new items, new sites, new locations;
  - it never changes an existing row;
  - it returns the number of rows added, so a re-run returns 0.

  New full-service clients are enrolled on insert by
  `clients_zz_onboarding_checklist`, which is gated on
  `service_scope = 'full'`. Existing clients are **not** enrolled by the
  migration; the Onboarding tab's button starts them one at a time.

### Statuses

The checklist keeps "access asked for", "connection works" and "data or
listing seen" apart:

| Status | Meaning | Rule |
| --- | --- | --- |
| `requested` | Access asked for | — |
| `in_progress` | Being worked | — |
| `submitted` | Listing created / submitted | evidence; citation items only |
| `claimed` | Listing claimed | evidence; a listing must be **recorded on the Citations tab** |
| `connected` | Connection works | evidence |
| `verified` | Data or listing evidence seen | evidence; **only a signed-in teammate**; citation items need a **current accurate check** |
| `needs_correction`, `inaccessible` | — | next action |
| `blocked` | — | blocking reason |
| `not_applicable` | — | reason (e.g. hidden-address eligibility, no free BBB listing) |

An item is done when it is `verified`, or `not_applicable` with a reason.
Connected is not done.

### Controls

- **No automatic sign-off.** The guard refuses `verified` unless
  `auth.uid()` is a team member. That rules out the worker, the service role
  and a connected account. Once an item is verified, its sign-off cannot be
  re-attributed.
- **Isolation.** A row's site and location must belong to its client. A row
  cannot move to another client, item or scope. Signals and pipeline-task
  links read only the row's own client.
- **No credentials.** The database and the action both refuse anything that
  looks like a password, key or token. Access is tracked on the Access
  tracker and here, never the credential itself.
- **Team only.**
  - RLS uses `is_team()`.
  - `authenticated` has no delete.
  - History and the registry are read-only to the app.
  - `service_role` can only select.
  - No portal view reads the checklist.

## Pipeline templates (future enrollments)

Tasks are copied from templates when a client enrols, so changing a template
only changes what *new* enrollments get. Completed tasks are not touched.

| Was | Now (template) |
| --- | --- |
| Social › Brand & Content Setup: "Connect Metricool" | `zernio_connect`: connect and verify the exact Zernio Facebook Page / GBP destination and posting permission |
| SEO › Tracking Setup: `brightlocal_lsg` (billable LSG report) | `map_grid_profile`: Compass map-grid profile, weekly scans off until Tom enables them |
| SEO › Tracking Setup: `brightlocal_lrt` (billable LRT report) | `bing_webmaster`: Bing Webmaster Tools verified + sitemap (separate from Bing Places) |
| SEO › Local Citations: `citation_submit` "…or run BrightLocal Citation Builder (billable)" | create or claim the listings and record them on Citations; paid Citation Builder only with Tom's written approval |

Tasks that are still **open** from the old templates are not closed or
deleted. They are relabelled "[Legacy — do not buy] …" (BrightLocal) or
"[Legacy] Connect Metricool", with a dated note. Done tasks keep their title,
notes and completion. No BrightLocal subscription is cancelled. The stage name
"Tracking Setup (GSC, BrightLocal)" is kept because worker fires and the skill
use it as an identifier.

## Inventory: Tom's items vs the CRM (before → after)

| Item | Before this change | After |
| --- | --- | --- |
| 1 GSC | **Partial.** `gsc_verify` task; `clients.gsc_property` / brand `gsc_property`; import receipts and integration health. Nothing records "verified for the Compass account" per site. | `gsc_verified` (site), linked to `gsc_verify`; shows the property and the latest import date |
| 2 GA4 | **Partial.** `ga4` task, `sites.ga4_measurement_id`, GA4 imports (only some clients). A property does not prove the tag is installed. | `ga4_stream` (property, stream, tag, key events) and `ga4_reporting` (data proven), kept separate |
| GSC ↔ GA4 link | **Missing** | `gsc_ga4_link` |
| GBP ("connect GBP & GA4") | **Partial.** Foundation `google_access`; Zernio GBP binding; GBP directory in Citations | `gbp_ownership` (claimed, verified, manager, exact place id, UTM on the website link), `citation_gbp`, `zernio_gbp` |
| 3 Bing | Bing Places directory only. **Bing Webmaster Tools missing.** | `bing_webmaster` (site + template) and `citation_bing_places` |
| 4 Apple Maps | Directory `apple_business_connect` exists | `citation_apple` |
| 5 BBB (free) | Directory `bbb` exists | `citation_bbb`, free listing only |
| 6 Socials ("in GSC") | Zernio FB / GBP binding; outdated Metricool template. GSC has no social integration. | `zernio_facebook`, `zernio_gbp`, `social_profile_links` (links plus `sameAs`), `other_social_channels` (per agreement, optional) |
| 7 MapQuest | Directory exists | `citation_mapquest` |
| 8 Yelp | Directory exists | `citation_yelp` |
| 9 Nextdoor | Directory exists | `citation_nextdoor` |
| Website Builds | Website pipeline, `sites.work_mode`, `launched_at` | `website_path` and `website_live_measured` (built ≠ launched ≠ indexed ≠ measured). The detailed Website Builds list waits on Tom's notes. |
| Identity / NAP / service areas | Overview Business card; Citations identities | `identity_business`, `identity_location` (public vs hidden address), `service_areas`, `website_owner`, `access_requests` |

The Citation Tracker has no "claimed" state and no per-directory "not
applicable". The checklist carries both, and a claim is gated on a recorded
listing. A directory with no listing on record is shown as "not proof it does
not exist".

## Where it shows

- **Client › Onboarding** (`/clients/[id]/onboarding`):
  - required items done;
  - progress by section;
  - outstanding blockers (blocked, needs correction / inaccessible, overdue);
  - each item with its signal, linked pipeline task, "waiting on"
    dependencies (judged in the same site / location) and an edit form.
- **Control Center › Client onboarding**: one more check per client, "New
  client onboarding checklist".
  - Missing until started.
  - Blocked while any blocker is open.
  - Recorded only when every required item is done.

## Applying it

1. Review, then apply `20261029170000_client_onboarding_checklist.sql`. Apply
   it **before** deploying the code: until then the Onboarding tab shows "could
   not be read" and the Control Center check shows "unavailable".
2. Start one client from its Onboarding tab, in preview first.
3. Rollback: `supabase/rollback/20261029170000_client_onboarding_checklist.down.sql`.
   Export the checklist tables first if any client was enrolled.

## Tests

- `tests/client-onboarding-database.test.mjs` replays every migration into
  PGlite, using the replay hooks `supabase/tests/sandbox/replay/20261029170000.*`
  (fictional clients carrying open and done legacy tasks). It then runs
  `supabase/tests/sandbox/client_onboarding.test.sql`, which covers:
  - legacy preservation;
  - templates and a new social enrollment;
  - idempotent enrollment;
  - client / site / location isolation;
  - evidence rules;
  - sign-off attribution;
  - the Citation Tracker gate;
  - history;
  - team-only access.

  The same suite runs natively in `scripts/test-portal-sandbox.sh`.
- `tests/client-onboarding.test.mjs` covers the pure helpers (summary,
  dependencies, signals, update validation) and the Control Center check.
