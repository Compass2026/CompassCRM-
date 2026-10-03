# Billing cutover kit (0058 – 0062)

Run in this order, as described in `docs/billing-readiness.md` § 6 and § 17.
Each file is plain SQL for the Supabase MCP's `execute_sql` (it runs as
`postgres`) or the SQL editor. **Nothing here has been run on production.**

| File | When | What |
| --- | --- | --- |
| `01_pause_automation.sql` | before the migrations | pauses the planners B5 changes (weekly blog, website updates) and the monthly reporting fire; prints what it paused |
| (migrations 0058 – 0062) | | `apply_migration`, one at a time |
| `02_agreements.sql` | after the migrations | the **Compass Standard** package (one entitlement definition: nine features; 8 blog / 8 GBP / 8 social posts, 4 new pages, 1 refresh a month) and the **eight confirmed agreements** (six at the $650 default, BHG Safety Partners and Shewmaker Brothers Masonry at the $500 legacy price; all month-to-month from 2026-10-01, Stripe ACH; `docs/billing-agreement-inventory.md`). One atomic statement; idempotent; refuses rather than overwrite a different package or agreement. Maps nothing to Stripe |
| `03_test_client.sql` | after 02 | the fictional *Compass Billing Test Client (TEST)*, paused, with its agreement and a test portal contact; creates no tasks, fires no worker |
| `04_validate.sql` | after 02 / 03 | refuses (raises) if any active client has no agreement and is not explicitly excluded (after 02 none of the eight needs excluding); prints whether the $650 / $500 Stripe Prices are mapped to Compass Standard (never raises — they do not exist yet), every client's entitlements and this month's allocation |
| `05_resume_automation.sql` | after 04 passes | resumes exactly the jobs 01 paused |

Tested against the sandbox replay by `supabase/tests/sandbox/billing_cutover_kit.test.sql`
(01 → migrations already applied → 02 refused without the clients, then run twice with them, refusals on a differing agreement or definition → 03 → 04 → 05).

**Stripe Prices are not part of the kit.** The live Compass Standard Product,
its $650 default Price and its $500 legacy Price do not exist yet; they are
created only once the Option B billing runtime exists, and mapped to the
package in Settings › Billing catalog (placeholders at the end of
`02_agreements.sql`). The Stripe TEST product maps to the test client's
*Test Standard (TEST)* package, never to Compass Standard.
