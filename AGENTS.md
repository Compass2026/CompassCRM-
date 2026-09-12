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
3. **Billing — next.** Stripe subscriptions ported from the Show Me Electrical
   CRM. Subscription model only; paid status is webhook-driven. See
   `docs/spec.md` §6.5b and §9.
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

0008 (Stripe) is applied remotely from its own unmerged branch
(`claude/compass-phase-3-stripe-gr28lo`) and is still the open Phase 3 work.
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
4. Enrollment in **Website**, parked `pending` behind Foundation (0018 —
   every new client gets a site; drop the `clients_zz_website_enrollment`
   trigger to change that policy).
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

**Still manual / not built** (reconciliation.md build-order steps 8, 9): the
intake form (the New client dialog captures name / industry / website / service
area only — `vertical` and `business_type` are typed on the Overview tab), the
autonomy filter on Tasks, and the brief generator.

## Foundation worker (Sept 11 2026)

The thing that actually does the `CLAUDE`-owned work. Nothing in the app calls
an LLM; instead a Claude Code **Routine** ("Compass Foundation worker") spawns
a fresh session in this environment, and that session runs
`.claude/skills/foundation-worker/SKILL.md`. **Postgres starts the runs**
(0017, 0018): `fire_foundation_worker()` POSTs to the Routine's API trigger
when a client is created, a Foundation stage completes, Website activates, or
any Foundation / Website stage is set to `not_started` (a retry or a backfill); every fire is logged to
`worker_fires` with its reason and pg_net request id, debounced to one per
client **per reason** per two minutes (0019 — a bulk reopen collapses, a stage
completion never gets swallowed by the fire that started the run). The Routine's schedule is a **daily** sweep for
anything the events missed. URL and bearer token live in Vault as
`ROUTINE_FIRE_URL` / `ROUTINE_FIRE_TOKEN`; without them nothing fires and
nothing breaks. The skill is the playbook —
Brand Build, Service Taxonomy, Keyword Research, then Website › Build to 70% —
and the CRM is its only channel: it reads open stages from Supabase, works
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

Pause or edit the Routine at claude.ai/code/routines; each run opens as a
normal session there. The skill is versioned here and picked up on the next
fire. `worker_fires` answers "why did a run start"; the run's transcript
answers "what did it do"; `client_stages.evidence` is the durable record.

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
| `GITHUB_TOKEN` | PAT with repo scope (org: contents + administration). |
| `GDRIVE_CLIENT_ID` / `GDRIVE_CLIENT_SECRET` | Only if the Google OAuth app differs from the GSC one; otherwise it falls back to `GSC_CLIENT_ID` / `GSC_CLIENT_SECRET`. |
| `GITHUB_ORG` | Defaults to `Compass2026`. |

Verified on Sept 11 2026 with no secrets (both steps `skipped`, 200) and with
deliberately bad ones (both `failed` with the upstream error, 502, no tasks
closed).

## Known state / open items (as of Aug 31 2026)

- **BrightLocal key is a trial** — 1,000 lifetime requests, ~50 per monthly
  sync. Get a production key before that runs out.
- **Keyword priorities are unset.** The City Index averages P1 keywords only
  (`compute_location_index`, migration 0013), so every location's index is
  blank until priorities are set in the Keywords tab.
- **GSC coverage is partial.** Logic Solar, Lucas Construction, Ginger Huff and
  Show Me Design sync. Show Me Electrical's property exists but Google has no
  data for it at all (likely created recently — GSC does not backfill).
  Pensacola Equipment Rentals has no Search Console property; one needs to be
  created and verified.
- **Brand boards are drafted, not approved** (Sep 1 2026) — website scan +
  intake done for the five clients with websites (palette roles assigned, logos
  from the site, identity/voice/AI-guidance fields written from site copy).
  Pensacola has a placeholder only (no website, no material). Each client's
  "Build brand board" task stays open until Tom approves on the Brand tab.
  Draft boards are filed in Drive under Compass Clients / <Client>.
- **Client seed data is partial** — several clients still need enrolled
  pipelines, plan details, and contacts filled in. Pensacola also has no
  `website_url`.
