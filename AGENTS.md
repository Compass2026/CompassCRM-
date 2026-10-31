<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Compass Client Platform

## Agency rollout reviews (October 14, 2026)

See `docs/agency-rollout.md`. The team-only append-only review ledger keeps
accepted stage separate from current health. No client stage is inferred from
setup counts; every brand and the parent/shared scope require their own review.
Scope changes require renewed verification. No publisher, consent, billing,
portal, or worker activation is part of a rollout review.

## New Client Onboarding v1.0 (October 29, 2026; `20261029170000` written, **not applied**)

See `docs/client-onboarding.md`. One reusable checklist per client / site /
business location (`client_onboarding_items`, standard in `onboarding_items`),
shown on the client's Onboarding tab and as one Control Center check. Items
point at existing records (pipeline task keys, Citation Tracker listings,
GSC / GA4 imports, Zernio bindings, sites); those are signals, never a
sign-off. Nothing is complete by omission: `scope_sites` / `scope_locations`
are decisions and `client_onboarding_gaps` keeps a client incomplete until
every site and location has its rows (or "none" is decided with a reason).
Verified needs a signed-in teammate, every prerequisite done in the same
site / location (a missing row is never satisfied), and exact evidence:
GSC / GA4 imports for the site's own host, the location's own named GBP
profile / the site's own Page (one account credits one location / site).
Enrollment is idempotent and adds rows only; new full-service clients and
their later sites / locations are enrolled automatically, map-tracking and
existing clients are not. Future templates: Metricool → `zernio_connect`,
BrightLocal LRT / LSG → `bing_webmaster` / `map_grid_profile`. The migration
changes no existing task; open legacy tasks are labelled only by the reviewed
`supabase/deferred/20261029_legacy_task_labels.sql`. Apply the migration
before deploying the code.

## Core 50-aware Authority input (P1.3, October 30, 2026; `20261030190000` written, **not applied**; engine `authority-v1.5` not deployed)

See `docs/authority-core-scope.md`. Authority discovery reads only each site
program's approved Core 50.

- **`authority_core_scope(client)`** returns per site the approved list (id,
  version, sorted ids), or `proposed_only` / `missing`, and every keyword the
  list grounds (`core_keyword_grounding()`), with three verdicts:
  `keyword_owner()` per purpose, and the places its text names.
- **`authority_input_scoped(client)`** is `authority_input()` plus
  `authority.core`; `authority-run` reads it. `authority_input()` itself is
  unchanged.
- **The engine fails closed:**
  - An off-list, other-site, held, unverified or text-only-place keyword is
    never a Ready target. It is blocked with its code.
  - A site with no approved list gets one `core_list:` decision, never the
    full inventory.
  - Opportunity keys are unchanged, so re-runs update rows; history is
    untouched.
  - Every keyword-targeted opportunity carries a `core` receipt.
- **`authority_fingerprint()`** gains a `core` section (patched in place on
  its md5-pinned 0048 definition).
- **Deploy order:** apply the migration first, then deploy `authority-run`.
  Runs are a separate authorization.

## Site-program readiness, Gate B / Gate C (October 29, 2026; `20261029200000` written, **not applied**)

See `docs/site-program-readiness.md`. `site_program_readiness(client)` is a
read-only report, one entry per site program:

- **Gate B (Strategy Ready):** an approved site Core 50, owners per
  `keyword_owner()`, and places tied to markets.
- **Gate C (Content Ready):** evidence for safe drafting, never permission
  to publish.
- **Properties:** STABLE and security invoker. Teammates only (42501
  otherwise). Approval is read from `status` / `approved_at`, never from
  `source_ref`. Unknown figures are null, never 0.
- **Places in keyword text:** these are read in SQL (`core_places_in` over
  `place_names`, loaded by the data step `supabase/seeds/place-names-v1.sql`).
  - A place named only in the text is never green: an unrecorded market is
    blocked, and a recorded market without `market_id` / `city` is not
    verified.
  - Unless the reference is place-names-v1 exactly (count and row digest
    pinned in `place_reference_status()`), every keyword is
    `geography_unassessed`. The seed is all or nothing.
- **Claims and `brand_assets` carry no site:** for a multi-brand client they
  are reported with scope `client`, and Gate C cannot be ready on them.
  Missing own-work proof is `limited`, not blocked.
- **Held offerings in existing content:** counted by
  `promotion_hold_conflict_counts()`, a team-readable twin of
  `promotion_hold_conflicts()`.
  - It inlines the two helpers kept from `authenticated`; their grants are
    unchanged.
  - The sandbox proves the counts equal, and pins the three definitions'
    md5s.
  - Known conflicts make Gate C limited; unreadable ones make it not verified.
- **Not per-draft gates:** Gate B scores whole-site strategy completeness.
  Each draft is still decided by its own keyword and content gates.
- **Ownership:** it changes no existing gate. Slot, channel and destination
  readiness stay with the Authority rollout (`social_slot_readiness`).
- **Receipt:** `scripts/site-program-readiness.mjs`.

## Client progress and backlinks (October 12, 2026)

See `docs/client-growth-and-backlinks.md` for the Progress dashboard and backlink
acquisition workflow. Migration `20261012173948_client_growth_and_backlinks.sql`
was released in PR #125 on October 12. Portal progress uses client-scoped read-only
views with private evidence stripped. Baselines remain in the append-only ledger.
Link checks are append-only; a placement stage is not proof of a live backlink.
Do not represent imported query/page GSC sums as full property totals or tracked
placements as the complete backlink profile. No automated outreach is enabled.

## Google Business Profile performance (October 12, 2026)

`docs/gbp-performance.md` describes the read-only Zernio importer and daily refresh
of complete calendar months. It uses the existing read key and exact GBP binding.
The service RPC appends source-labelled report evidence; retries do not duplicate
it, corrections preserve the first baseline, and portal views reuse the report
ledger boundary. No publishing, reconnecting, plan changes or purchases occur.

## Native Agreements (October 7, 2026)

`docs/durable-payment-links.md` describes the 7-day client payment capability
added October 10. Only the dedicated billing project redeems it; no new Stripe
secrets in CRM or Supabase Edge Functions. Issuing/replacing/revoking links is
admin-only. Issued/signed contracts and agreed operational prices stay immutable.

