// content-drafter: the linter for a blog draft. Pure; no model, no network.
//
// The post drafter's rule, applied to every word a reader sees (title, meta,
// H1, headings, body, CTA): a factual marketing assertion is either a CRM
// fact the brief allows or stated inside the verbatim text of a linked
// usable claim. The same detectors (post-drafter/rules.ts) find credentials,
// tenure, response times, reviews, pricing, addresses, diagnoses,
// superlatives, materials and stray numbers; the same place rule refuses
// places the client has not approved. Then the article's own rules:
// structure, length, links only to the client's approved pages, the
// standing CTA, the keyword limit.
import { COMMON_WORD_PLACES, PLACE_AFTER, PLACE_BEFORE } from "../post-drafter/lint.ts";
import { DETECTORS, MATERIAL_RE, NUMBER_RE, PHONE_RE, digits, escapeRe, mask, ngrams, normalizeUrl, spansOf, words } from "../post-drafter/rules.ts";
import type { LintProblem, LintResult } from "../post-drafter/types.ts";
import type { BlogBrief } from "./brief.ts";

export type BlogDraft = {
  title: string;
  slug: string;
  meta_title: string;
  meta_description: string;
  h1: string;
  outline: { level: number; heading: string }[];
  body_markdown: string;
  internal_links: { url: string; anchor: string; reason?: string }[];
  cta: { text: string; url: string | null };
  claim_ids: string[];
  // A web page (0069).
  page_path?: string | null;
  page_objective?: string | null;
  structured_data?: Record<string, unknown> | null;
};

// Every string inside a JSON-LD recommendation (what a search engine reads).
function jsonStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => jsonStrings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => jsonStrings(x, out));
  return out;
}

const MD_LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const BARE_URL = /https?:\/\/\S+|\bwww\.\S+/gi;

