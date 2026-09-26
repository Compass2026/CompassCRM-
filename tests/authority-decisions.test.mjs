// Authority decision rules (src/lib/authority-decisions.ts): which decision
// an opportunity takes, what the engine recommended, the preview defaults,
// the refresh plan and how authority_apply's answers read. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  decisionKind, intentRecommendation, marketPlace, normPlace, servicePath, suggestedServiceName, serviceUrl, defaultTask,
  applyErrorText, appliedText, refreshPlan, AUTHORITY_ONLY, CANONICAL_ACTIONS, MAX_SELECTED,
} from "../src/lib/authority-decisions.ts";

const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/authority-lucas-run.json", import.meta.url), "utf8"));
const byKey = (k) => FX.opportunities.find((o) => o.key === k);

test("decision kinds from the key", () => {
  assert.equal(decisionKind("confirm_intent:x"), "intent");
  assert.equal(decisionKind("confirm_market:ofallon"), "market");
  assert.equal(decisionKind("confirm_service:/services/x"), "service");
  assert.equal(decisionKind("data_fix:service-page:x"), null);
  assert.deepEqual([...CANONICAL_ACTIONS].sort(), ["approve_market", "confirm_service", "set_intent"]);
  assert.equal(MAX_SELECTED, 25);
});

test("intent recommendation from the production Lucas entries", () => {
  const all = FX.opportunities.filter((o) => o.key.startsWith("confirm_intent:")).map(intentRecommendation);
  assert.equal(all.length, 7);
  assert.ok(all.every((r) => r && r.keywordId && r.stored && r.options.length >= 1), JSON.stringify(all));
  const cot = intentRecommendation({ gap: "Stored as informational; the query reads as commercial or transactional.", target: { keyword_id: "k", keyword: "roof repair near me", intent: "informational" } });
  assert.deepEqual(cot, { keywordId: "k", keyword: "roof repair near me", stored: "informational", assessed: "commercial or transactional", options: ["commercial", "transactional"] });
  assert.deepEqual(intentRecommendation({ gap: "Stored as commercial; the query reads as navigational.", target: { keyword_id: "k", keyword: "x", intent: "Commercial" } }).options, ["navigational"]);
  assert.equal(intentRecommendation({ gap: "something else", target: {} }), null);
});

test("market place and normalisation (the engine's rule)", () => {
  const m = byKey("confirm_market:chesterfield");
  assert.equal(marketPlace(m), "Chesterfield");
  assert.equal(normPlace("O'Fallon"), normPlace("OFallon"));
  assert.equal(normPlace("Lake St. Louis"), "lake saint louis");
  assert.equal(marketPlace({ target: { location: null }, topic: "Market: Cottleville" }), "Cottleville");
});

test("service page, suggested name and URL", () => {
  const s = byKey("confirm_service:/services/commercial-roofing");
  assert.equal(servicePath(s.key), "/services/commercial-roofing");
  assert.equal(suggestedServiceName({ key: "confirm_service:/services/storm-damage", reasons: [{ tag: "FACT", text: 'Live page /services/storm-damage: "Storm Damage Repair | Lucas Construction".' }] }), "Storm Damage Repair");
  assert.equal(suggestedServiceName({ key: "confirm_service:/services/metal-roofing/", reasons: [] }), "Metal Roofing");
  assert.ok(suggestedServiceName(s).length > 0);
  assert.equal(serviceUrl("https://www.lucasconstructionmo.com/", "/services/commercial-roofing"), "https://www.lucasconstructionmo.com/services/commercial-roofing");
  assert.equal(serviceUrl(null, "/x"), null);
  assert.equal(serviceUrl("not a url", "/x"), null);
});

test("task defaults", () => {
  assert.deepEqual(defaultTask({ topic: "Roof Repair", gap: "The owner page is missing." }, "Create"), { title: "Create: Roof Repair", notes: "The owner page is missing." });
  assert.equal(defaultTask({ topic: "x".repeat(300), gap: "" }, "Create").title.length, 200);
});

test("authority_apply's answers", () => {
  const changed = applyErrorText({ code: "AU409", message: "Changed since the preview: the keyword's intent is now transactional" });
  assert.equal(changed.changed, true);
  assert.equal(changed.text, "Changed since the preview: the keyword's intent is now transactional. Nothing was saved; review it again.");
  assert.deepEqual(applyErrorText({ code: "42501" }).changed, false);
  assert.match(applyErrorText({ code: "22023", message: "A market needs its coordinates (rank checks use them)" }).text, /coordinates.*Nothing was saved/);
  assert.match(applyErrorText({ code: "XX000", message: "?" }).text, /no clear answer/);
  assert.equal(appliedText("decline_market", {}), `Market declined. ${AUTHORITY_ONLY}`);
  assert.equal(appliedText("not_offered", {}), `Marked not offered. ${AUTHORITY_ONLY}`);
  assert.equal(AUTHORITY_ONLY, "Authority decision only; no Client Intelligence record created.");
  assert.match(appliedText("keep_intent", {}), /comes back only if a later analysis recommends something different/);
});

test("refresh after a change to client data, never a full crawl", () => {
  assert.deepEqual(refreshPlan({ inventory_stale: false, stale_sections: ["keywords"] }), { refresh: true });
  assert.equal(refreshPlan({ inventory_stale: true, stale_sections: [] }).refresh, false);
  assert.match(refreshPlan({ inventory_stale: false, stale_sections: ["site"] }).text, /needs a full analysis/);
  assert.equal(refreshPlan(null).refresh, false);
});
