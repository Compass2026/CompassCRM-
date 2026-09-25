// Authority Engine v1 (D1): the deterministic map and opportunity engine over
// a Lucas-shaped fixture, then one failure case at a time. Pure: no network,
// no database, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAuthority } from "../supabase/functions/authority/engine.ts";
import { renderMarkdown } from "../supabase/functions/authority/report.ts";
import { ACTIONS } from "../supabase/functions/authority/types.ts";
import { GBP_CADENCE_DAYS } from "../supabase/functions/authority/coverage.ts";
import { assessIntent } from "../supabase/functions/authority/intent.ts";
import { buildPlaceIndex } from "../supabase/functions/authority/urls.ts";
import { prioritize, demandBucket, actionForRefusals } from "../supabase/functions/authority/opportunities.ts";
import { lucasAuthority, page, ROOF, REPAIR, STORM, SITE, APPROVED_POST, REJECTED_POST } from "./fixtures/authority-lucas.mjs";

const run = (mut) => { const i = lucasAuthority(); mut?.(i); return runAuthority(i); };
const pillar = (r, name) => r.pillars.find((p) => p.name === name);
const opp = (r, id) => r.opportunities.find((o) => o.id === id);
const conflicts = (r, kind) => r.conflicts.filter((c) => c.kind === kind);
const kwd = (r, keyword) => r.keywords.find((k) => k.keyword === keyword);
const text = (reasons) => reasons.map((x) => x.text).join("\n");

test("Lucas: the authority map rediscovers every known finding", () => {
  const r = run();
  // owner page title / H1 location + unsupported credential wording
  const rr = pillar(r, "Roof Replacement");
  assert.equal(rr.owner.path, "/services/roof-replacement");
  assert.equal(rr.owner.state, "live");
  assert.match(text(rr.page_issues), /title .* names Saint Louis|title .* names St\. Louis/i);
  assert.match(text(rr.page_issues), /H1 "Expert Roof Replacement in St\. Louis\." names/);
  assert.match(text(rr.page_issues), /"Expert" \(credential\)/);
  assert.match(text(rr.page_issues), /"Certified" \(credential\)/);
  assert.doesNotMatch(text(rr.page_issues), /Owens Corning Preferred Contractor/, "a usable claim's own text is not flagged");
  // broken Roof Repair page and its redirect into Roof Replacement
  const rp = pillar(r, "Roof Repair");
  assert.equal(rp.owner.state, "missing");
  assert.equal(rp.owner.conflict, true);
  assert.match(text(rp.owner.reasons), /redirects to \/services\/roof-replacement/);
  assert.match(text(rp.owner.reasons), /Roof Repair has no page of its own/);
  // missing Storm Damage page, with its unmerged proposal
  const st = pillar(r, "Storm Damage & Insurance Claims");
  assert.equal(st.owner.state, "missing");
  assert.equal(st.owner.pending_proposal, true);
  // polluted Roof Replacement keywords
  assert.equal(kwd(r, "roofer in wentzville mo").role, "homepage_pollution");
  assert.ok(conflicts(r, "keyword_pollution").some((c) => c.subject === "Roof Replacement"));
  // unapproved city pages: coverage, not authorisation
  const loc = conflicts(r, "unapproved_location_pages")[0];
  assert.match(text(loc.reasons), /ofallon, troy/);
  const byKey = (k) => r.opportunities.find((o) => o.key === k);
  assert.equal(byKey("confirm_market:ofallon").action, "requires_confirmation");
  assert.equal(byKey("confirm_market:ofallon").target.location, "O'Fallon");
  assert.equal(byKey("confirm_market:troy").action, "requires_confirmation");
  assert.ok(!r.opportunities.some((o) => o.key === "confirm_market:wentzville"), "the approved market needs no decision");
  // existing Business Profile coverage
  assert.ok(rr.coverage.some((c) => c.kind === "gbp_post" && c.ref === APPROVED_POST));
  // overlapping blogs
  assert.equal(opp(r, "topic:choosing_contractor").action, "consolidate");
  assert.ok(conflicts(r, "blog_overlap")[0].reasons.some((x) => /compete for the same queries/.test(x.text)));
  // commercial roofing needs confirmation
  assert.equal(opp(r, "confirm_service:services-commercial-roofing").action, "requires_confirmation");
  // research-required topics
  assert.equal(opp(r, "topic:signs_replacement").action, "research_required");
  assert.equal(opp(r, "topic:repair_vs_replacement").action, "research_required");
  // the home page's own wording
  assert.match(text(conflicts(r, "home_page_wording")[0].reasons), /"Premier" \(superlative\)/);
});

