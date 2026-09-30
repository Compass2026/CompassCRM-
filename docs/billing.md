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
Agreement → client_entitlements_for() / client_quota_usage() (B5) → Five Layers
   (never billing state)
```

## Status

| Step | What | State |
| --- | --- | --- |
| B1 | Schema: mirror, catalog, agreement, entitlements, read models | **0058 written, not applied**; review changes made (14-service catalog, `stripe_refunds`, admin-only financial configuration) |
| B2 | Shared Stripe sync layer + corrected webhook | **0059 + `_shared/stripe/` + `stripe-webhook` written and tested, not applied / not deployed** |
| B3 | Checkout, link existing customer, Customer Portal, billing screens | **0060 + `stripe-billing` + app screens written and tested, not applied / not deployed** |
| B4 | Reconciliation | **0061 + `stripe-reconcile` + Stripe sync screens written and tested, not applied / not deployed** |
| B5 | Entitlement interface for the Five Layers + portal billing | **0062 + app + worker skill written and tested, not applied / not deployed** |

Everything stays in Stripe **test mode** until reviewed. **Do not add the
Stripe secrets to Vault and do not deploy `stripe-billing` or
`stripe-webhook` outside the cutover in `docs/billing-cutover.md`**: the
deployed v2 / v1 are the 0008 code, which writes columns 0058 drops (both
answer 500 without secrets, so today they do nothing). 0058 – 0062 ship
together with the app and the three functions. Draft PR:
Compass2026/CompassCRM-#86.

## B1: migration 0058

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
| Stripe sync session (0059) | write, through the sync functions only | — | read | — | read |
| Worker SQL (`postgres`) | **refused** (0059 guard) | owner | owner | owner | read |
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

## B2: the Stripe sync layer (migration 0059, `supabase/functions/_shared/stripe/`, `stripe-webhook`)

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

What 0059 enforces:

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

## B3: billing operations (migration 0060, `stripe-billing`, the app)

### What was built

- **0060** (`supabase/migrations/0059_billing_operations.sql`, not applied):
  `billing_record_checkout` (a Checkout Session the handler created, keyed
  by its Stripe id, audited in the same transaction),
  `billing_record_external_payment` / `billing_void_external_payment`
  (admin-recorded check / wire / manual ACH / other; `client_request_id`
  makes a retry a no-op; the row is immutable except for one void with who,
  when and why; nothing is deleted), and `billing_audit_events`, an
  append-only history of every billing action (team-readable; no API
  writes; update / delete refused even to the service role). All are
  security definer, callable only from an `authenticator` + `service_role`
  session, and write through 0059's mirror guard. The same shared-key
  residual applies: any Edge Function could call them.
- **`stripe-billing`** (`supabase/functions/stripe-billing/`: `handler.ts`
  factory, `store.ts`, `index.ts`; deployed with `verify_jwt = true`): the
  410 stub is replaced by explicit actions. Every Stripe write is followed
  by the shared B2 sync (`_shared/stripe/sync.ts`), so linking, Checkout and
  prices land in the mirror exactly as a webhook would put them. There is no
  separate import logic.
- **App:** the Billing tab (`src/app/(app)/clients/[clientId]/billing/page.tsx`,
  actions in `src/app/billing-actions.ts`), Settings › Billing catalog
  (`src/app/(app)/settings/billing/page.tsx`, `src/app/billing-catalog-actions.ts`),
  the public Checkout return pages (`src/app/checkout/complete`,
  `/checkout/canceled`, exact paths let through by `src/proxy.ts`), pure
  helpers in `src/lib/billing-ops.ts` and the function call in
  `src/lib/stripe-billing-call.ts` (the signed-in person's own JWT; no
  Stripe key is ever in the app).

### Authorization (the existing `team_members.role`; no new framework)

| Action | Admin | Member | Portal contact | Enforced by |
| --- | --- | --- | --- | --- |
| Search Stripe customers, link an existing one, create one | yes | no | no | function (role), 0059 |
| Import a Stripe Product into the catalog | yes | no | no | function |
| Create a client's Custom Retainer price | yes | no | no | function |
| Create / expire a payment link (Checkout) | yes | no | no | function |
| Copy / open / send an existing payment link | yes | yes | no | RLS (team read) |
| Configure the Customer Portal | yes | no | no | function |
| Open the Customer Portal for a client | yes | no | own client only (derived from the sign-in; B5 adds the button) | function |
| Record / void an external payment | yes | no | no | function + 0060 (recorder must be an admin) |
| Re-read a customer from Stripe | yes | yes | no | function |
| Packages, entitlement defaults, one-time items, price mappings, billing mode, team roles | yes | read | no | RLS (`is_team_admin()`, 0058) |
| Client agreement and entitlement overrides | yes | yes | no | RLS (`is_team()`) |
| Read billing (mirror, records, audit) | yes | yes | no | RLS |

The UI shows admin controls to admins only; the function and the database
refuse them for anyone else regardless.

### Stripe API calls

Reads (the sync layer): `GET /v1/customers/:id`, `/v1/customers/search`,
`/v1/products/:id`, `/v1/prices` (`?product=`), `/v1/prices/:id`,
`/v1/subscriptions` (`?customer=&status=all`), `/v1/subscriptions/:id`,
`/v1/invoices`, `/v1/invoices/:id`, `/v1/invoices/:id/lines`,
`/v1/payment_intents`, `/v1/payment_intents/:id`, `/v1/charges/:id`,
`/v1/refunds`, `/v1/refunds/:id`, `/v1/checkout/sessions/:id`,
`/v1/billing_portal/configurations/:id`.

Writes (only `stripe-billing`): `POST /v1/customers`, `POST /v1/prices`,
`POST /v1/checkout/sessions`, `POST /v1/checkout/sessions/:id/expire`,
`POST /v1/billing_portal/configurations`, `POST /v1/billing_portal/sessions`.
Nothing else in Stripe is changed by Compass: no subscription update,
cancel, pause, refund or invoice action.

### Idempotency

| Stripe create | Idempotency key | Compass record |
| --- | --- | --- |
| Customer | `compass-customer-<client>-<mode>-<n>` (n = the client's past links in that mode) | one active link per client and mode (unique index); a customer Compass created but never linked is found by its `compass_client_id` metadata and offered for linking instead |
| Custom price | `compass-price-<request id>` | `billing_package_prices` unique on the Stripe price |
| Checkout Session | `compass-checkout-<client>-<request id>` (`-card` for the card-only fallback) | `checkout_sessions` unique on the session id |
| Session expiry | `compass-expire-<session>` | synced |
| Portal configuration | `compass-portal-config-v<version>-<mode>-<previous id>` | `app_settings.billing_portal` |
| External payment | (no Stripe object) | `payments.client_request_id` unique |

Request ids are generated when the page renders (a hidden field), so a
double click or a retried submit sends the same id. Reusing a key with
different parameters is refused by Stripe (`idempotency_error`); the
function turns that into a plain refusal.

### Customers

- **Link existing:** search by name (substring), email (exact) or `cus_` id;
  each result shows name, email, created date, mode, subscriptions and any
  client it is already linked to. Nothing links on a match: the admin ticks
  "This is <client>'s Stripe customer" and presses Link. Refused: a deleted
  customer, the wrong mode, a customer linked to another client, a second
  active customer for the client, and a customer whose `compass_client_id`
  metadata names another client. Linking never writes to Stripe. The shared
  `linkCustomer` then imports the customer, subscriptions (with items,
  products and prices), invoices (with lines), payments and every refund.
- **Create:** name and billing email (prefilled from the primary contact),
  metadata `compass_client_id` / `compass_client_name`, then linked
  (`link_source = created`) and synced the same way.

### Catalog

Admins add packages (standard or custom retainer), import each package's
Stripe Product (`import_product` syncs the product and all its prices),
approve which recurring Prices sell a standard package (one default), set
what each package includes, and add one-time items with their own Products.
No amount is typed in the catalog: standard prices are created in Stripe and
approved here. A **custom retainer** is one general Product ("Compass Custom
Retainer"); its Prices are created per client by an admin on that client's
Billing tab (`create_custom_price`: integer cents, USD, month or year,
nickname, metadata naming the client) and reserved to that client
(`billing_package_prices.client_id`). One-time items are never part of a
recurring price; selling them through Checkout is not in B3 (invoice them in
Stripe; the mirror records the invoice).

### Checkout and duplicate protection

`create_checkout` takes only `{client_id, package_price_id, request_id}`.
The function resolves the approved mapping, re-reads the price from Stripe
(an archive in the dashboard is honoured), and refuses unless: the mapping
is active and (for a custom package) this client's; the agreement's package
is that package and is collected through Stripe; the price is active,
recurring, licensed, fixed-amount and in the current mode; the client has an
active customer link. It then lists the customer's subscriptions in Stripe
(`status=all`, synced) and the mirror's for the client: any `active`,
`trialing`, `past_due`, `unpaid`, `incomplete` or `paused` subscription
refuses the sale (409 `subscription_exists`, listing them). The mirror can
still represent several subscriptions (Stripe may have them); only creation
is blocked. An open, unexpired link for the client is refused too
(`checkout_open`, returning it), except the same request, which returns the
same session.

The session: `mode=subscription`, the linked customer, `client_reference_id`
and metadata naming the client, package, mapping and request,
`subscription_data.metadata` naming the client and package, one line item
(the approved price, quantity 1), `payment_method_types` card +
`us_bank_account` (retried card-only when the account cannot take ACH, and
reported), success / cancel URLs `<APP_BASE_URL>/checkout/complete` /
`/checkout/canceled`. Those pages are static and public: they read no
session or data. Reaching them proves nothing; the webhook's
`checkout.session.completed` (and, for ACH, the later payment events) is
what the mirror records.

**Payment Link Ready** (Billing tab): client, package, price and interval,
expiry, mode, who created it, the URL, **Copy Payment Link** (clipboard),
**Open Payment Link**, and (admin) **Expire link**. Sending it is the
teammate's (a Send Payment Link action is later work).

### Customer Portal

`configure_portal` (admin, Settings › Billing catalog) creates Compass's
configuration: update payment method, invoice history (view / download),
update email, address, phone and tax id. Cancellation, plan / quantity
changes and pausing are **off**; the configuration id is stored per mode in
`app_settings.billing_portal`. Before every session the function reads the
configuration from Stripe and refuses (`portal_config_unsafe`) if someone
widened it in the dashboard. Sessions are created server-side only, for the
client's active linked customer: a teammate names the client (admin only;
**Manage Billing in Stripe** on the Billing tab); a portal contact names
nothing — the client comes from their sign-in, and any other client id is
refused. The session URL is returned to the caller and not stored. Every
session is audited with its actor.

### External payments

Admin only. Client, amount (integer cents), currency, date received, method
(check / wire / manually received ACH / other), reference, required note.
Recorded as `source = external`, `status = succeeded`, with the admin's
name; idempotent by request id. Never edited or deleted: a mistake is
voided with a reason (shown struck through with who and why) and the correct
payment recorded. Stripe is not involved.

### Test / live

B3 creates Stripe objects in **test mode only**. The function refuses a live
key unless `app_settings.billing` is `{"livemode": true}`, and refuses a test
key once it is (so the screens never show one mode while the function writes
the other). Only an admin can write that setting (0058); there is no mode
switch in the UI. Every billing screen carries a mode banner.

### Five Layers

Nothing in B3 touches the Authority Engine, Client Intelligence, the
Drafter, the Publisher or the Creative Engine, and billing state never
changes an entitlement or stops work.

### Tests (B3)

- `npm test`: `tests/stripe-billing-handler.test.mjs` (22: form encoding,
  search queries, portal configuration rules, Checkout price rules,
  authorization for every action, portal-contact scoping, mode refusals,
  search, linking rules, create-customer idempotency including the
  lagging-search window, catalog import, standard Checkout, injection
  ignored, agreement / archive / no-customer refusals, each blocking
  subscription status, card-only fallback, expiry, Custom Retainer, portal
  sessions and a widened configuration, external payments);
  `tests/billing-ops.test.mjs` (the app's form readers and wording).
- `npm run test:sandbox`: `billing_operations.test.sql` (34: the worker's
  SQL and every non-service session refused, external payment rules,
  idempotency, admin-only, void rules, immutability, append-only audit,
  cross-client Checkout records refused, reads).
- `npm run test:stripe-billing`: the real handler, sync layer, webhook and
  stores over PostgREST + the replay with the fake Stripe (14 end-to-end
  checks).
- `npm run test:billing-ops-ui`: the screens in Chromium with the real
  handler and webhook behind the gateway (13 checks); screenshots in
  `docs/screenshots/billing/`.

## B4: reconciliation (migration 0061, `stripe-reconcile`)

Webhooks are the real-time path; reconciliation is the safety net that makes
Compass converge on Stripe after a missed or failed webhook, an outage, an
interrupted deployment, a change made by hand in Stripe, a customer linked
with history, a Checkout Session that expired unseen, or a catalog change.
It is **not a second sync**: every Stripe read and mirror write goes through
the shared B2 layer (`_shared/stripe/sync.ts` → `billing_sync_apply`).
Stripe wins; reconciliation never writes to Stripe and never changes an
agreement, an entitlement or an external payment.

### Architecture

```
scheduler (pg_cron → billing_fire_reconciliation, daily, after cutover)
admin: Run Billing Reconciliation / Reconcile This Client
   └→ stripe-reconcile (202 + background)
        1. catalog: every mapped Stripe Product + all its Prices     ┐ fingerprint
        2. each linked customer: resyncCustomer, invoices Stripe no   │ before / after
           longer lists, non-final Checkout Sessions                  ┘ = repairs
        3. webhook ledger: failed + stale-lease events, re-synced from Stripe now
   └→ billing_reconciliation_runs / _results (0061)
   └→ client_billing_status (unchanged) raises attention from the repaired mirror
