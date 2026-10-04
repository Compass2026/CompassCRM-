# Billing cutover kit (0058 – 0062)

Run in this order, as described in `docs/billing-readiness.md` § 6 and § 17.
Each file is plain SQL for the Supabase MCP's `execute_sql` (it runs as
`postgres`) or the SQL editor. **Nothing here has been run on production.**

| File | When | What |
| --- | --- | --- |
| `01_pause_automation.sql` | before the migrations | pauses the planners B5 changes (weekly blog, website updates) and the monthly reporting fire; prints what it paused |
| (migrations 0058 – 0062) | | `apply_migration`, one at a time |
| `02_agreements.sql` | after the migrations | the **Compass Standard** package (one entitlement definition: nine features; 8 blog / 8 GBP / 8 social posts, 4 new pages, 1 refresh a month) and the **eight confirmed agreements**, each with its structured agreed price (`agreed_amount_cents` 65000 for six, 50000 for BHG Safety Partners and Shewmaker Brothers Masonry; `usd`, every 1 `month`), month-to-month from 2026-10-01, Stripe ACH (`docs/billing-agreement-inventory.md`). No Stripe Price is bound (`billing_package_price_id` null), so Checkout refuses these clients (`agreement_price_not_mapped`) until 07. One atomic statement; idempotent; refuses rather than overwrite a different package or agreement |
| `03_test_client.sql` | after 02 | the fictional *Compass Billing Test Client (TEST)*, paused, with its agreement (agreed $2,500.00/month, the TEST price's terms) and a test portal contact; creates no tasks, fires no worker |
| `04_validate.sql` | after 02 / 03 | refuses (raises) if any active client has no agreement, or any Stripe-collected agreement has no structured agreed price, unless explicitly excluded (after 02 nothing needs excluding); reports each agreement's Checkout readiness (`unmapped` is expected for the eight in test mode; never raises), Compass Standard's agreements and mapped prices, every client's entitlements and this month's allocation |
| `05_resume_automation.sql` | after 04 passes | resumes exactly the jobs 01 paused |
| `06_bind_test_client_price.sql` | test mode, after § 17 step 11 imports Tom's TEST product | binds the test client's agreement to exactly `price_1UMDr54Zq9yMk653B7jdneFm` ($2,500.00/month, test) so its sandbox Checkout runs the same agreement-price enforcement as live; refuses until that price is an approved price of *Test Standard (TEST)*, or in live mode |
| `07_live_bind_standard_prices.sql` | **live mode only, after Option B** and after the live $650 / $500 Prices are mapped to Compass Standard | binds each of the eight agreements to the one live Compass Standard price that says exactly its agreed terms (BHG + Shewmaker → $500, the other six → $650), by amount — no id typed by hand; refuses in test mode, on a missing or ambiguous match; all or nothing |

Tested against the sandbox replay by `supabase/tests/sandbox/billing_cutover_kit.test.sql`
(01 → migrations already applied → 02 refused without the clients, then run twice with them, refusals on a differing agreement, agreed amount or definition, notes never read as the price → 03 → 04 → 05 → 06 refused before the import, then bound → 07 refused in test mode, refused on an ambiguous match, then a simulated live binding with sandbox-only price ids).

**No real Stripe id is invented.** The live Compass Standard Product, its
$650 default Price and its $500 legacy Price do not exist yet; they are
created only once the Option B billing runtime exists, and mapped to the
package in Settings › Billing catalog (placeholders at the end of
`02_agreements.sql`); 07 then binds the agreements to them. The Stripe TEST
product maps to the test client's *Test Standard (TEST)* package, never to
Compass Standard.
