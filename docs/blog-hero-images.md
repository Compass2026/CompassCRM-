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
- site-push's content-entry exception accepts the image only as a
  content-addressed file directly inside the recorded folder
  (`content_paths.blog_images`, default `public/blog/images`), on JSON blogs.

## Site contract

`compass-blog.json` stays `version: 1` (hero-less articles publish to existing
sites exactly as before). A hero article additionally requires:

```json
{ "hero_image": true, "hero_image_dir": "public/blog/images", "hero_image_url_prefix": "/blog/images/" }
```

A site without them **refuses** the article ("needs the Compass blog hero
image upgrade") rather than publishing it without its image. The folder must
match the site row's `content_paths.blog_images` (default above). The
Markdown adapter refuses hero articles.
