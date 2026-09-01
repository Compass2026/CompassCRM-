<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Compass Client Platform

Internal Compass Marketing Advisors agency tool — every client, their department
pipelines (SEO / Website / Social / CRM / Paid Ads), and the recurring monthly
Reporting cycle. Full build spec: `docs/spec.md`.

- **Stack:** Next.js (App Router) + Tailwind v4 + shadcn/ui (Base UI — triggers
  use `render`, not `asChild`), Supabase (project `compass-client-platform`,
  ref `iokcopiyzajigvhwexhe`), deployed on Vercel (project `compass-crm`) at
  https://compass-crm-ten.vercel.app.
- **Schema:** `supabase/migrations/` mirrors what is applied to the remote
  project via the Supabase MCP. Enrollment / convergence / monthly-cycle
  automations live in Postgres triggers and functions — see
  `0001_initial_schema.sql`.
- **Auth:** internal team only. Password sign-in is the primary path with a
  magic-link fallback (`src/app/login/page.tsx`); the built-in Supabase mailer
  rate-limits aggressively, so custom SMTP via Resend is the intended fix.
  RLS is enabled everywhere with a blanket authenticated policy; the Phase 5
  client portal only adds client-scoped policies.
- **Secrets** live in Supabase Vault, never in the repo, and are read by Edge
  Functions through the service-role-only `get_secret()` function:
  `BRIGHTLOCAL_API_KEY`, `GSC_CLIENT_ID` / `GSC_CLIENT_SECRET` /
  `GSC_REFRESH_TOKEN`, `SYNC_CRON_SECRET`, `SUPABASE_ANON_KEY`.

## Phases

1. **Foundation — done.** Clients list, Overview / Plan / Brand / Documents /
   Pipelines tabs, Dashboard, Tasks by owner, Settings.
2. **Trackers — done.** Keywords, locations (with a "cities within N miles"
   suggester backed by a bundled GeoNames dataset, `src/data/us-cities.json`),
   geo-grid configs with a radius helper, rank matrix + City Index, BrightLocal
   sync, GSC sync, Content tracker, Social tracker + calendar, Reports tab,
   monthly cycle automation.
3. **Billing — next.** Stripe subscriptions ported from the Show Me Electrical
   CRM. Subscription model only; paid status is webhook-driven. See
   `docs/spec.md` §6.5b and §9.
4. Views & publishing (Board, Tasks, Looker export, Meta publishing).
5. Client portal (RLS policies + read-only views).

## Sync architecture (Phase 2)

Two Edge Functions in `supabase/functions/`, both authorized by either a
signed-in team member's JWT or the `x-cron-secret` header, both responding 202
and finishing in the background via `EdgeRuntime.waitUntil`:

- **`brightlocal-sync`** — read-only ingestion of Local Rank Tracker results
  (best organic + map-pack position per keyword) and Local Search Grid runs
  (per-point ranks, avg map rank). It never triggers billable report runs;
  BrightLocal's own weekly schedule produces the data. REST base is
  `https://api.brightlocal.com/manage/v1` with an `x-api-key` header — note
  the older `tools.brightlocal.com/seo-tools/api` endpoints are deprecated and
  reject new keys. Runs monthly via pg_cron (1st, 07:00 UTC).
- **`gsc-sync`** — refreshes a Google OAuth token for the Compass Workspace
  account, auto-matches each client's Search Console property from
  `clients.website_url` (`sc-domain:` or URL-prefix, stored on
  `clients.gsc_property`, overridable), and pulls the last 28 complete days of
  query+page performance. Runs monthly via pg_cron (1st, 07:30 UTC).

Both are idempotent: natural-key unique indexes on `rank_snapshots`,
`grid_snapshots`, and `gsc_snapshots` make re-ingestion a no-op.

## Brand board (spec §6.2b)

Every client has a brand board on the **Brand** tab — the team's visual
reference and the structured "brain" AI reads before writing anything for the
client. Migration `0009_brand_board.sql`.

