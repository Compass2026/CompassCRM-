// Authority Engine v1 (D1): the orchestrator. One pure function from an
// AuthorityInput to an AuthorityReport — no model, no network, no database,
// no clock (the run is judged at input.authority.now). Read-only by
// construction: nothing here can write anywhere.
import { citableClaims, evidenceFor } from "./evidence.ts";
import { resolveOwner } from "./owners.ts";
import { aboutUnconfirmed, classifyKeywords } from "./keywords.ts";
import { distinctStems } from "./evidence.ts";
import { blindSpots, contentPostCoverage, pageCoverage, pendingProposals, postCoverage } from "./coverage.ts";
import { gscForService, landingPath, latestWindow } from "./gsc.ts";
import { TEMPLATES } from "./playbooks.ts";
import { findConflicts, pageWordingIssues } from "./conflicts.ts";
import { buildOpportunities } from "./opportunities.ts";
import { classifyPages, prefixes, slugWords, type ClassifiedPage } from "./site.ts";
import { buildInventory, normPath, placesIn, buildPlaceIndex, type Inventory, type PlaceIndex } from "./urls.ts";
import {
  AUTHORITY_VERSION, type Action, type AuthorityInput, type AuthorityReport, type ClaimRef, type CoverageItem,
  type OwnerResolution, type Pillar, type Reason, type SupportingTopic,
} from "./types.ts";

type Service = AuthorityInput["services"][number];

const stems4 = (s: string) => (s.toLowerCase().match(/[a-z]{4,}/g) ?? []).map((w) => w.slice(0, 4));
const titleCase = (s: string) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pageText = (p: ClassifiedPage) => `${p.page.title ?? ""} ${p.page.h1 ?? ""} ${slugWords(p.slug)}`;

