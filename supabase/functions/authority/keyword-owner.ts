// The keyword owner resolver (20261028170000), the TypeScript twin of SQL's
// keyword_owner(). Pure: reads one owner_context (keyword_owner_context(),
// the same rows SQL reads) and returns the keyword's single owner page or
// the first reason there is none. tests/fixtures/keyword-owner-cases.json is
// run through both, so the two cannot drift apart unnoticed.
//
//   owner page       exactly one explicit claim: an approved page group whose
//                    primary keyword is the keyword (or an equivalent row of
//                    the same site program), the keyword's target_url, or the
//                    page of an approved service whose primary keyword it is.
//                    Two different claims are a conflict, never a priority
//                    order. With no claim, the related service's page.
//   related service  keywords.service_id: optional, approved, same site.
//
// Used by the post-drafter and content-drafter briefs and the authority
// conflicts pass. The database gates stay authoritative: a brief from this
// resolver that disagrees with keyword_owner() is refused at write time.

export type OwnerPurpose = "post" | "blog" | "refresh" | "add";
export type OwnerRole = "service" | "city" | "home" | "brand" | "blog";

export type OwnerContext = {
  // false for a client with Tom's recorded core-keyword exemption: page
  // checks, markets and roles are reported, not enforced (holds, conflicts
  // and wrong pages always are).
  enforce: boolean;
  program_id: string | null;
  site_url: string | null;
  workspaces: { id: string; name: string; website_url: string | null; service_ids: string[] }[];
  keywords: {
    id: string; keyword: string; is_active: boolean; intent: string | null; service_id: string | null;
    target_url: string | null; city: string | null; market_id: string | null; core_parent_keyword_id: string | null;
  }[];
  services: { id: string; status: string; page_url: string | null; primary_keyword_id: string | null }[];
  page_groups: { id: string; status: string; page_type: string; target_url: string | null; primary_keyword_id: string | null; created_at?: string }[];
  published_posts: { id: string; url: string }[];
  markets: { id: string; brand_workspace_id: string | null; city: string; state: string; country?: string; status: string; basis?: string; source_ref: string }[];
  page_checks: { url_norm: string; verdict: string; checked_at: string; detail?: string | null; method?: string; id?: number }[];
  holds: { id: string; brand_workspace_id: string | null; offering: string; phrases: string[]; service_ids: string[]; decided_on: string; source_ref: string }[];
  as_of: string;
};

export type KeywordOwner = {
  url: string;
  display_url: string;
  page_group_id: string | null;
  role: OwnerRole;
  program_id: string | null;
  market_id: string | null;
  market: string | null;
  related_service_id: string | null;
  from_service: boolean;
};

export type OwnerResult =
  | { ok: true; owner: KeywordOwner; notes: string[] }
  | { ok: false; code: string; message: string; partial: Partial<KeywordOwner> };

export const PAGE_CHECK_MAX_AGE_DAYS = 45;

