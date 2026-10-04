# Billing and the shared service-role credential — options and recommendation

Production-readiness review, Sept 30 2026.

> **DECISION (approved Sept 30 2026 by Tom and ChatGPT):** Option A is
> accepted **for Stripe TEST MODE only**. **Hard go-live rule:** no live
> Stripe secret may ever be placed in the shared Supabase Edge Function /
> Vault architecture. Before any real client billing (a recurring charge,
> a card payment or an ACH debit), Option B must be implemented and
> reviewed: a dedicated billing runtime, billing-only Stripe credentials
> and a dedicated least-privilege database role.
>
> **STATUS (Oct 4 2026): Option B is built** — `billing/` (the
> `compass-billing` Vercel project), migration `0064_billing_runtime.sql`
> (the `billing_sync` login and the boundary switch) and the CRM's
> `BILLING_API_URL` switch. It stays a go-live blocker until it is deployed
> and verified per `docs/billing-runtime.md`, which also records where the
> build differs from the shape below.

## The problem, exactly

Every Supabase Edge Function in project `iokcopiyzajigvhwexhe` receives the
same `SUPABASE_SERVICE_ROLE_KEY`. Supabase has no per-function secrets:
function secrets and Vault are project-wide. The key belongs to these 16
functions (15 deployed today plus `stripe-reconcile`):

- **Sync:** `brightlocal-sync`, `gsc-sync`, `rank-sync`
- **Brand and provisioning:** `brand-scan`, `client-provision`
- **Site, Google and portal:** `site-push`, `google-ops`, `google-connect`, `portal-invite`
- **Posts, Authority and assets:** `post-publisher`, `post-drafter`, `authority-run`, `source-assets`
- **Billing:** `stripe-webhook`, `stripe-billing`, `stripe-reconcile`

