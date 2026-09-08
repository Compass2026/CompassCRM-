# Platform ↔ Pipeline Reconciliation

Compass Marketing Advisors · Making the CRM run the delivery playbooks

v1.0 · September 7, 2026 · Applies to CompassCRM- spec v0.2 and Client_Delivery_Pipeline v1.1


## The problem

Two specs, written two days apart, model the same work two different ways.

The platform spec (v0.2, Aug 31) organises by department: five parallel pipelines a client can be enrolled in, converging into monthly Reporting. It is the answer to "what did this client buy, and where are we on each part."

The delivery pipeline (v1.1, Sept 2) organises by sequence: seven playbooks where taxonomy gates brand and keywords, and those gate the build. It is the answer to "what does Claude do, in what order, and where does it stop."

Neither is wrong. The department view is what the Dashboard and Board should show. The playbook view is what the engine runs. The platform currently has the department view built and the playbook view absent — no taxonomy table, no brand board, onboarding buried as stage 2 of SEO, and a website stage that still says Next.js.

## Decisions

| **#** | **Decision** | **Reasoning** |
| --- | --- | --- |
| 1 | Keep department pipelines as the client-facing structure | Plans, billing, enrollment and the Dashboard already work this way. Nothing about the playbooks requires changing it. |
| 2 | Add a sixth pipeline, "Foundation," that every client is enrolled in automatically | Onboarding & Taxonomy, Brand Build and Keyword Research are not SEO work. They are the shared input every department reads. A Website-only client needs them as much as an SEO client. Putting them inside SEO was the structural mistake. |
| 3 | Foundation must complete before SEO or Website stages can start | This is the gate the delivery spec describes. Enforce it in the enrollment trigger, not in the UI. |
| 4 | Rewrite the SEO and Website stage templates to match Playbooks 4a and 4b | The current stages were written before the playbooks existed. Replace them. |
| 5 | Website stage builds on Astro | Per the stack policy in v1.1. The Next.js + Antigravity reference is stale. |
| 6 | Add the playbook data model as new tables; do not restructure existing ones | services, page_groups, money_keywords, alerts, change_log, decisions, placeholders, client_requests, industry_pulse, brand_boards. Additive migration. |
| 7 | Map autonomy levels onto the existing task owner enum | Run = CLAUDE. Run+Flag = CLAUDE with a flag column. Hold = CLAUDE_APPROVAL. No new enum. |
| 8 | Drive stays the file store; the platform models the folder structure | Add drive_folders to clients with the six standard subfolder URLs. The platform creates them on enrollment. |
| 9 | Brand board is structured fields plus a Drive doc, not a doc alone | The website build reads hex codes and typeface names from fields, not from prose. The Drive doc is exported from the fields. |
| 10 | Reporting pipeline absorbs Playbooks 5 and 6 | Monthly Refresh and Industry Pulse are the recurring cycle. The monthly_cycles table already exists; extend it. |

## Pipeline and stage templates — replacement seed

These replace the seed data in section 5 of the platform spec. Stages carry the playbook step they run and the autonomy level.

### Foundation (new — auto-enrolled for every client)

| **#** | **Stage** | **Playbook** | **Gate** |
| --- | --- | --- | --- |
| 1 | Onboarding & Service Taxonomy | PB1 | Taxonomy approved by Tom |
| 2 | Brand Build | PB2 | Brand board approved |
| 3 | Keyword Research | PB3 | Keyword map + tracked list approved |

Stages 2 and 3 run in parallel after stage 1. Foundation is complete when all three are. Nothing in SEO or Website starts until then.

### SEO (rewritten)

| **#** | **Stage** | **Playbook** | **Level** |
| --- | --- | --- | --- |
| 1 | Audit & Adjust | PB4a | Run / Run+Flag / Hold per step |
| 2 | GBP Setup & Optimisation | — | Run+Flag |
| 3 | Local Citations | — | Run |
| 4 | Backlink Foundation | — | Run+Flag |
| 5 | Tracking Setup (GSC, BrightLocal) | — | Run |

Audit was stage 1 and Onboarding stage 2 in the old seed. Both moved: Onboarding to Foundation, Audit now runs against the approved taxonomy and keyword map. Keyword Research moved to Foundation.