// Body words as a reader counts them (markup and link targets removed).
export function wordCount(markdown: string): number {
  const text = markdown.replace(MD_LINK, "$1").replace(/[#*>_`|]+/g, " ").trim();
  return text ? text.split(/\s+/).length : 0;
}

// The reader-visible text of the body: link text kept, targets dropped,
// list numbering dropped (a "1." is not a factual number).
function visibleBody(markdown: string): string {
  return markdown.replace(MD_LINK, "$1").replace(/^\s*\d+[.)]\s+/gm, "").replace(/[#*>_`|]+/g, " ");
}

// A blog or a web page (0069): the same rules, the page's on top.
export const lintContent = (...a: Parameters<typeof lintBlog>) => lintBlog(...a);

export function lintBlog(brief: BlogBrief, draft: BlogDraft, opts: { gazetteer?: string[] } = {}): LintResult {
  const problems: LintProblem[] = [];
  const warnings: LintProblem[] = [];
  const add = (code: string, message: string, match?: string) => {
    if (!problems.some((p) => p.code === code && p.match === match)) problems.push({ code, message, ...(match ? { match } : {}) });
  };
  const warn = (code: string, message: string, match?: string) => warnings.push({ code, message, ...(match ? { match } : {}) });
  const R = brief.rules;
  const body = draft.body_markdown ?? "";
  const page = brief.kind === "page" ? brief.target.page : undefined;

  // ── Structure ──
  const need = (v: string | null | undefined, label: string, code: string) => { if (!v || !v.trim()) add(code, `${label} is required.`); };
  need(draft.title, "A title", "title_missing");
  need(draft.h1, "An H1", "h1_missing");
  need(draft.meta_title, "A meta title", "meta_title_missing");
  need(draft.meta_description, "A meta description", "meta_description_missing");
  need(body, "The article body", "body_missing");
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(draft.slug ?? "") || (draft.slug ?? "").length > R.slug_max) {
    add("slug_invalid", `The slug is lowercase words joined by hyphens, at most ${R.slug_max} characters.`, draft.slug);
  }
  const mt = (draft.meta_title ?? "").length;
  if (mt > R.meta_title_max) add("meta_title_too_long", `Keep the meta title to ${R.meta_title_max} characters (this is ${mt}).`);
  else if (mt > R.meta_title_preferred_max) warn("meta_title_long", `Search results show about ${R.meta_title_preferred_max} characters (this is ${mt}).`);
  const md = (draft.meta_description ?? "").length;
  if (md > R.meta_description_max) add("meta_description_too_long", `Keep the meta description to ${R.meta_description_max} characters (this is ${md}).`);
  else if (md > 0 && md < R.meta_description_min) add("meta_description_too_short", `Write at least ${R.meta_description_min} characters of meta description (this is ${md}).`);
  else if (md > 0 && (md < R.meta_description_preferred_min || md > R.meta_description_preferred_max)) {
    warn("meta_description_length", `Aim for ${R.meta_description_preferred_min}–${R.meta_description_preferred_max} characters (this is ${md}).`);
  }
  if ((draft.h1 ?? "").length > R.h1_max) add("h1_too_long", `Keep the H1 to ${R.h1_max} characters.`);
  if (/^#\s/m.test(body)) add("h1_in_body", "The H1 is its own field; the body starts at H2 (##).");
  const n = wordCount(body);
  if (body.trim() && n < R.min_words) add("too_short", `Write at least ${R.min_words} words (this is ${n}).`);
  if (n > R.max_words) add("too_long", `Keep it to ${R.max_words} words (this is ${n}).`);
  if (n >= R.min_words && n <= R.max_words && (n < R.preferred_min_words || n > R.preferred_max_words)) {
    warn("length_outside_preferred", `Aim for ${R.preferred_min_words}–${R.preferred_max_words} words (this is ${n}).`);
  }
  const outline = Array.isArray(draft.outline) ? draft.outline : [];
  if (outline.filter((o) => o.level === 2).length < R.min_sections) add("outline_too_short", `The outline needs at least ${R.min_sections} H2 sections.`);
  const bodyHeadings = [...body.matchAll(/^(#{2,3})\s+(.+?)\s*$/gm)].map((m) => ({ level: m[1].length, heading: m[2].trim().toLowerCase() }));
  for (const o of outline) {
    if (![2, 3].includes(o.level) || !o.heading?.trim()) { add("outline_invalid", "Outline entries are H2 or H3 headings."); continue; }
    if (!bodyHeadings.some((h) => h.level === o.level && h.heading === o.heading.trim().toLowerCase())) {
      add("outline_mismatch", `The outline's "${o.heading}" is not a heading in the body.`, o.heading);
    }
  }

  // ── A page: its path, objective and structured data (0069) ──
  let schemaText = "";
  if (page) {
    const path = draft.page_path ?? "";
    if (!/^\/([a-z0-9]+(-[a-z0-9]+)*\/?)*$/.test(path) || path.length > 200) {
      add("page_path_invalid", "The proposed URL path is lowercase words and hyphens from the site root, like /services/roof-replacement.", path);
    } else if ((path.replace(/\/+$/, "").split("/").pop() ?? "") !== (draft.slug ?? "") && path !== "/") {
      add("slug_not_path", `The slug is the path's last segment ("${path.replace(/\/+$/, "").split("/").pop()}").`, draft.slug);
    }
    if (page.change === "page_rewrite" && page.existing_url) {
      let keep = "";
      try { keep = new URL(page.existing_url).pathname.replace(/\/+$/, "") || "/"; } catch { /* the brief checked it */ }
      if (keep && path.replace(/\/+$/, "") !== keep.replace(/\/+$/, "")) {
        add("refresh_moves_page", `A refresh keeps the page's URL (${keep}); moving it is a new page.`, path);
      }
    }
    const obj = (draft.page_objective ?? "").trim();
    if (!obj) add("objective_missing", "Say what the page is for (its objective).");
    else if (obj.length > (R as { objective_max?: number }).objective_max!) add("objective_too_long", "Keep the objective to one or two sentences.");
    const sd = draft.structured_data;
    if (sd != null) {
      if (typeof sd !== "object" || Array.isArray(sd)) add("schema_invalid", "The structured data is one JSON-LD object.");
      else {
        if (sd["@context"] !== "https://schema.org") add("schema_invalid", "Structured data uses \"@context\": \"https://schema.org\".");
        const types = Array.isArray(sd["@type"]) ? (sd["@type"] as unknown[]) : [sd["@type"]];
        for (const t of types) {
          if (typeof t !== "string" || !page.schema_types.includes(t)) {
            add("schema_type_not_allowed", `A ${page.type.replace(/_/g, " ")} page recommends ${page.schema_types.join(", ")}; not ${String(t)}.`, String(t));
          }
        }
        const strings = jsonStrings(sd);
        for (const u of strings.filter((x) => /^https?:\/\//.test(x) && x !== "https://schema.org")) {
          if (!brief.links.site || !u.startsWith(brief.links.site.replace(/\/+$/, ""))) add("schema_url_off_site", `Structured data links only to the client's site, not ${u}.`, u);
        }
        schemaText = strings.filter((x) => !/^https?:\/\//.test(x) && x !== "https://schema.org" && !types.includes(x)).join("\n");
      }
    }
  } else if (draft.page_path || draft.page_objective) {
    add("page_fields_on_blog", "A blog has no page path or objective.");
  }

  // ── Claims: only the brief's, within its limits ──
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
  if (linked.length < brief.allowed_facts.min_claims) add("too_few_claims", `A ${brief.target.search_intent} article links at least ${brief.allowed_facts.min_claims} usable claim.`);

  // ── Links: the client's own approved pages only ──
  const allowedUrls = new Set(brief.links.allowed.map((l) => normalizeUrl(l.url)));
  const bodyLinks = [...body.matchAll(MD_LINK)].map((m) => ({ anchor: m[1], url: m[2] }));
  const checkUrl = (url: string, where: string) => {
    const n2 = normalizeUrl(url);
    if (!n2 || !allowedUrls.has(n2)) add("link_not_allowed", `${where} links to ${url}, which is not one of the client's approved pages.`, url);
  };
  for (const l of bodyLinks) checkUrl(l.url, "The body");
  for (const l of draft.internal_links ?? []) checkUrl(l.url, "An internal-link recommendation");
  for (const m of body.replace(MD_LINK, "$1").matchAll(BARE_URL)) add("url_in_body", "Link with anchor text, not a bare URL.", m[0]);
  for (const r of brief.links.required) {
    if (!bodyLinks.some((l) => normalizeUrl(l.url) === normalizeUrl(r.url))) {
      add("required_link_missing", `Link to ${r.label} (${r.url}) in the body.`, r.url);
    }
  }
  if (!draft.cta?.text?.trim()) add("cta_missing", "A call to action is required.");
  else if (brief.cta.text && draft.cta.text.trim().toLowerCase() !== brief.cta.text.trim().toLowerCase()) {
    add("cta_not_standing", `The call to action is the brand's standing CTA: "${brief.cta.text}".`, draft.cta.text);
  }
  if (draft.cta?.url) checkUrl(draft.cta.url, "The CTA");

  // ── Facts: everything a reader sees ──
  const text = [draft.title, draft.meta_title, draft.meta_description, draft.h1, ...outline.map((o) => o.heading), visibleBody(body), draft.cta?.text,
    page ? draft.page_objective : null, schemaText]
    .filter(Boolean).join("\n");
  const spans: [number, number][] = [];
  for (const c of linked) {
    const s = spansOf(text, c.text);
    spans.push(...s);
    if (!s.length) warn("claim_not_stated", `Linked claim "${c.text}" is not stated verbatim; state it or unlink it.`, c.id);
  }
  const canonicalPhone = digits(brief.client.phone);
  for (const m of text.matchAll(PHONE_RE)) {
    if (digits(m[0]) === canonicalPhone) spans.push([m.index!, m.index! + m[0].length]);
    else add("wrong_phone", `The only phone number is ${brief.client.phone}.`, m[0]);
  }
  for (const name of [brief.client.name, ...brief.allowed_facts.crm.services, ...brief.allowed_facts.crm.places]) spans.push(...spansOf(text, name));
  let masked = mask(text, spans);
  for (const d of DETECTORS) {
    d.re.lastIndex = 0;
    for (const m of masked.matchAll(d.re)) {
      add(
        `unsupported_${d.category}`,
        d.category === "credential"
          ? `"${m[0].trim()}" states ${d.label}; say it only in the exact words of a linked usable claim.`
          : d.category === "diagnosis"
            ? `"${m[0].trim()}" tells the reader what their home needs; only an inspection can. Explain the signs and invite an inspection instead.`
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

  // ── Places (the post drafter's rule) ──
  const allowedPlaces = new Set(brief.allowed_facts.crm.places.map((p) => p.toLowerCase()));
  const placeText = mask(text, [...spans, ...brief.allowed_facts.crm.places.flatMap((p) => spansOf(text, p))]);
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

  // ── Brand ──
  const lower = text.toLowerCase();
  for (const w of brief.brand.words_we_avoid) {
    if (w.trim() && lower.includes(w.trim().toLowerCase())) add("word_to_avoid", `The brand avoids "${w}".`, w);
  }
  const textGrams = ngrams(words(mask(text, spans)), 4);
  for (const d of brief.brand.differentiators) {
    if (brief.allowed_facts.claims.some((c) => c.text.toLowerCase() === d.toLowerCase())) continue;
    const hit = ngrams(words(d), 4).find((g) => textGrams.includes(g));
    if (hit) add("differentiator_as_fact", `"${d}" is brand guidance, not evidence; stating it needs its own usable claim.`, hit);
  }

  // ── Keyword ──
  const kw = brief.target.primary_keyword;
  if (kw) {
    const uses = spansOf(visibleBody(body), kw).length;
    if (uses > R.keyword_max_exact_uses) add("keyword_stuffing", `"${kw}" appears ${uses} times in the body; use it at most ${R.keyword_max_exact_uses}.`);
    const kwWords = words(kw).filter((w) => w.length >= 4);
    const inTitle = kwWords.some((w) => words(`${draft.title} ${draft.h1}`).includes(w));
    if (!inTitle) warn("keyword_not_in_title", `Neither the title nor the H1 mentions "${kw}".`);
  }
  return { ok: problems.length === 0, problems, warnings };
}
