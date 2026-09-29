# Billing & Financial Operations — Phase 1 audit and proposed design

Written Sept 28 2026, before any billing changes. It covers what already
exists in the repo and in production (`compass-client-platform`), what
can be kept, what has to change and why, and a proposed normalized schema
and build order for review. The decisions of Sept 28 2026 are recorded in
`AGENTS.md`; what was built from this audit, and its status, is in
`docs/billing.md`.

Principle it is written against: **Stripe is the financial source of
truth; Compass is the operational source of truth.** Stripe owns
customers, products, prices, subscriptions, invoices, payments, payment
methods, refunds and cancellation. Compass keeps a mirror of what it
needs for display, reporting, entitlements and automation, and never
computes billing itself.

## 1. Short answer

A Phase 3 billing build already exists (Aug 31 2026: migration `0008`,
two Edge Functions, a Billing tab, and a setup card on the Plan tab). It has
**never been used**:

- The Stripe secrets are not in Vault.
- Every billing table in production has zero rows.
- No client has a plan or a fee.

So there is **no data to migrate and no live behaviour to protect**. The
build is a sound skeleton: Vault secrets, a signed webhook, event dedupe,
team-only RLS and the one-customer-per-client link. But it differs from the
target architecture in several structural ways:

1. **No catalog.** Setting up billing creates a *new Stripe Product per
   client*, priced ad hoc from `plans.monthly_fee`. Compass is inventing
   prices instead of choosing Stripe ones.
2. **No Checkout and no Customer Portal.** The first payment goes through
   a hosted-invoice link, and there is no self-service.
3. **The webhook can lose events.** It records the event id *before* doing
   the work and always answers 200. A failed write is therefore never
   retried, and Stripe's own retry is treated as a duplicate.
4. **It only updates rows Compass created.** A subscription created in the
   Stripe dashboard or through Checkout is ignored. So is an invoice that
   is not paid.
5. **No invoice mirror, no refunds, no cancel-at-period-end, no currency.**
   Amounts are stored as dollar `numeric`.
6. **Compass recomputes billing state.** `paid_status` and the daily
   `mark_past_due_subscriptions()` sweep reproduce what Stripe's
   subscription and invoice status already say.
7. **No reconciliation, no entitlements, no portal billing view.**
8. **Team members can write the mirror directly.** `subscriptions`,
   `payments` and `stripe_customers` carry "team full access", so the UI
   or PostgREST can edit financial state the webhook is meant to own.

Recommendation: **keep the shape, replace the internals.** Keep the two
function names, the Vault secrets, `stripe_customers` as the durable client
↔ customer link, the `subscriptions` / `payments` / `stripe_events` tables
(extended), and the Billing tab route. Rewrite the two functions as
tested `handler.ts` factories, as the other functions in the repo already
are. Add a package catalog, an invoice mirror, a reconciliation function
and an entitlement read model.

## 2. Inventory (the 20 audit questions)

