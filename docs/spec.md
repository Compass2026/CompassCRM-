# Compass Client Platform — Build Spec v0.2

**Owner:** Tom Dombrowski, Compass Marketing Advisors
**Date:** 2026-08-31 (v0.2 — added rank/location tracking and Stripe billing to v1)
**Status:** Draft for review → then schema build
**Builder:** Claude Code + Supabase, same workflow as the other Compass OS apps
**Scope:** Internal agency tool. No client login in v1. Client portal is a later phase and the schema is designed so it can be added without rework.

---

## 1. Purpose

One place where every Compass client lives. Each client is enrolled in one or more **department pipelines** (SEO, Website, Social, CRM, Paid Ads) based on their plan. Pipelines run in parallel. When all enrolled pipelines complete, the client rolls into the single **Reporting** pipeline — the recurring monthly cycle that never ends.

Every stage carries the Compass process spec: tasks, owner, deadline, deliverable, completion evidence, next action.

## 2. Non-goals (v1)

- No client-facing login or portal
- No replacement for Google Drive as the file store — Drive stays the source of truth for client deliverables; the app links to it and stores only contracts/uploads in Supabase Storage
- No in-app SERP scraping — rank data comes from BrightLocal (see §6.5a); CSV import remains as a fallback

## 3. Stack

- **Frontend:** Next.js (App Router), Tailwind, shadcn/ui — same pattern as the Show Me Electrical CRM
- **Backend:** Supabase — **new project** (do not share the Show Me project); Postgres, Auth (team only, magic link or Google), Storage (contracts/uploads), Edge Functions (Stripe webhooks, BrightLocal sync), Row Level Security ready for portal phase
- **Billing:** Stripe (Compass account) — mirror the Show Me Electrical CRM billing implementation
- **Rank data:** Google Search Console API (organic clicks/impressions/position per query + page, sitewide) + BrightLocal API (Local Rank Tracker + Local Search Grid + Live Search Ranking for per-city and grid)
- **Social publishing:** none in v1 (posts logged in-app); Meta Graph API publishing planned for a later phase
- **Hosting:** Vercel; DNS via Cloudflare
- **Repo:** GitHub, `compass-client-platform`
- **Build tooling:** Claude Code (primary) with Supabase MCP; Antigravity for UI passes

## 4. Core concepts

| Term | Meaning |
|---|---|
| **Client** | A business Compass serves. Has a plan, contacts, documents, and enrolled pipelines. |
| **Pipeline** | A department's ordered set of stages (template). Five launch pipelines + one Reporting pipeline. |
| **Enrollment** | A client is enrolled in a pipeline. Creates one `client_stage` row per stage in that pipeline. |
| **Stage** | A bubble. Has tasks, an owner, evidence, and a status. |
| **Task** | Checklist item under a stage or a monthly cycle. Carries the owner designation (TOM / CLAUDE / CLAUDE+APPROVAL / DELEGATED / WAITING). |
| **Monthly cycle** | One row per client per month once in Reporting. Groups recurring tasks, rank snapshot, and the monthly report. |

**Convergence rule:** when every enrolled launch pipeline has its final stage marked `complete`, the client's status flips to `active` and a Reporting enrollment is created automatically. The first monthly cycle is created on the next 1st of the month.

## 5. Pipelines & stages (seed data)

Stages marked *(opt)* are optional per client and can be skipped without blocking convergence.

### 5.1 SEO
1. Audit — on-page / technical / off-page (deliverable: audit report from Compass SEO skills)
2. Onboarding — access (GSC, GA4, GBP, hosting), domain portfolio check, brand assets, NAP confirmed
3. Keyword Research & Targeting — target keyword set entered in Keywords tab
4. Local Citations — citation build list + completion sheet
5. GBP Setup & Optimization
6. Backlink Foundation
7. Tracking & Reporting Setup — GSC/GA4/Looker Studio connected

### 5.2 Website
1. Discovery — sitemap, page inventory, content sources, photos requested
2. Build — Next.js + Antigravity, GitHub repo created
3. SEO QA — on-page/technical skills run, Rich Results Test passed, schema components in place
4. Launch — DNS cutover, redirects verified, GSC submitted

