// The entitlement contract's typed model (src/lib/entitlements.ts, B5): rows
// from client_entitlements_for() into a set, not-included-means-zero, the
// monthly arithmetic, planning within the agreement, mid-month changes, and
// the loaders failing safe. Pure (the loaders take a fake Supabase client);
// the SQL side is supabase/tests/sandbox/billing_entitlements_portal.test.sql.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FEATURE_KEYS, QUOTA_KEYS, EntitlementsUnavailable, entitlementSet, includes, monthlyAllocation, remainingAllocation,
  usageFrom, targetText, planWork, serviceScope, getClientEntitlements, getClientEntitlement, getEntitlementsForClients,
  getQuotaUsage, getClientAgreement, usageByKey,
} from "../src/lib/entitlements.ts";

const C = "00000000-0000-4000-b000-00000000000a";
const PKG = "00000000-0000-4000-e000-000000000001";
const CATALOG = [
  ["seo", "SEO", "feature"], ["website", "Website Management", "feature"], ["gbp", "Google Business Profile", "feature"],
  ["social", "Social Media", "feature"], ["paid_ads", "Paid Advertising", "feature"], ["crm", "CRM", "feature"],
  ["reporting", "Monthly Reporting", "feature"], ["client_portal", "Client Portal", "feature"], ["hosting", "Website Hosting", "feature"],
  ["blog_posts", "Blog Posts", "quota"], ["website_pages", "New Website Pages", "quota"], ["website_refreshes", "Website Page Refreshes", "quota"],
  ["gbp_posts", "Google Business Profile Posts", "quota"], ["social_posts", "Social Media Posts", "quota"],
];
// Rows as client_entitlements_for() returns them: `given` is {key: [enabled,
// quantity, source]}; everything else is not included (source none, 0).
function rows(given, clientId = C) {
  return CATALOG.map(([key, name, kind], i) => {
    const g = given[key];
    const enabled = g ? g[0] : false;
    return {
      client_id: clientId, service_key: key, service_name: name, kind, enabled,
      quantity: kind === "quota" ? (enabled ? g[1] : 0) : null,
      unit: kind === "quota" ? "posts" : null, period: kind === "quota" ? "month" : null,
      source: g ? g[2] ?? "package" : "none", package_id: g ? PKG : null, sort_order: i,
    };
  });
}
const growth = {
  seo: [true], website: [true], gbp: [true], social: [false, null],
  blog_posts: [true, 4], gbp_posts: [true, 4], website_pages: [true, 2], social_posts: [false, 0],
};
const fake = (result) => ({ calls: [], rpc(fn, args) { this.calls.push({ fn, args }); return Promise.resolve(typeof result === "function" ? result(fn, args) : result); } });

test("the service keys are the nine features and five quotas", () => {
  assert.deepEqual([...FEATURE_KEYS].sort(), ["client_portal", "crm", "gbp", "hosting", "paid_ads", "reporting", "seo", "social", "website"]);
  assert.deepEqual([...QUOTA_KEYS].sort(), ["blog_posts", "gbp_posts", "social_posts", "website_pages", "website_refreshes"]);
  assert.deepEqual(CATALOG.map((c) => c[0]).sort(), [...FEATURE_KEYS, ...QUOTA_KEYS].sort());
});

test("1 a package feature is included", () => {
  const s = entitlementSet(C, rows(growth));
  assert.equal(includes(s, "seo"), true);
  assert.equal(s.byKey.seo.source, "package");
  assert.equal(s.packageId, PKG);
});

test("2 a package quota is its monthly allocation", () => {
  const s = entitlementSet(C, rows(growth));
  assert.equal(monthlyAllocation(s, "blog_posts"), 4);
  assert.equal(includes(s, "blog_posts"), true);
});

test("3-4 client overrides win over the package, for features and quotas", () => {
  const s = entitlementSet(C, rows({ ...growth, social: [true, null, "client_override"], social_posts: [true, 8, "client_override"] }));
  assert.equal(includes(s, "social"), true);
  assert.equal(s.byKey.social.source, "client_override");
  assert.equal(monthlyAllocation(s, "social_posts"), 8);
});

