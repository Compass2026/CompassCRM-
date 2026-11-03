// Several Business Profile locations per client (20261027190935): a GBP brief
// names its location, never guessed between several; a planner slot names its
// location only when the form offers the choice. The database boundary is
// supabase/tests/sandbox/gbp_location_per_post.test.sql.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBrief, ownerContextOf } from "../supabase/functions/post-drafter/brief.ts";
import { workspaceAccounts } from "../supabase/functions/post-drafter/workspace.ts";
import { parsePlanFields } from "../src/lib/content-planner.ts";
import { lintDraft } from "../supabase/functions/post-drafter/lint.ts";
import { lucas, TARGET, GOOD, GAZETTEER, OC, WARRANTY, KW } from "./fixtures/drafter-lucas.mjs";

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
  // Two verified locations: the named one has its market recorded.
  const mapped = { ...wichita, markets: [{ market: "Wentzville", kind: "office" }] };
  const r = buildBrief(lucas(), { ...TARGET, socialAccountId: WICHITA }, { socialAccounts: [mapped, overland, facebook] });
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

test("a city keyword outside the location's markets is refused (market_not_applicable)", () => {
  const input = lucas();
  const ctx = ownerContextOf(input);
  const cityKeyword = { ...input, owner_context: { ...ctx, keywords: ctx.keywords.map((k) => (k.id === KW ? { ...k, city: "Wentzville" } : k)) } };
  const off = buildBrief(cityKeyword, { ...TARGET, socialAccountId: WICHITA },
    { socialAccounts: [withMarkets(wichita, [{ market: "O'Fallon", kind: "office" }]), overland] });
  assert.ok(codes(off).includes("market_not_applicable"));
  const on = buildBrief(cityKeyword, { ...TARGET, socialAccountId: WICHITA },
    { socialAccounts: [withMarkets(wichita, [{ market: "Wentzville", kind: "office" }]), overland] });
  assert.ok(!codes(on).includes("market_not_applicable"));
});

test("an unmapped profile of a client with several offices or locations is refused, never given every city", () => {
  const twoOffices = { ...lucas(), locations: [...lucas().locations, { name: "O'Fallon, MO", city: "O'Fallon", state: "MO", is_active: true }] };
  assert.ok(codes(buildBrief(twoOffices, TARGET, { socialAccounts: [wichita] })).includes("location_market_unmapped"));
  assert.ok(codes(buildBrief(twoOffices, { ...TARGET, socialAccountId: WICHITA }, { socialAccounts: [wichita, overland] })).includes("location_market_unmapped"));
  // Mapped, or a single-office client: drafted as before.
  assert.ok(!codes(buildBrief(twoOffices, TARGET, { socialAccounts: [withMarkets(wichita, [{ market: "Wentzville", kind: "office" }])] })).includes("location_market_unmapped"));
  assert.ok(!codes(buildBrief(lucas(), TARGET, { socialAccounts: [wichita] })).includes("location_market_unmapped"));
  // Blog briefs are never refused for it.
  assert.ok(!codes(buildBrief(twoOffices, TARGET, { socialAccounts: [wichita], purpose: "blog" })).includes("location_market_unmapped"));
});

// ── Logic-shaped production data (Nov 2 2026) ─────────────────────────────────
// One verified profile (Wichita, recorded as its office market); Overland
// Park is an office with no connected profile (its verification hold); the
// Kansas City suburbs are approved markets of the client, not of Wichita; the
// client's phone is its Kansas City number. Fictional ids; real place names.
import { createCopyCheck } from "../supabase/functions/content-approvals/copy-check.ts";
import realGazetteer from "../supabase/functions/post-drafter/gazetteer.json" with { type: "json" };

const KS = realGazetteer.KS;
const KC_PHONE = "816-300-5781";
const KC_PLACES = ["Overland Park", "Kansas City", "Lenexa", "Olathe", "Shawnee"];
const market = (city, state, basis) => ({ id: `m-${city}-${state}`, city, state, basis, status: "approved", brand_workspace_id: null });
function logicShaped() {
  const base = lucas();
  const input = { ...base, client: { ...base.client, phone: KC_PHONE, state: "KS" },
    locations: [{ name: "Wichita, KS", city: "Wichita", state: "KS", is_active: true }, { name: "Overland Park, KS", city: "Overland Park", state: "KS", is_active: true }] };
  const ctx = ownerContextOf(input);
  return { ...input, owner_context: { ...ctx, markets: [market("Wichita", "KS", "office"), market("Overland Park", "KS", "office"),
    market("Kansas City", "KS", "recorded_decision"), market("Kansas City", "MO", "recorded_decision"),
    market("Lenexa", "KS", "recorded_decision"), market("Olathe", "KS", "recorded_decision"), market("Shawnee", "KS", "recorded_decision")] } };
}
const wichitaOffice = withMarkets(wichita, [{ market: "Wichita", kind: "office" }]);
const ACCOUNTS = [wichitaOffice, facebook];
const WICHITA_COPY = GOOD.replace("Wentzville", "Wichita");

