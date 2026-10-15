# Compass map grid pilot

Replaces the Google Maps grid collector and viewer for explicitly enrolled locations. Existing BrightLocal imports, original snapshots, organic rank tracking, GBP publishing, citations and subscriptions are unchanged.

## Model and collection

- `map_grid_profiles`: team-readable configuration; service-only writes. Exact saved coordinates and keyword IDs, a reviewed Google Place ID, explicit scan zoom, and separate manual/weekly switches. Default disabled.
- `map_grid_runs`: frozen configuration, idempotency key, completion and worker lease. One active run per profile; at most one new run per hour. At most 1,000 checks/run, 225 points and 10 keywords.
- `map_grid_checks`: one keyword/point pair, provider task ID and cost, status, rank, result list, timestamp. Exact Google Place ID matching only. No name/host fallback can silently match a competitor.
- `map-grid-sync`: team JWT or existing cron-secret authentication. Reuses `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` from Vault, without returning them. Modes `status`, `discover` (read-only paid identity lookup), `start`, `collect`, `weekly` (cron only).
- Standard Maps task queue: depth 100, desktop, English, priority 1, coordinates and zoom fixed in run configuration, search_this_area=true, search_places=false. Keywords encode literal percent and plus signs.
- Search mode is now explicit on profiles and frozen into each run. `search_this_area=true` retains the initial pilot behavior; `false` allows the query's named market to influence results beyond the displayed viewport. Old run JSON without this field retains `true`. Never compare these modes as a ranking change. A production diagnostic at the same point/query returned Lucas at #4 with false and not found with true, so city-qualified BrightLocal replacement requires mode review before enrollment.
- A scan snapshots the profile before spending. Task tags bind provider responses to exact checks. Unknown POST outcomes are never automatically reposted. Results are retried without creating paid tasks. Collection is bounded to 60 checks per invocation; the five-minute collector continues work. Six-hour expiry is explicit failure, not a rank loss.
- Collector runs only one scan at a time in this pilot. Broader enrollment requires capacity review. Weekly scheduler is Thursday 14:00 UTC, and selects enabled profiles with weekly_enabled=true.

## Dense 1/2/5-mile layout (Oct 15 2026)

Tom asked for neighborhood detail rather than a 25-mile picture. Zooming a sparse scan cannot add measurements, so the layout itself is denser. Radius always means distance from the business center, never diameter.

- **Geometry** (`localGrid` in `supabase/functions/_shared/map-grid.ts`, version `local-multiscale-v1`): one nested, deduplicated set around the verified home location. 0.25-mile lattice inside 1 mile, 0.5-mile lattice from 1 to 2 miles, 1-mile lattice from 2 to 5 miles. Ring membership uses integer lattice arithmetic; coordinates are great-circle destinations rounded to 7 decimals, so boundary points sit within 0.00001 mile of their ring. At Lucas's center: **153 unique points — 49 within 1 mi, 85 within 2 mi, 153 within 5 mi**. Five keywords = 765 checks, est. $0.459 at $0.0006/check. Six keywords is the most the 1,000-check cap allows (918); seven is refused by `validateGrid` and the table constraint.
- **One scan, every radius.** There are no separate 1/2/5-mile scans; the center is charged once. The viewer filters the frozen checks by distance from `geometry.center` (tolerance 0.001 mi). Switching radius, rings, zoom or keyword is client-side and never calls `map-grid-sync`.
- **Storage.** `map_grid_profiles.geometry` (migration `20261015040000`) holds version, center, tiers, radii, default radius and `point_count`; a check constraint requires `point_count` to equal the points array. `map_grid_start` already freezes `to_jsonb(profile)`, so new runs carry geometry; old run JSON is never rewritten. `validateGrid` refuses a run whose geometry does not describe its points, before any task is posted. Still one profile per grid config (`grid_config_id` is unique).
- **Applying it to a profile** is a deliberate, separate step: `node --no-warnings scripts/map-grid-local-geometry.mjs <profile_id> <lat> <lng> [keywords]` prints the counts and the SQL. The SQL changes only `points` and `geometry`, requires the center to equal the grid config's recorded center, and refuses while a run is running. Keywords, Place ID, zoom, search mode and both enable switches are untouched. The broad 41 points stay in the first run's frozen config.
- **Viewer.** 1 mi / 2 mi / 5 mi / Full scan controls (point counts shown), business center halo, optional distance rings, per-radius sampled-point count and metrics. Fits bounds only on a deliberate radius change; refreshes, polling, resizes and keyword switches keep the user's zoom and pan. Max zoom 18. Marker size follows each point's spacing at the current zoom; numbers appear once a marker is large enough to read. Runs without geometry open at full extent with a note stating their spacing and how few points fall inside the chosen radius — a broad scan and a dense scan are different baselines, not a ranking change. **Run scan** opens a confirmation stating the next scan's points per radius, keywords, checks, cost and search mode.

## Viewer

Team-only client **Map rankings** tab. Keyword selector, 30-scan history, interactive Leaflet/OSM map, point competitor details, CSV download (with distance from the business, for the radius shown), recorded API cost. Original BrightLocal baseline has its actual source date. No cross-provider movement score is calculated.

Top 3 coverage divides by completed checks, including not-found checks. Average rank includes found points only and says so. Gray means pending/unavailable, never a ranking loss. Not found is labeled 100+ and can include cases where Google returned fewer than 100 listings. Provider errors and empty/malformed result envelopes are not treated as rank losses.

OSM standard tiles are fetched normally by the browser only for the current viewport, retain standard caching/referrer, and display attribution. No tile scraping, prefetch or offline download. Review a commercial tile provider before client-facing rollout or substantial traffic.

## Release and verification

1. Pass parser/worker tests, full migration replay and database permission tests, lint, TypeScript, build and browser acceptance. Native PostgreSQL CI is the full migration/role gate; PGlite replay is supplemental.
2. Apply the additive migration and deploy map-grid-sync. No profiles are created by the migration; scheduler has no eligible targets.
3. Use discover for the one pilot client. Review returned Place ID against business website, phone and title. Seed a profile from existing BrightLocal snapshot coordinates and the existing five keyword IDs. Never infer a square grid from grid_size: Lucas's imported config says 15 while the actual customized grid has 41 points.
4. Enable only the reviewed profile, run one manual scan, verify count, cost, identity and source date in production.
5. Turn on that profile's weekly switch only after the manual run passes. Keep BrightLocal for overlap. Compare contemporaneous scans before any subscription change.

Rollback: disable enabled/weekly_enabled on the pilot profile. Let queued paid tasks finish collecting. Revert UI code if necessary; retained tables and history are additive. Never delete prior source records.
