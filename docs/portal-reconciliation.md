# Portal reconciliation (Sept 22 2026)

Migrations 0036–0038 were applied to the Supabase project (`iokcopiyzajigvhwexhe`)
on Sept 15 and 17 from two unmerged branches, `claude/portal-step0-team-rls` and
`claude/portal-step1-client-logins`. The Edge Functions they pair with were
deployed at the same time. `main` carried none of it, and 0039 (on `main`)
already depends on 0036's `is_team()`. This branch brings the repository back in
line with what is running. **Nothing was applied, deployed or changed in the
project to produce it.**

## Merging this PR deploys the app

Vercel's production branch for `compass-crm` is `main`. **Merging this PR
into `main` deploys the CRM, portal routes included, to production** at
https://compass-crm-ten.vercel.app with no manual step. It does **not** apply
migrations or deploy Edge Functions; those stay manual, in the "To go live"
steps below.

What ships on merge is safe to expose:
- the read-only `/portal` routes, which serve only the views 0037 already
  created live;
- the Overview tab's **Client portal** card, listing any existing contacts
  (none today) with **Revoke**.

What does **not** become usable: the card's **Send invite** form. It sits
behind the server-side flag `PORTAL_INVITES_ENABLED`, which is **off unless
set to exactly `true`** in the deployment's environment. With the flag off:

- the card shows "Invites are switched off for now" instead of the form;
- `invitePortalUserAction` refuses before reading the form or calling
  `portal-invite`, so a hand-crafted POST of the action sends nothing
  (`src/lib/portal-invites.ts`; `tests/portal-invites.test.mjs`);
- Revoke is not gated: taking access away always works.

The flag isn't `NEXT_PUBLIC_`, so it's never in the browser bundle.
Vercel applies environment variable changes only to **new** deployments, so
turning it on or off needs a redeploy.

## What the branch contains

| Commit | What |
| --- | --- |
| Merge of step 1 (contains step 0) | 0036, 0037, 0038; team-only checks in eight Edge Functions; `portal-invite`; `/portal` routes; the Overview tab's Client portal card; `/auth/signout`; `shouldCreateUser: false` on magic links. `site-push/index.ts` conflict resolved to **main's** version (see below). |
| Deployed-byte alignment | `rank-sync` and `portal-invite` differed from the deployed source only in comment-divider width; the repo now holds the deployed bytes. |
| Types | `src/lib/database.types.ts` regenerated from the live schema. |
| Routing fix | A client contact who signs in at `/login` goes to `/portal` instead of being signed out. |
| Sandbox | `scripts/test-portal-sandbox.sh` + `supabase/tests/sandbox/` — replays every migration into a local Postgres shaped like the project and runs the access checks (310 today). |
| This document | |
| **Follow-ups (below)** | `0007a_gsc_snapshots_plain_key.sql` (the recorded migration that had no file); `0042_portal_single_assignment.sql` (**new, not applied**); `portal-invite` rewritten as a tested handler that links first-time invitees and really delivers re-invites (**not deployed**). |

## Migration files and Supabase's recorded versions

