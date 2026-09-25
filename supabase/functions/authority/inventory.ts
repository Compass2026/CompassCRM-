// Read-only snapshot of a client's own public site, shared by
// scripts/site-inventory.mjs and the authority-run Edge Function (D2).
// Ordinary GET requests only, with redirects followed by hand so a loop is
// seen rather than hidden. Guarded: only the recorded site host (with or
// without www), http(s), no IP literals or local names, no credentials or
// ports; the host must resolve only to public addresses (netguard.ts),
// checked before every request including each same-host redirect hop; a
// redirect to another host is recorded, never followed. Bounded: a URL cap,
// 4 requests at a time, a per-request timeout, an overall time budget and a
// response-size cap. fetch and the resolver are injected so the module is
// testable.
import type { SitePage } from "./types.ts";
import { checkHost, systemResolver, type Resolver } from "./netguard.ts";

export const INVENTORY_LIMITS = {
  maxPages: 150,          // URLs per inventory
  concurrency: 4,         // requests at a time
  timeoutMs: 20_000,      // per request
  budgetMs: 120_000,      // the whole inventory
  maxBytes: 2_000_000,    // per response body
  textChars: 4_000,       // page text kept (the engine reads it for wording checks)
} as const;

export type InventoryOptions = {
  site: string;                     // the client's recorded site URL
  candidates?: string[];            // extra URLs (CRM pages, GSC pages, claim sources)
  maxPages?: number;
  concurrency?: number;
  timeoutMs?: number;
  budgetMs?: number;
  maxBytes?: number;
  fetch?: typeof fetch;
  // undefined: the system resolver; null: none, so every request is refused
  resolve?: Resolver | null;
  now?: () => string;
  clock?: () => number;             // ms, for the budget
};
export type Refusal = { url: string; reason: string };
export type Inventory = {
  fetched_at: string; site: string; pages: SitePage[]; sitemap_urls: number;
  refused: string[]; refusals: Refusal[];
  budget_exceeded: boolean; skipped: number;   // URLs never requested because the budget ran out
};

const bare = (h: string) => h.replace(/^www\./, "").toLowerCase();

// The only hosts the inventory may request: the site's own host, with or
// without www. Anything else (another host, an IP literal, localhost) is
// refused. The address check (netguard.ts) happens at request time.
export function allowedUrl(url: string, site: string): boolean {
  let u: URL, s: URL;
  try { u = new URL(url); s = new URL(site); } catch { return false; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (u.username || u.password || u.port) return false;
  const h = u.hostname.toLowerCase();
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.includes(":") || h.startsWith("[") || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  return bare(h) === bare(s.hostname);
}

// Reads at most max bytes of a body, then stops the download.
async function readCapped(r: Response, max: number): Promise<string> {
  const stream = (r as { body?: ReadableStream<Uint8Array> | null }).body;
  if (!stream || typeof stream.getReader !== "function") {
    const t = await r.text();
    return t.length > max ? t.slice(0, max) : t;
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = value.subarray(0, Math.max(0, max - n));
    chunks.push(take);
    n += take.length;
    if (n >= max) { await reader.cancel().catch(() => {}); break; }
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { all.set(c, o); o += c.length; }
  return new TextDecoder().decode(all);
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
    text: text.slice(0, INVENTORY_LIMITS.textChars),
  };
}

export async function inventorySite(opts: InventoryOptions): Promise<Inventory> {
  const f = opts.fetch ?? fetch;
  const resolve = opts.resolve === undefined ? await systemResolver() : opts.resolve;
  const clock = opts.clock ?? Date.now;
  const site = opts.site.replace(/\/+$/, "");
  const origin = new URL(site).origin;
  const max = opts.maxPages ?? INVENTORY_LIMITS.maxPages;
  const maxBytes = opts.maxBytes ?? INVENTORY_LIMITS.maxBytes;
  const deadline = clock() + (opts.budgetMs ?? INVENTORY_LIMITS.budgetMs);
  const refusals: Refusal[] = [];
  let budgetExceeded = false;
  const NONE = { status: null as number | null, location: null as string | null, body: "" };

  async function get(url: string): Promise<{ status: number | null; location: string | null; body: string }> {
    if (!allowedUrl(url, site)) { refusals.push({ url, reason: "host" }); return NONE; }
    const left = deadline - clock();
    if (left <= 0) { budgetExceeded = true; return NONE; }
    const guard = await checkHost(new URL(url).hostname, resolve);
    if (!guard.ok) { refusals.push({ url, reason: guard.reason }); return NONE; }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), Math.min(opts.timeoutMs ?? INVENTORY_LIMITS.timeoutMs, left));
    try {
      const r = await f(url, { redirect: "manual", signal: ctl.signal, headers: { "user-agent": "CompassAuthorityInventory/1 (read-only)" } });
      let body = "";
      if (r.status >= 200 && r.status < 300) body = await readCapped(r, maxBytes);
      else await (r as { body?: ReadableStream | null }).body?.cancel?.().catch(() => {});
      return { status: r.status, location: r.headers.get("location"), body };
    } catch {
      if (clock() >= deadline) budgetExceeded = true;
      return NONE;
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
    let res = NONE;
    for (let hop = 0; hop < 10; hop++) {
      if (seen.has(cur)) return empty(url, inSitemap, first, true);
      seen.add(cur);
      if (!allowedUrl(cur, site)) {
        // a redirect off the site: record where it went, never follow it
        return { ...empty(url, inSitemap, first, false), final_url: cur };
      }
      res = await get(cur);          // every hop is checked again, address included
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
  // The home page first, so it is never the one the budget skips.
  const all = [...new Set([`${origin}/`, ...inSitemap, ...candidates])].slice(0, max);
  const results: (SitePage | null)[] = all.map(() => null);
  let next = 0;
  async function worker() {
    while (next < all.length) {
      const i = next++;
      if (clock() >= deadline) { budgetExceeded = true; continue; }
      results[i] = await page(all[i], inSitemap.has(all[i]));
    }
  }
  const lanes = Math.max(1, Math.min(opts.concurrency ?? INVENTORY_LIMITS.concurrency, all.length));
  await Promise.all(Array.from({ length: lanes }, worker));
  const pages = results.filter((p): p is SitePage => p !== null);
  return {
    fetched_at: opts.now?.() ?? new Date().toISOString(), site, pages, sitemap_urls: inSitemap.size,
    refused: refusals.map((r) => r.url), refusals, budget_exceeded: budgetExceeded, skipped: all.length - pages.length,
  };
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
