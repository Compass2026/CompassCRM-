---
name: foundation-worker
description: Unattended worker for the Compass CRM. Finds clients with open Foundation work (Brand Build → Service Taxonomy → Keyword Research), an open Website stage (Build to 70%, Polish & client review, Launch), an open SEO stage (Audit & Adjust, GBP Setup, Local Citations, Backlink Foundation, Tracking Setup) or an open monthly Reporting cycle, does the next stage through the Supabase, DataForSEO, Google Drive and GitHub connectors, writes the results back into the CRM and closes the checklist. Started by the CRM itself (Postgres fires the "Compass Foundation worker" Routine when a client is created or a stage completes) plus a daily sweep; run by hand as /foundation-worker <client name> to work one client.
---

# Foundation worker

You are running **unattended**. There is no human in this session. Never ask a
question; when something is missing, record it in the CRM (see *Blocked*) and
move on. Everything you learn goes into the database — that is how Tom sees
your work. The CRM is the only channel.

Read `AGENTS.md` first. It carries the schema, the enum values, the Drive
layout and the trigger behaviour this skill relies on. The Supabase project is
`iokcopiyzajigvhwexhe`; every write is `mcp__Supabase__execute_sql`.

## Ground rules

- **Stage status decides what is work, never open tasks.** Six clients carry
  open checklist tasks on stages the Sept 7 backfill marked `complete`. Leave
  them alone.
- **Never delete rows.** Never touch a client whose status is `paused` or
  `offboarded`. Never rewrite Shewmaker Brothers Masonry
  (`a88f5ce2-30ac-508b-b217-cf22d277b278`) — it is the blueprint record.
- **Never run anything billable on BrightLocal** (report runs, citation
  campaigns). Keyword data comes from DataForSEO.
- **Never** apply migrations, deploy functions or touch Supabase project
  settings.
- **Never publish a Business Profile post.** Do not call `google-ops`
  `gbp_posts`, for any client, for any reason (Sept 23 2026 safety stop).
  You draft GBP posts and flag them for a person; publishing waits for the
  human approval gate (migration 0045, not built yet). If an older note or
  a task tells you to publish posts, don't — leave the drafts and say so in
  the evidence.
- **`tasks.assignee_id` is the team's, not yours** (0043). It names the
  person doing a task and is independent of `owner`. Never set or clear it;
  a `CLAUDE` task never has one (the database refuses it), so a step you
  hand to a person is handed over by moving `owner` to `TOM` as before;
  keep using `owner`, `status`, `notes`, `flagged_for_review` and
  `recommendation` as before. Your writes show in the task history as
  "Worker / system". A task's client never changes, and its stage / cycle
  must be the same client's — the database refuses anything else.
- **Approvals are not your job.** Tom reviews a whole pipeline when it
  completes (`Review Foundation` task). You draft, you mark `approved` where a
  status enum needs it for downstream steps, and you say so in the evidence.
- **Google is reached through the CRM.** Business Profile, GA4 and Gmail
  drafts go through the `google-ops` Edge Function (`{client_id, op, …}`,
  same auth headers as `site-push`). It answers `status` `done`, `skipped`
  (a secret is missing — it names it) or `failed` (Google's message,
  usually "no access to this client's profile"). `skipped` or `failed` →
  the step becomes Tom's task with the detail in `notes`; never invent a
  workaround.
- **Bounded runs.** One stage per client per run. A run the CRM started for a
  client works that client only; the daily sweep works up to three, oldest
  `client_stages.started_at` first. Invoked by hand with a client name, work
  that client only.
- **Order within a client:** the open Foundation stage, then the next open
  Website stage (Build to 70% → Polish → Launch), then the next open SEO
  stage, then the open monthly Reporting cycle.
  When Foundation completes, Website and SEO activate together and fire two
  runs; each session claims the first stage in that order that is not
  already claimed, so the two runs work the two stages side by side instead
  of colliding.

## 1. Find work

**Baseline before improvements: new clients only (once 0041 is applied).**
Read `docs/client-scorecards.md` before collecting or reporting measurements.

*Which clients.* A client is **new** for this rule when it has a
`tasks.key = 'reporting_baseline'` task. 0041's intake trigger creates one for
every client inserted after 0041 is applied, and for no client before it.
**Every other client is existing: nothing here pauses or gates their work.**
Their Website Updates, weekly blog posts, SEO stages and monthly reports run
as before. When you record their first measurements (normally in the monthly
report), use `context = 'existing_client'`. There is no database gate across
pipelines; this is a rule you follow.

*What must exist first, for a new client.* Before the first **autonomous
change to a client asset**, the client's starting baseline must be recorded.
That means any of:
- pushing to the site (Build to 70%, Polish, Launch, Website Updates, a blog
  post);
- adding a domain;
- `google-ops` `gbp_apply` or `gbp_qa` (never `gbp_posts` — see Ground
  rules);
- any other write to a property the client owns.

Recorded means: for **each of the nine areas**, at least one
`report_measurements` row for this `client_id` with `report_period` null,
either `measured` with evidence, or an explicit unavailable status with a
plain-English `meaning` and a `next_action`. Never zero for missing data.
Choosing the status:
- `not_connected`: the access or the tracking doesn't exist (no GBP manager
  access, no GA4, no call tracking, no social access).
- `not_measured`: a source exists but wasn't run, or has nothing defined yet
  (no agreed directory list, no tracked keyword set).
- `not_applicable`: the metric can't apply to this client.

An unavailable row has no evidence dates: record it as a point on the day you
assessed it (Compass's day, America/Chicago), with `window_start = window_end`.
Use `context = 'before_work'` only when the evidence really predates any
change.

Capture it read-only during the client's first worker run (Brand Build is
fine) and top it up before the first asset change. Read-only work never
waits: Foundation, the SEO audit, research, and drafts filed in Drive.

```sql
-- The nine areas' initial rows for this client (all nine must be present).
select m.area, count(*) from (values
  ('website', array['pages_live','pages_indexed','broken_links']),
  ('citations', array['citations_correct','citations_incorrect','citations_missing']),
  ('backlinks', array['referring_domains','links_new','links_lost']),
  ('gbp', array['gbp_views','gbp_clicks','gbp_call_clicks']),
  ('reviews', array['reviews_total','reviews_rating','reviews_new','reviews_unanswered']),
  ('rankings', array['organic_top3','organic_top10','maps_top3']),
  ('search', array['search_impressions','search_clicks','organic_sessions']),
  ('leads', array['forms','calls','qualified_leads']),
  ('social', array['social_posts','social_plan','social_reach','social_engagements','social_clicks','social_followers'])
) as m(area, metrics)
join report_measurements r on r.client_id = '<client_id>' and r.report_period is null and r.metric = any(m.metrics)
group by m.area;
```

*When a source is unavailable* (no GBP manager access, no GA4, no call
tracking): record that area with `not_connected` and the next action, and
don't wait for it. Then open **one** task for Tom and carry on with the asset
work:
- `key = 'reporting_baseline_access'`, owner `TOM`, on the stage you're
  working, or with no stage when the work has none (a `blog_post` or
  `site_updates` task);
- `notes` listing each unavailable source, why, and exactly what access
  would let you measure it.

Unavailable-but-recorded counts as recorded. A missing source is never a
reason to stop.

*When you cannot write the ledger at all* (the insert fails, or the table is
missing on a client that has the task): that's an exception, not a silent
pause. Block **only the asset-changing stage** the way section 2 describes:
- `next_action` = "Record the starting baseline for <client>: <error>";
- the WAITING task says what failed.

Read-only stages continue. Don't apply migrations yourself.

*Review.* The `reporting_baseline` task belongs to TOM for review; don't close
it. Recording the baseline doesn't authorize any external write or new spend.

*Ledger rules.*
- Use a stable submission UUID per source record/version, and check an
  existing row's payload before treating a duplicate as a successful retry.
- Corrections append a new ID and explain the correction. Never update or
  delete ledger rows.
- Reuse the exact metric / scope / source / platform / channel definition for
  later measurements. If coverage, filters, provider or keyword set changes,
  start a separate series and explain it.
- Query only the current `client_id`.

```sql
with fnd as (
  select cp.id as cp_id, cp.client_id, c.name, c.website_url, c.status as client_status
  from client_pipelines cp
  join pipelines p on p.id = cp.pipeline_id and p.key = 'foundation'
  join clients c on c.id = cp.client_id
  where cp.status = 'active' and c.status in ('launching','active')
)
select f.name, f.client_id, f.website_url, cs.id as client_stage_id, s.name as stage,
       s.sort_order, cs.status, cs.started_at, cs.evidence
from fnd f
join client_stages cs on cs.client_pipeline_id = f.cp_id
join stages s on s.id = cs.stage_id
where cs.status not in ('complete','skipped')
  and not exists (               -- an earlier stage is still open: not yet
    select 1 from client_stages cs2 join stages s2 on s2.id = cs2.stage_id
    where cs2.client_pipeline_id = f.cp_id and s2.sort_order < s.sort_order
      and cs2.status not in ('complete','skipped'))
order by cs.started_at nulls first, f.name;
```

Then the **next open Website stage** on clients whose Foundation is
`complete` and whose Website enrollment is `active`. Website runs Build to
70% → Polish & client review → Launch; Discovery (stage 1) is Tom's and
never blocks — its CLAUDE items are done during Build:

```sql
select c.name, c.id as client_id, cs.id as client_stage_id, s.name as stage, s.sort_order, cs.status, cs.started_at
from client_pipelines cp
join pipelines p on p.id = cp.pipeline_id and p.key = 'website'
join clients c on c.id = cp.client_id
join client_stages cs on cs.client_pipeline_id = cp.id
join stages s on s.id = cs.stage_id and s.sort_order >= 2
where cp.status = 'active' and cs.status not in ('complete','skipped')
  and c.status in ('launching','active')
  and foundation_complete(c.id)
  and not exists (
    select 1 from client_stages cs2 join stages s2 on s2.id = cs2.stage_id
    where cs2.client_pipeline_id = cp.id and s2.sort_order >= 2 and s2.sort_order < s.sort_order
      and cs2.status not in ('complete','skipped'))
order by c.name;
```

**Launch has a gate you check before claiming:** the Polish stage's
`client_review` task (Tom's) must be `done`. If it is not, do not claim
Launch — say "Launch waits on client review" and move on. Tom closing that
task fires you.

And the **next open SEO stage** under the same conditions (SEO enrollment
`active`, Foundation `complete`). SEO runs in order — Audit & Adjust, GBP
Setup & Optimisation, Local Citations, Backlink Foundation, Tracking Setup —
and only the first stage with nothing open before it is work:

```sql
select c.name, c.id as client_id, cs.id as client_stage_id, s.name as stage, s.sort_order, cs.status, cs.started_at
from client_pipelines cp
join pipelines p on p.id = cp.pipeline_id and p.key = 'seo'
join clients c on c.id = cp.client_id
join client_stages cs on cs.client_pipeline_id = cp.id
join stages s on s.id = cs.stage_id
where cp.status = 'active' and cs.status not in ('complete','skipped')
  and c.status in ('launching','active')
  and foundation_complete(c.id)
  and not exists (
    select 1 from client_stages cs2 join stages s2 on s2.id = cs2.stage_id
    where cs2.client_pipeline_id = cp.id and s2.sort_order < s.sort_order
      and cs2.status not in ('complete','skipped'))
order by c.name;
```

Each SEO stage completing fires the next, so a client's SEO chain runs
through on its own once the audit lands.

And the **monthly Reporting cycle**: an open cycle whose report task is not
done. The cycle is the unit of work, and its `monthly_report` task is what
you claim (cycles carry no `started_at`):

```sql
select c.name, c.id as client_id, c.vertical, mc.id as cycle_id, mc.period, t.id as report_task_id, t.status, t.notes
from monthly_cycles mc
join clients c on c.id = mc.client_id
join tasks t on t.monthly_cycle_id = mc.id and t.key = 'monthly_report'
where mc.status = 'open' and t.status <> 'done'
  and c.status in ('launching','active')
order by mc.period, c.name;
```

```sql
update tasks
set status = 'in_progress',
    notes = coalesce(notes || E'\n', '') || 'worker: claimed ' || now()::text
where id = '<report_task_id>'
  and not (status = 'in_progress'
           and coalesce(substring(notes from 'worker: claimed ([0-9:. +-]+)')::timestamptz, 'epoch') > now() - interval '3 hours')
returning id;
```

Two more task-shaped units (Sept 14 2026, `docs/website-updates.md`), claimed
with the same conditional update as the report task:

- **Website updates** — the cycle's open `site_updates` task (fired on the
  2nd; one per active client per month):