`docs/native-agreements.md` describes the Compass-only contract workflow,
private agreement runtime, signing verification and immutable PDF records.
Migration `20261007180518_native_agreements.sql` is additive. It does not switch
Stripe live mode or change operational plans. The future client issuer model
is present, but Lucas/BHG issuance for their own customers is not enabled.
Never edit or delete an issued/signed document; prepare a new agreement.
Verification email configuration and reviewed terms are required before issue.
Payment handoff attaches an existing live Checkout only when the signed scope
matches the operational plan. Signing never authorizes or creates a charge.

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
  migration that was missing a file — never apply it; `0042` is written but
  **not yet applied**; `0058` (billing foundation, B1), `0059` (Stripe sync
  boundary, B2), `0060` (billing operations, B3), `0061` (billing
  reconciliation, B4) and `0062` (entitlement contract + portal billing,
  B5) were applied Oct 4 2026 as `20261004023512`, `20261004031812`,
  `20261004032556`, `20261004032929` and `20261004033843` — after 0063,
  which they share no object with (`0057` is the Creative Engine
  overlay-roles migration, written and sandbox-tested, not applied (PR #95);
  `docs/billing-cutover.md`); `0064` (the dedicated billing runtime login,
  Option B; `docs/billing-runtime.md`) is written but **not yet applied**;
  `0063` (Compass Communications) was applied Oct 2 2026 as
  `20261002211041`; `0065` (Communications Vault reads by account SID +
  mixed-case Twilio SIDs) was applied Oct 5 2026 as `20261005033418`; `0056` (Canva folder ids on the client record) was
  applied Sept 28 2026 as `20260928212948`; `0054` (Creative Engine schema) was applied Sept 28
  2026 as `20260928021735` (recorded under the name `creative_engine`; nothing
  enabled); `0055` (source-asset hashing) was applied Sept 28
  2026 as `20260928184831`; `0053` (Authority → AI Drafter hand-off) was applied Sept
  27 2026 as `20260927224214` (app and `post-drafter` v2 deployed with it: PR
  #79); `0052` (reconciliation writes bound to their preview) was
  applied Sept 27 2026 as `20260927212625` (app deployed with it: PR #77); `0051` (atomic Home re-home cleanup) was applied Sept 27 2026 as
  `20260927193245`;
  `0050` (Authority reconciliation + `content_posts.origin`)
  was applied Sept 27 2026 as `20260927173308`; `0049` (Authority decisions) was applied Sept 27 2026 as
  `20260927162712` (app deployed with it); `0048` (Authority runs) was applied Sept 25 2026 as
  `20260925221705`; `0047` (AI Drafter) was applied Sept 25 2026 as
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
  run's start (the keyword's own website identifies "us": the client's one
  site, or for a multi-brand client the brand site owning the keyword's
  service — `supabase/functions/_shared/rank-site.ts`, Oct 27 2026; the
  host judged against is stored on `rank_snapshots.site_host`, and a
  keyword whose site cannot be resolved is neither posted nor recorded but
  named in the run's error; the business or brand name still counts in the
  map pack),
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

**Billing & Financial Operations rework** (audit Sept 28 2026,
`docs/billing-audit.md`; architecture and status `docs/billing.md`; cutover
`docs/billing-cutover.md`; draft PR Compass2026/CompassCRM-#86 — do not
merge or deploy without the runbook). Decisions: standard packages + custom
retainers + one-time work; link existing Stripe customers, never duplicate;
card + ACH debit, external arrangements admin-recorded; Stripe owns dunning
(Compass derives `billing_attention` only); entitlements now, never switched
off by billing; Checkout link copied by a teammate. **B1 = 0058** (written,
sandbox-tested, applied Oct 4 2026): the Stripe mirror (team read-only, money
in minor units, `livemode` on every row, `stripe_refunds` one row per
refund), the package / price / one-time catalog, the 14-service
`service_catalog`, `package_entitlements`, `client_entitlement_overrides`,
`plans` as the agreement, the `client_entitlements` /
`client_billing_status` read models; the 3-day sweep and `paid_status`
retired. **Financial configuration is admin-only** (`team_members.role` via
`is_team_admin()`): the catalog and its Stripe mapping, the billing mode
(`app_settings` `billing…`), and team roles (members cannot mint or take
over an admin). **B2 = 0059 + `supabase/functions/_shared/stripe/` +
`stripe-webhook`** (applied and deployed Oct 4 2026): one
shared sync layer (fetch-on-event, pinned API version, newest read wins)
behind the webhook, B3 and future reconciliation; a claim / lease / fail
ledger; the mirror writable only inside the sync functions by an
authenticator + service_role session (the worker's SQL is refused). **B3 =
0060 + `stripe-billing` + the app** (applied and deployed Oct 4 2026): explicit admin actions (search / link an existing customer
with confirmation, create a customer, import a Stripe product, a client's
Custom Retainer price, Checkout from an approved price only with
duplicate-subscription protection, expire a link, configure and open the
Customer Portal, record / void external payments), every Stripe create
idempotent and followed by the shared sync; `billing_audit_events`
append-only; Billing tab (Payment Link Ready, customer, entitlements with
source, invoices, payments with individual refunds, history), Settings ›
Billing catalog, public `/checkout/complete` and `/checkout/canceled`.
Members read everything and edit agreements / overrides; portal contacts
can only open their own client's Customer Portal. **B4 = 0061 +
`stripe-reconcile`** (applied and deployed Oct 4 2026):
the safety net behind the webhook, reusing the shared sync (never a second
one) — mapped catalog products and prices, every linked customer
(`resyncCustomer`, invoices Stripe no longer lists, non-final Checkout
Sessions), then failed / stale webhook events re-synced from Stripe's
current state; repairs measured by mirror fingerprints; per-run and
per-client history (`billing_reconciliation_runs` / `_results`,
`client_billing_reconciliation`, `billing_sync_health`); callers are the
scheduler (`BILLING_RECONCILE_SECRET`; daily schedule enabled only at
cutover) or an admin (Settings › Run Billing Reconciliation, Billing tab ›
Reconcile This Client). Stripe wins; nothing is written to Stripe, and
agreements, entitlements and external payments are never touched. **B5 =
0062 + the app + the worker skill** (applied and deployed Oct 4 2026): `client_entitlements_for()` is the one read of what the
agreement includes (package + client overrides; a disabled or absent quota
is 0, never unlimited; never reads billing) and `client_quota_usage()` the
monthly accounting (America/Chicago month; allocation, completed, planned,
remaining, over allocation). Typed helpers are in `src/lib/entitlements.ts`.
The weekly blog task and the monthly website updates are planned only within
the agreement; every skip is logged in `automation_entitlement_log`, and
nothing is planned when the entitlements are unreadable. A person may always
add more. Authority marks work outside the agreement (the engine and
`authority_input` are unchanged). Tasks / Content / Social / Authority show
"3 / 4 planned" targets; Reports keeps actual and included apart;
Intelligence shows the service scope. `client_agreement_events` is the
agreement history. Agreements are not versioned. `/portal/billing` shows
the portal's own plan, status, services and invoices through
`portal_billing_summary` / `portal_billing_invoices` /
`portal_entitlements`, and a Manage billing button that sends no client id.
**From 0062 on, a client with no recorded agreement gets no weekly blog task
or website updates** — the cutover runbook's precondition 7. **Production readiness** (Sept 30
2026): `docs/billing-readiness.md` (reconciliation with the Creative
Engine branch, security-definer hardening in 0062 — every billing function
pins `search_path = public, pg_temp` —, the tested rollback in
`supabase/rollback/` (`npm run test:billing-rollback`), the cutover kit in
`supabase/cutover/`, the test-mode dress rehearsal `npm run
test:billing-rehearsal`, the deployment order and the go-live checklist);
`docs/billing-agreement-inventory.md` (**agreements confirmed Oct 2026**:
one package, **Compass Standard** — all nine services, 8 blog / 8 GBP / 8
social posts, 4 new pages, 1 refresh a month — for all eight clients,
month-to-month from 2026-10-01, Stripe ACH; BHG Safety Partners and
Shewmaker Brothers Masonry at the $500 legacy price, the other six at the
$650 default; one package and one entitlement definition for both prices;
seeded at cutover by `supabase/cutover/02_agreements.sql`, not yet in
production; the live $650 / $500 Stripe Prices do not exist and are created
only after Option B). **The agreement binds the exact price** (Oct 3 2026,
in 0058): `plans.agreed_amount_cents` / `agreed_currency` /
`agreed_billing_interval` / `agreed_billing_interval_count` are what the
client contracted to pay (notes are descriptive only), and
`plans.billing_package_price_id` is the one approved price of the
agreement's own package Checkout sells (composite FK
`plans_price_of_package`; `plans_agreement_price_guard` requires it active,
recurring, fixed, in the current mode and exactly the agreed terms; only an
admin sets the price or the binding). Checkout takes no price from the
browser, sells only the bound price and refuses an unbound or mismatched
agreement (`agreement_price_not_mapped` / `agreement_price_mismatch`);
`client_agreement_price` reports readiness; the eight stay unbound until
`07_live_bind_standard_prices.sql` (live, after Option B); the test client
binds `price_1UMDr54Zq9yMk653B7jdneFm` with `06_bind_test_client_price.sql`;
`docs/billing-service-role.md` (the Stripe key is in Vault,
readable by every Edge Function and the worker's SQL). **Decided Sept 30
2026: Option A for Stripe TEST MODE only; no live Stripe secret may ever go
into the shared Edge Function / Vault architecture — Option B (dedicated
billing runtime, billing-only Stripe credentials, least-privilege database
role) is a hard go-live blocker.** The Stripe TEST lifecycle passed on
production on Oct 4 2026 (subscription active, invoice paid $2,500, payment
succeeded, all `livemode = false`) through the Edge Functions. **Option B is
built (Oct 4 2026, not yet deployed): `billing/` is the `compass-billing`
Vercel project (the same three handlers as Node functions, a `pg` store as
the `billing_sync` login from 0064, daily reconciliation by Vercel Cron), and
the CRM calls it with the signed-in user's JWT once `BILLING_API_URL` is set
on `compass-crm`. `billing_runtime.edge_functions` keeps the Edge Function
path open until the owner closes it; ordered deployment, verification and
rollback in `docs/billing-runtime.md`.** Operator steps:
`docs/stripe-test-mode-operator-checklist.md`; the agreement questions
(`docs/active-client-agreement-questions.md`) are answered. Every Edge Function
shares the service-role key, so isolation between functions is code review
— a production-blocking follow-up in `docs/billing.md`. **Do not add Stripe
secrets or deploy either function outside the runbook; test mode only.** No
tenant model yet (debt, `docs/billing.md`).

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

**Map-tracking-only clients** (Oct 15 2026, migration
`20261015170000_client_service_scope.sql`): `clients.service_scope` is
`full` (default) or `map_tracking`. Every onboarding insert trigger above runs
only for `full`, so a `map_tracking` client gets no pipelines, tasks, brand
row, worker fire or Drive/GitHub provisioning. A check keeps it `paused` (or
`offboarded`), which keeps every status-driven job (rank sync, blog tasks,
delivery months, monthly cycles, website updates) away from it; its map
scans run from its `map_grid_profiles`. Changing the scope later does not
replay onboarding. The client header shows "Map tracking only".

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
post every week (since B5 / 0062, the numbers come from each client's
agreement — `client_quota_usage()`; see "Billing architecture"), published on Compass-run sites **without a look** (the
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

## Weekly Facebook and Business Profile drafts (Oct 27 2026)

Migration `20261027191343_weekly_social_slots.sql` (sandbox suite
`weekly_social_slots.test.sql`). The monthly delivery standard plans
8 Facebook + 8 GBP posts per site; until this, nothing drafted them.

- **Wednesday beat** (`create_weekly_blog_tasks`, unchanged cron): besides
  the blog slots, `queue_standard_social_tasks()` opens one CLAUDE task
  keyed `social_slot:<plan item>` per standard Facebook / GBP slot dated
  this week that `social_slot_readiness()` calls ready, and fires the worker
  once per client. A unique index makes a second task per slot impossible.
  Forward only: slots before this week are never queued.
- **Ready** = client active or launching, slot not held / linked / queued,
  brand approved (the slot's brand site for multi-brand clients, else the
  board), destination bound through the publisher (Facebook: the site's own
  Page, never a sister brand's; GBP: zernio transport and exactly one
  verified location, shared by every brand of the client), and an active
  keyword with a recorded intent, an approved service and an owner page.
  Anything else is skipped with the first reason, logged in
  `delivery_queue_log` (team read-only). The keyword check is judged once
  per site, over the site's own approved list and the supporting terms
  naming one of its keywords (`20261029030000`; same answers, proven
  against the previous definition), and `keyword_owner`'s same-text lookup
  uses `keywords_client_norm_kw`. At BHG's scale (3 × 50 plus supporting
  terms) a week's readiness went from about 42 s to well under a second.
- **Core keyword list** (Tom, Oct 27: every program derives from its
  approved core 50, **per site**). `core_keyword_lists` holds versioned
  lists per site program (`brand_workspace_id`: each brand site of a
  multi-brand client — BHG has three — else the client): proposed →
  approved only by a signed-in teammate (Keywords tab › Core keyword list)
  and only with **exactly 50 valid keywords** (active, intent recorded, a
  service of that site; judged at approval, `core_list_incomplete`
  otherwise — an incomplete list stays a proposal). Never edited or
  deleted; a new approval supersedes the old. A long-tail keyword counts
  only through `keywords.core_parent_keyword_id`. Approving a list sets
  `is_tracked` to the union of the client's approved site lists
  (`normalize_tracked_keywords` keeps the 0033 top-50 rule only for
  clients with none); `core_keyword_site_coverage` reports per site.
  Readers judge each organic row against its keyword's own website
  (`keyword_site_hosts` / `keyword_rank_state`, inlined in the ranking
  views and used by the City Index): a sister brand's page is
  `third_party`, and an older multi-brand row (no `site_host`, judged
  against "the first site") is `unverified` unless it shows a page on the
  keyword's own site. No stored row is rewritten.
  Proposals are data steps (`supabase/seeds/core-keyword-lists-v1-proposed.sql`,
  `bhg-core-keyword-lists-v1-proposed.sql`), not approvals.
- **No fail-open.** Every content path is gated, whoever writes it: the
  weekly queue (per site: one site's missing list never stops its sister),
  claim and link, `drafter_write`, `content_draft_open_weekly`, any social
  post or content draft (blog or page) entering review **or revised while
  in review** (keyword, service, destination, plan item), and every
  `page_rewrite` / `page_added` / `blog_post` change_log row, which must
  name its `sites` row (`object_type 'site'`), the site's program
  (`client_brand_workspaces.blog_site_id`) and `after.keyword_id`, with
  `after.url` on that site. No approved list, or a revoked one → refused.
  `core_keyword_links` records keyword, list and version for each entry
  and each revision. The only bypass is a recorded exception
  (`core_keyword_exemptions`, granted by a signed-in team admin with a
  reason; production has none).
- **Location markets.** `gbp_location_markets` says which city keywords a
  Business Profile location takes (`office` / `service_area` / `all` for a
  shared profile). A city keyword posted to a location must be one of its
  markets (`market_not_applicable`); a client with a single verified
  location and no rows is unaffected, which is every client today.
  The rows take effect on insert (there is no proposed state), so
  `supabase/seeds/gbp-location-markets-v1-after-scope-confirmation.sql`
  (Logic Wichita office, BHG shared HQ all) refuses to run until
  `compass.market_scope_confirmed` names Tom's confirmation; it is not one
  of the keyword proposal seeds.
- **Worker:** one token per run (`worker-routine:<run id>`, reused on
  retries) → `social_slot_claim` (the binding one-hour claim, same door as
  `authority_draft_claim`; refuses a slot no longer eligible) →
  `post-drafter` brief / check / submit → `social_slot_link`, which
  re-checks eligibility, accepts only the governed in-review draft written
  for that task at the slot's destination and brand on a current core
  keyword, fills the slot's keyword / service / intent / owner page and
  closes the task. The skill's "Weekly social slot" playbook.
- **Launching clients:** readiness, not lifecycle. A launching client
  whose brand is approved now gets its standard blog tasks (from this week
  on, `queue_standard_blog_tasks_site`, so no backlog) and its social
  tasks. Lifecycle and publishing are untouched: drafts wait for review,
  and the publisher still needs Tom's approval, the account switch and the
  pilot list.
- **BHG:** three brand sites share one GBP location; each site's GBP slots
  are queued, and a task whose location has other open slots that day
  tells the worker to choose a different service and topic.

## Keyword owner page vs related service (Oct 28 2026; `20261028170000` written, **not applied**)

Every gate used to take a keyword's service and treat `services.page_url`
as the keyword's page, so a city term owned by its city page, a Home or
brand term with no service, and a BHG brand-site term with no service were
refused, and a service's primary keyword co-owned every keyword of that
service. The migration separates the two:

- **Owner page:** exactly one explicit claim on the keyword: an approved
  page group naming it (or an equivalent row of the **same site program**)
  primary, its `target_url`, or the page of an approved service naming it
  primary. Two different claims are `keyword_owner_conflict`, never a
  priority order. With no claim, the related service's page; never Home by
  default. The page group's `page_type` gives the role: service, city, home,
  brand (`other`), or blog (a published article).
- **Related service:** `keywords.service_id`, optional; when set, approved
  and on the same site. A service page owner needs it unless the intent is
  navigational.
- **One resolver, two twins:** SQL `keyword_owner(client, program,
  keyword, purpose)` and TypeScript `authority/keyword-owner.ts`. Both are
  held to `tests/fixtures/keyword-owner-cases.json` (46 cases: relative
  paths, aliases, same text on another brand site, same-named cities, wrong
  site, unapproved service, held market, 404, duplicate owners, no-service
  Home). Purposes are post, blog, refresh and add (`core_owner_allows`):
  - Home anchors posts but no new blog.
  - A reviews page takes commercial and navigational posts.
  - A refresh rewrites the owner page, never an article.
- **Evidence it needs:**
  - `client_service_markets` is organic scope. Offices are backfilled from
    active physical locations. Anything else is a recorded decision (source
    and date) or a signed-in teammate's. It is separate from
    `gbp_location_markets` (publication); a Business Profile post needs
    both.
  - `keywords.market_id` is explicit. A bare `keywords.city` resolves only
    when exactly one market of the site has that name.
  - `owner_page_checks`: unchecked means `page_not_verified`, and a check
    older than 45 days counts as unchecked. The `owner-page-check` function
    (team JWT or cron secret) records `http` verdicts for the pages
    `owner_page_check_targets` lists (each keyword resolved once since
    `20261028235000`; BHG's 123 keywords take about 4 s); a host that answers
    any path with the same page content (its `<main>`, or body, without
    header / nav / footer, compared in full) is `soft_404`. SPA routes
    (Show Me Design) are verified by a `rendered` check.
  - `client_promotion_holds` holds offerings, with the person's words and
    date. No keyword, core parent, related service, owner page, CTA or
    copy may promote a held offering. Only a signed-in teammate releases a
    hold. Phrases match by word stem in any order within a short span
    (`core_hold_hit` / `holdHit`: "solar panel repairs", "we will monitor
    your solar system") inside one field, one link address or one JSON
    string value — never across fields, and never joining a link's
    address to the words around it (`20261029010000`, after an approved
    installation article matched across its topic and keyword fields);
    prose they do not name is the reviewer's to catch. The database checks the copy itself on every forward step —
    review, approval, scheduling, the publisher's claim, an edit in any of
    those, a blog release and its claim, a page change, a planner slot —
    so content written before a hold stops at its next step: refused with
    the reason, a queued article's claim recorded `blocked`, a slot marked
    `blocked`. Nothing is deleted or rewritten. `promotion_hold_conflicts
    (client)` lists what already matches.
- **Patched:**
  - eligibility (a 5-argument form with purpose), grounding, the list guard;
  - the post / draft / change review gates (`cta_not_owner`,
    `owner_page_mismatch`, `refresh_not_owner`);
  - drafter_write: the brief must name the database's owner, so a brief
    from an older drafter is refused;
  - `social_slot_link` (the slot target is the owner page), readiness;
  - `client_intelligence_for_content(client, service, keyword)`, which adds
    `owner_context`;
  - `content_plan_board`, the planner's Authority path, and the worker
    skill's Map-first rule.
- **Deploy order:**
  1. Apply the migration. Drafting fails closed until step 2: briefs
     without an owner page are refused.
  2. Deploy `post-drafter` and `content-drafter` (both pass `p_keyword_id`,
     which the old loader lacks).
  3. Deploy `owner-page-check`, and run it per client.
  4. Record markets and holds as data steps.

  Rollback: redeploy the previous functions, then restore the patched
  functions from `20261027191343`. Nothing here rewrites existing rows.

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

## AI Drafter (0047 applied Sept 25 2026 as `20260925165933`; `post-drafter` v1 deployed Sept 25 2026)

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
  `database.types.ts` was regenerated from production. `post-drafter` v1
  was deployed Sept 25 2026 (Supabase deployment version 1, with the D1
  files, `src/lib/client-intelligence.ts` and `post-publisher/channel.ts`
  it imports); the two Lucas pilot runs used it.

## Authority → AI Drafter hand-off (0053 applied Sept 27 2026 as `20260927224214`; live since PR #79)

A teammate asks the AI Drafter for the Business Profile post a Ready
Authority opportunity recommends. Authority chooses what to create; the
Drafter decides whether and how it can be written. Nothing is approved,
scheduled or published by any of it.

- **Request (0053, `authority_apply('request_draft')`):** a signed-in
  teammate only. One CLAUDE task keyed `authority_draft:<opportunity id>`
  (a partial unique index allows one open or blocked request per
  opportunity; a repeat request reuses it, a blocked one reopens), the
  opportunity accepted, the team's `request_draft` decision event naming the
  task, and the worker started through `authority_draft_start(task)` →
  `fire_foundation_worker` (reason `Authority draft request <task id>`). A
  failed start is retried by `retry_failed_fires()`; a missed one is
  restarted from the card's **Restart** (debounced two minutes). No path
  creates a second request, run or post.
- **The request task is orchestration only** — never an Authority link.
  The linked `social_post` is the lifecycle: in review → in progress,
  rejected → draftable again, approved / published → completed for the
  current cycle. `authority_opportunities.cycle_started_at`: when the engine
  reports a recurring post eligible again and this cycle's post is done,
  `authority_record_run` starts a new cycle (a `reopened` event, "new
  cadence cycle"); only links since then count.
- **`post-drafter` v2** (`supabase/functions/post-drafter/authority.ts`,
  handler v2, `features: ["authority_mode", "duplicate_recent_post"]`):
  brief / check / submit take `authority_opportunity_id` and **no target**
  (a target alongside it is refused); `expected_run_id` is an optional
  expected version, checked against the opportunity. The target (service,
  keyword, intent, button, standard post, no photo) is derived from the
  opportunity the latest completed run reports. Every mode checks the
  opportunity first (present and current, not dismissed, Ready / create,
  `eligible_from` passed, nothing in review or approved this cycle, no
  Business Profile post for the service and intent in the last 21 days),
  then builds the Drafter's own brief exactly as v1, refuses a disagreement
  (`target_mismatch` — the page, key, keyword or button; `evidence_ineligible`
  — Authority evidence the Drafter does not allow) and adds
  `brief.authority` (run, objective, gap, reasons, preferred claims = the
  analysis's evidence, which become the recommended claims, and the recent
  posts' openings). check and submit add the `duplicate_recent_post` lint
  (same opening, or half the five-word phrasing of any Business Profile post
  of the last 90 days, rejected ones included). submit needs the teammate's
  open request, then one `drafter_write` with the opportunity and run, which
  repeats every check under a row lock and links the post and closes the
  request in the same transaction. Authority conflicts answer 409
  `authority_conflict` with a `code` and record **no** Drafter run; the
  Drafter's own refusals (stale brief, lint, database) are recorded as in v1
  with `drafter_runs.authority_opportunity_id`. Without
  `authority_opportunity_id` the function behaves exactly as v1.
- **Worker:** the skill's "Authority draft request" playbook claims the task,
  runs brief → check → submit with the opportunity id, and on any conflict or
  refusal sets the task `blocked` with the code in its notes; it never
  drafts another target and never refreshes Authority.
- **Binding claims (20261015175410, applied Oct 15 2026).**
  The Authority twin of the blog drafts' binding claims (20261015175146,
  which it needs). The worker's old `update tasks … set status` claim was
  advisory and `drafter_write` never checked it.
  - `authority_draft_claim(task_id, claimant)` records `tasks.claimed_by` /
    `claimed_at` on an open `authority_draft:` request. Only service_role
    and the worker can call it. The claim holds for an hour.
  - `post-drafter` v8 (`features` adds `claims`): brief / check / submit
    take a `claimant`. Another claimant's live claim answers
    `409 claimed_by_other` before any other check, and records no run.
  - `drafter_write` (patched in place) refuses it under the request lock
    with CD409, mapped the same way.
  - An unclaimed request, and every draft without an opportunity, writes as
    before. The Routine claims as `worker-routine`.
  - Ship in this order: 20261015175146 (with its PR), this migration, merge
    (the skill goes live with it), then deploy `post-drafter` from main at
    once. Until it answers v8 with `claims`, the worker's preflight stops
    without drafting. Tests: `tests/post-drafter-authority.test.mjs`,
    sandbox `authority_draft_claims.test.sql`.
- **Authority tab:** **Draft with AI** on a Ready, due Business Profile post
  (`src/lib/authority-draft.ts`, `src/app/authority-draft-actions.ts`,
  `opportunity-draft.tsx`): requested (with Restart), blocked (the worker's
  reason, Draft with AI again), the draft in review (link to the post),
  completed this cycle, or not yet due.
- **Tests:** `tests/post-drafter-authority.test.mjs`,
  `tests/authority-draft.test.mjs`, `tests/drafter-authority-lucas.test.mjs`
  (the production Lucas snapshot, read-only), the sandbox's
  `authority_drafter_handoff.test.sql`, `npm run test:drafter-authority`
  (real handler and store over PostgREST), `npm run test:authority-draft-ui`.
  Read-only dry run over a production snapshot:
  `node scripts/drafter-authority-dry-run.mjs <snapshot.json> [draft.txt]`
  (brief and check only; its store refuses writes).
- **Lucas (Sept 27 2026, dry run only):** the Roof Replacement transactional
  opportunity (`gbp_post:4288b96c-…:transactional`, keyword "get a roofing
  quote wentzville", run `082e8e2a-…`) builds a brief; both evidence claims
  ("Roofing, siding, guttering, fascia and soffit contractor", "Installs
  Owens Corning Duration shingles") are Drafter-eligible and recommended;
  no request exists. **No Lucas draft has been requested, no worker run
  started and no post created.**
- **Live (Sept 27 2026):** PR #79 merged as `8a2312c`, deployed to Vercel
  production; `post-drafter` v2 deployed from it through
  `deploy-supabase-function.yml` (Supabase deployment version 2; `version`
  answers 2 with `authority_mode`). Verified read-only on Lucas (brief and
  check; the deployed brief hash equals the reviewed code's). The next step is
  a teammate pressing Draft with AI.
- **Creative Engine, step 1 (0054, applied Sept 28 2026 as `20260928021735`):**
  the database only — source-image governance on `brand_assets`
  (`creative_use` unreviewed / approved / excluded, own-work flag, subjects,
  focal point, reviewer; AI suggestions in `creative_suggestions`, never
  governed), `client_creative_settings` (no row = `none`; nothing enabled),
  immutable versioned `creative_templates` with per-client approval after a
  preview (`client_creative_templates`), `creative_runs`, immutable
  content-addressed `creative_assets` (private `creative-assets` bucket,
  `<client>/<sha256>.<ext>`) and `creative_asset_sources`, creative links on
  `post_assets`, `social_posts.creative_policy / creative_status /
  creative_version / rejection_category`, the approval snapshot's `creative`
  key (only when creative is linked, so existing hashes are unchanged),
  `request_new_creative`, and `creative_governance_events`. Writes only in the
  Creative Engine's service session (`creative_begin_run`, `creative_write`,
  `creative_fail_run`, `creative_register_template`); governance is a
  signed-in teammate's. `drafter_write` leaves a post whose policy is
  `required` as a draft for its creative. No renderer, template or policy
  exists yet. Tests: the sandbox's `creative_engine.test.sql`. Verified on
  production after applying: recorded SQL identical to the file (md5), all 38
  function bodies match, grants / RLS / storage policy as designed, 27
  rolled-back probes refused (worker SQL, SET ROLE service_role, SET ROLE
  authenticated + team JWT, a portal contact, anon), existing posts, approval
  hashes and brand assets unchanged; `database.types.ts` regenerated (the post
  page lists brand-asset links only, since `post_assets.brand_asset_id` is now
  nullable).
- **Source Asset Governance (0055 applied Sept 28 2026 as `20260928184831`):** a hash is a
  measurement of the stored bytes, so `brand_assets.content_hash` /
  `content_hashed_at` / `content_measurement` are written only by
  `brand_asset_record_hash()` in the source-assets function's service session
  (compare-and-set on the path and previous hash, storage object present, size
  matching; a no-op when nothing changed). Any other change to `storage_path`,
  `url`, `width` or `height` clears the hash, and a changed or cleared hash
  resets the review (0054). Approval now also needs a recorded hash, the
  stored object present, at least one lower-case subject tag, and for a photo
  the own-work decision and a focal point; hashing, approvals (with the
  approved hash) and resets are in `creative_governance_events`.
  `supabase/functions/source-assets` (`handler.ts`, `plan.ts`, `store.ts`,
  `../_shared/image-meta.ts`): `inventory` is a read-only dry run (downloads
  each stored file from `brand-assets`, sha256 + size + EXIF orientation;
  link-only assets reported with the brand-scan import that would store them),
  `hash` records only the assets named in `expect: {asset_id: hash}` from an
  inventory and refuses bytes that changed since. It never writes image bytes
  or review fields. UI: Brand tab › **Creative use**
  (`/clients/[id]/brand/creative-use`; `src/lib/creative-use.ts`,
  `src/app/creative-use-actions.ts`, `src/components/creative-use/`):
  Approve for creative / Exclude (reason) / Keep unreviewed, as the signed-in
  teammate, refused when the file changed since the page loaded; AI
  suggestions shown apart and only prefill subjects / focal point on request.
  Tests: `tests/source-assets.test.mjs`, `tests/creative-use.test.mjs`, the
  sandbox's `source_asset_hashing.test.sql`, `npm run test:creative-use-ui`.
  `source-assets` is on the deploy workflow's function list. Verified on
  production after applying 0055: recorded SQL identical to the file (md5),
  all 6 function bodies match, grants / constraints / triggers as designed,
  rolled-back probes refused the worker's SQL (also with the flag, SET ROLE
  service_role and SET ROLE authenticated + team JWT), a portal contact, a
  non-team sign-in and anon; every brand asset unchanged and unreviewed;
  `database.types.ts` regenerated. **Lucas (Sept 28 2026):**
  - All 15 of Lucas's brand assets are hashed; none is reviewed.
  - The website's v3 wordmark was imported as `logo_primary`; the old
    square mark is kept as a legacy `logo_icon`.
  - The Creative use cards now show the file name, the full hash, the
    asset's notes and quality warnings (`qualityWarnings` in
    `src/lib/creative-use.ts`: hero size < 1080 px, compression, enlarged
    crops, Facebook / WhatsApp files, raster logos). Warnings never block
    or decide.
  - The focal picker keeps the photo's shape, so clicks map to the image.
  - Decisions and the Lucas creative palette / type:
    `docs/lucas-creative-readiness.md`.
- **Architecture decisions (Sept 28 2026; `docs/client-intelligence.md`,
  "Content architecture decisions"):** one Authority opportunity per
  publishing channel (GBP, Facebook, Instagram each their own lifecycle; a
  future `content_group_id` may group sibling variants without merging their
  lifecycles), and generated creative is never stored in `brand_assets` (a
  future `creative_assets` model; approval will bind copy and the exact
  creative version). Nothing of the Creative Engine is built.

## Creative Engine renderer (Sept 30 2026; post graphics Oct 3; 0057 written, not applied; nothing deployed)

This is the deterministic renderer and the Lucas template pilot. Full
design, rules and runbook: `docs/creative-engine.md`. Production state and
the readiness matrix: `docs/lucas-creative-readiness.md`.

- **Code:** `supabase/functions/creative-engine/`.
  - **Pinned stack:** resvg-wasm 2.6.2, hash-checked; opentype.js 1.3.4;
    Montserrat / Poppins embedded and hash-checked. Text is drawn as glyph
    paths.
  - **Determinism:** the same inputs give the same bytes, and Deno is
    byte-identical to Node (`deno-check.ts`).
  - **Hashes:** spec hash = `creative_spec_hash`; brief hash; copy hash;
    re-hashed source bytes; the output hash.
- **Governance (`govern.ts`):** the request carries references only (a
  service id, claim ids, a label id, photo ids) and every word is resolved
  from the record.
  - **Words:** a claim must be confirmed or sourced-with-source. Compass-wide
    and client (`kits.ts`) phrase blocks apply. Word limits apply, and copy
    that does not fit is refused, never shrunk.
  - **Photos:** approved, own work, unchanged, focal point set, no people
    tags, showing the service. A hero needs ≥ 1080 px, and nothing is
    enlarged.
  - **Nothing falls back.**
- **Templates:** `registry.ts` holds five cleared families (Service
  Spotlight, Trust & Know-How authority mode, Seasonal non-offer, Real Work
  Showcase, Service Light) × Business Profile 1200×900 / Facebook /
  Instagram 1080×1350, as `lucas-*-{gbp,facebook,instagram}` v1. Review
  Spotlight, Team & Community and Offer mode stay blocked.
- **Function (`handler.ts`):**
  - `version`
  - `register`: through `creative_register_template`
  - `plan`: a dry run, no writes
  - `preview`: `creative_begin_run` → upload at the content address →
    `creative_write`; proposes, never approves
  - `post` (Oct 3 2026): the graphic for a draft post from a template
    approved for the client. `post-bindings.ts` takes the post's service
    and only its linked claims, and picks approved own-work photos of that
    service. The run is bound to the post's copy hash and creative version.
    `creative_write` links the image for review.
  - It is **not deployed**.
- **0057** adds overlay roles (phone, website, service segment, template
  label; claims in previews; ≤ 12 lines) so the record matches what is
  drawn. It is **not applied**.
- **Previews and approval:** Brand › Creative use › **Creative previews**
  (`/clients/[id]/brand/creative-preview`, `src/lib/creative-preview.ts`)
  renders the Lucas preview set with the teammate's own session (viewing
  writes nothing).
  - Per template and channel: **Record preview for approval** (the
    function's `preview` mode) and **Approve** / **Revoke**
    (`client_creative_templates`).
  - Per channel: the **graphic policy for new posts**
    (`client_creative_settings`).
- **Post graphics:** the post page's **Graphic** section (policy, Generate
  graphic, Download PNG, Request new graphic), with
  `src/app/creative-actions.ts` calling the function with the teammate's
  JWT.
  - `/clients/[id]/creative/[assetId]` serves recorded bytes, re-hashed.
  - Reject asks copy / graphic / both.
  - Approved posts get **Copy text**.
- **Tests:**
  - `npm test`: `creative-engine`, `creative-engine-handler`,
    `creative-engine-post`
  - the sandbox's `creative_overlay_roles.test.sql`
  - `npm run test:creative-preview-ui`, `npm run test:creative-post-ui`
    (end to end: register → preview → approve → render → download →
    approve post → request new → reject graphic)
  - `deno-check.ts`
- **Runtime** (`docs/creative-engine-runtime.md`):
  - Measured in Deno with photo-like JPEGs: 0.53–1.44 s for a cold
    render, with a process peak of 165–216 MB RSS.
  - Edge limits: 2 s CPU and 256 MB.
  - The 1080×1350 formats miss the 1.0 s CPU margin in this container.
  - Measure the deployed function (a write-free `measure` mode, not built
    yet) before any production render.

## Canva folder mapping (0056, applied Sept 28 2026 as `20260928212948`)

Every Compass client keeps its designs in one primary Canva folder with one
"Used" subfolder inside it. `clients.canva_folder_id` /
`canva_used_folder_id` (nullable text; a client without Canva has neither)
record their **ids**, which are the integration key. Canva folder names are
display labels and are never stored or matched ("Show Me Used" belongs to
Show Me Electrical only because its id sits inside that client's folder).

- **Rules:** an id looks like a Canva folder id (`^FA[A-Za-z0-9_-]{6,62}$`:
  no names, no `root` / `uploads`, no design ids); a Used folder needs a
  primary folder and differs from it; no two clients that are not offboarded
  share a folder in either column (partial unique indexes
  `clients_canva_folder_id_live` / `clients_canva_used_folder_id_live`, plus
  the security-definer `clients_canva_folders_guard` for cross-column reuse,
  23505 naming the client that holds it). Reactivating an offboarded client
  whose folders a live client holds is refused.
- **Read model:** `client_canva_folders(p_client_id default null)` (invoker
  rights; team and service role) and `src/lib/canva-folders.ts`
  (`loadClientCanvaFolders`). `client_intelligence_input` / `authority_input`
  are deliberately not extended: Authority fingerprints the intelligence
  document, so new fields there would mark every run stale.
- **Seed:** the eight active clients from the confirmed Sept 28 2026
  reconciliation (`tests/fixtures/canva-folder-mapping.json`), by client id.
  Compass Activation Test (fictional, offboarded) and every Canva-only
  folder stay unmapped. The backfill refuses a partial set, an offboarded
  client or a different existing mapping, and seeds nothing on a database
  without those clients.
- **Not built:** Canva asset sync (`canva_assets`), moving designs, creative
  generation or publishing from Canva. Nothing reads the columns but the read
  model.
- **Integration rules** (`docs/canva-integration.md`, from the Sept 28 2026
  read-only discovery): folder listing is safe for metadata; reading a
  design's content or metadata through the connector updates Canva's
  modified time even with no edit (a thumbnail-only read does not), so
  capture listing metadata first, prefer thumbnail-only reads, and never read
  a post-read modified time as a human edit. Current vs Used comes from the
  parent folder id, never the title. The same doc holds the discovery counts,
  the Lucas template-family shortlist (planning only; no template registered)
  and the governance gaps it found.
- **Tests:** the sandbox's `client_canva_folders.test.sql` (the replay
  inserts the nine production-shaped clients before 0056 through
  `supabase/tests/sandbox/replay/0056.before.sql`, and `0056.after.sql`
  snapshots the backfill and removes them), `tests/canva-folders.test.mjs`.
- **Verified on production after applying:** recorded SQL identical to the
  file (md5 `a75f5e61…`), both function bodies match (md5), grants /
  indexes / constraints / trigger as designed; the eight mappings exact and
  the activation test client unmapped (table and read model). Rolled-back
  probes as a teammate: duplicate primary, duplicate Used and both
  cross-column reuses refused (23505 naming the holder), a folder name,
  `uploads` and a Used folder without a primary refused (23514), reactivating
  an offboarded client on a live client's folders refused; with the guard
  disabled both unique indexes refuse duplicates on their own; anon is denied
  the read model and a non-team sign-in sees and updates nothing. Before and
  after the apply, for all nine clients, the Authority fingerprint, stale
  sections, `client_intelligence_input` and `authority_input` are identical,
  as are posts, creative / drafter / publisher / Authority counts and the
  publisher switch (off). `database.types.ts` regenerated from production is
  identical to the reviewed file.

## Social History (SH1 live Oct 8 2026, Lucas's 53 Facebook posts imported; SH2 live Oct 8 2026: migration `20261008024508` applied, `social-history` v2 deployed, Lucas profile v1 **proposed**, not approved)

A client's real published social posts, imported read-only, are evidence of
how the client writes and what performs. They are never grounding. Design,
approved decisions and the steps to the first import:
`docs/social-history.md`. Pilot: Lucas, Facebook, through Zernio.

- **Never grounding.** Historical posts never become claims, sources or
  evidence. No function, view or trigger outside the `social_history_*`
  family may read the history tables: the migration's verify block and the
  sandbox's `social_history.test.sql` enforce it. Do not add history to
  `client_intelligence_input` / `authority_input`.
- **Compass posts never feed style learning.** The database decides the
  `origin` (a match on platform id, URL or copy against `social_posts`).
  `social_history_learnable_posts` is the only input an analyzer may read.
- **Read-only Zernio.** `supabase/functions/social-history/zernio.ts` is the
  only Zernio client: GET only, four allowlisted paths. The key is
  `ZERNIO_READ_API_KEY` (a read-only, profile-scoped Zernio key). Never add
  a Zernio write, a publishing path or a write-capable key.
- **Writes.** Only the function's session writes history (`begin` /
  `record` / `finish`). A teammate only includes / excludes posts from
  learning. The function's modes are `version`, `plan` (the dry run, writes
  nothing) and `import` (an admin, or the operator door `x-cron-secret`;
  bound to the plan's account and Page). Re-running `import` is the metrics
  refresh: unchanged posts are no-ops, and new numbers append a snapshot.
- **Style profiles (SH2).** `analyze.ts` is a pure, deterministic analyzer
  over the learnable posts and the client's governed rules
  (`client_intelligence_input`, read only to mask). The function's `analyze`
  mode (any teammate or the operator door; `dry_run` writes nothing) records
  a **proposed** row in `social_history_style_profiles` through
  `social_history_style_record` (service session only; idempotent on the
  fingerprint; examples must be the client's own learnable posts).
- **A profile is active only once a teammate approves it** on Social ›
  Style: `social_history_style_review`, PostgREST teammate only, bound to the
  profile hash, refused with `SH409` when an example has left the learnable
  view. `social_history_style_approved()` is the only read for later use.
  Profile content is immutable; re-analysis makes a new version.
- **Performance is relative to the client's own history.** It is never
  computed without reach and never compared with generic benchmarks.
  Performance confidence is capped at medium on one snapshot. Example posts
  are masked with the drafter's detectors, plus unapproved places, urgency
  and the words to avoid.
- **Not built:** drafter use and the 90-day duplicate-copy guard (SH3), and
  Creative Engine use (SH4). Nothing reads a profile yet.

## Zernio Social Publisher v1 (Oct 10 2026; migration `20261010224407` applied; `post-publisher` v2 deployed; Lucas bound, publishing off)

Approved Facebook posts are published by the existing `post-publisher`
through Zernio. Compass is the system of record; Zernio is transport only.
Design, gates, endpoints and Lucas state: `docs/zernio-publisher.md`.

- **Routing:** `google_business` takes the Google path, unchanged. A
  `facebook` post goes through Zernio only when all of these hold: the
  publisher is on, the client is piloted, and the Page has a verified,
  enabled binding of the same client. Everything else gets the hand reminder
  as before.
- **Binding** lives on `social_accounts.publish_*`. It is explicit and never
  inferred.
  - Only the publisher's `zernio_bind` binds, through
    `publisher_bind_account`, after re-reading the account, its selected Page
    and its health with the publish key. Binding never enables.
  - Only a signed-in team admin enables, disables or unbinds.
  - The worker's SQL cannot write any of it.
- **Keys:** `ZERNIO_PUBLISH_API_KEY` is read only by `post-publisher`. Never
  reuse `ZERNIO_READ_API_KEY` for writes; the publisher refuses to run when
  the two keys are the same.
- **Only the approved snapshot is sent:** the exact copy and the Page id
  pinned. The image's stored bytes are re-hashed against the approved hash.
  0045's claim still re-checks the approval and grounding.
- **Never a second post:**
  - an `Idempotency-Key` of `compass-<publish_key>-g<n>`;
  - a write-ahead `uncertain` run;
  - a GET before any re-send;
  - a 409 duplicate is reconciled only when it is the exact copy on the same
    account.
- **Recorded published** only from Zernio's Facebook entry with an https
  `platformPostUrl`.
- **`publisher_runs`** records the transport and Zernio's post id, status,
  target and key, never a secret.
- **No-write preflight:** `{mode: "preflight", post_id | fixture}`.
- **Do not publish** a real Facebook post outside Tom's final steps in the
  doc.
- **Facebook drafts** (Oct 11 2026; migration `20261011040705`,
  `post-drafter` v3, `source-assets` v2; doc section "Facebook drafts"): the
  AI Drafter writes a standard Facebook post with no button on an explicitly
  named Page of the client (`socialAccountId`), at most one stored, hashed
  photo or `social_post` graphic, and submits it to review; one open draft
  per concept (copy, image). It never approves, schedules or publishes.
  `source-assets` `upload_slot` / `register` file generated graphics into
  private storage as unreviewed `social_post` assets marked non-evidentiary.
- **Business Profile drafts name their location** (`20261027190935`): a
  brief reads the client's verified Zernio locations, takes the one
  `socialAccountId` names (never a Page, an unverified or another client's
  row), the only one when none is named, and with several refuses until the
  draft names one. Until the Oct 29 2026 fix `post-drafter` loaded accounts
  for Facebook briefs only, so a named location was always refused as
  `social_account_unknown`; the weekly slot pilot drafted with it omitted.

## Business Profile through Zernio (Oct 11 2026; migration `20261011050000` not yet applied)

Business Profile posts can go through Zernio instead of directly to Google.
Design, gates and the steps for Lucas are in `docs/zernio-publisher.md`
("Business Profile through Zernio").

- **Exactly one publisher per post** (`gbp.ts gbpRoute`):
  - the approved snapshot names a location, or the client's transport
    (`publisher_client_transports`) is `zernio` → Zernio only, refused there
    when anything is missing, **never** sent directly to Google. Binding
    selects `zernio`; unbinding keeps it; only a team admin returns a client
    to `google` (`publisher_set_gbp_transport`), once unbound;
  - otherwise → the direct Google path, unchanged.
- **Binding:** one `locations/<id>` per client, on the client's
  `google_business` `social_accounts` row.
  - Recorded and bound only by the publisher (`zernio_gbp_bind` →
    `publisher_bind_gbp_location`) after re-reading the account, its locations
    and its health.
  - Binding never enables; a team admin switches it on.
- **The approval binds the destination.** A post approved without a location
  is reopened, saved and approved again; nothing rewrites an approval.
- **Shared Zernio machinery** (`zernio-path.ts`): idempotency, write-ahead
  runs, upload, reconciliation and tasks for Facebook and Business Profile
  alike. Runs record the pinned `target_location_id`; a binding that changes
  in flight goes to a person. A same-key re-send re-checks every write gate
  (binding on and healthy, content, approval and grounding) first.
- **Scope:** standard posts — text, one JPEG/PNG image (≤ 5 MB, ≥ 400 × 300)
  and a linked button. Offer and event posts and Call buttons are refused
  explicitly.
- **Illustrative graphics** (Oct 15 2026, `post-drafter` v7, feature
  `gbp_social_graphics`): a Business Profile draft may carry one stored
  `social_post` graphic instead of a photo, as Facebook drafts already could.
  A graphic is presentation, never evidence: it supports no claim, is never
  shown as the client's work (the post page labels it), and still passes the
  publisher's format, size and dimension preflight. No schema change.

## Compass Communications (0063 applied Oct 2 2026 as `20261002211041`; functions deployed; issue #88)

Twilio SMS per client, piloted with BHG Safety Partners. Full design, flows
and the remaining manual Twilio steps: `docs/communications.md`.

- **Twilio shape:** Compass's parent account (ISV) holds one **subaccount
  per client**. Vault: the parent's **Main** API key (`TWILIO_ACCOUNT_SID` /
  `TWILIO_API_KEY` / `TWILIO_API_SECRET`), used only on the parent's own
  `/Accounts.json` (create, list / find a subaccount — Twilio denies a
  parent API key every subaccount resource with 20404); per subaccount its
  own Standard key (minted with the subaccount's own Auth Token) and its
  Auth Token (`TWILIO_SUB_<AC…>_API_KEY` / `_API_SECRET` / `_AUTH_TOKEN`;
  the token copied from the Twilio Console by hand). Every client operation uses the subaccount's key. No
  credential is an env var, a column, a response or a log line; no EIN is
  stored anywhere.
- **Functions:** `communications` (team JWT; admin modes check
  `team_members.role = 'admin'`: create / link subaccount, Messaging Service,
  purchase / link / attach numbers; any teammate: send, search, sync
  compliance) and `twilio-webhook` (`verify_jwt = false`; official-SDK
  signature validation with the subaccount's Auth Token;
  `/messages/inbound`, `/messages/status?m=<id>`). Both are `handler.ts`
  factories; REST to Twilio is `_shared/communications/twilio.ts` over
  injected fetch.
- **Schema rules:** messages, conversations, consents and the Twilio
  registry are written only by 0063's functions (not by teammates, the
  service role directly, or the worker's SQL). Consent is separate from a
  phone number: sending needs `granted` consent under a lock; STOP / 21610
  opt the recipient out and only their START lifts it. Inbound is idempotent
  on `MessageSid`; delivery status only moves forward. `contacts` are the
  client's own customers (not `client_contacts`). Team-only RLS, no portal
  view.
- **UI:** client tab **Communications** (Overview, Inbox, Numbers,
  Compliance, Settings). Per-client switch `client_communication_settings`
  (no row = off; only a teammate turns sending on).
- **Tests:** `npm test` (handler, webhook with real SDK signatures,
  provider, lib), the sandbox's `communications.test.sql`,
  `npm run test:communications` (real handlers over PostgREST, fake Twilio),
  `npm run test:communications-ui`.
- **BHG:** `supabase/seeds/clients/bhg-safety-partners-communications.sql`
  (data only, sending off; not run yet).
- **Production (Oct 2 2026):** 0063 applied as `20261002211041` (recorded
  SQL identical to the file, md5 `bcb710b3…`; dry run first, rolled back).
  Verified after applying: 11 tables with RLS and only the `is_team()`
  policy, grants as designed (anon none; function-only tables select-only),
  25 functions with their execute grants, guard / history / `updated_at`
  triggers, no portal view reference, every non-Communications function /
  column / policy / trigger fingerprint unchanged, and rolled-back probes
  refused the worker's SQL (with and without the write flag, SET ROLE
  service_role, SET ROLE authenticated + team JWT), anon and a non-team
  sign-in. `communications` v1 (`verify_jwt = true`) and `twilio-webhook`
  v1 (`verify_jwt = false`) deployed through the Supabase MCP from the PR
  branch (the workflow deploys only `main`); unsigned / forged webhooks
  answer 403. `database.types.ts` regenerated from production. No Twilio
  secret is in Vault, no subaccount or number exists, no row is in any
  Communications table and nothing has been sent.
- **0065 (applied Oct 5 2026 as `20261005033418`; `communications` v2 and
  `twilio-webhook` v2 deployed through the Supabase MCP).** The BHG link
  failed because the functions looked up `TWILIO_SUB_<sid>_AUTH_TOKEN` by
  the exact SID the request carried, and Twilio never returns a
  subaccount's Auth Token to an API key, so the token is stored by hand.
  Now: `communication_subaccount_secrets(<AC…>)` (service role only) reads
  a subaccount's key, secret and token by SID (exact name, else the single
  case-insensitive match, trimmed) and reports the expected names and the
  other SIDs holding a token; `communication_secret_status()` gives the
  pages yes / no and the expected name; Twilio SID checks accept
  `[0-9a-fA-F]` (five constraints and three record functions rebuilt
  unchanged otherwise). `create_subaccount` refuses when Twilio already
  has a `Compass - <name>` subaccount and records a created one at once
  (207 partial when the token or key is missing); `link_subaccount`
  registers nothing until the token is in Vault (409 naming it). Errors
  are 424 / 409 / 207 rather than 5xx (the gateway replaces 5xx bodies).
  Tests: the sandbox's `communications_secrets.test.sql` (a 56-character
  dynamic name through `get_secret` as service_role),
  `tests/communications-store.test.mjs`, and the handler / integration /
  UI suites.
- **`communications` v3 (deployed Oct 6 2026).** The BHG link then failed
  with Twilio 20404 on `GET /Accounts/<sub>.json`: a parent API key may
  touch only main-account resources, never a subaccount's (Twilio's
  subaccount docs). `link_subaccount` now finds the SID in the parent's own
  `/Accounts.json` list (paged, any letter case; owner must be the parent,
  status not closed; 409 `not_in_parent` / `not_a_subaccount` /
  `subaccount_closed`), and the subaccount's Standard key is minted with the
  subaccount's own SID + Auth Token from Vault (the parent key would get
  20404 on `/Accounts/<sub>/Keys.json` too). `create_subaccount` without a
  returned token registers the subaccount and answers 207 with `key:
  "waiting_for_auth_token"`; the link finishes it. Tests: the handler,
  provider (a fake Twilio that answers 20404 to the parent key on any
  subaccount resource) and integration suites.

