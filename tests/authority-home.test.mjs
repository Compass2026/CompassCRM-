// Home ownership (C3): the approved Home page group governs broad brand /
// category keywords; service-specific queries stay with their service; Home-like
// queries another governed page claims are a decision; arbitrary unmapped
// keywords never become Home's. Over the trimmed Lucas production export
// (tests/fixtures/authority-lucas-home.json). Pure: no network, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runAuthority } from "../supabase/functions/authority/engine.ts";
import { root } from "../supabase/functions/authority/home.ts";
import { lucasHomeInput, LUCAS_HOME } from "./helpers/lucas-home-input.mjs";

const run = (mut) => runAuthority(lucasHomeInput(mut));
const kw = (r, text) => r.keywords.find((k) => k.keyword === text);
const byText = (i, text) => i.keywords.find((k) => k.keyword === text);
const home = (i) => i.authority.pageGroupsFull.find((g) => g.page_type === "home");
const opp = (r, key) => r.opportunities.find((o) => o.key === key);
const flagged = (r, f) => r.keywords.filter((k) => k.flags.includes(f)).map((k) => k.keyword).sort();
const SITE = LUCAS_HOME.site.url;
const ROOF = LUCAS_HOME.services.find((s) => s.name === "Roof Replacement").id;

const HOME_14 = [
  "affordable roofer wentzville", "best roofer near me", "best roofing company wentzville", "licensed roofing contractor wentzville",
  "local roofer near me", "local roofing contractor wentzville", "lucas construction roofing reviews", "lucas construction roofing wentzville",
  "residential roofer wentzville", "roofer near me", "roofing company in wentzville mo", "roofing contractor near wentzville",
  "top rated roofer in wentzville", "trusted roofer near me",
];
const SERVICE_3 = ["lucas construction gutter services", "lucas construction roof repair", "lucas construction storm damage repair"];

test("9. Lucas: 14 home_eligible, 1 home_ambiguous, 3 service-specific; nothing written", () => {
  const r = run();
  assert.deepEqual(flagged(r, "home_eligible"), HOME_14);
  assert.deepEqual(flagged(r, "home_ambiguous"), ["roofer in wentzville mo"]);
  const polluted = flagged(r, "homepage_pollution");
  assert.equal(polluted.length, 18);
  assert.deepEqual(polluted.filter((k) => !HOME_14.includes(k) && k !== "roofer in wentzville mo"), SERVICE_3);
  for (const t of SERVICE_3) assert.equal(kw(r, t).home_check.fit, "service", t);
  assert.equal(r.home.valid, true);
  assert.deepEqual([r.home.path, r.home.state, r.home.category, r.home.eligible, r.home.ambiguous, r.home.owned], ["/", "live", ["roof"], 14, 1, 0]);
  // Every one is still mapped to its service in the CRM: roles do not change until a person re-homes it.
  for (const t of [...HOME_14, "roofer in wentzville mo"]) assert.equal(kw(r, t).service_id, ROOF, t);
  assert.equal(r.keywords.filter((k) => k.role === "unmapped").length, 26);
  assert.equal(r.version, "authority-v1.2");
});

