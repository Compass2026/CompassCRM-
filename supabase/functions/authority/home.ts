// Home ownership (C3): which keywords the approved Home page group may govern.
// A broad category or company query ("roofer near me", "roofing company in
// Wentzville", "Lucas Construction roofing reviews") belongs to the home page;
// a query naming a service, a service activity or a material belongs to that
// service, always. Anything in between is surfaced for a person, never
// silently given to Home. Deterministic and pure: every word of the query is
// accounted for from governed data (the Home page group's primary keyword,
// the approved services, locations and page groups, the client's name) and a
// fixed vocabulary; a word the rules do not know makes the query ambiguous.
import { materialsIn, aboutUnconfirmed, type UnconfirmedPage } from "./keywords.ts";
import type { AuthorityInput, HomeSummary as ReportHome, PageGroupRow, Reason } from "./types.ts";
import { normPath, normPlace, type Inventory, type PlaceIndex } from "./urls.ts";

export type HomeFit = "home" | "service" | "ambiguous" | "none";
export type HomeCheck = { fit: HomeFit; eligible: boolean; reason: string };
export type HomeSummary = Omit<ReportHome, "eligible" | "ambiguous" | "owned">;

// Company and qualifier words a category query may carry without being about
// a particular service. Quality words (best, affordable, licensed…) are here
// for ownership only; the risk rules still keep them out of content.
const FILLER = new Set([
  "company", "companies", "contractor", "contractors", "services", "service", "business", "local", "residential",
  "trusted", "best", "top", "rated", "affordable", "licensed", "professional", "review", "reviews",
  "near", "me", "in", "the", "a", "of", "and",
]);
// Service activities: a query naming one is about that service, whatever else it says.
const ACTIVITY = /\b(repair\w*|replac\w*|install\w*|inspect\w*|restor\w*|mainten\w*|clean\w*|remov\w*|damage\w*|storm\w*|hail|wind|leak\w*|emergenc\w*|insurance|claims?)\b/i;
const STATE_NAMES: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut", de: "delaware",
  fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa", ks: "kansas", ky: "kentucky",
  la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan", mn: "minnesota", ms: "mississippi", mo: "missouri",
  mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire", nj: "new jersey", nm: "new mexico", ny: "new york",
  nc: "north carolina", nd: "north dakota", oh: "ohio", ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhode island",
  sc: "south carolina", sd: "south dakota", tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington",
  wv: "west virginia", wi: "wisconsin", wy: "wyoming",
};

// "roofer", "roofers", "roofing" → "roof"; "plumbing" → "plumb".
export function root(word: string): string {
  const w = word.toLowerCase();
  for (const suf of ["ers", "er", "ing", "s"]) if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length);
  return w;
}
const words = (s: string) => s.toLowerCase().replace(/['’]/g, "").split(/[^a-z0-9]+/).filter(Boolean);
const sameWord = (a: string, b: string) => root(a) === root(b) || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));

export type HomeContext = {
  summary: HomeSummary;
  group: PageGroupRow | null;
  category: Set<string>;               // roots
  brandWords: string[];                // every word of the client's name
  distinctiveBrand: string[];          // the words that make a query a brand query
  homeCity: string | null;             // normPlace'd
  stateWords: string[];                // the client's state: its code and its name
  serviceWords: string[];              // service-specific words of approved services
  categoryServices: string[];          // approved services named only in category words
  otherClaims: Map<string, string[]>;  // keyword id → approved city / hub / other groups listing it
  places: PlaceIndex;
  unconfirmed: UnconfirmedPage[];
};

export function homeContext(input: AuthorityInput, inv: Inventory, places: PlaceIndex, unconfirmed: UnconfirmedPage[]): HomeContext {
  const site = input.authority.site?.url ?? input.client.website_url;
  const groups = input.authority.pageGroupsFull.filter((g) => g.status === "approved");
  const homes = groups.filter((g) => g.page_type === "home");
  const reasons: Reason[] = [];
  const group = homes.length === 1 ? homes[0] : null;
  const path = group ? normPath(group.target_url, site) : null;
  const state = path ? inv.resolve(path).state : "none";
  if (!homes.length) reasons.push({ tag: "FACT", text: "No approved Home page group; brand and general queries cannot be re-homed." });
  else if (homes.length > 1) reasons.push({ tag: "FACT", text: `${homes.length} approved Home page groups (${homes.map((h) => h.name).join(", ")}); a person must keep one.` });
  else if (path !== "/") reasons.push({ tag: "FACT", text: `The Home page group targets ${path ?? "nothing"}, not the home page.` });
  else if (state !== "live") reasons.push({ tag: "FACT", text: `The home page is ${state.replace("_", " ")} in the latest site snapshot.` });
  const valid = !!group && path === "/" && state === "live";

  const code = (input.client.state ?? "").trim().toLowerCase();
  const stateWords = code ? [code, ...words(STATE_NAMES[code] ?? "")] : [];
  const brandWords = words(input.client.name);
  const distinctiveBrand = brandWords.filter((w) => w.length >= 4 && !["construction", "roofing", "company", "services"].includes(w));
  const kwText = new Map(input.keywords.map((k) => [k.id, k.keyword]));
  const primary = group?.primary_keyword_id ? kwText.get(group.primary_keyword_id) ?? null : null;
  const category = new Set<string>();
  if (primary) {
    for (const w of words(stripPlaces(primary, places))) {
      if (FILLER.has(w) || stateWords.includes(w) || brandWords.includes(w)) continue;
      category.add(root(w));
    }
  }
  if (group && !primary) reasons.push({ tag: "FACT", text: "The Home page group has no primary keyword, so only brand queries can be recognised as Home's." });

  const approved = input.services.filter((s) => s.status === "approved");
  const serviceWords = new Set<string>();
  const categoryServices: string[] = [];
  for (const s of approved) {
    const own = words(s.name).filter((w) => w.length >= 4 && !FILLER.has(w) && !category.has(root(w)));
    own.forEach((w) => serviceWords.add(w));
    if (!own.length) categoryServices.push(s.name);
  }

  const otherClaims = new Map<string, string[]>();
  for (const g of groups) {
    if (!["city", "hub", "other"].includes(g.page_type)) continue;
    for (const id of [g.primary_keyword_id, ...(g.supporting_keyword_ids ?? [])]) {
      if (!id) continue;
      otherClaims.set(id, [...(otherClaims.get(id) ?? []), `${g.name} (${g.page_type} page${normPath(g.target_url, site) ? ` ${normPath(g.target_url, site)}` : ""})`]);
    }
  }

  return {
    summary: { page_group_id: group?.id ?? null, name: group?.name ?? null, path, state, valid, category: [...category].sort(), reasons },
    group, category, brandWords, distinctiveBrand,
    homeCity: input.client.city ? normPlace(input.client.city) : null, stateWords,
    serviceWords: [...serviceWords].sort(), categoryServices, otherClaims, places, unconfirmed,
  };
}

