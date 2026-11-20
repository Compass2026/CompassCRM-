// A pure, lossless delivery contract. The site must explicitly advertise the
// contract; old Lucas renderers only display plain text and would lose links.
//
// Hero images (20261015210000): an approved hero is copied INTO the site
// repository in the same commit as the article, at a content-addressed path
// (<images dir>/<slug>-<hash12>.<ext>), and the article carries
// heroImage {src, alt, width, height, illustrative}. The site must advertise
// `hero_image: true` and the folder it serves; an older site refuses the
// article rather than publishing it without its image. A storage URL is never
// published: brand-assets is a private bucket and its signed URLs expire.
//
// TL;DR (tldr.ts, Oct 18 2026): an approved summary is delivered exactly once.
// A site advertising `tldr: true` gets the article's `tldr` field and renders
// it between the H1 and the hero; any other site gets it as the first
// paragraph of the body (`**TL;DR:** …`). Releases approved without one are
// delivered exactly as before.
//
// Foundation v1 (foundation_brand_content, foundation-blog.ts, Nov 2026): the
// article is a typed Article appended to the site's generated posts file
// (compass-blog.json `posts_file`), its body converted from the approved
// restricted Markdown to the site's Block[] types. No hero (client
// photography only), no author, no TL;DR slot (the summary is the first
// paragraph of the body). Title = the approved H1; seo.title = the approved
// meta title (the page's <title>, og:title and twitter:title).
import { bodyWithTldr } from "./tldr.ts";
import { blockHrefs, checkFoundationContract, FOUNDATION_ADAPTER, foundationHref, foundationPostsFile, markdownToBlocks,
  readCompassPosts, writeCompassPosts, type Block, type FoundationArticle } from "./foundation-blog.ts";
