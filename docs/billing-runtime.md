# Billing runtime (Option B) — `compass-billing`

Built Oct 4 2026. Decision and threat model: `docs/billing-service-role.md`.
Billing architecture: `docs/billing.md`. Live cutover: `docs/billing-cutover.md`.

The Stripe handlers (operations, webhook, reconciliation) run in their own
Vercel project, `compass-billing`, built from `billing/` in this repository.
Only that project holds the Stripe key, the webhook signing secret and the
password of the `billing_sync` database login. It holds **no** Supabase
service-role key. No Edge Function and no Vault secret can reach Stripe once
the cutover below is finished.

## What runs where

| Piece | Where | What it holds |
| --- | --- | --- |
| `POST /api/billing` | `compass-billing` (Node 22) | `stripe-billing`'s handler, unchanged |
| `POST /api/stripe/webhook` | `compass-billing` | `stripe-webhook`'s handler, unchanged (Stripe signature verified on the raw body) |
| `POST /api/reconcile` | `compass-billing` | `stripe-reconcile`'s handler, unchanged (admin JWT) |
| `GET /api/reconcile` | `compass-billing`, Vercel Cron `17 6 * * *` (06:17 UTC daily) | the scheduled agency-wide run; Vercel sends `Authorization: Bearer $CRON_SECRET` |
| Database access | login `billing_sync` (migration 0064) through the Supavisor transaction pooler | billing-only grants, no Vault |
| The CRM (`compass-crm`) | server actions in `src/app/billing-actions.ts` → `src/lib/stripe-billing-call.ts` | only `BILLING_API_URL`; no Stripe secret, no service-role key |

**Reused logic.** The three entry points in `billing/src/entries/` wrap the
existing `handler.ts` factories in `supabase/functions/stripe-*` and the shared
sync in `supabase/functions/_shared/stripe/`. Exact agreement pricing,
duplicate-subscription protection, the webhook's signature check and ledger,
entitlements and reconciliation are the same code the TEST lifecycle already
proved. Only the store changed: `billing/src/store.ts` makes the same reads
and RPC calls through `pg` as the `billing_sync` login, instead of through
supabase-js as `service_role`.

**Who is asking.** The CRM sends the signed-in person's Supabase JWT. The
runtime asks Supabase Auth who it belongs to (`GET /auth/v1/user` with the
public anon key) and then looks the user up in `team_members` /
`portal_users`, as `stripe-billing` did. Admin-only actions, member actions
and the portal contact's own Customer Portal keep their rules.

**The database boundary (0064).**

- `billing_sync` is a plain login: no superuser, BYPASSRLS, CREATEROLE or
  replication, a member of no role, and a 60 s statement timeout. The
  migration sets no password.
- It reads:
  - the Stripe mirror, the catalog, the ledger, the reconciliation history
    and the billing read models;
  - only the columns it needs of `clients`, `plans`, `team_members` and
    `portal_users`.
- It writes directly only:
  - a catalog entry's Stripe Product;
  - a client-bound custom price;
  - the `billing_portal` setting.

  Everything else goes through the billing write functions.
- It can never write `plans`, the billing mode, entitlements or a mirror row
  directly. It has no delete or truncate anywhere, and cannot reach
  `get_secret` / `set_secret` / Vault.
- `billing_caller_is_service()` admits `session_user = 'billing_sync'`
  always. It admits the old Edge Function session (`authenticator` +
  `service_role`) only while `billing_runtime.edge_functions` is true. That
  is the switch that keeps the TEST setup working until the replacement is
  verified.
- Only the database owner can change the switch. `service_role` can read it
  but never write it, so no Edge Function can reopen the old path.

## Environment of `compass-billing`

Set these for **Production** only. Preview deployments then have no secrets
and answer 503.

| Variable | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | the Stripe **TEST** secret key (`sk_test_…` or a restricted `rk_test_…`). A live key is refused unless `BILLING_ALLOW_LIVE` is `true`. |
| `STRIPE_WEBHOOK_SECRET` | the signing secret of the Stripe endpoint that points at this project (step 4) |
| `CRON_SECRET` | a new random string (e.g. `openssl rand -hex 32`); Vercel Cron sends it as the bearer |
| `BILLING_DATABASE_URL` | the **transaction pooler** URI with user `billing_sync.iokcopiyzajigvhwexhe` and the password from step 2: `postgresql://billing_sync.iokcopiyzajigvhwexhe:<password>@aws-0-us-west-2.pooler.supabase.com:6543/postgres` (copy host and port from Supabase › Connect › Transaction pooler) |
| `BILLING_DATABASE_CA` | optional: the PEM from Supabase › Database settings › SSL configuration › Download certificate. With it the server certificate is verified; without it the connection is still TLS-encrypted, but unverified. |
| `SUPABASE_URL` | `https://iokcopiyzajigvhwexhe.supabase.co` |
| `SUPABASE_ANON_KEY` | the project's public anon key (the same value as the CRM's `NEXT_PUBLIC_SUPABASE_ANON_KEY`) |
| `APP_BASE_URL` | `https://compass-crm-ten.vercel.app` (Checkout / Customer Portal return links) |
| `BILLING_ALLOW_LIVE` | **unset** until go-live (`docs/billing-cutover.md`) |

None of these values goes in the repository, Supabase Vault, an Edge Function
secret, or a chat with Claude. They are entered in the Vercel dashboard only.

## Deployment — in this order

The old path (Edge Functions + Vault + the current Stripe endpoint) stays
fully working until step 7. Every step before that is reversible by doing
nothing.

1. **Merge the PR.** `compass-crm` redeploys from `main` with
   `BILLING_API_URL` unset, so it still calls the Edge Functions. Nothing
   changes for anyone.
