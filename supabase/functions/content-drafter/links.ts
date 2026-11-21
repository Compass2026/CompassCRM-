// External citations use exact sourced URLs, retaining query parameters.
// A source note containing prose or multiple URLs is not a link permission.
export function citationUrl(value: string | null | undefined): string | null {
  if (!value || /\s/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

const hostname = (u: string): string | null => {
  try { return new URL(u).hostname.replace(/^www\./, "").toLowerCase(); } catch { return null; }
};
const locs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1].replaceAll("&amp;", "&"));

// Live articles (Nov 20 2026): the article URLs the client's own sitemap
// lists under its blog route, so a draft may link the site's published posts
// even when they predate the CRM. Same host, https, exactly one slug below
// the route, never the route itself. The label is the slug in words, a hint
// for the writer, not page copy.
export function sitemapArticles(xml: string, site: string, blogRoute = "/blog/{slug}"): { url: string; title: string }[] {
  const host = hostname(site);
  if (!host) return [];
  const prefix = (blogRoute.split("{")[0] || "/blog/").replace(/\/?$/, "/");
  const out: { url: string; title: string }[] = [];
  for (const raw of locs(xml)) {
    let url: URL;
    try { url = new URL(raw); } catch { continue; }
    if (url.protocol !== "https:" || hostname(raw) !== host || url.search || url.hash) continue;
    const path = url.pathname.replace(/\/+$/, "");
    if (!path.startsWith(prefix)) continue;
    const slug = path.slice(prefix.length);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || out.some((o) => o.url === url.href)) continue;
    const words = slug.replace(/-/g, " ");
    out.push({ url: url.href, title: words.charAt(0).toUpperCase() + words.slice(1) });
  }
  return out;
}

// The child sitemaps a sitemap index names, on the site's own host.
export function sitemapChildren(xml: string, site: string): string[] {
  const host = hostname(site);
  if (!host || !/<sitemapindex[\s>]/i.test(xml)) return [];
  return locs(xml).filter((u) => hostname(u) === host);
}
