// URL, page-state and place helpers. Pure.
import { COMMON_WORD_PLACES } from "../post-drafter/lint.ts";
import type { PageState, SitePage } from "./types.ts";

// Site-relative path: no origin (any host of the client's site, with or
// without www), no query or hash, no trailing slash (except "/").
export function normPath(url: string | null | undefined, siteUrl?: string | null): string | null {
  if (!url) return null;
  const raw = url.trim();
  if (!raw) return null;
  let path: string;
  try {
    const base = siteUrl && /^https?:\/\//.test(siteUrl) ? siteUrl : "https://site.invalid";
    const u = new URL(raw, base);
    if (/^https?:\/\//.test(raw) && siteUrl) {
      const host = (h: string) => h.replace(/^www\./, "").toLowerCase();
      if (host(u.hostname) !== host(new URL(siteUrl).hostname)) return null; // another site
    }
    path = decodeURIComponent(u.pathname);
  } catch {
    return null;
  }
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return path || "/";
}

export type Inventory = {
  byPath: Map<string, SitePage>;
  // final path a request path settles on, following recorded redirects
  resolve(path: string | null): { state: PageState; final_path: string | null; page: SitePage | null };
};

export function buildInventory(pages: SitePage[] | null | undefined, siteUrl: string | null): Inventory {
  const byPath = new Map<string, SitePage>();
  for (const p of pages ?? []) {
    const path = normPath(p.url, siteUrl);
    if (path && !byPath.has(path)) byPath.set(path, p);
  }
  const resolve = (path: string | null) => {
    if (!path) return { state: "not_checked" as PageState, final_path: null, page: null };
    const p = byPath.get(path);
    if (!p) return { state: "not_checked" as PageState, final_path: null, page: null };
    if (p.redirect_loop) return { state: "redirect_loop" as PageState, final_path: null, page: p };
    const finalPath = normPath(p.final_url, siteUrl);
    const st = p.final_status ?? p.status;
    if (st === 404 || st === 410) return { state: "missing" as PageState, final_path: finalPath, page: p };
    if (st === null || st >= 500 || st === 0) return { state: "error" as PageState, final_path: finalPath, page: p };
    if (finalPath && finalPath !== path) {
      const target = byPath.get(finalPath);
      return { state: "redirects" as PageState, final_path: finalPath, page: target ?? p };
    }
    if (st >= 200 && st < 300) return { state: "live" as PageState, final_path: path, page: p };
    return { state: "error" as PageState, final_path: finalPath, page: p };
  };
  return { byPath, resolve };
}

// ── Places ──────────────────────────────────────────────────────────────────
// "St. Louis", "St Louis" and "Saint Louis" are one place; "O'Fallon" and
// "OFallon" too. Matching is on normalized words.
export function normPlace(s: string): string {
  return ` ${s.toLowerCase().replace(/['’]/g, "").replace(/\bst\b\.?/g, "saint").replace(/[^a-z0-9]+/g, " ").trim()} `;
}

export type PlaceIndex = { names: { name: string; norm: string }[]; approved: Set<string> };

export function buildPlaceIndex(places: string[], approved: string[], exclude: string[]): PlaceIndex {
  const excluded = new Set(exclude.map((e) => normPlace(e).trim()));
  const seen = new Set<string>();
  const names: { name: string; norm: string }[] = [];
  for (const name of places) {
    const n = normPlace(name);
    const bare = n.trim();
    if (bare.length < 4 || seen.has(n) || COMMON_WORD_PLACES.has(name) || excluded.has(bare)) continue;
    seen.add(n);
    names.push({ name, norm: n });
  }
  // longest first, so "Lake Saint Louis" wins over "Saint Louis"
  names.sort((a, b) => b.norm.length - a.norm.length);
  return { names, approved: new Set(approved.map((a) => normPlace(a))) };
}

// Places named in a text, longest match first; each span counted once.
export function placesIn(text: string | null | undefined, index: PlaceIndex): { name: string; approved: boolean }[] {
  if (!text) return [];
  let hay = normPlace(text);
  const out: { name: string; approved: boolean }[] = [];
  for (const p of index.names) {
    if (hay.includes(p.norm)) {
      out.push({ name: p.name, approved: index.approved.has(p.norm) });
      hay = hay.split(p.norm).join(" ");
    }
  }
  return out;
}

export function daysBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 86_400_000;
}

export function addDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);
}