test("vocabulary, determinism and purity", () => {
  const i = lucasAuthority();
  const before = JSON.stringify(i);
  const a = runAuthority(i), b = runAuthority(lucasAuthority());
  assert.equal(JSON.stringify(i), before, "the input is not mutated");
  assert.deepEqual(a, b, "same input, same report");
  for (const o of a.opportunities) {
    assert.ok(ACTIONS.includes(o.action), o.action);
    assert.ok(["A", "B", "C", "none"].includes(o.tier));
    assert.ok(o.reasons.length > 0, `${o.id} has reasons`);
    for (const t of ["FACT", "HEURISTIC", "RESEARCH_REQUIRED", "REQUIRES_CONFIRMATION"]) assert.ok(Array.isArray(o.provenance[t]));
  }
  // tiers are sorted A → none
  const rank = { A: 0, B: 1, C: 2, none: 3 };
  a.opportunities.reduce((prev, o) => { assert.ok(rank[o.tier] >= prev); return rank[o.tier]; }, 0);
  const md = renderMarkdown(a);
  for (const tag of ["[FACT]", "[HEURISTIC]", "[RESEARCH REQUIRED]", "[REQUIRES CONFIRMATION]"]) assert.ok(md.includes(tag), tag);
});

test("GSC reads the latest window only and maps old URLs through redirects", () => {
  const r = run();
  const rr = pillar(r, "Roof Replacement");
  assert.equal(rr.gsc.window, "2026-08-25..2026-09-21");
  assert.equal(rr.gsc.impressions, 120 + 90 + 40, "the older overlapping window is not summed");
  const rp = pillar(r, "Roof Repair");
  assert.ok(rp.gsc.landing_pages.some((l) => l.path === "/services/roof-replacement"), "/roofing-repairs/ maps to where it lands");
});

test("broken owner: a 404 owner page becomes a tier-A create", () => {
  const r = run((i) => {
    i.authority.inventory.pages = i.authority.inventory.pages.map((p) => p.url.endsWith("/services/roof-replacement") ? page("/services/roof-replacement", { status: 404, final_status: 404 }) : p);
    i.authority.inventory.pages = i.authority.inventory.pages.filter((p) => !p.url.endsWith("/roofing-repairs/"));
  });
  const rr = pillar(r, "Roof Replacement");
  assert.equal(rr.owner.state, "missing");
  const o = opp(r, "service_page:roof-replacement");
  assert.equal(o.action, "create");
  assert.equal(o.tier, "A");
  assert.ok(!r.opportunities.some((x) => x.id.startsWith("gbp_post:roof-replacement")), "no Business Profile post without a live owner");
});

test("redirect loop: an owner that never settles is not live", () => {
  const r = run((i) => {
    i.authority.inventory.pages = i.authority.inventory.pages.map((p) => p.url.endsWith("/services/storm-damage") ? { ...p, status: 308, final_url: null, final_status: null, redirect_loop: true } : p);
  });
  assert.equal(pillar(r, "Storm Damage & Insurance Claims").owner.state, "redirect_loop");
});

