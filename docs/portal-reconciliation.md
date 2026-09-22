# Portal reconciliation (Sept 22 2026)

Migrations 0036–0038 were applied to the Supabase project (`iokcopiyzajigvhwexhe`)
on Sept 15 and 17 from two unmerged branches, `claude/portal-step0-team-rls` and
`claude/portal-step1-client-logins`. The Edge Functions they pair with were
deployed at the same time. `main` carried none of it, and 0039 (on `main`)
already depends on 0036's `is_team()`. This branch brings the repository back in
line with what is running. **Nothing was applied, deployed or changed in the
project to produce it.**

## What the branch contains

| Commit | What |
| --- | --- |
| Merge of step 1 (contains step 0) | 0036, 0037, 0038; team-only checks in eight Edge Functions; `portal-invite`; `/portal` routes; the Overview tab's Client portal card; `/auth/signout`; `shouldCreateUser: false` on magic links. `site-push/index.ts` conflict resolved to **main's** version (see below). |
| Deployed-byte alignment | `rank-sync` and `portal-invite` differed from the deployed source only in comment-divider width; the repo now holds the deployed bytes. |
| Types | `src/lib/database.types.ts` regenerated from the live schema. |
| Routing fix | A client contact who signs in at `/login` goes to `/portal` instead of being signed out. |
| Sandbox | `scripts/test-portal-sandbox.sh` + `supabase/tests/sandbox/` — replays every migration into a local Postgres shaped like the project and runs 298 access checks. |
| This document | |

## Migration files and Supabase's recorded versions

Supabase records a migration applied through the MCP / Management API under a
**version** (the UTC timestamp at apply time, `YYYYMMDDHHMMSS`) and a **name**
(whatever the caller passed). The repository orders files by a four-digit
prefix. The two are matched by name, not by position: names were passed
without the prefix up to 0021 and for 0032–0035, and with it from 0022–0031
and from 0036 on. The project has **41** recorded migrations and the
repository **40** files — `gsc_snapshots_plain_key` has no file (below).

"Content" compares the recorded SQL (`supabase_migrations.schema_migrations
.statements`) with the file: *identical* = same md5 once the file's trailing
newline is dropped; *comments only* = same md5 after removing `--` comments
and all whitespace from both sides (calibrated on the identical ones); the
executable SQL is the same, only comment text differs.

