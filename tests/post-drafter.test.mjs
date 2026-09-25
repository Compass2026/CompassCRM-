// AI Drafter v1, Deliverable 1: the governed brief and the deterministic
// linter (supabase/functions/post-drafter). Pure: no database, no model, no
// network. The fixture mirrors Lucas Construction's production records on
// Sept 25 2026 (claims, statuses and sources as stored).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief, briefHash } from "../supabase/functions/post-drafter/brief.ts";
import { lintDraft } from "../supabase/functions/post-drafter/lint.ts";
import { modelRequest } from "../supabase/functions/post-drafter/prompt.ts";

import { SITE, PAGE, ROOF, KW, OC, WARRANTY, FREE_QUOTES, REVIEWS, lucas, TARGET, GAZETTEER, GOOD } from "./fixtures/drafter-lucas.mjs";
const brief = (mut = (x) => x, target = TARGET) => buildBrief(mut(lucas()), target);
const okBrief = () => {
  const r = brief();
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  return r.brief;
};
const lint = (copy, claim_ids = [OC, WARRANTY]) => lintDraft(okBrief(), { copy, claim_ids }, { gazetteer: GAZETTEER });
const codes = (r) => r.problems.map((p) => p.code);
const refused = (copy, code, claim_ids) => {
  const r = lint(copy, claim_ids);
  assert.equal(r.ok, false, `expected ${code}: ${copy}`);
  assert.ok(codes(r).includes(code), `expected ${code}, got ${JSON.stringify(r.problems)}`);
};

// ── The Lucas pilot brief ────────────────────────────────────────────────────
test("Lucas Roof Replacement: an eligible brief with the right target, facts and exclusions", async () => {
  const b = okBrief();
  assert.equal(b.target.service.page_url, PAGE);
  assert.equal(b.target.service.page_group_id, "046dba3b-fae7-44d5-a1a8-887d30602d85");
  assert.deepEqual(b.target.keyword, { id: KW, text: "roof replacement wentzville", tracked: true, money: true, max_exact_uses: 1 });
  assert.deepEqual(b.target.cta, { type: "LEARN_MORE", url: PAGE, in_copy_phrase: "Request a quote" });
  assert.equal(b.target.offer, null);
  assert.deepEqual(b.target.assets, []);
  assert.deepEqual(b.allowed_facts.recommended_claim_ids, [WARRANTY, OC], "the two relevant claims, strongest first");
  assert.deepEqual(b.allowed_facts.crm.places, ["Wentzville"], "active locations only");
  const ex = new Map(b.excluded.claims.map((c) => [c.id, c.reason]));
  assert.match(ex.get(REVIEWS), /Reviews and ratings/);
  assert.match(ex.get(FREE_QUOTES), /unverified/);
  assert.match(ex.get("b73742bd-3d98-40f5-997f-846860397621"), /street address/);
  assert.match(ex.get("7c2a2d65-8242-4734-851d-fa3d6f58911e"), /confirmed/, "BBB 'since' date needs confirmation");
  assert.ok(b.excluded.facts.some((f) => /service area/i.test(f.fact)), "free-text service area excluded");
  assert.ok(b.excluded.facts.some((f) => /One local company/.test(f.fact)), "differentiator without a claim excluded as evidence");
  assert.equal(b.brand.differentiators_citable, false);
  assert.equal(b.brand.hard_rules.length, 6);
  assert.match(await briefHash(b), /^sha256:[0-9a-f]{64}$/);
  assert.equal(await briefHash(b), await briefHash(okBrief()), "hash is stable");
});

test("the per-draft gate ignores unrelated gaps (unlabelled keywords, missing photos)", () => {
  const r = brief((x) => ({ ...x, keywords: [...x.keywords, { id: "u1", keyword: "gutters", intent: null, intent_note: null, is_active: true, is_tracked: false, is_money: false, service_id: null, target_url: null, priority: null }], assets: [] }));
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
});

test("a well-grounded Lucas draft passes the linter", () => {
  const r = lint(GOOD);
  assert.deepEqual(r.problems, []);
  assert.equal(r.ok, true);
});

