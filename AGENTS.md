<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Compass Client Platform

Internal Compass Marketing Advisors agency tool — every client, their department
pipelines (SEO / Website / Social / CRM / Paid Ads), and the recurring monthly
Reporting cycle. Full build spec: `docs/spec.md`.

- **Stack:** Next.js (App Router) + Tailwind v4 + shadcn/ui (Base UI — triggers
  use `render`, not `asChild`), Supabase (project `compass-client-platform`,
  ref `iokcopiyzajigvhwexhe`), deployed on Vercel (project `compass-crm`) at
  https://compass-crm-ten.vercel.app. Production deploys from `main`.
- **Schema:** `supabase/migrations/` mirrors what is applied to the remote
  project via the Supabase MCP. Enrollment / convergence / monthly-cycle
  automations live in Postgres triggers and functions — see
  `0001_initial_schema.sql`.
- **Auth:** internal team only. Password sign-in is the primary path with a
  magic-link fallback (`src/app/login/page.tsx`); the built-in Supabase mailer
  rate-limits aggressively, so custom SMTP via Resend is the intended fix.
  RLS is enabled everywhere with a blanket authenticated policy; the Phase 5
  client portal only adds client-scoped policies.
- **Secrets** live in Supabase Vault, never in the repo, and are read by Edge
  Functions through the service-role-only `get_secret()` function:
  `BRIGHTLOCAL_API_KEY`, `GSC_CLIENT_ID` / `GSC_CLIENT_SECRET` /
  `GSC_REFRESH_TOKEN`, `SYNC_CRON_SECRET`, `SUPABASE_ANON_KEY`. Provisioning
  (`client-provision`) additionally wants `GDRIVE_REFRESH_TOKEN`,
  `GDRIVE_ROOT_FOLDER_ID`, `GITHUB_TOKEN` and optionally `GDRIVE_CLIENT_ID` /
  `GDRIVE_CLIENT_SECRET` and `GITHUB_ORG` — **none of these are set yet**; see
  "Provisioning" below.

## Phases

1. **Foundation — done.** Clients list, Overview / Plan / Brand / Documents /
   Pipelines tabs, Dashboard, Tasks by owner, Settings.
2. **Trackers — done.** Keywords, locations (with a "cities within N miles"
   suggester backed by a bundled GeoNames dataset, `src/data/us-cities.json`),
   geo-grid configs with a radius helper, rank matrix + City Index, BrightLocal
   sync, GSC sync, Content tracker, Social tracker + calendar, Reports tab,
   monthly cycle automation.
3. **Billing — built, awaiting Stripe keys.** Subscription model only; paid
   status is webhook-driven (`docs/spec.md` §6.5b and §9). See "Billing
   architecture" below for what's deployed and the two secrets still missing.
4. Views & publishing (Board, Tasks, Looker export, Meta publishing).
5. Client portal (RLS policies + read-only views).

## Sync architecture (Phase 2)

Two Edge Functions in `supabase/functions/`, both authorized by either a
signed-in team member's JWT or the `x-cron-secret` header, both responding 202
and finishing in the background via `EdgeRuntime.waitUntil`:

- **`brightlocal-sync`** — read-only ingestion of Local Rank Tracker results
  (best organic + map-pack position per keyword) and Local Search Grid runs
  (per-point ranks, avg map rank). It never triggers billable report runs;
  BrightLocal's own weekly schedule produces the data. REST base is
  `https://api.brightlocal.com/manage/v1` with an `x-api-key` header — note
  the older `tools.brightlocal.com/seo-tools/api` endpoints are deprecated and
  reject new keys. Runs monthly via pg_cron (1st, 07:00 UTC).
- **`gsc-sync`** — refreshes a Google OAuth token for the Compass Workspace
  account, auto-matches each client's Search Console property from
  `clients.website_url` (`sc-domain:` or URL-prefix, stored on
  `clients.gsc_property`, overridable), and pulls the last 28 complete days of
  query+page performance. Runs monthly via pg_cron (1st, 07:30 UTC).

Both are idempotent: natural-key unique indexes on `rank_snapshots`,
`grid_snapshots`, and `gsc_snapshots` make re-ingestion a no-op.

## Playbook model (Sept 7 2026)

`docs/reconciliation.md` reconciles the department pipelines with the delivery
playbooks. Migrations 0010–0013 implement its build-order steps 1–3 plus the
City Index fix; the Services / Brand board / Keywords / Tasks / brief work
(steps 4–9) is still open.

- **0010** additive playbook schema: services, page_groups, money_keywords,
  alerts, change_log, decisions, brand_boards, claims, sites, client_requests,
  placeholders, industry_pulse; new columns on clients, keywords, stages,
  task_templates and tasks; `pipeline_key` gains `foundation`,
  `enrollment_status` gains `pending`.
- **0011** reseeds pipelines: Foundation (every client), SEO and Website
  rewritten to Playbooks 4a / 4b (Astro), Reporting task templates extended
  with PB5 / PB6. Existing stage progress is preserved.
