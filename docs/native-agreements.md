# Native Compass Agreements

## Verification email delivery (October 18, 2026)

Apply `20261018211252_agreement_verification_delivery.sql` before deploying
the app. The isolated agreement runtime appends a provider outcome for each
verification request: accepted (with provider message ID), failed (with an
allowlisted reason and HTTP status), or unknown (network/server uncertainty).
The team history explains these states and highlights failures. A requested
code is not proof of sending, and provider acceptance is not inbox delivery.
Old request events retain their original meaning and are not rewritten.

The private delivery function verifies the current link and code hash, uses
the existing contract/link lock order, and deduplicates by request event.
Only `agreement_service` can call it. It adds no public RPC or table write
grant. No raw code, token, recipient, credential or provider response body is
stored in the delivery event. Signature and payment operations are unchanged.
Audit failures do not trigger another email or falsely record a provider error.

The production sender was restored to
`Compass Marketing <agreements@send.compassmarketing.ai>` because the existing
key rejected the root-domain sender with HTTP 403. Before changing the sender,
verify both the domain and the key's sending scope. A verified domain alone
does not authorize a domain-scoped key. Environment changes require a new
deployment. Confirm a successful send from the actual agreement runtime and
check its provider record before declaring inbox delivery verified.

Regression checks cover acceptance, sender rejection, transport uncertainty,
audit failure, request binding, idempotency, grant boundaries, and unchanged
agreement content. No automatic retry or client reminder is introduced.
Admins can use **Test verification email setup** on the agreement page to
exercise the deployed sender and key against Resend's `delivered@resend.dev`
simulator. This does not create a customer code, signature, payment, or history
event. The displayed result confirms provider acceptance only. The recipient
is fixed server-side and cannot be supplied by the browser.

## Payment handoff fix (October 14, 2026)

Apply `20261014225000_agreement_payment_preparation.sql`, then deploy the CRM.
The agreement runtime can attach only an existing live, unrevoked seven-day
billing capability for the same client, linked customer and unchanged price.
It rechecks the complete agreement scope and the authorizing admin. Contract
terms, content hashes and signatures remain immutable.

Issuing and emailing a Stripe-collected agreement now prepare payment first.
For an already issued agreement, use **Prepare secure payment**. Preparation
is idempotent while its existing capability remains valid; it creates no Stripe
customer, Checkout Session, subscription or charge. After signing, the existing
recipient page shows **Continue to secure payment**, leading through `/pay/`
to the dedicated billing runtime. That runtime reuses or refreshes Checkout,
and retains its duplicate-subscription and ACH-processing protections.

Signing links last fourteen days; payment capabilities last seven days.
The admin page shows the payment expiry. Refresh payment preparation if an
agreement has been waiting longer. Revoking/replacing a payment capability
still invalidates the old one. The legacy signed-only Checkout attachment is
retained in SQL for compatibility, but the CRM uses preparation going forward.

Checks: `tests/agreement-payment-handoff.test.mjs` exercises a fictional
issued agreement through verification and signing, without creating a checkout,
and checks unchanged terms, idempotency, role boundaries, scope, client,
customer, mode, expiry, revocation and allowed URLs.

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
   **Preview signing email** shows the saved recipient, subject, and branded
   HTML in desktop/mobile views, plus its plain-text fallback. Previewing is
   read-only, disables links, and never requests a verification code or sends
   mail. The same renderer supplies delivery, using the agreement snapshot's
   client, fee and term. After a page reload, an admin can paste an already
   copied signing link to send it without rotation; the existing delivery
   guard checks that it belongs to this agreement and remains valid.
5. The recipient requests a code sent to the stored recipient email, verifies
   it, reads the document, and signs with explicit electronic-record consent.
   They can decline or contact Compass for changes or a paper alternative.
6. The final PDF includes the frozen scope, terms, both typed signatures,
   timestamps, verified email, consent and observed request context. Both
   parties can download it. Final bytes and SHA-256 are retained immutably.
7. The prepared payment button appears after signing. The recipient follows
   it to Stripe and separately authorizes the recurring subscription. Existing
   issued agreements can be prepared using **Prepare secure payment** before
   the recipient signs. Refresh expired preparation before sending an old link.

Service start dates are disclosed in the document. They do not instruct Stripe
to backdate a subscription, collect arrears, or silently change billing anchors.
Those choices remain part of the existing reviewed billing setup.

## Runtime and access

`AGREEMENTS_DATABASE_URL` is a server-only connection using `agreement_service`
through the Supavisor transaction pooler. This role has no table grants, Stripe
credentials, Vault access or general database write access. It can execute only
the validating staff, signer, artifact and payment-preparation functions in the unexposed `agreement_private` schema.
TLS always verifies the server certificate and hostname. Set
`AGREEMENTS_DATABASE_CA` to the Supabase server root certificate PEM from
Database settings for poolers using Supabase's private certificate authority.
Safe diagnostic logs include only failure codes, never connection credentials.
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

External collection snapshots use `external_amount_cents`, `external_currency`
and `external_interval` from the existing plan, with one interval per payment.
Record the manual method (including Zelle when `external_method = other`), due
date and instructions in the plan notes and reviewed contract terms. External
agreements use manual-payment wording in the email, signed page and PDF, and
never expose an online payment handoff. The database payment-preparation guard
continues to require Stripe collection before calling billing.

Migration `20261030034002_external_payment_agreement_scope.sql` replaces only
the private scope reader. Save an existing draft to refresh its fee snapshot.
Issued/signed documents and stored artifacts are not rewritten. Stripe scope
keys and values stay identical so existing signed-scope checks still succeed.

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

