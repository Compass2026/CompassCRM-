// Reporting keeps actual and included apart (src/lib/reporting-activity.ts,
// B5): delivered work from the work records, included from the agreement;
// Business Profile posts are their own count, never social. Pure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { actualInMonth, actualText, includedPerMonth, includedText, monthActivity } from "../src/lib/reporting-activity.ts";
import { entitlementSet } from "../src/lib/entitlements.ts";

const q = (key, enabled, quantity) => ({ client_id: "c", service_key: key, service_name: key, kind: "quota", enabled, quantity, unit: "posts", period: "month", source: "package", package_id: null });
const set = entitlementSet("c", [q("blog_posts", true, 4), q("social_posts", true, 8), q("gbp_posts", false, 0)]);
const blog = [{ published_at: "2026-09-03" }, { published_at: "2026-09-20" }, { published_at: "2026-08-30" }, { published_at: null }];
const social = [
  { published_at: "2026-09-02T15:00:00Z", platform: "facebook" },
  { published_at: "2026-09-05T15:00:00Z", platform: "google_business" },
  { published_at: "2026-09-07T15:00:00Z", platform: "google_business" },
  { published_at: "2026-08-07T15:00:00Z", platform: "instagram" },
];

test("20 actual and included are separate, and GBP is not social", () => {
  const m = monthActivity("2026-09-01", blog, social, set);
  assert.deepEqual(m.actual, { blog: 2, social: 1, gbp: 2 });
  assert.deepEqual(m.included, { blog: 4, social: 8, gbp: 0 });
  // Delivered beyond what is included is still reported as delivered.
  assert.equal(actualText(m.actual), "2 blog · 1 social · 2 Business Profile published");
  assert.equal(includedText(m.included), "Included each month: 4 blog · 8 social posts");
});

test("20b actual does not depend on the agreement; included does not depend on the work", () => {
  assert.deepEqual(monthActivity("2026-09", blog, social, null).actual, actualInMonth("2026-09", blog, social));
  assert.deepEqual(includedPerMonth(set), monthActivity("2026-08", [], [], set).included);
  assert.match(includedText(null), /unknown/);
  assert.equal(includedText(includedPerMonth(entitlementSet("c", []))), "Included each month: no posts in the agreement");
});
