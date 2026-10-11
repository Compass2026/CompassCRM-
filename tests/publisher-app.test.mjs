// The app's view of the publisher (0046): settings parsing and which runs the
// Brief's Publishing card shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { approvedChannelProblems, latestPerPost, needsAttention, parsePublisherSettings, zernioRoute } from "../src/lib/publisher.ts";
import { availableActions } from "../src/lib/social-posts.ts";

test("the switch is off unless explicitly on; the pilot list keeps only ids", () => {
  assert.deepEqual(parsePublisherSettings(null), { enabled: false, clients: [] });
  assert.deepEqual(parsePublisherSettings({ enabled: "true", clients: "x" }), { enabled: false, clients: [] });
  assert.deepEqual(parsePublisherSettings({ enabled: true, clients: ["a", 3, "b"] }), { enabled: true, clients: ["a", "b"] });
});

test("the Brief shows a post's latest run only when a person must act", () => {
  const r = (post_id, outcome, created_at, o = {}) => ({ post_id, client_id: "c", outcome, transient: false, detail: null, created_at, task_id: null, ...o });
  const latest = latestPerPost([
    r("p1", "blocked", "2026-09-24T10:00:00Z"),
    r("p1", "published", "2026-09-24T11:00:00Z"),
    r("p2", "failed", "2026-09-24T10:00:00Z", { transient: true }),
    r("p3", "failed", "2026-09-24T10:00:00Z", { transient: true, task_id: "t" }),
    r("p4", "failed", "2026-09-24T10:00:00Z", { http_status: 400 }),
    r("p5", "lapsed", "2026-09-24T09:00:00Z"),
    r("p6", "retry_scheduled", "2026-09-24T09:00:00Z"),
    r("p7", "ambiguous", "2026-09-24T09:00:00Z", { task_id: "t7" }),
    r("p8", "uncertain", "2026-09-24T09:00:00Z"),
  ]);
  assert.deepEqual(needsAttention(latest).map((x) => x.post_id).sort(), ["p3", "p4", "p5", "p7"]);
});

test("the post page shows the publisher's own channel rules on the approved snapshot", () => {
  assert.deepEqual(approvedChannelProblems(null), []);
  const snap = { platform: "google_business", post_type: "standard", copy: "x".repeat(1501), cta_type: null, cta_url: null, assets: [] };
  assert.equal(approvedChannelProblems(snap).length, 1);
});

// Zernio Social Publisher v1: the post page offers Publish now for a Facebook
// post exactly when the publisher would send it, and not Mark published then.
test("Facebook: Publish now only when the switch, pilot list and the Page's enabled binding all hold", () => {
  const C = "102d3b20-2795-44ae-bd64-d1e43916291c";
  const b = (o = {}) => ({ id: "fa", client_id: C, platform: "facebook", external_account_id: "103977857788955", display_name: "LUCAS Construction",
    publish_provider: "zernio", publish_account_id: "6ac6efe9621dc76465184742", publish_page_id: "103977857788955", publish_account_name: "LUCAS Construction",
    publish_enabled: true, publish_verified_at: "2026-10-10T22:53:13Z", publish_health: { status: "healthy" }, ...o });
  const post = { platform: "facebook", client_id: C, social_account_id: "fa" };
  const on = { enabled: true, clients: [C] };
  assert.deepEqual(zernioRoute(post, b(), on), { ready: true, reasons: [] });
  assert.match(zernioRoute(post, b(), { enabled: false, clients: [C] }).reasons.join(), /switched off/);
  assert.match(zernioRoute(post, b(), { enabled: true, clients: [] }).reasons.join(), /pilot list/);
  assert.match(zernioRoute(post, b({ publish_enabled: false }), on).reasons.join(), /switched off/);
  assert.match(zernioRoute(post, b({ client_id: "other" }), on).reasons.join(), /another client/);
  assert.match(zernioRoute(post, null, on).reasons.join(), /not in Compass/);
  assert.equal(zernioRoute({ ...post, platform: "instagram" }, b(), on).ready, false);

  const approved = { review_status: "approved", publish_status: "not_scheduled", platform: "facebook" };
  assert.ok(availableActions({ ...approved, zernio_ready: true }).includes("publish_now"));
  assert.ok(!availableActions({ ...approved, zernio_ready: true }).includes("mark_published"), "not posted by hand while the publisher sends it");
  assert.ok(availableActions({ ...approved, publish_status: "failed", zernio_ready: true }).includes("mark_published"), "a person can record one found on the Page");
  assert.ok(!availableActions({ ...approved, zernio_ready: false }).includes("publish_now"));
  assert.ok(availableActions({ ...approved, zernio_ready: false }).includes("mark_published"));
  assert.ok(availableActions({ ...approved, platform: "google_business" }).includes("publish_now"), "Business Profile unchanged");
});