Supabase records a migration applied through the MCP / Management API under a
**version** (the UTC timestamp at apply time, `YYYYMMDDHHMMSS`) and a **name**
(whatever the caller passed). The repository orders files by a four-digit
prefix. The two are matched by name, not by position: names were passed
without the prefix up to 0021 and for 0032–0035, and with it from 0022–0031
and from 0036 on. The project has **41** recorded migrations and the
repository has a file for each: `gsc_snapshots_plain_key` had none until
`0007a_gsc_snapshots_plain_key.sql` (the `a` sorts it after 0007 and before
0008, the order it was applied in). `0042_portal_single_assignment.sql` is
new and has **no recorded version yet** — it is waiting to be applied.

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
| 20260831154225 | gsc_snapshots_plain_key | 0007a_gsc_snapshots_plain_key.sql | identical (file restored Sept 22) |
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
| — | (PR #50's 0041, not applied) | not on this branch | — |
| — (not applied) | — | 0042_portal_single_assignment.sql | new |

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
| portal-invite | v1 | 2a3ee13da94729c8 | identical at the reconciliation commit; **rewritten by the follow-up, awaiting deploy** | absent |

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

Result on this branch: **310 pass, 0 fail, 0 gaps** (297 + 1 gap at the
reconciliation commit; the follow-up turned the gap into required checks and
added the GSC upsert).

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

**Former gap G5, now required (H1–H7, migration 0042).** `portal_client_id()`
is `limit 1`, and nothing stopped one sign-in from sitting on two active rows,
or a row from being moved to another client. Every H write is made as
`postgres` (the power the team and the service role have), so only the
constraints can stop it: a second active assignment (23505), a reassignment
(23514), a case-variant duplicate email (23505) and reactivating a revoked row
for a sign-in active elsewhere (23505) are all refused; a revoked row may stay
behind; client A's contact still sees exactly client A afterwards. With 0042
removed, 7 of these fail — including H7, which shows the contact really does
end up seeing client B.

**GSC upsert after a fresh replay (I1–I4, 0007a).** The replay's
`gsc_snapshots_natural_key` equals production's definition, `page` defaults to
`''`, and the upsert exactly as PostgREST issues it for `gsc-sync`
(`on conflict (client_id, query, page, period_start, period_end) do nothing`)
succeeds twice as the service role and leaves one row. With 0007a removed,
both upserts fail with 42P10 — every sync would have failed on a database
rebuilt from the repository.

## Follow-ups (Sept 22 2026): what changed and what still has to happen

**`portal-invite`** (`handler.ts` + `index.ts`, tested by
`tests/portal-invite-handler.test.mjs`, 18 tests over a fake Supabase that
enforces 0037 + 0042 and records every email instead of sending it):

- **First-time invites now link.** The deployed v1 saved the row *before* the
  invite created the sign-in, and the link trigger only fires on insert or an
  email change — so a first-time invitee's `auth_user_id` stayed null,
  `portal_client_id()` returned nothing, and the CRM layout signed them out.
  The handler now saves the id `inviteUserByEmail` returns on *that* row
  (matched by row id and client), reads it back, and reports success only if
  it stuck. A failed link is a 500 with `saved: true, linked: false`.
- **Re-invites are delivered.** `generateLink` (which only returns a link) is
  gone: a contact who has signed in gets a magic link through
  `signInWithOtp` with `shouldCreateUser: false`; one who never accepted gets
  the invite re-sent. The status says which (`invited` / `invite_resent` /
  `link_sent`). Existing sign-ins are found across every page of users, not
  just the first 50.
- **No cross-client moves.** An address already on another client's row
  (active or revoked) is a 409 before anything is written or sent; so is a
  sign-in already active for another client. 0042 enforces the same in the
  database, and the handler maps a raced constraint error to 409, never to
  success. Revoke is scoped to the client the card belongs to.
- **Partial failures converge.** Order is: refuse → save row → (existing
  sign-in: link, then send) / (new address: send, then link). Every failure
  after the row is saved says so, and re-sending the same invite finishes the
  job without a second row (tests for a failed row save, a failed email, a
  failed link, a link that matched no row, and each retry).
- The mutation check: putting back the two original bugs (no link after a
  first-time invite; `generateLink` for re-invites) fails 7 of the 18 tests.

**To go live (Tom's call; nothing here was applied, deployed or sent):**

1. Apply `0042_portal_single_assignment.sql` through the Supabase MCP
   (`apply_migration`, name `0042_portal_single_assignment`). `portal_users`
   is empty, so its pre-checks pass. **Do not apply 0007a** — it is already
   recorded as `20260831154225`.
2. Deploy `portal-invite` (both files). It works with or without 0042; 0042 is
   the database-side guarantee.
3. Before the first real invite: custom SMTP (below), and check that the Auth
   email templates for *Invite* and *Magic Link* send the
   `token_hash` form `/auth/confirm` reads. Emails sent by the server (invite
   and the re-invite magic link) cannot use the browser's PKCE code; with the
   default templates the session arrives in the URL fragment, which
   `/auth/confirm` never sees. This was true of v1 as well and is not
   verified here (no read access to Auth settings).
4. **Turn invites on, last:**
   1. Vercel → project `compass-crm` → Settings → Environment Variables.
      Add `PORTAL_INVITES_ENABLED` with the value `true` (lowercase, no
      spaces), scoped to **Production**. Add **Preview** too only if you
      want invites from preview deployments, which invite with a redirect
      back to that preview URL.
   2. Deployments → the current production deployment → **Redeploy**.
      The variable takes effect only in a new deployment.
   3. Open any client's Overview tab. The Client portal card now shows the
      **Send invite** form instead of the "switched off" notice.
   4. Invite a Compass-controlled test address first, sign in through the
      email, and confirm it lands on `/portal` with only that client's data.
      Then revoke it.

   **To turn invites off again:** delete the variable (or set it to
   anything but `true`) and redeploy. The form disappears and the action
   refuses. Existing contacts keep their access until revoked.

## Remaining differences and findings

1. ~~`gsc_snapshots_plain_key` has no file.~~ Restored as
   `0007a_gsc_snapshots_plain_key.sql`, byte-identical to the recorded SQL;
   the sandbox proves the `gsc-sync` upsert on a fresh replay (I1–I4).
2. **Comment-only drift** in 19 migrations (table above). Harmless; noted so a
   future checksum comparison is not surprised.
3. ~~`portal-invite` re-invites send nothing.~~ Fixed in the repository;
   **the deployed v1 still behaves this way until the new version is
   deployed.**
4. ~~Re-inviting an address under another client moves it.~~ Refused (409) by
   the handler and, once applied, by 0042.
5. ~~G5~~ — required checks H1–H7; enforced once 0042 is applied.
6. **Advisors not caused by these migrations:** `pg_net` in `public`,
   leaked-password protection off. The `authenticated_security_definer_
   function_executable` WARN on the four RPCs is intended (tests B4 / A7 / F).
7. **Custom SMTP** is still needed before inviting real clients (AGENTS.md).
8. **PR #50** (`codex/client-baseline-scorecards`) also edits `AGENTS.md` and
   `src/lib/database.types.ts` and adds `0041`. Whichever lands second
   resolves those two files; this branch does not touch #50.
9. **First-time invitees are never linked by the deployed v1** (see
   Follow-ups). Nobody has been invited yet (`portal_users` is empty), so no
   one is affected today; deploy the new `portal-invite` before the first
   invite.

## Rollback

- **This PR.** Merging deploys the app (above). Nothing in the Supabase
  project changes either way. Revert the merge with
  `git revert -m 1 <merge commit>`; the revert redeploys the previous app.
  To shut invites without reverting, unset `PORTAL_INVITES_ENABLED` and
  redeploy.
  Reverting reopens the exposure described above: `main`'s eight Edge
  Functions without the team check would again be what a redeploy ships.
- **Edge Functions.** Nothing was deployed. If a later deploy from this branch
  misbehaves, redeploy the previous version from the Supabase dashboard
  (versions listed above; `portal-invite` v1 is the one to return to).
- **0042, once applied.** Nothing depends on it. To undo: `drop trigger
  portal_users_client_fixed on portal_users; drop function
  portal_user_client_fixed(); drop index portal_users_one_active_client,
  portal_users_email_lower_key;` as a new migration.
- **0007a** changes nothing in production (already recorded); reverting the
  file only makes a fresh replay wrong again.
- **Database.** Nothing was applied. 0036–0038 are live and were before this
  branch. Undoing them is a new migration, not a history edit, and needs
  Tom's decision:
  - *portal only (0037/0038):* revoke `select` on the eight `portal_*` views
    from `authenticated` (instant, reversible), or drop the views,
    `portal_seen()`, `portal_client_id()`, the two triggers and `portal_users`.
  - *0036:* do **not** roll back without a replacement — it is what keeps a
    portal sign-in out of every base table, and 0039's `foundation_releases`
    policy calls `is_team()`.
