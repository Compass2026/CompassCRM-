// Intent sanity check. The stored keywords.intent is kept as a FACT; this
// assesses the query text with a conservative, deterministic classifier and
// flags a clear contradiction. It never corrects the stored value: a
// conflict is a finding for a person, and an ambiguous query is left to
// judgment rather than guessed. Pure.
import { placesIn, type PlaceIndex } from "./urls.ts";

export type AssessedIntent = "navigational" | "informational" | "commercial_or_transactional" | "ambiguous";
export type IntentCheck = { stored: string | null; assessed: AssessedIntent; conflict: boolean; reason: string };

const QUESTION = /^(how|what|why|when|which|who|where|can|does|do|is|are|should|will)\b|\?$|\b(vs\.?|versus|signs of|guide to|tips|ideas|meaning|lifespan)\b/i;
const BUYER = /\bnear me\b|\b(quotes?|estimates?|hire|hiring|book|schedule|cost to install|contractors?|compan(y|ies)|services?|installers?|pros?)\b/i;
// A service noun or a service verb: "roof repair", "gutter installation".
const SERVICE = /\b(repair|replacement|replace|installation|install|inspection|restoration|roofing|roofer|siding|gutters?|soffit|fascia|lighting|lights)\b/i;
const STRONG_BUYER = /\bnear me\b|\b(quotes?|estimates?|hire|book)\b/i;
const STATE_SUFFIX = /\b(mo|missouri)\b/i;

export function assessIntent(query: string, stored: string | null, ctx: { clientName: string; places: PlaceIndex }): IntentCheck {
  const q = query.toLowerCase().trim();
  const brandWords = (ctx.clientName.toLowerCase().match(/[a-z']{4,}/g) ?? []).filter((w) => !["construction", "roofing", "company", "services"].includes(w));
  const brand = q.includes(ctx.clientName.toLowerCase()) || brandWords.some((w) => new RegExp(`\\b${w}\\b`).test(q));
  const local = placesIn(q, ctx.places).length > 0 || STATE_SUFFIX.test(q);
  let assessed: AssessedIntent;
  let reason: string;
  if (brand && (SERVICE.test(q) || BUYER.test(q))) {
    assessed = "ambiguous";
    reason = "Names the business and a service: navigational or commercial; left to human judgment.";
  } else if (brand) {
    assessed = "navigational";
    reason = "Names the business: a brand query.";
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
