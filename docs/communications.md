# Compass Communications (Phase 1: Twilio SMS, BHG Safety pilot)

Issue #88. Migrations `0063_communications.sql` (**applied Oct 2 2026** as
`20261002211041`) and `0065_communications_secret_access.sql` (**applied Oct
5 2026** as `20261005033418`), Edge Functions `communications` (v2, JWT
verified) and `twilio-webhook` (v2, `verify_jwt = false`) (**v2 deployed Oct
5 2026**), the client **Communications** tab. The parent Main key and the
BHG subaccount's Auth Token are in Vault; outbound sending is off. Phase 2 (CRM Lite:
opportunities, pipelines, notes) is not started.

## Architecture

```
Compass's parent Twilio account (ISV)  ── Main API Key (Vault)
  └─ one subaccount per client that uses Communications
       ├─ its own Standard API key (Vault)      ← every client operation
       ├─ its Auth Token (Vault)                ← validates its webhooks
       ├─ Messaging Service "<Client> Messaging" (inbound + status webhooks)
       ├─ toll-free number(s) in that service
       └─ compliance: secondary customer profile (BU…) + toll-free verification (HH…)
```

| Layer | Where |
| --- | --- |
| Schema, RLS, write rules | `supabase/migrations/0063_communications.sql` |
| Provider contract | `supabase/functions/_shared/communications/provider.ts` |
| Twilio implementation (REST over injected `fetch`) | `supabase/functions/_shared/communications/twilio.ts` |
| Credential names | `supabase/functions/_shared/communications/credentials.ts` |
| Teammate actions → Twilio | `supabase/functions/communications/` (`handler.ts`, `store.ts`, `index.ts`) |
| Twilio → Compass webhooks | `supabase/functions/twilio-webhook/` |
| Shared pure rules (statuses, phone, keywords) | `src/lib/communications.ts` |
| Pages | `src/app/(app)/clients/[clientId]/communications/` (Overview, Inbox, Numbers, Compliance, Settings) |
| Server actions | `src/app/communications-actions.ts` |
| BHG pilot data | `supabase/seeds/clients/bhg-safety-partners-communications.sql` |

Nothing in code names a client. BHG is configuration data.

### Data model (0063)

| Table | What |
| --- | --- |
| `client_communication_settings` | Per-client switch (no row = off): `enabled`, `outbound_enabled` |
| `communication_accounts` | The client's Twilio subaccount (SID, status). No credential columns. |
| `communication_messaging_services` | Messaging Service per client / use case; opt-out mode |
| `communication_numbers` | Numbers in the subaccount: type, capabilities, service, primary |
| `communication_compliance_profiles` | Secondary customer profile + toll-free verifications: business and program details (teammate), Twilio's raw `provider_status` and its mapped `status`, dates, rejection (sync only), Compass `restriction` (teammate) |
| `communication_compliance_items` | Pre-submission checklist per registration, with evidence and who checked it |
| `contacts` | **The client's own customers** (the people it texts). `client_contacts` (0001) is unchanged: Compass's contacts at the client. Unique by phone per client. |
| `communication_consents` | Consent per client + phone + type: `granted` / `revoked` / `opted_out` |
| `communication_consent_events` | Append-only consent history (who: team / recipient / provider) |
| `communication_conversations` | One thread per client, contact, number, channel; unread count, assignee |
| `communication_messages` | Every SMS; unique Twilio `MessageSid`; outbound unique `request_id` |

No calls table yet (voice is Phase 2). No EIN or tax-id column exists
(0063's verify block refuses one).

### Who can write what

`communication_caller()`: `service` (the Edge Functions: authenticator +
service_role), `team` (a signed-in teammate through PostgREST), `owner`
(postgres: the worker, data scripts), `superuser` (sandbox fixtures).

- **Messages, conversations, consents, accounts, services, numbers** are
  written only inside 0063's functions; nobody — teammate, service role or
  the worker's SQL — writes them directly (grants + guard triggers).
- **Consent** is a teammate's (`communication_record_consent`, evidence
  required) or the recipient's (STOP / START, Twilio's 21610). A teammate
  cannot overwrite a STOP.
- **Settings, compliance details, checklist** are a teammate's; a data
  script (owner) may create them but never turns sending on.
