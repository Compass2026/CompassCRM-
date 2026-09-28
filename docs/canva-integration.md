# Canva integration

How Compass reads Canva, what it has learned doing so, and the Lucas
template-family shortlist that the Creative Engine's first governed templates
will be built from. Nothing here is built: no `canva_assets` rows, no
template registration, no renderer, no creative policy enabled.

Folder mapping (migration 0056): each client's primary ("Current") folder
and its Used subfolder are recorded by id on `clients.canva_folder_id` /
`canva_used_folder_id`; read them through `client_canva_folders()`.

## Integration rules (permanent)

Learned in the read-only discovery of Sept 28 2026 and confirmed by test.

1. **Folder listing is safe for metadata inventory.** `list-folder-items`
   returns id, title, created / modified time, page count and thumbnail for
   each item and changes nothing.
2. **Reading design content or metadata changes Canva's modified time.**
   `read-design` with `design_content` / `design_metadata` updated
   `updated_at` on 87 of 88 Lucas designs although nothing was edited
   (titles and page counts unchanged). A **thumbnail-only** read
   (`fields: ["thumbnails"]`) did not: DAG3B9q8YVE kept its `updated_at`
   after one. The one Lucas design whose content read was rate-limited also
   kept its date.
3. **Capture folder and item metadata before reading any design content**,
   and prefer thumbnail-only reads for visual review. Read content only for
   the designs that need it.
4. **Never treat a modified time observed after a content read as evidence
   that a person edited the design.** The original Lucas dates are kept in
   the discovery inventory, not in Canva.
5. **Current vs Used comes from the parent folder id** the item was listed
   in (`canva_folder_id` vs `canva_used_folder_id`), never from the title.
   Titles are unreliable: designs titled "(Used)" sit in Current folders and
   vice versa, and "Show Me" titles are shared by two clients.

## Discovery results (Sept 28 2026, read-only)

| Client | Current designs / pages | Used designs / pages |
|---|---|---|
| Lucas Construction | 19 / 21 | 69 / 99 |
| Ginger Huff Interiors | 34 / 48 | 23 / 36 |
| Logic Solar | 20 / 24 | 11 / 11 |
| Pensacola Equipment Rentals | 9 / 11 | 66 / 94 |
| Show Me Design | 10 / 24 | 27 / 48 |
| Show Me Electrical | 23 / 29 | 54 / 74 |
| BHG Safety Partners, Shewmaker | 0 | 0 (folders created Sept 28) |

No folder holds images; every Current folder contains exactly its Used
folder. Lucas's 88 designs were reviewed visually: 30 strong, 35 usable, 15
weak, 8 unsuitable as template references; 58 use real Lucas photos, 23
stock, 4 AI-looking, 3 no photo.

## Lucas template-family shortlist

The goal is Lucas's proven visual language rebuilt as governed Compass
templates, not copies of the old designs. Every family keeps the Lucas logo
tile, black-and-blue palette and bold caps headlines, and fixes what held the
legacy designs back: long paragraphs, script and ghost-text type, stock
photos, and copy that was never grounded.

### Quality benchmark (Tom's examples, Sept 28 2026)

Tom supplied five Facebook posts as the minimum finished quality. They are
**references only**: third-party work, never copied, never stored as
templates or assets. The screenshots are not committed to this repo.

**Magnolia Home Inspections** is the benchmark to meet or beat:

- **"New Doesn't Mean Perfect."** A dark panel with a thin gold rule on the
  left edge. A gold category pill heads a 3-line condensed off-white
  headline, then one subline and two gold-check bullets. A real photo sits
  in a thin gold frame on the right. A gold divider separates the footer:
  cream logo tile, "CALL TODAY" with the phone in large gold, and the
  website.
- **"Louisiana Humidity Breeds Mold."** A full-bleed real crawlspace photo
  under a dark vignette. Centred: an outlined gold pill, a huge 3-line local
  hook, one benefit line, a gold CTA pill ("Schedule an Inspection"), the
  cream logo tile, then phone and website.
