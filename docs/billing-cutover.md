# Billing cutover runbook (B1 + B2 + B3, test mode)

How migrations 0057 / 0058 / 0059, the app, and the Stripe Edge Functions
go to production together. Nothing here has been run. Architecture:
`docs/billing.md`; review: draft PR Compass2026/CompassCRM-#86.

**Why this must be coordinated.** 0057 drops `subscriptions.paid_status`,
the `plans` fee / quantity columns and the 0008 tables' shapes. The app on
`main` reads them (Plan, Billing, Dashboard, Clients, Content, Social); the
app on this branch reads the new model. Neither app works against the other
schema, so the migration and the app ship back to back, in one sitting.
The production billing tables are empty (checked Sept 28–29 2026), so no
data moves.

**Recommendation:** cut over B1–B3 together (B3 is now built): an admin can
then link or create a Stripe customer, build the catalog and send a payment
link from the app, all in Stripe test mode.

## 0. Preconditions (all must hold)

1. PR #86 reviewed and approved; the Five Layer / Authority migrations are
   reconciled and 0057 / 0058 / 0059 renumbered after the last applied migration
   (rename the files, rerun `npm run test:sandbox`; nothing inside them
   depends on their number).
2. CI green on the final head: `npm test`, lint, `tsc`, build. Locally:
   `npm run test:sandbox`, `npm run test:stripe-webhook`,
   `npm run test:stripe-billing`, `npm run test:billing-ui`,
   `npm run test:billing-ops-ui`.
3. Production billing tables still empty. 0057 refuses to run otherwise;
   check first:
   `select (select count(*) from stripe_customers) + (select count(*) from subscriptions) + (select count(*) from payments) + (select count(*) from stripe_events) + (select count(*) from plans);`
   The expected answer is 0.
4. No Stripe secret in Vault:
   `select name from vault.secrets where name like 'STRIPE%';`
   The expected answer is none.
