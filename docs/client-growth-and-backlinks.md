# Client progress and backlink acquisition

Tom's October 12 scope: a broad client dashboard showing a fixed starting
baseline and progression, plus backlink acquisition and tracking. Visitor
identification is excluded. AI visibility is not the dashboard's focus.

## Routes and behavior

- Team: Clients > Progress (`/clients/[clientId]/growth`) and Backlinks.
- Client: portal > Progress (`/portal/growth`) and Backlinks.
- Progress reads the existing append-only report ledger. Reports remains the
  place to record measured values, unavailable data, and subsequent observations.
- Each source/scope/platform/channel series retains its first recorded measured
  baseline. Backdating a new entry cannot replace it. Current follows observation
  dates; a correction for the same window wins without replacing the baseline.
- Since-start, monthly, and custom views include complete measurement windows.
  Baselines remain fixed outside the selected range. Future baselines are hidden
  in historical views. Missing values are not zero; incompatible windows have
  no growth delta. Stale observations are labeled.
- Existing GSC query/page imports appear as a separate dated history. They are
  explicitly partial imported-row aggregates, not complete property traffic.
  They are not silently promoted into immutable verified baselines.
- The portal overview links to Progress; existing rankings, work log, reports,
  inquiries and billing stay available.

## Backlink workflow

A teammate chooses an existing active keyword and an exact target page, records
an external source page, relevance category, next action, due date and internal
notes. A keyword's service resolves its brand workspace when the client has
multiple brands. The database rejects foreign-client keywords, wrong-brand
service ownership, sibling-brand targets, and internal self-links.

Research > Ready for outreach > Contacted > Submitted > Placement reported;
Closed is available for unsuitable or completed opportunities. Saving a stage
never sends a message. Placement reported is not proof that a link is live.

A teammate opens the source page and records a dated check, link attributes,
anchor and evidence. Checks are append-only. Unreachable is separate from
missing; a missing link is classified as lost only after a previous live check.
Checks older than 30 days need rechecking. Counters cover managed placements,
not the entire web backlink profile. Distinct referring websites are normalized
hostnames (www removed), not a paid provider's registrable-domain index.

Placement identity and URLs are immutable so evidence cannot be moved onto a
different placement. Updates use an updated_at concurrency check. Create/check
submissions have stable IDs and detect conflicting retries.

## Security and rollout

Migration `20261012173948_client_growth_and_backlinks.sql` is additive. No
provider purchases, billing changes, mass link exchanges, outreach, or portal
invitations are performed. The portal follows the established 0037 boundary:
owner views, security_barrier, explicit portal_client_id() filtering, SELECT
only grants, and no underlying table access. Internal notes, evidence, next
actions, and actor IDs are excluded from portal views. Opportunities that have
never had a live check are not client-visible.

Apply the reviewed migration before releasing the app. Roll back the app by
reverting this feature commit; retain the additive tables and append-only
history. No destructive down migration is needed.

## Validation

- `node --test tests/client-growth.test.mjs tests/client-growth-database.test.mjs`
  checks fixed baselines, date windows, unknown data, source separation, checks,
  and full PGlite migration replay with A/B/stranger/inactive portal isolation.
- `scripts/test-portal-sandbox.sh` includes `client_growth.test.sql` in the full
  native PostgreSQL access suite. Native CI remains the release gate.
- `CHROME_PATH=/usr/bin/google-chrome node tests/client-growth-ui.mjs` exercises
  rendering, filters, mobile overflow, failed-save retention, opportunity creation,
  stage changes, verification recording, and portal views with synthetic API data.
  Screenshots are uploaded by CI. The SQL tests separately validate real RLS.
- TypeScript, lint, build, and the existing test suite remain required.

## Data coverage and remaining operations

At inspection on October 12, six clients had imported GSC history and Resilient
Boxing had 40 ledger entries. That is an observed starting state, not a guarantee
that all nine areas are connected. Historical onboarding measurements require
actual dated evidence. The release does not invent earlier values or imply that
GA4 or a backlink provider has been connected.

Acquisition research/outreach and link verification are human-operated in this
release. Automated external crawling, full-profile backlink-provider ingestion,
GA4 ingestion, automated outreach, and AI-visibility scans are separate future
integrations. Any later integration must preserve sources, client/brand scope,
immutable baselines, and explicit unavailable states.

## Implementation verification, October 12

Implementation is on `codex/client-progress-backlinks`, pull request #125.
TypeScript, ESLint, the production webpack build, and all six new feature and
full-replay database tests passed locally. The complete test suite passed in
GitHub CI; the local social-post-review test process was killed with SIGKILL
without an assertion failure.

Native PostgreSQL replay reached 689 passing generic portal access checks.
Growth-specific checks use their own fixture IDs while rejecting all foreign
client rows, allowing other ledger fixtures to coexist. All native suites remain
required on the final branch head.

Browser verification covers baseline comparisons, date filters, mobile overflow,
failed-save retry retention, backlink workflow actions and client-only views.
It found a form reset after failed saves, which is fixed by retaining input values
until successful completion. Screenshot review found dark inherited headings on
dark hero panels; explicit white headings and a computed-color assertion fix this.
CI uploads screenshots for visual review. Final CI results are tracked on the PR.

Tom explicitly authorized uploading this branch and opening a pull request on
October 12. The connected GitHub app performed the upload. PR #125 was merged and released on October 12 after final CI passed.
Supabase recorded the migration as `20261012181624`; Vercel production deployed
main commit `d7f2c2f10023a633f6f379845cfce843d356996d`.


## Keyword and Maps ranking summary

Migration `20261012182258_dashboard_ranking_metrics.sql` adds team and tenant-scoped
portal read models. The dashboard counts every active tracked keyword, including
keywords without snapshots. It displays organic and Maps/GBP top-3 and top-10
keyword totals plus average positions. Each keyword qualifies once in any checked
location; averages cover ranked keyword/location pairs and exclude not-found rows.
No checks is unavailable, not zero. Checks older than 14 days are flagged.

The expandable table compares first and latest DataForSEO checks for the same
keyword, location and result type. Other sources and future checks are excluded.
The first chronological check is labeled as such, not an onboarding baseline.
A missing latest position remains missing even when an earlier rank exists.
This operational snapshot is independent of the dated scorecard filters. GBP
views, calls and website clicks still require separate performance ingestion.

`tests/growth-rankings.test.mjs` covers counting, missing values and movement.
`growth_rankings.test.sql` covers source/location separation, null latest ranks,
untracked keywords, tenant isolation and read-only grants in both replay suites.
The existing browser acceptance covers summary totals, comparisons and mobile layout.
Apply the additive migration before releasing this dashboard extension.

## Interactive performance design (October 12, 2026)

The Progress dashboard now opens with a performance studio: selectable metric
cards, an accessible line/bar chart, a baseline toggle, dated inspection buttons
and recent-measurement controls. A GBP action donut requires all three action
metrics to share an exact period, source and scope. It never mixes impressions
with actions or treats actions as unique people. Ranking segments are disjoint
per keyword using the best checked location; selecting one filters the searchable
keyword table. Reporting date filters still apply to complete measurement windows,
and original baselines remain fixed. The ranking snapshot is independent of those
filters. Full measurement records and missing coverage remain under expandable
sections. Team and portal render the same charts from existing scoped data.
No new provider calls, database schema, or access permissions are introduced.