- **"A Safer View From Above."** Portrait. A real photo in the top ~55%
  inside a double gold frame with corner brackets. Below, on a dark panel: a
  gold eyebrow, a 2-line headline, a subline, an outlined CTA with an icon,
  and 2×2 outlined feature cards (icon, word, two-word descriptor). The
  same footer as the first post.

**Wireless Wizard** (two posts) is a reference for thumb-stop headline scale
and icon-label rows only. It is **not** a reference for imagery or claims:

- Its phone splash and store interior read as AI-generated renders.
- "Mississippi's #1 Phone Repair Shop" and "Fast / Reliable / Affordable"
  are unsupported superlatives.
- Its busy multi-colour look is not Lucas.

**Tom's second batch** of four posts. Tom: "These should be the floor; all
ours need to be better than these."

| Post | Strengths to match | Weaknesses Compass must not repeat |
|---|---|---|
| Roy, Scott & James, "Holding the Powerful Accountable" | Real people photographed well; an authoritative serif headline; logo top-left; a high-contrast phone bar; a three-card credibility row | "Millions Recovered" and "Proven Results" are unsupported. The Louisiana-map icon sits over "Free Case Review", which it doesn't match. The cards are offset unevenly, and the courtroom background is a composite. |
| Roy, Scott & James, "Did You Know?" | An educational hook; hedged, accurate wording ("may", "depending on the circumstances"); scannable bullets; a clear CTA block with phone and website | A stock photo. About 70 words on the image, in two paragraphs. The red text block adds nothing. Several unrelated fonts. |
| Louisiana Foundation Repair, "Uneven floors or cracks in your walls?" | A problem-question hook; an explanatory visual (piers under the house); a three-icon benefit row; a strong two-colour footer | The visual is a render, not a real job. "Safety restored / stronger foundation" are outcome promises. There's a paragraph on the image, and red, blue and black all compete. |
| Louisiana Foundation Repair, "Our Services" | A real branded truck and trailer, the best authenticity signal in the set; a service trio of labelled photos; a clear footer | A script "and much more!"; the cliché "No job too big or too small"; the caption claims "20+ years" and "the best in Central Louisiana" without support; clutter. |

**The floor, all nine examples.** Every Compass graphic must at least match
their strengths:

- A readable hook headline.
- A named service.
- A benefit or icon row.
- A visible logo.
- A footer with phone and website.
- One clear CTA.

It must also avoid every weakness they show:

- AI or stock imagery presented as real.
- Unsupported superlatives, results and outcome promises.
- Paragraphs on the image.
- Script and mismatched fonts.
- Competing accent colours.
- Clichés.
- Icons that don't match their labels.

**Better than the floor** means both conditions at once, plus the Magnolia
system traits below. Magnolia is the strongest of the nine and remains the
target.

Patterns from the second batch worth adopting for Lucas:

- **The educational split ("Did You Know?")** feeds Trust & Know-How's
  educational mode. Keep the hedged wording; cut to one line and three
  bullets.
- **The problem-question hook** ("Uneven floors…?") feeds Service
  Spotlight headlines, for example a storm-damage question. The answer must
  be a governed service, never an outcome promise.
- **The branded vehicle with a service trio** ("Our Services") becomes a
  Services Overview layout in Service Light. Lucas has real branded trucks
  in its photos (DAGdypS7ZU4, DAG3B9q8YVE, DAGsgGZS5KA), plus labelled real
  photos of approved services.
- **The credibility row** (Roy, Scott & James) feeds Trust & Know-How
  authority mode, filled only from sourced claims such as Owens Corning
  Preferred Contractor, BBB Accredited and Lifetime Workmanship Warranty.
- **Explanatory diagrams** (roof layers, how a leak happens) are a future
  asset type. They would have to be labelled as illustrations and never
  pass as a job photo. Nothing is planned for them yet.

What the Magnolia set does, which every Lucas template must also do:

1. **It is one recognisable system.** The same dark ground, one accent,
   one light tone, the same logo tile and the same footer on every post.
   You can tell whose post it is before reading.