- **Data:** `client_brands` (1:1 with clients — tagline, positioning, story,
  audience, differentiators, voice & tone, content pillars, words we use /
  avoid, imagery style, typography notes, AI guidance, approval stamp),
  `brand_colors`, `brand_fonts`, `brand_assets`. Files live in the private
  `brand-assets` bucket; the browser uploads straight to Storage
  (`src/components/brand-asset-uploader.tsx`) and a server action records the
  row, so uploads aren't bound by the server-action body limit.
- **AI access:** `select get_brand_profile('<client uuid>')` returns the whole
  brand as one JSON document (client basics, identity fields, colors, fonts,
  assets with bucket + storage path). Any Claude session with the Supabase
  connector should call this before generating content for a client; sign
  `storage_path`s against `brand-assets` to fetch the images.
- **Process hook:** creating a client inserts the empty brand row and a
  "Build brand board" task (owner CLAUDE+APPROVAL, `tasks.key = 'brand_board'`).
  Enrolling in SEO attaches that task to the Onboarding stage. Claude drafts
  the board (website scan + intake), Tom approves on the tab, which closes the
  task.
- **Website scan** (`scanWebsiteAction` in `src/app/brand-actions.ts`) pulls
  colors, fonts, logo, favicon and og:image from `clients.website_url` as a
  starting point — heuristic, always review the result. The same scan runs
  server-side as the `brand-scan` Edge Function (service role; authorized by
  a team JWT or `x-cron-secret`), so Claude can seed boards without a browser
  session: `select net.http_post('.../functions/v1/brand-scan', headers with
  get_secret('SUPABASE_ANON_KEY') + get_secret('SYNC_CRON_SECRET'),
  body '{"client_id": "..."}')` and read the result from `net._http_response`.
  WordPress sites leak the Gutenberg default palette (#ff6900, #cf2e2e,
  #fcb900, #0693e3, #9b51e0) — delete those and assign roles by hand.
  For sites the scan can't read (JavaScript-rendered, logos only on inner
  pages) the same function has an **import mode**: body
  `{"client_id": "...", "import": [{"url", "kind", "label", "notes",
  "is_primary"}], "remove": ["<asset id>"]}` files specific images (by URL
  or `data_base64` + `mime_type`) into the bucket and `brand_assets`.
- **Outputs:** `/clients/[id]/brand-board` is a print-ready page (Save as
  PDF); "Publish snapshot to Documents" writes a self-contained HTML board into
  the `documents` bucket as a `brand` document. Filing a copy in
  Compass Clients / <Client> on Drive is done by Claude via the Drive
  connector — the app itself has no Google credentials.

## Known state / open items (as of Aug 31 2026)

- **BrightLocal key is a trial** — 1,000 lifetime requests, ~50 per monthly
  sync. Get a production key before that runs out.
- **Keyword priorities are unset.** The City Index is specified as the average
  of P1 keywords but currently falls back to *all* active keywords because no
  P1s exist yet. Setting priorities in the Keywords tab makes it behave per spec.
- **GSC coverage is partial.** Logic Solar, Lucas Construction, Ginger Huff and
  Show Me Design sync. Show Me Electrical's property exists but Google has no
  data for it at all (likely created recently — GSC does not backfill).
  Pensacola Equipment Rentals has no Search Console property; one needs to be
  created and verified.
- **Brand boards are drafted, not approved** (Sep 1 2026) — website scan +
  intake done for the five clients with websites (palette roles assigned, logos
  from the site, identity/voice/AI-guidance fields written from site copy).
  Pensacola has a placeholder only (no website, no material). Each client's
  "Build brand board" task stays open until Tom approves on the Brand tab.
  Draft boards are filed in Drive under Compass Clients / <Client>.
- **Client seed data is partial** — several clients still need enrolled
  pipelines, plan details, and contacts filled in. Pensacola also has no
  `website_url`.
