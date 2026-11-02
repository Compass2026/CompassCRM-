# CRM Lite lead workspace

The portal `/portal/inquiries` and team review route
`/clients/{clientId}/workspace-preview` share a responsive lead dashboard.
Enable `crm_lite_settings.workspace_enabled` for each reviewed client; other portals keep their existing inquiry screen.
It shows real inquiries, filters, status, original messages, internal notes,
and per-lead communication. Counts describe the loaded records, with a visible
notice when the newest 200 records do not represent the whole list.

## Email

Resend is the selected transport for lead email. Each client has a verified
sender and receiving subdomain, with server-only configuration in
`client_mailboxes`. Existing ordinary mailbox MX records stay unchanged.
Google mailbox connection is unnecessary for Resend clients; legacy agency
OAuth and existing client access are preserved.

`client-mailbox` authenticates each request and checks active client status,
CRM settings, team membership or the exact client's active portal membership.
Drafts are private to the actor. The saved revision reserves one send in a
transaction before calling the provider. Unknown outcomes block new sends;
there is no automatic resend. Resend also receives an idempotency key.
Recipients come from the authorized inquiry, never a browser-supplied address.

A random per-thread reply token and receiving domain route replies.
`client-email-webhook` verifies the raw payload with the official Svix SDK,
checks the lead participant and receiving domain, then retrieves the email
body. The body is plain text, never HTML or executable instructions. Webhook
receipts and message changes commit atomically; repeated and out-of-order
callbacks do not downgrade delivery or remove a bounce/complaint suppression.
The UI distinguishes provider acceptance from actual delivery.

Receiving needs an API key with permission to retrieve received email, not a
sending-only key. Store it as `CLIENT_RESEND_RECEIVING_API_KEY` in Vault; the sender uses its domain-scoped key referenced by `api_key_secret`. Store the
webhook signing secret as `CLIENT_RESEND_WEBHOOK_SECRET`. Keep `resend_ready`
false until DNS, receiving permission and a controlled round trip are checked.
The current composer supports plain text. Attachments are not displayed.

## Text messages

`client-phone` reuses the existing Communications transport and signed Twilio
callbacks. `client_phone_begin_sms` is a service-only reservation function,
separate from the existing team send function. It resolves the inquiry's
contact, verifies the real actor and client, requires carrier approval and
recorded consent, and applies the existing STOP/START rules. Portal users do
not gain provisioning, consent administration or base-table permissions.
Saved text drafts are actor-private and deduplicated by revision. The SMS
history is shared across inquiries for the same client contact.

## Calls

The Voice SDK loads only when the user connects the phone. Access tokens are
short-lived and issued only to active workspace members. Outbound calls need a
one-use server-created intent tied to the actor, client and inquiry's stored
phone number. The signed TwiML callback cannot dial an arbitrary browser
parameter. Signed callbacks record call status and duration.

Inbound calls can ring active portal users who have connected their browsers.
Unanswered calls redirect to the pre-existing Twilio Bin when configured.
Preserve that fallback before changing number routing. This release does not
replace the fallback's voicemail system or import voicemail recordings.
Keep `client_voice_settings.enabled` false until the TwiML application and
controlled call tests are ready. The number's existing route should only be
changed after those tests.

## Deployment and verification

Apply the mailbox migration followed by `20261031160538_client_resend_email.sql`
and `20261031161048_client_phone_workspace.sql` after full schema replay checks.
Deploy `client-mailbox`, `client-phone`, `client-email-webhook` and
`client-voice-webhook` with gateway JWT verification disabled: user endpoints
validate the user's JWT internally, webhook endpoints validate provider
signatures. Never disable those internal checks.

New tables are service-only, with RLS and no anon/authenticated privileges.
The existing portal inquiry views and account invitations remain unchanged.
No client-specific identifiers, addresses, credentials or operational decisions
belong in this public repository.

Automated tests cover authorization, database permissions, actual PostgreSQL
reservation behavior, sender suppression, webhook signatures, duplicate events
and delivery ordering. Production acceptance additionally requires email
send/reply, SMS send/reply and STOP handling with a consenting test recipient,
and browser call/answer/fallback checks. Provider registration approval is an
external prerequisite. Never label untested channels as live.
