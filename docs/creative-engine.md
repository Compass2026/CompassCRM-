# Creative Engine renderer (Sept 30 2026)

This is the deterministic renderer for the Creative Engine, plus the Lucas
template pilot. It is built on 0054's schema and write boundaries (the
Creative Engine function's session: `creative_register_template`,
`creative_begin_run`, `creative_write`, `creative_fail_run`) and on 0055's
source governance.

**Status:**

- **Built and tested:** the renderer, the specs, the Edge Function code
  (including graphics for posts, Oct 3 2026), the preview page with template
  approval, and the post page's Graphic section.
- **Not done:**
  - Migration 0057 is written and sandbox-tested, but **not applied**.
  - The Edge Function is **not deployed**.
  - **No template is registered.**
  - Lucas's creative policy is untouched (no `client_creative_settings`
    row).
  - No run, asset, post, approval or publishing exists.

## Architecture

```
request (references only) ──► govern.ts ──► render.ts ──► PNG + brief + hashes
  template key/version/spec_hash      │ resolves every word from the record
  service_id, bindings by role+id     │ checks photos' creative-use review
  photo asset ids                     │ crops at the reviewed focal point
                                      ▼
              handler.ts (creative-engine function)
              plan: dry run, no writes
              preview: creative_begin_run → upload (content address) → creative_write
```

### Files in `supabase/functions/creative-engine/`