### 5.3 Social Media
1. Audit — existing profiles, handles, posting history
2. Brand & Content Setup — voice, pillars, templates (Canva), Metricool connected
3. Content Calendar — first 30 days planned in Social tab
4. First Month Live

### 5.4 CRM
1. Requirements — pipelines, fields, automations, comms needs
2. Build
3. Data Migration *(opt)*
4. Training
5. Live

### 5.5 Paid Ads
1. Account Audit — existing ad accounts, historical spend, pixel/tag state
2. Tracking Setup — conversions, GA4, Meta pixel/CAPI
3. Campaign Build
4. Launch
5. Optimization Handoff → Reporting

### 5.6 Reporting (recurring — created automatically on convergence)
Monthly cycle tasks (template, filtered by which departments the client has):
- GBP posts (count per plan)
- New backlinks
- Blog content published (from Content tab)
- Social posts published (from Social tab)
- Paid ads optimization + spend review
- Rank snapshot recorded
- Monthly report generated → saved to Drive → link stored in Reports tab

## 6. Client section — screens

Route: `/clients/[clientId]` with tabs.

### 6.1 Overview
- Business name, DBA, industry/vertical, website, phone, address (NAP), service area
- Primary contact(s): name, role, email, phone
- Access tracker: GSC, GA4, GBP, hosting/DNS, ad accounts, social accounts — each with status (not needed / requested / granted) and notes. **No passwords stored.**
- Key dates: signed, kickoff, launched, renewal
- Status badge: `launching` / `active` / `paused` / `offboarded`

### 6.2 Plan
- Package name, monthly fee, term, start date, renewal date
- Enrolled pipelines (checkboxes → drive enrollment)
- Plan-specific parameters: GBP posts/month, blog posts/month, social posts/month, ad budget managed
- Plan notes (free text)

### 6.2b Brand
The client's brand board — the visual reference for the team and the
structured "brain" AI reads before generating any content for the client.
- Board view (top of tab, also at `/clients/[clientId]/brand-board` as a
  print-ready page): logo on white / primary / dark, color palette swatches,
  typography samples (Google fonts render live), positioning & voice,
  content pillars, words we use / avoid, imagery style, AI guidance, logo
  variations, reference gallery.
- Identity fields (`client_brands`): tagline, positioning, story, audience,
  differentiators, voice & tone, content pillars, words we use / avoid,
  imagery style, typography notes, AI guidance.
- Colors (`brand_colors`): name, hex, role (primary / secondary / accent /
  neutral / background / text / other), usage.
- Fonts (`brand_fonts`): family, role (heading / body / accent / other),
  source, URL, weights, notes.
- Assets (`brand_assets`): logos (primary / alternate / icon / wordmark),
  photos, website screenshots, social posts, ads, print, patterns, video,
  links. Files upload straight from the browser to the private
  `brand-assets` bucket (multi-file drag & drop); links point at external
  material (Instagram post, Canva design, Drive file).
- **Scan website**: pulls colors, fonts, logo, favicon and share image from
  `clients.website_url` and adds them tagged "found on website" for review.
- **Approve** stamps `approved_at` / `approved_by` and closes the client's
  "Build brand board" task; **Reopen** reverses both.
- **Publish snapshot to Documents** renders a self-contained HTML brand board
  (images inlined) into the `documents` bucket as a `brand` document.
- `get_brand_profile(client_id)` returns the whole brand as one JSON document
  for AI consumers (Claude via the Supabase MCP, Edge Functions).

### 6.3 Documents
Two sections in one view:
- **Drive links** — client root folder plus pinned links (proposal, brand guide, audit report, report folder). Fields: label, URL, category.
- **Uploaded files** — Supabase Storage. Contracts, signed proposals, W-9s, brand assets. Fields: filename, category, uploaded by, uploaded at, notes.

### 6.4 Pipelines
- Bubble view: one row per enrolled pipeline, stages as bubbles (`not started` / `in progress` / `blocked` / `skipped` / `complete`)
- Tap a bubble → stage drawer: tasks with owner + due date, deliverable links, evidence field, next action, notes
- Convergence indicator: "X of Y pipelines complete → Reporting"

