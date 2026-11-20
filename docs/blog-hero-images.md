# Blog hero images

One reviewed hero image per blog draft (migration `20261016173307_blog_hero_images.sql`, applied Oct 16 2026; the file was written as 20261015210000 and renamed to the version production recorded).

## What a hero is

- `content_drafts.hero_asset_id` + `hero_alt`, set together. The asset must be
  a brand asset of the **same client** (composite FK), **stored and hashed**
  (`storage_path`, `content_hash`), kind **`photo` or `social_post`**, a PNG /
  JPEG / WebP with recorded dimensions, and (for multi-brand clients) assigned
  to the draft's brand workspace.
- A `social_post` asset is a generated graphic: **non-evidentiary**. The draft
  page labels it "Illustrative graphic, not a photo of the client's work" and
  shows its provenance (label, notes, source, hash). The article carries
  `illustrative: true`; it is never a claim, a source or E-E-A-T evidence.

## Who sets it, and what it invalidates

- **Team:** the Hero image panel on the draft page
  (`/clients/[clientId]/drafts/[draftId]`), beside the copy. Only on a
  draft or rejected draft (withdraw or reopen first), exactly like a content
  edit.
- **Drafter:** optional `hero_asset_id` / `hero_alt` in the `submit` payload's
  `draft`. The function checks the asset (`hero_refused`, 422) and writes the
  hero and the content in one transaction (`content_draft_write_with_hero`).
- Every change bumps the draft version (`content_drafts_hero_guard`), so an
  open review or a pinned approval no longer matches. Reopening an approved
  draft clears its approval as before.
- `content_draft_approve` adds `hero` (asset id, content hash, alt, kind,
  illustrative, file facts) to the approval snapshot, so `approved_hash`
  covers it. Hero-less drafts get no `hero` key and hash exactly as before.
- `blog_publication_problems` blocks a release whose hero file, kind or alt
  changed since approval, or that no longer qualifies.

## Delivery: the file is copied into the site repository

Chosen pattern: **copy the image into the site repo in the same site-push
commit as the article**, not a storage URL. `brand-assets` is a private
bucket; its signed URLs expire and a public URL would make the CRM's storage
part of the client's website.

- Path: `<hero_image_dir>/<slug>-<first 12 hex of content_hash>.<ext>`
  (content-addressed, so a retry finds the same file; a different file at the
  path refuses).
- blog-publisher downloads the approved file, refuses if its sha256 differs
  from the approved `content_hash`, and pushes it base64 with the JSON. The
  expected-head, release-hash and live-verification checks are unchanged; live
  verification also requires an `<img>` with the approved src and alt.
- Article JSON: `heroImage: { src, alt, width, height, illustrative }`.
- Markdown post (`markdown_blog`, Nov 2026): the same fields as a
  `hero_image` block mapping at the end of the front matter, after
  `keyword_id` (values JSON-quoted like the other keys):

  ```yaml
  hero_image:
    src: "/blog/images/<slug>-<hash12>.webp"
    alt: "…"
    width: 1920
    height: 1080
    illustrative: true
  ```

  A hero-less post is byte-for-byte what the adapter wrote before. Alt text
  with a line break or control character refuses (manual review).
- site-push's content-entry exception accepts the image only as a
  content-addressed file directly inside the recorded folder
  (`content_paths.blog_images`, default `public/blog/images`), on JSON,
  Foundation posts-file and Markdown blogs. On a Foundation site the image
  must travel with the posts file, and on a Markdown blog with its own post
  (`<blog_dir>/<slug>.mdx` in the same request); an image alone, or beside a
  different post, is not a data entry.

## Site contract

`compass-blog.json` stays `version: 1` (hero-less articles publish to existing
sites exactly as before). A hero article additionally requires:

```json
{ "hero_image": true, "hero_image_dir": "public/blog/images", "hero_image_url_prefix": "/blog/images/" }
```

A site without them **refuses** the article ("needs the Compass blog hero
image upgrade") rather than publishing it without its image. The folder must
match the site row's `content_paths.blog_images` (default above).

The same keys opt a **Markdown blog** in (`adapter: "markdown_blog"`); a
Markdown site without them refuses a hero article exactly like a JSON site.
The site renders `hero_image` from the front matter with its width, height
and alt, and shows no automatic "Illustration" caption for an illustrative
hero (the flag stays internal; the alt text carries the description). A
Markdown post has no TL;DR slot, so an article with both a TL;DR and a hero
still refuses on a Markdown blog (the summary must sit above the hero).

Opted in: `Compass2026/BHGSafetyPartners` (bhgsafety.com), once its
`compass/blog-hero-support` PR is merged. `BHG-Heavy-Equipment` and
`BHG-Forklift-Training` have not opted in and refuse hero articles.

**Release order** for a Markdown site: after the CRM merge, deploy
`site-push` first (it bundles `src/lib/content-adapters.ts`, which accepts
the image), then `blog-publisher` (it bundles
`content-drafter/publication.ts`, which writes it); then merge the site's PR
so its `compass-blog.json` advertises `hero_image`. A new publisher talking
to an old site-push would have its push refused after authorisation and the
release marked uncertain, so site-push goes first. An opted-in site with an
old publisher simply refuses the hero article before writing.
