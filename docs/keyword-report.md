# Keyword results report (pilot)

`/clients/[clientId]/growth/report`, team only, linked from the Growth tab.
Lucas Construction is the pilot. One page answers: which tracked keywords
the website ranks for now compared with the first check, what Maps, Search
Console, Analytics and Business Profile recorded, which inquiries arrived and
what work was published. Each number carries its source and date.

**Reads only.** `src/lib/keyword-report-data.ts` reads stored rows scoped to
the client. Rank rows are reached through the client's own keyword ids.
Inquiry contact fields are never selected. Opening the page calls no
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
- **Baseline.** Each keyword's first check from the same location is its
  baseline, labelled *first observed*. It is not a pre-engagement baseline.
  The summary uses a stable comparison group: keywords verified in both the
  first and the latest complete run. Exclusions are counted and shown, never
  silently dropped from the denominator.
- **Separate measures.** Website rank (DataForSEO organic), the local pack in
  normal results, the Maps grid and Search Console are separate measures and
  are never combined. Average position from Search Console is not shown as a
  rank.
- **Maps.** Two scans are compared only when their frozen geometry and
  keywords are identical. A different grid is a different baseline.
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
