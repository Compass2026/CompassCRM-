# Client payment links

Stripe Checkout sessions last at most 24 hours. The Billing tab can now issue
a client-specific Compass link valid for 7 days, or revoke/replace it. Copy
the URL when issued; only its SHA-256 digest is stored, so leaving the page
requires replacing the link to recover a shareable URL. No email is sent.

GET `/pay/<43-character capability>` reads only the client name, agreed price,
expiry and status. A deliberate same-origin POST opens Stripe Checkout via
the dedicated billing runtime `/api/payment-links`. Neither CRM nor Supabase
Edge Functions gain Stripe keys or anonymous database access.

An admin's issuance delegates only that client's unchanged agreement, billing
mode and linked customer. Redemption rechecks the issuer's admin role, link
expiry/revocation, client status, customer and exact agreement. Existing guarded
Checkout logic rechecks the price in Stripe and current/mirrored subscriptions,
including ACH processing/incomplete states. A matching open session is reused;
an expired one gets a fresh request UUID. Completed sessions cannot restart
payment through the same link. Creation never itself authorizes a charge.

A 120-second database lease serializes redemption; Stripe writes retain their
idempotency key after uncertain failures. Link replacement/revocation cannot
race an active redemption. Lease ownership is checked on release. No session
locks are used on transaction-pooled connections. Checkout audit/metadata names
the authorizing admin and payment link. Public errors omit internal records.

Revoking a Compass link stops redemption. A Stripe page already opened remains
valid until its own expiry; use **Expire link** for that session if necessary.

Existing links are capped at seven days from their original issuance without
changing their URLs. Earlier expirations and revoked links are preserved.

Deployment: apply `20261010224500_durable_payment_links.sql` followed by
`20261011005243_seven_day_payment_links.sql`, deploy `billing/`
and the CRM from the same reviewed commit. No new environment variables or
Stripe permissions are needed. The legacy 24-hour Checkout actions remain
available. Issued/signed agreements and operational prices are unchanged.

Checks: `tests/durable-payment-links-db.test.mjs` uses real Postgres semantics
in PGlite for grants, RLS, capability scope, expiry, replacement, completion and
leases. Shared handler tests cover reuse/refresh and duplicate subscriptions;
runtime tests cover anonymous refusals, public reads, concurrent clicks and
failure cleanup. Run the portal sandbox after this grants/functions migration.