- **Contacts** are a teammate's, or the inbound path's.
- Admin-only (`team_members.role = 'admin'`, checked by the function):
  create / link subaccount, create Messaging Service, purchase / link /
  attach numbers, check the parent key.

Tenancy: every row carries `client_id`; children reference parents by
`(id, client_id)`; RLS is 0036's `is_team()` on every table; no portal view
references any of it, so a portal contact reaches nothing.

## Environment variables and secrets

All Twilio credentials live in **Supabase Vault** (the repo convention: Edge
Functions read them through the service-role-only `get_secret()`); none is
an environment variable, none is `NEXT_PUBLIC_*`, and the Next app never
holds one.

| Vault secret | What | Set by |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID` | Parent (ISV) account SID `AC…` | Tom, by hand |
| `TWILIO_API_KEY` | Parent **Main** API key SID `SK…` (Console → API keys → Main) | Tom |
| `TWILIO_API_SECRET` | Its secret | Tom |
| `TWILIO_SUB_<AC…>_API_KEY` / `_API_SECRET` | A Standard key created **in** the client's subaccount | the function (create / link subaccount) |
| `TWILIO_SUB_<AC…>_AUTH_TOKEN` | The subaccount's Auth Token (webhook signatures) | the function when Twilio returns it, **otherwise Tom by hand** (see below) |
| `TWILIO_WEBHOOK_BASE_URL` (optional) | Public base of `twilio-webhook` if not `<SUPABASE_URL>/functions/v1/twilio-webhook` | Tom, only behind a proxy / custom domain |

- The parent's Main key is used **only** for `/Accounts` and `/Keys`
  (creating / reading a subaccount and minting its key). A Standard key
  cannot read `/Accounts`; **Settings › Check the parent key** reports
  whether the stored key is a Main key.
- Everything about a client (numbers, Messaging Service, messages,
  compliance reads) runs with **that subaccount's own key**. There is no
  fallback to the parent key.
- Twilio signs a subaccount's webhooks with **that subaccount's Auth
  Token**, so the token is stored per subaccount (Vault only) and
  `twilio-webhook` validates with it.
- The parent `TWILIO_AUTH_TOKEN` is not used and should not be stored.
- No key, secret or token is returned by a function, logged, or shown on a
  page; the pages ask `communication_secret_status()` (0065: yes / no and
  the exact secret name expected, never a value).
- **Twilio does not return a subaccount's Auth Token to an API key**, Main
  key included (create and fetch answer without `auth_token`). So after
  **Create subaccount** or **Link subaccount** the token is normally
  missing: copy it from the subaccount in the Twilio Console into Vault
  under the exact name the Numbers page shows
  (`TWILIO_SUB_<AC…>_AUTH_TOKEN`), then press **Store the subaccount's key
  and token again** / **Link subaccount** with the same SID.
- **Vault reads by account SID (0065).** The functions read a
  subaccount's secrets with `communication_subaccount_secrets(<AC…>)`
  (service role only): the exact name, else the single name that differs
  only in letter case (Twilio SIDs are mixed-case hex, so a SID typed in
  another case still finds its token), with surrounding whitespace
  trimmed; two such names are ambiguous and read as missing. A missing
  token is answered with the exact name expected and the SIDs that *do*
  have a stored token, so a token filed under another SID is visible.
  A failed Vault read is an error (424), never "missing".

## Webhook endpoints

| Route | Twilio sends | Configured |
| --- | --- | --- |
| `POST https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/twilio-webhook/messages/inbound` | Inbound SMS | Messaging Service inbound URL (set by Create Messaging Service; `UseInboundWebhookOnNumber=false`) |
| `POST …/twilio-webhook/messages/status?m=<message id>` | Delivery status | Per message `StatusCallback` (set by every send) and the service default |

`twilio-webhook` is deployed with `verify_jwt = false` (Twilio sends no
Supabase JWT; the deploy workflow passes `--no-verify-jwt` for it). Every
request:

1. must be a form POST with `X-Twilio-Signature` and an `AccountSid` of a
   registered subaccount whose Auth Token is in Vault;
2. is validated with the **official Twilio SDK** (`validateRequest`, from
   `twilio/lib/webhooks/webhooks.js` only) against the public URL including
   its query string and every posted parameter, known or not;
3. otherwise answers 403 and reads / writes nothing.

Inbound: number → client (the number must belong to that `AccountSid`), then
`communication_record_inbound` resolves or creates the contact and the
thread, stores the message, bumps `last_message_at` and the unread count,
and records STOP / START (Twilio's `OptOutType`, else the standard keywords).
Idempotent on `MessageSid`. The answer is an empty `<Response/>`: Compass
never auto-replies; STOP / HELP replies are Twilio's. A number not linked in
Compass answers 404 (visible in Twilio's debugger).

Status: forward-only (`communication_status_rank`), so out-of-order
callbacks never move a delivered message back; the `?m=` id lets a callback
that outruns the send's answer still find its message; the callback's
account must own the message.

## Sending

Inbox composer → `sendMessageAction` (teammate check) → `communications`
`send` with the teammate's JWT → `communication_begin_outbound` (settings on,
sending on, number active + in an active Messaging Service, consent
`granted` under a row lock, never `opted_out`; message row `pending`,
idempotent on the composer's `request_id`) → Twilio Messages API with the
**subaccount key** and `MessagingServiceSid` → `communication_mark_sent`
(SID + status, or Twilio's error code). Twilio unreachable → the message
stays `pending` until its callback. Twilio 21610 (recipient unsubscribed)
marks the recipient opted out.

## Compliance status flow

Twilio's own statuses are stored verbatim; Compass maps them one-to-one:

| Registration | Twilio | Compass |
| --- | --- | --- |
| Secondary customer profile | `draft`, `pending-review`, `in-review`, `twilio-approved`, `twilio-rejected` | draft, pending_review, in_review, approved, rejected |
| Toll-free verification | `PENDING_REVIEW`, `IN_REVIEW`, `TWILIO_APPROVED`, `TWILIO_REJECTED` | pending_review, in_review, approved, rejected |

The client-level pipeline (`pipelineStatus`, `src/lib/communications.ts`):

```
not_configured → profile_pending → profile_approved → number_purchased
  → verification_pending → verification_in_review → approved
                                                 ↘ rejected
