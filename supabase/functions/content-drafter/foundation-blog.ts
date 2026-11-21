// Compass Website Foundation v1 blog delivery (adapter foundation_brand_content).
//
// A Foundation site renders typed content, never Markdown: an article is an
// `Article` object whose body is `Block[]` (brands/<brand>/content/blog and
// content/blocks.ts in the site repository). The site advertises the
// contract in compass-blog.json:
//
//   {"version":1,"adapter":"foundation_brand_content","brand":"<brand>",
//    "keyword_provenance":true,"markdown":false,"blocks":true,"seo_fields":true,
//    "tldr":false,"hero_image":false,
//    "posts_file":"brands/<brand>/content/blog/compass-posts.ts","blog_route":"/blog/{slug}"}
//
// and carries one generated file the CRM may rewrite, between two markers:
//
//   export const compassPosts: Article[] = /* compass:begin */ [] /* compass:end */;
//
// Optional upgrades the site may advertise instead of the two false flags: "tldr":true (the Article's
// `tldr` slot) and "hero_image":true with "hero_image_dir" (the recorded
// content_paths.blog_images folder) and "hero_image_url_prefix" (the URL it
// serves that folder at) for the Article's `heroImage`. See publication.ts.
//
// Only the JSON array between the markers changes (a JSON array of Article
// objects is valid TypeScript). The site's registry merges compassPosts with
// its hand-written posts and fails the build on a duplicate slug.
//
// The approved body is the drafter's restricted Markdown. It is converted
// here, deterministically, to the site's block types; anything those types
// cannot express is refused rather than approximated. Links to the site's
// own host become root-relative paths (the site's typed-link rule); every
// other link must be https.
//
// Titles: the H1 is the Article's `title`; the approved meta title is
// `seo.title`, which the site uses for <title>, og:title and twitter:title,
// adding " | <site name>" only while the whole stays within 60 characters
// (foundationDocumentTitle).
//
// Pure: no Deno, no network, so `node --test` imports it.

export type Inline =
  | string
  | { type: "link"; text: string; href: string }
  | { type: "strong"; text: string }
  | { type: "em"; text: string };
export type RichText = string | Inline[];
export type Block =
  | { type: "h2"; text: string }
  | { type: "h3"; text: string }
  | { type: "p"; text: RichText }
  | { type: "ul"; items: RichText[] }
  | { type: "ol"; items: RichText[] }
  | { type: "quote"; text: RichText }
  | { type: "sources"; heading?: string; items: { label: string; href: string; note?: string }[] };

export type FoundationArticle = {
  slug: string; path: string; title: string;
  /** The approved TL;DR, only on a site advertising `tldr: true` (else it is the body's first paragraph). */
  tldr?: string;
  seo: { title: string; description: string }; excerpt: string; publishedAt: string;
  /** The approved hero, only on a site advertising `hero_image: true`; `illustrative` is internal, never a caption. */
  heroImage?: { src: string; alt: string; width: number; height: number; illustrative: boolean };
  relatedServices?: string[]; body: Block[];
  compass: { release_hash: string; draft_id: string; draft_version: number; keyword_id: string | null };
};

export const FOUNDATION_ADAPTER = "foundation_brand_content";
export const FOUNDATION_BLOG_ROUTE = "/blog/{slug}";
export const POSTS_BEGIN = "/* compass:begin */";
export const POSTS_END = "/* compass:end */";
const POSTS_DECL = "export const compassPosts: Article[] = ";

function fail(message: string): never { throw new Error(message); }

const BRAND_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The recorded posts file, checked to sit directly in brands/<brand>/content/blog/. */
export function foundationPostsFile(paths: { brand?: string | null; posts_file?: string | null }): string {
  const brand = paths.brand ?? "";
  const file = paths.posts_file ?? "";
  if (!BRAND_RE.test(brand)) fail("The Foundation site has no recorded client brand (content_paths.brand)");
  if (!new RegExp(`^brands/${brand}/content/blog/[a-z0-9]+(-[a-z0-9]+)*\\.ts$`).test(file) || /\/index\.ts$/.test(file)) {
    fail(`The Foundation posts file must be a generated .ts file in brands/${brand}/content/blog/ (content_paths.posts_file)`);
  }
  return file;
}