- **0012** triggers: new clients are enrolled in Foundation and cannot leave it;
  SEO / Website enrollments stay `pending` until Foundation completes and their
  gated stages cannot start early; Foundation stages 2–3 wait for the taxonomy.
- **0013** City Index in SQL, P1 only; `brightlocal-sync` calls
  `recompute_location_indexes` instead of computing it in TypeScript.
- **Services tab** (`/clients/[id]/services`, step 5): the taxonomy grouped by
  segment with folded children, edit / approve / retire / reorder, page groups
  read-only. **Foundation tab** (`/clients/[id]/foundation`): the three
  Foundation stages with evidence and next action, Drive folder links, the
  brand board (palette, typography, positioning, CTA, hard rules, approve /
  reopen), claims with confirm, money keywords with thresholds and
  confirmation, and the keyword map. `src/lib/brand-board.ts` renders both
  palette shapes (the doc's array and the Shewmaker load's structured object).

All four were applied to the remote project on Sept 7 2026 and
`brightlocal-sync` redeployed. Clients that existed before Foundation did have
it marked complete (0011), so the gate only bites new clients.
- **0014** finishes build-order step 2: every launch stage carries its playbook
  checklist as task templates, mid-process approvals are gone, and completing a
  pipeline raises one review task. See "Onboarding flow" below.