test("the model request is vendor-neutral and carries the whole brief", () => {
  const req = modelRequest(okBrief());
  assert.equal(req.brief.target.service.name, "Roof Replacement");
  assert.match(req.instructions, /Return JSON only/);
  assert.doesNotMatch(JSON.stringify(req), /claude|anthropic|openai|gpt|gemini|model_name|temperature/i);
});

// ── Brief refusals ───────────────────────────────────────────────────────────
test("refused: brand board not approved", () => {
  const r = brief((x) => ({ ...x, board: { ...x.board, status: "draft" } }));
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((f) => f.code === "brand_board_not_approved"));
});

test("refused: missing, off-site or unapproved target page", () => {
  for (const [mut, code] of [
    [(x) => ({ ...x, services: x.services.map((s) => (s.id === ROOF ? { ...s, page_url: null } : s)) }), "target_page_missing"],
    [(x) => ({ ...x, services: x.services.map((s) => (s.id === ROOF ? { ...s, page_url: "https://evil.example/roof" } : s)) }), "target_page_invalid"],
    [(x) => ({ ...x, services: x.services.map((s) => (s.id === ROOF ? { ...s, page_url: "http://lucasconstructionmo.com/services/roof-replacement" } : s)) }), "target_page_invalid"],
    [(x) => ({ ...x, pageGroups: [] }), "target_page_unapproved"],
    [(x) => ({ ...x, pageGroups: x.pageGroups.map((g) => ({ ...g, status: "draft" })) }), "target_page_unapproved"],
  ]) {
    const r = brief(mut);
    assert.equal(r.ok, false, code);
    assert.ok(r.refusals.some((f) => f.code === code), `${code}: ${JSON.stringify(r.refusals)}`);
  }
});

test("refused: an unapproved service, a mismatched keyword, an offer on a standard post, a button to another page", () => {
  const cases = [
    [{ ...TARGET, serviceId: "svc-draft", keywordId: null }, "service_not_approved"],
    [{ ...TARGET, keywordId: "kw-info" }, "keyword_intent_mismatch"],
    [{ ...TARGET, offerId: "o1" }, "offer_not_applicable"],
    [{ ...TARGET, ctaUrl: `${SITE}/contact` }, "cta_invalid"],
    [{ ...TARGET, channel: "facebook" }, "channel_unsupported"],
    [{ ...TARGET, serviceId: null, keywordId: null }, "service_missing"],
  ];
  for (const [t, code] of cases) {
    const r = brief(undefined, t);
    assert.equal(r.ok, false, code);
    assert.ok(r.refusals.some((f) => f.code === code), `${code}: ${JSON.stringify(r.refusals)}`);
  }
});

test("refused: a commercial draft with no relevant usable claim", () => {
  const r = brief((x) => ({ ...x, claims: x.claims.filter((c) => c.status === "unverified") }));
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((f) => f.code === "no_usable_claim"));
});

test("refused: an offer post without a confirmed current offer", () => {
  const r = brief((x) => ({ ...x, offers: [{ id: "o1", title: "Spring", terms: "10% off", source: "x", status: "draft", starts_on: null, ends_on: null, confirmed_by: null, confirmed_on: null, service_id: null }] }), { ...TARGET, postType: "offer", offerId: "o1", ctaType: null });
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((f) => f.code === "offer_not_current"));
});

// ── Lint refusals ────────────────────────────────────────────────────────────
test("refused: linking an unverified claim", () => {
  refused(GOOD, "claim_not_allowed", [OC, WARRANTY, FREE_QUOTES]);
  refused(GOOD, "claim_not_allowed", [OC, REVIEWS]);
});

test("refused: warranty or credential language not stated as a linked claim", () => {
  refused(GOOD.replace("our Lifetime Workmanship Warranty", "a lifetime warranty on materials"), "unsupported_credential");
  refused(GOOD, "unsupported_credential", [OC]); // warranty stated but its claim not linked
  refused(GOOD.replace("We're an Owens Corning Preferred Contractor, and", "Our certified crews are licensed and insured, and"), "unsupported_credential");
  refused(GOOD + " Our work is guaranteed.", "unsupported_credential");
});

