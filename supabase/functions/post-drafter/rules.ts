// Deterministic detectors shared by the brief builder (to sort claims into
// what a draft may cite) and the linter (to judge copy). One list, so the
// two can never disagree about what counts as a price, a tenure claim or a
// credential. Pure; no model or vendor logic.

export const PHONE_RE = /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;

// Categories of factual assertion the hard rules govern.
export const DETECTORS: { category: string; label: string; re: RegExp }[] = [
  { category: "review", label: "a review count, rating or testimonial", re: /\breviews?\b|\bstars?\b|\bfive[- ]star\b|\brated\b|\bratings?\b|\btestimonials?\b|\b\d(?:\.\d)?\s*\/\s*5\b/gi },
  {
    category: "address",
    label: "a street address",
    re: /\b\d{1,6}\s+(?:[A-Z][A-Za-z.]*\s+){1,4}(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Parkway|Pkwy|Highway|Hwy|Lane|Ln|Way|Court|Ct|Place|Pl)\b\.?|\bsuite\s+\d+|\bP\.?\s?O\.?\s+Box\b|\b\d{5}(?:-\d{4})?\b|\baddress\b/gi,
  },
  {
    category: "pricing",
    label: "pricing, a discount or a free offer",
    re: /\$\s?\d|\bfree\b|\bdiscounts?\b|\b\d+\s?%|\bpercent\b|\bprices?\b|\bpriced\b|\bpricing\b|\bcosts?\b|\bafford\w*|\bcheap\w*|\bsavings?\b|\bsave\b|\bdeals?\b|\bfinancing\b|\bno[- ]obligation\b/gi,
  },
  {
    category: "tenure",
    label: "a founding year, tenure or ownership claim",
    re: /\b(?:19|20)\d{2}\b|\bsince\b|\bestablished\b|\bfounded\b|\b\d+\+?\s*(?:years?|yrs|decades?)\b|\bdecades?\b|\bgenerations?\b|\bfamily[- ](?:owned|operated|run)\b|\bowner[- ]operated\b|\blocally[- ]owned\b|\bveteran[- ]owned\b/gi,
  },
  {
    category: "response",
    label: "a response-time or availability promise",
    re: /\b24\s?\/\s?7\b|\b24 hours\b|\bsame[- ](?:day|week)\b|\bnext[- ](?:day|week)\b|\bthis week\b|\bby tomorrow\b|\bwithin\s+\d+\b|\b\d+\s*(?:hours?|hrs|days?|minutes?|mins)\b|\bemergency\b|\bround[- ]the[- ]clock\b|\bon[- ]site\b|\bquick(?:ly)? respon\w*|\bfast(?:est)? respon\w*|\bimmediate(?:ly)?\b|\bright away\b/gi,
  },
  {
    category: "credential",
    label: "a credential, warranty or guarantee",
    re: /\bwarrant(?:y|ies|ied)\b|\bguarantee[ds]?\b|\blifetime\b|\bcertifi(?:ed|cation|cations)\b|\blicensed\b|\binsured\b|\bbonded\b|\baccredit(?:ed|ation)\b|\bpreferred\b|\bawards?\b|\baward[- ]winning\b|\bowens corning\b|\bGAF\b|\bcertainteed\b|\bmaster elite\b|\bBBB\b|\bA\+|\bexperts?\b|\bspeciali[sz]\w*/gi,
  },
  {
    category: "superlative",
    label: "an unprovable superlative",
    re: /\bbest\b|#\s?1\b|\bnumber one\b|\btop[- ]rated\b|\bleading\b|\bpremier\b|\bunmatched\b|\bunbeatable\b|\bunrivall?ed\b|\bmost trusted\b/gi,
  },
];

// Materials: stating one needs a linked claim that names it. Includes the
// materials the hard rules name as unverified (cedar shake, slate).
export const MATERIAL_RE =
  /\bcedar\b|\bshakes?\b|\bslate\b|\bmetal roof\w*|\bstanding seam\b|\btile roof\w*|\bclay tiles?\b|\bcopper\b|\bsynthetic\b|\bcomposite\b|\basphalt\b|\bshingles?\b|\barchitectural\b|\bduration\b|\bTPO\b|\bEPDM\b|\bfiber[- ]cement\b|\bhardie\w*|\bvinyl\b|\baluminum\b|\bsteel\b/gi;

export const NUMBER_RE = /\d/g;

// Which categories a claim's own text falls into.
export function claimCategories(text: string): string[] {
  const out = new Set<string>();
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    if (d.re.test(text)) out.add(d.category);
  }
  PHONE_RE.lastIndex = 0;
  if (PHONE_RE.test(text) || /\bphone\b/i.test(text)) out.add("phone");
  return [...out];
}

export function digits(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");
}

export function normalizeUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.hostname.replace(/^www\./, "").toLowerCase()}${x.pathname.replace(/\/+$/, "") || ""}`;
  } catch {
    return null;
  }
}

export function hostOf(u: string | null | undefined): string {
  try {
    return new URL(u ?? "").hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Case-insensitive spans of `needle` in `hay`.
export function spansOf(hay: string, needle: string): [number, number][] {
  const out: [number, number][] = [];
  if (!needle.trim()) return out;
  const re = new RegExp(escapeRe(needle.trim()), "gi");
  for (const m of hay.matchAll(re)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

export function mask(text: string, spans: [number, number][]): string {
  const chars = [...text];
  for (const [a, b] of spans) for (let i = a; i < b && i < chars.length; i++) chars[i] = " ";
  return chars.join("");
}

// Lowercase words, for n-gram comparisons.
export function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/).filter(Boolean);
}

export function ngrams(ws: string[], n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i + n <= ws.length; i++) out.push(ws.slice(i, i + n).join(" "));
  return out;
}

// Stable JSON (sorted keys) for hashing.
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}
