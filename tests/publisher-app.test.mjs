// The app's view of the publisher (0046): settings parsing and which runs the
// Brief's Publishing card shows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { approvedChannelProblems, latestPerPost, needsAttention, parsePublisherSettings } from "../src/lib/publisher.ts";

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