test("Logic-shaped: the Wichita profile's brief approves Wichita only, carries no phone, and lists the Kansas City places as excluded", () => {
  const r = buildBrief(logicShaped(), { ...TARGET, socialAccountId: WICHITA }, { socialAccounts: ACCOUNTS });
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  assert.deepEqual(placesOf(r), ["Wichita"]);
  assert.equal(r.brief.client.phone, "");
  assert.equal(r.brief.allowed_facts.crm.phone, "");
  const excluded = r.brief.excluded.facts.map((f) => f.fact).join(" | ");
  for (const p of KC_PLACES) assert.ok(excluded.includes(p), p);
  assert.ok(r.brief.excluded.facts.some((f) => f.fact === "The client's phone number"));
  assert.ok(!JSON.stringify(r.brief).includes(KC_PHONE), "the Kansas City number is nowhere in the brief");
  assert.equal(r.brief.target.cta.type, "LEARN_MORE");
});

test("Logic-shaped: Wichita copy naming a Kansas City place or the phone is refused; plain Wichita copy passes", () => {
  const r = buildBrief(logicShaped(), { ...TARGET, socialAccountId: WICHITA }, { socialAccounts: ACCOUNTS });
  const lint = (copy) => lintDraft(r.brief, { copy, claim_ids: [OC, WARRANTY] }, { gazetteer: KS });
  const clean = lint(WICHITA_COPY);
  assert.deepEqual(clean.problems.filter((p) => ["unapproved_location", "wrong_phone"].includes(p.code)), []);
  for (const p of KC_PLACES) {
    const out = lint(`${WICHITA_COPY} We also serve ${p}.`);
    assert.ok(out.problems.some((x) => x.code === "unapproved_location" && x.message.includes(p)), p);
  }
  const phone = lint(`${WICHITA_COPY} Call ${KC_PHONE}.`);
  assert.ok(phone.problems.some((x) => x.code === "wrong_phone" && x.message === "This post names no phone number."));
});

test("Logic-shaped: a Call button is refused for the Wichita profile; Learn More to the owner page is the button", () => {
  const r = buildBrief(logicShaped(), { ...TARGET, ctaType: "CALL", socialAccountId: WICHITA }, { socialAccounts: ACCOUNTS });
  assert.ok(codes(r).includes("cta_invalid"));
  assert.match(r.refusals.find((x) => x.code === "cta_invalid").message, /no recorded phone; use Learn More/);
});

test("Logic-shaped: Facebook and blog briefs keep the client's places and phone", () => {
  const fb = buildBrief(logicShaped(), { ...TARGET, channel: "facebook", ctaType: null, socialAccountId: PAGE }, { socialAccounts: ACCOUNTS });
  assert.equal(fb.ok, true, JSON.stringify(fb.refusals));
  for (const p of ["Wichita", ...KC_PLACES]) assert.ok(placesOf(fb).includes(p), p);
  assert.equal(fb.brief.client.phone, KC_PHONE);
  const blog = buildBrief(logicShaped(), TARGET, { socialAccounts: ACCOUNTS, purpose: "blog" });
  for (const p of ["Wichita", ...KC_PLACES]) assert.ok(placesOf(blog).includes(p), p);
  assert.equal(blog.brief.client.phone, KC_PHONE);
});

test("Logic-shaped: the content-approvals copy check enforces the same rule on a copy edit", async () => {
  const post = { platform: "google_business", post_type: "standard", search_intent: "commercial", service_id: TARGET.serviceId,
    keyword_id: KW, offer_id: null, cta_type: "LEARN_MORE", cta_url: null, social_account_id: WICHITA, asset_ids: [], campaign_mode: "keyword" };
  const check = createCopyCheck({ postTarget: async () => post, input: async () => logicShaped(), socialAccounts: async () => ACCOUNTS, gazetteer: realGazetteer });
  const ok = await check("client", "post", WICHITA_COPY, [OC, WARRANTY]);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const olathe = await check("client", "post", `${WICHITA_COPY} Now serving Olathe.`, [OC, WARRANTY]);
  assert.equal(olathe.ok, false);
  assert.ok(olathe.problems.some((p) => p.code === "unapproved_location"));
  const phone = await check("client", "post", `${WICHITA_COPY} Call ${KC_PHONE}.`, [OC, WARRANTY]);
  assert.ok(phone.problems.some((p) => p.code === "wrong_phone"));
});

