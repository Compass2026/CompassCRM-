// AI Drafter v1: the Deterministic Linter. Pure; no model, no network.
//
// Judges a model's draft against the brief it was written from. Any problem
// means the draft is not written anywhere; the model adapter may revise
// against the SAME brief. Warnings never block.
//
// The core rule: every factual marketing assertion is either a CRM fact the
// brief allows or stated inside the verbatim text of a linked usable claim.
// The linter masks those spans, then refuses anything factual left over:
// credentials and guarantees, tenure, response times, reviews and ratings,
// pricing, addresses, materials no linked claim names, superlatives, stray
// numbers, other phone numbers, unapproved places, Brand Board
// differentiators stated as fact. Plus the channel's own rules (reused from
// the publisher), words the brand avoids and the keyword-use limit.
import { channelProblems } from "../post-publisher/channel.ts";
import type { Brief, LintProblem, LintResult, ModelDraft } from "./types.ts";
import { DETECTORS, MATERIAL_RE, NUMBER_RE, PHONE_RE, digits, escapeRe, mask, ngrams, spansOf, words } from "./rules.ts";

export type LintOptions = {
  // Place names the linter treats as places (e.g. the client's state from
  // the bundled GeoNames list). Any found that is not an approved place is
  // refused. Optional: without it only "... County" is checked.
  gazetteer?: string[];
};

const DIFFERENTIATOR_NGRAM = 4;

// Gazetteer names that are also ordinary English words. These count as a
// place only in a place context ("in Liberty", "near Union", "Republic, MO"),
// so "Independence Day" or "a union of" never trip the location rule.
export const COMMON_WORD_PLACES = new Set([
  "Advance", "Arcadia", "Bland", "Center", "Clever", "Competition", "Crane", "Diamond", "Excelsior", "Freedom",
  "Independence", "Liberal", "Liberty", "Paradise", "Peculiar", "Republic", "Success", "Summit", "Union", "Victoria",
]);
const PLACE_BEFORE = "(?:[Ii]n|[Nn]ear|[Aa]round|[Ss]erving|[Tt]hroughout|[Ff]rom|[Tt]o|[Oo]f|[Aa]cross)\\s+";
const PLACE_AFTER = "(?:,?\\s+(?:MO|Missouri|County)\\b)";

