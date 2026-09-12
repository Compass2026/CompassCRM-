# Compass Astro starter

The site every Compass client starts from. Copy this directory into the
client's repo, fill `src/config/site.ts` from the CRM, build, run the gate,
push. The quality bar lives in the layout and components, not in anyone's
memory: every page gets a canonical, one H1, JSON-LD, breadcrumbs; every
service and city page gets an answer-first section, a FAQ with FAQPage schema,
and a facts block; the site gets `llms.txt`, `robots.txt` and a sitemap.

```
npm install
npm run build
npm run gate -- --phone "<the one phone number>" --name "<Business Name>"
```

`npm run gate` runs `scripts/site-quality-gate.mjs` from the CRM repo against
`dist/`. It must pass before Build to 70% is complete. Placeholders are
counted, never failed — a 70% build is expected to carry them.

## Filling it

Everything comes from `src/config/site.ts`, typed in `src/config/types.ts`:

| Config | CRM source |
| --- | --- |
| `business` | `clients` (name, phone, city/state, service_area), `brand_boards.hard_rules` |
| `brand` | `brand_boards.palette` / `typography`, `client_brands` (tagline, positioning, cta) |
| `facts` | `claims` where `status = 'sourced'` **only** — never unverified |
| `services[]` | `services` (approved) + their `page_groups` primary keyword + `keywords` |
| `cities[]` | `page_groups` where `page_type = 'city'` with `city_tier` |
| `placeholders[]` | mirrors the `placeholders` table — one row per visible block |

Rules the components enforce, so you do not have to:

- One phone number. It is `business.phone` and appears nowhere else.
- No street address unless `business.address.street` is set (service-area
  businesses leave it unset; schema then uses `areaServed`).
- Facts blocks only render entries with a `source`. An entry without one is a
  build error.
- Every `<img>` needs `alt`. Missing images are `<Placeholder>` blocks.

## Structure

```
src/config/site.ts        the single source of truth
src/config/types.ts       its shape
src/lib/schema.ts         JSON-LD builders (LocalBusiness, Service, FAQPage, BreadcrumbList)
src/layouts/Base.astro    head (title, meta, canonical, OG), tokens, header, footer, JSON-LD
src/components/           Breadcrumbs, Answer, Faq, Facts, Placeholder, ServiceCard, Cta
src/pages/                index, about, contact, services/, areas/, 404, llms.txt, robots.txt
src/styles/global.css     tokens from brand.colors + typography, base styles
```

Fonts load from Google Fonts by family name; swapping to self-hosted
Fontsource packages is a Polish-stage task.
