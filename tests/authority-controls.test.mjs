// The Authority tab's run controls (src/lib/authority-controls.ts): which
// button may be pressed and why not, how the authority-run function's answer
// is reported, and what a finished run says. Pure: no network, no database.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  controlsState, activeRun, startOutcome, finishMessage, HELPER_TEXT, STUCK_AFTER_MS,
} from "../src/lib/authority-controls.ts";

const NOW = new Date("2026-09-26T12:00:00Z");
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const base = (over = {}) => ({
  clientStatus: "active", hasCompletedRun: true, staleSections: [], inventoryStale: false,
  runs: [{ id: "c1", mode: "full", created_at: ago(86_400_000), status: "completed" }], now: NOW, ...over,
});

test("current results: both enabled, Run Full Analysis primary, helper text shown", () => {
  const s = controlsState(base());
  assert.equal(s.visible, true);
  assert.deepEqual([s.full.enabled, s.full.primary, s.refresh.enabled, s.refresh.primary], [true, true, true, false]);
  assert.equal(s.helper, HELPER_TEXT);
  assert.equal(HELPER_TEXT, "Full analysis crawls the website again. Refresh rechecks current business and search data using the latest site snapshot.");
});

test("no completed run: Refresh disabled with the reason", () => {
  const s = controlsState(base({ hasCompletedRun: false, runs: [] }));
  assert.equal(s.full.enabled, true);
  assert.deepEqual([s.refresh.enabled, s.refresh.reason], [false, "Needs a full analysis first."]);
});

test("site changed or snapshot older than 14 days: Refresh disabled, Full primary", () => {
  const site = controlsState(base({ staleSections: ["site", "keywords"] }));
  assert.equal(site.refresh.enabled, false);
  assert.match(site.refresh.reason, /site record changed/);
  assert.equal(site.full.primary, true);
  const old = controlsState(base({ inventoryStale: true }));
  assert.equal(old.refresh.enabled, false);
  assert.match(old.refresh.reason, /more than 14 days old/);
});

test("only CRM or Search Console data changed: Refresh becomes primary", () => {
  const s = controlsState(base({ staleSections: ["keywords", "gsc"] }));
  assert.deepEqual([s.refresh.enabled, s.refresh.primary, s.full.enabled, s.full.primary], [true, true, true, false]);
});

test("a run in progress disables both buttons", () => {
  const s = controlsState(base({ runs: [{ id: "r1", mode: "refresh", created_at: ago(60_000), status: "running" }, ...base().runs] }));
  assert.equal(s.running.id, "r1");
  assert.equal(s.full.enabled || s.refresh.enabled, false);
  assert.match(s.full.reason, /^An analysis is running \(started /);
});

test("a run left running 15 minutes is stuck: buttons enabled again", () => {
  const runs = [{ id: "r1", mode: "full", created_at: ago(STUCK_AFTER_MS), status: "running" }];
  assert.deepEqual(activeRun(runs, NOW), { running: null, stuck: { id: "r1", mode: "full", created_at: runs[0].created_at } });
  assert.equal(activeRun(runs, new Date(NOW.getTime() - 1)).running.id, "r1");
  const s = controlsState(base({ runs }));
  assert.equal(s.stuck.id, "r1");
  assert.equal(s.full.enabled, true);
});

test("offboarded: no controls", () => {
  assert.equal(controlsState(base({ clientStatus: "offboarded" })).visible, false);
});

test("start outcomes: every answer the function gives is mapped", () => {
  assert.deepEqual(startOutcome("full", 202, { run_id: "r1", mode: "full", status: "running" }), { kind: "started", runId: "r1", text: "Full analysis started." });
  assert.equal(startOutcome("refresh", 202, { run_id: "r2" }).text, "Refresh started.");
  assert.deepEqual(startOutcome("full", 409, { error: "run_in_progress", run_id: "r0" }),
    { kind: "running", runId: "r0", text: "An analysis is already running for this client; showing its progress." });
  assert.deepEqual(startOutcome("refresh", 409, { error: "needs_full_run", detail: "No completed run." }), { kind: "error", text: "Refresh isn't possible yet: No completed run." });
  assert.equal(startOutcome("full", 409, { error: "client_offboarded" }).kind, "error");
  assert.equal(startOutcome("full", 404, { error: "client_not_found" }).text, "Client not found.");
  assert.match(startOutcome("full", 403, { error: "forbidden" }).text, /Sign in again/);
  assert.match(startOutcome("full", 401, {}).text, /Sign in again/);
  assert.match(startOutcome("full", 400, { error: "mode is one of full, refresh, version" }).text, /mode is one of/);
});

test("start outcomes: a timeout, network error, 5xx or 202 without a run id is uncertain, never 'started' or 'failed'", () => {
  for (const [status, body] of [[null, null], [502, { error: "bad gateway" }], [500, "x"], [504, null], [202, {}], [200, { ok: true }]]) {
    const o = startOutcome("full", status, body);
    assert.equal(o.kind, "uncertain", `status ${status}`);
    assert.match(o.text, /It may have started/);
  }
});

test("finish messages: completed with changes, degraded and failed leave results unchanged", () => {
  assert.equal(finishMessage({ id: "r", status: "running", mode: "full", diff: null, error: null, health: null }), null);
  assert.deepEqual(finishMessage({ id: "r", status: "completed", mode: "refresh", diff: { added: [], resolved: [], regressed: [], section_changed: [], reopened: [] }, error: null, health: null }),
    { tone: "success", text: "Refresh complete: no change." });
  assert.equal(finishMessage({ id: "r", status: "completed", mode: "full", diff: { added: ["a", "b"], resolved: ["c"] }, error: null, health: null }).text,
    "Full analysis complete: +2 added · −1 resolved.");
  assert.deepEqual(finishMessage({ id: "r", status: "degraded", mode: "full", diff: { skipped: "x" }, error: null, health: { reasons: ["home page answered 503"] } }),
    { tone: "warning", text: "Full analysis finished degraded (home page answered 503). Results are unchanged." });
  assert.deepEqual(finishMessage({ id: "r", status: "failed", mode: "full", diff: null, error: "inventory exploded", health: null }),
    { tone: "error", text: "Full analysis failed: inventory exploded. Results are unchanged." });
});
