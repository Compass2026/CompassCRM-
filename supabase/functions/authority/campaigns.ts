// Versioned campaign packages persisted inside each immutable Authority run.
// Existing governed records remain the source of truth. This projection never
// creates content or changes keyword ownership, approvals, schedules or spend.
import type { AuthorityInput, KeywordAssignment, Opportunity, Pillar } from "./types.ts";
import { keywordCampaignRank } from "./opportunities.ts";
import { latestWindow, gscCoverage } from "./gsc.ts";
import { hostOf, normalizeUrl } from "../post-drafter/rules.ts";
import { coreVerdict, groundingProblem } from "./core.ts";

export type CampaignChannel = "website" | "blog" | "google_business" | "facebook" | "email" | "ads";
export type KeywordCampaign = {
  schema_version: 1; key: string; service_id: string; name: string;
  // The service's primary keyword only when the site's approved Core 50
  // grounds it and it is otherwise eligible; else null, with primary_excluded.
  primary: { id: string; keyword: string; intent: string | null } | null;
  primary_excluded?: { keyword: string; reason: string } | null;
  // Grounded membership (reporting). post: null when a Business Profile post
  // may target it now, else the Core 50 code that stops it.
  cluster: { id: string; keyword: string; intent: string | null; post?: string | null }[];
  excluded: { keyword: string; reason: string }[];
  intent_mix: string[]; owner_url: string | null; objective: string;
  blockers: string[]; evidence_claim_ids: string[]; priority: number[];
  // opportunity_keys and review_plan: actionable opportunities only (a content
  // action, every gate but cadence passed, no Core 50 refusal). Opportunities
  // that exist but cannot proceed are blocked_by, with their reason.
  channels: { channel: CampaignChannel; objective: string; opportunity_keys: string[]; existing: number; status: "review_plan" | "existing_content" | "not_planned" | "blocked";
    blocked_by?: { key: string; reason: string }[] }[];
  measurement: {
    window: string | null; coverage: string; impressions: number | null; clicks: number | null;
    ranks: { keyword: string; type: string; position: number | null; recorded_at: string }[];
    content_count: number; traffic: null; conversions: null;
  };
};

const norm = (s: string) => s.toLowerCase().trim().replace(/\s+/g, " ");
const compare = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
};
// Actionable = what a plan may be built from: tier A–C (a content action
// whose every gate passed, cadence aside) and no Core 50 refusal.
export const actionable = (o: Opportunity) => o.tier !== "none" && !o.core?.verdict;
const blockReason = (o: Opportunity) =>
  o.core?.verdict ?? o.gates.find((g) => !g.pass && g.gate !== "cadence")?.gate ?? o.action;
const channelOf = (o: Opportunity): CampaignChannel | null =>
  o.content_type === "gbp_post" ? "google_business" :
  ["blog_post", "blog_refresh"].includes(o.content_type) ? "blog" :
  ["service_page", "location_page", "page_improvement"].includes(o.content_type) ? "website" : null;

