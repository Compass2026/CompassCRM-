# Operational evidence and onboarding expansion

This extends the existing Control Center. A Delivery & work tab now includes
six operational cards per client: rankings, backlinks, social publishing,
CRM Lite notification delivery, billing reconciliation, and website mappings.
Every card has its evidence, recorded attempt/evidence dates and an existing
workflow link. All reads use the signed-in team's RLS session and exact-count
completeness checks. Unknown is never converted to zero. No dashboard mutation,
provider request, credential read or new database object is introduced.

## What each source proves

- Rankings require current organic and map observations for every tracked keyword,
  plus a completed run with checks. Fourteen days matches the existing Progress
  view. A null position with a check date means not found, not unchecked.
- Backlink profiles match each client/brand host and DataForSEO observation scope.
  A completed job alone is insufficient. Weekly evidence expires after eight days.
  Partial history is visible even when summary counts succeeded. Placement checks
  expire after thirty days; latest checks supersede previous missing-link results.
  Due follow-ups exclude closed work. Research creates a review reminder, not outreach.
- Social reviews link to individual posts. Failed, overdue and interrupted delivery
  requires review. Future schedules and published records do not become failures.
  Provider IDs/URLs establish recorded publication, not a new live URL probe.
- CRM Lite distinguishes provider-confirmed delivery from sent/accepted. Blocked,
  failed, unknown and overdue attempts remain visible. No SMS is enabled or sent.
- Billing uses only live client-scoped reconciliation receipts and a two-day daily
  check threshold. Latest clean recovery supersedes historical failures. A healthy
  mirror is not a paid subscription, signed agreement or authorization to charge.
- Website cards state mapping completeness and last push. They explicitly do not
  label a code push as a READY deployment or live page verification.

## Onboarding

Approved services, confirmed claims, keyword intent/service/owner-page mapping and
brand website destination ownership are checked per brand, preserving BHG's three
websites. Claims awaiting confirmation remain waiting. Missing source reads remain
unknown. Recent Authority inventory is a separate evidence check, not approval to
produce or publish content. A dated measurement is an observed reporting baseline,
not necessarily a baseline from before Compass engagement.

Existing brand, intake, reporting, subscription and portal checks remain. Evidence
is not a package entitlement and cannot replace human approvals or consent. Full
activation still requires external account permissions and deliberate SMS, billing
and portal rollout. No messages, invitations, charges or publishing are performed.

Blog queue alerts now use scheduled time, and a newer published version of the same
draft safely supersedes an older blocked/uncertain release. Different clients or
drafts cannot clear each other's incidents.

## Validation

Unit tests exercise missing data, actual observation coverage, exact backlink host
scope, recovered placements, social review links, future schedules, recovered
publications, accepted versus delivered notifications, live/test billing isolation,
and brand-scoped onboarding. The real Next route browser test verifies operational
cards and social approval navigation, filtering, failed/capped reads and no writes.
Full CI includes native database/RLS, application/billing and all browser gates.
