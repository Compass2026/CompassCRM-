// Authority plans within the agreement (src/lib/authority-agreement.ts, B5):
// each opportunity's work is marked against the client's entitlements and
// this month's usage, over the production Lucas run fixture. The engine's
// analysis is unchanged; nothing is hidden. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildAuthorityView } from "../src/lib/authority-view.ts";
import { cardAgreement, workKindOf } from "../src/lib/authority-agreement.ts";
import { entitlementSet } from "../src/lib/entitlements.ts";

const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/authority-lucas-run.json", import.meta.url), "utf8"));
const RUN = FX.meta.run;
const C = "c";
const set = (given) => entitlementSet(C, Object.entries(given).map(([key, [enabled, quantity]]) => ({
  client_id: C, service_key: key, service_name: key, kind: quantity === undefined ? "feature" : "quota",
  enabled, quantity: quantity === undefined ? null : quantity, unit: null, period: null, source: "package", package_id: null,
})));
const input = (agreement) => ({
  latest: { run_id: RUN.id, finished_at: RUN.finished_at, judged_at: RUN.finished_at, mode: "full", engine_version: "authority-v1.1",
    counts: FX.meta.counts, sources: FX.meta.sources, inventory_fetched_at: RUN.inventory_fetched_at, stale_sections: [], inventory_stale: false },
  runs: [{ id: RUN.id, created_at: RUN.created_at, finished_at: RUN.finished_at, status: "completed", mode: "full", requested_via: "team", requested_by: null,
    inventory_fetched_at: RUN.inventory_fetched_at, inventory_pages: 64, inventory_errors: 0, diff: null, error: null, health: null }],
  opportunities: FX.opportunities, pillars: FX.meta.pillars,
  states: FX.opportunities.map((o, i) => ({ id: `s${i}`, key: o.key, effective_status: "open", present: true, first_seen_run_id: RUN.id, last_seen_run_id: RUN.id })),
  events: [], members: [], agreement,
});
const cards = (v) => v.sections.flatMap((s) => s.groups.flatMap((g) => g.cards));
const gbpReady = (v) => cards(v).filter((c) => c.details.raw.content_type === "gbp_post" && c.details.raw.action === "create");

test("work kinds: posts, pages and refreshes; CRM housekeeping carries no mark", () => {
  assert.equal(workKindOf({ action: "create", content_type: "gbp_post" }), "gbp_post");
  assert.equal(workKindOf({ action: "create", content_type: "blog_post" }), "blog_post");
  assert.equal(workKindOf({ action: "create", content_type: "service_page" }), "new_page");
  assert.equal(workKindOf({ action: "improve", content_type: "page_improvement" }), "page_refresh");
  assert.equal(workKindOf({ action: "refresh", content_type: "blog_refresh" }), "page_refresh");
  assert.equal(workKindOf({ action: "improve", content_type: "data_fix" }), null);
  assert.equal(workKindOf({ action: "requires_confirmation", content_type: "location_page" }), null);
  assert.equal(workKindOf({ action: "blocked_data_prerequisite", content_type: "gbp_post" }), null);
});

test("18 Authority planning reads the entitlements: GBP posts outside the agreement are marked, not hidden", () => {
  const without = buildAuthorityView(input({ set: set({ gbp: [false], gbp_posts: [false, 0] }), usage: {} }));
  const withNone = buildAuthorityView(input(null));
  assert.equal(gbpReady(without).length, 2);
  assert.equal(cards(without).length, cards(withNone).length, "nothing hidden");
  for (const c of gbpReady(without)) {
    assert.equal(c.agreement.status, "not_in_agreement");
    assert.equal(c.agreement.label, "Not in agreement");
  }
  // Housekeeping (data fixes) carries no agreement mark.
  assert.ok(cards(without).filter((c) => c.details.raw.content_type === "data_fix").every((c) => c.agreement === null));
});

test("18b a used allocation is marked; room left is unmarked (label null)", () => {
  const s = set({ gbp: [true], gbp_posts: [true, 4], website: [true], website_pages: [true, 2], website_refreshes: [true, 2] });
  const used = buildAuthorityView(input({ set: s, usage: { gbp_posts: { used: 4 }, website_pages: { used: 0 } } }));
  for (const c of gbpReady(used)) assert.equal(c.agreement.status, "allocation_used");
  const pages = cards(used).filter((c) => c.details.raw.content_type === "service_page" && c.details.raw.action === "create");
  assert.equal(pages.length, 2);
  for (const c of pages) {
    assert.equal(c.agreement.status, "within_allocation");
    assert.equal(c.agreement.label, null);
    assert.match(c.agreement.title, /2 of 2 new website pages left/);
  }
});

test("18c entitlements unreadable: every automatable card says so (fail safe)", () => {
  const v = buildAuthorityView(input({ unavailable: "permission denied" }));
  const marked = cards(v).filter((c) => c.agreement);
  assert.ok(marked.length > 0);
  assert.ok(marked.every((c) => c.agreement.status === "unknown" && /paused/.test(c.agreement.title)));
});

test("the engine's opportunities are untouched by the agreement", () => {
  const a = buildAuthorityView(input({ set: set({}), usage: {} }));
  const b = buildAuthorityView(input(null));
  const strip = (v) => cards(v).map((c) => ({ ...c, agreement: undefined }));
  assert.deepEqual(strip(a), strip(b));
  assert.equal(cardAgreement({ action: "create", content_type: "gbp_post" }, null), null);
});
