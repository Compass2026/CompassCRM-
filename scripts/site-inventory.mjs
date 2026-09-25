#!/usr/bin/env node
// Read-only snapshot of a client's public site for the Authority Engine.
// GETs the sitemap and a set of candidate URLs (the CRM's recorded pages),
// follows redirects by hand so a loop is detected rather than hidden, and
// keeps title, H1, H2s, canonical, word count and truncated visible text.
// Sends nothing but ordinary GET requests; writes only the output file.
//
//   node scripts/site-inventory.mjs --site https://example.com \
//     [--input authority-input.json]   # adds page groups, service pages, keyword targets, GSC pages, proposals
//     [--urls /a,/b] [--out inventory.json] [--max 150]
import fs from "node:fs";

const args = process.argv.slice(2);
const arg = (n, d = null) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : d; };
const site = (arg("site") ?? "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(site)) { console.error("--site https://… is required"); process.exit(2); }
const max = Number(arg("max", "150"));
const origin = new URL(site).origin;
const sameSite = (u) => new URL(u).hostname.replace(/^www\./, "") === new URL(site).hostname.replace(/^www\./, "");

const decode = (s) => s.replace(/&amp;/g, "&").replace(/&#39;|&#x27;|&rsquo;|&#8217;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;|&#160;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
const strip = (h) => decode(h.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

async function get(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { redirect: "manual", signal: ctl.signal, headers: { "user-agent": "CompassAuthorityInventory/1 (read-only)" } });
    const body = r.status >= 200 && r.status < 300 ? await r.text() : "";
    return { status: r.status, location: r.headers.get("location"), body };
  } catch { return { status: null, location: null, body: "" }; } finally { clearTimeout(t); }
}

async function page(url, inSitemap) {
  const seen = new Set();
  let cur = url, first = null, res;
  for (let hop = 0; hop < 10; hop++) {
    if (seen.has(cur)) return { url, status: first, final_url: null, final_status: null, redirect_loop: true, in_sitemap: inSitemap, title: null, h1: null, h2: [], canonical: null, words: null, text: null };
    seen.add(cur);
    res = await get(cur);
    if (first === null) first = res.status;
    if (res.status && res.status >= 300 && res.status < 400 && res.location) { cur = new URL(res.location, cur).href; continue; }
    break;
  }
  if (res.status && res.status >= 300 && res.status < 400) return { url, status: first, final_url: null, final_status: null, redirect_loop: true, in_sitemap: inSitemap, title: null, h1: null, h2: [], canonical: null, words: null, text: null };
  const html = res.body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ");
  const one = (re) => { const m = html.match(re); return m ? strip(m[1]) : null; };
  const text = strip(html.replace(/<(header|nav|footer)[\s\S]*?<\/\1>/gi, " ").replace(/^[\s\S]*?<body[^>]*>/i, ""));
  return {
    url, status: first, final_url: cur, final_status: res.status, redirect_loop: false, in_sitemap: inSitemap,
    title: one(/<title[^>]*>([\s\S]*?)<\/title>/i), h1: one(/<h1[^>]*>([\s\S]*?)<\/h1>/i),
    h2: [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => strip(m[1])).filter(Boolean).slice(0, 20),
    canonical: (html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0].match(/href=["']([^"']+)/i) ?? [])[1] ?? null,
    words: text ? text.split(" ").length : 0, text: text.slice(0, 4000),
  };
}

async function sitemapUrls() {
  const out = new Set();
  const queue = [`${origin}/sitemap.xml`];
  while (queue.length && out.size < max) {
    const r = await get(queue.shift());
    for (const m of r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      const u = decode(m[1]);
      if (/sitemap[^/]*\.xml$/i.test(u)) queue.push(u); else if (sameSite(u)) out.add(u);
    }
  }
  return out;
}

const candidates = new Set([`${origin}/`]);
for (const u of (arg("urls") ?? "").split(",").filter(Boolean)) candidates.add(new URL(u, origin).href);
if (arg("input")) {
  let input = JSON.parse(fs.readFileSync(arg("input"), "utf8"));
  if (Array.isArray(input)) input = input[0];
  if (input?.input) input = input.input;
  const a = input.authority ?? {};
  const add = (u) => { try { if (u) { const x = new URL(u, origin); if (sameSite(x.href)) candidates.add(x.href.replace(/#.*$/, "")); } } catch { /* not a URL */ } };
  for (const g of a.pageGroupsFull ?? []) add(g.target_url);
  for (const s of input.services ?? []) add(s.page_url);
  for (const k of input.keywords ?? []) add(k.target_url);
  for (const g of a.gsc ?? []) add(g.page);
  for (const c of a.changeLog ?? []) add(c.after?.url);
  for (const c of input.claims ?? []) add(c.source);
}
const inSitemap = await sitemapUrls();
const all = [...new Set([...inSitemap, ...candidates])].slice(0, max);
const pages = [];
for (const u of all) pages.push(await page(u, inSitemap.has(u)));
const out = { fetched_at: new Date().toISOString(), site, pages };
const dest = arg("out");
if (dest) fs.writeFileSync(dest, JSON.stringify(out, null, 2)); else console.log(JSON.stringify(out, null, 2));
console.error(`${pages.length} URLs (${inSitemap.size} in the sitemap); ${pages.filter((p) => p.redirect_loop).length} loops, ${pages.filter((p) => p.final_status === 404).length} 404s.`);
