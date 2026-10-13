# Control Center provider evidence

This increment extends `/production/health` and PR #147. It does not create a
second dashboard or change the Five-Layer architecture.

## Evidence contract

The signed-in team's Supabase client reads existing RLS-protected configuration,
immutable import receipts and sync outcomes. There is no service key, provider
request, secret lookup, migration, write, or new permission. Only selected safe
columns reach the projection. Raw provider payloads are never serialized to UI.
Exact row counts must match returned data, including when PostgREST caps results
below a requested limit. Partial reads are unknown, never empty or healthy.

The first slice covers GSC, GA4 and GBP/Zernio reporting. It shows configuration,
last attempt and result, last confirmed retrieval, immutable receipt save time,
and each property's latest validated data window. A completed run without useful
outcomes cannot verify delivery. An unchanged result confirms retrieval only when
its period has an existing receipt. Successful windows within partial runs are
visible without treating the overall attempt as healthy. Later recovery replaces
historical failures in current alerts.

Daily retrieval evidence expires after 48 hours for all three daily importers.
GSC/GBP complete-month windows expire after 45 days. GA4 month-to-date windows
expire after 7 days, allowing the importer's four-day reporting delay. These are
operational policies, not provider availability guarantees. Failed/partial/stale
states block reporting-readiness checks; missing and unknown remain distinct.

BHG remains one client with three named brand/property scopes. Receipts match
client AND property, or client AND exact GBP account/location. Shared GBP data
is displayed once at the parent. Current Google run logs omit brand/property
identity, so multi-property last-success attribution remains unverified even
when all properties have data. A missing brand property stays visible.

## Follow-on slices

- Stamp property/brand identity and preflight failures in provider run logs.
- Extend the same evidence model to weekly rank/backlink imports, social and
  website delivery, CRM Lite receipts, and live billing reconciliation.
- Complete scope-aware onboarding for services, claims, keyword intent, Authority
  readiness, publishing destinations and portal launch. Recorded scope is not
  authorization to enable, invite, bill, approve or publish.
- Add incident ownership/acknowledgements through a reviewed database boundary.

## Validation

`tests/integration-health.test.mjs` covers empty/completed results, partial runs,
recovery, unchanged receipts, freshness thresholds, incomplete reads, malformed
and future evidence, client/property isolation and three-brand coverage.
`tests/operations-control-center-v2.test.mjs` covers alert/readiness propagation.
`tests/operations-control-center-ui.mjs` runs the real Next.js page with a
read-only synthetic API, checks filters, alert links, missing/failed/truncated
sources, onboarding and mobile layout. CI runs it alongside the full application,
native database/RLS, billing, blog review and client growth browser gates.
