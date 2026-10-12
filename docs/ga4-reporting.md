# GA4 reporting and backlink profiles

The `ga4-performance` read-only importer uses the Compass Google connection with
Analytics reporting consent. It validates the assigned `properties/ID`, verifies a
web stream against the client's exact website host, and filters Data API reports
to that host and its www variant. It imports sessions, total users and page views.
Users are distinct per window, not additive across months. These are not leads.

Daily 10:00 UTC refresh, three previous months plus month-to-date by default;
explicit backfills allow six months. Dates use the GA4 property's timezone with
four days left for processing. History begins no earlier than property creation.
Complete months, partial launch months and month-to-date remain separate series.
Partial periods never receive baseline growth comparisons. Empty, thresholded,
sampled or malformed reports never become zero measurements. A newly created
property may have no eligible periods yet. Google can revise processed reports.

The service-only import RPC rechecks the client/property/host binding, validates
counts and writes an atomic receipt plus three append-only ledger observations.
Identical retries are unchanged; corrections append without replacing the first
baseline. Team-readable sync runs preserve short safe error codes. The portal
reuses the existing client-scoped measurement view without exposing import details.
Worker Google operations and publishing permissions are unrelated and unchanged.

## Backlink profiles

Team Backlinks now accepts dated provider reports for client or brand websites:
indexed backlinks, referring websites, and explicitly reported new/lost links.
Provider and coverage are mandatory and form the immutable comparison scope.
Unknown counts remain blank. New/lost counts require the provider's date range;
net domain changes are never reclassified as acquired or lost links. Evidence
stays private. Batch insertion is atomic and repeated submissions are checked.
Profiles appear in team/portal Progress and Backlinks with interactive charts.

This does not purchase or enable a backlink data subscription. A genuine provider
report/export is needed to populate each client's starting profile. Search Console
samples must be labeled as samples. Managed opportunities and manual dated checks
remain separate from the provider index; saving records sends no outreach.

## Verification and operation

Focused importer tests cover auth, stream identity, host filtering, calendar and
launch boundaries, missing data and safe failure handling. The full database
replay tests cover idempotency, corrections, private imports and portal isolation.
Browser acceptance verifies profile saving and chart interactions. Full native
PostgreSQL CI, lint, typecheck and builds are release gates.

October 12 investigation: Lucas's existing layout supports NEXT_PUBLIC_GA_ID but
production lacked it. The verified measurement ID is G-2CSTPLZ0D4. The production
configuration was added and the existing deployed commit redeployed, without
changing client site code. Historical traffic that was never collected cannot be
recovered by this importer. BHG/Resilient properties began September 21; Ginger
began October 11. Do not label their launch periods as full historical months.
