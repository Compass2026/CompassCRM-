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
- `weekly` and `collect` dispatch every running scan to its own invocation (see **Multi-client capacity** below). Weekly scheduler is Thursday 14:00 UTC, and selects enabled profiles with weekly_enabled=true. Each weekly start outcome is recorded (see **Weekly scan alerts**).

## Dense 1/2/5-mile layout (Oct 15 2026)

Tom asked for neighborhood detail rather than a 25-mile picture. Zooming a sparse scan cannot add measurements, so the layout itself is denser. Radius always means distance from the business center, never diameter.

- **Geometry** (`localGrid` in `supabase/functions/_shared/map-grid.ts`, version `local-multiscale-v1`): one nested, deduplicated set around the verified home location. 0.25-mile lattice inside 1 mile, 0.5-mile lattice from 1 to 2 miles, 1-mile lattice from 2 to 5 miles. Ring membership uses integer lattice arithmetic; coordinates are great-circle destinations rounded to 7 decimals, so boundary points sit within 0.00001 mile of their ring. At Lucas's center: **153 unique points — 49 within 1 mi, 85 within 2 mi, 153 within 5 mi**. Five keywords = 765 checks, est. $0.459 at $0.0006/check. Six keywords is the most the 1,000-check cap allows (918); seven is refused by `validateGrid` and the table constraint.
- **One scan, every radius.** There are no separate 1/2/5-mile scans; the center is charged once. The viewer filters the frozen checks by distance from `geometry.center` (tolerance 0.001 mi). Switching radius, rings, zoom or keyword is client-side and never calls `map-grid-sync`.
- **Storage.** `map_grid_profiles.geometry` (migration `20261015040000`) holds version, center, tiers, radii, default radius and `point_count`; the check constraint calls `map_grid_geometry_valid()`, which answers strictly true or false (a CHECK accepts NULL) and requires every key: version, finite center, 1–5 tiers with positive, increasing `max_miles` and positive `spacing_miles` ≤ max, `radii_miles` equal to the tier maxima, `default_radius_miles` among them, and `point_count` equal to the points array. SQL NULL stays valid for legacy profiles. `geometryProblem()` applies the same rules at runtime. `map_grid_start` already freezes `to_jsonb(profile)`, so new runs carry geometry; old run JSON is never rewritten. `validateGrid` refuses a run whose geometry does not describe its points, before any task is posted. Still one profile per grid config (`grid_config_id` is unique).
- **Applying it to a profile** is a deliberate, separate step: `node --no-warnings scripts/map-grid-local-geometry.mjs <profile_id> <lat> <lng> [keywords]` prints the counts and the SQL. The SQL changes only `points` and `geometry`, requires the center to equal the grid config's recorded center, and refuses while a run is running. Keywords, Place ID, zoom, search mode and both enable switches are untouched. The broad 41 points stay in the first run's frozen config.
- **Viewer.** 1 mi / 2 mi / 5 mi / Full scan controls (point counts shown), business center halo, optional distance rings, per-radius sampled-point count and metrics. Geometry, point counts, spacing, header and coverage note always describe the dataset on screen: the BrightLocal baseline uses its own points, never the scan's dense metadata, and a deliberate source switch resets to that dataset's default radius and refits to its extent. Fits bounds only on a deliberate radius or source change; refreshes, polling, resizes and keyword switches keep the user's zoom and pan. Max zoom 18. Marker size follows each point's spacing at the current zoom; numbers appear once a marker is large enough to read. Runs without geometry open at full extent with a note stating their spacing and how few points fall inside the chosen radius — a broad scan and a dense scan are different baselines, not a ranking change. **Run scan** opens a confirmation stating the next scan's points per radius, keywords, checks, cost and search mode.

## Market-centered grids and the BrightLocal migration (Oct 15 2026)

