# Client Intelligence (five-layer plan, layer 1)

The layer every AI-drafted post stands on: verified client facts, brand,
services, audience, locations, offers, proof, assets, keywords and content
rules. This page records what already exists, what is missing, and the path
from here to a one-client social / Google Business Profile publishing pilot.
Separate from the visual redesign (`docs/design-system.md`) and the portal
go-live (`docs/portal-reconciliation.md`).

## What already exists (inventory, Sept 23 2026)

| Area | Where it lives | State in production |
| --- | --- | --- |
| Business facts | `clients` (phone, website, address, city/state, `business_type`, `service_area`) | filled for most clients |
| Brand and voice | `client_brands` (positioning, voice, story, differentiators), `brand_boards` (approval) | 9 of 9 written, **2 of 9 boards approved** |
| Services | `services` (taxonomy, `page_url`, `primary_keyword_id`) | 112 approved; several clients have none mapped to a page |
| Audience | `client_brands.audience` | written |
| Locations | `locations` (lat/lng, physical flag), `clients.service_area` | at least one per client |
| Offers | `offers` (0044: exact terms, source, optional dates, draft / confirmed / retired) | table live, **0 offers recorded**; no editing screen yet |
| Proof | `claims` (`sourced` / `unverified` / `confirmed`, `source`) | 63 sourced, 31 unverified, **0 client-confirmed** |
| Assets | `brand_assets` (logos, photos, labels, sizes) | 84 photos, 8 primary logos |
| Keywords and intent | `keywords` (`intent`, constrained to the four intents or NULL since 0044; `intent_note`; `service_id`; money / tracked flags), `page_groups`, `money_keywords` | 414 labelled with one of the four intents, 133 without an intent (55 of them Shewmaker rows whose former free-text intent now sits in `intent_note`) |
| Content rules | `client_brands` (AI guidance, words to use / avoid, pillars), `brand_boards.hard_rules` | written |
| Posts | `social_posts` (platform, copy, status), `content_posts` (blog) | 0 social rows; **GBP posts have no CRM record** — `google-ops gbp_posts` sends straight to Google |

## Rules the whole post line follows

- **Topic and intent first.** A post starts from an approved service, its
  page, and one search intent — navigational (brand / contact),
  informational (answer a question), commercial (why us, proof), or
  transactional (book, call, offer). `topicCandidates()` builds these.
- **Facts are cited, never invented.** A post may state only what a usable
  claim says: `sourced` with a recorded source, or `confirmed` by the
  client. `unverified` is never cited. Offer posts wait for offer records.
- **A person approves before anything is published.** The worker drafts;
  it never approves or publishes its own work.
- **No SEO promises.** Social and GBP posts support visibility, engagement
  and calls. They are not presented as a guarantee of rankings or topical
  authority; results are reported as measured, through the scorecard.

## Sequence to a one-client pilot

1. **Readiness and topics (this branch).** The client **Intelligence** tab
   and `src/lib/client-intelligence.ts`: ten areas scored ready / partial
   / missing with the exact fix, the intent mix, and post topics. Read-only.
2. **Close the gaps (data, not code).** Tom approves the brand boards;
   label the blank intents; map approved services to page URLs.
   Shewmaker's intent notes (blueprint record) move in 0044 at Tom's request
   (Sept 23), verbatim, with no intent guessed.
3. **Schema for intent and offers (migration 0044 — applied Sept 23 2026, `20260923164846`).**
   `keywords.intent_note`; the 55 Shewmaker notes move there verbatim with
   `intent` set to NULL (never guessed); `intent` normalized on write and
   constrained to the four values or NULL; `offers` (title, exact terms,
   source, optional start / end, optional same-client service, `draft` /
   `confirmed` / `retired`; confirmed needs who confirmed it and when) under
   `is_team()`. Dates stay optional because standing offers (free
   estimates, free inspections, military discounts, financing, referral
   programs) have no set expiry; when both are present the end cannot
   precede the start. Verified on production: 547 rows, 414 intents
   unchanged, 133 NULL, 55 notes identical to their pre-apply text, 0
   nonstandard; types regenerated. Reconciled in the app: the Foundation
   keyword map shows the intent and the note separately, and the
   Intelligence tab reads `offers` (below).
4. **The post record (migration 0045).** One table for GBP and social
   drafts: channel, service, keyword, intent, body, CTA, assets, cited
   claim ids, status `draft → in_review → approved → published | rejected`,
   reviewer and time. Triggers refuse a draft leaving `draft` without a
   topic, an intent and at least one usable claim; refuse approval by the
   worker; refuse publishing anything not approved. Covered by
   `scripts/test-portal-sandbox.sh`.
5. **Grounded drafting.** A `get_client_intelligence(client_id)` packet
   mirroring these rules (the way `get_brand_profile` serves the brand)
   and a worker step that writes drafts only, to the plan's monthly count.
6. **Review.** A review queue on the Brief and the client tab: the draft
   beside the claims it cites; approve, edit or reject; assignable through
   the 0043 task fields.
7. **Publishing.** Approved GBP posts through `google-ops gbp_posts`,
   recording the Google post id; social published by hand first (mark
   published with the URL). Needs **Connect Google** (Settings) and the
   client's Business Profile manager grant.
   Channel rules live here, not on the Client Intelligence record: a GBP
   Offer post needs a start and end date, and that is checked when an
   offer post is published, not when the offer is recorded.
8. **Pilot and feedback.** One client, four GBP posts a month for a month;
   the scorecard records posts published, profile views and calls as
   measured values. Candidate: **Pensacola Equipment Rentals**, 8 of 9
   areas ready (only its brand board approval is open).

## How the Intelligence tab reads offers

`offerState()` places each offer on the Central-time day: **current**
(confirmed and inside its window, or a standing offer with no dates),
**upcoming** (confirmed, starts later), **ended** (confirmed, its end date
passed), **awaiting confirmation** (draft) or **retired** (ignored). The
Offers area is ready with at least one current offer, partial with only
drafts, upcoming or ended ones, and missing with none. It never blocks the
general pilot: `pilotReadiness(areas)` counts nine areas, and only content
that needs an offer asks `pilotReadiness(areas, { needsOffer: true })`,
which makes offers blocking. Channel rules (a GBP Offer post's date window)
stay with publishing.

## Readiness in production (Sept 23 2026)

Computed with `assessIntelligence()` over live rows (blocking areas ready):

| Client | Ready | Open |
| --- | --- | --- |
| Pensacola Equipment Rentals | 8 / 9 | brand board draft |
| Show Me Design | 7 / 9 | board; services without pages |
| Lucas Construction | 7 / 9 | board; unlabelled intents |
| Ginger Huff Interiors | 7 / 9 | board; services without pages |
| Logic Solar | 7 / 9 | board; services without pages |
| Shewmaker Brothers Masonry | 7 / 9 | facts; intent notes (blueprint) |
| BHG Safety Partners | 6 / 9 | board; photos; unlabelled intents |
| Show Me Electrical | 5 / 9 | facts; board; services; intents |
