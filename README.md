# Compass Client Platform

One place where every Compass client lives. Each client is enrolled in one or
more department pipelines (SEO, Website, Social, CRM, Paid Ads); when all
enrolled pipelines complete, the client rolls into the recurring monthly
Reporting cycle.

Internal agency tool for Compass Marketing Advisors — no client login in v1.
Full build spec: [`docs/spec.md`](docs/spec.md).

## Stack

- **Frontend:** Next.js (App Router), Tailwind v4, shadcn/ui
- **Backend:** Supabase (`compass-client-platform` project) — Postgres, Auth
  (team magic link), Storage, Edge Functions
- **Hosting:** Vercel

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in the anon key from the Supabase dashboard
npm run dev
```

Sign in with a team email (magic link).

## Database

`supabase/migrations/` holds the schema and template seeds, already applied to
the remote project. Key automations run in Postgres:

- Enrolling a client in a pipeline creates its `client_stages` and template tasks
- A stage marked complete/skipped completes the pipeline when nothing blocks
- All launch pipelines complete → client becomes `active` + Reporting enrollment
- `create_monthly_cycles()` — called by cron on the 1st (wired in Phase 2)

## Phase status

| Phase | Scope | Status |
|---|---|---|
| 1 | Schema, seeds, Clients, Overview / Plan / Documents / Pipelines tabs, Dashboard | ✅ built |
| 2 | Keywords, Locations, GSC + BrightLocal sync, City Index, Content/Social trackers, Reports | ⏳ |
| 3 | Stripe billing (port from Show Me CRM) | ⏳ |
| 4 | Board & Tasks views, Looker export, Meta publishing | ⏳ |
| 5 | Client portal (RLS policies + read-only views) | ⏳ |
