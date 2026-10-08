// Social Style Analyzer (SH2). Pure and deterministic: the same imported
// posts, metrics and rules always give the same profile, byte for byte. No
// network, no database, no clock (as_of is an input and only recorded).
//
// What it produces is a PROPOSED Client Social Style Profile: how the client
// writes and what has performed on its own Page. It is style and performance
// evidence only, never factual grounding (docs/social-history.md, decisions
// 2 and 8). Nothing here creates, confirms or cites a claim. Every example
// post it keeps is masked with the AI Drafter's own fact detectors, so no
// historical statement can be copied into a draft as a fact.
//
// Post roles (one post may hold several):
//   representative  closest to the client's normal voice, per major content
//                   category
//   top performer   engagement per reach clearly above the client's OWN
//                   baseline for the same format family (no generic
//                   benchmark), not an outlier, not do-not-learn
//   outlier         extreme reach or engagement (robust z on the log scale
//                   and at least 3× the baseline or the median reach):
//                   informs performance patterns, never the voice
//   do-not-learn    no caption, too short, one-off promotion, hiring post,
//                   testimonial, scarcity or words-to-avoid wording, mostly
//                   unsupported claims, or excluded by a
//                   teammate / the learnable view (Compass, paid, not the
//                   Page's own, missing)
//
// Unavailable metrics stay null: no engagement rate is computed without
// reach, and a trait's confidence drops with what it rests on.
import { claimCategories, DETECTORS, MATERIAL_RE, stableJson } from "../post-drafter/rules.ts";

export const ANALYZER_VERSION = "social-style-v1";
export const PROFILE_SCHEMA = "compass-social-style/1";
export const MIN_PERFORMANCE_AGE_HOURS = 168;      // 7 days: reach has mostly accrued
export const MIN_GROUP = 5;                         // a pattern needs at least 5 posts
export const OUTLIER_Z = 3.5;                       // modified z-score (Iglewicz–Hoaglin)
export const OUTLIER_MIN = 3;                       // and at least 3× the baseline (or the median reach)
export const TOP_LIFT = 1.25;
export const MAX_TOP = 6;
export const MAX_REPRESENTATIVE = 6;
export const MAX_MASKED_SHARE = 0.35;               // above this a post is mostly unsupported claims
export const WEAK_CHARS = 40;

export type Confidence = "high" | "medium" | "low";
export type Metrics = {
  captured_at: string;
  age_hours: number | null;
  impressions: number | null;
  reach: number | null;
  reactions: number | null;
  comments: number | null;
  shares: number | null;
  clicks: number | null;
  views: number | null;
  unavailable: string[];
};
export type StylePost = {
  id: string;
  platform_post_id: string;
  published_at: string;
  copy: string;
  copy_hash: string;
  format: string;
  permalink: string | null;
  media_count: number;
  learnable: boolean;            // social_history_learnable_posts said so
  exclusion: string | null;      // why the learnable view excludes it
  metrics: Metrics | null;
};
export type StyleInput = {
  client: { id: string; name: string; phone: string | null; website_url: string | null; city: string | null; state: string | null; service_area: string | null };
  platform: "facebook";
  as_of: string;
  timezone: string;
  posts: StylePost[];
  rules: { words_we_avoid: string[]; hard_rules: string[] };
  places: { approved: string[] };
  usable_claims: string[];
};

// ── Small helpers ────────────────────────────────────────────────────────────
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function dist(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => { const v = quantile(s, p); return v == null ? null : round(v, 1); };
  return { n: s.length, min: s.length ? s[0] : null, p10: q(0.1), p25: q(0.25), median: q(0.5), p75: q(0.75), p90: q(0.9), max: s.length ? s[s.length - 1] : null };
}
const median = (xs: number[]) => quantile([...xs].sort((a, b) => a - b), 0.5);
const share = (k: number, n: number) => (n ? round(k / n, 3) : null);
export function confidence(n: number, cap: Confidence = "high"): Confidence {
  const c: Confidence = n >= 30 ? "high" : n >= 15 ? "medium" : "low";
  const order: Confidence[] = ["low", "medium", "high"];
  return order[Math.min(order.indexOf(c), order.indexOf(cap))];
}
const g = (re: RegExp) => new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
function tally<T extends string>(xs: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}
const words = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9\s'-]/g, " ").split(/\s+/).filter(Boolean);

// ── Text structure ───────────────────────────────────────────────────────────
export const EMOJI_RE = /(?:[\u{1F1E6}-\u{1F1FF}]{2})|(?:\p{Extended_Pictographic}(?:\uFE0F|\u20E3)?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F)?)*)/gu;
const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu;
const BULLET_RE = /^(?:[-•*]|\p{Extended_Pictographic}\uFE0F?)\s*\S/u;
const SIGNATURE_RE = /^(?:📞|🌐|📍|☎️|📲)/u;

