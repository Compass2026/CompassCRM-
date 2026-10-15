import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isoWeekLabel,
  isoWeekStart,
  weeklyScanStatus,
} from "../src/lib/map-grid-weekly.ts";

const on = (now, runs = [], attempts = []) =>
  weeklyScanStatus({ enabled: true, weeklyEnabled: true, runs, attempts, now });
// ISO week 2026-W42 runs Mon Oct 12 – Sun Oct 18; its slot is Thu Oct 15 14:00 UTC.
const slot = "2026-10-15T14:00:00Z";

test("ISO weeks start on Monday UTC and label across year boundaries", () => {
  assert.equal(new Date(isoWeekStart(Date.parse(slot))).toISOString(), "2026-10-12T00:00:00.000Z");
  assert.equal(isoWeekLabel(isoWeekStart(Date.parse(slot))), "2026-W42");
  assert.equal(isoWeekLabel(isoWeekStart(Date.parse("2027-01-01T12:00:00Z"))), "2026-W53");
  assert.equal(isoWeekLabel(isoWeekStart(Date.parse("2025-12-30T12:00:00Z"))), "2026-W01");
});

test("profiles not scheduled weekly never alert", () => {
  const s = weeklyScanStatus({ enabled: true, weeklyEnabled: false, runs: [], attempts: [], now: "2026-10-16T12:00:00Z" });
  assert.equal(s.state, "off");
  assert.equal(s.severity, null);
});

test("a complete scan this week, weekly or manual, is ok", () => {
  const s = on("2026-10-16T12:00:00Z", [{ started_at: "2026-10-15T14:00:05Z", status: "complete" }]);
  assert.equal(s.state, "ok");
  assert.equal(s.week, "2026-W42");
  assert.equal(on("2026-10-16T12:00:00Z", [{ started_at: "2026-10-13T09:00:00Z", status: "complete" }]).state, "ok");
});

test("before Thursday's slot the previous week is judged", () => {
  // Monday of W43: last week's complete scan keeps it green.
  const ok = on("2026-10-19T09:00:00Z", [{ started_at: "2026-10-15T14:00:05Z", status: "complete" }]);
  assert.equal(ok.state, "ok");
  assert.equal(ok.week, "2026-W42");
  // Monday of W43 with nothing for W42: missed, critical (no start recorded).
  const missed = on("2026-10-19T09:00:00Z", [{ started_at: "2026-10-08T14:00:05Z", status: "complete" }]);
  assert.equal(missed.state, "missed");
  assert.equal(missed.severity, "critical");
  assert.match(missed.detail, /No weekly start was recorded for 2026-W42/);
  assert.equal(missed.lastSuccessAt, "2026-10-08T14:00:05Z");
});

test("during the slot window: due, then scanning, then missed if never started", () => {
  assert.equal(on("2026-10-15T14:20:00Z").state, "due");
  const running = on("2026-10-15T15:00:00Z", [{ started_at: "2026-10-15T14:00:05Z", status: "running" }],
    [{ outcome: "started", message: null, attempted_at: "2026-10-15T14:00:03Z" }]);
  assert.equal(running.state, "scanning");
  assert.equal(running.severity, null);
  const silent = on("2026-10-15T15:30:00Z");
  assert.equal(silent.state, "missed");
  assert.equal(silent.severity, "critical");
});

test("a recorded start error alerts immediately with its message", () => {
  const s = on("2026-10-15T14:05:00Z", [],
    [{ outcome: "error", message: "Grid keyword mismatch", attempted_at: "2026-10-15T14:00:03Z" }]);
  assert.equal(s.state, "missed");
  assert.equal(s.severity, "critical");
  assert.equal(s.detail, "Grid keyword mismatch");
});

test("after the settle window a partial or skipped week is missed, with the reason", () => {
  const partial = on("2026-10-15T22:00:00Z",
    [{ started_at: "2026-10-15T14:00:05Z", status: "partial", error: "Some checks did not complete; missing checks are not ranking losses" }],
    [{ outcome: "started", message: null, attempted_at: "2026-10-15T14:00:03Z" }]);
  assert.equal(partial.state, "missed");
  assert.equal(partial.severity, "attention");
  assert.match(partial.detail, /ended partial/);
  const cooldown = on("2026-10-16T09:00:00Z", [],
    [{ outcome: "cooldown", message: "Wait one hour before starting another scan", attempted_at: "2026-10-15T14:00:03Z" }]);
  assert.equal(cooldown.state, "missed");
  assert.match(cooldown.detail, /another scan started within the hour/);
});