### 6.5 Keywords
- Table: keyword, target URL, priority (P1/P2/P3), pipeline/department, GSC avg position / clicks / impressions (last 28 days), best local position, avg position across tracked locations, change vs last month
- Keyword detail: GSC trend + per-location rank table + trend line from `rank_snapshots`
- **GSC sync:** client's property connected via Google OAuth (Compass Workspace account has access); Edge Function pulls query + page data monthly and on demand into `gsc_snapshots`; "discovered queries" list surfaces GSC queries not yet in the keyword set
- Import: CSV upload (keyword, location, position, date) as fallback

### 6.5a Rank & Location Tracker (v1)
Two tracking modes, both sourced from BrightLocal, both run **monthly by default** (with the report) and **on demand** from a "Run now" button.

**Locations** — each client has a list of tracked locations (cities / service areas). For multi-location clients, each physical location is also a tracked location with its GBP attached.

**Mode A — Per-city rank tracking (BrightLocal Local Rank Tracker)**
- Every active keyword × every tracked location = one rank check
- Tracks **organic** and **Map Pack / Local Finder** positions separately
- Stored as `rank_snapshots` rows with `location_id`
- Views: keyword × city matrix (heat-colored), city detail (all keywords for that city), trend per keyword-city pair
- **City Index:** per location, a single score = average of best positions across P1 keywords (organic and map pack shown separately), so each city can be compared and trended month over month

**Mode B — Geo-grid (BrightLocal Local Search Grid)**
- Per physical location: grid config (center lat/lng, grid size e.g. 7×7, spacing), keyword set
- Each run stores one `grid_snapshots` row per keyword with the per-point positions as JSON plus BrightLocal's average map rank and share-of-voice
- View: color-coded grid rendered in-app (green 1–3 / orange 4–10 / red 10+), before/after slider, competitor list from the report
- **Grid defaults (editable per location, seeded in Settings):**

| Client type | Grid | Spacing |
|---|---|---|
| City-based contractor / retail (dense metro) | 7×7 | 1 mile |
| Suburban service business | 7×7 | 2 miles |
| Rural / wide service area (e.g. equipment rental, solar) | 9×9 | 3–5 miles |
| Single storefront (design studio, showroom) | 5×5 | 1 mile |

Grid results also roll into the location's City Index

**On-demand checks** use BrightLocal's Live Search Ranking API (pay-per-request) so a one-off check doesn't require editing the scheduled report.

**Sync flow:** Supabase Edge Function on cron (1st of month) → trigger BrightLocal report runs → poll for completion → fetch results → write snapshots → update keyword/location rollups → attach summary to the monthly cycle. Manual "Run now" calls the same function.

**Build note:** confirm during setup whether Local Search Grid point-level data is available via the API on Compass's BrightLocal plan; if not, Mode B falls back to storing the report link + average map rank and rendering the grid from a CSV export.

### 6.5b Billing (v1 — Stripe)
Port the billing module from the Show Me Electrical CRM (repo already available in Claude Code). **Subscription model only** — no one-off invoicing in v1.

Goal: the app reports whether each client's subscription is **paid** for the current period. All payments flow through Stripe — card or Stripe ACH debit (`us_bank_account`) — so paid status is fully webhook-driven. No manual payment entry in v1 (schema keeps `source = manual` available for later).

- Per client: Stripe customer ID, subscription (plan price, status, current period), payment method type (card / us_bank_account)
- **Paid status logic:** `paid` when `invoice.paid` lands for the current period; `open` until due date; `past_due` after due date without payment. ACH debits can take several days to settle — show `processing` between `invoice.payment_action_required`/`payment_intent.processing` and `invoice.paid`.
- Views: subscription card (plan, amount, period, paid / processing / open / past due badge), payment history, lifetime paid
- Actions: create Stripe customer + subscription from the Plan tab; pause / resume; open in Stripe
- Stripe webhooks (Edge Function): `invoice.paid`, `invoice.payment_failed`, `payment_intent.processing`, `customer.subscription.updated/deleted` → upsert `subscriptions` / `payments`, recompute paid status
- Past due → badge on client card + Dashboard "needs attention"
- Compass Stripe account only

### 6.6 Content
- Blog tracker: title/topic, target keyword (linked), status (`idea` → `brief` → `draft` → `review` → `published`), owner, due date, URL, published date, word count
- Filter by status; monthly count feeds the Reporting cycle