### Website (rewritten)

| **#** | **Stage** | **Playbook** | **Level** |
| --- | --- | --- | --- |
| 1 | Discovery — photos requested, existing-site inventory, stack confirmed | — | Hold (client-dependent) |
| 2 | Build to 70% | PB4b | Run through step 9; 10–11 Hold |
| 3 | Polish & client review — punch list, placeholders replaced | — | Run+Flag |
| 4 | Launch — DNS, redirects, GSC submitted | — | Hold |

Stage 2 reads the brand board and keyword map from Foundation. Stack is Astro. Remove the Next.js + Antigravity reference.

### Social, CRM, Paid Ads

Unchanged from v0.2. These have no playbooks yet. When they get them, they follow the same pattern: stages reference a playbook and a level.

### Reporting (extended)

| **#** | **Task** | **Playbook** |
| --- | --- | --- |
| 1 | Industry Pulse — one per vertical, before client refreshes | PB6 |
| 2 | Monthly Refresh & Report — per client | PB5 |
| 3 | GBP posts, backlinks, content, social counts | existing |
| 4 | Rank snapshot | existing |

## Schema additions

All additive. Existing tables are not restructured. Every new table carries client_id.

```
services                          -- the taxonomy. THE SPINE.
  id, client_id, name, segment, gbp_entry, page_url, page_type (service/hub),
  parent_service_id (nullable, for folded sections), primary_keyword_id,
  status (proposed/approved/retired), sort_order, created_at
```

```
keywords — ADD COLUMNS: service_id, city (nullable), intent, volume, cpc,
  competition, is_money (bool), is_tracked (bool), source, last_checked
```

```
page_groups
  id, client_id, name, page_type (home/service/city/hub/other), target_url,
  primary_keyword_id, supporting_keyword_ids (uuid[]), city_tier (1/2/fold),
  serp_notes, status
```

```
money_keywords
  id, keyword_id, confirmed_by, confirmed_on, alert_threshold_map (default 3),
  alert_threshold_organic (default 5)
```

```
alerts
  id, client_id, keyword_id, triggered_on, previous_rank, current_rank,
  source, acknowledged (bool), acknowledged_at
```

```
change_log
  id, client_id, change_type, object_type, object_id, before (jsonb),
  after (jsonb), reasoning, evidence, status (proposed/approved/vetoed),
  reviewed_by, reviewed_on, created_at
```

```
decisions
  id, client_id (nullable — some rules are global), task_id, decision,
  rule_text, decided_by, decided_on, match_count (for promotion after 3)
```

```
brand_boards
  id, client_id, version, status (draft/approved),
  palette (jsonb: [{role, hex, usage}]), typography (jsonb),
  positioning_line, standing_cta, hard_rules (text[]),
  drive_doc_url, approved_by, approved_on
```

```
claims                            -- sourced vs unverified tracking
  id, client_id, claim (text), status (sourced/unverified/confirmed),
  source, confirmed_by, confirmed_on
```

```
placeholders
  id, client_id, site_id, page, type (image/claim/fact/project),
  description, client_request_id (nullable), resolved (bool), resolved_at
```

```
client_requests
  id, client_id, items (jsonb), drafted_by_claude_at, sent_by_tom_at,
  responses (jsonb), status
```

```
sites
  id, client_id, url, stack (astro/nextjs/other), controlled_by_compass (bool),
  repo_url, vercel_project, staging_url, domain_constant, launched_at
```

```
industry_pulse
  id, vertical, period, rising_queries (jsonb), serp_changes (jsonb),
  competitor_moves (jsonb), news_items (jsonb), affected_client_ids (uuid[])
```

```
clients — ADD COLUMNS: vertical, business_type (storefront/service_area),
  drive_folders (jsonb: {onboarding, brand, keywords, website, reports, media})
```

```
tasks — ADD COLUMNS: playbook_step (text), autonomy_level (run/run_flag/hold),
  flagged_for_review (bool), recommendation (text), default_if_approved (text)
```

```
stages — ADD COLUMNS: playbook_ref (text), requires_foundation (bool)
```

## Autonomy mapping

