# Billing production readiness and Stripe TEST MODE cutover

Status as of Oct 3 2026 (branch `claude/amazing-gates-eak3wb`, draft PR
Compass2026/CompassCRM-#86). **Nothing has been merged, deployed, applied or
configured.** The client agreements are **confirmed** (Oct 2026: § 4–5) and
seeded by the cutover kit, not yet in production.
- no Stripe credential has been added
- no live Stripe object exists
- the daily reconciliation schedule is not enabled

Companion documents:
- `docs/billing.md`: architecture
- `docs/billing-cutover.md`: the runbook this document feeds
- `docs/billing-service-role.md`: the credential decision
- `docs/billing-agreement-inventory.md` (+ `.csv`): the confirmed agreements

## 1. Branch reconciliation

What was inspected, all read-only:

| Area | State |
| --- | --- |
| `main` | `897b1c0` (PR #89, Compass Communications, Oct 2 2026), merged into PR #86's branch on Oct 3. The only conflicts were text (`AGENTS.md`, the sandbox script, the portal suite's security-definer allowlist, `database.types.ts`); both sides kept. |
| Production app | Vercel `compass-crm` serves `main`. |
| Production database | Last recorded migration: `0063_compass_communications` (`20261002211041`, applied Oct 2 2026). `0042` is still written but unapplied. Billing (0058 – 0062) therefore applies **after** 0063; the two touch no common object (0063 has no billing reference, and 0062's security-definer check covers only billing / portal-billing functions and the two planners), and the replay passes in file order. |
| Deployed Edge Functions | 15. `stripe-billing` is v2 and `stripe-webhook` v1 (the 0008 code, inert without secrets). `stripe-reconcile` is not deployed. |
| Five Layer / Authority | 0047 – 0056 are all merged and applied. Nothing from B5 depends on unmerged Five Layer code. |
| Other branches | `claude/dreamy-cerf-pzlgff` (Creative Engine step 2) has one unmerged commit from Sept 30 with its own `0057_creative_overlay_roles.sql` (not applied, no PR). **This is the only collision.** |
| Other open PR | PR #62 (Sept 25, "Narrow Connect Google"). No migrations. It overlaps our branch only in `AGENTS.md`, `docs/follow-ups.md` and the worker `SKILL.md`, which is a text merge. |

Trial merge of PR #86 with the Creative Engine branch in a scratch worktree
(not pushed):
- **Conflicts:** only two, both text: `AGENTS.md` (two paragraphs) and
  `scripts/test-portal-sandbox.sh` (both suites kept).
- **Tests:** the full replay of both sets passes, 22 suites including the
  Creative Engine's; `npm test` passes 631; tsc, lint and build pass.
- **One real dependency:** the Creative Engine branch adds npm dependencies
  (`@resvg/resvg-wasm`, `opentype.js`), so run `npm ci` after merging it.

The no-billing architecture test now also covers the Creative Engine's
`supabase/functions/creative-engine` and `src/lib/creative-preview.ts`. The
Creative code passes it.

## 2. Final migration numbers

| Before | Final | Content |
| --- | --- | --- |
| 0057 | **0058** | billing foundation (B1) |
| 0058 | **0059** | Stripe sync boundary (B2) |
| 0059 | **0060** | billing operations (B3) |
| 0060 | **0061** | reconciliation (B4) |
| 0061 | **0062** | entitlement contract + portal billing (B5) + security-definer hardening |

`0057` is left to the Creative Engine's `0057_creative_overlay_roles.sql`.

- The two sets are independent, so either can be applied first. Their
  replay order (0057 before 0058) passes both ways.
- The rename was done with `git mv`, so history is kept. Every reference in
  code, tests, docs and the sandbox script follows.
- Recheck at merge time: if anything else lands first, renumber after the
  last applied migration.

## 3. Conflict resolutions

- **Migration numbers:** as in § 2.
- **`AGENTS.md` and the sandbox script:** keep both sides when merging.
- **B5's assumptions about Five Layer code:** re-checked against `main`, and
  none has changed:
  - `client_intelligence_input` / `authority_input` unchanged;
  - the Authority engine and its fingerprint unchanged;
  - Drafter / Publisher untouched.
- **Found during this review:**
  - A post filed as a Google Doc (client-run sites) is a draft with a date but
    no due date, and was not counted against the blog allocation. Fixed:
    counted by `coalesce(due_date, published_at)`; sandbox check U3b.
  - A Customer Portal session now returns the portal contact to
    `/portal/billing`.

## 4–5. Client agreements — RESOLVED (Oct 2026)

Tom confirmed the terms for all eight current clients
(`docs/billing-agreement-inventory.md`, `.csv`):

- **One package, Compass Standard** (`compass_standard`): Website
  Management, Website Hosting, SEO, GBP, Social Media, Paid Ads, CRM,
  Reporting and Client Portal included; 8 blog posts, 8 GBP posts, 8 social
  posts, 4 new website pages and 1 website refresh a month.
- **Two prices for the same package and the same entitlements:** $650/month
  (default) and $500/month (legacy, grandfathered). No second package.
- **Eight agreements**, all Compass Standard, month-to-month from
  2026-10-01, collected by Stripe (ACH): BHG Safety Partners and Shewmaker
  Brothers Masonry at $500; Logic Solar, Show Me Design, Show Me Electrical,
  Lucas Construction, Ginger Huff Interiors and Pensacola Equipment Rentals
  at $650. No overrides and no exclusions.
- **Seed:** `supabase/cutover/02_agreements.sql` (replaces the template):
  one atomic statement, idempotent, refuses rather than overwrite a
  different package or agreement. Each agreement stores its contracted price
  as structured terms (`agreed_amount_cents` 50000 / 65000, `usd`, every 1
  `month`); the notes only describe it. No Stripe Price is bound
  (`billing_package_price_id` null).
- **Not seeded, and not invented:** the live Stripe Product and the live
  $650 / $500 Prices. They do not exist; they are created only after
  Option B, then mapped to Compass Standard in Settings › Billing catalog
  ($650 as the default price, $500 as a second approved price), and
  `07_live_bind_standard_prices.sql` binds each agreement to the one that
  says exactly its terms. Until then `04_validate.sql` reports the eight as
  `unmapped` (Checkout refused), which is expected for a test-mode cutover
  and never raises.
- **The agreement binds the exact price (fixed Oct 3 2026, before any
  deployment).** The earlier limit — Checkout accepted either approved price
  of the client's package — is closed:
  - `plans` carries the contracted recurring terms and
    `billing_package_price_id`, the exact approved package price; a
    composite foreign key keeps it on the agreement's own package, and
    `plans_agreement_price_guard` requires it to be active, recurring,
    licensed, fixed-amount, in the current mode and exactly the agreed
    amount, currency, interval and count. Only an admin sets the price or
    the binding.
  - Checkout sells only the bound price (the browser sends no price; a
    different `package_price_id` is refused, `agreement_price_mismatch`)
    and refuses an unbound agreement (`agreement_price_not_mapped`) or one
    whose price no longer matches. BHG Safety Partners and Shewmaker
    Brothers Masonry cannot be sold the $650 price, nor the six the $500.
  - `client_agreement_price` reports each agreement's readiness;
    `agreement_price_unmapped` / `agreement_price_mismatch` flag
    configuration gaps (never financial state); the portal's plan price is
    the agreement's.
- **Automation effect from 0062:** website refreshes drop from Tom's Sept 14
  rule of 2 a month to the agreement's 1, and new pages may rise to 4; the
  weekly blog (≤ 5 a month) stays within 8.

## 6. Automation cutover plan

**Affected by B5:**

| Job (pg_cron) | Schedule (UTC) | Function | B5 change |
| --- | --- | --- | --- |
| `weekly-blog-posts` | Wed 09:00 | `create_weekly_blog_tasks()` | plans only while `blog_posts` has room; logs every skip |
| `fire-website-updates` | 2nd 09:00 | `fire_website_updates()` | fires only with `website` + room in pages or refreshes |
| `fire-monthly-reporting` | 1st 09:00 | `fire_monthly_reporting()` | the worker's report reads the allocation |
| the Foundation worker Routine | daily sweep + CRM fires | `SKILL.md` | website updates / blog / GBP spec / report read `client_quota_usage` |

Not affected, and keep running:
- `create-monthly-cycles`
- the BrightLocal / GSC / rank syncs
- `post-publisher-tick`
- `retry-failed-fires`
- `social-posts-recheck`

**Sequence.** Each step's file is in `supabase/cutover/`, and every file has
been run in the sandbox by `billing_cutover_kit.test.sql`.

1. Pause the Foundation worker Routine at claude.ai/code/routines (Tom).
2. `01_pause_automation.sql`: `cron.alter_job(…, active := false)` for the
   three jobs. It prints what it paused.
3. Apply 0058 → 0062 (`apply_migration`, one at a time).
4. Merge PR #86 → Vercel deploys the app. Regenerate the database types.
5. Seed Compass Standard and the eight confirmed agreements:
   `02_agreements.sql` (prints what it recorded; refuses, writing nothing,
   if any of the eight clients is missing or already has a different
   agreement).
6. `03_test_client.sql`: the fictional test client, paused, with its test
   agreement.
7. `04_validate.sql`: **raises** unless every active client has an agreement
   or is excluded by id (`set compass.cutover_excluded = '{…}'`; after 02
   nothing needs excluding). It then prints whether Compass Standard's $650 /
   $500 Stripe Prices are mapped ("not ready" until the live prices exist),
   each client's entitlements, allocations, and what each planner will do
   next.
8. Test the entitlement reads in the app: Tasks / Content / Social /
   Intelligence per client.
9. `05_resume_automation.sql`, then unpause the Routine.

**Timing:** plan the window to avoid the 1st, 2nd and Wednesday 09:00 UTC. If
the window crosses one, the pause covers it and the job runs on its next
schedule.

## 7. SECURITY DEFINER audit

Scope:
- every function created or changed by 0058 – 0062;
- the two identity helpers the portal views rest on;
- one control: a deliberately unhardened function.

**Findings:**

- **Owner:** every function is owned by `postgres` (the migration owner; not
  a superuser).
- **Execute grants:** no function is executable by PUBLIC or anon. A
  signed-in user can execute only the self-scoping helpers.
- **Session re-check:** every service-only function re-checks its session
  itself (`billing_caller_is_service()` / `billing_require_service()`:
  `session_user = authenticator` and role `service_role`).
- **Caller identity:** it is never taken from the caller.
  - Portal contacts: `portal_client_id()` from `auth.uid()`. The portal row
    functions take **no argument** to spoof.
  - Teammates and admins: the JWT is resolved against `team_members` by
    the function.
  - Clients: ownership comes from the customer link (`billing_owner`),
    never from Stripe metadata alone.
- **Hardening applied:**
  - **search_path:** every billing function is pinned to
    `search_path = public, pg_temp`. Before this, `public` alone let a
    session's temporary tables be searched first. A control run proved
    that: an unhardened copy read a temp `app_settings`, while the hardened
    `billing_livemode()` did not.
  - **Identity helpers:** `portal_client_id()` and `is_team()` get the
    same pin.
  - **Grants:** `service_role` loses execute on the two planners and the
    history trigger.
  - **Verify block:** 0062's verify block refuses any billing
    security-definer function outside the pattern.
- **Qualification:** object names are not schema-qualified. Pinning
  `pg_temp` last makes `public` the only schema searched, and no API role can
  create objects in `public` (checked on production: `authenticated`, `anon`
  and `service_role` lack CREATE).
- **Tests:** `billing_security_definer.test.sql` (18 checks, below).

| Function | Kind | Executable by (beyond the owner) | Guard |
| --- | --- | --- | --- |
| `billing_sync_apply`, `billing_link_customer`, `billing_event_begin/finish/fail` | definer | service_role | `billing_caller_is_service()` |
| `billing_record_checkout`, `billing_record_external_payment`, `billing_void_external_payment`, `billing_audit` | definer | service_role | `billing_require_service()` |
| `billing_reconcile_begin/client/finish` | definer | service_role | `billing_require_service()` |
| `billing_livemode` | definer | authenticated, service_role | returns one boolean |
| `portal_billing_summary_row`, `portal_entitlement_rows` | definer | authenticated, service_role | no argument; `portal_client_id()` only; client-safe columns only |
| `portal_client_id`, `is_team` (0037 / 0036) | definer | authenticated, service_role | re-derive from `auth.uid()`; now pinned |
| `create_weekly_blog_tasks`, `fire_website_updates` | definer | nobody (pg_cron as owner) | — |
| `record_client_agreement_event` | definer trigger | nobody | trigger only |
| everything else in 0058 – 0062 | invoker | as listed in the migrations | RLS / explicit checks |

**Remaining (outside billing):** other Five Layer security-definer functions
(0045 – 0056) still use `search_path = public`. They are not reachable
through PostgREST with a temp table either, since the API runs no DDL. Same
fix, separate follow-up.

## 8. Shared service-role credential

See `docs/billing-service-role.md`.
- **Key finding:** the Stripe secret is read from Vault through
  `get_secret()`. **Any** of the 16 Edge Functions can read it, and so can
  the worker's connector SQL.
- **Recommendation:**
  - **Test mode:** Option A (accept, with its mitigations).
  - **Before any live key:** Option B, a dedicated Vercel billing project
    that holds the Stripe secrets outside Vault and connects through a
    `billing_sync` Postgres role. Estimated at about 2–3 days.
- Nothing is built until reviewed.

## 9. Rollback: tested

**Files:**
- `supabase/rollback/billing_0058_0062_backup.sql`: exports every row the
  rollback drops, Compass-owned records first.
- `supabase/rollback/billing_0058_0062_down.sql`: one transaction. It
  refuses if billing is not applied, and verifies at the end.

`npm run test:billing-rollback` (`scripts/test-billing-rollback.sh`):

1. Replay 0001 – 0057 plus fixtures, then snapshot `pg_dump` (public + cron),
   the cron jobs and the billing settings.
2. Apply 0058 – 0062.
3. Seed every billing table:
   - a package, an agreement and an override;
   - the mirror, an external payment, audit rows, a reconciliation run and
     planning-log rows;
   - the billing mode, the portal setting and the daily reconciliation
     schedule.
4. Run the backup.
5. Run the rollback. **The schema dump, cron and settings are identical to
   the baseline.**
6. Run main's portal access suite on the result: 374 pass.
7. Re-apply 0058 – 0062: clean.

What the rollback means:

| Question | Answer |
| --- | --- |
| Rolled back automatically | Every billing table, view, function, trigger, policy and type is removed. The 0001 / 0008 / 0036 billing tables, enums, policies, the past-due sweep and its cron job are recreated exactly. 0035's planners are restored. The identity helpers go back to their 0036 / 0037 `search_path`. |
| Data lost | Agreements, overrides, the package catalog and its entitlements, the agreement and planning history, external payments, the billing audit trail and the reconciliation history. **Back these up first** with the backup script. The Stripe mirror can be rebuilt from Stripe. |
| App version | The billing app reads tables the rollback drops. Revert the merge on `main` first; Vercel then serves the pre-billing app. It is safe to roll back the database once that app is live. |
| Stripe mirror rows | Dropped. Stripe keeps the truth. After a roll-forward, reconciliation re-imports them. |
| Automation | The planners return to 0035's behaviour: every active client gets a weekly blog task again. |
| Scheduled reconciliation | `cron.unschedule('billing-reconcile-daily')` in the script (and it is never enabled before cutover step 12). |
| Stripe webhooks | **Before** the database rollback: disable the endpoint in the Stripe dashboard and remove `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `BILLING_RECONCILE_SECRET` from Vault. The functions then answer 503. Stripe retries undelivered events for 3 days; a later roll-forward's reconciliation catches up anyway. |
| Never | Destructive rollback testing against production. |

## 10. Stripe TEST MODE setup (Tom, in the Stripe dashboard, test mode only)

**Keys and secrets.** Everything goes into Supabase Vault; under Option B it
would go into the billing project's environment instead.

| Secret | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | A **test** key: `sk_test_…`, or a restricted `rk_test_…` with the permissions below. |
| `STRIPE_WEBHOOK_SECRET` | The test endpoint's `whsec_…`. |
| `BILLING_RECONCILE_SECRET` | 32+ random bytes, generated by Tom (for example `openssl rand -hex 32`). It never appears in chat or git. |
| `APP_BASE_URL` | Optional; defaults to `https://compass-crm-ten.vercel.app`. |
| `app_settings.billing` | Leave absent (test mode). A live key is refused while it is absent. |

Restricted-key permissions (test):
- **Write:** Customers, Prices, Checkout Sessions, Customer Portal
  (configurations + sessions).
- **Read:** Products, Prices, Customers (including search), Subscriptions,
  Invoices, PaymentIntents, Charges, Refunds, Checkout Sessions, Events.

**Created by Tom in Stripe TEST MODE (Oct 2026).** Ids below are test-mode
object ids, not secrets. The three secret values are held privately by Tom
and are **not** in Vault yet (they go in at § 17 step 9); they never appear
in chat, git or this document.

| Object | Test-mode id | Use |
| --- | --- | --- |
| Product "Compass Standard (TEST)" | `prod_VMxmkG052epGVU` | the test lifecycle |
| its monthly Price, $2,500.00 | `price_1UMDr54Zq9yMk653B7jdneFm` | test fixture amount, **not** Compass pricing |
| Product "Compass Custom Retainer (TEST)" | `prod_VMxtVQBYzS0Qya` | no prices; the app creates a test retainer Price per client (Billing tab › Custom Retainer) |
| Webhook endpoint | `we_1UMFdM4Zq9yMk653d9ynrHOP` | the 34 events below |
| Payment methods | cards + ACH Direct Debit (`us_bank_account`) | enabled |

**Mapping (§ 17 step 11):** the TEST Standard product and its $2,500 price
map to the test client's package **"Test Standard (TEST)"**
(`03_test_client.sql`), never to Compass Standard. The test client's
agreement (agreed $2,500.00/month, usd, monthly) is then bound to exactly
`price_1UMDr54Zq9yMk653B7jdneFm` (`06_bind_test_client_price.sql`, or Plan
tab › Agreed price › Bind price), so the sandbox Checkout runs the same
agreement-price enforcement live billing will. Compass Standard stays
unmapped in test mode; its live $650 default and $500 legacy Prices are
created and mapped only for live mode, after Option B. The Custom Retainer
(TEST) product is imported as a `custom` package, used only for the test
client's retainer path.

Original setup steps, for reference:

1. **Product** "Compass Standard (TEST)" with a monthly recurring **Price**.
2. **Product** "Compass Custom Retainer (TEST)" with **no prices**.
3. **Optional:** a one-time Product/Price "Website Build (TEST)".
4. **Settings › Payment methods:** enable **ACH Direct Debit
   (`us_bank_account`)** and cards.
5. **Webhook endpoint:**
   `https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/stripe-webhook`.
   Select **exactly these 34 events (no wildcard)**:
   - `customer.updated`, `customer.deleted`
   - `product.created`, `product.updated`, `product.deleted`
   - `price.created`, `price.updated`, `price.deleted`
   - `customer.subscription.created`, `customer.subscription.updated`,
     `customer.subscription.deleted`, `customer.subscription.paused`,
     `customer.subscription.resumed`
   - `invoice.created`, `invoice.finalized`, `invoice.updated`,
     `invoice.paid`, `invoice.payment_failed`,
     `invoice.payment_action_required`, `invoice.voided`,
     `invoice.marked_uncollectible`, `invoice.deleted`
   - `payment_intent.processing`, `payment_intent.succeeded`,
     `payment_intent.payment_failed`, `payment_intent.canceled`
   - `charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`
   - `checkout.session.completed`, `checkout.session.expired`,
     `checkout.session.async_payment_succeeded`,
     `checkout.session.async_payment_failed`

   The source of truth is `STRIPE_WEBHOOK_EVENTS` in
   `supabase/functions/_shared/stripe/sync.ts`.
6. **Customer Portal:** do not configure it by hand. An admin presses
   **Configure Customer Portal** in Settings › Billing. That creates the
   restricted configuration: payment methods, invoices and contact details
   only; no cancellation, no plan or quantity changes. Every session
   re-checks that configuration and refuses one widened in the dashboard.
7. **In the app** (admin), Settings › Billing catalog:
   - import `prod_VMxmkG052epGVU` onto **Test Standard (TEST)** and approve
     `price_1UMDr54Zq9yMk653B7jdneFm` as its default;
   - import `prod_VMxtVQBYzS0Qya` as the custom-retainer product;
   - leave **Compass Standard** unmapped (its entitlements are already
     seeded by `02_agreements.sql`);
   - bind the test client's agreement: `06_bind_test_client_price.sql`.

**Test payment details:**
- **Cards:**
  - `4242 4242 4242 4242`: succeeds.
  - `4000 0000 0000 0341`: attaches, then later charges fail. Use it for
    failure-path testing.
- **ACH:** routing `110000000`, account `000123456789`: succeeds. Use the
  failure account numbers from Stripe's ACH testing documentation for a
  failed debit.

Never use live mode, live keys or live products.

## 11. Test client

`supabase/cutover/03_test_client.sql`: **Compass Billing Test Client (TEST)**
(`c0ffee00-0000-4000-b000-00000000b111`).

- **Status:** paused, so neither the worker nor the planners touch it.
- **Creation:** made with the client-insert automation off for that row, so
  there is no worker fire, provisioning, task or pipeline. The sandbox proves
  this.
- **Agreement:** package "Test Standard (TEST)":
  - **Features:** Website Management, Website Hosting, SEO, GBP, Social,
    Reporting, Client Portal.
  - **Monthly:** 4 blog, 8 GBP posts, 30 social posts, 2 new pages,
    2 refreshes.
- **Portal contact:** a test inbox Tom controls. It is invited from the
  client's Overview tab, or the sign-in is created in Supabase Auth. It must
  not be a team address.

These values are testing fixtures, not Compass product decisions. Offboard
the client after go-live.

## 12–15. Test results

**Real Stripe TEST MODE: not run. BLOCKED** on:
- the migrations being applied;
- the functions being deployed;
- Tom's test keys and webhook endpoint.

All of these wait for approval of this handoff.

Everything below was proven in a **dress rehearsal**:
`npm run test:billing-rehearsal` (`tests/billing-lifecycle-rehearsal.mjs`,
17 checks). It runs the real `stripe-billing`, `stripe-webhook` and
`stripe-reconcile` handlers and stores over PostgREST on the full replay,
with Stripe faked. The same steps are the manual checklist for the real
test-mode run.

| # | Step | Rehearsal | Real test mode |
| --- | --- | --- | --- |
| 10.1 | Agreement → entitlements (4 / 8 / 30 / 2 / 2 + 7 services) | PASS | pending |
| 10.2 | Customer created and linked; Checkout refused until the agreement is bound to its exact TEST price, a different price refused, then created at exactly `price_1UMDr54Zq9yMk653B7jdneFm`; link ready | PASS | pending |
| 10.3 | Payment → webhook → subscription / invoice / payment mirrored; Active; MRR; next billing date; entitlements unchanged | PASS | pending |
| 10.4 | Invoice internal + portal (hosted page, PDF); no Stripe id / package id / codes | PASS | pending |
| 10.5 | Customer Portal: own client only; payment methods; no cancel or plan change; widened config refused | PASS | pending |
| 10.6 | Reconciliation, then a second run with no differences | PASS | pending |
| 11.1 | Payment failure → attention → entitlements intact → portal "payment needs attention" | PASS | pending |
| 11.2 | Successful retry → Active | PASS | pending |
| 11.3 | Duplicate webhook → one result | PASS (Dashboard "Resend" in real mode) | pending |
| 11.4 | Out-of-order webhook → Stripe's state wins; cancel at period end → "scheduled to end"; entitlements intact | PASS | pending |
| 11.5 | Two partial refunds → two rows | PASS | pending |
| 11.6 | Expired Checkout without a webhook → reconciliation repairs | PASS | pending |
| 11.7 | Missed webhook → reconciliation repairs; next run no differences | PASS | pending |
| 12.1 | past_due / unpaid / canceling / canceled → entitlements unchanged | PASS | pending |
| 12.2 | Social 30 → 20: remaining 0, 5 over, nothing deleted; 20 → 30: remaining 5; both in history | PASS | pending |
| 12.3 | Client Intelligence / Authority inputs carry no billing | PASS | pending |
| 12.4 | Intelligence scope, Authority marks, Tasks / Content / Social targets, Reports included vs actual | PASS (`test:entitlements-ui`, `test:authority-ui`, sandbox) | pending |
| 13 | Portal: nav, own summary, client-safe entitlements, invoices with links, no internal data, Manage Billing own client only, external client no button, cross-client refused | PASS (`test:portal-billing-ui` + rehearsal + sandbox) | pending |

**Real test-mode procedure** (after cutover steps 1–12, with the test client):

1. Plan tab: confirm the agreement and its **Agreed price** ($2,500.00/month,
   Stripe Price **Mapped**, test mode). Billing tab: create the customer;
   before binding, confirm Checkout is refused (no payment link offered);
   then **Create Payment Link for $2,500.00/month** (no price to choose) and
   copy the link.
2. Pay the link with `4242…`, then check the Billing tab: Active, MRR, next
   billing date.
3. Portal (test inbox): check Billing, the invoice, and Manage billing.
4. Run **Reconcile This Client** twice; the second run must report no
   differences.
5. Run the failure paths:
   - **Payment failure:** attach `4000 0000 0000 0341` in the Customer
     Portal, then in the dashboard advance the subscription (a test clock,
     or "reset billing cycle") so it invoices. Check: past due.
   - **Recovery:** attach `4242…` and pay the invoice. Check: Active.
   - **Cancel at period end:** schedule it in the dashboard, then unschedule
     it.
   - **Refunds:** two partial refunds from the dashboard.
   - **Duplicate event:** "Resend" an event from the dashboard.
   - **Missed webhook:** disable the endpoint, change the quantity in the
     dashboard, re-enable, then Reconcile.
   - **Expired Checkout:** create a link for a second fictional client,
     expire it with the endpoint disabled, then Reconcile.
6. Five Layer: change social 30 → 20 → 30 on the Plan tab, then check the
   Tasks / Social targets.
7. ACH: pay a second test client's link with test ACH, then check
   `processing` → `succeeded`.

## 14. Observability: what Tom checks, all on existing screens

| Check | Where | Healthy |
| --- | --- | --- |
| Webhook health | Settings › Billing › Stripe sync | "Healthy"; no failed events |
| Failed Stripe events | Same card | 0; any failure is retried by the next reconciliation |
| Last reconciliation | Same card + the run table | today, Completed |
| Reconciliation failures | Run table (status, failures) | none, or explained in the run's summary |
| Clients needing billing attention | Dashboard + each client's Billing tab (`client_billing_status.billing_attention`) | none, or a known reason |
| Past-due clients | Billing tab state "Past due"; Stripe dashboard | Stripe's dunning is working on it |
| Unmapped prices | attention reason `unmapped_price` | none; map the price in the catalog |
| Package mismatches | attention reason `package_mismatch` | none; fix the agreement or the subscription |
| Multiple live subscriptions | attention reason `multiple_live_subscriptions` | none; cancel the duplicate in Stripe |
| Automation skips | `select * from automation_entitlement_log order by created_at desc limit 50` | skips only for clients deliberately without an allocation |

Daily: glance at the Stripe sync card. Weekly: the attention list and the
automation log. On any red: Reconcile This Client, then read the result.

## 16. Remaining blockers

**Resolved (Oct 2026): the client agreements.** Tom confirmed all eight
(§ 4–5); `02_agreements.sql` seeds them and the cutover kit proves the
validator passes with no exclusions.

**Resolved (Oct 3 2026): the agreement binds its exact recurring price.**
Checkout can no longer sell a client either of a package's prices; it sells
only the price the agreement is bound to (§ 4–5).

Remaining, in the order they unblock:

1. **Stripe TEST MODE deployment** (§ 17 steps 1 – 10): migrations, app,
   functions, Tom's test secrets into Vault, the existing test webhook
   endpoint pointed at the deployed function. Option A, test mode only.
2. **Real Stripe test lifecycle** (§ 12–15, § 17 step 11) with the test
   client.
3. **Production cutover**: the agreements seeded and `04_validate.sql`
   passing on production (§ 17 step 6), automation resumed.
4. **Production database type regeneration** after the migrations (§ 17
   step 5). The branch types were matched by hand against the replay.
5. **Daily reconciliation activation**, only after the test lifecycle passes
   (§ 17 step 12).
6. **Option B, the dedicated live billing runtime** (§ 8): a hard go-live
   blocker. No live Stripe secret may go into the shared Supabase Edge
   Function / Vault architecture.
7. **The live $650 default and $500 legacy Stripe Prices** on a live
   Compass Standard Product: created only after Option B, then mapped to
   Compass Standard ($650 default, $500 second approved price), then each
   agreement bound to its exact price (`07_live_bind_standard_prices.sql`);
   only then may Checkout run for the eight. No ids exist or are invented;
   placeholders are in `02_agreements.sql` and `docs/billing-cutover.md`.

Not blockers: the Creative Engine branch's 0057 can merge before or after
(`npm ci` if it merges first); live mode itself is a separate reviewed change
(Option B, the live prices, live keys, a live endpoint and a real low-value
charge + refund).

## 17. Production deployment order (test mode)

The schema and the app must ship together. Each checkpoint (✓) says what to
do if that step fails.

1. **Freeze.** PR #86 approved and CI green. Pause the Foundation worker
   Routine. Run `supabase/cutover/01_pause_automation.sql`.
   - ✓ Rollback: `05_resume_automation.sql` and unpause the Routine.
2. **Back up.** In the Supabase dashboard, take a backup / PITR restore
   point. Record `select count(*)` of the old billing tables; all must be 0.
3. **Database.** `apply_migration` for 0058, 0059, 0060, 0061, 0062, one at
   a time. Each verify block must pass. Then check the recorded SQL md5
   against the files. The rolled-back probes are in `docs/billing-cutover.md`
   § 1.
   - ✓ Rollback: `billing_0058_0062_backup.sql`, then
     `billing_0058_0062_down.sql` (tested). The old app still works on
     `main`.
4. **App.** Merge PR #86. Vercel deploys `main`. Smoke test as the admin
   (`docs/billing-cutover.md` § 2).
   - ✓ Rollback: revert the merge on `main`, then step 3's rollback.
5. **Types.** Regenerate `database.types.ts` from production. Any diff
   against the branch file becomes a follow-up PR.
6. **Agreements.**
   - Run `02_agreements.sql`: Compass Standard and the eight confirmed
     agreements with their structured agreed prices (no Stripe Price
     bound). It prints the eight; it refuses, writing nothing, if a client
     is missing or already has a different agreement.
   - Run `03_test_client.sql`.
   - Run `04_validate.sql`; it must pass (every Stripe agreement has its
     agreed price; the eight report `unmapped`, Checkout refused — expected
     in test mode).
   - Check the Tasks / Content / Social targets for each active client.
7. **Automation.** Run `05_resume_automation.sql` and unpause the Routine.
   - ✓ Watch the next Wednesday's `automation_entitlement_log`.
8. **Billing runtime.** Deploy `stripe-billing`, then `stripe-reconcile`
   (the workflow), then `stripe-webhook` (CLI, `--no-verify-jwt`). Each
   answers 503 until the keys exist.
   - Option B, if chosen, replaces this step.
9. **Secrets.** Add the test `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
   and `BILLING_RECONCILE_SECRET` to Vault.
   - ✓ Rollback: remove them; the functions answer 503.
10. **Webhook endpoint.** Create it with the 34 events. Send a test event;
    it must read `ignored` in `stripe_events`.
11. **Catalog mapping.**
    - Import the TEST products onto the test packages and approve the test
      price (§ 10). Compass Standard stays unmapped in test mode.
    - Run `06_bind_test_client_price.sql`: the test client's agreement is
      bound to exactly `price_1UMDr54Zq9yMk653B7jdneFm` and reports
      `ready`.
    - Configure the Customer Portal.
    - Run the test-client lifecycle (§ 12–15).
12. **Daily reconciliation.** Only after step 11 passes:
    `select cron.schedule('billing-reconcile-daily', '17 7 * * *', 'select billing_fire_reconciliation()');`
    - ✓ Rollback: `cron.unschedule('billing-reconcile-daily')`.

Live mode is not in this sequence.

## 18. GO-LIVE checklist

**Result:** no item is marked PASS until it is proven on production or
signed off by Tom.

| Item | Status | Evidence / action |
| --- | --- | --- |
| Code merged | BLOCKED | PR #86 is a draft awaiting this review |
| Migrations finalized | PASS | 0058 – 0062 (§ 2); recheck at merge |
| Migration replay clean | PASS | `npm run test:sandbox`: 25 suites on the branch (with `billing_agreement_price`), including main's 0063 communications suite after the Oct 3 merge; the merge trial with the Creative Engine branch (0057) also passes (§ 1) |
| Rollback tested | PASS (sandbox) | `npm run test:billing-rollback`: exact schema / cron / settings; main's portal suite 374 pass; re-apply clean |
| Active client agreements confirmed | **RESOLVED** | Tom, Oct 2026 (§ 4–5): eight agreements on Compass Standard, six at $650, two at $500 legacy; seeded with structured agreed prices by `02_agreements.sql`, proven in the sandbox (cutover kit K3a – K3o, K9a) |
| Agreement bound to its exact price | **RESOLVED** (code) | `plans.agreed_*` + `billing_package_price_id`, composite FK + `plans_agreement_price_guard`, Checkout sells only the bound price; sandbox `billing_agreement_price` (52), cutover kit K11 – K18, handler unit tests, integration, rehearsal, `test:billing-ops-ui` |
| Test client bound to its TEST price | MANUAL ACTION REQUIRED | § 17 step 11: `06_bind_test_client_price.sql` after the TEST import |
| Live agreements bound to live prices | BLOCKED | after Option B and the live $650 / $500 Prices: `07_live_bind_standard_prices.sql` (tested in the sandbox with sandbox-only ids) |
| Agreements entered on production | MANUAL ACTION REQUIRED | § 17 step 6 (`02_agreements.sql`) |
| Entitlements verified | MANUAL ACTION REQUIRED | `04_validate.sql` on production after the agreements; passes with no exclusions in the sandbox |
| Security-definer audit passed | PASS | § 7; 18 regression checks; hardening in 0062 |
| Service-role isolation decision made | PASS (test mode) / BLOCKED (live) | Approved Sept 30 2026: Option A for Stripe TEST MODE only. Hard rule: no live Stripe secret in the shared Edge Function / Vault architecture. Option B (dedicated billing runtime, billing-only Stripe credentials, least-privilege database role) must be built and reviewed before any real billing. |
| Stripe test lifecycle passed | BLOCKED | rehearsal PASS (17); the real test-mode run waits on deployment and keys |
| Failure-path tests passed | BLOCKED | rehearsal PASS; real test mode pending |
| Portal tests passed | BLOCKED | browser + sandbox PASS; real test mode pending |
| Webhook endpoint tested | MANUAL ACTION REQUIRED | created in test mode (`we_1UMFdM4Zq9yMk653d9ynrHOP`, 34 events); test event → `ignored` after deployment |
| ACH tested | MANUAL ACTION REQUIRED | ACH enabled in test mode; one test ACH payment after deployment |
| Reconciliation tested | BLOCKED | rehearsal and integration PASS; production run pending |
| Production DB types regenerated | MANUAL ACTION REQUIRED | after step 3 |
| Production secrets ready | MANUAL ACTION REQUIRED | Tom holds the test restricted key, the test signing secret and `BILLING_RECONCILE_SECRET` privately; added to Vault at § 17 step 9 |
| Live Stripe catalog ready | BLOCKED | needs Option B first; then the live Compass Standard Product with a $650 default and a $500 legacy monthly Price, mapped to the one package. Not created; do not create |
| Daily reconciliation ready but disabled | PASS | `billing_fire_reconciliation()` exists; never scheduled by a migration (checked by the sandbox) |
| Backup captured | MANUAL ACTION REQUIRED | step 2 of § 17 |
| Deployment order ready | PASS | § 17 |

No live billing until Tom explicitly approves this checklist.