test("conflicting owners: candidates that land on different live pages", () => {
  const r = run((i) => {
    i.services.find((s) => s.id === ROOF).page_url = `${SITE}/services/commercial-roofing`;
  });
  const rr = pillar(r, "Roof Replacement");
  assert.equal(rr.owner.conflict, true);
  assert.equal(rr.owner.path, "/services/roof-replacement", "the page group's live target stays the owner");
  assert.ok(conflicts(r, "owner_conflict").some((c) => c.subject === "Roof Replacement"));
  assert.ok(opp(r, "data_fix:service-page:roof-replacement"), "the service record must be fixed");
});

test("homepage keyword pollution: a data fix, never a content target", () => {
  const r = run();
  const k = kwd(r, "roofer in wentzville mo");
  assert.ok(k.flags.includes("homepage_pollution"));
  const o = opp(r, "data_fix:keyword-ownership:roof-replacement");
  assert.equal(o.content_type, "data_fix");
  assert.match(text(o.reasons), /roofer in wentzville mo/);
  for (const g of r.opportunities.filter((x) => x.content_type === "gbp_post")) assert.notEqual(g.target.keyword, "roofer in wentzville mo");
});

test("unapproved location: flagged until the market is approved", () => {
  let r = run();
  assert.equal(kwd(r, "roofer in o'fallon mo").role, "location_unapproved");
  r = run((i) => i.locations.push({ name: "O'Fallon, MO", city: "O'Fallon", state: "MO", is_active: true }));
  assert.ok(!kwd(r, "roofer in o'fallon mo").flags.includes("location_unapproved"));
  assert.doesNotMatch(text(conflicts(r, "unapproved_location_pages")[0].reasons), /ofallon/);
});

test("unsupported material: needs a usable claim naming it", () => {
  let r = run();
  assert.equal(kwd(r, "asphalt shingle roofing wentzville").role, "material_unsupported");
  assert.equal(opp(r, "evidence:unsupported-materials").action, "insufficient_evidence");
  r = run((i) => i.claims.push({ id: "c-asphalt", claim: "Installs asphalt shingle roofs", status: "confirmed", source: null }));
  assert.equal(kwd(r, "asphalt shingle roofing wentzville").role, "material_supported");
});

test("unsupported service: a draft service gets no pillar and no opportunity", () => {
  const r = run();
  assert.ok(!r.pillars.some((p) => p.service_id === "svc-draft"));
  assert.ok(!r.opportunities.some((o) => o.service_id === "svc-draft"));
});

test("recent duplicate Business Profile post: cadence defers, an open post avoids, a rejection does not count", () => {
  let r = run();
  const c = opp(r, "gbp_post:roof-replacement:commercial");
  assert.equal(c.eligible_from, "2026-10-16", `${GBP_CADENCE_DAYS} days after the approved post`);
  assert.equal(c.gates.find((g) => g.gate === "cadence").pass, false);
  assert.equal(c.tier, "B");
  assert.equal(opp(r, "gbp_post:roof-replacement:transactional").gates.find((g) => g.gate === "cadence").pass, true, "another intent may go sooner");
  r = run((i) => { i.authority.socialPosts = i.authority.socialPosts.filter((p) => p.id === REJECTED_POST); });
  assert.equal(opp(r, "gbp_post:roof-replacement:commercial").gates.find((g) => g.gate === "cadence").pass, true);
  r = run((i) => { i.authority.socialPosts[0].review_status = "in_review"; });
  const open = opp(r, "gbp_post:roof-replacement:commercial");
  assert.equal(open.action, "avoid");
  assert.equal(open.tier, "none");
});

test("overlapping blogs: consolidate with the shared queries", () => {
  const r = run();
  const o = conflicts(r, "blog_overlap")[0];
  assert.equal(o.subject, "Choosing a roofing contractor");
  assert.match(text(o.reasons), /wentzville roofing/);
  assert.ok(conflicts(r, "blog_wording").some((c) => /out-of-town/.test(text(c.reasons))));
  assert.ok(conflicts(r, "coverage_blind_spot").length === 1, "live blogs missing from content_posts");
});

