# Site-program readiness (Gate B / Gate C)

COMPASS-2027-ROADMAP P1.4a, Executive OS task `81bb73a8`. Migration
`20261029200000_site_program_readiness.sql` (**written, not applied**), data
step `supabase/seeds/place-names-v1.sql`, rollback
`supabase/rollback/20261029200000_site_program_readiness.down.sql`.

`select site_program_readiness('<client uuid>')` returns one JSON report per
client. It has one entry for each site program: each brand site of a
multi-brand client, or else the client itself. It is read-only:

- It is `STABLE`, so PostgreSQL refuses any write inside it.
- It runs as `security invoker` under the caller's RLS.
- It refuses a signed-in non-team user with `42501`; anon has no execute.

It does not replace any existing gate. It shows what the existing gates and
records already say, in one place.

## The gates

- **Gate B: Strategy Ready** (`ready | not_verified | blocked`). It is ready
  only when all of the following hold:
  - The site has an approved Core 50: exactly 50 distinct, active,
    intent-labelled keywords.
  - Every keyword has one usable owner page per `keyword_owner()`. The
    resolver checks holds, the related service, wrong host, a live check within
    45 days, and the structured market.
  - Every place a keyword names is tied to a recorded, approved market of the
    site.
- **Gate C: Content Ready** (`ready | limited | not_verified | blocked`). It
  needs all of the following:
  - Gate B is ready.
  - The site's brand is approved (the brand site for a multi-brand client,
    otherwise the board).
  - The site has an approved service.
  - There are usable claims (confirmed, or sourced with a source).
  - There is reviewed own-work proof.

  - Hold-conflict evidence that can be read: existing content promoting a
    held offering makes it **limited** (`hold_conflicts_open`); evidence that
    cannot be read makes it **not verified** (`hold_conflicts_unverified`).

  Missing proof makes Gate C **limited**, not blocked. Content that needs no
  project proof can still be drafted with accurately labelled assets, and every
  draft's own claim and asset gates still apply. **Gate C is never permission
  to publish.** Approval, destination and receipts stay with the existing
  gates.

**What the gates are not.** Gate B scores the completeness of a whole site's
strategy. It is not a per-draft gate, and a Gate B that is not ready is no
reason to abandon an otherwise valid individual brief: each draft is still
decided by its own keyword gates (`keyword_owner`, eligibility, grounding)
and content gates (review, claims, assets, holds). Gate C is a drafting
evidence signal, never publishing authority.

The "Proposed, not approved" text in `source_ref` is ignored. Approval is
read only from `status` / `approved_at`. When no list is approved, the newest
proposal is evaluated and shown, but its Gate B is always blocked.

## Places named only in keyword text

`keyword_owner()` checks markets only through `keywords.market_id` /
`keywords.city`. A keyword such as "interior designer troy il" with both
fields empty would pass. Here the text is read in SQL.

`core_places_in(text, states, exclude)` matches up to five-word spans against
`place_names`:

- `place_names` holds 21,316 US places from `src/data/us-cities.json`,
  normalized as the Authority engine's `normPlace`.
- The longest span wins.
- The client's and brand's own name words are excluded.

A span counts as a place when any of the following holds:

- **state_named:** the place's own state follows it ("troy il").
- **program_state:** the place is in a state of the client, its active
  locations or the site's markets.
