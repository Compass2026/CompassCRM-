# Creative Lab (Preview Mode)

Decided Oct 8 2026. Explore freely → choose → promote to review → a human
approves → publish. Approval friction is removed from exploration only.

## What Preview Mode allows without an approval
- Market / industry signals: an advisory packet per client
  (`lab/<client>/market-signals-*.md`).
- The **proposed** Social Style Profile, used as a soft style signal: voice,
  hooks, sentence rhythm, how much personality, CTA phrasing, emoji, hashtags
  and presentation. It never decides topics, services, keywords, intent,
  claims, places, offers, E-E-A-T evidence or strategy. Once a profile is
  approved, the influence rule in `docs/social-history.md` governs it.
- Concepts, copy variations, graphic variations and regenerations: all of
  these are working material.
- Lab layouts (`scripts/lib/creative-lab-layouts.mjs`) and any registered
  family, with no template registration or client template approval needed
  for a preview.

## What it never relaxes
- **Precedence:** Truth / Client Intelligence / E-E-A-T → Authority → search
  intent → market signals → brand rules → Social Style → creative
  presentation.
- **Copy** goes through the AI Drafter's own `buildBrief`: approved service,
  live approved target page, usable claims, approved places. It also goes
  through `lintDraft` and the client's creative-kit phrases.
- **Facebook copy** takes the same factual rules; only the Business Profile
  channel limits are not applied.
- **Images** go through the Creative Engine's `render()`. Every word is a
  governed role, and every photo is an approved own-work file, re-hashed and
  never enlarged. A claim the Drafter excludes is refused on an image too.
- **Nothing is written.** The lab writes nothing to the database, Storage,
  Zernio or Google, and nothing is created, approved, scheduled or published.

## Pieces
- **`supabase/functions/creative-lab`** (read-only; team JWT or
  `x-cron-secret`). Its `sources` mode returns five-minute signed links to a
  client's renderable sources: approved, hashed and stored files, no people
  imagery, the primary logo. Tests: `tests/creative-lab.test.mjs`.
- **`scripts/creative-lab.mjs`** renders a sprint file
  (`lab/<client>/sprint-NN.json`: strategy, copy, creative references) into
  PNGs plus `results.json`. It ignores any downloaded file whose bytes do not
  match a reviewed hash.
- **The review board.** A teammate reviews the sprint on a private board
  page and iterates in conversation, for example "#3 shorter", or "photo from
  #5 with the copy from #2".

## Promotion
A chosen piece is promoted into the governed workflow; nothing else changes:
- **Business Profile:** an AI Drafter `submit` with the chosen copy and its
  claims. This is the same brief and linter, so a lab piece that passed
  passes again. It becomes a draft post in review.
- **Images:** the creative is a Creative Engine `post` render from a
  registered template that a teammate has approved for the client. A lab
  layout is registered as a template version first.
- **Facebook:** a teammate creates the post on the Social tab.
- From there, the existing grounding, claims, content hash, creative hash,
  review and publisher protections apply unchanged.

## Lucas Sprint 01 (Oct 8 2026)
- Six concepts: transactional quote, commercial proof, an informational fall
  check, a project-experience post, a timely Missouri storm-claim myth post,
  and a customer FAQ. Each has Facebook and Business Profile copy and a
  render.
- Every piece passed the Drafter brief, the linter and the render
  governance.
- Running the sprint found a linter bug: `mask()` split text by code point
  while spans are UTF-16 indices, so emoji shifted the masks. It is fixed in
  `post-drafter/rules.ts`. The deployed `post-drafter` still has the old
  `mask()` until it is redeployed.

## Lucas visual direction (decided Oct 9 2026)

Baselines come from Sprint 02:
- **4H** for project and jobsite posts: one large real photo, minimal design,
  and a small contextual label only when it helps.
- **6H** for information that genuinely benefits from design: credentials,
  warranties, myth / fact, comparisons and checklists. These are the
  exception.
- **3H / 3N** for educational and photo-detail posts: the image does the work.
  A very small hook such as "Look closer" is fine.

Principles for every Lucas creative:
1. Real Lucas photography is the default creative.
2. A designed graphic needs a reason to exist.
3. Do not turn every post into a branded advertisement.
4. Keep logos and branding restrained.
5. Do not bake phone numbers, URLs or CTA buttons into every graphic. The
   lab's card layouts (`lab-card-facebook`, `lab-card-gbp`) are the
   credentials card without them.
6. Tell multi-photo stories with real albums / carousels, one render per
   photo, rather than squeezing several photos into one graphic.
7. Credentials, checklists, comparisons, myths / facts and similar
   information may use designed cards.
8. Educational and project content usually stays photo-first.

Copy direction, from Sprint 03:
- Facebook reads like a knowledgeable Lucas team member talking to a
  homeowner. Some posts simply teach, show the work, tell a story or answer
  a question.
- Do not force a claim or credential into the prose because it is
  available. A post must still never state anything that is not grounded.
- Avoid repeated patterns: formula transitions ("Here's our answer"),
  identical CTA blocks, a checklist in every post, emoji openings.
- Business Profile copy stays tighter, service- and search-oriented.

Before a lab layout or label is used for publishing, it becomes a
registered template version (with its labels) and is approved for the
client, as any template is.
