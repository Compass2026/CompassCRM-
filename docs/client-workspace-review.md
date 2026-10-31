# Client workspace review

## Current implementation

The team-only `/clients/{clientId}/workspace-preview` route renders a reusable lead dashboard using that client's authorized inquiry records. It does not change the live client portal.

Included: responsive overview, status and website summaries, combined search/status/website filters, inquiry detail, existing follow-up controls, internal notes and activity. The latest 200 records are loaded; an exact total and a visible limit notice avoid representing a capped list as the complete dataset. Recorded URL hosts are display labels only, not trusted intake-source attribution.

Notes and status changes use existing server actions and database authorization. The preview explains that those edits save to the CRM. Selected inquiry IDs are scoped to the route's client. There is an explicit team-membership check in the route as well as the existing application layout.

Email uses the mailbox connection, durable drafts and conversation workflow described below. SMS remains an explicitly disabled preview. No provider state, conversations, revenue, unread counts or reply history is fabricated.

## SMS implementation remaining

Extend existing Communications and contacts. Do not build a second SMS transport. Add minimal client-scoped portal projections, explicit portal-author attribution and authorization at send time; keep provisioning and consent administration restricted to the team. Preserve existing consent, opt-out, verification, idempotency and signature checks.

## Release acceptance

This branch is a review interface with mailbox email, not a completed client release. Before client rollout, finish controlled send/reply verification and mobile checks. Use controlled test recipients only. Preserve existing client access while development continues. Client-specific operational decisions belong in the private work tracker, not this repository.

Validation performed: production build, TypeScript check, lint (existing warnings only), and focused workspace/intake/invitation tests. Desktop browser review passed. Actual email/SMS send-and-reply tests remain outstanding.

## Mailbox connection and lead email

The review branch now includes `client-mailbox` and an authenticated same-origin
`/api/client-mailbox` proxy. The mailbox is configured per client by an admin.
Connecting requests only Google identity, Gmail send and Gmail read-only scopes.
A `mailbox.` state prefix routes the existing registered `google-connect`
callback into the separate mailbox handler; the agency OAuth behavior and
`GOOGLE_OPS_REFRESH_TOKEN` are unchanged. OAuth application credentials are
reused, but each client grant gets its own Vault secret reference. No refresh
or access tokens reach the browser, database projections, responses or logs.

The single-use, ten-minute state record binds actor, client, PKCE verifier,
connection generation and an exactly allowlisted return origin. Both the start
and callback check active actor/client access. Callback checks the actual Gmail
profile against the configured email and requires send/read scopes. A new
generation prevents late callbacks from overwriting a newer connection.
Google app verification or Workspace policies can still block consent.

All new tables deny direct anon/authenticated access. The function authenticates
the user's JWT and checks team membership or that client's active portal user,
CRM enabled settings and client status on every request. The portal's existing
scoped inquiry views remain unchanged. Tokens and OAuth state have no portal
projections. Two service-role-only functions atomically consume OAuth state and
reserve a send; neither is executable by a browser role.

Drafts are durable, private per actor/inquiry, and explicitly saved. A saved
revision is the send idempotency key. The recipient is resolved from the scoped
inquiry and pinned to its conversation. Changed recipients require assistance.
A conversation lock serializes reservation; uncertain sends block new sends.
The receipt is stored before Gmail is called. Gmail acceptance is labelled
“Sent to Gmail,” never delivered/read. Transport timeouts and provider 5xx
responses remain uncertain; Refresh replies reconciles by the exact RFC
Message-ID before any resend can occur. No automatic retry sends.

Replies use Gmail's thread ID plus RFC reply headers. Refresh retrieves only
threads started from a CRM inquiry and accepts participants matching the lead
or connected mailbox. It never enumerates the mailbox inbox. Only plain text
is rendered; HTML-only messages refer the user to Gmail for formatting and
attachments. Attachments and automatic background synchronization are not
included. The conversation shows its most recent 200 messages.

Release steps: apply `20261031151105_client_mailbox.sql` after database checks;
deploy client-mailbox with internal JWT authentication (gateway verify_jwt off
for its state-protected callback), then the google-connect callback router with
its existing verify_jwt=false setting; configure the pilot's expected mailbox
and exact trusted origins privately; deploy the review branch. The live portal
is not replaced before mailbox consent and a controlled send/reply test. SMS
transport and production outbound settings are unchanged.

Tests cover cross-client/inactive/unauthenticated requests, wrong Google account,
header injection, required scopes, callback origin validation, single-use state,
real PostgreSQL table/function privilege denial, send reservation/replay and
ambiguous send behavior. Live send/reply remains pending mailbox authorization.