```

- **`supabase/functions/stripe-reconcile/`**: `handler.ts` (who may call,
  mode checks, begin, 202, background), `engine.ts` (the three passes, change
  measurement, failure handling; pure helpers unit-tested), `store.ts` (the
  stripe-billing store plus reconciliation reads and the 0061 functions),
  `index.ts`. Deployed with `verify_jwt = true`.
- **Measuring repairs without a second sync.** 0061's
  `billing_mirror_fingerprint(client, mode)` returns one digest per mirrored
  object (the row minus `id`, timestamps and `stripe_synced_at`; a
  subscription includes its items, an invoice its lines), and
  `billing_catalog_fingerprint(mode)` the same for mapped products and their
  prices. The engine takes one before and one after re-reading; the
  difference, by category (`subscription_updated`, `invoice_imported`,
  `invoice_removed`, `payment_imported`, `refund_imported`,
  `checkout_updated`, `catalog_product_updated`, `catalog_price_updated`, …),
  is what the run repaired. A re-read that finds nothing new changes no digest,
  so a second run reports zero. No Stripe payload is stored. A webhook that
  lands during a run may be counted as a repair (documented, harmless).

### Scheduling and authorization

| Caller | How | Scope |
| --- | --- | --- |
| Scheduler | `billing_fire_reconciliation()` (0061) posts with the anon key (gateway) and header `x-billing-reconcile-secret` = Vault `BILLING_RECONCILE_SECRET` (compared in constant time). **Not scheduled yet**: the cutover runbook schedules it daily. | agency-wide |
| Admin | their own JWT (`team_members.role = admin`), Settings › Billing **Run Billing Reconciliation** | agency-wide |
| Admin | their own JWT, the client's Billing tab **Reconcile This Client** | one client |
| Member, portal contact, stranger, anon | refused (403 / 401) before Stripe is called | — |

The dedicated secret narrows who can trigger a run compared with the shared
`SYNC_CRON_SECRET`, but anything that can read Vault (the service role, the
worker's SQL as `postgres`) can read it; a run only re-reads Stripe and is
idempotent, so the exposure is Stripe API usage. The shared service-role key
residual (above) applies to 0061's functions too. One run at a time per
mode (409 `run_in_progress`); a run left running 30 minutes is closed as
failed when the next begins. A live key is refused until billing is switched
to live, a test key once it is.

### Run history (0061)

- `billing_reconciliation_runs`: mode, trigger (`schedule` / `admin` /
  `admin_client`), who, scope, status (`running`, `completed`,
  `completed_with_errors`, `partial`, `failed`), started / completed,
  `customers_examined`, `customers_repaired`, `objects_examined`,
  `records_changed`, `warnings`, `failures`, `events_recovered`, `error`, and
  `summary` (JSON: objects examined by kind, changes by category, the ledger
  pass, up to 50 warnings and failures, customers skipped by the time limit).
- `billing_reconciliation_results`: one row per client per run: customer,
  status (`healthy` / `repaired` / `attention` / `failed`),
  `records_changed`, `changes` by category, `objects_examined`, the client's
  `attention_reasons` after the run (from `client_billing_status`),
  warnings (`customer_deleted_in_stripe`, `checkout_missing:<id>`), error.
- Both team-read, append-only (a run changes only while running), written
  only by `billing_reconcile_begin` / `_client` / `_finish` in the function's
  session through 0059's guard.
- Read models: `client_billing_reconciliation` (each client's latest result
  in the current mode: "Last reconciled", "Result") and `billing_sync_health`
  (failed and stuck webhook events, the last agency-wide run).

### What is reconciled

1. **Catalog** (agency-wide runs): every Stripe Product a package or one-time
   item maps, in the current mode, and every Price on it (paginated). An
   archived / deleted product or price is mirrored as such; the Compass
   mapping is **kept** and a warning (`catalog_price_archived`,
   `catalog_product_archived`, `catalog_product_other_mode`) is shown on the
   run for an admin.
2. **Customers**: every active linked customer in the mode, least recently
   reconciled first, **two at a time**. `resyncCustomer` re-reads the
   customer, every subscription (`status=all`) with items, products and
   prices, every invoice with its lines, every PaymentIntent with its latest
   charge and every refund (all paginated). Then the invoices Compass holds
   that Stripe no longer lists (re-read one by one: a deleted draft is
   removed, as the webhook's `invoice.deleted` would), and Compass-created
   Checkout Sessions that are open (whatever the local expiry says: Stripe
   decides) or complete with the payment still settling. A customer deleted in
   Stripe is marked deleted, flagged, and not listed further.
3. **Webhook ledger** (agency-wide runs, last): up to 100 `failed` events and
   `processing` events whose lease expired, oldest first, claimed through
   `billing_event_begin`, re-synced from the object id (the stored payload is
   never replayed; deletions use the existing deleted-object handling) and
   finished `processed` / `ignored`, or failed again with the reason.
   Unsupported events are `ignored`, never failures.

Stripe faithfully mirrored means: two live subscriptions are both kept and
raise `multiple_live_subscriptions`; a subscription on another package's
price raises `package_mismatch`; past due / unpaid follow Stripe. Nothing is
deleted or rewritten to resolve them.

### Failure handling, rate limits, scale

- **Per customer:** an error is recorded on that client (`failed`, with the
  reason) and the run continues; the run ends `completed_with_errors`.
- **Systemic:** a Stripe 401 / 403 / authentication error, a database error
  while recording, or three customers failing in a row fails the run with
  the reason. A preflight read checks the key first.
- **Time budget:** 300 s by default; customers not reached are counted
  (`summary.skipped`) and the run is `partial`. The next run starts with them.
- **Rate limits:** the Stripe client (`_shared/stripe/api.ts`) retries 429,
  5xx, a retryable 409 and network errors up to twice, honouring
  `Retry-After` (capped at 10 s), else exponential backoff with jitter; it
  never retries `Stripe-Should-Retry: false`, and retries a create only when
  it carries an idempotency key. Concurrency is two customers.

### UI

- **Settings › Billing:** Stripe sync (webhook health, last agency-wide run,
  mode), **Run Billing Reconciliation** (admin), and the last ten runs
  (started, completed, status, mode, by, customers, repairs, warnings,
  failures, with the warnings and failures behind a disclosure).
- **Client Billing tab:** Stripe sync (webhook health, last reconciled,
  result — "No differences", "Repaired N billing records", "· needs
  attention", "Failed" — what changed, the attention reasons) and **Reconcile
  This Client** (admin). Members see everything but the buttons.
- The admin actions call the same function the scheduler does and wait up to
  20 s for the run to say what it found.

### Tests (B4)

- `npm test`: `tests/stripe-reconcile-handler.test.mjs` (fingerprint diffs,
  statuses, bounded concurrency, the secret, pagination over three pages,
  retries for 429 / 5xx / network / should-retry / auth / creates, every
  caller refused or admitted, one run at a time, mode, one customer failing,
  an authentication failure, three in a row, the time budget) and
  `tests/billing-reconcile.test.mjs` (the screens' wording).
- `npm run test:sandbox`: `billing_reconciliation.test.sql` (44: the worker's
  SQL and every non-service session refused, one running run per mode,
  abandoned runs, results bound to the client's own customer in the run's
  mode, append-only history, fingerprints ignore bookkeeping and count one
  change per object, external payments excluded, live / test views, portal
  isolation, the unscheduled fire function).
- `npm run test:stripe-reconcile`: 19 end-to-end checks over PostgREST with
  the fake Stripe (healthy and idempotent runs, missed subscription / invoice
  / payment / refund / Checkout / product / price, failed and stale webhook
  recovery, deleted objects, multiple subscriptions, package mismatch,
  external payments and entitlements untouched, test / live and cross-client
  isolation, unauthorized callers, admin runs, one customer failing, a
  global failure, run counts, last reconciled).
- `npm run test:billing-reconcile-ui`: 4 browser checks; screenshots in
  `docs/screenshots/billing/reconcile-*.png`.

## B5: the entitlement contract and portal billing (migration 0062, the app)

Two paths, kept apart:

```
Stripe → billing mirror → client_billing_status        (money: B1–B4)
Agreement (plans.package_id) + package_entitlements + client overrides
       → client_entitlements_for() → the Five Layers    (scope: B5)