2. **An eyebrow names the service.** A small caps pill or label above the
   headline (NEW CONSTRUCTION, MOLD INSPECTIONS, DRONE INSPECTIONS).
3. **The headline dominates.** 3–5 words over at most three lines, in a
   heavy condensed or geometric face, off-white not pure white, taking
   roughly a quarter to a third of the canvas height.
4. **There is one supporting line**, a single sentence of benefit.
5. **Support items are few and short.** At most four, each 2–4 words, with
   an accent-colour check or icon.
6. **There is one real photo** showing the problem or the result. It is
   framed with a thin accent keyline, or full-bleed under a vignette, and
   never a collage of mixed-quality shots.
7. **There is one CTA**, verb-led, in an accent-filled or outlined pill.
8. **The footer band is fixed:** logo tile, "Call today" with the phone in
   the accent colour, and the website. Same place every time.
9. **The palette is at most three colours** plus the photo.
10. **Margins are generous.** Nothing crowds the edges, and thin rules and
    frames give the polish.
11. **The caption carries the detail and the image carries the hook**
    (hook line, then detail, then CTA, then hashtags).

Mapped onto Lucas, Magnolia's system fits the legacy look closely: dark
ground, one accent and a logo tile.

| Magnolia | Lucas equivalent |
|---|---|
| Dark brown ground | Charcoal / black ground |
| Gold accent | Lucas blue `#3ca8f0` |
| Cream text and logo tile | White text; the black Lucas logo tile |

The logo tile needs a thin white or Lucas-blue keyline on charcoal, or it
disappears (DAG5u2I9Lhk does this).

**Quality gate the renderer will check** (to be encoded later, not built):

- One headline of ≤ 5 words and ≤ 3 lines, the largest element.
- Overlay copy ≤ 25 words, not counting the footer.
- At most one eyebrow, one subline, four support items and one CTA.
- At most three colours plus the photo.
- One approved photo of at least 1080 px on its short side.
- The fixed footer band is present.
- Text contrast of at least 4.5:1 for small text.
- A safe margin of at least 5% on every edge.
- The headline stays legible when the post is shown at the width of a phone
  feed.

### Rules every family follows

- **Copy is governed.** Overlay text comes from the Drafter / approved post,
  services from the approved taxonomy, credentials from `sourced` or
  `confirmed` claims, service area from `clients.service_area`, phone and
  website from the client record. No template carries a claim of its own.
- **Photos are approved own work only** (`brand_assets.creative_use =
  'approved'`, `depicts_own_work = true`, focal point set). No stock, no
  AI imagery, no photo presented as a job that is not one.
- **People** (owner headshot, crew, team) only with consent recorded.
- **CTA** is the brand board's standing CTA, "Request a quote", until a
  different one is approved. "Free quote" is not usable: the claim "Free
  quotes offered" is `unverified`.
- **Type:** Montserrat ExtraBold / Black caps for headlines (≤ 6 words),
  Poppins for supporting text and contact (brand board). No script faces,
  no ghost text, no paragraph over ~25 words.
- **Palette:** charcoal / black panels, Lucas blue `#3ca8f0` accents,
  white type; roof brown `#9c603c` only inside the logo. The legacy Canva
  teal is normalised to the recorded Lucas blue (see Gaps).
- **Sizes:** each family ships a 4:3 landscape master for Google Business
  Profile (the legacy "Lucas Google" designs are 1200×1000, close to it) and
  a 4:5 portrait master for Facebook / Instagram; the square is optional.
- **Logo:** the black Lucas logo tile, always on its tile, never directly on
  a busy photo; bottom-right on landscape, top-left on portrait unless the
  family says otherwise. On charcoal it carries a thin white or Lucas-blue
  keyline.
- **Shared components** (from the benchmark), identical in every family:
  - **Eyebrow:** a Lucas-blue caps pill or label naming the service or
    topic.
  - **Footer band:** logo tile, "Call today" with the phone in Lucas blue,
    and the website, in the same place every time.
  - **CTA:** one, verb-led, in a Lucas-blue pill (filled or outlined).
  - The families differ in their middle section only.