// Places the engine recognises: the state gazetteer, the client's city page
// groups and the slugs of its live service-area pages. Approved = the active
// governed locations only. The client's own name never counts as a place.
export function placeIndexFor(input: AuthorityInput, pages: ClassifiedPage[]): PlaceIndex {
  const names = [
    ...(input.authority.places ?? []),
    ...input.authority.pageGroupsFull.filter((g) => g.page_type === "city").map((g) => g.name),
    ...pages.filter((p) => p.kind === "location" && p.slug).map((p) => titleCase(slugWords(p.slug))),
    ...input.locations.flatMap((l) => [l.city ?? "", (l.name ?? "").replace(/,.*$/, "")]),
  ].filter(Boolean);
  const approved = input.locations.filter((l) => l.is_active).flatMap((l) => [l.city ?? "", (l.name ?? "").replace(/,.*$/, "")]).filter(Boolean);
  const clientWords = (input.client.name.match(/[A-Za-z']{4,}/g) ?? []);
  return buildPlaceIndex(names, approved, [input.client.name, ...clientWords]);
}

// A service whose only live landing is a redirect into ANOTHER service's
// designated page has no page of its own (Lucas: /roofing-repairs → the Roof
// Replacement page). Its owner falls back to its own designated page, in
// whatever state that is, and the redirect is reported as a conflict.
export function borrowedOwners(services: Service[], owners: Map<string, OwnerResolution>) {
  const designated = new Map<string, string>();
  for (const s of services) {
    const o = owners.get(s.id)!;
    const d = o.candidates.find((c) => c.source === "page_group") ?? o.candidates[0];
    if (d) designated.set(d.state === "redirects" ? d.final_path ?? d.path : d.path, s.name);
  }
  for (const s of services) {
    const o = owners.get(s.id)!;
    if (o.state !== "live" || !o.path) continue;
    const other = designated.get(o.path);
    if (!other || other === s.name) continue;
    const ownOwn = o.candidates.some((c) => c.state === "live" && c.path === o.path);
    if (ownOwn) continue;
    const own = o.candidates.find((c) => c.source === "page_group") ?? o.candidates.find((c) => c.final_path !== o.path) ?? null;
    owners.set(s.id, {
      ...o, path: own?.path ?? null, state: own ? (own.state === "redirects" ? "missing" : own.state) : "none",
      source: own?.source ?? null, conflict: true,
      reasons: [...o.reasons, { tag: "FACT", text: `Its only live landing, ${o.path}, is ${other}'s page: ${s.name} has no page of its own.` }],
    });
  }
}

// Live service pages no approved service owns: discovery, never a service.
export function unconfirmedServicePages(input: AuthorityInput, pages: ClassifiedPage[], owners: OwnerResolution[], inv: Inventory) {
  const approved = input.services.filter((s) => s.status === "approved");
  const owned = new Set<string>();
  for (const o of owners) for (const c of o.candidates) {
    owned.add(c.path);
    if (c.final_path) owned.add(c.final_path);
  }
  const known = new Set(approved.flatMap((s) => stems4(s.name)));
  const { rows } = latestWindow(input.authority.gsc);
  return pages
    .filter((p) => p.kind === "service" && !owned.has(p.path))
    .map((p) => {
      const words = slugWords(p.slug).toLowerCase().match(/[a-z]{4,}/g) ?? [];
      const tokens = words.filter((w) => !known.has(w.slice(0, 4)));
      const context = words.filter((w) => known.has(w.slice(0, 4)));
      const u = { path: p.path, tokens, context };
      const agg = new Map<string, number>();
      for (const r of rows) {
        const lands = landingPath(input, inv, r.page) === p.path;
        if (lands || aboutUnconfirmed(r.query, u)) agg.set(r.query, (agg.get(r.query) ?? 0) + r.impressions);
      }
      const queries = [...agg].map(([query, impressions]) => ({ query, impressions })).sort((a, b) => b.impressions - a.impressions);
      return { ...u, title: p.page.title ?? p.page.h1, queries };
    })
    .filter((u) => u.tokens.length > 0);
}

function supportingTopics(input: AuthorityInput, pages: ClassifiedPage[], citable: ClaimRef[]): SupportingTopic[] {
  const approved = input.services.filter((s) => s.status === "approved");
  const blogs = pages.filter((p) => p.kind === "blog");
  const out: SupportingTopic[] = [];
  for (const t of TEMPLATES) {
    const svc = approved.filter((s) => t.segment.test(`${s.segment ?? ""} ${s.name}`));
    if (!svc.length) continue;
    const reasons: Reason[] = [{ tag: "HEURISTIC", text: t.angle }];
    const covered = t.blog ? blogs.filter((b) => t.blog!.test(pageText(b))) : [];
    const coverage: CoverageItem[] = covered.map((b) => ({ kind: "blog", ref: b.path, label: b.page.title ?? b.path, state: "live", tag: "FACT" }));
    const evidence = t.claim ? citable.filter((c) => t.claim!.test(c.text)) : [];
    const unusable = t.claim ? input.claims.filter((c) => t.claim!.test(c.claim) && !citable.some((x) => x.id === c.id)) : [];
    let action: Action;
    let ids = svc.map((s) => s.id);
    if (t.kind === "forbidden") {
      action = "avoid";
      reasons.unshift({ tag: "FACT", text: t.rule ?? "Conflicts with a hard rule." });
    } else if (t.kind === "entity" || t.kind === "client_fact") {
      if (evidence.length) {
        action = "create";
        reasons.unshift({ tag: "FACT", text: `Usable evidence: ${evidence.map((e) => e.text).join("; ")}.` });
      } else {
        action = "insufficient_evidence";
        reasons.unshift({ tag: "FACT", text: `No usable claim states it${unusable.length ? ` (not citable: ${unusable.map((c) => `"${c.claim}" — ${c.status}`).join("; ")})` : ""}.` });
      }
    } else {
      if (t.kind === "comparison") {
        const need = (t.services ?? []).map((re) => approved.find((s) => re.test(s.name)));
        if (need.some((s) => !s)) continue; // not meaningful without both services
        ids = need.map((s) => s!.id);
      }
      if (covered.length >= 2) {
        action = "consolidate";
        reasons.unshift({ tag: "FACT", text: `${covered.length} live blog posts already cover it: ${covered.map((b) => b.path).join(", ")}.` });
      } else if (covered.length === 1) {
        action = "avoid";
        reasons.unshift({ tag: "FACT", text: `Already covered by ${covered[0].path}; a new post would duplicate it.` });
      } else {
        action = "research_required";
        reasons.unshift({ tag: "RESEARCH_REQUIRED", text: "Needs general factual information Client Intelligence does not hold; model knowledge never substitutes for evidence." });
      }
      if (evidence.length) reasons.push({ tag: "FACT", text: `Client evidence that may be cited alongside: ${evidence.map((e) => e.text).join("; ")}.` });
    }
    out.push({ key: t.key, name: t.name, service_ids: ids, action, reasons, evidence, coverage });
  }
  return out;
}

// Blog posts on the same topic, and the latest-window queries they share.
function blogOverlaps(input: AuthorityInput, inv: Inventory, supporting: SupportingTopic[]) {
  const { rows } = latestWindow(input.authority.gsc);
  return supporting.filter((s) => s.coverage.filter((c) => c.kind === "blog").length >= 2).map((s) => {
    const paths = s.coverage.filter((c) => c.kind === "blog").map((c) => c.ref);
    const landing = new Map<string, Set<string>>();
    for (const r of rows) {
      const p = landingPath(input, inv, r.page);
      if (p && paths.includes(p)) landing.set(r.query, (landing.get(r.query) ?? new Set()).add(p));
    }
    return { topic: s.name, paths, shared_queries: [...landing].filter(([, ps]) => ps.size > 1).map(([q]) => q) };
  });
}

// Blog wording the brand forbids (words we avoid, anywhere in the page), or
// headings the governed rules would refuse.
function blogWording(input: AuthorityInput, pages: ClassifiedPage[], places: PlaceIndex, citable: ClaimRef[]) {
  const avoid = input.brand?.words_we_avoid ?? [];
  const out: { path: string; reasons: Reason[] }[] = [];
  for (const b of pages.filter((p) => p.kind === "blog")) {
    const reasons: Reason[] = [];
    const hay = `${b.page.title ?? ""} ${b.page.h1 ?? ""} ${b.page.h2.join(" ")} ${b.page.text ?? ""}`;
    const hits = avoid.filter((w) => new RegExp(`\\b${esc(w)}\\b`, "i").test(hay));
    if (hits.length) reasons.push({ tag: "FACT", text: `Uses brand "words we avoid": ${hits.map((h) => `"${h}"`).join(", ")}.` });
    const heading = { ...b.page, h2: [] as string[] };
    const issues = pageWordingIssues(heading, places, citable).filter((r) => !/not an approved location/.test(r.text));
    reasons.push(...issues);
    if (reasons.length) out.push({ path: b.path, reasons });
  }
  return out;
}

function judgments(input: AuthorityInput, pillars: Pillar[]): string[] {
  const out = [
    "HEURISTIC: supporting-topic templates and their title / slug patterns (playbooks.ts) — a person should review the list per vertical.",
    `HEURISTIC: Business Profile cadence of one post per service + intent per 21 days.`,
    "HEURISTIC: claim relevance to a service is by shared word stem, owner-page source or segment in the source URL; it can miss a relevant claim or include a loose one.",
    "HEURISTIC: unmapped Search Console queries are matched to a service when they contain every 5+ letter stem of its name.",
    "HEURISTIC: tier thresholds (value 3 = a money keyword, 2 = a P1 / primary keyword; severity 4 = the owner page is missing or broken).",
    "JUDGMENT: whether an educational topic already covered by one blog post should be refreshed rather than left alone (the engine says avoid).",
    "JUDGMENT: which of several overlapping blog posts survives a consolidation, and where the others redirect.",
    "JUDGMENT: a material is supported only when a usable claim names it; a brand of shingle does not prove the generic material (\"Duration shingles\" does not state \"asphalt\").",
  ];
  if (pillars.some((p) => p.owner.conflict)) out.push("JUDGMENT: which of the conflicting owner candidates becomes the owner page (the engine prefers a live page, then the page group).");
  if (!input.authority.inventory) out.push("MISSING: no site inventory — owner states are 'not_checked' and page coverage is empty.");
  return out;
}

export function runAuthority(input: AuthorityInput): AuthorityReport {
  const a = input.authority;
  const site = a.site?.url ?? input.client.website_url;
  const inv = buildInventory(a.inventory?.pages, site);
  const pages = classifyPages(inv, a.site?.content_paths ?? null);
  const { cityPrefix } = prefixes(a.site?.content_paths ?? null);
  const places = placeIndexFor(input, pages);
  const { citable } = citableClaims(input);
  const approved: Service[] = input.services.filter((s) => s.status === "approved");

  const owners = new Map(approved.map((s) => [s.id, resolveOwner(input, s, inv)]));
  borrowedOwners(approved, owners);
  const unconfirmed = unconfirmedServicePages(input, pages, [...owners.values()], inv);
  const ownerPathByService = new Map(approved.map((s) => [s.id, owners.get(s.id)!.path]));
  const keywords = classifyKeywords(input, { ownerPathByService, cityPrefix, places, citable, unconfirmed, clientName: input.client.name });
  const pending = pendingProposals(input);

  const pillars: Pillar[] = approved.map((s) => {
    const owner = owners.get(s.id)!;
    const livePath = owner.state === "live" ? owner.path : null;
    const kwIds = new Set(input.keywords.filter((k) => k.service_id === s.id).map((k) => k.id));
    const mine = keywords.filter((k) => k.service_id === s.id);
    const by_role: Record<string, number> = {};
    for (const k of mine) by_role[k.role] = (by_role[k.role] ?? 0) + 1;
    const stemRe = new RegExp(`\\b(${distinctStems(s.name).map(esc).join("|") || "$^"})`, "i");
    const coverage: CoverageItem[] = [
      ...(livePath ? [{ kind: "owner_page" as const, ref: livePath, label: inv.resolve(livePath).page?.title ?? livePath, state: "live", tag: "FACT" as const }] : []),
      ...pageCoverage(pages, "location", stemRe),
      ...pageCoverage(pages, "blog", stemRe),
      ...contentPostCoverage(input, kwIds),
      ...postCoverage(input, s.id),
      ...pending.filter((p) => owner.candidates.some((c) => c.path === p.path))
        .map((p) => ({ kind: "pending_proposal" as const, ref: p.path, label: p.title, state: "proposed", tag: "FACT" as const })),
    ];
    const ownerPage = livePath ? inv.resolve(livePath).page : null;
    return {
      service_id: s.id, name: s.name, segment: s.segment ?? null,
      parent: input.services.find((x) => x.id === s.parent_service_id)?.name ?? null,
      owner, evidence: evidenceFor(input, s.name, s.segment ?? null, livePath),
      keywords: { total: mine.length, by_role }, coverage,
      gsc: (({ matched_by_name: _m, ...g }) => g)(gscForService(input, inv, s.name, kwIds, livePath, s.primary_keyword_id)),
      page_issues: ownerPage ? pageWordingIssues(ownerPage, places, citable) : [],
    };
  });

  const servicePageUrlGaps = pillars.flatMap((p) => {
    if (p.owner.state !== "live" || !p.owner.path) return [];
    const svc = approved.find((s) => s.id === p.service_id)!;
    const rec = normPath(svc.page_url, site);
    const r = inv.resolve(rec);
    const lands = r.state === "live" ? rec : r.state === "redirects" ? r.final_path : null;
    return lands === p.owner.path ? [] : [{ service_id: p.service_id, service: p.name, owner: p.owner.path, recorded: svc.page_url }];
  });

  const supporting = supportingTopics(input, pages, citable);
  const overlaps = blogOverlaps(input, inv, supporting);
  const wording = blogWording(input, pages, places, citable);
  const blind = blindSpots(input, pages);
  const unapprovedLocationPages = pages
    .filter((p) => p.kind === "location" && !placesIn(slugWords(p.slug), places).some((x) => x.approved))
    .map((p) => p.path);

  const conflicts = findConflicts({
    pillars, keywords, pages, places, unconfirmed, blindSpots: blind, blogOverlaps: overlaps, blogWording: wording, servicePageUrlGaps,
  });
  const home = pages.find((p) => p.kind === "home");
  const homeIssues = home ? pageWordingIssues(home.page, places, citable) : [];
  if (homeIssues.length) conflicts.push({ kind: "home_page_wording", subject: "/", reasons: homeIssues });
  const opportunities = buildOpportunities({
    input, pillars, keywords, supporting, unconfirmed, unapprovedLocationPages, blindSpots: blind, blogOverlaps: overlaps, servicePageUrlGaps, homeIssues,
  });

  const by_kind: Record<string, number> = {};
  for (const p of pages) by_kind[p.kind] = (by_kind[p.kind] ?? 0) + 1;
  return {
    version: AUTHORITY_VERSION,
    client: { id: input.client.id, name: input.client.name },
    as_of: input.asOf,
    generated_at: a.now,
    inventory: {
      fetched_at: a.inventory?.fetched_at ?? null, pages: inv.byPath.size, live: pages.length, by_kind,
      blind_spots: blind.length ? [{ tag: "FACT", text: `${blind.length} live blog posts are not in content_posts.` }] : [],
    },
    pillars, keywords, conflicts, supporting, opportunities, judgments: judgments(input, pillars),
  };
}

