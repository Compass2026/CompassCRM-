// A pure, lossless delivery contract. The site must explicitly advertise the
// contract; old Lucas renderers only display plain text and would lose links.
export type BlogRelease = {
  draft_id: string; client_id: string; version: number; keyword_id: string;
  title: string; slug: string; meta_title: string; meta_description: string;
  h1: string; body_markdown: string; cta: { text: string; url: string | null };
  internal_links: { url: string; anchor: string }[];
  destination: {
    site_id: string; url: string; repo_url: string; branch: string;
    content_adapter: string; content_paths: { blog?: string; blog_dir?: string; blog_route?: string };
    controlled_by_compass: boolean;
  };
};
export type RepositoryRead = { head: string; repo_url: string; branch: string; files: { path: string; content?: string }[] };
export type PublicationFile = { path: string; content: string };
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
export function preparePublication(r: BlogRelease, releaseHash: string, read: RepositoryRead, date: string): {
  expected_head: string; url: string; files: PublicationFile[]; already_present: boolean;
} {
  const d = r.destination;
  if (!d.controlled_by_compass || read.repo_url !== d.repo_url || read.branch !== d.branch) fail("Website destination changed since approval");
  if (!/^[0-9a-f]{40}$/.test(read.head)) fail("Repository head is missing");
  if (!/^sha256:[0-9a-f]{64}$/.test(releaseHash) || !r.keyword_id) fail("A released keyword-backed article is required");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("Publication date is invalid");
  validatePublishableMarkdown(r.body_markdown);
  const contractText = read.files.find((f) => f.path === "compass-blog.json")?.content;
  if (!contractText) fail("Website needs the Compass blog renderer upgrade before publishing");
  const contract = JSON.parse(contractText);
  if (contract.version !== 1 || contract.adapter !== d.content_adapter || contract.keyword_provenance !== true
      || contract.markdown !== true || contract.seo_fields !== true) fail("Website does not support the complete approved article");
  const url = publicationUrl(r);
  const path = publicationPaths(r)[1];
  const existing = read.files.find((f) => f.path === path);
  const marker = { draft_id: r.draft_id, release_hash: releaseHash, keyword_id: r.keyword_id, version: r.version };
  if (["lucas_json", "json_blog"].includes(d.content_adapter)) {
    if (!existing?.content) fail("The site's blog JSON could not be read; no overwrite is allowed");
    const posts = JSON.parse(existing!.content!);
    if (!Array.isArray(posts)) fail("The site's blog JSON must be an array");
    const matches = posts.filter((p: { slug?: string }) => p.slug === r.slug);
    const article = { slug: r.slug, title: r.title, description: r.meta_description,
      metaTitle: r.meta_title, h1: r.h1, datePublished: date, dateModified: date,
      bodyMarkdown: r.body_markdown, cta: r.cta, compass: marker };
    if (matches.length) {
      if (matches.length === 1 && JSON.stringify(matches[0]) === JSON.stringify(article)) {
        return { expected_head: read.head, url, files: [], already_present: true };
      }
      return fail("Blog slug already exists. Review the existing article before publishing");
    }
    return { expected_head: read.head, url, files: [{ path, content: JSON.stringify([...posts, article], null, 2) + "\n" }], already_present: false };
  }
  const q = (v: string) => JSON.stringify(v);
  if (r.cta.url && !/^https:\/\/[^\s<>()[\]{}]+$/.test(r.cta.url)) fail("CTA URL is invalid");
  if (/[\[\]\n\r<>{}]/.test(r.cta.text)) fail("CTA text requires manual review");
  const content = ["---", `title: ${q(r.title)}`, `meta_title: ${q(r.meta_title)}`, `h1: ${q(r.h1)}`,
    `date: ${q(date)}`, `excerpt: ${q(r.meta_description)}`, `compass_draft_id: ${q(r.draft_id)}`,
    `compass_release_hash: ${q(releaseHash)}`, `keyword_id: ${q(r.keyword_id)}`, "---", "",
    r.body_markdown, "", r.cta.url ? `[${r.cta.text}](${r.cta.url})` : r.cta.text, ""].join("\n");
  if (existing) {
    if (existing.content === content) return { expected_head: read.head, url, files: [], already_present: true };
    return fail("Blog slug already exists. Review the existing article before publishing");
  }
  return { expected_head: read.head, url, files: [{ path, content }], already_present: false };
}
