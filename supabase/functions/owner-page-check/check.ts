// owner-page-check: the verdict on one fetched owner page. Pure; no network.
//
// A 200 is not proof of a usable page. A page is live only when it was
// answered at the address asked (www and a trailing slash aside), on the
// site's host, with a canonical that does not point elsewhere, with a title
// or H1, and distinguishable from what the same host answers for a path that
// cannot exist (the probe). A host that answers any path with the same page
// (a single-page app, a catch-all) is soft_404 here: its routes are verified
// by reading the rendered page (method 'rendered'), never by status alone.
import { ownerHost, ownerNormUrl } from "../authority/keyword-owner.ts";

export type Fetched = { status: number; finalUrl: string; html: string };
export type Verdict = "live" | "missing" | "soft_404" | "redirected" | "wrong_host" | "unreadable";
export type PageCheck = {
  verdict: Verdict;
  final_url: string;
  http_status: number;
  title: string | null;
  h1: string | null;
  canonical: string | null;
  content_sha256: string;
  detail: string | null;
};

const clean = (s: string | undefined | null) =>
  (s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
// Title, H1 and canonical are metadata: kept short for the record.
const text = (s: string | undefined | null) => {
  const t = clean(s);
  return t ? t.slice(0, 300) : null;
};
// The site chrome every page shares, removed before comparing pages.
const CHROME = /<(header|nav|footer|aside|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi;
export const MAX_CONTENT = 200_000;

// body is the page's own content: <main> when the page has one, else <body>,
// without scripts, styles and the shared chrome, compared in full (up to
// MAX_CONTENT characters of HTML) — never cut to a metadata-length prefix,
// where a long shared navigation would make every page look alike.
export function readPage(html: string): { title: string | null; h1: string | null; canonical: string | null; body: string } {
  const title = text(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const h1 = text(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]);
  const link = html.match(/<link\b[^>]*rel=["']?canonical["']?[^>]*>/i)?.[0] ?? "";
  const canonical = link.match(/href=["']([^"']+)["']/i)?.[1] ?? null;
  const doc = (html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html).slice(0, MAX_CONTENT)
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const main = doc.match(/<main\b[^>]*>([\s\S]*)<\/main>/i)?.[1];
  return { title, h1, canonical, body: clean((main ?? doc).replace(CHROME, " ")) };
}

const NOT_FOUND = /\b(page not found|404|not found|no longer available|doesn'?t exist|does not exist)\b/i;

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function judgePage(requestedUrl: string, siteUrl: string, page: Fetched, probe: Fetched | null): Promise<PageCheck> {
  const read = readPage(page.html);
  const hash = await sha256(read.body);
  const out = (verdict: Verdict, detail: string | null): PageCheck => ({
    verdict, final_url: page.finalUrl, http_status: page.status, title: read.title, h1: read.h1, canonical: read.canonical,
    content_sha256: hash, detail: detail ? detail.slice(0, 1000) : null,
  });
  const want = ownerNormUrl(requestedUrl);
  if (page.status >= 400 || page.status === 0) return out("missing", `HTTP ${page.status}`);
  if (ownerHost(page.finalUrl) !== ownerHost(siteUrl)) return out("wrong_host", `answered from ${page.finalUrl}, not the keyword's site ${siteUrl}`);
  if (ownerNormUrl(page.finalUrl) !== want) return out("redirected", `redirected to ${page.finalUrl}`);
  if (read.canonical) {
    const c = ownerNormUrl(read.canonical, siteUrl);
    if (c && c !== want) return out("redirected", `canonical points to ${read.canonical}`);
  }
  if (!read.title && !read.h1) return out("unreadable", "no title or H1 in the served HTML");
  if ((read.h1 && NOT_FOUND.test(read.h1)) || (read.title && NOT_FOUND.test(read.title) && !read.h1)) {
    return out("soft_404", `the page says it is not found (${read.h1 ?? read.title})`);
  }
  if (probe && probe.status < 400) {
    // The same content, or the same title and H1, as a path that cannot exist.
    const p = readPage(probe.html);
    const same = (await sha256(p.body)) === hash || (p.title === read.title && p.h1 === read.h1);
    if (same) return out("soft_404", "the host answers a path that cannot exist with the same page; verify this route by its rendered content");
  }
  return out("live", null);
}