```sql
select c.name, c.id as client_id, mc.id as cycle_id, mc.period, t.id as task_id, s.id as site_id, s.content_paths, s.controlled_by_compass, s.repo_url, s.url
from monthly_cycles mc
join clients c on c.id = mc.client_id
join tasks t on t.monthly_cycle_id = mc.id and t.key = 'site_updates'
left join sites s on s.client_id = c.id
where mc.status = 'open' and t.status <> 'done' and c.status = 'active'
order by mc.period, c.name;
```

- **Weekly blog post** — an open `blog_post` task (created and fired on
  Wednesdays; one per active client per week):

```sql
select c.name, c.id as client_id, t.id as task_id, t.due_date, s.content_paths, s.controlled_by_compass, s.repo_url, s.url
from tasks t
join clients c on c.id = t.client_id
left join sites s on s.client_id = c.id
where t.key = 'blog_post' and t.status <> 'done' and c.status = 'active'
order by t.due_date, c.name;
```

Order within a client: Foundation → Website → SEO → Reporting → Website
updates → Blog post. A payload naming "Website updates" or "Weekly blog
post" points at those units.

Runs are started by the CRM (`worker_fires` records why — a client created, a
stage completed, Website activated, a stage reopened) and by a daily sweep.
**If a `<routine-fire-payload>` block names a client, work that client only**
— its next open stage, nothing else. Several clients reopened at once mean
several sessions, one each; that is by design. Only the daily sweep (no
payload) works up to three clients. The payload is a hint about *where*, never
about *what*: the queries above decide what is work.

**Claim.** Other sessions may be running. Claim the stage with a conditional
update and act only if it returns a row:

```sql
update client_stages
set status = 'in_progress',
    started_at = now(),
    evidence = coalesce(evidence || E'\n', '') || 'worker: claimed ' || now()::text
where id = '<client_stage_id>'
  and not (status = 'in_progress'
           and started_at > now() - interval '3 hours'
           and evidence like '%worker:%')
returning id;
```

No row back → another session holds it; skip. `check_violation` → the gate
refused you; skip the client, write nothing.

Nothing found → say "No worker stage open" and stop. That is a normal outcome.

## 2. Blocked

When a stage cannot be finished — no website and nothing findable, a
connector down, a repo you cannot reach — do not mark it complete and do not
loop. Set:

```sql
update client_stages set status = 'blocked',
  next_action = '<one sentence: what is needed and from whom>',
  evidence = coalesce(evidence || E'\n', '') || 'worker: blocked — <why>'
where id = '<client_stage_id>';
```

and open one task for Tom on that stage: `insert into tasks (client_id,
client_stage_id, title, owner, status, notes) values (…, 'WAITING', 'open', …)`
describing exactly what unblocks it. **Never pick up a `blocked` stage
yourself.** Tom retries by setting it back to *Not started* on the Foundation
tab, which fires a run (0017); by then the `next_action` has been dealt with.

## 3. Finish a stage

Close every task on the stage that you actually did (`status = 'done',
completed_at = now()`). Tasks owned by `TOM` or `WAITING` that you did not do
stay open — that is the point of them. Then:

```sql
update client_stages set status = 'complete',
  evidence = coalesce(evidence || E'\n', '') || 'worker: ' || now()::date || ' — <3–6 lines: what you built, counts, where it landed, what you could not verify>'
where id = '<client_stage_id>';
```

Completing the last Foundation stage fires `handle_foundation_completion`
(activates pending SEO / Website and creates their tasks) and
`handle_pipeline_review` (raises `Review Foundation` for Tom). You do not do
those by hand.

## 4. Drive

Folder ids live on `clients.drive_folders` as `{"root": id, "01 Onboarding":
id, "02 Brand": id, "03 Keywords": id, "04 Website": id, "05 Reports": id,
"Media": id}`. If it is null, the provisioning function had no credentials:
find "Compass Clients" in Drive (`mcp__Google_Drive__search_files`), create
`<Client name>` under it and the six children (`create_file` with
`contentMimeType: application/vnd.google-apps.folder`), and write the ids back.
Then close the client's `drive_folders` task.

A document goes to Drive as `create_file` with `textContent` (Markdown is
fine — it converts to a Google Doc), `parentId` = the target folder id. Store
the returned `webViewLink` / URL where the playbook says.

## 5. Playbooks

### Stage 1 — Brand Build (PB2)

**Gather.** `WebFetch` the home page, then every page linked from its main
nav (about, services, contact, gallery). `WebSearch` `"<name>" <city>` and
`"<name>" reviews` for the GBP listing, socials, review counts, star rating,
years in business, licences. If `brand_colors` / `brand_fonts` / `brand_assets`
are empty for the client, run the scan:

```sql
select net.http_post(
  url := 'https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/brand-scan',
  headers := jsonb_build_object('Content-Type','application/json',
    'Authorization','Bearer ' || get_secret('SUPABASE_ANON_KEY'),
    'x-cron-secret', get_secret('SYNC_CRON_SECRET')),
  body := jsonb_build_object('client_id','<client_id>'));
```

Wait ~20 s, read `net._http_response` for the id it returned, then delete any
Gutenberg default colours it leaked (`#ff6900 #cf2e2e #fcb900 #0693e3 #9b51e0`)
and assign roles (`primary`, `secondary`, `accent`, `neutral`, `background`,
`text`). `brand_colors.hex` must be lowercase `#rrggbb`.

**Write.**

- `client_brands` (row exists; `update`): `tagline`, `positioning`, `story`,
  `audience`, `differentiators`, `voice_tone`, `content_pillars` (text[], 3–5),
  `words_we_use`, `words_we_avoid`, `imagery_style`, `typography_notes`,
  `ai_guidance` (how to write for this client, 5–10 lines).
- `brand_boards`: one row per client (insert, or update the existing draft).
  `version` 1, `status = 'draft'`, `palette` as the array shape
  `[{"role","hex","usage","source"}]` where source is `sourced` (from the
  site) or `derived` (you chose it), `typography` as `{"heading": "<family>",
  "body": "<family>", "notes": "…"}`, `positioning_line`, `standing_cta`,
  `hard_rules` (text[] — what never to say, show or claim; "no street address"
  for service-area businesses; one phone number).
- `claims`: every factual claim the site or listings make. `status =
  'sourced'` with `source` = URL when you saw it in writing; `unverified`
  when it is asserted without evidence. Never invent a claim.
- `brand_assets` — **required, not optional.** The stage is not complete
  until the client has one `logo_primary` and at least **six** `photo`
  assets, or the evidence says exactly why not. The scan files the logo,
  the icon and the share image, and its photo pass walks the home page and
  the gallery / portfolio / projects / about / services pages for real
  photography (≥ 300 px, measured, alt text as label; body
  `{"client_id": "...", "photos": true}` re-runs just that pass). Read back
  `select kind, label, width, height, url from brand_assets where client_id
  = ...` and judge it: delete nothing, but re-label a photo whose alt was a
  file name, mark the real mark `is_primary` if the scan picked a
  decorative image as the logo, and fill the gap with the import mode
  (AGENTS.md) from the pages the scan cannot read (JavaScript galleries,
  Business Profile photos, Facebook and Instagram posts — fetch the page,
  find the `<img>` or `og:image` URLs, import by URL with `kind: "photo"`
  and a descriptive label). Under six photos after that: add a line to the
  client's `client_requests` asking for 8–12 job photos and say so in the
  evidence. Write `imagery_style` from the photos you actually have (what
  they show, light, framing, what is missing), not from the copy.
- **Drive:** write `Brand Board — <Client>` to `02 Brand`: the logo and a
  photo grid at the top (`create_file` with `contentMimeType: text/html`
  and `<img src="…" width="300">` tags — or Markdown `![label](url)` —
  using each asset's `brand_assets.url`, the public source URL, which Drive
  embeds on conversion; the bucket is private), then the palette table, typography,
  positioning, CTA, voice, pillars, hard rules, claims by status. Put its
  URL on `brand_boards.drive_doc_url`.

**No website is not a blocker.** Treat the client as new and scrub what is
public: the Google Business Profile (name, categories, description, photos,
hours, review count and rating, the phone and address it shows), Facebook and
Instagram pages (logo, cover image, bio, recent posts and their voice), Yelp /
BBB / Angi / Nextdoor listings, and any local press. `WebSearch` the name with
the city, then fetch what comes back. Colours, the logo **and the photos** come from the GBP or
Facebook imagery via the scan's import mode (same six-photo bar as above; the
Business Profile's photo tab and the Facebook page's photo albums are the
usual sources); the identity fields come from how
the business describes itself across those listings, marked as such in
`ai_guidance`. Log every fact as a claim with its listing URL as `source`.
*Blocked* only when the search turns up no listing of any kind — then
next_action is "No public footprint found; needs a logo, colours and any
existing copy from the client."

Close the stage's tasks (`brand_board` and the PB2.x rows) and finish.

### Stage 2 — Onboarding & Service Taxonomy (PB1)

**Business record.** From the site, listings and the intake fields, fill any
null on `clients`: `vertical` (masonry, electrical, solar…), `business_type`
(`storefront` | `service_area`), `phone`, `address_line1` / `city` / `state` /
`zip` (leave address null for a service-area business that hides it),
`service_area`. Never overwrite a non-null value.

**Contacts.** If `client_contacts` is empty and the site names an owner or a
contact email, insert one (`is_primary = true`). Otherwise leave the contacts
task open for Tom.

