// Readers for the two JSON reports the Foundation worker leaves on a site
// row: `sites.quality` (the quality gate run on the build, written at Build
// to 70%) and `sites.audit` (the SEO › Audit & Adjust report on the client's
// live site). Both are written by a skill, not by typed code, so every field
// is read defensively and the UI renders whatever is present.

import type { Json } from "@/lib/database.types";

export type GateScores = { seo: number; aeo: number; geo: number };

export type SiteQuality = {
  pass: boolean | null;
  score: GateScores | null;
  pages: number | null;
  placeholders: number | null;
  failures: number;
  warnings: number;
  checkedAt: string | null;
};

export type SiteAudit = {
  target: string | null;
  gate: GateScores | null;
  gatePass: boolean | null;
  pages: number | null;
  pageGroups: { total: number; served: number; missing: number } | null;
  findings: { high: number; medium: number; low: number } | null;
  backlinks: { referringDomains: number | null; backlinks: number | null; spamScore: number | null } | null;
  gbp: {
    found: boolean | null;
    claimed: boolean | null;
    rating: number | null;
    reviews: number | null;
    napMismatches: number | null;
  } | null;
  lighthouse: Record<string, Record<string, number>> | null;
  reportUrl: string | null;
};

type Obj = Record<string, Json | undefined>;

function obj(v: Json | null | undefined): Obj | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : null;
}

function num(v: Json | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(v: Json | undefined): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function str(v: Json | undefined): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

function len(v: Json | undefined): number {
  return Array.isArray(v) ? v.length : 0;
}

function scores(v: Json | undefined): GateScores | null {
  const o = obj(v);
  if (!o) return null;
  const seo = num(o.seo);
  const aeo = num(o.aeo);
  const geo = num(o.geo);
  return seo == null || aeo == null || geo == null ? null : { seo, aeo, geo };
}

export function parseQuality(value: Json | null | undefined): SiteQuality | null {
  const o = obj(value);
  if (!o) return null;
  return {
    pass: bool(o.pass),
    score: scores(o.score),
    pages: num(o.pages),
    placeholders: num(o.placeholders),
    failures: len(o.failures),
    warnings: len(o.warnings),
    checkedAt: str(o.checkedAt),
  };
}

export function parseAudit(value: Json | null | undefined): SiteAudit | null {
  const o = obj(value);
  if (!o) return null;
  const gate = obj(o.gate);
  const groups = obj(o.page_groups);
  const findings = obj(o.findings);
  const backlinks = obj(o.backlinks);
  const gbp = obj(o.gbp);
  const lighthouseRaw = obj(o.lighthouse);
  let lighthouse: SiteAudit["lighthouse"] = null;
  if (lighthouseRaw) {
    lighthouse = {};
    for (const [page, v] of Object.entries(lighthouseRaw)) {
      const inner = obj(v);
      if (!inner) continue;
      const row: Record<string, number> = {};
      for (const [k, n] of Object.entries(inner)) {
        const x = num(n);
        if (x != null) row[k] = x;
      }
      lighthouse[page] = row;
    }
  }
  return {
    target: str(o.target),
    gate: gate ? scores(gate.score) : null,
    gatePass: gate ? bool(gate.pass) : null,
    pages: num(o.pages),
    pageGroups: groups
      ? {
          total: num(groups.total) ?? 0,
          served: num(groups.served) ?? 0,
          missing: num(groups.missing) ?? 0,
        }
      : null,
    findings: findings
      ? {
          high: num(findings.high) ?? 0,
          medium: num(findings.medium) ?? 0,
          low: num(findings.low) ?? 0,
        }
      : null,
    backlinks: backlinks
      ? {
          referringDomains: num(backlinks.referring_domains),
          backlinks: num(backlinks.backlinks),
          spamScore: num(backlinks.spam_score),
        }
      : null,
    gbp: gbp
      ? {
          found: bool(gbp.found),
          claimed: bool(gbp.claimed),
          rating: num(gbp.rating),
          reviews: num(gbp.reviews),
          napMismatches: num(gbp.nap_mismatches),
        }
      : null,
    lighthouse,
    reportUrl: str(o.report_url),
  };
}

// A score is green from 90, amber from 70, red below.
export function scoreTone(n: number): string {
  if (n >= 90) return "bg-green-100 text-green-800 border-green-200";
  if (n >= 70) return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-red-100 text-red-800 border-red-200";
}

export function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