0008 (Stripe) was applied remotely from its own branch on Aug 31; the branch
(`claude/compass-phase-3-stripe-gr28lo`) was merged on Sept 13 2026 and the
code is inert until the Stripe secrets are in Vault (see "Billing
architecture").

## Billing architecture (Phase 3)

Two more Edge Functions in `supabase/functions/`, deployed to the remote
project (migration `0008_stripe_billing.sql` applied):

- **`stripe-billing`** — JWT-authorized actions called from
  `src/app/billing-actions.ts`: `setup` (create Stripe customer + monthly
  subscription priced from `plans.monthly_fee`, `default_incomplete`, card +
  `us_bank_account`; the first hosted-invoice link is stored on
  `subscriptions.latest_invoice_url` for sending to the client),
  `pause` / `resume` (`pause_collection`).
- **`stripe-webhook`** — deployed with `verify_jwt = false`; authenticity
  comes from the Stripe signature (`STRIPE_WEBHOOK_SECRET`). Sole writer of
  `paid_status`: `invoice.paid` → payment row + `paid`,
  `invoice.payment_failed` → `past_due`, `payment_intent.processing` →
  `processing` (ACH settling), `customer.subscription.updated/deleted` →
  mirror status/price/period (a new period resets `paid_status` to `open`).
  `stripe_events` dedupes Stripe's retried deliveries.

A daily pg_cron sweep (06:30 UTC, `mark_past_due_subscriptions()`) flips
subscriptions still `open` 3+ days past `current_period_end` to `past_due`;
the Dashboard surfaces those under "Payments past due". UI: Billing tab
(subscription card, payment history, lifetime paid, pause/resume, open in
Stripe) plus a setup card on the Plan tab.

## Brand board (spec §6.2b)

Every client has a brand board on the **Brand** tab — the team's visual
reference and the structured "brain" AI reads before writing anything for the
client. Migration `0009_brand_board.sql`.

- **Data:** `client_brands` (1:1 with clients — tagline, positioning, story,
  audience, differentiators, voice & tone, content pillars, words we use /
  avoid, imagery style, typography notes, AI guidance, approval stamp),
  `brand_colors`, `brand_fonts`, `brand_assets`. Files live in the private
  `brand-assets` bucket; the browser uploads straight to Storage
  (`src/components/brand-asset-uploader.tsx`) and a server action records the
  row, so uploads aren't bound by the server-action body limit.
- **AI access:** `select get_brand_profile('<client uuid>')` returns the whole
  brand as one JSON document (client basics, identity fields, colors, fonts,
  assets with bucket + storage path). Any Claude session with the Supabase
  connector should call this before generating content for a client; sign
  `storage_path`s against `brand-assets` to fetch the images.
- **Process hook:** creating a client inserts the empty brand row and a
  "Build brand board" task (owner CLAUDE, `tasks.key = 'brand_board'`), which
  0014 attaches to Foundation › Brand Build. Claude drafts the board (website
  scan + intake) and closes the task; it is read at the Foundation review, not
  signed off mid-flight.
- **Website scan** (`scanWebsiteAction` in `src/app/brand-actions.ts`) pulls
  colors, fonts, logo, favicon and og:image from `clients.website_url` as a
  starting point — heuristic, always review the result. The same scan runs
  server-side as the `brand-scan` Edge Function (service role; authorized by
  a team JWT or `x-cron-secret`), so Claude can seed boards without a browser
  session: `select net.http_post('.../functions/v1/brand-scan', headers with
  get_secret('SUPABASE_ANON_KEY') + get_secret('SYNC_CRON_SECRET'),
  body '{"client_id": "..."}')` and read the result from `net._http_response`.
  WordPress sites leak the Gutenberg default palette (#ff6900, #cf2e2e,
  #fcb900, #0693e3, #9b51e0) — delete those and assign roles by hand.
  **Photos** (Sept 13 2026): the same scan walks the home page plus the
  gallery / portfolio / projects / about / services pages linked from it,
  collects real photography (`img` + `srcset` + lazy-load attributes +
  inline background images + lightbox links; WordPress `-WxH` thumbnail
  suffixes stripped and Next.js `/_next/image?url=` proxies unwrapped so
  the full-size file is fetched), measures every file from its bytes,
  drops icons / sprites / logos / anything under 300 px or wider than
  3.2:1, and files the best 12 as `photo` assets with the alt text as
  label and `width` / `height` set. Body `{"client_id": "...", "photos":
  true}` runs only that pass; the default scan runs it when the client has
  fewer than four photos. Brand Build now requires one `logo_primary` and
  six photos (or a client request and a line of evidence saying why not),
  and the Foundation tab's brand board card shows the logo and a photo
  strip so the pull is visible where Tom reads.
  For sites the scan can't read (JavaScript-rendered, logos only on inner
  pages) the same function has an **import mode**: body
  `{"client_id": "...", "import": [{"url", "kind", "label", "notes",
  "is_primary"}], "remove": ["<asset id>"]}` files specific images (by URL
  or `data_base64` + `mime_type`) into the bucket and `brand_assets`.
- **Outputs:** `/clients/[id]/brand-board` is a print-ready page (Save as
  PDF); "Publish snapshot to Documents" writes a self-contained HTML board into
  the `documents` bucket as a `brand` document. Filing a copy in
  Compass Clients / <Client> on Drive is done by Claude via the Drive
  connector — the app itself has no Google credentials.

## Schema notes learned from the Shewmaker load (Sept 10 2026)

- `brand_colors.hex` has a check constraint: lowercase `#rrggbb` only.
- `page_groups.supporting_keyword_ids` is NOT NULL; use `'{}'::uuid[]` when empty.
- Inserting a client fires `enroll_client_in_foundation` (Foundation enrollment + 3
  stages) and, from the unmerged brand-board branch, `handle_client_created`
  (blank `client_brands` row + a `brand_board` task; `tasks.key` exists remotely only).
- Enrolling in a pipeline whose stages `requires_foundation` is parked as `pending`
  by `gate_pipeline_enrollment` and activated by `handle_foundation_completion`.
  `enforce_stage_gates` blocks gated stages, and Foundation stages 2–3 until the
  taxonomy stage is complete.
- `handle_pipeline_completion` flips a client to `active` and enrolls Reporting
  once every non-recurring enrollment is complete **and** at least one
  department pipeline is enrolled (0016) — Foundation alone no longer converges.
- `clients.drive_folders` is `{"root": id, "01 Onboarding": id, …, "Media": id}` —
  Drive folder ids keyed by folder name. See docs/reconciliation.md "Drive layout".
- Client data loads use deterministic uuid5 ids (`uuid_generate_v5(uuid_ns_dns(),
  '<client>:<table>:<key>')`) so re-running a load is idempotent; loads are data
  scripts, not migrations. Shewmaker (`a88f5ce2-30ac-508b-b217-cf22d277b278`) is the
  blueprint record; nothing about it is deleted or rewritten without Tom.
- RLS on every table is the single "team full access" policy for authenticated users.

## Onboarding flow (Sept 11 2026)

What happens on its own when a client is created, and what a person still does.

**Automatic, on insert (`clients_created`, `clients_foundation_enrollment`):**

1. An empty brand row, and a "Build brand board" task on Foundation › Brand Build.
2. Enrollment in **Foundation**, which cannot be removed.
3. Foundation's three stages, each with its playbook checklist — 22 tasks in
   total (9 brand / 6 taxonomy / 7 keywords).
4. Enrollment in **Website** (0018) and **SEO** (0022), both parked
   `pending` behind Foundation — every new client gets a site and an SEO
   audit; drop the `clients_zz_website_enrollment` /
   `clients_zz_seo_enrollment` trigger to change that policy.
5. The insert fires the **Foundation worker** (below); Brand Build starts
   within a couple of minutes.

**Sequencing gates (kept — they are data dependencies, not sign-offs):**

- Foundation is strictly sequential since 0016: **Brand Build → Onboarding &
  Service Taxonomy → Keyword Research**. Brand first was Tom's call (the board
  reads the website, not the service list); keywords last because every
  keyword links to a service.
- SEO and Website enrollments sit at `pending` until Foundation completes, then
  activate themselves and create their tasks (`handle_foundation_completion`).
- Postgres refuses a stage that starts early with `check_violation`.
  `src/lib/db-errors.ts` turns that into a banner on the Pipelines and Plan
  tabs rather than an error page.

**No mid-process approvals.** `CLAUDE_APPROVAL` / autonomy `hold` is not used
anywhere in the seed data as of 0014 — Claude runs the line unattended. Review
happens once per pipeline instead: `handle_pipeline_review` raises a single
"Review <Pipeline>" task owned by TOM when a pipeline completes. It is a to-do,
not a gate, so convergence (client → `active`, Reporting enrolled) and the
monthly cycle are unaffected.