- **Every render passes the quality gate** above.

### 1. Service Spotlight (service / promotional)

- **References:**
  - DAG193AlLyE (Current): the services-checklist structure.
  - DAGeF8pz5_c (Current): the photo hero with a black contact band.
  - DAG3B9q8YVE (Used): the rounded full-bleed photo card with a blue CTA bar.
- **Layout:**
  - **Landscape (Google Business Profile)** follows the structure of
    Magnolia's "New Doesn't Mean Perfect". On a charcoal ground: a thin
    Lucas-blue rule on the left edge; the eyebrow, headline, one subline and
    up to three checked bullets on the left; one approved photo in a thin
    blue keyline frame on the right; then the footer band.
  - **Portrait (Facebook / Instagram)** follows the Lucas photo hero. One
    approved photo in the top 55–60% under a charcoal scrim, with the
    eyebrow and headline over it; then the bullets, CTA and footer band.
  - The legacy references supply the Lucas look: the checklist from
    DAG193AlLyE, the black band from DAGeF8pz5_c and the photo card from
    DAG3B9q8YVE.
- **Logo:** tile in the contact band, bottom-right.
- **Headline:** ≤ 6 words, white caps on the scrim. Optional subheadline of
  ≤ 12 words.
- **Image:** single full-bleed own-work photo, cropped by focal point, with
  a 0→60% scrim for legibility. No mosaics in this family.
- **CTA:** blue pill in the contact band.
- **Variables:**
  - `service_label` (approved service)
  - `headline`
  - `subheadline`
  - `bullets[0..3]` (approved sub-services or sourced claims)
  - `photo`
  - `cta`
  - `phone`
  - `website`
  - `badge?` (one sourced credential)
- **Fixed:** logo tile, palette, type ramp, scrim, contact-band geometry,
  margins.
- **Do not carry forward:**
  - "Roof Inspections", "Emergency Roof Repairs" and "Roof Installation" as
    separate services (not in the approved taxonomy).
  - "Call for a free quote".
  - The "Locally owned" badge (unverified).
  - Stock houses (DAHF62RcfDg, DAG0eOkwucI).
  - St. Louis County in the service area.
  - The empty black strip at the bottom of DAG1hw7AoCs.
  - The owner headshot, until consent is recorded.
- **Channels:** both.

### 2. Trust & Know-How (authority / educational)

- **References:**
  - DAHBDkX484I (Used): aerial photo, angled blue title ribbon, icon points
    on black.
  - DAGoMRbPsR8 (Used): hero roof, white info band, three-photo strip.
  - DAGhcapfunU (Used): 2×2 icon checklist. Layout only; its stock
    hail-in-hand photo is excluded.
- **Layout:** follows the structure of Magnolia's "A Safer View From Above",
  in the Lucas look of DAHBDkX484I. A framed own-work photo fills the top
  half, with an angled blue title ribbon or eyebrow at the seam. Below, on a
  charcoal panel: a 2-line headline, one subline, and three or four
  outlined point cards (icon, 1–2 words, 2-word descriptor) or a checklist.
  Then the CTA and footer band. An educational "hook" variant follows
  "Louisiana Humidity Breeds Mold": a full-bleed own-work photo under a
  vignette, a centred local hook headline, one line, the CTA pill and a
  centred logo tile. Its headline copy must be governed, informational and
  free of fear-selling. Two modes:
  - **Authority:** points are sourced credentials.
  - **Educational:** points are a checklist from approved educational
    content, with no claims.
- **Logo:** tile top-left over the photo.
- **Headline:** the title ribbon holds 2–4 words; an optional question line
  goes under it.
- **Image:** aerial or detail own-work photo, top half.
- **CTA:** contact bar with CTA, phone and website.
- **Colors / type:** as above; icons in Lucas blue outline.
- **Variables:**
  - `mode`
  - `title`
  - `subtitle?`
  - `points[3..4]` (text + key from a fixed icon set)
  - `explainer?`
  - `photo`
  - `credential_badges?` (sourced claims only)
  - `cta`
  - `phone`
  - `website`