(the Creative Engine's `creative-engine` would be the 17th).

B2's write boundary (`billing_caller_is_service()`: `session_user =
authenticator` and role `service_role`) keeps teammates, portal contacts,
anon and the worker's SQL out of the billing write functions. It **cannot**
tell one Edge Function from another: they all present the same role.

**Two holders are more privileged than the Edge Functions:**

1. **The Stripe secret is in Vault.** The three billing functions read
   `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and
   `BILLING_RECONCILE_SECRET` through `get_secret()`. That function is
   executable by `service_role`, so **any** Edge Function can read the Stripe
   key, not just call the billing RPCs.
2. **The worker's SQL.** The Foundation worker and every Claude session run
   the Supabase connector's `execute_sql` as `postgres`. `postgres` owns
   `get_secret()`, so it can read the Stripe key too. The billing write
   boundary refuses its writes to billing tables, but it can read Vault.

## Option A: accept the shared trust boundary for v1

**What a compromised or buggy unrelated Edge Function could do.** Examples:
a malicious dependency in `brand-scan`, or a code-injection bug in `site-push`.

- **In the database, with only the service key:**
  - Write any billing mirror row through `billing_sync_apply`: fake "paid"
    invoices, active subscriptions, a wrong MRR.
  - Link a Stripe customer to the wrong client (`billing_link_customer`).
  - Record or void external payments, attributed to any `actor_team_member_id`
    it chooses.
  - Append forged `billing_audit_events`, and record reconciliation runs.
  - Change agreements and entitlements directly. `service_role` bypasses RLS,
    and `plans` / `client_entitlement_overrides` are not guarded, so it could
    change what automation plans for a client.
  - Read every billing row: client names, amounts, and the last 4 digits and
    type of each payment method. Stripe holds no full card data in Compass.
- **In Stripe, with the key read from Vault** (test mode: fake money only;
  live mode: real money):
  - list customers and their billing addresses
  - issue refunds
  - charge a saved payment method
  - cancel subscriptions
  - change prices and create Checkout sessions
- **What it could not do:**
  - Webhooks: fake a webhook without the webhook secret. (It can read that
    secret from Vault too, but the webhook only re-fetches objects from
    Stripe, never trusts the payload.)
  - Card numbers: read full card numbers, which never reach Compass.

**What mitigates it today:**

- **Deploys are gated.** Every function deploys through
  `deploy-supabase-function.yml`, which needs `expected_sha` equal to
  `main`'s HEAD and `confirm = DEPLOY`. Only merged code reaches production.
- **Branch protection and review.** Every merge to `main` needs review
  (Tom + ChatGPT), and `main` runs the CI `validate` job.
- **Few dependencies and no user code.** The functions have few
  third-party dependencies (Deno std, supabase-js, no npm tree in most) and
  no user-supplied code execution.
- **Detection.** Stripe is the source of truth: reconciliation (B4)
  overwrites mirror tampering on its next run, and Stripe's own dashboard
  and audit log record every API call made with the key.
- **Test mode first.** A test key moves no money.

**Why it may be acceptable, temporarily:** for **Stripe test mode**, yes. The
worst case is fake data in a test account and a mirror that reconciliation
repairs.

**For live mode, no.** A single compromised function in any part of Compass
could refund, charge or cancel real customers. The same exposure also
applies to every other Vault secret (GitHub, Google, DataForSEO,
BrightLocal); that is wider than billing and belongs in the same fix.

## Option B: a dedicated billing runtime and database role

Move the three Stripe handlers out of Supabase Edge Functions into a runtime
whose secrets no other Compass code has.

### Shape that fits the current architecture

- **Runtime:** a second Vercel project, for example `compass-billing`, built
  from this repository's `billing/` entry point. Vercel environment variables
  are per project, so only this project holds:
  - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BILLING_RECONCILE_SECRET`
    (removed from Supabase Vault);
  - `BILLING_DATABASE_URL`: a Supavisor connection string for a dedicated
    Postgres login.
  The main app (`compass-crm`) keeps no Stripe secret. It already holds no
  service-role key (no `SERVICE_ROLE` in `src/`).
- **Database role:** `billing_sync` (LOGIN, NOINHERIT, no BYPASSRLS, no table
  privileges). It gets EXECUTE on the billing write functions only:
  - `billing_sync_apply`, `billing_link_customer`, `billing_event_*`
  - `billing_record_*`, `billing_void_external_payment`, `billing_audit`
  - `billing_reconcile_*`
  It gets SELECT on the few read models its handlers need. The boundary check
  `billing_caller_is_service()` becomes `session_user = 'billing_sync'`, so
  `service_role` and the other Edge Functions lose billing writes entirely.
  The worker's SQL (`postgres`) is still refused, as today.
- **Callers:**
  - Stripe's webhook points at `https://<billing>.vercel.app/api/stripe/webhook`.
  - The CRM's server actions call the billing project's operations endpoint
    with the signed-in teammate's or portal contact's Supabase JWT. The
    billing project verifies the JWT against Supabase (the same checks
    `stripe-billing` does now).
  - The daily reconciliation runs from Vercel Cron in that project. This
    replaces the pg_cron + `billing_fire_reconciliation()` call, and the
    shared secret is no longer needed.
- **Code:** the handlers are already factories over a store and a Stripe
  API: `handler.ts` / `store.ts` / `_shared/stripe/`.
  - The Deno-specific parts are `index.ts` only.
  - A Node entry point and a `pg`-based store (`select
    billing_sync_apply($1)`) replace the supabase-js service-role store.
  - The unit and integration suites keep running against the same
    handlers.
- **What stays in Supabase:** the schema, RLS, the portal views, the
  entitlement contract. The Five Layers never touch billing either way.

### Remaining risks under Option B

- A compromise of the billing project itself; that project is small and
  billing-only.
- The Vercel account.
- The database owner (`postgres`: the Supabase dashboard and MCP), which can
  still do anything in the database by design, but no longer holds the
  Stripe key.

### Effort

About two to three days:

- the Node entry points and a `pg` store for the three handlers
- migration `0064` (0063 is Communications): the `billing_sync` role and the boundary switch
- the Vercel project, env and cron
- moving the three secrets from Vault to Vercel
- re-running the whole suite plus a test-mode lifecycle on the new
  endpoint

### Alternatives considered

- **A separate Supabase project for billing.** Rejected: it would split the
  CRM's data from its billing views, and the portal and entitlement joins
  depend on one database.
- **Keep Edge Functions and add a per-function HMAC.** Rejected: the HMAC
  secret would itself sit in the shared env / Vault.

## Recommendation

1. **Test mode: Option A,** with the mitigations above, written down and
   accepted by Tom. It is what the cutover runbook's test-mode phase
   assumes.
2. **Before any live key: Option B.** Make it a go-live gate (the checklist
   in `docs/billing-readiness.md` lists it as BLOCKED until done).
3. **Separately:** stop the worker's connector SQL (`postgres`) from reading
   Vault. Either move `get_secret()` callers to a dedicated role, or move the
   worker to a non-owner role. That is an existing follow-up
   (`docs/follow-ups.md`, "non-owner role for worker SQL"). It matters
   before live billing even with Option B, because other live credentials
   are in Vault.

Option B was approved and is built (Oct 4 2026): `docs/billing-runtime.md`.
Differences from the shape above: the switch keeps the Edge Function path
open until the owner closes it (so the TEST setup works until the
replacement is verified); the Vercel Cron bearer (`CRON_SECRET`) replaces
`BILLING_RECONCILE_SECRET`; `billing_sync` also has the few direct writes the
handlers already made after their admin check (a catalog entry's Stripe
Product, a client-bound custom price, the `billing_portal` setting) and
column-limited reads of `clients`, `plans`, `team_members` and
`portal_users`.
