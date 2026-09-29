# Billing cutover runbook (B1 + B2, test mode)

How migrations 0057 / 0058, the app, and the Stripe Edge Functions go to
production together. Nothing here has been run. Architecture:
`docs/billing.md`; review: draft PR Compass2026/CompassCRM-#86.

**Why this must be coordinated.** 0057 drops `subscriptions.paid_status`,
the `plans` fee / quantity columns and the 0008 tables' shapes. The app on
`main` reads them (Plan, Billing, Dashboard, Clients, Content, Social); the
app on this branch reads the new model. Neither app works against the other
schema, so the migration and the app ship back to back, in one sitting.
The production billing tables are empty (checked Sept 28–29 2026), so no
data moves.

**Recommendation:** cut over after B3, when a teammate can link or create a
Stripe customer from the app. After B1 + B2 alone the webhook would run,
but with no linked customers it only mirrors the catalog and records
everything else as ignored.

## 0. Preconditions (all must hold)

1. PR #86 reviewed and approved; the Five Layer / Authority migrations are
   reconciled and 0057 / 0058 renumbered after the last applied migration
   (rename the files, rerun `npm run test:sandbox`; nothing inside them
   depends on their number).
2. CI green on the final head: `npm test`, lint, `tsc`, build. Locally:
   `npm run test:sandbox`, `npm run test:stripe-webhook`,
   `npm run test:billing-ui`.
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

1. Apply 0057, then 0058. Each runs its own verify block and aborts on any
   deviation.
2. Record both versions in `docs/portal-reconciliation.md` and `AGENTS.md`.
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
   - `select count(*) from service_catalog` returns 14.
   - The single production admin still reads `is_team_admin()` = true.

## 2. App (immediately after step 1)

1. Merge PR #86; Vercel deploys `main`.
2. Smoke test as the admin:
   - The Plan tab shows the Agreement card, the entitlements table (14
     services, "Not included") and the Billing card "Not set up".
   - The Billing tab is empty and says "Showing Stripe test mode".
   - The Dashboard has no billing card.
   - The Clients list shows "—" for the package.
3. Regenerate `database.types.ts` from production and confirm it matches the
   branch file. The branch's types were matched by hand; any difference is a
   follow-up PR.

## 3. Edge Functions

1. **`stripe-billing`**: deploy the retired stub (410) so the 0008 code can
   never run against the new schema, even if a secret appears. B3 replaces
   it.
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
     - B3 needs write access for Checkout, customers and portal sessions.
   - `STRIPE_WEBHOOK_SECRET`: the test endpoint's `whsec_`.
3. Leave `app_settings.billing` absent (test mode). A live key is refused
   (503) until an admin sets `{"livemode": true}`.
4. Create the test catalog in Stripe: standard package products and prices,
   a "Compass Custom Retainer" product, and one-time products. Then have an
   admin map them in Compass (Settings UI in B3; SQL as the admin until
   then).

## 5. Test-mode verification

1. Stripe dashboard → "Send test webhook" (for example
   `customer.updated`). A `stripe_events` row should appear, ending
   `ignored`; the test customer is not linked.
2. Update a test price. Its `stripe_prices` row should follow Stripe.
3. After B3: link a test customer and run test-card and test-ACH payments
   through Checkout, then check:
   - `client_billing_status`
   - `invoices`, `payments` and `stripe_refunds` (refund twice, partially)
   - that `stripe_events` has nothing left `failed` or `processing`
4. Break it on purpose: pause the database or send a wrong signature. The
   events should read `failed` or return 400, and Stripe's retry (or the
   dashboard's "Resend") should recover them.
5. Watch the Edge Function logs for 4xx / 5xx for a day before anything
   else.

## 6. Rollback

Write the down script and test it in the sandbox **before** cutover
(`supabase/tests/sandbox` replay, then down, then the 0056 suites). It must
restore 0056's state exactly:

- Drop the 0058 functions and triggers, then the 0057 views, functions,
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
  - Keep `stripe-billing` as the 410 stub; the 0008 code is not to be
    redeployed.
- **Stripe:** nothing to undo. Compass never writes Stripe in B2, and
  Stripe keeps the events it could not deliver for three days.

## 7. Later: live mode (a separate, reviewed change)

1. Resolve the write-boundary follow-up.
2. Create the live catalog and the live webhook endpoint (same event list).
3. Add the live `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Keep the
   test ones in a note; one mode runs at a time per endpoint.
4. An admin sets `app_settings.billing = {"livemode": true}`. The read
   models switch to live and the webhook starts processing.
5. Verify as in section 5 with a real low-value charge and refund.