- **Fixed:** ribbon shape, panel, icon style, logo position, contact bar.
- **Do not carry forward:**
  - "Locally Trusted" (unverified local claim).
  - Long paragraphs (DAHBDkX484I, DAG9MobUlsc).
  - Stock hail photos.
  - "100% Satisfaction Guaranteed".
  - "100+ 5-Star Reviews" (the claim record contradicts itself; see Gaps).
  - Third-party marks (Owens Corning, BBB) as logos. Use text badges unless
    permission is recorded.
- **Sourced credentials available today:**
  - Owens Corning Preferred Contractor
  - BBB Accredited Business since 6/30/2025
  - Lifetime Workmanship Warranty
  - Storm damage repair and insurance claims assistance
- **Channels:** both. Authority suits Google Business Profile; Educational
  suits Facebook / Instagram.

### 3. Review Spotlight (review / testimonial)

- **References:**
  - DAGdypS7ZU4 (Used): headline stack left, dark rounded Google-review card
    right, logo tile overlapping, faded truck photo behind.
  - DAGtbaANXq0 (Current): review card structure only.
- **Layout:** the left column holds a headline and a governed service-area
  line with a pin icon, then the CTA and contact. On the right is a dark
  review card: stars, excerpt, reviewer display name, source badge
  ("Google review") and date. Behind both is an approved photo at 15–20%
  opacity.
- **Logo:** tile overlapping the card's bottom-right.
- **Headline:** a short caps line, e.g. "Trusted in Wentzville". The words
  must come from governed copy.
- **Image:** background only, faded.
- **CTA:** under the headline stack.
- **Variables:**
  - `review_excerpt` (verbatim, ≤ ~220 characters)
  - `reviewer_display_name` (as published)
  - `review_source`
  - `review_date`
  - `rating` (rendered, never typed)
  - `headline`
  - `service_area_line`
  - `photo`
  - `cta`
  - `phone`
  - `website`
- **Fixed:** card style, source badge, star rendering, logo, layout.
- **Do not carry forward:**
  - Any review not taken verbatim from a recorded source.
  - Script type for names.
  - Full-length reviews.
  - The team photo in DAGtbaANXq0 (consent).
  - "St. Charles, St. Louis, and Warren Counties".
  - Review-count claims.
- **Blocked until** the CRM has a governed review record: source URL,
  retrieved date and permission to feature. None exists today.
- **Channels:** Facebook / Instagram first. Google Business Profile is
  allowed but lower value there.

### 4. Seasonal & Offer

- **References:**
  - DAGht5PJaz0 (Used): white column with roofline icon, condensed caps
    headline, logo tile, 2×2 real shingle grid.
  - DAGht3-ZR3A (Used): photo row with a blue headline box and blue contact
    bar.
  - DAGgsKOAAew (Used): full-bleed home with a translucent offer panel. The
    offer layout only.
- **Layout:** two modes.
  - **Seasonal:** a white or light column with the roofline icon, a
    headline of ≤ 5 words and a one-line benefit. Beside it, a grid of 2–4
    own-work photos. A contact band sits at the bottom; the reference lacks
    phone and website, so this is added.
  - **Offer:** a full-bleed own-work photo with a translucent panel holding
    the offer title, exact terms and dates, and a contact bar.
- **Logo:** tile in the column (Seasonal), bottom-right (Offer).
- **Headline:** caps, ≤ 5 words, reassuring rather than fearful (brand
  voice).
- **Image:** photo grid (Seasonal) or full-bleed photo (Offer).
- **CTA:** blue pill in the contact band.
- **Variables:**
  - `mode`
  - `season_label`
  - `headline`
  - `subheadline`
  - `photos[1..4]`
  - `offer_id` → `title` / `terms` / `starts_on` / `ends_on`, verbatim
  - `cta`
  - `phone`
  - `website`