// ── A phone recorded for one location (gbp_location_phones, Nov 3 2026) ──────
// The scoped profile carries its own recorded number and may take a Call
// button; the client-wide number is "not this location's number" there.
// Without a recorded phone the profile stays phone-free (tests above).
// Synthetic 555-01xx number; the store attaches it (last test).
import { createStore } from "../supabase/functions/post-drafter/store.ts";

const LOCATION_PHONE = "(316) 555-0142";
const wichitaWithPhone = { ...wichitaOffice, phone: LOCATION_PHONE };
const PHONE_ACCOUNTS = [wichitaWithPhone, facebook];

test("location phone: the scoped profile's brief carries its recorded phone, and the client-wide number is excluded as not this location's", () => {
  const r = buildBrief(logicShaped(), { ...TARGET, socialAccountId: WICHITA }, { socialAccounts: PHONE_ACCOUNTS });
  assert.equal(r.ok, true, JSON.stringify(r.refusals));
  assert.equal(r.brief.client.phone, LOCATION_PHONE);
  assert.equal(r.brief.allowed_facts.crm.phone, LOCATION_PHONE);
  assert.deepEqual(placesOf(r), ["Wichita"]);
  const clientWide = r.brief.excluded.facts.find((f) => f.fact.startsWith("The client-wide phone number"));
  assert.ok(clientWide && clientWide.fact.includes(KC_PHONE), "the client-wide number is named as an excluded fact");
  assert.match(clientWide.reason, /Not this location's number/);
  assert.ok(!r.brief.excluded.facts.some((f) => f.fact === "The client's phone number"), "no phone-free exclusion when a phone is recorded");
  assert.ok(r.brief.excluded.facts.some((f) => f.fact === "A staffed office at this location"), "a recorded phone is not a staffed office");
});

test("location phone: copy with the location's number passes; the client-wide 816 number is refused as wrong_phone", () => {
  const r = buildBrief(logicShaped(), { ...TARGET, socialAccountId: WICHITA }, { socialAccounts: PHONE_ACCOUNTS });
  const lint = (copy) => lintDraft(r.brief, { copy, claim_ids: [OC, WARRANTY] }, { gazetteer: KS });
  for (const written of [LOCATION_PHONE, "316-555-0142", "316.555.0142"]) {
    const ok = lint(`${WICHITA_COPY} Call ${written}.`);
    assert.deepEqual(ok.problems.filter((p) => p.code === "wrong_phone"), [], written);
  }
  const wrong = lint(`${WICHITA_COPY} Call ${KC_PHONE}.`);
  assert.ok(wrong.problems.some((p) => p.code === "wrong_phone" && p.message === `The only phone number is ${LOCATION_PHONE}.`));
});

test("location phone: a Call button is accepted only for a location with a recorded phone", () => {
  const withPhone = buildBrief(logicShaped(), { ...TARGET, ctaType: "CALL", socialAccountId: WICHITA }, { socialAccounts: PHONE_ACCOUNTS });
  assert.equal(withPhone.ok, true, JSON.stringify(withPhone.refusals));
  assert.deepEqual(withPhone.brief.target.cta, { type: "CALL", url: null, in_copy_phrase: withPhone.brief.target.cta.in_copy_phrase });
  const without = buildBrief(logicShaped(), { ...TARGET, ctaType: "CALL", socialAccountId: WICHITA }, { socialAccounts: ACCOUNTS });
  assert.ok(codes(without).includes("cta_invalid"));
  // A phone recorded for another location does not lend this one a Call button.
  const elsewhere = buildBrief(logicShaped(), { ...TARGET, ctaType: "CALL", socialAccountId: WICHITA },
    { socialAccounts: [wichitaOffice, { ...overland, phone: "(913) 555-0107", markets: [{ market: "Overland Park", kind: "office" }] }, facebook] });
  assert.ok(codes(elsewhere).includes("cta_invalid"));
  // A Call button still takes no link.
  const linked = buildBrief(logicShaped(), { ...TARGET, ctaType: "CALL", ctaUrl: "https://example.test/x", socialAccountId: WICHITA }, { socialAccounts: PHONE_ACCOUNTS });
  assert.ok(codes(linked).includes("cta_invalid"));
});

test("location phone: a scoped location without a recorded phone is unchanged (phone-free, Learn More)", () => {
  const before = buildBrief(logicShaped(), { ...TARGET, socialAccountId: WICHITA }, { socialAccounts: ACCOUNTS });
  const nulled = buildBrief(logicShaped(), { ...TARGET, socialAccountId: WICHITA }, { socialAccounts: [{ ...wichitaOffice, phone: null }, facebook] });
  assert.equal(nulled.ok, true, JSON.stringify(nulled.refusals));
  assert.deepEqual(nulled.brief, before.brief);
  assert.equal(nulled.brief.client.phone, "");
  assert.ok(!JSON.stringify(nulled.brief).includes(KC_PHONE));
});

test("location phone: Facebook, blog, unscoped and 'all' profiles keep the client's phone", () => {
  const fb = buildBrief(logicShaped(), { ...TARGET, channel: "facebook", ctaType: null, socialAccountId: PAGE }, { socialAccounts: PHONE_ACCOUNTS });
  assert.equal(fb.ok, true, JSON.stringify(fb.refusals));
  assert.equal(fb.brief.client.phone, KC_PHONE);
  assert.ok(!JSON.stringify(fb.brief).includes(LOCATION_PHONE));
  const blog = buildBrief(logicShaped(), TARGET, { socialAccounts: PHONE_ACCOUNTS, purpose: "blog" });
  assert.equal(blog.brief.client.phone, KC_PHONE);
  // A single-location client with nothing recorded, and a shared 'all' profile: the client's phone, the location's ignored.
  const single = buildBrief(lucas(), TARGET, { socialAccounts: [{ ...wichita, phone: LOCATION_PHONE }] });
  assert.equal(single.brief.client.phone, lucas().client.phone);
  const all = buildBrief(lucas(), TARGET, { socialAccounts: [{ ...wichita, phone: LOCATION_PHONE, markets: [{ market: "All service markets", kind: "all" }] }] });
  assert.equal(all.brief.client.phone, lucas().client.phone);
});

test("location phone: the content-approvals copy check inherits it", async () => {
  const post = { platform: "google_business", post_type: "standard", search_intent: "commercial", service_id: TARGET.serviceId,
    keyword_id: KW, offer_id: null, cta_type: "CALL", cta_url: null, social_account_id: WICHITA, asset_ids: [], campaign_mode: "keyword" };
  const deps = (accounts) => ({ postTarget: async () => post, input: async () => logicShaped(), socialAccounts: async () => accounts, gazetteer: realGazetteer });
  const check = createCopyCheck(deps(PHONE_ACCOUNTS));
  const ok = await check("client", "post", `${WICHITA_COPY} Call ${LOCATION_PHONE}.`, [OC, WARRANTY]);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const wrong = await check("client", "post", `${WICHITA_COPY} Call ${KC_PHONE}.`, [OC, WARRANTY]);
  assert.equal(wrong.ok, false);
  assert.ok(wrong.problems.some((p) => p.code === "wrong_phone"));
  // The same Call-button post on a location with no recorded phone is refused at the brief.
  const none = await createCopyCheck(deps(ACCOUNTS))("client", "post", WICHITA_COPY, [OC, WARRANTY]);
  assert.equal(none.ok, false);
  assert.equal(none.code, "brief_refused");
  assert.ok(none.problems.some((p) => p.code === "cta_invalid"));
});

test("location phone: the store attaches each Business Profile location's recorded phone, and a missing table reads as none", async () => {
  const rows = { social_accounts: [{ ...wichita }, { ...overland }, { ...facebook }],
    gbp_location_markets: [{ social_account_id: WICHITA, market: "Wichita", kind: "office" }],
    gbp_location_phones: [{ social_account_id: WICHITA, phone: LOCATION_PHONE }] };
  const fake = (missing) => ({ from(table) {
    const q = { select: () => q, eq: () => q, in: () => q,
      then: (resolve) => resolve(missing && table === "gbp_location_phones"
        ? { data: null, error: { code: "PGRST205", message: "Could not find the table" } }
        : { data: rows[table].map((r) => ({ ...r })), error: null }) };
    return q;
  } });
  const accounts = await createStore(fake(false)).socialAccounts("client");
  assert.equal(accounts.find((a) => a.id === WICHITA).phone, LOCATION_PHONE);
  assert.equal(accounts.find((a) => a.id === OVERLAND).phone, null);
  assert.equal(accounts.find((a) => a.id === PAGE).phone, undefined, "a Facebook Page carries no location phone");
  const missing = await createStore(fake(true)).socialAccounts("client");
  assert.equal(missing.find((a) => a.id === WICHITA).phone, null);
});
