# Client agreement inventory (billing cutover record)

**Status: RESOLVED (October 2026).** Tom confirmed the commercial terms for
all eight current clients. Every one is on **Compass Standard**,
month-to-month from **October 1, 2026**, collected by **Stripe (ACH)**: six
at the $650/month default price, two at the $500/month legacy price. Nothing
is entered in production yet: the terms are seeded at cutover by
`supabase/cutover/02_agreements.sql` (tested in the sandbox by
`billing_cutover_kit.test.sql`), after migrations 0058 – 0062 are applied.

Machine-readable copy: `docs/billing-agreement-inventory.csv`.
The Sept 30 2026 worksheet that preceded this (no terms recorded anywhere;
the operational evidence per client) is in this file's git history.

## Compass Standard (the one standard package)

| | |
| --- | --- |
| Package | **Compass Standard** (`billing_packages.key = compass_standard`, kind `standard`) |
| Default price | **$650.00 / month** |
| Legacy price | **$500.00 / month** (grandfathered) |
| Term | Month-to-month (`plans.term_months` null, no renewal date) |
| Start | October 1, 2026 |
| Collection | Stripe (`plans.collection = 'stripe'`), ACH debit |

Both prices belong to the **same package with the same entitlements**. There
is no separate "legacy" package: the price a client pays never changes what
it receives.

**Included** (features — on, no quantity):

| Service | `service_key` |
| --- | --- |
| Website Management | `website` |
| Website Hosting | `hosting` |
| SEO | `seo` |
| Google Business Profile | `gbp` |
| Social Media | `social` |
| Paid Ads | `paid_ads` |
| CRM | `crm` |
| Reporting | `reporting` |
| Client Portal | `client_portal` |

**Monthly quantities** (quotas; America/Chicago month):

| Quota | `service_key` | Per month |
| --- | --- | --- |
| Blog posts | `blog_posts` | 8 |
| GBP posts | `gbp_posts` | 8 |
| Social posts | `social_posts` | 8 |
| New website pages | `website_pages` | 4 |
| Website refreshes | `website_refreshes` | 1 |

## The eight agreements

All: Compass Standard, month-to-month, start 2026-10-01, Stripe ACH, the full
Standard entitlements, no client overrides.

| Client | Client id | Status today | Price |
| --- | --- | --- | --- |
| BHG Safety Partners | `3eaa3389-2a33-4004-837c-8aef90404410` | active | **$500 legacy** |
| Shewmaker Brothers Masonry | `a88f5ce2-30ac-508b-b217-cf22d277b278` | launching | **$500 legacy** |
| Logic Solar | `70211d71-d9f4-46ab-abe2-ef39c41591fb` | active | $650 default |
| Show Me Design | `d94cfde2-0751-4002-a149-c83b4c6c956d` | active | $650 default |
| Show Me Electrical | `9a8e05f5-3d28-4839-9735-79bcdd0e277d` | active | $650 default |
| Lucas Construction | `102d3b20-2795-44ae-bd64-d1e43916291c` | launching | $650 default |
| Ginger Huff Interiors | `db9009c2-a04b-4e93-843f-e20c49263b5b` | launching | $650 default |
| Pensacola Equipment Rentals | `1e12fc47-731a-4d84-a4f1-4aed777db451` | launching | $650 default |

*Compass Activation Test (fictional)* is offboarded and has no agreement.

## How the price is recorded

The agreement is authoritative for what the client **contracted to pay**;
Stripe stays authoritative for what was actually billed and paid.

- **In the CRM (structured):** each agreement stores
  `plans.agreed_amount_cents` (50000 or 65000), `agreed_currency` (`usd`),
  `agreed_billing_interval` (`month`) and `agreed_billing_interval_count`
  (1). Notes still describe the terms but are never read as the price.
- **The exact Stripe Price:** `plans.billing_package_price_id` names the one
  approved package price Checkout sells for the agreement. It must be a
  price of the agreement's own package (composite foreign key), active,
  recurring, fixed-amount, in the current Stripe mode, and say exactly the
  agreed amount, currency and interval (`plans_agreement_price_guard`). It
  is **NULL for all eight today**: the live Prices do not exist.
- **In Stripe (later, live only):** one Compass Standard Product with two
  monthly Prices, both mapped to the one package in Settings › Billing
  catalog ($650 default, $500 second approved price). **Neither live Price
  exists yet** and no id is invented; the placeholders are at the end of
  `02_agreements.sql` and in `docs/billing-cutover.md`. Then
  `07_live_bind_standard_prices.sql` binds BHG Safety Partners and
  Shewmaker Brothers Masonry to the $500 price and the other six to the $650
  price, by their agreed terms.
- **At Checkout:** there is no price to choose. `stripe-billing` sells
  exactly the bound price and refuses an unbound agreement
  (`agreement_price_not_mapped`), any other price
  (`agreement_price_mismatch`), and a bound price that no longer matches
  the agreement. BHG and Shewmaker cannot be sold $650; the six cannot be
  sold $500.
- **ACH:** `collection = 'stripe'` is the agreement; the payment method is
  chosen on Stripe Checkout, which offers ACH debit (`us_bank_account`) and
  card. Nothing in the CRM restricts a Checkout to ACH only.

## What changes in automation when the agreements apply (0062)

- **Active clients** (BHG Safety Partners, Logic Solar, Show Me Design, Show
  Me Electrical) keep the weekly blog task (within 8 a month; one a week
  never exceeds it) and get the monthly website updates within 4 new pages
  and **1 refresh** a month (Tom's Sept 14 rule was 2 pages + 2 refreshes;
  the agreement now governs, so refreshes drop to 1 and pages may rise to 4).
  Website Management is included for the three client-run sites too, so
  their updates continue as proposed Google Docs.
- **Launching clients** (Ginger Huff, Lucas, Pensacola, Shewmaker) are not
  planned for until they converge to `active`; from then on they are planned
  for within the same Standard entitlements.
- `managed_ad_budget_cents` (Paid Ads budget under management) was not part
  of the confirmed terms and stays empty. It plans nothing.