// ── Helpers: the same rules as core_norm_url / core_url_host / core_norm_kw /
// core_norm_words ──
const ORIGIN = /^[A-Za-z]+:\/\/[^/?#\s]+/;
export function ownerNormUrl(url: string | null | undefined, site?: string | null): string | null {
  let v = (url ?? "").replace(/^ +| +$/g, "");
  if (!v) return null;
  if (v.startsWith("/")) {
    const s = (site ?? "").replace(/^ +| +$/g, "");
    if (!/^https?:\/\/[^/?#\s]+/i.test(s)) return null;
    v = s.match(ORIGIN)![0] + v;
  }
  if (!/^https?:\/\/[^/?#\s:]+/i.test(v)) return null;
  const scheme = v.match(/^([A-Za-z]+):\/\//)![1].toLowerCase();
  const host = v.match(/^[A-Za-z]+:\/\/([^/?#\s:]+)/)![1].toLowerCase().replace(/^www\./, "");
  const path = (v.match(/^[A-Za-z]+:\/\/[^/?#\s]+(\/[^?#\s]*)/)?.[1] ?? "").toLowerCase().replace(/\/+$/, "");
  return `${scheme}://${host}${path}`;
}
export function ownerHost(url: string | null | undefined): string | null {
  const m = (url ?? "").replace(/^ +| +$/g, "").match(/^[A-Za-z]+:\/\/([^/?#\s:]+)/);
  return m ? m[1].toLowerCase().replace(/^www\./, "") : null;
}
export const normKeyword = (s: string | null | undefined) => (s ?? "").replace(/^ +| +$/g, "").replace(/\s+/g, " ").toLowerCase();
export const normWords = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// What an owner of each role may anchor (core_owner_allows).
export function ownerAllows(role: string, purpose: string, intent: string | null): boolean {
  const i = intent ?? "";
  switch (purpose) {
    case "post":
      return role === "service" || role === "city"
        || (role === "home" && ["navigational", "commercial", "transactional"].includes(i))
        || (role === "brand" && ["navigational", "commercial"].includes(i))
        || (role === "blog" && ["informational", "commercial"].includes(i));
    case "blog":
      return (role === "service" && ["informational", "commercial"].includes(i)) || (role === "city" && i === "informational");
    case "refresh":
    case "add":
      return ["service", "city", "home", "brand"].includes(role);
    default:
      return false;
  }
}

// core_hold_stem: a light suffix stripper, so "repairs", "repaired" and
// "repairing" all meet "repair", and "consultations" / "consultant" /
// "consulting" meet "consultation". Applied to both sides, so it only has to
// be consistent, not linguistically right.
export function holdStem(word: string): string {
  let w = word;
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  if (w.endsWith("ation") && w.length > 7) w = w.slice(0, -5);
  else if (w.endsWith("ion") && w.length > 6) w = w.slice(0, -3);
  else if (w.endsWith("ment") && w.length > 7) w = w.slice(0, -4);
  else if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ant") && w.length > 6) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  if (w.endsWith("er") && w.length > 4) w = w.slice(0, -2);
  if (w.endsWith("e") && w.length > 4) w = w.slice(0, -1);
  const last = w.slice(-1);
  if (w.length > 3 && last === w.slice(-2, -1) && /[b-df-hj-km-np-rtv-y]/.test(last)) w = w.slice(0, -1);
  return w;
}
export const holdTokens = (s: string | null | undefined) => normWords(s).split(" ").filter(Boolean).map(holdStem);

// core_hold_hit: the first held phrase whose words all occur, in any order,
// within a span of the phrase's length + 2 words ("we will monitor your
// solar system" meets "solar system monitoring"). Phrases are the offering's
// words and its listed paraphrases; anything they do not name is the human
// reviewer's to catch — this is not a promise that other prose is safe.
export function holdHit(phrases: string[], text: string | null | undefined): string | null {
  const t = holdTokens(text);
  for (const p of phrases) {
    const ps = holdTokens(p);
    if (!ps.length) continue;
    for (let i = 0; i < t.length; i++) {
      if (!ps.includes(t[i])) continue;
      const win = t.slice(i, i + ps.length + 2);
      if (ps.every((s) => win.includes(s))) return p;
    }
  }
  return null;
}

// The held offering a text, service or page would promote (core_promotion_hold).
export function promotionHold(ctx: OwnerContext, program: string | null, text: string | null, serviceId: string | null, url: string | null): string | null {
  for (const h of ctx.holds) {
    if (h.brand_workspace_id !== null && h.brand_workspace_id !== program) continue;
    const bySvc = !!serviceId && h.service_ids.includes(serviceId);
    const byText = text != null && holdHit(h.phrases, text) !== null;
    const byUrl = !!url && h.service_ids.some((sid) => {
      const s = ctx.services.find((x) => x.id === sid);
      return !!s?.page_url && ownerNormUrl(s.page_url) === ownerNormUrl(url);
    });
    if (bySvc || byText || byUrl) return `${h.offering} (held ${h.decided_on}: ${h.source_ref.slice(0, 160)})`;
  }
  return null;
}

const isMulti = (ctx: OwnerContext) => ctx.workspaces.length > 0;

// core_site_of_keyword: the brand site owning the keyword's service; with no
// service, the one site whose host carries all of the keyword's OWN claims.
export function siteOfKeyword(ctx: OwnerContext, keywordId: string): string | null {
  if (!isMulti(ctx)) return null;
  const k = ctx.keywords.find((x) => x.id === keywordId);
  if (!k) return null;
  if (k.service_id) {
    const ws = ctx.workspaces.filter((w) => w.service_ids.includes(k.service_id!));
    return ws.length === 1 ? ws[0].id : null;
  }
  const claims = [
    ...(k.target_url?.trim() ? [k.target_url] : []),
    ...ctx.page_groups.filter((g) => g.status === "approved" && g.primary_keyword_id === k.id && g.target_url?.trim()).map((g) => g.target_url!),
    ...ctx.services.filter((s) => s.status === "approved" && s.primary_keyword_id === k.id && s.page_url?.trim()).map((s) => s.page_url!),
  ];
  const hosts = [...new Set(claims.map((u) => ownerHost(u)))];
  if (hosts.length !== 1) return null;
  const ws = ctx.workspaces.filter((w) => ownerHost(w.website_url) === hosts[0]);
  return ws.length === 1 ? ws[0].id : null;
}

export function resolveKeywordOwner(
  ctx: OwnerContext,
  keywordId: string,
  opts: { program?: string | null; purpose?: OwnerPurpose | null } = {},
): OwnerResult {
  const purpose = opts.purpose ?? null;
  const requested = opts.program ?? null;
  const notes: string[] = [];
  let partial: Partial<KeywordOwner> = {};
  const fail = (code: string, message: string): OwnerResult => ({ ok: false, code, message, partial });
  // Checks a client's exemption reports but does not enforce.
  const soft = (code: string, message: string): OwnerResult | null => {
    if (ctx.enforce) return fail(code, message);
    notes.push(`${code}: ${message}`);
    return null;
  };

  const k = ctx.keywords.find((x) => x.id === keywordId);
  if (!k || !k.is_active) return fail("keyword_unknown", "The keyword is inactive or not this client's.");
  const multi = isMulti(ctx);
  let program: string | null = null;
  let site: string | null;
  let wsName = "";
  if (multi) {
    program = siteOfKeyword(ctx, k.id);
    if (!program) return fail("program_unresolved", "The keyword belongs to no single brand site: its service is on none, or its own page claims are on no single brand site.");
    if (requested && requested !== program) {
      partial = { program_id: program };
      return fail("keyword_wrong_site", "The keyword belongs to another brand site.");
    }
    const ws = ctx.workspaces.find((w) => w.id === program)!;
    site = ws.website_url;
    wsName = ws.name;
  } else {
    if (requested) return fail("keyword_wrong_site", "A single-site client has no brand site program.");
    site = ctx.site_url;
  }
  const siteHost = ownerHost(site);
  partial = { program_id: program, related_service_id: k.service_id };

  const parent = ctx.keywords.find((x) => x.id === k.core_parent_keyword_id);
  let held = promotionHold(ctx, program, k.keyword, k.service_id, null) ?? (parent ? promotionHold(ctx, program, parent.keyword, null, null) : null);
  if (held) return fail("promotion_held", `Promotion is held: ${held}.`);

  let service: OwnerContext["services"][number] | undefined;
  if (k.service_id) {
    service = ctx.services.find((s) => s.id === k.service_id);
    if (!service || service.status !== "approved") return fail("service_not_approved", "The keyword's service is not approved.");
    if (multi && !ctx.workspaces.find((w) => w.id === program)!.service_ids.includes(service.id)) {
      return fail("service_wrong_site", "The keyword's service belongs to another brand site.");
    }
  }

  const text = normKeyword(k.keyword);
  const eq = new Set(ctx.keywords.filter((e) => e.is_active && normKeyword(e.keyword) === text
    && (e.id === k.id || !multi || siteOfKeyword(ctx, e.id) === program)).map((e) => e.id));
  const raw = [
    ...ctx.page_groups.filter((g) => g.status === "approved" && g.primary_keyword_id && eq.has(g.primary_keyword_id) && g.target_url?.trim()).map((g) => g.target_url!),
    ...ctx.keywords.filter((e) => eq.has(e.id) && e.target_url?.trim()).map((e) => e.target_url!),
    ...ctx.services.filter((s) => s.status === "approved" && s.primary_keyword_id && eq.has(s.primary_keyword_id) && s.page_url?.trim()).map((s) => s.page_url!),
  ];
  const invalid = raw.filter((u) => ownerNormUrl(u, site) === null);
  if (invalid.length) return fail("target_page_invalid", `A page claiming the keyword is not a URL: ${invalid.join(", ")}.`);
  const cands = [...new Set(raw.map((u) => ownerNormUrl(u, site)!))].sort();
  let owner: string;
  let fromService = false;
  if (cands.length > 1) {
    return fail("keyword_owner_conflict", `The keyword has competing owner pages: ${cands.join(", ")}. Resolve ownership before drafting.`);
  } else if (cands.length === 1) {
    owner = cands[0];
  } else if (service?.page_url?.trim() && ownerNormUrl(service.page_url, site)) {
    owner = ownerNormUrl(service.page_url, site)!;
    fromService = true;
  } else {
    return fail("target_page_missing", "No page claims the keyword and it has no related service page.");
  }
  partial = { ...partial, url: owner, from_service: fromService };

  if (!owner.startsWith("https://")) return fail("target_page_invalid", `${owner} is not an https page.`);
  if (!siteHost || ownerHost(owner) !== siteHost) {
    return fail("keyword_wrong_page", `${owner} is not on ${multi ? `${wsName}'s site ` : "the client's website "}${site ?? ""}.`);
  }

  const groups = ctx.page_groups.filter((g) => g.status === "approved" && ownerNormUrl(g.target_url, site) === owner)
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id.localeCompare(b.id));
  // Roles, not raw page types: service and hub are both a service page.
  const roleOf = (t: string): OwnerRole => (t === "home" ? "home" : t === "city" ? "city" : t === "other" ? "brand" : "service");
  const types = [...new Set(groups.map((g) => roleOf(g.page_type)))].sort();
  let role: OwnerRole;
  let display: string | null = null;
  let groupId: string | null = null;
  if (types.length > 1) {
    return fail("page_role_ambiguous", `Approved page groups give ${owner} different roles: ${types.join(", ")}.`);
  } else if (types.length === 1) {
    role = types[0] as OwnerRole;
    groupId = groups[0].id;
    display = groups[0].target_url;
  } else {
    const post = ctx.published_posts.filter((p) => ownerNormUrl(p.url, site) === owner).sort((a, b) => a.id.localeCompare(b.id))[0];
    if (!post) return fail("target_page_unapproved", `No approved page group targets ${owner}.`);
    role = "blog";
    display = post.url;
  }
  const displayUrl = display && /^https?:\/\//i.test(display) ? display : owner;
  partial = { ...partial, role, page_group_id: groupId, display_url: displayUrl };

  if (role === "service" && !k.service_id && (k.intent ?? "") !== "navigational") {
    return fail("service_missing", "A service page owns the keyword but the keyword names no related service.");
  }
  held = promotionHold(ctx, program, null, null, owner);
  if (held) return fail("promotion_held", `The owner page promotes a held offering: ${held}.`);

  if (purpose !== "add") {
    // The latest check; an http soft_404 (a host that answers every path
    // alike) defers to the latest rendered check (keyword_owner's rule).
    const mine = ctx.page_checks.filter((c) => c.url_norm === owner)
      .sort((a, b) => b.checked_at.localeCompare(a.checked_at) || (b.id ?? 0) - (a.id ?? 0));
    let chk = mine[0];
    if (chk && chk.method !== "rendered" && chk.verdict === "soft_404") chk = mine.find((c) => c.method === "rendered") ?? chk;
    const maxAge = PAGE_CHECK_MAX_AGE_DAYS * 86400000;
    if (!chk) {
      const r = soft("page_not_verified", `${owner} has not been checked live.`);
      if (r) return r;
    } else if (chk.verdict !== "live") {
      return fail("target_page_missing", `${owner} was ${chk.verdict} when checked ${chk.checked_at.slice(0, 10)}${chk.detail ? `: ${chk.detail}` : ""}.`);
    } else if (Date.parse(chk.checked_at) < Date.parse(ctx.as_of) - maxAge) {
      const r = soft("page_not_verified", `${owner} was last checked ${chk.checked_at.slice(0, 10)}; check it again.`);
      if (r) return r;
    }
  }

  const applicable = ctx.markets.filter((m) => m.brand_workspace_id === null || m.brand_workspace_id === program);
  let market: OwnerContext["markets"][number] | undefined;
  if (k.market_id) {
    market = applicable.find((m) => m.id === k.market_id);
    if (!market) {
      const r = soft("market_unverified", "The keyword's market is not a market of this site.");
      if (r) return r;
    }
  } else if (k.city?.replace(/^ +| +$/g, "")) {
    const city = k.city.replace(/^ +| +$/g, "").toLowerCase();
    const named = applicable.filter((m) => m.city.replace(/^ +| +$/g, "").toLowerCase() === city);
    if (named.length === 0) {
      const r = soft("market_unverified", `${k.city.trim()} is not a recorded service market of this site.`);
      if (r) return r;
    } else if (named.length > 1) {
      const r = soft("market_ambiguous", `${k.city.trim()} names more than one recorded market; record the keyword's market explicitly.`);
      if (r) return r;
    } else market = named[0];
  }
  if (market) {
    partial = { ...partial, market_id: market.id, market: `${market.city}, ${market.state}` };
    if (market.status !== "approved") {
      const r = soft("market_unverified", `${market.city}, ${market.state} is ${market.status} (${market.source_ref.slice(0, 160)}).`);
      if (r) return r;
    }
  } else if (role === "city" && !k.market_id && !k.city?.trim()) {
    const r = soft("market_unmapped", "A city page owns the keyword; record the keyword's market.");
    if (r) return r;
  }

  if (purpose) {
    if (role === "blog" && purpose === "blog") {
      return fail("keyword_already_owned", "A published article already owns the keyword; refresh it instead of writing another.");
    }
    if (!ownerAllows(role, purpose, k.intent)) {
      const r = soft("owner_role_not_allowed", `A ${role} page does not anchor a ${purpose} for a ${k.intent ?? "unlabelled"} keyword.`);
      if (r) return r;
    }
  }
  return {
    ok: true, notes,
    owner: {
      url: owner, display_url: displayUrl, page_group_id: groupId, role, program_id: program,
      market_id: market?.id ?? null, market: market ? `${market.city}, ${market.state}` : null,
      related_service_id: k.service_id, from_service: fromService,
    },
  };
}

// Approved service-market city names for a program (the places a draft may name).
export function approvedMarketPlaces(ctx: OwnerContext, program: string | null): string[] {
  return ctx.markets.filter((m) => m.status === "approved" && (m.brand_workspace_id === null || m.brand_workspace_id === program)).map((m) => m.city);
}