export type BlogHero = {
  asset_id: string; content_hash: string; alt: string; kind: "photo" | "social_post"; illustrative: boolean;
  mime_type: string; width: number; height: number; size_bytes: number; storage_path: string;
};
export type BlogRelease = {
  draft_id: string; client_id: string; version: number; keyword_id: string;
  title: string; slug: string; meta_title: string; meta_description: string;
  h1: string; body_markdown: string; cta: { text: string; url: string | null };
  /** The approved TL;DR, when the release carries one. */
  tldr?: string | null;
  internal_links: { url: string; anchor: string }[];
  destination: {
    site_id: string; url: string; repo_url: string; branch: string;
    content_adapter: string; content_paths: { blog?: string; blog_dir?: string; blog_route?: string; blog_images?: string; brand?: string; posts_file?: string };
    controlled_by_compass: boolean;
  };
  hero?: BlogHero | null;
};
export type RepositoryRead = { head: string; repo_url: string; branch: string; files: { path: string; content?: string; size?: number | null }[] };
export type PublicationFile = { path: string; content: string; encoding?: "base64" };
/** The approved hero's bytes, base64, already checked against hero.content_hash by the caller. */
export type HeroBytes = { base64: string };
function fail(message: string): never { throw new Error(message); }
const safePath = (path: string) => {
  if (!path || path.startsWith("/") || path.split("/").some((p) => !p || p === "." || p === "..") || /[\\\x00-\x1f]/.test(path)) fail("Unsafe repository content path");
  return path;
};
export function publicationUrl(r: BlogRelease): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(r.slug)) fail("Invalid blog slug");
  const site = new URL(r.destination.url);
  if (site.protocol !== "https:") fail("The website must use HTTPS");
  const route = r.destination.content_paths.blog_route;
  if (!route || !/^\/[a-z0-9/-]*\{slug\}\/?$/.test(route)) fail("A supported blog route is required");
  return new URL(route.replace("{slug}", r.slug), site.origin).href;
}
export function publicationPaths(r: BlogRelease): string[] {
  if (["lucas_json", "json_blog"].includes(r.destination.content_adapter)) return ["compass-blog.json", safePath(r.destination.content_paths.blog ?? "")];
  if (r.destination.content_adapter === "markdown_blog") return ["compass-blog.json", safePath(`${r.destination.content_paths.blog_dir}/${r.slug}.mdx`)];
  if (r.destination.content_adapter === FOUNDATION_ADAPTER) return ["compass-blog.json", safePath(foundationPostsFile(r.destination.content_paths))];
  return fail("Website adapter needs manual delivery");
}
// MDX is executable code. Generated prose is deliberately a restricted Markdown
// subset; never let JSX, imports, expressions or raw HTML enter an MDX module.
export function validatePublishableMarkdown(body: string): void {
  if (/^[ \t]*(?:import|export)\s/m.test(body) || /[<>{}]/.test(body) || /```|~~~/.test(body)) {
    fail("Article contains syntax that requires manual Markdown review");
  }
  for (const m of body.matchAll(/\]\(([^)]+)\)/g)) {
    if (!/^https:\/\/[^\s<>]+$/.test(m[1])) fail("Article links must be explicit HTTPS URLs");
  }
}
const HERO_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
/** Where the approved hero lives in the repository and the URL the site serves it at. */
export function heroImagePlan(r: BlogRelease, contract: Record<string, unknown>): { path: string; src: string } {
  const h = r.hero!;
  if (contract.hero_image !== true) fail("Website needs the Compass blog hero image upgrade before publishing this article");
  if (!["lucas_json", "json_blog"].includes(r.destination.content_adapter)) fail("This website's adapter cannot carry a hero image yet");
  const dir = String(contract.hero_image_dir ?? "");
  const prefix = String(contract.hero_image_url_prefix ?? "");
  const recorded = (r.destination.content_paths.blog_images ?? "public/blog/images").replace(/\/$/, "");
  if (safePath(dir) !== recorded) fail("Website hero image folder does not match the recorded site");
  if (!/^\/[a-z0-9/_-]*\/$/.test(prefix) || prefix.includes("//")) fail("Website hero image URL prefix is invalid");
  if (!/^[0-9a-f]{64}$/.test(h.content_hash) || !HERO_EXT[h.mime_type]) fail("The approved hero image is not a stored PNG, JPEG or WebP file");
  if (!Number.isInteger(h.width) || !Number.isInteger(h.height) || h.width < 1 || h.height < 1) fail("The approved hero image has no dimensions");
  if (!h.alt?.trim()) fail("The approved hero image needs alt text");
  const name = `${r.slug}-${h.content_hash.slice(0, 12)}.${HERO_EXT[h.mime_type]}`;
  return { path: `${dir}/${name}`, src: `${prefix}${name}` };
}
export function preparePublication(r: BlogRelease, releaseHash: string, read: RepositoryRead, date: string, heroBytes?: HeroBytes): {
  expected_head: string; url: string; files: PublicationFile[]; already_present: boolean; hero_src: string | null;
  tldr_mode: "slot" | "body" | null;
} {
  const d = r.destination;
  if (!d.controlled_by_compass || read.repo_url !== d.repo_url || read.branch !== d.branch) fail("Website destination changed since approval");
  if (!/^[0-9a-f]{40}$/.test(read.head)) fail("Repository head is missing");
  if (!/^sha256:[0-9a-f]{64}$/.test(releaseHash) || !r.keyword_id) fail("A released keyword-backed article is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("Publication date is invalid");
  validatePublishableMarkdown(r.body_markdown);
  const tldr = r.tldr?.trim() || null;
  if (tldr && (/[\[\]<>{}\n]/.test(tldr) || /```|~~~/.test(tldr))) fail("The TL;DR contains syntax that requires manual review");
  const contractText = read.files.find((f) => f.path === "compass-blog.json")?.content;
  if (!contractText) fail("Website needs the Compass blog renderer upgrade before publishing");
  const contract = JSON.parse(contractText);
  if (d.content_adapter === FOUNDATION_ADAPTER) return prepareFoundation(r, releaseHash, read, date, contract, tldr);
  if (contract.version !== 1 || contract.adapter !== d.content_adapter || contract.keyword_provenance !== true
      || contract.markdown !== true || contract.seo_fields !== true) fail("Website does not support the complete approved article");
  const url = publicationUrl(r);
  const path = publicationPaths(r)[1];
  const existing = read.files.find((f) => f.path === path);
  const marker = { draft_id: r.draft_id, release_hash: releaseHash, keyword_id: r.keyword_id, version: r.version };
  const hero = r.hero ? heroImagePlan(r, contract) : null;
  // The site's own TL;DR slot, or the first paragraph of the body: never both.
  const tldrSlot = !!tldr && contract.tldr === true && ["lucas_json", "json_blog"].includes(d.content_adapter);
  // In the body, the summary would land under the hero: the order is title, TL;DR, hero.
  if (tldr && hero && !tldrSlot) fail("Website needs the Compass blog TL;DR upgrade (tldr: true) to show the summary above its hero image");
  const body = tldrSlot ? r.body_markdown : bodyWithTldr(r.body_markdown, tldr);
  // The image file: already committed (content-addressed, same size) or added
  // in the same commit as the article. A different file at that path refuses.
  const heroFiles: PublicationFile[] = [];
  if (hero) {
    const inTree = read.files.find((f) => f.path === hero.path);
    if (inTree) {
      if (inTree.size != null && inTree.size !== r.hero!.size_bytes) fail("A different file already occupies the hero image path");
    } else {
      if (!heroBytes?.base64) fail("The approved hero image could not be loaded");
      heroFiles.push({ path: hero.path, content: heroBytes!.base64, encoding: "base64" });
    }
  }
  if (["lucas_json", "json_blog"].includes(d.content_adapter)) {
    if (!existing?.content) fail("The site's blog JSON could not be read; no overwrite is allowed");
    const posts = JSON.parse(existing!.content!);
    if (!Array.isArray(posts)) fail("The site's blog JSON must be an array");
    const matches = posts.filter((p: { slug?: string }) => p.slug === r.slug);
    const article = { slug: r.slug, title: r.title, description: r.meta_description,
      metaTitle: r.meta_title, h1: r.h1, ...(tldrSlot ? { tldr } : {}), datePublished: date, dateModified: date,
      bodyMarkdown: body, cta: r.cta,
      ...(hero ? { heroImage: { src: hero.src, alt: r.hero!.alt, width: r.hero!.width, height: r.hero!.height, illustrative: r.hero!.illustrative } } : {}),
      compass: marker };
    if (matches.length) {
      if (matches.length === 1 && JSON.stringify(matches[0]) === JSON.stringify(article)) {
        if (heroFiles.length) fail("The approved article is on the site but its hero image is missing. Review the repository");
        return { expected_head: read.head, url, files: [], already_present: true, hero_src: hero?.src ?? null, tldr_mode: tldr ? (tldrSlot ? "slot" : "body") : null };
      }
      return fail("Blog slug already exists. Review the existing article before publishing");
    }
    return { expected_head: read.head, url, files: [{ path, content: JSON.stringify([...posts, article], null, 2) + "\n" }, ...heroFiles],
      already_present: false, hero_src: hero?.src ?? null, tldr_mode: tldr ? (tldrSlot ? "slot" : "body") : null };
  }
  const q = (v: string) => JSON.stringify(v);
  if (r.cta.url && !/^https:\/\/[^\s<>()[\]{}]+$/.test(r.cta.url)) fail("CTA URL is invalid");
  if (/[\[\]\n\r<>{}]/.test(r.cta.text)) fail("CTA text requires manual review");
  const content = ["---", `title: ${q(r.title)}`, `meta_title: ${q(r.meta_title)}`, `h1: ${q(r.h1)}`,
    `date: ${q(date)}`, `excerpt: ${q(r.meta_description)}`, `compass_draft_id: ${q(r.draft_id)}`,
    `compass_release_hash: ${q(releaseHash)}`, `keyword_id: ${q(r.keyword_id)}`, "---", "",
    body, "", r.cta.url ? `[${r.cta.text}](${r.cta.url})` : r.cta.text, ""].join("\n");
  if (existing) {
    if (existing.content === content) return { expected_head: read.head, url, files: [], already_present: true, hero_src: null, tldr_mode: tldr ? "body" : null };
    return fail("Blog slug already exists. Review the existing article before publishing");
  }
  return { expected_head: read.head, url, files: [{ path, content }], already_present: false, hero_src: null, tldr_mode: tldr ? "body" : null };
}

