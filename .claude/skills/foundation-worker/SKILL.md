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
`priority = 'p3'`. Dedupe on `(client_id, lower(keyword))` — when a keyword
already exists (earlier trackers seeded terms without demand data), **update**
it: fill `volume`, `cpc`, `competition`, `intent`, `service_id` and
`last_checked` where they are null, and leave `priority`, `is_tracked` and
`is_money` as they are unless this playbook sets them below.

**Money keywords.** The 6–10 terms with the strongest commercial intent ×
volume × fit. Insert `money_keywords (client_id, keyword_id)` (thresholds
default; the trigger sets `keywords.is_money`). Set `priority = 'p1'` on them —
P1 drives the City Index.

**Tracked list.** The top ~30 by opportunity: `is_tracked = true`, `priority =
'p2'` unless already p1.

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

### Website — Build to 70% (PB4b)

Runs only when Foundation is `complete` and the Website enrollment is
`active`. Do the CLAUDE tasks on **Discovery** first (site inventory, `sites`
row: `stack = 'astro'`, `controlled_by_compass = true`, `url` = existing site)
and set Discovery `in_progress`; its TOM tasks (client request, DNS access)
stay open — Tom finishes Discovery himself.

**GitHub — you cannot reach it, and you do not need to.** Every github.com
request from a cloud session goes through a proxy that allows only the repo
attached to the Routine; a PAT never gets past it. Do not try `git clone`,
`git push`, `curl api.github.com` or the GitHub MCP tools against a client
repo — they fail before GitHub sees them. The CRM pushes for you: the
`site-push` Edge Function creates the repo if needed and commits your files
with the token from Vault. Step 8 below. If `sites.repo_url` is null that is
fine; `site-push` fills it.

**Build.** The starter is in this repo: `templates/astro-site/`. It already
carries the SEO / AEO / GEO structure — canonical, one H1, JSON-LD
(LocalBusiness, Service, FAQPage, BreadcrumbList), an answer-first block, a
sourced facts block, `llms.txt`, `robots.txt`, a sitemap — so your job is
the *content*, not the plumbing. Read its `README.md` first.

1. `mkdir /tmp/site` and copy `templates/astro-site/` into it — everything
   except `node_modules/` and `dist/`. You work in `/tmp/site`; nothing is
   cloned.
2. Fill `src/config/site.ts` from the CRM. The mapping:
   - `url` — the production domain if known (`sites.url` when we control it),
     else `https://<slug>.vercel.app`.
   - `business` — `clients` (name, phone, city / state, `service_area` split
     into towns), `schemaType` chosen from schema.org for the vertical
     (`RoofingContractor`, `Electrician`, `HomeAndConstructionBusiness`…),
     `sameAs` from the GBP / socials found in Brand Build. **No street
     address unless the client is a storefront.**
   - `brand` — `brand_boards.palette` → the seven colour roles, `typography`
     → `fonts`, `client_brands.tagline` / `positioning`, `hard_rules` copied
     verbatim, `cta` from the standing CTA.
   - `facts` — `claims` where `status = 'sourced'` **only**, with the source
     URL. An unverified claim never reaches the site.
   - `services[]` — every approved service; `primaryKeyword` from its page
     group's primary keyword; `question` is what a searcher asks; `answer` is
     40–60 words and directly answers it; ≥ 3 `faqs`, each answer 25–90
     words; `description` 70–160 chars.
   - `cities[]` — page groups of type `city` with their tier; same shape.
   - `homeFaqs` ≥ 3, `about` from `client_brands.story`, `placeholders[]` —
     one per missing photo / fact / project, mirrored as `placeholders` rows.
3. Titles 30–65 chars, one primary keyword per page, in the title, H1 and
   meta. Supporting keywords in body copy. Never fabricate a testimonial, a
   licence number, years in business, or a project.
4. Write `DESIGN.md`, `PRODUCT.md` and `docs/{brand-board,keyword-map,
   placeholders}.md` from the same data — short; the CRM is the source.
5. `npm install && npm run build`. A build error is yours to fix.
6. **Gate.** From the CRM checkout:
   `node scripts/site-quality-gate.mjs /tmp/site/dist --phone "<phone>"
   --name "<business name>"`. It must print `PASS`. Fix what it lists and
   rebuild — up to three rounds. Still failing → *Blocked* with the failure
   list in `next_action`. Placeholders are counted, never failed.
7. Run it once more with `--json` and store the report:
   `update sites set quality = '<json>'::jsonb, quality_checked_at = now()
   where client_id = '<client_id>'`.
