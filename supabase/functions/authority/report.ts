// Markdown rendering of an AuthorityReport. Every statement keeps its tag:
// [FACT], [HEURISTIC], [RESEARCH REQUIRED], [REQUIRES CONFIRMATION]. Pure.
import type { AuthorityReport, Opportunity, Reason, Tag } from "./types.ts";

const LABEL: Record<Tag, string> = {
  FACT: "[FACT]", HEURISTIC: "[HEURISTIC]", RESEARCH_REQUIRED: "[RESEARCH REQUIRED]", REQUIRES_CONFIRMATION: "[REQUIRES CONFIRMATION]",
};
const r = (x: Reason) => `${LABEL[x.tag]} ${x.text}`;
const bullets = (xs: Reason[], indent = "") => xs.map((x) => `${indent}- ${r(x)}`).join("\n");
const cell = (s: string | number | null | undefined) => String(s ?? "–").replace(/\|/g, "\\|").replace(/\n/g, " ");

function opportunity(o: Opportunity, n: number): string {
  const lines = [
    `### ${n}. ${o.topic} — \`${o.action}\` ${o.content_type} (tier ${o.tier})`,
    `- id: \`${o.id}\``,
    `- gap: ${o.gap}`,
  ];
  const t = o.target;
  const tgt = [t.keyword && `keyword "${t.keyword}"`, t.intent && `intent ${t.intent}`, t.owner_path && `owner ${t.owner_path}`, t.cta && `CTA ${t.cta}`, t.location && `location ${t.location}`].filter(Boolean);
  if (tgt.length) lines.push(`- target: ${tgt.join(", ")}`);
  if (o.evidence_claim_ids.length) lines.push(`- evidence: ${o.evidence_claim_ids.length} claim(s) (${o.evidence_claim_ids.map((i) => i.slice(0, 8)).join(", ")})`);
  if (o.existing_coverage.length) lines.push(`- existing coverage: ${o.existing_coverage.map((c) => `${c.kind} ${c.ref} (${c.state})`).join("; ")}`);
  lines.push(`- gates: ${o.gates.map((g) => `${g.pass ? "✓" : "✗"} ${g.gate} (${g.detail})`).join("; ")}`);
  if (o.eligible_from) lines.push(`- eligible from: ${o.eligible_from}`);
  if (o.blockers.length) lines.push(`- blockers: ${o.blockers.join(" ")}`);
  lines.push("- reasons:", bullets(o.reasons, "  "));
  return lines.join("\n");
}

export function renderMarkdown(rep: AuthorityReport): string {
  const out: string[] = [];
  out.push(`# Authority map — ${rep.client.name}`, "",
    `${rep.version} · as of ${rep.as_of} · judged at ${rep.generated_at} · inventory ${rep.inventory.fetched_at ?? "none"} (${rep.inventory.live} live of ${rep.inventory.pages} checked: ${Object.entries(rep.inventory.by_kind).map(([k, v]) => `${k} ${v}`).join(", ")})`, "",
    "Tags: [FACT] read from the CRM or the live site · [HEURISTIC] a Compass rule of thumb · [RESEARCH REQUIRED] needs facts Client Intelligence does not hold · [REQUIRES CONFIRMATION] a person must decide.", "");

  out.push("## Pillars and owner pages", "",
    "| Pillar | Owner page | State | Keywords | Relevant evidence | GSC (latest window) | Rank |",
    "| --- | --- | --- | --- | --- | --- | --- |");
  for (const p of rep.pillars) {
    const rk = p.gsc.rank;
    out.push(`| ${cell(p.name)} | ${cell(p.owner.path)} | ${p.owner.state}${p.owner.conflict ? " (conflict)" : ""} | ${p.keywords.total} (${Object.entries(p.keywords.by_role).map(([k, v]) => `${k} ${v}`).join(", ")}) | ${p.evidence.relevant.length} | ${p.gsc.impressions} impr, ${p.gsc.owner_impressions} on owner | ${rk ? `${cell(rk.keyword)}: organic ${rk.organic ?? "–"}, map ${rk.map_pack ?? "–"} → ${rk.url_path ?? "–"}` : "–"} |`);
  }
  out.push("");
  for (const p of rep.pillars) {
    out.push(`### ${p.name}`, bullets(p.owner.reasons));
    if (p.evidence.relevant.length) out.push(`- [FACT] Evidence: ${p.evidence.relevant.map((c) => `"${c.text}"`).join("; ")}.`);
    else out.push("- [FACT] No usable claim is relevant to this service.");
    if (p.page_issues.length) out.push(bullets(p.page_issues));
    if (p.coverage.length) out.push(`- [FACT] Existing coverage: ${p.coverage.map((c) => `${c.kind} ${c.ref} (${c.state})`).join("; ")}.`);
    if (p.gsc.landing_pages.length) out.push(`- [FACT] GSC ${p.gsc.window}: ${p.gsc.landing_pages.map((l) => `${l.path} ${l.impressions}`).join(", ")}.`);
    out.push("");
  }

  out.push("## Keyword clusters", "");
  const roles = [...new Set(rep.keywords.map((k) => k.role))];
  for (const role of roles) {
    const ks = rep.keywords.filter((k) => k.role === role);
    out.push(`- **${role}** (${ks.length}): ${ks.slice(0, 15).map((k) => k.keyword).join(", ")}${ks.length > 15 ? "…" : ""}`);
  }
  out.push("");

  out.push("## Intent sanity", "", "Stored intent is a [FACT]; the assessment is [HEURISTIC] and never written back.", "",
    "| Keyword | Stored | Assessed | Conflict | Reason |", "| --- | --- | --- | --- | --- |");
  for (const k of rep.keywords.filter((k) => k.intent_check.conflict || k.intent_check.assessed === "ambiguous")) {
    out.push(`| ${cell(k.keyword)} | ${cell(k.intent_check.stored)} | ${k.intent_check.assessed} | ${k.intent_check.conflict ? "**yes**" : "no (judgment)"} | ${cell(k.intent_check.reason)} |`);
  }
  out.push("");

  out.push("## Supporting topics", "");
  for (const s of rep.supporting) out.push(`- **${s.name}** → \`${s.action}\``, bullets(s.reasons, "  "));
  out.push("");

  out.push("## Conflicts and blockers", "");
  for (const c of rep.conflicts) out.push(`- **${c.kind}** — ${c.subject}`, bullets(c.reasons, "  "));
  out.push("");

  const ranked = rep.opportunities.filter((o) => o.tier !== "none");
  const held = rep.opportunities.filter((o) => o.tier === "none");
  out.push("## Ranked opportunities", "");
  ranked.forEach((o, i) => out.push(opportunity(o, i + 1), ""));
  out.push("## Blocked, research-required and needs-confirmation", "",
    "`insufficient_evidence` = missing client facts · `research_required` = general research · `requires_confirmation` = a human business decision · `blocked_data_prerequisite` = CRM data to reconcile first.", "");
  held.forEach((o, i) => out.push(opportunity(o, i + 1), ""));

  out.push("## Rules that still need human judgment", "", ...rep.judgments.map((j) => `- ${j}`), "");
  return out.join("\n");
}