### 6.7 Social
- Post tracker (log-only in v1): platform, copy, asset (Drive/Canva link or upload), scheduled date/time, status (`idea` → `drafted` → `approved` → `scheduled` → `published`), published URL, notes
- Posts are scheduled/published in the native platforms or a scheduler of choice; the app records them
- Calendar view (month) + list view; per-client posts-per-month counter against the Plan
- In-app publishing (Meta Graph API first) is a later phase — schema already includes `social_accounts` so it can be added without rework

### 6.8 Reports
- One card per monthly cycle: month, report Drive link, rank summary, tasks completed, notes
- Generated report is a Drive file; app stores the link

## 7. Global screens

- **Dashboard** `/` — all clients as cards with status + pipeline progress; "needs attention" list (blocked stages, overdue tasks, tasks awaiting approval)
- **Board** `/board` — Kanban-style view across all clients for one pipeline at a time (like the Show Me CRM bubbles, but rows = clients)
- **Tasks** `/tasks` — all tasks filtered by owner (TOM / CLAUDE / CLAUDE+APPROVAL / DELEGATED / WAITING), due date, client
- **Settings** `/settings` — pipeline & stage templates, task templates, packages, team members

## 8. Data model (Postgres / Supabase)

```
clients
  id, name, dba, industry, website_url, phone, address_line1, city, state, zip,
  service_area, status (enum), signed_at, kickoff_at, launched_at, renewal_at,
  drive_root_url, notes, created_at, updated_at

client_contacts
  id, client_id, name, role, email, phone, is_primary

client_access
  id, client_id, system (enum: gsc, ga4, gbp, hosting, dns, meta_ads, google_ads,
  facebook, instagram, linkedin, tiktok, crm, other), status (not_needed/requested/granted),
  notes, updated_at

plans
  id, client_id, package_name, monthly_fee, term_months, start_date, renewal_date,
  gbp_posts_per_month, blog_posts_per_month, social_posts_per_month,
  ad_budget_managed, notes

pipelines                         -- templates
  id, key (seo/website/social/crm/paid_ads/reporting), name, sort_order,
  is_recurring (bool)

stages                            -- templates
  id, pipeline_id, name, sort_order, is_optional (bool), description,
  default_owner (enum)

task_templates
  id, stage_id (nullable), pipeline_id (nullable, for recurring), title,
  default_owner, sort_order

client_pipelines                  -- enrollment
  id, client_id, pipeline_id, enrolled_at, completed_at, status

client_stages
  id, client_pipeline_id, stage_id, status (not_started/in_progress/blocked/
  skipped/complete), owner, due_date, started_at, completed_at,
  evidence, next_action, notes

tasks
  id, client_id, client_stage_id (nullable), monthly_cycle_id (nullable),
  title, owner (enum: TOM/CLAUDE/CLAUDE_APPROVAL/DELEGATED/WAITING),
  status (open/in_progress/blocked/done), due_date, completed_at, notes

deliverables
  id, client_id, client_stage_id (nullable), monthly_cycle_id (nullable),
  label, url, type (drive/site/sheet/report/other)

documents
  id, client_id, kind (drive_link/upload), label, category
  (contract/proposal/brand/audit/report/other), url (drive links),
  storage_path (uploads), file_name, mime_type, uploaded_by, created_at, notes

client_brands                     -- one per client, created with the client
  client_id (pk), tagline, positioning, story, audience, differentiators,
  voice_tone, content_pillars text[], words_we_use text[],
  words_we_avoid text[], imagery_style, typography_notes, ai_guidance,
  approved_at, approved_by, created_at, updated_at

brand_colors
  id, client_id, name, hex (#rrggbb), role (primary/secondary/accent/
  neutral/background/text/other), usage, sort_order

brand_fonts
  id, client_id, family, role (heading/body/accent/other), source, url,
  weights, notes, sort_order

brand_assets                      -- brand-assets bucket (private) or external url
  id, client_id, kind (logo_primary/logo_alt/logo_icon/wordmark/photo/
  website_screenshot/social_post/ad/print/pattern/video/other),
  label, source (upload/link/website_scan), storage_path, url, file_name,
  mime_type, size_bytes, width, height, is_primary, notes, sort_order,
  uploaded_by, created_at

keywords
  id, client_id, keyword, target_url, priority (p1/p2/p3),
  department (seo/website/social/paid_ads), is_active, created_at

locations                         -- tracked cities / physical locations
  id, client_id, name, city, state, lat, lng, is_physical_location (bool),
  gbp_place_id, brightlocal_location_id, brightlocal_lrt_report_id,
  is_active, sort_order

rank_snapshots                    -- Mode A: per keyword per location
  id, keyword_id, location_id, result_type (organic/map_pack),
  position (nullable = not in top 100), url_ranked, recorded_at,
  source (brightlocal_report/brightlocal_live/csv/manual), run_id

grid_configs                      -- Mode B: per physical location
  id, location_id, brightlocal_lsg_report_id, grid_size (e.g. 7),
  spacing_miles, center_lat, center_lng, keyword_ids (uuid[]), is_active

grid_snapshots
  id, grid_config_id, keyword_id, recorded_at, avg_map_rank,
  share_of_voice, points (jsonb: [{lat,lng,position}]),
  competitors (jsonb), report_url, run_id

rank_runs                         -- one per sync/on-demand execution
  id, client_id, triggered_by (cron/manual), started_at, completed_at,
  status, checks_count, error

location_index                    -- City Index rollup, one per location per month
  id, location_id, period, organic_index, map_index, keywords_counted,
  computed_at

stripe_customers
  id, client_id, stripe_customer_id, payment_method_type
  (card/us_bank_account/external_ach), last4, created_at

subscriptions
  id, client_id, stripe_subscription_id (nullable for external-ACH clients),
  stripe_price_id, amount, interval (month), status,
  current_period_start, current_period_end, paid_status
  (paid/open/past_due), cancel_at, created_at

payments
  id, client_id, subscription_id, source (stripe/manual),
  stripe_invoice_id, stripe_payment_intent_id, amount, method
  (card/stripe_ach/external_ach/check), period_start, period_end,
  reference, paid_at, recorded_by, notes

content_posts
  id, client_id, keyword_id (nullable), title, status (idea/brief/draft/review/
  published), owner, due_date, url, published_at, word_count, notes

gsc_snapshots                     -- Search Console, per query per page
  id, client_id, keyword_id (nullable, matched by query text), query, page,
  clicks, impressions, ctr, avg_position, period_start, period_end,
  recorded_at

social_accounts                   -- connected publishing accounts per client
  id, client_id, platform (facebook/instagram/linkedin/x/tiktok),
  external_account_id, display_name, access_token (encrypted),
  token_expires_at, status (connected/expired/manual_only), connected_at

social_posts
  id, client_id, social_account_id (nullable), platform (enum), copy,
  asset_url, storage_path, scheduled_at, status (idea/drafted/approved/
  scheduled/published/failed), published_url, external_post_id,
  error, notes

monthly_cycles
  id, client_id, period (date, first of month), status (open/complete),
  report_url, rank_summary (jsonb), notes, completed_at

team_members
  id, auth_user_id, name, email, role (admin/member)
```