test("5 disabled means not included and 0, never unlimited", () => {
  const s = entitlementSet(C, rows(growth));
  assert.equal(includes(s, "social"), false);
  assert.equal(monthlyAllocation(s, "social_posts"), 0);
  // Even a disabled row that somehow carried a quantity allocates nothing.
  const odd = entitlementSet(C, rows(growth).map((r) => r.service_key === "social_posts" ? { ...r, quantity: 50 } : r));
  assert.equal(monthlyAllocation(odd, "social_posts"), 0);
});

test("6 missing means not included: absent services and unknown keys are 0", () => {
  const s = entitlementSet(C, rows(growth));
  assert.equal(monthlyAllocation(s, "website_refreshes"), 0);
  assert.equal(s.byKey.website_refreshes.source, "none");
  const empty = entitlementSet(C, []);
  for (const k of QUOTA_KEYS) assert.equal(monthlyAllocation(empty, k), 0);
  for (const k of FEATURE_KEYS) assert.equal(includes(empty, k), false);
  const none = entitlementSet(C, rows({}));
  assert.deepEqual(serviceScope(none).included, []);
  assert.equal(serviceScope(none).notIncluded.length, 14);
});

test("7-9 the typed model has no billing input: status fields on a row are ignored", () => {
  // A row carrying billing-shaped extras (as a buggy caller might pass) changes nothing.
  const polluted = rows(growth).map((r) => ({ ...r, billing_state: "past_due", billing_attention: true, subscription_status: "unpaid" }));
  assert.deepEqual(entitlementSet(C, polluted).byKey, entitlementSet(C, rows(growth)).byKey);
});

test("10 typed helpers: getClientEntitlements / getClientEntitlement read client_entitlements_for", async () => {
  const sb = fake({ data: rows(growth), error: null });
  const s = await getClientEntitlements(sb, C);
  assert.deepEqual(sb.calls, [{ fn: "client_entitlements_for", args: { p_client_id: C } }]);
  assert.equal(monthlyAllocation(s, "gbp_posts"), 4);
  const one = await getClientEntitlement(fake({ data: rows(growth), error: null }), C, "website_refreshes");
  assert.deepEqual([one.enabled, one.quantity, one.source], [false, 0, "none"]);
});

test("10b fail safe: an error or no rows is EntitlementsUnavailable, never an empty agreement", async () => {
  await assert.rejects(getClientEntitlements(fake({ data: null, error: { message: "permission denied" } }), C), EntitlementsUnavailable);
  await assert.rejects(getClientEntitlements(fake({ data: [], error: null }), C), /not visible/);
  await assert.rejects(getQuotaUsage(fake({ data: null, error: { message: "boom" } }), C), EntitlementsUnavailable);
  const a = await getClientAgreement(fake({ data: null, error: { message: "boom" } }), C);
  assert.equal(a.set, null);
  assert.match(a.unavailable, /boom/);
});

test("10c the bulk read is one call for every client (no N+1)", async () => {
  const other = "00000000-0000-4000-b000-00000000000b";
  const sb = fake({ data: [...rows(growth), ...rows({ seo: [true] }, other)], error: null });
  const m = await getEntitlementsForClients(sb);
  assert.equal(sb.calls.length, 1);
  assert.deepEqual(sb.calls[0], { fn: "client_entitlements_for", args: {} });
  assert.equal(m.size, 2);
  assert.equal(monthlyAllocation(m.get(C), "blog_posts"), 4);
  assert.equal(monthlyAllocation(m.get(other), "blog_posts"), 0);
});

test("11 remaining = allocation − used, never negative", () => {
  assert.equal(remainingAllocation(4, 0), 4);
  assert.equal(remainingAllocation(4, 3), 1);
  assert.equal(remainingAllocation(4, 9), 0);
  assert.equal(remainingAllocation(0, 0), 0);
  assert.deepEqual(usageFrom(4, 1, 2), { allocation: 4, completed: 1, planned: 2, used: 3, remaining: 1, overAllocation: 0 });
});

