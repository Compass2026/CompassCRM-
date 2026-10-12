# Reporting connections

The Progress dashboard shares one template for every client. Source scopes keep properties, websites, time zones and partial reporting windows separate. Brand analytics bindings are optional `ga4_property` / `gsc_property` fields on `client_brand_workspaces`; the shared Business Profile remains client-scoped.

## Account discovery

`reporting-connections` is a read-only admin/cron endpoint. It inventories accessible Analytics properties and exact web streams, plus Search Console properties. It returns only safe account metadata, never credentials or raw upstream errors. Inventory must succeed before concluding a property is absent. A connected property does not prove the website tag is installed.

## Brand reporting

`ga4-performance` and `gsc-performance` accept `{client_id, brand_workspace_id?, months?:1..6}`. Both verify that the brand belongs to the client. GA4 verifies the exact website stream and filters the hostname. GSC verifies the exact property and reads finalized full-property totals. The service-only record RPC rechecks the current binding with row locks before appending evidence.

Daily brand imports run at 09:45 UTC for Search Console and 10:15 UTC for GA4. A brand using the parent's property is skipped to avoid duplicate imports. Existing client imports retain their schedules. Portal measurement views keep their client-only boundary and remove private evidence.

## Backlinks

`backlink-performance` accepts `{client_id}` from an admin or the cron secret. It deduplicates client and brand hosts and imports DataForSEO's live external summary plus the last two complete months of new/lost counts. Summary includes subdomains and indirect links, excludes internal links, and counts live links. History includes subdomains and uses the provider's monthly discoveries/losses. Both continue the existing `DataForSEO (unreviewed index)` series.

The weekly cron runs Tuesday at 11:00 UTC. Each client/host can claim one run per UTC calendar week. This prevents duplicate charges from repeated invocation. A partial or interrupted run is retained for review and is not automatically recharged in the same week. New measured observations are appended, unchanged observations are skipped, and no baseline is overwritten. Missing or malformed results never become zero. Failed imports do not represent verified placements or outreach.

Inspect `backlink_profile_sync_runs` for completion, per-source errors and provider cost receipts. A run is active for at most 30 minutes for record writes. No link purchases, outreach sends, disavow files, or campaign stage changes are part of this importer.

## Remaining setup

An analytics property and its web stream can be prepared before website access is available. Its measurement ID still needs to be installed on the correct production website and checked for collection. Newly created properties cannot supply historical traffic. Shewmaker requires a confirmed production domain. Zernio discovery currently exposes only Lucas through the configured read key; additional clients need accessible GBP accounts before they can be bound.
