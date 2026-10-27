// Which website a tracked keyword's organic rank is measured against.
//
// A single-site client has one website: clients.website_url and its sites
// rows must name the same host. A multi-brand client (BHG: three brand
// sites) measures each keyword against the brand site that owns its service
// — the same ownership core keyword lists use (client_brand_workspaces.
// service_ids, migration 20261027191343). Nothing is guessed: a keyword
// whose service belongs to no brand site, or to several, or a client whose
// records name different hosts, is a problem to show, never "the first
// site". Mirrored in SQL by public.keyword_site_hosts().
//
// Pure (no imports): used by rank-sync (Deno), the Keywords page (Next) and
// tests/rank-site.test.mjs.

export type RankSiteProgram = {
  id: string;
  name: string;
  website_url: string | null;
  blog_site_id: string | null;
  service_ids: string[] | null;
};
export type RankSiteClient = {
  name: string;
  dba?: string | null;
  website_url: string | null;
  sites: { id?: string | null; url: string | null }[] | null;
  client_brand_workspaces?: RankSiteProgram[] | null;
};
export type KeywordSite =
  | { ok: true; host: string; program: string | null; names: string[] }
  | { ok: false; problem: string };

// Same rule as public.url_host and src/lib/organic-rank.ts: lower-case, no www.
export function rankHost(url: string | null | undefined): string | null {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/:?#]+)/.exec(url ?? "");
  const h = m ? m[1].toLowerCase().replace(/^www\./, "") : "";
  return h || null;
}

export function keywordSite(client: RankSiteClient, keyword: { service_id: string | null }): KeywordSite {
  const names = [client.name, client.dba ?? null].filter((n): n is string => !!n);
  const programs = client.client_brand_workspaces ?? [];
  if (!programs.length) {
    const hosts = [...new Set([client.website_url, ...(client.sites ?? []).map((s) => s.url)].map(rankHost).filter((h): h is string => !!h))];
    if (!hosts.length) return { ok: false, problem: "no website is recorded for this client" };
    if (hosts.length > 1) return { ok: false, problem: `the client's records name ${hosts.length} websites (${hosts.join(", ")})` };
    return { ok: true, host: hosts[0], program: null, names };
  }
  const owners = keyword.service_id ? programs.filter((p) => (p.service_ids ?? []).includes(keyword.service_id!)) : [];
  if (!owners.length) return { ok: false, problem: keyword.service_id ? "its service belongs to no brand site" : "it has no service, so no brand site owns it" };
  if (owners.length > 1) return { ok: false, problem: `its service belongs to ${owners.length} brand sites (${owners.map((p) => p.name).join(", ")})` };
  const p = owners[0];
  const blogUrl = p.blog_site_id ? (client.sites ?? []).find((s) => s.id === p.blog_site_id)?.url ?? null : null;
  const hosts = [...new Set([blogUrl, p.website_url].map(rankHost).filter((h): h is string => !!h))];
  if (!hosts.length) return { ok: false, problem: `${p.name} has no website recorded` };
  if (hosts.length > 1) return { ok: false, problem: `${p.name}'s records name ${hosts.length} websites (${hosts.join(", ")})` };
  return { ok: true, host: hosts[0], program: p.id, names: [p.name, ...names] };
}

// Is this search result the keyword's own website (or a subdomain of it)?
// A sister brand's host never counts.
export function onKeywordSite(resultUrlOrDomain: string | null | undefined, host: string): boolean {
  const d = (/^[a-z][a-z0-9+.-]*:\/\//i.test(resultUrlOrDomain ?? "") ? rankHost(resultUrlOrDomain) : (resultUrlOrDomain ?? "").toLowerCase().replace(/^www\./, "")) || "";
  return !!d && (d === host || d.endsWith(`.${host}`));
}