test("12 planned work reduces what automation may add", () => {
  const s = entitlementSet(C, rows(growth));
  assert.deepEqual(planWork(s, { blog_posts: { used: 1 } }, "blog_post", 4),
    { status: "within_allocation", allowed: 3, allocation: 4, used: 1, remaining: 3 });
});

test("13 completed work prevents duplicates: nothing more once the allocation is used", () => {
  const s = entitlementSet(C, rows(growth));
  const d = planWork(s, { blog_posts: { used: 4 } }, "blog_post");
  assert.equal(d.status, "allocation_used");
  assert.equal(d.allowed, 0);
});

test("14 mid-month increase opens room at once", () => {
  const raised = entitlementSet(C, rows({ ...growth, blog_posts: [true, 6, "client_override"] }));
  assert.equal(planWork(raised, { blog_posts: { used: 4 } }, "blog_post").allowed, 1);
  assert.equal(planWork(raised, { blog_posts: { used: 4 } }, "blog_post", 5).allowed, 2);
});

test("15-16 mid-month decrease: remaining 0, the excess reported, nothing removed", () => {
  const lowered = entitlementSet(C, rows({ ...growth, blog_posts: [true, 2, "client_override"] }));
  const u = usageFrom(monthlyAllocation(lowered, "blog_posts"), 3, 2);
  assert.deepEqual(u, { allocation: 2, completed: 3, planned: 2, used: 5, remaining: 0, overAllocation: 3 });
  assert.equal(planWork(lowered, { blog_posts: u }, "blog_post").allowed, 0);
  assert.equal(targetText(u), "5 / 2 planned");
});

test("17 human extra work is counted, never refused", () => {
  // The model has no refusal for people: extra work only shows as over allocation.
  const u = usageFrom(4, 4, 3);
  assert.equal(u.overAllocation, 3);
  assert.equal(targetText({ allocation: 0, used: 2 }), "2 (not included)");
  assert.equal(targetText({ allocation: 0, used: 0 }), "not included");
  assert.equal(targetText({ allocation: 4, used: 3 }), "3 / 4 planned");
});

test("feature = false means no automatic work of that kind, whatever the quota", () => {
  const noGbp = entitlementSet(C, rows({ ...growth, gbp: [false, null, "client_override"] }));
  assert.equal(planWork(noGbp, {}, "gbp_post").status, "not_in_agreement");
  const noWebsite = entitlementSet(C, rows({ ...growth, website: [false, null, "client_override"] }));
  assert.equal(planWork(noWebsite, {}, "new_page").status, "not_in_agreement");
  assert.equal(planWork(entitlementSet(C, rows(growth)), {}, "new_page").allowed, 1);
  assert.equal(planWork(entitlementSet(C, rows(growth)), {}, "social_post").status, "not_in_agreement");
});

test("quota usage rows map to the typed model, keyed by quota", async () => {
  const sb = fake({ data: [
    { client_id: C, service_key: "blog_posts", service_name: "Blog Posts", month: "2026-09-01", allocation: 4, completed: 2, planned: 1, used: 3, remaining: 1, over_allocation: 0 },
    { client_id: C, service_key: "not_a_quota", service_name: "x", month: "2026-09-01", allocation: 0, completed: 0, planned: 0, used: 0, remaining: 0, over_allocation: 0 },
  ], error: null });
  const u = await getQuotaUsage(sb, C, "2026-09-01");
  assert.deepEqual(sb.calls[0], { fn: "client_quota_usage", args: { p_client_id: C, p_month: "2026-09-01" } });
  assert.equal(u.length, 1);
  assert.equal(usageByKey(u).blog_posts.remaining, 1);
  assert.equal(targetText(usageByKey(u).blog_posts), "3 / 4 planned");
});
