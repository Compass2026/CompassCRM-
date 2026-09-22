# Client baseline and monthly scorecards

Implementation status: review branch, not activated in production. Migration
0041 and the worker instructions must be reviewed before rollout. No BHG Safety
data has been collected or populated by this change.

## Process

1. **Intake:** create the client and confirm owned properties, profiles and
   access. A new TOM task asks for baseline review. Baseline collection does not
   wait for Foundation completion, active status or a monthly cycle.
2. **Starting baseline:** before changing client assets, record available
   measurements and explicit missing-source states across the nine areas.
   Review the evidence. For BHG Safety or any existing client whose work has
   started, label it **First available; work already started**. Never invent a
   historical pre-work baseline.
3. **Plan and delivery:** agree on the next actions. Foundation and department
   pipelines continue under their existing approval rules. A baseline review
   does not authorize publishing, outreach or advertising changes.
4. **Monthly refresh:** capture verified values with actual measurement dates.
   The scorecard compares the selected data month with the preceding data month
   and the original baseline, only where the source, scope and dates agree.
5. **Review and share:** open the nine compact areas, discuss what changed and
   the next action. The worker drafts the Drive report; Tom reviews and sends
   it through the existing `report_send` task. Nothing here automatically sends.
6. **Repeat:** append the next month's evidence. Preserve all earlier records.

The initial task is a review reminder, not a new database gate on all pipelines.
The worker's documented pre-change capture step is procedural. It must be
validated in the controlled worker sandbox before activation.

## Client-facing areas

| Area | Starting metrics |
| --- | --- |
| Website pages & links | Priority pages live, priority pages indexed, broken internal links |
| Citations | Accurate, incorrect and missing listings within the agreed list |
| Backlinks | Unique referring websites, relevant new and lost links |
| Google Business Profile | Profile views, website clicks, call-button clicks |
| Reviews | Total reviews, average rating, new reviews, unanswered reviews |
| Search rankings | Organic top 3, organic top 10, Maps top 3 |
| Search traffic | Search impressions, organic clicks, organic sessions |
| Leads & inquiries | Successful forms, tracked calls, verified qualified inquiries |
| Social media | Posts published, planned posts, reach, engagements, website clicks, net new followers |

Each recorded metric shows its dated baseline, previous month, current month,
change, plain-English meaning and next action. Evidence/history is expandable.
Detailed keyword positions, URL lists and activity records remain in existing
trackers or the report appendix. Use the same scope and dates for posts versus
plan. Do not combine different platform reach totals into unique audience reach.

## Data contract and comparison rules

`report_measurements` is an append-only evidence ledger owned by `client_id`.
It complements raw provider snapshots and `monthly_cycles`, not a replacement
for either. `src/lib/reporting.ts` defines the 31 metrics and nine areas.

- A series is `(client_id, metric, scope, source, platform, channel)`. Scope
  identifies the property/profile, filters and definition. For rankings include
  the keyword-set version, location, device, result type and search depth.
  For citations/pages include the agreed inventory version and denominator.
  Changing any series field starts a separate baseline, displayed separately.
- The first **measured** entry by database-assigned `sequence` is the permanent
  baseline. Unavailable entries do not establish numerical baselines. Metrics
  connected later get their own first measurement date. Date backfills and later
  corrections cannot replace the original baseline.
- Each entry records `context` (`before_work` or `existing_client`), dates,
  status, value, source, evidence, meaning and next action. The database stamps
  sequence, author and creation time, ignoring caller-supplied audit fields.
  Per-series transaction locks serialize initial concurrent submissions.
- `report_period = NULL` means an initial measurement. Otherwise it is the
  first day of the **data month**, with the measurement ending in that month.
  Example: the operational cycle opened October 1 drafts September's scorecard
  using `report_period = 2026-09-01`. Existing cycle labels/automation are unchanged.
- Point metrics use a single date. Flow metrics use inclusive start/end dates.
  Compare non-overlapping equal-length windows, or two full calendar months.
  Calendar month comparisons explicitly disclose possible differences in day
  counts. Never sum overlapping GSC windows or treat a partial window as a full
  month. Point snapshots can be compared at different dates, which are shown.
- Prior means the immediately preceding data month. No carry-forward from an
  older month. The latest appended entry for each series/month is the current
  reviewed value; earlier entries stay in history. Missing is not zero.
- Status is `measured`, `not_measured`, `not_connected`, `stale`, or
  `not_applicable`. Only measured entries accept numeric values. Unavailable
  entries require an explanation and next action. Stale measurements do not
  contribute to deltas; their earlier values remain in history.
- Counts must be whole numbers; rating is 0 through 5; only net new followers
  may be negative. The UI displays neutral deltas, not automatic success claims.
- Call-button clicks are not tracked calls. Form clicks are not successful
  submissions. Qualified inquiries require human verification and a documented
  definition in scope. Store aggregate evidence references, not personal lead data.
