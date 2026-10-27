// Mirror of public.url_host / public.organic_rank_state (migration
// 20261021163048) and public.keyword_organic_state (20261027191343) for
// pages that read rank_snapshots directly. Keep the two
// in step: tests/organic-rank.test.mjs pins the same truth table.
export type OrganicRankState = "website" | "third_party" | "unverified" | "not_found";

export function urlHost(url: string | null | undefined): string | null {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/:?#]+)/.exec(url ?? "");
  const h = m ? m[1].toLowerCase().replace(/^www\./, "") : "";
  return h || null;
}

// The client's own websites: client record, site rows and brand websites.
export function siteHosts(urls: (string | null | undefined)[]): string[] {
  return [...new Set(urls.map(urlHost).filter((h): h is string => !!h))];
}

export function organicRankState(source: string, position: number | null, url: string | null, hosts: string[]): OrganicRankState {
  if (position === null) return "not_found";
  // BrightLocal, CSV and manual rows rank the configured website and carry no URL.
  if (url === null) return source === "dataforseo" ? "unverified" : "website";
  const h = urlHost(url);
  if (!hosts.length || !h) return "unverified";
  return hosts.some(s => h === s || h.endsWith(`.${s}`)) ? "website" : "third_party";
}

// One keyword's organic row, judged against that keyword's own website
// (supabase/functions/_shared/rank-site.ts; hosts is [its host], or [] when
// unresolved). For a multi-brand client a DataForSEO row the collector did
// not judge against that same host (older rows, site_host null) proves
// nothing about this site unless it shows a page on it: unverified.
export function keywordOrganicState(source: string, position: number | null, url: string | null, siteHost: string | null, hosts: string[], multiBrand: boolean): OrganicRankState {
  if (multiBrand && source === "dataforseo" && (!siteHost || !hosts.includes(siteHost)))
    return position !== null && organicRankState(source, position, url, hosts) === "website" ? "website" : "unverified";
  return organicRankState(source, position, url, hosts);
}