export type Parsed = {
  body: string;                 // copy without the trailing hashtag block
  lines: string[];
  bullets: number;
  signatureLines: number;
  sentences: number[];          // words per sentence
  emojis: string[];
  emojiLead: boolean;
  hashtags: string[];
  hashtagBlock: boolean;        // hashtags sit in a closing block
  questions: number;
  exclamations: number;
  opening: string;
};
export function parse(copy: string): Parsed {
  const raw = copy.replace(/\r\n?/g, "\n");
  const all = raw.split("\n");
  // Strip trailing lines made only of hashtags.
  let end = all.length;
  while (end > 0 && (!all[end - 1].trim() || /^(?:\s*#[\p{L}\p{N}_]+\s*)+$/u.test(all[end - 1]))) end--;
  const body = all.slice(0, end).join("\n");
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => BULLET_RE.test(l) && l.length <= 70 && !/[.!?]\s+\S/.test(l)).length;
  const signatureLines = lines.filter((l) => SIGNATURE_RE.test(l)).length;
  const prose = lines.filter((l) => !(BULLET_RE.test(l) && l.length <= 70) && !SIGNATURE_RE.test(l) && !/^#/.test(l));
  const sentences = prose.flatMap((l) => l.split(/(?<=[.!?])\s+/)).map((s) => words(s.replace(HASHTAG_RE, "")).length).filter((n) => n >= 2);
  const emojis = [...raw.matchAll(EMOJI_RE)].map((m) => m[0]).filter((e) => !/^[\d#*]$/.test(e));
  const hashtags = [...raw.matchAll(HASHTAG_RE)].map((m) => m[0]);
  return {
    body,
    lines,
    bullets,
    signatureLines,
    sentences,
    emojis,
    emojiLead: lines.length > 0 && new RegExp(`^${EMOJI_RE.source}`, "u").test(lines[0]),
    hashtags,
    hashtagBlock: hashtags.length > 0 && end < all.length,
    questions: (body.match(/\?/g) ?? []).length,
    exclamations: (body.match(/!/g) ?? []).length,
    opening: lines[0] ?? "",
  };
}

// ── Openings, CTAs, tone, categories ────────────────────────────────────────
export function openingType(p: Parsed): string {
  const l = p.opening.replace(EMOJI_RE, "").trim();
  if (!l) return "none";
  if (/\?["”]?$/.test(l) || /^["“]?(?:is|are|do|does|did|need|looking|want|ever|what|how|why|would|can|could|have)\b[^.!]*\?/i.test(l)) return "question";
  if (/⚠️/.test(p.opening) || /\b(severe weather|storms? (?:are|is) (?:moving|expected|coming)|hail damage)\b/i.test(l)) return "alert";
  if (/\b(big news|now offering|officially|expanding|introducing|announc)/i.test(l)) return "announcement";
  if (/\b(happy (?:thanksgiving|holidays|new year|4th|fourth|easter|memorial)|merry christmas|fourth of july|4th of july|independence day|holidays are)\b/i.test(l)) return "seasonal_greeting";
  if (/\b(proud to support|parade|community|local heroes|thank you)\b/i.test(l)) return "community_moment";
  if (/^(?:your|you|is your|need|looking|don'?t|give your|clogged|protect)\b/i.test(l)) return "direct_address";
  const ws = l.split(/\s+/);
  const titleCase = ws.length >= 2 && ws.filter((w) => /^[A-Z0-9&]/.test(w)).length / ws.length >= 0.6;
  if (p.emojiLead && l.length <= 70) return titleCase ? "emoji_headline" : "emoji_statement";
  if (titleCase && l.length <= 70) return "headline";
  return "statement";
}

const CTA_PATTERNS: [string, RegExp][] = [
  ["call", /\b(?:call|give us a call|call or text)\b|📞/i],
  ["text", /\btext\b(?!ured)/i],
  ["message", /\b(?:send us a message|message us|dm us|personal message)\b|📲/i],
  ["comment", /\bcomment\b/i],
  ["website", /🌐|https?:\/\/|\b[a-z0-9-]+\.(?:com|net|org)\b/i],
  ["estimate_or_quote", /\b(?:estimates?|quotes?|consultation)\b/i],
  ["contact", /\bcontact\b/i],
  ["schedule", /\bschedul\w*|\bget on (?:our|the) schedule\b/i],
  ["tag_someone", /\btag someone\b/i],
];
export function ctaTypes(text: string): string[] {
  return CTA_PATTERNS.filter(([, re]) => re.test(text)).map(([k]) => k);
}

const PROMO_RE = /\b(?:free|discount|early bird|limited|spots?|special|offer|deal|call now|book now|filling up|today|don'?t wait|contact|schedule|estimate|quote)\b/gi;
const CONV_RE = /\b(?:you|your|you're|we're|we've|let's|i|my|thanks?|thank you|hope|loved|awesome|believe|honestly|yes)\b/gi;
export function tone(p: Parsed, ctas: string[]): { conversational: number; promotional: number; label: string } {
  const conv = (p.body.match(CONV_RE) ?? []).length * 0.5 + p.questions + (p.body.match(/😂|🤣|😅|😉/g) ?? []).length;
  const promo = (p.body.match(PROMO_RE) ?? []).length + ctas.length * 0.5 + p.bullets * 0.3 + (p.hashtags.length > 5 ? 1 : 0);
  const label = promo - conv >= 2 ? "promotional" : conv - promo >= 1 ? "conversational" : "balanced";
  return { conversational: round(conv, 1), promotional: round(promo, 1), label };
}

const CATEGORY_PATTERNS: [string, RegExp][] = [
  ["hiring", /\b(?:now hiring|is hiring|we'?re hiring|job opening|canvassers?|door knockers?|\/hour|per hour|interview)\b/i],
  ["testimonial", /\b(?:happy homeowner|kind words|testimonial|left us (?:a )?(?:review|5)|five[- ]star review)\b|⭐/i],
  ["weather_alert", /\b(?:severe weather|storms? (?:are|is) (?:moving|expected|coming|rolling)|expected to move through|hail (?:is|was) (?:expected|reported)|after (?:the|last night'?s|this week'?s) storms?)\b/i],
  ["community", /\b(?:parade|community|neighbou?rs|local heroes|support (?:our|local)|proud to support|first responders)\b/i],
  ["team", /\b(?:meet (?:the|our)|our crew|the crew|fantasy football|behind the scenes|team member)\b/i],
  ["promotional", /\b(?:discount|early bird|limited spots|spots will be limited|filling up|special offer|deal|call now|book now|big news|now offering|officially expanding)\b/i],
  ["project_showcase", /\b(?:finished|completed|another (?:roof|one|project|job)|before (?:and|&) after|this (?:roof|project|job|install)|done in one take|on the job|job site|out installing)\b/i],
  ["educational", /\b(?:signs? (?:of|your|that)|tips?|what does|how to|did you know|is your (?:roof|home|house) ready|when snow melts|ice dams?|what to look for|look like|actually look|here'?s (?:what|how|why))\b/i],
  ["seasonal", /\b(?:christmas|holidays?|thanksgiving|halloween|spring|summer|winter|fall|storm season|new year|fourth of july|4th of july)\b/i],
  ["service_promo", /(?:roof(?:ing)? (?:repairs?|replacements?|services?|solutions?))|(?:siding (?:&|and) gutters)|(?:storm damage)/i],
];
export function categories(text: string): string[] {
  return CATEGORY_PATTERNS.filter(([, re]) => re.test(text)).map(([k]) => k);
}

// ── Facts, places and masking ───────────────────────────────────────────────
// A counted review ("100+ 5-star reviews") is masked whole, number included.
const REVIEW_COUNT_RE = /\b\d[\d,]*\+?\s*(?:(?:5|five)[- ]star\s+)?(?:google\s+|online\s+|customer\s+)?(?:reviews?|ratings?)\b/gi;
const LIMITED_TIME_RE = /\blimited[- ]time\b|\blimited spots\b|\bspots? (?:will be|are) limited\b|\bfilling up fast\b|\bbefore (?:our )?(?:limited )?spots fill up\b|\b(?:call|act|book) now\b|\bdon'?t wait\b|\bwhile (?:they|supplies) last\b/gi;
const LABELS: Record<string, string> = {
  review: "review", address: "address", pricing: "price/offer", tenure: "tenure/ownership", response: "response time",
  credential: "credential", diagnosis: "diagnosis", superlative: "superlative", material: "material", limited_time: "urgency",
  avoided_wording: "avoided wording", place: "place not approved",
};
export type Span = { start: number; end: number; category: string; text: string };

export type PlaceBook = { approved: Set<string>; serviceArea: Set<string>; region: Set<string>; patterns: RegExp[] };
const canon = (s: string) => s.toLowerCase().replace(/[’']/g, "'").replace(/\bsaint\b/g, "st.").replace(/\bst\b\.?/g, "st.").replace(/\s+/g, " ").trim();
export function placeBook(input: StyleInput): PlaceBook {
  const approved = new Set<string>();
  for (const a of [...input.places.approved, input.client.city ?? ""]) {
    const base = a.replace(/,\s*[A-Z]{2}$/, "").trim();
    if (base && input.places.approved.some((x) => x.replace(/,\s*[A-Z]{2}$/, "").trim() === base)) approved.add(canon(base));
  }
  const serviceArea = new Set<string>();
  for (const part of (input.client.service_area ?? "").split(/,|\band\b/)) {
    const t = part.replace(/,?\s*Missouri\b|\bMO\b/gi, "").trim();
    if (!t) continue;
    serviceArea.add(canon(t));
    const county = t.replace(/\s+Count(?:y|ies)$/i, "").trim();
    if (county !== t) serviceArea.add(canon(county));
  }
  const region = new Set(["missouri", "mo", (input.client.state ?? "").toLowerCase()].filter(Boolean));
  const patterns = [
    /\b(?:St\.?|Saint)\s+[A-Z][a-z]+(?:\s+Count(?:y|ies))?/g,
    /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+Count(?:y|ies)\b/g,
    /\bO['’]Fallon\b/g,
  ];
  return { approved, serviceArea, region, patterns };
}
export function placeMentions(text: string, book: PlaceBook): { text: string; start: number; end: number; kind: "approved" | "service_area" | "other" }[] {
  const out: { text: string; start: number; end: number; kind: "approved" | "service_area" | "other" }[] = [];
  const add = (start: number, end: number) => {
    if (out.some((o) => start < o.end && end > o.start)) return;
    const t = text.slice(start, end);
    const c = canon(t.replace(/\s+Count(?:y|ies)$/i, ""));
    if (book.region.has(c)) return;
    const kind = book.approved.has(c) ? "approved" : book.serviceArea.has(c) || book.serviceArea.has(canon(t)) ? "service_area" : "other";
    out.push({ text: t, start, end, kind });
  };
  for (const re of book.patterns) for (const m of text.matchAll(g(re))) add(m.index!, m.index! + m[0].length);
  const known = [...book.approved, ...book.serviceArea].filter((k) => k.length >= 4).sort((a, b) => b.length - a.length);
  for (const k of known) {
    const pattern = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/st\\\./g, "(?:st\\.?|saint)").replace(/'/g, "['’]");
    for (const m of text.matchAll(new RegExp(`\\b${pattern}\\b`, "gi"))) add(m.index!, m.index! + m[0].length);
  }
  return out.sort((a, b) => a.start - b.start);
}

export function factSpans(text: string, input: StyleInput, book: PlaceBook): Span[] {
  const spans: Span[] = [];
  const push = (start: number, end: number, category: string) => { if (end > start) spans.push({ start, end, category, text: text.slice(start, end) }); };
  for (const d of DETECTORS) for (const m of text.matchAll(g(d.re))) push(m.index!, m.index! + m[0].length, d.category);
  for (const m of text.matchAll(REVIEW_COUNT_RE)) push(m.index!, m.index! + m[0].length, "review");
  for (const m of text.matchAll(g(MATERIAL_RE))) push(m.index!, m.index! + m[0].length, "material");
  for (const m of text.matchAll(g(LIMITED_TIME_RE))) push(m.index!, m.index! + m[0].length, "limited_time");
  for (const w of input.rules.words_we_avoid) {
    if (w.trim().length < 3 || /language$/i.test(w)) continue;
    const re = new RegExp(`\\b${w.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[- ]/g, "[- ]")}\\b`, "gi");
    for (const m of text.matchAll(re)) push(m.index!, m.index! + m[0].length, "avoided_wording");
  }
  for (const p of placeMentions(text, book)) if (p.kind !== "approved") push(p.start, p.end, "place");
  // Hashtags naming a place that is not approved.
  for (const m of text.matchAll(HASHTAG_RE)) {
    const tag = m[0].slice(1).toLowerCase();
    const names = [...book.serviceArea].map((s) => s.replace(/[^a-z]/g, "")).filter((s) => s.length >= 5);
    const unapproved = names.some((n) => tag.includes(n)) || /stlouis|stcharles|ofallon|lincolncounty|warrencounty/.test(tag);
    const approvedOnly = [...book.approved].some((a) => tag.includes(a.replace(/[^a-z]/g, "")));
    if (unapproved && !approvedOnly) push(m.index!, m.index! + m[0].length, "place");
  }
  // Protected: the client's own phone and website, and the verbatim text of a
  // claim the AI Drafter may cite (never reviews, addresses, prices or phones).
  const protectedRanges: [number, number][] = [];
  const phoneDigits = (input.client.phone ?? "").replace(/\D/g, "").slice(-10);
  for (const m of text.matchAll(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g)) {
    if (phoneDigits && m[0].replace(/\D/g, "").slice(-10) === phoneDigits) protectedRanges.push([m.index!, m.index! + m[0].length]);
  }
  const host = (input.client.website_url ?? "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  if (host) for (const m of text.matchAll(new RegExp(host.replace(/\./g, "\\."), "gi"))) protectedRanges.push([m.index!, m.index! + m[0].length]);
  for (const c of input.usable_claims) {
    const cats = claimCategories(c);
    if (cats.some((x) => ["review", "address", "pricing", "phone"].includes(x))) continue;
    const re = new RegExp(c.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    for (const m of text.matchAll(re)) protectedRanges.push([m.index!, m.index! + m[0].length]);
  }
  const kept = spans.filter((s) => !protectedRanges.some(([a, b]) => s.start >= a && s.end <= b));
  // Merge overlaps (first category wins, deterministic order by start then length).
  kept.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const s of kept) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) { if (s.end > last.end) { last.end = s.end; last.text = text.slice(last.start, last.end); } continue; }
    merged.push({ ...s });
  }
  return merged;
}
export function maskText(text: string, spans: Span[]): string {
  let out = "";
  let at = 0;
  for (const s of spans) {
    out += text.slice(at, s.start) + `[${LABELS[s.category] ?? s.category}]`;
    at = s.end;
  }
  return out + text.slice(at);
}

// ── Per-post reading ────────────────────────────────────────────────────────
type Reading = {
  post: StylePost;
  parsed: Parsed;
  chars: number;
  words: number;
  opening: string;
  ctas: string[];
  tone: ReturnType<typeof tone>;
  cats: string[];
  primary: string;
  spans: Span[];
  maskedShare: number;
  places: ReturnType<typeof placeMentions>;
  dnl: { code: string; detail: string }[];
  family: "video" | "static";
  engagement: number | null;
  rate: number | null;
  clickRate: number | null;
};
const PRIMARY_ORDER = CATEGORY_PATTERNS.map(([k]) => k);
// A post built on scarcity, or on wording the brand avoids, is kept out of the
// voice as a whole. Milder urgency ("don't wait", "call now") and a street
// address in a signature are masked and listed as phrases instead, so a
// typical post is not lost for one line.
const SCARCITY_RE = /\blimited[- ]time\b|\blimited spots\b|\bspots? (?:will be|are) limited\b|\bfilling up fast\b|\bspots fill up\b|\bwhile (?:they|supplies) last\b/i;
const forbids = (s: Span) => s.category === "avoided_wording" || (s.category === "limited_time" && SCARCITY_RE.test(s.text));
const ONE_OFF_RE = /\b(?:early bird|discount|%\s*off|on sale|promo code|coupon)\b|\b(?:before|until|ends?|by)\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?\b/i;

function read(post: StylePost, input: StyleInput, book: PlaceBook): Reading {
  const parsed = parse(post.copy);
  const text = post.copy;
  const ctas = ctaTypes(parsed.body);
  const cats = categories(text);
  const spans = factSpans(text, input, book);
  const bodyLen = Math.max(1, parsed.body.replace(/\s/g, "").length);
  const maskedBody = spans.filter((s) => s.start < parsed.body.length).reduce((a, s) => a + s.text.replace(/\s/g, "").length, 0);
  const maskedShare = round(Math.min(1, maskedBody / bodyLen), 3);
  const dnl: { code: string; detail: string }[] = [];
  if (!post.learnable) dnl.push({ code: "not_learnable", detail: post.exclusion ?? "Excluded by the learnable view." });
  const trimmed = post.copy.trim();
  if (!trimmed) dnl.push({ code: "no_caption", detail: "No caption: nothing to learn about the voice (still counted for media, cadence and performance)." });
  else if (trimmed.length < WEAK_CHARS) dnl.push({ code: "weak_content", detail: `Caption under ${WEAK_CHARS} characters: too little to learn the voice from.` });
  if (cats.includes("hiring")) dnl.push({ code: "hiring", detail: "A recruiting post, not the client's customer voice." });
  if (cats.includes("testimonial")) dnl.push({ code: "testimonial", detail: "A customer testimonial or review: never cited or imitated (hard rule on reviews)." });
  if (ONE_OFF_RE.test(text)) dnl.push({ code: "one_off_promotion", detail: "A one-off or date-bound promotion (discount, deadline): outdated and against the no-pricing rule." });
  const conflicts = [...new Set(spans.filter(forbids).map((s) => `"${s.text.toLowerCase()}"`))];
  if (conflicts.length) dnl.push({ code: "conflicts_with_brand_rules", detail: `Built on wording the brand rules forbid: ${conflicts.join(", ")}.` });
  if (trimmed && maskedShare > MAX_MASKED_SHARE) dnl.push({ code: "mostly_unsupported_claims", detail: `${Math.round(maskedShare * 100)}% of the caption is claims Compass cannot stand behind (see the phrase list).` });
  const m = post.metrics;
  const engagement = m && m.reactions != null && m.comments != null && m.shares != null ? m.reactions + m.comments + m.shares : null;
  const rate = engagement != null && m?.reach ? engagement / m.reach : null;
  const clickRate = m?.clicks != null && m?.reach ? m.clicks / m.reach : null;
  const primary = PRIMARY_ORDER.find((c) => cats.includes(c)) ?? (trimmed ? "general" : "no_caption");
  return {
    post, parsed, chars: trimmed.length, words: words(parsed.body).length, opening: openingType(parsed), ctas,
    tone: tone(parsed, ctas), cats, primary, spans, maskedShare,
    places: placeMentions(parsed.body, book), dnl,
    family: post.format === "reel" || post.format === "video" ? "video" : "static",
    engagement, rate, clickRate,
  };
}

// ── Profile ──────────────────────────────────────────────────────────────────
export function fingerprintSource(input: StyleInput): string {
  return stableJson({
    analyzer: ANALYZER_VERSION,
    platform: input.platform,
    posts: [...input.posts].sort((a, b) => a.id.localeCompare(b.id)).map((p) => [
      p.id, p.copy_hash, p.learnable, p.exclusion, p.format,
      p.metrics ? [p.metrics.captured_at, p.metrics.reach, p.metrics.impressions, p.metrics.reactions, p.metrics.comments, p.metrics.shares, p.metrics.clicks, p.metrics.views] : null,
    ]),
    rules: input.rules,
    places: [...input.places.approved].sort(),
    service_area: input.client.service_area,
    claims: [...input.usable_claims].sort(),
    phone: input.client.phone,
    website: input.client.website_url,
  });
}

function example(r: Reading, input: StyleInput, why: string[], lift: number | null) {
  return {
    post_id: r.post.id,
    platform_post_id: r.post.platform_post_id,
    permalink: r.post.permalink,
    published_at: r.post.published_at,
    format: r.post.format,
    category: r.primary,
    opening_type: r.opening,
    why,
    masked_copy: maskText(r.post.copy, r.spans),
    masked: tally(r.spans.map((s) => s.category)),
    metrics: r.post.metrics ? {
      reach: r.post.metrics.reach, reactions: r.post.metrics.reactions, comments: r.post.metrics.comments,
      shares: r.post.metrics.shares, clicks: r.post.metrics.clicks,
      engagement_per_reach: r.rate == null ? null : round(r.rate, 4), lift: lift == null ? null : round(lift, 2),
    } : null,
  };
}

function modifiedZ(values: number[]): (x: number) => number {
  const m = median(values) ?? 0;
  const mad = median(values.map((v) => Math.abs(v - m))) ?? 0;
  return (x) => (mad === 0 ? 0 : (0.6745 * (x - m)) / mad);
}

export function analyze(input: StyleInput) {
  const book = placeBook(input);
  const all = [...input.posts].sort((a, b) => a.published_at.localeCompare(b.published_at) || a.id.localeCompare(b.id)).map((p) => read(p, input, book));
  const learnable = all.filter((r) => r.post.learnable);

  // ── Performance, relative to the client's own history ──
  const eligible = learnable.filter((r) => r.rate != null && (r.post.metrics?.age_hours ?? 0) >= MIN_PERFORMANCE_AGE_HOURS);
  const familyMedian: Record<string, number | null> = {};
  for (const f of ["video", "static"] as const) {
    const xs = eligible.filter((r) => r.family === f).map((r) => r.rate!);
    familyMedian[f] = xs.length >= 8 ? median(xs) : null;
  }
  const overallRate = median(eligible.map((r) => r.rate!));
  const baselineOf = (r: Reading) => familyMedian[r.family] ?? overallRate;
  const lift = new Map<string, number>();
  for (const r of eligible) { const b = baselineOf(r); if (b && b > 0) lift.set(r.post.id, r.rate! / b); }
  const reachOf = (r: Reading) => r.post.metrics?.reach ?? null;
  const withReach = eligible.filter((r) => (reachOf(r) ?? 0) > 0);
  const reachMedian = median(withReach.map((r) => reachOf(r)!));
  const zLift = modifiedZ([...lift.values()].map((x) => Math.log(x)));
  const zReach = modifiedZ(withReach.map((r) => Math.log(reachOf(r)!)));
  const outlierIds = new Map<string, string[]>();
  for (const r of eligible) {
    const why: string[] = [];
    const l = lift.get(r.post.id);
    if (l != null && l >= OUTLIER_MIN && zLift(Math.log(l)) >= OUTLIER_Z) why.push(`engagement per reach ${l.toFixed(1)}× the ${r.family} baseline`);
    const reach = reachOf(r);
    if (reach && reachMedian && reach >= OUTLIER_MIN * reachMedian && zReach(Math.log(reach)) >= OUTLIER_Z) why.push(`reach ${reach} vs a median of ${Math.round(reachMedian ?? 0)}`);
    if (why.length) outlierIds.set(r.post.id, why);
  }
  const isDnl = (r: Reading) => r.dnl.length > 0;

  // ── The voice corpus: learnable, captioned, not do-not-learn, not outliers ──
  const voice = learnable.filter((r) => !isDnl(r) && !outlierIds.has(r.post.id));
  const nv = voice.length;
  const voiceConf = (cap: Confidence = "high") => confidence(nv, cap);

  const lengthBuckets = (c: number) => (c <= 80 ? "one_liner" : c <= 300 ? "short" : c <= 800 ? "medium" : "long");
  const byFamily = (f: string) => voice.filter((r) => r.family === f).map((r) => r.chars);

  const openings = tally(voice.map((r) => r.opening));
  const openingExamples = Object.fromEntries(Object.keys(openings).map((k) => [k, voice.filter((r) => r.opening === k).slice(-3).map((r) => ({
    post_id: r.post.id, line: maskText(r.parsed.opening, factSpans(r.parsed.opening, input, book)) }))]));

  const allSent = voice.flatMap((r) => r.parsed.sentences);
  const emojiPosts = voice.filter((r) => r.parsed.emojis.length > 0);
  const emojiTop = tally(voice.flatMap((r) => r.parsed.emojis));
  const hashtagPosts = voice.filter((r) => r.parsed.hashtags.length > 0);
  const tagTally = tally(voice.flatMap((r) => r.parsed.hashtags.map((h) => h.toLowerCase())));
  const tagSpans = (t: string) => factSpans(t, input, book).length > 0;

  const ctaTally: Record<string, number> = {};
  for (const r of voice) for (const c of r.ctas) ctaTally[c] = (ctaTally[c] ?? 0) + 1;
  const ctaLines = tally(voice.flatMap((r) => r.parsed.lines.filter((l) => ctaTypes(l).some((c) => ["call", "contact", "schedule", "message", "estimate_or_quote", "text", "comment"].includes(c)))
    .map((l) => maskText(l, factSpans(l, input, book)).replace(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, "[phone]").replace(/\s+/g, " ").trim())));

  const placeRows = voice.flatMap((r) => r.places.map((p) => ({ ...p, post: r.post.id })));
  const placeTally = (kind: string) => tally(placeRows.filter((p) => p.kind === kind).map((p) => p.text.replace(/['’]/g, "'")));

  const mixAll = learnable.filter((r) => r.post.copy.trim());
  const contentMix = tally(mixAll.map((r) => r.primary));

  // Cadence over every imported post of the Page (published history is fact,
  // whether or not a post is learned from).
  const dates = all.map((r) => new Date(r.post.published_at).getTime()).sort((a, b) => a - b);
  const gaps = dates.slice(1).map((t, i) => (t - dates[i]) / 86_400_000);
  const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: input.timezone, ...o });
  const weekday = tally(all.map((r) => fmt({ weekday: "short" }).format(new Date(r.post.published_at)).toLowerCase()));
  const hourBucket = tally(all.map((r) => {
    const h = Number(fmt({ hour: "numeric", hour12: false }).format(new Date(r.post.published_at))) % 24;
    return h < 6 ? "night" : h < 11 ? "morning" : h < 14 ? "midday" : h < 18 ? "afternoon" : "evening";
  }));
  const months = tally(all.map((r) => fmt({ year: "numeric", month: "2-digit" }).format(new Date(r.post.published_at)).replace(/(\d{2})\/(\d{4})/, "$2-$1")));
  const spanDays = dates.length > 1 ? (dates[dates.length - 1] - dates[0]) / 86_400_000 : 0;

  // Recurring language: four-word runs in at least a fifth of the voice posts.
  const df = new Map<string, Set<string>>();
  for (const r of voice) {
    const ws = words(r.parsed.body.replace(HASHTAG_RE, " ").replace(/https?:\/\/\S+/g, " ").replace(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g, " "));
    for (let i = 0; i + 4 <= ws.length; i++) {
      const k = ws.slice(i, i + 4).join(" ");
      if (!df.has(k)) df.set(k, new Set());
      df.get(k)!.add(r.post.id);
    }
  }
  const minDf = Math.max(3, Math.ceil(nv * 0.2));
  let phrases = [...df.entries()].filter(([, s]) => s.size >= minDf).map(([k, s]) => ({ phrase: k, posts: s.size }))
    .sort((a, b) => b.posts - a.posts || a.phrase.localeCompare(b.phrase));
  phrases = phrases.filter((p, i) => !phrases.slice(0, i).some((q) => q.posts === p.posts && q.phrase.includes(p.phrase.split(" ").slice(1).join(" ")) && q !== p)).slice(0, 15);
  const shingles = (r: Reading) => { const ws = words(r.parsed.body); const s = new Set<string>(); for (let i = 0; i + 5 <= ws.length; i++) s.add(ws.slice(i, i + 5).join(" ")); return s; };
  const sh = new Map(voice.map((r) => [r.post.id, shingles(r)]));
  const nearDup: { a: string; b: string; overlap: number }[] = [];
  for (let i = 0; i < voice.length; i++) for (let j = i + 1; j < voice.length; j++) {
    const A = sh.get(voice[i].post.id)!, B = sh.get(voice[j].post.id)!;
    if (!A.size || !B.size) continue;
    let shared = 0; for (const x of A) if (B.has(x)) shared++;
    const o = shared / Math.min(A.size, B.size);
    if (o >= 0.5) nearDup.push({ a: voice[i].post.id, b: voice[j].post.id, overlap: round(o, 2) });
  }

  // ── Engagement patterns (lift over the client's own baseline) ──
  const perfConf: Confidence = confidence(eligible.length, "medium");   // one snapshot per post caps it
  const groupLift = (key: (r: Reading) => string, pool = eligible) => {
    const groups: Record<string, number[]> = {};
    for (const r of pool) { const l = lift.get(r.post.id); if (l == null) continue; (groups[key(r)] ??= []).push(l); }
    return Object.fromEntries(Object.entries(groups).sort((a, b) => a[0].localeCompare(b[0])).map(([k, xs]) => [k, xs.length >= MIN_GROUP
      ? { posts: xs.length, median_lift: round(median(xs)!, 2), confidence: confidence(xs.length, "medium") }
      : { posts: xs.length, median_lift: null, confidence: "low" as Confidence, note: `fewer than ${MIN_GROUP} posts` }]));
  };

  // ── Roles ──
  const outliers = eligible.filter((r) => outlierIds.has(r.post.id)).map((r) => ({
    ...example(r, input, outlierIds.get(r.post.id)!, lift.get(r.post.id) ?? null),
    also_do_not_learn: r.dnl.map((d) => d.code),
  }));
  const topPool = eligible.filter((r) => !isDnl(r) && !outlierIds.has(r.post.id) && (lift.get(r.post.id) ?? 0) >= TOP_LIFT && r.maskedShare <= MAX_MASKED_SHARE)
    .sort((a, b) => (lift.get(b.post.id)! - lift.get(a.post.id)!) || a.post.id.localeCompare(b.post.id));
  const top: Reading[] = [];
  for (const r of topPool) {
    if (top.length >= MAX_TOP) break;
    const t = new Date(r.post.published_at).getTime();
    if (top.some((x) => Math.abs(new Date(x.post.published_at).getTime() - t) < 7 * 86_400_000)) continue;
    top.push(r);
  }

  // Representative: closest to the voice centre on standardised features,
  // up to two per major category, then the overall nearest.
  const feats = (r: Reading) => [r.chars, median(r.parsed.sentences) ?? 0, r.parsed.emojis.length, r.parsed.hashtags.length, r.parsed.bullets, r.ctas.length, r.tone.promotional - r.tone.conversational];
  const cols = voice.length ? feats(voice[0]).map((_, i) => voice.map((r) => feats(r)[i])) : [];
  const centre = cols.map((c) => median(c) ?? 0);
  const scale = cols.map((c, i) => { const m = median(c.map((v) => Math.abs(v - centre[i]))) ?? 0; return m > 0 ? m : 1; });
  const distance = (r: Reading) => Math.sqrt(feats(r).reduce((a, v, i) => a + ((v - centre[i]) / scale[i]) ** 2, 0));
  const repPool = voice.filter((r) => r.maskedShare <= 0.25).sort((a, b) => distance(a) - distance(b) || a.post.id.localeCompare(b.post.id));
  const majors = Object.entries(tally(voice.map((r) => r.primary))).filter(([, n]) => n >= 3 && n / Math.max(1, nv) >= 0.15).map(([k]) => k);
  const reps: Reading[] = [];
  for (const c of majors) for (const r of repPool.filter((x) => x.primary === c).slice(0, 2)) if (reps.length < MAX_REPRESENTATIVE && !reps.includes(r)) reps.push(r);
  const want = Math.min(MAX_REPRESENTATIVE, Math.max(4, majors.length * 2));
  // Fill up, preferring a category not yet shown, then the nearest overall.
  for (const r of repPool) { if (reps.length >= want) break; if (!reps.includes(r) && !reps.some((x) => x.primary === r.primary)) reps.push(r); }
  for (const r of repPool) { if (reps.length >= want) break; if (!reps.includes(r)) reps.push(r); }

  // ── Do-not-learn ──
  const dnlPosts = all.filter(isDnl).map((r) => ({
    post_id: r.post.id, platform_post_id: r.post.platform_post_id, permalink: r.post.permalink, published_at: r.post.published_at,
    format: r.post.format, opening: maskText(r.parsed.opening, factSpans(r.parsed.opening, input, book)).slice(0, 120), reasons: r.dnl,
  }));
  const phraseRows: Record<string, { posts: Set<string>; texts: Record<string, number> }> = {};
  for (const r of learnable) for (const s of r.spans) {
    const row = (phraseRows[s.category] ??= { posts: new Set(), texts: {} });
    row.posts.add(r.post.id);
    const t = s.text.toLowerCase().replace(/\s+/g, " ");
    row.texts[t] = (row.texts[t] ?? 0) + 1;
  }
  const phraseList = Object.entries(phraseRows).map(([category, row]) => ({
    category, label: LABELS[category] ?? category, posts: row.posts.size,
    examples: Object.entries(row.texts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([text, count]) => ({ text, count })),
    why: PHRASE_WHY[category] ?? "Conflicts with the brand rules.",
  })).sort((a, b) => b.posts - a.posts || a.category.localeCompare(b.category));

  const metricAvailability = (k: keyof Metrics) => {
    const xs = learnable.filter((r) => r.post.metrics);
    const present = xs.filter((r) => r.post.metrics![k] != null).length;
    return { present, of: xs.length };
  };
  const nonVideoViewsZero = learnable.filter((r) => r.family === "static" && r.post.metrics?.views === 0).length;
  const capture = learnable.map((r) => r.post.metrics?.captured_at).filter(Boolean).sort() as string[];
  const singleSnapshot = new Set(learnable.map((r) => r.post.metrics?.captured_at?.slice(0, 16))).size <= 3;

  const traits = {
    caption_length: {
      chars: dist(voice.map((r) => r.chars)), words: dist(voice.map((r) => r.words)),
      buckets: tally(voice.map((r) => lengthBuckets(r.chars))),
      by_format_family: { video: dist(byFamily("video")), static: dist(byFamily("static")) },
      n: nv, confidence: voiceConf(), basis: "Captions of the voice corpus (learnable, captioned, not do-not-learn, not outliers).",
    },
    structure: {
      lines_per_post: dist(voice.map((r) => r.parsed.lines.length)),
      posts_with_checklist: share(voice.filter((r) => r.parsed.bullets >= 3).length, nv),
      posts_with_signature_block: share(voice.filter((r) => r.parsed.signatureLines >= 2).length, nv),
      posts_with_hashtag_block: share(voice.filter((r) => r.parsed.hashtagBlock).length, nv),
      n: nv, confidence: voiceConf(), basis: "Checklist = 3+ short bullet lines; signature = 2+ lines starting 📞 🌐 📍.",
    },
    openings: { types: openings, examples: openingExamples, n: nv, confidence: voiceConf(), basis: "First line of each caption, by a fixed set of patterns." },
    sentences: {
      words_per_sentence: dist(allSent),
      short_sentence_share: share(allSent.filter((w) => w <= 8).length, allSent.length),
      posts_with_exclamation: share(voice.filter((r) => r.parsed.exclamations > 0).length, nv),
      posts_with_question: share(voice.filter((r) => r.parsed.questions > 0).length, nv),
      person: {
        we_our_per_post: round(median(voice.map((r) => (r.parsed.body.match(/\b(?:we|we're|we've|our|us)\b/gi) ?? []).length)) ?? 0, 1),
        you_your_per_post: round(median(voice.map((r) => (r.parsed.body.match(/\b(?:you|your|you're)\b/gi) ?? []).length)) ?? 0, 1),
        brand_name_per_post: round(median(voice.map((r) => (r.parsed.body.match(new RegExp(input.client.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")) ?? []).length)) ?? 0, 1),
      },
      n: allSent.length, confidence: confidence(nv), basis: "Prose lines only (bullets, signature lines and hashtags left out).",
    },
    tone: {
      labels: tally(voice.map((r) => r.tone.label)),
      median_conversational: round(median(voice.map((r) => r.tone.conversational)) ?? 0, 1),
      median_promotional: round(median(voice.map((r) => r.tone.promotional)) ?? 0, 1),
      n: nv, confidence: voiceConf("medium"), basis: "Counted markers (second person, questions, humour vs offers, CTAs, checklists, hashtag load). A heuristic, so capped at medium.",
    },
    emoji: {
      posts_with_any: share(emojiPosts.length, nv),
      per_post_when_used: dist(emojiPosts.map((r) => r.parsed.emojis.length)),
      top: Object.entries(emojiTop).slice(0, 12).map(([e, n]) => ({ emoji: e, count: n })),
      leads_first_line: share(voice.filter((r) => r.parsed.emojiLead).length, nv),
      n: nv, confidence: voiceConf(), basis: "Pictographic characters and flags in the caption.",
    },
    hashtags: {
      posts_with_any: share(hashtagPosts.length, nv),
      per_post_when_used: dist(hashtagPosts.map((r) => r.parsed.hashtags.length)),
      in_closing_block: share(voice.filter((r) => r.parsed.hashtagBlock).length, Math.max(1, hashtagPosts.length)),
      top: Object.entries(tagTally).slice(0, 15).map(([tag, count]) => ({ tag, count, do_not_learn: tagSpans(tag) })),
      n: nv, confidence: voiceConf(), basis: "Hashtags anywhere in the caption; a tag naming a place that is not approved is marked do-not-learn.",
    },
    cta: {
      posts_with_any: share(voice.filter((r) => r.ctas.length).length, nv),
      types: Object.fromEntries(Object.entries(ctaTally).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, v]) => [k, share(v, nv)])),
      common_lines: Object.entries(ctaLines).filter(([, n]) => n >= 2).slice(0, 8).map(([line, count]) => ({ line, count })),
      n: nv, confidence: voiceConf(), basis: "Call / text / message / comment / website / estimate / contact / schedule wording; lines are masked.",
    },
    locations: {
      posts_naming_a_place: share(voice.filter((r) => r.places.length).length, nv),
      approved: placeTally("approved"),
      in_service_area_not_approved: placeTally("service_area"),
      other: placeTally("other"),
      approved_locations: input.places.approved,
      n: nv, confidence: voiceConf("medium"), basis: "Pattern and service-area matching (no gazetteer), so capped at medium. Only approved locations may be used in drafts.",
    },
    content_mix: {
      primary: contentMix,
      share: Object.fromEntries(Object.entries(contentMix).map(([k, v]) => [k, share(v, mixAll.length)])),
      n: mixAll.length, confidence: confidence(mixAll.length, "medium"), basis: "Fixed keyword lexicon; a post's primary category is the first match in a fixed order. Heuristic, so capped at medium.",
    },
    media_mix: { formats: tally(learnable.map((r) => r.post.format)), n: learnable.length, confidence: confidence(learnable.length), basis: "Imported format of every learnable post." },
    cadence: {
      posts: all.length, span_days: Math.round(spanDays),
      posts_per_week: spanDays > 0 ? round(all.length / (spanDays / 7), 2) : null,
      gap_days: dist(gaps.map((x) => round(x, 1))),
      by_month: months, weekday, hour_local: hourBucket, timezone: input.timezone,
      n: all.length, confidence: confidence(all.length), basis: "Publish times of every imported post (history is fact, whether learned from or not).",
    },
    recurring_language: {
      phrases: phrases.map((p) => ({ ...p, share: share(p.posts, nv), do_not_learn: factSpans(p.phrase, input, book).length > 0 })),
      near_duplicate_pairs: nearDup.length,
      near_duplicates: nearDup.sort((a, b) => b.overlap - a.overlap || a.a.localeCompare(b.a)).slice(0, 8),
      n: nv, confidence: voiceConf("medium"), basis: `Four-word runs in at least ${minDf} voice posts; near-duplicates share half their five-word runs.`,
    },
    engagement: {
      metric: "engagement per reach = (reactions + comments + shares) / reach",
      eligible_posts: eligible.length,
      baseline: { video: familyMedian.video == null ? null : round(familyMedian.video, 4), static: familyMedian.static == null ? null : round(familyMedian.static, 4), overall: overallRate == null ? null : round(overallRate, 4) },
      reach: dist(withReach.map((r) => reachOf(r)!)),
      posts_with_comments: share(eligible.filter((r) => (r.post.metrics?.comments ?? 0) > 0).length, eligible.length),
      posts_with_shares: share(eligible.filter((r) => (r.post.metrics?.shares ?? 0) > 0).length, eligible.length),
      clicks_per_reach: (() => { const xs = eligible.map((r) => r.clickRate).filter((x): x is number => x != null); return xs.length ? round(median(xs)!, 4) : null; })(),
      lift_by_category: groupLift((r) => r.primary),
      lift_by_format: groupLift((r) => r.post.format),
      lift_by_opening: groupLift((r) => r.opening),
      lift_by_length: groupLift((r) => lengthBuckets(r.chars)),
      lift_by_hashtags: groupLift((r) => (r.parsed.hashtags.length ? "with_hashtags" : "no_hashtags")),
      lift_by_checklist: groupLift((r) => (r.parsed.bullets >= 3 ? "checklist" : "no_checklist")),
      n: eligible.length, confidence: perfConf,
      basis: `Each post against the median of its own format family on this Page (video ${familyMedian.video == null ? "uses the overall median" : "baseline"}, static likewise when under 8 posts). Posts younger than ${MIN_PERFORMANCE_AGE_HOURS / 24} days and posts without reach are left out; no generic benchmark is used. One metrics snapshot per post caps confidence at medium.`,
    },
  };

  return {
    schema: PROFILE_SCHEMA,
    analyzer_version: ANALYZER_VERSION,
    client_id: input.client.id,
    platform: input.platform,
    as_of: input.as_of,
    boundary: "Style and performance evidence only. Never factual grounding: no example, phrase or statistic here is a claim, a source or evidence. Facts in drafts come only from Client Intelligence and Authority under their own rules.",
    corpus: {
      imported: all.length,
      learnable: learnable.length,
      voice: nv,
      performance_eligible: eligible.length,
      do_not_learn: dnlPosts.length,
      outliers: outliers.length,
      window: { from: all[0]?.post.published_at ?? null, to: all.at(-1)?.post.published_at ?? null },
      metrics_captured: { first: capture[0] ?? null, last: capture.at(-1) ?? null, single_snapshot: singleSnapshot },
    },
    metric_availability: {
      reach: metricAvailability("reach"), impressions: metricAvailability("impressions"), reactions: metricAvailability("reactions"),
      comments: metricAvailability("comments"), shares: metricAvailability("shares"), clicks: metricAvailability("clicks"),
      saves: { present: 0, of: learnable.filter((r) => r.post.metrics).length, note: "Not a Facebook metric; not used." },
      views: { ...metricAvailability("views"), note: `Video only; ${nonVideoViewsZero} static posts report 0 (not applicable). Not used.` },
    },
    traits,
    representative: reps.map((r) => example(r, input, [
      `closest to the voice centre for ${r.primary.replace(/_/g, " ")}`,
      `${r.chars} characters, ${r.parsed.emojis.length} emoji, ${r.parsed.hashtags.length} hashtags, opening: ${r.opening.replace(/_/g, " ")}`,
    ], lift.get(r.post.id) ?? null)),
    top_performers: top.map((r) => example(r, input, [`engagement per reach ${(lift.get(r.post.id) ?? 0).toFixed(2)}× its ${r.family} baseline`], lift.get(r.post.id) ?? null)),
    outliers,
    do_not_learn: { posts: dnlPosts, phrases: phraseList },
    notes: [
      "Approve only if the representative posts sound like the client and the do-not-learn list is complete.",
      "Masked spans show what Compass cannot state without a usable claim; they are never learned as facts.",
      ...(singleSnapshot ? ["Metrics come from a single snapshot per post; refresh the import to add history."] : []),
    ],
  };
}

const PHRASE_WHY: Record<string, string> = {
  pricing: "Never quote or imply pricing, discounts or free offers (hard rule); offers go through the offers table.",
  tenure: "Founding year, tenure or ownership needs a confirmed claim (hard rule).",
  response: "Response-time promises need a confirmed claim (hard rule).",
  credential: "Credentials, warranties and guarantees need a usable claim in their exact words.",
  review: "Reviews, ratings and testimonials are never cited (hard rule).",
  address: "No street address in copy (hard rule).",
  diagnosis: "Never diagnose the reader's home.",
  superlative: "Unprovable superlatives are not used.",
  material: "Materials and products only when a linked claim names them.",
  limited_time: "No limited-time or high-pressure language (hard rule).",
  avoided_wording: "On the brand's words-to-avoid list.",
  place: "Only approved locations may be named in drafts.",
};

export type StyleProfile = ReturnType<typeof analyze>;
