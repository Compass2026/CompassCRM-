// AI Drafter v1: the request handed to a model adapter. Plain text plus the
// brief and an output contract; nothing vendor-specific (no roles, message
// formats, model names or parameters). Any adapter — the Claude worker skill
// in v1, an API model, a Compass agent — renders this however its runtime
// needs and must return a ModelDraft ({ copy, claim_ids }).
import type { Brief, LintProblem, ModelDraft } from "./types.ts";

export type ModelRequest = {
  instructions: string;
  brief: Brief;
  output_contract: { copy: "string"; claim_ids: "string[] (ids from brief.allowed_facts.claims only)" };
  revision?: { previous: ModelDraft; problems: LintProblem[] };
};

export const MAX_ATTEMPTS = 3;

export function modelRequest(brief: Brief, revision?: ModelRequest["revision"]): ModelRequest {
  const t = brief.target;
  const lines = [
    `Write one ${t.channel === "google_business" ? "Google Business Profile" : t.channel} ${t.post_type} post for ${brief.client.name}.`,
    `Search intent: ${t.search_intent}.${t.service ? ` Topic: ${t.service.name}.` : ""}${t.keyword ? ` The phrase "${t.keyword.text}" may appear at most ${t.keyword.max_exact_uses} time, only if it reads naturally.` : ""}`,
    `Write like a local business talking to neighbours, in the brand's voice (brief.brand). Not SEO copy.`,
    `Aim for about ${brief.channel_rules.preferred_min_chars}–${brief.channel_rules.preferred_max_chars} characters (never under ${brief.channel_rules.min_chars} or over ${brief.channel_rules.max_chars}), plain text, no hashtags, no links, no emoji. Make the point in the first ${brief.channel_rules.lead_chars} characters.`,
    t.cta.type
      ? `The post's button is ${t.cta.type}${t.cta.url ? ` to ${t.cta.url}` : ""}; the text may close with the brand's call to action${t.cta.in_copy_phrase ? ` ("${t.cta.in_copy_phrase}")` : ""}.`
      : `No button.`,
    `Facts: say only what brief.allowed_facts contains. State a claim only in its exact words, and link it in claim_ids. Use the fewest claims that make the post useful (at most ${brief.allowed_facts.max_claims}; prefer ${brief.allowed_facts.recommended_claim_ids.length ? "the recommended ones" : "none"}).`,
    `Places: only ${brief.allowed_facts.crm.places.join(", ") || "none"}.`,
    `Never: prices, discounts or "free"; years, tenure or "since"; response times; reviews, ratings or stars; street addresses; any other phone number; materials no linked claim names; superlatives; numbers outside the phone; anything in brief.excluded; a brand differentiator stated as fact.`,
    `Never diagnose the reader's home: no "beyond repair", "needs to be replaced", "time to replace", "needs a new roof", "patching no longer makes sense", "this damage requires replacement". Only an inspection can say that. Invite consideration instead: "If you're considering a roof replacement…", "If you're starting to think about replacing an aging roof…", "Learn more about whether roof replacement may fit your home".`,
    `Do not add anything the facts do not say. In particular, never write:`,
    `- process steps or how the work is done (who does it, in what order, what is included, how long it takes) unless a linked claim states them;`,
    `- implied competence or quality ("we know how…", "done right", "the right way", "careful", "experienced crews", "attention to detail");`,
    `- a broader scope for a claim than its exact words: no "every", "all", "always", "any", "fully" or "for life" attached to a warranty, credential or claim, and no restating a claim in other words;`,
    `- promises inferred from brand wording (positioning, differentiators, tagline, words we use): they set tone, not facts;`,
    `- a paraphrase of anything in brief.excluded, including these non-citable differentiators: ${brief.excluded.facts.filter((f) => f.fact.startsWith("Differentiator:")).map((f) => f.fact.replace(/^Differentiator: /, "")).join("; ") || "none"}.`,
    `Words from brief.brand.words_we_use may appear only where they state no new fact (e.g. "request an estimate" is fine; describing an inspection-to-sign-off process is not).`,
    `Materials and products (asphalt, metal, slate, cedar, shingle lines, manufacturers) only when a linked claim names them; plain "roof", "roofing" and the service name are fine.`,
    `Follow every hard rule in brief.brand.hard_rules and brief.brand.ai_guidance. Avoid brief.brand.words_we_avoid.`,
    `Prefer a plain, useful post: what the service is for and when a homeowner might need it, the linked claim(s) in their exact words, and the call to action.`,
    `Return JSON only: {"copy": "...", "claim_ids": ["..."]}.`,
  ];
  if (revision) {
    lines.push(`Your previous draft was refused. Fix exactly these problems and change nothing the brief does not allow:`);
    for (const p of revision.problems) lines.push(`- ${p.code}: ${p.message}`);
  }
  return {
    instructions: lines.join("\n"),
    brief,
    output_contract: { copy: "string", claim_ids: "string[] (ids from brief.allowed_facts.claims only)" },
    ...(revision ? { revision } : {}),
  };
}
