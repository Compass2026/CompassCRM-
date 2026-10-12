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

Local implementation is committed on `codex/client-progress-backlinks`.
TypeScript, ESLint, the production webpack build, and all six new feature and
full-replay database tests passed. The existing full test suite stops in the
unchanged `social-post-review-migration.test.mjs` process after 35 of its checks
pass; it also stops when run alone, without reporting an assertion failure.
That result requires CI investigation before release and has not been waived.

Native PostgreSQL binaries are unavailable in this environment. The mandatory
native sandbox command was attempted; the PGlite replay passed. Browser
acceptance is implemented but has not run: Chrome installation returned an
invalid/empty download. CI has a Chrome-based job and screenshot upload ready.

Tom explicitly authorized uploading this branch and opening a pull request on
October 12. The command-line Git client has no GitHub credentials, so the connected
GitHub app is used for the upload. No production migration or deployment has been
performed. Native and browser CI gates and screenshot review remain required
before releasing the additive migration and app.
