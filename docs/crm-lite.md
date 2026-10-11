# CRM Lite: website inquiries, follow-up, SMS alerts

Website inquiry → saved in Compass CRM → the website's existing email →
an SMS alert once every gate is open. Piloted with Ginger Huff Interiors; built
per client and switched on per client. Nothing in code names a client.

| Piece | Where | State |
| --- | --- | --- |
| Schema, rules, portal views, outbox | `supabase/migrations/20261011220000_crm_lite.sql` | **written, sandbox-tested, not applied** |
| Intake (website → Compass) | `supabase/functions/inquiry-intake/` (`verify_jwt = false`, per-source token) | not deployed |
| Alerts dispatcher + admin actions | `supabase/functions/crm-lite/` (`verify_jwt = true`) | not deployed |
| STOP / HELP / delivery status for the alert sender | `supabase/functions/twilio-webhook/` (v3: new `/notifications/*` routes; client routes unchanged) | not deployed |
| Agency workspace | Client › **Inquiries** (`/clients/[id]/inquiries`, detail, **Setup & alerts**) | in this PR |
| Client portal | `/portal/inquiries` (+ detail), Inquiries tab when portal access is on | in this PR |
| Shared rules | `src/lib/inquiries.ts`, `src/lib/inquiries-data.ts` | |
| Actions | `src/app/inquiry-actions.ts` (status, notes), `src/app/crm-lite-actions.ts` (setup) | |
| Ginger pilot data | `supabase/seeds/clients/ginger-huff-crm-lite.sql` | not run |
| Website side | `Compass2026/gingerhuff-website` `api/contact.ts` | separate PR |

## How an inquiry arrives

```
browser ──POST /api/contact (submissionId)──▶ website server (Vercel)
   validation · honeypot · form age · origin · rate limit (unchanged)
   1. Resend email (Idempotency-Key includes submissionId; "Reference: <id>")
   2. POST inquiry-intake  X-Compass-Source + Bearer token
        └▶ crm_ingest_inquiry: unique (source, submission id) → inquiry,
           contact matched in that client, history, alert jobs
   3. 200 only if the email was accepted AND Compass saved it
```

- **Ownership comes from configuration.** The website sends a source key and
  that source's token (Vault, `inquiry_sources.secret_name`). The inquiry's
  client is the source's client. A `client_id` in the body is ignored; a token
  for another source is 401. Unknown source, wrong token and missing token
  answer the same 401.
- **Stable submission id.** The browser mints one id per inquiry and keeps it
  while the details are unchanged (edited details get a new id). Pages loaded
  before the change send none, so the server derives `web-<sha256 of the
  fields>`.
- **Duplicates are impossible.** `unique (source_id, submission_id)` plus an
  advisory lock. A retry answers the first inquiry's id with `duplicate: true`
  and only moves the email outcome forward (failed → accepted).
- **Separate inquiries stay separate.** Same email, new submission id → a new
  inquiry on the same contact.
- **Contacts** are 0063's `contacts` (the client's own customers), matched by
  email, then phone, **within the client only**; otherwise one is created with
  `source = 'web_form'`.
- **Stored:** name, email, phone (as typed + E.164), location, service type,
  budget, the full message, page, submitted / received time, source, the
  website's email outcome (`accepted` / `failed`, Resend id).

### Partial failure and retries

The website has no queue of its own, so the durable retry is the visitor's
retained form plus two idempotency guarantees: Resend's key and Compass's
unique submission id. A retry can never send a second email or create a second
inquiry.

| Email (Resend) | Compass | Visitor sees | Where the inquiry is | Recovery |
| --- | --- | --- | --- | --- |
| accepted | saved | success | inbox + CRM | — |
| accepted | down / refused | "emailed, but we could not finish saving it — press Send once more" | inbox (with Reference) | the retry saves it; Resend reuses the first send |
| failed | saved | "could not be sent — try again" | CRM (marked *email failed*) | the retry sends the email and updates the CRM |
| failed | down | "could not confirm — retry" | the visitor's form | the retry |