/** compass-blog.json for this adapter, checked against what the site row records. */
export function checkFoundationContract(contract: Record<string, unknown>, paths: { brand?: string | null; posts_file?: string | null; blog_route?: string | null }): string {
  const postsFile = foundationPostsFile(paths);
  if (contract.version !== 1 || contract.adapter !== FOUNDATION_ADAPTER || contract.keyword_provenance !== true
      || contract.blocks !== true || contract.seo_fields !== true) {
    fail("Website does not support the complete approved article");
  }
  if (contract.brand !== paths.brand) fail("Website blog contract brand does not match the recorded site");
  if (contract.posts_file !== postsFile) fail("Website blog contract posts file does not match the recorded site");
  if (contract.blog_route !== FOUNDATION_BLOG_ROUTE || paths.blog_route !== FOUNDATION_BLOG_ROUTE) {
    fail("Foundation blog posts are served at /blog/{slug}; the contract or the recorded route differs");
  }
  return postsFile;
}

const hostOf = (h: string) => h.toLowerCase().replace(/^www\./, "");

/** How the site renders a link: own host → root-relative path, anything else → https URL unchanged. */
export function foundationHref(url: string, siteUrl: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return fail(`Article link ${url} is not a URL`); }
  if (u.protocol !== "https:" || u.username || u.password) fail(`Article links must be HTTPS URLs (${url})`);
  if (hostOf(u.hostname) === hostOf(new URL(siteUrl).hostname) && !u.port) return `${u.pathname || "/"}${u.search}${u.hash}`;
  return url;
}

// ── Inline runs ────────────────────────────────────────────────────────────
// Links, **strong** and *em* / _em_ — flat, never nested. Any marker left in
// the plain text afterwards (an unmatched or nested one), inline code, an
// escape or an image is something the block types cannot express.
const INLINE = /\[([^\[\]\n]+)\]\(([^()\s]+)\)|\*\*([^*\n]+?)\*\*|\*([^*\s](?:[^*\n]*?[^*\s])?)\*|(?<![A-Za-z0-9])_([^_\s](?:[^_\n]*?[^_\s])?)_(?![A-Za-z0-9])/g;
const EM_UNDERSCORE = /(?<![A-Za-z0-9])_[^_\s]/;

function plainText(s: string, where: string): string {
  if (/[*`\\\[\]]/.test(s) || /!\[/.test(s) || EM_UNDERSCORE.test(s) || /(?:^|\s)_|_(?:\s|$)/.test(s)) {
    fail(`The article ${where} contains Markdown the website's content blocks cannot express: "${s.trim().slice(0, 80)}"`);
  }
  return s;
}

export function parseInline(src: string, siteUrl: string, where = "body"): RichText {
  if (src.includes("![")) fail(`Images in the article ${where} cannot be expressed on this website`);
  const runs: Inline[] = [];
  let at = 0;
  const pushText = (t: string) => {
    if (!t) return;
    plainText(t, where);
    const last = runs[runs.length - 1];
    if (typeof last === "string") runs[runs.length - 1] = last + t; else runs.push(t);
  };
  for (const m of src.matchAll(INLINE)) {
    pushText(src.slice(at, m.index));
    if (m[1] !== undefined) runs.push({ type: "link", text: plainText(m[1], where), href: foundationHref(m[2], siteUrl) });
    else if (m[3] !== undefined) runs.push({ type: "strong", text: plainText(m[3], where) });
    else runs.push({ type: "em", text: plainText(m[4] ?? m[5], where) });
    at = m.index! + m[0].length;
  }
  pushText(src.slice(at));
  if (runs.length === 0) fail(`The article ${where} has an empty text block`);
  return runs.length === 1 && typeof runs[0] === "string" ? runs[0] : runs;
}

const headingText = (src: string, siteUrl: string) => {
  const t = parseInline(src.trim(), siteUrl, "heading");
  if (typeof t !== "string") fail(`Headings carry no links or emphasis on this website: "${src.trim()}"`);
  return t;
};

// ── Blocks ─────────────────────────────────────────────────────────────────
export function markdownToBlocks(markdown: string, siteUrl: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;
  let quote: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "p", text: parseInline(para.join(" "), siteUrl) });
    if (list) blocks.push({ type: list.type, items: list.items.map((i) => parseInline(i, siteUrl, "list")) });
    if (quote.length) blocks.push({ type: "quote", text: parseInline(quote.join(" "), siteUrl, "quote") });
    para = []; list = null; quote = [];
  };
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/[ \t]+$/, "");
    if (!line) { flush(); continue; }
    if (/^\s/.test(line)) fail(`Indented Markdown (nested lists or code) cannot be expressed on this website: "${line.trim().slice(0, 80)}"`);
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line) || /^\|/.test(line) || /^#(?!#)|^#{4,}/.test(line) || /^(?:=+|-+)$/.test(line)) {
      fail(`The article contains Markdown the website's content blocks cannot express: "${line.slice(0, 80)}"`);
    }
    let m: RegExpExecArray | null;
    if ((m = /^(#{2,3})\s+(.+)$/.exec(line))) {
      flush();
      blocks.push({ type: m[1].length === 2 ? "h2" : "h3", text: headingText(m[2], siteUrl) });
    } else if ((m = /^([-*+]|\d+[.)])\s+(.+)$/.exec(line))) {
      const type = /\d/.test(m[1]) ? "ol" : "ul";
      if (para.length || quote.length || (list && list.type !== type)) flush();
      (list ??= { type, items: [] }).items.push(m[2]);
    } else if ((m = /^>\s?(.*)$/.exec(line))) {
      if (para.length || list) flush();
      if (!m[1].trim()) fail("Empty or nested quotes cannot be expressed on this website");
      quote.push(m[1].trim());
    } else {
      if (list) fail(`A list item continues onto a new line; write each item on one line: "${line.slice(0, 80)}"`);
      if (quote.length) flush();
      para.push(line);
    }
  }
  flush();
  return toSources(blocks);
}

