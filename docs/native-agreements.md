# Native Compass Agreements

Compass can draft, review, issue and electronically sign its own agreements.
The initial customer is BHG Safety Partners, whose existing operational plan
is $500/month, month-to-month from October 1, 2026. No legal terms or recipient
email are invented. Import the existing Compass contract before issuing.

## Workflow

1. Open a client’s **Agreements** tab. Save Compass’s reviewed contract text as
   the template, or paste the complete terms into an individual draft.
2. Create a draft from the client’s recorded plan. Enter the signer’s name and
   email. Saving refreshes the price and included services from that plan.
3. Review the entire preview. Type the provider’s full name and confirm intent
   to sign for Compass. Issue locks the document and creates a 14-day link.
4. Copy the link or explicitly click **Email signing link**. A successful mail
   response means accepted by Resend, not proof of inbox delivery.
5. The recipient requests a code sent to the stored recipient email, verifies
   it, reads the document, and signs with explicit electronic-record consent.
   They can decline or contact Compass for changes or a paper alternative.
6. The final PDF includes the frozen scope, terms, both typed signatures,
   timestamps, verified email, consent and observed request context. Both
   parties can download it. Final bytes and SHA-256 are retained immutably.
7. Create the exact approved live payment link through the existing Billing
   tab. **Attach live payment link** checks the signed scope still matches the
   operational plan and exposes that existing link on the signing page.
   Signing and attaching a URL never create a charge or authorize ACH.

Service start dates are disclosed in the document. They do not instruct Stripe
to backdate a subscription, collect arrears, or silently change billing anchors.
Those choices remain part of the existing reviewed billing setup.

## Runtime and access

`AGREEMENTS_DATABASE_URL` is a server-only connection using `agreement_service`
through the Supavisor transaction pooler. This role has no table grants, Stripe
credentials, Vault access or general database write access. It can execute only
three validating functions in the unexposed `agreement_private` schema.
`agreement_private.set_password(text)` provisions the login without recording
plaintext credentials in migration history; only SQL as postgres can call it.

Team actions verify Supabase Auth with `getUser()` and resolve team membership
before calling the runtime. The private API rechecks the actor and requires an
admin for financial/contract changes. Authenticated teammates can read records;
portal contacts, anon and the shared service role cannot read or write them.
No public Data API function is introduced.

`AGREEMENTS_RESEND_API_KEY` and `AGREEMENTS_EMAIL_FROM` configure delivery from
a verified sender. `AGREEMENTS_APP_URL` is the canonical HTTPS signing origin.
Issuing links is blocked until verification email is configured. Emails are
sent only after the corresponding user action; no scheduled reminders exist.

Public `/sign/<43-character token>` routes bypass CRM sign-in only for exact
matching paths. A token hash is stored, never the raw URL token. Before email
verification, only the provider name is revealed. Codes last ten minutes,
allow five guesses, have a 60-second resend cooldown and a ten-per-day limit.
Codes are hashed together with the secret link token. Successful verification
creates a one-hour, HttpOnly, Secure, SameSite=Strict session cookie scoped to
that agreement’s path. Replacing a link revokes its codes and session.

All signer operations lock their link and contract rows. Signature retries are
idempotent. Terms and identity fields lock on issue; signatures lock on signing;
events and artifacts are append-only, with guards against direct worker SQL.
The content digest covers the database’s canonical JSONB envelope containing
the frozen document, title and recipient identity. The PDF has a separate byte
digest. This is an electronic signature record, not a certificate-based digital
signature. The record preserves signing evidence without guaranteeing a
particular contract’s legal enforceability.

Links have no-referrer, noindex/noarchive, frame-denial and no-store headers.
POSTs require the canonical same origin and JSON bodies with a small size limit.
Signed links allow re-verification/download for 90 days; the team retains access
afterward. Do not put signing URLs into analytics or third-party tracking.

## Client CRM expansion

`agreement_issuers.client_id` provides the ownership boundary for future Lucas
and BHG provider workspaces. The current staff API deliberately accepts only
the Compass issuer, and no client-issued contract UI or payment account is
enabled yet. Client CRM Lite will need its own scoped actor authorization,
approved templates, and connected merchant accounts before enabling issuance.

## Validation and release

`tests/native-agreements.test.mjs` runs the real migration in PostgreSQL/WASM,
including Supabase-shaped default grants, actor authorization, stranger/portal
isolation, consent, null-code rejection, guessing limits, link replacement,
immutable records, immutable PDFs, test/live separation and signed-scope checks.
All existing migration files were replayed together into a throwaway database.
Type checking, lint and production build are required before release.

Apply the additive migration before deploying the app, provision the isolated
login, then set production runtime variables. Preview builds do not get these
production credentials. Rollback removes the navigation/feature deployment;
retain agreement tables and final records. Never delete a signed record or
replace an issued document to roll back a release.

Before BHG can sign and pay: import the existing contract; confirm Brad’s
signer email; configure the verified email sender; finish dedicated-runtime
Stripe live setup and map the approved $500 monthly price. The software does
not bypass those missing inputs or mark a client paid without Stripe evidence.
