# Keyword results report (pilot)

`/clients/[clientId]/growth/report`, team only, linked from the Growth tab.
Lucas Construction is the pilot. One page answers: which tracked keywords
the website ranks for now compared with the first check, what Maps, Search
Console, Analytics and Business Profile recorded, which inquiries arrived and
what work was published. Each number carries its source and date.

**Reads only.** `src/lib/keyword-report-data.ts` reads stored rows scoped to
the client. Rank rows are reached through the client's own keyword ids.
Inquiry contact fields are never selected. Every read goes through
`readAll`: an exact count comes back with the first page, and pages are
fetched until the rows match it. A server row cap, a short read or a table
over the limit is an error, never a silent truncation. Embeds name their
foreign key (`services!keywords_service_id_fkey`,
`inquiry_sources!inquiries_source_id_client_id_fkey`), because `keywords`
and `services` are linked twice and an unnamed embed fails with PGRST201.
A failed read is logged on the server with its PostgREST code, and the page
shows only the code. Opening the page calls no
provider and starts no scan. The calculations live in
`src/lib/keyword-report.ts` and are pure functions with unit tests.

## Rules the page enforces

- **Organic rank is the website only.** A result counts as the site's rank
  only when its host is the site's host (`sites.url`, else
  `clients.website_url`). A directory, social or review page that carries the
  business name is labelled *third-party page matched* and is excluded from
  every count and comparison, because the website's own position for that
  check is unknown.
- **Not found is not a number.** `position = null` means the site was not in
  the top 100. It is shown as such and never becomes 100 or 0.
- **One source identity per series.** `resolveScope` resolves one website
  host (the client record and every `sites` row must agree), one Search
  Console property, one Analytics property and host, and one verified
  Business Profile account and location. Each series is filtered to that
  identity before months are chosen. Several hosts, several locations or
  brand workspaces mean the source is *unavailable*; the report never falls
  back to some other source. Multi-brand clients are outside the pilot.
- **Baseline.** The first complete *scheduled* rank run is the baseline.
  Manual runs before it are shown but not used, because request settings
  (engine, device, coordinates) are not stored per run. The page says
  comparability is inferred from the location record and the tracker's
  current settings. Each keyword's baseline is its result in that run, or
  its first later check (flagged *added after baseline*). It is not a
  pre-engagement baseline. The summary uses a stable comparison group:
  keywords verified in both the baseline and the latest complete run.
  Exclusions are counted and shown, never silently dropped from the
  denominator.
- **Source health.** `trackerHealth` uses the latest attempt. A failure or
  partial run newer than the last success shows as failed or partial, and
  the last success is kept beside it. Running, missing, stale and not set up
  are separate states. Map scans use the same 14-day staleness as ranks.
  Schedules show the configured cron and the next configured slot. They are
  not presented as confirmed runs. A disabled map profile is labelled as
  disabled.
- **Separate measures.** Website rank (DataForSEO organic), the local pack in
  normal results, the Maps grid and Search Console are separate measures and
  are never combined. Average position from Search Console is not shown as a
  rank.
- **Maps.** Two scans are compared only when the business (place id),
  search mode, zoom, geometry, points and keywords are all recorded and
  identical (`scanComparability`). A setting that is unknown on either scan
  is never treated as equal. Comparable scans show prior values and deltas;
  otherwise the page lists every reason they are not compared.
- **Traffic.** Search Console and Business Profile use complete months only.
  Analytics labels each month to date as partial and compares only months the
  provider marked `complete_month`. Analytics sessions are all channels,
  because the import has no channel split yet.
- **Inquiries.** Counted by Central-time month, page and form. They are not
  attributed to keywords, organic search or revenue.
- **Work.** Only published items are listed. Drafts are counted separately.
- **Freshness.** Uses the existing policies unchanged: ranks are stale after
  14 days, and `SOURCE_POLICY` in `integration-health.ts` covers GSC, GA4
  and GBP.

## rank-sync matching fix

Before this change, `rank-sync` collect used one matcher, site host **or**
business name, for both organic and map-pack results. A Facebook, MapQuest
or directory page titled with the business name was stored as the website's
organic rank. One such match was for another company with the same name in
another state. Organic now matches on host only; the map pack still accepts
the name. Past rows are not rewritten. The report classifies them on read.
The fix takes effect only once the function is deployed.