| Version | Recorded name | Repository file | Content |
| --- | --- | --- | --- |
| 20260831132035 | initial_schema | 0001_initial_schema.sql | identical |
| 20260831132200 | seed_templates | 0002_seed_templates.sql | identical |
| 20260831133254 | function_hardening | 0003_function_hardening.sql | identical |
| 20260831145225 | monthly_cycle_cron | 0004_monthly_cycle_cron.sql | identical |
| 20260831152053 | brightlocal_sync_plumbing | 0005_brightlocal_sync_plumbing.sql | identical |
| 20260831153045 | snapshot_dedupe | 0006_snapshot_dedupe.sql | identical |
| 20260831154138 | gsc_sync | 0007_gsc_sync.sql | identical |
| 20260831154225 | gsc_snapshots_plain_key | — | **no file** |
| 20260831174123 | stripe_billing | 0008_stripe_billing.sql | identical |
| 20260901215256 | brand_board | 0009_brand_board.sql | comments only |
| 20260908000140 | playbook_schema | 0010_playbook_schema.sql | identical |
| 20260908003915 | reseed_playbook_pipelines | 0011_reseed_playbook_pipelines.sql | identical |
| 20260908003955 | foundation_enrollment | 0012_foundation_enrollment.sql | identical |
| 20260908004013 | city_index_p1_only | 0013_city_index_p1_only.sql | identical |
| 20260911180424 | stage_task_templates_no_approval | 0014_stage_task_templates_no_approval.sql | comments only |
| 20260911182539 | client_provisioning | 0015_client_provisioning.sql | comments only |
| 20260911191014 | foundation_brand_first | 0016_foundation_brand_first.sql | comments only |
| 20260911192634 | worker_event_fires | 0017_worker_event_fires.sql | comments only |
| 20260912223513 | website_default_and_reopen_fires | 0018_website_default_and_reopen_fires.sql | comments only |
| 20260912225128 | fire_debounce_per_reason | 0019_fire_debounce_per_reason.sql | comments only |
| 20260912231047 | site_quality_scores | 0020_site_quality_scores.sql | identical |
| 20260912235208 | site_push_columns | 0021_site_push_columns.sql | comments only |
| 20260913014339 | 0022_seo_worker_stage | 0022_seo_worker_stage.sql | comments only |
| 20260913014710 | 0023_site_branch | 0023_site_branch.sql | comments only |
| 20260913020039 | 0024_reporting_worker | 0024_reporting_worker.sql | comments only |
| 20260913022036 | 0025_seo_stages_worker | 0025_seo_stages_worker.sql | comments only |
| 20260913023149 | 0026_website_stages_worker | 0026_website_stages_worker.sql | comments only |
| 20260913024152 | 0027_fire_retries | 0027_fire_retries.sql | comments only |
| 20260913024312 | 0028_fire_retry_pacing | 0028_fire_retry_pacing.sql | comments only |
| 20260913183150 | 0029_approvals_retool | 0029_approvals_retool.sql | comments only |
| 20260913191056 | 0030_fire_retry_no_response_window | 0030_fire_retry_no_response_window.sql | comments only |
| 20260913210325 | 0031_converge_on_enrollment_delete | 0031_converge_on_enrollment_delete.sql | comments only |
| 20260913212424 | google_connect | 0032_google_connect.sql | identical |
| 20260913231548 | rank_sync_dataforseo | 0033_rank_sync_dataforseo.sql | identical |
| 20260914015353 | rank_sync_collect | 0034_rank_sync_collect.sql | identical |
| 20260914022548 | website_updates | 0035_website_updates.sql | identical |
| 20260915214158 | 0036_team_only_access | 0036_team_only_access.sql | identical |
| 20260917184951 | 0037_portal_access | 0037_portal_access.sql | identical |
| 20260917185653 | 0038_portal_seen | 0038_portal_seen.sql | identical |
| 20260920201305 | 0039_foundation_v1_work_modes | 0039_foundation_v1_work_modes.sql | identical |
| 20260921012235 | 0040_foundation_v1_service_area | 0040_foundation_v1_service_area.sql | identical |

The migration history was read, never written: no `apply_migration`, no
`migration repair`, no rename of a recorded version. Renaming files to the
timestamped form (for the Supabase CLI) would be a separate change.

## 0036–0038 against the live database

Checked read-only against the catalog on Sept 22:

- **Functions** `is_team`, `secret_present`, `link_team_member`,
  `link_portal_user`, `portal_user_not_team`, `portal_client_id`,
  `portal_seen`: body, language, volatility, `SECURITY DEFINER`,
  `search_path=public`, ACLs and comments match the files.
- **Callable security-definer functions:** exactly `is_team`,
  `portal_client_id`, `portal_seen`, `secret_present`, to `authenticated`
  only (not `anon`) — the 0036 sweep's intended result.
- **Triggers** `team_members_link`, `portal_users_link`,
  `portal_users_not_team` present as written.
- **`portal_users`**: columns, defaults, FKs, `unique(email)`, RLS on, the
  two policies, no `anon` grant.
- **Policies:** 50 in `public` over 49 tables, 49 `is_team()`-based plus
  "portal user reads own row"; none `using (true)`; every table has RLS and a
  policy. Storage: the eight documents / brand-assets policies require
  `is_team()`.
- **Views:** all eight `portal_*` exist, `security_invoker=false`, owned by
  `postgres`, filtered by `portal_client_id()`, columns as in the file,
  `authenticated` SELECT only, nothing for `anon` / PUBLIC.
- **Seed:** one team member, linked; no portal users yet.

## Edge Functions

Deployed source fetched with `get_edge_function` and compared byte-for-byte
(sha256 prefix of the entry file):