| # | Question | Finding |
| --- | --- | --- |
| 1 | Stripe integration | Phase 3, Aug 31 2026. Built from `docs/spec.md` §6.5b ("port from the Show Me Electrical CRM"). Inert: no secrets. `docs/follow-ups.md` item 3. |
| 2 | Stripe SDK | `npm:stripe@18` imported inside the two Deno Edge Functions only. **Not** in `package.json`: the Next.js app never touches Stripe, which is correct and should stay so. No explicit `apiVersion` is set; the SDK's pinned default is used. |
| 3 | Configuration | None beyond the functions. There is no Stripe product, price, portal configuration or webhook endpoint (per AGENTS.md "No Stripe objects have been created"). |
| 4 | Env / secrets | `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are read from Vault through `get_secret()`. **Both absent** in production (checked Sept 28). No Vercel env vars for Stripe. |
| 5 | API routes | No Next.js route handlers. `src/app/billing-actions.ts` holds three server actions (`setup`, `pause`, `resume`) that POST to `stripe-billing` with the user's JWT. |
| 6 | Edge Functions | `stripe-billing` v2 (`verify_jwt = true`, team check; identical to repo per `docs/portal-reconciliation.md`). `stripe-webhook` v1 (`verify_jwt = false`, Stripe signature; deployed source compared Sept 28, identical to repo). **Neither is on the `deploy-supabase-function.yml` list.** Neither has a handler factory or tests. |
| 7 | Webhook handlers | `stripe-webhook` handles `invoice.paid`, `invoice.payment_failed`, `payment_intent.processing`, `customer.subscription.updated`, `customer.subscription.deleted`. Defects are in §3. |
| 8 | Billing tables | `stripe_customers`, `subscriptions`, `payments` (0001), `stripe_events` (0008). |
| 9 | Invoice tables | **None.** `spec.md` §9 mentions an `invoices` table that was never created. The only invoice data is `subscriptions.latest_invoice_url` and `payments.stripe_invoice_id`. |
| 10 | Subscription tables | `subscriptions`: `stripe_subscription_id` unique, one `stripe_price_id`, `amount numeric`, `interval`, free-text `status`, period start / end, `paid_status` enum, `cancel_at`, `latest_invoice_url`. No items, currency, `cancel_at_period_end`, `canceled_at`, `ended_at`, trial or sync watermark. Nothing enforces one live subscription per client (only a `maybeSingle` check in code, which errors if there are two). |
| 11 | Payment tables | `payments`: one row per paid invoice (`stripe_invoice_id` unique) or a manual entry (`source = 'manual'`, methods `external_ach` / `check`). `amount numeric`, no currency, no refund fields, `stripe_payment_intent_id` always written as null. |
| 12 | Stripe ids on clients | **Not on `clients`.** They live on `stripe_customers.client_id` (unique) → `stripe_customer_id` (unique). That is the right normalization; keep it. The FK is `on delete cascade`, which should become `restrict` (§5). |
| 13 | Packages / services | `plans` is 1:1 per client: free-text `package_name`, `monthly_fee`, `term_months`, `start_date`, `renewal_date` and quantities (`gbp_posts_per_month`, `blog_posts_per_month`, `social_posts_per_month`, `ad_budget_managed`). **There is no package catalog.** `spec.md` §7 lists "packages" under Settings, but none was built. `services` (0010) is the client's *service taxonomy* for SEO, not what Compass sells, and must not be confused with billing. Production: 0 `plans` rows. |
| 14 | Onboarding | Postgres triggers on `clients` insert: brand row, Foundation / Website / SEO enrollment, provisioning, worker fire (AGENTS.md "Onboarding flow"). **Billing plays no part.** A client is onboarded and worked whether or not it has a subscription. |
| 15 | Client status | `client_status` enum `launching / active / paused / offboarded`, driven by pipeline convergence (`handle_pipeline_completion`) and by hand. Independent of billing. Nothing reads `paid_status` except the Dashboard. |
| 16 | Billing UI | `/clients/[id]/billing` shows a subscription card (paid badge, amount, period, payment method, hosted-invoice link, pause / resume, open in Stripe), lifetime paid and payment history. The Plan tab has a "Create Stripe customer + subscription" card. The Dashboard has a "Payments past due" list. The Clients list shows `plans.package_name`. The Social and Content tabs read the `plans` quantities. |
| 17 | Portal UI | `src/app/portal/` covers rankings, search, work log and reports. **No billing.** 0037 names billing as deliberately unreachable (no `portal_*` view). |
| 18 | RLS | All four tables have RLS. `stripe_customers`, `subscriptions`, `payments` and `plans` carry `team full access` (ALL, `is_team()`). `stripe_events` is team SELECT only. The default Supabase grants to `anon` are still present on all five: harmless under RLS with no anon policy, but inconsistent with the portal views' explicit revokes. |
| 19 | Tenancy | Single agency. There is no organization or tenant model (`docs/client-scorecards.md` §"not multi-tenant"). Billing should stay keyed on `client_id`. Adding an `organization_id` now would be speculative. |
| 20 | Other references | `src/lib/labels.ts` (paid-status labels), `src/app/actions.ts` (`upsertPlanAction`), `src/app/(app)/page.tsx`, `clients/page.tsx`, `plan/page.tsx`, `billing/page.tsx`, `social/page.tsx`, `content/page.tsx`, `client-tabs.tsx`, `scripts/design-preview.mjs` (mock data), `database.types.ts`. The pg_cron job `billing-daily-past-due` (06:30 UTC) is active and runs over zero rows. |

## 3. Defects in the existing code (why "extend" is not enough)

**`stripe-webhook`**

- **Loses events on failure.** The `stripe_events` insert happens first, and
  the Supabase write results are never checked. A failed update is answered
  200 and marked done, so Stripe stops retrying. A later retry of the same
  event returns `duplicate: true`. Fix: record the event as `received`,
  process it, mark it `processed` only on success, and answer 5xx on
  failure so Stripe retries.
- **Order-sensitive.** Stripe does not guarantee delivery order. The
  handler applies each payload as it arrives, so a late `updated` can
  overwrite a newer state. Fix: on any subscription or invoice event, *fetch
  the current object from Stripe* and upsert that ("fetch-on-event"), with
  a `stripe_synced_at` watermark.
- **Update-only.** `customer.subscription.updated` does nothing unless
  Compass created the row. Subscriptions from Checkout, from the Stripe
  dashboard or from a teammate are never mirrored. There is no
  `customer.subscription.created`, `checkout.session.completed`,
  `invoice.finalized`, `invoice.payment_action_required`, `invoice.voided`,
  `invoice.marked_uncollectible`, `charge.refunded` or
  `customer.updated`.
- **Guesses at processing state.** `payment_intent.processing` marks *every*
  unpaid subscription of the customer as processing.
- **Loads the secret key on every call**, even for events it ignores. This
  is minor.

**`stripe-billing`**

- **Creates a Product per client** (`products.create` on every setup) with
  inline `price_data`. This fills Stripe with one-off products, makes
  catalog reporting in Stripe meaningless, and puts price authority in
  Compass (`plans.monthly_fee`).
- **No idempotency keys.** A double click can create two customers or two
  subscriptions. The "one subscription per client" check is a read, not a
  constraint.
- **Pause / resume writes `status = 'paused'`**, a value that is not a
  Stripe status: it mixes `pause_collection` into `status`.
- Uses a hosted-invoice link instead of Checkout. There is no Customer
  Portal session.

**Schema and policies**

- Money is dollar `numeric` with no currency. Stripe works in integer
  minor units with a currency.
- `paid_status`, together with the `mark_past_due_subscriptions()` sweep
  (open + 3 days → `past_due`), re-implements dunning that Stripe already
  does: its subscription status becomes `past_due` or `unpaid` per the
  account's retry settings.
- Team members can `insert` / `update` / `delete` the mirror through
  PostgREST, so "webhook-driven" is not enforced.
- `on delete cascade` from `clients` silently drops the Stripe link. Once a
  client has billing history, it should be offboarded, never deleted
  (the same rule 0041 applies to measurements).
- `plans.monthly_fee` stays editable after a subscription exists, so the
  CRM's fee and Stripe's price can drift with nothing to flag it.

## 4. Proposed design

### 4.1 Flow

```
Plan tab: choose package (Compass catalog → Stripe Price)
  → stripe-billing {action: "checkout"}         (team JWT)
      ensure Stripe Customer (metadata.compass_client_id, idempotency key)
      create Checkout Session (mode=subscription, card + us_bank_account,
        client_reference_id = client id, subscription_data.metadata)
  → Checkout URL sent to the client (or opened with them)
