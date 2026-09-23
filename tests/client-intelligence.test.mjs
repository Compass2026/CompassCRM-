// Client Intelligence readiness (five-layer plan, layer 1): what an AI post
// drafter may rely on, and what blocks a client from a posting pilot.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessIntelligence,
  intentCounts,
  normalizeIntent,
  pilotReadiness,
  topicCandidates,
  usableClaims,
} from "../src/lib/client-intelligence.ts";

const svc = (id, name, o = {}) => ({ id, name, status: "approved", page_url: `/${id}`, primary_keyword_id: null, parent_service_id: null, ...o });
const kw = (id, keyword, intent, o = {}) => ({ id, keyword, intent, is_active: true, is_tracked: true, is_money: false, service_id: null, target_url: null, priority: "p2", ...o });
const claim = (id, status, source = "About page") => ({ id, claim: `claim ${id}`, status, source });

function readyClient() {
  return {
    client: { name: "Fictional Roofing", phone: "555-0100", website_url: "https://roof.example", city: "Columbia", state: "MO", service_area: "Mid-Missouri", business_type: "service_area", address_line1: null },
    brand: { positioning: "Roofs done once.", voice_tone: "Plain, neighborly", audience: "Homeowners in Boone County", differentiators: null, ai_guidance: "Always name the service area.", words_we_use: [], words_we_avoid: ["cheap"], content_pillars: [] },
    board: { status: "approved", hard_rules: ["Never promise timelines"], standing_cta: "Call for a free estimate" },
    services: [svc("s1", "Roof repair", { primary_keyword_id: "k1" }), svc("s2", "Gutters")],
    keywords: [
      kw("k1", "roof repair columbia mo", "transactional", { service_id: "s1", is_money: true, priority: "p1" }),
      kw("k2", "how long does a roof last", "informational", { service_id: "s1" }),
      kw("k3", "best roofer columbia", "commercial", { service_id: "s1" }),
      kw("k4", "fictional roofing phone", "navigational"),
      kw("k5", "seamless gutters cost", "Commercial", { service_id: "s2" }),
    ],
    claims: [claim("c1", "sourced"), claim("c2", "sourced"), claim("c3", "confirmed", null), claim("c4", "unverified")],
    locations: [{ name: "Columbia", city: "Columbia", state: "MO", is_active: true }],
    assets: [{ kind: "logo_primary" }, ...Array.from({ length: 6 }, () => ({ kind: "photo" }))],
  };
}
const area = (areas, key) => areas.find((a) => a.key === key);

test("intent must be one of the four search intents; notes and blanks are not intents", () => {
  assert.equal(normalizeIntent(" Commercial "), "commercial");
  assert.equal(normalizeIntent("Primary keyword for /patios"), null);
  assert.equal(normalizeIntent(null), null);
  const c = intentCounts([kw("a", "a", "informational"), kw("b", "b", "Low volume, high intent"), kw("c", "c", null), kw("d", "d", "commercial", { is_active: false })]);
  assert.deepEqual(c, { active: 3, counts: { navigational: 0, informational: 1, commercial: 0, transactional: 0 }, unlabelled: 1, nonStandard: 1 });
});

test("only sourced-with-a-source or client-confirmed claims can be cited; unverified never", () => {
  const ids = usableClaims([claim("a", "sourced"), claim("b", "sourced", "  "), claim("c", "confirmed", null), claim("d", "unverified")]).map((c) => c.id);
  assert.deepEqual(ids, ["a", "c"]);
});

test("a complete client is pilot-ready; offers are reported but do not block", () => {
  const areas = assessIntelligence(readyClient());
  assert.deepEqual(areas.filter((a) => a.status !== "ready").map((a) => a.key), ["offers"]);
  assert.equal(area(areas, "offers").blocking, false);
  assert.deepEqual(pilotReadiness(areas), { ready: 9, total: 9, isReady: true });
  assert.match(area(areas, "proof").summary, /3 usable \(1 client-confirmed\); 1 unverified, never cited/);
});

test("topics tie approved services to keywords by intent, money keywords first", () => {
  const topics = topicCandidates(readyClient());
  assert.deepEqual(topics.map((t) => t.service), ["Roof repair", "Gutters"]);
  assert.deepEqual(topics[0].intents, { transactional: ["roof repair columbia mo"], informational: ["how long does a roof last"], commercial: ["best roofer columbia"] });
  assert.equal(topics[0].primaryKeyword, "roof repair columbia mo");
  const retired = { ...readyClient(), services: [svc("s1", "Roof repair", { status: "retired" })] };
  assert.deepEqual(topicCandidates(retired), []);
});

test("free-text intent notes (the Shewmaker shape) block the keywords area with a precise fix", () => {
  const input = readyClient();
  input.keywords = input.keywords.map((k) => ({ ...k, intent: "Primary keyword for /patios" }));
  const k = area(assessIntelligence(input), "keywords");
  assert.equal(k.status, "partial");
  assert.ok(k.gaps.some((g) => /5 keywords carry a note instead of an intent/.test(g)));
  assert.ok(k.gaps.some((g) => /Link keywords to approved services/.test(g)));
});

test("thin proof, a draft board and missing photos are named, not hidden", () => {
  const input = readyClient();
  input.claims = [claim("c1", "sourced"), claim("c2", "sourced", null), claim("c3", "unverified")];
  input.board = { ...input.board, status: "draft" };
  input.assets = [{ kind: "photo" }, { kind: "photo" }];
  const areas = assessIntelligence(input);
  assert.equal(area(areas, "proof").status, "partial");
  assert.ok(area(areas, "proof").gaps.some((g) => /at least 3 sourced or confirmed claims \(1 now\)/.test(g)));
  assert.ok(area(areas, "proof").gaps.some((g) => /1 claim marked sourced without a source/.test(g)));
  assert.equal(area(areas, "brand").status, "partial");
  assert.deepEqual(area(areas, "assets").gaps, ["Mark a primary logo.", "Add real photos: 2 of 6."]);
  assert.equal(pilotReadiness(areas).isReady, false);
});

test("an empty client reads as missing everywhere that matters", () => {
  const areas = assessIntelligence({
    client: { name: "New", phone: null, website_url: null, city: null, state: null, service_area: null, business_type: null, address_line1: null },
    brand: null, board: null, services: [], keywords: [], claims: [], locations: [], assets: [],
  });
  for (const key of ["facts", "brand", "services", "audience", "locations", "offers", "proof", "assets", "keywords", "rules"])
    assert.equal(area(areas, key).status, "missing", key);
  assert.deepEqual(pilotReadiness(areas), { ready: 0, total: 9, isReady: false });
});