- The website retries Compass once inside the request (dropped connection or
  5xx). Compass's intake answers 503 on any database error, never a false 200.
- `CRM_INTAKE_REQUIRED=false` on the website trades strictness for
  availability during a long Compass outage: an emailed inquiry is a success
  and is logged `Inquiry emailed; CRM save pending` with its reference. Off by
  default.
- No second email exists anywhere. CRM Lite sends no email of its own.

## The workspace

Statuses: **New → Contacted → Closed**, with Reopen. Status lives on the
inquiry; SMS delivery status lives on its alert jobs and never changes it.

- List: newest first, status labels, search by name / email / phone, filter
  chips with counts. Search terms are stripped of filter syntax
  (`searchTerm`).
- Detail: the full message and fields, **Call** (`tel:`) and **Email**
  (`mailto:`), status buttons, notes (author and time, immutable), history
  (received, every status change with who and when, notes).
- Agency only: the website's email outcome and the SMS alert jobs.
- Mobile first: single column, large buttons (checked at 390 px).

**Who may change what.** `crm_inquiry_set_status` / `crm_inquiry_add_note`
take a signed-in teammate, or a portal contact of the inquiry's own client
while that client's `portal_enabled` is on. Anyone else's inquiry looks
missing (`not_found`). A stale page is refused (`changed`). The worker's SQL,
the service role and anon cannot change anything. No direct writes exist to
inquiries, notes or history (guard triggers, no grants).

**Portal.** Four views, each filtered by `portal_client_id()` and the client's
`portal_enabled`: `portal_crm_lite`, `portal_inquiries`, `portal_inquiry_notes`
and `portal_inquiry_events`. They carry no contacts, email outcome, payload hash
or notification data. Authentication is the existing portal sign-in. Nothing in
this build sends invitations or resets passwords.

## SMS alerts (built, sending disabled)

```
inquiry saved ─▶ one notification_jobs row per recipient
                 queued  if every gate is open at that moment
                 blocked (reason) otherwise — never sent later
crm-lite dispatch (pg_cron every 5 min, only when something is due; and
inquiry-intake's kick):
  1. unknown jobs → list Twilio messages (to, from) → found: adopt SID
                                                    → provably absent: queue again
                                                    → can't tell: stay unknown
  2. queued jobs  → crm_notification_claim re-checks every gate, marks 'sending'
                  → Twilio (sender subaccount key, From = sender number,
                    StatusCallback …/notifications/status?j=<job>)
                  → created: sent · 4xx: failed · 429: queued + backoff
                    · 5xx / timeout / network: unknown (step 1, never blind)
twilio-webhook /notifications/status → forward-only delivery status
twilio-webhook /notifications/inbound → STOP / START / HELP
```

**Gates** (all are checked in the database at job creation and again at
claim):

1. The client's `sms_alerts_enabled`, switched on only by an admin through
   `crm_set_sms_alerts`. That function refuses until gates 2–4 hold.
2. The sender's toll-free verification is recorded `approved` by an admin
   (HH SID plus evidence; who and when are stamped), and the sender is
   enabled.
3. The recipient's consent is complete: date, method, their actual response,
   disclosure version and acknowledgment, recorded by a signed-in teammate.
   Nothing completes it automatically, and a data script cannot.
4. An admin's delivery test to that recipient was reported **delivered** by
   Twilio and confirmed received by the admin.

The job also needs no STOP on file for that sender and phone, and it must be
less than 24 hours old.

- **No old inquiries.** A job created while a gate is closed is `blocked` for
  good. Turning alerts on affects new inquiries only.
- **The text** is built in the database (`crm_inquiry_alert_text`):
  `Compass Marketing: <business> has a new website inquiry. Review it: <link>
  Reply STOP to opt out or HELP for help.` The link points to the portal
  detail (or the CRM detail for a teammate recipient), behind sign-in. It never
  carries the message, name, email or phone.
