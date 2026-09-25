// Opportunities: action, deterministic gates, priority tier and provenance.
//
// Deterministic: the gates, owner state, conflicts, the action for each
// data situation, the tier rules and the sort order. Heuristic (and tagged
// so): supporting-topic templates, the cadence constant, title / query
// pattern matches, the suggested angle. The Business Profile gate IS the
// drafter's own buildBrief, so Authority never promises a post the drafter
// would refuse. Pure.
import { buildBrief } from "../post-drafter/brief.ts";
import { cadence, GBP_CADENCE_DAYS } from "./coverage.ts";
import { aboutUnconfirmed } from "./keywords.ts";
import { normPath } from "./urls.ts";
import type {
  Action, AuthorityInput, ContentType, CoverageItem, Gate, KeywordAssignment, Opportunity, Pillar, Reason,
  SupportingTopic, Tag, Tier,
} from "./types.ts";

type Draft = Omit<Opportunity, "tier" | "order" | "provenance"> & { value: number; severity: number; impressions: number; deferred: boolean };

const TAGS: Tag[] = ["FACT", "HEURISTIC", "RESEARCH_REQUIRED", "REQUIRES_CONFIRMATION"];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function base(p: Partial<Draft> & Pick<Draft, "id" | "topic" | "action" | "content_type" | "gap">): Draft {
  return {
    service_id: null, target: { keyword_id: null, keyword: null, intent: null, location: null, owner_path: null, cta: null },
    evidence_claim_ids: [], existing_coverage: [], blockers: [], gates: [], eligible_from: null, reasons: [],
    value: 1, severity: 1, impressions: 0, deferred: false, ...p,
  };
}

export function pillarValue(p: Pillar, kws: KeywordAssignment[]): number {
  const mine = kws.filter((k) => k.service_id === p.service_id);
  if (mine.some((k) => k.money && (k.role === "primary" || k.role === "supporting"))) return 3;
  if (mine.some((k) => k.priority === "p1" || k.role === "primary")) return 2;
  return 1;
}

function bestKeyword(kws: KeywordAssignment[], serviceId: string, intent: string): KeywordAssignment | null {
  const rank = (k: KeywordAssignment) => [k.money ? 0 : 1, k.role === "primary" ? 0 : 1, (k.priority ?? "p9").localeCompare("p0"), -(k.volume ?? 0)];
  return kws
    .filter((k) => k.service_id === serviceId && k.intent === intent && (k.role === "primary" || k.role === "supporting"))
    .sort((a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return a.keyword.localeCompare(b.keyword); })[0] ?? null;
}

