# Google Business Profile performance

The Progress dashboard and Reports scorecard show monthly GBP performance through
Zernio's existing connection. Metrics: profile impressions, website clicks,
call-button clicks and direction requests. Impressions sum desktop/mobile Search
and Maps counts; they are not deduplicated people. Call clicks are not confirmed
or answered calls. There is no per-post GBP analytics claim.

## Source and identity

Official contract verified October 12, 2026:
https://docs.zernio.com/analytics/get-google-business-performance
https://docs.zernio.com/platforms/google-business/analytics

The `gbp-performance` Edge Function uses `ZERNIO_READ_API_KEY` from Vault. Every
provider request is GET to the fixed Zernio origin, redirects refused, 20-second
timeout. It uses already bound `google_business` accounts for active/launching
clients. It verifies the selected location before retrieval and again before
commit. The database checks and locks the CRM binding before writing. Shared GBP
figures belong to the bound client, never copied into separate brand totals.

Provider error text and credentials are not logged or returned. A 401/402/403/429
or changed location stops that client's remaining requests. Missing/incomplete
historical months are recorded as failures and later available months can proceed.
Nothing reconnects an account, changes billing or posts content.

## Import and history

POST accepts optional `client_id` and `months` (1-12, default 3). Only a team admin
or the existing `SYNC_CRON_SECRET` operator door can invoke it. Gateway JWT
verification stays enabled. Production returns 202 plus `run_id`, then uses
`EdgeRuntime.waitUntil` to finish the import. Durable `gbp_performance_sync_runs`
records completion/partial results and safe error codes. A run left running for
more than ten minutes indicates interruption and should be retried; do not infer
success from 202. Retries are idempotent at the recorded-month boundary.

Months are processed oldest first. The importer excludes the current month and
allows four completed days for Google reporting delay. It requires every daily
observation for all seven source metrics, exact account/platform/date range,
nonnegative integers, unique days, and daily sums equal to reported totals. An
absent value is never assumed to be zero.

`gbp_performance_record` accepts only a real PostgREST service session. It writes
an immutable receipt with daily evidence and appends four report measurements in
one transaction. Identical latest receipts return unchanged; revised receipts
append corrections. Original ledger baselines remain fixed. Imported history is
labelled first available measurement, not verified before work began.

The existing team/portal report views display the imported rows; no new portal
access path is added. Receipt data and operational run logs are team-only.

## Scheduling and rollout

Migration `20261012184123_gbp_performance_import.sql` adds the metric contract,
receipts, run log, writer and daily `gbp-performance-daily` job at 09:00 UTC.
The job refreshes the latest three eligible completed months to capture revisions.
Initial rollout requests six months for Lucas. Other clients participate when an
exact GBP binding is connected in Compass and the read key can access it.

Release order: apply migration, deploy the function (verify_jwt true), release
updated app labels, invoke the six-month backfill, confirm finished run records,
verify ledger totals and live dashboard. Do not import the new direction metric
before the updated app is ready. If rolling back the app, first ensure it recognizes
the new metric key or pause the importer and retain the current rendering code.
No destructive down migration or baseline deletion is appropriate.

## Verification

- `tests/gbp-performance.test.mjs`: dates/delay, zeros, incomplete/duplicate data,
  wrong accounts, totals, GET-only transport, location drift, provider failures,
  database failures and unauthorized callers.
- `supabase/tests/sandbox/gbp_performance.test.sql`: real service-session boundary,
  tenant/location match, whole-month windows, idempotent retries, appended
  corrections, fixed baseline and tenant-scoped portal visibility.
- SQL runs in PGlite full replay and native PostgreSQL CI; browser acceptance
  checks direction-request rendering and automatic-source disclosure.
