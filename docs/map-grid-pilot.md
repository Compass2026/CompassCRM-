# Compass map grid pilot

Replaces the Google Maps grid collector and viewer for explicitly enrolled locations. Existing BrightLocal imports, original snapshots, organic rank tracking, GBP publishing, citations and subscriptions are unchanged.

## Model and collection

- `map_grid_profiles`: team-readable configuration; service-only writes. Exact saved coordinates and keyword IDs, a reviewed Google Place ID, explicit scan zoom, and separate manual/weekly switches. Default disabled.
- `map_grid_runs`: frozen configuration, idempotency key, completion and worker lease. One active run per profile; at most one new run per hour. At most 1,000 checks/run, 225 points and 10 keywords.
- `map_grid_checks`: one keyword/point pair, provider task ID and cost, status, rank, result list, timestamp. Exact Google Place ID matching only. No name/host fallback can silently match a competitor.
- `map-grid-sync`: team JWT or existing cron-secret authentication. Reuses `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` from Vault, without returning them. Modes `status`, `discover` (read-only paid identity lookup), `start`, `collect`, `weekly` (cron only).
- Standard Maps task queue: depth 100, desktop, English, priority 1, coordinates and zoom fixed in run configuration, search_this_area=true, search_places=false. Keywords encode literal percent and plus signs.
- A scan snapshots the profile before spending. Task tags bind provider responses to exact checks. Unknown POST outcomes are never automatically reposted. Results are retried without creating paid tasks. Collection is bounded to 60 checks per invocation; the five-minute collector continues work. Six-hour expiry is explicit failure, not a rank loss.
- Collector runs only one scan at a time in this pilot. Broader enrollment requires capacity review. Weekly scheduler is Thursday 14:00 UTC, and selects enabled profiles with weekly_enabled=true.

## Viewer

Team-only client **Map rankings** tab. Keyword selector, 30-scan history, interactive Leaflet/OSM map, point competitor details, CSV download, recorded API cost. Original BrightLocal baseline has its actual source date. No cross-provider movement score is calculated.

Top 3 coverage divides by completed checks, including not-found checks. Average rank includes found points only and says so. Gray means pending/unavailable, never a ranking loss. Not found is labeled 100+ and can include cases where Google returned fewer than 100 listings. Provider errors and empty/malformed result envelopes are not treated as rank losses.

OSM standard tiles are fetched normally by the browser only for the current viewport, retain standard caching/referrer, and display attribution. No tile scraping, prefetch or offline download. Review a commercial tile provider before client-facing rollout or substantial traffic.

## Release and verification

1. Pass parser/worker tests, full migration replay and database permission tests, lint, TypeScript, build and browser acceptance. Native PostgreSQL CI is the full migration/role gate; PGlite replay is supplemental.
2. Apply the additive migration and deploy map-grid-sync. No profiles are created by the migration; scheduler has no eligible targets.
3. Use discover for the one pilot client. Review returned Place ID against business website, phone and title. Seed a profile from existing BrightLocal snapshot coordinates and the existing five keyword IDs. Never infer a square grid from grid_size: Lucas's imported config says 15 while the actual customized grid has 41 points.
4. Enable only the reviewed profile, run one manual scan, verify count, cost, identity and source date in production.
5. Turn on that profile's weekly switch only after the manual run passes. Keep BrightLocal for overlap. Compare contemporaneous scans before any subscription change.

Rollback: disable enabled/weekly_enabled on the pilot profile. Let queued paid tasks finish collecting. Revert UI code if necessary; retained tables and history are additive. Never delete prior source records.