test("refused: reviews and ratings", () => {
  refused(GOOD + " Rated 5 stars by over 100 homeowners.", "unsupported_review");
});

test("refused: a street address", () => {
  refused(GOOD + " Visit us at 12618 Veterans Memorial Pkwy.", "unsupported_address");
});

test("refused: pricing, free and discounts", () => {
  refused(GOOD.replace("request a quote", "request a free quote"), "unsupported_pricing");
  refused(GOOD + " Save 10% this month.", "unsupported_pricing");
  refused(GOOD + " Affordable prices for every budget.", "unsupported_pricing");
});

test("refused: a founding year or tenure", () => {
  refused(GOOD + " Serving families since 2018.", "unsupported_tenure");
  refused(GOOD + " We're family-owned.", "unsupported_tenure");
});

test("refused: a response-time promise", () => {
  refused(GOOD + " We're on site within 48 hours, 24/7.", "unsupported_response");
  refused(GOOD + " We can usually be out the same week.", "unsupported_response");
});

test("refused: an unapproved material", () => {
  refused(GOOD + " We also install cedar shake and slate roofs.", "unsupported_material");
});

test("refused: an unapproved location", () => {
  refused(GOOD.replace("your Wentzville home", "your O'Fallon home"), "unapproved_location");
  refused(GOOD + " Now serving St. Charles County.", "unapproved_location");
});

test("refused: a phone number other than the canonical one", () => {
  refused(GOOD + " Call (314) 555-0199.", "wrong_phone");
  assert.equal(lint(GOOD + " Call (636) 459-9328.").ok, true, "the canonical phone is allowed");
});

test("refused: keyword stuffing", () => {
  refused(GOOD + " Roof replacement Wentzville homeowners trust: roof replacement wentzville.", "keyword_stuffing");
});

test("refused: a URL in the body and a hashtag", () => {
  refused(GOOD + " Details at lucasconstructionmo.com/services.", "url_in_body");
  refused(GOOD + " #roofing", "hashtag");
});

test("refused: over-length and far over the Business Profile limit", () => {
  refused(GOOD + " " + "We keep you informed at every step of the job. ".repeat(12), "too_long");
  refused("x ".repeat(800) + GOOD, "channel_too_long");
});

test("refused: a brand differentiator stated as fact without its own claim", () => {
  refused(GOOD + " One local company from inspection and estimate to final sign-off.", "differentiator_as_fact");
});

test("refused: superlatives, stray numbers and words the brand avoids", () => {
  refused(GOOD + " The best roofer around.", "unsupported_superlative");
  refused(GOOD + " Over 300 roofs done.", "unsupported_number");
  refused(GOOD + " Not a storm chaser.", "word_to_avoid");
});

// ── Sept 25 decisions ────────────────────────────────────────────────────────
test("GBP length: 300 minimum, 450–700 preferred (a warning), 900 normal maximum, 1500 channel maximum", () => {
  const r = okBrief().channel_rules;
  assert.deepEqual([r.min_chars, r.preferred_min_chars, r.preferred_max_chars, r.max_chars, r.hard_max_chars], [300, 450, 700, 900, 1500]);
  const short = lint(GOOD); // ~400 characters: allowed, but outside the preferred range
  assert.equal(short.ok, true);
  assert.ok(short.warnings.some((w) => w.code === "length_outside_preferred"));
});

test("the model request forbids process detail, implied competence, broadened scope and differentiator paraphrase", () => {
  const { instructions } = modelRequest(okBrief());
  for (const needle of [/process steps/, /implied competence/, /"every", "all", "always"/, /promises inferred from brand wording/, /One local company from inspection and estimate to final sign-off/, /About 450–700|about 450–700/i, /plain "roof", "roofing"/]) {
    assert.match(instructions, needle);
  }
});

test("credentials stay faithful to the claim: no broadened warranty scope", () => {
  refused(GOOD.replace("backed by our Lifetime Workmanship Warranty", "covered for life"), "unsupported_credential");
  refused(GOOD.replace("our Lifetime Workmanship Warranty", "our lifelong guarantee"), "unsupported_credential");
});

