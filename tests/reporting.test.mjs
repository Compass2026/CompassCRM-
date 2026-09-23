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

// ── Release fixes (Sept 22): Central-time "today", 0041 transaction shape ──
import { readFileSync } from "node:fs";
import { agencyToday } from "../src/lib/reporting.ts";

test("today is Compass's day (America/Chicago), not UTC's", () => {
  // 03:30 UTC on Sept 23 is still Sept 22 in Chicago.
  assert.equal(agencyToday(new Date("2026-09-23T03:30:00Z")), "2026-09-22");
  assert.equal(agencyToday(new Date("2026-09-23T15:00:00Z")), "2026-09-23");
});
test("a measurement ending on Chicago's today is accepted; Chicago's tomorrow is not", () => {
  const today = "2026-09-22";
  const point = { metric: "pages_live", window_start: today, window_end: today, report_period: "2026-09" };
  assert.equal(parseMeasurement(client, form(point), today).window_end, today);
  assert.throws(() => parseMeasurement(client, form({ ...point, window_start: "2026-09-23", window_end: "2026-09-23" }), today));
});
test("0041 leaves the transaction to apply_migration and stamps its own audit columns", () => {
  const sql = readFileSync("supabase/migrations/0041_client_report_measurements.sql", "utf8");
  const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(code, /^\s*(begin|commit|rollback)\s*;/im, "no BEGIN/COMMIT in the migration");
  assert.match(code, /at time zone 'America\/Chicago'/, "future-date check uses Compass's day");
  for (const col of ["sequence bigint not null unique default 0", "created_at timestamptz not null default now()", "recorded_by text not null default ''"]) {
    assert.ok(code.includes(col), col);
  }
  assert.match(code, /new\.sequence := nextval/);
  assert.match(code, /new\.created_at := clock_timestamp\(\)/);
  assert.match(code, /new\.recorded_by := coalesce\(auth\.uid\(\)::text/);
  assert.match(code, /references public\.clients\(id\) on delete restrict/, "clients with history cannot be deleted");
});
test("the scorecard says its numbers are recorded by hand", () => {
  const ui = readFileSync("src/components/client-scorecard.tsx", "utf8");
  assert.match(ui, /Recorded by hand\./);
  assert.match(ui, /does not read the rank-tracking or Search Console snapshots/);
});
test("the worker's baseline rule applies to new clients only and never pauses silently", () => {
  const skill = readFileSync(".claude/skills/foundation-worker/SKILL.md", "utf8");
  const rule = skill.slice(skill.indexOf("**Baseline before improvements: new clients only"), skill.indexOf("with fnd as ("));
  assert.ok(rule.length > 0, "rule present");
  assert.match(rule, /tasks\.key = 'reporting_baseline'/, "new = has the intake task");
  assert.match(rule, /Every other client is existing: nothing here pauses or gates their work\./);
  assert.match(rule, /reporting_baseline_access/, "missing access becomes a task for Tom");
  assert.match(rule, /never a\s+reason to stop|is never a\s+reason to stop/);
  assert.match(rule, /Block \*\*only the asset-changing stage\*\*/);
  assert.doesNotMatch(skill, /Pause client-asset improvements/);
});
test("the validation workflow is read-only and uses no secrets", () => {
  const wf = readFileSync(".github/workflows/validate.yml", "utf8");
  assert.match(wf, /permissions:\s*\n\s*contents: read\s*\n/);
  assert.doesNotMatch(wf, /secrets\./);
  assert.doesNotMatch(wf, /write/);
});