2. **Apply 0064** to production; Claude can do it through the Supabase MCP on
   request, with a dry run first. The switch starts open, so the Edge
   Functions keep working exactly as now.

   Then **Tom sets the login's password**. Generate it in the password
   manager, then, as `postgres`, run one of:
   - in `psql`: `\password billing_sync` (preferred: the password is hashed
     before it is sent);
   - in the Supabase SQL editor:
     `alter role billing_sync with password '<generated>';`. Run it once and
     do not save the snippet.
3. **Create the Vercel project** (Vercel › Add New › Project, team
   compassmarketin):
   - Import `Compass2026/CompassCRM-` and name it `compass-billing`.
   - Root Directory: `billing`. Keep "Include files outside the Root
     Directory" **on**, because the build imports `supabase/functions/`.
   - Framework Preset: **Other**. Build and install commands: defaults
     (`npm run build`, `npm install`). Node.js 22.x.
   - Add the environment above, except `STRIPE_WEBHOOK_SECRET` (it exists
     only after step 4).
   - Deploy, and note the production domain (e.g.
     `https://compass-billing.vercel.app`).
   - Smoke test:
     - `curl -i https://<billing>/api/reconcile` → `401`;
     - `curl -i -X POST https://<billing>/api/billing -d '{}'` → `401
       not_signed_in`;
     - Settings › Cron Jobs lists `/api/reconcile` at `17 6 * * *`.
4. **Add a second Stripe TEST endpoint.** Stripe Dashboard (Test mode) ›
   Developers › Webhooks › Add endpoint:
   - URL: `https://<billing>/api/stripe/webhook`.
   - Events: the same 34 as the current endpoint (list in
     `docs/stripe-test-mode-operator-checklist.md` § 12).
   - Copy its signing secret into the Vercel variable
     `STRIPE_WEBHOOK_SECRET`, then redeploy.

   Both endpoints now receive every event. That is safe: the ledger
   (`billing_event_begin`) processes each event id once, and the second
   delivery is acknowledged as a duplicate.

   Check: Stripe › the new endpoint › **Send test webhook**
   (`invoice.paid`) → HTTP 200. A 400 means a wrong signing secret.
5. **Point the CRM at it.** Vercel › `compass-crm` › Settings › Environment
   Variables: add `BILLING_API_URL = https://<billing>` (Production; the
   origin only, no path), then redeploy.
6. **Verify on the TEST client** (no charge: nothing below creates a
   payment):
   - As an admin, Billing tab › **Reconcile This Client** → the run
     completes with no differences.
   - Open the Customer Portal from the Billing tab → Stripe's TEST portal
     opens.
   - In `compass-billing` › Logs, both requests show on `/api/reconcile` and
     `/api/billing`.
   - Optional: Settings › **Run Billing Reconciliation** → completed.
7. **Close the old path** (the cutover):
   1. In Stripe (Test mode), **disable** the old endpoint
      (`…supabase.co/functions/v1/stripe-webhook`). Do not delete it yet.
   2. As `postgres`, run:
      `update billing_runtime set edge_functions = false, updated_at = now();`
   3. Repeat step 6's reconcile. It must still complete: every billing write
      is now `billing_sync`'s.
   4. In Stripe › the new endpoint, **resend** the latest `invoice.paid` →
      200.
   5. The next morning, check that the cron run at 06:17 UTC recorded a
      `billing_reconciliation_runs` row with `trigger = 'schedule'`.
8. **Remove the old credentials.** Do this after one clean scheduled run.
   - Delete `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and
     `BILLING_RECONCILE_SECRET` from Supabase Vault.
   - Delete the three Edge Functions `stripe-billing`, `stripe-webhook` and
     `stripe-reconcile` (Supabase › Edge Functions).
   - Delete the disabled Stripe endpoint.
   - Roll the TEST secret key in Stripe (the old one sat in Vault) and put
     the new one in Vercel only.

   From here on, no Supabase component can reach Stripe.

Go-live stays a separate decision (`docs/billing-cutover.md`): a live key
goes into `compass-billing` only, together with `BILLING_ALLOW_LIVE=true`,
after billing is switched to live in the CRM.

## Rollback

**Before step 8**, at any point:

1. In `compass-crm`, remove `BILLING_API_URL` and redeploy. The CRM calls
   the Edge Functions again.
2. As `postgres`, run:
   `update billing_runtime set edge_functions = true, updated_at = now();`
3. In Stripe, re-enable the old endpoint, then disable the new one.

Data needs no repair. Both paths write the same mirror through the same
functions, and a missed event is repaired by the next reconciliation.
Migration 0064 can stay: it is additive, and with the switch open the
database behaves exactly as before it.

**After step 8**, rolling back also means putting the three secrets back
into Vault and redeploying the three functions from `main`
(`deploy-supabase-function.yml`). Prefer fixing forward in `compass-billing`.

## Checks

- `npm test --prefix billing`: the key rules, the Node adapter, and the
  built endpoints' refusals. Covers the webhook signature, a live key
  without `BILLING_ALLOW_LIVE`, no JWT, and the cron bearer.
- `npm test`: `tests/billing-target.test.mjs`, the CRM's switch between the
  two backends.
- `scripts/test-portal-sandbox.sh`, `billing_runtime.test.sql`:
  - what `billing_sync` can and cannot do;
  - the switch;
  - `service_role` cannot reopen the switch.
- `npm run test:billing-runtime`: the whole TEST lifecycle (agreement,
  exact-price Checkout, webhook, entitlements, portal, reconciliation,
  failures, refunds) through the real handlers on the `pg` store as
  `billing_sync`, with the Edge Function path closed.
