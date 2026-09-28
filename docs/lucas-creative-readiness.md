# Lucas Creative Readiness (Sept 28 2026)

## Decisions (Tom, Sept 28 2026)

The findings below were approved with these decisions. The template rules
are in `docs/canva-integration.md`, under "Rules every family follows".

- **Palette:**

  | Colour | Hex |
  |---|---|
  | Charcoal | `#0d0f10` |
  | Panel | `#1a1d1f` |
  | Lucas blue | `#128fb1` |
  | Sky blue | `#72d2e4` |
  | Text | `#f0f4f8` |
  | Muted text | `#8fa3b1` |

  - Brown stays in the logo artwork only.
  - The legacy red / cyan / grey palette is retired from Lucas templates.
  - The palette will be carried by the Lucas template definitions when
    templates are registered. `brand_colors` and the approved brand board
    (the website's record) are unchanged.
- **Creative type:** Montserrat for headlines, Poppins for supporting
  text. The website keeps Inter.
- **Logo:** the website's `lucas-logo-v3.png` is imported as the governed
  `logo_primary` (details below). It still needs a teammate's review on
  Creative use.
- **CTA:** "Request a Quote" is the standing creative CTA. Phone and
  website come from the governed client record.
- **Unavailable unless separately confirmed:**
  - Free Quote, Free Estimate and Free Inspection
  - 24/7 and same-day response
  - licensed / bonded
  - 500+ roofs
  - since 2018
  - review counts
  - Lifetime Workmanship Warranty (flagged for owner confirmation)
- **Project location:** an approved city or service-area page is not
  evidence that a project happened there. A caption names a place only when
  that photo or project has a governed or human-confirmed location.
  Geography is never inferred from the service area.
- **Services and geography** stay as found in section 5:
  - No Roof Inspections or Emergency Roof Repairs services, and no
    "emergency" language.
  - Wentzville where governed.
  - The county line is "St. Charles, Lincoln & Warren Counties".
  - No St. Louis County, Chesterfield, Ballwin, Wildwood, Florissant or
    other legacy markets until approved.
- **Review Spotlight and Team & Community** stay blocked. They wait on
  two future generic Compass capabilities: a governed review record, and a
  consent / usage record for people in photos. Neither delays the first
  Lucas pilot.

### Done on Sept 28 2026 (production)

1. **v3 logo imported** through brand-scan's import mode as brand asset
   `0c945d6f-c1ff-4b94-8c2b-afa777366e35`:
   - kind `logo_primary`, `is_primary`
   - source: link, `https://lucasconstructionmo.com/lucas-logo-v3.png`
   - 579,396 bytes, PNG, 1200×886
2. **Hashed by `source-assets`** from the stored copy: SHA-256
   `4f835f2c1d24434e8aeb5726ca0b74fe2284e99da119e7966c58770c17479a43`.
   This is the same hash as the file fetched independently from the site.
   The asset's notes record that it is a raster made for dark grounds, and
   that the vector original is requested. It is `unreviewed`: a teammate
   approves it on Creative use.
3. **The previous square mark is kept.** `81a697a7-63ce-4517-8565-98e8f9dfe545`
   is relabelled "Legacy square mark (old WordPress site icon, 512px)", with
   kind `logo_icon`. Its bytes, hash and review are unchanged. The 192 px
   icon is untouched, and nothing was deleted.
4. **TOM task opened:** "Get the original vector logo from Lucas", key
   `logo_vector`.
5. **The Creative use page** now shows, on every card:
   - the file name and host
   - the full hash and hash date
   - quality warnings: below hero size, heavily compressed, re-cropped or
     enlarged from a smaller file, a Facebook download, WhatsApp
     recompression, a raster logo
   - the asset's notes
   - an "Open full size" link

   Its focal-point picker now takes the photo's own shape, so a click lands
   on the same point of the image. Before, portrait photos were letterboxed
   in a square and the x coordinate was off.

Nothing was approved. No template, renderer, policy, creative, post or
publishing.

This report is read-only: nothing was written to the CRM, Canva or the Lucas
site. No renderer code, template rows, creative assets, social posts,
approvals or publishing. It asks what stands between the seven approved
Lucas template families (`docs/canva-integration.md`, "Lucas
template-family shortlist") and a first governed render, and who clears
each blocker.

Client: Lucas Construction, `102d3b20-2795-44ae-bd64-d1e43916291c`
(launching; site `upgrade_existing`, Compass-controlled, Tom's Next.js build
at lucasconstructionmo.com).

**Evidence.** Every CRM fact below was read on production on Sept 28 2026.
The sources were:

- `brand_assets`, `creative_governance_events`, `brand_boards`,
  `brand_colors`, `brand_fonts`, `client_brands`, `claims`, `offers`,
  `services`, `keywords`, `locations`, `page_groups` and `sites`.
- The live site: HTML and CSS from the production deployment.
- Canva: folder listings and one account-level uploads listing, metadata
  only. No design content was read in this phase.

## Summary

- **Nothing can render today.** Every Lucas brand asset is `unreviewed`.
  The two blockers every family shares are:
  - **Logo:** the CRM's only logo is the old WordPress site icon, not the
    current wordmark.
  - **Palette and typography:** the CRM's recorded values describe the
    retired WordPress site, not the current site or the Canva designs.
- **After those and the human photo review,** five families can render:
  1. Service Spotlight
  2. Trust & Know-How
  3. Seasonal (Seasonal mode only)
  4. Real Work Showcase
  5. Service Light
- **Two families stay blocked by missing governed data:**
  - Review Spotlight: there is no review record.
  - Team & Community: there is no consent record.
  - Offer mode is also blocked: there is no confirmed offer.
- **Only three of the 12 CRM photos** meet the hero threshold (≥ 1080 px
  on the short side); the other nine suit grid cells at most. The richer
  source is the real job photography in Canva. It can be imported later
  as governed assets; nothing has been imported.

## 1. Source photos: the review packet

**Where to review.** Brand › Creative use,
`/clients/102d3b20-2795-44ae-bd64-d1e43916291c/brand/creative-use`. The
page shows each preview beside the fields below and takes the decision:
Approve for creative, Exclude (with a reason), or Keep unreviewed.

**The decision is a teammate's.** Nothing here approves, excludes or
prefills anything.

**What approval needs** (0055, `src/lib/creative-use.ts`):

- A recorded hash of the stored file. All 12 have one.
- Known dimensions. All 12 have them.
- At least one lower-case subject tag.
- For a photo: the own-work decision and a focal point.

**The Creative Engine will use** only a photo that is `approved`, with
`depicts_own_work = true`. A hero also needs ≥ 1080 px on its short side
(the quality gate).

**Common to all 12:**

- **Source:** `website_scan`, from the old WordPress site
  (`lucasconstructionmo.com/wp-content/uploads/…`). Those URLs now answer
  403, and the current Next.js site shows no job photos (only the logo and
  a team photo). The stored copy in the private `brand-assets` bucket is
  the only copy the CRM holds.
- **Review state:**
  - `creative_use = unreviewed`
  - `depicts_own_work` not decided
  - `subjects` empty
  - no focal point
  - no review note
- **History:** one event each, `hashed` by the hasher (`source-assets/1`),
  2026-09-28 ~19:20 UTC. There are no review events.
- **Suggested subject tags:** none available. `creative_suggestions` is
  empty for every asset. I also couldn't view the stored bytes from this
  environment: the bucket is private and the original URLs are gone. So
  I've made no visual suggestions rather than guess. The labels are the
  scan's alt text, and only one is descriptive.
- **Orientation:** all 12 are portrait, EXIF orientation 1 (no rotation
  pending).

| # | Asset id | Original file (source) | Stored size | Bytes | SHA-256 (prefix) | Hero-grade (≥ 1080 short side) | Reviewer notes |
|---|---|---|---|---|---|---|---|
| 1 | `3a5e930a-1841-4cc3-860e-f6abbdf3e5a1` | `2025/06/IMG_7051.jpg` | 1536×2048 | 844,169 | `a2e36442fcb5…` | **Yes** | Camera original (iPhone naming), best quality of the set. Alt text: "Brick and stone two story home with a new architectural shingle roof and well maintained front yard". |
| 2 | `57d63a06-12d6-4a92-9950-495736f385a8` | `2025/06/PHOTO-2025-05-08-11-21-29.jpg` | 1366×2048 | 205,636 | `b8f07d58d18b…` | **Yes** | Messaging-app export, compressed. Same day as #3–#7. |
| 3 | `d3bb7aac-fbab-4ea5-89c4-23bdcec54328` | `2025/06/PHOTO-2025-05-08-11-21-08.jpg` | 1366×2048 | 197,753 | `a628f99d7093…` | **Yes** | As #2. |
| 4 | `03437409-1c0e-4129-9533-3e078329f5a1` | `2025/06/WhatsApp-Image-2025-05-08-at-11.19.55-1.jpeg` | 1066×1600 | 137,774 | `63adf1e06f7c…` | No (1066) | WhatsApp-compressed. Grid / mosaic cell only. |
| 5 | `9f599e07-a041-46a8-b7d3-b782097900d5` | `2025/06/WhatsApp-Image-2025-05-08-at-11.19.34-1.jpeg` | 1066×1600 | 132,451 | `b0c32b241089…` | No (1066) | As #4. |
| 6 | `3b515e61-f713-454a-a746-96853d0487f0` | `2025/06/WhatsApp-Image-2025-05-08-at-11.19.26-1.jpeg` | 1066×1600 | 133,061 | `a4abf43824c8…` | No (1066) | As #4. |
| 7 | `c097fe30-bbc9-4457-99f0-7311c534a57c` | `2025/06/WhatsApp-Image-2025-05-08-at-11.20.08-1.jpeg` | 1066×1600 | 137,126 | `28c4ea9551aa…` | No (1066) | As #4. |
| 8 | `c7db9166-f6ed-4581-8aaf-fbe6aeee43d5` | `2025/02/306120824_628177022035700_…_n-980x1307-1.jpg` | 980×1307 | 233,909 | `266bc07fbb14…` | No (980) | Facebook-download filename (`…_n`), then a WordPress resize. **Check it is Lucas's own job**, not a shared or customer post. |
| 9 | `db8e7148-8f13-47c4-9ecf-47053df220e6` | `2025/06/485607860_1117556233719243_…_n.jpg` | 950×1200 | 63,872 | `8f722ede8841…` | No (950) | Facebook-download filename; heavily compressed (64 KB). Check own work and visible quality. |
| 10 | `1979f6aa-accb-46b0-919a-7af48d7d6f87` | `2025/06/472447294_1142995140553883_…_n.jpg` | 950×1200 | 118,394 | `0a296a954362…` | No (950) | Facebook-download filename. Check own work. |
| 11 | `db6eec44-9c4d-4313-82d7-d27e5dfd9bda` | `2025/06/Lucas-Construction-03-480x360-1.jpg` | 950×1200 | 148,650 | `8de9ed919b51…` | No (950) | The filename says 480×360 landscape; the stored file is 950×1200 portrait. It is likely a theme crop of a smaller original, possibly upscaled. Check sharpness. |
| 12 | `8dfb59dd-1aab-4f2f-9200-1aff067b5396` | `2025/06/6-2-480x360-2.jpg` | 950×1200 | 145,092 | `efad04c0c739…` | No (950) | As #11. |

The two logos (`logo_primary` `81a697a7…`, `logo_icon` `c387232b…`) are in
the same state. They are covered in section 2.

**What each approval needs from the reviewer:**

- **Own work:** does the photo show a Lucas job (their crew, their
  finished roof)? #8–#10 came from Facebook and need particular care.
- **Subject tags:** lower-case; for example `roof replacement`,
  `architectural shingles`, `brick home`, `finished roof`, `crew`,
  `aerial`, `gutters`, `siding`. At least one is required.
- **Focal point:** x / y from 0 to 1 on the part of the frame that must
  survive a crop (the roofline, usually).
- **Exclude, with a reason:** anything that isn't a Lucas job, shows
  identifiable people without consent, shows a house number or plate, or
  is too soft to use.

**Hero candidates today:** #1–#3. A family needing a hero photo can render
once at least one of them is approved as own work. Families using grids
(Real Work Showcase mosaic, Seasonal) can use the rest as cells.

### More real Lucas photos in Canva (import later, not now)

Found through read-only listings only. Nothing was imported, approved or
moved.

**Where the real job photos are:**

- **Inside Lucas's designs.** The Sept 28 discovery found real Lucas
  project photos in 58 of the 88 designs in Lucas's two folders. This is
  the strongest pool: the photos are already used as Lucas's own work.
  They exist in Canva as images embedded in those designs.
- **The Canva uploads folder.** This is account-wide, shared by every
  client: 1,385 images. Names that point at Lucas:

  | Canva image id | Name | Uploaded | Thumbnail shape |
  |---|---|---|---|
  | `MAGoHrxmC3c` | `lucas roof.jpg` | 2025-05-21 | portrait 3:4 |
  | `MAGprvO4Yb8` | `Lucas-Construction-01-480x360.jpg` | 2025-06-07 | landscape 4:3 (480×360 by its name, too small for a hero) |

- **The PXL_ batch.** There are 59 phone-camera photos (`PXL_YYYYMMDD…`),
  taken between 2020-12 and 2025-06: 44 landscape and 15 portrait.
  - They were all uploaded on 2026-07-29 in one batch of 78 images,
    together with 14 `IMG_` phone photos and three numbered files.
  - The filenames don't say which client they belong to, and the uploads
    folder mixes every client. So these are **possible** Lucas job photos,
    not confirmed ones.

**What a later governed import needs:**

1. A person identifies each photo as a Lucas job, from the thumbnail.
2. The original file comes out of Canva. The connector can't give the
   bytes directly, so either Tom downloads the originals or they are
   exported from the designs. Then the brand-scan import mode stores them
   in `brand-assets`.
3. `source-assets` hashes each one.
4. It is reviewed on Creative use exactly like the 12 above, with own
   work, subjects and a focal point.

**Constraints for that import:**

- Canva thumbnails are 200 px and never a source.
- Reading a design's content bumps its modified date. Identifying the
  embedded photos must use thumbnail-only reads
  (`docs/canva-integration.md`).

**Not Lucas's.** The uploads folder also holds images for Logic Solar,
Show Me Electric, Pensacola Equipment Rental, BHG Safety Partners, Ginger
Huff, Silverback Plumbing, All Star Demo and several non-clients. It is
not a Lucas source by default.

## 2. Logo

| Candidate | Where | Format | Size | Full identity? | Creative Engine use |
|---|---|---|---|---|---|
| **`lucas-logo-v3.png`** (recommended) | Live site, `https://lucasconstructionmo.com/lucas-logo-v3.png` (header and footer of every page) | Raster PNG, RGBA, transparent background | 1200×886, 579,396 bytes, SHA-256 `4f835f2c1d24…` as fetched Sept 28 | Yes (see below) | **Appropriate on dark grounds only**, at tile size |
| CRM `logo_primary` `81a697a7-63ce-4517-8565-98e8f9dfe545` | Old WordPress site icon (`cropped-Untitled-design-27.png`) | Raster PNG | 512×512, 11,271 bytes | A square site-icon crop (the `cropped-` prefix and its 192 px twin) | **Not appropriate.** It is superseded by v3; keep it as the record of the old icon. |
| CRM `logo_icon` `c387232b-b9fe-490c-be0a-39f6b686a8ca` | 192 px twin of the above | PNG | 192×192 | No | Favicon-scale only |
| Canva "Logos" folder `FAFPNKjVvv8` | Canva | — | — | It holds only an icon and unrelated "Crush" images; **no Lucas wordmark** in that folder | — |
| Canva uploads `MAGdn5Q3Uo4` / `MAGpuUwrNBM` "LUCAS CONSTRUCTION LOGO.png" | Canva uploads (2025-01-29, re-uploaded 2025-06-08) | PNG; full size unknown from the listing | Thumbnail about 2.15:1, a wide horizontal lockup, a different shape from v3 (1.35:1) | Probably the earlier wordmark, from before v3; not checked | Tom to say whether it or v3 is current. v3 is what the live site uses. |
| Canva uploads `MAGfamwMZDw` "LucasConstructionLogo100-980x435.png" | Canva uploads (2025-02-18) | PNG, 980×435 by its name | — | The old WordPress-era header logo | Superseded |
| Canva brand kit "Lucas Construction" (`kAGghPt26-4`) | Canva | — | — | The connector lists its name and thumbnail only; its logo files can't be read through the listing | Ask Tom whether it holds an original or vector file |
| Logo tile inside legacy designs | Canva designs, e.g. DAG5u2I9Lhk | Embedded in designs | — | The same mark on a black tile | A layout reference, not a source file |

**What v3 shows:** "LUCAS CONSTRUCTION" in condensed caps, with a brown
roofline "L" framing the left side and the tagline "Roofing • Siding •
Guttering".

- **Colours:** the letters are white with a cyan outline (median
  `#02b0e7`); the roofline and tagline dots are brown (median `#b0601b`).
- **Tagline:** matches three approved service segments.
- **Name:** the site's legal name is "LUCAS Construction & Roofing LLC";
  the logo and the CRM say "Lucas Construction". This is not a problem for
  the logo; noted for the record.

**Quality.** v3 is a raster with soft edges. At full size, the tagline
letters show re-drawing artefacts from an upscale or clean-up. It is fine
at logo-tile size, about 240–400 px wide on a 1080–1200 px canvas. It is
not a print or large-format master.

- The white fill needs a dark ground: charcoal panel or black tile. That
  matches the approved families ("the black Lucas logo tile, always on its
  tile").

**Recommendation (not done):**

1. A teammate imports v3 through the existing brand-scan import as a new
   `logo_primary`, alongside the current one; it does not replace it.
2. `source-assets` hashes it.
3. A teammate approves it under Creative use, with subjects such as
   `wordmark` and `logo`.
4. The old 512 px icon is excluded with the reason "superseded by the v3
   wordmark". This is a teammate's decision, not automatic.
5. Separately, ask Lucas (or whoever designed v3) for the vector original
   (SVG / AI / PDF). If it arrives, it replaces v3 as the source through
   the same governed path.

## 3. Palette

**The three sources disagree.** The CRM records the retired WordPress
site. The current site, which Tom built on Sept 14, uses a different,
coherent system. The Canva designs sit close to the current site.

| Role | CRM today (`brand_colors`, board v1) | Current site (production CSS) | Canva designs (visual) |
|---|---|---|---|
| Dark ground | `#222222` "Charcoal", body text only | `#0d0f10` page background, `#121415` / `#1a1d1f` panels | black panels and logo tile |
| Brand blue | `#3ca8f0` "Lucas blue", sampled from the old logo | `#128fb1` accent (fills, borders, rules; 45 uses) and `#72d2e4` light accent (text accents and the **Request a quote** button with dark text; 41 uses) | teal / cyan around `#3ab0cc` |
| Logo blue | — | `#02b0e7` (inside the v3 logo) | the same mark |
| Light text | — | `#f0f4f8` text; `#8fa3b1` muted text | white |
| Warm | `#9c603c` "Roof brown" | `#7f4f21` warm accent (rare); `#c4874e` warm text | brown roofline in the logo |
| Red | `#ed202b` "Site red", CTAs on the old site | error states only, not a brand colour | not used |
| Other | `#03bed7` "Site cyan", `#777777` "Mid grey" | — | — |
| Type | Montserrat (headings) / Poppins (body) | Inter (Plus Jakarta Sans fallback) | condensed caps headlines |

### Proposed canonical Lucas creative palette (for Tom's decision; nothing written)

| Token | Hex | Use | Contrast |
|---|---|---|---|
| Lucas charcoal (ground) | `#0d0f10` | Panels, footer band, logo tile | — |
| Lucas panel (raised) | `#1a1d1f` | Cards, secondary panels | — |
| Lucas blue | `#128fb1` | Rules, keylines, eyebrow pills, icon outlines, CTA outline | 5.1:1 on charcoal. White on it is 3.8:1, so white text on this blue only at ≥ 24 px bold. |
| Lucas sky | `#72d2e4` | Filled CTA pill (charcoal text, as on the site), accent words, phone number | 11.0:1 with charcoal |
| White / light text | `#f0f4f8` (or `#ffffff`) | Headlines and body on charcoal | 17.4:1 |
| Muted text | `#8fa3b1` | Supporting lines, website, fine print | 7.4:1 |
| Roof brown (supporting, restricted) | `#7f4f21` | Only inside the logo, or a thin warm rule; never text (2.8:1) | — |

**What this proposal means:**

- It follows the current site, so posts and the site look like one brand.
- It fits the Canva look (black panels, cyan-blue accents, white type) and
  keeps the "three colours plus the photo" rule: charcoal, Lucas blue /
  sky as one family, and white.
- It **retires for creative** the old-site values: `#ed202b`, `#03bed7`,
  `#3ca8f0`, `#9c603c`, `#222222` and `#777777`. The legacy Canva teal
  normalises to `#128fb1` / `#72d2e4`.
- **Supersedes, once approved,** the shortlist's line "Lucas blue
  `#3ca8f0` accents". This report doesn't edit the approved shortlist.

**Also a decision:** the headline face. The CRM says Montserrat and the
site uses Inter. Canva's condensed caps are closest to the logo's own
lettering. I recommend Inter (ExtraBold) for headlines and body, to match
the site, unless Tom wants a condensed display face for headlines only.

**After Tom decides:** a teammate updates `brand_colors`, `brand_fonts`
and the board, which re-approves board v2. Not done here.

## 4. CTA, offers, phone and website

| Item | Governed record | Status for the Creative Engine |
|---|---|---|
| **"Request a quote"** | `brand_boards.standing_cta` = "Request a quote" (board v1, approved 2026-09-24). The live site's primary contact button says the same. | **Available**: the standing CTA. |
| "Free Quote" / "Free Estimate" | Claim "Free quotes offered" is `unverified`, with no source; no `offers` rows. The live site says "Free Quote", "Start Your Free Estimate" and "Send My Free Estimate Request", but the site is Compass-controlled (`sites.controlled_by_compass = true`), so it is Compass's copy, not independent evidence. | **Unavailable** until Lucas confirms. The claim then becomes `confirmed` with who and when. |
| "Free Inspection" / "Free Inspections" | No claim row at all. The site uses it ("Get Your Free Inspection", "Ready for a free inspection?"). | **Unavailable.** It needs its own confirmed claim. |
| Offers (any) | `offers`: 0 rows. | **Unavailable.** Offer mode stays disabled. |
| Phone | `clients.phone` = "(636) 459-9328"; sourced claim (BBB); brand-board hard rule "Only one phone number". | **Available**, as "(636) 459-9328". |
| Website | `clients.website_url` = `https://lucasconstructionmo.com` (the same on `sites.url`). | **Available**, displayed as "lucasconstructionmo.com". |
| Email | `lucas_construction@outlook.com` appears on the site but not in the CRM. | Unavailable; no family needs it. |

**Website claims the CRM does not hold (unavailable, never adopted from the
site):**

- "24/7 Response", "Emergency tarping within hours", "Same-Day Storm
  Inspections", "same-day priority". These are response-time promises,
  which the brand board forbids until confirmed.
- "Licensed, bonded & insured", "Missouri State Licensed Contractor".
- "Locally Owned Since 2018", "7+ Years in Business". The claim "Local /
  family-operated since 2018" is `unverified`, and the board forbids a
  founding year.
- "500+ Roofs Installed".
- "139 Google Reviews · 5.0 Rating" and "100+ 5-Star Reviews". See
  section 6.
- Commercial Flat Roofing / TPO / EPDM / Modified Bitumen, Metal Roofing,
  and siding materials (vinyl, fiber cement, steel). These are not in the
  approved taxonomy.

**Governed claims available as badges:**

- Owens Corning Preferred Contractor
- Installs Owens Corning Duration shingles
- BBB Accredited Business since 6/30/2025
- Storm damage repair and insurance claims assistance
- "Roofing, siding, guttering, fascia and soffit contractor"

**One to confirm first:** "Lifetime Workmanship Warranty" is `sourced`,
but its source is a page of the site Compass now runs
(`/services/roof-replacement`). It is a promise, so Lucas should confirm it
before it goes on a graphic as a badge.

## 5. Services and geography

| Legacy Canva wording | CRM truth | Creative Engine rule |
|---|---|---|
| **Roof Inspections** (as a service) | No such service. Two keywords map to **Roof Repair**: "roof inspection wentzville mo" (tracked) and "spring roof inspection wentzville". | Never listed as a separate service. The phrase may appear only in Drafter copy for Roof Repair aimed at those keywords. "Free inspection" is unavailable (section 4). |
| **Emergency Roof Repairs** | No such service. The keyword "emergency roof repair wentzville" (tracked) maps to **Roof Repair**. | Never listed as a separate service. "Emergency", 24/7 and same-day wording is unavailable: those are unconfirmed response-time promises. |
| Roof Installation | → **Roof Replacement** (approved; page `/services/roof-replacement`) | Use the approved name. |
| Storm damage / insurance | **Storm Damage & Insurance Claims** (approved; sourced claim) | Available; wording limited to "insurance claims assistance". |
| Gutters, siding, soffit & fascia | Gutter Installation & Repair, Siding Installation & Repair, Soffit & Fascia Replacement (approved) | Available. |
| Holiday / permanent lighting | Holiday & Landscape Lighting (hub), Holiday Lighting Installation, Permanent & Landscape Lighting Installation (approved) | Available (Seasonal family). |
| **St. Louis County** (e.g. "St. Charles, St. Louis, and Warren Counties") | Not in `clients.service_area`, no `locations` row, no page group. The site's list adds Chesterfield, Ballwin, Wildwood and Florissant and frames the area as "Greater St. Louis", but that is Compass's own copy and none of those markets is approved. Authority's unapproved-market decisions for Lucas are still open. | **Unavailable** until Tom approves those markets (the Authority market decision), not by adopting old designs. |
| **Wentzville** | Home city; the only `locations` row; tier-1 approved city page | **Available** anywhere. |
| Other cities | Approved city page groups: O'Fallon, St. Charles, Lake St. Louis (tier 2) and New Melle (fold). St. Peters appears only in the `service_area` text. | Available in the service-area line. **Tom to decide** whether an approved city page counts as an approved project location (Real Work Showcase's `project_label`). |
| County lists | `clients.service_area`: "Wentzville, O'Fallon, Lake St. Louis, St. Peters, St. Charles County, Lincoln County, and Warren County, Missouri" | The governed county line is "St. Charles, Lincoln & Warren Counties". Any other county list is unavailable. |

**Project captions.** A photo's city isn't recorded anywhere; `brand_assets`
has no location field. A Real Work Showcase caption can name the service
only, unless the reviewer puts the city in a subject tag and the city is
approved.

## 6. Reviews

**Blocked.** There is no governed review record:

- No review, testimonial or consent table exists in the schema.
- `clients.gbp_location` is empty, and Google is not connected, so no
  Business Profile reviews have been read.
- The only review claim, "100+ 5-star reviews (5.0 stars, 97 reviews
  aggregated)", contradicts itself and comes from a lead-gen directory.
- The site's "139 Google Reviews · 5.0" is Compass-written copy.
- The legacy Canva review graphics and counts are not review truth.

**What Review Spotlight needs** (future schema, not built): a review
record with

- the exact text
- the reviewer's display name as published
- the platform and source URL
- the review date, when available
- the rating
- the retrieved-at time
- a permission / usage state (allowed to feature, by whom, when)

Counts and averages are rendered from that record, never typed.

## 7. Team and people

**Blocked.** No consent record exists.

- **The only current team photo** is the site's
  `team-wentzville-parade-2025.jpg`, 1254×392: more than 20 people,
  **including children**, with a Lucas truck at the 2025 Wentzville
  parade.
  - It is also a one-off event, which the family excludes.
- **The Canva team photos** (DAGw7ij4zww, DAGssKUiIM8) and the owner
  headshot have no recorded consent.

**What Team & Community needs:** a current team or crew photo, adults
only unless a guardian's consent is recorded, with a consent record per
identifiable person (who, scope, date, withdrawal). There is no model for
this yet.

## 8. Template readiness matrix

**Shared prerequisites for every family.** None is met today.

- **S1 Logo:** v3 imported, hashed and approved (section 2).
- **S2 Palette and type:** Tom's decision recorded on the brand board
  (section 3).
- **S3 Photo:** at least one approved own-work photo; ≥ 1080 px short side
  for a hero (section 1).

Copy is governed in every family (section 4 and 5 rules). The standing
CTA, phone and website are available now.

| # | Family | Status | Specific blockers |
|---|---|---|---|
| 1 | Service Spotlight | **Ready after human photo approval** (plus S1, S2) | One hero photo approved (#1–#3 are the only hero-grade candidates). Services and bullets come from the approved taxonomy. The badge may use only the sourced claims in section 4. |
| 2 | Trust & Know-How | **Ready after human photo approval** (plus S1, S2) | Authority mode: sourced credentials are available (OC Preferred, Duration shingles, BBB since 6/30/2025, storm / insurance assistance); the warranty waits on Lucas's confirmation. The preferred aerial photo: none is known among the 12. Educational mode also needs approved educational post copy from the Drafter. |
| 3 | Review Spotlight | **Blocked by missing governed data** | No review record (section 6). |
| 4 | Seasonal & Offer | **Seasonal: ready after human photo approval** (plus S1, S2). **Offer: blocked by missing governed data.** | Seasonal needs 2–4 approved photos, one of them hero-grade. Offer needs a confirmed, current `offers` row; there are none, and "free quote" is unverified. |
| 5 | Real Work Showcase | **Ready after human photo approval** (plus S1, S2) | The mosaic needs 4–6 approved own-work photos: the 12 cover this if enough pass review, and a Canva import would strengthen it. The hero layout needs an aerial photo; none is known. The `project_label` city is limited to Wentzville unless Tom rules on approved city pages (section 5). |
| 6 | Team & Community | **Blocked by missing governed data** | No consent record. The only current team photo includes children and is event-specific (section 7). |
| 7 | Service Light | **Ready after human photo approval** (plus S1, S2) | Needs three approved photos (hero plus two supporting). The Services Overview variant needs a branded truck or crew photo: people require consent, and a truck-only photo needs approval. None is in the CRM today. |

**Nothing is "Ready" today.** The fastest path to a first render is:

1. Tom's palette and type decision.
2. The v3 logo import and approval.
3. Approving #1–#3 (if they are Lucas's own jobs).

That unblocks Service Spotlight, Trust & Know-How (Authority mode) and
Seasonal.

## Decisions and actions for Tom (none taken)

1. **Photos:** review the 12 on Creative use (own work, subjects, focal
   point). #8–#10 came from Facebook; #11–#12 may be upscaled.
2. **Logo:** approve importing `lucas-logo-v3.png` as a new `logo_primary`;
   ask Lucas for the vector original.
3. **Palette and type:** accept or amend the proposal in section 3.
4. **Free quote / free inspection / warranty:** confirm with Lucas, or
   leave them unavailable.
5. **Markets:** decide the St. Louis County cities through Authority, and
   whether approved city pages count as project locations.
6. **Canva photo import:** approve a later, governed import of the
   candidate job photos (section 1), for review like the 12.
7. **Reviews and consent:** schedule the review-record and consent-record
   schema work if Review Spotlight and Team & Community are wanted.
8. **Site copy:** the live site states several things the CRM doesn't hold
   (section 4). This is outside creative, but the same governance
   question applies.