- Social series require an explicit platform/profile and organic or paid channel.
  Do not substitute the existing social tracker's `scheduled_at` for proof of a
  publication date. Its historical count is separately labelled in cycle cards.
- Submission `id` is an idempotency key. A retry of identical data returns
  success without another row; conflicting reuse is rejected by the action.
  Importers must reuse a stable ID per source record/version and check payloads
  before treating a duplicate ID as success. A correction uses a new ID and
  explains the correction and original evidence reference in `meaning`.

An incorrect original baseline is retained and must be explained as such in the
report; there is deliberately no destructive baseline-reset button. Source or
scope revisions should be given a new explicit definition, not used to hide errors.

## Entering BHG's first measurements after approval

1. Open **Clients > BHG Safety > Reports**. Confirm the client identity.
2. Choose the month containing the measurement dates and **Starting baseline**.
3. Open **Record a measurement > Start an entry**. Select a metric and record
   scope, provider and evidence. Choose **Work already started / first available
   measurement** unless before-work status is actually documented.
4. Clear Data month for initial-only evidence, or keep the actual month if it is
   also a monthly result. For snapshot metrics, use the same start/end date.
5. Record missing connections with their availability status and an empty value.
   Start with the few meaningful metrics the client can act on; expand later.
6. Review each area's meaning and next action with the client. No fabricated
   data, new provider spending or automatic account connections are needed.

## Integration boundaries

The UI can accept verified measurements now. Existing raw rank and GSC snapshots
can be used as evidence only after confirming their coverage and dates. There is
no new scheduled provider importer in this change. GA4 sessions, GBP performance,
call/form attribution and social performance still require verified manual
exports or future connectors. Legacy `monthly_cycles.summary` is displayed as
an earlier summary and is not silently promoted to a baseline.

The worker contract is updated to populate this ledger and use this report
structure. Runtime execution and provider access remain unverified until the
sandbox rollout. A worker with missing access records missing data, not zero.

## Security and activation review

- Select and insert are team-only via `is_team()`. Anonymous users and client
  portal users have no access to the new table. Actions independently verify
  auth/team membership and client existence; all UI reads filter `client_id`.
- Update/delete are denied by grants, RLS and an immutable-history trigger.
  Even service-role accidental updates/deletes are blocked. Truncate is not
  granted. Client deletion is restricted while reporting evidence exists.
- This retains the current single-agency team model. It is **not** multi-tenant
  organization isolation: Compass team members can access all Compass clients.
  Future agency tenancy needs organization ownership and membership policies.
- `main` lacks migrations 0036-0038, although 0039 and deployment documentation
  reference them. Verify/reconcile the authoritative deployed team-access
  migrations before applying 0041. It fails closed if `is_team()` is absent.
  Never substitute a permissive implementation to make the migration pass.
- Apply first in an isolated database/preview with test identities and fictional
  clients. Review the full migration and its new-intake task trigger. Do not point
  a writable preview at production for the acceptance test.

Sandbox acceptance: create two fictional clients; verify the baseline task;
record 0 and missing values; append all nine areas; compare adjacent months;
change keyword scope/platform/channel and confirm separate series; retry an
identical submission; append a correction and backdated record; confirm baseline
unchanged. Sign in as anonymous/non-team/portal users and confirm reads/writes
are denied. Check form error retention and mobile table scrolling. Run the worker
on one fictional client and verify it drafts the same nine-area report, preserves
actual windows and makes no client-asset changes during capture.

Automated tests use PGlite (real PostgreSQL in-process) with minimal dependencies
to exercise 0041, constraints, history protection, intake tasks and RLS. This is
not a full replay of the incomplete existing migration chain or live Supabase
Auth testing. Separate unit tests cover comparisons, first baselines and input.

Validation commands: `npm test`, `npm run lint`, `npx tsc --noEmit`, and
`npm run build`. The PR workflow runs these without production credentials.
`npm run test:reporting-ui` starts the actual Next.js app against a local fake
auth/REST server and fictional records. Install Playwright Chromium first, or
set `REPORT_UI_CHROMIUM_PATH` to an available Chromium executable. It verifies
nine areas, deltas, error retention, a successful save, social controls and
mobile scrolling. Browser checks do not replace live sandbox identity tests.

Production migration, merge and deployment require explicit review. No
production schema/data, credentials, client repositories or provider accounts
were changed while implementing this branch.

## Rollback

Before deployment, retain the previous app/worker commit and snapshot the
database schema. If the rollout fails, first inspect what applied and which
rows/tasks were created; do not rerun blindly. Restore the previous app and
worker version. Leave the additive ledger and its rows intact so evidence is
not destroyed. With explicit database approval, disable only the
`clients_reporting_baseline` trigger if new-intake tasks are the issue. Existing
monthly cycles and reports do not depend on the new ledger. Do not drop the
table or delete baseline tasks as an automatic rollback.
