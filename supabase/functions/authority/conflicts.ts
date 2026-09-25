// Conflicts and cannibalization. Everything here is a FACT about the data or
// the live site, except where a reason says HEURISTIC. Pure.
import { DETECTORS } from "../post-drafter/rules.ts";
import type { ClaimRef, Conflict, KeywordAssignment, Pillar, Reason, SitePage } from "./types.ts";
import { placesIn, type PlaceIndex } from "./urls.ts";
import type { ClassifiedPage } from "./site.ts";

const HEADING_RISK = new Set(["credential", "superlative", "pricing", "tenure", "review", "response"]);

// Wording on a page's title / H1 / H2s that the governed rules would refuse:
// unapproved places, and credential / superlative / pricing words not inside
// the exact text of a usable claim.
export function pageWordingIssues(page: SitePage, places: PlaceIndex, citable: ClaimRef[]): Reason[] {
  const out: Reason[] = [];
  const fields: [string, string | null][] = [["title", page.title], ["H1", page.h1], ...page.h2.map((h, i) => [`H2 #${i + 1}`, h] as [string, string])];
  for (const [label, raw] of fields) {
    if (!raw) continue;
    let text = raw;
    for (const c of citable) text = text.split(new RegExp(c.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")).join(" ");
    const bad = placesIn(text, places).filter((p) => !p.approved).map((p) => p.name);
    if (bad.length) out.push({ tag: "FACT", text: `${label} "${raw}" names ${[...new Set(bad)].join(", ")}, not an approved location.` });
    const words: string[] = [];
    for (const d of DETECTORS) {
      if (!HEADING_RISK.has(d.category)) continue;
      d.re.lastIndex = 0;
      for (const m of text.matchAll(d.re)) words.push(`"${m[0].trim()}" (${d.category})`);
    }
    if (words.length) out.push({ tag: "FACT", text: `${label} "${raw}" uses ${[...new Set(words)].join(", ")}, which no usable claim states.` });
  }
  return out;
}

export function findConflicts(args: {
  pillars: Pillar[]; keywords: KeywordAssignment[]; pages: ClassifiedPage[]; places: PlaceIndex;
  unconfirmed: { path: string; tokens: string[]; title: string | null }[]; blindSpots: string[];
  blogOverlaps: { topic: string; paths: string[]; shared_queries: string[] }[];
  blogWording: { path: string; reasons: Reason[] }[];
  servicePageUrlGaps: { service: string; owner: string; recorded: string | null }[];
}): Conflict[] {
  const out: Conflict[] = [];
  for (const p of args.pillars) {
    if (p.owner.conflict) out.push({ kind: "owner_conflict", subject: p.name, reasons: p.owner.reasons.filter((r) => /disagree|point/.test(r.text)) });
    if (p.owner.state !== "live") out.push({ kind: "owner_unavailable", subject: p.name, reasons: p.owner.reasons });
    if (p.page_issues.length) out.push({ kind: "owner_page_wording", subject: `${p.name} (${p.owner.path})`, reasons: p.page_issues });
    const rk = p.gsc.rank;
    if (p.owner.state === "live" && rk?.url_path && p.owner.path && rk.url_path !== p.owner.path) {
      out.push({ kind: "ranking_differs_from_owner", subject: p.name, reasons: [
        { tag: "FACT", text: `"${rk.keyword}" ranks with ${rk.url_path} (organic ${rk.organic ?? "–"}, map pack ${rk.map_pack ?? "–"}, ${rk.recorded_at?.slice(0, 10)}), not the owner ${p.owner.path}.` },
      ] });
    }
    if (p.owner.state === "live" && p.gsc.impressions > 0 && p.gsc.owner_impressions === 0) {
      out.push({ kind: "owner_not_earning", subject: p.name, reasons: [
        { tag: "FACT", text: `In ${p.gsc.window}, ${p.gsc.impressions} impressions for this topic landed on ${p.gsc.landing_pages.map((l) => l.path).join(", ")}; the owner ${p.owner.path} earned none.` },
      ] });
    }
    const polluted = args.keywords.filter((k) => k.service_id === p.service_id && k.flags.includes("homepage_pollution"));
    if (polluted.length) out.push({ kind: "keyword_pollution", subject: p.name, reasons: [
      { tag: "FACT", text: `${polluted.length} of its keywords target the home page: ${polluted.map((k) => k.keyword).slice(0, 8).join(", ")}${polluted.length > 8 ? "…" : ""}.` },
      { tag: "HEURISTIC", text: "They read as brand / general-roofer terms; they belong to the Home page group, not this service." },
    ] });
  }
  for (const g of args.servicePageUrlGaps) {
    out.push({ kind: "service_page_url_gap", subject: g.service, reasons: [
      { tag: "FACT", text: `The owner page ${g.owner} is live, but the service record's page is ${g.recorded ?? "empty"}; the drafter reads the service record, so it cannot target this service.` },
    ] });
  }
  const loc = args.pages.filter((p) => p.kind === "location");
  const unapprovedLoc = loc.filter((p) => !placesIn(p.slug?.replace(/-/g, " ") ?? "", args.places).some((x) => x.approved));
  if (unapprovedLoc.length) out.push({ kind: "unapproved_location_pages", subject: `${unapprovedLoc.length} of ${loc.length} service-area pages`, reasons: [
    { tag: "FACT", text: `Live service-area pages for places that are not approved locations: ${unapprovedLoc.map((p) => p.slug).join(", ")}.` },
    { tag: "REQUIRES_CONFIRMATION", text: "They count as existing coverage; they do not authorise new location-targeted content until a person approves the market." },
  ] });
  for (const u of args.unconfirmed) out.push({ kind: "unconfirmed_service", subject: u.path, reasons: [
    { tag: "FACT", text: `Live page "${u.title ?? u.path}" is not owned by any approved service.` },
    { tag: "REQUIRES_CONFIRMATION", text: "Live pages and search demand are discovery signals, not proof the client wants the service promoted." },
  ] });
  for (const o of args.blogOverlaps) out.push({ kind: "blog_overlap", subject: o.topic, reasons: [
    { tag: "FACT", text: `${o.paths.length} live blog posts cover it: ${o.paths.join(", ")}.` },
    ...(o.shared_queries.length ? [{ tag: "FACT" as const, text: `They compete for the same queries: ${o.shared_queries.join("; ")}.` }] : []),
    { tag: "HEURISTIC", text: "Topic match is by title and slug pattern." },
  ] });
  for (const b of args.blogWording) out.push({ kind: "blog_wording", subject: b.path, reasons: b.reasons });
  if (args.blindSpots.length) out.push({ kind: "coverage_blind_spot", subject: "content_posts", reasons: [
    { tag: "FACT", text: `${args.blindSpots.length} live blog posts are not recorded in content_posts: ${args.blindSpots.join(", ")}.` },
  ] });
  return out;
}
