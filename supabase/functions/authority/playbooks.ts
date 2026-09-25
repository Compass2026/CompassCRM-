// Supporting-topic playbooks. The TEMPLATES are heuristic (Compass's view of
// what a roofing client's audience asks about); every judgment about a topic
// for a given client is made from that client's data: its services, usable
// claims, live pages and posts. A template never supplies a fact.
//
// kind:
//   entity       — about a thing a usable claim names (a manufacturer).
//   client_fact  — needs a client-specific fact (their warranty terms, their
//                  process). Missing → insufficient_evidence.
//   educational  — needs general factual information Client Intelligence does
//                  not hold. Missing → research_required (Sept 25 decision:
//                  model knowledge never substitutes for evidence).
//   comparison   — educational, and only meaningful when both services exist.
//   forbidden    — conflicts with a hard rule. → avoid.

export type Template = {
  key: string;
  name: string;
  segment: RegExp;                // which service segments it belongs to
  kind: "entity" | "client_fact" | "educational" | "comparison" | "forbidden";
  claim?: RegExp;                 // a usable claim that supports it
  blog?: RegExp;                  // blog titles / slugs that already cover it
  services?: RegExp[];            // approved services it needs (comparison)
  angle: string;                  // heuristic: why it could matter
  rule?: string;                  // forbidden: the rule it breaks
};

export const MANUFACTURERS = /\b(owens corning|gaf|certainteed|malarkey|tamko|iko|atlas|james hardie)\b/i;

export const TEMPLATES: Template[] = [
  { key: "manufacturer", name: "Manufacturer credential and product line", segment: /roof/i, kind: "entity", claim: MANUFACTURERS,
    angle: "Name the manufacturer relationship and product line the client is documented to use." },
  { key: "warranty_terms", name: "What the workmanship warranty covers", segment: /roof/i, kind: "client_fact", claim: /warrant.*(cover|term|year|transfer)/i,
    angle: "Explain the warranty's actual terms, only once the terms are recorded." },
  { key: "process", name: "The client's replacement process / what to expect", segment: /roof/i, kind: "client_fact", claim: /\b(process|step|inspection|timeline|clean[- ]?up)\b/i,
    angle: "Describe how the client works, only once the client confirms it." },
  { key: "choosing_contractor", name: "Choosing a roofing contractor", segment: /roof/i, kind: "educational",
    blog: /\b(choos\w*|hiring|pick\w*)\b.*\b(roofer|contractor|company)\b|\bscams?\b|apart from|out-of-town/i,
    angle: "Help homeowners compare contractors on verifiable criteria." },
  { key: "signs_replacement", name: "Signs a roof may need replacement", segment: /roof/i, kind: "educational",
    blog: /\bsigns?\b|when to replace/i,
    angle: "Consideration content for homeowners with an ageing roof; never diagnostic." },
  { key: "repair_vs_replacement", name: "Roof repair vs replacement", segment: /roof/i, kind: "comparison",
    services: [/repair/i, /replace/i], blog: /repair.*replace|replace.*repair/i,
    angle: "Help a homeowner understand the two options; the decision stays with an inspection." },
  { key: "storm_hail", name: "Storm and hail damage, insurance claims", segment: /roof/i, kind: "educational",
    claim: /storm|hail|insurance/i, blog: /storm|hail|insurance/i,
    angle: "Storm-season guidance; the client's claims-assistance claim may be cited, general hail facts may not." },
  { key: "materials", name: "Choosing roofing materials", segment: /roof/i, kind: "educational", blog: /material/i,
    angle: "Material comparisons; only materials a usable claim names may be presented as offered." },
  { key: "maintenance", name: "Roof maintenance", segment: /roof/i, kind: "educational", blog: /maintenance/i,
    angle: "Seasonal upkeep guidance." },
  { key: "cost", name: "Roof replacement cost", segment: /roof/i, kind: "forbidden", blog: /cost|price/i,
    angle: "Cost content.", rule: "Hard rule: never quote or imply pricing." },
];