test("9b. Lucas: the Roof Replacement ownership fix is split by destination", () => {
  const r = run();
  const o = opp(r, `data_fix:keyword-ownership:${ROOF}`);
  assert.match(o.gap, /15 keywords under Roof Replacement target the home page: 14 to Home, 0 to Roof Replacement, 1 to decide/);
  assert.ok(o.reasons.some((x) => x.text.startsWith("To the Home page group (14):")));
  assert.ok(o.reasons.some((x) => x.tag === "REQUIRES_CONFIRMATION" && /roofer in wentzville mo/.test(x.text)));
  assert.deepEqual(o.gates.find((g) => g.gate === "home_destination"), { gate: "home_destination", pass: true, detail: "The Home page group targets /, live." });
  assert.equal(o.tier, "A");
  const gutters = r.opportunities.find((x) => x.key.startsWith("data_fix:keyword-ownership:") && x.topic === "Gutter Installation & Repair");
  assert.match(gutters.reasons.map((x) => x.text).join(" "), /To Gutter Installation & Repair's page \/services\/gutters \(1\): lucas construction gutter services/);
  const repair = r.opportunities.find((x) => x.key.startsWith("data_fix:keyword-ownership:") && x.topic === "Roof Repair");
  assert.match(repair.reasons.map((x) => x.text).join(" "), /not live yet .*lucas construction roof repair/);
});

test("6. Lucas: the Wentzville city page's claim makes 'roofer in wentzville mo' a decision, never Home", () => {
  const r = run();
  const k = kw(r, "roofer in wentzville mo");
  assert.equal(k.home_check.fit, "ambiguous");
  assert.match(k.home_check.reason, /claimed by Wentzville \(city page \/service-areas\/wentzville\)/);
  const o = opp(r, `confirm_owner:${k.keyword_id}`);
  assert.equal(o.section, "needs_decision");
  assert.equal(o.action, "requires_confirmation");
  assert.equal(o.tier, "none");
  assert.equal(o.target.keyword, "roofer in wentzville mo");
});

test("1. a Home primary keyword with no service is Home's, not unmapped", () => {
  const r = run((i) => { byText(i, "roofer near me").service_id = null; });
  const k = kw(r, "roofer near me");
  assert.equal(k.role, "home");
  assert.ok(k.flags.includes("home_eligible"));
  assert.ok(k.reasons.some((x) => /Governed by the approved Home page group; not unmapped/.test(x.text)));
  assert.equal(r.keywords.filter((x) => x.role === "unmapped").length, 26);
  assert.doesNotMatch(opp(r, "data_fix:unmapped-keywords").reasons[0].text, /roofer near me/);
  assert.equal(r.home.owned, 1);
});

test("2. Home supporting keywords with no service are Home's; stricter gates still win the role", () => {
  const r = run((i) => {
    for (const t of ["lucas construction roofing wentzville", "best roofer near me"]) byText(i, t).service_id = null;
  });
  assert.equal(kw(r, "lucas construction roofing wentzville").role, "home");
  const best = kw(r, "best roofer near me");
  assert.equal(best.role, "avoid_risky", "the risk gate keeps it out of content");
  assert.ok(best.flags.includes("home_eligible"));
  assert.notEqual(best.role, "unmapped");
  assert.ok(opp(r, "avoid:risky-keywords").reasons.some((x) => /"best roofer near me"/.test(x.text)));
});

test("3. an eligible broad query may be re-homed: homepage_pollution + home_eligible from the analysis", () => {
  const r = run();
  for (const t of ["roofer near me", "roofing company in wentzville mo", "lucas construction roofing reviews"]) {
    const k = kw(r, t);
    assert.ok(k.flags.includes("homepage_pollution") && k.flags.includes("home_eligible"), t);
    assert.equal(k.home_check.eligible, true);
  }
});

test("4. service-specific Roof Replacement keywords stay with Roof Replacement", () => {
  const r = run();
  const k = kw(r, "roof replacement wentzville");
  assert.equal(k.role, "primary");
  assert.equal(k.home_check, null, "not a Home candidate");
  // Even pointed at the home page, its words keep it with the service.
  const r2 = run((i) => { byText(i, "roof replacement wentzville").target_url = `${SITE}/`; byText(i, "new roof installation wentzville").target_url = `${SITE}/`; });
  for (const t of ["roof replacement wentzville", "new roof installation wentzville"]) {
    const x = kw(r2, t);
    assert.equal(x.home_check.fit, "service", t);
    assert.ok(!x.flags.includes("home_eligible"), t);
    assert.ok(x.flags.includes("homepage_pollution"), t);
  }
});

test("5. gutters, siding, soffit, storm, lighting and materials can never move to Home", () => {
  const texts = ["seamless gutters wentzville mo", "siding installation wentzville", "soffit and fascia replacement wentzville",
    "hail damage roof repair wentzville", "christmas light installation near me", "metal roofing wentzville", "asphalt shingle roofing wentzville"];
  const r = run((i) => { for (const t of texts) byText(i, t).target_url = `${SITE}/`; });
  for (const t of texts) {
    const k = kw(r, t);
    assert.equal(k.home_check.fit, "service", t);
    assert.ok(!k.flags.includes("home_eligible") && !k.flags.includes("home_ambiguous"), t);
  }
  // Listed on the Home group with no service: still not Home's; a person decides.
  const r2 = run((i) => { const k = byText(i, "seamless gutters wentzville mo"); k.service_id = null; home(i).supporting_keyword_ids.push(k.id); });
  const g = kw(r2, "seamless gutters wentzville mo");
  assert.equal(g.role, "unmapped");
  assert.ok(g.flags.includes("home_ambiguous") && !g.flags.includes("home_eligible"));
  assert.ok(opp(r2, `confirm_owner:${g.keyword_id}`));
});

test("6b. ambiguity is surfaced, never resolved to Home", () => {
  const extra = (i, id, keyword, service_id = ROOF) =>
    i.keywords.push({ id, keyword, intent: "commercial", intent_note: null, is_active: true, is_tracked: true, is_money: false, service_id, target_url: `${SITE}/`, priority: "p2" });
  const r = run((i) => {
    extra(i, "kw-unknown", "roofing company open sunday near me");
    extra(i, "kw-unapproved", "roofing company troy mo");
    i.locations.push({ name: "Lake Saint Louis, MO", city: "Lake Saint Louis", state: "MO", is_active: true });
    extra(i, "kw-away", "roofing company lake saint louis");
  });
  assert.match(kw(r, "roofing company open sunday near me").home_check.reason, /"open sunday" is not a word the rules place/);
  assert.match(kw(r, "roofing company troy mo").home_check.reason, /not an approved location/);
  assert.match(kw(r, "roofing company lake saint louis").home_check.reason, /approved location other than the home city/);
  for (const id of ["kw-unknown", "kw-unapproved", "kw-away"]) {
    const k = r.keywords.find((x) => x.keyword_id === id);
    assert.ok(k.flags.includes("home_ambiguous") && !k.flags.includes("home_eligible"), id);
    assert.equal(opp(r, `confirm_owner:${id}`).section, "needs_decision");
  }
  // A service named for the category itself competes with Home for every general query.
  const r2 = run((i) => { i.services.push({ id: "svc-roofing", name: "Roofing", status: "approved", page_url: null, primary_keyword_id: null, parent_service_id: null, segment: null }); });
  assert.equal(kw(r2, "roofer near me").home_check.fit, "ambiguous");
  assert.match(kw(r2, "roofer near me").home_check.reason, /Roofing is named for the category itself/);
  assert.equal(kw(r2, "lucas construction roofing wentzville").home_check.fit, "home", "a brand query is still the company's");
});

test("7. arbitrary unmapped keywords are never Home candidates", () => {
  const r = run((i) => {
    i.keywords.push({ id: "kw-generic-unmapped", keyword: "roofing company near me", intent: null, intent_note: null, is_active: true, is_tracked: false, is_money: false, service_id: null, target_url: null, priority: "p3" });
  });
  for (const t of ["christmas light installers near me", "roofing company near me", "lucas construction christmas lights"]) {
    const k = kw(r, t);
    assert.equal(k.role, "unmapped", t);
    assert.equal(k.home_check, null, t);
    assert.ok(!k.flags.some((f) => f.startsWith("home_")), t);
  }
  assert.equal(r.keywords.filter((k) => k.role === "unmapped").length, 27);
});

test("Home must be one approved group, targeting a live home page", () => {
  const down = run((i) => { const p = i.authority.inventory.pages.find((x) => /lucasconstructionmo\.com\/?$/.test(x.url)); p.status = 500; p.final_status = 500; });
  assert.equal(down.home.valid, false);
  assert.match(down.home.reasons[0].text, /home page is error/);
  assert.deepEqual(flagged(down, "home_eligible"), []);
  assert.deepEqual(flagged(down, "home_ambiguous"), []);
  const o = opp(down, `data_fix:keyword-ownership:${ROOF}`);
  assert.equal(o.gates.find((g) => g.gate === "home_destination").pass, false);
  assert.equal(kw(down, "roofer near me").home_check.eligible, false);

  const two = run((i) => { i.authority.pageGroupsFull.push({ ...home(i), id: "pg-home-2", name: "Home (old)" }); });
  assert.equal(two.home.valid, false);
  assert.match(two.home.reasons[0].text, /2 approved Home page groups/);
  assert.deepEqual(flagged(two, "home_eligible"), []);

  const none = run((i) => { i.authority.pageGroupsFull = i.authority.pageGroupsFull.filter((g) => g.page_type !== "home"); });
  assert.equal(none.home.valid, false);
  assert.deepEqual(flagged(none, "home_eligible"), []);
  assert.equal(opp(none, `data_fix:keyword-ownership:${ROOF}`).gates.some((g) => g.gate === "home_destination"), false);
});

test("8. opportunity keys are stable: every production key survives; only ownership decisions are added", () => {
  const r = run();
  const keys = new Set(r.opportunities.map((o) => o.key));
  for (const k of LUCAS_HOME.production_opportunity_keys) assert.ok(keys.has(k), k);
  const added = [...keys].filter((k) => !LUCAS_HOME.production_opportunity_keys.includes(k));
  const decision = `confirm_owner:${kw(r, "roofer in wentzville mo").keyword_id}`;
  assert.ok(added.includes(decision));
  // The trimmed export carries no claims, so a claim-driven topic can appear; nothing else may.
  assert.deepEqual(added.filter((k) => k !== decision && !k.startsWith("topic:")), []);
  assert.deepEqual(r.opportunities.map((o) => o.key).sort(), run().opportunities.map((o) => o.key).sort(), "deterministic");
});

test("existing gates stay intact: risk, intent, material and location", () => {
  const r = run();
  assert.equal(r.keywords.filter((k) => k.flags.includes("intent_conflict")).length, 7);
  assert.equal(kw(r, "metal roofing wentzville").role, "material_unsupported");
  assert.equal(kw(r, "roofer in o'fallon mo").role, "location_unapproved");
  assert.equal(kw(r, "top rated roofer in wentzville").role, "avoid_risky");
  assert.ok(r.opportunities.some((o) => o.key === "confirm_market:ofallon"));
});

test("root(): category words share a root", () => {
  assert.deepEqual(["roofer", "roofers", "roofing", "roof", "plumbing", "plumber"].map(root), ["roof", "roof", "roof", "roof", "plumb", "plumb"]);
});
