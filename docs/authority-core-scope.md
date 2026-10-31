# Core 50-aware Authority input (P1.3)

COMPASS-2027-ROADMAP P1.3, Executive OS task `c1fbff44`. Migration
`20261030190000_authority_core_scope.sql` (**written, not applied**), rollback
`supabase/rollback/20261030190000_authority_core_scope.down.sql`, engine
`authority-v1.5` (`supabase/functions/authority/core.ts`).

The Authority rollout (`3ab519f3`) still owns:

- weekly cadence and the calendar;
- destinations and client activation;
- the draft workers;
- publishing;
- the BHG and Ginger list research.

This change owns only the opportunity input.

## The problem

`authority_input()` hands the engine every keyword the client has. Lucas has
112 active keywords, of which 50 are the approved v2 list; BHG has 202 across
three brand sites with no approved list. The engine could therefore call an
off-list, retired or other-brand keyword a **Ready** Business Profile post.
The draft gates refused such a post later, but discovery itself was
client-wide.

## What changes

The changes are read-only and additive:

- **`authority_core_scope(client)`** gives one answer per site program (each
  brand site of a multi-brand client, or else the client):
  - **The list.** The approved Core 50: its id, version, approval time and
    sorted keyword ids. If there is none, `status` says why:
    `proposed_only` (with the newest proposal's id, version and count) or
    `missing`. A proposal newer than the approved list is shown and never
    used.
  - **The keywords in scope.** Every active keyword the approved list grounds
    is listed with three verdicts:
    - **Grounding:** `core_keyword_grounding()` itself decides. A keyword is
      grounded as a list member (`core`) or as an active child whose active
      core parent is a member (`child`).
    - **Owner:** `keyword_owner()` itself, for `post`, `blog` and
      `refresh`. That covers holds, the service, the wrong host and site,
      page checks within 45 days, markets and roles.
    - **Geography:** the places its text names, read with
      `core_places_in()` over `place_reference_status()`, exactly as
      `site_program_readiness()` reads them.
  - **Counts:** `active_keywords`, `off_list`, `exempt` and the place
    reference status.
- **`authority_input_scoped(client)`** is `authority_input()` with
  `authority.core` set to the scope above. `authority-run` reads this one.
  **`authority_input()` is unchanged** (md5 `22629a4e…`, checked by the
  migration's verify block) for every other caller.
- **`authority_fingerprint(client)`** gains a `core` section. It hashes the
  lists, workspaces, the keywords' core fields, markets, holds, the exemption
  and the latest owner check, so approving a list or recording a market marks
  the latest run stale (`authority_latest.stale_sections`). The function is
  patched in place on its exact 0048 definition (md5 `308d6200…`); any other
  definition refuses the migration.

## What the engine does with it (`core.ts`, `opportunities.ts`, `campaigns.ts`)

`coreVerdict(input, keyword, service, purpose)` resolves the service's site
program (exactly one brand site for a multi-brand client) and then refuses
with a code. Nothing falls back.

| Code | Meaning |
|---|---|
| `core_scope_missing` | No scope, the wrong schema, or another client's scope |
| `program_unresolved` | The service is on no single brand site |
| `core_list_not_approved` / `core_list_missing` | The site has no approved list |
| `keyword_not_core` | The approved list does not ground the keyword |
| `keyword_wrong_program` | Another site's list grounds it |
| `keyword_wrong_service` | The keyword's related service is another service |
| resolver code | `promotion_held`, `page_not_verified`, `market_unverified`, `keyword_wrong_page`, `owner_role_not_allowed`, … |
| `page_absence_unverified` | New service page only: the owner page exists but is not proven missing |
| `place_text_only` / `place_without_market` / `place_mismatch` / `geography_unassessed` | A place named in the text with no structured, approved market of the site |

An exempt client (Tom's recorded exemption) passes, labelled `exempt`. The
database's own core gates skip it too.

### Business Profile posts (the only Ready content)

- For each service and intent the target is the best keyword that passes the
  Core 50 check.
- If none passes, the engine takes the best keyword anyway and blocks the
  opportunity (`blocked_data_prerequisite`), with:
  - a failing `core_keyword` gate;
  - a `drafter_brief` gate that is not attempted;
  - the code as a blocker.
- The drafter handoff (0053) accepts only `ready` / `create`, so a blocked
  opportunity can never reach it.

### Other opportunity types

- **New service page** (`service_page` `create`): its keyword must be
  grounded, and the page must provably not exist. That means either no page
  claims the keyword, or the owner page's latest check is a real 404 (verdict
  `missing`).
  - The scope carries that check (`owner.check`), read as `keyword_owner()`
    reads it: an http `soft_404` defers to the latest rendered check.
  - An existing page that is unchecked, older than 45 days, `unreadable`,
    `redirected`, `wrong_host` or an unresolved `soft_404` reads
    `page_absence_unverified`: check it first, never re-create it.
  - A hold or the wrong site refuses with its own code.
  - The exception covers new pages only; every other purpose keeps the
    resolver's code.
- **Page improvement:** the fix stays, but an off-list keyword is dropped as
  its target, with a reason. The fix may only correct or remove wording.
- **Unapproved list:** each site with no approved list gets one
  `core_list:<program id | client>` decision (`requires_confirmation`) that
  names the proposal. If there is no scope at all, one
  `core_list:scope` blocker appears instead.

### Campaigns, keywords and the run

- **Campaigns** keep two sets apart:
  - **`cluster`** is grounded membership, for reporting. Each entry's `post`
    is `null` when a Business Profile post may target it now, or else the
    code that stops it. Keywords outside the list are in `excluded` with
    their code.
  - **`opportunity_keys` and `review_plan`** come from actionable
    opportunities only: tier A–C (a content action whose every gate passed,
    cadence aside) and no Core 50 refusal.
  - A channel whose opportunities all exist but cannot proceed is `blocked`,
    with `blocked_by` listing each key and its reason. One usable keyword
    still plans its channel; the blocked ones are listed, not hidden.
  - **`primary`** is the service's primary keyword only when the list
    grounds it. Otherwise it is `null`, `primary_excluded` gives the keyword
    and its reason, a blocker names it, and neither `objective` nor
    `priority` uses it.
  - A site without an approved list is a campaign blocker.
  - The Authority tab shows "Blocked: <reasons>" and "Not usable: <keyword>".
- **Receipts:**
  - Every keyword-targeted opportunity carries `core`: purpose, program,
    list id and version, keyword, relation, core parent, owner URL and role,
    market, geography, verdict and detail.
  - The report carries `core`: per program the status, list id, version,
    sorted keyword ids, proposal and counts, plus `refused` counts.
  - Every keyword carries `core.status`: `core`, `child`, `off_list`,
    `no_approved_list`, `exempt` or `not_loaded`.
  - All of it is stored in the immutable `authority_runs.report`.
- **`authority-run`:**
  - It reads `authority_input_scoped`.
  - An input without `authority.core` fails the run before the site is
    fetched, so no opportunity changes are recorded.
  - Otherwise it is unchanged (version, modes, lock, fingerprint before
    input, one `authority_record_run`).

**Opportunity keys do not change.** `gbp_post:<service>:<intent>`,
`service_page:<service>` and the other keys stay what they were, so a re-run
updates the same `authority_opportunities` rows (a `section_changed` event),
and never duplicates them. Existing runs, opportunity rows, links, drafts,
approvals, posts and publications are untouched. The migration rewrites no
row, and `tests` prove the down script and a re-apply leave run history
byte-identical.

## Cost

`authority_core_scope()` calls `keyword_owner()` once per in-scope keyword
(list members and their children only; off-list keywords cost nothing). The
resolver compares each keyword with the client's whole active inventory
(its equivalent-row check), so the cost is in-scope × inventory. This is the
same cost `site_program_readiness()` already pays. Measured read-only on
production on Oct 30 2026:

- BHG: 204 keywords resolved in 619 ms.
- Lucas: 112 keywords in 247 ms.

The sandbox's BHG-shaped case (204 active, 180 in scope) has a 10 s limit.
The fingerprint's `core` section reads source rows only, so
`authority_latest` does not pay this cost.

## Gate B is not a blanket blocker

This is per keyword. A site whose Gate B is not ready (for example Lucas's
14 Wentzville keywords with no `market_id`) still gets Ready opportunities
for every approved keyword that passes on its own: owner, market and place,
an unheld service. Gate B stays a report (`site_program_readiness()`), and
every draft's own gates still decide each draft.

## Expected effect once applied (from the live data on Oct 30 2026; nothing has been run)

- **Lucas v2, Logic v2:** only the 50 approved keywords (and their children;
  there are none today) can be targets.
  - **Lucas:** the 14 text-only Wentzville keywords and "christmas light
    installation st louis" are blocked (`place_text_only` /
    `place_without_market`) until each has its market link or a decision.
  - **Logic:** the three text-only Wichita / Overland Park keywords are
    blocked (`place_text_only`). A keyword linked to one market that names
    the other reads `place_mismatch`, so Wichita and Overland Park never
    credit each other. The Overland Park GBP hold and the Austin exclusion
    are unchanged.
- **Ginger** (a v1 proposal), **BHG** (49 / 46 / 28 proposals) and every
  other client with only a proposal get nothing Ready. Each has one
  `core_list:` decision per site naming the proposal.

## Tests

- **`tests/authority-core.test.mjs`** (pure, 16 tests):
  - 50 approved out of a wider inventory that outranks them;
  - an intent with no usable core keyword;
  - a retired member;
  - a child with and without its parent;
  - proposed-only, missing and no scope (including another client's scope);
  - three brand sites, approved or proposed, including cross-site keywords;
  - holds, stale pages, markets and places named in text;
  - new pages and page improvements;
  - receipts, key stability from proposal to approval, determinism,
    exemption and campaigns.
- **`supabase/tests/sandbox/authority_core_scope.test.sql`** (native in
  `scripts/test-portal-sandbox.sh`, and in PGlite in
  `tests/authority-core-database.test.mjs`, which then feeds
  `authority_input_scoped()` to the engine):
  - v2 approved with v1 and v3 proposals (no version confusion);
  - scope = `core_keyword_grounding()`, and verdicts =
    `core_keyword_eligibility()` per purpose;
  - a hold, a 46-day-old check, structured, mismatched, text-only, missing
    and excluded markets;
  - a Ginger-shaped proposal and a client with no list;
  - three BHG-shaped sites, 49 / 46 / 28, then one approved: only its own
    keywords, never a cross-site row or a wrong-host keyword;
  - the scoped input = the unchanged input + core;
  - the fingerprint and `authority_latest` staleness: approval changes only
    `core`, and returning to v2 is idempotent;
  - exemption, anon / non-team / team access, and no writes;
  - BHG-shaped timing;
  - the down script and a re-apply with run history unchanged.
- **`tests/authority-run-handler.test.mjs`:** a scope-less input fails the
  run (no inventory, record only `failed`); a scoped run records the
  receipts.

## Release (only with Tom's words; nothing here is applied, deployed or run)

1. Apply the migration through the Supabase MCP (its verify block checks
   both definitions). Rename the file to the applied version.
2. Read-only: `select authority_core_scope(id)` for Lucas, Logic, Ginger and
   BHG, and compare with the expected effect above.
3. Deploy `authority-run` through `deploy-supabase-function.yml`, then check
   `{"mode": "version"}` says `authority-v1.5`. The function reads
   `authority_input_scoped`, so step 1 must come first. An old function
   against the new database is harmless (it still reads `authority_input`).
4. Any Authority run is a separate authorization.

Rollback: deploy the previous `authority-run`, then run the down script.