test("ranking differs from owner", () => {
  const r = run();
  const c = conflicts(r, "ranking_differs_from_owner").find((x) => x.subject === "Roof Replacement");
  assert.match(text(c.reasons), /ranks with \/ \(organic 4/);
  assert.ok(conflicts(r, "owner_not_earning").some((x) => x.subject === "Roof Replacement"));
  // a map-pack result alone is the Business Profile link, not a page choice
  const r2 = run((i) => { i.authority.ranks = i.authority.ranks.filter((x) => x.result_type === "map_pack"); });
  assert.ok(!conflicts(r2, "ranking_differs_from_owner").some((x) => x.subject === "Roof Replacement"));
});

test("insufficient evidence: no relevant usable claim → no create", () => {
  const r = run((i) => { i.claims = i.claims.filter((c) => !/storm|owens corning/i.test(c.claim)); });
  const o = opp(r, "service_page:storm-damage-insurance-claims");
  assert.equal(o.action, "insufficient_evidence");
  assert.equal(o.tier, "none");
  assert.equal(opp(r, "topic:warranty_terms").action, "insufficient_evidence");
  assert.equal(opp(run(), "service_page:storm-damage-insurance-claims").action, "create");
});

test("research-required topic: becomes avoid once a live post covers it", () => {
  assert.equal(opp(run(), "topic:signs_replacement").action, "research_required");
  const r = run((i) => i.authority.inventory.pages.push(page("/blog/5-signs-you-need-a-new-roof", { title: "5 Signs You Need a New Roof" })));
  assert.equal(opp(r, "topic:signs_replacement").action, "avoid");
  assert.equal(opp(run(), "topic:cost").action, "avoid", "a pricing topic is always avoided");
});

test("service requiring confirmation: keywords and claims stay unassigned", () => {
  const r = run();
  const k = kwd(r, "commercial roofing company wentzville");
  assert.equal(k.role, "requires_confirmation");
  const o = opp(r, "confirm_service:services-commercial-roofing");
  assert.equal(o.tier, "none");
  assert.deepEqual(o.evidence_claim_ids, []);
  assert.match(text(o.reasons), /commercial roofing wentzville \(6\)/);
  for (const g of r.opportunities.filter((x) => x.content_type === "gbp_post")) assert.notEqual(g.target.keyword, k.keyword);
  assert.ok(!r.pillars.some((p) => /commercial/i.test(p.name)), "no service is created");
});

test("Business Profile opportunities pass through the drafter's own brief", () => {
  const r = run();
  const t = opp(r, "gbp_post:roof-replacement:transactional");
  assert.equal(t.gates.find((g) => g.gate === "drafter_brief").pass, true);
  assert.ok(t.evidence_claim_ids.length > 0);
  // Missing owner → no Business Profile post for Roof Repair or Storm
  assert.ok(!r.opportunities.some((o) => o.content_type === "gbp_post" && (o.service_id === REPAIR || o.service_id === STORM)));
  assert.equal(t.target.keyword, "new roof installation wentzville");
});

// ── Refinement 1: intent sanity ────────────────────────────────────────────

const PLACES = buildPlaceIndex(["Wentzville", "O'Fallon", "Saint Charles", "Lucas"], ["Wentzville"], ["Lucas Construction", "Lucas"]);
const assess = (q, stored) => assessIntent(q, stored, { clientName: "Lucas Construction", places: PLACES });

test("intent sanity: service-discovery queries stored as navigational conflict", () => {
  for (const q of ["roof repair wentzville mo", "roof inspection wentzville mo", "vinyl siding installation wentzville mo", "seamless gutters wentzville mo"]) {
    const r = assess(q, "navigational");
    assert.equal(r.stored, "navigational", "the stored value is preserved");
    assert.equal(r.assessed, "commercial_or_transactional", q);
    assert.equal(r.conflict, true, q);
    assert.match(r.reason, /Stored as navigational/);
  }
});

test("intent sanity: conservative patterns, ambiguity left to judgment", () => {
  assert.deepEqual([assess("lucas construction", "navigational").assessed, assess("lucas construction", "navigational").conflict], ["navigational", false]);
  assert.equal(assess("lucas construction", "commercial").conflict, true, "a pure brand query stored as commercial");
  assert.equal(assess("roofer near me", "informational").conflict, true, "near me is strong buyer wording");
  assert.equal(assess("get a roofing quote wentzville", "transactional").conflict, false);
  assert.equal(assess("how long does a roof last", "informational").assessed, "informational");
  assert.equal(assess("how much does a new roof cost in wentzville", "commercial").conflict, false, "commercial research phrased as a question is not a conflict");
  assert.equal(assess("how long does a roof last", "transactional").conflict, true);
  const brandService = assess("lucas construction gutter services", "commercial");
  assert.equal(brandService.assessed, "ambiguous");
  assert.equal(brandService.conflict, false);
  assert.equal(assess("trimlight", null).assessed, "ambiguous");
  assert.equal(assess("roof repair wentzville mo", null).conflict, false, "no stored intent, nothing to contradict");
});

test("intent sanity in the engine: flagged, kept, excluded from post targets, never rewritten", () => {
  const i = lucasAuthority();
  const r = runAuthority(i);
  const k = kwd(r, "roof repair wentzville mo");
  assert.ok(k.flags.includes("intent_conflict"));
  assert.equal(k.intent, "navigational", "stored intent reported as is");
  assert.equal(k.role, "primary", "the flag never changes the role");
  assert.equal(i.keywords.find((x) => x.keyword === "roof repair wentzville mo").intent, "navigational", "input untouched");
  assert.equal(conflicts(r, "intent_conflict").length, 1);
  const d = r.opportunities.find((o) => o.key === "confirm_intent:kw-repair");
  assert.equal(d.action, "requires_confirmation");
  assert.equal(d.section, "needs_decision");
  assert.equal(d.target.intent, "navigational", "the stored intent, not the assessment");
  // a conflicted keyword is never picked as a Business Profile target
  const r2 = run((x) => { x.keywords.find((y) => y.id === "kw-trans").keyword = "lucas construction"; });
  assert.ok(!r2.opportunities.some((o) => o.content_type === "gbp_post" && o.target.keyword === "lucas construction"));
  assert.ok(!r2.opportunities.some((o) => o.id === "gbp_post:roof-replacement:transactional"), "no other clean transactional keyword");
});

// ── Refinement 2: demand tiebreaker within a tier ──────────────────────────
test("ordering: demand breaks ties after value and severity, never before", () => {
  assert.deepEqual([0, 2, 9, 10, 99, 100, 2577].map(demandBucket), [0, 1, 1, 2, 2, 3, 4]);
  const d = (id, value, severity, impressions) => ({
    id, topic: id, service_id: null, action: "improve", content_type: "page_improvement", gap: "", target: {},
    evidence_claim_ids: id === "low" ? ["a", "b", "c"] : [], existing_coverage: [], blockers: [], gates: [], eligible_from: null,
    reasons: [{ tag: "FACT", text: id }], value, severity, impressions, deferred: false,
  });
  let o = prioritize([d("low", 3, 3, 2), d("sitewide", 3, 3, 2577)]);
  assert.deepEqual(o.map((x) => x.id), ["sitewide", "low"], "high demand outranks low demand at equal severity, despite less evidence");
  o = prioritize([d("sitewide", 3, 3, 2577), d("broken", 3, 4, 0)]);
  assert.deepEqual(o.map((x) => x.id), ["broken", "sitewide"], "severity still wins");
  o = prioritize([d("sitewide", 2, 3, 2577), d("money", 3, 3, 0)]);
  assert.equal(o[0].id, "money", "business value still wins");
});

// ── Refinement 3: blocked data prerequisite ────────────────────────────────
test("blocked data prerequisite: a live owner the service record does not name", () => {
  const r = run((i) => { i.services.find((s) => s.id === ROOF).page_url = null; });
  const g = opp(r, "gbp_post:roof-replacement:transactional");
  assert.equal(g.action, "blocked_data_prerequisite");
  assert.notEqual(g.action, "insufficient_evidence");
  assert.equal(g.tier, "none");
  assert.equal(g.gates.find((x) => x.gate === "data_prerequisite").pass, false);
  assert.match(g.blockers.join(" "), /data_fix:service-page:roof-replacement/);
  assert.ok(opp(r, "data_fix:service-page:roof-replacement"), "the reconciling fix is itself an opportunity");
});

test("drafter refusals map to the right non-content action", () => {
  assert.equal(actionForRefusals(["no_usable_claim"]), "insufficient_evidence");
  assert.equal(actionForRefusals(["target_page_missing"]), "blocked_data_prerequisite");
  assert.equal(actionForRefusals(["keyword_wrong_page", "target_page_unapproved"]), "blocked_data_prerequisite");
  assert.equal(actionForRefusals(["brand_board_not_approved", "no_usable_claim"]), "requires_confirmation");
  assert.equal(actionForRefusals(["target_page_missing", "no_usable_claim"]), "insufficient_evidence");
});

// ── D1.1: identity, sections, decision granularity, objectives, sources ────
test("keys are ID-based, unique, and survive renaming a service", () => {
  const r = run();
  const keys = r.opportunities.map((o) => o.key);
  assert.equal(new Set(keys).size, keys.length, "unique within a run");
  for (const k of keys) assert.match(k, /^[a-z_]+:[A-Za-z0-9_:\/.-]+$/, k);
  assert.ok(keys.includes(`gbp_post:${ROOF}:transactional`));
  assert.ok(keys.includes(`service_page:${REPAIR}`));
  const renamed = run((i) => {
    i.services.find((s) => s.id === ROOF).name = "Full Roof Replacement";
    i.authority.pageGroupsFull.find((g) => g.name === "Roof Replacement").name = "Full Roof Replacement";
    i.pageGroups.find((g) => g.name === "Roof Replacement").name = "Full Roof Replacement";
  });
  const before = new Set(r.opportunities.filter((o) => o.service_id === ROOF).map((o) => o.key));
  const after = new Set(renamed.opportunities.filter((o) => o.service_id === ROOF).map((o) => o.key));
  assert.deepEqual([...after].sort(), [...before].sort(), "same keys after the rename");
  assert.notDeepEqual(renamed.opportunities.filter((o) => o.service_id === ROOF).map((o) => o.id).sort(), r.opportunities.filter((o) => o.service_id === ROOF).map((o) => o.id).sort(), "only the readable id changed");
});

test("sections follow the action and content type", () => {
  const r = run();
  const sec = (key) => r.opportunities.find((o) => o.key === key).section;
  assert.equal(sec(`service_page:${REPAIR}`), "fix_now");
  assert.equal(sec("page_improvement:home"), "fix_now");
  assert.equal(sec(`gbp_post:${ROOF}:transactional`), "ready");
  assert.equal(sec(`gbp_post:${ROOF}:commercial`), "ready", "cadence-deferred is still ready, with eligible_from");
  assert.equal(sec("confirm_market:ofallon"), "needs_decision");
  assert.equal(sec("topic:signs_replacement"), "research");
  assert.equal(sec("evidence:unsupported-materials"), "blocked");
  assert.equal(sec("topic:cost"), "avoid");
  const r2 = run((i) => { i.services.find((s) => s.id === ROOF).page_url = null; });
  assert.equal(r2.opportunities.find((o) => o.key === `gbp_post:${ROOF}:transactional`).section, "blocked");
});

test("objectives are fixed templates, present only where they apply", () => {
  const r = run();
  const obj = (key) => r.opportunities.find((o) => o.key === key).objective;
  assert.match(obj(`gbp_post:${ROOF}:transactional`), /^Prompt people ready to act to request roof replacement and send them to \/services\/roof-replacement\.$/);
  assert.match(obj(`service_page:${REPAIR}`), /Give Roof Repair its own live page/);
  assert.equal(obj("confirm_market:ofallon"), null);
  assert.equal(obj("topic:signs_replacement"), null);
});

test("decision granularity only: the ranked opportunities are unchanged", () => {
  const r = run();
  const ranked = r.opportunities.filter((o) => o.tier !== "none").map((o) => o.key);
  assert.ok(ranked.length > 0);
  for (const o of r.opportunities.filter((x) => x.key.startsWith("confirm_"))) assert.equal(o.tier, "none");
});

test("Search Console coverage: partial at the gsc-sync row cap, complete below, unknown with none", () => {
  assert.equal(run().sources.gsc.coverage, "complete");
  const capped = run((i) => {
    const w = ["2026-08-25", "2026-09-21"];
    i.authority.gsc = Array.from({ length: 250 }, (_, n) => ({ query: `q${n}`, page: `${SITE}/`, impressions: 1, clicks: 0, avg_position: 9, period_start: w[0], period_end: w[1], keyword_id: null }));
  });
  assert.equal(capped.sources.gsc.coverage, "partial");
  assert.equal(capped.sources.gsc.row_cap, 250);
  assert.ok(capped.judgments.some((j) => /coverage is partial/.test(j)));
  assert.match(renderMarkdown(capped), /coverage \*\*partial\*\*/);
  assert.equal(run((i) => { i.authority.gsc = []; }).sources.gsc.coverage, "unknown");
  // After gsc-sync paging: a large window below the cap is complete; one at the cap is partial.
  const win = (n) => (i) => { i.authority.gsc = Array.from({ length: n }, (_, k) => ({ query: `q${k}`, page: `${SITE}/`, impressions: 1, clicks: 0, avg_position: 9, period_start: "2026-08-26", period_end: "2026-09-22", keyword_id: null })); };
  assert.equal(run(win(800)).sources.gsc.coverage, "complete", "a paged window below the cap");
  const atCap = run(win(10000));
  assert.equal(atCap.sources.gsc.coverage, "partial", "the safety cap reached");
  assert.equal(atCap.sources.gsc.row_cap, 10000);
});

test("inventory: only the site's own host, loops detected, off-site redirects recorded not followed", async () => {
  const { inventorySite, allowedUrl } = await import("../supabase/functions/authority/inventory.ts");
  assert.equal(allowedUrl("https://www.lucasconstructionmo.com/a", SITE), true);
  for (const bad of ["https://evil.test/", "http://127.0.0.1/", "https://localhost/", "https://user:pw@lucasconstructionmo.com/", "https://lucasconstructionmo.com:8443/", "ftp://lucasconstructionmo.com/"]) {
    assert.equal(allowedUrl(bad, SITE), false, bad);
  }
  const hits = [];
  const routes = {
    "/sitemap.xml": [200, `<urlset><url><loc>${SITE}/a</loc></url><url><loc>https://evil.test/x</loc></url></urlset>`],
    "/": [200, "<title>Home</title><h1>Hi</h1>"],
    "/a": [200, "<title>A</title><h2>One</h2>"],
    "/loop": [308, null, "/loop2"], "/loop2": [308, null, "/loop"],
    "/off": [301, null, "https://evil.test/landing"],
  };
  const fake = async (url) => {
    hits.push(url);
    const u = new URL(url);
    const [status, body, loc] = routes[u.pathname] ?? [404, ""];
    return { status, headers: { get: (h) => (h === "location" ? loc ?? null : null) }, text: async () => body ?? "" };
  };
  const inv = await inventorySite({ site: SITE, candidates: [`${SITE}/loop`, `${SITE}/off`, "https://evil.test/y"], fetch: fake, now: () => "T" });
  const by = (p) => inv.pages.find((x) => x.url === `${SITE}${p}`);
  assert.equal(by("/a").title, "A");
  assert.equal(by("/loop").redirect_loop, true);
  assert.equal(by("/off").final_url, "https://evil.test/landing");
  assert.ok(!hits.some((h) => h.includes("evil.test")), "never requested another host");
  assert.ok(inv.pages.every((p) => allowedUrl(p.url, SITE)));
});
