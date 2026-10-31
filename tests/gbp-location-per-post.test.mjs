// Several Business Profile locations per client (20261027190935): a GBP brief
// names its location, never guessed between several; a planner slot names its
// location only when the form offers the choice. The database boundary is
// supabase/tests/sandbox/gbp_location_per_post.test.sql.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief } from "../supabase/functions/post-drafter/brief.ts";
import { workspaceAccounts } from "../supabase/functions/post-drafter/workspace.ts";
import { parsePlanFields } from "../src/lib/content-planner.ts";
import { lintDraft } from "../supabase/functions/post-drafter/lint.ts";
import { lucas, TARGET, GOOD, GAZETTEER, OC, WARRANTY } from "./fixtures/drafter-lucas.mjs";

const WICHITA = "c1000000-0000-4000-8000-0000000000c1";
const OVERLAND = "c1000000-0000-4000-8000-0000000000c2";
const PAGE = "c1000000-0000-4000-8000-0000000000c3";
const bound = (id, page, name) => ({ id, platform: "google_business", external_account_id: page, display_name: name,
  publish_provider: "zernio", publish_page_id: page, publish_verified_at: "2026-10-15T18:00:00Z" });
const wichita = bound(WICHITA, "locations/6226831491529440170", "Logic Solar Wichita");
const overland = bound(OVERLAND, "locations/1111111111", "Logic Solar Overland Park");
// Not connected: a location row with no binding.
const unbound = { ...overland, publish_provider: null, publish_page_id: null, publish_verified_at: null };
const facebook = { id: PAGE, platform: "facebook", external_account_id: "1039", display_name: "Logic Solar" };
const codes = (r) => (r.refusals ?? []).map((f) => f.code);

test("a Business Profile brief names its verified location and the brief carries it", () => {
  const r = buildBrief(lucas(), { ...TARGET, socialAccountId: WICHITA }, { socialAccounts: [wichita, overland, facebook] });
  assert.deepEqual(codes(r).filter((c) => c.startsWith("social_account")), []);
  assert.deepEqual(r.brief.target.social_account, { id: WICHITA, page_id: "locations/6226831491529440170", name: "Logic Solar Wichita" });
});

test("with two connected locations an unnamed Business Profile brief is refused, never guessed", () => {
  const r = buildBrief(lucas(), TARGET, { socialAccounts: [wichita, overland] });
  assert.ok(codes(r).includes("social_account_missing"));
});

test("with one connected location an unnamed brief goes there as before (no social_account in the brief)", () => {
  const r = buildBrief(lucas(), TARGET, { socialAccounts: [wichita, unbound, facebook] });
  assert.ok(!codes(r).some((c) => c.startsWith("social_account")));
  assert.equal(r.brief.target.social_account, undefined);
});

test("a location that is not connected, a Facebook Page or an unknown id cannot be named", () => {
  for (const id of [OVERLAND, PAGE, "c1000000-0000-4000-8000-0000000000ff"]) {
    const r = buildBrief(lucas(), { ...TARGET, socialAccountId: id }, { socialAccounts: [wichita, unbound, facebook] });
    assert.ok(codes(r).includes("social_account_unknown"), id);
  }
});

test("a brand workspace narrows Facebook Pages but keeps the client's Business Profile locations", () => {
  const input = { ...lucas(), workspace: { facebook_account_id: null } };
  assert.deepEqual(workspaceAccounts(input, [wichita, overland, facebook]).map((a) => a.id), [WICHITA, OVERLAND]);
});

const WEEK = "2026-10-12";
const form = (extra) => (k) => ({ deliverable: "gbp", purpose: "service", topic: "Battery priorities", ...extra })[k] ?? null;

test("a GBP slot's location is parsed only when the form offers it", () => {
  const off = parsePlanFields(form({}), WEEK);
  assert.ok(off.ok && !("gbp_location_id" in off.fields), "absent field leaves the slot's location untouched");
  const chosen = parsePlanFields(form({ gbp_location_id: WICHITA }), WEEK);
  assert.ok(chosen.ok && chosen.fields.gbp_location_id === WICHITA);
  const cleared = parsePlanFields(form({ gbp_location_id: "" }), WEEK);
  assert.ok(cleared.ok && cleared.fields.gbp_location_id === null);
  assert.equal(parsePlanFields(form({ gbp_location_id: "not-a-uuid" }), WEEK).ok, false);
  const blog = parsePlanFields((k) => ({ deliverable: "blog", purpose: "educational", topic: "x", gbp_location_id: WICHITA })[k] ?? null, WEEK);
  assert.equal(blog.ok, false, "only a Business Profile slot names a location");
});

// A location's recorded markets (gbp_location_markets) are its only approved
// places: an office profile in one city never names the client's other
// cities (Oct 31 2026: a Wichita office profile drafted for the client's
// Kansas City suburbs).
const withMarkets = (row, markets) => ({ ...row, markets });
const placesOf = (r) => r.brief.allowed_facts.crm.places;

test("a Business Profile brief approves only its location's recorded markets", () => {
  const r = buildBrief(lucas(), { ...TARGET, socialAccountId: WICHITA },
    { socialAccounts: [withMarkets(wichita, [{ market: "O'Fallon", kind: "office" }]), overland, facebook] });
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  assert.deepEqual(placesOf(r), ["O'Fallon"]);
  assert.ok(r.brief.excluded.facts.some((f) => f.fact.includes("Wentzville")), "the client's other places are listed as excluded");
  const lint = lintDraft(r.brief, { copy: GOOD, claim_ids: [OC, WARRANTY] }, { gazetteer: GAZETTEER });
  assert.ok(lint.problems.some((p) => p.code === "unapproved_location"), "copy naming another city is refused");
});

test("the only connected location is scoped the same way when the brief names none", () => {
  const r = buildBrief(lucas(), TARGET, { socialAccounts: [withMarkets(wichita, [{ market: "O'Fallon", kind: "service_area" }]), unbound] });
  assert.deepEqual(placesOf(r), ["O'Fallon"]);
});

test("a shared 'all' profile, a location with nothing recorded, Facebook and blog briefs keep the client's places", () => {
  const base = placesOf(buildBrief(lucas(), TARGET, { socialAccounts: [wichita] }));
  assert.deepEqual(base, ["Wentzville"]);
  const all = buildBrief(lucas(), TARGET, { socialAccounts: [withMarkets(wichita, [{ market: "All service markets", kind: "all" }])] });
  assert.deepEqual(placesOf(all), base);
  const blog = buildBrief(lucas(), TARGET, { socialAccounts: [withMarkets(wichita, [{ market: "O'Fallon", kind: "office" }])], purpose: "blog" });
  assert.deepEqual(placesOf(blog), base);
  const fb = buildBrief(lucas(), { ...TARGET, channel: "facebook", ctaType: null, socialAccountId: PAGE },
    { socialAccounts: [withMarkets(wichita, [{ market: "O'Fallon", kind: "office" }]), facebook] });
  assert.deepEqual(placesOf(fb), base);
});
