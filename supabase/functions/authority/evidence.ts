// Evidence availability: which claims a topic may stand on. The same rules
// as the drafter (usable = sourced with a source, or confirmed; reviews,
// addresses, the phone and unconfirmed tenure are never cited in v1), so
// Authority never promises evidence the writer will then refuse. Pure.
import { usableClaims } from "../../../src/lib/client-intelligence.ts";
import { claimCategories } from "../post-drafter/rules.ts";
import type { AuthorityInput, ClaimRef, Evidence } from "./types.ts";
import { normPath } from "./urls.ts";

const EXCLUDED: Record<string, string> = {
  review: "Reviews and ratings are not cited in v1.",
  address: "A street address is never stated.",
  phone: "The phone is a CRM fact, not a claim.",
};

export function citableClaims(input: AuthorityInput): { citable: ClaimRef[]; excluded: Evidence["excluded"] } {
  const usable = new Set(usableClaims(input.claims).map((c) => c.id));
  const citable: ClaimRef[] = [];
  const excluded: Evidence["excluded"] = [];
  for (const c of input.claims) {
    if (!usable.has(c.id)) { excluded.push({ id: c.id, text: c.claim, reason: `${c.status}: never cited.` }); continue; }
    const cats = claimCategories(c.claim);
    const hit = cats.find((k) => EXCLUDED[k]);
    if (hit) { excluded.push({ id: c.id, text: c.claim, reason: EXCLUDED[hit] }); continue; }
    if (cats.includes("tenure") && c.status !== "confirmed") {
      excluded.push({ id: c.id, text: c.claim, reason: "States a year or tenure; cited only once the client confirms it." });
      continue;
    }
    citable.push({ id: c.id, text: c.claim });
  }
  return { citable, excluded };
}

// Generic service words say nothing about which service a claim is about.
const GENERIC = new Set(["insta", "repai", "repla", "servi", "contr", "compa", "speci"]);
export const distinctStems = (s: string) => (s.toLowerCase().match(/[a-z]{5,}/g) ?? []).map((w) => w.slice(0, 5)).filter((w) => !GENERIC.has(w));
const stems = distinctStems;

// Relevant = sourced from the owner page, or shares a distinctive word stem
// (5+ letters) with the service, or its source is about the service's segment.
export function evidenceFor(input: AuthorityInput, serviceName: string, segment: string | null, ownerPath: string | null): Evidence {
  const { citable, excluded } = citableClaims(input);
  const site = input.authority.site?.url ?? input.client.website_url;
  const want = new Set(stems(serviceName));
  const seg = (segment ?? "").toLowerCase();
  const relevant = citable.filter((c) => {
    const claim = input.claims.find((x) => x.id === c.id)!;
    const src = claim.source ?? "";
    if (ownerPath && normPath(src, site) === ownerPath) return true;
    if (stems(c.text).some((s) => want.has(s))) return true;
    return seg.length >= 4 && src.toLowerCase().includes(seg);
  });
  return { usable: citable, relevant, excluded };
}