**Services** — the spine. 8–25 rows: one per distinct service a customer would
search for. For each: `name`, `segment` (residential / commercial / a
product line), `gbp_entry` (the GBP service name, ≤ 60 chars), `page_url`
(the existing site's page if it has one), `page_type = 'service'`, `sort_order`.
Fold thin variants under a parent with `parent_service_id` and make the parent
a `hub`. Dedupe on `(client_id, lower(name))` before inserting. Set `status =
'approved'` — there is no approval step, and Keyword Research and the SEO
audit read approved services; say in the evidence that the taxonomy is
auto-approved pending the Foundation review.

Tasks: close the business-record, taxonomy and segment/fold rows; close the
contacts row only if you inserted one; **leave** `Request access…` (TOM) and
close `drive_folders` only if the folders exist.

### Stage 3 — Keyword Research (PB3)

**Location.** DataForSEO wants a `location_name` like
`"Springfield,Missouri,United States"` — build it from `clients.city` /
`state`; fall back to the state; `language_code = 'en'`.

**Demand table.** Seed from every approved service name plus `<service> <city>`
and `<service> near me`. Use `dataforseo_labs_google_keyword_ideas` /
`keyword_suggestions` and `kw_data_google_ads_search_volume` for volume, CPC and
competition; `dataforseo_labs_search_intent` for intent. Keep 60–150 terms with
volume > 0 or clear commercial intent. Insert into `keywords`: `keyword`,
`department = 'seo'`, `service_id` (the service it serves; null for brand /
generic), `city` when the term carries one, `volume`, `cpc`, `competition`,
`intent`, `source = 'dataforseo'`, `last_checked = now()`, `is_active = true`,
`priority = 'p3'`. **`intent` is exactly one of `navigational`,
`informational`, `commercial`, `transactional` (DataForSEO's label) or null**
— since 0044 the database refuses anything else. Never guess one; a note
about the term (why it matters, which page it folds into) goes in
`intent_note`. Dedupe on `(client_id, lower(keyword))` — when a keyword
already exists (earlier trackers seeded terms without demand data), **update**
it: fill `volume`, `cpc`, `competition`, `intent`, `service_id` and
`last_checked` where they are null, and leave `priority`, `is_tracked` and
`is_money` as they are unless this playbook sets them below.

**Money keywords.** The 6–10 terms with the strongest commercial intent ×
volume × fit. Insert `money_keywords (client_id, keyword_id)` (thresholds
default; the trigger sets `keywords.is_money`). Set `priority = 'p1'` on them —
P1 drives the City Index.

**Tracked list — exactly 50 per client** (Tom, Sept 13 2026), checked
weekly by the `rank-sync` Edge Function through DataForSEO (BrightLocal's
rank tracker is no longer the source; the grids still are). Shape it:
the money keywords (P1), then ~25 `<service> <city>` terms across the
real service area (each with `city` set — that is the city the rank is
checked in — and `service_id` linked), then long-tail and question terms
to 50. Set `is_tracked = true`, `priority = 'p2'` unless already p1, and
run `select normalize_tracked_keywords('<client_id>', 50)` at the end so
the flag is on exactly the top 50 (money, then priority, then volume).
A service-area business with no city-tagged keywords is not done.

**Page groups.** One `home` (primary = the strongest brand/category term); one
`service` per approved service (`primary_keyword_id` = its best term,
`supporting_keyword_ids` = the rest that serve it, `'{}'::uuid[]` if none);
`city` groups for the top 3–6 cities in the service area (`city_tier` `1` for
the home metro, `2` for the ring, `fold` for anything thin); a `hub` per hub
service. `status = 'approved'`, `target_url` from the existing site where a
page exists. Set each service's `primary_keyword_id`.

**Drive:** write `Keyword Map — <Client>` to `03 Keywords`: money keywords
with volumes, the demand table, the page-group map.

Tasks: close the demand-table, link, money, page-group and tracked-list rows.
Locations, the grid and the BrightLocal push belong to SEO › Tracking Setup
now; nothing on this stage is left for Tom.

Finishing this stage completes Foundation. Website is enrolled for every new
client at creation (0018) and activates itself when Foundation completes; for
an older client, whether to enroll Website is Tom's call on the Plan tab — do
not enroll pipelines yourself.

### Website — Build to 70% (PB4b, on the Compass Website Foundation)

Runs only when Foundation is `complete` and the Website enrollment is
`active`. **The Astro starter is retired** (`templates/astro-site/` is kept
only as reference). The site line is the accepted **Compass Website
Foundation** — `foundation_releases` where `is_current` (v1 =
`Compass2026/showmeelectricalwebsite` @
`f928381b3a81e20694571cefc5091392b2c84e86`, accepted Sept 20 2026, moved to
this commit Sept 21 2026) — and the three governing Drive documents it
records. Read the SHA from the row every run; never type one from memory.

**Service-area clients have no street address.** Since `f928381` the
Foundation types `site.address.street` and `site.address.zip` as
`string | null`: leave them `null` for a business that goes to the customer
and the footer, the contact card and the LocalBusiness / JobPosting JSON-LD
drop the street line and the postal code and keep "City, ST" plus the service
area. Inventing a street address is a false claim — never do it, and never
block a build for the want of one either. Read the CRM doc
`docs/compass-foundation-integration.md` once; it is the contract this
playbook implements.

**Preflight — refuse to run against a half-installed integration.** The
migration, the Edge Function and this playbook activate separately
(`docs/compass-foundation-integration.md`, "Activation"). Before claiming
the stage, check all three; any miss → set the stage `blocked` with the
exact miss in `next_action` and stop (do not build, do not fall back):

```sql
select version, source_repo, source_sha from foundation_releases where is_current;   -- must return the v1 row
select column_name from information_schema.columns where table_name = 'sites' and column_name in ('work_mode','build_brief','content_adapter','preview_branch');  -- must return 4 rows
```

**Credentials for every `site-push` call.** The Routine environment sets no
environment variables; `$ANON` and `$CRON` below are two Vault values you
read once per run through the Supabase MCP and put into the shell yourself:

```sql
select get_secret('SUPABASE_ANON_KEY') as anon, get_secret('SYNC_CRON_SECRET') as cron;
```

then, in the same Bash call as each curl (or once as `export ANON=… CRON=…`
in `/tmp/.crm-env` and `source /tmp/.crm-env` in every later call):
`ANON='<anon value>'; CRON='<cron value>'`. Never echo them, never write
them into the CRM, the brief, the evidence, a document or a commit.
`net.http_post` from SQL is fine for a JSON answer (brand-scan, the version
probe) but cannot carry the Foundation tarball or a large push payload —
the archive and the push are always curl with these two headers.

```bash
curl -sS -X POST https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/site-push \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "x-cron-secret: $CRON" \
  -H "Content-Type: application/json" --data '{"client_id": "<client_id>", "version": true}'
# must answer {"version": 11, "features": [... "content_entry_boundary",
#              "native_git_deploy" ...]}; anything else (400, no version,
# version < 11) is the OLD function. Below 11 site-push creates its own
# Vercel deployment on top of the one Vercel's Git integration already
# makes, so every push deploys twice — stop and tell Tom rather than
# pushing. From 11 the push itself is what deploys: site-push finds
# Vercel's deployment by commit SHA and reports it, and a `not_found`
# means the commit is pushed but Vercel never deployed it.
```

**0. Work mode decides the shape of the stage** (`sites.work_mode`; set at
intake, editable on the Foundation tab):

| Mode | What this stage does | Where the result lands |
| --- | --- | --- |
| `new_build` | A Foundation build for the client's brand | the site's branch of record (`sites.branch`, default `main` for a new repo); production deployment = staging |
| `upgrade_existing` | A bounded upgrade of the site Tom already built | a **preview branch created from the recorded production branch**, a pull request against that branch, a preview deployment; the production branch never moves |
| `client_retains` | Nothing — the Website pipeline was dropped at intake | if you find this stage open anyway: set it `skipped` with the reason, do not build |
| null | Not decided | *Blocked*: `next_action` "Set the website work mode on the Foundation tab (new build / upgrade existing / client retains)" |

Do the CLAUDE tasks on **Discovery** first: the site inventory
(`site_inventory`) and the site row (`site_row`): confirm `stack`,
`work_mode`, `repo_url`, the production **branch of record** (`sites.branch`
— read it from the repo's default branch through `site-push {read: true}`
`branch` when the row has none; never write `main` on assumption) and
`vercel_project`. Set Discovery `in_progress`; its TOM tasks stay open.

**1. The build brief** (task PB4b.1). Export the rows the brief reads and
compose it with the CRM's own module — it is deterministic and the same
code the Foundation tab's button uses:

```sql
select json_build_object(
  'client', (select row_to_json(c) from (select id, name, dba, vertical, business_type, phone, city, state, address_line1, service_area, website_url, drive_folders from clients where id = '<client_id>') c),
  'site', (select row_to_json(s) from (select id, url, stack, controlled_by_compass, repo_url, branch, preview_branch, vercel_project, staging_url, domain_constant, work_mode, content_paths, content_adapter, foundation_version, foundation_sha from sites where client_id = '<client_id>' order by created_at limit 1) s),
  'release', (select row_to_json(r) from (select version, source_repo, source_sha, accepted_on, handoff_url as handoff_doc, documents from foundation_releases where is_current) r),
  'services', (select coalesce(json_agg(json_build_object('id', s.id, 'name', s.name, 'segment', s.segment, 'page_type', s.page_type, 'status', s.status, 'page_url', s.page_url, 'parent_name', p.name) order by s.sort_order), '[]') from services s left join services p on p.id = s.parent_service_id where s.client_id = '<client_id>'),
  'pageGroups', (select coalesce(json_agg(json_build_object('id', g.id, 'name', g.name, 'page_type', g.page_type, 'target_url', g.target_url, 'city_tier', g.city_tier, 'status', g.status, 'primary_keyword', k.keyword, 'primary_volume', k.volume)), '[]') from page_groups g left join keywords k on k.id = g.primary_keyword_id where g.client_id = '<client_id>'),
  'claims', (select coalesce(json_agg(json_build_object('claim', claim, 'status', status, 'source', source)), '[]') from claims where client_id = '<client_id>'),
  'locations', (select coalesce(json_agg(json_build_object('name', name, 'city', city, 'state', state, 'is_physical_location', is_physical_location)), '[]') from locations where client_id = '<client_id>'),
  'brand', (select row_to_json(b) from (select cb.tagline, cb.positioning, bb.standing_cta, coalesce(bb.hard_rules, '{}') as hard_rules, coalesce(bb.palette, '[]'::jsonb) as palette, bb.typography, bb.status as board_status, bb.drive_doc_url from client_brands cb left join brand_boards bb on bb.client_id = cb.client_id where cb.client_id = '<client_id>' order by bb.version desc nulls last limit 1) b),
  'assets', (select coalesce(json_agg(json_build_object('kind', kind, 'label', label, 'url', url, 'width', width, 'height', height, 'is_primary', is_primary)), '[]') from brand_assets where client_id = '<client_id>')
) as input;
```

Save it as `/tmp/brief-input.json`, add `"generatedBy": "worker <run date>"`
and, for an existing repo, `"tree": [...]` = the `path`s from `site-push
{"client_id": "…", "read": true, "paths": []}` (paths only, no contents). For
a Foundation tree the client's brand is **never guessed**: it must be
recorded on `sites.content_paths.brand`, exist as `brands/<brand>/` in the
tree, not be a fictional demonstration brand (`harbor-lane`) and be
registered in `brands/registry.ts` (read that file with `paths:
["brands/registry.ts"]`). Otherwise the brief lists the specific missing
input and the contract is **not writable** — record the brand on the site
row (a new build records the brand it creates) before any change. Plus
`"cityEvidence": {"<city group name>": {"coverage_confirmed": true|false,
"distinctive_evidence": ["<sourced, city-specific fact with its source>"]}}`
for every `city` page group — `coverage_confirmed` only when
`clients.service_area` or a sourced claim names the city; evidence only from
`claims` (`sourced`) or the site's own copy. Then:

```bash
node --no-warnings scripts/build-brief.mjs /tmp/brief-input.json > /tmp/brief.json
node --no-warnings scripts/build-brief.mjs /tmp/brief-input.json --markdown > /tmp/brief.md
```

Store it — `update sites set build_brief = '<brief.json>'::jsonb,
build_brief_at = now(), content_adapter = '<brief.content_adapter.key>',
foundation_version = <brief.framework.foundation_version or null>,
foundation_sha = <… or null> where client_id = …` — write `Build Brief —
<Client>` to Drive `04 Website` from `brief.md` (update the existing doc
when one is recorded), and record it: `deliverables (client_id,
client_stage_id, label, url, type) = ('Build Brief', …, 'drive')`. Read
`missing_inputs`: each one is either something you can fill from the CRM
now, a `placeholders` row, or a line in the client request. **Never fill a
missing input with an invented fact.** Close PB4b.1.

**2. The source.** GitHub is unreachable from this session (see *GitHub —
you cannot reach it*); the CRM fetches the pinned Foundation for you. This
is a curl with the two credentials from the preflight (a binary answer;
`net.http_post` cannot carry it):

```bash
curl -sS -X POST https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/site-push \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "x-cron-secret: $CRON" \
  -H "Content-Type: application/json" \
  --data '{"client_id": "<client_id>", "archive": {"repo": "<release.source_repo>", "ref": "<release.source_sha>"}}' \
  -o /tmp/foundation.tar.gz
mkdir -p /tmp/site && tar -xzf /tmp/foundation.tar.gz -C /tmp/site --strip-components=1
```

The function serves only the current release (or the client's own repo).
A non-200 answer is the specific blocker (`error` in the body — the token
missing, the release row missing, GitHub refusing): set the stage
*Blocked* with that text in `next_action`. **Do not fall back to
`templates/astro-site/`, and do not build from any other commit.** Record
`release.version` / `source_sha` in the evidence.

For `upgrade_existing`, also read the client's repository itself (`site-push
{read: true}` gives text files inline; binaries as paths + sizes) into
`/tmp/client-site/` — that is what you change; the Foundation tarball is the
reference you adopt from, never a replacement for the client's tree.

**3. Build the brand layer** (`new_build`; PB4b.2–PB4b.6). In `/tmp/site`
follow `docs/starter-checklist.md` of the Foundation: copy
`brands/harbor-lane` to `brands/<brand>` (brand = the repo slug), register
it in `brands/registry.ts` with `fictional: false`, and replace **every**
Harbor Lane value — it is a fictional demonstration and none of its facts,
copy, images or routes may survive. The mapping from the CRM:

- `site.config.ts` — `clients` (name, phone, city / state, `service_area`),
  `business_type` (`storefront` → address public; `service_area` → no
  street address), `sameAs` from the sourced GBP / social claims, `careers:
  null`, `metadata` from the brand tagline / positioning.
- `theme.css`, `fonts.ts`, `theme.config.ts` — `brand_boards.palette` →
  the semantic roles (`primary`, `accent`, `surface`, `ink`), `typography`
  → fonts, motion and decoration off unless the board asks for them.
- `inquiry.config.ts` — `forceMock: false`, recipients from the client
  record's contact, sender left to the environment (`INQUIRY_FROM`); the
  form is mocked in every preview (`INQUIRY_DELIVERY=mock`). No recipient
  or secret goes into the brief or the evidence.
- `content/*` — home, about, services (one hub per hub service, a child
  page per approved service with a page group), the service-area hub, the
  contact page; `claims` where `status = 'sourced'` **only**; every service
  page's primary keyword in its title / H1 / description from the page
  group; `relatedServices` between hubs and children; a `<Placeholder>`
  labelled block for each missing photo / fact (mirrored as
  `placeholders` rows), never an invented one.
- **City pages** (PB4b.5): only the page groups the brief marks `planned`
  (coverage confirmed + distinctive local material). A `candidate` city is
  plain text in the service-area hub, not a route. Physical locations only
  for `locations` rows with `is_physical_location = true`. Never generate
  service × city pages.
- `redirects.ts` — the old site's useful URLs when we replace one
  (Polish writes the full map).

Keep the framework untouched: components, `lib/`, `app/` routes and the QA
scripts are the Foundation's; a change there is a Foundation change, not a
client build.

**3b. Upgrade an existing site** (`upgrade_existing`). Work in
`/tmp/client-site/`. The brief's `content_adapter` says what the tree is
(`src/lib/content-adapters.ts`); the page plan says what is `exists`,
`planned`, `candidate` or `proposed`. Adopt in **small batches** from the
Foundation reference — motion safeguards, metadata / canonical helpers,
sitemap and route registry, city and location page structure, inquiry
retry contract — only where the client's stack is compatible, and record
in the evidence which modules were adopted and which stayed site-specific.
Preserve identity, working forms, useful URLs and integrations. A
wholesale rebuild is a separate decision for Tom, not this stage.

**4. Verify with the Foundation's own checks** (both modes; the old
`site-quality-gate.mjs` is for auditing non-Foundation sites only). One
script from the CRM checkout runs the recipe in order — install, the
**brand-specific** typecheck, the build, the manifest, the provider suite,
then the shared mock provider service is started **first** and the same
`INQUIRY_MOCK_PROVIDER_URL` is handed to both the running site and the form
suite, the crawl, the browser launcher check, the mocked forms suite and
the browser suite on the brand's representative routes:

```bash
bash scripts/foundation-verify.sh /tmp/site <brand> <production host> /tmp/verify.json 3450 "/,<service hub>,<service detail>,<city page>,/contact"
```

It writes `/tmp/verify.json` = `{pass: [...], fail: [...], deferred: [{name,
detail}], ok}` and exits non-zero when any check **fails**. Without a
Chromium (`scripts/qa/browser-launch.mjs --check` fails) the forms and
browser suites are recorded as **deferred** with the reason — never as
passed, and a deferred check is never acceptance: the brief carries it as
deferred until someone runs it where a browser exists. Delivery is mocked
in every step; nothing is sent. A failed check is yours to fix, up to three
rounds; still failing → *Blocked* with `fail` in `next_action`. For an
`upgrade_existing` tree that has not adopted the QA scripts, run its own
`npm run build` plus the Foundation's crawl against the preview URL and
record everything else as deferred.

The `pass` / `fail` / `deferred` arrays become the `checks` of step 6
verbatim.

**5. Push through the CRM** — one call, the mode decides the branch:

- `new_build`: `{"client_id", "message": "Foundation v1 build (Compass CRM)",
  "brand": "<brand>", "files": [...]}` — no `branch`. site-push lands it on
  the branch of record (a new repo: `main`), creates the Vercel project with
  `COMPASS_BRAND` set and starts the production deployment that is the
  staging site. If the response's `note` says the branch of record already
  carried someone else's site, the build sits on `compass/foundation-build`
  as a preview and Launch will wait on Tom.
- `upgrade_existing`: `{"client_id", "preview": true, "message": "…",
  "files": [<only the files you changed>], "pull_request": {"title":
  "<Client>: <what>", "body": "<the brief's acceptance checks with results, the preview URL, what was adopted>"}}`.
  site-push creates `compass/preview-<date>-<slug>` **from the recorded
  production branch**, opens the PR against it and deploys a preview.
  `branch_of_record` in the response must equal `sites.branch`; if the
  function refuses (409), the site row's work mode or branch is wrong —
  fix the row, do not force anything.

Payload shape as before (text files as `content`, binaries base64); never
`node_modules/`, `.next/`, `.git/`. Do not print the secrets.

**A `new_build` push is the WHOLE TREE, not the brand layer.** Every file
under `/tmp/site` except `node_modules/`, `.next/`, `.git/` — the framework
(`app/`, `lib/`, `components/`, `brands/registry.ts`, `package.json`,
`package-lock.json`, `next.config.ts`, `tsconfig.json`, `scripts/`) as well
as `brands/<brand>/` and `public/`. A repository holding only
`brands/<brand>/` has no framework: Vercel answers `NEXT_NO_VERSION` ("No
Next.js version detected") and nothing builds. That is what a 30-file push
did on Sept 20 2026. One push of ~250 files is one tree request and is well
within the limits — do not "optimise" it into batches.

**Verify the deployment before you record it** (both modes). The push
response's `vercel` block now carries `ready_state` and, when the build
failed, `error_message`. `site-push` also answers a read-only status call:

```bash
curl -sS -X POST https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/site-push \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "x-cron-secret: $CRON" \
  -H "Content-Type: application/json" \
  --data '{"client_id": "<client_id>", "deployment_status": "<vercel.deployment_url or deployment id>"}'
# { ready_state, target, error_message, error_code, url }
```

Rules, and they are not negotiable:

- `ready_state` `ERROR` → the stage is **blocked** with `error_message` in
  `next_action`. Never complete it.
- `ready_state` still `BUILDING` / `QUEUED` after the status call → record
  the deployment as **deferred** in the checks (with the id), say so in the
  evidence, and leave the stage `in_progress` for the next run to confirm.
  A deployment you have not seen reach `READY` is never "the preview is up".
- `vercel.status` `blocked` → the Vercel project has no deployment yet, so a
  preview cannot be made: Vercel promotes a project's first deployment to
  production whatever the branch. **Pushing again does not help** — the next
  deployment would still be the project's first. The commit is on the preview
  branch and is fine; record the deployment as *deferred* with the blocked
  detail, put that detail in `next_action`, and leave the stage for Tom. For a
  fictional or demonstration brand a preview is never available, because it
  may never have a production deployment: verify it from the local build.
- `target` must be `preview` for any preview push. A `production` target on
  a preview push is a failure, not a result — site-push reports it as one.
- Deployment protection (a Vercel login) may stop you fetching the preview
  URL. That is not verification either way: the status call is.

**6. Attach the outcome.** Fold the push response and `/tmp/verify.json`
into the brief and record them. Write `/tmp/outcome.json` (each `pass`
entry → `{"name", "result": "pass"}`, each `fail` → `"fail"`, each
`deferred` → `"deferred"` with its `detail`):

```json
{"branch": "<response.branch>", "base": "<response.branch_of_record>",
 "commit_url": "<…>", "pull_request_url": "<… or null>",
 "deployment_url": "<vercel.deployment_url or staging_url, or null>",
 "checks": [{"name": "typecheck", "result": "pass"}, {"name": "build", "result": "pass"},
            {"name": "manifest", "result": "pass"}, {"name": "crawl", "result": "pass"},
            {"name": "forms (mocked)", "result": "deferred", "detail": "no Chromium"},
            {"name": "browser", "result": "deferred", "detail": "no Chromium"}]}
```

then `node --no-warnings scripts/build-brief.mjs /tmp/brief-input.json
--attach /tmp/outcome.json > /tmp/attached.json`. `attached.brief` →
`update sites set build_brief = …, preview_branch = <branch when a preview>,
staging_url = <deployment url when new_build>`; `attached.evidence_line` →
appended to the stage evidence; `attached.deliverables` → one
`deliverables` row each (`type = 'site'`); `attached.change_log` → one
`change_log` row; `attached.decision` → one `decisions` row (`decided_by =
'worker'`). Refresh the Drive brief doc. Every result is
**builder-reported**; write "independent review pending" in the evidence,
not "verified".

Close PB4b.1–PB4b.7 for what you actually did (the Vercel item only when
`vercel.status` is `created` / `deployed`), set the stage `complete`, and
put the release SHA, the branch of record, the preview branch or staging
URL, the PR URL, the check results (pass / fail / deferred) and the
placeholder count in the evidence. Do not touch Polish or Launch.

### Website — Polish & client review

The bones are live on staging; this stage makes them presentable and
ready to launch. You cannot clone the repo; **read it back through the
CRM** and push back only what you changed.

**1. Read the site.**

```bash
curl -sS -X POST https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/site-push \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "x-cron-secret: $CRON" \
  -H "Content-Type: application/json" --data '{"client_id": "<client_id>", "read": true}' > /tmp/site-read.json
```

`files[]` carries every text file with `content` (binaries are listed with
`size` only). Write them to `/tmp/site/<path>`; `npm install` there. That
is your working copy. Pass `"branch": "<sites.preview_branch>"` when the
build sits on a preview branch (`compass/foundation-build`, or an
`upgrade_existing` preview): you polish that branch and push back to it
with the same `branch` (and `pull_request` for an upgrade); Launch waits
until Tom merges it into the branch of record.

**2. The punch list** is three things, in this order:

- **Audit findings** — the open tasks on this stage with `key is null`
  (the SEO audit filed them; each `notes` carries the URL and the
  `after`). Apply each one to `src/config/site.ts` or the page it names —
  titles, metas, H1s, FAQ answers, missing city / service pages (add the
  page group's entry to `services[]` / `cities[]`), internal links,
  schema fields. Close each task you applied with `notes` = `applied:
  <what>`; leave one you cannot apply open with `notes` = `needs: <what>`.
- **Material** — the client's Drive `Media` folder
  (`clients.drive_folders->>'Media'`; `mcp__Google_Drive__search_files`
  with `'<id>' in parents`, images only) and `client_requests.responses`.
  For each image ≤ 4 MB: download (`download_file_content`), save as
  `public/images/<slug>.<ext>` (slug from the file name; keep JPEG / PNG /
  WebP as they are), and wire it: hero → `about.image` or the home hero
  slot, a service photo → that service's `image`, a city photo → that
  city's, anything else → the gallery if the site has one. Every `<img>`
  gets a real `alt`. Then mark the matching `placeholders` row
  `resolved = true, resolved_at = now()`. No material → nothing changes;
  say so.
- **Placeholders still open** — leave the `<Placeholder>` blocks (the
  gate counts them, never fails them) and leave their rows unresolved;
  they are the client request. Do not invent a photo, a testimonial, a
  licence or a project.

**3. Redirect map** (`redirect_map`), only when the client has an old site
we are replacing (`sites.controlled_by_compass = true` and `sites.url` is
not the staging URL): `WebFetch` the old site's `/sitemap.xml` (follow an
index; fall back to the audit's inventory), map every old path to the new
route by slug and title (`/roofing-services` → `/services/roofing/`,
`/about-us` → `/about/`, blog posts → the closest service or `/`), and
write `vercel.json` at the repo root:

```json
{ "redirects": [ { "source": "/old-path", "destination": "/services/roofing/", "permanent": true } ] }
```

One line per old URL; `/` and paths that already exist need none. Keep
the map in `docs/redirects.md` too, with a reason per line. No old site →
close the task with "no old URL set".

**4. Build, check, push.** The Foundation's checks from Build step 4
(typecheck, build, manifest, crawl; forms and browser when a Chromium
exists, else deferred) must pass again; a non-Foundation site (an
`upgrade_existing` tree that has not adopted the QA scripts) gets its own
build plus the crawl run against the preview URL. Store the results on
`sites.build_brief` through `--attach` as at Build. Push **only the files
you changed or added** (the same payload shape and branch as Build;
`site-push` leaves the rest as it is), `message` = `Polish: <n> findings
applied, <n> images placed`. Images go as `encoding: "base64"`.

**5. Lighthouse** (`lighthouse_pass`). Two minutes after the push,
`mcp__Data_for_SEO__on_page_lighthouse` on the staging home page and one
service page, `enable_javascript = true` (mobile is the default): record
performance, accessibility, best-practices and SEO. Store them:
`update sites set quality = quality || jsonb_build_object('lighthouse',
'<json>'::jsonb)`. Performance < 90 → the usual causes are oversized
images (resize to ≤ 1600 px wide, quality 80, with `sharp` from the
site's `node_modules` if present, else `python3 -c "from PIL import
Image…"`) and render-blocking fonts; fix, rebuild, push again, once.
SEO < 100 → fix what it names. Close the task when the home page is
≥ 90 / ≥ 90 / ≥ 90 / 100; otherwise leave it open with the four numbers
in `notes` and move on — a client photo can drag performance and that is
Tom's call.

**Close.** `punch_list` closes `flagged_for_review = true`,
`recommendation` = `n findings applied, n images placed, n placeholders
still open, n deferred (needs material)`. `redirect_map` and
`lighthouse_pass` as above. `client_review` is Tom's: `notes` = the
staging URL, what changed, what is still a placeholder. Stage `complete`
when your own tasks are done — client review is a to-do, not a gate on
this stage; it gates **Launch**. Feedback comes back as new tasks Tom adds
to this stage before setting it to *Not started*, which fires you again;
a reopened Polish repeats steps 1–5 on the new tasks.

### Website — Launch

Runs only when Polish is `complete` **and** its `client_review` task is
`done` (see *Find work*). The site is on `sites.staging_url`; the
production host is `sites.domain_constant`, else the host of
`clients.website_url`, else *Blocked*: "No production domain recorded —
set it on the Overview tab (website URL)".

**Preview branch → blocked.** When the build lives on a preview branch
(`sites.preview_branch` set and the site's open pull request not merged —
`compass/foundation-build`, or an `upgrade_existing` preview), the branch
of record still serves the previous site. Set the stage `blocked`,
`next_action` = "Merge <preview branch> into <branch of record> (the pull
request), then set Launch to Not started", open the WAITING task, stop.
Launch never merges a pull request and never relabels the branch of record.

**1. Domain** (`domain_added`):

```bash
curl -sS -X POST https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/site-push \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "x-cron-secret: $CRON" \
  -H "Content-Type: application/json" --data '{"client_id": "<client_id>", "domain": "<host>"}'
```

It adds the host and its www / apex twin (as a 308 to the primary) to the
Vercel project and answers `status` (`verified` | `pending`) plus `dns[]`
— the exact records: an A record `@ → 76.76.21.21` for the apex, a CNAME
`www → cname.vercel-dns.com`, and any TXT Vercel asks for. Close
`domain_added`. Write the records into the `dns_records` task's `notes`
(Tom's), one per line, with "at the registrar for <apex>" and the note
that the old host stops serving the moment these change. If `status` is
already `verified` (Tom did it earlier), go straight on.

**2. Verified** (`dns_verified`). `status = pending` → leave the task open,
leave the stage `in_progress`, put "waiting on DNS records" in the
evidence, **stop**. Tom closing `dns_records` fires you; the daily sweep
also finds an `in_progress` Launch once the 3-hour lock has passed and
re-checks. `status = verified` → `curl -sSI https://<host>/` must be 200
and the page must carry our canonical (`<link rel="canonical"
href="https://<host>/"`) — that is the new site, not the old one served
from a cache. Close `dns_verified`. Then, if the site's config `url` is
still the vercel.app address, set `url` in `src/config/site.ts` to
`https://<host>` and push that one file (Build sets it when the domain
was known; Polish may have fixed it already).

**3. Redirects** (`redirects_verified`). For each `source` in
`vercel.json` (read it back with `{"read": true}`): `curl -sSI
https://<host><source>` → 301 / 308 with a `location` on the same host,
and that location → 200. Every miss goes in `notes`; all good → close.
No `vercel.json` → close with "no old URL set".

**4. Sitemap** (`sitemap_submitted`):

```bash
curl -sS -X POST https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/gsc-sync \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "x-cron-secret: $CRON" \
  -H "Content-Type: application/json" \
  --data '{"client_id": "<client_id>", "submit_sitemap": "https://<host>/sitemap-index.xml"}'
```

200 → close. 404 (no Search Console property) → leave open with
`notes` "needs the Search Console property — Tracking Setup › gsc_verify".

**5. Launched** (`launched`). `update sites set url = 'https://<host>/',
launched_at = current_date where client_id = …`; `update clients set
launched_at = current_date where id = … and launched_at is null`. Write
`Site Plan — <Client>` to Drive `04 Website`: the page list with each
page's primary keyword, the redirect map, placeholders still open, the
tracking state (Search Console, GA4, BrightLocal from the Tracking Setup
tasks), the staging and production URLs, the Lighthouse numbers.
`deliverables` = `('Site Plan', …, 'drive')`. Close `launched`. Stage
`complete` → the Website pipeline completes, the CRM raises `Review
Website`, and with SEO complete the client converges to `active` and
Reporting begins on the 1st.

### SEO — Audit & Adjust (PB4a)

Runs only when Foundation is `complete` and the SEO enrollment is `active`.
The audit measures the **site the client has today** against the approved
taxonomy and keyword map, and writes a fix list the rest of the SEO pipeline
and Tom's blend work start from. It is read-only on the site: nothing here
edits a page.

**Target.** `sites.url` for the client's site row, else
`clients.website_url`. A client with neither but a `sites.staging_url` (the
bones you built) is audited on staging and the evidence says so. None of the
three → *Blocked*: `next_action` "No live site or staging URL to audit;
record the site on the Website tab".

**Budget.** DataForSEO is metered. Per client: at most 40 `on_page_instant_pages`
calls, 2 `on_page_lighthouse` calls, 10 `serp_organic_live_advanced` calls,
one `dataforseo_labs_google_ranked_keywords`, one `backlinks_summary`, one
`backlinks_referring_domains`, one `backlinks_anchors`, one
`business_data_business_listings_search`. Nothing on BrightLocal.

**1. On-page (PB4a.1).** Inventory the site: `WebFetch` `/sitemap.xml`
(follow a sitemap index) and take every URL on the site's host, up to 40,
home and service / area pages first; no sitemap → home plus everything
linked from its nav and footer. For each page call
`mcp__Data_for_SEO__on_page_instant_pages` and record `url`, `status_code`,
`title`, `meta description`, `h1` (count and text), `canonical`, `word
count`, `schema types`, image count without alt, internal link count. Then
map the **page groups**: for every `page_groups` row (home / service / city /
hub) with `status = 'approved'`, find the page that serves it (by
`target_url`, then by slug or title match) and check that its
`primary_keyword` appears in the title, the H1 and the meta description.
Record, per group: `served_by` (URL or null), `keyword_in_title`, `_in_h1`,
`_in_meta`. Fill `page_groups.target_url` where it was null and you found
the page. A group with no page is a **missing page** finding; two groups
served by the same page is a **cannibalisation** finding; a page whose title
or H1 carries none of the client's keywords is an **untargeted page**
finding. Pull what the domain ranks for with
`dataforseo_labs_google_ranked_keywords` (`target` = bare host,
`location_name = 'United States'`, `limit = 100`) and, for each money
keyword (`keywords.is_money`), the live position from
`serp_organic_live_advanced` at the client's city location
(`"<City>,<State>,United States"`, `depth = 20`): position, ranking URL,
and the three domains above it. These positions go in the report, not in
`rank_snapshots` (that table is BrightLocal's).

**2. Technical (PB4a.2).** `on_page_lighthouse` on the home page and the
strongest service page, `enable_javascript = true`: performance,
accessibility, best-practices and SEO scores, LCP, CLS. Then check by
`WebFetch` / `curl -sI`: `http://` → `https://` redirect, `www` / apex
consistency (one 301 to the other), `/robots.txt` present and not blocking
`/`, a sitemap referenced from it, a real 404 (`/compass-404-probe` returns
404, not 200), a viewport meta on every page, mixed content on the home
page. Then **run the quality gate on a mirror of the live site**, so the
audit scores the client's site the same way the build was scored: from the
CRM checkout,

```bash
mkdir -p /tmp/audit/dist
# for each inventoried URL, path /a/b/ → /tmp/audit/dist/a/b/index.html
curl -sL --max-time 20 "<url>" -o "/tmp/audit/dist/<path>/index.html"
curl -sL --max-time 20 "<origin>/llms.txt" -o /tmp/audit/dist/llms.txt
node scripts/site-quality-gate.mjs /tmp/audit/dist --phone "<phone>" --name "<business name>" --json > /tmp/audit/gate.json
```

A site that was not built from the Compass starter will fail some checks
(no facts block, no FAQPage, no `llms.txt`); those are findings, not
errors. Read `gate.json`: every entry in `failures` and `warnings` is a
finding with its route.

**3. Off-page (PB4a.3).** `backlinks_summary` (bare host): referring
domains, backlinks, rank, broken pages, spam score.
`backlinks_referring_domains` (`limit = 20`, ordered by rank desc) and
`backlinks_anchors` (`limit = 20`) for the profile's shape: brand vs
money-anchor share, toxic-looking domains. Citation state:
`business_data_business_listings_search` with `title` = the client name and
`location_coordinate` = the home city as `"<lat>,<lng>,25"` (lat / lng from
the client's `locations` row, else the city's entry in
`src/data/us-cities.json` — rows are `[city, state, lat, lng, population]`),
`is_claimed` unset — record the GBP name, primary category, phone, address, rating,
review count, and whether it is claimed. Compare the NAP with the CRM
(`clients.phone`, `city`, `state`, `website_url`): each mismatch is a
finding. `WebSearch` `"<name>" "<phone>"` and `"<name>" <city> reviews` to
spot the top directory listings (Yelp, BBB, Facebook, Angi, Houzz,
Nextdoor, industry directories) and note which carry a different phone,
name or URL. This is a read; the citation build itself is stage 3.

**4. Fix list and report (PB4a.4).** Every finding is one row in
`change_log`:

```sql
insert into change_log (client_id, change_type, object_type, object_id, before, after, reasoning, evidence, status)
values ('<client_id>', '<title|meta|h1|canonical|schema|redirect|robots|sitemap|content|internal_link|missing_page|cannibalisation|speed|nap|backlink>',
        '<page|page_group|site|listing>', <page_group id or null>,
        '<jsonb: what is there now>', '<jsonb: what it should be>',
        '<one sentence: why, citing the keyword map or the gate check>',
        '<url or listing name>', 'proposed');
```

`before` / `after` are small objects (`{"title": "..."}`); for a missing
page `after` carries the page group and its primary keyword. Severity goes
in `after` as `"severity": "high" | "medium" | "low"` — high: a money
keyword with no page, a broken redirect chain, `noindex` or a blocked
robots, a NAP mismatch on the GBP; medium: titles / H1s / metas off the
keyword map, missing schema, thin pages under 300 words, no sitemap;
low: everything else the gate warns about.

Write `SEO Audit — <Client>` to Drive `04 Website` (Markdown → Google Doc):
scores (gate SEO / AEO / GEO and Lighthouse), the page inventory table, the
page-group map (group → page → keyword in title / H1 / meta), money keyword
positions, off-page summary, then the fix list grouped by severity with the
`after` for each. Record it: `insert into deliverables (client_id,
client_stage_id, label, url, type) values (…, 'SEO Audit', '<webViewLink>',
'drive')`. Store the report on the site row:

```sql
update sites set audit = '<json>'::jsonb, audit_checked_at = now() where client_id = '<client_id>';
```

with `audit` = `{"target": "<url>", "gate": <gate.json>, "lighthouse":
{"home": {...}, "service": {...}}, "pages": <n inventoried>, "page_groups":
{"total": n, "served": n, "missing": n}, "findings": {"high": n, "medium":
n, "low": n}, "backlinks": {"referring_domains": n, "backlinks": n,
"spam_score": n}, "gbp": {"found": bool, "claimed": bool, "rating": n,
"reviews": n, "nap_mismatches": n}, "report_url": "<doc url>"}`.

**5. Adjust (PB4a.5, run+flag).** Apply what lives in the CRM: fill
`page_groups.target_url`, correct a `keywords.city` that the site's page
proves wrong, add a `claims` row (`status = 'sourced'`) for a licence or
award the site states with a source. Mark those `change_log` rows
`approved` with `reviewed_by = 'worker'`, `reviewed_on = now()`. The site
itself you do not edit: on a site Compass controls (`sites.controlled_by_compass`)
add each high and medium finding as a task on the Website › **Polish &
client review** stage (`owner = 'CLAUDE'`, `status = 'open'`, title = the
fix, `notes` = the URL and the `after`), so it is applied when that stage
runs; on a site Compass does not control, the fix list is the deliverable
and Tom blends it into the site himself. Then set the PB4a.5 task
`flagged_for_review = true`, `recommendation` = one line: how many fixes
were applied in the CRM, how many went on the punch list, how many wait on
the live site — and close it.

Close `seo_onpage`, `seo_technical`, `seo_offpage`, `seo_fix_list`,
`seo_fixes` by key. Set the stage `complete`; evidence carries the target
URL, the gate scores and Lighthouse scores, pages inventoried, page groups
served / missing, findings by severity, the report URL. Do not touch GBP
Setup or anything after it; the SEO pipeline stays open, so no `Review SEO`
task is raised yet — Tom reads the audit from the Foundation tab and the
Drive doc.

### SEO — GBP Setup & Optimisation

You have no Business Profile login. This stage produces the **spec** Tom
applies, drafted from the taxonomy and the brand, checked against the
listing as it is today; applying it is Tom's task. Read: approved
`services` (name, segment, description), `client_brands` (positioning,
story, voice, words we use / avoid), `brand_boards` (cta, hard_rules),
`claims` with `status = 'sourced'`, `page_groups` of type `city` with
`city_tier`, `sites.audit->'gbp'` from the audit, and the FAQs you wrote
into the site (`sites.url` or staging) if any.

**Categories.** `business_data_business_listings_search` with `categories`
= [the vertical's head term], `location_coordinate` = home city
`"<lat>,<lng>,30"`, `limit = 20`, ordered by `rating.votes_count,desc`:
the primary categories of the top 10 competitors and their additional
categories. Primary = the category that fits the taxonomy and is most
common among them; secondaries = up to 5 others the approved services
justify. One call.

**Spec.** `GBP Spec — <Client>` to Drive `04 Website`, in this order:

1. Business name exactly as the CRM has it — no keywords added (a hard
   rule; Google suspends for it).
2. Primary + secondary categories, with the competitor count behind each.
3. Description ≤ 750 characters from the positioning line and story: what
   they do, where, since when (sourced claims only), the standing CTA.
4. Services: one per approved service, name ≤ 60 characters, description
   ≤ 300, in the brand voice.
5. Service area: the tier 1 and 2 cities from the page groups, plus the
   counties in `clients.service_area`; for a storefront the address stays
   visible, for a service-area business it is hidden.
6. Attributes to switch on (from the vertical: licensed, free estimates,
   veteran-owned … only when a sourced claim backs it).
7. Hours as the listing shows them today, marked "confirm".
8. Booking / quote link = the site's CTA URL.
9. Q&A seeds: 5 questions a customer asks, answered in ≤ 60 words.
10. Photo shot list: 10 shots (exterior, team, 3 jobs, 3 process, 2
    before/after) — placeholders are fine; Tom shoots.
11. **What is wrong today:** each field where the live listing (audit `gbp`
    + the listing search) differs from the spec.

**Posts.** Four posts for the first month, in the brand voice, each ≤ 1,500
characters with a CTA: a "what we do" post, a service spotlight, a city
spotlight, an offer or seasonal post. Same doc, last section.

Record the doc as `deliverables (client_id, client_stage_id, label, url,
type)` = `('GBP Spec', …, 'drive')`. Close `gbp_spec`; close
`gbp_posts_drafted` with `flagged_for_review = true` and a one-line
`recommendation`.

**Apply it** (`gbp_apply`). Store the spec as JSON and let the CRM write
it to the profile:

```bash
curl -sS -X POST https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/google-ops \
  -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "x-cron-secret: $CRON" \
  -H "Content-Type: application/json" --data @spec.json
```

with `spec.json` = `{"client_id": "…", "op": "gbp_apply", "spec": {
"primary_category": "<display name>", "secondary_categories": [...],
"description": "<≤750 chars>", "services": [{"name", "description"}],
"website": "<url>", "hours": [{"day": "monday", "open": "08:00", "close":
"17:00"}], "hours_confirmed": false}}`. `hours_confirmed` stays `false`
unless the listing already showed hours you copied verbatim — the
function only writes hours when it is `true`. Then `{"op": "gbp_qa",
"qa": [{"q", "a"}]}` with the five Q&A seeds. The function never touches
the business name. **Do not publish the four posts** — never call
`gbp_posts` (Ground rules). They stay drafted in the GBP Spec doc, and
`gbp_posts_drafted` stays closed with `flagged_for_review = true` so a
person reviews them; publishing waits for the approval gate. `done` on
`gbp_apply` → close the task `flagged_for_review = true`,
`recommendation` = what was applied and what it could not resolve
(`unresolved`), and note the Q&A result in the evidence, with "posts
drafted for review, not published". `skipped` or `failed` (no access to the
profile yet, no token) → set `gbp_apply.owner = 'TOM'` with the detail
and the doc link in `notes`; the `google_access` task on Foundation is
the fix. `gbp_photos` is always Tom's (someone has to shoot them): put
the shot list link in its `notes`. Stage `complete`; evidence:
categories chosen, services count, mismatches found, what was applied,
doc URL.

### SEO — Local Citations

**List.** Build the directory list for this client: the three aggregators
(Data Axle, Foursquare, Neustar Localeze), the general set (Bing Places,
Apple Business Connect, Yelp, Facebook, BBB, Nextdoor, Yellow Pages,
MapQuest, Manta, Superpages, Hotfrog, the local chamber of commerce), and
10–15 for the vertical and state (`WebSearch` `"<vertical>" directory
listing`, `best <vertical> directories`, plus what you know: Angi,
HomeAdvisor, Houzz, Thumbtack, Porch, BuildZoom for trades; EnergySage,
SolarReviews for solar; and so on). Tier each: 1 = aggregator or general
top-5, 2 = general, 3 = vertical / local.

**Sweep.** For each directory, `WebSearch` `site:<directory domain>
"<client name>"` (and the DBA), ≤ 30 searches; `WebFetch` a hit to read
the name, address, phone and website as listed. Canonical NAP is the CRM
(`clients.name`, `address_line1` / `city` / `state` / `zip` — omit the
street for a service-area business — `phone`, `website_url`). Status per
directory: `listed` (NAP matches), `mismatch` (say which field and the
exact value to change), `missing`, `unknown` (the directory cannot be
searched from outside). Fold in the audit's NAP mismatches.

**Sheet.** `Citation Sheet — <Client>` to Drive `04 Website`: the canonical
NAP block at the top (copy-paste ready, plus a 250-character and a
750-character description and the category list from the GBP spec), then
one table: directory, tier, status, listing URL, fix / submit note, login
needed. `deliverables` = `('Citation Sheet', …, 'drive')`. Close
`citation_list`, `nap_sweep`, `citation_sheet`. `citation_submit` is Tom's:
its `notes` get the sheet link, the counts (`n missing, n mismatched`), and
the line "BrightLocal Citation Builder can submit the aggregators and the
tier-1 set for a fee — Tom's call". Stage `complete`; evidence: listed /
mismatch / missing counts, doc URL.

### SEO — Backlink Foundation

**Prospects.** Bare host = `sites.url` or `clients.website_url`.
`backlinks_competitors` (`target` = host, `limit = 10`,
`exclude_large_domains = true`) gives the domains sharing the client's link
profile; add the top 3 organic domains for the top 3 money keywords from
the audit's positions (`serp_organic_live_advanced` at the client's city,
`depth = 10`, only if the audit did not store them; ≤ 3 calls). Keep the
5 most local / most relevant as competitors. `backlinks_domain_intersection`
(`targets` = those competitor hosts, `exclude_targets` = [client host],
`limit = 60`, `order_by = ["1.rank,desc"]`) is the **link gap**: domains
linking to competitors and not to the client. Drop platforms (social,
big directories already in the citation sheet) and anything with a spam
score above 30. Classify what is left: `directory`, `local news`,
`association / chamber`, `supplier / partner`, `blog / resource`,
`sponsorship`. Then local opportunities by `WebSearch` (≤ 8):
`<city> chamber of commerce`, `<county> business association`,
`<vertical> association <state>`, `<city> youth sports sponsorship`,
`<city> nonprofit sponsors`, `<city> news business feature`. Aim for 25–40
prospects with a why and a how for each.

**Disavow candidates.** `backlinks_referring_domains` (`target` = client
host, `limit = 100`, `order_by = ["backlink_spam_score,desc"]`): domains
with spam score ≥ 60 or an obvious PBN / foreign-language / gambling
pattern. List them; do not act — a disavow is Tom's decision (the audit
may already have raised a task for it).

**Templates.** Three outreach emails in the brand voice (`client_brands`
voice, words we use / avoid): local sponsorship or partnership, supplier /
partner "we work with you" link, local press / resource pitch. ≤ 150 words
each, a subject line, one ask, from Tom's name, no fabricated facts.

**Doc.** `Backlink Prospects — <Client>` to Drive `04 Website`: prospects
table (domain, type, rank, why, how / contact, template number), the
disavow list with reasons, the three templates. `deliverables` =
`('Backlink Prospects', …, 'drive')`. **Drafts:** for every prospect with
a contact email you actually found (never a guessed address), `google-ops`
`{"op": "gmail_draft", "to", "subject", "text"}` with the matching
template filled in — Tom's name, the client's name, the specific reason
for this prospect; at most ten. Count what was drafted; a `skipped` /
`failed` answer means the drafts are in the doc only. **Baseline:** `backlinks_summary`
(one call) — referring domains and backlinks today, into the evidence,
and `update sites set audit = audit || jsonb_build_object('backlinks_baseline',
jsonb_build_object('referring_domains', n, 'backlinks', n, 'on', now()::date))`
so the monthly cycle counts from here. Close `backlink_prospects`,
`backlink_baseline`; close `outreach_drafts` flagged with a
`recommendation`; `outreach_send` (Tom) gets the doc link, the prospect
count and "n drafts waiting in Gmail" in `notes`. Stage `complete`.

### SEO — Tracking Setup (GSC, BrightLocal)

Nothing billable is created here. The CRM rows and the inputs are made
ready; the two BrightLocal reports and the Google verifications are Tom's.

**Locations, tracked list, grid** (`tracking_locations`). Ensure one
`locations` row for the home city: `name` = client name, `city`, `state`,
`lat` / `lng` (the client's `locations` row if any, else
`src/data/us-cities.json`), `is_physical_location` = `business_type =
'storefront'`, `gbp_place_id` from the audit's listing if it carried one,
`is_active = true`. Never delete or rename an existing location. Ensure
the tracked list is 50 keywords (`keywords.is_tracked`; Keyword Research
set it — top up from DataForSEO ideas for the approved services and
cities if short, then `normalize_tracked_keywords`). Ranks arrive every
Monday from `rank-sync`; fire it once now for this client
(`net.http_post` to `/functions/v1/rank-sync` with the cron headers and
body `{"client_id": "..."}`) so the first snapshots exist before
`first_sync` checks for them. Ensure
one `grid_configs` row for the home location if none exists: `center_lat`
/ `center_lng` = the location, `grid_size = 7`, `spacing_miles` = 1 for a
storefront, 2 for a service-area business, `keyword_ids` = the money
keywords (≤ 10), `is_active = true`. Existing grids are left as they are.

**Search Console** (`gsc_verify`). `clients.gsc_property` set and
`gsc_snapshots` has rows for the client → close it. Property set but no
rows → close it with a note ("property exists; Google has no data yet — the
monthly sync fills it"). Property null → set `owner = 'TOM'` and `notes`
with the steps: in Search Console (as the Compass Workspace account) add
a Domain property `sc-domain:<host>`, add the TXT record at the registrar,
verify, then on the Overview tab set the property; `gsc-sync` matches it
on the next run. Leave it open.

**GA4** (`ga4`). `google-ops` `{"op": "ga4_provision", "site_url":
"<https://host or the staging URL>"}` creates the property under the
Compass Analytics account, a web stream, and the `phone_click` /
`form_submit` key events, and stores `sites.ga4_measurement_id`. `done` →
read the site back (`site-push` `{read: true}`), set
`analytics.ga4MeasurementId` in `src/config/site.ts` to the measurement
id, push that one file (the layout emits the tag and fires both events
on its own), close `ga4` with the property and id in `notes`. `skipped`
(`GA4_ACCOUNT_ID` or the token missing) or `failed` → `owner = 'TOM'`,
detail in `notes`, leave open.

**BrightLocal** (`brightlocal_lrt`, `brightlocal_lsg`) are Tom's and
billable; give each `notes` with the exact inputs: the location (name,
city, GBP place id), the tracked list count and a Drive doc
`Tracked Keywords — <Client>` in `03 Keywords` (one keyword per line,
with city), the grid (center, size, spacing, the money keywords), and
"paste the report id on the Keywords tab (LRT) / the grid config (LSG)".

**First sync** (`first_sync`). Run the two read-only syncs for this
client and see what lands:

```bash
for fn in brightlocal-sync gsc-sync; do
  curl -sS -X POST https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/$fn \
    -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "x-cron-secret: $CRON" \
    -H "Content-Type: application/json" --data "{\"client_id\": \"<client_id>\"}"
done
```

Both answer 202 and finish in the background; wait two minutes, then count
`rank_snapshots` (via the client's keywords) and `gsc_snapshots` for the
client recorded in the last ten minutes. Rows landed → close `first_sync`
with the counts. Nothing landed (no BrightLocal reports yet, no GSC
property) → leave it open with a note saying which source is missing; it
closes on a later run once Tom's tasks are done. Stage `complete` either
way; evidence: location, tracked count, grid summary, GSC state, what the
first sync returned. This completes the SEO pipeline: the CRM raises
`Review SEO` for Tom and, once Website is complete too, converges the
client to `active` and enrolls Reporting.

### Reporting — Industry Pulse (PB6) and Monthly Refresh & Report (PB5)

Runs for an open `monthly_cycles` row (the CRM opens one per active client
on the 1st and fires you at 09:00 UTC, after the BrightLocal and GSC syncs;
a cycle started by hand on the Reports tab fires at once). The cycle's `period`
is its operational month: the cycle opened on Oct 1 normally reports September.
The scorecard ledger's `report_period` is the actual data month (September 1
in that example), and every measurement retains its actual start/end dates.
Everything below is **read from the CRM and DataForSEO** and
**written to the CRM and Drive**; nothing is sent to the client. Sending is
Tom's `report_send` task.

**Pulse first (PB6).** One `industry_pulse` row per `clients.vertical` per
period; it is unique on `(vertical, period)`, so insert it before doing
anything else and treat a unique violation as "another session did it,
read theirs":

```sql
insert into industry_pulse (vertical, period, rising_queries, serp_changes, competitor_moves, news_items, affected_client_ids)
values ('<vertical>', '<period>', '[]', '[]', '[]', '[]', array['<client_id>']::uuid[])
on conflict (vertical, period) do update set affected_client_ids = array(select distinct unnest(industry_pulse.affected_client_ids || excluded.affected_client_ids))
returning id, (xmax = 0) as inserted;
```

`inserted = true` → fill it in: `kw_data_google_trends_explore` with the
vertical's 3–5 head terms (`time_range = 'past_90_days'`, `location_name =
'United States'`, `item_types = ['google_trends_queries_list']`, one
keyword per call) for rising queries — Trends only takes a country, so
**filter the list**: drop any query naming a city, county or state outside
the client's state, and any brand that does not operate there (the Lucas
dry run returned "roofing contractors cleveland" and "roof replacement
nj"; neither belongs in a Missouri pulse). Keep what a Missouri roofer
would care about: product and material terms, cost and financing terms,
storm and season terms, "near me" phrasings. Fewer than five left → add
the top related queries from `dataforseo_labs_google_related_keywords`
for the head term at the client's city (one call); `serp_organic_live_advanced` on the
vertical's two head terms at the client's city for SERP feature changes (an
AI overview, a new local pack shape) and the domains newly in the top 5
(`competitor_moves`); `WebSearch` `"<vertical>" news <month year>` and
`content_analysis_search` (`keyword` = the vertical's head term,
`page_type = ['news']`, `limit = 10`) for `news_items` — each `{title, url,
date, why_it_matters}`. Update the row. `inserted = false` → use the row as
it is. Budget: ≤ 5 trends calls, ≤ 2 SERP calls, 1 content-analysis call
per vertical per period.

**Refresh (PB5).** Compare the report period with the one before it,
everything from the CRM first:

- **Ranks:** `rank_snapshots` joined to `keywords` (`is_tracked`) and
  `locations`, latest `recorded_at` in the period vs latest in the prior
  period, per `result_type`: keywords up / down / unchanged, top-3 and
  top-10 counts, the five biggest movers each way. `location_index` rows for
  the two periods give the City Index per location.
- **Grid:** `grid_snapshots` per `grid_configs` — `avg_map_rank` and
  `share_of_voice`, this period vs prior.
- **Search Console:** use verified property totals for the exact window. Existing
  `gsc_snapshots` contain query/page rows and actual `period_start`/`period_end`
  (normally a rolling 28-day export). Do not sum overlapping exports, label
  query/page totals as complete property totals without coverage evidence, or
  average averages. If totals cannot be verified, record them as not measured;
  query/page detail can remain in the appendix with its coverage limitation.
- **Alerts:** `alerts` triggered in the period, acknowledged or not.
- **Activity:** `content_posts` published in the period, `social_posts`
  with verified publication dates (social `scheduled_at` alone is not proof),
  GBP posts (count the `gbp_posts` task's notes if Tom recorded a verified number,
  else not measured), against `plans.gbp_posts_per_month` /
  `blog_posts_per_month` / `social_posts_per_month`.
- **Off-page:** `backlinks_timeseries_summary` (bare host, `date_from` = the
  first of the prior period, `group_range = 'month'`): referring domains and
  backlinks, this month vs last. One call.
- **GBP:** `business_data_business_listings_search` as in the audit — rating
  and review count now; the prior figure comes from the previous cycle's
  `summary.gbp`, if any.

A source with no data for the period is a line in the report ("No rank
snapshots this period — BrightLocal reports not set up"), never a blocker.
A client with nothing at all (no snapshots, no GSC, no activity) still gets
a report; it says so.

**Scorecard ledger first.** Follow `docs/client-scorecards.md` and the metric
catalog in `src/lib/reporting.ts`. Append the nine areas' supported measurements
to `report_measurements`, with source, scope, dates, status, evidence, meaning
and next action. Keep social per profile/platform and organic/paid channel.
GBP call-button clicks are not actual calls; qualified leads must be verified.
No new integration is assumed: manual verified exports are acceptable, otherwise
use an unavailable status with an empty value. The first measured sequence is
the permanent per-series baseline. Compare to the immediately preceding data
month; never substitute older data. Suppress deltas for changed definitions,
overlapping dates or unequal partial windows. Calendar months may have different
day counts; disclose that. Never populate a baseline by copying an unverified
old `summary`.

**Compatibility summary.** Continue writing `monthly_cycles.summary` for
existing consumers, omitting unavailable numeric fields rather than inventing
zeroes. This shape is supplementary; the sourced ledger drives the scorecard:

```json
{"period": "<yyyy-mm>", "ranks": {"tracked": n, "up": n, "down": n, "flat": n, "top3": n, "top10": n, "prev_top3": n, "prev_top10": n, "movers_up": [{"keyword","city","from","to"}], "movers_down": [...]},
 "city_index": [{"location","organic","map","prev_organic","prev_map"}],
 "grid": [{"location","keyword","avg_map_rank","prev","share_of_voice"}],
 "gsc": {"clicks": n, "impressions": n, "ctr": n, "position": n, "prev": {...}, "top_queries": [...], "top_pages": [...]},
 "activity": {"blog": n, "blog_plan": n, "social": n, "social_plan": n, "gbp_posts": n, "gbp_plan": n},
 "backlinks": {"referring_domains": n, "prev": n, "backlinks": n},
 "gbp": {"rating": n, "reviews": n, "prev_reviews": n},
 "alerts": n,
 "wins": ["<3 one-liners>"], "next_month": ["<3 one-liners>"],
 "pulse_id": "<industry_pulse id>"}
```

and `monthly_cycles.rank_summary` = `{"organic_index": <avg City Index
organic>, "map_index": <avg map>, "note": "<one line>"}` (the Reports tab
reads that shape). Then the report: `Monthly Report — <Client> — <Month
YYYY>` to Drive `05 Reports`. Start with a short progress overview, then the
nine areas in catalog order. Each area has a small scorecard with dated baseline,
previous period, current period and supported changes, followed by one sentence
on what it means and one next action. Show missing data explicitly. Keep the
primary report easy to review; keyword positions, URL inventories, detailed
activity and industry pulse belong in an optional appendix. Finish with the
next month's three priorities. An initial report is titled `Starting Baseline`
and uses actual first-measurement dates; no fictional earlier comparisons.
Plain language, no jargon, no internal ids; the
client's name, never "the client". Store the link on the cycle
(`report_url`) and as `deliverables (client_id, monthly_cycle_id, label,
url, type)` = `('…', '…', 'Monthly Report <yyyy-mm>', '<url>', 'report')`.

**Close.** Tasks on the cycle by key: `monthly_report` and `pulse` (done);
`rank_snapshot` only if a snapshot landed in the period;
`content_published` / `social_published` only if the CRM shows the plan's
count met, else leave them open with a note saying `n of plan`. `gbp_posts`,
`backlinks_new`, `paid_ads_review`, `report_send` are Tom's; leave them.
Draft the send: the client's primary contact (`client_contacts` where
`is_primary`, else any contact with an email) gets a `google-ops`
`{"op": "gmail_draft"}` — subject `<Client> — <Month YYYY> marketing
report`, a short plain-text note in Tom's voice (three wins, one line
on next month, the report link), nothing sent. No contact email → no
draft; say so. Put the report URL, the headline deltas and "draft in
Gmail" (or "no contact email on file") in the `report_send` task's
`notes` so Tom has them where he works. Do **not** set the cycle
`complete` — Tom closes it once the report is sent. Set the claimed task's
`notes` to what you did (replace the claim line).

### Website Updates (PB7, monthly — the cycle's `site_updates` task)

Tom's rules (Sept 14 2026): **two new pages and two refreshes per client per
month, published on Compass-run sites without a look** (the Foundation
tab's *Put it back* button is the safety net), **Google Docs for
client-run sites**. Nothing invented: a claim without a source is a
placeholder line, never copy.

**The contract — one adapter per site.** `sites.content_adapter` and
`sites.content_paths` say what the site is and where you may write
(`src/lib/content-adapters.ts` is the reference; `docs/website-updates.md`
the table). Read the adapter's `mutation` per kind of change before doing
anything:

| Adapter | City page | Blog post | Service page / FAQ |
| --- | --- | --- | --- |
| `lucas_json` (`data/locations.json`, `data/blog-posts.json`) | push | push | pull request |
| `markdown_blog` (`content/blog/*.mdx` + data files) | proposed document | push | pull request |
| `foundation_brand_content` (`brands/<brand>/content/*.ts`) | pull request | pull request | pull request |
| `unsupported` / null | proposed document | proposed document | proposed document |

A **push** goes to the site's recorded branch of record (`sites.branch` —
name it explicitly; never write `main` from habit). A **pull request** goes
to a preview branch (`"preview": true` + `pull_request`) and site-push
targets the branch of record. A **proposed document** is a Google Doc in
`04 Website` (`Site update — <Client> — <Month>`; one section per page with
URL, title, meta description, H1, body, FAQs, schema JSON) plus a
`change_log` row (`status = 'proposed'`), and you skip the push steps.
Foundation typed content is TypeScript: an entry is a typed object file
plus a registry import, built and crawled on the preview before the PR is
opened — never JSON written into a registry, and never a city into the
physical-locations registry. If the adapter is null, run the detection
from the tree first (`scripts/build-brief.mjs` with `tree`) and store
`content_adapter` / `content_paths`; a site whose tree you have not
inspected is `unsupported` for this month.

**1. Map first (every month, cheap).** For every tracked keyword with no
`target_url`, pick the page: the `page_groups` row whose primary or
supporting keywords include it (its `target_url`), else the city route for
its `city`, else the service page for its `service_id`, else the home page.
Write `keywords.target_url`. Fill `page_groups.target_url` from the site
where the page exists (read the tree: `site-push {read: true}` lists paths;
`src/app/<route>/page.tsx` or a `data/locations.json` slug is a page). A
page group with no page is a candidate below.

**2. Pick the month's work** from the evidence, in this order, until the
caps are met (2 new, 2 refresh):

- *New city page:* a `city` page group (tier 1 first) with no page, or a
  tracked `city` with ≥ 3 keywords and no entry in `locations`.
- *New service page:* an approved `service` page group with no page — for a
  hand-built site this is a **pull request**, not a push (below).
- *Refresh — striking distance:* a tracked keyword at organic position 4–20
  in the latest `rank_snapshots` (source `dataforseo`) whose page exists:
  rewrite title / H1 / intro / FAQ to answer the query directly.
- *Refresh — Search Console:* `gsc_snapshots` queries with impressions ≥ 50
  and CTR < 2% for a page you can edit, or question queries with no FAQ.
- *Placeholders:* an open `placeholders` row whose material now exists in
  Drive `Media` or `client_requests.responses`.

Skip anything changed in the last 60 days (`change_log` `object_type =
'site'`). Log what you considered and why in the task notes.

**3. Write entries, not components.** Read only what you need:
`site-push {client_id, read: true, paths: ["data/locations.json",
"data/blog-posts.json"]}` (other files come back as paths + sizes). Match
the existing entries exactly — same keys, same tone of `heroH1` /
`heroSub` / `geoRelevanceBlock`, 4–6 FAQs, the `schema` string built the
way the neighbours are (LocalBusiness / the site's type, the city URL,
address from the site's own entries, never a street address for a
service-area business). Facts come from `claims` (`sourced`), the brand
board and the site's existing copy; a city paragraph names real places in
that city (`us-cities.json` and the GBP / Maps listing are your sources),
never invented landmarks. Slugs are lowercase-hyphen and unique. Keep the
JSON valid and the array order stable (append).

**4. Publish.** One push per month per client:

```json
{"client_id": "...", "branch": "<sites.branch — the recorded branch of record>",
 "message": "Website updates <Month YYYY>: +<n> pages, <n> refreshes (Compass CRM)",
 "files": [{"path": "data/locations.json", "content": "<whole file>"}, ...]}
```

Naming the branch of record explicitly asks for the data-entry exception,
and site-push grants it only when **every** file is a push path of the
site's recorded adapter (`data/locations.json` / `data/blog-posts.json` on
`lucas_json`; `content/blog/*.mdx` on `markdown_blog`) and nothing is
deleted — a component, a layout, a config or a delete in the same request
is refused (409) and belongs on a preview branch with a pull request. Leave
`deploy` alone: Vercel's Git integration **blocks** commits from authors
who are not team members (ours are "Compass CRM" — they show as BLOCKED
in Vercel and are harmless), so site-push creates the production
deployment itself and the response's `vercel.staging_url` is where to
verify. A change to a hand-built page (`src/app/services/<slug>/page.tsx`,
or a new service page) goes to a branch with a pull request instead, and
site-push makes a **preview** deployment for it (`vercel.target:
"preview"`, `vercel.staging_url` = the preview) — put that URL in the PR
body so Tom can look before merging:

```json
{"client_id": "...", "branch": "compass/<yyyy-mm>-<slug>",
 "message": "...", "files": [...],
 "pull_request": {"title": "<Client>: <what>", "body": "<why, evidence, the keyword and its rank, the preview URL>"}}
```

The branch is created from the branch of record and the PR targets it
(`pull_request_base` in the response); `sites.branch` does not move.

Never touch components, styles, layout files, `package.json` or anything
outside `content_paths` and `services_dir`.

**5. Verify, then record.** Wait ~90 s, then fetch each new or changed URL
on `sites.url` (else `staging_url`): expect 200, exactly one H1, the
canonical, and the JSON-LD block. A page that fails → `site-push {revert:
true}` then `{deploy: true}` at once, then fix and re-push, or leave it out
and say so. For every change one `change_log` row: `object_type = 'site'`,
`change_type` in `page_added` / `page_rewrite` / `faq_added` /
`pull_request`, `before` (old entry or `{}`), `after` `{url, title,
keyword, commit, pull_request_url}`, `reasoning` (the evidence: rank,
impressions, missing page), `status = 'approved'` for a published change,
`'proposed'` for a PR or a Doc. `keywords.target_url` for the keyword the
page serves. Close `site_updates`: done, `flagged_for_review = true`,
`recommendation` = "`+2 pages, 2 refreshes on <host>; PR open for <x>`" or
"`Docs filed for <n> pages (site not on the contract)`" — that is what the
Brief shows Tom.

Caps are caps: two new, two refreshes, then stop, even if the list is
longer. What is left waits for next month and goes in the notes.

### Weekly blog post (PB7, weekly — the `blog_post` task)

One post per client per week. **Each post serves one long-tail keyword and
one service page**, in the brand voice (`get_brand_profile`), sourced facts
only.

1. **Pick the keyword:** a tracked P2 / P3 keyword with `informational` or
   `commercial` intent (`keywords.intent`), no post yet
   (`content_posts.keyword_id`), preferring Search Console queries with
   impressions and a `gsc_snapshots` position past 10, then volume. Note
   the service page it supports (`service_id` → the service's page group
   `target_url`).
2. **Write it:** 700–1,100 words; title ≤ 60 chars carrying the keyword;
   `description` ≤ 155 chars; an answer-first opening paragraph; H2s that
   are the questions people ask; one internal link to the service page and
   one to the relevant city page; a short FAQ (2–3) at the end; a closing
   CTA using `brand_boards.standing_cta`. Numbers, years, licences and
   guarantees only from `claims` (`sourced`) or the site itself; otherwise
   leave them out. No stock phrases, no "in today's fast-paced world".
3. **File it.** Per the adapter's `blog_post` mutation: `push` → append to
   `content_paths.blog` (`blog_format: json` → an entry shaped like the
   neighbours — `slug`, `title`, `description`, `datePublished`,
   `dateModified`, `blocks[]` of the same block types the file already
   uses; `markdown` → a new file in `blog_dir` with the same front-matter as
   its neighbours) and push with `branch: "<sites.branch>"`, message `Blog:
   <title> (Compass CRM)`; `pull_request` (Foundation typed content) → a
   typed article file plus its registry import on a preview branch with a
   PR; `proposed_document` → the Doc below.
   Not on the contract: a Google Doc in `04 Website` named `Blog — <Client>
   — <title>` and a line in the task notes for Tom.
4. **Record:** verify the URL after ~90 s (200, one H1, canonical); a
   `content_posts` row (`keyword_id`, `title`, `status = 'published'` or
   `'draft'` for a Doc, `owner = 'CLAUDE'`, `url`, `published_at`,
   `word_count`); a `change_log` row (`change_type = 'blog_post'`, `after`
   `{url, title, keyword, commit}`); close `blog_post` done, flagged, with
   `recommendation` = the title and URL.

One post, then stop. The next task arrives next Wednesday.

## 6. End of run

Print a five-line summary: clients touched, stage completed or blocked for
each, anything left for Tom. Nothing else is required — the CRM already
carries it.