## Tests

- `tests/keyword-report.test.mjs`: calculations, with labelled fixtures.
- `tests/rank-collection.test.mjs`: rank-sync collect against fixture SERPs.
  These tests fail on the previous matcher.
- `tests/keyword-report-ui.mjs`: browser check against a stub PostgREST with
  fictional data. It asserts GET-only reads with no unexpected endpoint
  (so no provider calls), client-scoped queries and no contact fields.
  `KEYWORD_REPORT_DATA=<export.json>` renders a read-only export instead. Use
  it for review screenshots and never commit them, because this repository is
  public.

## Older ranking and search surfaces (review 2)

Migration `20261020230000_organic_rank_website_only.sql` applies the same
rule everywhere else that shows ranks.

- `public.url_host(text)` and `public.organic_rank_state(source, position,
  url, hosts)` are pure, immutable and invoker functions. `url_host`
  lower-cases before removing `www.`, so `https://WWW.Site.Test` is
  `site.test`, the same as the TypeScript mirror. Execute is granted
  to `authenticated` and `service_role`, never to `anon`.
  `src/lib/organic-rank.ts` mirrors them, and `tests/organic-rank.test.mjs`
  pins both to one truth table. A client's hosts are its record, its `sites`
  rows and its brand websites. A row on any other client's website is
  `third_party`.
- `client_growth_rankings`, `portal_growth_rankings` and `portal_rankings`
  keep their columns, security options and grants. They gain
  `first_state` / `state` / `previous_state` (`website`, `third_party`,
  `unverified`, `not_found`, `listed`). An organic position is returned only
  for `website`, so even an un-updated reader cannot count a third-party
  page. Host sets are computed inline in each view: a function would run as
  the portal user, who cannot read `clients` or `sites`.
- `compute_location_index` (City Index) takes the latest in-period organic
  row per P1 keyword first, including a check that found nothing. It then
  leaves the keyword out unless that row is the client's website, so an older
  website rank is never substituted for a newer *not found* or third-party
  result. The map pack keeps its existing rule. Stored `location_index` rows
  are not rewritten; the next `rank-sync` run recomputes the current period.
- The team Keywords page reads `url_ranked` and `source`. It shows **3P**
  for an excluded latest result and keeps it out of best-rank and the City
  Index.
- The Growth page shows an excluded count, an "excluded" ranking bucket and
  "Not comparable: not the website".
- Search Console: the property totals on portal search render whether or
  not a query sample exists; the sample has its own empty state.
- Search Console: the portal home and portal search headlines read the
  verified property import (`portal_growth_measurements`, source "Google
  Search Console property totals") through `propertySearchTotals`. Several
  property scopes show as unavailable instead of being added together.
  Query-row sums, including the unweighted average position headline, are
  removed or labelled *sample*. This applies to Growth's "Search Console
  query sample" too.
- Rollback: `supabase/rollback/20261020230000_organic_rank_website_only.down.sql`
  is tested by `organic_website_only_rollback.test.sql`. It restores the
  previous views, grants and City Index function, drops the helpers and
  touches no data.

### Release order (after review)

1. Merge PR #187 into main.
2. Apply the migration to `iokcopiyzajigvhwexhe` (Supabase MCP
   `apply_migration`). Then commit the recorded version, following the
   repo's existing "Record the applied migration version" convention.
3. Deploy `rank-sync` through the *Deploy Supabase Edge Function* workflow,
   with `expected_sha` set to the resulting main SHA and `confirm` set to
   `DEPLOY`. Read the deployed source back and confirm it contains
   `organic: onSite`.
4. Optionally recompute the current City Index period:
   `select recompute_location_indexes(null, date_trunc('month', now())::date)`.
   This is a derived cache, and the Oct 26 run recomputes it anyway.
5. Live check after the Monday 06:00 UTC run: new DataForSEO organic rows
   carry only client hosts, Growth and portal states match the report page,
   and no paid scans are added.

The app deploy can come before or after step 2. Readers treat a missing
`state` as the old behaviour and do not fail.
