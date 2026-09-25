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
  `0001_initial_schema.sql`. Supabase records each migration under a
  timestamp version; `docs/portal-reconciliation.md` maps every file to its
  recorded version (`0007a_gsc_snapshots_plain_key.sql` is the recorded
  migration that was missing a file — never apply it; `0042` and `0048` (Authority
  runs) are written but **not yet applied**; `0047` (AI Drafter) was applied Sept 25 2026 as
  `20260925165933`; `0044` was applied Sept 23 2026 as `20260923164846`; `0045` was applied
  Sept 24 2026 as `20260924004839`; `0046` (the Business Profile publisher)
  was applied Sept 24 2026 as `20260924015915`). `scripts/test-portal-sandbox.sh` replays all migrations into
  a local Postgres shaped like the project and runs the team / anon / portal
  access tests — run it after any migration that touches policies, grants,
  security-definer functions or `portal_*` views.
- **Auth:** internal team only. Password sign-in is the primary path with a
  magic-link fallback (`src/app/login/page.tsx`); the built-in Supabase mailer
  rate-limits aggressively, so custom SMTP via Resend is the intended fix.
  Magic links never create accounts (`shouldCreateUser: false`). RLS is
  enabled everywhere and every team policy reads `is_team()` (migration
  0036) — a sign-in whose `auth.uid()` is not on `team_members` sees
  nothing; the app layout sends a portal contact to `/portal` and signs
  anyone else out via `/auth/signout`. Sign-ups are
  disabled in Supabase Auth; to add a teammate, invite them in Supabase Auth,
  then insert a `team_members` row with that email (a trigger links
  `auth_user_id`). **New tables
  must use `using ((select is_team())) with check ((select is_team()))`,
  never `using (true)`**, and new security-definer functions must be revoked
  from `public, anon, authenticated`. Edge Functions that accept a JWT also
  require the user to be on `team_members` (403 otherwise); `x-cron-secret`
  callers are unaffected. The Phase 5 client portal adds client-scoped
  policies alongside these.
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

- **`rank-sync`** (Sept 13 2026, migrations 0033 + 0034) — the rank source
  since Tom chose weekly checks on 50 keywords per client through DataForSEO
  instead of BrightLocal's billable Local Rank Tracker. Two modes on the
  DataForSEO **task queue** (the live endpoint takes one task per call and
  costs ten times as much): **post** (pg_cron `rank-sync-weekly`, Monday
  06:00 UTC; body `{client_id}` for one client) sends each active /
  launching client's tracked keywords to `task_post`, 100 per call, desktop,
  depth 100, keyword id as the tag, and opens a `rank_runs` row with the
  posted count in `checks_count`; **collect** (pg_cron `rank-sync-collect`,
  every 20 minutes, a no-op when nothing is ready) reads `tasks_ready`,
  fetches each result, writes organic + map-pack positions to
  `rank_snapshots` with `source = 'dataforseo'` and `recorded_at` = the
  run's start (the client's site host or business name identifies "us"),
  stamps `keywords.last_checked`, completes the run once every posted task
  has answered and recomputes the City Index; a run still open after three
  hours is marked failed with the shortfall. **Locations:** every
  `locations` row carries lat/lng, so tasks are checked by
  `location_coordinate` whenever the keyword's city (or the home city) has
  a row; a keyword city with no row is checked by name and re-posted at the
  home coordinates when DataForSEO refuses the name (it does not list every
  small town — Gravois Mills, Clayton). rank-sync never creates location
  rows. **Needs `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` in Vault** (set
  Sept 14); without them post answers `skipped`. Observed cost $0.006 per
  check → 398 a week ≈ $2.40 a week, about $10 a month.
  `normalize_tracked_keywords(client_id, 50)` keeps `is_tracked` on exactly
  the top 50 (money, then priority, then volume) — run on every client on
  Sept 13; nothing is deleted. BrightLocal's monthly sync still runs and
  still reads the grids; its rank rows simply sit alongside.

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

