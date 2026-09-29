# Billing & Financial Operations

The architecture reference for billing. The audit that preceded it, and the
decisions of Sept 28 2026 it implements, are in `docs/billing-audit.md`.

**Principle.** Stripe is the financial source of truth: customers,
products, prices, subscriptions, invoices, payments, payment methods,
refunds, retries, dunning, past due and cancellation. Compass is the
operational source of truth: which package a client is on, what the
agreement includes, and how billing state becomes an operational alert.
Compass mirrors Stripe and never runs a second billing state machine.

```
Compass: client → agreement (plans: package, collection) → entitlements
   └─ Checkout link (B3) → Stripe Customer → Subscription → invoices → payments
Stripe webhooks (B2) ─┐
Reconciliation (B4) ──┴→ _shared sync → Stripe mirror (service role only)
   → client_billing_status (derived) → Dashboard / Plan / Billing / portal (B5)
```

## Status

| Step | What | State |
| --- | --- | --- |
| B1 | Schema: mirror, catalog, agreement, entitlements, read models | **0057 written, not applied** (Sept 29 2026) |
| B2 | Shared Stripe sync module + corrected webhook | not started |
| B3 | Checkout, link existing customer, Customer Portal, billing screens | not started |
| B4 | Reconciliation | not started |
| B5 | Entitlement interface for the Five Layers + portal billing | not started |

Everything stays in Stripe **test mode** until reviewed. Until B2 is
deployed, **do not add the Stripe secrets to Vault and do not deploy
`stripe-billing` or `stripe-webhook`**: the deployed v2 / v1 are the 0008
code, which writes columns 0057 drops (both answer 500 without secrets,
so today they do nothing).

## B1: migration 0057

### Tables

**Stripe mirror**: team read-only, written only by the service role (the
Stripe Edge Functions). Every row carries `livemode`. Money is stored as
`bigint` minor units (`*_cents`) with a `currency` on the row.

| Table | Key | Notes |
| --- | --- | --- |
| `stripe_customers` | `stripe_customer_id` (unique, forever one client) | The durable client ↔ customer link. `link_source` is `created` or `linked_existing` (an existing Stripe customer linked by a teammate, never re-created). `unlinked_at` + `unlink_reason` keep a mistaken link as history. `deleted_at` is set when the customer is deleted in Stripe. Default payment method type / brand / last4 |
| `stripe_products` | `stripe_product_id` | Stripe's catalog as Stripe says it is |
| `stripe_prices` | `stripe_price_id` | `type` recurring / one_time, `unit_amount_cents`, interval + count, usage type |
| `checkout_sessions` | `stripe_checkout_session_id` | The Checkout links Compass generates (B3): mode, status, url, expiry, package, requested line items, who created it |
| `subscriptions` | `stripe_subscription_id` | Stripe's status verbatim, collection method, currency, cancel_at_period_end / cancel_at / canceled_at / ended_at + reason, pause_collection, trial, billing-cycle anchor, current period, latest invoice id |
| `subscription_items` | `stripe_subscription_item_id` | price + quantity (NULL for metered) |
| `invoices` | `stripe_invoice_id` | status draft / open / paid / uncollectible / void, subtotal / total / due / paid / remaining, attempts and next attempt, due date, period, hosted URL + PDF, paid / voided / uncollectible stamps. `stripe_subscription_id` NULL = one-time work |
| `invoice_line_items` | `(invoice_id, stripe_line_item_id)` | price / product (soft references, since an ad hoc `price_data` price is never in the catalog), amount (may be negative), period, proration |
| `payments` | `stripe_payment_intent_id` / `stripe_charge_id` | `source` stripe (status, method card / us_bank_account, failure, refunded amount) or external (check / wire / ach_manual / other, reference). External rows are allowed by the schema; who records them is decided in B3 / B5 |
| `stripe_events` | Stripe event id | The webhook ledger: `received` → `processed` / `ignored` (with reason) / `failed` (with error, retried). `attempts`, timestamps, object type / id |

**Compass catalog and agreement**: team-editable.