**Notes**
- All tables carry `client_id` (directly or via join) so RLS for a future client portal is a policy addition, not a schema change.
- `owner` enums mirror the Compass GTD app so tasks can sync both ways later.
- Enrollment trigger: inserting a `client_pipelines` row creates `client_stages` for every stage in that pipeline and `tasks` from `task_templates`.
- Convergence trigger: when all non-recurring `client_pipelines` for a client are `complete`, set `clients.status = active` and insert a Reporting enrollment.
- Monthly trigger (cron): on the 1st, for every active client, insert a `monthly_cycles` row and its tasks from Reporting `task_templates`, filtered by the client's enrolled departments.

## 9. Automations (v1)

| Trigger | Action |
|---|---|
| Client created | Create empty `client_brands` row + "Build brand board" task (owner CLAUDE+APPROVAL, `tasks.key = brand_board`) |
| Client enrolled in pipeline | Create stages + tasks from templates; attach the open brand-board task to the Onboarding stage when the pipeline has one (SEO) |
| Brand board approved | Stamp `approved_at` / `approved_by`, close the brand-board task |
| Stage marked complete | Set `next_action` prompt; if final stage, mark pipeline complete |
| All launch pipelines complete | Status → active; enroll in Reporting |
| 1st of month | Create monthly cycle + recurring tasks for each active client |
| Content post → published | Increment monthly cycle blog count |
| Social post → published | Increment monthly cycle social count |
| 1st of month (after cycle created) | Trigger BrightLocal report runs for every active client → write snapshots → compute `location_index` → attach summary to cycle |
| "Run now" pressed | Same sync function for one client, via Live Search Ranking API |
| Rank CSV uploaded | Insert `rank_snapshots`, recompute rollups |
| Stripe webhook (invoice.*, payment_intent.*, customer.subscription.*) | Upsert `invoices` / `payments` / `subscriptions`; past_due → flag client |
| 1st of month | Pull GSC query/page data for each connected client → `gsc_snapshots` → match to keywords |
| Stripe webhook (invoice.paid / payment_failed, payment_intent.processing, subscription.*) | Upsert `subscriptions` / `payments`; recompute `paid_status` |
| Daily | Any subscription past `current_period_end` + grace days without `invoice.paid` → `past_due`, flag client |
| Plan saved with subscription enabled | Create Stripe customer + subscription |

