// The monthly delivery standard's typed model (src/lib/delivery-standard.ts):
// explicit months on the Chicago calendar, per-brand units and the client
// total counted once, and the loader failing loudly. The SQL side is
// supabase/tests/sandbox/delivery_standard.test.sql.
import { test } from "node:test";
import assert from "node:assert/strict";
import { countText, currentMonth, getDeliveryTargets, groupDelivery, monthOf, parseMonth, remainingFor, sharedBusinessProfile, totalText } from "../src/lib/delivery-standard.ts";
import { standardWeekTargets, summarize, WEEKLY_TARGETS } from "../src/lib/content-planner.ts";

const M = "00000000-0000-4000-d500-00000000000a";
const S = "00000000-0000-4000-d500-00000000000b";
const target = { blog_posts: 8, facebook_posts: 8, gbp_posts: 8, page_refreshes: 1 };
function rows(clientId, units, work = {}, dest = {}) {
  return units.flatMap(([kind, id, name]) => Object.entries(target).map(([deliverable, t]) => {
    const [completed, planned, unverified = 0] = work[`${name}:${deliverable}`] ?? [0, 0];
    const tgt = kind === "unattributed" ? 0 : t;
    return {
      client_id: clientId, month: "2026-11-01", unit_kind: kind, brand_workspace_id: id, unit_name: name, deliverable,
      target: tgt, completed, planned, used: completed + planned, remaining: Math.max(0, tgt - completed - planned),
      over_target: Math.max(0, completed + planned - tgt), unverified, destination: dest[`${name}:${deliverable}`] ?? null,
      standard_version: 1, source_ref: "executive_os:decision",
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
});

test("totals keep each site's shortfall: one brand's surplus and unattributed work never cover another brand", () => {
  // Safety 2 done + 1 planned (5 short), Forklift 1 (7 short), Heavy Equipment 9 (1 over), 2 unattributed.
  const [c] = groupDelivery(bhg);
  assert.deepEqual(c.total.blog_posts, { target: 24, completed: 12, planned: 1, used: 13, remaining: 12, over: 1, credited: 11, unverified: 0 });
  assert.equal(totalText(c.total.blog_posts), "11 / 24 delivered · 1 planned · 12 not yet planned · 1 beyond a site's target");
  const heavy = c.units.find((u) => u.name === "Heavy Equipment").counts.blog_posts;
  assert.deepEqual({ used: heavy.used, remaining: heavy.remaining, over: heavy.over, credited: heavy.credited }, { used: 9, remaining: 0, over: 1, credited: 8 });
  // Unattributed: shown on its own, never in the total or a brand.
  assert.equal(c.unattributed.facebook_posts.used, 2);
  assert.equal(c.total.facebook_posts.used, 0);
  assert.equal(c.total.facebook_posts.remaining, 24);
  assert.equal(countText(c.units.find((u) => u.kind === "unattributed").counts.facebook_posts), "2 (no target)");
  assert.equal(countText(c.units.find((u) => u.name === "Safety").counts.blog_posts), "3 / 8");
  assert.equal(remainingFor(c, "blog_posts"), 12);
  assert.equal(remainingFor(null, "blog_posts"), 0);
});

test("refreshes approved without a live receipt are carried as unverified, not credited", () => {
  const [c] = groupDelivery(rows(M, [["brand", "a", "Safety"], ["brand", "b", "Forklift"]], { "Safety:page_refreshes": [0, 2, 2], "Forklift:page_refreshes": [1, 0, 0] }));
  assert.deepEqual({ credited: c.total.page_refreshes.credited, remaining: c.total.page_refreshes.remaining, unverified: c.total.page_refreshes.unverified, over: c.total.page_refreshes.over },
    { credited: 1, remaining: 0, unverified: 2, over: 1 });
  assert.equal(c.units.find((u) => u.name === "Safety").counts.page_refreshes.credited, 0);
  assert.equal(c.units.find((u) => u.name === "Safety").counts.page_refreshes.completed, 0);
});

test("a shared Business Profile is stated only from a recorded destination, never from having several brands", () => {
  const units = [["brand", "a", "Safety"], ["brand", "b", "Forklift"], ["brand", "c", "Heavy Equipment"]];
  assert.equal(sharedBusinessProfile(groupDelivery(rows(M, units))[0]), null);
  const gbp = { "Safety:gbp_posts": "BHG (verified)", "Forklift:gbp_posts": "BHG (verified)", "Heavy Equipment:gbp_posts": "BHG (verified)" };
  assert.equal(sharedBusinessProfile(groupDelivery(rows(M, units, {}, gbp))[0]), "BHG (verified)");
  // Different or partial destinations are not one shared profile.
  assert.equal(sharedBusinessProfile(groupDelivery(rows(M, units, {}, { ...gbp, "Forklift:gbp_posts": "Other" }))[0]), null);
  assert.equal(sharedBusinessProfile(groupDelivery(rows(M, units, {}, { "Safety:gbp_posts": "BHG (verified)" }))[0]), null);
  const c = groupDelivery(rows(M, units, {}, { "Safety:facebook_posts": "Safety Page" }))[0];
  assert.equal(c.units.find((u) => u.name === "Safety").destinations.facebook_posts, "Safety Page");
  assert.equal(c.units.find((u) => u.name === "Forklift").destinations.facebook_posts, null);
});

test("a week on the standard is measured against its planned slots, not 2/2/2/1", () => {
  const slots = [
    { deliverable: "blog", standard_key: "blog_posts" }, { deliverable: "blog", standard_key: "blog_posts" },
    { deliverable: "blog", standard_key: "blog_posts" }, { deliverable: "social", standard_key: "facebook_posts" },
    { deliverable: "web_page", standard_key: "page_refreshes" }, { deliverable: "blog", standard_key: null },
  ];
  assert.deepEqual(standardWeekTargets(slots), { social: 1, gbp: 0, blog: 3, web_page: 1 });
  const s = summarize([{ deliverable: "blog", status: "approved" }], standardWeekTargets(slots));
  assert.deepEqual({ target: s.blog.target, done: s.blog.done, unplanned: s.blog.unplanned, gbpTarget: s.gbp.target }, { target: 3, done: 1, unplanned: 2, gbpTarget: 0 });
  assert.equal(summarize([]).blog.target, WEEKLY_TARGETS.blog);
});

test("a single-site client is one unit; clients stay separate; unknown deliverables are ignored", () => {
  const single = rows(S, [["client", null, "Ginger"]], { "Ginger:page_refreshes": [1, 0] });
  const out = groupDelivery([...bhg, ...single, { ...single[0], deliverable: "instagram_posts" }]);
  assert.equal(out.length, 2);
  const g = out.find((c) => c.clientId === S);
  assert.equal(g.units.length, 1);
  assert.deepEqual(g.total.page_refreshes, { target: 1, completed: 1, planned: 0, used: 1, remaining: 0, over: 0, credited: 1, unverified: 0 });
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