| File | What it is |
|---|---|
| `spec.ts` | Template spec types; `jsonbText` / `specHash`, byte-identical to Postgres `creative_spec_hash` (proved in the sandbox for all 15 specs); the spec lint (palette only, WCAG contrast, canvas, safe area). |
| `families.ts` | Fixed design structure of the five cleared families on the two canvases: geometry, type roles, spacing, footer, logo tile, CTA. |
| `kits.ts` | The client's approved creative system (palette, pinned fonts, the approved logo asset, phrases the client has ruled out). Never a claim, service or contact detail. |
| `registry.ts` | The template versions this code renders (`lucas-<family>-<gbp|facebook|instagram>` v1). |
| `govern.ts` | Turns references into governed lines and photos, or refuses with a code. |
| `crop.ts` | Focal-point cover crop that never enlarges a photo. |
| `text.ts` | Glyph-level measuring and wrapping from the pinned fonts. Copy that does not fit is refused, never shrunk. Text is emitted as SVG paths. |
| `render.ts` | Composes the SVG, rasterises it with resvg, checks the PNG, and hashes it. Holds the pinned versions. |
| `handler.ts` / `store.ts` / `index.ts` | The Edge Function: modes `version`, `register`, `plan`, `preview`, `post`. |
| `post-bindings.ts` | A post's creative: which governed references fill a template's slots (the post's service and linked claims) and which approved photos fill its photo slots. |
| `previews.ts` | The Lucas preview set (references only). |
| `fonts.generated.ts` | Embedded, hash-pinned font files (from `scripts/creative-fonts.mjs`). |
| `deno-check.ts` | Cross-runtime check against the Node goldens. |

### Determinism

- **Pinned rasteriser:** resvg-wasm 2.6.2. The WASM is refused unless its
  SHA-256 is
  `22bf6e9f9a100d972da0411a69c5ba504367fc1fa87b3b64e3f35e53926d2d70`.
- **Pinned fonts:** opentype.js 1.3.4. Montserrat 700 / 800 and Poppins 500 /
  600 are embedded (Latin, @fontsource 5.3.0, OFL), each checked against its
  SHA-256 when the engine starts.
- **Text as paths:** no font shaping happens in the rasteriser.
- **Renderer id:** `creative-engine/1 resvg-wasm@2.6.2 opentype.js@1.3.4`,
  recorded on every run.
- **Same inputs, same bytes,** from a second engine, and **in Deno
  byte-identical to Node**. `deno-check.ts` renders the four golden
  templates as `index.ts` wires the engine; all four hashes match
  `tests/fixtures/creative-golden.json`.
- **Hashes recorded:**
  - **Spec hash:** `creative_spec_hash`.
  - **Source hashes:** each source file is re-read and re-hashed at render
    time, and refused if it differs from the reviewed hash.
  - **Copy hash:** SHA-256 of the resolved lines. A request may pin it.
  - **Brief hash:** `creative_spec_hash(brief)`. The brief holds the
    template, every line with its source id, every photo with its hash,
    focal point and crop, the logo hash, the copy hash and the renderer.
  - **Output hash:** SHA-256 of the PNG, which is also its storage
    address.

### What a render may say and show

**Words:** every line is resolved from the record, by role and source id.
The caller never passes text; a request with a text field is refused.

| Role | Source |
|---|---|
| `business_name` | `clients.name` |
| `service_name` | an approved service's name |
| `service_segment` | an approved service's segment |
| `tagline` | the client brand's tagline |
| `standing_cta` | the brand board's standing CTA |
| `claim` | confirmed, or sourced with a source |
| `phone` | `clients.phone` |
| `website` | `clients.website_url`, shown without scheme / `www.` |
| `template_label` | a fixed label in the spec: "Our work", or a season |

**Refused lines:**

- **Compass-wide phrases** (`GLOBAL_BLOCKED`): free, 24/7, same-day,
  licensed / bonded / insured, counts ("500+ roofs"), founding years,
  reviews / stars / ratings, superlatives (#1, best, premier, …),
  guarantees, prices, urgency, emergency, street addresses.
- **The client's own ruled-out phrases** (the Lucas kit):
  - warranty, pending the owner's confirmation
  - inspections
  - St. Louis County / Greater St. Louis, Chesterfield, Ballwin, Wildwood,
    Florissant
  - locally owned, family owned / operated
  - "storm chaser" and the brand board's other avoided words
- **Too many words:** headline ≤ 6 words, eyebrow ≤ 5, subline ≤ 12,
  points ≤ 8 each.
- **Too long for the box:** a line that does not fit its box at the spec's
  fixed size and line limit.

**Photos.** A photo is used only when all of these hold:

- `creative_use = 'approved'` and `depicts_own_work = true`
- the stored bytes still hash to the reviewed hash
- a reviewed focal point exists
- no people subject tags (people imagery waits for a consent record)
- the subject tags show the creative's service (e.g. `roof` for Roof
  Replacement)

A hero slot also needs a short side of at least 1,080 px (the quality gate).
No slot ever enlarges a photo: a region smaller than the slot is refused, so
a marginal photo cannot become a hero.

**Logo:** the kit's approved primary logo, always on its charcoal tile.

**Nothing falls back.** A missing, withdrawn, unreviewed, excluded or
changed source, a missing governed value, a template version mismatch or a
copy hash mismatch each refuse the render with a code. There is no default
text and no stock image.

## Templates (Lucas, v1)

There are five families, each on Business Profile 1200×900 (4:3) and a
1080×1350 (4:5) social canvas. The social canvas is registered once for
Facebook and once for Instagram, because 0054 keys a template to one
channel; the two layouts are identical.

**Canvas choices** were checked against the platforms' published guidance
(Sept 2026):

- **Business Profile:** recommended 1200×900, JPG / PNG, 10 KB – 5 MB.
  Text, logo and CTA stay in the central 900×900 so square crops keep them.
- **Instagram / Facebook:** 4:5 is the tallest ratio the Instagram API
  accepts. Content stays at least 72 px from the sides, because the 3:4
  profile grid trims about 34 px on each side.

| Family | Structure | Governed slots | Photos |
|---|---|---|---|
| Service Spotlight | Photo (GBP: right half; social: top 790 px) with a Lucas-blue rule; text column on charcoal | eyebrow (segment / business), **headline** (service / claim), subline (claim / tagline), points (claims, GBP only), CTA | 1 hero (≥ 1080) |
| Trust & Know-How (authority mode) | Photo panel; a credential as the headline; checked points | eyebrow (business / segment), **headline** (claim), points (2–3 claims), CTA | 1 feature (no upscale; social needs ≥ 1080 wide) |
| Seasonal (non-offer) | Season label, service, one governed line; a two-photo row | eyebrow (a season label), **headline** (service), subline (tagline / claim), CTA | 2 cells |
| Real Work Showcase | Own-work mosaic (GBP 3, social 4); label "Our work"; the service; no location | eyebrow ("Our work"), **headline** (service), CTA | 3 / 4 cells |
| Service Light | Light ground, charcoal type, rounded hero and two support photos; charcoal footer | eyebrow, **headline** (service), subline, CTA | 1 hero + 2 cells |

**Shared across every family:**

- **Footer band:** panel colour and a Lucas-blue rule; the v3 wordmark on a
  charcoal tile with a Lucas-blue keyline; the governed phone in sky blue;
  the website in muted text.
- **CTA:** "Request a quote" (the standing CTA) in a pill, set in
  Montserrat caps.
- **Palette:**

  | Colour | Hex |
  |---|---|
  | Charcoal | `#0d0f10` |
  | Panel | `#1a1d1f` |
  | Lucas blue | `#128fb1` |
  | Sky | `#72d2e4` |
  | Text | `#f0f4f8` |
  | Muted | `#8fa3b1` |

  The lint refuses any other colour and any text below 4.5:1 contrast
  (3:1 for large text).
- **Type:** Montserrat 800 caps for headlines, 700 for eyebrows; Poppins
  for supporting text.

**Not built:**

- Trust & Know-How's educational mode: it needs approved educational copy.
- Real Work's single-aerial hero layout: there is no aerial own-work photo.
- Review Spotlight, Team & Community and Offer mode: these stay blocked.

## Migration 0057 (written, sandbox-tested, not applied)

0054's overlay record allows three lines from six roles. The approved
layouts draw up to nine: the phone and website on every render, a segment
eyebrow, a template label, and claims in previews. Recording fewer lines
than are drawn would make the record wrong, so 0057:

- Replaces `creative_overlay_problems`:
  - Adds the roles `phone`, `website`, `service_segment` and
    `template_label` (a label of the template named by `source_id`). Each
    must still equal its source.
  - Lets a template preview show a usable claim of the client.
  - Allows up to 12 lines; the primary line stays ≤ 8 words.
- Moves `creative_assets_overlay_bounded` to 12 lines.

No table, grant, policy or write boundary changes. Its tests are
`supabase/tests/sandbox/creative_overlay_roles.test.sql`. They also prove
the renderer's spec hash equals Postgres's for all 15 Lucas specs.
**Apply only on approval.**

## Previews and template approval

**Brand › Creative use › Creative previews**
(`/clients/<id>/brand/creative-preview`) renders the Lucas preview set on
request with the signed-in teammate's own session. The image route is
`…/creative-preview/<template key>`.

- **Same renderer:** the output is byte-identical to the renderer tests
  (checked by the browser test).
- **Viewing writes nothing:** no run, asset, template, client template,
  post, event or policy.
- **Refusals show on the page,** with no fallback image.

Under each preview, per channel (the 4:5 layout once for Facebook and once
for Instagram, since 0054 keys a template to one channel):

- **Record preview for approval** calls the function's `preview` mode with
  the teammate's JWT: a `template_preview` run and asset, and a `proposed`
  `client_creative_templates` row. Shown once the version is registered and
  its registered spec equals this code's.
- **Recorded preview** opens the stored bytes (`/clients/<id>/creative/<asset
  id>`, re-hashed on the way out).
- **Approve for this client** / **Revoke** update the row as the teammate,
  conditional on the status they saw; 0054's guard requires a current
  preview and stamps `approved_by`.

**Graphic policy for new posts** sets `client_creative_settings` per channel
(none / optional / required). Existing posts keep their own policy.

## Graphics for posts (`post` mode, Oct 3 2026)

A teammate turns a draft post into one with a rendered graphic from the post
page (**Social › post › Graphic**):

1. **Policy:** on a draft, *No graphic* / *Graphic optional* / *Graphic
   required* (`social_posts.creative_policy`; a teammate's change, drafts
   only). *Required* blocks approval until a graphic is linked.
2. **Generate graphic:** pick a template approved for the client on the
   post's channel. The CRM calls the function with the teammate's JWT:
   `{mode: "post", post_id, template: {key, version, spec_hash}}`. The
   request carries no words, claims or photos.
3. **What the function decides** (`post-bindings.ts`):
   - **Service:** the post's service is the topic. Service-led families
     refuse a post without one (`post_service_missing`).
   - **Claims:** only claims linked to the post, in link order, confirmed
     or sourced-with-source, and free of blocked language. A claim the copy
     may cite but no creative may carry (the warranty, review counts) is
     left off. Trust & Know-How needs a headline claim plus two points:
     three usable linked claims, else `not_enough_claims`.
   - **Other lines:** the eyebrow is the service segment (else the
     business name). The subline is the tagline or a linked claim. Seasonal
     takes the season of the post's Central date (never "storm season").
     Real Work uses the "Our work" label.
   - **Photos:** for each slot in order, the largest approved own-work photo
     of the service that fills it without enlarging (hero ≥ 1080 px), no
     people, no repeats. No photo means `no_eligible_photo`, never a
     stand-in.
4. **Writes, all through 0054's functions:**
   - `creative_begin_run` with `purpose: post`. The `copy_hash` is
     `drafter_copy_hash(copy)`, and the brief carries
     `post: {id, copy_hash, creative_version}`, so a new copy or a new
     version is a new run and a repeat is the same run.
   - The upload at the content address.
   - `creative_write`, which checks the overlay against the post's own
     service and linked claims (0057), links the image (`post_assets`,
     role `primary`), sets `creative_status = ready` and bumps
     `creative_version`.
   - The post stays a draft until a teammate submits it.
5. **Review:** the reviewer sees the image. **Approve** binds its content
   hash in `approved_snapshot.creative`. **Reject** asks whether the copy,
   the graphic or both are rejected (`rejection_category`, required by
   0054 when a graphic is linked).
6. **Request new graphic** (in review, approved, or rejected for the
   graphic) calls `request_new_creative`: it keeps the copy, unlinks the
   graphic and returns the post to draft.
7. **Delivery without the publisher:**
   - **Download PNG** serves the exact recorded bytes, re-hashed, named
     `<client>-<template>-<hash12>.png`.
   - An approved post also has **Copy text**.

## Runtime

Full readiness note: `docs/creative-engine-runtime.md`.

| Where | Render time | Memory |
|---|---|---|
| Node (tests) | 15 renders, slowest 986 ms (compose + rasterise); most 300–650 ms | RSS 219 MB for the whole test process |
| Deno 2.1, photo-like JPEGs at Lucas's sizes | 0.53–1.44 s for a first render; 0.38–1.17 s warm | peak RSS 165–216 MB per process (the runtime is ~89 MB of that) |

- **Supabase Edge limits:** 256 MB memory and **2 s CPU per request**.
- **The 1080×1350 formats are the risk.** Their cold renders take
  1.15–1.44 s, above the 1.0 s (50%) margin the note sets. Almost all of
  it is resvg's high-quality resampling of the photos.
- **Before deploying:** the note's `measure` protocol. `plan` does not
  rasterise.
- **If production CPU is tighter than measured here:** use the reductions
  in the note, or move rendering to a Node host with more CPU (the
  renderer is runtime-neutral and byte-identical) and keep the writes in
  the Creative Engine's database session.

## Tests

| Command | What it covers |
|---|---|
| `npm test` | Includes `tests/creative-engine.test.mjs` (21), `tests/creative-engine-handler.test.mjs` (16) and `tests/creative-engine-post.test.mjs` (6): specs and lint, jsonb hash, crop, text, governance refusals, determinism, goldens, pixel checks (focal point and footer), handler auth, dry run, refusals before writes, write path, idempotency, retry after failure; post mode's refusals, run binding and every Lucas template on a roofing post; the post picker's claims, photos and seasons. |
| `npm run test:sandbox` | Includes `creative_overlay_roles.test.sql` (21). |
| `npm run test:creative-preview-ui` | The page and route in a real app session over the sandbox (7 checks). |
| `npm run test:creative-post-ui` | End to end over the sandbox with the real handler and store: register, record a preview, approve it, set the channel policy, render a post's graphic, download the exact bytes, submit and approve (snapshot binds the hash), request a new graphic, reject the graphic alone, portal / anonymous refused, phone width (9 checks). |
| `deno run --allow-net --allow-read --allow-env supabase/functions/creative-engine/deno-check.ts` | Cross-runtime check. |

**Regenerate** (only with a new renderer or template version):

- `node scripts/creative-fonts.mjs`
- `node scripts/creative-templates-fixture.mjs`
- `CREATIVE_WRITE_GOLDEN=1 node --test tests/creative-engine.test.mjs`

## To go live (each step on Tom's approval)

1. Apply 0057; verify it with the recorded SQL md5 and the probes.
2. Deploy `creative-engine` through `deploy-supabase-function.yml` (it is
   on the function list); check it with `{"mode": "version"}` and a `plan`
   of each 1080×1350 template (its `ms` shows the render time against the
   2 s CPU limit).
3. `register` the approved template versions (`{"mode": "register"}` with
   a teammate's JWT or the cron secret).
4. On **Creative previews**, **Record preview for approval** for each
   template and channel Lucas will use.
5. A teammate opens each recorded preview and **Approves** it for Lucas.
6. Set Lucas's **Graphic policy for new posts** per channel on the same
   page.

From then on a teammate renders graphics on draft posts (above).

Publishing stays with the existing publisher and its switch.
