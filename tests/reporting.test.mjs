import { test } from "node:test";
import assert from "node:assert/strict";
import { compareMeasurements, formatMeasurement, parseMeasurement, previousMonth, scorecardRows, REPORT_AREAS } from "../src/lib/reporting.ts";

const client = "00000000-0000-4000-8000-000000000001";
const base = {
  client_id: client, id: "00000000-0000-4000-8000-000000000002", sequence: 1,
  metric: "search_clicks", scope: "example.test, web, country US", source: "GSC export",
  platform: "none", channel: "none", context: "existing_client", report_period: "2026-08-01",
  window_start: "2026-08-01", window_end: "2026-08-31", status: "measured", value: 10,
  evidence: "Fixture export", meaning: "Verified clicks", next_action: "Review queries",
  created_at: "2026-09-01T00:00:00Z", recorded_by: client,
};
function row(overrides = {}) { return { ...base, ...overrides }; }
function form(overrides = {}) {
  const input = { ...base, report_period: "2026-08", value: "10", ...overrides };
  const data = new FormData();
  for (const [key, value] of Object.entries(input)) data.set(key, String(value));
  return data;
}
const current = row({ id: "00000000-0000-4000-8000-000000000003", sequence: 2, report_period: "2026-09-01", window_start: "2026-09-01", window_end: "2026-09-30", value: 20 });

test("nine areas include social, reviews and qualified leads", () => {
  assert.equal(REPORT_AREAS.length, 9);
  assert.ok(REPORT_AREAS.some((a) => a.key === "social"));
  assert.equal(new Set(REPORT_AREAS.flatMap((a) => a.metrics.map(([key]) => key))).size, 31);
});
test("zero is measured; unavailable data cannot masquerade as zero", () => {
  assert.equal(parseMeasurement(client, form({ value: "0" })).value, 0);
  assert.equal(formatMeasurement(row({ value: 0 })), "0");
  assert.equal(formatMeasurement(), "Not measured");
  for (const status of ["not_measured", "not_connected", "stale", "not_applicable"]) {
    assert.equal(parseMeasurement(client, form({ status, value: "" })).value, null);
    assert.throws(() => parseMeasurement(client, form({ status, value: "0" })));
  }
});
test("input rejects invalid dates, windows, metrics and missing evidence", () => {
  for (const patch of [
    { window_end: "2026-02-30" }, { window_start: "2026-09-02" },
    { window_end: "2099-01-01" }, { metric: "invented" }, { evidence: "" },
    { value: "NaN" }, { value: "Infinity" }, { value: "" }, { value: "-1" }, { value: "1.2" },
    { report_period: "2026-07" }, { metric: "pages_live" }, { status: "__proto__" },
  ]) assert.throws(() => parseMeasurement(client, form(patch)));
  assert.equal(parseMeasurement(client, form({ metric: "reviews_rating", value: "4.6", window_start: "2026-08-31" })).value, 4.6);
  assert.throws(() => parseMeasurement(client, form({ metric: "reviews_rating", value: "5.1", window_start: "2026-08-31" })));
});
test("social requires platform/channel; net followers can be negative", () => {
  assert.throws(() => parseMeasurement(client, form({ metric: "social_followers" })));
  assert.equal(parseMeasurement(client, form({ metric: "social_followers", platform: "linkedin", channel: "organic", value: "-3" })).value, -3);
  assert.throws(() => parseMeasurement(client, form({ platform: "linkedin", channel: "organic" })));
});
test("comparable full calendar months permit a delta and disclose day counts", () => {
  assert.deepEqual(compareMeasurements(current, base), { delta: 10, reason: "Calendar months (day counts may differ)" });
});
test("different sources, clients, scopes, platforms and channels cannot be compared", () => {
  for (const patch of [{ source: "other" }, { scope: "different keywords" }, { client_id: "other-client" }, { platform: "facebook" }, { channel: "paid" }]) {
    assert.equal(compareMeasurements(row({ ...current, ...patch }), base).delta, null);
  }
});
test("overlap, unequal partial windows and unavailable measurements suppress change", () => {
  for (const patch of [{ window_start: "2026-08-31" }, { window_start: "2026-09-02" }, { status: "stale", value: null }]) {
    assert.equal(compareMeasurements(row({ ...current, ...patch }), base).delta, null);
  }
  assert.equal(compareMeasurements(base, base).delta, null);
  assert.equal(compareMeasurements(current).delta, null);
});
test("first measured baseline survives later corrections and backdating", () => {
  const unavailable = row({ id: "missing", sequence: 0, status: "not_connected", value: null });
  const correction = row({ id: "correction", sequence: 3, value: 15, window_end: "2026-08-30" });
  const [result] = scorecardRows([correction, current, unavailable, base], client, "2026-09-01");
  assert.equal(result.baseline.id, base.id);
  assert.equal(result.previous.id, correction.id);
  assert.equal(result.current.id, current.id);
  assert.equal(result.sinceBaseline.delta, 10);
});
test("missing previous month is not substituted with an older result; clients stay separate", () => {
  const [result] = scorecardRows([base, current, row({ client_id: "another-client" })], client, "2026-11-01");
  assert.equal(result.previous, undefined);
  assert.equal(result.current, undefined);
  assert.equal(result.history.length, 2);
  assert.equal(result.baseline.id, base.id);
  assert.equal(scorecardRows([current], client, "2026-08-01")[0].baseline, undefined);
  assert.equal(previousMonth("2026-01-01"), "2025-12-01");
});