restricted / blocked: a teammate's mark on a registration (Twilio has no such state); overrides all
```

Registrations are submitted in the **Twilio Console** inside the client's
subaccount (that is where the EIN is entered — Compass never sees or stores
it). A teammate links the `BU…` / `HH…` SID on the Compliance page and
presses **Sync with Twilio**, which reads both with the subaccount key and
records the status, dates, rejection code / reason and whether Twilio allows
an edit.

## Number provisioning flow

All admin, all explicit (Numbers page):

1. **Create subaccount** (type the client's name) or **Link subaccount**
   (an `AC…` made in the Console; must be a subaccount of the parent;
   any letter case). The function mints the subaccount's own Standard key
   and stores the Auth Token when Twilio returns one.
   - **Create** first lists the parent's subaccounts named
     `Compass - <name>` and refuses (409 `subaccount_exists_in_twilio`)
     when one exists — link it instead, never create a second. Once Twilio
     has created the subaccount it is registered at once, so a later
     failure (no Auth Token returned, the key not minted) is a **partial**
     state (207, `auth_token: "missing"` and the secret name), never a
     failure that invites another create.
   - **Link** registers nothing until the Auth Token is in Vault (409
     `auth_token_missing` with the exact name); then it registers the
     subaccount, mints the key and answers 200.
   - Twilio or Vault errors answer 424 with the detail (the Supabase
     gateway replaces a function's 5xx body, so 5xx is not used).
2. **Create Messaging Service** (“<display name> Messaging”, the client's
   Communications display name, else its name) with the webhooks.
3. **Search available numbers**: US toll-free, SMS + voice, preferred
   prefix (800) first. Buys nothing.
4. Pick one, **type it again**, **Purchase this number**: bought in the
   subaccount, registered, added to the Messaging Service. Nothing is ever
   purchased automatically.
5. Or **Link number** (a `PN…` already in the subaccount) and **Add to
   service**.

## Local development and tests

No real Twilio traffic anywhere in the suite.

| Command | Covers |
| --- | --- |
| `npm test` | `twilio-webhook-handler` (real SDK signatures: valid / tampered / other subaccount's token / unknown account, retries, new params, opt-out keywords, routing, status), `communications-handler` (team / admin authorization, consent and opt-out refusals, idempotent sends, Twilio errors, parent key only for subaccounts, no secret in responses), `twilio-provider` (URLs, form fields, which key), `communications-lib` |
| `npm run test:sandbox` | `communications.test.sql`: 128 checks — guards against the worker, service and teammate, registry, inbound idempotency and routing, composite keys, consent and opt-out, outbound rules, forward-only status, compliance, tenancy (portal contact, stranger, anon), cascade |
| `npm run test:communications` | The real handlers and stores over the sandbox + PostgREST with a fake Twilio: provisioning, inbound, retries, cross-tenant refusals, consent, send, callbacks, STOP, compliance sync, admin gate, no secret leaks |
| `npm run test:communications-ui` | Chromium over `next dev`: every page, Send from the inbox, opted-out composer, search buys nothing, no credential on any page, portal contact kept out (`SCREENSHOTS=dir`) |

The two PostgREST suites need `postgrest` on `PATH` and Chromium
(`CHROME_PATH`, defaults to the Playwright build in `/opt/pw-browsers`).

## Production setup (in order)

1. ~~Apply 0063~~ — **done Oct 2 2026** (`20261002211041`; dry run, md5,
   grants, RLS and refusal probes verified; `database.types.ts` regenerated
   from production).
2. ~~Deploy `communications` and `twilio-webhook`~~ — **done Oct 2 2026**
   (v1 each, from the PR branch through the Supabase MCP; later deploys go
   through `deploy-supabase-function.yml` from `main`, which gives
   `twilio-webhook` `--no-verify-jwt`).
3. Vault: `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`
   (a **Main** key). Settings › Check the parent key.
4. Run the BHG data script (below).

## BHG pilot setup

Client `3eaa3389-2a33-4004-837c-8aef90404410` (BHG Safety Partners, active).

1. Run `supabase/seeds/clients/bhg-safety-partners-communications.sql`
   (communications on, **sending off**, draft business profile and draft
   toll-free verification with the program, standard checklist; no EIN, no
   URLs, no Twilio objects).
2. **Twilio Console (Tom):** confirm the parent account's business identity
   is ISV Reseller / Partner and its primary business profile is approved.
3. **Numbers page (admin):** Create subaccount → Create Messaging Service
   (named “BHG Safety Messaging” from the display name the script sets) →
   search 800 → purchase one toll-free number.
4. **Twilio Console (Tom), in the BHG subaccount:**
   - choose opt-out handling on the Messaging Service (default STOP / START
     / HELP, or Advanced Opt-Out with BHG's HELP text — Advanced sends
     `OptOutType`, which Compass prefers);
   - set the number's **voice** handling (e.g. forward to 573-822-6448) —
     Compass does not handle calls in Phase 1;
   - create BHG's **secondary customer profile** with the EIN from BHG's IRS
     record; link its `BU…` SID on the Compliance page;
   - after the checklist is done, submit the **toll-free verification** for
     the number (use case, samples and volume from the Compliance page); link
     its `HH…` SID; Sync.
5. **BHG's website (checklist):** optional unchecked SMS consent on the form
   naming BHG Safety Partners LLC, purpose, “frequency varies”, “Message and
   data rates may apply”, HELP / STOP, Terms and Privacy links beside it;
   Privacy Policy SMS non-sharing language; Terms SMS section; remove the
   800-555-0100 placeholder. Record the opt-in, privacy and terms URLs.
6. When the verification is **approved**: Settings › allow sending.

## Risks and decisions to review

- **Inbound to an unlinked number** answers 404 and is not stored (Twilio
  keeps it in its logs). Link numbers bought in the Console before use.
- **START** re-grants consent for every type the recipient had opted out of
  (it is their own opt-in keyword); a teammate's revocation is not undone.
- **A customer who texts first** has no consent until a teammate records it
  (source “Customer texted first and asked for a reply”); the composer says so.
- **One subaccount per client** is enforced (unique per client); a second
  use case would be a second Messaging Service in the same subaccount.
- **Contacts** is a new, minimal table meant to become CRM Lite's contact
  model; `client_contacts` keeps its meaning.
- The deploy workflow and `database.types.ts` are also touched by Billing's
  draft PR; the conflicts are list / regeneration only.
