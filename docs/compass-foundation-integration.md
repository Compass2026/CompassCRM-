# Compass Website Foundation v1 in the CRM

Implemented Sept 21 2026 on `claude/foundation-v1-crm-integration` from the
[accepted handoff](https://github.com/Compass2026/showmeelectricalwebsite/blob/codex/foundation-v1-handoff/docs/foundation-v1-handoff.md)
and the [CRM onboarding review](https://github.com/Compass2026/showmeelectricalwebsite/blob/codex/foundation-v1-handoff/docs/compass-crm-onboarding-review.md).
Accepted foundation code: `Compass2026/showmeelectricalwebsite` @
`94014af35316c94616dadb3f8d606a4b68577fb0`. The three governing Drive
originals are listed in `foundation_releases.documents` (migration 0036).

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
| Stage wording | "Confirm the stack and record the site row (Astro, …)" | Migration 0036 rewrites the Website stage description and the Discovery / Build task titles; open tasks on not-started stages pick the wording up |

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

From the Foundation at the pinned SHA: `npm run typecheck`,
`COMPASS_BRAND=<brand> npx next build`, `npm run qa:manifest`, `npm run
qa:crawl -- <preview> --host <production host> --assets remap`; with a
Chromium (`scripts/qa/browser-launch.mjs --check`) also the mocked forms
suite and the browser suite; without one they are recorded as deferred,
never as passed. `FRESH=1 npm run verify` remains the documented
clean-checkout recipe for a human or a session with a browser. Results are
builder-reported; the brief keeps "independent review" empty until someone
else records it.

## Tests

`npm test` (Node's test runner, no new dependency):

- `tests/site-push-plan.test.mjs` — new build on an empty repo (main,
  production, nextjs); no-row insert never astro; client-retains refused;
  **non-main production branch** (`production`): preview created from it,
  PR base `production`, branch of record unchanged; upgrade push at the
  branch of record refused unless named; authorised entry deploys to
  production; `preview: true` auto-naming; repo default branch as baseline;
  foreign-author full build → side branch; archive allow-list.
- `tests/content-adapters.test.mjs` — Foundation / Lucas JSON / Markdown /
  unknown trees each resolve to their adapter; unknown → proposed documents
  for every kind; JSON into typed content refused; locations registry
  protected; verification declared per adapter; SHA pinned.
- `tests/build-brief.test.mjs` — new-build brief is v1-pinned with the
  Foundation adapter; city gate (coverage + evidence → planned, else
  candidate); unverified claims not usable; client-retains brief has no
  push; upgrade with `production` branch keeps branch, framework and
  Vercel project and plans a preview; Markdown rendering; preview outcome
  attaches to the work records.

The edge function itself was type-checked against a Deno shim
(`tsc` with `Deno` declared); it was not executed against GitHub or Vercel
in this pass.

## Activation (what turns each part on)

Code on the branch does nothing to the running system until these steps.

1. **Review and merge** `claude/foundation-v1-crm-integration` into `main`.
   Vercel deploys the CRM app from `main` (project `compass-crm`): the
   intake radio, the Foundation-tab work mode, adapter, preview branch and
   build-brief card go live with that deployment. They read columns from
   step 2, so **merge after the migration is applied** or the Foundation
   tab errors on the missing columns.
2. **Apply migration 0036** to `iokcopiyzajigvhwexhe` through the Supabase
   MCP (`apply_migration`), the way earlier migrations were applied. Adds
   `website_work_mode`, the site columns, `foundation_releases` (with the v1
   row), rewrites the Website stage / task wording, backfills work modes
   (client-run → `client_retains`; Tom's pushed Next.js sites →
   `upgrade_existing`). No client rows are otherwise touched.
3. **Deploy `site-push`** (v9) from `supabase/functions/site-push/` (the
   dashboard or `supabase functions deploy site-push`). Until then the
   deployed function keeps the old branch logic; the worker instructions
   that send `preview: true` / `archive` would get 400s from the old
   version, which the skill treats as a blocker, not a fallback.
4. **The Routine picks up the skill on its next fire**: `.claude/skills/
   foundation-worker/SKILL.md` is read from the attached repo at session
   start, so the merge is the activation. Confirm the Routine's source is
   `main` (or point it at the branch for a trial run on one client by hand
   with `/foundation-worker <client>`).
5. **Per client**: set the work mode on the Foundation tab for existing
   clients where the backfill left it null (Shewmaker; any site never
   pushed), press *Generate build brief*, read `missing_inputs`. For a new
   client the intake radio records it.
6. **Optional, later**: Vercel deployment protection on client previews
   (a login is needed to view an `upgrade_existing` preview today), a
   Chromium in the Routine environment (so forms / browser checks stop
   being deferred).

Nothing in this branch applies migrations, deploys functions, enrolls
clients, runs the Routine, publishes a site, changes DNS or sends messages.

## BHG Safety Partners

`docs/clients/bhg-safety-partners-upgrade-brief.md` is the version-pinned
upgrade brief for the next session (read-only preparation; work mode
`upgrade_existing`, adapter `markdown_blog`, production branch `main`).
