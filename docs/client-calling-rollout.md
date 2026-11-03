# Client calling rollout

Compass CRM Lite owns the lead workspace. Twilio subaccounts provide each
client's phone, recordings, and Conversation Intelligence (classic) transcripts
and summaries. Resend delivers summary notifications to selected authorized
workspace users. No HighLevel or Google mailbox access is required.

## Operator setup

1. Confirm the existing CRM Lite workspace, active client contacts, Twilio
   subaccount credentials, and primary voice-capable number.
2. Open Client > Communications > Settings. Admins alone see calling setup.
   Set up browser calling, then Twilio summaries. These operations create or
   recover client-specific provider resources; they do not enable calling or
   change inbound routing. Twilio must make Conversation Intelligence available
   on that account. Automatic account-wide transcription and data logging stay off.
3. Select recording, summaries, retention (default 30 days), and recipients.
   Recipients are active contacts of this client or Compass teammates. Summary
   email also requires that client's enabled, verified Resend mailbox.
4. Enable browser calling. Use a consenting internal test contact to verify
   microphone, two-way audio, business caller ID, hangup, token refresh, mute,
   consent acceptance/refusal/timeout, and stop recording.
5. Check authenticated recording playback and unauthorized media access,
   transcript, summary, and each recipient's delivery receipt. AI text never
   changes a lead status, creates tasks, or triggers customer outreach.
6. Route incoming calls explicitly after the outbound check. Verify browser
   ringing, answer, missed call, and the retained TwiML forwarding fallback.
   Fallback forwarding is outside the new recording/summary flow.
7. Repeat the same acceptance checks per client. Configuration is not proof of
   successful live testing. Keep client access independent of channel readiness.

## Consent and data boundaries

Incoming callers hear a keypad prompt before connecting. Outgoing leads hear
the prompt on their leg before the browser is bridged. Only digit 1 grants
recording/transcription consent. Any other input or timeout connects without
recording. Outbound REST recording begins only after affirmative consent;
incoming dual-channel recording begins on answer. If an outbound recording
start cannot be confirmed, that call ends rather than silently retrying a paid
operation. Agents can stop recording while continuing the call.

Every browser request rechecks current client membership and workspace status.
The server binds outbound destinations to one-use lead call intents. Twilio
webhooks validate the public URL and subaccount signature. Consent callbacks
verify the child call belongs to the reserved parent. Recording callbacks
bind client, call, consent, and provider identifiers before storing a result.
Completion callbacks remain functional when new calling is disabled.

New data tables have RLS and no anon/authenticated grants. Only authenticated
application handlers expose an authorized client's content. Audio is proxied
through the signed-in session without exposing provider credentials or media
URLs. Transcripts load on demand. Provider media authentication must be checked
with the pilot recording; public access must be denied.

## Processing, email, and retention

`client-call-worker` requires the existing cron secret. Atomic database leases
prevent concurrent work. Transcript submission recovery searches by recording
source before creating anything; ambiguous creates are not blindly repeated.
The worker polls the exact summary operator. Output is displayed as plain text,
labelled AI-generated, and never treated as commands.

One summary is saved per recording. An outbox has one row per recording and
recipient. Resend uses that row's fixed idempotency key and immutable payload;
uncertain sends stop retrying after 23 hours. Membership, selected recipients,
mailbox readiness, and suppression are checked again before sending. Signed
Resend callbacks record delivery/bounce/complaint and suppress bad recipients.
Provider acceptance and confirmed delivery remain distinct.

Expiration is fixed when a recording arrives, using the retention setting and
call start time. Playback rejects expired records immediately. The worker
deletes Twilio transcripts and recordings, then clears local transcript,
summary, and outbox text. It retries deletion failures. Basic call metadata
remains. Copies already delivered by email cannot be recalled. Changing the
retention setting applies to new recordings, not retroactively.

The first release processes one recording and up to two emails per minute.
The limit keeps work within Edge Function runtime limits; monitor backlog and
increase capacity before a high-volume rollout. Failed/uncertain processing
requires operator review rather than a duplicate paid submission.

## Release order and rollback

1. Run unit/handler tests, strict Edge handler typecheck, lint, app typecheck,
   full PostgreSQL migration replay, CRM workspace browser tests, and build.
2. Apply `20261102231538_client_call_intelligence.sql`.
3. Deploy `client-phone`, `client-voice-webhook`, `client-email-webhook`, and
   `client-call-worker`, with gateway JWT verification off. Each authenticates
   internally; unsigned calls must fail.
4. Run `supabase/cutover/client-call-worker.sql` to register the one-minute job.
5. Release the matching app commit. Configure and verify the pilot before
   enrolling other clients. No client identifiers or email addresses are in
   this public repository.

For rollback, disable new calling/recording/summary switches for the affected
client and restore its prior inbound route. Keep completion callbacks and the
retention worker operating for existing recordings. Restore the previous app
if needed; the migration is additive and does not revoke client access.

## Verified references

- https://www.twilio.com/docs/voice/twiml/number
- https://www.twilio.com/docs/voice/twiml/dial
- https://www.twilio.com/docs/voice/api/recording
- https://www.twilio.com/docs/conversation-intelligence-classic/api/transcript-resource
- https://www.twilio.com/docs/conversation-intelligence-classic/api/service-resource
- https://www.twilio.com/docs/conversation-intelligence-classic/api/operator-attachment-subresource

Live audio, caller ID, provider availability, actual summary output shape, and
email delivery are separate acceptance checks, not established by mock tests.