- **Market center.** A service-area business with no public address (Logic Solar, Wichita) is sampled around a documented market center, not a guessed business location. `geometry.center_kind` is `business` (absent = business) or `market`, and a market center needs `center_label`, e.g. "Wichita, KS market center" (OpenStreetMap city relation 129814). Both `geometryProblem()` and `map_grid_geometry_valid()` (migration `20261015171000`) enforce it. The viewer then says "Radius from scan center", "of/from the scan center" and labels the halo with the market. Ranks are still matched to the business's own Place ID.
- **Onboarding.** `node --no-warnings scripts/brightlocal-migration-onboarding.mjs > onboarding.sql` prints the preview (stderr) and one guarded, idempotent SQL script for the nine remaining BrightLocal locations. The roster in the script records the evidence for every center and Place ID. The SQL:
  - creates Silverback, MADHAIRLAB and Premier as paused `map_tracking` clients (migration `20261015170000`) with their location and BrightLocal grid keywords, not rank-tracked;
  - records Show Me Design's user-confirmed phone in the CRM only;
  - adds new grid configs where the old center was wrong (Ginger Huff, Show Me Design) or the business has no public address (Logic Wichita), leaving old configs and BrightLocal history untouched;
  - creates nine map-grid profiles, all **disabled with weekly off**.
  Prerequisites: both migrations applied and the multi-profile collector deployed. After that, per location: enable, one manual scan, check, weekly on.
- **Spend at BrightLocal's keyword counts:** 7 × 765 checks plus Silverback 612 and Premier 459, plus Lucas: $4.315/week, about $18.70/month.

## Multi-client capacity (Oct 15 2026)

**Target (Tom, Oct 15):** ten dense weekly profiles, one for each BrightLocal location. Each is 153 points × 5 keywords = 765 checks, so 7,650 checks are all due Thursday 14:00 UTC.

The pilot collector worked only the oldest running scan per invocation. `map-grid-v4` then worked every running run in one `collect` / `weekly` invocation, sized by the 150 s wall clock. That was the wrong limit (see **CPU budget** below). `map-grid-sync` version `map-grid-v5` works **one run per invocation**.

### CPU budget (map-grid-v5)

**Observed in production on 2026-10-15.** Supabase Edge kills an invocation at **2,000 ms CPU**: the log reason is `CPUTime`, and the wall clock does not matter. One v4 `collect` invocation was working 9 running runs. It was killed 77 s in, after about 370 `task_get` parses. That is far short of its 100 s `WORK_MS` deadline. Its `finally` never ran, so 8 run leases stayed held for the full ten-minute `LEASE_MS`.

**Sizing model** (`tests/map-grid-capacity.test.mjs`, `tests/map-grid.test.mjs`). These figures are arithmetic from per-call constants taken from the production logs above, not new Edge CPU measurements. The test fixtures return one result item per read, so a full 100-item provider payload may cost more to parse. Get representative-payload evidence (non-billable: a staging function fed saved `task_get` responses) before relying on the margins below for the nine new weekly profiles.

| Work in one invocation | CPU |
|---|---|
| One result read (fetch, JSON parse, `parseMapsTask`, row write) | ~5.4 ms (2,000 / 370) |
| One 100-task POST and its 100 binding writes | up to ~62.5 ms (a 765-check run costs 350–500 ms) |
| One run's pass: post up to 765 checks + 60 reads (measured 230–520 ms) | ≤ 824 ms modelled |
| Read cap: a full 1,000-check post + 150 reads | ≤ 1,436 ms modelled |
| v4 weekly pass: 10 runs × 8 POSTs + 600 reads | ~8,200 ms: killed mid-post |

A v4 weekly pass would be killed while posting. Checks left in `posting` become `unknown`: they may have been paid for, are never collected, and the runs end `partial`.

**How v5 works:**

1. **`weekly`** (cron only). For each enabled + weekly profile it calls `map_grid_start` (database only: it freezes the run and plans its checks) and records the `map_grid_weekly_attempts` row as before. It then **dispatches**. It posts nothing and parses nothing itself.
2. **`collect`** (cron or team JWT) selects up to 20 (`MAX_RUNS`) `running` runs whose lease is free, oldest first, and dispatches them. `weekly` dispatches its started runs plus the same free-lease set.
3. **Dispatch** sends one self-request per run to `map-grid-sync` with `{mode: "start", profile_id, request_key}`, using the run's own request key. It authenticates with the Vault `SUPABASE_ANON_KEY` bearer and the `x-cron-secret` header, exactly like pg_cron, and sends at most 5 at a time (`DISPATCH_LANES`). `start` finds the run that already owns that key and returns it, as `map_grid_start` would: there is no new run and no spend. The lookup comes before profile validation, so a profile edited mid-run cannot strand its run. `processRuns` still validates the run's **frozen** config before any POST. Each child replies 202 and works its run in the background with its own 2,000 ms CPU budget. A child that is not delivered (`status: "error"` or non-202 in `dispatched`) leaves its run `running`, and the next five-minute tick dispatches it again.
4. **Each child** takes that run's lease, marks any interrupted `posting` checks `unknown`, posts that run's `planned` checks in 100-task batches (sequential within the run), reads up to 60 of its oldest-polled `queued` checks (10 in flight), settles the run and releases the lease.