export function buildKeywordCampaigns(input: AuthorityInput, keywords: KeywordAssignment[], pillars: Pillar[], opportunities: Opportunity[]): KeywordCampaign[] {
  const active = new Set(input.keywords.filter((k) => k.is_active).map((k) => k.id));
  const window = latestWindow(input.authority.gsc);
  return input.services.filter((s) => s.status === "approved").map((service): KeywordCampaign => {
    const pillar = pillars.find((p) => p.service_id === service.id);
    const candidateOwner = normalizeUrl(service.page_url);
    const owner = candidateOwner?.startsWith("https://") && hostOf(candidateOwner) === hostOf(input.client.website_url) ? candidateOwner : null;
    const recorded = keywords.find((k) => k.keyword_id === service.primary_keyword_id && active.has(k.keyword_id));
    const mine = keywords.filter((k) => k.service_id === service.id && active.has(k.keyword_id));
    // v1.5: a cluster holds only keywords the site's approved Core 50 grounds.
    const grounding = (k: KeywordAssignment) => groundingProblem(coreVerdict(input, k.keyword_id, service.id, "post"));
    const eligible = (k: KeywordAssignment) => ["primary", "supporting", "material_supported"].includes(k.role) && !k.intent_check.conflict && !grounding(k);
    const cluster = mine.filter(eligible).sort((a, b) => compare(keywordCampaignRank(a), keywordCampaignRank(b)) || a.keyword.localeCompare(b.keyword));
    const ids = new Set(cluster.map((k) => k.keyword_id));
    const text = new Set(cluster.map((k) => norm(k.keyword)));
    // An off-list or otherwise ineligible primary is never advertised.
    const primary = recorded && ids.has(recorded.keyword_id) ? recorded : null;
    const primaryExcluded = recorded && !primary
      ? { keyword: recorded.keyword, reason: grounding(recorded) ?? (recorded.intent_check.conflict ? recorded.intent_check.reason : recorded.role) } : null;
    const blockers: string[] = [];
    const listProblem = groundingProblem(coreVerdict(input, null, service.id, "post"));
    if (listProblem && listProblem !== "keyword_missing") blockers.push(`The site's Core 50 is not usable: ${listProblem}.`);
    if (primaryExcluded) blockers.push(`The service's primary keyword "${primaryExcluded.keyword}" is not usable for this site (${primaryExcluded.reason}).`);
    else if (!primary) blockers.push("An active, validated primary keyword mapped to this service is required.");
    if (!owner || !input.pageGroups.some((g) => g.status === "approved" && normalizeUrl(g.target_url) === owner)) blockers.push("An approved owner page is required.");
    if (pillar?.owner.conflict) blockers.push("Owner-page candidates disagree.");
    if (primary) {
      const equivalent = input.keywords.filter((k) => k.is_active && norm(k.keyword) === norm(primary.keyword));
      const equivalentIds = new Set(equivalent.map((k) => k.id));
      const owners = new Set([
        ...equivalent.map((k) => k.target_url),
        ...input.pageGroups.filter((g) => g.status === "approved" && g.primary_keyword_id && equivalentIds.has(g.primary_keyword_id)).map((g) => g.target_url),
        ...input.services.filter((s) => s.status === "approved" && s.primary_keyword_id && equivalentIds.has(s.primary_keyword_id)).map((s) => s.page_url),
      ].map(normalizeUrl).filter(Boolean));
      if (owners.size > 1) blockers.push("The primary keyword has more than one owner page.");
    }
    // Every keyword-targeted opportunity of the service: the actionable ones
    // plan a channel; the rest say why the channel is blocked.
    const ops = opportunities.filter((o) => o.service_id === service.id && o.target.keyword_id);
    const social = input.authority.socialPosts.filter((p) => p.keyword_id && ids.has(p.keyword_id));
    const content = input.authority.contentPosts.filter((p) => p.keyword_id && ids.has(p.keyword_id));
    const rows = window.rows.filter((r) => r.keyword_id ? ids.has(r.keyword_id) : text.has(norm(r.query)));
    const ranks = new Map<string, typeof input.authority.ranks[number]>();
    for (const r of input.authority.ranks.filter((r) => ids.has(r.keyword_id))) {
      const key = `${r.keyword_id}:${r.result_type}`;
      if (!ranks.has(key) || ranks.get(key)!.recorded_at < r.recorded_at) ranks.set(key, r);
    }
    const objectives: Record<CampaignChannel, string> = {
      website: "Maintain the single owner page for this keyword cluster.",
      blog: "Answer supported questions and reinforce the owner page.",
      google_business: "Reinforce local service demand with a governed Business Profile brief.",
      facebook: "Use natural awareness copy grounded in this cluster and its claims.",
      email: "Plan only with a defined audience, consent and channel brief.",
      ads: "Plan only after intent, economics, landing page and budget review.",
    };
    const channels = (Object.keys(objectives) as CampaignChannel[]).map((channel) => {
      const mineOps = ops.filter((o) => channelOf(o) === channel);
      const planned = mineOps.filter((o) => actionable(o) && ids.has(o.target.keyword_id!));
      const held = mineOps.filter((o) => !planned.includes(o)).map((o) => ({ key: o.key, reason: blockReason(o) }));
      const existing = channel === "blog" ? content.length : channel === "website" ? Number(pillar?.owner.state === "live") : social.filter((p) => p.platform === channel).length;
      const status = blockers.length ? "blocked" : planned.length ? "review_plan" : held.length ? "blocked" : existing ? "existing_content" : "not_planned";
      return { channel, objective: objectives[channel], opportunity_keys: planned.map((o) => o.key), existing,
        status: status as KeywordCampaign["channels"][number]["status"], ...(held.length ? { blocked_by: held } : {}) };
    });
    return {
      schema_version: 1, key: `keyword_campaign:${service.id}`, service_id: service.id, name: service.name,
      primary: primary ? { id: primary.keyword_id, keyword: primary.keyword, intent: primary.intent } : null,
      primary_excluded: primaryExcluded,
      cluster: cluster.map((k) => { const v = coreVerdict(input, k.keyword_id, service.id, "post"); return { id: k.keyword_id, keyword: k.keyword, intent: k.intent, post: v.ok ? null : v.receipt.verdict }; }),
      excluded: mine.filter((k) => !eligible(k)).map((k) => ({ keyword: k.keyword, reason: grounding(k) ?? (k.intent_check.conflict ? k.intent_check.reason : k.role) })),
      intent_mix: [...new Set(cluster.map((k) => k.intent).filter((i): i is string => !!i))].sort(), owner_url: owner,
      objective: `Build supported coverage for ${primary?.keyword ?? service.name} around one owner page.`,
      blockers, evidence_claim_ids: pillar?.evidence.relevant.map((c) => c.id) ?? [],
      priority: primary ? keywordCampaignRank(primary) : [4], channels,
      measurement: { window: window.label, coverage: gscCoverage(window.rows.length),
        impressions: window.label ? rows.reduce((n, r) => n + r.impressions, 0) : null,
        clicks: window.label ? rows.reduce((n, r) => n + r.clicks, 0) : null,
        ranks: [...ranks.values()].map((r) => ({ keyword: keywords.find((k) => k.keyword_id === r.keyword_id)!.keyword, type: r.result_type, position: r.position, recorded_at: r.recorded_at })),
        content_count: social.length + content.length, traffic: null, conversions: null },
    };
  }).sort((a, b) => compare(a.priority, b.priority) || a.key.localeCompare(b.key));
}