- **Fixed:** roofline icon, column and grid geometry, offer panel, logo,
  contact band.
- **Do not carry forward:**
  - "Get a free quote" and "No Hassles, No Surprises" (unverified).
  - The holiday stock frames (DAG7-VO-l1w, DAG39b_ZHdU, DAGr4CEoGHo,
    DAGr86KV8Qc).
  - Stock storm photos (DAHEPfUS3Q4, DAHN-NHdLPI).
  - "Limited time" urgency (words we avoid).
  - County lists that don't match the CRM.
- **Offer mode is disabled** until a confirmed, current `offers` row exists.
  Lucas has none.
- **Channels:** both. A Google Business Profile Offer post follows 0046's
  channel rules.

### 5. Real Work Showcase (project)

- **References:**
  - DAGsgGZS5KA (Current): six-photo mosaic with a black logo cell.
  - DAG5u2I9Lhk (Used): photo strip plus black brand panel with "Excellence
    in Roofing".
  - DAHF7MIgY4k (Used): full-bleed aerial roof with a centred logo tile and a
    two-line headline.
- **Layout:** two layouts.
  - **Mosaic:** 4–6 own-work photos plus a brand panel with the logo tile,
    a caps headline and contact details.
  - **Hero:** a single aerial photo with the logo tile centred and a
    two-line headline below.
  - Optional caption: service and city.
- **Logo:** brand panel (Mosaic) or centred tile (Hero).
- **Headline:** ≤ 5 words, caps.
- **Image:** real Lucas jobs only. This family is the proof.
- **CTA:** contact line in the panel or under the headline.
- **Variables:**
  - `layout`
  - `photos[1..6]`
  - `headline`
  - `project_label` (approved service + approved location)
  - `cta`
  - `phone`
  - `website`
- **Fixed:** grid geometry, brand panel, logo tile, edge stripe.
- **Do not carry forward:**
  - The street address on DAGsgGZS5KA page 2 (brand-board hard rule).
  - The stock before/after in DAGoMRagXBk: never as project evidence.
  - Any photo not approved as own work.
  - City names outside approved locations (only Wentzville is a
    `locations` row today).
- **Channels:** both; the strongest fit for Google Business Profile.

### 6. Team & Community (conditional)

- **References:**
  - DAGw7ij4zww (Used): blurred roof background, blue-outlined frame around
    the team photo, caps headline, tagline band, logo tile.
  - DAGssKUiIM8 (Used): team on black, secondary.
- **Layout:** a framed team or crew-on-site photo, a caps headline above it,
  a one-line caption band (not script), the logo tile overlapping the band,
  and a contact footer.
- **Logo:** tile at the bottom-right of the caption band.
- **Image:** a current team or crew photo with consent recorded.
- **CTA:** optional.
- **Variables:**
  - `headline`
  - `caption`
  - `team_photo`
  - `cta?`
- **Fixed:** frame, background treatment, logo, footer.
- **Do not carry forward:**
  - DAGoHi6z5U0 (every headshot labelled "Fred").
  - Cutouts composited onto houses of unverified origin.
  - Script taglines.
  - One-off events and giveaways (parade, bingo sponsorship, hockey
    tickets) and the dated hiring post.
- **Include only** when a current team photo with consent is available.
- **Channels:** Facebook / Instagram. Google Business Profile optional.

### 7. Service Light (optional second service layout)

Adds a light-background layout, so the feed isn't all black panels.

- **References:**
  - DAHBtA0EmOU (Used): aerial strip and stacked real homes on light grey,
    caps "ROOFING", logo tile, CTA tab.
  - DAG9kzVMDUo (Used): white ground, blue headline pill, three icon service
    rows, rounded photo frames.
  - DAG8QORDz9Y (Used): split with a rounded device-frame photo.
- **Layout:** a light grey or white ground with one hero photo and two
  supporting photos in rounded frames. A blue caps headline sits beside
  three icon service rows, with the logo tile and a CTA pill with contact.
