// Authority Engine v1 (D1): the deterministic map and opportunity engine over
// a Lucas-shaped fixture, then one failure case at a time. Pure: no network,
// no database, no model.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAuthority } from "../supabase/functions/authority/engine.ts";
import { renderMarkdown } from "../supabase/functions/authority/report.ts";
import { ACTIONS } from "../supabase/functions/authority/types.ts";
import { GBP_CADENCE_DAYS } from "../supabase/functions/authority/coverage.ts";
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
  assert.equal(opp(r, "confirm_markets:service-areas").action, "requires_confirmation");
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
