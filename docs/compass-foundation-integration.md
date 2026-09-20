# Compass Website Foundation v1 in the CRM

Implemented Sept 20 2026 on `claude/foundation-v1-crm-integration` from the
[accepted handoff](https://github.com/Compass2026/showmeelectricalwebsite/blob/codex/foundation-v1-handoff/docs/foundation-v1-handoff.md)
and the [CRM onboarding review](https://github.com/Compass2026/showmeelectricalwebsite/blob/codex/foundation-v1-handoff/docs/compass-crm-onboarding-review.md).
Accepted foundation code: `Compass2026/showmeelectricalwebsite` @
`94014af35316c94616dadb3f8d606a4b68577fb0`. The three governing Drive
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

`npm test` (Node's test runner, no new dependency) — 43 checks:

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
  tree** (`tests/fixtures/foundation-94014af-tree.json`, from `git ls-tree`
  at `94014af`): the blog registry is `brands/<brand>/content/blog/index.ts`
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

## BHG Safety Partners

`docs/clients/bhg-safety-partners-upgrade-brief.md` is the version-pinned
upgrade brief for the next session (read-only preparation; work mode
`upgrade_existing`, adapter `markdown_blog`, production branch `main`).
