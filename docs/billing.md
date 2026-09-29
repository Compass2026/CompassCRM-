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
| B1 | Schema: mirror, catalog, agreement, entitlements, read models | **0057 written, not applied**; review changes made (14-service catalog, `stripe_refunds`, admin-only financial configuration) |
| B2 | Shared Stripe sync layer + corrected webhook | **0058 + `_shared/stripe/` + `stripe-webhook` written and tested, not applied / not deployed** |
| B3 | Checkout, link existing customer, Customer Portal, billing screens | not started |
| B4 | Reconciliation | not started |
| B5 | Entitlement interface for the Five Layers + portal billing | not started |

Everything stays in Stripe **test mode** until reviewed. **Do not add the
Stripe secrets to Vault and do not deploy `stripe-billing` or
`stripe-webhook` outside the cutover in `docs/billing-cutover.md`**: the
deployed v2 / v1 are the 0008 code, which writes columns 0057 drops (both
answer 500 without secrets, so today they do nothing). Draft PR:
Compass2026/CompassCRM-#86.

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
| `payments` | `stripe_payment_intent_id` / `stripe_charge_id` | `source` stripe (status, method card / us_bank_account, failure, Stripe's aggregate refunded amount for display) or external (check / wire / ach_manual / other, reference). External rows are allowed by the schema; recording them is an admin action in B3, with an audit trail |
| `stripe_refunds` | `stripe_refund_id` (`re_` / `pyr_`) | Every Stripe refund, one row each (a payment may have several partial refunds): client, payment (a Stripe payment only), PaymentIntent / charge, amount, currency, Stripe status (pending / requires_action / succeeded / failed / canceled), reason, failure reason, created, livemode (the PaymentIntent's: a Refund carries none) |
| `stripe_events` | Stripe event id | The webhook ledger: `received` → `processed` / `ignored` (with reason) / `failed` (with error, retried). `attempts`, timestamps, object type / id |

**Compass catalog and agreement**: team-editable.

| Table | Notes |
| --- | --- |
| `service_catalog` | What Compass delivers, keyed by a stable `key` that code reads. `feature` (on/off) or `quota` (unit per month). The initial 14, not a closed list: features seo (SEO), website (Website Management, the recurring service; one-time website projects are `billing_one_time_items`), gbp (Google Business Profile), social (Social Media), paid_ads (Paid Advertising), crm (CRM), reporting (Monthly Reporting), client_portal (Client Portal), hosting (Website Hosting); quotas blog_posts (Blog Posts), website_pages (New Website Pages), website_refreshes (Website Page Refreshes), gbp_posts (Google Business Profile Posts), social_posts (Social Media Posts). `pipeline_key` links a service to its delivery pipeline (not wired) |
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
  - Open, overdue and settling invoice counts (an invoice whose ACH debit is
    still `processing` is settling, never overdue), outstanding amount per
    currency, and
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

**Authorization model.** The existing `team_members.role` (`admin` /
`member`, 0001) — no parallel permission system. `is_team_admin()` (invoker
rights) reads it. Production has one admin today.

| Caller | Stripe mirror | Catalog + Stripe mapping (services, packages, package prices, one-time items, package entitlements) | Billing mode (`app_settings` `billing…`) | Agreement (`plans`) + client overrides | Read models |
| --- | --- | --- | --- | --- | --- |
| Admin | read | read / write | read / write | read / write | read |
| Member | read | read | read | read / write | read |
| Stripe sync session (0058) | write, through the sync functions only | — | read | — | read |
| Worker SQL (`postgres`) | **refused** (0058 guard) | owner | owner | owner | read |
| Portal contact / stranger | nothing (their own client's billing included) | nothing | nothing | nothing | nothing |
| anon | refused | refused | refused | refused | refused |

- **Admins cannot be minted by members.** A trigger on `team_members`
  refuses a signed-in non-admin who creates an admin, changes anyone's
  role, or edits / removes an admin's row (re-pointing an admin row's
  `auth_user_id` would take the role over). Supabase Auth's own linking,
  the service role and the worker (no signed-in user) are not gated there.
- Manual payment recording is admin-only and arrives in B3 (a governed
  function with an audit trail); today nobody can write `payments` through
  the API.
- The Reporting worker reads `client_entitlements` for "posts planned"
  (skill updated). No portal view reads billing yet (B5).

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
| Refund | `stripe_refunds` (every refund); `payments.amount_refunded_cents` is the charge's aggregate, for display |
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

### Tests (B1)

- `npm run test:sandbox`: `billing_foundation.test.sql` (190 checks:
  structure, the 14-service catalog, every constraint above, refunds,
  teammate cannot write the mirror, admin-only catalog / billing mode /
  roles, catalog rules, entitlements, agreements, the derived
  states in test and live mode, portal / stranger / anon, isolation from
  Five Layer / Authority, delete protection). The portal suite's per-table
  checks now cover every billing table too.
- `npm test`: `tests/billing.test.mjs` (money in minor units, agreement
  and override rules, labels).
- `npm run test:billing-ui`: PostgREST + `next dev` + Chromium over the
  replay (Plan tab agreement / overrides / refusals, Content tab planned
  count, Billing tab, Dashboard, Clients list, API boundaries).

## B2: the Stripe sync layer (migration 0058, `supabase/functions/_shared/stripe/`, `stripe-webhook`)

### Architecture

```
Stripe event ──► stripe-webhook/handler.ts
                   verify signature (whsec, 5-minute tolerance)
                   claim in the ledger (billing_event_begin: one delivery works it)
                   syncEvent ──┐
reconciliation (B4) ───────────┤
link existing customer (B3) ───┼──► _shared/stripe/sync.ts
manual resync ─────────────────┘      read the object from Stripe NOW (api.ts, pinned version)
                                      map it (map.ts, one mapper per object)
                                      store.apply → billing_sync_apply (one transaction per object group)
                   finish (processed / ignored + reason) or fail (error kept; 500 → Stripe retries)
```

- **One path.** Every trigger calls the same `createStripeSync` functions
  (`syncEvent`, `syncCustomer`, `syncSubscription`, `syncInvoice`,
  `syncPaymentIntent`, `syncRefund`, `syncCheckoutSession`,
  `resyncCustomer`, `linkCustomer`), so a Stripe object is mapped and written
  the same way whatever asked.
- **Fetch-on-event.** An event only names the object; its payload is never
  written. The object is read from Stripe at sync time, so a late,
  duplicated or reordered event converges on Stripe's present state.
- **Newest read wins.** Every row carries `stripe_synced_at` (the read
  time); `billing_sync_apply` never lets an older read overwrite a newer
  one, so two concurrent syncs of one object converge.
- **Deleted objects** are recorded from the event itself, because Stripe
  may no longer return them: `customer.deleted` / `product.deleted` /
  `price.deleted` set `deleted_at` (history kept; a product or price also
  becomes inactive), and `invoice.deleted` removes a draft (a finalized
  invoice is never removed). An update event for an object Stripe no longer
  returns (404) is treated the same way. A canceled subscription is still
  retrievable and is synced normally.
- **Stripe is read, never written**, by the sync layer. B3's actions add
  the writes they need (Checkout, portal sessions, customers).
- **API version pinned** at `2025-03-31.basil` (`STRIPE_API_VERSION` in
  `api.ts`), with the older field locations as fallbacks in `map.ts`. No
  Stripe SDK: plain `fetch`, so the same code runs in Deno and in the Node
  tests.

### Objects synchronised

| Stripe | How it is synced |
| --- | --- |
| Customer | update-only on a linked customer (email, name, currency, default payment method summary); linking creates the row (`billing_link_customer`) |
| Product / Price | upserted whenever seen (price events, or as a subscription's items) |
| Subscription + items | the item set is replaced with Stripe's; products / prices first |
| Invoice + lines | its subscription first, then the invoice and its full line list (paginated), then each PaymentIntent it was paid with |
| PaymentIntent + Charge | one `payments` row (status, method, failure, Stripe's refunded aggregate) |
| Refund | every refund of the PaymentIntent, listed from Stripe, one row each |
| Checkout Session | update-only (Compass creates the rows in B3); what a completed session produced (subscription, invoice or payment) is synced either way |

Ownership comes from the customer link inside the database: a caller never
names the client (a row that does is overridden). An object of a customer
Compass has not linked is skipped (`unlinked`); a live object on a test
customer (or the reverse) is refused (`mode_mismatch`).

### Webhook events subscribed (explicit, no wildcard)

`customer.updated`, `customer.deleted`, `product.created`,
`product.updated`, `product.deleted`, `price.created`, `price.updated`,
`price.deleted`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`customer.subscription.paused`, `customer.subscription.resumed`,
`invoice.created`, `invoice.finalized`, `invoice.updated`, `invoice.paid`,
`invoice.payment_failed`, `invoice.payment_action_required`,
`invoice.voided`, `invoice.marked_uncollectible`, `invoice.deleted`,
`payment_intent.processing`, `payment_intent.succeeded`,
`payment_intent.payment_failed`, `payment_intent.canceled`,
`charge.refunded`, `refund.created`, `refund.updated`, `refund.failed`,
`checkout.session.completed`, `checkout.session.expired`,
`checkout.session.async_payment_succeeded`,
`checkout.session.async_payment_failed` (34; `STRIPE_WEBHOOK_EVENTS` in
`sync.ts` is the source). Anything else delivered is recorded `ignored`
(`unsupported_event`).

### Event processing and idempotency

- `billing_event_begin` inserts the event once (its Stripe id is the key)
  and **claims** it with a five-minute lease: `received`, `failed` or an
  expired `processing` → `processing`, attempt + 1. The claiming attempt
  number is the ownership token.
- A concurrent delivery of the same event is told `in_progress` → **409**
  (Stripe retries later and then gets a duplicate 200). A finished event's
  redelivery → **200 duplicate**, and nothing is re-run.
- Success → `billing_event_finish` (`processed`, or `ignored` with the
  reason: `customer_not_linked`, `mode_mismatch`, `unsupported_event`,
  `not_created_by_compass`, …) → **200**.
- Failure (Stripe API error, database error) → `billing_event_fail` keeps
  the error, the event is **not** processed → **500**, and Stripe retries
  (for up to three days). A crash mid-sync leaves `processing` until the
  lease expires, then the next delivery takes it over; the crashed attempt
  can no longer finish.
- Each object group is one transaction (`billing_sync_apply`). A sync that
  touches several groups (an invoice and its subscription) may commit the
  first before a later one fails; the retry re-reads everything, and
  because every write is an idempotent newest-read upsert, the result is
  the same as an uninterrupted run.
- Reconciliation (B4) will replay `failed` / stale `processing` events and
  resync customers through the same functions.

### Test / live isolation

- The mode is the secret key's (`sk_test_` / `sk_live_`). An event whose
  `livemode` differs is recorded `ignored` (`mode_mismatch`). Each mode has
  its own webhook endpoint and signing secret in Stripe.
- A **live key processes nothing until an admin switches billing to live**
  (`app_settings.billing = {"livemode": true}`): the webhook answers 503
  `live_mode_not_enabled`.
- In the database every mirrored row carries `livemode`, an object must
  match its customer's mode, and the read models show one mode.

### The write boundary, and its limit (production-blocking follow-up)

What was checked (production, Sept 29 2026): the Foundation worker's SQL
(Supabase MCP) runs as `postgres` (table owner, BYPASSRLS, not a superuser);
**every** Edge Function reaches Postgres through PostgREST as
`authenticator` + `service_role` with the one project-wide service-role key
(Supabase project secrets are shared by all functions); the app uses user
JWTs only.

What 0058 enforces:

- The mirror tables (and the ledger) refuse every insert / update / delete /
  truncate unless it runs inside a billing sync function called by an
  `authenticator` + `service_role` session. The worker's SQL is refused
  whatever role it switches to or flag it sets (its `session_user` is
  always `postgres`); `service_role` has no direct write grant on the
  mirror; teammates, portal contacts and anon have no write path at all.
  The sync functions accept only Stripe-shaped rows and derive ownership
  themselves.

What it cannot enforce: **any Edge Function in the project** holds the same
service-role key and could call `billing_sync_apply`. The database cannot
tell the Stripe functions from the other fourteen; between Edge Functions
the boundary is code review. Hard, credential-level isolation needs the
Stripe sync to run with a credential no other code holds — in practice a
separate runtime (e.g. a dedicated Supabase project, or a server outside
Supabase connecting as its own Postgres login with grants only to the sync
functions). That is an infrastructure change, recorded here as a
**production-blocking follow-up**: decide to accept the shared-key residual
(the same trust model the publisher and Drafter run on) or to re-host the
sync before live billing.

Also out of scope (as 0047): a deliberate schema change by the table owner
(disabling the triggers) defeats any in-database control.

### Tests (B2)

- `npm test`: `tests/stripe-sync.test.mjs` (signatures, the pinned API
  client, every mapper in both API shapes, fetch-on-event, invoice ordering,
  refunds, deleted objects, Checkout, customer import, outcomes, the event
  list) and `tests/stripe-webhook-handler.test.mjs` (signature refusal,
  processing, duplicate and concurrent delivery, failed write → retry,
  Stripe API failure, out-of-order, test / live, unlinked customers,
  unsupported / deleted events, refunds, config).
- `npm run test:sandbox`: `billing_sync.test.sql` (53 checks: the worker's
  SQL refused with and without SET ROLE / the flag, direct service-role
  writes refused, linking rules, newest-read-wins, item / line replacement,
  cross-client and mode refusal, refunds, deleted markers, the ledger's
  claim / lease / fail / retry / finish, team / portal / anon refused).
- `npm run test:stripe-webhook`: the real handler, sync layer and store over
  PostgREST + the replay with the fake Stripe (13 end-to-end checks,
  including concurrent delivery, failure then retry, cancellation, three
  partial refunds, test / live and cross-client isolation, unauthorized
  writes by a teammate / the service role / the worker, and a canonical
  resync after a missed webhook).