5. **A decision on the write-boundary follow-up** (`docs/billing.md`, "The
   write boundary, and its limit"): accept the shared service-role key for
   test mode, or re-host the sync. This is required before live mode, and
   recommended before test mode too.
6. A tested rollback script (section 6) is in hand.

## 1. Database (Supabase MCP `apply_migration`, one migration at a time)

1. Apply 0057, then 0058, then 0059. Each runs its own verify block and
   aborts on any deviation.
2. Record the three versions in `docs/portal-reconciliation.md` and `AGENTS.md`.
3. Verify on production:
   - The recorded SQL equals the files (md5), including every function body.
   - `cron.job` has no `billing-daily-past-due`.
   - Rolled-back probes are refused:
     - The worker's SQL, with and without `SET ROLE service_role`,
       inserting into `subscriptions` or calling `billing_sync_apply`.
     - A team JWT calling `billing_sync_apply`.
     - A member writing `billing_packages` or the `billing` setting.
     - A member changing a team role.
     - anon.
     - The worker's SQL, a team JWT and anon calling
       `billing_record_external_payment`, `billing_record_checkout` or
       `billing_audit`, or writing `billing_audit_events`.
   - `select count(*) from service_catalog` returns 14.
   - The single production admin still reads `is_team_admin()` = true.

## 2. App (immediately after step 1)

1. Merge PR #86; Vercel deploys `main`.
2. Smoke test as the admin:
   - The Plan tab shows the Agreement card, the entitlements table (14
     services, "Not included") and the Billing card "Not set up".
   - The Billing tab carries the "Stripe test mode." banner and, for the
     admin, the link / create customer panel.
   - Settings › Billing catalog opens (no packages yet).
   - The Dashboard has no billing card.
   - The Clients list shows "—" for the package.
3. Regenerate `database.types.ts` from production and confirm it matches the
   branch file. The branch's types were matched by hand; any difference is a
   follow-up PR.

## 3. Edge Functions

1. **`stripe-billing`**: deploy the B3 handler with the default
   `verify_jwt = true` (every caller is a signed-in teammate or portal
   contact) through `deploy-supabase-function.yml` (already on its function
   list). It bundles `_shared/stripe/`. Check
   it: a POST `{"action": "version"}` with a teammate's JWT answers
   `{version: 1}`; any other action answers `503 stripe_not_configured`
   until the key exists.
2. **`stripe-webhook`**: deploy with **`verify_jwt = false`**, because Stripe
   sends no Supabase JWT.
   - The `deploy-supabase-function.yml` workflow does not pass that flag and
     the repo has no `supabase/config.toml`.
   - Either deploy with the CLI (`supabase functions deploy stripe-webhook
     --no-verify-jwt`), or add `[functions.stripe-webhook] verify_jwt =
     false` to a `supabase/config.toml` and the function to the workflow's
     list in a reviewed PR first.
3. Check it with an unsigned POST: the answer should be `503
   stripe_not_configured` until the secrets exist.

## 4. Stripe (test mode) and secrets

1. In the Stripe dashboard (**test mode**), create the webhook endpoint
   `https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/stripe-webhook`
   with exactly the 34 events listed in `docs/billing.md` (the source of
   truth is `STRIPE_WEBHOOK_EVENTS` in `_shared/stripe/sync.ts`). Its API
   version does not matter: payloads are never trusted, and objects are
   re-read at `2025-03-31.basil`.
2. Vault (service role only):
   - `STRIPE_SECRET_KEY`: a **test** key.
     - B2 only reads: products, prices, customers, subscriptions, invoices,
       PaymentIntents, charges, refunds and Checkout sessions. A restricted
       key (`rk_test_`) with read access to those is enough for B2.
     - B3 also writes: Customers, Prices, Checkout Sessions and Customer
       Portal configurations / sessions (and reads Customer search). Use a
       restricted key with exactly those write permissions, or a test
       secret key.
   - `STRIPE_WEBHOOK_SECRET`: the test endpoint's `whsec_`.
   - `APP_BASE_URL` (optional): the app's https origin for the Checkout
     return pages and the portal's return link. Default
     `https://compass-crm-ten.vercel.app`.
3. Leave `app_settings.billing` absent (test mode). A live key is refused
   (503) until an admin sets `{"livemode": true}`.
4. In the Stripe dashboard (test mode) enable **ACH Direct Debit**
   (`us_bank_account`) under payment methods. Without it Checkout falls back
   to card only and says so.
5. Create the test catalog in Stripe: standard package products and prices,
   a "Compass Custom Retainer" product (no prices; they are created per
   client from the app), and one-time products. Then an admin, in Settings ›
   Billing catalog: adds the packages, imports each product, approves the
   standard prices (one default), sets what each package includes, adds the
   one-time items, and presses **Configure Customer Portal**.

## 5. Test-mode verification

1. Stripe dashboard → "Send test webhook" (for example
   `customer.updated`). A `stripe_events` row should appear, ending
   `ignored`; the test customer is not linked.
2. Update a test price. Its `stripe_prices` row should follow Stripe.
3. Link a test customer (and create one for another client), send a payment
   link, and pay it with a test card and with test ACH
   (`000123456789` / `110000000`), then check:
   - `client_billing_status`
   - `invoices`, `payments` and `stripe_refunds` (refund twice, partially)
   - that `stripe_events` has nothing left `failed` or `processing`
   - that a second payment link for the subscribed client is refused
   - Manage Billing in Stripe opens the portal without cancel / plan change
   - an external payment recorded and voided, and `billing_audit_events`
4. Break it on purpose: pause the database or send a wrong signature. The
   events should read `failed` or return 400, and Stripe's retry (or the
   dashboard's "Resend") should recover them.
5. Watch the Edge Function logs for 4xx / 5xx for a day before anything
   else.

## 6. Rollback

Write the down script and test it in the sandbox **before** cutover
(`supabase/tests/sandbox` replay, then down, then the 0056 suites). It must
restore 0056's state exactly:

- Drop the 0059 functions, triggers, `billing_audit_events` and the new
  `payments` columns, then the 0058 functions and triggers, then the 0057 views, functions,
  triggers, restrictive `app_settings` policies, the `team_members` guard,
  and the new tables.
- Recreate `stripe_customers`, `subscriptions`, `payments` and
  `stripe_events` as 0001 / 0008 define them, with their enums, policies
  and grants.
- Restore the `plans` columns.
- Reschedule `billing-daily-past-due` and recreate
  `mark_past_due_subscriptions()`.

The order depends on how far you got:

- **Database applied, app not yet deployed:** run the down script. `main`
  is unchanged and works again.
- **App deployed:** revert the merge on `main` (Vercel redeploys the
  previous app), then run the down script.
- **Functions:**
  - Remove the Stripe secrets from Vault (the webhook then answers 503).
  - Disable the endpoint in the Stripe dashboard.
  - Redeploy `stripe-billing` as the 410 stub (the file is in git history
    at the B2 commit); the 0008 code is not to be redeployed.
- **Stripe:** B3 creates only test-mode objects (customers, prices, Checkout
  Sessions, a portal configuration); leave or archive them. Stripe keeps the
  events it could not deliver for three days.

## 7. Later: live mode (a separate, reviewed change)

1. Resolve the write-boundary follow-up.
2. Create the live catalog and the live webhook endpoint (same event list).
3. Add the live `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Keep the
   test ones in a note; one mode runs at a time per endpoint.
4. An admin sets `app_settings.billing = {"livemode": true}`. The read
   models switch to live and the webhook starts processing.
5. Verify as in section 5 with a real low-value charge and refund.