- **major_city:** the place has a population of 100,000 or more ("forklift
  training atlanta").

A small out-of-state town that is also a word ("christmas lights" →
Christmas, FL) does not count.

Each keyword is then judged:

| Geography | Meaning | Gate B |
|---|---|---|
| `structured` | `market_id` / `city` set, and every place in the text agrees | resolver decides |
| `none` | no place in the text, nothing structured | ok |
| `text_only` | the text names an approved market of the site; the keyword has no `market_id` / `city` | **not_verified** (`place_text_only`) |
| `without_market` | the text names a place that is not an approved market, including a held or excluded one | **blocked** (`place_without_market`) |
| `mismatch` | the text names a place other than the structured city / market | **not_verified** (`place_mismatch`) |
| `unassessed` | the place reference is not place-names-v1 exactly (see below) | **not_verified** (`geography_unassessed`) |

The check fails closed. `place_reference_status()` accepts only
**place-names-v1 exactly**: the migration pins its version, source sha256
(`baa021df…`), row count (21,316) and the md5 of its rows
(`f45e381b…`, "norm|state|name|population" lines in byte order). It
recomputes the count and digest on every report. Anything else is not ok, and
every keyword is then `unassessed`, with the problem named in the report:

- `missing`: nothing is loaded.
- `partial`: fewer rows than the reference.
- `extra_rows`: rows beyond it.
- `rows_mismatch`: same count, altered rows.
- `source_mismatch`: no source row, or another one.

The seed is all or nothing. One block inserts whatever is missing, then
requires `place_reference_status()` to be ok, or raises so that nothing is
kept. Re-running it is a no-op, and it completes a partial load. It refuses an
altered or extended reference, and that reference stays exactly as it was.
`tests/site-program-readiness.test.mjs` holds the migration's constants to the
generator's output.

Checked against the 673 live list keywords on Oct 29 2026 (scratch, read-only;
no client data is committed). Expected results once the migration and seed
are applied:

- **Lucas v2:** 14 Wentzville keywords are text-only (Wentzville is the
  office market), and "christmas light installation st louis" names St. Louis,
  which is not a recorded market. Gate B **blocked** until a person records
  St. Louis or replaces that keyword, and sets `market_id` on the 14 others.
- **Logic v2:** 3 keywords name Wichita or Overland Park only in their text.
  Gate B **not verified**.
- **Ginger v1:** 32 keywords name places (Edwardsville, Troy, Glen Carbon,
  Clayton MO, …) with no structured market. Gate B **blocked**.
- **BHG:** the nine Forklift city keywords are structured (`city`), so the
  resolver's own `market_unverified` / `keyword_wrong_page` apply. Gate B is
  **blocked** in any case, because all three lists are proposals.

## Client-wide evidence

`claims` and `brand_assets` carry no site. For a multi-brand client (BHG):

- Both are reported with `scope: "client"`.
- The site-level figures (`site_usable`, `site_own_work_approved`) are
  `null`, never a count.
- Gate C reads `claims_client_scope` (not_verified) and `proof_client_scope`
  (limited).

P0.3 (`11454716`) designs site-scoped claims and proof. This check only
refuses to pretend.

## Other figures (reported, not gating)

- `owner_pages`: live, stale (more than 45 days), unchecked or not live, and
  concentration (`top_share`; one page owning at least half the list is the
  `owner_concentration` warning, an audit note, not a call for more pages).
- `owners.blog`: the supply for new articles (`blog_supply_low` when below 8).
- `markets`, `holds.active`.
- `holds.open_conflicts_client` / `open_conflicts_by_kind` come from
  `promotion_hold_conflict_counts()`, a team-readable twin of
  `promotion_hold_conflicts()`. The original cannot be run by a signed-in
  teammate: it calls `content_draft_program()` and
  `content_draft_hold_text()`, which `20261029013051` deliberately keeps
  from `authenticated`.
  - Rather than widening those grants, the twin inlines the two bodies
    verbatim. It runs under the caller's RLS and returns counts only.
  - The sandbox proves the counts equal for every kind (posts, drafts,
    articles, planned slots).
  - The suite pins the md5 of the three canonical definitions; they match
    production on Oct 29 2026. A later change to any of them fails CI until
    the twin is reviewed.
  - If the twin is ever unreadable, the figure is `null` and Gate C is not
    verified. The migration's verify block also refuses to apply if either
    helper has become executable by `authenticated`.
  - The counts are client-wide, since posts and drafts carry no reliable
    site.
- `authority`: the last run, its age, and whether it predates the list's
  approval. Authority is client-wide and not core-aware (P1.3).
- `onboarding`: counts by status for the client-level and site-level rows.
  Content Ready is not Onboarding Complete.
- `claims_no_review_date`: claims record no expiry yet (W1).

## Receipt

```bash
node --no-warnings scripts/site-program-readiness.mjs --file report.json
```

This renders a saved report, for example a JSON export of
`select site_program_readiness('<uuid>')`. With `SUPABASE_URL`,
`SUPABASE_ANON_KEY` and a teammate's `SUPABASE_ACCESS_TOKEN` it calls the RPC
instead. Wording: `src/lib/site-program-readiness.ts`. Unknown values print
as NOT VERIFIED.

## Tests

- **`supabase/tests/sandbox/site_program_readiness.test.sql`**: native in
  `scripts/test-portal-sandbox.sh`, and in PGlite in
  `tests/site-program-readiness-database.test.mjs`. It covers:
  - the place matcher, and the seed loading idempotently;
  - per-site gates, including a stale 46-day check, a held keyword, a
    49-keyword proposal, and missing rows (nulls, not 0);
  - text-only, unrecorded, excluded and mismatched places;
  - BHG-shaped isolation, including one site's approval changing only that
    site;
  - client-wide evidence;
  - purpose verdicts equal to direct `keyword_owner()` calls;
  - anon, non-team and team access;
  - zero rows changed;
  - BHG-shaped timing (3 × 50 core plus 300 supporting terms: about 1.5 s
    locally, limit 10 s);
  - the reference empty, partial, completed by the seed, re-applied, altered,
    extended and from another source, and the seed refusing an altered
    reference with nothing kept;
  - hold-conflict counts equal to the original for every kind, known
    conflicts → limited, an unreadable twin → not verified on an otherwise
    ready site, and the definition tripwire;
  - the down script and a re-apply.
- **`tests/site-program-readiness.test.mjs`**:
  - The seed matches its generator byte for byte.
  - The normalizer equals the engine's.
  - Every emitted code has wording.
  - The rendering never shows an unknown as 0 or an unready gate as READY.

## Data corrections are separate (not in this PR)

The checks against live keywords show what will read not green. Fixing that
is a data step, each with Tom's own decision:

- **Lucas.** Do not assume St. Louis is a market. Show Tom the eligibility
  evidence, separating a served metro from a branch. Then either record the
  exact market or submit a revised keyword for list approval. The 14
  Wentzville keywords each need their exact market link, never a blanket
  update.
- **Logic.** The 3 text-only keywords are reconciled to the approved site
  markets one by one before any change. The Overland Park GBP hold and the
  Austin exclusion do not change.
- **Ginger and BHG.** List research stays with the Authority rollout
  (`3ab519f3`). Nothing here approves a list or creates a location page.

## Release (only with Tom's words)

1. Apply the migration through the Supabase MCP. Rename the file to the
   applied version and record its md5.
2. Run `supabase/seeds/place-names-v1.sql` once as the owner, then confirm
   `select place_reference_status()->>'ok'` is `true`. A refusal leaves
   nothing behind.
3. Read-only: run `select site_program_readiness(id)` for Lucas, Logic, Ginger
   and BHG, and compare with the P0.2 audit (`b4a63aa2`, result `4587c2ae`).

Nothing needs deploying. Rollback is the down script.