**Website builds come from the Compass Website Foundation** (Sept 20
2026; `docs/compass-foundation-integration.md`), not the retired Astro
starter (`templates/astro-site/` stays as reference only). The pinned
release is the `foundation_releases` row with `is_current` — v1 accepted
Sept 20 2026, with its source repository, pinned SHA and the three governing
Drive documents recorded on that row (read them from the row; they are not
copied here). The pin moved Sept 21 2026 to a later commit of the same
repository for **service-area support**: `site.address.street` and
`site.address.zip` are nullable, and the footer, the contact card and the
LocalBusiness / JobPosting JSON-LD omit what is absent. A business that goes
to the customer has no public street address; the worker never invents one
and no longer blocks for the lack of it (migration
0040_foundation_v1_service_area). The worker fetches it
through `site-push {archive}`, builds the brand layer per the Foundation's
`docs/starter-checklist.md` from the CRM's brand board, taxonomy, page
groups and sourced claims, and verifies with the Foundation's own checks
(`scripts/foundation-verify.sh`: install, brand-specific typecheck, build,
manifest, provider suite, one shared mock provider started first and handed
to both the site and the form suite, crawl, then the mocked forms and
browser suites when a Chromium exists — otherwise recorded as deferred,
never as passed or as acceptance). Every build or upgrade starts
from a **build brief** (`sites.build_brief`, `Build Brief — <Client>` in
Drive 04 Website; `src/lib/build-brief.ts`, the Foundation tab button):
standard version + SHA, repository and branches, framework and content
adapter, brand and factual sources, page + keyword plan, links, assets,
contact configuration, missing inputs, evidence. The old
`scripts/site-quality-gate.mjs` now only audits non-Foundation sites.

**Website work mode** (`sites.work_mode`, chosen at intake, editable on the
Foundation tab): `new_build` (a Foundation build; lands on the site's
branch of record), `upgrade_existing` (a site Tom already built; every
change is a preview branch created from the recorded production branch plus
a pull request against it — the production branch never moves by itself),
`client_retains` (the client runs the site; the Website enrollment is
dropped at intake and content lands as proposed documents). **Content
adapters** (`src/lib/content-adapters.ts`) are detected from the actual
repository tree, never inferred from another site or from a template
version: `foundation_brand_content` (typed TS content; pull requests only),
`lucas_json` (the Sept 14 contract; data pushes), `markdown_blog` (BHG's
shape; blog pushes, city pages as documents), `unsupported` (documents).

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
  name — from `clients.gbp_spec`), `gbp_qa`, `ga4_provision`
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
- **Worker Google operations switch** (Sept 24 2026; `app_settings`
  `worker_google_ops`, **off** unless it is exactly `{"enabled": true}`; a
  missing row is off). Connect Google only stores the credential and
  reports what it can reach; it grants the worker nothing. While the switch
  is off, an automated caller (the `x-cron-secret` door the worker uses) is
  refused every `google-ops` op except the read-only `gbp_locate`, and
  `gsc-sync` `{submit_sitemap}`, with 403 `status: skipped`, `reason:
  worker_google_ops_off`, before any token is fetched. An op added later is
  a write until it is put on `READ_ONLY_GOOGLE_OPS`. A team member acting in
  person is not gated. Shared rule in
  `supabase/functions/_shared/worker-google.ts`; both functions are
  `handler.ts` factories wired by `index.ts`; tests in
  `tests/worker-google-ops.test.mjs`. Settings › **Worker Google
  operations** (below Google hands) switches it and records who and when.
  It is separate from, and never combined with, the post publisher's switch.
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

## Website Updates and the weekly blog (Sept 14 2026)

