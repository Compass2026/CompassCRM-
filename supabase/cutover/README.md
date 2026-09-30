# Billing cutover kit (0058 – 0062)

Run in this order, as described in `docs/billing-readiness.md` § 6 and § 17.
Each file is plain SQL for the Supabase MCP's `execute_sql` (it runs as
`postgres`) or the SQL editor. **Nothing here has been run on production.**

| File | When | What |
| --- | --- | --- |
| `01_pause_automation.sql` | before the migrations | pauses the planners B5 changes (weekly blog, website updates) and the monthly reporting fire; prints what it paused |
| (migrations 0058 – 0062) | | `apply_migration`, one at a time |
| `02_agreements.template.sql` | after the migrations | **template**: the package catalog and every active client's agreement; filled in only from Tom's confirmed terms (`docs/billing-agreement-inventory.md`) |
| `03_test_client.sql` | after 02 | the fictional *Compass Billing Test Client (TEST)*, paused, with its agreement and a test portal contact; creates no tasks, fires no worker |
| `04_validate.sql` | after 02 / 03 | refuses (raises) if any active client has no agreement and is not explicitly excluded; prints every client's entitlements and this month's allocation |
| `05_resume_automation.sql` | after 04 passes | resumes exactly the jobs 01 paused |

Tested against the sandbox replay by `supabase/tests/sandbox/billing_cutover_kit.test.sql`
(01 → migrations already applied → a filled 02 → 03 → 04 → 05).