- **Services Overview variant** (from the floor set's "Our Services"): a
  real branded Lucas truck or crew photo as the hero, an angled Lucas-blue
  "Our services" banner, and three labelled own-work photos, one per
  approved service. Then the footer band. No "and much more" or "no job too
  big".
- **Variables:** as Service Spotlight.
- **Do not carry forward:**
  - The "Get a free quote today" starburst.
  - The "Locally trusted" map pin.
  - Script display words.
  - County lists that don't match the CRM.
- **Channels:** both, mainly Facebook / Instagram.

### Not shortlisted

- **The black split family** (DAGzvmQzCck, DAG19wpxtGc, DAGwtaX2uEM):
  sound, but it overlaps Service Spotlight. DAG19wpxtGc is the alternate
  reference if a second dark service layout is wanted.
- **DAHF62RcfDg:** built on the same Canva layout as Logic Solar's
  DAHGH8p-U1Y, so it is not distinctly Lucas.
- **The five videos, the 4×6 postcard and the three giveaway / event
  posts:** not static templates.

## Gaps found for Tom

1. **Free quotes.** "Free quotes offered" is `unverified`, but most legacy
   designs promise a free quote. Confirm it, or keep "Request a quote".
2. **Review count.** The claim "100+ 5-star reviews (5.0 stars, 97 reviews
   aggregated)" is marked `sourced` but its own text says 97. Correct it
   before any use.
3. **Service area.** Legacy designs name St. Louis County. The CRM service
   area is Wentzville, O'Fallon, Lake St. Louis, St. Peters and St. Charles,
   Lincoln and Warren Counties, and the only `locations` row is Wentzville.
4. **Service lists.** Legacy designs list Roof Inspections and Emergency
   Roof Repairs, which aren't in the approved taxonomy.
5. **Palette.** Black is Lucas's dominant panel colour in Canva but isn't a
   recorded brand colour, and the Canva teal differs from the recorded
   Lucas blue `#3ca8f0`. Confirm the panel colour and accent.
6. **Reviews.** There's no review record in the CRM, so Review Spotlight
   stays blocked.
7. **Offers.** There are no offers, so Offer mode stays disabled.
8. **Photos.** Lucas's 12 photos and 2 logos in `brand_assets` are all
   unreviewed, so no template can render until photos are approved under
   Creative use. The Canva designs hold many more real Lucas job photos
   that aren't in `brand_assets`; they are candidates for a future,
   governed import.
9. **People.** The owner headshot and the team photos need consent
   recorded before use.
10. **Benchmark.** Nine benchmark posts were supplied in the conversation
    as screenshots and are described under Quality benchmark: Magnolia ×3,
    Wireless Wizard ×2, Roy, Scott & James ×2 and Louisiana Foundation
    Repair ×2. They are not in Canva, Drive or the repo. Together they are
    the floor, and every Compass graphic must beat them. More examples
    belong in a benchmark folder outside every client folder.

## Designs in Lucas's folder that are not Lucas's

Reported only. None was moved, because no destination is unambiguous.

| Design | What it is | Created | Likely destination and evidence |
|---|---|---|---|
| DAHTNp2pGpA "emil load screen" (Current) | Resilien Boxing Gym logo, "Faith Over Fear" | 2026-08-24 | Unknown. There is no Resilien client in the CRM, no Canva folder, and a Canva search finds no other Resilien designs. Likely a prospect or personal project; Tom to decide. |
| DAHO5hsKCZc, untitled (Current) | AI-generated boxing-gym image (generator sparkle mark), 16:9 | 2026-07-09 | The same subject as the Resilien logo, so the same destination. Unknown. |
| DAHGgKNbx3A, untitled (Current) | Unbranded photo of solar panels on a flat commercial roof | 2026-04-11 | Leaning towards Logic Solar: the only solar client in the CRM, and its Current folder has designs created 2026-04-06. The photo isn't in the four Logic designs checked, though, and Solar Scapes (a Canva-only solar folder, idle since 2025-08-11) is also possible. Not moved. |