export function buildOpportunities(ctx: {
  input: AuthorityInput; pillars: Pillar[]; keywords: KeywordAssignment[]; supporting: SupportingTopic[];
  unconfirmed: { path: string; tokens: string[]; context: string[]; title: string | null; queries: { query: string; impressions: number }[] }[];
  unapprovedLocationPages: string[]; blindSpots: string[];
  blogOverlaps: { topic: string; paths: string[]; shared_queries: string[] }[];
  servicePageUrlGaps: { service_id: string; service: string; owner: string; recorded: string | null }[];
  homeIssues?: Reason[];
}): Opportunity[] {
  const { input, pillars, keywords } = ctx;
  const out: Draft[] = [];

  for (const p of pillars) {
    const value = pillarValue(p, keywords);
    const primary = keywords.find((k) => k.service_id === p.service_id && k.role === "primary") ?? null;
    const relevant = p.evidence.relevant.map((c) => c.id);
    const cov = p.coverage;

    // ── Owner page missing / broken → create it (or finish the proposal) ──
    if (p.owner.state !== "live") {
      const hasEvidence = relevant.length > 0;
      const reasons: Reason[] = [...p.owner.reasons];
      if (p.owner.pending_proposal) reasons.push({ tag: "HEURISTIC", text: "Finish the pending proposal rather than starting a second page." });
      if (p.gsc.impressions) reasons.push({ tag: "FACT", text: `Search demand already exists: ${p.gsc.impressions} impressions in ${p.gsc.window}, best position ${p.gsc.best_position ?? "–"}, landing on ${p.gsc.landing_pages.map((l) => l.path).join(", ")}.` });
      out.push(base({
        id: `service_page:${slug(p.name)}`, topic: p.name, service_id: p.service_id,
        action: hasEvidence ? "create" : "insufficient_evidence", content_type: "service_page",
        target: { keyword_id: primary?.keyword_id ?? null, keyword: primary?.keyword ?? null, intent: primary?.intent ?? "commercial", location: null, owner_path: p.owner.path, cta: null },
        evidence_claim_ids: relevant, existing_coverage: cov,
        gap: `The owner page ${p.owner.path ?? "(none)"} is ${p.owner.state === "none" ? "not defined" : p.owner.state.replace("_", " ")}.`,
        blockers: hasEvidence ? [] : ["No usable claim relevant to this service."],
        gates: [
          { gate: "approved_service", pass: true, detail: "Approved service." },
          { gate: "evidence", pass: hasEvidence, detail: `${relevant.length} relevant usable claim(s).` },
          { gate: "owner_page", pass: true, detail: "This opportunity creates it." },
        ],
        reasons, value, severity: 4, impressions: p.gsc.impressions,
      }));
    }

    // ── Owner page live but its wording or ownership is wrong → improve ──
    if (p.owner.state === "live") {
      const reasons: Reason[] = [...p.page_issues];
      const rk = p.gsc.rank;
      if (rk?.url_path && rk.url_path !== p.owner.path) reasons.push({ tag: "FACT", text: `"${rk.keyword}" ranks with ${rk.url_path} (organic ${rk.organic ?? "–"}, map pack ${rk.map_pack ?? "–"}), not ${p.owner.path}.` });
      if (p.gsc.impressions > 0 && p.gsc.owner_impressions === 0) reasons.push({ tag: "FACT", text: `The owner page earned 0 of ${p.gsc.impressions} impressions for this topic in ${p.gsc.window}.` });
      if (reasons.length) {
        reasons.push({ tag: "HEURISTIC", text: "Fix the headings to the approved location and remove wording no claim supports; link to the owner from the pages Google currently prefers." });
        out.push(base({
          id: `page_improvement:${slug(p.name)}`, topic: p.name, service_id: p.service_id, action: "improve", content_type: "page_improvement",
          target: { keyword_id: primary?.keyword_id ?? null, keyword: primary?.keyword ?? null, intent: primary?.intent ?? null, location: null, owner_path: p.owner.path, cta: null },
          evidence_claim_ids: relevant, existing_coverage: cov,
          gap: p.page_issues.length ? "The owner page's headings conflict with the governed rules." : "Google does not yet associate the topic with its owner page.",
          gates: [
            { gate: "approved_service", pass: true, detail: "Approved service." },
            { gate: "owner_page", pass: true, detail: `${p.owner.path} is live.` },
            // Removing unsupported wording needs no new claim; any new statement still needs one.
            { gate: "no_new_claims", pass: true, detail: `Fix removes or corrects wording; ${relevant.length} relevant usable claim(s) available for anything added.` },
          ],
          reasons, value, severity: p.page_issues.some((r) => !/not an approved location/.test(r.text)) || (p.gsc.impressions > 0 && p.gsc.owner_impressions === 0) ? 3 : 2, impressions: p.gsc.impressions,
        }));
      }

      // ── Business Profile post, per intent, through the drafter's own gate ──
      const gap = ctx.servicePageUrlGaps.find((g) => g.service_id === p.service_id);
      const intents = [...new Set(keywords.filter((k) => k.service_id === p.service_id && k.intent && (k.role === "primary" || k.role === "supporting")).map((k) => k.intent!))].sort();
      for (const intent of intents) {
        if (intent === "navigational") continue;
        const kw = bestKeyword(keywords, p.service_id, intent);
        if (!kw) continue;
        const gates: Gate[] = [];
        const reasons: Reason[] = [];
        const blockers: string[] = [];
        let action: Action = "create";
        let evidence: string[] = [];
        if (gap) {
          blockers.push(`The service record's page is ${gap.recorded ?? "empty"} while the owner is ${gap.owner}; fix the record first.`);
          gates.push({ gate: "drafter_brief", pass: false, detail: "Not attempted: the service record has no valid page." });
          action = "insufficient_evidence";
        } else {
          const r = buildBrief(input, { channel: "google_business", postType: "standard", intent, serviceId: p.service_id, keywordId: kw.keyword_id, ctaType: "LEARN_MORE", offerId: null, assetIds: [] });
          if (!r.ok) {
            gates.push({ gate: "drafter_brief", pass: false, detail: r.refusals.map((x) => x.code).join(", ") });
            for (const x of r.refusals) blockers.push(x.message);
            action = "insufficient_evidence";
          } else {
            gates.push({ gate: "drafter_brief", pass: true, detail: "The drafter's governed brief builds for this target." });
            const used = new Set(input.authority.socialPosts.filter((s) => s.service_id === p.service_id && s.review_status !== "rejected").flatMap((s) => s.claim_ids));
            const allowed = r.brief.allowed_facts.claims;
            const fresh = allowed.filter((c) => !used.has(c.id)).map((c) => c.id);
            evidence = [...fresh, ...r.brief.allowed_facts.recommended_claim_ids.filter((id) => !fresh.includes(id))].slice(0, r.brief.allowed_facts.max_claims);
            if (fresh.length) reasons.push({ tag: "HEURISTIC", text: `Lead with evidence the last post did not use: ${allowed.filter((c) => fresh.includes(c.id)).map((c) => c.text).slice(0, 2).join("; ")}.` });
          }
        }
        const cad = cadence(input, p.service_id, intent);
        let deferred = false;
        if (cad.last) {
          const open = cad.last.review_status === "draft" || cad.last.review_status === "in_review";
          reasons.push({ tag: "FACT", text: `Last ${intent} Business Profile post on this service: ${cad.last.created_at.slice(0, 10)} (${cad.last.review_status}/${cad.last.publish_status}).` });
          if (open) { action = action === "create" ? "avoid" : action; blockers.push("An open drafted post already exists for this service and intent."); }
          else if (cad.blocked) { deferred = true; reasons.push({ tag: "HEURISTIC", text: `${GBP_CADENCE_DAYS}-day cadence per service + intent: eligible from ${cad.eligible_from}.` }); }
        }
        gates.push({ gate: "cadence", pass: !cad.blocked, detail: cad.blocked ? `Blocked until ${cad.eligible_from ?? "the open post is decided"}.` : "No recent post for this service and intent." });
        out.push(base({
          id: `gbp_post:${slug(p.name)}:${intent}`, topic: p.name, service_id: p.service_id, action, content_type: "gbp_post",
          target: { keyword_id: kw.keyword_id, keyword: kw.keyword, intent, location: null, owner_path: p.owner.path, cta: "LEARN_MORE" },
          evidence_claim_ids: evidence, existing_coverage: cov.filter((c) => c.kind === "gbp_post"),
          gap: `A ${intent} Business Profile post for "${kw.keyword}".`, blockers, gates, eligible_from: deferred ? cad.eligible_from : null,
          reasons, value, severity: 2, impressions: p.gsc.impressions, deferred,
        }));
      }
    }

    // ── Keywords mapped to the service but owned by the home page → data fix ──
    const polluted = keywords.filter((k) => k.service_id === p.service_id && k.flags.includes("homepage_pollution"));
    if (polluted.length) {
      out.push(base({
        id: `data_fix:keyword-ownership:${slug(p.name)}`, topic: p.name, service_id: p.service_id, action: "improve", content_type: "data_fix",
        target: { keyword_id: null, keyword: null, intent: null, location: null, owner_path: "/", cta: null },
        gap: `${polluted.length} keywords under ${p.name} target the home page.`,
        gates: [{ gate: "data_only", pass: true, detail: "Changes CRM data, not content." }],
        reasons: [
          { tag: "FACT", text: `${polluted.map((k) => k.keyword).join(", ")}.` },
          ...(polluted.some((k) => k.money) ? [{ tag: "FACT" as const, text: `Includes money keywords: ${polluted.filter((k) => k.money).map((k) => k.keyword).join(", ")}.` }] : []),
          { tag: "HEURISTIC", text: "Re-home them to the Home page group so this service's topic, evidence and GSC read cleanly." },
        ],
        value: polluted.some((k) => k.money) ? 3 : 2, severity: 3,
      }));
    }
  }

  // ── The home page's own headings (it earns most impressions today) ──
  if (ctx.homeIssues?.length) out.push(base({
    id: "page_improvement:home", topic: "Home page", action: "improve", content_type: "page_improvement",
    target: { keyword_id: null, keyword: null, intent: null, location: null, owner_path: "/", cta: null },
    gap: "The home page's headings conflict with the governed rules.",
    gates: [{ gate: "no_new_claims", pass: true, detail: "Fix removes or corrects wording." }],
    reasons: [...ctx.homeIssues, { tag: "HEURISTIC", text: "Lead with the approved location and supported claims; the home page carries most of the site's search impressions." }],
    value: 3, severity: ctx.homeIssues.some((r) => !/not an approved location/.test(r.text)) ? 3 : 2,
    impressions: latestHomeImpressions(input),
  }));

  // ── Service record pages that disagree with the live owner → data fix ──
  for (const g of ctx.servicePageUrlGaps) {
    out.push(base({
      id: `data_fix:service-page:${slug(g.service)}`, topic: g.service, service_id: g.service_id, action: "improve", content_type: "data_fix",
      target: { keyword_id: null, keyword: null, intent: null, location: null, owner_path: g.owner, cta: null },
      gap: `Set ${g.service}'s service page to ${g.owner} (now ${g.recorded ?? "empty"}).`,
      gates: [{ gate: "data_only", pass: true, detail: "Changes CRM data, not content." }],
      reasons: [{ tag: "FACT", text: `The live owner is ${g.owner}; the drafter and the Intelligence tab read the service record, which says ${g.recorded ?? "nothing"}.` }],
      value: 2, severity: 3,
    }));
  }

  // ── Keywords with no service ──
  const unmapped = keywords.filter((k) => k.role === "unmapped");
  if (unmapped.length) out.push(base({
    id: "data_fix:unmapped-keywords", topic: "Unmapped keywords", action: "improve", content_type: "data_fix",
    gap: `${unmapped.length} keywords have no service${unmapped.some((k) => !k.intent) ? " and no intent" : ""}.`,
    gates: [{ gate: "data_only", pass: true, detail: "Changes CRM data, not content." }],
    reasons: [{ tag: "FACT", text: `${unmapped.slice(0, 10).map((k) => k.keyword).join(", ")}${unmapped.length > 10 ? "…" : ""}.` }],
    value: 1, severity: 1,
  }));

  if (ctx.blindSpots.length) out.push(base({
    id: "data_fix:record-live-blog-posts", topic: "Content inventory", action: "improve", content_type: "data_fix",
    gap: `${ctx.blindSpots.length} live blog posts are missing from content_posts.`,
    gates: [{ gate: "data_only", pass: true, detail: "Changes CRM data, not content." }],
    reasons: [{ tag: "FACT", text: ctx.blindSpots.join(", ") }, { tag: "HEURISTIC", text: "Until they are recorded, the Blog Creator cannot see what it must not duplicate." }],
    value: 1, severity: 2,
  }));

  // ── Needs a person: unconfirmed services, unapproved markets ──
  for (const u of ctx.unconfirmed) {
    const kws = keywords.filter((k) => k.flags.includes("requires_confirmation") && (k.target_path === u.path || aboutUnconfirmed(k.keyword, u)));
    out.push(base({
      id: `confirm_service:${slug(u.path)}`, topic: u.title ?? u.path, action: "requires_confirmation", content_type: "service_page",
      target: { keyword_id: null, keyword: kws[0]?.keyword ?? null, intent: null, location: null, owner_path: u.path, cta: null },
      gap: "No approved service owns this live page.",
      blockers: ["A person must confirm the client wants this service promoted before any content, keyword or claim is assigned."],
      gates: [{ gate: "approved_service", pass: false, detail: "Not in the approved taxonomy." }],
      reasons: [
        { tag: "FACT", text: `Live page ${u.path}: "${u.title ?? ""}".` },
        ...(kws.length ? [{ tag: "FACT" as const, text: `Keywords pointing at it: ${kws.map((k) => k.keyword).join(", ")}.` }] : []),
        ...(u.queries.length ? [{ tag: "FACT" as const, text: `GSC queries (latest window): ${u.queries.slice(0, 5).map((q) => `${q.query} (${q.impressions})`).join(", ")}.` }] : []),
        { tag: "REQUIRES_CONFIRMATION", text: "Discovery signals only; keywords and claims stay unassigned until confirmed." },
      ],
    }));
  }
  if (ctx.unapprovedLocationPages.length) {
    const locKws = keywords.filter((k) => k.flags.includes("location_unapproved"));
    out.push(base({
      id: "confirm_markets:service-areas", topic: "Service-area markets", action: "requires_confirmation", content_type: "location_page",
      gap: `${ctx.unapprovedLocationPages.length} live service-area pages name places that are not approved locations.`,
      blockers: ["New location-targeted content waits for a person to approve the market."],
      gates: [{ gate: "approved_location", pass: false, detail: "Not approved locations." }],
      reasons: [
        { tag: "FACT", text: `Pages: ${ctx.unapprovedLocationPages.join(", ")}.` },
        ...(locKws.length ? [{ tag: "FACT" as const, text: `Keywords naming them: ${locKws.map((k) => k.keyword).join(", ")}.` }] : []),
        { tag: "REQUIRES_CONFIRMATION", text: "Existing pages count as coverage; approving a market is a separate, later decision." },
      ],
    }));
  }

  // ── Keywords the writers could never honour ──
  const risky = keywords.filter((k) => k.role === "avoid_risky");
  if (risky.length) out.push(base({
    id: "avoid:risky-keywords", topic: "Keywords with unsupportable modifiers", action: "avoid", content_type: "gbp_post",
    gap: "Content targeting these would need superlatives, prices, credentials, reviews or promises no claim supports.",
    gates: [{ gate: "hard_rules", pass: false, detail: "Conflicts with the brand's hard rules / drafter detectors." }],
    reasons: risky.map((k) => ({ tag: "FACT" as const, text: `"${k.keyword}": ${k.reasons.find((r) => /Contains/.test(r.text))?.text ?? ""}` })),
  }));
  const material = keywords.filter((k) => k.role === "material_unsupported");
  if (material.length) out.push(base({
    id: "evidence:unsupported-materials", topic: "Materials no claim names", action: "insufficient_evidence", content_type: "gbp_post",
    gap: "A material may be presented as offered only when a usable claim names it.",
    gates: [{ gate: "evidence", pass: false, detail: "No usable claim names the material." }],
    reasons: material.map((k) => ({ tag: "FACT" as const, text: `"${k.keyword}": ${k.reasons.filter((r) => /which no usable claim/.test(r.text)).map((r) => r.text).join(" ")}` })),
  }));

  // ── Supporting topics that are not plain "create" ──
  for (const s of ctx.supporting) {
    if (s.action === "create") continue; // carried by the pillar's post / page opportunities
    const overlap = ctx.blogOverlaps.find((o) => o.topic === s.name);
    const ct: ContentType = s.action === "consolidate" || s.action === "refresh" ? "blog_refresh" : "blog_post";
    out.push(base({
      id: `topic:${s.key}`, topic: s.name, service_id: s.service_ids[0] ?? null, action: s.action, content_type: ct,
      evidence_claim_ids: s.evidence.map((e) => e.id), existing_coverage: s.coverage,
      gap: s.reasons.find((r) => r.tag !== "HEURISTIC")?.text ?? s.name,
      blockers: s.action === "research_required" ? ["Needs a research / evidence layer (not built in v1)."] : s.action === "insufficient_evidence" ? ["Needs a client-confirmed fact."] : [],
      gates: [{ gate: "evidence", pass: s.action === "consolidate" || s.action === "refresh", detail: s.action }],
      reasons: s.reasons, value: overlap ? 2 : 1, severity: overlap ? 2 : 1,
    }));
  }

  return prioritize(out);
}

