#!/usr/bin/env node
// Site quality gate — SEO / AEO / GEO structural checks against a built
// Astro site (the dist/ directory). Zero dependencies; runs anywhere Node 18+
// runs, including a Foundation worker session that has not installed the
// CRM's node_modules.
//
//   node scripts/site-quality-gate.mjs <dist-dir> [options]
//
// Options
//   --phone "850-555-0100"     every phone number on the site must match (GEO: NAP)
//   --name "Business Name"     the LocalBusiness schema name must match
//   --service-paths services   comma-separated path prefixes that are service pages
//   --city-paths areas,service-area,locations
//   --min-qa 3                 Q&A blocks required per service / city page (AEO)
//   --json                     print the report as JSON only
//
// Exit code 0 = pass, 1 = hard failures. The report always prints; the
// worker records it on sites.quality and quotes the failures in the stage
// evidence. Placeholders are counted, never failed — a Build to 70% is
// expected to carry them.
//
// What "pass" means, per layer:
//   SEO  every page: one <title> 30–65 chars, one meta description 70–160,
//        exactly one <h1>, a canonical, <html lang>, viewport, alt on every
//        <img>, JSON-LD present; site: sitemap, robots.txt, a 404 page.
//   AEO  every service / city page: FAQPage schema with ≥ min-qa questions,
//        and ≥ min-qa question headings (H2/H3 ending in "?") each followed
//        by a direct answer paragraph of 25–90 words; Service schema on
//        service pages; BreadcrumbList on every non-home page.
//   GEO  a LocalBusiness (or subtype) schema on the home page whose name
//        matches --name; the same phone everywhere (--phone); a facts block
//        (<section data-facts> or id="facts") on home + service pages; an
//        llms.txt at the root; no "unverified" markers left in copy.

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

// ── args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dist = args.find((a) => !a.startsWith("--"));
if (!dist || !existsSync(dist)) {
  console.error("usage: site-quality-gate.mjs <dist-dir> [--phone ..] [--name ..]");
  process.exit(2);
}
const opt = (k, d = null) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d;
};
const flag = (k) => args.includes(`--${k}`);
const PHONE = opt("phone");
const NAME = opt("name");
const SERVICE_PATHS = (opt("service-paths", "services")).split(",").map((s) => s.trim()).filter(Boolean);
const CITY_PATHS = (opt("city-paths", "areas,service-area,locations,cities")).split(",").map((s) => s.trim()).filter(Boolean);
const MIN_QA = Number(opt("min-qa", "3"));
const JSON_ONLY = flag("json");

// ── helpers ──────────────────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".html")) out.push(p);
  }
  return out;
}
const strip = (html) => html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "");
const text = (html) => strip(html).replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const words = (s) => text(s).split(/\s+/).filter(Boolean).length;
const one = (re, html) => { const m = html.match(re); return m ? m[1] : null; };
const all = (re, html) => [...html.matchAll(re)].map((m) => m[1] ?? m[0]);
const digits = (s) => s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

function jsonLd(html) {
  const blocks = all(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi, html);
  const nodes = [];
  for (const b of blocks) {
    try {
      const parsed = JSON.parse(b.trim());
      const push = (n) => {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(push);
        nodes.push(n);
        if (Array.isArray(n["@graph"])) n["@graph"].forEach(push);
      };
      push(parsed);
    } catch { nodes.push({ "@type": "__INVALID__" }); }
  }
  return nodes;
}
const types = (nodes) => nodes.flatMap((n) => (Array.isArray(n["@type"]) ? n["@type"] : [n["@type"]])).filter(Boolean);
const LOCAL_BUSINESS = /^(LocalBusiness|HomeAndConstructionBusiness|GeneralContractor|Electrician|Plumber|RoofingContractor|HVACBusiness|Store|ProfessionalService|MedicalBusiness|AutoRepair|LegalService|RealEstateAgent|Locksmith|MovingCompany|HousePainter|Attorney|Dentist|Restaurant|.*Business|.*Contractor|.*Service|.*Store)$/;

function routeOf(file) {
  const rel = relative(dist, file).split(sep).join("/");
  return "/" + rel.replace(/index\.html$/, "").replace(/\.html$/, "");
}
const isHome = (r) => r === "/";
const under = (r, prefixes) => prefixes.some((p) => r.startsWith(`/${p}/`) && r !== `/${p}/`);

