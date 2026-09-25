// Read-only snapshot of a client's own public site, shared by
// scripts/site-inventory.mjs and the authority-run Edge Function (D2).
// Ordinary GET requests only, with redirects followed by hand so a loop is
// seen rather than hidden. Guarded: only the recorded site host (with or
// without www), http(s), no IP literals or local names, a URL cap, a
// per-request timeout and a response-size cap; a redirect to another host is
// recorded, never followed. fetch is injected so the module is testable.
import type { SitePage } from "./types.ts";

export type InventoryOptions = {
  site: string;                     // the client's recorded site URL
  candidates?: string[];            // extra URLs (CRM pages, GSC pages, claim sources)
  maxPages?: number;                // default 150
  timeoutMs?: number;               // per request, default 20 s
  maxBytes?: number;                // per response body, default 2 MB
  fetch?: typeof fetch;
  now?: () => string;
};
export type Inventory = { fetched_at: string; site: string; pages: SitePage[]; sitemap_urls: number; refused: string[] };

const bare = (h: string) => h.replace(/^www\./, "").toLowerCase();

// The only hosts the inventory may request: the site's own host, with or
// without www. Anything else (another host, an IP literal, localhost) is refused.
export function allowedUrl(url: string, site: string): boolean {
  let u: URL, s: URL;
  try { u = new URL(url); s = new URL(site); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password || u.port) return false;
  const h = u.hostname.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":") || h === "localhost" || h.endsWith(".local") || h.endsWith(".internal")) return false;
  return bare(h) === bare(s.hostname);
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&#39;|&#x27;|&rsquo;|&#8217;/g, "'").replace(/&quot;/g, '"')
  .replace(/&nbsp;|&#160;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const strip = (h: string) => decode(h.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

export function parsePage(html: string): Pick<SitePage, "title" | "h1" | "h2" | "canonical" | "words" | "text"> {
  const clean = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ");
  const one = (re: RegExp) => { const m = clean.match(re); return m ? strip(m[1]) : null; };
  const text = strip(clean.replace(/<(header|nav|footer)[\s\S]*?<\/\1>/gi, " ").replace(/^[\s\S]*?<body[^>]*>/i, ""));
  return {
    title: one(/<title[^>]*>([\s\S]*?)<\/title>/i),
    h1: one(/<h1[^>]*>([\s\S]*?)<\/h1>/i),
    h2: [...clean.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => strip(m[1])).filter(Boolean).slice(0, 20),
    canonical: (clean.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0].match(/href=["']([^"']+)/i) ?? [])[1] ?? null,
    words: text ? text.split(" ").length : 0,
    text: text.slice(0, 4000),
  };
}

export async function inventorySite(opts: InventoryOptions): Promise<Inventory> {
  const f = opts.fetch ?? fetch;
  const site = opts.site.replace(/\/+$/, "");
  const origin = new URL(site).origin;
  const max = opts.maxPages ?? 150;
  const refused: string[] = [];

  async function get(url: string): Promise<{ status: number | null; location: string | null; body: string }> {
    if (!allowedUrl(url, site)) { refused.push(url); return { status: null, location: null, body: "" }; }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20000);
    try {
      const r = await f(url, { redirect: "manual", signal: ctl.signal, headers: { "user-agent": "CompassAuthorityInventory/1 (read-only)" } });
      let body = "";
      if (r.status >= 200 && r.status < 300) {
        body = await r.text();
        if (body.length > (opts.maxBytes ?? 2_000_000)) body = body.slice(0, opts.maxBytes ?? 2_000_000);
      }
      return { status: r.status, location: r.headers.get("location"), body };
    } catch {
      return { status: null, location: null, body: "" };
    } finally {
      clearTimeout(t);
    }
  }

  const empty = (url: string, inSitemap: boolean, status: number | null, loop: boolean): SitePage => ({
    url, status, final_url: null, final_status: null, redirect_loop: loop, in_sitemap: inSitemap,
    title: null, h1: null, h2: [], canonical: null, words: null, text: null,
  });

  async function page(url: string, inSitemap: boolean): Promise<SitePage> {
    const seen = new Set<string>();
    let cur = url, first: number | null = null;
    let res = { status: null as number | null, location: null as string | null, body: "" };
    for (let hop = 0; hop < 10; hop++) {
      if (seen.has(cur)) return empty(url, inSitemap, first, true);
      seen.add(cur);
      if (!allowedUrl(cur, site)) {
        // a redirect off the site: record where it went, never follow it
        return { ...empty(url, inSitemap, first, false), final_url: cur };
      }
      res = await get(cur);
      if (first === null) first = res.status;
      if (res.status && res.status >= 300 && res.status < 400 && res.location) { cur = new URL(res.location, cur).href; continue; }
      break;
    }
    if (res.status && res.status >= 300 && res.status < 400) return empty(url, inSitemap, first, true);
    return { url, status: first, final_url: cur, final_status: res.status, redirect_loop: false, in_sitemap: inSitemap, ...parsePage(res.body) };
  }

  const inSitemap = new Set<string>();
  const queue = [`${origin}/sitemap.xml`];
  let sitemaps = 0;
  while (queue.length && inSitemap.size < max && sitemaps < 10) {
    sitemaps++;
    const r = await get(queue.shift()!);
    for (const m of r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      const u = decode(m[1]);
      if (/sitemap[^/]*\.xml$/i.test(u)) { if (allowedUrl(u, site)) queue.push(u); }
      else if (allowedUrl(u, site)) inSitemap.add(u);
    }
  }
  const candidates = new Set<string>([`${origin}/`]);
  for (const c of opts.candidates ?? []) {
    try { const x = new URL(c, origin).href.replace(/#.*$/, ""); if (allowedUrl(x, site)) candidates.add(x); } catch { /* not a URL */ }
  }
  const all = [...new Set([...inSitemap, ...candidates])].slice(0, max);
  const pages: SitePage[] = [];
  for (const u of all) pages.push(await page(u, inSitemap.has(u)));
  return { fetched_at: opts.now?.() ?? new Date().toISOString(), site, pages, sitemap_urls: inSitemap.size, refused };
}

// Candidate URLs from an authority input: what the CRM believes exists.
export function candidatesFrom(input: {
  services?: { page_url: string | null }[]; keywords?: { target_url: string | null }[]; claims?: { source: string | null }[];
  authority?: { pageGroupsFull?: { target_url: string | null }[]; gsc?: { page: string | null }[]; changeLog?: { after: unknown }[] };
}): string[] {
  const a = input.authority ?? {};
  return [
    ...(a.pageGroupsFull ?? []).map((g) => g.target_url),
    ...(input.services ?? []).map((s) => s.page_url),
    ...(input.keywords ?? []).map((k) => k.target_url),
    ...(a.gsc ?? []).map((g) => g.page),
    ...(a.changeLog ?? []).map((c) => (c.after as { url?: string } | null)?.url ?? null),
    ...(input.claims ?? []).map((c) => c.source),
  ].filter((u): u is string => !!u);
}
