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
  https://compass-crm-ten.vercel.app.
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

## Known state / open items (as of Aug 31 2026)

- **Stripe secrets are not in Vault yet.** Billing code is deployed but inert
  until `STRIPE_SECRET_KEY` is added to Supabase Vault, a webhook endpoint
  pointing at `/functions/v1/stripe-webhook` is created in the Stripe
  dashboard (events: `invoice.paid`, `invoice.payment_failed`,
  `payment_intent.processing`, `customer.subscription.updated`,
  `customer.subscription.deleted`), and its signing secret is stored as
  `STRIPE_WEBHOOK_SECRET`. No Stripe objects have been created.

- **BrightLocal key is a trial** — 1,000 lifetime requests, ~50 per monthly
  sync. Get a production key before that runs out.
- **Keyword priorities are unset.** The City Index is specified as the average
  of P1 keywords but currently falls back to *all* active keywords because no
  P1s exist yet. Setting priorities in the Keywords tab makes it behave per spec.
- **GSC coverage is partial.** Logic Solar, Lucas Construction, Ginger Huff and
  Show Me Design sync. Show Me Electrical's property exists but Google has no
  data for it at all (likely created recently — GSC does not backfill).
  Pensacola Equipment Rentals has no Search Console property; one needs to be
  created and verified.
- **Client seed data is partial** — several clients still need enrolled
  pipelines, plan details, and contacts filled in. Pensacola also has no
  `website_url`.