8. Insert the `placeholders` rows. Then **push through the CRM**: build a
   JSON payload of every file under `/tmp/site` except `node_modules/`,
   `dist/`, `.astro/` and `.git/` — text files as `{"path","content"}`,
   binaries (images) as `{"path","content":<base64>,"encoding":"base64"}` —
   and POST it:

   ```bash
   ANON=$(…)   # select get_secret('SUPABASE_ANON_KEY')
   CRON=$(…)   # select get_secret('SYNC_CRON_SECRET')
   curl -sS -X POST https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/site-push \
     -H "apikey: $ANON" -H "Authorization: Bearer $ANON" -H "x-cron-secret: $CRON" \
     -H "Content-Type: application/json" --data @payload.json
   ```

   with `payload.json` = `{"client_id": "<client_id>", "message": "Build to
   70% from Compass CRM", "files": [...]}`. Do **not** pass `branch`: the
   function picks it. A 200 returns `repo_url`, `branch`, `branch_url` and
   `commit_url` and updates the `sites` row. **If `branch` comes back as
   `compass-astro`, the repo's `main` already carries a site that is not
   ours** (Pensacola has a hand-built Next.js site there) — the build sits on
   the side branch for Tom to blend, and you say so in the evidence. Anything
   other than 200 is the GitHub error verbatim. Do not print the secrets.
9. Put `branch_url` and `commit_url` from the response in the evidence. The
   response also carries `vercel`: when `VERCEL_TOKEN` is in Vault it has
   created or reused a Vercel project and started a production deployment,
   and `sites.vercel_project` / `staging_url` are filled — put `staging_url`
   in the evidence. `vercel.status = "skipped"` means the token is not set
   (say so, leave the Vercel checklist task open for Tom); `"failed"` means
   the push succeeded but the deployment did not — quote `vercel.detail` and
   leave that task open.

Close Build-to-70% tasks 1–7 (the Vercel / staging item only if `vercel`
came back `created` or `deployed`), set the stage `complete`, and put the
repo URL, the staging URL, the three gate scores and the placeholder count in
the evidence. Do not touch Polish or Launch.

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
is your working copy. Note `branch`: `compass-astro` means `main` carries
a site that is not ours — you still polish the side branch, and Launch
will block until Tom blends.

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

**4. Build, gate, push.** `npm run build`, then the gate from the CRM
checkout (`node scripts/site-quality-gate.mjs /tmp/site/dist --phone …
--name … --json`) — it must still print `PASS`; store the report on
`sites.quality` as at Build. Push **only the files you changed or added**
(the same payload shape as Build; `site-push` leaves the rest as it is),
`message` = `Polish: <n> findings applied, <n> images placed`. Images go
as `encoding: "base64"`.

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

**Side branch → blocked.** `sites.branch = 'compass-astro'` means the
domain's current project serves a site that is not ours from the same
repo. Set the stage `blocked`, `next_action` = "Blend compass-astro into
main (or point the Vercel project at compass-astro), then set Launch to
Not started", open the WAITING task, stop.

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
"qa": [{"q", "a"}]}` with the five Q&A seeds, and `{"op": "gbp_posts",
"posts": [{"summary", "cta_url"}]}` with the four posts. The function
never touches the business name. `done` on `gbp_apply` → close the task
`flagged_for_review = true`, `recommendation` = what was applied and
what it could not resolve (`unresolved`), and note the Q&A / posts
results in the evidence. `skipped` or `failed` (no access to the
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
the tracked list has ≥ 20 keywords (`keywords.is_tracked`; Keyword Research
set it — top up from the highest-volume active keywords if short). Ensure
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
a cycle started by hand on the Reports tab fires at once). `period` is the
first of the month being reported on — the cycle opened on Oct 1 reports
September. Everything below is **read from the CRM and DataForSEO** and
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
- **Search Console:** `gsc_snapshots` — clicks, impressions, CTR, average
  position summed / averaged over the period vs prior; top 10 queries and
  pages by clicks; queries that gained the most impressions.
- **Alerts:** `alerts` triggered in the period, acknowledged or not.
- **Activity:** `content_posts` published in the period, `social_posts`
  published in the period, GBP posts (count the `gbp_posts` task's notes if
  Tom recorded a number, else 0), against `plans.gbp_posts_per_month` /
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

**Write.** `monthly_cycles.summary`:

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
YYYY>` to Drive `05 Reports`, in this order: three wins, the numbers
(ranks, City Index, Search Console, GBP, backlinks) each with the
month-over-month delta, activity against plan, what the industry did
(from the pulse, two or three items that matter to *this* client), next
month's three moves. Plain language, no jargon, no internal ids; the
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

## 6. End of run

Print a five-line summary: clients touched, stage completed or blocked for
each, anything left for Tom. Nothing else is required — the CRM already
carries it.