export function lintDraft(brief: Brief, draft: ModelDraft, opts: LintOptions = {}): LintResult {
  const problems: LintProblem[] = [];
  const warnings: LintProblem[] = [];
  const add = (code: string, message: string, match?: string) => {
    if (!problems.some((p) => p.code === code && p.match === match)) problems.push({ code, message, ...(match ? { match } : {}) });
  };
  const warn = (code: string, message: string, match?: string) => warnings.push({ code, message, ...(match ? { match } : {}) });
  const copy = draft.copy ?? "";
  const rules = brief.channel_rules;

  // ── Linked claims and assets must come from the brief ──
  const allowed = new Map(brief.allowed_facts.claims.map((c) => [c.id, c]));
  const excluded = new Map(brief.excluded.claims.map((c) => [c.id, c]));
  const linked = [];
  for (const id of new Set(draft.claim_ids ?? [])) {
    const c = allowed.get(id);
    if (c) linked.push(c);
    else {
      const x = excluded.get(id);
      add("claim_not_allowed", x ? `Claim "${x.text}" cannot be cited: ${x.reason}` : `Claim ${id} is not in the brief.`, id);
    }
  }
  if (linked.length > brief.allowed_facts.max_claims) add("too_many_claims", `Link at most ${brief.allowed_facts.max_claims} claims.`);
  if (linked.length < brief.allowed_facts.min_claims) add("too_few_claims", `A ${brief.target.search_intent} post links at least ${brief.allowed_facts.min_claims} usable claim.`);
  const assetIds = draft.asset_ids ?? brief.target.assets.map((a) => a.id);
  for (const id of assetIds) if (!brief.target.assets.some((a) => a.id === id)) add("asset_not_allowed", `Asset ${id} is not in the brief.`, id);

  // ── Channel rules (the publisher's own) ──
  const assets = brief.target.assets.filter((a) => assetIds.includes(a.id)).map((a, i) => ({ id: a.id, storage_path: a.storage_path, url: null, sort_order: i }));
  for (const p of channelProblems({ platform: brief.target.channel, post_type: brief.target.post_type, copy, cta_type: brief.target.cta.type, cta_url: brief.target.cta.url, offer: brief.target.offer, assets })) {
    add(`channel_${p.code}`, p.message);
  }
  const len = copy.trim().length;
  if (len > 0 && len < rules.min_chars) add("too_short", `Write at least ${rules.min_chars} characters (this is ${len}).`);
  if (len > rules.max_chars) add("too_long", `Keep it to ${rules.max_chars} characters (this is ${len}).`);
  if (len >= rules.min_chars && len <= rules.max_chars && (len < rules.preferred_min_chars || len > rules.preferred_max_chars)) {
    warnings.push({ code: "length_outside_preferred", message: `Aim for ${rules.preferred_min_chars}–${rules.preferred_max_chars} characters (this is ${len}).` });
  }
  for (const m of copy.matchAll(/https?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(?:com|net|org|co|us|io|biz|info)\b\S*/gi)) {
    add("url_in_body", "No links in the text: the button carries the link.", m[0]);
  }
  for (const m of copy.matchAll(/(^|\s)(#[\p{L}\p{N}_]+)/gu)) add("hashtag", "No hashtags on Business Profile posts.", m[2]);

  // ── Mask what is allowed: verbatim linked claims, the canonical phone, approved places, the business name ──
  const spans: [number, number][] = [];
  for (const c of linked) {
    const s = spansOf(copy, c.text);
    spans.push(...s);
    if (!s.length) warn("claim_not_stated", `Linked claim "${c.text}" is not stated verbatim; state it or unlink it.`, c.id);
  }
  const canonicalPhone = digits(brief.client.phone);
  for (const m of copy.matchAll(PHONE_RE)) {
    if (digits(m[0]) === canonicalPhone) spans.push([m.index!, m.index! + m[0].length]);
    else add("wrong_phone", `The only phone number is ${brief.client.phone}.`, m[0]);
  }
  for (const name of [brief.client.name, ...brief.allowed_facts.crm.services]) spans.push(...spansOf(copy, name));
  let masked = mask(copy, spans);
  // Pricing words inside an offer's own terms are the offer.
  const offerText = brief.target.offer ? `${brief.target.offer.title} ${brief.target.offer.terms}`.toLowerCase() : "";

  // ── Factual assertions left over ──
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    for (const m of masked.matchAll(d.re)) {
      if (d.category === "pricing" && offerText.includes(m[0].toLowerCase())) continue;
      add(
        `unsupported_${d.category}`,
        d.category === "credential"
          ? `"${m[0].trim()}" states ${d.label}; say it only in the exact words of a linked usable claim.`
          : d.category === "diagnosis"
            ? `"${m[0].trim()}" tells the reader what their home needs; only an inspection can. Invite consideration instead ("If you're considering …", "Learn more about whether … may fit your home").`
            : `"${m[0].trim()}" is ${d.label}, which this brief does not support.`,
        m[0].trim(),
      );
    }
  }
  const linkedText = linked.map((c) => c.text.toLowerCase()).join(" \n ");
  for (const m of masked.matchAll(MATERIAL_RE)) {
    if (!linkedText.includes(m[0].toLowerCase())) add("unsupported_material", `"${m[0]}" names a material no linked claim supports.`, m[0]);
  }
  masked = mask(masked, [...masked.matchAll(MATERIAL_RE)].map((m) => [m.index!, m.index! + m[0].length] as [number, number]));
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    masked = mask(masked, [...masked.matchAll(d.re)].map((m) => [m.index!, m.index! + m[0].length] as [number, number]));
  }
  for (const m of masked.matchAll(NUMBER_RE)) {
    add("unsupported_number", "Numbers appear only in the phone number or inside a linked claim.", m[0]);
    break;
  }

  // ── Places ──
  const allowedPlaces = new Set(brief.allowed_facts.crm.places.map((p) => p.toLowerCase()));
  const placeText = mask(copy, [...spans, ...brief.allowed_facts.crm.places.flatMap((p) => spansOf(copy, p))]);
  for (const m of placeText.matchAll(/\b(?:[A-Z][a-z'.]+\s){1,3}Count(?:y|ies)\b/g)) {
    if (!allowedPlaces.has(m[0].toLowerCase())) add("unapproved_location", `"${m[0]}" is not an approved location.`, m[0]);
  }
  for (const name of opts.gazetteer ?? []) {
    if (name.length < 4 || allowedPlaces.has(name.toLowerCase())) continue;
    const re = COMMON_WORD_PLACES.has(name)
      ? new RegExp(`(?:\\b${PLACE_BEFORE}${escapeRe(name)}(?![A-Za-z])|(^|[^A-Za-z])${escapeRe(name)}${PLACE_AFTER})`)
      : new RegExp(`(^|[^A-Za-z])${escapeRe(name)}(?![A-Za-z])`);
    if (re.test(placeText)) add("unapproved_location", `"${name}" is not an approved location (approved: ${brief.allowed_facts.crm.places.join(", ") || "none"}).`, name);
  }

  // ── Brand rules ──
  const lower = copy.toLowerCase();
  for (const w of brief.brand.words_we_avoid) {
    if (w.trim() && lower.includes(w.trim().toLowerCase())) add("word_to_avoid", `The brand avoids "${w}".`, w);
  }
  const copyWords = ngrams(words(mask(copy, spans)), DIFFERENTIATOR_NGRAM);
  for (const d of brief.brand.differentiators) {
    if (brief.allowed_facts.claims.some((c) => c.text.toLowerCase() === d.toLowerCase())) continue;
    const hit = ngrams(words(d), DIFFERENTIATOR_NGRAM).find((g) => copyWords.includes(g));
    if (hit) add("differentiator_as_fact", `"${d}" is brand guidance, not evidence; stating it needs its own usable claim.`, hit);
  }

  // ── Keyword ──
  if (brief.target.keyword) {
    const n = spansOf(copy, brief.target.keyword.text).length;
    if (n > brief.target.keyword.max_exact_uses) {
      add("keyword_stuffing", `"${brief.target.keyword.text}" appears ${n} times; use it at most ${brief.target.keyword.max_exact_uses}.`);
    }
  }

  // ── Advice (never blocks) ──
  const lead = copy.slice(0, rules.lead_chars).toLowerCase();
  if (brief.target.service && !words(brief.target.service.name).some((w) => w.length >= 4 && lead.includes(w))) {
    warn("lead_off_topic", `The first ${rules.lead_chars} characters don't mention ${brief.target.service.name}.`);
  }
  if (/\p{Extended_Pictographic}/u.test(copy)) warn("emoji", "Emoji: check the brand wants them.");

  return { ok: problems.length === 0, problems, warnings };
}