- **STOP** (Twilio's `OptOutType`, or the standard keywords) blocks every alert
  from that sender to that phone for every client. It opts out every
  recipient row with that phone and blocks queued jobs. A teammate cannot
  overwrite it. **START** lifts the sender block, but consent is then recorded
  again by a teammate before alerts resume. This is deliberately stricter than
  0063, because the published program says nothing about START. **HELP** is
  recorded. Twilio sends the replies (see Twilio below). Keywords are
  idempotent on the MessageSid.
- **Webhook signatures** use the official SDK with the sender subaccount's
  Auth Token, as for clients (0063).
- **Records:** provider SID, Twilio status (forward-only), error code /
  message, attempts, sent / delivered times, block reason.

## Configuration and secrets

All secrets live in Supabase Vault, under the existing names and readers. None
is in a repo, an environment variable of the CRM, or a page.

| Vault secret | What | Who |
| --- | --- | --- |
| `CRM_INTAKE_GINGER_HUFF_WEBSITE` | Ginger's intake token | written by **Issue token** (admin); shown once |
| `TWILIO_SUB_<AC… of "Compass - Notifications">_API_KEY` / `_API_SECRET` | a **Standard** API key created *in* the "Compass - Notifications" subaccount | Tom, by hand (Twilio Console → that subaccount → API keys) |
| `TWILIO_SUB_<AC… of "Compass - Notifications">_AUTH_TOKEN` | that subaccount's Auth Token (webhook signatures) | Tom, by hand |

The setup page names the exact secrets it expects (from the sender's SID) and
shows whether each is present, never a value. Twilio SIDs are not committed:
GitHub push protection treats them as secrets, and the BHG convention is that
an admin records them in the app.
| `SYNC_CRON_SECRET`, `SUPABASE_ANON_KEY` | existing | — |

Website (Vercel, Production, server-only): `CRM_INTAKE_URL`,
`CRM_INTAKE_SOURCE=ginger-huff-website`, `CRM_INTAKE_TOKEN`. See the website
README. BHG's subaccount, sender and credentials are not used.

**Twilio, in the "Compass - Notifications" subaccount:**

- The toll-free number's messaging webhook:
  `https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/twilio-webhook/notifications/inbound`
  (POST). An inbound posted to `/messages/inbound` is also recognized as the
  sender's.
- Opt-out handling: Twilio's default toll-free STOP / HELP, or Advanced
  Opt-Out on a Messaging Service with the program's HELP text. Proposed
  text, consistent with compassmarketing.ai/sms-consent.html:
  *"Compass CRM inquiry alerts from Compass Marketing Advisors LLC. Msg
  frequency varies. Msg & data rates may apply. Help:
  thomas@compassmarketing.ai. Reply STOP to opt out."* Compass never
  auto-replies.

## Enable Ginger (in order)

1. Review and merge both PRs.
2. **Apply** `20261011220000_crm_lite.sql` through the Supabase MCP: a
   rolled-back dry run first, then apply. Rename the file to its recorded
   version, verify (md5, grants, RLS), regenerate `database.types.ts` from
   production, and add a line to `docs/portal-reconciliation.md`. It also
   schedules `crm-lite-dispatch`, which calls nothing while no job is due.
3. **Deploy** `inquiry-intake`, `crm-lite` and `twilio-webhook` with
   `deploy-supabase-function.yml` (the workflow gives `inquiry-intake`
   `--no-verify-jwt`). Check `{"mode": "version"}` on `crm-lite`.
4. Run `supabase/seeds/clients/ginger-huff-crm-lite.sql` (dry run, then
   real). Result: CRM Lite on, portal access on, SMS off, source disabled,
   Ginger's mobile as a recipient with consent pending.
5. CRM › Ginger › Inquiries › **Setup & alerts** (admin): **Issue / rotate
   token**, copy it once, then **Enable** the source.
6. Website Vercel project → Production env: `CRM_INTAKE_URL`,
   `CRM_INTAKE_SOURCE`, `CRM_INTAKE_TOKEN` (Sensitive). Redeploy.
7. Authorized test inquiry on the live form, marked as a test. It lands in
   Ginger's inbox and in Inquiries with **Email accepted**. Close it.
8. Portal (optional now): invite Ginger from Overview › Client portal when
   invites are opened (`PORTAL_INVITES_ENABLED`, custom SMTP; see
   `docs/portal-reconciliation.md`).

**SMS, later, only when all hold:**

9. Setup › *Add the Compass alert sender* (admin): label "Compass -
   Notifications", the subaccount's `AC…` SID, the toll-free number, status
   *pending review*, not enabled. Then choose it as Ginger's sender. Nothing
   sends.
10. Twilio shows the toll-free verification **approved**. An admin opens Setup
   › *Edit this sender*, sets *approved*, enters the HH SID and the evidence,
   ticks *enabled*, and saves.
11. Tom adds the subaccount's API key, secret and Auth Token to Vault (names
    above). The setup page shows "credentials in Vault".
12. Record Ginger's consent with what actually happened: the date, the method,
    her words, disclosure version 2026-10-11 and the acknowledgment.
13. **Send delivery test** (admin) to her mobile. When it shows Twilio
    *delivered* and she confirms she received it, click **Confirm test**.
14. **Turn SMS alerts on**. Only inquiries received after this are texted.

## Add another client

1. Insert (or, on the setup page, save) `crm_lite_settings`. Add a source with
   **Add source** (key, label, site). Issue its token. Enable it.
2. On that client's website server, post to `inquiry-intake` with the key and
   token, as `api/contact.ts` does for Ginger (the contract is in
   `supabase/functions/inquiry-intake/handler.ts`).
3. Turn portal access on when the client's contacts should see it.
4. Alerts: add recipients, choose the Compass sender, then follow steps 12–14.

## Rollback (keeps every saved inquiry)

- **Stop intake:** remove the website's `CRM_INTAKE_*` variables and redeploy.
  The form is email-only, as before. Or **Disable** the source: new
  submissions are refused with 403 and the website asks visitors to retry,
  so remove the variables as well.
- **Stop alerts:** *Turn SMS alerts off* (or disable the sender). Queued jobs
  are blocked at their next claim.
- **Hide from the client:** untick portal access.
- **Pause the tick:** `select cron.unschedule('crm-lite-dispatch');`
- **Code:** revert the CRM PR. The tables keep their data; nothing drops
  them. Dropping the schema is a separate, deliberate decision (inquiries are
  business records). The functions to drop are listed in the migration
  header.

## Tests

| Command | Covers |
| --- | --- |
| `npm test` | `inquiry-intake-handler` (401 for every unauthorized shape, cross-client tokens, a client id in the body ignored, same id twice, separate inquiries, validation, outage → 503 then recovery, logs carry no PII or token), `crm-lite-handler` (who may call, gates closed → nothing sent, one send with callback, timeout → unknown → never resent blind, reconciliation found / absent / incomplete, 4xx / 429, missing Vault key, admin-only token issue and tests), `crm-lite-webhook` (real SDK signatures, STOP / HELP / START, other text not stored, sender account only), `crm-lite-lib`, `twilio-provider` (From-number send, listing) |
| `npm run test:sandbox` | `crm_lite.test.sql` (121 checks: RLS / grants / guards, the worker kept out, intake idempotency and client ownership, contact matching within the client, team and portal permissions, portal access off, strangers and anon, every gate step by step, no old inquiries, stale jobs, unknown / absent / transient / max attempts, STOP across clients, START, HELP, forward-only status, cascade, the Ginger seed) + the generic portal checks with the four new views |
| `npm run test:crm-lite-ui` | Chromium over `next dev` with the real handlers: website intake (once, owned by the source), agency list / search / detail / status / note / history, setup gates, the portal on a phone (close, reopen, note), client B kept out of client A's inquiry, no text sent. `SCREENSHOTS=dir` |

Website: `npm test` in `gingerhuff-website` (mocked Resend and Compass).
Nothing in any suite sends a real email or text.
