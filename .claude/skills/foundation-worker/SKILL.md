---
name: foundation-worker
description: Unattended worker for the Compass CRM. Finds clients with open Foundation work (Brand Build → Service Taxonomy → Keyword Research) or a Website "Build to 70%" stage, does the next stage through the Supabase, DataForSEO, Google Drive and GitHub connectors, writes the results back into the CRM and closes the checklist. Started by the CRM itself (Postgres fires the "Compass Foundation worker" Routine when a client is created or a stage completes) plus a daily sweep; run by hand as /foundation-worker <client name> to work one client.
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
- **Bounded runs.** One stage per client per run. A run the CRM started for a
  client works that client only; the daily sweep works up to three, oldest
  `client_stages.started_at` first. Invoked by hand with a client name, work
  that client only.

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

Then the same for Website › **Build to 70%** on clients whose Foundation is
`complete` and whose Website enrollment is `active`:

```sql
select c.name, c.id as client_id, cs.id as client_stage_id, cs.status, cs.started_at
from client_pipelines cp
join pipelines p on p.id = cp.pipeline_id and p.key = 'website'
join clients c on c.id = cp.client_id
join client_stages cs on cs.client_pipeline_id = cp.id
join stages s on s.id = cs.stage_id and s.name = 'Build to 70%'
where cp.status = 'active' and cs.status not in ('complete','skipped')
  and c.status in ('launching','active')
  and foundation_complete(c.id);
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

Nothing found → say "No Foundation work" and stop. That is a normal outcome.

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
- `brand_assets`: the scan files logos; add anything else it missed via the
  function's import mode (AGENTS.md) rather than by hand.
- **Drive:** write `Brand Board — <Client>` to `02 Brand`: palette table,
  typography, positioning, CTA, voice, pillars, hard rules, claims by status.
  Put its URL on `brand_boards.drive_doc_url`.

**No website is not a blocker.** Treat the client as new and scrub what is
public: the Google Business Profile (name, categories, description, photos,
hours, review count and rating, the phone and address it shows), Facebook and
Instagram pages (logo, cover image, bio, recent posts and their voice), Yelp /
BBB / Angi / Nextdoor listings, and any local press. `WebSearch` the name with
the city, then fetch what comes back. Colours and a logo come from the GBP or
Facebook imagery via the scan's import mode; the identity fields come from how
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
**Leave open**, owner `TOM`, with a note: `Add tracked locations and a geo-grid
config` (needs a judgment on radius) and the BrightLocal push (billable).

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

**GitHub.** Your session's GitHub connector reaches only the CRM repo; client
repos are handled over HTTPS with the token in Vault:

```sql
select get_secret('GITHUB_TOKEN');
```

Null → *Blocked* with next_action "Add GITHUB_TOKEN to Vault (PAT with repo
scope on the Compass2026 org)". Keep the token in a shell variable (`GH=…`);
never echo it, never write it to a file, and scrub it from the remote URL
before you finish (step 9).

**Repo.** `slug` = client name lower-cased, non-alphanumerics removed. If
`sites.repo_url` is null: `GET https://api.github.com/repos/Compass2026/<slug>`
with `Authorization: Bearer $GH` → 404 means create it with
`POST https://api.github.com/orgs/Compass2026/repos` body
`{"name":"<slug>","private":true}`. Record `repo_url` on the `sites` row
(create the row with `stack = 'astro'`, `controlled_by_compass = true` if
there is none).

**Build.** The starter is in this repo: `templates/astro-site/`. It already
carries the SEO / AEO / GEO structure — canonical, one H1, JSON-LD
(LocalBusiness, Service, FAQPage, BreadcrumbList), an answer-first block, a
sourced facts block, `llms.txt`, `robots.txt`, a sitemap — so your job is
the *content*, not the plumbing. Read its `README.md` first.

1. `git clone https://x-access-token:$GH@github.com/Compass2026/<slug>.git
   /tmp/site` (an empty repo clones fine). Copy `templates/astro-site/` into
   it — everything except `node_modules/` and `dist/`.
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
8. Insert the `placeholders` rows. Commit everything and push to `main`.
9. `git remote set-url origin https://github.com/Compass2026/<slug>.git` —
   the token leaves the clone.

Close Build-to-70% tasks 1–7 (the Vercel project and staging URL are Tom's
— note it), set the stage `complete`, and put the repo URL, the three gate
scores and the placeholder count in the evidence. Do not touch Polish or
Launch.

## 6. End of run

Print a five-line summary: clients touched, stage completed or blocked for
each, anything left for Tom. Nothing else is required — the CRM already
carries it.