**Intake** (build-order step 8, Sept 13 2026): the New client dialog captures
name, industry, `vertical` (slugged), `business_type`, phone, home city /
state, service area, website, and an "the client keeps this website" flag
that records a client-controlled `sites` row (`stack = 'other'`,
`controlled_by_compass = false`) before any worker runs **and drops the
Website enrollment** the insert trigger made, so no proposal site is built
(BHG Safety Partners, Sept 13: the worker built one before Tom could say
no). Enrolling Website on the Plan tab is the way back. The Overview tab
edits vertical and business type too.

**Tasks and the Brief** (build-order steps 8–9, Sept 13 2026): the Tasks
page filters by owner, autonomy level (run / run + flag / hold) and a
"flagged for review" view that includes finished run + flag work with its
recommendation. `/brief` is the page Tom reads in the morning and at the
end of the day: needs a decision (held / waiting tasks, blocked stages with
their next action), mine (TOM tasks, due first), review or send (the
`Review <Pipeline>` tasks and open `report_send` tasks with the report
link), done-review-if-you-want (flagged work closed this week), and the
last 24 hours (stages completed with evidence, worker runs with reasons).
Decision recording on approve / veto (`decisions`, promotion at three
matches) is still not built — no hold steps exist in the seed since 0014.

## Foundation worker (Sept 11 2026)

The thing that actually does the `CLAUDE`-owned work. Nothing in the app calls
an LLM; instead a Claude Code **Routine** ("Compass Foundation worker") spawns
a fresh session in this environment, and that session runs
`.claude/skills/foundation-worker/SKILL.md`. **Postgres starts the runs**
(0017, 0018): `fire_foundation_worker()` POSTs to the Routine's API trigger
when a client is created, a Foundation stage completes, Website or SEO
activates, or any Foundation / Website / SEO stage is set to `not_started`
(a retry or a backfill); every fire is logged to
`worker_fires` with its reason and pg_net request id, debounced to one per
client **per reason** per two minutes (0019 — a bulk reopen collapses, a stage
completion never gets swallowed by the fire that started the run). The
Routine API rate-limits fires (429 with a retry-after of a few minutes once
about ten sessions start inside half an hour); `retry_failed_fires()` runs
every 15 minutes (0027) and re-fires anything from the last six hours that
got a 429 or a 5xx — or no answer while under 20 minutes old (0030: pg_net
prunes `net._http_response`, so an older missing answer means pruned, not
failed) — two per tick, only once the newest answer for that client and
reason is ten minutes old (0028 — inside the window a retry just burns an
attempt), up to eight attempts, unless a later fire for the same client and
reason already succeeded. `worker_fires.retry_of`
/ `attempt` record the chain. The Routine's schedule is a **daily** sweep for
anything the events missed. URL and bearer token live in Vault as
`ROUTINE_FIRE_URL` / `ROUTINE_FIRE_TOKEN`; without them nothing fires and
nothing breaks. The skill is the playbook —
Brand Build, Service Taxonomy, Keyword Research, then Website › Build to 70%
and SEO › Audit & Adjust side by side — and the CRM is its only channel: it reads open stages from Supabase, works
them through the DataForSEO / Google Drive / GitHub connectors, writes results
back, closes checklist tasks, and records what it did in
`client_stages.evidence`. Tom reads the Foundation tab; he never has to open
a chat.

- **Work = stage status**, never open tasks (six clients carry open tasks on
  backfilled-complete stages; the worker ignores them).
- **One stage per client per run.** A run the CRM fired for a client works
  that client only, so reopening five clients starts five sessions; the daily
  sweep works up to three. Claims are conditional updates, so concurrent
  sessions never double-work a stage. Each completed stage fires the next run:
  a new client's Foundation chains through in roughly an hour and the website
  bones start the moment Foundation completes.
- **Lock:** an `in_progress` stage whose `started_at` is < 3 h old and whose
  evidence contains `worker:` belongs to a running session.
- **Blocked, never stuck:** missing website, unreachable repo, failed build →
  stage `blocked`, `next_action` says what is needed, and a `WAITING` task is
  opened for Tom. Tom retries by setting the stage back to *Not started* on
  the Foundation tab — that fires a run.
- **Never:** deletes, billable BrightLocal runs, migrations, Shewmaker's data,
  paused / offboarded clients, questions.
- **Approvals:** none mid-flight (0014). The worker sets `services` and
  `page_groups` to `approved` because downstream steps read that status, and
  says so in the evidence; Tom's review is the `Review Foundation` task.
- Run by hand: `/foundation-worker <client name>` works one client, no cap.
- 0016 also fixed convergence: a client enrolled only in Foundation no longer
  flips to `active` / Reporting when Foundation completes. The worker never
  enrolls pipelines; new clients get Website from 0018, older ones from Tom.
- **No website ≠ blocked.** The worker scrubs the GBP, socials and directory
  listings and builds the board from those; it blocks only when there is no
  public footprint at all.

