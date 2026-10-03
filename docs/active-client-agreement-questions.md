# Client agreement questions for Tom — ANSWERED (October 2026)

**Status: RESOLVED.** Tom answered these in October 2026. The answers are
recorded in `docs/billing-agreement-inventory.md` (and `.csv`) and seeded at
cutover by `supabase/cutover/02_agreements.sql`. The Sept 30 2026 blank
questionnaire and its operational-evidence notes are in this file's git
history.

## The answers

**Package.** One standard package, **Compass Standard**. Every current
client is on it. There is no separate package for the legacy price.

| Field | Answer (all eight clients) |
| --- | --- |
| Package / Custom Retainer | Compass Standard |
| Monthly amount | $650 default; **$500 legacy** for BHG Safety Partners and Shewmaker Brothers Masonry |
| Term | Month-to-month |
| Start date | 2026-10-01 |
| Collection method | Stripe (ACH) |
| Website Management | Included |
| Website Hosting | Included |
| SEO | Included |
| GBP | Included |
| Social Media | Included |
| Paid Ads | Included |
| CRM | Included |
| Reporting | Included |
| Client Portal | Included |
| Blog Posts / month | 8 |
| GBP Posts / month | 8 |
| Social Posts / month | 8 |
| New Website Pages / month | 4 |
| Website Refreshes / month | 1 |

| Client | Price |
| --- | --- |
| BHG Safety Partners | $500 legacy |
| Shewmaker Brothers Masonry | $500 legacy |
| Logic Solar | $650 default |
| Show Me Design | $650 default |
| Show Me Electrical | $650 default |
| Lucas Construction | $650 default |
| Ginger Huff Interiors | $650 default |
| Pensacola Equipment Rentals | $650 default |

## What the answers settled

1. **Terms per client:** as above; no client is excluded and none needs an
   interim agreement.
2. **The package catalog:** Compass Standard, one entitlement definition
   shared by both prices.
3. **The default cadence:** the confirmed quotas are 8 social / 8 GBP / 8
   blog / 4 new pages / 1 refresh a month (the first four match the Sept 28
   Product & Delivery Standard's planning target). Once 0062 applies the
   agreement replaces the CRM's old fixed rule of 2 pages + 2 refreshes.
4. **Website Management for client-run sites** (Logic Solar, Show Me Design,
   Show Me Electrical): included, so their monthly website updates continue
   as proposed Google Docs.
5. **Hosting, Social, GBP, Paid Ads, CRM, Reporting, Client Portal:**
   included for every client.

## Still open (not agreement questions)

- The live Stripe Product and its $650 default / $500 legacy Prices do not
  exist yet; they are created only after Option B and then mapped to
  Compass Standard (`docs/billing-cutover.md` section 7).
- The Paid Ads budget under management (`plans.managed_ad_budget_cents`) was
  not part of the answers and stays empty; it plans nothing.