function stripPlaces(text: string, places: PlaceIndex): string {
  let hay = normPlace(text);
  for (const p of places.names) if (hay.includes(p.norm)) hay = hay.split(p.norm).join(" ");
  return hay;
}

// The Home group lists it, or it is mapped to a service yet targets "/".
export function isHomeCandidate(k: { id: string; service_id: string | null }, target: string | null, ctx: HomeContext): boolean {
  const g = ctx.group;
  if (g && (g.primary_keyword_id === k.id || (g.supporting_keyword_ids ?? []).includes(k.id))) return true;
  return !!k.service_id && target === "/";
}

export function homeFit(k: { id: string; keyword: string }, ctx: HomeContext): { fit: HomeFit; reason: string } {
  const text = k.keyword;
  const tokens = words(text);
  // Without a category (no Home primary keyword) only a brand query can be Home's.
  if (!ctx.category.size && !ctx.distinctiveBrand.some((w) => tokens.includes(w))) {
    return { fit: "none", reason: "The Home page group has no primary keyword to take a category from, and this is not a brand query." };
  }
  // Service ownership wins: a service word, an activity, a material or an unconfirmed service's words.
  const svc = tokens.find((t) => ctx.serviceWords.some((w) => sameWord(t, w)));
  if (svc) return { fit: "service", reason: `Names "${svc}", a word of an approved service: the service owns it.` };
  const act = text.match(ACTIVITY);
  if (act) return { fit: "service", reason: `Names a service activity ("${act[0].toLowerCase()}"): a service owns it.` };
  const mats = materialsIn(text);
  if (mats.length) return { fit: "service", reason: `Names a material ("${mats[0]}"): a service owns it.` };
  const u = ctx.unconfirmed.find((x) => aboutUnconfirmed(text, x));
  if (u) return { fit: "service", reason: `About ${u.path}, a live service page no approved service owns yet.` };

  // Every remaining word must be the brand, a place, the category or filler.
  const found: { norm: string; approved: boolean }[] = [];
  let hay = normPlace(text);
  for (const p of ctx.places.names) {
    if (hay.includes(p.norm)) { found.push({ norm: p.norm, approved: ctx.places.approved.has(p.norm) }); hay = hay.split(p.norm).join(" "); }
  }
  const rest = words(hay);
  const brand = ctx.distinctiveBrand.some((w) => rest.includes(w));
  const category = rest.some((w) => ctx.category.has(root(w)));
  const unknown = rest.filter((w) => !FILLER.has(w) && !ctx.stateWords.includes(w) && !ctx.brandWords.includes(w) && !ctx.category.has(root(w)));
  if (!brand && !category) return { fit: "none", reason: "Names neither the business nor its category: not a Home query." };
  if (unknown.length) return { fit: "ambiguous", reason: `A general query, but "${unknown.join(" ")}" is not a word the rules place; a person decides.` };
  if (ctx.categoryServices.length && !brand) {
    return { fit: "ambiguous", reason: `A general category query, and the approved service ${ctx.categoryServices.join(", ")} is named for the category itself; a person decides.` };
  }
  const unapproved = found.filter((p) => !p.approved);
  if (unapproved.length) return { fit: "ambiguous", reason: `Names ${unapproved.map((p) => p.norm.trim()).join(", ")}, not an approved location; decide the market first.` };
  const away = found.filter((p) => p.approved && p.norm !== ctx.homeCity);
  if (away.length) return { fit: "ambiguous", reason: `Names ${away.map((p) => p.norm.trim()).join(", ")}, an approved location other than the home city; its location page may own it.` };
  const claims = ctx.otherClaims.get(k.id);
  if (claims?.length) return { fit: "ambiguous", reason: `A general query, but also claimed by ${claims.join(", ")}; a person decides which page owns it.` };
  return { fit: "home", reason: brand && !category ? "A company (brand) query: the home page owns it." : `A ${brand ? "company" : "general category"} query (${[...ctx.category].join(", ")}) with no service, activity or material: the home page owns it.` };
}

// Where a candidate stands. Only a valid Home makes anything eligible.
export function homeCheck(k: { id: string; keyword: string }, ctx: HomeContext): HomeCheck {
  const f = homeFit(k, ctx);
  if (!ctx.summary.valid) return { fit: f.fit, eligible: false, reason: `${f.reason} ${ctx.summary.reasons.map((r) => r.text).join(" ")}`.trim() };
  return { fit: f.fit, eligible: f.fit === "home", reason: f.reason };
}