**Website bones** are built from `templates/astro-site/` — the Compass Astro
starter the Shewmaker README promised — copied into the client's repo and
filled from `src/config/site.ts`. The quality bar is in the layout, not the
prompt: every page gets a canonical, one H1, JSON-LD and breadcrumbs; every
service and city page gets an answer-first block, a FAQ with FAQPage schema
and a sourced facts block; the site gets `llms.txt`, `robots.txt` and a
sitemap. `scripts/site-quality-gate.mjs` checks all of it against `dist/`
(SEO / AEO / GEO scores, hard failures, placeholders counted never failed) and
the worker cannot mark Build to 70% complete until it prints `PASS`; the
report lands on `sites.quality`. The starter passes its own gate at
100 / 100 / 100.

**The worker never touches GitHub; the CRM pushes for it.** A cloud session
reaches github.com only through a credential-protecting proxy that permits
the repo attached to the Routine and nothing else — a PAT in a URL is refused
before GitHub sees it, whatever the network setting. So the worker builds in
`/tmp/site` and POSTs the files to the `site-push` Edge Function, which runs
in Supabase (no proxy), creates the repo if needed with `GITHUB_TOKEN`, and
commits through GitHub's Git Data API. Two rules it enforces:

- `Compass2026` is a **user account, not an org** (Vercel's repo metadata
  says so): repos are created with `POST /user/repos`. `/orgs/…/repos`
  returns 404 for it, which is what every earlier "create repo" attempt hit.