## CRM Lite (Oct 11 2026; `20261012002616_crm_lite.sql` applied Oct 12 2026 as `20261012002616`)

Website inquiries saved in Compass, a New → Contacted → Closed workspace for
the agency (Client › **Inquiries**) and the client's own portal sign-in
(`/portal/inquiries`), and SMS inquiry alerts built with sending disabled.
Pilot: Ginger Huff Interiors (`supabase/seeds/clients/ginger-huff-crm-lite.sql`).
Design, gates, setup, rollback: `docs/crm-lite.md`. The Supabase connector
refuses some SQL shapes (`…);` then `update … set`, `drop …`): a migration
that times out never reached Postgres; stage it and apply as
`docs/crm-lite.md` › "Applying the migration" describes.

- **Website recovery:** Ginger website PR #1 (`94c2fef`) persists validated
  inquiries in a private Vercel Blob outbox before success, delivers in a
  background task, and retries via a secret-authenticated five-minute cron.
  It preserves email receipts to avoid duplicate sends and retains failed work.
  See `docs/crm-lite.md` for the rollout checkpoint and remaining blockers.
- **Intake** is `inquiry-intake` (`verify_jwt = false`): a website server
  sends `X-Compass-Source` plus that source's Bearer token (Vault,
  `inquiry_sources.secret_name`, issued once by an admin through `crm-lite`).
  **The client is the source's**, never a value in the request. One inquiry
  per (source, submission id) by unique key; contacts (0063's `contacts`) are
  matched by email / phone within the client only.
- **Writes** to inquiries, notes, history and the outbox happen only inside
  the `crm_*` functions. Status / notes: a teammate, or a portal contact of
  the inquiry's own client while `crm_lite_settings.portal_enabled` is on.
  Four portal views (`portal_crm_lite`, `portal_inquiries`,
  `portal_inquiry_notes`, `portal_inquiry_events`) filter by
  `portal_client_id()`.
- **SMS stays off** until an admin records the sender's toll-free
  verification approved, consent is complete (date, method, actual response,
  disclosure acknowledged; a teammate only, never automatic), an admin
  confirms a delivered test, and an admin switches the client on
  (`crm_set_sms_alerts`). A job created while a gate is closed is `blocked`
  for good: no old inquiries are ever texted. Unknown send outcomes are
  reconciled against Twilio before any resend. STOP to the sender blocks
  every client's alerts to that phone. Compass's own sender ("Compass -
  Notifications" subaccount) uses the 0065 Vault names; BHG's is never used.
- **Do not** send texts, record Ginger's consent from assumptions, approve the
  sender before Twilio does, or invite / reset portal users as part of
  CRM Lite work.

## Authority runs (D2; 0048 applied Sept 25 2026; `authority-run` deployed, engine `authority-v1.3` in production since Sept 27 2026)

The deterministic Authority Engine (`supabase/functions/authority/`, D1.1)
recorded as runs. **`authority-run`** (`handler.ts` factory, `store.ts`,
`classify.ts` pure rules, `index.ts`): modes `version` (engine, limits,
whether DNS resolves here), `full` (fresh read-only site inventory) and
`refresh` (reuses the latest completed run's inventory; `409 needs_full_run`
without one). Callers: a team JWT or `x-cron-secret`; `verify_jwt = true`.
It answers `202 {run_id}` after `authority_begin_run` (a running run is a
real `409 run_in_progress`), then in the background reads
`authority_fingerprint` **before** `authority_input`, inventories, runs the
engine, classifies and calls `authority_record_run` once; an exception
records the run `failed`. It writes nothing else. **Degraded:** the home page
not 2xx, ≥ 25% of requested URLs erroring (no answer or 5xx; a 404 is a
finding), or the inventory budget exceeded; no site URL completes with no
inventory. **Inventory limits** (`INVENTORY_LIMITS`): 150 URLs, 4 at a time,
20 s per request, 120 s overall, 2 MB per body, 4,000 characters of text.
**Address guard** (`authority/netguard.ts`): every request, each same-host
redirect hop included, resolves the host first and is refused unless every
A / AAAA answer is public (loopback, private, link-local, CGNAT, reserved,
documentation, multicast, and IPv4 inside IPv6 all refused); no resolver
fails closed. DNS rebinding between the check and fetch's own lookup is the
accepted residual. Deploy with the Supabase CLI (`supabase functions deploy
authority-run`; the gazetteer makes the bundle too large for the connector),
through the `deploy-supabase-function.yml` workflow (`function_name`,
`expected_sha` = main's HEAD, `confirm = DEPLOY`); check the deployed engine
with body `{"mode": "version"}` before any run.
Tests: `npm test` (`authority-run-handler`, `authority-netguard`),
`npm run test:authority` (the real handler and store over the sandbox replay
+ PostgREST, fake site and DNS), the sandbox's `authority.test.sql`.
**Authority tab** (`/clients/[clientId]/authority`, read-only checkpoint):
the latest completed run as a work queue. `src/lib/authority-view.ts` (pure;
`tests/authority-view.test.mjs` over the trimmed production Lucas export in
`tests/fixtures/authority-lucas-run.json`) groups and labels what the engine
decided: Fix Now by tier (A open, B / C collapsed), Ready now vs waiting on
cadence, decisions as Services / Markets / Intent conflicts, research (first
three), Blocked grouped by the prerequisite that unblocks it, Avoid collapsed;
details, gates and lifecycle behind a collapsed Details. Reads are the
teammate's own (`authority_latest`, `authority_runs`,
`authority_opportunity_state`, `authority_opportunity_events`). Browser
check: `npm run test:authority-ui`; screenshots in `docs/screenshots/authority/`.
**Run controls** (`src/lib/authority-controls.ts` rules,
`src/app/authority-actions.ts`, `authority-run-controls.tsx` /
`authority-run-watcher.tsx`): **Run Full Analysis** and **Refresh** call the
deployed `authority-run` with the signed-in teammate's JWT (the action checks
`team_members` first and writes nothing itself). Refresh is disabled with no
completed run, a changed site record or a snapshot over 14 days old, and is
the primary when only CRM / Search Console data changed; both are disabled
while a run is running, and a run left `running` 15 minutes is shown as stuck
(the next begin fails it). The watcher polls the run's status every 3 s only
while it runs, pauses while the tab is hidden, stops after 3 minutes, and
refreshes the page once when the run finishes (completed / degraded / failed
message). A 409 `run_in_progress` shows and watches the running run; a
timeout, network error or 5xx says it could not confirm the start and
refreshes the page to show a run if one began. No decisions, scheduling or
Drafter hand-off. Browser check: `npm run test:authority-controls-ui` (the
real handler and store behind the gateway, fake site and DNS).
**Lifecycle actions** (Decisions PR A; `src/lib/authority-lifecycle.ts` rules,
`decideAuthorityAction` in `src/app/authority-actions.ts`,
`opportunity-lifecycle.tsx`): Accept, Release, Dismiss for 30 / 60 / 90 days
(reason required; the end date is computed server-side on the Chicago
calendar), Never recommend again (reason plus a "permanent until reopened"
acknowledgement) and Reopen, all through 0048's `authority_decide` as the
signed-in teammate (`requireTeamMember` first). The request carries the
page's snapshot of the stored workflow; a mismatch (second tab, repeat
click) is refused as "changed since the page loaded". Authority workflow
only: no client data changes and no analysis starts. Each card shows a
status chip; dismissed and never-recommend items move to a collapsed
**Dismissed** group (with Reopen) and leave the summary counts; Details
shows the history with who, reason and date. Offboarded clients get no
actions. Tests: `tests/authority-lifecycle.test.mjs`, the sandbox's
`authority_lifecycle.test.sql`, `npm run test:authority-lifecycle-ui`.
**Decisions** (Decisions PR B; migration **0049, applied Sept 27 2026 as
`20260927162712`**;
`src/lib/authority-decisions.ts` rules, `src/app/authority-decision-actions.ts`,
`opportunity-decisions.tsx`): Keep current intent / Change to the
recommended intent, Approve / Decline / Later for a market, Confirm service /
Not offered, and Create task, each previewed (before → after) and applied by
`authority_apply(opportunity, action, payload, expected)`, which runs with
the caller's rights (RLS on every client-data write), refuses anyone but a
signed-in teammate through PostgREST, locks the opportunity
(`authority_lock_opportunity`) and the rows it writes, refuses with
SQLSTATE `AU409` when anything differs from the preview, and writes the
client-data change with its decision / suppression / link through
`authority_decide` in one transaction. Keep current intent is a suppression
bound to the reviewed recommendation (`authority_opportunities.suppression_basis`
= keyword, stored and assessed intent); `authority_record_run` lifts it only
when a later completed run recommends something materially different.
Decline market and Not offered write no Client Intelligence record and say
so ("Authority decision only; no Client Intelligence record created.").
Create task inserts a TOM task keyed `authority:<opportunity key>` and links
it atomically. Markets act only on ticked rows (at most 25, one transaction
each, one refresh). After a client-data change (set intent, approve market,
confirm service) the app starts an Authority **refresh** (never a full
crawl; skipped with a note when the site snapshot needs one), followed by
the page's shared run watcher (`authority-run-context.tsx`). No website,
`change_log`, Drafter or portal writes. Tests: `tests/authority-decisions.test.mjs`,
the sandbox's `authority_apply.test.sql`, `npm run test:authority-decisions-ui`
(a real engine run over a fake site). Verified on production after
applying: the recorded SQL and every function body match the file (md5),
grants as designed, and rolled-back probes refused the worker's SQL (also
with a team JWT), the service role, a non-team sign-in and anon;
`database.types.ts` was regenerated from production.
**Reconciliation** (Decisions PR C1; migration **0050, applied Sept 27
2026 as `20260927173308`**; database only, no UI yet): four more `authority_apply` actions for
the data fixes the engine already reports, with 0049's guarantees (caller's
RLS, teammate through PostgREST only, rows locked, `AU409` when anything
differs from the preview, the write and its decision event in one
transaction). Every page check reads the stored site snapshot of the run
that last reported the opportunity (`authority_page_state`,
`authority_norm_path` — a port of `authority/urls.ts` normPath pinned by
`tests/fixtures/authority-norm-path-vectors.json`). Batches are 1-25
explicitly selected rows that must equal the preview's
(`authority_selected_rows`).
`set_service_page` sets `services.page_url` to the approved service page
group's live target. `rehome_keywords` moves keywords the analysis flags
`homepage_pollution` to the service's live page, or to the one approved
Home page group (keyword unassigned from the service, added to the group's
supporting ids) **only when the run flags the keyword `home_eligible`** —
the engine does not emit that flag until PR C3, so Home re-homing is
refused until then. `record_content` records selected live blog pages
missing from `content_posts` as `origin = 'site_inventory'` (published, no
date, "Not produced by Compass."), skips URLs already recorded, serialises
per client with an advisory lock and links each row. `map_keywords` gives
an unmapped keyword an approved service only when that service's page group
target is live (no temporary mappings; Roof Repair / Storm Damage stay
unavailable until their pages exist). **Provenance:** `content_posts.origin`
is `compass` (default, every existing row) or `site_inventory`, fixed once
set (trigger, 42501). Compass-work views show `compass` only: the portal
work log (`portal_work_log` filter), the Reports tab's cycle counts, the
Content tab tracker (which notes how many pages were recorded) and the
worker's report Activity; `authority_input` counts both. Tests: the
sandbox's `authority_reconcile.test.sql`, `tests/authority-norm-path.test.mjs`,
`npm run test:content-origin-ui`. Verified on production after applying: the
recorded SQL and every function body match the file (md5), grants as
designed, all 8 existing `content_posts` rows are `compass`, rolled-back
probes refused the worker's SQL (also with a team JWT), the service role,
anon and a portal contact, and a rolled-back portal contact saw a Compass
post but not a `site_inventory` one; no client or Authority data changed;
`database.types.ts` was regenerated from production.
**Home ownership** (C3, introduced in engine `authority-v1.2`; engine only, no
schema; in production since Sept 27 2026, now as part of v1.3): the approved Home page group
may govern broad brand / category keywords (`authority/home.ts`, pure).
Considered only for keywords the Home group lists or that are mapped to a
service yet target `/` — never an arbitrary unmapped keyword — and only when
exactly one approved Home group targets a live `/`. A query is Home's
(`home_eligible`) when every word is the brand, the home city / state, the
category (from the Home group's primary keyword) or a fixed company /
qualifier word; any service word, activity or material keeps it with its
service; an unknown word, another approved or unapproved place, a city /
hub / other page group that also lists it, or a service named for the
category itself makes it `home_ambiguous` and a `confirm_owner:<keyword_id>`
decision (Needs Decision › Ownership, read-only). A Home-group keyword with no
service gets role `home` (not unmapped; stricter roles still win). The
keyword-ownership fix now splits its keywords to Home / the service page /
decision, with a `home_destination` gate; `report.home` summarises. Lucas
(read-only dry run over the production input and stored snapshot): 14
`home_eligible`, 1 `home_ambiguous` (`roofer in wentzville mo`, claimed by the
Wentzville city page), 3 service-specific; all 68 opportunity keys kept, one
`confirm_owner` added; no role changes. Tests: `tests/authority-home.test.mjs`
over `tests/fixtures/authority-lucas-home.json`, `npm run test:authority`,
`npm run test:authority-ui`. **0051** (applied Sept 27 2026 as `20260927193245`; recorded SQL and the
`authority_apply` body match the file by md5) makes 0050's Home re-home
atomic: the keyword leaves every service / hub page group's supporting list
in the same transaction that gives it to Home; a service's primary keyword is
refused; the sandbox's `authority_home_cleanup.test.sql`. Apply 0051 before
any real Home re-home.
**Reconciliation UI** (C2; **live since Sept 27 2026**: PR #77 merged as
`261829d` and deployed to Vercel production; migration **0052 applied as
`20260927212625`** — recorded SQL and the `authority_apply` body match the
file by md5, grants unchanged, rolled-back probes refused the worker's SQL
(also with a team JWT), the service role, anon, a portal contact and a
non-team sign-in, types unchanged; `authority-run` redeployed from that
commit and reporting engine **`authority-v1.3`**): a **Reconcile** control on each of the four data-fix cards (Set service page,
Re-home keywords, Record pages, Map keywords; `opportunity-reconcile.tsx`),
rules in `src/lib/authority-reconcile.ts` (pure), `previewReconcileAction` /
`applyReconcileAction` in `src/app/authority-decision-actions.ts`. The
preview reads what `authority_apply` will read (the run's `report.keywords`,
the stored snapshot through `authority_page_state`, `authority_service_group`)
and lists every field each row writes, before → after; rows start unticked,
there is no Select All, at most 25; unavailable rows stay visible with the
reason and a link to the decision that unblocks them (Ownership, the market).
The apply sends exactly the ticked rows to `authority_apply` as the signed-in
teammate (one transaction per batch), then one Authority **refresh**, never a
full analysis. **0052** binds each write to the preview: `set_service_page`
needs `expected.target_url`, every re-home / map row its `destination_url`,
a Home re-home its `removed_from` page-group ids; any mismatch or missing
field is AU409 and nothing is written. It also refuses to map a keyword the
analysis flags `location_unapproved` ("This keyword references an unapproved
market. Decide on that market first.") until the market is approved and a
refresh clears the flag. **v1.3** adds structured data only (keys, sections,
tiers and every other field unchanged): `candidate_paths` on
`data_fix:record-live-blog-posts` (the rows Record pages offers; reason text
is display-only, never a write source) and `unapproved_places` on each
keyword. A run from before v1.3 has no `candidate_paths`, so Record pages
asks for a refresh first. **Partial recording:** while the latest analysis
still lists pages, the card reads "Partly recorded · N remaining" (or
"Recorded · awaiting refresh") and keeps its control, although the stored
lifecycle says completed once any page is linked; the analysis confirms
completion by no longer reporting it. Tests: `tests/authority-reconcile.test.mjs`,
the sandbox's `authority_bind_preview.test.sql`, `npm run test:authority-reconcile-ui`.
**Lucas after the rollout** (one Refresh, run `082e8e2a-94cf-4b03-b385-2c7cd7fb239b`,
v1.3, reusing the stored inventory): 69 opportunities with the same keys,
sections, tiers, gaps, reasons and keyword roles as the v1.2 run; 14
`home_eligible`, 1 `confirm_owner` (Ownership) decision; 5 structured
`candidate_paths` on record-content; 13 of 26 unmapped keywords blocked by
the unapproved-market rule. **No real reconciliation has been performed for
Lucas yet**: no service page set, keyword re-homed or mapped, page recorded,
market decided or Authority task created; Lucas's keywords, services, page
groups, locations, content posts and Authority workflow are unchanged.
`gsc-sync` pages rows with `startRow` since Sept 25 2026 (PR #68, v5;
`_shared/gsc-paging.ts`, 1,000 per page, safety cap 10,000, logged when
reached); Authority labels a window at the cap, or a legacy window of
exactly 250, `partial`.

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

## Content Planner (0065 written, not applied; Oct 4 2026)

The weekly production view of the Production MVP sprint: per managed
client, **Social X/2 | GBP X/2 | Blogs X/2 | Web Pages X/1**, where X is
approved or delivered pieces. The targets (`WEEKLY_TARGETS` in
`src/lib/content-planner.ts`) are a cadence, not a quota. Full model,
statuses, the scoped next slices and go-live: `docs/content-planner.md`.

- **0065:** `content_plan_items` holds one planned piece per client and week
  (Monday).
  - Fields: deliverable, channel, purpose (the seven), topic, intent,
    keyword, service, Authority opportunity (exactly when the purpose is
    `authority`), target page, planned date, and the linked post / blog.
  - A hold (`blocked` with a reason, or `delivered`) plus the delivered
    link.
  - `content_plan_board` (security invoker) derives the status:
    blocked → delivered → approved → in_review → drafting →
    ready_to_generate → planned.
  - Team only. It touches no Billing object; Billing's quota counts the
    posts and blogs themselves.
  - **Not applied.** The planner types in `database.types.ts` are
    hand-written until 0065 is applied and the types are regenerated.
- **Pages:** **Production** (main nav, `/production`) for all clients'
  week, and the client **Planner** tab (`/clients/[id]/planner`).
  - Plan items per slot; **From Authority** plans a ready opportunity with
    its topic, intent, service and target page.
  - Link an existing draft, block / mark delivered, edit, remove.
  - Generating from the plan, and the Blog and Web Page Drafters, are
    scoped there and not built.
- **Tests:** `tests/content-planner.test.mjs`, the sandbox's
  `content_planner.test.sql` (41), `npm run test:planner-ui` (11).

## Blog Drafter v1 (0066–0068 written, not applied; Oct 4 2026)

Planner / Authority → **Generate draft** → the worker writes it through the
`content-drafter` function → human review → **Approve** → ONE final
`content_posts` row → Copy / Download Markdown. Full design, rules, tests and
go-live: `docs/blog-drafter.md`.

- **0066** adds `content_status` `approved`, in its own migration (a new
  enum value cannot be used in the transaction that adds it).
- **0067** `content_drafts` + `content_draft_claims` are the mutable
  drafting state for blogs, and next web pages.
  - **Draft attempts never touch `content_posts`, so Billing never counts
    one.**
  - `content_draft_approve` is version-pinned and idempotent: one row per
    draft, updated on re-approval.
  - Generated content arrives only through `content_draft_write`, in the
    drafter session. Only a teammate approves.
  - `content_draft_request` / `_regenerate` / `_approve` are team-callable
    security-definer functions on the portal suite's reviewed list.
  - Web pages will finalize to ONE `change_log` row (`page_added` /
    `page_rewrite`; Tom, Oct 4). That promotion is the Web Page Drafter's;
    not built.
- **`content-drafter`** (Edge Function, not deployed; on the deploy list)
  reuses `post-drafter`'s loader, gate, claim rule (`eligibleClaims`),
  detectors and place rule, on every word a reader sees, plus blog
  structure and approved-page links. The worker's playbook is *Content
  draft request*.
- **Pages:** the planner's **Generate draft** / **Open the draft**, and
  `/clients/[id]/drafts/[draftId]` (preview, claims, review, edit,
  regenerate, Copy Markdown, Download .md).
- **0068 (completion rules; Tom, Oct 4):** a blog completes only at
  approval.
  - The weekly `blog_post` task opens a draft (`content-drafter` `open` →
    `content_draft_open_weekly`) in that week's Planner slot, and stays open
    until approval closes it with the final row.
  - Reopening returns the final row to `draft`: the slot stops counting, and
    Billing's count is unchanged.
- **Binding claims (20261015175146, applied Oct 15 2026).**
  After the Logic Solar incident (the Routine overwrote an operator's
  claimed draft), a writer claims a draft with
  `content_draft_claim(draft_id, claimant)`. Only service_role and the
  worker can call it.
  - It records `tasks.claimed_by` / `claimed_at` on the draft's request task
    (or its weekly `blog_post` task). The claim holds for an hour.
  - `content-drafter` brief / check / submit take a `claimant`.
    `content_draft_write` refuses another claimant's live claim with CD409,
    which the function returns as `409 claimed_by_other`.
  - Unclaimed tasks write as before. The Routine claims as
    `worker-routine`.
  - Ship in this order: apply the migration, merge (the skill goes live
    with it), then deploy `content-drafter` from main at once. Until it
    answers v5 with `claims`, the worker's preflight stops without writing.
- **Not yet:** the Web Page Drafter.

## Delegated content approval (Oct 19 2026; `20261019190532` applied, `20261019202359` applied; `content-approvals`)

Tom can say "Approve and publish Logic Blogs A, B and C" or "Approve the Lucas
Facebook posts" in ChatGPT or Claude, and the assistant completes the existing
workflow through Executive OS's `content_review_batch` / `content_approve` /
`content_approval_status` tools. Full design, and which channels publish
today: `docs/delegated-content-approval.md`.

- **Delegated, not impersonated.** `content-approvals` (key:
  `x-compass-delegation-key` = Vault `EXECUTIVE_OS_DELEGATION_SECRET`, nothing
  else) records a receipt (`content_approval_authorizations`, unique
  `operation_id`, verbatim words, channel, account, executing assistant,
  each item's channel, review hash and destination — website, Page or
  location — and the time), then executes it in one transaction through the
  unchanged blog functions and the social review gate / existing schedule.
  The gates accept a receipt only while it is `executing` in the same
  transaction, for items in its scope.
- **Channels (20261019202359):** blogs, Facebook, Business Profile, for every
  client under one central policy (`content_delegation_settings` +
  `content_delegation_exclusions`; admin-only `content_delegation_configure` /
  `_exclude` / `_include`; paused and offboarded clients never). Publishing a
  post is allowed only where `post-publisher` itself would send it (switch,
  pilot list, verified enabled healthy Zernio binding): Lucas only today;
  approval works everywhere.
- Reviewer / releaser of record is the authorizing admin's `team_members.id`;
  the note names the assistant and channel. "approve" never publishes; it is
  never unattended — every item or batch needs Tom's own words.
- The Compass buttons are unchanged and remain the primary path.

## Delegated post edits (Oct 20 2026; `20261020200000` written, **not applied**; `content-approvals` v3 not deployed)

Tom: "I don't want to have to withdraw them, I want you 2 to handle these kind
of edits." Claude / ChatGPT, through Executive OS (`content_stage_media`,
`content_revise`, `content_revision_status`), revise ONE Facebook / Business
Profile post in review: withdraw → replace media with bytes the function
measured → resubmit for a fresh review, in one transaction under a
`content_edit_receipts` row. Never approves, schedules or publishes; refuses
approved, scheduled and published posts. Full design: `docs/delegated-post-edits.md`.

- **Copy edits** (`20261029180000`, content-approvals v4, Oct 29 2026): a second
  change kind, `replace_copy {copy, claim_ids}`, on the same door. The function
  lints the copy against a brief rebuilt for the post's own target (the
  post-drafter's `buildBrief` / `lintDraft`); execute refuses anything not
  checked clean or not the receipt's copy, and any claim that is not a usable
  claim of the client, then withdraws, sets the copy, links exactly those
  claims and resubmits. The authority must list `replace_copy`. Executive OS's
  `content_revise` needs the matching change before it can be called.

- Identity is the executing receipt in THIS transaction (`content_edit_receipt()`,
  txid-bound, service role) — never a session flag alone. History records
  `actor_kind = 'assistant'` with the receipt and no person; `updated_by` is the
  authorizing admin.
- Policy: `content_delegation_settings.allow_edit` (seeded on; admin-only
  `content_delegation_configure_edits`) plus the existing exclusions; the post's
  channel / service must be inside the authority Executive OS sends.

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

## Citations Phase 1 (released Oct 21 2026)

Provider-neutral listing inventory: approved identity per actual business
location (`citation_locations`, hidden-address flag, versioned history),
directory registry, listings, append-only teammate checks, the correction /
verification queue, manual fulfillment requests (admin approval, cash and
prepaid credits apart) and a generic mapped CSV import with a rolled-back
preview (`citation_import()`). Provider fulfillment never sets verification;
"not found" is not absence. Behind the server-only `CITATIONS_ENABLED` flag
(`src/lib/citations-flag.ts`), set to `true` in Vercel Production at the Oct 21
release; migration `20261021160410_citations_foundation.sql` is applied
(recorded version 20261021160410, byte-identical to the file). The pilot is
Logic Solar Overland Park only (public address). No provider calls, crawling or
spend; all imported listings stay independently unverified. Full notes, mapping, rollback and cost
measurement points: `docs/citations.md`.
