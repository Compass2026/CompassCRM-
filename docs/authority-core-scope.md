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
  - **Status and keys always agree:** a channel is `review_plan` exactly
    when it lists `opportunity_keys`, and a `blocked` channel lists none.
  - **`primary`** is the service's primary keyword only when the list
    grounds it. Otherwise it is `null`, `primary_excluded` gives the keyword
    and its reason, and neither `objective` nor `priority` uses it.
  - **An excluded primary is a warning, not a blocker** (`warnings`). The
    service's other approved, verified keywords still plan their channels on
    their own. No keyword is promoted in the primary's place, and the
    service's recorded primary is not changed.
  - **Campaign blockers** stop every channel: a site without an approved
    list, no primary recorded at all, no approved owner page, or competing
    owners. Such a channel lists no keys; an opportunity that would
    otherwise be actionable is in `blocked_by` as `foundation_blocked`.
  - The Authority tab shows "Blocked: <reasons>", "Not usable: <keyword>"
    and the warnings.
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

- **`tests/authority-core.test.mjs`** (pure, 24 tests):
  - 50 approved out of a wider inventory that outranks them;
  - an intent with no usable core keyword;
  - a retired member;
  - a child with and without its parent;
  - proposed-only, missing and no scope (including another client's scope);
  - three brand sites, approved or proposed, including cross-site keywords;
  - holds, stale pages, markets and places named in text;
  - new pages and page improvements;
  - receipts, key stability from proposal to approval, determinism,
    exemption and campaigns;
  - an off-list primary beside an approved, verified supporting keyword
    (the channel plans that keyword only; the primary is not replaced), a
    campaign blocker (no keys, `foundation_blocked`), and a check that status
    and keys agree in every Core 50 state.
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

## Linking a long tail to its core keyword (Nov 20 2026, `20261120190000`, written, not applied)

`core_keyword_grounding()` accepts a keyword that is in its site's approved
list **or** whose `core_parent_keyword_id` is, and every draft gate enforces
it (`core_keyword_required`). Until this migration nothing could set the
parent, so a long tail that plainly serves a core keyword could never ground
a draft. Logic Solar's blog draft on "solar installers wichita ks" is the
case: the approved v2 list has "solar installation wichita ks", with the same
service, city, intent and page.

**The door.** A signed-in teammate uses `keyword_link_core_parent(keyword,
parent, reason)` / `keyword_unlink_core_parent(keyword, reason)`. These are
security definer functions granted to `authenticated` only, and they refuse
anyone `is_team()` does not pass through PostgREST (`not_team`). The worker,
service role, anon and portal contacts are refused too. The UI is the
Keywords tab. Each active keyword outside its site's approved list shows its
current link with an Unlink control, and a "Link to core keyword" form. The
form offers only the parents the database calls eligible
(`keyword_core_link_options`) and needs a reason.

**The rule** (`keyword_core_link_problem`, the first failing check wins):

- Both keywords are this client's and active.
- The parent is in the approved list of the child's site program. The program
  and the list are found exactly as the grounding finds them.
- The child is not in that list.
- The parent has no parent and the child has no children, so links are one
  level.
- Same `service_id`, which is required.
- Same `intent`, which is required.
- City and market are compatible:
  - The parent's `market_id` and `city` must match the child's when the
    parent records them.
  - Every place the parent's text names must be one the child names, in its
    text, city or market (`place_mismatch`). Places are read the way
    `site_program_readiness()` reads them, from the place reference.

The dry run found the reason for the place check: Logic's v2 list has "solar
panels for homes overland park ks" with no recorded city. Without the check
it would have been offered as a parent for a Wichita keyword.

**The audit.** `keyword_core_link_events` gets one row per change: linked,
relinked (with the previous parent) or unlinked. Each row records who, the
keyword texts, the list id and version, and the reason. The table is
append-only (team read-only behind RLS, written only by the two functions),
and a deleted client takes its rows with it. Linking the same parent again
records nothing.

**No other writer.** The `keywords_core_parent_guard` trigger refuses any
insert or update that sets, changes or clears `core_parent_keyword_id`
outside the two functions (`core_parent_link_required`, 42501). That
includes a teammate's direct PATCH and the worker's SQL.

**The gate is unchanged.** Grounding, eligibility and every draft, post and
slot gate read the column exactly as before. A link is judged when it is
made. If either keyword changes later, the gate does not judge the link
again; the Keywords tab shows the link's problem today instead (for example,
a list version that dropped the parent). A retired parent stops grounding on
its own, because grounding needs an active parent.

**Tests.** `supabase/tests/sandbox/keyword_core_parent_link.test.sql` covers:

- every refusal code;
- the options;
- anon, service role, a stranger and the worker;
- a teammate's direct write;
- the reason;
- the audit rows (link, no-op, relink, unlink) and their immutability;
- `core_keyword_eligibility` passing for the linked child (four-argument
  form and blog purpose);
- the down script.

`portal_access.test.sql` A7 / D11o list the two functions. The unit test is
`tests/keyword-core-link.test.mjs`. `npm run test:keyword-core-link-ui`
(real Postgres + PostgREST + `next dev` + Chrome) runs the following as the
signed-in teammate:

- the eligible-only picker;
- the link and its audit row;
- the gate passing;
- the unlink.

**Production dry run (Nov 20 2026, rolled back).** The whole migration ran
in one transaction against the project, followed by a report and a final
`raise`:

- Grants: link, unlink, problem and options are executable by
  `authenticated` only; the caller check and the guard are executable by
  nobody.
- The events table has RLS with the `is_team()` policy, select-only.
- No links existed before the run.
- `keyword_core_link_problem` for "solar installers wichita ks" →
  "solar installation wichita ks" returned null (eligible).
- The Overland Park keyword returned `place_mismatch`.
- The options listed 11 eligible parents for the child, all Wichita, Kansas
  or placeless. Logic's whole options list (105 rows) took 362 ms, and it
  disagreed with the full rule on no pair.
- Calling the RPC as postgres was refused (`not_team`), and so was a direct
  update (`core_parent_link_required`).
- After a simulated link through the function's own write:
  - grounding pointed at list `2cc2d21b` v2 with the core keyword;
  - `core_keyword_eligibility` passed in its four-argument form and for the
    blog purpose; it had returned `core_keyword_required` before;
  - the owner page (`/services/installation`) matched the draft's brief.

**Release.** See the PR. In short: merge, apply the migration through the
Supabase MCP and rename the file to the applied version, and let Vercel
deploy `main`. A teammate then links the Logic keyword on the Keywords tab,
with a reason, and resubmits the draft.

Rollback: `supabase/rollback/20261120190000_keyword_core_parent_link.down.sql`.
Links already made stay on the column and keep grounding.
