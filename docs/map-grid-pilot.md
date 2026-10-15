# Compass map grid pilot

Replaces the Google Maps grid collector and viewer for explicitly enrolled locations. Existing BrightLocal imports, original snapshots, organic rank tracking, GBP publishing, citations and subscriptions are unchanged.

## Model and collection

- `map_grid_profiles`: team-readable configuration; service-only writes. Exact saved coordinates and keyword IDs, a reviewed Google Place ID, explicit scan zoom, and separate manual/weekly switches. Default disabled.
- `map_grid_runs`: frozen configuration, idempotency key, completion and worker lease. One active run per profile; at most one new run per hour. At most 1,000 checks/run, 225 points and 10 keywords.
- `map_grid_checks`: one keyword/point pair, provider task ID and cost, status, rank, result list, timestamp. Exact Google Place ID matching only. No name/host fallback can silently match a competitor.
- `map-grid-sync`: team JWT or existing cron-secret authentication. Reuses `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD` from Vault, without returning them. Modes `status`, `discover` (read-only paid identity lookup), `start`, `collect`, `weekly` (cron only).
- Standard Maps task queue: depth 100, desktop, English, priority 1, coordinates and zoom fixed in run configuration, search_this_area=true, search_places=false. Keywords encode literal percent and plus signs.
- Search mode is now explicit on profiles and frozen into each run. `search_this_area=true` retains the initial pilot behavior; `false` allows the query's named market to influence results beyond the displayed viewport. Old run JSON without this field retains `true`. Never compare these modes as a ranking change. A production diagnostic at the same point/query returned Lucas at #4 with false and not found with true, so city-qualified BrightLocal replacement requires mode review before enrollment.
- A scan snapshots the profile before spending. Task tags bind provider responses to exact checks. Unknown POST outcomes are never automatically reposted. Results are retried without creating paid tasks. Six-hour expiry is explicit failure, not a rank loss.
- The collector works every running scan at once (see **Multi-client capacity** below). Weekly scheduler is Thursday 14:00 UTC, and selects enabled profiles with weekly_enabled=true. Each weekly start outcome is recorded (see **Weekly scan alerts**).

## Dense 1/2/5-mile layout (Oct 15 2026)

Tom asked for neighborhood detail rather than a 25-mile picture. Zooming a sparse scan cannot add measurements, so the layout itself is denser. Radius always means distance from the business center, never diameter.

- **Geometry** (`localGrid` in `supabase/functions/_shared/map-grid.ts`, version `local-multiscale-v1`): one nested, deduplicated set around the verified home location. 0.25-mile lattice inside 1 mile, 0.5-mile lattice from 1 to 2 miles, 1-mile lattice from 2 to 5 miles. Ring membership uses integer lattice arithmetic; coordinates are great-circle destinations rounded to 7 decimals, so boundary points sit within 0.00001 mile of their ring. At Lucas's center: **153 unique points — 49 within 1 mi, 85 within 2 mi, 153 within 5 mi**. Five keywords = 765 checks, est. $0.459 at $0.0006/check. Six keywords is the most the 1,000-check cap allows (918); seven is refused by `validateGrid` and the table constraint.
- **One scan, every radius.** There are no separate 1/2/5-mile scans; the center is charged once. The viewer filters the frozen checks by distance from `geometry.center` (tolerance 0.001 mi). Switching radius, rings, zoom or keyword is client-side and never calls `map-grid-sync`.
- **Storage.** `map_grid_profiles.geometry` (migration `20261015040000`) holds version, center, tiers, radii, default radius and `point_count`; the check constraint calls `map_grid_geometry_valid()`, which answers strictly true or false (a CHECK accepts NULL) and requires every key: version, finite center, 1–5 tiers with positive, increasing `max_miles` and positive `spacing_miles` ≤ max, `radii_miles` equal to the tier maxima, `default_radius_miles` among them, and `point_count` equal to the points array. SQL NULL stays valid for legacy profiles. `geometryProblem()` applies the same rules at runtime. `map_grid_start` already freezes `to_jsonb(profile)`, so new runs carry geometry; old run JSON is never rewritten. `validateGrid` refuses a run whose geometry does not describe its points, before any task is posted. Still one profile per grid config (`grid_config_id` is unique).
- **Applying it to a profile** is a deliberate, separate step: `node --no-warnings scripts/map-grid-local-geometry.mjs <profile_id> <lat> <lng> [keywords]` prints the counts and the SQL. The SQL changes only `points` and `geometry`, requires the center to equal the grid config's recorded center, and refuses while a run is running. Keywords, Place ID, zoom, search mode and both enable switches are untouched. The broad 41 points stay in the first run's frozen config.
- **Viewer.** 1 mi / 2 mi / 5 mi / Full scan controls (point counts shown), business center halo, optional distance rings, per-radius sampled-point count and metrics. Geometry, point counts, spacing, header and coverage note always describe the dataset on screen: the BrightLocal baseline uses its own points, never the scan's dense metadata, and a deliberate source switch resets to that dataset's default radius and refits to its extent. Fits bounds only on a deliberate radius or source change; refreshes, polling, resizes and keyword switches keep the user's zoom and pan. Max zoom 18. Marker size follows each point's spacing at the current zoom; numbers appear once a marker is large enough to read. Runs without geometry open at full extent with a note stating their spacing and how few points fall inside the chosen radius — a broad scan and a dense scan are different baselines, not a ranking change. **Run scan** opens a confirmation stating the next scan's points per radius, keywords, checks, cost and search mode.

## Multi-client capacity (Oct 15 2026)

