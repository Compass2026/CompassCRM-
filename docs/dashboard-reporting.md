# Dashboard reporting and connection audit

October 12, 2026. Next phase after the interactive Progress dashboard.

## Implemented

`gsc-performance` reads full-property web Search Console totals for complete calendar months. It checks both the exact client website binding and Google property access. No query or page dimensions are sent. This is distinct from the existing query/page snapshot importer, which remains intact for keyword research. Search clicks do not measure website sessions or leads.

One client per invocation, up to six months oldest first. Daily 09:30 UTC cron rechecks three complete months. The four-day reporting delay avoids unfinished source data. The append-only measurement ledger preserves the first available baseline; identical retries are skipped and revised totals are appended. Empty/malformed/error responses are unavailable, never assumed zero. Admin or cron access only; Google requests only read reporting data. Inspect `gsc_performance_sync_runs` for completed/partial results, not only the HTTP 202 acknowledgement.

Progress cards include search clicks and impressions. The existing interactive chart supports metric selection, bars/lines, dates and baseline comparison. Published work comes from Compass-origin published blog records and published social/GBP records. It excludes drafts, approvals and external-origin blogs; social dates use America/Chicago. Month and type filters, dated publications and safe public links are available to both team and client. Website page changes require verified deployment evidence before they count as published work.

Team work view uses invoker RLS. Portal work view follows the existing minimal owner-view boundary, with explicit `portal_client_id()` in both branches, no private post copy, SELECT-only grants and no base-table access. The advisor reports this intentional owner view; native PostgreSQL and browser tests verify client isolation.

## Audited connections

| Client | Search Console property | GBP performance | GA4 property bound |
| --- | --- | --- | --- |
| BHG Safety Partners | sc-domain:bhgsafety.com | Needs exact binding | No |
| Ginger Huff Interiors | sc-domain:gingerhuffinteriors.com | Needs exact binding | No |
| Logic Solar | https://www.logic-solar.com/ | Needs exact binding | No |
| Lucas Construction | https://lucasconstructionmo.com/ | Live via existing Zernio binding | No |
| Pensacola Equipment Rentals | Not available in Google inventory | Needs exact binding | No |
| Resilient Boxing | sc-domain:resilientboxing.com, discovered during audit | Needs exact binding | No |
| Shewmaker Brothers Masonry | No website/property bound | Needs exact binding | No |
| Show Me Design | sc-domain:showmedesignbuild.com | Needs exact binding | No |
| Show Me Electrical | sc-domain:showmeelectrical.com | Needs exact binding | No |

Google returned owner access to the seven listed properties. Resilient's CRM property was initially blank. Pensacola's website currently points to bnbcoastalcuts.com; identity must be resolved before mapping an unrelated property. BHG's extra brand properties are not combined into the safety site's baseline.

## Remaining setup

GA4 account discovery returned 403 SERVICE_DISABLED for Analytics Admin API in Google Cloud project 308261457231. Enable `analyticsadmin.googleapis.com`, verify `analyticsdata.googleapis.com`, then extend the existing Google connection to request `analytics.readonly` and reconnect. Existing `analytics.edit` consent is insufficient for Data API runReport. Inventory and bind exact client properties before importing sessions/conversions; do not infer property ids from websites.

All seven existing inquiry records are explicit system tests, so they are not used as leads. Add a reliable test-record flag and conversion definitions before reporting qualified inquiry totals. Call-button clicks remain clicks, not connected calls.

No measured backlink-profile baseline or acquisition opportunities exist yet. The tracking workflow is deployed, but an empty opportunity list is not a zero backlink profile. Next work: provider/export baseline, relevant opportunity research mapped to client keywords/pages, then dated live-link verification. No paid provider activation, link purchases or outreach is part of this reporting release.

## Release verification

Run `npm test`, TypeScript, lint and build. `scripts/test-portal-sandbox.sh` runs the real PostgreSQL portal and importer boundaries; `tests/client-growth-database.test.mjs` also replays the migration chain in PGlite. Browser acceptance covers interactive filtering, unsafe links, responsive layout and portal routes. Apply the migration before releasing the UI and deploy the Edge Function with JWT verification enabled; include the shared complete-month helper from `gbp-performance/metrics.ts`. Backfill six months per verified client and inspect finished run results and receipts.
