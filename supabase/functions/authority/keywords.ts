// Keyword ownership and intent classification. Each keyword gets one role
// (the most restrictive that applies) plus every flag that applies, each with
// a tagged reason. Risk words are judged by the drafter's own detectors, so a
// keyword the writer could never honestly use is never recommended. Pure.
import { DETECTORS, MATERIAL_RE } from "../post-drafter/rules.ts";
import type { AuthorityInput, ClaimRef, KeywordAssignment, KeywordRole, Reason } from "./types.ts";
import { normPath, placesIn, type PlaceIndex } from "./urls.ts";

const RISK: Record<string, string> = {
  superlative: "an unprovable superlative",
  pricing: "pricing or cost",
  credential: "a credential no claim states",
  review: "reviews or ratings (not cited in v1)",
  response: "a response-time promise",
  tenure: "tenure or a year",
};

export type KeywordContext = {
  ownerPathByService: Map<string, string | null>;
  cityPrefix: string;
  places: PlaceIndex;
  citable: ClaimRef[];
  unconfirmed: UnconfirmedPage[];   // live service-like pages no approved service owns
  clientName: string;
};

// A live service page no approved service owns. tokens = its slug words no
// approved service uses ("commercial"); context = the rest ("roofing"). A
// text is about it when it names a token AND (if any) a context word, so
// "commercial christmas lights" is not about /services/commercial-roofing.
export type UnconfirmedPage = { path: string; tokens: string[]; context: string[] };
export function aboutUnconfirmed(text: string, u: UnconfirmedPage): boolean {
  const has = (w: string) => new RegExp(`\\b${w.slice(0, 4)}`, "i").test(text);
  return u.tokens.some(has) && (!u.context.length || u.context.some(has));
}

const ORDER: KeywordRole[] = [
  "requires_confirmation", "avoid_risky", "location_unapproved", "material_unsupported",
  "homepage_pollution", "mis_targeted", "material_supported", "primary", "supporting",
];

export function riskCategories(text: string, clientName: string): string[] {
  const hay = text.toLowerCase().split(clientName.toLowerCase()).join(" ");
  const out: string[] = [];
  for (const d of DETECTORS) {
    if (!RISK[d.category]) continue;
    d.re.lastIndex = 0;
    if (d.re.test(hay)) out.push(d.category);
  }
  return out;
}

export function materialsIn(text: string): string[] {
  MATERIAL_RE.lastIndex = 0;
  return [...new Set([...text.matchAll(MATERIAL_RE)].map((m) => m[0].toLowerCase()))];
}

export function materialSupported(material: string, citable: ClaimRef[]): boolean {
  const m = material.replace(/s$/, "");
  return citable.some((c) => c.text.toLowerCase().includes(m));
}

export function classifyKeywords(input: AuthorityInput, ctx: KeywordContext): KeywordAssignment[] {
  const site = input.authority.site?.url ?? input.client.website_url;
  const extras = new Map(input.authority.keywordExtras.map((e) => [e.id, e]));
  const money = new Set(input.authority.moneyKeywordIds);
  const primaryIds = new Set(input.services.map((s) => s.primary_keyword_id).filter(Boolean));
  return input.keywords.map((k) => {
    const flags = new Set<KeywordRole>();
    const reasons: Reason[] = [];
    const target = normPath(k.target_url, site);
    const owner = k.service_id ? ctx.ownerPathByService.get(k.service_id) ?? null : null;
    const text = k.keyword;

    if (!k.service_id) {
      reasons.push({ tag: "FACT", text: "Not mapped to any service." });
    }
    for (const u of ctx.unconfirmed) {
      const hit = (target && target === u.path) || aboutUnconfirmed(text, u);
      if (hit) {
        flags.add("requires_confirmation");
        reasons.push({ tag: "REQUIRES_CONFIRMATION", text: `Points at ${u.path}, a live page no approved service owns; a person must confirm the service first.` });
      }
    }
    const risks = riskCategories(text, ctx.clientName);
    if (risks.length) {
      flags.add("avoid_risky");
      reasons.push({ tag: "FACT", text: `Contains ${risks.map((r) => RISK[r]).join(" and ")}; the writer cannot honour it.` });
    }
    const unapproved = placesIn(text, ctx.places).filter((p) => !p.approved);
    const isCityTarget = !!target && target.startsWith(ctx.cityPrefix);
    if (unapproved.length) {
      flags.add("location_unapproved");
      reasons.push({ tag: "FACT", text: `Names ${unapproved.map((p) => p.name).join(", ")}, not an approved location.` });
    }
    for (const m of materialsIn(text)) {
      if (materialSupported(m, ctx.citable)) {
        flags.add("material_supported");
        reasons.push({ tag: "FACT", text: `Names "${m}", which a usable claim names.` });
      } else {
        flags.add("material_unsupported");
        reasons.push({ tag: "FACT", text: `Names "${m}", which no usable claim names.` });
      }
    }
    if (k.service_id && target === "/" && owner && owner !== "/") {
      flags.add("homepage_pollution");
      reasons.push({ tag: "FACT", text: `Mapped to this service but targets the home page, not ${owner}.` });
    } else if (k.service_id && target && owner && target !== owner && target !== "/" && !isCityTarget) {
      flags.add("mis_targeted");
      reasons.push({ tag: "FACT", text: `Targets ${target}, not the service's owner page ${owner}.` });
    }

    let role: KeywordRole = !k.service_id ? "unmapped" : primaryIds.has(k.id) ? "primary" : "supporting";
    for (const r of ORDER) if (flags.has(r)) { role = r; break; }
    if (!k.service_id && role !== "requires_confirmation") role = "unmapped";
    if (!reasons.length) reasons.push({ tag: "FACT", text: role === "primary" ? "The service's primary keyword, targeting its owner page." : "Supports the service and targets its owner page." });

    const ex = extras.get(k.id);
    return {
      keyword_id: k.id, keyword: text, service_id: k.service_id, intent: k.intent, money: money.has(k.id) || k.is_money,
      priority: k.priority, volume: ex?.volume ?? null, target_path: target, role, flags: [...flags], reasons,
    };
  });
}