// ── Foundation v1 (foundation_brand_content) ───────────────────────────────
/** The approved article as the Foundation site's typed Article. */
export function foundationArticle(r: BlogRelease, releaseHash: string, date: string, tldr: string | null): FoundationArticle {
  const site = r.destination.url;
  const body: Block[] = markdownToBlocks(bodyWithTldr(r.body_markdown, tldr), site);
  // The approved call to action closes the article, as on the Markdown adapter.
  const ctaText = r.cta?.text?.trim();
  if (ctaText) {
    if (/[\[\]\n\r<>{}*_`\\]/.test(ctaText)) fail("CTA text requires manual review");
    body.push({ type: "p", text: r.cta.url ? [{ type: "link", text: ctaText, href: foundationHref(r.cta.url, site) }] : ctaText });
  }
  const service = /^\/services\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
  const related = [...new Set([...r.internal_links.map((l) => foundationHref(l.url, site)), ...blockHrefs(body)].filter((h) => service.test(h)))];
  if (!r.h1?.trim() || /[\n<>{}]/.test(r.h1) || !r.meta_description?.trim()) fail("The approved H1 and meta description are required");
  if (!r.meta_title?.trim() || /[\n<>{}]/.test(r.meta_title)) fail("The approved meta title is required");
  return {
    slug: r.slug, path: `/blog/${r.slug}`, title: r.h1, seo: { title: r.meta_title.trim(), description: r.meta_description }, excerpt: r.meta_description,
    publishedAt: date, ...(related.length ? { relatedServices: related } : {}), body,
    compass: { release_hash: releaseHash, draft_id: r.draft_id, draft_version: r.version, keyword_id: r.keyword_id ?? null },
  };
}

/** The hrefs the Foundation page renders for the approved links (root-relative on the site's own host). */
export function foundationRenderedHrefs(r: BlogRelease): string[] {
  const site = r.destination.url;
  const bodyUrls = [...r.body_markdown.matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)].map((m) => m[1]);
  return [...new Set([...r.internal_links.map((l) => l.url), ...bodyUrls, ...(r.cta?.url ? [r.cta.url] : [])].map((u) => foundationHref(u, site)))];
}

function prepareFoundation(r: BlogRelease, releaseHash: string, read: RepositoryRead, date: string, contract: Record<string, unknown>, tldr: string | null) {
  const d = r.destination;
  const path = safePath(checkFoundationContract(contract, d.content_paths));
  // Client photography only: the CRM never sends a hero to this adapter.
  if (r.hero) heroImagePlan(r, contract);
  const url = publicationUrl(r);
  const dir = path.slice(0, path.lastIndexOf("/"));
  const handWritten = `${dir}/${r.slug}.ts`;
  if (handWritten === path || r.slug === "index") fail("Blog slug is reserved by the website's blog registry");
  const existing = read.files.find((f) => f.path === path);
  if (!existing?.content) fail("The site's Compass posts file could not be read; no overwrite is allowed");
  const file = readCompassPosts(existing!.content!);
  const matches = file.posts.filter((p) => p?.slug === r.slug);
  const base = { expected_head: read.head, url, hero_src: null, tldr_mode: tldr ? "body" as const : null };
  if (matches.length) {
    if (matches.length === 1 && matches[0].compass?.release_hash === releaseHash) return { ...base, files: [], already_present: true };
    return fail("Blog slug already exists. Review the existing article before publishing");
  }
  if (read.files.some((f) => f.path === handWritten)) fail(`Blog slug already exists as a hand-written article (${handWritten}). Review it before publishing`);
  const article = foundationArticle(r, releaseHash, date, tldr);
  return { ...base, files: [{ path, content: writeCompassPosts(file, [...file.posts, article]) }], already_present: false };
}
