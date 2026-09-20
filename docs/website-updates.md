# Website updates (decided Sept 14 2026)

Tom's calls, in his words: pace of two new pages and two refreshes per
client per month, a blog post **every week**, publish on Compass-built sites
without a look (one-click revert is the safety net), and the Astro line is
retired — his Next.js builds are the sites of record.

## What the monthly stage does

Runs on the 1st after the monthly report, per active client, from the same
evidence (weekly DataForSEO ranks, Search Console, audit findings, the page
plan, open placeholders, the brand board):

1. **Map first.** Every tracked keyword gets a `target_url`; every page group
   gets a URL. Groups with no page are the build list.
2. **Pick the month's work.** A city page for a tracked city with none; a
   service page for a group with no URL; a rewrite for a keyword at
   positions 4–20; FAQ additions from the questions Search Console shows;
   any open placeholder that now has material.
3. **Compass sites**: write the entries, run the checks, push; `site-push`
   creates the Vercel deployment (Vercel's own Git integration blocks the
   CRM's commits because the author is not a team member). The Brief lists
   what changed with links; "put it back" commits the previous tree and
   redeploys.
4. **Client-controlled sites**: the same pages and rewrites land as Google
   Docs in `04 Website` plus a `change_log` row for whoever runs the site.
5. **Blog**: one post a week per client, each tied to one long-tail keyword
   and one service page, in the brand voice, sourced claims only. Posted
   through the same file path; on client-controlled sites, a Doc.

Caps: 2 new pages + 2 refreshes a month, 1 post a week. Nothing invented:
a claim without a source is a placeholder, not copy.

## The content contract — one adapter per site (Sept 20 2026)

`src/lib/content-adapters.ts` is the reference; `sites.content_adapter` is
detected from the repository tree (`scripts/build-brief.mjs` with the
tree from `site-push {read: true}`), never inferred from another client's
site or from a template version. How a change reaches the site depends on
the adapter:

| Adapter | Shape | City page | Blog post | Service page / FAQ |
| --- | --- | --- | --- | --- |
| `lucas_json` | `data/locations.json` + `data/blog-posts.json` + `/service-areas/[city]` | push | push | pull request |
| `markdown_blog` | `content/blog/*.mdx` + JSON data files (BHG) | proposed document | push | pull request |
| `foundation_brand_content` | Compass Website Foundation v1: `brands/<brand>/content/*.ts`, `/service-area/[city]`, `/locations/[slug]` separate | pull request | pull request | pull request |
| `unsupported` | anything else, or a tree not yet inspected | proposed document | proposed document | proposed document |

A push names the site's recorded branch of record explicitly (never
`main` by habit); a pull request goes to a preview branch created from
that branch and targets it; a proposed document is a Google Doc in
`04 Website` plus a `change_log` row. Foundation typed content is
TypeScript — an entry is a typed object file and a registry import, built
and crawled on a preview before the PR opens; writing JSON into a typed
registry, or a served city into the physical-locations registry, is
refused (`assertWriteAllowed`).

### The `lucas_json` shape (from the Lucas repo)

`Compass2026/lucas_construction` is the reference. The stage writes data,
not components:

| Thing | Where | Shape |
| --- | --- | --- |
| City page | `data/locations.json` | `{ city, slug, heroH1, heroSub, geoRelevanceBlock, faqs[{question, answer}], schema }` rendered by `src/app/service-areas/[city]/page.tsx` |
| Blog post | `data/blog-posts.json` | `{ slug, title, description, datePublished, dateModified, blocks[] }` rendered by `src/app/blog/[slug]/page.tsx` |
| Service page | `src/app/services/<slug>/page.tsx` | hand-built; the stage opens a pull request with the rewrite rather than pushing to `main` |
| Sitemap / robots | `src/app/sitemap.ts`, `robots.ts` | read the data files, nothing to do |
| Canonical | `alternates.canonical` on every route | the repo's own rule: every new route declares its canonical |

A site is "on the contract" when it has those two data files, the two
dynamic routes, `sitemap.ts` and per-route canonicals. `site-push` commits
files to any repo and deploys the result on Vercel itself.

## Where each site stands (Sept 14 2026)

| Client | Repo | Stack | On the contract? | Gap |
| --- | --- | --- | --- | --- |
| Lucas Construction | `lucas_construction` | Next 16 App Router | **yes** | none — flip on first |
| BHG Safety Partners | `BHGSafetyPartners` | Next 16 App Router | adapter `markdown_blog` (Sept 20) | blog in `content/blog` (MDX) → push; `data/locations.json` entries render a templated city page with no local material → proposed document until the template carries real local content; `data/services.json` → pull request. Work mode `upgrade_existing`; see `docs/clients/bhg-safety-partners-upgrade-brief.md` |
| Pensacola Equipment Rentals | `pensacolaequipmentrentals` | Next 15 App Router | partly | equipment pages from `src/data/equipment.ts`; no locations file, no blog, no canonicals — add the two data files and routes |
| Show Me Electrical | `showmeelectricalwebsite` | Next 15 App Router — **the Compass Website Foundation v1 reference client** (`brands/showme`, accepted at `94014af`) | adapter `foundation_brand_content` on that repo; the live site is still the client's WordPress | client-controlled until the launch decision; after launch, pull requests only (typed content) |
| Show Me Design | `Show-Me-Design-Build-` | Vite + React Router SPA | no | the live site; blog in `posts.ts`, JSON-LD in `seo.ts`, no sitemap / robots (audit findings) — client-controlled path until rebuilt in Next |
| Ginger Huff Interiors | `gingerhuff-website` | Vite React single page | no | one `App.tsx`, no routing — rebuild in Next on the contract |
| Logic Solar | `Logic-Solar` | Vite + React Router SPA | no | city data in `src/data/locations-solar.json`, pages in `src/pages` — client-controlled path until rebuilt |
| Shewmaker Brothers Masonry | `shewmakerbrothersmasonry` | Astro (the starter's origin) | no | blueprint record; Tom decides |

Order to flip on: Lucas now; BHG after the blog adapter; Pensacola after
its data files exist; the rest as Tom finishes each Next.js build.

## Retired Sept 14 2026

The Astro proposal builds for Lucas, Ginger Huff and Pensacola: Vercel
projects `lucasconstruction`, `gingerhuffinteriors`,
`pensacolaequipmentrentals-astro` deleted; the `compass-astro` branch on
`pensacolaequipmentrentals` deleted; `sites` rows point at the Next.js
repos and Vercel projects (`lucas-construction`, `gingerhuff-website`,
`pensacolaequipmentrentals`). The repos `Compass2026/lucasconstruction`
and `Compass2026/gingerhuffinteriors` need Tom's admin rights to delete.
`templates/astro-site/` stays in the repo only as the source of the SEO
scaffolding to port; the worker no longer builds from it. Since Sept 20
2026 new builds come from the Compass Website Foundation
(`docs/compass-foundation-integration.md`).