Tom's calls: two new pages and two refreshes per client per month, a blog
post every week, published on Compass-run sites **without a look** (the
Foundation tab's **Put it back** button is the safety net), Google Docs for
client-run sites. Migration 0035; playbooks in the worker skill; the plan
and the per-site survey in `docs/website-updates.md`.

- **Contract.** `sites.content_paths` (json) says where the stage may
  write, on the shape of the first client site put on the contract:
  `locations`
  (`data/locations.json`, city pages), `blog` (`data/blog-posts.json` or a
  markdown `blog_dir`), `services_dir` (hand-built pages → pull request,
  never a push). Null = not on the contract → every page and post becomes
  a Doc in `04 Website` and a `change_log` row. Only Lucas is on it today.
- **Monthly**: the Reporting cycle carries a `site_updates` task;
  `fire_website_updates()` (pg_cron, 2nd 09:00 UTC) fires the worker per
  open cycle. Map tracked keywords to pages first, then pick from ranks
  (positions 4–20), Search Console, the page plan and open placeholders;
  write entries, push `branch: "main"`, verify each URL the response's
  `vercel.staging_url` points at (200, one H1, canonical, JSON-LD; a
  failure reverts at once),
  one `change_log` row per change with the commit, keyword `target_url`,
  close the task flagged with a one-line recommendation for the Brief.
- **Weekly**: `create_weekly_blog_tasks()` (pg_cron, Wednesdays 09:00 UTC)
  opens a `blog_post` task per active client and fires the worker. One
  post, one long-tail keyword, one service page, brand voice, sourced facts
  only; a `content_posts` row records it.
- **site-push v9** (Sept 20 2026; branch logic in
  `supabase/functions/site-push/plan.ts`, unit-tested by `npm test`): the
  **branch of record** is `sites.branch`, else the repository's default
  branch, else `main` — never assumed; `branch: "compass/<x>"` or
  `preview: true` creates a side branch **from the branch of record**,
  `pull_request: {title, body}` opens the PR **against it**, the deployment
  is a preview, `sites.preview_branch` is recorded and `sites.branch` is
  untouched; a `client_retains` site is refused (409); an
  `upgrade_existing` site takes only previews unless the caller names the
  branch of record for an authorised content entry; a row inserted by a
  push carries the stack the files imply, never astro; `{archive: {repo,
  ref}}` streams the pinned Foundation tarball (or the client's own repo)
  to the worker; `brand` sets `COMPASS_BRAND` on a Vercel project the push
  creates; `{version: true}` answers `{version: 9, features}` so the
  worker's preflight can tell the deployed function from the old one.
  **The production-write boundary:** naming the branch of record asks for
  Tom's Sept 14 data-entry exception, and it is granted only when every
  file in the request is a push path of the site's recorded adapter
  (`validateContentEntry`) and nothing is deleted — components, layouts,
  configs and deletes are refused (409) and go through a preview + PR. A
  `new_build` label never overrides the existing-site protection: a branch
  of record authored by someone else is parked on the side branch. The
  function is `handler.ts` (a factory over its Supabase and fetch
  dependencies) wired by `index.ts`, so `npm test` exercises the real
  request boundary with a fake GitHub and a fake Supabase
  (`tests/site-push-handler.test.mjs`). v8 behaviour kept: repo and Vercel project from the `sites` row
  (Tom's repos are named by hand, and a repo name and its Vercel project
  name often differ — always read both off the `sites` row rather than
  deriving them); `{read: true, paths: [...]}` returns only those
  files inline; `{revert: true}` makes a new commit carrying the previous
  commit's tree. **Deployments come from Vercel's own Git
  integration** (v11): commits carry a team member's address, so the
  integration deploys them like anyone else's, and site-push finds that
  deployment by commit SHA rather than making a second one. A **preflight
  runs before anything reaches GitHub** (side-branch creation included): a
  preview is refused unless the Vercel project already has a READY
  production deployment, and refused without creating or linking a project;
  a new production project is created, linked and its production branch
  confirmed before the push; an existing project whose production branch is
  not the branch of record blocks the push and is never changed
  automatically —
  production for the branch of record, a preview (behind Vercel's
  deployment protection, so a Vercel login is needed to view it) for a
  side branch, `vercel.target` / `staging_url` / `deployment_url` in the
  response. `deploy: false` is **refused** — the integration deploys from
  the push, so nothing can suppress it from here. `{deploy: true}` with no
  files is the one remaining REST deployment (Tom's Redeploy button: no
  commit, so the integration cannot serve it) and it refuses while a
  deployment of the same head is in flight. **Put it back** no longer
  follows its revert with a deploy — the revert commit deploys itself, and
  the revert takes the same preflight (a mismatched production branch blocks
  it before any GitHub write) and has its deployment located and verified by
  SHA like any other push. Next.js repos default to their recorded branch — the "not our
  author → compass-astro" guard is for full builds only. Verified Sept 15
  on Lucas: read, push to `main` + production deploy, branch + PR + preview
  (PR #9), revert (Sept 14 test, redeployed).
- **Retired:** the Astro proposal builds (Vercel projects and the
  `compass-astro` branch deleted; `sites` rows point at Tom's Next.js repos).
  Since Sept 20 the side-branch name for a build parked next to someone
  else's site is `compass/foundation-build`.

## Reporting worker (Sept 13 2026)

**Nine-area scorecard update (PR #50, app not deployed; 0041 applied Sept 23 as `20260923015843`):** see
`docs/client-scorecards.md` and migration 0041. Measurements are recorded by
hand; nothing reads the rank or Search Console snapshots automatically. The Reports tab adds early,
append-only baseline evidence and monthly comparisons for website pages/links,
citations, backlinks, GBP, reviews, rankings, search traffic, leads and social.
New intake creates a TOM baseline-review task. For those **new clients
only**, the worker records the nine areas (measured or explicitly unavailable)
before its first autonomous asset change. Missing access becomes a
`reporting_baseline_access` task for Tom, not a pause. Existing clients are not
gated. The ledger is team-only via `is_team()` (0036, live), never blanket
authenticated access. Clients with measurements can't be deleted (offboard
them instead). This is still single-agency access, not organization tenancy.
No new provider connector is implied. Missing sources stay explicit; original
baselines cannot be overwritten. Existing cycles and Drive links remain.

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

## Team work management (Sept 22 2026, migration 0043 applied Sept 23)

Tasks can be assigned to actual team members. Details, rollout and rollback:
`docs/agency-tasks.md`.

- **Two different things:** `tasks.owner` / `autonomy_level` are the worker's
  lane and stay exactly as they were; `tasks.assignee_id` (nullable →
  `team_members`) is the person responsible. Existing tasks stay unassigned,
  and assigning never changes the lane.
- **A `CLAUDE` task has no assignee** (`tasks_claude_lane_unassigned`): the
  worker runs it. Hand a step to a person by moving `owner` to a human lane
  first. `CLAUDE_APPROVAL` (hold: a person decides) is assignable.
- **Who changed what:** `created_by` / `updated_by` / `updated_at` are stamped
  by trigger from `auth.uid()` (callers cannot forge them); `task_events` is an
  append-only history written only by trigger; NULL actor = worker / system.
  `task_comments` are team comments, immutable in v1.
- **Belong together:** comments and events FK to `(task_id, client_id)`; a
  task cannot change client; its stage / monthly cycle must be the same
  client's (`check_violation` otherwise).
- **Access:** `is_team()` on both new tables; no API writes to `task_events`;
  portal users reach none of it (no portal view references tasks). Every task
  server action (`src/app/task-actions.ts`, plus `addTaskAction` /
  `toggleTaskAction`) calls `requireTeamMember` first.
- **Screens:** `/tasks` views My work / Unassigned (all but CLAUDE) /
  Overdue (Central-time today) / By client / All open (default, unchanged);
  `/tasks/[id]` edit + history + comments; client **Tasks** tab.
- **Tests:** `npm test`, `npm run test:sandbox` (Postgres replay; 316 portal +
  79 task checks), `npm run test:tasks-ui` (PostgREST + Chrome over the
  replay; screenshots with `SCREENSHOTS=dir`).

## Client Intelligence (five-layer plan, layer 1; Sept 23 2026)

The facts AI-drafted social and Business Profile posts may stand on. Plan,
inventory and rules: `docs/client-intelligence.md`. The client
**Intelligence** tab (`src/lib/client-intelligence.ts`, read-only) scores ten
areas ready / partial / missing with the exact fix, counts keywords by search
intent (navigational / informational / commercial / transactional), and lists
post topics (approved service + page + intent). A post may cite only
`sourced`-with-a-source or `confirmed` claims, never `unverified`; a person
approves before anything publishes; posts are never sold as an SEO guarantee.
**0044** (applied Sept 23 2026 as `20260923164846`; `tests/keyword-intent-offers-migration.test.mjs`)
moves notes out of `keywords.intent` into `keywords.intent_note` verbatim (55
Shewmaker rows), normalizes intent on write and constrains it to the four
intents or NULL, and adds team-only `offers` (exact terms and source always;
dates optional, since standing offers such as free estimates or military
discounts have no expiry, and an end never precedes a start; a confirmed offer
needs who confirmed it and when). Channel date rules, such as a GBP Offer
post's window, belong to the publishing layer. Verified on production after
applying: 547 keywords, 414 with one of the four intents, 133 NULL, 55
`intent_note` (all Shewmaker, identical to the pre-apply text), 0 nonstandard;
`offers` under `is_team()` with no anon grants; types regenerated. In the app,
the Foundation keyword map shows `intent` and `intent_note` separately (a note
is never shown as an intent), and the Intelligence tab's Offers area reads
`offers`: ready with a current confirmed offer (a standing offer with no dates
counts), partial with drafts / upcoming / ended ones, missing with none; it
never blocks the general pilot, and `pilotReadiness(areas, { needsOffer: true
})` makes it blocking for offer content only. There is no offer editing
screen yet.

**0045** (applied Sept 24 2026 as `20260924004839`; post record + human review
gate; rules in the migration header and `docs/client-intelligence.md` step
4): `social_posts` loses its free `status` for `review_status` (draft →
in_review → approved | rejected) and `publish_status` (not_scheduled →
scheduled → publishing → published | failed; nothing past not_scheduled
without an approval), plus `post_claims`, `post_assets` and append-only
`post_events`; the legacy `asset_url` / `storage_path` columns are dropped
(`post_assets` is the only media model) and `post_type` is `standard` or
`offer` (no Event posts yet). Only a signed-in teammate through PostgREST
approves, rejects or reopens (`session_user = 'authenticator'` + role
`authenticated` + a `team_members` row) — never the worker's SQL, the
service role or a trigger. Grounding (usable claims, `crm_facts_only` for
claimless navigational posts, an approved service for standard
informational / commercial / transactional posts, confirmed current
offers) is checked at submit, approval and publishing; approved content is
frozen with a sha256 snapshot; a lapse sends an approved post back to
review. Review tasks are one `post_review` task per post in the
`CLAUDE_APPROVAL` lane, unassigned (the Brief's "needs a decision"). A
teammate may mark an approved facebook / instagram / linkedin / x / tiktok
post published by hand (hash and grounding re-checked, `published_at` +
https `published_url` required, `external_post_id` optional); a Business
Profile post only ever goes out through the publisher. The worker does not write posts yet and never
calls `gbp_posts` / `gbp_qa` (PRs #57, #58); the publisher is 0046, below. UI: Social tab + post page.
Tests: `tests/social-post-review-migration.test.mjs`, the sandbox's
`social_post_review.test.sql`, `npm run test:posts-ui`. The sandbox
bootstrap now creates PostgREST's `authenticator` login, as production has
it. Verified on production after applying: all 16 function bodies match the
reviewed file (md5), RLS / grants / cron / portal isolation as designed, a
rolled-back worker draft opened a `CLAUDE_APPROVAL` review task and could
not approve; types regenerated from production.

## Business Profile publisher (0046, applied Sept 24 2026 as `20260924015915`)

The only way a Business Profile post reaches Google. Design approved Sept
24; rules in `docs/client-intelligence.md` step 7. **`google-ops gbp_posts`
is retired** (answers 410 before any Google call); `gbp_qa` is untouched and
out of scope.

- **`post-publisher` Edge Function** (`handler.ts` over an injected store and
  fetch; `channel.ts` pure rules; `google.ts` v4 localPosts; `store.ts`
  supabase-js with the service role, so writes reach 0045's triggers as the
  publisher identity). Callers: the pg_cron tick `post-publisher-tick`
  (every 5 minutes, `x-cron-secret`, `{mode: "tick"}`) or a team JWT with
  `{mode: "now", post_id}` — the app's **Publish now**, which schedules the
  post for now and asks the function to run that one post through the
  same path. No caller can pass text: it sends only `approved_snapshot`.
- **Path:** switch + pilot list (`app_settings.publisher` = `{enabled,
  clients}`, off by default; Settings › Publisher) → preflight (channel
  rules: ≤ 1500 chars, known CTA, https links, CALL without a link, offer
  terms, one photo; Google connected; the profile located by
  `clients.gbp_location`, else phone, then name, and stored) → claim
  (`scheduled → publishing`; 0045 re-checks the approval hash and
  grounding, a refusal sends the post back to review and records
  `lapsed`) → check Google before any re-send → create → `published` with
  `external_post_id` / `published_url`, or `failed`.
- **Never a guessed publication.** A create answer counts only when it
  names the LocalPost (`accounts/…/locations/…/localPosts/…`); a 2xx
  without one is `uncertain`, nothing is recorded, and the post stays
  `publishing` until the stuck sweep checks the profile. Every check
  (before a re-send, and in the sweep) compares each listed post with the
  approved request — text, topic, button and link, offer terms / redeem
  link / title / dates, photo count, not `REJECTED` — created since the
  post's **approval** (not since the last claim, so a retry after a check
  still sees the original). Exactly one full match and nothing else with
  that text → `reconciled`. Nothing with that text, a complete listing and
  no 2xx claimed → safe to send. Anything else → `ambiguous`: the post is
  `failed`, never re-sent or recorded automatically, and a
  `publisher_check_post` task asks a person to look.
- **Limits:** ≤ 5 posts a tick, one per Business Profile per tick. Automatic
  retry only for 429, 5xx and timeout / network, at 10 / 30 / 120 minutes,
  3 attempts in total; a post stuck in `publishing` over 10 minutes is
  reconciled against Google or failed as transient.
- **Records:** every outcome is a `publisher_runs` row (team read, no API
  writes). A block that needs a person opens one TOM task
  (`publisher_fix_post` and the post is unscheduled, `publisher_connect_google`,
  `publisher_profile_access`, `publisher_failed` when final,
  `publisher_check_post` when ambiguous), and the publisher closes them
  itself once it verifies the fix: `publisher_connect_google` when a token
  refresh works, `publisher_profile_access` when the client's profile
  opens (both checked every tick while such a task is open), and a post's
  `publisher_fix_post` / `publisher_failed` / `publisher_check_post` when
  that post publishes or reconciles. The Brief's
  **Publishing** card lists blocked / lapsed / finally failed / stuck posts;
  the post page shows the run history, attempts and channel problems.
- **Other platforms are never published:** when a scheduled facebook /
  instagram / linkedin / x / tiktok post comes due, the tick opens a TOM
  "Post this by hand" task (`post_by_hand`), closed once someone marks
  the post published, unschedules it or moves it later. Reminders are
  cycles, not a lifetime flag: the post's latest reminder event
  (`publisher_reminder_state()`) says whether one is open, so the same post
  scheduled again gets a new reminder and a new task. This runs even while
  the switch is off.
- **Rollout (Sept 24 2026):** 0046 applied; `post-publisher` v1 and
  `google-ops` v3 (`gbp_posts` → 410) deployed and verified with the switch
  **off** (tick 200 `enabled: false`, non-team Publish now 403, `gbp_posts`
  410 before any Google call). Still to do, in this order: connect Google,
  then switch on for one pilot client. Nothing has been published. Tests: `npm test`
  (`post-publisher-channel`, `post-publisher-handler`, `publisher-app`),
  `npm run test:publisher` (the real handler and store over the sandbox
  replay + PostgREST, fake Google) and the sandbox's
  `publisher_runs.test.sql`.

## AI Drafter (0047 applied Sept 25 2026 as `20260925165933`; `post-drafter` NOT deployed)

Drafts one Business Profile post from governed Client Intelligence and hands
it to 0045's human review. It never approves, schedules or publishes.

- **One read:** `client_intelligence_input(client_id)` (invoker rights) feeds
  the Intelligence tab, the `post-drafter` function and
  `scripts/drafter-dry-run.mjs`. Its fields are pinned to `DrafterInput` by
  `DRAFTER_INPUT_FIELDS` (compile time) and
  `tests/client-intelligence-loader.test.mjs` (SQL).
- **`post-drafter`** (`supabase/functions/post-drafter/`: `brief.ts`,
  `lint.ts`, `rules.ts`, `prompt.ts` from D1; `handler.ts`, `store.ts`,
  `index.ts`, `gazetteer.json` from D2). Modes: `brief`, `check`, `submit`,
  `version`. Auth: `x-cron-secret` (worker) or a team JWT;
  `verify_jwt = true`. Every request rebuilds the brief from live data, and
  a submit with a stale `brief_hash` is refused. There are at most three
  submits per brief. An accepted submit is one `drafter_write()` call.
- **Write boundary (session_user, like 0045):** only authenticator +
  service_role inside `drafter_write` may create a non-human post. The
  worker's SQL (`postgres`, with or without SET ROLE or the
  `compass.drafter_write` flag) cannot create posts, edit a drafted post's
  content or links, or write `drafter_runs`. `drafter_run_id` is
  provenance and never changes. A person may still edit a drafted post in
  the app; the post page flags "edited after check". Post history names
  the drafter `drafter`, never `publisher`. A deliberate schema change by
  the table owner is out of scope; the follow-up is a non-owner role for
  worker SQL.
- **Sandbox fixtures** that create worker-authored posts now insert as the
  cluster superuser (`supabase_admin`), because the worker's own SQL can no
  longer create them.
- **Tests:** `npm test`, `npm run test:sandbox` (`drafter.test.sql`),
  `npm run test:drafter` (the real handler and store over PostgREST),
  `npm run test:posts-ui` (the badge and the drafter row).
- **Applied Sept 25 2026** (`20260925165933`; recorded SQL identical to
  the file). Verified on production: every function body matches the file
  (md5), grants as designed, and rolled-back worker-path tests were all
  refused (direct insert, forged provenance, the flag, SET ROLE
  service_role / authenticator / authenticated + team JWT, SET SESSION
  AUTHORIZATION, editing a drafted post's copy, button or claims, rewriting
  or deleting a run, approving). The loader returns all 9 clients.
  `database.types.ts` was regenerated from production. **Still to do:**
  deploy `post-drafter` with the D1 files, `src/lib/client-intelligence.ts`
  and `post-publisher/channel.ts` (it imports them).

## Client portal (Phase 5, Sept 17 2026)

Migrations 0037 + 0038, routes under `src/app/portal/`. Read-only in v1:
rankings, search traffic, a work log, monthly reports and where the work
stands. No billing, no approvals, no uploads yet.

- **The boundary is views, not policies.** RLS cannot hide a column, so the
  portal never touches a base table: it reads `portal_client`,
  `portal_progress`, `portal_rankings`, `portal_search_performance`,
  `portal_search_queries`, `portal_work_log`, `portal_reports` and
  `portal_site`, each filtered by `portal_client_id()` and carrying only
  client-safe columns. The views run as their owner, so **the WHERE clause in
  each view is the security boundary** — a new portal view must filter by
  `portal_client_id()`, and 0037's verify block refuses the migration if one
  does not. Base tables stay team-only (0036), so anything not named here is
  unreachable: tasks, worker fires, billing, brand internals, other clients.
- **Grants matter as much as the filter.** Supabase grants ALL on new objects
  in `public` to anon and authenticated; a simple view is auto-updatable and a
  write through it runs as the view's owner, bypassing RLS. Every portal view
  is `revoke all … from public, anon, authenticated` then `grant select to
  authenticated`, and the verify block fails on anything else.
- **`portal_users`** is one row per client contact (unique by email), linked to
  `auth.users` by a trigger, with a second trigger refusing any address that
  belongs to a team member. `portal_client_id()` reads it. The work log shows
  approved `change_log` rows and published `content_posts` only — never
  `reasoning`, `evidence` or anything still `proposed`.
- **Routing:** the CRM layout sends a non-team sign-in to `/portal` (or to
  `/auth/signout` if they are neither), and the portal layout sends a team
  member back to `/`. `portal_seen()` (0038) stamps `last_seen_at` — the one
  write a portal user may make.
- **Invites are off by default:** the server-side flag
  `PORTAL_INVITES_ENABLED` must be exactly `true` in the Vercel deployment's
  environment, or the Send invite form is replaced by a notice and
  `invitePortalUserAction` refuses before calling anything
  (`src/lib/portal-invites.ts`). Merging to `main` deploys the app, so this
  is what keeps invites closed until the go-live steps in
  `docs/portal-reconciliation.md` are done. Revoke is never gated.
- **Invites:** `portal-invite` Edge Function (team JWT only) saves the
  `portal_users` row, sends the email (first invite, re-sent invite, or a
  magic link for a returning contact) and links `auth_user_id` on that row,
  reporting success only once the link is saved; the Overview tab's **Client
  portal** card invites and revokes. A contact belongs to one client: an
  address or sign-in already on another client is refused (409), and 0042
  enforces one active client per sign-in in the database. The handler is
  `handler.ts`, tested by `tests/portal-invite-handler.test.mjs`. **The
  deployed v1 predates this** (it never linked first-time invitees and its
  re-invites sent nothing) — deploy it before inviting anyone. Supabase's built-in mailer allows a couple of messages
  an hour, so **custom SMTP (Resend, `send.compassmarketing.ai` is verified)
  must be set in Auth → Emails before inviting real clients.**

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
  money keywords; the tracked list is 50 per client (Show Me Electrical 48
  — it only has 48 keywords; a Keyword Research re-run tops it up) and
  ranks come weekly from `rank-sync` once `DATAFORSEO_LOGIN` /
  `DATAFORSEO_PASSWORD` are in Vault. Three service-area clients (Lucas,
  Show Me Electrical, Ginger Huff) have no city-tagged keywords, so their
  checks all run at the home city until Keyword Research is re-run with
  the 50-keyword shape.
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
- **Sites (Sept 14 2026).** The Astro line is retired: Tom's Next.js builds
  are the sites of record and the worker no longer builds proposal sites
  (`docs/website-updates.md` has the per-site survey, the content contract
  taken from the first client site on the contract — `data/locations.json`,
  `data/blog-posts.json`, dynamic routes, `sitemap.ts`, per-route
  canonicals — and the monthly Website Updates stage Tom decided on: two
  pages + two refreshes a month, a blog post a week, publish without a look
  with a one-click revert). The three Astro Vercel projects and the
  `compass-astro` branch are deleted; `sites` rows point at the Next.js
  repos; two retired Astro repos need Tom's admin rights to delete
  (named in the per-site survey). Website › Build to 70% / Polish for Ginger, Lucas
  and Pensacola now refer to Tom's builds. Logic Solar, Show Me Design and
  Show Me Electrical's live sites stay client-controlled until their Next.js
  rebuilds are full sites. Tom deletes the leftover site-push smoke-test
  repo (the token cannot).
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