| Function | Deployed | sha256 | This branch | `main` before |
| --- | --- | --- | --- | --- |
| brand-scan | v7 | 76db573bfc2c6088 | identical | no team check |
| brightlocal-sync | v5 | c944fb082f4ace2d | identical | no team check |
| client-provision | v3 | c61f801f6ca4e081 | identical | no team check |
| google-connect | v2 | 9898fcad1872b442 | identical | no team check |
| google-ops | v2 | 4c393492f26e738c | identical | no team check |
| gsc-sync | v3 | 666074116d1c9c81 | identical | no team check |
| rank-sync | v4 | 790065b06e1e4bb1 | identical (dividers aligned) | no team check |
| stripe-billing | v2 | 11db4d26bd39946d | identical | no team check |
| portal-invite | v1 | 2a3ee13da94729c8 | identical (dividers aligned) | absent |

Before this branch, redeploying any of the first eight from `main` would have
silently removed the team-only guard that production relies on.

**site-push is `main`'s**, untouched: v11 with `handler.ts`, `plan.ts` and
`native_git_deploy` in `SITE_PUSH_FEATURES`. It already has the same
`team_members` check (in `handler.ts`). The deployed v16 bundle's `index.ts`
and `plan.ts` are byte-identical to `main`; `handler.ts` (5 lines) and
`src/lib/content-adapters.ts` (1 line) differ only in comment-divider width.
The step-1 branch's older single-file `index.ts` was discarded in the merge.

## Types

`src/lib/database.types.ts` is the generator's output for the live schema. It
is a strict superset of `main`'s file (no table, view, function, column or
enum value dropped); the only changed type is `worker_fires.id`, now `never`
on insert / update because it is an identity column. PR #50 also edits this
file and adds 0041, which is not applied yet — after #50 lands, regenerate.

## Sandbox tests

```
scripts/test-portal-sandbox.sh    # PostgreSQL 15+ server binaries; nothing remote
```

A throwaway cluster in a temp dir (Unix socket only, deleted on exit) is set
up like the project: `postgres` NOSUPERUSER BYPASSRLS owns everything (the
production role shape, so the security-definer views behave as they do live),
`service_role` BYPASSRLS, Supabase's default privileges (ALL on new public
objects to anon / authenticated / service_role), and stubs for `auth`,
`storage`, `vault`, `pg_net` and `pg_cron`. **All 40 migration files replay
in order**, one transaction each, including 0036's and 0037's own verify
blocks. Synthetic fixtures (two clients, a portal contact each, an inactive
contact, a stranger, the team account) then feed
`supabase/tests/sandbox/portal_access.test.sql`, which switches role and JWT
claims the way PostgREST does.

Result on this branch: **297 pass, 0 fail, 1 gap.**

| Area | Checks |
| --- | --- |
| Shape | views are security-definer, owned by a non-superuser BYPASSRLS role, filtered, SELECT-only; no open policy; RLS everywhere; function grants exactly as intended |
| Team | reads / writes clients, tasks, storage; `secret_present`; sees all portal users; gets **nothing** from portal views |
| Anonymous | zero rows from every table, refused on every view and on all four RPCs, no storage |
| Isolation | client A's contact sees only A in every view, B's only B; asking for the other client returns nothing; an inactive contact and a stranger get nothing |
| Read-only | INSERT / UPDATE / DELETE through every view refused; base-table writes (rename client, move self to B, create portal rows, write change_log, delete clients, upload to storage) affect nothing; no other security-definer function callable; `get_brand_profile()` reveals nothing; `portal_seen()` stamps only the caller |
| Content | rankings only tracked keywords from DataForSEO with previous position; work log only approved changes and published posts; reports only cycles with a link; no `notes` / `gbp_spec` / `reasoning` / `evidence` columns |

**The security-definer views, tested rather than waved through.** The
advisor's `security_definer_view` ERROR is accurate: the views run as
`postgres`, which bypasses RLS. The tests prove what that means here:

- **G1** a portal contact reads 0 rows from `rank_snapshots` / `gsc_snapshots`
  directly but real rows through `portal_rankings` / `portal_search_queries` —
  the view is the boundary, and only its `WHERE portal_client_id()` scopes it.