**Defence in depth:**

- **Read cap.** No invocation parses more than 150 results (`COLLECT_TOTAL`), whatever it is given.
- **Lease.** `LEASE_MS` stays 10 min. 150 s is the request idle timeout, not a limit on background work: a paid-plan worker may live 400 s ([limits](https://supabase.com/docs/guides/functions/limits), [background tasks](https://supabase.com/docs/guides/functions/background-tasks)). The lease must outlast any worker that could still post, so it is not shortened to recover faster. A lease left by a killed worker holds its run for up to two collector ticks; the next `collect` after it lapses resumes the run. The interrupted batch stays `unknown` and is never reposted.
- **Paid-submission fence.** A worker can stall on database I/O, and `WORK_MS` alone is only checked before a batch. So before every `task_post` the worker (1) claims the batch `planned` → `posting` and posts **only the rows that claim returned**, so a row another worker took is never sent; (2) re-reads the clock against `WORK_MS` after the claim; and (3) re-reads the run and requires `lease_until` to still be its own lease. If (2) or (3) fails, nothing has been sent: the claimed rows go back to `planned`, unless a newer worker has already swept them to `unknown`, in which case they stay `unknown`. No POST is therefore issued later than `WORK_MS` (100 s) after the worker started, and each aborts after 20 s, far inside the 10-minute lease. Covered by the delayed-claim / takeover regressions in `tests/map-grid-capacity.test.mjs`.
- **Overlap.** The 14:00 `collect` fires alongside `weekly`. Both dispatch the same runs, and the per-run lease lets exactly one child work each run. The other child is `busy` and does nothing.

**Unchanged:** never blindly re-posting (`unknown` is final), per-run leases, the six-hour expiry (errored runs still expire, become `failed` and keep their error), cron-secret / team-JWT auth (`weekly` is scheduler only), idempotent request keys, task-tag binding, no new paid task on retry, `WORK_MS`, and the 225-point, 1,000-check and 10-keyword limits.

**Throughput** for ten 765-check runs (7,650 checks, 80 POST batches), as measured in `tests/map-grid-capacity.test.mjs`. It matches v4, because each run still gets 60 reads per tick:

| Scenario | Collector ticks | Time from slot |
|---|---|---|
| Results ready on first read (typical: DataForSEO returns in 1–2 min, and the next tick is 5 min later) | 13 | ~1.1 h |
| Pessimistic latency: 5 s per POST including its 100 row writes, 1.5 s per read, every result pending once | 26 (longest invocation 49 s) | ~2.2 h |
| Slow queue: three reads per check | 39 | ~3.25 h |

- **Headroom.** Each run needs ⌈765 × reads-per-check / 60⌉ ticks, independent of how many runs share the slot. Six hours (72 ticks) covers up to about five reads per check. DataForSEO concurrency grows with the fleet: up to 10 reads in flight per run. `MAX_RUNS` (20) caps how many runs one tick dispatches, oldest first. A 21st running run waits until an older one finishes, so beyond about 20 weekly profiles, stagger the weekly slots or switch collection to DataForSEO's `tasks_ready` endpoint rather than extending the expiry.

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
  - **Action queue** gets one linked alert for each missed profile. The alert names the grid and links to `?profile=<id>`.
  - A failed read shows as a source error. It never shows as healthy.
- **Map-tracking-only clients count.** `loadMapGridWeekly` reads every weekly-enabled profile and its client's name directly. It does not use the active/launching health roster. So a paused `map_tracking` client (Silverback, MADHAIRLAB, Premier) still gets its table row and Action-queue alert. It gets no readiness, freshness, billing or onboarding rows. The client filter matches these grids by client name.
- **Clearing an alert:** fix the cause, then run a manual scan. A complete manual scan in the expected week clears it. A profile switched to weekly after Thursday's slot shows as missed until its first Thursday scan, or until a manual scan clears it.

## Viewer

Team-only client **Map rankings** tab. **Several grids per client.** A client can have one grid per location, for example Logic Overland Park and Logic Wichita. A *Location* dropdown appears when there are two or more. The URL carries `?profile=<id>`. History, checks, BrightLocal baseline, weekly notice and **Run scan** are all scoped to that grid. The selection survives reloads and refreshes. A `?run=` link without a profile opens the run's own grid. A grid or run belonging to another client is a 404. Switching location never starts a scan. Keyword selector, 30-scan history, interactive Leaflet/OSM map, point competitor details, CSV download (with distance from the business, for the radius shown), recorded API cost. Original BrightLocal baseline has its actual source date. No cross-provider movement score is calculated.

Top 3 coverage divides by completed checks, including not-found checks. Average rank includes found points only and says so. Gray means pending/unavailable, never a ranking loss. Not found is labeled 100+ and can include cases where Google returned fewer than 100 listings. Provider errors and empty/malformed result envelopes are not treated as rank losses.

OSM standard tiles are fetched normally by the browser only for the current viewport, retain standard caching/referrer, and display attribution. No tile scraping, prefetch or offline download. Review a commercial tile provider before client-facing rollout or substantial traffic.

## Release and verification

1. Pass parser/worker tests, full migration replay and database permission tests, lint, TypeScript, build and browser acceptance. Native PostgreSQL CI is the full migration/role gate; PGlite replay is supplemental.
2. Apply the additive migration and deploy map-grid-sync. No profiles are created by the migration; scheduler has no eligible targets.
3. Use discover for the one pilot client. Review returned Place ID against business website, phone and title. Seed a profile from existing BrightLocal snapshot coordinates and the existing five keyword IDs. Never infer a square grid from grid_size: Lucas's imported config says 15 while the actual customized grid has 41 points.
4. Enable only the reviewed profile, run one manual scan, verify count, cost, identity and source date in production.
5. Turn on that profile's weekly switch only after the manual run passes. Keep BrightLocal for overlap. Compare contemporaneous scans before any subscription change.

6. Multi-client rollout: apply `20261015180000_map_grid_weekly_attempts.sql` and redeploy `map-grid-sync`. `status` mode returns `map-grid-v4`.
7. CPU fix (`map-grid-v5`): redeploy `map-grid-sync`. No migration. The nine new profiles' initial scans **already completed on 2026-10-15** (6,426 / 6,426 checks). Do not enroll them again or run another initial scan.
   - **Deployed version:** `status` mode returns `map-grid-v5`.
   - **Controlled, non-billable worker check:** send `{mode: "start", profile_id, request_key}` with the cron secret, using one completed run's own key (e.g. `initial-<key>-2026-10-15`). Expect `202` with that existing `run_id`; no new `map_grid_runs` row; the run's lease is not taken (it is not `running`); no `task_post` or `task_get` in the Edge logs; no `CPUTime` shutdown. This proves the deployed auth and key-reuse path cannot spend.
   - **Dispatcher check:** a `collect` tick with no running run dispatches nothing, so it does **not** prove child dispatch. Before the slot, only confirm `collect` answers 200 with `dispatched: []`.
   - Then turn weekly on for the nine profiles under the existing authorization. Lucas stays on.
   - **First scheduled live run (separate, still open):** Thursday 14:00 UTC. Check `map_grid_weekly_attempts` (one `started` row per weekly profile), `dispatched` statuses all 202, one child invocation per run in the Edge logs, no `CPUTime` shutdowns, and every leased run released. By about 15:30 UTC, every weekly profile should read *Complete* for its week in the Control Center, with posts = `ceil(checks / 100)` per run and no `unknown` checks. Alert on any `CPUTime` shutdown, any non-202 dispatch, or a run still `running` after three hours.

Rollback: disable enabled/weekly_enabled on the pilot profile. Let queued paid tasks finish collecting. Revert UI code if necessary; retained tables and history are additive. Never delete prior source records.