| Table | Notes |
| --- | --- |
| `service_catalog` | What Compass delivers, keyed by a stable `key` that code reads. `feature` (on/off) or `quota` (unit per month). Seeded: seo, website, gbp, social, paid_ads, crm, reporting, client_portal; blog_posts, website_pages, website_refreshes, gbp_posts, social_posts. `pipeline_key` links a service to its delivery pipeline (not wired) |
| `billing_packages` | `standard` (its own Stripe Product and standard Prices) or `custom` (a general product such as "Compass Custom Retainer" whose Prices are each one client's agreement). One Stripe Product per package |
| `billing_package_prices` | Which recurring Stripe Prices sell a package. A custom-retainer price names its client; a standard price names none. One default per package |
| `billing_one_time_items` | Website projects, setup fees, special projects: one-time Stripe Products |
| `package_entitlements` | What a package includes, per service |
| `plans` | Kept by name, one row per client: now the **agreement**: `package_id`, `collection` (`stripe` or `external` with method, amount, currency, interval), term, dates, managed ad budget (cents), notes, `updated_by`. The fee and the per-plan quantities are gone: the fee is Stripe's, and quantities are entitlements |
| `client_entitlement_overrides` | What one client receives instead of its package's default, with a required reason and the teammate who set it |

### Relationships and constraints

- **Belong together.** Every client-owned mirror row carries `client_id`,
  and its links are composite foreign keys that include it:
  subscription → `(stripe_customer_id, client_id)`, item →
  `(subscription_id, client_id)`, invoice → customer and subscription with
  `client_id`, line item → `(invoice_id, client_id)`, payment and checkout
  session → customer with `client_id`. A row can never point at another
  client's customer, subscription or invoice.
- **Ownership never moves.** A trigger refuses any change to a mirrored
  row's `client_id` or Stripe id (`23514`), and the same applies to a
  package price's client.
- **Customers.** `stripe_customer_id` is unique, so one Stripe customer
  belongs to one client, ever. There is at most one active link per client
  per mode (partial unique index), which prevents duplicate creation and a
  second link. Test and live customers may coexist.
- **Package ↔ price, structurally.** A mapping's composite foreign keys
  require that the price's product is the package's product and that the
  price is recurring. `client_id` is set exactly when the package is
  `custom`. A Stripe product belongs to at most one catalog entry (a
  package or a one-time item, enforced by trigger).
- **Entitlements.** A feature has no quantity; an included quota has one;
  the service kind must match the catalog's (composite FK).
- **External arrangements.** `plans.collection = 'external'` requires
  method, amount, currency and interval; `stripe` forbids them.
- **Payments.** A Stripe payment names its customer and PaymentIntent and
  carries no external fields. An external payment carries no Stripe ids
  and is `succeeded` with a paid date. Refunds never exceed the amount.
- **No "one live subscription" constraint.** This is deliberate: the
  mirror must accept what Stripe holds. Two live subscriptions are flagged
  (`multiple_live_subscriptions`), and Compass's own Checkout will refuse to
  start a second (B3).
- **Clients with billing history cannot be deleted** (foreign keys are
  `restrict`); offboard them instead.
- Stripe ids are checked against their prefixes (`cus_`, `sub_`, `in_`, …),
  currencies must be lower-case ISO codes, and amounts are never negative
  except invoice totals and line items (credits).

### Read models (invoker rights; RLS applies)

- **`client_entitlements`**: per client and catalog service: `enabled`,
  `quantity`, `source` (`package` / `override` / `none`), the package's own
  values for display, and the override reason. Billing state never changes
  it (decision 5).
- **`client_billing_status`**: per client, in the current mode
  (`billing_livemode()`: live only when `app_settings.billing` is exactly
  `{"livemode": true}`). Derived, never stored:
  - `billing_state`: none, checkout_pending, external, incomplete,
    trialing, active, past_due, unpaid, paused, collection_paused,
    canceling, canceled.
  - Subscription fields, `next_billing_at`, and `mrr_cents` from the items
    (month / year / week / day normalised exactly).
  - Open and overdue invoice counts, outstanding amount per currency, and
    the latest invoice with its hosted URL.
  - Any open Checkout link.
  - `billing_attention` with `attention_reasons`:
    - `subscription_past_due`, `subscription_unpaid`,
      `subscription_incomplete`, `invoice_overdue`: Stripe's own state.
    - `multiple_live_subscriptions`, `unmapped_price`,
      `no_agreement_package`, `package_mismatch`: catalog and agreement
      mismatches.

### Retired

0008's `billing-daily-past-due` cron job, `mark_past_due_subscriptions()`,
`subscriptions.paid_status` and the `paid_status_type` /
`payment_method_type` / `payment_source` / `payment_method` enums. The old
tables were empty in production (the migration refuses to run otherwise).

### Access

| Caller | Mirror | Catalog / agreement / overrides | Read models |
| --- | --- | --- | --- |
| Teammate (`is_team()`) | read | read / write | read |
| Stripe functions (service role) | write | write | read |
| Portal contact | nothing (their own client's billing included) | nothing | nothing |
| Signed-in stranger | nothing | nothing | nothing |
| anon | refused | refused | refused |

No security-definer function was added. The Reporting worker reads
`client_entitlements` for "posts planned" (skill updated). No portal view
reads billing yet (B5).

### Stripe object mapping

| Stripe | Compass |
| --- | --- |
| Customer | `stripe_customers` (+ the client) |
| Product | `stripe_products`; a package or one-time item points at it |
| Price | `stripe_prices`; a package's through `billing_package_prices` |
| Checkout Session | `checkout_sessions` |
| Subscription / item | `subscriptions` / `subscription_items` |
| Invoice / line | `invoices` / `invoice_line_items` |
| PaymentIntent + Charge | `payments` (source stripe) |
| Refund | `payments.amount_refunded_cents` (from the charge) |
| Event | `stripe_events` |
| Payment method | summary on the customer and subscription (type, brand, last4) |

### Tenancy (technical debt)

Compass has no organization model yet. Billing keeps to the canonical
client model and does not add a second one. It is built so tenancy can be
added later:

- Every client-owned row carries `client_id` with composite
  belong-together keys, so an organization policy needs one predicate per
  table and cross-client links are impossible today.
- Catalog tables (`service_catalog`, `billing_packages`,
  `billing_one_time_items`, `stripe_products` / `stripe_prices`) are
  agency-level and will take an `organization_id`, along with a Stripe
  account per organization, when tenancy lands.
- RLS reads `is_team()` today. Tenancy will replace it with an
  organization-membership predicate.

### Tests

- `npm run test:sandbox`: `billing_foundation.test.sql` (149 checks:
  structure, service-role writes, every constraint above, teammate cannot
  write the mirror, catalog rules, entitlements, agreements, the derived
  states in test and live mode, portal / stranger / anon, isolation from
  Five Layer / Authority, delete protection). The portal suite's per-table
  checks now cover every billing table too.
- `npm test`: `tests/billing.test.mjs` (money in minor units, agreement
  and override rules, labels).
- `npm run test:billing-ui`: PostgREST + `next dev` + Chromium over the
  replay (Plan tab agreement / overrides / refusals, Content tab planned
  count, Billing tab, Dashboard, Clients list, API boundaries).