- **G2** switching the JWT in one session switches the scope; nothing is
  cached per session or per owner.
- **G3** deactivating a contact empties every view on the next statement.
- **A8 + D9** `portal_client` and `portal_site` are auto-updatable, so a write
  through them would run as the owner and bypass RLS. Only the SELECT-only
  grant stops it — the tests confirm the grant holds, and the negative
  control below confirms that without it the write succeeds.
- **G4** a team address cannot be made a portal user.

Switching the views to `security_invoker = true` would need client-scoped
policies on eight base tables and would expose every column of those tables
to portal users (RLS cannot hide columns) — the opposite of 0037's design.
The views stay; the checks above are what keeps them honest.

**Negative control.** With four weaknesses injected (UPDATE granted on
`portal_client`, `portal_site`'s filter defeated, `fire_foundation_worker`
granted to `authenticated`, an open policy on `keywords`), the suite reports
15 failures naming each one. So it fails when it should.

**Gap G5** (reported, not failed): `portal_users` has no unique index on
`auth_user_id`, and `portal_client_id()` is `limit 1` without an order. The
link trigger only fills a null `auth_user_id`, so one sign-in lands on two
active rows only through a direct team / service-role write — but if it did,
which client that sign-in sees would be undefined. Fix: a partial unique
index on `auth_user_id where is_active` (a new migration; not in this PR).

## Remaining differences and findings

1. **`gsc_snapshots_plain_key` has no file.** Production's
   `gsc_snapshots_natural_key` is on plain `page`, with `page default ''`;
   a replay of the repository gets 0007's expression index on
   `coalesce(page, '')`, and `gsc-sync`'s `upsert … onConflict` would fail
   against it. Restoring the file (as `0007a_…`, so it sorts after 0007)
   is a follow-up.
2. **Comment-only drift** in 19 migrations (table above). Harmless; noted so a
   future checksum comparison is not surprised.
3. **`portal-invite` re-invites send nothing.** For an address that already
   has a sign-in it calls `auth.admin.generateLink`, which returns a link but
   does not email it, then answers `link_sent`. First-time invites
   (`inviteUserByEmail`) do send. The deployed function behaves the same, so
   it is left identical here; fixing it means a code change plus a deploy.
4. **Re-inviting an address under another client moves it.** `portal-invite`
   upserts on `email`, so the row's `client_id` is overwritten. Team-only, but
   worth a confirmation step in the UI.
5. **G5** above.
6. **Advisors not caused by these migrations:** `pg_net` in `public`,
   leaked-password protection off. The `authenticated_security_definer_
   function_executable` WARN on the four RPCs is intended (tests B4 / A7 / F).
7. **Custom SMTP** is still needed before inviting real clients (AGENTS.md).
8. **PR #50** (`codex/client-baseline-scorecards`) also edits `AGENTS.md` and
   `src/lib/database.types.ts` and adds `0041`. Whichever lands second
   resolves those two files; this branch does not touch #50.

## Rollback

- **This PR.** It changes only the repository. Revert the merge with
  `git revert -m 1 <merge commit>`; nothing in the project changes either way.
  Reverting reopens the exposure described above: `main`'s eight Edge
  Functions without the team check would again be what a redeploy ships.
- **Edge Functions.** Nothing was deployed. If a later deploy from this branch
  misbehaves, redeploy the previous version from the Supabase dashboard
  (versions listed above).
- **Database.** Nothing was applied. 0036–0038 are live and were before this
  branch. Undoing them is a new migration, not a history edit, and needs
  Tom's decision:
  - *portal only (0037/0038):* revoke `select` on the eight `portal_*` views
    from `authenticated` (instant, reversible), or drop the views,
    `portal_seen()`, `portal_client_id()`, the two triggers and `portal_users`.
  - *0036:* do **not** roll back without a replacement — it is what keeps a
    portal sign-in out of every base table, and 0039's `foundation_releases`
    policy calls `is_team()`.