- A repo whose `main` already carries a commit not authored by "Compass CRM"
  (Pensacola has Tom's hand-built Next.js site there) is never overwritten:
  the build goes to branch **`compass-astro`** and the response says so. Tom
  blends from there.

`sites.last_pushed_at` / `last_commit_url` (0021) and `branch` (0023) record
each push. The Foundation tab's **Site** card shows all of it — live URL,
repo + branch, staging URL, last push, the build's gate scores and
placeholder count, the audit's scores and findings — with a **Redeploy on
Vercel** button that calls `site-push` with `{deploy: true}`. Without
`GITHUB_TOKEN` the function returns 500 and the stage blocks with a WAITING
task naming the secret.

**Vercel, same function, last and best-effort.** With `VERCEL_TOKEN` in
Vault (`VERCEL_TEAM_ID` optional; defaults to the compassmarketin team),
`site-push` ensures a Vercel project linked to the repo (framework Astro;
named `<slug>`, or `<slug>-astro` for a `compass-astro` side branch so it
never collides with an existing site's project), starts a production
deployment of the branch it pushed, and records `sites.vercel_project` /
`staging_url` (`https://<project>.vercel.app`). A Vercel failure never
undoes a successful push — the response's `vercel.status` is `created`,
`deployed`, `skipped` (no token) or `failed` (with the API error). Body
`{client_id, deploy: true}` with no files redeploys the current head without
a commit — the retry, and Tom's manual redeploy. The Vercel GitHub App must
be able to see the client repos (Compass2026 account → all repositories).

**The Routine's environment needs Full network access** so the worker can
fetch client websites and listings directly (the Default allowlist blocks
them). Full access does *not* open GitHub — see above.

Pause or edit the Routine at claude.ai/code/routines; each run opens as a
normal session there. The skill is versioned here and picked up on the next
fire. `worker_fires` answers "why did a run start"; the run's transcript
answers "what did it do"; `client_stages.evidence` is the durable record.

## SEO audit stage (Sept 13 2026)

Migration 0022 makes SEO › **Audit & Adjust** (Playbook 4a) a worker stage.
New clients are enrolled in SEO at creation, parked behind Foundation like
Website; when Foundation completes both activate and fire, and the two runs
work Build to 70% and the audit side by side (the skill orders a client's
open stages Foundation → Website → SEO and each session claims the first
one free).

- **Read-only on the site.** The audit inventories the live site (`sites.url`,
  else `clients.website_url`, else the staging bones) through DataForSEO
  on-page + Lighthouse, mirrors it and runs `scripts/site-quality-gate.mjs`
  on the mirror so the client's current site gets the same SEO / AEO / GEO
  scores as the build, maps every approved page group to the page that
  serves it, pulls money-keyword positions, the backlink profile and the
  GBP / NAP state.
- **Outputs:** one `change_log` row per finding (`status = 'proposed'`,
  severity in `after`), `SEO Audit — <Client>` in Drive `04 Website` recorded
  as a `deliverables` row, the report on `sites.audit` /
  `audit_checked_at`, and the stage evidence.
- **Adjust is CRM-side only.** Fixes that live in the CRM (page-group
  targets, keyword cities, sourced claims) are applied and their rows marked
  `approved`. On a Compass-controlled site the high / medium findings become
  tasks on Website › Polish & client review; on a client-controlled site the
  fix list is the deliverable for Tom to blend. The PB4a.5 task is closed
  flagged for review with a one-line recommendation.
- Existing clients were enrolled by hand on Sept 13 (a data step, not the
  migration); Logic Solar's audit was completed in August and is left as is.

## SEO stages 2–5 (Sept 13 2026)

Migration 0025 makes the rest of the SEO pipeline worker stages, run in
order and chained by fires (each SEO stage completing fires the next).
The worker has no Business Profile login, no directory accounts, nothing
to send mail from, and BrightLocal report creation is billable, so every
checklist is split honestly: CLAUDE steps are research, drafting and CRM
data, done and filed in Drive `04 Website` as a `deliverables` row; TOM
steps are the logins and the money, left open with the worker's notes
pointing at what it prepared. A stage is complete when the worker's steps
are; Tom's tasks stay on his list.

- **GBP Setup & Optimisation:** `GBP Spec — <Client>` (categories from the
  top competitors' listings, description, services, service area,
  attributes, hours to confirm, booking link, Q&A seeds, shot list, what is
  wrong today) plus four posts for the first month (`gbp_posts_drafted`,
  flagged). Tom applies it (`gbp_apply`, `gbp_photos`).
- **Local Citations:** `Citation Sheet — <Client>` (canonical NAP block,
  aggregators + general + vertical directories, status per directory from a
  search sweep: listed / mismatch with the exact fix / missing). Tom submits
  or runs Citation Builder (`citation_submit`, billable).
- **Backlink Foundation:** `Backlink Prospects — <Client>` (link gap from
  competitor intersections, local opportunities, 25–40 prospects with why
  and how, disavow candidates, three outreach templates in the brand
  voice, flagged); the referring-domain baseline goes on `sites.audit`.
  Tom sends (`outreach_send`).
- **Tracking Setup:** the home `locations` row, a ≥ 20 tracked list, a 7×7
  `grid_configs` on the money keywords; `gsc_verify` closes itself when the
  property has data and becomes Tom's with steps when there is no property;
  `ga4`, `brightlocal_lrt`, `brightlocal_lsg` are Tom's with the exact
  inputs (`Tracked Keywords — <Client>` in `03 Keywords`); `first_sync`
  runs the two read-only syncs and closes only if snapshots land.
  Completing it completes SEO → `Review SEO`, and with Website complete the
  client converges.

The six enrolled clients' open tasks were rewritten in place by 0025 (same
rows, new titles / keys / owners); the first fire for each was sent by hand.

## Website Polish and Launch (Sept 13 2026)

Migration 0026 makes Website › **Polish & client review** and **Launch**
worker stages, chained by fires (Build → Polish → Launch) with two of Tom's
tasks as gates: `client_review` must be done before Launch is claimed, and
`dns_records` before the domain can verify; closing either task fires the
worker (`tasks_zz_fire_worker`). Discovery stays Tom's and never blocks.

- **Polish.** The worker reads the pushed site back through `site-push`
  `{read: true}` (the tree with text files inline — it still cannot clone),
  works the punch list (the audit's findings as tasks on the stage, material
  from the client's Drive `Media` folder placed and its `placeholders`
  resolved, open placeholders left visible), writes the redirect map from
  the old site's sitemap into `vercel.json`, rebuilds, gates, pushes only
  the changed files, then runs Lighthouse on staging and stores the four
  scores under `sites.quality.lighthouse`. `client_review` gets the staging
  URL and what changed. Feedback: Tom adds tasks to Polish and sets it to
  *Not started*, which fires a run.
- **Launch.** `site-push` `{domain: "<host>"}` adds the domain and its
  www / apex twin (308 to the primary) to the Vercel project and returns
  the exact DNS records (A `@ → 76.76.21.21`, CNAME `www →
  cname.vercel-dns.com`, TXT if asked) plus `status: verified | pending`;
  the worker hands the records to Tom (`dns_records`), waits, verifies the
  host serves the new site, checks every redirect, submits the sitemap
  through `gsc-sync` `{submit_sitemap}` (the Search Console token the sync
  already holds), records `sites.url` / `launched_at` /
  `clients.launched_at` and files `Site Plan — <Client>`. A build on the
  `compass-astro` side branch blocks Launch until Tom blends. Completing
  Launch completes Website → `Review Website`, and with SEO complete the
  client converges.

## Approvals retooled (Sept 13 2026)

Tom's walk-through of the line found two real gates — client review before
Launch, and the DNS records — and eighty-odd chores that were his only
because the worker had no login. Migration 0029 and the `google-ops` Edge
Function change that:

- **Pipeline reviews are reads, not tasks.** `handle_pipeline_review` files
  a finished, flagged summary (owner CLAUDE, `summary_<pipeline>`) that shows
  on the Brief under "done, review if you want" and on the Tasks flagged
  view. Nothing waits on it.
- **`google-ops`** (`{client_id, op}`; team JWT or cron secret) is the CRM's
  hands on Google with one refresh token, `GOOGLE_OPS_REFRESH_TOKEN`
  (scopes `business.manage`, `analytics.edit`, `gmail.compose`, minted for
  the GSC OAuth app), plus `GA4_ACCOUNT_ID`. Ops: `gbp_locate`, `gbp_apply`
  (categories, description, services, website, confirmed hours — never the
  name — from `clients.gbp_spec`), `gbp_posts`, `gbp_qa`, `ga4_provision`
  (property + web stream + `phone_click` / `form_submit` key events →
  `sites.ga4_measurement_id`; the Astro layout fires both events when the
  id is set), `gmail_draft` (drafts only; nothing is ever sent). Every op
  answers `done` / `skipped` (names the missing secret) / `failed`
  (Google's message); the worker turns the last two into Tom's task with
  the detail. **Neither secret is set yet** (the Connect Google button mints
  both; Tom has not pressed it): verified Sept 13 that with the
  GSC token alone every op fails with Google's "insufficient authentication
  scopes", so the tasks fall back to Tom exactly as before.
- **Connect Google button** (Settings › Google hands, Sept 13 2026): the
  `google-connect` Edge Function (deployed `verify_jwt = false`; Google's
  redirect carries no JWT, so an HMAC-signed ten-minute `state` is the auth
  on the callback, and every other mode checks a team JWT) runs the OAuth
  consent flow for the Compass Workspace account and stores the refresh
  token straight into Vault as `GOOGLE_OPS_REFRESH_TOKEN` through
  `set_secret()` (0032, service-role only); the account email and granted
  scopes land on `app_settings.google_ops`. The same card lists the
  Analytics accounts the token can see and stores the chosen one as
  `GA4_ACCOUNT_ID`, and **Check access** matches every client against the
  Business Profile locations the account manages (phone, name, website),
  the Search Console property list (GSC token) and `clients.ga4_property`,
  stored on `app_settings.google_access`. `secret_present(name)` (0032,
  authenticated) gives the page yes / no status and never a value. The
  OAuth app (`GSC_CLIENT_ID`) must list
  `https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/google-connect`
  as an authorized redirect URI, and the Google Cloud project needs the
  Business Profile APIs (Account Management, Business Information, Q&A,
  and the v4 API for posts — Business Profile API access is requested
  once per project), the Analytics Admin API and the Gmail API enabled.
- **Per client, Tom does one grant:** the Foundation task `google_access` —
  make the Compass Workspace account a manager on the Business Profile, an
  owner on Search Console, an editor on GA4.
- **Outreach and the monthly report are Gmail drafts** the worker writes;
  `outreach_send` and `report_send` stay Tom's — he presses send.
- **Still Tom's by design:** client review, DNS records, photos, and
  anything billable on BrightLocal (see `docs/follow-ups.md`).
- Leftover tasks from before the worker (keyword-map exports, geo-grid
  configs, DNS access, default branch, SEO enrollment decision) were closed
  and their templates removed.

## Reporting worker (Sept 13 2026)

Migration 0024 makes the monthly Reporting cycle worker-run (Playbooks 5 and
6). The month has three beats on the 1st, all pg_cron: 06:00 UTC
`create_monthly_cycles()` opens a cycle and its keyed tasks per active
client enrolled in Reporting; 07:00 / 07:30 the BrightLocal and GSC syncs;
09:00 `fire_monthly_reporting()` fires the worker once per open cycle. A
cycle started by hand on the Reports tab fires at once (insert trigger; the
cron batch is marked with `compass.cycle_batch` so it does not double-fire).

- **PB6 first:** one `industry_pulse` row per vertical per period (unique
  index; the insert is the claim), rising queries, SERP changes, competitor
  moves and news for that vertical, `affected_client_ids` accumulated.
- **PB5:** ranks, City Index, grid, Search Console, alerts, activity against
  the plan, backlinks and GBP, this period vs the prior one, all from the
  CRM plus two DataForSEO calls; `monthly_cycles.summary` carries the
  figures, `rank_summary` the Reports-tab shape, `report_url` the Drive doc
  (`Monthly Report — <Client> — <Month YYYY>` in `05 Reports`, also a
  `deliverables` row). Missing sources are lines in the report, never a
  block.
- **Nothing is sent.** The worker closes `monthly_report`, `pulse` and the
  activity tasks the CRM can prove, writes the link and headline deltas into
  the new TOM task `report_send`, and leaves the cycle `open`. Tom sends the
  report and closes the cycle.
- The worker claims the cycle's `monthly_report` task (cycles carry no
  `started_at`); the daily sweep picks up cycles the 09:00 fire missed.
- Cycles exist only for `active` clients enrolled in Reporting, which is
  what convergence does when every launch pipeline completes. To start
  monthly reporting for a client before that, set the client `active` and
  enroll Reporting on the Plan tab.

## Provisioning (Sept 11 2026)

Build-order step 4. `supabase/functions/client-provision` creates the client's
Drive folder structure and its site's GitHub repo; migration 0015 fires it from
the `clients_provision` trigger on insert, and the Foundation tab carries a
"Create Drive folders + repo" button as the retry.

- **Drive:** ensures `<GDRIVE_ROOT_FOLDER_ID> / <Client name>` and the six
  children, merges the ids into `clients.drive_folders` (never dropping a
  hand-recorded one) and fills `drive_root_url` if empty.
- **GitHub:** ensures `<GITHUB_ORG>/<slug>` (private, auto-init) and records it
  on the client's `sites` row, creating an Astro row if there isn't one.
- **Idempotent by lookup:** it searches Drive and asks GitHub before creating
  either, so re-running is a no-op and a half-finished run finishes itself.
- **Task keys:** 0015 adds `task_templates.key`, copied onto tasks by
  `create_stage_tasks`. The function closes `drive_folders` and `github_repo`
  by key rather than by title, so rewording a checklist item can't break it.
- **Degrades, never blocks.** A step whose secrets are missing reports
  `skipped` with the exact secret names and the run returns 200; a step whose
  credentials are wrong reports `failed` with the upstream error and the run
  returns 502. Either way no task is closed, so the checklist still shows the
  work as outstanding.

**Credentials are not set yet**, so today both steps skip and the two checklist
items stay open — do them by hand (or ask Claude, which has the Drive and
GitHub connectors). To turn it on, add to Vault:

| Secret | What |
| --- | --- |
| `GDRIVE_REFRESH_TOKEN` | Compass Workspace refresh token carrying `https://www.googleapis.com/auth/drive`. The GSC token is `webmasters`-scoped and will **not** work. |
| `GDRIVE_ROOT_FOLDER_ID` | Folder id of "Compass Clients" in My Drive. |
| `GITHUB_TOKEN` | PAT with repo scope (org: contents + administration). **Also required by the Foundation worker** to create and push client site repos. |
| `GDRIVE_CLIENT_ID` / `GDRIVE_CLIENT_SECRET` | Only if the Google OAuth app differs from the GSC one; otherwise it falls back to `GSC_CLIENT_ID` / `GSC_CLIENT_SECRET`. |
| `GITHUB_ORG` | Defaults to `Compass2026`. |

Verified on Sept 11 2026 with no secrets (both steps `skipped`, 200) and with
deliberately bad ones (both `failed` with the upstream error, 502, no tasks
closed).

## Known state / open items (as of Sept 13 2026)

- **Stripe secrets are not in Vault yet.** Billing code is deployed but inert
  until `STRIPE_SECRET_KEY` is added to Supabase Vault, a webhook endpoint
  pointing at `/functions/v1/stripe-webhook` is created in the Stripe
  dashboard (events: `invoice.paid`, `invoice.payment_failed`,
  `payment_intent.processing`, `customer.subscription.updated`,
  `customer.subscription.deleted`), and its signing secret is stored as
  `STRIPE_WEBHOOK_SECRET`. No Stripe objects have been created.
- **BrightLocal key is a trial** — 1,000 lifetime requests, ~50 per monthly
  sync. Get a production key before that runs out.
- **Keyword priorities are set.** Keyword Research gave every client 6–10 P1
  money keywords and a tracked list of 35–65; the City Index fills on the
  next BrightLocal sync (1st of the month) or a `recompute_location_indexes`
  call.
- **GSC coverage is partial.** Ginger Huff, Logic Solar, Lucas Construction
  and Show Me Design sync. Show Me Electrical's property exists but Google
  has no data for it. Pensacola Equipment Rentals has no Search Console
  property; one needs to be created and verified (Tracking Setup, SEO
  stage 5, is still manual).
- **Foundation is complete for all seven clients** (worker-built brand
  boards, taxonomies and keyword maps; Shewmaker's from the Sept 10 load).
  Six *Review Foundation* tasks are open for Tom — that review is the only
  sign-off in the model. SEO › Audit & Adjust is complete for the six
  non-blueprint clients (reports in Drive 04 Website, findings in
  `change_log`, `sites.audit`); the audit's gate scores on a client-built
  site are relative — the gate expects the Compass starter's structure
  (facts block, FAQPage, `llms.txt`), so a WordPress site scores low on SEO
  / AEO by construction. Read the findings, not the number.
- **Sites.** Ginger Huff, Lucas Construction and Pensacola have Astro bones
  live on Vercel (`gingerhuffinteriors.vercel.app`, `lucasconstruction.vercel.app`,
  `pensacolaequipmentrentals-astro.vercel.app`; Pensacola's is on the
  `compass-astro` side branch because `main` carries Tom's Next.js site).
  Their Website › Polish & client review stages carry the audit punch lists
  (Ginger 23, Pensacola 18, Lucas 5 tasks) and the Discovery TOM tasks
  (client request, DNS access) are open. Logic Solar and Show Me Design keep
  their sites and are not enrolled in Website. Tom deletes the
  `Compass2026/zz-sitepush-smoke` test repo (the token cannot).
- **Reporting has not started.** Every client is still `launching` and none
  is enrolled in Reporting, so no monthly cycle exists; convergence waits on
  the launch pipelines (SEO and Website run through on their own now; Tom's
  gates are client review and the DNS records). To start monthly
  reports for a client now, set it `active` and enroll Reporting on the Plan
  tab — the 1st-of-month beats and the worker take it from there.
- **Not built:** decision recording on approve / veto and autonomy
  promotion; the client portal. Tom's by design: client review, DNS
  records, photos, pressing send on drafted mail, and the billable
  BrightLocal work. The open list is `docs/follow-ups.md`.
