# Client workspace review

## Current implementation

The team-only `/clients/{clientId}/workspace-preview` route renders a reusable lead dashboard using that client's authorized inquiry records. It does not change the live client portal.

Included: responsive overview, status and website summaries, combined search/status/website filters, inquiry detail, existing follow-up controls, internal notes and activity. The latest 200 records are loaded; an exact total and a visible limit notice avoid representing a capped list as the complete dataset. Recorded URL hosts are display labels only, not trusted intake-source attribution.

Notes and status changes use existing server actions and database authorization. The preview explains that those edits save to the CRM. Selected inquiry IDs are scoped to the route's client. There is an explicit team-membership check in the route as well as the existing application layout.

Email and SMS tabs demonstrate the proposed composer but cannot send. Drafts are memory-only, separated by inquiry and channel, with their temporary nature explicitly labelled. No provider state, conversations, revenue, unread counts or reply history is fabricated.

## Messaging implementation remaining

Extend existing Communications and contacts. Do not build a second SMS transport. Add minimal client-scoped portal projections, explicit portal-author attribution and authorization at send time; keep provisioning and consent administration restricted to the team. Preserve existing consent, opt-out, verification, idempotency and signature checks.

For mailbox email, add a separate client-owned OAuth connection. The existing agency-wide Google operations refresh token is not a client mailbox connection and must not be reused or overwritten. Bind expiring single-use OAuth state to the actor/client, verify the expected mailbox, store tokens only server-side, and check the provider's required scopes/verification before activation.

Import only explicitly associated lead threads, not unrelated personal email. Store provider thread/message identifiers, reconcile ambiguous sends before retries, synchronize received replies, and keep internal notes separate. Durable per-thread/per-channel drafts are required before client launch.

Docs: https://developers.google.com/workspace/gmail/api/auth/scopes and https://developers.google.com/workspace/gmail/api/guides/sync.

## Release acceptance

This branch is a review interface, not a completed messaging backend. Before client rollout, test mobile and desktop interactions, two-client isolation, inactive users, disabled channels, deduplication, failed/uncertain sends and received replies. Use controlled test recipients only. Preserve existing client access while development continues. Client-specific operational decisions belong in the private work tracker, not this repository.

Validation performed: production build, TypeScript check, lint (existing warnings only), and focused workspace/intake/invitation tests. Visual browser review and actual email/SMS send-and-reply tests remain outstanding.