Every weekly profile is due at the same Thursday 14:00 UTC slot. The pilot collector worked only the oldest running scan per invocation. With about seven 765-check profiles, the later runs would have been posted and collected too late. Their paid tasks would then have been failed at the six-hour expiry. `map-grid-sync` (version `map-grid-v4`) now works every running run in each `collect` / `weekly` invocation:

1. **Lease.** Up to 20 running runs (`MAX_RUNS`, oldest first) are each leased separately for ten minutes. A run that another collector holds is skipped (`busy`) without blocking the rest. Overlapping five-minute ticks therefore split runs and never share one.
2. **Post.** For each leased run, oldest first, every `planned` check is posted in 100-task batches (`POST_BATCH`). Any interrupted `posting` check is first marked `unknown`. Interrupted posts are still never reposted.
3. **Collect.** The invocation takes up to 60 of each run's oldest-polled `queued` checks (`COLLECT_PER_RUN`) and interleaves them round-robin across runs. It then reads at most 360 results (`COLLECT_TOTAL`), six at a time. A large or slow run cannot starve the others. Result reads never create a paid task.
4. **Settle and release.** Each run is completed, made partial or expired on its own. Every lease is released.

- **Deadline.** No new POST batch or result read starts more than 100 s (`WORK_MS`) into an invocation. In-flight calls have a 20 s timeout, so an invocation stays inside the Edge wall clock. A batch that is not posted stays `planned`: it has cost nothing and posts on the next tick. It is never marked `unknown`.
- **Isolation.** An error in one run, such as invalid geometry, a database write failure or an ambiguous POST, is recorded on that run's `error`. That run is skipped for the rest of the invocation, and the other runs continue. A run that keeps erroring still expires at six hours: it becomes `failed` and keeps its error text. Before this change it stayed `running` indefinitely and blocked the profile's next start. `start` with `wait: true` still returns 503 for its own run's error.
- **Unchanged.** Idempotent `request_key`, task-tag binding, unknown POSTs never reposted, no new paid task on retry, six-hour expiry, and the 225-point, 1,000-check and 10-keyword limits.
- **Throughput.** Seven 765-check runs (5,355 checks, 56 POST batches) take 15 collector ticks, about 1.25 h, when each result is ready on its first read. If every check needs three reads, they take 45 ticks, about 3.75 h. Both cases are in `tests/map-grid-capacity.test.mjs`. In practice posting usually spans the first one to three ticks: each batch also writes its 100 check rows. Six hours is 72 ticks × 360 reads = 25,920 reads. That is room for about 20 runs (the `MAX_RUNS` cap) at one read per check, or about 11 runs at three reads per check. Before going past roughly ten weekly profiles at one slot, stagger the slots or move collection to DataForSEO's `tasks_ready` endpoint.

## Weekly scan alerts (Oct 15 2026)

Previously the weekly scheduler swallowed start errors, and nothing noticed a missed week. Now:

- **`map_grid_weekly_attempts`** (migration `20261015180000`) gets one row per weekly-enabled profile per weekly invocation: `outcome` is `started` (with `run_id`), `already_running`, `cooldown`, `disabled` or `error`. `message` holds the database or validation error text, up to 500 characters. RLS is team read via `(select is_team())`, with no `authenticated` or `anon` writes. Only the service-role Edge runtime inserts. A failed insert is logged and never stops the other profiles' starts.
- **The rule** (`weeklyScanStatus` in `src/lib/map-grid-weekly.ts`, shared by both screens): a weekly-enabled profile needs a **complete** scan, weekly or manual, started in the expected ISO week (UTC, Monday start). Before Thursday 14:00 UTC the expected week is the previous one. From the slot onward it is the current week.
  - **Complete** (green): a complete scan exists for that week.
  - **Due** (gray): it is the current week, less than 1 h after the slot, and no attempt has been recorded yet.
  - **In progress** (blue): a scan is running, less than 7 h after the slot (six-hour expiry plus one hour of grace).
  - **Missed, critical** (red): a weekly start `error` was recorded, or no start attempt was recorded more than 1 h after the slot, which points to the cron job or the function. Check `cron.job_run_details` for `map-grid-weekly` and the `map-grid-sync` function logs.
  - **Missed, attention** (amber): after the 7 h window the week's scan ended `partial` or `failed`, or the start was skipped (`cooldown`, `already_running`, `disabled`). The reason is shown. Partial scans and missing checks are not ranking losses.
- **Where it shows:**
  - The client **Map rankings** tab has a banner above the map with the week's state, the last complete scan and the recent weekly start attempts. It is hidden for profiles that are not weekly.
  - **Control Center → Source freshness** has a *Map grid weekly scans* table.
  - **Action queue** gets one linked alert for each missed profile.
  - A failed read shows as a source error. It never shows as healthy.
- **Clearing an alert:** fix the cause, then run a manual scan. A complete manual scan in the expected week clears it. A profile switched to weekly after Thursday's slot shows as missed until its first Thursday scan, or until a manual scan clears it.

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

6. Multi-client rollout: apply `20261015180000_map_grid_weekly_attempts.sql` and redeploy `map-grid-sync`. `status` mode returns `map-grid-v4`. Then enroll the next profiles one at a time, each with its own manual run, before turning on weekly. The first Thursday with several profiles, confirm in the Control Center that every weekly profile reads *Complete* for its week.

Rollback: disable enabled/weekly_enabled on the pilot profile. Let queued paid tasks finish collecting. Revert UI code if necessary; retained tables and history are additive. Never delete prior source records.