```

Billing never controls entitlements: a past-due, unpaid or canceled
subscription, `billing_attention` or a reconciliation run changes nothing
in what Compass plans. Stripe is never called by, and no billing table is
read by, Client Intelligence, the Authority Engine, the Drafter, the
Publisher or the Creative Engine.

### The entitlement interface (0062)

- **`client_entitlements_for(p_client_id uuid default null)`**: invoker
  rights over `client_entitlements` (0058); one row per client and catalog
  service. Columns: `client_id`, `service_key`, `service_name`, `kind`
  (`feature` | `quota`), `enabled`, `quantity`, `unit`, `period`, `source`
  (`package` | `client_override` | `none`), `package_id`, `sort_order`.
  No Stripe concept. A quota's `quantity` is its monthly allocation: **0
  when disabled or not agreed, never NULL, never unlimited**; a feature's
  is NULL. With no argument it returns every visible client in one call
  (no N+1). A teammate and the service role see every client; a portal
  contact, a stranger or anon see nothing (anon cannot execute it).
- **Service keys.** Features: `seo`, `website`, `hosting`, `gbp`,
  `social`, `paid_ads`, `crm`, `reporting`, `client_portal`. Quotas:
  `blog_posts`, `website_pages`, `website_refreshes`, `gbp_posts`,
  `social_posts`. Typed in `src/lib/entitlements.ts` (`FEATURE_KEYS`,
  `QUOTA_KEYS`).
- **Typed helpers** (`src/lib/entitlements.ts`): `getClientEntitlements`,
  `getClientEntitlement`, `getEntitlementsForClients` (bulk),
  `getQuotaUsage`, `getClientAgreement` (a screen's fail-safe read),
  `includes`, `monthlyAllocation`, `remainingAllocation`, `planWork`,
  `serviceScope`, `targetText`. A read error or no rows throws
  `EntitlementsUnavailable`: callers that plan stop and say why, and never
  treat "unreadable" as "nothing included" or "unlimited".
- **What automation needs for each kind of work** (`WORK_REQUIREMENTS`,
  mirrored in the SQL planners): Business Profile posts → `gbp` +
  `gbp_posts`; social posts → `social` + `social_posts`; blog posts →
  `blog_posts`; new pages → `website` + `website_pages`; refreshes →
  `website` + `website_refreshes`. A feature that is off means no
  automatic work of that kind, whatever the quota says.

### Monthly quota accounting (0062)

`client_quota_usage(p_client_id default null, p_month default this month)`
on the America/Chicago calendar month, for each quota: `allocation` (live
from the entitlements), `completed`, `planned`, `used` = completed +
planned, `remaining` = max(0, allocation − used), `over_allocation` =
max(0, used − allocation). What counts:

| Quota | Completed | Planned |
| --- | --- | --- |
| `blog_posts` | Compass `content_posts` published this month | Compass posts not published and due this month; open `blog_post` tasks created this month |
| `gbp_posts` | `google_business` posts published this month | not rejected, not published, scheduled (or, unscheduled, created) this month |
| `social_posts` | the same on every other platform | the same |
| `website_pages` | `change_log` `page_added`, approved, this month | proposed |
| `website_refreshes` | `change_log` `page_rewrite`, approved | proposed |

A `site_inventory` page (0050) is never Compass's work. A vetoed change or
a rejected post does not count. A mid-month increase opens room at once; a
decrease leaves `remaining` at 0 and reports the excess — **nothing is ever
deleted to fit**. Known limits: a blog task and the post it produced can
both count for the moments between the worker recording the post and
closing the task; a failed publish still counts as planned until someone
rejects or reschedules it.

### Planning within the agreement

- **Weekly blog post** (`create_weekly_blog_tasks`, redefined): a task only
  while `blog_posts` has room this month.
- **Monthly website updates** (`fire_website_updates`, redefined): the
  worker is fired only with the `website` feature and room in
  `website_pages` or `website_refreshes`. The cycle's `site_updates` task
  stays open for a person either way.
- Every decision is a row in **`automation_entitlement_log`** (`created` /
  `skipped` with `within_allocation`, `not_in_agreement`,
  `allocation_used` or `entitlements_unavailable`, and the numbers). If the
  entitlements cannot be read the planner catches the error, logs
  `entitlements_unavailable` and plans nothing for that client.
- **The worker skill** reads `client_quota_usage` for website updates (the
  cap per kind), the weekly blog task, the first month's GBP posts and the
  report's activity, and stops with the reason if it cannot.
- **Authority**: the engine's analysis is unchanged (deterministic,
  fingerprinted, no entitlement input — `authority_input` is deliberately
  not extended). `src/lib/authority-agreement.ts` marks each opportunity's
  work on the Authority tab: "Not in agreement", "Allocation used", or
  unmarked with the room left in its title; "Agreement unknown" when the
  entitlements cannot be read. Nothing is hidden, and the "Planning within
  the agreement" card shows the month's GBP / blog / page / refresh
  targets. The Drafter hand-off stays a teammate's request, so it is not
  blocked.
- **People keep operational control.** No database constraint refuses work
  beyond the allocation: a teammate may add posts, pages or tasks, and they
  show as over allocation.

### Screens

- Client **Tasks**, **Content**, **Social** and **Authority** show "3 / 4
  planned" targets from `client_quota_usage` (`MonthlyAllocation`); Social
  counts Business Profile posts apart from social posts (before B5 the tab
  counted every platform against `social_posts`).
- **Reports** keeps actual (published blog / social / Business Profile per
  cycle) and included (the agreement) apart (`src/lib/reporting-activity.ts`).
- **Intelligence** shows the service scope (included, every month, not
  included). `client_intelligence_input` is unchanged, since Authority
  fingerprints it, and the scope never changes which facts a post may cite.

### Agreement history and versioning

`client_agreement_events` (0062) keeps every change to `plans` and to
`client_entitlement_overrides`, including a removed override, with before /
after and the teammate. It is append-only and written only by trigger; no-op
updates are skipped. The override row itself keeps its reason, `updated_by`
and `updated_at`. **Agreements are not versioned:** entitlements are
always read as of now, so a past month's "included" shows today's terms.
The history makes the terms at a date recoverable by hand; versioned
agreements (effective dates, per-period entitlements) are follow-up work.

### Portal billing

- **Route** `/portal/billing` and a **Billing** tab in the portal nav, shown
  once the client has an agreement (`src/app/portal/billing/page.tsx`,
  `src/components/portal-nav.tsx`). Team members are still sent out of the
  portal by the portal layout, and portal contacts out of the CRM.
- **Read models (0062)**, 0037's pattern (owner-run views filtered by
  `portal_client_id()`; `revoke all`, then `grant select to
  authenticated`, checked by 0062's verify block and the sandbox's generic
  portal checks):
  - `portal_billing_summary`: plan name, collection, status as a
    client-safe code (`active`, `trial`, `payment_attention` for past due
    or unpaid, `payment_pending`, `scheduled_to_end`, `ended`, `external`,
    `awaiting_setup`, `paused`, `not_set_up`), monthly amount / currency /
    next billing date / end date for Stripe-collected agreements only, and
    `can_manage_billing`.
  - `portal_billing_invoices`: number, date, status, amounts, due date,
    period, and Stripe's `hosted_invoice_url` / `invoice_pdf`. Current
    billing mode only; never drafts.
  - `portal_entitlements`: the included services and monthly deliverables,
    from the same entitlement contract, without `source`, package or
    override reason.
- `client_billing_status` and `client_entitlements` are security-invoker
  views, which Postgres checks with the caller's rights even inside an
  owner-run view. Two security-definer row functions sit between them and
  the portal: `portal_billing_summary_row()` and
  `portal_entitlement_rows()`. Each takes no argument, answers only for
  `portal_client_id()`, and returns only the client-safe columns.
  `billing_livemode()` is now security definer, because it read
  `app_settings` with the caller's rights and would have shown a portal
  contact test mode in live mode.
- **Never exposed**:
  - Stripe ids, package ids
  - `billing_attention` codes, reconciliation / webhook data, the audit
    trail
  - admin notes, override reasons, external-payment notes / methods / references
- **Status wording** (`src/lib/portal-billing.ts`):
  - Active; Trial
  - "Payment needs attention" (with what to do)
  - "First payment pending"; "Scheduled to end"; "Ended"
  - "Managed directly with Compass"
  - "Waiting for your payment details"; "Paused"; "Not set up yet"
- **Manage billing** (`openPortalBillingAction`) calls B3's
  `create_portal_session` with the contact's own sign-in and **no client
  id**. `stripe-billing` derives the client from the sign-in, refuses any
  other, re-checks Compass's restricted Customer Portal configuration
  (payment method, invoices, contact details; no cancel, plan or quantity
  changes), audits it as the portal contact, and returns to
  `/portal/billing`. On any failure the contact sees one generic message.
- **External arrangement**: status "Managed directly with Compass", the
  sentence "Billing is managed directly with Compass.", no amounts, no
  invoices and no Stripe button.

### Tests (B5)

- `npm test`:
  - `tests/entitlements.test.mjs` (the typed model, not-included = 0,
    overrides, fail safe, bulk read, remaining, planned / completed,
    mid-month changes, excess kept, human extra work, features gate work)
  - `tests/authority-agreement.test.mjs` (Authority reads the entitlements
    over the production Lucas run; nothing hidden; unknown when unreadable)
  - `tests/reporting-activity.test.mjs` (actual vs included; GBP apart from
    social)
  - `tests/five-layer-no-billing.test.mjs` (no Stripe or billing table in
    Five Layer code)
- `npm run test:sandbox`:
  - `billing_entitlements_portal.test.sql` (82 checks):
    - the contract
    - billing states and reconciliation change nothing
    - fail safe
    - quota accounting
    - the weekly blog and website-update gates
    - mid-month changes, nothing deleted, human extra work
    - agreement history
    - no Five Layer function reads billing
    - portal isolation, read-only, external, live / test, status codes
    - team access unchanged
  - `portal_access.test.sql` now covers eleven portal views.
- `npm run test:portal-billing-ui`: 6 browser checks with the real
  `stripe-billing` over the fake Stripe:
  - the page
  - Manage billing (no client id, own customer, return URL, audit)
  - a past-due status
  - an external client
  - cross-client refusal
  - routing
- `npm run test:entitlements-ui`: 6 browser checks (Tasks / Content /
  Social / Reports / Intelligence targets, and no agreement reads "not
  included").
- Screenshots: `docs/screenshots/billing/portal-billing-*.png`,
  `docs/screenshots/billing/entitlements-*.png`.
