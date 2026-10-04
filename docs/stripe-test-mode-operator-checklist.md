# Stripe TEST MODE: operator checklist (Tom + ChatGPT)

Manual setup in the Stripe Dashboard for the billing test-mode validation.
**Test mode only. Nothing here touches Supabase, Vercel or the CRM.** Stop at
step 19 and return before anything is deployed.

Rules for the whole session:

- Every key you see must start with `sk_test_`, `rk_test_`, `pk_test_` or
  `whsec_`. If you ever see `sk_live_` / `rk_live_`, stop: you are in live
  mode.
- Secrets go only into your password manager. Never into chat, email, git,
  Slack or a document.
- Stripe IDs (`prod_…`, `price_…`, `we_…`) are not secret. Note them for step 19.

> Stripe moves Dashboard menus from time to time. The paths below are current
> as of Sept 2026. If a label differs, look for the same function nearby;
> the required outcome in each step does not change.

## 1. Enter Stripe TEST MODE

1. Sign in at https://dashboard.stripe.com.
2. Switch the **Test mode** toggle (top right) on. If the account shows
   **Sandboxes** instead, open the default sandbox.
3. Confirm the orange "Test mode" / sandbox banner is visible on every page.
   Keep it visible for all the steps that follow.

## 2. Create the restricted test API key

1. **Developers → API keys**.
2. Under *Restricted keys*, click **Create restricted key**.
3. If asked how it will be used, choose "Building your own integration".
4. **Name:** `Compass CRM billing (TEST)`.
5. Set the permissions exactly as in step 3, then click **Create key**.
6. Copy the key (`rk_test_…`) into your password manager as
   **STRIPE_SECRET_KEY (test)**. It is shown once.

## 3. Restricted-key permissions (derived from the code's actual API calls)

| Resource | Permission | Why |
| --- | --- | --- |
| Customers | **Write** | search, read, create a customer; link an existing one |
| Products | **Read** | import a package / one-time product |
| Prices | **Write** | read prices; create a client's Custom Retainer price |
| Checkout Sessions | **Write** | create a payment link; expire it; read its state |
| Customer portal | **Write** | create the restricted portal configuration and sessions |
| Subscriptions | **Read** | mirror subscriptions |
| Invoices | **Read** | mirror invoices and their lines |
| PaymentIntents | **Read** | mirror payments |
| Charges | **Read** | mirror payment methods and refund totals |
| Refunds | **Read** | mirror each refund |
| **Everything else** | **None** | webhooks, payouts, balance, disputes, Connect, files and so on |

The code never writes Subscriptions, Invoices, PaymentIntents, Charges or
Refunds.

If the Dashboard groups a resource differently (for example, Refunds under
Charges), grant the listed level to the group that contains it and nothing
more.

## 4. Create the test Standard package Product

1. **Product catalog → + Add product**.
2. **Name:** `Compass Standard (TEST)`.
3. **Description:** `TEST package for billing validation. Not a real Compass product.`

## 5. Create its recurring monthly Price (same form)

1. **Pricing model:** Standard pricing.
2. **Price:** any test amount, for example `2,500.00 USD`.
3. Choose **Recurring**, then **Billing period: Monthly**.
4. Click **Add product**, then note `prod_…` and `price_…`.

## 6. Create the Compass Custom Retainer TEST Product

1. **Product catalog → + Add product**.
2. **Name:** `Compass Custom Retainer (TEST)`.
3. Add **no price**. If the form forces one, add a placeholder of 1.00 USD,
   one-time, then **archive that price** right after saving. The CRM creates
   each client's retainer price itself (Billing tab › Custom Retainer).
4. Note `prod_…`.

## 7. Optional: Website Build TEST Product / Price

1. **+ Add product**, **Name:** `Website Build (TEST)`.
2. **Price:** any amount, **One-off**.
3. Note `prod_…` and `price_…`.

## 8. Enable cards

1. **Settings → Payments → Payment methods**. Use the default payment-method
   configuration.
2. Confirm **Cards** is **On**.

## 9. Enable ACH Direct Debit (US bank account)

1. On the same page, turn **ACH Direct Debit** **On**. Accept the test-mode
   prompts.
2. If there is an option, leave bank verification at the default (instant
   verification through Financial Connections).
3. Test values for later:
   - Card, success: `4242 4242 4242 4242`
   - Card, later charges fail: `4000 0000 0000 0341`
   - ACH, success: routing `110000000`, account `000123456789`

## 10. Create the webhook endpoint

1. **Developers → Webhooks → + Add endpoint** (or *Add destination*).
2. **Events from:** *Your account*. Not connected accounts.
3. **Payload / event style:** the classic **snapshot** events. **Not** "thin"
   events: the webhook expects the full event object.
4. **API version:** leave the default. Compass re-reads every object at its
   own pinned version and never trusts the payload.
5. Enter the URL from step 11.
6. Select the events from step 12.
7. Leave the endpoint enabled. It will answer 503 until deployment, and
   Stripe retries for up to 3 days.

## 11. Exact webhook URL