function latestHomeImpressions(input: AuthorityInput): number {
  const rows = input.authority.gsc;
  if (!rows.length) return 0;
  const end = rows.reduce((m, r) => (r.period_end > m ? r.period_end : m), rows[0].period_end);
  const site = input.authority.site?.url ?? input.client.website_url;
  return rows.filter((r) => r.period_end === end && normPath(r.page, site) === "/").reduce((s, r) => s + r.impressions, 0);
}

const CONTENT_ACTIONS = new Set<Action>(["create", "improve", "refresh", "consolidate"]);

export function tierOf(d: Draft): Tier {
  if (!CONTENT_ACTIONS.has(d.action)) return "none";
  if (d.gates.some((g) => !g.pass && g.gate !== "cadence")) return "none";
  if (!d.deferred && d.value >= 3 && d.severity >= 3) return "A";
  if (d.severity >= 2 || d.deferred || d.value >= 2) return "B";
  return "C";
}

export function prioritize(drafts: Draft[]): Opportunity[] {
  const tierRank: Record<Tier, number> = { A: 0, B: 1, C: 2, none: 3 };
  const withTier = drafts.map((d) => {
    const tier = tierOf(d);
    const order = [tierRank[tier], -d.value, -d.severity, d.deferred ? 1 : 0, -d.evidence_claim_ids.length, -d.impressions];
    const provenance = Object.fromEntries(TAGS.map((t) => [t, d.reasons.filter((r) => r.tag === t).map((r) => r.text)])) as Record<Tag, string[]>;
    const { value: _v, severity: _s, impressions: _i, deferred: _d, ...rest } = d;
    return { ...rest, tier, order, provenance } as Opportunity;
  });
  return withTier.sort((a, b) => {
    for (let i = 0; i < a.order.length; i++) if (a.order[i] !== b.order[i]) return a.order[i] - b.order[i];
    return a.id.localeCompare(b.id);
  });
}

export type { CoverageItem };
