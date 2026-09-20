# BHG Safety Partners — Foundation upgrade brief (version-pinned)

Prepared Sept 20 2026 (UTC; the preparation session ran Sept 19–20 local
time) for the next working session. **Read-only
preparation**: no BHG code, deployment, DNS, GBP or CRM row was changed.
Every fact below names its source; anything not sourced is listed under
*Missing information* and must stay unknown until BHG or Tom confirms it.

| Pin | Value |
| --- | --- |
| Client | BHG Safety Partners, CRM client `3eaa3389-2a33-4004-837c-8aef90404410` (status `active`, vertical `safety_training`, `service_area` business, Hannibal MO) |
| Not to be confused with | BHG Forklift Training (`Compass2026/BHG-Forklift-Training`, bhgforklifttraining.com) and BHG Heavy Equipment (`Compass2026/BHG-Heavy-Equipment`) — separate repositories and projects; nothing from them is used here |
| Work mode | `upgrade_existing` (a site Compass manages; CRM `sites.controlled_by_compass = true`, `stack = nextjs`; migration 0039 backfills this) |
| Standard | Compass Website Foundation v1, `Compass2026/showmeelectricalwebsite` @ `94014af35316c94616dadb3f8d606a4b68577fb0` (accepted Sept 20 2026), applied as **reference** — BHG has not adopted it; adoption is what this upgrade decides module by module |
| Governing documents | Build Standard v1.1, Page Template Library v1.1, Foundation v1 Review and Completion Brief (links in `foundation_releases.documents` / `docs/compass-foundation-integration.md`) |
| Content adapter | `markdown_blog` (detected from the tree: `content/blog/*.mdx`, `src/app/blog/[slug]/page.tsx`, `data/locations.json`, `data/services.json`) |
| Branch plan | production branch of record **`main`** (the repository's only branch); preview branch `compass/preview-YYYYMMDD-bhgsafetypartners` created from `main`; pull request base `main`; Vercel **preview** deployment; `main` and the production deployment unchanged until Tom merges |

## 1. Current state (verified Sept 20 2026)

**Repository.** `Compass2026/BHGSafetyPartners` (private). Single branch
`main`; HEAD `9c5766d5c3a0bcfc91fce9e90d5cd6a36e4b8b21` (Sept 14 2026
21:50 −05:00, "Merge pull request #3 … Build the 10 missing service pages
(audit finding #5)"). Pull requests: #1 Resend wiring (merged Sept 11), #2
audit fixes (merged Sept 15), #3 ten service pages (merged Sept 15). No
open pull requests. No CI workflow, no tests, no `.env.example` beyond the
Resend variables.

**Framework.** Next.js 16.2.4 App Router, React 19.2.4, Tailwind v4 with
shadcn (Base UI) tokens, `@next/mdx` + `next-mdx-remote` + `gray-matter`
for the blog, `lucide-react`, `tw-animate-css`, Inter via `next/font`,
Resend 6.27. `npm ci && npm run build` at `9c5766d` succeeds locally
(Node 22.22) and prerenders every route statically.

**Content format.**
- `data/services.json` — 16 services (6 consulting, the training hub, 9
  courses added in PR #3): `slug, title, seoTitle, h1, category,
  shortDescription, longDescription, benefits[], courseFacts[], sections[],
  topics[], faqs[], relatedSlugs[]`.
- `data/locations.json` — 1,680 entries (`slug "state/city", stateAbbr,
  stateName, stateSlug, city, keywords[3]`), ~100 per state across 17
  states. Seventeen `data/<state>_cities.json` files exist but nothing in
  `src/` imports them (dead data).
- `content/blog/*.mdx` — one post (`why-onsite-safety-training-matters`,
  front-matter `title, date, excerpt, author`).
- `src/lib/faqs.ts` — five site-wide FAQs; `public/llms.txt` — hand-written.

**Deployment.** Vercel project `bhg-safety-partners`
(`prj_LzmsHCal8rkT1pYg4hqFt0civGtT`, team compassmarketin), production from
`main`, Node 24.x, latest production deployment `dpl_D7TJVj5XzdpHH85CgZySh6rGs6et`
READY (matches the PR #3 merge). Domains on the project: `bhgsafety.com`
(primary, 200), `www.bhgsafety.com` (redirects to the apex),
`bhgsafetypartners.com`, `www.bhgsafetypartners.com`, plus the vercel.app
aliases. **SSO deployment protection is on for everything except custom
domains** — a preview URL needs a Vercel login, which matters for client
review of the upgrade. Environment: `RESEND_API_KEY`, `CONTACT_TO_EMAIL`
(defaults to brad@bhgsafety.com), `CONTACT_FROM_EMAIL` (defaults to
noreply@send.bhgsafety.com) — values not read here.

**Live checks.** `https://bhgsafety.com/` 200 with canonical
`https://bhgsafety.com`; `sitemap.xml` on the live host lists home, about,
services, contact, locations, blog, 16 service pages and 1,680 + 17 location
pages; `robots.txt` allows all and names the AI crawlers explicitly;
`llms.txt` is served **but still gives the website as
https://www.bhgsafetypartners.com** (inconsistent with `SITE_URL`).

**CRM record.** Foundation complete (brand board *draft*, 16-row taxonomy,
94 keywords / 50 tracked / 8 money, 22 page groups — all 22 now have a
`target_url`), SEO pipeline complete (audit Sept 13, GBP spec, two citation
sheets, backlink prospects, tracking setup), Reporting active; **Website
pipeline not enrolled** (dropped at intake on Sept 13 when the site was
treated as client-controlled; the site row has since been recorded as
Compass-managed — resolve this on the Plan tab before the CRM runs the
upgrade, or run the pilot directly from BHG's Claude project). `sites`:
repo above, `branch main`, `vercel_project bhg-safety-partners`,
`domain_constant "https://bhgsafety.com"` (a URL where a host is expected —
normalise to `bhgsafety.com` when the row is next touched), `content_paths`
null (not on the monthly contract), audit JSON from Sept 13, 18
`change_log` rows, 7 open `placeholders`, 12 open tasks (9 Tom's: Google
access, GBP apply/photos, citations, outreach, GSC, GA4, two BrightLocal
reports; 3 CLAUDE: board snapshot, contacts, first sync). Drive `04
Website` holds the SEO Audit, GBP Spec, Citation Sheets, Backlink Prospects
and a filed blog draft ("OSHA 30 Certification: What It Actually Covers",
Sept 16, not on the site); `02 Brand` the Brand Board; `03 Keywords` the
Keyword Map and Tracked Keywords.

## 2. What exists and must be preserved

**Routes (all static).** `/`, `/about`, `/services`, `/services/[slug]`
(16), `/locations`, `/locations/[state]` (17), `/locations/[state]/[city]`
(1,680), `/blog`, `/blog/[slug]` (1), `/contact`, `/sitemap.xml`,
`/robots.txt`, `/llms.txt`. Every route declares `alternates.canonical`;
`metadataBase` pins absolute URLs to `SITE_URL`. Keep every service URL —
they are the `page_groups.target_url` values the keyword map and the
tracked list point at.

**Forms.** One server action `submitContactForm` (`src/app/actions/contact.ts`)
behind `useActionState`, used by four surfaces: the home/location split
section (`AboutContactSplit`), `/contact` (`ContactContent`), service pages
(`ServiceContactForm`) and location pages (via `AboutContactSplit` with a
`source`). Fields `company, name, email, phone, address, message`, a hidden
`source`, a honeypot `website`. Server-side validation with per-field
messages, `aria-invalid` and an `aria-live` status, a fallback message with
the phone and office@bhgspllc.com on provider failure, Reply-To = the
visitor. Delivery through Resend to `CONTACT_TO_EMAIL`. **Preserve the
fields, the `source` labelling and the recipient/sender configuration.**
Gaps against the Foundation contract: no submission id / provider
idempotency key (a retry or double click can send twice), no same-origin
check, no rate limit, no explicit focus management after a server error.

**Integrations.** Resend only. No analytics tag, no chat, no scheduling,
no reCAPTCHA. JSON-LD: `Organization` in the layout (Hannibal locality, no
street address, `sameAs` Facebook + LinkedIn), `FAQPage` on home and
service pages, `BreadcrumbList` on services, locations and blog,
`LocalBusiness` per city page with `areaServed` = the city and
`address` = Hannibal (one entity, no fabricated local address — keep).

**Design elements to preserve.** Palette orange `#F97316`, black
`#111827`, gray-light `#F9FAFB`, gray-dark `#374151` (the brand board's
sourced palette); Inter throughout; glass-card hero over a background
video (`public/hero-video.mp4`, autoplay/muted/loop, no poster); the
sticky, pulsing mobile "Get a Quote" button; the frosted nav that changes
on scroll with a Locations dropdown (17 states); dot/grid textures and
orange glows; the stats row; the "How we work" and FAQ accordion sections;
the single testimonial card; the footer (six service links — all valid
since PR #2 — and an "Areas served" list). Two real photos
(`safety-training.png`, `safety-professional.png`) and the logo files.

## 3. Foundation improvements that apply (module by module)

Adopt from `showmeelectricalwebsite@94014af` **only what is compatible with
this Next 16 / Tailwind 4 tree**; copying is not automatic compatibility.
Never replace BHG's identity with Show Me's, never use Harbor Lane content.

| Area | Finding at `9c5766d` | Foundation module to adopt / adapt | Standard |
| --- | --- | --- | --- |
| Motion | Hero video autoplays with no poster and no `prefers-reduced-motion` handling; the mobile CTA pulses forever; `tw-animate-css` transitions with no reduced-motion variant; nav underline/dropdown transitions everywhere | Reduced-motion fallback (video paused + poster; pulse off), critical text visible before hydration, no entrance animation that hides painted content (`immediateDeadlineMs` pattern), CSS-only hover/focus | Build Standard §3 |
| Accessibility | Lighthouse accessibility 86 (home) / 92 (service) on Sept 13 desktop runs, causes not recorded; FAQ accordion and Locations dropdown are custom (`role="menu"` on a link list); no skip link; focus styles inconsistent | Skip link, nav focus order, `browser.test.mjs`-style checks (no-JS content, reduced motion, 390 px overflow, 24 px targets, table headers), labelled `<dl>` fact lists | §10 UX |
| Performance | Hero MP4 on the LCP path; images are PNG (`safety-training.png` 1024 px) served via `next/image` in some places and `<img>` in others; no mobile lab run recorded (desktop 100/100 only) | Poster + lazy video, `next/image` everywhere with reserved space, mobile Lighthouse on home / service / city / article / contact templates recorded in the brief | §10 Performance |
| SEO | Canonicals, breadcrumbs, FAQPage and sitemap host fixed (PRs #2/#3); `llms.txt` still names the old domain; sitemap `lastModified: new Date()` on every build (truthful lastmod rule broken); `keywords` meta tags; titles on 1,680 city pages are templated | `lib/metadata.ts`-style page metadata with an owned default share image (none today), sitemap `lastmod` only from real content dates, drop `keywords` meta, a route manifest and the crawl (`scripts/qa/crawl.mjs`: one canonical, sitemap = manifest, no orphans, 404 on unknown) | §4 |
| Internal linking | Service pages link `relatedSlugs`; the hub lists courses; city pages link only the generic service grid; no article → service body links (the one post has none); footer carries "Areas served" as text | Hub → child, child → parent/alternatives, city → services actually offered, article body → service page, breadcrumbs as hierarchy; record parent/related/incoming per route | §6 |
| Local pages | 1,680 templated city pages with three swapped keywords each, no local material (audit finding 14: doorway-page risk); the keyword map has five served cities (St. Louis, Chicago, Houston tier 1; Indianapolis, Dallas tier 2) | The city gate: keep only cities with confirmed coverage **and** sourced distinctive material; everything else becomes plain text in a service-area hub (or a 301 to its state page / hub); physical location = none (service-area business, one entity) | §5, Library §5–6 |
| AI-agent usability | Facts are readable in HTML; `llms.txt` contradicts the live domain; no labelled fact list on city pages; forms lack duplicate-safe handling; FAQs render client-side (content present in HTML? verify) | Labelled `<dl>` facts (served: yes / office: no / run from Hannibal / phone), same facts in JSON-LD and copy, duplicate-safe inquiry action (provider idempotency key, explicit changed / in-progress outcomes), reading/navigation/mocked-inquiry task trial recorded with versions | §12, Library §15 |
| Forms | See §2 gaps | Server validation shared with the client, submission id bound to content, Resend `idempotencyKey`, mocked provider in every preview (`INQUIRY_DELIVERY=mock` pattern), readable success/failure states | §9 |

Not applicable / separate decisions: careers module (BHG has none), the
Foundation brand layer as a whole (a wholesale rebuild is Tom's separate
decision), GA4 (CRM task `ga4` is Tom's; analytics stays deferred), GBP
and citation work (SEO pipeline, Tom's tasks).

## 4. First implementation batch (prioritised) and acceptance checks

All work on `compass/preview-YYYYMMDD-bhgsafetypartners` from `main`,
one pull request against `main`, Vercel preview only. Mocked email in the
preview; no real inquiry. No deployment to production, no DNS, no domain
changes, no CRM row changes beyond attaching evidence when the CRM path is
used.

1. **Truthful basics (small, safe).** `public/llms.txt` → `https://bhgsafety.com`
   and the same facts as the Organization schema; sitemap `lastModified`
   only for the blog post's real date (omit elsewhere); remove `keywords`
   meta; add an owned default share image (needs an asset — see missing
   info) and Open Graph image metadata; normalise the CRM
   `domain_constant`. *Accept:* crawl passes on the preview (`--host
   bhgsafety.com --assets remap`): one canonical per page, sitemap =
   manifest, no orphans, 404 on `/compass-404-probe`; `llms.txt` and
   JSON-LD agree with visible copy.
2. **Motion and accessibility safeguards.** Hero video: poster frame,
   `prefers-reduced-motion` → paused/hidden with the poster; mobile CTA
   pulse only when motion is allowed; nav dropdown and FAQ accordion
   keyboard-operable with visible focus and correct roles; a skip link
   before the header. *Accept:* the Foundation `browser.test.mjs` checks
   (ported or run against the preview) pass on `/`, `/services/forklift-operator-certification`,
   `/locations/missouri/st-louis`, `/blog/why-onsite-safety-training-matters`, `/contact`:
   no-JS content visible, reduced motion leaves nothing hidden or
   translated, no horizontal overflow at 390 px, targets ≥ 24 px, first Tab
   reaches the skip link.
3. **Duplicate-safe inquiry.** Add a content-bound submission id to the
   forms, pass `idempotencyKey` to Resend, return explicit outcomes for an
   unchanged retry (original result), a changed payload under a used id
   (refused) and an in-flight send (in progress); keep fields, `source`,
   recipients and the phone fallback; add same-origin and a per-instance
   rate limit; focus the first invalid field after a server error. *Accept:*
   a mocked-provider suite modelled on `scripts/qa/forms.test.mjs`
   (validation, lost response → original result, changed content → refused,
   double click → one send, server error → input preserved + focus) passes
   on the preview with delivery mocked; nothing is sent.
4. **Local pages under the gate.** Decide the five keyword-map cities:
   for each, record coverage confirmation and distinctive sourced
   material; build (or keep) a real city page only where both exist,
   with a labelled fact list, services actually offered there, and links
   to the service pages; retire the remaining ~1,675 templated pages
   (state pages become the service-area hub level; 301 removed city URLs
   to their state page) **only after Tom confirms** — this is the
   largest content decision in the batch and reversible via the PR.
   *Accept:* the page plan in the brief marks each city `planned` or
   `candidate` with its evidence; sitemap contains only kept routes;
   redirects verified on the preview; no fabricated local facts.
5. **Internal-link contract.** Article body links to the OSHA-30 General
   Industry service page; city pages link the services offered; hub ↔
   child links complete; `docs/route-manifest.md`-style manifest committed
   with parent / related / incoming per route. *Accept:* crawl reports no
   orphan and every incoming link source recorded.
6. **Performance record.** Mobile Lighthouse on home, a service, a kept
   city, the article and contact on the preview, before and after. *Accept:*
   numbers recorded in the brief (≥ 90 or a documented exception per
   template); LCP image identified and prioritised.

Evidence goes to the brief (`attachPreviewOutcome` shape): builder checks,
deferred checks (a browser may be unavailable in the Routine environment),
independent review (empty until ChatGPT/Tom records it), launch work (Tom's
merge and the production deployment are separate).

## 5. Missing information (do not invent)

- **Years of experience**: the site shows "45+" (about page, hero body) and
  "65+" (stats row); the brand board's hard rule says use "decades of
  combined experience" until BHG confirms. *Needs BHG.*
- **Testimonial provenance**: the "KW" quote on the home page is not in the
  claims table; keep it only with BHG's confirmation of who and when.
- **OSHA Outreach Trainer authorisation / DOL cards** for the four OSHA
  10/30 pages; **First Aid/CPR issuing body and validity**; **course
  durations, class sizes, prerequisites**; **pricing** (positioning
  decision) — the seven open `placeholders`.
- **Coverage confirmation and local material** for St. Louis, Chicago,
  Houston, Indianapolis and Dallas (and whether "nationwide" is to be
  claimed before Midwest framing — hard rule says Midwest first).
- **Photos**: two real photos exist; the brand build asks for six and a
  hero poster frame. *Needs BHG (Drive `Media` folder).*
- **Owned default share image** for social cards (none today).
- **Business identity**: the citation sheet found three domains and two
  street addresses circulating; the site's public-address policy is "no
  street address" — confirm before any address appears on the site.
- **Lighthouse accessibility causes** (86/92) — measure on the preview
  rather than guess.
- **Whether the Website pipeline should be enrolled** for BHG in the CRM
  (dropped at intake) or the pilot runs from BHG's Claude project.
- **Vercel preview protection**: whether to disable SSO protection on
  previews so BHG can review without a Vercel login.

## 6. How to run it

**Through the CRM** (after activation — `docs/compass-foundation-integration.md`):
enrol Website on the Plan tab, confirm the site row (`work_mode
upgrade_existing`, `branch main`), press *Generate build brief* on the
Foundation tab, then run `/foundation-worker BHG Safety Partners` or let the
fire chain reach Website › Build to 70%. The worker follows the playbook's
`upgrade_existing` path and attaches the preview to the stage.

**Directly in BHG's Claude project** (no CRM activation needed): use the
prompt in `docs/clients/bhg-safety-partners-session-prompt.md`. It pins
this brief, the Foundation SHA and the branch plan, and forbids production,
DNS and real email.