```
https://iokcopiyzajigvhwexhe.supabase.co/functions/v1/stripe-webhook
```

## 12. Exact 34 events (select each one; **no** "select all", **no** wildcard)

```
customer.updated
customer.deleted
product.created
product.updated
product.deleted
price.created
price.updated
price.deleted
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
customer.subscription.paused
customer.subscription.resumed
invoice.created
invoice.finalized
invoice.updated
invoice.paid
invoice.payment_failed
invoice.payment_action_required
invoice.voided
invoice.marked_uncollectible
invoice.deleted
payment_intent.processing
payment_intent.succeeded
payment_intent.payment_failed
payment_intent.canceled
charge.refunded
refund.created
refund.updated
refund.failed
checkout.session.completed
checkout.session.expired
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
```

The list's source of truth is `STRIPE_WEBHOOK_EVENTS` in
`supabase/functions/_shared/stripe/sync.ts`. Count them after saving: the
endpoint page should show **34** events.

## 13. Obtain the webhook signing secret

1. Open the new endpoint.
2. Under **Signing secret**, click **Reveal**.
3. Copy the `whsec_…` value into your password manager as
   **STRIPE_WEBHOOK_SECRET (test)**.
4. Note the endpoint id `we_…`.

## 14. Generate BILLING_RECONCILE_SECRET locally

On your own machine:

```
openssl rand -hex 32
```

Store the 64-character result in your password manager as
**BILLING_RECONCILE_SECRET**. It is Compass's own secret, not Stripe's.

## 15. Values that will eventually go into Supabase Vault (not yet)

| Vault name | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | the `rk_test_…` from step 2 |
| `STRIPE_WEBHOOK_SECRET` | the `whsec_…` from step 13 |
| `BILLING_RECONCILE_SECRET` | the value from step 14 |

They are added only at step 9 of the deployment order in
`docs/billing-readiness.md` § 17, after the migrations, the app and the
functions.

## 16. What NOT to add yet

- **Nothing into Supabase Vault or Vercel.** The Stripe credentials stay in
  your password manager until the deployment step.
- **No live key, ever, in the current architecture.** Approved rule: live
  secrets only after Option B, in a dedicated billing runtime.
- **No live-mode Products, Prices, webhook endpoint or payment methods.**
- **No Stripe customers or subscriptions for real clients.** Not even in test
  mode. The test lifecycle uses only "Compass Billing Test Client (TEST)".

## 17. What stays unset for test mode

- `app_settings.billing` in the CRM: leave it absent. That means test mode;
  a live key is refused.
- The `billing-reconcile-daily` schedule: not enabled until the last
  cutover step.
- `APP_BASE_URL`: leave it unset. The default is
  `https://compass-crm-ten.vercel.app`.
- Stripe Tax, coupons, trials, the Stripe-hosted "payment links" product,
  the Customer Portal no-code link: all off / unused.

## 18. Customer Portal: do NOT configure it by hand

- Do **not** turn on, in **Settings → Billing → Customer portal**:
  - cancellations
  - plan / price switching
  - quantity changes
  - pausing
  - the no-code **login link**
- The CRM creates its own restricted configuration through the API: an admin
  presses **Configure Customer Portal** in Settings › Billing. That
  configuration allows only payment methods, invoice history and contact
  details. Every session re-checks it and refuses one that was widened.
- If Stripe shows a banner saying the portal settings must be saved once
  before sessions can be created:
  1. Save the page with only **payment methods** and **invoice history**
     enabled.
  2. Leave everything above off.
  3. Do not activate the login link.

## 19. STOP: return to Claude / ChatGPT before deployment

Stop here. Do not paste any secret anywhere. Bring back, as plain text:

- [ ] Confirmation that everything above was done in **test mode**
- [ ] `prod_…` / `price_…` for Compass Standard (TEST)
- [ ] `prod_…` for Compass Custom Retainer (TEST)
- [ ] (optional) `prod_…` / `price_…` for Website Build (TEST)
- [ ] `we_…` endpoint id, and "34 events selected"
- [ ] Cards on / ACH Direct Debit on
- [ ] The three secrets are stored in your password manager, **not** added
      anywhere else

Deployment then follows `docs/billing-readiness.md` § 17. The
active-client agreement decisions it needed are answered (Oct 2026,
`docs/billing-agreement-inventory.md`).

**Returned by Tom (Oct 2026), test mode, ids only:**
- [x] Compass Standard (TEST): `prod_VMxmkG052epGVU`, monthly price
      `price_1UMDr54Zq9yMk653B7jdneFm` ($2,500 — a test fixture, not Compass
      pricing; mapped to the test client's *Test Standard (TEST)* package,
      whose agreement — agreed $2,500.00/month — is then bound to exactly
      that price by `supabase/cutover/06_bind_test_client_price.sql`)
- [x] Compass Custom Retainer (TEST): `prod_VMxtVQBYzS0Qya`
- [x] Webhook endpoint `we_1UMFdM4Zq9yMk653d9ynrHOP`, 34 events
- [x] Cards on / ACH Direct Debit on
- [x] The three secrets stored privately by Tom (not in Vault, chat or git)
