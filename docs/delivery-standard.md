# Delivery standard

## Current standard (Tom, Nov 6 2026; Executive OS task 3ab519f3)

This is the standard in force. Everything below it is the record of how it
came to be; where it disagrees, this section wins.

| Unit | Weekly | Monthly |
| --- | --- | --- |
| Each eligible website (each brand site of a multi-brand client) | 5 Facebook, 5 Business Profile, 3 blogs | 1 webpage refresh |
| BHG's shared Business Profile (three programs, one location) | 7 Business Profile posts **in total**, rotating among Safety, Heavy Equipment and Forklift | — |

- **In scope:** Lucas Construction, Logic Solar, Ginger Huff Interiors,
  MADHAIRLAB, Silverback Plumbing, Pensacola Equipment Rentals, Show Me
  Design, Show Me Electrical, Ready To Go and BHG (three programs).
- **Deferred:** Medic Wisdom, Resilient and Shewmaker Brothers Masonry. Plan
  nothing for them until Tom lifts the deferral.
- **Superseded:** the monthly v1 standard (8 / 8 / 8 a month, below) and the
  open BHG question in the weekly rules ("7 of 15 fit a week ... an open
  decision for Tom"); the 7-a-week rotation answers it. Both are kept as
  history. Adoption stays data: a client works to the weekly standard from
  its `client_weekly_delivery_standards` row (Lucas and Logic from Nov 2
  2026); clients without one still carry v1 slots until Tom gives a start
  date.

### Operating rules

1. **Read the current CRM state before acting.** Brand board, Brand tab,
   core keyword list, claims, bindings and existing slots, posts and drafts.
   Never act from a packet, a task note or memory alone.
2. **Foundation corrections come before drafting.** A draft's brief freezes
   the brand, claims and campaign it was written against, and the blog
   publisher refuses an article whose frozen brief no longer matches
   ("Keyword, brand or campaign foundation changed since review"). Fix the
   board, the Brand tab and the claims first, get the board re-approved,
   then draft or regenerate. After any brand or claim change, check which
   in-review drafts it invalidates before more work.
3. **Preserve existing work.** No duplicate slots, tasks, drafts, assets or
   approval requests; reconcile what exists first. Regenerate in place
   (version history is kept) and keep reviewed copy, heroes and alt text
   wherever they still pass.
4. **Ready for review is not published.** Report each item as *in review*,
   *approved*, *scheduled*, *published (with the live URL and receipt)* or
   *blocked (with the exact reason and owner)*. Only Tom approves content,
   and only his explicit words publish it.
5. **Do not hold healthy channels behind missing integrations.** A client's
   bound, healthy Facebook and Business Profile channels proceed once its
   brand board and core keyword list are approved, even when its blog has
   no website adapter yet.

## History

What Compass delivers per website, kept apart from what the agreement sold
(billing entitlements, 0062). Two versions live side by side in
`delivery_standards`; a client works to one of them by data, never by a
migration.

| Version | Cadence | Per website | Migration |
| --- | --- | --- | --- |
| 1 (**superseded** Nov 6 2026) | monthly (America/Chicago calendar month) | 8 Facebook, 8 Business Profile, 8 blogs, 1 page refresh | `20261015150000_monthly_delivery_standard.sql` |
| 2 | weekly (Monday–Sunday, America/Chicago) | 5 Facebook, 5 Business Profile, 3 blogs a week; 1 page refresh a month | `20261030180000_weekly_delivery_standard.sql` |

The unit is the same in both: each brand site of a multi-brand client
(`client_brand_workspaces`), otherwise the client. Business Profile
locations are destinations, never units.

## Monthly standard (v1, superseded by the current standard above)

`client_delivery_standards` adopts a client from a month on.
`plan_delivery_month()` opens the month's missing slots
(`content_plan_items.standard_key / standard_month / standard_seq`),
`delivery_targets()` reports target / completed / planned per site and month,
and `blog_publication_has_room()` keeps blog releases inside the month's
target. Cron `delivery-standard-month` (1st, 11:00 UTC) plans each new month;
the Wednesday beat (`weekly-blog-posts`) queues the week's slots.

## Weekly standard (v2, Tom; Executive OS decision `0b407d66-de7d-4086-b6de-013f793bcbd4`)

Not 20 / 20 / 12 a month: a weekly cadence. A month with five Mondays gets
five weeks of work.

### Rules

- **Week.** Monday–Sunday in America/Chicago. An item counts in the week of
  its own date: a published post or article on its publication date,
  otherwise the date of the slot it fills, otherwise its own scheduled / due
  / created date. Timestamps are converted to Chicago dates first, so the DST
  weeks (Nov 1 2026, Mar 14 2027) split at local midnight.
- **Start.** `client_weekly_delivery_standards (client_id, standard_id,
  start_date, source_ref)`. `start_date` is the date Tom gives; the guard sets
  `effective_week` to the first Monday on or after it and refuses a date in
  the past. A weekly adoption needs the client's monthly adoption, so every
  reader that asks "is this client on a standard" keeps working unchanged.
  Append-only.
- **Partial first week: it starts at the next Monday, never pro-rated.** A
  mid-week start date waits for the following Monday, so the first week is a
  full 5 / 5 / 3 and nothing is owed for the days before it (no retroactive
  obligation, no catch-up). Pro-rating was rejected: 5 × 3/7 is not a whole
  post, any rounding rule is arbitrary, and it would tie the planner to the
  day the adoption happened to be typed in. A week that is planned late (the
  Monday run missed) gets only the target of the days left in it.
- **Reruns add nothing back.** A site's room in a week is the smaller of the
  week's target less everything dated in the week, and the target of the
  days left less what is already dated on them. A Wednesday-first week opens
  3 Facebook / 3 GBP / 2 blogs once; a second run that day, or on Thursday
  or Friday, opens nothing, even if Wednesday's slots were removed. A missed
  day stays missed.
- **Page refresh stays monthly.** For a month the weekly standard governs,
  `plan_delivery_month()` plans the weeks, then runs its monthly loop for
  `page_refreshes` only: one refresh slot per website per month, as in v1, and
  a rerun opens none.
- **Standard days.** A weekly count lands on days in the order Mon, Wed, Fri,
  Tue, Thu, Sat, Sun: 5 → Mon–Fri, 3 → Mon / Wed / Fri. The planner prefers a
  site's free standard days; the month report uses the same days.
- **Month targets** (`delivery_targets()`): for a month the weekly standard
  governs, each deliverable's target is the sum of its days' share of their
  week's target, so the Nov 30 week counts its Monday in November and Tue–Fri
  in December, and a year adds up to exactly its weeks. The days of the
  transition month before the first weekly week keep v1's count pro-rated by
  weekdays (start Nov 9 → 8 × 5/21 ≈ 2, plus the weekly days after).
  Refreshes stay 1 a month. Every client the weekly standard does not govern
  for that month gets the v1 rows unchanged (`delivery_targets_monthly`).
- **Blog gate.** `blog_publication_has_room()` is unchanged and reads
  `delivery_targets()`, so a weekly client's month ceiling is the sum of its
  weekly blog targets in that month.

### Several locations, and the collision rule

- A website with two Business Profile locations still gets 5 GBP posts a
  week. The planner names the location on every GBP slot
  (`gbp_location_id`) and alternates, 3 / 2 one week and 2 / 3 the next.
- **At most `delivery_standards.gbp_daily_location_cap` (v2: 1) Business
  Profile post per location per Chicago day**, counting posts (published,
  scheduled, in review, draft) and open slots. The planner spreads every
  site's GBP slots over the free (location, day) cells of the week, sites in
  round-robin with the first site rotating week by week.
- **Over capacity is flagged, not dropped.** A slot that finds no free cell
  is still opened (the target stays visible) on its site's least-used day,
  and `social_slot_readiness()` reports `Over capacity: <location> already has
  1 Business Profile post(s) planned on <day> …`, so it is never queued,
  claimed or linked. A three-site client on one location under the plain
  standard: 15 wanted, 7 placed, 8 over capacity every week; that client now
  has a cadence override (below).
  `gbp_slot_capacity_problem()` is the rule; only weeks a weekly adoption
  governs are judged, so monthly clients are unaffected.

### Cadence overrides (Tom, Nov 3 2026; Executive OS task `3ab519f3`, decision `367b12c0`)

Tom's call for the three-site client on one shared location: **7 Business
Profile posts a week in total, at most one a day, alternating between the
businesses.** Facebook (5 a site), blogs (3 a site) and the monthly refresh
are unchanged. Migration `20261103180000_gbp_cadence_override.sql`, sandbox
suite `gbp_cadence_override.test.sql`.

- **Data, not code.** `client_delivery_overrides (client_id, deliverable
  'gbp_posts', allocation 'round_robin', weekly_total 1–7, effective_week,
  source_ref, recorded_by, recorded_at)`. `effective_week` is a Monday, today
  or later (no retroactive weeks). Append-only: a later row replaces an
  earlier one from its week, and `allocation = 'standard'` (no total) ends
  the override. It applies only in weeks the weekly standard governs for the
  client; recording it before the client adopts the standard is fine.
- **Rotation.** The week's `weekly_total` positions sit on the first
  `weekly_total` standard days in date order (7 → Mon–Sun, one a day).
  Position *i* of week *w* goes to site `((w − effective_week) / 7 ×
  weekly_total + i) mod sites`, sites ordered by slug. It is one continuous
  round robin, day after day across week boundaries: with three sites (a, b,
  c by slug) the weeks run `abcabca`, `bcabcab`, `cabcabc`, then `abcabca`
  again, so each week is 3 / 2 / 2 and the extra post rotates. It is computed
  from the calendar, not from what happens to be planned, so reruns and
  late runs agree.
- **Planner.** `plan_delivery_week` opens each position's slot on its own day
  (`delivery_override_id` set) unless the day has passed or already carries
  a Business Profile item. A site never gets more than its share less the
  work already dated in the week, and the week never more than
  `weekly_total`. Reruns open nothing, and a missed day stays missed.
- **A week the standard already planned.** The first time the override
  plans a week, the standard's GBP slots for that week with nothing attached
  are retired (blocked, `Retired: superseded by the Business Profile cadence
  override …`, previous hold kept, never deleted). A slot with work attached
  (post, article, draft, delivered mark, open task) stays, holds its day
  and counts toward its site's share.
- **Reporting.** `delivery_week_report`'s GBP target is the site's share of
  the week (7 in total, not 15), so the removed 8 are neither remaining nor
  over capacity; retired slots show in `v1_retired`. `delivery_targets`
  adds `delivery_override_month_delta()` per site and month: the override's
  days less the standard's days, which is 0 for every other client and
  month, so their rows are unchanged. One post a day means a fully covered
  month has as many GBP posts as days. The days of a transition month
  before the first weekly week keep v1's pro-rated count, as before.
- **Recording one (data, after review):**

  ```sql
  insert into client_delivery_overrides (client_id, deliverable, allocation, weekly_total, effective_week, source_ref)
  values ('<client id>', 'gbp_posts', 'round_robin', 7, date '<first Monday it applies>', '<where Tom decided it>');
  ```

  Then `select * from delivery_week_report('<client id>', '<that Monday>', '<+ 3 weeks>')`
  shows 7 GBP posts a week and no over capacity.

### Reconciliation of the v1 slots

- A slot with work attached (a post or article in any state but rejected, a
  draft, a delivered mark, or an unfinished task) is kept and its work counts
  once, in the week of its date. The four pilot posts published Oct 29 2026
  from Nov 3 slots count in the week of Oct 26; their November slots carry no
  credit and do not reduce the week of Nov 2.
- v1 slots dated on or after the first weekly week with nothing attached are
  **retired** the first time the weekly planner runs for the client:
  `hold = 'blocked'` with a `Retired: superseded by weekly delivery standard
  v2 …` reason (every existing gate already skips a blocked slot),
  `retired_at` stamped, the previous hold kept in `retired_hold` /
  `retired_hold_reason`. Never deleted. Clearing the hold by hand un-retires
  the slot. Refresh slots are never retired.
- `delivery_week_report(client, from, through, preview_week)` is the
  read-only reconciliation: per client, site, week and deliverable the
  target, credited work (and how much is published), open slots, v1 slots
  retiring / retired, GBP over-capacity and the projected overflow. For a
  client without a weekly adoption, `preview_week` previews a start.

### Scheduling

- **New:** `delivery-standard-week`, Mondays 10:00 UTC (04:00 / 05:00
  Chicago): `plan_delivery_weeks()` plans the current and next week for
  active / launching clients with a weekly adoption whose first week has
  arrived or is next, then queues this week's drafts
  (`queue_delivery_week_drafts`) for those whose first week has begun. No
  adoption → it does nothing.
- **Unchanged cron definitions:** `delivery-standard-month` and
  `weekly-blog-posts` still call `plan_delivery_month()`; for a weekly
  client's month it now plans the month's weeks (Mondays in the month, from
  the current week) and its one page refresh per website. For every other
  client it is unchanged.
- **Drafting lead time (Monday publication).** Drafts must exist, and be
  reviewed, before their day. The Wednesday beat (`create_weekly_blog_tasks`)
  used to queue only through the current Sunday, so next Monday's and
  Tuesday's slots waited for the following Wednesday, two days late. For a
  weekly client it now plans next week and queues through **next** Sunday:
  Monday's drafts are queued five days ahead. Clients on the monthly
  standard keep the old horizon. The Monday beat queues the current week as a
  fallback (a first week adopted after the Wednesday before, or a slot the
  Wednesday beat could not queue), so nothing waits for the Wednesday it
  falls in. `queue_delivery_week_drafts` applies the Wednesday beat's gates
  (brand, approved core list, `social_slot_readiness`) and logs every skip.
  Both beats read `delivery_today()` (the Chicago date; a pinned date only in
  the sandbox).
- Drafting still needs readiness (brand board or site guidance, verified
  destination, approved core keyword list, holds); publishing still needs
  Tom's approval, the publisher switch and the holds. None of it changed.

### Adopting a client (data, after review)

```sql
insert into client_weekly_delivery_standards (client_id, standard_id, start_date, source_ref)
select c.id, s.id, date '<Tom''s start date>', '<where Tom decided it>'
from clients c cross join (select id from delivery_standards where version = 2) s
where c.id in (<client ids>);
```

Then run `select * from delivery_week_report(null, '<start>', '<start + 4 weeks>')`
to see the first weeks before the Monday run plans them. If the adoption is
recorded after the Wednesday before the first week, plan and queue that week
in the same step, so Monday's drafts do not wait for the Monday beat:
`select plan_delivery_week(id, '<first Monday>'), queue_delivery_week_drafts(id, '<first Sunday>')`
per client (service role). It queues drafts only; nothing is approved,
scheduled or published.

### Dry run against production (Oct 30 2026, rolled back)

Migration applied, every v1 client adopted from Monday Nov 2, November
planned, all inside one transaction that raised at the end. 12 clients,
14 websites (one client with three sites).

- Week of Oct 26 (before the start, target 0): 8 Facebook and 6 GBP posts
  credited (5 and 3 published), the four pilots among them; 27 / 27 / 29
  open v1 slots kept.
- Each November week: target 70 Facebook, 70 GBP, 42 blogs (14 sites ×
  5 / 5 / 3); nothing credited yet; 8 GBP slots over capacity (the
  three-site client).
- November v1 slots: 332 retired (110 Facebook, 110 GBP, 112 blogs; 96 of
  them were already blocked); 4 kept, the pilot slots; 14 refresh slots kept.
- Weekly slots opened for Nov 2 – Nov 30: 910 (182 a week).
- November month targets: Facebook 112 → 294, GBP 112 → 294, blogs
  112 → 182, refreshes 14 → 14.

### Open decisions for Tom

1. **Start date** (the only input the adoption needs), and which clients.
2. ~~The three-site, one-location collision.~~ **Decided Nov 3 2026**
   (Executive OS decision `367b12c0`): 7 GBP posts a week across the three
   sites, one a day, alternating between the businesses. Recorded per client
   as a cadence override (above), not as a new standard.
3. Whether a shortfall week should ever be made up later (today: no).
4. The weekday pattern (Mon–Fri for posts, Mon / Wed / Fri for blogs).

### Rollback

Roll back `20261103180000` first:
`supabase/rollback/20261103180000_gbp_cadence_override.down.sql` restores
`plan_delivery_week`, `delivery_week_report` and `delivery_targets` byte for
byte (md5-checked) and removes the override's table, column and functions.
Once an override is recorded it stops unless
`compass.delivery_override_rollback = 'confirmed'`; then the rows are kept as
`client_delivery_overrides_rolled_back`, slots the override opened stay as
ordinary weekly slots, and slots it retired stay retired. Nothing is deleted.

`supabase/rollback/20261030180000_weekly_delivery_standard.down.sql`
restores `social_slot_readiness`, `plan_delivery_month`, `delivery_targets`
and `create_weekly_blog_tasks` byte for byte (md5-checked) and unschedules
`delivery-standard-week`. With no adoption it removes everything, standard 2
included. Once a client has adopted it stops unless
`compass.weekly_rollback = 'confirmed'`; then retired v1 slots get their
holds back, weekly slots with nothing attached are removed, slots with work
stay, and the adoption rows are kept as
`client_weekly_delivery_standards_rolled_back`.
