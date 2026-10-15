// The monthly delivery standard's typed model (src/lib/delivery-standard.ts):
// explicit months on the Chicago calendar, per-brand units and the client
// total counted once, and the loader failing loudly. The SQL side is
// supabase/tests/sandbox/delivery_standard.test.sql.
import { test } from "node:test";
import assert from "node:assert/strict";
import { countText, currentMonth, getDeliveryTargets, groupDelivery, monthOf, parseMonth, sharesBusinessProfile } from "../src/lib/delivery-standard.ts";

const M = "00000000-0000-4000-d500-00000000000a";
const S = "00000000-0000-4000-d500-00000000000b";
const target = { blog_posts: 8, facebook_posts: 8, gbp_posts: 8, page_refreshes: 1 };
function rows(clientId, units, work = {}) {
  return units.flatMap(([kind, id, name]) => Object.entries(target).map(([deliverable, t]) => {
    const [completed, planned] = work[`${name}:${deliverable}`] ?? [0, 0];
    const tgt = kind === "unattributed" ? 0 : t;
    return {
      client_id: clientId, month: "2026-11-01", unit_kind: kind, brand_workspace_id: id, unit_name: name, deliverable,
      target: tgt, completed, planned, used: completed + planned, remaining: Math.max(0, tgt - completed - planned),
      over_target: Math.max(0, completed + planned - tgt), standard_version: 1, source_ref: "executive_os:decision",
    };
  }));
}
const bhg = rows(M, [["brand", "a", "Safety"], ["brand", "b", "Forklift"], ["brand", "c", "Heavy Equipment"], ["unattributed", null, "Unattributed"]], {
  "Safety:blog_posts": [2, 1], "Forklift:blog_posts": [1, 0], "Heavy Equipment:blog_posts": [9, 0],
  "Safety:gbp_posts": [1, 0], "Unattributed:facebook_posts": [0, 2],
});

test("months are explicit calendar months on the Chicago clock", () => {
  // 03:30 UTC on Nov 1 is still Oct 31 in Chicago.
  assert.equal(currentMonth(new Date("2026-11-01T03:30:00Z")), "2026-10-01");
  assert.equal(currentMonth(new Date("2026-11-01T06:30:00Z")), "2026-11-01");
  assert.equal(parseMonth("2026-11"), "2026-11-01");
  assert.equal(parseMonth("2026-11-17"), "2026-11-01");
  assert.equal(parseMonth("2026-13", new Date("2026-11-05T12:00:00Z")), "2026-11-01");
  assert.equal(parseMonth(undefined, new Date("2026-11-05T12:00:00Z")), "2026-11-01");
  assert.equal(monthOf("2026-10-26"), "2026-10-01");
});

test("each BHG brand site carries the full standard and the total is 24 / 24 / 24 / 3", () => {
  const [c] = groupDelivery(bhg);
  const brands = c.units.filter((u) => u.kind === "brand");
  assert.deepEqual(brands.map((u) => u.name), ["Forklift", "Heavy Equipment", "Safety"]);
  for (const u of brands) assert.deepEqual(Object.fromEntries(Object.entries(u.counts).map(([k, v]) => [k, v.target])), target);
  assert.deepEqual(Object.fromEntries(Object.entries(c.total).map(([k, v]) => [k, v.target])),
    { blog_posts: 24, facebook_posts: 24, gbp_posts: 24, page_refreshes: 3 });
  assert.equal(c.units.at(-1).kind, "unattributed");
  assert.equal(sharesBusinessProfile(c), true);
});

test("work is counted once: brand rows add up to the total, over-target work is kept, unattributed has no target", () => {
  const [c] = groupDelivery(bhg);
  assert.deepEqual(c.total.blog_posts, { target: 24, completed: 12, planned: 1, used: 13, remaining: 11, over: 0 });
  const heavy = c.units.find((u) => u.name === "Heavy Equipment").counts.blog_posts;
  assert.deepEqual({ used: heavy.used, remaining: heavy.remaining, over: heavy.over }, { used: 9, remaining: 0, over: 1 });
  const un = c.units.find((u) => u.kind === "unattributed").counts.facebook_posts;
  assert.equal(countText(un), "2 (no target)");
  assert.equal(c.total.facebook_posts.used, 2);
  assert.equal(c.total.facebook_posts.target, 24);
  assert.equal(countText(c.units.find((u) => u.name === "Safety").counts.blog_posts), "3 / 8");
});

test("a single-site client is one unit; clients stay separate; unknown deliverables are ignored", () => {
  const single = rows(S, [["client", null, "Ginger"]], { "Ginger:page_refreshes": [1, 0] });
  const out = groupDelivery([...bhg, ...single, { ...single[0], deliverable: "instagram_posts" }]);
  assert.equal(out.length, 2);
  const g = out.find((c) => c.clientId === S);
  assert.equal(g.units.length, 1);
  assert.equal(sharesBusinessProfile(g), false);
  assert.deepEqual(g.total.page_refreshes, { target: 1, completed: 1, planned: 0, used: 1, remaining: 0, over: 0 });
  assert.ok(!("instagram_posts" in g.total));
});

test("the loader passes an explicit month and reports a failure instead of 'no standard'", async () => {
  const calls = [];
  const ok = { rpc: async (fn, args) => { calls.push([fn, args]); return { data: bhg, error: null }; } };
  const res = await getDeliveryTargets(ok, M, "2026-11-01");
  assert.deepEqual(calls, [["delivery_targets", { p_client_id: M, p_month: "2026-11-01" }]]);
  assert.equal(res.error, null);
  assert.equal(res.clients[0].total.gbp_posts.target, 24);
  const bad = { rpc: async () => ({ data: null, error: { message: "permission denied" } }) };
  assert.deepEqual(await getDeliveryTargets(bad, M, "2026-11-01"), { clients: [], error: "permission denied" });
  const none = { rpc: async () => ({ data: [], error: null }) };
  assert.deepEqual((await getDeliveryTargets(none, M, "2026-10-01")).clients, []);
});
