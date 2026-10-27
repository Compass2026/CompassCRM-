// Intent sanity check. The stored keywords.intent is kept as a FACT; this
// assesses the query text with a conservative, deterministic classifier and
// flags a clear contradiction. It never corrects the stored value: a
// conflict is a finding for a person, and an ambiguous query is left to
// judgment rather than guessed. Pure.
import { normPlace, placesIn, type PlaceIndex } from "./urls.ts";

export type AssessedIntent = "navigational" | "informational" | "commercial_or_transactional" | "ambiguous";
export type IntentCheck = { stored: string | null; assessed: AssessedIntent; conflict: boolean; reason: string };

const QUESTION = /^(how|what|why|when|which|who|where|can|does|do|is|are|should|will)\b|\?$|\b(vs\.?|versus|signs of|guide to|tips|ideas|meaning|lifespan)\b/i;
const BUYER = /\bnear me\b|\b(quotes?|estimates?|hire|hiring|book|schedule|cost to install|contractors?|compan(y|ies)|services?|installers?|pros?)\b/i;
// A service noun or a service verb: "roof repair", "gutter installation".
const SERVICE = /\b(repair|replacement|replace|installation|install|inspection|restoration|roofing|roofer|siding|gutters?|soffit|fascia|lighting|lights)\b/i;
const STRONG_BUYER = /\bnear me\b|\b(quotes?|estimates?|hire|book)\b/i;
// What may accompany a business's name in a plainly navigational search:
// finding it, reaching it or getting in. Anything else beside the name
// ("reviews", "membership", "battery backup") is judged on the evidence.
const CONTACT = new Set([
  "phone", "number", "telephone", "call", "address", "hours", "location", "locations",
  "directions", "contact", "website", "site", "official", "email", "login", "log",
  "near", "me", "office", "map",
]);
const FILLER = new Set(["and", "the", "of", "at", "in", "co"]);
const STATES = new Set([
  "al", "ak", "az", "ar", "ca", "co", "ct", "de", "fl", "ga", "hi", "id", "il", "in", "ia",
  "ks", "ky", "la", "me", "md", "ma", "mi", "mn", "ms", "mo", "mt", "ne", "nv", "nh", "nj",
  "nm", "ny", "nc", "nd", "oh", "ok", "or", "pa", "ri", "sc", "sd", "tn", "tx", "ut", "vt",
  "va", "wa", "wv", "wi", "wy", "alabama", "alaska", "arizona", "arkansas", "california",
  "colorado", "connecticut", "delaware", "florida", "georgia", "hawaii", "idaho", "illinois",
  "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts",
  "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada",
  "ohio", "oklahoma", "oregon", "pennsylvania", "tennessee", "texas", "utah", "vermont",
  "virginia", "washington", "wisconsin", "wyoming",
]);
const STATE_SUFFIX = /\b(mo|missouri)\b/i;

export function assessIntent(query: string, stored: string | null, ctx: { clientName: string; places: PlaceIndex }): IntentCheck {
  const q = query.toLowerCase().trim();
  // Industry and service nouns in business names are not brand identifiers.
  // "BHG Forklift Training" should not make "forklift training course" a
  // navigational search. Keep distinctive names and literal acronyms instead.
  const generic = new Set([
    "construction", "roofing", "company", "services", "service", "partners", "partner",
    "llc", "inc", "group", "solutions", "training", "equipment", "forklift",
    "safety", "heavy", "operator", "operators", "industrial", "consulting",
    "consultants", "consultant", "compliance", "audits", "audit", "contractors",
    "contractor", "interiors", "design", "build", "electrical", "marketing",
    "solar", "plumbing", "contracting", "rental", "rentals", "boxing", "masonry",
    "brothers",
  ]);
  // A place in the name ("Pensacola Equipment Rentals") is not a brand word
  // either: "equipment rental pensacola" is someone choosing a provider.
  const placeWords = new Set(ctx.places.names.flatMap((p) => p.norm.trim().split(" ")));
  const brandWords = (ctx.clientName.toLowerCase().match(/[a-z']{4,}/g) ?? [])
    .filter((w) => !generic.has(w) && !placeWords.has(w.replace(/'/g, "")));
  const initialism = ctx.clientName.match(/^\s*([A-Z]{2,5})\b/)?.[1]?.toLowerCase();
  const fullName = q.includes(ctx.clientName.toLowerCase());
  const brand = fullName
    || brandWords.some((w) => new RegExp(`\\b${w}\\b`).test(q))
    || !!(initialism && new RegExp(`\\b${initialism}\\b`).test(q));
  // A name made only of service and place words is also what people search
  // for the service; matching it is not by itself a search for the business.
  const descriptiveName = fullName && brandWords.length === 0 && !initialism;
  const local = placesIn(q, ctx.places).length > 0 || STATE_SUFFIX.test(q);
  let assessed: AssessedIntent;
  let reason: string;
  // Naming the business is an attribute, not a primary intent. Only the bare
  // name, alone or with a place or contact words, is plainly navigational;
  // every other branded query is judged on the evidence.
  if (brand && descriptiveName) {
    assessed = "ambiguous";
    reason = "The business name is also a description of the service; left to human judgment.";
  } else if (brand) {
    const rest = beyondName(q, ctx.clientName, ctx.places);
    if (rest.length === 0) {
      assessed = "navigational";
      reason = "The business's name alone, or with a place or contact words: a search for the business.";
    } else {
      assessed = "ambiguous";
      reason = `Names the business with "${rest.join(" ")}": the evidence decides; left to human judgment.`;
    }
  } else if (QUESTION.test(q)) {
    assessed = "informational";
    reason = "Phrased as a question or a how-to / comparison.";
  } else if (BUYER.test(q)) {
    assessed = "commercial_or_transactional";
    reason = `Buyer wording (${q.match(BUYER)![0]}).`;
  } else if (SERVICE.test(q) && local) {
    assessed = "commercial_or_transactional";
    reason = `A service (${q.match(SERVICE)![0]}) plus a place: someone looking for a provider.`;
  } else {
    assessed = "ambiguous";
    reason = "No clear brand, question or buyer pattern; left to human judgment.";
  }
  const s = stored?.toLowerCase() ?? null;
  let conflict = false;
  // Only clear contradictions. Commercial research is often phrased as a
  // question ("how much does a new roof cost"), so commercial vs a question
  // is not a conflict; informational vs buyer wording is one only when the
  // wording is strong (near me / quote / estimate / hire / book).
  if (s && assessed !== "ambiguous") {
    if (assessed === "navigational") conflict = s !== "navigational";
    else if (assessed === "informational") conflict = s === "navigational" || s === "transactional";
    else conflict = s === "navigational" || (s === "informational" && STRONG_BUYER.test(q));
  }
  if (!s) reason += " No stored intent.";
  else if (conflict) reason += ` Stored as ${s}.`;
  return { stored, assessed, conflict, reason };
}

// The words of a branded query that are not the business's name, a place,
// a state or a contact word.
function beyondName(q: string, clientName: string, places: PlaceIndex): string[] {
  let hay = normPlace(q);
  for (const p of places.names) hay = hay.split(p.norm).join(" ");
  const nameWords = new Set(normPlace(clientName).trim().split(" "));
  return hay.trim().split(/\s+/).filter((w) =>
    w && !nameWords.has(w) && !CONTACT.has(w) && !FILLER.has(w) && !STATES.has(w));
}