| **Delivery spec** | **Platform task owner** | **Extra** |
| --- | --- | --- |
| Run | CLAUDE | autonomy_level = run. Logged only. |
| Run + Flag | CLAUDE | autonomy_level = run_flag, flagged_for_review = true. Surfaces in the morning brief under "done, review if you want". |
| Hold | CLAUDE_APPROVAL | autonomy_level = hold. Surfaces under "needs a decision" with recommendation and default_if_approved. |
| Tom does it | TOM | Unchanged. |
| Waiting on client | WAITING | Unchanged. Client requests create these. |

Promotion: when three decisions rows match on the same playbook_step with the same decision, Claude proposes changing that step’s autonomy_level. Tom approves in a brief. This is the mechanism by which the line gets faster.

## Automations to add

| **Trigger** | **Action** |
| --- | --- |
| Client created | Enroll in Foundation. Create Drive folder structure (01–05 + Media), store URLs in clients.drive_folders. Create the GitHub repo. Log the client in ~/Clients on the build machine. |
| Foundation stage 1 approved | Unlock stages 2 and 3. Create tasks from PB2 and PB3 templates. |
| Foundation complete | Unlock enrolled SEO and Website pipelines. Their stage 1 tasks are created now, not at enrollment. |
| Any task with autonomy_level = hold reaches its step | Create a CLAUDE_APPROVAL task with recommendation and default. Surface in the next brief. |
| Money keyword drops below threshold (BrightLocal sync) | Insert alerts row. Notify same day. |
| Three matching decisions on one step | Propose promotion. Create a Hold task for Tom. |
| Brand board approved | Export to Drive 02 Brand as a doc. Store URL. |
| Keyword map approved | Export to Drive 03 Keywords. Push tracked list to BrightLocal. |

## What this does NOT change

- Plans, billing, Stripe — untouched
- Contacts, access tracker, documents — untouched
- Content and social trackers — untouched
- Rank tracking, GSC sync, geo-grid, City Index — untouched, except the City Index bug (it averages all keywords, not P1) which should be fixed while in there
- Dashboard, Board, Tasks views — they gain a Foundation pipeline row and an autonomy filter; otherwise unchanged

## Build order

For Claude Code, in the CompassCRM- repo. Each step is a PR.

| **#** | **Work** | **Blocks** |
| --- | --- | --- |
| 1 | Migration: new tables, new columns. Additive only. | Everything below |
| 2 | Reseed pipelines and stages: add Foundation, rewrite SEO and Website, extend Reporting task templates. | 3, 4 |
| 3 | Enrollment trigger: auto-enroll Foundation, gate SEO/Website on Foundation completion. | 5 |
| 4 | Client-creation automation: Drive folders, GitHub repo. | — |
| 5 | Services tab on the client record: the taxonomy, editable, with approve action. | 6 |
| 6 | Brand board tab: fields plus Drive export. | — |
| 7 | Keywords tab: add service_id, is_money, is_tracked columns; money-keyword confirm action; export to Drive. | — |
| 8 | Tasks: autonomy_level filter, flagged_for_review view, decision recording on approve/veto. | 9 |
| 9 | Brief generator: 8:00 and 5:30 views reading held and flagged tasks. | — |
| 10 | Fix City Index to average P1 only. Verify BrightLocal key is the subscription key. | — |

## Seed Shewmaker as the first client through the new model

The reference run already exists in docs. Seed it into the platform as the proof:

- clients row: Shewmaker Brothers Masonry, service_area business, vertical = masonry, drive_folders from the existing Drive structure
- services: the 19 approved services with segments, page URLs and primary keywords from the keyword map
- keywords: every term in the demand table with volume, CPC, competition, is_money for the eight nominated
- page_groups: the 34-page sitemap with city tiers
- brand_boards: palette hex values, Rokkitt / Merriweather Sans, positioning line, standing CTA, hard rules
- claims: every SOURCED and UNVERIFIED line from the brand board
- sites: the Astro repo, Vercel project, staging URL
- placeholders: from docs/placeholders.md in the site repo
- Foundation: all three stages complete. Website: stage 2 in progress.

If Shewmaker seeds cleanly, the model holds. If a field has nowhere to go, the schema is wrong and this doc gets a v1.1.
