# Delivery standard

What Compass delivers per website, kept apart from what the agreement sold
(billing entitlements, 0062). Two versions live side by side in
`delivery_standards`; a client works to one of them by data, never by a
migration.

| Version | Cadence | Per website | Migration |
| --- | --- | --- | --- |
| 1 | monthly (America/Chicago calendar month) | 8 Facebook, 8 Business Profile, 8 blogs, 1 page refresh | `20261015150000_monthly_delivery_standard.sql` |
| 2 | weekly (Monday–Sunday, America/Chicago) | 5 Facebook, 5 Business Profile, 3 blogs a week; 1 page refresh a month | `20261030180000_weekly_delivery_standard.sql` |

The unit is the same in both: each brand site of a multi-brand client
(`client_brand_workspaces`), otherwise the client. Business Profile
locations are destinations, never units.

## Monthly standard (v1)

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
  claimed or linked. A three-site client on one location: 15 wanted, 7 placed,
  8 over capacity every week until Tom decides (see below).
  `gbp_slot_capacity_problem()` is the rule; only weeks a weekly adoption
  governs are judged, so monthly clients are unaffected.

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

### Release (Oct 31 2026)

Tom's go-ahead: Executive OS decision `fcdbcc8b-618b-42f9-8865-f4b18d283621`,
after ChatGPT's re-review of `abc794b`. It covers the release, two adoptions
from Mon Nov 2 and first-week drafts for review. It does not approve or
publish any content.

- **Checks:** main had one new commit (#208), which touches none of the
  patched functions. Production's four patched functions still matched the
  md5s the patch expects. Merged as `f7431ba`; CI green; `npm test` 1320/1320.
- **Rehearsal (rolled back, in production, two clients):**
  - Per client: November opened 65 slots (5 Monday weeks × 13), and a rerun
    opened 0. December, a fresh month, opened 53 (4 × 13 + 1 refresh), and a
    rerun opened 0.
  - Week of Nov 2: 10 social slots ready; the pilots credited to the week
    of Oct 26.
  - No task, no worker fire, no other client touched.
- **Applied:** remote version `20261031153456`. All 24 functions it defines
  or patches hash the same as a sandbox replay of the repo file.
  `delivery-standard-week` is scheduled (Mon 10:00 UTC). Grants are as
  reviewed. Merged as `a2dfca4`; Vercel production deploy succeeded.
- **Adoptions:** two rows, `effective_week = 2026-11-02`. Per client:
  - 65 November weekly slots;
  - 22 unattached v1 slots retired (8 blog, 7 Facebook, 7 GBP);
  - the 2 pilot slots kept (no November credit);
  - the November refresh slot kept.
- **First week:** the adoption came after the Wednesday before, so the week
  was queued at once with `queue_delivery_week_drafts(id, '2026-11-08')`, one
  worker fire per client. Five existing in-review posts whose keywords are on
  the approved core list filled week-1 slots first. They were linked the way
  the Planner's "Link output" links them; the posts themselves are unchanged.
  21 slots were queued for drafting.
- **First week in review** (Oct 31, about an hour after the fires): each
  site has 5 Facebook, 5 GBP and 3 blogs in review for the week of Nov 2,
  every new item tied to its approved core list v2. Nothing is approved,
  scheduled or published.
  - **Defects found on reading the drafts, left for review:** a location with
    no `gbp_location_markets` row gets copy written for the client's home
    market, so an office profile in another city got home-market copy.
    `content_revise` only replaces media; copy fixes are a review decision.
  - **Images:** none attached to the new items. A client with no approved
    brand photo needs a visual review, or illustrative images, before any are
    attached.

### Open decisions for Tom

1. ~~Start date~~ Decided Oct 31: Mon Nov 2 for two clients; the rest join as their readiness is approved.
2. **The three-site, one-location collision (unresolved).** Tom asked for
   15 GBP posts a week across the three-site client's websites; one post per location
   per day fits only 7 on its one shared profile, so the 7-post limit does
   **not** fulfil the request. The planner opens all 15 and flags the other
   8 "Over capacity" (never drafted) until Tom chooses: connect more
   locations, record a standard with a higher daily cap, or accept a lower
   count.
3. ~~Make-up weeks~~ Decided Oct 31: missed work is reported, never added to later weeks.
4. ~~Weekday pattern~~ Decided Oct 31: Mon–Fri for posts, Mon / Wed / Fri for blogs.

### Rollback

`supabase/rollback/20261030180000_weekly_delivery_standard.down.sql`
restores `social_slot_readiness`, `plan_delivery_month`, `delivery_targets`
and `create_weekly_blog_tasks` byte for byte (md5-checked) and unschedules
`delivery-standard-week`. With no adoption it removes everything, standard 2
included. Once a client has adopted it stops unless
`compass.weekly_rollback = 'confirmed'`; then retired v1 slots get their
holds back, weekly slots with nothing attached are removed, slots with work
stay, and the adoption rows are kept as
`client_weekly_delivery_standards_rolled_back`.
