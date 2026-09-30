# Active client agreement inventory (billing cutover worksheet)

Compiled Sept 30 2026 for the B5 cutover gate. **No business terms are
guessed here.** Two sources were checked:

- **Production (read-only SQL).** There are no `plans` rows, no Stripe
  customers and no subscriptions.
- **The repository, and a read-only search of the Compass Google Drive.** No
  client's proposal, agreement, SOW, invoice or price sheet exists. Every
  client's `01 Onboarding` folder is empty. The only commercial documents are
  blank templates:
  - `Compass_Marketing_Service_Agreement`: month-to-month or annual; setup
    fee and monthly payment left blank; ACH authorization.
  - `Compass_Client_Onboarding_Checklist`: Package / Monthly Retainer /
    Setup Fee left blank.
  - `Compass_Client_Roadmap_with_Monthly_Deliverables`: Package left blank.

Drive to-do lists refer to contracts and payments handled in GoHighLevel,
Stripe and email ("Send Brad a contract through GHL and Stripe", "Setup ACH
Payments", "Collect Shane's payment"). The terms most likely live there, or
with Tom.

Fill-in copy: `docs/billing-agreement-inventory.csv` (one row per client,
one column per required field). The confirmed values become
`supabase/cutover/02_agreements.template.sql`, or are entered in the app.

## Why this blocks 0062

From 0062 on, automation plans only within the agreement:

- A client with no agreement gets **no weekly blog task and no website
  updates**.
- An agreement that includes 0 of something gets none of it.

The four active clients receive a weekly blog task today, from
`create_weekly_blog_tasks()`: two each so far, on Sept 16 and 23.
Applying 0062 without their agreements would stop that silently. The
validation step refuses to continue in that case: `supabase/cutover/04_validate.sql`.

## Active clients (the cutover gate)

For all four active clients, **nothing is recorded or known**:

- agreement
- package
- monthly amount / term / start date
- collection method (Stripe or external)
- every quota: blog, social, GBP, new pages, refreshes

What the CRM shows for each:

**BHG Safety Partners** (`3eaa3389-2a33-4004-837c-8aef90404410`)
- **Operational evidence:**
  - Pipelines: Foundation ✓, SEO ✓, Reporting active.
  - Compass-run Next.js site (`upgrade_existing`, `markdown_blog`).
  - Weekly blog running: 2 posts, 1 published.
  - No social accounts; no GBP location linked.
- **Drive:** a to-do says "Send Brad a contract through GHL and Stripe … Setup ACH Payments / Send Brad proposal". No terms.

**Logic Solar** (`70211d71-d9f4-46ab-abe2-ef39c41591fb`)
- **Operational evidence:**
  - Pipelines: Foundation ✓, SEO ✓, Reporting active.
  - Client-run site (`client_retains`): blog posts are filed as Google Docs (2 drafts).
  - No social accounts; no GBP location.
- **Drive:** "Sign Logic up for Compass", "Logic- Website and Invoice", "Collect Shane's payment". No amounts.

**Show Me Design** (`d94cfde2-0751-4002-a149-c83b4c6c956d`)
- **Operational evidence:**
  - Pipelines: Foundation ✓, SEO ✓, Reporting active.
  - Client-run site; blog posts filed as Docs (2 drafts).
  - No social accounts; no GBP location.
- **Drive:** to-dos only.

**Show Me Electrical** (`9a8e05f5-3d28-4839-9735-79bcdd0e277d`)
- **Operational evidence:**
  - Pipelines: Foundation ✓, SEO ✓, Reporting active.
  - Client-run site; blog posts filed as Docs (2 drafts).
  - No social accounts; no GBP location.
- **Drive:**
  - to-dos only;
  - the Compass OS scoping doc lists "Show Me Electric" as a Compass OS CRM tenant, with no price.

Services are listed per client in the CSV. Operational evidence is only a
hint: "SEO pipeline complete" shows work was done, not that SEO is part of a
paid agreement.

## Launching clients (not planned for until active)

For all four, **nothing is recorded or known** about the agreement or its
terms.

**Ginger Huff Interiors** (`db9009c2-a04b-4e93-843f-e20c49263b5b`)
- **Operational evidence:** Foundation ✓, SEO ✓, Website active; Compass-run Next.js site.
- **Drive:** to-do "Update Blogs, Add Location pages, Update GBP".

**Lucas Construction** (`102d3b20-2795-44ae-bd64-d1e43916291c`)
- **Operational evidence:**
  - Foundation ✓, SEO ✓, Website active.
  - Compass-run site (`upgrade_existing`, `lucas_json`).
  - A Sept cycle whose website updates are done: 2 pages proposed, 2 refreshes published.
  - 4 GBP post drafts (2 approved).
- **Drive:** the September monthly report states: "There is no service plan on file for Lucas Construction".

**Pensacola Equipment Rentals** (`1e12fc47-731a-4d84-a4f1-4aed777db451`)
- **Operational evidence:** Foundation ✓, SEO ✓, Website active; Compass-run Next.js site.
- **Drive:** to-dos ("build AI Website", "Post FB").

**Shewmaker Brothers Masonry** (`a88f5ce2-30ac-508b-b217-cf22d277b278`)
- **Operational evidence:** Foundation ✓, Website active; the blueprint record.
- **Drive:** nothing.

*Compass Activation Test (fictional)* is offboarded and excluded.

## Missing business decisions (Tom)

1. **Terms per active client:**
   - package or custom retainer
   - monthly amount, term and start date
   - collection: Stripe (card / ACH debit) or external (check / wire / manual ACH, with the amount)
2. **The package catalog:** which packages Compass sells, and what each
   includes: the 9 services and 5 monthly quantities.
3. **The default cadence.** Two sources disagree:
   - Compass Marketing OS — Product & Delivery Standard (Drive, Sept 28 2026):
     "Default monthly planning target: 8 Social Media posts • 8 Google
     Business Profile posts • 8 Blog posts • 4 new Website pages". It calls
     this a planning target, not a contract term.
   - The CRM today: one blog post a week (about 4–5 a month) and up to 2 new
     pages plus 2 refreshes a month.

   Which one, if either, is the contract default?
4. **Website Management for client-run sites** (Logic Solar, Show Me Design,
   Show Me Electrical). Does the agreement include `website` (Docs proposed to
   the client) or not? From 0062, website updates run only when `website` is
   included.
5. **Hosting:** which sites Compass hosts and bills for.
6. **Social, GBP, Paid Ads, CRM (Compass OS), Reporting, Client Portal:**
   included per client? No active client has a social account or a GBP
   location linked in the CRM today.
7. **If the terms cannot be confirmed before cutover,** choose per client:
   - **(a) Exclude.** Record the client's id in the validation's exclusion
     list; automation stops for them (the weekly blog stops) until the
     agreement is entered.
   - **(b) An explicitly interim agreement** that reproduces today's
     automation for that client, for example "Interim — current service",
     with the numbers Tom states. It must be labelled interim in its notes,
     and replaced when terms are confirmed.

   Neither may be chosen without Tom.
