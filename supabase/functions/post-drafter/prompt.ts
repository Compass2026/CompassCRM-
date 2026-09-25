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
    `${brief.channel_rules.min_chars}–${brief.channel_rules.max_chars} characters, plain text, no hashtags, no links, no emoji. Make the point in the first ${brief.channel_rules.lead_chars} characters.`,
    t.cta.type
      ? `The post's button is ${t.cta.type}${t.cta.url ? ` to ${t.cta.url}` : ""}; the text may close with the brand's call to action${t.cta.in_copy_phrase ? ` ("${t.cta.in_copy_phrase}")` : ""}.`
      : `No button.`,
    `Facts: say only what brief.allowed_facts contains. State a claim only in its exact words, and link it in claim_ids. Use the fewest claims that make the post useful (at most ${brief.allowed_facts.max_claims}; prefer ${brief.allowed_facts.recommended_claim_ids.length ? "the recommended ones" : "none"}).`,
    `Places: only ${brief.allowed_facts.crm.places.join(", ") || "none"}.`,
    `Never: prices, discounts or "free"; years, tenure or "since"; response times; reviews, ratings or stars; street addresses; any other phone number; materials no linked claim names; superlatives; numbers outside the phone; anything in brief.excluded; a brand differentiator stated as fact.`,
    `Follow every hard rule in brief.brand.hard_rules and brief.brand.ai_guidance. Avoid brief.brand.words_we_avoid.`,
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