test("materials: generic roof words are fine; specific materials and products need a linked claim", () => {
  assert.equal(lint(GOOD.replace("If your roof is showing its age", "If your roofing is showing its age")).ok, true);
  for (const add of [" We install asphalt roofs.", " Ask about metal.", " We use GAF Timberline products.", " Tamko and Malarkey lines available."]) {
    refused(GOOD + add, "unsupported_material");
  }
  const duration = "fa1d2070-c56c-4a75-a7ce-43effb6f0d21";
  assert.equal(lint(GOOD + " Installs Owens Corning Duration shingles.", [WARRANTY, duration]).problems.filter((p) => p.code === "unsupported_material").length, 0, "a linked claim naming the product allows it");
});

test("narrow false-positive exemptions: plain English passes, the category still fires", () => {
  const ok = [
    " Feel free to ask questions.",
    " Fall is the best time to plan a roof replacement.",
    " Small leaks can end up leading to bigger repairs.",
    " Think about the lifetime of your roof.",
    " Pick your preferred time for a visit.",
    " We help you deal with the next steps.",
    " It can save time later.",
    " We'll review what we see with you.",
    " Since the last storm, many roofs need attention.",
    " Have a great Independence Day.",
  ];
  for (const add of ok) {
    const r = lint(GOOD + add);
    assert.deepEqual(r.problems, [], add);
  }
  refused(GOOD + " Ask for a free estimate.", "unsupported_pricing");
  refused(GOOD + " The best roofer in town.", "unsupported_superlative");
  refused(GOOD + " A leading roofer.", "unsupported_superlative");
  refused(GOOD + " Read our reviews.", "unsupported_review");
  refused(GOOD + " Serving homes since day one.", "unsupported_tenure");
  refused(GOOD + " We're on site within the hour.", "unsupported_response");
  refused(GOOD + " Now serving homes in Liberty.", "unapproved_location");
  refused(GOOD + " Visit our office address downtown.", "unsupported_address");
});

// ── Diagnostic language (Sept 25 2026 decision): consider, never diagnose ──
test("refused: telling the reader what their home needs", () => {
  const lead = "Thinking about a roof replacement for your Wentzville home? ";
  const tail = " We're an Owens Corning Preferred Contractor, and every roof replacement we complete is backed by our Lifetime Workmanship Warranty. Request a quote.";
  for (const phrase of [
    "When patching no longer makes sense, Lucas Construction can help.",
    "If your roof is beyond repair, Lucas Construction can help.",
    "An older roof needs to be replaced before it leaks.",
    "An older roof requires to be replaced.",
    "Hail-damaged shingles must be replaced.",
    "It's time to replace your roof.",
    "Your home needs a new roof.",
    "This damage requires replacement.",
    "Your roof needs replacing.",
    "An aging roof calls for a full replacement.",
  ]) {
    const r = lint(lead + phrase + tail);
    assert.ok(codes(r).includes("unsupported_diagnosis"), `${phrase} → ${JSON.stringify(codes(r))}`);
    assert.match(r.problems.find((p) => p.code === "unsupported_diagnosis").message, /only an inspection can/);
  }
});

test("allowed: inviting consideration", () => {
  const tail = " Lucas Construction is an Owens Corning Preferred Contractor, and every roof replacement we complete is backed by our Lifetime Workmanship Warranty. Request a quote.";
  for (const phrase of [
    "If you're considering a roof replacement for your Wentzville home, we can walk you through it.",
    "If you're starting to think about replacing an aging roof, we can walk you through it.",
    "Learn more about whether roof replacement may fit your home.",
  ]) {
    const r = lint(phrase + tail);
    assert.ok(!codes(r).includes("unsupported_diagnosis"), `${phrase} → ${JSON.stringify(r.problems)}`);
  }
  assert.ok(!codes(lint(GOOD)).includes("unsupported_diagnosis"), "the reviewed Lucas copy stays clean");
});

test("the model request says to invite consideration, never diagnose", () => {
  const text = modelRequest(okBrief()).instructions;
  assert.match(text, /Never diagnose the reader's home/);
  assert.match(text, /Learn more about whether roof replacement may fit your home/);
});