// ── per-page checks ──────────────────────────────────────────────────────
const pages = walk(dist).filter((f) => !/\/404\.html$/.test(f));
const report = { dist, pages: pages.length, failures: [], warnings: [], placeholders: 0, perPage: [] };
const fail = (route, layer, msg) => report.failures.push({ route, layer, msg });
const warn = (route, layer, msg) => report.warnings.push({ route, layer, msg });

const phonesSeen = new Map();
let homeBusinessName = null;
let homeHasLocalBusiness = false;

for (const file of pages) {
  const html = readFileSync(file, "utf8");
  const route = routeOf(file);
  const isService = under(route, SERVICE_PATHS);
  const isCity = under(route, CITY_PATHS);
  const kind = isHome(route) ? "home" : isService ? "service" : isCity ? "city" : "other";
  const nodes = jsonLd(html);
  const t = types(nodes);
  const pg = { route, kind, seo: true, aeo: true, geo: true, types: [...new Set(t)] };

  // SEO
  const title = one(/<title[^>]*>([\s\S]*?)<\/title>/i, html);
  if (!title) { fail(route, "seo", "no <title>"); pg.seo = false; }
  else if (title.trim().length < 30 || title.trim().length > 65) { warn(route, "seo", `title ${title.trim().length} chars (want 30–65)`); }
  const desc = one(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i, html) ?? one(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i, html);
  if (!desc) { fail(route, "seo", "no meta description"); pg.seo = false; }
  else if (desc.length < 70 || desc.length > 160) { warn(route, "seo", `meta description ${desc.length} chars (want 70–160)`); }
  const h1s = all(/<h1[\s>]/gi, html);
  if (h1s.length !== 1) { fail(route, "seo", `${h1s.length} <h1> (want exactly 1)`); pg.seo = false; }
  if (!/<link[^>]+rel=["']canonical["']/i.test(html)) { fail(route, "seo", "no canonical"); pg.seo = false; }
  if (!/<html[^>]+lang=/i.test(html)) { fail(route, "seo", "<html> has no lang"); pg.seo = false; }
  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) { fail(route, "seo", "no viewport meta"); pg.seo = false; }
  const imgs = all(/<img\b[^>]*>/gi, html);
  const noAlt = imgs.filter((i) => !/\balt=/i.test(i)).length;
  if (noAlt) { fail(route, "seo", `${noAlt} <img> without alt`); pg.seo = false; }
  if (nodes.length === 0) { fail(route, "seo", "no JSON-LD"); pg.seo = false; }
  if (t.includes("__INVALID__")) { fail(route, "seo", "JSON-LD does not parse"); pg.seo = false; }

  // AEO
  if (kind !== "home" && !t.includes("BreadcrumbList")) { fail(route, "aeo", "no BreadcrumbList schema"); pg.aeo = false; }
  if (kind === "service" && !t.includes("Service")) { fail(route, "aeo", "service page without Service schema"); pg.aeo = false; }
  if (kind === "service" || kind === "city") {
    const faq = nodes.find((n) => n["@type"] === "FAQPage");
    const faqCount = faq && Array.isArray(faq.mainEntity) ? faq.mainEntity.length : 0;
    if (faqCount < MIN_QA) { fail(route, "aeo", `FAQPage schema has ${faqCount} questions (want ≥ ${MIN_QA})`); pg.aeo = false; }
    // question headings followed by a direct answer
    const body = strip(html);
    const qa = [...body.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>\s*([\s\S]*?)(?=<h[1-6]|$)/gi)]
      .filter((m) => /\?\s*$/.test(text(m[1])))
      .map((m) => {
        const firstP = one(/<p[^>]*>([\s\S]*?)<\/p>/i, m[2]);
        return firstP ? words(firstP) : 0;
      });
    const good = qa.filter((w) => w >= 25 && w <= 90).length;
    if (qa.length < MIN_QA) { fail(route, "aeo", `${qa.length} question headings (want ≥ ${MIN_QA})`); pg.aeo = false; }
    else if (good < MIN_QA) { fail(route, "aeo", `only ${good}/${qa.length} questions answered directly in 25–90 words`); pg.aeo = false; }
  }

  // GEO
  if (kind === "home") {
    const lb = nodes.find((n) => types([n]).some((x) => LOCAL_BUSINESS.test(x)));
    if (!lb) { fail(route, "geo", "home page has no LocalBusiness (or subtype) schema"); pg.geo = false; }
    else {
      homeHasLocalBusiness = true;
      homeBusinessName = lb.name ?? null;
      if (NAME && (lb.name ?? "").trim() !== NAME.trim()) { fail(route, "geo", `LocalBusiness name "${lb.name}" ≠ "${NAME}"`); pg.geo = false; }
      if (!lb.telephone) { fail(route, "geo", "LocalBusiness schema has no telephone"); pg.geo = false; }
      if (!lb.address && !lb.areaServed) { fail(route, "geo", "LocalBusiness schema has neither address nor areaServed"); pg.geo = false; }
      if (!lb.url) { warn(route, "geo", "LocalBusiness schema has no url"); }
    }
  }
  if (kind === "home" || kind === "service") {
    if (!/<(section|div|aside)[^>]+(data-facts|id=["']facts["'])/i.test(html)) { fail(route, "geo", "no facts block (<section data-facts> or id=\"facts\")"); pg.geo = false; }
  }
  const phones = all(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, text(html));
  for (const p of phones) phonesSeen.set(digits(p), (phonesSeen.get(digits(p)) ?? 0) + 1);
  if (PHONE) {
    const bad = phones.filter((p) => digits(p) !== digits(PHONE));
    if (bad.length) { fail(route, "geo", `phone(s) that are not ${PHONE}: ${[...new Set(bad)].join(", ")}`); pg.geo = false; }
  }
  if (/\bunverified\b/i.test(text(html))) { fail(route, "geo", "copy contains 'unverified' — a claim leaked from the claims table"); pg.geo = false; }

  // placeholders: counted, never failed
  const ph = (text(html).match(/\[(PLACEHOLDER|TODO|IMAGE|PHOTO|PROJECT|FACT)[^\]]*\]/gi) ?? []).length;
  report.placeholders += ph;
  pg.placeholders = ph;
  report.perPage.push(pg);
}

// ── site-level checks ────────────────────────────────────────────────────
const has = (f) => existsSync(join(dist, f));
if (!(has("sitemap-index.xml") || has("sitemap.xml") || has("sitemap-0.xml"))) fail("/", "seo", "no sitemap");
if (!has("robots.txt")) fail("/", "seo", "no robots.txt");
if (!has("404.html")) fail("/", "seo", "no 404 page");
if (!has("llms.txt")) fail("/", "geo", "no llms.txt at the site root");
if (!homeHasLocalBusiness && !report.failures.some((f) => f.route === "/" && /LocalBusiness/.test(f.msg))) fail("/", "geo", "no home page found");
if (!PHONE && phonesSeen.size > 1) warn("/", "geo", `${phonesSeen.size} distinct phone numbers across the site — pass --phone to enforce one`);

// ── scores ───────────────────────────────────────────────────────────────
const pct = (k) => report.pages ? Math.round((report.perPage.filter((p) => p[k]).length / report.pages) * 100) : 0;
const siteFails = (layer) => report.failures.filter((f) => f.route === "/" && f.layer === layer && !report.perPage.some((p) => p.route === "/" && !p[layer])).length;
report.score = {
  seo: Math.max(0, pct("seo") - 10 * siteFails("seo")),
  aeo: pct("aeo"),
  geo: Math.max(0, pct("geo") - 10 * siteFails("geo")),
};
report.pass = report.failures.length === 0;
report.business = homeBusinessName;
report.checkedAt = new Date().toISOString();

// ── output ───────────────────────────────────────────────────────────────
if (JSON_ONLY) {
  console.log(JSON.stringify(report));
} else {
  console.log(`Site quality gate — ${report.pages} pages — ${report.pass ? "PASS" : "FAIL"}`);
  console.log(`  SEO ${report.score.seo}%   AEO ${report.score.aeo}%   GEO ${report.score.geo}%   placeholders ${report.placeholders}`);
  if (report.failures.length) {
    console.log(`\n${report.failures.length} failures:`);
    for (const f of report.failures) console.log(`  ✗ [${f.layer}] ${f.route}  ${f.msg}`);
  }
  if (report.warnings.length) {
    console.log(`\n${report.warnings.length} warnings:`);
    for (const w of report.warnings) console.log(`  · [${w.layer}] ${w.route}  ${w.msg}`);
  }
  console.log(`\nJSON: node scripts/site-quality-gate.mjs ${dist} --json`);
}
process.exit(report.pass ? 0 : 1);
