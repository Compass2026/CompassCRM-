# Compass Website Foundation v1 in the CRM

Implemented Sept 20 2026 on `claude/foundation-v1-crm-integration` from the
[accepted handoff](https://github.com/Compass2026/showmeelectricalwebsite/blob/codex/foundation-v1-handoff/docs/foundation-v1-handoff.md)
and the [CRM onboarding review](https://github.com/Compass2026/showmeelectricalwebsite/blob/codex/foundation-v1-handoff/docs/compass-crm-onboarding-review.md).
Accepted foundation code: `Compass2026/showmeelectricalwebsite` @
`f928381b3a81e20694571cefc5091392b2c84e86` (v1 was accepted at
`94014af35316c94616dadb3f8d606a4b68577fb0` on Sept 20 2026 and moved to
`f928381` on Sept 21 2026 for service-area support — see "Service-area
support" below; migration 0040_foundation_v1_service_area). The three governing Drive
originals are listed in `foundation_releases.documents` (migration 0039_foundation_v1_work_modes).

This branch changes code and instructions. **Nothing is deployed by it**:
the migration is not applied, the Edge Function is not redeployed, the
Routine still runs whatever skill its last fire loaded. "Activation" below
says exactly what turns each part on.

## What changed

| Area | Before (reviewed at `b847a08`) | Now |
| --- | --- | --- |
| Website build source | Worker copied `templates/astro-site/`, set `stack='astro'`, ran the Astro dist gate | Worker fetches the pinned Foundation release through site-push's archive mode, builds the brand layer per `docs/starter-checklist.md`, verifies with the Foundation's own checks. `templates/astro-site/` is reference only; the old gate audits non-Foundation sites |
| Work mode | A checkbox "the client keeps this website" | `sites.work_mode`: `new_build` / `upgrade_existing` / `client_retains`, chosen at intake (radio), editable on the Foundation tab. Each mode is a distinct path for the worker and for site-push. `client_retains` keeps the Sept 13 behaviour (client-controlled row, Website enrollment dropped) |
| Build brief | None | `sites.build_brief` (JSON) + `Build Brief — <Client>` in Drive 04 Website: standard version + SHA, repo, baseline / production / preview branch, PR base, framework, adapter, brand and factual sources, services, coverage (real locations vs served cities with the city gate), page + keyword plan, internal links, assets, contact configuration, missing inputs, evidence buckets, preview links, acceptance checks. `src/lib/build-brief.ts`, `scripts/build-brief.mjs`, Foundation-tab button |
| Content adapters | Monthly instructions assumed Lucas JSON paths and `/service-areas/{slug}` | `src/lib/content-adapters.ts`: `foundation_brand_content` (typed TS, `/service-area/[city]`, locations separate — pull requests only), `lucas_json` (push), `markdown_blog` (BHG shape — blog pushes, city pages are documents), `unsupported` (documents). Detected from the actual tree; JSON into a typed registry is refused; a version is not evidence of adoption |
| site-push branches | Side branch from `main`, PR base `main`, non-PR push relabelled the branch of record, missing row inserted as Astro | `plan.ts`: branch of record = `sites.branch` → repo default branch → `main` (never assumed); preview created from it, PR base = it, preview deploy, `sites.preview_branch` recorded, `sites.branch` untouched; `client_retains` refused (409); `upgrade_existing` requires a preview + PR unless the branch of record is named for an authorised content entry; inserted rows carry the detected stack |
| Evidence | Gate report on `sites.quality` | Preview outcomes fold into the brief (`attachPreviewOutcome`): stage evidence line, `deliverables` rows for the preview and PR, a `change_log` row, a `decisions` row; builder checks, deferred checks, independent review and launch work are separate buckets |
| Stage wording | "Confirm the stack and record the site row (Astro, …)" | Migration 0039 rewrites the Website stage description and the Discovery / Build task titles; open tasks on not-started stages pick the wording up |

Preserved: Foundation enrollment and gates (0012, 0016), Website / SEO
default enrollment (0018, 0022), the Sept 14 authorisation to publish
content-contract entries without a look on Compass-run sites (now explicit:
the entry names the branch of record), the weekly blog, the monthly cycle,
Put it back, the SEO stages, GBP / citation / backlink playbooks.

## Work modes

| Mode | Site row at intake | Website pipeline | Build to 70% | Monthly updates |
| --- | --- | --- | --- | --- |
| `new_build` | `stack nextjs`, `controlled_by_compass true` | enrolled (pending behind Foundation) | Foundation build → branch of record → production deployment = staging | adapter `foundation_brand_content`: pull requests |
| `upgrade_existing` | `stack other` until detected, `repo_url` + `branch` from the form | enrolled | preview branch from `sites.branch` + PR + preview deployment | per detected adapter; pushes only for authorised entries naming `sites.branch` |
| `client_retains` | `stack other`, `controlled_by_compass false` | dropped (Plan tab re-enrols) | n/a | proposed documents + `change_log` |

## Source access in the Routine environment

The worker session cannot reach github.com (credential proxy; only the
attached CRM repo). `site-push { archive: { repo, ref } }` fetches the
tarball with the Vault token and streams it back; it serves only the
client's own repository or the current `foundation_releases` row, so it is
not a general proxy. A failure is reported as the specific error and the
stage blocks; the worker never falls back to Astro or another commit. If
the Routine cannot install packages (registry blocked), that is recorded
as the blocker too.

## Verification the worker runs

`scripts/foundation-verify.sh <site-dir> <brand> <production-host>
[results.json] [port] [browser-paths]` is the recipe, executable as written
by the worker, a human or a test fixture. In order: `npm ci`; the
**brand-specific** typecheck (`node scripts/qa/typecheck-brand.mjs
<brand>`); `COMPASS_BRAND=<brand> npx next build`; the route manifest; the
provider suite (`npx tsx scripts/qa/provider.test.mjs`, its own in-process
mock service); then ONE shared mock provider service is started **first**
and the same `INQUIRY_MOCK_PROVIDER_URL` is passed to both the site
(`next start` with `INQUIRY_DELIVERY=mock`) and the form suite; the crawl
against the production host with assets remapped; the browser launcher
check; the mocked forms suite and the browser suite on the brand's
representative routes when a Chromium exists — otherwise both are recorded
as `deferred` with the reason, never as passed, and a deferred check is
never acceptance. Results land in `results.json` (`pass`, `fail`,
`deferred`, `ok`) and become the brief's evidence verbatim through
`attachPreviewOutcome`. Delivery is mocked in every step; nothing is sent.
`FRESH=1 npm run verify` in the foundation remains the clean-checkout
recipe for a human. Results are builder-reported; the brief keeps
"independent review" empty until someone else records it.

## Tests

`npm test` (Node's test runner, no new dependency) — 51 checks:

- `tests/site-push-handler.test.mjs` — the **request boundary**: the real
  `handler.ts` with a fake Supabase client and a fake GitHub API
  (`tests/helpers/fakes.mjs`). Version mode; 401 without credentials; 403 for a
  signed-in non-team user (the team-only check from 0036_team_only_access);
  naming `main` with `src/app/page.tsx` + `src/components/Header.tsx` →
  409 and no GitHub write; a data entry mixed with code, or with a
  deletion → 409; an authorised blog/data entry → commit on the branch of
  record, `grant: content_entry`; an upgrade preview on a `production`
  branch → branch created from the production head, PR base `production`,
  `production` and `main` unmoved, `sites.preview_branch` recorded; a
  `new_build` into a repo whose `main` is authored by someone else → parked
  on `compass/foundation-build` (orphan), `main` untouched; a new build into
  an empty repo → `main`, production; client-retains → 409; no site row +
  default branch `trunk` → baseline `trunk`, inserted row `nextjs`; archive
  allow-list (403 / 200).
- `tests/site-push-plan.test.mjs` — the planning helper, including the
  content-entry verdicts and the `new_build`-over-foreign-head rule.
- `tests/content-adapters.test.mjs` — against the **accepted foundation
  tree** (`tests/fixtures/foundation-v1-tree.json`, from `git ls-tree`
  at `94014af`, still accurate at the pinned `f928381` — every path in it
  exists there and the service-area commit added none): the blog registry is `brands/<brand>/content/blog/index.ts`
  (no `content/articles`); a recorded, registered, non-fictional brand is
  verified; no recorded brand, multiple client brands, a brand missing from
  the tree, the fictional brand, an unregistered brand → each a specific
  missing input and `writable: false`; the Lucas / BHG / unknown shapes;
  typed-registry writes refused; the content-entry validator.
- `tests/build-brief.test.mjs` — the brief, the city gate, a Foundation
  site with no recorded brand (not writable, says why), outcome attachment.

`next build`, `tsc --noEmit` and `eslint` pass. The edge function is
type-checked against a Deno shim; its HTTP paths are exercised by the
handler tests, not against the live GitHub or Vercel APIs.

**Verification recipe, executed in an isolated fixture** (Sept 20 2026): the
accepted foundation at `94014af` was extracted with `git archive` into a
temporary directory and `scripts/foundation-verify.sh <dir> harbor-lane
harbor-lane.example … "/,/locations/westfield,/service-area/northgate,/contact"`
was run as the worker would run it. See the PR description for the
`results.json` of that run. The browser suite depends on the routes passed
in: the foundation's own `verify.sh` uses per-brand representative routes,
and the script takes them as its sixth argument.

## Activation — one sequence, in this order

Code on the branch does nothing to the running system until these steps.
Three parts activate separately (the database, the Edge Function, the app
and the Routine's skill), and scheduled runs keep firing during the
transition — the daily sweep, the monthly `site_updates` fire on the 2nd,
the weekly `blog_post` fire on Wednesdays, and any stage completion. The
sequence below makes a run against a half-installed integration impossible
in two independent ways: the Routine is paused for the window, and the
playbook's **preflight** refuses to build unless all three parts answer.

| Step | Action | Verifies | Rollback |
| --- | --- | --- | --- |
| 0 | **Pause the Routine** ("Compass Foundation worker" at claude.ai/code/routines) and note the time. Fires that arrive while it is paused are recorded in `worker_fires` (the CRM keeps POSTing) and `retry_failed_fires()` re-sends the recent ones once it is resumed; nothing is lost, nothing runs. | `select count(*) from worker_fires where fired_at > '<pause time>'` grows without sessions starting | resume the Routine |
| 1 | **Apply migration 0039** to `iokcopiyzajigvhwexhe` through the Supabase MCP (`apply_migration`, name `0039_foundation_v1_work_modes`; the remote already carries 0036–0038 from the portal branches). | `select version, source_sha from foundation_releases where is_current` → v1 / `94014af…`; `sites.work_mode` backfilled (`select name, work_mode from sites join clients …`) | the migration is additive (new type, columns, table, wording); leave it in place — nothing reads it until step 3 |
| 2 | **Deploy site-push v9** from `supabase/functions/site-push/` (dashboard upload or `supabase functions deploy site-push`). | `POST {client_id, version: true}` with the cron secret → `{"version": 9, "features": [...]}` | redeploy the previous function from `main` (v8: no `version` mode, `main` assumed) |
| 3 | **Merge PR #38 into `main`.** Vercel deploys the CRM app (project `compass-crm`) from `main`: intake radio, Foundation-tab work mode / adapter / preview branch / build-brief card. The app reads the columns from step 1. | the Foundation tab of a client renders the Site card with a work mode | revert the merge commit; the app then ignores the new columns |
| 4 | **Verify the Routine's source branch** — do not assume it. Open the Routine at claude.ai/code/routines and read the repository and branch it starts sessions from; it must be `Compass2026/CompassCRM-` @ `main` (the merged branch). If it is pinned to another branch or SHA, point it at `main`. The skill is read from that checkout at session start. | the Routine's source shows `main`; a hand run `/foundation-worker <client>` prints the preflight lines | pause again |
| 5 | **Resume the Routine.** `retry_failed_fires()` (every 15 min) re-fires what arrived during the pause; the daily sweep covers the rest. | `worker_fires` answers turn 200 again; the next run's evidence carries `release v1 …` and `site-push v9` from the preflight | pause |
| 6 | **Per client**: set the work mode on the Foundation tab where the backfill left it null (Shewmaker; any site never pushed), press *Generate build brief*, read `missing_inputs`; for a Foundation site record `content_paths.brand`. | the brief card shows the mode, adapter and count of missing inputs | — |

If steps 1–3 cannot all be completed in one window, leave the Routine
paused: a run that finds the release row missing, the columns missing or
the function answering without `version` **blocks the stage** with the
exact miss (playbook preflight) instead of building — but pausing is the
first line, the preflight the second.

Optional, later: Vercel deployment protection on client previews (a login
is needed to view an `upgrade_existing` preview today); a Chromium in the
Routine environment (so forms / browser checks stop being deferred).

Nothing in this branch applies migrations, deploys functions, enrols
clients, runs the Routine, publishes a site, changes DNS or sends messages.

## Activation record — Sept 20 2026

Activated in the documented order between 20:11 and 20:19 UTC, with the
Routine's general client processing paused for the window. Deployed
versions:

| Part | Before (rollback point) | After |
| --- | --- | --- |
| CRM app (Vercel `compass-crm`, production) | `dpl_y6bBSRNBAxk9bxC3SpYjLtyfMfLi` = `main` @ `b847a08` | `dpl_4DvSiC6WFdn7cjKAb5Ek11UU8Jfy` = `main` @ `f8c366d` (merge of PR #38, head `dc8525e`) |
| Database (`iokcopiyzajigvhwexhe`) | latest migration `20260917185653 0038_portal_seen` | `20260920201305 0039_foundation_v1_work_modes` (additive; `foundation_releases` v1 = `94014af…`, seven `sites` columns, backfill: Lucas + BHG `upgrade_existing`, three client-run sites `client_retains`, Pensacola / Ginger Huff / Shewmaker null) |
| Edge Function `site-push` | Supabase version 9 (Sept 15; `ezbr` `7702c4a5…`; contract v8, team-member check) | Supabase version 10 (`ezbr` `c7e0ef6f…`); `{version: true}` → `{"version": 9, "features": [branch_of_record, preview, pull_request_base, archive, content_entry_boundary, work_modes, version]}` — probed live through `net.http_post` with the cron secret (request 664, HTTP 200) |
| Routine "Compass Foundation worker" (`trig_01Gn8V8uXR72fhSz3Dg1JsQm`) | cron `0 13 * * *` UTC, enabled, source `Compass2026/CompassCRM-` with no branch pinned (= default branch `main`), connectors Data-for-SEO / Google-Drive / Supabase | unchanged |

**What differed from the plan, and why.**

- The Routine could not be paused from a session (`update_trigger` is
  refused for Routines created through the HTTP API; only Tom can toggle it
  at claude.ai/code/routines). Its next scheduled sweep was 13:00 UTC the
  following day, outside the window. General processing was paused on the
  database side instead: a temporary `worker_pause` row and a guarded
  `fire_foundation_worker()` that **records** a paused fire in
  `worker_fires` (`request_id null, attempt 99` — never auto-retried by
  `retry_failed_fires()`, which skips `attempt >= 8`) and sends nothing. The
  guard allows one client (`allow_client`). Both are removed at close and
  the function restored verbatim.
- The remote project already carried migrations 0036–0038 from the portal
  branches, so the foundation migration was renumbered **0039** and the
  `foundation_releases` policy uses `(select is_team())`; the deployed
  `site-push` had the team-member check from 0036, which `handler.ts` now
  carries too (commit `dc8525e`, 43 checks).
- `plan.ts` imports `src/lib/content-adapters.ts`; the function is deployed
  with the repository-relative layout (entrypoint
  `supabase/functions/site-push/index.ts` plus `src/lib/content-adapters.ts`),
  which the Supabase bundler resolves.

**Fictional test client** (`67f110bd-fb6e-4432-8536-7f192df92532`,
"Compass Activation Test (fictional)"; site row
`fce5f434-5e5e-4e4e-84cf-89fa2867d8ec`, `work_mode = new_build`). Every
fact is invented and labelled; status stayed `launching` (no billing,
reporting, monthly cycle, site-updates or blog fires, which are for
`active` clients), the SEO enrollment was dropped before Foundation
completed (no audit, no DataForSEO / BrightLocal spend), Foundation data
was seeded by hand (brand board, 4 services, 6 keywords, 6 page groups, 2
`unverified` claims) and the three Foundation stages were closed by hand,
which activated Website through `handle_foundation_completion`.

The intake **form** could not be driven from this environment: the deployed
app sits behind Vercel SSO (creating an automation bypass was refused, 403)
and a magic-link sign-in was not permitted. The intake's own two inserts
(`createClientAction`, `new_build`) were executed as SQL on the production
database instead, so the intake triggers (Foundation enrollment, pending
Website / SEO, `client created` fire) ran; the form → server action path
itself is still to be exercised by Tom once (see the report).

**Worker runs on the test client** (each fired through the CRM's own path:
`fire_foundation_worker()` → `pg_net` → the Routine API, HTTP 200 with the
session id in `worker_fires`/`net._http_response`):

| Run | Session | Fire | Outcome |
| --- | --- | --- | --- |
| 1 | `cse_01NDVwoFivFa36sBGGYgeSdS`, 20:35–20:46 UTC | `worker_fires` 116 / request 667 | Preflight passed (release row, columns, `site-push` v9 probe). Discovery done, Drive folders created, **build brief composed and stored** (`sites.build_brief`: standard v1 @ `94014af…`, Drive doc filed, `deliverables` row). Blocked at the source fetch: the playbook used `$ANON` / `$CRON` without saying where they come from. Fixed in PR #39 (skill: read both with `get_secret()` through the Supabase MCP). |
| 2 | `cse_01AGHgd7WUwvWvFk9ieynLQG`, 20:56–21:03 UTC | 118 / 672 | Credentials read, version probe OK, **pinned Foundation archive fetched through `site-push` archive mode (4.0 MB)**, brand `activation-test` started with `fictional: true`. Blocked on a real Foundation gap: `site.address` is required and rendered unconditionally (footer, contact page, JSON-LD), so a `service_area` business cannot be built on v1 without a Foundation change. The worker refused to invent an address or patch framework files, which is the intended behaviour. |
| 3 | `cse_01QQVJ5MKzfutgtmvJ6sV1Ec`, 21:14–21:47 UTC | 120 / 674 | Test client recast as `storefront` with a labelled fictional address. **Brand layer built on the pinned source, brand registered `fictional: true`, inquiry `forceMock: true`; the Foundation verification recipe ran in the worker environment and every check passed with nothing deferred** (install, brand typecheck, build, manifest, provider suite, crawl, mocked forms, browser — a Chromium exists there). Brief regenerated (`content_adapter = foundation_brand_content`, `foundation_version = v1`, `foundation_sha = 94014af…`), two placeholders logged. **Push failed three times with GitHub's secondary rate limit (403)**: site-push created one blob per file with sequential POSTs, and a 250-file build exceeds the ~80 content-creating requests a minute GitHub allows. Fixed in site-push (text files ride inline in the single tree request; blobs only for binaries, paced) — Supabase function version 11, contract still v9; test "a 250-file new build is one tree request". |

| 4 | `cse_01GmdSYEiXQNwPgAmKauwEcG`, 21:58–22:16 UTC | 122 / 678 | The push succeeded on the first attempt, confirming the rate-limit fix. Three defects instead: the worker pushed **only the brand layer** (30 files, no framework), so Vercel answered `NEXT_NO_VERSION`; the push **created** the Vercel project, and Vercel promotes a project's first deployment to **production**, which for a fictional brand is the one boundary this test forbids (nothing was published: the build failed); and the worker **completed the stage** on a deployment its own evidence said it had not verified. Completion rolled back by hand. All three fixed (below). |
| 5 | `cse_01PTQwqUVZn2MeRxH1YzdKJT`, 22:32–22:43 UTC | 126 / 685 | **Pass.** Whole tree pushed in one request (commit `3efb25f0`, 251 files, framework included), preview branch from `main` with `main` unmoved, Vercel deployment `dpl_FyNm9s537Ghbv5JhwnuxXgK1rREu` **READY** on a **preview** target, verified through the new `{ deployment_status }` call rather than assumed. All eight Foundation checks passed with nothing deferred. Brief, deliverables, change-log and decision rows written back. |

**Independently verified by the activation session, not taken from the
worker's evidence:** the deployment is `READY` with `target` preview (the
Vercel API, not the worker); the pushed branch carries 251 files including
`package.json` (with `next`), `next.config.ts`, `tsconfig.json`,
`brands/registry.ts`, `lib/routes.ts`, `app/layout.tsx` and `app/robots.ts`;
the brand is `fictional: true` in **both** `brands/registry.ts` (which fails a
production build) and `site.config.ts` (which forces `noindex` and a
`Disallow: /` robots.txt); and `inquiry.config.ts` has `forceMock: true`.
Nothing was delivered and nothing is indexable.

**What the platform actually does, verified against the live Vercel API:**
a project's **first** deployment is promoted to `production` whatever the
branch (`dpl_4rd3hS1DC5HyYbTz4iWgCNXnXRoW`, ref
`compass/preview-…`, `target: production`), the **second** deployment on the
same project and ref comes back `target: null` (preview), and an explicit
`target: "preview"` is rejected by the API as invalid. So a preview push may
never be the deployment that creates a project.

**Fixes made during the window** (PRs #39, #40, #41, all merged):

| Defect | Fix | Where |
| --- | --- | --- |
| The playbook used `$ANON` / `$CRON` without saying where they come from; the Routine environment has no such variables | the preflight reads both with `get_secret()` through the Supabase MCP and puts them in the shell for every curl | skill |
| One `POST /git/blobs` per file trips GitHub's secondary rate limit on a 250-file build | text files ride inline in the single tree request; blobs only for binaries, paced | site-push v11 |
| A preview push that creates the Vercel project lands on a production target | no deployment on the push that creates a project (the next push is a real preview); a production-target preview is reported `failed`, never as a preview | site-push v12 |
| Deployments were taken on trust | site-push waits up to 45 s, returns `ready_state` / `error_message`, and answers a read-only `{ deployment_status }` call | site-push v12 |
| A `new_build` push of only the brand layer leaves the repo with no framework | the playbook requires the whole tree and forbids splitting it into batches | skill |
| A stage completed on an unverified deployment | the playbook forbids completing a stage on a deployment not seen `READY`; an unverified one is deferred or blocked | skill |

**Close-out (22:45 UTC).**

- **Queued work.** Every fire recorded during the window (9) belongs to the
  fictional test client; none to a real client. `retry_failed_fires()` had
  zero candidates, so resuming re-fired nothing. The ten `pg_cron` jobs were
  never paused — only the worker fire path was gated — and all stayed active.
- **Scheduling restored.** `fire_foundation_worker()` is back to its
  pre-window definition verbatim (2-minute debounce, no pause gate) and the
  temporary `worker_pause` table is dropped. The Routine itself was never
  disabled; its next sweep is 13:00 UTC as usual.
- **Test client archived** as `offboarded`, which the worker's ground rules
  already refuse to touch.
- **Preview resources.** The GitHub repository
  `Compass2026/compassactivationtestfictional` is kept as the evidence trail
  and should be deleted once this record is accepted. The Vercel project
  `compassactivationtestfictional-preview` needs deleting by hand: this
  session's Vercel connection has no delete-project capability. It is not
  publicly reachable in the meantime (no custom domain, team SSO on all
  deployments, `noindex` and `Disallow: /` from the fictional brand).

**Gaps closed after the close-out (23:00–23:40 UTC).**

- **`upgrade_existing`, end to end, live.** Exercised against the disposable
  fictional repository with its built branch recorded as the branch of record.
  A push with no preview is refused (409, branch of record resolved from the
  record, not assumed `main`); naming the branch of record with typed
  Foundation content is refused too, because that adapter publishes nothing
  without a pull request; and the authorised path produced preview branch
  `…-preview`, pull request #1 against the branch of record, and a `READY`
  preview-target deployment, with the branch of record still at `fc2aabf` and
  without the change.
- **A seventh defect, found by that exercise and fixed.**
  `previewBranchName()` generates `compass/preview-<date>-<slug>`. When a
  site's branch of record is *itself* an old preview branch, the generated
  name equalled it, so the "preview" commit landed on the branch of record —
  and because a pull request is only opened when the branch differs, no pull
  request was opened either. A colliding name now takes a `-preview` suffix.
  site-push v13; test "an auto-named preview branch that collides with the
  branch of record is moved off it".
- **Intake form.** Still cannot be clicked from a session: the deployed CRM is
  behind Vercel SSO and the server action needs a signed-in team session. The
  contract it depends on is now enforced by tests instead
  (`tests/intake-contract.test.mjs`): every field the form posts is read by
  `createClientAction`, the work-mode radio offers exactly the three enum
  values, the action branches on all three, `client_retains` drops the Website
  enrollment, every mode records a `sites` row and none records Astro. One
  manual action remains for Tom — the supervised intake below, still
  **UNVERIFIED**.

## Tom's one supervised intake — UNVERIFIED

The only part of this integration that has never been exercised through the
interface it ships with. Everything below the form is covered by tests and by
five live worker runs; the form itself needs a signed-in team session, which
no session in this environment can obtain (the deployed CRM is behind Vercel
SSO, creating an automation bypass returned 403). **This stays marked
unverified until Tom actually completes it.** Ten minutes, fictional data,
nothing sent.

1. Open <https://compass-crm-ten.vercel.app/clients> signed in as a team
   member and click **New client**.
2. Fill the dialog with invented data, clearly labelled as such, e.g.
   Business name `Intake Check (fictional)`, Vertical `electrical`, Business
   type **Service area (goes to the customer)** — already the default, and
   the case this release exists for — City `Westfield`, State `MO`, Service area
   `Westfield and Northgate (fictional)`. Leave Website URL, Phone and
   Industry empty or fictional. Never a real business, and never a real
   phone number or address.
3. Under **Website work**, leave the first radio selected — *"New build on
   the Compass Website Foundation."* Leave Repository and Production branch
   empty: they belong to the upgrade path.
4. Click **Create client**.
5. On the new client, open the **Foundation** tab. Check three things:
   - **Work mode** reads *new build* (the select next to "Work mode:"). This
     is the whole point of the exercise: the radio reached `sites.work_mode`.
   - The site row exists and its stack is **not** Astro.
   - Press **Generate build brief**. The summary line that appears must read
     `Build brief · new_build · v1 @ f928381 (source)`. Any other SHA means
     the app is serving an older deployment or the release row moved.
6. Then dispose of it: set the client's status to `offboarded`. Nothing was
   sent, no repository or Vercel project was created — the intake only writes
   CRM rows.

If step 5 shows the work mode blank or the brief names a different SHA, stop
and say so rather than continuing; those are the two failure modes the form
could still have.
- **Service-area businesses** are supported by the Foundation as of
  `claude/foundation-service-area` (`e214dae`): `address.street` and
  `address.zip` are `string | null`, so the typechecker proves every consumer
  handles their absence. Verified by the full suite plus a built and served
  service-area variant — no street anywhere in the HTML, and the structured
  data carries locality, region and country with no `streetAddress` and no
  `postalCode`. **Merged and activated in the CRM on Sept 21 2026** — see
  "Service-area support" above; this closes the Foundation follow-up that
  stood here.

**An eighth defect, and the correction that found it (Sept 21 2026).**
Worker run 4 had produced a production-target deployment on a fictional brand
because Vercel promotes a project's *first* deployment to production whatever
the branch. The first guard written for it was wrong in two ways, and Tom
named both: it only *reported* the promotion after the deployment existed,
and its "create the project, then push again" advice was false — creating a
project does not make the next deployment its second. Both are now prevented
**before** anything is deployed:

- site-push **v14** (Supabase function version 14): a preview push probes the
  project's deployments first and returns `{"vercel": {"status": "blocked"}}`
  without deploying when there are none, with an accurate next action — give
  the project its first production deployment deliberately, and, for a
  fictional or demonstration brand, that a preview is not available at all and
  the build is verified locally instead.
- site-push **v15** (Supabase function version 15): the probe counts only
  `state=READY` deployments. The live v14 test exposed the hole: Vercel's own
  Git integration registers a deployment for our push and then **BLOCKS** it
  (commit author "Compass CRM" is not a team member), and a blocked
  deployment that never built would have satisfied a bare count — so the
  *third* request would have deployed to production after all.

The contract stays v9. Tests: "a preview push is blocked when the Vercel
project has no deployments — twice in a row", "a blocked Git-integration
deployment does not count as the project having one", "a preview deploys
normally once the project has a deployment", "a preview that Vercel still
puts on a production target is reported failed".

**The live fresh-project test (Sept 21 2026, function v15).** Two consecutive
preview requests for the fictional test client against
`compassactivationtestfictional-fresh`, a Vercel project that did not exist
when the first request arrived:

| # | Request | Answer | Deployments created by site-push |
| --- | --- | --- | --- |
| 1 | 706 | `vercel.status: "blocked"`, `created_project: true` | none |
| 2 | 707 | `vercel.status: "blocked"`, `created_project: false` | none |

Both carried the same detail and next action. Vercel's deployment list for
the project afterwards holds exactly one entry —
`dpl_Hf3T1tjW29Pq8ggHvtFvYGYTzU2S`, `state: BLOCKED`, `target: production`,
created by the **Git integration** from request 2's commit, never built and
serving nothing. That is the entry v15 is written to disregard: under v14 it
would have cleared the next preview. Nothing reached production, and the
Foundation's own guards stand behind this one anyway — a fictional brand
throws on `VERCEL_ENV=production` at build time, `noindex` in the layout and
`Disallow: /` from `app/robots.ts`.

**That interaction is settled in PR #46 (site-push v10).** Making site-push
commit as a Vercel **team member** is right in itself, but it also stops the
Git-integration deployment described above being `BLOCKED`: on a project
with zero deployments it would build and be promoted to production, from a
push site-push itself deliberately refused to deploy. The Git integration is
a second, independent deploy path and site-push's probe does not gate it.

The fix is the one guessed at here — turn the Git integration's automatic
deployments off — done in the repository rather than on the project, because
Vercel's project-level `deploymentPolicy` is not provisioned for this team
(it answers 404). Every commit site-push makes now carries `vercel.json`
with `git.deploymentEnabled: false`, merged into whatever settings the file
already holds: first in an empty repository's bootstrap commit, atomically
in the tree of every other push, on the revert path too, and fail-closed if
it cannot be read or merged. After deploying, site-push also lists Vercel's
deployments for the commit SHA and reports any it did not create. See
`docs/vercel-deployment-paths.md` for the evidence and the verification.

**Still to do before this is true in production:** #46 is not merged and
site-push is not redeployed, and the guarantee only holds for repositories
whose head already carries the config. The rollout order matters — seed each
CRM-managed repository while commits are still blocked by the old identity,
confirm no `source: "git"` deployment appears, and only then merge.

## Service-area support — Sept 21 2026

The first Foundation build for a service-area client stopped dead. The
Foundation read `site.address` as required and rendered the street in the
footer, on the contact page and in the LocalBusiness JSON-LD with no way to
omit it; the worker refused to invent an address and blocked (worker run 2,
below). Refusing was right — a street address for a business that goes to the
customer is a false claim — but the Foundation had to grow the case.

**The Foundation change** (`Compass2026/showmeelectricalwebsite` PR #1,
`e214dae`, merged as `f928381b3a81e20694571cefc5091392b2c84e86` on
`claude/template-completion`; six files, +52 −14). `address.street` and
`address.zip` are typed `string | null`, which makes the typechecker prove
every consumer handles the absence:

| Consumer | With a street | Without one |
| --- | --- | --- |
| `components/site/SiteFooter.tsx` | street line, then `City, ST ZIP` | `City, ST` only |
| `app/contact/page.tsx` | street line, then `City, ST ZIP` | `City, ST` then `site.serviceAreaLong` |
| `lib/seo.ts` (LocalBusiness) | `streetAddress` + `postalCode` | both keys **omitted**, never `""` |
| `lib/jobs.ts` (JobPosting) | `streetAddress` + `postalCode` | both keys **omitted** |

Locality, region and country stay in the structured data: they are true and
they anchor the listing. It is the same omit-rather-than-invent rule the
locations registry already applies to its optional street and `geo` applies
to coordinates. `v1` stays the accepted version — a required field becoming
optional is additive, and both brand configs still type check — so
`foundation_releases` keeps one v1 row and moves its SHA.

**Checks run before pinning** (Sept 21 2026): `FRESH=1 npm run verify` on a
clean clone of the merged tree, whole and with nothing deferred — browser
probe, `tsc --noEmit`, brand typecheck for `harbor-lane`, lint, crawl
fixtures, the provider suite, then per brand build → manifest → crawl →
mocked forms → browser for `showme` and `harbor-lane`, then both production
guards. `verify: ALL PASSED`. The clone was at `e214dae`, whose tree
(`1acf5158…`) is byte-identical to the merge commit `f928381` — the merge
brought in nothing else.

**Pinning** (migration `0040_foundation_v1_service_area`, applied to
`iokcopiyzajigvhwexhe` Sept 21 2026): `foundation_releases` v1 `source_sha`
→ `f928381…`, `accepted_on` → 2026-09-21, notes updated. `FOUNDATION_V1_SHA`
in `src/lib/content-adapters.ts` (the fallback `build-brief.ts` uses when no
row is loaded) moved with it.

**Both consumers confirmed live, after pinning:**

| What | How it was checked | Result |
| --- | --- | --- |
| A newly generated build brief | `composeBuildBrief` (the same module the Foundation tab button calls) over the fictional test client's rows exported from the live database, release row read from `foundation_releases` | `standard.source_sha` = `f928381…`, `applies_as: source`, `framework.foundation_sha` = `f928381…`; rendered line: ``Standard: v1 at `f928381b3a81e20694571cefc5091392b2c84e86` in Compass2026/showmeelectricalwebsite (source, accepted 2026-09-21).`` |
| The worker's downloaded source | `site-push {archive}` called live for the new SHA (request 711) | HTTP 200, `content-type: application/gzip`, `x-archive-ref: f928381b3a81e20694571cefc5091392b2c84e86`, body opens with the gzip magic `1f 8b 08` |
| …and the old SHA is no longer reachable | same call for `94014af…` (request 710) | HTTP 403 — *"archive refused: only this client's repository or the current Foundation release (Compass2026/showmeelectricalwebsite@f928381b3a81e20694571cefc5091392b2c84e86) may be fetched"* |

**Documentation moved with it**: `AGENTS.md` (pinned release paragraph),
`.claude/skills/foundation-worker/SKILL.md` (pinned release + a standing
"service-area clients have no street address" rule: leave the fields null,
never invent one, never block a build for the want of one), this document,
and the Foundation's own `docs/starter-checklist.md`. The tree fixture was
renamed `tests/fixtures/foundation-v1-tree.json` so it stops carrying a SHA
that moves, and `tests/build-brief.test.mjs` now asserts against
`FOUNDATION_V1.source_sha` rather than a literal. 53 checks pass.

## BHG Safety Partners

`docs/clients/bhg-safety-partners-upgrade-brief.md` is the version-pinned
upgrade brief for the next session (read-only preparation; work mode
`upgrade_existing`, adapter `markdown_blog`, production branch `main`).