Stripe: Customer → Subscription → monthly invoices → automatic collection
  → stripe-webhook (signed)  → stripe_events ledger → fetch-on-event
      → _shared/stripe-sync.ts upserts customer / subscription / items /
        invoice / payment mirrors
  → client_billing_status (view) → entitlements (view) → CRM, Dashboard,
    portal, automations
stripe-reconcile (pg_cron daily + button)
  → list Stripe customers / subscriptions / recent invoices
  → same _shared/stripe-sync.ts upserts (safe repairs)
  → billing_reconciliation_findings for anything it will not repair
Billing tab / portal: "Manage billing" → Stripe Customer Portal session
```

The webhook and reconciliation share **one mapping and upsert module**, so
the two paths can never disagree about what a Stripe object means.

### 4.2 Where each value lives (normalized)

| Value | Home | Notes |
| --- | --- | --- |
| `stripe_customer_id` | `stripe_customers` (unique per client, unique per customer) | Existing table. This is the durable client ↔ customer relationship. Add `email`, `name`, `currency`, `default_payment_method_type` / `last4` / `brand`, `stripe_synced_at`, `deleted_at`. FK → `on delete restrict`. |
| Active subscription id | `subscriptions.stripe_subscription_id` | One row per Stripe subscription, history kept. A partial unique index allows **one live subscription per client** (status not in `canceled`, `incomplete_expired`). |
| Stripe price id(s) | `subscription_items` (new) | `stripe_subscription_item_id`, `stripe_price_id`, `quantity`, `unit_amount_cents`, `currency`, `interval`, `interval_count`. Allows add-ons without a schema change. `subscriptions.stripe_price_id` is dropped. |
| Current plan / package | `plans.package_id` → `billing_packages` (new catalog); also derived from the live subscription's price → `billing_prices.package_id` | Compass decides what a package *means* (entitlements). Stripe decides what it *costs*. |
| Billing status | `client_billing_status` **view** | Derived; never stored. Values: `none`, `checkout_pending`, `trialing`, `active`, `past_due`, `unpaid`, `paused`, `canceling`, `canceled`. |
| Subscription status | `subscriptions.status` | Stripe's status verbatim (check constraint on Stripe's enum). `pause_collection` is stored separately as `collection_paused` + `pause_resumes_at`. |
| Billing-cycle anchor | `subscriptions.billing_cycle_anchor` | |
| Current period start / end | `subscriptions.current_period_start` / `_end` | Read from the item on newer API versions; the existing helper already handles both. |
| Next billing date | derived: `current_period_end` unless canceling or paused | Shown in the view, not stored. |
| Cancellation | `subscriptions.cancel_at_period_end`, `cancel_at`, `canceled_at`, `ended_at`, `cancellation_reason` | |
| MRR | derived in the view from live `subscription_items` (normalised to a month) | Never stored, so it can never go stale. |
| Currency | on every money row, integer `*_cents` columns | |
| Latest invoice state | `invoices` (new) + `subscriptions.latest_invoice_id` | `status` draft / open / paid / uncollectible / void, `amount_due` / `paid` / `remaining`, `due_date`, `hosted_invoice_url`, `invoice_pdf`, `attempt_count`, `next_payment_attempt`, `period_start` / `end`, `paid_at`, `billing_reason`. Replaces `latest_invoice_url`. |
| Payment state | `payments` (kept) | Stripe rows keyed by `stripe_invoice_id` / `stripe_payment_intent_id` / `stripe_charge_id`, plus `amount_refunded_cents` and `refunded_at` from `charge.refunded`. `source = 'manual'` stays for external ACH and cheques. |

Tables that stay operational (Compass-owned, team-writable):

- **`billing_packages`**: `key`, `name`, `description`, `active`,
  `stripe_product_id`, `sort_order`.
- **`billing_prices`**: a read-only mirror of the Stripe Prices on those
  products (`stripe_price_id`, `package_id`, amount, currency, interval,
  `active`, `nickname`). Synced from Stripe (`price.*` / `product.*`
  events and reconciliation), never typed in. A custom deal is a Stripe
  Price on the package's Product, created in Stripe (or by an explicit
  "create custom price" action), then mirrored.
- **`package_entitlements`**: `package_id`, `key` (e.g. `gbp_posts_per_month`,
  `blog_posts_per_month`, `social_posts_per_month`, `pipeline:seo`,
  `portal`), `limit` / `enabled`.
- **`plans`** (kept, per client): gains `package_id`. Its quantities become
  **per-client overrides** of the package entitlements. `package_name` and
  `monthly_fee` become read-only legacy columns, shown only when no package
  is set, and are dropped once the UI no longer reads them.

Sync and audit tables (service-role writes only):

- **`stripe_events`** (kept, extended): `status` received / processed /
  failed / ignored, `attempts`, `last_error`, `event_created`, `object_id`,
  `processed_at`, `livemode`. Stores the id and type, not the payload; the
  payload can always be re-fetched from Stripe.
- **`billing_reconciliation_runs`**: started / finished, scope, counts,
  status.
- **`billing_reconciliation_findings`**: run, client, Stripe object, `kind`
  (`missing_in_compass`, `stale_in_compass`, `orphan_customer`,
  `unlinked_customer`, `duplicate_live_subscription`, `metadata_mismatch`,
  …), before / after, `repaired` boolean, `resolved_by` / `_at`.

### 4.3 Webhook events to subscribe

`checkout.session.completed`, `checkout.session.expired`,
`customer.created` / `updated` / `deleted`,
`customer.subscription.created` / `updated` / `deleted` / `paused` /
`resumed` / `trial_will_end`,
`invoice.created` / `finalized` / `paid` / `payment_failed` /
`payment_action_required` / `voided` / `marked_uncollectible` / `upcoming`,
`payment_intent.processing` / `succeeded` / `payment_failed`,
`charge.refunded`, `charge.dispute.created`,
`product.updated`, `price.created` / `updated`.

Every event is idempotent by `stripe_events.id`, and every handler
re-fetches the object, so replay, reordering and reconciliation are all the
same operation.

### 4.4 Reconciliation (`stripe-reconcile`)

pg_cron, daily plus a Settings button (team JWT or `x-cron-secret`, the
same auth pattern as the syncs). Steps:

1. List every Stripe customer with `metadata.compass_client_id` plus every
   `stripe_customers` row.
2. For each, list its subscriptions (all statuses) and invoices from the
   last 90 days.
3. Upsert through `_shared/stripe-sync.ts`, the exact code the webhook
   uses. Safe repairs are applied: missing or stale mirror rows, missed
   invoices and payments.
4. Anything that is not a mirror update is **logged, never repaired**:
   - a Stripe customer with no Compass client, or pointing at an
     offboarded one;
   - two live subscriptions for one client;
   - metadata that disagrees with the link table;
   - a Compass row whose Stripe object no longer exists.
5. Replay `stripe_events` rows left `failed` or `received` for more than 15
   minutes.

It never creates, changes or cancels anything in Stripe.

### 4.5 Entitlements

`client_entitlements` view: package entitlements ⊕ `plans` overrides ⊕
billing state. **Phase 1 is display and reporting only.** Nothing is
switched off by billing state. A later, separate switch (off by default,
the same pattern as `worker_google_ops` and the publisher switch) could
let billing state pause worker fires or Reporting. That change needs
Tom's policy on grace periods and must not touch the Five Layer or
Authority code paths.

### 4.6 Security and access

- `stripe_customers`, `subscriptions`, `subscription_items`, `invoices`,
  `payments` (Stripe rows), `billing_prices`, `stripe_events` and
  reconciliation tables: **team SELECT only** (`using ((select
  is_team()))`). Writes come only from the service role inside the Edge
  Functions. Manual payment entry, if it is ever wanted, goes through a
  security-definer function that accepts only `source = 'manual'`.
- `billing_packages`, `package_entitlements` and `plans`: team full access
  (they are operational).
- Revoke all from `anon` on every billing table. New security-definer
  functions are revoked from `public, anon, authenticated`, per
  AGENTS.md.
- Portal (later): one `portal_billing` view filtered by
  `portal_client_id()` (status, next billing date, latest invoice amount /
  status / hosted link; never payment-method detail or Stripe ids beyond
  what is needed). Plus a `stripe-billing {action: "portal"}` path that
  accepts a portal user's JWT and opens a Customer Portal session **for
  that user's own client only**. It must pass 0037's verify block and the
  sandbox portal tests.
- Both functions move to `handler.ts` factories with injected Stripe and
  Supabase, are tested with a fake Stripe (signature, duplicates, failure →
  5xx → retry, out-of-order delivery, unknown customer), and are added to
  `deploy-supabase-function.yml`.

## 5. Build order (proposed, each step reviewable on its own)

**B1: schema (one migration, no Stripe calls).** Extend
`stripe_customers` / `subscriptions` / `payments` / `stripe_events`. Add
`subscription_items`, `invoices`, `billing_packages`, `billing_prices`,
`package_entitlements`, `plans.package_id`, and the reconciliation tables.
Add the `client_billing_status` and `client_entitlements` views. Tighten
RLS and grants, change the FK to `restrict`, and add the partial unique
index for one live subscription per client. Convert money to cents; safe
because every table is empty, and the migration asserts that. Unschedule
`billing-daily-past-due` and drop `paid_status` / `paid_status_type`, with
the view deriving a compatible `paid_state` for the existing UI. Covered by
sandbox tests and `test-portal-sandbox.sh`.

**B2: sync core + webhook.** `_shared/stripe-sync.ts` (pure mapping +
upserts), `stripe-webhook` rewritten as a handler with the ledger and
fetch-on-event. Unit and handler tests against a fake Stripe.

**B3: Checkout + Customer Portal + UI.** `stripe-billing` actions:
`checkout`, `portal`, `pause`, `resume`, `cancel_at_period_end` /
`reactivate`. Remove per-client Product creation. Plan tab package picker,
Billing tab on the new mirror (invoices, refunds, "Manage in Stripe
portal"), Settings › Packages (catalog + entitlements; prices shown from
the mirror, read-only), Dashboard MRR and past-due from the view.

**B4: reconciliation.** `stripe-reconcile`, pg_cron, a Settings card with
the last run and any open findings, and a Brief line when findings are
open.

**B5: entitlements consumers and portal billing.** Social, Content and
Clients read `client_entitlements`. Add the `portal_billing` view and the
portal "Manage billing" link. The enforcement switch is only discussed
here, not built.

**Go-live:** Stripe **test mode** first (test keys in Vault, test webhook
endpoint, Customer Portal configured in the dashboard, products / prices
created in Stripe). Run end-to-end Checkout → invoice → webhook → reconcile
in test mode. Then live keys. The secrets stay in Vault; nothing goes in the
repo or in Vercel.

## 6. Parallel-work notes (Five Layer / Authority)

- Billing touches only the billing tables, `plans`, the Billing, Plan and
  Settings pages, the Dashboard card and two Edge Functions. It does not
  touch Client Intelligence, Authority, the Drafter, the publisher, Creative
  or the worker skill.
- `plans` quantities feed the Social and Content tabs today. Those reads
  switch to the entitlement view in B5, with the same numbers.
- **Migration numbers and `database.types.ts` will collide** with the Five
  Layer branches. The billing migration takes its number at merge time, and
  types are regenerated from production after it is applied, the same as
  every other migration here.

## 7. Decisions needed before B1

1. **Catalog vs custom pricing.** Are there standard packages (fixed Stripe
   Prices), or is every client custom? The proposal supports both:
   packages on Products, with a custom deal as another Price on the package
   Product. The current per-client Product would go.
2. **Existing billing.** Are any current clients already billed in Stripe
   (the Compass account, or the Show Me Electrical CRM's)? If so,
   reconciliation needs an "adopt existing customer" step that links by
   id; it would never recreate them.
3. **Payment methods.** Is it still card + ACH debit (`us_bank_account`)?
   Is external ACH or a cheque still recorded by hand (`source = manual`)?
4. **Past-due policy.** Is the plan to rely on Stripe's retry and dunning
   settings and drop the Compass 3-day sweep? (Recommended.)
5. **Entitlement enforcement.** Display-only for now, with any automatic
   pausing a later opt-in switch? (Recommended.)
6. **Who sends Checkout.** A teammate copies the link, or Compass emails it
   (a Gmail draft, per the existing "nothing is sent" rule)?
