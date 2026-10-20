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
