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
  `GSC_REFRESH_TOKEN`, `SYNC_CRON_SECRET`, `SUPABASE_ANON_KEY`.

## Phases

1. **Foundation — done.** Clients list, Overview / Plan / Documents /
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
it marked complete (0011), so the gate only bites new clients. 0008 (Stripe) and 0009 (brand board) are applied remotely
from their own unmerged branches; the brand-board branch's enrollment hook
attaches its task to the old SEO "Onboarding" stage, which no longer exists,
so it needs re-pointing at Foundation › Brand Build when that branch lands.

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
- `handle_pipeline_completion` flips a client to `active` and enrolls Reporting as
  soon as no non-recurring enrollment is incomplete — so a client enrolled in
  nothing but Foundation converges when Foundation completes. Enroll Website or
  SEO first, or complete Foundation with the convergence trigger disabled (as the
  0011 backfill did). Proposed fix: convergence should require at least one
  non-Foundation pipeline.
- `clients.drive_folders` is `{"root": id, "01 Onboarding": id, …, "Media": id}` —
  Drive folder ids keyed by folder name. See docs/reconciliation.md "Drive layout".
- Client data loads use deterministic uuid5 ids (`uuid_generate_v5(uuid_ns_dns(),
  '<client>:<table>:<key>')`) so re-running a load is idempotent; loads are data
  scripts, not migrations. Shewmaker (`a88f5ce2-30ac-508b-b217-cf22d277b278`) is the
  blueprint record; nothing about it is deleted or rewritten without Tom.
- RLS on every table is the single "team full access" policy for authenticated users.

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
- **Client seed data is partial** — several clients still need enrolled
  pipelines, plan details, and contacts filled in. Pensacola also has no
  `website_url`.