## 10. Phase plan

**Phase 1 — Foundation**
Schema + seed pipelines/stages/task templates; Clients list; Overview, Plan, Documents tabs; Pipelines tab with bubble view + stage drawer; Dashboard.

**Phase 2 — Trackers**
Keywords; Locations; GSC sync; BrightLocal sync (Mode A + Mode B) with CSV fallback; City Index; Content tracker; Social tracker (log-only); Reports tab; monthly cycle automation.

**Phase 3 — Billing**
Stripe customer + subscription, webhook writes (card + Stripe ACH), paid / processing / past-due status — ported from the Show Me CRM.

**Phase 4 — Views & publishing**
Board view; Tasks view by owner; Looker Studio export; in-app social publishing via Meta Graph API. (Tasks stay separate from the Compass GTD app — decided Aug 2026.)

**Phase 5 — Client portal**
Client auth, RLS policies, read-only views of Pipelines / Documents / Reports / Billing / approvals.

## 11. Seed clients

Six active clients (Aug 2026), seeded at setup:

| # | Client | Website | Enrolled pipelines | Tracked cities |
|---|---|---|---|---|
| 1 | Show Me Electrical | showmeelectrical.com | TBD | St. Louis metro (TBD) |
| 2 | Lucas Construction | TBD | TBD (Website active — lighting division) | TBD |
| 3 | Show Me Design | TBD | TBD | TBD |
| 4 | Ginger Huff Interiors | TBD | TBD | TBD |
| 5 | Pensacola Equipment Rentals | TBD | TBD | Pensacola, FL area (TBD) |
| 6 | Logic Solar | logic-solar.com | SEO (on-page audit complete Aug 2026) + TBD | TBD |

Fill in pipelines and cities during Phase 1 seeding.

## 12. Decisions (Aug 31, 2026)

- Separate app, Compass agency-only; Found It Marketing not included
- Internal login only in v1; client portal is Phase 5
- Rank data: Google Search Console **and** BrightLocal (per-city + geo-grid), organic + Map Pack, monthly by default with on-demand runs
- Grid defaults by client type as in §6.5a
- Social: log-only in v1; in-app publishing (Meta first) is Phase 4
- Tasks stay separate from the Compass GTD app
- Billing: subscription model only; all payments (card and ACH) through Stripe, paid status webhook-driven; ported from the Show Me Electrical CRM (repo available in Claude Code); Compass Stripe account only
- Builder: Claude Code + new Supabase project

## 13. Open questions

1. **Seed detail** — for each of the six clients: (a) enrolled pipelines (SEO / Website / Social / CRM / Paid Ads) and (b) tracked cities for rank checks. Can be entered during Phase 1 seeding.

## 14. Confirmed / notes

- BrightLocal: API access confirmed for the Compass subscription (Aug 31, 2026); pull location and grid-report limits from the plan page during Phase 2 setup
- Show Me CRM repo is already available to Claude Code locally; billing port needs no extra input
- Meta: the Ads MCP uses Meta's hosted app, so social publishing (Phase 4) will need its own Compass Marketing Business app with Pages / Instagram publishing permissions — create it then, not now