// "## Sources" (or "## References") followed by a list in which every item is
// exactly one link, optionally followed by " — note", is the site's numbered
// sources block. Any other list under that heading stays an ordinary list.
function toSources(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i], next = blocks[i + 1];
    if (b.type === "h2" && /^(sources|references)$/i.test(b.text) && next && (next.type === "ul" || next.type === "ol")) {
      const items = next.items.map((it) => {
        if (!Array.isArray(it) || it.length < 1 || it.length > 2) return null;
        const [link, rest] = it;
        if (typeof link === "string" || link.type !== "link") return null;
        if (rest === undefined) return { label: link.text, href: link.href };
        if (typeof rest !== "string" || !/^ — \S/.test(rest)) return null;
        return { label: link.text, href: link.href, note: rest.slice(3) };
      });
      if (items.every((x) => x)) {
        out.push({ type: "sources", heading: b.text, items: items as { label: string; href: string; note?: string }[] });
        i++;
        continue;
      }
    }
    out.push(b);
  }
  return out;
}

const richString = (r: RichText) => (typeof r === "string" ? r : r.map((x) => (typeof x === "string" ? x : x.text)).join(""));

/** Every visible line the blocks render, for live verification. */
export function blockLines(blocks: Block[]): string[] {
  return blocks.flatMap((b) => {
    switch (b.type) {
      case "h2": case "h3": return [b.text];
      case "p": case "quote": return [richString(b.text)];
      case "ul": case "ol": return b.items.map(richString);
      case "sources": return [b.heading ?? "Sources", ...b.items.map((s) => (s.note ? `${s.label} — ${s.note}` : s.label))];
    }
  }).map((s) => s.trim()).filter(Boolean);
}

/** Every href the blocks render. */
export function blockHrefs(blocks: Block[]): string[] {
  const rich = (r: RichText) => (typeof r === "string" ? [] : r.flatMap((x) => (typeof x !== "string" && x.type === "link" ? [x.href] : [])));
  return blocks.flatMap((b) => {
    switch (b.type) {
      case "p": case "quote": return rich(b.text);
      case "ul": case "ol": return b.items.flatMap(rich);
      case "sources": return b.items.map((s) => s.href);
      default: return [];
    }
  });
}

// ── The generated posts file ───────────────────────────────────────────────
export function readCompassPosts(content: string): { before: string; posts: FoundationArticle[]; after: string } {
  const begin = content.split(POSTS_BEGIN).length - 1;
  const end = content.split(POSTS_END).length - 1;
  const at = content.indexOf(POSTS_BEGIN);
  const close = content.indexOf(POSTS_END);
  if (begin !== 1 || end !== 1 || close < at || !content.slice(0, at).endsWith(POSTS_DECL)) {
    fail("The site's Compass posts file is not the generated contract file; no overwrite is allowed");
  }
  let posts: unknown;
  try { posts = JSON.parse(content.slice(at + POSTS_BEGIN.length, close)); } catch { fail("The site's Compass posts are not a JSON array; no overwrite is allowed"); }
  if (!Array.isArray(posts)) fail("The site's Compass posts are not a JSON array; no overwrite is allowed");
  return { before: content.slice(0, at + POSTS_BEGIN.length), posts: posts as FoundationArticle[], after: content.slice(close) };
}

export function writeCompassPosts(file: { before: string; after: string }, posts: FoundationArticle[]): string {
  return `${file.before} ${JSON.stringify(posts, null, 2)} ${file.after}`;
}

/** The site's document-title rule: the SEO title plus " | <site name>" while the whole fits in 60 characters. */
export const FOUNDATION_TITLE_MAX = 60;
export function foundationDocumentTitle(seoTitle: string, siteName: string | null): string {
  const suffixed = siteName ? `${seoTitle} | ${siteName}` : null;
  return suffixed && suffixed.length <= FOUNDATION_TITLE_MAX ? suffixed : seoTitle;
}
