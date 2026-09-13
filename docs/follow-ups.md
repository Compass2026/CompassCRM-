# Follow-ups

Deferred on purpose, in the order to take them up. Each line says what it
unblocks and what it costs.

## Needs Tom's decision or money

1. **BrightLocal spend.** Two things wait on a per-client credit cap:
   Citation Builder submissions (`citation_submit`) and the Local Rank
   Tracker + Local Search Grid reports (`brightlocal_lrt`, `brightlocal_lsg`).
   With a cap, a function like `google-ops` calls the BrightLocal API and the
   tasks stop landing on Tom. The trial key (1,000 lifetime requests) needs
   replacing first.
2. **Google ops token.** `GOOGLE_OPS_REFRESH_TOKEN` (business.manage,
   analytics.edit, gmail.compose) and `GA4_ACCOUNT_ID` into Vault; then one
   `google_access` grant per client. Until then GBP apply, GA4 and drafts
   fall back to Tom's tasks. Once the token is in, set each client's
   GBP Setup and Tracking Setup stages to *Not started* on the Foundation
   tab so the worker applies the specs it already wrote.
3. **Stripe secrets** (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) — billing
   is built and inert.
4. **Pensacola**: blend the `compass-astro` branch into `main` (Launch is
   blocked on it) and create the Search Console property.
5. **Delete `Compass2026/zz-sitepush-smoke`** — the token cannot.

## Worth building next

6. **Client domains on Vercel DNS** would remove the last DNS gate (Tom adds
   records at each registrar today).
7. **Photos**: a client upload link that lands in Drive `Media` so Polish
   can place them without Tom forwarding files.
8. **Social and Paid Ads pipelines** have no playbooks and no worker.
9. **Decision recording on approve / veto** and autonomy promotion
   (reconciliation step 8) — no hold steps exist, so low value today.
10. **Client portal** (Phase 5): read-only report, site and task views per
    client.
11. **Auth mail via Resend** so magic links stop rate-limiting.
12. **Brand board snapshot from the worker.** The Brand Build checklist item
    "Publish the board snapshot to Documents" needs Storage write access the
    worker session does not have, so it stays open on every new client. Add
    a `brand-snapshot` mode to an Edge Function (the app's publish action
    already renders the HTML) and let the worker call it.
