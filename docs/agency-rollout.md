# Agency rollout scorecard, standard 1.0

Control Center > Agency rollout separates a human-reviewed stage from current
marketing health. It uses the existing team authorization and source-evidence
models. It never changes client lifecycle, deliverables, publication approval,
publishing switches, SMS, billing, or portal access.

## Review workflow

Expand a client and its parent/shared or individual brand scope. Record the
agreed requirements, responsible owner, next action and evidence references.
Every scope starts **Not assessed**. Existing receipts and setup counts do not
backfill human acceptance. The other Control Center tabs retain current provider,
queue and setup evidence. Open **Record / update review** to append a review.

- Scoped: every applicability decision, an agreed-scope reference, and at least
  one required item. Optional/excluded items require a decision reference, reason
  and review trigger. Unknown is never automatically excluded.
- Configured: a configuration evidence reference.
- Ready for pilot: all required evidence reviews current, plus explicit review
  that no critical marketing incident remains. The server also re-reads required
  GA4/GSC/GBP provider evidence before advancement.
- Pilot verified: approved keyword through published destination and attributable
  measurement, retained in the pilot-cycle evidence reference.
- Operating: two consecutive completed seven-day delivery cycles with evidence
  references and explicit admin acceptance of the recurring workflow.

Advance one stage at a time. A scope change from Ready/Pilot/Operating requires
returning to Configured or earlier and proving the changed scope. Later incidents
can change health without rewriting the historical accepted stage. Other than
provider checks, these are attributed human attestations, not automated verification
of arbitrary evidence references. The scorecard makes this boundary visible.

## Brand and health rules

Every existing brand gets its own review; parent/shared requirements are separate.
The client stage is the least advanced scope. One approved brand never certifies
its siblings. Shared GBP is reviewed under the parent; a child records the scoped
exclusion and parent decision reference. Brand GA4/GSC uses its exact property.
Provider failure, stale or unknown data overrides manual current evidence. Missing
history, incomplete query counts and unreadable brand inventory fail closed.
Unresolved critical release/site alerts apply conservatively to the client and
brands until reconciled. SMS, billing and portal alerts are outside marketing health.

Current evidence needs a real reference, checked timestamp and explicit expiry.
Expired evidence becomes Attention. Counts show current review evidence over
required review items; this is not an operating percentage. Live provider health
can still degrade the card. A recorded stage is not an authorization to publish.

## Persistence and access

`20261015010455_agency_rollout_reviews.sql` creates one append-only snapshot ledger.
Each client/brand has a monotonically increasing version. The trigger locks the
scope and rejects stale versions, overwrites reviewer/time, enforces scope and
stage rules, and refuses worker/service-role impersonation. Only a signed-in
team member through PostgREST may insert. New Operating acceptance needs admin.
All reads use team RLS. No portal grants/views and no public or service writes.
References are bounded private text, not fetched or rendered as executable links.

No production client reviews are seeded. Review history is retained and visible.
The 3,000-row bounded read checks exact count and shows unavailable if incomplete;
pagination is needed before exceeding that bound, never a silent truncation.

## Verification and release

- `tests/agency-rollout.test.mjs`: stages, expired reviews, provider failure,
  scope changes, BHG-style brand rollup, cross-client isolation, supporting holds.
- `tests/agency-rollout-migration.test.mjs`: real migration and SQL probes in PGlite.
- `supabase/tests/sandbox/agency_rollout.test.sql`: native replay also checks human
  boundary, forged actor/time, portal/anon denial, immutable history and versions.
- Existing Control Center browser suite now covers save/re-render, stale review,
  history failures, filtering and mobile layout against synthetic HTTP data.

Apply the additive migration after passing CI and before releasing the app. Verify
RLS, grants and zero seeded reviews. Rollback the app with the ledger retained;
never delete review history to roll back. Database replay is mandatory.
